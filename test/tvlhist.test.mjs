// The volume and TVL history (lib/tvlhist.mjs) on made-up pools (MOCKUP · MADE-UP NUMBERS): a pool's two token balances
// at a day's end become its TVL at that day's prices; a failed read or an unpriced token is null, never 0; a v4 pool
// gets only its map's value (no balance of its own); Base's archive reach ends the backfill at about 90 days; the days
// line up with the fee rows (y), the swaps over the candle for volume, the first reading kept; the archive reads fit
// the deep backfill's caps (batches, calls a batch, days a pool); the cache round-trips; the public line carries counts
// and ratios only; history.json's size stays in check; and the series never reach a window, the gem, a lens or the
// backtest. Each check also runs against a planted fault and must catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOUR, DAY, merge, emptySeries } from '../lib/snapshots.mjs';
import { BACKFILL, planBackfill, blockClock, missingMoments } from '../lib/backfill.mjs';
import { FEEHIST, DEEP_RANK, deepMoments } from '../lib/feehist.mjs';
import { allWindows } from '../lib/windows.mjs';
import { readUint } from '../lib/pools.mjs';
import { seal } from '../lib/lock.mjs';
import { SWAP_TOPICS } from '../lib/swaps.mjs';
import { dayFees, eventsByPool, packSx, unpackSx, emptyCache } from '../lib/exactfees.mjs';
import { TVLHIST, endOfDay, reachDay, balanceCalls, readBalances, holdings, mapHoldings, emptyTv, tvHeld, touchTv, recordTv, packTv, unpackTv,
  endMoment, isEndMoment, tvlMoments, unionMoments, volTvlYear, tvlLines } from '../lib/tvlhist.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = Date.UTC(2026, 10, 14, 12, 40);
const TODAY = Math.floor(NOW / DAY) * DAY;
const D0 = 18, D1 = 6, USD0 = 2.5, USD1 = 1, PX = 2.5; // token0 $2.50 (18 decimals), token1 $1 (6 decimals): 2.5 token1 per token0
const SQRT = BigInt(Math.round(Math.sqrt(PX * 10 ** (D1 - D0)) * 2 ** 96));
const POOL = { v: 3, d0: D0, d1: D1, usd0: USD0, usd1: USD1, pxNow: PX };
const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const ok = (v) => ({ ok: true, data: '0x' + W(v) });
const A = (c) => '0x' + c.repeat(40);
const T0 = A('1'), T1 = A('2'), P3 = A('a'), V4ID = '0x' + 'c'.repeat(64);
const near = (a, b, tol = 2e-3) => Math.abs(a / b - 1) < tol;
// 1,000 token0 and 4,000 token1 in the pool: $2,500 + $4,000 at the pass's prices
const BAL = [1000n * 10n ** 18n, 4000n * 10n ** 6n];
const yRows = (from, to = TODAY - DAY) => { const y = []; for (let t = from; t <= to; t += DAY) y.push([t, 1, 'e']); return y; };
// GeckoTerminal's cache entry: token0 is its base; close(d) its USD close, vol(d) the day's volume
const gtOf = ({ close = () => USD0, vol = () => 5e5, from = TODAY - 366 * DAY } = {}) => {
  const days = new Map();
  for (let t = from; t < TODAY; t += DAY) days.set(t, [vol(t / DAY), close(t / DAY)]);
  return { t: NOW, b: 0, days };
};
const tvOf = (entries) => ({ c: 'ethereum', t: NOW, d: new Map(entries) });
// a pool watched for months: an hourly row 5 minutes past each hour (14 days) and a daily one (91 days), so the daily
// and hourly backfill ask nothing of it (skip: days whose daily row is missing)
function watched({ skip = [] } = {}) {
  const rows = [], row = (t) => ({ t, block: 1, sqrtPriceX96: SQRT, tick: 0, L: 1n, fg0: 1n, fg1: 1n });
  for (let t = Math.floor((NOW - 14 * DAY) / HOUR) * HOUR + BACKFILL.at; t < NOW; t += HOUR) if (!skip.includes(Math.floor(t / DAY) * DAY)) rows.push(row(t));
  for (let d = TODAY - 91 * DAY; d <= TODAY; d += DAY) if (!skip.includes(d)) rows.push(row(d + BACKFILL.at));
  return merge(emptySeries(), rows, { now: NOW });
}

