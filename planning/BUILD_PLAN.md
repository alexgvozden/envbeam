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

- [ ] P0 Scaffold: package.json, tsconfig, vitest, eslint, dir structure, CI-style scripts
- [ ] P1 Core utils: exec/CommandRunner, logger, prompter, fs helpers, errors
- [ ] P2 Config: zod schema, JSON Schema export, loader+defaults, global config, identity model
- [ ] P3 Detection engine: git, container, database, secrets detectors + orchestrator
- [ ] P4 Provider interfaces + registry + plugin loader
- [ ] P5 Git provider
- [ ] P6 Secrets providers: doppler, onepassword
- [ ] P7 Container providers: devcontainer, compose
- [ ] P8 Database providers: postgres, mysql (+ sync targets: local-folder, syncthing, s3; encryption)
- [ ] P9 Session providers: claude-sync, remote-control, none
- [ ] P10 Identity store + resolver (keychain + file backends)
- [ ] P11 Pipelines: resume, pause (dry-run, force, reporting)
- [ ] P12 Commands: init, resume, pause, status, doctor, identity, config (sync/validate/explain)
- [ ] P13 CLI wiring (commander), help, exit codes
- [ ] P14 Tests: unit for everything; integration for present tools; coverage pass
- [ ] P15 Docs: README, schema publish, examples; final doctor/e2e dry-runs
- [ ] P16 Live validation against real accounts (optional, with user-provided secrets)

## Status log

- 2026-06-27: Plan created. Environment probed. Starting P0.
- 2026-06-27: P0–P13 done. Full source compiles; CLI smoke-tested in scratch workspace
  (init/doctor/detection/config sync/validate/explain/identity/status/resume --dry-run/
  pause --dry-run all working). Fixed: unborn-branch git, preflight DB-connectivity blocking,
  lenient identity resolution, dry-run non-execution. Next: P14 comprehensive tests.
