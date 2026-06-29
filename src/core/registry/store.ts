import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGlobalConfig, saveGlobalConfig } from '../config/globalConfig.js';
import { REGISTRY_FILE_NAME } from '../config/paths.js';
import type { GlobalStorageConfig } from '../config/schema.js';
import { EnvbeamError } from '../util/errors.js';
import type { CommandRunner } from '../util/exec.js';
import {
  type ProjectEntry,
  type ProjectRegistry,
  projectRegistrySchema,
  EMPTY_REGISTRY,
} from './types.js';

/**
 * Registry store that syncs project registry to/from S3.
 */
export class RegistryStore {
  private readonly storage: GlobalStorageConfig;
  private readonly runner: CommandRunner;

  constructor(storage: GlobalStorageConfig, runner: CommandRunner) {
    this.storage = storage;
    this.runner = runner;
  }

  /** Get S3 credentials from environment or Doppler. */
  private async getS3Env(): Promise<Record<string, string>> {
    // Check if credentials are in environment
    const accessKey = process.env.ENVBEAM_S3_ACCESS_KEY;
    const secretKey = process.env.ENVBEAM_S3_SECRET_KEY;

    if (accessKey && secretKey) {
      return {
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: secretKey,
      };
    }

    // If credentialSource is doppler, fetch from Doppler
    if (this.storage.credentialSource === 'doppler') {
      const res = await this.runner.run(
        'doppler',
        ['secrets', '--project', 'envbeam-global', '--config', 'prd', '--json'],
        { allowFailure: true },
      );

      if (res.code === 0) {
        try {
          const secrets = JSON.parse(res.stdout) as Record<string, { computed?: string }>;
          const dopplerAccess = secrets['ENVBEAM_S3_ACCESS_KEY']?.computed;
          const dopplerSecret = secrets['ENVBEAM_S3_SECRET_KEY']?.computed;
          if (dopplerAccess && dopplerSecret) {
            return {
              AWS_ACCESS_KEY_ID: dopplerAccess,
              AWS_SECRET_ACCESS_KEY: dopplerSecret,
            };
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    throw new EnvbeamError(
      'S3 credentials not found. Run `envbeam setup` or set ENVBEAM_S3_ACCESS_KEY and ENVBEAM_S3_SECRET_KEY.',
      { exitCode: 2 },
    );
  }

  /** Build AWS CLI base arguments. */
  private baseArgs(): string[] {
    const args: string[] = [];
    if (this.storage.endpoint) args.push('--endpoint-url', this.storage.endpoint);
    if (this.storage.region) args.push('--region', this.storage.region);
    return args;
  }

  /** S3 URI for the registry file. */
  private registryUri(): string {
    return `s3://${this.storage.bucket}/${REGISTRY_FILE_NAME}`;
  }

  /** Load registry from S3. Returns empty registry if not found. */
  async load(): Promise<ProjectRegistry> {
    const env = await this.getS3Env();
    const tmpFile = path.join(os.tmpdir(), `envbeam-registry-${Date.now()}.json`);

    try {
      const res = await this.runner.run(
        'aws',
        ['s3', 'cp', this.registryUri(), tmpFile, ...this.baseArgs()],
        { allowFailure: true, env },
      );

      if (res.code !== 0) {
        // Check if file doesn't exist (404)
        if (res.stderr.includes('404') || res.stderr.includes('does not exist') || res.stderr.includes('NoSuchKey')) {
          return structuredClone(EMPTY_REGISTRY);
        }
        throw new EnvbeamError(`Failed to load registry from S3: ${res.stderr}`, { exitCode: 2 });
      }

      const content = await fs.readFile(tmpFile, 'utf8');
      const parsed = JSON.parse(content);
      const result = projectRegistrySchema.safeParse(parsed);

      if (!result.success) {
        throw new EnvbeamError(`Invalid registry format: ${result.error.message}`, { exitCode: 2 });
      }

      return result.data;
    } finally {
      // Clean up temp file
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /** Save registry to S3. */
  async save(registry: ProjectRegistry): Promise<void> {
    const env = await this.getS3Env();
    const tmpFile = path.join(os.tmpdir(), `envbeam-registry-${Date.now()}.json`);

    try {
      await fs.writeFile(tmpFile, JSON.stringify(registry, null, 2));

      const res = await this.runner.run(
        'aws',
        ['s3', 'cp', tmpFile, this.registryUri(), ...this.baseArgs()],
        { allowFailure: true, env },
      );

      if (res.code !== 0) {
        throw new EnvbeamError(`Failed to save registry to S3: ${res.stderr}`, { exitCode: 2 });
      }
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /** Register or update a project. Throws if name conflicts with different git remote. */
  async registerProject(entry: ProjectEntry): Promise<void> {
    const registry = await this.load();

    // Check for name conflicts
    const existing = registry.projects[entry.name];
    if (existing && existing.gitRemote !== entry.gitRemote) {
      throw new EnvbeamError(
        `Project "${entry.name}" already exists with a different git remote.\n` +
        `Existing: ${existing.gitRemote}\n` +
        `New: ${entry.gitRemote}\n` +
        `Choose a unique workspace name in your .envbeam.yaml.`,
        { exitCode: 1 },
      );
    }

    registry.projects[entry.name] = entry;
    await this.save(registry);
  }

  /** Unregister a project by name. Returns true if found and removed. */
  async unregisterProject(name: string): Promise<boolean> {
    const registry = await this.load();
    if (!(name in registry.projects)) {
      return false;
    }
    delete registry.projects[name];
    await this.save(registry);
    return true;
  }

  /** Get a project by name. */
  async getProject(name: string): Promise<ProjectEntry | undefined> {
    const registry = await this.load();
    return registry.projects[name];
  }

  /** List all projects. */
  async listProjects(): Promise<ProjectEntry[]> {
    const registry = await this.load();
    return Object.values(registry.projects);
  }

  /** Check if a project exists. */
  async hasProject(name: string): Promise<boolean> {
    const registry = await this.load();
    return name in registry.projects;
  }

  /** Initialize empty registry in S3 if it doesn't exist. */
  async initializeIfNeeded(): Promise<boolean> {
    const env = await this.getS3Env();

    // Check if registry exists
    const res = await this.runner.run(
      'aws',
      ['s3api', 'head-object', '--bucket', this.storage.bucket, '--key', REGISTRY_FILE_NAME, ...this.baseArgs()],
      { allowFailure: true, env },
    );

    if (res.code === 0) {
      // Already exists
      return false;
    }

    // Create empty registry
    await this.save(EMPTY_REGISTRY);
    return true;
  }
}

/**
 * Create a registry store from global config.
 * Throws if storage is not configured.
 */
export async function createRegistryStore(runner: CommandRunner): Promise<RegistryStore> {
  const globalConfig = await loadGlobalConfig();

  if (!globalConfig.storage) {
    throw new EnvbeamError(
      'Global storage not configured. Run `envbeam setup` first.',
      { exitCode: 2, hint: 'envbeam setup' },
    );
  }

  return new RegistryStore(globalConfig.storage, runner);
}

/**
 * Check if global storage is configured.
 */
export async function isStorageConfigured(): Promise<boolean> {
  const globalConfig = await loadGlobalConfig();
  return !!globalConfig.storage;
}

/**
 * Save storage configuration to global config.
 */
export async function saveStorageConfig(storage: GlobalStorageConfig): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  globalConfig.storage = storage;
  await saveGlobalConfig(globalConfig);
}
