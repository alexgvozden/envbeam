import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import pc from 'picocolors';
import type { RunContext } from './context.js';
import type { resolveActiveProviders } from './providers.js';
import { loadState, type ObservedCheckpoint } from '../state.js';
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

/** The four things envbeam syncs, each with its own notion of "moved". */
export type SyncDomain = 'git' | 'database' | 'session' | 'secrets';

/**
 * Where one domain stands. A single `revision` counter says *that* the remote
 * moved, never *what* it moved — so a machine that changed its database while
 * the remote changed only secrets was told the two had diverged, and the whole
 * pull was refused over work that was never in contention (SYNC_SAFETY.md §12.3).
 *
 * No registry schema change is needed to fix that. The checkpoint already names
 * one artifact per domain — `gitCommit`, `snapshotName`, `sessionName`,
 * `secretsHash` — so recording the checkpoint we last observed (`baseCheckpoint`)
 * and comparing it field by field says which domains the remote moved. Crossing
 * that with what moved locally says which ones actually diverged.
 */
export interface DomainVerdict {
  domain: SyncDomain;
  localMoved: boolean;
  remoteMoved: boolean;
  /** What moved locally, in words. Shown to the user. */
  localDetail?: string;
}

export interface SyncStatus {
  verdict: SyncVerdict;
  /** The revision this machine last observed. */
  baseRevision: number;
  /** The revision now in the registry. */
  remoteRevision: number;
  /** Per-domain breakdown. Empty when the remote has no checkpoint to compare. */
  domains: DomainVerdict[];
  /**
   * Domains both sides moved. Empty when the verdict is not `diverged` — and
   * also when a checkpoint-less registry entry left us unable to attribute the
   * divergence to anything narrower than "shared state".
   */
  divergedDomains: SyncDomain[];
  /** Human-readable descriptions of what moved locally since the base. */
  localChanges: string[];
  /**
   * Untracked files. Not divergence — but git refuses to fast-forward over a
   * dirty tree, so they can still stop a pull from applying the checkpoint.
   */
  untracked: string[];
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

/**
 * Has the materialized dotenv been edited since envbeam wrote it, in a way that
 * means this machine's *shared* state has moved?
 *
 * Only under `sync: two-way`. There, `.env` is where local secret edits live and
 * a push uploads them, so an edit is genuinely a change the remote hasn't seen.
 * Under `pull-only` — the default — the provider is the source of truth and the
 * file is a generated artifact: an edit to it conflicts with nothing on the
 * remote, and counting it as divergence would block every pull over a scratch
 * value. That case is handled where it belongs, by the backup-and-confirm in
 * `materializeSecrets` (SYNC_SAFETY.md S2).
 */
async function dotenvEdited(ctx: RunContext): Promise<boolean> {
  if ((ctx.config.secrets?.sync ?? 'pull-only') !== 'two-way') return false;
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
): Promise<{ local: Map<SyncDomain, string>; untracked: string[] }> {
  const local = new Map<SyncDomain, string>();
  const state = await loadState(ctx.workspaceRoot);

  const git = await active.git.status(ctx.providerCtx('git'));
  // Only *tracked* modifications count. An untracked scratch file is not state
  // any machine shares, so it cannot have diverged from anything — treating it
  // as divergence would turn every stray file into a refused pull.
  const trackedEdits = git.dirtyFiles.length - git.untrackedFiles.length;
  const gitDetail = [
    trackedEdits > 0 ? `${trackedEdits} uncommitted change(s) to tracked files` : null,
    git.ahead > 0 ? `${git.ahead} unpushed commit(s) on ${git.branch}` : null,
  ].filter(Boolean);
  if (gitDetail.length) local.set('git', gitDetail.join(', '));

  if (opts.probeDatabase && active.database && state.dbFingerprint && !ctx.dryRun) {
    const change = await active.database.hasChanged(ctx.providerCtx('database'), state.dbFingerprint);
    if (change.changed) local.set('database', `database data changed (${change.detail})`);
  }

  if (await dotenvEdited(ctx)) local.set('secrets', 'local edits to the materialized .env');

  // Session changes are not probed: the session merge never destroys anything
  // (T3 parks a diverged transcript beside yours), so nothing here needs to stop
  // a pull on its account.

  return { local, untracked: git.untrackedFiles };
}

/**
 * Which domains the remote moved, by comparing its checkpoint against the
 * checkpoint this machine last observed.
 *
 * It must be checkpoint-against-checkpoint. Comparing the remote's `gitCommit`
 * against this machine's `baseGitCommit` looks equivalent and is not: a commit
 * pushed outside envbeam moves HEAD past whatever the checkpoint names, so every
 * later run would report the remote as having moved git while it stood still —
 * and a machine with any local change would be told it had diverged. `base*`
 * records where *we* ended up; only `baseCheckpoint` records what the *remote*
 * said.
 *
 * An **absent** field on the remote checkpoint contributes no evidence. A push
 * from a machine that never pulled has no `secretsHash`; a `migrations-only`
 * project never has a `snapshotName`. Reading "absent" as "moved" would invent
 * divergences, which is the very thing this exists to stop. Each domain's own
 * guard (D4 for the database, S2 for secrets, T3 for sessions) still refuses to
 * overwrite anything without consent, so under-reporting here is safe and
 * over-reporting is not.
 */
function remoteMovement(remote: Checkpoint, base: ObservedCheckpoint): Map<SyncDomain, boolean> {
  const moved = new Map<SyncDomain, boolean>();
  const changed = (now: string | undefined, then: string | undefined): boolean =>
    now !== undefined && now !== then;

  moved.set('git', changed(remote.gitCommit, base.gitCommit));
  moved.set('database', changed(remote.snapshotName, base.snapshotName));
  moved.set('session', changed(remote.sessionName, base.sessionName));
  moved.set('secrets', changed(remote.secretsHash, base.secretsHash));
  return moved;
}

/** The subset of a checkpoint worth recording as "what the remote said". */
export function observeCheckpoint(cp: Checkpoint): ObservedCheckpoint {
  return {
    revision: cp.revision,
    gitCommit: cp.gitCommit,
    snapshotName: cp.snapshotName,
    sessionName: cp.sessionName,
    secretsHash: cp.secretsHash,
  };
}

const ALL_DOMAINS: SyncDomain[] = ['git', 'database', 'session', 'secrets'];

/** Compute where we stand, without deciding what to do about it. */
export async function syncStatus(
  ctx: RunContext,
  active: Active,
  opts: { probeDatabase: boolean },
): Promise<SyncStatus> {
  const state = await loadState(ctx.workspaceRoot);
  const baseRevision = state.baseRevision ?? 0;
  const { entry, unavailable } = await readRemote(ctx);
  const { local, untracked } = await detectLocalChanges(ctx, active, opts);
  const localChanges = [...local.values()];

  if (unavailable || !entry) {
    return {
      verdict: 'first-sync',
      baseRevision,
      remoteRevision: 0,
      domains: [],
      divergedDomains: [],
      localChanges,
      untracked,
      unavailable,
    };
  }

  // A machine that has never synced (base 0) but finds a populated registry is
  // behind, not in-sync — it has observed nothing of what's there.
  const remoteAdvanced = entry.revision > baseRevision;

  // Two ways to have nothing to compare field by field: the remote entry predates
  // checkpoints (before 0.23.0), or this machine has not observed one yet. Either
  // way, fall back to the coarse whole-project verdict. A single pull or push
  // records a base checkpoint and the next run gets the precise answer.
  if (!entry.checkpoint || !state.baseCheckpoint) {
    const verdict: SyncVerdict = remoteAdvanced
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
      domains: [],
      // No attribution: claiming all four diverged would be a guess dressed as a
      // finding. The checkpoint itself still travels — `resume` needs it for the
      // coherence check regardless of whether we can compare it to anything.
      divergedDomains: [],
      localChanges,
      untracked,
      checkpoint: entry.checkpoint,
    };
  }

