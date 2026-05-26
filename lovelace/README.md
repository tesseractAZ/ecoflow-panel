# EcoFlow Panel — Lovelace cards

This HACS plugin ships Lovelace cards for your **EcoFlow Panel**
add-on. Pick one or use several:

| Card | When to use |
|---|---|
| `custom:ecoflow-panel-card` | Compact stats glance — 12 headline numbers in a single panel |
| `custom:ecoflow-panel-dashboard` (v0.9.4) | Multi-tab interface — Dashboard / Battery / Forecast / Alerts |
| `custom:ecoflow-fleet-card` (early dev) | First card in the new Lit-based rewrite — live status + counts (PR2) |
| `custom:ecoflow-alerts-card` (early dev) | Active + cleared alerts, predictive insights, notify controls (PR4) |

For the deepest analytics (interactive charts, per-cell voltage,
strategy config) the PWA at `:8787` remains the full surface — both
cards have an **Open full dashboard** button.

## Lit-based cards (in development)

A new generation of cards is being built on [Lit](https://lit.dev),
written in TypeScript, sharing a single WebSocket connection to the
add-on per host. They live under `src/` and build into `dist/` via
Rollup. The legacy `custom:ecoflow-panel-card` and
`custom:ecoflow-panel-dashboard` remain the production cards and are
unaffected by the new build.

**PR2 — shared infrastructure (current)**

The fleet card now renders real data: connection-state badge plus
device/online/alert counts, driven by:

- **Snapshot store** (`src/shared/snapshot-store.ts`) — per-host
  refcounted singleton; opens a WebSocket on first subscribe,
  REST-seeds from `/api/snapshot`, reconnects with 1/2/4/8/16/30 s
  exponential backoff, and tears down 5 s after the last unsubscribe
  so dashboard tab switches don't churn the connection.
- **Primitives** (`src/shared/primitives/`) — `<ef-badge>`,
  `<ef-tile>`, `<ef-section>` — small LitElements styled off the
  `--ef-*` design tokens.
- **Glossary directive** (`src/shared/glossary.ts`) — Shadow-DOM-safe
  rewrite of the React-era hover-tooltip pass; call `glossary('soc')`
  inside any `html\`\`` template.
- **Ports** — `alerts.ts` and `sort.ts` copied verbatim from
  `web/src/`; pure data, no React.

The full fleet visuals (EnergyFlow SVG, forecast chart) land in PR3+.

**PR4 — alerts card (current)**

`custom:ecoflow-alerts-card` renders the live alerts list, lazy-loaded
cleared history, predictive-insights subset, and notify controls. Each
active alert gets Ack / Dismiss / Failed buttons that POST to
`/api/alerts/outcome` — the feedback loop feeding the learned-risk
model. Empty state is a friendly "No active alerts" with a green tick.
Built independently of PR3 (`fleet-card`); both share the per-host
snapshot WS via the shared store.

Add it to a dashboard alongside the fleet card:

```yaml
type: 'custom:ecoflow-alerts-card'
host: http://homeassistant.local:8787
title: Alerts
```

Manual install (no HACS): copy `dist/ecoflow-alerts-card.js` to
`<config>/www/` and add a JavaScript-Module resource for it. HACS users
can keep using the legacy `ecoflow-panel-card.js` entry while the new
cards stabilize — each card is a self-contained file under `dist/`.

Building locally:

```bash
cd lovelace
npm install
npm run build       # writes dist/ecoflow-{fleet,alerts}-card.js + test bundle
npm run type-check  # tsc --noEmit
```

Built bundles are committed to `dist/` so HACS can serve them
directly without a build step on the user's machine.

**Tests** — `test/snapshot-store.test.html` loads
`dist/snapshot-store.test.js` and runs five vanilla-JS cases against
a stubbed `WebSocket` (subscribe, refcount, reconnect, grace,
getSnapshot). Open the HTML file in a browser after `npm run build`.

## Stats card (`custom:ecoflow-panel-card`)

A focused Home Assistant Lovelace card that pulls the 12 most important
live numbers from your **EcoFlow Panel** add-on and renders them inside
HA — no need to bookmark `:8787`. For deep analytics (Predictive Insights,
Advanced Insights, charts) tap the **Open dashboard →** button to launch
the full PWA.

## What you see

PV right now · Panel load · Backup pool % · Runway to reserve · Projected
SoC low · Grid status · PV lifetime + CO2 avoided · Round-trip
efficiency · Tariff savings · Alerts count · Soonest pack EOL · Clipped
today.

Each tile colour-codes status: green = healthy, amber = watch, red = act.

## Install via HACS (Frontend → Custom repositories)

1. **HACS → Frontend → ⋮ → Custom repositories**
2. Add `https://github.com/tesseractAZ/ecoflow-panel` as **Type: Plugin**
3. Search for "EcoFlow Panel Card" and install it
4. Add to your Lovelace dashboard:
   ```yaml
   type: 'custom:ecoflow-panel-card'
   host: http://homeassistant.local:8787
   refresh_seconds: 30
   ```

## Install manually (no HACS)

1. Copy `dist/ecoflow-panel-card.js` to `<config>/www/ecoflow-panel-card.js`
2. **Settings → Dashboards → Resources → Add resource**
   - URL: `/local/ecoflow-panel-card.js`
   - Resource type: JavaScript Module
3. Add the YAML snippet above to your dashboard

## Options

| Option | Default | Notes |
|---|---|---|
| `host` | `http://<current hostname>:8787` | Where the EcoFlow Panel add-on lives |
| `refresh_seconds` | `30` | Poll interval (min 5) |
| `title` | `EcoFlow Panel` | Card header text |

## Dashboard card (`custom:ecoflow-panel-dashboard`) — v0.9.4

Bigger sibling of the stats card. Four navigable tabs covering the
high-value views inline:

- **Dashboard** — PV/load/backup tiles + per-DPU compact tiles + alert summary
- **Battery** — per-pack SoC/SoH/temp + degradation summary + ML composite risk (heuristic + trained LR + novelty)
- **Forecast** — next-24h PV mini-chart (CSS bars, no chart-lib dep) + key projections
- **Alerts** — full active alerts list with severity colour-coding

Same install path as the stats card. Add to a Lovelace dashboard:

```yaml
type: 'custom:ecoflow-panel-dashboard'
host: http://homeassistant.local:8787
refresh_seconds: 30
default_tab: dashboard       # dashboard | battery | forecast | alerts
```

For manual install (no HACS), copy
`dist/ecoflow-panel-dashboard.js` to `<config>/www/` alongside the
stats card and add a second JavaScript Module resource for it.

## Why two cards and not the full dashboard?

The full React dashboard lives in the add-on and ships as a PWA — you
can Add-to-Home-Screen it for app-like access. Replicating the entire
Predictive Insights / Advanced Insights / per-circuit / strategy views
inside Lovelace would be a multi-week Web Components rewrite that
duplicates work for marginal benefit.

The **stats card** focuses on the quick glance. The **dashboard card**
covers the next layer down — most-asked questions per tab. For the
deepest data (SVG flow diagrams, interactive 24h charts, per-cell
voltage detail, strategy config) the PWA is still the right answer
and lives one button-click away.
