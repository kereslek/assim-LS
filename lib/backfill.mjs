// The snapshot backfill: which past moments a pool's series (lib/snapshots.mjs) is missing, the block for
// each moment, a plan of multicall batches within a per-pass budget, and how one pool's answers at that
// block become a row, "not there yet" or unread. The scan runs the plan through archive nodes, checks each
// batch's own block timestamp (pastBlockAnswer), and merges what came back; whatever the budget left is
// still missing next pass, so the backfill resumes by itself until both tiers are full.
//
// Moments: 5 minutes past each missing UTC hour (14 days) and past the first hour of each missing UTC day
// (90 days), so one read fills a day and its first hour, next to where a pass's own rows sit (the loop's
// first pass of an hour starts in its first minutes). A bucket that holds any row is not asked for
// again. Nothing before the pool's creation (createdAt, when the pool list found its event), or at or
// before a moment a read found it not there yet (the series' nb), is asked for: those rows stay absent,
// never 0. Order: the 24h window's hours, then the 30d window's days, the 7d window's hours, the daily
// chart's older days, the hourly chart's older hours; newest first within each.
//
// The block for a moment comes from (time, block) pairs already known: the store's own rows (dense over
// the last 30 days) and, where the moments wanted reach past them, block timestamps read first at a few
// probe moments (probeMoments), so the clock interpolates everywhere instead of extrapolating 60 days
// (missed slots make a plain 12 s a block land hours off). A batch that still lands outside its moment's
// hour is asked again once, in the same pass, at the block its own timestamp points to (retryJobs); the
// row that missed is real data and is kept where it landed.
//
// Pure: no I/O and no clock, except runBudgeted, which takes its clock as an argument.
import { HOUR, DAY, TIERS } from './snapshots.mjs';
import { readV3Slot0, readV4Slot0, readUint } from './pools.mjs';
import { readFeeGrowth } from './maps.mjs';
import { decodeWords } from './abi.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// The per-pass budget: at most maxBatches batches of at most callsPerBatch calls each, none started after
// deadlineMs, concurrency at a time. A batch is one eth_call (one block, one group of pools).
export const BACKFILL = Object.freeze({ maxBatches: 120, callsPerBatch: 250, deadlineMs: 60e3, concurrency: 3, at: 5 * 60e3, probeEvery: 3 * DAY });

// Each window's class reaches one step past its start, as the window maths reads a row up to one step before it.
export const ORDER = Object.freeze([
  Object.freeze({ tier: 'h', within: DAY + HOUR }), // the 24h window
  Object.freeze({ tier: 'd', within: 31 * DAY }), // the 30d window
  Object.freeze({ tier: 'h', within: 7 * DAY + HOUR }), // the 7d window
  Object.freeze({ tier: 'd', within: TIERS.d.span }), // the daily chart (90 days)
  Object.freeze({ tier: 'h', within: TIERS.h.span }), // the hourly chart (14 days)
]);

// The moments a series is missing: Map(T ms → rank in ORDER). now = the pass time; the bucket holding now
// is the pass's own. notBefore (ms): the pool's creation, when known.
export function missingMoments(series, { now, notBefore = null, at = BACKFILL.at } = {}) {
  const out = new Map();
  const floor = Math.max(isNum(notBefore) ? notBefore : -Infinity, isNum(series?.nb) ? series.nb + 1 : -Infinity);
  for (const tier of ['h', 'd']) {
    const { step, span } = TIERS[tier];
    const have = new Set((series?.[tier] || []).map((r) => Math.floor(r.t / step)));
    const b0 = Math.ceil((now - span - step - at) / step), b1 = Math.floor(now / step) - 1;
    for (let b = b1; b >= b0; b--) {
      const T = b * step + at;
      if (have.has(b) || T < floor) continue;
      const rank = ORDER.findIndex((c) => c.tier === tier && T >= now - c.within);
      if (rank < 0) continue;
      if (!out.has(T) || rank < out.get(T)) out.set(T, rank);
    }
  }
  return out;
}

