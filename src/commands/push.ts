import pc from 'picocolors';
import { promises as fs } from 'node:fs';
import { buildRunContext, type RunContext } from '../core/pipeline/context.js';
import { runPause, type PauseOptions } from '../core/pipeline/pause.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';
import { createRegistryStore, type ProjectEntryInput } from '../core/registry/index.js';
import { ensureStorageReady } from './storage.js';
import { getMachineId } from '../core/util/machine.js';
import { loadState, patchState } from '../core/state.js';
import { SafetyError } from '../core/util/errors.js';
import { detectedValue, resolveBranch } from '../core/detect/types.js';
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
    return prompter.input('Commit message', 'envbeam: push checkpoint');
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

  // Use stdin piping for the prompt to avoid shell escaping issues with newlines
  const result = await ctx.runner.run(claudePath, ['-p'], {
    cwd: ctx.workspaceRoot,
    allowFailure: true,
    timeout: 60000,
    shell: process.platform === 'win32',
    input: prompt,
  });

  // Debug info on failure
  if (result.code !== 0) {
    const debugInfo = `code=${result.code}, stderr=${result.stderr.slice(0, 100)}`;
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
  return prompter.input('Commit message', 'envbeam: push checkpoint');
}

export interface PushCliOptions extends GlobalCliOptions {
  force?: boolean;
  /** Overwrite a remote checkpoint this machine has never seen. */
  overwriteRemote?: boolean;
  /** Sweep untracked files into the commit (they get pushed; this is one-way). */
  includeUntracked?: boolean;
  snapshot?: boolean;
  noSnapshot?: boolean;
  commit?: boolean;
  stash?: boolean;
  message?: string;
}

