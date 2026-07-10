import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { RealCommandRunner } from '../../src/core/util/exec.js';
import { MysqlProvider, mysqlDumpTables } from '../../src/core/providers/database/mysql.js';
import { makeTestContext } from '../helpers/context.js';
import type { ProviderContext, SnapshotOptions } from '../../src/core/providers/types.js';

const runner = new RealCommandRunner();
let dockerOk = false;
let containerId: string | undefined;

const PASSWORD = 'mysqlpw';
const DB = 'keeper';
const CONTAINER = 'envbeam-mysql-it';
const MYSQL_IMAGE = process.env.MYSQL_TEST_IMAGE ?? 'mysql:8';

/**
 * `mysql` and `mysqldump` are usually not installed on a developer's machine,
 * and installing them is not this suite's business. Instead, put shims on PATH
 * that run the client *inside* the server container.
 *
 * The provider passes file paths to `mysqldump --result-file=…` and to the
 * client's `source …`, so the container must see those paths at the same place
 * the host does. `WORK` is bind-mounted at its own absolute path, and both
 * `ENVBEAM_HOME` (where snapshots are written) and the dumps under test live
 * inside it. Nothing here special-cases the provider; it runs unmodified.
 */
const WORK = path.join(os.tmpdir().replace(/^\/var\//, '/private/var/'), 'envbeam-mysql-it');

async function dockerAvailable(): Promise<boolean> {
  if (!(await runner.which('docker'))) return false;
  const res = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true });
  return res.code === 0 && /\d/.test(res.stdout.trim());
}

async function writeShims(binDir: string): Promise<void> {
  await fs.mkdir(binDir, { recursive: true });
  for (const tool of ['mysql', 'mysqldump']) {
    const shim = path.join(binDir, tool);
    // `-i` so `source` can read a dump on stdin-less invocations too; MYSQL_PWD
    // is how the provider passes the password, so forward it explicitly.
    await fs.writeFile(
      shim,
      `#!/bin/sh\nexec docker exec -i -e MYSQL_PWD="$MYSQL_PWD" ${CONTAINER} ${tool} "$@"\n`,
      { mode: 0o755 },
    );
  }
}

async function startMysql(): Promise<string> {
  await runner.run('docker', ['rm', '-f', CONTAINER], { allowFailure: true });
  const run = await runner.run(
    'docker',
    [
      'run', '-d', '--name', CONTAINER,
      '-e', `MYSQL_ROOT_PASSWORD=${PASSWORD}`,
      '-e', `MYSQL_DATABASE=${DB}`,
      '-v', `${WORK}:${WORK}`,
      MYSQL_IMAGE,
    ],
    { allowFailure: true },
  );
  if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * The entrypoint runs a temporary server for initialization before the real one
 * listens, so probing with `SELECT 1` succeeds too early. Wait for the log line
 * that only the real server prints.
 */
async function waitReady(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const logs = await runner.run('docker', ['logs', CONTAINER], { allowFailure: true });
    if (/port: 3306\s+MySQL Community Server/.test(logs.stdout + logs.stderr)) {
      const probe = await runner.run('docker', ['exec', CONTAINER, 'mysql', `-uroot`, `-p${PASSWORD}`, '-N', '-e', 'SELECT 1'], { allowFailure: true });
      if (probe.code === 0) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('mysql did not become ready in time');
}

/** Run SQL directly against the server, bypassing the provider. */
async function sql(statement: string): Promise<string> {
  const res = await runner.run(
    'docker',
    ['exec', CONTAINER, 'mysql', '-uroot', `-p${PASSWORD}`, DB, '-N', '-B', '-e', statement],
    { allowFailure: true },
  );
  if (res.code !== 0) throw new Error(`mysql failed: ${res.stderr}`);
  return res.stdout.trim();
}

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  if (!dockerOk) return;
  try {
    await fs.rm(WORK, { recursive: true, force: true });
    await fs.mkdir(path.join(WORK, 'home'), { recursive: true });
    await writeShims(path.join(WORK, 'bin'));
    process.env.PATH = `${path.join(WORK, 'bin')}${path.delimiter}${process.env.PATH}`;
    process.env.ENVBEAM_HOME = path.join(WORK, 'home');
    process.env.ENVBEAM_MACHINE = 'mysqlbox';

    containerId = await startMysql();
    await waitReady();
  } catch (e) {
    dockerOk = false;
    process.stderr.write(`[mysql integration] skipping: ${(e as Error).message}\n`);
  }
}, 180_000);

