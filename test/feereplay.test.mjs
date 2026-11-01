// The fee-identity replay against a small re-implementation of the pools' own swap loop (v3-core and
// v4-core Pool.swap + SwapMath, exact input), on made-up pools. Each planted fault must be caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqrtRatioAtTick, amount0Delta, amount1Delta, MIN_TICK, MAX_TICK } from '../lib/v3math.mjs';
import { replayFeeGrowth, feeIdentityPath, feeIdentity, pathIndex } from '../lib/checks.mjs';
import { liquidityMap } from '../lib/v3math.mjs';
import { decodeExtra, EXTRA_TOPICS, hookReturnsSwapDelta } from '../lib/swaps.mjs';

const PIPS = 1000000n;
const mulDivUp = (a, b, d) => { const p = a * b; return p / d + (p % d ? 1n : 0n); };
function tickAt(s) {
  let t = Math.floor(Math.log((Number(s) / 2 ** 96) ** 2) / Math.log(1.0001));
  while (t + 1 <= MAX_TICK && sqrtRatioAtTick(t + 1) <= s) t++;
  while (sqrtRatioAtTick(t) > s) t--;
  return t;
}
function nextFromInput(cur, L, amt, down) {
  return down ? mulDivUp(L << 96n, cur, (L << 96n) + amt * cur) : cur + (amt << 96n) / L;
}
function step(v, cur, target, L, rem, fee) {
  const down = cur >= target, lessFee = (rem * (PIPS - fee)) / PIPS;
  let amountIn = down ? amount0Delta(target, cur, L, true) : amount1Delta(cur, target, L, true);
  if (lessFee >= amountIn) return { next: target, amountIn, feeAmount: mulDivUp(amountIn, fee, PIPS - fee) };
  const next = nextFromInput(cur, L, lessFee, down);
  if (v === 4) return { next, amountIn: lessFee, feeAmount: rem - lessFee };
  amountIn = down ? amount0Delta(next, cur, L, true) : amount1Delta(cur, next, L, true);
  return { next, amountIn, feeAmount: rem - amountIn };
}

