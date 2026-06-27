import type { ProviderContext } from '../types.js';

export interface DbConnectionParts {
  url?: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
}

const URL_KEYS_BY_ENGINE: Record<'postgres' | 'mysql', string[]> = {
  postgres: ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'DB_URL'],
  mysql: ['DATABASE_URL', 'MYSQL_URL', 'DB_URL'],
};

const SCHEME_BY_ENGINE: Record<'postgres' | 'mysql', RegExp> = {
  postgres: /^postgres(ql)?:\/\//i,
  mysql: /^mysql:\/\//i,
};

/** Parse a DB connection URL into parts. */
export function parseDbUrl(url: string): DbConnectionParts {
  try {
    const u = new URL(url);
    return {
      url,
      host: u.hostname || undefined,
      port: u.port || undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: u.pathname ? u.pathname.replace(/^\//, '') || undefined : undefined,
    };
  } catch {
    return { url };
  }
}

/**
 * Resolve DB connection details from loaded secrets (ctx.env) and config.
 * `database.connection` may be "from-secrets" (default), a literal URL, or the
 * NAME of an env var holding a URL.
 */
export function resolveConnection(
  ctx: ProviderContext,
  engine: 'postgres' | 'mysql',
  partKeys: {
    host: string[];
    port: string[];
    user: string[];
    password: string[];
    database: string[];
  },
): DbConnectionParts {
  const env = ctx.env;
  const connSetting = ctx.config.database?.connection ?? 'from-secrets';

  if (connSetting && connSetting !== 'from-secrets') {
    if (/:\/\//.test(connSetting)) return parseDbUrl(connSetting);
    const fromVar = env[connSetting];
    if (fromVar) return parseDbUrl(fromVar);
  }

  // 1) explicit URL var
  for (const key of URL_KEYS_BY_ENGINE[engine]) {
    const val = env[key];
    if (val && SCHEME_BY_ENGINE[engine].test(val)) return parseDbUrl(val);
  }

  // 2) assemble from parts
  const pick = (keys: string[]): string | undefined => {
    for (const k of keys) {
      if (env[k] != null && env[k] !== '') return env[k];
    }
    return undefined;
  };
  return {
    host: pick(partKeys.host),
    port: pick(partKeys.port),
    user: pick(partKeys.user),
    password: pick(partKeys.password),
    database: pick(partKeys.database),
  };
}

export function describeConnection(parts: DbConnectionParts): string {
  const host = parts.host ?? 'localhost';
  const db = parts.database ?? '(default)';
  return `${parts.user ? parts.user + '@' : ''}${host}${parts.port ? ':' + parts.port : ''}/${db}`;
}
