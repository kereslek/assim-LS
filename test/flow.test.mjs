import test from 'node:test';
import assert from 'node:assert/strict';
import { dailySigma, ratioByDay, markouts } from '../lib/flow.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DAY = 86400, T0 = 1790000000;
const series = (n, f) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, price: f(i) }));

test('daily sigma: a series swinging ±2% a day reads 2%; holes and short windows give null', () => {
  const zig = series(31, (i) => 100 * Math.exp(i % 2 ? 0.02 : 0));
  assert.ok(near(dailySigma(zig), 0.02, 1e-12));
  const holed = zig.filter((_, i) => i !== 10 && i !== 11); // a 3-day gap is bridged
  assert.ok(dailySigma(holed) > 0);
  const broken = zig.filter((_, i) => i < 5 || i > 14); // a 10-day hole is not
  assert.equal(dailySigma(broken), null);
  assert.equal(dailySigma(series(10, () => 1)), null); // a third of a window
  assert.equal(dailySigma([]), null);
  assert.equal(dailySigma(series(31, () => 5)), 0); // a flat price really is zero volatility
});

test('ratio by day: token per quote, only on days both have a price', () => {
  const a = series(5, (i) => 10 + i), b = series(5, (i) => (i === 2 ? null : 2));
  const r = ratioByDay(a, b);
  assert.equal(r.length, 4);
  assert.equal(r[0].price, 5);
});

// Made-up swaps on a pool at raw price 1.0 (sqrtPriceX96 = 2^96), 0.3% fee.
const Q96 = 1n << 96n;
const sq = (p) => BigInt(Math.round(Math.sqrt(p) * 2 ** 96));
const swap = (block, inSide, amountIn, amountOut, priceAfter) => ({ block, logIndex: 0, in: inSide, amountIn: BigInt(amountIn), amountOut: BigInt(amountOut), sqrtPriceX96: sq(priceAfter) });
const feeOf = (s) => (s.amountIn * 3n) / 1000n;

test('markouts: flow that does not predict the price costs LPs nothing beyond the fee', () => {
  const ss = [swap(100, 0, 1000000, 997000, 1), swap(110, 1, 1000000, 997000, 1), swap(200, 0, 1000000, 997000, 1)];
  const m = markouts(ss, { horizon: 25, endBlock: 300, feeOf });
  assert.equal(m.counted, 3);
  assert.ok(near(m.ratio, 0, 1e-9));
  assert.equal(Q96, sq(1));
});

test('markouts: buying just before the price rises takes the fee back and more', () => {
  const ss = [swap(100, 1, 1000000, 997000, 1), swap(120, 1, 10, 9, 1.01)]; // the price is 1% higher 20 blocks later
  const m = markouts(ss, { horizon: 25, endBlock: 300, feeOf });
  // first swap: the pool got 1,000,000 token1 and paid 997,000 token0, worth 1,006,970 later:
  // adverse = fee 3,000 − (1,000,000 − 1,006,970) = 9,970. The tiny second swap adds −0.91.
  assert.ok(near(m.adverse, 9970 - 0.91, 1e-6), `adverse ${m.adverse}`);
  assert.ok(near(m.ratio, (9970 - 0.91) / 3000, 1e-9));
  assert.ok(m.ratio > 1);
});

test('markouts: swaps whose horizon has not ended are skipped; nothing countable is null', () => {
  const ss = [swap(100, 0, 1000000, 997000, 1), swap(290, 0, 1000000, 997000, 1)];
  const m = markouts(ss, { horizon: 25, endBlock: 300, feeOf });
  assert.equal(m.counted, 1);
  assert.equal(m.skipped, 1);
  assert.equal(markouts([swap(290, 0, 1000, 997, 1)], { horizon: 25, endBlock: 300, feeOf }), null);
  assert.equal(markouts([], { horizon: 25, endBlock: 300, feeOf }), null);
});
