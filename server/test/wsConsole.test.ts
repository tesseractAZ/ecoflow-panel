/**
 * Tests for the browser web-terminal transport (/console).
 *
 *   1. parseXtermData — the char-mode (NO telnet IAC) keyboard parser maps
 *      ESC arrows, CR/LF→enter, Ctrl-C, TAB and printable ASCII to the same
 *      transport-agnostic InputEvents the telnet parser produces.
 *   2. TuiSession — the extracted session driver renders frames to its write
 *      sink, applies key navigation, honors resize, suppresses byte-identical
 *      frames (anti-flicker), and reports quit on ctrl-c / q.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXtermData } from '../src/telnet/wsConsole.js';
import { TuiSession } from '../src/telnet/session.js';
import type { TuiDataProvider } from '../src/telnet/session.js';
import type { FleetSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function mockRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function mockDataProvider(): TuiDataProvider {
  const snap: FleetSnapshot = { generatedAt: Date.now(), devices: {}, alerts: [] };
  return {
    store: { get: () => snap } as any,
    recorder: mockRecorder(),
    totals: () => null,
    forecast: () => null,
    degradation: () => null,
    serverStartedAt: Date.now() - 60_000,
  };
}

/** A TuiSession wired to a string-collecting sink. */
function makeSession(width = 100, height = 40) {
  const writes: string[] = [];
  const session = new TuiSession({
    write: (d) => writes.push(d),
    data: mockDataProvider(),
    width,
    height,
  });
  return { session, writes };
}

/* ── parseXtermData ────────────────────────────────────────────────────── */

test('parseXtermData — printable keys', () => {
  assert.deepEqual(parseXtermData('1'), [{ type: 'key', key: '1' }]);
  assert.deepEqual(parseXtermData('q'), [{ type: 'key', key: 'q' }]);
  assert.deepEqual(parseXtermData('ab'), [
    { type: 'key', key: 'a' },
    { type: 'key', key: 'b' },
  ]);
});

test('parseXtermData — CR, LF and CRLF all become a single enter', () => {
  assert.deepEqual(parseXtermData('\r'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(parseXtermData('\n'), [{ type: 'key', key: 'enter' }]);
  assert.deepEqual(parseXtermData('\r\n'), [{ type: 'key', key: 'enter' }]);
});

test('parseXtermData — Ctrl-C and TAB', () => {
  assert.deepEqual(parseXtermData('\x03'), [{ type: 'key', key: 'ctrl-c' }]);
  assert.deepEqual(parseXtermData('\t'), [{ type: 'key', key: 'tab' }]);
});

test('parseXtermData — arrow keys (CSI and SS3 forms)', () => {
  assert.deepEqual(parseXtermData('\x1b[A'), [{ type: 'key', key: 'up' }]);
  assert.deepEqual(parseXtermData('\x1b[B'), [{ type: 'key', key: 'down' }]);
  assert.deepEqual(parseXtermData('\x1b[C'), [{ type: 'key', key: 'right' }]);
  assert.deepEqual(parseXtermData('\x1b[D'), [{ type: 'key', key: 'left' }]);
  assert.deepEqual(parseXtermData('\x1bOA'), [{ type: 'key', key: 'up' }]);
});

test('parseXtermData — bare ESC is its own key', () => {
  assert.deepEqual(parseXtermData('\x1b'), [{ type: 'key', key: 'esc' }]);
});

test('parseXtermData — no IAC handling (0xFF is just skipped, not a command)', () => {
  // A telnet parser would treat 0xFF (IAC) as a command lead-in; the char-mode
  // parser has no IAC concept, so a lone 0xFF byte is a non-printable skip and
  // the following printable still registers.
  assert.deepEqual(parseXtermData('\xff1'), [{ type: 'key', key: '1' }]);
});

/* ── TuiSession driver ─────────────────────────────────────────────────── */

test('TuiSession — first draw writes a non-empty synchronized frame', () => {
  const { session, writes } = makeSession();
  session.draw();
  assert.equal(writes.length, 1);
  // Wrapped in mode-2026 synchronized-output escapes.
  assert.ok(writes[0].startsWith('\x1b[?2026h'), 'frame not wrapped in BEGIN_SYNC');
  assert.ok(writes[0].endsWith('\x1b[?2026l'), 'frame not wrapped in END_SYNC');
});

test('TuiSession — identical re-draw is suppressed (anti-flicker)', () => {
  const { session, writes } = makeSession();
  session.draw();
  const after1 = writes.length;
  session.draw(); // nothing changed → byte-identical body → no write
  assert.equal(writes.length, after1, 'identical frame should not be re-written');
});

test('TuiSession — navigating chooser → plant produces a new frame', () => {
  const { session, writes } = makeSession();
  session.draw();
  const before = writes.length;
  const r = session.feed([{ type: 'key', key: '1' }]); // pick Plant Operator
  assert.equal(r.redraw, true);
  session.draw();
  assert.ok(writes.length > before, 'mode switch should yield a fresh frame');
});

test('TuiSession — ctrl-c and q report quit', () => {
  const a = makeSession();
  assert.equal(a.session.feed([{ type: 'key', key: 'ctrl-c' }]).quit, true);
  const b = makeSession();
  assert.equal(b.session.feed([{ type: 'key', key: 'q' }]).quit, true);
  const c = makeSession();
  assert.equal(c.session.feed([{ type: 'key', key: 'Q' }]).quit, true);
});

test('TuiSession — resize clamps to the supported range and flags change', () => {
  const { session } = makeSession(100, 40);
  // Within range.
  assert.equal(session.resize(120, 50), true);
  assert.equal(session.width, 120);
  assert.equal(session.height, 50);
  // Same size → no change.
  assert.equal(session.resize(120, 50), false);
  // Out of range → clamped (cols 60..200, rows 16..80).
  assert.equal(session.resize(9999, 9999), true);
  assert.equal(session.width, 200);
  assert.equal(session.height, 80);
  assert.equal(session.resize(1, 1), true);
  assert.equal(session.width, 60);
  assert.equal(session.height, 16);
  // Non-positive is ignored.
  assert.equal(session.resize(0, 0), false);
});

test('TuiSession — resize via a naws InputEvent redraws', () => {
  const { session } = makeSession(100, 40);
  const r = session.feed([{ type: 'naws', w: 120, h: 50 }]);
  assert.equal(r.redraw, true);
  assert.equal(session.width, 120);
  assert.equal(session.height, 50);
});

test('TuiSession — TAB from a console returns to the chooser', () => {
  const { session } = makeSession();
  session.feed([{ type: 'key', key: '1' }]); // into plant
  assert.equal(session.isInteractive, true);
  const r = session.feed([{ type: 'key', key: 'tab' }]); // back to chooser
  assert.equal(r.redraw, true);
  assert.equal(session.isInteractive, false);
});
