import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import type {
  SessionProvider,
  SessionResult,
  SessionStatus,
  ProviderContext,
  ToolRequirement,
} from '../types.js';
import type { ProviderFactory } from '../registry.js';
import type { SyncConfig } from '../../config/schema.js';
import { createSyncTarget, encryptFile, decryptFile } from '../../sync/index.js';
import {
  getGlobalStorageConfig,
  injectStorageEnv,
  getGlobalEncryptionConfig,
  injectEncryptionEnv,
} from '../../storage/global.js';
import { ensureDir, pathExists } from '../../util/fs.js';
import { ensureTools } from '../../util/tools.js';
import { machineName } from '../database/base.js';

/**
 * Claude Code stores a project's sessions under
 * `<config-dir>/projects/<sanitized-path>/`, where the sanitized name is the
 * absolute workspace path with every non-alphanumeric character replaced by
 * '-'. The LEADING DASH IS KEPT: /Users/me/app → -Users-me-app.
 */
export function claudeProjectDirName(workspaceRoot: string): string {
  return workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface ParsedSessionName {
  workspace: string;
  scope: string;
  machine: string;
  timestamp: string;
}

/**
 * Parse `claude-session-<workspace>-<scope>-<machine>-<ts>.tar.gz`. Workspace
 * and machine names routinely contain dashes (e.g. "synthetic-signals",
 * hostnames), so anchor on the scope keyword and the timestamp shape instead
 * of assuming dash-free segments.
 */
export function parseSessionFileName(name: string): ParsedSessionName | null {
  const m = name.match(
    /^claude-session-(.+)-(project|workspace|global)-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.tar\.gz$/,
  );
  if (!m) return null;
  return { workspace: m[1]!, scope: m[2]!, machine: m[3]!, timestamp: m[4]! };
}

/** Newest .jsonl mtime in a directory (falls back to the dir's own mtime). */
async function newestActivity(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let newest = 0;
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const st = await fs.stat(path.join(dir, e.name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
    if (newest) return newest;
    return (await fs.stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
}

interface ResolvedSessionPath {
  /** Directory holding the session data (or where it should be restored). */
  dir: string;
  /** The Claude config dir it belongs to (equal to `dir` for workspace scope). */
  configDir: string;
  exists: boolean;
}

/**
 * Native Claude session sync — syncs Claude Code session data to S3/storage.
 *
 * Scope options:
 * - project: <claude-config>/projects/<sanitized-path>/ (default)
 * - workspace: .claude/ folder in the workspace root
 * - global: the whole Claude config dir (tools, plugins, all sessions)
 */
export class ClaudeNativeProvider implements SessionProvider {
  readonly name = 'claude-native';
  readonly kind = 'session' as const;

  requiredTools(): ToolRequirement[] {
    // Uses tar for archiving; aws CLI for S3 (if S3 target)
    return [];
  }

  /**
   * Candidate Claude config dirs. An explicit CLAUDE_CONFIG_DIR (Claude Code's
   * own env var, often set via a shell alias) or legacy CLAUDE_HOME wins;
   * otherwise every ~/.claude* directory is a candidate — users run Claude
   * with alternate config dirs like ~/.claude-personal.
   */
  private async candidateConfigDirs(): Promise<{ dirs: string[]; fromEnv: boolean }> {
    const env = process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME;
    if (env) return { dirs: [path.resolve(env)], fromEnv: true };

    const home = os.homedir();
    const dirs: string[] = [];
    try {
      for (const e of await fs.readdir(home, { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith('.claude')) dirs.push(path.join(home, e.name));
      }
    } catch {
      /* unreadable home — fall through */
    }
    if (!dirs.length) dirs.push(path.join(home, '.claude'));
    return { dirs: dirs.sort(), fromEnv: false };
  }

  /**
   * Resolve where this scope's Claude data lives (or should be restored to):
   * among the candidate config dirs, pick the one with the most recent
   * session activity for this project; fall back to the first candidate.
   */
  private async resolveSessionPath(scope: string, workspaceRoot: string): Promise<ResolvedSessionPath> {
    if (scope === 'workspace') {
      const p = path.join(workspaceRoot, '.claude');
      return { dir: p, configDir: p, exists: await pathExists(p) };
    }
    const { dirs } = await this.candidateConfigDirs();
    const sub = scope === 'global' ? '' : path.join('projects', claudeProjectDirName(workspaceRoot));

    let best: { dir: string; configDir: string; activity: number } | null = null;
    for (const configDir of dirs) {
      const dir = sub ? path.join(configDir, sub) : configDir;
      if (!(await pathExists(dir))) continue;
      const activity = await newestActivity(dir);
      if (!best || activity > best.activity) best = { dir, configDir, activity };
    }
    if (best) return { dir: best.dir, configDir: best.configDir, exists: true };

    const def = dirs[0]!;
    return { dir: sub ? path.join(def, sub) : def, configDir: def, exists: false };
  }

  private async getSyncTarget(ctx: ProviderContext) {
    // Use session.sync if configured, else fall back to database.sync
    const syncConfig: SyncConfig | undefined = ctx.config.session?.sync ?? ctx.config.database?.sync;
    if (!syncConfig) return null;

    // Ensure S3 credentials are available
    if (syncConfig.target === 's3' && !process.env.ENVBEAM_S3_ACCESS_KEY) {
      const globalStorage = await getGlobalStorageConfig(ctx.runner);
      if (globalStorage) injectStorageEnv(globalStorage);
    }
    return createSyncTarget(syncConfig, ctx.identity);
  }

  private sessionFileName(workspace: string, scope: string, machine: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `claude-session-${workspace}-${scope}-${machine}-${timestamp}.tar.gz`;
  }

  private async ensureEncryptionKeys(ctx: ProviderContext, need: 'public' | 'private'): Promise<string | null> {
    const envKey = need === 'public' ? 'ENVBEAM_AGE_PUBLIC_KEY' : 'ENVBEAM_AGE_PRIVATE_KEY';
    if (process.env[envKey]) return null;
    const encryptionConfig = await getGlobalEncryptionConfig(ctx.runner);
    if (!encryptionConfig) {
      return 'no encryption keys found — run `envbeam session setup` to generate them.';
    }
    injectEncryptionEnv(encryptionConfig);
    return null;
  }

  async push(ctx: ProviderContext): Promise<SessionResult> {
    const scope = ctx.config.session?.scope ?? 'project';
    const workspace = ctx.config.workspace;
    const machine = machineName();

    const source = await this.resolveSessionPath(scope, ctx.workspaceRoot);
    if (!source.exists) {
      const { dirs } = await this.candidateConfigDirs();
      return { action: 'noop', detail: `no Claude ${scope} data found (looked in ${dirs.join(', ')})` };
    }
    ctx.logger.sub(pc.dim(`using Claude config ${source.configDir}`));

    if (ctx.dryRun) {
      return { action: 'noop', detail: `would push ${scope} session from ${source.dir}` };
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

    // Metadata records the source path so restore can translate paths.
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

    // `--` ends option parsing: Claude project dir names start with '-'
    // (e.g. -Users-me-Code-app) and tar would otherwise read them as flags.
    const tarRes = await ctx.runner.run(
      'tar',
      ['-czf', archivePath, '-C', path.dirname(source.dir), '--', path.basename(source.dir)],
      { cwd: ctx.workspaceRoot, allowFailure: true },
    );
    if (tarRes.code !== 0) {
      return { action: 'noop', detail: `tar failed: ${tarRes.stderr}` };
    }
    try {
      const st = await fs.stat(archivePath);
      ctx.logger.sub(pc.dim(`session archive ${(st.size / 1024 / 1024).toFixed(1)} MB`));
    } catch {
      /* size is informational */
    }

    const syncConfig: SyncConfig | undefined = ctx.config.session?.sync ?? ctx.config.database?.sync;
    if (!syncConfig) return { action: 'noop', detail: 'no sync target configured' };

    const keyErr = await this.ensureEncryptionKeys(ctx, 'public');
    if (keyErr) return { action: 'noop', detail: keyErr };

    // Sessions are always age-encrypted — install age for the user if missing.
    const age = await ensureTools(['age'], ctx.runner, ctx.logger, ctx.prompter);
    if (!age.allInstalled) {
      return { action: 'noop', detail: 'age (encryption tool) is not installed — session not pushed' };
    }

    const encryptedConfig: SyncConfig = { ...syncConfig, encrypt: 'age' };
    const uploadPath = archivePath + '.age';
    const uploadName = archiveName + '.age';
    await encryptFile(ctx, encryptedConfig, archivePath, uploadPath);
    ctx.logger.sub('session encrypted');

    // Upload metadata separately (not encrypted — contains no sensitive data)
    const metaArchiveName = archiveName.replace('.tar.gz', '.meta.json');
    try {
      await target.put(ctx, uploadPath, uploadName);
      await target.put(ctx, metadataPath, metaArchiveName);

      await fs.rm(archivePath, { force: true });
      await fs.rm(uploadPath, { force: true });
      await fs.rm(metadataPath, { force: true });

      return { action: 'pushed', detail: `${scope} session pushed (encrypted with age)` };
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
    if (!target) return { action: 'noop', detail: 'no sync target configured' };

    // Choose the newest encrypted archive for this workspace + scope,
    // preferring one pushed from a different machine.
    const entries = await target.list(ctx, `claude-session-${workspace}`);
    const candidates = entries
      .filter((e) => e.name.endsWith('.tar.gz.age'))
      .map((e) => ({ name: e.name, parsed: parseSessionFileName(e.name.replace(/\.age$/, '')) }))
      .filter((c): c is { name: string; parsed: ParsedSessionName } => c.parsed != null && c.parsed.scope === scope)
      .sort((a, b) => b.parsed.timestamp.localeCompare(a.parsed.timestamp));
    if (!candidates.length) {
      return { action: 'noop', detail: 'no session backups found' };
    }
    const chosen = candidates.find((c) => c.parsed.machine !== machine) ?? candidates[0]!;

    const syncConfig: SyncConfig | undefined = ctx.config.session?.sync ?? ctx.config.database?.sync;
    if (!syncConfig) return { action: 'noop', detail: 'no sync target configured' };

    const keyErr = await this.ensureEncryptionKeys(ctx, 'private');
    if (keyErr) return { action: 'noop', detail: keyErr };

    // Decryption needs age too — install it for the user if missing.
    const age = await ensureTools(['age'], ctx.runner, ctx.logger, ctx.prompter);
    if (!age.allInstalled) {
      return { action: 'noop', detail: 'age (encryption tool) is not installed — session not restored' };
    }

    const tempDir = path.join(os.tmpdir(), 'envbeam-session');
    await ensureDir(tempDir);
    const downloadPath = path.join(tempDir, chosen.name);
    const archiveBase = chosen.name.replace(/\.age$/, '');
    const archivePath = path.join(tempDir, archiveBase);
    const metaPath = path.join(tempDir, archiveBase.replace('.tar.gz', '.meta.json'));

    try {
      await target.get(ctx, chosen.name, downloadPath);
    } catch (e) {
      return { action: 'noop', detail: `download failed: ${(e as Error).message}` };
    }

    const decryptConfig: SyncConfig = { ...syncConfig, encrypt: 'age' };
    await decryptFile(ctx, decryptConfig, downloadPath, archivePath);
    await fs.rm(downloadPath, { force: true });
    ctx.logger.sub('session decrypted');

    // Metadata (optional): records the source machine's workspace path.
    let metadata: { workspaceRoot?: string } = {};
    try {
      await target.get(ctx, archiveBase.replace('.tar.gz', '.meta.json'), metaPath);
      metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      /* metadata optional */
    }

    // Where should the sessions live on THIS machine? (This differs from the
    // source machine's dir name whenever the workspace path differs, so we
    // extract to a temp dir and copy into the locally-resolved destination.)
    const dest = await this.resolveSessionPath(scope, ctx.workspaceRoot);
    ctx.logger.sub(pc.dim(`restoring into ${dest.dir}`));

    const extractDir = path.join(tempDir, `extract-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
    await ensureDir(extractDir);
    const extractRes = await ctx.runner.run('tar', ['-xzf', archivePath, '-C', extractDir], {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });
    if (extractRes.code !== 0) {
      return { action: 'noop', detail: `extract failed: ${extractRes.stderr}` };
    }

    // The archive contains a single top-level dir named after the SOURCE
    // machine's sanitized path — merge its contents into the local dest.
    const [extractedName] = await fs.readdir(extractDir);
    if (!extractedName) {
      return { action: 'noop', detail: 'archive was empty' };
    }
    await ensureDir(path.dirname(dest.dir));
    await fs.cp(path.join(extractDir, extractedName), dest.dir, { recursive: true, force: true });

    // Translate absolute paths inside session files to this machine's layout.
    if (scope === 'project' && metadata.workspaceRoot && metadata.workspaceRoot !== ctx.workspaceRoot) {
      await this.translatePaths(dest.dir, metadata.workspaceRoot, ctx.workspaceRoot);
    }

    await fs.rm(archivePath, { force: true });
    await fs.rm(metaPath, { force: true }).catch(() => {});
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});

    return {
      action: 'pulled',
      detail: `${scope} session restored from ${chosen.parsed.machine} (${chosen.parsed.timestamp}) → ${dest.dir}`,
    };
  }

  /**
   * Translate file paths in session files from source machine path to local path.
   */
  private async translatePaths(sessionDir: string, sourcePath: string, destPath: string): Promise<void> {
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
    const source = await this.resolveSessionPath(scope, ctx.workspaceRoot);
    const target = await this.getSyncTarget(ctx);
    return {
      available: true,
      detail: source.exists
        ? `Claude ${scope} data exists at ${source.dir}`
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
