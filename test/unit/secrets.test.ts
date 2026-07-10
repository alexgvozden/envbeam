import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DopplerSecretsProvider } from '../../src/core/providers/secrets/doppler.js';
import { OnePasswordSecretsProvider } from '../../src/core/providers/secrets/onepassword.js';
import { renderDotenv, dotenvEscape, parseDotenv, hashSecrets, materializeSecrets } from '../../src/core/providers/secrets/materialize.js';
import { loadState } from '../../src/core/state.js';
import { createHash } from 'node:crypto';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import { AutoPrompter, type AutoPrompterOptions } from '../../src/core/util/prompt.js';

/** AutoPrompter that claims to be a TTY, so interactive-only branches run. */
const interactivePrompter = (answers: AutoPrompterOptions['answers']) =>
  new AutoPrompter({ answers, interactive: true });

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

// SYNC_SAFETY.md §6 / Phase 1 — record what the provider held and what we wrote,
// so a later pull can tell a local .env edit apart from an untouched file, and a
// two-way push can do a key-level three-way diff.
describe('secrets base recording', () => {
  it('hashSecrets is order-independent and never stores a plaintext value', () => {
    const a = hashSecrets({ B: 'two', A: 'one' });
    const b = hashSecrets({ A: 'one', B: 'two' });
    expect(a.hash).toBe(b.hash);
    expect(Object.keys(a.keyHashes).sort()).toEqual(['A', 'B']);
    expect(JSON.stringify(a)).not.toContain('one');
    expect(JSON.stringify(a)).not.toContain('two');
  });

  it('changes the set hash when any value changes, and pins it to the key', () => {
    const before = hashSecrets({ A: 'one', B: 'two' });
    const after = hashSecrets({ A: 'one', B: 'CHANGED' });
    expect(after.hash).not.toBe(before.hash);
    expect(after.keyHashes.A).toBe(before.keyHashes.A);
    expect(after.keyHashes.B).not.toBe(before.keyHashes.B);
  });

  it('materialize records secretsBase and the hash of the bytes it wrote', async () => {
    const { dir: home, cleanup: c1 } = await tmpDir('envbeam-home-');
    const { dir: ws, cleanup: c2 } = await tmpDir();
    cleanups.push(c1, c2);
    process.env.ENVBEAM_HOME = home;
    try {
      const ctx = ctxFor(baseConfig({ provider: 'doppler' }), new FakeRunner(), ws);
      await materializeSecrets(ctx, { values: { API_KEY: 'k' }, count: 1, keys: ['API_KEY'] });

      const state = await loadState(ws);
      expect(state.secretsBase?.hash).toBe(hashSecrets({ API_KEY: 'k' }).hash);
      expect(state.secretsBase?.pulledAt).toBeTruthy();

      const written = await fs.readFile(path.join(ws, '.env'), 'utf8');
      expect(state.dotenvHash).toBe(createHash('sha256').update(written).digest('hex'));
    } finally {
      delete process.env.ENVBEAM_HOME;
    }
  });

  it('records nothing under --dry-run', async () => {
    const { dir: home, cleanup: c1 } = await tmpDir('envbeam-home-');
    const { dir: ws, cleanup: c2 } = await tmpDir();
    cleanups.push(c1, c2);
    process.env.ENVBEAM_HOME = home;
    try {
      const ctx = makeTestContext({
        config: baseConfig({ provider: 'doppler' }),
        runner: new FakeRunner(),
        workspaceRoot: ws,
        dryRun: true,
      }).providerCtx('secrets');
      await materializeSecrets(ctx, { values: { API_KEY: 'k' }, count: 1, keys: ['API_KEY'] });
      expect(await loadState(ws)).toEqual({});
    } finally {
      delete process.env.ENVBEAM_HOME;
    }
  });
});

