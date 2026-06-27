import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import { globalConfigSchema, type GlobalConfig, type IdentityDef } from './schema.js';
import { globalConfigPath } from './paths.js';
import { ensureDir, pathExists } from '../util/fs.js';
import { EnvbeamError } from '../util/errors.js';
import path from 'node:path';

const EMPTY: GlobalConfig = { identities: {} };

/** Load global config (~/.envbeam/config.yaml); returns empty config if absent. */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const p = globalConfigPath();
  if (!(await pathExists(p))) return structuredClone(EMPTY);
  const text = await fs.readFile(p, 'utf8');
  const raw = YAML.parse(text) ?? {};
  const result = globalConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvbeamError(`Invalid global config (${p}):\n${lines.join('\n')}`, { exitCode: 2 });
  }
  return result.data;
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const p = globalConfigPath();
  await ensureDir(path.dirname(p));
  const validated = globalConfigSchema.parse(config);
  const header = '# envbeam global config — identity definitions only, no secret values.\n';
  await fs.writeFile(p, header + YAML.stringify(validated));
}

export async function upsertIdentity(name: string, def: IdentityDef): Promise<GlobalConfig> {
  const config = await loadGlobalConfig();
  config.identities[name] = def;
  await saveGlobalConfig(config);
  return config;
}

export async function removeIdentity(name: string): Promise<boolean> {
  const config = await loadGlobalConfig();
  if (!(name in config.identities)) return false;
  delete config.identities[name];
  await saveGlobalConfig(config);
  return true;
}

export function getIdentity(config: GlobalConfig, name: string): IdentityDef | undefined {
  return config.identities[name];
}
