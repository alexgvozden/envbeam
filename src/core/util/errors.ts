/** Error that maps to a specific process exit code with a user-facing message. */
export class EnvbeamError extends Error {
  readonly exitCode: number;
  readonly hint?: string;
  constructor(message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = 'EnvbeamError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}

/** A precondition (doctor/preflight) failed; fix-it guidance attached. */
export class PreflightError extends EnvbeamError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 2, hint });
    this.name = 'PreflightError';
  }
}

/** A mutating action was refused because it would lose work without --force. */
export class SafetyError extends EnvbeamError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: 3, hint });
    this.name = 'SafetyError';
  }
}
