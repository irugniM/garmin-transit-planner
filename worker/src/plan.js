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

// Walk minutes always say "min" (never "m", which reads as metres):
// "Walk 3 min to #509", "Walk 3 min #1142" when "to" would pass 18
// characters, "Walk 6 min to stop", or just "Walk 12 min" (the stop's name
// line follows).
function walkTo(secs, tag) {
  const w = `Walk ${mins(secs)} min`;
  for (const t of [`${w} to ${tag}`, tag === 'stop' ? w : `${w} ${tag}`]) if (t.length <= MAX_LINE) return t;
  return w;
}

// "09" -> "9", "102" stays.
export function routeLabel(leg) {
  const r = String(leg.routeShortName ?? leg.displayName ?? '?');
  return r.replace(/^0+(?=\w)/, '');
}

// "13A White Oaks Mall via Westminster Park" -> { variant: "13A", to: "White Oaks Mall" }
export function splitHeadsign(headsign, route) {
  let h = unparen(headsign); // "London (Downtown)" -> "London Dtwn"
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

// "#1234", or "stop" for a stop without a code (its name goes on the next
// line, so times and walk minutes are never cut for a long name).
function stopTag(place) {
  if (place && place.stopCode) return `#${place.stopCode}`;
  return 'stop';
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
//   bus only), board ("Walk 6 min to #509", "Walk 6 min #1234" when "to"
//   doesn't fit, or "Board at #1234"), bus, to
//   (headsign), off, walkEnd (walk after the last bus), walk (walk-only
//   trip), arrive, name (the boarding stop's name, right after its board
//   line: "Sarnia/Western WB"), offname (the same for an Off stop;
//   droppable, except when the next bus leaves from that very stop),
//   closed (right after the board/Off line, or its name line, when that stop
//   is closed for the route: "Temp stop 130m W", "Use Althouse", or
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
      const board = walked && walkSecs > 0 ? walkTo(walkSecs, stopTag(from)) : `Board at ${stopTag(from)}`;
      out.push({ k: 'board', t: clip(board), n: busNo });
      const name = stopName(from);
      if (name) out.push({ k: 'name', t: name, n: busNo });
    } else {
      // The Off stop's name above is now the boarding stop's: keep it.
      const prev = out.findLast((x) => x.k === 'offname');
      if (prev) prev.k = 'name';
    }
    // Boarding stop closed for this route: say where the temporary stop is
    // (for a same-stop transfer, unless the Off line above already did).
    const shut = closureLine(from, route, alerts);
    if (shut && !(sameStop && out.at(-1)?.k === 'closed')) out.push({ k: 'closed', t: shut, n: busNo });
    const { variant, to } = splitHeadsign(leg.headsign, routeLabel(leg));
    const kind = leg.mode === 'BUS' ? 'Bus' : leg.mode[0] + leg.mode.slice(1).toLowerCase();
    // The departure time always shows: "Coach FlixBus 2702 13:55" is too
    // long, so "FlixBus 2702 13:55" (or the route cut to fit).
    const at = hhmm(toSecs(leg.startTime));
    let bus = `${kind} ${variant} ${at}`;
    if (bus.length > MAX_LINE) bus = `${cutTo(String(variant), MAX_LINE - at.length - 1)} ${at}`;
    if (leg.realTime && (bus + ' live').length <= MAX_LINE) bus += ' live';
    out.push({ k: 'bus', t: clip(bus), n: busNo });
    if (to) out.push({ k: 'to', t: destLine(to), n: busNo, of: nBus });
    const coded = Boolean(leg.to?.stopCode);
    out.push({ k: 'off', t: clip(coded ? `Off #${leg.to.stopCode} ${hhmm(toSecs(leg.endTime))}` : `Off ${hhmm(toSecs(leg.endTime))}`), n: busNo });
    // Without a code the name is the only thing saying where: must-keep.
    const offName = stopName(leg.to);
    if (offName) out.push({ k: coded ? 'offname' : 'name', t: offName, n: busNo });
    const shutOff = closureLine(leg.to, route, alerts);
    if (shutOff) out.push({ k: 'closed', t: shutOff, n: busNo });
    lastOff = leg.to?.stopId || null;
    busNo++;
    walked = false;
    walkSecs = 0;
  }
  if (walked) out.push({ k: busNo ? 'walkEnd' : 'walk', t: clip(`Walk ${mins(walkSecs)} min`) });
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

