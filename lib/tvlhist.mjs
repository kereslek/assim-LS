// Volume and TVL history (the owner's "yes to TVL recording", 14 Nov 2026): up to a year of each pool's daily volume
// and TVL beside its fee history, history.json `yv` and `yt` (docs/DATA.md), for the charts only.
//
// VOLUME, one value a UTC day (the y rows' days):
//   's' the day's own swaps, where the exact fees summed them (lib/exactfees.mjs: Σ each swap's input amount, token0's
//       side converted at the day's end price), valued at the day's prices as the fee days are (lib/feehist.mjs exactUsd);
//   'g' GeckoTerminal's day candle (USD), the `gt` cache in snapshots.json (up to 366 days);
//   null: neither (never 0). The swaps over the candle for the same day.
//
// TVL, one value a UTC day: what the pool holds at the day's END, valued at that day's prices (the same rule as an exact
// fee day: the candle's close for GeckoTerminal's base token, the pool's own price at the reading for the other; no
// close within 3 days: the pass's prices). A reading taken within the first hour of a UTC day is the day before's end
// (the y days run from one 00:05 to the next). One reading a pool-day, the first taken, never read again:
//   'r' recorded: a v3-style pool's two token balances (balanceOf(pool) on token0 and token1), read by the pass itself
//       at its own block, the first pass in the hour after midnight;
//   'b' backfilled: the same balances at an archive block, riding in the backfills' 00:05 reads (the batch that reads
//       the pool's row at that block: one multicall per pool-day), newest days first, the largest pools first, within
//       the deep backfill's batches and time; never before the pool existed (the block's slot0 must show the pool);
//       Base only back to its archive nodes' reach (lib/chains.mjs archiveDays, about 90 days): older Base days null;
//   'm' map: a v4 pool's tokens sit in the shared PoolManager, so no balance is its own: its TVL is the value of its
//       liquidity map (the positions' principal at the reading's price), from the pass's own map (from now on) or a past
//       map the persistence check read at a moment in the first hour of a day. Other past v4 days are null ("not
//       readable"): reading a whole map at one block a day is hundreds of calls a pool-day.
// What balanceOf counts: everything the pool contract holds, i.e. the positions' principal, LP fees earned but not yet
// collected, the protocol's cut not yet collected (v3 protocolFees), and tokens sent to the pool by mistake. A map
// counts the principal only. So a v3 day reads a little above its map, never below it (the scan's "map value v3" check).
//
// Never in a score: these series feed history.json only (test/tvlhist.test.mjs proves it statically and by taint).
// Pure: the scan does the reads (scripts/scan.mjs) and gives this module their answers.
import { HOUR, DAY } from './snapshots.mjs';
import { BACKFILL, missingMoments } from './backfill.mjs';
import { FEEHIST, DEEP_RANK, exactUsd, closeNear, median } from './feehist.mjs';
import { encodeCall } from './abi.mjs';
import { readUint } from './pools.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sig = (x, n) => (isNum(x) ? Number(x.toPrecision(n)) : null);
const dayOf = (t) => Math.floor(t / DAY);
const SRC = new Set(['r', 'b', 'm']);

export const TVLHIST = Object.freeze({
  days: FEEHIST.days, // completed UTC days, as y
  within: HOUR, // a reading within the first hour of a UTC day is the day before's end
  keepMs: 30 * DAY, // a pool not scanned for 30 days leaves the cache
  perPool: FEEHIST.deep.perPool, // archive days a pool per pass, shared with the fee history's own (newest first)
  vxMinUsd: 1000, // candle days under this are left out of the swaps÷candle ratio (noise)
});

// The UTC day (ms) a reading at ts (ms) closes: the day before, when ts is within the first hour of a day; else null.
export function endOfDay(ts) {
  if (!isNum(ts)) return null;
  const d = dayOf(ts);
  return ts - d * DAY <= TVLHIST.within ? (d - 1) * DAY : null;
}

// The first UTC day whose end an archive with this reach (ms) still serves at `now`: its 00:05 moment within the reach.
export function reachDay(now, reachMs, at = BACKFILL.at) {
  if (!isNum(reachMs)) return null;
  return (Math.ceil((now - reachMs - at) / DAY) - 1) * DAY;
}

