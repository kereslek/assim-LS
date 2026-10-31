import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePool, recentMoves } from '../lib/score.mjs';
import { parseChart } from '../lib/history.mjs';
import { lvrApr } from '../lib/economics.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Made-up pool at raw price 1 (both tokens 18 decimals, token1 = $1), active liquidity 1e24.
const base = { tick: 0, sqrt: 1, d1: 18, usdPer1: 1, activeL: 10n ** 24n, feeTier: 0.003, feesPerDayUsd: 100, sigma: 0.02, walls: { below: 0.3, above: Infinity } };

test('score: band value from an independent formula, then fee APR shared with the liquidity already there', () => {
  const s = scorePool(base, { days: 14, ticket: 1000, gasUsd: 5 });
  assert.equal(s.r, 0.07); // 2% a day over 14 days, whole percent
  // at price 1, a ±r band holds 2·L·(1 − e^(−r/2)) in token1 terms
  const band = (2 * 1e24 * (1 - Math.exp(-0.07 / 2))) / 1e18;
  assert.ok(near(s.bandValueUsd / band, 1, 0.005), `band ${s.bandValueUsd} vs ${band}`);
  assert.ok(near(s.feeApr, (365 * 100) / (s.bandValueUsd + 1000), 1e-12));
  assert.ok(near(s.lvr, lvrApr(0.02, 0.07), 1e-12));
  assert.ok(near(s.net, s.feeApr - s.lvr - (365 * 0.0004 / 0.0049) * 0.00175 - (365 * 0.0004 / 0.0049) * 5 / 1000, 1e-9));
  assert.ok(near(s.edge, s.feeApr / s.lvr, 1e-12));
  assert.ok(near(s.wallSigmaBelow, 0.3 / (0.02 * Math.sqrt(7)), 1e-12));
  assert.equal(s.wallSigmaAbove, Infinity); // no wall in view: far away, not missing
});

test('score: a missing input leaves the dependent numbers blank, never zero', () => {
  const a = scorePool({ ...base, sigma: null }, { gasUsd: 5 });
  assert.equal(a.r, null);
  assert.equal(a.feeApr, null);
  assert.equal(a.wallSigmaBelow, null);
  const b = scorePool(base, { gasUsd: null });
  assert.ok(b.feeApr > 0);
  assert.equal(b.net, null);
  const c = scorePool({ ...base, feesPerDayUsd: null }, { gasUsd: 5 });
  assert.equal(c.feeApr, null);
  assert.equal(scorePool({ ...base, usdPer1: null }, { gasUsd: 5 }).bandValueUsd, null);
});

test('recent moves: 7-day and last-day log moves from a daily series', () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ t: 1790000000 + i * 86400, price: 100 * Math.exp(0.01 * i) }));
  const m = recentMoves(pts);
  assert.ok(near(m.move7dLog, 0.07, 1e-12));
  assert.ok(near(m.lastDayLog, 0.01, 1e-12));
  assert.deepEqual(recentMoves(pts.slice(0, 5)), { move7dLog: null, lastDayLog: null });
});

test('chart parsing: coins with no prices are absent, keys lower-cased', () => {
  const m = parseChart({ coins: { 'ethereum:0xABC': { prices: [{ timestamp: 2, price: 3 }, { timestamp: 1, price: 2 }] }, 'ethereum:0xdef': { prices: [] } } });
  assert.deepEqual([...m.keys()], ['ethereum:0xabc']);
  assert.deepEqual(m.get('ethereum:0xabc').map((p) => p.t), [1, 2]);
});
