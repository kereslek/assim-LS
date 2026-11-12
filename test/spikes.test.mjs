// Fee spikes (lib/spikes.mjs): a day 20× its 30-day median or more stands only with the day's volume behind it,
// else history.json `u` lists it as unconfirmed. Each rule has a planted fault it must catch. MOCKUP · MADE-UP NUMBERS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPIKE, rowRates, spikes, backed, volumeEvidence, unconfirmed, feeSpikes } from '../lib/spikes.mjs';

const DAY = 86400e3, T0 = Date.UTC(2026, 7, 1) + 5 * 60e3; // 00:05 UTC rows
// 60 daily history rows [t, price, fees, vol, parked]: $100 a day, a spike of `big` on day `at`
const dRows = ({ at = 40, big = 10000, gapAt = null, gapDays = 3 } = {}) => {
  const out = [[T0, 1, null, null, null]];
  let t = T0;
  for (let i = 1; i < 60; i++) {
    const days = i === gapAt ? gapDays : 1;
    t += days * DAY;
    out.push([t, 1, (i === at ? big : 100) * days, null, null]);
  }
  return out;
};
const gtOf = (vol = () => 10000) => { const days = new Map(); for (let i = -2; i < 70; i++) { const d = Math.floor(T0 / DAY) * DAY + i * DAY; days.set(d, [vol(d), 1]); } return { days }; };
const RATE = 0.01; // $10,000 of volume a day → $100 of LP fees

test('a day 100× its 30-day median is a spike; an ordinary day, a 5× day, a thin baseline or a $5 day is not', () => {
  const rows = dRows().map((r) => [r[0], r[2]]);
  const sp = spikes(rowRates(rows));
  assert.equal(sp.length, 1);
  assert.equal(sp[0].t, rows[40][0]);
  assert.ok(Math.abs(sp[0].ratio - 100) < 1e-9 && sp[0].base === 100);
  assert.equal(spikes(rowRates(dRows({ big: 500 }).map((r) => [r[0], r[2]]))).length, 0, '5× is not a spike');
  assert.equal(spikes(rowRates(rows.slice(36, 42))).length, 0, 'fewer than 5 rows around: no baseline, no verdict');
  const tiny = dRows({ big: 5 }).map((r, i) => [r[0], r[2] == null ? null : i === 40 ? 5 : 0.05]);
  assert.equal(spikes(rowRates(tiny)).length, 0, `a day under $${SPIKE.minUsd} is noise, whatever its ratio`);
});

test('a row after a gap is fees over its whole span: per day it is no spike (planted fault: booking it on one day)', () => {
  const rows = dRows({ at: -1, gapAt: 40, gapDays: 30 }).map((r) => [r[0], r[2]]); // 30 days of $100 on one row
  assert.equal(spikes(rowRates(rows)).length, 0, 'spread per day: $100 a day');
  const oneDay = rowRates(rows).map((r) => ({ ...r, rate: rows[r.i][1] })); // the fault: the row's fees as one day
  assert.equal(spikes(oneDay).length, 1, 'the planted fault books 30 days on one and is caught');
});

test('volume evidence: the days an interval overlaps, pro rata; a day with no volume read is no evidence, never 0', () => {
  const gt = gtOf();
  const a = Date.UTC(2026, 7, 10, 12), b = a + 2 * DAY;
  assert.equal(volumeEvidence(gt.days, a, b, RATE), 200);
  assert.equal(volumeEvidence(gt.days, a, a + DAY / 4, RATE), 25);
  gt.days.set(Date.UTC(2026, 7, 11), [null, 1]);
  assert.equal(volumeEvidence(gt.days, a, b, RATE), null, 'a missing day: no evidence');
  assert.equal(volumeEvidence(gt.days, a, b, null), null, 'no fee rate: no evidence');
  assert.equal(volumeEvidence(null, a, b, RATE), null);
});

test('backed: evidence at least a quarter of the counters backs a spike; none read is unconfirmed (planted fault: missing as backed)', () => {
  assert.equal(backed(10000, 9000), true);
  assert.equal(backed(10000, 1000), false);
  assert.equal(backed(10000, null), null);
  const faulty = (c, e) => (e == null ? true : e >= c * SPIKE.backed);
  const rows = dRows().map((r) => [r[0], r[2]]);
  assert.deepEqual(unconfirmed(rows, () => null), [rows[40][0]], 'no evidence: unconfirmed');
  const hidden = spikes(rowRates(rows)).filter((s) => faulty(rows[s.i][1], null) !== true).map((s) => s.t);
  assert.deepEqual(hidden, [], 'the planted fault shows the unread spike as checked');
  assert.notDeepEqual(unconfirmed(rows, () => null), hidden, 'the real rule catches what the fault hides');
});

test('history.json u: a spike the day volume backs stands; one it contradicts or nobody read is listed, d and y alike', () => {
  const d = dRows();
  const spikeDay = Math.floor(d[39][0] / DAY) * DAY; // the spike row spans day 39 00:05 → day 40 00:05
  const realVol = gtOf((day) => (day === spikeDay ? 1e6 : 10000));
  assert.deepEqual(feeSpikes({ d, gt: realVol, rate: RATE }), { u: null, spikes: 1, backedN: 1 }, 'the day traded 100×: backed');
  const flat = feeSpikes({ d, gt: gtOf(), rate: RATE });
  assert.deepEqual(flat.u, { d: [d[40][0]], y: [] }, 'an ordinary volume day contradicts it');
  assert.deepEqual(feeSpikes({ d, gt: null, rate: RATE }).u, { d: [d[40][0]], y: [] }, 'no volume read: unconfirmed');
  assert.equal(feeSpikes({ d: dRows({ big: 100 }), gt: null, rate: RATE }).u, null, 'no spike: nothing listed');
  // y: exact days [t, fees, 'x'], one a day; estimated days are the volume itself and are never judged
  const day0 = Math.floor(T0 / DAY) * DAY, y = Array.from({ length: 60 }, (_, i) => [day0 + i * DAY, i === 30 ? 8000 : 100, i === 50 ? 'e' : 'x']);
  y[50][1] = 9000;
  const fy = feeSpikes({ y, gt: gtOf(), rate: RATE });
  assert.deepEqual(fy.u, { d: [], y: [day0 + 30 * DAY] }, 'the exact spike is listed, the estimated one is not judged');
  assert.equal(feeSpikes({ y, gt: gtOf((day) => (day === day0 + 30 * DAY ? 8e5 : 10000)), rate: RATE }).u, null, 'backed by its own day');
});
