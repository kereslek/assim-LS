// Pool scoring for one snapshot: the suggested range from volatility, what a ticket would earn in
// that range (diluted by the liquidity already at the price), what holding it costs (LVR, re-range
// swaps, gas), and the walls' distance in volatility terms. Any missing input → null fields.
import { valueInRange, ticksForLog } from './v3math.mjs';
import { suggestRange, feeAprAtTicket, netApr, swapCostPerRerange } from './economics.mjs';
import { wallSigma } from './shape.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// p: { tick, sqrt (raw sqrt price), d1, usdPer1, activeL (BigInt), feeTier (fraction, e.g. 0.003),
//      feesPerDayUsd, sigma, walls: { below, above } (log distances) }
// o: { days (holding horizon for the range), ticket, gasUsd }
export function scorePool(p, { days = 14, ticket = 1000, gasUsd = null } = {}) {
  const r = suggestRange(p.sigma, days);
  const out = { r, feeApr: null, lvr: null, net: null, edge: null, rerangeDays: null, wallSigmaBelow: null, wallSigmaAbove: null, bandValueUsd: null };
  if (p.walls && isNum(p.sigma)) {
    out.wallSigmaBelow = p.walls.below == null ? null : wallSigma(p.walls.below, p.sigma, 7);
    out.wallSigmaAbove = p.walls.above == null ? null : wallSigma(p.walls.above, p.sigma, 7);
  }
  if (r == null || !isNum(p.usdPer1) || p.activeL == null || !isNum(p.sqrt) || p.sqrt <= 0) return out;
  const t = Math.max(1, Math.round(ticksForLog(r)));
  // USD value of one unit of liquidity spread over the suggested band at the current price
  const perL = valueInRange(1n, p.tick - t, p.tick + t, p.sqrt, p.d1) * p.usdPer1;
  if (!(perL > 0)) return out;
  out.bandValueUsd = Number(p.activeL) * perL; // the active level's value over our band
  out.feeApr = feeAprAtTicket({ feesPerDay: p.feesPerDayUsd, bandValue: out.bandValueUsd, ticket });
  if (out.feeApr == null || !isNum(gasUsd)) return out;
  const n = netApr({ feeApr: out.feeApr, sigma: p.sigma, r, swapCost: swapCostPerRerange(p.feeTier), gasUsd, ticket });
  if (n) Object.assign(out, { lvr: n.lvr, net: n.net, edge: n.edge, rerangeDays: n.rerangeDays });
  return out;
}

// The 7-day and last-day log moves of a ratio series (for lens 3), or nulls.
export function recentMoves(points) {
  const pts = points.filter((x) => x.price > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 8) return { move7dLog: null, lastDayLog: null };
  const last = pts[pts.length - 1], day = (k) => pts.find((x) => Math.abs(x.t - (last.t - k * 86400)) < 43200);
  const d1 = day(1), d7 = day(7);
  return { move7dLog: d7 ? Math.log(last.price / d7.price) : null, lastDayLog: d1 ? Math.log(last.price / d1.price) : null };
}
