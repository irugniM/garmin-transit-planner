// LTCTrip Worker logic: GET /v1/plan and GET /v1/ping. See ../../README.md.
// The Worker entry (index.js) may only export handlers, so the testable
// pieces live here.
import { clip, compactAlerts, errorReply, hereReply, metres, nearHomePlan, trimPlan, HERE_M, NEAR_HOME_M, NEAR_SHIFT } from './plan.js';

export const VERSION = '0.1';
export const USER_AGENT = `LTCTrip/${VERSION} (+https://github.com/irugniM)`;
export const TRANSITOUS = 'https://api.transitous.org/api/v5/plan';
export const GEOCODE = 'https://api.transitous.org/api/v1/geocode';
// HTTPS on this host is broken; plain http is the only working option.
export const ALERTS_URL = 'http://gtfs.ltconline.ca/Alert/Alerts.json';
export const ALERTS_TTL = 60;
export const MAX_DIRECT_WALK = 5400; // seconds
export const MAX_FIRST_WALK = 1800; // seconds

// School: Sarnia Rd at Western Rd (public LTC stops #1646 EB / #1647 WB).
// Home comes from the HOME_LATLON secret and is never in the code.
export const SCHOOL = { lat: 43.00129, lon: -81.27883 };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseLatLon(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function num(v) {
  if (v === null || v === '' || v === undefined) return NaN;
  return Number(v);
}

// Module-level copy as well as the Cache API: the Cache API may be a no-op on
// workers.dev, and an isolate often serves several requests in a row.
let memo = { at: 0, map: null, failedAt: -1e9 };
// After a failed fetch, skip the feed for this long so every plan request
// doesn't wait for the timeout while LTC's host is down.
export const ALERTS_RETRY = 30;

export function resetAlertMemo() {
  memo = { at: 0, map: null, failedAt: -1e9 };
}

// Returns the compact alert map, or null when the feed is unreachable.
export async function loadAlerts({ fetchImpl, cache, now, timeoutMs = 3000 }) {
  if (memo.map && now - memo.at < ALERTS_TTL) return memo.map;
  if (now - memo.failedAt < ALERTS_RETRY) return null;
  const key = new Request('https://ltctrip.internal/alerts-v1');
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const body = await hit.json();
        if (body && now - body.at < ALERTS_TTL) {
          memo = { ...memo, at: body.at, map: body.map };
          return body.map;
        }
      }
    } catch (_) {
      // Cache trouble is never fatal.
    }
  }
  try {
    const r = await fetchImpl(ALERTS_URL, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`alerts HTTP ${r.status}`);
    const map = compactAlerts(await r.json(), now);
    memo = { at: now, map, failedAt: -1e9 };
    if (cache) {
      const resp = new Response(JSON.stringify({ at: now, map }), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ALERTS_TTL}` },
      });
      try {
        await cache.put(key, resp);
      } catch (_) {
        // ignore
      }
    }
    return map;
  } catch (_) {
    memo = { ...memo, failedAt: now };
    return null;
  }
}

// ---- places ------------------------------------------------------------------
// Private list: the PLACES secret, JSON [{"n": name, "lat": .., "lon": ..,
// "id"?: short id}]. The watch only ever gets ids and names; coordinates
// stay in the Worker, like HOME_LATLON. Missing or invalid: empty list.
export const MAX_PLACES = 20;
export const MAX_NAME = 20;

export function parsePlaces(text) {
  let list;
  try {
    list = JSON.parse(String(text || '[]'));
  } catch (_) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length && out.length < MAX_PLACES; i++) {
    const e = list[i];
    if (!e || typeof e !== 'object') continue;
    const lat = Number(e.lat);
    const lon = Number(e.lon);
    const n = String(e.n ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
    if (!n || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    let id = e.id === undefined || e.id === null ? String(i + 1) : String(e.id);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, n, lat, lon });
  }
  return out;
}

export function placesReply(env) {
  return { v: 1, ok: true, places: parsePlaces(env.PLACES).map(({ id, n }) => ({ id, n })) };
}

// Geocoding (POST /v1/geocode): Transitous's geocoder, biased to London and
// limited to matches within GEO_RADIUS_M of it. The address text has to go
// to Transitous; nothing is stored or logged here.
export const LONDON = { lat: 42.9849, lon: -81.2453 };
export const GEO_RADIUS_M = 150000;
export const MAX_ADDRESS = 200;

export async function geocode(q, deps) {
  const text = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : '';
  if (text.length < 3 || text.length > MAX_ADDRESS) return errorReply('Bad address');
  const u = new URL(GEOCODE);
  u.searchParams.set('text', text);
  u.searchParams.set('place', `${LONDON.lat},${LONDON.lon}`);
  u.searchParams.set('placeBias', '5');
  u.searchParams.set('numResults', '5');
  u.searchParams.set('language', 'en');
  // Plain call: workerd's fetch rejects a `this` (deps.fetchImpl(...)).
  const { fetchImpl } = deps;
  let list;
  try {
    const r = await fetchImpl(u.toString(), {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(deps.transitousTimeoutMs ?? 12000),
    });
    if (!r.ok) return errorReply('Transitous down');
    list = await r.json();
  } catch (_) {
    return errorReply('Transitous down');
  }
  const hit = (Array.isArray(list) ? list : []).find((m) => m && Number.isFinite(Number(m.lat)) && Number.isFinite(Number(m.lon)) &&
    m.lat !== null && m.lon !== null && metres(LONDON, { lat: Number(m.lat), lon: Number(m.lon) }) <= GEO_RADIUS_M);
  if (!hit) return errorReply('Address not found');
  const r5 = (x) => Math.round(Number(x) * 1e5) / 1e5;
  return { v: 1, ok: true, lat: r5(hit.lat), lon: r5(hit.lon), n: clip(String(hit.name || ''), MAX_NAME) };
}

// `params.get(name)` gives a string or null (URLSearchParams for GET, the
// JSON body for POST). Only POST may name a private place or coordinates.
export async function planTrip(params, env, deps, { post = false } = {}) {
  const { fetchImpl, now } = deps;
  const lat = num(params.get('lat'));
  const lon = num(params.get('lon'));
  const dest = params.get('dest');
  const place = post ? params.get('place') : null;
  const tlat = post ? num(params.get('tlat')) : NaN;
  const tlon = post ? num(params.get('tlon')) : NaN;
  const custom = place !== null || params.get('tlat') !== null || params.get('tlon') !== null;
  const mode = params.get('mode') || 'depart';
  const tRaw = params.get('t');
  const t = tRaw === null || tRaw === '' ? now : num(tRaw);
  if (
    !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
    (post && custom ? dest !== null : dest !== 'home' && dest !== 'school') ||
    (place === null && post && custom && (!Number.isFinite(tlat) || !Number.isFinite(tlon) || Math.abs(tlat) > 90 || Math.abs(tlon) > 180)) ||
    (mode !== 'depart' && mode !== 'arrive') ||
    !Number.isFinite(t) || (mode === 'arrive' && (tRaw === null || tRaw === ''))
  ) {
    return errorReply('Bad params');
  }
  let to = SCHOOL;
  if (place !== null) {
    const p = parsePlaces(env.PLACES).find((x) => x.id === place);
    if (!p) return errorReply('Place not found');
    to = { lat: p.lat, lon: p.lon };
  } else if (post && custom) {
    to = { lat: tlat, lon: tlon };
  } else if (dest === 'home') {
    to = parseLatLon(env.HOME_LATLON);
    if (!to) return errorReply('Home not set');
  }
  // Already there: no need to ask Transitous.
  if (metres({ lat, lon }, to) <= HERE_M) return hereReply(now, to);
  // Near home (HOME_LATLON secret): ask a bit earlier and fix detour walks
  // to the first stop (see nearHomePlan). Elsewhere nothing changes.
  const home = parseLatLon(env.HOME_LATLON);
  const nearHome = Boolean(home) && metres({ lat, lon }, home) <= NEAR_HOME_M;
  const qt = nearHome && mode === 'depart' ? t - NEAR_SHIFT : t;

  const u = new URL(TRANSITOUS);
  u.searchParams.set('fromPlace', `${lat.toFixed(5)},${lon.toFixed(5)}`);
  u.searchParams.set('toPlace', `${to.lat},${to.lon}`);
  u.searchParams.set('time', new Date(Math.floor(qt) * 1000).toISOString());
  u.searchParams.set('arriveBy', mode === 'arrive' ? 'true' : 'false');
  // 5, not 3: the chosen trip is often the last of three, which left no
  // "Next:" bus to show.
  u.searchParams.set('numItineraries', '5');
  // Walk-only connections come back separately in `direct`. WALK is MOTIS'
  // default, but ask explicitly so a default change can't drop them.
  u.searchParams.set('directModes', 'WALK');
  // MOTIS caps direct walks at 30 min and the walk to the first stop at
  // 15 min by default. Late at night a long walk (or a far first stop) beats
  // "No trips found". The walk from the last stop keeps its default.
  u.searchParams.set('maxDirectTime', String(MAX_DIRECT_WALK));
  u.searchParams.set('maxPreTransitTime', String(MAX_FIRST_WALK));

  const alertsP = loadAlerts(deps);
  let tq;
  try {
    const r = await fetchImpl(u.toString(), {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(deps.transitousTimeoutMs ?? 12000),
    });
    if (!r.ok) return errorReply('Transitous down');
    tq = await r.json();
  } catch (_) {
    return errorReply('Transitous down');
  }
  if (nearHome) tq = nearHomePlan(tq, { lat, lon }, mode, t);
  const alerts = await alertsP;
  return trimPlan(tq, { mode, t, alerts, to });
}

export const MAX_BODY = 2048;

// JSON object body as a params getter, or null.
async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  let text;
  try {
    text = await request.text();
  } catch (_) {
    return null;
  }
  if (text.length > MAX_BODY) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return {
    get: (k) => {
      const v = Object.prototype.hasOwnProperty.call(body, k) ? body[k] : null;
      if (v === null || v === undefined || typeof v === 'object') return null;
      return String(v);
    },
  };
}

// GET /v1/ping, GET /v1/plan (query; what the 6895b4a watch build uses) and
// POST /v1/plan, /v1/geocode, /v1/places with a JSON body that carries the
// token as "k" (addresses and coordinates never go in a URL).
export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET') {
    if (path === '/v1/ping') return json({ v: 1, ok: true, t: deps.now });
    if (path === '/v1/plan') {
      if (!env.TOKEN) return json(errorReply('Token not set'));
      if (!sameToken(url.searchParams.get('k') || '', env.TOKEN)) return json(errorReply('Bad token'));
      return json(await planTrip(url.searchParams, env, deps));
    }
    if (path === '/v1/geocode' || path === '/v1/places') return json(errorReply('Use POST'), 405);
    return json(errorReply('Not found'), 404);
  }
  if (request.method !== 'POST') return json(errorReply('Bad params'), 405);
  if (path !== '/v1/plan' && path !== '/v1/geocode' && path !== '/v1/places') return json(errorReply('Not found'), 404);
  const body = await readBody(request);
  if (!body) return json(errorReply('Bad params'), 400);
  if (!env.TOKEN) return json(errorReply('Token not set'));
  if (!sameToken(body.get('k') || '', env.TOKEN)) return json(errorReply('Bad token'));
  if (path === '/v1/plan') return json(await planTrip(body, env, deps, { post: true }));
  if (path === '/v1/geocode') return json(await geocode(body.get('q'), deps));
  return json(placesReply(env));
}
