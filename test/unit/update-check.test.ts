import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  compareSemver,
  detectInstallMethod,
  runUpdateCheck,
  type UpdateCheckDeps,
} from '../../src/core/util/updateCheck.js';
import { stateDir } from '../../src/core/config/paths.js';
import { tmpDir } from '../helpers/context.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { Logger } from '../../src/core/util/logger.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('orders core versions numerically, not lexically (0.9.0 < 0.10.0)', () => {
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
  });

  it('ranks a prerelease below its release (0.18.0-beta.1 < 0.18.0)', () => {
    expect(compareSemver('0.18.0-beta.1', '0.18.0')).toBe(-1);
    expect(compareSemver('0.18.0', '0.18.0-beta.1')).toBe(1);
  });

  it('orders prerelease identifiers per semver precedence', () => {
    expect(compareSemver('0.18.0-alpha', '0.18.0-beta')).toBe(-1);
    expect(compareSemver('0.18.0-beta.1', '0.18.0-beta.2')).toBe(-1);
    expect(compareSemver('0.18.0-beta.2', '0.18.0-beta.10')).toBe(-1); // numeric, not lexical
    expect(compareSemver('0.18.0-1', '0.18.0-alpha')).toBe(-1); // numeric < alphanumeric
    expect(compareSemver('0.18.0-beta', '0.18.0-beta.1')).toBe(-1); // fewer identifiers lower
  });

  it('tolerates leading v and build metadata', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3+build.5', '1.2.3+build.9')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runUpdateCheck / detectInstallMethod
// ---------------------------------------------------------------------------

let out = '';
let cleanup: (() => Promise<void>) | undefined;
const GLOBAL_ROOT = '/usr/local/lib/node_modules';
const GLOBAL_PKG_ROOT = `${GLOBAL_ROOT}/envbeam`;

beforeEach(async () => {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => {
    out += String(c);
    return true;
  });
  const t = await tmpDir('envbeam-update-');
  cleanup = t.cleanup;
  process.env.ENVBEAM_HOME = path.join(t.dir, '.home');
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.ENVBEAM_HOME;
  if (cleanup) await cleanup();
  cleanup = undefined;
});

/** A fetch stub that answers the npm /latest endpoint with `version`. */
function fetchReturning(version: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ version }),
  })) as unknown as typeof fetch;
}

function baseDeps(overrides: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
  return {
    currentVersion: '0.17.0',
    packageRoot: GLOBAL_PKG_ROOT, // looks like a global install by default
    isCompiled: true,
    runner,
    logger: new Logger({ level: 'info' }),
    prompter: new AutoPrompter({ answers: [{ match: 'Upgrade', value: true }] }),
    interactive: true,
    assumeYes: false,
    argv: ['node', '/usr/local/bin/envbeam', 'status'],
    now: 1_000_000,
    reExec: () => {
      /* record via override in tests that care */
    },
    ...overrides,
  };
}

async function readCacheFile(): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir(), 'update-check.json'), 'utf8'));
  } catch {
    return null;
  }
}

