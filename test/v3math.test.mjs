import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCall, decodeWords, signed, toAddress } from '../lib/abi.mjs';
import { tickToPrice, priceToTick, amountsInRange, liquidityMap, ticksInWord, bitmapWordRange } from '../lib/v3math.mjs';

// Made-up positions -> initialized ticks, as the pool itself stores them.
export function poolFrom(positions, tickCurrent) {
  const net = new Map();
  for (const p of positions) {
    net.set(p.lo, (net.get(p.lo) || 0n) + p.L);
    net.set(p.hi, (net.get(p.hi) || 0n) - p.L);
  }
  const ticks = [...net].filter(([, n]) => n !== 0n).map(([tick, liquidityNet]) => ({ tick, liquidityNet }));
  const liquidity = positions.filter((p) => p.lo <= tickCurrent && tickCurrent < p.hi).reduce((s, p) => s + p.L, 0n);
  return { ticks, tickCurrent, liquidity };
}

test('abi: getPool call encodes addresses and fee', () => {
  const data = encodeCall('getPool(address,address,uint24)', [
    { t: 'address', v: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
    { t: 'address', v: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    { t: 'uint', v: 3000 },
  ]);
  assert.equal(data.slice(0, 10), '0x1698ee82');
  assert.equal(data.length, 10 + 3 * 64);
  assert.ok(data.endsWith('0bb8'));
});

test('abi: negative int24 round-trips through a 256-bit word', () => {
  const data = encodeCall('ticks(int24)', [{ t: 'int', v: -887220 }]);
  const w = decodeWords('0x' + data.slice(10))[0];
  assert.equal(signed(w), -887220n);
  assert.equal(toAddress(decodeWords('0x' + '0'.repeat(24) + '1f9840a85d5af5bf1d1762f925bdaddc4201f984')[0]), '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984');
  assert.equal(decodeWords('not hex'), null);
});

test('tick and price convert both ways', () => {
  assert.ok(Math.abs(tickToPrice(0) - 1) < 1e-12);
  for (const t of [-200000, -60, 0, 59, 123456]) assert.ok(Math.abs(priceToTick(tickToPrice(t) * 1.00001) - t) <= 1);
  assert.ok(Math.abs(tickToPrice(-201000, 18, 6) - Math.pow(1.0001, -201000) * 1e12) < 1e-6);
});

test('a symmetric range at price 1 holds equal amounts of both tokens', () => {
  const [a0, a1] = amountsInRange(10n ** 18n, -600, 600, 1);
  assert.ok(Math.abs(a0 - a1) / a1 < 1e-9);
  assert.deepEqual(amountsInRange(10n ** 18n, 600, 1200, 1).map((x) => x > 0), [true, false]); // above: token0 only
  assert.deepEqual(amountsInRange(10n ** 18n, -1200, -600, 1).map((x) => x > 0), [false, true]); // below: token1 only
});

test('liquidity map: complete read passes every check', () => {
  const pool = poolFrom([
    { lo: -6000, hi: -3000, L: 10n ** 21n },
    { lo: 2400, hi: 4800, L: 8n * 10n ** 20n },
    { lo: -600, hi: 600, L: 10n ** 19n },
    { lo: -887220, hi: 887220, L: 10n ** 18n },
  ], 120);
  const m = liquidityMap(pool);
  assert.equal(m.checks.netSumZero, true);
  assert.equal(m.checks.neverNegative, true);
  assert.equal(m.checks.matchesPool, true);
  assert.equal(m.checks.walkedLiquidity, 10n ** 19n + 10n ** 18n);
});

test('planted fault: one missing tick is caught', () => {
  const pool = poolFrom([{ lo: -6000, hi: -3000, L: 10n ** 21n }, { lo: -600, hi: 600, L: 10n ** 19n }], 0);
  pool.ticks = pool.ticks.filter((t) => t.tick !== -6000);
  const m = liquidityMap(pool);
  assert.equal(m.checks.netSumZero, false);
  assert.equal(m.checks.matchesPool, false);
  assert.equal(m.checks.neverNegative, false);
});

test('tick bitmap words map back to ticks', () => {
  assert.deepEqual(ticksInWord(0, 1n, 60), [0]);
  assert.deepEqual(ticksInWord(-1, 1n << 255n, 60), [-60]);
  assert.deepEqual(ticksInWord(2, 0b101n, 10), [5120, 5140]);
  assert.deepEqual(bitmapWordRange(60), { lo: -58, hi: 57 });
  assert.deepEqual(bitmapWordRange(1), { lo: -3466, hi: 3465 });
});
