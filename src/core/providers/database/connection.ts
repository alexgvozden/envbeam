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

// Accept SQLAlchemy / driver-qualified schemes too, e.g. postgresql+psycopg://,
// postgresql+asyncpg://, mysql+pymysql://.
const SCHEME_BY_ENGINE: Record<'postgres' | 'mysql', RegExp> = {
  postgres: /^postgres(ql)?(\+[a-z0-9_]+)?:\/\//i,
  mysql: /^mysql(\+[a-z0-9_]+)?:\/\//i,
};

/** Strip a `+driver` qualifier so CLI clients (psql/mysql) accept the URL. */
function normalizeScheme(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9.-]*)\+[a-z0-9_]+:\/\//i, '$1://');
}

// scheme://[user[:password]@]host[:port][/database][?query]
// Hand-rolled because Node's WHATWG `new URL()` rejects postgres://mysql:// URLs
// with dotted hostnames (non-special-scheme host parsing quirk).
const DB_URL_RE =
  /^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/?#]+)(?::([^@/?#]*))?@)?([^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?/i;

function safeDecode(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse a DB connection URL into parts (robust to dotted hosts + `+driver`). */
export function parseDbUrl(url: string): DbConnectionParts {
  const normalized = normalizeScheme(url);
  const m = DB_URL_RE.exec(normalized);
  if (!m) return { url: normalized };
  const [, user, password, host, port, database] = m;
  return {
    url: normalized,
    host: host || undefined,
    port: port || undefined,
    user: safeDecode(user) || undefined,
    password: password != null ? safeDecode(password) : undefined,
    database: database ? database.replace(/^\//, '') || undefined : undefined,
  };
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

  // 1) explicit URL var — known names first, then any other env var whose value
  //    looks like a connection URL for this engine (catches app-prefixed vars
  //    like AGENTLAB_DATABASE_URL). Prefer *_URL / *_DSN names when scanning.
  const scanOrder = [
    ...URL_KEYS_BY_ENGINE[engine],
    ...Object.keys(env)
      .filter((k) => !URL_KEYS_BY_ENGINE[engine].includes(k))
      .sort((a, b) => Number(/_(URL|DSN)$/i.test(b)) - Number(/_(URL|DSN)$/i.test(a))),
  ];
  for (const key of scanOrder) {
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
