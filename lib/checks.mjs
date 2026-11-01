// Cross-checks that compare our numbers with an independent reading (step 5).
import { swapFees } from './swaps.mjs';
import { sqrtRatioAtTick, amount0Delta, amount1Delta, MAX_TICK } from './v3math.mjs';

const Q128 = 2 ** 128;
const PIPS = 1000000n;
const Q224 = 1n << 224n;

// Fee identity: each swap adds its LP fee ÷ the active liquidity to the pool's feeGrowthGlobal,
// so the day's replayed swaps must reproduce the counter's change between the window's ends.
// swaps: one pool's decoded swaps in the window; meta: its fee settings; fgThen/fgNow: [g0, g1].
// Returns the ratio replay ÷ counter per token side (null where nothing moved or unread).
export function feeIdentity(swaps, meta, fgThen, fgNow) {
  if (!fgThen || !fgNow) return null;
  const exp = [0, 0];
  for (const s of swaps) {
    const f = swapFees(s, meta);
    if (!f || !(s.liquidity > 0n)) continue;
    exp[s.in] += (Number(f.lp) * Q128) / Number(s.liquidity);
  }
  return [0, 1].map((side) => {
    const d = Number(BigInt.asUintN(256, fgNow[side] - fgThen[side]));
    return d > 0 && exp[side] > 0 ? exp[side] / d : null;
  });
}

// The fee identity, replayed the way the pool books it (v3-core and v4-core Pool.swap). A swap walks
// the price in steps between initialized ticks; each step adds its LP fee ÷ that step's liquidity to
// feeGrowthGlobal of the input token. The LP fee of a step is its net input (input less the fee) ×
// rate, and the net input is liquidity × the step's price move (Δ√P for token1 in, Δ(1/√P) for
// token0 in), so fee ÷ liquidity = price move × rate: liquidity cancels, except across stretches with
// no liquidity, where the price jumps and nothing is booked. The event's liquidity is the post-swap
// value, which is why dividing a crossing swap's whole fee by it misses (the old method, above).
//   rate, v3: f/(1−f) × (1 − 1/N), N the protocol divisor for the input token (0 = off).
//   rate, v4: (sf − pf)/(1 − sf), sf the event's swap fee (protocol included: pf + lp − pf·lp),
//             pf the protocol's pips of the gross input for that direction.
// A swap inside one stretch is replayed unit for unit instead: fee = gross input − the pool's own
// rounded-up net input for the price move, less the protocol's cut, ÷ liquidity, rounded down.
// v3 flash payments (less 1/N) and v4 donations add to the counter ÷ the liquidity at that moment.
function lpRate(s, meta) {
  if (s.v === 3) {
    if (meta?.fee == null || meta?.feeProtocol == null) return null;
    const f = BigInt(meta.fee), n = BigInt(s.in === 0 ? meta.feeProtocol % 16 : meta.feeProtocol >> 4);
    return { num: n > 0n ? f * (n - 1n) : f, den: n > 0n ? (PIPS - f) * n : PIPS - f, cut: (fee) => (n > 0n ? fee / n : 0n) };
  }
  if (meta?.protocolFee == null || s.fee == null || s.fee >= 1000000) return null;
  const sf = BigInt(s.fee), pf = BigInt(s.in === 0 ? meta.protocolFee & 0xfff : meta.protocolFee >> 12);
  return { num: sf > pf ? sf - pf : 0n, den: PIPS - sf, cut: (fee, gross) => (pf === 0n ? 0n : sf === pf ? fee : (gross * pf) / PIPS) };
}

