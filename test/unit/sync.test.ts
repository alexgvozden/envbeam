import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { LocalFolderTarget } from '../../src/core/sync/localFolder.js';
import { S3Target } from '../../src/core/sync/s3.js';
import { createSyncTarget, syncTargetTools } from '../../src/core/sync/index.js';
import { encryptionSuffix, requiredCryptoTools } from '../../src/core/sync/crypto.js';
import { snapshotName, parseSnapshotName, formatTimestamp, sortByTimestampDesc } from '../../src/core/sync/types.js';
import { syncConfigSchema } from '../../src/core/config/schema.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import type { ProviderContext } from '../../src/core/providers/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function pctx(runner = new FakeRunner()): ProviderContext {
  return makeTestContext({ config: { version: 1, workspace: 'keeper' }, runner }).providerCtx('database');
}

describe('snapshot naming', () => {
  it('round-trips workspace/timestamp/machine/ext', () => {
    const name = snapshotName('keeper-api', '20260627T120000Z', 'laptop', 'sql.gz');
    expect(name).toBe('keeper-api__20260627T120000Z__laptop.sql.gz');
    expect(parseSnapshotName(name)).toEqual({ workspace: 'keeper-api', timestamp: '20260627T120000Z', machine: 'laptop', ext: 'sql.gz' });
  });

  it('formats a UTC timestamp sortably and sorts desc', () => {
    expect(formatTimestamp(new Date('2026-06-27T12:00:00.123Z'))).toBe('20260627T120000Z');
    const sorted = sortByTimestampDesc([
      { ref: 'a', name: 'a', timestamp: '20260101T000000Z' },
      { ref: 'b', name: 'b', timestamp: '20260301T000000Z' },
    ]);
    expect(sorted[0]!.ref).toBe('b');
  });

  it('rejects malformed names', () => {
    expect(parseSnapshotName('nope.sql')).toBeNull();
  });
});

describe('local-folder target', () => {
  it('puts, lists (filtered by workspace), gets, and prunes to keep N', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const folder = path.join(dir, 'snaps');
    const target = new LocalFolderTarget(syncConfigSchema.parse({ target: 'local-folder', path: folder, keep: 2 }), 'local-folder');
    const ctx = pctx();

    // create three snapshots for keeper + one for another workspace
    for (const ts of ['20260101T000000Z', '20260201T000000Z', '20260301T000000Z']) {
      const src = path.join(dir, `src-${ts}.sql`);
      await fs.writeFile(src, `dump ${ts}`);
      await target.put(ctx, src, snapshotName('keeper', ts, 'laptop', 'sql'));
    }
    const other = path.join(dir, 'other.sql');
    await fs.writeFile(other, 'x');
    await target.put(ctx, other, snapshotName('different', '20260401T000000Z', 'laptop', 'sql'));

    const list = await target.list(ctx, 'keeper');
    expect(list.map((e) => e.timestamp)).toEqual(['20260301T000000Z', '20260201T000000Z', '20260101T000000Z']);

    const dest = path.join(dir, 'restored.sql');
    await target.get(ctx, list[0]!.ref, dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('dump 20260301T000000Z');

    const pruned = await target.prune(ctx, 'keeper', 2);
    expect(pruned).toHaveLength(1);
    expect((await target.list(ctx, 'keeper')).map((e) => e.timestamp)).toEqual(['20260301T000000Z', '20260201T000000Z']);
    // other workspace untouched
    expect(await target.list(ctx, 'different')).toHaveLength(1);
  });

  it('requires a path', () => {
    expect(() => new LocalFolderTarget(syncConfigSchema.parse({ target: 'local-folder' }), 'local-folder')).toThrow(/sync.path/);
  });

  it('listNames matches a raw prefix (finds non-snapshot artifacts like sessions)', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const folder = path.join(dir, 'store');
    const target = new LocalFolderTarget(syncConfigSchema.parse({ target: 'local-folder', path: folder }), 'local-folder');
    const ctx = pctx();
    const src = path.join(dir, 's');
    await fs.writeFile(src, 'x');
    // a session archive (NOT snapshot-formatted) + a db snapshot in the same store
    await target.put(ctx, src, 'claude-session-synthetic-signals-project-mac-2026-07-08T10-14-27.tar.gz.age');
    await target.put(ctx, src, snapshotName('synthetic-signals', '20260708T000000Z', 'mac', 'sql'));

    // list() (snapshot-aware) drops the session; listNames() finds it by prefix
    expect((await target.list(ctx, 'synthetic-signals')).some((e) => e.name.includes('claude-session'))).toBe(false);
    const names = await target.listNames(ctx, 'claude-session-synthetic-signals');
    expect(names.map((n) => n.name)).toEqual(['claude-session-synthetic-signals-project-mac-2026-07-08T10-14-27.tar.gz.age']);
  });
});

describe('s3 target', () => {
  it('uploads with cp and lists via list-objects-v2 filtered by workspace', async () => {
    const runner = new FakeRunner({ available: ['aws'] });
    runner.on('aws s3api list-objects-v2', {
      stdout: JSON.stringify({
        Contents: [
          { Key: 'snaps/keeper__20260101T000000Z__laptop.dump', Size: 10 },
          { Key: 'snaps/other__20260101T000000Z__laptop.dump', Size: 20 },
        ],
      }),
    });
    const target = new S3Target(syncConfigSchema.parse({ target: 's3', bucket: 'mybucket', prefix: 'snaps', region: 'us-east-1' }), 'personal');
    const ctx = pctx(runner);

    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const f = path.join(dir, 'd.dump');
    await fs.writeFile(f, 'x');
    await target.put(ctx, f, 'keeper__20260201T000000Z__laptop.dump');
    const cp = runner.callsTo('aws').find((c) => c.args.includes('cp'))!;
    expect(cp.args).toContain('s3://mybucket/snaps/keeper__20260201T000000Z__laptop.dump');
    expect(cp.args).toContain('--profile');
    expect(cp.args).toContain('personal');

    const list = await target.list(ctx, 'keeper');
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toContain('keeper__');
  });
});

describe('sync factory + crypto helpers', () => {
  it('builds targets by kind and reports required tools', () => {
    expect(createSyncTarget(syncConfigSchema.parse({ target: 'syncthing', path: '/tmp/x' })).kind).toBe('syncthing');
    expect(createSyncTarget(syncConfigSchema.parse({ target: 's3', bucket: 'b' })).kind).toBe('s3');
    expect(syncTargetTools(syncConfigSchema.parse({ target: 's3', bucket: 'b' }))).toEqual(['aws']);
    expect(syncTargetTools(syncConfigSchema.parse({ target: 'local-folder', path: '/x' }))).toEqual([]);
  });

  it('computes encryption suffix and crypto tools', () => {
    expect(encryptionSuffix(syncConfigSchema.parse({ target: 'local-folder', path: '/x', encrypt: 'age' }))).toBe('.age');
    expect(encryptionSuffix(syncConfigSchema.parse({ target: 'local-folder', path: '/x' }))).toBe('.age');
    expect(encryptionSuffix(undefined)).toBe('');
    expect(requiredCryptoTools(syncConfigSchema.parse({ target: 'local-folder', path: '/x', encrypt: 'gpg' }))).toEqual(['gpg']);
  });
});
