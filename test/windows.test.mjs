// Window metrics (lib/windows.mjs) on made-up pools built by a tiny simulator: swaps move the fee-growth
// counters exactly as a pool does (LP fee × 2^128 ÷ active liquidity), passes snapshot the state, and the
// swap list is the independent answer. Cases: a cross-check against the swap list, a sole LP, a flat
// price, a one-way move, a pool born mid-window, fee growth wrapping past 2^256, unread rows, missing
// inputs. Each check also runs against a planted fault and must catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, DAY, merge, emptySeries, rowsIn } from '../lib/snapshots.mjs';
import { windowMetrics, allWindows, sigmaOf, PARTS, windowMs } from '../lib/windows.mjs';
import { valueInRange, ticksForLog } from '../lib/v3math.mjs';

// ---- a made-up pool -------------------------------------------------------------------------------
const D0 = 18, D1 = 6, USD0 = 2.5, USD1 = 1;            // token0 18 decimals at $2.50, token1 6 decimals at $1
const KEEP_BP = [7500n, 10000n];                         // LPs keep 75% of token0-side fees, all of token1-side
const POOL = { feeTier: 0.003, lpKeeps: [0.75, 1], d0: D0, d1: D1, usd0: USD0, usd1: USD1, tvlUsd: 400000, gasUsd: 6 };
const CONFIG = { ticket: 1000, holdDays: { ethereum: 14 }, toxicMarkout: 0.6, minPairAgeDays: 180, windows: ['24h', '7d', '30d'] };
const NOW = Date.UTC(2026, 9, 31, 12, 40);
const TWO256 = 1n << 256n;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sqrtX96 = (p) => BigInt(Math.round(Math.sqrt(p * 10 ** (D1 - D0)) * 2 ** 96));
const tickOf = (p) => Math.floor(Math.log(p * 10 ** (D1 - D0)) / Math.log(1.0001));

// Swaps at random times; a pass every passMin minutes from `from` to `now` (the last one at now).
function simulate({ now = NOW, from, passMin = 6, price = () => 2.5, L = () => 10n ** 18n, swapsPerHour = 10, side0 = 0.5, seed = 7,
  fgStart = [7n << 128n, 3n << 128n], parked = () => 0.3 } = {}) {
  const rnd = mulberry32(seed), ev = [];
  const n = Math.round(((now - from) / HOUR) * swapsPerHour);
  for (let i = 0; i < n; i++) ev.push({ t: from + 1 + rnd() * (now - from - 2), side: rnd() < side0 ? 0 : 1, usd: 200 + rnd() * 9800 });
  for (let t = from; t < now; t += passMin * 60e3) ev.push({ t, pass: true });
  ev.push({ t: now, pass: true });
  ev.sort((a, b) => a.t - b.t);
  const fg = [...fgStart], rows = [], swaps = [];
  for (const e of ev) {
    if (e.pass) {
      const p = price(e.t);
      rows.push({ t: e.t, block: 20_000_000 + Math.floor((e.t - from) / 12e3), sqrtPriceX96: sqrtX96(p), tick: tickOf(p), L: L(e.t), fg0: fg[0], fg1: fg[1], parked: parked(e.t) });
      continue;
    }
    const d = e.side === 0 ? D0 : D1, u = e.side === 0 ? USD0 : USD1;
    const amountIn = BigInt(Math.round((e.usd / u) * 10 ** Math.min(d, 15))) * 10n ** BigInt(Math.max(0, d - 15));
    const total = (amountIn * 3000n) / 1000000n, lp = (total * KEEP_BP[e.side]) / 10000n;
    fg[e.side] = BigInt.asUintN(256, fg[e.side] + (lp << 128n) / L(e.t));
    swaps.push({ t: e.t, side: e.side, amountIn, lp, proto: total - lp });
  }
  return { rows, cur: rows.at(-1), swaps, series: merge(emptySeries(), rows, { now }) };
}
const usdRaw = (a, side) => (Number(a) / 10 ** (side === 0 ? D0 : D1)) * (side === 0 ? USD0 : USD1);
function truth(swaps, from, to) {
  const s = swaps.filter((x) => x.t > from && x.t <= to);
  return { lp: s.reduce((a, x) => a + usdRaw(x.lp, x.side), 0), vol: s.reduce((a, x) => a + usdRaw(x.amountIn, x.side), 0), proto: s.reduce((a, x) => a + usdRaw(x.proto, x.side), 0), n: s.length };
}
// The window's first fee-read row, found independently: rows of its tier from one step before its start.
function startRow(series, w, now) {
  const W = windowMs(w), tier = W <= 7 * DAY ? 'h' : 'd', step = tier === 'h' ? HOUR : DAY;
  return rowsIn(series, tier, now - W - step, now - 1).find((r) => r.fg0 != null && r.fg1 != null && r.L != null);
}
const run = (sim, w, { pool = POOL, config = CONFIG, cur = sim.cur, series = sim.series, parts } = {}) =>
  windowMetrics({ window: w, series, cur, pool, config, chain: 'ethereum' }, parts ? { parts: { ...PARTS, ...parts } } : undefined);
