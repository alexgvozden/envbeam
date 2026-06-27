import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import type { WorkspaceConfig } from './schema.js';
import type { DetectionReport } from '../detect/types.js';

export interface ConfigGap {
  path: string[];
  value: string;
  reason: string;
}

function det(detection: DetectionReport, field: string): string | undefined {
  const f = detection.fields.find((x) => x.field === field);
  return f && f.status === 'detected' && typeof f.value === 'string' ? f.value : undefined;
}

/** Detected fields the config doesn't yet declare (PRD §6 doctor / §9a config sync). */
export function computeGaps(config: WorkspaceConfig | null, detection: DetectionReport): ConfigGap[] {
  const gaps: ConfigGap[] = [];
  const add = (path: string[], value: string | undefined, reason: string, condition: boolean) => {
    if (value && condition) gaps.push({ path, value, reason });
  };

  add(['container', 'mode'], det(detection, 'container.mode'), 'detected container mode', !config?.container?.mode);
  add(
    ['container', 'composeFile'],
    det(detection, 'container.composeFile'),
    'detected compose file',
    !!config?.container && !config.container.composeFile,
  );

  if (config?.database) {
    add(['database', 'provider'], det(detection, 'database.provider'), 'detected DB engine', !config.database.provider);
    add(['database', 'service'], det(detection, 'database.service'), 'detected DB service', !config.database.service);
    add(
      ['database', 'migrateCommand'],
      det(detection, 'database.migrateCommand'),
      'detected migrate command',
      !config.database.migrateCommand,
    );
  }

  return gaps;
}

/** Apply gaps to a YAML config file, preserving comments/formatting. */
export async function applyGaps(configPath: string, gaps: ConfigGap[]): Promise<string[]> {
  if (!gaps.length) return [];
  const text = await fs.readFile(configPath, 'utf8');
  const doc = YAML.parseDocument(text);
  const written: string[] = [];
  for (const gap of gaps) {
    if (doc.hasIn(gap.path)) continue;
    doc.setIn(gap.path, gap.value);
    written.push(`${gap.path.join('.')} = ${gap.value}`);
  }
  if (written.length) await fs.writeFile(configPath, doc.toString());
  return written;
}