test('a reading in the first hour of a UTC day is the day before\'s end; the archive\'s reach in days', () => {
  assert.equal(endOfDay(TODAY + 5 * 60e3), TODAY - DAY, '00:05 closes yesterday');
  assert.equal(endOfDay(TODAY), TODAY - DAY);
  assert.equal(endOfDay(TODAY + HOUR), TODAY - DAY, 'the hour\'s end still counts');
  assert.equal(endOfDay(TODAY + HOUR + 1), null, 'later in the day: not a day\'s end');
  assert.equal(endOfDay(TODAY - 60e3), null, '23:59: inside its own day, not its end');
  assert.equal(endOfDay(null), null);
  assert.ok(isEndMoment(endMoment(TODAY - 3 * DAY)) && endMoment(TODAY - 3 * DAY) === TODAY - 2 * DAY + BACKFILL.at);
  // Base's 90 days: the oldest day whose 00:05 moment is within 90 days of the pass
  const r = reachDay(NOW, 90 * DAY);
  assert.ok(endMoment(r) >= NOW - 90 * DAY && endMoment(r - DAY) < NOW - 90 * DAY, `${(TODAY - r) / DAY} days back`);
  assert.equal(reachDay(NOW, null), null, 'no reach (Ethereum): every day of the year');
  // planted fault: the fee history's 4-hour alignment used for a day's end → a 03:00 reading would count, caught
  const loose = (ts) => (ts - Math.floor(ts / DAY) * DAY <= 4 * HOUR ? Math.floor(ts / DAY) * DAY - DAY : null);
  assert.notEqual(loose(TODAY + 3 * HOUR), endOfDay(TODAY + 3 * HOUR));
});

test('balances at a day\'s end → TVL at that day\'s prices (the close for the base token, the pool\'s own price for the other)', () => {
  const calls = balanceCalls({ v: 3, id: P3, t0: T0, t1: T1 });
  assert.deepEqual(calls.map((c) => c.target), [T0, T1], 'balanceOf on each token');
  assert.ok(calls.every((c) => c.data.startsWith('0x70a08231') && c.data.endsWith(P3.slice(2))), 'balanceOf(pool)');
  const bal = readBalances([ok(BAL[0]), ok(BAL[1])]);
  assert.deepEqual(bal, BAL);
  const [q, px] = holdings(bal, SQRT);
  assert.ok(near(px * 10 ** (D0 - D1), PX, 1e-6) && near(q, 1000e18 * px + 4000e6, 1e-5), 'token1 raw units, token0 converted at the pool\'s price');
  // a different close every day: each day valued at its own
  const close = (d) => USD0 * (1 + (d % 3) / 10), gt = gtOf({ close });
  const days = [5, 4, 3, 2, 1].map((k) => TODAY - k * DAY);
  const tv = tvOf(days.map((d) => [d, [q, px, 'b']]));
  const { yt, ytp, last } = volTvlYear({ y: yRows(TODAY - 10 * DAY), gt, tv, pool: POOL, now: NOW });
  for (const d of days) {
    const c = close(d / DAY), want = 1000 * c + 4000 * (c / PX); // token0 at its close, token1 at the close ÷ the pool's price
    const got = yt[(d - (TODAY - 10 * DAY)) / DAY];
    assert.equal(got[1], 'b');
    assert.ok(near(got[0], want), `${new Date(d).toISOString().slice(0, 10)}: ${got[0]} vs ${want}`);
  }
  assert.deepEqual(ytp, { b: 5, r: 0, m: 0, lim: null, from: null });
  assert.ok(near(last, 1000 * close(TODAY / DAY - 1) + 4000 * close(TODAY / DAY - 1) / PX), 'yesterday\'s for the cross-check');
  // no close within 3 days: the pass's prices ($2.50 and $1)
  const flat = volTvlYear({ y: yRows(TODAY - 10 * DAY), gt: null, tv, pool: POOL, now: NOW }).yt.at(-1);
  assert.ok(near(flat[0], 2500 + 4000));
  // planted fault: every day valued at today's prices → the past redrawn by today's price, caught
  const today = (d) => 2500 * (close(TODAY / DAY) / USD0) + 4000 * (close(TODAY / DAY) / PX);
  assert.ok(days.some((d) => !near(today(d), yt[(d - (TODAY - 10 * DAY)) / DAY][0])));
  // a pool holding nothing (both balances read as 0) is a real 0
  assert.deepEqual(holdings([0n, 0n], SQRT), [0, Number(((Number(SQRT) / 2 ** 96) ** 2).toPrecision(6))]);
});

