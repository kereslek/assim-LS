// Flow quality (lib/flowq.mjs) on made-up swaps (MOCKUP · MADE-UP NUMBERS): the arb/retail classifier, Spearman's
// rank correlation, drift correlation from hourly rows, the routing share (a miss is null, never 0), distinct
// senders, and the daily record the longer windows read. Planted faults show each check would catch a slip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySwaps, retailShare, spearman, ranks, driftCorr, routingShare, txSample, sendersOf, dailyFlow, nextFlowDaily } from '../lib/flowq.mjs';

const Q = 2 ** 96;
const sq = (p) => BigInt(Math.round(Math.sqrt(p) * Q)); // sqrtPriceX96 of a raw price (token1 per token0)
const H = (n) => '0x' + n.toString(16).padStart(64, '0');
// a v3-style swap: in = 0 sells token0 (the price falls), in = 1 buys it (the price rises); amounts at `avg`
function sw({ block, after, in: side, amountIn = 1000n, avg, k = 0 }) {
  const aIn = Number(amountIn), out = side === 0 ? BigInt(Math.round(aIn * avg)) : BigInt(Math.round(aIn / avg));
  return { v: 3, pool: '0xp', in: side, amountIn, amountOut: out, sqrtPriceX96: sq(after), block, logIndex: k, tx: H(block * 10 + k) };
}
const feeOf = (s) => s.amountIn / 100n; // 1% LP fee in input units, for the made-up swaps

test('the classifier: a swap toward the later price that leaves the trader ahead is arb-like; the rest is retail', () => {
  // the market moved up to 1.10: an arb buys token0 at about 1.02 and lifts the pool to 1.08, the price then reaches 1.10
  const arb = sw({ block: 100, after: 1.08, in: 1, avg: 1.02 });
  const later = sw({ block: 110, after: 1.10, in: 1, avg: 1.09, k: 1 });
  // retail sells token0 at 1.08 and pushes the pool down, against where the price goes next
  const retail = sw({ block: 120, after: 1.05, in: 0, avg: 1.075, k: 2 });
  const back = sw({ block: 130, after: 1.11, in: 1, avg: 1.06, k: 3 });
  const v = classifySwaps([back, retail, later, arb], { horizon: 15, endBlock: 200, feeOf, prev: sq(1.0) });
  const of = (s) => v.find((x) => x.swap === s).arb;
  assert.equal(of(arb), true, 'toward the later price, the trader ahead at it');
  assert.equal(of(retail), false, 'against the later price');
  // a swap toward the later price that loses the trader money at it is retail too
  const small = sw({ block: 300, after: 1.001, in: 1, avg: 1.05 }); // paid 1.05 for what is worth about 1.001
  const v2 = classifySwaps([small], { horizon: 15, endBlock: 400, feeOf, prev: sq(1.0) });
  assert.equal(v2[0].arb, false);
  // the first swap of a window with no price before it, and a swap whose horizon has not passed, are not classified
  assert.equal(classifySwaps([arb], { horizon: 15, endBlock: 200, feeOf })[0].arb, null);
  assert.equal(classifySwaps([arb], { horizon: 500, endBlock: 200, feeOf, prev: sq(1.0) })[0].arb, null);
  // planted fault: a classifier that drops the "toward" test calls the retail sale arb-like (it is ahead at the post-trade price)
  const faulty = (s, prevP, later_) => { const pm = later_, a = Number(s.amountIn), o = Number(s.amountOut); return (s.in === 0 ? a * pm - o : a - o * pm) < 0; };
  assert.equal(faulty(retail, 1.08, 1.05), true, 'the faulty rule misreads it');
  assert.equal(of(retail), false, 'the real rule does not');
});

test('retailShare: the share of classified LP fees from retail swaps; too few classified or no fees → null', () => {
  const mkV = (arb, fee) => ({ swap: {}, arb, fee });
  const vs = [...Array(8).fill(0).map(() => mkV(false, 3)), mkV(true, 6), mkV(true, 6), mkV(null, 100)];
  const r = retailShare(vs);
  assert.equal(r.classified, 10);
  assert.equal(r.share, 24 / 36, 'fee-weighted: unclassified swaps left out');
  assert.equal(retailShare(vs.slice(0, 9)), null, 'under 10 classified');
  assert.equal(retailShare(Array(12).fill(0).map(() => mkV(false, 0))), null, 'no fees: nothing to share');
  assert.equal(retailShare(Array(12).fill(0).map(() => mkV(true, 1))).share, 0, 'all arbitrage: a real 0');
});

test('spearman: ranks with ties, monotone series, and the cases with no answer', () => {
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  assert.equal(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
  assert.equal(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]) - 0.8) < 1e-12, 'textbook: 1 − 6·4/(5·24) = 0.8');
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null, 'a constant side');
  assert.equal(spearman([1, 2], [1, 2]), null, 'under 3 pairs');
  assert.equal(spearman([1, 2, null, 4], [1, 2, 3, 4]), 1, 'an unread value drops its pair');
  // planted fault: Pearson instead of Spearman misses a monotone but curved relation
  const x = [1, 2, 3, 4, 5, 6, 7, 8], y = x.map((v) => Math.exp(v));
  const pearson = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
  assert.ok(pearson(x, y) < 0.9);
  assert.equal(spearman(x, y), 1);
});

