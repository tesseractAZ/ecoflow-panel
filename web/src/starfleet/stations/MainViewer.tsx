/**
 * MAIN VIEWER — the captain's-chair-eye view. Used as the bridge's
 * landing screen.
 *
 * Layout (TMP-era main viewer convention):
 *   - Header: alert condition, stardate, ship status
 *   - Wireframe schematic of the plant (top-down "blueprint" view)
 *   - Headline readouts: backup pool SOC, fleet power flow, alert count
 *   - Stardate / chronometer
 */

import { useMemo } from 'react';
import { BridgePanel } from '../components/BridgePanel';
import { WireframeSchematic } from '../components/WireframeBlock';
import { RingGauge } from '../components/RingGauge';
import { JellybeanArray, type JellybeanCell } from '../components/JellybeanArray';
import {
  stardate, fmtKW, fmtPct,
} from '../utils';
import type { FleetSnapshot, DeviceSnapshot } from '../../types';

export function MainViewer({ snapshot }: { snapshot: FleetSnapshot | null }) {
  const data = useMemo(() => buildOverview(snapshot), [snapshot]);
  if (!data) {
    return <BridgePanel title="MAIN VIEWER" dept="cmd"><div className="sf-working">AWAITING TELEMETRY…</div></BridgePanel>;
  }

  return (
    <div className="grid lg:grid-cols-[2fr_1fr] gap-3">
      {/* === LEFT: wireframe schematic ============================== */}
      <BridgePanel title="PLANT SCHEMATIC · TOP-DOWN" subtitle={`STARDATE ${stardate()}`} dept="cmd">
        <WireframeSchematic
          pvW={data.pvW}
          loadW={data.loadW}
          batNetW={data.batNetW}
          socPct={data.socPct}
          gridW={data.gridW}
          dpus={data.dpus}
        />
      </BridgePanel>

      {/* === RIGHT: vitals stack =================================== */}
      <div className="flex flex-col gap-3">
        {/* Backup pool ring */}
        <BridgePanel title="BACKUP POOL · CAPACITY" dept="eng">
          <div className="flex flex-col items-center">
            <RingGauge
              value={data.socPct ?? 0}
              setpoint={data.reservePct ?? undefined}
              size={220}
              centerNumber={data.socPct != null ? data.socPct.toFixed(1) : '— —'}
              centerUnit="PERCENT"
              centerLabel="CHARGE STATE"
              fillColor="#e89c40"
            />
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 mt-3 w-full text-center">
              <div>
                <div className="sf-label">RUN · DISCHARGE</div>
                <div className="sf-readout sf-readout-md">{data.dchHrs != null ? data.dchHrs.toFixed(1) : '—'}<span className="sf-readout-unit">HR</span></div>
              </div>
              <div>
                <div className="sf-label">RECHARGE EST.</div>
                <div className="sf-readout sf-readout-md">{data.chHrs != null ? data.chHrs.toFixed(1) : '—'}<span className="sf-readout-unit">HR</span></div>
              </div>
            </div>
          </div>
        </BridgePanel>

        {/* Power flow tiles */}
        <BridgePanel title="POWER FLOW · LIVE" dept="eng">
          <div className="grid grid-cols-3 gap-3">
            <FlowTile label="SOLAR" value={fmtKW(data.pvW)} unit="kW" color="amber" />
            <FlowTile label="LOAD" value={fmtKW(data.loadW)} unit="kW" color="white" />
            <FlowTile label="BATT NET" value={fmtKW(Math.abs(data.batNetW))} unit="kW" color={data.batNetW > 5 ? 'amber' : data.batNetW < -5 ? 'green' : 'blue'} sub={data.batNetW > 5 ? '◄ DCH' : data.batNetW < -5 ? '► CHG' : 'IDLE'} />
          </div>
        </BridgePanel>

        {/* Alert tally */}
        <BridgePanel title="CONDITION · ALARMS" dept="tac">
          <div className="flex items-center justify-between mb-3">
            <div className="sf-label">CONDITION</div>
            <span className={
              data.alertCrit > 0 ? 'sf-alert-banner' :
              data.alertWarn > 0 ? 'sf-alert-banner sf-alert-banner--yellow' :
              'sf-alert-banner sf-alert-banner--green'
            } style={{ fontSize: '11px' }}>
              {data.alertCrit > 0 ? 'RED ALERT' : data.alertWarn > 0 ? 'YELLOW ALERT' : 'CONDITION GREEN'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Tally label="CRIT" n={data.alertCrit} color="red" />
            <Tally label="WARN" n={data.alertWarn} color="amber" />
            <Tally label="INFO" n={data.alertInfo} color="blue" />
          </div>
        </BridgePanel>
      </div>
    </div>
  );
}

function FlowTile({ label, value, unit, color, sub }: { label: string; value: string; unit: string; color: 'amber' | 'green' | 'blue' | 'white'; sub?: string }) {
  const fill =
    color === 'amber' ? '#e89c40' :
    color === 'green' ? '#6fb854' :
    color === 'blue' ? '#4a86c6' : '#f4e8c8';
  return (
    <div className="text-center">
      <div className="sf-label">{label}</div>
      <div className="sf-readout sf-readout-lg mt-1" style={{ color: fill, textShadow: `0 0 6px ${fill}99` }}>{value}</div>
      <div className="sf-readout-unit">{unit}</div>
      {sub && <div className="sf-label mt-1" style={{ color: fill }}>{sub}</div>}
    </div>
  );
}

function Tally({ label, n, color }: { label: string; n: number; color: 'red' | 'amber' | 'blue' }) {
  const fill = color === 'red' ? '#c4242a' : color === 'amber' ? '#e89c40' : '#4a86c6';
  return (
    <div>
      <div className="sf-label">{label}</div>
      <div className="sf-readout sf-readout-lg" style={{ color: fill, textShadow: `0 0 6px ${fill}99` }}>{n}</div>
    </div>
  );
}

function buildOverview(snap: FleetSnapshot | null) {
  if (!snap) return null;
  const devices = Object.values(snap.devices);
  const shp2 = devices.find((d) => d.projection?.kind === 'shp2');
  const dpus = devices
    .filter((d) => (d.productName ?? '').toLowerCase().includes('delta pro ultra'))
    .sort((a, b) => {
      const an = Number((a.deviceName.match(/\d+/) ?? ['999'])[0]);
      const bn = Number((b.deviceName.match(/\d+/) ?? ['999'])[0]);
      return an - bn;
    });
  const onlineDpus = dpus.filter((d) => d.online && d.projection?.kind === 'dpu');
  const sum = (f: (d: DeviceSnapshot) => number | null | undefined) =>
    onlineDpus.reduce((s, d) => s + (f(d) ?? 0), 0);
  const pvW = sum((d) => (d.projection as any)?.pvTotalWatts);
  const totIn = sum((d) => (d.projection as any)?.totalInWatts);
  const totOut = sum((d) => (d.projection as any)?.totalOutWatts);
  const batNetW = totOut - totIn;
  const acIn = sum((d) => (d.projection as any)?.acInWatts);
  const loadW = shp2?.projection?.kind === 'shp2'
    ? (shp2.projection as any).circuits.reduce((s: number, c: any) => s + (c.watts ?? 0), 0)
    : sum((d) => (d.projection as any)?.acOutWatts);
  const socPct = shp2?.projection?.kind === 'shp2' ? (shp2.projection as any).backupBatPercent : null;
  const reservePct = shp2?.projection?.kind === 'shp2' ? (shp2.projection as any).backupReserveSoc : null;
  const dchHrs = shp2?.projection?.kind === 'shp2' && (shp2.projection as any).backupDischargeTimeMin != null
    ? (shp2.projection as any).backupDischargeTimeMin / 60 : null;
  const chHrs = shp2?.projection?.kind === 'shp2' && (shp2.projection as any).backupChargeTimeMin != null
    ? (shp2.projection as any).backupChargeTimeMin / 60 : null;
  const alerts = snap.alerts ?? [];
  return {
    pvW,
    loadW,
    batNetW,
    socPct,
    reservePct,
    gridW: acIn,
    dchHrs,
    chHrs,
    dpus: dpus.map((d) => ({
      name: d.deviceName,
      soc: (d.projection as any)?.soc ?? null,
      online: d.online,
    })),
    alertCrit: alerts.filter((a) => a.severity === 'critical').length,
    alertWarn: alerts.filter((a) => a.severity === 'warning').length,
    alertInfo: alerts.filter((a) => a.severity === 'info').length,
  };
}
