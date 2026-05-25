/**
 * v0.9.18 — Ship-wide audible broadcast to HomePod + Sonos.
 *
 * Listens to alert-condition transitions (any → red, green → yellow,
 * red/yellow → green) and pushes the appropriate Starfleet alert sound
 * to every configured speaker via Home Assistant's `media_player`
 * service. Optionally appends a TTS-generated situational announcement.
 *
 * Configuration is env-driven (set from the HA add-on Configuration tab):
 *
 *   BROADCAST_ENABLED       true / false (default false — opt-in)
 *   BROADCAST_TARGETS       comma-separated media_player entity IDs
 *                           e.g. "media_player.living_room, media_player.kitchen"
 *   BROADCAST_AUDIO_BASE    URL prefix for the WAV files; defaults to
 *                           "http://homeassistant.local:8787" — the
 *                           speaker must be able to reach this URL on
 *                           the LAN. Set to your HA Pi's IP if mDNS
 *                           resolution is flaky.
 *   BROADCAST_VOLUME        0..1 (default 0.5). Applied via
 *                           media_player.volume_set before play_media.
 *   BROADCAST_MIN_SEVERITY  "critical" | "warning" — alarm level below
 *                           this never broadcasts. Default "critical".
 *   BROADCAST_QUIET_HOURS   "22-06" (or empty). Non-critical alarms
 *                           are suppressed during this window. Critical
 *                           always fires.
 *   BROADCAST_TTS_SERVICE   e.g. "tts.google_translate_say" or
 *                           "tts.cloud_say" or "tts.piper". Empty
 *                           disables verbal announcements (klaxon only).
 *   BROADCAST_TTS_LANGUAGE  e.g. "en-US" for Google. Engine-specific.
 *   BROADCAST_SONOS_RESTORE true / false — wrap each Sonos broadcast in
 *                           sonos.snapshot + sonos.restore so we don't
 *                           leave music paused. Default true.
 *
 * Broadcast policy (deliberate — see the "every detail matters" note
 * from the user):
 *
 *   - Fires on CONDITION TRANSITIONS, not per-tick. Going 3 crit → 2
 *     crit (one cleared, still RED) is silent. A NEW critical alert
 *     while already RED re-fires the klaxon (shorter form).
 *   - First-render is silent. Joining an already-RED state at boot
 *     doesn't klaxon the house.
 *   - Min severity gates the broadcast. With default "critical", only
 *     red alerts fire. Set to "warning" to also broadcast yellow.
 *   - Quiet hours only affect warning / info broadcasts. Critical
 *     always fires regardless of time of day (the whole point of
 *     critical: someone needs to know).
 *   - Test broadcast (`POST /api/broadcast/test`) bypasses all gates.
 */

import type { SnapshotStore } from './snapshot.js';
import type { Alert } from './alerts.js';
import { callHaService, isSupervised, hasService } from './haService.js';
import { parseQuietHours, inQuietWindow } from './alertMonitor.js';

export type BroadcastBackend = 'auto' | 'music_assistant' | 'media_player';

export interface BroadcastConfig {
  enabled: boolean;
  targets: string[];
  audioBase: string;
  volume: number;
  minSeverity: 'critical' | 'warning';
  quietHours: [number, number] | null;
  ttsService: string | null;        // e.g. "tts.google_translate_say"
  ttsLanguage: string | null;
  sonosRestore: boolean;
  /** v0.9.23 — which HA service path to use. 'auto' picks MA if installed. */
  backend: BroadcastBackend;
}

