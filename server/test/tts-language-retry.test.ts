import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleLocaleSeparator, ttsGetUrl, type TtsRequestFn } from '../src/haService.js';

/**
 * v0.9.63 — Language-format fallback for HA's `/api/tts_get_url`.
 *
 * Empirically verified bug: HA returns 500 when the language string
 * doesn't match the wired-up TTS engine's format expectation. Wyoming
 * engines (Piper) want POSIX (`en_US`); HA Cloud wants BCP47 (`en-US`).
 * `ttsGetUrl` now retries up to twice on 500: toggled separator first,
 * then dropping the language parameter entirely.
 *
 * These tests stub the injected `requestFn` so we exercise the retry
 * chain without standing up a fake HA. They lock in:
 *   - first attempt succeeds → no extra calls, returned URL
 *   - first 500 + toggled 200 → returns toggled URL, logs the hint
 *   - first 500 + toggled 500 + drop 200 → returns
 *   - all three 500 → returns error containing all three attempt strings
 *   - non-500 on first attempt → fails fast, no retry
 *   - no language given → only one attempt (nothing to toggle)
 *   - helper toggles `-` ↔ `_`, leaves others alone
 */

const PREV_TOKEN = process.env.SUPERVISOR_TOKEN;
process.env.SUPERVISOR_TOKEN = 'test-token-for-tts-retry';

interface StubCall {
  url: string;
  body: Record<string, unknown>;
}

interface StubResponse {
  statusCode: number;
  bodyText: string;
}

function makeStub(responses: StubResponse[]): { fn: TtsRequestFn; calls: StubCall[] } {
  const calls: StubCall[] = [];
  let i = 0;
  const fn: TtsRequestFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = responses[i++];
    if (!r) throw new Error(`stub exhausted at call #${calls.length}`);
    return {
      statusCode: r.statusCode,
      body: { text: async () => r.bodyText },
    };
  };
  return { fn, calls };
}

function okBody(path = '/api/tts_proxy/abc.mp3'): string {
  return JSON.stringify({ url: path, path });
}

function errBody(message: string): string {
  return JSON.stringify({ message });
}

test('toggleLocaleSeparator — `en-US` ↔ `en_US`', () => {
  assert.equal(toggleLocaleSeparator('en-US'), 'en_US');
  assert.equal(toggleLocaleSeparator('en_US'), 'en-US');
});

test('toggleLocaleSeparator — `fr-FR` ↔ `fr_FR`', () => {
  assert.equal(toggleLocaleSeparator('fr-FR'), 'fr_FR');
  assert.equal(toggleLocaleSeparator('fr_FR'), 'fr-FR');
});

test('toggleLocaleSeparator — no separator returns unchanged', () => {
  assert.equal(toggleLocaleSeparator('en'), 'en');
  assert.equal(toggleLocaleSeparator(''), '');
});

test('ttsGetUrl — as-given succeeds → one call, no fallback log', async () => {
  const { fn, calls } = makeStub([{ statusCode: 200, bodyText: okBody() }]);
  const logs: string[] = [];
  const res = await ttsGetUrl(
    'tts.piper',
    'hello',
    'en-US',
    'http://homeassistant.local:8123',
    (m) => logs.push(m),
    fn,
  );
  assert.equal(calls.length, 1, 'should not retry on success');
  assert.equal(calls[0].body.language, 'en-US');
  assert.equal(res.error, undefined);
  assert.equal(res.url, 'http://homeassistant.local:8123/api/tts_proxy/abc.mp3');
  assert.equal(res.path, '/api/tts_proxy/abc.mp3');
  assert.equal(logs.length, 0, 'no fallback log when first attempt succeeds');
});

test('ttsGetUrl — as-given 500, toggled 200 → returns toggled URL + emits hint log', async () => {
  const { fn, calls } = makeStub([
    { statusCode: 500, bodyText: errBody('Unsupported language en-US') },
    { statusCode: 200, bodyText: okBody('/api/tts_proxy/piper-good.mp3') },
  ]);
  const logs: string[] = [];
  const res = await ttsGetUrl(
    'tts.piper',
    'hello',
    'en-US',
    null,
    (m) => logs.push(m),
    fn,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.language, 'en-US', 'first call uses as-given separator');
  assert.equal(calls[1].body.language, 'en_US', 'second call toggles to underscore');
  assert.equal(res.error, undefined);
  assert.ok(res.url.endsWith('/api/tts_proxy/piper-good.mp3'));
  assert.equal(logs.length, 1, 'one fallback log emitted');
  assert.match(logs[0], /toggled/);
  assert.match(logs[0], /en_US/);
  assert.match(logs[0], /BROADCAST_TTS_LANGUAGE/);
});

