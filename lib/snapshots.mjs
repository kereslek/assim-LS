// Per-pool snapshot store: the raw state each pass reads, kept so every time window can be recomputed
// from the pool's own counters (lib/windows.mjs) instead of from a stored answer.
//
//   row = { t, block, sqrtPriceX96, tick, L, fg0, fg1, parked }
//     t ms since epoch (required); block number; sqrtPriceX96, L, fg0, fg1 BigInt (fg = the pool's
//     feeGrowthGlobal{0,1}X128); tick number; parked 0..1 (share of value parked away from the price).
//     Any field but t may be null (unread). A row with nothing read is not stored: missing is never zero.
//     Nor is a row with no price read and both fee counters at exactly 0: that is what a pool that did
//     not exist yet answers (a v4 pool before its initialisation reads 0 everywhere), and storing it
//     would book the pool's whole lifetime of fees into its first real interval.
//
// Two tiers: h = the first row in each UTC hour, kept 14 days; d = the first row in each UTC day, kept
// 90 days. Each tier keeps one step beyond its span, so a full window always has a row at its start.
// The time windows (lib/windows.mjs) read 7 days of the hourly tier and 30 of the daily one, as they
// always have; the longer spans feed history.json's charts. Windows up to 7 days read the hourly tier.
// nb ("not before", optional, ms): the latest moment a backfill found the pool not yet there; nothing
// at or before it is asked for again (lib/backfill.mjs).
// "First" = the earliest row in the bucket, except that a row with more fields read replaces one with
// fewer (a pass that failed to read the pool doesn't hold the hour against a good one).
//
// Serialised compactly for gzip: per tier, parallel arrays (not one object per row); t and block are
// delta-coded (first value absolute); BigInts are decimal strings; parked is stored in basis points.
//
// Pure and synchronous: no I/O and no clock (now is always passed in).

export const HOUR = 3600e3;
export const DAY = 86400e3;
export const TIERS = Object.freeze({
  h: Object.freeze({ step: HOUR, span: 14 * DAY }),
  d: Object.freeze({ step: DAY, span: 90 * DAY }),
});
// The longest window read from the hourly tier (longer ones read the daily tier), fixed whatever the
// hourly tier keeps.
export const HOURLY_WINDOWS = 7 * DAY;
const BIG = ['sqrtPriceX96', 'L', 'fg0', 'fg1'];
const FIELDS = ['block', 'sqrtPriceX96', 'tick', 'L', 'fg0', 'fg1', 'parked'];
const MAX = { sqrtPriceX96: 1n << 160n, L: 1n << 128n, fg0: 1n << 256n, fg1: 1n << 256n };

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function toBig(x, name) {
  if (x == null) return null;
  let v;
  if (typeof x === 'bigint') v = x;
  else if (typeof x === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(x)) v = BigInt(x);
  else if (typeof x === 'number' && Number.isSafeInteger(x)) v = BigInt(x);
  else throw new Error(`snapshot row: ${name} is not a whole number`);
  if (v < 0n || v >= MAX[name]) throw new Error(`snapshot row: ${name} out of range`);
  return v;
}

// A clean row (BigInts as BigInt) or null when nothing but t was read. A row that is wrong rather than
// missing (no time, a field of the wrong kind) throws: a corrupt store must be loud, never zero.
export function normRow(x) {
  if (!x || typeof x !== 'object') throw new Error('snapshot row: not an object');
  if (!isNum(x.t) || x.t <= 0) throw new Error('snapshot row: needs t, ms since epoch');
  const r = { t: x.t, block: null, sqrtPriceX96: null, tick: null, L: null, fg0: null, fg1: null, parked: null };
  for (const k of BIG) r[k] = toBig(x[k], k);
  if (x.block != null) { if (!Number.isSafeInteger(x.block) || x.block < 0) throw new Error('snapshot row: block is not a block number'); r.block = x.block; }
  if (x.tick != null) { if (!Number.isInteger(x.tick) || Math.abs(x.tick) > 887272) throw new Error('snapshot row: tick out of range'); r.tick = x.tick; }
  if (x.parked != null) { if (!isNum(x.parked) || x.parked < 0 || x.parked > 1) throw new Error('snapshot row: parked must be 0..1'); r.parked = x.parked; }
  if (unbornLike(r)) return null;
  return readCount(r) ? r : null;
}

