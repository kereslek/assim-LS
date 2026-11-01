// Real-position check on a made-up pool (MOCKUP · MADE-UP NUMBERS) that books fee growth the way
// v3 Pool.swap does: step by step between initialized ticks, fee ÷ that step's liquidity. Its
// liquidity is four times higher above √P 2.02, and many swaps cross it. Every planted fault must fail the check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare } from '../lib/backtest.mjs';
import { realCheck, realCheckPasses, inRangeCandidates, feeGrowthInside, unchangedPositions, decodePositionEvent, v3PositionKey, POSITION_TOPICS } from '../lib/backtest-real.mjs';
import { keccakHex } from '../lib/keccak.mjs';
import { swapFees } from '../lib/swaps.mjs';

const X96 = 2 ** 96, Q128 = 2 ** 128, B = 2.02, L1 = 1e21, L2 = 4e21, F = 0.003, META = { fee: 3000, feeProtocol: 0x44 };
const RATE = (F / (1 - F)) * 0.75; // LP's share of the fee per unit of net input, after the protocol's quarter
const Lat = (sp) => (sp < B ? L1 : L2);
const tickOf = (sp) => Math.floor(Math.log(sp * sp) / Math.log(1.0001));
let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const swaps = [], truth = [0, 0];
let sp = 2;
for (let i = 0; i < 400; i++) {
  const next = Math.min(2.07, Math.max(1.97, sp * Math.exp((rnd() - 0.5) * 0.04)));
  const up = next > sp, lo = Math.min(sp, next), hi = Math.max(sp, next);
  const steps = lo < B && hi > B ? [[lo, B], [B, hi]] : [[lo, hi]];
  let net = 0;
  for (const [a, b] of steps) { const d = up ? b - a : 1 / a - 1 / b; net += Lat((a + b) / 2) * d; truth[up ? 1 : 0] += d * RATE; }
  swaps.push({ v: 3, in: up ? 1 : 0, amountIn: BigInt(Math.round(net / (1 - F))), amountOut: 1n, sqrtPriceX96: BigInt(Math.round(next * X96)), liquidity: BigInt(Lat(next)),
    tick: tickOf(next), fee: null, block: 100 + i, logIndex: 0, t: (i + 1) * 60e3 });
  sp = next;
}
const win = { start: { t: 0, sp: 2, tick: tickOf(2), L: Lat(2) }, end: { t: 401 * 60e3 } };
const P = sp * sp, then = [123n << 128n, 77n << 128n], now = [0, 1].map((i) => then[i] + BigInt(Math.round(truth[i] * Q128)));
const RANGES = [[tickOf(1.9), tickOf(2.2)], [tickOf(1.95), tickOf(2.1)], [-887220, 887220], [tickOf(1.5), tickOf(2.5)], [tickOf(1.965), tickOf(2.075)], [tickOf(1.99), tickOf(2.05)]];
const positions = RANGES.map(([ta, tb]) => ({ ta, tb }));
const prep = prepare(swaps, { meta: META, d0: 18, d1: 18, ref: 1 });
const withReal = (cands) => cands.map((c) => ({ ...c, then, now }));

test('the engine credits real in-range positions what the pool booked', () => {
  const cands = inRangeCandidates(prep, win, positions);
  assert.equal(cands.length, 5); // the narrowest range lets the price out: it is not a clean comparison
  assert.ok(cands.every((c, i) => i === 0 || c.tb - c.ta >= cands[i - 1].tb - cands[i - 1].ta)); // narrowest first
  const rc = realCheck(withReal(cands), { P, d0: 18, d1: 18, ref: 1 });
  assert.equal(rc.positions, 5);
  assert.equal(rc.within2, 5);
  assert.ok(Math.abs(rc.median - 1) < 1e-4, String(rc.median));
  assert.ok(realCheckPasses(rc));
  assert.ok(swaps.filter((s, i) => i && s.liquidity !== swaps[i - 1].liquidity).length > 20); // the test really crosses
});

test('planted fault: the old method (whole fee ÷ post-swap liquidity) fails the check', () => {
  const old = [0, 0];
  for (const s of swaps) old[s.in] += Number(swapFees(s, META).lp) / Number(s.liquidity);
  const rc = realCheck(withReal(positions.slice(0, 5).map((p) => ({ ...p, credit: old }))), { P, d0: 18, d1: 18, ref: 1 });
  assert.ok(!realCheckPasses(rc), JSON.stringify(rc));
});

