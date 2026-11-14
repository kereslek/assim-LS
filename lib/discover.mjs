// Pool discovery for the venues added after Ethereum's Uniswap list (scripts/pools.mjs): PancakeSwap v3 on
// Ethereum and Base, and Base's Uniswap v3 and v4. The same method as Ethereum's: candidate pairs (universe
// token × quote token × fee tier) looked up at one block through each factory (v4: computed pool ids checked
// through StateView), their state and balances read, TVL priced two ways; creation events over a recent
// window give the young pools' ages (an older pool's age stays unknown: null, never a guess).
// Every function takes its RPC through arguments, so tests run it on a fake chain.
import { encodeCall } from './abi.mjs';
import { ZERO, v3Candidates, v4Candidates, getPoolCall, v4Slot0Call, readGetPool, readV4Slot0, readV3Slot0, readUint, poolPrice, tvlUsd, baseUsdAtPool, decodePoolCreated, decodeInitialize, v4PoolId, TOPICS } from './pools.mjs';
import { logsAdaptive } from './logs-adaptive.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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

// v4 pool keys from the PoolManager's own Initialize events, for listed pool ids the PositionManager can't
// resolve: a pool initialised straight on the PoolManager (its liquidity added through a custom router or
// hook, never a position minted through the PositionManager) has no poolKeys entry, but every pool has
// exactly one Initialize event. eth_getLogs with address = the PoolManager, topic0 = Initialize, topic1 = the
// ids still wanted, in chunks of `step` blocks (9,000 on Ethereum, 10,000 on L2s): first each id's window
// (windows: Map id → [lo, hi], initWindow below) read backwards from its top, then, with sweep, every chunk of
// [from, to] (the PoolManager's deployment block to the head) backwards from the head, `concurrency` chunks in
// flight, until every id is found or the budget (lib/budget.mjs) is spent.
// A log counts only if it comes from the PoolManager, sits inside the asked range, decodes, carries a wanted
// id, and its key hashes back to that id (keccak256(abi.encode(key)) = the PoolId). An answer holding any log
// that fails those checks is rejected: its chunk stays unread, like one nobody answered or (confirmEmpty) an
// empty answer no second node confirms.
// Returns { keys: Map id → { currency0, currency1, fee, tickSpacing, hooks, block, time } | false (no event
// anywhere in [from, to], every chunk read) | null (unread: never "no pool", never a guessed key),
// rejected (logs that failed the checks), swept (the whole range was read) }.
export async function keysFromInitialize(logRpc, { poolManager, ids, from, to, step = 9000, windows = null, sweep = true, confirmEmpty = true, budget = null, concurrency = 4, retries = 1, waitMs = 1000 }) {
  const want = [...new Set((ids || []).map((x) => String(x).toLowerCase()))];
  const pm = String(poolManager).toLowerCase(), found = new Map();
  let rejected = 0;
  const pending = () => want.filter((id) => !found.has(id));
  const spent = () => !!budget?.over();
  // one chunk [a, b] for the ids in `list`: true = read and checked, false = unread
  async function chunk(a, b, list) {
    const q = [{ address: pm, topics: [TOPICS.initialize, list], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }];
    for (let t = 0; t <= retries; t++) {
      if (t) await pause(Math.min(waitMs * 2 ** (t - 1), budget ? budget.left() : Infinity));
      if (budget && !budget.take()) return false;
      let r;
      if (confirmEmpty && logRpc.callWho) {
        const first = await logRpc.callWho('eth_getLogs', q);
        r = first.result;
        if (Array.isArray(r) && r.length === 0) {
          if (budget && !budget.take()) return false;
          const second = first.url ? await logRpc.callWho('eth_getLogs', q, [first.url]) : { result: null };
          r = Array.isArray(second.result) ? second.result : null; // unconfirmed: unread
        }
      } else r = await logRpc.call('eth_getLogs', q);
      if (!Array.isArray(r)) { if (spent()) return false; continue; }
      let bad = 0;
      for (const l of r) { const e = initKey(l, { pm, wanted: list, a, b }); if (!e) bad++; else if (!found.has(e.id)) found.set(e.id, e); }
      if (bad) { rejected += bad; return false; }
      return true;
    }
    return false;
  }
  for (const id of want) {
    const w = windows?.get(id);
    if (!w || found.has(id)) continue;
    const lo = Math.max(from, w[0]), hi = Math.min(to, w[1]);
    for (let b = hi; b >= lo && !found.has(id) && !spent(); b -= step) await chunk(Math.max(lo, b - step + 1), b, pending());
  }
  let swept = false;
  if (sweep && pending().length && to >= from) {
    const n = Math.ceil((to - from + 1) / step);
    let k = 0, unread = 0;
    const walker = async () => {
      while (k < n && pending().length && !spent()) {
        const i = k++, b = to - i * step;
        if (!(await chunk(Math.max(from, b - step + 1), b, pending()))) unread++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, n) }, walker));
    swept = k >= n && unread === 0;
  }
  const keys = new Map(want.map((id) => {
    const e = found.get(id);
    return [id, e ? { currency0: e.currency0, currency1: e.currency1, fee: e.fee, tickSpacing: e.tickSpacing, hooks: e.hooks, block: e.block, time: e.time } : swept ? false : null];
  }));
  return { keys, rejected, swept };
}

// One Initialize log → { id, key fields, block, time } when it passes every check above, else null.
function initKey(log, { pm, wanted, a, b }) {
  try {
    if (log?.address != null && String(log.address).toLowerCase() !== pm) return null;
    const e = decodeInitialize(log);
    if (!e || !wanted.includes(e.id) || !(e.block >= a && e.block <= b)) return null;
    const key = { currency0: e.t0, currency1: e.t1, fee: e.fee, tickSpacing: e.tickSpacing, hooks: e.hooks };
    return v4PoolId(key) === e.id ? { id: e.id, ...key, block: e.block, time: e.time } : null;
  } catch { return null; }
}

// The block range to search first for a listed pool's Initialize event, from the aggregator's creation time
// (ms): `back` seconds before it to `ahead` seconds after, through the chain's clock blockAt(tSec) (exact on a
// chain with eras; on Ethereum 12 s a slot runs early by the missed slots, so `slack` raises the top by that
// share of the distance to the head). No usable time → null (no window; the sweep still looks).
export function initWindow(createdAtMs, { head, blockAt, back = 86400, ahead = 3600, slack = 0 }) {
  if (!Number.isFinite(createdAtMs) || createdAtMs < 1.4e12 || !Number.isFinite(head)) return null;
  const t = createdAtMs / 1000, lo = blockAt(t - back), mid = blockAt(t), hi = blockAt(t + ahead);
  if (![lo, mid, hi].every(Number.isFinite)) return null;
  const top = Math.min(head, Math.ceil(hi + slack * Math.max(0, head - mid))), bottom = Math.max(0, Math.floor(lo));
  return bottom <= top ? [bottom, top] : null;
}
