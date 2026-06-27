import type { MigrateResult, ProviderContext } from '../types.js';

/**
 * Run the workspace's migration command (PRD §7.6 — always, both modes). Stack-
 * agnostic: executes the configured/detected command string via the shell with
 * loaded secrets in the environment. Works without a known DB engine, so
 * migrations-only workspaces don't need a database provider.
 */
export async function runMigrateCommand(ctx: ProviderContext): Promise<MigrateResult> {
  const db = ctx.config.database;
  if (db?.migrate === false) return { ran: false, detail: 'migrate: false' };
  const command = db?.migrateCommand;
  if (!command) {
    return { ran: false, detail: 'no migrate command configured/detected' };
  }
  if (ctx.dryRun) {
    ctx.logger.sub(`would run migrations: ${command}`);
    return { ran: false, detail: 'dry-run' };
  }
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd' : 'sh';
  const shellArgs = isWin ? ['/c', command] : ['-c', command];
  const res = await ctx.runner.run(shell, shellArgs, {
    cwd: ctx.workspaceRoot,
    env: ctx.env,
    allowFailure: true,
  });
  if (res.code !== 0) {
    return {
      ran: false,
      detail: `migration command failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
  }
  return { ran: true, detail: command };
}