afterAll(async () => {
  if (containerId) await runner.run('docker', ['rm', '-f', CONTAINER], { allowFailure: true });
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_MACHINE;
  await fs.rm(WORK, { recursive: true, force: true }).catch(() => undefined);
}, 60_000);

function mysqlCtx(root: string): ProviderContext {
  return makeTestContext({
    config: {
      version: 1,
      workspace: 'keeper',
      database: { provider: 'mysql', mode: 'snapshot', changeTables: ['seed_users'] },
    },
    runner,
    workspaceRoot: root,
    env: { DATABASE_URL: `mysql://root:${PASSWORD}@127.0.0.1:3306/${DB}` },
  }).providerCtx('database');
}

const SNAP: SnapshotOptions = {
  dataOnly: true,
  compress: false,
  includeTables: [],
  excludeTables: [],
  machine: 'mysqlbox',
  timestamp: '20260101T000000Z',
};

describe(`mysql provider (real docker ${MYSQL_IMAGE})`, () => {
  it('reports reachable status and detects change', async () => {
    if (!dockerOk) return;
    const ctx = mysqlCtx(WORK);
    expect((await new MysqlProvider().status(ctx)).reachable).toBe(true);

    await sql('DROP TABLE IF EXISTS seed_users');
    await sql('CREATE TABLE seed_users(id INT AUTO_INCREMENT PRIMARY KEY, name TEXT)');
    const provider = new MysqlProvider();
    const first = await provider.hasChanged(ctx, undefined);
    expect(first.fingerprint).toBeTruthy();

    await sql("INSERT INTO seed_users(name) VALUES ('alice')");
    expect((await provider.hasChanged(ctx, first.fingerprint)).changed).toBe(true);
  }, 60_000);

  it('reads the target tables off a data-only dump', async () => {
    if (!dockerOk) return;
    const f = path.join(WORK, 'sample.sql');
    await fs.writeFile(
      f,
      [
        '-- MySQL dump',
        'LOCK TABLES `notes` WRITE;',
        "INSERT INTO `notes` VALUES (1,'a');",
        'UNLOCK TABLES;',
        'LOCK TABLES `we``ird` WRITE;',
        'INSERT INTO `we``ird` VALUES (1);',
        'UNLOCK TABLES;',
      ].join('\n'),
    );
    expect((await mysqlDumpTables(f)).sort()).toEqual(['notes', 'we`ird']);
  });

  /**
   * The cross-machine case: this database already holds rows, and the snapshot
   * holds different ones under the same primary keys. A data-only dump appends,
   * so the restore collided on every key and (unlike postgres, which reported
   * success) failed outright. Either way the tables must end up holding exactly
   * what the snapshot holds.
   */
  it('restore over conflicting rows replaces them', async () => {
    if (!dockerOk) return;
    const provider = new MysqlProvider();
    const ctx = mysqlCtx(WORK);

    await sql('DROP TABLE IF EXISTS seed_users');
    await sql('CREATE TABLE seed_users(id INT AUTO_INCREMENT PRIMARY KEY, name TEXT)');
    await sql("INSERT INTO seed_users(name) VALUES ('alice'),('bob')");

    const snap = await provider.snapshot(ctx, SNAP);
    expect(snap.sizeBytes).toBeGreaterThan(0);

    // The other machine's database: same ids, different rows, plus one more.
    await sql('TRUNCATE TABLE seed_users');
    await sql("INSERT INTO seed_users(name) VALUES ('zed'),('yan'),('xor')");

    const res = await provider.restore(ctx, snap.file);
    expect(res.restored).toBe(true);
    expect(await sql('SELECT count(*) FROM seed_users')).toBe('2');
    expect(await sql("SELECT group_concat(name ORDER BY id) FROM seed_users")).toBe('alice,bob');
  }, 90_000);

  it('truncates a table another table references by foreign key', async () => {
    if (!dockerOk) return;
    const provider = new MysqlProvider();
    const ctx = mysqlCtx(WORK);

    await sql('DROP TABLE IF EXISTS seed_tags');
    await sql('DROP TABLE IF EXISTS seed_users');
    await sql('CREATE TABLE seed_users(id INT PRIMARY KEY, name TEXT)');
    await sql('CREATE TABLE seed_tags(id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES seed_users(id))');
    await sql("INSERT INTO seed_users VALUES (1,'alice')");
    await sql('INSERT INTO seed_tags VALUES (1,1)');

    const snap = await provider.snapshot(ctx, SNAP);
    // Change both sides, then restore. TRUNCATE on a referenced table is refused
    // outright unless foreign key checks are off for the duration.
    await sql('DELETE FROM seed_tags');
    await sql("UPDATE seed_users SET name='changed'");
    await sql('INSERT INTO seed_tags VALUES (9,1)');

    const res = await provider.restore(ctx, snap.file);
    expect(res.restored).toBe(true);
    expect(await sql('SELECT name FROM seed_users WHERE id=1')).toBe('alice');
    expect(await sql('SELECT group_concat(id) FROM seed_tags')).toBe('1');
  }, 90_000);

  it('restores into a database missing some of the dump’s tables', async () => {
    if (!dockerOk) return;
    const provider = new MysqlProvider();
    const ctx = mysqlCtx(WORK);

    await sql('DROP TABLE IF EXISTS seed_tags');
    await sql('DROP TABLE IF EXISTS seed_users');
    await sql('CREATE TABLE seed_users(id INT PRIMARY KEY, name TEXT)');
    await sql("INSERT INTO seed_users VALUES (1,'alice')");
    const snap = await provider.snapshot(ctx, SNAP);

    // A fresh clone: the table exists (migrations ran) but holds nothing, and
    // TRUNCATE must not be attempted on tables that do not exist at all.
    await sql('TRUNCATE TABLE seed_users');
    const res = await provider.restore(ctx, snap.file);
    expect(res.restored).toBe(true);
    expect(await sql('SELECT count(*) FROM seed_users')).toBe('1');
  }, 90_000);

  it('a restore that genuinely fails is reported as a failure', async () => {
    if (!dockerOk) return;
    const provider = new MysqlProvider();
    const ctx = mysqlCtx(WORK);
    const bad = path.join(WORK, 'bad.sql');
    await fs.writeFile(bad, 'INSERT INTO `definitely_not_a_table` VALUES (1);\n');
    await expect(provider.restore(ctx, bad)).rejects.toThrow();
  }, 60_000);

  it('round-trips a gzipped dump', async () => {
    if (!dockerOk) return;
    const provider = new MysqlProvider();
    const ctx = mysqlCtx(WORK);

    await sql('DROP TABLE IF EXISTS seed_tags');
    await sql('DROP TABLE IF EXISTS seed_users');
    await sql('CREATE TABLE seed_users(id INT PRIMARY KEY, name TEXT)');
    await sql("INSERT INTO seed_users VALUES (1,'alice'),(2,'bob')");

    const snap = await provider.snapshot(ctx, { ...SNAP, compress: true });
    expect(snap.file.endsWith('.sql.gz')).toBe(true);

    await sql("UPDATE seed_users SET name='clobbered'");
    await sql('INSERT INTO seed_users VALUES (3,'.concat("'extra')"));

    const res = await provider.restore(ctx, snap.file);
    expect(res.restored).toBe(true);
    expect(await sql("SELECT group_concat(name ORDER BY id) FROM seed_users")).toBe('alice,bob');
  }, 90_000);
});
