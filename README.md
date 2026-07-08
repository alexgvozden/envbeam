# envbeam

> **`env.beam`** — beam your whole dev environment to any machine. Pause here, resume there.

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.16.0-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="local-only" src="https://img.shields.io/badge/backend-none%20(local--only)-purple">
</p>

Switching laptops, spinning up a cloud VM, or handing a task to a beefier box shouldn't mean re-cloning, re-fetching secrets, rebuilding containers, and losing your database state and AI session. `envbeam` moves **all of it** in two commands:

```bash
envbeam pause     # safely hand off this machine
envbeam resume    # pick up on the other machine exactly where you left off
```

It carries **code · secrets · container · database state · Claude Code session** — each under **the right account** for that concern (your work GitHub, your personal Doppler vault, and so on).

There is **no envbeam backend**. Everything runs locally and flows only through infrastructure *you already own*: your git remote, your secrets manager, your storage bucket.

---

## How it works

`envbeam` doesn't reinvent anything — it orchestrates the tools you already use, in the right order, behind two verbs.

```
      ┌──────────────────────────────┐                    ┌──────────────────────────────┐
      │  💻  Machine A  (your laptop) │                    │  ☁️  Machine B  (cloud VM)    │
      │                              │                    │                              │
      │      envbeam pause  ─────────┼───┐            ┌───┼─────────  envbeam resume     │
      └──────────────────────────────┘   │            │   └──────────────────────────────┘
                                         │            │
                                    push │            │ pull
                                         ▼            ▲
                   ┌─────────────────────────────────────────────────────┐
                   │              infrastructure YOU own                  │
                   ├─────────────────────────────────────────────────────┤
                   │  code   ───────────►  git remote      GitHub/GitLab  │
                   │  secrets ──────────►  Doppler · 1Password            │
                   │  database snapshot ►  S3 · Syncthing · local folder  │
                   │  Claude session ───►  S3  (age/gpg encrypted)        │
                   └─────────────────────────────────────────────────────┘
                        no envbeam server ever sees your code or data
```

- **Detection-first.** Point it at a repo and it figures out your git remote, container mode (Compose / Dev Container), database engine, migration command, and secret keys. You only write config to *override* a wrong guess.
- **Ordered & fail-fast.** Each verb runs a strict pipeline (preflight → git → secrets → deps → session → container → database → report) that stops on the first real problem.
- **Non-destructive.** No command silently drops uncommitted work or local DB state. Destructive actions need confirmation or `--force`.
- **Idempotent.** `resume` and `status` converge without side effects; safe to re-run.

---

## Install

```bash
npm install -g envbeam
```

Requires **Node ≥ 18**. `envbeam` shells out to the CLIs of whatever providers you use (`git`, `docker`, `doppler`/`op`, `pg_dump`/`mysqldump`, `claude-sync`, …). Missing a tool? `envbeam` **installs it for you** on demand — or run `envbeam doctor` to see the full picture up front.

---

## Quick start

```bash
cd my-project
envbeam init                                     # scaffold .envbeam.yaml (auto-detects what it can)
envbeam identity add github:work --type git --ssh-host github-work
envbeam identity add doppler:personal --type doppler
envbeam doctor                                   # verify tools + auth + detection
envbeam resume                                   # branch synced, secrets loaded, container up, session pulled
# … work …
envbeam pause                                    # commit/push, optional DB snapshot, push session
```

---

## The two verbs

### `envbeam resume` — get this machine ready to work

```console
$ envbeam resume
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
→ Your Claude sessions are restored — run `claude --resume` in this project to pick one up.
▸ 5. Container
    container up
▸ 6. Database
    migrations applied (2 new)
    restored snapshot from 2026-07-08T14-32-10Z
▸ 7. Report
    identity:  github:work
    branch:    main (fast-forwarded)
    secrets:   24 written to .env
    container: up
    database:  restored snapshot 2026-07-08T14-32-10Z, migrations applied
    session:   synced
✓ Ready to work.
→ Start coding — env, container, and session are in place.
```

What it does, in order:

1. **Preflight** — required tools present & authenticated; auto-installs missing DB clients.
2. **Git** — fetch, then fast-forward a clean tree. **Never clobbers uncommitted work.**
3. **Secrets** — pull from your provider into a **gitignored** `.env`. Never written anywhere git-tracked.
4. **Session** — pull the Claude Code session for this workspace.
5. **Container** — bring the Dev Container / Compose stack up.
6. **Database** — apply pending migrations (always); in snapshot mode, offer to restore a newer snapshot.
7. **Report** — a one-glance summary of everything that changed.

### `envbeam pause` — safely hand off this machine

