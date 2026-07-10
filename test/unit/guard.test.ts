import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs, writeFileSync } from 'node:fs';
import { assertCanPull, assertCanPush, syncStatus } from '../../src/core/pipeline/guard.js';
import { resolveActiveProviders } from '../../src/core/pipeline/providers.js';
import { patchState } from '../../src/core/state.js';
import { SafetyError } from '../../src/core/util/errors.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import type { RunContext } from '../../src/core/pipeline/context.js';

const cleanups: Array<() => Promise<void>> = [];
let home: string;

beforeEach(async () => {
  const t = await tmpDir('envbeam-home-guard-');
  home = t.dir;
  process.env.ENVBEAM_HOME = home;
  process.env.ENVBEAM_MACHINE = 'guardbox';
  process.env.ENVBEAM_S3_ACCESS_KEY = 'ak';
  process.env.ENVBEAM_S3_SECRET_KEY = 'sk';
  cleanups.push(t.cleanup);
  // A configured global storage, so the guard actually consults a registry.
  await fs.writeFile(
    path.join(home, 'config.yaml'),
    'identities: {}\nstorage:\n  type: s3\n  bucket: bkt\n  credentialSource: env\n',
  );
});
afterEach(async () => {
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_MACHINE;
  delete process.env.ENVBEAM_S3_ACCESS_KEY;
  delete process.env.ENVBEAM_S3_SECRET_KEY;
  delete process.env.ENVBEAM_DISABLE_STORAGE;
  while (cleanups.length) await cleanups.pop()!();
});

const config = {
  version: 1,
  workspace: 'keeper',
  secrets: { provider: 'doppler' },
  database: { provider: 'postgres', mode: 'snapshot', migrateCommand: 'm', sync: { target: 'local-folder', path: '/tmp/x' } },
  session: { provider: 'none' },
};

/** A runner whose registry holds `keeper` at `remoteRevision` (0 = absent). */
function runnerWith(opts: {
  remoteRevision: number;
  /** Tracked modifications (` M path`). */
  dirty?: string[];
  /** Untracked files (`?? path`). */
  untracked?: string[];
  ahead?: number;
  dbRows?: string;
}): FakeRunner {
  const r = new FakeRunner({ available: ['git', 'aws', 'psql', 'pg_dump'] });
  r.on((_c, a) => a[0] === '--version', { stdout: 'v1' });
  r.on('git', {});
  r.on('git branch --show-current', { stdout: 'main\n' });
  r.on('git status --porcelain', {
    stdout: [...(opts.dirty ?? []).map((f) => ` M ${f}`), ...(opts.untracked ?? []).map((f) => `?? ${f}`)].join('\n'),
  });
  r.on('git rev-parse --abbrev-ref', { stdout: 'origin/main' });
  r.on('git rev-parse HEAD', { stdout: 'b'.repeat(40) });
  r.on('git rev-list', { stdout: `0\t${opts.ahead ?? 0}` });
  r.on('git remote get-url', { stdout: 'git@github.com:acme/keeper.git' });
  r.on('psql', (_c, a) => (a.includes('SELECT 1') ? { stdout: '1' } : { stdout: opts.dbRows ?? '0' }));

  const projects =
    opts.remoteRevision > 0
      ? {
          keeper: {
            name: 'keeper',
            gitRemote: 'git@github.com:acme/keeper.git',
            gitBranch: 'main',
            configSnapshot: 'version: 1\n',
            lastPush: '2026-07-10T00:00:00Z',
            machineId: 'other-machine',
            revision: opts.remoteRevision,
          },
        }
      : {};
  r.on(
    (c, a) => c === 'aws' && a[1] === 'get-object',
    (_c, a) => {
      writeFileSync(a[a.indexOf('--key') + 2]!, JSON.stringify({ version: 1, projects }));
      return { stdout: '{"ETag":"\\"e1\\""}' };
    },
  );
  return r;
}

async function ctxOn(
  runner: FakeRunner,
  opts: { force?: boolean; dryRun?: boolean; prompter?: AutoPrompter; lines?: string[] } = {},
): Promise<{ ctx: RunContext; root: string }> {
  const { dir, cleanup } = await tmpDir();
  cleanups.push(cleanup);
  const ctx = makeTestContext({
    config,
    runner,
    workspaceRoot: dir,
    force: opts.force,
    dryRun: opts.dryRun,
    prompter: opts.prompter,
    logLines: opts.lines,
  });
  return { ctx, root: dir };
}

const active = (ctx: RunContext) => resolveActiveProviders(ctx);

