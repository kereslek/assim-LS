// Gem score v2 (0-100): Stranded 25 + Yield 35 + Persistence 25 + Flow 15, minus 10 per warning.
// A failed check blocks the pool; a missing input leaves the score blank (null), never zero.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Persistence 0-1: half from how many of the last 30 days the pool stayed stranded, a quarter from
// how far the stranded liquidity sits in volatility terms (2 sigma-weeks or more counts in full),
// a quarter from the share of it held by inactive wallets rather than rebalancing vaults.
export function persistenceScore({ strandedDays30, wallSigma, inactiveShare }) {
  if (![strandedDays30, wallSigma, inactiveShare].every(isNum)) return null;
  return 0.5 * clamp(strandedDays30 / 30) + 0.25 * clamp(wallSigma / 2) + 0.25 * clamp(inactiveShare);
}

// Flow 0-1: 70% from low toxicity (markout well under the fee), 30% from breadth (about 100
// distinct traders a week counts in full).
export function flowScore({ markoutToFee, traders7d }) {
  if (![markoutToFee, traders7d].every(isNum)) return null;
  return 0.7 * clamp(1 - markoutToFee) + 0.3 * clamp(Math.log10(Math.max(1, traders7d)) / 2);
}

export function gemScore({ stranded, net, persistence, flow, warnings = [], fails = [] }) {
  if (fails.length) return { total: null, blocked: true, reasons: fails, parts: null, missing: [] };
  const missing = Object.entries({ stranded, net, persistence, flow }).filter(([, v]) => !isNum(v)).map(([k]) => k);
  if (missing.length) return { total: null, blocked: false, reasons: warnings, parts: null, missing };
  const parts = {
    stranded: Math.round(25 * clamp((stranded - 0.8) / 0.15)),
    yield: Math.round(35 * clamp(net / 0.5)),
    persistence: Math.round(25 * clamp(persistence)),
    flow: Math.round(15 * clamp(flow)),
  };
  const total = Math.max(0, parts.stranded + parts.yield + parts.persistence + parts.flow - 10 * warnings.length);
  return { total, blocked: false, reasons: warnings, parts, missing };
}

