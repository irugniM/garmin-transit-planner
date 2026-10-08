// Pure helpers: turn a Transitous (MOTIS 2) /api/v5/plan reply into the
// small text reply the watch draws, and join LTC GTFS-RT stop alerts.
// No I/O here, so everything is unit-testable with saved fixtures.

export const TZ = 'America/Toronto';
export const MAX_LINE = 18;
export const MAX_ALERT = 36;
export const STOP_PREFIX = 'ca-on-London-Transit_';

const hhmmFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function hhmm(unixSecs) {
  return hhmmFmt.format(new Date(unixSecs * 1000));
}

export function toSecs(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

export function clip(text, max = MAX_LINE) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

// Trim at a word boundary when one is reasonably close to the limit.
export function clipWords(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : s.slice(0, max)).trimEnd();
}

function mins(secs) {
  return Math.max(1, Math.round((secs || 0) / 60));
}

// "09" -> "9", "102" stays.
export function routeLabel(leg) {
  const r = String(leg.routeShortName ?? leg.displayName ?? '?');
  return r.replace(/^0+(?=\w)/, '');
}

// "13A White Oaks Mall via Westminster Park" -> { variant: "13A", to: "White Oaks Mall" }
export function splitHeadsign(headsign, route) {
  let h = String(headsign || '').trim();
  let variant = route;
  const m = h.match(/^(\d+[A-Z])\s+(.*)$/);
  if (m) {
    variant = m[1].replace(/^0+(?=\w)/, '');
    h = m[2];
  }
  h = h.replace(/\s+via\s+.*$/i, '').replace(/^express\s+to\s+/i, '').replace(/\s+only$/i, '').trim();
  return { variant, to: h };
}

// "to X" when it fits; else just "X"; else cut X at a word boundary.
export function destLine(to, max = MAX_LINE) {
  const s = String(to).replace(/\s+/g, ' ').trim();
  if (s.length + 3 <= max) return `to ${s}`;
  if (s.length <= max) return s;
  return clipWords(s, max).replace(/\s*(&|and|-|\/)$/i, '').trimEnd();
}

function stopTag(place) {
  if (place && place.stopCode) return `#${place.stopCode}`;
  return clip(place?.name || 'stop', 10);
}

function isTransit(leg) {
  return leg && leg.mode && leg.mode !== 'WALK' && leg.mode !== 'BIKE' && leg.mode !== 'CAR';
}

function cancelled(it) {
  return (it.legs || []).some((l) => l.cancelled === true || l.from?.cancelled === true || l.to?.cancelled === true);
}

function legSecs(leg) {
  const d = Number(leg.duration);
  if (Number.isFinite(d)) return Math.max(0, d);
  if (leg.startTime && leg.endTime) return Math.max(0, toSecs(leg.endTime) - toSecs(leg.startTime));
  return 0;
}

