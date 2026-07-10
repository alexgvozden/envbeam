import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import type { ProviderFactory } from '../registry.js';
import type {
  DatabaseProvider,
  DbStatus,
  ProviderContext,
  SnapshotOptions,
  ToolRequirement,
} from '../types.js';
import { SqlDatabaseProvider, firstInt, type DbOverview } from './base.js';
import { resolveConnection, describeConnection, ambiguousUrlWarning } from './connection.js';

const PART_KEYS = {
  host: ['MYSQL_HOST', 'DB_HOST'],
  port: ['MYSQL_PORT', 'DB_PORT'],
  user: ['MYSQL_USER', 'DB_USER', 'DB_USERNAME'],
  password: ['MYSQL_PASSWORD', 'MYSQL_PWD', 'DB_PASSWORD'],
  database: ['MYSQL_DATABASE', 'MYSQL_DB', 'DB_NAME', 'DB_DATABASE'],
};

function conn(ctx: ProviderContext): { env: Record<string, string>; args: string[]; database?: string } {
  const parts = resolveConnection(ctx, 'mysql', PART_KEYS);
  const env: Record<string, string> = {};
  const args: string[] = [];
  if (parts.host) args.push('-h', parts.host);
  if (parts.port) args.push('-P', parts.port);
  if (parts.user) args.push('-u', parts.user);
  if (parts.password) env.MYSQL_PWD = parts.password;
  return { env, args, database: parts.database };
}

async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dest));
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

/** Backtick-quote an identifier, doubling any backtick inside it. */
function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** Single-quote a string literal for MySQL. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/**
 * Tables a `mysqldump` data-only dump loads into.
 *
 * The dump wraps each table's rows in `LOCK TABLES `t` WRITE;` … `UNLOCK
 * TABLES;` and emits `INSERT INTO `t` VALUES (…)`. Both name the table, so
 * either line identifies it. Read line by line: a dump can be gigabytes and must
 * never be held in memory.
 */
export async function mysqlDumpTables(file: string): Promise<string[]> {
  const out = new Set<string>();
  let stream: import('node:fs').ReadStream;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    return [];
  }
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const m = line.match(/^(?:LOCK TABLES|INSERT INTO)\s+`((?:[^`]|``)+)`/i);
      if (m) out.add(m[1]!.replace(/``/g, '`'));
    }
  } catch {
    return [];
  }
  return [...out];
}

