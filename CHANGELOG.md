# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0] - 2026-07-08

### Security
- **Doppler-anchored integrity hashes for backups** — on `push`, envbeam records the `sha256` of every uploaded artifact (encrypted DB snapshot, encrypted session archive, and the session metadata) in a per-workspace manifest secret in the **Doppler `envbeam-global` project** — a different trust domain than the storage bucket. On `pull`/`resume` it verifies the downloaded artifact against that hash **before** decrypting/restoring and **refuses** on mismatch. So tampering with or rolling back a bucket object is now detectable unless the attacker also has Doppler write access (and age already makes tampering-without-the-key fail on decrypt). The plaintext session metadata is now hash-verified too, so a bad `workspaceRoot` can't drive path translation. The manifest is pruned to what's still on the sync target, and a missing hash (artifact pushed before this version, or Doppler unavailable) warns rather than blocking.

## [0.15.0] - 2026-07-08

### Added
- **Detect all database URLs by scheme + warn on ambiguity** — `findDatabaseUrls` finds every Postgres/MySQL connection URL in the environment by its scheme (not by a hard-coded var name). When more than one URL of the same engine is present, `push`/`pull` now warn (naming the one envbeam picked) so you can pin `database.connection` and not silently snapshot/restore the wrong database.

## [0.14.1] - 2026-07-08

### Security
- **Command injection via detected Alembic path** — a scanned `alembic.ini` path was interpolated into a `sh -c` migrate command, so a repo with a maliciously-named nested directory could execute arbitrary code on `resume`/`pull`. The path is now shell-quoted (`shellArgQuote`).
- **No silent `curl | sh` tool installs in CI/non-interactive runs** — auto-install now requires a real prompt on a TTY, or an explicit `--yes` non-interactively; it never installs (piping vendor scripts to `sh`) by default in piped/CI contexts.
- **Secrets no longer leak to the command trace** — `--verbose`/`ENVBEAM_TRACE` output now redacts URL credentials (`postgres://user:***@…`, token git remotes). The recorded `ENVBEAM_GIT_REMOTE` also strips any embedded token before it reaches `doppler secrets set` argv.
- **Bootstrap validates the registry-supplied git remote/branch** — refuses code-executing transports (`ext::`, `file:`) and flag-looking values before `git clone`/`checkout`.
- **Untrusted session archives handled safely on restore** — extraction uses `--no-same-owner`, refuses any archive containing a symlink (tar breakout), copies plain files only, and never overwrites security-sensitive Claude config (`settings*.json`, `*.mcp.json`) that could inject hooks.
- **No plaintext left on disk** — DB snapshots and session archives are written to private `mkdtemp` (0700) dirs and removed in `finally` on every path; the age private key is written with `O_EXCL` inside a fresh 0700 dir instead of a predictable tmp name.

### Fixed
- Change-detection fingerprint no longer folds in volatile planner estimates (`pg_database_size`, `n_live_tup`, MySQL `table_rows`) when change tables are configured, so `push` stops reporting spurious "data changed".
- `envbeam -V`/`--help` no longer trigger a full self-rebuild; the rebuild re-exec now maps a signal-killed child to a non-zero exit instead of 0.
- Shallow detection scan no longer skips `.github`/`.gitlab` (the `.startsWith('.git')` over-match); `.git` is still ignored.
- Doppler `ensureReady` no longer hard-blocks a scoped service token that lacks `projects list` permission.
- `parsePortConflict` now also matches Docker Desktop's "address already in use" wording.

## [0.14.0] - 2026-07-08

