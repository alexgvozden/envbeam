import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  Neo4jProvider,
  parseScalarInt,
  extractCypherStatements,
  addNeo4jPluginsToCompose,
} from '../../src/core/providers/database/neo4j.js';
import { resolveConnection } from '../../src/core/providers/database/connection.js';
import { FakeRunner } from '../helpers/fakeRunner.js';
import { makeTestContext, tmpDir, writeFiles } from '../helpers/context.js';
import { AutoPrompter } from '../../src/core/util/prompt.js';
import type { SnapshotOptions } from '../../src/core/providers/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const SNAP: SnapshotOptions = {
  dataOnly: true,
  compress: false,
  includeTables: [],
  excludeTables: [],
  machine: 'laptop',
  timestamp: '20260713T000000Z',
};

function n4jCtx(runner: FakeRunner, root: string, env: Record<string, string>, config: object = {}) {
  return makeTestContext({
    config: { version: 1, workspace: 'keeper', database: { provider: 'neo4j', mode: 'snapshot', ...config } },
    runner,
    workspaceRoot: root,
    env,
  }).providerCtx('database');
}

/** Grab the trailing Cypher query a cypher-shell call ran (the last positional). */
function lastQuery(args: string[]): string {
  return args[args.length - 1] ?? '';
}

describe('neo4j connection', () => {
  const KEYS = { host: ['NEO4J_HOST'], port: ['NEO4J_PORT'], user: ['NEO4J_USERNAME'], password: ['NEO4J_PASSWORD'], database: ['NEO4J_DATABASE'] };

  it('resolves a NEO4J_URI bolt URL into parts', () => {
    const ctx = n4jCtx(new FakeRunner(), '/tmp', { NEO4J_URI: 'neo4j://app:secret@graph.local:7687' });
    const parts = resolveConnection(ctx, 'neo4j', KEYS);
    expect(parts).toMatchObject({ host: 'graph.local', port: '7687', user: 'app', password: 'secret' });
    expect(parts.url).toBe('neo4j://app:secret@graph.local:7687');
  });

  it('accepts a bolt+s TLS scheme', () => {
    const ctx = n4jCtx(new FakeRunner(), '/tmp', { NEO4J_URI: 'bolt+s://x.databases.neo4j.io:7687' });
    const parts = resolveConnection(ctx, 'neo4j', KEYS);
    expect(parts.host).toBe('x.databases.neo4j.io');
    expect(parts.url).toBe('bolt+s://x.databases.neo4j.io:7687');
  });

  it('passes the password via NEO4J_PASSWORD env, never in argv', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', { stdout: '1' });
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(runner, '/tmp', { NEO4J_URI: 'neo4j://neo4j:hunter2@localhost:7687' });
    await provider.status(ctx);
    const call = runner.callsTo('cypher-shell')[0]!;
    expect(call.options.env?.NEO4J_PASSWORD).toBe('hunter2');
    expect(call.args).not.toContain('hunter2');
    // address is scheme://host:port with credentials stripped
    const aIdx = call.args.indexOf('-a');
    expect(call.args[aIdx + 1]).toBe('neo4j://localhost:7687');
    expect(call.args).toContain('-u');
    expect(call.args[call.args.indexOf('-u') + 1]).toBe('neo4j');
  });

  it('falls back to a Docker NEO4J_AUTH=user/password', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', { stdout: '1' });
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(runner, '/tmp', { NEO4J_HOST: 'localhost', NEO4J_AUTH: 'neo4j/testpass' });
    await provider.status(ctx);
    const call = runner.callsTo('cypher-shell')[0]!;
    expect(call.args[call.args.indexOf('-u') + 1]).toBe('neo4j');
    expect(call.options.env?.NEO4J_PASSWORD).toBe('testpass');
  });

  it('warns when two bolt URLs are present', () => {
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(new FakeRunner(), '/tmp', {
      NEO4J_URI: 'neo4j://a@h1:7687',
      OTHER_BOLT_URL: 'bolt://b@h2:7687',
    });
    expect(provider.ambiguityWarning(ctx)).toMatch(/Multiple neo4j/);
  });
});

