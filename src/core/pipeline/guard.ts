import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import pc from 'picocolors';
import type { RunContext } from './context.js';
import type { resolveActiveProviders } from './providers.js';
import { loadState } from '../state.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { RegistryStore } from '../registry/store.js';
import type { Checkpoint, ProjectEntry } from '../registry/types.js';
import { SafetyError } from '../util/errors.js';

/**
 * Where this machine stands relative to the remote checkpoint.
 *
 * These are git's words, and deliberately so (SYNC_SAFETY.md §10.3). The whole
 * point is that "which is newer" stops being a timestamp comparison — which is
 * really "whose clock is fastest" — and becomes a question about whether one
 * state descends from the other.
 */
export type SyncVerdict =
  /** Nothing in the registry for this project. Any push is the first. */
  | 'first-sync'
  /** Remote is where we left it and nothing moved locally. */
  | 'in-sync'
  /** Remote is where we left it; we have local changes. Safe to push. */
  | 'ahead'
  /** Remote moved; we changed nothing. Safe to pull (fast-forward). */
  | 'behind'
  /** Both moved. No timestamp can adjudicate this. Stop and ask. */
  | 'diverged';

export interface SyncStatus {
  verdict: SyncVerdict;
  /** The revision this machine last observed. */
  baseRevision: number;
  /** The revision now in the registry. */
  remoteRevision: number;
  /** Human-readable descriptions of what moved locally since the base. */
  localChanges: string[];
  /** The remote checkpoint, when the registry has one. */
  checkpoint?: Checkpoint;
  /** Set when the registry could not be consulted at all (offline, unconfigured). */
  unavailable?: string;
}

type Active = ReturnType<typeof resolveActiveProviders>;

/** Read the registry entry for this workspace, or explain why we can't. */
async function readRemote(ctx: RunContext): Promise<{ entry?: ProjectEntry; unavailable?: string }> {
  if (process.env.ENVBEAM_DISABLE_STORAGE) return { unavailable: 'storage disabled' };
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig.storage) return { unavailable: 'no global storage configured' };
  try {
    const store = new RegistryStore(globalConfig.storage, ctx.runner);
    return { entry: await store.getProject(ctx.config.workspace) };
  } catch (e) {
    return { unavailable: (e as Error).message };
  }
}

/** Has the materialized dotenv been edited since envbeam wrote it? */
async function dotenvEdited(ctx: RunContext): Promise<boolean> {
  const state = await loadState(ctx.workspaceRoot);
  if (!state.dotenvHash) return false; // no base recorded — cannot tell, don't guess
  const rel =
    ctx.config.secrets?.output === 'run-wrapper' ? '.envbeam/runenv.sh' : ctx.config.secrets?.dotenvPath ?? '.env';
  try {
    const text = await fs.readFile(path.join(ctx.workspaceRoot, rel), 'utf8');
    return createHash('sha256').update(text).digest('hex') !== state.dotenvHash;
  } catch {
    return false; // absent → nothing to lose
  }
}

/**
 * What has moved on this machine since its base. Each entry is shown to the
 * user, so each must say what it means in plain words.
 *
 * `probeDatabase` is off on the pull path: the database usually isn't reachable
 * that early (container down, secrets not materialized), and a "not reachable"
 * answer would read as "nothing changed". The restore itself re-checks with
 * `hasChanged()` once the container is up, which is where it matters.
 */
async function detectLocalChanges(
  ctx: RunContext,
  active: Active,
  opts: { probeDatabase: boolean },
): Promise<string[]> {
  const changes: string[] = [];
  const state = await loadState(ctx.workspaceRoot);

  const git = await active.git.status(ctx.providerCtx('git'));
  if (git.dirtyFiles.length) changes.push(`${git.dirtyFiles.length} uncommitted file(s)`);
  if (git.ahead > 0) changes.push(`${git.ahead} unpushed commit(s) on ${git.branch}`);

  if (opts.probeDatabase && active.database && state.dbFingerprint && !ctx.dryRun) {
    const change = await active.database.hasChanged(ctx.providerCtx('database'), state.dbFingerprint);
    if (change.changed) changes.push(`database data changed (${change.detail})`);
  }

  if (await dotenvEdited(ctx)) changes.push('local edits to the materialized .env');

  return changes;
}

/** Compute where we stand, without deciding what to do about it. */
export async function syncStatus(
  ctx: RunContext,
  active: Active,
  opts: { probeDatabase: boolean },
): Promise<SyncStatus> {
  const state = await loadState(ctx.workspaceRoot);
  const baseRevision = state.baseRevision ?? 0;
  const { entry, unavailable } = await readRemote(ctx);
  const localChanges = await detectLocalChanges(ctx, active, opts);

  if (unavailable || !entry) {
    return {
      verdict: 'first-sync',
      baseRevision,
      remoteRevision: 0,
      localChanges,
      unavailable,
    };
  }

  // A machine that has never synced (base 0) but finds a populated registry is
  // behind, not in-sync — it has observed nothing of what's there.
  const remoteMoved = entry.revision > baseRevision;
  const verdict: SyncVerdict = remoteMoved
    ? localChanges.length
      ? 'diverged'
      : 'behind'
    : localChanges.length
      ? 'ahead'
      : 'in-sync';

  return {
    verdict,
    baseRevision,
    remoteRevision: entry.revision,
    localChanges,
    checkpoint: entry.checkpoint,
  };
}

