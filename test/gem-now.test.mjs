// Gem now (lib/gem.mjs) on made-up days: the typical day is the median, so a one-day burst can't carry a pool
// over a steady one; patterns; a one-trader burst is tagged and left out; and the daily record from the
// snapshot store (lib/windows.mjs). Each check also runs against a planted fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gemNow, patternOf, burstOf } from '../lib/gem.mjs';
import { HOUR, DAY, merge, emptySeries } from '../lib/snapshots.mjs';
import { windowMetrics } from '../lib/windows.mjs';

const T0 = Date.UTC(2026, 9, 20);
const days = (vals, cost = 0.2) => vals.map((f, i) => ({ t: T0 + (i + 1) * DAY, feesPer1k: f, net: f - cost }));
const ok = (id) => ({ id, label: id, ok: true });
const CHECKS = ['contract-verified', 'sell-test', 'token-age-rank', 'verified', 'fee-identity'].map(ok);
const same = { thinness: 0.004, markoutToFee: 0.2, traders7d: 200, persistence: 0.5, checks: CHECKS };

test('a one-day 20× spike does not rank a pool over a steady one (the typical day is the median)', () => {
  const steady = gemNow({ ...same, daily: days([1, 1.05, 0.95, 1, 1.1, 0.9, 1]) });
  const spiky = gemNow({ ...same, daily: days([0.6, 0.6, 0.6, 12, 0.6, 0.6, 0.6]) });
  assert.ok(steady.total > spiky.total, `steady ${steady.total} vs spiky ${spiky.total}`);
  assert.equal(steady.pattern, 'steady');
  assert.equal(spiky.pattern, 'bursty');
  assert.deepEqual([spiky.burst.maxDay, spiky.burst.medianDay, spiky.burst.burstDays], [12, 0.6, 1]);
  // planted fault: the mean instead of the median lets the spike win
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(gemNow({ ...same, daily: days([0.6, 0.6, 0.6, 12, 0.6, 0.6, 0.6]) }, { typical: mean }).total > gemNow({ ...same, daily: days([1, 1.05, 0.95, 1, 1.1, 0.9, 1]) }, { typical: mean }).total);
});

test('patterns: steady, bursty, emerging (new, or the last day 3× the week), fading', () => {
  assert.equal(patternOf(days([1, 1, 1, 1, 1, 1, 1])), 'steady');
  assert.equal(patternOf(days([1, 1, 1, 9, 1, 1, 1])), 'bursty');
  assert.equal(patternOf(days([1, 2])), 'emerging');
  assert.equal(patternOf(days([1, 1, 1, 1, 1, 1, 1]), { last24: 3.5 }), 'emerging');
  assert.equal(patternOf(days([2, 2, 2, 2, 0.5, 0.5, 0.5])), 'fading');
  assert.equal(patternOf([]), null);
  assert.ok(gemNow({ ...same, daily: days([1, 2]), netPer1kDay: 1 }).tags.includes('unconfirmed'), 'emerging pools may score but are unconfirmed');
});

test('a burst paid mostly by one trader is tagged one-off and left out of the typical day', () => {
  const d = days([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 12]);
  const one = gemNow({ ...same, daily: d, topTxShare: 0.8 });
  assert.ok(one.tags.includes('one-off'), JSON.stringify(one.tags));
  assert.equal(one.burst.oneTrader, 0.8);
  const many = gemNow({ ...same, daily: d, topTxShare: 0.3 });
  assert.ok(!many.tags.includes('one-off'));
  assert.ok(one.total <= many.total);
  // the biggest day is not the latest: who paid it is unknown, never guessed
  assert.equal(burstOf(days([12, 0.6, 0.6]), { topTxShare: 0.9 }).oneTrader, null);
  // planted fault: a 30% trader called one-off would be caught by the tag check above
  assert.equal(gemNow({ ...same, daily: d, topTxShare: 0.3 }).tags.includes('one-off'), false);
});

test('windows carry the daily record (up to 30 days), the pattern and the burst', () => {
  const Q = 1n << 128n, L = 10n ** 18n, NOW = Date.UTC(2026, 10, 1, 18, 0), rows = [];
  let fg1 = 7n * Q;
  for (let t = NOW - 12 * DAY; t <= NOW; t += HOUR) {
    const k = (t - NOW + 12 * DAY) / HOUR;
    rows.push({ t, block: 1 + k * 300, sqrtPriceX96: (1n << 96n) + BigInt(Math.round(Math.sin(k / 5) * 1e25)), tick: 0, L, fg0: 3n * Q, fg1, parked: 0.2 });
    fg1 += ((125n * 10n ** 6n) * Q) / L; // $125 an hour of LP fees, $3,000 a day
  }
  const w = windowMetrics({ window: '24h', series: merge(emptySeries(), rows, { now: NOW }), cur: rows.at(-1), chain: 'ethereum',
    pool: { feeTier: 0.003, lpKeeps: 1, d0: 6, d1: 6, usd0: 1, usd1: 1, tvlUsd: 2e7, gasUsd: 5 }, config: { ticket: 1000, holdDays: { ethereum: 14 } } });
  assert.ok(w.daily.length >= 10 && w.daily.length <= 13, `days ${w.daily.length}`);
  assert.ok(w.daily.every((d) => Number.isFinite(d.t) && d.feesPer1k > 0));
  const f = w.daily.map((d) => d.feesPer1k);
  assert.ok(Math.max(...f) / Math.min(...f) < 1.05, 'a steady pool reads the same every day');
  assert.equal(w.daily.at(-1).t, NOW, 'the latest entry is the last 24 hours');
  assert.ok(w.pattern === 'steady' || w.pattern === 'mixed', w.pattern);
  assert.ok(w.burst && w.burst.medianDay > 0);
});
