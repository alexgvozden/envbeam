# Claude Code Instructions

Project-specific instructions for Claude Code when working on envbeam.

## Versioning & Changelog

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0) — breaking changes to CLI, config schema, or provider interfaces
- **MINOR** (0.X.0) — new features, new providers, new detection capabilities
- **PATCH** (0.0.X) — bug fixes, documentation, refactoring without behavior change

### On every commit that changes functionality:

1. **Bump version** in `package.json` according to semver
2. **Update `CHANGELOG.md`** under the new version heading:
   - `### Added` — new features
   - `### Changed` — changes in existing functionality
   - `### Deprecated` — soon-to-be removed features
   - `### Removed` — removed features
   - `### Fixed` — bug fixes
   - `### Security` — vulnerability fixes
3. **Run `npm install --package-lock-only`** to sync package-lock.json
4. **Rebuild** with `npm run build`

### Commit message format:

```
<type>: <short description>

<optional body with details>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`

## Development

```bash
npm run dev -- <command>   # run CLI from source
npm run typecheck          # check types
npm test                   # run tests
npm run build              # compile to dist/
```

## Architecture

See `DEVELOPMENT.md` for the full architecture map and design decisions.

Key files:
- `src/core/detect/` — auto-detection logic
- `src/core/providers/` — provider implementations
- `src/core/pipeline/` — resume/pause orchestration
- `src/core/config/schema.ts` — zod schema (run `npm run schema:gen` after changes)
