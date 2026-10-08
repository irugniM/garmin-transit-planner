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
// Same token, test home far away (White Oaks Mall): BASE is not near home.
const ENV_AWAY = { TOKEN: 'test-token', HOME_LATLON: '42.98220,-81.25120' };

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
  const r = await call(`${BASE}&dest=school`, { fetchImpl: f, env: ENV_AWAY });
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

// ---- near home ----------------------------------------------------------------
// BASE (43.0255,-81.2816) is ~18 m from the test home (Masonville). Fake stops.
const iso = (secs) => new Date(secs * 1000).toISOString();
function detourTq(deps) {
  const stop = { name: 'Test Stop NB - #9001', stopId: 'T9001', stopCode: '9001', lat: 43.02639, lon: -81.2816 }; // ~99 m N
  const off = { name: 'Test Stop Far SB - #9099', stopId: 'T9099', stopCode: '9099', lat: 43.0013, lon: -81.2788 };
  return {
    itineraries: deps.map((dep) => ({
      startTime: iso(dep - 420), endTime: iso(dep + 720), duration: 1140, transfers: 0,
      legs: [
        { mode: 'WALK', from: { name: 'START', lat: 43.0255, lon: -81.2816 }, to: stop, startTime: iso(dep - 420), endTime: iso(dep), duration: 420, distance: 500 },
        { mode: 'BUS', routeShortName: '6', headsign: 'Somewhere', from: stop, to: off, startTime: iso(dep), endTime: iso(dep + 600), duration: 600 },
        { mode: 'WALK', from: off, to: { name: 'END' }, startTime: iso(dep + 600), endTime: iso(dep + 720), duration: 120, distance: 100 },
      ],
    })),
    direct: [],
  };
}
function tqFetch(tq) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    return new Response(String(url) === ALERTS_URL ? '{"entity":[]}' : JSON.stringify(tq));
  };
  f.calls = calls;
  return f;
}
const timeOf = (f) => new URL(f.calls.find((c) => c.includes('transitous'))).searchParams.get('time');

test('near home, depart: asks 5 min earlier, straight-line first walk, missed buses dropped', async () => {
  const f = tqFetch(detourTq([NOW + 60, NOW + 240, NOW + 720]));
  const r = await call(`${BASE}&dest=school`, { fetchImpl: f });
  assert.equal(timeOf(f), '2026-10-08T11:55:00.000Z');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.leave, NOW + 120);
  assert.equal(r.body.lines[0], 'Leave 08:02');
  assert.ok(r.body.lines.includes('Walk 2 min #9001'));
  assert.ok(r.body.lines.includes('Bus 6 08:04'));
  assert.equal(r.body.next, 'Next bus 08:12');
  assert.ok(r.bytes <= 600);
});

test('near home, arrive-by: time unchanged, walk still fixed', async () => {
  const f = tqFetch(detourTq([NOW - 1800]));
  const t = NOW + 600;
  const r = await call(`${BASE}&dest=school&mode=arrive&t=${t}`, { fetchImpl: f });
  assert.equal(timeOf(f), iso(t));
  assert.equal(r.body.leave, NOW - 1800 - 120);
});

test('away from home: no shift and Transitous walk times kept', async () => {
  const f = tqFetch(detourTq([NOW + 60, NOW + 240, NOW + 720]));
  const r = await call(`${BASE}&dest=school`, { fetchImpl: f, env: ENV_AWAY });
  assert.equal(timeOf(f), '2026-10-08T12:00:00.000Z');
  assert.equal(r.body.leave, NOW + 60 - 420);
  assert.ok(r.body.lines.includes('Walk 7 min #9001'));
  // No home secret at all: same.
  const g = tqFetch(detourTq([NOW + 60]));
  const r2 = await call(`${BASE}&dest=school`, { fetchImpl: g, env: { TOKEN: 'test-token' } });
  assert.equal(timeOf(g), '2026-10-08T12:00:00.000Z');
  assert.equal(r2.body.leave, NOW + 60 - 420);
});

// ---- POST endpoints: plan by place id or coordinates, geocode, places --------
// Public places only: Masonville, Western, downtown.

const DOWNTOWN = { lat: 42.98365, lon: -81.24963 }; // Covent Garden Market
const PLACES = JSON.stringify([
  { n: 'Downtown', lat: DOWNTOWN.lat, lon: DOWNTOWN.lon },
  { id: 'wom', n: 'White Oaks Mall', lat: 42.93208, lon: -81.22315 },
  { n: '', lat: 1, lon: 2 }, // no name: skipped
  { n: 'Bad', lat: 'x', lon: 2 }, // bad coordinates: skipped
]);
const ENV_P = { ...ENV, PLACES };

