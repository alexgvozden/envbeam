import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import type { RunContext } from './context.js';
import { resolveActiveProviders } from './providers.js';
import { runPreflight, assertSecretsAuth, type ToolCheck } from './preflight.js';
import { runMigrateCommand } from '../providers/database/migrate.js';
import { machineName } from '../providers/database/base.js';
import { stateDir } from '../config/paths.js';
import { loadState, patchState, snapshotBase } from '../state.js';
import {
  createSyncTarget,
  decryptFile,
  detectEncryptFromName,
  ensureAgeKeys,
  formatTimestamp,
  verifyArtifact,
  type SnapshotEntry,
} from '../sync/index.js';
import { PreflightError, EnvbeamError } from '../util/errors.js';
import { assertCanPull, type SyncStatus } from './guard.js';
import { ensureTools } from '../util/tools.js';
import { ensureDockerRunning } from '../util/docker.js';
import { installRuntimeDeps, type DepsReport } from './deps.js';
import { sessionSummary } from './format.js';
import type { GitPullResult, MaterializeResult, ContainerStatus } from '../providers/types.js';

export interface ResumeReport {
  identity?: string;
  sync?: SyncStatus;
  git?: GitPullResult & { branch: string; commit?: string };
  secrets?: { count: number; materialized?: MaterializeResult };
  deps?: DepsReport;
  session?: { action: string; detail?: string };
  container?: ContainerStatus;
  database?: {
    migrated: boolean;
    migrateDetail?: string;
    restored?: { timestamp: string; file: string };
    /** Why a snapshot that exists on the sync target was not restored. */
    restoreSkipped?: string;
  };
}

function blockingProblems(ctx: RunContext, checks: ToolCheck[]): ToolCheck[] {
  const snapshotMode = ctx.config.database?.mode === 'snapshot';
  return checks.filter((c) => {
    // Session is best-effort; never blocks resume.
    if (c.concern === 'session') return false;
    // DB connectivity can't pass until the container step runs; only a *missing*
    // dump/restore tool blocks, and only in snapshot mode (migrations-only needs none).
    if (c.concern === 'database') return !c.present && snapshotMode;
    return !c.present || (c.authChecked && c.authOk === false);
  });
}

