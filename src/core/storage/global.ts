import type { CommandRunner } from '../util/exec.js';

const DOPPLER_PROJECT = 'envbeam-global';
const DOPPLER_CONFIG = 'prd';

export interface GlobalStorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

export interface GlobalEncryptionConfig {
  agePublicKey: string;
  agePrivateKey: string;
}

/**
 * Fetch global storage configuration.
 * Priority: environment variables > Doppler envbeam-global project
 */
export async function getGlobalStorageConfig(runner: CommandRunner): Promise<GlobalStorageConfig | null> {
  // Check environment variables first
  const fromEnv = getFromEnv();
  if (fromEnv) return fromEnv;

  // Try Doppler
  return await getFromDoppler(runner);
}

function getFromEnv(): GlobalStorageConfig | null {
  const endpoint = process.env.ENVBEAM_S3_ENDPOINT;
  const bucket = process.env.ENVBEAM_S3_BUCKET;
  const region = process.env.ENVBEAM_S3_REGION;
  const accessKey = process.env.ENVBEAM_S3_ACCESS_KEY;
  const secretKey = process.env.ENVBEAM_S3_SECRET_KEY;

  if (endpoint && bucket && accessKey && secretKey) {
    return { endpoint, bucket, region: region ?? 'auto', accessKey, secretKey };
  }
  return null;
}

async function getFromDoppler(runner: CommandRunner): Promise<GlobalStorageConfig | null> {
  // Check if doppler CLI exists
  const dopplerPath = await runner.which('doppler');
  if (!dopplerPath) return null;

  const res = await runner.run(
    'doppler',
    ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
    { allowFailure: true },
  );

  if (res.code !== 0) return null;

  try {
    const secrets = JSON.parse(res.stdout) as Record<string, { computed?: string }>;
    const endpoint = secrets['ENVBEAM_S3_ENDPOINT']?.computed;
    const bucket = secrets['ENVBEAM_S3_BUCKET']?.computed;
    const region = secrets['ENVBEAM_S3_REGION']?.computed;
    const accessKey = secrets['ENVBEAM_S3_ACCESS_KEY']?.computed;
    const secretKey = secrets['ENVBEAM_S3_SECRET_KEY']?.computed;

    if (endpoint && bucket && accessKey && secretKey) {
      return { endpoint, bucket, region: region ?? 'auto', accessKey, secretKey };
    }
  } catch {
    /* ignore parse errors */
  }

  return null;
}

/**
 * Inject global storage config into environment variables.
 * Call this before creating S3Target if you want automatic Doppler integration.
 */
export function injectStorageEnv(config: GlobalStorageConfig): void {
  process.env.ENVBEAM_S3_ENDPOINT = config.endpoint;
  process.env.ENVBEAM_S3_BUCKET = config.bucket;
  process.env.ENVBEAM_S3_REGION = config.region;
  process.env.ENVBEAM_S3_ACCESS_KEY = config.accessKey;
  process.env.ENVBEAM_S3_SECRET_KEY = config.secretKey;
}

/**
 * Check if global storage is configured (in env or Doppler).
 */
export async function hasGlobalStorage(runner: CommandRunner): Promise<boolean> {
  return (await getGlobalStorageConfig(runner)) !== null;
}

/**
 * Fetch global encryption config (age keys) from Doppler.
 */
export async function getGlobalEncryptionConfig(runner: CommandRunner): Promise<GlobalEncryptionConfig | null> {
  // Check environment variables first
  const pubKey = process.env.ENVBEAM_AGE_PUBLIC_KEY;
  const privKey = process.env.ENVBEAM_AGE_PRIVATE_KEY;
  if (pubKey && privKey) {
    return { agePublicKey: pubKey, agePrivateKey: privKey };
  }

  // Try Doppler
  const dopplerPath = await runner.which('doppler');
  if (!dopplerPath) return null;

  const res = await runner.run(
    'doppler',
    ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
    { allowFailure: true },
  );

  if (res.code !== 0) return null;

  try {
    const secrets = JSON.parse(res.stdout) as Record<string, { computed?: string }>;
    const agePublicKey = secrets['ENVBEAM_AGE_PUBLIC_KEY']?.computed;
    const agePrivateKey = secrets['ENVBEAM_AGE_PRIVATE_KEY']?.computed;

    if (agePublicKey && agePrivateKey) {
      return { agePublicKey, agePrivateKey };
    }
  } catch {
    /* ignore parse errors */
  }

  return null;
}

/**
 * Inject encryption config into environment variables.
 */
export function injectEncryptionEnv(config: GlobalEncryptionConfig): void {
  process.env.ENVBEAM_AGE_PUBLIC_KEY = config.agePublicKey;
  process.env.ENVBEAM_AGE_PRIVATE_KEY = config.agePrivateKey;
}
