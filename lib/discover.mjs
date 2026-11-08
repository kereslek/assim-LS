// Pool discovery for the venues added after Ethereum's Uniswap list (scripts/pools.mjs): PancakeSwap v3 on
// Ethereum and Base, and Base's Uniswap v3 and v4. The same method as Ethereum's: candidate pairs (universe
// token × quote token × fee tier) looked up at one block through each factory (v4: computed pool ids checked
// through StateView), their state and balances read, TVL priced two ways; creation events over a recent
// window give the young pools' ages (an older pool's age stays unknown: null, never a guess).
// Every function takes its RPC through arguments, so tests run it on a fake chain.
import { encodeCall } from './abi.mjs';
import { ZERO, v3Candidates, v4Candidates, getPoolCall, v4Slot0Call, readGetPool, readV4Slot0, readV3Slot0, readUint, poolPrice, tvlUsd, baseUsdAtPool, decodePoolCreated, decodeInitialize, TOPICS } from './pools.mjs';
import { logsAdaptive } from './logs-adaptive.mjs';

// v3-style lookups through one factory. Returns { pools: [{ v: 3, dex, id, t0, t1, fee }], candidates, unread }.
export async function lookupV3(mc, tag, { factory, fees, tokens, quotes, dex }) {
  const cand = v3Candidates(tokens, quotes, fees);
  const r = await mc(cand.map((c) => getPoolCall(factory, c)), tag);
  const pools = [];
  let unread = 0;
  cand.forEach((c, i) => { const a = readGetPool(r[i]); if (a === null) unread++; else if (a) pools.push({ ...c, v: 3, dex, id: a }); });
  return { pools, candidates: cand.length, unread };
}

// v4 standard keys (no hooks) through StateView. Returns { pools, candidates, unread }.
export async function lookupV4(mc, tag, { stateView, tokens, quotes }) {
  const cand = v4Candidates(tokens, quotes);
  const r = await mc(cand.map((c) => v4Slot0Call(stateView, c.id)), tag);
  const pools = [];
  let unread = 0;
  cand.forEach((c, i) => { const s = readV4Slot0(r[i]); if (s === null) unread++; else if (s) pools.push({ ...c, dex: 'uniswap', slot0: s }); });
  return { pools, candidates: cand.length, unread };
}

// State: v3-style price, active liquidity and token balances; v4 active liquidity (and slot0 when missing).
// Returns the number of pools with something unread.
export async function readState(mc, tag, { v3 = [], v4 = [], stateView }) {
  const st3 = await mc(v3.flatMap((p) => [
    { target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') },
    { target: p.t0, data: encodeCall('balanceOf(address)', [{ t: 'address', v: p.id }]) },
    { target: p.t1, data: encodeCall('balanceOf(address)', [{ t: 'address', v: p.id }]) },
  ]), tag);
  v3.forEach((p, i) => { p.slot0 = readV3Slot0(st3[4 * i]); p.liquidity = readUint(st3[4 * i + 1]); p.bal0 = readUint(st3[4 * i + 2]); p.bal1 = readUint(st3[4 * i + 3]); });
  const st4 = await mc(v4.flatMap((p) => [v4Slot0Call(stateView, p.id), { target: stateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }]), tag);
  v4.forEach((p, i) => { const s = readV4Slot0(st4[2 * i]); if (s) p.slot0 = s; else if (!p.slot0) p.slot0 = null; p.liquidity = readUint(st4[2 * i + 1]); });
  return v3.filter((p) => !p.slot0 || p.liquidity == null || p.bal0 == null || p.bal1 == null).length + v4.filter((p) => p.liquidity == null || !p.slot0).length;
}

// TVL two ways for v3-style pools (both sides at market; the base side at the pool's own rate) and whether
// the pool trades more than `sanity` off the market. dec / usd: Map(address → decimals / USD).
export function priceTvl(v3, { dec, usd, quoteSet, sanity = 0.1 }) {
  let offMarket = 0;
  for (const p of v3) {
    const d0 = dec.get(p.t0), d1 = dec.get(p.t1), u0 = usd.get(p.t0), u1 = usd.get(p.t1);
    p.tvl = tvlUsd({ bal0: p.bal0, bal1: p.bal1, d0, d1, usd0: u0, usd1: u1 });
    const quoteIs = quoteSet.has(p.t1) ? 1 : quoteSet.has(p.t0) ? 0 : null;
    const atPool = baseUsdAtPool({ price: poolPrice(p.slot0?.sqrtPriceX96, d0, d1), quoteIs, quoteUsd: quoteIs === 1 ? u1 : u0 });
    p.tvlAtPool = quoteIs === 1 ? tvlUsd({ bal0: p.bal0, bal1: p.bal1, d0, d1, usd0: atPool, usd1: u1 }) : tvlUsd({ bal0: p.bal0, bal1: p.bal1, d0, d1, usd0: u0, usd1: atPool });
    const market = quoteIs === 1 ? u0 : u1;
    p.offMarket = atPool != null && market > 0 && p.liquidity > 0n ? Math.abs(atPool / market - 1) > sanity : null;
    if (p.offMarket) offMarket++;
  }
  return { offMarket };
}

// Creation events in [from, to] from one emitter: v3-style PoolCreated (a factory) or v4 Initialize (the
// PoolManager). Returns the decoded events or null when any stretch stayed unread. timeOf(block) → seconds.
// budget (lib/budget.mjs): the read's time and call cap; past it the window is unread (null).
export async function recentCreations(logRpc, { address, kind, from, to, step = 9000, timeOf, confirmEmpty = true, budget = null, minStep = 250 }) {
  const logs = await logsAdaptive(logRpc, { address, topics: [kind === 'v4' ? TOPICS.initialize : TOPICS.poolCreated] }, from, to, { step, maxStep: step, minStep, segments: 3, retries: 2, confirmEmpty, budget });
  if (!logs) return null;
  return logs.map(kind === 'v4' ? decodeInitialize : decodePoolCreated).filter(Boolean).map((e) => ({ ...e, time: e.time ?? (timeOf ? timeOf(e.block) : null) }));
}

// The pools' creation times from a recent window of events (seconds); pools not in it keep createdAt null.
export function stampCreations(pools, events) {
  const at = new Map((events || []).map((e) => [e.id, e]));
  let n = 0;
  for (const p of pools) { const e = at.get(p.id); if (e) { p.createdBlock = e.block; p.createdAt = e.time; n++; } }
  return n;
}

// A token's first trading day from the aggregator's pair list (DexScreener pairCreatedAt, ms) and from
// Ethereum's own creation record for the same coin (seconds): the earlier, in seconds; null when neither.
export function firstTradedAt({ dsPairs = null, ethFirst = null } = {}) {
  const ds = (dsPairs || []).map((p) => p?.createdAt).filter((t) => Number.isFinite(t) && t > 1.4e12).map((t) => Math.floor(t / 1000));
  const all = [...ds, ...(Number.isFinite(ethFirst) ? [ethFirst] : [])];
  return all.length ? Math.min(...all) : null;
}

export const isZero = (a) => String(a).toLowerCase() === ZERO;
