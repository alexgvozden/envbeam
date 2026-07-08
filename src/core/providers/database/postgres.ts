import { promises as fs } from 'node:fs';
import type { ProviderFactory } from '../registry.js';
import type {
  DatabaseProvider,
  DbStatus,
  ProviderContext,
  SnapshotOptions,
  ToolRequirement,
} from '../types.js';
import { SqlDatabaseProvider, firstInt, type DbOverview } from './base.js';
import { resolveConnection, describeConnection, type DbConnectionParts } from './connection.js';

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
    if (isCustom) {
      // pg_restore requires an explicit -d target to load into a database.
      const target = c.parts.url ?? c.parts.database;
      if (!target) {
        throw new Error('postgres restore needs a database (set PGDATABASE or a connection URL).');
      }
      await ctx.runner.run(
        'pg_restore',
        ['--no-owner', '--no-privileges', '--data-only', '-d', target, file],
        { env: c.env },
      );
    } else {
      await ctx.runner.run('psql', [...c.args, '-f', file], { env: c.env });
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
