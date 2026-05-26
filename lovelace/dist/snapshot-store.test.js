/**
 * Per-host WebSocket-backed snapshot store, shared across all cards on a
 * dashboard so multiple `ecoflow-*` cards pointed at the same add-on share
 * a single live connection.
 *
 * Lifecycle
 * ---------
 *   getStore(host)              -> refcounted singleton per host
 *   store.subscribe(cb)         -> registers cb; first sub opens the WS,
 *                                  also fires a one-shot REST /api/snapshot
 *                                  fetch so cards mounted before the first
 *                                  WS push render real data immediately
 *   (returned unsubscribe)()    -> drops cb; when ref-count hits zero the
 *                                  WS stays alive for `GRACE_MS` (5 s) so
 *                                  Lovelace tab switches and minor DOM
 *                                  churn don't churn the connection
 *
 * Reconnect policy
 * ----------------
 *   Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped).
 *   Counter resets to 1s on a successful open.
 *   `connectionState()` reports the lifecycle so the fleet card can render
 *   a connection badge.
 *
 * Manual test plan
 * ----------------
 * 1. Load dev/index.html with the add-on running. Confirm cards show data.
 * 2. Stop the add-on briefly. Confirm badge turns to "reconnecting" and
 *    the card keeps the last good snapshot.
 * 3. Restart the add-on. Confirm badge returns to "open" within ~15 s and
 *    snapshot updates resume.
 * 4. Open two cards at the same host. Confirm DevTools shows ONE WS
 *    connection (Network tab → WS filter).
 *
 * Automated check
 * ---------------
 * See `test/snapshot-store.test.html` — a tiny vanilla-JS harness that
 * stubs `WebSocket` with a fake, exercises subscribe/unsubscribe/reconnect
 * paths, and asserts state transitions.
 */
const stores = new Map();
const GRACE_MS = 5000;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];
/**
 * Build the WS URL for a host. The store accepts both bare hosts
 * ("homeassistant.local:8787") and full URLs ("http://homeassistant.local:8787"
 * or "https://example.com/path/"). Trailing slashes are normalized away.
 */
