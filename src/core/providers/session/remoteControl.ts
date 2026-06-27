import type {
  SessionProvider,
  SessionResult,
  SessionStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';

const DOC_URL = 'https://docs.claude.com/en/docs/claude-code/remote';

/**
 * Documents Claude Code Remote Control as an alternative to file-based session
 * sync: one live session viewed from multiple surfaces. There is nothing to
 * push/pull — envbeam just surfaces the guidance (PRD §9).
 */
export class RemoteControlProvider implements SessionProvider {
  readonly name = 'remote-control';
  readonly kind = 'session' as const;

  requiredTools(): ToolRequirement[] {
    return [];
  }

  async pull(ctx: ProviderContext): Promise<SessionResult> {
    ctx.logger.sub(`Remote Control mode: resume your live session from this surface — ${DOC_URL}`);
    return { action: 'documented', detail: 'using Claude Code Remote Control (no file sync)' };
  }

  async push(ctx: ProviderContext): Promise<SessionResult> {
    ctx.logger.sub('Remote Control mode: your session stays live; nothing to push.');
    return { action: 'documented', detail: 'using Claude Code Remote Control (no file sync)' };
  }

  async status(): Promise<SessionStatus> {
    return { available: true, detail: `Remote Control mode (${DOC_URL})` };
  }
}

export const remoteControlProviderFactory: ProviderFactory<SessionProvider> = {
  kind: 'session',
  name: 'remote-control',
  create: () => new RemoteControlProvider(),
};
