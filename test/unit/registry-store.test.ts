import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { RegistryStore } from '../../src/core/registry/store.js';
import { EMPTY_REGISTRY, type ProjectEntryInput } from '../../src/core/registry/types.js';
import { SafetyError, EnvbeamError } from '../../src/core/util/errors.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import type { GlobalStorageConfig } from '../../src/core/config/schema.js';

const STORAGE: GlobalStorageConfig = { type: 's3', bucket: 'bkt', credentialSource: 'env' };

beforeEach(() => {
  process.env.ENVBEAM_S3_ACCESS_KEY = 'ak';
  process.env.ENVBEAM_S3_SECRET_KEY = 'sk';
});
afterEach(() => {
  delete process.env.ENVBEAM_S3_ACCESS_KEY;
  delete process.env.ENVBEAM_S3_SECRET_KEY;
});

/**
 * An in-memory S3 object with real ETag semantics: every write mints a new tag,
 * and a conditional write whose tag no longer matches is rejected with 412.
 * `onBeforePut` is the hook that lets a test interleave another machine's write
 * between our read and our write — the race R1 describes.
 */
class FakeS3 {
  content: string | null = null;
  etag = '';
  puts = 0;
  private seq = 0;
  onBeforePut?: () => void;
  onAfterPut?: () => void;
  /** Make put-object behave like an endpoint with no conditional-write support. */
  conditionalWrites = true;
  /**
   * Reproduce Ceph RGW / Hetzner: `--if-none-match` is honored, `--if-match` is
   * refused with 412 even when the ETag matches, and aws-cli mangles the empty
   * <Message/> into an opaque TypeError. No stderr regex can tell these apart.
   */
  cephRgw = false;

  constructor(initial?: unknown) {
    if (initial !== undefined) this.write(JSON.stringify(initial, null, 2));
  }

  write(content: string): void {
    this.content = content;
    this.etag = `"etag-${++this.seq}"`;
  }

  install(runner: FakeRunner): FakeRunner {
    runner.on(
      (c, a) => c === 'aws' && a[0] === 's3api' && a[1] === 'get-object',
      (_c, a) => {
        if (this.content === null) return { code: 1, stderr: 'An error occurred (404) NoSuchKey' };
        // `aws s3api get-object ... --key K <outfile>`: the outfile follows the key.
        const out = a[a.indexOf('--key') + 2]!;
        writeFileSync(out, this.content);
        return { stdout: JSON.stringify({ ETag: this.etag }) };
      },
    );
    runner.on(
      (c, a) => c === 'aws' && a[0] === 's3api' && a[1] === 'head-object',
      () =>
        this.content === null
          ? { code: 1, stderr: 'An error occurred (404) Not Found' }
          : { stdout: JSON.stringify({ ETag: this.etag }) },
    );
    runner.on(
      (c, a) => c === 'aws' && a[0] === 's3api' && a[1] === 'put-object',
      (_c, a) => {
        const ifMatch = a.includes('--if-match') ? a[a.indexOf('--if-match') + 1] : undefined;
        const ifNoneMatch = a.includes('--if-none-match');

        if (!this.conditionalWrites && (ifMatch || ifNoneMatch)) {
          return { code: 255, stderr: 'Unknown options: --if-match' };
        }
        // Verbatim from `aws s3api put-object --if-match <correct etag>` against
        // Hetzner Object Storage with aws-cli 2.35.
        const OPAQUE = "aws: [ERROR]: argument of type 'NoneType' is not a container or iterable";
        if (this.cephRgw && ifMatch) return { code: 255, stderr: OPAQUE };

        this.onBeforePut?.();

        if (ifMatch && ifMatch !== this.etag) {
          return { code: 254, stderr: this.cephRgw ? OPAQUE : 'An error occurred (PreconditionFailed) ... 412' };
        }
        if (ifNoneMatch && this.content !== null) {
          return { code: 254, stderr: this.cephRgw ? OPAQUE : 'An error occurred (PreconditionFailed) ... 412' };
        }
        const body = a[a.indexOf('--body') + 1]!;
        this.write(readFileSync(body, 'utf8'));
        this.puts++;
        this.onAfterPut?.();
        return { stdout: '{}' };
      },
    );
    return runner;
  }

  parsed(): { projects: Record<string, { revision: number; gitRemote: string }> } {
    return JSON.parse(this.content!);
  }
}

const entry = (name: string, over: Partial<ProjectEntryInput> = {}): ProjectEntryInput => ({
  name,
  gitRemote: `git@github.com:acme/${name}.git`,
  gitBranch: 'main',
  configSnapshot: 'version: 1\n',
  lastPush: '2026-07-10T00:00:00Z',
  machineId: 'm1',
  ...over,
});

function storeOn(s3: FakeS3): RegistryStore {
  return new RegistryStore(STORAGE, s3.install(new FakeRunner({ available: ['aws'] })));
}

