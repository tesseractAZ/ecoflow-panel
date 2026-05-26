/**
 * Vanilla test runner for the snapshot store. Built by Rollup as
 * `dist/snapshot-store.test.js` and loaded by snapshot-store.test.html.
 * Output goes to a fixed `<pre id="log">` so it's easy to eyeball.
 *
 * Run:   open lovelace/test/snapshot-store.test.html in a browser after
 *        `npm run build`. All cases should show "PASS".
 *
 * Tests use createStore() directly with a stubbed WebSocket so the
 * suite never touches the network.
 */

import { __internal, type SnapshotStore } from '../src/shared/snapshot-store.js';
import type { FleetSnapshot } from '../src/shared/types.js';

type Listener = (ev: any) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;
  readyState = 0;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  fakeOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  fakeMessage(data: any) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  fakeClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
  close() {
    this.fakeClose();
  }
}

function makeSnapshot(generatedAt = Date.now()): FleetSnapshot {
  return { generatedAt, devices: {}, alerts: [] };
}

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, detail: (err as Error).message });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // ── Test 1: subscribe opens WS, message updates snapshot, unsubscribe closes after grace
  await run('subscribe opens WS and delivers snapshot', async () => {
    FakeWebSocket.instances = [];
    const store: SnapshotStore = __internal.createStore('test-host', {
      wsCtor: FakeWebSocket as any,
      fetchImpl: (async () => ({ ok: false, json: async () => null })) as any,
    });
    let latest: FleetSnapshot | null = null;
    const unsub = store.subscribe((s) => {
      latest = s;
    });
    assert(FakeWebSocket.instances.length === 1, 'expected 1 WS instance');
    const ws = FakeWebSocket.instances[0];
    ws.fakeOpen();
    assert(store.connectionState() === 'open', `expected open, got ${store.connectionState()}`);
    const snap = makeSnapshot(123);
    ws.fakeMessage({ type: 'snapshot', data: snap });
    assert(latest != null && (latest as FleetSnapshot).generatedAt === 123, 'snapshot not delivered');
    unsub();
  });

  // ── Test 2: refcount — second subscribe reuses the same store; both notified
  await run('refcount shares store across subscribers', async () => {
    FakeWebSocket.instances = [];
    const store = __internal.createStore('refcount-host', {
      wsCtor: FakeWebSocket as any,
      fetchImpl: (async () => ({ ok: false, json: async () => null })) as any,
    });
    let countA = 0;
    let countB = 0;
    const unA = store.subscribe(() => {
      countA++;
    });
    const unB = store.subscribe(() => {
      countB++;
    });
    assert(FakeWebSocket.instances.length === 1, 'second subscriber should reuse WS');
    const ws = FakeWebSocket.instances[0];
    ws.fakeOpen();
    ws.fakeMessage({ type: 'snapshot', data: makeSnapshot() });
    assert(countA >= 1, 'A not notified');
    assert(countB >= 1, 'B not notified');
    unA();
    unB();
  });

  // ── Test 3: reconnect after close, exponential backoff first step is 1s
  await run('reconnects after close with backoff', async () => {
    FakeWebSocket.instances = [];
    const store = __internal.createStore('reconnect-host', {
      wsCtor: FakeWebSocket as any,
      fetchImpl: (async () => ({ ok: false, json: async () => null })) as any,
    });
    const unsub = store.subscribe(() => {});
    const ws = FakeWebSocket.instances[0];
    ws.fakeOpen();
    assert(store.connectionState() === 'open', 'should be open before close');
    ws.fakeClose();
    assert(
      store.connectionState() === 'reconnecting',
      `should be reconnecting after close, got ${store.connectionState()}`
    );
    // Wait slightly over the first backoff step (1s).
    await sleep(1100);
    assert(FakeWebSocket.instances.length === 2, `expected 2 WS instances after reconnect, got ${FakeWebSocket.instances.length}`);
    unsub();
  });

  // ── Test 4: unsubscribe closes after grace period (5s), re-subscribe within grace cancels teardown
  await run('grace period keeps WS alive briefly', async () => {
    FakeWebSocket.instances = [];
    const store = __internal.createStore('grace-host', {
      wsCtor: FakeWebSocket as any,
      fetchImpl: (async () => ({ ok: false, json: async () => null })) as any,
    });
    const un1 = store.subscribe(() => {});
    const ws = FakeWebSocket.instances[0];
    ws.fakeOpen();
    un1();
    // Within grace period, state should still be 'open' (we don't tear down yet).
    await sleep(200);
    assert(store.connectionState() === 'open', `grace: expected still open, got ${store.connectionState()}`);
    // Re-subscribe within grace cancels teardown.
    const un2 = store.subscribe(() => {});
    await sleep(200);
    assert(FakeWebSocket.instances.length === 1, 'no new WS should open within grace');
    un2();
  });

  // ── Test 5: getSnapshot returns latest received snapshot
  await run('getSnapshot returns latest', async () => {
    FakeWebSocket.instances = [];
    const store = __internal.createStore('getsnap-host', {
      wsCtor: FakeWebSocket as any,
      fetchImpl: (async () => ({ ok: false, json: async () => null })) as any,
    });
    const un = store.subscribe(() => {});
    const ws = FakeWebSocket.instances[0];
    ws.fakeOpen();
    ws.fakeMessage({ type: 'snapshot', data: makeSnapshot(7777) });
    assert(store.getSnapshot()?.generatedAt === 7777, 'getSnapshot returned wrong value');
    un();
  });

  render(results);
}

function render(rows: TestResult[]) {
  const pass = rows.filter((r) => r.passed).length;
  const total = rows.length;
  const lines: string[] = [];
  lines.push(`Snapshot store tests — ${pass} / ${total} passed`);
  lines.push('');
  for (const r of rows) {
    lines.push(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  const el = document.getElementById('log');
  if (el) el.textContent = lines.join('\n');
  // Also publish a programmatic result for headless runners.
  (window as any).__testResults = { pass, total, rows };
}

main();