### Changed
- **Database snapshots are now encrypted at rest by default** — previously `sync.encrypt` defaulted to `none`, so a full DB dump (potentially your entire dataset) uploaded in plaintext, while sessions were always encrypted. Now, when age keys are available (they're set up as part of session sync / `envbeam storage setup`), snapshots are age-encrypted by default — no config needed. An explicit `sync.encrypt` still wins; if no keys exist, envbeam warns that the snapshot is stored unencrypted rather than failing. Restore now detects encryption from the **file extension** (`.age`/`.gpg`), so it decrypts correctly regardless of local config, auto-installing `age` and fetching keys from Doppler as needed.

### Added
- **Post-restore session hint** — after `pull`/`resume` restores Claude sessions, envbeam tells you how to use them: *"Your Claude sessions are restored — run `claude --resume` in this project to pick one up."*

## [0.13.3] - 2026-07-08

### Fixed
- **`pull` couldn't find pushed sessions ("no session backups found")** — the sync target's `list()` parses every object as a database-snapshot filename (`<workspace>__<ts>__<machine>`) and filtered out session archives (`claude-session-…`), so they were invisible even though the push succeeded. Added a raw name-prefix `listNames()` to the sync target (S3 + local-folder/syncthing); session pull now uses it, so pushed sessions are found and restored.

## [0.13.2] - 2026-07-08

### Fixed
- **Session encryption auto-installs `age`** — pushing a session on a machine without `age` crashed the whole push with `spawn age ENOENT`. The session provider now installs `age` for you before encrypting/decrypting (it was already in the tool registry — just never requested), and the Session step in both `push` and `pull` is best-effort: a session-sync failure warns and continues instead of aborting the checkpoint after git has already pushed.

## [0.13.1] - 2026-07-08

### Fixed
- **Session push failed with `tar: Invalid replacement flag`** — Claude project dir names start with a dash (`-Users-…`), which tar parsed as bundled options (`-U -s …`). The tar invocation now passes `--` before the directory name (verified against real bsdtar).

## [0.13.0] - 2026-07-08

### Fixed
- **Claude session sync never found any sessions** — three bugs made the Session step a permanent no-op:
  1. the project-dir name stripped Claude Code's **leading dash** (`projects/Users-…` instead of `projects/-Users-…`), so the session folder was never found even in `~/.claude`;
  2. only `~/.claude` was searched — users running Claude with an aliased `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-personal`) were invisible;
  3. the archive-name parser assumed dash-free workspace/machine names, so restore failed for names like `synthetic-signals`.

### Added
- **Claude config-dir discovery** — honors `CLAUDE_CONFIG_DIR`/`CLAUDE_HOME`, otherwise scans every `~/.claude*` dir and picks the one with the most recent session activity for the project (logged: `using Claude config ~/.claude-personal`). Restore resolves the destination on the **target** machine the same way, extracts to a temp dir, merges into the locally-correct project dir (source and target sanitized names differ when paths differ), and translates absolute paths inside the session files. Push logs the archive size; pull prefers the newest archive from a *different* machine and logs where it restored to.

## [0.12.0] - 2026-07-08

### Added
- **Language dependency sync on `pull`/`resume`** — a new Dependencies step detects the project's toolchains from lockfiles (root + two levels deep, vendor dirs skipped), **installs the package manager itself if missing** (uv, poetry, pipenv, pnpm, yarn, bun, npm, bundler, composer, go, cargo — per the auto-install rule), then syncs dependencies against the just-pulled lockfiles: `uv sync`, `poetry install`, `pnpm install`, `npm ci` (or `npm install` when `node_modules` exists), `go mod download`, `cargo fetch`, `bundle install`, `composer install`. Monorepos work naturally (workspace lockfiles live at the root; per-app lockfiles like `apps/web/package-lock.json` get their own install). Best-effort: failures warn and are listed in the report (`deps: 2 synced`), never block the resume. So after `envbeam pull`, things like `make api` (`uv run uvicorn …`) work immediately.

## [0.11.7] - 2026-07-08

### Added
- **Port-conflict self-heal on `compose up`** — when a published port is already allocated (e.g. another Postgres on 5432), envbeam now finds the culprit: if it's another container it names it (with its compose project) and offers to **stop it and retry**; if it's a host process it identifies it via `lsof` (e.g. a brew postgres) so you know exactly what to stop. Failure hints are now tailored to the actual error (port conflict / daemon down / image pull) instead of a generic "ensure Docker is running".
- Verbose trace failure summaries now surface the real error line (e.g. `Error response from daemon: …`) instead of progress noise like `db Pulling`.

## [0.11.6] - 2026-07-08

### Fixed
- **Shadowed/stale installs are now self-evident and self-repairing** — verified empirically that a fresh git install of 0.11.5 always prints the `(build …)` stamp, so a bare version in `-V` proves the shell is resolving a *different, stale* install (e.g. an old `npm link`ed checkout shadowing the global bin). Now: (a) a compiled `dist/` with **no** build stamp counts as stale and triggers the in-place rebuild + re-exec; (b) `--verbose` leads with `envbeam <version+build> · <cli path>`; (c) **every non-zero exit** prints the same identity footer — so the running install is visible in any error output. Diagnose duplicates with `which -a envbeam`.

