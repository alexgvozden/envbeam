import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { ProviderFactory } from '../registry.js';
import { resolveComposeFile } from '../container/compose.js';
import type {
  DatabaseProvider,
  DbChangeResult,
  DbStatus,
  MigrateResult,
  ProviderContext,
  RestoreResult,
  SnapshotOptions,
  SnapshotResult,
  ToolRequirement,
} from '../types.js';
import { snapshotWorkDir } from './base.js';
import { runMigrateCommand } from './migrate.js';
import {
  resolveConnection,
  describeConnection,
  ambiguousUrlWarning,
  type DbConnectionParts,
} from './connection.js';
import { EnvbeamError } from '../../util/errors.js';

const PART_KEYS = {
  host: ['NEO4J_HOST', 'DB_HOST'],
  port: ['NEO4J_PORT', 'DB_PORT'],
  user: ['NEO4J_USERNAME', 'NEO4J_USER', 'DB_USER', 'DB_USERNAME'],
  password: ['NEO4J_PASSWORD', 'DB_PASSWORD'],
  database: ['NEO4J_DATABASE', 'NEO4J_DB', 'DB_NAME', 'DB_DATABASE'],
};

interface Neo4jConn {
  env: Record<string, string>;
  args: string[];
  database?: string;
  parts: DbConnectionParts;
}

/**
 * Build the `cypher-shell` connection: address via `-a`, user via `-u`, and the
 * password via `NEO4J_PASSWORD` in the environment so it never lands in argv
 * (and thus never in the process list) — the same discipline the mysql provider
 * uses for `MYSQL_PWD`.
 */
function conn(ctx: ProviderContext): Neo4jConn {
  const parts = resolveConnection(ctx, 'neo4j', PART_KEYS);
  const env: Record<string, string> = {};
  const args: string[] = [];

  const scheme = parts.url?.match(/^([a-z0-9+]+):\/\//i)?.[1] ?? 'neo4j';
  const address = parts.host
    ? `${scheme}://${parts.host}${parts.port ? ':' + parts.port : ''}`
    : undefined;
  if (address) args.push('-a', address);

  // Docker images take a combined NEO4J_AUTH=user/password; use it to fill any
  // gap the URL/parts didn't provide.
  let user = parts.user;
  let password = parts.password;
  const auth = ctx.env.NEO4J_AUTH;
  if ((!user || !password) && auth && auth.includes('/') && !/^(none|false)$/i.test(auth)) {
    const [u, ...rest] = auth.split('/');
    user ??= u || undefined;
    password ??= rest.join('/') || undefined;
  }
  if (user) args.push('-u', user);
  if (password) env.NEO4J_PASSWORD = password;

  return { env, args, database: parts.database, parts: { ...parts, user, password } };
}

async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dest));
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

/** First integer found across a `cypher-shell --format plain` result, skipping the header row. */
export function parseScalarInt(stdout: string): number {
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  }
  return 0;
}

/**
 * Recover the raw Cypher script from a `cypher-shell --format plain` result of
 * `... apoc.export.cypher.all(...) YIELD cypherStatements RETURN cypherStatements`.
 *
 * Plain format prints the `cypherStatements` column header, then the value. When
 * the value spans lines it is wrapped in double quotes with `"`/`\` escaped; a
 * single-row (unbatched) export is one such blob. We drop the header and unwrap.
 * The integration test round-trips a real container and is the source of truth
 * for this shape — adjust here if a server version formats it differently.
 */
export function extractCypherStatements(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  if (lines[0]?.trim() === 'cypherStatements') lines.shift();
  let body = lines.join('\n').trim();
  if (body.startsWith('"') && body.endsWith('"')) {
    body = body
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }
  body = body.trim();
  return body ? body + '\n' : '';
}

const EXPORT_QUERY =
  "CALL apoc.export.cypher.all(null, {stream:true, format:'cypher-shell', " +
  'batchSize:1000000, useOptimizations:{type:"UNWIND_BATCH", unwindBatchSize:1000}}) ' +
  'YIELD cypherStatements RETURN cypherStatements';

export class Neo4jProvider implements DatabaseProvider {
  readonly name = 'neo4j';
  readonly kind = 'database' as const;

