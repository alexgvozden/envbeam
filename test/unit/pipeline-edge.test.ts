import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { promises as fs, writeFileSync, copyFileSync } from 'node:fs';
import { runResume } from '../../src/core/pipeline/resume.js';
import { runPause } from '../../src/core/pipeline/pause.js';
import { runStatus, printStatus } from '../../src/core/pipeline/status.js';
import { snapshotName } from '../../src/core/sync/types.js';
import { patchState, loadState } from '../../src/core/state.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import type { RunContext } from '../../src/core/pipeline/context.js';

const cleanups: Array<() => Promise<void>> = [];
let home: string;

beforeEach(async () => {
  const t = await tmpDir('envbeam-home-edge-');
  home = t.dir;
  process.env.ENVBEAM_HOME = home;
  process.env.ENVBEAM_MACHINE = 'edgebox';
  cleanups.push(t.cleanup);
});
afterEach(async () => {
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_MACHINE;
  while (cleanups.length) await cleanups.pop()!();
});

function baseRunner(over: { dirty?: string[]; psqlRows?: () => string } = {}): FakeRunner {
  const r = new FakeRunner({ available: ['git', 'doppler', 'docker', 'pg_dump', 'psql', 'claude-sync'] });
  r.on((c, a) => a[0] === '--version', { stdout: 'v1' });
  // catch-all git registered first so specific git stubs below take precedence
  r.on('git', {});
  r.on('git branch --show-current', { stdout: 'main\n' });
  r.on('git status --porcelain', { stdout: (over.dirty ?? []).map((f) => ` M ${f}`).join('\n') });
  r.on('git rev-parse', { stdout: 'origin/main' });
  r.on('git rev-list', { stdout: '0\t0' });
  r.on('git remote get-url', { stdout: 'x' });
  r.on('doppler me', { stdout: '{}' });
  r.on('doppler secrets download', { stdout: '{"A":"1"}' });
  r.on('docker info', { stdout: '25' });
  r.on('docker compose', (_c, a) => (a.includes('ps') ? { stdout: '[]' } : {}));
  r.on('psql', (_c, a) => (a.includes('SELECT 1') ? { stdout: '1' } : { stdout: over.psqlRows ? over.psqlRows() : '0' }));
  r.on('sh', { stdout: 'ok' });
  r.on('claude-sync', {});
  r.on('pg_dump', (_c, a) => {
    const i = a.indexOf('-f');
    if (i < 0) return { stdout: 'pg_dump 14.0' }; // --version probe
    writeFileSync(a[i + 1]!, '-- dump\n'.repeat(10));
    return {};
  });
  return r;
}

async function ctxOn(root: string, runner: FakeRunner, config: object, prompter?: AutoPrompter): Promise<RunContext> {
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:16\n');
  return makeTestContext({ config, runner, workspaceRoot: root, prompter });
}

const snapConfig = (sync: object, over: object = {}) => ({
  version: 1,
  workspace: 'keeper',
  secrets: { provider: 'doppler' },
  container: { mode: 'compose' },
  database: { provider: 'postgres', mode: 'snapshot', migrateCommand: 'm', snapshot: { dataOnly: true, compress: false }, sync, ...over },
  session: { provider: 'none' },
});

describe('resume edge cases', () => {
  it('declines restore when prompter says no', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(home, 'snaps');
    await fs.mkdir(syncDir, { recursive: true });
    await fs.writeFile(path.join(syncDir, snapshotName('keeper', '20260601T120000Z', 'desktop', 'sql')), '-- sql\n');
    const runner = baseRunner();
    const ctx = await ctxOn(dir, runner, snapConfig({ target: 'local-folder', path: syncDir }), new AutoPrompter({ answers: [{ match: 'Restore', value: false }] }));
    const report = await runResume(ctx);
    expect(report.database?.restored).toBeUndefined();
    expect(runner.calls.some((c) => c.command === 'pg_restore')).toBe(false);
  });

  it('skips restore when state already reflects the latest snapshot', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(home, 'snaps');
    await fs.mkdir(syncDir, { recursive: true });
    await fs.writeFile(path.join(syncDir, snapshotName('keeper', '20260601T120000Z', 'desktop', 'sql')), '-- sql\n');
    await patchState(dir, { lastRestoredTimestamp: '20260601T120000Z' });
    const ctx = await ctxOn(dir, baseRunner(), snapConfig({ target: 'local-folder', path: syncDir }, { restore: 'auto' }));
    const report = await runResume(ctx);
    expect(report.database?.restored).toBeUndefined();
  });

  it('migrations-only mode never restores even with snapshots present', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const config = { ...snapConfig({ target: 'local-folder', path: path.join(home, 'snaps') }), database: { provider: 'postgres', mode: 'migrations-only', migrateCommand: 'm' } };
    const report = await runResume(await ctxOn(dir, baseRunner(), config));
    expect(report.database?.restored).toBeUndefined();
    expect(report.database?.migrated).toBe(true);
  });
});

