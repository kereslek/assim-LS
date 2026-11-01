// Visual backtest engine: replays one pool's swaps over a past window with a simulated LP position
// and measures what it would have earned and lost. Pure functions, no I/O.
//
// Units. Raw prices are token1 raw per token0 raw; sp is their square root (as v3 maths uses).
// Money is counted in the reference token (the side with a market feed), and turned into USD with
// one fixed price for the window; the other token is valued at the pool's own rate at each moment.
//
// Fees. Each swap's LP fee (after the protocol's cut, lib/swaps.mjs swapFees) is shared by the
// liquidity along the swap's path. A position with liquidity L earns fee × f × L ÷ (activeL + ours):
// f is the part of the path inside its range, by input amount at constant liquidity (Δ√P for
// token1 in, Δ(1/√P) for token0 in), activeL is the event's liquidity, and ours is the liquidity
// of every sleeve of the strategy on that path (one sleeve: just L).
//
// Loss vs holding (measured, not from a formula). Each segment, from entry or a re-centre to the
// next re-centre, is compared with holding the tokens it started with; closed segments add up.
// A range position is never worth more than its own starting tokens, so the loss is ≤ 0. Then
// net = fees + lvr + costs is the P&L against holding what you had at each re-centre.
//
// Triggers. A bot sees the pool when a block is done, so triggers read the price after each block's
// last swap and a re-centre happens at that price; fees still follow every swap's path.
//
// Costs. Entry and each re-centre swap the needed part of the position at swapRate (the pool's
// fee, capped by a cheaper route, plus slippage; taken out of the position) and pay gasUsd (paid
// from outside the position). Signs in the output: fees ≥ 0, lvr ≤ 0, costs ≤ 0.
import { swapFees } from './swaps.mjs';
import { MIN_TICK, MAX_TICK, sqrtAtTick, ticksForLog } from './v3math.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const HOUR = 3600e3, DAY = 86400e3;
const LN_SQRT_BASE = Math.log(1.0001) / 2;

export const TRIGGERS = ['exit', 'exit+12h', 'exit+24h', 'drift50', 'drift75'];

// 'exit' re-centres when the price leaves the range; 'exit+Nh' once it has stayed out N hours;
// 'driftNN' when it has gone NN% of the way from the centre to an edge (log terms); 'none' never.
export function parseTrigger(s) {
  if (s === 'exit') return { kind: 'exit' };
  if (s === 'none') return { kind: 'none' };
  let m = /^exit\+(\d+)h$/.exec(String(s));
  if (m) return { kind: 'delay', delay: Number(m[1]) * HOUR };
  m = /^drift(\d+)$/.exec(String(s));
  if (m && Number(m[1]) > 0 && Number(m[1]) < 100) return { kind: 'drift', drift: Number(m[1]) / 100 };
  return null;
}

// Value of raw amounts (a0, a1) in the reference token at raw price P.
export function refValue(ref, d0, d1) {
  const s0 = 10 ** d0, s1 = 10 ** d1;
  return ref === 1 ? (a0, a1, P) => (a0 * P + a1) / s1 : (a0, a1, P) => (a0 + a1 / P) / s0;
}

export const tickOfSqrt = (sp) => Math.floor(Math.log(sp) / LN_SQRT_BASE);

// Raw amounts held by liquidity L between sqrt prices sa < sb when the pool is at sp.
export function amountsAt(L, sa, sb, sp) {
  if (sp <= sa) return [(L * (sb - sa)) / (sa * sb), 0];
  if (sp >= sb) return [0, L * (sb - sa)];
  return [(L * (sb - sp)) / (sp * sb), L * (sp - sa)];
}

// The part of a swap's path from sqrt price pre to post that lies in [sa, sb), by input amount at
// constant liquidity. A swap that doesn't move the price earns in full if it sits in the range.
export function pathFraction(pre, post, sa, sb, side) {
  if (!(pre > 0) || !(post > 0)) return 0;
  if (pre === post) return pre >= sa && pre < sb ? 1 : 0;
  const lo = Math.min(pre, post), hi = Math.max(pre, post);
  const a = Math.max(lo, sa), b = Math.min(hi, sb);
  if (!(b > a)) return 0;
  return side === 0 ? (1 / a - 1 / b) / (1 / lo - 1 / hi) : (b - a) / (hi - lo);
}

