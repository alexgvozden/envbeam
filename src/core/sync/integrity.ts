import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { CommandRunner } from '../util/exec.js';

// The integrity manifest lives in the global Doppler project — a DIFFERENT
// trust domain than the storage bucket. Tampering with a bucket artifact is
// therefore detectable unless the attacker also has write access to Doppler
// (and age already makes tampering-without-the-key fail outright). One secret
// per workspace keeps the map small and avoids cross-project write contention.
const DOPPLER_PROJECT = 'envbeam-global';
const DOPPLER_CONFIG = 'prd';

function manifestKey(workspace: string): string {
  const w = workspace.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `ENVBEAM_HASHES_${w || 'DEFAULT'}`;
}

/** SHA-256 (hex) of a file, streamed so large snapshots don't buffer in memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Read the workspace's artifact→sha256 manifest from Doppler ({} if absent). */
export async function readManifest(
  runner: CommandRunner,
  workspace: string,
): Promise<Record<string, string>> {
  const res = await runner.run(
    'doppler',
    ['secrets', 'get', manifestKey(workspace), '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--plain'],
    { allowFailure: true },
  );
  if (res.code !== 0) return {};
  try {
    const v = JSON.parse(res.stdout.trim() || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The two artifact families that share one workspace manifest. They are listed
 * from the sync target by different calls, so each writer only ever knows which
 * of *its own* artifacts are still live.
 */
export type ArtifactKind = 'snapshot' | 'session';

/** Session archives are the ones with the well-known prefix; the rest are dumps. */
export function artifactKind(name: string): ArtifactKind {
  return name.startsWith('claude-session-') ? 'session' : 'snapshot';
}

/**
 * Record `name → hash` in the workspace manifest (read-modify-write of one
 * Doppler secret). Optionally prune entries whose artifact is no longer on the
 * sync target (pass the live names) so the manifest tracks retention. Returns
 * false if the manifest couldn't be written (e.g. Doppler unavailable).
 *
 * Pruning is scoped to the recorded artifact's own family. It has to be: a push
 * records the database snapshot (pruning against the live *snapshots*) and then
 * the session archive (pruning against the live *session archives*). An
 * unscoped prune therefore has each step delete the other's hashes, and the
 * second one wins — so the database snapshot's hash was erased on every push,
 * and `verifyArtifact` could only ever answer `missing` for it. The integrity
 * check silently verified nothing.
 */
export async function recordArtifactHash(
  runner: CommandRunner,
  workspace: string,
  name: string,
  hash: string,
  liveNames?: Set<string>,
): Promise<boolean> {
  const manifest = await readManifest(runner, workspace);
  manifest[name] = hash;
  if (liveNames) {
    const kind = artifactKind(name);
    for (const k of Object.keys(manifest)) {
      if (k !== name && artifactKind(k) === kind && !liveNames.has(k)) delete manifest[k];
    }
  }
  const res = await runner.run(
    'doppler',
    ['secrets', 'set', `${manifestKey(workspace)}=${JSON.stringify(manifest)}`, '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG],
    { allowFailure: true },
  );
  return res.code === 0;
}

export type VerifyResult = 'ok' | 'missing' | 'mismatch';

/**
 * Verify a downloaded artifact against the Doppler-anchored hash.
 * - `ok`       — hash recorded and matches (integrity confirmed)
 * - `mismatch` — hash recorded but differs → the artifact was tampered/replaced
 * - `missing`  — no hash recorded (pushed before integrity, or Doppler down)
 */
export async function verifyArtifact(
  runner: CommandRunner,
  workspace: string,
  name: string,
  filePath: string,
): Promise<VerifyResult> {
  const manifest = await readManifest(runner, workspace);
  const expected = manifest[name];
  if (!expected) return 'missing';
  const actual = await sha256File(filePath);
  return actual === expected ? 'ok' : 'mismatch';
}
