import { buildRunContext } from '../core/pipeline/context.js';
import { runStatus, printStatus } from '../core/pipeline/status.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface StatusCliOptions extends GlobalCliOptions {
  json?: boolean;
}

export async function statusCommand(opts: StatusCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const ctx = await buildRunContext({ logger, prompter: makePrompter(opts) });
    const report = await runStatus(ctx);
    if (opts.json) {
      logger.raw(JSON.stringify(report, null, 2));
    } else {
      printStatus(ctx, report);
    }
    return 0;
  });
}
