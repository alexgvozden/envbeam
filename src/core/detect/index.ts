import { detectGit } from './git.js';
import { detectContainer } from './container.js';
import { detectDatabase } from './database.js';
import { detectSecrets } from './secrets.js';
import type { DetectionReport } from './types.js';

export * from './types.js';
export { parseGitConfig, sshHostFromUrl } from './git.js';
export { findComposeFile, parseCompose } from './container.js';
export { detectMigrateCommand } from './database.js';
export { parseEnvKeys } from './secrets.js';

/** Run all detectors against a workspace and assemble the report (PRD §5). */
export async function detectWorkspace(workspaceRoot: string): Promise<DetectionReport> {
  const [git, container, database, secrets] = await Promise.all([
    detectGit(workspaceRoot),
    detectContainer(workspaceRoot),
    detectDatabase(workspaceRoot),
    detectSecrets(workspaceRoot),
  ]);
  return {
    workspaceRoot,
    fields: [...git, ...container, ...database, ...secrets],
  };
}
