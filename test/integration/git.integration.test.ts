import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RealCommandRunner } from '../../src/core/util/exec.js';
import { buildRunContext } from '../../src/core/pipeline/context.js';
import { runResume } from '../../src/core/pipeline/resume.js';
import { runPause } from '../../src/core/pipeline/pause.js';
import { runStatus } from '../../src/core/pipeline/status.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import { Logger } from '../../src/core/util/logger.js';
import { tmpDir } from '../helpers/context.js';

const runner = new RealCommandRunner();
let hasGit = false;

beforeAll(async () => {
  hasGit = (await runner.which('git')) != null;
  process.env.ENVBEAM_CREDENTIAL_STORE = 'file';
});
afterAll(() => {
  delete process.env.ENVBEAM_CREDENTIAL_STORE;
  delete process.env.ENVBEAM_HOME;
});

const CONFIG = 'version: 1\nworkspace: keeper\ngit:\n  branch: current\ncontainer:\n  mode: none\nsession:\n  provider: none\n';

async function git(cwd: string, ...args: string[]): Promise<void> {
  const res = await runner.run('git', args, { cwd, allowFailure: true });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function silentCtxOpts(cwd: string) {
  return {
    cwd,
    runner,
    prompter: new AutoPrompter({ defaults: true }),
    logger: new Logger({ level: 'error', write: () => undefined }),
  };
}

describe('git round-trip (real git)', () => {
  it('pause in clone A pushes; resume in clone B pulls the work', async () => {
    if (!hasGit) return;
    const { dir, cleanup } = await tmpDir('envbeam-git-int-');
    try {
      const home = path.join(dir, 'home');
      await fs.mkdir(home, { recursive: true });
      process.env.ENVBEAM_HOME = home;

      const bare = path.join(dir, 'remote.git');
      const cloneA = path.join(dir, 'A');
      const cloneB = path.join(dir, 'B');

      await git(dir, 'init', '--bare', '-b', 'main', bare);

      // clone A, seed it, push initial
      await git(dir, 'clone', bare, cloneA);
      await git(cloneA, 'config', 'user.email', '****');
      await git(cloneA, 'config', 'user.name', 't');
      await fs.writeFile(path.join(cloneA, 'README.md'), '# keeper\n');
      await fs.writeFile(path.join(cloneA, '.envbeam.yaml'), CONFIG);
      await git(cloneA, 'add', '-A');
      await git(cloneA, 'commit', '-m', 'initial');
      await git(cloneA, 'push', '-u', 'origin', 'main');

      // clone B from the seeded remote
      await git(dir, 'clone', bare, cloneB);
      await git(cloneB, 'config', 'user.email', '****');
      await git(cloneB, 'config', 'user.name', 't');

      // In A: new work, pause with --commit (commits + pushes)
      await fs.writeFile(path.join(cloneA, 'feature.ts'), 'export const x = 1;\n');
      const ctxA = await buildRunContext(silentCtxOpts(cloneA));
      const pauseReport = await runPause(ctxA, { force: false, workMode: 'commit', message: 'add feature' });
      expect(pauseReport.git?.committed).toBe(true);
      expect(pauseReport.git?.pushed).toBe(true);

      // In B: resume fast-forwards to A's pushed commit
      const ctxB = await buildRunContext(silentCtxOpts(cloneB));
      const resumeReport = await runResume(ctxB);
      expect(resumeReport.git?.action).toBe('fast-forwarded');
      expect(await fs.readFile(path.join(cloneB, 'feature.ts'), 'utf8')).toContain('export const x = 1;');

      // status in B is now clean + in sync
      const status = await runStatus(ctxB);
      expect(status.git?.dirtyFiles).toHaveLength(0);
      expect(status.git?.behind).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('pause refuses to lose uncommitted work without --force', async () => {
    if (!hasGit) return;
    const { dir, cleanup } = await tmpDir('envbeam-git-int2-');
    try {
      const home = path.join(dir, 'home');
      await fs.mkdir(home, { recursive: true });
      process.env.ENVBEAM_HOME = home;
      const bare = path.join(dir, 'remote.git');
      const clone = path.join(dir, 'A');
      await git(dir, 'init', '--bare', '-b', 'main', bare);
      await git(dir, 'clone', bare, clone);
      await git(clone, 'config', 'user.email', '****');
      await git(clone, 'config', 'user.name', 't');
      await fs.writeFile(path.join(clone, '.envbeam.yaml'), CONFIG);
      await fs.writeFile(path.join(clone, 'a.txt'), '1');
      await git(clone, 'add', '-A');
      await git(clone, 'commit', '-m', 'init');
      await git(clone, 'push', '-u', 'origin', 'main');

      // dirty change, pause with workMode none → must refuse
      await fs.writeFile(path.join(clone, 'a.txt'), '2');
      const ctx = await buildRunContext(silentCtxOpts(clone));
      await expect(runPause(ctx, { force: false, workMode: 'none' })).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
