/**
 * v0.40.2 — circuitLifetimeFields: the per-circuit lifetime-kWh state fields must be
 * enumerated from the SAME circuit list the MQTT discovery configs use, so every
 * discovered `ecoflow_circuit_<ch>_lifetime_kwh` sensor always finds its key in the
 * state payload. Otherwise HA logs "'dict object' has no attribute circuit_N_lifetime_kwh"
 * template warnings whenever a live circuit's accumulator key isn't present yet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circuitLifetimeFields } from '../src/mqttDiscovery.js';

const circuits = [{ ch: 1 }, { ch: 2 }, { ch: 10 }, { ch: 12 }];

test('emits a key for EVERY live circuit (discovery ⟷ state channel sets match)', () => {
  // Accumulator only has data for ch 1 + ch 10; ch 2 + ch 12 are not ready yet.
  const lifetimeKwh = (k: string) => (k === 'circuit_1_wh' ? 12.5 : k === 'circuit_10_wh' ? 3.0 : null);
  const fields = circuitLifetimeFields(circuits, lifetimeKwh);

  const emittedChannels = Object.keys(fields)
    .map((k) => Number(k.match(/^circuit_(\d+)_lifetime_kwh$/)?.[1]))
    .sort((a, b) => a - b);
  assert.deepEqual(emittedChannels, [1, 2, 10, 12], 'one key per live circuit — even ones with no accumulator yet');
});

test('uses null (NOT 0) when a circuit has no accumulator — avoids a false total_increasing reset', () => {
  const lifetimeKwh = (_k: string) => null; // nothing accumulated yet (cold start)
  const fields = circuitLifetimeFields(circuits, lifetimeKwh);
  for (const c of circuits) {
    assert.equal(fields[`circuit_${c.ch}_lifetime_kwh`], null, `ch ${c.ch} must be null, not 0`);
  }
});

test('passes through the accumulated kWh when present', () => {
  const lifetimeKwh = (k: string) => (k === 'circuit_10_wh' ? 42.7 : null);
  const fields = circuitLifetimeFields(circuits, lifetimeKwh);
  assert.equal(fields['circuit_10_lifetime_kwh'], 42.7);
  assert.equal(fields['circuit_1_lifetime_kwh'], null);
});

test('no SHP2 / no circuits → empty (no orphan keys)', () => {
  assert.deepEqual(circuitLifetimeFields([], () => null), {});
});

test('reads the correct accumulator key (circuit_<ch>_wh ← circuit_<ch>_lifetime_kwh)', () => {
  const seen: string[] = [];
  circuitLifetimeFields([{ ch: 7 }], (k) => { seen.push(k); return null; });
  assert.deepEqual(seen, ['circuit_7_wh'], 'lifetime field circuit_7_lifetime_kwh sources accumulator circuit_7_wh');
});
