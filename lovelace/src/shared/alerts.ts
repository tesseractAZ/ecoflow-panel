/**
 * Alerts are computed server-side (the single source of truth) and arrive in
 * snapshot.alerts. This module only re-exports the types and a small counts
 * helper for the UI.
 *
 * Ported verbatim from web/src/alerts.ts — pure data, no React.
 */
export type { Alert, Severity } from './types.js';
import type { Alert, Severity } from './types.js';

export function alertCounts(alerts: Alert[]): Record<Severity, number> {
  return {
    critical: alerts.filter((a) => a.severity === 'critical').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    info: alerts.filter((a) => a.severity === 'info').length,
  };
}

/**
 * v0.11.0 — ISA-18.2 / IEC 62682 alarm priority (presentation only).
 *
 * Mirrors server/src/alertPriority.ts and web/src/alertPriority.ts. The internal
 * `severity` ('critical'|'warning'|'info') + `source` ('threshold'|'learned')
 * are UNCHANGED; this derives a 4-tier display priority from them:
 *
 *   critical                 → Critical (P1)
 *   warning + threshold      → High     (P2)
 *   warning + learned        → Medium   (P3)
 *   info                     → Low      (P4)
 */
export type AlarmPriority = 'critical' | 'high' | 'medium' | 'low';

/** Canonical order, most-severe → least. */
export const ALARM_PRIORITY_ORDER: readonly AlarmPriority[] = ['critical', 'high', 'medium', 'low'] as const;

export interface AlarmPriorityMeta {
  id: AlarmPriority;
  /** Operator-facing label, e.g. "Critical". */
  label: string;
  /** ISA-18.2 / IEC 62682 designation, e.g. "P1". */
  isa: string;
  /** 0 = most severe … 3 = least. Lower sorts first. */
  rank: number;
}

export const ALARM_PRIORITY_META: Record<AlarmPriority, AlarmPriorityMeta> = {
  critical: { id: 'critical', label: 'Critical', isa: 'P1', rank: 0 },
  high: { id: 'high', label: 'High', isa: 'P2', rank: 1 },
  medium: { id: 'medium', label: 'Medium', isa: 'P3', rank: 2 },
  low: { id: 'low', label: 'Low', isa: 'P4', rank: 3 },
};

/** Derive the ISA priority for an alert from its severity + source. */
export function priorityOf(alert: Pick<Alert, 'severity' | 'source'>): AlarmPriority {
  if (alert.severity === 'critical') return 'critical';
  if (alert.severity === 'warning') return alert.source === 'learned' ? 'medium' : 'high';
  return 'low';
}

/** Tally a list of alerts into the four ISA priority buckets. */
export function priorityCounts(alerts: Alert[]): Record<AlarmPriority, number> {
  const out: Record<AlarmPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of alerts) out[priorityOf(a)]++;
  return out;
}

/** Sort comparator: most-severe first. */
export function comparePriority(a: AlarmPriority, b: AlarmPriority): number {
  return ALARM_PRIORITY_META[a].rank - ALARM_PRIORITY_META[b].rank;
}