async function post(path, body, { env = ENV_P, fetchImpl = fakeFetch(), now = NOW, raw = null } = {}) {
  const req = new Request(`https://w.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
  });
  const res = await handle(req, env, { fetchImpl, cache: null, now });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), bytes: Buffer.byteLength(text), fetchImpl, text };
}
const ORIG = { lat: '43.02550', lon: '-81.28160' };
const tqUrl = (f) => new URL(f.calls.find((c) => c.url.includes('/api/v5/plan')).url);

test('POST plan: token in the body; school/home like GET; the GET path still works', async () => {
  const f = fakeFetch();
  const r = await post('/v1/plan', { k: 'test-token', ...ORIG, dest: 'school', mode: 'depart' }, { fetchImpl: f, env: { ...ENV_AWAY, PLACES } });
  assert.equal(r.body.ok, true);
  assert.equal(tqUrl(f).searchParams.get('toPlace'), '43.00129,-81.27883');
  // Same answer as the GET the 6895b4a watch build sends.
  const g = await call(`${BASE}&dest=school&mode=depart`, { env: ENV_AWAY });
  assert.deepEqual(r.body, g.body);
  assert.equal((await post('/v1/plan', { k: 'nope', ...ORIG, dest: 'school' })).body.err, 'Bad token');
  assert.equal((await post('/v1/plan', { ...ORIG, dest: 'school' })).body.err, 'Bad token');
  assert.equal((await post('/v1/plan', { k: 'test-token', ...ORIG })).body.err, 'Bad params');
  assert.equal((await post('/v1/plan', null, { raw: 'not json' })).status, 400);
  assert.equal((await post('/v1/plan', null, { raw: JSON.stringify({ k: 'test-token', pad: 'x'.repeat(3000) }) })).status, 400);
});

test('POST plan by coordinates (settings and saved places): pts.d is that place', async () => {
  const f = fakeFetch();
  const r = await post('/v1/plan', { k: 'test-token', ...ORIG, tlat: '42.98365', tlon: '-81.24963' }, { fetchImpl: f });
  assert.equal(r.body.ok, true);
  assert.equal(tqUrl(f).searchParams.get('toPlace'), '42.98365,-81.24963');
  assert.deepEqual(r.body.pts.d, [42.98365, -81.24963]);
  // Numbers work too; bad or half coordinates, or coordinates plus dest, don't.
  assert.equal((await post('/v1/plan', { k: 'test-token', ...ORIG, tlat: 42.98365, tlon: -81.24963 })).body.ok, true);
  for (const bad of [{ tlat: '42.9' }, { tlat: 'x', tlon: '-81.2' }, { tlat: '95', tlon: '-81.2' }, { tlat: '42.9', tlon: '-81.2', dest: 'school' }]) {
    assert.equal((await post('/v1/plan', { k: 'test-token', ...ORIG, ...bad })).body.err, 'Bad params', JSON.stringify(bad));
  }
  // Near the place: "You're here" with that place in pts.d.
  const here = await post('/v1/plan', { k: 'test-token', lat: '42.98370', lon: '-81.24970', tlat: '42.98365', tlon: '-81.24963' });
  assert.deepEqual(here.body.lines, ["You're here"]);
  // GET never takes a destination other than school/home.
  const g = await call(`${BASE}&tlat=42.98365&tlon=-81.24963`);
  assert.equal(g.body.err, 'Bad params');
  const g2 = await call(`${BASE}&place=1`);
  assert.equal(g2.body.err, 'Bad params');
});

test('POST plan by private place id: coordinates come from the PLACES secret', async () => {
  const f = fakeFetch();
  const r = await post('/v1/plan', { k: 'test-token', ...ORIG, place: '1' }, { fetchImpl: f });
  assert.equal(r.body.ok, true);
  assert.equal(tqUrl(f).searchParams.get('toPlace'), `${DOWNTOWN.lat},${DOWNTOWN.lon}`);
  assert.deepEqual(r.body.pts.d, [DOWNTOWN.lat, DOWNTOWN.lon]);
  const g = fakeFetch();
  await post('/v1/plan', { k: 'test-token', ...ORIG, place: 'wom' }, { fetchImpl: g });
  assert.equal(tqUrl(g).searchParams.get('toPlace'), '42.93208,-81.22315');
  for (const id of ['3', '9', 'nope']) {
    assert.equal((await post('/v1/plan', { k: 'test-token', ...ORIG, place: id })).body.err, 'Place not found', id);
  }
  // No secret: nothing to find.
  assert.equal((await post('/v1/plan', { k: 'test-token', ...ORIG, place: '1' }, { env: ENV })).body.err, 'Place not found');
});

test('POST places: names and ids only; empty when the secret is missing or junk', async () => {
  const r = await post('/v1/places', { k: 'test-token' });
  assert.deepEqual(r.body, { v: 1, ok: true, places: [{ id: '1', n: 'Downtown' }, { id: 'wom', n: 'White Oaks Mall' }] });
  assert.ok(!r.text.includes('42.9'), 'no coordinates in the list');
  for (const env of [ENV, { ...ENV, PLACES: '' }, { ...ENV, PLACES: '{bad' }, { ...ENV, PLACES: '{"n":"x"}' }]) {
    assert.deepEqual((await post('/v1/places', { k: 'test-token' }, { env })).body, { v: 1, ok: true, places: [] });
  }
  // Long names are cut; at most 20 places.
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ n: `Place number ${i} with a long name`, lat: 42.98, lon: -81.25 })));
  const m = await post('/v1/places', { k: 'test-token' }, { env: { ...ENV, PLACES: many } });
  assert.equal(m.body.places.length, 20);
  assert.ok(m.body.places.every((p) => p.n.length <= 20));
  assert.equal((await post('/v1/places', { k: 'bad' })).body.err, 'Bad token');
  // Only POST.
  const g = await call('https://w.example/v1/places?k=test-token');
  assert.equal(g.status, 405);
});

function geoFetch(matches, { status = 200 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(matches), { status });
  };
  f.calls = calls;
  return f;
}

test('POST geocode: first match near London, rounded; far matches ignored', async () => {
  const f = geoFetch([
    { type: 'PLACE', name: 'Somewhere far away', lat: 38.23, lon: -85.74 },
    { type: 'PLACE', name: 'Masonville Place', lat: 43.026312, lon: -81.280127 },
  ]);
  const r = await post('/v1/geocode', { k: 'test-token', q: '  Masonville   Place ' }, { fetchImpl: f });
  assert.deepEqual(r.body, { v: 1, ok: true, lat: 43.02631, lon: -81.28013, n: 'Masonville Place' });
  assert.equal(f.calls.length, 1);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.transitous.org/api/v1/geocode');
  // The address text has to go to Transitous (only there), with a London bias.
  assert.equal(u.searchParams.get('text'), 'Masonville Place');
  assert.equal(u.searchParams.get('place'), '42.9849,-81.2453');
  assert.ok(!f.calls[0].url.includes('test-token'));
  assert.equal(f.calls[0].init.headers['User-Agent'], USER_AGENT);
});

test('POST geocode: not found, bad input, Transitous down', async () => {
  const far = geoFetch([{ type: 'PLACE', name: 'Nook and Nowhere', lat: 38.23, lon: -85.74 }]);
  assert.deepEqual((await post('/v1/geocode', { k: 'test-token', q: 'zzqx nowhere' }, { fetchImpl: far })).body,
    { v: 1, ok: false, err: 'Address not found' });
  assert.equal((await post('/v1/geocode', { k: 'test-token', q: 'zzqx' }, { fetchImpl: geoFetch([]) })).body.err, 'Address not found');
  assert.equal((await post('/v1/geocode', { k: 'test-token', q: 'Masonville' }, { fetchImpl: geoFetch([], { status: 500 }) })).body.err, 'Transitous down');
  const none = geoFetch([]);
  for (const q of [undefined, '', 'ab', 'x'.repeat(201), 42]) {
    assert.equal((await post('/v1/geocode', { k: 'test-token', q }, { fetchImpl: none })).body.err, 'Bad address', String(q));
  }
  assert.equal(none.calls.length, 0);
  assert.equal((await post('/v1/geocode', { k: 'wrong', q: 'Masonville Place' }, { fetchImpl: none })).body.err, 'Bad token');
  assert.equal(none.calls.length, 0);
});

test('geocode: the address is only accepted in a POST body, never a URL', async () => {
  const f = geoFetch([{ type: 'PLACE', name: 'Masonville Place', lat: 43.0263, lon: -81.2801 }]);
  for (const url of ['https://w.example/v1/geocode?k=test-token&q=Masonville+Place', 'https://w.example/v1/plan?k=test-token&q=Masonville+Place']) {
    const res = await handle(new Request(url), ENV_P, { fetchImpl: f, cache: null, now: NOW });
    const body = await res.json();
    assert.equal(body.ok, false, url);
  }
  // A query string on the POST is ignored: the body is what counts.
  const req = new Request('https://w.example/v1/geocode?q=Masonville+Place', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ k: 'test-token' }),
  });
  const res = await (await handle(req, ENV_P, { fetchImpl: f, cache: null, now: NOW })).json();
  assert.equal(res.err, 'Bad address');
  assert.equal(f.calls.length, 0);
});

test('the Worker source has no console logging', () => {
  for (const n of ['core.js', 'plan.js', 'index.js']) {
    const src = readFileSync(new URL(`../src/${n}`, import.meta.url), 'utf8');
    assert.ok(!/console\./.test(src), n);
  }
});

test('geocode calls fetch without a `this` (workerd rejects one)', async () => {
  let self = 'unset';
  const f = async function (url) {
    self = this;
    return new Response(JSON.stringify([{ name: 'Masonville Place', lat: 43.0263, lon: -81.2801 }]));
  };
  const r = await post('/v1/geocode', { k: 'test-token', q: 'Masonville Place' }, { fetchImpl: f });
  assert.equal(r.body.ok, true);
  assert.equal(self, undefined);
});