test('ttsGetUrl — as-given AND toggled both 500, drop-language 200 → returns', async () => {
  const { fn, calls } = makeStub([
    { statusCode: 500, bodyText: errBody('format wrong') },
    { statusCode: 500, bodyText: errBody('still wrong') },
    { statusCode: 200, bodyText: okBody('/api/tts_proxy/no-lang.mp3') },
  ]);
  const logs: string[] = [];
  const res = await ttsGetUrl(
    'tts.weird_engine',
    'hello',
    'en-US',
    null,
    (m) => logs.push(m),
    fn,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.language, 'en-US');
  assert.equal(calls[1].body.language, 'en_US');
  assert.equal('language' in calls[2].body, false, 'third call omits language entirely');
  assert.equal(res.error, undefined);
  assert.ok(res.url.endsWith('/api/tts_proxy/no-lang.mp3'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no-language/);
});

test('ttsGetUrl — all three attempts 500 → error with all three attempt strings', async () => {
  const { fn, calls } = makeStub([
    { statusCode: 500, bodyText: errBody('err one') },
    { statusCode: 500, bodyText: errBody('err two') },
    { statusCode: 500, bodyText: errBody('err three') },
  ]);
  const logs: string[] = [];
  const res = await ttsGetUrl('tts.piper', 'hello', 'en-US', null, (m) => logs.push(m), fn);
  assert.equal(calls.length, 3);
  assert.equal(res.url, '');
  assert.equal(res.path, '');
  assert.ok(res.error, 'error should be present');
  // All three labels and all three HA error messages should be in there
  // so the user can see exactly what was tried.
  assert.match(res.error!, /as-given/);
  assert.match(res.error!, /toggled/);
  assert.match(res.error!, /no-language/);
  assert.match(res.error!, /err one/);
  assert.match(res.error!, /err two/);
  assert.match(res.error!, /err three/);
  assert.match(res.error!, /tts\.piper/);
  assert.equal(logs.length, 0, 'no success log on total failure');
});

test('ttsGetUrl — non-500 on as-given fails fast, no retry', async () => {
  const { fn, calls } = makeStub([
    { statusCode: 401, bodyText: errBody('unauthorized') },
  ]);
  const logs: string[] = [];
  const res = await ttsGetUrl('tts.piper', 'hello', 'en-US', null, (m) => logs.push(m), fn);
  assert.equal(calls.length, 1, 'must not retry on 4xx');
  assert.equal(res.url, '');
  assert.ok(res.error);
  assert.match(res.error!, /401/);
  assert.match(res.error!, /unauthorized/);
  assert.equal(logs.length, 0);
});

test('ttsGetUrl — no language given → only one attempt (nothing to toggle/drop)', async () => {
  const { fn, calls } = makeStub([
    { statusCode: 500, bodyText: errBody('engine sulking') },
  ]);
  const logs: string[] = [];
  const res = await ttsGetUrl('tts.piper', 'hello', null, null, (m) => logs.push(m), fn);
  assert.equal(calls.length, 1, 'with no language there is no toggle and no drop to retry');
  assert.equal('language' in calls[0].body, false);
  assert.equal(res.url, '');
  assert.ok(res.error);
  assert.match(res.error!, /as-given/);
  assert.match(res.error!, /engine sulking/);
});

test('ttsGetUrl — language without separator → toggled is identical, only 2 distinct attempts', async () => {
  // `en` has no `-` or `_`. toggleLocaleSeparator returns it unchanged.
  // The dedup logic in ttsGetUrl drops the toggled attempt when it
  // matches as-given, so we should see exactly 2 calls (as-given, no-lang).
  const { fn, calls } = makeStub([
    { statusCode: 500, bodyText: errBody('no good') },
    { statusCode: 200, bodyText: okBody() },
  ]);
  const logs: string[] = [];
  const res = await ttsGetUrl('tts.piper', 'hello', 'en', null, (m) => logs.push(m), fn);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.language, 'en');
  assert.equal('language' in calls[1].body, false, 'second call is the drop, not a no-op toggle');
  assert.equal(res.error, undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no-language/);
});

test('cleanup — restore SUPERVISOR_TOKEN', () => {
  if (PREV_TOKEN === undefined) delete process.env.SUPERVISOR_TOKEN;
  else process.env.SUPERVISOR_TOKEN = PREV_TOKEN;
});
