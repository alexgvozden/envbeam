# Cloudflare environments as an envbeam target — design & plan

> Status: exploratory design, promoted to a real feature initiative. Author notes for scoping.

## 1. The vision (what we're actually building)

> "I'm working on new development, I say **push to Cloudflare**, and it stands up a **whole
> environment** wired to my current dev setup so I can test remotely. I can **update** that
> environment or **deploy a new one**, **delete** ones I don't need, and get **notified about old
> environments I'm still paying for**. Use it to spin up an env from my current work, do remote
> development, or as a **target for a PR's automated tests**."

That is bigger than "another storage backend." It introduces a genuinely new first-class concept to
envbeam — the **Environment**: a named, addressable, remote, disposable instance of your workspace,
provisioned on Cloudflare from your current dev state, with a full **lifecycle** (create → update →
delete) and **cost governance**.

Everything below is designed to deliver exactly the three use cases you named:

- **U1 — Ephemeral remote dev/test env** from your current working tree ("push to Cloudflare").
- **U2 — Remote development** against a long-lived named environment you update over time.
- **U3 — Per-PR CI environment** that the pipeline spins up, tests against, and tears down.

---

## 2. Where this sits vs. what envbeam already does

Today `pull`/`resume` means *"get **this machine** ready."* The new capability is *"get a **remote
Cloudflare environment** ready, from my current state."* Mechanically that's:

**capture current state (like `pause`) → provision remote → hydrate remote (like `resume`, run
inside the container).**

We reuse the two existing pipelines rather than inventing new ones:

- `src/core/pipeline/pause.ts` already knows how to **capture**: snapshot the DB, encrypt + hash it,
  push it to a sync target, record the git commit + secrets manifest.
- `src/core/pipeline/resume.ts` already knows how to **hydrate**: fast-forward git, materialize
  secrets, restore the DB snapshot (`downloadAndRestore`, `resume.ts:512`), bring the container up.

The trick that keeps this tractable: **run envbeam itself inside the Cloudflare container** and let
it run `resume` there (the "agent-in-container" approach). The remote box simply *is* "this machine."
The local CLI's new job is **orchestration + lifecycle + registry**, not a rewrite of every provider
to be remote-aware.

---

## 3. Platform facts that shape the design (verified)

| Fact | Design consequence |
|---|---|
| **R2 is S3-compatible** object storage. | Reuse the existing S3 sync target for durable state. Snapshots + env registry live in R2. |
| **Cloudflare Containers run standard OCI/Docker images**, up to 4 vCPU / 12 GiB / 20 GB disk (custom types available). | Your app and DB images run as-is. No re-platforming of the app. |
| **Container disk is ephemeral** — sleeps → next start gets a fresh image disk. | **Do not** run a persistent DB volume. Run an *ephemeral* DB container and hydrate it from an R2 snapshot on start — which is *exactly* envbeam's pause/resume model. The platform's biggest limitation is the one envbeam already engineered around. |
| Containers are fronted by a **Worker + Durable Object**; a DO can hold small persistent state and address a specific instance. | The Worker is the env's front door / URL and router. The DO is where per-environment coordination + status hooks live. |
| **`sleepAfter`** scales an idle instance to zero; instances otherwise run indefinitely. | Idle envs get cheap automatically, but **scale-to-zero ≠ deleted** — you still pay for allocated/registered envs. This is *why* the "notify me about old envs" requirement exists, and we handle it in the registry (§7). |
| Managed durable DB alternatives: **D1** (SQLite), external Postgres via **Hyperdrive**. Neither runs Neo4j. | Default to ephemeral-container-DB-hydrated-from-R2 (works for Postgres *and* Neo4j). Offer managed DB as an opt-in later. |

Sources are listed at the end of §14.

---

## 4. Anatomy of one "environment" on Cloudflare

A single envbeam Environment deploys to this topology:

