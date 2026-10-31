// Persistence from day one, without stored history: a pool's maps at a few past blocks.
// - strandedShare: of the snapshots (now and the past ones), the share where the pool was stranded;
//   times 30 it stands in for "days stranded in the last 30" until daily history exists.
// - stickyShare: of the liquidity parked away from the price today, the share (by value) that was
//   already at the same ticks at the oldest snapshot: walls that sit still, not vaults that move.
import { valueInRange } from './v3math.mjs';

// Piecewise-constant liquidity by tick from map segments: L at tick t.
function levelAt(segments, t) {
  for (const s of segments) if (s.lo <= t && t < s.hi) return s.L;
  return 0n;
}

// segmentsNow/Then: map segments; activeL: liquidity at today's price; tick: today's tick.
// Value is measured at today's price (sqrt raw price sp, token1 decimals d1).
export function stickyShare(segmentsNow, segmentsThen, { tick, activeL, sp, d1 }) {
  if (!segmentsNow || !segmentsThen) return null;
  const cuts = [...new Set([...segmentsNow, ...segmentsThen].flatMap((s) => [s.lo, s.hi]))].sort((a, b) => a - b);
  const La = BigInt(activeL);
  let parked = 0, kept = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const lo = cuts[i], hi = cuts[i + 1];
    if (!(hi <= tick || lo > tick)) continue; // the stretch holding the price is not parked
    const now = levelAt(segmentsNow, lo), then = levelAt(segmentsThen, lo);
    if (now <= La) continue;
    const ex = now - La, keep = (then > La ? then - La : 0n);
    const k = keep < ex ? keep : ex;
    parked += valueInRange(ex, lo, hi, sp, d1);
    if (k > 0n) kept += valueInRange(k, lo, hi, sp, d1);
  }
  return parked > 0 ? kept / parked : null;
}

// hollows: hollowness of each snapshot (null = unread). Needs at least half read.
export function strandedShare(hollows, threshold = 0.8) {
  const read = hollows.filter((h) => h != null);
  if (read.length < Math.ceil(hollows.length / 2)) return null;
  return read.filter((h) => h >= threshold).length / read.length;
}