describe('runUpdateCheck', () => {
  it('newer version available → prompts → runs the global upgrade and re-execs', async () => {
    const runner = new FakeRunner({ available: ['npm'] })
      .on('npm root -g', { stdout: GLOBAL_ROOT })
      .on('npm install -g envbeam@latest', { code: 0 });
    let reExecArgv: string[] | undefined;
    const deps = baseDeps({
      runner,
      fetchImpl: fetchReturning('0.18.0'),
      reExec: (argv) => {
        reExecArgv = argv;
      },
    });
    await runUpdateCheck(deps);

    expect(runner.called('npm install -g envbeam@latest')).toBe(true);
    expect(reExecArgv).toEqual(['node', '/usr/local/bin/envbeam', 'status']);
    expect(out).toMatch(/0\.17\.0 → 0\.18\.0/);
  });

  it('declined → no upgrade, command proceeds, and the version is snoozed', async () => {
    const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
    const deps = baseDeps({
      runner,
      fetchImpl: fetchReturning('0.18.0'),
      prompter: new AutoPrompter({ answers: [{ match: 'Upgrade', value: false }] }),
    });
    await runUpdateCheck(deps);

    expect(runner.called('npm install -g')).toBe(false);
    const cache = await readCacheFile();
    expect(cache.snoozedVersion).toBe('0.18.0');
  });

  it('does not re-prompt for a version the user already snoozed', async () => {
    const confirm = vi.fn(async () => true);
    const deps = baseDeps({
      fetchImpl: fetchReturning('0.18.0'),
      prompter: { interactive: true, confirm } as any,
    });
    // Seed the cache as if 0.18.0 was declined earlier today.
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(
      path.join(stateDir(), 'update-check.json'),
      JSON.stringify({ checkedAt: 999_999, latest: '0.18.0', snoozedVersion: '0.18.0' }),
    );
    await runUpdateCheck(deps);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('network failure / timeout → silent continue, no prompt, no error', async () => {
    const confirm = vi.fn(async () => true);
    const failingFetch = vi.fn(async () => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    }) as unknown as typeof fetch;
    const deps = baseDeps({
      fetchImpl: failingFetch,
      prompter: { interactive: true, confirm } as any,
    });
    await expect(runUpdateCheck(deps)).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(out).not.toMatch(/available/);
  });

  it('records a failed registry read so the next command does not refetch', async () => {
    // Without negative caching, an offline machine — or an unpublished package
    // whose /latest 404s — pays the timeout on EVERY command, forever.
    const failingFetch = vi.fn(async () => {
      throw new Error('ENOTFOUND registry.npmjs.org');
    }) as unknown as typeof fetch;

    await runUpdateCheck(baseDeps({ fetchImpl: failingFetch, now: 1_000_000 }));
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect((await readCacheFile())?.checkedAt).toBe(1_000_000);

    // A second command 10 minutes later must not touch the network.
    await runUpdateCheck(baseDeps({ fetchImpl: failingFetch, now: 1_000_000 + 600_000 }));
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it('retries the registry an hour after a failure, not a full day', async () => {
    const failingFetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    await runUpdateCheck(baseDeps({ fetchImpl: failingFetch, now: 1_000_000 }));
    expect(failingFetch).toHaveBeenCalledTimes(1);

    // A failure record expires after FAILURE_TTL_MS (1h), unlike a success (24h).
    const later = 1_000_000 + 61 * 60 * 1000;
    await runUpdateCheck(baseDeps({ fetchImpl: failingFetch, now: later }));
    expect(failingFetch).toHaveBeenCalledTimes(2);
  });

  it('a 404 (unpublished package) never prompts or upgrades', async () => {
    const confirm = vi.fn(async () => true);
    const notFound = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
    await runUpdateCheck(
      baseDeps({ fetchImpl: notFound, runner, prompter: { interactive: true, confirm } as any }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(runner.called('npm install')).toBe(false);
  });

  it('cache within TTL → no second registry hit', async () => {
    const fetchImpl = fetchReturning('0.18.0');
    // First call fetches and writes the cache; decline so nothing mutates.
    await runUpdateCheck(
      baseDeps({
        fetchImpl,
        prompter: new AutoPrompter({ answers: [{ match: 'Upgrade', value: false }] }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Second call a minute later is within the 24h TTL → served from cache.
    await runUpdateCheck(
      baseDeps({
        fetchImpl,
        now: 1_060_000,
        prompter: new AutoPrompter({ answers: [{ match: 'Upgrade', value: false }] }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still one — no second hit
  });

  it('non-interactive → notice only, never prompts or upgrades', async () => {
    const confirm = vi.fn(async () => true);
    const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
    const deps = baseDeps({
      runner,
      fetchImpl: fetchReturning('0.18.0'),
      interactive: false,
      prompter: { interactive: false, confirm } as any,
    });
    await runUpdateCheck(deps);
    expect(confirm).not.toHaveBeenCalled();
    expect(runner.called('npm install -g')).toBe(false);
    expect(out).toMatch(/0\.17\.0 → 0\.18\.0 available/);
  });

  it('--yes → notice only, does not silently auto-upgrade', async () => {
    const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
    const deps = baseDeps({
      runner,
      fetchImpl: fetchReturning('0.18.0'),
      assumeYes: true,
    });
    await runUpdateCheck(deps);
    expect(runner.called('npm install -g')).toBe(false);
    expect(out).toMatch(/available/);
  });

  it('already up to date → no notice, no prompt', async () => {
    const confirm = vi.fn(async () => true);
    const deps = baseDeps({
      currentVersion: '0.18.0',
      fetchImpl: fetchReturning('0.18.0'),
      prompter: { interactive: true, confirm } as any,
    });
    await runUpdateCheck(deps);
    expect(confirm).not.toHaveBeenCalled();
    expect(out).toBe('');
  });

  it('non-global install (git checkout) → no auto-upgrade, explains what it found', async () => {
    const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
    const deps = baseDeps({
      runner,
      isCompiled: false, // running from src via tsx = dev checkout
      fetchImpl: fetchReturning('0.18.0'),
    });
    await runUpdateCheck(deps);
    expect(runner.called('npm install -g')).toBe(false);
    expect(out).toMatch(/source checkout/);
  });

  it('non-global install (npx) → no auto-upgrade', async () => {
    const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });
    const deps = baseDeps({
      runner,
      packageRoot: '/home/u/.npm/_npx/abc123/node_modules/envbeam',
      fetchImpl: fetchReturning('0.18.0'),
    });
    await runUpdateCheck(deps);
    expect(runner.called('npm install -g')).toBe(false);
    expect(out).toMatch(/npx/);
  });
});

describe('detectInstallMethod', () => {
  const runner = new FakeRunner({ available: ['npm'] }).on('npm root -g', { stdout: GLOBAL_ROOT });

  it('flags a tsx/source run as a git checkout', async () => {
    const m = await detectInstallMethod({ packageRoot: GLOBAL_PKG_ROOT, isCompiled: false, runner });
    expect(m.kind).toBe('git-checkout');
  });

  it('flags a package under npm root -g as a global install', async () => {
    const m = await detectInstallMethod({ packageRoot: GLOBAL_PKG_ROOT, isCompiled: true, runner });
    expect(m.kind).toBe('global-npm');
  });

  it('flags an _npx path as npx', async () => {
    const m = await detectInstallMethod({
      packageRoot: '/home/u/.npm/_npx/abc/node_modules/envbeam',
      isCompiled: true,
      runner,
    });
    expect(m.kind).toBe('npx');
  });

  it('flags a project-local node_modules as local', async () => {
    const m = await detectInstallMethod({
      packageRoot: '/work/proj/node_modules/envbeam',
      isCompiled: true,
      runner,
    });
    expect(m.kind).toBe('local');
  });
});
