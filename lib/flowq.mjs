// Flow quality (Window.flow): who pays a pool's fees.
//
// retailShare: the share of the LPs' fees paid by swaps that don't look like arbitrage. A swap is
//   arb-like when it moves the pool toward the market price AND the trader comes out ahead at that price
//   (a positive markout for the trader, after the fee). The market price is the reference the markouts
//   already use (lib/flow.mjs): the pool's own price `horizon` blocks after the swap (about 5 minutes),
//   which arbitrage pulls to the exchanges' price. Toward = the swap leaves the pool closer to it in log
//   price than it found it. The price a swap found is the previous swap's (the window's first swap has
//   none and is not classified), so the share is over the classified swaps' LP fees, in token1 units.
// driftCorr: Spearman's rank correlation between each hour's LP fees and that hour's |log return| of the
//   pair (the pool's own price at the hourly snapshots): near 1, fees come with price moves (arbitrage
//   repricing the pool); near 0, they come regardless (flow that doesn't follow the price).
// routing: the share of swaps whose transaction was sent (tx.to) to a known router or aggregator
//   (lib/routers.mjs), from a stable sample of the window's transactions (the `sample` smallest hashes,
//   a uniform sample that changes little from one pass to the next, so a cache keeps it cheap).
// Missing is never zero: anything unread or too thin to say is null; a real 0 needs read data.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const lnRaw = (sqrtPriceX96) => { const s = Number(sqrtPriceX96) / 2 ** 96; return s > 0 ? 2 * Math.log(s) : null; }; // log of token1 raw per token0 raw
const rawPrice = (sqrtPriceX96) => { const s = Number(sqrtPriceX96) / 2 ** 96; return s * s; };

export const FLOWQ = Object.freeze({ minClassified: 10, minHours: 12, sample: 40, minRouted: 10 });

// One pool's swaps (lib/swaps.mjs decoded) → each swap's verdict: { swap, arb: true | false | null, fee (token1 raw units) | null }.
// feeOf(s) → the swap's LP fee in raw input units, or null. prev: the price before the first swap, when known.
export function classifySwaps(swaps, { horizon = 25, endBlock = null, feeOf, prev = null } = {}) {
  const ss = swaps.filter((s) => s && s.in != null && s.amountIn > 0n && s.sqrtPriceX96 != null && BigInt(s.sqrtPriceX96) > 0n)
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const out = [];
  let j = 0;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i], target = s.block + horizon;
    const before = i > 0 ? ss[i - 1].sqrtPriceX96 : prev;
    const fee = feeOf(s);
    const p1 = rawPrice(s.sqrtPriceX96), feeT1 = fee == null ? null : s.in === 0 ? Number(fee) * p1 : Number(fee);
    if (before == null || (endBlock != null && target > endBlock) || fee == null) { out.push({ swap: s, arb: null, fee: feeT1 }); continue; }
    if (j < i) j = i;
    while (j + 1 < ss.length && ss[j + 1].block <= target) j++;
    const lm = lnRaw(ss[j].sqrtPriceX96), l0 = lnRaw(before), l1 = lnRaw(s.sqrtPriceX96);
    if (![lm, l0, l1].every(isNum)) { out.push({ swap: s, arb: null, fee: feeT1 }); continue; }
    const toward = Math.abs(l1 - lm) < Math.abs(l0 - lm);
    // the pool's side, valued at the later price (as lib/flow.mjs markouts): negative = the trader gained, after the fee
    const pm = Math.exp(lm), aIn = Number(s.amountIn), aOut = Number(s.amountOut);
    const poolValue = s.in === 0 ? aIn * pm - aOut : aIn - aOut * pm;
    out.push({ swap: s, arb: toward && poolValue < 0, fee: feeT1 });
  }
  return out;
}

// → { share, classified, arbs, fees } or null (fewer than minClassified swaps classified, or no fees among them).
export function retailShare(verdicts, { minClassified = FLOWQ.minClassified } = {}) {
  const c = (verdicts || []).filter((v) => v && v.arb != null && isNum(v.fee) && v.fee >= 0);
  const fees = c.reduce((s, v) => s + v.fee, 0);
  if (c.length < minClassified || !(fees > 0)) return null;
  const retail = c.filter((v) => !v.arb).reduce((s, v) => s + v.fee, 0);
  return { share: retail / fees, classified: c.length, arbs: c.filter((v) => v.arb).length, fees };
}

// Average ranks, ties sharing the mean of their positions (1-based).
export function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let k = i;
    while (k + 1 < idx.length && idx[k + 1][0] === idx[i][0]) k++;
    const avg = (i + k) / 2 + 1;
    for (let m = i; m <= k; m++) r[idx[m][1]] = avg;
    i = k + 1;
  }
  return r;
}

