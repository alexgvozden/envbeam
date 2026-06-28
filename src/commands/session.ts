import pc from 'picocolors';
import { RealCommandRunner } from '../core/util/exec.js';
import { EnvbeamError } from '../core/util/errors.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

const DOPPLER_PROJECT = 'envbeam-global';
const DOPPLER_CONFIG = 'prd';

export interface SessionSetupOptions extends GlobalCliOptions {
  scope?: string;
}

/**
 * `envbeam session setup` — configure Claude session sync.
 * Requires storage to be configured first. Generates encryption keys.
 */
export async function sessionSetupCommand(opts: SessionSetupOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);

  return runCommand(logger, async () => {
    const runner = new RealCommandRunner();

    // 1. Check Doppler CLI
    const dopplerPath = await runner.which('doppler');
    if (!dopplerPath) {
      throw new EnvbeamError(
        'Doppler CLI not found. Install it first: https://docs.doppler.com/docs/install-cli',
        { exitCode: 2 },
      );
    }

    // 2. Check storage is configured
    logger.info('Checking storage configuration…');
    const secretsRes = await runner.run(
      'doppler',
      ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
      { allowFailure: true },
    );

    let hasStorage = false;
    if (secretsRes.code === 0) {
      try {
        const secrets = JSON.parse(secretsRes.stdout) as Record<string, { computed?: string }>;
        hasStorage = !!(secrets['ENVBEAM_S3_BUCKET']?.computed);
      } catch {
        /* ignore */
      }
    }

    if (!hasStorage) {
      logger.error('Storage not configured.');
      logger.hint('Run `envbeam storage setup` first to configure S3 storage.');
      return 1;
    }
    logger.sub('Storage configured ✓');

    // 3. Check age is installed
    const ageInstalled = await runner.which('age-keygen');
    if (!ageInstalled) {
      throw new EnvbeamError(
        'age-keygen not found. Install age: https://github.com/FiloSottile/age#installation',
        { exitCode: 2 },
      );
    }

    // 4. Prompt for session scope
    logger.raw('');
    logger.raw(pc.bold('Claude Session Sync Configuration'));
    logger.raw('');

    const scope =
      opts.scope ??
      (await prompter.select(
        'Session scope',
        [
          { name: 'project — ~/.claude/projects/<path>/ (this project only)', value: 'project' },
          { name: 'workspace — .claude/ folder in repo', value: 'workspace' },
          { name: 'global — ~/.claude/ (all sessions, tools, plugins)', value: 'global' },
        ],
        'project',
      ));

    // 5. Generate encryption keys
    logger.raw('');
    logger.info('Generating encryption keys…');

    const keygenRes = await runner.run('age-keygen', [], { allowFailure: true });
    if (keygenRes.code !== 0) {
      throw new EnvbeamError(`Failed to generate age keys: ${keygenRes.stderr}`, { exitCode: 2 });
    }

    const privateKey = keygenRes.stdout.trim();
    const pubKeyMatch = keygenRes.stderr.match(/public key: (age1[a-z0-9]+)/i);
    if (!pubKeyMatch || !privateKey.startsWith('AGE-SECRET-KEY-')) {
      throw new EnvbeamError('Failed to parse age-keygen output', { exitCode: 2 });
    }
    const publicKey = pubKeyMatch[1]!;
    logger.sub(`Generated key: ${publicKey.slice(0, 20)}...`);

    // 6. Store keys in Doppler
    logger.info('Storing encryption keys in Doppler…');

    const secrets: Array<[string, string]> = [
      ['ENVBEAM_AGE_PUBLIC_KEY', publicKey],
      ['ENVBEAM_AGE_PRIVATE_KEY', privateKey],
      ['ENVBEAM_SESSION_SCOPE', scope],
    ];

    const secretArgs = secrets.map(([k, v]) => `${k}=${v}`);
    const uploadRes = await runner.run(
      'doppler',
      ['secrets', 'set', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, ...secretArgs],
      { allowFailure: true },
    );

    if (uploadRes.code !== 0) {
      throw new EnvbeamError(`Failed to store keys: ${uploadRes.stderr}`, { exitCode: 2 });
    }

    logger.raw('');
    logger.success('Session sync configured.');
    logger.raw('');
    logger.raw(pc.dim('  Scope: ') + scope);
    logger.raw(pc.dim('  Encryption: ') + 'age (keys stored in Doppler)');
    logger.raw('');
    logger.hint('Add to your .envbeam.yaml:');
    logger.raw(pc.cyan(`  session:
    provider: claude-native
    scope: ${scope}`));

    return 0;
  });
}

/**
 * `envbeam session status` — show Claude session sync configuration.
 */
export async function sessionStatusCommand(opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);

  return runCommand(logger, async () => {
    const runner = new RealCommandRunner();

    logger.raw(pc.bold('Session Sync Configuration'));
    logger.raw('');

    // Check Doppler for session config
    const secretsRes = await runner.run(
      'doppler',
      ['secrets', '--project', DOPPLER_PROJECT, '--config', DOPPLER_CONFIG, '--json'],
      { allowFailure: true },
    );

    let hasStorage = false;
    let hasEncryptionKeys = false;
    let agePublicKey: string | undefined;
    let sessionScope: string | undefined;

    if (secretsRes.code === 0) {
      try {
        const secrets = JSON.parse(secretsRes.stdout) as Record<string, { computed?: string }>;
        hasStorage = !!(secrets['ENVBEAM_S3_BUCKET']?.computed);
        hasEncryptionKeys = !!(
          secrets['ENVBEAM_AGE_PUBLIC_KEY']?.computed &&
          secrets['ENVBEAM_AGE_PRIVATE_KEY']?.computed
        );
        agePublicKey = secrets['ENVBEAM_AGE_PUBLIC_KEY']?.computed;
        sessionScope = secrets['ENVBEAM_SESSION_SCOPE']?.computed;
      } catch {
        /* ignore */
      }
    }

    // Storage prerequisite
    if (!hasStorage) {
      logger.raw(pc.red('✗') + ' Storage not configured');
      logger.hint('Run `envbeam storage setup` first.');
      return 1;
    }
    logger.raw(pc.green('✓') + ' Storage configured');

    // Encryption keys
    if (hasEncryptionKeys) {
      const keyPreview = agePublicKey ? agePublicKey.slice(0, 20) + '...' : '';
      logger.raw(pc.green('✓') + ` Encryption keys configured ${pc.dim(`(${keyPreview})`)}`);
    } else {
      logger.raw(pc.yellow('!') + ' Encryption keys not configured');
      logger.hint('Run `envbeam session setup` to generate keys.');
      return 0;
    }

    // Scope
    if (sessionScope) {
      logger.raw(pc.green('✓') + ` Scope: ${sessionScope}`);
    }

    logger.raw('');
    logger.raw(pc.dim('Session data will be encrypted with age before upload.'));

    return 0;
  });
}