  requiredTools(): ToolRequirement[] {
    return [
      {
        command: 'cypher-shell',
        versionArgs: ['--version'],
        installHint: 'Install the Neo4j client (cypher-shell); snapshots also need the APOC plugin enabled on the server.',
        authCheck: async (ctx) => {
          const ping = await this.cypher(ctx, 'RETURN 1', { allowFailure: true });
          if (ping.code !== 0) return { ok: false, detail: 'cannot connect to neo4j' };
          const apoc = await this.cypher(ctx, 'RETURN apoc.version()', { allowFailure: true });
          return apoc.code === 0
            ? { ok: true }
            : { ok: false, detail: 'APOC plugin not enabled on the server (needed for snapshot/restore)' };
        },
      },
    ];
  }

  /** Run a Cypher statement, returning the raw `--format plain` stdout. */
  protected async cypher(
    ctx: ProviderContext,
    query: string,
    opts: { allowFailure?: boolean } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const c = conn(ctx);
    return ctx.runner.run(
      'cypher-shell',
      [...c.args, ...(c.database ? ['-d', c.database] : []), '--format', 'plain', query],
      { env: c.env, allowFailure: opts.allowFailure },
    );
  }

  protected async ping(ctx: ProviderContext): Promise<boolean> {
    const res = await this.cypher(ctx, 'RETURN 1', { allowFailure: true });
    return res.code === 0;
  }

  protected async apocReady(ctx: ProviderContext): Promise<boolean> {
    const res = await this.cypher(ctx, 'RETURN apoc.version()', { allowFailure: true });
    return res.code === 0;
  }

  /**
   * APOC is required for logical export/import. Verify it; when it's absent and
   * envbeam owns the Neo4j compose container, offer to enable it (edit the
   * compose file + recreate — confirmed with the user). Otherwise fail with
   * concrete, dev-oriented guidance rather than dead-ending.
   */
  protected async requireApoc(ctx: ProviderContext): Promise<void> {
    if (await this.apocReady(ctx)) return;
    if (await this.tryEnableApocViaCompose(ctx)) return;
    throw new EnvbeamError('Neo4j APOC plugin is not enabled on the server.', {
      exitCode: 2,
      hint:
        'Enable APOC (dev): on Docker set NEO4J_PLUGINS=\'["apoc"]\' and recreate the container; ' +
        'on a self-managed server drop the APOC Core jar into plugins/ and restart. Neo4j Aura has it built in.',
    });
  }

