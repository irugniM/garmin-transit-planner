import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toSecs } from '../src/plan.js';
import {
  alertDetail, alertFor, bestWalk, compactAlerts, compactItems, hereReply, hhmm, itineraryLines, legStops, metres, splitHeadsign,
  trimPlan, HERE_M, MAX_LINE, MAX_REPLY,
} from '../src/plan.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
// One itinerary of a fixture on its own.
const only = (n, i) => { const tq = fx(n); return { ...tq, itineraries: [tq.itineraries[i]] }; };
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const NOW = at('2026-10-08T07:55:00-04:00');
const ALERTS = compactAlerts(fx('alerts_handmade'), NOW);

function checkShape(r) {
  assert.equal(r.v, 1);
  assert.equal(r.ok, true);
  assert.equal(typeof r.leave, 'number');
  assert.equal(typeof r.arr, 'number');
  assert.equal(typeof r.rt, 'boolean');
  assert.equal(typeof r.xfers, 'number');
  assert.ok(Array.isArray(r.lines) && r.lines.length >= 1);
  for (const l of r.lines) assert.ok(typeof l === 'string' && l.length <= MAX_LINE, `line too long: "${l}"`);
  if (r.next !== null) assert.ok(r.next.length <= MAX_LINE, `next too long: "${r.next}"`);
  assert.deepEqual(Object.keys(r), ['v', 'ok', 'leave', 'arr', 'rt', 'xfers', 'lines', 'alert', 'next']);
}

// Every bus line has a line naming its boarding stop just before it (a walk
// or "Board at"), or follows an Off at that same stop; each bus has an Off.
// The stop's name and a closure note may sit in between.
function checkBoarding(lines) {
  lines.forEach((l, i) => {
    if (!/^Bus /.test(l)) return;
    let j = i - 1;
    while (j >= i - 2 && j >= 0 && !/^(Walk|Board at|Off|Bus|Leave|No transfer|\d+ transfers?$)/.test(lines[j])) j--;
    const prev = lines[j] || '';
    assert.ok(/^(Walk \d+m to |Board at |Off )/.test(prev), `no boarding stop before "${l}" in ${JSON.stringify(lines)}`);
  });
  assert.equal(lines.filter((l) => /^Bus /.test(l)).length, lines.filter((l) => /^Off /.test(l)).length);
}

test('hhmm uses America/Toronto', () => {
  assert.equal(hhmm(at('2026-10-08T12:01:00Z')), '08:01');
  assert.equal(hhmm(at('2026-12-01T05:30:00Z')), '00:30'); // EST, UTC-5
});

test('splitHeadsign drops variant prefix, via and Express', () => {
  assert.deepEqual(splitHeadsign('13A White Oaks Mall via Westminster Park', '13'), { variant: '13A', to: 'White Oaks Mall' });
  assert.deepEqual(splitHeadsign('Capulet Lane via Western University', '27'), { variant: '27', to: 'Capulet Lane' });
  assert.deepEqual(splitHeadsign('Express to Masonville Mall', '90'), { variant: '90', to: 'Masonville Mall' });
});

test('trim: to school with a transfer and a closure alert at the stop you get off', () => {
  const r = trimPlan(only('masonville_to_school_0800', 0), { mode: 'depart', t: at('2026-10-08T08:00:00-04:00'), alerts: ALERTS });
  checkShape(r);
  assert.equal(hhmm(r.leave), '08:01');
  assert.equal(hhmm(r.arr), '08:26');
  assert.equal(r.xfers, 1);
  assert.equal(r.rt, false);
  assert.deepEqual(r.lines, [
    'Leave 08:01', '1 transfer', 'Walk 1m to #1143', 'Masonville Pl 4', 'Bus 13A 08:02', 'to White Oaks Mall', 'Off #509 08:11',
    'Delaware Hall SB', 'Walk 2m to #1173', 'Talbot College', 'Bus 27 08:15', 'to Capulet Lane', 'Off #1647 08:23',
    'Sarnia/Western WB', 'Temp stop 130m W', 'Walk 3m', 'Arrive 08:26',
  ]);
  assert.equal(r.alert, '#1647 closed: temp stop 130m W');
  assert.equal(r.next, null);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (1 transfer + alert): ${bytes}`);
  assert.ok(bytes < 450, `reply ${bytes} B`);
});

test('trim: from school, transfer at a different stop, Express headsign', () => {
  const r = trimPlan(only('school_to_masonville_1600', 0), { mode: 'depart', t: at('2026-10-08T16:00:00-04:00'), alerts: ALERTS });
  checkShape(r);
  assert.deepEqual(r.lines.slice(0, 4), ['Leave 16:04', '1 transfer', 'Walk 1m to #1646', 'Sarnia/Western EB']);
  assert.deepEqual(r.lines.slice(r.lines.indexOf('Walk 2m to #1512'), r.lines.indexOf('Walk 2m to #1512') + 2), ['Walk 2m to #1512', 'Richmond/Univ NB']);
  assert.ok(r.lines.includes('to Masonville Mall'));
  // UNIVRIC1 has a detour alert for route 27 (alighting stop of leg 1).
  assert.equal(r.alert, '#1818 detour: temp stop 2 poles S');
  assert.equal(r.next, null);
});

test('trim: depart picks earliest arrival when it has the fewest transfers', () => {
  const r = trimPlan(fx('natsci_to_whiteoaks_1200'), { mode: 'depart', t: at('2026-10-08T12:00:00-04:00'), alerts: {} });
  checkShape(r);
  assert.equal(hhmm(r.leave), '12:07');
  assert.equal(r.xfers, 0);
  assert.equal(r.alert, null);
  // The 12:09 and 12:11 trips catch buses before the chosen 12:19 one;
  // the next bus is the 12:34.
  assert.equal(r.next, 'Next bus 12:34');
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (direct, no alert): ${bytes}`);
});

