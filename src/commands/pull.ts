import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import { buildRunContext } from '../core/pipeline/context.js';
import { runResume } from '../core/pipeline/resume.js';
import { RealCommandRunner } from '../core/util/exec.js';
import { pathExists } from '../core/util/fs.js';
import { EnvbeamError } from '../core/util/errors.js';
import { createRegistryStore, checkProjectRegistration } from '../core/registry/index.js';
import { ensureStorageReady } from './storage.js';
import { WORKSPACE_CONFIG_NAME } from '../core/config/paths.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface PullCliOptions extends GlobalCliOptions {
  /** Project name to pull (bootstrap mode). */
  project?: string;
  /** Directory to clone into (bootstrap mode). */
  dir?: string;
}

/**
 * Reject a registry-supplied git remote that could make git execute a command
 * or be read as a flag. Allows normal scp-style (`git@host:org/repo`) and
 * http(s)/ssh/git URLs; blocks `ext::`, `file://`, other `<transport>::` forms,
 * and leading `-`.
 */
export function assertSafeGitRemote(remote: string): void {
  const bad =
    remote.startsWith('-') ||
    /^[a-z][a-z0-9+.-]*::/i.test(remote) || // ext::, transport helper forms
    /^(file|ext|fd):/i.test(remote);
  const ok = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@|[a-z0-9.-]+@[a-z0-9.-]+:)/i.test(remote);
  if (bad || !ok) {
    throw new EnvbeamError(`Refusing to clone an unsafe git remote: ${remote}`, {
      exitCode: 2,
      hint: 'The stored remote must be an https/ssh/git URL or a scp-style host:path.',
    });
  }
}

/** A branch value safe to pass to `git checkout` (no flag/injection surface). */
export function isSafeGitBranch(branch: string): boolean {
  return !branch.startsWith('-') && /^[A-Za-z0-9._/-]+$/.test(branch);
}

export async function pullCommand(opts: PullCliOptions): Promise<number> {
  const logger = makeLogger(opts);

  // If project name is provided, run bootstrap mode
  if (opts.project) {
    return bootstrapPullCommand(opts.project, opts);
  }

  // Standard pull in current workspace
  return runCommand(logger, async () => {
    const ctx = await buildRunContext({
      dryRun: opts.dryRun,
      logger,
      prompter: makePrompter(opts),
    });

    // Check if project is registered, prompt to register if not
    await checkProjectRegistration(ctx);

    await runResume(ctx);
    return 0;
  });
}

/**
 * Bootstrap pull: clone a project by name and set it up.
 */
async function bootstrapPullCommand(projectName: string, opts: PullCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);
  const runner = new RealCommandRunner();

  return runCommand(logger, async () => {
    // Self-heal storage (install/auth Doppler, import S3 config) before pulling.
    if (!(await ensureStorageReady({ runner, logger, prompter }))) {
      throw new EnvbeamError('Storage could not be configured.', {
        exitCode: 2,
        hint: 'Run `envbeam setup` to configure S3 storage.',
      });
    }

    // 1. Load registry and find project
    logger.info(`Looking up project "${projectName}"…`);
    const store = await createRegistryStore(runner);
    const project = await store.getProject(projectName);

    if (!project) {
      throw new EnvbeamError(
        `Project "${projectName}" not found in registry.`,
        { exitCode: 1, hint: 'Run `envbeam list` to see available projects.' },
      );
    }

    logger.sub(pc.dim(`Found: ${project.gitRemote}`));

    // 2. Determine target directory
    const targetDir = opts.dir
      ? path.resolve(opts.dir)
      : path.join(process.cwd(), projectName);

    // Check if directory exists
    if (await pathExists(targetDir)) {
      const configPath = path.join(targetDir, WORKSPACE_CONFIG_NAME);
      if (await pathExists(configPath)) {
        // Directory exists with config - just cd there and run normal resume
        logger.info(`Project already exists at ${targetDir}`);
        logger.info('Running pull…');

        // Change to project directory
        const originalCwd = process.cwd();
        process.chdir(targetDir);

        try {
          const ctx = await buildRunContext({
            dryRun: opts.dryRun,
            logger,
            prompter,
          });
          await runResume(ctx);
          return 0;
        } finally {
          process.chdir(originalCwd);
        }
      } else {
        throw new EnvbeamError(
          `Directory "${targetDir}" exists but has no ${WORKSPACE_CONFIG_NAME}.`,
          { exitCode: 1, hint: 'Remove the directory or specify a different --dir.' },
        );
      }
    }

    // 3. Clone the repository
    logger.info(`Cloning ${project.gitRemote}…`);

    if (!project.gitRemote) {
      throw new EnvbeamError(
        'Project has no git remote URL stored.',
        { exitCode: 1 },
      );
    }
    // The remote comes from the shared registry (another machine wrote it), so
    // reject git's code-executing transports and flag-looking values before it
    // reaches `git clone`.
    assertSafeGitRemote(project.gitRemote);

    const cloneRes = await runner.run('git', ['clone', '--', project.gitRemote, targetDir], {
      allowFailure: true,
    });

    if (cloneRes.code !== 0) {
      throw new EnvbeamError(
        `Failed to clone repository: ${cloneRes.stderr}`,
        { exitCode: 1 },
      );
    }

    logger.sub(pc.dim(`Cloned to ${targetDir}`));

    // 4. Checkout the correct branch
    if (
      project.gitBranch &&
      project.gitBranch !== 'main' &&
      project.gitBranch !== 'master' &&
      isSafeGitBranch(project.gitBranch)
    ) {
      logger.info(`Checking out branch ${project.gitBranch}…`);
      // isSafeGitBranch already rejected `-`-leading values, so this can't be
      // read as a flag; `--` isn't used because for checkout it means pathspec.
      const checkoutRes = await runner.run('git', ['checkout', project.gitBranch], {
        cwd: targetDir,
        allowFailure: true,
      });

      if (checkoutRes.code !== 0) {
        logger.warn(`Could not checkout branch ${project.gitBranch}: ${checkoutRes.stderr}`);
      }
    }

    // 5. Write .envbeam.yaml if missing (from snapshot)
    const configPath = path.join(targetDir, WORKSPACE_CONFIG_NAME);
    if (!(await pathExists(configPath)) && project.configSnapshot) {
      logger.info(`Writing ${WORKSPACE_CONFIG_NAME} from registry snapshot…`);
      await fs.writeFile(configPath, project.configSnapshot);
      logger.sub(pc.dim('Config restored from registry.'));
    }

    // 6. Run normal resume in the new directory
    logger.raw('');
    logger.info('Running pull to restore state…');

    const originalCwd = process.cwd();
    process.chdir(targetDir);

    try {
      const ctx = await buildRunContext({
        dryRun: opts.dryRun,
        logger,
        prompter,
      });
      await runResume(ctx);

      logger.raw('');
      logger.success(`Project "${projectName}" is ready at ${targetDir}`);
      logger.hint(`cd ${path.relative(originalCwd, targetDir)}`);

      return 0;
    } finally {
      process.chdir(originalCwd);
    }
  });
}

// Re-export for backwards compatibility
export { pullCommand as resumeCommand };
