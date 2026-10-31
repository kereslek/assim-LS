import test from 'node:test';
import assert from 'node:assert/strict';
import { selector } from '../lib/keccak.mjs';
import {
  ZERO, ETHEREUM, TOPICS, v4PoolId, v3Candidates, v4Candidates, sortPair, readGetPool, readV4Slot0, readV3Slot0,
  decodePoolCreated, decodeInitialize, poolPrice, tvlUsd, baseUsdAtPool,
} from '../lib/pools.mjs';

const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// Real events, read from the chain (public data).
const UNI_WETH_CREATED = { // the first v3 pool ever, UNI/WETH 0.3%
  topics: [TOPICS.poolCreated, '0x' + w(UNI), '0x' + w(WETH), '0x' + w(3000)],
  data: '0x' + w(60) + w('0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801'), blockNumber: '0xbcbf4b', timeStamp: '0x6091a604',
};
const ETH_USDC_INIT = { // v4 ETH/USDC 0.05%
  topics: [TOPICS.initialize, '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27', '0x' + w(0), '0x' + w(USDC)],
  data: '0x' + w(500) + w(10) + w(0) + w('0x4449d40969b3d337975ed199f72c') + w(195388), blockNumber: '0x14af0e1', timeStamp: '0x6792759b',
};

test('selectors and topics match the published values', () => {
  assert.equal(selector('getPool(address,address,uint24)'), '0x1698ee82');
  assert.equal(selector('decimals()'), '0x313ce567');
  assert.equal(selector('balanceOf(address)'), '0x70a08231');
  assert.equal(selector('getSlot0(bytes32)'), '0xc815641c');
  assert.equal(selector('getLiquidity(bytes32)'), '0xfa6793d5');
  assert.equal(selector('slot0()'), '0x3850c7bd');
  assert.equal(selector('liquidity()'), '0x1a686502');
  assert.equal(TOPICS.poolCreated, '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118');
  assert.equal(TOPICS.initialize, '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438');
});

test('v4 pool ids reproduce real pools, with and without hooks', () => {
  assert.equal(v4PoolId({ currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }), ETH_USDC_INIT.topics[1]);
  // an arbitrary hooked pool from the event stream (taken for its key, nothing else)
  assert.equal(v4PoolId({ currency0: ZERO, currency1: '0xb6f2f0fda9e100d6ba5dcfcd2bd5381e34f4e5eb', fee: 10000, tickSpacing: 200, hooks: '0x014257c9bfb770a94065716188d60f881d1180c0' }),
    '0x6d74e82847362ba8c439d5e1f07cbde9b12e3a8171e215e72b5e4c90b1db0f30');
});

test('creation events decode to the right pools', () => {
  const p = decodePoolCreated(UNI_WETH_CREATED);
  assert.deepEqual(p, { v: 3, id: '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801', t0: UNI, t1: WETH, fee: 3000, tickSpacing: 60, block: 12369739, time: 1620157956 });
  const q = decodeInitialize(ETH_USDC_INIT);
  assert.equal(q.id, ETH_USDC_INIT.topics[1]);
  assert.equal(q.t0, ZERO);
  assert.equal(q.t1, USDC);
  assert.equal(q.fee, 500);
  assert.equal(q.tickSpacing, 10);
  assert.equal(q.hooks, ZERO);
  assert.equal(q.block, 21688545);
  // the event's tick agrees with its own sqrt price
  const raw = (Number(q.sqrtPriceX96) / 2 ** 96) ** 2;
  assert.ok(near(Math.log(raw) / Math.log(1.0001), q.tick, 1));
  // wrong topic or short data → null, not a pool
  assert.equal(decodePoolCreated({ ...UNI_WETH_CREATED, topics: [TOPICS.initialize, ...UNI_WETH_CREATED.topics.slice(1)] }), null);
  assert.equal(decodeInitialize({ ...ETH_USDC_INIT, data: '0x' + w(500) }), null);
  // negative ticks sign-extend
  assert.equal(decodeInitialize({ ...ETH_USDC_INIT, data: '0x' + w(500) + w(10) + w(0) + w(1n << 90n) + w(-195388) }).tick, -195388);
});

test('candidates: every token × quote and quote × quote pair, sorted, no duplicates', () => {
  const T = ['0x' + 'aa'.repeat(20), '0x' + 'bb'.repeat(20)];
  const Q = [WETH, USDC];
  const c3 = v3Candidates(T, Q);
  assert.equal(c3.length, (T.length * Q.length + 1) * 4);
  assert.ok(c3.every((c) => BigInt(c.t0) < BigInt(c.t1)));
  assert.equal(new Set(c3.map((c) => c.t0 + c.t1 + c.fee)).size, c3.length);
  const c4 = v4Candidates([UNI], [ZERO, USDC]);
  assert.ok(c4.some((c) => c.id === ETH_USDC_INIT.topics[1]));
  assert.ok(c4.every((c) => c.id === v4PoolId({ currency0: c.t0, currency1: c.t1, fee: c.fee, tickSpacing: c.tickSpacing })));
  assert.deepEqual(sortPair(WETH, UNI), [UNI, WETH]);
  assert.ok(ETHEREUM.quotes.every((q) => q.address === q.address.toLowerCase()));
});

test('lookup answers: unread is null, no pool is false', () => {
  assert.equal(readGetPool(null), null);
  assert.equal(readGetPool({ ok: false, data: '0x' }), null);
  assert.equal(readGetPool({ ok: true, data: '0x' + w(0) }), false);
  assert.equal(readGetPool({ ok: true, data: '0x' + w('0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801') }), '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801');
  assert.equal(readV4Slot0({ ok: true, data: '0x' + w(0) + w(0) + w(0) + w(0) }), false);
  assert.deepEqual(readV4Slot0({ ok: true, data: '0x' + w(1n << 96n) + w(-5) + w(0) + w(500) }), { sqrtPriceX96: 1n << 96n, tick: -5, protocolFee: 0, lpFee: 500 });
  assert.equal(readV3Slot0({ ok: true, data: '0x' + w(1) }), null);
});

test('prices and TVL: missing inputs give null, never a partial sum', () => {
  const sp = BigInt(Math.round(Math.sqrt(0.003154) * 2 ** 96));
  assert.ok(near(poolPrice(sp, 18, 18), 0.003154, 1e-9));
  assert.ok(near(poolPrice(1n << 96n, 18, 6), 1e12, 1));
  assert.equal(poolPrice(0n, 18, 18), null);
  assert.equal(tvlUsd({ bal0: 2n * 10n ** 18n, bal1: 5n * 10n ** 6n, d0: 18, d1: 6, usd0: 3, usd1: 1 }), 11);
  assert.equal(tvlUsd({ bal0: 1n, bal1: null, d0: 18, d1: 6, usd0: 3, usd1: 1 }), null);
  assert.equal(tvlUsd({ bal0: 1n, bal1: 1n, d0: 18, d1: 6, usd0: 0, usd1: 1 }), null);
  assert.equal(baseUsdAtPool({ price: 0.5, quoteIs: 1, quoteUsd: 4 }), 2);
  assert.equal(baseUsdAtPool({ price: 0.5, quoteIs: 0, quoteUsd: 4 }), 8);
  assert.equal(baseUsdAtPool({ price: null, quoteIs: 0, quoteUsd: 4 }), null);
});
