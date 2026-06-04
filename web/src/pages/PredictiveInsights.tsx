import type { Alert } from '../types';
import { SubjectBoxes } from '../cards/AlertParts';
// v0.11.0 — label learned signals by ISA priority (learned warnings → Medium, learned info → Low).
import { priorityOf, priorityMeta, priorityCounts } from '../alertPriority';
import { ForecastDetail } from '../cards/ForecastDetail';
import { DegradationCard } from '../cards/DegradationCard';
import { AdvancedInsightsCard } from '../cards/AdvancedInsightsCard';

/**
 * Predictive Insights — the learned-anomaly + forecast engine, shown in full
 * statistical detail. Splits into "Anomalies" (unusual right now: peer
 * comparison + self-baseline) and "Forecasts" (where it's heading: runtime,
 * degradation, day-ahead). The plain Alerts page keeps the fixed-threshold rules.
 */
export function PredictiveInsights({ alerts }: { alerts: Alert[] }) {
  // Sort by ISA priority — most-severe first.
  const byPriority = (xs: Alert[]) =>
    [...xs].sort((a, b) => priorityMeta(priorityOf(a)).rank - priorityMeta(priorityOf(b)).rank);
  const anomalies = byPriority(alerts.filter((a) => !a.id.startsWith('forecast-')));
  const forecasts = byPriority(alerts.filter((a) => a.id.startsWith('forecast-')));
  const counts = priorityCounts(alerts);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Predictive insights</span>
          <span className="text-xs text-muted normal-case tracking-normal">{alerts.length} learned signal(s)</span>
        </div>
        <p className="text-sm text-muted leading-relaxed">
          Not fixed-threshold rules. The learned engine compares every battery pack against its
          four siblings, every sensor against its own hour-of-day history, and projects current
          trends forward — surfacing problems an absolute limit would miss.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <CountTile label="Anomalies" value={anomalies.length} accent={anomalies.length ? 'text-accent' : 'text-muted'} />
          <CountTile label="Forecasts" value={forecasts.length} accent={forecasts.length ? 'text-accent' : 'text-muted'} />
          <CountTile
            label="Actionable"
            value={counts.critical + counts.high + counts.medium}
            accent={counts.critical + counts.high + counts.medium ? 'text-warn' : 'text-muted'}
          />
          <CountTile label="Low" value={counts.low} accent="text-muted" />
        </div>
      </div>

      <Section
        title="Anomalies"
        subtitle="Unusual right now — peer comparison & self-baseline"
        items={anomalies}
        empty="No anomalies — every pack is tracking its siblings and its own baseline."
      />
      <Section
        title="Forecasts"
        subtitle="Where it's heading — runtime, degradation & day-ahead projection"
        items={forecasts}
        empty="No forecasts flagged — no concerning trends projected."
      />

      <DegradationCard />

      <ForecastDetail />

      <AdvancedInsightsCard />
    </div>
  );
}

function Section({
  title,
  subtitle,
  items,
  empty,
}: {
  title: string;
  subtitle: string;
  items: Alert[];
  empty: string;
}) {
  return (
    <div className="card">
      <div className="card-title flex items-baseline gap-2">
        <span>{title}</span>
        <span className="text-muted normal-case tracking-normal">({items.length})</span>
        <span className="text-[11px] text-muted normal-case tracking-normal ml-auto hidden sm:inline">{subtitle}</span>
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-ok">
          <span className="h-2 w-2 rounded-full bg-ok inline-block" />
          {empty}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <InsightCard key={a.id} alert={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function InsightCard({ alert }: { alert: Alert }) {
  const meta = priorityMeta(priorityOf(alert));
  return (
    <div className={`flex items-stretch gap-3 bg-panel2/50 border ${meta.ring} rounded-lg p-3`}>
      <SubjectBoxes alert={alert} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold">{alert.title}</span>
          <span className={`badge ${meta.badge} text-[10px]`}>{meta.label}</span>
          <span className="badge badge-muted text-[10px]">{alert.category}</span>
          {alert.coreNum == null && <span className="text-[10px] text-muted">{alert.device}</span>}
        </div>
        <div className="text-xs text-muted mt-1 leading-relaxed">{alert.detail}</div>
        {alert.facts && alert.facts.length > 0 && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {alert.facts.map((f) => (
              <div key={f.label} className="bg-panel border border-line rounded-md px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-wider text-muted leading-none">{f.label}</div>
                <div className="text-sm font-mono font-semibold tabular-nums text-ink mt-1 leading-none">{f.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CountTile({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="bg-panel2/60 border border-line rounded-xl p-3 text-center">
      <div className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-muted mt-1">{label}</div>
    </div>
  );
}
