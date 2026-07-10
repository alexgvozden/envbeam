import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { compareContents, mergeSessionTree, summarizeMerge } from '../../src/core/providers/session/merge.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('compareContents', () => {
  it('classifies the append-only cases', () => {
    expect(compareContents(buf('abc'), buf('abc'))).toBe('same');
    expect(compareContents(buf('abc'), buf('abcdef'))).toBe('remote-extends');
    expect(compareContents(buf('abcdef'), buf('abc'))).toBe('local-extends');
  });

  it('calls an in-place rewrite diverged rather than assuming append-only', () => {
    // Same length, different bytes: a compaction or redaction, not an append.
    expect(compareContents(buf('abcdef'), buf('abcXef'))).toBe('diverged');
    // Longer, but the shared prefix does not match.
    expect(compareContents(buf('abc'), buf('abXdef'))).toBe('diverged');
  });

  it('treats an empty local file as extendable', () => {
    expect(compareContents(buf(''), buf('abc'))).toBe('remote-extends');
  });
});

/** Build a source tree and a destination tree, then merge src → dest. */
async function scene(src: Record<string, string>, dest: Record<string, string>) {
  const { dir, cleanup } = await tmpDir('merge-');
  cleanups.push(cleanup);
  const srcDir = path.join(dir, 'src');
  const destDir = path.join(dir, 'dest');
  await writeFiles(srcDir, src);
  await writeFiles(destDir, dest);
  return { dir, srcDir, destDir };
}

const read = (f: string) => fs.readFile(f, 'utf8');
const exists = (f: string) => fs.access(f).then(() => true, () => false);

// SYNC_SAFETY.md T3 — per-file merge, never a whole-tree copy that truncates.
describe('mergeSessionTree: transcripts', () => {
  it('copies a session this machine has never seen', async () => {
    const { srcDir, destDir } = await scene({ 'a.jsonl': '{"i":1}\n' }, {});
    const r = await mergeSessionTree(srcDir, destDir, 'other');
    expect(r.actions).toEqual([{ path: 'a.jsonl', action: 'copied' }]);
    expect(await read(path.join(destDir, 'a.jsonl'))).toBe('{"i":1}\n');
  });

  it('fast-forwards when the remote transcript extends ours', async () => {
    const { srcDir, destDir } = await scene({ 'a.jsonl': '{"i":1}\n{"i":2}\n' }, { 'a.jsonl': '{"i":1}\n' });
    const r = await mergeSessionTree(srcDir, destDir, 'other');
    expect(r.actions).toEqual([{ path: 'a.jsonl', action: 'fast-forwarded' }]);
    expect(await read(path.join(destDir, 'a.jsonl'))).toBe('{"i":1}\n{"i":2}\n');
  });

  it('never truncates: an older remote transcript leaves ours alone', async () => {
    // This is the whole point. The old copyFile would have shortened a.jsonl.
    const { srcDir, destDir } = await scene({ 'a.jsonl': '{"i":1}\n' }, { 'a.jsonl': '{"i":1}\n{"i":2}\n' });
    const r = await mergeSessionTree(srcDir, destDir, 'other');
    expect(r.actions).toEqual([{ path: 'a.jsonl', action: 'local-ahead' }]);
    expect(await read(path.join(destDir, 'a.jsonl'))).toBe('{"i":1}\n{"i":2}\n');
  });

  it('reports identical transcripts as up-to-date', async () => {
    const { srcDir, destDir } = await scene({ 'a.jsonl': 'x\n' }, { 'a.jsonl': 'x\n' });
    const r = await mergeSessionTree(srcDir, destDir, 'other');
    expect(r.actions).toEqual([{ path: 'a.jsonl', action: 'up-to-date' }]);
  });

  it('parks a genuinely diverged transcript beside ours, keeping both', async () => {
    const { srcDir, destDir } = await scene({ 'a.jsonl': 'x\nREMOTE\n' }, { 'a.jsonl': 'x\nLOCAL\n' });
    const r = await mergeSessionTree(srcDir, destDir, 'laptop');
    expect(r.actions).toEqual([{ path: 'a.jsonl', action: 'diverged' }]);
    expect(r.sidecars).toEqual(['a.remote-laptop.jsonl']);
    expect(await read(path.join(destDir, 'a.jsonl'))).toBe('x\nLOCAL\n');
    expect(await read(path.join(destDir, 'a.remote-laptop.jsonl'))).toBe('x\nREMOTE\n');
  });

  it('unions disjoint sessions from two machines', async () => {
    const { srcDir, destDir } = await scene({ 'remote.jsonl': 'r\n' }, { 'local.jsonl': 'l\n' });
    await mergeSessionTree(srcDir, destDir, 'other');
    expect(await read(path.join(destDir, 'local.jsonl'))).toBe('l\n');
    expect(await read(path.join(destDir, 'remote.jsonl'))).toBe('r\n');
  });
});

