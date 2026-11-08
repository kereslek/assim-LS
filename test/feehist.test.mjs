// The fee history (lib/feehist.mjs) on a made-up pool (MOCKUP · MADE-UP NUMBERS): exact days from the fee
// counters, estimated days from made-up GeckoTerminal candles, exact overriding, no row before the pool existed,
// the candle cache reused and never refetched, the per-pass caps, the deep backfill resuming pass after pass back
// to the pool's creation, and the isolation: estimates never reach the windows, the gem, the backtest or a score.
// Each check also runs against a planted fault and must catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUR, DAY, merge, emptySeries, serializeStore, parseStore } from '../lib/snapshots.mjs';
import { BACKFILL, planBackfill, blockClock } from '../lib/backfill.mjs';
import { allWindows, PARTS } from '../lib/windows.mjs';
import { median as gemMedian } from '../lib/gem.mjs';
import { makeBudget } from '../lib/budget.mjs';
import { FEEHIST, DEEP_RANK, windowSeries, dayRows, exactDay, deepMoments, foldDeep, gtUrl, parseOhlcv, baseSide, gtNeed, fetchVolumes, packGt, unpackGt, feeYear, median } from '../lib/feehist.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = Date.UTC(2026, 10, 8, 12, 40);
const TODAY = Math.floor(NOW / DAY) * DAY;
const D0 = 18, D1 = 6, USD0 = 2.5, USD1 = 1, PX = 2.5; // token0 $2.50, token1 $1 (6 decimals): 2.5 token1 per token0
const SQRT = BigInt(Math.round(Math.sqrt(PX * 10 ** (D1 - D0)) * 2 ** 96));
const L = 10n ** 18n;
const RATE = 0.003 * 0.75;
const POOL = { d0: D0, d1: D1, rate: RATE, dyn: false, usd0: USD0, usd1: USD1, pxNow: PX, createdAt: null };
const WETH = '0x' + 'e'.repeat(39) + 'f', T0 = '0x' + '1'.repeat(40), T1 = '0x' + '2'.repeat(40), ZERO = '0x' + '0'.repeat(40);