describe('neo4j helpers', () => {
  it('parseScalarInt skips the plain-format header row', () => {
    expect(parseScalarInt('count(n)\n42')).toBe(42);
    expect(parseScalarInt('count(r)\n0')).toBe(0);
    expect(parseScalarInt('nope')).toBe(0);
  });

  it('extractCypherStatements drops the column header', () => {
    const out = extractCypherStatements('cypherStatements\n:begin\nCREATE (n);\n:commit\n');
    expect(out).toBe(':begin\nCREATE (n);\n:commit\n');
  });

  it('extractCypherStatements unwraps a quoted multi-line blob', () => {
    const quoted = 'cypherStatements\n":begin\\nCREATE (n {name:\\"a\\"});\\n:commit"';
    const out = extractCypherStatements(quoted);
    expect(out).toBe(':begin\nCREATE (n {name:"a"});\n:commit\n');
  });
});

describe('addNeo4jPluginsToCompose', () => {
  it('adds NEO4J_PLUGINS to a map-form environment, preserving comments', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const file = path.join(dir, 'docker-compose.yml');
    await fs.writeFile(file, 'services:\n  graph:\n    image: neo4j:5 # dev graph\n    environment:\n      NEO4J_AUTH: neo4j/pw\n');
    expect(await addNeo4jPluginsToCompose(file, 'graph')).toBe(true);
    const out = await fs.readFile(file, 'utf8');
    expect(out).toMatch(/NEO4J_PLUGINS:/);
    expect(out).toContain('# dev graph'); // comment preserved
    expect(out).toContain('NEO4J_AUTH: neo4j/pw');
  });

  it('adds to a list-form environment', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const file = path.join(dir, 'compose.yaml');
    await fs.writeFile(file, 'services:\n  graph:\n    image: neo4j:5\n    environment:\n      - NEO4J_AUTH=neo4j/pw\n');
    expect(await addNeo4jPluginsToCompose(file, 'graph')).toBe(true);
    const out = await fs.readFile(file, 'utf8');
    expect(out).toMatch(/- NEO4J_PLUGINS=/);
  });

  it('creates an environment block when the service has none', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const file = path.join(dir, 'compose.yaml');
    await fs.writeFile(file, 'services:\n  graph:\n    image: neo4j:5\n');
    expect(await addNeo4jPluginsToCompose(file, 'graph')).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toMatch(/environment:[\s\S]*NEO4J_PLUGINS/);
  });

  it('is idempotent and returns false when the plugin is already declared or the service is missing', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const file = path.join(dir, 'compose.yaml');
    await fs.writeFile(file, 'services:\n  graph:\n    image: neo4j:5\n    environment:\n      NEO4J_PLUGINS: \'["apoc"]\'\n');
    expect(await addNeo4jPluginsToCompose(file, 'graph')).toBe(false);
    expect(await addNeo4jPluginsToCompose(file, 'nope')).toBe(false);
  });
});

