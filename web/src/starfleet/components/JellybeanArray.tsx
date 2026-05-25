/**
 * Jellybean indicator strip / grid.
 *
 * The iconic backlit-button cluster on the TMP bridge. Each pip has its
 * own colour + a small text caption. Used for dotmatrix-style status
 * displays (fleet online state, per-circuit state, per-pack ok/fault).
 */

import type { JellybeanColor } from '../utils';
import { jellybeanHex } from '../utils';

export interface JellybeanCell {
  color: JellybeanColor;
  label?: string;
  /** Tooltip on hover (native title attr). */
  title?: string;
  /** Subtle pulse animation — used for in-progress / active states. */
  pulse?: boolean;
}

export function JellybeanArray({ cells, columns, size = 'sm' }: { cells: JellybeanCell[]; columns?: number; size?: 'sm' | 'lg' }) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${columns ?? cells.length}, minmax(0, 1fr))`,
        gap: size === 'lg' ? '12px' : '6px',
      }}
    >
      {cells.map((cell, i) => (
        <div key={i} className="flex flex-col items-center gap-1" title={cell.title}>
          <span
            className={`sf-jellybean${size === 'lg' ? ' sf-jellybean--lg' : ''}`}
            style={{
              ['--jb-color' as any]: jellybeanHex(cell.color),
              animation: cell.pulse ? 'sf-alert-pulse 1.4s ease-in-out infinite' : undefined,
            }}
            aria-hidden
          />
          {cell.label && <span className="sf-label" style={{ fontSize: '8px' }}>{cell.label}</span>}
        </div>
      ))}
    </div>
  );
}
