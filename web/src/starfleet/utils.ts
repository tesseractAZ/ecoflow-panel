/**
 * Starfleet utilities — stardate conversion, alert-level decisions,
 * formatting helpers tuned for the bridge's data displays.
 */

/**
 * TMP-era stardate. The Star Trek franchise has had several formulae;
 * the TNG-onward convention (year offset × 1000 + day-of-year fraction)
 * gives the densest, most "computer-readable" stardate so we use it.
 * Result format: `XXXXX.X` (e.g. `78145.7`).
 */
export function stardate(now = new Date()): string {
  // Anchor: TNG epoch begins ~stardate 41000 on 2364-01-01.
  // sd = 41000 + (year - 2364) × 1000 + (dayOfYear / daysInYear) × 1000
  const year = now.getFullYear();
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  const dayFrac = (now.getTime() - start) / (end - start);
  const sd = 41000 + (year - 2364) * 1000 + dayFrac * 1000;
  return sd.toFixed(1);
}

/**
 * Map a system state to a Starfleet alert level. The TMP-era bridge
 * had three nominal levels (plus "all clear"):
 *   - Yellow Alert: caution, defensive posture
 *   - Red Alert: combat / emergency, full battle stations
 *   - Condition Green: nominal, but not the chime-loud "all clear"
 */
export type AlertLevel = 'green' | 'yellow' | 'red';

export function alertLevelFromCounts(crit: number, warn: number): AlertLevel {
  if (crit > 0) return 'red';
  if (warn > 0) return 'yellow';
  return 'green';
}

/**
 * The TMP-era ship designation block. Returns the prefix block + a
 * registry number we synthesise from the running plant ID. The actual
 * Enterprise refit was NCC-1701 — we use NCC-EFP-01 to distinguish
 * "Eco-Flow Plant, Hull 01" without claiming to be the real ship.
 */
export function shipDesignation(): { prefix: string; registry: string; name: string; cls: string } {
  return {
    prefix: 'UNITED FEDERATION OF PLANETS · STARFLEET COMMAND',
    registry: 'NCC-EFP-01',
    name: 'U.S.S. ECOFLOW',
    cls: 'CONSTITUTION (refit) · OFF-GRID ENERGY MANAGEMENT',
  };
}

/* ─── numeric formatters tuned for Eurostile-style display ─────────── */

export function fmtKW(w: number | null | undefined): string {
  if (w == null) return '— —';
  const abs = Math.abs(w);
  if (abs >= 1000) return (w / 1000).toFixed(2);
  return (w / 1000).toFixed(3);
}

export function unitKW(w: number | null | undefined): string {
  if (w == null) return 'kW';
  return Math.abs(w) >= 1000 ? 'kW' : 'kW';
}

export function fmtKWh(wh: number | null | undefined): string {
  if (wh == null) return '— —';
  return (wh / 1000).toFixed(2);
}

export function fmtPct(p: number | null | undefined, d = 1): string {
  if (p == null) return '—';
  return p.toFixed(d);
}

export function fmtTimeShort(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ─── colour helpers ──────────────────────────────────────────────── */

export type JellybeanColor = 'red' | 'amber' | 'yellow' | 'green' | 'blue' | 'magenta' | 'white';

const JB_HEX: Record<JellybeanColor, string> = {
  red:     '#c4242a',
  amber:   '#e89c40',
  yellow:  '#e2c44c',
  green:   '#6fb854',
  blue:    '#4a86c6',
  magenta: '#b85b91',
  white:   '#f4e8c8',
};

export function jellybeanHex(c: JellybeanColor): string {
  return JB_HEX[c];
}

/** Pick a jellybean colour from a normalized 0..1 SOC (or similar). */
export function jellybeanForPct(pct: number): JellybeanColor {
  if (pct < 0.20) return 'red';
  if (pct < 0.50) return 'amber';
  if (pct < 0.80) return 'yellow';
  return 'green';
}