const fullTicks = (S) => ({ ta: Math.ceil(MIN_TICK / S) * S, tb: Math.floor(MAX_TICK / S) * S });

// A range of half-width r (log price) around a tick, on the pool's tick spacing, at least one
// spacing wide and always containing the tick.
export function rangeAround(tick, r, spacing = 1) {
  const S = spacing > 0 ? spacing : 1, f = fullTicks(S);
  const h = Math.max(1, Math.round(ticksForLog(r)));
  let ta = Math.floor((tick - h) / S) * S, tb = Math.ceil((tick + h) / S) * S;
  if (tb <= tick) tb += S;
  ta = Math.max(ta, f.ta); tb = Math.min(tb, f.tb);
  if (tb <= ta) tb = ta + S;
  return { ta, tb };
}

// Swaps → columns the simulations walk (block numbers mark where a bot can act). Drops swaps with no input side or price, removes repeats
// of the same log (block:logIndex), sorts by block and log index. Each LP fee is valued in the
// reference token at the swap's own price. unpriced counts swaps whose fee can't be split (missing
// protocol settings): the caller must then report the window as unread, never as fee-free.
export function prepare(swaps, { meta = null, feeFn = swapFees, d0 = 0, d1 = 0, ref = 1 } = {}) {
  const val = refValue(ref, d0, d1), seen = new Set(), rows = [];
  let dup = 0, skipped = 0, unpriced = 0;
  for (const s of swaps || []) {
    const spx = s && typeof s.sqrtPriceX96 === 'bigint' ? s.sqrtPriceX96 : null;
    if (!s || (s.in !== 0 && s.in !== 1) || !(spx > 0n) || !isNum(s.t)) { skipped++; continue; }
    const key = s.block != null && s.logIndex != null ? `${s.block}:${s.logIndex}` : null;
    if (key) { if (seen.has(key)) { dup++; continue; } seen.add(key); }
    const f = feeFn(s, s.meta ?? meta);
    if (!f) unpriced++;
    rows.push({ s, key, f });
  }
  rows.sort((x, y) => (x.s.block ?? 0) - (y.s.block ?? 0) || (x.s.logIndex ?? 0) - (y.s.logIndex ?? 0) || x.s.t - y.s.t);
  const n = rows.length;
  const p = { n, t: new Float64Array(n), block: new Float64Array(n), sp: new Float64Array(n), tick: new Int32Array(n), act: new Float64Array(n), side: new Uint8Array(n), lpRaw: new Float64Array(n), lpRef: new Float64Array(n), keys: new Array(n), dup, skipped, unpriced };
  rows.forEach(({ s, key, f }, i) => {
    const sp = Number(s.sqrtPriceX96) / 2 ** 96, P = sp * sp, lp = f ? Number(f.lp) : 0;
    p.t[i] = s.t; p.block[i] = Number.isInteger(s.block) ? s.block : NaN; p.sp[i] = sp; p.side[i] = s.in; p.act[i] = Number(s.liquidity ?? 0n);
    p.tick[i] = Number.isInteger(s.tick) ? s.tick : tickOfSqrt(sp);
    p.lpRaw[i] = lp; p.lpRef[i] = s.in === 0 ? val(lp, 0, P) : val(0, lp, P); p.keys[i] = key;
  });
  return p;
}

// First index with t > x (columns are in time order).
export function firstAfter(t, x) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

