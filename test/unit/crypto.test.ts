import { describe, it, expect } from 'vitest';
import { encryptFile, decryptFile, encryptionSuffix, requiredCryptoTools } from '../../src/core/sync/crypto.js';
import { syncConfigSchema } from '../../src/core/config/schema.js';
import { EnvbeamError } from '../../src/core/util/errors.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext } from '../helpers/context.js';
import type { ProviderContext } from '../../src/core/providers/types.js';

function pctx(runner: FakeRunner): ProviderContext {
  return makeTestContext({ config: { version: 1, workspace: 'w' }, runner }).providerCtx('database');
}

const ageCfg = (over: object = {}) => syncConfigSchema.parse({ target: 'local-folder', path: '/x', encrypt: 'age', recipient: 'age1xyz', ...over });
const gpgCfg = (over: object = {}) => syncConfigSchema.parse({ target: 'local-folder', path: '/x', encrypt: 'gpg', recipient: 'me@e****…****.com', ...over });

describe('crypto helpers', () => {
  it('builds age encrypt/decrypt commands', async () => {
    const runner = new FakeRunner({ available: ['age'] });
    const ctx = pctx(runner);
    await encryptFile(ctx, ageCfg(), '/in/dump.sql', '/out/dump.sql.age');
    const enc = runner.callsTo('age')[0]!;
    expect(enc.args).toEqual(['-r', 'age1xyz', '-o', '/out/dump.sql.age', '/in/dump.sql']);

    await decryptFile(ctx, ageCfg(), '/out/dump.sql.age', '/in/dump.sql');
    const dec = runner.callsTo('age')[1]!;
    expect(dec.args).toEqual(['-d', '-o', '/in/dump.sql', '/out/dump.sql.age']);
  });

  it('builds gpg encrypt/decrypt commands', async () => {
    const runner = new FakeRunner({ available: ['gpg'] });
    const ctx = pctx(runner);
    await encryptFile(ctx, gpgCfg(), '/in/d.sql', '/out/d.sql.gpg');
    const enc = runner.callsTo('gpg')[0]!;
    expect(enc.args).toContain('--encrypt');
    expect(enc.args).toContain('--recipient');
    expect(enc.args).toContain('me@e****…****.com');

    await decryptFile(ctx, gpgCfg(), '/out/d.sql.gpg', '/in/d.sql');
    expect(runner.callsTo('gpg')[1]!.args).toContain('--decrypt');
  });

  it('requires a recipient for age/gpg encryption', async () => {
    const runner = new FakeRunner({ available: ['age', 'gpg'] });
    const ctx = pctx(runner);
    await expect(encryptFile(ctx, ageCfg({ recipient: undefined }), '/a', '/b')).rejects.toBeInstanceOf(EnvbeamError);
    await expect(encryptFile(ctx, gpgCfg({ recipient: undefined }), '/a', '/b')).rejects.toBeInstanceOf(EnvbeamError);
  });

  it('computes suffix and required tools', () => {
    expect(encryptionSuffix(ageCfg())).toBe('.age');
    expect(encryptionSuffix(gpgCfg())).toBe('.gpg');
    expect(encryptionSuffix(syncConfigSchema.parse({ target: 'local-folder', path: '/x' }))).toBe('');
    expect(requiredCryptoTools(ageCfg())).toEqual(['age']);
    expect(requiredCryptoTools(undefined)).toEqual([]);
  });
});
