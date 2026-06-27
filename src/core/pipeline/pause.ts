import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import type { RunContext } from './context.js';
import { resolveActiveProviders } from './providers.js';
import { machineName } from '../providers/database/base.js';
import { loadState, patchState } from '../state.js';
import {
  createSyncTarget,
  encryptionSuffix,
  encryptFile,
  formatTimestamp,
  snapshotName,
} from '../sync/index.js';
import { PreflightError } from '../util/errors.js';
import type { GitPushResult, SnapshotOptions } from '../providers/types.js';

export interface PauseOptions {
  force: boolean;
  /** true = force a snapshot, false = skip, undefined = auto (change-detection). */
  snapshot?: boolean;
  workMode: 'commit' | 'stash' | 'none';
  message?: string;
}

export interface PauseReport {
  git?: GitPushResult & { branch: string };
  database?: {
    snapshot?: { timestamp: string; file: string; sizeBytes: number };
    skipped?: string;
    migrationsOnly: boolean;
  };
  session?: { action: string; detail?: string };
  container?: { stopped: boolean };
}

/** Pause pipeline (PRD §7): flush local state outward so another machine resumes. */
export async function runPause(ctx: RunContext, opts: PauseOptions): Promise<PauseReport> {
  const log = ctx.logger;
  log.resetSteps();
  if (ctx.identityWarnings.length && !ctx.dryRun) {
    throw new PreflightError(
      `Unknown identity reference(s): ${ctx.identityWarnings.join(', ')}.`,
      'Define them with `envbeam identity add <name>` or fix the names in .envbeam.yaml.',
    );
  }
  const active = resolveActiveProviders(ctx);
  const report: PauseReport = {};

  // 1. Git
  log.step('Git');
  const gctx = ctx.providerCtx('git');
  const status = await active.git.status(gctx);
  if (status.dirtyFiles.length) {
    log.sub(pc.yellow(`${status.dirtyFiles.length} uncommitted file(s)`));
    for (const f of status.dirtyFiles.slice(0, 10)) log.sub(pc.dim(`  ${f}`));
  }
  if (status.ahead) log.sub(`${status.ahead} unpushed commit(s) on ${status.branch}`);
  const push = await active.git.pushWork(gctx, {
    workMode: opts.workMode,
    message: opts.message,
    force: opts.force,
  });
  report.git = { ...push, branch: status.branch };
  if (push.committed) log.sub('committed working changes');
  if (push.stashed) log.sub('stashed working changes');
  log.sub(push.pushed ? push.detail ?? 'pushed' : push.detail ?? 'not pushed');

  // 2. Database
  if (ctx.config.database) {
    log.step('Database');
    report.database = await pauseDatabase(ctx, active, opts);
  }

  // 3. Session
  if (active.session) {
    log.step('Session');
    const res = await active.session.push(ctx.providerCtx('session'));
    report.session = { action: res.action, detail: res.detail };
    log.sub(res.detail ?? res.action);
  }

  // 4. Secrets — no push by default (source of truth is the provider)
  if (active.secrets) {
    log.step('Secrets');
    log.sub('not pushed (source of truth is your secrets provider)');
  }

  // 5. Container — optionally stop
  if (active.container && ctx.config.container?.stopOnPause) {
    log.step('Container');
    await active.container.down(ctx.providerCtx('container'));
    report.container = { stopped: true };
    log.sub(ctx.dryRun ? 'would stop container' : 'container stopped');
  }

  // 6. Report
  printPauseReport(ctx, report);
  return report;
}

