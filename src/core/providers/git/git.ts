import type {
  GitProvider,
  GitStatus,
  GitPullResult,
  GitPushOptions,
  GitPushResult,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { SafetyError } from '../../util/errors.js';

function gitConfig(ctx: ProviderContext) {
  const g = ctx.config.git;
  return {
    remote: g?.remote ?? 'origin',
    branch: g?.branch ?? 'current',
    autopush: g?.autopush ?? true,
    autopull: g?.autopull ?? 'ff-only',
  };
}

async function git(ctx: ProviderContext, args: string[], allowFailure = false) {
  const env: Record<string, string> = { ...ctx.identity?.env };
  return ctx.runner.run('git', args, {
    cwd: ctx.workspaceRoot,
    allowFailure,
    env: Object.keys(env).length ? env : undefined,
  });
}

async function resolveBranch(ctx: ProviderContext): Promise<string> {
  const cfg = gitConfig(ctx);
  if (cfg.branch && cfg.branch !== 'current') return cfg.branch;
  // `git branch --show-current` works on an unborn branch (no commits yet) and
  // returns empty when detached; fall back to symbolic-ref, then HEAD.
  const shown = await git(ctx, ['branch', '--show-current'], true);
  if (shown.code === 0 && shown.stdout.trim()) return shown.stdout.trim();
  const sym = await git(ctx, ['symbolic-ref', '--short', 'HEAD'], true);
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
  return 'HEAD';
}

/**
 * Whether `ancestor` is reachable from `descendant` — git's own definition of
 * "this state descends from that one", and the only decidable lineage test
 * envbeam has (SYNC_SAFETY.md §10.4). Anchoring a checkpoint's other artifacts
 * to a commit sha lets `pull` verify that the code it is about to restore data
 * *into* actually contains the migrations that data expects.
 *
 * Returns false when either sha is unknown to this repo, which is the safe
 * answer: an unreachable commit is not an ancestor.
 */
export async function gitIsAncestor(
  ctx: ProviderContext,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(ancestor) || !/^[0-9a-f]{7,40}$/i.test(descendant)) return false;
  const res = await git(ctx, ['merge-base', '--is-ancestor', ancestor, descendant], true);
  return res.code === 0;
}

/** Whether the repo has an object for `sha` at all (it may need fetching). */
export async function gitHasCommit(ctx: ProviderContext, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  const res = await git(ctx, ['cat-file', '-e', `${sha}^{commit}`], true);
  return res.code === 0;
}