test('a failed read or an unpriced token gives null, never 0 (planted fault: a failed balance read as 0)', () => {
  const failed = [[null, ok(5)], [ok(5), null], [{ ok: false, data: '0x' }, ok(5)], [ok(5), { ok: true, data: '0x' }], []];
  for (const a of failed) assert.equal(readBalances(a), null, JSON.stringify(a));
  assert.equal(holdings(null, SQRT), null);
  assert.equal(holdings(BAL, 0n), null, 'no price: nothing to convert token0 with');
  assert.equal(holdings(BAL, null), null);
  assert.equal(holdings([1n], SQRT), null);
  assert.equal(mapHoldings(NaN, D1, SQRT), null);
  assert.equal(mapHoldings(5, undefined, SQRT), null, 'token1\'s decimals unknown');
  const cache = emptyTv();
  assert.equal(recordTv(cache, P3, { day: TODAY - DAY, reading: null, src: 'b', now: NOW }), false, 'nothing kept for an unread day');
  assert.equal(recordTv(cache, P3, { day: TODAY - DAY, reading: [-1, 1], src: 'b', now: NOW }), false);
  assert.equal(recordTv(cache, P3, { day: TODAY - DAY, reading: [1, 1], src: 'x', now: NOW }), false, 'an unknown source');
  // a reading the day can't be priced for: token decimals unknown, or no close and no price at all → null, never 0
  const tv = tvOf([[TODAY - DAY, [...holdings(BAL, SQRT), 'b']]]);
  assert.deepEqual(volTvlYear({ y: yRows(TODAY - DAY), tv, pool: { ...POOL, d1: undefined }, now: NOW }).yt, [[null, null]]);
  assert.deepEqual(volTvlYear({ y: yRows(TODAY - DAY), tv, pool: { v: 3, d0: D0, d1: D1 }, now: NOW }).yt, [[null, null]]);
  // no reading at all: null, and counted as still to read (Ethereum v3)
  const none = volTvlYear({ y: yRows(TODAY - 3 * DAY), pool: POOL, now: NOW });
  assert.deepEqual(none.yt, [[null, null], [null, null], [null, null]]);
  assert.deepEqual([none.gone, none.open], [0, 3]);
  // planted fault: a reader that takes a failed balance as 0 books a pool's whole token0 side away, caught
  const zeroed = (a) => [readUint(a[0]) ?? 0n, readUint(a[1]) ?? 0n];
  assert.notEqual(holdings(zeroed([null, ok(BAL[1])]), SQRT), null, 'the faulty reader yields a number');
  assert.equal(holdings(readBalances([null, ok(BAL[1])]), SQRT), null, 'the real one: null');
});

test('a v4 pool: no balance of its own (the PoolManager holds every pool\'s tokens), only its map\'s value; past days not readable', () => {
  assert.deepEqual(balanceCalls({ v: 4, id: V4ID, t0: T0, t1: T1 }), [], 'no balanceOf for a v4 pool');
  // its map: 3,000 token1 (human) of value at the reading's price → [q, px]; valued as a balance reading is
  const r = mapHoldings(3000, D1, SQRT);
  assert.ok(near(r[0], 3000e6, 1e-6));
  const tv = tvOf([[TODAY - DAY, [...r, 'm']]]);
  const v4 = volTvlYear({ y: yRows(TODAY - 5 * DAY), gt: gtOf(), tv, pool: { ...POOL, v: 4 }, now: NOW });
  assert.ok(near(v4.yt.at(-1)[0], 3000 * (USD0 / PX)) && v4.yt.at(-1)[1] === 'm');
  assert.deepEqual(v4.yt.slice(0, 4), [[null, null], [null, null], [null, null], [null, null]], 'earlier days: null, never estimated');
  assert.deepEqual(v4.ytp, { b: 0, r: 0, m: 1, lim: 'v4', from: null });
  assert.deepEqual([v4.gone, v4.open], [4, 0], 'not readable, not "to read"');
  // planted fault: balanceOf(PoolManager) read as the pool's own → every v4 pool's tokens in one, far above its map, caught
  const manager = holdings([10n ** 24n, 10n ** 13n], SQRT);
  assert.ok(manager[0] > 1000 * r[0]);
});

test('Base: the archive reads stop at its reach (about 90 days); older days null and counted not readable', () => {
  const series = watched(), reachMs = 90 * DAY;
  const ms = tvlMoments(series, { now: NOW, reachMs, perPool: 400 });
  assert.ok(ms.size > 0 && [...ms.keys()].every((T) => T >= NOW - reachMs), 'no moment past the reach');
  const eth = tvlMoments(series, { now: NOW, perPool: 400 });
  assert.ok([...eth.keys()].some((T) => T < NOW - 300 * DAY), 'Ethereum: back to the year\'s start');
  const y = yRows(TODAY - 365 * DAY), base = volTvlYear({ y, pool: POOL, now: NOW, reachMs });
  assert.equal(base.ytp.lim, 'archive');
  assert.equal(base.ytp.from, reachDay(NOW, reachMs));
  assert.equal(base.gone, (base.ytp.from - y[0][0]) / DAY, 'the days before the reach: not readable');
  assert.equal(base.open, y.length - base.gone);
  // planted fault: Base read with Ethereum's rule (no reach) → moments older than its nodes keep, caught
  assert.ok([...tvlMoments(series, { now: NOW, perPool: 400 }).keys()].some((T) => T < NOW - reachMs));
});

