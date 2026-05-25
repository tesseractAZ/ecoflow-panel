/**
 * The Starfleet bridge — top-level component when theme=starfleet.
 *
 * Renders the iconic TMP-era bridge surround: warm tan header with
 * Starfleet delta + ship designation + stardate, station selector row,
 * then the active station's content panel area.
 *
 * Owns its own state for the active station; deliberately does NOT use
 * the existing tab/page state — Starfleet is a different organization
 * of the data.
 */

import { useState } from 'react';
import { useSnapshot } from '../useSnapshot';
import { DeltaShield } from './components/DeltaShield';
import { StationBar, type StationId } from './components/StationBar';
import { stardate, shipDesignation, alertLevelFromCounts } from './utils';
import { MainViewer } from './stations/MainViewer';
import { Conn } from './stations/Conn';
import { Engineering } from './stations/Engineering';
import { Science } from './stations/Science';
import { Tactical } from './stations/Tactical';
import { Ops } from './stations/Ops';
import { ThemeToggle } from '../components/ThemeToggle';

export function StarfleetBridge() {
  const { snapshot, conn } = useSnapshot();
  const [station, setStation] = useState<StationId>('cmd');

  const alerts = snapshot?.alerts ?? [];
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const level = alertLevelFromCounts(crit, warn);
  const ship = shipDesignation();

  return (
    <div className="sf-bridge">
      {/* === Header banner (tan/jellybean console look) =============== */}
      <header className="sf-header">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center gap-4">
          <DeltaShield size={48} color="#1a120a" glow={false} />
          <div className="flex flex-col">
            <div style={{ fontSize: 10, letterSpacing: '0.35em', fontWeight: 700 }}>{ship.prefix}</div>
            <div style={{ fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 22, letterSpacing: '0.12em', lineHeight: 1.1 }}>{ship.name}</div>
            <div style={{ fontSize: 10, letterSpacing: '0.18em', opacity: 0.75 }}>{ship.cls}</div>
          </div>
          <div className="ml-auto flex items-center gap-6">
            <div className="text-right">
              <div style={{ fontSize: 9, letterSpacing: '0.3em', fontWeight: 700 }}>STARDATE</div>
              <div style={{ fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{stardate()}</div>
            </div>
            <div className="text-right">
              <div style={{ fontSize: 9, letterSpacing: '0.3em', fontWeight: 700 }}>REGISTRY</div>
              <div style={{ fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{ship.registry}</div>
            </div>
            <div className="text-right">
              <div style={{ fontSize: 9, letterSpacing: '0.3em', fontWeight: 700 }}>CONDITION</div>
              <div style={{
                fontFamily: 'Antonio, sans-serif', fontWeight: 700, fontSize: 18, lineHeight: 1,
                color: level === 'red' ? '#c4242a' : level === 'yellow' ? '#a8581a' : '#3a5018',
              }}>{level === 'red' ? 'RED' : level === 'yellow' ? 'YELLOW' : 'GREEN'}</div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* === Station selector ========================================= */}
      <div className="max-w-[1800px] mx-auto">
        <StationBar
          active={station}
          onChange={setStation}
          flags={{
            tac: crit > 0 || warn > 0 ? 'alert' : undefined,
          }}
        />
      </div>

      {/* === Active station content =================================== */}
      <main className="max-w-[1800px] mx-auto px-4 pb-8">
        {!snapshot ? (
          <div className="sf-panel text-center py-12">
            <div className="sf-working" style={{ fontSize: 18 }}>ESTABLISHING SUBSPACE LINK · STAND BY…</div>
            <div className="sf-label mt-3">SOCKET: {conn}</div>
          </div>
        ) : (
          <StationContent station={station} snapshot={snapshot} />
        )}
      </main>

      {/* === Footer === */}
      <footer className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between text-xs" style={{ borderTop: '1px solid #5a4520', color: '#8c7a5c' }}>
        <span style={{ fontFamily: 'Antonio, sans-serif', letterSpacing: '0.2em' }}>STARFLEET INTERFACE · TMP-ERA · ALL DUTY STATIONS REPORTING</span>
        <span style={{ fontFamily: 'Share Tech Mono', letterSpacing: '0.15em' }}>SOCK · {conn.toUpperCase()}</span>
      </footer>
    </div>
  );
}

function StationContent({ station, snapshot }: { station: StationId; snapshot: any }) {
  switch (station) {
    case 'cmd':  return <MainViewer snapshot={snapshot} />;
    case 'conn': return <Conn snapshot={snapshot} />;
    case 'eng':  return <Engineering snapshot={snapshot} />;
    case 'sci':  return <Science snapshot={snapshot} />;
    case 'tac':  return <Tactical snapshot={snapshot} />;
    case 'ops':  return <Ops snapshot={snapshot} />;
  }
}
