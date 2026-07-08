// Stamp the compiled output with the version it was built from, so the CLI can
// detect when dist/ is stale relative to package.json (e.g. `git pull` without
// a rebuild) and repair itself instead of silently running old code.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout (e.g. npm pack extraction) */
}

const info = { version, commit, builtAt: new Date().toISOString() };
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: v${info.version} (${info.commit}) ${info.builtAt}`);
