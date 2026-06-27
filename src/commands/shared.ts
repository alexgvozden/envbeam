import pc from 'picocolors';
import { Logger } from '../core/util/logger.js';
import { EnvbeamError } from '../core/util/errors.js';
import { AutoPrompter, TerminalPrompter, type Prompter } from '../core/util/prompt.js';

export interface GlobalCliOptions {
  dryRun?: boolean;
  yes?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

export function makeLogger(opts: GlobalCliOptions): Logger {
  return new Logger({
    level: opts.quiet ? 'error' : opts.verbose ? 'debug' : 'info',
    dryRun: opts.dryRun,
  });
}

export function makePrompter(opts: GlobalCliOptions): Prompter {
  if (opts.yes || !process.stdout.isTTY) return new AutoPrompter({ defaults: opts.yes ?? false });
  return new TerminalPrompter();
}

/** Wrap a command body so EnvbeamError maps to a clean message + exit code. */
export async function runCommand(
  logger: Logger,
  fn: () => Promise<number | void>,
): Promise<number> {
  try {
    const code = await fn();
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    if (err instanceof EnvbeamError) {
      logger.error(err.message);
      if (err.hint) logger.hint(err.hint);
      return err.exitCode;
    }
    logger.error((err as Error)?.message ?? String(err));
    if ((err as Error)?.stack && process.env.ENVBEAM_DEBUG) {
      logger.raw(pc.dim((err as Error).stack!));
    }
    return 1;
  }
}
