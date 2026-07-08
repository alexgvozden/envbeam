/** Human-readable report text for a session provider action (push or pull). */
export function sessionSummary(action: string): string {
  switch (action) {
    case 'pushed':
    case 'pulled':
      return 'synced';
    case 'noop':
      return 'nothing to sync';
    case 'documented':
      return 'documented (no file sync)';
    default:
      return action;
  }
}
