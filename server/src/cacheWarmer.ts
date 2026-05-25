import type { SnapshotStore } from './snapshot.js';
import type { Recorder } from './recorder.js';
import {
  getDayForecast,
  computeDegradation,
  computeRunway,
  computeRoundTripEfficiency,
  computeClipping,
  computeSelfConsumption,
  computeCarbonReport,
  computeTariffReport,
  computeForecastSkill,
  computeBayesianSolarModel,
  computeProbabilisticForecast,
  computeMultiDayForecast,
  computeAmbientThermalForecast,
  computeThermalEvents,
  computeEquipmentHealth,
  computeShadeReport,
  computeSoilingDecomposition,
  computeStringMismatch,
  computeEvWindowPrediction,
  computeChargeCurveFingerprint,
  computeInternalResistance,
  resetHaStateShortLivedCaches,
} from './analytics.js';
import { computeRepairIssues } from './repairIssues.js';
import { computeTotals, startOfLocalDayMs } from './aggregator.js';

/**
 * v0.9.5 — Cache pre-warmer.
 *
 * The /api/ha-state endpoint chains 8+ heavy computations (carbon, tariff,
 * self-consumption, clipping, getDayForecast, degradation, runway, RTE,
 * Bayesian, multi-day, ambient-thermal, forecast skill). Each function
 * has its own TTL cache, but several use a 5-minute TTL — when they
 * expire roughly together, the next /api/ha-state caller pays ~1.8s to
 * rebuild them all on its critical path.
 *
 * Pre-warmer fix: call all of them in the background every WARM_INTERVAL_MS
 * (4 min, just inside the 5-min TTL window). When a real request arrives,
 * every cache is warm and the response is <5ms.
 *
 * v0.9.11 — log analysis showed the spikes were still happening every
 * ~5 min in production. Root cause: each `compute*` function's cache
 * check returns the cached value WITHOUT updating its timestamp when
 * the cache is still warm, so the 4-min warmer never actually refreshes
 * a 5-min cache — it just reads it. The cache then expires 5 min after
 * the original cold compute, leaving a 1-3 min cold window every cycle.
 * Fix: call resetHaStateShortLivedCaches() at the start of each warm
 * cycle, forcing the subsequent computes to do real work + restamp `ts`.
 *
 * Errors in one function don't stop the rest — each is wrapped so a
 * transient weather-API failure doesn't block carbon/tariff warming.
 */

const WARM_INTERVAL_MS = 4 * 60 * 1000;

export interface CacheWarmerHandle {
  stop: () => void;
  /** Trigger an immediate warm cycle (used for testing). */
  warmNow: () => Promise<void>;
  /** Per-task wall time (ms) of the most recent successful run. */
  lastTimings: () => Record<string, number>;
}