// A made-up chain: the pool exists from `born`; LP fees accrue at `perDay` USD a day, half in each token; the
// counters move exactly as a pool's do (raw LP fee × 2^128 ÷ liquidity).
function chain({ born = -Infinity, perDay = (d) => 1000 + 10 * (d % 7) } = {}) {
  const fgAt = (t) => {
    let u0 = 0, u1 = 0;
    const start = Math.max(Math.floor(Math.max(born, NOW - 500 * DAY) / DAY), Math.floor((NOW - 500 * DAY) / DAY));
    for (let d = start; d * DAY < t; d++) {
      const a = Math.max(d * DAY, born), b = Math.min((d + 1) * DAY, t);
      if (b <= a) continue;
      const share = (b - a) / DAY;
      u0 += (perDay(d) / 2) * share; u1 += (perDay(d) / 2) * share;
    }
    const raw0 = BigInt(Math.round((u0 / USD0) * 1e6)) * 10n ** 12n, raw1 = BigInt(Math.round((u1 / USD1) * 1e6));
    return [(raw0 << 128n) / L, (raw1 << 128n) / L];
  };
  const read = (T) => {
    if (T < born) return { kind: 'unborn' };
    const [fg0, fg1] = fgAt(T);
    return { kind: 'row', row: { t: T, block: 20_000_000 + Math.round((T - NOW) / 12e3), sqrtPriceX96: SQRT, tick: 0, L, fg0, fg1, parked: null } };
  };
  return { read, fgAt, perDay };
}
// The tiers a pool that has been watched for `watched` days holds: a row 5 minutes past each UTC hour (14 days) and
// day (90 days), from its creation on.
function watchedSeries(c, { watched = 90, born = -Infinity, misaligned = [] } = {}) {
  const rows = [];
  // the daily backfill's own read that found the pool not there yet (its nb), when it was born inside the tier
  const nbAt = Number.isFinite(born) ? Math.floor(born / DAY) * DAY + BACKFILL.at - (Math.floor(born / DAY) * DAY + BACKFILL.at < born ? 0 : DAY) : null;
  for (let t = Math.floor((NOW - Math.min(watched, 14) * DAY) / HOUR) * HOUR + BACKFILL.at; t < NOW; t += HOUR) if (t >= born) rows.push(c.read(t).row);
  for (let d = Math.floor((NOW - watched * DAY) / DAY); d * DAY < NOW; d++) {
    const t = d * DAY + (misaligned.includes(d) ? 13 * HOUR : BACKFILL.at);
    if (t >= born && t < NOW) rows.push(c.read(t).row);
  }
  rows.push(c.read(NOW).row);
  return merge(emptySeries(), rows, { now: NOW, unborn: nbAt != null && nbAt > NOW - watched * DAY ? nbAt : null });
}
// One pass of the deep backfill as the scan runs it: the deep moments, read, merged, folded.
function deepPass(series, c, { now = NOW, notBefore = null, perPool = FEEHIST.deep.perPool } = {}) {
  const ms = deepMoments(series, { now, notBefore, perPool });
  const got = [], asked = [...ms.keys()];
  let unborn = null;
  for (const T of asked) { const r = c.read(T); if (r.kind === 'row') got.push(r.row); else unborn = Math.max(unborn ?? 0, T); }
  const next = merge(series, got, { now });
  const y = foldDeep(next, [...series.h, ...series.d, ...got], { now, unborn, notBefore });
  if (y) next.y = y; else delete next.y;
  return { series: next, asked };
}
const candles = (days, { vol = (d) => (1000 + 10 * (d % 7)) / RATE, close = () => USD0, from = TODAY - 400 * DAY } = {}) => {
  const list = [];
  for (let t = TODAY; t >= from; t -= DAY) list.push([t / 1000, 1, 1, 1, close(t / DAY), vol(t / DAY)]);
  return { data: { attributes: { ohlcv_list: list.slice(0, days) } }, meta: { base: { address: T0 }, quote: { address: T1 } } };
};
const gtEntry = (json, side = 0, now = NOW) => { const got = parseOhlcv(json), days = new Map(); for (const [d, v] of got.days) if (d < TODAY) days.set(d, v); return { t: now, b: side, days }; };

test('an exact day is Δ fee growth × liquidity over 20-28 hours, scaled to 24 h; anything else is not a day', () => {
  const c = chain();
  const a = c.read(TODAY - 3 * DAY + BACKFILL.at).row, b = c.read(TODAY - 2 * DAY + BACKFILL.at).row;
  const [q, px] = exactDay(a, b);
  const d = (TODAY - 3 * DAY) / DAY, usd = (q / 1e6) * USD1; // q in token1 raw units
  assert.ok(Math.abs(usd / c.perDay(d) - 1) < 1e-3, `${usd} vs ${c.perDay(d)}`);
  assert.ok(Math.abs(px * 10 ** (D0 - D1) / PX - 1) < 1e-6);
  // planted faults: rows 13 hours apart, 37 hours apart, a counter that went back, an unread counter
  const c13 = c.read(TODAY - 3 * DAY + 13 * HOUR).row;
  assert.equal(exactDay(c13, b), null);
  assert.equal(exactDay(a, c.read(TODAY - DAY + 13 * HOUR).row), null);
  assert.equal(exactDay(b, { ...a, t: b.t + DAY }), null);
  assert.equal(exactDay(a, { ...b, fg0: null }), null);
  // a day with no swaps is a real 0
  assert.deepEqual(exactDay(a, { ...b, fg0: a.fg0, fg1: a.fg1 })[0], 0);
});

