import pc from 'picocolors';
import { RealCommandRunner } from '../core/util/exec.js';
import { createRegistryStore, isStorageConfigured } from '../core/registry/index.js';
import { loadGlobalConfig } from '../core/config/globalConfig.js';
import { EnvbeamError } from '../core/util/errors.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface DeleteCliOptions extends GlobalCliOptions {
  force?: boolean;
}

/**
 * `envbeam delete <project>` — delete a project from registry and remote storage.
 */
export async function deleteCommand(projectName: string, opts: DeleteCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);

  return runCommand(logger, async () => {
    // Check if storage is configured
    if (!(await isStorageConfigured())) {
      logger.error('Global storage not configured.');
      logger.hint('Run `envbeam setup` to configure S3 storage first.');
      return 1;
    }

    const runner = new RealCommandRunner();
    const store = await createRegistryStore(runner);
    const project = await store.getProject(projectName);

    if (!project) {
      throw new EnvbeamError(`Project "${projectName}" not found in registry.`, { exitCode: 1 });
    }

    // Strong confirmation required
    if (!opts.force) {
      logger.raw('');
      logger.raw(pc.red(pc.bold('⚠️  WARNING: This action is IRREVERSIBLE')));
      logger.raw('');
      logger.raw('This will permanently delete:');
      logger.raw(`  ${pc.red('•')} Project "${projectName}" from the registry`);
      logger.raw(`  ${pc.red('•')} All remote database snapshots`);
      logger.raw(`  ${pc.red('•')} All synced session data`);
      logger.raw('');
      logger.raw(pc.dim('Local files will NOT be deleted.'));
      logger.raw('');

      const confirmName = await prompter.input(
        `Type the project name "${pc.bold(projectName)}" to confirm deletion`,
        '',
      );

      if (confirmName !== projectName) {
        logger.raw('');
        logger.raw('Deletion cancelled.');
        return 1;
      }
    }

    logger.raw('');

    // 1. Delete remote snapshots
    logger.info('Deleting remote snapshots…');
    try {
      await deleteRemoteSnapshots(runner, projectName, logger);
      logger.sub(pc.dim('Remote snapshots deleted.'));
    } catch (err) {
      logger.warn(`Could not delete all snapshots: ${(err as Error).message}`);
    }

    // 2. Delete remote session data
    logger.info('Deleting remote session data…');
    try {
      await deleteRemoteSessionData(runner, projectName, logger);
      logger.sub(pc.dim('Remote session data deleted.'));
    } catch (err) {
      logger.warn(`Could not delete session data: ${(err as Error).message}`);
    }

    // 3. Remove from registry
    logger.info('Removing from registry…');
    await store.unregisterProject(projectName);
    logger.sub(pc.dim('Removed from registry.'));

    logger.raw('');
    logger.success(`Deleted project "${projectName}"`);
    logger.raw(pc.dim('Local files remain at their original location.'));

    return 0;
  });
}

/**
 * Delete all remote snapshots for a project.
 */
async function deleteRemoteSnapshots(
  runner: RealCommandRunner,
  projectName: string,
  logger: ReturnType<typeof makeLogger>,
): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig.storage) return;

  const storage = globalConfig.storage;
  const env = await getS3Env(runner, storage.credentialSource);

  // Sanitize project name for S3 key matching
  const safeName = projectName.replace(/[^A-Za-z0-9._-]/g, '-');

  // List all objects with the project prefix
  const baseArgs: string[] = [];
  if (storage.endpoint) baseArgs.push('--endpoint-url', storage.endpoint);
  if (storage.region) baseArgs.push('--region', storage.region);

  // Use prefix filter to find project snapshots
  const listRes = await runner.run(
    'aws',
    ['s3api', 'list-objects-v2', '--bucket', storage.bucket, '--prefix', safeName, ...baseArgs],
    { allowFailure: true, env },
  );

  if (listRes.code !== 0 || !listRes.stdout.trim()) {
    return; // No objects to delete
  }

  let objects: { Contents?: Array<{ Key?: string }> };
  try {
    objects = JSON.parse(listRes.stdout);
  } catch {
    return;
  }

  const keys = (objects.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k && k.startsWith(safeName));

  if (keys.length === 0) return;

  logger.sub(pc.dim(`Deleting ${keys.length} snapshot(s)…`));

  // Delete each object
  for (const key of keys) {
    await runner.run(
      'aws',
      ['s3', 'rm', `s3://${storage.bucket}/${key}`, ...baseArgs],
      { allowFailure: true, env },
    );
  }
}

/**
 * Delete remote session data for a project.
 */
async function deleteRemoteSessionData(
  runner: RealCommandRunner,
  projectName: string,
  logger: ReturnType<typeof makeLogger>,
): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  if (!globalConfig.storage) return;

  const storage = globalConfig.storage;
  const env = await getS3Env(runner, storage.credentialSource);

  const baseArgs: string[] = [];
  if (storage.endpoint) baseArgs.push('--endpoint-url', storage.endpoint);
  if (storage.region) baseArgs.push('--region', storage.region);

  // Session data is stored with 'sessions/' prefix
  const sessionPrefix = `sessions/${projectName}`;

  const listRes = await runner.run(
    'aws',
    ['s3api', 'list-objects-v2', '--bucket', storage.bucket, '--prefix', sessionPrefix, ...baseArgs],
    { allowFailure: true, env },
  );

  if (listRes.code !== 0 || !listRes.stdout.trim()) {
    return;
  }

  let objects: { Contents?: Array<{ Key?: string }> };
  try {
    objects = JSON.parse(listRes.stdout);
  } catch {
    return;
  }

  const keys = (objects.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => !!k);

  if (keys.length === 0) return;

  logger.sub(pc.dim(`Deleting ${keys.length} session file(s)…`));

  for (const key of keys) {
    await runner.run(
      'aws',
      ['s3', 'rm', `s3://${storage.bucket}/${key}`, ...baseArgs],
      { allowFailure: true, env },
    );
  }
}

/**
 * Get S3 credentials from environment or Doppler.
 */
async function getS3Env(
  runner: RealCommandRunner,
  credentialSource: string,
): Promise<Record<string, string>> {
  // Check environment first
  const accessKey = process.env.ENVBEAM_S3_ACCESS_KEY;
  const secretKey = process.env.ENVBEAM_S3_SECRET_KEY;

  if (accessKey && secretKey) {
    return {
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
    };
  }

  // Try Doppler
  if (credentialSource === 'doppler') {
    const res = await runner.run(
      'doppler',
      ['secrets', '--project', 'envbeam-global', '--config', 'prd', '--json'],
      { allowFailure: true },
    );

    if (res.code === 0) {
      try {
        const secrets = JSON.parse(res.stdout) as Record<string, { computed?: string }>;
        const dopplerAccess = secrets['ENVBEAM_S3_ACCESS_KEY']?.computed;
        const dopplerSecret = secrets['ENVBEAM_S3_SECRET_KEY']?.computed;
        if (dopplerAccess && dopplerSecret) {
          return {
            AWS_ACCESS_KEY_ID: dopplerAccess,
            AWS_SECRET_ACCESS_KEY: dopplerSecret,
          };
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  throw new EnvbeamError('S3 credentials not found.', { exitCode: 2 });
}
