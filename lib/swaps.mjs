// Swap events → per-pool volume and fees. Sign conventions differ and were checked on real swaps:
// a v3 pool reports amounts from its own side (positive = paid into the pool), while v4's
// PoolManager reports them from the trader's side (negative = paid in). The input token is where
// the fee is charged. v3 fees: the pool's tier, of which the protocol keeps 1/N (slot0.feeProtocol,
// one nibble per input token). v4 fees: the event carries the whole swap fee; the protocol's part
// is slot0.protocolFee for that direction (12 bits each), the rest goes to LPs.
import { topic } from './keccak.mjs';
import { decodeWords, signed, toAddress } from './abi.mjs';

export const SWAP_TOPICS = {
  v3: topic('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  v4: topic('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
};

const hexNum = (x) => (typeof x === 'number' ? x : parseInt(x, 16));
const abs = (x) => (x < 0n ? -x : x);

export function decodeSwap(log) {
  const t = log?.topics, d = decodeWords(log?.data);
  if (!t || !d) return null;
  const t0 = String(t[0]).toLowerCase();
  if (t0 === SWAP_TOPICS.v3 && d.length >= 5) {
    const a0 = signed(d[0]), a1 = signed(d[1]);
    const inSide = a0 > 0n ? 0 : a1 > 0n ? 1 : null;
    return {
      v: 3, pool: String(log.address).toLowerCase(), in: inSide, amountIn: inSide === 0 ? a0 : inSide === 1 ? a1 : 0n,
      amountOut: inSide === 0 ? abs(a1) : inSide === 1 ? abs(a0) : 0n, sqrtPriceX96: d[2], liquidity: d[3], tick: Number(signed(d[4])),
      fee: null, sender: t[1] ? toAddress(BigInt(t[1])) : null, recipient: t[2] ? toAddress(BigInt(t[2])) : null,
      block: hexNum(log.blockNumber), logIndex: hexNum(log.logIndex), tx: log.transactionHash,
    };
  }
  if (t0 === SWAP_TOPICS.v4 && d.length >= 6) {
    const a0 = signed(d[0]), a1 = signed(d[1]);
    const inSide = a0 < 0n ? 0 : a1 < 0n ? 1 : null;
    return {
      v: 4, pool: String(t[1]).toLowerCase(), in: inSide, amountIn: inSide === 0 ? -a0 : inSide === 1 ? -a1 : 0n,
      amountOut: inSide === 0 ? abs(a1) : inSide === 1 ? abs(a0) : 0n, sqrtPriceX96: d[2], liquidity: d[3], tick: Number(signed(d[4])),
      fee: Number(d[5]), sender: t[2] ? toAddress(BigInt(t[2])) : null, recipient: null,
      block: hexNum(log.blockNumber), logIndex: hexNum(log.logIndex), tx: log.transactionHash,
    };
  }
  return null;
}

// Fee split of one swap, in raw units of the input token: { total, protocol, lp }.
// pool: v3 { fee, feeProtocol }, v4 { protocolFee }. Missing protocol settings → null (never assume).
export function swapFees(s, pool) {
  if (!s || s.in == null || !pool) return null;
  if (s.v === 3) {
    if (pool.fee == null || pool.feeProtocol == null) return null;
    const total = (s.amountIn * BigInt(pool.fee)) / 1000000n;
    const n = s.in === 0 ? pool.feeProtocol % 16 : pool.feeProtocol >> 4;
    const protocol = n > 0 ? total / BigInt(n) : 0n;
    return { total, protocol, lp: total - protocol };
  }
  if (pool.protocolFee == null || s.fee == null) return null;
  const pf = s.in === 0 ? pool.protocolFee & 0xfff : pool.protocolFee >> 12;
  const total = (s.amountIn * BigInt(s.fee)) / 1000000n;
  const protocol = (s.amountIn * BigInt(pf)) / 1000000n;
  return { total, protocol, lp: total > protocol ? total - protocol : 0n };
}

// Sum swaps per pool: volume (input amounts) and fees per token, raw units; counts and distinct txs.
export function summarize(swaps, poolsById) {
  const out = new Map();
  for (const s of swaps) {
    if (!s || s.in == null) continue;
    const p = poolsById.get(s.pool);
    let r = out.get(s.pool);
    if (!r) { r = { swaps: 0, txs: new Set(), volume: [0n, 0n], lp: [0n, 0n], protocol: [0n, 0n], unpriced: 0, first: s.block, last: s.block }; out.set(s.pool, r); }
    r.swaps++;
    r.txs.add(s.tx);
    r.volume[s.in] += s.amountIn;
    const f = swapFees(s, p);
    if (f) { r.lp[s.in] += f.lp; r.protocol[s.in] += f.protocol; } else r.unpriced++;
    r.first = Math.min(r.first, s.block);
    r.last = Math.max(r.last, s.block);
  }
  for (const r of out.values()) { r.txs = r.txs.size; }
  return out;
}

// Raw two-token amounts → USD; null if either side is needed but unpriced.
export function usdOfPair([a0, a1], d0, d1, usd0, usd1) {
  const need0 = a0 > 0n, need1 = a1 > 0n;
  if ((need0 && !(usd0 > 0)) || (need1 && !(usd1 > 0))) return null;
  return (need0 ? (Number(a0) / 10 ** d0) * usd0 : 0) + (need1 ? (Number(a1) / 10 ** d1) * usd1 : 0);
}
