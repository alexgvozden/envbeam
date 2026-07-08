import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256File, recordArtifactHash, verifyArtifact, readManifest } from '../../src/core/sync/integrity.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { tmpDir } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A FakeRunner backed by an in-memory Doppler manifest secret. */
function dopplerRunner(store: { value?: string }) {
  const runner = new FakeRunner({ available: ['doppler'] });
  runner.on('doppler secrets get', () =>
    store.value == null ? { code: 1, stderr: 'not found' } : { stdout: store.value },
  );
  runner.on('doppler secrets set', (_c, args) => {
    // args: secrets set ENVBEAM_HASHES_X={json} --project … --config …
    const kv = args[2] ?? '';
    store.value = kv.slice(kv.indexOf('=') + 1);
    return {};
  });
  return runner;
}

async function fileWith(content: string): Promise<{ p: string; hash: string }> {
  const { dir, cleanup } = await tmpDir();
  cleanups.push(cleanup);
  const p = path.join(dir, 'artifact.bin');
  await fs.writeFile(p, content);
  return { p, hash: await sha256File(p) };
}

describe('integrity manifest (Doppler-anchored hashes)', () => {
  it('sha256File is stable and content-sensitive', async () => {
    const a = await fileWith('hello');
    const b = await fileWith('hello');
    const c = await fileWith('hello!');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a hash and verifies OK on a matching file', async () => {
    const store: { value?: string } = {};
    const runner = dopplerRunner(store);
    const { p, hash } = await fileWith('snapshot-bytes');
    expect(await recordArtifactHash(runner, 'synthetic-signals', 'snap.dump.age', hash)).toBe(true);
    expect(await readManifest(runner, 'synthetic-signals')).toEqual({ 'snap.dump.age': hash });
    expect(await verifyArtifact(runner, 'synthetic-signals', 'snap.dump.age', p)).toBe('ok');
  });

  it('detects tampering as a mismatch', async () => {
    const store: { value?: string } = {};
    const runner = dopplerRunner(store);
    const orig = await fileWith('original');
    await recordArtifactHash(runner, 'w', 'a.age', orig.hash);
    const tampered = await fileWith('TAMPERED'); // same name, different bytes
    expect(await verifyArtifact(runner, 'w', 'a.age', tampered.p)).toBe('mismatch');
  });

  it('reports missing when no hash was recorded', async () => {
    const runner = dopplerRunner({});
    const { p } = await fileWith('x');
    expect(await verifyArtifact(runner, 'w', 'never-recorded.age', p)).toBe('missing');
  });

  it('prunes manifest entries no longer on the sync target', async () => {
    const store: { value?: string } = {};
    const runner = dopplerRunner(store);
    await recordArtifactHash(runner, 'w', 'old.age', 'aaa');
    await recordArtifactHash(runner, 'w', 'new.age', 'bbb', new Set(['new.age'])); // old.age not live
    expect(await readManifest(runner, 'w')).toEqual({ 'new.age': 'bbb' });
  });

  it('returns false (and does not throw) when Doppler is unavailable', async () => {
    const runner = new FakeRunner(); // doppler not on PATH, default set fails? -> code 0 empty
    runner.on('doppler secrets set', { code: 1, stderr: 'unauthorized' });
    expect(await recordArtifactHash(runner, 'w', 'a.age', 'h')).toBe(false);
  });
});
