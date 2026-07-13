# Plan — Neo4j database provider

Status: **IMPLEMENTED** in v0.27.0 (MINOR — new provider). (The version line originally read v0.19.0
from a stale DEVELOPMENT.md header; the repo was actually at 0.26.0, so the bump landed at 0.27.0.)

Add a `neo4j` provider to the `database` kind, sitting alongside `postgres` and `mysql`. It lets
`envbeam pause/push` snapshot a Neo4j graph and `resume/pull` restore it on another machine, with the
same change-detection / divergence guarantees the SQL providers already have.

---

## 1. Why Neo4j does not extend `SqlDatabaseProvider`

`SqlDatabaseProvider` (`src/core/providers/database/base.ts`) is built around SQL primitives its
subclasses must supply: `runSql`, `changeProbeSql(table)`, `databaseOverview` via
`information_schema`/`pg_stat`, and dump files that are SQL text. Neo4j is a labelled-property graph
with Cypher, no `information_schema`, and no `pg_dump` equivalent that streams over a client
connection on Community edition.

**Decision:** implement the `DatabaseProvider` interface (`types.ts:263`) **directly**, reusing the
already-exported free helpers from `base.ts` — `snapshotWorkDir()`, `formatBytes()`, `machineName()`
— and `runMigrateCommand()` from `migrate.ts`. This keeps the blast radius off the SQL base class.
The dry-run / file-naming / `fs.stat` scaffolding in `SqlDatabaseProvider.snapshot`/`restore` is ~15
lines; we duplicate it rather than widen the SQL base (a shared non-SQL base is not worth it for one
provider — revisit if a second graph/document provider lands).

## 2. Dump / restore strategy — the key decision

Two candidate mechanisms:

| Approach | Tool | Online? | Community? | Fits envbeam's connection model? |
|---|---|---|---|---|
| **A. APOC logical export (chosen)** | `cypher-shell` | ✅ yes | ✅ yes | ✅ pure bolt connection, like `psql` |
| B. `neo4j-admin database dump`/`load` | `neo4j-admin` | ❌ DB must be stopped | ✅ | ❌ needs local data dir + stop the server |

**Chosen: A.** `neo4j-admin dump` produces the highest-fidelity binary `.dump`, but it requires the
database to be **offline** and the command to run **on the box holding the data files** — envbeam
talks to databases over a connection (possibly a container/remote host), exactly the constraint that
made B wrong for the SQL providers too. APOC's streaming export runs entirely over the bolt
connection, mirroring how `postgres`/`mysql` shell out to `psql`/`mysql`.

**Dump.** Stream Cypher statements back over the connection (no server-side file, no
`apoc.export.file.enabled` needed):

```
CALL apoc.export.cypher.all(null, {stream:true, format:'cypher-shell',
  useOptimizations:{type:'UNWIND_BATCH', unwindBatchSize:1000}})
YIELD cypherStatements RETURN cypherStatements;
```

We capture `cypher-shell`'s stdout to the snapshot file. Extension: `.cypher` (or `.cypher.gz` with
`compress`, reusing the same gzip stream helpers `mysql.ts` uses).

**Restore.** Neo4j has no "data-only" concept, and the export contains `CREATE`/constraint
statements — replaying it onto a populated graph **duplicates** everything. To honour envbeam's
invariant that *"restore this snapshot" means the DB ends up holding exactly what the snapshot holds*
(the same reasoning documented in `postgres.ts`/`mysql.ts` restore), we **empty the graph first**:

```
MATCH (n) DETACH DELETE n;   // in batches via apoc.periodic.iterate for large graphs
CALL apoc.schema.assert({}, {});   // drop existing constraints/indexes the dump will recreate
```

then pipe the snapshot file into `cypher-shell`. cypher-shell aborts on the first error and exits
non-zero (like `mysql`, unlike bare `psql`), so a failed restore is never mis-reported as success.

**APOC dependency — decided: APOC-only, and envbeam provisions it as far as it can reach.** No
no-APOC fallback in v1. APOC is a hard requirement of this provider and is auto-provisioned per the
repo's "install missing tools / self-heal prerequisites, never dead-end" rules — but provisioning
splits cleanly by *who owns the Neo4j server*, because APOC is a **server-side plugin**, not a client
CLI:

