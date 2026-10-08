// Re-capture the Transitous test fixtures from the public API.
// Uses public places only (Masonville Place, Western University, White Oaks
// Mall, Sarnia & Western, Argyle Mall, Westmount Mall). Strips geometry and
// intermediate stops so the files stay small; everything the trimmer reads is
// kept as Transitous sent it.
//   node scripts/capture-fixtures.mjs [name ...]   (no names: all)
import { writeFileSync } from 'node:fs';

const UA = 'LTCTrip/0.1 (+https://github.com/irugniM)';
const MASONVILLE = '43.02566,-81.2815';
const SCHOOL = '43.00129,-81.27883';
const NATSCI = '43.010172,-81.273174';
const WHITE_OAKS = '42.93242,-81.22351';
const ARGYLE = '42.9906,-81.1767';
const WESTMOUNT = '42.9478,-81.2932';

const CAPTURES = [
  ['masonville_to_school_0800', MASONVILLE, SCHOOL, '2026-10-08T08:00:00-04:00', false],
  ['natsci_to_whiteoaks_arrive1300', NATSCI, WHITE_OAKS, '2026-10-08T13:00:00-04:00', true],
  ['school_to_masonville_1600', SCHOOL, MASONVILLE, '2026-10-08T16:00:00-04:00', false],
  ['natsci_to_whiteoaks_1200', NATSCI, WHITE_OAKS, '2026-10-08T12:00:00-04:00', false],
  // Two transfers (earliest arrival), for the long-trip line tests.
  ['argyle_to_westmount_0800', ARGYLE, WESTMOUNT, '2026-10-08T08:00:00-04:00', false],
];
const only = process.argv.slice(2);

function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'legGeometry' || k === 'intermediateStops' || k === 'debugOutput' || k === 'steps' || k === 'alternatives') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return obj;
}

for (const [name, from, to, time, arriveBy] of CAPTURES) {
  if (only.length && !only.includes(name)) continue;
  const u = new URL('https://api.transitous.org/api/v5/plan');
  u.searchParams.set('fromPlace', from);
  u.searchParams.set('toPlace', to);
  u.searchParams.set('time', time);
  u.searchParams.set('arriveBy', String(arriveBy));
  u.searchParams.set('numItineraries', '3');
  u.searchParams.set('directModes', 'WALK');
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const raw = await r.text();
  const data = strip(JSON.parse(raw));
  writeFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), JSON.stringify(data, null, 1) + '\n');
  console.log(name, r.status, `raw=${raw.length}B`, `itineraries=${data.itineraries?.length}`);
}
