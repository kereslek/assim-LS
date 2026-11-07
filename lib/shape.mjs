// Liquidity shape: how much of a pool's value sits inside a band around the price, how much is
// stranded outside it, where the big walls are, and a plain-words tag for the shape.
import { valueInRange, ticksForLog, logForTicks, MIN_TICK, MAX_TICK } from './v3math.mjs';

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

// The liquidity chart's bins: the pool's whole LP field, from its lowest to its highest initialized tick. Out to
// ±fine the bins are depthHistogram's own edges (the walls are still found on depthHistogram of the whole map,
// unchanged); past it, coarser bins coarseX times as wide continue to about ±0.64 in log price (+90% / −47%), as
// before; past those, "far" bins double in width at each step (farX) out to the furthest initialized tick on that side,
// with no cap but the tick limit itself (`far` can set one; the last bin is cut at the cap). About 58 to 82 bins.
// Full-range liquidity is a layer of its own: the liquidity present at every tick within ±wide (log) of the price
// (full-range positions, and any stack of wide positions covering that whole stretch), out as far as the liquidity
// stays at least that level. It comes off every bin and is returned as `fullRange` { v, a, b } (its value, and its
// extent as log offsets), so a chart can draw it as a flat layer instead of smearing it across the far bins, and the
// far bins stop where the rest of the liquidity ends. Then one "beyond" bucket a side holds whatever lies past the
// bins: a real 0 when the bins reach the side's last tick, which, uncapped, they always do.
// bins + beyond + fullRange.v = the whole map. Values in token1 units, like depthHistogram; each bin carries its centre
// o and its edges a, b as log offsets from the price, and `edges` lists every bin edge in order (bins + 1 of them).
// Missing is never zero: `unread` lists tick ranges [lo, hi) the map did not read. The segments are taken as walked
// out from the price (anchored at the pool's own liquidity there), so an unread chunk hides itself and everything past
// it on its side: those bins and that side's beyond are null. A chunk that holds the price hides every bin. A side with
// an unread chunk runs its far bins out to the cap (where its last tick is, nobody knows), null from the chunk outwards.
// With any unread chunk the layer can't be measured: fullRange.v is null and the bins hold everything. A bin past the
// last usable tick holds a real 0. Options { far: Math.LN10, wide: null } give the chart as it was before the whole field
// (no layer taken off: fullRange.v is null, not measured).
export const DEPTH = Object.freeze({ fine: 0.45, fineBins: 48, coarseBins: 5, coarseX: 2, farX: 2, far: Infinity, wide: 5 });
const EDGE_MARGIN = 32767; // the widest tick spacing: a pool's usable ticks start within this of MIN_TICK and MAX_TICK

// The full-range layer: { L, lo, hi } (ticks) or { L: 0n } when no liquidity spans ±wide around the price.
export function fullRangeLayer(segments, tickCurrent, { wide = DEPTH.wide } = {}) {
  const none = { L: 0n, lo: null, hi: null };
  if (!(wide > 0)) return none;
  const segs = segments.filter((x) => x.hi > x.lo).sort((x, y) => x.lo - y.lo);
  const X = ticksForLog(wide), lo = Math.max(tickCurrent - X, MIN_TICK + EDGE_MARGIN), hi = Math.min(tickCurrent + X, MAX_TICK - EDGE_MARGIN);
  if (!segs.length || !(hi > lo) || segs[0].lo > lo || segs.at(-1).hi < hi) return none;
  let L = null, a = -1, b = -1;
  for (let i = 0; i < segs.length; i++) {
    const x = segs[i];
    if (x.hi <= lo || x.lo >= hi) continue;
    if (a >= 0 && x.lo !== segs[i - 1].hi) return none; // a stretch with no segment: nothing spans it
    if (a < 0) a = i;
    b = i;
    if (L == null || x.L < L) L = x.L;
  }
  if (a < 0 || !(L > 0n)) return none;
  while (a > 0 && segs[a - 1].hi === segs[a].lo && segs[a - 1].L >= L) a--;
  while (b < segs.length - 1 && segs[b + 1].lo === segs[b].hi && segs[b + 1].L >= L) b++;
  return { L, lo: segs[a].lo, hi: segs[b].hi };
}

