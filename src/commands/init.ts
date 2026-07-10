import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import { WORKSPACE_CONFIG_NAME } from '../core/config/paths.js';
import { pathExists } from '../core/util/fs.js';
import { detectWorkspace } from '../core/detect/index.js';
import { detectedValue, getField, resolveBranch } from '../core/detect/types.js';
import { parseConfig } from '../core/config/load.js';
import { RealCommandRunner, type CommandRunner } from '../core/util/exec.js';
import { isStorageConfigured, createRegistryStore, type ProjectEntryInput } from '../core/registry/index.js';
import { checkSecretsAuth, loginHint, isInteractive } from '../core/providers/secretsAuth.js';
import { pullCommand } from './pull.js';
import { ensureStorageReady } from './storage.js';
import { getMachineId } from '../core/util/machine.js';
import { inspectLocalGit, sameRemote } from '../core/util/gitSync.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

/**
 * Parse git remote URL and detect identity from SSH config.
 * e.g., git@github-work:org/repo.git → github:work
 */
async function detectGitIdentity(gitUrl: string | undefined): Promise<string | undefined> {
  if (!gitUrl) return undefined;

  // Parse host from git URL
  // Formats: git@host:path, ssh://git@host/path, https://host/path
  let host: string | undefined;
  const sshMatch = gitUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/);
  const httpsMatch = gitUrl.match(/^https?:\/\/([^/]+)\//);
  host = sshMatch?.[1] ?? httpsMatch?.[1];

  if (!host) return undefined;

  // Check if this is a custom SSH host alias (not a standard domain)
  // e.g., github-work, gitlab-personal
  if (!host.includes('.')) {
    // It's an alias like "github-work" - convert to identity format
    // github-work → github:work, gitlab-personal → gitlab:personal
    const parts = host.split('-');
    if (parts.length >= 2) {
      return `${parts[0]}:${parts.slice(1).join('-')}`;
    }
    return `git:${host}`;
  }

  // Standard domain - try to read SSH config to find matching Host entries
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
  try {
    const sshConfig = await fs.readFile(sshConfigPath, 'utf8');
    // Look for Host entries that have HostName matching this domain
    // e.g., Host github-work → HostName github.com
    const hostPattern = new RegExp(
      `Host\\s+(\\S+)[^]*?HostName\\s+${host.replace('.', '\\.')}`,
      'gi',
    );
    const matches = [...sshConfig.matchAll(hostPattern)];
    for (const match of matches) {
      const alias = match[1];
      if (alias && alias !== host && !alias.includes('*')) {
        // Found an alias - convert to identity format
        const parts = alias.split('-');
        if (parts.length >= 2) {
          return `${parts[0]}:${parts.slice(1).join('-')}`;
        }
      }
    }
  } catch {
    // No SSH config or can't read it
  }

  // Standard domain without custom alias
  // github.com → github:default, gitlab.com → gitlab:default
  const domainParts = host.split('.');
  if (domainParts[0] === 'www') domainParts.shift();
  return undefined; // Don't suggest identity for standard domains
}

export interface InitOptions extends GlobalCliOptions {
  force?: boolean;
  /** Bootstrap an existing project by name instead of scaffolding a new one. */
  project?: string;
  /** Directory to clone into (bootstrap mode). */
  dir?: string;
  /** Injectable command runner (tests pass a fake to avoid real network I/O). */
  runner?: CommandRunner;
}

