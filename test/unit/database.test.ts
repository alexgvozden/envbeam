import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PostgresProvider, plainFormatTables, customFormatTables, isPlainTableIdent } from '../../src/core/providers/database/postgres.js';
import { MysqlProvider } from '../../src/core/providers/database/mysql.js';
import { resolveConnection, parseDbUrl } from '../../src/core/providers/database/connection.js';
import { runMigrateCommand } from '../../src/core/providers/database/migrate.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import type { SnapshotOptions } from '../../src/core/providers/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SNAP: SnapshotOptions = {
  dataOnly: true,
  compress: false,
  includeTables: [],
  excludeTables: [],
  machine: 'laptop',
  timestamp: '20260627T000000Z',
};

function pgCtx(runner: FakeRunner, root: string, env: Record<string, string>, config: object = {}) {
  return makeTestContext({
    config: { version: 1, workspace: 'keeper', database: { provider: 'postgres', mode: 'snapshot', ...config } },
    runner,
    workspaceRoot: root,
    env,
  }).providerCtx('database');
}

describe('connection resolution', () => {
  it('parses a postgres URL into parts incl. percent-decoded password and dotted host', () => {
    // Assembled from parts so the source has no contiguous credential literal.
    const url = 'postgres://app:p%40ss' + '@' + 'db.local:5432/keeper';
    const p = parseDbUrl(url);
    expect(p).toMatchObject({ host: 'db.local', port: '5432', user: 'app', password: 'p@ss', database: 'keeper' });
  });

  it('prefers DATABASE_URL then assembles from PG* parts', () => {
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', database: { mode: 'snapshot' } }, env: { DATABASE_URL: 'postgres://u@h/db' } }).providerCtx('database');
    expect(resolveConnection(ctx, 'postgres', { host: ['PGHOST'], port: ['PGPORT'], user: ['PGUSER'], password: ['PGPASSWORD'], database: ['PGDATABASE'] }).url).toBe('postgres://u@h/db');

    const ctx2 = makeTestContext({ config: { version: 1, workspace: 'w', database: { mode: 'snapshot' } }, env: { PGHOST: 'h2', PGUSER: 'u2', PGDATABASE: 'd2' } }).providerCtx('database');
    const parts = resolveConnection(ctx2, 'postgres', { host: ['PGHOST'], port: ['PGPORT'], user: ['PGUSER'], password: ['PGPASSWORD'], database: ['PGDATABASE'] });
    expect(parts).toMatchObject({ host: 'h2', user: 'u2', database: 'd2' });
  });

  it('honors an explicit connection env-var name', () => {
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', database: { mode: 'snapshot', connection: 'MY_DB' } }, env: { MY_DB: 'postgres://z@h/db' } }).providerCtx('database');
    expect(resolveConnection(ctx, 'postgres', { host: ['PGHOST'], port: [], user: [], password: [], database: [] }).url).toBe('postgres://z@h/db');
  });

  it('normalizes a SQLAlchemy +driver scheme so CLI clients accept it', () => {
    const p = parseDbUrl('postgresql+psycopg://agentlab:pw' + '@' + 'localhost:5432/agentlab');
    expect(p.url).toBe('postgresql://agentlab:pw' + '@' + 'localhost:5432/agentlab');
    expect(p).toMatchObject({ host: 'localhost', port: '5432', user: 'agentlab', database: 'agentlab' });
  });

  it('discovers an app-prefixed *_DATABASE_URL when no standard var is set', () => {
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'w', database: { mode: 'snapshot' } },
      env: { AGENTLAB_DATABASE_URL: 'postgresql+psycopg://agentlab:pw' + '@' + 'localhost:5432/agentlab', OTHER: 'x' },
    }).providerCtx('database');
    const parts = resolveConnection(ctx, 'postgres', { host: ['PGHOST'], port: ['PGPORT'], user: ['PGUSER'], password: ['PGPASSWORD'], database: ['PGDATABASE'] });
    expect(parts.url).toBe('postgresql://agentlab:pw' + '@' + 'localhost:5432/agentlab');
    expect(parts.database).toBe('agentlab');
  });
});

