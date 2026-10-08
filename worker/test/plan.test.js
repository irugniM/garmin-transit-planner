import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  alertDetail, alertFor, bestWalk, compactAlerts, hereReply, hhmm, itineraryLines, legStops, metres, splitHeadsign,
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
function checkBoarding(lines) {
  lines.forEach((l, i) => {
    if (!/^Bus /.test(l)) return;
    const prev = lines[i - 1] || '';
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
    'Leave 08:01', '1 transfer', 'Walk 1m to #1143', 'Bus 13A 08:02', 'to White Oaks Mall', 'Off #509 08:11',
    'Walk 2m to #1173', 'Bus 27 08:15', 'to Capulet Lane', 'Off #1647 08:23', 'Walk 3m', 'Arrive 08:26',
  ]);
  assert.equal(r.alert, '#1647 closed: temp stop 130m W');
  assert.equal(r.next, null);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (1 transfer + alert): ${bytes}`);
  assert.ok(bytes < 400, `reply ${bytes} B`);
});

test('trim: from school, transfer at a different stop, Express headsign', () => {
  const r = trimPlan(only('school_to_masonville_1600', 0), { mode: 'depart', t: at('2026-10-08T16:00:00-04:00'), alerts: ALERTS });
  checkShape(r);
  assert.deepEqual(r.lines.slice(0, 3), ['Leave 16:04', '1 transfer', 'Walk 1m to #1646']);
  assert.ok(r.lines.includes('Walk 2m to #1512'));
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
  assert.equal(r.next, 'Next: 12:09');
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
  assert.equal(d.next, 'Earlier: 12:07');
  const r = trimPlan(only('natsci_to_whiteoaks_arrive1300', 3), { mode: 'arrive', t: at('2026-10-08T13:00:00-04:00'), alerts: null });
  checkShape(r);
  assert.equal(hhmm(r.leave), '12:11');
  assert.equal(r.xfers, 1);
  // Walk to the first stop and the final walk; none at the same-stop transfer.
  assert.deepEqual(r.lines.filter((l) => l.startsWith('Walk')), ['Walk 1m to #1222', 'Walk 3m']);
  assert.ok(!r.lines.some((l) => l.startsWith('Board')), 'Off #1521 already names the transfer stop');
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
  assert.equal(r.lines[3], 'Bus 90 12:19 live');
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
  // Same arrival: still walk.
  tq.direct = [walkDirect(27 * 60)];
  assert.deepEqual(trimPlan(tq, { t: T0 }).lines, ['Walk 27 min', 'Arrive 08:27']);
  // Walk slower than the bus: the bus trip as before.
  tq.direct = [walkDirect(40 * 60)];
  const b = trimPlan(tq, { mode: 'depart', t: T0, alerts: ALERTS });
  checkShape(b);
  assert.equal(b.lines[0], 'Leave 08:10');
  assert.equal(b.next, 'Next: 08:15');
  // Arrive-by: walk wins when you can leave no earlier than for the bus.
  const arr = fx('natsci_to_whiteoaks_arrive1300'); // chosen bus leaves 12:09
  const t = at('2026-10-08T13:00:00-04:00');
  arr.direct = [walkDirect(45 * 60, t - 45 * 60)];
  const w = trimPlan(arr, { mode: 'arrive', t });
  checkShape(w);
  assert.deepEqual(w.lines, ['Walk 45 min', 'Arrive 13:00']);
  assert.equal(hhmm(w.leave), '12:15');
  assert.equal(w.next, 'Bus: leave 12:09');
});

test('bus trip with a slower walk and no later bus mentions the walk', () => {
  const tq = fx('masonville_to_school_0800');
  tq.itineraries = [tq.itineraries[0]];
  tq.direct = [walkDirect(40 * 60)];
  const r = trimPlan(tq, { t: T0 });
  checkShape(r);
  assert.equal(r.next, 'Walk: arr 08:40');
});

test('two transfers: every Bus and Off kept, ends with Off, Walk, Arrive', () => {
  const r = trimPlan(only('argyle_to_westmount_0800', 1), { mode: 'depart', t: T0, alerts: ALERTS });
  checkShape(r);
  assert.equal(r.xfers, 2);
  assert.deepEqual(r.lines, [
    'Leave 08:06', '2 transfers', 'Walk 1m to #1788', 'Bus 2A 08:07', 'to Natural Science', 'Off #538 08:23',
    'Walk 2m to #28', 'Bus 92 08:25', 'Victoria Hosptial', 'Off #2284 08:35',
    'Bus 24 08:39', 'to Talbot Village', 'Off #1997 08:56', 'Walk 3m', 'Arrive 08:59',
  ]);
  checkBoarding(r.lines);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (2 transfers): ${bytes}`);
  assert.ok(bytes <= MAX_REPLY);
});

test('over budget: drops headsigns (middle first) then Leave, never Board/Bus/Off/last Walk/Arrive', () => {
  const tq = only('argyle_to_westmount_0800', 1);
  const t = T0;
  const r1 = trimPlan(tq, { t, maxBytes: 330 });
  assert.deepEqual(r1.lines.filter((l) => /^(to |Victoria)/.test(l)), ['to Natural Science']);
  const r2 = trimPlan(tq, { t, maxBytes: 200 });
  assert.deepEqual(r2.lines, [
    '2 transfers', 'Walk 1m to #1788', 'Bus 2A 08:07', 'Off #538 08:23', 'Walk 2m to #28', 'Bus 92 08:25', 'Off #2284 08:35',
    'Bus 24 08:39', 'Off #1997 08:56', 'Walk 3m', 'Arrive 08:59',
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
  assert.deepEqual(big.lines.slice(-3).map((l) => l.split(' ')[0]), ['Off', 'Walk', 'Arrive']);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= MAX_REPLY);
});

test('boarding stop always shown: no walk leg, split walk legs, stop-less walk end', () => {
  const base = fx('masonville_to_school_0800').itineraries[1]; // WALK, BUS 93 #1142>#2003, WALK
  // Starting right at the stop: Transitous gives no leading walk leg.
  const noWalk = { ...base, legs: base.legs.slice(1) };
  let lines = itineraryLines(noWalk);
  assert.deepEqual(lines.slice(0, 4), ['Leave 08:10', 'No transfer', 'Board at #1142', 'Bus 93 08:14']);
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
  assert.equal(r.next, 'Next: 05:58');
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
