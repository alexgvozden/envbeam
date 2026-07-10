import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { stateDir } from './config/paths.js';
import { ensureDir, readFileIfExists } from './util/fs.js';

/**
 * The domain-naming half of a registry checkpoint, recorded locally so a later
 * run can ask which domains the remote moved. Structural on purpose: `state.ts`
 * has no business depending on the registry's zod schema.
 */
export interface ObservedCheckpoint {
  revision: number;
  gitCommit?: string;
  snapshotName?: string;
  sessionName?: string;
  secretsHash?: string;
}

/** Hashes of the secret set we last pulled. Never holds a plaintext value. */
export interface SecretsBase {
  /** sha256 over the sorted `k=v` set — changes when any key or value changes. */
  hash: string;
  /** Per-key sha256 of the value, so a three-way diff can be key-level. */
  keyHashes: Record<string, string>;
  pulledAt: string;
}

export interface WorkspaceState {
  /** Last DB change-detection fingerprint observed. */
  dbFingerprint?: string;
  /** Timestamp string of the last snapshot this machine pushed. */
  lastSnapshotTimestamp?: string;
  /** Timestamp string of the last snapshot this machine restored. */
  lastRestoredTimestamp?: string;

  /*
   * The BASE: the remote state this machine last observed, by pulling it or by
   * pushing it. "Did the remote move since we last synced?" is a comparison
   * against these, and it is the only question that distinguishes a safe
   * fast-forward from a divergence (SYNC_SAFETY.md §3).
   */

  /** Registry revision this machine last observed. Absent = never synced. */
  baseRevision?: number;
  /**
   * The remote checkpoint as it looked at `baseRevision` — what the remote *said*
   * about itself when we last observed it.
   *
   * Distinct from the `base*` fields below, which record where this machine
   * ended up. Asking "did the remote move its git?" by comparing the remote's
   * `gitCommit` against our `baseGitCommit` conflates the two: a commit pushed
   * outside envbeam moves our HEAD past the checkpoint, and every later pull
   * would report the remote as having moved when it stood still. Only a
   * checkpoint can be compared with a checkpoint.
   */
  baseCheckpoint?: ObservedCheckpoint;
  /** Full sha of the commit the base checkpoint names. */
  baseGitCommit?: string;
  /** File name of the snapshot our database currently reflects. */
  baseSnapshotName?: string;
  /** File name of the session archive our transcripts currently reflect. */
  baseSessionName?: string;
  /** Hashes of the secret set we last pulled from the provider. */
  secretsBase?: SecretsBase;
  /** sha256 of the dotenv file exactly as envbeam last wrote it. */
  dotenvHash?: string;
}

/**
 * The newest snapshot this machine has already seen — whether it *pushed* that
 * snapshot or *restored* it. Both mean "our database already reflects this",
 * so a remote snapshot is only newer than us when it sorts above this.
 *
 * Consulting the push side is what stops a machine from restoring its own dump
 * over data it has changed since (SYNC_SAFETY.md D1): `lastSnapshotTimestamp`
 * was recorded on every push and then never read.
 *
 * Returns undefined when this machine has no history for the workspace, in
 * which case any snapshot is genuinely new to it.
 */
export function snapshotBase(state: WorkspaceState): string | undefined {
  const seen = [state.lastSnapshotTimestamp, state.lastRestoredTimestamp].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  );
  if (!seen.length) return undefined;
  return seen.sort()[seen.length - 1];
}

function stateFile(workspaceRoot: string): string {
  const key = createHash('sha1').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16);
  return path.join(stateDir(), `${key}.json`);
}

export async function loadState(workspaceRoot: string): Promise<WorkspaceState> {
  const text = await readFileIfExists(stateFile(workspaceRoot));
  if (!text) return {};
  try {
    return JSON.parse(text) as WorkspaceState;
  } catch {
    return {};
  }
}

export async function saveState(workspaceRoot: string, state: WorkspaceState): Promise<void> {
  const file = stateFile(workspaceRoot);
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n');
}

export async function patchState(workspaceRoot: string, patch: Partial<WorkspaceState>): Promise<WorkspaceState> {
  const current = await loadState(workspaceRoot);
  const next = { ...current, ...patch };
  await saveState(workspaceRoot, next);
  return next;
}
