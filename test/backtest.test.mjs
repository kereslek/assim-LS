// Backtest engine on made-up price paths (MOCKUP · MADE-UP NUMBERS). Both tokens use 18 decimals
// and token1 is the $1 reference, so raw prices are human prices and values are dollars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, simulate, pathFraction, rangeAround, amountsAt, parseTrigger, sigmaFromSwaps } from '../lib/backtest.mjs';
import { runBacktest, strategiesFor, swapRateFor } from '../lib/backtest-run.mjs';
import { auditBacktest } from '../lib/backtest-audit.mjs';
import { sqrtAtTick } from '../lib/v3math.mjs';

const X96 = 2 ** 96, MIN = 60e3, HOUR = 3600e3;
const toX96 = (sp) => BigInt(Math.round(sp * X96));
const tickOf = (P) => Math.floor(Math.log(P) / Math.log(1.0001));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const V3 = { fee: 3000, feeProtocol: 0 };

// A price path → swaps: each swap moves the pool to the next price; the input side follows the move.
function path(prices, { dt = 10 * MIN, amount = 10n ** 18n, L = 10n ** 21n, v = 3, fees = null, t0 = 0, sideIfFlat = (i) => i % 2 } = {}) {
  return prices.map((P, i) => {
    const prev = i ? prices[i - 1] : P;
    return { v, in: P > prev ? 1 : P < prev ? 0 : sideIfFlat(i), amountIn: amount, amountOut: 1n, sqrtPriceX96: toX96(Math.sqrt(P)), liquidity: L,
      tick: tickOf(P), fee: v === 4 ? (fees ? fees[i % fees.length] : 3000) : null, block: 1000 + i, logIndex: 0, t: t0 + (i + 1) * dt };
  });
}
const ctxFor = (P0, tEnd, extra = {}) => ({ start: { t: 0, sp: Math.sqrt(P0), tick: tickOf(P0) }, end: { t: tEnd }, d0: 18, d1: 18, ref: 1, refUsd: 1, ticket: 1000, gasUsd: 2, swapRate: 0.0035, spacing: 60, points: 200, ...extra });
const one = (r, trigger = 'exit') => ({ id: 'x', sleeves: [{ w: 1, r }], trigger });
const sumFees = (ss, meta) => ss.reduce((a, s) => a + Number((s.amountIn * BigInt(s.fee ?? meta.fee)) / 1000000n), 0) / 1e18;

test('path fraction: only the part of a crossing swap inside the range earns', () => {
  assert.equal(pathFraction(1, 1, 0.9, 1.1, 0), 1);
  assert.equal(pathFraction(1.2, 1.2, 0.9, 1.1, 0), 0);
  assert.ok(near(pathFraction(0.9, 1.05, 1, 1.1, 1), 1 / 3, 1e-12)); // token1 in: by Δ√P
  assert.ok(near(pathFraction(1.2, 1.05, 1, 1.1, 0), (1 / 1.05 - 1 / 1.1) / (1 / 1.05 - 1 / 1.2), 1e-12)); // token0 in: by Δ(1/√P)
  assert.equal(pathFraction(1.2, 1.3, 1, 1.1, 1), 0); // wholly outside
  assert.equal(pathFraction(0.95, 1.2, 1, 1.1, 1) > 0, true);
});

test('ranges sit on the tick spacing, contain the price, and are at least one spacing wide', () => {
  for (const [tick, r, S] of [[125, 0.05, 60], [-77, 0.001, 200], [0, 0.3, 1], [887000, 0.5, 60]]) {
    const { ta, tb } = rangeAround(tick, r, S);
    assert.ok(ta % S === 0 && tb % S === 0 && ta <= tick && tick < tb && tb - ta >= S, `${tick} ${r} ${S}`);
  }
  assert.deepEqual(parseTrigger('exit+12h'), { kind: 'delay', delay: 12 * HOUR });
  assert.deepEqual(parseTrigger('drift75'), { kind: 'drift', drift: 0.75 });
  assert.equal(parseTrigger('later'), null);
});

test('flat price: fees only, no loss vs holding, entry costs once, always in range', () => {
  const ss = path(Array(100).fill(1));
  const prep = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 });
  const r = simulate(prep, ctxFor(1, 101 * 10 * MIN), one(0.05), { trace: true });
  assert.ok(r.feesUsd > 0);
  assert.ok(near(r.lvrUsd, 0, 1e-9));
  assert.equal(r.reranges, 0);
  assert.equal(r.ledger.length, 1);
  assert.ok(near(r.costsUsd, -(2 + r.ledger[0].swapUsd), 1e-12) && r.ledger[0].swapUsd > 0);
  assert.ok(near(r.ledger[0].swappedUsd, 500, 2)); // about half the ticket is swapped at entry
  assert.ok(near(r.tir, 1, 1e-12));
  // every swap pays the same share: L ÷ (activeL + L) of its LP fee
  const L = r.trace.L[0], want = sumFees(ss, V3) * (L / (1e21 + L));
  assert.ok(near(r.feesUsd, want, 1e-9 * want));
  assert.ok(near(r.netUsd, r.feesUsd + r.costsUsd, 1e-9));
  assert.equal(r.series.t.length, 201);
  assert.equal(r.series.t[0], 0);
  assert.equal(r.series.t[200], 101 * 10 * MIN);
});

