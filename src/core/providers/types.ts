import type { CommandRunner } from '../util/exec.js';
import type { Logger } from '../util/logger.js';
import type { Prompter } from '../util/prompt.js';
import type {
  WorkspaceConfig,
  GitConfig,
  SecretsConfig,
  ContainerConfig,
  DatabaseConfig,
  SessionConfig,
} from '../config/schema.js';

export type ProviderKind = 'git' | 'secrets' | 'container' | 'database' | 'session';

/** A credential/account handle resolved before any pipeline runs (PRD §9). */
export interface ResolvedIdentity {
  /** e.g. "github:work" */
  name: string;
  /** identity type, e.g. git | doppler | onepassword | s3 */
  type: string;
  account?: string;
  sshHost?: string;
  profile?: string;
  /** Secret token resolved from the OS keychain / credential store, if any. */
  token?: string;
  /** Extra non-secret env to pass to the provider CLI. */
  env: Record<string, string>;
}

/** Everything a provider needs for one operation. */
export interface ProviderContext {
  workspaceRoot: string;
  runner: CommandRunner;
  logger: Logger;
  prompter: Prompter;
  dryRun: boolean;
  /**
   * The user passed `--force`: override safety guards that would otherwise
   * refuse to overwrite state this machine has not seen. Every guard that
   * honors this must log what it overrode.
   */
  force?: boolean;
  /** Full workspace config (resolved + detection-filled). */
  config: WorkspaceConfig;
  /** Resolved identity for this concern, if the config named one. */
  identity?: ResolvedIdentity;
  /** Env materialized from secrets, shared with later providers (e.g. DB conn). */
  env: Record<string, string>;
}

export interface ToolRequirement {
  command: string;
  versionArgs?: string[];
  installHint: string;
  /** Optional auth probe beyond presence-on-PATH. */
  authCheck?: (ctx: ProviderContext) => Promise<{ ok: boolean; detail?: string }>;
}

export interface BaseProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  /** External CLIs this provider shells out to (for doctor preflight). */
  requiredTools(ctx: ProviderContext): ToolRequirement[];
}

/* ---------------------------------- git ---------------------------------- */

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirtyFiles: string[];
  hasUpstream: boolean;
  remoteUrl?: string;
  /** Full sha of HEAD. Absent on an unborn branch (no commits yet). */
  commit?: string;
}

export interface GitPullResult {
  action: 'fast-forwarded' | 'up-to-date' | 'skipped-dirty' | 'skipped-no-upstream' | 'skipped';
  detail?: string;
}

export interface GitPushOptions {
  /** 'commit' commits dirty work with `message`; 'stash' stashes; 'none' leaves it. */
  workMode: 'commit' | 'stash' | 'none';
  message?: string;
  force: boolean;
}

export interface GitPushResult {
  committed: boolean;
  stashed: boolean;
  pushed: boolean;
  detail?: string;
}

export interface GitProvider extends BaseProvider {
  kind: 'git';
  status(ctx: ProviderContext): Promise<GitStatus>;
  pull(ctx: ProviderContext): Promise<GitPullResult>;
  pushWork(ctx: ProviderContext, opts: GitPushOptions): Promise<GitPushResult>;
}

/* -------------------------------- secrets -------------------------------- */

export interface SecretsStatus {
  present: boolean;
  count: number;
  /** True if the materialized file is older than the provider's current set. */
  stale?: boolean;
  detail?: string;
}

export interface SecretsPullResult {
  count: number;
  /** Variable names only — never log values. */
  keys: string[];
  values: Record<string, string>;
}

export interface MaterializeResult {
  mode: 'dotenv' | 'run-wrapper';
  path?: string;
  count: number;
  /** Relative path of the backup written before overwriting local edits. */
  backupPath?: string;
  /** Set when local edits were found and the user chose to keep them. */
  skipped?: string;
}

export interface SecretsPushResult {
  count: number;
  keys: string[];
  action: 'uploaded' | 'noop' | 'skipped';
  detail?: string;
}

export interface SecretsSetupResult {
  created: boolean;
  project: string;
  config: string;
  imported: number;
  detail?: string;
}

export interface SecretsSetupOptions {
  /** Project name to create/use */
  project: string;
  /** Config name (e.g. dev, staging, prod) */
  config: string;
  /** Import secrets from existing .env file */
  importEnv?: boolean;
}

export interface SecretsReadyResult {
  /** True if the backing project/config exists (or was just created). */
  ready: boolean;
  /** True when this call provisioned it. */
  created?: boolean;
  /** Reason it's not ready (shown to the user). */
  detail?: string;
  /** Remediation hint when we couldn't auto-provision (e.g. non-interactive). */
  hint?: string;
}

