// Exact fees (the owner's pick, 14 Nov 2026): each pool's LP fees per UTC day summed from its own swap events,
// history.json y src 's' (docs/DATA.md). The fee counters' day (Δ feeGrowth × liquidity, src 'x') mis-states a day
// on which a large LP adds or removes liquidity, since one liquidity figure stands for the whole interval; the
// swaps do not depend on liquidity at all.
//
// A day's LP fees = Σ over its swaps of the input amount × the swap's fee rate × (1 − the protocol's share), plus
// v3 flash-loan fees (less the protocol's share) and v4 donations, which also go to the LPs (lib/swaps.mjs signs:
// a v3 pool's positive amount is paid in; v4's PoolManager reports the trader's side, negative = paid in).
//   - Uniswap v3: the pool's tier; the protocol keeps 1/N of the fee (slot0.feeProtocol, one nibble per input
//     token), read at the block before the day and followed through the day's SetFeeProtocol events.
//   - PancakeSwap v3: the pool's tier; each Swap event carries the protocol's part itself (lp = fee − that part).
//   - Uniswap v4: the Swap event carries the swap's whole fee (dynamic fees included); the protocol's part is
//     slot0.protocolFee for the direction (12 bits each), followed through ProtocolFeeUpdated events.
//   The setting read at the block before the day, carried through the day's own change events, must arrive at the
//   setting read at the day's last block: anything else means a change was missed, and the day is not exact.
// A day counts only when every one of its blocks was read: the day's first and last block found from block
// timestamps (the first block at or after 00:00 UTC, and the block before the next day's first), every log chunk
// in between read (lib/logs-adaptive.mjs: an unread stretch is null, never "no events"), and the pool's state read at
// both ends. Anything less leaves the day unread (null), never a partial sum.
// A UTC day is read once, 30 minutes after it ended (EXACT.settleMs), and kept in snapshots.json `sx` (sealed); a
// day held is never read again. Newest days first, the pools in the order the dashboard ranks them (gem first),
// up to a year back and never before a pool existed, within each chain's per-pass caps (lib/chains.mjs caps.exact).
// Each day's fees are kept as [q, px] like the deep record (lib/feehist.mjs): q = token1 raw units with token0's
// side converted at px, px = token1 raw per token0 raw at the day's end (the pool's own price at its last block).
// Pure, except chainIo (the chain reads, through the scan's public nodes).
import { topic } from './keccak.mjs';
import { decodeWords, encodeCall } from './abi.mjs';
import { decodeSwap, decodeExtra, swapFees, SWAP_TOPICS, EXTRA_TOPICS } from './swaps.mjs';
import { v3ProtocolCut, readV3Slot0, readV4Slot0, readUint, v4Slot0Call } from './pools.mjs';
import { makeRpc, mapLimit } from './rpc.mjs';
import { makeMulticall, MULTICALL3 } from './multicall.mjs';
import { capRpc } from './budget.mjs';
import { logsAdaptive } from './logs-adaptive.mjs';
import { blockAtTime } from './chains.mjs';

const DAY = 86400e3;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sig = (x, n) => (isNum(x) ? Number(x.toPrecision(n)) : null);
const dayOf = (t) => Math.floor(t / DAY);
const hexNum = (x) => (typeof x === 'number' ? x : parseInt(x, 16));

export const EXACT = Object.freeze({
  days: 365, // the fee history's year (lib/feehist.mjs FEEHIST.days)
  settleMs: 30 * 60e3, // a day is read once it ended 30 minutes ago
  group: 40, // pools per log filter, as the scan's 24 h read
  stopAfter: 3, // unread jobs in a row: the rest wait for the next pass
  concurrency: 2,
  keepMs: 30 * DAY, // a pool not scanned for 30 days leaves the cache
  maxSteps: 24, // block-timestamp reads to find one day's first block
});