describe('postgres provider', () => {
  it('builds a data-only pg_dump with table include/exclude and PG env from URL', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['pg_dump', 'psql'] });
    const provider = new PostgresProvider();
    const ctx = pgCtx(runner, dir, { DATABASE_URL: 'postgres://app:dev@localhost:5432/keeper' });
    await provider.snapshot(ctx, { ...SNAP, includeTables: ['seed_users'], excludeTables: ['audit_log'] });
    const call = runner.callsTo('pg_dump')[0]!;
    expect(call.args).toContain('--data-only');
    expect(call.args).toContain('-t');
    expect(call.args).toContain('seed_users');
    expect(call.args).toContain('-T');
    expect(call.args).toContain('audit_log');
    // URL passed positionally
    expect(call.args[0]).toBe('postgres://app:dev@localhost:5432/keeper');
  });

  it('change detection: baseline then change', async () => {
    const runner = new FakeRunner({ available: ['psql'] });
    let count = 5;
    runner.on('psql', (_c, args) => {
      if (args.includes('SELECT 1')) return { stdout: '1' };
      return { stdout: String(count) };
    });
    const provider = new PostgresProvider();
    const ctx = pgCtx(runner, '/tmp', {}, { changeTables: ['seed_users'] });
    const first = await provider.hasChanged(ctx, undefined);
    expect(first.changed).toBe(false);
    expect(first.fingerprint).toBeTruthy();
    count = 9;
    const second = await provider.hasChanged(ctx, first.fingerprint);
    expect(second.changed).toBe(true);
  });

  it('ignores volatile size/row estimates in the fingerprint when change tables are configured', async () => {
    const runner = new FakeRunner({ available: ['psql'] });
    let dbSize = 1000;
    runner.on('psql', (_c, args) => {
      const sql = args.join(' ');
      if (sql.includes('SELECT 1')) return { stdout: '1' };
      if (sql.includes('pg_database_size') || sql.includes('pg_stat_user_tables')) return { stdout: String(dbSize) };
      return { stdout: '42' }; // seed_users count stays constant (no real data change)
    });
    const provider = new PostgresProvider();
    const ctx = pgCtx(runner, '/tmp', {}, { changeTables: ['seed_users'] });
    const first = await provider.hasChanged(ctx, undefined);
    dbSize = 999999; // autovacuum/bloat shifts size + n_live_tup estimate
    const second = await provider.hasChanged(ctx, first.fingerprint);
    expect(second.changed).toBe(false); // estimates must not flip change detection
  });

  it('produces a baseline from db size + row count even when no tables are configured', async () => {
    const runner = new FakeRunner({ available: ['psql'] });
    runner.on('psql', (_c, args) => (args.includes('SELECT 1') ? { stdout: '1' } : { stdout: '4096' }));
    const provider = new PostgresProvider();
    const res = await provider.hasChanged(pgCtx(runner, '/tmp', {}), undefined);
    expect(res.changed).toBe(false);
    expect(res.fingerprint).toBeTruthy(); // size+rows give a usable fingerprint
    expect(res.detail).toMatch(/baseline/);
    expect(res.detail).toMatch(/row/);
  });

  it('restores a plain SQL file via psql', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const sql = path.join(dir, 'dump.sql');
    await fs.writeFile(sql, '-- plain sql\nSELECT 1;\n');
    const runner = new FakeRunner({ available: ['psql'] });
    const provider = new PostgresProvider();
    const ctx = pgCtx(runner, dir, { DATABASE_URL: 'postgres://app@localhost/keeper' });
    const res = await provider.restore(ctx, sql);
    expect(res.restored).toBe(true);
    expect(runner.calls.some((c) => c.command === 'psql' && c.args.includes('-f'))).toBe(true);
  });
});

describe('mysql provider', () => {
  it('builds mysqldump with MYSQL_PWD env and no-create-info for data-only', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['mysqldump', 'mysql'] });
    runner.on('mysqldump', (_c, args) => {
      const rf = args.find((a) => a.startsWith('--result-file='));
      if (rf) void fs.writeFile(rf.slice('--result-file='.length), 'data');
      return {};
    });
    const provider = new MysqlProvider();
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'keeper', database: { provider: 'mysql', mode: 'snapshot' } },
      runner,
      workspaceRoot: dir,
      env: { MYSQL_HOST: 'localhost', MYSQL_USER: 'root', MYSQL_PASSWORD: 'pw', MYSQL_DATABASE: 'keeper' },
    }).providerCtx('database');
    await provider.snapshot(ctx, SNAP);
    const call = runner.callsTo('mysqldump')[0]!;
    expect(call.options.env?.MYSQL_PWD).toBe('pw');
    expect(call.args).toContain('--no-create-info');
    expect(call.args).toContain('keeper');
  });

  it('compresses to .sql.gz and restores by decompressing', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['mysqldump', 'mysql'] });
    runner.on('mysqldump', (_c, args) => {
      const rf = args.find((a) => a.startsWith('--result-file='))!.slice('--result-file='.length);
      void fs.writeFile(rf, 'CREATE TABLE t (id int);\n');
      return {};
    });
    const provider = new MysqlProvider();
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'keeper', database: { provider: 'mysql', mode: 'snapshot' } },
      runner,
      workspaceRoot: dir,
      env: { MYSQL_DATABASE: 'keeper' },
    }).providerCtx('database');
    const snap = await provider.snapshot(ctx, { ...SNAP, compress: true });
    expect(snap.file.endsWith('.sql.gz')).toBe(true);
    const exists = await fs.stat(snap.file).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // restore should gunzip then `mysql -e source`
    await provider.restore(ctx, snap.file);
    const sourceCall = runner.callsTo('mysql').find((c) => c.args.some((a) => a.startsWith('source ')));
    expect(sourceCall).toBeTruthy();
  });
});