export function depthProfile(segments, sp, d1, tickCurrent, { fine = DEPTH.fine, fineBins = DEPTH.fineBins, coarseBins = DEPTH.coarseBins, coarseX = DEPTH.coarseX,
  farX = DEPTH.farX, far = DEPTH.far, wide = DEPTH.wide, unread = [] } = {}) {
  const hist = depthHistogram(segments, sp, d1, tickCurrent, { span: fine, buckets: fineBins });
  const half = ticksForLog(fine), w = (2 * half) / fineBins, cw = coarseX * w, outer = half + coarseBins * cw;
  const coarseLog = logForTicks(cw);
  // what the read covers, walking out from the price
  let rLo = -Infinity, rHi = Infinity, blind = false;
  const chunks = unread.filter(([a, b]) => b > a);
  for (const [a, b] of chunks) {
    if (a <= tickCurrent && tickCurrent < b) blind = true;
    else if (b <= tickCurrent) rLo = Math.max(rLo, b);
    else rHi = Math.min(rHi, a);
  }
  // the full-range layer comes off every bin (unknown with an unread chunk: the bins then hold everything)
  const layer = chunks.length || !(wide > 0) ? null : fullRangeLayer(segments, tickCurrent, { wide });
  const Lf = layer ? layer.L : 0n;
  const res = Lf > 0n ? segments.map((x) => (x.lo >= layer.lo && x.hi <= layer.hi ? { lo: x.lo, hi: x.hi, L: x.L - Lf } : x)) : segments;
  const fineHist = Lf > 0n ? depthHistogram(res, sp, d1, tickCurrent, { span: fine, buckets: fineBins }) : hist;
  // ticks [a, b) read in full? Past the tick limits there is nothing to read (a real 0).
  const covered = (a, b) => {
    const lo = Math.max(a, MIN_TICK), hi = Math.min(b, MAX_TICK);
    return !(hi > lo) || !(blind || lo < rLo || hi > rHi);
  };
  const valueIn = (a, b) => {
    if (!covered(a, b)) return null;
    let v = 0;
    for (const x of res) {
      if (x.L <= 0n) continue;
      const lo = Math.max(x.lo, a), hi = Math.min(x.hi, b);
      if (hi > lo) v += valueInRange(x.L, lo, hi, sp, d1);
    }
    return v;
  };
  // the far bins' outer edges on one side, as tick distances from the price: doubling widths from the coarse
  // bins' edge until the side's furthest initialized tick (of what is left after the layer) is inside, or the cap
  let lowest = Infinity, highest = -Infinity;
  for (const x of res) if (x.L > 0n) { lowest = Math.min(lowest, x.lo); highest = Math.max(highest, x.hi); }
  const capOf = (limit) => Math.min(ticksForLog(far), limit);
  const farEdges = (reach, cap) => {
    const out = [];
    for (let e = outer, fw = cw * farX; e < cap && e < reach; fw *= farX) { e = Math.min(cap, e + fw); out.push(e); }
    return out;
  };
  const sideUnread = (below) => blind || (below ? rLo > -Infinity : rHi < Infinity);
  const farBelow = farEdges(sideUnread(true) ? Infinity : tickCurrent - lowest, capOf(tickCurrent - MIN_TICK));
  const farAbove = farEdges(sideUnread(false) ? Infinity : highest - tickCurrent, capOf(MAX_TICK - tickCurrent));
  const bins = [];
  // a bin from tick distance x to y (signed: below the price is negative)
  const bin = (x, y) => { const a = logForTicks(x), b = logForTicks(y); bins.push({ o: (a + b) / 2, a, b, v: valueIn(tickCurrent + x, tickCurrent + y) }); };
  for (let j = farBelow.length - 1; j >= 0; j--) bin(-farBelow[j], j ? -farBelow[j - 1] : -outer);
  // the coarse bins, as before (same centres and edges)
  for (let j = coarseBins; j >= 1; j--) bins.push({ o: -fine - (j - 0.5) * coarseLog, a: logForTicks(-half - j * cw), b: logForTicks(-half - (j - 1) * cw), v: valueIn(tickCurrent - half - j * cw, tickCurrent - half - (j - 1) * cw) });
  // the fine bins: depthHistogram's centres and tick edges exactly (of what is left after the layer)
  fineHist.buckets.forEach((v, i) => bins.push({ o: -hist.span + (i + 0.5) * hist.bucketLog, a: logForTicks(-half + i * w), b: logForTicks(-half + (i + 1) * w),
    v: covered(tickCurrent - half + i * w, tickCurrent - half + (i + 1) * w) ? v : null }));
  for (let j = 1; j <= coarseBins; j++) bins.push({ o: fine + (j - 0.5) * coarseLog, a: logForTicks(half + (j - 1) * cw), b: logForTicks(half + j * cw), v: valueIn(tickCurrent + half + (j - 1) * cw, tickCurrent + half + j * cw) });
  for (let j = 0; j < farAbove.length; j++) bin(j ? farAbove[j - 1] : outer, farAbove[j]);
  const outBelow = farBelow.length ? farBelow.at(-1) : outer, outAbove = farAbove.length ? farAbove.at(-1) : outer;
  return {
    bins, hist,
    edges: [bins[0].a, ...bins.map((b) => b.b)],
    beyond: { below: sideUnread(true) ? null : valueIn(MIN_TICK, tickCurrent - outBelow), above: sideUnread(false) ? null : valueIn(tickCurrent + outAbove, MAX_TICK) },
    fullRange: layer == null ? { v: null, a: null, b: null } : Lf > 0n
      ? { v: valueInRange(Lf, layer.lo, layer.hi, sp, d1), a: logForTicks(layer.lo - tickCurrent), b: logForTicks(layer.hi - tickCurrent) } : { v: 0, a: null, b: null },
    span: [-logForTicks(outBelow), logForTicks(outAbove)],
    step: { fine: hist.bucketLog, coarse: coarseLog, edge: fine },
  };
}

