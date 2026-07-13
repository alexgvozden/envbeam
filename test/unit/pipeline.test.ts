import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { promises as fs, copyFileSync } from 'node:fs';
import { runResume } from '../../src/core/pipeline/resume.js';
import { runPause } from '../../src/core/pipeline/pause.js';
import { runStatus } from '../../src/core/pipeline/status.js';
import { runPreflight } from '../../src/core/pipeline/preflight.js';
import { PreflightError, SafetyError } from '../../src/core/util/errors.js';
import { snapshotName } from '../../src/core/sync/types.js';
import { loadState } from '../../src/core/state.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import type { RunContext } from '../../src/core/pipeline/context.js';

const cleanups: Array<() => Promise<void>> = [];
let envbeamHome: string;

beforeEach(async () => {
  const { dir, cleanup } = await tmpDir('envbeam-home-');
  envbeamHome = dir;
  process.env.ENVBEAM_HOME = dir;
  process.env.ENVBEAM_MACHINE = 'testbox';
  // Snapshot at-rest encryption is required — provide test age keys.
  process.env.ENVBEAM_AGE_PUBLIC_KEY = 'age1testpub';
  process.env.ENVBEAM_AGE_PRIVATE_KEY = 'AGE-SECRET-KEY-test';
  cleanups.push(cleanup);
});
afterEach(async () => {
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_MACHINE;
  delete process.env.ENVBEAM_AGE_PUBLIC_KEY;
  delete process.env.ENVBEAM_AGE_PRIVATE_KEY;
  while (cleanups.length) await cleanups.pop()!();
});

/** A FakeRunner scripted for a healthy machine. */
function happyRunner(opts: { dirty?: string[]; behind?: number; noDbTools?: boolean } = {}): FakeRunner {
  const avail = ['git', 'doppler', 'docker', 'claude-sync', 'age'];
  if (!opts.noDbTools) avail.push('pg_dump', 'psql');
  const runner = new FakeRunner({ available: avail });
  // versions
  runner.on((c, a) => a[0] === '--version', { stdout: 'tool 1.0.0' });
  // fake age: encrypt copies in→out; decrypt copies out→in.
  runner.on('age', (_c, a) => {
    const o = a.indexOf('-o');
    if (o < 0) return { stdout: 'age 1.0' };
    copyFileSync(a[a.length - 1]!, a[o + 1]!);
    return {};
  });
  // git
  runner.on('git branch --show-current', { stdout: 'main\n' });
  runner.on('git status --porcelain', { stdout: (opts.dirty ?? []).map((f) => ` M ${f}`).join('\n') });
  runner.on('git rev-parse --abbrev-ref --symbolic-full-name', { stdout: 'origin/main' });
  runner.on('git rev-list', { stdout: `${opts.behind ?? 0}\t0` });
  runner.on('git remote get-url', { stdout: 'git@github-work:acme/keeper.git' });
  runner.on('git fetch', {});
  runner.on('git merge', {});
  runner.on('git add', {});
  runner.on('git commit', {});
  runner.on('git stash', {});
  runner.on('git push', {});
  // doppler
  runner.on('doppler me', { stdout: '{"name":"me"}' });
  runner.on('doppler projects', { stdout: JSON.stringify([{ name: 'keeper' }]) });
  runner.on('doppler secrets download', { stdout: JSON.stringify({ API_KEY: 'k', DATABASE_URL: 'postgres://app@localhost/keeper' }) });
  // docker / compose
  runner.on('docker info', { stdout: '25.0' });
  runner.on('docker compose', (_c, a) => (a.includes('ps') ? { stdout: JSON.stringify([{ Name: 'db', State: 'running' }]) } : {}));
  // postgres
  runner.on('psql', { stdout: '1' });
  // sh: tool-install commands make the DB client appear; everything else is migrate
  runner.on('sh', (_c, a) => {
    if (/brew|apt-get|dnf|winget|install/.test(a.join(' '))) {
      runner.available('pg_dump', 'psql');
      return {};
    }
    return { stdout: 'migrated' };
  });
  // session
  runner.on('claude-sync', {});
  return runner;
}