describe('mergeSessionTree: sidecars follow their parent', () => {
  it('brings sidecars over when the transcript fast-forwards', async () => {
    const { srcDir, destDir } = await scene(
      { 'a.jsonl': 'x\ny\n', 'a/subagents/s1.jsonl': 'sub\n' },
      { 'a.jsonl': 'x\n' },
    );
    await mergeSessionTree(srcDir, destDir, 'other');
    expect(await read(path.join(destDir, 'a', 'subagents', 's1.jsonl'))).toBe('sub\n');
  });

  it('leaves sidecars alone when we are ahead of the remote transcript', async () => {
    const { srcDir, destDir } = await scene(
      { 'a.jsonl': 'x\n', 'a/subagents/s1.jsonl': 'stale\n' },
      { 'a.jsonl': 'x\ny\n', 'a/subagents/s1.jsonl': 'fresh\n' },
    );
    await mergeSessionTree(srcDir, destDir, 'other');
    expect(await read(path.join(destDir, 'a', 'subagents', 's1.jsonl'))).toBe('fresh\n');
  });

  it('parks the diverged run’s sidecars beside ours, not mixed into it', async () => {
    const { srcDir, destDir } = await scene(
      { 'a.jsonl': 'x\nREMOTE\n', 'a/subagents/s1.jsonl': 'their-sub\n' },
      { 'a.jsonl': 'x\nLOCAL\n', 'a/subagents/s1.jsonl': 'our-sub\n' },
    );
    await mergeSessionTree(srcDir, destDir, 'laptop');
    expect(await read(path.join(destDir, 'a', 'subagents', 's1.jsonl'))).toBe('our-sub\n');
    expect(await read(path.join(destDir, 'a.remote-laptop', 'subagents', 's1.jsonl'))).toBe('their-sub\n');
  });
});

// SYNC_SAFETY.md T6 — memory/ is shared, mutable, and rewritten in place. There
// is no natural merge; the rule is last-writer-wins, and it must never eat bytes.
describe('mergeSessionTree: memory/ is mutable shared state', () => {
  async function withMtimes(
    src: Record<string, string>,
    dest: Record<string, string>,
    srcMtime: Date,
    destMtime: Date,
  ) {
    const s = await scene(src, dest);
    for (const f of Object.keys(src)) await fs.utimes(path.join(s.srcDir, f), srcMtime, srcMtime);
    for (const f of Object.keys(dest)) await fs.utimes(path.join(s.destDir, f), destMtime, destMtime);
    return s;
  }

  it('a newer remote memory file wins, and our copy is saved beside it', async () => {
    const { destDir, srcDir } = await withMtimes(
      { 'memory/MEMORY.md': 'theirs\n' },
      { 'memory/MEMORY.md': 'ours\n' },
      new Date('2026-07-11T00:00:00Z'),
      new Date('2026-07-10T00:00:00Z'),
    );
    const r = await mergeSessionTree(srcDir, destDir, 'laptop');
    expect(r.actions).toContainEqual({ path: path.join('memory', 'MEMORY.md'), action: 'replaced' });
    expect(await read(path.join(destDir, 'memory', 'MEMORY.md'))).toBe('theirs\n');
    expect(await read(path.join(destDir, 'memory', 'MEMORY.local-backup.md'))).toBe('ours\n');
  });

  it('an older remote memory file does not win, and is written beside ours', async () => {
    const { destDir, srcDir } = await withMtimes(
      { 'memory/MEMORY.md': 'theirs\n' },
      { 'memory/MEMORY.md': 'ours\n' },
      new Date('2026-07-10T00:00:00Z'),
      new Date('2026-07-11T00:00:00Z'),
    );
    const r = await mergeSessionTree(srcDir, destDir, 'laptop');
    expect(r.actions).toContainEqual({ path: path.join('memory', 'MEMORY.md'), action: 'diverged' });
    expect(await read(path.join(destDir, 'memory', 'MEMORY.md'))).toBe('ours\n');
    expect(await read(path.join(destDir, 'memory', 'MEMORY.remote-laptop.md'))).toBe('theirs\n');
  });

  it('identical memory files are left alone entirely', async () => {
    const { destDir, srcDir } = await scene({ 'memory/a.md': 'same\n' }, { 'memory/a.md': 'same\n' });
    const r = await mergeSessionTree(srcDir, destDir, 'laptop');
    expect(r.sidecars).toEqual([]);
    expect(await exists(path.join(destDir, 'memory', 'a.remote-laptop.md'))).toBe(false);
  });
});

describe('mergeSessionTree: security rules survive the rewrite', () => {
  it('never writes a file that would inject hooks, MCP servers, or settings', async () => {
    const { srcDir, destDir } = await scene(
      {
        'settings.json': '{"hooks":{}}',
        'settings.local.json': '{}',
        'a.mcp.json': '{}',
        'memory/settings.json': '{}',
      },
      {},
    );
    const r = await mergeSessionTree(srcDir, destDir, 'evil');
    expect(await exists(path.join(destDir, 'settings.json'))).toBe(false);
    expect(await exists(path.join(destDir, 'settings.local.json'))).toBe(false);
    expect(await exists(path.join(destDir, 'a.mcp.json'))).toBe(false);
    expect(await exists(path.join(destDir, 'memory', 'settings.json'))).toBe(false);
    expect(r.actions.filter((a) => a.action === 'skipped-sensitive')).toHaveLength(4);
  });

  it('skips symlinks rather than following them out of the tree', async () => {
    const { srcDir, destDir } = await scene({ 'a.jsonl': 'x\n' }, {});
    await fs.symlink('/etc/passwd', path.join(srcDir, 'evil.jsonl'));
    await fs.symlink('/etc', path.join(srcDir, 'evildir'));
    const r = await mergeSessionTree(srcDir, destDir, 'evil');
    expect(await exists(path.join(destDir, 'evil.jsonl'))).toBe(false);
    expect(await exists(path.join(destDir, 'evildir'))).toBe(false);
    expect(r.actions.filter((a) => a.action === 'skipped-symlink').length).toBeGreaterThan(0);
  });
});

describe('summarizeMerge', () => {
  it('tallies actions across archives', async () => {
    const { srcDir, destDir } = await scene({ 'a.jsonl': 'x\ny\n', 'b.jsonl': 'n\n' }, { 'a.jsonl': 'x\n' });
    const r = await mergeSessionTree(srcDir, destDir, 'other');
    expect(summarizeMerge([r])).toBe('1 copied, 1 fast-forwarded');
  });

  it('says so when there was nothing to do', () => {
    expect(summarizeMerge([])).toBe('nothing to merge');
  });
});