// The map at the end block, as the replay needs it: initialized ticks' prices, and the stretches holding liquidity.
export function pathIndex(segments) {
  if (!Array.isArray(segments)) return null;
  const ticks = [...new Set(segments.map((g) => g.lo))].sort((x, y) => x - y).map(sqrtRatioAtTick);
  const live = [];
  for (const g of [...segments].sort((x, y) => x.lo - y.lo)) {
    if (!(BigInt(g.L) > 0n)) continue;
    const a = sqrtRatioAtTick(g.lo), b = sqrtRatioAtTick(Math.min(g.hi, MAX_TICK));
    if (live.length && live[live.length - 1][1] === a) live[live.length - 1][1] = b; else live.push([a, b]);
  }
  return { ticks, live };
}
function firstAbove(arr, x, key = (v) => v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) > x) hi = m; else lo = m + 1; } return lo; }
const crossesTick = (ix, lo, hi) => { if (!ix) return false; const i = firstAbove(ix.ticks, lo); return i < ix.ticks.length && ix.ticks[i] < hi; };
const moveOf = (x, y, down) => (y <= x ? 0n : down ? (Q224 * (y - x)) / (x * y) : y - x);
function liveDelta(ix, lo, hi, down) {
  const full = moveOf(lo, hi, down);
  if (!ix) return { d: full, full };
  let d = 0n;
  for (let i = Math.max(0, firstAbove(ix.live, lo, (v) => v[1]) - 1); i < ix.live.length && ix.live[i][0] < hi; i++) {
    const x = ix.live[i][0] > lo ? ix.live[i][0] : lo, y = ix.live[i][1] < hi ? ix.live[i][1] : hi;
    d += moveOf(x, y, down);
  }
  return { d, full };
}

// swaps/extras: one pool's decoded events in the window (lib/swaps.mjs); meta: its fee settings;
// start: { sqrtPriceX96, liquidity } at the block before the window; path: pathIndex(map) or null.
// Returns the expected counter growth per token (BigInt, X128) and what each side's replay went through.
export function replayFeeGrowth({ swaps = [], extras = [], meta, start, path = null }) {
  if (!meta || !start || start.sqrtPriceX96 == null || !(BigInt(start.sqrtPriceX96) > 0n) || start.liquidity == null) return null;
  const evs = [...swaps.filter(Boolean).map((s) => ({ ...s, kind: 'swap' })), ...extras.filter(Boolean)].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  let P = BigInt(start.sqrtPriceX96), L = BigInt(start.liquidity);
  const growth = [0n, 0n];
  const sides = [0, 1].map(() => ({ swaps: 0, crossing: 0, empty: 0, extras: 0, backwards: 0, still: 0, unpriced: 0, fromCrossing: 0n, fromExtras: 0n }));
  for (const e of evs) {
    if (e.kind === 'flash' || e.kind === 'donate') {
      for (const i of [0, 1]) {
        const paid = BigInt(e.paid?.[i] ?? 0n);
        if (paid <= 0n) continue;
        if (e.kind === 'flash' && meta.feeProtocol == null) { sides[i].unpriced++; continue; }
        const n = e.kind === 'flash' ? BigInt(i === 0 ? meta.feeProtocol % 16 : meta.feeProtocol >> 4) : 0n;
        const add = L > 0n ? ((paid - (n > 0n ? paid / n : 0n)) << 128n) / L : 0n;
        growth[i] += add; sides[i].extras++; sides[i].fromExtras += add;
      }
      continue;
    }
    const s = e;
    if (s.in == null || s.sqrtPriceX96 == null || !(BigInt(s.sqrtPriceX96) > 0n)) {
      if (s.sqrtPriceX96 != null && BigInt(s.sqrtPriceX96) > 0n) P = BigInt(s.sqrtPriceX96);
      if (s.liquidity != null) L = BigInt(s.liquidity);
      continue;
    }
    const sd = sides[s.in], P1 = BigInt(s.sqrtPriceX96), L1 = BigInt(s.liquidity ?? 0n), down = s.in === 0, gross = BigInt(s.amountIn);
    sd.swaps++;
    const r = lpRate(s, meta);
    let add = 0n;
    if (!r) sd.unpriced++;
    else if (down ? P1 > P : P1 < P) {
      // the price moved against the input: an event is missing or out of order; fall back to fee ÷ post-swap liquidity
      sd.backwards++;
      const f = swapFees(s, meta);
      add = f && L1 > 0n ? (f.lp << 128n) / L1 : 0n;
    } else if (L1 === L && L > 0n && !crossesTick(path, down ? P1 : P, down ? P : P1)) {
      const net = down ? amount0Delta(P1, P, L, true) : amount1Delta(P, P1, L, true);
      const fee = gross > net ? gross - net : 0n;
      if (P1 === P) sd.still++; // the price didn't move: the whole input is fee (dust), or the event is a duplicate
      // A swap can't pay more than its input × the fee rate (plus rounding). More means the replay's
      // inputs disagree (a duplicate or missing event, or a liquidity change it can't see): that swap
      // falls back to its own fee ÷ its post-swap liquidity, and is counted.
      const most = (gross * BigInt(s.v === 3 ? meta.fee : s.fee)) / PIPS + 3n;
      if (fee > most) {
        sd.inconsistent = (sd.inconsistent || 0) + 1;
        const f = swapFees(s, meta);
        add = f && L1 > 0n ? (f.lp << 128n) / L1 : 0n;
      } else add = ((fee - r.cut(fee, gross)) << 128n) / L;
    } else {
      const { d, full } = liveDelta(path, down ? P1 : P, down ? P : P1, down);
      add = ((down ? d : d << 32n) * r.num) / r.den;
      sd.crossing++; sd.fromCrossing += add;
      if (d < full) sd.empty++;
    }
    growth[s.in] += add;
    P = P1; L = L1;
  }
  return { growth, sides, end: { sqrtPriceX96: P, liquidity: L } };
}

