import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../config/paths.js';
import { ensureDir, readFileIfExists } from './fs.js';
import type { CommandRunner } from './exec.js';
import type { Logger } from './logger.js';
import type { Prompter } from './prompt.js';

/**
 * Update check + self-upgrade that runs before a command executes.
 *
 * Contract: this must NEVER break a command. Every failure path (offline,
 * registry down, proxy, unparseable cache) is swallowed and the command
 * continues on the current version. It also must never block: the registry
 * fetch has a hard timeout and the result is cached so we hit the network at
 * most once per {@link TTL_MS}.
 */

/** Default npm registry endpoint. `/latest` returns the latest dist-tag's manifest. */
const REGISTRY_BASE = 'https://registry.npmjs.org';

/** Hard cap on the registry request — a slow/hung network must not delay a command. */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Re-check the registry at most once per 24h. npm publishes are infrequent, so a
 * daily check surfaces a new release within a day while keeping startup instant
 * (cache read, no network) and registry load negligible. The cache also carries
 * the version the user last declined, so we don't nag on every command in a day.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A *failed* read is cached too, for an hour. Without this the failure path never
 * records `checkedAt`, so an offline machine — or an unpublished package, whose
 * registry read 404s — pays the full timeout on every single command, forever.
 * Shorter than {@link TTL_MS} so a transient outage doesn't blind us for a day.
 */
const FAILURE_TTL_MS = 60 * 60 * 1000;

interface UpdateCache {
  /** Epoch ms of the last successful registry read. */
  checkedAt: number;
  /** Latest version last seen on the registry (null if the read failed). */
  latest: string | null;
  /** Version the user explicitly declined to upgrade to — suppresses re-prompting. */
  snoozedVersion?: string;
}

function cacheFile(): string {
  return path.join(stateDir(), 'update-check.json');
}