// One strategy over one window.
// ctx: { start: { t, sp, tick }, end: { t }, d0, d1, ref, refUsd, ticket, gasUsd, swapRate, spacing, points }
// strategy: { id, sleeves: [{ w, r } | { w, full: true }], trigger }
// Returns null when an input is missing (never a made-up zero).
export function simulate(prep, ctx, strategy, { trace = false } = {}) {
  const { start, end, d0 = 0, d1 = 0, ref = 1, refUsd, ticket, gasUsd, swapRate, spacing = 1, points = 200 } = ctx || {};
  const trig = parseTrigger(strategy?.trigger);
  if (!prep || !trig || !start || !end || ![refUsd, ticket, gasUsd, swapRate, start.t, end.t, start.sp].every(isNum)) return null;
  if (!(ticket > 0) || !(refUsd > 0) || !(end.t > start.t) || !(start.sp > 0) || gasUsd < 0 || swapRate < 0) return null;
  if (!strategy.sleeves?.length || strategy.sleeves.some((x) => !(x.w > 0) || (!x.full && !(x.r > 0)))) return null;
  const val = refValue(ref, d0, d1), human = 10 ** (d0 - d1), S = spacing > 0 ? spacing : 1;
  let sp = start.sp, tick = Number.isInteger(start.tick) ? start.tick : tickOfSqrt(sp), tPrev = start.t;
  let fees = 0, poolFees = 0, costUsd = 0, reranges = 0, swapsIn = 0;
  const poolLp = [0, 0], ledger = [];
  const sl = strategy.sleeves.map((x) => ({ w: x.w, r: x.r, full: !!x.full, ta: 0, tb: 0, sa: 0, sb: 0, sc: 0, L: 0, x0: 0, y0: 0, lvrClosed: 0, exitAt: null, inT: 0 }));
  const tr = trace ? { idx: [], sleeve: [], frac: [], fee: [], ta: [], tb: [], L: [] } : null;
  const fr = new Float64Array(sl.length);

  const holdLoss = (s, P) => { const [a0, a1] = amountsAt(s.L, s.sa, s.sb, sp); return val(s.x0, s.y0, P) - val(a0, a1, P); };
  function open(s, k, V, share0, t, kind) {
    const { ta, tb } = s.full ? fullTicks(S) : rangeAround(tick, s.r, S);
    const sa = sqrtAtTick(ta), sb = sqrtAtTick(tb), P = sp * sp;
    const [n0, n1] = amountsAt(1, sa, sb, sp), nv = val(n0, n1, P);
    const swapped = Math.abs(val(n0, 0, P) / nv - share0) * V, swapRef = swapped * swapRate;
    const L = (V - swapRef) / nv;
    Object.assign(s, { ta, tb, sa, sb, sc: Math.sqrt(sa * sb), L, x0: n0 * L, y0: n1 * L, exitAt: null });
    const e = { t, kind, sleeve: k, gasUsd, swappedUsd: swapped * refUsd, swapUsd: swapRef * refUsd };
    ledger.push(e);
    costUsd += e.gasUsd + e.swapUsd;
  }
  function recentre(s, t) {
    const P = sp * sp, [a0, a1] = amountsAt(s.L, s.sa, s.sb, sp), V = val(a0, a1, P);
    s.lvrClosed += val(s.x0, s.y0, P) - V;
    reranges++;
    open(s, sl.indexOf(s), V, V > 0 ? val(a0, 0, P) / V : 0.5, t, 'recentre');
  }
  const inRange = (s) => sp >= s.sa && sp < s.sb;

  const series = { t: [], px: [], lo: [], hi: [], fees: [], lvr: [], costs: [], net: [] };
  const sampleT = (k) => (k === points ? end.t : start.t + ((end.t - start.t) * k) / points);
  let k = 0;
  function sample(tt) {
    const P = sp * sp;
    let loss = 0;
    for (const s of sl) loss += s.lvrClosed + holdLoss(s, P);
    const f = fees * refUsd, l = -loss * refUsd, c = -costUsd;
    series.t.push(Math.round(tt)); series.px.push(P * human);
    series.lo.push(sl[0].sa * sl[0].sa * human); series.hi.push(sl[0].sb * sl[0].sb * human);
    series.fees.push(f); series.lvr.push(l); series.costs.push(c); series.net.push(f + l + c);
  }
  const emitBefore = (tt) => { while (k <= points && sampleT(k) < tt) { sample(sampleT(k)); k++; } };
  function advance(tt) {
    const dt = tt - tPrev;
    if (dt <= 0) return;
    for (const s of sl) if (s.L > 0 && inRange(s)) s.inT += dt;
    tPrev = tt;
  }
  function deadlines(tt) {
    if (trig.kind !== 'delay') return;
    for (;;) {
      let best = null;
      for (const s of sl) if (s.exitAt != null && s.exitAt + trig.delay <= tt && (!best || s.exitAt < best.exitAt)) best = s;
      if (!best) return;
      const d = best.exitAt + trig.delay;
      emitBefore(d); advance(d); recentre(best, d);
    }
  }

  const ticketRef = ticket / refUsd;
  sl.forEach((s, i) => open(s, i, ticketRef * s.w, ref === 0 ? 1 : 0, start.t, 'entry'));
  for (let i = firstAfter(prep.t, start.t); i < prep.n && prep.t[i] <= end.t; i++) {
    const ti = prep.t[i];
    deadlines(ti); emitBefore(ti); advance(ti);
    const pre = sp, post = prep.sp[i], side = prep.side[i], lp = prep.lpRef[i], act = prep.act[i];
    poolFees += lp; poolLp[side] += prep.lpRaw[i]; swapsIn++;
    // the swap's liquidity = the pool's active liquidity plus every sleeve of ours on its path
    let ours = 0;
    for (let j = 0; j < sl.length; j++) { const s = sl[j]; fr[j] = s.L > 0 ? pathFraction(pre, post, s.sa, s.sb, side) : 0; if (fr[j] > 0) ours += s.L; }
    for (let j = 0; j < sl.length; j++) {
      const s = sl[j], f = fr[j];
      const e = f > 0 ? (lp * f * s.L) / (act + ours) : 0;
      fees += e;
      if (tr) { tr.idx.push(i); tr.sleeve.push(j); tr.frac.push(f); tr.fee.push(e); tr.ta.push(s.ta); tr.tb.push(s.tb); tr.L.push(s.L); }
    }
    sp = post; tick = prep.tick[i];
    // a bot sees the pool once a block is done: triggers look at the price after the block's last swap,
    // so a spike that comes back within the same block (a sandwich) never re-centres anything
    if (i + 1 < prep.n && prep.block[i + 1] === prep.block[i] && prep.t[i + 1] <= end.t) continue;
    for (const s of sl) {
      const inside = inRange(s);
      if (trig.kind === 'exit') { if (!inside) recentre(s, ti); }
      else if (trig.kind === 'delay') { if (inside) s.exitAt = null; else if (s.exitAt == null) s.exitAt = ti; }
      else if (trig.kind === 'drift' && (!inside || Math.abs(Math.log(sp / s.sc)) >= trig.drift * Math.log(s.sb / s.sc))) {
        // on a coarse tick spacing the re-centred range can be the same one: then there is nothing to do
        const nr = s.full ? null : rangeAround(tick, s.r, S);
        if (!inside || !nr || nr.ta !== s.ta || nr.tb !== s.tb) recentre(s, ti);
      }
    }
  }
  deadlines(end.t); emitBefore(end.t); advance(end.t);
  while (k <= points) { sample(sampleT(k)); k++; }

  const P = sp * sp, span = end.t - start.t, days = span / DAY;
  let loss = 0, tir = 0;
  for (const s of sl) { loss += s.lvrClosed + holdLoss(s, P); tir += (s.w * s.inT) / span; }
  const wsum = sl.reduce((a, s) => a + s.w, 0);
  const feesUsd = fees * refUsd, lvrUsd = -loss * refUsd, costsUsd = -costUsd, netUsd = feesUsd + lvrUsd + costsUsd;
  return {
    id: strategy.id, days, feesUsd, lvrUsd, costsUsd, netUsd,
    net: days >= 1 / 24 ? ((netUsd / ticket) * 365) / days : null,
    tir: tir / wsum, reranges, share: poolFees > 0 ? fees / poolFees : null,
    poolFeesUsd: poolFees * refUsd, poolLp, swaps: swapsIn, ledger, series, trace: tr,
    ranges: sl.map((s) => ({ ta: s.ta, tb: s.tb })),
  };
}

// Daily volatility from the window's own prices, sampled hourly (used only when the days before
// the window can't give one, e.g. a young pool). Needs at least 12 hourly returns.
export function sigmaFromSwaps(prep, start, end) {
  if (!prep || !start || !(end.t > start.t)) return null;
  let i = firstAfter(prep.t, start.t), sp = start.sp, prev = null, sum = 0, n = 0;
  for (let h = start.t + HOUR; h <= end.t; h += HOUR) {
    while (i < prep.n && prep.t[i] <= h) sp = prep.sp[i++];
    if (prev != null && sp > 0 && prev > 0) { const r = 2 * Math.log(sp / prev); sum += r * r; n++; }
    prev = sp;
  }
  return n >= 12 ? Math.sqrt((sum / n) * 24) : null;
}
