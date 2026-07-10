import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  ClaudeNativeProvider,
  claudeProjectDirName,
  parseSessionFileName,
  sessionTimestampMs,
} from '../../src/core/providers/session/claudeNative.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ENVBEAM_MACHINE;
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_AGE_PRIVATE_KEY;
  while (cleanups.length) await cleanups.pop()!();
});

describe('claudeProjectDirName', () => {
  it('keeps the leading dash and replaces every non-alphanumeric char', () => {
    expect(claudeProjectDirName('/Users/me/Code/synthlab')).toBe('-Users-me-Code-synthlab');
    expect(claudeProjectDirName('/Users/me/my_app.v2')).toBe('-Users-me-my-app-v2');
  });
});

describe('parseSessionFileName', () => {
  it('handles dashes in workspace and machine names', () => {
    const parsed = parseSessionFileName(
      'claude-session-synthetic-signals-project-aleksandars-mac-book-analog-local-2026-07-08T10-14-27.tar.gz',
    );
    expect(parsed).toEqual({
      workspace: 'synthetic-signals',
      scope: 'project',
      machine: 'aleksandars-mac-book-analog-local',
      timestamp: '2026-07-08T10-14-27',
    });
  });

  it('rejects unrelated names', () => {
    expect(parseSessionFileName('claude-session-x.meta.json')).toBeNull();
  });
});

describe('claude-native session discovery', () => {
  it('finds project sessions in the CLAUDE_CONFIG_DIR (e.g. ~/.claude-personal alias)', async () => {
    const { dir: ws, cleanup: c1 } = await tmpDir();
    const { dir: cfg, cleanup: c2 } = await tmpDir('claude-personal-');
    cleanups.push(c1, c2);
    const projectDir = path.join('projects', claudeProjectDirName(ws));
    await writeFiles(cfg, { [path.join(projectDir, 'abc.jsonl')]: '{"role":"user"}\n' });
    process.env.CLAUDE_CONFIG_DIR = cfg;

    const provider = new ClaudeNativeProvider();
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'w', session: { provider: 'claude-native', scope: 'project' } },
      runner: new FakeRunner(),
      workspaceRoot: ws,
    }).providerCtx('session');

    // No sync target configured → push stops AFTER locating the data,
    // proving discovery found the sessions in the aliased config dir.
    const res = await provider.push(ctx);
    expect(res.detail).toMatch(/no sync target configured/);

    const status = await provider.status(ctx);
    expect(status.detail).toContain(path.join(cfg, projectDir));
  });

  it('tars the dash-prefixed project dir safely (-- ends option parsing)', async () => {
    const { dir: ws, cleanup: c1 } = await tmpDir();
    const { dir: cfg, cleanup: c2 } = await tmpDir('claude-cfg-');
    const { dir: sync, cleanup: c3 } = await tmpDir('sync-');
    cleanups.push(c1, c2, c3);
    const sanitized = claudeProjectDirName(ws); // starts with '-'
    await writeFiles(cfg, { [path.join('projects', sanitized, 'abc.jsonl')]: '{}\n' });
    process.env.CLAUDE_CONFIG_DIR = cfg;

    const runner = new FakeRunner({ available: ['tar'] });
    runner.on('tar', {});
    const provider = new ClaudeNativeProvider();
    const ctx = makeTestContext({
      config: {
        version: 1,
        workspace: 'synthetic-signals',
        session: { provider: 'claude-native', scope: 'project', sync: { target: 'local-folder', path: sync } },
      },
      runner,
      workspaceRoot: ws,
    }).providerCtx('session');

    await provider.push(ctx); // stops later at encryption keys — tar already ran
    const tarCall = runner.calls.find((c) => c.command === 'tar')!;
    expect(tarCall).toBeTruthy();
    const dashIdx = tarCall.args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    expect(tarCall.args[dashIdx + 1]).toBe(sanitized); // '-Users-…' comes AFTER --
  });

  it('reports every searched location when no data exists', async () => {
    const { dir: ws, cleanup: c1 } = await tmpDir();
    const { dir: cfg, cleanup: c2 } = await tmpDir('claude-empty-');
    cleanups.push(c1, c2);
    process.env.CLAUDE_CONFIG_DIR = cfg;

    const provider = new ClaudeNativeProvider();
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'w', session: { provider: 'claude-native', scope: 'project' } },
      runner: new FakeRunner(),
      workspaceRoot: ws,
    }).providerCtx('session');

    const res = await provider.push(ctx);
    expect(res.action).toBe('noop');
    expect(res.detail).toContain('no Claude project data found');
    expect(res.detail).toContain(cfg);
  });
});

describe('sessionTimestampMs', () => {
  it('parses the archive timestamp as UTC', () => {
    expect(sessionTimestampMs('2026-07-10T12-30-00')).toBe(Date.parse('2026-07-10T12:30:00Z'));
  });

  it('returns 0 for anything it cannot parse (caller treats it as unknown)', () => {
    expect(sessionTimestampMs('latest')).toBe(0);
    expect(sessionTimestampMs('')).toBe(0);
  });
});

