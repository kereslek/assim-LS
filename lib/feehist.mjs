// Fee history: up to a year of daily LP fees for every pool (docs/DATA.md history.json `y`), exact where the
// chain has been read, estimated before that (the owner's option C, 8 Nov 2026).
//
// EXACT ('x'): the pool's own fee counters at one block per UTC day. The day's LP fees = Δ feeGrowthGlobal ×
//   the interval's liquidity (the harmonic mean of its two ends, as lib/windows.mjs), from the day's row to the
//   next day's, scaled to 24 h; rows 20 to 28 hours apart, anything else is not a day. The rows: the snapshot
//   tiers' (lib/snapshots.mjs: hours for 14 days, days for 90), and a deep backfill that reads one block per
//   past day (00:05 UTC), a few days a pool per pass, back to the pool's creation and at most 365 days, and
//   again at 00:05 for a day whose only row is far from its start (deepMoments). Each exact day is kept
//   compactly in the series' deep record (foldDeep): { f: Map(UTC day ms → [q, px]), r: raw rows still to
//   pair, nb }, where q = the day's LP fees in token1 raw units (token0's side converted at px) and px =
//   token1 raw per token0 raw at the day's end.
// ESTIMATED ('e'): the day's volume × fee tier × the share LPs keep (the pool's own lpKeeps; a v4 dynamic-fee
//   pool uses its current lpFee: `dyn`). Volume = GeckoTerminal's public day candles (USD), each pool fetched
//   once (up to 366 days) and cached in snapshots.json `gt`; after that only the newest days, once a UTC day,
//   about 25 calls a minute and a capped number per pass, resumed on the next pass.
// Exact always overrides estimated for the same day. Both are valued at the day's prices: the candle's close
// for GeckoTerminal's base token, the pool's own price at the day's end for the other side (no close within
// 3 days: today's prices). A day with neither is [t, null, null]; a day before the pool existed has no row.
//
// The estimates reach history.json's y rows and one public sanity number only (the median of estimated ÷
// exact on days with both): never the windows, the gem, the backtest or a score. windowSeries is what the
// windows are given (the deep record stripped); test/feehist.test.mjs proves the isolation with planted leaks.
// Pure, except fetchVolumes (network through the getJson it is given).
import { HOUR, DAY, TIERS, normRow } from './snapshots.mjs';
import { BACKFILL, ORDER, missingMoments } from './backfill.mjs';
import { deltaFg, PARTS } from './windows.mjs';
import { ZERO } from './pools.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sig = (x, n) => (isNum(x) ? Number(x.toPrecision(n)) : null);
const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const dayOf = (t) => Math.floor(t / DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const category = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || 'error';

export const FEEHIST = Object.freeze({
  days: 365, // completed UTC days in y (yesterday and the 364 before)
  // GeckoTerminal's public API allows about 30 calls a minute: 2.4 s apart, at most 24 calls and 60 s a pass
  gt: Object.freeze({ ms: 60e3, calls: 24, spacingMs: 2400, limit: 366, missRetryMs: 7 * DAY, settleMs: 30 * 60e3, stopAfter: 3, keepMs: 30 * DAY }),
  // the deep backfill per pass: batches on Ethereum (Base: lib/chains.mjs caps.backfill.deep), days per pool,
  // and unread batches in a row before the rest wait for the next pass
  deep: Object.freeze({ batches: 40, perPool: 10, stopAfter: 3 }),
  gap: Object.freeze({ min: 20 * HOUR, max: 28 * HOUR }),
  align: 4 * HOUR, // a row within 4 h of its day's start: two of them are 20-28 h apart
  closeWithin: 3, // days: the nearest candle close used to value an exact day
  xcheckMinUsd: 10, // exact days under this are left out of the sanity ratio (noise)
});
// the deep backfill's moments come after every class the windows and the 90-day chart read (lib/backfill.mjs ORDER)
export const DEEP_RANK = ORDER.length;

// What the windows, the gem, the backtest and the scores are given of a series: the hourly and daily raw tiers
// (and nb). The deep record stays behind; the estimates were never in the series.
export const windowSeries = (s) => (s ? { h: s.h || [], d: s.d || [], ...(isNum(s.nb) ? { nb: s.nb } : {}) } : s);

// ---- exact days -------------------------------------------------------------------------------------------

const feeRead = (r) => r && r.fg0 != null && r.fg1 != null && r.L != null;

// One raw row per UTC day: fee-read rows only, the earliest of the day.
export function dayRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!feeRead(r)) continue;
    const b = dayOf(r.t), have = out.get(b);
    if (!have || r.t < have.t) out.set(b, r);
  }
  return out;
}

