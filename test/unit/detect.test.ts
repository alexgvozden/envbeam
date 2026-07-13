import { describe, it, expect, afterEach } from 'vitest';
import { detectWorkspace } from '../../src/core/detect/index.js';
import { detectMigrateCommand } from '../../src/core/detect/database.js';
import { parseEnvKeys } from '../../src/core/detect/secrets.js';
import { sshHostFromUrl, parseGitConfig } from '../../src/core/detect/git.js';
import { parseCompose, findComposeFile } from '../../src/core/detect/container.js';
import { getField, detectedValue, resolveBranch } from '../../src/core/detect/types.js';
import { tmpDir, writeFiles } from '../helpers/context.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(files: Record<string, string>): Promise<string> {
  const { dir, cleanup } = await tmpDir();
  cleanups.push(cleanup);
  await writeFiles(dir, files);
  return dir;
}

describe('git detection', () => {
  it('extracts ssh host alias from scp-style and ssh:// urls', () => {
    expect(sshHostFromUrl('git@github-work:acme/repo.git')).toBe('github-work');
    expect(sshHostFromUrl('ssh://git@github-personal/acme/repo.git')).toBe('github-personal');
    expect(sshHostFromUrl('https://github.com/acme/repo.git')).toBeNull();
  });

  it('parses remotes from .git/config', async () => {
    const dir = await fixture({
      '.git/config': '[remote "origin"]\n\turl = git@github-work:acme/repo.git\n[branch "main"]\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
    });
    const { remotes } = await parseGitConfig(`${dir}/.git`);
    expect(remotes[0]).toEqual({ name: 'origin', url: 'git@github-work:acme/repo.git' });
  });

  it('resolves the `current` sentinel to the detected branch', async () => {
    const report = {
      workspaceRoot: '/x',
      fields: [{ field: 'git.branch', value: 'wave-1', source: '.git/HEAD', status: 'detected' as const }],
    };
    // sentinel / unset → detected branch
    expect(resolveBranch(report, 'current')).toBe('wave-1');
    expect(resolveBranch(report, undefined)).toBe('wave-1');
    // explicit branch in config wins
    expect(resolveBranch(report, 'release')).toBe('release');
    // nothing detected → main
    expect(resolveBranch({ workspaceRoot: '/x', fields: [] }, 'current')).toBe('main');
  });

  it('flags an https remote identity as ambiguous', async () => {
    const dir = await fixture({
      '.git/config': '[remote "origin"]\n\turl = https://github.com/acme/repo.git\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
    });
    const report = await detectWorkspace(dir);
    expect(getField(report, 'git.identity')?.status).toBe('ambiguous');
    expect(detectedValue(report, 'git.branch')).toBe('main');
  });
});

describe('container detection', () => {
  it('prefers devcontainer over compose', async () => {
    const dir = await fixture({
      '.devcontainer/devcontainer.json': '{}',
      'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
    });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'container.mode')).toBe('devcontainer');
    expect(detectedValue(report, 'container.composeFile')).toBe('docker-compose.yml');
  });

  it('detects compose mode and parses services', async () => {
    const dir = await fixture({
      'compose.yaml': 'services:\n  web:\n    build: .\n  db:\n    image: mysql:8\n    ports: ["3306:3306"]\n',
    });
    const file = await findComposeFile(dir);
    expect(file).toContain('compose.yaml');
    const parsed = await parseCompose(file!);
    expect(parsed?.services.map((s) => s.name).sort()).toEqual(['db', 'web']);
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'container.mode')).toBe('compose');
  });

  it('returns mode=none when nothing present', async () => {
    const dir = await fixture({ 'readme.md': '# x' });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'container.mode')).toBe('none');
  });

  it('detects a compose file kept in a subdirectory (monorepo layout)', async () => {
    const dir = await fixture({
      'infra/docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
    });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'container.mode')).toBe('compose');
    expect(detectedValue(report, 'container.composeFile')).toBe('infra/docker-compose.yml');
    // subdir compose still drives database detection
    expect(detectedValue(report, 'database.provider')).toBe('postgres');
  });

  it('prefers a root compose file over one in a subdirectory', async () => {
    const dir = await fixture({
      'compose.yml': 'services:\n  web:\n    build: .\n',
      'infra/docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
    });
    expect(await findComposeFile(dir)).toBe(`${dir}/compose.yml`);
  });

  it('prefers a dev-oriented subdir (infra) over a deploy/prod one', async () => {
    const dir = await fixture({
      'deploy/compose.yml': 'services:\n  db:\n    image: postgres:16\n',
      'infra/docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
    });
    expect(await findComposeFile(dir)).toBe(`${dir}/infra/docker-compose.yml`);
  });

  it('does not descend into ignored directories', async () => {
    const dir = await fixture({
      'node_modules/pkg/docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n',
      'readme.md': '# x',
    });
    expect(await findComposeFile(dir)).toBeNull();
  });
});

