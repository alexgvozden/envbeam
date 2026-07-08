import path from 'node:path';
import { promises as fs, type Dirent } from 'node:fs';

/** Directories never worth descending into when scanning a workspace. */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  'vendor',
  '.terraform',
  '.idea',
  '.vscode',
  '.claude',
  'coverage',
  '.cache',
]);

export interface ShallowScanOptions {
  /** How many directory levels below the root to descend (0 = root only). */
  maxDepth?: number;
  /** Extra directory names to skip beyond the built-in ignore list. */
  ignore?: Iterable<string>;
  /**
   * Directory basenames to visit first, in the order given, when several
   * candidates sit at the same depth. Lets callers prefer dev-oriented
   * locations (e.g. `infra/`) over deploy/prod ones. Directories not listed
   * are visited afterwards, alphabetically.
   */
  preferDirs?: readonly string[];
}

/**
 * Breadth-first collection of ALL files whose basename is in `names`, scanning
 * the root and up to `maxDepth` levels of subdirectories (same ignore rules as
 * findFileShallow). Returns absolute paths, shallowest first, deterministic.
 */
export async function findFilesShallow(
  root: string,
  names: readonly string[],
  opts: ShallowScanOptions = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 2;
  const ignore = new Set(IGNORE_DIRS);
  for (const extra of opts.ignore ?? []) ignore.add(extra);
  const wanted = new Set(names);
  const found: string[] = [];

  let frontier: string[] = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const nextFrontier: string[] = [];
    for (const dir of frontier) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth < maxDepth && !ignore.has(entry.name)) {
            nextFrontier.push(path.join(dir, entry.name));
          }
        } else if (entry.isFile() && wanted.has(entry.name)) {
          found.push(path.join(dir, entry.name));
        }
      }
    }
    frontier = nextFrontier.sort();
  }
  return found;
}

/**
 * Breadth-first search for the first file whose basename is in `names`,
 * scanning the root and up to `maxDepth` levels of subdirectories.
 *
 * Shallower matches win over deeper ones (a root-level `compose.yml` beats
 * `infra/compose.yml`); within a level, directories are visited in sorted
 * order and `names` in the order given, so the result is deterministic.
 * Well-known vendor/build directories are skipped (see IGNORE_DIRS).
 */
export async function findFileShallow(
  root: string,
  names: readonly string[],
  opts: ShallowScanOptions = {},
): Promise<string | null> {
  const maxDepth = opts.maxDepth ?? 2;
  const ignore = new Set(IGNORE_DIRS);
  for (const extra of opts.ignore ?? []) ignore.add(extra);

  const prefer = opts.preferDirs ?? [];
  const rankOf = (dirPath: string): number => {
    const idx = prefer.indexOf(path.basename(dirPath));
    return idx === -1 ? prefer.length : idx;
  };
  const byPreference = (a: string, b: string): number =>
    rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);

  // Each BFS level is fully checked for a match before descending, so the
  // shallowest hit is returned.
  let frontier: string[] = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const nextFrontier: string[] = [];
    for (const dir of frontier) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const fileNames = new Set<string>();
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth < maxDepth && !ignore.has(entry.name)) {
            nextFrontier.push(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          fileNames.add(entry.name);
        }
      }
      for (const name of names) {
        if (fileNames.has(name)) return path.join(dir, name);
      }
    }
    frontier = nextFrontier.sort(byPreference);
  }
  return null;
}
