import type { ProviderContext } from '../types.js';

export interface DbConnectionParts {
  url?: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
  /** The env var the URL/connection was resolved from (for ambiguity warnings). */
  sourceKey?: string;
}

export type DbEngine = 'postgres' | 'mysql';

export interface DbUrlHit {
  key: string;
  engine: DbEngine;
  /** Redacted for display (no password). */
  redacted: string;
}

/**
 * Find every env var whose value is a database connection URL for a supported
 * engine — by SCHEME, not by name. Used to warn when a workspace exposes more
 * than one database of the same engine (envbeam snapshots/restores one).
 */
export function findDatabaseUrls(env: Record<string, string | undefined>): DbUrlHit[] {
  const hits: DbUrlHit[] = [];
  for (const [key, val] of Object.entries(env)) {
    if (!val) continue;
    const engine: DbEngine | null = SCHEME_BY_ENGINE.postgres.test(val)
      ? 'postgres'
      : SCHEME_BY_ENGINE.mysql.test(val)
        ? 'mysql'
        : null;
    if (engine) hits.push({ key, engine, redacted: parseDbUrl(val).host ? `${engine}://…@${parseDbUrl(val).host}${parseDbUrl(val).database ? '/' + parseDbUrl(val).database : ''}` : engine });
  }
  return hits;
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
    if (val && SCHEME_BY_ENGINE[engine].test(val)) return { ...parseDbUrl(val), sourceKey: key };
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

/**
 * A warning to show when a workspace exposes more than one database URL of the
 * SAME engine — envbeam only snapshots/restores one, so the user should pin
 * `database.connection` to be explicit. Returns null when unambiguous.
 */
export function ambiguousUrlWarning(
  env: Record<string, string | undefined>,
  engine: DbEngine,
  resolvedKey: string | undefined,
): string | null {
  const same = findDatabaseUrls(env).filter((h) => h.engine === engine);
  if (same.length <= 1) return null;
  const keys = same.map((h) => h.key);
  const using = resolvedKey ?? keys[0];
  return `Multiple ${engine} database URLs found (${keys.join(', ')}). envbeam snapshots/restores only one — using ${using}. Set database.connection in .envbeam.yaml to pick a specific one.`;
}

export function describeConnection(parts: DbConnectionParts): string {
  const host = parts.host ?? 'localhost';
  const db = parts.database ?? '(default)';
  return `${parts.user ? parts.user + '@' : ''}${host}${parts.port ? ':' + parts.port : ''}/${db}`;
}
