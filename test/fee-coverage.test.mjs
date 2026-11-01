// Regression tests for pool LP fees that read a few dollars on a busy pool (made-up numbers): windows
// labelled 7 and 30 days whose fee counters covered only the hours since the loop began, and backfilled
// rows from nodes that answered old block tags with today's state. Each test fails on the code that did it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, DAY, merge, emptySeries, pastBlockAnswer } from '../lib/snapshots.mjs';
import { windowMetrics } from '../lib/windows.mjs';
import { feesVsAggregator } from '../lib/checks.mjs';

const NOW = Date.UTC(2026, 10, 1, 17, 0);
const Q = 1n << 128n;
const POOL = { feeTier: 0.003, lpKeeps: 1, d0: 6, d1: 6, usd0: 1, usd1: 1, tvlUsd: 2e7, gasUsd: 5 };
const CONFIG = { ticket: 1000, holdDays: { ethereum: 14 }, toxicMarkout: 0.6 };
// A made-up pool trading $1M a day at 0.3% (all LP fees in token1, 6 decimals, $1): $3,000 of LP fees a day.
const L = 10n ** 18n, PER_HOUR = (3000n * 10n ** 6n) / 24n;
function rows({ from = NOW - 8 * DAY, feesFrom = from } = {}) {
  const out = [];
  let fg1 = 7n * Q;
  for (let t = from; t <= NOW; t += HOUR) {
    const k = (t - from) / HOUR;
    out.push({ t, block: 1 + k * 300, sqrtPriceX96: (1n << 96n) + BigInt(Math.round(Math.sin(k / 5) * 1e25)), tick: 0,
      fg0: t >= feesFrom ? 3n * Q : null, fg1: t >= feesFrom ? fg1 : null, L: t >= feesFrom ? L : null, parked: 0.2 });
    fg1 += (PER_HOUR * Q) / L;
  }
  return out;
}
const win = (w, rs) => windowMetrics({ window: w, series: merge(emptySeries(), rs, { now: NOW }), cur: rs.at(-1), pool: POOL, config: CONFIG, chain: 'ethereum' });

test('a pool with $1M a day of volume shows about $3,000 a day of LP fees in every window', () => {
  const rs = rows();
  for (const [w, d] of [['24h', 1], ['7d', 7]]) {
    const x = win(w, rs);
    assert.ok(Math.abs(x.lpFeesUsd / (3000 * x.days) - 1) < 0.03, `${w}: ${x.lpFeesUsd} over ${x.days} days`);
    assert.ok(Math.abs(x.volUsd / (1e6 * x.days) - 1) < 0.03 && x.days >= d * 0.95, w);
  }
});

test('fee counters covering under half the window give no fees for it, and days shows the true coverage', () => {
  // prices for 8 days, fee counters only for the last 30 hours (the loop had just started)
  const rs = rows({ feesFrom: NOW - 30 * HOUR });
  const w7 = win('7d', rs);
  for (const k of ['lpFeesUsd', 'volUsd', 'protocolFeesUsd', 'feeApr', 'aggApr']) assert.equal(w7[k], null, k);
  const w24 = win('24h', rs);
  assert.ok(Math.abs(w24.lpFeesUsd / 3000 - 1) < 0.05, `24h ${w24.lpFeesUsd}`);
  // over half covered (4.5 of 7 days): fees shown, days = the covered span, partial
  const w45 = win('7d', rows({ feesFrom: NOW - 4.5 * DAY }));
  assert.ok(w45.lpFeesUsd > 0 && Math.abs(w45.days - 4.5) < 0.05 && w45.partial === true, JSON.stringify([w45.days, w45.partial]));
});

test('backfill answers from a node that served today\'s state for an old block are refused', () => {
  const nowSec = Math.floor(NOW / 1000);
  assert.equal(pastBlockAnswer(nowSec - 24 * 3600, { nowSec, blocksBack: 7200 }), true, 'a day back, a day old');
  assert.equal(pastBlockAnswer(BigInt(nowSec - 3600), { nowSec, blocksBack: 300 }), true, 'an hour back, an hour old');
  assert.equal(pastBlockAnswer(nowSec - 30, { nowSec, blocksBack: 7200 }), false, 'a day back, but today\'s state');
  assert.equal(pastBlockAnswer(nowSec - 60, { nowSec, blocksBack: 300 }), false, 'an hour back, but today\'s state');
  assert.equal(pastBlockAnswer(null, { nowSec, blocksBack: 300 }), false, 'no timestamp, no rows');
  // what such rows did to a 7-day window: counters frozen at today's value read as almost no fees
  const rs = rows(), frozen = rs.map((r, i) => (i < rs.length - 3 ? { ...r, fg1: rs.at(-4).fg1 } : r));
  assert.ok(win('7d', frozen).lpFeesUsd < 0.05 * win('7d', rs).lpFeesUsd, 'the fault this guards against');
});

test('fees vs aggregator flags a 2× gap (planted) and passes the honest number', () => {
  assert.equal(feesVsAggregator({ feesUsd: 3000, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, true);
  assert.equal(feesVsAggregator({ feesUsd: 6000, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, false);
  assert.equal(feesVsAggregator({ feesUsd: 1500, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, false);
  assert.equal(feesVsAggregator({ feesUsd: 86 / 7, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, false, 'a few dollars a day on a busy pool');
});
