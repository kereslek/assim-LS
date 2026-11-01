// Time-window metrics (docs/DATA.md "Window") for one pool, from its snapshot rows (lib/snapshots.mjs)
// plus the current state and the pool's settings. Pure: no I/O, no clock (now = the current state's t).
//
// Fees come from the pools' own fee-growth counters:
//   - pool LP fees = Σ over snapshot intervals of Δfg × L of that interval (L = the harmonic mean of the
//     interval's two ends: exact when the liquidity changes once, mid-interval, at a steady fee rate);
//     volume = LP fees ÷ the LP fee rate (fee tier × the LPs' share after the protocol's cut), per token;
//     protocol fees = volume × fee tier − LP fees.
//   - fee APR at the ticket = 365·F / (V + S): F = the pool's LP fees per day over the window, V = the
//     value already inside ±r (today's map; without one, the active liquidity's value over ±r), S = the
//     ticket. A re-centring position shares the in-range fees with what is already there. (A first version
//     diluted in liquidity units against the active liquidity at the current tick: a stable pool whose
//     LPs sit in the ticks next to the price read 69% instead of 1%.)
//   - Δfg wraps at 2^256: the counters are uint256 and overflow by design.
// σ (daily) from hourly log returns for windows up to 7 days, from daily returns beyond (hourly when a
// young pool has too few days): σ² = Σ r² / Σ Δt in days, so a missed hour only makes the next return
// longer. Then r = σ√holdDays (economics.suggestRange), LVR = 365σ²/8 · 1/(1 − e^(−r/2)), re-ranges
// N = 365σ²/r², swap cost N × cost per re-range, gas N × gas ÷ ticket, net, edge = fee APR ÷ LVR.
//
// Young pools: days = what the rows cover, partial = more than one step short of the window; under a
// day of data the window is null. Missing is never zero: any field whose inputs are missing is null,
// and an unread row is skipped (the counters are cumulative, so the next read row bridges the gap).
import { valueInRange, ticksForLog } from './v3math.mjs';
import { suggestRange, lvrApr, rerangesPerYear, swapCostPerRerange } from './economics.mjs';
import { bandStats, wallSigma } from './shape.mjs';
import { gemNow, median, persistenceScore } from './gem.mjs';
import { lensStranded, lensFreshPool, lensAfterMove, toxicFilter, DEFAULTS as LENS } from './lenses.mjs';
import { HOUR, DAY, TIERS, tierFor, rowsIn } from './snapshots.mjs';

const LN_BASE = Math.log(1.0001);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pos = (x) => isNum(x) && x > 0;
const sig = (x, n) => (isNum(x) ? Number(x.toPrecision(n)) : null);

export const DEFAULT_WINDOWS = Object.freeze(['24h', '7d', '30d']);

// '24h' → ms, '7d' → ms; anything else → null.
export function windowMs(w) {
  const m = /^(\d{1,3})([hd])$/.exec(String(w));
  return m && Number(m[1]) > 0 ? Number(m[1]) * (m[2] === 'h' ? HOUR : DAY) : null;
}

export const deltaFg = (a, b) => BigInt.asUintN(256, b - a);

// The building blocks the window maths is made of. Tests swap one for a faulty copy to show the checks
// catch it (a planted fault); production always uses these.
export const PARTS = Object.freeze({
  deltaFg,
  // one interval's liquidity from its two ends
  intervalL: (a, b) => (a > 0n && b > 0n ? (2n * a * b) / (a + b) : a > b ? a : b),
  // pool LP fees of one interval, raw units per token: Δfg × L
  poolRaw: (d0, d1, L) => [(d0 * L) >> 128n, (d1 * L) >> 128n],
  // the share of the in-range fees a ticket S keeps next to the value V already in range
  dilution: (V, S) => S / (V + S),
  // how the gem reads the typical day from the daily nets
  typical: median,
});

const priceRead = (p) => p && (p.sqrtPriceX96 != null || p.tick != null);
const feeRead = (p) => p && p.fg0 != null && p.fg1 != null && p.L != null;
const anyRead = (p) => p && ['block', 'sqrtPriceX96', 'tick', 'L', 'fg0', 'fg1', 'parked'].some((k) => p[k] != null);
// log of the raw price (token1 raw per token0 raw)
const logPrice = (p) => (p.sqrtPriceX96 != null && p.sqrtPriceX96 > 0n ? 2 * Math.log(Number(p.sqrtPriceX96) / 2 ** 96) : p.tick != null ? p.tick * LN_BASE : null);