// A made-up pool: positions → initialized ticks; v3 { fee, feeProtocol } or v4 { lpFee, protocolFee }.
function makePool({ v = 3, positions, tick, fee = 3000, feeProtocol = 0, lpFee = 3000, protocolFee = 0 }) {
  const net = new Map();
  for (const p of positions) { net.set(p.lo, (net.get(p.lo) || 0n) + p.L); net.set(p.hi, (net.get(p.hi) || 0n) - p.L); }
  const ticks = [...net].filter(([, n]) => n !== 0n).sort((a, b) => a[0] - b[0]).map(([t, n]) => ({ tick: t, net: n }));
  const L = positions.filter((p) => p.lo <= tick && tick < p.hi).reduce((s, p) => s + p.L, 0n);
  return { v, ticks, tick, sqrtP: sqrtRatioAtTick(tick) + 12345n, L, fee, feeProtocol, lpFee, protocolFee, fg: [0n, 0n], block: 100, log: 0, events: [] };
}
const swapFeeOf = (pool, down, lpFee) => {
  const pf = BigInt(down ? pool.protocolFee & 0xfff : pool.protocolFee >> 12);
  return pf === 0n ? BigInt(lpFee) : pf + BigInt(lpFee) - (pf * BigInt(lpFee)) / PIPS;
};
function swap(pool, down, amount, { lpFee = pool.lpFee } = {}) {
  let rem = amount, gross = 0n, guard = 0;
  const sf = pool.v === 3 ? BigInt(pool.fee) : swapFeeOf(pool, down, lpFee);
  const n = BigInt(down ? pool.feeProtocol % 16 : pool.feeProtocol >> 4);
  const pf = BigInt(down ? pool.protocolFee & 0xfff : pool.protocolFee >> 12);
  while (rem > 0n && guard++ < 1000) {
    const nx = down ? [...pool.ticks].reverse().find((t) => t.tick <= pool.tick) : pool.ticks.find((t) => t.tick > pool.tick);
    const tNext = nx ? nx.tick : down ? MIN_TICK : MAX_TICK, target = sqrtRatioAtTick(tNext);
    const st = step(pool.v, pool.sqrtP, target, pool.L, rem, sf);
    rem -= st.amountIn + st.feeAmount; gross += st.amountIn + st.feeAmount;
    let feeAmount = st.feeAmount;
    if (pool.v === 3 && n > 0n) feeAmount -= feeAmount / n;
    if (pool.v === 4 && pf > 0n) feeAmount -= sf === pf ? feeAmount : ((st.amountIn + st.feeAmount) * pf) / PIPS;
    if (pool.L > 0n) pool.fg[down ? 0 : 1] += (feeAmount << 128n) / pool.L;
    const was = pool.sqrtP;
    pool.sqrtP = st.next;
    if (st.next === target) {
      if (nx) pool.L += down ? -nx.net : nx.net;
      pool.tick = down ? tNext - 1 : tNext;
    } else if (st.next !== was) pool.tick = tickAt(st.next);
  }
  const ev = { v: pool.v, in: down ? 0 : 1, amountIn: gross, amountOut: 1n, sqrtPriceX96: pool.sqrtP, liquidity: pool.L, tick: pool.tick, fee: pool.v === 4 ? Number(sf) : null, block: pool.block, logIndex: pool.log++ };
  pool.events.push(ev);
  return ev;
}
function flash(pool, paid0, paid1) { // v3: paid less the protocol's 1/N; v4 donate: all of it
  const kind = pool.v === 3 ? 'flash' : 'donate';
  [paid0, paid1].forEach((paid, i) => {
    if (paid <= 0n) return;
    const n = pool.v === 3 ? BigInt(i === 0 ? pool.feeProtocol % 16 : pool.feeProtocol >> 4) : 0n;
    pool.fg[i] += ((paid - (n > 0n ? paid / n : 0n)) << 128n) / pool.L;
  });
  const e = { kind, v: pool.v, paid: [paid0, paid1], block: pool.block, logIndex: pool.log++ };
  pool.events.push(e);
  return e;
}
const metaOf = (p) => (p.v === 3 ? { fee: p.fee, feeProtocol: p.feeProtocol } : { protocolFee: p.protocolFee, lpFee: p.lpFee });
const mapOf = (p) => liquidityMap({ ticks: p.ticks.map((t) => ({ tick: t.tick, liquidityNet: t.net })), tickCurrent: p.tick, liquidity: p.L }).segments;
function run(pool, script) {
  const start = { sqrtPriceX96: pool.sqrtP, liquidity: pool.L }, then = [...pool.fg];
  script(pool);
  const swaps = pool.events.filter((e) => e.in != null), extras = pool.events.filter((e) => e.kind);
  return { start, then, now: [...pool.fg], swaps, extras, meta: metaOf(pool), path: pathIndex(mapOf(pool)) };
}
const near = (r, tol = 1e-6) => r.every((x) => x == null || Math.abs(x - 1) <= tol);
const replayRatio = (w, over = {}) => feeIdentityPath(replayFeeGrowth({ swaps: w.swaps, extras: w.extras, meta: w.meta, start: w.start, path: w.path, ...over }), w.then, w.now);
const E18 = 10n ** 18n;

test('tick maths: the exact sqrt prices match TickMath at the ends and the float formula everywhere', () => {
  assert.equal(sqrtRatioAtTick(0), 1n << 96n);
  assert.equal(sqrtRatioAtTick(MIN_TICK), 4295128739n);
  assert.equal(sqrtRatioAtTick(MAX_TICK), 1461446703485210103287273052203988822378723970342n);
  for (let i = 0; i < 20; i++) for (const t of [2 ** i, -(2 ** i), 2 ** i + 1]) {
    if (Math.abs(t) > MAX_TICK) continue;
    const f = Math.sqrt(Math.pow(1.0001, t)) * 2 ** 96;
    assert.ok(Math.abs(Number(sqrtRatioAtTick(t)) / f - 1) < 1e-9, `tick ${t}`);
  }
  assert.ok(sqrtRatioAtTick(-60) < sqrtRatioAtTick(-59));
});

