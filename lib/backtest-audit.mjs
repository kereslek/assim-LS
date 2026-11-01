// Audit of one backtest run, recomputed from the canonical swaps on a separate code path. The job
// runs it on every window; each check has a planted fault in test/backtest-audit.test.mjs.
//
//   pool-fees  the engine's pool LP fees per token side = the scan's replay (lib/swaps.mjs summarize)
//              of the same window. Catches a swap counted twice or missed, the fee charged on the
//              wrong side, and a missing protocol cut. Reported as a ratio per side.
//   per-swap   every swap appears once per sleeve, and the fee booked follows the rule in
//              lib/backtest.mjs, recomputed here: within one stretch, LP fee × inside share ÷ activeL
//              per unit L; after a liquidity change, the price move inside × LP rate; then × L ×
//              activeL ÷ (activeL + ours), capped at the swap's fee. Catches fees earned out of range.
//   sum        the per-swap fees add up to feesUsd.
//   costs      one ledger entry per sleeve at entry and one per re-centre, each paying the gas and
//              the swap at the stated rate; the ledger adds up to costsUsd. Catches a skipped cost.
//   identity   net = fees + lvr + costs, fees ≥ 0, lvr ≤ 0, costs ≤ 0 (entry ≤ 0 and inside costs),
//              the annualised net leaves the entry out, share and time in range in 0..1.
import { swapFees, summarize } from './swaps.mjs';
import { sqrtAtTick } from './v3math.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const close = (a, b, rel = 1e-6, abs = 1e-9) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
const keyOf = (s) => (s.block != null && s.logIndex != null ? `${s.block}:${s.logIndex}` : null);
const sqrtOf = (s) => Number(s.sqrtPriceX96) / 2 ** 96;

// Input amount moved inside [sa, sb) as a share of the swap's whole input, at constant liquidity.
function insideShare(pre, post, sa, sb, side) {
  if (pre === post) return pre >= sa && pre < sb ? 1 : 0;
  if (side === 1) { // token1 in: the price rises, input ∝ Δ√P
    const a = Math.max(Math.min(pre, post), sa), b = Math.min(Math.max(pre, post), sb);
    return b > a ? (b - a) / Math.abs(post - pre) : 0;
  }
  const hi = Math.min(Math.max(pre, post), sb), lo = Math.max(Math.min(pre, post), sa); // token0 in: input ∝ Δ(1/√P)
  return hi > lo ? (1 / lo - 1 / hi) / Math.abs(1 / Math.min(pre, post) - 1 / Math.max(pre, post)) : 0;
}

// The scan's replay of the window's LP fees per side (raw units), grouped by fee settings.
export function replayLp(swaps, meta) {
  const groups = new Map();
  for (const s of swaps) { const m = s.meta ?? meta; if (!groups.has(m)) groups.set(m, []); groups.get(m).push({ ...s, pool: 'p' }); }
  const lp = [0n, 0n];
  for (const [m, ss] of groups) {
    const r = summarize(ss, new Map([['p', m]])).get('p');
    if (!r || r.unpriced) return null;
    lp[0] += r.lp[0]; lp[1] += r.lp[1];
  }
  return lp;
}

