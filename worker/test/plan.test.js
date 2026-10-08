import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  alertDetail, alertFor, compactAlerts, hhmm, itineraryLines, legStops, splitHeadsign, trimPlan, MAX_LINE,
} from '../src/plan.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
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
  assert.ok(Array.isArray(r.lines) && r.lines.length >= 2);
  for (const l of r.lines) assert.ok(l.length <= MAX_LINE, `line too long: "${l}"`);
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
  const r = trimPlan(fx('masonville_to_school_0800'), { mode: 'depart', t: at('2026-10-08T08:00:00-04:00'), alerts: ALERTS });
  checkShape(r);
  assert.equal(hhmm(r.leave), '08:01');
  assert.equal(hhmm(r.arr), '08:26');
  assert.equal(r.xfers, 1);
  assert.equal(r.rt, false);
  assert.deepEqual(r.lines, [
    'Leave 08:01', 'Walk 1m to #1143', 'Bus 13A 08:02', 'to White Oaks Mall', 'Off #509 08:11',
    'Walk 2m to #1173', 'Bus 27 08:15', 'to Capulet Lane', 'Off #1647 08:23', 'Arrive 08:26',
  ]);
  assert.equal(r.alert, '#1647 closed: temp stop 130m W');
  assert.equal(r.next, 'Next: 08:10');
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (1 transfer + alert): ${bytes}`);
  assert.ok(bytes < 400, `reply ${bytes} B`);
});

test('trim: from school, transfer at a different stop, Express headsign', () => {
  const r = trimPlan(fx('school_to_masonville_1600'), { mode: 'depart', t: at('2026-10-08T16:00:00-04:00'), alerts: ALERTS });
  checkShape(r);
  assert.equal(r.lines[0], 'Leave 16:04');
  assert.equal(r.lines[1], 'Walk 1m to #1646');
  assert.ok(r.lines.includes('Walk 2m to #1512'));
  assert.ok(r.lines.includes('to Masonville Mall'));
  // UNIVRIC1 has a detour alert for route 27 (alighting stop of leg 1).
  assert.equal(r.alert, '#1818 detour: temp stop 2 poles S');
  assert.equal(r.next, 'Next: 16:12');
});

test('trim: depart picks earliest arrival, then fewer transfers', () => {
  const r = trimPlan(fx('natsci_to_whiteoaks_1200'), { mode: 'depart', t: at('2026-10-08T12:00:00-04:00'), alerts: {} });
  checkShape(r);
  assert.equal(hhmm(r.leave), '12:07');
  assert.equal(r.xfers, 0);
  assert.equal(r.alert, null);
  assert.equal(r.next, 'Next: 12:09');
  const bytes = Buffer.byteLength(JSON.stringify(r));
  console.log(`  reply bytes (direct, no alert): ${bytes}`);
});

test('trim: arrive-by picks latest leave that arrives in time; same-stop transfer has no walk line', () => {
  const r = trimPlan(fx('natsci_to_whiteoaks_arrive1300'), { mode: 'arrive', t: at('2026-10-08T13:00:00-04:00'), alerts: null });
  checkShape(r);
  assert.equal(hhmm(r.leave), '12:11');
  assert.ok(r.arr <= at('2026-10-08T13:00:00-04:00'));
  assert.equal(r.xfers, 1);
  assert.equal(r.lines.filter((l) => l.startsWith('Walk')).length, 1);
  assert.equal(r.next, 'Earlier: 12:09');
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
  assert.equal(r.lines[2], 'Bus 90 12:19 live');
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
