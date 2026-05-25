/**
 * Bridge station selector — six tabs arranged like the bridge stations:
 *
 *   COMMAND · CONN · OPS · ENGINEERING · SCIENCE · TACTICAL
 *
 * Each tab is the "console button" style — warm tan when active, dark
 * brass when inactive. Tactical pulses red when there's an active red
 * alert; Science pulses amber when there are warnings.
 */

export type StationId = 'cmd' | 'conn' | 'eng' | 'sci' | 'tac' | 'ops';

export const STATIONS: Array<{ id: StationId; label: string; subtitle: string }> = [
  { id: 'cmd',  label: 'MAIN VIEWER', subtitle: 'Bridge Overview' },
  { id: 'conn', label: 'CONN',        subtitle: 'Helm · Navigation' },
  { id: 'eng',  label: 'ENGINEERING', subtitle: 'Reactor · M/AM' },
  { id: 'sci',  label: 'SCIENCE',     subtitle: 'Sensors · Forecast' },
  { id: 'tac',  label: 'TACTICAL',    subtitle: 'Defense · Alarms' },
  { id: 'ops',  label: 'OPS',         subtitle: 'Communications' },
];

export interface StationBarProps {
  active: StationId;
  onChange: (id: StationId) => void;
  /** Which stations should pulse — keys are station IDs, values are alert type. */
  flags?: Partial<Record<StationId, 'alert'>>;
}

export function StationBar({ active, onChange, flags }: StationBarProps) {
  return (
    <nav className="flex flex-wrap gap-2 px-4 py-3" aria-label="Bridge stations">
      {STATIONS.map((s) => {
        const isActive = s.id === active;
        const isAlert = flags?.[s.id] === 'alert';
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            className={`sf-station-tab ${isActive ? 'sf-station-tab--active' : ''} ${isAlert && !isActive ? 'sf-station-tab--alert' : ''}`}
            style={{ minWidth: '140px' }}
          >
            <span className="block leading-tight">{s.label}</span>
            <span className="block leading-none mt-0.5" style={{ fontSize: '8px', fontWeight: 400, letterSpacing: '0.18em', opacity: 0.7 }}>{s.subtitle}</span>
          </button>
        );
      })}
    </nav>
  );
}
