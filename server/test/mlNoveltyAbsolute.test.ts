import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNovelty, FEATURE_NAMES, type FeatureVector, type FeatureName } from '../src/ml.js';

/**
 * v0.13.3 — P3-2: computeNovelty now maps each pack's Mahalanobis centroid
 * distance ABSOLUTELY against a fixed chi-square cutoff (CHI2_THRESHOLD), rather
 * than dividing by the in-sample MAX distance. The old scaling pinned the single
 * most-deviant pack to exactly 100 by construction — even on a perfectly healthy,
 * homogeneous fleet. These tests pin the new behavior.
 */

/** A FeatureVector whose every normalized feature is `v`. */
function pack(sn: string, packNum: number, v: number): FeatureVector {
  const normalized = {} as Record<FeatureName, number>;
  const values = {} as Record<FeatureName, number | null>;
  for (const n of FEATURE_NAMES) {
    normalized[n] = v;
    values[n] = v;
  }
  return { sn, packNum, values, normalized };
}

// Baseline anchors define centroid = 0.5 and per-feature stdev ≈ 0.1414, so a
// pack with all features at v sits at distance ≈ 17.32·|v−0.5| from the centroid
// (CHI2_THRESHOLD = 3.4 is reached at |v−0.5| ≈ 0.196, i.e. v ≈ 0.70 / 0.30).
const BASELINE = [pack('B', 1, 0.4), pack('B', 2, 0.6)];

test('novelty — a tight/healthy fleet is NOT pinned to 100 (top pack < 100, but proportional)', () => {
  const feats = [pack('P', 1, 0.52), pack('P', 2, 0.55), pack('P', 3, 0.6)]; // all within threshold
  const res = computeNovelty(feats, BASELINE);
  const top = Math.max(...res.map((r) => r.novelty0to100));
  assert.ok(top < 100, `healthy-fleet top novelty must be < 100 (old divide-by-max would force 100), got ${top}`);
  assert.ok(top > 0, `but proportional to distance, not zeroed — got ${top}`);
});

test('novelty — a genuinely far pack (distance ≥ CHI2_THRESHOLD) saturates at 100', () => {
  const res = computeNovelty([pack('P', 9, 0.85)], BASELINE); // distance ≈ 6 ≥ 3.4
  assert.equal(res[0].novelty0to100, 100);
});

test('novelty — monotonic non-decreasing in distance from the centroid', () => {
  const feats = [pack('P', 1, 0.52), pack('P', 2, 0.6), pack('P', 3, 0.68), pack('P', 4, 0.85)];
  const res = computeNovelty(feats, BASELINE); // map() preserves input order
  for (let i = 1; i < res.length; i++) {
    assert.ok(
      res[i].novelty0to100 >= res[i - 1].novelty0to100,
      `novelty must be non-decreasing in distance — got ${res.map((r) => r.novelty0to100)}`,
    );
  }
  // sanity: the closest is well below 100, the farthest is saturated
  assert.ok(res[0].novelty0to100 < 100);
  assert.equal(res[res.length - 1].novelty0to100, 100);
});
