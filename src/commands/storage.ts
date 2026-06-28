import pc from 'picocolors';
import { RealCommandRunner } from '../core/util/exec.js';
import { EnvbeamError } from '../core/util/errors.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

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
 * `envbeam storage setup` — configure global S3-compatible storage for database snapshots.
 * Stores credentials in Doppler under the envbeam-global project.
 */
export async function storageSetupCommand(opts: StorageSetupOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);

  return runCommand(logger, async () => {
    const runner = new RealCommandRunner();

    // 1. Check Doppler CLI is installed
    logger.info('Checking Doppler CLI…');
    const dopplerPath = await runner.which('doppler');
    if (!dopplerPath) {
      throw new EnvbeamError(
        'Doppler CLI not found. Install it first: https://docs.doppler.com/docs/install-cli',
        { exitCode: 2 },
      );
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

    // 4. Collect S3 credentials
    logger.raw('');
    logger.raw(pc.bold('S3-compatible Storage Configuration'));
    logger.raw(pc.dim('For Hetzner Object Storage, MinIO, or other S3-compatible services.'));
    logger.raw('');

    let endpoint =
      opts.endpoint ??
      (await prompter.input(
        'S3 endpoint URL (e.g. https://fsn1.your-objectstorage.com)',
        '',
      ));
    if (!endpoint) {
      throw new EnvbeamError('Endpoint is required for S3-compatible storage.', { exitCode: 2 });
    }
    // Auto-add https:// if no protocol specified
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      endpoint = `https://${endpoint}`;
    }

    const bucket =
      opts.bucket ?? (await prompter.input('Bucket name', ''));
    if (!bucket) {
      throw new EnvbeamError('Bucket name is required.', { exitCode: 2 });
    }

    const region =
      opts.region ?? (await prompter.input('Region (e.g. fsn1, us-east-1)', 'auto'));

    const accessKey =
      opts.accessKey ?? (await prompter.input('Access Key ID', ''));
    if (!accessKey) {
      throw new EnvbeamError('Access Key ID is required.', { exitCode: 2 });
    }

    const secretKey =
      opts.secretKey ?? (await prompter.password('Secret Access Key'));
    if (!secretKey) {
      throw new EnvbeamError('Secret Access Key is required.', { exitCode: 2 });
    }

    // 5. Upload secrets to Doppler using `doppler secrets set`
    logger.raw('');
    logger.info('Storing credentials in Doppler…');

    const secrets: Array<[string, string]> = [
      ['ENVBEAM_S3_ENDPOINT', endpoint],
      ['ENVBEAM_S3_BUCKET', bucket],
      ['ENVBEAM_S3_REGION', region],
      ['ENVBEAM_S3_ACCESS_KEY', accessKey],
      ['ENVBEAM_S3_SECRET_KEY', secretKey],
    ];

    // Use `doppler secrets set KEY=VALUE ...` to set multiple secrets
    const secretArgs = secrets.map(([k, v]) => `${k}=${v}`);
    const uploadRes = await runner.run(
      'doppler',
      ['secrets', 'set', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, ...secretArgs],
      { allowFailure: true },
    );

    if (uploadRes.code !== 0) {
      throw new EnvbeamError(`Failed to upload secrets to Doppler: ${uploadRes.stderr}`, { exitCode: 2 });
    }

    // 6. Test connectivity
    logger.info('Testing S3 connectivity…');
    const testRes = await runner.run(
      'aws',
      [
        's3api',
        'head-bucket',
        '--bucket',
        bucket,
        '--endpoint-url',
        endpoint,
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

    logger.raw('');
    logger.success('Storage configuration saved to Doppler.');
    logger.hint(`To use in workspaces, run: doppler run -p ${DOPPLER_PROJECT} -c ${DOPPLER_CONFIG} -- envbeam resume`);
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

    if (hasEnvConfig) {
      // Environment is active (injected or manually set)
      logger.raw(pc.green('✓') + ' S3 storage active:');
      for (const [key, value] of Object.entries(envVars)) {
        if (value) {
          logger.raw(`  ${key.padEnd(24)} ${pc.dim(value)}`);
        }
      }
    } else if (hasDopplerGlobal) {
      // Global storage configured in Doppler
      const bucketInfo = dopplerBucket ? ` (${dopplerBucket})` : '';
      const endpointInfo = dopplerEndpoint ? ` via ${dopplerEndpoint}` : '';
      logger.raw(pc.green('✓') + ` Global storage configured${bucketInfo}${endpointInfo}`);
      logger.raw(pc.dim('  Credentials auto-loaded from Doppler when needed.'));
    } else {
      // No storage configured
      logger.raw(pc.yellow('!') + ' No storage configured.');
      logger.hint('Run `envbeam storage setup` to configure global S3 storage.');
    }

    return 0;
  });
}