// balanceOf(pool) on each of a v3-style pool's tokens; [] for a v4 pool (its tokens sit in the PoolManager).
export const balanceCalls = (p) => (p?.v === 3 ? [p.t0, p.t1].map((t) => ({ target: t, data: encodeCall('balanceOf(address)', [{ t: 'address', v: p.id }]) })) : []);

// [bal0, bal1] (BigInt) from the two answers, or null when either is unread or reverted (never 0).
export function readBalances(answers) {
  const b0 = readUint(answers?.[0]), b1 = readUint(answers?.[1]);
  return b0 == null || b1 == null ? null : [b0, b1];
}

const pxOf = (sqrtPriceX96) => {
  let sp = null;
  try { sp = sqrtPriceX96 == null ? null : BigInt(sqrtPriceX96); } catch { sp = null; }
  return sp != null && sp > 0n ? (Number(sp) / 2 ** 96) ** 2 : null;
};

// A reading as the deep record keeps a fee day: [q, px], q = the holdings in token1 raw units (token0's side converted
// at px), px = token1 raw per token0 raw at the reading. null without both balances or a price.
export function holdings(bal, sqrtPriceX96) {
  if (!Array.isArray(bal) || bal.length !== 2 || bal.some((b) => typeof b !== 'bigint' || b < 0n)) return null;
  const px = pxOf(sqrtPriceX96);
  if (px == null) return null;
  const q = Number(bal[0]) * px + Number(bal[1]);
  return isNum(q) ? [sig(q, 6), sig(px, 6)] : null;
}

// A liquidity map's value (token1, human units: lib/shape.mjs hollowness total) as a reading.
export function mapHoldings(total, d1, sqrtPriceX96) {
  if (!isNum(total) || total < 0 || !Number.isInteger(d1)) return null;
  const px = pxOf(sqrtPriceX96);
  return px == null ? null : [sig(total * 10 ** d1, 6), sig(px, 6)];
}

// ---- the readings (snapshots.json tv) ------------------------------------------------------------------------

// Map(id → { c: chain, t: last scanned ms, d: Map(UTC day ms → [q, px, src]) })
export const emptyTv = () => new Map();
export const tvHeld = (cache, id, day) => !!cache?.get(id)?.d.has(day);

// Mark the pools scanned this pass (a pool not scanned for keepMs leaves the cache).
export function touchTv(cache, pools, now) {
  for (const p of pools) {
    const e = cache.get(p.id);
    if (e) { e.t = now; e.c = p.chain ?? e.c; } else cache.set(p.id, { c: p.chain ?? null, t: now, d: new Map() });
  }
}

// Keep one reading: the day's first (a day held is never replaced), within the year, completed days only.
// → true when it was added.
export function recordTv(cache, id, { day, reading, src, now, chain = null } = {}) {
  if (!isNum(day) || day % DAY !== 0 || !Array.isArray(reading) || !SRC.has(src)) return false;
  const [q, px] = reading;
  if (!(isNum(q) && q >= 0) || !(px == null || (isNum(px) && px > 0))) return false;
  const today = dayOf(now);
  if (day >= today * DAY || day < (today - TVLHIST.days) * DAY) return false;
  let e = cache.get(id);
  if (!e) { e = { c: chain, t: now, d: new Map() }; cache.set(id, e); }
  if (e.d.has(day)) return false;
  e.d.set(day, [q, px ?? null, src]);
  return true;
}