test('one-way move: the loss grows, the range exits and re-centres, and every re-centre pays', () => {
  const prices = Array.from({ length: 120 }, (_, i) => Math.exp(0.004 * (i + 1)));
  const ss = path(prices), prep = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 });
  const ctx = ctxFor(1, 121 * 10 * MIN);
  const r = simulate(prep, ctx, one(0.05));
  assert.ok(r.reranges >= 4, `reranges ${r.reranges}`);
  assert.ok(r.lvrUsd < -1);
  for (let i = 1; i < 201; i++) {
    assert.ok(r.series.lvr[i] <= r.series.lvr[i - 1] + 1e-9, 'loss never shrinks on a one-way move');
    assert.ok(r.series.costs[i] <= r.series.costs[i - 1] + 1e-12 && r.series.fees[i] >= r.series.fees[i - 1] - 1e-12);
  }
  assert.equal(r.ledger.filter((e) => e.kind === 'recentre').length, r.reranges);
  assert.ok(r.ledger.every((e) => e.gasUsd === 2 && e.swapUsd > 0));
  assert.ok(near(r.costsUsd, -r.ledger.reduce((a, e) => a + e.gasUsd + e.swapUsd, 0), 1e-9));
  assert.ok(r.tir > 0.95); // re-centred at once on each exit
  // a wide range that never exits: the loss equals the closed form for a v3 position
  const w = simulate(prep, ctx, one(1));
  assert.equal(w.reranges, 0);
  const { ta, tb } = rangeAround(0, 1, 60), sa = sqrtAtTick(ta), sb = sqrtAtTick(tb);
  const L = (1000 - w.ledger[0].swapUsd) / (amountsAt(1, sa, sb, 1)[0] + amountsAt(1, sa, sb, 1)[1]);
  const [x0, y0] = amountsAt(L, sa, sb, 1), P = prices.at(-1), [x1, y1] = amountsAt(L, sa, sb, Math.sqrt(P));
  assert.ok(near(w.lvrUsd, -((x0 * P + y0) - (x1 * P + y1)), 1e-6));
});

test('round trips: the loss comes back to zero while fees keep growing', () => {
  const leg = Array.from({ length: 10 }, (_, i) => 1 + 0.01 * (i + 1));
  const trip = [...leg, ...leg.slice(0, -1).reverse(), 1];
  const ss = path([...trip, ...trip, ...trip]), prep = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 });
  const r = simulate(prep, ctxFor(1, (ss.length + 1) * 10 * MIN), one(0.5));
  assert.equal(r.reranges, 0);
  assert.ok(near(r.lvrUsd, 0, 1e-9));
  assert.ok(Math.min(...r.series.lvr) < -0.01); // it was down mid-trip
  assert.ok(r.feesUsd > 0 && r.netUsd > r.costsUsd);
});

test('a sole LP takes 100% of the fees while in range', () => {
  const ss = path([1, 1.001, 0.999, 1, 1.002, 1.0005], { L: 0n });
  const prep = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 });
  const r = simulate(prep, ctxFor(1, 7 * 10 * MIN), one(0.05));
  assert.ok(near(r.share, 1, 1e-12), String(r.share));
  assert.ok(near(r.feesUsd, r.poolFeesUsd, 1e-12));
  // two sleeves of one ticket share one pool: together still exactly 100%, never 200%
  const g = simulate(prep, ctxFor(1, 7 * 10 * MIN), { id: 'g', sleeves: [{ w: 0.7, r: 0.05 }, { w: 0.3, r: 0.02 }], trigger: 'exit' });
  assert.ok(near(g.share, 1, 1e-12), String(g.share));
});

