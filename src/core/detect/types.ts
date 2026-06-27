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
