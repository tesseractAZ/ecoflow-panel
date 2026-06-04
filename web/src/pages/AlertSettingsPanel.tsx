/**
 * v0.11.0 — Alert Settings page.
 *
 * Operator surface for the ISA-18.2 / IEC 62682 alarm-PRIORITY taxonomy.
 * Lets the user turn annunciation on/off per priority (Critical/High/
 * Medium/Low), tune how many times the klaxon repeats before the spoken
 * announcement, and PREVIEW each priority's announcement either in the
 * browser or out on the speakers.
 *
 * ALARM-MANAGEMENT NOTE: turning a priority OFF only silences its
 * annunciation (push notification, chime, speaker broadcast). The alarm
 * itself STILL appears on the Alerts page — we never hide an active
 * alarm, we only mute how loudly it shouts. This mirrors the server's
 * annunciation gate (isPriorityEnabled).
 *
 * Talks to the cross-group contracts:
 *   GET  api/alert-settings  → { priorities[], chimeRepeat, updatedAt }
 *   PUT  api/alert-settings  → same shape
 *   POST api/alert-preview   → { ok, spokenText, audioPath?, played, ... }
 */

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../api';
import { ALARM_PRIORITY_ORDER, PRIORITY_META, type AlarmPriority } from '../alertPriority';

/** One row of the GET/PUT api/alert-settings response. */
interface PriorityRow {
  id: AlarmPriority;
  label: string;
  isa: string;
  rank: number;
  tag: string;
  colorToken: string;
  description: string;
  response: string;
  enabled: boolean;
}

interface AlertSettingsResponse {
  priorities: PriorityRow[];
  chimeRepeat: number;
  updatedAt: number;
}

type PreviewTarget = 'browser' | 'speakers';

interface PreviewResponse {
  ok: boolean;
  spokenText: string;
  audioPath?: string;
  played: 'browser' | 'speakers';
  error?: string;
  cooldownRemainingMs?: number;
}

/** Per-row transient UI state for the Preview control. */
interface PreviewState {
  busy: boolean;
  status?: string;
  spokenText?: string;
  error?: string;
}

