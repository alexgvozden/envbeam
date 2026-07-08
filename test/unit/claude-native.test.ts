import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import {
  ClaudeNativeProvider,
  claudeProjectDirName,
  parseSessionFileName,
} from '../../src/core/providers/session/claudeNative.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
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
