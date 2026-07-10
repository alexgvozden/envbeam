import type { CommandRunner } from './exec.js';

/** Local-vs-upstream state of a checkout, as seen before a pull runs. */
export interface LocalGitSync {
  isRepo: boolean;
  branch: string;
  hasUpstream: boolean;
  /** Commits on HEAD that the upstream does not have. */
  ahead: number;
  /** Commits on the upstream that HEAD does not have. */
  behind: number;
  dirtyFiles: string[];
  /** `<sha> <subject>` for up to 10 of the ahead commits, newest first. */
  aheadCommits: string[];
  remoteUrl?: string;
}

const EMPTY: LocalGitSync = {
  isRepo: false,
  branch: '',
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  dirtyFiles: [],
  aheadCommits: [],
};

/**
 * Inspect a checkout's divergence from its upstream. Fetches first (best
 * effort — an offline fetch leaves the counts based on the last known remote
 * refs rather than failing the caller).
 *
 * Every command allows failure: this runs on directories that may not be git
 * repos at all, and its job is to report, never to throw.
 */
export async function inspectLocalGit(
  runner: CommandRunner,
  dir: string,
  remote = 'origin',
): Promise<LocalGitSync> {
  const git = (args: string[]) => runner.run('git', args, { cwd: dir, allowFailure: true });

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { ...EMPTY };

  await git(['fetch', remote, '--prune']);

  const branchRes = await git(['branch', '--show-current']);
  const branch = branchRes.stdout.trim();

  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const hasUpstream = upstream.code === 0;

  let ahead = 0;
  let behind = 0;
  let aheadCommits: string[] = [];
  if (hasUpstream) {
    const counts = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (counts.code === 0) {
      const [b, a] = counts.stdout.trim().split(/\s+/);
      behind = Number(b ?? 0) || 0;
      ahead = Number(a ?? 0) || 0;
    }
    if (ahead > 0) {
      const log = await git(['log', '--oneline', '--no-decorate', '--max-count=10', '@{upstream}..HEAD']);
      if (log.code === 0) {
        aheadCommits = log.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      }
    }
  }

  const porcelain = await git(['status', '--porcelain']);
  const dirtyFiles = porcelain.stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^.. /, ''));

  const url = await git(['remote', 'get-url', remote]);
  const remoteUrl = url.code === 0 ? url.stdout.trim() || undefined : undefined;

  return { isRepo: true, branch, hasUpstream, ahead, behind, dirtyFiles, aheadCommits, remoteUrl };
}

/** True when the checkout holds work that is not on the upstream yet. */
export function hasUnsyncedWork(s: LocalGitSync): boolean {
  return s.isRepo && (s.ahead > 0 || s.dirtyFiles.length > 0);
}

/**
 * Compare two git remote URLs for identity, ignoring the shapes that address
 * the same repo: scp-style vs ssh://, a trailing `.git`, a trailing slash, and
 * case. Returns false when either side is missing.
 */
export function sameRemote(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeRemote(a) === normalizeRemote(b);
}

function normalizeRemote(url: string): string {
  let s = url.trim().toLowerCase();
  s = s.replace(/^ssh:\/\//, '');
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^git:\/\//, '');
  s = s.replace(/^[^@/]+@/, ''); // strip user@ (git@, user@)
  s = s.replace(/:(?=\D)/, '/'); // scp-style host:org/repo → host/org/repo
  s = s.replace(/\/+$/, ''); // before `.git`, so `…/repo.git/` normalizes too
  s = s.replace(/\.git$/, '');
  return s;
}
