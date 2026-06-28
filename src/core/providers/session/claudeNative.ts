import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  SessionProvider,
  SessionResult,
  SessionStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import type { SyncConfig } from '../../config/schema.js';
import { createSyncTarget, encryptionSuffix, encryptFile, decryptFile } from '../../sync/index.js';
import { getGlobalStorageConfig, injectStorageEnv } from '../../storage/global.js';
import { ensureDir, pathExists } from '../../util/fs.js';
import { machineName } from '../database/base.js';

/**
 * Native Claude session sync - syncs Claude Code session data to S3/storage.
 *
 * Scope options:
 * - project: ~/.claude/projects/<workspace-path>/ (default)
 * - workspace: .claude/ folder in the workspace root
 * - global: ~/.claude/ (tools, plugins, all sessions)
 */
export class ClaudeNativeProvider implements SessionProvider {
  readonly name = 'claude-native';
  readonly kind = 'session' as const;

  requiredTools(): ToolRequirement[] {
    // Uses tar for archiving; aws CLI for S3 (if S3 target)
    return [];
  }

  private getClaudeHome(): string {
    return process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
  }

  private getProjectSessionPath(workspaceRoot: string): string {
    // Claude Code stores sessions in ~/.claude/projects/<sanitized-path>/
    const sanitized = workspaceRoot.replace(/[\\/:]/g, '-').replace(/^-+/, '');
    return path.join(this.getClaudeHome(), 'projects', sanitized);
  }

