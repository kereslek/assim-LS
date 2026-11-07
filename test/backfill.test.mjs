// The snapshot backfill (lib/backfill.mjs) and history.json's rows (lib/charts.mjs) on a made-up chain
// (MOCKUP · MADE-UP NUMBERS): which moments are asked for and in what order, the block clock, the budget,
// resuming pass after pass, and pools that did not exist yet. Each check also runs against a planted
// fault and must catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, DAY, TIERS, merge, emptySeries, normRow, serializeSeries, parseSeries, mergeStore } from '../lib/snapshots.mjs';
import { BACKFILL, ORDER, missingMoments, blockClock, storePoints, planBackfill, runBudgeted, retryJobs, readBackfill, probeMoments, oldestMissing } from '../lib/backfill.mjs';
import { historyRows, intervalFeesUsd } from '../lib/charts.mjs';

const NOW = Date.UTC(2026, 10, 7, 6, 10); // a made-up pass time
const Q = 1n << 128n;
const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const ans = (...words) => ({ ok: true, data: '0x' + words.map(W).join('') });

// ---- a made-up chain: 12-second slots, about 1% of them missed, so blocks run slower than 12 s ------
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const SLOTS = 100 * 7200, SLOT0 = NOW - SLOTS * 12e3, TIMES = [];
for (let s = 0; s <= SLOTS; s++) if (s === SLOTS || rnd() > 0.01 + 0.006 * Math.sin(s / 50000)) TIMES.push(SLOT0 + s * 12e3);
const HEAD = 23_000_000, FIRST = HEAD - (TIMES.length - 1);
const timeOf = (b) => TIMES[b - FIRST];
const blockAt = (T) => { let lo = 0, hi = TIMES.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (TIMES[m] <= T) lo = m; else hi = m - 1; } return FIRST + lo; };
// A made-up pool's state at a block: born at `born` (ms); fee counters that grow with time.
const stateAt = (b, born) => {
  const t = timeOf(b);
  if (t < born) return null;
  const k = BigInt(Math.round((t - born) / 60e3));
  return { sqrtPriceX96: (79228162514264337593543950336n * BigInt(1000 + Number(k % 37n))) / 1000n, tick: Number(k % 300n) - 150, L: 10n ** 20n + k, fg0: Q * 5n + k * 10n ** 30n, fg1: Q * 2n + k * 10n ** 28n };
};
// The answers a pool gives at a block, as the scan reads them: [slot0, liquidity, fee growth...].
function answersAt(v, b, born) {
  const s = stateAt(b, born);
  if (v === 3) return s ? [ans(s.sqrtPriceX96, s.tick, 0, 1, 1, 0, 1), ans(s.L), ans(s.fg0), ans(s.fg1)] : [{ ok: true, data: '0x' }, { ok: true, data: '0x' }, { ok: true, data: '0x' }, { ok: true, data: '0x' }];
  return s ? [ans(s.sqrtPriceX96, s.tick, 0, 3000), ans(s.L), ans(s.fg0, s.fg1)] : [ans(0, 0, 0, 0), ans(0), ans(0, 0)]; // StateView reads 0 for a pool not there
}
// A pass row (what the scan stores each pass) at time t.
const passRow = (t, born = SLOT0) => ({ t, block: blockAt(t), ...stateAt(blockAt(t), born), parked: 0.4 });