// SYNC_SAFETY.md §10.3 — the three outcomes, and the whole UX.
describe('syncStatus verdict', () => {
  it('first-sync when the registry has no entry for this project', async () => {
    const { ctx } = await ctxOn(runnerWith({ remoteRevision: 0 }));
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('first-sync');
  });

  it('in-sync when the remote is where we left it and nothing moved locally', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 3 }));
    await patchState(root, { baseRevision: 3 });
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('in-sync');
  });

  it('ahead when only the local side moved', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 3, dirty: ['src/a.ts'] }));
    await patchState(root, { baseRevision: 3 });
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('ahead');
    expect(s.localChanges).toEqual(['1 uncommitted change(s) to tracked files']);
  });

  it('does not treat an untracked scratch file as divergence', async () => {
    // A stray .env.local must not turn a routine pull into a refusal: it belongs
    // to no synced domain, so it cannot have diverged from anything.
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5, untracked: ['.env.local'] }));
    await patchState(root, { baseRevision: 3 });
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('behind');
    expect(s.localChanges).toEqual([]);
    expect(s.untracked).toEqual(['.env.local']);
  });

  it('still counts tracked edits alongside untracked files', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5, dirty: ['src/a.ts'], untracked: ['scratch.txt'] }));
    await patchState(root, { baseRevision: 3 });
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('diverged');
    expect(s.localChanges).toEqual(['1 uncommitted change(s) to tracked files']);
  });

  it('behind when only the remote moved', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5 }));
    await patchState(root, { baseRevision: 3 });
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('behind');
  });

  it('diverged when both moved', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5, ahead: 2 }));
    await patchState(root, { baseRevision: 3 });
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('diverged');
    expect(s.localChanges).toEqual(['2 unpushed commit(s) on main']);
  });

  it('a machine that never synced is behind a populated registry, not in-sync', async () => {
    const { ctx } = await ctxOn(runnerWith({ remoteRevision: 4 })); // no baseRevision at all
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.baseRevision).toBe(0);
    expect(s.verdict).toBe('behind');
  });

  it('counts a locally-edited .env as a local change', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 3 }));
    await patchState(root, { baseRevision: 3, dotenvHash: 'not-the-hash-of-whats-there' });
    await fs.writeFile(path.join(root, '.env'), 'API_KEY="edited"\n');
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.verdict).toBe('ahead');
    expect(s.localChanges).toContain('local edits to the materialized .env');
  });

  it('reports unavailable rather than guessing when storage is off', async () => {
    process.env.ENVBEAM_DISABLE_STORAGE = '1';
    const { ctx } = await ctxOn(runnerWith({ remoteRevision: 9 }));
    const s = await syncStatus(ctx, active(ctx), { probeDatabase: false });
    expect(s.unavailable).toBe('storage disabled');
    expect(s.verdict).toBe('first-sync');
  });
});

// D2 — the stale machine must not publish its week-old snapshot.
describe('assertCanPush', () => {
  it('refuses when this machine is behind, even with no local changes', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5 }));
    await patchState(root, { baseRevision: 3 });
    const err = await assertCanPush(ctx, active(ctx), false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafetyError);
    expect((err as Error).message).toMatch(/is behind the remote \(base r3, remote r5\)/);
    expect((err as Error).message).toMatch(/older than what is already published/);
  });

  it('refuses when diverged', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5, dirty: ['a'] }));
    await patchState(root, { baseRevision: 3 });
    await expect(assertCanPush(ctx, active(ctx), false)).rejects.toThrow(/has diverged from the remote/);
  });

  it('proceeds when ahead, in-sync, or first-sync', async () => {
    for (const [remote, base] of [
      [3, 3],
      [0, 0],
    ] as const) {
      const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: remote, dirty: ['a'] }));
      await patchState(root, { baseRevision: base });
      await expect(assertCanPush(ctx, active(ctx), false)).resolves.toBeTruthy();
    }
  });

  it('--overwrite-remote proceeds and says what it overrode', async () => {
    const lines: string[] = [];
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5 }), { lines });
    await patchState(root, { baseRevision: 3 });
    const s = await assertCanPush(ctx, active(ctx), true);
    expect(s.verdict).toBe('behind');
    expect(lines.join('\n')).toMatch(/--overwrite-remote: pushing over remote revision 5/);
  });

  it('under --dry-run it prints the verdict instead of throwing', async () => {
    const lines: string[] = [];
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5 }), { dryRun: true, lines });
    await patchState(root, { baseRevision: 3 });
    await expect(assertCanPush(ctx, active(ctx), false)).resolves.toBeTruthy();
    expect(lines.join('\n')).toMatch(/a real push would be refused here/);
  });
});

