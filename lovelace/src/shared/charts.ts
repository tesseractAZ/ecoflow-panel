import { html, svg, type TemplateResult, type SVGTemplateResult } from 'lit';

/**
 * Tiny hand-rolled SVG chart helpers. Designed for sparklines and the
 * 24-hour forecast area-chart on the fleet card. Reused by PR5 (battery)
 * and PR6 (solar) so the API stays minimal and stable.
 *
 * Why not recharts? recharts is React-only and weighs ~70 KB minified.
 * These helpers cover the dashboard cases (sparkline, layered area + line,
 * optional reference line) for a few hundred bytes total.
 *
 * All functions return a TemplateResult so they slot into a Lit render
 * without extra wrapping. Inputs are plain `{ts, value}` arrays so the
 * caller can integrate with any fetch shape.
 */

export interface ChartPoint {
  ts: number;
  value: number | null;
}

/** Linear scale builder — returns `(input) => screenCoord`. */
function scale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): (v: number) => number {
  const dSpan = domainMax - domainMin || 1;
  const rSpan = rangeMax - rangeMin;
  return (v) => rangeMin + ((v - domainMin) / dSpan) * rSpan;
}

/** Build an SVG path `d` string from points, dropping null values (creates gaps). */
function pathD(
  points: ChartPoint[],
  xs: (t: number) => number,
  ys: (v: number) => number,
): string {
  const parts: string[] = [];
  let pen = false;
  for (const p of points) {
    if (p.value == null || !Number.isFinite(p.value)) {
      pen = false;
      continue;
    }
    const x = xs(p.ts);
    const y = ys(p.value);
    parts.push(`${pen ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`);
    pen = true;
  }
  return parts.join(' ');
}

/** Append a "down to baseline + back" closure so the line path becomes a filled area. */
function areaD(points: ChartPoint[], xs: (t: number) => number, ys: (v: number) => number, baselineY: number): string {
  const line = pathD(points, xs, ys);
  if (!line) return '';
  // Find first and last non-null point for the baseline closure.
  let firstX: number | null = null;
  let lastX: number | null = null;
  for (const p of points) {
    if (p.value != null && Number.isFinite(p.value)) {
      const x = xs(p.ts);
      if (firstX == null) firstX = x;
      lastX = x;
    }
  }
  if (firstX == null || lastX == null) return '';
  return `${line} L ${lastX.toFixed(1)} ${baselineY.toFixed(1)} L ${firstX.toFixed(1)} ${baselineY.toFixed(1)} Z`;
}

export interface SparklineOpts {
  width?: number;
  height?: number;
  color?: string;
  /** Optional fixed y-axis bounds; defaults to data min/max with 5% padding. */
  yMin?: number;
  yMax?: number;
}

/** Single-series mini line chart. ~40 px tall by default. */
export function sparkline(points: ChartPoint[], opts: SparklineOpts = {}): TemplateResult {
  const w = opts.width ?? 320;
  const h = opts.height ?? 40;
  const color = opts.color ?? 'var(--ef-accent)';
  const validValues = points.map((p) => p.value).filter((v): v is number => v != null && Number.isFinite(v));
  if (validValues.length < 2) {
    return html`<div style="height:${h}px;color:var(--ef-muted);font-size:10px;">collecting…</div>`;
  }
  const dataMin = Math.min(...validValues);
  const dataMax = Math.max(...validValues);
  const pad = (dataMax - dataMin) * 0.05 || 1;
  const yMin = opts.yMin ?? dataMin - pad;
  const yMax = opts.yMax ?? dataMax + pad;
  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const xs = scale(tsMin, tsMax, 2, w - 2);
  const ys = scale(yMin, yMax, h - 2, 2); // svg y is flipped
  const d = pathD(points, xs, ys);
  return html`
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true">
      <path d=${d} fill="none" stroke=${color} stroke-width="1.5" />
    </svg>
  `;
}

export interface ForecastSeries {
  /** Filled area in the background (forecast PV). */
  area?: { points: ChartPoint[]; color: string; label?: string };
  /** Overlaid line (forecast load). */
  line?: { points: ChartPoint[]; color: string; label?: string };
  /** Secondary axis line (projected SoC %). 0..100 right axis. */
  rightLine?: { points: ChartPoint[]; color: string; label?: string };
  /** Optional dashed horizontal line on the right (SoC) axis (reserve floor). */
  rightRef?: { value: number; color: string };
}

export interface ForecastChartOpts {
  width?: number;
  height?: number;
  /** Override watt y-axis max. Otherwise derived from data. */
  yMax?: number;
}

/**
 * Layered forecast chart: filled area + overlaid line on a watt axis, plus an
 * optional secondary line on a 0..100% right axis with reference line. Hand
 * rolled — no JSX, no library. Used by the fleet card's forecast section.
 */