// tv: { "<id>": { c, t, d0: <UTC day ms>|null, q: [<n|null>], px: [<n|null>], s: "<one char a day: r b m, or . for none>" } },
// the last 366 days; a pool not scanned for keepMs is dropped.
export function packTv(cache, { now, keepMs = TVLHIST.keepMs } = {}) {
  const out = {}, from = (dayOf(now) - TVLHIST.days - 1) * DAY;
  for (const [id, e] of cache || []) {
    if (!e || !(now - (e.t ?? 0) < keepMs)) continue;
    const ds = [...e.d.keys()].filter((d) => d >= from).sort((a, b) => a - b);
    const d0 = ds.length ? ds[0] : null, n = ds.length ? Math.round((ds.at(-1) - d0) / DAY) + 1 : 0;
    const q = new Array(n).fill(null), px = new Array(n).fill(null), s = new Array(n).fill('.');
    for (const d of ds) { const i = Math.round((d - d0) / DAY), v = e.d.get(d); q[i] = v[0]; px[i] = v[1]; s[i] = v[2]; }
    out[id] = { c: e.c ?? null, t: e.t, d0, q, px, s: s.join('') };
  }
  return out;
}
// The readings back from snapshots.json; anything malformed is dropped (read again), never a guess.
export function unpackTv(o) {
  const cache = emptyTv();
  for (const [id, e] of Object.entries(o && typeof o === 'object' ? o : {})) {
    if (!e || !isNum(e.t) || !Array.isArray(e.q) || !Array.isArray(e.px) || typeof e.s !== 'string' || e.q.length !== e.px.length || e.s.length !== e.q.length) continue;
    if (e.q.length && !(isNum(e.d0) && e.d0 % DAY === 0)) continue;
    const d = new Map();
    e.q.forEach((q, i) => {
      const px = e.px[i], src = e.s[i];
      if (SRC.has(src) && isNum(q) && q >= 0 && (px == null || (isNum(px) && px > 0))) d.set(e.d0 + i * DAY, [q, px ?? null, src]);
    });
    cache.set(id, { c: typeof e.c === 'string' ? e.c : null, t: e.t, d });
  }
  return cache;
}

// ---- the archive moments --------------------------------------------------------------------------------------

// A day's end moment: 00:05 UTC of the next day (the backfills' own moment).
export const endMoment = (day, at = BACKFILL.at) => day + DAY + at;
// Whether a backfill moment is one a day's end reading can come from (its first hour).
export const isEndMoment = (T) => isNum(T) && T - dayOf(T) * DAY <= TVLHIST.within;

// The archive moments a v3-style pool's TVL is missing: Map(T → DEEP_RANK), the 00:05 UTC moment after each day held
// by no reading, newest first, at most perPool. have: the pool's readings (Map day → reading). Never a day the pool did
// not exist by its end (notBefore = its creation, the series' nb and the deep record's), never today's moment before
// it passed, never a moment the daily and hourly backfill asks itself (its reads carry the balances), never past the
// archive's reach (reachMs: Base), never before the year.
export function tvlMoments(series, { now, have = null, notBefore = null, at = BACKFILL.at, perPool = TVLHIST.perPool, days = TVLHIST.days, reachMs = null } = {}) {
  const out = new Map(), reg = missingMoments(series, { now, notBefore, at });
  const floor = Math.max(isNum(notBefore) ? notBefore : -Infinity, isNum(series?.nb) ? series.nb + 1 : -Infinity, isNum(series?.y?.nb) ? series.y.nb + 1 : -Infinity);
  const today = dayOf(now), first = today - days, reach = reachDay(now, reachMs, at);
  for (let D = today - 1; D >= first && out.size < perPool; D--) {
    const day = D * DAY, T = endMoment(day, at);
    if (T > now - at) continue; // today's 00:05 not passed yet
    if (T < floor || (reach != null && day < reach)) break;
    if (have?.has(day) || reg.has(T)) continue;
    out.set(T, DEEP_RANK);
  }
  return out;
}

// Two moment maps into one, newest first, at most perPool.
export function unionMoments(a, b, perPool = TVLHIST.perPool) {
  const m = new Map([...(a || []), ...(b || [])]);
  return new Map([...m].sort((x, y) => y[0] - x[0]).slice(0, perPool));
}

// ---- the year of rows -----------------------------------------------------------------------------------------

