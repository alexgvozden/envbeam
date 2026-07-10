import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir } from '../../util/fs.js';

/**
 * Merging a Claude session tree, file by file (SYNC_SAFETY.md §7.1).
 *
 * The old restore was a whole-tree `copyFile` over the local tree, which
 * truncates a longer local `.jsonl` when the archive holds a shorter one. The
 * layout splits into three regions with three different rules:
 *
 *   <session-uuid>.jsonl        transcript, append-only  → union, fast-forward
 *   <session-uuid>/**           sidecars, keyed by uuid   → follow the parent
 *   memory/**                   shared, rewritten in place → newest wins + backup
 *
 * Session UUIDs are minted per machine, so two machines working the same project
 * produce *disjoint* transcript files and union is the natural operation. The
 * only true collision is a session pulled to machine B and resumed there while
 * machine A also appended to it.
 */

export type FileAction =
  /** No local file; took the remote one. */
  | 'copied'
  /** Local was a strict byte-prefix of remote: appended the rest. */
  | 'fast-forwarded'
  /** Byte-identical. */
  | 'up-to-date'
  /** Remote was a prefix of local: we hold more. Left alone. */
  | 'local-ahead'
  /** Neither is a prefix of the other. Local kept; remote written beside it. */
  | 'diverged'
  /** Remote was newer and won; the local copy was saved beside it. */
  | 'replaced'
  /** Would inject hooks/MCP/settings that run on next Claude start. */
  | 'skipped-sensitive'
  | 'skipped-symlink';

export interface MergeReport {
  actions: Array<{ path: string; action: FileAction }>;
  /** Relative paths written next to a local file rather than over it. */
  sidecars: string[];
}

/** Config files whose contents cause code execution when Claude next runs. */
export function isSensitiveConfigFile(name: string): boolean {
  return name === 'settings.json' || name === 'settings.local.json' || name.endsWith('.mcp.json');
}

/**
 * How `remote` relates to `local`, by bytes.
 *
 * This *verifies* append-only rather than assuming it. If Claude ever rewrites a
 * transcript in place (compaction, redaction), the prefix test fails and the
 * file is classified `diverged` instead of being silently truncated. The cost is
 * a length compare, then a byte compare up to the shorter length.
 */
export function compareContents(local: Buffer, remote: Buffer): 'same' | 'remote-extends' | 'local-extends' | 'diverged' {
  const shorter = Math.min(local.length, remote.length);
  if (!local.subarray(0, shorter).equals(remote.subarray(0, shorter))) return 'diverged';
  if (local.length === remote.length) return 'same';
  return local.length < remote.length ? 'remote-extends' : 'local-extends';
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** Copy preserving mtime, so a restored file keeps the time it was last written. */
async function copyPreservingMtime(src: string, dest: string): Promise<void> {
  await fs.copyFile(src, dest);
  const st = await fs.stat(src).catch(() => null);
  if (st) await fs.utimes(dest, st.atime, st.mtime).catch(() => undefined);
}

/** Recursive copy with the same security rules as the flat copy: no symlinks, no config. */
async function copyTree(src: string, dest: string, report: MergeReport, relBase: string): Promise<void> {
  await ensureDir(dest);
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const rel = path.join(relBase, e.name);
    if (e.isSymbolicLink()) {
      report.actions.push({ path: rel, action: 'skipped-symlink' });
      continue;
    }
    if (e.isDirectory()) {
      await copyTree(path.join(src, e.name), path.join(dest, e.name), report, rel);
    } else if (e.isFile()) {
      if (isSensitiveConfigFile(e.name)) {
        report.actions.push({ path: rel, action: 'skipped-sensitive' });
        continue;
      }
      await copyPreservingMtime(path.join(src, e.name), path.join(dest, e.name));
      report.actions.push({ path: rel, action: 'copied' });
    }
  }
}