| Piece | What it is | Auto-provisioning |
|---|---|---|
| `cypher-shell` | client CLI | **Auto-install** via existing `ensureTool`/`TOOLS` (§5b), exactly like `pg_dump`/`mysql`. |
| APOC plugin | Neo4j **server** plugin | Depends on who runs the server (below). |

**Baseline assumption (dev environment):** envbeam runs against a **development** Neo4j the user
controls, so we can generally reach the server to enable APOC — directly (compose container / local
install) or by asking the user to grant access. We never silently fail for want of APOC; we escalate
through the ladder below, ending in a concrete "here's how" rather than a dead-end.

APOC provisioning ladder (first that applies wins):
1. **Already present** — `authCheck` runs `RETURN apoc.version()`; if it answers, done.
2. **envbeam owns the container** (`database.service` resolves to a compose service on a `neo4j`
   image): auto-enable — inject `NEO4J_PLUGINS=["apoc"]` (Neo4j 5) into the service env and recreate
   the container on the next `up`. True "install it for the user." *(Touches the compose provider's
   `up`; scoped as §9.6 so the core provider can ship first.)*
3. **Neo4j Aura / managed** — APOC **Core** ships built-in; nothing to do.
4. **Server envbeam doesn't yet control** — since this is a dev box, *ask*: on an interactive
   terminal, prompt to run the enable step (e.g. drop the APOC Core jar into the server's `plugins/`
   or set `NEO4J_PLUGINS`, then restart), performing it when the user grants access; non-interactively
   or if declined, print the exact copy-pasteable command and the docs link. Guides, never dead-ends —
   consistent with the repo's self-heal-prerequisites rule.

## 3. Change detection

Whole-graph overview (the zero-config fallback, analogous to size+rows):

```
MATCH (n) RETURN count(n);              // node count
MATCH ()-[r]->() RETURN count(r);       // relationship count
```

Fingerprint = `sha1("nodes:<n>|rels:<r>")`. `DbOverview.sizeBytes` has no cheap exact analog; report
`0`/omit and summarise as "~N nodes, ~M rels" instead of bytes (adjust the `hasChanged` summary
accordingly, or reuse `store sizes` from `apoc.meta.stats()` if available).

Optional pinned signal (the `changeTables` analog): treat configured entries as **labels** and probe
`MATCH (n:`Label`) RETURN count(n)`. Reuse the existing `database.changeTables` config field (rename
in docs to "tables/labels") to avoid a schema change.

## 4. Connection resolution (`connection.ts` changes)

Extend the existing resolver rather than fork it:

- `DbEngine` union → add `'neo4j'`.
- `SCHEME_BY_ENGINE.neo4j = /^(neo4j|bolt)(\+s(sc)?)?:\/\//i` (covers `bolt://`, `neo4j://`,
  `neo4j+s://`, `neo4j+ssc://`, `bolt+s://`).
- `URL_KEYS_BY_ENGINE.neo4j = ['NEO4J_URI', 'NEO4J_URL', 'NEO4J_BOLT_URL']`.
- Part keys for `neo4j.ts`:
  - host `['NEO4J_HOST','DB_HOST']`, port `['NEO4J_PORT','DB_PORT']` (default 7687),
  - user `['NEO4J_USERNAME','NEO4J_USER','DB_USER']`, password `['NEO4J_PASSWORD','DB_PASSWORD']`,
  - database `['NEO4J_DATABASE','NEO4J_DB','DB_NAME']` (default `neo4j`).
- Handle Docker's combined `NEO4J_AUTH=neo4j/password` form (split on `/`) as a fallback source.

