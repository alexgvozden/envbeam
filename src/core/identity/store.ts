import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandRunner } from '../util/exec.js';
import { credentialStorePath, globalDir } from '../config/paths.js';
import { ensureDir, pathExists, readFileIfExists, writeSecureFile } from '../util/fs.js';

/**
 * Stores provider tokens out of the repo (PRD §10). Two backends: the OS
 * keychain (preferred) or a 0600 JSON file fallback. Repos only ever name an
 * identity; the secret lives here.
 */
export interface CredentialStore {
  readonly backend: 'keychain' | 'file';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<string[]>;
}

const KEYCHAIN_ACCOUNT = 'envbeam';

function service(key: string): string {
  return `envbeam:${key}`;
}

function indexPath(): string {
  return path.join(globalDir(), 'credentials.index');
}

async function readIndex(): Promise<string[]> {
  const text = await readFileIfExists(indexPath());
  if (!text) return [];
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function writeIndex(keys: string[]): Promise<void> {
  await ensureDir(globalDir());
  await writeSecureFile(indexPath(), Array.from(new Set(keys)).sort().join('\n') + '\n');
}

/** macOS `security` / Linux `secret-tool` backed store. Names tracked in an index. */
export class KeychainStore implements CredentialStore {
  readonly backend = 'keychain' as const;
  private readonly runner: CommandRunner;
  private readonly platform: NodeJS.Platform;

  constructor(runner: CommandRunner, platform: NodeJS.Platform = process.platform) {
    this.runner = runner;
    this.platform = platform;
  }

  async get(key: string): Promise<string | null> {
    if (this.platform === 'darwin') {
      const res = await this.runner.run(
        'security',
        ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service(key), '-w'],
        { allowFailure: true },
      );
      return res.code === 0 ? res.stdout.replace(/\n$/, '') : null;
    }
    const res = await this.runner.run(
      'secret-tool',
      ['lookup', 'service', service(key), 'account', KEYCHAIN_ACCOUNT],
      { allowFailure: true },
    );
    return res.code === 0 && res.stdout ? res.stdout.replace(/\n$/, '') : null;
  }

  async set(key: string, value: string): Promise<void> {
    if (this.platform === 'darwin') {
      await this.runner.run(
        'security',
        ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service(key), '-w', value, '-U'],
      );
    } else {
      await this.runner.run(
        'secret-tool',
        ['store', '--label', service(key), 'service', service(key), 'account', KEYCHAIN_ACCOUNT],
        { input: value },
      );
    }
    const idx = await readIndex();
    if (!idx.includes(key)) await writeIndex([...idx, key]);
  }

  async delete(key: string): Promise<boolean> {
    let ok = false;
    if (this.platform === 'darwin') {
      const res = await this.runner.run(
        'security',
        ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service(key)],
        { allowFailure: true },
      );
      ok = res.code === 0;
    } else {
      const res = await this.runner.run(
        'secret-tool',
        ['clear', 'service', service(key), 'account', KEYCHAIN_ACCOUNT],
        { allowFailure: true },
      );
      ok = res.code === 0;
    }
    const idx = await readIndex();
    if (idx.includes(key)) await writeIndex(idx.filter((k) => k !== key));
    return ok;
  }

  async list(): Promise<string[]> {
    return readIndex();
  }
}

/** 0600 JSON file store. Default fallback; deterministic for tests. */
export class FileCredentialStore implements CredentialStore {
  readonly backend = 'file' as const;
  private readonly file: string;

  constructor(file: string = credentialStorePath()) {
    this.file = file;
  }

  private async read(): Promise<Record<string, string>> {
    const text = await readFileIfExists(this.file);
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async write(data: Record<string, string>): Promise<void> {
    await writeSecureFile(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  async get(key: string): Promise<string | null> {
    const data = await this.read();
    return key in data ? data[key]! : null;
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.read();
    data[key] = value;
    await this.write(data);
  }

  async delete(key: string): Promise<boolean> {
    const data = await this.read();
    if (!(key in data)) return false;
    delete data[key];
    await this.write(data);
    return true;
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.read()).sort();
  }
}

/**
 * Pick a credential store. `ENVBEAM_CREDENTIAL_STORE=keychain|file` overrides;
 * otherwise use the keychain when its CLI is present, else the file fallback.
 */
export async function createCredentialStore(runner: CommandRunner): Promise<CredentialStore> {
  const override = process.env.ENVBEAM_CREDENTIAL_STORE;
  if (override === 'file') return new FileCredentialStore();
  if (override === 'keychain') return new KeychainStore(runner);

  if (process.platform === 'darwin' && (await runner.which('security'))) {
    return new KeychainStore(runner);
  }
  if (process.platform === 'linux' && (await runner.which('secret-tool'))) {
    return new KeychainStore(runner);
  }
  // ensure global dir exists for the file store
  if (!(await pathExists(globalDir()))) await fs.mkdir(globalDir(), { recursive: true });
  return new FileCredentialStore();
}