// No price read and both fee counters exactly 0: a pool before it existed (see the top), never a row.
export const unbornLike = (r) => r.sqrtPriceX96 == null && r.tick == null && r.fg0 === 0n && r.fg1 === 0n;

export const readCount = (r) => FIELDS.reduce((n, k) => n + (r[k] != null ? 1 : 0), 0);
export const emptySeries = () => ({ h: [], d: [] });

// One tier: rows into buckets (earliest wins, unless a later one has more fields read), sorted, pruned.
function tierMerge(rows, { step, span }, now) {
  const best = new Map();
  for (const r of rows) {
    const b = Math.floor(r.t / step), have = best.get(b);
    if (!have) { best.set(b, r); continue; }
    const a = readCount(have), c = readCount(r);
    if (c > a || (c === a && r.t < have.t)) best.set(b, r);
  }
  const cut = now - span - step;
  return [...best.values()].filter((r) => r.t >= cut).sort((x, y) => x.t - y.t);
}

// Merge rows (a pass's new row, or a backfill) into a series. Duplicates collapse into their bucket,
// so merging the same rows twice changes nothing. Returns a new series; the input is not changed.
// unborn (ms, optional): a moment a backfill found the pool not there yet; the series keeps the latest
// such moment as nb while it is inside the daily span. A moment later than a row the series holds
// contradicts that row (the pool was there), so it is ignored: no row is ever dropped for it.
export function merge(series, rows, { now, unborn = null } = {}) {
  const s = series || emptySeries();
  const fresh = (rows || []).map(normRow).filter(Boolean);
  const all = [...s.h, ...s.d, ...fresh];
  const at = isNum(now) ? now : all.reduce((m, r) => Math.max(m, r.t), 0);
  const out = { h: tierMerge([...s.h, ...fresh], TIERS.h, at), d: tierMerge([...s.d, ...fresh], TIERS.d, at) };
  const first = all.reduce((m, r) => Math.min(m, r.t), Infinity);
  const nbs = [s.nb, unborn].filter((x) => isNum(x) && x < first && x >= at - TIERS.d.span - TIERS.d.step);
  if (nbs.length) out.nb = Math.max(...nbs);
  return out;
}

export const append = (series, row, { now = row?.t } = {}) => merge(series, [row], { now });
export const prune = (series, now) => merge(series, [], { now });

// The tier a window reads: hourly up to 7 days, daily beyond.
export const tierFor = (windowMs) => (windowMs <= HOURLY_WINDOWS ? 'h' : 'd');

// Rows of one tier with from <= t <= to.
export function rowsIn(series, tier, from = -Infinity, to = Infinity) {
  return (series?.[tier] || []).filter((r) => r.t >= from && r.t <= to);
}

// How much of the window [now - windowMs, now] the rows cover, for young pools and gaps.
//   span   share of the window from the first row in it (a row up to one step before the start counts) to now
//   days   that span in days; filled = share of the window's buckets holding a row; rows = rows used.
export function coverage(series, windowMs, { now, tier = tierFor(windowMs) } = {}) {
  const { step } = TIERS[tier];
  const rows = rowsIn(series, tier, now - windowMs - step, now);
  if (!rows.length) return { span: 0, days: 0, filled: 0, rows: 0, from: null };
  const from = rows[0].t, span = Math.min(1, (now - from) / windowMs);
  const buckets = Math.max(1, Math.round(windowMs / step));
  const seen = new Set(rows.filter((r) => r.t > now - windowMs).map((r) => Math.floor((now - r.t) / step)));
  return { span, days: (now - from) / DAY, filled: Math.min(1, seen.size / buckets), rows: rows.length, from };
}

// ---- serialisation -------------------------------------------------------------------------------

function deltas(xs) {
  let last = null;
  return xs.map((x) => { if (x == null) return null; const d = last == null ? x : x - last; last = x; return d; });
}
function undeltas(ds) {
  let last = null;
  return ds.map((d) => { if (d == null) return null; const x = last == null ? d : last + d; last = x; return x; });
}

