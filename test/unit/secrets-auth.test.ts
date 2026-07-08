import { describe, it, expect } from 'vitest';
import { checkSecretsAuth } from '../../src/core/providers/secretsAuth.js';
import { Logger } from '../../src/core/util/logger.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import { FakeRunner } from '../helpers/fakeRunner.js';

function deps(runner: FakeRunner) {
  return {
    runner,
    logger: new Logger({ level: 'error' }),
    prompter: new AutoPrompter({ defaults: true }),
    workspaceRoot: '/tmp/ws',
  };
}

describe('checkSecretsAuth', () => {
  it('reports missing CLI when the tool is not on PATH', async () => {
    const runner = new FakeRunner(); // doppler not available
    const res = await checkSecretsAuth('doppler', deps(runner));
    expect(res).toMatchObject({ tool: 'doppler', installed: false, authenticated: false });
    expect(res?.installHint).toMatch(/doppler/i);
  });

  it('flags an installed-but-unauthenticated Doppler CLI', async () => {
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler me', { code: 1, stderr: 'you must provide a token' });
    const res = await checkSecretsAuth('doppler', deps(runner));
    expect(res).toMatchObject({ tool: 'doppler', installed: true, authenticated: false });
    expect(res?.detail).toMatch(/not logged in/i);
  });

  it('passes when Doppler is authenticated', async () => {
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler me', { code: 0, stdout: '{"name":"me"}' });
    const res = await checkSecretsAuth('doppler', deps(runner));
    expect(res).toMatchObject({ installed: true, authenticated: true });
  });

  it('checks 1Password via op whoami', async () => {
    const runner = new FakeRunner({ available: ['op'] });
    runner.on('op whoami', { code: 1, stderr: 'not signed in' });
    const res = await checkSecretsAuth('onepassword', deps(runner));
    expect(res).toMatchObject({ tool: 'op', installed: true, authenticated: false });
  });

  it('returns null for providers with nothing to check', async () => {
    expect(await checkSecretsAuth('none', deps(new FakeRunner()))).toBeNull();
  });
});
