import path from 'node:path';
import YAML from 'yaml';
import { pathExists, readFileIfExists } from '../util/fs.js';
import { findFileShallow } from './scan.js';
import type { DetectedField } from './types.js';

const COMPOSE_NAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];

export interface ComposeService {
  name: string;
  image?: string;
  build?: boolean;
  ports?: string[];
  environment?: Record<string, string>;
}

export interface ParsedCompose {
  file: string;
  services: ComposeService[];
}

function coerceEnv(env: unknown): Record<string, string> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const item of env) {
      if (typeof item === 'string') {
        const idx = item.indexOf('=');
        if (idx >= 0) out[item.slice(0, idx)] = item.slice(idx + 1);
        else out[item] = '';
      }
    }
    return out;
  }
  if (typeof env === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
    return out;
  }
  return undefined;
}

export async function findComposeFile(root: string): Promise<string | null> {
  // Scan the root plus a couple of levels down so compose files kept under
  // infra/, deploy/, docker/, .devcontainer/, etc. are still detected in
  // monorepo layouts. Root-level files still win (shallowest match first);
  // among sibling subdirs, dev-oriented locations beat deploy/prod ones.
  return findFileShallow(root, COMPOSE_NAMES, {
    maxDepth: 2,
    preferDirs: ['.devcontainer', 'docker', '.docker', 'infra', 'dev', 'local', 'compose'],
  });
}

export async function parseCompose(file: string): Promise<ParsedCompose | null> {
  const text = await readFileIfExists(file);
  if (!text) return null;
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const servicesRaw = (doc as Record<string, unknown>).services;
  const services: ComposeService[] = [];
  if (servicesRaw && typeof servicesRaw === 'object') {
    for (const [name, defRaw] of Object.entries(servicesRaw as Record<string, unknown>)) {
      const def = (defRaw ?? {}) as Record<string, unknown>;
      const ports = Array.isArray(def.ports) ? def.ports.map((p) => String(p)) : undefined;
      services.push({
        name,
        image: typeof def.image === 'string' ? def.image : undefined,
        build: def.build != null,
        ports,
        environment: coerceEnv(def.environment),
      });
    }
  }
  return { file, services };
}

export async function detectContainer(workspaceRoot: string): Promise<DetectedField[]> {
  const fields: DetectedField[] = [];
  const devcontainerDir = path.join(workspaceRoot, '.devcontainer');
  const hasDevcontainer =
    (await pathExists(path.join(devcontainerDir, 'devcontainer.json'))) ||
    (await pathExists(path.join(workspaceRoot, '.devcontainer.json')));
  const composeFile = await findComposeFile(workspaceRoot);

  if (hasDevcontainer) {
    fields.push({
      field: 'container.mode',
      value: 'devcontainer',
      source: '.devcontainer/devcontainer.json',
      status: 'detected',
    });
  } else if (composeFile) {
    fields.push({
      field: 'container.mode',
      value: 'compose',
      source: path.relative(workspaceRoot, composeFile),
      status: 'detected',
    });
  } else {
    fields.push({
      field: 'container.mode',
      value: 'none',
      source: 'no .devcontainer/ or compose file',
      status: 'detected',
    });
  }

  if (composeFile) {
    fields.push({
      field: 'container.composeFile',
      value: path.relative(workspaceRoot, composeFile),
      source: 'filesystem',
      status: 'detected',
    });
    const parsed = await parseCompose(composeFile);
    if (parsed && parsed.services.length) {
      fields.push({
        field: 'container.services',
        value: parsed.services.map((s) => s.name),
        source: path.relative(workspaceRoot, composeFile),
        status: 'detected',
      });
    }
  }

  return fields;
}