/** Insert `suffix` before the extension: `abc.jsonl` + `.remote-x` → `abc.remote-x.jsonl`. */
function withSuffix(name: string, suffix: string): string {
  const ext = name.endsWith('.tar.gz') ? '.tar.gz' : path.extname(name);
  return `${name.slice(0, name.length - ext.length)}${suffix}${ext}`;
}

/**
 * Merge one transcript. Never truncates: a file that neither extends nor is
 * extended by the local one is written beside it, and the local bytes stay.
 */
async function mergeTranscript(
  srcFile: string,
  destFile: string,
  machine: string,
  report: MergeReport,
  rel: string,
): Promise<FileAction> {
  const local = await readOrNull(destFile);
  if (!local) {
    await copyPreservingMtime(srcFile, destFile);
    report.actions.push({ path: rel, action: 'copied' });
    return 'copied';
  }
  const remote = await fs.readFile(srcFile);
  switch (compareContents(local, remote)) {
    case 'same':
      report.actions.push({ path: rel, action: 'up-to-date' });
      return 'up-to-date';
    case 'remote-extends':
      await copyPreservingMtime(srcFile, destFile);
      report.actions.push({ path: rel, action: 'fast-forwarded' });
      return 'fast-forwarded';
    case 'local-extends':
      report.actions.push({ path: rel, action: 'local-ahead' });
      return 'local-ahead';
    case 'diverged': {
      const beside = withSuffix(path.basename(destFile), `.remote-${machine}`);
      const besidePath = path.join(path.dirname(destFile), beside);
      await copyPreservingMtime(srcFile, besidePath);
      report.actions.push({ path: rel, action: 'diverged' });
      report.sidecars.push(path.join(path.dirname(rel), beside));
      return 'diverged';
    }
  }
}

/**
 * `memory/` is the hole in the union model: shared, mutable, rewritten in place,
 * and keyed by nothing. There is no natural merge. Newest mtime wins — but the
 * displaced bytes are always written beside the winner, because "last writer
 * wins" should never mean "the other writer's notes are gone".
 */
async function mergeMutable(
  srcFile: string,
  destFile: string,
  machine: string,
  report: MergeReport,
  rel: string,
): Promise<void> {
  const local = await readOrNull(destFile);
  if (!local) {
    await copyPreservingMtime(srcFile, destFile);
    report.actions.push({ path: rel, action: 'copied' });
    return;
  }
  const remote = await fs.readFile(srcFile);
  if (local.equals(remote)) {
    report.actions.push({ path: rel, action: 'up-to-date' });
    return;
  }

  const [srcStat, destStat] = await Promise.all([fs.stat(srcFile), fs.stat(destFile)]);
  const dir = path.dirname(destFile);
  const base = path.basename(destFile);

  if (srcStat.mtimeMs > destStat.mtimeMs) {
    // Remote is the last writer. Keep our bytes beside it before overwriting.
    const backup = withSuffix(base, '.local-backup');
    await copyPreservingMtime(destFile, path.join(dir, backup));
    await copyPreservingMtime(srcFile, destFile);
    report.actions.push({ path: rel, action: 'replaced' });
    report.sidecars.push(path.join(path.dirname(rel), backup));
  } else {
    const beside = withSuffix(base, `.remote-${machine}`);
    await copyPreservingMtime(srcFile, path.join(dir, beside));
    report.actions.push({ path: rel, action: 'diverged' });
    report.sidecars.push(path.join(path.dirname(rel), beside));
  }
}

/**
 * Merge an extracted session tree into `destDir`. `machine` names the machine
 * that produced the archive, and appears in any sidecar this writes.
 */
