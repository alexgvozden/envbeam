import path from 'node:path';
import type {
  ContainerProvider,
  ContainerStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { findComposeFile } from '../../detect/container.js';
import { ensureDockerRunning, isDockerDaemonUp } from '../../util/docker.js';
import { EnvbeamError } from '../../util/errors.js';

export async function resolveComposeFile(ctx: ProviderContext): Promise<string> {
  const configured = ctx.config.container?.composeFile;
  if (configured) return path.resolve(ctx.workspaceRoot, configured);
  const found = await findComposeFile(ctx.workspaceRoot);
  if (!found) {
    throw new EnvbeamError('No docker-compose file found for compose container mode.', {
      exitCode: 2,
      hint: 'Set container.composeFile in .envbeam.yaml or add a docker-compose.yml.',
    });
  }
  return found;
}

function composeArgs(file: string, rest: string[]): string[] {
  return ['compose', '-f', file, ...rest];
}

/** True when a command failed specifically because the Docker daemon is down. */
function isDaemonError(stderr: string): boolean {
  return /cannot connect to the docker daemon|is the docker daemon running|docker daemon/i.test(stderr);
}

/** Extract the host port from a "Bind for 0.0.0.0:5432 failed: port is already allocated" error. */
export function parsePortConflict(stderr: string): string | null {
  const m = stderr.match(/bind for [\d.:[\]]*:(\d+) failed: port is already allocated/i);
  return m?.[1] ?? null;
}

/** Tailor the failure hint to what actually went wrong (not a generic guess). */
function composeFailureHint(err: string): string {
  if (parsePortConflict(err)) {
    return `Another service holds port ${parsePortConflict(err)} — stop it (see above), or change the published port (e.g. POSTGRES_PORT) and re-run.`;
  }
  if (isDaemonError(err)) {
    return 'Ensure Docker is running (Docker Desktop / colima / OrbStack), then re-run.';
  }
  if (/pull access denied|manifest unknown|not found/i.test(err)) {
    return 'The image could not be pulled — check the image name/registry access in the compose file.';
  }
  return 'Run `envbeam --verbose pull` to see each command, or `docker compose up` directly for full output.';
}

export class ComposeContainerProvider implements ContainerProvider {
  readonly name = 'compose';
  readonly kind = 'container' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'docker',
        versionArgs: ['--version'],
        installHint: 'Install Docker: https://docs.docker.com/get-docker/',
        authCheck: async (ctx) =>
          (await isDockerDaemonUp(ctx)) ? { ok: true } : { ok: false, detail: 'docker daemon not running' },
      },
    ];
  }

  async up(ctx: ProviderContext): Promise<ContainerStatus> {
    const file = await resolveComposeFile(ctx);
    const service = ctx.config.container?.service;
    const rest = ['up', '-d', ...(service ? [service] : [])];
    if (ctx.dryRun) {
      ctx.logger.sub(`would run: docker compose -f ${path.relative(ctx.workspaceRoot, file)} ${rest.join(' ')}`);
      return this.status(ctx);
    }
    // Proactively make sure Docker is installed + running.
    await ensureDockerRunning(ctx);

    let res = await ctx.runner.run('docker', composeArgs(file, rest), {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });
    // Reactive backstop: if the daemon really was down (the check can be fooled
    // on some CLIs), the error says so — start Docker and retry once.
    if (res.code !== 0 && isDaemonError(res.stderr)) {
      ctx.logger.sub('Docker daemon unavailable — starting Docker and retrying…');
      await ensureDockerRunning(ctx, 120_000, true); // force: we saw a real daemon error
      res = await ctx.runner.run('docker', composeArgs(file, rest), {
        cwd: ctx.workspaceRoot,
        allowFailure: true,
      });
    }
    // Port conflict self-heal: find what holds the port, offer to stop it, retry.
    const conflictPort = res.code !== 0 ? parsePortConflict(res.stderr) : null;
    if (conflictPort && (await this.resolvePortConflict(ctx, conflictPort))) {
      res = await ctx.runner.run('docker', composeArgs(file, rest), {
        cwd: ctx.workspaceRoot,
        allowFailure: true,
      });
    }
    if (res.code !== 0) {
      const err = res.stderr.trim() || res.stdout.trim();
      throw new EnvbeamError(`docker compose up failed: ${err}`, {
        exitCode: 2,
        hint: composeFailureHint(err),
      });
    }
    return this.status(ctx);
  }

  /**
   * A published port is taken. Name the culprit (container, or host process via
   * lsof) and — for containers — offer to stop it so the stack can come up.
   * Returns true when the port was freed and a retry makes sense.
   */
  private async resolvePortConflict(ctx: ProviderContext, port: string): Promise<boolean> {
    // Another container publishing this port?
    const ps = await ctx.runner.run(
      'docker',
      ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}'],
      { allowFailure: true },
    );
    const [name, project] = (ps.stdout.trim().split(/\r?\n/)[0] ?? '').split('\t');
    if (ps.code === 0 && name) {
      const who = project ? `container '${name}' (compose project '${project}')` : `container '${name}'`;
      ctx.logger.sub(`port ${port} is already used by ${who}`);
      const stop = await ctx.prompter.confirm(`Stop ${who} to free port ${port} and retry?`, true);
      if (!stop) return false;
      const stopped = await ctx.runner.run('docker', ['stop', name], { allowFailure: true });
      if (stopped.code === 0) {
        ctx.logger.sub(`stopped '${name}' — retrying`);
        return true;
      }
      ctx.logger.warn(`could not stop '${name}': ${stopped.stderr.trim()}`);
      return false;
    }
    // A host process (e.g. brew postgres)? Name it so the user knows what to stop.
    if (process.platform !== 'win32') {
      const lsof = await ctx.runner.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { allowFailure: true });
      const line = lsof.stdout.trim().split(/\r?\n/)[1]; // skip header
      if (line) ctx.logger.warn(`port ${port} is held by a host process: ${line.split(/\s+/).slice(0, 2).join(' (pid ')})`);
    }
    return false;
  }

  async down(ctx: ProviderContext): Promise<void> {
    const file = await resolveComposeFile(ctx);
    if (ctx.dryRun) {
      ctx.logger.sub('would run: docker compose stop');
      return;
    }
    await ctx.runner.run('docker', composeArgs(file, ['stop']), {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });
  }

  async status(ctx: ProviderContext): Promise<ContainerStatus> {
    const file = await resolveComposeFile(ctx);
    const res = await ctx.runner.run('docker', composeArgs(file, ['ps', '--format', 'json']), {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });
    if (res.code !== 0) {
      return { running: false, services: [], detail: 'compose not up or docker unavailable' };
    }
    const services = parseComposePs(res.stdout);
    const running = services.some((s) => /running|up/i.test(s.state));
    return { running, services };
  }
}

/** Docker compose ps --format json emits either a JSON array or NDJSON. */
export function parseComposePs(stdout: string): Array<{ name: string; state: string }> {
  const text = stdout.trim();
  if (!text) return [];
  const rows: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows.push(...parsed);
    else rows.push(parsed);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* skip non-JSON line */
      }
    }
  }
  return rows.map((r) => ({
    name: String(r.Name ?? r.Service ?? ''),
    state: String(r.State ?? r.Status ?? 'unknown'),
  }));
}

export const composeProviderFactory: ProviderFactory<ContainerProvider> = {
  kind: 'container',
  name: 'compose',
  create: () => new ComposeContainerProvider(),
};