// Stop names as Transitous gives them -> at most 18 chars, shaped
// "Main/Cross DIR": "Richmond at University SB - #1513" -> "Richmond/Univ SB",
// "Richmond between Oxford & Central NB" -> "Richmond/Oxford NB".
// The direction (NB/SB/EB/WB) is always kept: its room is reserved first.
// Then: common abbreviations; more abbreviations and dropped street types
// only when still too long; then letters cut off the main street (6 kept),
// then off the cross street (4 kept). null when there's no real name (empty,
// or just the stop code).
const ABBR = [
  [/\bRoad\b/gi, 'Rd'], [/\bStreet\b/gi, 'St'], [/\bAvenue\b/gi, 'Av'], [/\bDrive\b/gi, 'Dr'],
  [/\bCrescent\b/gi, 'Cr'], [/\bBoulevard\b/gi, 'Blvd'], [/\bCourt\b/gi, 'Ct'], [/\bPlace\b/gi, 'Pl'],
  [/\bParkway\b/gi, 'Pkwy'], [/\bTerrace\b/gi, 'Ter'], [/\bLane\b/gi, 'Ln'], [/\bGate\b/gi, 'Gt'],
  [/\bSquare\b/gi, 'Sq'], [/\bHighway\b/gi, 'Hwy'], [/\bMount\b/gi, 'Mt'], [/\bSaint\b/gi, 'St'],
];
// Only when the name is still too long.
const ABBR_MORE = [
  [/\bUniver?sit?y\b|\bUniverstiy\b/gi, 'Univ'], [/\bHospital\b/gi, 'Hosp'], [/\bDowntown\b/gi, 'Dtwn'],
  [/\bCent(re|er)\b/gi, 'Ctr'], [/\bCollege\b/gi, 'Coll'], [/\bTerminal\b/gi, 'Term'], [/\bStation\b/gi, 'Stn'],
  [/\bMall\b/gi, 'Mall'], [/\bNorth\b/g, 'N'], [/\bSouth\b/g, 'S'], [/\bEast\b/g, 'E'], [/\bWest\b/g, 'W'],
];
const STREET_TYPE = /\s+(St|Rd|Av|Dr|Cr|Blvd|Ct|Pl|Ln|Ter|Pkwy|Gt|Sq)(?=\s+[NSEW]$|$)/g;
const REL = { north: 'N', south: 'S', east: 'E', west: 'W', n: 'N', s: 'S', e: 'E', w: 'W' };

