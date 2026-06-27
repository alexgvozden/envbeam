import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RealCommandRunner } from '../../src/core/util/exec.js';
import { ComposeContainerProvider } from '../../src/core/providers/container/compose.js';
import { DevcontainerProvider } from '../../src/core/providers/container/devcontainer.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';

const runner = new RealCommandRunner();
let dockerOk = false;
let devcontainerOk = false;

async function dockerAvailable(): Promise<boolean> {
  if (!(await runner.which('docker'))) return false;
  const res = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true });
  return res.code === 0 && /\d/.test(res.stdout.trim());
}

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  devcontainerOk = (await runner.which('devcontainer')) != null;
}, 30_000);

const COMPOSE = `services:
  app:
    image: alpine:3
    command: ["sleep", "600"]
`;

describe('compose container provider (real docker)', () => {
  it('brings the stack up, reports running, then stops it', async () => {
    if (!dockerOk) return;
    const { dir, cleanup } = await tmpDir('envbeam-compose-int-');
    const provider = new ComposeContainerProvider();
    try {
      await fs.writeFile(path.join(dir, 'docker-compose.yml'), COMPOSE);
      const ctx = makeTestContext({
        config: { version: 1, workspace: 'ctest', container: { mode: 'compose', service: 'app' } },
        runner,
        workspaceRoot: dir,
      }).providerCtx('container');

      const up = await provider.up(ctx);
      expect(up.running).toBe(true);

      const status = await provider.status(ctx);
      expect(status.services.some((s) => /running|up/i.test(s.state))).toBe(true);

      await provider.down(ctx);
      const after = await provider.status(ctx);
      expect(after.running).toBe(false);
    } finally {
      await runner.run('docker', ['compose', '-f', path.join(dir, 'docker-compose.yml'), 'down', '-v'], {
        cwd: dir,
        allowFailure: true,
      });
      await cleanup();
    }
  }, 120_000);
});

describe('devcontainer provider (real devcontainer CLI)', () => {
  it('brings a devcontainer up and stops it', async () => {
    if (!dockerOk || !devcontainerOk) return;
    const { dir, cleanup } = await tmpDir('envbeam-devc-int-');
    const provider = new DevcontainerProvider();
    try {
      await fs.mkdir(path.join(dir, '.devcontainer'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.devcontainer', 'devcontainer.json'),
        JSON.stringify({ name: 'devc-int', image: 'alpine:3', overrideCommand: true }),
      );
      const ctx = makeTestContext({
        config: { version: 1, workspace: 'devc', container: { mode: 'devcontainer' } },
        runner,
        workspaceRoot: dir,
      }).providerCtx('container');

      const up = await provider.up(ctx);
      expect(up.running).toBe(true);
      await provider.down(ctx);
    } finally {
      await cleanup();
    }
  }, 180_000);
});