test('dust amounts and a dust ticket: small numbers, never NaN', () => {
  const ss = path([1, 1.0001, 1, 0.9999], { amount: 1000n });
  const prep = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 });
  const r = simulate(prep, ctxFor(1, 5 * 10 * MIN, { ticket: 1e-6 }), one(0.05));
  for (const k of ['feesUsd', 'lvrUsd', 'costsUsd', 'netUsd', 'tir']) assert.ok(Number.isFinite(r[k]), k);
  for (const k of Object.keys(r.series)) assert.ok(r.series[k].every(Number.isFinite), k);
  assert.ok(r.feesUsd >= 0 && r.share >= 0 && r.share < 1e-6);
  const zero = simulate(prepare(path([1, 1], { amount: 1n }), { meta: V3, d0: 18, d1: 18, ref: 1 }), ctxFor(1, 3 * 10 * MIN), one(0.05));
  assert.equal(zero.share, null); // the pool paid nothing: the share is unknown, not 0%
});

test('v4 dynamic fees: each swap pays its own fee, less the protocol part', () => {
  const fees = [500, 3000, 10000, 2500];
  const ss = path([1, 1, 1, 1, 1, 1, 1, 1], { v: 4, fees, L: 0n });
  const prep = prepare(ss, { meta: { protocolFee: 0 }, d0: 18, d1: 18, ref: 1 });
  const r = simulate(prep, ctxFor(1, 9 * 10 * MIN), one(0.05));
  assert.ok(near(r.feesUsd, sumFees(ss), 1e-15));
  const cut = 100 | (100 << 12); // the protocol keeps 0.01% of the input on both sides
  const rc = simulate(prepare(ss, { meta: { protocolFee: cut }, d0: 18, d1: 18, ref: 1 }), ctxFor(1, 9 * 10 * MIN), one(0.05));
  assert.ok(near(r.feesUsd - rc.feesUsd, 8 * 1e-4, 1e-12));
  assert.equal(prepare(ss, { meta: { protocolFee: null }, d0: 18, d1: 18, ref: 1 }).unpriced, 8); // never assumed
});

test('v3 protocol cut: LPs keep the tier less 1/N', () => {
  const ss = path(Array(10).fill(1), { L: 0n });
  const full = simulate(prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 }), ctxFor(1, 11 * 10 * MIN), one(0.05));
  const cut = simulate(prepare(ss, { meta: { fee: 3000, feeProtocol: 0x44 }, d0: 18, d1: 18, ref: 1 }), ctxFor(1, 11 * 10 * MIN), one(0.05));
  assert.ok(near(cut.feesUsd / full.feesUsd, 0.75, 1e-12));
});

test('triggers: exit+12h waits, a return in time cancels, drift re-centres early', () => {
  // out of range from hour 1 to hour 14, then back: exit+12h re-centres once, at hour 13
  const P = (h) => (h >= 1 && h < 14 ? 1.2 : 1);
  const ss = Array.from({ length: 20 }, (_, h) => h).map((h) => ({ ...path([P(h)])[0], t: h * HOUR + MIN, block: 10 + h, in: P(h) >= (h ? P(h - 1) : 1) ? 1 : 0 }));
  const prep = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 });
  const ctx = ctxFor(1, 20 * HOUR);
  const d12 = simulate(prep, ctx, one(0.05, 'exit+12h'));
  assert.equal(d12.reranges, 1);
  assert.equal(d12.ledger[1].t, HOUR + MIN + 12 * HOUR);
  const d24 = simulate(prep, ctx, one(0.05, 'exit+24h'));
  assert.equal(d24.reranges, 0); // back in range before 24 h
  assert.ok(near(d24.tir, 1 - 13 / 20, 0.01));
  const ex = simulate(prep, ctx, one(0.05, 'exit'));
  assert.equal(ex.reranges, 2); // out at hour 1, out again (below the new range) at hour 14
  // drift: a move 60% of the way to the edge (0.03 of a ±0.05 log range) triggers drift50, not drift75
  const ds = path([Math.exp(0.6 * 0.05)]), dp = prepare(ds, { meta: V3, d0: 18, d1: 18, ref: 1 });
  assert.equal(simulate(dp, ctxFor(1, 2 * 10 * MIN, { spacing: 1 }), one(0.05, 'drift50')).reranges, 1);
  assert.equal(simulate(dp, ctxFor(1, 2 * 10 * MIN, { spacing: 1 }), one(0.05, 'drift75')).reranges, 0);
});

test('missing inputs give null, never a zero result', () => {
  const prep = prepare(path([1, 1.01]), { meta: V3, d0: 18, d1: 18, ref: 1 });
  assert.equal(simulate(prep, ctxFor(1, 3 * 10 * MIN, { gasUsd: null }), one(0.05)), null);
  assert.equal(simulate(prep, ctxFor(1, 3 * 10 * MIN, { refUsd: null }), one(0.05)), null);
  assert.equal(simulate(prep, ctxFor(1, 3 * 10 * MIN), one(0.05, 'whenever')), null);
  const unread = runBacktest({ swaps: path([1, 1.01]), pool: { d0: 18, d1: 18, spacing: 60, meta: { fee: 3000, feeProtocol: null }, feeTier: 0.003 }, start: { t: 0, sp: 1, tick: 0 }, end: { t: HOUR }, usd: { ref: 1, refUsd: 1 }, sigma: 0.02, ticket: 1000, gasUsd: 2 });
  assert.equal(unread.backtest, null);
  assert.equal(unread.reason, 'unpriced');
});