export function startCacheWarmer(
  store: SnapshotStore,
  recorder: Recorder,
  log: (m: string) => void,
): CacheWarmerHandle {
  let stopped = false;
  let inFlight = false;
  const timings: Record<string, number> = {};

  /** Run one task, catch + log errors, record wall time on success. */
  const safe = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = Date.now();
    try {
      await fn();
      timings[name] = Date.now() - t0;
    } catch (e: any) {
      log(`cache-warmer: ${name} failed: ${e?.message ?? e}`);
    }
  };

  const warmNow = async () => {
    if (inFlight) return;        // a slow cycle shouldn't pile up if the interval fires early
    if (stopped) return;
    inFlight = true;
    const t0 = Date.now();
    const devices = store.get().devices;
    // Bail quietly when the snapshot store is empty — happens during the
    // first ~30s after boot, before the REST refresh has populated devices.
    if (Object.keys(devices).length === 0) {
      inFlight = false;
      return;
    }
    try {
      // v0.9.11 — clear the short-TTL caches so the subsequent computes
      // actually do the work instead of returning still-warm values
      // without restamping `ts`. See the file-level note for the bug.
      resetHaStateShortLivedCaches();
      // Two-pass strategy: forecast/degradation/RTE/clipping first because
      // several downstream functions consume them; then everything else.
      const fc = await getDayForecast(devices, recorder, () => {});
      await safe('degradation', () => computeDegradation(devices, recorder));
      await safe('runway', () => computeRunway(devices, recorder, fc));
      await safe('round-trip-efficiency', () => computeRoundTripEfficiency(devices, recorder));
      await safe('clipping', () => computeClipping(devices, recorder, fc));
      await safe('self-consumption', () => computeSelfConsumption(devices, recorder));
      await safe('carbon', () => computeCarbonReport(devices, recorder));
      await safe('tariff', () => computeTariffReport(devices, recorder));
      await safe('multi-day', () => computeMultiDayForecast(devices, recorder, fc));
      await safe('bayesian-solar', () => computeBayesianSolarModel(devices, recorder));
      // forecast-skill is async + depends on getDayForecast result
      const skill = await computeForecastSkill(devices, recorder, fc);
      await safe('probabilistic-forecast', () => computeProbabilisticForecast(fc, skill));
      await safe('ambient-thermal', () => computeAmbientThermalForecast(devices, recorder));
      // v0.9.14 — extended coverage: every "predictive insights"-tab endpoint
      // benefits from being pre-warm so its first fetch from a fresh page-load
      // hits <5 ms instead of recomputing. None of these are slow on their
      // own, but pre-warming amortizes them across all viewers.
      await safe('thermal-events', () => computeThermalEvents(devices, recorder));
      await safe('equipment-health', () => computeEquipmentHealth(devices, recorder));
      await safe('shade-report', () => computeShadeReport(devices, recorder));
      await safe('soiling-decomposition', () => computeSoilingDecomposition(devices, recorder));
      await safe('string-mismatch', () => computeStringMismatch(devices, recorder));
      await safe('ev-window-prediction', () => computeEvWindowPrediction(devices, recorder));
      await safe('charge-curve', () => computeChargeCurveFingerprint(devices, recorder));
      await safe('internal-resistance', () => computeInternalResistance(devices, recorder));
      // computeRepairIssues takes a pre-assembled context: it merges already-
      // warmed signals (degradation, soiling, equipment-health, forecast-skill)
      // into a unified "things to fix" list. Re-using the warmed caches here
      // keeps the build cheap.
      await safe('repair-issues', async () => {
        const snap = store.get();
        return computeRepairIssues({
          devices: snap.devices,
          alerts: snap.alerts ?? [],
          degradation: computeDegradation(devices, recorder),
          soiling: await computeSoilingDecomposition(devices, recorder),
          equipmentHealth: computeEquipmentHealth(devices, recorder),
          forecastSkill: skill,
        });
      });
      await safe('summary-today', () => computeTotals(store, recorder, startOfLocalDayMs(), Date.now()));
      const totalMs = Date.now() - t0;
      // Log only when cycle is unusually slow (>3s) — otherwise this would
      // flood the log every 4 min with healthy timings. With v0.9.14's
      // SQL-side bucketing the typical cycle drops well below 1s.
      if (totalMs > 3000) {
        const top = Object.entries(timings).sort((a, b) => b[1] - a[1]).slice(0, 3);
        log(`cache-warmer: slow cycle (${totalMs}ms) — top: ${top.map(([k, v]) => `${k} ${v}ms`).join(', ')}`);
      }
    } finally {
      inFlight = false;
    }
  };

  // Kick off first cycle ~10s after boot so the snapshot has populated.
  setTimeout(() => warmNow(), 10_000).unref();
  const timer = setInterval(() => warmNow(), WARM_INTERVAL_MS);
  timer.unref();

  log(`cache-warmer: started (interval ${WARM_INTERVAL_MS / 1000}s)`);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    warmNow,
    lastTimings: () => ({ ...timings }),
  };
}
