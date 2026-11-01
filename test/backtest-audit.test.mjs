// Planted faults: each audit check must catch the fault it exists for, and pass on clean data.
// Made-up swaps (MOCKUP · MADE-UP NUMBERS); token1 is the $1 reference, both tokens 18 decimals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, simulate } from '../lib/backtest.mjs';
import { auditBacktest, replayLp } from '../lib/backtest-audit.mjs';
import { swapFees } from '../lib/swaps.mjs';

const X96 = 2 ** 96, MIN = 60e3;
const tickOf = (P) => Math.floor(Math.log(P) / Math.log(1.0001));
const META = { fee: 3000, feeProtocol: 0x44 }; // the protocol keeps 1/4 on both sides
let x = 1, seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const prices = Array.from({ length: 600 }, () => (x *= Math.exp((rnd() - 0.48) * 0.012)));
const swaps = prices.map((P, i) => {
  const prev = i ? prices[i - 1] : 1;
  return { v: 3, in: P >= prev ? 1 : 0, amountIn: BigInt(1 + (i % 7)) * 10n ** 18n, amountOut: 1n, sqrtPriceX96: BigInt(Math.round(Math.sqrt(P) * X96)),
    liquidity: (i % 5 === 0 ? 13n : 10n) * 10n ** 21n, tick: tickOf(P), fee: null, block: 500 + i, logIndex: i % 3, t: (i + 1) * 5 * MIN }; // the book changes often: many swaps count as crossing
});
const END = (swaps.length + 1) * 5 * MIN;
const ctx = { start: { t: 0, sp: 1, tick: 0, L: 1e22 }, end: { t: END }, d0: 18, d1: 18, ref: 1, refUsd: 1, ticket: 1000, gasUsd: 3, swapRate: 0.0035, spacing: 60, points: 200 };
const ours = { id: 'ours', sleeves: [{ w: 1, r: 0.04 }], trigger: 'exit' };
const run = (ss, { meta = META, feeFn = swapFees, strategy = ours } = {}) => {
  const prep = prepare(ss, { meta, feeFn, d0: 18, d1: 18, ref: 1 });
  return { prep, r: simulate(prep, ctx, strategy, { trace: true }) };
};
const audit = ({ prep, r }) => auditBacktest(r, { prep, swaps, meta: META, ctx });
const clone = (r) => ({ ...r, ledger: r.ledger.map((e) => ({ ...e })), trace: Object.fromEntries(Object.entries(r.trace).map(([k, v]) => [k, [...v]])) });

test('clean runs pass every check: one sleeve, two sleeves, a drift trigger, a delay trigger', () => {
  for (const strategy of [ours, { id: 'g', sleeves: [{ w: 0.7, r: 0.04 }, { w: 0.3, r: 0.0133 }], trigger: 'exit' }, { id: 'a', sleeves: [{ w: 1, r: 0.06 }], trigger: 'drift50' }, { id: 'd', sleeves: [{ w: 1, r: 0.03 }], trigger: 'exit+12h' }]) {
    const res = run(swaps, { strategy });
    const a = audit(res);
    assert.ok(a.ok, `${strategy.id}: ${JSON.stringify(a.checks)}`);
    assert.ok(res.r.reranges > 0, `${strategy.id} re-ranged`);
  }
  const a = audit(run(swaps));
  assert.deepEqual(a.ratios, [1, 1]);
});

test('planted fault: a swap counted twice is caught', () => {
  const dup = { ...swaps[40], logIndex: 99 }; // a second copy that de-duplication can't recognise
  const a = audit(run([...swaps, dup]));
  assert.equal(a.checks['pool-fees'], false);
  assert.equal(a.checks['per-swap'], false);
});

test('planted fault: a swap missed is caught', () => {
  assert.equal(audit(run(swaps.filter((_, i) => i !== 77)))['checks']['pool-fees'], false);
});

test('planted fault: the fee charged on the wrong side is caught', () => {
  const a = audit(run(swaps.map((s, i) => (i % 5 === 0 ? { ...s, in: 1 - s.in } : s))));
  assert.equal(a.checks['pool-fees'], false);
  assert.equal(a.checks['per-swap'], false);
});

test('planted fault: a missing protocol cut is caught', () => {
  const noCut = (s, m) => swapFees(s, { ...m, feeProtocol: 0 });
  const a = audit(run(swaps, { feeFn: noCut }));
  assert.equal(a.checks['pool-fees'], false);
  assert.ok(a.ratios.every((q) => q > 1.3)); // LPs credited 4/3 of what they keep
  assert.equal(a.checks['per-swap'], false);
});

