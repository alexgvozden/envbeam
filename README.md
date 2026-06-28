# envbeam

> **`env.beam`** — beam your whole dev environment to any machine or VM. Pause on one machine, resume on another: **code + secrets + container + database state + Claude Code session**, under **the right account for each**.

`envbeam` is a local CLI that orchestrates the tools you already use — git, a secrets manager, Dev Containers / Docker Compose, your database's own dump tools, and Claude Code session sync — behind two verbs:

```bash
envbeam pause     # safely hand off this machine
envbeam resume    # get the other machine ready to work where you left off
```

Everything runs **locally**. There is no envbeam backend: secrets transit only through your secrets provider, and database snapshots go only to a sync target you own (a Syncthing folder, an S3 bucket, or a local folder).

---

## Install

```bash
npm install -g envbeam
```

Requires Node ≥ 18. The tool shells out to the CLIs of whatever providers you use (`git`, `docker`, `doppler`/`op`, `pg_dump`/`mysqldump`, `claude-sync`, …). Run `envbeam doctor` to see what's present and what's missing.

## Quick start

```bash
cd my-project
envbeam init           # scaffold a commented .envbeam.yaml (detects what it can)
envbeam doctor         # see detection + check required tools/auth
envbeam identity add doppler:personal --type doppler   # register an account once
envbeam resume         # branch synced, secrets loaded, container up, session pulled
# … work …
envbeam pause          # commit/stash + push, optional DB snapshot, push session
```

## The two verbs

### `envbeam resume`
Ordered, fail-fast pipeline:
1. **Preflight** — required tools present & authenticated (reuses `doctor`).
2. **Git** — fetch; fast-forward a clean tree; never clobbers uncommitted work.
3. **Secrets** — pull from your provider into a **gitignored** `.env` (or a run-wrapper). Never written to anything git-tracked.
4. **Session** — pull the Claude Code session for this workspace.
5. **Container** — bring the Dev Container / Compose stack up.
6. **Database** — apply pending migrations (always); in snapshot mode, offer to restore a newer snapshot from the sync target.
7. **Report** — identity, branch, secret count, DB snapshot + migrations, session, container.

Idempotent. Supports `--dry-run`.

### `envbeam pause`
1. **Git** — show uncommitted/unpushed work; `--commit` or `--stash`, then push. **Refuses to silently drop work** without `--force`.
2. **Database** — migrations-only by default. A snapshot is taken only when worth it: `--snapshot`, or change-detection finds drift on watched tables (then prompts). `--no-snapshot` forces skip. Dumps via the DB's own tools, optionally encrypted, pushed to your sync target, pruned to the last N.
3. **Session** — push the Claude Code session outward.
4. **Secrets** — not pushed (your provider is the source of truth).
5. **Container** — left running by default (`stopOnPause` to stop).
6. **Report** — what was pushed and what was intentionally left behind.

## Other commands

| Command | Purpose |
|---|---|
| `envbeam status` | Read-only "what would resume/pause do" — git ahead/behind + dirty, secrets, container, DB, session. `--json` for machines. |
| `envbeam doctor` | Checks required tools/auth **and** prints the detection report. `--fix` writes detected gaps into the config. |
| `envbeam init` | Interactive scaffold of `.envbeam.yaml`. |
| `envbeam identity add\|list\|test\|remove` | Manage named accounts (credentials go to the OS keychain / a 0600 file, **never** the repo). |
| `envbeam config validate\|explain\|sync` | Validate against the JSON Schema, explain fields, or inspect the repo and propose config additions (`--write`). |

Global flags: `--dry-run`, `-y/--yes`, `-v/--verbose`, `-q/--quiet`.

## Configuration

`.envbeam.yaml` lives at the workspace root and is committed to git. It contains **no secrets** — only references. It's **detection-first**: omit a field and it's auto-detected at run time; include it only to override a wrong guess. A real config is often just identities + database mode/target:

```yaml
version: 1
workspace: my-app
git: { identity: github:work }
secrets: { provider: doppler, identity: doppler:personal, project: my-app, config: dev }
database: { mode: snapshot, sync: { target: syncthing, path: ~/envbeam-snaps } }
session: { provider: claude-sync }
```

Everything else — branch, container mode, DB engine/service, migrate command, secret key names — is detected. `envbeam doctor` tells you what couldn't be inferred. See [`schema/envbeam.schema.json`](schema/envbeam.schema.json) for every field, or run `envbeam config explain`.

### Identities (multi-account)

Each concern routes through a **named identity**, so a work GitHub and a personal one — or a work 1Password vault and a personal one — coexist and are chosen per workspace. Identities are defined once in `~/.envbeam/config.yaml`; the repo only ever names them:

```yaml
# ~/.envbeam/config.yaml
identities:
  github:work:      { type: git, sshHost: github-work }
  github:personal:  { type: git, sshHost: github-personal }
  doppler:personal: { type: doppler }
  s3:personal:      { type: s3, profile: personal }
```

Tokens (where needed) are stored in the OS keychain (macOS `security`, Linux `secret-tool`) or a `0600` file — never in the repo.

## Providers (plugins)

Each concern is a small swappable interface. Built-ins ship in-tree:

| Concern | Built-ins |
|---|---|
| git | `git` |
| secrets | `doppler`, `onepassword` |
| container | `devcontainer`, `compose` |
| database | `postgres`, `mysql` |
| session | `claude-sync`, `remote-control`, `none` |
| sync target | `local-folder`, `syncthing`, `s3` (+ optional `age`/`gpg` at-rest encryption) |

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

The provider interfaces are exported from the package for type-safe authoring (`import type { SecretsProvider } from 'envbeam'`).

## AI-assisted configuration

`.envbeam.yaml` is plain declarative YAML with a published JSON Schema, designed to be edited by an agent:

- `envbeam config sync` does deterministic repo inspection (compose, `.devcontainer/`, migration dirs, ORM config, `.env.example`, lockfiles) and proposes a diff — apply with `--write`.
- Point Claude Code at the repo to edit the config directly, then run `envbeam config validate` to check it.
- `envbeam config explain [field]` documents what each field means.

## Guarantees

- **Local-only.** No third-party hosted dev environment. No envbeam backend.
- **Secrets never land in git** — materialized files are gitignored automatically.
- **Database data boundary.** envbeam only shells out to `pg_dump`/`pg_restore`/`mysqldump`; the snapshot file is the sole artifact and lives only where your config points.
- **Non-destructive by default.** No command silently discards uncommitted/unpushed work or local DB state; destructive actions need confirmation or `--force`.
- **Idempotent.** `resume` and `status` converge without side effects.
- **Stack-agnostic.** Environment specifics live in the Dev Container, not in envbeam.
- **Observable.** `--dry-run`, ordered human-readable output, non-zero exit codes on failure.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the architecture map, dev-environment setup, design decisions, and handoff notes.

```bash
npm install
npm run typecheck
npm test               # unit + integration (integration auto-skips when a tool is absent)
npm run test:unit
npm run build          # → dist/
npm run schema:gen     # regenerate schema/envbeam.schema.json
```

Integration tests use real tools when present: git (always), and Docker for Postgres / Compose / Dev Containers (auto-skipped when the daemon is down). Everything else is exercised deterministically through an injectable command runner, so all providers are covered without real credentials.

## License

MIT