test('trim: arrive-by picks a late leave that arrives in time; same-stop transfer has no walk line', () => {
  // Latest leave is 12:11 with a transfer; 12:09 is a single bus (2 min
  // earlier), so it wins.
  const d = trimPlan(fx('natsci_to_whiteoaks_arrive1300'), { mode: 'arrive', t: at('2026-10-08T13:00:00-04:00'), alerts: null });
  checkShape(d);
  assert.equal(hhmm(d.leave), '12:09');
  assert.equal(d.xfers, 0);
  assert.equal(d.lines[1], 'No transfer');
  assert.ok(d.arr <= at('2026-10-08T13:00:00-04:00'));
  // The latest bus before the chosen 12:15 one, from a trip leaving no
  // later (the 12:12 transfer trip leaves at 12:11).
  assert.equal(d.next, 'Earlier bus 12:04');
  const r = trimPlan(only('natsci_to_whiteoaks_arrive1300', 3), { mode: 'arrive', t: at('2026-10-08T13:00:00-04:00'), alerts: null });
  checkShape(r);
  assert.equal(hhmm(r.leave), '12:11');
  assert.equal(r.xfers, 1);
  // Walk to the first stop and the final walk; none at the same-stop transfer.
  assert.deepEqual(r.lines.filter((l) => l.startsWith('Walk')), ['Walk 1m to #1222', 'Walk 3m']);
  assert.ok(!r.lines.some((l) => l.startsWith('Board')), 'Off #1521 already names the transfer stop');
  // ...and its name line is now the boarding stop's, so it is must-keep.
  assert.deepEqual(r.lines.slice(6, 9), ['Off #1521 12:16', 'Richmo/Winderme SB', 'Bus 90 12:19']);
  const tight = trimPlan(only('natsci_to_whiteoaks_arrive1300', 3), { mode: 'arrive', t: at('2026-10-08T13:00:00-04:00'), maxBytes: 100 });
  assert.ok(tight.lines.includes('Richmo/Winderme SB'));
  assert.ok(!tight.lines.includes('White Oaks Mall 2'), 'the last Off name is droppable');
  assert.equal(r.next, null);
  assert.equal(r.alert, null);
});

test('trim: alert only counts for its route', () => {
  // Route 90 alert on RICHWIN2 is the boarding stop of the chosen 12:07 trip.
  const r = trimPlan(fx('natsci_to_whiteoaks_1200'), { mode: 'depart', t: at('2026-10-08T12:00:00-04:00'), alerts: ALERTS });
  assert.equal(r.alert, '#1521 closed - check LTC');
  // MASOSTO4 alert is for route 10 only; the 08:01 trip boards route 13 there.
  const stops = legStops(fx('masonville_to_school_0800').itineraries[0]);
  assert.equal(alertFor(stops.filter((s) => s.stopId === 'MASOSTO4'), ALERTS), null);
});

test('trim: no itineraries, all cancelled, junk input', () => {
  assert.deepEqual(trimPlan({ itineraries: [], direct: [] }, { t: NOW }), { v: 1, ok: false, err: 'No trips found' });
  const tq = fx('natsci_to_whiteoaks_1200');
  for (const it of tq.itineraries) it.legs[1].cancelled = true;
  assert.equal(trimPlan(tq, { t: NOW }).err, 'No trips found');
  assert.equal(trimPlan(null, { t: NOW }).err, 'No trips found');
});

test('trim: realtime leg marks live', () => {
  const tq = fx('natsci_to_whiteoaks_1200');
  tq.itineraries[0].legs[1].realTime = true;
  const r = trimPlan(tq, { t: NOW });
  assert.equal(r.rt, true);
  assert.equal(r.lines[4], 'Bus 90 12:19 live');
});

test('walk-only itinerary', () => {
  const lines = itineraryLines({
    startTime: '2026-10-08T12:00:00Z', endTime: '2026-10-08T12:09:00Z',
    legs: [{ mode: 'WALK', duration: 540, startTime: '2026-10-08T12:00:00Z', endTime: '2026-10-08T12:09:00Z' }],
  });
  assert.deepEqual(lines, ['Leave 08:00', 'Walk 9m', 'Arrive 08:09']);
});

test('alerts: active/expired/deleted, details, camelCase', () => {
  assert.ok(ALERTS.SARNWES2);
  assert.equal(ALERTS.DELAHAL2, undefined, 'expired alert ignored');
  assert.equal(ALERTS.NATSCI, undefined, 'deleted alert ignored');
  assert.equal(alertDetail('Temp Stop approx. 130m west of Stop'), 'temp stop 130m W');
  assert.equal(alertDetail('Temp Stop - 1 pole west of stop'), 'temp stop 1 pole W');
  assert.equal(alertDetail('can be found at Althouse College\r\n'), 'use Althouse College');
  assert.equal(alertDetail('nothing useful'), '');
  const cc = compactAlerts(fx('alerts_camelcase'), NOW);
  assert.equal(alertFor([{ stopId: 'NATSCI', code: '1222', route: '02' }], cc), '#1222 closed: temp stop 40m N');
  assert.equal(
    alertFor([{ stopId: 'WESTSAR2', code: '2003', route: '93' }], ALERTS),
    '#2003 closed: use Althouse College',
  );
});

test('headsign: drops "Only" and avoids mid-word cuts', async () => {
  const { splitHeadsign, destLine } = await import('../src/plan.js');
  const { to } = splitHeadsign('Dundas & Highbury Only', '2');
  assert.equal(to, 'Dundas & Highbury');
  assert.equal(destLine(to), 'Dundas & Highbury');
  assert.equal(destLine('White Oaks Mall'), 'to White Oaks Mall');
  assert.equal(destLine('Argyle Mall and Fanshawe College'), 'Argyle Mall');
  for (const s of ['Dundas & Highbury Only', 'Fanshawe College & Oxford Street East']) {
    const l = destLine(splitHeadsign(s, '1').to);
    assert.ok(l.length <= 18, l);
  }
});

// ---- walking, near the destination, long trips ---------------------------

// Hand-made Transitous pieces. Stops are the public Sarnia & Western ones.
const T0 = at('2026-10-08T08:00:00-04:00');
const iso = (secs) => new Date(secs * 1000).toISOString();
function walkDirect(secs, start = T0) {
  return {
    duration: secs, startTime: iso(start), endTime: iso(start + secs), transfers: 0,
    legs: [{ mode: 'WALK', duration: secs, startTime: iso(start), endTime: iso(start + secs), from: { name: 'START' }, to: { name: 'END' } }],
  };
}
const SARNWES1 = { name: 'Sarnia at Western - #1646', stopId: 'ca-on-London-Transit_SARNWES1', stopCode: '1646' };

test('near the destination: "You\'re here" within 150 m', () => {
  const school = { lat: 43.00129, lon: -81.27883 };
  assert.ok(metres(school, { lat: 43.0014, lon: -81.2789 }) < 20);
  assert.ok(metres(school, { lat: 43.00129 + 0.0012, lon: -81.27883 }) <= HERE_M); // ~133 m
  assert.ok(metres(school, { lat: 43.00129 + 0.0015, lon: -81.27883 }) > HERE_M); // ~167 m
  const r = hereReply(T0);
  checkShape(r);
  assert.deepEqual(r.lines, ["You're here"]);
  assert.equal(r.leave, T0);
  assert.equal(r.arr, T0);
  assert.equal(r.xfers, 0);
});