// The day from row a to row b (the next day's): [q, px] or null (not a day, a counter unread or going back).
export function exactDay(a, b) {
  if (!feeRead(a) || !feeRead(b)) return null;
  const gap = b.t - a.t;
  if (!(gap >= FEEHIST.gap.min && gap <= FEEHIST.gap.max)) return null;
  if (b.fg0 < a.fg0 || b.fg1 < a.fg1) return null; // a counter that went back is a bad read, never a wrap here
  const L = PARTS.intervalL(a.L, b.L);
  const r0 = Number((deltaFg(a.fg0, b.fg0) * L) >> 128n), r1 = Number((deltaFg(a.fg1, b.fg1) * L) >> 128n);
  const sp = b.sqrtPriceX96 != null && b.sqrtPriceX96 > 0n ? b.sqrtPriceX96 : a.sqrtPriceX96 != null && a.sqrtPriceX96 > 0n ? a.sqrtPriceX96 : null;
  const px = sp == null ? null : (Number(sp) / 2 ** 96) ** 2;
  if (px == null && r0 > 0) return null;
  return [sig((r0 * (px ?? 0) + r1) * (DAY / gap), 6), px == null ? null : sig(px, 6)];
}

const floorOf = (series, notBefore) => Math.max(isNum(notBefore) ? notBefore : -Infinity, isNum(series?.nb) ? series.nb + 1 : -Infinity, isNum(series?.y?.nb) ? series.y.nb + 1 : -Infinity);
const rawRows = (s) => [...(s?.h || []), ...(s?.d || []), ...(s?.y?.r || [])];
// a day's row close enough to the day's start that two of them make a 24 h day (FEEHIST.gap)
const aligned = (r, b) => !!r && r.t - b * DAY <= FEEHIST.align;

// The deep moments a series is missing: Map(T → DEEP_RANK), 5 minutes past midnight UTC, newest first, at most
// perPool. Day b's row is wanted while day b or the day before it has no exact fee and the series holds no
// fee-read row near day b's start (a pass row at 13:00 can't pair: that day is read again at 00:05). Moments
// the daily backfill asks for itself (lib/backfill.mjs missingMoments) are left to it. Nothing before the
// pool's creation (notBefore), at or before a moment a read found it not there yet (nb, either record's), or
// before the year.
export function deepMoments(series, { now, notBefore = null, at = BACKFILL.at, perPool = FEEHIST.deep.perPool, days = FEEHIST.days } = {}) {
  const out = new Map(), f = series?.y?.f || new Map();
  const byDay = dayRows(rawRows(series)), reg = missingMoments(series, { now, notBefore, at });
  const floor = floorOf(series, notBefore), today = dayOf(now), first = today - days;
  for (let b = today; b >= first && out.size < perPool; b--) {
    const T = b * DAY + at;
    if (T > now - at) continue; // today's moment not passed yet
    if (T < floor) break;
    if (aligned(byDay.get(b), b) || reg.has(T)) continue;
    const self = b < today && !f.has(b * DAY), before = b - 1 >= first && (b - 1) * DAY + at >= floor && !f.has((b - 1) * DAY);
    if (self || before) out.set(T, DEEP_RANK);
  }
  return out;
}

const safeNorm = (r) => { try { return normRow(r); } catch { return null; } };
const sameT = (rows) => new Set(rows.map((r) => r.t));

// The series' deep record after a pass. series = the pool's series after this pass's merge (its tiers pruned,
// the previous deep record carried); rows = every raw row the pass saw for the pool (the previous tiers', the
// pass's own, the backfills'); unborn = the latest moment a deep read found the pool not there.
//   f: every exact day of the year (kept once the tiers let its rows go); r: the fee-read rows near a day's
//   start that the tiers don't hold and a day not yet exact still needs; nb.
// null when there is nothing to keep.
export function foldDeep(series, rows, { now, unborn = null, notBefore = null, at = BACKFILL.at, days = FEEHIST.days } = {}) {
  const prev = series?.y || null, today = dayOf(now), first = today - days;
  const byDay = dayRows([...rawRows(series), ...(rows || []).map(safeNorm).filter(Boolean)]);
  const f = new Map([...(prev?.f || new Map())].filter(([d]) => d >= first * DAY));
  for (const [b, r] of byDay) {
    if (b < first || b >= today) continue;
    const x = exactDay(r, byDay.get(b + 1));
    if (x) f.set(b * DAY, x);
  }
  const nbs = [prev?.nb, unborn].filter(isNum), nb = nbs.length ? Math.max(...nbs) : null;
  const floor = Math.max(isNum(notBefore) ? notBefore : -Infinity, isNum(nb) ? nb + 1 : -Infinity, isNum(series?.nb) ? series.nb + 1 : -Infinity);
  const inTiers = sameT([...(series?.h || []), ...(series?.d || [])]), r = [];
  for (const [b, row] of [...byDay].sort((x, y) => x[0] - y[0])) {
    if (b < first || inTiers.has(row.t) || !aligned(row, b)) continue;
    const self = b < today && !f.has(b * DAY), before = b - 1 >= first && (b - 1) * DAY + at >= floor && !f.has((b - 1) * DAY);
    if (self || before) r.push(row);
  }
  if (!f.size && !r.length && nb == null) return null;
  return { f, r, nb };
}

