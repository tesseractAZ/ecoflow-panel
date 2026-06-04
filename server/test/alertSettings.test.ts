import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// v0.11.0 — the persistence path is read at module-load time (PATH constant),
// so the env override MUST be set BEFORE the import. Use a unique tmp file so
// this suite never collides with a real /data file or a parallel run.
const SETTINGS_PATH = resolve(tmpdir(), `alert-settings-test-${process.pid}-${Date.now()}.json`);
process.env.ALERT_SETTINGS_PATH = SETTINGS_PATH;

const {
  getAlertSettings,
  isPriorityEnabled,
  getChimeRepeat,
  updateAlertSettings,
  _resetAlertSettingsCacheForTest,
} = await import('../src/alertSettings.js');

test('defaults — all four priorities enabled, chimeRepeat === 2', () => {
  const s = getAlertSettings();
  assert.equal(s.priorityEnabled.critical, true);
  assert.equal(s.priorityEnabled.high, true);
  assert.equal(s.priorityEnabled.medium, true);
  assert.equal(s.priorityEnabled.low, true);
  assert.equal(s.chimeRepeat, 2);
  assert.equal(getChimeRepeat(), 2);
});

test('updateAlertSettings — disabling a priority persists to disk', () => {
  const next = updateAlertSettings({ priorityEnabled: { critical: false } });
  assert.equal(next.priorityEnabled.critical, false);
  // Other priorities untouched.
  assert.equal(next.priorityEnabled.high, true);
  // isPriorityEnabled reflects the live cache.
  assert.equal(isPriorityEnabled('critical'), false);
  assert.equal(isPriorityEnabled('high'), true);
  // The settings file now exists on disk.
  assert.ok(existsSync(SETTINGS_PATH), 'settings file should be written');
});

test('chimeRepeat — clamps out-of-range values to 1..4', () => {
  assert.equal(updateAlertSettings({ chimeRepeat: 99 }).chimeRepeat, 4);
  assert.equal(getChimeRepeat(), 4);
  assert.equal(updateAlertSettings({ chimeRepeat: 0 }).chimeRepeat, 1);
  assert.equal(getChimeRepeat(), 1);
});

test('_resetAlertSettingsCacheForTest — re-reads persisted value from disk', () => {
  // critical was disabled (and persisted) above. Drop the in-memory cache so the
  // next read must re-load from the file — the on-disk value should still hold.
  _resetAlertSettingsCacheForTest();
  assert.equal(isPriorityEnabled('critical'), false);
  // The persisted chimeRepeat (1, from the previous test) is re-read too.
  assert.equal(getChimeRepeat(), 1);
});

test('cleanup tmp file', () => {
  rmSync(SETTINGS_PATH, { force: true });
  assert.ok(true);
});
