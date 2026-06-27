import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { stateDir } from './config/paths.js';
import { ensureDir, readFileIfExists } from './util/fs.js';

export interface WorkspaceState {
  /** Last DB change-detection fingerprint observed. */
  dbFingerprint?: string;
  /** Timestamp string of the last snapshot this machine pushed. */
  lastSnapshotTimestamp?: string;
  /** Timestamp string of the last snapshot this machine restored. */
  lastRestoredTimestamp?: string;
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
