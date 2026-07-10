import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type ResolvedIdentities } from '../../src/core/pipeline/context.js';
import { createBuiltinRegistry } from '../../src/core/providers/builtins.js';
import { Logger } from '../../src/core/util/logger.js';
import { AutoPrompter, type Prompter } from '../../src/core/util/prompt.js';
import { FileCredentialStore } from '../../src/core/identity/store.js';
import { workspaceConfigSchema, type WorkspaceConfig } from '../../src/core/config/schema.js';
import type { DetectionReport } from '../../src/core/detect/types.js';
import type { CommandRunner } from '../../src/core/util/exec.js';
import { FakeRunner } from './fakeRunner.js';

let credSeq = 0;

export interface TestContextOptions {
  config: unknown;
  workspaceRoot?: string;
  runner?: CommandRunner;
  prompter?: Prompter;
  dryRun?: boolean;
  force?: boolean;
  env?: Record<string, string>;
  identities?: ResolvedIdentities;
  identityWarnings?: string[];
  logLines?: string[];
}

/** Build a fully-formed RunContext for pipeline/provider tests (no disk config). */
export function makeTestContext(opts: TestContextOptions): RunContext {
  const config: WorkspaceConfig = workspaceConfigSchema.parse(opts.config);
  const detection: DetectionReport = { workspaceRoot: opts.workspaceRoot ?? '/tmp/ws', fields: [] };
  const lines = opts.logLines ?? [];
  const logger = new Logger({
    level: 'debug',
    dryRun: opts.dryRun,
    write: (_s, text) => lines.push(text.replace(/\n$/, '')),
  });
  return new RunContext({
    workspaceRoot: opts.workspaceRoot ?? '/tmp/ws',
    configPath: path.join(opts.workspaceRoot ?? '/tmp/ws', '.envbeam.yaml'),
    config,
    detection,
    registry: createBuiltinRegistry(),
    plugins: [],
    globalConfig: { identities: {} },
    store: new FileCredentialStore(path.join(os.tmpdir(), `envbeam-test-cred-${process.pid}-${credSeq++}.json`)),
    runner: opts.runner ?? new FakeRunner(),
    logger,
    prompter: opts.prompter ?? new AutoPrompter({ defaults: true }),
    dryRun: opts.dryRun ?? false,
    force: opts.force ?? false,
    identities: opts.identities ?? {},
    identityWarnings: opts.identityWarnings ?? [],
    env: opts.env ?? {},
  });
}

/** Create a temp directory; returns the path and a cleanup fn. */
export async function tmpDir(prefix = 'envbeam-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}

/** Write a set of files (relative paths → content) under `root`. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}