## [0.11.5] - 2026-07-08

### Fixed
- **Stale builds can no longer masquerade as new versions** — root cause of "the fix didn't work": `-V` read `package.json` at runtime, so a `git pull` without a rebuild reported the new version while executing old compiled code (which predated the Docker auto-start entirely). The build now stamps `dist/build-info.json` (version + git sha + timestamp); `-V` prints it (`0.11.5 (build abc1234, …)`), and on a version mismatch the CLI **rebuilds itself and re-runs your command** (source checkouts) or prints the exact reinstall command. Escape hatch: `ENVBEAM_SKIP_REBUILD=1`.
- Empirically verified the Docker 25.0.3 daemon quirk against the real 25.0.3 CLI: dead daemon → exit 0, empty stdout, error on stderr — the digit-check from 0.11.4 handles it correctly.

## [0.11.4] - 2026-07-08

### Fixed
- **Docker now actually starts itself (macOS + Windows), no user action** — the daemon check now treats any non-version `docker info` output as "down" (docker 25.x prints the connect error to stdout and exits 0, which fooled the previous check), so envbeam reliably detects a stopped daemon and launches it. macOS tries Docker Desktop → OrbStack → colima; Windows tries the system-wide and per-user Docker Desktop paths; Linux starts the docker service. A reactive backstop also retries `compose up` after force-starting Docker if the daemon error still surfaces. No prompt, no waiting on the user.

### Added
- **`ENVBEAM_TRACE=1` also enables command tracing** — same output as `--verbose` but from process start and independent of flag position, so you can verify a deployed build (`ENVBEAM_TRACE=1 envbeam list`) and debug non-interactively.

## [0.11.3] - 2026-07-08

### Added
- **`--verbose` now traces every external command** — with `-v`/`--verbose`, envbeam prints each shell-out (`$ docker info …`, `$ doppler secrets …`, `$ aws s3 cp …`) and its exit code to stderr, so you can see exactly what it's doing and where a step fails. (Global flag: put it before the subcommand, e.g. `envbeam --verbose pull`.)

## [0.11.2] - 2026-07-08

### Fixed
- **Docker daemon detection was a false positive on Docker CLI 25.x** — `docker info --format '{{.ServerVersion}}'` exits **0** with empty output (error on stderr) when the daemon is down on older CLIs, so envbeam thought Docker was up, skipped starting it, and then failed at `compose up`. The check now requires a real server version, not just exit 0 — so `ensureDockerRunning` actually starts Docker, and preflight reports the daemon honestly. Shared `isDockerDaemonUp` is reused by the compose/devcontainer auth-checks.

## [0.11.1] - 2026-07-08

### Fixed
- **Updates now actually take effect** — added a `prepare` script so `dist/` (which is gitignored and drives the `envbeam` bin) is rebuilt on every install, local or from a git URL. Previously `git pull` without a manual `npm run build`, or `npm i -g github:…`, left the CLI running stale/absent compiled code — so pushed fixes never reached the machine.

## [0.11.0] - 2026-07-07

### Added
- **Shared secrets-auth gate that offers to sign you in** — a single set of helpers (`probeSecretsAuth` → `ensureSecretsAuth`) reuses each provider's own `authCheck` and honours a resolved token identity, and now backs every entry point. When the provider isn't signed in on an interactive terminal, envbeam **prompts and runs the login command for you** (`doppler login` / `op signin`) instead of dead-ending:
  - `init` offers to log in the moment you pick Doppler/1Password (interactive terminals only), before writing config.
  - `push`/`pause` gate **before touching git** when two-way sync would push to the provider — offering login, and only erroring if you decline or it's non-interactive (previously git was committed and pushed, then the run died at the secrets step, leaving a half-applied checkpoint).
  - `resume`/`pull` gate the same way up front (they pull secrets, so they need auth).
  - Read-only commands (`status`, `doctor`) are unaffected; `doctor` reports auth state without blocking. Non-interactive runs (CI, pipes) never hang on a login prompt — they fail with a clear hint.
