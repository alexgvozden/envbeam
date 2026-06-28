# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
