import path from 'node:path';
import type { ProviderContext } from '../providers/types.js';
import type { SyncConfig } from '../config/schema.js';
import { EnvbeamError } from '../util/errors.js';
import {
  type SnapshotEntry,
  type SyncTarget,
  type SyncTargetStatus,
  parseSnapshotName,
  sortByTimestampDesc,
} from './types.js';

/** S3 target. Shells out to the AWS CLI; envbeam never holds the snapshot. */
export class S3Target implements SyncTarget {
  readonly kind = 's3' as const;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region?: string;
  private readonly profile?: string;

  constructor(cfg: SyncConfig, identityProfile?: string) {
    if (!cfg.bucket) {
      throw new EnvbeamError('sync.target s3 requires sync.bucket.', { exitCode: 2 });
    }
    this.bucket = cfg.bucket;
    this.prefix = (cfg.prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.region = cfg.region;
    this.profile = identityProfile;
  }

  private key(name: string): string {
    return this.prefix ? `${this.prefix}/${name}` : name;
  }

  private uri(name: string): string {
    return `s3://${this.bucket}/${this.key(name)}`;
  }

  private baseArgs(): string[] {
    const args: string[] = [];
    if (this.region) args.push('--region', this.region);
    if (this.profile) args.push('--profile', this.profile);
    return args;
  }

  async verify(ctx: ProviderContext): Promise<SyncTargetStatus> {
    // Try head-bucket to verify credentials and bucket access
    const res = await ctx.runner.run(
      'aws',
      ['s3api', 'head-bucket', '--bucket', this.bucket, ...this.baseArgs()],
      { cwd: ctx.workspaceRoot, allowFailure: true },
    );
    if (res.code === 0) {
      return { ok: true, detail: `bucket s3://${this.bucket} accessible` };
    }
    // Parse common errors
    const stderr = res.stderr.toLowerCase();
    if (stderr.includes('403') || stderr.includes('forbidden')) {
      return { ok: false, detail: `access denied to bucket s3://${this.bucket}` };
    }
    if (stderr.includes('404') || stderr.includes('not found')) {
      return { ok: false, detail: `bucket s3://${this.bucket} does not exist` };
    }
    if (stderr.includes('unable to locate credentials')) {
      return { ok: false, detail: 'AWS credentials not configured' };
    }
    return { ok: false, detail: res.stderr.trim() || 'failed to access bucket' };
  }

  async put(ctx: ProviderContext, localFile: string, name: string): Promise<SnapshotEntry> {
    await ctx.runner.run('aws', ['s3', 'cp', localFile, this.uri(name), ...this.baseArgs()], {
      cwd: ctx.workspaceRoot,
    });
    const parsed = parseSnapshotName(name);
    return { ref: name, name, timestamp: parsed?.timestamp ?? '', machine: parsed?.machine };
  }

  async list(ctx: ProviderContext, workspace: string): Promise<SnapshotEntry[]> {
    const listPrefix = this.prefix ? `${this.prefix}/` : '';
    const res = await ctx.runner.run(
      'aws',
      ['s3api', 'list-objects-v2', '--bucket', this.bucket, '--prefix', listPrefix, ...this.baseArgs()],
      { cwd: ctx.workspaceRoot, allowFailure: true },
    );
    if (res.code !== 0 || !res.stdout.trim()) return [];
    let parsed: { Contents?: Array<{ Key?: string; Size?: number }> };
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return [];
    }
    const sane = workspace.replace(/[^A-Za-z0-9._-]/g, '-');
    const entries: SnapshotEntry[] = [];
    for (const obj of parsed.Contents ?? []) {
      if (!obj.Key) continue;
      const name = obj.Key.slice(obj.Key.lastIndexOf('/') + 1);
      const p = parseSnapshotName(name);
      if (!p || p.workspace !== sane) continue;
      entries.push({ ref: name, name, timestamp: p.timestamp, machine: p.machine, sizeBytes: obj.Size });
    }
    return sortByTimestampDesc(entries);
  }

  async get(ctx: ProviderContext, ref: string, localPath: string): Promise<void> {
    await ctx.runner.run('aws', ['s3', 'cp', this.uri(ref), localPath, ...this.baseArgs()], {
      cwd: ctx.workspaceRoot,
    });
  }

  async prune(ctx: ProviderContext, workspace: string, keep: number): Promise<string[]> {
    const entries = await this.list(ctx, workspace);
    const toRemove = entries.slice(keep);
    for (const e of toRemove) {
      await ctx.runner.run('aws', ['s3', 'rm', this.uri(e.ref), ...this.baseArgs()], {
        cwd: ctx.workspaceRoot,
        allowFailure: true,
      });
    }
    return toRemove.map((e) => e.ref);
  }
}

export function s3KeyHelper(prefix: string, name: string): string {
  return prefix ? `${path.posix.join(prefix, name)}` : name;
}
