import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import type { ProviderFactory } from '../registry.js';
import type {
  DatabaseProvider,
  DbStatus,
  ProviderContext,
  SnapshotOptions,
  ToolRequirement,
} from '../types.js';
import { SqlDatabaseProvider, firstInt, type DbOverview } from './base.js';
import { resolveConnection, describeConnection, ambiguousUrlWarning, type DbConnectionParts } from './connection.js';

const PART_KEYS = {
  host: ['PGHOST', 'POSTGRES_HOST', 'DB_HOST'],
  port: ['PGPORT', 'POSTGRES_PORT', 'DB_PORT'],
  user: ['PGUSER', 'POSTGRES_USER', 'DB_USER', 'DB_USERNAME'],
  password: ['PGPASSWORD', 'POSTGRES_PASSWORD', 'DB_PASSWORD'],
  database: ['PGDATABASE', 'POSTGRES_DB', 'DB_NAME', 'DB_DATABASE'],
};

function conn(ctx: ProviderContext): { env: Record<string, string>; args: string[]; parts: DbConnectionParts } {
  const parts = resolveConnection(ctx, 'postgres', PART_KEYS);
  const env: Record<string, string> = {};
  if (parts.url) {
    return { env, args: [parts.url], parts };
  }
  if (parts.host) env.PGHOST = parts.host;
  if (parts.port) env.PGPORT = parts.port;
  if (parts.user) env.PGUSER = parts.user;
  if (parts.password) env.PGPASSWORD = parts.password;
  if (parts.database) env.PGDATABASE = parts.database;
  return { env, args: [], parts };
}