// Spearman's ρ: the Pearson correlation of the ranks. null with fewer than minN pairs or a constant side.
export function spearman(xs, ys, { minN = 3 } = {}) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length) return null;
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isNum(x) && isNum(y));
  if (pairs.length < minN) return null;
  const rx = ranks(pairs.map((p) => p[0])), ry = ranks(pairs.map((p) => p[1]));
  const n = pairs.length, mx = rx.reduce((s, v) => s + v, 0) / n, my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// rows: history.json-style hourly rows [t ms, price, liquidity, lpFeesUsd (since the row before), parked],
// ascending. Only steps between 30 and 90 minutes count (an hour each); a step with its fees or either price
// unread is left out. → { rho, hours } or null with fewer than minHours steps.
export function driftCorr(rows, { from = -Infinity, to = Infinity, minHours = FLOWQ.minHours } = {}) {
  const fees = [], moves = [];
  for (let i = 1; i < (rows || []).length; i++) {
    const [t, px, , f] = rows[i], [t0, px0] = rows[i - 1];
    if (!(t > from && t <= to)) continue;
    const dt = (t - t0) / 3600e3;
    if (!(dt >= 0.5 && dt <= 1.5) || !isNum(f) || !(px > 0) || !(px0 > 0)) continue;
    fees.push(f / dt); moves.push(Math.abs(Math.log(px / px0)));
  }
  if (fees.length < minHours) return null;
  const rho = spearman(fees, moves);
  return rho == null ? null : { rho, hours: fees.length };
}

// The stable sample: up to n of the pool's distinct tx hashes, the smallest ones.
export function txSample(swaps, n = FLOWQ.sample) {
  return [...new Set((swaps || []).map((s) => s?.tx).filter((h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)).map((h) => h.toLowerCase()))].sort().slice(0, n);
}

// swaps: the pool's swaps in the window; txs: Map(hash → { to, from } | null) as read; isRouter(to) → bool.
// → { share, routed, known, sampled } or null when under minRouted sampled transactions were read.
export function routingShare(swaps, txs, isRouter, { sample = FLOWQ.sample, minRouted = FLOWQ.minRouted } = {}) {
  const hs = txSample(swaps, sample);
  const per = new Map();
  for (const s of swaps || []) { const h = String(s?.tx || '').toLowerCase(); if (hs.includes(h)) per.set(h, (per.get(h) || 0) + 1); }
  let known = 0, routed = 0, read = 0;
  for (const h of hs) {
    const t = txs?.get(h);
    if (!t || typeof t.to !== 'string') continue;
    read++;
    const n = per.get(h) || 1;
    known += n;
    if (isRouter(t.to)) routed += n;
  }
  if (hs.length < minRouted || read < Math.max(minRouted, Math.ceil(hs.length / 2)) || !known) return null;
  return { share: routed / known, routed, known, sampled: hs.length };
}

// Distinct senders (tx.from) over ALL the window's transactions; null unless every one was read.
export function sendersOf(swaps, txs) {
  const hs = [...new Set((swaps || []).map((s) => String(s?.tx || '').toLowerCase()).filter(Boolean))];
  if (!hs.length) return 0; // read, and no swaps: a real zero
  const from = new Set();
  for (const h of hs) { const t = txs?.get(h); if (!t || typeof t.from !== 'string') return null; from.add(t.from.toLowerCase()); }
  return from.size;
}

// Longer windows from the daily record (live.json pool.flowDaily: [[day ms, retailShare, lpFeesUsd, routing]]):
// the fee-weighted mean of retailShare and the mean of routing over the days inside [from, to].
export function dailyFlow(rows, { from, to, minDays = 3 } = {}) {
  const inside = (rows || []).filter((r) => Array.isArray(r) && r[0] >= from && r[0] <= to);
  const rs = inside.filter((r) => isNum(r[1]) && isNum(r[2]) && r[2] > 0), w = rs.reduce((s, r) => s + r[2], 0);
  const ro = inside.filter((r) => isNum(r[3]));
  return {
    retailShare: rs.length >= minDays && w > 0 ? rs.reduce((s, r) => s + r[1] * r[2], 0) / w : null,
    routing: ro.length >= minDays ? ro.reduce((s, r) => s + r[3], 0) / ro.length : null,
  };
}

// Carry the daily record forward: today's entry replaced by this pass's 24 h values, at most `keep` days.
export function nextFlowDaily(prev, { now, retailShare = null, lpFeesUsd = null, routing = null, keep = 30 } = {}) {
  const day = Math.floor(now / 86400e3) * 86400e3;
  const rows = (Array.isArray(prev) ? prev : []).filter((r) => Array.isArray(r) && isNum(r[0]) && r[0] !== day && r[0] > now - keep * 86400e3);
  const fx = (x, n) => (isNum(x) ? Number(x.toPrecision(n)) : null);
  if ([retailShare, routing].some(isNum)) rows.push([day, fx(retailShare, 4), fx(lpFeesUsd, 5), fx(routing, 4)]);
  return rows.sort((a, b) => a[0] - b[0]).slice(-keep);
}