test('walk only: Transitous gives just `direct`', () => {
  const r = trimPlan({ itineraries: [], direct: [walkDirect(740)] }, { mode: 'depart', t: T0, alerts: ALERTS });
  checkShape(r);
  assert.deepEqual(r.lines, ['Walk 12 min', 'Arrive 08:12']);
  assert.equal(r.leave, T0);
  assert.equal(r.arr, T0 + 740);
  assert.equal(r.xfers, 0);
  assert.equal(r.rt, false);
  assert.equal(r.alert, null);
  assert.equal(r.next, null);
  // Arrive-by: leave early enough to walk there by t.
  const a = trimPlan({ itineraries: [], direct: [walkDirect(740, T0 - 740)] }, { mode: 'arrive', t: T0 });
  checkShape(a);
  assert.equal(a.leave, T0 - 740);
  assert.equal(a.arr, T0);
  assert.deepEqual(a.lines, ['Walk 12 min', 'Arrive 08:00']);
  // Shortest walk wins; non-walk direct entries are ignored.
  const car = { ...walkDirect(60), legs: [{ mode: 'CAR', duration: 60 }] };
  assert.equal(bestWalk({ direct: [walkDirect(900), car, walkDirect(500)] }).dur, 500);
});

test('walk faster than the bus: show the walk, bus as a compact option', () => {
  const tq = fx('masonville_to_school_0800'); // chosen bus: leave 08:10, arrive 08:27
  tq.direct = [walkDirect(20 * 60)];
  const r = trimPlan(tq, { mode: 'depart', t: T0, alerts: ALERTS });
  checkShape(r);
  assert.deepEqual(r.lines, ['Walk 20 min', 'Arrive 08:20']);
  assert.equal(r.next, 'Bus: arr 08:27');
  assert.equal(r.xfers, 0);
  assert.equal(r.alert, null);
  // A walk of 20 min or less wins at the same arrival.
  const bus15 = trip('08:00', '08:15', ['9']);
  assert.deepEqual(trimPlan({ itineraries: [bus15], direct: [walkDirect(15 * 60)] }, { t: T0 }).lines, ['Walk 15 min', 'Arrive 08:15']);
  // ...and loses when slower; within 10 min of the bus it is an optional
  // last line, `next` keeps the next bus.
  const slow = trimPlan({ itineraries: [trip('08:00', '08:10', ['9']), trip('08:20', '08:30', ['9'])], direct: [walkDirect(15 * 60)] }, { t: T0 });
  assert.equal(slow.lines[0], 'Leave 08:00');
  assert.equal(slow.lines.at(-1), 'Walk 15m arr 08:15');
  assert.equal(slow.next, 'Next bus 08:20');
  // Arrive-by, short walk: wins when you can leave no earlier than for the bus.
  const by = at('2026-10-08T08:30:00-04:00');
  const a = trimPlan({ itineraries: [trip('08:10', '08:28', ['9'])], direct: [walkDirect(18 * 60, by - 18 * 60)] }, { mode: 'arrive', t: by });
  checkShape(a);
  assert.deepEqual(a.lines, ['Walk 18 min', 'Arrive 08:30']);
  assert.equal(a.next, 'Bus: leave 08:10');
});

test('long walks (over 20 min) win only when 15 min faster or no bus within 90 min', () => {
  const tq = fx('masonville_to_school_0800'); // chosen bus arrives 08:27
  // Same arrival: the bus is the main answer, `next` is the next bus and the
  // walk is an optional last line.
  tq.direct = [walkDirect(27 * 60)];
  let r = trimPlan(tq, { t: T0, alerts: ALERTS });
  checkShape(r);
  assert.equal(r.lines[0], 'Leave 08:10');
  assert.deepEqual(r.lines.slice(-2), ['Arrive 08:27', 'Walk 27m arr 08:27']);
  assert.equal(r.next, 'Next bus 08:30');
  // 6 min faster is not enough.
  tq.direct = [walkDirect(21 * 60)];
  r = trimPlan(tq, { t: T0 });
  assert.equal(r.lines.at(-1), 'Walk 21m arr 08:21');
  assert.equal(r.next, 'Next bus 08:30');
  // More than 10 min after the bus: not a real alternative, no walk line.
  tq.direct = [walkDirect(38 * 60)];
  r = trimPlan(tq, { t: T0 });
  assert.equal(r.lines.at(-1), 'Arrive 08:27');
  assert.equal(r.next, 'Next bus 08:30');
  tq.direct = [walkDirect(37 * 60)];
  assert.equal(trimPlan(tq, { t: T0 }).lines.at(-1), 'Walk 37m arr 08:37');
  // 15 min faster (or more) wins.
  const bus50 = trip('08:05', '08:50', ['9']);
  r = trimPlan({ itineraries: [bus50], direct: [walkDirect(35 * 60)] }, { t: T0 });
  assert.deepEqual(r.lines, ['Walk 35 min', 'Arrive 08:35']);
  assert.equal(r.next, 'Bus: arr 08:50');
  assert.equal(trimPlan({ itineraries: [bus50], direct: [walkDirect(36 * 60)] }, { t: T0 }).lines[0], 'Leave 08:05');
  // No bus within 90 min: the walk wins even if only a bit faster.
  const bus931 = trip('08:50', '09:31', ['9']);
  const bus929 = trip('08:50', '09:29', ['9']);
  assert.deepEqual(trimPlan({ itineraries: [bus931], direct: [walkDirect(85 * 60)] }, { t: T0 }).lines, ['Walk 85 min', 'Arrive 09:25']);
  r = trimPlan({ itineraries: [bus929], direct: [walkDirect(85 * 60)] }, { t: T0 });
  assert.equal(r.lines[0], 'Leave 08:50');
  assert.equal(r.lines.at(-1), 'Walk 85m arr 09:25');
  assert.equal(r.next, null);
  // Night: first bus in the morning, so a long walk is the answer.
  const night = at('2026-10-08T02:00:00-04:00');
  const morning = trip('05:40', '06:14', ['9']);
  r = trimPlan({ itineraries: [morning], direct: [walkDirect(76 * 60, night)] }, { t: night });
  checkShape(r);
  assert.deepEqual(r.lines, ['Walk 76 min', 'Arrive 03:16']);
  assert.equal(r.next, 'Bus: arr 06:14');
  // Arrive-by: a long walk must let you leave 15 min later than the bus.
  const arr = fx('natsci_to_whiteoaks_arrive1300'); // chosen bus leaves 12:09
  const t = at('2026-10-08T13:00:00-04:00');
  arr.direct = [walkDirect(45 * 60, t - 45 * 60)]; // leave 12:15
  r = trimPlan(arr, { mode: 'arrive', t });
  checkShape(r);
  assert.equal(hhmm(r.leave), '12:09');
  assert.equal(r.lines.at(-1), 'Walk 45m lv 12:15');
  assert.equal(r.next, 'Earlier bus 12:04');
  arr.direct = [walkDirect(36 * 60, t - 36 * 60)]; // leave 12:24
  r = trimPlan(arr, { mode: 'arrive', t });
  assert.deepEqual(r.lines, ['Walk 36 min', 'Arrive 13:00']);
  assert.equal(r.next, 'Bus: leave 12:09');
  // Every walk note fits; it is dropped first when space runs out (before
  // the Direct option).
  for (const m of [1, 9, 21, 59, 90]) {
    const x = trimPlan({ itineraries: [trip('08:00', '08:05', ['9'])], direct: [walkDirect(m * 60)] }, { t: T0 });
    checkShape(x);
  }
  const fast = trip('05:40', '06:05', ['10', '27']);
  const late = trip('05:58', '06:16', ['9']);
  const full = trimPlan({ itineraries: [fast, late], direct: [walkDirect(34 * 60, at('2026-10-08T05:40:00-04:00'))] }, { t: at('2026-10-08T05:40:00-04:00') });
  assert.deepEqual(full.lines.slice(-4), ['Arrive 06:05', 'Direct 9 05:58', 'arr 06:16', 'Walk 34m arr 06:14']);
  const less = trimPlan({ itineraries: [fast, late], direct: [walkDirect(34 * 60, at('2026-10-08T05:40:00-04:00'))] },
    { t: at('2026-10-08T05:40:00-04:00'), maxBytes: Buffer.byteLength(JSON.stringify(full)) - 1 });
  assert.deepEqual(less.lines.slice(-3), ['Arrive 06:05', 'Direct 9 05:58', 'arr 06:16']);
});