export class PostgresProvider extends SqlDatabaseProvider {
  readonly name = 'postgres';

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'pg_dump',
        versionArgs: ['--version'],
        installHint: 'Install PostgreSQL client tools (pg_dump, pg_restore, psql).',
      },
      {
        command: 'psql',
        versionArgs: ['--version'],
        installHint: 'Install PostgreSQL client tools.',
        authCheck: async (ctx) => {
          const c = conn(ctx);
          const res = await ctx.runner.run('psql', [...c.args, '-tAc', 'SELECT 1'], {
            env: c.env,
            allowFailure: true,
          });
          return res.code === 0 ? { ok: true } : { ok: false, detail: 'cannot connect to postgres' };
        },
      },
    ];
  }

  protected async runSql(ctx: ProviderContext, sql: string): Promise<string> {
    const c = conn(ctx);
    const res = await ctx.runner.run('psql', [...c.args, '-tAc', sql], { env: c.env });
    return res.stdout;
  }

  protected async ping(ctx: ProviderContext): Promise<boolean> {
    const c = conn(ctx);
    const res = await ctx.runner.run('psql', [...c.args, '-tAc', 'SELECT 1'], {
      env: c.env,
      allowFailure: true,
    });
    return res.code === 0;
  }

  connectionSummary(ctx: ProviderContext): string {
    return describeConnection(conn(ctx).parts);
  }

  ambiguityWarning(ctx: ProviderContext): string | null {
    return ambiguousUrlWarning(ctx.env, 'postgres', conn(ctx).parts.sourceKey);
  }

  protected changeProbeSql(table: string): string {
    return `SELECT count(*) FROM ${quoteIdent(table)}`;
  }

  protected async databaseOverview(ctx: ProviderContext): Promise<DbOverview | null> {
    try {
      const size = await this.runSql(ctx, 'SELECT pg_database_size(current_database())');
      const rows = await this.runSql(
        ctx,
        'SELECT COALESCE(sum(n_live_tup), 0)::bigint FROM pg_stat_user_tables',
      );
      return { sizeBytes: firstInt(size), rows: firstInt(rows) };
    } catch {
      return null;
    }
  }

  protected dumpExtension(opts: SnapshotOptions): string {
    return opts.compress ? 'dump' : 'sql';
  }

  protected async dumpToFile(ctx: ProviderContext, file: string, opts: SnapshotOptions): Promise<void> {
    const c = conn(ctx);
    const args = [...c.args, '--no-owner', '--no-privileges'];
    if (opts.dataOnly) args.push('--data-only');
    if (opts.compress) args.push('-Fc');
    else args.push('--format=plain');
    for (const t of opts.includeTables) args.push('-t', t);
    for (const t of opts.excludeTables) args.push('-T', t);
    args.push('-f', file);
    await ctx.runner.run('pg_dump', args, { env: c.env });
  }

  protected async restoreFromFile(ctx: ProviderContext, file: string): Promise<void> {
    const c = conn(ctx);
    const isCustom = await isPgCustomFormat(file);

    // A data-only dump carries rows, not a schema, so applying it to a table
    // that already has rows APPENDS — and where the dump's primary keys collide
    // with existing ones it fails outright. "Restore this snapshot" has to mean
    // the tables end up holding what the snapshot holds, so empty them first.
    const tables = isCustom ? await customFormatTables(ctx, file) : await plainFormatTables(file);
    const emptyFirst = async () => {
      if (tables.length) await truncateTables(ctx, tables);
    };
    await emptyFirst();

    if (!isCustom) {
      // Without ON_ERROR_STOP, psql prints each error, keeps going, and exits 0.
      // A restore that applied nothing then reported success, and envbeam
      // advanced its sync base over a database it had never actually written.
      await this.applyPlainDump(ctx, file);
      return;
    }

    // pg_restore requires an explicit -d target to load into a database.
    const target = c.parts.url ?? c.parts.database;
    if (!target) {
      throw new Error('postgres restore needs a database (set PGDATABASE or a connection URL).');
    }
    const res = await ctx.runner.run(
      'pg_restore',
      ['--no-owner', '--no-privileges', '--data-only', '--exit-on-error', '-d', target, file],
      { env: c.env, allowFailure: true },
    );
    if (res.code === 0) return;

    // A dump taken with a NEWER pg_dump carries session settings the server has
    // never heard of (`transaction_timeout` arrived in 17). `--exit-on-error`
    // stops on the first one, before a single row is loaded. Those settings are
    // preamble, not data: convert the archive to SQL, drop the settings this
    // server doesn't have, and apply the rest — still stopping on real errors.
    if (!/unrecognized configuration parameter/i.test(res.stderr)) {
      throw new Error(`pg_restore failed: ${res.stderr.trim()}`);
    }
    ctx.logger.sub('snapshot was taken with a newer pg_dump — replaying it without the settings this server lacks');
    const sqlFile = `${file}.plain.sql`;
    try {
      await ctx.runner.run(
        'pg_restore',
        ['--no-owner', '--no-privileges', '--data-only', '-f', sqlFile, file],
        { env: c.env },
      );
      await emptyFirst(); // the aborted attempt may have loaded part of a table
      await this.applyPlainDump(ctx, sqlFile);
    } finally {
      await fs.rm(sqlFile, { force: true }).catch(() => undefined);
    }
  }

  /** Apply a plain-SQL dump, aborting on the first real error. */
  private async applyPlainDump(ctx: ProviderContext, file: string): Promise<void> {
    const c = conn(ctx);
    const filtered = await stripUnknownSettings(ctx, file);
    try {
      await ctx.runner.run('psql', [...c.args, '-v', 'ON_ERROR_STOP=1', '-f', filtered ?? file], { env: c.env });
    } finally {
      if (filtered) await fs.rm(filtered, { force: true }).catch(() => undefined);
    }
  }

  async status(ctx: ProviderContext): Promise<DbStatus> {
    const reachable = await this.ping(ctx);
    return {
      reachable,
      pendingMigrations: 'unknown',
      detail: reachable ? 'postgres reachable' : 'postgres not reachable',
    };
  }
}

function quoteIdent(table: string): string {
  // allow schema-qualified names: schema.table
  return table
    .split('.')
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join('.');
}

/** `SET foo = ...;` at the start of a line — pg_dump's preamble form. */
const SET_LINE = /^SET\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\bTO\b)/i;

/**
 * Drop `SET` statements naming a session setting this server does not have, and
 * return the path of the rewritten file (or null when nothing needed dropping).
 *
 * A dump taken with a newer `pg_dump` opens with settings introduced after the
 * target server was released — `transaction_timeout` landed in PostgreSQL 17.
 * `psql` without `ON_ERROR_STOP` shrugged those off, which is also why it shrugged
 * off the errors that mattered. We keep `ON_ERROR_STOP` and remove exactly the
 * lines that are provably harmless: preamble settings the server cannot name.
 * Which ones those are is a question for the server, not a version table.
 */