// One scan pass of the backfill, read on the made-up chain: plan, read each batch at its block (its own
// timestamp is the block's), read the batches that missed their hour once more, and merge. Returns the new
// store and the plan. bias (ms): a clock that many ms early (a planted fault); retry: false drops the re-read.
function backfillPass(store, pools, now, { maxBatches = BACKFILL.maxBatches, readRow = readBackfill, bias = 0, retry = true } = {}) {
  const head = blockAt(now), entries = pools.map((p) => ({ id: p.id, calls: p.v === 3 ? 4 : 3, series: store.get(p.id), notBefore: p.createdAt ?? null }));
  // block timestamps first where the moments wanted reach past the pairs known (as the scan does)
  const anchors = [{ t: now, block: head }, ...storePoints(store)], clock0 = blockClock(anchors);
  const probes = probeMoments(anchors, oldestMissing(entries, { now })).map((T) => clock0(T)).map((b) => ({ t: timeOf(b), block: b }));
  const clock = blockClock([...anchors, ...probes]);
  const plan = planBackfill(entries, { now, clock: bias ? (T) => clock(T - bias) : clock, block: head, maxBatches });
  const again = retry ? retryJobs(plan.jobs, plan.jobs.map((j) => timeOf(j.block)), { block: head }) : [];
  const rows = new Map(pools.map((p) => [p.id, [passRow(now, p.born)].filter((r) => r.sqrtPriceX96 != null)])), unborn = new Map();
  for (const job of [...plan.jobs, ...again]) {
    for (const id of job.ids) {
      const p = pools.find((x) => x.id === id), r = readRow(p.v, answersAt(p.v, job.block, p.born));
      if (r.kind === 'row') rows.get(id).push({ t: timeOf(job.block), block: job.block, ...r.row, parked: null });
      else if (r.kind === 'unborn') unborn.set(id, Math.max(unborn.get(id) ?? 0, timeOf(job.block)));
    }
  }
  return { store: mergeStore(store, rows, { now, unborn }), plan, again };
}

test('missing moments: every empty hour of 14 days and day of 90, 5 minutes past, windows first, newest first', () => {
  // a pool with passes over the last 3 days only (one an hour)
  const s = merge(emptySeries(), Array.from({ length: 72 }, (_, k) => passRow(NOW - k * HOUR - 60e3)), { now: NOW });
  const m = missingMoments(s, { now: NOW });
  const hours = new Set(s.h.map((r) => Math.floor(r.t / HOUR))), days = new Set(s.d.map((r) => Math.floor(r.t / DAY)));
  assert.ok([...m.keys()].every((T) => T % HOUR === BACKFILL.at) && BACKFILL.at === 5 * 60e3, 'every moment is 5 minutes past an hour');
  assert.ok([...m.keys()].every((T) => !hours.has(Math.floor(T / HOUR)) || !days.has(Math.floor(T / DAY))), 'a bucket holding a row is not asked for');
  // what is asked for: the hours from 3 to 14 days back, and the days from 4 to 90 days back (each day's moment is its first hour's)
  const wantH = [...m.keys()].filter((T) => T >= NOW - TIERS.h.span - HOUR).length, wantD = [...m.keys()].filter((T) => T % DAY === BACKFILL.at).length;
  assert.ok(Math.abs(wantH - (14 - 3) * 24) <= 2, `hours ${wantH}`);
  assert.ok(Math.abs(wantD - (90 - 3)) <= 2, `days ${wantD}`);
  assert.ok(Math.min(...m.keys()) >= NOW - TIERS.d.span - DAY - HOUR && Math.max(...m.keys()) < NOW, 'inside the spans, never the pass\'s own bucket');
  // ranks: the 30d window's days before the 7d window's hours before the older days before the older hours
  const rankOf = (T) => m.get(T);
  assert.equal(rankOf(Math.floor((NOW - 10 * DAY) / DAY) * DAY + BACKFILL.at), 1);
  assert.equal(rankOf(Math.floor((NOW - 5 * DAY) / HOUR) * HOUR + 7 * HOUR + BACKFILL.at), 2);
  assert.equal(rankOf(Math.floor((NOW - 50 * DAY) / DAY) * DAY + BACKFILL.at), 3);
  assert.equal(rankOf(Math.floor((NOW - 10 * DAY) / HOUR) * HOUR + 7 * HOUR + BACKFILL.at), 4);
  assert.deepEqual(ORDER.map((c) => [c.tier, c.within / HOUR]), [['h', 25], ['d', 31 * 24], ['h', 7 * 24 + 1], ['d', 90 * 24], ['h', 14 * 24]]);
  // a full series asks for nothing
  const full = merge(emptySeries(), Array.from({ length: 92 * 24 }, (_, k) => passRow(NOW - k * HOUR - 60e3)), { now: NOW });
  assert.equal(missingMoments(full, { now: NOW }).size, 0);
  // nothing before the pool's creation or before a moment it was found not there yet (nb)
  const born = NOW - 40 * DAY;
  assert.ok([...missingMoments(s, { now: NOW, notBefore: born }).keys()].every((T) => T >= born));
  assert.ok([...missingMoments({ ...s, nb: born }, { now: NOW }).keys()].every((T) => T > born));
});

