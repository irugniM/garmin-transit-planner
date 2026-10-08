// LTCTrip Worker logic: GET /v1/plan and GET /v1/ping. See ../../README.md.
// The Worker entry (index.js) may only export handlers, so the testable
// pieces live here.
import { compactAlerts, errorReply, trimPlan } from './plan.js';

export const VERSION = '0.1';
export const USER_AGENT = `LTCTrip/${VERSION} (+https://github.com/irugniM)`;
export const TRANSITOUS = 'https://api.transitous.org/api/v5/plan';
// HTTPS on this host is broken; plain http is the only working option.
export const ALERTS_URL = 'http://gtfs.ltconline.ca/Alert/Alerts.json';
export const ALERTS_TTL = 60;

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

export async function planTrip(params, env, deps) {
  const { fetchImpl, now } = deps;
  const lat = num(params.get('lat'));
  const lon = num(params.get('lon'));
  const dest = params.get('dest');
  const mode = params.get('mode') || 'depart';
  const tRaw = params.get('t');
  const t = tRaw === null || tRaw === '' ? now : num(tRaw);
  if (
    !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
    (dest !== 'home' && dest !== 'school') ||
    (mode !== 'depart' && mode !== 'arrive') ||
    !Number.isFinite(t) || (mode === 'arrive' && (tRaw === null || tRaw === ''))
  ) {
    return errorReply('Bad params');
  }
  let to = SCHOOL;
  if (dest === 'home') {
    to = parseLatLon(env.HOME_LATLON);
    if (!to) return errorReply('Home not set');
  }

  const u = new URL(TRANSITOUS);
  u.searchParams.set('fromPlace', `${lat.toFixed(5)},${lon.toFixed(5)}`);
  u.searchParams.set('toPlace', `${to.lat},${to.lon}`);
  u.searchParams.set('time', new Date(Math.floor(t) * 1000).toISOString());
  u.searchParams.set('arriveBy', mode === 'arrive' ? 'true' : 'false');
  u.searchParams.set('numItineraries', '3');

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
  const alerts = await alertsP;
  return trimPlan(tq, { mode, t, alerts });
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json(errorReply('Bad params'), 405);
  if (url.pathname === '/v1/ping') {
    return json({ v: 1, ok: true, t: deps.now });
  }
  if (url.pathname === '/v1/plan') {
    if (!env.TOKEN) return json(errorReply('Token not set'));
    if (!sameToken(url.searchParams.get('k') || '', env.TOKEN)) return json(errorReply('Bad token'));
    return json(await planTrip(url.searchParams, env, deps));
  }
  return json(errorReply('Not found'), 404);
}