test('the archive moments: missing days only, never before the pool existed, never a moment the daily backfill asks itself', () => {
  // a series missing two days of its daily tier: the daily backfill asks those itself
  const s = watched({ skip: [TODAY - 40 * DAY, TODAY - 41 * DAY] });
  const reg = missingMoments(s, { now: NOW });
  assert.ok(reg.has(TODAY - 40 * DAY + BACKFILL.at), 'the daily backfill\'s own moment');
  const have = new Set([TODAY - 2 * DAY]);
  const ms = tvlMoments(s, { now: NOW, have, perPool: 400 });
  assert.ok([...ms.keys()].every((T) => !reg.has(T)), 'none the daily backfill asks');
  assert.ok(!ms.has(endMoment(TODAY - 2 * DAY)), 'a day held is not asked again');
  assert.ok(ms.has(endMoment(TODAY - DAY)), 'yesterday, at today\'s 00:05');
  assert.ok([...ms.values()].every((r) => r === DEEP_RANK), 'after every moment the windows and charts need');
  assert.ok([...ms.keys()].every((T, i, a) => i === 0 || T < a[i - 1]), 'newest first');
  assert.equal(tvlMoments(s, { now: TODAY + 3 * 60e3 }).has(TODAY + BACKFILL.at), false, 'today\'s 00:05 not passed yet');
  assert.equal(tvlMoments(s, { now: NOW, perPool: 4 }).size, 4, 'at most perPool a pass');
  // created 40 days ago at 07:00: its creation day's end is the first; nothing before it (nor before a read found it not there)
  const born = TODAY - 40 * DAY + 7 * HOUR, mb = tvlMoments(watched(), { now: NOW, notBefore: born, perPool: 400 });
  assert.ok([...mb.keys()].every((T) => T >= born));
  assert.equal(Math.min(...mb.keys()), endMoment(TODAY - 40 * DAY));
  const nb = tvlMoments({ ...watched(), nb: born }, { now: NOW, perPool: 400 });
  assert.ok(nb.size > 0);
  assert.ok([...nb.keys()].every((T) => T > born));
  // the union with the fee history's own: newest first, at most perPool
  const u = unionMoments(new Map([[5, 1], [9, 1]]), new Map([[7, 1], [9, 1], [1, 1]]), 3);
  assert.deepEqual([...u.keys()], [9, 7, 5]);
  // planted fault: a plan that ignores the creation → asks for a day the pool did not exist by its end, caught
  assert.ok([...tvlMoments(watched(), { now: NOW, perPool: 400 }).keys()].some((T) => T < born));
});

test('alignment and precedence: yv and yt are the y rows\' days; the swaps over the candle; the first reading kept', () => {
  const y = yRows(TODAY - 6 * DAY);
  const gt = gtOf({ vol: (d) => 1e5 + d % 5 }), q = holdings(BAL, SQRT);
  // the swaps' day: [fees q, px, volume vq] (lib/exactfees.mjs), 2 days with swaps, one swap day with no volume field (read earlier)
  const sx = { d: new Map([[TODAY - 2 * DAY, [10, q[1], 2e11]], [TODAY - 3 * DAY, [10, q[1]]], [TODAY - DAY, [0, q[1], 0]]]) };
  const cache = emptyTv();
  assert.equal(recordTv(cache, P3, { day: TODAY - 2 * DAY, reading: q, src: 'r', now: NOW }), true);
  assert.equal(recordTv(cache, P3, { day: TODAY - 2 * DAY, reading: [q[0] * 2, q[1]], src: 'b', now: NOW }), false, 'held: never replaced');
  assert.equal(recordTv(cache, P3, { day: TODAY, reading: q, src: 'r', now: NOW }), false, 'today is not complete');
  assert.equal(recordTv(cache, P3, { day: TODAY - 400 * DAY, reading: q, src: 'b', now: NOW }), false, 'older than the year');
  assert.equal(recordTv(cache, P3, { day: TODAY - 2 * DAY + 5, reading: q, src: 'b', now: NOW }), false, 'not a UTC day');
  assert.equal(tvHeld(cache, P3, TODAY - 2 * DAY), true);
  const r = volTvlYear({ y, gt, sx, tv: cache.get(P3), pool: POOL, now: NOW });
  assert.equal(r.yv.length, y.length);
  assert.equal(r.yt.length, y.length, 'one row per y row: yv[i], yt[i] are day y[i][0]');
  const at = (d) => (d - y[0][0]) / DAY;
  assert.equal(r.yv[at(TODAY - 2 * DAY)][1], 's', 'the swaps over the candle');
  assert.ok(near(r.yv[at(TODAY - 2 * DAY)][0], (2e11 / 1e6) * (USD0 / PX)), 'Σ input amounts in token1, at the day\'s price');
  assert.equal(r.yv[at(TODAY - 3 * DAY)][1], 'g', 'a swap day read before the volume was summed: the candle');
  assert.deepEqual(r.yv[at(TODAY - DAY)], [0, 's'], 'a day read with no swaps: a real 0');
  assert.equal(r.yv[0][1], 'g');
  assert.deepEqual(r.yvp, { s: 2, g: 4 });
  assert.ok(near(r.yt[at(TODAY - 2 * DAY)][0], 2500 + 4000) && r.yt[at(TODAY - 2 * DAY)][1] === 'r', 'the first reading');
  // a day GeckoTerminal has no candle for and no swaps: null
  const gap = gtOf(); gap.days.delete(TODAY - 4 * DAY);
  assert.deepEqual(volTvlYear({ y, gt: gap, pool: POOL, now: NOW }).yv[at(TODAY - 4 * DAY)], [null, null]);
  // the y rows decide the days: a reading before the pool's first y row is not shown
  const late = volTvlYear({ y: y.slice(3), gt, tv: tvOf([[TODAY - 5 * DAY, [...q, 'b']]]), pool: POOL, now: NOW });
  assert.equal(late.yt.length, 3);
  assert.ok(late.yt.every((x) => x[0] == null));
  // the swaps÷candle ratio: only candle days of at least $1,000
  assert.deepEqual(r.vx.length, 2);
  // planted fault: the candle allowed over the swaps → a different row, caught
  const leaky = r.yv.map((x, i) => (x[1] === 's' ? [gt.days.get(y[i][0])[0], 'g'] : x));
  assert.notDeepEqual(leaky, r.yv);
});