const near = (a, b, rel) => a != null && b != null && (a === b || Math.abs(a / b - 1) <= rel);
// Every number in a window is finite or null: no NaN, no Infinity, and no undefined field.
function clean(x) {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return true;
  if (typeof x === 'number') return Number.isFinite(x);
  if (Array.isArray(x)) return x.every(clean);
  if (typeof x === 'object') return Object.values(x).every((v) => v !== undefined && clean(v));
  return false;
}
const FIELDS = ['days', 'partial', 'volUsd', 'lpFeesUsd', 'protocolFeesUsd', 'swaps', 'traders', 'sigma', 'range', 'rerangeDays', 'inRangeUsd',
  'feeApr', 'lvr', 'swapCost', 'gas', 'net', 'edge', 'aggApr', 'parkedAvg', 'strandedShare', 'markout', 'gem', 'lenses', 'spark'];

// ---- the cross-check against the swap list ---------------------------------------------------------
// Liquidity changes three times at odd moments (mints and burns between snapshots).
const steppedL = (t) => (t < NOW - 20.3 * HOUR ? 10n ** 18n : t < NOW - 11.1 * HOUR ? 112n * 10n ** 16n : t < NOW - 3.7 * HOUR ? 97n * 10n ** 16n : 105n * 10n ** 16n);
const wobble = (t) => 2.5 * Math.exp(0.004 * Math.sin(t / 3.1e6) + 0.002 * Math.cos(t / 0.7e6));
const feesMatch = (w, tr) => near(w?.lpFeesUsd, tr.lp, 0.01) && near(w?.volUsd, tr.vol, 0.01) && near(w?.protocolFeesUsd, tr.proto, 0.01);

test('24h fees from fee growth agree with the made-up swap list within 1%', () => {
  const sim = simulate({ from: NOW - 2 * DAY, L: steppedL, price: wobble, seed: 11 });
  const w = run(sim, '24h'), tr = truth(sim.swaps, startRow(sim.series, '24h', NOW).t, NOW);
  assert.ok(tr.n > 200 && tr.proto > 0);
  assert.ok(feesMatch(w, tr), `lp ${w.lpFeesUsd / tr.lp}, vol ${w.volUsd / tr.vol}, proto ${w.protocolFeesUsd / tr.proto}`);
  assert.equal(w.partial, false);
  assert.ok(w.days >= 1 && w.days < 1.05);
  assert.ok(clean(w) && FIELDS.every((k) => k in w));
  assert.equal(w.spark.px.length, 24);
  assert.ok(near(w.spark.fees.reduce((a, x) => a + (x ?? 0), 0), w.lpFeesUsd, 0.01), 'the fee sparkline adds up to the window');
  // planted faults: Δfg read in the wrong token (a misread counter, or the maths swapping sides)
  const swapped = (r) => ({ ...r, fg0: r.fg1, fg1: r.fg0 });
  const misread = { ...sim, cur: swapped(sim.cur), series: { h: sim.series.h.map(swapped), d: sim.series.d.map(swapped) } };
  assert.equal(feesMatch(run(misread, '24h'), tr), false);
  assert.equal(feesMatch(run(sim, '24h', { parts: { poolRaw: (d0, d1, L) => [(d1 * L) >> 128n, (d0 * L) >> 128n] } }), tr), false);
  // planted fault: liquidity taken from one end of each interval only (a mint between snapshots ignored)
  assert.equal(feesMatch(run(sim, '24h', { parts: { intervalL: () => 10n ** 18n } }), tr), false);
});

