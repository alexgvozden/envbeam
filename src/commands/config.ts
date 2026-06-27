import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import { WORKSPACE_CONFIG_NAME } from '../core/config/paths.js';
import { findWorkspaceRoot, validateConfigText, tryLoadWorkspaceConfig } from '../core/config/load.js';
import { pathExists } from '../core/util/fs.js';
import { detectWorkspace } from '../core/detect/index.js';
import { computeGaps, applyGaps } from '../core/config/gaps.js';
import { FIELD_DOCS, explainField } from '../core/config/explain.js';
import { EnvbeamError } from '../core/util/errors.js';
import { makeLogger, runCommand, type GlobalCliOptions } from './shared.js';

export async function configValidateCommand(file: string | undefined, opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const target = file
      ? path.resolve(file)
      : path.join((await findWorkspaceRoot()) ?? process.cwd(), WORKSPACE_CONFIG_NAME);
    if (!(await pathExists(target))) {
      throw new EnvbeamError(`No config file at ${target}.`, { exitCode: 2 });
    }
    const text = await fs.readFile(target, 'utf8');
    const result = validateConfigText(text, target);
    if (result.ok) {
      logger.success(`${path.basename(target)} is valid.`);
      return 0;
    }
    logger.error(`${path.basename(target)} is invalid:`);
    for (const issue of result.issues) {
      logger.raw(`  ${pc.red('•')} ${issue.path || '(root)'}: ${issue.message}`);
    }
    return 2;
  });
}

export async function configExplainCommand(field: string | undefined, opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    if (field) {
      const doc = explainField(field);
      if (!doc) {
        logger.warn(`No documentation for "${field}". Run \`envbeam config explain\` to list fields.`);
        return 1;
      }
      logger.raw(`${pc.bold(field)}\n  ${doc}`);
      return 0;
    }
    logger.raw(pc.bold('envbeam config fields'));
    for (const [key, doc] of Object.entries(FIELD_DOCS)) {
      logger.raw(`  ${pc.cyan(key)}`);
      logger.raw(`    ${pc.dim(doc)}`);
    }
    return 0;
  });
}

export interface ConfigSyncOptions extends GlobalCliOptions {
  write?: boolean;
}

export async function configSyncCommand(opts: ConfigSyncOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const loaded = await tryLoadWorkspaceConfig();
    if (!loaded) {
      throw new EnvbeamError(`No ${WORKSPACE_CONFIG_NAME} found.`, {
        exitCode: 2,
        hint: 'Run `envbeam init` to scaffold one.',
      });
    }
    const detection = await detectWorkspace(loaded.workspaceRoot);
    const gaps = computeGaps(loaded.config, detection);

    logger.raw(pc.bold('Proposed config additions (from repo inspection)'));
    if (!gaps.length) {
      logger.success('Nothing to add — config already reflects what was detected.');
      return 0;
    }
    for (const gap of gaps) {
      logger.raw(`  ${pc.green('+')} ${pc.cyan(gap.path.join('.'))}: ${gap.value}  ${pc.dim(`(${gap.reason})`)}`);
    }
    logger.raw('');

    if (!opts.write) {
      logger.hint('Re-run with --write to apply these to .envbeam.yaml.');
      return 0;
    }
    const wrote = await applyGaps(loaded.configPath, gaps);
    logger.success(`Applied ${wrote.length} field(s) to ${path.basename(loaded.configPath)}.`);
    logger.hint('Run `envbeam config validate` to confirm.');
    return 0;
  });
}
