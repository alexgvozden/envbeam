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
import { createSyncTarget, encryptFile, decryptFile, sha256File, recordArtifactHash, verifyArtifact } from '../../sync/index.js';
import {
  getGlobalStorageConfig,
  injectStorageEnv,
  getGlobalEncryptionConfig,
  injectEncryptionEnv,
} from '../../storage/global.js';
import { ensureDir, pathExists } from '../../util/fs.js';
import { ensureTools } from '../../util/tools.js';
import { patchState } from '../../state.js';
import { mergeSessionTree, summarizeMerge, type MergeReport } from './merge.js';
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

/**
 * Milliseconds for a session-archive timestamp (`2026-07-10T12-30-00`, UTC —
 * see {@link ClaudeNativeProvider.sessionFileName}). 0 when unparseable, which
 * callers must treat as "unknown", never as "very old".
 */
export function sessionTimestampMs(timestamp: string): number {
  const m = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(ms) ? ms : 0;
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

/** Whether any entry in the tree (recursively) is a symlink. */
async function containsSymlink(dir: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) return true;
    if (e.isDirectory() && (await containsSymlink(path.join(dir, e.name)))) return true;
  }
  return false;
}

/** Config files whose contents cause code execution when Claude next runs. */
function isSensitiveConfigFile(name: string): boolean {
  return name === 'settings.json' || name === 'settings.local.json' || name.endsWith('.mcp.json');
}

/**
 * Copy a restored session tree into place, treating the archive as untrusted:
 * skip symlinks entirely, and never write files that would inject hooks/MCP
 * servers/settings (which would run commands the next time Claude starts).
 *
 * Modification times are carried over from the archive (tar preserves them), so
 * a restored transcript keeps the time it was last *written*, not the time it
 * was restored. Freshness comparisons on the next pull depend on this.
 */
