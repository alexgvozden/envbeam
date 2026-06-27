import pc from 'picocolors';
import { RealCommandRunner } from '../core/util/exec.js';
import { loadGlobalConfig, upsertIdentity, removeIdentity } from '../core/config/globalConfig.js';
import type { IdentityDef } from '../core/config/schema.js';
import { identityDefSchema } from '../core/config/schema.js';
import { createCredentialStore } from '../core/identity/store.js';
import { resolveIdentity } from '../core/identity/resolver.js';
import { EnvbeamError } from '../core/util/errors.js';
import { makeLogger, makePrompter, runCommand, type GlobalCliOptions } from './shared.js';

export interface IdentityAddOptions extends GlobalCliOptions {
  type?: string;
  sshHost?: string;
  account?: string;
  profile?: string;
  token?: string;
}

const TYPE_BY_PREFIX: Record<string, string> = {
  github: 'git',
  gitlab: 'git',
  git: 'git',
  bitbucket: 'git',
  doppler: 'doppler',
  onepassword: 'onepassword',
  '1password': 'onepassword',
  op: 'onepassword',
  s3: 's3',
  aws: 's3',
};

function inferType(name: string): string | undefined {
  const prefix = name.split(':')[0]?.toLowerCase();
  return prefix ? TYPE_BY_PREFIX[prefix] : undefined;
}

export async function identityAddCommand(name: string, opts: IdentityAddOptions): Promise<number> {
  const logger = makeLogger(opts);
  const prompter = makePrompter(opts);
  return runCommand(logger, async () => {
    if (!/^[a-z0-9][a-z0-9.+-]*:[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new EnvbeamError(`Identity name must look like "provider:account" (e.g. github:work). Got "${name}".`);
    }
    const type = opts.type ?? inferType(name) ?? (await prompter.input('Identity type (git|doppler|onepassword|s3)', 'git'));

    const def: IdentityDef = { type };
    if (type === 'git') {
      def.sshHost = opts.sshHost ?? (await prompter.input('SSH host alias (~/.ssh/config Host)', name.split(':')[0] ?? ''));
    } else if (type === 'doppler') {
      if (opts.profile) def.profile = opts.profile;
    } else if (type === 'onepassword') {
      def.account = opts.account ?? (await prompter.input('1Password account (e.g. my.1password.com)', ''));
    } else if (type === 's3') {
      def.profile = opts.profile ?? (await prompter.input('AWS profile', 'default'));
    }
    for (const k of Object.keys(def) as (keyof IdentityDef)[]) {
      if (def[k] === '') delete def[k];
    }

    // optional token → credential store (never written to config)
    let token = opts.token;
    if (token === undefined && prompter.interactive && type !== 'git') {
      const entered = await prompter.password(`Token for ${name} (blank to skip; stored in OS keychain)`);
      token = entered || undefined;
    }
    const validated = identityDefSchema.parse(def);
    await upsertIdentity(name, validated);

    if (token) {
      const runner = new RealCommandRunner();
      const store = await createCredentialStore(runner);
      await store.set(name, token);
      logger.sub(pc.dim(`token stored in ${store.backend} store`));
    }

    logger.success(`Added identity ${pc.bold(name)} (type: ${type})`);
    logger.hint(`Reference it from a workspace, e.g. git: { identity: ${name} }. Test with \`envbeam identity test ${name}\`.`);
    return 0;
  });
}

export async function identityListCommand(opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const config = await loadGlobalConfig();
    const runner = new RealCommandRunner();
    const store = await createCredentialStore(runner);
    const stored = new Set(await store.list());

    const names = Object.keys(config.identities);
    if (!names.length) {
      logger.info('No identities defined. Add one with `envbeam identity add <provider:account>`.');
      return 0;
    }
    logger.raw(pc.bold('Identities'));
    for (const name of names.sort()) {
      const def = config.identities[name]!;
      const bits = [
        `type=${def.type}`,
        def.sshHost ? `sshHost=${def.sshHost}` : null,
        def.account ? `account=${def.account}` : null,
        def.profile ? `profile=${def.profile}` : null,
        stored.has(def.tokenRef ?? name) ? pc.green('token✓') : null,
      ].filter(Boolean);
      logger.raw(`  ${pc.bold(name.padEnd(24))} ${pc.dim(bits.join('  '))}`);
    }
    return 0;
  });
}

export async function identityRemoveCommand(name: string, opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const removed = await removeIdentity(name);
    if (!removed) {
      logger.warn(`No identity named "${name}".`);
      return 1;
    }
    const runner = new RealCommandRunner();
    const store = await createCredentialStore(runner);
    await store.delete(name).catch(() => undefined);
    logger.success(`Removed identity ${name}`);
    return 0;
  });
}

export async function identityTestCommand(name: string, opts: GlobalCliOptions): Promise<number> {
  const logger = makeLogger(opts);
  return runCommand(logger, async () => {
    const config = await loadGlobalConfig();
    const runner = new RealCommandRunner();
    const store = await createCredentialStore(runner);
    const id = await resolveIdentity(name, config, store);

    logger.info(`Testing ${pc.bold(name)} (type: ${id.type})…`);
    const result = await testIdentity(id, runner);
    if (result.ok) {
      logger.success(result.detail ?? 'authenticated');
      return 0;
    }
    logger.error(result.detail ?? 'authentication failed');
    if (result.hint) logger.hint(result.hint);
    return 2;
  });
}

async function testIdentity(
  id: import('../core/providers/types.js').ResolvedIdentity,
  runner: RealCommandRunner,
): Promise<{ ok: boolean; detail?: string; hint?: string }> {
  const env: Record<string, string> = { ...id.env };
  switch (id.type) {
    case 'git': {
      if (!id.sshHost) return { ok: false, detail: 'no sshHost configured', hint: 'Set sshHost on the identity.' };
      const res = await runner.run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-T', `git@${id.sshHost}`], { allowFailure: true, timeout: 15000 });
      const text = res.stdout + res.stderr;
      if (/successfully authenticated|welcome to gitlab|logged in as/i.test(text)) {
        return { ok: true, detail: `SSH to ${id.sshHost} authenticated` };
      }
      return { ok: false, detail: `SSH to ${id.sshHost} did not authenticate`, hint: 'Check ~/.ssh/config and that the key is added.' };
    }
    case 'doppler': {
      if (id.token) env.DOPPLER_TOKEN = id.token;
      const res = await runner.run('doppler', ['me', '--json'], { allowFailure: true, env });
      return res.code === 0 ? { ok: true, detail: 'Doppler authenticated' } : { ok: false, detail: 'Doppler not authenticated', hint: 'Run `doppler login` or provide a token.' };
    }
    case 'onepassword': {
      if (id.account) env.OP_ACCOUNT = id.account;
      if (id.token) env.OP_SERVICE_ACCOUNT_TOKEN = id.token;
      const res = await runner.run('op', ['whoami'], { allowFailure: true, env });
      return res.code === 0 ? { ok: true, detail: '1Password authenticated' } : { ok: false, detail: '1Password not signed in', hint: 'Run `op signin` or set a service-account token.' };
    }
    case 's3': {
      const args = ['sts', 'get-caller-identity'];
      if (id.profile) args.push('--profile', id.profile);
      const res = await runner.run('aws', args, { allowFailure: true, env });
      return res.code === 0 ? { ok: true, detail: 'AWS credentials valid' } : { ok: false, detail: 'AWS credentials invalid', hint: 'Check the AWS profile / credentials.' };
    }
    default:
      return { ok: false, detail: `no test routine for type "${id.type}"` };
  }
}
