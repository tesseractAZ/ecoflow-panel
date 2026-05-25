/**
 * Wireframe schematic — the vector-line "computer simulation" graphic
 * that filled the TMP main viewer (V'ger probe approaches, drydock
 * sequence, warp-engine cutaway, etc.).
 *
 * For our purposes we render a top-down schematic of the plant: PV array
 * → SHP2 main bus → DPU pool → loads. All thin amber lines on black,
 * with small symbol nodes where data values dock.
 */

import type { ReactNode } from 'react';

export interface WireframeSchematicProps {
  /** PV total wattage (for live label). */
  pvW: number;
  /** SHP2 panel total load. */
  loadW: number;
  /** Battery net (>0 discharging, <0 charging). */
  batNetW: number;
  /** Backup pool percent. */
  socPct: number | null;
  /** Grid AC import (W). 0 = islanded. */
  gridW: number;
  /** Per-DPU SOC for the reactor-bank schematic, in display order. */
  dpus: Array<{ name: string; soc: number | null; online: boolean }>;
  width?: number;
  height?: number;
}

/**
 * The diagram is positioned by hand to read like a 1970s engineering
 * blueprint: thin amber lines, square junctions, every node labeled
 * with all-caps Eurostile + a live numeric.
 */
export function WireframeSchematic(p: WireframeSchematicProps) {
  const W = p.width ?? 720;
  const H = p.height ?? 360;
  const amber = '#e89c40';
  const dim = '#8c7a5c';
  const ink = '#f4e8c8';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet">
      {/* Grid background */}
      <defs>
        <pattern id="sf-blueprint-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(192,158,96,0.05)" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill="url(#sf-blueprint-grid)" />

      {/* === Node positions ============================================= */}
      {(() => {
        // 5 columns: PV  →  ARRAY-JUNCTION  →  REACTOR-BANK  →  MAIN-BUS  →  LOADS
        const cols = [W * 0.08, W * 0.30, W * 0.50, W * 0.70, W * 0.92];
        const midY = H * 0.5;

        // PV node + symbol (sun rays)
        const pvX = cols[0];
        // Grid node (below PV)
        const gridY = midY + 90;
        // Main bus is a vertical line at cols[3]
        const busX = cols[3];

        return (
          <>
            {/* === Trunk lines ============================================ */}
            {/* PV  →  reactor bank */}
            <line x1={pvX + 28} y1={midY} x2={cols[2] - 38} y2={midY} stroke={amber} strokeWidth="1.5" />
            {/* Reactor bank  →  main bus */}
            <line x1={cols[2] + 38} y1={midY} x2={busX - 6} y2={midY} stroke={amber} strokeWidth="1.5" />
            {/* Main bus vertical (loads tap upward, batteries below) */}
            <line x1={busX} y1={midY - 90} x2={busX} y2={midY + 100} stroke={amber} strokeWidth="2.5" />
            {/* Bus  →  loads */}
            <line x1={busX + 6} y1={midY} x2={cols[4] - 24} y2={midY} stroke={amber} strokeWidth="1.5" />
            {/* Bus  →  grid (down branch) */}
            <line x1={pvX + 28} y1={gridY} x2={busX - 6} y2={gridY} stroke={p.gridW < 5 ? dim : amber} strokeWidth="1.5" strokeDasharray={p.gridW < 5 ? '4 3' : undefined} />
            <line x1={busX} y1={midY + 1} x2={busX} y2={gridY} stroke={p.gridW < 5 ? dim : amber} strokeWidth="1.5" strokeDasharray={p.gridW < 5 ? '4 3' : undefined} />

            {/* === PV node ============================================== */}
            <NodeSquare cx={pvX} cy={midY} label="PV ARRAY" sub={`${formatKw(p.pvW)} kW`} />
            <SunSymbol cx={pvX} cy={midY - 32} />

            {/* === Reactor bank (DPUs) ================================= */}
            <text x={cols[2]} y={midY - 90} textAnchor="middle" fontFamily="Antonio" fontSize="10" letterSpacing="0.2em" fill={dim}>REACTOR BANK · DPU POOL</text>
            <DpuBank cx={cols[2]} cy={midY} dpus={p.dpus} />

            {/* === Main bus ============================================ */}
            <text x={busX + 12} y={midY - 92} fontFamily="Antonio" fontSize="10" letterSpacing="0.2em" fill={dim}>MAIN POWER BUS</text>
            <text x={busX + 12} y={midY - 78} fontFamily="Antonio" fontSize="12" fontWeight="700" fill={ink}>240V · 60.00 Hz</text>

            {/* === Loads node =========================================== */}
            <NodeSquare cx={cols[4]} cy={midY} label="HOUSE LOAD" sub={`${formatKw(p.loadW)} kW`} />

            {/* === Battery storage (below) ============================== */}
            <NodeSquare cx={busX} cy={midY + 100} w={120} h={48} label="BACKUP POOL" sub={`${p.socPct != null ? p.socPct.toFixed(0) : '—'} % · ${p.batNetW > 5 ? '◄ DISCHARGING' : p.batNetW < -5 ? '► CHARGING' : 'IDLE'}`} />

            {/* === Grid (lower-left branch) ============================ */}
            <NodeSquare cx={pvX} cy={gridY} label="A.C. INTAKE" sub={p.gridW < 5 ? 'ISLANDED' : `${formatKw(p.gridW)} kW`} dim={p.gridW < 5} />

            {/* Stardate-style frame marks */}
            <text x={10} y={H - 8} fontFamily="Share Tech Mono" fontSize="9" fill={dim} letterSpacing="0.15em">DIAGRAM REV-1701-D · TOP-DOWN PLAN VIEW</text>
            <text x={W - 10} y={H - 8} textAnchor="end" fontFamily="Share Tech Mono" fontSize="9" fill={dim} letterSpacing="0.15em">CLASSIFICATION: ENGINEERING · PUBLIC</text>
          </>
        );
      })()}
    </svg>
  );
}

