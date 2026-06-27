import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { loadWorkspaceConfig, tryLoadWorkspaceConfig, findWorkspaceRoot } from '../../src/core/config/load.js';
import { loadGlobalConfig, saveGlobalConfig, upsertIdentity, removeIdentity } from '../../src/core/config/globalConfig.js';
import { EnvbeamError } from '../../src/core/util/errors.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.ENVBEAM_HOME;
  while (cleanups.length) await cleanups.pop()!();
});

describe('workspace config loading', () => {
  it('finds and loads the nearest .envbeam.yaml from a subdir', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, {
      '.envbeam.yaml': 'version: 1\nworkspace: keeper\n',
      'src/deep/file.ts': 'x',
    });
    const root = await findWorkspaceRoot(path.join(dir, 'src/deep'));
    expect(root).toBe(dir);
    const loaded = await loadWorkspaceConfig(path.join(dir, 'src/deep'));
    expect(loaded.config.workspace).toBe('keeper');
    expect(loaded.workspaceRoot).toBe(dir);
  });

  it('throws a clear error when no config exists', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await expect(loadWorkspaceConfig(dir)).rejects.toBeInstanceOf(EnvbeamError);
    expect(await tryLoadWorkspaceConfig(dir)).toBeNull();
  });
});

describe('global config + identities', () => {
  it('loads empty, upserts, persists, and removes identities', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    process.env.ENVBEAM_HOME = dir;

    expect((await loadGlobalConfig()).identities).toEqual({});

    await upsertIdentity('github:work', { type: 'git', sshHost: 'github-work' });
    await upsertIdentity('doppler:keeper', { type: 'doppler' });
    const cfg = await loadGlobalConfig();
    expect(Object.keys(cfg.identities).sort()).toEqual(['doppler:keeper', 'github:work']);
    expect(cfg.identities['github:work']!.sshHost).toBe('github-work');

    expect(await removeIdentity('github:work')).toBe(true);
    expect(await removeIdentity('github:work')).toBe(false);
    expect(Object.keys((await loadGlobalConfig()).identities)).toEqual(['doppler:keeper']);
  });

  it('round-trips through YAML with no secret leakage', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    process.env.ENVBEAM_HOME = dir;
    await saveGlobalConfig({ identities: { 'doppler:k': { type: 'doppler', tokenRef: 'doppler:k' } } });
    const { promises: fs } = await import('node:fs');
    const text = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8');
    expect(text).toContain('tokenRef: doppler:k');
    expect(text).not.toMatch(/token:\s*\S+secret/i);
  });
});
