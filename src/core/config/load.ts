import path from 'node:path';
import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { workspaceConfigSchema, type WorkspaceConfig } from './schema.js';
import { WORKSPACE_CONFIG_NAME } from './paths.js';
import { findUp, pathExists } from '../util/fs.js';
import { EnvbeamError } from '../util/errors.js';

export interface LoadedConfig {
  config: WorkspaceConfig;
  configPath: string;
  workspaceRoot: string;
}

/** Locate the workspace root by walking up for `.envbeam.yaml`. */
export async function findWorkspaceRoot(start: string = process.cwd()): Promise<string | null> {
  return findUp(WORKSPACE_CONFIG_NAME, start);
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ConfigValidationError extends EnvbeamError {
  readonly issues: ValidationIssue[];
  constructor(configPath: string, issues: ValidationIssue[]) {
    const lines = issues.map((i) => `  • ${i.path || '(root)'}: ${i.message}`).join('\n');
    super(`Invalid ${path.basename(configPath)}:\n${lines}`, { exitCode: 2 });
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

function zodIssues(err: z.ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Parse + validate raw YAML text into a typed config (or throw with issues). */
export function parseConfig(text: string, sourcePath = WORKSPACE_CONFIG_NAME): WorkspaceConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new EnvbeamError(`Failed to parse YAML in ${sourcePath}: ${(e as Error).message}`, {
      exitCode: 2,
    });
  }
  if (raw == null || typeof raw !== 'object') {
    throw new ConfigValidationError(sourcePath, [{ path: '', message: 'config must be a mapping' }]);
  }
  const result = workspaceConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(sourcePath, zodIssues(result.error));
  }
  return result.data;
}

/** Validate without throwing; returns issues for `config validate`. */
export function validateConfigText(
  text: string,
  sourcePath = WORKSPACE_CONFIG_NAME,
): { ok: true; config: WorkspaceConfig } | { ok: false; issues: ValidationIssue[] } {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    return { ok: false, issues: [{ path: '', message: `YAML parse error: ${(e as Error).message}` }] };
  }
  const result = workspaceConfigSchema.safeParse(raw);
  if (!result.success) return { ok: false, issues: zodIssues(result.error) };
  return { ok: true, config: result.data };
}

/** Load + validate the workspace config nearest to `start`. */
export async function loadWorkspaceConfig(start: string = process.cwd()): Promise<LoadedConfig> {
  const root = await findWorkspaceRoot(start);
  if (!root) {
    throw new EnvbeamError(
      `No ${WORKSPACE_CONFIG_NAME} found in this directory or any parent.`,
      { exitCode: 2, hint: 'Run `envbeam init` to scaffold one.' },
    );
  }
  const configPath = path.join(root, WORKSPACE_CONFIG_NAME);
  const text = await fs.readFile(configPath, 'utf8');
  const config = parseConfig(text, configPath);
  return { config, configPath, workspaceRoot: root };
}

/** Load if present; null otherwise (for commands that tolerate no config). */
export async function tryLoadWorkspaceConfig(start: string = process.cwd()): Promise<LoadedConfig | null> {
  const root = await findWorkspaceRoot(start);
  if (!root) return null;
  const configPath = path.join(root, WORKSPACE_CONFIG_NAME);
  if (!(await pathExists(configPath))) return null;
  const text = await fs.readFile(configPath, 'utf8');
  const config = parseConfig(text, configPath);
  return { config, configPath, workspaceRoot: root };
}
