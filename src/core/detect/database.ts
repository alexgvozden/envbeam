import path from 'node:path';
import { pathExists, readFileIfExists } from '../util/fs.js';
import { findComposeFile, parseCompose, type ComposeService } from './container.js';
import { findFileShallow } from './scan.js';
import type { DetectedField } from './types.js';

interface EngineMatch {
  engine: 'postgres' | 'mysql';
  service?: string;
  source: string;
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

function matchEngineFromCompose(service: ComposeService): EngineMatch | null {
  const image = service.image ?? '';
  for (const { re, engine } of ENGINE_IMAGE_PATTERNS) {
    if (re.test(image)) return { engine, service: service.name, source: 'compose' };
  }
  // service name heuristic when image is custom-built
  if (/postgres|^pg$|^pg-/.test(service.name)) return { engine: 'postgres', service: service.name, source: 'compose' };
  if (/mysql|mariadb/.test(service.name)) return { engine: 'mysql', service: service.name, source: 'compose' };
  return null;
}

/** Detect database engine from ORM/framework config files (fallback when no compose). */
async function detectEngineFromConfig(root: string): Promise<EngineMatch | null> {
  // Prisma schema
  for (const schemaPath of ['prisma/schema.prisma', 'schema.prisma']) {
    const text = await readFileIfExists(path.join(root, schemaPath));
    if (text) {
      const match = text.match(/provider\s*=\s*["']?(postgresql|postgres|mysql|mariadb)["']?/i);
      if (match) {
        const raw = match[1]!.toLowerCase();
        const engine = raw === 'postgresql' || raw === 'postgres' ? 'postgres' : 'mysql';
        return { engine, source: schemaPath };
      }
    }
  }

  // Django settings.py
  const djangoSettings = await readFileIfExists(path.join(root, 'settings.py'))
    ?? await readFileIfExists(path.join(root, 'config', 'settings.py'));
  if (djangoSettings) {
    if (/django\.db\.backends\.postgresql/i.test(djangoSettings)) {
      return { engine: 'postgres', source: 'settings.py' };
    }
    if (/django\.db\.backends\.mysql/i.test(djangoSettings)) {
      return { engine: 'mysql', source: 'settings.py' };
    }
  }

  // Rails database.yml
  const railsDb = await readFileIfExists(path.join(root, 'config', 'database.yml'));
  if (railsDb) {
    if (/adapter:\s*["']?postgresql/i.test(railsDb)) {
      return { engine: 'postgres', source: 'config/database.yml' };
    }
    if (/adapter:\s*["']?mysql/i.test(railsDb)) {
      return { engine: 'mysql', source: 'config/database.yml' };
    }
  }

  // .NET appsettings.json connection strings
  const appsettings = await readFileIfExists(path.join(root, 'appsettings.json'));
  if (appsettings) {
    if (/Host\s*=|Server\s*=.*Port\s*=\s*5432|Npgsql|PostgreSQL/i.test(appsettings)) {
      return { engine: 'postgres', source: 'appsettings.json' };
    }
    if (/Server\s*=.*Port\s*=\s*3306|MySql|MariaDB/i.test(appsettings)) {
      return { engine: 'mysql', source: 'appsettings.json' };
    }
  }

  // Environment files - check DATABASE_URL pattern
  for (const envFile of ['.env', '.env.local', '.env.development']) {
    const envText = await readFileIfExists(path.join(root, envFile));
    if (envText) {
      // Match DATABASE_URL=postgres:// or DATABASE_URL=postgresql://
      if (/DATABASE_URL\s*=\s*["']?postgres(ql)?:\/\//i.test(envText)) {
        return { engine: 'postgres', source: envFile };
      }
      if (/DATABASE_URL\s*=\s*["']?mysql:\/\//i.test(envText)) {
        return { engine: 'mysql', source: envFile };
      }
    }
  }

  // Go: check for common driver imports in go.mod
  const goMod = await readFileIfExists(path.join(root, 'go.mod'));
  if (goMod) {
    if (/github\.com\/lib\/pq|github\.com\/jackc\/pgx/i.test(goMod)) {
      return { engine: 'postgres', source: 'go.mod' };
    }
    if (/github\.com\/go-sql-driver\/mysql/i.test(goMod)) {
      return { engine: 'mysql', source: 'go.mod' };
    }
  }

  // Java: application.properties or application.yml
  const javaProps = await readFileIfExists(path.join(root, 'src', 'main', 'resources', 'application.properties'));
  if (javaProps) {
    if (/jdbc:postgresql/i.test(javaProps)) {
      return { engine: 'postgres', source: 'application.properties' };
    }
    if (/jdbc:mysql|jdbc:mariadb/i.test(javaProps)) {
      return { engine: 'mysql', source: 'application.properties' };
    }
  }
  const javaYml = await readFileIfExists(path.join(root, 'src', 'main', 'resources', 'application.yml'))
    ?? await readFileIfExists(path.join(root, 'src', 'main', 'resources', 'application.yaml'));
  if (javaYml) {
    if (/jdbc:postgresql|driver-class-name:.*postgresql/i.test(javaYml)) {
      return { engine: 'postgres', source: 'application.yml' };
    }
    if (/jdbc:mysql|jdbc:mariadb|driver-class-name:.*mysql/i.test(javaYml)) {
      return { engine: 'mysql', source: 'application.yml' };
    }
  }

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
  // Python: Django
  if (await pathExists(path.join(root, 'manage.py'))) {
    return { command: 'python manage.py migrate', source: 'manage.py' };
  }
  // Python: Alembic (SQLAlchemy) — often kept at the repo root or under a service subdir
  const alembicIni = await findFileShallow(root, ['alembic.ini'], { maxDepth: 2 });
  if (alembicIni) {
    const rel = path.relative(root, alembicIni);
    // Run from the directory holding alembic.ini so its config is picked up.
    const dir = path.dirname(rel);
    const command =
      dir === '.' ? 'alembic upgrade head' : `alembic -c ${rel} upgrade head`;
    return { command, source: rel };
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
  const composeMatches: EngineMatch[] = [];
  if (composeFile) {
    const parsed = await parseCompose(composeFile);
    for (const svc of parsed?.services ?? []) {
      const m = matchEngineFromCompose(svc);
      if (m) composeMatches.push(m);
    }
  }

  if (composeMatches.length === 1) {
    const m = composeMatches[0]!;
    fields.push({
      field: 'database.provider',
      value: m.engine,
      source: composeFile ? path.relative(workspaceRoot, composeFile) : 'compose',
      status: 'detected',
    });
    fields.push({
      field: 'database.service',
      value: m.service!,
      source: composeFile ? path.relative(workspaceRoot, composeFile) : 'compose',
      status: 'detected',
    });
  } else if (composeMatches.length > 1) {
    fields.push({
      field: 'database.provider',
      source: 'compose services',
      status: 'ambiguous',
      note: 'multiple database services found — declare which one',
      candidates: composeMatches.map((m) => `${m.engine}:${m.service}`),
    });
  } else {
    // Fallback: detect from ORM/framework config files
    const configMatch = await detectEngineFromConfig(workspaceRoot);
    if (configMatch) {
      fields.push({
        field: 'database.provider',
        value: configMatch.engine,
        source: configMatch.source,
        status: 'detected',
        note: 'detected from config (no compose service found)',
      });
    } else {
      fields.push({
        field: 'database.provider',
        source: 'project files',
        status: 'missing',
        note: 'no database detected',
      });
    }
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
