import type { RunContext } from './context.js';
import { resolveActiveProviders } from './providers.js';
import type { BaseProvider, ProviderContext, ProviderKind, ToolRequirement } from '../providers/types.js';
import { syncTargetTools, requiredCryptoTools } from '../sync/index.js';

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

export interface PreflightReport {
  checks: ToolCheck[];
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
export async function runPreflight(ctx: RunContext, opts: { auth?: boolean } = {}): Promise<PreflightReport> {
  const checks: ToolCheck[] = [];
  const seen = new Set<string>();

  for (const entry of gather(ctx)) {
    const reqs = entry.provider.requiredTools(entry.pctx);
    for (const req of reqs) {
      const key = `${req.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push(await checkTool(ctx, entry.concern, entry.pctx, req, opts.auth ?? true));
    }
  }

  // sync target + crypto tools (database concern)
  const sync = ctx.config.database?.sync;
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
  }

  const ok = checks.every((c) => c.present && (c.authChecked ? c.authOk !== false : true));
  return { checks, ok };
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
