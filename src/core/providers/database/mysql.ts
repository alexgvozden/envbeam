import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
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
    return `SELECT count(*) FROM \`${table.replace(/`/g, '``')}\``;
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
      await ctx.runner.run(
        'mysql',
        [...c.args, c.database, '-e', `source ${sqlFile}`],
        { env: c.env },
      );
    } finally {
      if (temp) await fs.rm(temp, { force: true });
    }
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
