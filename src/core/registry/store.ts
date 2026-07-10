import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGlobalConfig, saveGlobalConfig } from '../config/globalConfig.js';
import { REGISTRY_FILE_NAME } from '../config/paths.js';
import type { GlobalStorageConfig } from '../config/schema.js';
import { EnvbeamError, SafetyError } from '../util/errors.js';
import type { CommandRunner } from '../util/exec.js';
import {
  type ProjectEntry,
  type ProjectEntryInput,
  type ProjectRegistry,
  projectEntrySchema,
  projectRegistrySchema,
  EMPTY_REGISTRY,
} from './types.js';

/** The registry object does not exist yet. */
function isNotFound(stderr: string): boolean {
  return /\b404\b|NoSuchKey|does not exist|Not Found/i.test(stderr);
}

/** Our ETag no longer matches (or the key appeared under `--if-none-match '*'`). */
export function isPreconditionFailed(stderr: string): boolean {
  return /\b412\b|PreconditionFailed|\b409\b|ConditionalRequestConflict/i.test(stderr);
}

/**
 * The CLI or the endpoint doesn't do conditional writes. Old aws-cli rejects the
 * flag outright; S3-compatible endpoints answer 501 or reject the header.
 */
export function isConditionalWriteUnsupported(stderr: string): boolean {
  return /Unknown options?:.*--if-(match|none-match)|no such option|\b501\b|NotImplemented|InvalidArgument.*[Ii]f-[Mm]atch/i.test(
    stderr,
  );
}

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
    return (await this.loadWithEtag()).registry;
  }

  /**
   * Load the registry along with its ETag, the token a conditional write uses to
   * say "only if nobody else has written since I read this". `etag` is undefined
   * when the object does not exist yet — the caller then writes with
   * `--if-none-match '*'` so exactly one racing machine creates it.
   */
  private async loadWithEtag(): Promise<{ registry: ProjectRegistry; etag?: string }> {
    const env = await this.getS3Env();
    const tmpFile = path.join(os.tmpdir(), `envbeam-registry-${process.pid}-${Date.now()}.json`);

    try {
      // s3api (not `s3 cp`) so the response metadata, and with it the ETag, is
      // available on stdout.
      const res = await this.runner.run(
        'aws',
        ['s3api', 'get-object', '--bucket', this.storage.bucket, '--key', REGISTRY_FILE_NAME, tmpFile, ...this.baseArgs()],
        { allowFailure: true, env },
      );

      if (res.code !== 0) {
        if (isNotFound(res.stderr)) return { registry: structuredClone(EMPTY_REGISTRY) };
        throw new EnvbeamError(`Failed to load registry from S3: ${res.stderr}`, { exitCode: 2 });
      }

      let etag: string | undefined;
      try {
        etag = (JSON.parse(res.stdout) as { ETag?: string }).ETag;
      } catch {
        /* some endpoints print nothing; we fall back to an unconditional write */
      }

      const content = await fs.readFile(tmpFile, 'utf8');
      const result = projectRegistrySchema.safeParse(JSON.parse(content));
      if (!result.success) {
        throw new EnvbeamError(`Invalid registry format: ${result.error.message}`, { exitCode: 2 });
      }
      return { registry: result.data, etag };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /** Save registry to S3, unconditionally. */
  async save(registry: ProjectRegistry): Promise<void> {
    const res = await this.put(registry, {});
    if (!res.ok) {
      throw new EnvbeamError(`Failed to save registry to S3: ${res.stderr}`, { exitCode: 2 });
    }
  }

  /**
   * Write the registry, optionally only if the remote object still matches the
   * ETag we read (`ifMatch`), or only if it does not exist (`ifNoneMatch`).
   * Reports a lost race as `{ ok: false, precondition: true }` rather than
   * throwing, so the caller can reload and re-apply.
   */
  private async put(
    registry: ProjectRegistry,
    cond: { ifMatch?: string; ifNoneMatch?: boolean },
  ): Promise<{ ok: true } | { ok: false; precondition: boolean; unsupported: boolean; stderr: string }> {
    const env = await this.getS3Env();
    const tmpFile = path.join(os.tmpdir(), `envbeam-registry-${process.pid}-${Date.now()}.json`);
    try {
      await fs.writeFile(tmpFile, JSON.stringify(registry, null, 2));
      const args = [
        's3api',
        'put-object',
        '--bucket',
        this.storage.bucket,
        '--key',
        REGISTRY_FILE_NAME,
        '--body',
        tmpFile,
        ...this.baseArgs(),
      ];
      if (cond.ifMatch) args.push('--if-match', cond.ifMatch);
      if (cond.ifNoneMatch) args.push('--if-none-match', '*');

      const res = await this.runner.run('aws', args, { allowFailure: true, env });
      if (res.code === 0) return { ok: true };
      return {
        ok: false,
        precondition: isPreconditionFailed(res.stderr),
        unsupported: isConditionalWriteUnsupported(res.stderr),
        stderr: res.stderr,
      };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Register or update a project, assigning it the next revision.
   *
   * This is a read-modify-write on a single JSON object holding *every* project,
   * so two machines pushing different projects at the same time used to drop one
   * of them entirely (SYNC_SAFETY.md R1). The write is now conditional on the
   * ETag we read; on a lost race we reload and re-apply only *our* entry, which
   * leaves the other machine's write intact.
   *
   * `expectedRevision` makes the write refuse when the remote entry has moved
   * since this machine's base — that is a divergence, and overwriting the
   * `configSnapshot` and checkpoint of a newer push would be a silent regression
   * (R2). Omit it to force.
   */
  async registerProject(
    entry: ProjectEntryInput,
    opts: { expectedRevision?: number } = {},
  ): Promise<ProjectEntry> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { registry, etag } = await this.loadWithEtag();
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

      // Divergence, not a race: retrying cannot make this succeed.
      if (opts.expectedRevision !== undefined && existing && existing.revision !== opts.expectedRevision) {
        throw new SafetyError(
          `Project "${entry.name}" is at revision ${existing.revision} in the registry, ` +
            `but this machine last saw revision ${opts.expectedRevision}. Another machine has pushed since.`,
          'Run `envbeam pull` to catch up, or re-run with --force to overwrite the remote checkpoint.',
        );
      }

      const revision = (existing?.revision ?? 0) + 1;
      const next: ProjectEntry = projectEntrySchema.parse({
        ...entry,
        revision,
        // The caller cannot know its revision until the CAS loop settles, and a
        // retry may bump it again. Stamp it here so the two never disagree.
        ...(entry.checkpoint ? { checkpoint: { ...entry.checkpoint, revision } } : {}),
      });
      registry.projects[entry.name] = next;

      const res = await this.put(registry, etag ? { ifMatch: etag } : { ifNoneMatch: true });
      if (res.ok) return next;

      if (res.precondition) continue; // someone else wrote; reload and re-apply
      if (res.unsupported) return this.registerWithoutCas(registry, next);

      throw new EnvbeamError(`Failed to save registry to S3: ${res.stderr}`, { exitCode: 2 });
    }
    throw new EnvbeamError(
      `Could not update the project registry after ${MAX_ATTEMPTS} attempts — it is being written concurrently.`,
      { exitCode: 2, hint: 'Retry in a moment.' },
    );
  }

  /**
   * Fallback for endpoints without conditional writes (some MinIO/R2 versions):
   * write unconditionally, then read back and verify nothing we saw disappeared.
   * This cannot *prevent* a lost update — it can only tell the user one happened,
   * which is strictly better than the silence R1 describes.
   */
  private async registerWithoutCas(registry: ProjectRegistry, entry: ProjectEntry): Promise<ProjectEntry> {
    this.warnedNoCas ||= true;
    const expected = Object.keys(registry.projects).sort();
    await this.save(registry);

    const after = await this.load();
    const lost = expected.filter((n) => !(n in after.projects));
    if (lost.length || after.projects[entry.name]?.revision !== entry.revision) {
      throw new EnvbeamError(
        `The storage endpoint does not support conditional writes, and a concurrent push raced this one.` +
          (lost.length ? ` Project(s) dropped from the registry: ${lost.join(', ')}.` : ''),
        {
          exitCode: 2,
          hint: 'Re-run `envbeam push`. To prevent this, use a bucket whose endpoint supports S3 conditional writes (If-Match).',
        },
      );
    }
    return entry;
  }

  /** True once a write had to fall back to a non-conditional put. */
  warnedNoCas = false;

  /** Unregister a project by name. Returns true if found and removed. */
  async unregisterProject(name: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const { registry, etag } = await this.loadWithEtag();
      if (!(name in registry.projects)) return false;
      delete registry.projects[name];

      const res = await this.put(registry, etag ? { ifMatch: etag } : {});
      if (res.ok) return true;
      if (res.precondition) continue;
      if (res.unsupported) {
        await this.save(registry);
        return true;
      }
      throw new EnvbeamError(`Failed to save registry to S3: ${res.stderr}`, { exitCode: 2 });
    }
    throw new EnvbeamError('Could not update the project registry — it is being written concurrently.', {
      exitCode: 2,
    });
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

  /**
   * Initialize an empty registry in S3 if it doesn't exist. Creates it with
   * `--if-none-match '*'` so that two machines setting up at once cannot have
   * one overwrite the other's freshly-created (and possibly already populated)
   * registry with an empty one — the check-then-write it used to do had exactly
   * that window.
   */
  async initializeIfNeeded(): Promise<boolean> {
    const env = await this.getS3Env();

    const res = await this.runner.run(
      'aws',
      ['s3api', 'head-object', '--bucket', this.storage.bucket, '--key', REGISTRY_FILE_NAME, ...this.baseArgs()],
      { allowFailure: true, env },
    );
    if (res.code === 0) return false; // already exists

    const created = await this.put(EMPTY_REGISTRY, { ifNoneMatch: true });
    if (created.ok) return true;
    // Someone created it in the window. That is the outcome we wanted anyway.
    if (created.precondition) return false;
    if (created.unsupported) {
      await this.save(EMPTY_REGISTRY);
      return true;
    }
    throw new EnvbeamError(`Failed to create registry in S3: ${created.stderr}`, { exitCode: 2 });
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
  // Escape hatch for offline use and hermetic tests: never touch remote storage.
  if (process.env.ENVBEAM_DISABLE_STORAGE) return false;
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
