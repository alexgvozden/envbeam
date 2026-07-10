# envbeam — Sync Safety: staleness, divergence, and lost updates

> **Status:** Design proposal, not yet implemented.
> **Scope:** `push` (pause) and `pull` (resume) across all five synced domains.
> **Written against:** v0.17.0.

---

## 1. The one-sentence problem

**envbeam has no causal order.** Git has one (commit ancestry). Nothing else does. The database, the session archive, the secrets, and the registry entry are each ordered by a wall-clock string produced by whichever machine wrote them last — so "newest" means "whichever laptop had the fastest clock", not "whichever change happened after the other."

Everywhere that order is used to decide *overwrite vs. skip*, the decision can be wrong, and when it's wrong the losing side's data is gone without a prompt.

Git is the exception and the model to copy. `git.pull()` fast-forwards only (`git/git.ts:115`) and refuses a non-fast-forward push (`git/git.ts:174-179`). It can decline to act, because it can *tell* whether one state descends from another. Every other domain overwrites unconditionally because it can't tell.

---

## 2. The invariant we want

> An envbeam operation may only overwrite state **S_remote** with **S_local** if S_remote is an ancestor of S_local — i.e. the machine writing already saw everything the target contains. If neither side is an ancestor of the other, the states have **diverged**: stop and ask. Never resolve divergence by timestamp.

This is exactly git's rule, generalized. The work is (a) giving each domain a lineage so "ancestor" is decidable, and (b) actually checking it on both `push` and `pull`.

Corollary the user asked about directly: *pull must not restore something older than what we have, and push must not upload something older than what's there.* Both fall out of the invariant.

---

## 3. Vocabulary

- **Base** — the remote state a machine last observed (pulled or pushed). Recorded locally.
- **Lineage** — a chain: each artifact records the base it was derived from.
- **Ancestor / descendant / diverged** — as in git. Diverged = both sides moved since their common base.
- **Epoch / revision** — a monotonic integer per project, incremented in the registry on every push. Provides a total order that doesn't depend on any machine's clock.
- **Coherent checkpoint** — a `push` where git commit, DB snapshot, session archive, and secrets all describe the *same* moment. envbeam does not currently guarantee this (§9).

---

## 4. Domain: Git

**What "newer" means:** commit ancestry. Fully decidable, already correct.

**Current behavior**

| Operation | Code | Behavior |
|---|---|---|
| pull | `git/git.ts:104-119` | fetch, then `merge --ff-only`; skips if dirty; skips if not fast-forwardable |
| push | `git/git.ts:169-181` | plain `git push`; on non-ff rejection raises `SafetyError`, never force-pushes |

**Verdict: safe.** Git already implements the invariant. Two residual issues, neither about staleness:

- **G1.** `pushWork` with `workMode: 'commit'` runs `git add -A` (`git/git.ts:135`) — commits everything, including files the user never intended to track. Out of scope here; worth its own issue.
- **G2.** A skipped git step (dirty tree → `skipped-dirty`) does **not** stop the DB restore that follows. See §9 — this is the coherence bug, and it's the most dangerous item in this document.

**Decision:** leave the git provider alone. Use it as the reference implementation, and use commit SHAs as the anchor for the other domains' lineage (§10).

---

## 5. Domain: Database

**What "newer" means:** ambiguous, and that is the heart of the problem. Two candidate orders exist and they disagree:

1. **Schema** order — decidable via migrations (an ordered, named list).
2. **Data** order — *not* decidable. There is no vector clock on rows. Two machines that both insert a row have genuinely diverged, and no automatic merge is correct.

**Current behavior**

Snapshots are files named `<workspace>__<timestamp>__<machine>.<ext>` (`sync/types.ts:42-50`) where the timestamp comes from `formatTimestamp(new Date())` on the *pushing* machine (`pipeline/pause.ts:262`). `list()` sorts by that string descending (`sync/types.ts:75-77`) and resume takes `entries[0]` (`pipeline/resume.ts:238`).