export function forecastChart(series: ForecastSeries, opts: ForecastChartOpts = {}): TemplateResult {
  const w = opts.width ?? 720;
  const h = opts.height ?? 220;
  const padL = 36;
  const padR = 36;
  const padT = 10;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const allPts: ChartPoint[] = [
    ...(series.area?.points ?? []),
    ...(series.line?.points ?? []),
    ...(series.rightLine?.points ?? []),
  ];
  if (allPts.length < 2) {
    return html`<div style="height:${h}px;color:var(--ef-muted);font-size:11px;display:flex;align-items:center;justify-content:center;">no forecast data</div>`;
  }
  const tsList = allPts.map((p) => p.ts);
  const tsMin = Math.min(...tsList);
  const tsMax = Math.max(...tsList);

  const wattValues: number[] = [];
  if (series.area) wattValues.push(...series.area.points.map((p) => p.value).filter((v): v is number => v != null));
  if (series.line) wattValues.push(...series.line.points.map((p) => p.value).filter((v): v is number => v != null));
  const wattMax = opts.yMax ?? Math.max(100, ...wattValues) * 1.05;
  const wattMin = Math.min(0, ...wattValues);

  const xs = scale(tsMin, tsMax, padL, padL + plotW);
  const ysW = scale(wattMin, wattMax, padT + plotH, padT);
  const ysPct = scale(0, 100, padT + plotH, padT);
  const baselineY = ysW(0);

  // Hour gridlines (every 6h) for context.
  const gridStep = 6 * 60 * 60 * 1000;
  const startHour = Math.ceil(tsMin / gridStep) * gridStep;
  const gridLines: SVGTemplateResult[] = [];
  for (let t = startHour; t <= tsMax; t += gridStep) {
    const x = xs(t);
    gridLines.push(svg`<line x1=${x} x2=${x} y1=${padT} y2=${padT + plotH} stroke="var(--ef-line)" stroke-dasharray="2 3" stroke-opacity=".6" />`);
  }

  // Y-axis ticks: watts at 0, max/2, max; pct at 0, 50, 100.
  const wTicks = [0, wattMax / 2, wattMax].map((v) => ({ v, y: ysW(v) }));
  const pctTicks = [0, 50, 100].map((v) => ({ v, y: ysPct(v) }));

  // Build paths.
  const areaPath = series.area ? areaD(series.area.points, xs, ysW, baselineY) : '';
  const linePath = series.line ? pathD(series.line.points, xs, ysW) : '';
  const rightLinePath = series.rightLine ? pathD(series.rightLine.points, xs, ysPct) : '';
  const refY = series.rightRef ? ysPct(series.rightRef.value) : null;

  // Legend rendered as inline HTML next to the SVG (keeps SVG small/static).
  // Inline styles are unavoidable since this helper has no shadow root of its own.
  const sw = 'display:inline-block;width:14px;height:2px;margin-right:4px;vertical-align:middle';
  const aw = 'display:inline-block;width:10px;height:10px;opacity:.6;border-radius:2px;margin-right:4px';
  const legend = html`<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--ef-muted);margin-top:4px;">${series.area?.label
    ? html`<span><span style="${aw};background:${series.area.color};"></span>${series.area.label}</span>`
    : null}${series.line?.label
    ? html`<span><span style="${sw};background:${series.line.color};"></span>${series.line.label}</span>`
    : null}${series.rightLine?.label
    ? html`<span><span style="${sw};background:${series.rightLine.color};"></span>${series.rightLine.label}</span>`
    : null}</div>`;

  return html`<svg viewBox="0 0 ${w} ${h}" width="100%" height=${h} preserveAspectRatio="none" aria-hidden="true">${gridLines}${wTicks.map(
    (t) => svg`<line x1=${padL} x2=${padL + plotW} y1=${t.y} y2=${t.y} stroke="var(--ef-line)" stroke-opacity=".4" /><text x=${padL - 4} y=${t.y + 3} text-anchor="end" font-size="9" fill="var(--ef-muted)">${(t.v / 1000).toFixed(1)}k</text>`,
  )}${pctTicks.map(
    (t) => svg`<text x=${padL + plotW + 4} y=${t.y + 3} text-anchor="start" font-size="9" fill="var(--ef-muted)">${t.v.toFixed(0)}%</text>`,
  )}${refY != null
    ? svg`<line x1=${padL} x2=${padL + plotW} y1=${refY} y2=${refY} stroke=${series.rightRef!.color} stroke-dasharray="4 4" stroke-opacity=".7" />`
    : null}${areaPath ? svg`<path d=${areaPath} fill=${series.area!.color} fill-opacity=".35" stroke="none" />` : null}${linePath ? svg`<path d=${linePath} fill="none" stroke=${series.line!.color} stroke-width="1.6" />` : null}${rightLinePath ? svg`<path d=${rightLinePath} fill="none" stroke=${series.rightLine!.color} stroke-width="2" />` : null}</svg>${legend}`;
}
