import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';

const { createReadRecorder } = await import('../src/readRecorder.js');
const { buildReport, isReportName, WARM_REPORTS } = await import('../src/reports.js');

/* A temp WAL DB seeded with a known series, mirroring recorder.ts's schema. */
function tempDb(rows: Array<[number, string, string, number]>): string {
  const path = `/tmp/worker-offload-test-${process.pid}-${rows.length}.db`;
  try { unlinkSync(path); } catch { /* */ }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE samples (ts INTEGER, sn TEXT, metric TEXT, value REAL);
    CREATE INDEX idx ON samples (sn, metric, ts);`);
  const ins = db.prepare('INSERT INTO samples (ts,sn,metric,value) VALUES (?,?,?,?)');
  for (const r of rows) ins.run(...r);
  db.close();
  return path;
}

test('readRecorder — raw query returns rows in ts order', () => {
  const path = tempDb([
    [1000, 'A', 'pv', 10],
    [2000, 'A', 'pv', 20],
    [3000, 'A', 'pv', 30],
    [1500, 'B', 'pv', 99],
  ]);
  const rec = createReadRecorder(path);
  // node:sqlite returns rows as null-prototype objects (so does recorder.ts);
  // map to plain objects so deepEqual compares values, not prototypes.
  const out = rec.query('A', 'pv', 0, 5000).map((r) => ({ ts: r.ts, value: r.value }));
  assert.deepEqual(out, [
    { ts: 1000, value: 10 },
    { ts: 2000, value: 20 },
    { ts: 3000, value: 30 },
  ]);
  // range filter excludes out-of-window + other-sn
  assert.equal(rec.query('A', 'pv', 1500, 2500).length, 1);
  assert.equal(rec.query('B', 'pv', 0, 5000).length, 1);
  rec.close();
  unlinkSync(path);
});

test('readRecorder — bucketed query averages within bucket, canonical bucket ts', () => {
  // Two samples inside the same 60s bucket → averaged; one in the next.
  const path = tempDb([
    [60_000, 'A', 'pv', 100],
    [90_000, 'A', 'pv', 200],   // same 60s bucket as 60_000 (bucket start 60_000)
    [120_000, 'A', 'pv', 50],   // next bucket (start 120_000)
  ]);
  const rec = createReadRecorder(path);
  const out = rec.query('A', 'pv', 0, 200_000, 60);  // 60s buckets
  assert.deepEqual(out, [
    { ts: 60_000, value: 150 },   // (100+200)/2, bucket start = floor(ts/60000)*60000
    { ts: 120_000, value: 50 },
  ]);
  rec.close();
  unlinkSync(path);
});

test('readRecorder — queryMulti batches metrics, empty array for missing', () => {
  const path = tempDb([
    [1000, 'A', 'pv', 10],
    [1000, 'A', 'load', 5],
    [2000, 'A', 'pv', 20],
  ]);
  const rec = createReadRecorder(path);
  const m = rec.queryMulti('A', ['pv', 'load', 'missing'], 0, 5000);
  assert.deepEqual(m.get('pv'), [{ ts: 1000, value: 10 }, { ts: 2000, value: 20 }]);
  assert.deepEqual(m.get('load'), [{ ts: 1000, value: 5 }]);
  assert.deepEqual(m.get('missing'), []);   // pre-seeded empty, never undefined
  rec.close();
  unlinkSync(path);
});

test('readRecorder — listMetrics returns distinct metrics sorted', () => {
  const path = tempDb([
    [1000, 'A', 'pv', 1],
    [1000, 'A', 'ac_in', 1],
    [2000, 'A', 'pv', 1],
  ]);
  const rec = createReadRecorder(path);
  assert.deepEqual(rec.listMetrics('A'), ['ac_in', 'pv']);
  rec.close();
  unlinkSync(path);
});

test('readRecorder — write methods are stubbed no-ops (read-only)', () => {
  const path = tempDb([[1000, 'A', 'pv', 1]]);
  const rec = createReadRecorder(path);
  // These must not throw and must not mutate the DB.
  rec.insertSnapshot({ generatedAt: 0, devices: {} } as any);
  rec.rollupLifetime();
  assert.deepEqual(rec.getLifetimeTotals(), {});
  assert.equal(rec.query('A', 'pv', 0, 5000).length, 1);
  rec.close();
  unlinkSync(path);
});

test('reports — registry shape: isReportName, WARM_REPORTS, unknown throws', async () => {
  assert.ok(isReportName('selfConsumption'));
  assert.ok(isReportName('degradation'));
  assert.ok(!isReportName('totally-not-a-report'));
  assert.ok(WARM_REPORTS.length >= 20, 'warm set covers the dashboard reports');
  assert.ok(WARM_REPORTS.every((n) => isReportName(n)), 'every warm report is a real report');

  const path = tempDb([[1000, 'A', 'pv_total', 100]]);
  const rec = createReadRecorder(path);
  const ctx = { recorder: rec, snapshot: { generatedAt: 0, devices: {} }, log: () => {} };
  await assert.rejects(() => buildReport('nope', ctx), /unknown report/);
  rec.close();
  unlinkSync(path);
});

test('reports — buildReport(selfConsumption) returns a well-formed report', async () => {
  const path = tempDb([[1000, 'A', 'pv_total', 100]]);
  const rec = createReadRecorder(path);
  const ctx = { recorder: rec, snapshot: { generatedAt: 0, devices: {} }, log: () => {} };
  const sc: any = await buildReport('selfConsumption', ctx, { days: 7 });
  assert.equal(typeof sc, 'object');
  for (const k of ['pvKwh', 'loadKwh', 'batteryChargeKwh', 'windowDays']) {
    assert.ok(k in sc, `selfConsumption report has ${k}`);
  }
  assert.equal(sc.windowDays, 7);
  rec.close();
  unlinkSync(path);
});