test('block clock: interpolates between known pairs; probes stand in where it would extrapolate (planted faults)', () => {
  // known: the stored rows of the last 30 days (one a day) and the pass's own block
  const known = [{ t: NOW, block: blockAt(NOW) }, ...Array.from({ length: 30 }, (_, k) => { const t = NOW - (k + 1) * DAY + 3 * 60e3; return { t: timeOf(blockAt(t)), block: blockAt(t) }; })];
  const moments = Array.from({ length: 90 }, (_, k) => Math.floor((NOW - (k + 1) * DAY) / DAY) * DAY + BACKFILL.at);
  const clock0 = blockClock(known);
  const probes = probeMoments(known, Math.min(...moments));
  assert.ok(probes.length >= 19 && probes.length <= 22 && probes.every((T, i) => i === 0 || T < probes[i - 1]) && probes.at(-1) < Math.min(...moments), `${probes.length} probes`);
  const clock = blockClock([...known, ...probes.map((T) => clock0(T)).map((b) => ({ t: timeOf(b), block: b }))]);
  const naive = (T) => blockAt(NOW) - Math.round((NOW - T) / 12e3);
  const off = (c) => moments.map((T) => timeOf(c(T)) - T);
  const worst = (xs) => Math.max(...xs.map(Math.abs));
  const hourMiss = (c) => moments.filter((T) => Math.floor(timeOf(c(T)) / HOUR) !== Math.floor(T / HOUR)).length;
  assert.ok(worst(off(clock).slice(0, 30)) < 4 * 60e3, `inside the known pairs (missed slots fall at random): off by ${worst(off(clock).slice(0, 30)) / 1e3} s`);
  assert.ok(worst(off(clock)) < 4 * 60e3 && hourMiss(clock) === 0, `with the probes: off by ${worst(off(clock)) / 60e3} min at most, ${hourMiss(clock)} in the wrong hour`);
  // planted faults: extrapolating 60 days along the known pace, or a plain 12 s a block, land in the wrong hour
  assert.ok(hourMiss(clock0) >= 20, `without the probes ${hourMiss(clock0)} of 90 moments miss their hour (off by ${worst(off(clock0)) / 60e3} min)`);
  assert.ok(hourMiss(naive) >= 60, `at 12 s a block ${hourMiss(naive)} of 90 miss their hour`);
  // nothing to probe once the known pairs reach the oldest moment; a pair out of order is left out; nothing known gives null
  assert.deepEqual(probeMoments(known, NOW - 20 * DAY), []);
  const bad = blockClock([...known, { t: NOW - 5 * DAY, block: blockAt(NOW) + 5 }]);
  assert.equal(bad(NOW - 10 * DAY + 1), clock0(NOW - 10 * DAY + 1));
  assert.equal(blockClock([])(NOW), null);
});

test('reading a past block: a pool not there yet is unborn (no row), an unread slot0 keeps nothing, never a row of zeros', () => {
  const b = blockAt(NOW - 20 * DAY), born = NOW - 10 * DAY;
  assert.deepEqual(readBackfill(3, answersAt(3, b, born)), { kind: 'unborn' }, 'v3: no code at that block');
  assert.deepEqual(readBackfill(4, answersAt(4, b, born)), { kind: 'unborn' }, 'v4: StateView reads 0');
  assert.deepEqual(readBackfill(3, [ans(0, 0, 0, 0, 0, 0, 0), ans(0), ans(0), ans(0)]), { kind: 'unborn' }, 'v3 created, not initialised');
  const later = readBackfill(4, answersAt(4, blockAt(NOW - 5 * DAY), born));
  assert.equal(later.kind, 'row');
  assert.deepEqual(later.row, (({ sqrtPriceX96, tick, L, fg0, fg1 }) => ({ sqrtPriceX96, tick, L, fg0, fg1 }))(stateAt(blockAt(NOW - 5 * DAY), born)));
  // slot0 unread: whether the pool was there is unknown, so the zero fee counters a v4 pool reads before it exists never become a row
  for (const s0 of [null, { ok: false, data: '0x' }]) assert.deepEqual(readBackfill(4, [s0, ans(0), ans(0, 0)]), { kind: 'unread' });
  // a fee counter unread stays null in the row
  const partial = readBackfill(3, [...answersAt(3, blockAt(NOW - 5 * DAY), born).slice(0, 2), null, null]);
  assert.ok(partial.kind === 'row' && partial.row.fg0 === null && partial.row.fg1 === null && partial.row.L != null);
});

