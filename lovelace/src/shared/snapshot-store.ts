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

import type { FleetSnapshot } from './types.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'reconnecting';

export interface SnapshotStore {
  getSnapshot(): FleetSnapshot | null;
  subscribe(cb: (s: FleetSnapshot | null) => void): () => void;
  connectionState(): ConnectionState;
}

interface InternalStore extends SnapshotStore {
  /** Test-only: force a teardown (used by test harness). */
  _destroy(): void;
}

const stores = new Map<string, InternalStore>();

const GRACE_MS = 5000;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Build the WS URL for a host. The store accepts both bare hosts
 * ("homeassistant.local:8787") and full URLs ("http://homeassistant.local:8787"
 * or "https://example.com/path/"). Trailing slashes are normalized away.
 */
function buildWsUrl(host: string): string {
  let h = host.trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(h)) {
    h = h.replace(/^http/i, 'ws');
  } else if (/^wss?:\/\//i.test(h)) {
    // already a ws URL — leave it
  } else {
    // bare host:port — default to ws://
    h = `ws://${h}`;
  }
  return `${h}/ws`;
}

function buildApiUrl(host: string, path: string): string {
  let h = host.trim().replace(/\/$/, '');
  if (/^wss?:\/\//i.test(h)) {
    h = h.replace(/^ws/i, 'http');
  } else if (!/^https?:\/\//i.test(h)) {
    h = `http://${h}`;
  }
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${h}${p}`;
}

interface CreateOpts {
  /** Optional WebSocket constructor for tests. Defaults to global WebSocket. */
  wsCtor?: typeof WebSocket;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

function createStore(host: string, opts: CreateOpts = {}): InternalStore {
  const WS = opts.wsCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  const fetchFn = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);

  let snapshot: FleetSnapshot | null = null;
  let state: ConnectionState = 'idle';
  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let seededOnce = false;

  const subs = new Set<(s: FleetSnapshot | null) => void>();

  const notify = () => {
    for (const cb of subs) {
      try {
        cb(snapshot);
      } catch (err) {
        // Per spec: no console.error on the happy path. A subscriber throwing
        // is a card bug — surface it but keep the loop alive.
        if (typeof console !== 'undefined') console.warn('[ecoflow] snapshot subscriber threw', err);
      }
    }
  };

  const setState = (next: ConnectionState) => {
    if (state === next) return;
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
      } catch {
        /* ignore */
      }
      ws = null;
    }
  };

  const seedFromRest = () => {
    if (seededOnce || !fetchFn) return;
    seededOnce = true;
    const url = buildApiUrl(host, '/api/snapshot');
    fetchFn(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (destroyed || !data) return;
        // Don't clobber a snapshot already delivered by WS.
        if (snapshot != null) return;
        snapshot = data as FleetSnapshot;
        notify();
      })
      .catch(() => {
        // REST seed is best-effort; WS is the source of truth.
      });
  };

  const connect = () => {
    if (destroyed || !WS) return;
    clearReconnect();
    setState(state === 'idle' ? 'connecting' : 'reconnecting');
    let sock: WebSocket;
    try {
      sock = new WS(buildWsUrl(host));
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      if (destroyed || ws !== sock) return;
      attempt = 0;
      setState('open');
      // One-shot REST seed for cards mounted before first WS push.
      seedFromRest();
    };

    sock.onmessage = (ev: MessageEvent) => {
      if (destroyed || ws !== sock) return;
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (msg && msg.type === 'snapshot' && msg.data) {
          snapshot = msg.data as FleetSnapshot;
          notify();
        }
      } catch {
        // Malformed frame — ignore, the server is the source of truth.
      }
    };

    sock.onerror = () => {
      // Don't double-close: the browser will fire onclose right after.
      // setState happens in onclose so we have a single transition path.
    };

    sock.onclose = () => {
      if (ws !== sock) return; // stale handler from a torn-down socket
      ws = null;
      if (destroyed) {
        setState('closed');
        return;
      }
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (destroyed) return;
    setState('reconnecting');
    const idx = Math.min(attempt, BACKOFF_STEPS.length - 1);
    const delay = BACKOFF_STEPS[idx];
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const store: InternalStore = {
    getSnapshot: () => snapshot,
    connectionState: () => state,
    subscribe(cb) {
      // Cancel any pending teardown — a new sub arrived during the grace window.
      clearGrace();
      subs.add(cb);
      // Push current state immediately so callers don't wait for the next event.
      try {
        cb(snapshot);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[ecoflow] snapshot subscriber threw', err);
      }
      // First subscriber kicks the connection.
      if (subs.size === 1 && ws == null && state !== 'open' && state !== 'connecting' && state !== 'reconnecting') {
        connect();
      }
      return () => {
        if (!subs.delete(cb)) return;
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
              if (stores.get(host) === store) stores.delete(host);
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
      if (stores.get(host) === store) stores.delete(host);
    },
  };

  return store;
}

export function getStore(host: string): SnapshotStore {
  const existing = stores.get(host);
  if (existing) return existing;
  const store = createStore(host);
  stores.set(host, store);
  return store;
}

/** Test-only helper. Not exported from the bundle entry points. */
export const __internal = { createStore, buildWsUrl, buildApiUrl };