// live.json's depth fields from a depthProfile, in USD at per1 (USD per token1). No profile or no
// price: no bars, and the span, the edges, the steps and the beyond read null (missing, never zero).
// depthEdges: every bar's edges in order (bars + 1 numbers), so bar i spans depthEdges[i] to
// depthEdges[i + 1]; depthSpan is its first and last. depthStep stays for readers of the first version.
// fullRangeUsd: the full-range layer the bars leave out (0 = none; null = not measured, the bars then hold
// everything); fullRangeSpan: its extent as log offsets, null when there is no layer.
const sig = (x, n) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(n)) : null);
export function depthFields(prof, per1) {
  if (!prof || !(typeof per1 === 'number' && Number.isFinite(per1))) {
    return { depth: [], depthSpan: null, depthEdges: null, depthStep: null, beyond: { below: null, above: null }, fullRangeUsd: null, fullRangeSpan: null };
  }
  const usd = (v) => (v == null ? null : sig(v * per1, 5));
  const edges = prof.edges.map((x) => sig(x, 6));
  return {
    depth: prof.bins.map((b) => [sig(b.o, 4), usd(b.v)]),
    depthSpan: [edges[0], edges.at(-1)],
    depthEdges: edges,
    depthStep: { fine: sig(prof.step.fine, 4), coarse: sig(prof.step.coarse, 4), edge: prof.step.edge },
    beyond: { below: usd(prof.beyond.below), above: usd(prof.beyond.above) },
    fullRangeUsd: usd(prof.fullRange?.v ?? null),
    fullRangeSpan: prof.fullRange?.a == null ? null : [sig(prof.fullRange.a, 6), sig(prof.fullRange.b, 6)],
  };
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

// Hollowness (the "stranded" measure): the share of the pool's value held as liquidity above the
// level that is active at the price. Wide or full-range positions include the price, so they add
// to that level and count as zero; walls parked away from the price count in full. 0 = the price is
// served by everything in the pool; near 1 = almost all of it sits away from the price.
// (A first version used "value outside a ±r band", which flagged pools of wide positions as stranded:
// it read 80% on UNI/WETH 0.3%, a normal pool.)
// near (log distance): liquidity closer to the price than this is never parked, however it is split
// into ranges (a stable pair's LPs crowd the ticks next to the price; that is served, not stranded).
// The scanner passes max(the suggested ±r, 2%).
export function hollowness(segments, sp, d1, tickCurrent, activeL, { near = 0 } = {}) {
  const La = BigInt(activeL), nt = near > 0 ? Math.ceil(ticksForLog(near)) : 0;
  let total = 0, above = 0, below = 0;
  for (const s of segments) {
    if (s.L <= 0n) continue;
    total += valueInRange(s.L, s.lo, s.hi, sp, d1);
    if (!(s.L > La)) continue;
    if (s.hi <= tickCurrent || s.lo > tickCurrent) {
      // the part of the segment beyond the near zone on its side of the price
      const lo = s.hi <= tickCurrent ? s.lo : Math.max(s.lo, tickCurrent + nt), hi = s.hi <= tickCurrent ? Math.min(s.hi, tickCurrent - nt) : s.hi;
      if (hi <= lo) continue;
      const v = valueInRange(s.L - La, lo, hi, sp, d1);
      if (s.hi <= tickCurrent) below += v; else above += v;
    }
  }
  if (!(total > 0)) return { hollow: null, aboveShare: null, excess: 0, total: 0 };
  const excess = above + below;
  return { hollow: excess / total, aboveShare: excess > 0 ? above / excess : null, excess, total };
}

// hollow: from hollowness(); aboveShare: share of the parked liquidity sitting above the price.
export function shapeTag({ hollow, aboveShare }) {
  if (hollow == null) return null;
  if (hollow >= 0.8) return aboveShare != null && (aboveShare >= 0.85 || aboveShare <= 0.15) ? 'one-sided' : 'stranded';
  if (hollow <= 0.3) return 'served';
  return 'mixed';
}

// The 30-day measure: of the daily snapshots, how many had the pool stranded.
export function strandedDays(dailyStranded, threshold = 0.8) {
  const read = dailyStranded.filter((x) => x != null);
  if (read.length < Math.ceil(dailyStranded.length / 2)) return null; // a window needs at least half its days
  return read.filter((x) => x >= threshold).length;
}