async function safeCopySessionTree(srcDir: string, destDir: string, scope: string): Promise<void> {
  await ensureDir(destDir);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    if (e.isDirectory()) {
      await safeCopySessionTree(s, d, scope);
    } else if (e.isFile()) {
      if (isSensitiveConfigFile(e.name)) continue;
      await fs.copyFile(s, d);
      const st = await fs.stat(s).catch(() => null);
      if (st) await fs.utimes(d, st.atime, st.mtime).catch(() => undefined);
    }
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

    // Everything below is written to a private (0700) temp dir that is removed
    // in the finally — so the plaintext session tar (source paths, tokens,
    // whole-DB in some scopes) never lingers in a shared tmp dir on any path.
    const archiveName = this.sessionFileName(workspace, scope, machine);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envbeam-session-'));
    const archivePath = path.join(tempDir, archiveName);
    try {
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

      // Upload metadata separately (not encrypted, but hashed below so tamper
      // is detectable — see the integrity manifest).
      const metaArchiveName = archiveName.replace('.tar.gz', '.meta.json');
      try {
        await target.put(ctx, uploadPath, uploadName);
        await target.put(ctx, metadataPath, metaArchiveName);
      } catch (e) {
        return { action: 'noop', detail: `upload failed: ${(e as Error).message}` };
      }

      // Anchor integrity in Doppler: record sha256 of the encrypted archive AND
      // the plaintext metadata, pruning to what's still on the target.
      const live = new Set(
        (await target.listNames(ctx, `claude-session-${workspace}`).catch(() => [])).map((e) => e.name),
      );
      const recorded =
        (await recordArtifactHash(ctx.runner, workspace, uploadName, await sha256File(uploadPath), live)) &&
        (await recordArtifactHash(ctx.runner, workspace, metaArchiveName, await sha256File(metadataPath), live));
      if (recorded) ctx.logger.sub(pc.dim('integrity hash recorded'));
      else ctx.logger.warn('could not record integrity hash in Doppler — restore cannot verify this archive');

      await patchState(ctx.workspaceRoot, { baseSessionName: uploadName });
      return { action: 'pushed', detail: `${scope} session pushed (encrypted with age)`, artifact: uploadName };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async pull(ctx: ProviderContext): Promise<SessionResult> {
    const scope = ctx.config.session?.scope ?? 'project';
    const workspace = ctx.config.workspace;

    if (ctx.dryRun) {
      return { action: 'noop', detail: `would pull ${scope} session` };
    }

    const target = await this.getSyncTarget(ctx);
    if (!target) return { action: 'noop', detail: 'no sync target configured' };

    // Every encrypted archive for this workspace + scope, newest first. Uses
    // listNames (raw prefix match) — target.list() only understands DB-snapshot
    // filenames. Match scope via an exact filename PREFIX (workspace + scope are
    // values we control) rather than parsing the scope out — a greedy regex
    // mis-splits when a machine/host segment happens to contain a scope keyword.
    const prefix = `claude-session-${workspace}-${scope}-`;
    const candidates = (await target.listNames(ctx, `claude-session-${workspace}`))
      .filter((e) => e.name.startsWith(prefix) && e.name.endsWith('.tar.gz.age'))
      .map((e) => ({ name: e.name, parsed: parseSessionFileName(e.name.replace(/\.age$/, '')) }))
      .sort((a, b) => (b.parsed?.timestamp ?? b.name).localeCompare(a.parsed?.timestamp ?? a.name));
    if (!candidates.length) {
      return { action: 'noop', detail: 'no session backups found' };
    }

    const dest = await this.resolveSessionPath(scope, ctx.workspaceRoot);

    // `global` scope is the whole Claude config dir — plugins, todos, shell
    // snapshots, statsig caches. Union semantics are not meaningful there, so it
    // keeps the coarse rule: newest archive wins, and never over newer local data.
    if (scope === 'global') {
      const chosen = candidates[0]!;
      const archiveMs = chosen.parsed ? sessionTimestampMs(chosen.parsed.timestamp) : 0;
      const localMs = dest.exists ? await newestActivity(dest.dir) : 0;
      if (archiveMs && localMs > archiveMs && !ctx.force) {
        return {
          action: 'noop',
          detail:
            `local Claude data (last written ${new Date(localMs).toISOString()}) is newer than the newest ` +
            `backup (${chosen.parsed?.timestamp}, from ${chosen.parsed?.machine ?? 'unknown'}) — not restoring. ` +
            `Push from this machine, or re-run with --force to overwrite it.`,
        };
      }
      if (archiveMs && localMs > archiveMs) {
        ctx.logger.warn('--force: overwriting global Claude data that is newer than the archive.');
      }
      return this.restoreArchives(ctx, target, [chosen], dest, scope, workspace);
    }

    // Restore the union of the LATEST archive per machine, oldest first
    // (SYNC_SAFETY.md T5). Restoring only the single newest archive silently
    // omits sessions that exist only in a third machine's older archive, so
    // session sync never converges — no machine ever ends up holding all of it.
    // Oldest-first so that where a rule is "newest wins" (memory/), the newest
    // archive genuinely writes last.
    const latestPerMachine = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      const machine = c.parsed?.machine ?? c.name;
      if (!latestPerMachine.has(machine)) latestPerMachine.set(machine, c); // candidates are newest-first
    }
    const chosen = [...latestPerMachine.values()].reverse();
    if (chosen.length > 1) {
      ctx.logger.sub(pc.dim(`merging ${chosen.length} archives (latest per machine: ${[...latestPerMachine.keys()].join(', ')})`));
    }

    return this.restoreArchives(ctx, target, chosen, dest, scope, workspace);
  }

  /** Download, verify, decrypt, extract and merge each archive in order. */
  private async restoreArchives(
    ctx: ProviderContext,
    target: NonNullable<Awaited<ReturnType<ClaudeNativeProvider['getSyncTarget']>>>,
    archives: Array<{ name: string; parsed: ParsedSessionName | null }>,
    dest: ResolvedSessionPath,
    scope: string,
    workspace: string,
  ): Promise<SessionResult> {
    const syncConfig: SyncConfig | undefined = ctx.config.session?.sync ?? ctx.config.database?.sync;
    if (!syncConfig) return { action: 'noop', detail: 'no sync target configured' };

    const keyErr = await this.ensureEncryptionKeys(ctx, 'private');
    if (keyErr) return { action: 'noop', detail: keyErr };

    // Decryption needs age too — install it for the user if missing.
    const age = await ensureTools(['age'], ctx.runner, ctx.logger, ctx.prompter);
    if (!age.allInstalled) {
      return { action: 'noop', detail: 'age (encryption tool) is not installed — session not restored' };
    }

    // Private, unpredictable, owner-only temp dir (not a fixed world-readable
    // path). Everything decrypted/extracted below lives here and is removed in
    // the finally, even on early errors — no plaintext session data lingers.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envbeam-session-'));
    const reports: MergeReport[] = [];
    const restored: string[] = [];
    const failures: string[] = [];

    try {
      ctx.logger.sub(pc.dim(`restoring into ${dest.dir}`));
      await ensureDir(path.dirname(dest.dir));

      for (const archive of archives) {
        const machine = archive.parsed?.machine ?? 'unknown';
        const work = path.join(tempDir, machine);
        await ensureDir(work);
        const downloadPath = path.join(work, archive.name);
        const archiveBase = archive.name.replace(/\.age$/, '');
        const archivePath = path.join(work, archiveBase);
        const metaName = archiveBase.replace('.tar.gz', '.meta.json');
        const metaPath = path.join(work, metaName);
        const extractDir = path.join(work, 'extract');

        try {
          await target.get(ctx, archive.name, downloadPath);
        } catch (e) {
          failures.push(`${machine}: download failed (${(e as Error).message})`);
          continue;
        }

        // Verify the encrypted archive against the Doppler-anchored hash BEFORE
        // decrypting. A mismatch means the bucket object was tampered/replaced.
        const verdict = await verifyArtifact(ctx.runner, workspace, archive.name, downloadPath);
        if (verdict === 'mismatch') {
          failures.push(`${machine}: failed integrity check (Doppler hash mismatch) — skipped`);
          continue;
        }
        if (verdict === 'missing') {
          ctx.logger.warn(`no integrity hash on record for ${archive.name} — cannot verify it was not tampered`);
        }

        await decryptFile(ctx, { ...syncConfig, encrypt: 'age' }, downloadPath, archivePath);
        await fs.rm(downloadPath, { force: true });

        // Metadata (optional): records the source machine's workspace path. It's
        // plaintext, so only trust it if its integrity hash also verifies.
        let metadata: { workspaceRoot?: string } = {};
        try {
          await target.get(ctx, metaName, metaPath);
          if ((await verifyArtifact(ctx.runner, workspace, metaName, metaPath)) !== 'mismatch') {
            metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));
          } else {
            ctx.logger.warn('session metadata failed integrity check — ignoring it (paths won’t be translated)');
          }
        } catch {
          /* metadata optional */
        }

        // The archive is downloaded from remote storage and is only encrypted for
        // confidentiality — its CONTENTS are untrusted. `--no-same-owner`, and
        // after extraction we refuse any symlink (the classic tar breakout) and
        // merge plain files only, skipping security-sensitive Claude config files.
        await ensureDir(extractDir);
        const extractRes = await ctx.runner.run('tar', ['-xzf', archivePath, '--no-same-owner', '-C', extractDir], {
          cwd: ctx.workspaceRoot,
          allowFailure: true,
        });
        if (extractRes.code !== 0) {
          failures.push(`${machine}: extract failed (${extractRes.stderr.trim()})`);
          continue;
        }
        if (await containsSymlink(extractDir)) {
          failures.push(`${machine}: archive contains a symlink (possible tar breakout) — skipped`);
          continue;
        }

        const [extractedName] = await fs.readdir(extractDir);
        if (!extractedName) {
          failures.push(`${machine}: archive was empty`);
          continue;
        }
        const tree = path.join(extractDir, extractedName);

        // Translate absolute paths to this machine's layout BEFORE merging, so
        // the byte comparison against local transcripts is apples to apples.
        // Guard against a bogus/short metadata value that would corrupt files.
        const src = metadata.workspaceRoot;
        if (scope === 'project' && src && src !== ctx.workspaceRoot && path.isAbsolute(src) && src.length >= 4) {
          await this.translatePaths(tree, src, ctx.workspaceRoot);
        }

        reports.push(
          scope === 'global'
            ? await this.copyWholeTree(tree, dest.dir)
            : await mergeSessionTree(tree, dest.dir, machine),
        );
        restored.push(machine);
      }

      for (const f of failures) ctx.logger.warn(`session: ${f}`);
      if (!restored.length) {
        return { action: 'noop', detail: failures.join('; ') || 'nothing restored' };
      }

      const sidecars = reports.flatMap((r) => r.sidecars);
      if (sidecars.length) {
        ctx.logger.warn(
          `${sidecars.length} session file(s) diverged — the remote copy was written beside yours, nothing was overwritten:`,
        );
        for (const s of sidecars.slice(0, 10)) ctx.logger.sub(pc.dim(`  ${s}`));
      }

      // The base is the newest archive we successfully merged.
      const newest = archives[archives.length - 1];
      if (newest) await patchState(ctx.workspaceRoot, { baseSessionName: newest.name });

      return {
        action: 'pulled',
        detail: `${scope} session merged from ${restored.join(', ')} (${summarizeMerge(reports)}) → ${dest.dir}`,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** `global` scope: coarse whole-tree copy, as before (§7 scope caveat). */
  private async copyWholeTree(src: string, dest: string): Promise<MergeReport> {
    await safeCopySessionTree(src, dest, 'global');
    return { actions: [], sidecars: [] };
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
