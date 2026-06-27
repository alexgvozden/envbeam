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
  return runCommand(logger, async () => {
    const ctx = await buildRunContext({
      dryRun: opts.dryRun,
      logger,
      prompter: makePrompter(opts),
    });

    let snapshot: boolean | undefined;
    if (opts.snapshot) snapshot = true;
    else if (opts.noSnapshot) snapshot = false;

    const workMode: PauseOptions['workMode'] = opts.commit
      ? 'commit'
      : opts.stash
        ? 'stash'
        : 'none';

    await runPause(ctx, {
      force: opts.force ?? false,
      snapshot,
      workMode,
      message: opts.message,
    });
    return 0;
  });
}
