export type DetectStatus = 'detected' | 'ambiguous' | 'missing';

export interface DetectedField {
  /** Dotted config path, e.g. "git.remote" or "database.provider". */
  field: string;
  value?: string | string[];
  /** Where the value came from (for the doctor detection report). */
  source: string;
  status: DetectStatus;
  note?: string;
  /** Candidate values when ambiguous (e.g. multiple db services). */
  candidates?: string[];
}

export interface DetectionReport {
  workspaceRoot: string;
  fields: DetectedField[];
}

export function getField(report: DetectionReport, field: string): DetectedField | undefined {
  return report.fields.find((f) => f.field === field);
}

export function detectedValue(report: DetectionReport, field: string): string | undefined {
  const f = getField(report, field);
  if (f && f.status === 'detected' && typeof f.value === 'string') return f.value;
  return undefined;
}

/**
 * Resolve the concrete git branch to record/restore. The config's `branch`
 * defaults to the sentinel `current` ("follow the checked-out branch"), which
 * isn't a real ref — so resolve it to the actually detected branch. An explicit
 * branch in the config wins; falls back to `main` if nothing is detected.
 */
export function resolveBranch(report: DetectionReport, configBranch?: string): string {
  if (configBranch && configBranch !== 'current') return configBranch;
  return detectedValue(report, 'git.branch') ?? 'main';
}