test('caps: the archive days fit the deep backfill\'s batches and calls a batch, balances included; the largest pools first', () => {
  const clock = blockClock([{ t: NOW, block: 20_000_000 }]);
  const base = 4, s = merge(emptySeries(), [{ t: NOW - HOUR, block: 1, sqrtPriceX96: SQRT, tick: 0, L: 1n, fg0: 1n, fg1: 1n }], { now: NOW });
  const pools = Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, v: i % 5 ? 3 : 4, series: s, notBefore: null, tvl: 1000 - i }));
  const callsAt = (p, T) => base + (p.v === 3 && endOfDay(T) != null ? 2 : 0);
  const momentsOf = (x, o, p) => unionMoments(deepMoments(x, { ...o, perPool: FEEHIST.deep.perPool }), p.v === 3 ? tvlMoments(x, { ...o, perPool: FEEHIST.deep.perPool }) : null, FEEHIST.deep.perPool);
  const plan = planBackfill(pools.map((p) => ({ ...p, calls: (T) => callsAt(p, T) })), { now: NOW, clock, block: 20_000_000, maxBatches: FEEHIST.deep.batches, momentsOf });
  assert.equal(plan.jobs.length, FEEHIST.deep.batches, 'at most the deep backfill\'s batches');
  const byId = new Map(pools.map((p) => [p.id, p]));
  for (const j of plan.jobs) assert.ok(j.ids.reduce((a, id) => a + callsAt(byId.get(id), j.T), 0) <= BACKFILL.callsPerBatch, 'at most 250 calls a batch, balances included');
  assert.ok(plan.jobs.every((j, i, a) => i === 0 || j.T <= a[i - 1].T), 'newest days first');
  assert.ok(plan.jobs.every((j) => j.ids.every((id, k) => k === 0 || Number(id.slice(1)) > Number(j.ids[k - 1].slice(1)))), 'the largest pools first');
  const perPool = new Map();
  for (const j of plan.jobs) for (const id of j.ids) perPool.set(id, (perPool.get(id) || 0) + 1);
  assert.ok([...perPool.values()].every((n) => n <= FEEHIST.deep.perPool), 'at most perPool days a pool a pass');
  // the pass's own reading: only in the first hour after midnight
  assert.equal(endOfDay(TODAY + 61 * 60e3), null);
  // planted fault: planned with the base calls only (the balances forgotten) → a batch over 250 calls when read, caught
  const blind = planBackfill(pools.map((p) => ({ ...p, calls: base })), { now: NOW, clock, block: 20_000_000, maxBatches: FEEHIST.deep.batches, momentsOf });
  assert.ok(blind.jobs.some((j) => j.ids.reduce((a, id) => a + callsAt(byId.get(id), j.T), 0) > BACKFILL.callsPerBatch));
});

