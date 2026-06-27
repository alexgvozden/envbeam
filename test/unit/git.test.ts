import { describe, it, expect } from 'vitest';
import { GitProviderImpl } from '../../src/core/providers/git/git.js';
import { SafetyError } from '../../src/core/util/errors.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext } from '../helpers/context.js';

function gitCtx(runner: FakeRunner, config: object = {}, dryRun = false) {
  return makeTestContext({ config: { version: 1, workspace: 'w', git: config }, runner, dryRun }).providerCtx('git');
}

function cleanRepoRunner(opts: { ahead?: number; behind?: number; dirty?: string[]; upstream?: boolean } = {}) {
  const { ahead = 0, behind = 0, dirty = [], upstream = true } = opts;
  const runner = new FakeRunner({ available: ['git'] });
  runner.on('git branch --show-current', { stdout: 'main\n' });
  runner.on('git status --porcelain', { stdout: dirty.map((f) => ` M ${f}`).join('\n') });
  runner.on('git rev-parse --abbrev-ref --symbolic-full-name', upstream ? { stdout: 'origin/main' } : { code: 1, stderr: 'no upstream' });
  runner.on('git rev-list', { stdout: `${behind}\t${ahead}` });
  runner.on('git remote get-url', { stdout: 'git@github-work:acme/repo.git' });
  return runner;
}

describe('git provider status', () => {
  it('reports branch, ahead/behind, dirty files, upstream', async () => {
    const runner = cleanRepoRunner({ ahead: 2, behind: 1, dirty: ['a.ts', 'b.ts'] });
    const st = await new GitProviderImpl().status(gitCtx(runner));
    expect(st).toMatchObject({ branch: 'main', ahead: 2, behind: 1, hasUpstream: true });
    expect(st.dirtyFiles).toEqual(['a.ts', 'b.ts']);
    expect(st.remoteUrl).toContain('github-work');
  });

  it('handles a missing upstream', async () => {
    const st = await new GitProviderImpl().status(gitCtx(cleanRepoRunner({ upstream: false })));
    expect(st.hasUpstream).toBe(false);
    expect(st.ahead).toBe(0);
  });
});

describe('git provider pull', () => {
  it('fast-forwards a clean behind tree', async () => {
    const runner = cleanRepoRunner({ behind: 3 });
    runner.on('git merge --ff-only', { stdout: 'Updating' });
    const res = await new GitProviderImpl().pull(gitCtx(runner));
    expect(res.action).toBe('fast-forwarded');
    expect(runner.called('git fetch origin')).toBe(true);
  });

  it('refuses to merge a dirty tree', async () => {
    const res = await new GitProviderImpl().pull(gitCtx(cleanRepoRunner({ behind: 2, dirty: ['x.ts'] })));
    expect(res.action).toBe('skipped-dirty');
  });

  it('reports up-to-date and respects autopull: off', async () => {
    expect((await new GitProviderImpl().pull(gitCtx(cleanRepoRunner({ behind: 0 })))).action).toBe('up-to-date');
    expect((await new GitProviderImpl().pull(gitCtx(cleanRepoRunner(), { autopull: 'off' }))).action).toBe('skipped');
  });
});

describe('git provider pushWork', () => {
  it('commits dirty work then pushes', async () => {
    const runner = cleanRepoRunner({ dirty: ['x.ts'], ahead: 1 });
    const res = await new GitProviderImpl().pushWork(gitCtx(runner), { workMode: 'commit', message: 'wip', force: false });
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(true);
    expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'commit')).toBe(true);
  });

  it('stashes when asked', async () => {
    const runner = cleanRepoRunner({ dirty: ['x.ts'] });
    const res = await new GitProviderImpl().pushWork(gitCtx(runner), { workMode: 'stash', force: false });
    expect(res.stashed).toBe(true);
    expect(runner.calls.some((c) => c.args[0] === 'stash')).toBe(true);
  });

  it('refuses to drop dirty work without force (SafetyError)', async () => {
    const runner = cleanRepoRunner({ dirty: ['x.ts'] });
    await expect(
      new GitProviderImpl().pushWork(gitCtx(runner), { workMode: 'none', force: false }),
    ).rejects.toBeInstanceOf(SafetyError);
  });

  it('proceeds with --force despite dirty work', async () => {
    const runner = cleanRepoRunner({ dirty: ['x.ts'] });
    const res = await new GitProviderImpl().pushWork(gitCtx(runner), { workMode: 'none', force: true });
    expect(res.pushed).toBe(true);
    expect(res.committed).toBe(false);
  });

  it('raises a SafetyError on rejected (non-fast-forward) push', async () => {
    const runner = cleanRepoRunner({ ahead: 1 });
    runner.on('git push', { code: 1, stderr: 'rejected: non-fast-forward' });
    await expect(
      new GitProviderImpl().pushWork(gitCtx(runner), { workMode: 'none', force: false }),
    ).rejects.toThrow(/rejected/);
  });

  it('uses -u to set upstream when none exists', async () => {
    const runner = cleanRepoRunner({ upstream: false });
    await new GitProviderImpl().pushWork(gitCtx(runner), { workMode: 'none', force: false });
    const push = runner.calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toContain('-u');
  });
});