test('runBacktest: the DATA.md shape, every strategy, the grid, and an audit that passes', () => {
  let x = 1, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const prices = Array.from({ length: 1500 }, () => (x *= Math.exp((rnd() - 0.5) * 0.01)));
  const ss = path(prices, { dt: 4 * MIN });
  const tEnd = (ss.length + 1) * 4 * MIN;
  const input = { swaps: ss, pool: { d0: 18, d1: 18, spacing: 60, meta: V3, feeTier: 0.003 }, start: { t: 0, sp: 1, tick: 0 }, end: { t: tEnd }, usd: { ref: 1, refUsd: 1 }, sigma: 0.03, ticket: 1000, gasUsd: 2, forecastNet: 0.12 };
  const { backtest: b, ours, prep } = runBacktest(input);
  assert.equal(b.trigger, 'exit');
  assert.equal(b.range, 0.11); // suggestRange(3%, 14 days)
  assert.equal(b.forecastNet, 0.12);
  assert.ok(near(b.days, tEnd / 86400e3, 1e-12) && b.partial === false);
  for (const k of ['net', 'netUsd', 'feesUsd', 'lvrUsd', 'costsUsd', 'tir', 'reranges', 'share']) assert.ok(Number.isFinite(b[k]), k);
  assert.ok(b.feesUsd >= 0 && b.lvrUsd <= 0 && b.costsUsd < 0);
  assert.ok(near(b.netUsd, b.feesUsd + b.lvrUsd + b.costsUsd, 1e-3));
  assert.deepEqual(Object.keys(b.series), ['t', 'px', 'lo', 'hi', 'fees', 'lvr', 'costs', 'net']);
  assert.ok(b.series.t.length === 201 && b.series.lo.every((lo, i) => lo <= b.series.px[i] * 1.2 && lo < b.series.hi[i]));
  assert.deepEqual(b.strategies.map((s) => s.id), ['ours', 'tight', 'wide', 'gamma', 'arrakis', 'full']);
  assert.ok(b.strategies.every((s) => Number.isFinite(s.net) && s.series.length === 201));
  assert.equal(b.strategies[0].net, b.net);
  assert.equal(b.strategies.find((s) => s.id === 'full').reranges, 0);
  assert.equal(b.grid.widths.length, 6);
  assert.deepEqual(b.grid.triggers, ['exit', 'exit+12h', 'exit+24h', 'drift50', 'drift75']);
  assert.ok(b.grid.net.length === 6 && b.grid.net.every((row) => row.length === 5 && row.every(Number.isFinite)));
  assert.equal(b.grid.net[2][0], b.net); // the 1 r × exit cell is ours
  assert.equal(b.revert, null);
  const ctx = { start: { t: 0, sp: 1 }, end: { t: tEnd }, d0: 18, d1: 18, ref: 1, refUsd: 1, gasUsd: 2, swapRate: swapRateFor(0.003) };
  const a = auditBacktest(ours, { prep, swaps: ss, meta: V3, ctx });
  assert.ok(a.ok, JSON.stringify(a));
  assert.ok(a.ratios.every((q) => near(q, 1, 1e-12)));
  // gamma's two sleeves audit clean too
  const g = simulate(prep, { ...ctx, ticket: 1000, spacing: 60, points: 200 }, strategiesFor(0.11)[3], { trace: true });
  assert.ok(auditBacktest(g, { prep, swaps: ss, meta: V3, ctx }).ok);
  // with no volatility from before the window, the window's own is used and labelled
  const own = runBacktest({ ...input, sigma: null }).backtest;
  assert.equal(own.sigmaFrom, 'window');
  assert.ok(near(own.sigma, sigmaFromSwaps(prep, { t: 0, sp: 1 }, { t: tEnd }), 1e-12));
});

test('swaps repeated by overlapping log reads are counted once', () => {
  const ss = path([1, 1.01, 1.02]);
  const a = prepare(ss, { meta: V3, d0: 18, d1: 18, ref: 1 }), b = prepare([...ss, ss[1], ss[2]], { meta: V3, d0: 18, d1: 18, ref: 1 });
  assert.equal(b.n, 3);
  assert.equal(b.dup, 2);
  assert.deepEqual([...a.lpRef], [...b.lpRef]);
});
