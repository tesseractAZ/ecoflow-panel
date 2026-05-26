import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { EcoflowCardBase } from '../shared/base-card.js';
import { themeCss } from '../shared/theme.css.js';
import type { ConnectionState } from '../shared/snapshot-store.js';
// Side-effect imports register the custom elements.
import '../shared/primitives/ef-badge.js';
import '../shared/primitives/ef-tile.js';
import '../shared/primitives/ef-section.js';

/**
 * PR2 fleet card: still a placeholder visually, but now wired end-to-end
 * through the real snapshot store and primitive elements. Proves the
 * shared plumbing works before PR3+ replaces this with the full fleet view.
 */
@customElement('ecoflow-fleet-card')
export class EcoflowFleetCard extends EcoflowCardBase {
  static styles = [
    themeCss,
    css`
      :host {
        display: block;
      }
      ha-card {
        padding: 12px;
      }
      .host {
        margin-top: 8px;
        font-size: 0.75rem;
        color: var(--ef-muted);
        word-break: break-all;
      }
    `,
  ];

  private connTone(state: ConnectionState): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
    switch (state) {
      case 'open':
        return 'ok';
      case 'connecting':
      case 'reconnecting':
        return 'warn';
      case 'closed':
        return 'bad';
      default:
        return 'neutral';
    }
  }

  private onlineCount(): number {
    if (!this.snapshot) return 0;
    return Object.values(this.snapshot.devices).filter((d) => d.online).length;
  }

  private deviceCount(): number {
    return this.snapshot ? Object.keys(this.snapshot.devices).length : 0;
  }

  private alertCount(): number {
    return this.snapshot?.alerts?.length ?? 0;
  }

  render() {
    const snap = this.snapshot;
    const tone = this.connTone(this.connState);
    const title = this.config?.title ?? 'EcoFlow Panel';
    return html`
      <ha-card>
        <ef-section .title=${title}>
          <ef-badge slot="header" tone=${tone}>${this.connState}</ef-badge>
          <ef-tile
            label="Devices"
            value=${snap ? this.deviceCount() : '—'}
          ></ef-tile>
          <ef-tile
            label="Online"
            value=${snap ? this.onlineCount() : '—'}
          ></ef-tile>
          <ef-tile
            label="Alerts"
            value=${snap ? this.alertCount() : '—'}
          ></ef-tile>
        </ef-section>
        <div class="host">Host: ${this.effectiveHost()}</div>
      </ha-card>
    `;
  }
}

// Register in HA's custom-cards catalog so it shows up in the card picker.
(window as unknown as { customCards?: unknown[] }).customCards =
  (window as unknown as { customCards?: unknown[] }).customCards || [];
(window as unknown as { customCards: unknown[] }).customCards.push({
  type: 'ecoflow-fleet-card',
  name: 'EcoFlow Fleet Card',
  description: 'Top-level dashboard for EcoFlow off-grid system',
});
