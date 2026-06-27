import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function readFileIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/** Write a file with restrictive perms (0600) — used for credential stores. */
export async function writeSecureFile(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, content, { mode: 0o600 });
  await fs.chmod(p, 0o600).catch(() => undefined);
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Walk up from `start` looking for the first directory containing `marker`.
 * Returns the directory path, or null if the filesystem root is reached.
 */
export async function findUp(marker: string, start: string): Promise<string | null> {
  let dir = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await pathExists(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Append a line to .gitignore if not already present; create it if missing. */
export async function ensureGitignored(repoRoot: string, entry: string): Promise<void> {
  const gi = path.join(repoRoot, '.gitignore');
  const current = (await readFileIfExists(gi)) ?? '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry.trim())) return;
  const next = current.length && !current.endsWith('\n') ? current + '\n' : current;
  await fs.writeFile(gi, next + entry + '\n');
}