test('exact overrides estimated; estimated = volume × fee tier × the LP share; a day with neither is null; valued at the day\'s prices', () => {
  const c = chain(), series = watchedSeries(c, { watched: 30 });
  const gt = gtEntry(candles(366, { close: (d) => USD0 * (1 + (d % 3) / 10) }));
  const { y, yp, xc } = feeYear({ series, gt, pool: POOL, now: NOW });
  assert.equal(y.length, 365, 'a year of completed days');
  assert.equal(y[0][0], TODAY - 365 * DAY);
  assert.equal(y.at(-1)[0], TODAY - DAY, 'yesterday is the last row; today is not complete');
  assert.ok(y.every((r, i) => i === 0 || r[0] - y[i - 1][0] === DAY), 'one row a day');
  const xs = y.filter((r) => r[2] === 'x'), es = y.filter((r) => r[2] === 'e');
  assert.equal(xs.length, 30, 'the 30 watched days are exact');
  assert.ok(xs.every((r) => r[0] >= TODAY - 30 * DAY), 'only where the counters were read');
  assert.equal(es.length, 335);
  // estimated = the candle's volume × fee tier × LP share (the made-up volume is set so the fees come to perDay)
  for (const [t, f] of es.slice(0, 20)) assert.ok(Math.abs(f / c.perDay(t / DAY) - 1) < 1e-3, `${t}: ${f}`);
  // exact days at that day's prices: token1's price from the close of token0 (GeckoTerminal's base) and the pool's price
  for (const [t, f] of xs) { const k = 1 + (t / DAY % 3) / 10; assert.ok(Math.abs(f / (c.perDay(t / DAY) * k) - 1) < 2e-3, `${t}: ${f} vs ${c.perDay(t / DAY) * k}`); }
  assert.deepEqual(yp, { exact: 30, est: 335, age: 365, dyn: false });
  // the sanity ratio: estimated ÷ exact on days with both (the made-up close moves, so it is the close's factor back)
  assert.equal(xc.length, 30);
  // planted fault: the estimate allowed to override an exact day → a different row, caught
  const leaky = y.map((r) => { const g = gt.days.get(r[0]); return r[2] === 'x' && g ? [r[0], Number((g[0] * RATE).toPrecision(4)), 'e'] : r; });
  assert.notDeepEqual(leaky, y);
  assert.ok(y.filter((r) => r[2] === 'x').every((r) => r[0] >= TODAY - 30 * DAY));
  // a day neither read nor on GeckoTerminal is null, never 0
  const gap = gtEntry(candles(366)); gap.days.delete(TODAY - 100 * DAY);
  const r100 = feeYear({ series, gt: gap, pool: POOL, now: NOW }).y.find((r) => r[0] === TODAY - 100 * DAY);
  assert.deepEqual(r100, [TODAY - 100 * DAY, null, null]);
  // no candle near an exact day: today's prices (token1 at $1 here)
  const noClose = feeYear({ series, gt: null, pool: POOL, now: NOW }).y.filter((r) => r[2] === 'x');
  for (const [t, f] of noClose) assert.ok(Math.abs(f / c.perDay(t / DAY) - 1) < 2e-3);
});

test('the sanity ratio: estimated ÷ exact near 1 when they agree; dynamic-fee pools and tiny days left out', () => {
  const c = chain(), series = watchedSeries(c, { watched: 60 });
  const gt = gtEntry(candles(366));
  const { xc } = feeYear({ series, gt, pool: POOL, now: NOW });
  assert.ok(xc.length >= 59 && Math.abs(median(xc) - 1) < 0.01, `median ${median(xc)} over ${xc.length}`);
  assert.equal(feeYear({ series, gt, pool: { ...POOL, dyn: true }, now: NOW }).xc.length, 0, 'a dynamic fee: the estimate uses the current lpFee, kept out of the ratio');
  assert.equal(feeYear({ series, gt, pool: { ...POOL, dyn: true }, now: NOW }).yp.dyn, true);
  const tiny = chain({ perDay: () => 5 }), ts = watchedSeries(tiny, { watched: 20 });
  assert.equal(feeYear({ series: ts, gt, pool: POOL, now: NOW }).xc.length, 0, 'exact days under $10 are noise');
  // planted fault: a fee tier read twice too high → the ratio says so
  assert.ok(median(feeYear({ series, gt, pool: { ...POOL, rate: RATE * 2 }, now: NOW }).xc) > 1.9);
});