export interface SecretsProvider extends BaseProvider {
  kind: 'secrets';
  pull(ctx: ProviderContext): Promise<SecretsPullResult>;
  materialize(ctx: ProviderContext, pulled: SecretsPullResult): Promise<MaterializeResult>;
  status(ctx: ProviderContext): Promise<SecretsStatus>;
  /** Push local .env secrets back to the provider. Optional — not all providers support this. */
  push?(ctx: ProviderContext): Promise<SecretsPushResult>;
  /** Set up the provider (create project, import secrets). Optional — for init flow. */
  setup?(ctx: ProviderContext, opts: SecretsSetupOptions): Promise<SecretsSetupResult>;
  /**
   * Verify the backing project/config exists and, on an interactive terminal,
   * offer to create it. Optional — providers without a project concept omit it.
   */
  ensureReady?(ctx: ProviderContext): Promise<SecretsReadyResult>;
  /**
   * Record envbeam bookkeeping (e.g. git remote + branch) into the provider so
   * it alone identifies what to clone. Keys are `ENVBEAM_`-prefixed and never
   * materialized into the app's `.env`. Best-effort. Optional.
   */
  recordMeta?(ctx: ProviderContext, meta: Record<string, string>): Promise<{ ok: boolean; detail?: string }>;
}

/* ------------------------------- container ------------------------------- */

export interface ContainerStatus {
  running: boolean;
  services: Array<{ name: string; state: string }>;
  detail?: string;
}

export interface ContainerProvider extends BaseProvider {
  kind: 'container';
  up(ctx: ProviderContext): Promise<ContainerStatus>;
  down(ctx: ProviderContext): Promise<void>;
  status(ctx: ProviderContext): Promise<ContainerStatus>;
}

/* -------------------------------- database ------------------------------- */

export interface DbChangeResult {
  changed: boolean;
  detail?: string;
  /** Fingerprint used for change detection (row counts / checksums). */
  fingerprint?: string;
}

export interface SnapshotOptions {
  dataOnly: boolean;
  compress: boolean;
  includeTables: string[];
  excludeTables: string[];
  machine: string;
  timestamp: string;
}

export interface SnapshotResult {
  /** Absolute path to the produced snapshot file. */
  file: string;
  sizeBytes: number;
  tables?: string[];
}

export interface RestoreResult {
  restored: boolean;
  detail?: string;
}

export interface MigrateResult {
  ran: boolean;
  detail?: string;
}

export interface DbStatus {
  reachable: boolean;
  pendingMigrations?: number | 'unknown';
  detail?: string;
}

export interface DatabaseProvider extends BaseProvider {
  kind: 'database';
  /** Human-readable connection target (e.g. `agentlab@localhost:5432/agentlab`). */
  connectionSummary?(ctx: ProviderContext): string;
  /** Warning when multiple same-engine DB URLs are present (else null). */
  ambiguityWarning?(ctx: ProviderContext): string | null;
  hasChanged(ctx: ProviderContext, sinceFingerprint?: string): Promise<DbChangeResult>;
  snapshot(ctx: ProviderContext, opts: SnapshotOptions): Promise<SnapshotResult>;
  restore(ctx: ProviderContext, snapshotFile: string): Promise<RestoreResult>;
  migrate(ctx: ProviderContext): Promise<MigrateResult>;
  status(ctx: ProviderContext): Promise<DbStatus>;
}

/* -------------------------------- session -------------------------------- */

export interface SessionStatus {
  available: boolean;
  detail?: string;
  syncConfigured?: boolean;
}

export interface SessionResult {
  action: 'pulled' | 'pushed' | 'noop' | 'documented';
  detail?: string;
  /** Name of the archive this push produced, for the checkpoint to name. */
  artifact?: string;
}

export interface SessionProvider extends BaseProvider {
  kind: 'session';
  pull(ctx: ProviderContext): Promise<SessionResult>;
  push(ctx: ProviderContext): Promise<SessionResult>;
  status(ctx: ProviderContext): Promise<SessionStatus>;
}

export type AnyProvider =
  | GitProvider
  | SecretsProvider
  | ContainerProvider
  | DatabaseProvider
  | SessionProvider;

/* ---------------------------- config slice types ---------------------------- */

export type ResolvedGitConfig = Required<Pick<GitConfig, 'remote' | 'branch' | 'autopush' | 'autopull'>> & {
  identity?: string;
};
export type { GitConfig, SecretsConfig, ContainerConfig, DatabaseConfig, SessionConfig };
