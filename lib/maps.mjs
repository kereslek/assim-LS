// Liquidity maps through Multicall3, all at one block: every tickBitmap word a pool can use, then
// each initialized tick's liquidityNet, rebuilt into segments with the completeness checks from
// v3math. v3 reads the pool contract; v4 reads StateView by pool id. Any unread word or tick makes
// the map unread for that pool: a partial map would show walls that aren't there.
import { encodeCall, decodeWords, signed } from './abi.mjs';
import { liquidityMap, ticksInWord, bitmapWordRange } from './v3math.mjs';

export const bitmapCall = (pool, stateView, word) => (pool.v === 3
  ? { target: pool.id, data: encodeCall('tickBitmap(int16)', [{ t: 'int', v: word }]) }
  : { target: stateView, data: encodeCall('getTickBitmap(bytes32,int16)', [{ t: 'bytes32', v: pool.id }, { t: 'int', v: word }]) });

export const tickCall = (pool, stateView, tick) => (pool.v === 3
  ? { target: pool.id, data: encodeCall('ticks(int24)', [{ t: 'int', v: tick }]) }
  : { target: stateView, data: encodeCall('getTickLiquidity(bytes32,int24)', [{ t: 'bytes32', v: pool.id }, { t: 'int', v: tick }]) });

export const feeGrowthCalls = (pool, stateView) => (pool.v === 3
  ? [{ target: pool.id, data: encodeCall('feeGrowthGlobal0X128()') }, { target: pool.id, data: encodeCall('feeGrowthGlobal1X128()') }]
  : [{ target: stateView, data: encodeCall('getFeeGrowthGlobals(bytes32)', [{ t: 'bytes32', v: pool.id }]) }]);

export function readFeeGrowth(pool, answers) {
  const w = answers.map((r) => (r && r.ok ? decodeWords(r.data) : null));
  if (pool.v === 3) return w[0]?.length && w[1]?.length ? [w[0][0], w[1][0]] : null;
  return w[0]?.length >= 2 ? [w[0][0], w[0][1]] : null;
}

export const wordsFor = (tickSpacing) => {
  const { lo, hi } = bitmapWordRange(tickSpacing);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
};

// pools: [{ v, id, tickSpacing, tick, liquidity }] → one map (liquidityMap's shape) or { unread } per pool.
export async function readMaps(mc, pools, { stateView, tag = 'latest' } = {}) {
  const plan = pools.map((p) => wordsFor(p.tickSpacing));
  const bm = await mc(pools.flatMap((p, i) => plan[i].map((w) => bitmapCall(p, stateView, w))), tag);
  let k = 0;
  const ticks = pools.map((p, i) => {
    const out = [];
    let unread = false;
    for (const w of plan[i]) {
      const r = bm[k++], v = r && r.ok ? decodeWords(r.data)?.[0] : null;
      if (v == null) unread = true; else out.push(...ticksInWord(w, v, p.tickSpacing));
    }
    return unread ? null : out;
  });
  const tc = await mc(pools.flatMap((p, i) => (ticks[i] || []).map((t) => tickCall(p, stateView, t))), tag);
  k = 0;
  return pools.map((p, i) => {
    if (!ticks[i]) return { unread: 'bitmap', words: plan[i].length };
    const rows = [];
    let unread = 0;
    for (const t of ticks[i]) {
      const r = tc[k++], w = r && r.ok ? decodeWords(r.data) : null;
      if (!w || w.length < 2) unread++; else rows.push({ tick: t, liquidityNet: signed(w[1]) });
    }
    if (unread) return { unread: 'ticks', missing: unread };
    return { ...liquidityMap({ ticks: rows, tickCurrent: p.tick, liquidity: p.liquidity }), words: plan[i].length };
  });
}
