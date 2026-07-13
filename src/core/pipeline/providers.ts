import type { RunContext } from './context.js';
import type {
  GitProvider,
  SecretsProvider,
  ContainerProvider,
  DatabaseProvider,
  SessionProvider,
} from '../providers/types.js';

export interface ActiveProviders {
  git: GitProvider;
  secrets?: SecretsProvider;
  container?: ContainerProvider;
  database?: DatabaseProvider;
  session?: SessionProvider;
}

/** Resolve the concrete provider instances a workspace's config activates. */
export function resolveActiveProviders(ctx: RunContext): ActiveProviders {
  const { config, registry } = ctx;

  const git = registry.create('git', 'git') as GitProvider;

  let secrets: SecretsProvider | undefined;
  if (config.secrets?.provider) {
    secrets = registry.create('secrets', config.secrets.provider) as SecretsProvider;
  }

  let container: ContainerProvider | undefined;
  if (config.container?.mode && config.container.mode !== 'none') {
    container = registry.create('container', config.container.mode) as ContainerProvider;
  }

  let database: DatabaseProvider | undefined;
  if (config.database?.provider) {
    database = registry.create('database', config.database.provider) as DatabaseProvider;
  }

  let session: SessionProvider | undefined;
  const sessionProvider = config.session?.provider ?? 'claude-native';
  if (sessionProvider && sessionProvider !== 'none') {
    session = registry.create('session', sessionProvider) as SessionProvider;
  }

  return { git, secrets, container, database, session };
}
