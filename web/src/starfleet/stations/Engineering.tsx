/**
 * ENGINEERING — reactor bank (DPUs), main power bus (SHP2),
 * E.P.S. conduits (panel feeders).
 *
 * The Engineering station was Scotty's panel — pool-table style with
 * rectangular indicators across the bottom. Our adaptation: one row
 * per reactor (DPU) with status jellybeans, then a feeder table.
 */

import { BridgePanel } from '../components/BridgePanel';
import { JellybeanArray, type JellybeanCell } from '../components/JellybeanArray';
import { fmtKW, jellybeanForPct } from '../utils';
import type { FleetSnapshot } from '../../types';

export function Engineering({ snapshot }: { snapshot: FleetSnapshot | null }) {
  if (!snapshot) {
    return <BridgePanel title="ENGINEERING" dept="eng"><div className="sf-working">AWAITING TELEMETRY…</div></BridgePanel>;
  }
  const devices = Object.values(snapshot.devices);
  const dpus = devices
    .filter((d) => d.projection?.kind === 'dpu')
    .sort((a, b) => {
      const an = Number((a.deviceName.match(/\d+/) ?? ['999'])[0]);
      const bn = Number((b.deviceName.match(/\d+/) ?? ['999'])[0]);
      return an - bn;
    });
  const shp2 = devices.find((d) => d.projection?.kind === 'shp2');
  const proj = shp2?.projection?.kind === 'shp2' ? (shp2.projection as any) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[5fr_4fr] gap-3">
      {/* ─── reactor bank ─────────────────────────────────────────── */}
      <BridgePanel title="REACTOR BANK · DELTA PRO ULTRA POOL" subtitle={`${dpus.filter((d) => d.online).length} / ${dpus.length} ONLINE`} dept="eng">
        <div className="space-y-2">
          {dpus.map((d, i) => {
            const p: any = d.projection ?? {};
            const online = d.online;
            const soc = p.soc ?? null;
            const pIn = p.totalInWatts ?? 0;
            const pOut = p.totalOutWatts ?? 0;
            const net = pOut - pIn;
            const errCode = p.sysErrCode ?? 0;
            return (
              <div
                key={d.sn}
                className="grid grid-cols-[110px_80px_110px_110px_110px_1fr] gap-3 items-center px-3 py-2 border-l-2"
                style={{
                  background: 'rgba(20,14,8,0.55)',
                  borderColor: online ? '#c4242a' : '#5a4520',
                  borderRadius: 2,
                  boxShadow: 'inset 0 1px 0 rgb(192 158 96 / 0.1)',
                }}
              >
                <div>
                  <div className="sf-label" style={{ color: '#8c7a5c' }}>UNIT</div>
                  <div className="sf-readout sf-readout-md" style={{ color: '#f4e8c8' }}>M/AM {i + 1}</div>
                </div>
                <div>
                  <div className="sf-label">STATE</div>
                  <span className="sf-jellybean sf-jellybean--lg" style={{
                    ['--jb-color' as any]: online ? '#6fb854' : '#5a4520',
                  }} />
                </div>
                <div>
                  <div className="sf-label">CHARGE</div>
                  <div className="sf-readout sf-readout-md" style={{
                    color: soc == null ? '#5a4520' : soc < 20 ? '#c4242a' : soc < 50 ? '#e89c40' : '#f4e8c8',
                  }}>{soc != null ? soc.toFixed(0) : '—'}<span className="sf-readout-unit">%</span></div>
                </div>
                <div>
                  <div className="sf-label">INTAKE</div>
                  <div className="sf-readout sf-readout-md" style={{ color: '#6fb854' }}>{fmtKW(pIn)}<span className="sf-readout-unit">kW</span></div>
                </div>
                <div>
                  <div className="sf-label">DRAW</div>
                  <div className="sf-readout sf-readout-md" style={{ color: '#e89c40' }}>{fmtKW(pOut)}<span className="sf-readout-unit">kW</span></div>
                </div>
                <div className="text-right">
                  <div className="sf-label">NET ‖ ERR</div>
                  <div className="sf-readout sf-readout-md">
                    {net > 5 ? '◄ DCH ' : net < -5 ? '► CHG ' : 'IDLE '}
                    <span style={{ color: errCode > 0 ? '#c4242a' : '#6fb854' }}>{errCode > 0 ? 'FAULT' : 'NOMINAL'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </BridgePanel>

      {/* ─── main bus + EPS feeders ───────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <BridgePanel title="MAIN POWER BUS · S.H.P. 2" dept="eng">
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div>
              <div className="sf-label">BUS POTENTIAL</div>
              <div className="sf-readout sf-readout-lg">240<span className="sf-readout-unit">V · 60.00 Hz</span></div>
            </div>
            <div className="text-right">
              <div className="sf-label">POOL CHARGE</div>
              <div className="sf-readout sf-readout-lg" style={{ color: '#e89c40' }}>
                {proj?.backupBatPercent != null ? proj.backupBatPercent.toFixed(0) : '—'}<span className="sf-readout-unit">%</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-[#5a4520] text-center">
            <Stat label="RESERVE" value={`${proj?.backupReserveSoc ?? '—'}%`} accent="#4a86c6" />
            <Stat label="CAPACITY" value={`${proj?.backupFullCapWh != null ? (proj.backupFullCapWh / 1000).toFixed(1) : '—'} kWh`} />
            <Stat label="CHG LIMIT" value={`${proj?.chargeWattPower != null ? (proj.chargeWattPower / 1000).toFixed(1) : '—'} kW`} />
          </div>
        </BridgePanel>

        <BridgePanel title="E.P.S. CONDUITS · LOAD DISTRIBUTION" dept="eng">
          <FeederTable proj={proj} />
        </BridgePanel>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="sf-label">{label}</div>
      <div className="sf-readout sf-readout-md" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}

function FeederTable({ proj }: { proj: any }) {
  if (!proj) return <div className="sf-label">NO TELEMETRY</div>;
  const pairedChs = new Set<number>();
  for (const pc of proj.pairedCircuits ?? []) {
    pairedChs.add(pc.primaryCh);
    if (pc.secondaryCh != null) pairedChs.add(pc.secondaryCh);
  }
  type Row = { ch: string; name: string; brk: number | null; w: number | null; v: number };
  const rows: Row[] = [];
  for (const pc of proj.pairedCircuits ?? []) {
    rows.push({
      ch: pc.secondaryCh != null ? `${pc.primaryCh}+${pc.secondaryCh}` : String(pc.primaryCh),
      name: pc.name || `Circuit ${pc.primaryCh}`,
      brk: pc.breakerAmps,
      w: pc.watts,
      v: pc.isSplitPhase ? 240 : 120,
    });
  }
  for (const c of proj.circuits ?? []) {
    if (pairedChs.has(c.ch)) continue;
    rows.push({ ch: String(c.ch), name: c.name || `Circuit ${c.ch}`, brk: c.setAmp, w: c.watts, v: 120 });
  }
  rows.sort((a, b) => Number(a.ch.split('+')[0]) - Number(b.ch.split('+')[0]));

  return (
    <div className="max-h-[420px] overflow-y-auto">
      <div className="grid grid-cols-[80px_1fr_60px_90px_60px] gap-2 sf-label mb-1 px-1">
        <span>CH</span><span>FEEDER</span><span className="text-right">BRK</span><span className="text-right">LOAD</span><span className="text-right">%</span>
      </div>
      <div className="space-y-1">
        {rows.map((r) => {
          const watts = r.w ?? 0;
          const pct = r.brk ? Math.min(100, (Math.abs(watts) / (r.brk * r.v)) * 100) : 0;
          const fillColor = pct >= 80 ? '#c4242a' : pct >= 60 ? '#e89c40' : '#6fb854';
          return (
            <div key={r.ch} className="grid grid-cols-[80px_1fr_60px_90px_60px] gap-2 items-center text-xs px-1 py-1" style={{ borderBottom: '1px dashed rgba(192,158,96,0.15)' }}>
              <span className="sf-readout" style={{ color: '#f4e8c8', fontSize: 12 }}>{r.ch}</span>
              <span style={{ color: '#f4e8c8', fontFamily: 'Antonio, sans-serif' }}>{r.name}</span>
              <span className="text-right sf-readout" style={{ fontSize: 11, color: '#8c7a5c' }}>{r.brk ?? '—'}A</span>
              <span className="text-right sf-readout" style={{ fontSize: 12, color: fillColor }}>{fmtKW(watts)}<span className="sf-readout-unit" style={{ fontSize: 9 }}>kW</span></span>
              <span className="text-right sf-readout" style={{ fontSize: 11 }}>{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
