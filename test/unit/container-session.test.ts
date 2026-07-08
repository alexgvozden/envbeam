import { describe, it, expect, afterEach } from 'vitest';
import { ComposeContainerProvider, parseComposePs } from '../../src/core/providers/container/compose.js';
import { DevcontainerProvider } from '../../src/core/providers/container/devcontainer.js';
import { ClaudeSyncProvider } from '../../src/core/providers/session/claudeSync.js';
import { RemoteControlProvider } from '../../src/core/providers/session/remoteControl.js';
import { NoneSessionProvider } from '../../src/core/providers/session/none.js';
import { ensureDockerRunning } from '../../src/core/util/docker.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('ensureDockerRunning (self-heal)', () => {
  const ctxWith = (runner: FakeRunner) =>
    makeTestContext({ config: { version: 1, workspace: 'w' }, runner }).providerCtx('container');

  it('returns true immediately when the daemon is already up', async () => {
    const runner = new FakeRunner();
    runner.on('docker info', { stdout: '25.0' });
    expect(await ensureDockerRunning(ctxWith(runner))).toBe(true);
    expect(runner.calls.some((c) => ['open', 'sh', 'cmd'].includes(c.command))).toBe(false);
  });

  it('starts Docker and waits until the daemon becomes ready', async () => {
    const runner = new FakeRunner();
    let up = false;
    runner.on('docker info', () => (up ? { stdout: '25.0' } : { code: 1, stderr: 'Cannot connect' }));
    const markUp = () => {
      up = true; // the launch command brings the daemon up
      return {};
    };
    runner.on('open', markUp);
    runner.on('sh', markUp);
    runner.on('cmd', markUp);
    expect(await ensureDockerRunning(ctxWith(runner), 10_000)).toBe(true);
    expect(runner.calls.some((c) => ['open', 'sh', 'cmd'].includes(c.command))).toBe(true);
  });

  it('returns false if the daemon never comes up (bounded wait)', async () => {
    const runner = new FakeRunner();
    runner.on('docker info', { code: 1, stderr: 'Cannot connect' });
    runner.on('open', {});
    runner.on('sh', {});
    runner.on('cmd', {});
    expect(await ensureDockerRunning(ctxWith(runner), 100)).toBe(false);
  });
});

describe('compose container provider', () => {
  it('brings the stack up with docker compose', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, { 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n' });
    const runner = new FakeRunner({ available: ['docker'] });
    runner.on('docker compose', (c, args) =>
      args.includes('ps') ? { stdout: JSON.stringify([{ Name: 'db', State: 'running' }]) } : {},
    );
    const provider = new ComposeContainerProvider();
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', container: { mode: 'compose' } }, runner, workspaceRoot: dir }).providerCtx('container');
    const status = await provider.up(ctx);
    expect(status.running).toBe(true);
    expect(runner.called('docker compose')).toBe(true);
    const upCall = runner.callsTo('docker').find((c) => c.args.includes('up'))!;
    expect(upCall.args).toContain('-d');
  });

  it('stops on down (preserving volumes)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, { 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n' });
    const runner = new FakeRunner({ available: ['docker'] });
    const provider = new ComposeContainerProvider();
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', container: { mode: 'compose' } }, runner, workspaceRoot: dir }).providerCtx('container');
    await provider.down(ctx);
    expect(runner.calls.some((c) => c.args.includes('stop'))).toBe(true);
  });

  it('parses both JSON-array and NDJSON ps output', () => {
    expect(parseComposePs('[{"Name":"a","State":"running"}]')).toEqual([{ name: 'a', state: 'running' }]);
    expect(parseComposePs('{"Name":"a","State":"running"}\n{"Name":"b","State":"exited"}')).toEqual([
      { name: 'a', state: 'running' },
      { name: 'b', state: 'exited' },
    ]);
    expect(parseComposePs('')).toEqual([]);
  });
});

describe('devcontainer provider', () => {
  it('runs devcontainer up and inspects via docker labels', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['devcontainer', 'docker'] });
    runner.on('devcontainer up', { stdout: '{"outcome":"success"}' });
    runner.on('docker ps', { stdout: 'abc123def456\n' });
    const provider = new DevcontainerProvider();
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', container: { mode: 'devcontainer' } }, runner, workspaceRoot: dir }).providerCtx('container');
    const status = await provider.up(ctx);
    expect(status.running).toBe(true);
    const upCall = runner.callsTo('devcontainer')[0]!;
    expect(upCall.args).toEqual(['up', '--workspace-folder', dir]);
  });

  it('reports not-running when no labelled container exists', async () => {
    const runner = new FakeRunner({ available: ['devcontainer', 'docker'] });
    runner.on('docker ps', { stdout: '' });
    const provider = new DevcontainerProvider();
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', container: { mode: 'devcontainer' } }, runner }).providerCtx('container');
    const status = await provider.status(ctx);
    expect(status.running).toBe(false);
  });
});

describe('session providers', () => {
  it('claude-sync pushes/pulls with workspace + scope args', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['claude-sync'] });
    const provider = new ClaudeSyncProvider();
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w', session: { provider: 'claude-sync', scope: 'project' } }, runner, workspaceRoot: dir }).providerCtx('session');
    const pull = await provider.pull(ctx);
    expect(pull.action).toBe('pulled');
    const push = await provider.push(ctx);
    expect(push.action).toBe('pushed');
    const pullCall = runner.callsTo('claude-sync')[0]!;
    expect(pullCall.args).toEqual(['pull', '--path', dir, '--scope', 'project']);
  });

  it('claude-sync reports failures as noop', async () => {
    const runner = new FakeRunner({ available: ['claude-sync'] });
    runner.on('claude-sync pull', { code: 1, stderr: 'boom' });
    const provider = new ClaudeSyncProvider();
    const ctx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner }).providerCtx('session');
    const pull = await provider.pull(ctx);
    expect(pull.action).toBe('noop');
    expect(pull.detail).toMatch(/boom/);
  });

  it('remote-control documents (no file sync) and none is a no-op', async () => {
    const runner = new FakeRunner();
    const rcCtx = makeTestContext({ config: { version: 1, workspace: 'w' }, runner }).providerCtx('session');
    expect((await new RemoteControlProvider().pull(rcCtx)).action).toBe('documented');
    expect((await new NoneSessionProvider().pull(rcCtx)).action).toBe('noop');
  });
});
