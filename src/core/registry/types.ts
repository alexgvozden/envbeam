import { z } from 'zod';

/**
 * Project entry in the global registry.
 * Tracks all projects for cross-machine sync.
 */
export const projectEntrySchema = z.object({
  /** Unique project name (from workspace config). */
  name: z.string().min(1),
  /** Git clone URL. */
  gitRemote: z.string(),
  /** Branch to checkout. */
  gitBranch: z.string().default('main'),
  /** Copy of .envbeam.yaml content (for bootstrap). */
  configSnapshot: z.string(),
  /** ISO timestamp of last push. */
  lastPush: z.string(),
  /** Machine ID that last pushed. */
  machineId: z.string(),
  /** Sync target configuration (for snapshots). */
  syncTarget: z
    .object({
      target: z.enum(['syncthing', 's3', 'local-folder']).optional(),
      bucket: z.string().optional(),
      prefix: z.string().optional(),
      region: z.string().optional(),
    })
    .optional(),
});

export type ProjectEntry = z.infer<typeof projectEntrySchema>;

/**
 * Global project registry stored in S3.
 */
export const projectRegistrySchema = z.object({
  version: z.literal(1),
  projects: z.record(projectEntrySchema),
});

export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

/** Empty registry for initialization. */
export const EMPTY_REGISTRY: ProjectRegistry = {
  version: 1,
  projects: {},
};
