/**
 * Mask credentials embedded in a URL's userinfo — `scheme://user:pass@host`
 * becomes `scheme://user:***@host`. Used before printing commands so a DB URL
 * or a token-bearing git remote in argv never lands in logs.
 */
export function redactUrlCreds(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, '$1$2:***@');
}

/**
 * Strip credentials entirely from a URL — `scheme://user:pass@host` becomes
 * `scheme://host`. Used when persisting a remote (e.g. to clone) so a token is
 * never stored or exposed via argv.
 */
export function stripUrlCreds(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^\s@/]+@)/gi, '$1');
}
