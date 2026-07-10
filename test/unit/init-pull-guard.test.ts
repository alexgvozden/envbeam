import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { tmpDir, writeFiles } from '../helpers/context.js';
import { FakeRunner } from '../helpers/fakeRunner.js';

const ENTRY = {
  name: 'synthetic-signals',
  gitRemote: 'git@github.com:acme/synthetic-signals.git',
  gitBranch: 'main',
  configSnapshot: 'version: 1\nworkspace: synthetic-signals\n',
  lastPush: '2026-01-01T00:00:00.000Z',
  machineId: 'other-machine',
};

const getProject = vi.fn(async (n: string) => (n === ENTRY.name ? ENTRY : undefined));
const registerProject = vi.fn(async () => {});

vi.mock('../../src/core/registry/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isStorageConfigured: vi.fn(async () => true),
  createRegistryStore: vi.fn(async () => ({ getProject, registerProject })),
  checkProjectRegistration: vi.fn(async () => {}),
}));

vi.mock('../../src/commands/storage.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureStorageReady: vi.fn(async () => true),
}));

const runResume = vi.fn(async () => {});
vi.mock('../../src/core/pipeline/resume.js', () => ({ runResume }));
vi.mock('../../src/core/pipeline/context.js', () => ({ buildRunContext: vi.fn(async () => ({})) }));

const { initCommand } = await import('../../src/commands/init.js');
const { pullCommand } = await import('../../src/commands/pull.js');

const cleanups: Array<() => Promise<void>> = [];
let originalCwd: string;
let out = '';

beforeEach(() => {
  originalCwd = process.cwd();
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => ((out += String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => ((out += String(c)), true));
  runResume.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  while (cleanups.length) await cleanups.pop()!();
});

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const { dir, cleanup } = await tmpDir('envbeam-guard-');
  cleanups.push(cleanup);
  await writeFiles(dir, files);
  process.env.ENVBEAM_HOME = path.join(dir, '.home');
  process.chdir(dir);
  return dir;
}

/** Repo that is 2 commits ahead of origin/main with one uncommitted file. */
function aheadRepo() {
  return new FakeRunner()
    .on('git rev-parse --is-inside-work-tree', { stdout: 'true\n' })
    .on('git branch --show-current', { stdout: 'main\n' })
    .on('git rev-parse --abbrev-ref --symbolic-full-name', { stdout: 'origin/main\n' })
    .on('git rev-list --left-right --count', { stdout: '0\t2\n' })
    .on('git log --oneline', { stdout: 'aaa1 local work\nbbb2 more local work\n' })
    .on('git status --porcelain', { stdout: ' M src/a.ts\n' })
    .on('git remote get-url', { stdout: `${ENTRY.gitRemote}\n` });
}

describe('init <name> on an already-registered project', () => {
  it('does not pull without confirmation; scaffolds a config instead', async () => {
    const dir = await workspace({ '.env.example': 'API_KEY=\n' });

    // Non-TTY, no --yes → AutoPrompter answers the confirm with its default (false).
    const code = await initCommand({ project: ENTRY.name, runner: aheadRepo() });

    expect(code).toBe(0);
    expect(runResume).not.toHaveBeenCalled();
    expect(out).toMatch(/already exists in the registry/i);
    expect(out).toMatch(/Not pulling/i);

    const cfg = await import('node:fs').then((m) => m.promises.readFile(path.join(dir, '.envbeam.yaml'), 'utf8'));
    expect(cfg).toMatch(/workspace: synthetic-signals/);
  });

  it('warns before pulling rather than silently bootstrapping', async () => {
    await workspace();
    await initCommand({ project: ENTRY.name, runner: aheadRepo() });
    expect(out).toMatch(/overwrites \.env/i);
  });
});

describe('pull <name> into an existing checkout with unsynced work', () => {
  it('aborts without running resume when the confirm is declined', async () => {
    const parent = await workspace();
    await writeFiles(path.join(parent, ENTRY.name), { '.envbeam.yaml': ENTRY.configSnapshot });

    const code = await pullCommand({ project: ENTRY.name, runner: aheadRepo() });

    expect(code).toBe(1);
    expect(runResume).not.toHaveBeenCalled();
    expect(out).toMatch(/2 commit\(s\) ahead/i);
    expect(out).toMatch(/aaa1 local work/);
    expect(out).toMatch(/1 uncommitted file/i);
    expect(out).toMatch(/cancelled/i);
  });

  it('proceeds when confirmed via --yes', async () => {
    const parent = await workspace();
    await writeFiles(path.join(parent, ENTRY.name), { '.envbeam.yaml': ENTRY.configSnapshot });

    const code = await pullCommand({ project: ENTRY.name, runner: aheadRepo(), yes: true });

    expect(code).toBe(0);
    expect(runResume).toHaveBeenCalledOnce();
  });

  it('runs without prompting when the checkout is clean and in sync', async () => {
    const parent = await workspace();
    await writeFiles(path.join(parent, ENTRY.name), { '.envbeam.yaml': ENTRY.configSnapshot });

    const clean = aheadRepo()
      .on('git rev-list --left-right --count', { stdout: '0\t0\n' })
      .on('git status --porcelain', { stdout: '' });

    expect(await pullCommand({ project: ENTRY.name, runner: clean })).toBe(0);
    expect(runResume).toHaveBeenCalledOnce();
  });

  it('restores a missing config from the snapshot instead of dead-ending', async () => {
    const parent = await workspace();
    await writeFiles(path.join(parent, ENTRY.name), { 'README.md': '# hi\n' });

    const clean = aheadRepo()
      .on('git rev-list --left-right --count', { stdout: '0\t0\n' })
      .on('git status --porcelain', { stdout: '' });

    const code = await pullCommand({ project: ENTRY.name, runner: clean });

    expect(code).toBe(0);
    const cfg = await import('node:fs').then((m) =>
      m.promises.readFile(path.join(parent, ENTRY.name, '.envbeam.yaml'), 'utf8'),
    );
    expect(cfg).toBe(ENTRY.configSnapshot);
  });
});
