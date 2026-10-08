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
  h = h.replace(/\s+via\s+.*$/i, '').replace(/^express\s+to\s+/i, '').trim();
  return { variant, to: h };
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

export function itineraryLines(it) {
  const lines = [];
  const legs = it.legs || [];
  lines.push(`Leave ${hhmm(toSecs(it.startTime))}`);
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (isTransit(leg)) {
      const route = routeLabel(leg);
      const { variant, to } = splitHeadsign(leg.headsign, route);
      const kind = leg.mode === 'BUS' ? 'Bus' : leg.mode[0] + leg.mode.slice(1).toLowerCase();
      let bus = `${kind} ${variant} ${hhmm(toSecs(leg.startTime))}`;
      if (leg.realTime && (bus + ' live').length <= MAX_LINE) bus += ' live';
      lines.push(clip(bus));
      if (to) lines.push(clip(`to ${to}`));
      lines.push(clip(`Off ${stopTag(leg.to)} ${hhmm(toSecs(leg.endTime))}`));
    } else {
      const next = legs[i + 1];
      if (next && isTransit(next)) {
        const prev = legs[i - 1];
        const sameStop = prev && prev.to?.stopId && prev.to.stopId === next.from?.stopId;
        if (!sameStop) lines.push(clip(`Walk ${mins(leg.duration)}m to ${stopTag(next.from)}`));
      } else if (!next && i === 0) {
        lines.push(clip(`Walk ${mins(leg.duration)}m`));
      }
    }
  }
  lines.push(`Arrive ${hhmm(toSecs(it.endTime))}`);
  return lines;
}

// Pick the itinerary to show.
// depart: earliest arrival, then fewer transfers, then latest leave.
// arrive: latest leave that still arrives by t, then fewer transfers.
export function chooseItinerary(its, mode, t) {
  const list = its.filter((it) => !cancelled(it) && it.startTime && it.endTime);
  if (!list.length) return { chosen: null, other: null };
  const leave = (it) => toSecs(it.startTime);
  const arr = (it) => toSecs(it.endTime);
  let chosen;
  if (mode === 'arrive') {
    const ok = list.filter((it) => arr(it) <= t);
    const pool = ok.length ? ok : list;
    chosen = [...pool].sort((a, b) => leave(b) - leave(a) || (a.transfers ?? 0) - (b.transfers ?? 0))[0];
    const earlier = list.filter((it) => leave(it) < leave(chosen)).sort((a, b) => leave(b) - leave(a))[0];
    return { chosen, other: earlier ? `Earlier: ${hhmm(leave(earlier))}` : null };
  }
  chosen = [...list].sort(
    (a, b) => arr(a) - arr(b) || (a.transfers ?? 0) - (b.transfers ?? 0) || leave(b) - leave(a),
  )[0];
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

// Build the reply object. `alerts` is the compact map from compactAlerts().
export function trimPlan(tq, { mode = 'depart', t, alerts = null } = {}) {
  const its = Array.isArray(tq?.itineraries) ? tq.itineraries : [];
  const { chosen, other } = chooseItinerary(its, mode, t);
  if (!chosen) return errorReply('No trips found');
  const legs = chosen.legs || [];
  const reply = {
    v: 1,
    ok: true,
    leave: toSecs(chosen.startTime),
    arr: toSecs(chosen.endTime),
    rt: legs.some((l) => isTransit(l) && l.realTime === true),
    xfers: chosen.transfers ?? Math.max(0, legs.filter(isTransit).length - 1),
    lines: itineraryLines(chosen).slice(0, 12),
    alert: alerts ? alertFor(legStops(chosen), alerts) : null,
    next: other,
  };
  return reply;
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