test('v3: crossing swaps and a protocol cut replay exactly; the post-swap liquidity method misses', () => {
  const pool = makePool({ positions: [{ lo: -600, hi: 600, L: 10n ** 21n }, { lo: -120, hi: 120, L: 4n * 10n ** 21n }, { lo: 60, hi: 900, L: 2n * 10n ** 21n }], tick: 0, fee: 3000, feeProtocol: 0x64 });
  const w = run(pool, (p) => {
    swap(p, false, 30n * E18); // up through 60 and 120
    swap(p, true, 2n * E18);
    swap(p, true, 40n * E18); // back down through 120, 60, -120
    swap(p, false, 7n * E18);
    for (let i = 0; i < 20; i++) swap(p, i % 2 === 0, BigInt(1 + i) * 10n ** 17n);
  });
  const r = replayRatio(w);
  assert.ok(near(r), JSON.stringify(r));
  const rep = replayFeeGrowth(w);
  assert.ok(rep.sides[0].crossing + rep.sides[1].crossing >= 2);
  const old = feeIdentity(w.swaps, w.meta, w.then, w.now);
  assert.ok(old.some((x) => Math.abs(x - 1) > 0.02), `old method should miss here: ${JSON.stringify(old)}`);
});

test('v3: a swap across a stretch with no liquidity books nothing there; without the map it is caught', () => {
  const pool = makePool({ positions: [{ lo: -1200, hi: -60, L: 3n * 10n ** 21n }, { lo: 600, hi: 3000, L: 3n * 10n ** 21n }], tick: -100, fee: 500, feeProtocol: 0x44 });
  const w = run(pool, (p) => { swap(p, false, 400n * E18); swap(p, true, 500n * E18); swap(p, false, 100n * E18); });
  const r = replayRatio(w);
  assert.ok(near(r), JSON.stringify(r));
  const rep = replayFeeGrowth(w);
  assert.ok(rep.sides[0].empty + rep.sides[1].empty >= 2);
  const blind = replayRatio(w, { path: null });
  assert.ok(!near(blind, 0.02), `no map: the gap is booked as if it held liquidity ${JSON.stringify(blind)}`);
});

test('v3: flash payments count (less the protocol 1/N); leaving them out, or a missed swap, is caught', () => {
  const pool = makePool({ positions: [{ lo: -6000, hi: 6000, L: 10n ** 22n }], tick: 10, fee: 3000, feeProtocol: 0x55 });
  const w = run(pool, (p) => {
    for (let i = 0; i < 12; i++) swap(p, i % 3 === 0, BigInt(5 + i) * E18);
    flash(p, 3n * 10n ** 16n, 4n * 10n ** 16n);
    swap(p, false, E18);
  });
  assert.ok(near(replayRatio(w)), JSON.stringify(replayRatio(w)));
  assert.ok(!near(replayRatio(w, { extras: [] }), 0.02));
  // a duplicated event (same price twice) would book its whole input as fee: it is bounded and counted
  const dup = { ...w, swaps: [...w.swaps.slice(0, 5), { ...w.swaps[4] }, ...w.swaps.slice(5)] };
  const rd = replayRatio(dup), sd = replayFeeGrowth(dup).sides;
  assert.ok(!near(rd, 0.02) && rd.every((x) => x == null || x < 1.5), JSON.stringify(rd));
  assert.equal(sd[0].inconsistent + (sd[1].inconsistent || 0) >= 1 || sd[0].still + sd[1].still >= 1, true);
  const missed = { ...w, swaps: w.swaps.filter((_, i) => i !== 4) };
  assert.ok(!near(replayRatio(missed), 0.02));
  assert.ok(!near(replayRatio(w, { meta: { fee: 3000, feeProtocol: 0 } }), 0.02), 'a protocol fee read as off is caught');
});