  const moved = remoteMovement(entry.checkpoint, state.baseCheckpoint);
  const domains: DomainVerdict[] = ALL_DOMAINS.map((domain) => ({
    domain,
    localMoved: local.has(domain),
    // A remote that advanced its revision without moving any domain we can name
    // still moved *something* we cannot see; don't claim it stood still.
    remoteMoved: moved.get(domain) ?? false,
    localDetail: local.get(domain),
  }));

  const divergedDomains = domains.filter((d) => d.localMoved && d.remoteMoved).map((d) => d.domain);
  const anyRemote = domains.some((d) => d.remoteMoved) || remoteAdvanced;
  const anyLocal = localChanges.length > 0;

  const verdict: SyncVerdict = divergedDomains.length
    ? 'diverged'
    : anyRemote
      ? 'behind'
      : anyLocal
        ? 'ahead'
        : 'in-sync';

  return {
    verdict,
    baseRevision,
    remoteRevision: entry.revision,
    domains,
    divergedDomains,
    localChanges,
    untracked,
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
    case 'diverged': {
      const what = s.divergedDomains.length ? s.divergedDomains.join(', ') : 'shared state';
      log.warn(`this machine and the remote have BOTH changed ${what} since they last synced (${rev}).`);
      break;
    }
  }
  // Name the domains that actually diverged, and the ones that did not. "Both
  // sides changed something" is not actionable; "your database diverged, git and
  // secrets fast-forward cleanly" is.
  if (s.divergedDomains.length && s.domains.length) {
    for (const d of s.domains.filter((d) => s.divergedDomains.includes(d.domain))) {
      log.sub(pc.yellow(`  ${d.domain}: diverged — you changed it (${d.localDetail}) and so did the remote`));
    }
    const clean = s.domains.filter((d) => !s.divergedDomains.includes(d.domain) && d.remoteMoved);
    if (clean.length) {
      log.sub(pc.dim(`  ${clean.map((d) => d.domain).join(', ')}: only the remote moved — would fast-forward`));
    }
    const oursOnly = s.domains.filter((d) => d.localMoved && !d.remoteMoved);
    if (oursOnly.length) {
      log.sub(pc.dim(`  ${oursOnly.map((d) => d.domain).join(', ')}: only you moved — nothing to reconcile`));
    }
  } else {
    for (const c of s.localChanges) log.sub(pc.dim(`  local: ${c}`));
  }

  // Not divergence, but git will not fast-forward over them, so the checkpoint
  // may go unapplied. Worth a word before that happens silently.
  if (s.untracked.length && action === 'pull') {
    log.sub(pc.dim(`  ${s.untracked.length} untracked file(s) — git will not fast-forward over them`));
    for (const f of s.untracked.slice(0, 5)) log.sub(pc.dim(`    ${f}`));
  }
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

  const revs = `base r${s.baseRevision}, remote r${s.remoteRevision}`;
  throw new SafetyError(
    s.verdict === 'diverged'
      ? `Refusing to push: this machine and the remote have both changed ${s.divergedDomains.join(', ') || 'shared state'} since they last synced (${revs}).`
      : `Refusing to push: this machine is behind the remote (${revs}). Its database snapshot and session archive are older than what is already published.`,
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

  const what = s.divergedDomains.length ? s.divergedDomains.join(', ') : 'shared state';
  throw new SafetyError(
    `Refusing to pull: this machine and the remote have both changed ${what} since they last synced ` +
      `(base r${s.baseRevision}, remote r${s.remoteRevision}).`,
    'Run `envbeam push` to publish your work first, or `envbeam pull --force` to discard it.',
  );
}