// Daily σ from points with a price: σ² = Σ r² / Σ Δt (days). Needs at least minReturns returns.
export function sigmaOf(points, { minReturns = 12 } = {}) {
  const pts = points.filter(priceRead).map((p) => ({ t: p.t, lp: logPrice(p) })).filter((p) => isNum(p.lp)).sort((a, b) => a.t - b.t);
  let sumSq = 0, days = 0, n = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / DAY;
    if (!(dt > 0)) continue;
    const r = pts[i].lp - pts[i - 1].lp;
    sumSq += r * r; days += dt; n++;
  }
  return n >= minReturns && days > 0 ? Math.sqrt(sumSq / days) : null;
}

// Token decimals and USD prices; a missing USD price is derived from the other side at the pool's price.
function pricing(pool, cur) {
  const { d0, d1 } = pool;
  if (!Number.isInteger(d0) || !Number.isInteger(d1) || !priceRead(cur)) return null;
  const lp = logPrice(cur), raw = Math.exp(lp), px = raw * 10 ** (d0 - d1); // token1 per token0, human units
  let usd0 = pos(pool.usd0) ? pool.usd0 : null, usd1 = pos(pool.usd1) ? pool.usd1 : null;
  if (usd0 == null && usd1 != null && px > 0) usd0 = usd1 * px;
  if (usd1 == null && usd0 != null && px > 0) usd1 = usd0 / px;
  const tick = Number.isInteger(cur.tick) ? cur.tick : Math.floor(lp / LN_BASE);
  return { d0, d1, usd0, usd1, px, sp: Math.exp(lp / 2), tick };
}

// Raw amounts (numbers) → USD; null when a side that is needed has no price.
function usdOf(a0, a1, k) {
  if (!k || !isNum(a0) || !isNum(a1)) return null;
  const need0 = a0 !== 0, need1 = a1 !== 0;
  if ((need0 && !pos(k.usd0)) || (need1 && !pos(k.usd1))) return null;
  return (need0 ? (a0 / 10 ** k.d0) * k.usd0 : 0) + (need1 ? (a1 / 10 ** k.d1) * k.usd1 : 0);
}

const humanPrice = (p, k) => { const lp = logPrice(p); return isNum(lp) && k ? Math.exp(lp) * 10 ** (k.d0 - k.d1) : null; };

// The point nearest to t (within tol) across both tiers and the current state, as a log price.
function logPriceAt(series, cur, t, tol) {
  let best = null;
  for (const p of [...(series?.h || []), ...(series?.d || []), cur]) {
    if (!priceRead(p) || Math.abs(p.t - t) > tol) continue;
    if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  }
  return best ? logPrice(best) : null;
}

// A v4 pool with a hook, or whose hook address was not read (it can't be shown to have none).
export const isHooked = (p) => p?.v === 4 && (p.hooks == null || !/^0x0{40}$/i.test(String(p.hooks)));

// The gem's warnings (−10 points each) for a pool: { v, hooks, swaps24h, offMarket }.
export function gemWarnings({ v, hooks, swaps24h = null, offMarket = null } = {}) {
  const w = [];
  if (isHooked({ v, hooks })) w.push('hooked pool');
  if (isNum(swaps24h) && swaps24h < 10) w.push('thin: under 10 swaps a day');
  if (offMarket === true) w.push('pool price more than 10% off market');
  return w;
}

const oneSided = (a) => isNum(a) && (a >= 0.85 || a <= 0.15);