test('planted fault: missed swaps, the wrong side, or a missing protocol cut fail the check', () => {
  const missed = prepare(swaps.filter((_, i) => i % 6 !== 0), { meta: META, d0: 18, d1: 18, ref: 1 });
  assert.ok(!realCheckPasses(realCheck(withReal(inRangeCandidates(missed, win, positions)), { P, d0: 18, d1: 18, ref: 1 })));
  const flipped = withReal(inRangeCandidates(prep, win, positions)).map((c) => ({ ...c, credit: [c.credit[1], c.credit[0]] }));
  assert.ok(!realCheckPasses(realCheck(flipped, { P, d0: 18, d1: 18, ref: 1 })));
  const noCut = prepare(swaps, { meta: { ...META, feeProtocol: 0 }, d0: 18, d1: 18, ref: 1 });
  assert.ok(!realCheckPasses(realCheck(withReal(inRangeCandidates(noCut, win, positions)), { P, d0: 18, d1: 18, ref: 1 })));
});

test('nothing comparable gives null, never a pass', () => {
  assert.equal(realCheck([], { P }), null);
  assert.equal(realCheck(positions.map((p) => ({ ...p, credit: [1, 1], then, now: then })), { P }), null); // no fee growth at all
  assert.equal(realCheckPasses(null), false);
  assert.equal(realCheckPasses({ positions: 5, within2: 3 }), false);
  assert.equal(realCheckPasses({ positions: 3, within2: 3 }), true);
});

test('fee growth inside: global less below and above, modulo 2^256', () => {
  const g = [1000n, 50n], lower = [300n, 10n], upper = [200n, 5n];
  assert.deepEqual(feeGrowthInside({ tick: 0, global: g, outsideLower: lower, outsideUpper: upper, ta: -60, tb: 60 }), [500n, 35n]);
  // price below the range: inside = outsideLower − outsideUpper (wrapping is fine: only differences matter)
  assert.deepEqual(feeGrowthInside({ tick: -120, global: g, outsideLower: lower, outsideUpper: upper, ta: -60, tb: 60 }), [100n, 5n]);
  const w = feeGrowthInside({ tick: 0, global: [5n, 5n], outsideLower: [10n, 0n], outsideUpper: [0n, 0n], ta: -60, tb: 60 });
  assert.equal(w[0], BigInt.asUintN(256, -5n));
});

const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const OWNER = '0x' + '5'.repeat(40), owner = '0x' + W(BigInt(OWNER));
test('position events decode; only real liquidity changes count, a fee poke does not', () => {
  const mint = decodePositionEvent({ topics: [POSITION_TOPICS.mint, owner, '0x' + W(-600), '0x' + W(600)], data: '0x' + W(7) + W(10n ** 18n) + W(1) + W(1), blockNumber: '0x10', logIndex: '0x1' });
  assert.deepEqual([mint.owner, mint.ta, mint.tb, mint.change, mint.block], [OWNER, -600, 600, 10n ** 18n, 16]);
  const burn = decodePositionEvent({ topics: [POSITION_TOPICS.burn, owner, '0x' + W(-600), '0x' + W(600)], data: '0x' + W(5n) + W(1) + W(1), blockNumber: '0x20', logIndex: '0x0' });
  assert.equal(burn.change, -5n);
  const mod = decodePositionEvent({ topics: [POSITION_TOPICS.modify, '0x' + 'ab'.repeat(32), owner], data: '0x' + W(-120) + W(240) + W(-3) + W(42), blockNumber: '0x30', logIndex: '0x2' });
  assert.deepEqual([mod.owner, mod.ta, mod.tb, mod.change, mod.salt], [OWNER, -120, 240, -3n, '0x' + W(42)]);
  const ev = (o, ta, change, block) => ({ owner: o, ta, tb: 600, salt: null, change, block });
  const events = [ev('a', -600, 5n, 10), ev('a', -600, 0n, 60), ev('b', -600, 5n, 10), ev('b', -600, -1n, 70), ev('c', -600, 5n, 55), ev('d', -900, 9n, 50)];
  assert.deepEqual(unchangedPositions(events, 50, 100).map((p) => p.owner).sort(), ['a', 'd']); // b changed, c came after the start
});

test('the v3 position key packs owner and both int24 ticks (two’s complement)', () => {
  const hex = OWNER.slice(2) + 'ffffc4' + '00003c';
  assert.equal(v3PositionKey(OWNER, -60, 60), keccakHex(Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)))));
});
