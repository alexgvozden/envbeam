import type {
  ContainerProvider,
  ContainerStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import { ensureDockerRunning, isDockerDaemonUp } from '../../util/docker.js';

const FOLDER_LABEL = 'devcontainer.local_folder';

/**
 * Dev Containers provider. Shells out to the `devcontainer` CLI to bring the
 * environment up; uses docker labels to inspect/stop the running container
 * (the CLI has no first-class `down`).
 */
export class DevcontainerProvider implements ContainerProvider {
  readonly name = 'devcontainer';
  readonly kind = 'container' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'devcontainer',
        versionArgs: ['--version'],
        installHint: 'Install the Dev Containers CLI: npm i -g @devcontainers/cli',
      },
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
    if (ctx.dryRun) {
      ctx.logger.sub(`would run: devcontainer up --workspace-folder ${ctx.workspaceRoot}`);
      return this.status(ctx);
    }
    await ensureDockerRunning(ctx);
    const res = await ctx.runner.run(
      'devcontainer',
      ['up', '--workspace-folder', ctx.workspaceRoot],
      { cwd: ctx.workspaceRoot, allowFailure: true },
    );
    if (res.code !== 0) {
      return { running: false, services: [], detail: `devcontainer up failed: ${res.stderr.trim()}` };
    }
    return this.status(ctx);
  }

  async down(ctx: ProviderContext): Promise<void> {
    const ids = await this.containerIds(ctx);
    if (ctx.dryRun) {
      ctx.logger.sub(`would stop ${ids.length} devcontainer container(s)`);
      return;
    }
    for (const id of ids) {
      await ctx.runner.run('docker', ['stop', id], { allowFailure: true });
    }
  }

  async status(ctx: ProviderContext): Promise<ContainerStatus> {
    const ids = await this.containerIds(ctx);
    if (ids.length === 0) {
      return { running: false, services: [], detail: 'no devcontainer running for this workspace' };
    }
    return {
      running: true,
      services: ids.map((id) => ({ name: id.slice(0, 12), state: 'running' })),
    };
  }

  private async containerIds(ctx: ProviderContext): Promise<string[]> {
    const res = await ctx.runner.run(
      'docker',
      ['ps', '-q', '--filter', `label=${FOLDER_LABEL}=${ctx.workspaceRoot}`],
      { allowFailure: true },
    );
    if (res.code !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
}

export const devcontainerProviderFactory: ProviderFactory<ContainerProvider> = {
  kind: 'container',
  name: 'devcontainer',
  create: () => new DevcontainerProvider(),
};
