import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { detectRuntimeTargets } from '../../src/core/detect/runtime.js';
import { installRuntimeDeps } from '../../src/core/pipeline/deps.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(files: Record<string, string>): Promise<string> {
  const { dir, cleanup } = await tmpDir();
  cleanups.push(cleanup);
  await writeFiles(dir, files);
  return dir;
}

describe('runtime target detection', () => {
  it('finds python (uv) at the root and node in a sub-app; ignores vendor dirs', async () => {
    const dir = await fixture({
      'uv.lock': '',
      'pyproject.toml': '[project]\nname = "x"\n',
      'apps/web/package-lock.json': '{}',
      'node_modules/dep/package-lock.json': '{}', // must be ignored
    });
    const targets = await detectRuntimeTargets(dir);
    expect(targets.map((t) => `${t.manager}:${t.dir}`)).toEqual(['uv:.', `npm:${path.join('apps', 'web')}`]);
  });

  it('prefers pnpm over npm when both lockfiles sit in one dir', async () => {
    const dir = await fixture({ 'pnpm-lock.yaml': '', 'package-lock.json': '{}' });
    const targets = await detectRuntimeTargets(dir);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.manager).toBe('pnpm');
  });

  it('detects go, rust, ruby, php markers', async () => {
    const dir = await fixture({
      'go.mod': 'module x',
      'Cargo.toml': '[package]',
      'Gemfile.lock': '',
      'composer.lock': '{}',
    });
    const managers = (await detectRuntimeTargets(dir)).map((t) => t.manager).sort();
    expect(managers).toEqual(['bundle', 'cargo', 'composer', 'go']);
  });

  it('returns no targets for a project without markers', async () => {
    const dir = await fixture({ 'readme.md': '# x' });
    expect(await detectRuntimeTargets(dir)).toEqual([]);
  });
});

describe('installRuntimeDeps', () => {
  it('installs a missing manager (uv) then syncs, and runs npm in the sub-app', async () => {
    const dir = await fixture({
      'uv.lock': '',
      'apps/web/package-lock.json': '{}',
    });
    const runner = new FakeRunner({ available: ['npm'] }); // uv missing at first
    runner.on('sh', () => {
      runner.available('uv'); // the install command puts uv on PATH
      return {};
    });
    runner.on('uv', {});
    runner.on('npm', {});
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner, workspaceRoot: dir });
    const report = await installRuntimeDeps(ctx);
    expect(report?.synced).toEqual(['uv (root)', `npm (${path.join('apps', 'web')})`]);
    // uv was installed via its install command, then `uv sync` ran at the root
    const sync = runner.calls.find((c) => c.command === 'uv' && c.args[0] === 'sync')!;
    expect(sync.options.cwd).toBe(dir);
    // npm ci (no node_modules yet) ran inside apps/web
    const npm = runner.calls.find((c) => c.command === 'npm' && c.args[0] === 'ci')!;
    expect(npm.options.cwd).toBe(path.join(dir, 'apps', 'web'));
  });

  it('reports failures without throwing (non-fatal)', async () => {
    const dir = await fixture({ 'uv.lock': '' });
    const runner = new FakeRunner({ available: ['uv'] });
    runner.on('uv', { code: 1, stderr: 'error: failed to resolve' });
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner, workspaceRoot: dir });
    const report = await installRuntimeDeps(ctx);
    expect(report?.failed).toEqual(['uv (root)']);
    expect(report?.synced).toEqual([]);
  });

  it('returns null (no step) when the project has no dependency targets', async () => {
    const dir = await fixture({ 'readme.md': '# x' });
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner: new FakeRunner(), workspaceRoot: dir });
    expect(await installRuntimeDeps(ctx)).toBeNull();
  });

  it('dry-run only reports what it would do', async () => {
    const dir = await fixture({ 'uv.lock': '' });
    const runner = new FakeRunner();
    const lines: string[] = [];
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner, workspaceRoot: dir, dryRun: true, logLines: lines });
    await installRuntimeDeps(ctx);
    expect(lines.join('\n')).toMatch(/would run: uv sync/);
    expect(runner.calls.some((c) => c.command === 'uv')).toBe(false);
  });
});