// SYNC_SAFETY.md S2 — pull materialized .env with an unconditional writeFile:
// no read, no diff, no backup. A local scratch value was gone without a trace.
describe('dotenv local-edit guard', () => {
  async function scene(opts: { prompter?: AutoPrompter; force?: boolean } = {}) {
    const { dir: home, cleanup: c1 } = await tmpDir('envbeam-home-');
    const { dir: ws, cleanup: c2 } = await tmpDir();
    cleanups.push(c1, c2, async () => void delete process.env.ENVBEAM_HOME);
    process.env.ENVBEAM_HOME = home;
    const lines: string[] = [];
    const ctx = makeTestContext({
      config: baseConfig({ provider: 'doppler' }),
      runner: new FakeRunner(),
      workspaceRoot: ws,
      force: opts.force,
      prompter: opts.prompter,
      logLines: lines,
    }).providerCtx('secrets');
    return { ctx, ws, lines };
  }

  const pulled = (values: Record<string, string>) => ({ values, count: Object.keys(values).length, keys: Object.keys(values) });

  it('overwrites silently when the file is exactly what envbeam last wrote', async () => {
    const { ctx, ws, lines } = await scene();
    await materializeSecrets(ctx, pulled({ A: '1' }));
    const res = await materializeSecrets(ctx, pulled({ A: '2' }));
    expect(res.backupPath).toBeUndefined();
    expect(lines.join('\n')).not.toMatch(/local edits/);
    expect(await fs.readFile(path.join(ws, '.env'), 'utf8')).toContain('A="2"');
  });

  it('backs up a hand-edited .env before overwriting it, naming only the keys', async () => {
    const { ctx, ws, lines } = await scene();
    await materializeSecrets(ctx, pulled({ A: '1' }));
    await fs.writeFile(path.join(ws, '.env'), 'A="1"\nLOCAL_ONLY="scratch"\n');

    const res = await materializeSecrets(ctx, pulled({ A: '1' }));
    expect(res.backupPath).toBe('.env.envbeam-backup');
    expect(await fs.readFile(path.join(ws, '.env.envbeam-backup'), 'utf8')).toContain('scratch');
    const out = lines.join('\n');
    expect(out).toMatch(/has local edits/);
    expect(out).toMatch(/differing key\(s\): LOCAL_ONLY/);
    expect(out).not.toContain('scratch'); // key names only, never values
  });

  it('gitignores the backup so a secret never lands in a commit', async () => {
    const { ctx, ws } = await scene();
    await materializeSecrets(ctx, pulled({ A: '1' }));
    await fs.writeFile(path.join(ws, '.env'), 'A="edited"\n');
    await materializeSecrets(ctx, pulled({ A: '1' }));
    expect(await fs.readFile(path.join(ws, '.gitignore'), 'utf8')).toContain('.env.envbeam-backup');
  });

  it('an interactive "no" keeps the local file and does not rebaseline', async () => {
    const { ctx, ws } = await scene();
    await materializeSecrets(ctx, pulled({ A: '1' }));
    const before = await loadState(ws);
    await fs.writeFile(path.join(ws, '.env'), 'A="edited"\n');

    const res = await materializeSecrets(
      { ...ctx, prompter: interactivePrompter([{ match: 'Overwrite', value: false }]) },
      pulled({ A: '1' }),
    );

    expect(res.skipped).toBe('local edits kept');
    expect(await fs.readFile(path.join(ws, '.env'), 'utf8')).toBe('A="edited"\n');
    // The base still describes the bytes we actually wrote, not the ones we didn't.
    expect((await loadState(ws)).dotenvHash).toBe(before.dotenvHash);
  });

  it('--yes keeps the historical overwrite behavior, with the backup as the net', async () => {
    const { ctx, ws } = await scene();
    await materializeSecrets(ctx, pulled({ A: '1' }));
    await fs.writeFile(path.join(ws, '.env'), 'A="edited"\n');
    const res = await materializeSecrets(ctx, pulled({ A: '1' })); // AutoPrompter → non-interactive
    expect(res.skipped).toBeUndefined();
    expect(res.backupPath).toBe('.env.envbeam-backup');
    expect(await fs.readFile(path.join(ws, '.env'), 'utf8')).toContain('A="1"');
  });
});
