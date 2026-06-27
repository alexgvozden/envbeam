/** Public API surface for plugin authors and programmatic use. */
export * from './core/providers/types.js';
export { ProviderRegistry, loadPlugins, type ProviderFactory } from './core/providers/registry.js';
export { createBuiltinRegistry, createRegistry, BUILTIN_FACTORIES } from './core/providers/builtins.js';
export * from './core/config/schema.js';
export { parseConfig, validateConfigText, loadWorkspaceConfig } from './core/config/load.js';
export { detectWorkspace } from './core/detect/index.js';
export type { DetectionReport, DetectedField } from './core/detect/types.js';
export { RealCommandRunner, type CommandRunner, type RunResult, type RunOptions } from './core/util/exec.js';
export { Logger } from './core/util/logger.js';
export type { SyncTarget, SnapshotEntry } from './core/sync/types.js';
export { createSyncTarget } from './core/sync/index.js';
export { buildRunContext, RunContext } from './core/pipeline/context.js';
export { runResume } from './core/pipeline/resume.js';
export { runPause } from './core/pipeline/pause.js';
export { runStatus } from './core/pipeline/status.js';
export { runPreflight } from './core/pipeline/preflight.js';