export async function stripUnknownSettings(ctx: ProviderContext, file: string): Promise<string | null> {
  // pg_dump writes every SET in the preamble, so a short head read finds them
  // all. A whole dump can be many gigabytes; it is never read into memory.
  const wanted = new Set<string>();
  for await (const line of readLines(file, 64 * 1024)) {
    const m = line.match(SET_LINE);
    if (m) wanted.add(m[1]!.toLowerCase());
  }
  if (!wanted.size) return null;

  const c = conn(ctx);
  const res = await ctx.runner.run(
    'psql',
    [...c.args, '-tAc', 'SELECT name FROM pg_settings'],
    { env: c.env, allowFailure: true },
  );
  if (res.code !== 0) return null; // can't ask; leave the dump alone
  const known = new Set(res.stdout.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));

  const unknown = [...wanted].filter((n) => !known.has(n));
  if (!unknown.length) return null;

  ctx.logger.sub(`ignoring ${unknown.length} setting(s) this server does not have: ${unknown.join(', ')}`);
  const out = `${file}.compat.sql`;
  const sink = createWriteStream(out);
  try {
    for await (const line of readLines(file)) {
      const m = line.match(SET_LINE);
      if (m && unknown.includes(m[1]!.toLowerCase())) continue;
      if (!sink.write(line + '\n')) await once(sink, 'drain');
    }
  } finally {
    sink.end();
    await once(sink, 'close');
  }
  return out;
}

/**
 * A schema-qualified table identifier we are willing to interpolate into SQL.
 * `pg_dump` emits plain `schema.table`; anything needing quotes (a name with a
 * dot, a space, mixed case) is rejected rather than escaped, and the table is
 * left alone. Refusing to truncate is always safe; guessing at quoting is not.
 */
export function isPlainTableIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name);
}

/**
 * Read `file` line by line without holding it in memory. `maxBytes` stops early,
 * for callers that only need the head.
 */
async function* readLines(file: string, maxBytes = Infinity): AsyncGenerator<string> {
  let stream: import('node:fs').ReadStream;
  try {
    stream = createReadStream(file, { encoding: 'utf8', end: maxBytes === Infinity ? undefined : maxBytes - 1 });
  } catch {
    return;
  }
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) yield line;
  } catch {
    /* unreadable — treat as empty */
  }
}

/** Tables a plain-SQL data dump loads into, read off its `COPY`/`INSERT` statements. */
export async function plainFormatTables(file: string): Promise<string[]> {
  const out = new Set<string>();
  for await (const line of readLines(file)) {
    const copy = line.match(/^COPY\s+([^\s(]+)\s*\(/);
    if (copy) out.add(copy[1]!);
    const insert = line.match(/^INSERT\s+INTO\s+([^\s(]+)\s*[(\s]/i);
    if (insert) out.add(insert[1]!);
  }
  return [...out].filter(isPlainTableIdent);
}

/** Tables a custom-format dump loads into, via `pg_restore -l`. */
export async function customFormatTables(ctx: ProviderContext, file: string): Promise<string[]> {
  const res = await ctx.runner.run('pg_restore', ['-l', file], { allowFailure: true });
  if (res.code !== 0) return [];
  const out = new Set<string>();
  // Lines look like: `123; 0 16385 TABLE DATA public notes app`
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.match(/\bTABLE DATA\s+(\S+)\s+(\S+)/);
    if (m) out.add(`${m[1]}.${m[2]}`);
  }
  return [...out].filter(isPlainTableIdent);
}

/**
 * Empty the given tables, ignoring any that don't exist yet (a fresh clone
 * restores before its migrations have ever run on some tables). `to_regclass`
 * makes the existence check cheap and injection-safe; the names themselves are
 * validated by {@link isPlainTableIdent} before they reach here.
 */
async function truncateTables(ctx: ProviderContext, tables: string[]): Promise<void> {
  const c = conn(ctx);
  const list = tables.map((t) => `'${t}'`).join(',');
  const sql = `DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[${list}]::text[] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE 'TRUNCATE TABLE ' || t || ' RESTART IDENTITY CASCADE';
    END IF;
  END LOOP;
END $$;`;
  await ctx.runner.run('psql', [...c.args, '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: c.env });
}

/** Postgres custom-format dumps start with the magic header "PGDMP". */
async function isPgCustomFormat(file: string): Promise<boolean> {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(5);
      await fh.read(buf, 0, 5, 0);
      return buf.toString('latin1') === 'PGDMP';
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export const postgresProviderFactory: ProviderFactory<DatabaseProvider> = {
  kind: 'database',
  name: 'postgres',
  identityType: 'database',
  create: () => new PostgresProvider(),
};
