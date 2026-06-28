import path from 'node:path';
import { readFileIfExists, pathExists } from '../util/fs.js';
import type { DetectedField } from './types.js';

/** Parse env-var NAMES (never values) from a .env-style file. */
export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.replace(/^export\s+/, '');
    const m = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1]) keys.push(m[1]);
  }
  return Array.from(new Set(keys));
}

const EXAMPLE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const ACTUAL_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.dev'];

/** Extract env var references from Python files (os.environ, os.getenv patterns). */
function extractPythonEnvKeys(text: string): string[] {
  const keys: string[] = [];
  // os.environ.get('KEY'), os.environ['KEY'], os.getenv('KEY')
  const patterns = [
    /os\.environ\.get\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /os\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /os\.getenv\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      if (match[1]) keys.push(match[1]);
    }
  }
  return keys;
}

/** Extract env var references from Java/Kotlin properties (${VAR} syntax). */
function extractJavaEnvKeys(text: string): string[] {
  const keys: string[] = [];
  // ${VAR} or ${VAR:default}
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g)) {
    if (match[1]) keys.push(match[1]);
  }
  return keys;
}

/** Extract env var references from .NET (IConfiguration, Environment.GetEnvironmentVariable). */
function extractDotNetEnvKeys(text: string): string[] {
  const keys: string[] = [];
  // Environment.GetEnvironmentVariable("KEY")
  for (const match of text.matchAll(/Environment\.GetEnvironmentVariable\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) {
    if (match[1]) keys.push(match[1]);
  }
  // Configuration["KEY"] or Configuration.GetValue<T>("KEY")
  for (const match of text.matchAll(/Configuration\s*\[\s*["']([A-Za-z_][A-Za-z0-9_:]*)["']\s*\]/g)) {
    if (match[1]) keys.push(match[1]);
  }
  return keys;
}

/** Extract env var references from Ruby (ENV['KEY'], ENV.fetch). */
function extractRubyEnvKeys(text: string): string[] {
  const keys: string[] = [];
  // ENV['KEY'], ENV["KEY"], ENV.fetch('KEY')
  for (const match of text.matchAll(/ENV\s*(?:\[|\.fetch\s*\()\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) {
    if (match[1]) keys.push(match[1]);
  }
  return keys;
}

/** Extract env var references from Go (os.Getenv). */
function extractGoEnvKeys(text: string): string[] {
  const keys: string[] = [];
  // os.Getenv("KEY")
  for (const match of text.matchAll(/os\.Getenv\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g)) {
    if (match[1]) keys.push(match[1]);
  }
  return keys;
}

interface EnvKeySource {
  keys: string[];
  source: string;
}

/** Scan project for env var references across multiple languages. */
async function detectEnvKeysFromCode(root: string): Promise<EnvKeySource | null> {
  const allKeys: string[] = [];
  const sources: string[] = [];

  // Python: settings.py, config.py
  for (const pyFile of ['settings.py', 'config.py', 'config/settings.py']) {
    const text = await readFileIfExists(path.join(root, pyFile));
    if (text) {
      const keys = extractPythonEnvKeys(text);
      if (keys.length) {
        allKeys.push(...keys);
        sources.push(pyFile);
      }
    }
  }

  // Java/Kotlin: application.properties, application.yml
  for (const javaFile of [
    'src/main/resources/application.properties',
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
  ]) {
    const text = await readFileIfExists(path.join(root, javaFile));
    if (text) {
      const keys = extractJavaEnvKeys(text);
      if (keys.length) {
        allKeys.push(...keys);
        sources.push(path.basename(javaFile));
      }
    }
  }

  // .NET: appsettings.json, Program.cs
  for (const dotnetFile of ['appsettings.json', 'Program.cs']) {
    const text = await readFileIfExists(path.join(root, dotnetFile));
    if (text) {
      const keys = extractDotNetEnvKeys(text);
      if (keys.length) {
        allKeys.push(...keys);
        sources.push(dotnetFile);
      }
    }
  }

  // Ruby: config/application.rb, config/environments/*.rb
  const rubyConfig = await readFileIfExists(path.join(root, 'config', 'application.rb'));
  if (rubyConfig) {
    const keys = extractRubyEnvKeys(rubyConfig);
    if (keys.length) {
      allKeys.push(...keys);
      sources.push('config/application.rb');
    }
  }

  // Go: main.go, config.go
  for (const goFile of ['main.go', 'config.go', 'cmd/main.go']) {
    const text = await readFileIfExists(path.join(root, goFile));
    if (text) {
      const keys = extractGoEnvKeys(text);
      if (keys.length) {
        allKeys.push(...keys);
        sources.push(goFile);
      }
    }
  }

  if (allKeys.length === 0) return null;
  return { keys: Array.from(new Set(allKeys)), source: sources.join(', ') };
}

/** Detect a secrets provider hint from lockfiles / config presence. */
async function detectProviderHint(root: string): Promise<string | undefined> {
  if (await pathExists(path.join(root, 'doppler.yaml'))) return 'doppler';
  if (await pathExists(path.join(root, '.doppler.yaml'))) return 'doppler';
  if (await pathExists(path.join(root, '.op'))) return 'onepassword';
  return undefined;
}

export async function detectSecrets(workspaceRoot: string): Promise<DetectedField[]> {
  const fields: DetectedField[] = [];

  // Priority 1: .env.example (template file)
  let exampleFile: string | undefined;
  for (const name of EXAMPLE_FILES) {
    if (await pathExists(path.join(workspaceRoot, name))) {
      exampleFile = name;
      break;
    }
  }

  if (exampleFile) {
    const text = (await readFileIfExists(path.join(workspaceRoot, exampleFile))) ?? '';
    const keys = parseEnvKeys(text);
    fields.push({
      field: 'secrets.keys',
      value: keys,
      source: exampleFile,
      status: keys.length ? 'detected' : 'missing',
      note: keys.length ? `${keys.length} secret names from template` : 'no keys found',
    });
  } else {
    // Priority 2: actual .env file (extract names only, never values)
    let envFile: string | undefined;
    for (const name of ACTUAL_ENV_FILES) {
      if (await pathExists(path.join(workspaceRoot, name))) {
        envFile = name;
        break;
      }
    }

    if (envFile) {
      const text = (await readFileIfExists(path.join(workspaceRoot, envFile))) ?? '';
      const keys = parseEnvKeys(text);
      fields.push({
        field: 'secrets.keys',
        value: keys,
        source: envFile,
        status: keys.length ? 'detected' : 'missing',
        note: keys.length ? `${keys.length} secret names from ${envFile} (names only)` : 'no keys found',
      });
    } else {
      // Priority 3: scan code for env var references
      const codeKeys = await detectEnvKeysFromCode(workspaceRoot);
      if (codeKeys && codeKeys.keys.length) {
        fields.push({
          field: 'secrets.keys',
          value: codeKeys.keys,
          source: codeKeys.source,
          status: 'detected',
          note: `${codeKeys.keys.length} env vars referenced in code`,
        });
      } else {
        fields.push({
          field: 'secrets.keys',
          source: 'project files',
          status: 'missing',
          note: 'no env files or env var references found',
        });
      }
    }
  }

  const providerHint = await detectProviderHint(workspaceRoot);
  if (providerHint) {
    fields.push({
      field: 'secrets.provider',
      value: providerHint,
      source: 'project files',
      status: 'detected',
    });
  } else {
    fields.push({
      field: 'secrets.provider',
      source: 'project files',
      status: 'missing',
      note: 'declare which secrets provider to use (doppler | onepassword)',
    });
  }

  return fields;
}