// ---- GeckoTerminal day candles ----------------------------------------------------------------------------

export const gtUrl = (network, id, limit) => `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${id}/ohlcv/day?aggregate=1&limit=${limit}&currency=usd`;

// { days: Map(UTC day ms → [volume USD|null, close USD|null]), base: address|null } or null (not candles).
export function parseOhlcv(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return null;
  const days = new Map();
  for (const c of list) {
    if (!Array.isArray(c) || !isNum(c[0]) || c[0] <= 0) continue;
    const ms = c[0] > 1e11 ? c[0] : c[0] * 1000, vol = num(c[5]), close = num(c[4]);
    days.set(dayOf(ms) * DAY, [vol != null && vol >= 0 ? vol : null, close != null && close > 0 ? close : null]);
  }
  const base = String(json?.meta?.base?.address || '').toLowerCase();
  return { days, base: /^0x[0-9a-f]{40}$/.test(base) ? base : null };
}

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
// Which of the pool's tokens GeckoTerminal's base is: 0, 1 or null (native ETH may be listed as WETH or 0xeee…).
export function baseSide(base, t0, t1, weth = null) {
  const n = (a) => { const x = String(a || '').toLowerCase(); return x === NATIVE ? ZERO : x; };
  const b = n(base), a0 = n(t0), a1 = n(t1), w = weth ? n(weth) : null;
  if (!b) return null;
  if (b === a0) return 0;
  if (b === a1) return 1;
  if (w && (b === w || b === ZERO)) { if (a0 === ZERO || a0 === w) return 0; if (a1 === ZERO || a1 === w) return 1; }
  return null;
}

const newestDay = (days) => { let m = null; for (const [d, v] of days || []) if ((v[0] != null || v[1] != null) && (m == null || d > m)) m = d; return m; };

// What one pool's cache entry needs this pass: { kind: 'full'|'new', limit } or null (nothing to ask).
// Never fetched: the full year. A pool GeckoTerminal doesn't know: again after missRetryMs. Otherwise once a
// UTC day, settleMs after midnight (yesterday's candle closed), from the newest day held (asked again too).
export function gtNeed(e, { now, limit = FEEHIST.gt.limit, missRetryMs = FEEHIST.gt.missRetryMs, settleMs = FEEHIST.gt.settleMs } = {}) {
  if (!e) return { kind: 'full', limit };
  if (isNum(e.miss)) return now - e.miss >= missRetryMs ? { kind: 'full', limit } : null;
  const today = dayOf(now) * DAY;
  if (now < today + settleMs || (isNum(e.t) && e.t >= today + settleMs)) return null;
  const newest = newestDay(e.days);
  if (newest == null) return { kind: 'full', limit };
  if (newest >= today - DAY) return null;
  return { kind: 'new', limit: Math.min(limit, Math.round((today - newest) / DAY) + 1) };
}

