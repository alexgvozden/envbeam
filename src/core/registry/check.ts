import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import type { RunContext } from '../pipeline/context.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { detectedValue } from '../detect/types.js';
import { getMachineId } from '../util/machine.js';
import { RegistryStore } from './store.js';
import type { ProjectEntryInput } from './types.js';

/**
 * Check if the current project is registered in the registry.
 * If not, prompt the user to register it.
 *
 * Returns true if registered (or user registered it), false if user declined.
 * Does nothing if storage is not configured.
 */
export async function checkProjectRegistration(ctx: RunContext): Promise<boolean> {
  const globalConfig = await loadGlobalConfig();

  // If storage not configured, skip silently
  if (!globalConfig.storage) {
    return true;
  }

  const store = new RegistryStore(globalConfig.storage, ctx.runner);
  const projectName = ctx.config.workspace;

  try {
    // Check if project is already registered
    const existing = await store.getProject(projectName);
    if (existing) {
      return true; // Already registered
    }
  } catch {
    // If we can't reach the registry, don't block the operation
    ctx.logger.sub(pc.dim('Could not check registry status.'));
    return true;
  }

  // Project exists locally but not registered - prompt to register
  ctx.logger.raw('');
  ctx.logger.raw(pc.yellow('!') + ` Project "${projectName}" exists locally but isn't registered.`);

  const confirm = await ctx.prompter.confirm(
    'Register it for cross-machine sync?',
    true,
  );

  if (!confirm) {
    ctx.logger.sub(pc.dim('Skipping registration.'));
    return false;
  }

  // Register the project
  try {
    const configContent = await fs.readFile(ctx.configPath, 'utf8');
    const machineId = await getMachineId();
    const gitRemote = detectedValue(ctx.detection, 'git.remoteUrl') ?? '';

    const entry: ProjectEntryInput = {
      name: projectName,
      gitRemote,
      gitBranch: ctx.config.git?.branch ?? 'main',
      configSnapshot: configContent,
      lastPush: new Date().toISOString(),
      machineId,
      syncTarget: ctx.config.database?.sync
        ? {
            target: ctx.config.database.sync.target,
            bucket: ctx.config.database.sync.bucket,
            prefix: ctx.config.database.sync.prefix,
            region: ctx.config.database.sync.region,
          }
        : undefined,
    };

    await store.registerProject(entry);
    ctx.logger.success(`Registered "${projectName}" in project registry.`);
    return true;
  } catch (err) {
    ctx.logger.warn(`Could not register project: ${(err as Error).message}`);
    return false;
  }
}
