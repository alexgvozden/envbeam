import { createHash } from 'node:crypto';
import type { SecretsBase } from '../../state.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * A key whose value changed on BOTH sides since the base, to different things.
 * No rule can pick a winner; only a human can.
 */
export interface SecretConflict {
  key: string;
  /** Present so a caller can prompt with the values. Never logged. */
  local: string;
  remote: string;
}

export interface ThreeWayResult {
  /** The union to upload. Contains every key either side still has. */
  merged: Record<string, string>;
  /** Keys only this machine changed or added. */
  localWins: string[];
  /** Keys only the provider changed or added — folded in, nothing to push. */
  remoteWins: string[];
  /** Changed on both sides, differently. */
  conflicts: SecretConflict[];
  /**
   * Keys present at the base and gone from `.env`, which the remote still has.
   * envbeam never deletes a provider secret: the merged set keeps them, and the
   * caller tells the user to delete them in the provider if that was the intent.
   */
  removedLocally: string[];
  /** True when there is no recorded base, so "who changed it" is unanswerable. */
  degraded: boolean;
}

/**
 * Three-way merge of a secret set (SYNC_SAFETY.md §6, S1).
 *
 * A two-way push read `.env` and uploaded it wholesale. If machine A added
 * `STRIPE_KEY` and pushed, and machine B (whose `.env` predates that) pushed
 * next, B uploaded a set that had never seen A's key. Whether that *deleted*
 * A's key or merely failed to add it depends on `doppler secrets upload`
 * semantics — which is exactly the dependency this removes: we upload the
 * **union**, so nothing is lost under either semantics, and deletions never
 * propagate implicitly.
 *
 * `base` holds hashes only, never plaintext. That is enough: comparing
 * `sha256(value)` against the recorded hash answers "did this side change it?",
 * which is the only question a three-way merge asks.
 */
export function threeWayMergeSecrets(
  base: SecretsBase | undefined,
  local: Record<string, string>,
  remote: Record<string, string>,
): ThreeWayResult {
  const out: ThreeWayResult = {
    merged: {},
    localWins: [],
    remoteWins: [],
    conflicts: [],
    removedLocally: [],
    degraded: !base,
  };

  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base?.keyHashes ?? {})]);

  for (const key of [...keys].sort()) {
    const l = local[key];
    const r = remote[key];
    const baseHash = base?.keyHashes[key];
    const lh = l === undefined ? undefined : sha256(l);
    const rh = r === undefined ? undefined : sha256(r);

    // Without a base we cannot attribute a difference to either side. Treat any
    // disagreement as a conflict rather than guessing — S3 is why this exists.
    if (!base) {
      if (l !== undefined && r !== undefined && lh !== rh) out.conflicts.push({ key, local: l, remote: r });
      else if (l !== undefined) {
        out.merged[key] = l;
        if (r === undefined) out.localWins.push(key);
      } else if (r !== undefined) {
        out.merged[key] = r;
        out.remoteWins.push(key);
      }
      continue;
    }

    const localChanged = lh !== baseHash;
    const remoteChanged = rh !== baseHash;

    if (!localChanged && !remoteChanged) {
      if (l !== undefined) out.merged[key] = l;
      continue;
    }
    if (localChanged && !remoteChanged) {
      if (l === undefined) {
        // Deleted here, untouched there. Keep it; deleting a provider secret is
        // not something a `.env` edit should do behind the user's back.
        out.removedLocally.push(key);
        if (r !== undefined) out.merged[key] = r;
      } else {
        out.merged[key] = l;
        out.localWins.push(key);
      }
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (r !== undefined) {
        out.merged[key] = r;
        out.remoteWins.push(key);
      }
      // Deleted upstream and untouched here → let it go.
      continue;
    }

    // Both changed.
    if (lh === rh && l !== undefined) {
      out.merged[key] = l; // same edit on both sides
    } else if (l === undefined && r !== undefined) {
      out.merged[key] = r; // we deleted, they changed → keep theirs
      out.removedLocally.push(key);
    } else if (r === undefined && l !== undefined) {
      out.merged[key] = l; // they deleted, we changed → keep ours
      out.localWins.push(key);
    } else if (l !== undefined && r !== undefined) {
      out.conflicts.push({ key, local: l, remote: r });
    }
  }

  return out;
}