/** Resume pipeline (PRD §7): get this machine ready to work where I left off. */
export async function runResume(ctx: RunContext): Promise<ResumeReport> {
  const log = ctx.logger;
  log.resetSteps();
  const active = resolveActiveProviders(ctx);
  const report: ResumeReport = { identity: ctx.identities.git?.name };

  // 1. Preflight
  log.step('Preflight');
  if (ctx.identityWarnings.length && !ctx.dryRun) {
    throw new PreflightError(
      `Unknown identity reference(s): ${ctx.identityWarnings.join(', ')}.`,
      'Define them with `envbeam identity add <name>` or fix the names in .envbeam.yaml.',
    );
  }
  // Resume pulls secrets from the provider, so gate on auth up front with the
  // same friendly login hint push uses (shared helper). Skipped in dry-run.
  if (!ctx.dryRun) await assertSecretsAuth(ctx);

  // Per project rule, install missing DB client tools for the user (snapshot
  // restore needs them) rather than letting preflight hard-block.
  if (!ctx.dryRun && ctx.config.database?.mode === 'snapshot' && active.database) {
    const dctx = ctx.providerCtx('database');
    const missing: string[] = [];
    for (const req of active.database.requiredTools(dctx)) {
      if (!(await ctx.runner.which(req.command))) missing.push(req.command);
    }
    if (missing.length) {
      log.sub(`database tools needed — installing ${missing.join(', ')}`);
      await ensureTools(missing, ctx.runner, ctx.logger, ctx.prompter);
    }
  }

  // If we'll bring a container up, self-heal Docker BEFORE preflight — otherwise
  // the daemon check would hard-block here, before container.up() could start it.
  const willStartContainer = !!active.container && ctx.config.container?.upOnResume !== false;
  if (!ctx.dryRun && willStartContainer) {
    await ensureDockerRunning(ctx.providerCtx('container'));
  }

  // Skip the database connectivity probe: on resume the DB can't be reached yet
  // (secrets not materialized, container not up). It's validated after, once the
  // container is up and secrets are written (see waitForDbReady).
  const pre = await runPreflight(ctx, { auth: true, skipAuthFor: ['database'] });
  const blockers = blockingProblems(ctx, pre.checks);
  for (const c of pre.checks) {
    if (!c.present) log.sub(pc.red(`✗ ${c.command} not found (${c.concern}) — ${c.installHint}`));
    else if (c.authChecked && c.authOk === false)
      log.sub(pc.yellow(`! ${c.command} present but ${c.authDetail ?? 'not authenticated'}`));
    else log.sub(pc.green(`✓ ${c.command}${c.version ? ' ' + c.version.replace(/^.*?\b(\d[\w.]*)\b.*$/, '$1') : ''}`));
  }
  if (blockers.length && !ctx.dryRun) {
    throw new PreflightError(
      `Preflight failed: ${blockers.map((b) => b.command).join(', ')} missing or unauthenticated.`,
      'Run `envbeam doctor` for actionable fixes.',
    );
  }

  // 2. Sync guard — before git touches anything, so a refusal costs nothing.
  log.step('Sync check');
  report.sync = await assertCanPull(ctx, active, ctx.force);

  // 3. Git
  log.step('Git');
  const gctx = ctx.providerCtx('git');
  const pull = await active.git.pull(gctx);
  const gstatus = await active.git.status(gctx);
  report.git = { ...pull, branch: gstatus.branch, commit: gstatus.commit };
  describeGitPull(ctx, pull, gstatus.branch);
  // The commit we ended up on is the git half of this machine's base.
  if (!ctx.dryRun && gstatus.commit) {
    await patchState(ctx.workspaceRoot, { baseGitCommit: gstatus.commit });
  }

  // 3. Secrets
  if (active.secrets) {
    log.step('Secrets');
    if (ctx.dryRun) {
      const dest = ctx.config.secrets?.dotenvPath ?? '.env';
      log.sub(`would pull secrets from ${ctx.config.secrets?.provider} → ${dest}`);
    } else {
      const sctx = ctx.providerCtx('secrets');
      const pulled = await active.secrets.pull(sctx);
      Object.assign(ctx.env, pulled.values);
      const materialized = await active.secrets.materialize(sctx, pulled);
      report.secrets = { count: pulled.count, materialized };
      log.sub(
        `pulled ${pulled.count} secret(s) from ${ctx.config.secrets?.provider}` +
          (materialized?.path ? ` → wrote ${materialized.path}` : ''),
      );
    }
  }

  // 4. Dependencies — detect language toolchains from lockfiles, install the
  // package manager if missing, and sync project deps (best-effort, non-fatal).
  report.deps = (await installRuntimeDeps(ctx)) ?? undefined;

  // 5. Session — best-effort: never block getting the machine ready to work.
  if (active.session) {
    log.step('Session');
    try {
      const res = await active.session.pull(ctx.providerCtx('session'));
      report.session = { action: res.action, detail: res.detail };
      log.sub(res.detail ?? res.action);
      if (res.action === 'pulled') {
        log.hint('Your Claude sessions are restored — run `claude --resume` in this project to pick one up.');
      }
    } catch (e) {
      report.session = { action: 'noop', detail: `session pull failed: ${(e as Error).message}` };
      log.warn(`session pull failed (continuing): ${(e as Error).message}`);
    }
  }

  // 5. Container
  if (willStartContainer) {
    log.step('Container');
    const status = await active.container!.up(ctx.providerCtx('container'));
    report.container = status;
    log.sub(status.running ? 'container up' : status.detail ?? 'container not running');
  }

  // 6. Database
  if (ctx.config.database) {
    log.step('Database');
    const ambiguous = active.database?.ambiguityWarning?.(ctx.providerCtx('database'));
    if (ambiguous) log.warn(ambiguous);
    // If we just started the container, the DB may need a moment to accept
    // connections before migrations/restore — wait for it (best-effort).
    if (willStartContainer && active.database && !ctx.dryRun) {
      await waitForDbReady(ctx, active.database);
    }
    report.database = await resumeDatabase(ctx, active);
  }

  // 7. Advance the base — but only if we actually took in what the remote holds.
  // A pull that skipped the git fast-forward (dirty tree) or declined a restore
  // has NOT observed the remote checkpoint, and claiming otherwise would let the
  // next push overwrite it while believing it was up to date.
  await advanceBaseIfApplied(ctx, report);

  // 8. Report
  printResumeReport(ctx, report);
  return report;
}

