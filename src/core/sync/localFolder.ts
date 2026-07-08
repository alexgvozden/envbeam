import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ProviderContext } from '../providers/types.js';
import type { SyncConfig } from '../config/schema.js';
import { EnvbeamError } from '../util/errors.js';
import { ensureDir, expandHome } from '../util/fs.js';
import {
  type SnapshotEntry,
  type SyncTarget,
  type SyncTargetStatus,
  parseSnapshotName,
  sortByTimestampDesc,
} from './types.js';

/**
 * Local-folder / Syncthing target. A Syncthing folder is just a watched local
 * directory, so both share this implementation; `kind` differs for reporting.
 */
export class LocalFolderTarget implements SyncTarget {
  readonly kind: 'local-folder' | 'syncthing';
  private readonly dir: string;

  constructor(cfg: SyncConfig, kind: 'local-folder' | 'syncthing') {
    this.kind = kind;
    if (!cfg.path) {
      throw new EnvbeamError(`sync.target ${kind} requires sync.path (the folder to use).`, {
        exitCode: 2,
      });
    }
    const base = expandHome(cfg.path);
    this.dir = cfg.prefix ? path.join(base, cfg.prefix) : base;
  }

  private fullPath(ref: string): string {
    return path.join(this.dir, ref);
  }

  async verify(_ctx: ProviderContext): Promise<SyncTargetStatus> {
    try {
      // Check if directory exists or can be created
      await ensureDir(this.dir);
      // Try to write a test file to verify write access
      const testFile = path.join(this.dir, '.envbeam-verify-test');
      await fs.writeFile(testFile, 'test', { mode: 0o600 });
      await fs.rm(testFile, { force: true });
      return { ok: true, detail: `${this.kind} path ${this.dir} accessible` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('EACCES') || msg.includes('permission denied')) {
        return { ok: false, detail: `no write access to ${this.dir}` };
      }
      if (msg.includes('ENOENT')) {
        return { ok: false, detail: `cannot create directory ${this.dir}` };
      }
      return { ok: false, detail: msg };
    }
  }

  async put(_ctx: ProviderContext, localFile: string, name: string): Promise<SnapshotEntry> {
    await ensureDir(this.dir);
    const dest = this.fullPath(name);
    await fs.copyFile(localFile, dest);
    const st = await fs.stat(dest);
    const parsed = parseSnapshotName(name);
    return {
      ref: name,
      name,
      timestamp: parsed?.timestamp ?? '',
      machine: parsed?.machine,
      sizeBytes: st.size,
    };
  }

  async list(_ctx: ProviderContext, workspace: string): Promise<SnapshotEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const entries: SnapshotEntry[] = [];
    for (const name of names) {
      const parsed = parseSnapshotName(name);
      if (!parsed || parsed.workspace !== sanitize(workspace)) continue;
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await fs.stat(this.fullPath(name))).size;
      } catch {
        /* ignore */
      }
      entries.push({ ref: name, name, timestamp: parsed.timestamp, machine: parsed.machine, sizeBytes });
    }
    return sortByTimestampDesc(entries);
  }

  async listNames(_ctx: ProviderContext, namePrefix: string): Promise<Array<{ name: string; sizeBytes?: number }>> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: Array<{ name: string; sizeBytes?: number }> = [];
    for (const name of names) {
      if (!name.startsWith(namePrefix)) continue;
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await fs.stat(this.fullPath(name))).size;
      } catch {
        /* ignore */
      }
      out.push({ name, sizeBytes });
    }
    return out;
  }

  async get(_ctx: ProviderContext, ref: string, localPath: string): Promise<void> {
    await ensureDir(path.dirname(localPath));
    await fs.copyFile(this.fullPath(ref), localPath);
  }

  async prune(ctx: ProviderContext, workspace: string, keep: number): Promise<string[]> {
    const entries = await this.list(ctx, workspace);
    const toRemove = entries.slice(keep);
    for (const e of toRemove) {
      await fs.rm(this.fullPath(e.ref), { force: true });
    }
    return toRemove.map((e) => e.ref);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-');
}
