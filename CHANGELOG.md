# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