// ---- sole LP and dilution --------------------------------------------------------------------------
test('a sole LP: pool fees are its L × Δfg; a ticket as big as the pool earns half; a huge one nearly all', () => {
  const L = 10n ** 18n, sim = simulate({ from: NOW - 3 * DAY, L: () => L, price: wobble, seed: 5 });
  const s = startRow(sim.series, '24h', NOW), tr = truth(sim.swaps, s.t, NOW);
  const w0 = run(sim, '24h');
  // the sole LP holds all of L: its fees by its own position maths
  const own = [0, 1].reduce((a, i) => a + usdRaw((BigInt.asUintN(256, sim.cur[`fg${i}`] - s[`fg${i}`]) * L) >> 128n, i), 0);
  assert.ok(near(w0.lpFeesUsd, own, 1e-6) && near(w0.lpFeesUsd, tr.lp, 1e-6), `own ${w0.lpFeesUsd / own - 1}, swaps ${w0.lpFeesUsd / tr.lp - 1}`);
  // a ticket that buys exactly the pool's liquidity over ±r
  const t = Math.max(1, Math.round(ticksForLog(w0.range))), tick = sim.cur.tick, sp = Number(sim.cur.sqrtPriceX96) / 2 ** 96;
  const perL = valueInRange(1n, tick - t, tick + t, sp, D1) * USD1, feeDays = (NOW - s.t) / DAY;
  const share = (w, ticket) => (w.feeApr * ticket * feeDays) / 365 / w.lpFeesUsd;
  const same = Number(L) * perL, huge = same * 1e6;
  const half = (parts) => share(run(sim, '24h', { config: { ...CONFIG, ticket: same }, parts }), same);
  const all = (parts) => share(run(sim, '24h', { config: { ...CONFIG, ticket: huge }, parts }), huge);
  assert.ok(Math.abs(half() - 0.5) < 1e-4, `half ${half()}`);
  assert.ok(Math.abs(all() - 1) < 1e-4, `all ${all()}`);
  // planted fault: the dilution term dropped (the ticket's L next to the pool's not counted)
  const noDilution = { dilution: () => 1 };
  assert.ok(Math.abs(half(noDilution) - 0.5) > 0.1);
  assert.ok(Math.abs(all(noDilution) - 1) > 0.1);
});

// ---- a flat price ------------------------------------------------------------------------------------
test('a flat price: zero volatility gives the minimum range, no LVR, no re-ranges, and no NaN', () => {
  const sim = simulate({ from: NOW - 31 * DAY, passMin: 30, price: () => 2.5, seed: 3 });
  const ws = allWindows({ series: sim.series, cur: sim.cur, pool: POOL, config: CONFIG, chain: 'ethereum' });
  assert.deepEqual(Object.keys(ws), ['24h', '7d', '30d']);
  for (const [k, w] of Object.entries(ws)) {
    assert.ok(clean(w), k);
    assert.equal(w.sigma, 0, k);
    assert.equal(w.range, 0.01, k);
    assert.equal(w.lvr, 0, k);
    assert.equal(w.swapCost, 0, k);
    assert.equal(w.gas, 0, k);
    assert.equal(w.rerangeDays, null, `${k}: never re-ranges, shown as blank`);
    assert.equal(w.edge, null, `${k}: fee APR over zero LVR is not a number`);
    assert.ok(w.feeApr > 0 && Math.abs(w.net - w.feeApr) < 1e-12, k);
    assert.ok(w.lenses.includes('calm'), k);
    assert.ok(w.spark.px.every((x) => x === w.spark.px[0]), k);
  }
  assert.equal(ws['30d'].partial, false);
  assert.ok(ws['30d'].days >= 29.9 && ws['30d'].days <= 31.01);
  assert.equal(ws['30d'].spark.px.length, 30);
  assert.equal(ws['7d'].spark.px.length, 24);
  // planted fault: a price that does move (one basis point back and forth) must not read as flat
  const jitter = sim.rows.map((r, i) => ({ ...r, sqrtPriceX96: r.sqrtPriceX96 + (BigInt(i % 2) * r.sqrtPriceX96) / 20000n }));
  assert.ok(sigmaOf(jitter.slice(-48), { minReturns: 12 }) > 1e-4);
});