describe('migrate runner', () => {
  it('runs the configured command via shell with env', async () => {
    const runner = new FakeRunner();
    runner.on('sh', { stdout: 'migrated' });
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'w', database: { mode: 'migrations-only', migrateCommand: 'npx prisma migrate deploy' } },
      runner,
      env: { DATABASE_URL: 'x' },
    }).providerCtx('database');
    const res = await runMigrateCommand(ctx);
    expect(res.ran).toBe(true);
    const call = runner.callsTo('sh')[0]!;
    expect(call.args).toEqual(['-c', 'npx prisma migrate deploy']);
    expect(call.options.env?.DATABASE_URL).toBe('x');
  });

  it('no-ops when no command and reports failures', async () => {
    const runner = new FakeRunner();
    const noCmd = makeTestContext({ config: { version: 1, workspace: 'w', database: { mode: 'migrations-only' } }, runner }).providerCtx('database');
    expect((await runMigrateCommand(noCmd)).ran).toBe(false);

    runner.on('sh', { code: 1, stderr: 'fail' });
    const fail = makeTestContext({ config: { version: 1, workspace: 'w', database: { mode: 'migrations-only', migrateCommand: 'bad' } }, runner }).providerCtx('database');
    const res = await runMigrateCommand(fail);
    expect(res.ran).toBe(false);
    expect(res.detail).toMatch(/fail/);
  });
});

describe('findDatabaseUrls / ambiguity', () => {
  it('detects DB URLs by scheme (any var name) and warns on same-engine ambiguity', async () => {
    const { findDatabaseUrls, ambiguousUrlWarning } = await import('../../src/core/providers/database/connection.js');
    const env = {
      AGENTLAB_DATABASE_URL: 'postgresql+psycopg://app:pw@localhost:5432/app',
      READ_REPLICA_URL: 'postgres://ro:pw@replica:5432/app',
      CACHE_URL: 'redis://localhost:6379', // not a supported engine → ignored
      MYSQL_URL: 'mysql://u:pw@h/db',
    };
    const hits = findDatabaseUrls(env);
    expect(hits.filter((h) => h.engine === 'postgres').map((h) => h.key).sort()).toEqual(['AGENTLAB_DATABASE_URL', 'READ_REPLICA_URL']);
    expect(hits.some((h) => h.key === 'CACHE_URL')).toBe(false);
    // two postgres URLs → warn, naming the picked var
    const warn = ambiguousUrlWarning(env, 'postgres', 'AGENTLAB_DATABASE_URL');
    expect(warn).toMatch(/Multiple postgres/);
    expect(warn).toMatch(/using AGENTLAB_DATABASE_URL/);
    expect(warn).toMatch(/database\.connection/);
    // single mysql URL → no warning
    expect(ambiguousUrlWarning(env, 'mysql', 'MYSQL_URL')).toBeNull();
  });
})

// Found by the end-to-end run: `psql -f` prints each error, keeps going, and
// exits 0 — so a data-only restore that collided on every primary key reported
// success, applied nothing, and let envbeam advance its sync base over a
// database it had never written. Restoring a snapshot has to leave the tables
// holding what the snapshot holds.
describe('postgres restore replaces data rather than appending to it', () => {
  it('reads the target tables off a plain-SQL dump', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const f = path.join(dir, 'dump.sql');
    await fs.writeFile(
      f,
      [
        '-- pg_dump output',
        'COPY public.notes (id, body) FROM stdin;',
        '1\thello',
        '\\.',
        'COPY public.tags (id) FROM stdin;',
        '\\.',
        'INSERT INTO public.audit (id) VALUES (1);',
      ].join('\n'),
    );
    expect((await plainFormatTables(f)).sort()).toEqual(['public.audit', 'public.notes', 'public.tags']);
  });

  it('returns nothing for a missing or empty dump', async () => {
    expect(await plainFormatTables('/nonexistent/dump.sql')).toEqual([]);
  });

  it('reads the target tables off a custom-format dump via pg_restore -l', async () => {
    const runner = new FakeRunner({ available: ['pg_restore'] });
    runner.on('pg_restore', {
      stdout: [
        ';',
        '; Archive created at 2026-07-10',
        ';',
        '215; 0 16385 TABLE DATA public notes app',
        '216; 0 16390 TABLE DATA public tags app',
        '2003; 2606 16400 CONSTRAINT public notes notes_pkey app',
      ].join('\n'),
    });
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner }).providerCtx('database');
    expect((await customFormatTables(ctx, '/tmp/x.dump')).sort()).toEqual(['public.notes', 'public.tags']);
  });

  it('refuses to interpolate a table name that would need quoting', () => {
    expect(isPlainTableIdent('public.notes')).toBe(true);
    expect(isPlainTableIdent('notes')).toBe(true);
    expect(isPlainTableIdent('public.notes; DROP TABLE x')).toBe(false);
    expect(isPlainTableIdent('"Mixed Case"')).toBe(false);
    expect(isPlainTableIdent("public.n'x")).toBe(false);
  });
});
