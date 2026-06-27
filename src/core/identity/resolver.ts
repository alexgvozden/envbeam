import type { GlobalConfig } from '../config/schema.js';
import type { ResolvedIdentity } from '../providers/types.js';
import type { CredentialStore } from './store.js';
import { EnvbeamError } from '../util/errors.js';

/**
 * Resolve a named identity reference into a ready-to-use credential/account
 * handle (PRD §9 identity resolution). The token (if any) is fetched from the
 * credential store via the identity's tokenRef (defaulting to the identity name).
 */
export async function resolveIdentity(
  name: string,
  globalConfig: GlobalConfig,
  store: CredentialStore,
): Promise<ResolvedIdentity> {
  const def = globalConfig.identities[name];
  if (!def) {
    throw new EnvbeamError(`Unknown identity "${name}".`, {
      exitCode: 2,
      hint: `Define it with \`envbeam identity add ${name}\` (or check the spelling).`,
    });
  }
  const tokenRef = def.tokenRef ?? name;
  let token: string | undefined;
  try {
    token = (await store.get(tokenRef)) ?? undefined;
  } catch {
    token = undefined;
  }
  return {
    name,
    type: def.type,
    account: def.account,
    sshHost: def.sshHost,
    profile: def.profile,
    token,
    env: { ...def.env },
  };
}

/** Resolve an optional identity reference (null when unset). */
export async function resolveOptionalIdentity(
  name: string | undefined,
  globalConfig: GlobalConfig,
  store: CredentialStore,
): Promise<ResolvedIdentity | undefined> {
  if (!name) return undefined;
  return resolveIdentity(name, globalConfig, store);
}