async function readCache(): Promise<UpdateCache | null> {
  const text = await readFileIfExists(cacheFile());
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as UpdateCache;
    if (typeof parsed.checkedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function patchCache(patch: Partial<UpdateCache>): Promise<void> {
  try {
    const current = (await readCache()) ?? { checkedAt: 0, latest: null };
    const next = { ...current, ...patch };
    await ensureDir(path.dirname(cacheFile()));
    await fs.writeFile(cacheFile(), JSON.stringify(next, null, 2) + '\n');
  } catch {
    /* a cache we can't write just means we re-check next time — never fatal */
  }
}

// ---------------------------------------------------------------------------
// Semver comparison (real precedence, not string compare)
// ---------------------------------------------------------------------------

function parseSemver(v: string): { core: [number, number, number]; pre: string[] } {
  // Strip a leading `v` and any build metadata (`+…`); the latter is ignored for
  // precedence per the semver spec.
  const cleaned = v.trim().replace(/^v/i, '').split('+')[0] ?? '';
  const dash = cleaned.indexOf('-');
  const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const pre = dash === -1 ? '' : cleaned.slice(dash + 1);
  const nums = core.split('.').map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  return {
    core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
    pre: pre ? pre.split('.') : [],
  };
}

/**
 * Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Implements the numeric-core and prerelease precedence rules of semver 2.0:
 *  - core compared field by field numerically (`0.9.0 < 0.10.0`)
 *  - a version WITH a prerelease has lower precedence than the same core
 *    without one (`0.18.0-beta.1 < 0.18.0`)
 *  - prerelease identifiers compared left to right; all-numeric identifiers
 *    compare numerically and rank below alphanumeric ones; a shorter set of
 *    identifiers (all else equal) has lower precedence.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const ca = pa.core[i] ?? 0;
    const cb = pb.core[i] ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // release > prerelease
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1; // fewer identifiers → lower precedence
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (an) {
      return -1; // numeric identifier < alphanumeric identifier
    } else if (bn) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Registry fetch (timeout-bounded, failure-silent)
// ---------------------------------------------------------------------------

async function fetchLatestVersion(
  pkg: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${REGISTRY_BASE}/${pkg}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    // offline, DNS failure, timeout/abort, proxy, malformed JSON — never propagate.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------

export type InstallKind = 'global-npm' | 'git-checkout' | 'npx' | 'local' | 'unknown';

export interface InstallMethod {
  kind: InstallKind;
  /** Human-readable label for messaging. */
  label: string;
  detail?: string;
}

/**
 * Work out how this CLI was installed, so we only auto-upgrade the one case that
 * is safe and meaningful: a global npm install. Upgrading anything else is
 * destructive or pointless — a git checkout is developed in place (and self-heals
 * via the build stamp), an npx invocation is a throwaway cache, and a local
 * dependency is owned by the project's own package.json.
 */
export async function detectInstallMethod(opts: {
  /** Real directory of the running package (dir of its package.json). */
  packageRoot: string;
  /** False when running from src via tsx (`npm run dev`) rather than compiled dist. */
  isCompiled: boolean;
  runner: CommandRunner;
  timeoutMs?: number;
}): Promise<InstallMethod> {
  const { packageRoot, isCompiled, runner } = opts;

  // Running from source (tsx over src/) is unambiguously a dev checkout.
  if (!isCompiled) {
    return { kind: 'git-checkout', label: 'source checkout', detail: 'running from src via tsx' };
  }

  // A published npm tarball ships only `dist/` (see package.json "files"). If the
  // package root still has `src/` + the build config, we're inside a source tree
  // — same signal the stale-build self-heal uses.
  if (
    existsSync(path.join(packageRoot, 'src')) &&
    existsSync(path.join(packageRoot, 'tsconfig.build.json'))
  ) {
    return { kind: 'git-checkout', label: 'source checkout', detail: packageRoot };
  }

  const rootPosix = packageRoot.replace(/\\/g, '/');

  // npx stages packages under `…/.npm/_npx/<hash>/node_modules/…`.
  if (rootPosix.includes('/_npx/')) {
    return { kind: 'npx', label: 'npx', detail: 'npx cache' };
  }

  // Global install: the package lives under `npm root -g`.
  try {
    const res = await runner.run('npm', ['root', '-g'], {
      allowFailure: true,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const globalRoot = res.stdout.trim().replace(/\\/g, '/');
    if (res.code === 0 && globalRoot && rootPosix.startsWith(globalRoot)) {
      return { kind: 'global-npm', label: 'global npm install' };
    }
  } catch {
    /* npm missing or slow — fall through to the conservative default */
  }

  // Anything else living in a node_modules is a project-local dependency.
  if (rootPosix.includes('/node_modules/')) {
    return { kind: 'local', label: 'local dependency', detail: 'node_modules' };
  }

  return { kind: 'unknown', label: 'unknown install' };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface UpdateCheckDeps {
  currentVersion: string;
  /** Real directory of the running package (dir of its package.json). */
  packageRoot: string;
  /** False when running from src via tsx. */
  isCompiled: boolean;
  runner: CommandRunner;
  logger: Logger;
  prompter: Prompter;
  /** True only on a real TTY (from isInteractive()). Gates any prompt. */
  interactive: boolean;
  /** --yes: assume-yes / non-interactive intent. */
  assumeYes: boolean;
  /** --dry-run: never mutate the system. */
  dryRun?: boolean;
  /** process.argv, used to re-exec the upgraded binary. */
  argv: string[];
  packageName?: string;
  timeoutMs?: number;
  /** Injectable clock (tests). */
  now?: number;
  /** Injectable fetch (tests stub global fetch instead by default). */
  fetchImpl?: typeof fetch;
  /** Injectable re-exec (tests). The default spawns the upgraded binary and exits. */
  reExec?: (argv: string[]) => void;
}

function defaultReExec(argv: string[]): void {
  // The already-loaded process is running the OLD code; the only safe way to run
  // the just-installed version is to re-invoke ourselves. After a global upgrade
  // npm overwrote the same bin path in place, so argv[1] now resolves to new code.
  // ENVBEAM_NO_UPDATE_CHECK stops the child from re-checking.
  const rerun = spawnSync(process.execPath, argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ENVBEAM_NO_UPDATE_CHECK: '1' },
  });
  process.exit(rerun.status == null ? 1 : rerun.status);
}

/** Run the update check; swallows every error so a command can never be broken by it. */
export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<void> {
  try {
    await runUpdateCheckInner(deps);
  } catch {
    /* an update check must never break the command it precedes */
  }
}

async function runUpdateCheckInner(deps: UpdateCheckDeps): Promise<void> {
  const {
    currentVersion,
    logger,
    prompter,
    interactive,
    assumeYes,
    dryRun = false,
    packageName = 'envbeam',
  } = deps;
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return; // no fetch (very old runtime) → skip

  const cache = await readCache();
  // A cache entry that never learned a version is a *failure* record; it expires
  // sooner than a successful one.
  const ttl = cache?.latest ? TTL_MS : FAILURE_TTL_MS;
  const fresh = cache != null && now - cache.checkedAt < ttl;

  let latest: string | null;
  if (fresh) {
    latest = cache.latest; // within TTL → use cache, do NOT hit the registry
  } else {
    const fetched = await fetchLatestVersion(packageName, fetchImpl, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    latest = fetched ?? cache?.latest ?? null; // network failed → fall back to stale, or give up
    // Always stamp `checkedAt`, success or not: an unrecorded failure means the
    // next command re-hits the registry and pays the timeout again.
    await patchCache({ checkedAt: now, latest });
  }

  if (!latest) return; // couldn't learn a latest version → silently continue
  if (compareSemver(latest, currentVersion) <= 0) return; // current is up to date (or ahead)

  const notice = `envbeam ${currentVersion} → ${latest} available`;

  // Never prompt (let alone mutate the machine) in non-interactive / CI / --yes /
  // --dry-run contexts. Auto-upgrading under --yes in CI would change the running
  // code mid-pipeline — surprising and unsafe. The documented compromise is a
  // single stderr notice (so it can't corrupt `--json` stdout) and continue.
  if (!interactive || assumeYes || dryRun) {
    logger.warn(`${notice} (auto-upgrade is offered on interactive runs).`);
    return;
  }

  // Already declined this exact version today → stay quiet (don't nag every command).
  if (cache?.snoozedVersion === latest) return;

  const method = await detectInstallMethod({
    packageRoot: deps.packageRoot,
    isCompiled: deps.isCompiled,
    runner: deps.runner,
    timeoutMs: deps.timeoutMs,
  });

  // Only a global npm install is safe to auto-upgrade. For anything else, say
  // what we found and continue — don't touch it.
  if (method.kind !== 'global-npm') {
    logger.warn(`${notice}, but this is a ${method.label}; leaving it untouched.`);
    return;
  }

  const yes = await prompter.confirm(`${notice}. Upgrade now?`, true);
  if (!yes) {
    await patchCache({ snoozedVersion: latest });
    return;
  }

  logger.info(`Upgrading envbeam ${currentVersion} → ${latest}…`);
  const res = await deps.runner.run('npm', ['install', '-g', `${packageName}@latest`], {
    inherit: true,
    allowFailure: true,
    timeout: 180000,
  });
  if (res.code !== 0) {
    logger.warn(`Upgrade failed (npm exited ${res.code}). Continuing with ${currentVersion}.`);
    return;
  }
  logger.success(`Upgraded to envbeam ${latest}. Re-running your command…`);
  // Clear the snooze; re-exec into the new code to finish the original command.
  await patchCache({ latest, snoozedVersion: undefined });
  (deps.reExec ?? defaultReExec)(deps.argv);
}
