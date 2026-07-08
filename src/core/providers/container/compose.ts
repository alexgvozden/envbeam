import path from 'node:path';
import type {
  ContainerProvider,
  ContainerStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { findComposeFile } from '../../detect/container.js';
import { ensureDockerRunning } from '../../util/docker.js';
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

export class ComposeContainerProvider implements ContainerProvider {
  readonly name = 'compose';
  readonly kind = 'container' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'docker',
        versionArgs: ['--version'],
        installHint: 'Install Docker: https://docs.docker.com/get-docker/',
        authCheck: async (ctx) => {
          const res = await ctx.runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], {
            allowFailure: true,
          });
          return res.code === 0 ? { ok: true } : { ok: false, detail: 'docker daemon not running' };
        },
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
    if (!(await ensureDockerRunning(ctx))) {
      throw new EnvbeamError('Docker daemon is not running and could not be started.', {
        exitCode: 2,
        hint: 'Start Docker Desktop (or the docker service), then re-run.',
      });
    }
    await ctx.runner.run('docker', composeArgs(file, rest), { cwd: ctx.workspaceRoot });
    return this.status(ctx);
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
