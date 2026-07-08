import type { SyncConfig } from '../config/schema.js';
import type { ResolvedIdentity } from '../providers/types.js';
import { EnvbeamError } from '../util/errors.js';
import type { SyncTarget } from './types.js';
import { LocalFolderTarget } from './localFolder.js';
import { S3Target } from './s3.js';

export * from './types.js';
export {
  encryptionSuffix,
  encryptFile,
  decryptFile,
  requiredCryptoTools,
  detectEncryptFromName,
  ensureAgeKeys,
} from './crypto.js';
export { sha256File, readManifest, recordArtifactHash, verifyArtifact, type VerifyResult } from './integrity.js';

/** Build the configured sync target, resolving the identity where relevant. */
export function createSyncTarget(cfg: SyncConfig, identity?: ResolvedIdentity): SyncTarget {
  switch (cfg.target) {
    case 'local-folder':
      return new LocalFolderTarget(cfg, 'local-folder');
    case 'syncthing':
      return new LocalFolderTarget(cfg, 'syncthing');
    case 's3':
      return new S3Target(cfg, identity?.profile);
    default:
      throw new EnvbeamError(`Unknown sync target: ${String(cfg.target)}`, { exitCode: 2 });
  }
}

/** External tools a sync target needs (for doctor). */
export function syncTargetTools(cfg: SyncConfig): string[] {
  return cfg.target === 's3' ? ['aws'] : [];
}