test('bus trip with a slower walk and no later bus mentions the walk', () => {
  const tq = fx('masonville_to_school_0800');
  tq.itineraries = [tq.itineraries[0]];
  tq.direct = [walkDirect(40 * 60)];
  const r = trimPlan(tq, { t: T0 });
  checkShape(r);
  assert.equal(r.next, 'Walk 40m arr 08:40');
});

test('equal arrival: fewer transfers win unless the direct trip walks over 10 min more', () => {
  // Like home from Western at 16:00: direct 9 with a 15 min walk to the
  // stop (22 min walking) vs 127 + 9 (11 min walking), both arriving 16:44.
  const viaTransfer = walkTrip('16:12', [{ walk: 120 }, { ride: 600, route: '127' }, { walk: 120 }, { ride: 660, route: '9' }, { walk: 420 }]);
  const direct22 = walkTrip('16:09', [{ walk: 900 }, { ride: 780, route: '9' }, { walk: 420 }]);
  assert.equal(viaTransfer.endTime, direct22.endTime);
  let r = trimPlan({ itineraries: [direct22, viaTransfer] }, { t: at('2026-10-08T16:00:00-04:00') });
  checkShape(r);
  assert.equal(r.xfers, 1, '11 min more walking: the transfer trip is intended');
  assert.deepEqual(r.lines.slice(-2), ['Direct 9 16:24', 'arr 16:44 walk 22m']);
  // 9 min more walking (under 10): the direct trip wins.
  const direct20 = walkTrip('16:11', [{ walk: 780 }, { ride: 780, route: '9' }, { walk: 420 }]);
  assert.equal(viaTransfer.endTime, direct20.endTime);
  r = trimPlan({ itineraries: [direct20, viaTransfer] }, { t: at('2026-10-08T16:00:00-04:00') });
  assert.equal(r.xfers, 0);
  assert.equal(r.lines[2], 'Walk 13m to #1');
});