describe('RegistryStore revision', () => {
  it('starts a new project at revision 1 and increments on each push', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    expect((await store.registerProject(entry('keeper'))).revision).toBe(1);
    expect((await store.registerProject(entry('keeper'))).revision).toBe(2);
    expect((await store.registerProject(entry('keeper'))).revision).toBe(3);
  });

  it('creates the registry object with if-none-match when it does not exist', async () => {
    const s3 = new FakeS3(); // no object yet
    const store = storeOn(s3);
    const created = await store.registerProject(entry('keeper'));
    expect(created.revision).toBe(1);
    expect(s3.parsed().projects.keeper!.revision).toBe(1);
  });

  it('defaults revision to 0 for entries written before the field existed', async () => {
    // A pre-0.19 registry: no `revision` key at all.
    const s3 = new FakeS3({
      version: 1,
      projects: {
        keeper: {
          name: 'keeper',
          gitRemote: 'git@github.com:acme/keeper.git',
          gitBranch: 'main',
          configSnapshot: 'version: 1\n',
          lastPush: '2026-01-01T00:00:00Z',
          machineId: 'old',
        },
      },
    });
    const store = storeOn(s3);
    expect((await store.getProject('keeper'))!.revision).toBe(0);
    expect((await store.registerProject(entry('keeper'))).revision).toBe(1);
  });
});

// SYNC_SAFETY.md R1 — the registry is one JSON object holding every project, so
// a plain read-modify-write drops whichever machine wrote first.
describe('RegistryStore compare-and-swap', () => {
  it('does not drop a concurrent push of a different project', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);

    // Machine B lands its write in the window between our read and our write.
    let raced = false;
    s3.onBeforePut = () => {
      if (raced) return;
      raced = true;
      const reg = JSON.parse(s3.content!);
      reg.projects.other = { ...entry('other'), revision: 1 };
      s3.write(JSON.stringify(reg));
    };

    const ours = await store.registerProject(entry('keeper'));
    expect(ours.revision).toBe(1);

    const after = s3.parsed().projects;
    expect(Object.keys(after).sort()).toEqual(['keeper', 'other']); // neither lost
    expect(after.other!.revision).toBe(1);
  });

  it('gives up after bounded retries rather than spinning forever', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    // Every attempt loses the race.
    s3.onBeforePut = () => s3.write(s3.content!);
    await expect(store.registerProject(entry('keeper'))).rejects.toThrow(/being written concurrently/);
  });

  it('re-reads the current revision when it loses a race on the same project', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    let raced = false;
    s3.onBeforePut = () => {
      if (raced) return;
      raced = true;
      const reg = JSON.parse(s3.content!);
      reg.projects.keeper = { ...entry('keeper'), revision: 7 };
      s3.write(JSON.stringify(reg));
    };
    // Not 1: the retry sees revision 7 and takes 8.
    expect((await store.registerProject(entry('keeper'))).revision).toBe(8);
  });
});

// SYNC_SAFETY.md R2 — an old machine must not overwrite a newer push's config
// snapshot and checkpoint.
describe('RegistryStore expectedRevision', () => {
  it('refuses to overwrite an entry that moved since this machine last saw it', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    await store.registerProject(entry('keeper')); // revision 1
    await store.registerProject(entry('keeper')); // revision 2

    // This machine's base is still revision 1.
    await expect(store.registerProject(entry('keeper'), { expectedRevision: 1 })).rejects.toThrow(SafetyError);
    await expect(store.registerProject(entry('keeper'), { expectedRevision: 1 })).rejects.toThrow(
      /at revision 2 .* last saw revision 1/,
    );
    expect(s3.parsed().projects.keeper!.revision).toBe(2); // untouched
  });

  it('proceeds when the remote is exactly where this machine left it', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    await store.registerProject(entry('keeper'));
    expect((await store.registerProject(entry('keeper'), { expectedRevision: 1 })).revision).toBe(2);
  });

  it('allows a first push of a project nobody has registered', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    expect((await store.registerProject(entry('keeper'), { expectedRevision: 0 })).revision).toBe(1);
  });

  it('still refuses a different git remote under the same name', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    await store.registerProject(entry('keeper'));
    await expect(
      store.registerProject(entry('keeper', { gitRemote: 'git@github.com:someone/else.git' })),
    ).rejects.toThrow(/different git remote/);
  });
});

