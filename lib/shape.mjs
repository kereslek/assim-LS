// Liquidity shape: how much of a pool's value sits inside a band around the price, how much is
// stranded outside it, where the big walls are, and a plain-words tag for the shape.
import { valueInRange, ticksForLog, logForTicks } from './v3math.mjs';

// Exact value split for the band [tickLo, tickHi): each segment is clipped to the band and its
// token amounts recomputed, so inside + outside always equals the total.
export function bandStats(segments, sp, d1, tickLo, tickHi, tickCurrent) {
  let total = 0, inside = 0, above = 0, below = 0;
  for (const s of segments) {
    if (s.L <= 0n) continue;
    const v = valueInRange(s.L, s.lo, s.hi, sp, d1);
    total += v;
    const lo = Math.max(s.lo, tickLo), hi = Math.min(s.hi, tickHi);
    const vin = hi > lo ? valueInRange(s.L, lo, hi, sp, d1) : 0;
    inside += vin;
    // the part outside the band, split by side of the price
    if (s.lo < tickLo) below += valueInRange(s.L, s.lo, Math.min(s.hi, tickLo), sp, d1);
    if (s.hi > tickHi) above += valueInRange(s.L, Math.max(s.lo, tickHi), s.hi, sp, d1);
  }
  if (!(total > 0)) return { total: 0, inside: 0, outside: 0, stranded: null, aboveShare: null };
  const outside = above + below;
  return { total, inside, outside, stranded: outside / total, aboveShare: outside > 0 ? above / outside : null };
}

// Value by log-price bucket across ±span around the current tick (for charts and wall finding).
export function depthHistogram(segments, sp, d1, tickCurrent, { span = 0.45, buckets = 48 } = {}) {
  const half = ticksForLog(span), w = (2 * half) / buckets;
  const out = new Array(buckets).fill(0);
  for (const s of segments) {
    if (s.L <= 0n) continue;
    for (let i = 0; i < buckets; i++) {
      const lo = Math.max(s.lo, tickCurrent - half + i * w), hi = Math.min(s.hi, tickCurrent - half + (i + 1) * w);
      if (hi > lo) out[i] += valueInRange(s.L, lo, hi, sp, d1);
    }
  }
  return { buckets: out, span, bucketLog: logForTicks(w) };
}

// Nearest wall on each side: the closest bucket whose value density is at least densityFactor times
// the chart's average. Distances are log-price (divide by sigma*sqrt(days) to read them in volatility
// terms). Infinity = no wall in view (far away, which is good news); null = nothing could be charted.
export function nearestWalls(hist, { densityFactor = 2 } = {}) {
  const total = hist.buckets.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { below: null, above: null };
  const n = hist.buckets.length, mid = n / 2, bar = (densityFactor * total) / n;
  const dist = (i) => Math.abs(i + 0.5 - mid) * hist.bucketLog;
  let below = Infinity, above = Infinity;
  for (let i = Math.ceil(mid) - 1; i >= 0; i--) if (hist.buckets[i] >= bar) { below = dist(i); break; }
  for (let i = Math.floor(mid); i < n; i++) if (hist.buckets[i] >= bar) { above = dist(i); break; }
  return { below, above };
}

export const wallSigma = (logDist, sigma, days = 7) =>
  logDist == null || !(sigma > 0) ? null : logDist / (sigma * Math.sqrt(days));

// stranded: share of value outside the band; aboveShare: share of that outside value above the price.
export function shapeTag({ stranded, aboveShare }) {
  if (stranded == null) return null;
  if (stranded >= 0.8) return aboveShare != null && (aboveShare >= 0.85 || aboveShare <= 0.15) ? 'one-sided' : 'stranded';
  if (stranded <= 0.5) return 'peaked';
  return 'mixed';
}

// The 30-day measure: of the daily snapshots, how many had the pool stranded.
export function strandedDays(dailyStranded, threshold = 0.8) {
  const read = dailyStranded.filter((x) => x != null);
  if (read.length < Math.ceil(dailyStranded.length / 2)) return null; // a window needs at least half its days
  return read.filter((x) => x >= threshold).length;
}
