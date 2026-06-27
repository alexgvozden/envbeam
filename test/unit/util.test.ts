import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { RealCommandRunner, CommandError } from '../../src/core/util/exec.js';
import { Logger } from '../../src/core/util/logger.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import { findUp, ensureGitignored, expandHome, writeSecureFile, pathExists } from '../../src/core/util/fs.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('RealCommandRunner', () => {
  const runner = new RealCommandRunner();

  it('captures stdout and exit code', async () => {
    const res = await runner.run('node', ['-e', 'process.stdout.write("hi")']);
    expect(res.stdout).toBe('hi');
    expect(res.code).toBe(0);
  });

  it('throws CommandError on failure unless allowFailure', async () => {
    await expect(runner.run('node', ['-e', 'process.exit(3)'])).rejects.toBeInstanceOf(CommandError);
    const res = await runner.run('node', ['-e', 'process.exit(3)'], { allowFailure: true });
    expect(res.code).toBe(3);
  });

  it('passes input on stdin and env', async () => {
    const res = await runner.run('node', ['-e', 'process.stdin.on("data",d=>process.stdout.write(d))'], { input: 'piped' });
    expect(res.stdout).toBe('piped');
    const envRes = await runner.run('node', ['-e', 'process.stdout.write(process.env.FOO||"")'], { env: { FOO: 'bar' } });
    expect(envRes.stdout).toBe('bar');
  });

  it('which resolves real and missing commands', async () => {
    expect(await runner.which('node')).toBeTruthy();
    expect(await runner.which('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});

describe('Logger', () => {
  it('captures structured step output and respects level', () => {
    const lines: string[] = [];
    const log = new Logger({ level: 'info', write: (_s, t) => lines.push(t.replace(/\n$/, '')) });
    log.step('Git');
    log.sub('did a thing');
    log.success('ok');
    log.debug('hidden at info level');
    const joined = lines.join('\n');
    expect(joined).toMatch(/1\. Git/);
    expect(joined).toMatch(/did a thing/);
    expect(joined).not.toMatch(/hidden/);
  });

  it('quiet level suppresses info but not error', () => {
    const lines: string[] = [];
    const log = new Logger({ level: 'error', write: (_s, t) => lines.push(t) });
    log.info('nope');
    log.error('boom');
    expect(lines.join('')).toMatch(/boom/);
    expect(lines.join('')).not.toMatch(/nope/);
  });
});

describe('AutoPrompter', () => {
  it('returns declared defaults and scripted answers', async () => {
    const p = new AutoPrompter({ answers: [{ match: 'snapshot', value: true }] });
    expect(await p.confirm('Take a DB snapshot?')).toBe(true);
    expect(await p.confirm('Something else', false)).toBe(false);
    expect(await p.input('Name', 'default-name')).toBe('default-name');
    expect(await p.select('Pick', [{ name: 'a', value: 'a' }, { name: 'b', value: 'b' }], 'b')).toBe('b');
  });

  it('defaults:true confirms everything', async () => {
    const p = new AutoPrompter({ defaults: true });
    expect(await p.confirm('anything')).toBe(true);
  });
});

describe('fs helpers', () => {
  it('findUp walks to the marker', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, { '.envbeam.yaml': 'x', 'a/b/c/file.txt': 'y' });
    expect(await findUp('.envbeam.yaml', path.join(dir, 'a/b/c'))).toBe(dir);
    expect(await findUp('nonexistent-marker', path.join(dir, 'a/b/c'))).toBeNull();
  });

  it('ensureGitignored is idempotent', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await ensureGitignored(dir, '.env');
    await ensureGitignored(dir, '.env');
    await ensureGitignored(dir, '.envbeam/');
    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi.match(/^\.env$/gm)?.length).toBe(1);
    expect(gi).toContain('.envbeam/');
  });

  it('expandHome and writeSecureFile (0600)', async () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(expandHome('/abs')).toBe('/abs');
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const f = path.join(dir, 'sub', 'secret.json');
    await writeSecureFile(f, '{}');
    expect(await pathExists(f)).toBe(true);
    expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
  });
});
