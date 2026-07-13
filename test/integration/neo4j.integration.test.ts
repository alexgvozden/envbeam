import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RealCommandRunner } from '../../src/core/util/exec.js';
import { Neo4jProvider, parseScalarInt } from '../../src/core/providers/database/neo4j.js';
import { makeTestContext, tmpDir } from '../helpers/context.js';
import type { ProviderContext, SnapshotOptions } from '../../src/core/providers/types.js';

const runner = new RealCommandRunner();
let dockerOk = false;
let cypherOk = false;
let containerId: string | undefined;
let boltUrl: string | undefined;
let cleanupTmp: (() => Promise<void>) | undefined;

const PASSWORD = 'testpassword';
// Community edition ships APOC Core as a bundled plugin, enabled via NEO4J_PLUGINS.
const NEO4J_IMAGE = process.env.NEO4J_TEST_IMAGE ?? 'neo4j:5-community';

async function dockerAvailable(): Promise<boolean> {
  if (!(await runner.which('docker'))) return false;
  const res = await runner.run('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true });
  return res.code === 0 && /\d/.test(res.stdout.trim());
}

async function startNeo4j(): Promise<{ id: string; url: string }> {
  const run = await runner.run(
    'docker',
    [
      'run', '-d',
      '-e', `NEO4J_AUTH=neo4j/${PASSWORD}`,
      '-e', 'NEO4J_PLUGINS=["apoc"]',
      '-p', '127.0.0.1::7687',
      NEO4J_IMAGE,
    ],
    { allowFailure: true },
  );
  if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const id = run.stdout.trim();
  const portRes = await runner.run('docker', ['port', id, '7687'], { allowFailure: true });
  const mapped = portRes.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const port = mapped.slice(mapped.lastIndexOf(':') + 1);
  // assemble URL from parts so no credential literal sits in source
  const url = 'neo4j://neo4j:' + PASSWORD + '@' + `127.0.0.1:${port}`;
  return { id, url };
}

/** Run Cypher directly (test-side helper; the provider drives its own calls). */
async function cypher(query: string): Promise<string> {
  const port = boltUrl!.slice(boltUrl!.lastIndexOf(':') + 1);
  const res = await runner.run(
    'cypher-shell',
    ['-a', `neo4j://127.0.0.1:${port}`, '-u', 'neo4j', '--format', 'plain', query],
    { env: { NEO4J_PASSWORD: PASSWORD }, allowFailure: true },
  );
  if (res.code !== 0) throw new Error(`cypher-shell failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/** Wait until bolt accepts connections AND APOC has finished loading. */
async function waitReady(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      await cypher('RETURN apoc.version()');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('neo4j did not become ready (with APOC) in time');
}

beforeAll(async () => {
  dockerOk = await dockerAvailable();
  cypherOk = (await runner.which('cypher-shell')) != null;
  if (!dockerOk || !cypherOk) return;
  try {
    const home = await tmpDir('envbeam-neo4j-home-');
    cleanupTmp = home.cleanup;
    process.env.ENVBEAM_HOME = home.dir;
    process.env.ENVBEAM_MACHINE = 'graphbox';
    const started = await startNeo4j();
    containerId = started.id;
    boltUrl = started.url;
    await waitReady();
  } catch (e) {
    dockerOk = false;
    process.stderr.write(`[neo4j integration] skipping: ${(e as Error).message}\n`);
  }
}, 180_000);

afterAll(async () => {
  if (containerId) await runner.run('docker', ['rm', '-f', containerId], { allowFailure: true });
  delete process.env.ENVBEAM_HOME;
  delete process.env.ENVBEAM_MACHINE;
  if (cleanupTmp) await cleanupTmp();
}, 30_000);

function n4jCtx(root: string, extraDb: object = {}): ProviderContext {
  return makeTestContext({
    config: {
      version: 1,
      workspace: 'keeper',
      database: { provider: 'neo4j', mode: 'snapshot', ...extraDb },
    },
    runner,
    workspaceRoot: root,
    env: { NEO4J_URI: boltUrl! },
  }).providerCtx('database');
}

const SNAP: SnapshotOptions = {
  dataOnly: true,
  compress: false,
  includeTables: [],
  excludeTables: [],
  machine: 'graphbox',
  timestamp: '20260713T120000Z',
};

async function nodeCount(): Promise<number> {
  return parseScalarInt(await cypher('MATCH (n) RETURN count(n)'));
}
async function relCount(): Promise<number> {
  return parseScalarInt(await cypher('MATCH ()-[r]->() RETURN count(r)'));
}

describe(`neo4j provider (real docker ${NEO4J_IMAGE})`, () => {
  it('reports reachable status and detects change via node/rel counts', async () => {
    if (!dockerOk || !cypherOk) return;
    const { dir, cleanup } = await tmpDir();
    try {
      const provider = new Neo4jProvider();
      const ctx = n4jCtx(dir);
      expect((await provider.status(ctx)).reachable).toBe(true);

      await cypher('MATCH (n) DETACH DELETE n');
      await cypher("CREATE (:Person {name:'alice'})-[:KNOWS]->(:Person {name:'bob'})");

      const baseline = await provider.hasChanged(ctx, undefined);
      expect(baseline.changed).toBe(false);
      expect(baseline.fingerprint).toBeTruthy();

      await cypher("CREATE (:Person {name:'carol'})");
      const after = await provider.hasChanged(ctx, baseline.fingerprint);
      expect(after.changed).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);

  for (const compress of [false, true]) {
    it(`snapshots and restores the graph, replacing existing data (${compress ? 'gzip' : 'plain'})`, async () => {
      if (!dockerOk || !cypherOk) return;
      const { dir, cleanup } = await tmpDir();
      try {
        const provider = new Neo4jProvider();
        const ctx = n4jCtx(dir);

        // Known dataset: 2 nodes, 1 relationship.
        await cypher('MATCH (n) DETACH DELETE n');
        await cypher("CREATE (:Person {name:'alice'})-[:KNOWS]->(:Person {name:'bob'})");
        expect(await nodeCount()).toBe(2);
        expect(await relCount()).toBe(1);

        const snap = await provider.snapshot(ctx, { ...SNAP, compress });
        expect(snap.sizeBytes).toBeGreaterThan(0);
        expect(snap.file.endsWith(compress ? '.cypher.gz' : '.cypher')).toBe(true);

        // The other machine's graph: different, larger data.
        await cypher('MATCH (n) DETACH DELETE n');
        await cypher("CREATE (:Person {name:'zed'}), (:Person {name:'yan'}), (:Person {name:'xor'})");
        expect(await nodeCount()).toBe(3);

        const res = await provider.restore(ctx, snap.file);
        expect(res.restored).toBe(true);

        // The graph now holds exactly what the snapshot held — not the 3 stale
        // nodes, and the relationship came back too.
        expect(await nodeCount()).toBe(2);
        expect(await relCount()).toBe(1);
        const names = await cypher('MATCH (p:Person) RETURN p.name ORDER BY p.name');
        expect(names).toMatch(/alice/);
        expect(names).toMatch(/bob/);
        expect(names).not.toMatch(/zed/);
      } finally {
        await cleanup();
      }
    }, 90_000);
  }
});