export async function pushCommand(opts: PushCliOptions): Promise<number> {
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

    // `--include-untracked` is the only way a *non-interactive* run publishes a
    // file git has never seen. Otherwise only somebody looking at the list can
    // say yes to it.
    let includeUntracked = opts.includeUntracked ?? false;

    // Check for uncommitted changes and prompt if needed
    if (workMode === 'none' && !force) {
      const status = await ctx.runner.run('git', ['status', '--porcelain'], {
        cwd: ctx.workspaceRoot,
        allowFailure: true,
      });
      const lines = status.stdout.split(/\r?\n/).filter((l) => l.length > 0);
      const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
      const tracked = lines.filter((l) => !l.startsWith('??')).map((l) => l.replace(/^.. /, ''));

      if (lines.length > 0) {
        logger.raw('');
        if (tracked.length) {
          logger.raw(pc.yellow(`${tracked.length} uncommitted change(s) to tracked files:`));
          for (const f of tracked.slice(0, 5)) logger.raw(pc.dim(`  ${f}`));
          if (tracked.length > 5) logger.raw(pc.dim(`  ... and ${tracked.length - 5} more`));
        }
        // Listed apart, because committing these is the irreversible one: git has
        // never seen them, so nothing has vetted them against .gitignore.
        if (untracked.length) {
          logger.raw(pc.yellow(`${untracked.length} untracked file(s) git has never seen:`));
          for (const f of untracked.slice(0, 5)) logger.raw(pc.dim(`  ${f}`));
          if (untracked.length > 5) logger.raw(pc.dim(`  ... and ${untracked.length - 5} more`));
        }
        logger.raw('');

        if (!prompter.interactive) {
          // `--yes` means "don't ask me the routine questions", not "publish
          // whatever is lying around". Carry the tracked work; name the rest.
          workMode = 'commit';
          message ??= 'envbeam: push checkpoint';
        } else {
          // With the untracked files listed right above, committing them all is
          // informed consent, and it is what carrying your work usually means —
          // a new source file is work too. Keep it the default, but let someone
          // who spots a stray secret in that list commit only the tracked half.
          const choices = untracked.length
            ? [
                { name: `Commit everything (${tracked.length} tracked + ${untracked.length} untracked)`, value: 'commit-all' },
                { name: `Commit only the ${tracked.length} tracked change(s)`, value: 'commit' },
                { name: 'Stash them', value: 'stash' },
                { name: "Leave them (won't be synced)", value: 'force' },
                { name: 'Cancel', value: 'cancel' },
              ]
            : [
                { name: 'Commit them (recommended)', value: 'commit' },
                { name: 'Stash them', value: 'stash' },
                { name: "Leave them (won't be synced)", value: 'force' },
                { name: 'Cancel', value: 'cancel' },
              ];
          const choice = await prompter.select(
            'How do you want to handle uncommitted changes?',
            choices,
            untracked.length ? 'commit-all' : 'commit',
          );

          if (choice === 'cancel') {
            logger.raw('Cancelled.');
            return 1;
          } else if (choice === 'commit' || choice === 'commit-all') {
            workMode = 'commit';
            includeUntracked = choice === 'commit-all';
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
    }

    const report = await runPause(ctx, {
      force,
      overwriteRemote: opts.overwriteRemote,
      snapshot,
      workMode,
      includeUntracked,
      message,
    });

    // A dry run must not advance the remote checkpoint.
    if (ctx.dryRun) return 0;

    // A push whose steps did not all land does not describe a moment any machine
    // was ever in. Leave the checkpoint where it is; `runPause` already reported
    // which step failed. Exit non-zero so a script notices (SYNC_SAFETY.md §9).
    if (report.incoherent.length) return 1;

    // Register/update project in registry after successful push. Opportunistically
    // self-heal storage from Doppler (silent — no prompts on every push), so the
    // project auto-registers once storage is set up, without dead-ending.
    if (await ensureStorageReady({ runner: ctx.runner, logger, prompter }, { silent: true })) {
      try {
        const store = await createRegistryStore(ctx.runner);
        const configContent = await fs.readFile(ctx.configPath, 'utf8');
        const machineId = await getMachineId();

        const state = await loadState(ctx.workspaceRoot);
        const gitBranch = resolveBranch(ctx.detection, ctx.config.git?.branch);

        // The checkpoint names ONLY what this push actually uploaded. `gitCommit`
        // is the causal anchor: a puller checks that the code it is about to
        // restore this data into descends from the commit the data was taken
        // against (§10.4). Without a commit there is nothing to anchor to, so no
        // checkpoint is written — the registry entry is still refreshed.
        const checkpoint = report.git?.commit
          ? {
              revision: 0, // the store assigns the real one
              gitCommit: report.git.commit,
              gitBranch,
              snapshotName: report.database?.snapshot?.file,
              sessionName: report.session?.artifact,
              secretsHash: state.secretsBase?.hash,
              machineId,
              at: new Date().toISOString(),
            }
          : undefined;

        const entry: ProjectEntryInput = {
          name: ctx.config.workspace,
          gitRemote: detectedValue(ctx.detection, 'git.url') ?? '',
          gitBranch,
          configSnapshot: configContent,
          lastPush: new Date().toISOString(),
          machineId,
          checkpoint,
          syncTarget: ctx.config.database?.sync
            ? {
                target: ctx.config.database.sync.target,
                bucket: ctx.config.database.sync.bucket,
                prefix: ctx.config.database.sync.prefix,
                region: ctx.config.database.sync.region,
              }
            : undefined,
        };

        // Claim the revision this machine last observed. If another machine has
        // pushed since, this refuses rather than overwriting their checkpoint —
        // the guard at the top of `runPause` catches that first, but the remote
        // can also move while this push is running.
        const stored = await store.registerProject(
          entry,
          opts.overwriteRemote ? {} : { expectedRevision: state.baseRevision ?? 0 },
        );
        await patchState(ctx.workspaceRoot, { baseRevision: stored.revision });
        logger.sub(pc.dim(`Registered "${ctx.config.workspace}" in project registry (r${stored.revision}).`));
      } catch (err) {
        // The registry is not reachable, or it moved under us. Either way git,
        // the snapshot, and the session archive are already published; failing
        // the command now would be misleading. But a SafetyError means we chose
        // NOT to advance the remote, and the user must know the push is partial.
        if (err instanceof SafetyError) {
          logger.warn(`Registry not advanced: ${err.message}`);
          if (err.hint) logger.hint(err.hint);
        } else {
          logger.warn(`Could not update registry: ${(err as Error).message}`);
        }
      }
    }

    return 0;
  });
}

// Re-export for backwards compatibility
export { pushCommand as pauseCommand };
export type { PushCliOptions as PauseCliOptions };
