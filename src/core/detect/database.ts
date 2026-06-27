import path from 'node:path';
import { pathExists, readFileIfExists } from '../util/fs.js';
import { findComposeFile, parseCompose, type ComposeService } from './container.js';
import type { DetectedField } from './types.js';

interface EngineMatch {
  engine: 'postgres' | 'mysql';
  service: string;
}

const ENGINE_IMAGE_PATTERNS: Array<{ re: RegExp; engine: 'postgres' | 'mysql' }> = [
  { re: /(^|\/)postgres(ql)?(:|$)/i, engine: 'postgres' },
  { re: /(^|\/)postgis(:|$)/i, engine: 'postgres' },
  { re: /timescale\/timescaledb/i, engine: 'postgres' },
  { re: /(^|\/)pgvector/i, engine: 'postgres' },
  { re: /(^|\/)mysql(:|$)/i, engine: 'mysql' },
  { re: /(^|\/)mariadb(:|$)/i, engine: 'mysql' },
  { re: /(^|\/)percona(:|$)/i, engine: 'mysql' },
];

function matchEngine(service: ComposeService): EngineMatch | null {
  const image = service.image ?? '';
  for (const { re, engine } of ENGINE_IMAGE_PATTERNS) {
    if (re.test(image)) return { engine, service: service.name };
  }
  // service name heuristic when image is custom-built
  if (/postgres|^pg$|^pg-/.test(service.name)) return { engine: 'postgres', service: service.name };
  if (/mysql|mariadb/.test(service.name)) return { engine: 'mysql', service: service.name };
  return null;
}

interface MigrateMarker {
  command: string;
  source: string;
}

/** Detect the stack's migration command from project markers. */
export async function detectMigrateCommand(root: string): Promise<MigrateMarker | null> {
  // Node: Prisma
  if (
    (await pathExists(path.join(root, 'prisma', 'schema.prisma'))) ||
    (await pathExists(path.join(root, 'schema.prisma')))
  ) {
    return { command: 'npx prisma migrate deploy', source: 'prisma/schema.prisma' };
  }
  // Node: Knex
  for (const kf of ['knexfile.js', 'knexfile.ts', 'knexfile.cjs']) {
    if (await pathExists(path.join(root, kf))) {
      return { command: 'npx knex migrate:latest', source: kf };
    }
  }
  // Node: TypeORM / Sequelize via package.json scripts
  const pkgText = await readFileIfExists(path.join(root, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (scripts.migrate) return { command: 'npm run migrate', source: 'package.json scripts.migrate' };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps?.typeorm) return { command: 'npx typeorm migration:run', source: 'package.json (typeorm)' };
      if (deps?.sequelize) return { command: 'npx sequelize-cli db:migrate', source: 'package.json (sequelize)' };
      if (deps?.['node-pg-migrate']) return { command: 'npx node-pg-migrate up', source: 'package.json (node-pg-migrate)' };
    } catch {
      /* ignore malformed package.json */
    }
  }
  // .NET EF Core: any .csproj referencing EntityFrameworkCore
  const csprojDir = await firstFileMatching(root, /\.csproj$/);
  if (csprojDir) {
    const text = await readFileIfExists(csprojDir);
    if (text && /EntityFrameworkCore|Microsoft\.EntityFrameworkCore/i.test(text)) {
      return { command: 'dotnet ef database update', source: path.basename(csprojDir) };
    }
  }
  // Rails
  if (await pathExists(path.join(root, 'config', 'database.yml'))) {
    return { command: 'bin/rails db:migrate', source: 'config/database.yml' };
  }
  // Django
  if (await pathExists(path.join(root, 'manage.py'))) {
    return { command: 'python manage.py migrate', source: 'manage.py' };
  }
  // Go: golang-migrate convention
  if (await pathExists(path.join(root, 'migrations'))) {
    return { command: 'migrate -path migrations -database "$DATABASE_URL" up', source: 'migrations/ (golang-migrate)' };
  }
  return null;
}

async function firstFileMatching(dir: string, re: RegExp): Promise<string | null> {
  const { promises: fs } = await import('node:fs');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (re.test(e)) return path.join(dir, e);
  }
  return null;
}

export async function detectDatabase(workspaceRoot: string): Promise<DetectedField[]> {
  const fields: DetectedField[] = [];
  const composeFile = await findComposeFile(workspaceRoot);
  const matches: EngineMatch[] = [];
  if (composeFile) {
    const parsed = await parseCompose(composeFile);
    for (const svc of parsed?.services ?? []) {
      const m = matchEngine(svc);
      if (m) matches.push(m);
    }
  }

  if (matches.length === 1) {
    const m = matches[0]!;
    fields.push({
      field: 'database.provider',
      value: m.engine,
      source: composeFile ? path.relative(workspaceRoot, composeFile) : 'compose',
      status: 'detected',
    });
    fields.push({
      field: 'database.service',
      value: m.service,
      source: composeFile ? path.relative(workspaceRoot, composeFile) : 'compose',
      status: 'detected',
    });
  } else if (matches.length > 1) {
    fields.push({
      field: 'database.provider',
      source: 'compose services',
      status: 'ambiguous',
      note: 'multiple database services found — declare which one',
      candidates: matches.map((m) => `${m.engine}:${m.service}`),
    });
  } else {
    fields.push({
      field: 'database.provider',
      source: 'compose services',
      status: 'missing',
      note: 'no database service detected',
    });
  }

  const migrate = await detectMigrateCommand(workspaceRoot);
  if (migrate) {
    fields.push({
      field: 'database.migrateCommand',
      value: migrate.command,
      source: migrate.source,
      status: 'detected',
    });
  } else {
    fields.push({
      field: 'database.migrateCommand',
      source: 'stack markers',
      status: 'missing',
      note: 'no migration tool detected — declare migrateCommand if migrations are used',
    });
  }

  return fields;
}
