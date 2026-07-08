import pc from 'picocolors';
import { RealCommandRunner } from '../core/util/exec.js';
import { createRegistryStore } from '../core/registry/index.js';
import { ensureStorageReady } from './storage.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface ListCliOptions extends GlobalCliOptions {
  json?: boolean;
}

/**
 * `envbeam list` — list all registered projects.
 */
export async function listCommand(opts: ListCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);

  return runCommand(logger, async () => {
    const runner = new RealCommandRunner();
    // Self-heal storage (install/auth Doppler, import S3 config) before listing.
    if (!(await ensureStorageReady({ runner, logger, prompter }))) return 1;

    const store = await createRegistryStore(runner);
    const projects = await store.listProjects();

    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return 0;
    }

    if (projects.length === 0) {
      logger.raw(pc.dim('No projects registered.'));
      logger.hint('Run `envbeam init` in a project to register it.');
      return 0;
    }

    logger.raw('');
    logger.raw(pc.bold('Registered Projects'));
    logger.raw('');

    // Table header
    const nameWidth = Math.max(20, ...projects.map((p) => p.name.length));
    const header = `${'NAME'.padEnd(nameWidth)}  ${'LAST PUSH'.padEnd(12)}  MACHINE`;
    logger.raw(pc.dim(header));
    logger.raw(pc.dim('─'.repeat(header.length + 10)));

    // Sort by last push (most recent first)
    const sorted = [...projects].sort(
      (a, b) => new Date(b.lastPush).getTime() - new Date(a.lastPush).getTime(),
    );

    for (const project of sorted) {
      const date = new Date(project.lastPush);
      const dateStr = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
      });

      const name = project.name.padEnd(nameWidth);
      const machine = project.machineId.split('-').slice(0, -1).join('-'); // Remove hash suffix

      logger.raw(`${pc.cyan(name)}  ${dateStr.padEnd(12)}  ${pc.dim(machine)}`);
    }

    logger.raw('');
    logger.raw(pc.dim(`${projects.length} project(s) total`));

    return 0;
  });
}
