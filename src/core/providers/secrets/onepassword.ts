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

function opEnv(ctx: ProviderContext): Record<string, string> {
  const env: Record<string, string> = { ...ctx.identity?.env };
  if (ctx.identity?.account) env.OP_ACCOUNT = ctx.identity.account;
  if (ctx.identity?.token) env.OP_SERVICE_ACCOUNT_TOKEN = ctx.identity.token;
  return env;
}

interface OpField {
  label?: string;
  value?: string;
  type?: string;
  purpose?: string;
}

/**
 * 1Password provider. Model: a single item (config: `secrets.item`) in a vault
 * (`secrets.vault`) whose fields are the env vars (label = KEY, value = value).
 * Shells out to the `op` CLI; never reads secret values into any envbeam store.
 */
export class OnePasswordSecretsProvider implements SecretsProvider {
  readonly name = 'onepassword';
  readonly kind = 'secrets' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'op',
        versionArgs: ['--version'],
        installHint: 'Install 1Password CLI: https://developer.1password.com/docs/cli/get-started/',
        authCheck: async (ctx) => {
          const res = await ctx.runner.run('op', ['whoami'], {
            allowFailure: true,
            env: opEnv(ctx),
          });
          return res.code === 0
            ? { ok: true }
            : { ok: false, detail: 'not signed in (run `op signin` or set a service-account token identity)' };
        },
      },
    ];
  }

  async pull(ctx: ProviderContext): Promise<SecretsPullResult> {
    const cfg = ctx.config.secrets;
    const item = cfg?.item;
    if (!item) {
      throw new EnvbeamError('onepassword provider requires `secrets.item` (the item holding env vars).', {
        exitCode: 2,
        hint: 'Set secrets.item (and optionally secrets.vault) in .envbeam.yaml.',
      });
    }
    const args = ['item', 'get', item, '--format', 'json'];
    if (cfg?.vault) args.push('--vault', cfg.vault);
    const res = await ctx.runner.run('op', args, {
      cwd: ctx.workspaceRoot,
      env: opEnv(ctx),
      allowFailure: true,
    });
    if (res.code !== 0) {
      throw new EnvbeamError(`op item get failed: ${res.stderr.trim() || res.stdout.trim()}`, {
        exitCode: 2,
        hint: 'Check the vault/item name and that the identity is authenticated.',
      });
    }
    let parsed: { fields?: OpField[] };
    try {
      parsed = JSON.parse(res.stdout || '{}');
    } catch {
      throw new EnvbeamError('op returned non-JSON output', { exitCode: 2 });
    }
    const values: Record<string, string> = {};
    for (const f of parsed.fields ?? []) {
      const label = f.label?.trim();
      if (!label) continue;
      // skip 1Password structural fields (username/password/notes carry a `purpose`)
      if (f.purpose) continue;
      if (f.value == null) continue;
      // only env-var-shaped labels become secrets
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) continue;
      values[label] = String(f.value);
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

export const onePasswordProviderFactory: ProviderFactory<SecretsProvider> = {
  kind: 'secrets',
  name: 'onepassword',
  identityType: 'onepassword',
  create: () => new OnePasswordSecretsProvider(),
};