describe('RegistryStore without conditional-write support', () => {
  it('falls back to an unconditional write and flags it', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    s3.conditionalWrites = false;
    const store = storeOn(s3);
    const written = await store.registerProject(entry('keeper'));
    expect(written.revision).toBe(1);
    expect(store.usedUnconditionalWrite).toBe(true);
    expect(s3.parsed().projects.keeper!.revision).toBe(1);
  });

  it('detects, after the fact, that a concurrent write clobbered ours', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    s3.conditionalWrites = false;
    const store = storeOn(s3);

    // Another machine overwrites the object right after our unconditional put,
    // before we read it back. Nothing can prevent this — only report it.
    let done = false;
    s3.onAfterPut = () => {
      if (done) return;
      done = true;
      s3.write(JSON.stringify({ version: 1, projects: {} }));
    };
    const err = await store.registerProject(entry('keeper')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvbeamError);
    expect((err as Error).message).toMatch(/overwritten by another machine/);
  });
});

// Verified against the real endpoint: Hetzner Object Storage (Ceph RGW) honors
// `If-None-Match: *` but refuses `If-Match` with 412 even when the ETag matches,
// and aws-cli 2.x turns its empty <Message/> into an opaque TypeError. Both
// failures therefore produce the SAME stderr, so classification must come from
// re-reading the object, not from the error text.
describe('RegistryStore on a Ceph RGW endpoint (Hetzner)', () => {
  it('creates the registry with if-none-match, which RGW does honor', async () => {
    const s3 = new FakeS3();
    s3.cephRgw = true;
    const store = storeOn(s3);
    expect((await store.registerProject(entry('keeper'))).revision).toBe(1);
    expect(store.conditionalWritesSupported).toBeUndefined(); // never tried if-match
  });

  it('recognizes a refused if-match as UNSUPPORTED, not as a lost race', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    s3.cephRgw = true;
    const store = storeOn(s3);
    // The ETag is unchanged, so the precondition held and the write was still
    // refused. Retrying would fail identically five times and then throw
    // "being written concurrently", which would be a lie.
    const written = await store.registerProject(entry('keeper'));
    expect(written.revision).toBe(1);
    expect(store.conditionalWritesSupported).toBe(false);
    expect(store.usedUnconditionalWrite).toBe(true);
    expect(s3.parsed().projects.keeper!.revision).toBe(1);
  });

  it('still distinguishes a genuine lost race by the changed ETag', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3); // supports if-match
    let raced = false;
    s3.onBeforePut = () => {
      if (raced) return;
      raced = true;
      const reg = JSON.parse(s3.content!);
      reg.projects.other = { ...entry('other'), revision: 1 };
      s3.write(JSON.stringify(reg)); // new ETag
    };
    await store.registerProject(entry('keeper'));
    expect(store.conditionalWritesSupported).toBe(true);
    expect(Object.keys(s3.parsed().projects).sort()).toEqual(['keeper', 'other']);
  });

  it('does not retry if-match once it knows the endpoint refuses it', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    s3.cephRgw = true;
    const store = storeOn(s3);
    await store.registerProject(entry('keeper'));
    const before = s3.puts;
    await store.registerProject(entry('keeper'));
    // Exactly one put on the second call: straight to the unconditional write.
    expect(s3.puts - before).toBe(1);
  });
});

/**
 * A checkpoint describes the state of the world at its revision, not merely what
 * one push uploaded. Per-domain divergence is a field-wise comparison against
 * it, so a push that carried no snapshot must not blank `snapshotName` — a
 * puller would read the gap as "the remote never moved the database".
 */
describe('checkpoint carries forward the domains a push did not touch', () => {
  const withCheckpoint = (over: Record<string, unknown>): ProjectEntryInput => ({
    ...entry('keeper'),
    checkpoint: {
      revision: 0,
      gitCommit: 'a'.repeat(40),
      gitBranch: 'main',
      machineId: 'm1',
      at: '2026-07-10T00:00:00Z',
      ...over,
    },
  });

  it('stamps the checkpoint with the revision the store actually assigned', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    await store.registerProject(withCheckpoint({ snapshotName: 'S1' }));
    const stored = await store.registerProject(withCheckpoint({ snapshotName: 'S2' }));
    expect(stored.revision).toBe(2);
    expect(stored.checkpoint?.revision).toBe(2);
    expect(s3.parsed().projects.keeper!.revision).toBe(2);
  });

  it('keeps whatever the caller carried forward', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    await store.registerProject(withCheckpoint({ snapshotName: 'S1', sessionName: 'Z1' }));

    // A later push with no new snapshot re-states S1 (as `push.ts` does).
    const next = await store.registerProject(withCheckpoint({ snapshotName: 'S1', sessionName: 'Z2' }));
    expect(next.checkpoint?.snapshotName).toBe('S1');
    expect(next.checkpoint?.sessionName).toBe('Z2');
  });

  it('leaves a domain absent when nothing has ever been pushed for it', async () => {
    const s3 = new FakeS3(EMPTY_REGISTRY);
    const store = storeOn(s3);
    const stored = await store.registerProject(withCheckpoint({}));
    expect(stored.checkpoint?.snapshotName).toBeUndefined();
    expect(stored.checkpoint?.secretsHash).toBeUndefined();
  });
});