export class MysqlProvider extends SqlDatabaseProvider {
  readonly name = 'mysql';

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'mysqldump',
        versionArgs: ['--version'],
        installHint: 'Install MySQL/MariaDB client tools (mysqldump, mysql).',
      },
      {
        command: 'mysql',
        versionArgs: ['--version'],
        installHint: 'Install MySQL/MariaDB client tools.',
        authCheck: async (ctx) => {
          const c = conn(ctx);
          const res = await ctx.runner.run(
            'mysql',
            [...c.args, ...(c.database ? [c.database] : []), '-N', '-e', 'SELECT 1'],
            { env: c.env, allowFailure: true },
          );
          return res.code === 0 ? { ok: true } : { ok: false, detail: 'cannot connect to mysql' };
        },
      },
    ];
  }

  protected async runSql(ctx: ProviderContext, sql: string): Promise<string> {
    const c = conn(ctx);
    const res = await ctx.runner.run(
      'mysql',
      [...c.args, ...(c.database ? [c.database] : []), '-N', '-B', '-e', sql],
      { env: c.env },
    );
    return res.stdout;
  }

  protected async ping(ctx: ProviderContext): Promise<boolean> {
    const c = conn(ctx);
    const res = await ctx.runner.run(
      'mysql',
      [...c.args, ...(c.database ? [c.database] : []), '-N', '-e', 'SELECT 1'],
      { env: c.env, allowFailure: true },
    );
    return res.code === 0;
  }

  connectionSummary(ctx: ProviderContext): string {
    return describeConnection(resolveConnection(ctx, 'mysql', PART_KEYS));
  }

  ambiguityWarning(ctx: ProviderContext): string | null {
    return ambiguousUrlWarning(ctx.env, 'mysql', resolveConnection(ctx, 'mysql', PART_KEYS).sourceKey);
  }

  protected changeProbeSql(table: string): string {
    return `SELECT count(*) FROM ${quoteIdent(table)}`;
  }

  protected async databaseOverview(ctx: ProviderContext): Promise<DbOverview | null> {
    try {
      const size = await this.runSql(
        ctx,
        'SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()',
      );
      const rows = await this.runSql(
        ctx,
        'SELECT COALESCE(SUM(table_rows), 0) FROM information_schema.tables WHERE table_schema = DATABASE()',
      );
      return { sizeBytes: firstInt(size), rows: firstInt(rows) };
    } catch {
      return null;
    }
  }

  protected dumpExtension(opts: SnapshotOptions): string {
    return opts.compress ? 'sql.gz' : 'sql';
  }

  protected async dumpToFile(ctx: ProviderContext, file: string, opts: SnapshotOptions): Promise<void> {
    const c = conn(ctx);
    if (!c.database) {
      throw new Error('mysql snapshot needs a database (set MYSQL_DATABASE or a connection URL).');
    }
    const args = [...c.args, '--single-transaction', '--no-tablespaces'];
    if (opts.dataOnly) args.push('--no-create-info');
    if (opts.excludeTables.length) {
      for (const t of opts.excludeTables) args.push(`--ignore-table=${c.database}.${t}`);
    }
    args.push(c.database);
    for (const t of opts.includeTables) args.push(t);

    const sqlTarget = opts.compress ? file.replace(/\.gz$/, '') : file;
    args.push(`--result-file=${sqlTarget}`);
    await ctx.runner.run('mysqldump', args, { env: c.env });
    if (opts.compress) {
      await gzipFile(sqlTarget, file);
      await fs.rm(sqlTarget, { force: true });
    }
  }

  protected async restoreFromFile(ctx: ProviderContext, file: string): Promise<void> {
    const c = conn(ctx);
    if (!c.database) {
      throw new Error('mysql restore needs a database (set MYSQL_DATABASE or a connection URL).');
    }
    let sqlFile = file;
    let temp: string | undefined;
    if (file.endsWith('.gz')) {
      temp = file.replace(/\.gz$/, '.restore.sql');
      await gunzipFile(file, temp);
      sqlFile = temp;
    }
    try {
      // A data-only dump carries rows, not a schema, so applying it to a table
      // that already holds rows appends — and collides on the primary key.
      // "Restore this snapshot" has to mean the tables end up holding what the
      // snapshot holds, so empty them first, exactly as the postgres provider
      // does. (Unlike `psql -f`, the mysql client aborts at the first error and
      // exits non-zero, so a failed restore was at least never reported as a
      // success here — it simply could not succeed over existing data.)
      const tables = await mysqlDumpTables(sqlFile);
      if (tables.length) await this.truncateTables(ctx, tables);

      await ctx.runner.run(
        'mysql',
        [...c.args, c.database, '-e', `source ${sqlFile}`],
        { env: c.env },
      );
    } finally {
      if (temp) await fs.rm(temp, { force: true });
    }
  }

  /**
   * Empty the given tables, skipping any the database does not have yet — a
   * fresh clone restores before every migration has created every table, and
   * `TRUNCATE` on a missing table is an error.
   *
   * Foreign keys are disabled for the duration: `TRUNCATE` is refused outright
   * on a table another table references, and the dump's own tables reference
   * each other in an order we have no reason to be able to sort.
   */
  private async truncateTables(ctx: ProviderContext, tables: string[]): Promise<void> {
    const c = conn(ctx);
    const list = tables.map(quoteLiteral).join(',');
    const present = await this.runSql(
      ctx,
      `SELECT table_name FROM information_schema.tables ` +
        `WHERE table_schema = DATABASE() AND table_name IN (${list})`,
    );
    const existing = present
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!existing.length) return;

    const sql = [
      'SET FOREIGN_KEY_CHECKS=0;',
      ...existing.map((t) => `TRUNCATE TABLE ${quoteIdent(t)};`),
      'SET FOREIGN_KEY_CHECKS=1;',
    ].join(' ');
    await ctx.runner.run('mysql', [...c.args, c.database!, '-e', sql], { env: c.env });
  }

  async status(ctx: ProviderContext): Promise<DbStatus> {
    const reachable = await this.ping(ctx);
    return {
      reachable,
      pendingMigrations: 'unknown',
      detail: reachable ? 'mysql reachable' : 'mysql not reachable',
    };
  }
}

export const mysqlProviderFactory: ProviderFactory<DatabaseProvider> = {
  kind: 'database',
  name: 'mysql',
  identityType: 'database',
  create: () => new MysqlProvider(),
};
