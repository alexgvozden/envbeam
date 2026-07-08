import type { CommandRunner } from '../util/exec.js';
import type { Logger } from '../util/logger.js';
import type { Prompter } from '../util/prompt.js';
import type { ProviderContext, SecretsProvider, SecretsReadyResult } from './types.js';
import type { WorkspaceConfig } from '../config/schema.js';
import { dopplerProviderFactory } from './secrets/doppler.js';
import { onePasswordProviderFactory } from './secrets/onepassword.js';
import type { ProviderFactory } from './registry.js';

export interface SecretsAuthResult {
  provider: string;
  /** The CLI the provider shells out to (e.g. `doppler`, `op`). */
  tool: string;
  installed: boolean;
  authenticated: boolean;
  installHint: string;
  /** Human-readable reason when not authenticated. */
  detail?: string;
}

const FACTORIES: Record<string, ProviderFactory<SecretsProvider>> = {
  doppler: dopplerProviderFactory,
  onepassword: onePasswordProviderFactory,
};

/** Interactive login command per provider (browser / desktop-app auth). */
const LOGIN_COMMANDS: Record<string, { command: string; args: string[] }> = {
  doppler: { command: 'doppler', args: ['login'] },
  onepassword: { command: 'op', args: ['signin'] },
};

/** True only on a real interactive terminal — never in CI, pipes, or tests. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Actionable next step when a secrets provider CLI isn't authenticated. */
export function loginHint(provider: string): string {
  if (provider === 'doppler')
    return 'Run `doppler login` (or add a token identity via `envbeam identity add doppler:<name> --token …`), then re-run.';
  if (provider === 'onepassword')
    return 'Run `op signin` (or set a service-account token identity via `envbeam identity add`), then re-run.';
  return 'Authenticate the secrets provider, then re-run.';
}

/**
 * Single source of truth for "is the secrets provider usable?". Resolves the
 * provider from `ctx.config.secrets.provider` and runs its own `requiredTools`
 * auth probe against the supplied context — so a resolved token identity on the
 * context is honoured. Returns null when there's nothing to check (no provider
 * configured, or one without an auth probe). Every entry point (`init`,
 * `push`/`pause`, `resume`/`pull`) funnels through this so they can't drift.
 */
export async function probeSecretsAuth(ctx: ProviderContext): Promise<SecretsAuthResult | null> {
  const provider = ctx.config.secrets?.provider;
  if (!provider) return null;
  const factory = FACTORIES[provider];
  if (!factory) return null;
  const req = factory.create().requiredTools(ctx)[0];
  if (!req) return null;

  const installed = (await ctx.runner.which(req.command)) != null;
  if (!installed) {
    return { provider, tool: req.command, installed: false, authenticated: false, installHint: req.installHint };
  }

  let authenticated = true;
  let detail: string | undefined;
  if (req.authCheck) {
    try {
      const r = await req.authCheck(ctx);
      authenticated = r.ok;
      detail = r.detail;
    } catch (e) {
      authenticated = false;
      detail = (e as Error).message;
    }
  }
  return { provider, tool: req.command, installed: true, authenticated, installHint: req.installHint, detail };
}

/**
 * Probe auth and, if the provider isn't signed in, offer to run its login
 * command right now (`doppler login` / `op signin`) via inherited stdio so the
 * browser/desktop flow works. Re-probes afterwards and returns the final state.
 * The login offer only fires on a real terminal (never CI/pipes/tests) and when
 * the CLI is actually installed. Shared by `init` and the pipeline gate so the
 * "sign in now?" experience is identical everywhere.
 */
export async function ensureSecretsAuth(
  ctx: ProviderContext,
  opts: { offerLogin?: boolean } = {},
): Promise<SecretsAuthResult | null> {
  let probe = await probeSecretsAuth(ctx);
  if (!probe || probe.authenticated) return probe;

  const login = LOGIN_COMMANDS[probe.provider];
  if (opts.offerLogin && probe.installed && login && isInteractive()) {
    const yes = await ctx.prompter.confirm(`Not signed in to ${probe.provider}. Log in now?`, true);
    if (yes) {
      ctx.logger.info(`Running \`${login.command} ${login.args.join(' ')}\`…`);
      const res = await ctx.runner.run(login.command, login.args, { inherit: true, allowFailure: true });
      if (res.code !== 0) {
        ctx.logger.warn(`\`${login.command} ${login.args.join(' ')}\` exited with code ${res.code}.`);
      }
      probe = (await probeSecretsAuth(ctx)) ?? probe;
    }
  }
  return probe;
}

/**
 * Verify (and, interactively, provision) the provider's backing project/config
 * by delegating to the provider's own `ensureReady`. Returns null when the
 * provider has no such concept (e.g. 1Password) or none is configured.
 */
export async function ensureSecretsProject(ctx: ProviderContext): Promise<SecretsReadyResult | null> {
  const provider = ctx.config.secrets?.provider;
  const instance = provider ? FACTORIES[provider]?.create() : undefined;
  if (!instance?.ensureReady) return null;
  return instance.ensureReady(ctx);
}

export interface SecretsAuthDeps {
  runner: CommandRunner;
  logger: Logger;
  prompter: Prompter;
  workspaceRoot: string;
  /** Backing project/config to verify + offer to create (e.g. Doppler project). */
  project?: string;
  config?: string;
}

/**
 * `init`-time convenience over {@link ensureSecretsAuth}: for a provider the
 * user just picked (before any config/identity exists), probe auth and offer to
 * log in on the spot, then verify/create its backing project. Returns null for
 * providers with nothing to check.
 */
export async function checkSecretsAuth(
  provider: string,
  deps: SecretsAuthDeps,
): Promise<SecretsAuthResult | null> {
  if (!FACTORIES[provider]) return null;
  const ctx: ProviderContext = {
    workspaceRoot: deps.workspaceRoot,
    runner: deps.runner,
    logger: deps.logger,
    prompter: deps.prompter,
    dryRun: false,
    config: {
      version: 1,
      workspace: deps.project ?? 'preflight',
      secrets: { provider, project: deps.project, config: deps.config ?? 'dev' },
    } as WorkspaceConfig,
    env: {},
  };
  const auth = await ensureSecretsAuth(ctx, { offerLogin: true });
  // Only provision the project once we know we can talk to the provider.
  if (auth?.installed && auth.authenticated) {
    const ready = await ensureSecretsProject(ctx);
    if (ready?.ready && !ready.created && ready.detail) {
      // Provider is the source of truth; surface that we're reusing it.
      deps.logger.sub(`${ready.detail} — reusing it (source of truth for secrets).`);
    } else if (ready && !ready.ready && ready.hint) {
      deps.logger.hint(ready.hint);
    }
  }
  return auth;
}