```console
$ envbeam pause --commit -m "wip: checkout flow"
▸ 1. Git
    2 uncommitted file(s)
      src/checkout.ts
      src/cart.ts
    committed working changes
    pushed main → origin (4 commits)
▸ 2. Database
    orders changed (+128 rows) since last push
    snapshot encrypted (age)
    snapshot pushed → my-app-2026-07-08T15-04-22Z.sql.age (3.2MB)
▸ 3. Session
    pushed 2 session(s)
▸ 4. Secrets
    not pushed (sync: pull-only — provider is source of truth)
▸ 5. Report
    git:       main — committed, pushed
    database:  snapshot 2026-07-08T15-04-22Z uploaded
    secrets:   not pushed (sync: pull-only — provider is source of truth)
    session:   synced
✓ Safe to switch machines.
```

1. **Git** — surfaces uncommitted/unpushed work; `--commit` or `--stash`, then push. **Refuses to silently drop work** without `--force`.
2. **Database** — migrations-only by default. A snapshot is taken only when it's worth it: `--snapshot`, or change-detection finds drift on watched tables (then prompts). Dumps via the DB's own tools, **encrypted at rest by default**, pushed to your sync target, pruned to the last N.
3. **Session** — push the Claude Code session outward.
4. **Secrets** — not pushed by default (your provider is the source of truth; opt into two-way sync in config).
5. **Report** — what was pushed, and what was intentionally left behind.

> Both verbs support `--dry-run` to preview every action without changing anything.

---

## Supported platforms

Every concern is a small swappable interface with built-ins in-tree. Mix and match — a work GitHub with a personal Doppler vault and an S3 bucket is a normal setup.

| Concern | Supported | Notes |
|---|---|---|
| **Code** | `git` | any git remote — GitHub, GitLab, self-hosted |
| **Secrets** | `doppler`, `1password` | pulled into a gitignored `.env`; optional two-way sync |
| **Container** | `devcontainer`, `compose` | brought up on resume, left running on pause by default |
| **Database** | `postgres`, `mysql` | dump/restore via the DB's own tools; migrations always applied |
| **AI session** | `claude-sync`, `remote-control`, `none` | Claude Code session state, per project/workspace/global scope |
| **Sync target** | `local-folder`, `syncthing`, `s3` | where DB snapshots + sessions live |
| **At-rest encryption** | `age`, `gpg` | snapshots & sessions encrypted by default when keys exist |

**S3 sync works with any S3-compatible provider** — the setup wizard asks which one and pre-fills the endpoint & region:

| Cloudflare R2 · Hetzner Object Storage · Backblaze B2 · AWS S3 · any other S3-compatible bucket |
|:--:|

