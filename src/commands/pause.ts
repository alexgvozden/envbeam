import pc from 'picocolors';
import { buildRunContext } from '../core/pipeline/context.js';
import { runPause, type PauseOptions } from '../core/pipeline/pause.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface PauseCliOptions extends GlobalCliOptions {
  force?: boolean;
  snapshot?: boolean;
  noSnapshot?: boolean;
  commit?: boolean;
  stash?: boolean;
  message?: string;
}

export async function pauseCommand(opts: PauseCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);

  return runCommand(logger, async () => {
    const ctx = await buildRunContext({
      dryRun: opts.dryRun,
      logger,
      prompter,
    });

    let snapshot: boolean | undefined;
    if (opts.snapshot) snapshot = true;
    else if (opts.noSnapshot) snapshot = false;

    let workMode: PauseOptions['workMode'] = opts.commit
      ? 'commit'
      : opts.stash
        ? 'stash'
        : 'none';
    let force = opts.force ?? false;
    let message = opts.message;

    // Check for uncommitted changes and prompt if needed
    if (workMode === 'none' && !force) {
      const gitStatus = await ctx.runner.run('git', ['status', '--porcelain'], {
        cwd: ctx.workspaceRoot,
        allowFailure: true,
      });
      const dirtyFiles = gitStatus.stdout
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((l) => l.replace(/^.. /, ''));

      if (dirtyFiles.length > 0) {
        logger.raw('');
        logger.raw(pc.yellow(`${dirtyFiles.length} uncommitted file(s):`));
        for (const f of dirtyFiles.slice(0, 5)) {
          logger.raw(pc.dim(`  ${f}`));
        }
        if (dirtyFiles.length > 5) {
          logger.raw(pc.dim(`  ... and ${dirtyFiles.length - 5} more`));
        }
        logger.raw('');

        const choice = await prompter.select(
          'How do you want to handle uncommitted changes?',
          [
            { name: 'Commit them (recommended)', value: 'commit' },
            { name: 'Stash them', value: 'stash' },
            { name: 'Leave them (won\'t be synced)', value: 'force' },
            { name: 'Cancel', value: 'cancel' },
          ],
          'commit',
        );

        if (choice === 'cancel') {
          logger.raw('Cancelled.');
          return 1;
        } else if (choice === 'commit') {
          workMode = 'commit';
          if (!message) {
            message = await prompter.input('Commit message', 'envbeam: pause checkpoint');
          }
        } else if (choice === 'stash') {
          workMode = 'stash';
        } else if (choice === 'force') {
          force = true;
        }
      }
    }

    await runPause(ctx, {
      force,
      snapshot,
      workMode,
      message,
    });
    return 0;
  });
}
