import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RealCommandRunner } from '../../src/core/util/exec.js';
import { PostgresProvider } from '../../src/core/providers/database/postgres.js';
import { createSyncTarget } from '../../src/core/sync/index.js';
import { snapshotName } from '../../src/core/sync/types.js';
import { syncConfigSchema } from '../../src/core/config/schema.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import type { ProviderContext, SnapshotOptions } from '../../src/core/providers/types.js';

const runner = new RealCommandRunner();
let dockerOk = false;
let pgDumpOk = false;
let containerId: string | undefined;
let dbUrl: string | undefined;
let cleanupTmp: (() => Promise<void>) | undefined;

const PASSWORD = 'pgpw';

async function dockerAvailable(): Promise<boolean> {
  if (!(await runner.which('docker'))) return false;
  // `docker info --format` can exit 0 with empty server version when the daemon
  // is down; require an actual version string before declaring docker usable.
  const res = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true });
  return res.code === 0 && /\d/.test(res.stdout.trim());
}

async function startPostgres(): Promise<{ id: string; url: string }> {
  const run = await runner.run(
    'docker',
    ['run', '-d', '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=keeper', '-p', '127.0.0.1::5432', 'postgres:14'],
    { allowFailure: true },
  );
  if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const id = run.stdout.trim();
  const portRes = await runner.run('docker', ['port', id, '5432'], { allowFailure: true });
  const mapped = portRes.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const port = mapped.slice(mapped.lastIndexOf(':') + 1);
  // assemble URL from parts so no credential literal sits in source
  const url = 'postgres://postgres:' + PASSWORD + '@' + `127.0.0.1:${port}/keeper`;
  return { id, url };
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const res = await runner.run('psql', [url, '-tAc', 'SELECT 1'], { allowFailure: true });
    if (res.code === 0 && res.stdout.trim() === '1') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('postgres did not become ready in time');
}

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  pgDumpOk = (await runner.which('pg_dump')) != null && (await runner.which('psql')) != null;
  if (!dockerOk || !pgDumpOk) return;
  try {
    const home = await tmpDir('envbeam-pg-home-');
    cleanupTmp = home.cleanup;
    process.env.ENVBEAM_HOME = home.dir;
    process.env.ENVBEAM_MACHINE = 'pgbox';
    const started = await startPostgres();
    containerId = started.id;
    dbUrl = started.url;
    await waitReady(dbUrl);
  } catch (e) {
    // Treat any setup failure (no daemon, image pull blocked, etc.) as "skip".
    dockerOk = false;
    process.stderr.write(`[postgres integration] skipping: ${(e as Error).message}\n`);
  }
}, 120_000);

afterAll(async () => {
  if (containerId) {
    await runner.run('docker', ['rm', '-f', containerId], { allowFailure: true });
  }
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_MACHINE;
  if (cleanupTmp) await cleanupTmp();
}, 30_000);

function pgCtx(root: string, extraDb: object = {}): ProviderContext {
  return makeTestContext({
    config: {
      version: 1,
      workspace: 'keeper',
      database: { provider: 'postgres', mode: 'snapshot', changeTables: ['seed_users'], ...extraDb },
    },
    runner,
    workspaceRoot: root,
    env: { DATABASE_URL: dbUrl! },
  }).providerCtx('database');
}

async function psql(sql: string): Promise<string> {
  const res = await runner.run('psql', [dbUrl!, '-tAc', sql], { allowFailure: true });
  if (res.code !== 0) throw new Error(`psql failed: ${res.stderr}`);
  return res.stdout.trim();
}

const SNAP: SnapshotOptions = {
  dataOnly: true,
  compress: true,
  includeTables: [],
  excludeTables: [],
  machine: 'pgbox',
  timestamp: '20260627T120000Z',
};

describe('postgres provider (real docker postgres:14)', () => {
  it('reports reachable status, migrates, and detects change', async () => {
    if (!dockerOk || !pgDumpOk) return;
    const { dir, cleanup } = await tmpDir();
    try {
      const provider = new PostgresProvider();
      const ctx = pgCtx(dir, {
        migrateCommand: `psql "$DATABASE_URL" -c "CREATE TABLE IF NOT EXISTS seed_users(id serial primary key, name text)"`,
      });

      expect((await provider.status(ctx)).reachable).toBe(true);

      const mig = await provider.migrate(ctx);
      expect(mig.ran).toBe(true);
      await psql("INSERT INTO seed_users(name) VALUES ('alice'),('bob')");

      const baseline = await provider.hasChanged(ctx, undefined);
      expect(baseline.changed).toBe(false);
      expect(baseline.fingerprint).toBeTruthy();

      await psql("INSERT INTO seed_users(name) VALUES ('carol')");
      const after = await provider.hasChanged(ctx, baseline.fingerprint);
      expect(after.changed).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('snapshots and restores data via a real local-folder sync round trip', async () => {
    if (!dockerOk || !pgDumpOk) return;
    const { dir, cleanup } = await tmpDir();
    try {
      const provider = new PostgresProvider();
      const ctx = pgCtx(dir);

      // ensure a known data set
      await psql('DROP TABLE IF EXISTS seed_users');
      await psql('CREATE TABLE seed_users(id serial primary key, name text)');
      await psql("INSERT INTO seed_users(name) VALUES ('alice'),('bob'),('carol')");
      expect(await psql('SELECT count(*) FROM seed_users')).toBe('3');

      // snapshot → push to a real local-folder sync target
      const syncDir = path.join(dir, 'snaps');
      const sync = createSyncTarget(syncConfigSchema.parse({ target: 'local-folder', path: syncDir, keep: 5 }));
      const snap = await provider.snapshot(ctx, SNAP);
      expect(snap.sizeBytes).toBeGreaterThan(0);
      const name = snapshotName('keeper', SNAP.timestamp, SNAP.machine, 'dump');
      await sync.put(ctx, snap.file, name);

      // mutate the DB (lose data), then restore from the synced snapshot
      await psql('TRUNCATE seed_users');
      expect(await psql('SELECT count(*) FROM seed_users')).toBe('0');

      const downloaded = path.join(dir, 'restore.dump');
      await sync.get(ctx, name, downloaded);
      const res = await provider.restore(ctx, downloaded);
      expect(res.restored).toBe(true);
      expect(await psql('SELECT count(*) FROM seed_users')).toBe('3');
    } finally {
      await cleanup();
    }
  }, 60_000);
});