async function advanceBaseIfApplied(ctx: RunContext, report: ResumeReport): Promise<void> {
  const sync = report.sync;
  if (ctx.dryRun || !sync || sync.unavailable || sync.remoteRevision === 0) return;

  const gitApplied =
    !report.git || report.git.action === 'fast-forwarded' || report.git.action === 'up-to-date';
  // "already at the latest snapshot" means the data is in place — that is applied.
  const dbApplied =
    !report.database?.restoreSkipped || report.database.restoreSkipped === 'already at the latest snapshot';

  if (gitApplied && dbApplied) {
    await patchState(ctx.workspaceRoot, { baseRevision: sync.remoteRevision });
    return;
  }
  if (sync.remoteRevision > sync.baseRevision) {
    ctx.logger.warn(
      `pull did not fully apply remote revision ${sync.remoteRevision} — the sync base stays at r${sync.baseRevision}.`,
    );
    const why = [
      gitApplied ? null : `git: ${report.git?.action}`,
      dbApplied ? null : `database: ${report.database?.restoreSkipped}`,
    ].filter(Boolean);
    for (const w of why) ctx.logger.sub(pc.dim(`  ${w}`));
    ctx.logger.hint('Resolve the above and pull again; until then `push` will refuse, since this machine is behind.');
  }
}

/** Poll the DB until it accepts connections (best-effort, ~45s cap). */
async function waitForDbReady(
  ctx: RunContext,
  db: NonNullable<ReturnType<typeof resolveActiveProviders>['database']>,
): Promise<void> {
  const dctx = ctx.providerCtx('database');
  if ((await db.status(dctx)).reachable) return;
  ctx.logger.sub('waiting for the database to accept connections…');
  const startedAt = Date.now();
  let waited = 0;
  while (Date.now() - startedAt < 45_000) {
    await new Promise((r) => setTimeout(r, 2000));
    waited += 2;
    if ((await db.status(dctx)).reachable) {
      ctx.logger.sub(pc.dim(`database ready (after ${waited}s)`));
      return;
    }
  }
  ctx.logger.sub(pc.yellow('database still not reachable — continuing (migrations may fail)'));
}