// ---- a one-way move -----------------------------------------------------------------------------------
test('a one-way move: fees on one side only, σ from the move, and the big-move lens once it stalls', () => {
  const T = NOW - 7 * DAY, stall = NOW - DAY;
  const climb = (t) => 2.5 * Math.exp(0.004 * (Math.min(t, stall) - T) / HOUR);  // +0.4% an hour for 6 days, then flat
  const sim = simulate({ from: NOW - 8 * DAY, passMin: 10, price: (t) => (t < T ? 2.5 : climb(t)), side0: 0, seed: 9 });
  assert.equal(sim.cur.fg0, sim.rows[0].fg0, 'nobody paid in token0');
  const w7 = run(sim, '7d'), tr = truth(sim.swaps, startRow(sim.series, '7d', NOW).t, NOW);
  assert.ok(feesMatch(w7, tr), `lp ${w7.lpFeesUsd / tr.lp}`);
  assert.ok(w7.sigma > 0.01, `sigma ${w7.sigma}`);
  assert.ok(w7.lenses.includes('bigmove'), JSON.stringify(w7.lenses));
  assert.ok(!w7.lenses.includes('calm'));
  // while it is still moving, no big-move lens (the last day isn't calm)
  const mid = NOW - 2 * DAY, part = { ...sim, cur: sim.rows.filter((r) => r.t <= mid).at(-1) };
  part.series = merge(emptySeries(), sim.rows.filter((r) => r.t <= mid), { now: part.cur.t });
  const wMid = run(part, '7d');
  assert.ok(wMid.sigma > 0 && !wMid.lenses.includes('bigmove'), JSON.stringify(wMid.lenses));
  // planted fault: the token0 counter read for token1 (decimals and prices differ) is caught
  const swapped = (r) => ({ ...r, fg0: r.fg1, fg1: r.fg0 });
  assert.equal(feesMatch(run({ ...sim, cur: swapped(sim.cur), series: { h: sim.series.h.map(swapped), d: sim.series.d.map(swapped) } }, '7d'), tr), false);
});

// ---- a pool born mid-window -------------------------------------------------------------------------
test('a pool born mid-window: days = what is covered, partial, annualised over its own days; under a day → null', () => {
  const born = NOW - 3.5 * DAY, sim = simulate({ from: born, price: wobble, seed: 21 });
  const ws = allWindows({ series: sim.series, cur: sim.cur, pool: POOL, config: CONFIG, chain: 'ethereum' });
  assert.equal(ws['24h'].partial, false);
  for (const k of ['7d', '30d']) {
    assert.equal(ws[k].partial, true, k);
    assert.ok(Math.abs(ws[k].days - 3.5) < 0.05, `${k} ${ws[k].days}`);
    assert.ok(ws[k].sigma > 0, `${k}: σ from what there is`);
    assert.ok(clean(ws[k]), k);
  }
  const tr = truth(sim.swaps, born, NOW);
  assert.ok(near(ws['7d'].lpFeesUsd, tr.lp, 0.01));
  assert.ok(near(ws['7d'].aggApr, (365 / 3.5) * tr.lp / POOL.tvlUsd, 0.01), 'annualised over 3.5 days, not 7');
  assert.equal(ws['30d'].spark.px.filter((x) => x != null).length, 4, 'the sparkline is blank before the pool existed');
  // under a day of data: every window is null
  const baby = simulate({ from: NOW - 12 * HOUR, seed: 22 });
  assert.deepEqual(allWindows({ series: baby.series, cur: baby.cur, pool: POOL, config: CONFIG, chain: 'ethereum' }), { '24h': null, '7d': null, '30d': null });
  // planted fault: annualising a young pool over the full window would halve its APR, and is caught
  const wrongApr = (365 / 7) * tr.lp / POOL.tvlUsd;
  assert.equal(near(wrongApr, ws['7d'].aggApr, 0.01), false);
});