  /**
   * When the workspace runs Neo4j as a compose service envbeam controls, enable
   * APOC for the user: add `NEO4J_PLUGINS=["apoc"]` to that service and recreate
   * the container. Every mutating action is confirmed first. Returns true once
   * APOC answers. Recreating a container can drop data not held in a named
   * volume, so the prompt says so.
   */
  protected async tryEnableApocViaCompose(ctx: ProviderContext): Promise<boolean> {
    if (ctx.dryRun) return false;
    if (ctx.config.container?.mode !== 'compose') return false;
    const service = ctx.config.database?.service ?? ctx.config.container?.service;
    if (!service) return false;
    let file: string;
    try {
      file = await resolveComposeFile(ctx);
    } catch {
      return false;
    }
    const rel = path.relative(ctx.workspaceRoot, file) || file;

    ctx.logger.warn(`Neo4j APOC plugin is not enabled on compose service '${service}'.`);
    const ok = await ctx.prompter.confirm(
      `Add NEO4J_PLUGINS=["apoc"] to ${rel} and recreate '${service}'? ` +
        `(recreates the container; data not in a named volume is lost)`,
      true,
    );
    if (!ok) return false;

    const edited = await addNeo4jPluginsToCompose(file, service);
    ctx.logger.sub(edited ? `enabled APOC in ${rel}` : `${rel} already declares NEO4J_PLUGINS — recreating '${service}'`);
    await ctx.runner.run('docker', ['compose', '-f', file, 'up', '-d', '--force-recreate', service], {
      cwd: ctx.workspaceRoot,
      allowFailure: true,
    });

    // Wait for the recreated container to accept connections with APOC loaded.
    const startedAt = Date.now();
    for (;;) {
      if (await this.apocReady(ctx)) {
        ctx.logger.sub('APOC is now enabled');
        return true;
      }
      if (Date.now() - startedAt >= 60_000) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    ctx.logger.warn(`recreated '${service}' but APOC did not come up within 60s`);
    return false;
  }

  connectionSummary(ctx: ProviderContext): string {
    const parts = conn(ctx).parts;
    return describeConnection({ ...parts, database: parts.database ?? 'neo4j' });
  }

  ambiguityWarning(ctx: ProviderContext): string | null {
    return ambiguousUrlWarning(ctx.env, 'neo4j', resolveConnection(ctx, 'neo4j', PART_KEYS).sourceKey);
  }

  /** Watched labels (the graph analog of change-tables): concrete names only. */
  private changeLabels(ctx: ProviderContext): string[] {
    const db = ctx.config.database;
    const source = db?.changeTables?.length ? db.changeTables : [];
    return source.filter((l) => !l.includes('*'));
  }

  async hasChanged(ctx: ProviderContext, sinceFingerprint?: string): Promise<DbChangeResult> {
    if (!(await this.ping(ctx))) {
      return { changed: false, detail: 'database not reachable (is it up, and is cypher-shell installed?)' };
    }
    const parts: string[] = [];

    const labels = this.changeLabels(ctx);
    for (const l of labels) {
      try {
        const out = await this.cypher(ctx, `MATCH (n:${quoteLabel(l)}) RETURN count(n)`);
        parts.push(`${l}:${parseScalarInt(out.stdout)}`);
      } catch {
        parts.push(`${l}:err`);
      }
    }

    let nodes = 0;
    let rels = 0;
    let haveOverview = false;
    try {
      nodes = parseScalarInt((await this.cypher(ctx, 'MATCH (n) RETURN count(n)')).stdout);
      rels = parseScalarInt((await this.cypher(ctx, 'MATCH ()-[r]->() RETURN count(r)')).stdout);
      haveOverview = true;
    } catch {
      haveOverview = false;
    }
    // Whole-graph counts are the zero-config fallback; keep them out of the
    // fingerprint when the user pinned specific labels (exact per-label counts
    // are the stable signal, mirroring the SQL providers' change-table logic).
    if (haveOverview && labels.length === 0) {
      parts.push(`nodes:${nodes}`, `rels:${rels}`);
    }

    if (parts.length === 0) {
      return { changed: false, detail: 'no readable change signal (no counts, no change labels)' };
    }

    const fingerprint = createHash('sha1').update(parts.join('|')).digest('hex');
    const changed = sinceFingerprint != null && sinceFingerprint !== fingerprint;
    const summary = haveOverview
      ? `~${nodes.toLocaleString('en-US')} node(s), ~${rels.toLocaleString('en-US')} rel(s)`
      : `${labels.length} tracked label(s)`;
    return {
      changed: sinceFingerprint == null ? false : changed,
      fingerprint,
      detail:
        sinceFingerprint == null
          ? `baseline: ${summary}`
          : changed
            ? `data changed → ${summary}`
            : `no data changes (${summary})`,
    };
  }

  async snapshot(ctx: ProviderContext, opts: SnapshotOptions): Promise<SnapshotResult> {
    const dir = await snapshotWorkDir();
    const ext = opts.compress ? 'cypher.gz' : 'cypher';
    const base = `${ctx.config.workspace}__${opts.timestamp}__${opts.machine}.${ext}`;
    const file = path.join(dir, base);
    if (ctx.dryRun) {
      ctx.logger.sub(`would export graph → ${base}`);
      return { file, sizeBytes: 0 };
    }
    await this.requireApoc(ctx);

    const res = await this.cypher(ctx, EXPORT_QUERY);
    const script = extractCypherStatements(res.stdout);
    if (opts.compress) {
      const plain = file.replace(/\.gz$/, '');
      await fs.writeFile(plain, script, 'utf8');
      await gzipFile(plain, file);
      await fs.rm(plain, { force: true });
    } else {
      await fs.writeFile(file, script, 'utf8');
    }

    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.stat(file)).size;
    } catch {
      /* ignore */
    }
    return { file, sizeBytes };
  }

  async restore(ctx: ProviderContext, snapshotFile: string): Promise<RestoreResult> {
    if (ctx.dryRun) {
      ctx.logger.sub(`would restore graph from ${path.basename(snapshotFile)}`);
      return { restored: false, detail: 'dry-run' };
    }
    await this.requireApoc(ctx);

    let scriptFile = snapshotFile;
    let temp: string | undefined;
    if (snapshotFile.endsWith('.gz')) {
      temp = snapshotFile.replace(/\.gz$/, '.restore.cypher');
      await gunzipFile(snapshotFile, temp);
      scriptFile = temp;
    }
    try {
      // The export contains CREATE/constraint statements, so replaying it onto a
      // populated graph would duplicate everything. "Restore this snapshot" has
      // to mean the graph ends up holding exactly what the snapshot holds — so
      // empty it first (nodes+rels, then indexes/constraints), exactly as the
      // SQL providers truncate before a data-only restore.
      await this.cypher(ctx, 'MATCH (n) DETACH DELETE n');
      await this.cypher(ctx, 'CALL apoc.schema.assert({}, {}, true)', { allowFailure: true });

      const c = conn(ctx);
      // cypher-shell aborts on the first error and exits non-zero (like the mysql
      // client), so a failed restore is never mis-reported as a success.
      await ctx.runner.run(
        'cypher-shell',
        [...c.args, ...(c.database ? ['-d', c.database] : []), '--file', scriptFile],
        { env: c.env },
      );
    } finally {
      if (temp) await fs.rm(temp, { force: true });
    }
    return { restored: true, detail: `restored ${path.basename(snapshotFile)}` };
  }

  async migrate(ctx: ProviderContext): Promise<MigrateResult> {
    return runMigrateCommand(ctx);
  }

  async status(ctx: ProviderContext): Promise<DbStatus> {
    const reachable = await this.ping(ctx);
    return {
      reachable,
      pendingMigrations: 'unknown',
      detail: reachable ? 'neo4j reachable' : 'neo4j not reachable',
    };
  }
}

