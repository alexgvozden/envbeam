import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorkspaceConfig, GlobalConfig } from '../config/schema.js';
import type { CommandRunner } from '../util/exec.js';
import { RealCommandRunner } from '../util/exec.js';
import { Logger } from '../util/logger.js';
import { TerminalPrompter, type Prompter } from '../util/prompt.js';
import { loadWorkspaceConfig } from '../config/load.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { mergeDetection } from '../config/merge.js';
import { detectWorkspace } from '../detect/index.js';
import type { DetectionReport } from '../detect/types.js';
import { createRegistry } from '../providers/builtins.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createCredentialStore, type CredentialStore } from '../identity/store.js';
import { resolveOptionalIdentity } from '../identity/resolver.js';
import type { ProviderContext, ProviderKind, ResolvedIdentity } from '../providers/types.js';
import { parseDotenv } from '../providers/secrets/materialize.js';
import { EnvbeamError } from '../util/errors.js';
import { getGlobalStorageConfig, injectStorageEnv } from '../storage/global.js';

export interface RunContextOptions {
  cwd?: string;
  dryRun?: boolean;
  runner?: CommandRunner;
  logger?: Logger;
  prompter?: Prompter;
}

export interface ResolvedIdentities {
  git?: ResolvedIdentity;
  secrets?: ResolvedIdentity;
  database?: ResolvedIdentity;
  sync?: ResolvedIdentity;
  session?: ResolvedIdentity;
}

/** Fully-prepared execution context shared across a pipeline run. */
export class RunContext {
  readonly workspaceRoot: string;
  readonly configPath: string;
  readonly config: WorkspaceConfig;
  readonly detection: DetectionReport;
  readonly registry: ProviderRegistry;
  readonly plugins: string[];
  readonly globalConfig: GlobalConfig;
  readonly store: CredentialStore;
  readonly runner: CommandRunner;
  readonly logger: Logger;
  readonly prompter: Prompter;
  readonly dryRun: boolean;
  readonly identities: ResolvedIdentities;
  /** Identity references that could not be resolved (reported, not fatal). */
  readonly identityWarnings: string[];
  /** Mutable env, seeded from any existing dotenv, augmented as secrets load. */
  env: Record<string, string>;

  constructor(init: {
    workspaceRoot: string;
    configPath: string;
    config: WorkspaceConfig;
    detection: DetectionReport;
    registry: ProviderRegistry;
    plugins: string[];
    globalConfig: GlobalConfig;
    store: CredentialStore;
    runner: CommandRunner;
    logger: Logger;
    prompter: Prompter;
    dryRun: boolean;
    identities: ResolvedIdentities;
    identityWarnings: string[];
    env: Record<string, string>;
  }) {
    this.workspaceRoot = init.workspaceRoot;
    this.configPath = init.configPath;
    this.config = init.config;
    this.detection = init.detection;
    this.registry = init.registry;
    this.plugins = init.plugins;
    this.globalConfig = init.globalConfig;
    this.store = init.store;
    this.runner = init.runner;
    this.logger = init.logger;
    this.prompter = init.prompter;
    this.dryRun = init.dryRun;
    this.identities = init.identities;
    this.identityWarnings = init.identityWarnings;
    this.env = init.env;
  }

  /** Build a ProviderContext for one concern, with the resolved identity. */
  providerCtx(kind: ProviderKind): ProviderContext {
    const identity =
      kind === 'git'
        ? this.identities.git
        : kind === 'secrets'
          ? this.identities.secrets
          : kind === 'database'
            ? this.identities.database
            : kind === 'session'
              ? this.identities.session
              : undefined;
    return {
      workspaceRoot: this.workspaceRoot,
      runner: this.runner,
      logger: this.logger,
      prompter: this.prompter,
      dryRun: this.dryRun,
      config: this.config,
      identity,
      env: this.env,
    };
  }
}

async function readExistingDotenv(workspaceRoot: string, config: WorkspaceConfig): Promise<Record<string, string>> {
  // Merge the configured dotenv plus common local variants so DB connection
  // details (and other vars) are found wherever the project keeps them. The
  // configured/primary file wins; later files only fill gaps.
  const primary = config.secrets?.dotenvPath ?? '.env';
  const files = [primary, '.env.local', '.env.development', '.env.dev'];
  const merged: Record<string, string> = {};
  const seen = new Set<string>();
  for (const rel of files) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const text = await fs.readFile(path.join(workspaceRoot, rel), 'utf8');
      for (const [k, v] of Object.entries(parseDotenv(text))) {
        if (!(k in merged)) merged[k] = v;
      }
    } catch {
      /* missing file — skip */
    }
  }
  return merged;
}

/** Load + detect + merge config, build registry, resolve identities. */
export async function buildRunContext(opts: RunContextOptions = {}): Promise<RunContext> {
  const cwd = opts.cwd ?? process.cwd();
  const runner = opts.runner ?? new RealCommandRunner();
  const logger = opts.logger ?? new Logger({ dryRun: opts.dryRun });
  const prompter = opts.prompter ?? new TerminalPrompter();

  const { config: rawConfig, configPath, workspaceRoot } = await loadWorkspaceConfig(cwd);
  const detection = await detectWorkspace(workspaceRoot);
  const config = mergeDetection(rawConfig, detection);

  const { registry, plugins } = await createRegistry();
  const globalConfig = await loadGlobalConfig();
  const store = await createCredentialStore(runner);

  const identityWarnings: string[] = [];
  const lenient = async (ref: string | undefined): Promise<ResolvedIdentity | undefined> => {
    try {
      return await resolveOptionalIdentity(ref, globalConfig, store);
    } catch (e) {
      if (e instanceof EnvbeamError && ref) identityWarnings.push(ref);
      else if (!(e instanceof EnvbeamError)) throw e;
      return undefined;
    }
  };
  const identities: ResolvedIdentities = {
    git: await lenient(config.git?.identity),
    secrets: await lenient(config.secrets?.identity),
    database: undefined,
    sync: await lenient(config.database?.sync?.identity),
    session: undefined,
  };

  const env = await readExistingDotenv(workspaceRoot, config);

  // Auto-inject global storage config from Doppler if using S3 sync and env vars aren't set
  if (config.database?.sync?.target === 's3' && !process.env.ENVBEAM_S3_ACCESS_KEY) {
    const globalStorage = await getGlobalStorageConfig(runner);
    if (globalStorage) {
      injectStorageEnv(globalStorage);
      logger.debug('Loaded global S3 storage config from Doppler');
    }
  }

  return new RunContext({
    workspaceRoot,
    configPath,
    config,
    detection,
    registry,
    plugins,
    globalConfig,
    store,
    runner,
    logger,
    prompter,
    dryRun: opts.dryRun ?? false,
    identities,
    identityWarnings,
    env,
  });
}