// Lines for one itinerary, each tagged with a kind so trimPlan can shorten
// long trips from the middle:
//   leave, xfer ("No transfer", "1 transfer", "2 transfers"; trips with a
//   bus only), board ("Walk 6m to #1234" or "Board at #1234"), bus, to
//   (headsign), off, walkEnd (walk after the last bus), walk (walk-only
//   trip), arrive, closed (right after a board or Off line whose stop is
//   closed for that route: "Temp stop 130m W", "Use Althouse", or
//   "Closed: see alert").
// Every bus gets a board line naming its stop, built from the bus leg itself
// (so a missing, split or stop-less walk leg can't hide it). The only
// exception is a transfer at the very stop the previous bus left you at: the
// "Off #1234" line just above already names it.
export function itineraryItems(it, alerts = null) {
  const out = [];
  const legs = it.legs || [];
  const nBus = legs.filter(isTransit).length;
  let busNo = 0;
  let walkSecs = 0;
  let walked = false;
  let lastOff = null;
  out.push({ k: 'leave', t: `Leave ${hhmm(toSecs(it.startTime))}` });
  if (nBus) out.push({ k: 'xfer', t: xferText(it.transfers ?? nBus - 1) });
  for (const leg of legs) {
    if (!isTransit(leg)) {
      walked = true;
      walkSecs += legSecs(leg);
      continue;
    }
    const from = leg.from || {};
    const route = legRoute(leg);
    const sameStop = busNo > 0 && lastOff && from.stopId && lastOff === from.stopId;
    if (!sameStop) {
      const board = walked && walkSecs > 0 ? `Walk ${mins(walkSecs)}m to ${stopTag(from)}` : `Board at ${stopTag(from)}`;
      out.push({ k: 'board', t: clip(board), n: busNo });
    }
    // Boarding stop closed for this route: say where the temporary stop is
    // (for a same-stop transfer, unless the Off line above already did).
    const shut = closureLine(from, route, alerts);
    if (shut && !(sameStop && out.at(-1)?.k === 'closed')) out.push({ k: 'closed', t: shut, n: busNo });
    const { variant, to } = splitHeadsign(leg.headsign, routeLabel(leg));
    const kind = leg.mode === 'BUS' ? 'Bus' : leg.mode[0] + leg.mode.slice(1).toLowerCase();
    let bus = `${kind} ${variant} ${hhmm(toSecs(leg.startTime))}`;
    if (leg.realTime && (bus + ' live').length <= MAX_LINE) bus += ' live';
    out.push({ k: 'bus', t: clip(bus), n: busNo });
    if (to) out.push({ k: 'to', t: destLine(to), n: busNo, of: nBus });
    out.push({ k: 'off', t: clip(`Off ${stopTag(leg.to)} ${hhmm(toSecs(leg.endTime))}`), n: busNo });
    const shutOff = closureLine(leg.to, route, alerts);
    if (shutOff) out.push({ k: 'closed', t: shutOff, n: busNo });
    lastOff = leg.to?.stopId || null;
    busNo++;
    walked = false;
    walkSecs = 0;
  }
  if (walked) out.push({ k: busNo ? 'walkEnd' : 'walk', t: clip(`Walk ${mins(walkSecs)}m`) });
  out.push({ k: 'arrive', t: `Arrive ${hhmm(toSecs(it.endTime))}` });
  return out;
}

function legRoute(leg) {
  return String(leg.routeId || '').replace(STOP_PREFIX, '') || String(leg.routeShortName || '');
}

// Closure alert for a stop as one short line, or null. Detours don't count.
export function closureLine(place, route, alerts) {
  if (!alerts || !place?.stopId) return null;
  const hits = alerts[String(place.stopId).replace(STOP_PREFIX, '')];
  const hit = hits && hits.find((h) => h.k === 'closed' && (!h.r || !route || h.r === route));
  if (!hit) return null;
  return closedText(hit.d);
}

// alertDetail() text -> line: "temp stop 130m W" -> "Temp stop 130m W",
// "temp stop 2 poles S" -> "Temp 2 poles S", "use Althouse College" ->
// "Use Althouse", "use Oxford at Mornington EB" -> "Use Oxford/Morningt",
// nothing -> "Closed: see alert".
export function closedText(detail) {
  const d = String(detail || '').trim();
  let m = d.match(/^temp stop (.+)$/i);
  if (m) {
    const long = `Temp stop ${m[1]}`;
    return long.length <= MAX_LINE ? long : clip(`Temp ${m[1]}`);
  }
  m = d.match(/^use (.+)$/i);
  if (m) {
    // "Oxford at Mornington EB" -> "Oxford/Mornington".
    const p = m[1].replace(/\s*\(temp stop\)/i, '').replace(/\s+[NSEW]B$/, '').replace(/\s+at\s+/i, '/').trim();
    return clipWords(`Use ${p}`, MAX_LINE).replace(/\s+(&|and|-|at|of)$/i, '').replace(/\/$/, '');
  }
  return 'Closed: see alert';
}

export function xferText(n) {
  if (!n) return 'No transfer';
  return n === 1 ? '1 transfer' : `${n} transfers`;
}

export function itineraryLines(it) {
  return itineraryItems(it).map((x) => x.t);
}

// Drop order when a reply is over budget: the no-transfer alternative, headsign lines (middle legs first,
// the first leg's last), then the Leave line (the watch shows the leave time
// in its header anyway). The transfer count, Board, Bus, Off, the last walk
// and Arrive are never dropped.
function dropRank(x) {
  if (x.k === 'alt') return -1;
  if (x.k === 'to') return x.n === 0 ? 2 : x.n === x.of - 1 ? 1 : 0;
  if (x.k === 'leave') return 3;
  return Infinity;
}