test('planted fault: a pre-creation day is absent, not 0, in snapshots and history.json', () => {
  // a v4 pool born 40 days ago, backfilled from an empty store until nothing is missing
  const pool = { id: 'made-up-v4-pool', v: 4, born: NOW - 40 * DAY - 7 * HOUR };
  const fill = (readRow) => { let st = new Map(); for (let k = 0; k < 10; k++) st = backfillPass(st, [pool], NOW, { readRow }).store; return st.get(pool.id); };
  const s = fill(readBackfill);
  assert.ok(s.d.length >= 40 && s.d.length <= 41 && s.h.length >= 14 * 24, `${s.d.length} days, ${s.h.length} hours`);
  assert.ok(s.d.every((r) => r.t >= pool.born) && s.h.every((r) => r.t >= pool.born), 'no row before the pool existed');
  assert.ok(s.nb < pool.born && s.nb > pool.born - DAY, 'the moment it was found not there is kept');
  assert.equal(missingMoments(s, { now: NOW }).size, 0, 'and nothing before it is asked for again');
  const pl = { d0: 18, d1: 6, usd0: 2, usd1: 1, rate: 0.003 }, hist = historyRows(s, pl);
  assert.equal(hist.d.length, s.d.length, 'one history row a stored day: none before the pool');
  assert.equal(hist.d[0][2], null, 'the first day has no fees (nothing before it), never 0 and never the lifetime');
  const typical = hist.d.slice(1).map((r) => r[2]).sort((a, b) => a - b)[Math.floor((hist.d.length - 1) / 2)];
  assert.ok(hist.d.slice(1).every((r) => r[2] > 0 && r[2] < 2 * typical), 'every day after it holds about one day of fees');
  // the fault: the first backfill kept a row whenever slot0 OR the fee counters answered, so a v4 pool's pre-creation
  // answers (no price, counters 0) became rows; its first real day then carries the pool's whole lifetime of fees
  const oldRule = (v, a) => { const r = readBackfill(v, a); if (r.kind !== 'unborn') return r; return v === 4 ? { kind: 'row', row: { sqrtPriceX96: null, tick: null, L: 0n, fg0: 0n, fg1: 0n } } : r; };
  const zeroRow = { t: NOW - 60 * DAY, block: blockAt(NOW - 60 * DAY), sqrtPriceX96: null, tick: null, L: 0n, fg0: 0n, fg1: 0n, parked: null };
  const faulty = { h: s.h, d: [zeroRow, ...s.d] }, fh = historyRows(faulty, pl);
  assert.ok(fh.d[1][2] > 100 * typical, `with the zero row, the first real day shows ${fh.d[1][2]} against a typical ${typical}: a fake spike`);
  // the guard: such a row is never stored, wherever it comes from (a pass, the old store, a backfill)
  assert.equal(normRow(zeroRow), null);
  assert.equal(merge(s, [zeroRow], { now: NOW }).d.length, s.d.length);
  assert.equal(parseSeries(JSON.parse(JSON.stringify(serializeSeries(faulty)))).d.length, s.d.length, 'an old store holding one loses it on load');
  const s2 = fill(oldRule);
  assert.deepEqual(historyRows(s2, pl).d.map((r) => r[0]), hist.d.map((r) => r[0]), 'even the old read rule now leaves no pre-creation row');
});