- **Automatic secrets-project provisioning** — the secrets provider gains an `ensureReady` step: on an interactive `init`/`push`/`resume`, envbeam verifies the backing Doppler project exists and, if not, offers to create it (`doppler projects create`). When it already exists, it says so and reuses it (the provider stays the source of truth). Non-interactive runs surface a clear "create it with …" hint rather than creating silently.
- **`envbeam init <name>` bootstraps an existing project** — if the named project is already registered, `init` reuses the `pull` bootstrap (clone → restore `.envbeam.yaml` from the registry snapshot → pull secrets → sync) instead of scaffolding a duplicate. A bare `envbeam init` in an already-initialized repo is now idempotent: it reports "already initialized" with next steps (exit 0) instead of erroring, and still re-scaffolds under `--force`.
- **Git remote + branch recorded in Doppler** — on `push`, envbeam writes `ENVBEAM_GIT_REMOTE` and `ENVBEAM_GIT_BRANCH` into the project's Doppler config (best-effort, both sync modes) so the provider alone tells you what repo and branch to pull. These `ENVBEAM_`-prefixed keys are filtered out of the materialized `.env` (like `DOPPLER_` vars) and never pushed back as app secrets.

### Changed
- **Self-heal Docker on resume/pull — install it *and* start it** — if the Docker CLI is missing, envbeam installs it for you (`brew install --cask docker` on macOS, etc.); if the daemon is down, it starts Docker Desktop (macOS/Windows) or the docker service (Linux) and waits for it to be ready. This runs **before preflight**, so a missing/stopped Docker no longer hard-blocks (previously preflight failed before the container step could fix it). Container `up()` keeps an idempotent check as a backstop. After the container starts, resume waits for the database to accept connections before migrations/restore.
- **Resume no longer false-warns "psql cannot connect to postgres"** — the database connectivity probe was running at preflight, before secrets were materialized and the container was up, so it always failed. Preflight now checks only that the DB client tools are present; actual connectivity is validated after the container is up and secrets are written.
- **Storage-gated commands self-heal instead of dead-ending** — `list`, `pull <project>`, and `delete` no longer stop at "Global storage not configured. Run `envbeam setup`". A shared `ensureStorageReady` helper installs the Doppler CLI if needed, offers to sign you in, then imports the `ENVBEAM_S3_*` settings from the Doppler `envbeam-global` project (its usual home) and continues with the requested command. It only falls back to guiding you to `envbeam setup` when no settings exist anywhere. `push`/`init` reuse the same helper (silently — no extra prompts) so a project auto-registers as soon as storage is available.
- **`ENVBEAM_DISABLE_STORAGE` escape hatch** — set it to keep envbeam fully offline (no Doppler/S3 registry access). Used to make the CLI integration tests hermetic so they no longer register junk projects in the real registry.
- **Auto-install missing DB client tools on `push`/`pull`** — when a snapshot needs `pg_dump`/`psql` (or `mysqldump`/`mysql`) and they're absent, envbeam now offers to install them for you (via the existing `ensureTools` flow; added Postgres/MySQL client entries to the tool registry) instead of telling you to install them by hand. It prints the resolved connection target too (e.g. `connecting to agentlab@localhost:5432/agentlab`). If the install is declined/fails, it skips the snapshot with an honest reason rather than the old misleading "database not reachable".
- **Smarter DB connection discovery from `.env`** — connection resolution now (a) recognizes SQLAlchemy/driver-qualified URL schemes like `postgresql+psycopg://` (normalized to `postgresql://` for the CLI), (b) discovers app-prefixed URL vars such as `AGENTLAB_DATABASE_URL` when no standard `DATABASE_URL` is set, and (c) merges `.env.local` / `.env.development` (filling gaps) in addition to the primary `.env`.
- **First push now backs up the database when nothing exists yet** — instead of only recording a change-detection baseline, `push` checks the sync target: if no snapshot has ever been uploaded for the workspace, it takes an **initial snapshot** so the data actually exists remotely. Subsequent pushes fall back to change-detection. When the DB can't be read (down, or client tools like `pg_dump`/`psql` missing), the step now says so plainly instead of falsely claiming "baseline recorded".
- **Change-detection works without configured tables** — the fingerprint now always includes the whole-database on-disk size and approximate row count (Postgres: `pg_database_size` + `pg_stat_user_tables`; MySQL: `information_schema.tables`), read via the `.env` connection. Pinning `changeTables` still adds exact per-table counts. Messages report the signal, e.g. `data changed → ~48.2 MB, ~12,043 row(s)`.
- **Clearer per-step messaging for `push`/`pull`** — each step now says what it did and why. In particular the database step explains the first-push case ("recorded a change-detection baseline (first push) — no snapshot yet; … run `envbeam push --snapshot` to force one now") instead of the terse "baseline recorded", and the summary line reports a concrete reason ("no snapshot — baseline recorded (first push)") rather than the misleading "no changes". Session outcomes read "synced" / "nothing to sync" instead of "noop", and pull reports where secrets were written.

