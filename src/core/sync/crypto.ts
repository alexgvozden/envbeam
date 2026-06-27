import type { ProviderContext } from '../providers/types.js';
import type { SyncConfig } from '../config/schema.js';
import { EnvbeamError } from '../util/errors.js';

/**
 * At-rest encryption for snapshot files. Wraps the `age` or `gpg` CLI; envbeam
 * never implements crypto itself. Returns the (possibly new) file path and the
 * extension suffix to append to the uploaded name.
 */
export function encryptionSuffix(cfg: SyncConfig | undefined): string {
  if (!cfg || cfg.encrypt === 'none') return '';
  return cfg.encrypt === 'age' ? '.age' : '.gpg';
}

export async function encryptFile(
  ctx: ProviderContext,
  cfg: SyncConfig,
  inFile: string,
  outFile: string,
): Promise<void> {
  if (cfg.encrypt === 'age') {
    if (!cfg.recipient) {
      throw new EnvbeamError('sync.encrypt: age requires sync.recipient (an age public key).', {
        exitCode: 2,
      });
    }
    await ctx.runner.run('age', ['-r', cfg.recipient, '-o', outFile, inFile], {
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
    // age -d uses the recipient's identity from default key locations (~/.config/age)
    // or the AGE_IDENTITY env var, which the caller can supply via the sync identity.
    await ctx.runner.run('age', ['-d', '-o', outFile, inFile], { cwd: ctx.workspaceRoot });
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
