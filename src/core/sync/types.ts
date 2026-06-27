import type { ProviderContext } from '../providers/types.js';

export interface SnapshotEntry {
  /** Opaque ref the target uses to fetch (filename or S3 key). */
  ref: string;
  /** Base file name. */
  name: string;
  /** Sortable timestamp string (YYYYMMDDTHHMMSSZ), parsed from the name. */
  timestamp: string;
  machine?: string;
  sizeBytes?: number;
}

/** Where DB snapshots live. The user owns this; envbeam has no backend (PRD §10). */
export interface SyncTarget {
  readonly kind: 'local-folder' | 'syncthing' | 's3';
  /** Upload a local file under `name`; returns its ref. */
  put(ctx: ProviderContext, localFile: string, name: string): Promise<SnapshotEntry>;
  /** List snapshots for the current workspace, most recent first. */
  list(ctx: ProviderContext, workspace: string): Promise<SnapshotEntry[]>;
  /** Download `ref` to `localPath`. */
  get(ctx: ProviderContext, ref: string, localPath: string): Promise<void>;
  /** Delete snapshots beyond the `keep` most recent; returns removed refs. */
  prune(ctx: ProviderContext, workspace: string, keep: number): Promise<string[]>;
}

const SEP = '__';

/** Build the canonical snapshot file name. */
export function snapshotName(
  workspace: string,
  timestamp: string,
  machine: string,
  ext: string,
): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-');
  return `${safe(workspace)}${SEP}${timestamp}${SEP}${safe(machine)}.${ext}`;
}

export interface ParsedSnapshotName {
  workspace: string;
  timestamp: string;
  machine: string;
  ext: string;
}

export function parseSnapshotName(name: string): ParsedSnapshotName | null {
  const dot = name.indexOf('.');
  if (dot < 0) return null;
  const base = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  const parts = base.split(SEP);
  if (parts.length !== 3) return null;
  const [workspace, timestamp, machine] = parts as [string, string, string];
  return { workspace, timestamp, machine, ext };
}

/** UTC timestamp in sortable compact form (YYYYMMDDTHHMMSSZ). */
export function formatTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function sortByTimestampDesc(entries: SnapshotEntry[]): SnapshotEntry[] {
  return [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}