// Remove droppable lines (middle first) until fits(lines) is true.
export function compactItems(items, fits) {
  let list = [...items];
  while (!fits(list.map((x) => x.t))) {
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const r = dropRank(list[i]);
      if (r === Infinity) continue;
      // Lowest rank first; among equals, the one nearest the middle of the trip.
      if (best < 0 || r < dropRank(list[best]) ||
        (r === dropRank(list[best]) && Math.abs(i - list.length / 2) < Math.abs(best - list.length / 2))) best = i;
    }
    if (best < 0) break;
    // The alternative's two lines go together.
    const drop = list[best];
    list = list.filter((x, i) => i !== best && !(drop.k === 'alt' && x.k === 'alt'));
  }
  return list.map((x) => x.t);
}

// ---- walking ---------------------------------------------------------------

export const HERE_M = 150;

// Great-circle distance in metres.
export function metres(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function hereReply(now) {
  return { v: 1, ok: true, leave: now, arr: now, rt: false, xfers: 0, lines: ["You're here"], alert: null, next: null };
}

// Shortest walk-only connection in Transitous' `direct` list, as seconds.
export function bestWalk(tq) {
  const list = Array.isArray(tq?.direct) ? tq.direct : [];
  let best = null;
  for (const d of list) {
    const legs = d?.legs || [];
    if (!legs.length || !legs.every((l) => l.mode === 'WALK')) continue;
    let dur = Number(d.duration);
    if (!Number.isFinite(dur) && d.startTime && d.endTime) dur = toSecs(d.endTime) - toSecs(d.startTime);
    if (!Number.isFinite(dur) || dur < 0) continue;
    if (best === null || dur < best.dur) best = { dur, start: d.startTime ? toSecs(d.startTime) : null, end: d.endTime ? toSecs(d.endTime) : null };
  }
  return best;
}

// Fewer transfers win when they cost at most this much (later arrival, or
// for arrive-by an earlier leave).
export const XFER_SLACK = 600;
// A trip is out if another one gets there no later (arrive-by: leaves no
// earlier) and walks more than this much less. Keeps the long walks to a
// first stop that maxPreTransitTime=1800 allows from beating normal trips.
export const WALK_SLACK = 600;

export function walkSecs(it) {
  return (it.legs || []).filter((l) => !isTransit(l)).reduce((n, l) => n + legSecs(l), 0);
}

// Pick the itinerary to show.
// depart: drop trips beaten on walking (above); among the rest arriving
//   within 10 min of the earliest arrival, fewest transfers, then earliest
//   arrival, then least walking, then latest leave.
// arrive: among trips that arrive by t (or all, if none do), same walking
//   rule; then leaving within 10 min of the latest leave, fewest transfers,
//   then latest leave, then least walking.
export function chooseItinerary(its, mode, t) {
  const list = its.filter((it) => !cancelled(it) && it.startTime && it.endTime);
  if (!list.length) return { chosen: null, other: null };
  const leave = (it) => toSecs(it.startTime);
  const arr = (it) => toSecs(it.endTime);
  const xf = (it) => it.transfers ?? Math.max(0, (it.legs || []).filter(isTransit).length - 1);
  const w = new Map(list.map((it) => [it, walkSecs(it)]));
  // "b is at least as good on time" for the walking rule.
  const asGood = mode === 'arrive' ? (b, a) => leave(b) >= leave(a) : (b, a) => arr(b) <= arr(a);
  const fair = (pool) => pool.filter((a) => !pool.some((b) => b !== a && asGood(b, a) && w.get(b) < w.get(a) - WALK_SLACK));
  let chosen;
  if (mode === 'arrive') {
    const ok = list.filter((it) => arr(it) <= t);
    const pool = fair(ok.length ? ok : list);
    const latest = Math.max(...pool.map(leave));
    chosen = pool
      .filter((it) => leave(it) >= latest - XFER_SLACK)
      .sort((a, b) => xf(a) - xf(b) || leave(b) - leave(a) || w.get(a) - w.get(b) || arr(b) - arr(a))[0];
    const earlier = list.filter((it) => leave(it) < leave(chosen)).sort((a, b) => leave(b) - leave(a))[0];
    return { chosen, other: earlier ? `Earlier: ${hhmm(leave(earlier))}` : null };
  }
  const pool = fair(list);
  const fastest = Math.min(...pool.map(arr));
  chosen = pool
    .filter((it) => arr(it) <= fastest + XFER_SLACK)
    .sort((a, b) => xf(a) - xf(b) || arr(a) - arr(b) || w.get(a) - w.get(b) || leave(b) - leave(a))[0];
  const next = list.filter((it) => leave(it) > leave(chosen)).sort((a, b) => leave(a) - leave(b))[0];
  return { chosen, other: next ? `Next: ${hhmm(leave(next))}` : null };
}

// Stops (and routes) a rider actually uses: where they board and alight.
export function legStops(it) {
  const out = [];
  for (const leg of it.legs || []) {
    if (!isTransit(leg)) continue;
    const route = String(leg.routeId || '').replace(STOP_PREFIX, '') || String(leg.routeShortName || '');
    for (const p of [leg.from, leg.to]) {
      if (!p || !p.stopId) continue;
      out.push({ stopId: String(p.stopId).replace(STOP_PREFIX, ''), code: p.stopCode || '', route });
    }
  }
  return out;
}

export const MAX_REPLY = 600; // bytes; the watch handles this comfortably

// Build the reply object. `alerts` is the compact map from compactAlerts().
// `t` is the query time (depart: leave at, arrive: arrive by).
export function trimPlan(tq, { mode = 'depart', t, alerts = null, maxBytes = MAX_REPLY } = {}) {
  const its = Array.isArray(tq?.itineraries) ? tq.itineraries : [];
  const { chosen, other } = chooseItinerary(its, mode, t);
  const walk = bestWalk(tq);
  if (!chosen && !walk) return errorReply('No trips found');

  let w = null;
  if (walk) {
    const tt = Number.isFinite(t) ? t : null;
    if (mode === 'arrive') {
      const arr = tt ?? walk.end ?? walk.start + walk.dur;
      w = { leave: arr - walk.dur, arr, dur: walk.dur };
    } else {
      const leave = tt ?? walk.start ?? walk.end - walk.dur;
      w = { leave, arr: leave + walk.dur, dur: walk.dur };
    }
  }
  const busLeave = chosen ? toSecs(chosen.startTime) : 0;
  const busArr = chosen ? toSecs(chosen.endTime) : 0;
  // depart: walk if it gets there no later than the bus.
  // arrive: walk if you can leave no earlier than for the bus.
  const preferWalk = w && (!chosen || (mode === 'arrive' ? w.leave >= busLeave : w.arr <= busArr));

  if (preferWalk) {
    let next = null;
    if (chosen) next = mode === 'arrive' ? `Bus: leave ${hhmm(busLeave)}` : `Bus: arr ${hhmm(busArr)}`;
    return {
      v: 1,
      ok: true,
      leave: w.leave,
      arr: w.arr,
      rt: false,
      xfers: 0,
      lines: [`Walk ${mins(w.dur)} min`, `Arrive ${hhmm(w.arr)}`],
      alert: null,
      next,
    };
  }

  const legs = chosen.legs || [];
  let next = other;
  if (!next && w) next = mode === 'arrive' ? `Walk: leave ${hhmm(w.leave)}` : `Walk: arr ${hhmm(w.arr)}`;
  const reply = {
    v: 1,
    ok: true,
    leave: busLeave,
    arr: busArr,
    rt: legs.some((l) => isTransit(l) && l.realTime === true),
    xfers: chosen.transfers ?? Math.max(0, legs.filter(isTransit).length - 1),
    lines: [],
    alert: alerts ? alertFor(legStops(chosen), alerts) : null,
    next,
  };
  const items = itineraryItems(chosen, alerts);
  if (reply.xfers > 0) items.push(...altItems(its, chosen));
  reply.lines = compactItems(items, (lines) => byteLen({ ...reply, lines }) <= maxBytes);
  return reply;
}

// When the chosen trip has transfers but a one-bus trip exists (it was not
// chosen because it arrives over 10 min later), two short optional lines:
// "Direct 9 05:58", "arr 06:11".
function altItems(its, chosen) {
  const one = its
    .filter((it) => it !== chosen && !cancelled(it) && it.startTime && it.endTime && (it.legs || []).filter(isTransit).length === 1)
    .sort((a, b) => toSecs(a.endTime) - toSecs(b.endTime))[0];
  if (!one) return [];
  const leg = one.legs.find(isTransit);
  const { variant } = splitHeadsign(leg.headsign, routeLabel(leg));
  return [
    { k: 'alt', t: clip(`Direct ${variant} ${hhmm(toSecs(leg.startTime))}`) },
    { k: 'alt', t: `arr ${hhmm(toSecs(one.endTime))}` },
  ];
}

function byteLen(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

export function errorReply(err) {
  return { v: 1, ok: false, err };
}

// ---- LTC GTFS-RT alerts ---------------------------------------------------

const DIRS = { north: 'N', south: 'S', east: 'E', west: 'W' };

function tr(textObj) {
  const list = textObj?.translation || [];
  const en = list.find((x) => !x.language || /^en/i.test(x.language)) || list[0];
  return en?.text ? String(en.text) : '';
}

// Short, display-ready detail from a stop-closure description, or ''.
export function alertDetail(desc) {
  const d = String(desc || '');
  let m = d.match(/(\d+)\s*m(?:etres|eters)?\.?\s+(north|south|east|west)/i);
  if (m) return `temp stop ${m[1]}m ${DIRS[m[2].toLowerCase()]}`;
  m = d.match(/(\d+)(?:st|nd|rd|th)?\s+poles?\s+(north|south|east|west)/i);
  if (m) {
    const n = Number(m[1]);
    return `temp stop ${n} pole${n > 1 ? 's' : ''} ${DIRS[m[2].toLowerCase()]}`;
  }
  m = d.match(/(?:can be found at|alternate stops?[^:]*:)\s*:?\s*([^\r\n(]+)/i);
  if (m && m[1].trim()) return `use ${m[1].trim()}`;
  return '';
}

function activeNow(alert, now) {
  const periods = alert.active_period || alert.activePeriod || [];
  if (!periods.length) return true;
  return periods.some((p) => {
    const s = Number(p.start || 0);
    const e = Number(p.end || 0);
    return (!s || now >= s) && (!e || now <= e);
  });
}

// Alerts.json -> { STOPID: [{ r: routeId or "", k: "closed"|"detour", d: detail }] }.
// Accepts snake_case (LTC's feed) and camelCase (protobuf JSON) field names.
export function compactAlerts(feed, now) {
  const map = {};
  for (const ent of feed?.entity || []) {
    const a = ent.alert;
    if (!a || ent.is_deleted || ent.isDeleted || !activeNow(a, now)) continue;
    const header = tr(a.header_text || a.headerText);
    const desc = tr(a.description_text || a.descriptionText);
    const effect = a.effect;
    const closed =
      /clos/i.test(header) || /closed/i.test(desc) || effect === 1 || effect === 9 || effect === 'NO_SERVICE' || effect === 'STOP_MOVED';
    const item = { r: '', k: closed ? 'closed' : 'detour', d: alertDetail(desc) };
    for (const ie of a.informed_entity || a.informedEntity || []) {
      const stop = ie.stop_id || ie.stopId;
      if (!stop) continue;
      const r = String(ie.route_id || ie.routeId || '');
      (map[stop] ||= []).push({ ...item, r });
    }
  }
  return map;
}

// First alert that hits a boarding/alighting stop (route-specific alerts
// only count for that route).
export function alertFor(stops, map) {
  for (const s of stops) {
    const hits = map[s.stopId];
    if (!hits) continue;
    const hit = hits.find((h) => !h.r || !s.route || h.r === s.route) || null;
    if (!hit) continue;
    const tag = s.code ? `#${s.code}` : s.stopId;
    if (hit.k === 'closed') {
      return hit.d ? clipWords(`${tag} closed: ${hit.d}`, MAX_ALERT) : `${tag} closed - check LTC`;
    }
    return hit.d ? clipWords(`${tag} detour: ${hit.d}`, MAX_ALERT) : `${tag} detour - check LTC`;
  }
  return null;
}
