import pc from 'picocolors';
import type { RunContext } from './context.js';
import { resolveActiveProviders } from './providers.js';
import { createSyncTarget } from '../sync/index.js';
import type { GitStatus, SecretsStatus, ContainerStatus, DbStatus, SessionStatus } from '../providers/types.js';

export interface StatusReport {
  workspace: string;
  identity?: string;
  git?: GitStatus;
  secrets?: SecretsStatus;
  container?: ContainerStatus;
  database?: DbStatus & { latestSnapshot?: string };
  session?: SessionStatus;
}

/** Read-only "what would resume/pause do" view (PRD §6 status). */
export async function runStatus(ctx: RunContext): Promise<StatusReport> {
  const active = resolveActiveProviders(ctx);
  const report: StatusReport = {
    workspace: ctx.config.workspace,
    identity: ctx.identities.git?.name,
  };

  report.git = await safe(() => active.git.status(ctx.providerCtx('git')));
  if (active.secrets) report.secrets = await safe(() => active.secrets!.status(ctx.providerCtx('secrets')));
  if (active.container)
    report.container = await safe(() => active.container!.status(ctx.providerCtx('container')));
  if (active.database && ctx.config.database) {
    const dctx = ctx.providerCtx('database');
    const base = await safe(() => active.database!.status(dctx));
    let latestSnapshot: string | undefined;
    if (ctx.config.database.sync) {
      try {
        const target = createSyncTarget(ctx.config.database.sync, ctx.identities.sync);
        const entries = await target.list(dctx, ctx.config.workspace);
        latestSnapshot = entries[0]?.timestamp;
      } catch {
        /* ignore */
      }
    }
    report.database = base ? { ...base, latestSnapshot } : undefined;
  }
  if (active.session) report.session = await safe(() => active.session!.status(ctx.providerCtx('session')));

  return report;
}

export function printStatus(ctx: RunContext, report: StatusReport): void {
  const log = ctx.logger;
  log.raw(pc.bold(`Workspace: ${report.workspace}`) + (report.identity ? pc.dim(`  (${report.identity})`) : ''));
  if (ctx.identityWarnings.length) {
    log.raw(`  ${pc.yellow('!')} unresolved identities: ${ctx.identityWarnings.join(', ')}`);
  }

  if (report.git) {
    const g = report.git;
    const dirty = g.dirtyFiles.length ? pc.yellow(`${g.dirtyFiles.length} dirty`) : pc.green('clean');
    const sync =
      g.ahead || g.behind
        ? pc.yellow(`↑${g.ahead} ↓${g.behind}`)
        : g.hasUpstream
          ? pc.green('in sync')
          : pc.dim('no upstream');
    log.raw(`  git       ${g.branch}  ${dirty}  ${sync}`);
  }
  if (report.secrets) {
    const s = report.secrets;
    log.raw(`  secrets   ${s.present ? pc.green(`${s.count} present`) : pc.yellow('not materialized')}`);
  }
  if (report.container) {
    const c = report.container;
    log.raw(`  container ${c.running ? pc.green('running') : pc.yellow('stopped')}`);
  }
  if (report.database) {
    const d = report.database;
    const reach = d.reachable ? pc.green('reachable') : pc.yellow('unreachable');
    const snap = d.latestSnapshot ? pc.dim(`  snapshot@${d.latestSnapshot}`) : '';
    log.raw(`  database  ${reach}${snap}`);
  }
  if (report.session) {
    const s = report.session;
    log.raw(`  session   ${s.available ? pc.green('ready') : pc.yellow('unavailable')}  ${pc.dim(s.detail ?? '')}`);
  }
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
