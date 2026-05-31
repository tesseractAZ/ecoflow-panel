// v0.10.2 — worker entry bootstrap.
//
// The analytics worker is a .ts module, but tsx's ESM loader does NOT reliably
// auto-propagate into worker threads: it inherits on macOS dev, but in the HA
// add-on container (node 22 + tsx, started via `tsx src/index.ts`) the worker
// came up with `Unknown file extension ".ts"`, and a bare `execArgv:
// ['--import','tsx']` didn't register the loader on the container's tsx
// version either.
//
// This bootstrap is a .mjs — Node loads it natively, no loader required. It
// registers tsx's loader for THIS (worker) thread, then dynamically imports
// the real .ts worker, which now resolves via the registered loader. Two
// strategies for resilience across tsx/node versions:
//   1. node:module register('tsx/esm', …)  — the standard API (node ≥ 20.6)
//   2. tsx/esm/api register()               — tsx's own programmatic helper
let registered = false;
try {
  const { register } = await import('node:module');
  register('tsx/esm', import.meta.url);
  registered = true;
} catch {
  /* fall through to tsx's own API */
}
if (!registered) {
  const { register } = await import('tsx/esm/api');
  register();
}

await import('./analyticsWorker.ts');