// Fetch what the cache needs, newest pools to the cache first (the pools never fetched, largest first, then
// the daily top-ups). cache: Map(id → { t, b, days, miss }), changed in place. pools: [{ id, network, t0, t1,
// weth, tvl }]. budget (lib/budget.mjs): one call each; spent, the rest wait for the next pass. Stops at once
// on a refusal of the host itself (no HTTP answer) or a 429, and after stopAfter other errors in a row.
// A 404: the pool is not on GeckoTerminal (asked again after a week). Today's partial candle is never kept.
export async function fetchVolumes(getJson, pools, { cache, now, budget = null, spacingMs = FEEHIST.gt.spacingMs, stopAfter = FEEHIST.gt.stopAfter, pause = sleep, clock = Date.now } = {}) {
  const wants = [];
  for (const p of pools || []) { const need = p?.network ? gtNeed(cache.get(p.id), { now }) : null; if (need) wants.push({ p, need }); }
  wants.sort((a, b) => (a.need.kind === 'full' ? 0 : 1) - (b.need.kind === 'full' ? 0 : 1) || (b.p.tvl ?? 0) - (a.p.tvl ?? 0));
  const st = { pools: (pools || []).length, wanted: wants.length, full: 0, fresh: 0, missed: 0, failed: 0, calls: 0, stopped: null, lastError: null };
  let fails = 0, last = null;
  for (const { p, need } of wants) {
    if (budget?.over()) { st.stopped = budget.why(); break; }
    if (last != null) { const w = spacingMs - (clock() - last); if (w > 0) await pause(budget ? Math.min(w, budget.left()) : w); }
    if (budget && !budget.take()) { st.stopped = budget.why(); break; }
    last = clock(); st.calls++;
    let got = null;
    try { got = parseOhlcv(await getJson(gtUrl(p.network, p.id, need.limit), { headers: { accept: 'application/json' } }, 20000)); } catch (e) {
      st.lastError = category(e);
      const http = /HTTP (\d{3})/.exec(String(e?.message || e))?.[1];
      if (http === '404') { // unknown: asked again in a week; a pool with candles already: tomorrow
        const prev = cache.get(p.id);
        cache.set(p.id, prev && newestDay(prev.days) ? { ...prev, t: now } : { t: now, b: null, days: new Map(), miss: now });
        st.missed++; fails = 0; continue;
      }
      st.failed++;
      if (!http) { st.stopped = 'unreachable'; break; }
      if (http === '429') { st.stopped = 'rate limit'; break; }
      if (++fails >= stopAfter) { st.stopped = 'errors'; break; }
      continue;
    }
    if (!got) { st.failed++; st.lastError = 'not candles'; if (++fails >= stopAfter) { st.stopped = 'errors'; break; } continue; }
    fails = 0;
    const prev = cache.get(p.id), today = dayOf(now) * DAY, from = today - FEEHIST.gt.limit * DAY;
    const days = new Map(prev && !isNum(prev.miss) ? prev.days : []);
    for (const [d, v] of got.days) if (d < today && d >= from) days.set(d, v);
    cache.set(p.id, { t: now, b: baseSide(got.base, p.t0, p.t1, p.weth) ?? prev?.b ?? null, days });
    if (need.kind === 'full') st.full++; else st.fresh++;
  }
  return st;
}

// The cache in snapshots.json `gt`: { "<id>": { t, b, d0, v: [volume…], c: [close…] } | { t, miss } }, days as
// columns from d0 (null = no candle), the last 366 days; a pool not asked for keepMs is dropped.
export function packGt(cache, { now, keepMs = FEEHIST.gt.keepMs } = {}) {
  const out = {}, from = (dayOf(now) - FEEHIST.gt.limit) * DAY;
  for (const [id, e] of cache || []) {
    if (!e || !(now - Math.max(e.t ?? 0, e.miss ?? 0) < keepMs)) continue;
    if (isNum(e.miss)) { out[id] = { t: e.t, miss: e.miss }; continue; }
    const ds = [...e.days.keys()].filter((d) => d >= from).sort((a, b) => a - b);
    const d0 = ds.length ? ds[0] : null, n = ds.length ? Math.round((ds.at(-1) - d0) / DAY) + 1 : 0;
    const v = new Array(n).fill(null), c = new Array(n).fill(null);
    for (const d of ds) { const i = Math.round((d - d0) / DAY), x = e.days.get(d); v[i] = sig(x[0], 5); c[i] = sig(x[1], 6); }
    out[id] = { t: e.t, b: e.b ?? null, d0, v, c };
  }
  return out;
}
export function unpackGt(o) {
  const cache = new Map();
  for (const [id, e] of Object.entries(o && typeof o === 'object' ? o : {})) {
    if (!e || !isNum(e.t)) continue;
    if (isNum(e.miss)) { cache.set(id, { t: e.t, b: null, days: new Map(), miss: e.miss }); continue; }
    if (!Array.isArray(e.v) || !Array.isArray(e.c) || e.v.length !== e.c.length || (e.v.length && !isNum(e.d0))) continue;
    const days = new Map();
    e.v.forEach((v, i) => { const c = e.c[i]; if (v != null || c != null) days.set(e.d0 + i * DAY, [isNum(v) && v >= 0 ? v : null, isNum(c) && c > 0 ? c : null]); });
    cache.set(id, { t: e.t, b: e.b === 0 || e.b === 1 ? e.b : null, days });
  }
  return cache;
}