test('v4: dynamic fees, a protocol fee on the gross input and donations replay exactly; faults are caught', () => {
  const pool = makePool({ v: 4, positions: [{ lo: -3000, hi: 3000, L: 10n ** 21n }, { lo: -600, hi: 1200, L: 5n * 10n ** 21n }], tick: 0, lpFee: 500, protocolFee: 300 | (200 << 12) });
  const w = run(pool, (p) => {
    swap(p, false, 420n * E18, { lpFee: 500 }); // up through 1200
    swap(p, true, 650n * E18, { lpFee: 3000 }); // down through 1200 and -600, at a hook's override the event carries
    swap(p, false, 10n * E18, { lpFee: 100 });
    flash(p, 10n ** 17n, 0n);
    for (let i = 0; i < 10; i++) swap(p, i % 2 === 1, BigInt(1 + i) * 10n ** 17n, { lpFee: 500 + 100 * i });
  });
  assert.ok(near(replayRatio(w)), JSON.stringify(replayRatio(w)));
  assert.ok(!near(replayRatio(w, { meta: { protocolFee: 0, lpFee: 500 } }), 0.02), 'protocol fee read as off');
  assert.ok(!near(replayRatio(w, { extras: [] }), 0.02), 'donation left out');
  // the crossing swaps' rate comes from the event's fee: a misread fee word is caught
  const wrong = { ...w, swaps: w.swaps.map((s) => ({ ...s, fee: s.fee + 2000 })) };
  assert.ok(replayFeeGrowth(w).sides.every((x) => x.crossing >= 1));
  assert.ok(!near(replayRatio(wrong), 0.02), JSON.stringify(replayRatio(wrong)));
});

test('dust swaps: rounding is replayed unit for unit, where fee × input ÷ liquidity is far off', () => {
  const pool = makePool({ positions: [{ lo: -887220, hi: 887220, L: 10n ** 9n }], tick: 0, fee: 500, feeProtocol: 0 });
  const w = run(pool, (p) => { for (let i = 0; i < 40; i++) swap(p, i % 2 === 0, 1500n + BigInt(i)); });
  assert.ok(near(replayFeeRatio(w), 0.02), JSON.stringify(replayFeeRatio(w)));
  const old = feeIdentity(w.swaps, w.meta, w.then, w.now);
  assert.ok(old.some((x) => x == null || Math.abs(x - 1) > 0.02), JSON.stringify(old));
});
function replayFeeRatio(w) { return replayRatio(w); }

test('unread starts and counters give null; a counter that moved with nothing replayed is a miss', () => {
  assert.equal(replayFeeGrowth({ swaps: [], meta: { fee: 3000, feeProtocol: 0 }, start: null }), null);
  const rep = replayFeeGrowth({ swaps: [], meta: { fee: 3000, feeProtocol: 0 }, start: { sqrtPriceX96: 1n << 96n, liquidity: 10n } });
  assert.equal(feeIdentityPath(rep, null, [1n, 1n]), null);
  assert.deepEqual(feeIdentityPath(rep, [5n, 5n], [5n, 9n]), [null, 0]);
});

test('flash and donate events decode; hooks that return swap deltas are flagged from the address bits', () => {
  const W = (v) => BigInt(v).toString(16).padStart(64, '0');
  const f = decodeExtra({ address: '0x' + 'ab'.repeat(20), topics: [EXTRA_TOPICS.flash, '0x' + W(1), '0x' + W(2)], data: '0x' + W(10) + W(0) + W(7) + W(0), blockNumber: '0x10', logIndex: '0x2' });
  assert.deepEqual([f.kind, f.paid[0], f.paid[1], f.block, f.logIndex], ['flash', 7n, 0n, 16, 2]);
  const d = decodeExtra({ address: '0x' + '44'.repeat(20), topics: [EXTRA_TOPICS.donate, '0x' + 'c'.repeat(64), '0x' + W(3)], data: '0x' + W(5) + W(6), blockNumber: '0x11', logIndex: '0x0' });
  assert.deepEqual([d.kind, d.pool, d.paid[1]], ['donate', '0x' + 'c'.repeat(64), 6n]);
  assert.equal(decodeExtra({ topics: ['0x' + '1'.repeat(64)], data: '0x' }), null);
  assert.equal(hookReturnsSwapDelta('0x0000000000000000000000000000000000000000'), false);
  assert.equal(hookReturnsSwapDelta('0x00000000000000000000000000000000000000c0'), false); // before/after swap only
  assert.equal(hookReturnsSwapDelta('0x0000000000000000000000000000000000000088'), true); // beforeSwap + returns delta
  assert.equal(hookReturnsSwapDelta('0x0000000000000000000000000000000000000044'), true); // afterSwap + returns delta
  assert.equal(hookReturnsSwapDelta(null), null);
});
