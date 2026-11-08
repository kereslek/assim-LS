// PancakeSwap v3 and Base (lib/pools.mjs, lib/swaps.mjs, lib/checks.mjs, lib/chains.mjs, lib/discover.mjs) on
// made-up numbers (MOCKUP · MADE-UP NUMBERS) and public contract facts: the feeProtocol decode (two 1/10,000 shares
// in a uint32, not Uniswap's nibbles), PancakeSwap's Swap event, the fee split and the fee-identity replay with its
// cut, Base's two-era block clock (2 s, then 0.2 s blocks) and the discovery helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { topic } from '../lib/keccak.mjs';
import { v3ProtocolCut, v3LpKeeps, PANCAKE_V3, BASE, ZERO, TOPICS } from '../lib/pools.mjs';
import { SWAP_TOPICS, decodeSwap, swapFees } from '../lib/swaps.mjs';
import { replayFeeGrowth } from '../lib/checks.mjs';
import { CHAINS, timeOfBlock, blockAtTime, blocksBack, ageOfBlocksBack, blocksPerDay } from '../lib/chains.mjs';
import { pastBlockAnswer } from '../lib/snapshots.mjs';
import { lookupV3, stampCreations, firstTradedAt, priceTvl } from '../lib/discover.mjs';
import { amount1Delta } from '../lib/v3math.mjs';

const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const FP = 3300 + 3400 * 65536; // what a probe read on a PancakeSwap pool (8 Nov 2026): 33% / 34%

test('PancakeSwap feeProtocol: two shares in 1/10,000ths, token0 in the low 16 bits', () => {
  assert.deepEqual(v3ProtocolCut(FP, 0, 'pancakeswap'), { num: 3300n, den: 10000n });
  assert.deepEqual(v3ProtocolCut(FP, 1, 'pancakeswap'), { num: 3400n, den: 10000n });
  const k = v3LpKeeps(FP, 'pancakeswap');
  assert.ok(Math.abs(k[0] - 0.67) < 1e-12 && Math.abs(k[1] - 0.66) < 1e-12);
  assert.deepEqual(v3LpKeeps(0, 'pancakeswap'), [1, 1], 'off: LPs keep everything');
  assert.equal(v3ProtocolCut(10001, 0, 'pancakeswap'), null, 'over 100%: impossible, unread');
  // Uniswap's nibbles: 1/N per side, 0 = off
  assert.deepEqual(v3LpKeeps(0x44), [0.75, 0.75]);
  assert.deepEqual(v3LpKeeps(0x60), [1, 1 - 1 / 6]);
  assert.equal(v3ProtocolCut(null, 0), null, 'unread → null, never assumed');
  // planted fault: reading PancakeSwap's word as Uniswap nibbles is refused (over 255), and its low byte would
  // claim the wrong cut
  assert.equal(v3ProtocolCut(FP, 0, 'uniswap'), null);
  assert.notDeepEqual(v3LpKeeps(FP & 0xff), k);
  assert.deepEqual(PANCAKE_V3.fees, [100, 500, 2500, 10000]);
  assert.equal(PANCAKE_V3.spacing[2500], 50);
});

test('PancakeSwap\'s Swap event: its own topic, two more words, decoded with the venue and its protocol fees', () => {
  assert.equal(SWAP_TOPICS.pcs3, topic('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'));
  assert.equal(SWAP_TOPICS.pcs3, '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83');
  assert.notEqual(SWAP_TOPICS.pcs3, SWAP_TOPICS.v3);
  const log = { address: '0xPOOL', topics: [SWAP_TOPICS.pcs3, '0x' + w(7), '0x' + w(8)], data: '0x' + w(10n ** 18n) + w(-(2n * 10n ** 9n)) + w(2n ** 96n) + w(10n ** 20n) + w(-5) + w(825n * 10n ** 12n) + w(0), blockNumber: '0x10', logIndex: '0x1', transactionHash: '0xt' };
  const s = decodeSwap(log);
  assert.equal(s.dex, 'pancakeswap'); assert.equal(s.v, 3); assert.equal(s.in, 0); assert.equal(s.tick, -5);
  assert.deepEqual(s.protocolFees, [825n * 10n ** 12n, 0n]);
  // the fee split: 0.25% tier, 33% of it to the protocol on token0 in
  const f = swapFees(s, { fee: 2500, feeProtocol: FP, dex: 'pancakeswap' });
  assert.equal(f.total, 25n * 10n ** 14n);
  assert.equal(f.protocol, (25n * 10n ** 14n * 3300n) / 10000n);
  assert.equal(f.protocol, s.protocolFees[0], 'our decode reproduces the event\'s own protocol fee');
  // a PancakeSwap swap read against Uniswap settings (or the reverse) is null, never a guess
  assert.equal(swapFees(s, { fee: 2500, feeProtocol: 0x44 }), null);
  const uni = decodeSwap({ ...log, topics: [SWAP_TOPICS.v3, ...log.topics.slice(1)] });
  assert.equal(uni.dex, 'uniswap');
  assert.equal(swapFees(uni, { fee: 3000, feeProtocol: FP, dex: 'pancakeswap' }), null);
});

