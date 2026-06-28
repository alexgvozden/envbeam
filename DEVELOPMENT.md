# envbeam — Development & Handoff

Working notes for continuing development across machines. If you just want to *use* the tool, see [README.md](README.md). For the original spec, see [planning/PRD.md](planning/PRD.md); for the phased build log, [planning/BUILD_PLAN.md](planning/BUILD_PLAN.md).

---

## Current status (2026-06-28)

**MVP complete and green.** Everything in PRD §§6–12 is implemented and tested.

- 59 source files, 19 test files, **134 tests passing**, ~85% line coverage.
- `npm run typecheck`, `npm run build`, `npm test` all pass.
- 4 logical commits on branch `master`; clean working tree.
- **No git remote yet** — pick a destination before pushing (see [Resuming on another machine](#resuming-on-another-machine)).

### Done
- Two pipelines (`resume`, `pause`) + `status`, all `--dry-run` capable.
- Commands: `init`, `resume`, `pause`, `status`, `doctor`, `identity add/list/test/remove`, `config validate/explain/sync`.
- Providers (all behind swappable interfaces, plugin-loadable): git · doppler · onepassword · devcontainer · compose · postgres · mysql · claude-sync · remote-control · none.
- Sync targets: local-folder · syncthing · s3, with optional age/gpg at-rest encryption.
- Detect-first config (zod schema + published JSON Schema), global identities, OS-keychain/file credential store.

### Pending / next
- **P16 — live-account validation (optional).** Everything is tested via an injectable command runner + Docker-backed Postgres/Compose/Dev Containers. Validating against *real* accounts needs: a Doppler service token + project/config; a 1Password `OP_SERVICE_ACCOUNT_TOKEN`; S3 creds + bucket (only for live S3 — local-folder/Syncthing need nothing); and how `claude-sync` is installed/authenticated.
- **Post-MVP (PRD §14):** `resume all` across workspaces, TUI dashboard, pre/post hooks, encrypted working-tree sync, per-machine profiles.

---

## Architecture map

```
src/
  cli.ts                     # commander entry; flags, exit codes
  index.ts                   # public API for plugin authors
  commands/                  # thin command wrappers → pipelines
    init, resume, pause, status, doctor, identity, config, shared
  core/
    util/      exec (CommandRunner), logger, prompt (Prompter), fs, errors
    config/    schema (zod), load, globalConfig, merge (detect-fill),
               gaps (doctor --fix / config sync), explain, paths
    detect/    git, container, database, secrets + orchestrator
    providers/ types (interfaces), registry (+ plugin loader), builtins
               git/ secrets/ container/ database/ session/
    sync/      types (naming), localFolder, s3, crypto (age/gpg), index
    identity/  store (keychain + file), resolver
    pipeline/  context (RunContext), providers (active set), preflight,
               resume, pause, status
    state.ts   per-workspace fingerprints + snapshot bookkeeping
```

**Key seam:** every external CLI call goes through `CommandRunner` (`core/util/exec.ts`). Tests inject `FakeRunner` (`test/helpers/fakeRunner.ts`) so all providers are covered deterministically without real credentials. Interactive prompts go through `Prompter` (real `TerminalPrompter` vs `AutoPrompter` in tests).

**Flow:** `buildRunContext` loads + validates config, runs detection, merges gaps, builds the provider registry (+ `~/.envbeam/plugins/`), resolves identities (lenient — unresolved ones warn, only `resume`/`pause` hard-fail), seeds env from any existing `.env`. Pipelines then drive the active providers in PRD §7 order.

---

## Dev environment setup (fresh machine)

```bash
git clone <remote> envbeam && cd envbeam   # once a remote exists
npm install
npm run build
npm test          # unit + integration (integration auto-skips absent tools)
```

**Required:** Node ≥ 18, git.

**Optional (only to run the real integration tests):**
- **Docker** — for the Postgres / Compose / Dev Containers integration tests. They auto-skip when the daemon is down. On macOS the daemon must be running (`open -ga Docker`).
- **`@devcontainers/cli`** — `npm i -g @devcontainers/cli` (for the devcontainer integration test).
- **Postgres client 14** — host `pg_dump`/`psql` must be ≥ the server major version. The integration test uses `postgres:14` to match a Homebrew Postgres 14 client; bump both together if you upgrade.

Everything else (doppler, op, mysql, aws, age/gpg, claude-sync) is exercised through `FakeRunner` and is **not** required to develop or test.

### Useful scripts
| Script | What |
|---|---|
| `npm run dev -- <args>` | run the CLI from source via tsx |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `test:unit` / `test:integration` | vitest |
| `npm run coverage` | coverage report |
| `npm run build` | emit `dist/` |
| `npm run schema:gen` | regenerate `schema/envbeam.schema.json` from the zod schema |

> After changing `core/config/schema.ts`, run `npm run schema:gen` so the published JSON Schema stays in sync.

---

## Resolved design decisions

(From PRD §13 open questions — see [planning/BUILD_PLAN.md](planning/BUILD_PLAN.md) for the full list.)

- Secrets v1: **both** Doppler and 1Password ship; default `doppler`.
- Session v1: `claude-sync` (default) + `remote-control` (docs/link) + `none`.
- Pause WIP: offer `--commit` or `--stash`; never auto-scratch-branch; refuse to lose work without `--force`.
- Container on pause: leave running (`stopOnPause: false`).
- Change-detection: prompt by default; `restore: auto` for non-interactive.
- Sync target v1: `local-folder` (default/test-friendly), `syncthing`, `s3`; optional age/gpg encryption.
- Big DBs: full dump/restore for v1 (size cap warns/aborts).
- Identity storage: global config for non-secret refs + OS keychain (fallback 0600 file) for tokens.
- `resume all`: deferred to post-MVP.

---

## Lessons learned / gotchas

- **Node `URL()` rejects `postgres://` / `mysql://` URLs with dotted hostnames** (non-special-scheme host parsing). `core/providers/database/connection.ts` uses a hand-rolled regex parser instead — don't "simplify" it back to `new URL()`.
- **`pg_dump`/`pg_restore` require the client major ≥ server major.** Keep the host client and the test container's Postgres version in lockstep.
- **`pg_restore` needs an explicit `-d` target** to load into a DB (without it, it writes a script to stdout). Plain-format dumps restore via `psql -f`; custom-format (`PGDMP` magic) via `pg_restore`.
- **`allowFailure` absorbs spawn `ENOENT`** (`core/util/exec.ts`) so best-effort steps (e.g. session sync) tolerate a missing binary instead of crashing.
- **git porcelain:** strip the 2-char `XY ` status prefix without trimming first, or paths get mangled. Handle unborn/detached HEAD via `git branch --show-current` → `symbolic-ref` → `HEAD`.
- **Preflight does not block on DB connectivity** — the DB server may only come up during the container step. Only a *missing dump tool in snapshot mode* blocks resume.

---

## Continuing the work (autonomous loop friendly)

The build was driven by `planning/BUILD_PLAN.md` as a living checklist. To pick up:

1. `npm install && npm test` to confirm a green baseline.
2. Check `planning/BUILD_PLAN.md` → Phases for the next unchecked item (currently only **P16**).
3. For new providers, implement the interface in `core/providers/types.ts`, register a factory in `core/providers/builtins.ts`, and add unit tests with `FakeRunner` + (optional) a skip-if-absent integration test.

## Resuming on another machine

1. Push to a remote (pick the right account — this is a personal project, so likely a **personal** GitHub, not the company enterprise instance):
   ```bash
   gh repo create <owner>/envbeam --private --source=. --remote=origin --push
   ```
2. On the other laptop: `git clone … && npm install && npm test`.
3. Optional: install Docker + `@devcontainers/cli` to run the full integration suite there too.
