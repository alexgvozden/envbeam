import { describe, it, expect } from 'vitest';
import { inspectLocalGit, hasUnsyncedWork, sameRemote } from '../../src/core/util/gitSync.js';
import { FakeRunner } from '../helpers/fakeRunner.js';

/** A runner that looks like a clean repo tracking origin/main, with overrides. */
function repoRunner(over: { counts?: string; log?: string; porcelain?: string; upstream?: number } = {}) {
  return new FakeRunner()
    .on('git rev-parse --is-inside-work-tree', { stdout: 'true\n' })
    .on('git branch --show-current', { stdout: 'main\n' })
    .on('git rev-parse --abbrev-ref --symbolic-full-name', {
      code: over.upstream ?? 0,
      stdout: over.upstream ? '' : 'origin/main\n',
    })
    .on('git rev-list --left-right --count', { stdout: over.counts ?? '0\t0\n' })
    .on('git log --oneline', { stdout: over.log ?? '' })
    .on('git status --porcelain', { stdout: over.porcelain ?? '' })
    .on('git remote get-url', { stdout: 'git@github.com:acme/synthetic-signals.git\n' });
}

describe('inspectLocalGit', () => {
  it('reports a clean, in-sync checkout', async () => {
    const s = await inspectLocalGit(repoRunner(), '/repo');
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.hasUpstream).toBe(true);
    expect({ ahead: s.ahead, behind: s.behind }).toEqual({ ahead: 0, behind: 0 });
    expect(hasUnsyncedWork(s)).toBe(false);
  });

  it('parses left-right counts as behind-then-ahead and lists ahead commits', async () => {
    const runner = repoRunner({ counts: '1\t3\n', log: 'aaa1 third\nbbb2 second\nccc3 first\n' });
    const s = await inspectLocalGit(runner, '/repo');
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(3);
    expect(s.aheadCommits).toEqual(['aaa1 third', 'bbb2 second', 'ccc3 first']);
    expect(hasUnsyncedWork(s)).toBe(true);
  });

  it('treats a dirty tree as unsynced work even when in sync with upstream', async () => {
    const s = await inspectLocalGit(repoRunner({ porcelain: ' M src/a.ts\n?? new.ts\n' }), '/repo');
    expect(s.ahead).toBe(0);
    expect(s.dirtyFiles).toEqual(['src/a.ts', 'new.ts']);
    expect(hasUnsyncedWork(s)).toBe(true);
  });

  it('skips ahead-commit logging when there is no upstream', async () => {
    const runner = repoRunner({ upstream: 128 });
    const s = await inspectLocalGit(runner, '/repo');
    expect(s.hasUpstream).toBe(false);
    expect(s.ahead).toBe(0);
    expect(runner.called('git rev-list')).toBe(false);
  });

  it('fetches before counting so the comparison is against fresh refs', async () => {
    const runner = repoRunner();
    await inspectLocalGit(runner, '/repo', 'upstream');
    const fetch = runner.callsTo('git').find((c) => c.args[0] === 'fetch');
    expect(fetch?.args).toEqual(['fetch', 'upstream', '--prune']);
    expect(fetch?.options.cwd).toBe('/repo');
  });

  it('returns a non-repo marker instead of throwing outside a work tree', async () => {
    const runner = new FakeRunner().on('git rev-parse --is-inside-work-tree', { code: 128, stderr: 'not a git repository' });
    const s = await inspectLocalGit(runner, '/tmp/plain');
    expect(s.isRepo).toBe(false);
    expect(hasUnsyncedWork(s)).toBe(false);
  });
});

describe('sameRemote', () => {
  it('matches the same repo across url shapes', () => {
    const forms = [
      'git@github.com:acme/repo.git',
      'ssh://git@github.com/acme/repo.git',
      'https://github.com/acme/repo',
      'https://github.com/acme/repo.git/',
      'GIT@GitHub.com:acme/Repo.git',
    ];
    for (const f of forms) expect(sameRemote(f, 'git@github.com:acme/repo.git')).toBe(true);
  });

  it('does not match different repos or hosts', () => {
    expect(sameRemote('git@github.com:acme/repo.git', 'git@github.com:acme/other.git')).toBe(false);
    expect(sameRemote('git@gitlab.com:acme/repo.git', 'git@github.com:acme/repo.git')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(sameRemote(undefined, 'git@github.com:acme/repo.git')).toBe(false);
    expect(sameRemote('git@github.com:acme/repo.git', '')).toBe(false);
  });
});
