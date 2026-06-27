import path from 'node:path';
import os from 'node:os';

export const WORKSPACE_CONFIG_NAME = '.envbeam.yaml';

/** Root of envbeam's global config/state. Overridable for tests via ENVBEAM_HOME. */
export function globalDir(): string {
  return process.env.ENVBEAM_HOME ?? path.join(os.homedir(), '.envbeam');
}

export function globalConfigPath(): string {
  return path.join(globalDir(), 'config.yaml');
}

export function pluginsDir(): string {
  return path.join(globalDir(), 'plugins');
}

/** Where the file-backed credential store lives when the OS keychain is unused. */
export function credentialStorePath(): string {
  return path.join(globalDir(), 'credentials.json');
}

/** Local state cache (last snapshot markers, etc.), keyed per workspace. */
export function stateDir(): string {
  return path.join(globalDir(), 'state');
}
