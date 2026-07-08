#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { setCommandTrace } from './core/util/exec.js';
import { initCommand } from './commands/init.js';
import { pullCommand } from './commands/pull.js';
import { pushCommand } from './commands/push.js';
import { listCommand } from './commands/list.js';
import { deleteCommand } from './commands/delete.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import {
  identityAddCommand,
  identityListCommand,
  identityRemoveCommand,
  identityTestCommand,
} from './commands/identity.js';
import {
  configValidateCommand,
  configExplainCommand,
  configSyncCommand,
} from './commands/config.js';
import { storageSetupCommand, storageStatusCommand } from './commands/storage.js';
import { sessionSetupCommand, sessionStatusCommand } from './commands/session.js';
import type { GlobalCliOptions } from './commands/shared.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

// Build stamp written into dist/ at compile time (scripts/write-build-info.mjs).
// Lets us detect when the compiled code is STALE relative to package.json —
// e.g. `git pull` without a rebuild — instead of silently running old code
// while `-V` (which reads package.json at runtime) claims the new version.
interface BuildInfo {
  version: string;
  commit?: string;
  builtAt?: string;
}
let BUILD: BuildInfo | null = null;
try {
  BUILD = require('./build-info.json') as BuildInfo;
} catch {
  /* dev run via tsx, or a build predating the stamp */
}

/** True when executing compiled output (dist/), not tsx over src/. */
const IS_COMPILED = fileURLToPath(import.meta.url).includes(`${path.sep}dist${path.sep}`);
/** The script the shell actually resolved — pinpoints WHICH install is running. */
const CLI_PATH = process.argv[1] ?? fileURLToPath(import.meta.url);
/** Version + build stamp; a stale dist can't masquerade as a fresh version. */
const VERSION_STRING = BUILD?.commit
  ? `${VERSION} (build ${BUILD.commit}${BUILD.builtAt ? `, ${BUILD.builtAt}` : ''})`
  : VERSION;

/**
 * If dist/ was built from a different version than the installed package.json —
 * or predates build stamping entirely (compiled output with no build-info.json)
 * — self-heal: rebuild in place (source checkouts) and re-exec the command, or,
 * when there's no source to build from, warn loudly with the reinstall command.
 */
function ensureFreshBuild(): void {
  const stale = BUILD ? BUILD.version !== VERSION : IS_COMPILED;
  if (!stale || process.env.ENVBEAM_SKIP_REBUILD) return;

  console.error(
    pc.yellow(
      BUILD
        ? `! envbeam build is stale: running code built for v${BUILD.version}, but v${VERSION} is installed.`
        : `! envbeam build is stale: dist/ predates build stamping (v${VERSION} is installed).`,
    ),
  );
  console.error(pc.dim(`  running: ${CLI_PATH}`));

  const root = path.dirname(require.resolve('../package.json'));
  const canRebuild =
    fs.existsSync(path.join(root, 'tsconfig.build.json')) && fs.existsSync(path.join(root, 'src'));

  if (canRebuild && !process.env.ENVBEAM_REBUILT) {
    console.error(pc.yellow('  rebuilding envbeam…'));
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (build.status === 0) {
      // Re-exec the original command against the fresh build.
      const rerun = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, ENVBEAM_REBUILT: '1' },
      });
      process.exit(rerun.status ?? 0);
    }
    console.error(pc.red('  rebuild failed — reinstall instead:'));
  }
  console.error(pc.dim('  npm i -g "git+ssh://git@github.com/alexgvozden/envbeam.git#main"'));
}

function globalOpts(cmd: Command): GlobalCliOptions {
  const g = cmd.optsWithGlobals();
  // Verbose → trace every external command + exit code to stderr, and lead
  // with the build identity so stale/shadowed installs are instantly visible.
  if (g.verbose) {
    setCommandTrace(true);
    process.stderr.write(pc.dim(`envbeam ${VERSION_STRING} · ${CLI_PATH}\n`));
  }
  return {
    dryRun: g.dryRun,
    yes: g.yes,
    verbose: g.verbose,
    quiet: g.quiet,
  };
}