  private getWorkspaceClaudePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.claude');
  }

  private async getSyncTarget(ctx: ProviderContext) {
    // Use session.sync if configured, else fall back to database.sync
    const syncConfig: SyncConfig | undefined =
      ctx.config.session?.sync ?? ctx.config.database?.sync;

    if (!syncConfig) {
      return null;
    }

    // Ensure S3 credentials are available
    if (syncConfig.target === 's3' && !process.env.ENVBEAM_S3_ACCESS_KEY) {
      const globalStorage = await getGlobalStorageConfig(ctx.runner);
      if (globalStorage) {
        injectStorageEnv(globalStorage);
      }
    }

    return createSyncTarget(syncConfig, ctx.identity);
  }

  private sessionFileName(workspace: string, scope: string, machine: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `claude-session-${workspace}-${scope}-${machine}-${timestamp}.tar.gz`;
  }

  private parseSessionFileName(name: string): {
    workspace: string;
    scope: string;
    machine: string;
    timestamp: string;
  } | null {
    const match = name.match(
      /^claude-session-([^-]+)-([^-]+)-([^-]+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.tar\.gz$/,
    );
    if (!match) return null;
    return {
      workspace: match[1]!,
      scope: match[2]!,
      machine: match[3]!,
      timestamp: match[4]!,
    };
  }

  async push(ctx: ProviderContext): Promise<SessionResult> {
    const scope = ctx.config.session?.scope ?? 'project';
    const workspace = ctx.config.workspace;
    const machine = machineName();

    // Determine source path based on scope
    let sourcePath: string;
    switch (scope) {
      case 'project':
        sourcePath = this.getProjectSessionPath(ctx.workspaceRoot);
        break;
      case 'workspace':
        sourcePath = this.getWorkspaceClaudePath(ctx.workspaceRoot);
        break;
      case 'global':
        sourcePath = this.getClaudeHome();
        break;
      default:
        return { action: 'noop', detail: `unknown scope: ${scope}` };
    }

    // Check if source exists
    if (!(await pathExists(sourcePath))) {
      return { action: 'noop', detail: `no Claude data at ${sourcePath}` };
    }

    if (ctx.dryRun) {
      return { action: 'noop', detail: `would push ${scope} session from ${sourcePath}` };
    }

    const target = await this.getSyncTarget(ctx);
    if (!target) {
      return { action: 'noop', detail: 'no sync target configured (set session.sync or database.sync)' };
    }

    // Create tar archive
    const archiveName = this.sessionFileName(workspace, scope, machine);
    const tempDir = path.join(os.tmpdir(), 'envbeam-session');
    await ensureDir(tempDir);
    const archivePath = path.join(tempDir, archiveName);

    // Create metadata file with path mapping
    const metadataPath = path.join(tempDir, 'envbeam-session-meta.json');
    const metadata = {
      workspace,
      scope,
      machine,
      workspaceRoot: ctx.workspaceRoot,
      timestamp: new Date().toISOString(),
      remotePaths: {
        ...ctx.config.session?.remotePaths,
        [machine]: ctx.workspaceRoot,
      },
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Create tarball with session data + metadata
    const tarRes = await ctx.runner.run(
      'tar',
      ['-czf', archivePath, '-C', path.dirname(sourcePath), path.basename(sourcePath)],
      { cwd: ctx.workspaceRoot, allowFailure: true },
    );

    if (tarRes.code !== 0) {
      return { action: 'noop', detail: `tar failed: ${tarRes.stderr}` };
    }

    // Get sync config for encryption settings
    const syncConfig: SyncConfig | undefined =
      ctx.config.session?.sync ?? ctx.config.database?.sync;

    // Apply encryption if configured
    const suffix = encryptionSuffix(syncConfig);
    let uploadPath = archivePath;
    let uploadName = archiveName;
    if (suffix && syncConfig) {
      uploadPath = archivePath + suffix;
      uploadName = archiveName + suffix;
      await encryptFile(ctx, syncConfig, archivePath, uploadPath);
      ctx.logger.sub(`session encrypted with ${syncConfig.encrypt}`);
    }

    // Upload metadata separately (not encrypted - contains no sensitive data)
    const metaArchiveName = archiveName.replace('.tar.gz', '.meta.json');

    try {
      await target.put(ctx, uploadPath, uploadName);
      await target.put(ctx, metadataPath, metaArchiveName);

      // Cleanup local files
      await fs.rm(archivePath, { force: true });
      if (suffix) await fs.rm(uploadPath, { force: true });
      await fs.rm(metadataPath, { force: true });

      const encNote = suffix ? ` (encrypted with ${syncConfig!.encrypt})` : '';
      return { action: 'pushed', detail: `${scope} session pushed${encNote}` };
    } catch (e) {
      return { action: 'noop', detail: `upload failed: ${(e as Error).message}` };
    }
  }

  async pull(ctx: ProviderContext): Promise<SessionResult> {
    const scope = ctx.config.session?.scope ?? 'project';
    const workspace = ctx.config.workspace;
    const machine = machineName();

    if (ctx.dryRun) {
      return { action: 'noop', detail: `would pull ${scope} session` };
    }

    const target = await this.getSyncTarget(ctx);
    if (!target) {
      return { action: 'noop', detail: 'no sync target configured' };
    }

    // List available sessions for this workspace
    const entries = await target.list(ctx, `claude-session-${workspace}`);
    if (!entries.length) {
      return { action: 'noop', detail: 'no session backups found' };
    }

    // Find the most recent session (not from this machine if possible)
    const otherMachine = entries.find((e) => {
      const parsed = this.parseSessionFileName(e.name);
      return parsed && parsed.machine !== machine && parsed.scope === scope;
    });
    const latest = otherMachine ?? entries[0];
    if (!latest) {
      return { action: 'noop', detail: 'no matching session found' };
    }

    const parsed = this.parseSessionFileName(latest.name);
    if (!parsed) {
      return { action: 'noop', detail: 'invalid session filename' };
    }

    // Download archive
    const tempDir = path.join(os.tmpdir(), 'envbeam-session');
    await ensureDir(tempDir);

    // Get sync config for decryption
    const syncConfig: SyncConfig | undefined =
      ctx.config.session?.sync ?? ctx.config.database?.sync;
    const suffix = encryptionSuffix(syncConfig);

    // Find the right file (with or without encryption suffix)
    let downloadName = latest.name;
    if (suffix && !downloadName.endsWith(suffix)) {
      // Look for encrypted version
      const encryptedEntry = entries.find((e) => e.name === latest.name + suffix);
      if (encryptedEntry) {
        downloadName = encryptedEntry.name;
      }
    }

    const downloadPath = path.join(tempDir, downloadName);
    const archivePath = path.join(tempDir, latest.name); // After decryption
    const metaPath = path.join(tempDir, latest.name.replace('.tar.gz', '.meta.json'));

    try {
      await target.get(ctx, downloadName, downloadPath);
    } catch (e) {
      return { action: 'noop', detail: `download failed: ${(e as Error).message}` };
    }

    // Decrypt if needed
    if (downloadName.endsWith(suffix) && suffix && syncConfig) {
      await decryptFile(ctx, syncConfig, downloadPath, archivePath);
      await fs.rm(downloadPath, { force: true });
      ctx.logger.sub(`session decrypted`);
    }

    // Try to get metadata
    let metadata: { workspaceRoot?: string; remotePaths?: Record<string, string> } = {};
    try {
      await target.get(ctx, latest.name.replace('.tar.gz', '.meta.json'), metaPath);
      metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      // Metadata optional
    }

    // Determine destination path
    let destPath: string;
    switch (scope) {
      case 'project':
        destPath = this.getProjectSessionPath(ctx.workspaceRoot);
        break;
      case 'workspace':
        destPath = this.getWorkspaceClaudePath(ctx.workspaceRoot);
        break;
      case 'global':
        destPath = this.getClaudeHome();
        break;
      default:
        return { action: 'noop', detail: `unknown scope: ${scope}` };
    }

    await ensureDir(destPath);

    // Extract archive
    const extractRes = await ctx.runner.run(
      'tar',
      ['-xzf', archivePath, '-C', path.dirname(destPath)],
      { cwd: ctx.workspaceRoot, allowFailure: true },
    );

    if (extractRes.code !== 0) {
      return { action: 'noop', detail: `extract failed: ${extractRes.stderr}` };
    }

    // Path translation for project sessions
    if (scope === 'project' && metadata.workspaceRoot && metadata.workspaceRoot !== ctx.workspaceRoot) {
      await this.translatePaths(destPath, metadata.workspaceRoot, ctx.workspaceRoot);
    }

    // Cleanup
    await fs.rm(archivePath, { force: true });
    await fs.rm(metaPath, { force: true }).catch(() => {});

    return {
      action: 'pulled',
      detail: `${scope} session restored from ${parsed.machine} (${parsed.timestamp})`,
    };
  }

  /**
   * Translate file paths in session files from source machine path to local path.
   */
  private async translatePaths(
    sessionDir: string,
    sourcePath: string,
    destPath: string,
  ): Promise<void> {
    // Claude session files may contain absolute paths
    // Walk through JSON files and replace paths
    const files = await this.walkJsonFiles(sessionDir);
    for (const file of files) {
      try {
        let content = await fs.readFile(file, 'utf8');
        if (content.includes(sourcePath)) {
          content = content.replace(new RegExp(this.escapeRegex(sourcePath), 'g'), destPath);
          await fs.writeFile(file, content);
        }
      } catch {
        // Skip files that can't be read/written
      }
    }
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async walkJsonFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await this.walkJsonFiles(fullPath)));
        } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Directory may not exist
    }
    return files;
  }

  async status(ctx: ProviderContext): Promise<SessionStatus> {
    const scope = ctx.config.session?.scope ?? 'project';
    let sourcePath: string;

    switch (scope) {
      case 'project':
        sourcePath = this.getProjectSessionPath(ctx.workspaceRoot);
        break;
      case 'workspace':
        sourcePath = this.getWorkspaceClaudePath(ctx.workspaceRoot);
        break;
      case 'global':
        sourcePath = this.getClaudeHome();
        break;
      default:
        return { available: false, detail: `unknown scope: ${scope}` };
    }

    const exists = await pathExists(sourcePath);
    const target = await this.getSyncTarget(ctx);

    return {
      available: true,
      detail: exists
        ? `Claude ${scope} data exists at ${sourcePath}`
        : `no Claude ${scope} data yet`,
      syncConfigured: target != null,
    };
  }
}

export const claudeNativeProviderFactory: ProviderFactory<SessionProvider> = {
  kind: 'session',
  name: 'claude-native',
  create: () => new ClaudeNativeProvider(),
};
