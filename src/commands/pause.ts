import pc from 'picocolors';
import { buildRunContext, type RunContext } from '../core/pipeline/context.js';
import { runPause, type PauseOptions } from '../core/pipeline/pause.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';
import type { Logger } from '../core/util/logger.js';
import type { Prompter } from '../core/util/prompt.js';

/**
 * Generate a commit message, using Claude CLI if available.
 */
async function generateCommitMessage(
  ctx: RunContext,
  logger: Logger,
  prompter: Prompter,
): Promise<string> {
  // Check if claude CLI is available - get the full path
  const claudePath = await ctx.runner.which('claude');
  if (!claudePath) {
    return prompter.input('Commit message', 'envbeam: pause checkpoint');
  }

  logger.info('Generating commit message with Claude...');

  // Get list of changed files
  const status = await ctx.runner.run('git', ['status', '--porcelain'], {
    cwd: ctx.workspaceRoot,
    allowFailure: true,
  });

  // Get actual diff for context
  const diff = await ctx.runner.run('git', ['diff', '--no-color'], {
    cwd: ctx.workspaceRoot,
    allowFailure: true,
  });

  const filesChanged = status.stdout.trim().split('\n').slice(0, 10).join('\n');
  const diffContent = diff.stdout.slice(0, 3000); // Limit to avoid token issues

  const prompt = `You are a git commit message generator. Output ONLY the commit message, nothing else. No explanations, no questions, no markdown.

Files:
${filesChanged}

Diff:
${diffContent}

Commit message:`;

  // Use shell on Windows to handle .cmd/.bat files
  const result = await ctx.runner.run(claudePath, ['-p', prompt], {
    cwd: ctx.workspaceRoot,
    allowFailure: true,
    timeout: 60000,
    shell: process.platform === 'win32',
  });

  // Debug info
  if (result.code !== 0 || !result.stdout.trim()) {
    const debugInfo = `code=${result.code}, stdout=${result.stdout.length}b, stderr=${result.stderr.slice(0, 100)}`;
    logger.sub(pc.dim(`Claude: ${debugInfo}`));
  }

  if (result.code === 0 && result.stdout.trim()) {
    // Clean up the response - remove quotes, newlines, etc.
    const firstLine = result.stdout.trim().split('\n')[0] ?? '';
    const generated = firstLine
      .replace(/^["'`]|["'`]$/g, '')  // Remove surrounding quotes
      .replace(/^(commit:?\s*)/i, '') // Remove "commit:" prefix if present
      .trim();

    if (generated.length > 0) {
      logger.sub(pc.dim(`→ ${generated}`));

      // Let user confirm or edit
      const confirmed = await prompter.confirm('Use this message?', true);
      if (confirmed) {
        return generated;
      }
      // If not confirmed, fall through to manual input with generated as default
      return prompter.input('Commit message', generated);
    }
  } else if (result.code === 0) {
    logger.sub(pc.dim(`Claude returned empty response`));
  }

  // Fall back to manual input
  return prompter.input('Commit message', 'envbeam: pause checkpoint');
}

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
            message = await generateCommitMessage(ctx, logger, prompter);
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