test('planted fault: a re-centre that skips its costs is caught', () => {
  const res = run(swaps);
  assert.ok(res.r.reranges >= 2);
  // the last re-centre's ledger entry dropped, and the totals made to agree with the shorter ledger
  const r = clone(res.r), gone = r.ledger.findLastIndex((e) => e.kind === 'recentre'), e = r.ledger.splice(gone, 1)[0];
  r.costsUsd += e.gasUsd + e.swapUsd; r.netUsd += e.gasUsd + e.swapUsd;
  assert.equal(audit({ prep: res.prep, r }).checks.costs, false);
  // a re-centre whose gas was left out
  const r2 = clone(res.r);
  r2.ledger[1].gasUsd = 0; r2.costsUsd += 3; r2.netUsd += 3;
  assert.equal(audit({ prep: res.prep, r: r2 }).checks.costs, false);
  // a re-centre that swapped without paying the swap
  const r3 = clone(res.r), s = r3.ledger[2].swapUsd;
  r3.ledger[2].swapUsd = 0; r3.costsUsd += s; r3.netUsd += s;
  assert.equal(audit({ prep: res.prep, r: r3 }).checks.costs, false);
});

test('planted fault: fees earned while out of range are caught', () => {
  const res = run(swaps, { strategy: { id: 'd', sleeves: [{ w: 1, r: 0.03 }], trigger: 'exit+24h' } });
  const r = clone(res.r), j = r.trace.frac.findIndex((f) => f === 0);
  assert.ok(j >= 0, 'the path leaves the range at least once');
  r.trace.fee[j] = 0.05; r.feesUsd += 0.05; r.netUsd += 0.05;
  const a = audit({ prep: res.prep, r });
  assert.equal(a.checks['per-swap'], false);
  assert.equal(a.checks.sum, true); // the totals were made to agree: only the per-swap check sees it
});

test('planted fault: totals that disagree with the swaps, or a broken identity, are caught', () => {
  const res = run(swaps);
  const r = clone(res.r);
  r.feesUsd *= 1.01; r.netUsd = r.feesUsd + r.lvrUsd + r.costsUsd;
  assert.equal(audit({ prep: res.prep, r }).checks.sum, false);
  const r2 = clone(res.r);
  r2.netUsd += 1;
  assert.equal(audit({ prep: res.prep, r: r2 }).checks.identity, false);
  const r3 = clone(res.r);
  r3.lvrUsd = -r3.lvrUsd; r3.netUsd = r3.feesUsd + r3.lvrUsd + r3.costsUsd; // a loss booked as a gain
  assert.equal(audit({ prep: res.prep, r: r3 }).checks.identity, false);
});

test('planted fault: an annualised net that still carries the entry cost is caught', () => {
  const res = run(swaps);
  const r = clone(res.r);
  r.net = ((r.netUsd / 1000) * 365) / r.days;
  assert.equal(audit({ prep: res.prep, r }).checks.identity, false);
  const r2 = clone(res.r);
  r2.entryUsd = 0; // the entry left out of its own field
  assert.equal(audit({ prep: res.prep, r: r2 }).checks.identity, false);
});

test('planted fault: a crossing swap credited by the whole fee ÷ post-swap liquidity is caught', () => {
  const res = run(swaps), r = clone(res.r);
  // rebuild one crossing swap's fee the old way and make the totals agree
  const j = r.trace.idx.findIndex((i, k) => k > 0 && res.prep.act[i] !== res.prep.act[i - 1] && r.trace.frac[k] === 1);
  assert.ok(j > 0, 'there is a crossing swap fully inside the range');
  const i = r.trace.idx[j], oldFee = (res.prep.lpRef[i] * r.trace.L[j]) / (res.prep.act[i] + r.trace.L[j]);
  r.feesUsd += oldFee - r.trace.fee[j]; r.netUsd += oldFee - r.trace.fee[j]; r.trace.fee[j] = oldFee;
  assert.equal(audit({ prep: res.prep, r }).checks['per-swap'], false);
});

test('the replay is the scan method: summarize per fee setting', () => {
  const lp = replayLp(swaps, META);
  const want = [0n, 0n];
  for (const s of swaps) want[s.in] += swapFees(s, META).lp;
  assert.deepEqual(lp, want);
  assert.equal(replayLp(swaps, { fee: 3000, feeProtocol: null }), null); // unread settings: no replay, not zero
  assert.equal(audit({ prep: null, r: null }).ok, false);
});