function packTier(rows) {
  return {
    t: deltas(rows.map((r) => r.t)),
    block: deltas(rows.map((r) => r.block)),
    sqrtP: rows.map((r) => (r.sqrtPriceX96 == null ? null : r.sqrtPriceX96.toString())),
    tick: rows.map((r) => r.tick),
    L: rows.map((r) => (r.L == null ? null : r.L.toString())),
    fg0: rows.map((r) => (r.fg0 == null ? null : r.fg0.toString())),
    fg1: rows.map((r) => (r.fg1 == null ? null : r.fg1.toString())),
    parked: rows.map((r) => (r.parked == null ? null : Math.round(r.parked * 1e4))),
  };
}

function unpackTier(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.t)) throw new Error('snapshot store: a tier is not packed rows');
  const n = p.t.length;
  for (const k of ['block', 'sqrtP', 'tick', 'L', 'fg0', 'fg1', 'parked']) {
    if (!Array.isArray(p[k]) || p[k].length !== n) throw new Error(`snapshot store: column ${k} does not match t`);
  }
  if (p.t.some((x) => x == null)) throw new Error('snapshot store: a row without t');
  const t = undeltas(p.t), block = undeltas(p.block);
  return t.map((ti, i) => normRow({
    t: ti, block: block[i], sqrtPriceX96: p.sqrtP[i], tick: p.tick[i], L: p.L[i], fg0: p.fg0[i], fg1: p.fg1[i],
    parked: p.parked[i] == null ? null : p.parked[i] / 1e4,
  })).filter(Boolean);
}

export const serializeSeries = (s) => ({ h: packTier(s?.h || []), d: packTier(s?.d || []), ...(isNum(s?.nb) ? { nb: s.nb } : {}) });
export function parseSeries(o) {
  const s = { h: unpackTier(o?.h), d: unpackTier(o?.d) };
  if (o?.nb != null) { if (!isNum(o.nb) || o.nb <= 0) throw new Error('snapshot store: nb is not a time'); s.nb = o.nb; }
  return s;
}

// A store of many pools: Map(pool id → series) ⇄ { v: 1, pools: { id: packed } }.
export function serializeStore(store) {
  const pools = {};
  for (const [id, s] of store) if (s.h.length || s.d.length) pools[id] = serializeSeries(s);
  return { v: 1, pools };
}
export function parseStore(o) {
  if (!o || o.v !== 1 || !o.pools || typeof o.pools !== 'object') throw new Error('snapshot store: not a v1 store');
  return new Map(Object.entries(o.pools).map(([id, p]) => [id, parseSeries(p)]));
}

// One pass: rowsById = Map or object (pool id → row or [rows]); unborn = Map(pool id → ms) of moments a
// backfill found the pool not there yet. Pools with nothing left are dropped.
export function mergeStore(store, rowsById, { now, unborn = null }) {
  const out = new Map(store || []);
  const entries = rowsById instanceof Map ? [...rowsById] : Object.entries(rowsById || {});
  for (const [id, rows] of entries) out.set(id, merge(out.get(id), Array.isArray(rows) ? rows : [rows], { now, unborn: unborn?.get(id) ?? null }));
  for (const [id, t] of unborn || []) if (out.has(id) && !entries.some(([k]) => k === id)) out.set(id, merge(out.get(id), [], { now, unborn: t }));
  for (const [id, s] of out) {
    const p = merge(s, [], { now });
    if (p.h.length || p.d.length) out.set(id, p); else out.delete(id);
  }
  return out;
}

// A backfill batch read at a past block is that block's state only if the block timestamp it returned
// (Multicall3 getCurrentBlockTimestamp, in the same batch) is about blocksBack × 12 s old. A node that
// answers an old block tag with today's state is caught here, and its rows are dropped.
// ageSec, when given, is the age that block should have (a chain whose pace changed, lib/chains.mjs).
export function pastBlockAnswer(ts, { nowSec, blocksBack, secPerBlock = 12, ageSec = null }) {
  const t = typeof ts === 'bigint' ? Number(ts) : ts, age = Number.isFinite(ageSec) ? ageSec : blocksBack * secPerBlock;
  return Number.isFinite(t) && t <= nowSec - age * 0.5 && t >= nowSec - age * 2;
}