test('two transfers: every Bus and Off kept, ends with Off, Walk, Arrive', () => {
  const r = trimPlan(only('argyle_to_westmount_0800', 1), { mode: 'depart', t: T0, alerts: ALERTS });
  checkShape(r);
  assert.equal(r.xfers, 2);
  assert.deepEqual(r.lines, [
    'Leave 08:06', '2 transfers', 'Walk 1m to #1788', 'Trafal/Atkinson WB', 'Bus 2A 08:07', 'to Natural Science',
    'Off #538 08:23', 'Dundas/Adelaide WB', 'Walk 2m to #28', 'Adelaide/Dundas SB', 'Bus 92 08:25', 'Victoria Hosptial',
    'Off #2284 08:35', 'Victoria/Zone A EB', 'Bus 24 08:39', 'to Talbot Village', 'Off #1997 08:56', 'Westmount Mall 1',
    'Walk 3m', 'Arrive 08:59',
  ]);
  checkBoarding(r.lines);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (2 transfers): ${bytes}`);
  assert.ok(bytes <= MAX_REPLY);
});

test('over budget: drops headsigns (middle first), Off stop names, then Leave, never Board/stop name/Bus/Off/last Walk/Arrive', () => {
  const tq = only('argyle_to_westmount_0800', 1);
  const t = T0;
  const r0 = trimPlan(tq, { t, maxBytes: 440 });
  assert.deepEqual(r0.lines.filter((l) => /^(to |Victoria Hospt)/.test(l)), ['to Natural Science', 'to Talbot Village']);
  const r1 = trimPlan(tq, { t, maxBytes: 420 });
  assert.deepEqual(r1.lines.filter((l) => /^(to |Victoria Hospt)/.test(l)), ['to Natural Science']);
  assert.ok(r1.lines.includes('Westmount Mall 1'), 'Off names go after the headsigns');
  const r2 = trimPlan(tq, { t, maxBytes: 200 });
  assert.deepEqual(r2.lines, [
    '2 transfers', 'Walk 1m to #1788', 'Trafal/Atkinson WB', 'Bus 2A 08:07', 'Off #538 08:23', 'Walk 2m to #28', 'Adelaide/Dundas SB',
    'Bus 92 08:25', 'Off #2284 08:35', 'Victoria/Zone A EB', 'Bus 24 08:39', 'Off #1997 08:56', 'Walk 3m', 'Arrive 08:59',
  ]);
  checkBoarding(r2.lines);

  // Synthetic 5-bus trip (repeat the two-transfer one's legs): fits the
  // default budget and still ends Off, Walk, Arrive.
  const it = structuredClone(tq.itineraries[0]);
  delete it.transfers;
  const mid = it.legs.slice(1, -1);
  it.legs = [it.legs[0], ...mid, mid[1], ...mid.slice(0, 3), it.legs.at(-1)]; // B W B W B W B W B
  const big = trimPlan({ itineraries: [it], direct: [] }, { t });
  checkShape(big);
  checkBoarding(big.lines);
  assert.equal(big.lines.filter((l) => l.startsWith('Bus')).length, 5);
  assert.equal(big.lines[1], '4 transfers');
  // Ends Off (then its stop name, if it fit), Walk, Arrive.
  assert.deepEqual(big.lines.slice(-2).map((l) => l.split(' ')[0]), ['Walk', 'Arrive']);
  assert.ok(/^Off /.test(big.lines.at(-3)) || /^Off /.test(big.lines.at(-4)), JSON.stringify(big.lines));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= MAX_REPLY);
});

test('boarding stop always shown: no walk leg, split walk legs, stop-less walk end', () => {
  const base = fx('masonville_to_school_0800').itineraries[1]; // WALK, BUS 93 #1142>#2003, WALK
  // Starting right at the stop: Transitous gives no leading walk leg.
  const noWalk = { ...base, legs: base.legs.slice(1) };
  let lines = itineraryLines(noWalk);
  assert.deepEqual(lines.slice(0, 5), ['Leave 08:10', 'No transfer', 'Board at #1142', 'Masonville Pl 3', 'Bus 93 08:14']);
  checkBoarding(lines);
  // Leading walk split in two (and the first part has no stop on its end).
  const w = base.legs[0];
  const split = {
    ...base,
    legs: [{ ...w, duration: 100, to: { name: 'corner' } }, { ...w, duration: 140, from: { name: 'corner' } }, ...base.legs.slice(1)],
  };
  lines = itineraryLines(split);
  assert.equal(lines[2], 'Walk 4m to #1142');
  checkBoarding(lines);
  // Zero-length walk: still names the stop.
  lines = itineraryLines({ ...base, legs: [{ ...w, duration: 0 }, ...base.legs.slice(1)] });
  assert.equal(lines[2], 'Board at #1142');
  // A transfer between different stops with no walk leg in between.
  const two = fx('masonville_to_school_0800').itineraries[0];
  lines = itineraryLines({ ...two, legs: two.legs.filter((_, i) => i !== 2) });
  assert.ok(lines.includes('Board at #1173'), JSON.stringify(lines));
  checkBoarding(lines);
});

test('every line of every fixture reply is at most 18 characters and names its boarding stops', () => {
  const cases = [
    ['masonville_to_school_0800', 'depart', '2026-10-08T08:00:00-04:00'],
    ['school_to_masonville_1600', 'depart', '2026-10-08T16:00:00-04:00'],
    ['natsci_to_whiteoaks_1200', 'depart', '2026-10-08T12:00:00-04:00'],
    ['natsci_to_whiteoaks_arrive1300', 'arrive', '2026-10-08T13:00:00-04:00'],
    ['argyle_to_westmount_0800', 'depart', '2026-10-08T08:00:00-04:00'],
  ];
  let n = 0;
  for (const [name, mode, when] of cases) {
    const tq = fx(name);
    // Every itinerary on its own, not just the chosen one.
    for (const it of tq.itineraries) {
      const r = trimPlan({ itineraries: [it], direct: [] }, { mode, t: at(when), alerts: ALERTS });
      checkShape(r);
      checkBoarding(r.lines);
      n += r.lines.length;
      for (const l of itineraryLines(it)) assert.ok(l.length <= MAX_LINE, l);
    }
    for (const d of [60, 600, 3600]) checkShape(trimPlan({ ...tq, direct: [walkDirect(d, at(when))] }, { mode, t: at(when) }));
  }
  checkShape(trimPlan({ itineraries: [], direct: [walkDirect(119 * 60)] }, { t: T0 }));
  assert.ok(n > 100);
});

// Synthetic trips for the choice rules: one bus leg per route, no stops needed.
function trip(start, end, routes) {
  const t0 = at(`2026-10-08T${start}:00-04:00`);
  const t1 = at(`2026-10-08T${end}:00-04:00`);
  const step = (t1 - t0) / routes.length;
  const legs = routes.map((r, i) => ({
    mode: 'BUS', routeShortName: r, headsign: 'Somewhere', startTime: iso(t0 + i * step), endTime: iso(t0 + (i + 1) * step),
    from: { stopId: `S${r}a`, stopCode: '1' }, to: { stopId: `S${r}b`, stopCode: '2' },
  }));
  return { startTime: iso(t0), endTime: iso(t1), transfers: routes.length - 1, legs };
}

test('choice: fewer transfers win within 10 minutes of the fastest arrival', () => {
  const fast = trip('05:40', '06:05', ['10', '27']); // 1 transfer, arrives 06:05
  const near = trip('05:50', '06:13', ['9']); // direct, 8 min later
  const late = trip('05:58', '06:16', ['9']); // direct, 11 min later
  let r = trimPlan({ itineraries: [fast, near, late] }, { t: T0 });
  assert.equal(r.xfers, 0);
  assert.deepEqual(r.lines.slice(0, 3), ['Leave 05:50', 'No transfer', 'Board at #1']);
  assert.equal(r.next, 'Next bus 05:58');
  // Exactly 10 minutes later still counts.
  r = trimPlan({ itineraries: [fast, trip('05:52', '06:15', ['9'])] }, { t: T0 });
  assert.equal(r.xfers, 0);
  // More than 10 minutes later: the faster trip with a transfer, plus the
  // direct one as two optional lines at the end.
  r = trimPlan({ itineraries: [fast, late] }, { t: T0 });
  checkShape(r);
  assert.equal(r.xfers, 1);
  assert.equal(r.lines[1], '1 transfer');
  assert.deepEqual(r.lines.slice(-3), ['Arrive 06:05', 'Direct 9 05:58', 'arr 06:16']);
  // The alternative is the first thing dropped when space runs out.
  const tight = trimPlan({ itineraries: [fast, late] }, { t: T0, maxBytes: Buffer.byteLength(JSON.stringify(r)) - 1 });
  assert.equal(tight.lines.at(-1), 'Arrive 06:05');
  // Equal transfers: earlier arrival.
  r = trimPlan({ itineraries: [trip('05:45', '06:12', ['9']), trip('05:40', '06:10', ['10'])] }, { t: T0 });
  assert.equal(hhmm(r.arr), '06:10');
  // 2 transfers vs 1 transfer 5 min later: 1 transfer.
  r = trimPlan({ itineraries: [trip('05:40', '06:00', ['2', '92', '24']), trip('05:40', '06:05', ['2', '15'])] }, { t: T0 });
  assert.equal(r.xfers, 1);
  assert.equal(r.lines[1], '1 transfer');
  // Arrive-by: a single bus leaving up to 10 min earlier beats a later-leaving transfer trip.
  const by = at('2026-10-08T06:20:00-04:00');
  r = trimPlan({ itineraries: [trip('05:50', '06:15', ['10', '27']), trip('05:42', '06:10', ['9'])] }, { mode: 'arrive', t: by });
  assert.equal(r.xfers, 0);
  r = trimPlan({ itineraries: [trip('05:50', '06:15', ['10', '27']), trip('05:39', '06:10', ['9'])] }, { mode: 'arrive', t: by });
  assert.equal(r.xfers, 1);
});

test('walk-only and "You\'re here" replies have no transfer line', () => {
  assert.ok(!trimPlan({ itineraries: [], direct: [walkDirect(300)] }, { t: T0 }).lines.some((l) => /transfer/.test(l)));
  assert.ok(!hereReply(T0).lines.some((l) => /transfer/.test(l)));
});

// ---- closed stops: a note under the boarding / Off line -----------------

const CLOSURES = compactAlerts(fx('alerts_closures_handmade'), NOW);

test('closed boarding and Off stops get a must-keep temp-stop line', () => {
  // Masonville -> school: board #1143 (closed, no detail), transfer to #1173
  // (closed, alternative named), get off at #1647 (temp stop 130 m west).
  let r = trimPlan(only('masonville_to_school_0800', 0), { t: at('2026-10-08T08:00:00-04:00'), alerts: CLOSURES });
  checkShape(r);
  checkBoarding(r.lines);
  assert.deepEqual(r.lines, [
    'Leave 08:01', '1 transfer', 'Walk 1m to #1143', 'Masonville Pl 4', 'Closed: see alert', 'Bus 13A 08:02', 'to White Oaks Mall',
    'Off #509 08:11', 'Delaware Hall SB', 'Walk 2m to #1173', 'Talbot College', 'Use Althouse', 'Bus 27 08:15', 'to Capulet Lane',
    'Off #1647 08:23', 'Sarnia/Western WB', 'Temp stop 130m W', 'Walk 3m', 'Arrive 08:26',
  ]);
  // School -> Masonville: board #1646 on route 27 (the route 9-only closure
  // there is ignored), detour at #1818 adds nothing, get off at closed #1143.
  r = trimPlan(only('school_to_masonville_1600', 0), { t: at('2026-10-08T16:00:00-04:00'), alerts: CLOSURES });
  checkShape(r);
  checkBoarding(r.lines);
  assert.deepEqual(r.lines.slice(0, 5), ['Leave 16:04', '1 transfer', 'Walk 1m to #1646', 'Sarnia/Western EB', 'Temp 2 poles E']);
  assert.equal(r.lines.filter((l) => l === 'Temp 2 poles E').length, 1);
  assert.ok(!r.lines.some((l) => /pole S/.test(l)), 'detours add no line');
  assert.deepEqual(r.lines.slice(-3), ['Closed: see alert', 'Walk 1m', 'Arrive 16:25']);
  // Never dropped when space runs out (headsigns and Leave go first).
  const tight = trimPlan(only('masonville_to_school_0800', 0), { t: at('2026-10-08T08:00:00-04:00'), alerts: CLOSURES, maxBytes: 100 });
  for (const l of ['Masonville Pl 4', 'Closed: see alert', 'Talbot College', 'Use Althouse', 'Temp stop 130m W']) assert.ok(tight.lines.includes(l), l);
  // No alerts map, no lines.
  assert.ok(!trimPlan(only('masonville_to_school_0800', 0), { t: NOW, alerts: null }).lines.some((l) => /^(Temp|Use|Closed)/.test(l)));
});

test('closure text fits 18 characters', async () => {
  const { closedText } = await import('../src/plan.js');
  assert.equal(closedText('temp stop 130m W'), 'Temp stop 130m W');
  assert.equal(closedText('temp stop 1 pole W'), 'Temp stop 1 pole W');
  assert.equal(closedText('temp stop 2 poles S'), 'Temp 2 poles S');
  assert.equal(closedText('temp stop 1250m N'), 'Temp stop 1250m N');
  assert.equal(closedText('use Althouse College'), 'Use Althouse');
  assert.equal(closedText('use Oxford at Mornington EB'), 'Use Oxford/Morning');
  assert.equal(closedText('use Clarke at Royal North NB'), 'Use Clarke/Royal');
  assert.equal(closedText('use Commissioners at Meadowlilly EB'), 'Use Commissioners');
  assert.equal(closedText('use Fanshawe College Stop 3'), 'Use Fanshawe');
  assert.equal(closedText(''), 'Closed: see alert');
  for (const d of ['temp stop 999m W', 'temp stop 12 poles N', 'use Wellington at Baseline Rd FS NB', 'use Commissioners at Meadowlilly EB']) {
    assert.ok(closedText(d).length <= MAX_LINE, closedText(d));
  }
});

test('no estimate: nothing from Transitous is "No trips found"', () => {
  assert.deepEqual(trimPlan({ itineraries: [], direct: [] }, { t: T0 }), { v: 1, ok: false, err: 'No trips found' });
});

// Synthetic trip with walks: [walk, bus, walk, bus, ...] from a spec list.
function walkTrip(start, parts) {
  let t = at(`2026-10-08T${start}:00-04:00`);
  const legs = [];
  let n = 0;
  for (const p of parts) {
    const secs = p.walk ?? p.ride;
    const leg = p.walk !== undefined
      ? { mode: 'WALK', duration: secs, from: { name: 'x' }, to: { name: 'y' } }
      : { mode: 'BUS', routeShortName: p.route, headsign: 'Somewhere', from: { stopId: `S${p.route}a${n}`, stopCode: '1' }, to: { stopId: `S${p.route}b${n++}`, stopCode: '2' } };
    leg.startTime = iso(t);
    t += secs;
    leg.endTime = iso(t);
    legs.push(leg);
  }
  const buses = legs.filter((l) => l.mode === 'BUS').length;
  return { startTime: legs[0].startTime, endTime: legs.at(-1).endTime, transfers: Math.max(0, buses - 1), legs };
}

test('choice: a long first walk does not beat a normal trip that is as fast with much less walking', () => {
  // Normal: 1 transfer, 5 min walking, arrives 08:38.
  const normal = walkTrip('08:00', [{ walk: 180 }, { ride: 900, route: '10' }, { ride: 1080, route: '27' }, { walk: 120 }, ]);
  // Long first walk (allowed by maxPreTransitTime=1800): direct bus, 27 min
  // walking, arrives 08:38 as well.
  const longWalk = walkTrip('07:51', [{ walk: 1500 }, { ride: 1200, route: '9' }, { walk: 120 }]);
  assert.equal(hhmm(toSecs(normal.endTime)), hhmm(toSecs(longWalk.endTime)));
  let r = trimPlan({ itineraries: [longWalk, normal] }, { t: T0 });
  assert.equal(r.xfers, 1, 'the normal trip wins despite the transfer');
  assert.equal(r.lines[2], 'Walk 3m to #1');
  // ...also when the long walk arrives a little later.
  const longLater = walkTrip('07:55', [{ walk: 1500 }, { ride: 1200, route: '9' }, { walk: 120 }]);
  assert.equal(trimPlan({ itineraries: [longLater, normal] }, { t: T0 }).xfers, 1);
  // A long walk that gets there clearly earlier is still fine to pick.
  const longEarly = walkTrip('07:30', [{ walk: 1500 }, { ride: 900, route: '9' }, { walk: 120 }]);
  assert.equal(trimPlan({ itineraries: [longEarly, normal] }, { t: T0 }).xfers, 0);
  // A direct bus with a bit more walking (under 10 min extra) still beats a transfer.
  const directBitMore = walkTrip('08:05', [{ walk: 540 }, { ride: 1500, route: '9' }, { walk: 120 }]); // 08:41
  assert.equal(hhmm(toSecs(directBitMore.endTime)), '08:41');
  r = trimPlan({ itineraries: [normal, directBitMore] }, { t: T0 });
  assert.equal(r.xfers, 0);
  // Same transfers and arrival: less walking wins.
  const a = walkTrip('08:00', [{ walk: 600 }, { ride: 1500, route: '9' }, { walk: 300 }]);
  const b = walkTrip('08:05', [{ walk: 120 }, { ride: 1680, route: '9' }, { walk: 300 }]);
  assert.equal(a.endTime, b.endTime);
  assert.equal(hhmm(trimPlan({ itineraries: [a, b] }, { t: T0 }).leave), '08:05');
  // Arrive-by: the long first walk leaving earlier loses to a normal trip leaving no earlier.
  const by = at('2026-10-08T08:45:00-04:00');
  assert.equal(trimPlan({ itineraries: [longWalk, normal] }, { mode: 'arrive', t: by }).xfers, 1);
});

// ---- stop names under the boarding / Off lines -----------------------------

test('stopName: "Main/Cross DIR", direction always kept, abbreviations, letter cuts, no name', async () => {
  const { stopName } = await import('../src/plan.js');
  const n = (name, code = '1') => stopName({ name, stopCode: code });
  // "between A & B": the first cross street.
  assert.equal(n('Richmond between Oxford & Central NB'), 'Richmond/Oxford NB');
  assert.equal(n('Western between Sarnia & Lambton SB'), 'Western/Sarnia SB');
  // Too long: cut the main street (6+ letters kept), then the cross street;
  // the direction always stays.
  assert.equal(n('Commissioners between Wellington & Adelaide EB'), 'Commis/Wellingt EB');
  assert.equal(n('Highbury between Commissioners Road & Hamilton Road SB'), 'Highbu/Commissi SB');
  // at, &, near, opposite, "N of".
  assert.equal(n('Sarnia at Western  WB - #1647', '1647'), 'Sarnia/Western WB');
  assert.equal(n('Trafalgar at Atkinson WB - #1788', '1788'), 'Trafal/Atkinson WB');
  assert.equal(n('Victoria Hospital & Zone A EB - #2284', '2284'), 'Victoria/Zone A EB');
  assert.equal(n('Adelaide opposite Central NB'), 'Adelaid/Central NB');
  assert.equal(n('Wharncliffe near Commissioners SB'), 'Wharnc/Commissi SB');
  assert.equal(n('Richmond south of Queens SB - #2742', '2742'), 'Richmond/Queens SB');
  assert.equal(n('Clarke north of Dundas'), 'Clarke N of Dundas'); // "N of" kept when it fits
  assert.equal(n('Western North of Phillip Aziz  NB - #2291', '2291'), 'Western/Phillip NB');
  // Abbreviations first, before any letter cuts.
  assert.equal(n('Richmond at University SB - #1513', '1513'), 'Richmond/Univ SB');
  assert.equal(n('Western at Sarnia Rd SB - #2003', '2003'), 'Western/Sarnia SB');
  assert.equal(n('Dundas Street at Highbury Avenue North WB'), 'Dundas/Highbury WB');
  assert.equal(n('Universtiy Hospital SB - #1817', '1817'), 'Univ Hosp SB');
  assert.equal(n('Masonville Place Stop #3 - #1142', '1142'), 'Masonville Pl 3');
  assert.equal(n('White Oaks Mall Stop 2 - #2061', '2061'), 'White Oaks Mall 2');
  assert.equal(n('Westmount Mall at Stop 1 - #1997', '1997'), 'Westmount Mall 1');
  assert.equal(n('Natural Science - #1222', '1222'), 'Natural Science');
  // Out of town: parentheses stripped, Downtown -> Dtwn.
  assert.equal(n('Kitchener (Downtown)'), 'Kitchener Dtwn');
  assert.equal(n('Charles / Water'), 'Charles/Water');
  assert.equal(n('London (Downtown) Stop 2'), 'London Dtwn 2');
  // No real name: no line.
  for (const x of ['', '   ', '#1513 - #1513', '1513', '#1513']) assert.equal(n(x, '1513'), null, x);
  assert.equal(stopName({ stopCode: '1513' }), null);
  assert.equal(stopName(null), null);
  // Anything with a direction and a cross street keeps both, within 18.
  for (const x of ['Fanshawe Park Road between Richmond Street & Masonville Place WB', 'Fanshawe Park Road West at Hyde Park Road NB',
    'Oxford Street West at Wharncliffe Road North EB', 'Abcdefghijklmnopqrstuvwxyz between Abcdefghijklmnop & X EB']) {
    const v = n(x);
    assert.ok(v.length <= MAX_LINE, `${x} -> ${v}`);
    assert.match(v, /^\S.{4,}\/\S{4,}.* [NSEW]B$/, `${x} -> ${v}`);
  }
  for (const x of ['University Hospital Main Entrance Loop Stop 4 EB', 'A'.repeat(40) + ' WB', 'A'.repeat(40)]) {
    const v = n(x);
    assert.ok(v && v.length <= MAX_LINE && !/[\/&-]$/.test(v), `${x} -> ${v}`);
    if (/B$/.test(x)) assert.match(v, / [NSEW]B$/);
  }
});

test('headsigns: parentheses stripped, Downtown -> Dtwn; a line repeating the one above is dropped', () => {
  // Long route names (intercity coaches) keep the departure time.
  const coach = structuredClone(fx('masonville_to_school_0800').itineraries[1]);
  Object.assign(coach.legs[1], { mode: 'COACH', routeShortName: 'FlixBus 2702' });
  assert.equal(itineraryLines(coach).find((l) => /08:14/.test(l)), 'FlixBus 2702 08:14');
  coach.legs[1].routeShortName = 'Some Very Long Coach Line 12';
  assert.equal(itineraryLines(coach).find((l) => /08:14/.test(l)), 'Some Very Lo 08:14');
  assert.deepEqual(splitHeadsign('Kitchener (Downtown)', '1'), { variant: '1', to: 'Kitchener Dtwn' });
  const items = [
    { k: 'bus', t: 'Bus 1 09:00' }, { k: 'to', t: 'London Dtwn', n: 0, of: 1 }, { k: 'name', t: 'London Dtwn' },
    { k: 'off', t: 'Off #9 10:30' }, { k: 'offname', t: 'Kitchener Dtwn' }, { k: 'offname', t: 'Kitchener Dtwn' }, { k: 'arrive', t: 'Arrive 10:35' },
  ];
  assert.deepEqual(compactItems(items, () => true), ['Bus 1 09:00', 'London Dtwn', 'Off #9 10:30', 'Kitchener Dtwn', 'Arrive 10:35']);
  // The kept copy is the must-keep one.
  assert.deepEqual(compactItems(items, (l) => l.length <= 4), ['Bus 1 09:00', 'London Dtwn', 'Off #9 10:30', 'Arrive 10:35']);
});

test('stop names: under every boarding line, closure note after the name, empty names skipped', () => {
  const base = fx('masonville_to_school_0800').itineraries[1]; // WALK, BUS 93 #1142>#2003, WALK
  let lines = itineraryLines(base);
  assert.deepEqual(lines.slice(2, 7), ['Walk 4m to #1142', 'Masonville Pl 3', 'Bus 93 08:14', 'to White Oaks Mall', 'Off #2003 08:23']);
  assert.equal(lines[7], 'Western/Sarnia SB');
  // Name missing or just the code: no name line.
  const bus = base.legs[1];
  for (const name of [undefined, '', '#1142', '1142 - #1142']) {
    const it = { ...base, legs: [base.legs[0], { ...bus, from: { ...bus.from, name }, to: { ...bus.to, name } }, base.legs[2]] };
    lines = itineraryLines(it);
    assert.deepEqual(lines.slice(2, 4), ['Walk 4m to #1142', 'Bus 93 08:14'], String(name));
    assert.equal(lines.length, 8, JSON.stringify(lines));
  }
  // Closed boarding stop: name, then the temp-stop note.
  const r = trimPlan(only('masonville_to_school_0800', 0), { t: T0, alerts: CLOSURES });
  const i = r.lines.indexOf('Walk 2m to #1173');
  assert.deepEqual(r.lines.slice(i, i + 3), ['Walk 2m to #1173', 'Talbot College', 'Use Althouse']);
  // Off names are dropped after headsigns and before Leave.
  const full = trimPlan(only('masonville_to_school_0800', 0), { t: T0 });
  const noTo = trimPlan(only('masonville_to_school_0800', 0), { t: T0, maxBytes: Buffer.byteLength(JSON.stringify(full)) - 40 });
  assert.ok(!noTo.lines.some((l) => l.startsWith('to ')), JSON.stringify(noTo.lines));
  assert.ok(noTo.lines.includes('Leave 08:01'));
  assert.ok(noTo.lines.includes('Masonville Pl 4') && noTo.lines.includes('Talbot College'));
  const fewer = trimPlan(only('masonville_to_school_0800', 0), { t: T0, maxBytes: Buffer.byteLength(JSON.stringify(noTo)) - 1 });
  assert.ok(fewer.lines.includes('Leave 08:01'), 'an Off name goes before Leave');
  assert.ok(fewer.lines.length < noTo.lines.length);
});

test('Next bus / Earlier bus: first bus departure, never the chosen trip\'s own bus', () => {
  // Two trips catch the same 16:14 bus (one leaves home later and walks
  // less); the next bus is 16:24.
  const chosen = walkTrip('16:00', [{ walk: 840 }, { ride: 1200, route: '9' }, { walk: 120 }]); // bus 16:14
  const sameBus = walkTrip('16:05', [{ walk: 540 }, { ride: 1200, route: '9' }, { walk: 120 }]); // bus 16:14 too
  const later = walkTrip('16:10', [{ walk: 840 }, { ride: 1200, route: '9' }, { walk: 120 }]); // bus 16:24
  sameBus.endTime = iso(toSecs(chosen.endTime) + 60); // arrives a minute later
  let r = trimPlan({ itineraries: [chosen, sameBus, later] }, { t: at('2026-10-08T16:00:00-04:00') });
  assert.equal(hhmm(r.leave), '16:00');
  assert.equal(r.next, 'Next bus 16:24');
  // Nothing later: no next.
  r = trimPlan({ itineraries: [chosen, sameBus] }, { t: at('2026-10-08T16:00:00-04:00') });
  assert.equal(r.next, null);
  // Arrive-by: the latest bus strictly before the chosen one's.
  const by = at('2026-10-08T17:00:00-04:00');
  r = trimPlan({ itineraries: [later, chosen] }, { mode: 'arrive', t: by });
  assert.equal(hhmm(r.leave), '16:10');
  assert.equal(r.next, 'Earlier bus 16:14');
  assert.ok('Earlier bus 23:59'.length <= MAX_LINE);
});
