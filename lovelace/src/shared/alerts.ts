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
