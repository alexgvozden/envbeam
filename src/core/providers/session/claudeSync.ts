import type {
  SessionProvider,
  SessionResult,
  SessionStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';

/**
 * Wraps the `claude-sync` CLI for independent-machine handoff of Claude Code
 * sessions. envbeam delegates session storage and path translation to
 * claude-sync (PRD §9); it only invokes push/pull scoped to this workspace.
 */
export class ClaudeSyncProvider implements SessionProvider {
  readonly name = 'claude-sync';
  readonly kind = 'session' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'claude-sync',
        versionArgs: ['--version'],
        installHint:
          'Install claude-sync (Claude Code session sync) and authenticate it; see its README.',
      },
    ];
  }

  private baseArgs(ctx: ProviderContext): string[] {
    const args = ['--path', ctx.workspaceRoot];
    const scope = ctx.config.session?.scope;
    if (scope) args.push('--scope', scope);
    const remotePath = ctx.config.session?.remotePath;
    if (remotePath) args.push('--remote-path', remotePath);
    return args;
  }

  async pull(ctx: ProviderContext): Promise<SessionResult> {
    if (ctx.dryRun) {
      ctx.logger.sub('would run: claude-sync pull');
      return { action: 'noop', detail: 'dry-run' };
    }
    const res = await ctx.runner.run('claude-sync', ['pull', ...this.baseArgs(ctx)], {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });
    if (res.code !== 0) {
      return { action: 'noop', detail: `claude-sync pull failed: ${res.stderr.trim()}` };
    }
    return { action: 'pulled', detail: 'session pulled for this workspace' };
  }

  async push(ctx: ProviderContext): Promise<SessionResult> {
    if (ctx.dryRun) {
      ctx.logger.sub('would run: claude-sync push');
      return { action: 'noop', detail: 'dry-run' };
    }
    const res = await ctx.runner.run('claude-sync', ['push', ...this.baseArgs(ctx)], {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });
    if (res.code !== 0) {
      return { action: 'noop', detail: `claude-sync push failed: ${res.stderr.trim()}` };
    }
    return { action: 'pushed', detail: 'session pushed outward' };
  }

  async status(ctx: ProviderContext): Promise<SessionStatus> {
    const present = (await ctx.runner.which('claude-sync')) != null;
    return {
      available: present,
      detail: present ? 'claude-sync available' : 'claude-sync not installed',
    };
  }
}

export const claudeSyncProviderFactory: ProviderFactory<SessionProvider> = {
  kind: 'session',
  name: 'claude-sync',
  create: () => new ClaudeSyncProvider(),
};