// r: simulate() output with trace; prep: the columns it ran on; swaps: the window's canonical swaps
// (decoded, deduplicated, with t); ctx: what the run was given (start, end, d0, d1, ref, refUsd, gasUsd, swapRate, ticket?).
export function auditBacktest(r, { prep, swaps, meta, ctx, feeFn = swapFees }) {
  const checks = {}, ratios = [null, null];
  if (!r || !prep || !swaps || !ctx) return { ok: false, checks: { inputs: false }, ratios, failed: ['inputs'] };
  const { start, end, d0 = 0, d1 = 0, ref = 1, refUsd, gasUsd, swapRate, ticket } = ctx;
  const win = swaps.filter((s) => s && (s.in === 0 || s.in === 1) && s.t > start.t && s.t <= end.t)
    .sort((a, b) => (a.block ?? 0) - (b.block ?? 0) || (a.logIndex ?? 0) - (b.logIndex ?? 0));

  // pool-fees
  const rep = replayLp(win, meta);
  if (!rep) checks['pool-fees'] = false;
  else {
    [0, 1].forEach((i) => { const want = Number(rep[i]), got = r.poolLp[i]; ratios[i] = want > 0 ? got / want : got > 0 ? Infinity : null; });
    checks['pool-fees'] = [0, 1].every((i) => (ratios[i] == null ? true : close(ratios[i], 1, 1e-9)));
  }

  // per-swap and sum
  const byKey = new Map(), prev = new Map(), prevL = new Map();
  let last = start.sp, lastL = isNum(start.L) ? start.L : null;
  for (const s of win) { const k = keyOf(s); byKey.set(k, s); prev.set(k, last); prevL.set(k, lastL); last = sqrtOf(s); lastL = Number(s.liquidity ?? 0n); }
  let perSwap = !!r.trace, booked = 0;
  if (r.trace) {
    const seen = new Set(), tr = r.trace, sleeves = r.ranges.length;
    const scale0 = 10 ** d0, scale1 = 10 ** d1;
    // each sleeve's inside share, then the swap's liquidity: the pool's plus all of ours on the path
    const share = tr.idx.map((i, j) => {
      const s = byKey.get(prep.keys[i]);
      return s && tr.L[j] > 0 ? insideShare(prev.get(prep.keys[i]), sqrtOf(s), sqrtAtTick(tr.ta[j]), sqrtAtTick(tr.tb[j]), s.in) : 0;
    });
    const oursOn = new Map(), raw = new Array(tr.idx.length).fill(0), owed = new Map(), lpOf = new Map();
    tr.idx.forEach((i, j) => { if (share[j] > 0) oursOn.set(i, (oursOn.get(i) || 0) + tr.L[j]); });
    for (let j = 0; j < tr.idx.length; j++) {
      const k = prep.keys[tr.idx[j]], s = byKey.get(k), id = `${k}#${tr.sleeve[j]}`;
      booked += tr.fee[j];
      if (!s || seen.has(id)) { perSwap = false; continue; }
      seen.add(id);
      const f = feeFn(s, s.meta ?? meta);
      if (!f) { perSwap = false; continue; }
      const pre = prev.get(k), post = sqrtOf(s), P = post * post, lp = Number(f.lp), one = ref === 1 ? (s.in === 0 ? P : 1) / scale1 : (s.in === 0 ? 1 : 1 / P) / scale0;
      const act = Number(s.liquidity ?? 0n), preL = prevL.get(k), L = tr.L[j];
      lpOf.set(tr.idx[j], lp * one);
      if (!(share[j] > 0)) continue;
      if (!(act > 0)) { raw[j] = (lp * one * share[j] * L) / oursOn.get(tr.idx[j]); continue; } // no one else at the price
      let perL;
      if (preL == null || preL === act || pre === post) perL = (lp * share[j]) / act; // one stretch: unit for unit
      else { // a liquidity change: the price move inside the range × the LP's rate
        const sa = sqrtAtTick(tr.ta[j]), sb = sqrtAtTick(tr.tb[j]), lo = Math.max(Math.min(pre, post), sa), hi = Math.min(Math.max(pre, post), sb);
        const net = Number(s.amountIn - f.total);
        perL = (s.in === 1 ? hi - lo : 1 / lo - 1 / hi) * (net > 0 ? lp / net : 0);
      }
      raw[j] = (one * L * perL * act) / (act + oursOn.get(tr.idx[j]));
    }
    tr.idx.forEach((i, j) => owed.set(i, (owed.get(i) || 0) + raw[j]));
    for (let j = 0; j < tr.idx.length; j++) {
      const i = tr.idx[j], tot = owed.get(i), lp = lpOf.get(i) ?? 0;
      const want = tot > lp && tot > 0 ? (raw[j] * lp) / tot : raw[j];
      if (!close(tr.fee[j], want, 1e-6, 1e-15)) perSwap = false;
    }
    if (seen.size !== win.length * sleeves) perSwap = false;
  }
  checks['per-swap'] = perSwap;
  checks.sum = !!r.trace && close(booked * refUsd, r.feesUsd, 1e-9, 1e-12);

  // costs
  const entries = r.ledger.filter((e) => e.kind === 'entry').length, recs = r.ledger.filter((e) => e.kind === 'recentre').length;
  const ledgerUsd = r.ledger.reduce((a, e) => a + e.gasUsd + e.swapUsd, 0);
  checks.costs = entries === r.ranges.length && recs === r.reranges &&
    r.ledger.every((e) => e.gasUsd === gasUsd && e.swapUsd >= 0 && close(e.swapUsd, e.swappedUsd * swapRate, 1e-9, 1e-12)) &&
    close(-ledgerUsd, r.costsUsd, 1e-9, 1e-12);

  // identity and bounds
  checks.identity = [r.feesUsd, r.lvrUsd, r.costsUsd, r.netUsd].every(isNum) && close(r.netUsd, r.feesUsd + r.lvrUsd + r.costsUsd, 1e-9, 1e-9) &&
    r.feesUsd >= 0 && r.lvrUsd <= 1e-9 * Math.max(1, Math.abs(r.feesUsd)) && r.costsUsd <= 0 &&
    (r.share == null || (r.share >= 0 && r.share <= 1 + 1e-9)) && r.tir >= 0 && r.tir <= 1 + 1e-9 &&
    r.series.net.every((x, i) => close(x, r.series.fees[i] + r.series.lvr[i] + r.series.costs[i], 1e-9, 1e-9)) &&
    isNum(r.entryUsd) && r.entryUsd <= 0 && r.entryUsd >= r.costsUsd - 1e-9 &&
    close(r.entryUsd, -r.ledger.filter((e) => e.kind === 'entry').reduce((a, e) => a + e.gasUsd + e.swapUsd, 0), 1e-9, 1e-12) &&
    (!isNum(ticket) || r.net == null || close(r.net, (((r.netUsd - r.entryUsd) / ticket) * 365) / r.days, 1e-9, 1e-12));

  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return { ok: failed.length === 0, checks, ratios, failed };
}
