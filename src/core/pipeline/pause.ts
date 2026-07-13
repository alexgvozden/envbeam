import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import type { RunContext } from './context.js';
import { resolveActiveProviders } from './providers.js';
import { machineName } from '../providers/database/base.js';
import { loadState, patchState, snapshotBase } from '../state.js';
import {
  createSyncTarget,
  encryptionSuffix,
  encryptFile,
  ensureAgeKeys,
  formatTimestamp,
  snapshotName,
  recordArtifactHash,
  sha256File,
  type SnapshotEntry,
} from '../sync/index.js';
import { PreflightError, EnvbeamError } from '../util/errors.js';
import { assertCanPush, type SyncStatus } from './guard.js';
import { assertSecretsAuth } from './preflight.js';
import { detectedValue, resolveBranch } from '../detect/types.js';
import { ensureTools } from '../util/tools.js';
import { stripUrlCreds } from '../util/redact.js';
import { sessionSummary } from './format.js';
import type { GitPushResult, SnapshotOptions } from '../providers/types.js';

export interface PauseOptions {
  /** Push even though uncommitted work would be left behind (a LOCAL risk). */
  force: boolean;
  /**
   * Push even though the remote holds a checkpoint this machine never saw (a
   * REMOTE risk). Deliberately not `--force`: leaving dirty files behind and
   * overwriting another machine's published state are different decisions, and
   * consenting to the first must not silently consent to the second.
   */
  overwriteRemote?: boolean;
  /** true = force a snapshot, false = skip, undefined = auto (change-detection). */
  snapshot?: boolean;
  workMode: 'commit' | 'stash' | 'none';
  /** Sweep untracked files into the commit. Only ever set from an explicit yes. */
  includeUntracked?: boolean;
  message?: string;
}

export interface PauseReport {
  sync?: SyncStatus;
  git?: GitPushResult & { branch: string; commit?: string };
  database?: {
    snapshot?: { timestamp: string; file: string; sizeBytes: number };
    skipped?: string;
    /** True when the snapshot was skipped on purpose, not because a step failed. */
    skipIntended?: boolean;
    migrationsOnly: boolean;
  };
  secrets?: { action: string; count: number; detail?: string };
  session?: { action: string; detail?: string; artifact?: string };
  container?: { stopped: boolean };
  /**
   * Reasons this push did NOT produce a coherent checkpoint. Empty means every
   * step it claims actually landed, and the registry may be advanced.
   */
  incoherent: string[];
}

/**
 * Which steps of this push failed to land (SYNC_SAFETY.md §9).
 *
 * `runPause` pushes git first, then snapshots the database, then the session.
 * Each step's failure is independent, so a snapshot that dies on the size cap
 * leaves remote git *ahead of remote data*: the next machine pulls code that
 * expects rows nobody uploaded, and is told everything is fine because the git
 * step succeeded. A checkpoint may only name artifacts that really exist.
 */
function incoherenceReasons(report: PauseReport): string[] {
  const reasons: string[] = [];
  if (report.git && !report.git.pushed) {
    reasons.push(`git was not pushed (${report.git.detail ?? 'unknown reason'})`);
  }
  if (report.database?.skipped && !report.database.skipIntended) {
    reasons.push(`database snapshot skipped: ${report.database.skipped}`);
  }
  if (report.secrets?.action === 'skipped' && report.secrets.detail !== 'pull-only mode') {
    reasons.push(`secrets not pushed: ${report.secrets.detail ?? 'skipped'}`);
  }
  return reasons;
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
  const report: PauseReport = { incoherent: [] };

  // Sync guard: the earliest point at which we can still abort cleanly. Once git
  // has pushed, refusing costs more than it saves.
  log.step('Sync check');
  report.sync = await assertCanPush(ctx, active, opts.overwriteRemote ?? false);

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
    includeUntracked: opts.includeUntracked,
  });
  report.git = { ...push, branch: status.branch };
  if (push.committed) log.sub('committed working changes');
  if (push.stashed) log.sub('stashed working changes');
  log.sub(push.pushed ? push.detail ?? 'pushed' : push.detail ?? 'not pushed');
  // A commit made on the user's behalf is pushed, and a push is not undoable.
  // Say plainly which files were not carried, rather than quietly publishing them.
  if (push.untrackedLeftBehind?.length) {
    log.warn(`${push.untrackedLeftBehind.length} untracked file(s) were NOT committed and will not reach the other machine:`);
    for (const f of push.untrackedLeftBehind.slice(0, 10)) log.sub(pc.dim(`  ${f}`));
    log.hint('Add them to git yourself, gitignore them, or re-run with --include-untracked.');
  }
  // Re-read HEAD: pushWork may have just committed, moving it.
  if (!ctx.dryRun && push.pushed) {
    const after = await active.git.status(gctx);
    report.git.commit = after.commit;
    if (after.commit) await patchState(ctx.workspaceRoot, { baseGitCommit: after.commit });
  }

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
      report.session = { action: res.action, detail: res.detail, artifact: res.artifact };
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
  report.incoherent = incoherenceReasons(report);
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

