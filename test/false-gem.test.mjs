// Regression tests for a false gem (made-up numbers shaped like the case): a hooked v4 stable pool whose
// liquidity all sits in the ticks next to the price read "one-sided", gem 95, fee APR 69% (trackers: 1%),
// "3/3 checks pass". Each test fails on the code that produced it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidityMap, valueInRange, ticksForLog } from '../lib/v3math.mjs';
import { hollowness, shapeTag } from '../lib/shape.mjs';
import { HOUR, DAY, merge, emptySeries } from '../lib/snapshots.mjs';
import { windowMetrics, gemWarnings, isHooked } from '../lib/windows.mjs';

const NOW = Date.UTC(2026, 10, 1, 15, 0);
const Q = 1n << 128n;

// Positions → map at tick 0 (raw price 1, 18 decimals for the value maths).
function mapOf(positions, tick = 0) {
  const net = new Map();
  for (const p of positions) { net.set(p.lo, (net.get(p.lo) || 0n) + p.L); net.set(p.hi, (net.get(p.hi) || 0n) - p.L); }
  const ticks = [...net].filter(([, n]) => n !== 0n).map(([t, n]) => ({ tick: t, liquidityNet: n }));
  const L = positions.filter((p) => p.lo <= tick && tick < p.hi).reduce((s, p) => s + p.L, 0n);
  return { ...liquidityMap({ ticks, tickCurrent: tick, liquidity: L }), L };
}
// The stable pool: thin liquidity at the current tick, crowds in the ticks just below and above (within 1%).
const crowded = [{ lo: -90, hi: 0, L: 10n ** 22n }, { lo: 0, hi: 1, L: 10n ** 19n }, { lo: 1, hi: 90, L: 10n ** 22n }];

test('(1) liquidity near the price is never parked: the crowded stable pool is served, a far wall still counts', () => {
  const m = mapOf(crowded);
  const near = Math.max(0.01, 0.02);
  const h = hollowness(m.segments, 1, 18, 0, m.L, { near });
  assert.ok(h.hollow < 0.01, `parked ${h.hollow}`);
  assert.equal(shapeTag(h), 'served');
  // a wall 5% above is beyond the near zone and is parked
  const w = mapOf([...crowded, { lo: 500, hi: 600, L: 10n ** 24n }]);
  const hw = hollowness(w.segments, 1, 18, 0, w.L, { near });
  assert.ok(hw.hollow > 0.8 && shapeTag(hw) === 'one-sided', `wall ${hw.hollow}`);
  // the old reading (no near zone) called the crowded pool parked: the fault this guards against
  assert.ok(hollowness(m.segments, 1, 18, 0, m.L).hollow > 0.8);
});

// A made-up stable pool over 2 days: fee growth from steady swaps at a thin active liquidity, and today's map
// holding about $10M inside ±r. The ticket is $1,000.
function stablePool({ inRange = 10e6 } = {}) {
  const Lact = 10n ** 18n, rows = [];
  let fg1 = 5n * Q;
  for (let t = NOW - 4 * DAY; t <= NOW; t += HOUR) {
    rows.push({ t, block: 1 + Math.round((t - NOW + 4 * DAY) / 12e3), sqrtPriceX96: 1n << 96n, tick: 0, L: Lact, fg0: 3n * Q, fg1, parked: 0 });
    fg1 += (11375000n * Q) / Lact; // about $11.4 of LP fees an hour in a 6-decimal $1 token1: ~$273 a day
  }
  const cur = rows.at(-1);
  const t = Math.round(ticksForLog(0.01)), perL = valueInRange(1n, -t, t, 1, 6); // USD per unit of liquidity over ±1%, token1 = $1
  const Lmap = BigInt(Math.round(inRange / perL));
  const segments = [{ lo: -t - 10, hi: t + 10, L: Lmap }];
  return { series: merge(emptySeries(), rows, { now: NOW }), cur: { ...cur, segments } };
}
const POOL = { feeTier: 0.0006, lpKeeps: 1, d0: 6, d1: 6, usd0: 1, usd1: 1, tvlUsd: 10e6, gasUsd: 5 };
const CONFIG = { ticket: 1000, holdDays: { ethereum: 14 }, toxicMarkout: 0.6 };