async function resumeDatabase(
  ctx: RunContext,
  active: ReturnType<typeof resolveActiveProviders>,
): Promise<NonNullable<ResumeReport['database']>> {
  const log = ctx.logger;
  const dctx = ctx.providerCtx('database');
  const db = ctx.config.database!;

  // migrations always
  const migrate = active.database
    ? await active.database.migrate(dctx)
    : await runMigrateCommand(dctx);
  log.sub(migrate.ran ? `migrations applied (${migrate.detail})` : `migrations: ${migrate.detail}`);

  const out: NonNullable<ResumeReport['database']> = {
    migrated: migrate.ran,
    migrateDetail: migrate.detail,
  };

  if (db.mode !== 'snapshot' || !active.database || !db.sync || db.restore === 'off') {
    return out;
  }
  if (ctx.dryRun) {
    log.sub('would check sync target for a newer snapshot to restore');
    return out;
  }

  // restore newer snapshot if available
  const target = createSyncTarget(db.sync, ctx.identities.sync);
  let entries: SnapshotEntry[] = [];
  try {
    entries = await target.list(dctx, ctx.config.workspace);
  } catch (e) {
    log.sub(`could not list snapshots: ${(e as Error).message}`);
    return out;
  }
  const latest = entries[0];
  if (!latest) {
    log.sub('no snapshots on sync target; schema is current via migrations');
    return out;
  }

  const state = await loadState(ctx.workspaceRoot);
  const base = snapshotBase(state);

  // Lineage guard (SYNC_SAFETY.md D1). `base` covers snapshots we pushed as well
  // as ones we restored, so our own dump can never look "newer" than us. When
  // the remote sorts strictly below our base, some other machine pushed stale
  // data (or newer snapshots were pruned) — that is worth shouting about.
  if (base && latest.timestamp <= base) {
    if (latest.timestamp < base) {
      log.warn(
        `the newest snapshot on the sync target is OLDER than this machine's database — not restoring.`,
      );
      log.sub(pc.dim(`  remote: ${latest.timestamp} (${latest.machine ?? 'unknown machine'})`));
      log.sub(pc.dim(`  local:  ${base} (last snapshot this machine pushed or restored)`));
      log.hint(
        'A machine with stale data may have pushed, or newer snapshots were pruned. `envbeam pull --force` restores it anyway and discards local data.',
      );
      out.restoreSkipped = `remote snapshot ${latest.timestamp} is older than local base ${base}`;
    } else {
      log.sub('local DB already reflects the latest snapshot');
      out.restoreSkipped = 'already at the latest snapshot';
    }
    if (!ctx.force) return out;
    log.warn(`--force: restoring ${latest.name}, which is not newer than this machine's database.`);
  }

  // Divergence guard (SYNC_SAFETY.md D4). A restore is a whole-database
  // overwrite; if the local data moved since our base, the two sides diverged
  // and no timestamp can adjudicate that. Never auto-restore over it.
  const change = state.dbFingerprint
    ? await active.database.hasChanged(dctx, state.dbFingerprint)
    : null;

  let shouldRestore = db.restore === 'auto';
  if (change?.changed) {
    log.warn(`local database has changed since the last sync — restoring ${latest.name} would discard those changes.`);
    log.sub(pc.dim(`  ${change.detail}`));
    if (ctx.force) {
      log.warn('--force: discarding local database changes.');
      shouldRestore = true;
    } else if (!ctx.prompter.interactive) {
      // `--yes` means "don't ask me the routine questions", not "discard data
      // nobody else has a copy of". A divergence needs a human or --force.
      shouldRestore = false;
      log.hint('Refusing to resolve a database divergence non-interactively. Re-run in a terminal, or pass --force to discard the local data.');
    } else {
      shouldRestore = await ctx.prompter.confirm(
        `Restore snapshot ${latest.timestamp} (${latest.machine ?? 'unknown'}) and DISCARD local database changes?`,
        false,
      );
    }
  } else if (db.restore === 'prompt') {
    // Change detection is row-counts (or size + approximate rows): an UPDATE in
    // place changes neither. Say so rather than implying "no changes" is proof.
    if (change) log.sub(pc.dim('  no row-count change detected locally (updates in place are not detected)'));
    shouldRestore = await ctx.prompter.confirm(
      `Restore newer DB snapshot from ${latest.timestamp} (${latest.machine ?? 'unknown'})?`,
      true,
    );
  }
  if (!shouldRestore) {
    log.sub('snapshot restore declined; migrations applied only');
    out.restoreSkipped = change?.changed ? 'local database has diverged' : 'declined';
    return out;
  }

  // About to overwrite data the remote has never seen — keep a copy first.
  if (change?.changed) {
    const backup = await preRestoreBackup(ctx, active);
    if (backup) log.sub(pc.dim(`  local database dumped to ${backup} before restore`));
    else log.warn('could not dump the local database before restoring — its current contents are not recoverable');
  }

  const restored = await downloadAndRestore(ctx, active, target, latest);
  if (restored) {
    // Re-baseline: the fingerprint now describes the restored data, otherwise the
    // next push would read the restore itself as a local change.
    const after = await active.database.hasChanged(dctx, undefined);
    await patchState(ctx.workspaceRoot, {
      lastRestoredTimestamp: latest.timestamp,
      baseSnapshotName: latest.name,
      ...(after.fingerprint ? { dbFingerprint: after.fingerprint } : {}),
    });
    out.restored = { timestamp: latest.timestamp, file: latest.name };
    log.sub(`restored snapshot from ${latest.timestamp}`);
  }
  return out;
}

/**
 * Dump the local database before a restore overwrites it. Best-effort: a
 * failure here is reported, never fatal — but the caller must say so, because
 * the data is about to be unrecoverable.
 */
async function preRestoreBackup(
  ctx: RunContext,
  active: ReturnType<typeof resolveActiveProviders>,
): Promise<string | null> {
  try {
    const dctx = ctx.providerCtx('database');
    const dir = path.join(stateDir(), 'pre-restore');
    await fs.mkdir(dir, { recursive: true });
    const result = await active.database!.snapshot(dctx, {
      dataOnly: ctx.config.database?.snapshot?.dataOnly ?? true,
      compress: ctx.config.database?.snapshot?.compress ?? true,
      includeTables: [],
      excludeTables: [],
      machine: machineName(),
      timestamp: formatTimestamp(new Date()),
    });
    const dest = path.join(dir, path.basename(result.file));
    await fs.rename(result.file, dest).catch(async () => {
      await fs.copyFile(result.file, dest);
      await fs.rm(result.file, { force: true });
    });
    return dest;
  } catch {
    return null;
  }
}

