import type { WorkspaceConfig } from './schema.js';
import { type DetectionReport, detectedValue, getField } from '../detect/types.js';

/**
 * Fill absent config fields from detection (PRD §5: present overrides, absent is
 * auto-detected). Returns a new config; the input is not mutated. Detected
 * values never clobber explicit config.
 */
export function mergeDetection(config: WorkspaceConfig, detection: DetectionReport): WorkspaceConfig {
  const merged: WorkspaceConfig = structuredClone(config);

  // --- git ---
  // git defaults (remote=origin, branch=current) come from the schema; the git
  // provider follows the checked-out branch when branch is "current". git.identity
  // is never auto-adopted — detection yields an ssh host alias, not an identity
  // name, so the user must declare which identity to use.

  // --- container ---
  const detectedMode = detectedValue(detection, 'container.mode');
  if (!merged.container?.mode && detectedMode) {
    merged.container = { ...merged.container, mode: detectedMode as 'devcontainer' | 'compose' | 'none' };
  }
  const detectedCompose = detectedValue(detection, 'container.composeFile');
  if (merged.container && !merged.container.composeFile && detectedCompose) {
    merged.container.composeFile = detectedCompose;
  }

  // --- database ---
  // DB management is opt-in via a `database:` block; detection fills gaps within
  // it but never synthesizes one (matches the PRD minimal-config examples).
  if (merged.database) {
    const detectedDbProvider = detectedValue(detection, 'database.provider');
    if (!merged.database.provider && detectedDbProvider) merged.database.provider = detectedDbProvider;
    const detectedService = detectedValue(detection, 'database.service');
    if (!merged.database.service && detectedService) merged.database.service = detectedService;
    const detectedMigrate = detectedValue(detection, 'database.migrateCommand');
    if (!merged.database.migrateCommand && detectedMigrate) merged.database.migrateCommand = detectedMigrate;
  }

  // --- secrets ---
  const detectedSecretsProvider = getField(detection, 'secrets.provider');
  if (merged.secrets && !merged.secrets.provider && detectedSecretsProvider?.value) {
    merged.secrets.provider = String(detectedSecretsProvider.value);
  }

  return merged;
}
