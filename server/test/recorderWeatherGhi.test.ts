import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * v0.13.1 — durable weather-irradiance persistence (the GHI backfill).
 *
 * Root cause being pinned: forecast-skill (days 4-7), the soiling estimator,
 * and Bayesian solar-model training all need HISTORICAL global horizontal
 * irradiance, but the only source was weather.ts's in-memory cache — a 2h
 * TTL over a short fetch window that evaporates on restart. The fix
 * persists each fetch's past+present hours to the recorder DB under the
 * pseudo-device SN "weather" (metric "ghi_wm2" + "cloud_pct") so the series
 * survives and consumers can read it back over the full window via query().
 *
 * These tests prove (a) written hours come back through the normal query
 * API, and (b) re-writing the same hours is a no-op — the change-detection /
 * idempotency holds so the series stays at ~24 rows/day, not N×24.
 */

// Point the recorder at a throwaway DB BEFORE it (→ config.ts) is imported.
// config.dbPath is read from process.env.DB_PATH at module-load, and
// createRecorder resolves it against process.cwd(), so an absolute path here
// keeps the test hermetic regardless of where the runner is invoked from.
const tmp = mkdtempSync(join(tmpdir(), 'ef-ghi-'));
process.env.DB_PATH = join(tmp, 'ecoflow.db');

const { createRecorder } = await import('../src/recorder.js');
const { SnapshotStore } = await import('../src/snapshot.js');

const HOUR = 3_600_000;
// Three consecutive, clearly-distinct GHI hours (above VALUE_EPSILON apart)
// plus matching cloud cover. Timestamps are already top-of-hour.
const BASE = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
const hours = [
  { epochMs: BASE + 0 * HOUR, radiationWm2: 120, cloudCoverPct: 40 },
  { epochMs: BASE + 1 * HOUR, radiationWm2: 350, cloudCoverPct: 15 },
  { epochMs: BASE + 2 * HOUR, radiationWm2: 610, cloudCoverPct: 5 },
];

test('recordWeatherGhi — persisted hours come back via query("weather","ghi_wm2")', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    rec.recordWeatherGhi(hours);

    const ghi = rec
      .query('weather', 'ghi_wm2', BASE - HOUR, BASE + 3 * HOUR)
      .map((r) => ({ ts: r.ts, value: r.value }));
    assert.deepEqual(ghi, [
      { ts: BASE + 0 * HOUR, value: 120 },
      { ts: BASE + 1 * HOUR, value: 350 },
      { ts: BASE + 2 * HOUR, value: 610 },
    ]);

    // Cloud cover is persisted under the same SN as its own metric.
    const cloud = rec
      .query('weather', 'cloud_pct', BASE - HOUR, BASE + 3 * HOUR)
      .map((r) => ({ ts: r.ts, value: r.value }));
    assert.deepEqual(cloud, [
      { ts: BASE + 0 * HOUR, value: 40 },
      { ts: BASE + 1 * HOUR, value: 15 },
      { ts: BASE + 2 * HOUR, value: 5 },
    ]);
  } finally {
    rec.close();
  }
});

test('recordWeatherGhi — re-writing the same hours adds no duplicate rows (idempotent)', () => {
  const store = new SnapshotStore();
  const rec = createRecorder(store, () => {});
  try {
    rec.recordWeatherGhi(hours);
    const before = rec.query('weather', 'ghi_wm2', BASE - HOUR, BASE + 3 * HOUR).length;
    assert.equal(before, 3, 'three distinct GHI hours on first write');

    // Re-write the identical batch twice; change-detection must hold.
    rec.recordWeatherGhi(hours);
    rec.recordWeatherGhi(hours);

    const after = rec.query('weather', 'ghi_wm2', BASE - HOUR, BASE + 3 * HOUR).length;
    assert.equal(after, 3, 'no duplicate rows after re-writing the same hours');

    // Same guarantee for the cloud series.
    assert.equal(
      rec.query('weather', 'cloud_pct', BASE - HOUR, BASE + 3 * HOUR).length,
      3,
      'cloud series also free of duplicates',
    );
  } finally {
    rec.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