/**
 * A workspace + Claude config dir + sync folder, with a fake `age` (copy) and a
 * fake `tar` that materializes a per-machine tree, so `pull` runs end to end.
 */
async function sessionScene(opts: {
  /** machine → its latest archive: timestamp and the tree that archive contains. */
  archives: Record<string, { timestamp: string; tree?: Record<string, string> }>;
  /** Additional (older) archives on the target, which must be ignored. */
  extraArchives?: Array<{ machine: string; timestamp: string }>;
  /** Local files under the destination tree. */
  local?: Record<string, string>;
  localMtime?: Date;
  machine: string;
  scope?: 'project' | 'global';
  force?: boolean;
}) {
  const { dir: ws, cleanup: c1 } = await tmpDir();
  const { dir: cfg, cleanup: c2 } = await tmpDir('claude-cfg-');
  const { dir: sync, cleanup: c3 } = await tmpDir('sync-');
  const { dir: home, cleanup: c4 } = await tmpDir('envbeam-home-');
  cleanups.push(c1, c2, c3, c4);
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.ENVBEAM_MACHINE = opts.machine;
  process.env.ENVBEAM_HOME = home;
  process.env.ENVBEAM_AGE_PRIVATE_KEY = 'AGE-SECRET-KEY-1FAKE';
  const scope = opts.scope ?? 'project';

  const destDir = scope === 'global' ? cfg : path.join(cfg, 'projects', claudeProjectDirName(ws));
  for (const [rel, content] of Object.entries(opts.local ?? {})) {
    const full = path.join(destDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    if (opts.localMtime) await fs.utimes(full, opts.localMtime, opts.localMtime);
  }

  // Ciphertext carries the archive key so the fake tar knows which tree to emit.
  const trees: Record<string, Record<string, string>> = {};
  for (const [machine, { timestamp, tree }] of Object.entries(opts.archives)) {
    const key = `${machine}@${timestamp}`;
    await fs.writeFile(path.join(sync, `claude-session-w-${scope}-${machine}-${timestamp}.tar.gz.age`), `ct:${key}`);
    trees[key] = tree ?? { [`${machine}.jsonl`]: `from-${machine}\n` };
  }
  for (const { machine, timestamp } of opts.extraArchives ?? []) {
    const key = `${machine}@${timestamp}`;
    await fs.writeFile(path.join(sync, `claude-session-w-${scope}-${machine}-${timestamp}.tar.gz.age`), `ct:${key}`);
    trees[key] = { 'STALE.jsonl': 'must-not-appear\n' };
  }

  const runner = new FakeRunner({ available: ['tar', 'age', 'doppler'] });
  runner.on((_c, a) => a[0] === '--version', { stdout: 'v1' });
  // No integrity manifest → verifyArtifact returns 'missing' (warns, proceeds).
  runner.on('doppler', { code: 1, stderr: 'not found' });
  // Fake `age -d -o out in`: copy input to output.
  runner.on('age', (_c, a) => {
    const o = a.indexOf('-o');
    if (o < 0) return { stdout: 'age 1.0' };
    copyFileSync(a[a.length - 1]!, a[o + 1]!);
    return {};
  });
  // Fake `tar -xzf <archive> --no-same-owner -C <extractDir>`: write that
  // archive's tree under a single top-level dir, as a real archive would.
  runner.on('tar', (_c, a) => {
    const f = a.indexOf('-xzf');
    if (f < 0) return {};
    const key = readFileSync(a[f + 1]!, 'utf8').replace('ct:', '');
    const root = path.join(a[a.indexOf('-C') + 1]!, 'tree');
    for (const [rel, content] of Object.entries(trees[key] ?? {})) {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return {};
  });

  const lines: string[] = [];
  const ctx = makeTestContext({
    config: {
      version: 1,
      workspace: 'w',
      session: { provider: 'claude-native', scope, sync: { target: 'local-folder', path: sync } },
    },
    runner,
    workspaceRoot: ws,
    force: opts.force,
    logLines: lines,
  });
  return { provider: new ClaudeNativeProvider(), ctx: ctx.providerCtx('session'), lines, destDir };
}

const readFile = (f: string) => fs.readFile(f, 'utf8');
const fileExists = (f: string) => fs.access(f).then(() => true, () => false);

// SYNC_SAFETY.md §7 — `global` scope is the whole Claude config dir, where union
// semantics are meaningless, so it keeps the coarse newest-wins rule.
describe('claude-native session pull, global scope (T1/T2)', () => {
  it('T1: chooses the newest archive, not merely one from another machine', async () => {
    const { provider, ctx } = await sessionScene({
      scope: 'global',
      archives: {
        thisbox: { timestamp: '2026-07-10T12-00-00' },
        otherbox: { timestamp: '2026-07-09T12-00-00' },
      },
      local: { 'abc.jsonl': 'local\n' },
      localMtime: new Date('2026-07-11T00:00:00Z'),
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx);
    // The freshness guard names whichever archive was chosen. The old heuristic
    // preferred `otherbox`'s knowingly older one.
    expect(res.detail).toContain('2026-07-10T12-00-00');
    expect(res.detail).toContain('thisbox');
    expect(res.detail).not.toContain('otherbox');
  });

  it('T2: refuses an archive older than local activity', async () => {
    const { provider, ctx } = await sessionScene({
      scope: 'global',
      archives: { otherbox: { timestamp: '2026-07-09T12-00-00' } },
      local: { 'abc.jsonl': 'local\n' },
      localMtime: new Date('2026-07-10T00:00:00Z'),
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx);
    expect(res.action).toBe('noop');
    expect(res.detail).toMatch(/not restoring/);
    expect(res.detail).toMatch(/--force/);
  });

  it('T2: --force overwrites newer local data, and says so', async () => {
    const { provider, ctx, lines } = await sessionScene({
      scope: 'global',
      archives: { otherbox: { timestamp: '2026-07-09T12-00-00' } },
      local: { 'abc.jsonl': 'local\n' },
      localMtime: new Date('2026-07-10T00:00:00Z'),
      machine: 'thisbox',
      force: true,
    });
    const res = await provider.pull(ctx);
    expect(lines.join('\n')).toMatch(/--force: overwriting global Claude data/);
    expect(res.action).toBe('pulled');
  });
});

// SYNC_SAFETY.md T3/T5 — project scope merges per file, and takes the union of
// the latest archive per machine so session sync actually converges.
describe('claude-native session pull, project scope (T3/T5)', () => {
  it('restores when there are no local sessions at all', async () => {
    const { provider, ctx, destDir } = await sessionScene({
      archives: { otherbox: { timestamp: '2026-07-09T12-00-00' } },
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx);
    expect(res.action).toBe('pulled');
    expect(await readFile(path.join(destDir, 'otherbox.jsonl'))).toBe('from-otherbox\n');
  });

  it('T5: merges the latest archive from EVERY machine, not just the newest one', async () => {
    const { provider, ctx, destDir, lines } = await sessionScene({
      archives: {
        // laptop's archive is older, but it holds a session nobody else has.
        laptop: { timestamp: '2026-07-08T09-00-00', tree: { 'laptop-session.jsonl': 'L\n' } },
        desktop: { timestamp: '2026-07-10T12-00-00', tree: { 'desktop-session.jsonl': 'D\n' } },
      },
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx);
    expect(res.action).toBe('pulled');
    expect(lines.join('\n')).toMatch(/merging 2 archives \(latest per machine: desktop, laptop\)/);
    // Restoring only the newest archive silently drops laptop's session.
    expect(await readFile(path.join(destDir, 'laptop-session.jsonl'))).toBe('L\n');
    expect(await readFile(path.join(destDir, 'desktop-session.jsonl'))).toBe('D\n');
  });

  it('T5: ignores a machine’s older archives, taking only its latest', async () => {
    const { provider, ctx, destDir, lines } = await sessionScene({
      archives: { desktop: { timestamp: '2026-07-10T12-00-00', tree: { 'd.jsonl': 'new\n' } } },
      extraArchives: [{ machine: 'desktop', timestamp: '2026-07-01T00-00-00' }],
      machine: 'thisbox',
    });
    await provider.pull(ctx);
    expect(lines.join('\n')).not.toMatch(/merging 2 archives/);
    expect(await fileExists(path.join(destDir, 'STALE.jsonl'))).toBe(false);
  });

  it('T3: an older remote transcript does not truncate a longer local one', async () => {
    const { provider, ctx, destDir } = await sessionScene({
      archives: { desktop: { timestamp: '2026-07-10T12-00-00', tree: { 'a.jsonl': 'line1\n' } } },
      local: { 'a.jsonl': 'line1\nline2\n' },
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx);
    expect(res.action).toBe('pulled');
    expect(res.detail).toMatch(/1 local-ahead/);
    expect(await readFile(path.join(destDir, 'a.jsonl'))).toBe('line1\nline2\n');
  });

  it('T3: a remote transcript that extends ours fast-forwards it', async () => {
    const { provider, ctx, destDir } = await sessionScene({
      archives: { desktop: { timestamp: '2026-07-10T12-00-00', tree: { 'a.jsonl': 'line1\nline2\n' } } },
      local: { 'a.jsonl': 'line1\n' },
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx);
    expect(res.detail).toMatch(/1 fast-forwarded/);
    expect(await readFile(path.join(destDir, 'a.jsonl'))).toBe('line1\nline2\n');
  });

  it('T3: a diverged transcript is parked beside ours and reported', async () => {
    const { provider, ctx, destDir, lines } = await sessionScene({
      archives: { desktop: { timestamp: '2026-07-10T12-00-00', tree: { 'a.jsonl': 'x\nTHEIRS\n' } } },
      local: { 'a.jsonl': 'x\nOURS\n' },
      machine: 'thisbox',
    });
    await provider.pull(ctx);
    expect(await readFile(path.join(destDir, 'a.jsonl'))).toBe('x\nOURS\n');
    expect(await readFile(path.join(destDir, 'a.remote-desktop.jsonl'))).toBe('x\nTHEIRS\n');
    expect(lines.join('\n')).toMatch(/session file\(s\) diverged/);
  });
});