export function loadBroadcastConfig(): BroadcastConfig {
  const targetsRaw = process.env.BROADCAST_TARGETS ?? '';
  const targets = targetsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('media_player.'));
  const backendRaw = (process.env.BROADCAST_USE_MUSIC_ASSISTANT ?? 'auto').toLowerCase();
  const backend: BroadcastBackend =
    backendRaw === 'true' || backendRaw === 'music_assistant' ? 'music_assistant' :
    backendRaw === 'false' || backendRaw === 'media_player' ? 'media_player' :
    'auto';
  return {
    enabled: process.env.BROADCAST_ENABLED === 'true' || process.env.BROADCAST_ENABLED === '1',
    targets,
    audioBase: (process.env.BROADCAST_AUDIO_BASE || 'http://homeassistant.local:8787').replace(/\/$/, ''),
    volume: clamp01(Number(process.env.BROADCAST_VOLUME ?? 0.5)),
    minSeverity: (process.env.BROADCAST_MIN_SEVERITY ?? 'critical') === 'warning' ? 'warning' : 'critical',
    quietHours: parseQuietHours(process.env.BROADCAST_QUIET_HOURS ?? ''),
    ttsService: emptyToNull(process.env.BROADCAST_TTS_SERVICE),
    ttsLanguage: emptyToNull(process.env.BROADCAST_TTS_LANGUAGE),
    sonosRestore: process.env.BROADCAST_SONOS_RESTORE !== 'false',
    backend,
  };
}