// ---- Gem now (replaces v2 in the windows; v2 stays for the scan's own candidate log) -------------------
// Score 0-100 = Yield now 45 + Thinness 25 + Flow quality 20 + Staying power 10 (a bonus only), minus 10 per
// warning and 5 per data check that did not run.
//   yield now   the typical day's net yield per $1,000 at the price (fees after dilution at the ticket, less
//               LVR and re-range costs): the MEDIAN of the last 7 days, so a one-day burst can't carry it;
//               $1.37 a day (50% a year) counts in full
//   thinness    the day's LP fees ÷ the value already inside ±r; 0.5% a day counts in full
//   flow        markout ÷ fee (70%) and distinct traders a week (30%, about 100 in full)
//   staying     the persistence score, when there is one (missing → 0, never a blank)
// Strictness: a safety check (contract-verified, sell-test, token-age-rank, verified) that failed → no gem;
// one that did not run → capped at 40, tag "unchecked". A data check that failed → no gem; not run → −5.
// Tags: "unconfirmed" (emerging pattern), "one-off" (one trader or tx paid over half of the biggest day).
export const SAFETY_CHECKS = Object.freeze(['contract-verified', 'sell-test', 'token-age-rank', 'verified']);
export const median = (a) => {
  const s = a.filter(isNum).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const meanOf = (x) => x.reduce((s, v) => s + v, 0) / x.length;

// daily: [{ t, feesPer1k, net }] oldest first. pattern: emerging | bursty | fading | steady | mixed | null.
export function patternOf(daily, { last24 = null } = {}) {
  const f = daily.map((d) => d.feesPer1k).filter(isNum);
  if (!f.length) return null;
  const last7 = f.slice(-7), med7 = median(last7), med = median(f.slice(-30));
  if (f.length <= 2 || (isNum(last24) && med7 > 0 && last24 >= 3 * med7)) return 'emerging';
  if (med > 0 && Math.max(...f.slice(-30)) / med >= 5) return 'bursty';
  if (f.length >= 7 && meanOf(f.slice(-7, -3)) > 0 && meanOf(f.slice(-3)) < 0.5 * meanOf(f.slice(-7, -3))) return 'fading';
  const mean7 = meanOf(last7), sd = Math.sqrt(meanOf(last7.map((v) => (v - mean7) ** 2)));
  const pos = daily.slice(-7).filter((d) => isNum(d.net) && d.net > 0).length;
  if (mean7 > 0 && sd / mean7 < 1 && pos >= 5) return 'steady';
  return 'mixed';
}

// burst: the biggest day against the typical one; oneTrader = the share of the biggest day's fees paid by
// its single largest trader or tx (known only when the biggest day is the latest one, from the day's replay).
export function burstOf(daily, { topTxShare = null } = {}) {
  const f = daily.map((d) => (isNum(d.feesPer1k) ? d.feesPer1k : null)), known = f.filter(isNum);
  if (!known.length) return { maxDay: null, medianDay: null, burstDays: 0, oneTrader: null };
  const medianDay = median(known), maxDay = Math.max(...known), at = f.lastIndexOf(maxDay);
  return { maxDay, medianDay, burstDays: medianDay > 0 ? known.filter((x) => x >= 5 * medianDay).length : 0,
    oneTrader: at === f.length - 1 && isNum(topTxShare) ? topTxShare : null };
}

// typical: how the yield reads the daily nets (the median; tests plant the mean to show it is caught).
export function gemNow({ daily = [], netPer1kDay = null, thinness = null, markoutToFee = null, traders7d = null, persistence = null,
  checks = [], warnings = [], last24 = null, topTxShare = null } = {}, { typical = median } = {}) {
  const pattern = patternOf(daily, { last24 }), burst = burstOf(daily, { topTxShare });
  const tags = [], reasons = [...warnings];
  const oneOff = isNum(burst.oneTrader) && burst.oneTrader > 0.5;
  if (oneOff) tags.push('one-off');
  if (pattern === 'emerging') tags.push('unconfirmed');
  // the typical day: the last 7 days' nets, without a one-off burst day
  let nets = daily.slice(-7).map((d) => d.net);
  if (oneOff) nets = nets.slice(0, -1);
  const fromHistory = nets.filter(isNum).length >= 3;
  const t = fromHistory ? typical(nets.filter(isNum)) : netPer1kDay;
  const flow = flowScore({ markoutToFee, traders7d });
  const missing = Object.entries({ yield: t, thinness, flow }).filter(([, v]) => !isNum(v)).map(([k]) => k);
  const failed = checks.filter((c) => c.ok === false).map((c) => c.label || c.id);
  const safetyUnrun = checks.filter((c) => SAFETY_CHECKS.includes(c.id) && c.ok == null).length;
  const dataUnrun = checks.filter((c) => !SAFETY_CHECKS.includes(c.id) && c.ok == null).length;
  if (safetyUnrun) tags.push('unchecked');
  const base = { pattern, burst, tags };
  if (failed.length) return { ...base, total: null, blocked: true, parts: null, warnings: failed, missing };
  if (missing.length) return { ...base, total: null, blocked: false, parts: null, warnings: reasons, missing };
  let y = 45 * clamp(t / ((0.5 * 1000) / 365));
  if (oneOff && !fromHistory) y *= 0.5; // no history to take the typical day from: halve a one-trader day
  const parts = { yield: Math.round(y), thinness: Math.round(25 * clamp(thinness / 0.005)), flow: Math.round(20 * clamp(flow)), staying: isNum(persistence) ? Math.round(10 * clamp(persistence)) : 0 };
  if (dataUnrun) reasons.push(`${dataUnrun} data checks not run (−5 each)`);
  let total = Math.max(0, parts.yield + parts.thinness + parts.flow + parts.staying - 10 * warnings.length - 5 * dataUnrun);
  if (safetyUnrun) { total = Math.min(total, 40); reasons.push(`${safetyUnrun} safety checks not run: capped at 40`); }
  return { ...base, total, blocked: false, parts, warnings: reasons, missing };
}