const fullConfig = (over: Record<string, unknown> = {}) => ({
  version: 1,
  workspace: 'keeper',
  git: { identity: undefined },
  secrets: { provider: 'doppler', project: 'keeper', config: 'dev' },
  container: { mode: 'compose' },
  database: { provider: 'postgres', mode: 'migrations-only', migrateCommand: 'npx prisma migrate deploy' },
  session: { provider: 'claude-sync' },
  ...over,
});

async function ctxOn(root: string, runner: FakeRunner, config: object, dryRun = false, prompter?: AutoPrompter): Promise<RunContext> {
  // compose provider resolves a real file on disk
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:16\n');
  return makeTestContext({ config, runner, workspaceRoot: root, dryRun, prompter });
}

describe('resume pipeline', () => {
  it('runs all steps and materializes secrets (migrations-only)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    const report = await runResume(await ctxOn(dir, runner, fullConfig()));

    expect(report.secrets?.count).toBe(2);
    expect(report.container?.running).toBe(true);
    expect(report.database?.migrated).toBe(true);
    expect(report.session?.action).toBe('pulled');
    // .env materialized + gitignored, never committed
    const env = await fs.readFile(path.join(dir, '.env'), 'utf8');
    expect(env).toMatch(/API_KEY="k"/);
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');
    // migration ran via shell
    expect(runner.calls.some((c) => c.command === 'sh')).toBe(true);
  });

  it('blocks when a required tool is missing (non-dry-run)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    // doppler absent on PATH → secrets concern blocks resume
    const runner = new FakeRunner({ available: ['git', 'docker', 'pg_dump', 'psql', 'claude-sync'] });
    runner.on((c, a) => a[0] === '--version', { stdout: 'tool 1.0.0' });
    runner.on('git branch --show-current', { stdout: 'main\n' });
    runner.on('git status --porcelain', { stdout: '' });
    runner.on('git rev-parse', { stdout: 'origin/main' });
    runner.on('git rev-list', { stdout: '0\t0' });
    runner.on('git remote get-url', { stdout: 'x' });
    runner.on('docker info', { stdout: '25' });
    runner.on('psql', { stdout: '1' });
    await expect(runResume(await ctxOn(dir, runner, fullConfig()))).rejects.toBeInstanceOf(PreflightError);
  });

  it('throws on an unresolved identity reference', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const ctx = makeTestContext({ config: fullConfig(), runner: happyRunner(), workspaceRoot: dir, identityWarnings: ['doppler:missing'] });
    await expect(runResume(ctx)).rejects.toThrow(/Unknown identity/);
  });

  it('restores a newer snapshot in snapshot mode (prompt → yes)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(envbeamHome, 'snaps');
    await fs.mkdir(syncDir, { recursive: true });
    // place a snapshot newer than (empty) state
    const snapFile = path.join(syncDir, snapshotName('keeper', '20260601T120000Z', 'desktop', 'sql'));
    await fs.writeFile(snapFile, '-- plain sql dump\n');

    const runner = happyRunner();
    runner.on('pg_restore', {});
    const config = fullConfig({
      database: {
        provider: 'postgres',
        mode: 'snapshot',
        restore: 'prompt',
        migrateCommand: 'npx prisma migrate deploy',
        sync: { target: 'local-folder', path: syncDir, keep: 5 },
      },
    });
    const ctx = await ctxOn(dir, runner, config, false, new AutoPrompter({ defaults: true }));
    const report = await runResume(ctx);
    expect(report.database?.restored?.timestamp).toBe('20260601T120000Z');
    // state records the restore so a re-run won't restore again
    const state = await loadState(dir);
    expect(state.lastRestoredTimestamp).toBe('20260601T120000Z');
  });
});