describe('database detection', () => {
  it('maps postgres image to provider+service', async () => {
    const dir = await fixture({ 'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n' });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'database.provider')).toBe('postgres');
    expect(detectedValue(report, 'database.service')).toBe('db');
  });

  it('maps mariadb image to mysql provider', async () => {
    const dir = await fixture({ 'docker-compose.yml': 'services:\n  maria:\n    image: mariadb:11\n' });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'database.provider')).toBe('mysql');
  });

  it('maps a neo4j image to the neo4j provider+service', async () => {
    const dir = await fixture({ 'docker-compose.yml': 'services:\n  graph:\n    image: neo4j:5\n' });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'database.provider')).toBe('neo4j');
    expect(detectedValue(report, 'database.service')).toBe('graph');
  });

  it('detects neo4j from a NEO4J_URI in .env when no compose service exists', async () => {
    const dir = await fixture({ '.env': 'NEO4J_URI=neo4j://localhost:7687\nNEO4J_PASSWORD=x\n' });
    const report = await detectWorkspace(dir);
    expect(detectedValue(report, 'database.provider')).toBe('neo4j');
  });

  it('flags multiple db services as ambiguous', async () => {
    const dir = await fixture({
      'docker-compose.yml': 'services:\n  pg:\n    image: postgres:16\n  my:\n    image: mysql:8\n',
    });
    const report = await detectWorkspace(dir);
    const f = getField(report, 'database.provider');
    expect(f?.status).toBe('ambiguous');
    expect(f?.candidates?.length).toBe(2);
  });

  it('detects migrate commands per stack', async () => {
    expect((await detectMigrateCommand(await fixture({ 'prisma/schema.prisma': 'x' })))?.command).toMatch(/prisma/);
    expect((await detectMigrateCommand(await fixture({ 'knexfile.js': 'x' })))?.command).toMatch(/knex/);
    expect((await detectMigrateCommand(await fixture({ 'manage.py': 'x' })))?.command).toMatch(/manage\.py migrate/);
    expect((await detectMigrateCommand(await fixture({ 'app.csproj': '<Project><PackageReference Include="Microsoft.EntityFrameworkCore"/></Project>' })))?.command).toMatch(/dotnet ef/);
    expect(await detectMigrateCommand(await fixture({ 'readme.md': 'x' }))).toBeNull();
  });

  it('detects Alembic migrations (root and nested)', async () => {
    const root = await detectMigrateCommand(await fixture({ 'alembic.ini': '[alembic]\n' }));
    expect(root?.command).toBe('alembic upgrade head');
    const nested = await detectMigrateCommand(await fixture({ 'apps/api/alembic.ini': '[alembic]\n' }));
    expect(nested?.command).toBe('alembic -c apps/api/alembic.ini upgrade head');
  });

  it('reads migrate from package.json scripts and deps', async () => {
    expect((await detectMigrateCommand(await fixture({ 'package.json': JSON.stringify({ scripts: { migrate: 'x' } }) })))?.command).toBe('npm run migrate');
    expect((await detectMigrateCommand(await fixture({ 'package.json': JSON.stringify({ dependencies: { typeorm: '1' } }) })))?.command).toMatch(/typeorm/);
  });
});

describe('secrets detection', () => {
  it('parses env keys (names only, no values, skips comments)', () => {
    const keys = parseEnvKeys('# c\nexport API_KEY=secret\nDB_URL=postgres://x\n\nBLANK=\nnot a line');
    expect(keys).toEqual(['API_KEY', 'DB_URL', 'BLANK']);
  });

  it('detects candidate keys from .env.example', async () => {
    const dir = await fixture({ '.env.example': 'API_KEY=\nDATABASE_URL=\n' });
    const report = await detectWorkspace(dir);
    const f = getField(report, 'secrets.keys');
    expect(f?.value).toEqual(['API_KEY', 'DATABASE_URL']);
  });
});
