// One pool, one window: every strategy and the widths × triggers grid, in the shape docs/DATA.md
// gives `Backtest`. Pure functions, no I/O.
//
// Widths follow the scanner: ours is ±r with r = suggestRange(σ, hold days, 14 by default) (lib/economics.mjs), so
// the backtest replays the range the scanner would have suggested at the window start. Tight and
// wide are 0.68 r and 2 r (the 0.68 σ√T and 2 σ√T bands when r = σ√T). Swap costs use the
// scanner's model too: the pool's fee capped at 0.3% (a cheaper route exists) plus 0.05% slippage,
// on the part of the position a re-centre has to swap.
import { prepare, simulate, sigmaFromSwaps, TRIGGERS } from './backtest.mjs';
import { suggestRange } from './economics.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const HOLD_DAYS = 14;
export const SLIPPAGE = 0.0005;
export const WIDTH_MULTS = [0.5, 0.68, 1, 1.5, 2, 3];
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export const swapRateFor = (feeTier) => (isNum(feeTier) ? Math.min(feeTier, 0.003) + SLIPPAGE : null);

// The named strategies at a base width r. Gamma-style: two sleeves of one ticket, a base ±r (70%)
// and a narrow ±r/3 (30%), each re-centred when it exits. Arrakis-style: a wider ±1.5 r kept
// near the centre, re-centred once the price is halfway to an edge. Full range never re-centres.
export function strategiesFor(r) {
  return [
    { id: 'ours', name: 'Ours: ±r, re-centre on exit', sleeves: [{ w: 1, r }], trigger: 'exit' },
    { id: 'tight', name: 'Tight: ±0.68r, re-centre on exit', sleeves: [{ w: 1, r: r4(0.68 * r) }], trigger: 'exit' },
    { id: 'wide', name: 'Wide: ±2r, re-centre on exit', sleeves: [{ w: 1, r: r4(2 * r) }], trigger: 'exit' },
    { id: 'gamma', name: 'Gamma-style: base ±r (70%) + narrow ±r/3 (30%)', sleeves: [{ w: 0.7, r }, { w: 0.3, r: r4(r / 3) }], trigger: 'exit' },
    { id: 'arrakis', name: 'Arrakis-style: ±1.5r, re-centre at 50% drift', sleeves: [{ w: 1, r: r4(1.5 * r) }], trigger: 'drift50' },
    { id: 'full', name: 'Full range', sleeves: [{ w: 1, full: true }], trigger: 'none' },
  ];
}

const roundSig = (x, n = 8) => (x === 0 || !isNum(x) ? x : Number(x.toPrecision(n)));
const roundUsd = (x) => (isNum(x) ? Math.round(x * 1e4) / 1e4 : null);
function packSeries(s) {
  return { t: s.t, px: s.px.map((x) => roundSig(x)), lo: s.lo.map((x) => roundSig(x)), hi: s.hi.map((x) => roundSig(x)),
    fees: s.fees.map(roundUsd), lvr: s.lvr.map(roundUsd), costs: s.costs.map(roundUsd), net: s.net.map(roundUsd) };
}

// input: {
//   swaps (decoded, each with t in ms; optional per-swap meta) or prep (from prepare),
//   pool: { d0, d1, spacing, meta, feeTier },
//   start: { t, sqrtPriceX96 | sp, tick }, end: { t },
//   usd: { ref: 0|1, refUsd }, sigma (daily, from the days before the window) | null,
//   ticket, gasUsd, swapRate?, holdDays? (default 14), forecastNet?, partial?, points?, feeFn? }
// Returns { backtest, ours, prep, reason } — backtest null with a reason when an input is missing.
export function runBacktest(input) {
  const { pool = {}, start = {}, end = {}, usd = {}, ticket, gasUsd, forecastNet = null, partial = false, points = 200, feeFn } = input || {};
  const prep = input.prep || prepare(input.swaps, { meta: pool.meta, feeFn, d0: pool.d0, d1: pool.d1, ref: usd.ref });
  if (prep.unpriced) return { backtest: null, prep, reason: 'unpriced' };
  const sp = isNum(start.sp) ? start.sp : start.sqrtPriceX96 != null ? Number(start.sqrtPriceX96) / 2 ** 96 : null;
  if (!(sp > 0)) return { backtest: null, prep, reason: 'start price' };
  const st = { t: start.t, sp, tick: start.tick };
  let sigma = isNum(input.sigma) ? input.sigma : null, sigmaFrom = sigma != null ? 'before' : null;
  if (sigma == null) { sigma = sigmaFromSwaps(prep, st, end); sigmaFrom = sigma != null ? 'window' : null; }
  const r = suggestRange(sigma, isNum(input.holdDays) && input.holdDays > 0 ? input.holdDays : HOLD_DAYS);
  const swapRate = isNum(input.swapRate) ? input.swapRate : swapRateFor(pool.feeTier);
  if (r == null) return { backtest: null, prep, reason: 'volatility' };
  if (swapRate == null || !isNum(gasUsd) || !isNum(usd.refUsd)) return { backtest: null, prep, reason: 'costs or prices' };
  const ctx = { start: st, end, d0: pool.d0, d1: pool.d1, ref: usd.ref, refUsd: usd.refUsd, ticket, gasUsd, swapRate, spacing: pool.spacing, points };

  const memo = new Map();
  const single = (w, trigger, opts) => {
    const key = `${w}|${trigger}`;
    if (!memo.has(key) || (opts?.trace && !memo.get(key)?.trace)) memo.set(key, simulate(prep, ctx, { id: key, sleeves: [{ w: 1, r: w }], trigger }, opts));
    return memo.get(key);
  };
  const ours = single(r, 'exit', { trace: true });
  if (!ours) return { backtest: null, prep, reason: 'inputs' };
  const strategies = strategiesFor(r).map((s) => {
    const one = s.sleeves.length === 1 && !s.sleeves[0].full ? single(s.sleeves[0].r, s.trigger) : simulate(prep, ctx, s);
    return { id: s.id, name: s.name, net: one?.net ?? null, netUsd: roundUsd(one?.netUsd), reranges: one?.reranges ?? null, series: one ? one.series.net.map(roundUsd) : [] };
  });
  const widths = WIDTH_MULTS.map((m) => r4(m * r));
  const grid = { widths, triggers: TRIGGERS, net: widths.map((w) => TRIGGERS.map((g) => single(w, g)?.net ?? null)) };
  return {
    prep, ours, reason: null,
    backtest: {
      days: ours.days, partial: !!partial, range: r, trigger: 'exit', sigma, sigmaFrom,
      forecastNet: isNum(forecastNet) ? forecastNet : null,
      net: ours.net, netUsd: roundUsd(ours.netUsd), feesUsd: roundUsd(ours.feesUsd), lvrUsd: roundUsd(ours.lvrUsd), costsUsd: roundUsd(ours.costsUsd),
      tir: ours.tir, reranges: ours.reranges, share: ours.share, swaps: ours.swaps,
      series: packSeries(ours.series), strategies, grid, revert: null,
    },
  };
}