```
                    ┌─────────────────────────────────────────────┐
   env URL  ───────▶│  Worker (front door / router)               │
  *.workers.dev     │   - routes to app container                 │
  or custom route   │   - optional Cloudflare Access protection   │
                    │   - Cron trigger: self-report last-used/idle │
                    └───────────────┬─────────────────────────────┘
                                    │ (Durable Object bindings)
              ┌─────────────────────┼─────────────────────┐
              ▼                                             ▼
   ┌───────────────────────┐                   ┌───────────────────────┐
   │ App container         │  internal net     │ DB container          │
   │  - your dev image     │◀─────────────────▶│  - postgres / neo4j   │
   │  - envbeam agent runs │                   │  - EPHEMERAL disk      │
   │    `resume` on start  │                   │  - restored from R2    │
   │  - secrets injected   │                   │    snapshot on start   │
   └───────────────────────┘                   └───────────┬───────────┘
                                                            │
                                                     ┌──────▼───────┐
                                                     │ R2 bucket    │
                                                     │  - DB snap    │
                                                     │  - env state  │
                                                     └──────────────┘
```

State that must be **durable** lives in **R2** (encrypted, per envbeam's mandatory at-rest rule).
Everything in a container is disposable and re-derivable, which is what makes delete/recreate safe
and cheap.

> **Networking caveat (verified) — the diagram's app↔DB link is NOT docker-compose.** Cloudflare
> Containers have **no inbound raw TCP/UDP and no flat container-to-container network**; all ingress
> is proxied through a Worker as HTTP/WebSocket. A DB container *can* expose a TCP port
> (`getTcpPort()`) that a Worker/Durable Object reaches, and Workers can open *outbound* TCP via
> `connect()` — but there is no direct `app-container → db:5432` socket. So the **default topology is
> a single container running app + DB together** (they talk over `localhost`, which works fine
> in-container and is adequate for an ephemeral dev/test/PR env). The two-container split in the
> diagram is an **advanced mode** requiring a proxy sidecar (app's `localhost:5432` → Worker/DO →
> DB container's TCP port). See O5. Managed-DB alternatives (Hyperdrive/D1/external Aura) sidestep
> this entirely but aren't self-contained on Cloudflare and can't host Neo4j.

An **Environment record** (the unit the lifecycle operates on) is: a deployed Wrangler
project (Worker + container bindings) **+** its R2 state prefix **+** a registry entry (§6).

---

## 5. Foundations (must land first, described earlier — condensed)

These two are prerequisites; details/checklists in §13.

- **F1 — R2 sync target** (`target: 'r2'`). Durable store for snapshots and env state. Low risk;
  reuses `src/core/sync/s3.ts`. Inherits encryption + integrity for free.
- **F2 — Cloudflare Containers provider** (`container` provider `cloudflare`, shelling out to
  `wrangler`). Implements `up`/`down`/`status`. This is how a single container gets deployed; the
  environment orchestrator (F3) composes app + DB containers on top of it.

---

## 6. The new core concept — the Environment registry

This is the heart of the feature and the thing envbeam doesn't have today.

**Reuse the existing registry pattern.** envbeam already has an S3-backed *project* registry
(`src/core/registry/`). Add a sibling **environment registry** (same storage, R2/S3, same mandatory
encryption). It is the source of truth for lifecycle + cost governance.

**Per-environment record (stored, encrypted):**

```jsonc
{
  "id": "env_9f3a…",                 // stable id
  "name": "pr-123",                   // human/CI name, unique per project
  "project": "acme-api",
  "status": "running | sleeping | provisioning | error | deleted",
  "source": {
    "gitRemote": "…", "branch": "feature-x", "commit": "abc123",
    "dirty": false                    // was it pushed from an uncommitted tree?
  },
  "cloudflare": {
    "accountId": "…", "workerName": "…", "url": "https://pr-123-acme.…workers.dev",
    "instanceType": "standard-2", "containers": ["app", "db"]
  },
  "state": { "r2Prefix": "envs/pr-123/", "dbSnapshot": "…", "encrypt": "age" },
  "createdAt": "…", "lastDeployedAt": "…", "lastSeenActiveAt": "…",
  "createdBy": "alex",
  "ttl": "24h",                       // default; extended (reset from now) on every deploy
  "deleteAfter": "…",                 // absolute deadline the Worker cron enforces
  "cost": { "instanceType": "standard-2", "estMonthlyUsd": 14.2, "sinceUsd": 3.1 }
}
```

`lastSeenActiveAt` is what powers stale-env detection (§8) — updated by the Worker's Cron trigger
and/or on each request, written back to the DO/registry.

---

## 7. Command surface (the lifecycle)

A new `env` command group. Design goal: **idempotent create-or-update**, safe teardown, CI-friendly.

| Command | Purpose | Maps to your ask |
|---|---|---|
| `envbeam push --target cloudflare [--env NAME] [--ttl DURATION]` | Create **or update** an env from current dev state. Name/TTL resolved interactively if omitted (§7.1, §7.2). The headline verb. | "push to Cloudflare" (U1/U2) |
| `envbeam env create [NAME]` | Explicitly provision a **new** env (fails if name exists). | "deploy as a new one" |
| `envbeam env update NAME` | Redeploy an existing env with current state (new commit / new snapshot / re-materialized secrets). | "update existing environment" |
| `envbeam env list [--stale] [--json]` | List envs: age, last-active, status, instance type, **est. cost**, stale flag. | "delete old ones / notified I'm paying" |
| `envbeam env status NAME` | Detailed status + URL + live cost estimate. | remote dev visibility |
| `envbeam env url NAME` / `env logs NAME` | Convenience: print URL / stream logs. | remote dev / CI |
| `envbeam env delete NAME [--purge-state] [--yes]` | Teardown: scale-to-zero → delete Worker/containers → optionally purge R2 state → remove registry record. | "delete old environments" |
| `envbeam env gc [--older-than 7d] [--idle 48h] [--yes]` | Bulk-prune stale/idle envs. Non-interactive for CI/cron. | cost cleanup, "notify + reap" |

**Idempotency:** `push`/`create`/`update` share one provisioning engine; the only difference is the
"does this name already exist" policy. Re-running `push` for `pr-123` updates in place — critical for
CI re-runs and for U2 (iterating on a long-lived env).

**Non-interactive mode:** all of the above honor `--yes`/`--json` and the existing `Prompter`
abstraction so CI never hangs on a prompt. This is what makes U3 work.

### 7.1 Environment name resolution (interactive by default)

`push --target cloudflare` resolves the target name in this order:

1. **`--env NAME` given** → use it (create-or-update).
2. **Project has a default env set** (`environments.default` in `envbeam.yaml`, or a per-user pref) →
   use it silently. This is the "just push to my default" path.
3. **Neither** → **prompt** for a name, pre-filling a suggestion derived from the branch/PR
   (e.g. `feature-x` → `feature-x`). After a name is chosen, also ask: *"Make this the default env for
   this project?"* — if yes, persist `environments.default = NAME` so future bare `push` skips the
   prompt.
4. **`--yes`/CI with no name and no default** → hard error (never silently invent a paid env in CI);
   CI must pass `--env` explicitly (see §9).

`envbeam env default [NAME]` sets/clears/show the project default outside of a push.

### 7.2 Self-delete (TTL) resolution — 1 day default, extended on every deploy

Every environment carries a **self-delete timer, default `24h`**, so a forgotten env reaps itself.

- **Interactive:** on **first create**, prompt *"Auto-delete this environment after? [1 day]"* with
  `1 day` pre-selected; the user can pick longer (e.g. `3d`, `7d`) or `never` (with a "you'll keep
  paying" warning). `--ttl DURATION` skips the prompt.
- **Extended on every deploy:** each `push`/`update` to an existing env **resets the countdown** from
  now (so an env you're actively iterating on is never reaped mid-use). The clock only runs while the
  env is idle/untouched.
- **Enforced remotely:** the env's Worker Cron trigger checks the deadline and **self-deletes** when
  it passes — robust even if you never run the CLI again (this is what makes it a true safety net, not
  just a local reminder). `lastSeenActiveAt` + `ttl` together decide reaping.
- **CI:** PR envs pass an explicit short `--ttl` (e.g. `24h`) as a backstop for a missed teardown
  webhook (§9).

---

## 8. Cost governance & "you're paying for an old env" notifications

You explicitly asked to be *notified* about forgotten paid environments. Three layers, cheapest
first:

1. **Passive (always on).** `env list` and `env status` always show age, `lastSeenActiveAt`, and an
   **estimated cost** (instance type × running time; scale-to-zero periods cost less). `env list
   --stale` filters to environments past an idle/age threshold. `envbeam doctor` grows a check that
   warns when stale envs exist.
2. **Proactive local (opt-in).** A `env gc` you can wire to `/loop` or a scheduled agent, or a
   `postDeploy`/shell reminder, that surfaces stale envs and optionally reaps them. Threshold config
   in `envbeam.yaml` (`environments.staleAfter`, `environments.autoReap`).
3. **Proactive remote (opt-in, self-hosting).** Each deployed env's **Worker Cron trigger** updates
   `lastSeenActiveAt` and can enforce its own `ttl` — an env can **self-delete** after its TTL (ideal
   for PR envs) or ping a notification channel (email/Slack webhook) that it's still alive and
   billing. This makes cleanup robust even if you never run the CLI again.

Config knobs: `ttl` per env (**default `24h`**, extended on every deploy, `--ttl` or the create-time
prompt to change, `never` to opt out), account-wide `environments.defaultTtl`,
`environments.staleAfter`, `environments.autoReap`, `environments.maxConcurrent` (a safety cap so a
runaway CI can't spawn 200 paid envs).

---

## 9. CI / PR pipeline as a target (U3)

The end-to-end flow you want for "test a PR from the pipeline":

```yaml
# on: pull_request  (opened / synchronize)
- run: envbeam push --target cloudflare --env "pr-${{ github.event.number }}" --ttl 24h --yes --json
      # → idempotent create-or-update; prints { "url": "…" } for the test job to hit.
      #   --ttl is the backstop: even if the "closed" teardown below never fires, the env self-deletes.
- run: npm run e2e -- --base-url "$ENV_URL"        # tests run against the live remote env

# on: pull_request  (closed)
- run: envbeam env delete "pr-${{ github.event.number }}" --purge-state --yes
```

Requirements this drives into the design (all already listed above): deterministic naming, idempotent
push, `--json` machine output, `--yes` non-interactive, and a **safety net** (`ttl` + `env gc`) so a
missed "closed" webhook doesn't leak a paid env forever.

---

## 10. Provisioning flow (create / update, U1+U2)

`envbeam push --target cloudflare --env NAME`:

1. **Capture** current state — reuse `pause` logic: snapshot DB → encrypt + hash → upload to the
   env's R2 prefix; record git commit + secrets manifest. (If the tree is dirty, either commit-on-
   push to a scratch ref or refuse — see open question O3.)
2. **Resolve secrets** — read from the configured secrets provider (Doppler/1Password) and inject
   them into Cloudflare as **Worker/container secrets** (never committed, never in the image). New
   materialization target on `SecretsProvider` (or a Cloudflare-aware `materialize`).
3. **Generate/patch Wrangler config** — declare app + DB containers, bindings, routes, instance
   type, `sleepAfter`, optional Cloudflare Access. Template lives in the repo or is synthesized.
4. **Deploy** — `wrangler deploy` (create) or redeploy (update). Wait for readiness.
5. **Hydrate** — the app container boots the **envbeam agent**, which runs `resume` *inside*:
   fast-forward git, materialize secrets locally, restore the DB snapshot from R2 into the ephemeral
   DB container, run migrations, bring the app process up.
6. **Register** — write/update the environment record; compute URL + cost estimate.
7. **Report** — print URL (+ `--json`).

`env delete`: scale-to-zero → `wrangler delete` Worker + containers → optional R2 state purge →
registry record → `deleted`.

---

## 11. Config schema additions (`src/core/config/schema.ts`)

New optional `environments` (a.k.a. `cloudflare`) section, plus `'r2'` in the sync `target` enum:

```jsonc
environments: {
  provider: "cloudflare",
  cloudflare: {
    accountId: "…",
    route: "…workers.dev | custom",
    instanceType: "standard-2",
    sleepAfter: "10m",
    access: { enabled: true, policy: "…" }   // Cloudflare Access protection
  },
  db: { mode: "ephemeral-r2 | d1 | external-hyperdrive" },   // default ephemeral-r2
  naming: "pr-{pr} | {branch} | {custom}",
  default: null,             // per-project default env name; bare `push` targets it (§7.1)
  defaultTtl: "24h",         // self-delete default; each deploy resets the countdown (§7.2)
  staleAfter: "7d",
  autoReap: false,
  maxConcurrent: 10
}
```

Then `npm run schema:gen` to regenerate `schema/envbeam.schema.json`.

---

## 12. Phased delivery (each phase shippable; end-state = full vision)

| Phase | Delivers | Unlocks |
|---|---|---|
| **P1 — R2 sync target** | Durable encrypted state store on Cloudflare. | Foundation; "pull from Cloudflare" (storage). |
| **P2 — Cloudflare Containers provider** | Deploy a single container (app **or** DB) via `wrangler`; ephemeral DB hydrated from R2. | Compute foundation. |
| **P3 — Environment registry + lifecycle** | `env create/update/list/status/delete`, `push --target cloudflare`, provisioning engine (§10), agent-in-container hydrate. | **U1 + U2**: spin up / update / delete whole envs from current dev work. |
| **P4 — Cost governance** | Cost estimates, `env list --stale`, `doctor` check, TTL + `env gc`, Worker-cron self-report/self-delete. | "notify me about old paid envs," safe auto-cleanup. |
| **P5 — CI/PR target** | `--json`/`--yes` hardening, deterministic naming, GitHub Action recipe, teardown-on-close, `maxConcurrent` guard. | **U3**: PR pipeline as an automated-test target. |

P1–P2 are the foundations; **P3 is where your headline "push to Cloudflare, get a whole env" lands**;
P4 delivers the cost/notify ask; P5 delivers the CI-target ask.

---

## 13. File-change checklists

**P1 — sync target `r2`:** `src/core/sync/r2.ts` (new) · `sync/index.ts` (switch + tools) ·
`sync/types.ts` (kind union) · `config/schema.ts` (target enum + R2 fields) · `registry/types.ts`
(matching enum) · `config/explain.ts` · `pipeline/context.ts` + `providers/session/claudeNative.ts`
(credential preflight) · `commands/init.ts` (config comment) · tests · `npm run schema:gen`.

**P2 — container provider `cloudflare`:** `src/core/providers/container/cloudflare.ts` (new) ·
`providers/builtins.ts` (register factory) · `config/schema.ts` (`container.mode` enum + fields) ·
`detect/container.ts` (detect `wrangler.*` w/ `[[containers]]`) · `util/tools.ts` (`wrangler` install
metadata) · review Docker self-heal in `pipeline/resume.ts` (skip for Cloudflare) · tests · docs.

**P3 — environment lifecycle (the big one):**
- `src/core/environments/` (new module): registry (model on `src/core/registry/`), provisioning
  engine, Wrangler-config generator, agent-in-container bootstrap.
- `src/commands/env/` (new): `create.ts`, `update.ts`, `list.ts`, `status.ts`, `delete.ts`, `gc.ts`;
  plus `--target cloudflare` handling in `src/commands/push.ts` (`src/commands/pull.ts` for the
  reverse if we support "pull from an env").
- `src/cli.ts`: register the `env` command group + flags.
- `src/core/providers/secrets/*`: a Cloudflare secret-materialization target (inject into Worker/
  container secrets).
- `src/core/config/schema.ts`: `environments` section + `npm run schema:gen`.
- `pipeline/pause.ts` / `pipeline/resume.ts`: parameterize "capture to / hydrate from" so they can
  run against an env's R2 prefix and inside the container.
- Tests (FakeRunner for `wrangler`), docs, version bump, `planning/` PRD cross-link.

**P4 — cost governance:** `src/core/environments/cost.ts` (estimates) · `commands/env/list.ts`
(`--stale`) + `gc.ts` · `commands/doctor.ts` (stale-env check) · Worker template Cron trigger +
self-delete/notify · schema (`ttl`, `staleAfter`, `autoReap`, `maxConcurrent`).

**P5 — CI target:** `--json`/`--yes` across `env` commands · deterministic naming resolver ·
`maxConcurrent` guard · a `.github/workflows/` recipe in docs · teardown-on-close guidance.

---

## 14. Open questions & recommended defaults

- **O1 — DB durability model.** *Recommend:* ephemeral DB container hydrated from R2 snapshot
  (works for Postgres **and** Neo4j; matches envbeam's model). Offer D1/external-Hyperdrive later for
  users who want managed durability. **Decide before P2.**
- **O2 — Access protection.** Should env URLs be public `*.workers.dev` or gated behind Cloudflare
  Access by default? *Recommend:* Access-gated by default; `--public` to open. **P3.**
- **O3 — Dirty working tree.** Push from uncommitted changes: commit to a scratch ref, or refuse and
  require a commit? *Recommend:* push a scratch/`envbeam/env-<name>` ref so remote git stays honest;
  flag `dirty:true` in the record. **P3.**
- **O4 — Secret injection mechanism.** Worker secrets vs. container env vs. a secrets-store binding —
  which does Cloudflare best support for containers, and does it expose them the way the app expects
  (`.env` vs. real env vars)? *Needs a spike.* **Before P3.**
- **O5 — App↔DB topology (RESOLVED by spike).** Cloudflare has **no compose-style container-to-
  container TCP**: ingress is Worker-proxied HTTP/WebSocket, and cross-container DB access requires
  routing TCP through the Worker/DO layer (`getTcpPort()` on the DB container + `connect()` from the
  Worker) plus a proxy sidecar in the app container to preserve a normal `postgres://localhost` view.
  *Recommend:* **default to a single container running app + DB together** (localhost, trivially
  works, fine for ephemeral dev/test); offer the two-container + proxy split as an advanced mode, and
  managed DB (Hyperdrive/D1/external Aura — no Neo4j) as an opt-out. This makes the hydrate step
  write `postgres://localhost:5432` in the common case. **Decided; folds into P2/P3.**
- **O6 — Notification channel.** For proactive "old env" alerts: local `doctor`/`gc` only, or also a
  remote webhook (Slack/email) from the Worker cron? *Recommend:* ship local first (P4), remote
  webhook as a follow-up.
- **O7 — Cost estimation fidelity.** Cloudflare bills on active CPU/memory time, not wall-clock;
  scale-to-zero complicates estimates. *Recommend:* start with a coarse "instance-type × running
  hours" estimate labeled *approximate*, refine later against the billing API.

**Verified platform sources:**
[R2 / storage options](https://developers.cloudflare.com/workers/platform/storage-options/) ·
[Containers overview](https://developers.cloudflare.com/containers/) ·
[Limits & instance types](https://developers.cloudflare.com/containers/platform-details/limits/) ·
[Container lifecycle (ephemeral disk)](https://developers.cloudflare.com/containers/platform-details/architecture/) ·
[Containers 2025 announcement](https://blog.cloudflare.com/cloudflare-containers-coming-2025/) ·
[Higher container resource limits (2026 changelog)](https://developers.cloudflare.com/changelog/post/2026-02-25-higher-container-resource-limits/)