### Fixed
- **`push` registry update recorded an empty git remote** — it read a non-existent `git.remoteUrl` detection field (should be `git.url`), so re-pushing a project reported a spurious "already exists with a different git remote" conflict. It now records the real remote.
- **Bootstrap landed on the wrong branch** — the registry stored the config's `branch` value, which defaults to the literal sentinel `current`, so `git checkout current` failed during `pull`/`init <name>` and you fell back to the default branch. A new `resolveBranch` helper records the actual detected branch (e.g. `wave-1-identity`); both `init` and `push` use it, so the bootstrap checks out the branch the project was pushed from.
- **Subdirectory-aware compose detection** — `envbeam init`/`doctor` now find Docker Compose files kept under `infra/`, `deploy/`, `docker/`, `.devcontainer/`, and similar subdirectories (a shallow, depth-2 scan), not just the repo root. Monorepos that don't keep a root-level compose file are now correctly detected as `container.mode: compose`, which also unblocks database provider/service detection. Root-level files still take priority; among sibling subdirectories, dev-oriented locations (`infra/`, `docker/`, …) win over `deploy/`/prod ones. Well-known vendor/build directories (`node_modules/`, `.venv/`, `dist/`, …) are skipped.
- **Alembic migration detection** — `detectMigrateCommand` now recognizes SQLAlchemy/Alembic projects via `alembic.ini` (root or nested), emitting `alembic upgrade head` (or `alembic -c <path> upgrade head` when nested).

### Tests
- Added coverage for subdirectory compose detection, root-over-subdir and dev-over-deploy preference, ignored-directory skipping, and Alembic (root + nested) migration detection.
- Added coverage for `checkSecretsAuth` (missing CLI, installed-but-unauthenticated, authenticated, 1Password, and the no-op `none` provider) and for `push` fail-fast: two-way sync aborts before git when the provider is unauthenticated, and proceeds when authenticated.

## [0.10.0] - 2026-06-29

### Added
- **Storage provider picker** — `envbeam storage setup` now asks which S3-compatible provider you use (Cloudflare R2, Hetzner, Backblaze B2, AWS S3, or any other) and pre-fills the endpoint and region accordingly. AWS S3 no longer requires a custom endpoint.
- **Reuse existing Doppler storage settings** — if `ENVBEAM_S3_*` secrets already exist in the `envbeam-global` Doppler project, setup offers to reuse them instead of re-entering credentials.
- **Import storage during `envbeam init`** — when the Doppler secrets provider is selected and no global storage is configured yet, init offers to import existing storage settings from Doppler so projects auto-register without a separate setup step.

### Changed
- **`envbeam storage setup` no longer assumes AWS** — the AWS CLI (used purely as the S3 client for any provider) is now checked only after you choose to proceed, with Doppler verified first. The wizard makes clear envbeam works with any S3-compatible storage.

### Tests
- Added unit coverage for `readExistingDopplerStorage` (the Doppler reuse-detection logic shared by `storage setup` and `init`): full credentials, AWS-style missing endpoint/region defaults, missing required secrets, command failure, and unparseable output.

## [0.9.0] - 2026-06-29

### Added
- **Cross-machine project registry** — projects are now tracked in S3 for seamless sync across machines
- **`envbeam setup`** — one-time global S3 storage configuration for cross-machine sync
- **`envbeam list`** — list all registered projects across all machines
- **`envbeam delete <project>`** — delete a project from registry and remote storage (requires confirmation)
- **Bootstrap pull** — `envbeam pull <project-name>` clones, configures, and restores any registered project
- **Auto-registration** — `envbeam init` automatically registers projects when storage is configured
- **Unregistered project detection** — commands prompt to register local projects not yet in the registry

### Changed
- **Command renames** — `pause` renamed to `push`, `resume` renamed to `pull` (aliases preserved for backwards compatibility)
- **Push workflow** — `envbeam push` now updates the project registry after successful completion

## [0.8.2] - 2026-06-29

### Fixed
- **Claude commit message generation** — use stdin piping instead of command-line arguments to avoid shell escaping issues with multiline prompts on Windows

