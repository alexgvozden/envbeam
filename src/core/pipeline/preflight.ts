import type { RunContext } from './context.js';
import { resolveActiveProviders } from './providers.js';
import type { BaseProvider, ProviderContext, ProviderKind, ToolRequirement } from '../providers/types.js';
import { syncTargetTools, requiredCryptoTools, createSyncTarget } from '../sync/index.js';
import { PreflightError } from '../util/errors.js';
import { ensureSecretsAuth, ensureSecretsProject, loginHint } from '../providers/secretsAuth.js';

/**
 * Ensure the active secrets provider is usable BEFORE the pipeline mutates
 * anything (e.g. git push). Delegates to the shared {@link ensureSecretsAuth},
 * which offers to run `doppler login` / `op signin` on the spot (honouring a
 * resolved token identity too) — so `init`, `push`, and `resume` behave
 * identically. No-op when no secrets provider is configured. Throws
 * {@link PreflightError} only when the CLI is missing, or the user declined /
 * login failed and it's still unauthenticated.
 */
export async function assertSecretsAuth(ctx: RunContext): Promise<void> {
  const probe = await ensureSecretsAuth(ctx.providerCtx('secrets'), { offerLogin: true });
  if (!probe) return;
  if (!probe.installed) {
    throw new PreflightError(
      `${probe.tool} is required for the "${probe.provider}" secrets provider but was not found.`,
      probe.installHint,
    );
  }
  if (!probe.authenticated) {
    throw new PreflightError(
      `Not authenticated with ${probe.provider}${probe.detail ? ` — ${probe.detail}` : ''}.`,
      loginHint(probe.provider),
    );
  }
  // Authenticated — make sure the backing project/config actually exists
  // (offers to create it interactively) before the pipeline uploads/pulls.
  const ready = await ensureSecretsProject(ctx.providerCtx('secrets'));
  if (ready && !ready.ready) {
    throw new PreflightError(
      `${probe.provider} not ready — ${ready.detail ?? 'backing project/config missing'}.`,
      ready.hint ?? loginHint(probe.provider),
    );
  }
}

export interface ToolCheck {
  command: string;
  concern: string;
  present: boolean;
  version?: string;
  authChecked: boolean;
  authOk?: boolean;
  authDetail?: string;
  installHint: string;
}

export interface SyncCheck {
  target: string;
  ok: boolean;
  detail?: string;
}

export interface PreflightReport {
  checks: ToolCheck[];
  syncCheck?: SyncCheck;
  ok: boolean;
}

interface ProviderEntry {
  concern: ProviderKind;
  provider: BaseProvider;
  pctx: ProviderContext;
}

function gather(ctx: RunContext): ProviderEntry[] {
  const active = resolveActiveProviders(ctx);
  const entries: ProviderEntry[] = [];
  const add = (concern: ProviderKind, provider?: BaseProvider) => {
    if (provider) entries.push({ concern, provider, pctx: ctx.providerCtx(concern) });
  };
  add('git', active.git);
  add('secrets', active.secrets);
  add('container', active.container);
  add('database', active.database);
  add('session', active.session);
  return entries;
}

/** Run doctor-style checks for every tool the active providers need (PRD §8/§9). */
export async function runPreflight(
  ctx: RunContext,
  opts: { auth?: boolean; skipAuthFor?: ProviderKind[] } = {},
): Promise<PreflightReport> {
  const checks: ToolCheck[] = [];
  const seen = new Set<string>();
  const skipAuth = new Set(opts.skipAuthFor ?? []);

  for (const entry of gather(ctx)) {
    const reqs = entry.provider.requiredTools(entry.pctx);
    for (const req of reqs) {
      const key = `${req.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Some concerns (e.g. database connectivity) can't be checked yet on
      // resume — secrets aren't materialized and the container isn't up. Skip
      // their auth probe; presence is still verified.
      const doAuth = (opts.auth ?? true) && !skipAuth.has(entry.concern);
      checks.push(await checkTool(ctx, entry.concern, entry.pctx, req, doAuth));
    }
  }

  // sync target + crypto tools (database concern)
  const sync = ctx.config.database?.sync;
  let syncCheck: SyncCheck | undefined;
  if (sync) {
    const dbPctx = ctx.providerCtx('database');
    for (const cmd of [...syncTargetTools(sync), ...requiredCryptoTools(sync)]) {
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      checks.push(
        await checkTool(
          ctx,
          'database',
          dbPctx,
          { command: cmd, versionArgs: ['--version'], installHint: `Install ${cmd}.` },
          false,
        ),
      );
    }

    // Verify sync target connectivity
    if (opts.auth) {
      try {
        const target = createSyncTarget(sync, ctx.identities.sync);
        const status = await target.verify(dbPctx);
        syncCheck = { target: sync.target, ok: status.ok, detail: status.detail };
      } catch (e) {
        syncCheck = { target: sync.target, ok: false, detail: (e as Error).message };
      }
    }
  }

  const toolsOk = checks.every((c) => c.present && (c.authChecked ? c.authOk !== false : true));
  const syncOk = syncCheck ? syncCheck.ok : true;
  return { checks, syncCheck, ok: toolsOk && syncOk };
}

async function checkTool(
  ctx: RunContext,
  concern: string,
  pctx: ProviderContext,
  req: ToolRequirement,
  doAuth: boolean,
): Promise<ToolCheck> {
  const resolved = await ctx.runner.which(req.command);
  const present = resolved != null;
  let version: string | undefined;
  if (present && req.versionArgs) {
    const res = await ctx.runner.run(req.command, req.versionArgs, { allowFailure: true });
    if (res.code === 0) version = res.stdout.trim().split(/\r?\n/)[0];
  }
  const check: ToolCheck = {
    command: req.command,
    concern,
    present,
    version,
    authChecked: false,
    installHint: req.installHint,
  };
  if (present && doAuth && req.authCheck) {
    try {
      const r = await req.authCheck(pctx);
      check.authChecked = true;
      check.authOk = r.ok;
      check.authDetail = r.detail;
    } catch (e) {
      check.authChecked = true;
      check.authOk = false;
      check.authDetail = (e as Error).message;
    }
  }
  return check;
}
