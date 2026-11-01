// Planted faults: each cross-check must catch the fault it exists for, and pass on clean data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { feeIdentity, priceRatio } from '../lib/checks.mjs';
import { swapFees } from '../lib/swaps.mjs';

const Q128 = 1n << 128n;
const L = 10n ** 20n;
// Made-up v3 swaps on one pool: 0.3% tier, the protocol keeps 1/4 of token0-side fees.
const meta = { fee: 3000, feeProtocol: 0x44 };
const swaps = Array.from({ length: 12 }, (_, i) => ({ v: 3, in: i % 3 === 0 ? 1 : 0, amountIn: BigInt(1000 + i) * 10n ** 18n, amountOut: 1n, liquidity: L, block: 100 + i, logIndex: 0 }));
// The chain's counters as the pool itself would grow them.
function counters(ss, m) {
  const g = [0n, 0n];
  for (const s of ss) g[s.in] += (swapFees(s, m).lp * Q128) / s.liquidity;
  return g;
}
const base = [10n ** 30n, 10n ** 30n];
const now = counters(swaps, meta).map((x, i) => base[i] + x);
const ok = (r) => r.every((x) => x == null || Math.abs(x - 1) <= 0.02);

test('fee identity passes on clean data', () => {
  const r = feeIdentity(swaps, meta, base, now);
  assert.ok(ok(r), JSON.stringify(r));
  assert.ok(r.every((x) => x != null));
});

test('planted fault: a protocol fee read as off is caught', () => {
  assert.ok(!ok(feeIdentity(swaps, { ...meta, feeProtocol: 0 }, base, now)));
});

test('planted fault: a swap counted twice, or one missed, is caught', () => {
  assert.ok(!ok(feeIdentity([...swaps, swaps[1], swaps[2]], meta, base, now)));
  assert.ok(!ok(feeIdentity(swaps.slice(3), meta, base, now)));
});

test('planted fault: the v3 sign read the v4 way (input side flipped) is caught', () => {
  assert.ok(!ok(feeIdentity(swaps.map((s) => ({ ...s, in: 1 - s.in })), meta, base, now)));
});

test('unread counters give null, not a pass', () => {
  assert.equal(feeIdentity(swaps, meta, null, now), null);
});

test('price ratio: agreement reads 1 whichever side is the quote; a decimals slip is caught', () => {
  // made-up pool: token0 $2, token1 $2,000 → 0.001 token1 per token0
  assert.ok(Math.abs(priceRatio({ poolPrice: 0.001, quoteIs: 1, usd0: 2, usd1: 2000 }) - 1) < 1e-12);
  assert.ok(Math.abs(priceRatio({ poolPrice: 0.001, quoteIs: 0, usd0: 2, usd1: 2000 }) - 1) < 1e-12);
  assert.ok(Math.abs(priceRatio({ poolPrice: 0.001 * 1e12, quoteIs: 1, usd0: 2, usd1: 2000 }) - 1) > 0.02); // 6 vs 18 decimals
  assert.equal(priceRatio({ poolPrice: 0.001, quoteIs: 1, usd0: null, usd1: 2000 }), null);
});