test('the fee-identity replay books PancakeSwap\'s cut: (fee − fee·fp/10,000) ÷ liquidity', () => {
  const L = 10n ** 20n, P0 = 2n ** 96n, P1 = P0 + P0 / 1000n;
  const net = amount1Delta(P0, P1, L, true), fee = 500n;
  const gross = (net * 1000000n + (1000000n - fee) - 1n) / (1000000n - fee); // the input that leaves net after a 0.05% fee
  const swap = { v: 3, dex: 'pancakeswap', in: 1, amountIn: gross, sqrtPriceX96: P1, liquidity: L, block: 1, logIndex: 0 };
  const meta = { fee: 500, feeProtocol: FP, dex: 'pancakeswap' };
  const rep = replayFeeGrowth({ swaps: [swap], meta, start: { sqrtPriceX96: P0, liquidity: L } });
  const f = gross - net, want = ((f - (f * 3400n) / 10000n) << 128n) / L;
  assert.equal(rep.growth[1], want);
  // planted fault: the same swap with Uniswap's 1/4 would book 75% instead of 66%
  const uniRep = replayFeeGrowth({ swaps: [{ ...swap, dex: 'uniswap' }], meta: { fee: 500, feeProtocol: 0x44 }, start: { sqrtPriceX96: P0, liquidity: L } });
  assert.ok(Math.abs(Number(uniRep.growth[1]) / Number(rep.growth[1]) - 0.75 / 0.66) < 0.01);
  // flash payments to a PancakeSwap pool lose the same share
  const flash = replayFeeGrowth({ swaps: [], extras: [{ kind: 'flash', v: 3, paid: [10000n, 0n], block: 2, logIndex: 0 }], meta, start: { sqrtPriceX96: P0, liquidity: L } });
  assert.equal(flash.growth[0], ((10000n - 3300n) << 128n) / L);
});

test('Base\'s block clock: 2 s blocks until 5 Nov 2026 18:00 UTC, 0.2 s since (block numbers read by timestamp)', () => {
  const B = CHAINS.base;
  // reference blocks (Base block-by-timestamp lookups, 8 Nov 2026)
  for (const [t, b] of [[1794132364, 54709946], [1794045964, 54277946], [1791540364, 52375508], [1786356364, 49783508], [1793898000, 53554326], [1793905200, 53574126]]) {
    assert.equal(blockAtTime(B, t), b, `block at ${t}`);
    assert.ok(Math.abs(timeOfBlock(B, b) - t) < 1, `time of ${b}`);
  }
  assert.equal(blocksPerDay(B), 432000);
  const head = 54709946, nowSec = 1794132364;
  assert.equal(blocksBack(B, { block: head, nowSec, secBack: 86400 }), 432000);
  assert.equal(blocksBack(B, { block: head, nowSec, secBack: 30 * 86400 }), head - 52375508, 'across the switch');
  // the stale-state check takes the era clock's age: 30 days back is 2.33M blocks, not 30 × 432,000
  const back = head - 52375508, age = ageOfBlocksBack(B, { block: head, back });
  assert.ok(Math.abs(age - 30 * 86400) < 2);
  assert.equal(pastBlockAnswer(nowSec - 30 * 86400, { nowSec, blocksBack: back, ageSec: age }), true);
  assert.equal(pastBlockAnswer(nowSec - 30 * 86400, { nowSec, blocksBack: back, secPerBlock: 0.2 }), false, 'a flat 0.2 s would call real state stale');
  assert.equal(pastBlockAnswer(nowSec - 60, { nowSec, blocksBack: back, ageSec: age }), false, "today's state for an old block");
  // Ethereum keeps the anchor-based clock (no eras): 12 s for a day
  assert.equal(timeOfBlock(CHAINS.ethereum, 1), null);
  assert.equal(blocksBack(CHAINS.ethereum, { block: 1e7, nowSec, secBack: 86400 }), 7200);
  assert.equal(BASE.chainId, 8453);
});

test('discovery helpers: lookups through a factory, ages from a recent window, the first trading day', async () => {
  const pool = '0x' + 'ab'.repeat(20);
  const mc = async (calls) => calls.map((c) => (c.data.includes('0bb8') ? { ok: true, data: '0x' + w(pool) } : c.data.includes('09c4') ? null : { ok: true, data: '0x' + w(0) }));
  const r = await lookupV3(mc, 'latest', { factory: PANCAKE_V3.factory, fees: [500, 2500, 3000], tokens: ['0x' + '11'.repeat(20)], quotes: [BASE.quotes[0].address], dex: 'pancakeswap' });
  assert.equal(r.candidates, 3); assert.equal(r.unread, 1, 'an unanswered lookup is unread, not "no pool"');
  assert.deepEqual(r.pools.map((p) => [p.id, p.fee, p.dex]), [[pool, 3000, 'pancakeswap']]);
  const ps = [{ id: 'a' }, { id: 'b' }];
  assert.equal(stampCreations(ps, [{ id: 'a', block: 5, time: 100 }]), 1);
  assert.equal(ps[0].createdAt, 100); assert.equal(ps[1].createdAt, undefined, 'older than the window: unknown');
  assert.equal(firstTradedAt({ dsPairs: [{ createdAt: 1.7e12 }, { createdAt: 1.6e12 }], ethFirst: 1.65e9 }), 1.6e9);
  assert.equal(firstTradedAt({ dsPairs: [{ createdAt: null }] }), null);
  // TVL: any unpriced side → null, never a partial sum
  const v = [{ t0: 'x', t1: 'q', bal0: 10n ** 18n, bal1: 10n ** 6n, liquidity: 1n, slot0: { sqrtPriceX96: 2n ** 96n } }];
  priceTvl(v, { dec: new Map([['x', 18], ['q', 6]]), usd: new Map([['q', 1]]), quoteSet: new Set(['q']) });
  assert.equal(v[0].tvl, null);
  assert.equal(TOPICS.poolCreated, topic('PoolCreated(address,address,uint24,int24,address)'), 'PancakeSwap\'s factory emits the same PoolCreated');
  assert.equal(ZERO, '0x0000000000000000000000000000000000000000');
});