describe('assertCanPull', () => {
  it('fast-forwards without complaint when merely behind', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5 }));
    await patchState(root, { baseRevision: 3 });
    await expect(assertCanPull(ctx, active(ctx), false)).resolves.toMatchObject({ verdict: 'behind' });
  });

  it('says there is nothing to pull when this machine is ahead', async () => {
    const lines: string[] = [];
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 3, ahead: 1 }), { lines });
    await patchState(root, { baseRevision: 3 });
    await expect(assertCanPull(ctx, active(ctx), false)).resolves.toMatchObject({ verdict: 'ahead' });
    expect(lines.join('\n')).toMatch(/nothing to pull — this machine holds work the remote has not seen/);
  });

  it('refuses a diverged pull non-interactively rather than discarding local work', async () => {
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5, dirty: ['a'] }), {
      // AutoPrompter is non-interactive, which is what --yes gives us.
      prompter: new AutoPrompter({ defaults: true }),
    });
    await patchState(root, { baseRevision: 3 });
    await expect(assertCanPull(ctx, active(ctx), false)).rejects.toThrow(SafetyError);
  });

  it('--force pulls over local changes and says so', async () => {
    const lines: string[] = [];
    const { ctx, root } = await ctxOn(runnerWith({ remoteRevision: 5, dirty: ['a'] }), { lines });
    await patchState(root, { baseRevision: 3 });
    await expect(assertCanPull(ctx, active(ctx), true)).resolves.toMatchObject({ verdict: 'diverged' });
    expect(lines.join('\n')).toMatch(/--force: pulling over local changes/);
  });
});

// SYNC_SAFETY.md §9 / §10.4 — pull must not restore a checkpoint's data into a
// checkout that does not contain the commit that data was captured against.
describe('checkpoint coherence on pull', () => {
  const HEAD = 'b'.repeat(40);
  const OTHER = 'c'.repeat(40);

  /** A registry whose `keeper` entry carries a checkpoint. */
  function runnerWithCheckpoint(opts: {
    gitCommit: string;
    snapshotName?: string;
    /** commits `git cat-file -e` should accept. */
    known?: string[];
    /** ancestors of HEAD, per `git merge-base --is-ancestor`. */
    ancestors?: string[];
  }): FakeRunner {
    const r = runnerWith({ remoteRevision: 5 });
    const known = new Set(opts.known ?? [opts.gitCommit, HEAD]);
    const ancestors = new Set(opts.ancestors ?? [opts.gitCommit, HEAD]);
    r.on('git cat-file', (_c, a) => ({ code: known.has((a[2] ?? '').replace('^{commit}', '')) ? 0 : 1 }));
    r.on('git merge-base', (_c, a) => ({ code: ancestors.has(a[2] ?? '') ? 0 : 1 }));

    // Re-stub get-object with a checkpoint-bearing entry.
    r.on(
      (c, a) => c === 'aws' && a[1] === 'get-object',
      (_c, a) => {
        const projects = {
          keeper: {
            name: 'keeper',
            gitRemote: 'git@github.com:acme/keeper.git',
            gitBranch: 'main',
            configSnapshot: 'version: 1\n',
            lastPush: '2026-07-10T00:00:00Z',
            machineId: 'other-machine',
            revision: 5,
            checkpoint: {
              revision: 5,
              gitCommit: opts.gitCommit,
              gitBranch: 'main',
              snapshotName: opts.snapshotName,
              machineId: 'other-machine',
              at: '2026-07-10T00:00:00Z',
            },
          },
        };
        writeFileSync(a[a.indexOf('--key') + 2]!, JSON.stringify({ version: 1, projects }));
        return { stdout: '{"ETag":"\\"e1\\""}' };
      },
    );
    return r;
  }

  it('carries the checkpoint through when it is an ancestor of HEAD', async () => {
    const { ctx, root } = await ctxOn(runnerWithCheckpoint({ gitCommit: OTHER, ancestors: [OTHER] }));
    await patchState(root, { baseRevision: 3 });
    const s = await assertCanPull(ctx, active(ctx), false);
    expect(s.checkpoint?.gitCommit).toBe(OTHER);
  });

  it('surfaces the checkpoint even when the commit is unknown — resume decides', async () => {
    const { ctx, root } = await ctxOn(runnerWithCheckpoint({ gitCommit: OTHER, known: [HEAD] }));
    await patchState(root, { baseRevision: 3 });
    const s = await assertCanPull(ctx, active(ctx), false);
    expect(s.checkpoint?.gitCommit).toBe(OTHER);
    expect(s.verdict).toBe('behind');
  });

  it('names the snapshot the checkpoint allows', async () => {
    const { ctx, root } = await ctxOn(
      runnerWithCheckpoint({ gitCommit: OTHER, snapshotName: 'keeper__20260701T120000Z__other.sql', ancestors: [OTHER] }),
    );
    await patchState(root, { baseRevision: 3 });
    const s = await assertCanPull(ctx, active(ctx), false);
    expect(s.checkpoint?.snapshotName).toBe('keeper__20260701T120000Z__other.sql');
  });
});
