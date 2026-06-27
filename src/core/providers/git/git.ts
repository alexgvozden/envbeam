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
  const g = ctx.config.git ?? {};
  return {
    remote: g.remote ?? 'origin',
    branch: g.branch ?? 'current',
    autopush: g.autopush ?? true,
    autopull: g.autopull ?? 'ff-only',
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
    const dirtyFiles = porcelain.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^..\s+/, ''));

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

    return { branch, ahead, behind, dirtyFiles, hasUpstream, remoteUrl };
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

    if (st.dirtyFiles.length > 0) {
      if (opts.workMode === 'commit') {
        if (ctx.dryRun) {
          ctx.logger.sub(`would commit ${st.dirtyFiles.length} file(s)`);
        } else {
          await git(ctx, ['add', '-A']);
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
      return { committed, stashed, pushed: false, detail: 'autopush: false' };
    }

    if (ctx.dryRun) {
      ctx.logger.sub(`would push ${branch} to ${cfg.remote}`);
      return { committed, stashed, pushed: false, detail: 'dry-run' };
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
    return { committed, stashed, pushed: true, detail: `pushed ${branch} → ${cfg.remote}` };
  }
}

export const gitProviderFactory: ProviderFactory<GitProvider> = {
  kind: 'git',
  name: 'git',
  identityType: 'git',
  create: () => new GitProviderImpl(),
};
