# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