// Block numbers for past moments, from known (t ms, block) pairs: linear between the two around T; past
// the oldest, along the average pace over everything known (missed slots included: a plain 12 s a block
// lands hours off at 90 days); with one pair, 12 s a block. null with nothing known.
export function blockClock(points, { secPerBlock = 12 } = {}) {
  const pts = [];
  for (const p of [...(points || [])].filter((p) => p && isNum(p.t) && Number.isSafeInteger(p.block)).sort((a, b) => a.t - b.t)) {
    if (!pts.length || (p.t > pts.at(-1).t && p.block > pts.at(-1).block)) pts.push(p); // a pair out of order with the rest is left out
  }
  const msPerBlock = secPerBlock * 1000;
  const pace = pts.length >= 2 ? (pts.at(-1).block - pts[0].block) / (pts.at(-1).t - pts[0].t) : 1 / msPerBlock;
  return (T) => {
    if (!pts.length || !isNum(T)) return null;
    if (T <= pts[0].t) return Math.round(pts[0].block - (pts[0].t - T) * pace);
    if (T >= pts.at(-1).t) return Math.round(pts.at(-1).block + (T - pts.at(-1).t) / msPerBlock);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= T) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi];
    return Math.round(a.block + ((T - a.t) * (b.block - a.block)) / (b.t - a.t));
  };
}

// Probe moments where the clock would extrapolate: from the oldest known pair back past `oldest` (the
// oldest moment wanted), one every `every`, the last just before `oldest`. [] when nothing is past them.
export function probeMoments(points, oldest, { every = BACKFILL.probeEvery } = {}) {
  const ts = (points || []).filter((p) => p && isNum(p.t)).map((p) => p.t);
  if (!ts.length || !isNum(oldest)) return [];
  const first = ts.reduce((m, t) => Math.min(m, t), Infinity), out = [];
  if (!(oldest < first - HOUR)) return [];
  for (let T = first - every; T > oldest - HOUR; T -= every) out.push(T);
  out.push(oldest - HOUR);
  return out;
}

// The oldest moment any of these pools is missing (null when none is), for probeMoments.
export function oldestMissing(pools, { now, at = BACKFILL.at } = {}) {
  let o = Infinity;
  for (const p of pools) for (const T of missingMoments(p.series, { now, notBefore: p.notBefore, at }).keys()) o = Math.min(o, T);
  return o === Infinity ? null : o;
}

// The (t, block) pairs a store already holds, for blockClock (the deep record's raw rows included: they reach
// back past the daily tier, where the fee history's deep backfill reads, lib/feehist.mjs).
export const storePoints = (store) => [...(store?.values?.() || [])].flatMap((s) => [...(s.h || []), ...(s.d || []), ...(s.y?.r || [])]).filter((r) => r.block != null).map((r) => ({ t: r.t, block: r.block }));

// The batches to read this pass. pools: [{ id, calls (multicall calls per pool), series, notBefore }];
// clock: blockClock; block: the pass's block (only older blocks are read). Returns { jobs: [{ T, block,
// rank, ids }], wanted (pool moments missing), planned (pool moments in jobs) }. momentsOf: which moments a
// series is missing (default missingMoments; the fee history's deep backfill passes its own, lib/feehist.mjs).
export function planBackfill(pools, { now, clock, block, maxBatches = BACKFILL.maxBatches, callsPerBatch = BACKFILL.callsPerBatch, at = BACKFILL.at, momentsOf = missingMoments } = {}) {
  const byT = new Map();
  let wanted = 0;
  for (const p of pools) {
    for (const [T, rank] of momentsOf(p.series, { now, notBefore: p.notBefore, at })) {
      wanted++;
      const e = byT.get(T) || { T, rank, pools: [] };
      e.rank = Math.min(e.rank, rank);
      e.pools.push(p);
      byT.set(T, e);
    }
  }
  const jobs = [];
  let planned = 0;
  for (const e of [...byT.values()].sort((a, b) => a.rank - b.rank || b.T - a.T)) {
    const blk = clock(e.T);
    if (!Number.isSafeInteger(blk) || blk < 1 || blk >= block) continue;
    const groups = [];
    let ids = [], n = 0;
    for (const p of e.pools) {
      if (ids.length && n + p.calls > callsPerBatch) { groups.push(ids); ids = []; n = 0; }
      ids.push(p.id); n += p.calls;
    }
    if (ids.length) groups.push(ids);
    for (const g of groups) {
      if (jobs.length >= maxBatches) return { jobs, wanted, planned };
      jobs.push({ T: e.T, block: blk, rank: e.rank, ids: g });
      planned += g.length;
    }
  }
  return { jobs, wanted, planned };
}

