import { describe, it, expect } from 'vitest';
import { threeWayMergeSecrets } from '../../src/core/providers/secrets/threeWay.js';
import { hashSecrets } from '../../src/core/providers/secrets/materialize.js';
import type { SecretsBase } from '../../src/core/state.js';

const baseOf = (values: Record<string, string>): SecretsBase => ({
  ...hashSecrets(values),
  pulledAt: '2026-07-10T00:00:00Z',
});

// SYNC_SAFETY.md S1 — a two-way push read .env and uploaded it wholesale, so a
// machine whose file predated another's push published a set that had never seen
// the newer key.
describe('threeWayMergeSecrets', () => {
  it('folds in a key another machine added, without needing to know upload semantics', () => {
    const base = baseOf({ API_KEY: 'k' });
    // A added STRIPE_KEY upstream. Our .env predates it.
    const r = threeWayMergeSecrets(base, { API_KEY: 'k' }, { API_KEY: 'k', STRIPE_KEY: 's' });
    expect(r.merged).toEqual({ API_KEY: 'k', STRIPE_KEY: 's' });
    expect(r.remoteWins).toEqual(['STRIPE_KEY']);
    expect(r.conflicts).toEqual([]);
  });

  it('keeps a value only this machine changed', () => {
    const base = baseOf({ API_KEY: 'old' });
    const r = threeWayMergeSecrets(base, { API_KEY: 'new' }, { API_KEY: 'old' });
    expect(r.merged).toEqual({ API_KEY: 'new' });
    expect(r.localWins).toEqual(['API_KEY']);
  });

  it('takes a value only the provider changed', () => {
    const base = baseOf({ API_KEY: 'old' });
    const r = threeWayMergeSecrets(base, { API_KEY: 'old' }, { API_KEY: 'rotated' });
    expect(r.merged).toEqual({ API_KEY: 'rotated' });
    expect(r.remoteWins).toEqual(['API_KEY']);
  });

  it('reports a conflict when both sides changed a key differently', () => {
    const base = baseOf({ API_KEY: 'old' });
    const r = threeWayMergeSecrets(base, { API_KEY: 'mine' }, { API_KEY: 'theirs' });
    expect(r.conflicts).toEqual([{ key: 'API_KEY', local: 'mine', remote: 'theirs' }]);
    expect(r.merged).not.toHaveProperty('API_KEY'); // caller must decide
  });

  it('is not a conflict when both sides made the SAME change', () => {
    const base = baseOf({ API_KEY: 'old' });
    const r = threeWayMergeSecrets(base, { API_KEY: 'same' }, { API_KEY: 'same' });
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toEqual({ API_KEY: 'same' });
  });

  it('adds keys this machine created', () => {
    const base = baseOf({});
    const r = threeWayMergeSecrets(base, { NEW: 'v' }, {});
    expect(r.merged).toEqual({ NEW: 'v' });
    expect(r.localWins).toEqual(['NEW']);
  });

  it('never deletes a provider secret just because .env no longer has it', () => {
    const base = baseOf({ API_KEY: 'k', OLD_KEY: 'o' });
    const r = threeWayMergeSecrets(base, { API_KEY: 'k' }, { API_KEY: 'k', OLD_KEY: 'o' });
    expect(r.merged).toEqual({ API_KEY: 'k', OLD_KEY: 'o' }); // still there
    expect(r.removedLocally).toEqual(['OLD_KEY']);
  });

  it('drops a key the provider deleted and we never touched', () => {
    const base = baseOf({ API_KEY: 'k', GONE: 'g' });
    const r = threeWayMergeSecrets(base, { API_KEY: 'k', GONE: 'g' }, { API_KEY: 'k' });
    expect(r.merged).toEqual({ API_KEY: 'k' });
  });

  it('keeps our value when they deleted a key we changed', () => {
    const base = baseOf({ K: 'old' });
    const r = threeWayMergeSecrets(base, { K: 'mine' }, {});
    expect(r.merged).toEqual({ K: 'mine' });
    expect(r.localWins).toEqual(['K']);
  });

  it('keeps their value when we deleted a key they changed', () => {
    const base = baseOf({ K: 'old' });
    const r = threeWayMergeSecrets(base, {}, { K: 'theirs' });
    expect(r.merged).toEqual({ K: 'theirs' });
    expect(r.removedLocally).toEqual(['K']);
  });

  it('the merged set is a union, so it is safe whether upload merges or replaces', () => {
    const base = baseOf({ SHARED: 'v' });
    const r = threeWayMergeSecrets(base, { SHARED: 'v', MINE: 'm' }, { SHARED: 'v', THEIRS: 't' });
    // Uploading this set cannot lose THEIRS under replace semantics, and cannot
    // fail to add MINE under merge semantics.
    expect(r.merged).toEqual({ SHARED: 'v', MINE: 'm', THEIRS: 't' });
  });

  // S3 — without a base, "who changed it" has no answer.
  describe('without a recorded base', () => {
    it('treats every differing key as a conflict rather than guessing', () => {
      const r = threeWayMergeSecrets(undefined, { K: 'mine' }, { K: 'theirs' });
      expect(r.degraded).toBe(true);
      expect(r.conflicts).toEqual([{ key: 'K', local: 'mine', remote: 'theirs' }]);
    });

    it('still unions keys that exist on only one side', () => {
      const r = threeWayMergeSecrets(undefined, { MINE: 'm' }, { THEIRS: 't' });
      expect(r.merged).toEqual({ MINE: 'm', THEIRS: 't' });
      expect(r.conflicts).toEqual([]);
    });

    it('agrees silently when both sides hold the same value', () => {
      const r = threeWayMergeSecrets(undefined, { K: 'v' }, { K: 'v' });
      expect(r.conflicts).toEqual([]);
      expect(r.merged).toEqual({ K: 'v' });
    });
  });
});