// ---- fee growth wrapping past 2^256 ------------------------------------------------------------------
test('fee growth that wraps past 2^256 gives the same answers as one that does not', () => {
  const opts = { from: NOW - 2 * DAY, L: steppedL, price: wobble, seed: 13 };
  const plain = simulate(opts);
  const growth = plain.cur.fg1 - plain.rows[0].fg1;
  const wrap = simulate({ ...opts, fgStart: [TWO256 - 12345n, TWO256 - growth / 2n] });
  assert.ok(wrap.cur.fg1 < wrap.rows[0].fg1, 'the token1 counter did wrap');
  const a = run(plain, '24h'), b = run(wrap, '24h');
  for (const k of ['lpFeesUsd', 'volUsd', 'protocolFeesUsd', 'feeApr', 'net', 'aggApr']) assert.ok(near(b[k], a[k], 1e-9), k);
  // planted fault: plain subtraction (no wrap) is caught
  const c = run(wrap, '24h', { parts: { deltaFg: (x, y) => y - x } });
  assert.equal(near(c.lpFeesUsd, a.lpFeesUsd, 0.01), false);
});

// ---- unread rows and missing inputs ------------------------------------------------------------------
test('unread rows are bridged by the counters, never read as zero; missing inputs give nulls, never 0', () => {
  const sim = simulate({ from: NOW - 2 * DAY, price: wobble, seed: 17 });
  const rnd = mulberry32(99);
  const holes = sim.rows.map((r, i) => (i === sim.rows.length - 1 || rnd() > 0.35 ? r : rnd() < 0.5 ? { t: r.t } : { ...r, fg0: null, fg1: null, L: null }));
  const series = merge(emptySeries(), holes, { now: NOW });
  const w = run({ ...sim, series }, '24h'), tr = truth(sim.swaps, startRow(series, '24h', NOW).t, NOW);
  assert.ok(feesMatch(w, tr), `lp ${w.lpFeesUsd / tr.lp}`);
  // planted fault: an unread counter read as 0 is caught
  const zeros = merge(emptySeries(), sim.rows.map((r, i) => (i % 7 === 3 ? { ...r, fg0: 0n, fg1: 0n } : r)), { now: NOW });
  assert.equal(feesMatch(run({ ...sim, series: zeros }, '24h'), tr), false);

  // the current state unread → fee fields null (σ still from the prices)
  const c1 = run(sim, '24h', { cur: { ...sim.cur, fg0: null } });
  for (const k of ['lpFeesUsd', 'volUsd', 'protocolFeesUsd', 'feeApr', 'net', 'edge', 'aggApr']) assert.equal(c1[k], null, k);
  assert.ok(c1.sigma > 0 && c1.lvr > 0);
  // no USD prices → every dollar field null; no fee settings → volume and protocol fees null
  const c2 = run(sim, '24h', { pool: { ...POOL, usd0: null, usd1: null } });
  for (const k of ['lpFeesUsd', 'volUsd', 'protocolFeesUsd', 'feeApr', 'aggApr', 'net']) assert.equal(c2[k], null, k);
  assert.ok(c2.spark.fees.every((x) => x === null) && c2.spark.px.some((x) => x != null));
  const c3 = run(sim, '24h', { pool: { ...POOL, lpKeeps: null } });
  assert.ok(c3.lpFeesUsd > 0 && c3.volUsd === null && c3.protocolFeesUsd === null);
  // one USD price is enough: the other comes from the pool's price
  const c4 = run(sim, '24h', { pool: { ...POOL, usd0: null } });
  assert.ok(near(c4.lpFeesUsd, w.lpFeesUsd, 0.02));
  // no gas → gas and net null, the rest stands; no hold days → no range, so nothing at the ticket
  const c5 = run(sim, '24h', { pool: { ...POOL, gasUsd: null } });
  assert.ok(c5.gas === null && c5.net === null && c5.feeApr > 0 && c5.lvr > 0 && c5.edge > 0);
  const c6 = run(sim, '24h', { config: { ...CONFIG, holdDays: {} } });
  for (const k of ['range', 'feeApr', 'lvr', 'swapCost', 'gas', 'net', 'edge', 'rerangeDays', 'inRangeUsd']) assert.equal(c6[k], null, k);
  assert.ok(c6.lpFeesUsd > 0);
  // no swap replay for this window → swaps, traders and markout null, and the gem says what is missing
  assert.ok(w.swaps === null && w.traders === null && w.markout === null);
  assert.ok(w.gem.total === null && w.gem.missing.includes('flow') && w.gem.missing.includes('persistence'));
  // every field null-or-finite in all of these
  for (const x of [w, c1, c2, c3, c4, c5, c6]) assert.ok(clean(x));
});

