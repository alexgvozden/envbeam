import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ensureDir } from '../../util/fs.js';
import { stateDir } from '../../config/paths.js';
import { runMigrateCommand } from './migrate.js';
import type {
  DatabaseProvider,
  DbChangeResult,
  DbStatus,
  MigrateResult,
  ProviderContext,
  SnapshotOptions,
  SnapshotResult,
  RestoreResult,
} from '../types.js';

/** Whole-database change signal: on-disk size (bytes) + approximate row count. */
export interface DbOverview {
  sizeBytes: number;
  rows: number;
}

/** Parse the first integer out of a CLI query result (tolerant of whitespace). */
export function firstInt(out: string): number {
  const n = parseInt(out.trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Human-readable byte size, e.g. 12.3 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Working directory for in-flight dump/restore files (cleaned by retention). */
export async function snapshotWorkDir(): Promise<string> {
  const dir = path.join(stateDir(), 'snapshots');
  await ensureDir(dir);
  return dir;
}

/**
 * Shared logic for SQL databases. Subclasses provide engine-specific dump,
 * restore, SQL execution, reachability, and tool requirements.
 */
export abstract class SqlDatabaseProvider implements DatabaseProvider {
  abstract readonly name: string;
  readonly kind = 'database' as const;
  abstract requiredTools(ctx: ProviderContext): ReturnType<DatabaseProvider['requiredTools']>;

  /** Run a SQL statement and return raw tab/newline output (untouched). */
  protected abstract runSql(ctx: ProviderContext, sql: string): Promise<string>;
  /** Whether the server is reachable. */
  protected abstract ping(ctx: ProviderContext): Promise<boolean>;
  /** Produce a dump file at `file`; honor data-only/tables/compress. */
  protected abstract dumpToFile(ctx: ProviderContext, file: string, opts: SnapshotOptions): Promise<void>;
  /** Restore from `file` (handles compressed/plain). */
  protected abstract restoreFromFile(ctx: ProviderContext, file: string): Promise<void>;
  /** File extension for dumps given compression. */
  protected abstract dumpExtension(opts: SnapshotOptions): string;
  /** SQL to read a single table's count + optional updated_at marker. */
  protected abstract changeProbeSql(table: string): string;
  /**
   * Whole-database change signal: on-disk size + approximate total row count.
   * Used so change-detection works out of the box without configured tables.
   * Return null if the engine can't compute it.
   */
  protected abstract databaseOverview(ctx: ProviderContext): Promise<DbOverview | null>;

  /** Tables to watch for change detection. Wildcards aren't concrete tables. */
  protected changeTables(ctx: ProviderContext): string[] {
    const db = ctx.config.database;
    const source =
      db?.changeTables && db.changeTables.length
        ? db.changeTables
        : (db?.snapshot?.tables?.include ?? []);
    return source.filter((t) => !t.includes('*'));
  }

  async hasChanged(ctx: ProviderContext, sinceFingerprint?: string): Promise<DbChangeResult> {
    if (!(await this.ping(ctx))) {
      return { changed: false, detail: 'database not reachable (is it up, and are the client tools installed?)' };
    }
    const parts: string[] = [];

    // Exact per-table counts when the user pinned specific tables — these are
    // stable signals and are the sole fingerprint basis when present.
    const tables = this.changeTables(ctx);
    for (const t of tables) {
      try {
        const out = await this.runSql(ctx, this.changeProbeSql(t));
        parts.push(`${t}:${out.trim().replace(/\s+/g, ',')}`);
      } catch {
        parts.push(`${t}:err`);
      }
    }

    // Whole-DB signal (size + approx rows) — used ONLY as a zero-config
    // fallback. It relies on planner statistics (n_live_tup, on-disk size)
    // that drift with autovacuum/bloat, so mixing it into an exact-table
    // fingerprint would cause spurious "data changed". Keep it out when we
    // have exact table signals; always compute it for the human summary.
    let overview: DbOverview | null = null;
    try {
      overview = await this.databaseOverview(ctx);
    } catch {
      overview = null;
    }
    if (overview && tables.length === 0) {
      parts.push(`size:${overview.sizeBytes}`, `rows:${overview.rows}`);
    }

    if (parts.length === 0) {
      return { changed: false, detail: 'no readable change signal (no size/row info, no change tables)' };
    }

    const fingerprint = createHash('sha1').update(parts.join('|')).digest('hex');
    const changed = sinceFingerprint != null && sinceFingerprint !== fingerprint;
    const summary = overview
      ? `~${formatBytes(overview.sizeBytes)}, ~${overview.rows.toLocaleString('en-US')} row(s)`
      : `${tables.length} tracked table(s)`;
    return {
      changed: sinceFingerprint == null ? false : changed,
      fingerprint,
      detail:
        sinceFingerprint == null
          ? `baseline: ${summary}`
          : changed
            ? `data changed → ${summary}`
            : `no data changes (${summary})`,
    };
  }

  async snapshot(ctx: ProviderContext, opts: SnapshotOptions): Promise<SnapshotResult> {
    const dir = await snapshotWorkDir();
    const ext = this.dumpExtension(opts);
    const base = `${ctx.config.workspace}__${opts.timestamp}__${opts.machine}.${ext}`;
    const file = path.join(dir, base);
    if (ctx.dryRun) {
      ctx.logger.sub(`would dump database → ${base}${opts.dataOnly ? ' (data-only)' : ''}`);
      return { file, sizeBytes: 0, tables: opts.includeTables };
    }
    await this.dumpToFile(ctx, file, opts);
    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.stat(file)).size;
    } catch {
      /* ignore */
    }
    return { file, sizeBytes, tables: opts.includeTables.length ? opts.includeTables : undefined };
  }

  async restore(ctx: ProviderContext, snapshotFile: string): Promise<RestoreResult> {
    if (ctx.dryRun) {
      ctx.logger.sub(`would restore database from ${path.basename(snapshotFile)}`);
      return { restored: false, detail: 'dry-run' };
    }
    await this.restoreFromFile(ctx, snapshotFile);
    return { restored: true, detail: `restored ${path.basename(snapshotFile)}` };
  }

  async migrate(ctx: ProviderContext): Promise<MigrateResult> {
    return runMigrateCommand(ctx);
  }

  abstract status(ctx: ProviderContext): Promise<DbStatus>;
}

export function machineName(): string {
  return process.env.ENVBEAM_MACHINE || os.hostname() || 'machine';
}
