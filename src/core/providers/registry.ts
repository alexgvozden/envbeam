import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AnyProvider, ProviderKind } from './types.js';
import { pluginsDir } from '../config/paths.js';
import { EnvbeamError } from '../util/errors.js';
import { isDirectory, pathExists } from '../util/fs.js';

export interface ProviderFactory<T extends AnyProvider = AnyProvider> {
  kind: ProviderKind;
  name: string;
  /** Identity type this provider expects (validated against the named identity). */
  identityType?: string;
  create(): T;
}

/** Registry of provider factories, keyed by kind then name. Plugin-extensible. */
export class ProviderRegistry {
  private readonly byKind = new Map<ProviderKind, Map<string, ProviderFactory>>();

  register(factory: ProviderFactory): this {
    let inner = this.byKind.get(factory.kind);
    if (!inner) {
      inner = new Map();
      this.byKind.set(factory.kind, inner);
    }
    inner.set(factory.name, factory);
    return this;
  }

  has(kind: ProviderKind, name: string): boolean {
    return this.byKind.get(kind)?.has(name) ?? false;
  }

  getFactory(kind: ProviderKind, name: string): ProviderFactory | undefined {
    return this.byKind.get(kind)?.get(name);
  }

  create(kind: ProviderKind, name: string): AnyProvider {
    const factory = this.getFactory(kind, name);
    if (!factory) {
      const available = this.list(kind).join(', ') || '(none)';
      throw new EnvbeamError(
        `No ${kind} provider named "${name}". Available: ${available}.`,
        { exitCode: 2, hint: `Install a plugin in ${pluginsDir()} or fix the provider name.` },
      );
    }
    return factory.create();
  }

  list(kind: ProviderKind): string[] {
    return Array.from(this.byKind.get(kind)?.keys() ?? []);
  }

  listAll(): ProviderFactory[] {
    const out: ProviderFactory[] = [];
    for (const inner of this.byKind.values()) out.push(...inner.values());
    return out;
  }
}

/**
 * Discover and register third-party plugins from `~/.envbeam/plugins/`.
 * Each subdirectory may export (default or named `providers`) a ProviderFactory
 * or an array of them, or a `register(registry)` function.
 */
export async function loadPlugins(registry: ProviderRegistry, dir = pluginsDir()): Promise<string[]> {
  const loaded: string[] = [];
  if (!(await pathExists(dir))) return loaded;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return loaded;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (!(await isDirectory(full))) continue;
    const candidate = await resolvePluginEntry(full);
    if (!candidate) continue;
    try {
      const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
      const factories = extractFactories(mod, registry);
      for (const f of factories) {
        registry.register(f);
        loaded.push(`${f.kind}:${f.name}`);
      }
    } catch (err) {
      throw new EnvbeamError(`Failed to load plugin "${entry}": ${(err as Error).message}`, {
        exitCode: 2,
      });
    }
  }
  return loaded;
}

async function resolvePluginEntry(dir: string): Promise<string | null> {
  const pkgPath = path.join(dir, 'package.json');
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { main?: string; module?: string };
      const main = pkg.module ?? pkg.main;
      if (main) {
        const resolved = path.join(dir, main);
        if (await pathExists(resolved)) return resolved;
      }
    } catch {
      /* fall through to index lookups */
    }
  }
  for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
    const p = path.join(dir, name);
    if (await pathExists(p)) return p;
  }
  return null;
}

function extractFactories(mod: Record<string, unknown>, registry: ProviderRegistry): ProviderFactory[] {
  const reg = mod.register ?? (mod.default as Record<string, unknown> | undefined)?.register;
  if (typeof reg === 'function') {
    (reg as (r: ProviderRegistry) => void)(registry);
    return [];
  }
  const candidates: unknown[] = [];
  if (mod.providers) candidates.push(mod.providers);
  if (mod.default) candidates.push(mod.default);
  const flat: ProviderFactory[] = [];
  for (const c of candidates) {
    if (Array.isArray(c)) flat.push(...(c as ProviderFactory[]));
    else if (c && typeof c === 'object' && 'kind' in (c as object)) flat.push(c as ProviderFactory);
  }
  return flat;
}
