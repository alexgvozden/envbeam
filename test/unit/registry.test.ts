import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { ProviderRegistry, loadPlugins } from '../../src/core/providers/registry.js';
import { createBuiltinRegistry } from '../../src/core/providers/builtins.js';
import { EnvbeamError } from '../../src/core/util/errors.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('built-in registry', () => {
  it('registers every concern and creates providers by name', () => {
    const reg = createBuiltinRegistry();
    expect(reg.list('secrets').sort()).toEqual(['doppler', 'onepassword']);
    expect(reg.list('container').sort()).toEqual(['compose', 'devcontainer']);
    expect(reg.list('database').sort()).toEqual(['mysql', 'neo4j', 'postgres']);
    expect(reg.list('session').sort()).toEqual(['claude-native', 'claude-sync', 'none', 'remote-control']);
    expect(reg.create('database', 'postgres').name).toBe('postgres');
  });

  it('throws a helpful error for an unknown provider', () => {
    const reg = createBuiltinRegistry();
    expect(() => reg.create('secrets', 'vault')).toThrow(EnvbeamError);
    expect(() => reg.create('secrets', 'vault')).toThrow(/Available: doppler, onepassword/);
  });
});

describe('plugin loader', () => {
  it('loads a factory-array plugin from disk', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, {
      'my-secrets/index.mjs': `
        export default [{
          kind: 'secrets',
          name: 'vault',
          identityType: 'vault',
          create: () => ({ name: 'vault', kind: 'secrets', requiredTools: () => [], pull: async () => ({count:0,keys:[],values:{}}), materialize: async () => ({mode:'dotenv',count:0}), status: async () => ({present:false,count:0}) }),
        }];
      `,
    });
    const reg = new ProviderRegistry();
    const loaded = await loadPlugins(reg, dir);
    expect(loaded).toContain('secrets:vault');
    expect(reg.has('secrets', 'vault')).toBe(true);
  });

  it('loads a register()-style plugin and resolves package.json main', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, {
      'reg-plugin/package.json': JSON.stringify({ name: 'reg-plugin', main: 'main.js' }),
      'reg-plugin/main.js': `
        export function register(registry) {
          registry.register({ kind: 'session', name: 'my-session', create: () => ({ name: 'my-session', kind: 'session', requiredTools: () => [], pull: async()=>({action:'noop'}), push: async()=>({action:'noop'}), status: async()=>({available:true}) }) });
        }
      `,
    });
    const reg = new ProviderRegistry();
    const loaded = await loadPlugins(reg, dir);
    expect(reg.has('session', 'my-session')).toBe(true);
    expect(loaded.length).toBe(0); // register() doesn't report names, but registers
  });

  it('returns empty when the plugins dir is absent', async () => {
    const reg = new ProviderRegistry();
    expect(await loadPlugins(reg, path.join('/nonexistent', 'plugins'))).toEqual([]);
  });
});