Third-party providers drop into `~/.envbeam/plugins/` and implement the same interface (see [Providers](#providers-plugins) below).

---

## Command reference

| Command | Purpose |
|---|---|
| `envbeam init [project]` | Scaffold a `.envbeam.yaml` — or bootstrap a registered project by name. |
| `envbeam resume` / `pull` | Pull state and get ready to work. Idempotent. |
| `envbeam pause` / `push` | Push state so you can switch machines. |
| `envbeam status` | Read-only "what would resume/pause do". `--json` for machines. |
| `envbeam doctor` | Check required tools/auth **and** print the detection report. `--fix` writes gaps into config. |
| `envbeam identity add\|list\|test\|remove` | Manage named accounts. Credentials → OS keychain / `0600` file, **never** the repo. |
| `envbeam config validate\|explain\|sync` | Validate against the JSON Schema, explain fields, or propose config additions (`--write`). |
| `envbeam storage setup\|status` | Configure global S3-compatible storage. |
| `envbeam session setup\|status` | Configure Claude session sync (generates encryption keys). |
| `envbeam list \| pull <project> \| delete <project>` | List projects across machines, bootstrap one locally, or remove one. |

Global flags: `--dry-run`, `-y/--yes`, `-v/--verbose`, `-q/--quiet`.

### `envbeam status`

A read-only glance — no side effects.

```console
$ envbeam status
Workspace: my-app  (github:work)
  git       main  clean  ↑2 ↓0
  secrets   24 present
  container running
  database  reachable  snapshot@2026-07-08T15-04-22Z
  session   ready  claude-sync (workspace scope)
```

### `envbeam doctor`

Checks tools/auth and shows exactly what detection could and couldn't infer.

```console
$ envbeam doctor
envbeam doctor
workspace: /Users/you/code/my-app

Environment
  ✓ git 2.39.5 (git) · authenticated
  ✓ doppler 3.68.0 (secrets) · authenticated
  ✓ docker 27.3.1 (container)
  ✓ pg_dump 14.13 (database)
  ✓ sync:s3 (database snapshots) · accessible

Detection report
  ✓ git.url                  git@github.com:acme/my-app.git
  ✓ git.branch               main
  ✓ container.mode           compose
  ✓ database.engine          postgres
  ? database.service         (ambiguous)
      candidates: db, postgres
  · session.provider         —

✓ Environment looks good.
```

### `envbeam identity list`

```console
$ envbeam identity list
Identities
  github:work              type=git  sshHost=github-work
  doppler:personal         type=doppler  token✓
  s3:personal              type=s3  profile=personal
```

### `envbeam list`

Every project registered across your machines (needs global storage configured).

```console
$ envbeam list
Registered Projects

NAME           LAST PUSH     MACHINE
──────────────────────────────────────────────
my-app         2026-07-08    laptop
data-pipeline  2026-07-05    cloud-vm

2 project(s) total
```

Bootstrap any of them on a fresh machine with `envbeam pull my-app` — it clones, loads secrets, and brings everything up.

---

## Configuration

`.envbeam.yaml` lives at the workspace root and is committed to git. It holds **no secrets** — only references. It's **detection-first**: omit a field and it's auto-detected at run time; include it only to override a wrong guess. A real config is often just identities + database mode/target:

```yaml
version: 1
workspace: my-app
git:      { identity: github:work }
secrets:  { provider: doppler, identity: doppler:personal, project: my-app, config: dev }
database: { mode: snapshot, sync: { target: s3, keep: 5 } }
session:  { provider: claude-sync }
```

Everything else — branch, container mode, DB engine/service, migrate command, secret key names — is detected. Run `envbeam config explain [field]` to see what any field means, or check [`schema/envbeam.schema.json`](schema/envbeam.schema.json).

### Identities (multi-account)

Each concern routes through a **named identity**, so a work GitHub and a personal one — or a work 1Password vault and a personal one — coexist and are chosen per workspace. Identities are defined once in `~/.envbeam/config.yaml`; the repo only ever *names* them:

```yaml
# ~/.envbeam/config.yaml
identities:
  github:work:      { type: git, sshHost: github-work }
  github:personal:  { type: git, sshHost: github-personal }
  doppler:personal: { type: doppler }
  s3:personal:      { type: s3, profile: personal }
```

Tokens (where needed) are stored in the OS keychain (macOS `security`, Linux `secret-tool`) or a `0600` file — **never in the repo**.

### Global storage

Global storage powers the cross-machine project registry and S3-based session/DB sync. `envbeam storage setup` works with **any S3-compatible provider** — it asks which one and pre-fills the endpoint & region. Credentials are stored as `ENVBEAM_S3_*` secrets in the `envbeam-global` Doppler project; if they already exist, both `storage setup` and `init` offer to **reuse** them. For non-interactive setup, pass `--endpoint`, `--bucket`, `--region`, `--access-key`, and `--secret-key`.

---

## Providers (plugins)

Third-party plugins drop into `~/.envbeam/plugins/` and implement the same interface — a directory whose entry exports a `ProviderFactory` (or array), or a `register(registry)` function:

```js
// ~/.envbeam/plugins/my-secrets/index.mjs
export default [{
  kind: 'secrets',
  name: 'vault',
  identityType: 'vault',
  create: () => new MyVaultProvider(),
}];
```

Provider interfaces are exported from the package for type-safe authoring:

```ts
import type { SecretsProvider } from 'envbeam';
```

### AI-assisted configuration

`.envbeam.yaml` is plain declarative YAML with a published JSON Schema, designed to be edited by an agent:

- `envbeam config sync` does deterministic repo inspection (compose, `.devcontainer/`, migration dirs, ORM config, `.env.example`, lockfiles) and proposes a diff — apply with `--write`.
- Point Claude Code at the repo to edit the config directly, then run `envbeam config validate` to check it.

---

## Guarantees

- **Local-only.** No third-party hosted dev environment. No envbeam backend.
- **Secrets never land in git** — materialized files are gitignored automatically.
- **Database data boundary.** envbeam only shells out to `pg_dump`/`pg_restore`/`mysqldump`; the snapshot file is the sole artifact and lives only where your config points. Snapshots are **encrypted at rest by default** and integrity-checked against a Doppler-anchored hash before restore.
- **Non-destructive by default.** No command silently discards uncommitted/unpushed work or local DB state; destructive actions need confirmation or `--force`.
- **Idempotent.** `resume` and `status` converge without side effects.
- **Stack-agnostic.** Environment specifics live in the Dev Container, not in envbeam.
- **Observable.** `--dry-run`, ordered human-readable output, non-zero exit codes on failure.

---

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the architecture map, dev-environment setup, and design decisions.

```bash
npm install
npm run typecheck
npm test               # unit + integration (integration auto-skips when a tool is absent)
npm run build          # → dist/
npm run schema:gen     # regenerate schema/envbeam.schema.json
```

Integration tests use real tools when present (git always; Docker for Postgres / Compose / Dev Containers, auto-skipped when the daemon is down). Everything else is exercised deterministically through an injectable command runner, so all providers are covered without real credentials.

## License

MIT
