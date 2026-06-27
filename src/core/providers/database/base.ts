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
    const tables = this.changeTables(ctx);
    if (tables.length === 0) {
      return { changed: false, detail: 'no change-detection tables configured' };
    }
    if (!(await this.ping(ctx))) {
      return { changed: false, detail: 'database not reachable' };
    }
    const parts: string[] = [];
    for (const t of tables) {
      try {
        const out = await this.runSql(ctx, this.changeProbeSql(t));
        parts.push(`${t}:${out.trim().replace(/\s+/g, ',')}`);
      } catch {
        parts.push(`${t}:err`);
      }
    }
    const fingerprint = createHash('sha1').update(parts.join('|')).digest('hex');
    const changed = sinceFingerprint != null && sinceFingerprint !== fingerprint;
    return {
      changed: sinceFingerprint == null ? false : changed,
      fingerprint,
      detail:
        sinceFingerprint == null
          ? 'baseline fingerprint recorded'
          : changed
            ? 'tracked tables changed since last snapshot'
            : 'no change in tracked tables',
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
