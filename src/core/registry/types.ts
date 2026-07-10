import { z } from 'zod';

/**
 * What one successful push actually produced. Written once, at the end of a
 * push, naming only the artifacts that really uploaded — so a partial push
 * (snapshot over the size cap, `pg_dump` missing, network died) never advertises
 * data that isn't there (SYNC_SAFETY.md §9).
 *
 * `gitCommit` is the causal anchor: `pull` can ask git whether the commit this
 * data was taken against is an ancestor of what the checkout will be on, which
 * is the one lineage question that is actually decidable.
 */
export const checkpointSchema = z.object({
  revision: z.number().int().nonnegative(),
  /** Full sha the other artifacts were captured against. */
  gitCommit: z.string(),
  gitBranch: z.string(),
  /** Absent = this checkpoint carries no database snapshot. */
  snapshotName: z.string().optional(),
  sessionName: z.string().optional(),
  /** sha256 over the sorted key=valuehash set that was pushed. */
  secretsHash: z.string().optional(),
  machineId: z.string(),
  /** ISO, informational only — never used for ordering. */
  at: z.string(),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

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
  /** Human-readable metadata only. Local wall-clock; never used for ordering. */
  lastPush: z.string(),
  /** Machine ID that last pushed. Metadata only. */
  machineId: z.string(),
  /**
   * Monotonic, incremented on every successful push. This is the total order —
   * the one that does not depend on any machine's clock. `default(0)` so
   * registries written before this field parse cleanly.
   */
  revision: z.number().int().nonnegative().default(0),
  /** What the last successful push produced. Absent on pre-checkpoint entries. */
  checkpoint: checkpointSchema.optional(),
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

/** What a caller supplies: `revision` is assigned by the store, not the caller. */
export type ProjectEntryInput = Omit<z.input<typeof projectEntrySchema>, 'revision'>;

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
