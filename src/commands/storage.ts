import pc from 'picocolors';
import { RealCommandRunner, type CommandRunner } from '../core/util/exec.js';
import { EnvbeamError } from '../core/util/errors.js';
import { ensureTools } from '../core/util/tools.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';
import { saveStorageConfig, RegistryStore } from '../core/registry/index.js';
import type { GlobalStorageConfig } from '../core/config/schema.js';
import { loadGlobalConfig } from '../core/config/globalConfig.js';

export interface StorageSetupOptions extends GlobalCliOptions {
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

const DOPPLER_PROJECT = 'envbeam-global';
const DOPPLER_CONFIG = 'prd';

/**
 * Known S3-compatible storage providers. envbeam works with ANY S3-compatible
 * service — these presets just pre-fill the endpoint/region so the user doesn't
 * have to look them up. "custom" covers anything not listed (MinIO, Ceph, etc.).
 * The AWS CLI is used as the S3 client for all of them; it is not tied to AWS S3.
 */
interface StorageProvider {
  value: string;
  name: string;
  /** Example endpoint shown as the input default/placeholder. Empty = use AWS default endpoint. */
  endpointHint: string;
  /** Default region. */
  region: string;
}

const STORAGE_PROVIDERS: StorageProvider[] = [
  { value: 'r2', name: 'Cloudflare R2', endpointHint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto' },
  { value: 'hetzner', name: 'Hetzner Object Storage', endpointHint: 'https://fsn1.your-objectstorage.com', region: 'fsn1' },
  { value: 'b2', name: 'Backblaze B2', endpointHint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004' },
  { value: 'aws', name: 'AWS S3', endpointHint: '', region: 'us-east-1' },
  { value: 'custom', name: 'Other S3-compatible (MinIO, Ceph, …)', endpointHint: 'https://s3.example.com', region: 'auto' },
];

interface S3Credentials {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}

/**
 * Read existing ENVBEAM_S3_* secrets from the global Doppler project, if any.
 * Returns null when no usable storage config is present.
 */
export async function readExistingDopplerStorage(
  runner: CommandRunner,
): Promise<S3Credentials | null> {
  const res = await runner.run(
    'doppler',
    ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
    { allowFailure: true },
  );
  if (res.code !== 0) return null;
  let parsed: Record<string, { computed?: string }>;
  try {
    parsed = JSON.parse(res.stdout) as Record<string, { computed?: string }>;
  } catch {
    return null;
  }
  const get = (k: string) => parsed[k]?.computed ?? '';
  const bucket = get('ENVBEAM_S3_BUCKET');
  const accessKey = get('ENVBEAM_S3_ACCESS_KEY');
  const secretKey = get('ENVBEAM_S3_SECRET_KEY');
  // Need at least a bucket + credentials to count as configured.
  if (!bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: get('ENVBEAM_S3_ENDPOINT'),
    bucket,
    region: get('ENVBEAM_S3_REGION') || 'auto',
    accessKey,
    secretKey,
  };
}

/**
 * `envbeam storage setup` — configure global S3-compatible storage for database snapshots.
 *
 * Works with any S3-compatible provider (Cloudflare R2, Hetzner, Backblaze B2,
 * AWS S3, MinIO, …); a provider picker pre-fills the endpoint/region. The AWS CLI
 * is used purely as the S3 client. Credentials are stored in Doppler under the
 * envbeam-global project, and existing ENVBEAM_S3_* settings there can be reused.
 */
export async function storageSetupCommand(opts: StorageSetupOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);

  return runCommand(logger, async () => {
    const runner = new RealCommandRunner();

    // 1. Ensure Doppler (where credentials are stored). The AWS CLI is checked
    //    later, once we know we're proceeding — it's the S3 client for whatever
    //    provider you choose, not a sign that AWS S3 is assumed.
    logger.info('Checking required tools…');
    const dopplerTool = await ensureTools(['doppler'], runner, logger, prompter);
    if (!dopplerTool.allInstalled) {
      throw new EnvbeamError(`Missing required tools: ${dopplerTool.missing.join(', ')}`, { exitCode: 2 });
    }

    // 2. Check Doppler is authenticated
    const meRes = await runner.run('doppler', ['me', '--json'], { allowFailure: true });
    if (meRes.code !== 0) {
      throw new EnvbeamError('Doppler not authenticated. Run `doppler login` first.', { exitCode: 2 });
    }

    // 3. Check/create the envbeam-global project
    logger.info(`Ensuring Doppler project "${DOPPLER_PROJECT}" exists…`);
    const projectsRes = await runner.run('doppler', ['projects', '--json'], { allowFailure: true });
    let projectExists = false;
    if (projectsRes.code === 0) {
      try {
        const projects = JSON.parse(projectsRes.stdout) as Array<{ name?: string; slug?: string }>;
        projectExists = projects.some((p) => p.slug === DOPPLER_PROJECT || p.name === DOPPLER_PROJECT);
      } catch {
        /* ignore parse error */
      }
    }

    if (!projectExists) {
      logger.sub(`Creating project "${DOPPLER_PROJECT}"…`);
      const createRes = await runner.run('doppler', ['projects', 'create', DOPPLER_PROJECT], { allowFailure: true });
      if (createRes.code !== 0) {
        throw new EnvbeamError(`Failed to create Doppler project: ${createRes.stderr}`, { exitCode: 2 });
      }
    } else {
      logger.sub(pc.dim(`Project "${DOPPLER_PROJECT}" already exists.`));
    }

    // 4. Determine S3 credentials — either reuse what's already in Doppler,
    //    or collect fresh ones after picking a provider.
    let endpoint = '';
    let bucket = '';
    let region = 'auto';
    let accessKey = '';
    let secretKey = '';
    let reusedExisting = false;

    // Any credential passed on the CLI means non-interactive intent; skip reuse.
    const hasCliCreds =
      opts.endpoint || opts.bucket || opts.region || opts.accessKey || opts.secretKey;

    if (!hasCliCreds) {
      const existing = await readExistingDopplerStorage(runner);
      if (existing) {
        logger.raw('');
        logger.raw(pc.bold('Existing storage settings found in Doppler'));
        logger.raw(pc.dim(`  Bucket:   ${existing.bucket}`));
        logger.raw(pc.dim(`  Endpoint: ${existing.endpoint || '(AWS default)'}`));
        logger.raw(pc.dim(`  Region:   ${existing.region}`));
        logger.raw('');
        const reuse = await prompter.confirm('Use these existing storage settings?', true);
        if (reuse) {
          ({ endpoint, bucket, region, accessKey, secretKey } = existing);
          reusedExisting = true;
        }
      }
    }

    if (!reusedExisting) {
      logger.raw('');
      logger.raw(pc.bold('S3-compatible Storage Configuration'));
      logger.raw(pc.dim('envbeam works with any S3-compatible service. Pick yours to pre-fill the'));
      logger.raw(pc.dim('endpoint (the AWS CLI is used as the S3 client for all of them).'));
      logger.raw('');

      const providerId =
        hasCliCreds
          ? 'custom'
          : await prompter.select(
              'Storage provider',
              STORAGE_PROVIDERS.map((p) => ({ name: p.name, value: p.value })),
              'r2',
            );
      const provider = STORAGE_PROVIDERS.find((p) => p.value === providerId) ?? STORAGE_PROVIDERS[4]!;

      endpoint = opts.endpoint ?? (await prompter.input('S3 endpoint URL', provider.endpointHint));
      // AWS S3 needs no custom endpoint; everything else does.
      if (!endpoint && provider.value !== 'aws') {
        throw new EnvbeamError('Endpoint is required for S3-compatible storage.', { exitCode: 2 });
      }
      // Auto-add https:// if no protocol specified
      if (endpoint && !endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
        endpoint = `https://${endpoint}`;
      }

      bucket = opts.bucket ?? (await prompter.input('Bucket name', ''));
      if (!bucket) {
        throw new EnvbeamError('Bucket name is required.', { exitCode: 2 });
      }

      region = opts.region ?? (await prompter.input('Region (e.g. fsn1, us-east-1)', provider.region));

      accessKey = opts.accessKey ?? (await prompter.input('Access Key ID', ''));
      if (!accessKey) {
        throw new EnvbeamError('Access Key ID is required.', { exitCode: 2 });
      }

      secretKey = opts.secretKey ?? (await prompter.password('Secret Access Key'));
      if (!secretKey) {
        throw new EnvbeamError('Secret Access Key is required.', { exitCode: 2 });
      }
    }

    // 5. Ensure the AWS CLI (S3 client) now that we're committed to proceeding.
    const awsTool = await ensureTools(['aws'], runner, logger, prompter);
    if (!awsTool.allInstalled) {
      throw new EnvbeamError(`Missing required tools: ${awsTool.missing.join(', ')}`, { exitCode: 2 });
    }

    // 6. Upload secrets to Doppler (skip when reusing what's already there).
    if (!reusedExisting) {
      logger.raw('');
      logger.info('Storing credentials in Doppler…');

      const secrets: Array<[string, string]> = [
        ['ENVBEAM_S3_ENDPOINT', endpoint],
        ['ENVBEAM_S3_BUCKET', bucket],
        ['ENVBEAM_S3_REGION', region],
        ['ENVBEAM_S3_ACCESS_KEY', accessKey],
        ['ENVBEAM_S3_SECRET_KEY', secretKey],
      ];

      // Use `doppler secrets set KEY=VALUE ...` to set multiple secrets,
      // skipping empties (e.g. endpoint when using native AWS S3).
      const secretArgs = secrets.filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`);
      const uploadRes = await runner.run(
        'doppler',
        ['secrets', 'set', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, ...secretArgs],
        { allowFailure: true },
      );

      if (uploadRes.code !== 0) {
        throw new EnvbeamError(`Failed to upload secrets to Doppler: ${uploadRes.stderr}`, { exitCode: 2 });
      }
    } else {
      logger.sub(pc.dim('Reusing existing Doppler credentials — nothing to upload.'));
    }

    // 7. Test connectivity
    logger.info('Testing S3 connectivity…');
    const testRes = await runner.run(
      'aws',
      [
        's3api',
        'head-bucket',
        '--bucket',
        bucket,
        ...(endpoint ? ['--endpoint-url', endpoint] : []),
        '--region',
        region,
      ],
      {
        allowFailure: true,
        env: {
          AWS_ACCESS_KEY_ID: accessKey,
          AWS_SECRET_ACCESS_KEY: secretKey,
        },
      },
    );

    if (testRes.code === 0) {
      logger.success(`Connected to bucket "${bucket}" successfully.`);
    } else {
      logger.warn(`Could not verify bucket access: ${testRes.stderr.trim() || 'unknown error'}`);
      logger.hint('Credentials were saved. You may need to check bucket permissions or endpoint URL.');
    }

    // 8. Save storage config to global config
    logger.info('Saving storage configuration…');
    const storageConfig: GlobalStorageConfig = {
      type: 's3',
      bucket,
      region,
      ...(endpoint ? { endpoint } : {}),
      credentialSource: 'doppler',
    };
    await saveStorageConfig(storageConfig);

    // 9. Initialize registry in S3
    logger.info('Initializing project registry…');
    const registryStore = new RegistryStore(storageConfig, runner);

    // Temporarily set env vars for registry initialization
    process.env.ENVBEAM_S3_ACCESS_KEY = accessKey;
    process.env.ENVBEAM_S3_SECRET_KEY = secretKey;
    if (endpoint) process.env.ENVBEAM_S3_ENDPOINT = endpoint;
    process.env.ENVBEAM_S3_BUCKET = bucket;
    process.env.ENVBEAM_S3_REGION = region;

    const created = await registryStore.initializeIfNeeded();
    if (created) {
      logger.sub('Created empty project registry.');
    } else {
      logger.sub(pc.dim('Project registry already exists.'));
    }

    logger.raw('');
    logger.success('Storage and registry configured successfully.');
    logger.hint(`To use in workspaces, run: doppler run -p ${DOPPLER_PROJECT} -c ${DOPPLER_CONFIG} -- envbeam push`);
    logger.hint('Or set ENVBEAM_S3_* variables in your shell / secrets provider.');

    return 0;
  });
}

/**
 * `envbeam storage status` — show current storage configuration.
 */
export async function storageStatusCommand(opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);

  return runCommand(logger, async () => {
    const runner = new RealCommandRunner();

    // Check environment variables
    const envVars = {
      ENVBEAM_S3_ENDPOINT: process.env.ENVBEAM_S3_ENDPOINT,
      ENVBEAM_S3_BUCKET: process.env.ENVBEAM_S3_BUCKET,
      ENVBEAM_S3_REGION: process.env.ENVBEAM_S3_REGION,
      ENVBEAM_S3_ACCESS_KEY: process.env.ENVBEAM_S3_ACCESS_KEY ? '***' : undefined,
      ENVBEAM_S3_SECRET_KEY: process.env.ENVBEAM_S3_SECRET_KEY ? '***' : undefined,
    };
    const hasEnvConfig = Object.values(envVars).some(Boolean);

    // Check Doppler global project
    let hasDopplerGlobal = false;
    let dopplerBucket: string | undefined;
    let dopplerEndpoint: string | undefined;
    const secretsRes = await runner.run(
      'doppler',
      ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
      { allowFailure: true },
    );
    if (secretsRes.code === 0) {
      try {
        const secrets = JSON.parse(secretsRes.stdout) as Record<string, { computed?: string }>;
        hasDopplerGlobal = Object.keys(secrets).some((k) => k.startsWith('ENVBEAM_S3_'));
        dopplerBucket = secrets['ENVBEAM_S3_BUCKET']?.computed;
        dopplerEndpoint = secrets['ENVBEAM_S3_ENDPOINT']?.computed;
      } catch {
        /* ignore parse errors */
      }
    }

    logger.raw(pc.bold('Storage Configuration'));
    logger.raw('');

    // Check global config for storage settings
    const globalConfig = await loadGlobalConfig();
    const hasGlobalStorage = !!globalConfig.storage;

    if (hasEnvConfig) {
      // Environment is active (injected or manually set)
      logger.raw(pc.green('✓') + ' S3 storage active:');
      for (const [key, value] of Object.entries(envVars)) {
        if (value) {
          logger.raw(`  ${key.padEnd(24)} ${pc.dim(value)}`);
        }
      }
    } else if (hasDopplerGlobal || hasGlobalStorage) {
      // Global storage configured
      const bucket = dopplerBucket || globalConfig.storage?.bucket || '';
      const endpoint = dopplerEndpoint || globalConfig.storage?.endpoint || '';
      const bucketInfo = bucket ? ` (${bucket})` : '';
      const endpointInfo = endpoint ? ` via ${endpoint}` : '';
      logger.raw(pc.green('✓') + ` Global storage configured${bucketInfo}${endpointInfo}`);
      logger.raw(pc.dim('  Credentials auto-loaded from Doppler when needed.'));
    } else {
      // No storage configured
      logger.raw(pc.yellow('!') + ' No storage configured.');
      logger.hint('Run `envbeam storage setup` to configure global S3 storage.');
    }

    // Show registry status if storage is configured
    if (hasEnvConfig || hasDopplerGlobal || hasGlobalStorage) {
      logger.raw('');
      logger.raw(pc.bold('Project Registry'));

      try {
        const { RegistryStore } = await import('../core/registry/index.js');
        const storage = globalConfig.storage || {
          type: 's3' as const,
          bucket: dopplerBucket || process.env.ENVBEAM_S3_BUCKET || '',
          region: process.env.ENVBEAM_S3_REGION,
          endpoint: dopplerEndpoint || process.env.ENVBEAM_S3_ENDPOINT,
          credentialSource: 'doppler' as const,
        };
        const registryStore = new RegistryStore(storage, runner);
        const projects = await registryStore.listProjects();
        logger.raw(pc.green('✓') + ` ${projects.length} project(s) registered`);
        if (projects.length > 0 && projects.length <= 5) {
          for (const p of projects) {
            logger.raw(pc.dim(`  • ${p.name}`));
          }
        } else if (projects.length > 5) {
          logger.raw(pc.dim(`  Run 'envbeam list' to see all projects.`));
        }
      } catch (err) {
        logger.raw(pc.yellow('!') + ` Could not load registry: ${(err as Error).message}`);
      }
    }

    return 0;
  });
}