`cypher-shell` invocation: `-a <uri> -u <user> -d <database>`, **password via `NEO4J_PASSWORD` env**
(never in argv, so it stays out of the process list — same discipline as `mysql`'s `MYSQL_PWD`),
`--format plain` for query output. `parseDbUrl` already tolerates dotted hosts and no path segment,
so a `neo4j://host:7687` URL parses to `{host, port}` with `database` undefined → default to `neo4j`.

`findDatabaseUrls`/`ambiguousUrlWarning` widen to include neo4j so a workspace with two bolt URLs
warns just like two postgres URLs.

## 5. Provider skeleton (`src/core/providers/database/neo4j.ts`)

```ts
export class Neo4jProvider implements DatabaseProvider {
  readonly name = 'neo4j';
  readonly kind = 'database' as const;

  requiredTools(): ToolRequirement[] {
    return [{
      command: 'cypher-shell',
      versionArgs: ['--version'],
      installHint: 'Install Neo4j client tools (cypher-shell), and enable the APOC plugin.',
      authCheck: async (ctx) => {           // verify connect AND apoc present
        const ping = await this.query(ctx, 'RETURN 1', { allowFailure: true });
        if (ping.code !== 0) return { ok: false, detail: 'cannot connect to neo4j' };
        const apoc = await this.query(ctx, 'RETURN apoc.version()', { allowFailure: true });
        return apoc.code === 0 ? { ok: true }
          : { ok: false, detail: 'APOC plugin not installed (needed for snapshots)' };
      },
    }];
  }

  connectionSummary(ctx) { /* describeConnection(parts) */ }
  ambiguityWarning(ctx) { /* ambiguousUrlWarning(env, 'neo4j', sourceKey) */ }
  async hasChanged(ctx, since) { /* §3 */ }
  async snapshot(ctx, opts) { /* §2 dump; dry-run + fs.stat scaffolding */ }
  async restore(ctx, file) { /* §2 empty-then-replay */ }
  async migrate(ctx) { return runMigrateCommand(ctx); }   // generic, config-driven
  async status(ctx) { /* reachable via RETURN 1 */ }
}
export const neo4jProviderFactory: ProviderFactory<DatabaseProvider> = {
  kind: 'database', name: 'neo4j', identityType: 'database', create: () => new Neo4jProvider(),
};
```

## 5b. Tool provisioning (`util/tools.ts`)

Add a `cypher-shell` entry to `TOOLS` so `ensureTools(['cypher-shell'], …)` auto-installs it on the
push/pull path and via `doctor`, matching how `pg_dump`/`mysql` are handled:

```ts
'cypher-shell': {
  command: 'cypher-shell',
  name: 'Neo4j client (cypher-shell)',
  installCommands: {
    win32: 'winget install Neo4j.Neo4j',           // ships cypher-shell
    darwin: 'brew install cypher-shell',
    linux: 'sudo apt-get install -y cypher-shell || sudo dnf install -y cypher-shell',
  },
  checkArgs: ['--version'],
  url: 'https://neo4j.com/docs/operations-manual/current/cypher-shell/',
},
```

> ⚠️ **Verify the install recipes on a real machine before shipping** — `cypher-shell` is not in
> every distro's default repos (it lives in Neo4j's apt/yum repo). If `brew install cypher-shell` /
> the apt package is unavailable, fall back to `brew install neo4j` (bundles cypher-shell) and, on
> Linux, adding Neo4j's package repo first. This is the one recipe I can't confirm from the
> repo alone; I'll test it during implementation and adjust.

**No new pipeline code needed.** `pause.ts:306` and `resume.ts:85` already iterate the active DB
provider's `requiredTools()` and pass any missing commands to `ensureTools`. So once
`Neo4jProvider.requiredTools()` returns `{command:'cypher-shell', …}` **and** `TOOLS` has the entry
above, `cypher-shell` is auto-installed on the push/pull path for free.

## 6. Wiring (small, mechanical)

1. `builtins.ts` — import + push `neo4jProviderFactory` into `BUILTIN_FACTORIES`.
2. `pipeline/providers.ts:36` — no change (already `registry.create('database', config.database.provider)`).
3. `config/schema.ts:121` — update the `provider` description to `postgres | mysql | neo4j`; broaden
   the `changeTables` description to "tables/labels". No structural schema change → but still run
   `npm run schema:gen` and `npm install --package-lock-only`.
4. `detect/database.ts` — add detection:
   - `ENGINE_IMAGE_PATTERNS`: `{ re: /(^|\/)neo4j(:|$)/i, engine: 'neo4j' }`.
   - service-name heuristic: `/neo4j|graphdb/`.
   - `detectEngineFromConfig`: `.env` with `NEO4J_URI=` or a `bolt://`/`neo4j://` `DATABASE_URL`.
   - widen the local `EngineMatch.engine` / `ENGINE_IMAGE_PATTERNS` unions to include `'neo4j'`.
   - migrate-command detection: none for v1 (Neo4j has no dominant migration tool); users set
     `database.migrateCommand` explicitly if they use e.g. `neo4j-migrations`.

## 7. Tests

**Unit — `test/unit/database.test.ts` (extend) or `neo4j.test.ts` (new):** drive `Neo4jProvider`
through `FakeRunner`, scripting `cypher-shell` responses:
- connection resolution: `NEO4J_URI=neo4j://u:p@host:7687`, `NEO4J_AUTH` split, part assembly,
  `bolt+s://` scheme, ambiguity warning with two bolt URLs.