async function downloadAndRestore(
  ctx: RunContext,
  active: ReturnType<typeof resolveActiveProviders>,
  target: ReturnType<typeof createSyncTarget>,
  entry: SnapshotEntry,
): Promise<boolean> {
  const dctx = ctx.providerCtx('database');
  const db = ctx.config.database!;
  const work = path.join(ctx.workspaceRoot, '.envbeam', 'restore');
  await fs.mkdir(work, { recursive: true });
  const downloaded = path.join(work, entry.name);
  await target.get(dctx, entry.ref, downloaded);

  // Verify the downloaded snapshot against the Doppler-anchored hash before
  // restoring it into the database. A mismatch = tampered/replaced in the bucket.
  const verdict = await verifyArtifact(ctx.runner, ctx.config.workspace, entry.name, downloaded);
  if (verdict === 'mismatch') {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw new EnvbeamError('refusing to restore: database snapshot failed integrity check (Doppler hash mismatch)', {
      exitCode: 2,
      hint: 'The snapshot in storage does not match the recorded hash — it may have been tampered with.',
    });
  }
  if (verdict === 'missing') {
    ctx.logger.sub('no integrity hash on record for this snapshot — cannot verify it was not tampered');
  }

  // Decryption is driven by the FILE's extension, not config — so a snapshot
  // encrypted by default (age) still restores even if the local config differs.
  let restoreFile = downloaded;
  const enc = detectEncryptFromName(entry.name);
  if (enc !== 'none') {
    await ensureAgeKeys(dctx);
    const t = await ensureTools([enc === 'gpg' ? 'gpg' : 'age'], dctx.runner, dctx.logger, dctx.prompter);
    if (!t.allInstalled) {
      throw new EnvbeamError(`snapshot is ${enc}-encrypted but ${enc} is not installed`, {
        exitCode: 2,
        hint: `Install ${enc} to decrypt the database snapshot.`,
      });
    }
    restoreFile = downloaded.slice(0, -4); // '.age' / '.gpg'
    await decryptFile(dctx, { ...db.sync!, encrypt: enc }, downloaded, restoreFile);
    ctx.logger.sub('snapshot decrypted');
  }

  await active.database!.restore(dctx, restoreFile);
  await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

function describeGitPull(ctx: RunContext, pull: GitPullResult, branch: string): void {
  const log = ctx.logger;
  switch (pull.action) {
    case 'fast-forwarded':
      log.sub(`${branch}: ${pull.detail ?? 'fast-forwarded'}`);
      break;
    case 'up-to-date':
      log.sub(`${branch}: already up to date`);
      break;
    case 'skipped-dirty':
      log.sub(pc.yellow(`${branch}: ${pull.detail} (left as-is)`));
      break;
    default:
      log.sub(`${branch}: ${pull.detail ?? pull.action}`);
  }
}

function printResumeReport(ctx: RunContext, report: ResumeReport): void {
  const log = ctx.logger;
  log.step('Report');
  const lines: string[] = [];
  if (report.identity) lines.push(`identity:  ${report.identity}`);
  if (report.sync && !report.sync.unavailable) {
    lines.push(`sync:      ${report.sync.verdict} (base r${report.sync.baseRevision}, remote r${report.sync.remoteRevision})`);
  }
  if (report.git) lines.push(`branch:    ${report.git.branch} (${report.git.action})`);
  if (report.secrets) lines.push(`secrets:   ${report.secrets.count} written to ${report.secrets.materialized?.path ?? '.env'}`);
  if (report.deps) {
    lines.push(
      `deps:      ${report.deps.synced.length} synced${report.deps.failed.length ? `, ${report.deps.failed.length} failed (${report.deps.failed.join(', ')})` : ''}`,
    );
  }
  if (report.container) lines.push(`container: ${report.container.running ? 'up' : 'not running'}`);
  if (report.database) {
    const r = report.database.restored
      ? `restored snapshot ${report.database.restored.timestamp}, `
      : report.database.restoreSkipped
        ? `no restore (${report.database.restoreSkipped}), `
        : '';
    lines.push(`database:  ${r}migrations ${report.database.migrated ? 'applied' : 'up to date'}`);
  }
  if (report.session) lines.push(`session:   ${sessionSummary(report.session.action)}`);
  for (const l of lines) log.raw('    ' + l);
  log.success(ctx.dryRun ? 'resume dry-run complete' : 'Ready to work.');
  if (!ctx.dryRun) log.hint('Start coding — env, container, and session are in place.');
}