test('a day before the pool existed has no row: creation event, a read that found it not there, planted candles from before', () => {
  const born = TODAY - 40 * DAY + 7 * HOUR, c = chain({ born });
  const series = watchedSeries(c, { watched: 90, born });
  const gt = gtEntry(candles(366)); // planted: candles for days the pool did not exist
  const { y, yp } = feeYear({ series, gt, pool: { ...POOL, createdAt: born }, now: NOW });
  assert.equal(y[0][0], TODAY - 40 * DAY, 'the first row is the creation day');
  assert.equal(y.length, 40);
  assert.equal(yp.age, 40);
  assert.equal(y[0][2], 'e', 'the creation day itself is partial: estimated');
  assert.ok(y.slice(1).every((r) => r[2] === 'x'), 'every full day after it is exact');
  // without a creation event, inside the daily tier: the daily backfill's read that found it not there (nb)
  const nbOnly = feeYear({ series, gt, pool: POOL, now: NOW });
  assert.equal(nbOnly.y[0][0], TODAY - 40 * DAY);
  assert.equal(nbOnly.yp.age, 40);
  // older than the tier, no creation event: the deep backfill's own read that found it not there sets the start
  const born2 = TODAY - 120 * DAY + 7 * HOUR, c2 = chain({ born: born2 });
  let s = watchedSeries(c2, { watched: 90, born: born2 });
  for (let k = 0; k < 5; k++) s = deepPass(s, c2).series;
  assert.ok(s.y.nb >= born2 - DAY && s.y.nb < born2, 'nb is the last moment it was not there');
  const z = feeYear({ series: s, gt, pool: POOL, now: NOW });
  assert.equal(z.y[0][0], TODAY - 120 * DAY, `starts ${(TODAY - z.y[0][0]) / DAY} days back`);
  assert.ok(z.y.every((r) => r[0] + DAY > s.y.nb), 'no day that ended before the pool existed');
  assert.equal(z.yp.exact, 119);
  // planted fault: forget both the creation event and the read that found the pool not there → the planted
  // candles become rows before the pool existed, caught
  const leaky = feeYear({ series: { ...series, nb: undefined }, gt, pool: POOL, now: NOW });
  assert.ok(leaky.y[0][0] < born - DAY);
});

test('the deep backfill resumes pass after pass back to the creation (365 days at most), never asks before it, and keeps little raw', () => {
  const born = TODAY - 200 * DAY + 3 * HOUR, c = chain({ born });
  let s = watchedSeries(c, { watched: 90, born });
  const asked = [];
  for (let k = 0; k < 15; k++) { const r = deepPass(s, c, { notBefore: born }); s = r.series; asked.push(...r.asked); }
  assert.ok(asked.every((T) => T >= born), 'nothing asked before the creation event');
  assert.equal(new Set(asked).size, asked.length, 'each day asked once');
  const { y, yp } = feeYear({ series: s, gt: null, pool: { ...POOL, createdAt: born }, now: NOW });
  assert.equal(yp.age, 200);
  assert.equal(yp.exact, 199, 'every full day exact; the creation day (from 03:00) has no 00:05 row');
  assert.ok(s.y.r.length <= 2, `raw rows kept ${s.y.r.length}`);
  assert.equal(deepMoments(s, { now: NOW, notBefore: born }).size, 0, 'done: nothing more is asked');
  for (const [t, f] of y.filter((r) => r[2] === 'x')) assert.ok(Math.abs(f / c.perDay(t / DAY) - 1) < 2e-3, `${t}`);
  // an old pool stops at 365 days
  const old = chain();
  let o = watchedSeries(old, { watched: 90 });
  for (let k = 0; k < 40; k++) o = deepPass(o, old).series;
  assert.equal(feeYear({ series: o, gt: null, pool: POOL, now: NOW }).yp.exact, 365);
  assert.ok([...o.y.f.keys()].every((d) => d >= TODAY - 365 * DAY));
  // the deep record survives the store's serialisation, and the windows' tiers are unchanged by it
  const back = parseStore(JSON.parse(JSON.stringify(serializeStore(new Map([['p', o]]))))).get('p');
  assert.equal(back.y.f.size, o.y.f.size);
  const sorted = (f) => [...f.entries()].sort((a, b) => a[0] - b[0]);
  assert.deepEqual(sorted(back.y.f), sorted(o.y.f));
  assert.equal(back.d.length, o.d.length);
  // carried through a later merge (a new pass row), and a later pass still sees every day
  const later = merge(back, [old.read(NOW + HOUR).row], { now: NOW + HOUR });
  assert.equal(later.y.f.size, o.y.f.size);
});

