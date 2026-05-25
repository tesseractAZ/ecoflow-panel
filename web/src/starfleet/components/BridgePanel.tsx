/**
 * The standard TMP-era data panel — black recessed display with brass
 * trim, an amber title bar with status dot, and an optional departmental
 * stripe down the left edge.
 */

import type { ReactNode } from 'react';

export type Department = 'cmd' | 'eng' | 'sci' | 'ops' | 'tac' | 'med';

export interface BridgePanelProps {
  title: string;
  subtitle?: string;
  dept?: Department;
  /** Tag the panel as "WORKING" / processing — shows the blinking indicator. */
  working?: boolean;
  /** Extra header content right-justified, e.g. a small live indicator. */
  headerExtra?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function BridgePanel({
  title,
  subtitle,
  dept,
  working,
  headerExtra,
  className,
  children,
}: BridgePanelProps) {
  return (
    <div className={`sf-panel sf-grid-bg ${className ?? ''}`}>
      {dept && <span className={`sf-dept-stripe sf-dept-${dept}`} aria-hidden />}
      <div className="flex items-center gap-3 mb-3">
        <h2 className="sf-panel-title flex-shrink-0">{title}</h2>
        {subtitle && <span className="sf-panel-subtitle hidden sm:inline">{subtitle}</span>}
        <div className="ml-auto flex items-center gap-3">
          {working && <span className="sf-working">WORKING…</span>}
          {headerExtra}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
