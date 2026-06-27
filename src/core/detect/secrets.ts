import path from 'node:path';
import { readFileIfExists, pathExists } from '../util/fs.js';
import type { DetectedField } from './types.js';

/** Parse env-var NAMES (never values) from a .env.example-style file. */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.replace(/^export\s+/, '');
    const m = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1]) keys.push(m[1]);
  }
  return Array.from(new Set(keys));
}

const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];

/** Detect a secrets provider hint from lockfiles / config presence. */
async function detectProviderHint(root: string): Promise<string | undefined> {
  if (await pathExists(path.join(root, 'doppler.yaml'))) return 'doppler';
  if (await pathExists(path.join(root, '.doppler.yaml'))) return 'doppler';
  if (await pathExists(path.join(root, '.op'))) return 'onepassword';
  return undefined;
}

export async function detectSecrets(workspaceRoot: string): Promise<DetectedField[]> {
  const fields: DetectedField[] = [];
  let exampleFile: string | undefined;
  for (const name of EXAMPLE_FILES) {
    if (await pathExists(path.join(workspaceRoot, name))) {
      exampleFile = name;
      break;
    }
  }

  if (exampleFile) {
    const text = (await readFileIfExists(path.join(workspaceRoot, exampleFile))) ?? '';
    const keys = parseEnvKeys(text);
    fields.push({
      field: 'secrets.keys',
      value: keys,
      source: exampleFile,
      status: keys.length ? 'detected' : 'missing',
      note: keys.length ? `${keys.length} candidate secret names (names only)` : 'no keys found',
    });
  } else {
    fields.push({
      field: 'secrets.keys',
      source: '.env.example',
      status: 'missing',
      note: 'no .env.example found',
    });
  }

  const providerHint = await detectProviderHint(workspaceRoot);
  if (providerHint) {
    fields.push({
      field: 'secrets.provider',
      value: providerHint,
      source: 'project files',
      status: 'detected',
    });
  } else {
    fields.push({
      field: 'secrets.provider',
      source: 'project files',
      status: 'missing',
      note: 'declare which secrets provider to use (doppler | onepassword)',
    });
  }

  return fields;
}
