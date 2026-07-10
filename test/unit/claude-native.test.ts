import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
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

// SYNC_SAFETY.md §7 — the pull side must never restore an archive that is
// older than the transcripts already on disk.
describe('claude-native session pull freshness (T1/T2)', () => {
  /** A workspace + Claude config dir + sync folder, wired together. */
  async function scene(opts: {
    /** Archive file names to place on the sync target. */
    archives: string[];
    /** mtime for the local transcript, or null to leave the project dir absent. */
    localMtime: Date | null;
    machine: string;
    force?: boolean;
  }): Promise<{ provider: ClaudeNativeProvider; ctx: ReturnType<typeof makeTestContext>; lines: string[] }> {
    const { dir: ws, cleanup: c1 } = await tmpDir();
    const { dir: cfg, cleanup: c2 } = await tmpDir('claude-cfg-');
    const { dir: sync, cleanup: c3 } = await tmpDir('sync-');
    cleanups.push(c1, c2, c3);
    process.env.CLAUDE_CONFIG_DIR = cfg;
    process.env.ENVBEAM_MACHINE = opts.machine;

    if (opts.localMtime) {
      const transcript = path.join(cfg, 'projects', claudeProjectDirName(ws), 'abc.jsonl');
      await writeFiles(cfg, { [path.relative(cfg, transcript)]: '{"role":"user"}\n' });
      await fs.utimes(transcript, opts.localMtime, opts.localMtime);
    }
    for (const name of opts.archives) await fs.writeFile(path.join(sync, name), 'ciphertext');

    const lines: string[] = [];
    const ctx = makeTestContext({
      config: {
        version: 1,
        workspace: 'w',
        session: { provider: 'claude-native', scope: 'project', sync: { target: 'local-folder', path: sync } },
      },
      runner: new FakeRunner({ available: ['tar', 'age'] }),
      workspaceRoot: ws,
      force: opts.force,
      logLines: lines,
    });
    return { provider: new ClaudeNativeProvider(), ctx, lines };
  }

  const archive = (machine: string, ts: string) => `claude-session-w-project-${machine}-${ts}.tar.gz.age`;

  it('T1: chooses the newest archive, not merely one from another machine', async () => {
    // Ours is the newest. The old heuristic preferred `otherbox`'s stale one and
    // copied it over the local tree.
    const { provider, ctx } = await scene({
      archives: [archive('thisbox', '2026-07-10T12-00-00'), archive('otherbox', '2026-07-09T12-00-00')],
      localMtime: new Date('2026-07-11T00:00:00Z'),
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx.providerCtx('session'));
    // The freshness guard names whichever archive was chosen.
    expect(res.detail).toContain('2026-07-10T12-00-00');
    expect(res.detail).toContain('thisbox');
    expect(res.detail).not.toContain('otherbox');
  });

  it('T2: refuses to restore an archive older than the local transcripts', async () => {
    const { provider, ctx } = await scene({
      archives: [archive('otherbox', '2026-07-09T12-00-00')],
      localMtime: new Date('2026-07-10T00:00:00Z'),
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx.providerCtx('session'));
    expect(res.action).toBe('noop');
    expect(res.detail).toMatch(/not restoring/);
    expect(res.detail).toMatch(/--force/);
  });

  it('T2: --force overwrites newer local transcripts, and says so', async () => {
    const { provider, ctx, lines } = await scene({
      archives: [archive('otherbox', '2026-07-09T12-00-00')],
      localMtime: new Date('2026-07-10T00:00:00Z'),
      machine: 'thisbox',
      force: true,
    });
    const res = await provider.pull(ctx.providerCtx('session'));
    expect(lines.join('\n')).toMatch(/--force: overwriting Claude sessions/);
    // Proceeds past the guard (and then stops for want of encryption keys).
    expect(res.detail).not.toMatch(/not restoring/);
  });

  it('restores normally when the archive is newer than local activity', async () => {
    const { provider, ctx } = await scene({
      archives: [archive('otherbox', '2026-07-12T12-00-00')],
      localMtime: new Date('2026-07-10T00:00:00Z'),
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx.providerCtx('session'));
    expect(res.detail).not.toMatch(/not restoring/);
  });

  it('restores when there are no local sessions at all', async () => {
    const { provider, ctx } = await scene({
      archives: [archive('otherbox', '2026-07-09T12-00-00')],
      localMtime: null,
      machine: 'thisbox',
    });
    const res = await provider.pull(ctx.providerCtx('session'));
    expect(res.detail).not.toMatch(/not restoring/);
  });
});