describe('neo4j provider', () => {
  it('change detection: baseline then change via node/rel counts', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    let nodes = 3;
    runner.on('cypher-shell', (_c, args) => {
      const q = lastQuery(args);
      if (q === 'RETURN 1') return { stdout: '1' };
      if (q.includes('count(n)')) return { stdout: `count(n)\n${nodes}` };
      if (q.includes('count(r)')) return { stdout: 'count(r)\n2' };
      return { stdout: '' };
    });
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(runner, '/tmp', { NEO4J_HOST: 'localhost' });
    const first = await provider.hasChanged(ctx, undefined);
    expect(first.changed).toBe(false);
    expect(first.fingerprint).toBeTruthy();
    expect(first.detail).toMatch(/node/);
    nodes = 10;
    const second = await provider.hasChanged(ctx, first.fingerprint);
    expect(second.changed).toBe(true);
  });

  it('hasChanged reports unreachable when ping fails', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', { code: 1, stderr: 'refused' });
    const res = await new Neo4jProvider().hasChanged(n4jCtx(runner, '/tmp', {}), undefined);
    expect(res.changed).toBe(false);
    expect(res.detail).toMatch(/not reachable/);
  });

  it('pins per-label counts and ignores whole-graph counts when labels are set', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    let totalNodes = 100;
    runner.on('cypher-shell', (_c, args) => {
      const q = lastQuery(args);
      if (q === 'RETURN 1') return { stdout: '1' };
      if (q.includes('`Person`')) return { stdout: 'count(n)\n5' }; // pinned, stable
      if (q.includes('count(n)')) return { stdout: `count(n)\n${totalNodes}` };
      if (q.includes('count(r)')) return { stdout: 'count(r)\n1' };
      return { stdout: '' };
    });
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(runner, '/tmp', { NEO4J_HOST: 'localhost' }, { changeTables: ['Person'] });
    const first = await provider.hasChanged(ctx, undefined);
    totalNodes = 999; // whole-graph drift must not flip the fingerprint
    const second = await provider.hasChanged(ctx, first.fingerprint);
    expect(second.changed).toBe(false);
  });

  it('exports via apoc and writes a .cypher file', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', (_c, args) => {
      const q = lastQuery(args);
      if (q === 'RETURN apoc.version()') return { stdout: '5.20.0' };
      if (q.includes('apoc.export.cypher.all')) return { stdout: 'cypherStatements\n:begin\nCREATE (:X);\n:commit\n' };
      return { stdout: '' };
    });
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(runner, dir, { NEO4J_HOST: 'localhost' });
    const snap = await provider.snapshot(ctx, SNAP);
    cleanups.push(async () => { await fs.rm(snap.file, { force: true }); });
    expect(snap.file.endsWith('.cypher')).toBe(true);
    const content = await fs.readFile(snap.file, 'utf8');
    expect(content).toContain('CREATE (:X)');
    expect(runner.calls.some((c) => lastQuery(c.args).includes('apoc.export.cypher.all'))).toBe(true);
  });

  it('snapshot refuses (with guidance) when APOC is absent', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', (_c, args) =>
      lastQuery(args) === 'RETURN apoc.version()' ? { code: 1, stderr: 'Unknown function' } : { stdout: '' },
    );
    const provider = new Neo4jProvider();
    await expect(provider.snapshot(n4jCtx(runner, '/tmp', {}), SNAP)).rejects.toThrow(/APOC/);
  });

  it('empties the graph before replaying the dump on restore', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const script = path.join(dir, 'dump.cypher');
    await fs.writeFile(script, ':begin\nCREATE (:X);\n:commit\n');
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', (_c, args) =>
      lastQuery(args) === 'RETURN apoc.version()' ? { stdout: '5.20.0' } : { stdout: '' },
    );
    const provider = new Neo4jProvider();
    const res = await provider.restore(n4jCtx(runner, dir, { NEO4J_HOST: 'localhost' }), script);
    expect(res.restored).toBe(true);

    const deleteIdx = runner.calls.findIndex((c) => lastQuery(c.args).includes('DETACH DELETE'));
    const fileIdx = runner.calls.findIndex((c) => c.args.includes('--file'));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThan(deleteIdx); // wipe precedes replay
    expect(runner.calls[fileIdx]!.args[runner.calls[fileIdx]!.args.indexOf('--file') + 1]).toBe(script);
  });

  it('round-trips a gzipped snapshot', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', (_c, args) => {
      const q = lastQuery(args);
      if (q === 'RETURN apoc.version()') return { stdout: '5.20.0' };
      if (q.includes('apoc.export.cypher.all')) return { stdout: 'cypherStatements\nCREATE (:Y);\n' };
      return { stdout: '' };
    });
    const provider = new Neo4jProvider();
    const ctx = n4jCtx(runner, dir, { NEO4J_HOST: 'localhost' });
    const snap = await provider.snapshot(ctx, { ...SNAP, compress: true });
    cleanups.push(async () => { await fs.rm(snap.file, { force: true }); });
    expect(snap.file.endsWith('.cypher.gz')).toBe(true);
    expect(await fs.stat(snap.file).then(() => true).catch(() => false)).toBe(true);

    await provider.restore(ctx, snap.file);
    // the gunzipped temp is fed to cypher-shell --file and then cleaned up
    const fileCall = runner.calls.find((c) => c.args.includes('--file'))!;
    const tempPath = fileCall.args[fileCall.args.indexOf('--file') + 1]!;
    expect(tempPath.endsWith('.restore.cypher')).toBe(true);
    expect(await fs.stat(tempPath).then(() => true).catch(() => false)).toBe(false);
  });

  it('dry-run snapshot/restore run no cypher-shell', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'keeper', database: { provider: 'neo4j', mode: 'snapshot' } },
      runner,
      dryRun: true,
      env: { NEO4J_HOST: 'localhost' },
    }).providerCtx('database');
    const provider = new Neo4jProvider();
    const snap = await provider.snapshot(ctx, SNAP);
    expect(snap.sizeBytes).toBe(0);
    await provider.restore(ctx, '/tmp/x.cypher');
    expect(runner.callsTo('cypher-shell')).toHaveLength(0);
  });

  it('auto-enables APOC on a compose service when confirmed, then snapshots', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, {
      'docker-compose.yml': 'services:\n  graph:\n    image: neo4j:5\n    environment:\n      NEO4J_AUTH: neo4j/testpass\n',
    });
    const runner = new FakeRunner({ available: ['cypher-shell', 'docker'] });
    let apocEnabled = false;
    runner.on('cypher-shell', (_c, args) => {
      const q = lastQuery(args);
      if (q === 'RETURN apoc.version()') return apocEnabled ? { stdout: '5.20.0' } : { code: 1, stderr: 'Unknown function' };
      if (q.includes('apoc.export.cypher.all')) return { stdout: 'cypherStatements\nCREATE (:Z);\n' };
      return { stdout: '' };
    });
    // The recreate is what "installs" APOC — flip the flag when docker runs.
    runner.on('docker', () => { apocEnabled = true; return {}; });

    const ctx = makeTestContext({
      config: {
        version: 1,
        workspace: 'keeper',
        container: { mode: 'compose', service: 'graph' },
        database: { provider: 'neo4j', mode: 'snapshot', service: 'graph' },
      },
      runner,
      workspaceRoot: dir,
      env: { NEO4J_HOST: 'localhost' },
      prompter: new AutoPrompter({ defaults: true }),
    }).providerCtx('database');

    const snap = await new Neo4jProvider().snapshot(ctx, SNAP);
    cleanups.push(async () => { await fs.rm(snap.file, { force: true }); });
    // it recreated the container…
    expect(runner.calls.some((c) => c.command === 'docker' && c.args.includes('--force-recreate'))).toBe(true);
    // …and the compose file now declares the plugin
    const compose = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/NEO4J_PLUGINS/);
    expect(compose).toMatch(/apoc/);
  });

  it('snapshot still fails with guidance when the user declines the APOC enable', async () => {
    const { dir, cleanup } = await tmpDir();
    cleanups.push(cleanup);
    await writeFiles(dir, { 'docker-compose.yml': 'services:\n  graph:\n    image: neo4j:5\n' });
    const runner = new FakeRunner({ available: ['cypher-shell', 'docker'] });
    runner.on('cypher-shell', (_c, args) =>
      lastQuery(args) === 'RETURN apoc.version()' ? { code: 1, stderr: 'Unknown function' } : { stdout: '' },
    );
    const ctx = makeTestContext({
      config: { version: 1, workspace: 'keeper', container: { mode: 'compose', service: 'graph' }, database: { provider: 'neo4j', mode: 'snapshot', service: 'graph' } },
      runner,
      workspaceRoot: dir,
      env: { NEO4J_HOST: 'localhost' },
      prompter: new AutoPrompter({ answers: [{ match: 'NEO4J_PLUGINS', value: false }] }),
    }).providerCtx('database');
    await expect(new Neo4jProvider().snapshot(ctx, SNAP)).rejects.toThrow(/APOC/);
    expect(runner.calls.some((c) => c.command === 'docker')).toBe(false); // never recreated
  });

  it('authCheck fails when APOC is missing but connection works', async () => {
    const runner = new FakeRunner({ available: ['cypher-shell'] });
    runner.on('cypher-shell', (_c, args) => {
      const q = lastQuery(args);
      if (q === 'RETURN 1') return { stdout: '1' };
      return { code: 1, stderr: 'Unknown function apoc.version' };
    });
    const provider = new Neo4jProvider();
    const check = provider.requiredTools()[0]!.authCheck!;
    const res = await check(n4jCtx(runner, '/tmp', { NEO4J_HOST: 'localhost' }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/APOC/);
  });
});