test('(2) fee APR at the ticket is 365·F/(V+S): ~1% next to $10M in range, the same identity in every window', () => {
  const { series, cur } = stablePool();
  const w = windowMetrics({ window: '24h', series, cur, pool: POOL, config: CONFIG, chain: 'ethereum' });
  const F = w.lpFeesUsd / w.days;
  assert.ok(F > 250 && F < 300, `F ${F}`);
  assert.ok(w.inRangeUsd > 9e6 && w.inRangeUsd < 11e6, `V ${w.inRangeUsd}`);
  const want = (365 * F) / (w.inRangeUsd + CONFIG.ticket);
  assert.ok(Math.abs(w.feeApr / want - 1) < 0.02, `fee APR ${w.feeApr} vs ${want}`);
  assert.ok(w.feeApr > 0.005 && w.feeApr < 0.015, `about 1%: ${w.feeApr}`);
  // the same identity in the longer windows (the 4-day pool covers over half of 7 days)
  for (const k of ['7d']) {
    const x = windowMetrics({ window: k, series, cur, pool: POOL, config: CONFIG, chain: 'ethereum' });
    assert.ok(x && Math.abs(x.feeApr / ((365 * x.lpFeesUsd / x.days) / (x.inRangeUsd + CONFIG.ticket)) - 1) < 0.02, k);
  }
});

test('(3) gem: unrun checks cap it at 40, hooked pools take the warning, stranded is 0 under 0.8 parked', () => {
  // a stranded pool that would score high
  const rows = [];
  for (let t = NOW - 3 * DAY; t <= NOW; t += HOUR) {
    const k = (t - NOW + 3 * DAY) / HOUR;
    rows.push({ t, block: 1 + k, sqrtPriceX96: (1n << 96n) + BigInt(Math.round(Math.sin(k) * 1e24)), tick: 0, L: 10n ** 18n, fg0: 3n * Q, fg1: 5n * Q + BigInt(k) * ((2000000000n * Q) / 10n ** 18n), parked: 0.97 });
  }
  const series = merge(emptySeries(), rows, { now: NOW });
  const cur = { ...rows.at(-1), aboveShare: 0.95 };
  const pool = { ...POOL, tvlUsd: 2e5, walls: { below: Infinity, above: 0.5 }, inactiveShare: 1, flow: { '24h': { swaps: 500, traders: 200, markout: 0.05 } } };
  const run = (extra, c = cur) => windowMetrics({ window: '24h', series, cur: c, pool: { ...pool, ...extra }, config: CONFIG, chain: 'ethereum' });
  const all = run({ checks: { ran: 12, total: 12 } });
  assert.ok(all.gem.total > 40, `precondition: a high gem with every check run (${all.gem.total})`);
  const few = run({ checks: { ran: 3, total: 12 } });
  assert.ok(few.gem.total <= 40, `capped: ${few.gem.total}`);
  assert.ok(few.gem.warnings.includes('only 3 of 12 checks ran'));
  // hooked pools, and pools whose hook was never read, take the −10 warning
  assert.ok(isHooked({ v: 4, hooks: '0x0000000000000000000000000000000000004444' }) && isHooked({ v: 4, hooks: undefined }));
  assert.ok(!isHooked({ v: 4, hooks: '0x0000000000000000000000000000000000000000' }) && !isHooked({ v: 3 }));
  const hooked = run({ checks: { ran: 12, total: 12 }, warnings: gemWarnings({ v: 4, hooks: undefined, swaps24h: 500 }) });
  assert.equal(hooked.gem.total, Math.max(0, all.gem.total - 10));
  // under 0.8 parked the stranded part is 0
  const served = merge(emptySeries(), rows.map((r) => ({ ...r, parked: 0.5 })), { now: NOW });
  const s = windowMetrics({ window: '24h', series: served, cur: { ...cur, parked: 0.5 }, pool: { ...pool, checks: { ran: 12, total: 12 } }, config: CONFIG, chain: 'ethereum' });
  assert.equal(s.gem.stranded, 0);
});
