// Pool discovery for Uniswap v3 and v4: candidate pairs (universe token × quote token × fee tier)
// looked up on-chain. v3 pools come from the factory's getPool; v4 pools have no registry, so
// their ids are computed from the pool key and checked through StateView (an uninitialised pool
// reads sqrtPrice 0). Creation events (PoolCreated, Initialize) give pool ages and catch the pools
// a lookup can't, such as v4 pools with hooks or unusual fees.
import { keccakHex, topic } from './keccak.mjs';
import { encodeCall, decodeWords, signed, toAddress } from './abi.mjs';

export const ZERO = '0x0000000000000000000000000000000000000000';

export const ETHEREUM = {
  name: 'ethereum',
  chainId: 1,
  v3Factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  v3FactoryBlock: 12369621,
  v4PoolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
  v4StateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  // Quote tokens. ETH (address zero) exists only in v4, where native ETH replaces WETH.
  quotes: [
    { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, v3: true, v4: true },
    { symbol: 'ETH', address: ZERO, decimals: 18, v3: false, v4: true, priceAs: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
    { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, v3: true, v4: true },
    { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, v3: true, v4: true },
    { symbol: 'DAI', address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18, v3: true, v4: true },
    { symbol: 'WBTC', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', decimals: 8, v3: true, v4: true },
  ],
};

export const V3_FEES = [100, 500, 3000, 10000];
export const V4_STANDARD = [[100, 1], [500, 10], [3000, 60], [10000, 200]]; // [fee, tickSpacing], no hooks
export const DYNAMIC_FEE = 0x800000;

export const TOPICS = {
  poolCreated: topic('PoolCreated(address,address,uint24,int24,address)'),
  initialize: topic('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
};

const lower = (a) => String(a).toLowerCase();
const addrWord = (a) => lower(a).replace(/^0x/, '').padStart(64, '0');
const uWord = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const hexBytes = (h) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));

export const sortPair = (a, b) => (BigInt(a) < BigInt(b) ? [lower(a), lower(b)] : [lower(b), lower(a)]);

// v4 PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
export function v4PoolId({ currency0, currency1, fee, tickSpacing, hooks = ZERO }) {
  return keccakHex(hexBytes(addrWord(currency0) + addrWord(currency1) + uWord(fee) + uWord(tickSpacing) + addrWord(hooks)));
}

// Every pair of a universe token with a quote token, plus quote × quote pairs; deduplicated.
function pairs(tokens, quotes) {
  const seen = new Set(), out = [];
  const add = (x, y) => {
    if (lower(x) === lower(y)) return;
    const [t0, t1] = sortPair(x, y), k = t0 + t1;
    if (!seen.has(k)) { seen.add(k); out.push([t0, t1]); }
  };
  for (const q of quotes) {
    for (const t of tokens) add(t, q);
    for (const q2 of quotes) add(q, q2);
  }
  return out;
}

export const v3Candidates = (tokens, quotes, fees = V3_FEES) =>
  pairs(tokens, quotes).flatMap(([t0, t1]) => fees.map((fee) => ({ v: 3, t0, t1, fee })));

export const v4Candidates = (tokens, quotes, combos = V4_STANDARD) =>
  pairs(tokens, quotes).flatMap(([t0, t1]) => combos.map(([fee, tickSpacing]) => {
    const key = { currency0: t0, currency1: t1, fee, tickSpacing, hooks: ZERO };
    return { v: 4, t0, t1, fee, tickSpacing, hooks: ZERO, id: v4PoolId(key) };
  }));

export const getPoolCall = (factory, c) => ({
  target: factory,
  data: encodeCall('getPool(address,address,uint24)', [{ t: 'address', v: c.t0 }, { t: 'address', v: c.t1 }, { t: 'uint', v: c.fee }]),
});
export const v4Slot0Call = (stateView, id) => ({ target: stateView, data: encodeCall('getSlot0(bytes32)', [{ t: 'bytes32', v: id }]) });

// A multicall answer → pool address, null = unread (never "no pool"), false = no pool.
export function readGetPool(r) {
  if (!r || !r.ok) return null;
  const w = decodeWords(r.data);
  if (!w || w.length < 1) return null;
  return w[0] === 0n ? false : toAddress(w[0]);
}

// StateView.getSlot0 → { sqrtPriceX96, tick, protocolFee, lpFee }; false = not initialised.
export function readV4Slot0(r) {
  if (!r || !r.ok) return null;
  const w = decodeWords(r.data);
  if (!w || w.length < 4) return null;
  if (w[0] === 0n) return false;
  return { sqrtPriceX96: w[0], tick: Number(signed(w[1])), protocolFee: Number(w[2]), lpFee: Number(w[3]) };
}

// v3 pool slot0 → { sqrtPriceX96, tick, feeProtocol }.
export function readV3Slot0(r) {
  if (!r || !r.ok) return null;
  const w = decodeWords(r.data);
  if (!w || w.length < 7) return null;
  return { sqrtPriceX96: w[0], tick: Number(signed(w[1])), feeProtocol: Number(w[5]) };
}

export function readUint(r) {
  if (!r || !r.ok) return null;
  const w = decodeWords(r.data);
  return w && w.length >= 1 ? w[0] : null;
}

const hexNum = (x) => (x == null ? null : typeof x === 'number' ? x : parseInt(x, 16));

// PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
export function decodePoolCreated(log) {
  const t = log?.topics, d = decodeWords(log?.data);
  if (!t || t.length < 4 || lower(t[0]) !== TOPICS.poolCreated || !d || d.length < 2) return null;
  return {
    v: 3, id: toAddress(d[1]), t0: toAddress(BigInt(t[1])), t1: toAddress(BigInt(t[2])), fee: Number(BigInt(t[3])),
    tickSpacing: Number(signed(d[0])), block: hexNum(log.blockNumber), time: hexNum(log.timeStamp ?? log.blockTimestamp),
  };
}

// Initialize(PoolId indexed id, Currency indexed currency0, Currency indexed currency1, uint24 fee,
//            int24 tickSpacing, IHooks hooks, uint160 sqrtPriceX96, int24 tick)
export function decodeInitialize(log) {
  const t = log?.topics, d = decodeWords(log?.data);
  if (!t || t.length < 4 || lower(t[0]) !== TOPICS.initialize || !d || d.length < 5) return null;
  return {
    v: 4, id: lower(t[1]), t0: toAddress(BigInt(t[2])), t1: toAddress(BigInt(t[3])), fee: Number(d[0]),
    tickSpacing: Number(signed(d[1])), hooks: toAddress(d[2]), sqrtPriceX96: d[3], tick: Number(signed(d[4])),
    block: hexNum(log.blockNumber), time: hexNum(log.timeStamp ?? log.blockTimestamp),
  };
}

// Human price of token0 in token1 from sqrtPriceX96.
export function poolPrice(sqrtPriceX96, d0, d1) {
  if (sqrtPriceX96 == null || !(BigInt(sqrtPriceX96) > 0n)) return null;
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s * 10 ** (d0 - d1);
}

// USD value of the tokens a v3 pool holds. Any missing input → null, never a partial sum.
export function tvlUsd({ bal0, bal1, d0, d1, usd0, usd1 }) {
  if (bal0 == null || bal1 == null || !(usd0 > 0) || !(usd1 > 0) || d0 == null || d1 == null) return null;
  return (Number(bal0) / 10 ** d0) * usd0 + (Number(bal1) / 10 ** d1) * usd1;
}

// The base token's USD price at the pool's own rate, given the quote side's feed price.
export function baseUsdAtPool({ price, quoteIs, quoteUsd }) {
  if (!(price > 0) || !(quoteUsd > 0)) return null;
  return quoteIs === 1 ? price * quoteUsd : quoteUsd / price;
}