/** Print the verdict and the evidence behind it. */
function describe(ctx: RunContext, s: SyncStatus, action: 'push' | 'pull'): void {
  const log = ctx.logger;
  if (s.unavailable) {
    log.sub(pc.dim(`sync check skipped (${s.unavailable})`));
    return;
  }
  const rev = `local base r${s.baseRevision}, remote r${s.remoteRevision}`;
  switch (s.verdict) {
    case 'first-sync':
      log.sub(pc.dim(`first sync for this project (${rev})`));
      break;
    case 'in-sync':
      log.sub(pc.dim(`in sync (${rev})`));
      break;
    case 'ahead':
      log.sub(pc.dim(`ahead of the remote (${rev})`));
      break;
    case 'behind':
      log.sub(pc.dim(`behind the remote (${rev})`));
      break;
    case 'diverged':
      log.warn(`this machine and the remote have BOTH changed since they last synced (${rev}).`);
      break;
  }
  for (const c of s.localChanges) log.sub(pc.dim(`  local: ${c}`));
  if (s.verdict === 'diverged' && s.checkpoint) {
    log.sub(pc.dim(`  remote: r${s.checkpoint.revision} pushed by ${s.checkpoint.machineId} at ${s.checkpoint.at}`));
  }
  if (s.verdict === 'diverged') {
    log.hint(
      action === 'push'
        ? 'Pull first to take in the remote checkpoint, or re-run with --overwrite-remote to make this machine authoritative.'
        : 'Push first to publish your work, or re-run with --force to discard the local changes listed above.',
    );
  }
}

/**
 * Refuse a push that would overwrite a remote checkpoint this machine has never
 * seen. `canPush() = registry.revision === state.baseRevision` (§10.3).
 *
 * Note this refuses on plain `behind` too, not just `diverged`: a machine that
 * has been offline for a week has no local changes, but its snapshot is a week
 * old, and uploading it makes every other machine restore week-old data. That is
 * D2, and "we changed nothing" is precisely why the push is dangerous rather
 * than why it's safe.
 */
export async function assertCanPush(ctx: RunContext, active: Active, overwriteRemote: boolean): Promise<SyncStatus> {
  const s = await syncStatus(ctx, active, { probeDatabase: true });
  describe(ctx, s, 'push');

  if (s.verdict !== 'behind' && s.verdict !== 'diverged') return s;

  if (overwriteRemote) {
    ctx.logger.warn(
      `--overwrite-remote: pushing over remote revision ${s.remoteRevision}, which this machine has not seen.`,
    );
    return s;
  }
  if (ctx.dryRun) {
    ctx.logger.warn('a real push would be refused here.');
    return s;
  }

  const noun = s.verdict === 'diverged' ? 'has diverged from' : 'is behind';
  throw new SafetyError(
    `Refusing to push: this machine ${noun} the remote (base r${s.baseRevision}, remote r${s.remoteRevision}).` +
      (s.verdict === 'behind'
        ? ' Its database snapshot and session archive are older than what is already published.'
        : ''),
    'Run `envbeam pull` to take in the remote checkpoint first, or `envbeam push --overwrite-remote` to make this machine authoritative.',
  );
}

/**
 * Refuse a pull that would resolve a divergence by overwriting local work. A
 * pull that is merely `behind` fast-forwards, which is the ordinary case.
 *
 * `ahead` is not an error: there is simply nothing to take. Saying so is the
 * difference between "up to date" and "you are the one holding the newer data".
 */
export async function assertCanPull(ctx: RunContext, active: Active, force: boolean): Promise<SyncStatus> {
  const s = await syncStatus(ctx, active, { probeDatabase: false });
  describe(ctx, s, 'pull');

  if (s.verdict === 'ahead') {
    ctx.logger.sub(pc.dim('nothing to pull — this machine holds work the remote has not seen'));
  }
  if (s.verdict !== 'diverged') return s;

  if (force) {
    ctx.logger.warn(`--force: pulling over local changes (base r${s.baseRevision}, remote r${s.remoteRevision}).`);
    return s;
  }
  if (ctx.dryRun) {
    ctx.logger.warn('a real pull would be refused here.');
    return s;
  }
  // Never resolve a divergence for someone who told us not to ask questions.
  if (ctx.prompter.interactive) {
    const proceed = await ctx.prompter.confirm('Pull anyway, discarding the local changes listed above?', false);
    if (proceed) return s;
  }

  throw new SafetyError(
    `Refusing to pull: this machine and the remote have both changed since they last synced ` +
      `(base r${s.baseRevision}, remote r${s.remoteRevision}).`,
    'Run `envbeam push` to publish your work first, or `envbeam pull --force` to discard it.',
  );
}
