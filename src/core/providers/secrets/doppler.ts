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
  SecretsReadyResult,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { EnvbeamError, SafetyError } from '../../util/errors.js';
import { loadState } from '../../state.js';
import { threeWayMergeSecrets } from './threeWay.js';
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
      if (k.startsWith('ENVBEAM_')) continue; // skip envbeam bookkeeping (git remote/branch)
      values[k] = v == null ? '' : String(v);
    }
    const keys = Object.keys(values);
    return { count: keys.length, keys, values };
  }

  async materialize(ctx: ProviderContext, pulled: SecretsPullResult): Promise<MaterializeResult> {
    return materializeSecrets(ctx, pulled);
  }

  async ensureReady(ctx: ProviderContext): Promise<SecretsReadyResult> {
    const project = ctx.config.secrets?.project;
    // No project declared → rely on the repo's doppler.yaml scope; nothing to check.
    if (!project) return { ready: true };

    const env = dopplerEnv(ctx);
    const list = await ctx.runner.run('doppler', ['projects', '--json'], { env, allowFailure: true });
    if (list.code === 0) {
      try {
        const projects = JSON.parse(list.stdout) as Array<{ id?: string; name?: string }>;
        if (projects.some((p) => p.id === project || p.name === project)) {
          return { ready: true, detail: `Doppler project '${project}' already exists` };
        }
      } catch {
        /* fall through to create */
      }
    } else {
      // A scoped service token can read/write its own config's secrets but may
      // lack `projects list`/`create` permission. Don't block push/resume on
      // that — assume the project exists rather than trying (and failing) to
      // create it.
      return { ready: true, detail: 'could not verify Doppler project (assuming it exists)' };
    }

    const createCmd = `doppler projects create ${project}`;
    // The prompter encodes interactivity: a real terminal asks; a non-TTY run
    // auto-declines (unless `--yes`), so we never create silently or hang.
    const yes = await ctx.prompter.confirm(`Doppler project '${project}' doesn't exist. Create it now?`, true);
    if (!yes) {
      return { ready: false, detail: `project '${project}' not found`, hint: `Create it with \`${createCmd}\`.` };
    }
    const created = await ctx.runner.run('doppler', ['projects', 'create', project], { env, allowFailure: true });
    if (created.code !== 0) {
      return {
        ready: false,
        detail: created.stderr.trim() || created.stdout.trim() || `failed to create project '${project}'`,
        hint: `Create it manually with \`${createCmd}\`.`,
      };
    }
    ctx.logger.success(`Created Doppler project '${project}' (configs: dev, stg, prd).`);
    return { ready: true, created: true };
  }

  async recordMeta(ctx: ProviderContext, meta: Record<string, string>): Promise<{ ok: boolean; detail?: string }> {
    const pairs = Object.entries(meta).filter(([, v]) => v !== '' && v != null);
    if (!pairs.length) return { ok: true };
    if (ctx.dryRun) return { ok: true, detail: 'dry-run' };
    const res = await ctx.runner.run(
      'doppler',
      ['secrets', 'set', ...pairs.map(([k, v]) => `${k}=${v}`), ...projectArgs(ctx)],
      { cwd: ctx.workspaceRoot, env: dopplerEnv(ctx), allowFailure: true },
    );
    return res.code === 0
      ? { ok: true }
      : { ok: false, detail: res.stderr.trim() || res.stdout.trim() || `exit ${res.code}` };
  }

  async status(ctx: ProviderContext): Promise<SecretsStatus> {
    const mat = await readMaterialized(ctx);
    return {
      present: mat.present,
      count: mat.count,
      detail: mat.present ? `${mat.count} var(s) materialized` : 'no .env materialized yet',
    };
  }

  /**
   * Fold the provider's current secrets into ours. Returns the set to upload,
   * or null if the user declined to resolve a conflict.
   *
   * Conflicts are never resolved by a rule: a key both sides changed, to
   * different values, has no correct automatic answer. Non-interactive runs
   * refuse (`--yes` is not consent to discard a secret), and `--force` keeps the
   * local value while saying which keys it overwrote.
   */
  private async mergeWithRemote(
    ctx: ProviderContext,
    local: Record<string, string>,
  ): Promise<Record<string, string> | null> {
    const state = await loadState(ctx.workspaceRoot);

    let remote: Record<string, string>;
    try {
      remote = (await this.pull(ctx)).values;
    } catch (e) {
      ctx.logger.warn(`could not read current Doppler secrets to merge (${(e as Error).message}) — uploading local set`);
      return local;
    }
    for (const k of Object.keys(remote)) {
      if (k.startsWith('DOPPLER_') || k.startsWith('ENVBEAM_')) delete remote[k];
    }

    const result = threeWayMergeSecrets(state.secretsBase, local, remote);

    if (result.degraded && (result.conflicts.length || result.remoteWins.length)) {
      ctx.logger.warn('no recorded secrets base for this workspace — cannot tell which side changed a key.');
      ctx.logger.hint('Run `envbeam pull` once to record a base; until then differing keys are treated as conflicts.');
    }
    if (result.remoteWins.length) {
      ctx.logger.sub(`folding in ${result.remoteWins.length} key(s) changed in Doppler: ${result.remoteWins.join(', ')}`);
    }
    if (result.removedLocally.length) {
      ctx.logger.warn(
        `${result.removedLocally.length} key(s) are missing from your .env but still in Doppler: ${result.removedLocally.join(', ')}.`,
      );
      ctx.logger.hint('envbeam never deletes a provider secret. Remove them in Doppler if that was intended.');
    }

    if (!result.conflicts.length) return result.merged;

    const names = result.conflicts.map((c) => c.key);
    if (ctx.force) {
      ctx.logger.warn(`--force: keeping the local value for ${names.length} conflicting key(s): ${names.join(', ')}`);
      for (const c of result.conflicts) result.merged[c.key] = c.local;
      return result.merged;
    }
    if (!ctx.prompter.interactive) {
      throw new SafetyError(
        `${names.length} secret(s) changed both here and in Doppler since this machine last pulled: ${names.join(', ')}.`,
        'Re-run interactively to choose per key, or pass --force to keep the local values.',
      );
    }

    ctx.logger.warn(`${names.length} secret(s) changed on both sides since this machine last pulled.`);
    for (const c of result.conflicts) {
      const keep = await ctx.prompter.select(`Which value should "${c.key}" have?`, [
        { name: 'keep the value in Doppler', value: 'remote' },
        { name: 'use the value from your .env', value: 'local' },
        { name: 'cancel the secrets push', value: 'cancel' },
      ]);
      if (keep === 'cancel') return null;
      result.merged[c.key] = keep === 'local' ? c.local : c.remote;
    }
    return result.merged;
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
    // Filter out DOPPLER_ / ENVBEAM_ prefixed vars (provider + envbeam bookkeeping)
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (!k.startsWith('DOPPLER_') && !k.startsWith('ENVBEAM_')) filtered[k] = v;
    }

    if (Object.keys(filtered).length === 0) {
      return { count: 0, keys: [], action: 'noop', detail: 'no secrets to push' };
    }

    if (ctx.dryRun) {
      const n = Object.keys(filtered).length;
      return { count: n, keys: Object.keys(filtered), action: 'uploaded', detail: `would upload ${n} secret(s)` };
    }

    // Re-pull and merge before writing. Uploading `.env` wholesale meant a
    // machine whose file predates another's push would publish a set that never
    // saw the newer key (SYNC_SAFETY.md S1). Uploading the merged union is safe
    // whether `doppler secrets upload` replaces the config's secret set or
    // merges into it — we never depend on which.
    const merged = await this.mergeWithRemote(ctx, filtered);
    if (!merged) {
      return { count: 0, keys: [], action: 'skipped', detail: 'secrets merge declined' };
    }
    const keys = Object.keys(merged);

    // Write to temp file for upload
    const tmpFile = path.join(ctx.workspaceRoot, '.envbeam-push-tmp.env');
    const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
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
