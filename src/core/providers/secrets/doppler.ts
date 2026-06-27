import type {
  SecretsProvider,
  SecretsPullResult,
  SecretsStatus,
  MaterializeResult,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { EnvbeamError } from '../../util/errors.js';
import { materializeSecrets, readMaterialized } from './materialize.js';

function dopplerEnv(ctx: ProviderContext): Record<string, string> {
  const env: Record<string, string> = { ...ctx.identity?.env };
  if (ctx.identity?.token) env.DOPPLER_TOKEN = ctx.identity.token;
  return env;
}

function projectArgs(ctx: ProviderContext): string[] {
  const cfg = ctx.config.secrets;
  const args: string[] = [];
  if (cfg?.project) args.push('--project', cfg.project);
  if (cfg?.config) args.push('--config', cfg.config);
  return args;
}

export class DopplerSecretsProvider implements SecretsProvider {
  readonly name = 'doppler';
  readonly kind = 'secrets' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'doppler',
        versionArgs: ['--version'],
        installHint: 'Install Doppler CLI: https://docs.doppler.com/docs/cli',
        authCheck: async (ctx) => {
          const res = await ctx.runner.run('doppler', ['me', '--json'], {
            allowFailure: true,
            env: dopplerEnv(ctx),
          });
          return res.code === 0
            ? { ok: true }
            : { ok: false, detail: 'not logged in (run `doppler login` or set a token identity)' };
        },
      },
    ];
  }

  async pull(ctx: ProviderContext): Promise<SecretsPullResult> {
    const res = await ctx.runner.run(
      'doppler',
      ['secrets', 'download', '--no-file', '--format', 'json', ...projectArgs(ctx)],
      { cwd: ctx.workspaceRoot, env: dopplerEnv(ctx), allowFailure: true },
    );
    if (res.code !== 0) {
      throw new EnvbeamError(`doppler secrets download failed: ${res.stderr.trim() || res.stdout.trim()}`, {
        exitCode: 2,
        hint: 'Check the project/config and that the identity is authenticated (`envbeam identity test`).',
      });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(res.stdout || '{}');
    } catch {
      throw new EnvbeamError('doppler returned non-JSON output', { exitCode: 2 });
    }
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('DOPPLER_')) continue; // skip provider metadata vars
      values[k] = v == null ? '' : String(v);
    }
    const keys = Object.keys(values);
    return { count: keys.length, keys, values };
  }

  async materialize(ctx: ProviderContext, pulled: SecretsPullResult): Promise<MaterializeResult> {
    return materializeSecrets(ctx, pulled);
  }

  async status(ctx: ProviderContext): Promise<SecretsStatus> {
    const mat = await readMaterialized(ctx);
    return {
      present: mat.present,
      count: mat.count,
      detail: mat.present ? `${mat.count} var(s) materialized` : 'no .env materialized yet',
    };
  }
}

export const dopplerProviderFactory: ProviderFactory<SecretsProvider> = {
  kind: 'secrets',
  name: 'doppler',
  identityType: 'doppler',
  create: () => new DopplerSecretsProvider(),
};