// Replay ÷ counter per token side. null where neither moved (nothing to check) or the counters are
// unread; a counter that moved with no replayed fee (or the reverse) is a real miss, not a blank.
export function feeIdentityPath(replay, fgThen, fgNow) {
  if (!replay || !fgThen || !fgNow) return null;
  return [0, 1].map((side) => {
    const d = Number(BigInt.asUintN(256, fgNow[side] - fgThen[side])), e = Number(replay.growth[side]);
    if (d === 0 && e === 0) return null;
    return d === 0 ? Infinity : e / d;
  });
}

// A pool's price for its base token against the market's, as a ratio (1 = agrees).
export function priceRatio({ poolPrice, quoteIs, usd0, usd1 }) {
  if (!(poolPrice > 0) || !(usd0 > 0) || !(usd1 > 0)) return null;
  const market = usd0 / usd1; // token1 per token0 at market prices
  return quoteIs === 0 ? market / poolPrice : poolPrice / market;
}

// Per-pool checklist items (null = didn't run, never a pass).
// creation-events: the pool's own creation event (v3 PoolCreated / v4 Initialize) was found. Missing
// from a complete event record is a fail; missing from a partial record (v4 reads only recent
// weeks, or the v3 read stopped) is unread.
export function creationCheck({ createdAt, complete }) {
  if (createdAt != null && Number.isFinite(createdAt)) return true;
  return complete === true ? false : null;
}

// fees-vs-aggregator: our 24 h fees (LP + protocol, USD) against the aggregator's 24 h volume × the
// pool's total fee rate; within ±tol. Missing anything → null.
export function feesVsAggregator({ feesUsd, aggVolumeUsd, feeTier, tol = 0.1 }) {
  if (typeof feesUsd !== "number" || !(feesUsd >= 0) || !(aggVolumeUsd > 0) || !(feeTier > 0)) return { ok: null, ratio: null };
  const ratio = feesUsd / (aggVolumeUsd * feeTier);
  return { ok: Math.abs(ratio - 1) <= tol, ratio };
}

// token-age-rank: every non-quote token has a CoinGecko rank and has traded on Uniswap v3 for at
// least minDays (its first pool's creation). Quote tokens pass. Unknown age → null.
export function tokenAgeRank(tokens, { now, minDays }) {
  let unknown = false;
  for (const t of tokens) {
    if (!t || t.quote) continue;
    if (t.rank == null) return false;
    if (t.firstPoolAt == null) { unknown = true; continue; }
    if ((now - t.firstPoolAt) / 86400 < minDays) return false;
  }
  return unknown ? null : true;
}