- `hasChanged`: baseline (no prior fingerprint → `changed:false`), then changed node/rel counts →
  `changed:true`; unreachable → graceful `changed:false` with detail.
- `snapshot`: asserts the `apoc.export.cypher.all(... stream:true ...)` call and that stdout lands in
  the `.cypher` file; `compress` → gzipped `.cypher.gz`; dry-run emits no run.
- `restore`: asserts the `DETACH DELETE` + `apoc.schema.assert` empty step **precedes** the replay,
  and gzip inputs are gunzipped to a temp file that is cleaned up.
- `requiredTools`/`authCheck`: APOC-missing path returns `{ok:false}`.

**Integration — `test/integration/neo4j.integration.test.ts` (new, skip-if-absent):** mirror
`postgres.integration.test.ts`. Skip unless Docker + `cypher-shell` are present. Boot
`neo4j:5-community` with `NEO4J_AUTH=neo4j/testpassword` and `NEO4J_PLUGINS='["apoc"]'`, wait for
bolt, seed a small graph, `snapshot` → wipe → `restore`, assert node/rel counts round-trip. Derive
the image tag from an env override (`NEO4J_TEST_IMAGE`) like the PG test does.

## 8. Docs & release

- `CHANGELOG.md` → new `## [0.19.0]` with `### Added` — Neo4j database provider.
- `package.json` version bump to `0.19.0`; `npm install --package-lock-only`.
- `README.md` provider list + a Neo4j config example.
- `DEVELOPMENT.md` provider line, and a "gotchas" note (APOC requirement; `DETACH DELETE`
  replace-semantics; password via env not argv).
- `npm run schema:gen`, `npm run typecheck`, `npm test`, `npm run build` all green.

## 9. Risks / open questions for review

1. ~~APOC-only vs. a no-APOC fallback~~ **Decided (§2): APOC-only.** envbeam auto-installs
   `cypher-shell`, auto-enables APOC when it owns the compose container, and otherwise guides. The
   compose-side APOC auto-enable (§9.6) is the one piece that may slip to a follow-up so the core
   provider ships first.
2. **Fidelity:** `apoc.export.cypher.all` preserves nodes, relationships, properties, constraints,
   indexes — but not internal element ids or fine-grained index config. Acceptable for dev-data sync;
   call it out in docs.
3. **Large graphs:** `DETACH DELETE n` in one statement can OOM; use `apoc.periodic.iterate` batched
   delete. Reuse `snapshot.maxSizeMB` as the size guard on the produced `.cypher`.
4. **Multi-database (Neo4j 4+):** we target one database (default `neo4j`); the `system` db is never
   touched. Ambiguity warning covers multiple bolt URLs, not multiple databases behind one URL.
5. **`neo4j-admin dump` interop:** out of scope for v1; note it as a future high-fidelity option if a
   user controls the server box.
6. **Compose-side APOC auto-enable — DECIDED: bundled into v0.19.0, and every mutating action is
   confirmed with the user first.** Injecting `NEO4J_PLUGINS=["apoc"]` into a detected compose `neo4j`
   service and recreating the container touches the compose provider's `up`. It ships in this release.
   Because recreating a container is destructive to its ephemeral state, envbeam **prompts before
   acting** — "APOC isn't enabled on service `neo4j`; add NEO4J_PLUGINS and recreate the container?
   [y/N]" — performs it only on consent, and on an interactive TTY defaults per the repo's prompt
   convention; non-interactively it prints the exact change and skips (never silently mutates infra).

## 10. Execution order (once approved)

1. `connection.ts` (engine union, schemes, URL/part keys, `NEO4J_AUTH`) + its unit tests.
2. `util/tools.ts` — add the `cypher-shell` entry (§5b); verify install recipe on this machine.
3. `neo4j.ts` provider + unit tests (FakeRunner) — iterate to green.
4. `builtins.ts`, `schema.ts` desc, `detect/database.ts` + detection unit tests.
5. `schema:gen`, integration test, full `typecheck`/`test`/`build`.
6. Docs + version bump + changelog. Commit as `feat: add Neo4j database provider`.
7. (Optional / review) compose-side APOC auto-enable (§9.6) — separate commit or follow-up.
</content>
</invoke>
