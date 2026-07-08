import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { RealCommandRunner } from '../../src/core/util/exec.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../../dist/cli.js');
const runner = new RealCommandRunner();
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

let built = false;
beforeAll(async () => {
  built = await fs
    .stat(CLI)
    .then(() => true)
    .catch(() => false);
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function ws(): Promise<{ dir: string; home: string }> {
  const { dir, cleanup } = await tmpDir('envbeam-cli-int-');
  cleanups.push(cleanup);
  const home = path.join(dir, 'home');
  await fs.mkdir(home, { recursive: true });
  return { dir, home };
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

async function eb(cwd: string, home: string, ...args: string[]) {
  const res = await runner.run('node', [CLI, ...args], {
    cwd,
    allowFailure: true,
    // ENVBEAM_DISABLE_STORAGE keeps the compiled CLI from reaching the real
    // Doppler/S3 registry (the subprocess inherits process.env otherwise).
    env: { ENVBEAM_HOME: home, ENVBEAM_CREDENTIAL_STORE: 'file', NO_COLOR: '1', ENVBEAM_DISABLE_STORAGE: '1' },
  });
  return { code: res.code, out: strip(res.stdout), err: strip(res.stderr) };
}

describe('CLI end-to-end (compiled dist)', () => {
  it('reports version and help', async () => {
    if (!built) return;
    const { dir, home } = await ws();
    // Version output is stamped with build info, e.g. "0.11.5 (build abc1234, …)".
    expect((await eb(dir, home, '--version')).out.trim()).toMatch(new RegExp(`^${PKG_VERSION.replace(/\./g, '\\.')}`));
    const help = await eb(dir, home, '--help');
    expect(help.out).toMatch(/Beam your whole dev environment/);
    expect(help.out).toMatch(/resume[\s\S]*pause[\s\S]*doctor/);
  });

  it('init → validate → doctor → status → config sync flow', async () => {
    if (!built) return;
    const { dir, home } = await ws();
    await writeFiles(dir, {
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
      '.env.example': 'API_KEY=\nDATABASE_URL=\n',
      'prisma/schema.prisma': 'x',
    });
    // git repo so git detection works
    await runner.run('git', ['init', '-q'], { cwd: dir, allowFailure: true });

    const init = await eb(dir, home, '--yes', 'init');
    expect(init.code).toBe(0);
    expect(await fs.readFile(path.join(dir, '.envbeam.yaml'), 'utf8')).toMatch(/workspace:/);

    const validate = await eb(dir, home, 'config', 'validate');
    expect(validate.code).toBe(0);
    expect(validate.out).toMatch(/is valid/);

    const doctor = await eb(dir, home, 'doctor', '--no-auth');
    // exit 0 when all tools present, 2 when some are missing (doppler/claude-sync
    // aren't installed here) — both are valid; the detection report is the point.
    expect([0, 2]).toContain(doctor.code);
    expect(doctor.out).toMatch(/Detection report/);
    expect(doctor.out).toMatch(/database\.provider\s+postgres/);

    const status = await eb(dir, home, 'status');
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/Workspace:/);

    const sync = await eb(dir, home, 'config', 'sync');
    expect(sync.out).toMatch(/database\.migrateCommand/);
  });

  it('rejects an invalid config with exit code 2', async () => {
    if (!built) return;
    const { dir, home } = await ws();
    await fs.writeFile(path.join(dir, '.envbeam.yaml'), 'version: 9\nworkspace: x\n');
    const res = await eb(dir, home, 'config', 'validate');
    expect(res.code).toBe(2);
    expect(res.err + res.out).toMatch(/invalid/i);
  });

  it('manages identities (add/list/remove) via the file store', async () => {
    if (!built) return;
    const { dir, home } = await ws();
    const add = await eb(dir, home, 'identity', 'add', 'github:work', '--type', 'git', '--ssh-host', 'github-work');
    expect(add.code).toBe(0);
    const list = await eb(dir, home, 'identity', 'list');
    expect(list.out).toMatch(/github:work/);
    expect(list.out).toMatch(/sshHost=github-work/);
    const rm = await eb(dir, home, 'identity', 'remove', 'github:work');
    expect(rm.code).toBe(0);
    expect((await eb(dir, home, 'identity', 'list')).out).not.toMatch(/github:work/);
  });

  it('runs resume/pause as dry-runs without mutating', async () => {
    if (!built) return;
    const { dir, home } = await ws();
    await runner.run('git', ['init', '-q'], { cwd: dir, allowFailure: true });
    await fs.writeFile(
      path.join(dir, '.envbeam.yaml'),
      'version: 1\nworkspace: w\ncontainer:\n  mode: none\nsession:\n  provider: none\n',
    );
    const resume = await eb(dir, home, '--yes', '--dry-run', 'resume');
    expect(resume.code).toBe(0);
    expect(resume.out).toMatch(/dry-run complete/);
    const pause = await eb(dir, home, '--yes', '--dry-run', 'pause');
    expect(pause.code).toBe(0);
    expect(pause.out).toMatch(/dry-run complete/);
  });
});
