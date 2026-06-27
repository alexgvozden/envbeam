import type {
  SessionProvider,
  SessionResult,
  SessionStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';

/** No-op session provider: session sync is disabled for this workspace. */
export class NoneSessionProvider implements SessionProvider {
  readonly name = 'none';
  readonly kind = 'session' as const;

  requiredTools(): ToolRequirement[] {
    return [];
  }

  async pull(_ctx: ProviderContext): Promise<SessionResult> {
    return { action: 'noop', detail: 'session sync disabled' };
  }

  async push(_ctx: ProviderContext): Promise<SessionResult> {
    return { action: 'noop', detail: 'session sync disabled' };
  }

  async status(): Promise<SessionStatus> {
    return { available: true, detail: 'session sync disabled' };
  }
}

export const noneSessionProviderFactory: ProviderFactory<SessionProvider> = {
  kind: 'session',
  name: 'none',
  create: () => new NoneSessionProvider(),
};