// Batches whose answer landed outside their moment's hour (the clock a few minutes off; the batch's own
// block timestamp says by how much), asked again at the block that timestamp points to. Without this a miss
// into an hour that already holds a row is dropped, teaches the clock nothing, and the same block would be
// asked for again every pass. tsMs[j]: job j's block timestamp in ms, null when unread or not that block's.
export function retryJobs(jobs, tsMs, { block, secPerBlock = 12, max = Infinity } = {}) {
  const out = [];
  jobs.forEach((job, j) => {
    const t = tsMs[j];
    if (!isNum(t) || Math.floor(t / HOUR) === Math.floor(job.T / HOUR) || out.length >= max) return;
    const b = job.block + Math.round((job.T - t) / (secPerBlock * 1000));
    if (Number.isSafeInteger(b) && b > 0 && b < block && b !== job.block) out.push({ ...job, block: b, retry: true });
  });
  return out;
}

// Run jobs n at a time; none starts once deadlineMs have passed since the first. Unstarted jobs are null.
export async function runBudgeted(jobs, fn, { concurrency = BACKFILL.concurrency, deadlineMs = BACKFILL.deadlineMs, clock = Date.now } = {}) {
  const results = new Array(jobs.length).fill(null), t0 = clock();
  let i = 0, started = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (i < jobs.length && clock() - t0 < deadlineMs) {
      const k = i++;
      started++;
      try { results[k] = await fn(jobs[k], k); } catch { results[k] = null; }
    }
  }));
  return { results, started, skipped: jobs.length - started };
}

// One pool's answers at a past block, in the order [slot0, liquidity, ...fee growth calls]:
//   { kind: 'row', row: { sqrtPriceX96, tick, L, fg0, fg1 } } — the pool's state there (L or the
//     counters may be null: unread)
//   { kind: 'unborn' } — the pool was not there yet: a v3 address with no code (an empty answer), a v3
//     pool not yet initialised (price 0), a v4 pool not yet initialised (StateView reads 0)
//   { kind: 'unread' } — slot0 not answered: whether the pool was there is unknown, so nothing is kept
//     (a v4 pool before it existed answers its fee counters with 0, which must never become a row)
export function readBackfill(v, answers) {
  const a = answers || [];
  if (v === 3 && a[0]?.ok === true && (decodeWords(a[0].data) || [null]).length === 0) return { kind: 'unborn' };
  const s0 = v === 3 ? readV3Slot0(a[0]) : readV4Slot0(a[0]);
  if (s0 === false || (s0 && s0.sqrtPriceX96 === 0n)) return { kind: 'unborn' };
  if (!s0) return { kind: 'unread' };
  const L = readUint(a[1]), fg = readFeeGrowth({ v }, a.slice(2));
  return { kind: 'row', row: { sqrtPriceX96: s0.sqrtPriceX96, tick: s0.tick, L: L ?? null, fg0: fg?.[0] ?? null, fg1: fg?.[1] ?? null } };
}