// history.json's yv and yt for one pool, aligned to its y rows (yv[i] and yt[i] are day y[i][0]), and their progress.
//   y       the pool's fee rows (lib/feehist.mjs feeYear)
//   gt      its GeckoTerminal cache entry, or null
//   sx      its exact-fees cache entry (days [q, px, vq]), or null
//   tv      its TVL readings ({ d: Map(day → [q, px, src]) }), or null
//   pool    { v, d0, d1, usd0, usd1, pxNow } (the valuation inputs feeYear takes)
//   reachMs the archive's reach for this pool's chain (Base), or null
// Returns { yv: [[volUsd|null, 's'|'g'|null]], yt: [[tvlUsd|null, 'b'|'r'|'m'|null]], yvp: { s, g }, ytp: { b, r, m, lim,
// from }, vx: [swaps ÷ candle on days with both], last: yesterday's TVL in USD or null, gone: TVL days that can never
// be read, open: TVL days still to read }.
//   ytp.lim: null (every past day can be read), 'archive' (days before ytp.from are past the archive's reach), 'v4' (a v4
//   pool: no past balance; only map readings). ytp.from: the first UTC day the archive still serves ('archive'), else null.
export function volTvlYear({ y = [], gt = null, sx = null, tv = null, pool = {}, now, reachMs = null } = {}) {
  const gd = gt && !isNum(gt.miss) ? gt.days : new Map(), sd = sx?.d instanceof Map ? sx.d : new Map(), td = tv?.d instanceof Map ? tv.d : new Map();
  const v4 = pool.v === 4, reach = v4 ? null : reachDay(now, reachMs);
  const yv = [], yt = [], yvp = { s: 0, g: 0 }, ytp = { b: 0, r: 0, m: 0, lim: v4 ? 'v4' : reach != null ? 'archive' : null, from: reach };
  const vx = [], yesterday = (dayOf(now) - 1) * DAY;
  let last = null, gone = 0, open = 0;
  for (const row of y) {
    const t = row[0], val = { close: closeNear(gd, t), side: gt?.b ?? null, ...pool };
    const s = sd.get(t), g = gd.get(t), r = td.get(t);
    const su = s && isNum(s[2]) ? exactUsd([s[2], s[1]], val) : null, gu = g && isNum(g[0]) ? g[0] : null;
    if (su != null) { yv.push([sig(su, 4), 's']); yvp.s++; } else if (gu != null) { yv.push([sig(gu, 4), 'g']); yvp.g++; } else yv.push([null, null]);
    if (su != null && gu != null && gu >= TVLHIST.vxMinUsd) vx.push(su / gu);
    const tu = r ? exactUsd([r[0], r[1]], val) : null;
    if (tu != null) { yt.push([sig(tu, 4), r[2]]); ytp[r[2]]++; if (t === yesterday) last = tu; } else {
      yt.push([null, null]);
      if (v4 || (reach != null && t < reach)) gone++; else open++;
    }
  }
  return { yv, yt, yvp, ytp, vx, last, gone, open };
}

// The public lines (counts and ratios only) and the sealed checks' verdicts.
//   tot: { pools, days, b, r, m, gone, goneV4, goneReach, open, vs, vg, vNull, vx: [ratios], tl: [yesterday ÷ pool list] }
//   pass: { r, m, b, unread } readings added this pass, and balance reads that came back unread
export function tvlLines(tot, pass) {
  const f2 = (x) => (x == null ? '—' : x.toFixed(2));
  const tm = median(tot.tl || []), vm = median(tot.vx || []);
  const tvl = `${tot.b + tot.r + tot.m} pool-days of ${tot.days} with a value (${tot.b} from balances at archive blocks, ${tot.r} recorded by the passes, ${tot.m} from liquidity maps), `
    + `${tot.gone} not readable (${tot.goneV4} v4 days before recording, ${tot.goneReach} past Base's archive reach), ${tot.open} still to read; `
    + `this pass +${pass.b + pass.r + pass.m} (${pass.b} balances, ${pass.r} recorded, ${pass.m} maps), ${pass.unread} reads unread; `
    + `yesterday ÷ the pool list's TVL median ${f2(tm)} over ${(tot.tl || []).length} pools`;
  const vol = `${tot.vs + tot.vg} pool-days of ${tot.days} with a value (${tot.vs} from swaps, ${tot.vg} from candles), ${tot.vNull} unread; swaps÷candle median ${f2(vm)} over ${(tot.vx || []).length} days`;
  return {
    tvl, vol,
    tvlOk: (tot.tl || []).length >= 20 && tm != null ? Math.abs(tm - 1) <= 0.25 : null,
    volOk: (tot.vx || []).length >= 20 && vm != null ? Math.abs(vm - 1) <= 0.25 : null,
  };
}
