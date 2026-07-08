import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ProviderContext } from '../providers/types.js';
import type { SyncConfig } from '../config/schema.js';
import { EnvbeamError } from '../util/errors.js';
import { getGlobalEncryptionConfig, injectEncryptionEnv } from '../storage/global.js';

/**
 * At-rest encryption for snapshot files. Wraps the `age` or `gpg` CLI; envbeam
 * never implements crypto itself. Returns the (possibly new) file path and the
 * extension suffix to append to the uploaded name.
 */
export function encryptionSuffix(cfg: SyncConfig | undefined): string {
  if (!cfg || cfg.encrypt === 'none') return '';
  return cfg.encrypt === 'age' ? '.age' : '.gpg';
}

/** Encryption implied by a stored file's extension (source of truth on restore). */
export function detectEncryptFromName(name: string): 'age' | 'gpg' | 'none' {
  if (name.endsWith('.age')) return 'age';
  if (name.endsWith('.gpg')) return 'gpg';
  return 'none';
}

/**
 * Ensure age keys are present in the environment, fetching them from the global
 * Doppler config if needed. Returns which halves are available.
 */
export async function ensureAgeKeys(ctx: ProviderContext): Promise<{ pub: boolean; priv: boolean }> {
  if (!process.env.ENVBEAM_AGE_PUBLIC_KEY || !process.env.ENVBEAM_AGE_PRIVATE_KEY) {
    const cfg = await getGlobalEncryptionConfig(ctx.runner);
    if (cfg) injectEncryptionEnv(cfg);
  }
  return { pub: !!process.env.ENVBEAM_AGE_PUBLIC_KEY, priv: !!process.env.ENVBEAM_AGE_PRIVATE_KEY };
}

/**
 * Get age public key from: config.recipient > ENVBEAM_AGE_PUBLIC_KEY env var
 */
function getAgePublicKey(cfg: SyncConfig): string | undefined {
  return cfg.recipient ?? process.env.ENVBEAM_AGE_PUBLIC_KEY;
}

/**
 * Get age private key from ENVBEAM_AGE_PRIVATE_KEY env var
 */
function getAgePrivateKey(): string | undefined {
  return process.env.ENVBEAM_AGE_PRIVATE_KEY;
}

export async function encryptFile(
  ctx: ProviderContext,
  cfg: SyncConfig,
  inFile: string,
  outFile: string,
): Promise<void> {
  if (cfg.encrypt === 'age') {
    const recipient = getAgePublicKey(cfg);
    if (!recipient) {
      throw new EnvbeamError(
        'age encryption requires a public key. Set sync.recipient in config or run `envbeam storage setup`.',
        { exitCode: 2 },
      );
    }
    await ctx.runner.run('age', ['-r', recipient, '-o', outFile, inFile], {
      cwd: ctx.workspaceRoot,
    });
  } else if (cfg.encrypt === 'gpg') {
    if (!cfg.recipient) {
      throw new EnvbeamError('sync.encrypt: gpg requires sync.recipient (a key id/email).', {
        exitCode: 2,
      });
    }
    await ctx.runner.run(
      'gpg',
      ['--batch', '--yes', '--encrypt', '--recipient', cfg.recipient, '--output', outFile, inFile],
      { cwd: ctx.workspaceRoot },
    );
  }
}

export async function decryptFile(
  ctx: ProviderContext,
  cfg: SyncConfig,
  inFile: string,
  outFile: string,
): Promise<void> {
  if (cfg.encrypt === 'age') {
    const privateKey = getAgePrivateKey();
    if (privateKey) {
      // Write the private key inside a fresh 0700 dir (mkdtemp gives a
      // unique, unpredictable, owner-only path) — never a predictable name in
      // the world-traversable tmpdir where a symlink could redirect the write.
      const keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'envbeam-age-'));
      const tempKeyFile = path.join(keyDir, 'key.txt');
      try {
        await fs.writeFile(tempKeyFile, privateKey + '\n', { mode: 0o600, flag: 'wx' });
        await ctx.runner.run('age', ['-d', '-i', tempKeyFile, '-o', outFile, inFile], {
          cwd: ctx.workspaceRoot,
        });
      } finally {
        await fs.rm(keyDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      // Fall back to default identity locations
      await ctx.runner.run('age', ['-d', '-o', outFile, inFile], { cwd: ctx.workspaceRoot });
    }
  } else if (cfg.encrypt === 'gpg') {
    await ctx.runner.run('gpg', ['--batch', '--yes', '--decrypt', '--output', outFile, inFile], {
      cwd: ctx.workspaceRoot,
    });
  }
}

export function requiredCryptoTools(cfg: SyncConfig | undefined): string[] {
  if (!cfg || cfg.encrypt === 'none') return [];
  return [cfg.encrypt];
}
