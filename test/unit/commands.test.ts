import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { initCommand } from '../../src/commands/init.js';
import { configValidateCommand, configExplainCommand, configSyncCommand } from '../../src/commands/config.js';
import { identityAddCommand, identityListCommand, identityRemoveCommand, identityTestCommand } from '../../src/commands/identity.js';
import { doctorCommand } from '../../src/commands/doctor.js';
import { statusCommand } from '../../src/commands/status.js';
import { readExistingDopplerStorage, ensureStorageReady } from '../../src/commands/storage.js';
import { tmpDir, writeFiles } from '../helpers/context.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { Logger } from '../../src/core/util/logger.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';

const DOPPLER_SECRETS = 'doppler secrets --project envbeam-global --config prd --json';
const dopplerSecret = (computed: string) => ({ computed });

const cleanups: Array<() => Promise<void>> = [];
let originalCwd: string;
let out = '';

beforeEach(() => {
  originalCwd = process.cwd();
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  process.env.ENVBEAM_CREDENTIAL_STORE = 'file';
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_CREDENTIAL_STORE;
  for (const k of ['ENVBEAM_S3_ACCESS_KEY', 'ENVBEAM_S3_SECRET_KEY', 'ENVBEAM_S3_BUCKET', 'ENVBEAM_S3_REGION', 'ENVBEAM_S3_ENDPOINT']) {
    delete process.env[k];
  }
  while (cleanups.length) await cleanups.pop()!();
});

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const { dir, cleanup } = await tmpDir('envbeam-cmd-');
  cleanups.push(cleanup);
  await writeFiles(dir, files);
  process.env.ENVBEAM_HOME = path.join(dir, '.home');
  process.chdir(dir);
  return dir;
}

describe('init command', () => {
  it('scaffolds a valid config and refuses to overwrite without --force', async () => {
    const dir = await workspace({
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
      '.env.example': 'API_KEY=\n',
    });
    // fake runner → no real doppler/aws/S3 network I/O during init
    const runner = new FakeRunner();
    expect(await initCommand({ yes: true, runner })).toBe(0);
    const cfg = await fs.readFile(path.join(dir, '.envbeam.yaml'), 'utf8');
    expect(cfg).toMatch(/workspace:/);
    expect(cfg).toMatch(/provider: doppler/);

    // second run without force → idempotent "already initialized" (exit 0, no overwrite)
    out = '';
    expect(await initCommand({ yes: true, runner })).toBe(0);
    expect(out).toMatch(/already initialized/i);
    // with force → re-scaffolds
    expect(await initCommand({ yes: true, force: true, runner })).toBe(0);
  });
});

describe('config command', () => {
  it('validates, explains, and syncs', async () => {
    const dir = await workspace({
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
      'prisma/schema.prisma': 'x',
      '.envbeam.yaml': 'version: 1\nworkspace: keeper\ndatabase:\n  mode: migrations-only\n',
    });

    expect(await configValidateCommand(undefined, {})).toBe(0);
    expect(out).toMatch(/is valid/);

    out = '';
    expect(await configExplainCommand('database.mode', {})).toBe(0);
    expect(out).toMatch(/migrations-only/);

    out = '';
    expect(await configExplainCommand(undefined, {})).toBe(0);
    expect(out).toMatch(/config fields/);

    out = '';
    expect(await configSyncCommand({})).toBe(0);
    expect(out).toMatch(/database\.migrateCommand/);

    out = '';
    expect(await configSyncCommand({ write: true })).toBe(0);
    const cfg = await fs.readFile(path.join(dir, '.envbeam.yaml'), 'utf8');
    expect(cfg).toMatch(/migrateCommand: npx prisma migrate deploy/);
    // re-validate after the agent-style edit
    out = '';
    expect(await configValidateCommand(undefined, {})).toBe(0);
  });

  it('reports invalid configs with exit 2', async () => {
    await workspace({ '.envbeam.yaml': 'version: 1\nworkspace: x\nbogus: 1\n' });
    expect(await configValidateCommand(undefined, {})).toBe(2);
    expect(out).toMatch(/invalid/i);
  });
});

describe('identity command', () => {
  it('adds, lists, tests, and removes identities', async () => {
    await workspace();
    expect(await identityAddCommand('github:work', { type: 'git', sshHost: 'github-work', yes: true })).toBe(0);
    expect(await identityAddCommand('doppler:keeper', { type: 'doppler', token: 'tok123', yes: true })).toBe(0);

    out = '';
    expect(await identityListCommand({})).toBe(0);
    expect(out).toMatch(/github:work/);
    expect(out).toMatch(/doppler:keeper/);
    expect(out).toMatch(/token/);

    // test a doppler identity with no doppler CLI → exit 2
    expect(await identityTestCommand('doppler:keeper', {})).toBe(2);

    // bad name → error
    expect(await identityAddCommand('not a name', { yes: true })).not.toBe(0);

    expect(await identityRemoveCommand('github:work', {})).toBe(0);
    expect(await identityRemoveCommand('github:work', {})).toBe(1);
  });
});