// One window. input: { window: '24h'|'7d'|'30d'|…, series, cur, pool, config, chain }
//   series  { h: rows, d: rows } from lib/snapshots.mjs (BigInt fields)
//   cur     the current state, a row plus optional { segments (today's liquidity map), aboveShare }
//   pool    { feeTier (fraction), lpKeeps (fraction, or [token0 side, token1 side]), d0, d1, usd0, usd1,
//             tvlUsd, gasUsd (one re-range in USD), walls: { below, above } (log distances),
//             inactiveShare, warnings, fails, poolAgeDays, pairAgeDays, volumeShare, liquidityShare,
//             flow: { '<window>': { swaps, traders, markout, gemFlow: { markoutToFee, traders7d } } },
//             checkList: [{ id, label, ok }] (the pool's checks; lib/gem.mjs gemNow reads safety and data checks),
//             flow['24h'].topTxShare (the day's largest trader or tx's share of its LP fees),
//             inRangeUsd: (r) => USD (if no segments) }
//   config  lib/config.mjs: ticket, holdDays (per chain), toxicMarkout, minPairAgeDays
export function windowMetrics({ window, series, cur, pool = {}, config = {}, chain } = {}, { parts = PARTS } = {}) {
  const W = windowMs(window);
  if (!W || !cur || !isNum(cur.t)) return null;
  const now = cur.t, wStart = now - W, tier = tierFor(W), { step } = TIERS[tier];
  const pts = [...rowsIn(series, tier, wStart - step, now - 1), cur];
  const first = pts.find(anyRead);
  if (!first) return null;
  const span = now - first.t;
  if (span < DAY - HOUR) return null; // under a day of data
  const days = span / DAY, partial = span < W - step;
  const win = pts.filter((p) => p.t >= first.t);
  const k = pricing(pool, cur);
  const ticket = config.ticket, holdDays = config.holdDays?.[chain] ?? pool.holdDays;

  // fees from fee growth
  const fp = win.filter(feeRead);
  let fees = null;
  // the fee counters must cover at least half the window (and a day): a window read over a few hours is
  // not labelled 7 or 30 days
  if (feeRead(cur) && fp.length >= 2 && now - fp[0].t >= DAY - HOUR && now - fp[0].t >= 0.5 * W) {
    const intervals = [];
    let raw0 = 0n, raw1 = 0n;
    for (let i = 1; i < fp.length; i++) {
      const a = fp[i - 1], b = fp[i];
      const d0 = parts.deltaFg(a.fg0, b.fg0), d1 = parts.deltaFg(a.fg1, b.fg1), L = parts.intervalL(a.L, b.L);
      const [r0, r1] = parts.poolRaw(d0, d1, L);
      raw0 += r0; raw1 += r1;
      intervals.push({ t1: b.t, d0, d1, L, raw: [r0, r1] });
    }
    fees = { days: (now - fp[0].t) / DAY, intervals, raw: [raw0, raw1] };
  }
  const lp0 = fees ? usdOf(Number(fees.raw[0]), 0, k) : null, lp1 = fees ? usdOf(0, Number(fees.raw[1]), k) : null;
  const lpFeesUsd = lp0 != null && lp1 != null ? lp0 + lp1 : null;
  const keeps = Array.isArray(pool.lpKeeps) ? pool.lpKeeps : [pool.lpKeeps, pool.lpKeeps];
  const rates = keeps.map((x) => (pos(pool.feeTier) && isNum(x) && x > 0 && x <= 1 ? pool.feeTier * x : null));
  const ratesOk = rates.every((x) => x != null);
  const volUsd = lpFeesUsd != null && ratesOk ? lp0 / rates[0] + lp1 / rates[1] : null;
  const protocolFeesUsd = lpFeesUsd != null && ratesOk ? (lp0 * (1 - keeps[0])) / keeps[0] + (lp1 * (1 - keeps[1])) / keeps[1] : null;

  // volatility and the range
  let sigma = sigmaOf(win, { minReturns: tier === 'h' ? 12 : 5 });
  if (sigma == null && tier === 'd') sigma = sigmaOf([...rowsIn(series, 'h', wStart - HOUR, now - 1), cur], { minReturns: 12 });
  const r = sigma != null && pos(holdDays) ? suggestRange(sigma, holdDays) : null;

  // V: the value already inside ±r at today's price (the map's; without one, the active liquidity's)
  let tRange = null, inRangeUsd = null;
  if (r != null && k && pos(k.usd1)) {
    tRange = Math.max(1, Math.round(ticksForLog(r)));
    if (Array.isArray(cur.segments)) inRangeUsd = bandStats(cur.segments, k.sp, k.d1, k.tick - tRange, k.tick + tRange, k.tick).inside * k.usd1;
    else if (typeof pool.inRangeUsd === 'function') { const v = pool.inRangeUsd(r); inRangeUsd = isNum(v) ? v : null; }
  }
  let V = inRangeUsd;
  if (V == null && tRange != null && cur.L != null) {
    const perL = valueInRange(1n, k.tick - tRange, k.tick + tRange, k.sp, k.d1) * k.usd1; // USD per unit of liquidity over ±r
    if (perL > 0) V = Number(cur.L) * perL;
  }
  // fee APR = 365·F/(V + S)
  const feeApr = fees && lpFeesUsd != null && isNum(V) && pos(ticket) ? ((365 * (lpFeesUsd / fees.days)) * parts.dilution(V, ticket)) / ticket : null;
  const lvr = r != null ? lvrApr(sigma, r) : null;
  const N = r != null ? rerangesPerYear(sigma, r) : null;
  const perRerange = swapCostPerRerange(pool.feeTier);
  const swapCost = N != null && perRerange != null ? N * perRerange : null;
  const gas = N != null && isNum(pool.gasUsd) && pos(ticket) ? (N * pool.gasUsd) / ticket : null;
  const net = [feeApr, lvr, swapCost, gas].every(isNum) ? feeApr - lvr - swapCost - gas : null;
  const edge = isNum(feeApr) && pos(lvr) ? feeApr / lvr : null;
  const rerangeDays = pos(N) ? 365 / N : null;

  const aggApr = fees && lpFeesUsd != null && pos(pool.tvlUsd) ? ((365 / fees.days) * lpFeesUsd) / pool.tvlUsd : null;

  // shape over the window's snapshots: at least half of them read, or at least 3 read ones spread over at
  // least half of the window (a backfill measures the shape on a few past days only)
  const hollows = win.map((p) => (isNum(p.parked) ? p.parked : null));
  const readP = win.filter((p) => isNum(p.parked)), readH = readP.map((p) => p.parked);
  const enough = readH.length >= Math.ceil(hollows.length / 2) || (readH.length >= 3 && readP.at(-1).t - readP[0].t >= span / 2);
  const parkedAvg = readH.length && enough ? readH.reduce((a, x) => a + x, 0) / readH.length : null;
  const strandedShare = enough && readH.length ? readH.filter((h) => h >= 0.8).length / readH.length : null;

  // flow (from the scan's swap replay, where it covers this window)
  const fl = pool.flow?.[window] || {};
  const swaps = isNum(fl.swaps) ? fl.swaps : null, traders = isNum(fl.traders) ? fl.traders : null, markout = isNum(fl.markout) ? fl.markout : null;

  // gem
  let wallMin = null;
  if (pool.walls && isNum(sigma)) {
    const ws = [pool.walls.below, pool.walls.above].filter((x) => x != null).map((d) => wallSigma(d, sigma, 7)).filter((x) => x != null);
    if (ws.length) wallMin = Math.min(...ws) === Infinity ? 99 : Math.min(...ws);
  }
  const persistence = persistenceScore({ strandedDays30: strandedShare == null ? null : 30 * strandedShare, wallSigma: wallMin, inactiveShare: pool.inactiveShare });
  // a window without its own swap replay may score flow from the latest one (gemFlow), shown nowhere else
  const gf = fl.gemFlow || {};
  const mk = markout ?? (isNum(gf.markoutToFee) ? gf.markoutToFee : null);
  const traders7d = traders != null ? (traders * 7) / Math.max(1, days) : isNum(gf.traders7d) ? gf.traders7d : null;

  // the daily record (up to 30 days): each day's fees per $1,000 at the price, after dilution at the ticket
  // against today's value in range, and its net after LVR and re-range costs; the latest entry is the last
  // 24 hours from the hourly rows
  const costPer1kDay = [lvr, swapCost, gas].every(isNum) ? ((lvr + swapCost + gas) * 1000) / 365 : null;
  const daily = [];
  if (k && isNum(V) && pos(ticket)) {
    const entry = (a, b) => {
      const dt = (b.t - a.t) / DAY;
      const [r0, r1] = parts.poolRaw(parts.deltaFg(a.fg0, b.fg0), parts.deltaFg(a.fg1, b.fg1), parts.intervalL(a.L, b.L));
      const usd = usdOf(Number(r0), Number(r1), k);
      return usd == null || !(dt > 0) ? null : (usd / dt) * 1000 / (V + ticket);
    };
    const push = (t, fpk) => daily.push({ t, feesPer1k: sig(fpk, 4), net: fpk == null || costPer1kDay == null ? null : sig(fpk - costPer1kDay, 4) });
    const dr = [...rowsIn(series, 'd', now - 31 * DAY, now - 1), cur].filter(feeRead);
    for (let i = 1; i < dr.length; i++) if (dr[i].t <= now - 20 * HOUR && dr[i].t - dr[i - 1].t >= 0.5 * DAY) push(dr[i].t, entry(dr[i - 1], dr[i]));
    const hr = [...rowsIn(series, 'h', now - 25 * HOUR, now - 1), cur].filter(feeRead);
    if (hr.length >= 2 && now - hr[0].t >= 20 * HOUR && feeRead(cur)) {
      let usd = 0;
      for (let i = 1; i < hr.length && usd != null; i++) { const e = entry(hr[i - 1], hr[i]); usd = e == null ? null : usd + e * ((hr[i].t - hr[i - 1].t) / DAY); }
      push(now, usd == null ? null : usd / ((now - hr[0].t) / DAY));
    }
    daily.splice(0, Math.max(0, daily.length - 30));
  }
  const thinness = fees && lpFeesUsd != null && pos(V) ? lpFeesUsd / fees.days / V : null; // the day's LP fees ÷ the value at the price
  const g = gemNow({
    daily, netPer1kDay: isNum(net) ? (net * 1000) / 365 : null, thinness, markoutToFee: mk, traders7d, persistence,
    checks: [...(pool.checkList || []), ...(pool.fails || []).map((l) => ({ id: l, label: l, ok: false }))], warnings: pool.warnings || [],
    last24: window === '24h' && isNum(feeApr) ? (feeApr * 1000) / 365 : null, topTxShare: isNum(fl.topTxShare) ? fl.topTxShare : null,
  }, { typical: parts.typical });
  const gem = { total: g.total, yield: g.parts?.yield ?? null, thinness: g.parts?.thinness ?? null, flow: g.parts?.flow ?? null, staying: g.parts?.staying ?? null,
    warnings: g.warnings, missing: g.missing, tags: g.tags };

  // lenses
  const lenses = [];
  if (lensStranded({ stranded30: parkedAvg })?.on) lenses.push(oneSided(cur.aboveShare ?? pool.aboveShare) ? 'one-sided' : 'stranded');
  const fresh = lensFreshPool({ poolAgeDays: pool.poolAgeDays, pairAgeDays: pool.pairAgeDays, volumeShare: pool.volumeShare, liquidityShare: pool.liquidityShare },
    { ...LENS, freshMinPairDays: isNum(config.minPairAgeDays) ? config.minPairAgeDays : LENS.freshMinPairDays });
  if (fresh?.on) lenses.push('fresh');
  const lpNow = logPrice(cur), lp7 = logPriceAt(series, cur, now - 7 * DAY, 12 * HOUR), lpDay = logPriceAt(series, cur, now - DAY, 2 * HOUR);
  const move = lensAfterMove({ move7dLog: isNum(lpNow) && isNum(lp7) ? lpNow - lp7 : null, lastDayLog: isNum(lpNow) && isNum(lpDay) ? lpNow - lpDay : null, sigma });
  if (move?.on) lenses.push('bigmove');
  if (isNum(sigma) && sigma < LENS.calmMaxSigma) lenses.push('calm');
  const toxic = toxicFilter({ markoutToFee: mk }, { ...LENS, maxMarkoutToFee: isNum(config.toxicMarkout) ? config.toxicMarkout : LENS.maxMarkoutToFee });
  if (toxic && !toxic.pass) lenses.push('toxic');

  // sparklines: about 24 buckets ending now (24 of an hour, 24 of 7 hours, 30 of a day)
  const steps = Math.max(1, Math.round(W / step)), nb = Math.max(1, Math.round(steps / Math.max(1, Math.round(steps / 24)))), bw = W / nb;
  const bucket = (t) => (t > wStart ? Math.min(nb - 1, Math.floor((t - wStart) / bw)) : -1);
  const px = new Array(nb).fill(null), fz = new Array(nb).fill(null), broken = new Set();
  for (const p of win) { const b = bucket(p.t), h = humanPrice(p, k); if (b >= 0 && isNum(h)) px[b] = sig(h, 6); }
  for (const iv of fees?.intervals || []) {
    const b = bucket(iv.t1);
    if (b < 0) continue;
    const u = usdOf(Number(iv.raw[0]), Number(iv.raw[1]), k);
    if (u == null) broken.add(b); else fz[b] = (fz[b] ?? 0) + u;
  }
  for (let b = 0; b < nb; b++) fz[b] = broken.has(b) ? null : sig(fz[b], 4);

  return {
    days: Math.round((fees ? Math.min(days, fees.days) : days) * 100) / 100, partial: partial || (fees != null && fees.days * DAY < W - step),
    volUsd, lpFeesUsd, protocolFeesUsd, swaps, traders,
    sigma, range: r, rerangeDays,
    inRangeUsd, feeApr, lvr, swapCost, gas, net, edge, aggApr,
    parkedAvg, strandedShare, markout,
    gem, pattern: g.pattern, burst: g.burst, daily, lenses, spark: { px, fees: fz },
  };
}

// Every window in the config: { '24h': Window|null, '7d': …, '30d': … }.
export function allWindows(input, opts) {
  const ws = Array.isArray(input?.config?.windows) && input.config.windows.length ? input.config.windows : DEFAULT_WINDOWS;
  return Object.fromEntries(ws.map((w) => [w, windowMetrics({ ...input, window: w }, opts)]));
}