describe('pause pipeline', () => {
  it('migrations-only by default: pushes branch, no snapshot', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner({ behind: 0 });
    const report = await runPause(await ctxOn(dir, runner, fullConfig()), { force: false, workMode: 'none' });
    expect(report.git?.pushed).toBe(true);
    expect(report.database?.snapshot).toBeUndefined();
    expect(report.session?.action).toBe('pushed');
  });

  it('records git remote + branch into Doppler on push', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    await runPause(await ctxOn(dir, runner, fullConfig()), { force: false, workMode: 'none' });
    const set = runner.calls.find((c) => c.command === 'doppler' && c.args[0] === 'secrets' && c.args[1] === 'set');
    expect(set).toBeTruthy();
    expect(set!.args.some((a) => a.startsWith('ENVBEAM_GIT_BRANCH='))).toBe(true);
  });

  it('refuses to drop dirty work without commit/stash/force', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner({ dirty: ['x.ts'] });
    await expect(runPause(await ctxOn(dir, runner, fullConfig()), { force: false, workMode: 'none' })).rejects.toBeInstanceOf(SafetyError);
  });

  it('commits dirty work when asked', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner({ dirty: ['x.ts'] });
    const report = await runPause(await ctxOn(dir, runner, fullConfig()), { force: false, workMode: 'commit', message: 'wip' });
    expect(report.git?.committed).toBe(true);
    expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'commit')).toBe(true);
  });

  it('--snapshot dumps, uploads to local-folder, and records state', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(envbeamHome, 'snaps');
    const runner = happyRunner();
    runner.on('pg_dump', (_c, args) => {
      const i = args.indexOf('-f');
      if (i < 0) return { stdout: 'pg_dump 14.0' };
      void fs.writeFile(args[i + 1]!, '-- dump\n');
      return {};
    });
    const config = fullConfig({
      database: {
        provider: 'postgres',
        mode: 'snapshot',
        migrateCommand: 'npx prisma migrate deploy',
        snapshot: { dataOnly: true, compress: false },
        sync: { target: 'local-folder', path: syncDir, keep: 5 },
      },
    });
    const report = await runPause(await ctxOn(dir, runner, config), { force: false, snapshot: true, workMode: 'none' });
    expect(report.database?.snapshot?.timestamp).toBeTruthy();
    const files = await fs.readdir(syncDir);
    expect(files.some((f) => f.startsWith('keeper__'))).toBe(true);
    const state = await loadState(dir);
    expect(state.lastSnapshotTimestamp).toBeTruthy();
  });

  it('two-way secrets: aborts before touching git when the provider is unauthenticated', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    runner.on('doppler me', { code: 1, stderr: 'you must provide a token' }); // not logged in
    const cfg = fullConfig({ secrets: { provider: 'doppler', project: 'keeper', config: 'dev', sync: 'two-way' } });
    await expect(
      runPause(await ctxOn(dir, runner, cfg), { force: false, workMode: 'none' }),
    ).rejects.toBeInstanceOf(PreflightError);
    // fail-fast: git must not have been pushed
    expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'push')).toBe(false);
  });

  it('two-way secrets: aborts before git when the Doppler project is missing and creation is declined', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    runner.on('doppler projects', { stdout: '[]' }); // authed, but project does not exist
    const decline = new AutoPrompter({ answers: [{ match: 'Create it now', value: false }] }); // user says no
    const cfg = fullConfig({ secrets: { provider: 'doppler', project: 'keeper', config: 'dev', sync: 'two-way' } });
    await expect(
      runPause(await ctxOn(dir, runner, cfg, false, decline), { force: false, workMode: 'none' }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'push')).toBe(false);
    expect(runner.calls.some((c) => c.command === 'doppler' && c.args[0] === 'projects' && c.args[1] === 'create')).toBe(false);
  });

  it('two-way secrets: creates the Doppler project when missing and confirmed', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    let created = false;
    runner.on('doppler projects', (_c, a) => {
      if (a[0] === 'create') { created = true; return {}; }
      return { stdout: created ? JSON.stringify([{ name: 'keeper' }]) : '[]' };
    });
    const cfg = fullConfig({ secrets: { provider: 'doppler', project: 'keeper', config: 'dev', sync: 'two-way' } });
    const report = await runPause(await ctxOn(dir, runner, cfg), { force: false, workMode: 'none' });
    expect(runner.calls.some((c) => c.command === 'doppler' && c.args[0] === 'projects' && c.args[1] === 'create' && c.args[2] === 'keeper')).toBe(true);
    expect(report.git?.pushed).toBe(true);
  });

  it('two-way secrets: proceeds past preflight when authenticated', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    const cfg = fullConfig({ secrets: { provider: 'doppler', project: 'keeper', config: 'dev', sync: 'two-way' } });
    const report = await runPause(await ctxOn(dir, runner, cfg), { force: false, workMode: 'none' });
    expect(report.git?.pushed).toBe(true);
    expect(report.secrets?.action).toBeDefined();
  });

  it('installs missing DB client tools on push instead of skipping (auto-install rule)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(envbeamHome, 'snaps');
    const runner = happyRunner({ noDbTools: true }); // pg_dump/psql absent until "installed"
    runner.on('psql', (_c, args) => (args.includes('SELECT 1') ? { stdout: '1' } : { stdout: '5' }));
    runner.on('pg_dump', (_c, args) => {
      const i = args.indexOf('-f');
      if (i < 0) return { stdout: 'pg_dump 14.0' };
      void fs.writeFile(args[i + 1]!, '-- dump\n');
      return {};
    });
    const config = fullConfig({
      database: {
        provider: 'postgres',
        mode: 'snapshot',
        migrateCommand: 'm',
        changeTables: ['seed_users'],
        snapshot: { dataOnly: true, compress: false },
        sync: { target: 'local-folder', path: syncDir, keep: 5 },
      },
    });
    const report = await runPause(await ctxOn(dir, runner, config), { force: false, snapshot: true, workMode: 'none' });
    // ran an install command and then succeeded in taking the snapshot
    expect(runner.calls.some((c) => c.command === 'sh' && /brew|apt|install/.test(c.args.join(' ')))).toBe(true);
    expect(report.database?.snapshot?.timestamp).toBeTruthy();
  });

  it('first push with nothing backed up snapshots; unchanged pushes skip; changes snapshot', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const syncDir = path.join(envbeamHome, 'snaps');
    let rows = 3;
    const runner = happyRunner();
    runner.on('psql', (_c, args) => (args.includes('SELECT 1') ? { stdout: '1' } : { stdout: String(rows) }));
    runner.on('pg_dump', (_c, args) => {
      const i = args.indexOf('-f');
      if (i < 0) return { stdout: 'pg_dump 14.0' };
      void fs.writeFile(args[i + 1]!, '-- dump\n');
      return {};
    });
    const config = fullConfig({
      database: {
        provider: 'postgres',
        mode: 'snapshot',
        migrateCommand: 'm',
        changeTables: ['seed_users'],
        snapshot: { dataOnly: true, compress: false },
        sync: { target: 'local-folder', path: syncDir, keep: 5 },
      },
    });
    // r1: first push and nothing backed up yet → takes an initial snapshot
    const r1 = await runPause(await ctxOn(dir, runner, config), { force: false, workMode: 'none' });
    expect(r1.database?.snapshot?.timestamp).toBeTruthy();
    const state = await loadState(dir);
    expect(state.dbFingerprint).toBeTruthy();

    // r2: nothing changed and a snapshot already exists → skips
    const r2 = await runPause(await ctxOn(dir, runner, config), { force: false, workMode: 'none' });
    expect(r2.database?.snapshot).toBeUndefined();

    // r3: data changed → snapshot (prompter confirms)
    rows = 99;
    const r3 = await runPause(await ctxOn(dir, runner, config, false, new AutoPrompter({ defaults: true })), { force: false, workMode: 'none' });
    expect(r3.database?.snapshot?.timestamp).toBeTruthy();
  });
});

describe('status + preflight', () => {
  it('status aggregates without mutating', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = happyRunner();
    const report = await runStatus(await ctxOn(dir, runner, fullConfig()));
    expect(report.git?.branch).toBe('main');
    expect(report.container?.running).toBe(true);
    // no mutating git calls
    expect(runner.calls.some((c) => c.args[0] === 'fetch' || c.args[0] === 'push')).toBe(false);
  });

  it('preflight flags a missing tool', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['git', 'docker', 'pg_dump', 'psql', 'claude-sync'] });
    runner.on((c, a) => a[0] === '--version', { stdout: 'v1' });
    runner.on('git', { stdout: 'origin/main' });
    runner.on('docker info', { stdout: '25' });
    runner.on('psql', { stdout: '1' });
    const pre = await runPreflight(await ctxOn(dir, runner, fullConfig()));
    expect(pre.ok).toBe(false);
    expect(pre.checks.find((c) => c.command === 'doppler')?.present).toBe(false);
  });
});
