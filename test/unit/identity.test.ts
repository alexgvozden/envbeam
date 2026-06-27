import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { FileCredentialStore, KeychainStore } from '../../src/core/identity/store.js';
import { resolveIdentity, resolveOptionalIdentity } from '../../src/core/identity/resolver.js';
import { EnvbeamError } from '../../src/core/util/errors.js';
import { globalConfigSchema } from '../../src/core/config/schema.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { tmpDir } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('file credential store', () => {
  it('sets, gets, lists, deletes with 0600 perms', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const store = new FileCredentialStore(path.join(dir, 'creds.json'));
    expect(await store.get('a:b')).toBeNull();
    await store.set('a:b', 'tok1');
    await store.set('c:d', 'tok2');
    expect(await store.get('a:b')).toBe('tok1');
    expect((await store.list()).sort()).toEqual(['a:b', 'c:d']);
    const { promises: fs } = await import('node:fs');
    const mode = (await fs.stat(path.join(dir, 'creds.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await store.delete('a:b')).toBe(true);
    expect(await store.delete('a:b')).toBe(false);
    expect(await store.get('a:b')).toBeNull();
  });
});

describe('keychain store (macOS security via fake runner)', () => {
  it('shells out to security and maintains a names index', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    process.env.ENVBEAM_HOME = dir;
    const runner = new FakeRunner();
    const secrets = new Map<string, string>();
    runner.on('security add-generic-password', (_c, args) => {
      const s = args[args.indexOf('-s') + 1]!;
      const w = args[args.indexOf('-w') + 1]!;
      secrets.set(s, w);
      return {};
    });
    runner.on('security find-generic-password', (_c, args) => {
      const s = args[args.indexOf('-s') + 1]!;
      return secrets.has(s) ? { stdout: secrets.get(s)! + '\n' } : { code: 1 };
    });
    const store = new KeychainStore(runner, 'darwin');
    await store.set('doppler:keeper', 'tokX');
    expect(await store.get('doppler:keeper')).toBe('tokX');
    expect(await store.list()).toContain('doppler:keeper');
    delete process.env.ENVBEAM_HOME;
  });
});

describe('identity resolver', () => {
  const global = globalConfigSchema.parse({
    identities: {
      'github:work': { type: 'git', sshHost: 'github-work' },
      'doppler:keeper': { type: 'doppler', tokenRef: 'doppler:keeper' },
    },
  });

  it('resolves account fields and the stored token', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const store = new FileCredentialStore(path.join(dir, 'creds.json'));
    await store.set('doppler:keeper', 'secrettoken');
    const id = await resolveIdentity('doppler:keeper', global, store);
    expect(id).toMatchObject({ name: 'doppler:keeper', type: 'doppler', token: 'secrettoken' });

    const git = await resolveIdentity('github:work', global, store);
    expect(git.sshHost).toBe('github-work');
    expect(git.token).toBeUndefined();
  });

  it('throws on an unknown identity', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const store = new FileCredentialStore(path.join(dir, 'creds.json'));
    await expect(resolveIdentity('nope:x', global, store)).rejects.toBeInstanceOf(EnvbeamError);
    expect(await resolveOptionalIdentity(undefined, global, store)).toBeUndefined();
  });
});
