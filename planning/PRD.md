# envbeam — Product Requirements Document

> **Name:** `envbeam` (repo + CLI binary). Styled **`env.beam`** in logo/wordmark only — beam your whole dev environment to any machine or VM. Config file: `.envbeam.yaml`.

**Version:** 0.3 (MVP)
**Owner:** Alex Gvozden
**Status:** Draft for build
**Target build environment:** Claude Code

---

## 1. Problem

Working on the same codebase across multiple personal machines (laptop + desktop) means manually repeating the same ritual on every switch: pull git, re-sync environment variables, rebuild the dev container, restore local database state, and lose the Claude Code session context. None of these are hard individually, but doing them by hand on every switch is error-prone (forgetting to push uncommitted work, drifting secrets, a database that's migrated on one machine but not the other, mismatched container state) and breaks flow.

It's also not one identity. The same person juggles multiple accounts per tool — a company GitHub and a personal one, a company 1Password vault and a personal one — so "which account" is part of the context that must travel with the workspace, not a global default.

There is no single tool that treats "my working context" — code + secrets + environment + **database state** + AI session, under **the right account for each** — as one portable unit you can pause on one machine and resume on another.

## 2. Goal

A single local CLI, `envbeam`, that orchestrates the existing best-in-class tools (git, a secrets manager, Dev Containers, Claude Code session sync) behind two primary verbs:

- `envbeam resume` — get this machine fully ready to work where I left off.
- `envbeam pause` — safely hand off so I can switch to another machine.

Everything runs **locally**. No cloud-hosted dev environment. The tool is an orchestrator, not a replacement for the underlying tools.

## 3. Non-goals (MVP)

- Not building a new secrets store, container runtime, or sync backend — only orchestrating existing ones.
- Not a cloud/remote dev environment (explicitly rejected; work stays on the user's own hardware).
- Not a GUI. CLI only for MVP.
- Not multi-user / team features (single user, multiple machines).
- Not responsible for provisioning a machine from scratch (dotfiles, OS packages) — that is delegated, not owned.

## 4. Users & context

Primary (and only) user: a developer running the same set of repos across 2+ personal machines (e.g. macOS laptop + Linux/Windows desktop). Comfortable in the terminal. Uses Docker, a secrets manager, git, and Claude Code. Stacks in play include .NET, Node, and Flutter, so the tool must be stack-agnostic and drive everything through the project's Dev Container rather than assuming a language.

## 5. Core concepts

### Detection-first

`envbeam` infers as much as possible from the repo and the machine, and only asks you to declare what it genuinely can't know. Most fields in `.envbeam.yaml` are optional: if absent, they're auto-detected at run time; if present, they override the guess. The config file's real job is to hold (a) identity selections and (b) a few choices that aren't inferable (e.g. snapshot vs migrations-only, which sync target). `doctor` is the surface for this: it reports what was detected, what's ambiguous, and what's missing, and can write just those gaps into the config on request.

Detection sources:

| Field | Detected from |
|---|---|
| git remote, branch | `.git/config`, current checkout |
| git identity (which key/account) | `~/.ssh/config` host alias, remote URL |
| container mode + services | `.devcontainer/`, `docker-compose.yml` |
| database engine + service | compose service images, ORM/connection config |
| migrate command | stack markers (.NET EF, Prisma/Knex, etc.) |
| candidate secrets keys | `.env.example` (names only, never values) |

What still must be declared: which **identity** to use per concern (the machine can't reliably guess work vs personal), the database **mode** and **sync target**, and any deliberate override of a wrong guess.


| Concept | Meaning |
|---|---|
| **Workspace** | A single project directory containing a `.envbeam.yaml` config. |
| **Resume** | Bring the current machine to a ready-to-work state for a workspace. |
| **Pause** | Flush all local state outward so another machine can resume cleanly. |
| **Providers** | Pluggable adapters for each concern: `git`, `secrets`, `container`, `database`, `session`. |
| **Identity / Account** | A named, reusable credential set for a provider (e.g. `github:work`, `1password:personal`). A workspace references identities by name; the actual credentials live in global config / the OS keychain, never in the repo. |
| **Plugin** | A provider adapter, loaded by name. Built-ins ship with the tool (e.g. `postgres`, `doppler`); third-party plugins can be added and are discovered by the same interface. |

## 6. Commands (MVP surface)

### `envbeam init`
Scaffolds a `.envbeam.yaml` in the current repo through an interactive prompt. Detects git remote automatically; asks which secrets provider and container mode to use. Writes a commented config file.

### `envbeam resume`
Runs the resume pipeline (see §7). Idempotent — safe to run repeatedly. Supports `--dry-run`.

### `envbeam pause`
Runs the pause pipeline (see §7). Refuses to silently discard work; warns and stops on conflicts unless `--force`.

### `envbeam status`
Reports, without changing anything: git ahead/behind + dirty files, whether secrets are present/stale, container running or not, and session sync state. This is the "what would resume/pause do" view.

### `envbeam doctor`
Two jobs. First, **environment**: checks that required external tools are installed and authenticated (git, docker, the chosen secrets CLI, the chosen database client, claude / claude-sync) for the identities this workspace uses, and prints actionable fixes. Second, **detection report**: shows every field it auto-detected (git remote/branch/identity, container mode, DB engine/service, migrate command, candidate secret names), flags what's ambiguous or missing, and offers to write only those gaps into `.envbeam.yaml` (`--fix` / interactive). Runnable before first use; the primary way you learn what you do and don't need to declare.

### `envbeam identity`
Manages named accounts that workspaces reference.
- `envbeam identity add` — register a named identity for a provider (e.g. `github:work`, `1password:personal`, `doppler:keeper`), capturing how to authenticate (SSH key/host alias, CLI account handle, vault name, token reference). Credentials go to the OS keychain or global config, **never** the repo.
- `envbeam identity list` — show configured identities per provider.
- `envbeam identity test` — verify an identity actually authenticates.

### `envbeam config sync` (AI-assisted)
Inspects the current repo — `docker-compose.yml`, `.devcontainer/`, migration folders, ORM config, `.env.example`, lockfiles — and **proposes** additions/updates to `.envbeam.yaml`: detected database engine and connection, detected container mode, likely secrets keys, etc. Prints a diff and applies only on confirmation (`--write`). This is the "take a look at the repo and update my config" entry point; it's designed so an agent (Claude Code) can run it or perform the same inspection-and-edit directly.

## 7. Pipelines

### Resume pipeline (ordered, fail-fast with clear messaging)
1. **Preflight** — verify required providers are available and authenticated (reuse `doctor` checks).
2. **Git** — fetch; if local is behind and clean, fast-forward pull. If local has uncommitted changes, warn and continue without clobbering (do not auto-merge).
3. **Secrets** — pull env vars from the configured provider into the runtime mechanism (e.g. generate a gitignored `.env` or prepare a run-wrapper). Never write secrets into anything git-tracked.
4. **Session** — pull the Claude Code session for this workspace (via the configured session provider) so history/context is present locally.
5. **Container** — bring the Dev Container up (`devcontainer up` or equivalent) so the environment is ready.
6. **Database** — apply pending migrations so the schema is current (always). If a newer snapshot exists on the sync target than the local DB reflects, offer to restore it (or auto-restore when `database.restore: auto`); otherwise migrations alone bring the schema up to date. In migrations-only workspaces, this step is just "run migrations."
7. **Report** — print a concise summary: identity in use, branch, commit, secret count loaded, DB snapshot restored (timestamp) + migrations applied, session synced, container status, and the suggested next action.

### Pause pipeline
1. **Git** — show uncommitted/unpushed work. Offer to commit (with a message) or stash; push the current branch. Stop and warn if anything would be lost; require explicit confirmation or `--force`.
2. **Database** — by default, **migrations-only**: no dump, rely on migration files in git + seed scripts (fast, the common case). A snapshot is taken only when it's worth it: either you pass `--snapshot`, or change-detection finds the local DB has diverged since the last snapshot (row-count deltas / max `updated_at` / quick checksum on configured tables) and prompts you. When a snapshot is taken, dump (optionally a `tables:` subset, compressed, `--data-only` if schema is migration-covered) and push to the sync target tagged with timestamp + machine. `--no-snapshot` forces skip. Warn if the dump exceeds the configured size cap.
3. **Session** — push the current Claude Code session outward so the other machine can pull it.
4. **Secrets** — no push by default (source of truth is the secrets provider); optionally warn if local overrides diverged.
5. **Container** — optionally stop/clean the container (configurable; default leave running).
6. **Report** — confirm machine is safe to switch away from; list the DB snapshot pushed and anything intentionally left behind.

## 8. Configuration: `.envbeam.yaml`

Lives at the workspace root, committed to git (contains **no secrets**, only references). **Most fields are optional** — omit them and they're auto-detected (see §5, Detection-first); include them only to override a wrong guess. A minimal real config is often just identities + database mode/target. The schema below is shown *fully expanded* to document every field, not because you'd write all of it:

```yaml
version: 1
workspace: keeper-api

git:
  identity: github:work   # references a named identity; resolves SSH host alias / account
  remote: origin
  branch: main            # or "current" to follow the checked-out branch
  autopush: true          # pause pushes the branch
  autopull: ff-only       # resume only fast-forwards a clean tree

secrets:
  provider: doppler       # plugin name
  identity: doppler:keeper # which account
  project: keeper         # provider-specific reference (no secret values here)
  config: dev
  output: dotenv          # how secrets are materialized: dotenv | run-wrapper

container:
  mode: devcontainer      # devcontainer | compose | none
  upOnResume: true
  stopOnPause: false

database:
  provider: postgres      # plugin name: postgres | mysql | ...
  mode: migrations-only   # DEFAULT. migrations-only (fast) | snapshot (carry data)
  restore: prompt         # on resume: prompt | auto | off
  connection: from-secrets # resolve DB host/creds from loaded secrets, or inline ref
  service: db             # the container service to dump/restore against
  migrate: true           # apply pending migrations (always, both modes)
  migrateCommand: "dotnet ef database update"  # stack-specific; auto-detectable
  snapshot:
    dataOnly: true        # schema comes from migrations; dump data only
    compress: true
    tables:               # optional: limit dump to tables worth carrying
      include: [test_*, seed_*]
      exclude: [audit_log, events]
    changeDetection: true # only auto-prompt a snapshot if these tables changed
  sync:
    target: syncthing     # where snapshots live: syncthing | s3 | local-folder
    identity: s3:personal # account for the sync target, if applicable
    maxSizeMB: 500        # warn/abort above this
    keep: 5               # retain N most recent snapshots

session:
  provider: claude-sync   # claude-sync | remote-control | none
  scope: sessions         # sessions-only vs full
```

**Identities** are defined once in global config (`~/.envbeam/config.yaml`), not per repo:

```yaml
identities:
  github:work:
    type: git
    sshHost: github-work      # ~/.ssh/config alias mapping to the work key
  github:personal:
    type: git
    sshHost: github-personal
  1password:work:
    type: onepassword
    account: my-company.1password.com
  1password:personal:
    type: onepassword
    account: my.1password.com
  doppler:keeper:
    type: doppler
    # auth handled by doppler CLI; this just names which login to use
```

The repo's `.envbeam.yaml` only ever names an identity (`github:work`); the credentials and account specifics live in global config or the OS keychain. This keeps multi-account routing explicit and keeps secrets out of git.

In practice, with detection on, a real workspace config can be as short as:

```yaml
version: 1
workspace: keeper-api
git: { identity: github:work }
secrets: { provider: doppler, identity: doppler:keeper, project: keeper, config: dev }
database: { mode: snapshot, sync: { target: syncthing } }
session: { provider: claude-sync }
```

Everything else — branch, container mode, DB engine/service, migrate command, secret key names — is detected. `doctor` tells you if any of it couldn't be inferred.

## 9. Provider adapters

Each concern is an interface with a small contract so providers are swappable. Every provider call receives a resolved **identity** so the same provider type can act as different accounts in different workspaces.

- **GitProvider**: `status()`, `pull()`, `pushWork(opts)`.
- **SecretsProvider**: `pull()`, `materialize(mode)`, `status()`. MVP target: Doppler and 1Password CLI; design the interface so Infisical/dotenv-vault drop in later.
- **ContainerProvider**: `up()`, `down()`, `status()`. MVP target: Dev Containers (`devcontainer` CLI) and Docker Compose.
- **DatabaseProvider**: `hasChanged(since)`, `snapshot(opts)`, `restore(snapshot)`, `migrate()`, `status()`. MVP target: Postgres and MySQL. Default operation is migrations-only (just `migrate()`); snapshotting is on-demand (`--snapshot`) or triggered by `hasChanged()` detecting divergence on configured tables. Must support: data-only dumps, table include/exclude, compression, size cap, retention of the N most recent snapshots, and a sync target (Syncthing folder, S3, local folder).
- **SessionProvider**: `pull()`, `push()`, `status()`. MVP target: `claude-sync` for independent-machine handoff; a `remote-control` mode that simply documents/links to Claude Code Remote Control as an alternative when the user wants one live session viewed from multiple surfaces. (Note: native cross-client Claude Code session sync is not yet built in, so the tool wraps `claude-sync`'s push/pull and path-mapping rather than relying on a built-in.)

Adapters shell out to the underlying CLIs rather than reimplementing them.

**Plugin model.** Providers are loaded by name from config. Built-ins ship in-tree; third-party plugins implement the same interface and are resolved from a known location (e.g. `~/.envbeam/plugins/` or an npm namespace). A plugin declares which concern it satisfies (`git` / `secrets` / `container` / `database` / `session`) and what identity `type` it expects. This is what lets you "add a plugin for Postgres, a plugin for this, a plugin for that" without changing the core.

**Identity resolution.** Before any pipeline runs, the engine resolves each concern's `identity:` reference against global config and the OS keychain, then passes a ready-to-use credential/account handle to the provider. A workspace that mixes `github:work` with `1password:personal` is fully supported — routing is per-concern, per-workspace.

## 9a. AI-assisted configuration

`.envbeam.yaml` should be writable by an agent, not just by hand. Two supported paths:

- **`envbeam config sync`** does deterministic repo inspection (compose files, `.devcontainer/`, migration directories, ORM/connection config, `.env.example`, lockfiles) and proposes a config diff. The detection logic is the tool's, so results are consistent.
- **Agent-driven editing.** Because the config is plain declarative YAML with a documented schema, an agent like Claude Code can be pointed at the repo ("look at the code and update my `.envbeam.yaml`") and edit it directly. To make this safe and reliable, the tool ships:
  - a published **JSON Schema** for `.envbeam.yaml` so edits can be validated (`envbeam config validate`),
  - `envbeam config explain` to describe what each detected/needed field means,
  - the expectation that any agent edit is followed by `envbeam config validate` before use.

Detection targets for v1: database engine + connection (from compose/ORM), container mode, migrate command per stack (.NET EF, Node/Prisma/Knex, Flutter/Dart where relevant), and candidate secrets keys (names only, never values).

## 10. Key requirements & guarantees

- **Local-only:** never moves code or secrets to a third-party hosted dev environment. Secrets transit only through the user's chosen secrets provider and stay out of git.
- **Multi-account:** every concern routes through a named identity, so multiple accounts of the same provider (work vs personal GitHub, work vs personal 1Password) coexist and are selected per workspace. Credentials never live in the repo.
- **Database fidelity:** `resume` leaves the local DB matching the last paused state — same schema (migrations applied) and, in snapshot mode, same data. Never drops or overwrites a database without confirmation.
- **Database data boundary:** envbeam never stores, reads into itself, or transmits DB contents to any envbeam-owned service. It only shells out to the database's own CLI (`pg_dump`/`pg_restore`, `mysqldump`) to produce a snapshot file, and writes that file to the sync target the user owns (their Syncthing folder, their S3 bucket, a local folder). The snapshot file is the sole artifact and lives only where the config points. There is no envbeam backend.
- **Non-destructive by default:** no command silently discards uncommitted/unpushed work or local database state. Destructive actions require confirmation or `--force`.
- **Idempotent:** `resume` and `status` can run repeatedly with no side effects beyond converging to the ready state.
- **Stack-agnostic:** all environment specifics live in the Dev Container, not in `envbeam`.
- **Observable:** `--dry-run` on mutating commands; clear, ordered, human-readable output; non-zero exit codes on failure.
- **Cross-platform:** macOS, Linux, Windows (the session provider must handle differing home paths — delegate path translation to `claude-sync`).
- **Fast preflight:** `doctor` catches missing/unauthenticated tools before any pipeline runs.

## 11. Tech suggestions (non-binding)

- Language: Node/TypeScript (good CLI ergonomics, easy npm distribution) or Go (single static binary). Either fits; pick per preference.
- Config parsing: YAML with schema validation.
- Distribution: single global install (`npm i -g` or a binary).

## 12. Success criteria

- Switching machines reduces to one command per side: `envbeam pause` here, `envbeam resume` there.
- Zero incidents of lost uncommitted work caused by the tool.
- Secrets never land in git.
- After `resume`, the user can start coding — correct branch, env vars loaded, container up, Claude session present — with no further manual setup.
- `doctor` correctly diagnoses a fresh machine's missing prerequisites.

## 13. Open questions

- Secrets provider for v1: commit to Doppler first, or support 1Password from day one?
- Session handoff default: ship with `claude-sync`, or default to Remote Control and treat sync as opt-in?
- Should `pause` auto-commit WIP to a scratch branch, or only stash + push the working branch?
- Container on pause: leave running (faster resume) vs stop (clean state) as the default?
- **Database default is migrations-only** (resolved): snapshots are on-demand (`--snapshot`) or change-detection-triggered, so the slow dump only happens when local test data is worth carrying. Open sub-question: should change-detection prompt interactively, or auto-snapshot when it fires?
- **Snapshot sync target for v1:** Syncthing (pure local P2P, fits the local-only ethos) vs S3/object storage (simpler setup, but external)? Snapshots can be large and may contain sensitive data — encrypt at rest, and how?
- **Big databases:** is full dump/restore acceptable for v1, or is incremental/differential sync needed early?
- **Identity storage:** OS keychain vs encrypted global config file as the credential store?
- Multi-workspace `resume all` for people juggling several repos at once — in or out of MVP?

## 14. Future (post-MVP)

- `resume all` across multiple workspaces.
- A TUI dashboard showing every workspace's sync state at a glance.
- Hooks (pre/post resume/pause) for custom steps.
- Optional encrypted sync of uncommitted working-tree changes (Syncthing-style) for people who don't want to commit half-done work.
- Profiles per machine (e.g. desktop builds images, laptop pulls prebuilt).