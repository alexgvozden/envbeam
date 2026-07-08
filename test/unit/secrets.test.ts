import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DopplerSecretsProvider } from '../../src/core/providers/secrets/doppler.js';
import { OnePasswordSecretsProvider } from '../../src/core/providers/secrets/onepassword.js';
import { renderDotenv, dotenvEscape, parseDotenv } from '../../src/core/providers/secrets/materialize.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function ctxFor(config: unknown, runner: FakeRunner, root: string, env: Record<string, string> = {}) {
  return makeTestContext({ config, runner, workspaceRoot: root, env }).providerCtx('secrets');
}

const baseConfig = (secrets: object) => ({ version: 1, workspace: 'keeper', secrets });

describe('dotenv materialize', () => {
  it('escapes special characters round-trip', () => {
    const value = 'a"b\\c$d`e\nf';
    const rendered = renderDotenv({ K: value });
    const parsed = parseDotenv(rendered);
    expect(parsed.K).toBe(value);
  });

  it('quotes and parses normal values', () => {
    expect(dotenvEscape('plain')).toBe('plain');
    expect(parseDotenv('export FOO=bar\nBAZ="qux"\n# c\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});

describe('doppler provider', () => {
  it('pulls secrets via the CLI, strips DOPPLER_ vars, materializes a gitignored .env', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler secrets download', {
      stdout: JSON.stringify({ API_KEY: 'sk_live_1', DB_URL: 'postgres://x', DOPPLER_PROJECT: 'keeper' }),
    });
    const provider = new DopplerSecretsProvider();
    const ctx = ctxFor(baseConfig({ provider: 'doppler', project: 'keeper', config: 'dev' }), runner, dir);

    const pulled = await provider.pull(ctx);
    expect(pulled.count).toBe(2);
    expect(pulled.keys.sort()).toEqual(['API_KEY', 'DB_URL']);
    expect(pulled.values.DOPPLER_PROJECT).toBeUndefined();

    // CLI invoked with project/config
    const call = runner.callsTo('doppler')[0]!;
    expect(call.args).toContain('--project');
    expect(call.args).toContain('keeper');

    const mat = await provider.materialize(ctx, pulled);
    expect(mat.path).toBe('.env');
    const envText = await fs.readFile(path.join(dir, '.env'), 'utf8');
    expect(envText).toMatch(/API_KEY="sk_live_1"/);
    const gitignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env');
  });

  it('passes a token identity as DOPPLER_TOKEN env', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler secrets download', { stdout: '{"A":"1"}' });
    const provider = new DopplerSecretsProvider();
    const base = makeTestContext({
      config: baseConfig({ provider: 'doppler' }),
      runner,
      workspaceRoot: dir,
      identities: { secrets: { name: 'doppler:keeper', type: 'doppler', token: 'tok123', env: {} } },
    });
    await provider.pull(base.providerCtx('secrets'));
    expect(runner.callsTo('doppler')[0]!.options.env?.DOPPLER_TOKEN).toBe('tok123');
  });

  it('throws a helpful error when the CLI fails', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler secrets download', { code: 1, stderr: 'unauthorized' });
    const provider = new DopplerSecretsProvider();
    await expect(provider.pull(ctxFor(baseConfig({ provider: 'doppler' }), runner, dir))).rejects.toThrow(/doppler secrets download failed/);
  });

  it('strips ENVBEAM_ bookkeeping vars from pulled secrets', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler secrets download', {
      stdout: JSON.stringify({ API_KEY: 'k', ENVBEAM_GIT_REMOTE: 'git@x:y.git', ENVBEAM_GIT_BRANCH: 'wave-1' }),
    });
    const provider = new DopplerSecretsProvider();
    const pulled = await provider.pull(ctxFor(baseConfig({ provider: 'doppler', project: 'keeper', config: 'dev' }), runner, dir));
    expect(pulled.keys).toEqual(['API_KEY']);
    expect(pulled.values.ENVBEAM_GIT_REMOTE).toBeUndefined();
  });

  it('recordMeta sets ENVBEAM_ git coordinates via `doppler secrets set`', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['doppler'] });
    const provider = new DopplerSecretsProvider();
    const res = await provider.recordMeta(
      ctxFor(baseConfig({ provider: 'doppler', project: 'keeper', config: 'dev' }), runner, dir),
      { ENVBEAM_GIT_REMOTE: 'git@github.com:me/keeper.git', ENVBEAM_GIT_BRANCH: 'wave-1', ENVBEAM_GIT_EMPTY: '' },
    );
    expect(res.ok).toBe(true);
    const set = runner.callsTo('doppler').find((c) => c.args[0] === 'secrets' && c.args[1] === 'set')!;
    expect(set.args).toContain('ENVBEAM_GIT_REMOTE=git@github.com:me/keeper.git');
    expect(set.args).toContain('ENVBEAM_GIT_BRANCH=wave-1');
    // empty values are dropped, and project/config are targeted
    expect(set.args.some((a) => a.startsWith('ENVBEAM_GIT_EMPTY'))).toBe(false);
    expect(set.args).toContain('--project');
    expect(set.args).toContain('keeper');
  });
});

describe('onepassword provider', () => {
  it('pulls env-var fields from an item, ignoring structural fields', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['op'] });
    runner.on('op item get', {
      stdout: JSON.stringify({
        fields: [
          { label: 'username', value: 'admin', purpose: 'USERNAME' },
          { label: 'API_KEY', value: 'sk_1' },
          { label: 'DB_URL', value: 'postgres://x' },
          { label: 'not a key', value: 'ignored' },
          { label: 'notesPlain', value: '', purpose: 'NOTES' },
        ],
      }),
    });
    const provider = new OnePasswordSecretsProvider();
    const ctx = ctxFor(baseConfig({ provider: 'onepassword', vault: 'Private', item: 'keeper-env' }), runner, dir);
    const pulled = await provider.pull(ctx);
    expect(pulled.keys.sort()).toEqual(['API_KEY', 'DB_URL']);
    const call = runner.callsTo('op')[0]!;
    expect(call.args).toEqual(['item', 'get', 'keeper-env', '--format', 'json', '--vault', 'Private']);
  });

  it('errors when secrets.item is missing', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['op'] });
    const provider = new OnePasswordSecretsProvider();
    await expect(provider.pull(ctxFor(baseConfig({ provider: 'onepassword' }), runner, dir))).rejects.toThrow(/requires `secrets.item`/);
  });
});
