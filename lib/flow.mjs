// Volatility and markouts, the two inputs that judge whether fees are worth the risk.
//
// dailySigma: the daily volatility of a price series, from log returns. Gaps of up to 7 days are
// bridged (a k-day return counts as k days of variance); a window needs at least two thirds of its days.
//
// markouts: how much each swap cost LPs beyond the fee it paid. For each swap, the pool's inventory
// change (what it received minus what it paid) is valued at the pool's price `horizon` blocks later.
// That value is the fee plus or minus adverse selection: adverse = fee − value. Summed over swaps,
// adverse ÷ fees near 0 means flow that doesn't predict the price; near 1 or above means informed
// flow (arbitrage) takes the fees back.

export function dailySigma(points, { days = 30, now = null, minShare = 2 / 3, maxGapDays = 7 } = {}) {
  const pts = points.filter((p) => p && p.price > 0 && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const end = now ?? pts[pts.length - 1].t, start = end - days * 86400;
  const w = pts.filter((p) => p.t >= start - 43200 && p.t <= end + 43200);
  let sumSq = 0, spanDays = 0, used = 0;
  for (let i = 1; i < w.length; i++) {
    const k = Math.round((w[i].t - w[i - 1].t) / 86400);
    if (k < 1) continue;
    if (k > maxGapDays) return null; // a hole too long to bridge: don't invent a quiet stretch
    const r = Math.log(w[i].price / w[i - 1].price);
    sumSq += r * r; spanDays += k; used++;
  }
  if (spanDays < Math.ceil(days * minShare) || used < 5) return null;
  return Math.sqrt(sumSq / spanDays);
}

// Two USD series → their ratio by day (UTC), e.g. token per WETH.
export function ratioByDay(a, b) {
  const day = (t) => Math.floor(t / 86400);
  const m = new Map(b.filter((p) => p.price > 0).map((p) => [day(p.t), p.price]));
  return a.filter((p) => p.price > 0 && m.has(day(p.t))).map((p) => ({ t: p.t, price: p.price / m.get(day(p.t)) }));
}

const rawPrice = (sqrtPriceX96) => { const s = Number(sqrtPriceX96) / 2 ** 96; return s * s; }; // token1 raw per token0 raw

// swaps: decoded swaps of ONE pool (lib/swaps.mjs), any order. feeOf(s) → total fee in raw input units.
// Returns { adverse, fees, ratio, counted, skipped } in raw token1 units; null when nothing could be counted.
export function markouts(swaps, { horizon = 25, endBlock, feeOf }) {
  const ss = swaps.filter((s) => s && s.in != null && s.amountIn > 0n).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  let adverse = 0, fees = 0, counted = 0, skipped = 0, j = 0;
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i], target = s.block + horizon;
    if (endBlock != null && target > endBlock) { skipped++; continue; } // horizon not over yet
    if (j < i) j = i;
    while (j + 1 < ss.length && ss[j + 1].block <= target) j++;
    const pf = rawPrice(ss[j].sqrtPriceX96);
    const fee = feeOf(s);
    if (fee == null || !(pf > 0)) { skipped++; continue; }
    const aIn = Number(s.amountIn), aOut = Number(s.amountOut);
    // value to the pool of what it received minus what it paid, in token1 at the later price
    const value = s.in === 0 ? aIn * pf - aOut : aIn - aOut * pf;
    const feeT1 = s.in === 0 ? Number(fee) * pf : Number(fee);
    adverse += feeT1 - value; fees += feeT1; counted++;
  }
  if (!counted || !(fees > 0)) return null;
  return { adverse, fees, ratio: adverse / fees, counted, skipped };
}
