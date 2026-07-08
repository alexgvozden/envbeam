import path from 'node:path';
import fs from 'node:fs';
import pc from 'picocolors';
import type { RunContext } from './context.js';
import { detectRuntimeTargets, type RuntimeTarget } from '../detect/runtime.js';
import { ensureTools } from '../util/tools.js';

export interface DepsReport {
  synced: string[];
  failed: string[];
}

const MAX_TARGETS = 8;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

function label(t: RuntimeTarget): string {
  return `${t.manager} (${t.dir === '.' ? 'root' : t.dir})`;
}

/**
 * Detect the project's language toolchains from lockfiles and get dependencies
 * ready to run: install the package manager itself if missing (auto-install
 * rule), then sync deps against the just-pulled lockfiles (`uv sync`,
 * `npm ci`/`install`, `pnpm install`, `go mod download`, …). Best-effort:
 * failures warn but never block the resume. Returns null when the project has
 * no detectable targets (the step is skipped entirely).
 */
export async function installRuntimeDeps(ctx: RunContext): Promise<DepsReport | null> {
  const targets = await detectRuntimeTargets(ctx.workspaceRoot);
  if (!targets.length) return null;

  const log = ctx.logger;
  log.step('Dependencies');

  // No silent caps: say when we bound the work.
  const run = targets.slice(0, MAX_TARGETS);
  if (targets.length > run.length) {
    log.warn(`found ${targets.length} dependency targets; running the first ${MAX_TARGETS} (shallowest first)`);
  }

  const report: DepsReport = { synced: [], failed: [] };
  for (const t of run) {
    const dirAbs = path.resolve(ctx.workspaceRoot, t.dir);
    // npm: `ci` gives a clean reproducible install, but wipes node_modules —
    // use it only when node_modules doesn't exist yet.
    const args =
      t.manager === 'npm'
        ? [fs.existsSync(path.join(dirAbs, 'node_modules')) ? 'install' : 'ci']
        : t.args;

    if (ctx.dryRun) {
      log.sub(`would run: ${t.manager} ${args.join(' ')} in ${t.dir} (${t.marker})`);
      continue;
    }

    // Install the package manager itself if missing (prompted, per the rule).
    const tool = await ensureTools([t.manager], ctx.runner, ctx.logger, ctx.prompter);
    if (!tool.allInstalled) {
      log.sub(pc.yellow(`skipping ${label(t)} — ${t.manager} is not installed`));
      report.failed.push(label(t));
      continue;
    }

    log.sub(`${t.manager} ${args.join(' ')} — ${t.dir === '.' ? 'workspace root' : t.dir} (${t.marker})`);
    const res = await ctx.runner.run(t.manager, args, {
      cwd: dirAbs,
      allowFailure: true,
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (res.code === 0) {
      report.synced.push(label(t));
    } else {
      const firstErr = (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/).find((l) =>
        /error|failed|cannot|denied/i.test(l),
      );
      log.warn(`${label(t)} failed${firstErr ? `: ${firstErr}` : ` (exit ${res.code})`}`);
      report.failed.push(label(t));
    }
  }

  if (report.synced.length) log.sub(pc.green(`dependencies ready: ${report.synced.join(', ')}`));
  return report;
}
