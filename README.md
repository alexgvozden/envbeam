# envbeam

> **`env.beam`** — pause your work on one machine, resume it whole on another. Code, secrets, database, container, and Claude session.

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.16.0-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="local-only" src="https://img.shields.io/badge/backend-none%20(local--only)-purple">
</p>

Switching laptops shouldn't mean re-cloning, re-fetching secrets, rebuilding containers, and losing your database state and AI session. `envbeam` moves **all of it** with two commands:

```bash
envbeam push     # hand off this machine
envbeam pull     # pick up where you left off on the other one
```

> `pause` and `resume` are exact aliases for `push` and `pull` — use whichever reads better to you.

**Contents** · [What it moves](#what-it-moves) · [How it works](#how-it-works) · [Install](#install) · [Quick start](#quick-start) · [Push here, pull there](#push-here-pull-there) · [All commands](#all-commands) · [Supported platforms](#supported-platforms) · [Configuration](#configuration) · [Guarantees](#guarantees) · [Extending](#extending-envbeam) · [Development](#development)

---

## What it moves

| | Handled by | How it travels |
|---|---|---|
| **Code** | `git` | pushed to / pulled from your git remote |
| **Secrets** | Doppler / 1Password | re-fetched from your provider into a gitignored `.env` |
| **Container** | Dev Container / Compose | brought up on the other machine |
| **Database** | `pg_dump` / `mysqldump` / `cypher-shell`+APOC | age-encrypted snapshot on your sync target |
| **Claude session** | `claude-native` (built-in) | age-encrypted archive on your sync target |

Each concern runs under **the right account** for it (work GitHub, personal Doppler vault, …). There is **no envbeam backend** — everything flows only through infrastructure *you already own*.

> Secrets never touch envbeam storage — both machines point at the same provider, so `pull` re-materializes them straight from Doppler or 1Password. Session sync is **opt-in** (off by default; enable it with `envbeam session setup`).

---

## How it works

`envbeam` doesn't reinvent anything. It orchestrates the tools you already use, in the right order, behind the two commands.

```
   ┌───────────────────────────┐                        ┌───────────────────────────┐
   │  Machine A  (laptop)      │                        │  Machine B  (desktop)     │
   │                           │                        │                           │
   │     envbeam push  ────────┼───┐                ┌───┼──────── envbeam pull      │
   └───────────────────────────┘   │                │   └───────────────────────────┘
                                   │  push      pull │
                                   ▼                 ▲
                 ┌───────────────────────────────────────────────────┐
                 │              infrastructure YOU own                │
                 ├───────────────────────────────────────────────────┤
                 │  code   ───────────►  git remote     GitHub/GitLab │
                 │  secrets ──────────►  Doppler · 1Password          │
                 │  database snapshot ►  S3 · Syncthing · local dir   │
                 │  Claude session ───►  same sync target (age-enc.)  │
                 └───────────────────────────────────────────────────┘
                     no envbeam server ever sees your code or data
```

- **Detection-first** — point it at a repo and it infers the git remote, container mode, database engine, migrate command, and secret keys. You write config only to *override* a wrong guess.
- **Ordered & fail-fast** — each command is a strict pipeline that stops on the first real problem.
- **Non-destructive** — nothing silently drops uncommitted work or local DB state; destructive actions need confirmation or `--force`.
- **Idempotent** — `pull` and `status` converge without side effects; safe to re-run.

---

## Install

```bash
npm install -g envbeam
```

Requires **Node ≥ 18**. Missing a provider CLI (`docker`, `doppler`, `pg_dump`, …)? `envbeam` **installs it for you** on demand — or run `envbeam doctor` to see the full picture first.

envbeam checks for a newer release before it runs and offers to upgrade itself. Skip that with `--no-update-check` or `ENVBEAM_NO_UPDATE_CHECK=1`; upgrade by hand any time with `npm install -g envbeam@latest`.

---

## Quick start

```bash
cd my-project
envbeam init      # scaffold .envbeam.yaml — auto-detects git, container, DB, secrets
envbeam doctor    # verify tools + auth, and show what was detected

envbeam push --commit -m "wip"   # hand off: commit & push, snapshot DB, sync session
# … then on the other machine …
envbeam pull                     # pick up: branch, secrets, container, DB, session
```

That's the whole happy path — `init` detects your git account automatically, so most single-account setups need no extra configuration.

Working across a work and a personal account? Route each concern to the right one — see [Identities](#identities-multi-account).

---

## Push here, pull there

These two commands *are* the tool, and they're a round trip. On the machine you're **leaving**, run `push` to hand everything off. On the machine you're **arriving at**, run `pull` to pick up exactly where you left off. Same two commands, every time.

Think bigger than `git push` / `git pull`: these move your *entire machine state* — code, secrets, container, database, and Claude session — not just commits.

### `envbeam push` — hand off this machine

*(alias: `envbeam pause`)*

```console
$ envbeam push --commit -m "wip: checkout flow"
▸ 1. Git
    2 uncommitted file(s)
    committed working changes
    pushed main → origin (4 commits)
▸ 2. Database
    orders changed (+128 rows) since last push
    snapshot encrypted (age)
    snapshot pushed → my-app-2026-07-08T15-04-22Z.sql.age (3.2MB)
▸ 3. Session
    pushed 2 session(s)
▸ 4. Secrets
    not pushed (provider is source of truth)
▸ 5. Report
    git:       main — committed, pushed
    database:  snapshot 2026-07-08T15-04-22Z uploaded
    session:   synced
✓ Safe to switch machines.
```

It **refuses to drop uncommitted work** without `--commit`, `--stash`, or `--force`, and snapshots the database only when the data actually changed (`--snapshot` forces one). Secrets aren't pushed — your provider stays the source of truth.

### `envbeam pull` — pick up on the new machine

*(alias: `envbeam resume`)*

```console
$ envbeam pull
▸ 1. Preflight
    ✓ git 2.39.5
    ✓ doppler 3.68.0
    ✓ docker 27.3.1
    ✓ pg_dump 14.13
▸ 2. Git
    main: fast-forwarded 3 commits
▸ 3. Secrets
    pulled 24 secret(s) from doppler → wrote .env
▸ 4. Session
    pulled 2 session(s)
▸ 5. Container
    container up
▸ 6. Database
    migrations applied (2 new)
    restored snapshot from 2026-07-08T14-32-10Z
▸ 7. Report
    branch:    main (fast-forwarded)
    secrets:   24 written to .env
    container: up
    database:  restored snapshot 2026-07-08T14-32-10Z, migrations applied
    session:   synced
✓ Ready to work.
```

`pull` only **fast-forwards** — if your branch has diverged or the working tree is dirty, it stops and leaves your work untouched instead of clobbering it. A newer database snapshot is *offered*, never forced.

> Both commands support `--dry-run` to preview every action without changing anything.

---

## All commands

Everyday work:

| Command | What it does |
|---|---|
| [`envbeam push`](#envbeam-push--hand-off-this-machine) · `pause` | Hand off this machine: commit & push, snapshot DB, sync session. |
| [`envbeam pull`](#envbeam-pull--pick-up-on-the-new-machine) · `resume` | Pick up on another machine: branch, secrets, container, DB, session. |
| [`envbeam status`](#status--doctor) | Read-only view of git/secrets/container/DB/session. `--json` for scripts. |

Setup & health:

| Command | What it does |
|---|---|
| `envbeam init [project]` | Scaffold `.envbeam.yaml`, or bootstrap a registered project by name. |
| [`envbeam doctor`](#status--doctor) | Check tools/auth **and** print the detection report. `--fix` writes gaps into config. |
| `envbeam identity add\|list\|test\|remove` | Manage [named accounts](#identities-multi-account). Credentials → OS keychain, never the repo. |
| `envbeam storage setup\|status` | Configure [global S3-compatible storage](#global-storage). |
| `envbeam session setup\|status` | Configure Claude session sync (generates encryption keys). |
| `envbeam config validate\|explain\|sync` | Validate, explain, or auto-propose [config](#configuration) additions (`--write`). |

Across machines (needs global storage):

| Command | What it does |
|---|---|
| [`envbeam list`](#working-across-machines) | List every project registered across your machines. |
| `envbeam pull <project>` | Bootstrap a registered project on a fresh machine (clone + secrets + up). |
| `envbeam delete <project>` | Remove a project from the registry and remote storage. |

Global flags: `--dry-run`, `-y/--yes`, `-v/--verbose`, `-q/--quiet`.

### `status` & `doctor`

`status` is a read-only glance — no side effects:

```console
$ envbeam status
Workspace: my-app  (github:work)
  git       main  clean  ↑2 ↓0
  secrets   24 present
  container running
  database  reachable  snapshot@2026-07-08T15-04-22Z
  session   ready  claude-sync (workspace scope)
```

`doctor` checks tools/auth and shows exactly what detection could and couldn't infer:

```console
$ envbeam doctor
Environment
  ✓ git 2.39.5 (git) · authenticated
  ✓ doppler 3.68.0 (secrets) · authenticated
  ✓ docker 27.3.1 (container)
  ✓ pg_dump 14.13 (database)
  ✓ sync:s3 (database snapshots) · accessible

Detection report
  ✓ git.url                  git@github.com:acme/my-app.git
  ✓ container.mode           compose
  ✓ database.engine          postgres
  ? database.service         (ambiguous)   candidates: db, postgres

✓ Environment looks good.
```

### Working across machines

With [global storage](#global-storage) configured, every `push` registers the project so any machine can see and bootstrap it:

```console
$ envbeam list
Registered Projects

NAME           LAST PUSH     MACHINE
──────────────────────────────────────
my-app         2026-07-08    laptop
data-pipeline  2026-07-05    cloud-vm

2 project(s) total
```

Then `envbeam pull my-app` on a fresh machine clones it, loads secrets, and brings everything up.

---

## Supported platforms

Each concern is a swappable provider — mix and match freely (a work GitHub with a personal Doppler vault and an S3 bucket is a normal setup). These are the built-ins; the provider kinds marked *pluggable* accept [your own](#extending-envbeam).

| Concern | Built-in providers | |
|---|---|---|
| **Code** | `git` | GitHub, GitLab, or any self-hosted remote · *pluggable* |
| **Secrets** | `doppler`, `onepassword` | materialized to a gitignored `.env` or a `run-wrapper` script; `pull-only` or `two-way` · *pluggable* |
| **Container** | `devcontainer`, `compose`, `none` | brought up on `pull` · *pluggable* |
| **Database** | `postgres`, `mysql`, `neo4j` | `migrations-only` (default) or `snapshot` mode · *pluggable* |
| **Claude session** | `claude-native`, `claude-sync`, `remote-control`, `none` | default `none` (opt-in) · *pluggable* — see below |

Session providers differ in what they actually do:

| Provider | What it does |
|---|---|
| `claude-native` | **Built-in.** Archives your Claude session, **age-encrypts** it, uploads to your sync target, and records a Doppler-anchored integrity hash. Enabled by `envbeam session setup`. |
| `claude-sync` | Delegates to a separate `claude-sync` CLI (installed & authenticated by you) — envbeam just runs its `push`/`pull`; encryption & storage are that tool's concern. |
| `remote-control` | No file sync — documents Claude Code Remote Control (one live session across surfaces). |
| `none` | Disabled (default). |

Storage & encryption (configured, not pluggable):

| | Options |
|---|---|
| **Sync target** (DB snapshots + sessions) | `local-folder`, `syncthing`, `s3` |
| **At-rest encryption** | `age` (default for snapshots once keys exist; **always** used for sessions) · `gpg` (snapshots only, with an explicit recipient) |
| **Cross-machine registry** | `s3` only |

**S3 works with any S3-compatible provider** — the setup wizard asks which and pre-fills the endpoint & region:

> Cloudflare R2 · Hetzner Object Storage · Backblaze B2 · AWS S3 · any other S3-compatible bucket

Need a provider that isn't here? Write one — see [Extending envbeam](#extending-envbeam).

---

## Configuration

`.envbeam.yaml` lives at the workspace root and is committed to git. It holds **no secrets** — only references — and is **detection-first**: omit a field and it's auto-detected; include it only to override a wrong guess. A real config is often this short:

```yaml
version: 1
workspace: my-app
secrets:  { provider: doppler, project: my-app, config: dev }
database: { mode: snapshot, sync: { target: s3, keep: 5 } }
session:  { provider: claude-native }   # written for you by `envbeam session setup`
```

Everything else — branch, container mode, DB engine/service, migrate command, secret keys — is detected. Run `envbeam config explain [field]` for docs on any field, or point Claude Code at the repo and let it edit the config, then `envbeam config validate`.

### Identities (multi-account)

Only needed when you route between **multiple accounts** (work vs. personal GitHub, two Doppler vaults). Define them once in `~/.envbeam/config.yaml`; the repo only ever *names* them:

```yaml
# ~/.envbeam/config.yaml
identities:
  github:work:      { type: git, sshHost: github-work }
  github:personal:  { type: git, sshHost: github-personal }
  doppler:personal: { type: doppler }
```

Then reference one in `.envbeam.yaml`, e.g. `git: { identity: github:work }`. Tokens are stored in the OS keychain (macOS `security`, Linux `secret-tool`) or a `0600` file — **never in the repo**.

### Global storage

Powers the cross-machine project registry and S3-based session/DB sync. `envbeam storage setup` works with any S3-compatible provider — it asks which one and pre-fills endpoint & region. Credentials live as `ENVBEAM_S3_*` secrets in the `envbeam-global` Doppler project and are **reused** automatically if already present. For non-interactive setup, pass `--endpoint`, `--bucket`, `--region`, `--access-key`, `--secret-key`.

---

## Guarantees

- **Local-only** — no hosted dev environment, no envbeam backend.
- **Secrets never land in git** — the materialized `.env` (or run-wrapper) is written `0600` and added to `.gitignore` automatically.
- **Database data boundary** — envbeam only shells out to `pg_dump`/`pg_restore`/`mysqldump`; the snapshot is the sole artifact, lives only where your config points, and is integrity-checked against a Doppler-anchored hash before restore.
- **Encryption** — sessions are **always** age-encrypted (no key → not pushed). Snapshots are age-encrypted once keys exist (`envbeam session setup`); without keys, envbeam **warns loudly before** storing one unencrypted.
- **Non-destructive by default** — no command discards uncommitted work or local DB state without confirmation or `--force`. `pull` only fast-forwards; a diverged or dirty tree stops it.
- **Idempotent & observable** — `pull`/`status` re-run safely; `--dry-run`, ordered output, non-zero exit on failure.

---

## Extending envbeam

Five provider kinds are pluggable: **`git`**, **`secrets`**, **`container`**, **`database`**, and **`session`**. (Sync targets, the config schema, and the S3 registry are built-in and not plugin-extensible.) A plugin is just a directory in `~/.envbeam/plugins/` that exports one or more provider factories — no fork, no rebuild of envbeam.

**1. Implement the interface for your kind.** Each kind (`GitProvider`, `SecretsProvider`, `ContainerProvider`, `DatabaseProvider`, `SessionProvider`) is exported from the package, so your editor enforces the exact methods:

```ts
import type { SecretsProvider, ProviderContext } from 'envbeam';

class VaultProvider implements SecretsProvider {
  readonly kind = 'secrets' as const;
  readonly name = 'vault';
  requiredTools() {
    return [{ command: 'vault', versionArgs: ['--version'], installHint: 'brew install vault' }];
  }
  async pull(ctx: ProviderContext) { /* … → { values, count } */ }
  async materialize(ctx, pulled) { /* write the gitignored .env */ }
  async status(ctx) { /* … */ }
}
```

**2. Export a factory.** A `ProviderFactory` is `{ kind, name, create, identityType? }`. The plugin entry (its `package.json` `main`/`module`, or `index.{js,mjs,cjs}`) can export it any of three ways:

```js
// default export: one factory or an array
export default [{ kind: 'secrets', name: 'vault', identityType: 'vault', create: () => new VaultProvider() }];

// …or a named `providers` export (same shape)
export const providers = [ /* factories */ ];

// …or a register(registry) function for full control
export function register(registry) {
  registry.register({ kind: 'secrets', name: 'vault', create: () => new VaultProvider() });
}
```

**3. Wire it up.** Name the provider in `.envbeam.yaml` (`secrets: { provider: vault }`); if it needs an account, add an identity whose `type` matches the factory's `identityType`. `envbeam doctor` lists every provider that loaded — including yours.

---

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the architecture map, the test strategy, and design decisions.

## License

MIT
