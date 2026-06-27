# envbeam — Build Plan & Progress

Living document. Tracks the agentic build loop toward full PRD conformance, fully tested across all plugins.

## Resolved design decisions (from PRD §13 open questions)

- **Language/stack:** Node + TypeScript, ESM, distributed via npm (`envbeam` bin). Single dependency-light codebase.
- **Secrets v1:** Both Doppler **and** 1Password ship as plugins behind one `SecretsProvider` interface. Default `doppler`.
- **Session v1:** Ship `claude-sync` wrapper + `remote-control` (documents/links) + `none`. Default `claude-sync`.
- **Pause WIP:** Offer commit-to-current-branch **or** stash; push branch. Never auto-create scratch branch. Stop + require confirm/`--force` if work would be lost.
- **Container on pause:** Default leave running (`stopOnPause: false`).
- **Change detection:** Default **prompt** interactively; config `database.snapshot.changeDetection: true` + `pause --snapshot`/`--no-snapshot` override; `restore: auto` for non-interactive.
- **Sync target v1:** `local-folder` (default, test-friendly), `syncthing` (a watched local folder), `s3`. Optional at-rest encryption via `age`/`gpg` (`sync.encrypt`).
- **Big DBs:** full dump/restore for v1 (documented limitation; size cap warns/aborts).
- **Identity storage:** global config file (`~/.envbeam/config.yaml`) for non-secret account refs + OS keychain for tokens (macOS `security`, Linux `secret-tool`, fallback 0600 file). Repo only ever names identities.
- **`resume all`:** out of MVP (future).

## Architecture

- `CommandRunner` abstraction wraps all CLI shell-outs → injectable `FakeRunner` for deterministic tests.
- `Prompter` abstraction for interactive prompts → `AutoPrompter` in tests.
- Providers implement small interfaces (`GitProvider`, `SecretsProvider`, `ContainerProvider`, `DatabaseProvider`, `SessionProvider`), loaded by name via a registry; third-party plugins discovered from `~/.envbeam/plugins/`.
- Detection engine infers config from repo/machine; `doctor` + `config sync` surface it.
- Resume/Pause pipelines orchestrate providers in PRD §7 order, fail-fast, `--dry-run`.

## Testing strategy

- **Unit:** every provider, detector, command, and the schema, against `FakeRunner` — covers all plugins with no real creds. Target: high coverage, all branches.
- **Integration (real tools present here):** git (local bare repos), docker compose + postgres container, devcontainer CLI (install via npm), config validate/explain/sync against fixture repos.
- **Skipped-when-absent:** mysql, doppler, op, claude-sync, aws, syncthing → integration tests detect-and-skip with a clear note; unit-covered regardless.
- **E2E live (optional, last):** against the user's real Doppler/1Password/S3/claude-sync accounts.

## Phases (executed in a loop; check off as completed)

- [x] P0 Scaffold: package.json, tsconfig, vitest, dir structure, scripts
- [x] P1 Core utils: exec/CommandRunner, logger, prompter, fs helpers, errors
- [x] P2 Config: zod schema, JSON Schema export, loader+defaults, global config, identity model
- [x] P3 Detection engine: git, container, database, secrets detectors + orchestrator
- [x] P4 Provider interfaces + registry + plugin loader
- [x] P5 Git provider
- [x] P6 Secrets providers: doppler, onepassword
- [x] P7 Container providers: devcontainer, compose
- [x] P8 Database providers: postgres, mysql (+ sync targets: local-folder, syncthing, s3; encryption)
- [x] P9 Session providers: claude-sync, remote-control, none
- [x] P10 Identity store + resolver (keychain + file backends)
- [x] P11 Pipelines: resume, pause (dry-run, force, reporting) + status
- [x] P12 Commands: init, resume, pause, status, doctor, identity, config (sync/validate/explain)
- [x] P13 CLI wiring (commander), help, exit codes
- [x] P14 Tests: 134 tests; unit for every plugin; real integration for git/postgres/compose/devcontainer; 85% line coverage
- [x] P15 Docs: README, published JSON Schema, examples
- [ ] P16 Live validation against real accounts (optional — needs user Doppler/1Password/S3/claude-sync creds)

## Status log

- 2026-06-27: Plan created. Environment probed. Starting P0.
- 2026-06-27: P0–P13 done. Full source compiles; CLI smoke-tested in scratch workspace
  (init/doctor/detection/config sync/validate/explain/identity/status/resume --dry-run/
  pause --dry-run all working). Fixed: unborn-branch git, preflight DB-connectivity blocking,
  lenient identity resolution, dry-run non-execution. Next: P14 comprehensive tests.
- 2026-06-27: P14–P15 done. 134 tests pass (19 files). Real integration validated against
  live git (pause→resume round-trip), Postgres 14 in Docker (pg_dump/pg_restore snapshot+restore
  via local-folder sync), Docker Compose up/down, and the Dev Containers CLI. Fixed: Node URL()
  can't parse postgres://mysql:// dotted-host URLs → hand-rolled DB-URL parser; git porcelain
  path-strip; allowFailure now absorbs spawn ENOENT so best-effort steps tolerate missing tools.
  85% line coverage. MVP complete per PRD §§6–12. Remaining: P16 optional live-account validation.