async function main(): Promise<void> {
  ensureFreshBuild();
  // Every failure self-identifies: which version, which build, WHICH install —
  // so a shadowed/stale install is visible in the error output itself.
  process.on('exit', (code) => {
    if (code !== 0) process.stderr.write(pc.dim(`envbeam ${VERSION_STRING} · ${CLI_PATH}\n`));
  });
  const program = new Command();
  program
    .name('envbeam')
    .description('Beam your whole dev environment to any machine. Pause here, resume there.')
    .version(VERSION_STRING, '-V, --version')
    .option('--dry-run', 'preview actions without changing anything')
    .option('-y, --yes', 'assume yes / accept defaults (non-interactive)')
    .option('-v, --verbose', 'verbose output')
    .option('-q, --quiet', 'only errors')
    .showHelpAfterError();

  program
    .command('init [project]')
    .description('Scaffold a .envbeam.yaml (or bootstrap an existing project by name)')
    .option('--force', 'overwrite an existing config')
    .option('--dir <path>', 'directory to clone into (bootstrap mode)')
    .action(async (project, opts, cmd) =>
      exit(await initCommand({ ...globalOpts(cmd), force: opts.force, project, dir: opts.dir })),
    );

  program
    .command('pull [project]')
    .alias('resume')
    .description('Pull state and get ready to work (or bootstrap a project by name)')
    .option('--dir <path>', 'directory to clone into (bootstrap mode)')
    .action(async (project, opts, cmd) =>
      exit(await pullCommand({ ...globalOpts(cmd), project, dir: opts.dir })),
    );

  program
    .command('push')
    .alias('pause')
    .description('Push state so you can switch to another machine')
    .option('--force', 'proceed even if uncommitted work would be left behind')
    .option('--snapshot', 'force a database snapshot')
    .option('--no-snapshot', 'skip the database snapshot')
    .option('--commit', 'commit dirty working changes before pushing')
    .option('--stash', 'stash dirty working changes before pushing')
    .option('-m, --message <msg>', 'commit/stash message')
    .action(async (opts, cmd) =>
      exit(
        await pushCommand({
          ...globalOpts(cmd),
          force: opts.force,
          snapshot: opts.snapshot === true ? true : undefined,
          noSnapshot: opts.snapshot === false ? true : undefined,
          commit: opts.commit,
          stash: opts.stash,
          message: opts.message,
        }),
      ),
    );

  program
    .command('list')
    .description('List all registered projects')
    .option('--json', 'output JSON')
    .action(async (opts, cmd) => exit(await listCommand({ ...globalOpts(cmd), json: opts.json })));

  program
    .command('delete <project>')
    .description('Delete a project from registry and remote storage (irreversible)')
    .option('--force', 'skip confirmation prompt')
    .action(async (project, opts, cmd) =>
      exit(await deleteCommand(project, { ...globalOpts(cmd), force: opts.force })),
    );

  program
    .command('status')
    .description('Report git/secrets/container/db/session state without changing anything')
    .option('--json', 'output JSON')
    .action(async (opts, cmd) => exit(await statusCommand({ ...globalOpts(cmd), json: opts.json })));

  program
    .command('doctor')
    .description('Check required tools/auth and show the detection report')
    .option('--fix', 'write detected gaps into .envbeam.yaml')
    .option('--no-auth', 'skip authentication probes (presence checks only)')
    .action(async (opts, cmd) =>
      exit(await doctorCommand({ ...globalOpts(cmd), fix: opts.fix, noAuth: opts.auth === false })),
    );

  const identity = program.command('identity').description('Manage named accounts that workspaces reference');
  identity
    .command('add <name>')
    .description('Register a named identity (e.g. github:work)')
    .option('--type <type>', 'identity type (git|doppler|onepassword|s3)')
    .option('--ssh-host <host>', 'SSH host alias (git identities)')
    .option('--account <account>', 'account handle (1password, etc.)')
    .option('--profile <profile>', 'CLI profile (aws, doppler)')
    .option('--token <token>', 'token to store in the OS keychain')
    .action(async (name, opts, cmd) =>
      exit(
        await identityAddCommand(name, {
          ...globalOpts(cmd.parent),
          type: opts.type,
          sshHost: opts.sshHost,
          account: opts.account,
          profile: opts.profile,
          token: opts.token,
        }),
      ),
    );
  identity
    .command('list')
    .description('Show configured identities')
    .action(async (_opts, cmd) => exit(await identityListCommand(globalOpts(cmd.parent))));
  identity
    .command('test <name>')
    .description('Verify an identity authenticates')
    .action(async (name, _opts, cmd) => exit(await identityTestCommand(name, globalOpts(cmd.parent))));
  identity
    .command('remove <name>')
    .description('Remove an identity and its stored credential')
    .action(async (name, _opts, cmd) => exit(await identityRemoveCommand(name, globalOpts(cmd.parent))));

  const config = program.command('config').description('Validate, explain, and sync .envbeam.yaml');
  config
    .command('validate [file]')
    .description('Validate a config file against the schema')
    .action(async (file, _opts, cmd) => exit(await configValidateCommand(file, globalOpts(cmd.parent))));
  config
    .command('explain [field]')
    .description('Describe what each config field means')
    .action(async (field, _opts, cmd) => exit(await configExplainCommand(field, globalOpts(cmd.parent))));
  config
    .command('sync')
    .description('Inspect the repo and propose config additions')
    .option('--write', 'apply the proposed additions')
    .action(async (opts, cmd) => exit(await configSyncCommand({ ...globalOpts(cmd.parent), write: opts.write })));

  const storage = program.command('storage').description('Configure global S3-compatible storage for database snapshots');
  storage
    .command('setup')
    .description('Set up S3-compatible storage (Cloudflare R2, Hetzner, Backblaze, AWS S3, or any other) and store credentials in Doppler')
    .option('--endpoint <url>', 'S3 endpoint URL')
    .option('--bucket <name>', 'bucket name')
    .option('--region <region>', 'region')
    .option('--access-key <key>', 'access key ID')
    .option('--secret-key <key>', 'secret access key')
    .action(async (opts, cmd) =>
      exit(
        await storageSetupCommand({
          ...globalOpts(cmd.parent),
          endpoint: opts.endpoint,
          bucket: opts.bucket,
          region: opts.region,
          accessKey: opts.accessKey,
          secretKey: opts.secretKey,
        }),
      ),
    );
  storage
    .command('status')
    .description('Show current storage configuration')
    .action(async (_opts, cmd) => exit(await storageStatusCommand(globalOpts(cmd.parent))));

  const session = program.command('session').description('Configure Claude session sync');
  session
    .command('setup')
    .description('Set up Claude session sync (generates encryption keys, requires storage first)')
    .option('--scope <scope>', 'session scope (project|workspace|global)')
    .action(async (opts, cmd) =>
      exit(await sessionSetupCommand({ ...globalOpts(cmd.parent), scope: opts.scope })),
    );
  session
    .command('status')
    .description('Show session sync configuration')
    .action(async (_opts, cmd) => exit(await sessionStatusCommand(globalOpts(cmd.parent))));

  await program.parseAsync(process.argv);
}

function exit(code: number): never {
  process.exitCode = code;
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(pc.red(`envbeam: ${err?.message ?? err}\n`));
  process.exit(1);
});