/** Backtick-quote a label, doubling any backtick inside it (Cypher escaping). */
function quoteLabel(label: string): string {
  return `\`${label.replace(/`/g, '``')}\``;
}

const APOC_PLUGINS_VALUE = '["apoc"]';

/**
 * Add `NEO4J_PLUGINS=["apoc"]` to a service's `environment` in a compose file,
 * preserving the file's formatting and comments (edits a parsed Document, not
 * text). Handles both env shapes — a map (`KEY: value`) and a sequence
 * (`- KEY=value`) — and is idempotent (returns false when NEO4J_PLUGINS is
 * already declared, or when the service can't be found).
 */
export async function addNeo4jPluginsToCompose(file: string, service: string): Promise<boolean> {
  const doc = YAML.parseDocument(await fs.readFile(file, 'utf8'));
  if (doc.getIn(['services', service]) == null) return false;

  const envPath = ['services', service, 'environment'];
  const env = doc.getIn(envPath);

  if (env == null) {
    doc.setIn([...envPath, 'NEO4J_PLUGINS'], APOC_PLUGINS_VALUE);
  } else if (YAML.isMap(env)) {
    if (env.has('NEO4J_PLUGINS')) return false;
    doc.setIn([...envPath, 'NEO4J_PLUGINS'], APOC_PLUGINS_VALUE);
  } else if (YAML.isSeq(env)) {
    const already = env.items.some((it) => {
      const v = YAML.isScalar(it) ? it.value : it;
      return typeof v === 'string' && /^NEO4J_PLUGINS\s*=/.test(v);
    });
    if (already) return false;
    env.add(`NEO4J_PLUGINS=${APOC_PLUGINS_VALUE}`);
  } else {
    return false;
  }

  await fs.writeFile(file, doc.toString(), 'utf8');
  return true;
}

export const neo4jProviderFactory: ProviderFactory<DatabaseProvider> = {
  kind: 'database',
  name: 'neo4j',
  identityType: 'database',
  create: () => new Neo4jProvider(),
};