export async function initCommand(opts: InitOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);
  const runner = opts.runner ?? new RealCommandRunner();

  // `envbeam init <name>` for a project that already exists remotely can be
  // bootstrapped via pull (clone, write config from snapshot, sync) — but that
  // runs a full resume, so never do it implicitly. Ask; on "no", scaffold a
  // local config here, which is what `init` says on the tin.
  if (opts.project) {
    if (await isStorageConfigured()) {
      const existing = await createRegistryStore(runner)
        .then((store) => store.getProject(opts.project!))
        .catch(() => undefined);
      if (existing) {
        logger.warn(`Project "${opts.project}" already exists in the registry.`);
        if (existing.gitRemote) logger.sub(pc.dim(`remote: ${existing.gitRemote}`));
        if (existing.lastPush) logger.sub(pc.dim(`last push: ${existing.lastPush}`));
        logger.hint('Pulling runs a full resume: it fast-forwards git, overwrites .env, and may start containers.');

        const doPull = await prompter.confirm(`Pull "${opts.project}" from the registry?`, false);
        if (doPull) {
          // Standing inside the project's own checkout, `pull <name>` would
          // clone a nested copy at ./<name>. Target this directory instead.
          const here = await inspectLocalGit(runner, process.cwd());
          const dir =
            opts.dir ?? (sameRemote(here.remoteUrl, existing.gitRemote) ? process.cwd() : undefined);
          return pullCommand({
            dryRun: opts.dryRun,
            yes: opts.yes,
            verbose: opts.verbose,
            quiet: opts.quiet,
            project: opts.project,
            dir,
            runner,
          });
        }

        logger.info(`Not pulling — writing a local ${WORKSPACE_CONFIG_NAME} instead.`);
        logger.hint(`Run \`envbeam pull ${opts.project}\` when you want to sync from the registry.`);
      }
    }
    // Not registered yet: fall through and scaffold a new project with this name.
  }

  return runCommand(logger, async () => {
    const cwd = process.cwd();
    const configPath = path.join(cwd, WORKSPACE_CONFIG_NAME);
    if ((await pathExists(configPath)) && !opts.force) {
      // Idempotent: init was already run here. Point to the next steps rather
      // than erroring — Doppler/registry remain the source of truth.
      logger.success(`Already initialized — ${WORKSPACE_CONFIG_NAME} is present.`);
      logger.hint('Run `envbeam doctor` to review, `envbeam push`/`pull` to sync. Use --force to re-scaffold.');
      return 0;
    }

    const detection = await detectWorkspace(cwd);
    const detectedMode = detectedValue(detection, 'container.mode') ?? 'none';
    const detectedRemote = detectedValue(detection, 'git.remote') ?? 'origin';
    const dbField = getField(detection, 'database.provider');
    const hasDb = dbField?.status === 'detected';

    logger.raw(pc.bold('envbeam init'));
    const gitUrl = detectedValue(detection, 'git.url');
    if (gitUrl) {
      logger.sub(pc.dim(`detected git remote ${detectedRemote}: ${gitUrl}`));
    }

    // Auto-detect git identity from remote URL and SSH config
    const detectedGitIdentity = await detectGitIdentity(gitUrl);
    if (detectedGitIdentity) {
      logger.sub(pc.dim(`detected git identity: ${detectedGitIdentity}`));
    }

    const workspace = await prompter.input('Workspace name', opts.project ?? path.basename(cwd));
    const gitIdentity = detectedGitIdentity ?? '';
    const secretsProvider = await prompter.select(
      'Secrets provider',
      [
        { name: 'Doppler', value: 'doppler' },
        { name: '1Password', value: 'onepassword' },
        { name: 'None', value: 'none' },
      ],
      'doppler',
    );

    // The provider is the source of truth for secrets, so sign in on the spot
    // (offers `doppler login` / `op signin`) rather than warning and letting a
    // later `push`/`resume` fail. Interactive setup only — in `--yes`/non-TTY/CI
    // runs we just scaffold the config and never shell out to the provider.
    if (secretsProvider !== 'none' && isInteractive()) {
      const auth = await checkSecretsAuth(secretsProvider, {
        runner,
        logger,
        prompter,
        workspaceRoot: cwd,
        project: secretsProvider === 'doppler' ? workspace : undefined,
        config: 'dev',
      });
      if (auth && !auth.installed) {
        logger.warn(`${auth.tool} CLI not found — install it to use ${secretsProvider}.`);
        logger.hint(auth.installHint);
      } else if (auth && auth.authenticated) {
        logger.sub(pc.dim(`${secretsProvider} signed in`));
      } else if (auth) {
        // Declined the login prompt — config still scaffolds; they can sign in later.
        logger.hint(loginHint(secretsProvider));
      }
    }

    // Ask about secrets sync mode
    let secretsSync: 'pull-only' | 'two-way' = 'pull-only';
    if (secretsProvider !== 'none') {
      const twoWay = await prompter.confirm('Enable two-way secrets sync? (push local changes back)', false);
      secretsSync = twoWay ? 'two-way' : 'pull-only';
    }
    const containerMode = await prompter.select(
      'Container mode',
      [
        { name: 'Dev Container', value: 'devcontainer' },
        { name: 'Docker Compose', value: 'compose' },
        { name: 'None', value: 'none' },
      ],
      detectedMode as 'devcontainer' | 'compose' | 'none',
    );
    const dbMode = await prompter.select(
      'Database mode',
      [
        { name: 'migrations-only (fast, default)', value: 'migrations-only' },
        { name: 'snapshot (carry data)', value: 'snapshot' },
        { name: 'none', value: 'none' },
      ],
      hasDb ? 'migrations-only' : 'none',
    );
    // Simple yes/no for Claude session sync
    const enableSessionSync = await prompter.confirm('Enable Claude session sync?', true);
    const sessionProvider = enableSessionSync ? 'claude-native' : 'none';
    const sessionScope = 'project'; // Default to project scope

    if (enableSessionSync) {
      logger.hint('Run `envbeam storage setup` then `envbeam session setup` to configure.');
    }

    const yaml = renderConfig({
      workspace,
      gitIdentity: gitIdentity.trim() || undefined,
      gitRemote: detectedRemote,
      secretsProvider,
      secretsSync,
      containerMode,
      dbMode,
      dbProvider: hasDb ? String(dbField?.value) : undefined,
      sessionProvider,
      sessionScope,
    });

    // validate before writing
    parseConfig(yaml, configPath);
    await fs.writeFile(configPath, yaml);

    logger.success(`Wrote ${WORKSPACE_CONFIG_NAME}`);

    // Auto-register the project. Opportunistically self-heal storage from
    // Doppler (silent — no extra prompts; the user already signed in above),
    // so a project registers as soon as storage is available.
    if (await ensureStorageReady({ runner, logger, prompter }, { silent: true })) {
      try {
        const store = await createRegistryStore(runner);

        // Check for name conflict
        const existing = await store.getProject(workspace);
        if (existing) {
          logger.warn(`Project "${workspace}" already exists in registry.`);
          logger.hint('Use a different workspace name or run `envbeam delete` first.');
        } else {
          const machineId = await getMachineId();
          const entry: ProjectEntryInput = {
            name: workspace,
            gitRemote: gitUrl ?? '',
            gitBranch: resolveBranch(detection),
            configSnapshot: yaml,
            lastPush: new Date().toISOString(),
            machineId,
          };
          await store.registerProject(entry);
          logger.success(`Registered "${workspace}" in project registry.`);
        }
      } catch (err) {
        // Non-fatal - init succeeded, just warn about registry
        logger.warn(`Could not register project: ${(err as Error).message}`);
      }
    }

    logger.hint('Run `envbeam doctor` to see what was detected and what still needs declaring.');
    return 0;
  });
}

