import { z } from 'zod';

/**
 * Schema for `.envbeam.yaml` (workspace config, committed to git, no secrets).
 *
 * Detection-first (PRD §5): almost every field is optional. Absent fields are
 * auto-detected at run time; present fields override the guess. Identity
 * references and a few non-inferable choices are the real payload.
 */

const identityRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.+-]*:[a-z0-9][a-z0-9._-]*$/i, {
    message: 'identity must look like "provider:account", e.g. github:work',
  })
  .describe('Reference to a named identity defined in global config (~/.envbeam/config.yaml).');

export const gitConfigSchema = z
  .object({
    identity: identityRef.optional(),
    remote: z.string().default('origin').describe('Git remote name.'),
    branch: z
      .string()
      .default('current')
      .describe('Branch to track, or "current" to follow the checked-out branch.'),
    autopush: z.boolean().default(true).describe('pause pushes the branch.'),
    autopull: z
      .enum(['ff-only', 'off'])
      .default('ff-only')
      .describe('resume pull policy: ff-only fast-forwards a clean tree; off skips.'),
  })
  .strict();

export const secretsConfigSchema = z
  .object({
    provider: z.string().describe('Secrets plugin name, e.g. doppler | onepassword.'),
    identity: identityRef.optional(),
    project: z.string().optional().describe('Provider-specific project reference (no secret values).'),
    config: z.string().optional().describe('Provider-specific config/environment name.'),
    vault: z.string().optional().describe('1Password vault name (onepassword provider).'),
    item: z.string().optional().describe('1Password item name holding the env vars.'),
    output: z
      .enum(['dotenv', 'run-wrapper'])
      .default('dotenv')
      .describe('How secrets are materialized locally.'),
    dotenvPath: z
      .string()
      .default('.env')
      .describe('Path (relative to workspace) for the gitignored dotenv file.'),
    sync: z
      .enum(['pull-only', 'two-way'])
      .default('pull-only')
      .describe('Sync mode: pull-only (provider is source of truth) or two-way (push local changes on pause).'),
  })
  .strict();

export const containerConfigSchema = z
  .object({
    mode: z
      .enum(['devcontainer', 'compose', 'none'])
      .describe('Container orchestration mode.'),
    composeFile: z.string().optional().describe('Path to docker-compose file (compose mode).'),
    service: z.string().optional().describe('Primary compose service to bring up.'),
    upOnResume: z.boolean().default(true),
    stopOnPause: z.boolean().default(false),
  })
  .strict();

export const snapshotConfigSchema = z
  .object({
    dataOnly: z.boolean().default(true).describe('Dump data only; schema comes from migrations.'),
    compress: z.boolean().default(true),
    tables: z
      .object({
        include: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      })
      .strict()
      .partial()
      .optional(),
    changeDetection: z
      .boolean()
      .default(true)
      .describe('Auto-prompt a snapshot on pause only if configured tables changed.'),
  })
  .strict();

export const syncConfigSchema = z
  .object({
    target: z
      .enum(['syncthing', 's3', 'local-folder'])
      .describe('Where DB snapshots live.'),
    identity: identityRef.optional(),
    path: z
      .string()
      .optional()
      .describe('Folder path for syncthing/local-folder targets.'),
    bucket: z.string().optional().describe('S3 bucket name (s3 target).'),
    prefix: z.string().optional().describe('Key prefix within the bucket/folder.'),
    region: z.string().optional().describe('S3 region (s3 target).'),
    encrypt: z
      .enum(['none', 'age', 'gpg'])
      .default('none')
      .describe('At-rest encryption of snapshot files.'),
    recipient: z.string().optional().describe('age/gpg recipient (public key / key id).'),
    maxSizeMB: z.number().positive().default(500).describe('Warn/abort above this dump size.'),
    keep: z.number().int().positive().default(5).describe('Retain N most recent snapshots.'),
  })
  .strict();

export const databaseConfigSchema = z
  .object({
    provider: z.string().optional().describe('Database plugin name: postgres | mysql.'),
    mode: z
      .enum(['migrations-only', 'snapshot'])
      .default('migrations-only')
      .describe('migrations-only (fast, default) | snapshot (carry data).'),
    restore: z
      .enum(['prompt', 'auto', 'off'])
      .default('prompt')
      .describe('On resume, how to handle a newer snapshot.'),
    connection: z
      .string()
      .default('from-secrets')
      .describe('"from-secrets" resolves host/creds from loaded secrets, or an inline env-var ref.'),
    service: z.string().optional().describe('Container service to dump/restore against.'),
    migrate: z.boolean().default(true).describe('Apply pending migrations (both modes).'),
    migrateCommand: z
      .string()
      .optional()
      .describe('Stack-specific migrate command; auto-detectable.'),
    changeTables: z
      .array(z.string())
      .optional()
      .describe('Tables watched for change-detection (defaults to snapshot include set).'),
    snapshot: snapshotConfigSchema.optional(),
    sync: syncConfigSchema.optional(),
  })
  .strict();

export const sessionConfigSchema = z
  .object({
    provider: z
      .enum(['claude-sync', 'remote-control', 'none'])
      .default('claude-sync'),
    scope: z.enum(['sessions', 'full']).default('sessions'),
    /** Remote project path mapping for cross-machine path translation. */
    remotePath: z.string().optional(),
  })
  .strict();

export const workspaceConfigSchema = z
  .object({
    version: z.literal(1).describe('Config schema version.'),
    workspace: z.string().min(1).describe('Human-readable workspace name.'),
    git: gitConfigSchema.optional(),
    secrets: secretsConfigSchema.optional(),
    // container stays partial: `mode` has no default and is detection-filled.
    container: containerConfigSchema.partial().optional(),
    database: databaseConfigSchema.optional(),
    session: sessionConfigSchema.optional(),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type GitConfig = z.infer<typeof gitConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type ContainerConfig = z.infer<typeof containerConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type SnapshotConfig = z.infer<typeof snapshotConfigSchema>;
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;

/** Global config (~/.envbeam/config.yaml): identity definitions, no secrets. */
export const identityDefSchema = z
  .object({
    type: z
      .string()
      .describe('Identity type the provider expects: git | doppler | onepassword | s3 | ...'),
    sshHost: z.string().optional().describe('~/.ssh/config host alias (git identities).'),
    account: z.string().optional().describe('CLI account handle / vault host (doppler, 1password).'),
    profile: z.string().optional().describe('Named CLI profile (e.g. aws profile, doppler config).'),
    /** Reference to a secret in the OS keychain/credential store; never an inline token. */
    tokenRef: z.string().optional().describe('Name of a stored credential (keychain key).'),
    env: z.record(z.string()).optional().describe('Extra non-secret env passed to the provider CLI.'),
  })
  .strict();

export const globalConfigSchema = z
  .object({
    identities: z.record(identityDefSchema).default({}),
    defaults: z
      .object({
        secretsProvider: z.string().optional(),
        sessionProvider: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type IdentityDef = z.infer<typeof identityDefSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