test('the readings round-trip through snapshots.json; malformed entries dropped; a pool not scanned for 30 days leaves', () => {
  const c = emptyTv(), q = holdings(BAL, SQRT);
  touchTv(c, [{ id: P3, chain: 'ethereum' }, { id: V4ID, chain: 'base' }], NOW);
  recordTv(c, P3, { day: TODAY - DAY, reading: q, src: 'r', now: NOW });
  recordTv(c, P3, { day: TODAY - 4 * DAY, reading: q, src: 'b', now: NOW });
  recordTv(c, V4ID, { day: TODAY - 2 * DAY, reading: mapHoldings(10, D1, SQRT), src: 'm', now: NOW });
  c.set('old', { c: 'ethereum', t: NOW - 31 * DAY, d: new Map([[TODAY - DAY, [1, 1, 'b']]]) });
  const packed = JSON.parse(JSON.stringify(packTv(c, { now: NOW })));
  assert.deepEqual(Object.keys(packed).sort(), [P3, V4ID].sort(), 'the pool not scanned for 31 days is dropped');
  assert.equal(packed[P3].s, 'b..r', 'one source a day, "." for none');
  assert.deepEqual(packed[P3].q, [q[0], null, null, q[0]]);
  const back = unpackTv(packed);
  assert.deepEqual([...back.get(P3).d], [[TODAY - 4 * DAY, [...q, 'b']], [TODAY - DAY, [...q, 'r']]]);
  assert.equal(back.get(V4ID).d.get(TODAY - 2 * DAY)[2], 'm');
  const bad = unpackTv({ a: { t: NOW, d0: 5, q: [1], px: [1], s: 'b' }, b: { t: NOW, d0: TODAY, q: [-1, 'x', 2], px: [1, 1, 1], s: 'bbz' }, c: { t: NOW, d0: TODAY, q: [1], px: [1], s: 'bb' } });
  assert.equal(bad.has('a'), false, 'a d0 off a UTC day: dropped');
  assert.equal(bad.get('b').d.size, 0, 'a negative or junk value, or an unknown source: not a reading');
  assert.equal(bad.has('c'), false, 'columns that don\'t match');
  assert.equal(unpackTv(null).size, 0);
  // planted fault: a pack that loses the sources → every day unreadable on the way back, caught
  const lossy = unpackTv(JSON.parse(JSON.stringify({ ...packed, [P3]: { ...packed[P3], s: '....' } })));
  assert.notDeepEqual([...lossy.get(P3).d], [...back.get(P3).d]);
});

test('exact fees sum the day\'s volume beside its fees: Σ input amounts, token0\'s side at the day\'s price (planted fault: outputs)', () => {
  const ADDR = '0x' + W(7), Q96 = 1n << 96n, E18 = 10n ** 18n;
  let li = 0;
  const at = (block) => ({ blockNumber: '0x' + block.toString(16), logIndex: '0x' + (li++).toString(16), transactionHash: '0x' + (li * 7919).toString(16).padStart(64, '0') });
  const v3swap = (a0, a1, block) => ({ address: P3, topics: [SWAP_TOPICS.v3, ADDR, ADDR], data: '0x' + W(a0) + W(a1) + W(Q96) + W(10n ** 20n) + W(0), ...at(block) });
  const evs = eventsByPool([v3swap(E18, -2n * E18, 10), v3swap(-E18, 3n * E18, 11)]).get(P3);
  const st = { setting: 0, sqrtPriceX96: Q96 };
  const r = dayFees({ id: P3, v: 3, dex: 'uniswap', fee: 3000 }, evs, { start: st, end: st });
  assert.equal(r.kind, 'day');
  assert.equal(r.vq, Number((E18 + 3n * E18).toString()), 'token0 in 1e18 at price 1, token1 in 3e18');
  assert.equal(dayFees({ id: P3, v: 3, dex: 'uniswap', fee: 3000 }, [], { start: st, end: st }).vq, 0, 'read, no swaps: a real 0');
  // kept in snapshots.json sx beside the fees, and only where a day has it
  const c = emptyCache();
  c.p.set(P3, { c: 'ethereum', t: NOW, d: new Map([[TODAY - DAY, [r.q, r.px, r.vq]], [TODAY - 2 * DAY, [5, 1]]]), s0: null });
  const packed = JSON.parse(JSON.stringify(packSx(c, { now: NOW })));
  assert.deepEqual(packed.p[P3].v, [null, r.vq]);
  assert.deepEqual(unpackSx(packed).p.get(P3).d.get(TODAY - DAY), [r.q, r.px, r.vq]);
  assert.deepEqual(unpackSx(packed).p.get(P3).d.get(TODAY - 2 * DAY), [5, 1], 'a day read before the volume was summed: fees only');
  c.p.get(P3).d.delete(TODAY - DAY);
  assert.equal('v' in packSx(c, { now: NOW }).p[P3], false, 'no volume column when no day has one');
  // planted fault: volume from the output amounts → a different number, caught
  const outs = evs.reduce((a, e) => a + Number(e.amountOut), 0);
  assert.notEqual(outs, r.vq);
});