// The fee-setting changes a day's log read carries alongside the swaps.
export const SETTING_TOPICS = Object.freeze({
  v3: topic('SetFeeProtocol(uint8,uint8,uint8,uint8)'), // Uniswap v3 pool: old0, old1, new0, new1 (nibbles)
  pcs3: topic('SetFeeProtocol(uint32,uint32,uint32,uint32)'), // PancakeSwap v3 pool: old0, old1, new0, new1 (/10,000)
  v4: topic('ProtocolFeeUpdated(bytes32,uint24)'), // v4 PoolManager, topic1 = pool id: the new protocolFee
});

// A fee-setting change → { kind: 'setting', v, dex, pool, old (null for v4: the event carries only the new value),
// value (packed as slot0 holds it), block, logIndex }; null for anything else.
export function decodeSetting(log) {
  const t = log?.topics, d = decodeWords(log?.data);
  if (!t || !d) return null;
  const t0 = String(t[0]).toLowerCase(), at = { block: hexNum(log.blockNumber), logIndex: hexNum(log.logIndex) };
  if ((t0 === SETTING_TOPICS.v3 || t0 === SETTING_TOPICS.pcs3) && d.length >= 4) {
    const pcs = t0 === SETTING_TOPICS.pcs3, k = pcs ? 65536 : 16, n = d.map(Number);
    if (n.slice(0, 4).some((x) => !(x >= 0 && x < k))) return null;
    return { kind: 'setting', v: 3, dex: pcs ? 'pancakeswap' : 'uniswap', pool: String(log.address).toLowerCase(), old: n[0] + n[1] * k, value: n[2] + n[3] * k, ...at };
  }
  if (t0 === SETTING_TOPICS.v4 && d.length >= 1 && t[1]) return { kind: 'setting', v: 4, dex: 'uniswap', pool: String(t[1]).toLowerCase(), old: null, value: Number(d[0] & 0xffffffn), ...at };
  return null;
}

// The log filter of one job: v3-style pools by address, v4 pools by id on the PoolManager.
export function filterOf(v, ids, poolManager) {
  return v === 4 ? { address: poolManager, topics: [[SWAP_TOPICS.v4, EXTRA_TOPICS.donate, SETTING_TOPICS.v4], ids] }
    : { address: ids, topics: [[SWAP_TOPICS.v3, SWAP_TOPICS.pcs3, EXTRA_TOPICS.flash, SETTING_TOPICS.v3, SETTING_TOPICS.pcs3]] };
}

