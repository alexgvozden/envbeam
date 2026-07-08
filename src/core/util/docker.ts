import os from 'node:os';
import pc from 'picocolors';
import type { ProviderContext } from '../providers/types.js';
import { ensureTools } from './tools.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the Docker daemon is reachable right now. */
async function daemonUp(ctx: ProviderContext): Promise<boolean> {
  const res = await ctx.runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    allowFailure: true,
  });
  return res.code === 0;
}

/** Best-effort command to launch the Docker daemon for this platform. */
function startDockerCommand(): { command: string; args: string[] } | null {
  switch (os.platform()) {
    case 'darwin':
      return { command: 'open', args: ['-a', 'Docker'] }; // Docker Desktop.app
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', 'Docker Desktop'] };
    case 'linux':
      // Try system then user service; needs privileges, so best-effort.
      return {
        command: 'sh',
        args: ['-c', 'sudo systemctl start docker 2>/dev/null || systemctl --user start docker 2>/dev/null || true'],
      };
    default:
      return null;
  }
}

/**
 * Ensure Docker is installed AND its daemon is running before we shell out to
 * `docker`. If the CLI is missing, install it for the user (per the auto-install
 * rule). If the daemon is down, start Docker Desktop (or the service) and wait
 * for it to become ready — self-healing rather than failing with "command not
 * found" or "Is the docker daemon running?". Returns true when Docker is usable.
 * No-op in dry-run. Skipped silently on unknown platforms.
 */
export async function ensureDockerRunning(ctx: ProviderContext, timeoutMs = 120_000): Promise<boolean> {
  // 1) Installed? Install it for the user if not (prompts via ensureTools).
  if (!(await ctx.runner.which('docker'))) {
    if (ctx.dryRun) return true;
    ctx.logger.sub('Docker is not installed — installing…');
    const res = await ensureTools(['docker'], ctx.runner, ctx.logger, ctx.prompter);
    if (!res.allInstalled && !(await ctx.runner.which('docker'))) return false;
  }

  // 2) Daemon up?
  if (await daemonUp(ctx)) return true;
  if (ctx.dryRun) return true;

  const start = startDockerCommand();
  if (!start) return false;

  ctx.logger.sub('Docker daemon not running — starting Docker…');
  await ctx.runner.run(start.command, start.args, { allowFailure: true });

  const startedAt = Date.now();
  let waited = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(2000);
    waited += 2;
    if (await daemonUp(ctx)) {
      ctx.logger.sub(pc.dim(`Docker is ready (after ${waited}s).`));
      return true;
    }
    if (waited % 10 === 0) ctx.logger.sub(pc.dim(`  waiting for Docker to start… (${waited}s)`));
  }
  return false;
}