test('driftCorr: each hour\'s fees against that hour\'s |return|; gaps, unread fees and thin data handled', () => {
  const t0 = Date.UTC(2026, 10, 1);
  // fees follow the size of the move: drift-driven
  const rows = [[t0, 1, 1e20, null, null]];
  let px = 1;
  for (let i = 1; i <= 24; i++) { const r = ((i * 7) % 5) / 1000; px *= Math.exp(i % 2 ? r : -r); rows.push([t0 + i * 3600e3, px, 1e20, 100 * r + 1, null]); }
  const d = driftCorr(rows);
  assert.ok(d.rho > 0.95 && d.hours === 24, JSON.stringify(d));
  // fees that ignore the moves
  const flat = rows.map((r, i) => [r[0], r[1], r[2], i ? 10 + (i % 3) : null, null]);
  assert.ok(Math.abs(driftCorr(flat).rho) < 0.5);
  // a 3-hour gap is not an hour; an unread hour is left out, never 0
  const gappy = rows.filter((_, i) => i !== 5).map((r, i) => (i === 9 ? [r[0], r[1], r[2], null, null] : r));
  assert.equal(driftCorr(gappy).hours, 21, "24 hours less the 2-hour step and the unread one");
  assert.equal(driftCorr(rows.slice(0, 10)), null, 'under 12 hours');
  assert.equal(driftCorr(rows, { from: t0 + 20 * 3600e3 }), null, 'the window holds 4 hours');
});

test('routing: the share of sampled swaps sent to a known router; a miss is null, never 0', () => {
  const swaps = Array.from({ length: 30 }, (_, i) => ({ tx: H(i + 1) }));
  const R = '0x' + 'aa'.repeat(20), O = '0x' + 'bb'.repeat(20);
  const isRouter = (to) => to === R;
  const all = new Map(swaps.map((s, i) => [s.tx, { to: i % 3 ? O : R, from: '0x' + String(i).padStart(40, '0') }]));
  const r = routingShare(swaps, all, isRouter);
  assert.equal(r.sampled, 30); assert.equal(r.known, 30); assert.equal(r.share, 10 / 30);
  assert.equal(routingShare(swaps, new Map(), isRouter), null, 'no transaction read: null, not 0');
  assert.equal(routingShare(swaps, null, isRouter), null);
  const few = new Map([...all].slice(0, 8));
  assert.equal(routingShare(swaps, few, isRouter), null, 'under half the sample read');
  assert.equal(routingShare(swaps.slice(0, 6), all, isRouter), null, 'under 10 transactions: too thin');
  const none = new Map(swaps.map((s) => [s.tx, { to: O, from: O }]));
  assert.equal(routingShare(swaps, none, isRouter).share, 0, 'read, and nothing routed: a real 0');
  // a transaction with two swaps in the pool counts twice
  const two = [...swaps, { tx: swaps[0].tx }];
  assert.equal(routingShare(two, all, isRouter).share, 11 / 31);
  // the sample is the smallest hashes: stable as new swaps arrive with larger hashes
  const s1 = txSample(swaps, 5), s2 = txSample([...swaps, { tx: H(999) }], 5);
  assert.deepEqual(s1, s2);
  // planted fault: counting unread transactions as "not routed" turns a miss into a 0
  const faulty = (sw, txs) => sw.filter((s) => isRouter(txs.get(s.tx)?.to)).length / sw.length;
  assert.equal(faulty(swaps, new Map()), 0);
});

test('senders: distinct tx.from over every transaction, null unless all were read', () => {
  const swaps = [{ tx: H(1) }, { tx: H(2) }, { tx: H(3) }];
  const txs = new Map([[H(1), { from: '0xA' }], [H(2), { from: '0xa' }], [H(3), { from: '0xb' }]]);
  assert.equal(sendersOf(swaps, txs), 2, 'case-insensitive');
  assert.equal(sendersOf(swaps, new Map([[H(1), { from: '0xa' }]])), null);
  assert.equal(sendersOf([], txs), 0, 'no swaps: a real zero');
});

test('the daily record: today replaced, 30 days kept; longer windows read a fee-weighted mean', () => {
  const day = 86400e3, now = Date.UTC(2026, 10, 8, 12);
  let rows = [];
  for (let k = 9; k >= 0; k--) rows = nextFlowDaily(rows, { now: now - k * day, retailShare: k % 2 ? 0.8 : 0.4, lpFeesUsd: k % 2 ? 100 : 300, routing: 0.5 });
  assert.equal(rows.length, 10);
  rows = nextFlowDaily(rows, { now: now + 3600e3, retailShare: 0.9, lpFeesUsd: 300, routing: 0.7 });
  assert.equal(rows.length, 10, 'the same day is replaced');
  assert.equal(rows.at(-1)[1], 0.9);
  const d = dailyFlow(rows, { from: now - 7 * day, to: now + day });
  const inW = rows.filter((r) => r[0] >= now - 7 * day);
  assert.ok(Math.abs(d.retailShare - inW.reduce((s, r) => s + r[1] * r[2], 0) / inW.reduce((s, r) => s + r[2], 0)) < 1e-12);
  assert.equal(dailyFlow(rows.slice(-2), { from: 0, to: now + day }).retailShare, null, 'under 3 days');
  assert.equal(nextFlowDaily(rows, { now: now + 40 * day }).length, 0, 'nothing read today, and the old days aged out');
});