// ---- the year of rows -------------------------------------------------------------------------------------

// The candle close nearest to day t within FEEHIST.closeWithin days: { c, same: the day's own } or null.
function closeNear(days, t) {
  for (let k = 0; k <= FEEHIST.closeWithin; k++) {
    for (const d of k ? [t - k * DAY, t + k * DAY] : [t]) { const c = days.get(d)?.[1]; if (isNum(c) && c > 0) return { c, same: k === 0 }; }
  }
  return null;
}

// An exact day in USD at that day's prices (token1's from the close and the pool's own price), else today's.
function exactUsd([q, px], { close, side, d0, d1, usd0, usd1, pxNow }) {
  if (q === 0) return 0;
  if (!Number.isInteger(d0) || !Number.isInteger(d1)) return null;
  const pxH = isNum(px) && px > 0 ? px * 10 ** (d0 - d1) : null; // token1 per token0, human units, at the day's end
  let u1 = null;
  if (close && side === 1) u1 = close.c;
  else if (close && side === 0 && pxH) u1 = close.c / pxH;
  else if (isNum(usd1) && usd1 > 0) u1 = usd1;
  else if (isNum(usd0) && usd0 > 0 && isNum(pxNow) && pxNow > 0) u1 = usd0 / pxNow;
  return u1 == null ? null : (q / 10 ** d1) * u1;
}

// history.json's y rows for one pool and its progress, plus the sanity ratios (estimated ÷ exact on days with
// both, exact valued at that day's own close with GeckoTerminal's base side known, dynamic-fee pools left out).
//   series  the pool's snapshot series (d tier and the deep record y)
//   gt      its GeckoTerminal cache entry, or null
//   pool    { d0, d1, rate (fee tier × LP share), dyn, usd0, usd1, pxNow (token1 per token0 now), createdAt (ms|null) }
// Returns { y: [[t, feesUsd|null, 'x'|'e'|null]], yp: { exact, est, age, dyn }, xc: [ratio] }.
export function feeYear({ series, gt = null, pool = {}, now } = {}) {
  const today = dayOf(now), first = today - FEEHIST.days;
  const ex = new Map(series?.y?.f || []);
  const byDay = dayRows(rawRows(series));
  for (const [b, r] of byDay) { const x = b < today ? exactDay(r, byDay.get(b + 1)) : null; if (x) ex.set(b * DAY, x); }
  const gd = gt && !isNum(gt.miss) ? gt.days : new Map();
  const nbs = [series?.nb, series?.y?.nb].filter(isNum), nb = nbs.length ? Math.max(...nbs) : null;
  // the pool's first day: its creation, else the day of the last moment it was not there yet, else its first data
  const data = [...ex.keys(), ...[...gd].filter(([, v]) => v[0] != null).map(([d]) => d)].filter((d) => d >= first * DAY);
  let start = isNum(pool.createdAt) ? dayOf(pool.createdAt) : nb != null ? dayOf(nb) : data.length ? dayOf(Math.min(...data)) : null;
  const yp = { exact: 0, est: 0, age: null, dyn: !!pool.dyn };
  if (start == null) return { y: [], yp, xc: [] };
  if (nb != null) start = Math.max(start, dayOf(nb)); // a day that ended before a read found the pool not there: no row
  const known = isNum(pool.createdAt) || nb != null || start <= first;
  start = Math.max(start, first);
  const y = [], xc = [];
  for (let D = start; D < today; D++) {
    const t = D * DAY, x = ex.get(t), g = gd.get(t), close = closeNear(gd, t);
    const xu = x ? exactUsd(x, { close, side: gt?.b ?? null, ...pool }) : null;
    const eu = g && g[0] != null && isNum(pool.rate) && pool.rate > 0 ? g[0] * pool.rate : null;
    if (xu != null) { y.push([t, sig(xu, 4), 'x']); yp.exact++; } else if (eu != null) { y.push([t, sig(eu, 4), 'e']); yp.est++; } else y.push([t, null, null]);
    if (xu != null && eu != null && close?.same && (gt?.b === 0 || gt?.b === 1) && !pool.dyn && xu >= FEEHIST.xcheckMinUsd) xc.push(eu / xu);
  }
  if (known) yp.age = y.length;
  return { y, yp, xc };
}

export const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