export async function mergeSessionTree(
  srcDir: string,
  destDir: string,
  machine: string,
): Promise<MergeReport> {
  const report: MergeReport = { actions: [], sidecars: [] };
  await ensureDir(destDir);

  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  // Pass 1: transcripts. Their outcome decides what happens to their sidecars.
  const transcript = new Map<string, FileAction>();
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink() || !e.name.endsWith('.jsonl')) continue;
    const action = await mergeTranscript(
      path.join(srcDir, e.name),
      path.join(destDir, e.name),
      machine,
      report,
      e.name,
    );
    transcript.set(e.name.slice(0, -'.jsonl'.length), action);
  }

  // Pass 2: directories.
  for (const e of entries) {
    if (!e.isDirectory()) {
      if (e.isSymbolicLink()) report.actions.push({ path: e.name, action: 'skipped-symlink' });
      continue;
    }
    const src = path.join(srcDir, e.name);

    if (e.name === 'memory') {
      await mergeMutableTree(src, path.join(destDir, e.name), machine, report, e.name);
      continue;
    }

    const parent = transcript.get(e.name);
    if (parent === 'local-ahead' || parent === 'up-to-date') continue; // nothing to bring over
    if (parent === 'diverged') {
      // The sidecars belong to the remote transcript, which we parked beside the
      // local one. Park theirs beside it too, rather than mixing the two runs.
      await copyTree(src, path.join(destDir, `${e.name}.remote-${machine}`), report, `${e.name}.remote-${machine}`);
      continue;
    }
    await mergeGenericTree(src, path.join(destDir, e.name), machine, report, e.name);
  }

  // Pass 3: root files that are not transcripts (rare; treat as mutable).
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink() || e.name.endsWith('.jsonl')) continue;
    if (isSensitiveConfigFile(e.name)) {
      report.actions.push({ path: e.name, action: 'skipped-sensitive' });
      continue;
    }
    await mergeMutable(path.join(srcDir, e.name), path.join(destDir, e.name), machine, report, e.name);
  }

  return report;
}

/** `memory/**`: every file follows the mutable rule. */
async function mergeMutableTree(
  src: string,
  dest: string,
  machine: string,
  report: MergeReport,
  rel: string,
): Promise<void> {
  await ensureDir(dest);
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isSymbolicLink()) {
      report.actions.push({ path: r, action: 'skipped-symlink' });
      continue;
    }
    if (e.isDirectory()) {
      await mergeMutableTree(path.join(src, e.name), path.join(dest, e.name), machine, report, r);
    } else if (e.isFile()) {
      if (isSensitiveConfigFile(e.name)) {
        report.actions.push({ path: r, action: 'skipped-sensitive' });
        continue;
      }
      await mergeMutable(path.join(src, e.name), path.join(dest, e.name), machine, report, r);
    }
  }
}

/**
 * A subtree with no known keying (a sidecar dir, or something Claude added since
 * this was written). Nested `.jsonl` files still get the prefix rule — they are
 * the append-only thing we most want not to truncate — and anything else falls
 * back to the mutable rule, which never destroys bytes either.
 */
async function mergeGenericTree(
  src: string,
  dest: string,
  machine: string,
  report: MergeReport,
  rel: string,
): Promise<void> {
  await ensureDir(dest);
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isSymbolicLink()) {
      report.actions.push({ path: r, action: 'skipped-symlink' });
      continue;
    }
    if (e.isDirectory()) {
      await mergeGenericTree(path.join(src, e.name), path.join(dest, e.name), machine, report, r);
    } else if (e.isFile()) {
      if (isSensitiveConfigFile(e.name)) {
        report.actions.push({ path: r, action: 'skipped-sensitive' });
        continue;
      }
      if (e.name.endsWith('.jsonl')) {
        await mergeTranscript(path.join(src, e.name), path.join(dest, e.name), machine, report, r);
      } else {
        await mergeMutable(path.join(src, e.name), path.join(dest, e.name), machine, report, r);
      }
    }
  }
}

/** One-line summary for the run report. */
export function summarizeMerge(reports: MergeReport[]): string {
  const tally: Partial<Record<FileAction, number>> = {};
  for (const r of reports) for (const a of r.actions) tally[a.action] = (tally[a.action] ?? 0) + 1;
  const parts = (['copied', 'fast-forwarded', 'replaced', 'diverged', 'local-ahead', 'up-to-date'] as const)
    .filter((k) => tally[k])
    .map((k) => `${tally[k]} ${k}`);
  return parts.length ? parts.join(', ') : 'nothing to merge';
}