export class GitProviderImpl implements GitProvider {
  readonly name = 'git';
  readonly kind = 'git' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'git',
        versionArgs: ['--version'],
        installHint: 'Install git: https://git-scm.com/downloads',
      },
    ];
  }

  async status(ctx: ProviderContext): Promise<GitStatus> {
    const branch = await resolveBranch(ctx);
    const cfg = gitConfig(ctx);

    const porcelain = await git(ctx, ['status', '--porcelain']);
    // Porcelain v1 lines are "XY <path>"; the 2-char status prefix carries
    // meaningful leading spaces, so strip exactly "XY " without trimming first.
    const statusLines = porcelain.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    const dirtyFiles = statusLines.map((l) => l.replace(/^.. /, ''));
    const untrackedFiles = statusLines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));

    const upstream = await git(
      ctx,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      true,
    );
    const hasUpstream = upstream.code === 0;

    let ahead = 0;
    let behind = 0;
    if (hasUpstream) {
      const counts = await git(ctx, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], true);
      if (counts.code === 0) {
        const [b, a] = counts.stdout.trim().split(/\s+/);
        behind = Number(b ?? 0) || 0;
        ahead = Number(a ?? 0) || 0;
      }
    }

    let remoteUrl: string | undefined;
    const url = await git(ctx, ['remote', 'get-url', cfg.remote], true);
    if (url.code === 0) remoteUrl = url.stdout.trim();

    // Fails on an unborn branch — a repo with no commits has no HEAD to name.
    let commit: string | undefined;
    const head = await git(ctx, ['rev-parse', 'HEAD'], true);
    if (head.code === 0 && /^[0-9a-f]{40}$/i.test(head.stdout.trim())) commit = head.stdout.trim();

    return { branch, ahead, behind, dirtyFiles, untrackedFiles, hasUpstream, remoteUrl, commit };
  }

  async pull(ctx: ProviderContext): Promise<GitPullResult> {
    const cfg = gitConfig(ctx);
    if (cfg.autopull === 'off') return { action: 'skipped', detail: 'autopull: off' };

    if (ctx.dryRun) {
      ctx.logger.sub(`would fetch ${cfg.remote} and fast-forward if clean`);
      return { action: 'skipped', detail: 'dry-run' };
    }

    await git(ctx, ['fetch', cfg.remote, '--prune'], true);
    const st = await this.status(ctx);

    if (!st.hasUpstream) return { action: 'skipped-no-upstream', detail: 'no tracking branch' };
    if (st.behind === 0) return { action: 'up-to-date' };
    if (st.dirtyFiles.length > 0) {
      return {
        action: 'skipped-dirty',
        detail: `${st.dirtyFiles.length} uncommitted file(s); not auto-merging`,
      };
    }
    const merge = await git(ctx, ['merge', '--ff-only', '@{upstream}'], true);
    if (merge.code !== 0) {
      return { action: 'skipped', detail: `cannot fast-forward: ${merge.stderr.trim()}` };
    }
    return { action: 'fast-forwarded', detail: `pulled ${st.behind} commit(s)` };
  }

  async pushWork(ctx: ProviderContext, opts: GitPushOptions): Promise<GitPushResult> {
    const cfg = gitConfig(ctx);
    const branch = await resolveBranch(ctx);
    const st = await this.status(ctx);

    let committed = false;
    let stashed = false;
    let untrackedLeftBehind: string[] | undefined;

    if (st.dirtyFiles.length > 0) {
      if (opts.workMode === 'commit') {
        // `add -A` sweeps untracked files into a commit that is then PUSHED. An
        // `api-key.txt` nobody remembered to gitignore ends up in the remote's
        // history, and history is not something envbeam can take back. Stage
        // untracked files only when the caller says so, having shown them.
        const stage = opts.includeUntracked ? ['add', '-A'] : ['add', '-u'];
        const tracked = st.dirtyFiles.length - st.untrackedFiles.length;
        if (!opts.includeUntracked && st.untrackedFiles.length) {
          untrackedLeftBehind = st.untrackedFiles;
        }
        if (tracked === 0 && !opts.includeUntracked) {
          ctx.logger.sub('nothing to commit (only untracked files, which are not swept in)');
        } else if (ctx.dryRun) {
          ctx.logger.sub(`would commit ${opts.includeUntracked ? st.dirtyFiles.length : tracked} file(s)`);
        } else {
          await git(ctx, stage);
          await git(ctx, ['commit', '-m', opts.message ?? 'envbeam: pause checkpoint']);
          committed = true;
        }
      } else if (opts.workMode === 'stash') {
        if (ctx.dryRun) {
          ctx.logger.sub(`would stash ${st.dirtyFiles.length} file(s)`);
        } else {
          await git(ctx, ['stash', 'push', '-u', '-m', opts.message ?? 'envbeam: pause stash']);
          stashed = true;
        }
      } else if (!opts.force) {
        if (ctx.dryRun) {
          ctx.logger.warn(
            `${st.dirtyFiles.length} uncommitted file(s) would block pause — use --commit/--stash/--force.`,
          );
        } else {
          throw new SafetyError(
            `${st.dirtyFiles.length} uncommitted file(s) would not be carried over.`,
            'Re-run pause and choose commit/stash, or pass --force to push without them.',
          );
        }
      }
    }

    if (!cfg.autopush) {
      return { committed, stashed, pushed: false, detail: 'autopush: false', untrackedLeftBehind };
    }

    if (ctx.dryRun) {
      ctx.logger.sub(`would push ${branch} to ${cfg.remote}`);
      return { committed, stashed, pushed: false, detail: 'dry-run', untrackedLeftBehind };
    }

    const pushArgs = st.hasUpstream
      ? ['push', cfg.remote, branch]
      : ['push', '-u', cfg.remote, branch];
    const push = await git(ctx, pushArgs, true);
    if (push.code !== 0) {
      if (/non-fast-forward|rejected/i.test(push.stderr) && !opts.force) {
        throw new SafetyError(
          `Push of ${branch} was rejected (remote has commits you don't).`,
          'Pull/rebase first, or resolve manually. envbeam never force-pushes automatically.',
        );
      }
      throw new SafetyError(`git push failed: ${push.stderr.trim()}`);
    }
    return { committed, stashed, pushed: true, detail: `pushed ${branch} → ${cfg.remote}`, untrackedLeftBehind };
  }
}

export const gitProviderFactory: ProviderFactory<GitProvider> = {
  kind: 'git',
  name: 'git',
  identityType: 'git',
  create: () => new GitProviderImpl(),
};