/**
 * Refuse to publish a snapshot taken from a database that has not seen the
 * newest snapshot on the target (SYNC_SAFETY.md D2).
 *
 * A machine offline for a week takes a dump of week-old data, gets today's
 * timestamp on it, sorts first, and every other machine restores it. Nothing
 * here looked at what was already on the target beyond "does anything exist".
 *
 * The registry guard (`assertCanPush`) usually catches this first, but the sync
 * target is a separate system: snapshots can exist for a workspace whose
 * registry entry is missing, stale, or unreachable. This is the check that is
 * anchored to the artifact itself.
 *
 * Returns null to proceed, or a reason to skip.
 */
async function snapshotLineageBlock(
  ctx: RunContext,
  dctx: ReturnType<RunContext['providerCtx']>,
  overwriteRemote: boolean,
): Promise<string | null> {
  const sync = ctx.config.database!.sync!;
  let entries: SnapshotEntry[];
  try {
    entries = await createSyncTarget(sync, ctx.identities.sync).list(dctx, ctx.config.workspace);
  } catch {
    return null; // can't list → don't block the push on it
  }
  const newest = entries[0];
  if (!newest) return null; // nothing published; ours is the first

  const state = await loadState(ctx.workspaceRoot);
  const base = snapshotBase(state);
  if (base && newest.timestamp <= base) return null; // we have seen everything there

  const whose = newest.machine ? ` (pushed by ${newest.machine})` : '';
  const detail = base
    ? `the target holds a newer snapshot ${newest.timestamp}${whose}; this machine's data only reflects ${base}`
    : `the target already holds snapshot ${newest.timestamp}${whose}, and this machine has never restored one`;

  if (overwriteRemote) {
    ctx.logger.warn(`--overwrite-remote: uploading anyway — ${detail}.`);
    return null;
  }
  ctx.logger.warn(`refusing to upload a database snapshot: ${detail}.`);
  ctx.logger.hint('Run `envbeam pull` to take in the newer snapshot first, or `envbeam push --overwrite-remote` to make this machine authoritative.');
  return `would publish data older than ${newest.timestamp}`;
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
  // A skip the user asked for (or that carries no data) keeps the push coherent.
  // A skip forced by a missing tool, an unreadable DB, or a refused upload does
  // not: git is already published, and the data it expects is not (§9).
  let skipIntended = true;

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
        skipIntended = false; // we could not read the DB, not "nothing changed"
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
    out.skipIntended = true;
    return out;
  }
  if (!take) {
    out.skipped = skipReason;
    out.skipIntended = skipIntended;
    return out;
  }

  // Lineage check before doing the expensive thing. Dumping a whole database to
  // then refuse the upload wastes minutes and leaves a plaintext dump on disk.
  if (!ctx.dryRun) {
    const blocked = await snapshotLineageBlock(ctx, dctx, opts.overwriteRemote ?? false);
    if (blocked) {
      out.skipped = blocked;
      return out;
    }
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

  // Encrypt at rest — REQUIRED. A snapshot carries the whole database, so
  // envbeam never uploads it in the clear: if encryption can't be performed it
  // stops and points at the setup guide rather than falling back to plaintext.
  const target = createSyncTarget(db.sync, ctx.identities.sync);
  const cryptoCfg = db.sync; // schema guarantees encrypt is 'age' | 'gpg'
  const tool = cryptoCfg.encrypt === 'gpg' ? 'gpg' : 'age';

  const suffix = encryptionSuffix(cryptoCfg);
  const uploadFile = result.file + suffix;
  const uploadName = path.basename(result.file) + suffix;
  let encryptedFile: string | null = null;
  // The plaintext dump (and any encrypted copy) must never survive an error —
  // wrap encrypt+upload so a failure can't leave a full DB dump in the temp dir.
  try {
    // Make sure we can actually encrypt before uploading anything.
    if (cryptoCfg.encrypt === 'age') {
      const keys = await ensureAgeKeys(dctx);
      if (!keys.pub && !cryptoCfg.recipient) {
        throw new EnvbeamError('at-rest encryption is required, but no age key is set up on this machine.', {
          exitCode: 2,
          hint: 'Run `envbeam storage setup` to generate and store an encryption key, then push again.',
        });
      }
    } else if (!cryptoCfg.recipient) {
      throw new EnvbeamError('at-rest encryption is required: sync.encrypt gpg needs sync.recipient (a key id/email).', {
        exitCode: 2,
        hint: 'Set sync.recipient in .envbeam.yaml to your gpg key id, then push again.',
      });
    }
    const t = await ensureTools([tool], dctx.runner, dctx.logger, dctx.prompter);
    if (!t.allInstalled) {
      throw new EnvbeamError(`snapshot encryption needs ${tool}, which is not installed.`, {
        exitCode: 2,
        hint: `Install ${tool} (envbeam can do this for you) and push again — the snapshot is never uploaded unencrypted.`,
      });
    }

    encryptedFile = uploadFile;
    await encryptFile(dctx, cryptoCfg, result.file, uploadFile);
    log.sub(`snapshot encrypted (${cryptoCfg.encrypt})`);

    const entry = await target.put(dctx, uploadFile, uploadName);
    const pruned = await target.prune(dctx, ctx.config.workspace, db.sync.keep ?? 5);
    if (pruned.length) log.sub(`pruned ${pruned.length} old snapshot(s)`);

    // Anchor snapshot integrity in Doppler (separate trust domain from the
    // bucket), pruning manifest entries for snapshots that no longer exist.
    const live = new Set((await target.list(dctx, ctx.config.workspace).catch(() => [])).map((e) => e.name));
    const ok = await recordArtifactHash(dctx.runner, ctx.config.workspace, uploadName, await sha256File(uploadFile), live);
    if (!ok) log.warn('could not record snapshot integrity hash in Doppler — restore cannot verify this snapshot');

    // Re-baseline change detection against the data we just published. The
    // change-detection path records a fingerprint, but `--snapshot` skips that
    // path entirely — so a forced snapshot left `dbFingerprint` unset, and the
    // next pull's divergence check (D4) had nothing to compare against and
    // silently allowed a restore over locally-changed data.
    const fingerprint = (await active.database.hasChanged(dctx, undefined)).fingerprint;
    await patchState(ctx.workspaceRoot, {
      lastSnapshotTimestamp: timestamp,
      baseSnapshotName: entry.name,
      ...(fingerprint ? { dbFingerprint: fingerprint } : {}),
    });
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
  if (report.sync && !report.sync.unavailable) {
    lines.push(`sync:      ${report.sync.verdict} (base r${report.sync.baseRevision}, remote r${report.sync.remoteRevision})`);
  }
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

  // A partial push is not a success. Say what landed, what didn't, and that the
  // remote checkpoint was left where it was — otherwise the next machine pulls
  // code expecting data nobody uploaded, and is told everything is fine.
  if (report.incoherent.length && !ctx.dryRun) {
    log.warn('this push is incomplete — the remote checkpoint was NOT advanced.');
    if (report.git?.pushed && report.git.commit) {
      log.sub(pc.dim(`  git pushed at ${report.git.commit.slice(0, 8)}`));
    }
    for (const r of report.incoherent) log.sub(pc.dim(`  ${r}`));
    log.hint('Fix the above and push again. Other machines will not see a half-applied checkpoint.');
    return;
  }
  log.success(ctx.dryRun ? 'pause dry-run complete' : 'Safe to switch machines.');
}