// ---- shape, lenses and the gem ----------------------------------------------------------------------
test('a stranded one-sided pool with toxic flow: lenses, shape averages and the gem from lib/gem.mjs', () => {
  const sim = simulate({ from: NOW - 9 * DAY, passMin: 15, price: wobble, parked: (t) => (t > NOW - 2 * DAY ? 0.95 : 0.85), seed: 31 });
  const cur = { ...sim.cur, aboveShare: 0.97 };
  const pool = { ...POOL, walls: { below: 0.4, above: Infinity }, inactiveShare: 0.7, flow: { '24h': { swaps: 240, traders: 60, markout: 0.8 }, '7d': { swaps: 1500, traders: 300, markout: 0.3 } } };
  const ws = allWindows({ series: sim.series, cur, pool, config: CONFIG, chain: 'ethereum' });
  const w24 = ws['24h'], w7 = ws['7d'];
  assert.ok(w24.parkedAvg >= 0.94 && w24.strandedShare === 1);
  assert.ok(w7.parkedAvg > 0.85 && w7.parkedAvg < 0.95);
  assert.ok(w24.lenses.includes('one-sided') && !w24.lenses.includes('stranded'));
  assert.ok(w24.lenses.includes('toxic') && !w7.lenses.includes('toxic'), 'toxic above the config threshold only');
  assert.deepEqual([w24.swaps, w24.traders, w24.markout], [240, 60, 0.8]);
  assert.ok(Number.isInteger(w7.gem.total), JSON.stringify(w7.gem));
  assert.equal(w7.gem.stranded + w7.gem.yield + w7.gem.persistence + w7.gem.flow, w7.gem.total);
  // a failed check blocks the gem; a warning costs 10 points
  const blocked = allWindows({ series: sim.series, cur, pool: { ...pool, fails: ['unverified'] }, config: CONFIG, chain: 'ethereum' })['7d'];
  assert.equal(blocked.gem.total, null);
  const warned = allWindows({ series: sim.series, cur, pool: { ...pool, warnings: ['hooked pool'] }, config: CONFIG, chain: 'ethereum' })['7d'];
  assert.equal(warned.gem.total, Math.max(0, w7.gem.total - 10));
  // the in-range value comes from today's map when it is passed in
  const seg = [{ lo: sim.cur.tick - 5000, hi: sim.cur.tick + 5000, L: 10n ** 18n }];
  const withMap = run({ ...sim, cur: { ...cur, segments: seg } }, '7d', { pool });
  assert.ok(withMap.inRangeUsd > 0 && withMap.inRangeUsd < 1e6);
  assert.equal(run({ ...sim, cur }, '7d', { pool }).inRangeUsd, null, 'no map, no value: never 0');
  // the toxic threshold is the config's: raised above the markout, the lens goes off
  assert.equal(allWindows({ series: sim.series, cur, pool, config: { ...CONFIG, toxicMarkout: 0.9 }, chain: 'ethereum' })['24h'].lenses.includes('toxic'), false);
  // a pool parked on both sides of the price is plain stranded, not one-sided
  assert.ok(run({ ...sim, cur: { ...sim.cur, aboveShare: 0.5 } }, '24h', { pool }).lenses.includes('stranded'));
});

test('a backfill that measured the shape on a few past days still gives a 30-day average; too few gives null', () => {
  const sim = simulate({ from: NOW - 31 * DAY, passMin: 60, price: wobble, parked: () => 0.9, seed: 41 });
  const keep = (n) => sim.rows.map((r, i) => (i === sim.rows.length - 1 || (n > 0 && i % Math.floor(sim.rows.length / n) === 0) ? r : { ...r, parked: null }));
  const sparse = merge(emptySeries(), keep(3), { now: NOW });
  const w = run({ ...sim, series: sparse }, '30d', { pool: { ...POOL, flow: { '30d': { gemFlow: { markoutToFee: 0.2, traders7d: 300 } } } } });
  assert.ok(Math.abs(w.parkedAvg - 0.9) < 1e-9 && w.strandedShare === 1, JSON.stringify([w.parkedAvg, w.strandedShare]));
  assert.equal(w.markout, null, 'the latest replay scores the gem but is not shown as this window\'s markout');
  assert.ok(!w.gem.missing.includes('flow'));
  // planted fault: only the current shape read must not pass for a 30-day average
  const thin = merge(emptySeries(), keep(0), { now: NOW });
  assert.equal(run({ ...sim, series: thin }, '30d').parkedAvg, null);
});