async function pauseDatabase(
  ctx: RunContext,
  active: ReturnType<typeof resolveActiveProviders>,
  opts: PauseOptions,
): Promise<NonNullable<PauseReport['database']>> {
  const log = ctx.logger;
  const db = ctx.config.database!;
  const out: NonNullable<PauseReport['database']> = { migrationsOnly: db.mode !== 'snapshot' };

  if (!active.database) {
    log.sub('migrations-only (no database provider active; nothing to snapshot)');
    return out;
  }
  if (!db.sync) {
    log.sub('migrations-only (no sync target configured)');
    return out;
  }

  const dctx = ctx.providerCtx('database');
  let take = opts.snapshot === true;

  if (opts.snapshot === undefined && db.mode === 'snapshot') {
    // change-detection path
    const state = await loadState(ctx.workspaceRoot);
    const change = await active.database.hasChanged(dctx, state.dbFingerprint);
    if (change.fingerprint) await patchState(ctx.workspaceRoot, { dbFingerprint: change.fingerprint });
    if (state.dbFingerprint == null) {
      log.sub('change-detection baseline recorded; no snapshot this run');
    } else if (change.changed) {
      log.sub(pc.yellow(change.detail ?? 'tracked tables changed'));
      take = ctx.dryRun
        ? false
        : await ctx.prompter.confirm('Take a DB snapshot to carry the changed data?', true);
    } else {
      log.sub(change.detail ?? 'no tracked changes');
    }
  }

  if (opts.snapshot === false) {
    log.sub('snapshot skipped (--no-snapshot)');
    out.skipped = 'forced skip';
    return out;
  }
  if (!take) {
    out.skipped = out.migrationsOnly ? 'migrations-only' : 'no changes';
    return out;
  }

  // produce snapshot
  const timestamp = formatTimestamp(new Date());
  const machine = machineName();
  const snapOpts: SnapshotOptions = {
    dataOnly: db.snapshot?.dataOnly ?? true,
    compress: db.snapshot?.compress ?? true,
    includeTables: db.snapshot?.tables?.include ?? [],
    excludeTables: db.snapshot?.tables?.exclude ?? [],
    machine,
    timestamp,
  };
  const result = await active.database.snapshot(dctx, snapOpts);
  const sizeMB = result.sizeBytes / (1024 * 1024);
  const cap = db.sync.maxSizeMB ?? 500;
  if (sizeMB > cap) {
    log.warn(`snapshot is ${sizeMB.toFixed(1)}MB, above the ${cap}MB cap — skipping upload.`);
    out.skipped = `over size cap (${sizeMB.toFixed(1)}MB > ${cap}MB)`;
    if (!ctx.dryRun) await fs.rm(result.file, { force: true }).catch(() => undefined);
    return out;
  }

  if (ctx.dryRun) {
    log.sub(`would upload snapshot ${path.basename(result.file)} (${sizeMB.toFixed(1)}MB)`);
    out.snapshot = { timestamp, file: path.basename(result.file), sizeBytes: result.sizeBytes };
    return out;
  }

  // optional encryption
  const target = createSyncTarget(db.sync, ctx.identities.sync);
  const suffix = encryptionSuffix(db.sync);
  let uploadFile = result.file;
  let uploadName = path.basename(result.file);
  if (suffix) {
    uploadFile = result.file + suffix;
    uploadName += suffix;
    await encryptFile(dctx, db.sync, result.file, uploadFile);
  }

  const entry = await target.put(dctx, uploadFile, uploadName);
  const pruned = await target.prune(dctx, ctx.config.workspace, db.sync.keep ?? 5);
  if (pruned.length) log.sub(`pruned ${pruned.length} old snapshot(s)`);

  // record + cleanup local artifacts
  await patchState(ctx.workspaceRoot, { lastSnapshotTimestamp: timestamp });
  await fs.rm(result.file, { force: true }).catch(() => undefined);
  if (suffix) await fs.rm(uploadFile, { force: true }).catch(() => undefined);

  out.snapshot = { timestamp, file: entry.name, sizeBytes: result.sizeBytes };
  log.sub(`snapshot pushed → ${entry.name} (${sizeMB.toFixed(1)}MB)`);
  return out;
}

function printPauseReport(ctx: RunContext, report: PauseReport): void {
  const log = ctx.logger;
  log.step('Report');
  const lines: string[] = [];
  if (report.git) {
    const bits = [
      report.git.committed ? 'committed' : null,
      report.git.stashed ? 'stashed' : null,
      report.git.pushed ? 'pushed' : 'not pushed',
    ].filter(Boolean);
    lines.push(`git:       ${report.git.branch} — ${bits.join(', ')}`);
  }
  if (report.database) {
    lines.push(
      report.database.snapshot
        ? `database:  snapshot ${report.database.snapshot.timestamp} pushed`
        : `database:  ${report.database.skipped ?? 'migrations-only'} (no snapshot)`,
    );
  }
  if (report.session) lines.push(`session:   ${report.session.action}`);
  if (report.container?.stopped) lines.push('container: stopped');
  for (const l of lines) log.raw('    ' + l);
  log.success(ctx.dryRun ? 'pause dry-run complete' : 'Safe to switch machines.');
}
