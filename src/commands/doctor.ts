import path from 'node:path';
import pc from 'picocolors';
import { Logger } from '../core/util/logger.js';
import { RealCommandRunner } from '../core/util/exec.js';
import { findWorkspaceRoot, tryLoadWorkspaceConfig } from '../core/config/load.js';
import { findUp } from '../core/util/fs.js';
import { detectWorkspace } from '../core/detect/index.js';
import type { DetectionReport } from '../core/detect/types.js';
import { computeGaps, applyGaps } from '../core/config/gaps.js';
import { buildRunContext } from '../core/pipeline/context.js';
import { runPreflight, type PreflightReport } from '../core/pipeline/preflight.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface DoctorOptions extends GlobalCliOptions {
  fix?: boolean;
  noAuth?: boolean;
}

export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const cwd = process.cwd();
    const wsRoot = (await findWorkspaceRoot(cwd)) ?? (await findUp('.git', cwd)) ?? cwd;
    const detection = await detectWorkspace(wsRoot);
    const loaded = await tryLoadWorkspaceConfig(cwd);

    logger.raw(pc.bold('envbeam doctor'));
    logger.raw(pc.dim(`workspace: ${wsRoot}`));
    logger.raw('');

    // ---- environment ----
    logger.raw(pc.bold('Environment'));
    let preflight: PreflightReport | undefined;
    if (loaded) {
      const ctx = await buildRunContext({ cwd, logger, prompter: makePrompter(opts) });
      preflight = await runPreflight(ctx, { auth: !opts.noAuth });
      printPreflight(logger, preflight);
    } else {
      logger.raw(pc.dim('  no .envbeam.yaml — checking baseline tools only'));
      await printBaselineTools(logger);
    }
    logger.raw('');

    // ---- detection report ----
    logger.raw(pc.bold('Detection report'));
    printDetection(logger, detection);
    logger.raw('');

    // ---- fix ----
    if (opts.fix) {
      if (!loaded) {
        logger.warn('No .envbeam.yaml to update. Run `envbeam init` first.');
      } else {
        const gaps = computeGaps(loaded.config, detection);
        if (!gaps.length) {
          logger.info('No gaps to fill — config already covers what was detected.');
        } else {
          const prompter = makePrompter(opts);
          const ok = opts.yes || (await prompter.confirm(`Write ${gaps.length} detected field(s) into ${path.basename(loaded.configPath)}?`, true));
          if (!ok) {
            logger.info('Skipped writing (no confirmation).');
          } else {
            const wrote = await applyGaps(loaded.configPath, gaps);
            logger.success(`Wrote ${wrote.length} detected field(s) into ${path.basename(loaded.configPath)}`);
            for (const w of wrote) logger.sub(pc.dim(w));
          }
        }
      }
    }

    const envOk = preflight ? preflight.ok : true;
    if (!envOk) {
      logger.warn('Some tools are missing or unauthenticated (see above).');
      return 2;
    }
    logger.success('Environment looks good.');
    return 0;
  });
}

function printPreflight(logger: Logger, report: PreflightReport): void {
  for (const c of report.checks) {
    if (!c.present) {
      logger.raw(`  ${pc.red('✗')} ${c.command} ${pc.dim(`(${c.concern})`)} — ${pc.dim('not found')}`);
      logger.raw(`      ${pc.dim(c.installHint)}`);
    } else if (c.authChecked && c.authOk === false) {
      logger.raw(`  ${pc.yellow('!')} ${c.command} ${pc.dim(`(${c.concern})`)} — ${pc.yellow(c.authDetail ?? 'auth failed')}`);
    } else {
      const v = c.version ? pc.dim(` ${c.version}`) : '';
      const auth = c.authChecked && c.authOk ? pc.dim(' · authenticated') : '';
      logger.raw(`  ${pc.green('✓')} ${c.command}${v} ${pc.dim(`(${c.concern})`)}${auth}`);
    }
  }
}

async function printBaselineTools(logger: Logger): Promise<void> {
  const runner = new RealCommandRunner();
  for (const cmd of ['git', 'docker']) {
    const found = await runner.which(cmd);
    logger.raw(`  ${found ? pc.green('✓') : pc.yellow('!')} ${cmd} ${pc.dim(found ? '' : 'not found')}`);
  }
}

function printDetection(logger: Logger, detection: DetectionReport): void {
  for (const f of detection.fields) {
    const icon =
      f.status === 'detected' ? pc.green('✓') : f.status === 'ambiguous' ? pc.yellow('?') : pc.dim('·');
    const value = Array.isArray(f.value)
      ? f.value.length
        ? f.value.join(', ')
        : '(none)'
      : (f.value ?? pc.dim('—'));
    const note = f.note ? pc.dim(`  (${f.note})`) : '';
    logger.raw(`  ${icon} ${f.field.padEnd(24)} ${value}${note}`);
    if (f.candidates?.length) logger.raw(`      ${pc.dim('candidates: ' + f.candidates.join(', '))}`);
  }
}