function NodeSquare({ cx, cy, w = 90, h = 36, label, sub, dim }: { cx: number; cy: number; w?: number; h?: number; label: string; sub: string; dim?: boolean }) {
  const ink = dim ? '#8c7a5c' : '#f4e8c8';
  const stroke = dim ? '#5a4520' : '#c09e60';
  return (
    <g>
      <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} fill="rgba(0,0,0,0.55)" stroke={stroke} strokeWidth="1" rx="2" />
      <text x={cx} y={cy - 5} textAnchor="middle" fontFamily="Antonio" fontSize="9" letterSpacing="0.18em" fill="#8c7a5c">{label}</text>
      <text x={cx} y={cy + 9} textAnchor="middle" fontFamily="Antonio" fontWeight="700" fontSize="12" fill={ink}>{sub}</text>
    </g>
  );
}

function SunSymbol({ cx, cy }: { cx: number; cy: number }) {
  const c = '#e89c40';
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI * 2) / 8;
    const x1 = cx + Math.cos(a) * 6;
    const y1 = cy + Math.sin(a) * 6;
    const x2 = cx + Math.cos(a) * 11;
    const y2 = cy + Math.sin(a) * 11;
    return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth="1.2" />;
  });
  return (
    <g style={{ filter: 'drop-shadow(0 0 4px #e89c40)' }}>
      <circle cx={cx} cy={cy} r="5" fill="none" stroke={c} strokeWidth="1.5" />
      {rays}
    </g>
  );
}

function DpuBank({ cx, cy, dpus }: { cx: number; cy: number; dpus: WireframeSchematicProps['dpus'] }) {
  // Render up to 5 rectangles stacked vertically. Each is the reactor.
  const n = Math.min(5, Math.max(1, dpus.length));
  const rowH = 22;
  const w = 70;
  const totalH = n * rowH + (n - 1) * 4;
  const top = cy - totalH / 2;
  return (
    <g>
      {dpus.slice(0, n).map((d, i) => {
        const y = top + i * (rowH + 4);
        const ink = d.online ? '#f4e8c8' : '#8c7a5c';
        const stroke = d.online ? '#c09e60' : '#5a4520';
        const socColor = d.soc == null ? '#5a4520' :
                         d.soc < 20 ? '#c4242a' :
                         d.soc < 50 ? '#e89c40' :
                         '#6fb854';
        return (
          <g key={i}>
            <rect x={cx - w / 2} y={y} width={w} height={rowH} fill="rgba(0,0,0,0.5)" stroke={stroke} strokeWidth="1" rx="1" />
            {/* SOC fill bar inside the rectangle (small) */}
            <rect x={cx - w / 2 + 4} y={y + rowH - 5} width={(w - 8) * Math.max(0, Math.min(1, (d.soc ?? 0) / 100))} height="2" fill={socColor} />
            <text x={cx - w / 2 + 6} y={y + 12} fontFamily="Antonio" fontSize="9" fill={ink} letterSpacing="0.12em">{d.name}</text>
            <text x={cx + w / 2 - 6} y={y + 12} textAnchor="end" fontFamily="Antonio" fontWeight="700" fontSize="10" fill={ink}>{d.soc != null ? `${d.soc.toFixed(0)}%` : '—'}</text>
          </g>
        );
      })}
    </g>
  );
}

function formatKw(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 10_000) return (w / 1000).toFixed(1);
  if (abs >= 1000) return (w / 1000).toFixed(2);
  return (w / 1000).toFixed(3);
}