test('a day whose only row is far from its start is read again at 00:05; the moments the daily backfill asks are left to it', () => {
  const c = chain(), mis = [Math.floor(NOW / DAY) - 50, Math.floor(NOW / DAY) - 51];
  const s = watchedSeries(c, { watched: 90, misaligned: mis });
  const ms = deepMoments(s, { now: NOW, perPool: 30 });
  for (const d of mis) assert.ok(ms.has(d * DAY + BACKFILL.at), `day ${d} asked at 00:05`);
  // a day missing from the daily tier is the daily backfill's (its rank), never asked twice
  const holed = merge(emptySeries(), [...s.h, ...s.d.filter((r) => Math.floor(r.t / DAY) !== Math.floor(NOW / DAY) - 60)], { now: NOW });
  assert.ok(!deepMoments(holed, { now: NOW, perPool: 400 }).has((Math.floor(NOW / DAY) - 60) * DAY + BACKFILL.at));
  // fixed after one pass
  let x = s;
  x = deepPass(x, c, { perPool: 30 }).series;
  const days = feeYear({ series: x, gt: null, pool: POOL, now: NOW }).y.filter((r) => r[2] === 'x').map((r) => r[0] / DAY);
  for (const d of [...mis, mis[1] - 1]) assert.ok(days.includes(d), `day ${d} exact after the read`);
});

test('caps: the deep backfill plans at most its batches and days a pool; GeckoTerminal at most its calls, paced', async () => {
  const c = chain(), s = watchedSeries(c, { watched: 90 });
  assert.equal(deepMoments(s, { now: NOW, perPool: 4 }).size, 4);
  assert.ok([...deepMoments(s, { now: NOW, perPool: 4 }).keys()].every((T, i, a) => i === 0 || T < a[i - 1]), 'newest first');
  const pools = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, calls: 100, series: s, notBefore: null }));
  const clock = blockClock([{ t: NOW, block: 20_000_000 }]);
  const deep = planBackfill(pools, { now: NOW, clock, block: 20_000_000, maxBatches: 7, momentsOf: (x, o) => deepMoments(x, { ...o, perPool: 10 }) });
  assert.equal(deep.jobs.length, 7);
  assert.ok(deep.jobs.every((j) => j.rank === DEEP_RANK && j.ids.length <= 2), 'at most 250 calls a batch');
  // GeckoTerminal: 3 calls allowed of 10 pools wanted, 2.4 s apart (the pause is asked for, not waited here)
  let calls = 0;
  const waits = [];
  let t = 0;
  const getJson = async () => { calls++; return candles(366); };
  const cache = new Map();
  const st = await fetchVolumes(getJson, Array.from({ length: 10 }, (_, i) => ({ id: 'g' + i, network: 'eth', t0: T0, t1: T1, tvl: i })), { cache, now: NOW, budget: makeBudget({ calls: 3 }), spacingMs: 2400, pause: async (ms) => { waits.push(ms); t += ms; }, clock: () => t });
  assert.equal(calls, 3);
  assert.equal(st.calls, 3);
  assert.equal(st.stopped, 'calls');
  assert.deepEqual(waits, [2400, 2400]);
  assert.deepEqual([...cache.keys()], ['g9', 'g8', 'g7'], 'the largest pools first');
  // planted fault: no budget → every pool asked in one pass, caught by the same count
  calls = 0;
  await fetchVolumes(getJson, Array.from({ length: 10 }, (_, i) => ({ id: 'h' + i, network: 'eth', t0: T0, t1: T1 })), { cache: new Map(), now: NOW, spacingMs: 0, pause: async () => {} });
  assert.notEqual(calls, 3);
});