test('the plan keeps to its budget, puts the windows first, and resumes pass after pass until both tiers are full', () => {
  // three made-up pools: two old ones (one with a known creation time) and one born 20 days ago
  const pools = [
    { id: 'made-up-a', v: 3, born: SLOT0 }, { id: 'made-up-b', v: 4, born: SLOT0 },
    { id: 'made-up-c', v: 3, born: NOW - 20 * DAY - 5 * HOUR, createdAt: NOW - 20 * DAY - 5 * HOUR },
  ];
  let store = new Map();
  const passes = [];
  for (let k = 0; k < 12; k++) {
    const r = backfillPass(store, pools, NOW, { maxBatches: 100 });
    store = r.store;
    passes.push(r.plan);
    if (!r.plan.jobs.length) break;
    assert.ok(r.plan.jobs.length <= 100, 'the budget holds');
    assert.ok(r.plan.jobs.every((j, i) => i === 0 || j.rank > r.plan.jobs[i - 1].rank || (j.rank === r.plan.jobs[i - 1].rank && j.T < r.plan.jobs[i - 1].T)), 'windows first, newest first');
    assert.ok(r.plan.jobs.every((j) => j.ids.length * 4 <= BACKFILL.callsPerBatch && j.block < blockAt(NOW)), 'batches fit, and only past blocks');
  }
  assert.ok(passes.length >= 5 && passes.length <= 8 && passes.at(-1).jobs.length === 0, `done in ${passes.length - 1} passes`);
  // the first pass already covers the 24h and 30d windows
  const first = backfillPass(new Map(), pools, NOW, { maxBatches: 100 }).store.get('made-up-a');
  assert.ok(first.h.filter((r) => r.t >= NOW - DAY - HOUR).length >= 24 && first.d.filter((r) => r.t >= NOW - 31 * DAY).length >= 30);
  // in the end: 14 days of hours and 90 days for the old pools; the young one from its creation only
  for (const id of ['made-up-a', 'made-up-b']) {
    const s = store.get(id);
    assert.ok(s.h.length >= 14 * 24 && s.h.length <= 14 * 24 + 2 && s.d.length >= 90 && s.d.length <= 92, `${id}: ${s.h.length} hours, ${s.d.length} days`);
  }
  const c = store.get('made-up-c');
  assert.ok(c.d.length >= 20 && c.d.length <= 21 && c.d.every((r) => r.t >= pools[2].born), `young pool: ${c.d.length} days`);
  // no moment was asked for twice: once a bucket holds a row, it is done
  const asked = passes.flatMap((p) => p.jobs.flatMap((j) => j.ids.map((id) => `${id}@${j.T}`)));
  assert.equal(new Set(asked).size, asked.length);
  // planted fault: a plan that ignores its budget reads everything in one pass
  const greedy = planBackfill(pools.map((p) => ({ id: p.id, calls: 4, series: null })), { now: NOW, clock: blockClock([{ t: NOW, block: blockAt(NOW) }]), block: blockAt(NOW), maxBatches: Infinity });
  assert.ok(greedy.jobs.length > 100, 'without the budget the first pass would read every moment at once');
});