test('the public lines: counts and two ratios only; each check needs 20 days or pools with both', () => {
  const tot = { pools: 6, days: 1800, b: 900, r: 40, m: 10, gone: 500, goneV4: 365, goneReach: 135, open: 350, vs: 70, vg: 1700, vNull: 30, vx: [1, 1.02, 0.98], tl: [1, 1.1] };
  const { tvl, vol, tvlOk, volOk } = tvlLines(tot, { b: 36, r: 4, m: 1, unread: 2 });
  assert.equal(tvl, '950 pool-days of 1800 with a value (900 from balances at archive blocks, 40 recorded by the passes, 10 from liquidity maps), 500 not readable (365 v4 days before recording, 135 past Base\'s archive reach), 350 still to read; this pass +41 (36 balances, 4 recorded, 1 maps), 2 reads unread; yesterday ÷ the pool list\'s TVL median 1.05 over 2 pools');
  assert.equal(vol, '1770 pool-days of 1800 with a value (70 from swaps, 1700 from candles), 30 unread; swaps÷candle median 1.00 over 3 days');
  assert.ok(![tvl, vol].some((l) => /\$|0x[0-9a-f]{6,}/i.test(l)), 'no amounts, no addresses');
  assert.deepEqual([tvlOk, volOk], [null, null], 'under 20: no verdict');
  assert.equal(tvlLines({ ...tot, tl: Array(25).fill(1.04) }, { b: 0, r: 0, m: 0, unread: 0 }).tvlOk, true);
  assert.equal(tvlLines({ ...tot, tl: Array(25).fill(1.5) }, { b: 0, r: 0, m: 0, unread: 0 }).tvlOk, false, 'TVL half again the pool list\'s: fails');
  assert.equal(tvlLines({ ...tot, vx: Array(25).fill(0.5) }, { b: 0, r: 0, m: 0, unread: 0 }).volOk, false, 'swaps half the candle: fails');
});

// ---- size: a made-up 300-pool full year ------------------------------------------------------------------------

test('size: yv, yt and their progress add under 1.2 MB sealed to a made-up 300-pool full-year history.json', (t) => {
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const y0 = TODAY - 365 * DAY, without = {}, withNew = {};
  for (let p = 0; p < 300; p++) {
    const y = [], gt = { t: NOW, b: 0, days: new Map() }, tv = new Map(), sx = new Map();
    let lvl = 10 ** (5 + 3 * rnd()), vol = lvl * (0.05 + rnd()), px = PX;
    for (let k = 0; k < 365; k++) {
      const d = y0 + k * DAY;
      lvl *= Math.exp((rnd() - 0.5) * 0.08); vol = Math.max(0, vol * Math.exp((rnd() - 0.5) * 0.6)); px *= Math.exp((rnd() - 0.5) * 0.04);
      y.push([d, Number((vol * 0.0025).toPrecision(4)), k > 300 ? 's' : k > 200 ? 'x' : 'e']);
      gt.days.set(d, [vol, USD0 * (px / PX)]);
      const pxRaw = px * 10 ** (D1 - D0);
      tv.set(d, [Number(((lvl / 2 / USD1) * 1e6 * 2).toPrecision(6)), Number(pxRaw.toPrecision(6)), k > 330 ? 'r' : 'b']);
      if (k > 300) sx.set(d, [1, Number(pxRaw.toPrecision(6)), Number(((vol / USD1) * 1e6).toPrecision(6))]);
    }
    const r = volTvlYear({ y, gt, sx: { d: sx }, tv: { d: tv }, pool: POOL, now: NOW });
    const yp = { exact: 164, est: 201, age: 365, dyn: false, sw: 64 };
    without[p] = { y, yp };
    withNew[p] = { y, yp, yv: r.yv, yt: r.yt, yvp: r.yvp, ytp: r.ytp };
  }
  const aes = crypto.randomBytes(32);
  const size = (pools) => JSON.stringify(seal({ v: 1, t: NOW, pools }, aes)).length;
  const added = size(withNew) - size(without);
  t.diagnostic(`yv + yt + yvp + ytp add ${Math.round(added / 1024)} KB sealed for 300 pools × 365 days (${Math.round(added / 300)} bytes a pool); y + yp alone ${Math.round(size(without) / 1024)} KB`);
  assert.ok(added > 0 && added < 1.2 * 1024 * 1024, `${added} bytes`);
  // planted fault: rows that repeat each day's time (as y does) → well over the budget the parallel rows keep, caught
  const withT = Object.fromEntries(Object.entries(withNew).map(([k, e]) => [k, { ...e, yv: e.yv.map((x, i) => [e.y[i][0], ...x]), yt: e.yt.map((x, i) => [e.y[i][0], ...x]) }]));
  assert.ok(size(withT) - size(without) > added * 1.3);
});

// ---- isolation: the series never reach a window, the gem, a lens or the backtest --------------------------------

