import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  SecretsProvider,
  SecretsPullResult,
  SecretsStatus,
  MaterializeResult,
  SecretsPushResult,
  SecretsSetupResult,
  SecretsSetupOptions,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { EnvbeamError } from '../../util/errors.js';
import { materializeSecrets, readMaterialized, parseDotenv } from './materialize.js';

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

  async push(ctx: ProviderContext): Promise<SecretsPushResult> {
    const cfg = ctx.config.secrets;
    const envPath = path.join(ctx.workspaceRoot, cfg?.dotenvPath ?? '.env');

    let text: string;
    try {
      text = await fs.readFile(envPath, 'utf8');
    } catch {
      return { count: 0, keys: [], action: 'skipped', detail: 'no .env file to push' };
    }

    const secrets = parseDotenv(text);
    // Filter out DOPPLER_ prefixed vars
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (!k.startsWith('DOPPLER_')) filtered[k] = v;
    }

    const keys = Object.keys(filtered);
    if (keys.length === 0) {
      return { count: 0, keys: [], action: 'noop', detail: 'no secrets to push' };
    }

    if (ctx.dryRun) {
      return { count: keys.length, keys, action: 'uploaded', detail: `would upload ${keys.length} secret(s)` };
    }

    // Write to temp file for upload
    const tmpFile = path.join(ctx.workspaceRoot, '.envbeam-push-tmp.env');
    const lines = Object.entries(filtered).map(([k, v]) => `${k}=${v}`);
    await fs.writeFile(tmpFile, lines.join('\n'), { mode: 0o600 });

    try {
      const res = await ctx.runner.run(
        'doppler',
        ['secrets', 'upload', tmpFile, ...projectArgs(ctx)],
        { cwd: ctx.workspaceRoot, env: dopplerEnv(ctx), allowFailure: true },
      );
      if (res.code !== 0) {
        throw new EnvbeamError(`doppler secrets upload failed: ${res.stderr.trim() || res.stdout.trim()}`, {
          exitCode: 2,
        });
      }
      return { count: keys.length, keys, action: 'uploaded', detail: `uploaded ${keys.length} secret(s) to Doppler` };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  async setup(ctx: ProviderContext, opts: SecretsSetupOptions): Promise<SecretsSetupResult> {
    const env = dopplerEnv(ctx);
    const { project, config } = opts;

    // Check if project exists
    const listRes = await ctx.runner.run(
      'doppler',
      ['projects', '--json'],
      { env, allowFailure: true },
    );
    let projectExists = false;
    if (listRes.code === 0) {
      try {
        const projects = JSON.parse(listRes.stdout) as Array<{ id: string; name: string }>;
        projectExists = projects.some((p) => p.id === project || p.name === project);
      } catch { /* ignore */ }
    }

    // Create project if it doesn't exist
    if (!projectExists) {
      if (ctx.dryRun) {
        ctx.logger.info(`Would create Doppler project: ${project}`);
      } else {
        const createRes = await ctx.runner.run(
          'doppler',
          ['projects', 'create', project],
          { env, allowFailure: true },
        );
        if (createRes.code !== 0) {
          throw new EnvbeamError(`Failed to create Doppler project: ${createRes.stderr.trim()}`, { exitCode: 2 });
        }
        ctx.logger.success(`Created Doppler project: ${project}`);
      }
    }

    // Set up doppler.yaml in workspace
    if (!ctx.dryRun) {
      const setupRes = await ctx.runner.run(
        'doppler',
        ['setup', '--project', project, '--config', config, '--no-interactive'],
        { cwd: ctx.workspaceRoot, env, allowFailure: true },
      );
      if (setupRes.code !== 0) {
        throw new EnvbeamError(`Failed to configure Doppler: ${setupRes.stderr.trim()}`, { exitCode: 2 });
      }
    }

    // Import from .env if requested
    let imported = 0;
    if (opts.importEnv) {
      const envPath = path.join(ctx.workspaceRoot, '.env');
      try {
        const text = await fs.readFile(envPath, 'utf8');
        const secrets = parseDotenv(text);
        const filtered: Record<string, string> = {};
        for (const [k, v] of Object.entries(secrets)) {
          if (!k.startsWith('DOPPLER_')) filtered[k] = v;
        }
        imported = Object.keys(filtered).length;

        if (imported > 0 && !ctx.dryRun) {
          const tmpFile = path.join(ctx.workspaceRoot, '.envbeam-import-tmp.env');
          const lines = Object.entries(filtered).map(([k, v]) => `${k}=${v}`);
          await fs.writeFile(tmpFile, lines.join('\n'), { mode: 0o600 });
          try {
            await ctx.runner.run(
              'doppler',
              ['secrets', 'upload', tmpFile, '--project', project, '--config', config],
              { cwd: ctx.workspaceRoot, env, allowFailure: false },
            );
          } finally {
            await fs.unlink(tmpFile).catch(() => {});
          }
          ctx.logger.success(`Imported ${imported} secret(s) from .env to Doppler`);
        }
      } catch {
        // No .env to import, that's fine
      }
    }

    return {
      created: !projectExists,
      project,
      config,
      imported,
      detail: projectExists
        ? `Configured existing project ${project}/${config}`
        : `Created and configured ${project}/${config}`,
    };
  }
}

export const dopplerProviderFactory: ProviderFactory<SecretsProvider> = {
  kind: 'secrets',
  name: 'doppler',
  identityType: 'doppler',
  create: () => new DopplerSecretsProvider(),
};
