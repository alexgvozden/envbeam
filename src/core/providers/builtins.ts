import { ProviderRegistry, loadPlugins } from './registry.js';
import { gitProviderFactory } from './git/git.js';
import { dopplerProviderFactory } from './secrets/doppler.js';
import { onePasswordProviderFactory } from './secrets/onepassword.js';
import { composeProviderFactory } from './container/compose.js';
import { devcontainerProviderFactory } from './container/devcontainer.js';
import { postgresProviderFactory } from './database/postgres.js';
import { mysqlProviderFactory } from './database/mysql.js';
import { neo4jProviderFactory } from './database/neo4j.js';
import { claudeNativeProviderFactory } from './session/claudeNative.js';
import { claudeSyncProviderFactory } from './session/claudeSync.js';
import { remoteControlProviderFactory } from './session/remoteControl.js';
import { noneSessionProviderFactory } from './session/none.js';

/** All in-tree provider factories. */
export const BUILTIN_FACTORIES = [
  gitProviderFactory,
  dopplerProviderFactory,
  onePasswordProviderFactory,
  composeProviderFactory,
  devcontainerProviderFactory,
  postgresProviderFactory,
  mysqlProviderFactory,
  neo4jProviderFactory,
  claudeNativeProviderFactory,
  claudeSyncProviderFactory,
  remoteControlProviderFactory,
  noneSessionProviderFactory,
];

/** Register built-ins. */
export function createBuiltinRegistry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  for (const f of BUILTIN_FACTORIES) reg.register(f);
  return reg;
}

/** Register built-ins plus any third-party plugins discovered on disk. */
export async function createRegistry(): Promise<{ registry: ProviderRegistry; plugins: string[] }> {
  const registry = createBuiltinRegistry();
  const plugins = await loadPlugins(registry);
  return { registry, plugins };
}