const SCORE_ROOTS = ['lib/windows.mjs', 'lib/gem.mjs', 'lib/score.mjs', 'lib/economics.mjs', 'lib/lenses.mjs', 'lib/flowq.mjs', 'lib/flow.mjs', 'lib/persistence.mjs', 'lib/pairs.mjs',
  'lib/checks.mjs', 'lib/shape.mjs', 'lib/cex.mjs', 'lib/backtest.mjs', 'lib/backtest-real.mjs', 'lib/backtest-run.mjs', 'lib/backtest-audit.mjs', 'scripts/backtest.mjs'];
// a scorer that could see the volume or TVL history: it imports the module, or reads its fields or its cache
const seesTvlHistory = (src) => /tvlhist|volTvlYear|\byt\b|\byv\b|\bytp\b|\byvp\b|tvCache|unpackTv|balanceCalls/.test(src);
// every module a scorer reaches through its imports, itself included
function closure(roots) {
  const seen = new Set(), todo = [...roots];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/^import[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) todo.push(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, f)), m[1])));
  }
  return [...seen];
}

test('isolation, statically: no window, gem, lens, score or backtest module (nor anything they import) can see the volume or TVL history', () => {
  const files = closure(SCORE_ROOTS);
  assert.ok(files.length > SCORE_ROOTS.length, 'their imports followed');
  for (const f of files) assert.equal(seesTvlHistory(fs.readFileSync(path.join(ROOT, f), 'utf8')), false, f);
  // planted leaks: the gem importing the module, or a lens reading yesterday's TVL row, caught
  const gem = fs.readFileSync(path.join(ROOT, 'lib/gem.mjs'), 'utf8'), lenses = fs.readFileSync(path.join(ROOT, 'lib/lenses.mjs'), 'utf8');
  assert.equal(seesTvlHistory(`import { volTvlYear } from './tvlhist.mjs';\n${gem}`), true);
  assert.equal(seesTvlHistory(lenses.replace('export function', 'const tvl = hist.yt.at(-1)[0];\nexport function')), true);
});

// The windows as the scan builds them, beside a pool's TVL history scaled by k. pool.tvlUsd is the pool list's own
// (p.tvl ?? p.mapUsd); leak feeds yesterday's TVL from the history into it instead (a planted fault).
function windowsBeside(k, { leak = false } = {}) {
  const rows = [];
  for (let h = 24 * 32; h >= 0; h--) {
    const t = NOW - h * HOUR;
    rows.push({ t, block: 20_000_000 - h * 300, sqrtPriceX96: SQRT, tick: 0, L: 10n ** 18n, fg0: BigInt(2 ** 40) * BigInt(24 * 32 - h + 1) * 10n ** 20n, fg1: BigInt(2 ** 40) * BigInt(24 * 32 - h + 1) * 10n ** 9n, parked: 0.3 });
  }
  const series = merge(emptySeries(), rows, { now: NOW });
  const tv = tvOf(Array.from({ length: 30 }, (_, i) => [TODAY - (i + 1) * DAY, [holdings(BAL, SQRT)[0] * k, holdings(BAL, SQRT)[1], 'b']]));
  const hist = volTvlYear({ y: yRows(TODAY - 30 * DAY), gt: gtOf({ vol: () => 1e5 * k }), tv, pool: POOL, now: NOW });
  const gemFlow = { markoutToFee: 0.1, traders7d: 280 };
  const pool = { feeTier: 0.003, lpKeeps: [0.75, 1], d0: D0, d1: D1, usd0: USD0, usd1: USD1, tvlUsd: leak ? hist.last : 4e5, gasUsd: 6,
    flow: { '24h': { swaps: 120, traders: 40, markout: 0.1, topTxShare: 0.05 }, '7d': { gemFlow }, '30d': { gemFlow } } };
  return { w: allWindows({ series, cur: series.h.at(-1), pool, config: { ticket: 1000, holdDays: { ethereum: 14 }, toxicMarkout: 0.6, minPairAgeDays: 180, windows: ['24h', '7d', '30d'] }, chain: 'ethereum' }), hist };
}

test('isolation, by taint: the windows, the gem and the lenses are identical whatever the TVL and volume history say; a planted leak is caught', () => {
  const a = windowsBeside(1), b = windowsBeside(1000);
  assert.notDeepEqual(a.hist.yt, b.hist.yt, 'the history did change');
  assert.notDeepEqual(a.hist.yv, b.hist.yv);
  assert.ok(Number.isFinite(a.w['24h']?.lpFeesUsd) && a.w['24h'].lpFeesUsd > 0 && a.w['24h'].aggApr != null, 'the windows ran');
  assert.deepEqual(a.w, b.w, 'nothing the windows, the gem or the lenses give moved');
  // planted leak: yesterday's TVL from the history fed into the windows' tvlUsd → aggApr moves with it, caught
  const l = [1, 1000].map((k) => windowsBeside(k, { leak: true }).w);
  assert.notDeepEqual(l[0]['24h'].aggApr, l[1]['24h'].aggApr, 'leak caught');
});
