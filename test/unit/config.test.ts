import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  validateConfigText,
  ConfigValidationError,
} from '../../src/core/config/load.js';
import { workspaceConfigSchema } from '../../src/core/config/schema.js';
import { mergeDetection } from '../../src/core/config/merge.js';
import { computeGaps } from '../../src/core/config/gaps.js';
import { explainField, FIELD_DOCS } from '../../src/core/config/explain.js';
import type { DetectionReport } from '../../src/core/detect/types.js';

const MINIMAL = `
version: 1
workspace: keeper-api
git: { identity: github:work }
secrets: { provider: doppler, identity: doppler:keeper, project: keeper, config: dev }
database: { mode: snapshot, sync: { target: syncthing, path: ~/snaps } }
session: { provider: claude-sync }
`;

describe('config schema', () => {
  it('parses a minimal real config and applies defaults', () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.workspace).toBe('keeper-api');
    expect(cfg.git?.remote).toBe('origin'); // default
    expect(cfg.git?.branch).toBe('current'); // default
    expect(cfg.database?.mode).toBe('snapshot');
    expect(cfg.database?.restore).toBe('prompt'); // default
    expect(cfg.session?.scope).toBe('project'); // default
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => parseConfig('version: 1\nworkspace: x\nbogus: true')).toThrow(ConfigValidationError);
  });

  it('rejects a bad version', () => {
    const res = validateConfigText('version: 2\nworkspace: x');
    expect(res.ok).toBe(false);
  });

  it('rejects a malformed identity reference', () => {
    const res = validateConfigText('version: 1\nworkspace: x\ngit: { identity: "not an id" }');
    expect(res.ok).toBe(false);
  });

  it('reports issues with paths for invalid enums', () => {
    const res = validateConfigText('version: 1\nworkspace: x\ndatabase: { mode: bogus }');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes('database.mode'))).toBe(true);
    }
  });

  it('accepts the fully-expanded schema from the PRD', () => {
    const full = {
      version: 1,
      workspace: 'keeper-api',
      git: { identity: 'github:work', remote: 'origin', branch: 'main', autopush: true, autopull: 'ff-only' },
      secrets: { provider: 'doppler', identity: 'doppler:keeper', project: 'keeper', config: 'dev', output: 'dotenv' },
      container: { mode: 'devcontainer', upOnResume: true, stopOnPause: false },
      database: {
        provider: 'postgres',
        mode: 'snapshot',
        restore: 'prompt',
        connection: 'from-secrets',
        service: 'db',
        migrate: true,
        migrateCommand: 'dotnet ef database update',
        snapshot: { dataOnly: true, compress: true, tables: { include: ['test_*'], exclude: ['audit_log'] }, changeDetection: true },
        sync: { target: 's3', identity: 's3:personal', bucket: 'b', maxSizeMB: 500, keep: 5 },
      },
      session: { provider: 'claude-sync', scope: 'project' },
    };
    expect(() => workspaceConfigSchema.parse(full)).not.toThrow();
  });
});

function detection(fields: DetectionReport['fields']): DetectionReport {
  return { workspaceRoot: '/ws', fields };
}

describe('mergeDetection', () => {
  it('fills container mode/compose and db fields when absent', () => {
    const cfg = parseConfig('version: 1\nworkspace: x\ndatabase: { mode: migrations-only }');
    const merged = mergeDetection(cfg, detection([
      { field: 'container.mode', value: 'compose', source: 's', status: 'detected' },
      { field: 'container.composeFile', value: 'docker-compose.yml', source: 's', status: 'detected' },
      { field: 'database.provider', value: 'postgres', source: 's', status: 'detected' },
      { field: 'database.service', value: 'db', source: 's', status: 'detected' },
      { field: 'database.migrateCommand', value: 'npx prisma migrate deploy', source: 's', status: 'detected' },
    ]));
    expect(merged.container?.mode).toBe('compose');
    expect(merged.container?.composeFile).toBe('docker-compose.yml');
    expect(merged.database?.provider).toBe('postgres');
    expect(merged.database?.migrateCommand).toBe('npx prisma migrate deploy');
  });

  it('does not override explicit config', () => {
    const cfg = parseConfig('version: 1\nworkspace: x\ncontainer: { mode: none }\ndatabase: { provider: mysql, mode: migrations-only }');
    const merged = mergeDetection(cfg, detection([
      { field: 'container.mode', value: 'compose', source: 's', status: 'detected' },
      { field: 'database.provider', value: 'postgres', source: 's', status: 'detected' },
    ]));
    expect(merged.container?.mode).toBe('none');
    expect(merged.database?.provider).toBe('mysql');
  });

  it('never synthesizes a database block when none is declared', () => {
    const cfg = parseConfig('version: 1\nworkspace: x');
    const merged = mergeDetection(cfg, detection([
      { field: 'database.provider', value: 'postgres', source: 's', status: 'detected' },
    ]));
    expect(merged.database).toBeUndefined();
  });
});

describe('computeGaps', () => {
  it('returns only detected-but-undeclared fields', () => {
    const cfg = parseConfig('version: 1\nworkspace: x\ncontainer: { mode: compose }\ndatabase: { mode: migrations-only }');
    const gaps = computeGaps(cfg, detection([
      { field: 'container.mode', value: 'compose', source: 's', status: 'detected' },
      { field: 'container.composeFile', value: 'docker-compose.yml', source: 's', status: 'detected' },
      { field: 'database.service', value: 'db', source: 's', status: 'detected' },
    ]));
    const paths = gaps.map((g) => g.path.join('.'));
    expect(paths).toContain('container.composeFile');
    expect(paths).toContain('database.service');
    expect(paths).not.toContain('container.mode'); // already declared
  });

  it('ignores ambiguous/missing detection', () => {
    const cfg = parseConfig('version: 1\nworkspace: x\ndatabase: { mode: migrations-only }');
    const gaps = computeGaps(cfg, detection([
      { field: 'database.provider', source: 's', status: 'ambiguous', candidates: ['postgres:db1', 'postgres:db2'] },
    ]));
    expect(gaps).toHaveLength(0);
  });
});

describe('config explain', () => {
  it('documents every field that appears in the schema docs map', () => {
    expect(explainField('database.mode')).toMatch(/migrations-only/);
    expect(explainField('nonexistent')).toBeUndefined();
    expect(Object.keys(FIELD_DOCS).length).toBeGreaterThan(20);
  });
});
