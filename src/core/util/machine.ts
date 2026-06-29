import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { globalDir } from '../config/paths.js';
import { ensureDir, pathExists } from './fs.js';

const MACHINE_ID_FILE = 'machine-id';

/**
 * Get a stable machine identifier.
 * Uses hostname + username, stored in ~/.envbeam/machine-id for consistency.
 * Format: hostname-username (sanitized)
 */
export async function getMachineId(): Promise<string> {
  const idPath = path.join(globalDir(), MACHINE_ID_FILE);

  // Return cached ID if exists
  if (await pathExists(idPath)) {
    const cached = (await fs.readFile(idPath, 'utf8')).trim();
    if (cached) return cached;
  }

  // Generate new ID from hostname + username
  const hostname = os.hostname().toLowerCase();
  const username = os.userInfo().username.toLowerCase();
  const raw = `${hostname}-${username}`;

  // Sanitize: only alphanumeric and hyphens
  const sanitized = raw.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

  // Add short hash suffix for uniqueness
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  const machineId = `${sanitized}-${hash}`;

  // Cache for future use
  await ensureDir(globalDir());
  await fs.writeFile(idPath, machineId + '\n');

  return machineId;
}

/**
 * Get machine ID synchronously (may not be cached).
 * Use getMachineId() when possible.
 */
export function getMachineIdSync(): string {
  const hostname = os.hostname().toLowerCase();
  const username = os.userInfo().username.toLowerCase();
  const raw = `${hostname}-${username}`;
  const sanitized = raw.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  return `${sanitized}-${hash}`;
}