interface RenderArgs {
  workspace: string;
  gitIdentity?: string;
  gitRemote: string;
  secretsProvider: string;
  secretsSync: 'pull-only' | 'two-way';
  containerMode: string;
  dbMode: string;
  dbProvider?: string;
  sessionProvider: string;
  sessionScope: string;
}

function renderConfig(a: RenderArgs): string {
  const lines: string[] = [];
  lines.push('# envbeam workspace config. Committed to git — contains NO secrets, only references.');
  lines.push('# Most fields are optional and auto-detected; run `envbeam doctor` to see detection.');
  lines.push('# Schema: https://envbeam.dev/schema/envbeam.schema.json');
  lines.push('version: 1');
  lines.push(`workspace: ${a.workspace}`);
  lines.push('');

  lines.push('git:');
  if (a.gitIdentity) lines.push(`  identity: ${a.gitIdentity}   # named identity from ~/.envbeam/config.yaml`);
  else lines.push('  # identity: github:work   # set a named identity (see `envbeam identity add`)');
  lines.push(`  remote: ${a.gitRemote}`);
  lines.push('  branch: current          # follow the checked-out branch');
  lines.push('');

  if (a.secretsProvider !== 'none') {
    lines.push('secrets:');
    lines.push(`  provider: ${a.secretsProvider}`);
    if (a.secretsProvider === 'doppler') {
      lines.push('  # identity: doppler:keeper   # add via `envbeam identity add doppler:keeper`');
      lines.push('  project: ' + a.workspace + '          # Doppler project (no secret values here)');
      lines.push('  config: dev');
    } else {
      lines.push('  # identity: onepassword:personal   # add via `envbeam identity add`');
      lines.push('  vault: Private');
      lines.push('  item: ' + a.workspace + '-env       # 1Password item whose fields are the env vars');
    }
    lines.push('  output: dotenv             # dotenv | run-wrapper');
    lines.push(`  sync: ${a.secretsSync}            # pull-only | two-way`);
    lines.push('');
  }

  if (a.containerMode !== 'none') {
    lines.push('container:');
    lines.push(`  mode: ${a.containerMode}`);
    lines.push('  upOnResume: true');
    lines.push('  stopOnPause: false');
    lines.push('');
  }

  if (a.dbMode !== 'none') {
    lines.push('database:');
    if (a.dbProvider) lines.push(`  provider: ${a.dbProvider}        # detected; remove to re-detect`);
    else lines.push('  # provider: postgres      # auto-detected from compose if present');
    lines.push(`  mode: ${a.dbMode}`);
    lines.push('  migrate: true              # apply pending migrations on resume');
    lines.push('  # migrateCommand: "..."    # auto-detected per stack');
    if (a.dbMode === 'snapshot') {
      lines.push('  restore: prompt            # prompt | auto | off');
      lines.push('  snapshot:');
      lines.push('    dataOnly: true');
      lines.push('    compress: true');
      lines.push('  sync:');
      lines.push('    target: local-folder     # local-folder | syncthing | s3');
      lines.push('    path: ~/envbeam-snapshots');
      lines.push('    keep: 5');
      lines.push('    maxSizeMB: 500');
    }
    lines.push('');
  }

  if (a.sessionProvider !== 'none') {
    lines.push('session:');
    lines.push(`  provider: ${a.sessionProvider}`);
    lines.push(`  scope: ${a.sessionScope}          # project | workspace | global`);
    if (a.sessionProvider === 'claude-native') {
      lines.push('  sync:');
      lines.push('    target: s3               # uses global storage from `envbeam storage setup`');
      lines.push('    encrypt: age             # encryption via age (keys in Doppler)');
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
