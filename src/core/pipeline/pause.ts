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
  ensureAgeKeys,
  formatTimestamp,
  snapshotName,
} from '../sync/index.js';
import { PreflightError } from '../util/errors.js';
import { assertSecretsAuth } from './preflight.js';
import { detectedValue, resolveBranch } from '../detect/types.js';
import { ensureTools } from '../util/tools.js';
import { stripUrlCreds } from '../util/redact.js';
import { sessionSummary } from './format.js';
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
  secrets?: { action: string; count: number; detail?: string };
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

  // Preflight: if two-way secrets sync will push to the provider, make sure we
  // can authenticate BEFORE touching git — otherwise git pushes and the run
  // dies at the secrets step, leaving a half-applied checkpoint.
  const willPushSecrets =
    !!active.secrets && (ctx.config.secrets?.sync ?? 'pull-only') === 'two-way' && !!active.secrets.push;
  if (willPushSecrets && !ctx.dryRun) {
    await assertSecretsAuth(ctx);
  }

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

  // 3. Session — best-effort: a session-sync failure must never abort the
  // push (git is already pushed by now; the checkpoint should still complete).
  if (active.session) {
    log.step('Session');
    try {
      const res = await active.session.push(ctx.providerCtx('session'));
      report.session = { action: res.action, detail: res.detail };
      log.sub(res.detail ?? res.action);
    } catch (e) {
      report.session = { action: 'noop', detail: `session push failed: ${(e as Error).message}` };
      log.warn(`session push failed (continuing): ${(e as Error).message}`);
    }
  }

  // 4. Secrets — push if two-way sync is enabled
  if (active.secrets) {
    log.step('Secrets');
    const syncMode = ctx.config.secrets?.sync ?? 'pull-only';
    if (syncMode === 'two-way' && active.secrets.push) {
      const pushRes = await active.secrets.push(ctx.providerCtx('secrets'));
      report.secrets = { action: pushRes.action, count: pushRes.count, detail: pushRes.detail };
      if (pushRes.action === 'uploaded') {
        log.sub(pushRes.detail ?? `pushed ${pushRes.count} secret(s)`);
      } else {
        log.sub(pushRes.detail ?? pushRes.action);
      }
    } else {
      report.secrets = { action: 'skipped', count: 0, detail: 'pull-only mode' };
      log.sub('not pushed (sync: pull-only — provider is source of truth)');
    }

    // Record git remote + branch into the provider so it alone says what to
    // clone (visible in Doppler; never materialized into .env). Best-effort.
    if (active.secrets.recordMeta && !ctx.dryRun) {
      // Strip any embedded token from the remote before recording it (it must
      // not sit in `doppler secrets set` argv, visible via `ps`).
      const gitRemote = stripUrlCreds(detectedValue(ctx.detection, 'git.url') ?? '');
      const gitBranch = resolveBranch(ctx.detection, ctx.config.git?.branch);
      const meta = await active.secrets.recordMeta(ctx.providerCtx('secrets'), {
        ENVBEAM_GIT_REMOTE: gitRemote ?? '',
        ENVBEAM_GIT_BRANCH: gitBranch,
      });
      if (meta.ok) log.sub(pc.dim(`recorded git remote + branch (${gitBranch}) in ${ctx.config.secrets?.provider}`));
    }
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

/** Whether any snapshot for this workspace already exists on the sync target. */
async function hasRemoteSnapshot(ctx: RunContext, dctx: ReturnType<RunContext['providerCtx']>): Promise<boolean> {
  const sync = ctx.config.database?.sync;
  if (!sync) return false;
  try {
    const target = createSyncTarget(sync, ctx.identities.sync);
    const entries = await target.list(dctx, ctx.config.workspace);
    return entries.length > 0;
  } catch {
    return false; // can't list → assume none; safer to back up than to skip
  }
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
  let skipReason = out.migrationsOnly ? 'migrations-only (schema carried by migrations)' : 'no data changes';

  // Snapshotting needs the DB client tools (pg_dump/psql, mysqldump/mysql).
  // Per project rule, install them for the user rather than telling them to.
  if (opts.snapshot !== false && (db.mode === 'snapshot' || opts.snapshot === true)) {
    const missing: string[] = [];
    for (const req of active.database.requiredTools(dctx)) {
      if (!(await ctx.runner.which(req.command))) missing.push(req.command);
    }
    if (missing.length) {
      if (ctx.dryRun) {
        log.sub(pc.yellow(`snapshot needs ${missing.join(', ')} — would offer to install them`));
        out.skipped = `client tools missing: ${missing.join(', ')}`;
        return out;
      }
      log.sub(`snapshot needs ${missing.join(', ')} — installing`);
      const res = await ensureTools(missing, ctx.runner, ctx.logger, ctx.prompter);
      if (!res.allInstalled) {
        log.sub(pc.yellow(`skipping snapshot — could not install: ${res.missing.join(', ')}`));
        out.skipped = `client tools unavailable: ${res.missing.join(', ')}`;
        return out;
      }
    }
    if (active.database.connectionSummary) {
      log.sub(pc.dim(`connecting to ${active.database.connectionSummary(dctx)}`));
    }
    const ambiguous = active.database.ambiguityWarning?.(dctx);
    if (ambiguous) log.warn(ambiguous);
  }

  if (opts.snapshot === undefined && db.mode === 'snapshot') {
    // change-detection path
    const state = await loadState(ctx.workspaceRoot);
    const change = await active.database.hasChanged(dctx, state.dbFingerprint);
    if (change.fingerprint) await patchState(ctx.workspaceRoot, { dbFingerprint: change.fingerprint });
    if (state.dbFingerprint == null) {
      // First push. If we couldn't read the DB, be honest — no baseline taken.
      if (!change.fingerprint) {
        log.sub(pc.yellow(`skipping snapshot — ${change.detail}`));
        skipReason = change.detail ?? 'database not readable';
      } else {
        // If nothing has ever been backed up to the sync target, take an
        // initial snapshot so the data exists remotely; otherwise the data is
        // already there (e.g. fresh clone / another machine), so just baseline.
        const backedUp = await hasRemoteSnapshot(ctx, dctx);
        if (backedUp) {
          log.sub(`recorded change-detection baseline (${change.detail})`);
          log.sub(pc.dim('  future pushes snapshot only when data changes; run `envbeam push --snapshot` to force one'));
          skipReason = 'baseline recorded (already backed up remotely)';
        } else {
          log.sub(`first push, nothing backed up yet — taking an initial snapshot (${change.detail})`);
          take = !ctx.dryRun;
          if (ctx.dryRun) skipReason = 'would take initial snapshot';
        }
      }
    } else if (change.changed) {
      log.sub(pc.yellow(change.detail ?? 'tracked tables changed since last push'));
      take = ctx.dryRun
        ? false
        : await ctx.prompter.confirm('Take a DB snapshot to carry the changed data?', true);
      if (!take) skipReason = 'changes detected but snapshot declined';
    } else {
      log.sub(change.detail ?? 'no tracked data changes since last push');
    }
  }

  if (opts.snapshot === false) {
    log.sub('snapshot skipped (--no-snapshot)');
    out.skipped = 'skipped (--no-snapshot)';
    return out;
  }
  if (!take) {
    out.skipped = skipReason;
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

  // Encrypt at rest. Snapshots carry the whole database, so — like sessions —
  // default to age encryption when keys are available (secure by default);
  // honor an explicit sync.encrypt otherwise.
  const target = createSyncTarget(db.sync, ctx.identities.sync);
  let cryptoCfg = db.sync;
  if (!cryptoCfg.encrypt || cryptoCfg.encrypt === 'none') {
    const keys = await ensureAgeKeys(dctx);
    if (keys.pub) cryptoCfg = { ...cryptoCfg, encrypt: 'age' };
  } else if (cryptoCfg.encrypt === 'age') {
    await ensureAgeKeys(dctx);
  }

  const suffix = encryptionSuffix(cryptoCfg);
  let uploadFile = result.file;
  let uploadName = path.basename(result.file);
  let encryptedFile: string | null = null;
  // The plaintext dump (and any encrypted copy) must never survive an error —
  // wrap encrypt+upload so a failure can't leave a full DB dump in the temp dir.
  try {
    if (suffix) {
      const tool = cryptoCfg.encrypt === 'gpg' ? 'gpg' : 'age';
      const t = await ensureTools([tool], dctx.runner, dctx.logger, dctx.prompter);
      if (t.allInstalled) {
        uploadFile = result.file + suffix;
        uploadName += suffix;
        encryptedFile = uploadFile;
        await encryptFile(dctx, cryptoCfg, result.file, uploadFile);
        log.sub(`snapshot encrypted (${cryptoCfg.encrypt})`);
      } else {
        log.warn(`${tool} unavailable — snapshot stored UNENCRYPTED`);
      }
    } else {
      log.warn('snapshot stored UNENCRYPTED — run `envbeam session setup` to generate age keys for at-rest encryption');
    }

    const entry = await target.put(dctx, uploadFile, uploadName);
    const pruned = await target.prune(dctx, ctx.config.workspace, db.sync.keep ?? 5);
    if (pruned.length) log.sub(`pruned ${pruned.length} old snapshot(s)`);

    await patchState(ctx.workspaceRoot, { lastSnapshotTimestamp: timestamp });
    out.snapshot = { timestamp, file: entry.name, sizeBytes: result.sizeBytes };
    log.sub(`snapshot pushed → ${entry.name} (${sizeMB.toFixed(1)}MB)`);
    return out;
  } finally {
    await fs.rm(result.file, { force: true }).catch(() => undefined);
    if (encryptedFile) await fs.rm(encryptedFile, { force: true }).catch(() => undefined);
  }
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
        ? `database:  snapshot ${report.database.snapshot.timestamp} uploaded`
        : `database:  no snapshot — ${report.database.skipped ?? 'migrations-only'}`,
    );
  }
  if (report.secrets) {
    lines.push(
      report.secrets.action === 'uploaded'
        ? `secrets:   ${report.secrets.count} pushed to provider`
        : `secrets:   ${report.secrets.detail ?? report.secrets.action}`,
    );
  }
  if (report.session) lines.push(`session:   ${sessionSummary(report.session.action)}`);
  if (report.container?.stopped) lines.push('container: stopped');
  for (const l of lines) log.raw('    ' + l);
  log.success(ctx.dryRun ? 'pause dry-run complete' : 'Safe to switch machines.');
}