test('the GeckoTerminal cache is reused: fetched once, then only the newest days once a UTC day; unknown pools wait a week', async () => {
  const urls = [];
  const getJson = async (u) => { urls.push(u); if (u.includes('/pools/unknown/')) throw new Error('HTTP 404'); return candles(Number(/limit=(\d+)/.exec(u)[1])); };
  const pools = [{ id: '0x' + 'a'.repeat(40), network: 'eth', t0: T0, t1: T1, tvl: 2 }, { id: 'unknown', network: 'base', t0: T0, t1: T1, tvl: 1 }];
  const run = (cache, now) => fetchVolumes(getJson, pools, { cache, now, spacingMs: 0, pause: async () => {} });
  let cache = new Map();
  let st = await run(cache, NOW);
  assert.deepEqual([st.full, st.missed, st.calls], [1, 1, 2]);
  assert.equal(urls[0], gtUrl('eth', pools[0].id, 366));
  assert.equal(urls[0], 'https://api.geckoterminal.com/api/v2/networks/eth/pools/' + pools[0].id + '/ohlcv/day?aggregate=1&limit=366&currency=usd');
  const e = cache.get(pools[0].id);
  assert.ok(!e.days.has(TODAY), 'today\'s partial candle is not kept');
  assert.equal(e.days.size, 365, 'the year of completed days');
  assert.equal(e.b, 0);
  // the next passes the same day: nothing asked; the cache goes through snapshots.json and back
  cache = unpackGt(JSON.parse(JSON.stringify(packGt(cache, { now: NOW }))));
  assert.equal(cache.get(pools[0].id).days.size, 365);
  urls.length = 0;
  st = await run(cache, NOW + 2 * HOUR);
  assert.equal(urls.length, 0, 'reused, not refetched');
  // the next UTC day: not before 00:30 (yesterday's candle closes), then the newest two days only (the last held, again)
  st = await run(cache, TODAY + DAY + 10 * 60e3);
  assert.equal(urls.length, 0);
  st = await run(cache, TODAY + DAY + 40 * 60e3);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /limit=3&/, 'today (dropped), yesterday and the last day held');
  assert.equal(st.fresh, 1);
  st = await run(cache, TODAY + DAY + 5 * HOUR);
  assert.equal(urls.length, 1, 'once a day');
  // the unknown pool is asked again only after a week
  urls.length = 0;
  await run(cache, NOW + 8 * DAY);
  assert.ok(urls.some((u) => u.includes('/pools/unknown/')));
  // a pool with candles that answers 404 on its top-up waits for the next day, not the next pass
  const gone = new Map([['g', { t: TODAY - DAY + HOUR, b: 0, days: new Map([[TODAY - 2 * DAY, [1, 1]]]) }]]);
  let n404 = 0;
  const g404 = async () => { n404++; throw new Error('HTTP 404'); };
  for (const t of [NOW, NOW + HOUR, NOW + 2 * HOUR]) await fetchVolumes(g404, [{ id: 'g', network: 'eth' }], { cache: gone, now: t, spacingMs: 0, pause: async () => {} });
  assert.equal(n404, 1);
  assert.equal(gone.get('g').days.size, 1, 'its candles kept');
  // planted fault: a cache that loses its entries refetches the full year, caught
  urls.length = 0;
  await run(new Map(), NOW + 2 * HOUR);
  assert.ok(urls.some((u) => /limit=366/.test(u)));
});

