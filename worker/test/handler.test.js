import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, resetAlertMemo, ALERTS_URL, USER_AGENT } from '../src/core.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8');
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const NOW = at('2026-10-08T08:00:00-04:00');
// Test-only home: Masonville Place (public). The real one is a Worker secret.
const ENV = { TOKEN: 'test-token', HOME_LATLON: '43.02566,-81.2815' };
const BASE = 'https://w.example/v1/plan?lat=43.0255&lon=-81.2816&k=test-token';

function fakeFetch({ plan = 'masonville_to_school_0800', planStatus = 200, alerts = 'alerts_handmade', alertsFail = false, planFail = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === ALERTS_URL) {
      if (alertsFail) throw new Error('connect timeout');
      return new Response(fx(alerts), { status: 200 });
    }
    if (planFail) throw new Error('network down');
    return new Response(planStatus === 200 ? fx(plan) : 'oops', { status: planStatus });
  };
  f.calls = calls;
  return f;
}

async function call(url, { env = ENV, fetchImpl = fakeFetch(), now = NOW, cache = null } = {}) {
  const res = await handle(new Request(url), env, { fetchImpl, cache, now });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), bytes: Buffer.byteLength(text), fetchImpl };
}

beforeEach(() => resetAlertMemo());

test('ping needs no token', async () => {
  const r = await call('https://w.example/v1/ping', { env: {} });
  assert.deepEqual(r.body, { v: 1, ok: true, t: NOW });
});

test('plan to school: Transitous query and trimmed reply', async () => {
  const f = fakeFetch();
  const r = await call(`${BASE}&dest=school`, { fetchImpl: f });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  // The single bus at 08:10 (1 min later than the transfer trip) is chosen.
  assert.equal(r.body.xfers, 0);
  assert.equal(r.body.alert, '#2003 closed: use Althouse College');
  console.log(`  /v1/plan reply bytes: ${r.bytes}`);
  const tq = f.calls.find((c) => c.url.startsWith('https://api.transitous.org/'));
  const u = new URL(tq.url);
  assert.equal(u.pathname, '/api/v5/plan');
  assert.equal(u.searchParams.get('fromPlace'), '43.02550,-81.28160');
  assert.equal(u.searchParams.get('toPlace'), '43.00129,-81.27883');
  assert.equal(u.searchParams.get('arriveBy'), 'false');
  assert.equal(u.searchParams.get('numItineraries'), '5');
  assert.equal(u.searchParams.get('time'), '2026-10-08T12:00:00.000Z');
  assert.equal(u.searchParams.get('directModes'), 'WALK');
  assert.equal(u.searchParams.get('maxDirectTime'), '5400');
  assert.equal(u.searchParams.get('maxPreTransitTime'), '1800');
  assert.equal(u.searchParams.get('maxPostTransitTime'), null);
  assert.equal(tq.init.headers['User-Agent'], USER_AGENT);
  assert.equal(USER_AGENT, 'LTCTrip/0.1 (+https://github.com/irugniM)');
});

test('plan home uses HOME_LATLON and arrive-by', async () => {
  const f = fakeFetch({ plan: 'school_to_masonville_1600' });
  const t = at('2026-10-08T16:40:00-04:00');
  // From the school stop (the test home is Masonville).
  const r = await call(`https://w.example/v1/plan?lat=43.00129&lon=-81.27883&k=test-token&dest=home&mode=arrive&t=${t}`, { fetchImpl: f });
  assert.equal(r.body.ok, true);
  const u = new URL(f.calls.find((c) => c.url.includes('transitous')).url);
  assert.equal(u.searchParams.get('toPlace'), '43.02566,-81.2815');
  assert.equal(u.searchParams.get('arriveBy'), 'true');
  // pts: the (synthetic test) home from the secret, and the first boarding stop.
  assert.deepEqual(r.body.pts.d, [43.02566, -81.2815]);
  assert.equal(r.body.pts.s.length, 2);
  assert.equal(typeof r.body.pts.t, 'number');
  assert.ok(Buffer.byteLength(JSON.stringify(r.body)) <= 600);
});

test('errors: token', async () => {
  assert.deepEqual((await call(`${BASE.replace('test-token', 'nope')}&dest=school`)).body, { v: 1, ok: false, err: 'Bad token' });
  assert.equal((await call(`${BASE.replace('&k=test-token', '')}&dest=school`)).body.err, 'Bad token');
  assert.equal((await call(`${BASE}&dest=school`, { env: { HOME_LATLON: ENV.HOME_LATLON } })).body.err, 'Token not set');
});

test('errors: bad params', async () => {
  const bad = [
    'https://w.example/v1/plan?k=test-token&dest=school',
    `${BASE}&dest=work`,
    `${BASE}`,
    `${BASE}&dest=school&mode=soon`,
    `${BASE}&dest=school&mode=arrive`,
    `${BASE}&dest=school&t=abc`,
    'https://w.example/v1/plan?lat=95&lon=0&k=test-token&dest=school',
  ];
  for (const u of bad) {
    const r = await call(u);
    assert.deepEqual(r.body, { v: 1, ok: false, err: 'Bad params' }, u);
  }
});