test('a batch that misses its hour is read again at the block its timestamp points to (planted fault: asked for forever)', () => {
  // passes every hour for the last 3 days, but three single hours were missed
  const pool = { id: 'made-up-a', v: 3, born: SLOT0 };
  const gap = [20, 30, 40].map((k) => Math.floor((NOW - k * HOUR) / HOUR) * HOUR);
  const rows = Array.from({ length: 72 }, (_, k) => passRow(Math.floor((NOW - k * HOUR) / HOUR) * HOUR + 3 * 60e3)).filter((r) => !gap.includes(Math.floor(r.t / HOUR) * HOUR));
  const start = new Map([[pool.id, merge(emptySeries(), rows, { now: NOW })]]);
  const holes = (st) => gap.filter((h) => !st.get(pool.id).h.some((r) => Math.floor(r.t / HOUR) * HOUR === h)).length;
  // a clock 10 minutes early: each moment (5 past) lands 5 minutes before its hour, in an hour that already holds a row
  let st = start, r;
  for (let k = 0; k < 3; k++) { r = backfillPass(st, [pool], NOW, { bias: 10 * 60e3, retry: false }); st = r.store; }
  assert.equal(holes(st), 3, 'planted fault: without the re-read the three hours stay empty, pass after pass');
  assert.ok(r.plan.jobs.some((j) => gap.includes(Math.floor(j.T / HOUR) * HOUR)), 'and the same moments are asked for again');
  // with it: one pass fills them, at the corrected blocks
  r = backfillPass(start, [pool], NOW, { bias: 10 * 60e3 });
  assert.equal(holes(r.store), 0);
  assert.ok(r.again.length >= 3 && r.again.every((j) => j.retry && Math.floor(timeOf(j.block) / HOUR) === Math.floor(j.T / HOUR)), `${r.again.length} re-read`);
  // a batch that landed in its hour, or whose timestamp is unknown, is not read again
  assert.deepEqual(retryJobs([{ T: NOW - HOUR, block: 5 }, { T: NOW - HOUR, block: 6 }], [NOW - HOUR + 60e3, null], { block: 10 }), []);
});

test('the time budget: no batch starts after the deadline; the rest wait for the next pass', async () => {
  let fake = 0;
  const clock = () => fake;
  const jobs = Array.from({ length: 50 }, (_, k) => k);
  const r = await runBudgeted(jobs, async (k) => { fake += 1000; return k * 2; }, { concurrency: 3, deadlineMs: 20e3, clock });
  assert.ok(r.started >= 20 && r.started <= 23 && r.skipped === 50 - r.started, `${r.started} started`);
  assert.ok(r.results.slice(0, r.started).every((x, k) => x === k * 2) && r.results.slice(r.started).every((x) => x === null));
  // a batch that throws is unread (null), and the others still run
  const t = await runBudgeted([1, 2, 3], async (k) => { if (k === 2) throw new Error('node down'); return k; }, { deadlineMs: 1e9 });
  assert.deepEqual(t.results, [1, null, 3]);
});

test('not-before moments: kept through the store, ignored when a row contradicts them', () => {
  const s = merge(emptySeries(), [passRow(NOW - 2 * DAY)], { now: NOW, unborn: NOW - 30 * DAY });
  assert.equal(s.nb, NOW - 30 * DAY);
  const back = parseSeries(JSON.parse(JSON.stringify(serializeSeries(s))));
  assert.equal(back.nb, NOW - 30 * DAY, 'round trip');
  assert.throws(() => parseSeries({ ...serializeSeries(s), nb: 'soon' }), /nb/);
  // a later "not there" contradicts a row the store holds (the pool was there): it is ignored and no row is lost
  const c = merge(s, [], { now: NOW, unborn: NOW - DAY });
  assert.equal(c.nb, NOW - 30 * DAY);
  assert.equal(c.d.length, s.d.length);
  // and it ages out with the daily span
  assert.equal(merge(s, [], { now: NOW + 70 * DAY }).nb, undefined);
});

test('history rows: fees between stored rows, null after an unread row, rounded, in the same five columns', () => {
  const rows = Array.from({ length: 5 }, (_, k) => passRow(NOW - (4 - k) * DAY + 60e3));
  rows[2] = { ...rows[2], fg0: null };
  const s = merge(emptySeries(), rows, { now: NOW }), pl = { d0: 18, d1: 6, usd0: 2, usd1: 1, rate: 0.003 };
  const h = historyRows(s, pl);
  assert.deepEqual(h.d.map((r) => r[2] === null), [true, false, true, true, false], 'first row, the unread one and the one after it: null');
  assert.ok(Math.abs(h.d[4][2] - intervalFeesUsd(s.d[3], s.d[4], pl)) <= 1e-4 * h.d[4][2] && Math.abs(h.d[4][3] - h.d[4][2] / 0.003) <= 1e-3 * h.d[4][3]);
  assert.ok(h.h.every((r) => r.length === 5 && (r[2] === null || Number(r[2].toPrecision(8)) === r[2]) && (r[4] === null || Math.round(r[4] * 1e4) / 1e4 === r[4])));
});