test('GeckoTerminal: candles parsed, today dropped, base side found (native ETH as WETH); stops on a 429 or an unreachable host', async () => {
  const got = parseOhlcv(candles(5));
  assert.equal(got.days.size, 5);
  assert.deepEqual(got.days.get(TODAY - DAY), [(1000 + 10 * (((TODAY - DAY) / DAY) % 7)) / RATE, USD0]);
  assert.equal(parseOhlcv({ data: {} }), null);
  assert.deepEqual(parseOhlcv({ data: { attributes: { ohlcv_list: [[TODAY / 1000, 1, 1, 1, 'x', -5]] } } }).days.get(TODAY), [null, null], 'a bad value is null, never 0');
  assert.equal(baseSide(T0, T0, T1), 0);
  assert.equal(baseSide(T1, T0, T1), 1);
  assert.equal(baseSide(WETH, ZERO, T1, WETH), 0, 'a v4 pool of native ETH listed with WETH');
  assert.equal(baseSide('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ZERO, T1, WETH), 0);
  assert.equal(baseSide(WETH, T0, T1, WETH), null);
  const pools = Array.from({ length: 5 }, (_, i) => ({ id: 'q' + i, network: 'eth', t0: T0, t1: T1 }));
  for (const [err, why, calls] of [['HTTP 429', 'rate limit', 2], ['fetch failed', 'unreachable', 1]]) {
    let n = 0;
    const waits = [];
    const st = await fetchVolumes(async () => { n++; throw new Error(err); }, pools, { cache: new Map(), now: NOW, spacingMs: 0, pause: async (ms) => { waits.push(ms); } });
    assert.equal(n, calls, why);
    assert.equal(st.stopped, why);
    if (calls === 2) assert.deepEqual(waits, [FEEHIST.gt.backoffMs], 'one wait on the first 429, then the same pool again');
  }
  // a 429 then answers: the wait pays off and the pass goes on
  let k = 0;
  const once = await fetchVolumes(async () => { if (k++ === 1) throw new Error('HTTP 429'); return candles(366); }, pools, { cache: new Map(), now: NOW, spacingMs: 0, pause: async () => {} });
  assert.deepEqual([once.full, once.stopped, once.calls], [5, null, 6]);
  // no room left in the time budget for the wait: stop at once
  let m = 0;
  const tight = await fetchVolumes(async () => { m++; throw new Error('HTTP 429'); }, pools, { cache: new Map(), now: NOW, budget: makeBudget({ ms: 5000 }), spacingMs: 0, pause: async () => {} });
  assert.deepEqual([m, tight.stopped], [1, 'rate limit']);
  let n = 0;
  const st = await fetchVolumes(async () => { n++; throw new Error('HTTP 502'); }, pools, { cache: new Map(), now: NOW, spacingMs: 0, pause: async () => {} });
  assert.equal(n, FEEHIST.gt.stopAfter);
  assert.equal(st.stopped, 'errors');
  assert.ok(gtNeed(null, { now: NOW }).kind === 'full');
});

// ---- isolation: the estimates never reach the windows, the gem, the backtest or a score ----------------------

const SCORERS = ['lib/windows.mjs', 'lib/gem.mjs', 'lib/score.mjs', 'lib/economics.mjs', 'lib/lenses.mjs', 'lib/flowq.mjs', 'lib/flow.mjs', 'lib/persistence.mjs', 'lib/pairs.mjs',
  'lib/checks.mjs', 'lib/shape.mjs', 'lib/cex.mjs', 'lib/backtest.mjs', 'lib/backtest-real.mjs', 'lib/backtest-run.mjs', 'lib/backtest-audit.mjs', 'scripts/backtest.mjs'];
// a scorer that could see the fee history: it imports the module, reads GeckoTerminal's candles, or a series' deep record
const seesFeeHistory = (src) => /feehist|ohlcv|geckoterminal|feeYear|\.y\.f\b|\.y\?\.f\b|\byp\b/.test(src);

test('isolation, statically: no window, gem, score or backtest module can see the fee history', () => {
  for (const f of SCORERS) assert.equal(seesFeeHistory(fs.readFileSync(path.join(ROOT, f), 'utf8')), false, f);
  // planted fault: the gem importing the fee history is caught
  const gem = fs.readFileSync(path.join(ROOT, 'lib/gem.mjs'), 'utf8');
  assert.equal(seesFeeHistory(`import { feeYear } from './feehist.mjs';\n${gem}`), true);
  assert.equal(seesFeeHistory(gem.replace('export function', 'const est = series.y.f;\nexport function')), true);
});

// The windows, as the scan builds them: a pool's series after the pass (its deep record attached), the estimates
// in the cache beside it. k scales every estimate and every deep day: an output that moves with k saw them.
function scanWindows(k, { strip = windowSeries, parts = () => PARTS } = {}) {
  const c = chain(), series = watchedSeries(c, { watched: 35 });
  for (let i = 0; i < 4; i++) Object.assign(series, { y: deepPass(series, c).series.y });
  series.y = { ...series.y, f: new Map([...series.y.f].map(([d, [q, px]]) => [d, [q * k, px]])) };
  const gt = gtEntry(candles(366, { vol: (d) => k * 1e9 + d }));
  const fy = feeYear({ series, gt, pool: POOL, now: NOW });
  const cur = series.h.at(-1);
  const gemFlow = { markoutToFee: 0.1, traders7d: 280 };
  const pool = { feeTier: 0.003, lpKeeps: [0.75, 1], d0: D0, d1: D1, usd0: USD0, usd1: USD1, tvlUsd: 4e5, gasUsd: 6, est: fy.y, gt,
    flow: { '24h': { swaps: 120, traders: 40, markout: 0.1, topTxShare: 0.05 }, '7d': { gemFlow }, '30d': { gemFlow } } };
  return { w: allWindows({ series: strip(series), cur, pool, config: { ticket: 1000, holdDays: { ethereum: 14 }, toxicMarkout: 0.6, minPairAgeDays: 180, windows: ['24h', '7d', '30d'] }, chain: 'ethereum' }, { parts: parts(fy) }), fy };
}

test('isolation, by taint: the windows and the gem are identical whatever the estimates say; planted leaks are caught', () => {
  const a = scanWindows(1), b = scanWindows(1000);
  assert.notDeepEqual(a.fy.y, b.fy.y, 'the estimates did change');
  assert.ok(Number.isFinite(a.w['24h']?.gem?.total) && Number.isFinite(a.w['30d']?.gem?.total) && a.w['24h'].lpFeesUsd > 0, 'the windows and the gem ran');
  assert.deepEqual(a.w, b.w, 'nothing the windows, the gem or the lenses give moved');
  // planted leak 1: the series passed whole and a window part that reads the deep record → caught
  // (it rebuilds the daily tier's counters from the deep record's days: a "fill from the long history" change)
  const leakyView = (series, now, W) => {
    const v = PARTS.view(series, now, W), last = v.d.at(-1), rows = [last];
    let acc = last.fg1;
    for (const [d, [q]] of [...(series.y?.f || [])].filter(([d]) => d >= now - 31 * DAY && d + BACKFILL.at < last.t).sort((a, b) => b[0] - a[0])) {
      acc -= (BigInt(Math.round(q)) << 128n) / last.L;
      rows.unshift({ ...last, t: d + BACKFILL.at, fg1: acc });
    }
    return { ...v, d: rows };
  };
  const l1 = [1, 1000].map((k) => scanWindows(k, { strip: (s) => s, parts: () => ({ ...PARTS, view: leakyView }) }).w);
  assert.notDeepEqual(l1[0], l1[1], 'leak through the series caught');
  // planted leak 2: the gem's typical day taken from the estimated rows (scaled to a day's net per $1,000) → caught
  const leakyTypical = (fy) => ({ ...PARTS, typical: () => gemMedian(fy.y.filter((r) => r[2] === 'e').slice(-7).map((r) => r[1])) * 1e-7 });
  const l2 = [1, 1000].map((k) => scanWindows(k, { parts: leakyTypical }).w);
  assert.notDeepEqual(l2[0]['24h']?.gem, l2[1]['24h']?.gem, 'leak into the gem caught');
  // and the production strip: the windows are given no deep record
  assert.equal('y' in windowSeries({ h: [], d: [], y: { f: new Map(), r: [], nb: null } }), false);
});

test('dayRows keeps fee-read rows only, the earliest of each day', () => {
  const c = chain();
  const r1 = c.read(TODAY - DAY + 2 * HOUR).row, r2 = c.read(TODAY - DAY + BACKFILL.at).row;
  const m = dayRows([r1, r2, { ...r2, t: TODAY - DAY + 60e3, fg0: null }]);
  assert.equal(m.get(Math.floor((TODAY - DAY) / DAY)).t, r2.t);
});