function emptyToNull(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/* ─── condition derivation ────────────────────────────────────────── */

export type ConditionLevel = 'green' | 'yellow' | 'red';

export function conditionFromAlerts(alerts: Alert[]): { level: ConditionLevel; crit: number; warn: number } {
  const crit = alerts.filter((a) => a.severity === 'critical').length;
  const warn = alerts.filter((a) => a.severity === 'warning').length;
  const level: ConditionLevel = crit > 0 ? 'red' : warn > 0 ? 'yellow' : 'green';
  return { level, crit, warn };
}

/* ─── monitor ─────────────────────────────────────────────────────── */

export interface BroadcastMonitor {
  /** Force a test broadcast (bypasses every gate except the cooldown). */
  test: (level?: ConditionLevel) => Promise<{ ok: boolean; messages: string[]; cooldownRemainingMs?: number }>;
  /** Current config snapshot. */
  config: () => BroadcastConfig;
  /** Last-broadcast status for the diagnostic endpoint. */
  status: () => BroadcastStatus;
  /** Stop polling on shutdown. */
  stop: () => void;
}

export interface BroadcastStatus {
  supervised: boolean;
  enabled: boolean;
  targetCount: number;
  lastBroadcastAt: number | null;
  lastLevel: ConditionLevel | null;
  lastOutcome: 'success' | 'partial' | 'failure' | null;
  lastErrors: string[];
  /** v0.9.23 — which backend was used on the last broadcast. */
  lastBackend: 'music_assistant' | 'media_player' | null;
  /** v0.9.23 — does HA expose Music Assistant's announce service? */
  musicAssistantAvailable: boolean;
  /** v0.9.23 — ms until the test endpoint will accept another call. 0 = ready. */
  testCooldownRemainingMs: number;
}

/** v0.9.23 — cooldown on the test endpoint. Rapid retests during
 *  v0.9.18-19 debugging cascaded into 502s because each fresh test
 *  collided with the in-flight Music Assistant stream. 10 s is plenty
 *  for any single broadcast (klaxon + transition) to settle. */
const TEST_COOLDOWN_MS = 10_000;

export function startBroadcastMonitor(
  store: SnapshotStore,
  log: (m: string) => void,
): BroadcastMonitor {
  let cfg = loadBroadcastConfig();
  let prevLevel: ConditionLevel | null = null;
  let prevCrit = 0;
  let firstTick = true;
  let stopped = false;
  let lastBroadcastAt: number | null = null;
  let lastLevel: ConditionLevel | null = null;
  let lastOutcome: BroadcastStatus['lastOutcome'] = null;
  let lastErrors: string[] = [];
  let lastBackend: BroadcastStatus['lastBackend'] = null;
  let lastTestAt = 0;
  let musicAssistantAvailable = false;

  const supervised = isSupervised();
  if (!supervised) {
    log('broadcast: SUPERVISOR_TOKEN not set; running outside HA, broadcasts disabled');
  } else if (!cfg.enabled) {
    log('broadcast: disabled (set BROADCAST_ENABLED=true to opt in)');
  } else if (cfg.targets.length === 0) {
    log('broadcast: no targets configured (set BROADCAST_TARGETS to comma-separated media_player entity IDs)');
  } else {
    log(`broadcast: enabled, ${cfg.targets.length} target(s): ${cfg.targets.join(', ')}`);
  }

  /** v0.9.23 — Music Assistant detection. We check the service catalog
   *  on startup (and again after each config-reload tick that flips backend
   *  to auto). MA's purpose-built announce service is a much better fit
   *  than media_player.play_media for our broadcast use case:
   *
   *    - plays simultaneously across all targets (not serial per speaker)
   *    - returns immediately (doesn't block on per-speaker acks)
   *    - handles volume override + restore atomically
   *    - bypasses the MA play queue (won't interrupt music sessions)
   *
   *  If the user explicitly sets BROADCAST_USE_MUSIC_ASSISTANT=false we
   *  skip detection. If they force =true and MA isn't installed, we still
   *  fall back at runBroadcast() time with a clear error message. */
  const detectMusicAssistant = async () => {
    if (!supervised || cfg.backend === 'media_player') {
      musicAssistantAvailable = false;
      return;
    }
    musicAssistantAvailable = await hasService('music_assistant', 'play_announcement');
    if (musicAssistantAvailable) {
      log('broadcast: music_assistant.play_announcement detected — preferring it over media_player.play_media');
    } else if (cfg.backend === 'music_assistant') {
      log('broadcast: BROADCAST_USE_MUSIC_ASSISTANT=true but music_assistant.play_announcement not available; calls will fail');
    } else {
      log('broadcast: music_assistant not detected, using media_player.play_media');
    }
  };
  void detectMusicAssistant();

  const inQuiet = (): boolean => {
    if (!cfg.quietHours) return false;
    return inQuietWindow(new Date(), cfg.quietHours);
  };

  /**
   * Decide which HA backend to use for this broadcast.
   *
   *   - explicit 'music_assistant' → use MA even if detection failed
   *     (user will see the failure if it really isn't installed)
   *   - explicit 'media_player' → never use MA
   *   - 'auto' → use MA if detected, else media_player
   */
  const pickBackend = (): 'music_assistant' | 'media_player' => {
    if (cfg.backend === 'music_assistant') return 'music_assistant';
    if (cfg.backend === 'media_player') return 'media_player';
    return musicAssistantAvailable ? 'music_assistant' : 'media_player';
  };

  /**
   * Run one broadcast via Music Assistant's purpose-built announce service.
   * This is the preferred path: simultaneous across all targets, returns
   * immediately, handles volume override + restore atomically.
   *
   * MA expects announce_volume as 0-100 percent integer, not 0-1 float —
   * convert before sending. The TTS is appended as a SECOND announcement
   * because play_announcement plays one URL per call.
   */
  const runBroadcastMA = async (level: ConditionLevel, message: string | null): Promise<{ ok: boolean; errors: string[] }> => {
    const errors: string[] = [];
    const wav = `${cfg.audioBase}/audio/${level === 'red' ? 'red-alert' : level === 'yellow' ? 'yellow-alert' : 'all-clear'}.wav`;
    const announceVolume = Math.round(cfg.volume * 100);

    // 1. Main klaxon. use_pre_announce=false because the WAV itself is the alert tone.
    const r = await callHaService('music_assistant', 'play_announcement', {
      entity_id: cfg.targets,
      url: wav,
      use_pre_announce: false,
      announce_volume: announceVolume,
    });
    if (!r.ok) errors.push(`music_assistant.play_announcement: ${r.error ?? r.status}`);

    // 2. Optional TTS announcement, queued as a second announcement that
    //    fires after the klaxon clears. MA handles the gap timing internally.
    if (cfg.ttsService && message && r.ok) {
      // Brief gap so MA finishes the klaxon-announce volume-restore cycle
      // before we hit it again with another announce. (MA queues but
      // overlapping announces can clip the start.)
      await sleep(level === 'red' ? 3500 : 1500);
      // For TTS via MA we go through the configured TTS service, which is
      // its own world (some integrations support announce, others don't).
      // Simpler: render TTS via the underlying tts service directly to the
      // MA-registered players; MA passes through.
      const [domain, service] = cfg.ttsService.split('.');
      const data: Record<string, unknown> = {
        entity_id: cfg.targets,
        message,
      };
      if (cfg.ttsLanguage) data.language = cfg.ttsLanguage;
      const tRes = await callHaService(domain, service, data);
      if (!tRes.ok) errors.push(`tts: ${tRes.error ?? tRes.status}`);
    }

    return { ok: errors.length === 0, errors };
  };

  /**
   * Run one broadcast via the original media_player.play_media path.
   * Used when Music Assistant isn't available or the user has forced
   * BROADCAST_USE_MUSIC_ASSISTANT=false. Same behavior as v0.9.18-22.
   */
  const runBroadcastMP = async (level: ConditionLevel, message: string | null): Promise<{ ok: boolean; errors: string[] }> => {
    const errors: string[] = [];
    const wav = `${cfg.audioBase}/audio/${level === 'red' ? 'red-alert' : level === 'yellow' ? 'yellow-alert' : 'all-clear'}.wav`;
    const boatswain = `${cfg.audioBase}/audio/boatswain.wav`;

    const sonosTargets = cfg.targets.filter((t) => t.includes('sonos') || /\bsonos\b/i.test(t));
    if (cfg.sonosRestore && sonosTargets.length > 0) {
      const r = await callHaService('sonos', 'snapshot', { entity_id: sonosTargets, with_group: true });
      if (!r.ok) errors.push(`sonos.snapshot: ${r.error ?? r.status}`);
    }

    const volRes = await callHaService('media_player', 'volume_set', {
      entity_id: cfg.targets,
      volume_level: cfg.volume,
    });
    if (!volRes.ok) errors.push(`volume_set: ${volRes.error ?? volRes.status}`);

    if (cfg.ttsService && message) {
      const bRes = await callHaService('media_player', 'play_media', {
        entity_id: cfg.targets,
        media_content_id: boatswain,
        media_content_type: 'music',
        announce: true,
      });
      if (!bRes.ok) errors.push(`boatswain: ${bRes.error ?? bRes.status}`);
      await sleep(1500);
    }

    const kRes = await callHaService('media_player', 'play_media', {
      entity_id: cfg.targets,
      media_content_id: wav,
      media_content_type: 'music',
      announce: true,
    });
    if (!kRes.ok) errors.push(`play_media: ${kRes.error ?? kRes.status}`);

    if (cfg.ttsService && message) {
      await sleep(level === 'red' ? 3500 : 1500);
      const [domain, service] = cfg.ttsService.split('.');
      const data: Record<string, unknown> = {
        entity_id: cfg.targets,
        message,
      };
      if (cfg.ttsLanguage) data.language = cfg.ttsLanguage;
      const tRes = await callHaService(domain, service, data);
      if (!tRes.ok) errors.push(`tts: ${tRes.error ?? tRes.status}`);
    }

    if (cfg.sonosRestore && sonosTargets.length > 0) {
      const settleMs = (cfg.ttsService && message ? 8000 : (level === 'red' ? 3500 : 1500));
      await sleep(settleMs);
      const r = await callHaService('sonos', 'restore', { entity_id: sonosTargets, with_group: true });
      if (!r.ok) errors.push(`sonos.restore: ${r.error ?? r.status}`);
    }

    return { ok: errors.length === 0, errors };
  };

  /** Dispatcher — picks the right backend and runs it. */
  const runBroadcast = async (level: ConditionLevel, message: string | null): Promise<{ ok: boolean; errors: string[]; backend: 'music_assistant' | 'media_player' }> => {
    if (!supervised) {
      return { ok: false, errors: ['not supervised'], backend: 'media_player' };
    }
    if (cfg.targets.length === 0) {
      return { ok: false, errors: ['no targets configured'], backend: 'media_player' };
    }
    const backend = pickBackend();
    const t0 = Date.now();
    const r = backend === 'music_assistant'
      ? await runBroadcastMA(level, message)
      : await runBroadcastMP(level, message);
    const dt = Date.now() - t0;
    if (r.ok) {
      log(`broadcast: ${level} via ${backend} → ok in ${dt}ms (${cfg.targets.length} target(s))`);
    } else {
      log(`broadcast: ${level} via ${backend} → errors in ${dt}ms: ${r.errors.join('; ')}`);
    }
    return { ...r, backend };
  };

  /**
   * Build a short situational TTS message for the given condition.
   */
  const messageFor = (level: ConditionLevel, alerts: Alert[]): string | null => {
    if (!cfg.ttsService) return null;
    if (level === 'red') {
      const crit = alerts.find((a) => a.severity === 'critical');
      const what = crit ? `, ${crit.title}` : '';
      return `Red alert. Red alert. Critical condition${what}.`;
    }
    if (level === 'yellow') {
      const warn = alerts.find((a) => a.severity === 'warning');
      const what = warn ? `, ${warn.title}` : '';
      return `Yellow alert. Caution${what}.`;
    }
    return 'All clear. All stations report normal.';
  };

  /* ── tick ─── periodic check for condition transitions */
  const tick = async () => {
    if (stopped) return;
    cfg = loadBroadcastConfig(); // re-read each tick so config changes apply without restart
    const alerts = (store.get().alerts ?? []) as Alert[];
    const { level, crit } = conditionFromAlerts(alerts);
    if (firstTick) {
      firstTick = false;
      prevLevel = level;
      prevCrit = crit;
      return;
    }
    const transitioned = level !== prevLevel;
    const newCrit = level === 'red' && crit > prevCrit;
    if (!transitioned && !newCrit) {
      return;
    }
    // Severity gate.
    if (!cfg.enabled) { prevLevel = level; prevCrit = crit; return; }
    if (level === 'yellow' && cfg.minSeverity === 'critical') { prevLevel = level; prevCrit = crit; return; }
    // Quiet-hours gate — critical always fires.
    if (level !== 'red' && inQuiet()) {
      log(`broadcast: ${level} suppressed by quiet hours`);
      prevLevel = level; prevCrit = crit; return;
    }
    log(`broadcast: condition ${prevLevel} → ${level}${newCrit ? ' (new crit)' : ''}, ${cfg.targets.length} target(s)`);
    const message = messageFor(level, alerts);
    const result = await runBroadcast(level, message);
    lastBroadcastAt = Date.now();
    lastLevel = level;
    lastOutcome = result.ok ? 'success' : 'partial';
    lastErrors = result.errors;
    lastBackend = result.backend;
    prevLevel = level;
    prevCrit = crit;
  };

  const tickInterval = setInterval(() => { tick().catch((e) => log(`broadcast: tick failed: ${e?.message ?? e}`)); }, 10_000);
  tickInterval.unref();

  return {
    test: async (level: ConditionLevel = 'red') => {
      cfg = loadBroadcastConfig();
      // v0.9.23 — cooldown gate. Prevents the "rapid clicks → cascading 502s"
      // pattern observed in the v0.9.22 log (4 broadcasts in 30s overwhelmed
      // Music Assistant's queue).
      const remaining = Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now());
      if (remaining > 0) {
        return {
          ok: false,
          messages: [`cooldown: wait ${Math.ceil(remaining / 1000)}s before testing again`],
          cooldownRemainingMs: remaining,
        };
      }
      lastTestAt = Date.now();
      // Re-detect MA on every test in case the user installed it between
      // checks. Cheap — single HA service-catalog GET.
      await detectMusicAssistant();
      const message =
        level === 'red' ? 'Test broadcast. Red alert klaxon. This is only a test.' :
        level === 'yellow' ? 'Test broadcast. Yellow alert chime. This is only a test.' :
        'Test broadcast. All clear chime. This is only a test.';
      const r = await runBroadcast(level, cfg.ttsService ? message : null);
      lastBroadcastAt = Date.now();
      lastLevel = level;
      lastOutcome = r.ok ? 'success' : 'partial';
      lastErrors = r.errors;
      lastBackend = r.backend;
      return {
        ok: r.ok,
        messages: r.errors,
        cooldownRemainingMs: TEST_COOLDOWN_MS,
      };
    },
    config: () => cfg,
    status: () => ({
      supervised,
      enabled: cfg.enabled,
      targetCount: cfg.targets.length,
      lastBroadcastAt,
      lastLevel,
      lastOutcome,
      lastErrors,
      lastBackend,
      musicAssistantAvailable,
      testCooldownRemainingMs: Math.max(0, lastTestAt + TEST_COOLDOWN_MS - Date.now()),
    }),
    stop: () => {
      stopped = true;
      clearInterval(tickInterval);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