export function AlertSettingsPanel() {
  const [settings, setSettings] = useState<AlertSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row's toggle is mid-flight (id) — disables that control.
  const [savingId, setSavingId] = useState<AlarmPriority | 'chime' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [target, setTarget] = useState<PreviewTarget>('browser');
  const [preview, setPreview] = useState<Partial<Record<AlarmPriority, PreviewState>>>({});
  // v0.11.0 — silencing Critical (P1) is high-consequence; gate it behind a confirm.
  const [confirmDisableCritical, setConfirmDisableCritical] = useState(false);

  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;
    const load = async () => {
      try {
        const r = await fetch(apiUrl('api/alert-settings'));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as AlertSettingsResponse;
        if (liveRef.current) {
          setSettings(j);
          setLoadError(null);
        }
      } catch (e: any) {
        if (liveRef.current) setLoadError(String(e?.message ?? e));
      }
    };
    load();
    return () => {
      liveRef.current = false;
    };
  }, []);

  /** PUT a patch, then replace local state from the response. */
  const put = async (
    patch: { priorityEnabled?: Partial<Record<AlarmPriority, boolean>>; chimeRepeat?: number },
    saving: AlarmPriority | 'chime',
  ) => {
    setSavingId(saving);
    setSaveError(null);
    try {
      const r = await fetch(apiUrl('api/alert-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as AlertSettingsResponse;
      if (liveRef.current) setSettings(j);
    } catch (e: any) {
      if (liveRef.current) setSaveError(String(e?.message ?? e));
    } finally {
      if (liveRef.current) setSavingId(null);
    }
  };

  const toggle = (row: PriorityRow) => {
    // Turning Critical OFF removes the push, chime, and broadcast for the
    // highest alarm tier — confirm before silencing it. Turning it back ON,
    // and toggling any other priority, applies immediately.
    if (row.id === 'critical' && row.enabled) {
      setConfirmDisableCritical(true);
      return;
    }
    put({ priorityEnabled: { [row.id]: !row.enabled } }, row.id);
  };
  const confirmCriticalOff = () => {
    setConfirmDisableCritical(false);
    put({ priorityEnabled: { critical: false } }, 'critical');
  };

  const setChime = (n: number) => {
    const clamped = Math.max(1, Math.min(4, Math.round(n)));
    if (settings && clamped === settings.chimeRepeat) return;
    put({ chimeRepeat: clamped }, 'chime');
  };

  const runPreview = async (row: PriorityRow) => {
    setPreview((p) => ({ ...p, [row.id]: { busy: true, status: 'Preparing…' } }));
    try {
      const r = await fetch(apiUrl('api/alert-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: row.id, target }),
      });
      const j = (await r.json()) as PreviewResponse;
      if (!liveRef.current) return;
      if (!j.ok) {
        const cd =
          typeof j.cooldownRemainingMs === 'number' && j.cooldownRemainingMs > 0
            ? ` (cooldown ${Math.ceil(j.cooldownRemainingMs / 1000)}s)`
            : '';
        setPreview((p) => ({
          ...p,
          [row.id]: { busy: false, error: (j.error ?? 'Preview failed') + cd, spokenText: j.spokenText },
        }));
        return;
      }
      if (target === 'browser' && j.audioPath) {
        const a = new Audio(apiUrl(j.audioPath));
        setPreview((p) => ({ ...p, [row.id]: { busy: false, status: 'Playing…', spokenText: j.spokenText } }));
        a.play().catch(() => {
          if (liveRef.current)
            setPreview((p) => ({
              ...p,
              [row.id]: { busy: false, error: 'Browser blocked autoplay — click again', spokenText: j.spokenText },
            }));
        });
      } else if (target === 'speakers') {
        setPreview((p) => ({
          ...p,
          [row.id]: { busy: false, status: 'Broadcasting to speakers…', spokenText: j.spokenText },
        }));
      } else {
        setPreview((p) => ({ ...p, [row.id]: { busy: false, status: 'Ready', spokenText: j.spokenText } }));
      }
    } catch (e: any) {
      if (liveRef.current)
        setPreview((p) => ({ ...p, [row.id]: { busy: false, error: String(e?.message ?? e) } }));
    }
  };

  if (loadError) {
    return (
      <div className="card">
        <div className="card-title">Alert settings</div>
        <div className="text-sm text-bad">Could not load alert settings: {loadError}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="card flex items-center gap-2 text-sm text-muted">
        <span className="h-2 w-2 rounded-full bg-accent inline-block animate-pulse" />
        Loading alert settings…
      </div>
    );
  }

  // Render priorities in the GET response order (critical..low). Guard against
  // an unexpected/short payload by falling back to the canonical order.
  const rows =
    settings.priorities.length > 0
      ? settings.priorities
      : ALARM_PRIORITY_ORDER.map((id) => ({
          id,
          label: PRIORITY_META[id].label,
          isa: PRIORITY_META[id].isa,
          rank: PRIORITY_META[id].rank,
          tag: PRIORITY_META[id].tag,
          colorToken: '',
          description: PRIORITY_META[id].description,
          response: PRIORITY_META[id].response,
          enabled: true,
        }));

  const criticalOff = rows.some((r) => r.id === 'critical' && !r.enabled);

  return (
    <div className="space-y-4">
      {/* Intro / alarm-management note */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>Alert settings</span>
          <span className="text-xs text-muted normal-case tracking-normal">ISA-18.2 / IEC 62682 priorities</span>
        </div>
        <div className="text-sm text-muted leading-relaxed">
          Each alarm is assigned one of four industrial priorities. Turning a priority{' '}
          <span className="text-ink font-medium">OFF</span> silences its annunciation — the push
          notification, the chime, and the speaker broadcast. The alarm itself{' '}
          <span className="text-ink font-medium">still appears on the Alerts page</span>; an active
          alarm is never hidden, it is only made quiet. This follows alarm-management best practice:
          you suppress the noise, not the signal.
        </div>
      </div>

      {/* v0.11.0 — persistent warning whenever Critical (P1) is silenced */}
      {criticalOff && (
        <div className="card border border-bad/55 bg-bad/10">
          <div className="flex items-start gap-2 text-sm">
            <span className="mt-1 h-2 w-2 rounded-full bg-bad inline-block shrink-0 animate-pulse" />
            <span>
              <span className="text-ink font-medium">Critical (P1) annunciation is silenced.</span>{' '}
              <span className="text-muted">
                Critical alarms still appear on the Alerts page but will not push, chime, or broadcast.
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Chime repeat + preview target controls */}
      <div className="card">
        <div className="card-title">Annunciation</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Chime repeats stepper */}
          <div className="bg-panel2/60 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted">Chime repeats (default 2)</div>
            <div className="text-xs text-muted mt-1 leading-relaxed">
              How many times the klaxon sounds before the spoken announcement on a new alarm.
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                type="button"
                onClick={() => setChime(settings.chimeRepeat - 1)}
                disabled={savingId === 'chime' || settings.chimeRepeat <= 1}
                className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-40 text-base leading-none px-3"
                aria-label="Decrease chime repeats"
              >
                −
              </button>
              <span className="text-2xl font-bold tabular-nums w-8 text-center">{settings.chimeRepeat}</span>
              <button
                type="button"
                onClick={() => setChime(settings.chimeRepeat + 1)}
                disabled={savingId === 'chime' || settings.chimeRepeat >= 4}
                className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-40 text-base leading-none px-3"
                aria-label="Increase chime repeats"
              >
                +
              </button>
              <span className="text-[11px] text-muted ml-1">min 1 · max 4</span>
            </div>
          </div>

          {/* Preview target chooser (shared by all rows) */}
          <div className="bg-panel2/60 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted">Preview target</div>
            <div className="text-xs text-muted mt-1 leading-relaxed">
              Where the per-priority Preview plays the announcement.
            </div>
            <div className="flex bg-panel border border-line rounded-lg overflow-hidden mt-2 w-max text-xs">
              <button
                type="button"
                onClick={() => setTarget('browser')}
                className={`px-3 py-1 transition-colors ${
                  target === 'browser' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'
                }`}
              >
                In browser
              </button>
              <button
                type="button"
                onClick={() => setTarget('speakers')}
                className={`px-3 py-1 transition-colors ${
                  target === 'speakers' ? 'bg-accent/20 text-accent' : 'text-muted hover:text-ink'
                }`}
              >
                On speakers
              </button>
            </div>
          </div>
        </div>
        {saveError && <div className="mt-3 text-xs text-bad">Could not save: {saveError}</div>}
      </div>

      {/* One card per priority, in critical..low order */}
      {rows.map((row) => {
        const meta = PRIORITY_META[row.id];
        const pv = preview[row.id];
        const toggling = savingId === row.id;
        return (
          <div key={row.id} className={`card border ${meta.ring}`}>
            <div className="flex items-start gap-3">
              {/* colour dot */}
              <span className={`mt-1.5 h-2.5 w-2.5 rounded-full inline-block shrink-0 ${meta.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold">{row.label}</span>
                  <span className={`badge ${meta.badge} text-[10px]`}>
                    {row.label} · {row.isa}
                  </span>
                  <span className="badge badge-muted text-[10px]">{row.response}</span>
                </div>
                <div className="text-xs text-muted mt-1 leading-relaxed">{row.description}</div>
              </div>

              {/* on/off toggle */}
              <button
                type="button"
                onClick={() => toggle(row)}
                disabled={toggling}
                role="switch"
                aria-checked={row.enabled}
                aria-label={`${row.label} annunciation ${row.enabled ? 'on' : 'off'}`}
                className={`badge shrink-0 self-start transition-colors disabled:opacity-50 ${
                  row.enabled ? 'badge-ok' : 'badge-muted'
                }`}
              >
                {toggling ? '…' : row.enabled ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* preview control + result */}
            <div className="mt-3 pt-3 border-t border-line flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => runPreview(row)}
                disabled={pv?.busy}
                className="badge badge-muted hover:bg-muted/20 transition-colors disabled:opacity-50"
              >
                {pv?.busy ? 'Preview…' : 'Preview ▶'}
              </button>
              <span className="text-[11px] text-muted">
                {target === 'browser' ? 'plays in this browser' : 'broadcasts to speakers'}
              </span>
              {pv?.status && <span className="text-xs text-accent">{pv.status}</span>}
              {pv?.error && <span className="text-xs text-bad">{pv.error}</span>}
            </div>
            {pv?.spokenText && (
              <div className="mt-1.5 text-xs text-muted leading-relaxed">
                Will announce: <span className="text-ink">“{pv.spokenText}”</span>
              </div>
            )}
          </div>
        );
      })}

      {/* v0.11.0 — confirm before silencing Critical (P1) annunciation */}
      {confirmDisableCritical && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm silencing Critical annunciation"
        >
          <div className="card max-w-md border border-bad/55">
            <div className="card-title text-bad normal-case tracking-normal text-sm">
              Silence Critical (P1) annunciation?
            </div>
            <div className="text-sm text-muted leading-relaxed mt-2">
              Critical alarms will <span className="text-ink font-medium">stay visible on the Alerts page</span>,
              but they will no longer send a push notification, sound the chime, or broadcast to the speakers.
              For an off-grid plant the push is often the only way you learn of a safety-critical alarm while away.
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setConfirmDisableCritical(false)}
                className="badge badge-muted hover:bg-muted/20 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmCriticalOff}
                className="badge badge-bad hover:bg-bad/25 transition-colors"
              >
                Silence Critical
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
