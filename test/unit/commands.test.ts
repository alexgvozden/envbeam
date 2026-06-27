import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { initCommand } from '../../src/commands/init.js';
import { configValidateCommand, configExplainCommand, configSyncCommand } from '../../src/commands/config.js';
import { identityAddCommand, identityListCommand, identityRemoveCommand, identityTestCommand } from '../../src/commands/identity.js';
import { doctorCommand } from '../../src/commands/doctor.js';
import { statusCommand } from '../../src/commands/status.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

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
    expect(await initCommand({ yes: true })).toBe(0);
    const cfg = await fs.readFile(path.join(dir, '.envbeam.yaml'), 'utf8');
    expect(cfg).toMatch(/workspace:/);
    expect(cfg).toMatch(/provider: doppler/);

    // second run without force → refuses
    expect(await initCommand({ yes: true })).toBe(1);
    // with force → overwrites
    expect(await initCommand({ yes: true, force: true })).toBe(0);
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