Restore is gated on exactly one condition (`pipeline/resume.ts:245`):

```ts
const newer = !state.lastRestoredTimestamp || latest.timestamp > state.lastRestoredTimestamp;
```

**Failure cases**

- **D1 — restoring your own snapshot over newer local data.** `lastSnapshotTimestamp` is written on push (`pause.ts:333`) but **never read**. Only `lastRestoredTimestamp` is consulted. So: machine A pushes a snapshot at T5, keeps working, changes data, then runs `pull`. `lastRestoredTimestamp` is unset, `latest.timestamp` (T5, A's own) is "newer" → with `restore: auto` A silently restores its own T5 dump over the newer local rows. With `restore: prompt` the default answer is `true` (`resume.ts:253-256`). **This is a live data-loss bug, not a hypothetical.**

- **D2 — the stale machine wins on push.** Machine B has been offline for a week with old data. B runs `push`. Its snapshot gets *today's* timestamp, sorts first, and every other machine now restores B's week-old database. Nothing in `pauseDatabase` (`pause.ts:165-341`) looks at what's already on the sync target except `hasRemoteSnapshot()` (`pause.ts:153-163`), which only asks *whether any snapshot exists*, never *whether it is newer than our base*. This is the exact "push something older" case in the request.

- **D3 — clock skew inverts the order.** Both the filename timestamp and the sort key are local wall-clock. A laptop 3 minutes fast permanently wins every race.

- **D4 — restore clobbers unsaved local data changes.** Nothing compares the live DB's fingerprint against the base before restoring. `hasChanged()` exists (`database/base.ts:89-124`) and is only used on the push path.

- **D5 — the fingerprint under-detects.** It is per-table row counts, or (zero-config fallback) database size + approximate row count (`base.ts:97-120`). An `UPDATE` that changes no counts is invisible. So "no local changes" is **not** a safe basis for silently overwriting; it can only *strengthen* a warning, never suppress one.

**Decisions**

| Case | Decision |
|---|---|
| D1 | Track `lastKnownSnapshot` (id, not timestamp) covering *both* push and restore. A snapshot this machine produced is never "newer" than the machine that produced it. Fix regardless of the rest of this plan. |
| D2 | On push, refuse to upload a snapshot whose base is not the current remote head. Offer: pull-and-restore first, force-overwrite (explicit), or push git-only and skip the snapshot. |
| D3 | Stop ordering by timestamp. Order by `revision` from the registry (§10). Keep the timestamp in the filename for humans only. |
| D4 | Before any restore, run `hasChanged()` against the base fingerprint. If changed → this is divergence. Never auto-restore, even with `restore: auto`; require `--force` or an explicit prompt. Offer a pre-restore local dump as a safety net. |
| D5 | Treat "no detected change" as *weak* evidence. Phrase prompts as "no row-count change detected (updates in place are not detected)". Never use it to skip a confirmation the lineage check demands. |

**Explicitly not doing:** merging two diverged databases. That is unsolvable in general. envbeam's job is to *detect* it and hand the user both snapshots.

---

## 6. Domain: Secrets

**What "newer" means:** per-key. The provider (Doppler/1Password) is the source of truth in `pull-only` mode, which is the default and is *already safe*. Everything below concerns `sync: two-way`.

**Current behavior**

- **Pull** materializes `.env` with an unconditional `fs.writeFile` (`secrets/materialize.ts:53-56`). No read of the existing file, no diff, no backup.
- **Push** (two-way) reads `.env`, filters `DOPPLER_`/`ENVBEAM_` keys, and runs `doppler secrets upload` (`secrets/doppler.ts:154-200`). No version check, no ETag, no read-before-write.
- 1Password has **no `push` method at all** — `pause.ts:111` guards on `active.secrets.push`, so `sync: two-way` on 1Password silently does nothing. That is a documentation bug at minimum.

**Failure cases**

- **S1 — lost update.** A adds `STRIPE_KEY` and pushes. B (whose `.env` predates that) runs `push`. B's upload does not contain `STRIPE_KEY`. Whether B *deletes* A's key or merely fails to add it depends on `doppler secrets upload` semantics — **this needs verifying against the Doppler CLI before we design around it** (see §12). Either way B has pushed a state that never saw A's change, violating the invariant.

- **S2 — `.env` clobbered on pull.** A developer edits `.env` locally (a scratch value, a local DB URL) and runs `pull`. It is overwritten silently. There is no record of what was there.

- **S3 — no base recorded.** Nothing stores what we last pulled, so a three-way comparison is impossible today.

**Decisions**

| Case | Decision |
|---|---|
| S3 | On every successful pull, record `secretsBase = { hash, keyHashes, pulledAt }` in `WorkspaceState`. This is the enabling change. |
| S1 | Before a two-way push, **re-pull** and compare against `secretsBase`. If the remote changed since our base → three-way key diff (`added` / `removed` / `changed` on each side). Auto-apply the non-conflicting union; prompt per conflicting key. Never blind-upload. |
| S2 | Before writing `.env`, hash it. If it differs from the hash we last materialized, the user has local edits → show a key-level diff, write `.env.envbeam-backup` (0600), and confirm. `--yes` keeps today's overwrite behavior. |
| — | Store only **hashes** of values in `WorkspaceState`, never plaintext. State lives at `stateDir()`, not in the repo. |
| — | Make 1Password two-way an explicit error at config-validation time rather than a silent no-op. |

---

## 7. Domain: Session (Claude Code)

**What "newer" means:** `.jsonl` transcripts are append-only per session id, so *longer is newer* for a given file, and per-file mtime is a decent proxy. Across machines, two sessions with the same id that both grew have diverged.

**Current behavior**

Pull lists archives, sorts by the timestamp parsed out of the filename, and then:

```ts
const chosen = candidates.find((c) => c.parsed && c.parsed.machine !== machine) ?? candidates[0]!;
```
— `session/claudeNative.ts:349`

It then extracts and copies over the local tree with `safeCopySessionTree` (`claudeNative.ts:434`), which `fs.copyFile`s each regular file, replacing whatever is there.

**Failure cases**

- **T1 — deliberately prefers a *stale* archive.** The `find(machine !== machine)` heuristic means: if this machine has the newest archive, pull picks an **older** one from another machine and copies it over the local session tree. The intent was "restore the other machine's work," but it is implemented as "prefer not-mine," with no timestamp comparison against local. A machine that pushes, keeps working, then pulls will overwrite its own newer transcripts with a stale remote copy.

- **T2 — no local-vs-remote freshness check at all.** `newestActivity()` exists (`claudeNative.ts:57-72`) and is used *only* to pick which `~/.claude*` config dir to read. It is never compared with the archive timestamp.

- **T3 — whole-file replace on same-id transcripts.** Restoring an older archive over a longer local `.jsonl` truncates the tail. Content is unrecoverable (the archive is the only other copy).

- **T4 — session push is additive and therefore safe.** Every archive gets a unique timestamped name; nothing is overwritten in the bucket. Pruning is the only deletion. **No change needed on the push side.**

- **T5 — pull restores exactly one archive, so sessions from other machines are missed.** `claudeNative.ts:342-349` selects a single archive. But an archive contains only the *pushing* machine's session tree. With three machines, restoring the single newest archive silently omits sessions that exist only in machine C's older archive. Session sync is not convergent: no machine ever ends up holding the union.

### 7.1 The on-disk layout decides the merge rule

Verified against a real `~/.claude*/projects/<sanitized-path>/`:

```
<project-dir>/
  <session-uuid>.jsonl              ← transcript, grows by append
  <session-uuid>/subagents/*.jsonl  ← sidecar, keyed under its session
  <session-uuid>/subagents/*.meta.json
  memory/MEMORY.md                  ← NOT session-scoped; rewritten in place
  memory/<slug>.md
```

Session UUIDs are minted per machine, so **two machines working the same project produce disjoint transcript files.** Union is the natural operation, and a same-id collision only occurs when a session was pulled to machine B and *resumed* there while machine A also appended to it. `safeCopySessionTree` already never deletes, so local-only sessions survive a pull today — the damage is narrower than "sessions get clobbered."

That splits the tree into three regions with three different rules:

| Region | Keyed by | Conflicts? | Rule |
|---|---|---|---|
| `<uuid>.jsonl` | session id | only on resume-on-two-machines | union; prefix fast-forward on collision |
| `<uuid>/**` | session id | follows its parent | same decision as the parent transcript |
| `memory/**` | nothing | **yes, always** | mutable shared state — needs its own rule |

**`memory/` is the hole in the model.** It is shared, mutable, and rewritten in place; union-by-uuid does nothing for it and there is no natural merge. The files are small and human-readable, so last-writer-wins with a `.remote-<machine>` backup sidecar is defensible — but it must be a conscious choice, not a side effect of `copyFile`.

**Decisions**

| Case | Decision |
|---|---|
| T1 | Delete the "prefer another machine" heuristic. Choose the genuinely newest archive by `revision`, then timestamp. If it is one this machine pushed and nothing has changed since, it's a no-op — which is the correct answer. |
| T2 | Compare the chosen archive's timestamp against `newestActivity(destDir)` before restoring. Local newer → do not restore; report it; offer `--force`. |
| T3 | Per-file merge, not per-tree copy, partitioned by region (§7.1). For each `<uuid>.jsonl`: local absent → copy. Local is a byte-prefix of remote → fast-forward. Remote is a prefix of local → we are ahead, skip. Neither → **diverged**: keep local, write the remote as `<uuid>.remote-<machine>.jsonl`, report it. Never truncate. Sidecars follow their parent. `memory/**` gets the last-writer-wins + backup rule. |
| T4 | No change. |
| T5 | Restore the union of **the latest archive per machine**, not the single newest archive. Apply the T3 rules across all of them. This is what makes session sync converge. |

**Why the prefix check and not an mtime/size compare:** it does not *assume* `.jsonl` is append-only, it *verifies* it, per file, for free. If Claude ever rewrites a transcript in place (compaction, redaction), the prefix test fails and the file is classified as diverged rather than silently truncated. Cost is a size compare, then a byte compare up to the shorter length.

**Scope caveat.** All of the above is clean for `scope: project`. For `scope: global` the archive is the entire Claude config dir — plugins, todos, shell snapshots, statsig caches — where union semantics are not meaningful. (`settings*.json` / `*.mcp.json` are already skipped for security, `claudeNative.ts:89-92`.) Keep `global` on a coarser "newest wins, with confirmation" rule rather than pretending to merge it.

---

## 8. Domain: Registry entry & config snapshot

**What "newer" means:** the registry is a single JSON object in S3 holding every project. It has `lastPush` and `machineId` (`registry/types.ts:16-19`) and both are **written and never read for ordering**.

**Current behavior**

`registerProject` (`registry/store.ts:143-160`) is a read-modify-write against S3 with no compare-and-swap:

```ts
const registry = await this.load();
// ...only conflict check is on gitRemote...
registry.projects[entry.name] = entry;
await this.save(registry);
```

**Failure cases**

- **R1 — lost update across projects.** Two machines pushing *different projects* concurrently: both `load()` the whole registry, both `save()` it. The second write drops the first machine's project entry entirely. There is no ETag / `If-Match`.
- **R2 — stale `configSnapshot` overwrites a newer one.** Every `push` overwrites `configSnapshot` with the local `.envbeam.yaml` (`push.ts:190,197`). An old machine pushes an old config; the next `init <name>` bootstrap on a *third* machine writes that old config out.
- **R3 — `lastPush` is decorative.** Nothing compares it. It's also local wall-clock (`push.ts:198`), so it couldn't be trusted anyway.

**Decisions**

| Case | Decision |
|---|---|
| R1 | Conditional write. `aws s3api put-object --if-match <etag>` (S3 conditional writes) with bounded retry: reload, re-apply *our* project entry only, re-put. Detect non-supporting endpoints (MinIO/R2 vary) and fall back to read-after-write verification with a loud warning. |
| R2 | Guard `configSnapshot` on `revision`: refuse to overwrite a snapshot from a higher revision than our base. Prompt to pull first. |
| R3 | Replace ordering-by-`lastPush` (which nothing does today) with `revision`. Keep `lastPush` as human-readable metadata only, and label it as such in the schema comment. |

---

## 9. The sleeper: cross-domain incoherence

Everything above treats each domain independently. The worse bug is that **envbeam's steps can partially apply, producing a state no machine was ever in.**

`runResume` (`pipeline/resume.ts:108-174`) runs: git → secrets → deps → session → container → **database**. Each step's failure is independent. Specifically:

- If the tree is dirty, `git.pull()` returns `skipped-dirty` (`git/git.ts:109-114`) and resume **continues**. It then restores a DB snapshot that was taken against a *newer commit*. Old migrations, new data. If that snapshot's schema is ahead of the local code, the app breaks in ways that look like a migration bug.
- `runPause` (`pipeline/pause.ts:68-137`) pushes **git first**, then snapshots the DB, then session, then secrets. A snapshot failure (size cap `pause.ts:275-280`, missing `pg_dump`, network) leaves remote git ahead of remote data. The next machine pulls code that expects data that was never uploaded — and it is told everything is fine, because the git step succeeded.

**Decision:** introduce a **checkpoint** as the unit of sync.

- A checkpoint is `{ revision, gitCommit, snapshotId?, sessionId?, secretsHash }`, written to the registry **once, at the end of a successful push**, and only if the steps it names actually completed.
- `pull` reads the checkpoint and *plans* before it acts: if it cannot reach `gitCommit` (dirty tree, non-ff, unfetchable), it **must not** apply that checkpoint's snapshot. Refuse the whole thing with a clear reason, rather than half-applying.
- Report partial pushes explicitly: "git pushed at `abc123`, DB snapshot skipped (over size cap) — remote checkpoint NOT advanced."

This subsumes most of §5–§8: once a checkpoint is atomic and ordered by `revision`, "is the remote newer than my base" is a single integer comparison, and "did they diverge" is `remote.revision > base.revision && localHasChanges`.

---

## 10. Proposed mechanism

### 10.1 Registry gains a revision and a checkpoint

```ts
// registry/types.ts
projectEntrySchema = z.object({
  name, gitRemote, gitBranch, configSnapshot,
  lastPush, machineId,                    // demoted: human-readable metadata only
  syncTarget,

  /** Monotonic. Incremented on every successful push. The total order. */
  revision: z.number().int().nonnegative().default(0),

  /** What the last successful push actually produced. */
  checkpoint: z.object({
    revision: z.number().int(),
    gitCommit: z.string(),               // full sha — the causal anchor
    gitBranch: z.string(),
    snapshotName: z.string().optional(), // absent = no DB snapshot in this checkpoint
    sessionName: z.string().optional(),
    secretsHash: z.string().optional(),  // sha256 of sorted k=v of pushed secrets
    machineId: z.string(),
    at: z.string(),                      // ISO, informational
  }).optional(),
});
```

### 10.2 Local state gains a base

```ts
// core/state.ts — WorkspaceState
baseRevision?: number;          // registry revision this machine last observed
baseGitCommit?: string;
baseSnapshotName?: string;      // replaces lastRestoredTimestamp AND lastSnapshotTimestamp
baseSessionName?: string;
secretsBase?: { hash: string; keyHashes: Record<string, string>; pulledAt: string };
dotenvHash?: string;            // hash of .env as we last wrote it (S2)
dbFingerprint?: string;         // exists; now also captured at restore time
```

`lastSnapshotTimestamp` / `lastRestoredTimestamp` collapse into `baseSnapshotName`. Migration: on first run, treat a missing `baseRevision` as `0` and *warn once* rather than assuming safety.

### 10.3 The two guards

```
canPush()  = registry.revision === state.baseRevision
             // remote hasn't moved since we last synced

canPull()  = remote.checkpoint.gitCommit is reachable AND
             (localClean OR fast-forwardable) AND
             no unsynced local work in the domains the checkpoint touches
```

Everything else is the message you print when they're false. Both guards produce three outcomes, and this is the whole UX:

| | meaning | default |
|---|---|---|
| **ahead** | local base == remote revision, local has changes | proceed |
| **behind** | remote revision > base, local unchanged | proceed (fast-forward) |
| **diverged** | remote revision > base **and** local has changes | **stop, explain, ask** |

### 10.4 Why `gitCommit` and not just `revision`

`revision` gives a total order but says nothing about *what* changed. Anchoring each checkpoint to a commit sha lets `pull` verify with `git merge-base --is-ancestor <checkpoint.gitCommit> HEAD` that the code we're about to restore data *into* actually contains the migrations that data expects. That is the coherence check from §9, and it costs one git call.

---

## 11. Implementation plan

Ordered so each phase is independently shippable and each one leaves the tool safer than it found it.

### Phase 0 — Stop the bleeding (bug fixes, no new concepts)

Small, high value, no schema change. Ship first.

- **D1** `resume.ts:244-249` — consult `lastSnapshotTimestamp` as well as `lastRestoredTimestamp`; never restore a snapshot this machine produced unless `--force`.
- **T1** `claudeNative.ts:349` — drop the `machine !== machine` preference; pick the newest.
- **T2** `claudeNative.ts:410-434` — compare archive timestamp with `newestActivity(dest.dir)`; skip + report when local is newer.
- **D4** `resume.ts:251-257` — run `hasChanged()` before restore; downgrade `restore: auto` to a prompt when the local DB has changed.
- Tests: one per bug, using `FakeRunner` + a temp sync dir. These are all reproducible without S3.

### Phase 1 — Record a base

- Extend `WorkspaceState` (§10.2). Write `secretsBase` and `dotenvHash` on materialize, `baseSnapshotName` on both push and restore, `baseGitCommit` on both.
- No behavior change yet — just start recording. Ship it so that by the time Phase 2 lands, machines have a base.

### Phase 2 — Registry revision + conditional write

- Schema `revision` + `checkpoint`, `default(0)` so old registries parse.
- `RegistryStore.registerProject` → compare-and-swap via `--if-match` ETag, bounded retry, per-project merge on conflict (fixes **R1**).
- Probe endpoint support for conditional writes once, cache in global config, warn when unavailable.

### Phase 3 — The guards

- `assertCanPush(ctx)` in `runPause` before the git step — the earliest point where we can still abort cleanly.
- `assertCanPull(ctx)` in `runResume` before the git step; carry the resolved checkpoint through the pipeline so the DB step knows which snapshot it is *allowed* to restore.
- Both surface the ahead/behind/diverged table from §10.3, reusing the presentation already built for `confirmPullOverLocalWork` (`commands/pull.ts`).

### Phase 4 — Per-domain merges

- **S1/S2** three-way secrets diff + `.env` backup.
- **T3/T6** per-file `.jsonl` fast-forward with `.remote-<machine>` sidecars on divergence; explicit rule for `memory/**`.
- **T5** restore the union of the latest archive per machine, so session sync converges.
- **D2** push-side snapshot lineage check.

### Phase 5 — Coherence

- Atomic checkpoint write at end of `push`; only names the artifacts that actually uploaded.
- `pull` refuses to apply a checkpoint whose `gitCommit` it cannot reach.
- Report partial pushes loudly.

### Cross-cutting

- **Clock skew (D3):** once `revision` exists, no ordering decision reads a timestamp. Add a one-time sanity check comparing local clock to the S3 `Date` response header; warn past ~60s skew.
- **`--force` everywhere:** every guard gets an explicit escape hatch, and every escape hatch logs what it overrode.
- **`--dry-run`:** the guards must run in dry-run and print their verdict. That's how a user checks safety before committing to a push.

---

## 12. Open questions

1. **`doppler secrets upload` semantics** — does it replace the config's secret set, or merge keys? This determines whether **S1** is *"B fails to add A's key"* (annoying) or *"B deletes A's key"* (data loss). Must be verified against the CLI before Phase 4. Everything else in §6 holds either way.
2. **Conditional writes on non-AWS endpoints** — R2 and MinIO support for `If-Match` on `put-object` varies by version. Need a probe and a documented fallback. Is a warning acceptable, or should envbeam refuse to use a bucket that can't do CAS?
3. **Is `revision` enough, or do we want a real vector clock?** A counter forces a total order and therefore *reports* divergence but cannot describe it precisely ("you both changed the DB" vs "you changed the DB, they changed secrets"). A per-domain revision map is strictly better and barely more code. Leaning toward per-domain.
4. **Snapshot retention vs. divergence.** `prune(keep: 5)` (`pause.ts:324`) can delete the very snapshot a diverged machine needs as its merge base. Should a snapshot named by any known machine's `baseSnapshotName` be pinned against pruning?
5. **Where does `--force` stop?** A force-push of a stale DB snapshot is a legitimate operation ("my local data is authoritative, discard theirs"). A force-restore over uncommitted local data is almost never what anyone wants. Should these share a flag?

---

## 13. Summary table

| # | Domain | Case | Today | Decision |
|---|---|---|---|---|
| G1 | git | `add -A` commits everything | as described | out of scope |
| G2 | git | skipped pull doesn't stop DB restore | **incoherent state** | Phase 5 |
| D1 | db | restores your own snapshot over newer local data | **data loss** | Phase 0 |
| D2 | db | stale machine's snapshot wins by timestamp | **data loss** | Phase 4 |
| D3 | db | clock skew inverts order | latent | Phase 2 (revision) |
| D4 | db | restore clobbers unsaved local changes | **data loss** | Phase 0 |
| D5 | db | fingerprint misses in-place updates | under-detects | wording + never suppress prompts |
| S1 | secrets | two-way push from stale `.env` | lost update | Phase 4 (verify §12.1 first) |
| S2 | secrets | `.env` overwritten silently on pull | local edits lost | Phase 4 |
| S3 | secrets | no base recorded | blocks S1/S2 | Phase 1 |
| S4 | secrets | 1Password `two-way` silently no-ops | misleading | validate at config load |
| T1 | session | prefers a *stale* archive by design | **data loss** | Phase 0 |
| T2 | session | never compares against local activity | **data loss** | Phase 0 |
| T3 | session | whole-file replace truncates `.jsonl` | **data loss** | Phase 4 |
| T4 | session | push is additive | safe | no change |
| T5 | session | pull restores one archive; misses other machines' sessions | never converges | Phase 4 |
| T6 | session | `memory/**` is shared + mutable; no merge rule | last-writer-wins | Phase 4 (explicit rule) |
| R1 | registry | no CAS; concurrent push drops a project | **data loss** | Phase 2 |
| R2 | registry | stale `configSnapshot` overwrites newer | config regression | Phase 3 |
| R3 | registry | `lastPush` written, never read | dead metadata | Phase 2 |