## [0.8.1] - 2026-06-28

### Added
- **Auto-install missing tools** — setup commands now prompt to install missing CLI tools (doppler, age, aws, git, docker, tar)
- **Platform-specific install commands** — provides correct install instructions for Windows (winget), macOS (brew), and Linux (apt/curl)
- **`ensureTools` helper** — reusable utility for checking and installing required tools

### Changed
- `envbeam storage setup` now checks for doppler and aws CLI before proceeding
- `envbeam session setup` now checks for doppler and age-keygen before proceeding

## [0.8.0] - 2026-06-28

### Added
- **Native Claude session sync (`claude-native`)** — built-in session sync to S3/storage without external CLI
- **Session scope options** — `project` (default, ~/.claude/projects/<path>/), `workspace` (.claude/ in repo), `global` (~/.claude/)
- **Session encryption** — uses same age/gpg encryption as database snapshots for secure transfer
- **Cross-machine path translation** — automatically translates workspace paths when restoring sessions from another machine
- **`remotePaths` config** — map machine names to workspace paths for multi-machine setups

### Changed
- Session provider default changed from `claude-sync` to `none` (opt-in)
- Session scope renamed from `sessions`/`full` to `project`/`workspace`/`global`
- `envbeam init` now prompts for `claude-native` as the recommended session sync option

## [0.7.0] - 2026-06-28

### Added
- **`envbeam storage setup`** — CLI command to configure S3-compatible storage (Hetzner, MinIO, AWS S3) and store credentials in Doppler
- **`envbeam storage status`** — show current storage configuration from environment variables or Doppler
- **S3-compatible endpoint support** — S3Target now supports custom endpoints via `ENVBEAM_S3_ENDPOINT` environment variable
- **Environment-based S3 credentials** — S3Target reads `ENVBEAM_S3_ACCESS_KEY`, `ENVBEAM_S3_SECRET_KEY`, `ENVBEAM_S3_BUCKET`, `ENVBEAM_S3_REGION` from environment

### Changed
- S3 sync target now supports Hetzner Object Storage, MinIO, and other S3-compatible services via custom endpoints

## [0.6.0] - 2026-06-28

### Added
- **Sync target verification in doctor** — `envbeam doctor` now verifies that the database snapshot sync target (S3, local-folder, syncthing) is accessible
- **S3 bucket connectivity check** — verifies credentials and bucket access via `aws s3api head-bucket`
- **Local folder write check** — verifies the snapshot directory exists and is writable

## [0.5.0] - 2026-06-28

### Added
- **Two-way secrets sync** — new `sync: two-way` config option enables pushing local .env changes back to Doppler on `envbeam pause`
- **Doppler push support** — `SecretsProvider.push()` method uploads local secrets to the provider
- **Doppler auto-setup** — `SecretsProvider.setup()` method auto-creates Doppler projects and imports existing .env files

### Changed
- Secrets sync mode is now configurable: `pull-only` (default, provider is source of truth) or `two-way`

## [0.4.1] - 2026-06-28

### Fixed
- CLI now reads version from package.json instead of hardcoded value
- CLI integration test now reads expected version from package.json dynamically

## [0.4.0] - 2026-06-28

### Added
- **Database detection from ORM configs** — detect database provider from Prisma schema, Django settings, Rails database.yml, .NET appsettings.json, Go go.mod, and Java application.properties/yml when no compose file is present
- **Secrets detection from .env files** — extract secret key names (never values) from existing `.env`, `.env.local`, `.env.development` files as fallback when no `.env.example` exists
- **Cross-language env var detection** — scan code for environment variable references in Python (`os.environ.get`), Java/Kotlin (`${VAR}`), .NET (`Environment.GetEnvironmentVariable`), Ruby (`ENV[]`), and Go (`os.Getenv`)

## [0.3.0] - 2026-06-28

### Added
- Initial MVP release
- Two main commands: `resume` and `pause` for environment sync
- Commands: `init`, `status`, `doctor`, `identity`, `config`
- Providers: git, doppler, onepassword, devcontainer, compose, postgres, mysql, claude-sync, remote-control
- Sync targets: local-folder, syncthing, s3 with optional age/gpg encryption
- Detection-first config with auto-detection of git, container, database, and secrets
- Global identities with OS keychain / file credential store
- 134 tests with ~85% coverage