// Decoded events per pool (ascending; a log seen twice counted once): Map(id → [event]).
export function eventsByPool(logs) {
  const out = new Map(), seen = new Set();
  for (const l of logs || []) {
    const k = `${l?.transactionHash}:${hexNum(l?.logIndex)}:${hexNum(l?.blockNumber)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const s = decodeSwap(l), e = s ? { ...s, kind: 'swap' } : decodeExtra(l) ?? decodeSetting(l);
    if (!e) continue;
    if (!out.has(e.pool)) out.set(e.pool, []);
    out.get(e.pool).push(e);
  }
  for (const evs of out.values()) evs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return out;
}

// One pool's day from its events and its state at both ends.
//   pool   { v, dex, fee } (fee = the v3 tier in pips; v4 reads each swap's own)
//   events the pool's events in the day's blocks (eventsByPool), ascending
//   start  the state at the block before the day: { setting, sqrtPriceX96 } | false (not there yet) | null (unread)
//   end    the state at the day's last block, likewise
// → { kind: 'day', q, px, swaps } | { kind: 'unborn' } (not there by the day's end: no row) | { kind: 'unread', why }.
export function dayFees(pool, events, { start, end } = {}) {
  if (end === false) return { kind: 'unborn' };
  if (start == null || end == null || end.setting == null) return { kind: 'unread', why: 'state' };
  const evs = events || [], sets = evs.filter((e) => e.kind === 'setting');
  // the setting in force before the day's first change: the day's start; a pool created during the day: the first
  // change's old value (v4's events carry none: unread), or with no change the setting at the day's end
  let cur = start !== false ? start.setting : sets.length ? sets[0].old : end.setting;
  if (cur == null) return { kind: 'unread', why: 'setting' };
  const f = [0n, 0n];
  let swaps = 0;
  for (const e of evs) {
    if (e.kind === 'setting') { if ((e.dex ?? 'uniswap') !== (pool.dex ?? 'uniswap') || e.v !== pool.v) return { kind: 'unread', why: 'venue' }; cur = e.value; continue; }
    if (e.kind === 'flash' || e.kind === 'donate') {
      if (e.v !== pool.v) return { kind: 'unread', why: 'venue' };
      for (const i of [0, 1]) {
        const paid = BigInt(e.paid?.[i] ?? 0n);
        if (paid <= 0n) continue;
        if (e.kind === 'donate') { f[i] += paid; continue; }
        const c = v3ProtocolCut(cur, i, pool.dex ?? 'uniswap');
        if (!c) return { kind: 'unread', why: 'setting' };
        f[i] += paid - (paid * c.num) / c.den;
      }
      continue;
    }
    if (e.kind !== 'swap' || e.in == null) continue; // no input side: nothing was charged
    if (e.v !== pool.v || (pool.v === 3 && (e.dex ?? 'uniswap') !== (pool.dex ?? 'uniswap'))) return { kind: 'unread', why: 'venue' };
    let lp;
    if (pool.v === 3 && e.dex === 'pancakeswap' && Array.isArray(e.protocolFees)) {
      if (pool.fee == null) return { kind: 'unread', why: 'fee' };
      const total = (BigInt(e.amountIn) * BigInt(pool.fee)) / 1000000n, prot = BigInt(e.protocolFees[e.in]);
      lp = total > prot ? total - prot : 0n;
    } else {
      const r = swapFees(e, pool.v === 3 ? { fee: pool.fee, feeProtocol: cur, dex: pool.dex ?? 'uniswap' } : { protocolFee: cur });
      if (!r) return { kind: 'unread', why: 'fee' };
      lp = r.lp;
    }
    f[e.in] += lp;
    swaps++;
  }
  // the day's changes must lead to the setting read at its end: otherwise a change was missed
  if (cur !== end.setting) return { kind: 'unread', why: 'setting' };
  const sp = end.sqrtPriceX96 != null && BigInt(end.sqrtPriceX96) > 0n ? BigInt(end.sqrtPriceX96) : null;
  const px = sp == null ? null : (Number(sp) / 2 ** 96) ** 2;
  if (px == null && f[0] > 0n) return { kind: 'unread', why: 'price' };
  return { kind: 'day', q: sig(Number(f[0]) * (px ?? 0) + Number(f[1]), 6), px: px == null ? null : sig(px, 6), swaps };
}

// The pool states a multicall answered at one block: answers[0] = the block's timestamp (Multicall3), then one
// slot0 per pool. → Map(id → { setting, sqrtPriceX96 } | false | null), or null when the timestamp is unread or
// outside [lo, hi] (s): a node that answers an old block with today's state is not that block's state.
export function readStates(pools, answers, [lo, hi] = [-Infinity, Infinity]) {
  const ts = readUint(answers?.[0]);
  if (ts == null || Number(ts) < lo || Number(ts) > hi) return null;
  const out = new Map();
  pools.forEach((p, i) => {
    const a = answers[i + 1];
    if (p.v === 3) {
      if (a?.ok === true && (decodeWords(a.data) || [null]).length === 0) { out.set(p.id, false); return; } // no code yet
      const s = readV3Slot0(a);
      out.set(p.id, s == null ? null : s.sqrtPriceX96 === 0n ? false : { setting: s.feeProtocol, sqrtPriceX96: s.sqrtPriceX96 });
      return;
    }
    const s = readV4Slot0(a);
    out.set(p.id, s === false ? false : s == null ? null : { setting: s.protocolFee, sqrtPriceX96: s.sqrtPriceX96 });
  });
  return out;
}

// The first block whose timestamp is at or after T (s). blockTs(b) → s | null; guess: a block near it; spb: seconds
// a block (a lower bound on Ethereum, where missed slots only lengthen the gaps); head: the newest block. Brackets T
// from the guess, then narrows by interpolation, halving whenever that did not halve the bracket.
// → block, or null (a read failed, T lies past the head, or no answer within maxSteps reads).
export async function firstBlockAt(blockTs, T, { guess, spb, head, maxSteps = EXACT.maxSteps } = {}) {
  let lo = null, hi = null, b = Math.max(1, Math.min(head, Math.round(guess))), width = null, halve = false;
  for (let k = 0; k < maxSteps; k++) {
    const ts = await blockTs(b);
    if (!isNum(ts)) return null;
    if (ts >= T) { if (!hi || b < hi.b) hi = { b, ts }; } else if (!lo || b > lo.b) lo = { b, ts };
    if (lo && hi) {
      if (hi.b - lo.b <= 1) return hi.b;
      const w = hi.b - lo.b;
      halve = width != null && w > width / 2;
      width = w;
      let m = halve ? Math.floor((lo.b + hi.b) / 2) : lo.b + Math.ceil(((T - lo.ts) / (hi.ts - lo.ts)) * w);
      b = Math.min(hi.b - 1, Math.max(lo.b + 1, m));
    } else if (hi) {
      if (hi.b <= 1) return hi.b;
      b = Math.max(1, hi.b - Math.max(1, Math.ceil((hi.ts - T) / spb) + 1));
    } else {
      if (lo.b >= head) return null; // T is past the newest block
      b = Math.min(head, lo.b + Math.max(1, Math.ceil((T - lo.ts) / spb)));
    }
  }
  return null;
}

// ---- the cache (snapshots.json sx) ---------------------------------------------------------------------------

// { p: Map(id → { c: chain, t: last scanned ms, d: Map(UTC day ms → [q, px]), s0: first possible day ms | null }),
//   b: Map(chain → Map(UTC day ms → the day's first block)) }
export const emptyCache = () => ({ p: new Map(), b: new Map() });

const columns = (m, from) => {
  const ds = [...m.keys()].filter((d) => d >= from).sort((a, b) => a - b);
  const d0 = ds.length ? ds[0] : null, n = ds.length ? Math.round((ds.at(-1) - d0) / DAY) + 1 : 0;
  return { ds, d0, n };
};
// sx: { p: { "<id>": { c, t, d0, q: [<n|null>], px: [<n|null>], s0? } }, b: { "<chain>": { d0, n: [<block|null>] } } },
// the last 366 days; a pool not scanned for keepMs is dropped.
export function packSx(cache, { now, keepMs = EXACT.keepMs, days = EXACT.days } = {}) {
  const from = (dayOf(now) - days - 1) * DAY, p = {}, b = {};
  for (const [id, e] of cache?.p || []) {
    if (!e || !(now - (e.t ?? 0) < keepMs)) continue;
    const { ds, d0, n } = columns(e.d || new Map(), from), q = new Array(n).fill(null), px = new Array(n).fill(null);
    for (const d of ds) { const i = Math.round((d - d0) / DAY), v = e.d.get(d); q[i] = v[0]; px[i] = v[1]; }
    p[id] = { c: e.c ?? null, t: e.t, d0, q, px, ...(isNum(e.s0) ? { s0: e.s0 } : {}) };
  }
  for (const [chain, m] of cache?.b || []) {
    const { ds, d0, n: len } = columns(m, from), n = new Array(len).fill(null);
    for (const d of ds) n[Math.round((d - d0) / DAY)] = m.get(d);
    if (len) b[chain] = { d0, n };
  }
  return { p, b };
}
// The cache back from snapshots.json; anything malformed is dropped (read again), never a guess.
export function unpackSx(o) {
  const c = emptyCache();
  for (const [id, e] of Object.entries(o?.p && typeof o.p === 'object' ? o.p : {})) {
    if (!e || !isNum(e.t) || !Array.isArray(e.q) || !Array.isArray(e.px) || e.q.length !== e.px.length || (e.q.length && !(isNum(e.d0) && e.d0 % DAY === 0))) continue;
    const d = new Map();
    e.q.forEach((q, i) => { const px = e.px[i]; if (isNum(q) && q >= 0 && (px == null || (isNum(px) && px > 0))) d.set(e.d0 + i * DAY, [q, px ?? null]); });
    c.p.set(id, { c: typeof e.c === 'string' ? e.c : null, t: e.t, d, s0: isNum(e.s0) ? e.s0 : null });
  }
  for (const [chain, e] of Object.entries(o?.b && typeof o.b === 'object' ? o.b : {})) {
    if (!e || !Array.isArray(e.n) || (e.n.length && !(isNum(e.d0) && e.d0 % DAY === 0))) continue;
    const m = new Map();
    e.n.forEach((x, i) => { if (Number.isSafeInteger(x) && x > 0) m.set(e.d0 + i * DAY, x); });
    c.b.set(chain, m);
  }
  return c;
}

// ---- the plan and the pass -------------------------------------------------------------------------------------

// The first UTC day (index) a pool can have: the year's first, its creation day, the day after a read found it not
// there by a day's end (s0).
const firstDay = (p, e, first) => Math.max(first, isNum(p.createdAt) ? dayOf(p.createdAt) : -Infinity, isNum(e?.s0) ? dayOf(e.s0) : -Infinity);

// The jobs this chain's pools need: for each UTC day from `last` back to `first` (indices), the pools still missing
// it, in the given order, cut into groups of `group` by kind (v3-style by address, v4 by id). Newest days first.
// → { jobs: [{ day (ms), v, pools }], wanted (pool-days) }.
export function planDays(pools, cache, { last, first, group = EXACT.group } = {}) {
  const jobs = [];
  let wanted = 0;
  const from = new Map(pools.map((p) => [p.id, firstDay(p, cache?.p.get(p.id), first)]));
  for (let D = last; D >= first; D--) {
    const t = D * DAY;
    for (const v of [3, 4]) {
      const want = pools.filter((p) => (p.v === 4 ? 4 : 3) === v && D >= from.get(p.id) && !cache?.p.get(p.id)?.d.has(t));
      wanted += want.length;
      for (let i = 0; i < want.length; i += group) jobs.push({ day: t, v, pools: want.slice(i, i + group) });
    }
  }
  return { jobs, wanted };
}

const tally = (o, k) => { o[k] = (o[k] || 0) + 1; };

// One chain's pass. pools: [{ id, v, dex, fee, createdAt (ms|null) }] in the dashboard's order; cache: emptyCache()
// shape, changed in place; io: chainIo(...) or a fake { head, spb, clock(Ts) → block|null, blockTs(b), logs(v, ids,
// from, to) → logs|null, state(pools, block, [lo, hi]) → Map|null }; budget (lib/budget.mjs): the pass stops asking
// once it is spent (what is left waits for the next pass).
// hold: a reason to read nothing this pass (e.g. the chain's own 24 h swap read came back unread: its log nodes are
// struggling), every job left for a later pass.
// → stats: { chain, wanted, jobs, read, unread, left, added, unborn, poolUnread, why, bounds, covered, possible, changed, stopped }.
export async function exactFeesChain({ chain, pools, cache, now, io, budget = null, hold = null, days = EXACT.days, settleMs = EXACT.settleMs, group = EXACT.group, stopAfter = EXACT.stopAfter, concurrency = EXACT.concurrency } = {}) {
  const st = { chain, wanted: 0, jobs: 0, read: 0, unread: 0, left: 0, added: 0, unborn: 0, poolUnread: 0, why: {}, bounds: 0, covered: 0, possible: 0, changed: false, stopped: null };
  const today = dayOf(now), last = now >= today * DAY + settleMs ? today - 1 : today - 2, first = today - days;
  for (const p of pools) {
    const e = cache.p.get(p.id);
    if (e) { e.t = now; e.c = chain; } else cache.p.set(p.id, { c: chain, t: now, d: new Map(), s0: null });
  }
  if (!cache.b.has(chain)) cache.b.set(chain, new Map());
  const bmap = cache.b.get(chain), memo = new Map(), stateMemo = new Map();
  const plan = planDays(pools, cache, { last, first, group });
  st.wanted = plan.wanted;
  let headTs; // read once, for a guess when nothing nearer is known
  // a chain with a fixed block clock (Base): its clock; else the nearest day start known, else the head's timestamp
  const guessOf = async (Ts) => {
    const c = io.clock ? io.clock(Ts) : null;
    if (isNum(c)) return c;
    let near = null;
    for (const [d, b] of bmap) if (!near || Math.abs(d / 1000 - Ts) < Math.abs(near[0] / 1000 - Ts)) near = [d, b];
    if (near) return near[1] + Math.round((Ts - near[0] / 1000) / io.spb);
    if (headTs === undefined) headTs = await io.blockTs(io.head);
    return isNum(headTs) ? io.head - Math.ceil((headTs - Ts) / io.spb) : null;
  };
  const boundary = (t) => {
    if (bmap.has(t)) return Promise.resolve(bmap.get(t));
    if (!memo.has(t)) memo.set(t, (async () => {
      const g = await guessOf(t / 1000);
      const b = isNum(g) ? await firstBlockAt(io.blockTs, t / 1000, { guess: g, spb: io.spb, head: io.head }) : null;
      if (b != null) { bmap.set(t, b); st.bounds++; st.changed = true; }
      return b;
    })());
    return memo.get(t);
  };
  const states = async (ps, block, range) => {
    const need = ps.filter((p) => !stateMemo.has(`${block}|${p.id}`));
    if (need.length) {
      const got = await io.state(need, block, range);
      for (const p of need) if (got) stateMemo.set(`${block}|${p.id}`, got.get(p.id) ?? null);
    }
    return new Map(ps.map((p) => [p.id, stateMemo.has(`${block}|${p.id}`) ? stateMemo.get(`${block}|${p.id}`) : null]));
  };
  let fails = 0;
  if (hold) st.stopped = hold;
  if (hold) st.left = plan.jobs.length;
  await mapLimit(hold ? [] : plan.jobs, concurrency, async (job) => {
    if (budget?.over() || fails >= stopAfter) { st.left++; if (!st.stopped) st.stopped = budget?.why() || 'errors'; return; }
    st.jobs++;
    const t = job.day, [from, next] = await Promise.all([boundary(t), boundary(t + DAY)]);
    // a job the budget cut short is left for a later pass, not unread
    const fail = (why) => { if (budget?.over()) { st.jobs--; st.left++; if (!st.stopped) st.stopped = budget.why(); return; } st.unread++; tally(st.why, why); fails++; };
    if (from == null || next == null || !(next > from)) return fail('boundary');
    // the state at both ends first (one call each): with none of it read, or no pool there by the day's end, the
    // day's logs are not worth reading
    const T0 = t / 1000, T1 = (t + DAY) / 1000;
    const [a, z] = await Promise.all([states(job.pools, from - 1, [T0 - 3600, T0 - 1]), states(job.pools, next - 1, [T1 - 3600, T1 - 1])]);
    if (job.pools.every((p) => a.get(p.id) == null || z.get(p.id) == null) && !job.pools.some((p) => z.get(p.id) === false)) return fail('state');
    const live = job.pools.filter((p) => z.get(p.id) !== false && a.get(p.id) != null && z.get(p.id) != null);
    const logs = live.length ? await io.logs(job.v, live.map((p) => p.id), from, next - 1) : [];
    if (logs == null) return fail('logs');
    st.read++; fails = 0;
    const evs = eventsByPool(logs);
    for (const p of job.pools) {
      const e = cache.p.get(p.id), start = a.get(p.id), end = z.get(p.id), r = dayFees(p, evs.get(p.id) || [], { start, end });
      if (r.kind === 'day') {
        e.d.set(t, [r.q, r.px]); st.added++; st.changed = true;
        if (start === false && !(e.s0 >= t)) e.s0 = t; // created that day: nothing before it
      } else if (r.kind === 'unborn') {
        if (!(e.s0 >= t + DAY)) { e.s0 = t + DAY; st.changed = true; }
        st.unborn++;
      } else { st.poolUnread++; tally(st.why, r.why); }
    }
  });
  // coverage: the days held of the days each pool can have, from its first possible day to the last settled one
  for (const p of pools) {
    const e = cache.p.get(p.id), f = firstDay(p, e, first);
    if (f > last) continue;
    st.possible += last - f + 1;
    for (let D = f; D <= last; D++) if (e.d.has(D * DAY)) st.covered++;
  }
  return st;
}

// ---- the chain reads -------------------------------------------------------------------------------------------

// The reads one chain's pass makes (lib/chains.mjs entry CH): block timestamps (headers, any node), the day's logs
// (the scan's log nodes, the swap read's chunking, every call spending the budget) and the pools' state at a block
// (archive nodes, Multicall3 with the block's own timestamp). Its own node lists, so refusals here never drop a
// node the rest of the pass uses.
export function chainIo(CH, { budget = null, head, timeout = 20000 } = {}) {
  const logRpc = makeRpc(CH.rpcs.filter((u) => !CH.noLogs.some((x) => u.includes(x))), { timeout, maxRefusals: 1000 });
  const rpc = capRpc(makeRpc(CH.rpcs, { timeout, maxRefusals: 6 }), budget);
  const amc = makeMulticall(capRpc(makeRpc(CH.archive, { timeout, maxRefusals: 6 }), budget), { chunk: 300, concurrency: 2 });
  const eth = CH.id === 'ethereum', tsCall = { target: MULTICALL3, data: encodeCall('getCurrentBlockTimestamp()') };
  const slot0Of = (p) => (p.v === 4 ? v4Slot0Call(CH.c.v4StateView, p.id) : { target: p.id, data: encodeCall('slot0()') });
  return {
    head, spb: CH.secPerBlock,
    clock: CH.eras ? (Ts) => blockAtTime(CH, Ts) : null,
    async blockTs(b) {
      const r = await rpc.call('eth_getBlockByNumber', ['0x' + b.toString(16), false]);
      const t = r && typeof r.timestamp === 'string' ? parseInt(r.timestamp, 16) : null;
      return Number.isFinite(t) && (r.number == null || parseInt(r.number, 16) === b) ? t : null;
    },
    logs: (v, ids, from, to) => logsAdaptive(logRpc, filterOf(v, ids, CH.c.v4PoolManager), from, to,
      { step: CH.swapStep, maxStep: CH.swapStep, minStep: eth ? 250 : 500, segments: eth ? 1 : 4, confirmEmpty: CH.confirmEmpty, retries: 1, budget }),
    async state(pools, block, range) { return readStates(pools, await amc([tsCall, ...pools.map(slot0Of)], '0x' + block.toString(16)), range); },
  };
}

// ---- the public line -------------------------------------------------------------------------------------------

const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// The public log's line (counts, ratios and seconds only) and the sealed check's verdict. runs: one stats object per
// chain (exactFeesChain, plus ms and calls); xs: swap ÷ growth ratios on days with both (lib/feehist.mjs feeYear);
// sDays: pool-days drawn from swaps. The check passes with the median within 10% of 1 over 20 days or more.
export function exactLine(runs, { xs = [], sDays = 0 } = {}) {
  const m = median(xs), off = xs.filter((r) => isNum(r) && Math.abs(r - 1) > 0.2).length;
  const per = runs.map((r) => r.broke ? `${r.chain} broke (${r.broke})`
    : `${r.chain} +${r.added} days in ${r.read} of ${r.jobs} jobs read (${r.unread} unread${Object.keys(r.why).length ? `: ${Object.entries(r.why).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}; ${r.left} left${r.stopped ? ` by ${r.stopped}` : ''}), coverage ${r.covered} of ${r.possible} pool-days, ${Math.round((r.ms ?? 0) / 1000)} s, ${r.calls ?? 0} calls`).join('; ');
  const line = `${sDays} pool-days from swaps, median swap÷growth ${m == null ? '—' : m.toFixed(2) + 'x'} over ${xs.length} days, ${off} days differ >20%; ${per}`;
  return { line, ok: xs.length >= 20 && m != null ? Math.abs(m - 1) <= 0.1 : null, median: m };
}
