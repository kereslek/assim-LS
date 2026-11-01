// Per-pool snapshot store: the raw state each pass reads, kept so every time window can be recomputed
// from the pool's own counters (lib/windows.mjs) instead of from a stored answer.
//
//   row = { t, block, sqrtPriceX96, tick, L, fg0, fg1, parked }
//     t ms since epoch (required); block number; sqrtPriceX96, L, fg0, fg1 BigInt (fg = the pool's
//     feeGrowthGlobal{0,1}X128); tick number; parked 0..1 (share of value parked away from the price).
//     Any field but t may be null (unread). A row with nothing read is not stored: missing is never zero.
//
// Two tiers: h = the first row in each UTC hour, kept 7 days; d = the first row in each UTC day, kept
// 30 days. Each tier keeps one step beyond its span, so a full window always has a row at its start.
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
  h: Object.freeze({ step: HOUR, span: 7 * DAY }),
  d: Object.freeze({ step: DAY, span: 30 * DAY }),
});
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
  return readCount(r) ? r : null;
}

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
export function merge(series, rows, { now } = {}) {
  const s = series || emptySeries();
  const fresh = (rows || []).map(normRow).filter(Boolean);
  const all = [...s.h, ...s.d, ...fresh];
  const at = isNum(now) ? now : all.reduce((m, r) => Math.max(m, r.t), 0);
  return { h: tierMerge([...s.h, ...fresh], TIERS.h, at), d: tierMerge([...s.d, ...fresh], TIERS.d, at) };
}

export const append = (series, row, { now = row?.t } = {}) => merge(series, [row], { now });
export const prune = (series, now) => merge(series, [], { now });

// The tier a window reads: hourly up to 7 days, daily beyond.
export const tierFor = (windowMs) => (windowMs <= TIERS.h.span ? 'h' : 'd');

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

export const serializeSeries = (s) => ({ h: packTier(s?.h || []), d: packTier(s?.d || []) });
export const parseSeries = (o) => ({ h: unpackTier(o?.h), d: unpackTier(o?.d) });

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

// One pass: rowsById = Map or object (pool id → row or [rows]). Pools with nothing left are dropped.
export function mergeStore(store, rowsById, { now }) {
  const out = new Map(store || []);
  const entries = rowsById instanceof Map ? [...rowsById] : Object.entries(rowsById || {});
  for (const [id, rows] of entries) out.set(id, merge(out.get(id), Array.isArray(rows) ? rows : [rows], { now }));
  for (const [id, s] of out) {
    const p = merge(s, [], { now });
    if (p.h.length || p.d.length) out.set(id, p); else out.delete(id);
  }
  return out;
}

// A backfill batch read at a past block is that block's state only if the block timestamp it returned
// (Multicall3 getCurrentBlockTimestamp, in the same batch) is about blocksBack × 12 s old. A node that
// answers an old block tag with today's state is caught here, and its rows are dropped.
export function pastBlockAnswer(ts, { nowSec, blocksBack, secPerBlock = 12 }) {
  const t = typeof ts === 'bigint' ? Number(ts) : ts, age = blocksBack * secPerBlock;
  return Number.isFinite(t) && t <= nowSec - age * 0.5 && t >= nowSec - age * 2;
}