test('errors: home not set', async () => {
  for (const home of [undefined, '', 'nowhere', '100,200']) {
    const r = await call(`${BASE}&dest=home`, { env: { TOKEN: 'test-token', HOME_LATLON: home } });
    assert.equal(r.body.err, 'Home not set', String(home));
  }
});

test('errors: Transitous down (HTTP 5xx and network)', async () => {
  assert.equal((await call(`${BASE}&dest=school`, { fetchImpl: fakeFetch({ planStatus: 503 }) })).body.err, 'Transitous down');
  assert.equal((await call(`${BASE}&dest=school`, { fetchImpl: fakeFetch({ planFail: true }) })).body.err, 'Transitous down');
});

test('errors: no trips found', async () => {
  const f = async (url) => new Response(String(url) === ALERTS_URL ? '{"entity":[]}' : '{"itineraries":[],"direct":[]}');
  assert.deepEqual((await call(`${BASE}&dest=school`, { fetchImpl: f })).body, { v: 1, ok: false, err: 'No trips found' });
});

test('alerts feed unreachable: plan still works, alert null, retry after 30 s', async () => {
  const f = fakeFetch({ alertsFail: true });
  const r = await call(`${BASE}&dest=school`, { fetchImpl: f });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.alert, null);
  await call(`${BASE}&dest=school`, { fetchImpl: f, now: NOW + 10 });
  assert.equal(f.calls.filter((c) => c.url === ALERTS_URL).length, 1, 'no refetch within 30 s');
  const ok = fakeFetch();
  const r2 = await call(`${BASE}&dest=school`, { fetchImpl: ok, now: NOW + 31 });
  assert.equal(r2.body.alert, '#2003 closed: use Althouse College');
});

test('alerts cached for 60 s (memory and Cache API)', async () => {
  const store = new Map();
  const cache = {
    async match(req) { const v = store.get(req.url); return v ? new Response(v) : undefined; },
    async put(req, res) { store.set(req.url, await res.text()); },
  };
  const f = fakeFetch();
  await call(`${BASE}&dest=school`, { fetchImpl: f, cache });
  await call(`${BASE}&dest=school`, { fetchImpl: f, cache, now: NOW + 30 });
  assert.equal(f.calls.filter((c) => c.url === ALERTS_URL).length, 1, 'memo hit');
  resetAlertMemo();
  await call(`${BASE}&dest=school`, { fetchImpl: f, cache, now: NOW + 40 });
  assert.equal(f.calls.filter((c) => c.url === ALERTS_URL).length, 1, 'Cache API hit');
  await call(`${BASE}&dest=school`, { fetchImpl: f, cache, now: NOW + 61 });
  assert.equal(f.calls.filter((c) => c.url === ALERTS_URL).length, 2, 'expired, refetched');
});

test('unknown path is 404 JSON', async () => {
  const r = await call('https://w.example/');
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test('at the destination: "You\'re here" without calling Transitous', async () => {
  const f = fakeFetch();
  // About 15 m from the school stop.
  const r = await call('https://w.example/v1/plan?lat=43.00140&lon=-81.27890&k=test-token&dest=school', { fetchImpl: f });
  assert.deepEqual(r.body, {
    v: 1, ok: true, leave: NOW, arr: NOW, rt: false, xfers: 0, lines: ["You're here"], alert: null, next: null,
    pts: { d: [43.00129, -81.27883] },
  });
  assert.equal(f.calls.length, 0);
  // Home works the same way (test home is Masonville; BASE is ~15 m from it).
  assert.deepEqual((await call(`${BASE}&dest=home`, { fetchImpl: f })).body.lines, ["You're here"]);
  // ~170 m away is not "here".
  const far = await call('https://w.example/v1/plan?lat=43.00282&lon=-81.27883&k=test-token&dest=school', { fetchImpl: fakeFetch() });
  assert.notDeepEqual(far.body.lines, ["You're here"]);
});

test('walk-only reply when Transitous has only `direct`', async () => {
  const walk = {
    duration: 480, startTime: '2026-10-08T12:00:00Z', endTime: '2026-10-08T12:08:00Z',
    legs: [{ mode: 'WALK', duration: 480, startTime: '2026-10-08T12:00:00Z', endTime: '2026-10-08T12:08:00Z' }],
  };
  const f = async (url) => new Response(String(url) === ALERTS_URL ? '{"entity":[]}' : JSON.stringify({ itineraries: [], direct: [walk] }));
  const r = await call(`${BASE}&dest=school`, { fetchImpl: f });
  assert.deepEqual(r.body, {
    v: 1, ok: true, leave: NOW, arr: NOW + 480, rt: false, xfers: 0, lines: ['Walk 8 min', 'Arrive 08:08'], alert: null, next: null,
    pts: { d: [43.00129, -81.27883] },
  });
});
