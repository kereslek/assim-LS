import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSwap, swapFees, summarize, usdOfPair, SWAP_TOPICS } from '../lib/swaps.mjs';

// Real swaps, read from the chain (public data): v3 UNI/WETH 0.3% (token0 UNI, token1 WETH) and
// v4 ETH/USDC 0.05% (currency0 ETH, currency1 USDC). Directions were checked against the price moves.
// Sender and recipient topics are replaced with a made-up address; amounts and prices are as read.
const V3_POOL = '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801';
const v3buy = { address: V3_POOL, topics: [SWAP_TOPICS.v3, '0x' + '0'.repeat(24) + '7777777777777777777777777777777777777777', '0x' + '0'.repeat(24) + '7777777777777777777777777777777777777777'],
  data: '0xffffffffffffffffffffffffffffffffffffffffffffffe3a70adec2cd2f2c9700000000000000000000000000000000000000000000000016d0a94a2abe000000000000000000000000000000000000000000000e55621d465d1d64086d7d92000000000000000000000000000000000000000000002a4baa768229550fa2b0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1ec9',
  blockNumber: '0x1917573', logIndex: '0x192', transactionHash: '0xfe1f' };
const v3sell = { address: V3_POOL, topics: [SWAP_TOPICS.v3, '0x' + '0'.repeat(24) + '7777777777777777777777777777777777777777', '0x' + '0'.repeat(24) + '7777777777777777777777777777777777777777'],
  data: '0x00000000000000000000000000000000000000000000000019d5843b1104722dffffffffffffffffffffffffffffffffffffffffffffffffffeb5451be61bad800000000000000000000000000000000000000000e5561a029b52ccf0af626af000000000000000000000000000000000000000000002a4baa768229550fa2b0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1ec9',
  blockNumber: '0x1917576', logIndex: '0x69', transactionHash: '0x10ea' };
const V4_ID = '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27';
const v4buyEth = { address: '0x000000000004444c5dc75cb358380d2e3de08a90', topics: [SWAP_TOPICS.v4, V4_ID, '0x' + '0'.repeat(24) + '7777777777777777777777777777777777777777'],
  data: '0x0000000000000000000000000000000000000000000000000acc8747827c8f26ffffffffffffffffffffffffffffffffffffffffffffffffffffffff9759c07f000000000000000000000000000000000000000000031cc58222b45009c32f8600000000000000000000000000000000000000000000000002260e9350cf1bb7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcf63a0000000000000000000000000000000000000000000000000000000000000271',
  blockNumber: '0x1918906', logIndex: '0x2e', transactionHash: '0xb600' };
const v4sellEth = { address: '0x000000000004444c5dc75cb358380d2e3de08a90', topics: [SWAP_TOPICS.v4, V4_ID, '0x' + '0'.repeat(24) + '7777777777777777777777777777777777777777'],
  data: '0xfffffffffffffffffffffffffffffffffffffffffffffffff9e08740a2efb9a0000000000000000000000000000000000000000000000000000000003b45df32000000000000000000000000000000000000000000031cb32a8f09e11d42334d00000000000000000000000000000000000000000000000002270b458b311548fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcf6380000000000000000000000000000000000000000000000000000000000000271',
  blockNumber: '0x1918906', logIndex: '0x11f', transactionHash: '0x96d9' };

test('swap topics are the published ones', () => {
  assert.equal(SWAP_TOPICS.v3, '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  assert.equal(SWAP_TOPICS.v4, '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f');
});

test('v3: positive amount = paid into the pool; the price moves the way the input says', () => {
  const buy = decodeSwap(v3buy), sell = decodeSwap(v3sell);
  assert.equal(buy.in, 1); // WETH in, UNI out
  assert.equal(buy.amountIn, 0x16d0a94a2abe0000n);
  assert.equal(sell.in, 0); // UNI in
  assert.ok(sell.sqrtPriceX96 < buy.sqrtPriceX96); // selling token0 lowers token0's price
  assert.equal(buy.pool, V3_POOL);
  assert.ok(Math.abs(Math.pow(1.0001, buy.tick) - 0.003135) < 0.0001); // ≈ WETH per UNI
});

test('v4: negative amount = paid in by the trader (the opposite of v3)', () => {
  const buy = decodeSwap(v4buyEth), sell = decodeSwap(v4sellEth);
  assert.equal(buy.in, 1); // USDC in, ETH out
  assert.equal(buy.amountIn, 0x68a63f81n);
  assert.equal(sell.in, 0); // ETH in
  assert.equal(sell.amountIn, 0x061f78bf5d104660n);
  assert.equal(buy.pool, V4_ID);
  assert.equal(buy.fee, 625); // 0.05% LP fee plus a 0.0125% protocol fee
  assert.ok(Math.abs(Math.pow(1.0001, buy.tick) * 1e12 - 2250) < 20); // ≈ USDC per ETH
});

test('fee split: the protocol cut is read, never assumed', () => {
  const s3 = decodeSwap(v3sell);
  const f3 = swapFees(s3, { fee: 3000, feeProtocol: 0x66 }); // made-up setting: 1/6 to the protocol
  assert.equal(f3.total, (s3.amountIn * 3000n) / 1000000n);
  assert.equal(f3.protocol, f3.total / 6n);
  assert.equal(f3.lp + f3.protocol, f3.total);
  assert.equal(swapFees(s3, { fee: 3000, feeProtocol: 0 }).protocol, 0n);
  assert.equal(swapFees(s3, { fee: 3000 }), null); // unknown protocol setting → no number
  const s4 = decodeSwap(v4sellEth);
  const f4 = swapFees(s4, { protocolFee: 125 | (125 << 12) });
  assert.equal(f4.total, (s4.amountIn * 625n) / 1000000n);
  assert.equal(f4.protocol, (s4.amountIn * 125n) / 1000000n);
  assert.ok(Math.abs(Number(f4.lp) / Number(s4.amountIn) - 0.0005) < 1e-6); // LPs keep 0.05% of the input
  assert.equal(swapFees(s4, {}), null);
});

test('summaries add per pool and per input token; unpriced stays visible', () => {
  const pools = new Map([[V3_POOL, { fee: 3000, feeProtocol: 0 }], [V4_ID, {}]]);
  const sum = summarize([v3buy, v3sell, v4buyEth, v4sellEth].map(decodeSwap), pools);
  const a = sum.get(V3_POOL), b = sum.get(V4_ID);
  assert.equal(a.swaps, 2);
  assert.equal(a.volume[1], 0x16d0a94a2abe0000n);
  assert.equal(a.lp[0], (0x19d5843b1104722dn * 3000n) / 1000000n);
  assert.equal(b.unpriced, 2); // v4 pool without its protocol setting: counted, not priced
  assert.equal(usdOfPair([10n ** 18n, 0n], 18, 6, 2000, null), 2000);
  assert.equal(usdOfPair([10n ** 18n, 1n], 18, 6, 2000, null), null);
  assert.equal(decodeSwap({ topics: ['0x' + '1'.repeat(64)], data: '0x' }), null);
});