describe('pause edge cases', () => {
  it('--no-snapshot forces skip in snapshot mode', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const report = await runPause(await ctxOn(dir, baseRunner(), snapConfig({ target: 'local-folder', path: path.join(home, 'snaps') })), { force: false, snapshot: false, workMode: 'none' });
    expect(report.database?.snapshot).toBeUndefined();
    expect(report.database?.skipped).toMatch(/--no-snapshot/);
  });

  it('aborts upload when the dump exceeds the size cap', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(home, 'snaps');
    const report = await runPause(
      await ctxOn(dir, baseRunner(), snapConfig({ target: 'local-folder', path: syncDir, maxSizeMB: 0.000001 })),
      { force: false, snapshot: true, workMode: 'none' },
    );
    expect(report.database?.snapshot).toBeUndefined();
    expect(report.database?.skipped).toMatch(/over size cap/);
    // nothing uploaded
    const files = await fs.readdir(syncDir).catch(() => []);
    expect(files).toHaveLength(0);
  });

  it('stops the container when stopOnPause is set', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = baseRunner();
    const config = { version: 1, workspace: 'w', container: { mode: 'compose', stopOnPause: true }, session: { provider: 'none' } };
    const report = await runPause(await ctxOn(dir, runner, config), { force: false, workMode: 'none' });
    expect(report.container?.stopped).toBe(true);
    expect(runner.calls.some((c) => c.args.includes('stop'))).toBe(true);
  });
});

describe('status printing', () => {
  it('prints a human-readable summary including identity warnings', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const lines: string[] = [];
    const ctx = makeTestContext({
      config: snapConfig({ target: 'local-folder', path: path.join(home, 'snaps') }),
      runner: baseRunner(),
      workspaceRoot: dir,
      identityWarnings: ['doppler:missing'],
      logLines: lines,
    });
    await fs.writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:16\n');
    const report = await runStatus(ctx);
    printStatus(ctx, report);
    const out = lines.join('\n');
    expect(out).toMatch(/Workspace: keeper/);
    expect(out).toMatch(/unresolved identities: doppler:missing/);
    expect(out).toMatch(/git\s+main/);
  });
});

describe('encrypted snapshot round trip (fake age)', () => {
  it('encrypts on pause and decrypts on resume', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(home, 'snaps');
    const runner = baseRunner();
    runner.available('age');
    // fake age: encrypt copies in→out, decrypt copies out→in (synchronously)
    runner.on('age', (_c, a) => {
      const o = a.indexOf('-o');
      if (o < 0) return { stdout: 'age 1.0' }; // --version probe
      copyFileSync(a[a.length - 1]!, a[o + 1]!);
      return {};
    });
    const sync = { target: 'local-folder', path: syncDir, encrypt: 'age', recipient: 'age1xyz', keep: 5 };

    const pauseReport = await runPause(await ctxOn(dir, runner, snapConfig(sync)), { force: false, snapshot: true, workMode: 'none' });
    expect(pauseReport.database?.snapshot?.file.endsWith('.age')).toBe(true);
    const files = await fs.readdir(syncDir);
    expect(files.every((f) => f.endsWith('.age'))).toBe(true);

    // resume restores: download + age decrypt + psql restore (plain dump)
    const resumeReport = await runResume(await ctxOn(dir, runner, snapConfig(sync, { restore: 'auto' })));
    expect(resumeReport.database?.restored).toBeTruthy();
    expect(runner.calls.some((c) => c.command === 'age' && c.args.includes('-d'))).toBe(true);
    expect(runner.calls.some((c) => c.command === 'psql' && c.args.includes('-f'))).toBe(true);
    const state = await loadState(dir);
    expect(state.lastRestoredTimestamp).toBeTruthy();
  });

  it('encrypts by default with age when keys are available (no explicit sync.encrypt)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(home, 'snaps');
    const runner = baseRunner();
    runner.available('age');
    runner.on('age', (_c, a) => {
      const o = a.indexOf('-o');
      if (o < 0) return { stdout: 'age 1.0' };
      copyFileSync(a[a.length - 1]!, a[o + 1]!);
      return {};
    });
    process.env.ENVBEAM_AGE_PUBLIC_KEY = 'age1testpub';
    process.env.ENVBEAM_AGE_PRIVATE_KEY = 'AGE-SECRET-KEY-test';
    try {
      const sync = { target: 'local-folder', path: syncDir, keep: 5 }; // no encrypt field
      const report = await runPause(await ctxOn(dir, runner, snapConfig(sync)), { force: false, snapshot: true, workMode: 'none' });
      expect(report.database?.snapshot?.file.endsWith('.age')).toBe(true);
      const files = await fs.readdir(syncDir);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.endsWith('.age'))).toBe(true);
    } finally {
      delete process.env.ENVBEAM_AGE_PUBLIC_KEY;
      delete process.env.ENVBEAM_AGE_PRIVATE_KEY;
    }
  });
});