// "Kitchener (Downtown)" -> "Kitchener Dtwn"; other parentheses just go.
export function unparen(text) {
  return String(text || '')
    .replace(/\(\s*downtown\s*\)/gi, 'Dtwn')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const squash = (x) => String(x || '').replace(/\s+/g, ' ').trim();
const cutTo = (x, n) => (x.length <= n ? x : x.slice(0, n).replace(/[\s&/-]+$/, ''));

export function stopName(place, max = MAX_LINE) {
  const code = String(place?.stopCode || '').trim();
  let s = unparen(String(place?.name || '').replace(/\s+-\s*#\s*\w+\s*$/, ''));
  let dir = '';
  const m = s.match(/\s+([NSEW]B)$/);
  if (m) {
    dir = m[1];
    s = s.slice(0, m.index).trim();
  }
  if (!s || /^#?\d+$/.test(s) || (code && s.replace(/^#\s*/, '') === code)) return null;
  s = squash(
    s
      .replace(/\s+(?:at\s+)?Stop\s*#?\s*(\d+)\b/gi, ' $1') // "Mall at Stop 2" -> "Mall 2"
      .replace(/\bStop\b/gi, ' '),
  );
  // Main street and first cross street.
  let main = s;
  let cross = '';
  let rel = '';
  let p;
  if ((p = s.match(/^(.+?)\s+between\s+(.+?)\s+(?:&|and)\s+.+$/i))) [, main, cross] = p;
  else if ((p = s.match(/^(.+?)\s+(north|south|east|west|[NSEW])\s+of\s+(.+)$/i))) {
    [, main, , cross] = p;
    rel = `${REL[p[2].toLowerCase()]} of`;
  } else if ((p = s.match(/^(.+?)\s+(?:at|&|near|opposite|opp\.?)\s+(.+)$/i))) [, main, cross] = p;
  else if ((p = s.match(/^(.+?)\s*\/\s*(.+)$/))) [, main, cross] = p; // "Charles / Water"
  main = squash(main);
  cross = squash(cross);
  for (const [re, to] of ABBR) {
    main = main.replace(re, to);
    cross = cross.replace(re, to);
  }
  const room = max - (dir ? dir.length + 1 : 0);
  const join = () => (cross ? `${main}/${cross}` : main);
  const done = (x) => (dir ? `${x} ${dir}` : x);
  // "Richmond S of Queens" when it fits, else "Richmond/Queens".
  if (rel && `${main} ${rel} ${cross}`.length <= room) return done(`${main} ${rel} ${cross}`);
  if (join().length <= room) return done(join());
  for (const [re, to] of ABBR_MORE) {
    main = main.replace(re, to);
    cross = cross.replace(re, to);
  }
  if (join().length > room) {
    main = squash(main.replace(STREET_TYPE, '')) || main;
    cross = squash(cross.replace(STREET_TYPE, '')) || cross;
  }
  if (join().length <= room) return done(join());
  if (!cross) return done(cutTo(main, room));
  // Cut the main street (keep 6+ letters), then the cross street (keep 4+).
  const full = main;
  const over = join().length - room;
  main = cutTo(main, Math.max(Math.min(main.length, 6), main.length - over));
  if (join().length > room) cross = cutTo(cross, Math.max(4, room - main.length - 1));
  // Give back main-street letters the cross-street cut left room for (or
  // take more if a cut ended on a space).
  main = cutTo(full, Math.max(1, room - cross.length - 1));
  return done(join());
}

export function xferText(n) {
  if (!n) return 'No transfer';
  return n === 1 ? '1 transfer' : `${n} transfers`;
}

export function itineraryLines(it) {
  return itineraryItems(it).map((x) => x.t);
}

// Drop order when a reply is over budget: the walk alternative, the
// no-transfer alternative, headsign lines (middle legs first,
// the first leg's last), Off stop names, then the Leave line (the watch shows
// the leave time in its header anyway). The transfer count, Board and its
// stop name, Bus, Off, closed-stop notes, the last walk and Arrive are never
// dropped.
function dropRank(x) {
  if (x.k === 'walkalt') return -2;
  if (x.k === 'alt') return -1;
  if (x.k === 'to') return x.n === 0 ? 2 : x.n === x.of - 1 ? 1 : 0;
  if (x.k === 'offname') return 2.5;
  if (x.k === 'leave') return 3;
  return Infinity;
}

// Remove droppable lines (middle first) until fits(lines) is true. A line
// that repeats the one just above it ("London Dtwn" as a headsign and then
// as the stop) goes first, keeping the stronger of the two kinds.
export function compactItems(items, fits) {
  let list = [];
  for (const x of items) {
    const prev = list.at(-1);
    if (prev && prev.t === x.t) {
      if (dropRank(x) > dropRank(prev)) list[list.length - 1] = x;
      continue;
    }
    list.push(x);
  }
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
    // An alternative's lines go together.
    const drop = list[best];
    list = list.filter((x, i) => i !== best && !((drop.k === 'alt' || drop.k === 'walkalt') && x.k === drop.k));
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

export function hereReply(now, to = null) {
  return { v: 1, ok: true, leave: now, arr: now, rt: false, xfers: 0, lines: ["You're here"], alert: null, next: null, pts: ptsFor(null, to) };
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
// ---- near home: unrealistic detour walks to the first stop -----------------
// From home, Transitous sometimes routes the walk to a stop ~100 m away as a
// ~500 m detour, which makes "Leave" minutes too early and hides buses that
// are still catchable. Near HOME_LATLON (a Worker secret) the query is made
// NEAR_SHIFT earlier (depart), such first walks are replaced by a
// straight-line estimate, and trips you could no longer catch are dropped.
export const NEAR_HOME_M = 150;
export const NEAR_SHIFT = 300; // seconds
export const DETOUR_FACTOR = 3; // routed walk over 3x the straight line...
export const DETOUR_MAX_STRAIGHT = 300; // ...to a stop under 300 m away
export const WALK_SPEED = 1.2; // m/s
export const STRAIGHT_FACTOR = 1.3; // straight line to street distance
export const MIN_FIRST_WALK = 120; // seconds

const isoOf = (secs) => new Date(secs * 1000).toISOString().replace('.000Z', 'Z');

function walkDistance(leg) {
  const d = Number(leg.distance);
  if (Number.isFinite(d) && leg.distance !== null) return d;
  const steps = Array.isArray(leg.steps) ? leg.steps : [];
  const sum = steps.reduce((n, st) => n + (Number(st?.distance) || 0), 0);
  return steps.length && sum > 0 ? sum : null;
}

// The itinerary with its first walk replaced, or the same object when the
// rule doesn't apply. `origin` is the request position { lat, lon }.
export function fixFirstWalk(it, origin) {
  const legs = it?.legs || [];
  const k = legs.findIndex(isTransit);
  if (k < 1 || legs.slice(0, k).some((l) => l.mode !== 'WALK')) return it;
  const bus = legs[k];
  const stop = bus.from;
  if (!bus.startTime || !stop || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lon)) ||
      stop.lat === null || stop.lon === null) return it;
  const routed = legs.slice(0, k).reduce((n, l) => (n === null ? null : (walkDistance(l) === null ? null : n + walkDistance(l))), 0);
  if (routed === null) return it;
  const straight = metres(origin, { lat: Number(stop.lat), lon: Number(stop.lon) });
  if (!(straight < DETOUR_MAX_STRAIGHT && routed > DETOUR_FACTOR * straight)) return it;
  const walk = Math.max(MIN_FIRST_WALK, Math.ceil((straight * STRAIGHT_FACTOR) / WALK_SPEED));
  const dep = toSecs(bus.startTime);
  const leave = dep - walk;
  const first = legs[0];
  const walkLeg = {
    ...first,
    to: legs[k - 1].to,
    startTime: isoOf(leave),
    endTime: isoOf(dep),
    duration: walk,
    distance: Math.round(straight * STRAIGHT_FACTOR),
    estimated: true,
  };
  delete walkLeg.steps;
  delete walkLeg.legGeometry;
  if (walkLeg.scheduledStartTime) walkLeg.scheduledStartTime = walkLeg.startTime;
  if (walkLeg.scheduledEndTime) walkLeg.scheduledEndTime = walkLeg.endTime;
  const end = it.endTime ? toSecs(it.endTime) : null;
  return {
    ...it,
    startTime: isoOf(leave),
    ...(end !== null ? { duration: end - leave } : {}),
    legs: [walkLeg, ...legs.slice(k)],
  };
}

// Near home: fix first walks; for depart queries (time shifted earlier by
// NEAR_SHIFT) drop trips that would mean leaving before `t`.
export function nearHomePlan(tq, origin, mode, t) {
  if (!tq || !Array.isArray(tq.itineraries)) return tq;
  let its = tq.itineraries.map((it) => fixFirstWalk(it, origin));
  if (mode !== 'arrive') its = its.filter((it) => !it.startTime || toSecs(it.startTime) >= t);
  return { ...tq, itineraries: its };
}

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
  // First bus departure. "Next bus" is the first one strictly after the
  // chosen trip's first bus, from a trip leaving no earlier; "Earlier bus"
  // (arrive-by) the last one strictly before it, from a trip leaving no later.
  const dep = (it) => {
    const l = (it.legs || []).find(isTransit);
    return l?.startTime ? toSecs(l.startTime) : null;
  };
  let chosen;
  if (mode === 'arrive') {
    const ok = list.filter((it) => arr(it) <= t);
    const pool = fair(ok.length ? ok : list);
    const latest = Math.max(...pool.map(leave));
    chosen = pool
      .filter((it) => leave(it) >= latest - XFER_SLACK)
      .sort((a, b) => xf(a) - xf(b) || leave(b) - leave(a) || w.get(a) - w.get(b) || arr(b) - arr(a))[0];
    const c0 = dep(chosen);
    const earlier = c0 === null ? null : list.filter((it) => dep(it) !== null && dep(it) < c0 && leave(it) <= leave(chosen)).sort((a, b) => dep(b) - dep(a))[0];
    return { chosen, other: earlier ? `Earlier bus ${hhmm(dep(earlier))}` : null };
  }
  const pool = fair(list);
  const fastest = Math.min(...pool.map(arr));
  chosen = pool
    .filter((it) => arr(it) <= fastest + XFER_SLACK)
    .sort((a, b) => xf(a) - xf(b) || arr(a) - arr(b) || w.get(a) - w.get(b) || leave(b) - leave(a))[0];
  const c0 = dep(chosen);
  const next = c0 === null ? null : list.filter((it) => dep(it) !== null && dep(it) > c0 && leave(it) >= leave(chosen)).sort((a, b) => dep(a) - dep(b))[0];
  return { chosen, other: next ? `Next bus ${hhmm(dep(next))}` : null };
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

export const MAX_REPLY = 600; // bytes; above this, optional lines are dropped
// Hard cap: when the must-keep lines alone are over this (very long trips),
// the reply is an error instead. The simulator read 8 KB fine.
export const HARD_MAX = 1200;

const r5 = (x) => Math.round(Number(x) * 1e5) / 1e5;
const ll = (p) => (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && p.lat !== null && p.lon !== null
  ? [r5(p.lat), r5(p.lon)] : null);

// For the watch's arrow: { s: first boarding stop [lat, lon], t: that bus's
// departure (unix secs), k: "<route>@<scheduled departure>" naming that bus
// (the watch's auto-refresh compares it to tell "same trip, new times" from
// "a different trip"), d: destination [lat, lon] }. s/t/k only when the
// answer is a bus trip; null when there's nothing to point at.
export function ptsFor(chosen, to) {
  const out = {};
  const leg = chosen ? (chosen.legs || []).find(isTransit) : null;
  const s = ll(leg?.from);
  if (s && leg.startTime) {
    out.s = s;
    out.t = toSecs(leg.startTime);
    const route = String(leg.routeShortName ?? leg.displayName ?? '?').slice(0, 8);
    out.k = `${route}@${toSecs(leg.scheduledStartTime || leg.startTime)}`;
  }
  const d = ll(to);
  if (d) out.d = d;
  return Object.keys(out).length ? out : null;
}

// Build the reply object. `alerts` is the compact map from compactAlerts().
// Optional lines go above `maxBytes`; still over `hardMax`: "Trip too long".
// `t` is the query time (depart: leave at, arrive: arrive by).
// `to` is the destination { lat, lon } (for `pts`).
export function trimPlan(tq, { mode = 'depart', t, alerts = null, maxBytes = MAX_REPLY, hardMax = HARD_MAX, to = null } = {}) {
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
  const preferWalk = w && (!chosen || walkWins(w, { mode, t, busLeave, busArr }));

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
      pts: ptsFor(null, to),
    };
  }

  const legs = chosen.legs || [];
  // `next` is only "Next bus"/"Earlier bus". A walk that lost is two
  // optional last lines ("Or walk 25 min", "arr 16:40") when it is a real
  // alternative (gets there at most 10 min after the bus; arrive-by: leaves
  // at most 10 min before it), or when there is no next bus to show.
  const next = other;
  const walkLine = w && (!next || (mode === 'arrive' ? w.leave >= busLeave - WALK_ALT : w.arr <= busArr + WALK_ALT));
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
    pts: ptsFor(chosen, to),
  };
  const items = itineraryItems(chosen, alerts);
  if (reply.xfers > 0) items.push(...altItems(its, chosen, mode, t));
  if (walkLine) items.push(...walkNote(w, mode).map((t) => ({ k: 'walkalt', t })));
  reply.lines = compactItems(items, (lines) => byteLen({ ...reply, lines }) <= maxBytes);
  if (byteLen(reply) > hardMax) return errorReply('Trip too long');
  return reply;
}

// When the chosen trip has transfers but a one-bus trip exists (not chosen
// because it arrives over 10 min later, or walks over 10 min more), two
// short optional lines: "Direct 9 05:58", "arr 06:11" (plus "walk 22 min"
// when the walking is what ruled it out). They are dropped together.
function altItems(its, chosen, mode, t) {
  const one = its
    .filter((it) => it !== chosen && !cancelled(it) && it.startTime && it.endTime && (it.legs || []).filter(isTransit).length === 1)
    .filter((it) => mode !== 'arrive' || !Number.isFinite(t) || toSecs(it.endTime) <= t)
    .sort((a, b) => toSecs(a.endTime) - toSecs(b.endTime) || walkSecs(a) - walkSecs(b))[0];
  if (!one) return [];
  const leg = one.legs.find(isTransit);
  const { variant } = splitHeadsign(leg.headsign, routeLabel(leg));
  const w = walkSecs(one);
  const out = [
    { k: 'alt', t: clip(`Direct ${variant} ${hhmm(toSecs(leg.startTime))}`) },
    { k: 'alt', t: `arr ${hhmm(toSecs(one.endTime))}` },
  ];
  if (w - walkSecs(chosen) > WALK_SLACK) out.push({ k: 'alt', t: `walk ${mins(w)} min` });
  return out;
}

// Walk-only vs the chosen bus trip.
// Walks up to 20 min: the walk wins if it gets there no later (arrive-by:
// lets you leave no earlier).
// Longer walks win only if they get there at least 15 min earlier (arrive-by:
// leave 15 min later), or no bus gets there within 90 min of t (arrive-by:
// the bus would be late, or gets there over 90 min early), e.g. at night.
export const LONG_WALK = 1200;
export const WALK_ALT = 600;
export const LONG_WALK_GAIN = 900;
export const BUS_HORIZON = 5400;

export function walkWins(w, { mode, t, busLeave, busArr }) {
  const tt = Number.isFinite(t) ? t : mode === 'arrive' ? w.arr : w.leave;
  if (mode === 'arrive') {
    if (w.dur <= LONG_WALK) return w.leave >= busLeave;
    return w.leave >= busLeave + LONG_WALK_GAIN || busArr > tt || busArr < tt - BUS_HORIZON;
  }
  if (w.dur <= LONG_WALK) return w.arr <= busArr;
  return w.arr <= busArr - LONG_WALK_GAIN || busArr > tt + BUS_HORIZON;
}

// The walk as an option after a bus trip, two lines that are dropped
// together: "Or walk 25 min", "arr 16:40" (arrive-by: "lv 07:40").
export function walkNote(w, mode) {
  return [`Or walk ${mins(w.dur)} min`, mode === 'arrive' ? `lv ${hhmm(w.leave)}` : `arr ${hhmm(w.arr)}`];
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