describe('readExistingDopplerStorage', () => {
  const fullSecrets = {
    ENVBEAM_S3_ENDPOINT: dopplerSecret('https://fsn1.your-objectstorage.com'),
    ENVBEAM_S3_BUCKET: dopplerSecret('my-bucket'),
    ENVBEAM_S3_REGION: dopplerSecret('fsn1'),
    ENVBEAM_S3_ACCESS_KEY: dopplerSecret('AKIA'),
    ENVBEAM_S3_SECRET_KEY: dopplerSecret('shhh'),
  };

  it('returns parsed credentials when all required secrets are present', async () => {
    const runner = new FakeRunner().on(DOPPLER_SECRETS, { stdout: JSON.stringify(fullSecrets) });
    expect(await readExistingDopplerStorage(runner)).toEqual({
      endpoint: 'https://fsn1.your-objectstorage.com',
      bucket: 'my-bucket',
      region: 'fsn1',
      accessKey: 'AKIA',
      secretKey: 'shhh',
    });
  });

  it('defaults region to "auto" and endpoint to "" when absent (e.g. native AWS S3)', async () => {
    const runner = new FakeRunner().on(DOPPLER_SECRETS, {
      stdout: JSON.stringify({
        ENVBEAM_S3_BUCKET: dopplerSecret('aws-bucket'),
        ENVBEAM_S3_ACCESS_KEY: dopplerSecret('AKIA'),
        ENVBEAM_S3_SECRET_KEY: dopplerSecret('shhh'),
      }),
    });
    expect(await readExistingDopplerStorage(runner)).toEqual({
      endpoint: '',
      bucket: 'aws-bucket',
      region: 'auto',
      accessKey: 'AKIA',
      secretKey: 'shhh',
    });
  });

  it('returns null when required secrets (bucket/access/secret) are missing', async () => {
    const runner = new FakeRunner().on(DOPPLER_SECRETS, {
      stdout: JSON.stringify({ ENVBEAM_S3_BUCKET: dopplerSecret('only-bucket') }),
    });
    expect(await readExistingDopplerStorage(runner)).toBeNull();
  });

  it('returns null when the doppler command fails', async () => {
    const runner = new FakeRunner().on(DOPPLER_SECRETS, { code: 1, stderr: 'not authenticated' });
    expect(await readExistingDopplerStorage(runner)).toBeNull();
  });

  it('returns null on unparseable doppler output', async () => {
    const runner = new FakeRunner().on(DOPPLER_SECRETS, { stdout: 'not json' });
    expect(await readExistingDopplerStorage(runner)).toBeNull();
  });
});

describe('ensureStorageReady (self-heal from Doppler)', () => {
  const deps = (runner: FakeRunner) => ({
    runner,
    logger: new Logger({ level: 'error' }),
    prompter: new AutoPrompter({ defaults: true }),
  });

  it('imports S3 settings from Doppler and reports ready', async () => {
    await workspace(); // isolated ENVBEAM_HOME → storage not configured yet
    const runner = new FakeRunner({ available: ['doppler', 'aws'] });
    runner.on('doppler me', { stdout: '{"name":"me"}' });
    runner.on(DOPPLER_SECRETS, {
      stdout: JSON.stringify({
        ENVBEAM_S3_BUCKET: dopplerSecret('b'),
        ENVBEAM_S3_ACCESS_KEY: dopplerSecret('ak'),
        ENVBEAM_S3_SECRET_KEY: dopplerSecret('sk'),
        ENVBEAM_S3_ENDPOINT: dopplerSecret('https://e'),
        ENVBEAM_S3_REGION: dopplerSecret('auto'),
      }),
    });
    expect(await ensureStorageReady(deps(runner))).toBe(true);
    expect(process.env.ENVBEAM_S3_BUCKET).toBe('b'); // applied to env for this process
  });

  it('reports not-ready (guides to setup) when Doppler has no S3 settings', async () => {
    await workspace();
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler me', { stdout: '{"name":"me"}' });
    runner.on(DOPPLER_SECRETS, { stdout: '{}' }); // nothing stored
    expect(await ensureStorageReady(deps(runner))).toBe(false);
  });

  it('reports not-ready when not signed in to Doppler', async () => {
    await workspace();
    const runner = new FakeRunner({ available: ['doppler'] });
    runner.on('doppler me', { code: 1, stderr: 'you must provide a token' });
    expect(await ensureStorageReady(deps(runner))).toBe(false);
  });
});

describe('doctor + status commands', () => {
  it('doctor prints detection report and can write gaps with --fix', async () => {
    const dir = await workspace({
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
      'prisma/schema.prisma': 'x',
      '.envbeam.yaml': 'version: 1\nworkspace: keeper\ndatabase:\n  mode: migrations-only\n',
    });
    const code = await doctorCommand({ noAuth: true, fix: true, yes: true });
    expect([0, 2]).toContain(code);
    expect(out).toMatch(/Detection report/);
    const cfg = await fs.readFile(path.join(dir, '.envbeam.yaml'), 'utf8');
    expect(cfg).toMatch(/service: db|provider: postgres/);
  });

  it('status reports without a workspace fails clearly', async () => {
    await workspace(); // no .envbeam.yaml
    const code = await statusCommand({});
    expect(code).toBe(2);
  });
});