function buildWsUrl(host) {
    let h = host.trim().replace(/\/$/, '');
    if (/^https?:\/\//i.test(h)) {
        h = h.replace(/^http/i, 'ws');
    }
    else if (/^wss?:\/\//i.test(h)) ;
    else {
        // bare host:port — default to ws://
        h = `ws://${h}`;
    }
    return `${h}/ws`;
}
function buildApiUrl(host, path) {
    let h = host.trim().replace(/\/$/, '');
    if (/^wss?:\/\//i.test(h)) {
        h = h.replace(/^ws/i, 'http');
    }
    else if (!/^https?:\/\//i.test(h)) {
        h = `http://${h}`;
    }
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${h}${p}`;
}
function createStore(host, opts = {}) {
    const WS = opts.wsCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    const fetchFn = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    let snapshot = null;
    let state = 'idle';
    let ws = null;
    let attempt = 0;
    let reconnectTimer = null;
    let graceTimer = null;
    let destroyed = false;
    let seededOnce = false;
    const subs = new Set();
    const notify = () => {
        for (const cb of subs) {
            try {
                cb(snapshot);
            }
            catch (err) {
                // Per spec: no console.error on the happy path. A subscriber throwing
                // is a card bug — surface it but keep the loop alive.
                if (typeof console !== 'undefined')
                    console.warn('[ecoflow] snapshot subscriber threw', err);
            }
        }
    };
    const setState = (next) => {
        if (state === next)
            return;
        state = next;
        // State changes don't carry snapshot data, but subscribers re-render
        // on any callback. Fleet card reads connectionState() in render().
        notify();
    };
    const clearReconnect = () => {
        if (reconnectTimer != null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };
    const clearGrace = () => {
        if (graceTimer != null) {
            clearTimeout(graceTimer);
            graceTimer = null;
        }
    };
    const teardown = () => {
        clearReconnect();
        if (ws) {
            // Prevent our own handlers from triggering a reconnect.
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
            ws = null;
        }
    };
    const seedFromRest = () => {
        if (seededOnce || !fetchFn)
            return;
        seededOnce = true;
        const url = buildApiUrl(host, '/api/snapshot');
        fetchFn(url)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
            if (destroyed || !data)
                return;
            // Don't clobber a snapshot already delivered by WS.
            if (snapshot != null)
                return;
            snapshot = data;
            notify();
        })
            .catch(() => {
            // REST seed is best-effort; WS is the source of truth.
        });
    };
    const connect = () => {
        if (destroyed || !WS)
            return;
        clearReconnect();
        setState(state === 'idle' ? 'connecting' : 'reconnecting');
        let sock;
        try {
            sock = new WS(buildWsUrl(host));
        }
        catch {
            scheduleReconnect();
            return;
        }
        ws = sock;
        sock.onopen = () => {
            if (destroyed || ws !== sock)
                return;
            attempt = 0;
            setState('open');
            // One-shot REST seed for cards mounted before first WS push.
            seedFromRest();
        };
        sock.onmessage = (ev) => {
            if (destroyed || ws !== sock)
                return;
            try {
                const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
                if (msg && msg.type === 'snapshot' && msg.data) {
                    snapshot = msg.data;
                    notify();
                }
            }
            catch {
                // Malformed frame — ignore, the server is the source of truth.
            }
        };
        sock.onerror = () => {
            // Don't double-close: the browser will fire onclose right after.
            // setState happens in onclose so we have a single transition path.
        };
        sock.onclose = () => {
            if (ws !== sock)
                return; // stale handler from a torn-down socket
            ws = null;
            if (destroyed) {
                setState('closed');
                return;
            }
            scheduleReconnect();
        };
    };
    const scheduleReconnect = () => {
        if (destroyed)
            return;
        setState('reconnecting');
        const idx = Math.min(attempt, BACKOFF_STEPS.length - 1);
        const delay = BACKOFF_STEPS[idx];
        attempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    };
    const store = {
        getSnapshot: () => snapshot,
        connectionState: () => state,
        subscribe(cb) {
            // Cancel any pending teardown — a new sub arrived during the grace window.
            clearGrace();
            subs.add(cb);
            // Push current state immediately so callers don't wait for the next event.
            try {
                cb(snapshot);
            }
            catch (err) {
                if (typeof console !== 'undefined')
                    console.warn('[ecoflow] snapshot subscriber threw', err);
            }
            // First subscriber kicks the connection.
            if (subs.size === 1 && ws == null && state !== 'open' && state !== 'connecting' && state !== 'reconnecting') {
                connect();
            }
            return () => {
                if (!subs.delete(cb))
                    return;
                if (subs.size === 0) {
                    // Grace period — don't tear down for a quick remount.
                    clearGrace();
                    graceTimer = setTimeout(() => {
                        graceTimer = null;
                        if (subs.size === 0) {
                            teardown();
                            attempt = 0;
                            seededOnce = false;
                            setState('idle');
                            // Drop the singleton so a future getStore(host) starts fresh.
                            if (stores.get(host) === store)
                                stores.delete(host);
                        }
                    }, GRACE_MS);
                }
            };
        },
        _destroy() {
            destroyed = true;
            clearGrace();
            teardown();
            setState('closed');
            subs.clear();
            if (stores.get(host) === store)
                stores.delete(host);
        },
    };
    return store;
}
/** Test-only helper. Not exported from the bundle entry points. */
const __internal = { createStore, buildWsUrl, buildApiUrl };

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
class FakeWebSocket {
    constructor(url) {
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        this.readyState = 0;
        this.url = url;
        FakeWebSocket.instances.push(this);
    }
    fakeOpen() {
        this.readyState = 1;
        this.onopen?.({});
    }
    fakeMessage(data) {
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
FakeWebSocket.instances = [];
function makeSnapshot(generatedAt = Date.now()) {
    return { generatedAt, devices: {}, alerts: [] };
}
const results = [];
function assert(cond, msg) {
    if (!cond)
        throw new Error(msg);
}
async function run(name, fn) {
    try {
        await fn();
        results.push({ name, passed: true });
    }
    catch (err) {
        results.push({ name, passed: false, detail: err.message });
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function main() {
    // ── Test 1: subscribe opens WS, message updates snapshot, unsubscribe closes after grace
    await run('subscribe opens WS and delivers snapshot', async () => {
        FakeWebSocket.instances = [];
        const store = __internal.createStore('test-host', {
            wsCtor: FakeWebSocket,
            fetchImpl: (async () => ({ ok: false, json: async () => null })),
        });
        let latest = null;
        const unsub = store.subscribe((s) => {
            latest = s;
        });
        assert(FakeWebSocket.instances.length === 1, 'expected 1 WS instance');
        const ws = FakeWebSocket.instances[0];
        ws.fakeOpen();
        assert(store.connectionState() === 'open', `expected open, got ${store.connectionState()}`);
        const snap = makeSnapshot(123);
        ws.fakeMessage({ type: 'snapshot', data: snap });
        assert(latest != null && latest.generatedAt === 123, 'snapshot not delivered');
        unsub();
    });
    // ── Test 2: refcount — second subscribe reuses the same store; both notified
    await run('refcount shares store across subscribers', async () => {
        FakeWebSocket.instances = [];
        const store = __internal.createStore('refcount-host', {
            wsCtor: FakeWebSocket,
            fetchImpl: (async () => ({ ok: false, json: async () => null })),
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
            wsCtor: FakeWebSocket,
            fetchImpl: (async () => ({ ok: false, json: async () => null })),
        });
        const unsub = store.subscribe(() => { });
        const ws = FakeWebSocket.instances[0];
        ws.fakeOpen();
        assert(store.connectionState() === 'open', 'should be open before close');
        ws.fakeClose();
        assert(store.connectionState() === 'reconnecting', `should be reconnecting after close, got ${store.connectionState()}`);
        // Wait slightly over the first backoff step (1s).
        await sleep(1100);
        assert(FakeWebSocket.instances.length === 2, `expected 2 WS instances after reconnect, got ${FakeWebSocket.instances.length}`);
        unsub();
    });
    // ── Test 4: unsubscribe closes after grace period (5s), re-subscribe within grace cancels teardown
    await run('grace period keeps WS alive briefly', async () => {
        FakeWebSocket.instances = [];
        const store = __internal.createStore('grace-host', {
            wsCtor: FakeWebSocket,
            fetchImpl: (async () => ({ ok: false, json: async () => null })),
        });
        const un1 = store.subscribe(() => { });
        const ws = FakeWebSocket.instances[0];
        ws.fakeOpen();
        un1();
        // Within grace period, state should still be 'open' (we don't tear down yet).
        await sleep(200);
        assert(store.connectionState() === 'open', `grace: expected still open, got ${store.connectionState()}`);
        // Re-subscribe within grace cancels teardown.
        const un2 = store.subscribe(() => { });
        await sleep(200);
        assert(FakeWebSocket.instances.length === 1, 'no new WS should open within grace');
        un2();
    });
    // ── Test 5: getSnapshot returns latest received snapshot
    await run('getSnapshot returns latest', async () => {
        FakeWebSocket.instances = [];
        const store = __internal.createStore('getsnap-host', {
            wsCtor: FakeWebSocket,
            fetchImpl: (async () => ({ ok: false, json: async () => null })),
        });
        const un = store.subscribe(() => { });
        const ws = FakeWebSocket.instances[0];
        ws.fakeOpen();
        ws.fakeMessage({ type: 'snapshot', data: makeSnapshot(7777) });
        assert(store.getSnapshot()?.generatedAt === 7777, 'getSnapshot returned wrong value');
        un();
    });
    render(results);
}
function render(rows) {
    const pass = rows.filter((r) => r.passed).length;
    const total = rows.length;
    const lines = [];
    lines.push(`Snapshot store tests — ${pass} / ${total} passed`);
    lines.push('');
    for (const r of rows) {
        lines.push(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
    }
    const el = document.getElementById('log');
    if (el)
        el.textContent = lines.join('\n');
    // Also publish a programmatic result for headless runners.
    window.__testResults = { pass, total, rows };
}
main();
//# sourceMappingURL=snapshot-store.test.js.map
