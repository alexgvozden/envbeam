import { buildRunContext } from '../core/pipeline/context.js';
import { runResume } from '../core/pipeline/resume.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export async function resumeCommand(opts: GlobalCliOptions & { force?: boolean }): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const ctx = await buildRunContext({
      dryRun: opts.dryRun,
      force: opts.force,
      logger,
      prompter: makePrompter(opts),
    });
    await runResume(ctx);
    return 0;
  });
}
