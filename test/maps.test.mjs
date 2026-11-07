import test from 'node:test';
import assert from 'node:assert/strict';
import { selector } from '../lib/keccak.mjs';
import { readMaps, wordsFor, readFeeGrowth, feeGrowthCalls, readNearMaps, walkNear, nearWindow, wordOf } from '../lib/maps.mjs';
import { bandStats } from '../lib/shape.mjs';
import { sqrtAtTick, ticksForLog } from '../lib/v3math.mjs';
import { poolFrom } from './v3math.test.mjs';

const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const SV = '0x' + '5'.repeat(40);
const SEL = { bm3: selector('tickBitmap(int16)'), t3: selector('ticks(int24)'), bm4: selector('getTickBitmap(bytes32,int16)'), t4: selector('getTickLiquidity(bytes32,int24)') };

// Made-up pools: positions → initialized ticks; a fake multicall answers bitmap and tick reads from them.
function world(defs) {
  const pools = new Map();
  for (const d of defs) {
    const p = poolFrom(d.positions, d.tick);
    pools.set(d.id, { ...d, net: new Map(p.ticks.map((t) => [t.tick, t.liquidityNet])), liquidity: p.liquidity });
  }
  return pools;
}
function fakeMc(pools, { dropTick = null, dropWord = null } = {}) {
  return async (calls) => calls.map(({ target, data }) => {
    const sel = data.slice(0, 10), v4 = sel === SEL.bm4 || sel === SEL.t4;
    const id = v4 ? '0x' + data.slice(10, 74) : target;
    const arg = Number(BigInt.asIntN(256, BigInt('0x' + (v4 ? data.slice(74, 138) : data.slice(10, 74)))));
    const P = pools.get(id);
    if (sel === SEL.bm3 || sel === SEL.bm4) {
      if (arg === dropWord) return null;
      let bm = 0n;
      for (const t of P.net.keys()) { const c = t / P.tickSpacing, wi = Math.floor(c / 256); if (wi === arg) bm |= 1n << BigInt(c - wi * 256); }
      return { ok: true, data: '0x' + W(bm) };
    }
    if (arg === dropTick) return { ok: false, data: '0x' };
    const n = P.net.get(arg) || 0n;
    return { ok: true, data: '0x' + W(n < 0n ? -n : n) + W(n) + (sel === SEL.t3 ? W(0).repeat(6) : '') };
  });
}

const V3 = { v: 3, id: '0x' + 'a'.repeat(40), tickSpacing: 60, tick: 125, positions: [{ lo: -4200, hi: -2400, L: 10n ** 21n }, { lo: 1800, hi: 3600, L: 8n * 10n ** 20n }, { lo: -300, hi: 300, L: 2n * 10n ** 19n }, { lo: -887220, hi: 887220, L: 10n ** 18n }] };
const V4 = { v: 4, id: '0x' + 'b'.repeat(64), tickSpacing: 10, tick: -205, positions: [{ lo: -1000, hi: 500, L: 3n * 10n ** 18n }, { lo: -887270, hi: 887270, L: 10n ** 17n }] };

test('maps: v3 and v4 rebuilt in one pass, complete and matching each pool', async () => {
  const pools = world([V3, V4]);
  const input = [...pools.values()].map(({ v, id, tickSpacing, tick, liquidity }) => ({ v, id, tickSpacing, tick, liquidity }));
  const [m3, m4] = await readMaps(fakeMc(pools), input, { stateView: SV });
  for (const m of [m3, m4]) {
    assert.equal(m.checks.netSumZero, true);
    assert.equal(m.checks.neverNegative, true);
    assert.equal(m.checks.matchesPool, true);
  }
  assert.equal(m3.checks.initialized, 8);
  assert.equal(m4.checks.initialized, 4);
  assert.equal(m3.words, wordsFor(60).length);
  assert.equal(wordsFor(60).length, 116);
  assert.equal(wordsFor(1).length, 6932);
});

test('maps: one unread tick or bitmap word makes that map unread, never partial', async () => {
  const pools = world([V3, V4]);
  const input = [...pools.values()].map(({ v, id, tickSpacing, tick, liquidity }) => ({ v, id, tickSpacing, tick, liquidity }));
  const a = await readMaps(fakeMc(pools, { dropTick: 1800 }), input, { stateView: SV });
  assert.deepEqual(a[0], { unread: 'ticks', missing: 1 });
  assert.equal(a[1].checks.matchesPool, true); // the other pool is unaffected
  const b = await readMaps(fakeMc(pools, { dropWord: -1 }), input, { stateView: SV });
  assert.equal(b[0].unread, 'bitmap');
  assert.equal(b[1].unread, 'bitmap');
});

test('maps: planted faults are caught by the checks', async () => {
  const pools = world([V3]);
  const p = [...pools.values()][0];
  // the pool reports a different active liquidity than its ticks add up to
  const [m] = await readMaps(fakeMc(pools), [{ ...p, liquidity: p.liquidity + 1n }], { stateView: SV });
  assert.equal(m.checks.matchesPool, false);
  // a tick lost from the bitmap: the walk no longer sums to zero
  const lossy = new Map(pools);
  lossy.set(p.id, { ...p, net: new Map([...p.net].filter(([t]) => t !== 3600)) });
  const [m2] = await readMaps(fakeMc(lossy), [{ ...p }], { stateView: SV });
  assert.equal(m2.checks.netSumZero, false);
});

test('fee growth reads: v3 two calls, v4 one; unread is null', () => {
  const v3 = { v: 3, id: '0x' + 'a'.repeat(40) }, v4 = { v: 4, id: '0x' + 'b'.repeat(64) };
  assert.equal(feeGrowthCalls(v3, SV).length, 2);
  assert.equal(feeGrowthCalls(v4, SV).length, 1);
  assert.deepEqual(readFeeGrowth(v3, [{ ok: true, data: '0x' + W(5) }, { ok: true, data: '0x' + W(7) }]), [5n, 7n]);
  assert.deepEqual(readFeeGrowth(v4, [{ ok: true, data: '0x' + W(5) + W(7) }]), [5n, 7n]);
  assert.equal(readFeeGrowth(v3, [{ ok: true, data: '0x' + W(5) }, null]), null);
});

// ---------- the near-price map (readNearMaps): only the words around the price, walked from the pool's liquidity
const NEAR = { v: 3, id: '0x' + 'c'.repeat(40), tickSpacing: 60, tick: 30, positions: [{ lo: -600, hi: 900, L: 4n * 10n ** 18n }, { lo: 300, hi: 1200, L: 7n * 10n ** 18n },
  { lo: -1500, hi: -60, L: 2n * 10n ** 18n }, { lo: -120, hi: 60, L: 9n * 10n ** 18n }, { lo: 2400, hi: 4800, L: 5n * 10n ** 19n }, { lo: -887220, hi: 887220, L: 10n ** 17n }] };
const NEAR4 = { v: 4, id: '0x' + 'd'.repeat(64), tickSpacing: 1, tick: -3, positions: [{ lo: -700, hi: 650, L: 3n * 10n ** 18n }, { lo: -2, hi: 5, L: 10n ** 19n }, { lo: -887272, hi: 887272, L: 10n ** 16n }] };
const inside = (segs, sp, tick, r) => { const t = ticksForLog(r); return bandStats(segs, sp, 0, tick - t, tick + t, tick).inside; };

test('near maps: the value within ±1%, ±5%, ±9% equals the full map\'s, v3 and v4, from a few words', async () => {
  const pools = world([NEAR, NEAR4]);
  const input = [...pools.values()].map(({ v, id, tickSpacing, tick, liquidity }) => ({ v, id, tickSpacing, tick, liquidity }));
  const full = await readMaps(fakeMc(pools), input, { stateView: SV });
  const near = await readNearMaps(fakeMc(pools), input, { stateView: SV, r: 0.09 });
  for (let i = 0; i < input.length; i++) {
    const sp = sqrtAtTick(input[i].tick + 0.4);
    assert.equal(near[i].checks.neverNegative, true);
    for (const r of [0.01, 0.05, 0.09]) {
      const a = inside(full[i].segments, sp, input[i].tick, r), b = inside(near[i].segments, sp, input[i].tick, r);
      assert.ok(a > 0 && Math.abs(b / a - 1) < 1e-12, `pool ${i} ±${r}: near ${b} vs full ${a}`);
    }
  }
  assert.equal(near[0].words, 2); // spacing 60: ±9% around tick 30 spans words −1 and 0, not 116
  assert.ok(near[1].words <= 9 && near[1].words < wordsFor(1).length / 500);
  assert.equal(near[0].checks.initialized, 6); // -600 -120 -60 60 300 900 inside the ±960-tick window; 1200 and beyond are not read
});

test('near maps: a window wider than the band is required, and words cover it', () => {
  const w = nearWindow(30, 60, 0.09);
  assert.ok(w.hi - 30 >= ticksForLog(0.09) && 30 - w.lo >= ticksForLog(0.09));
  assert.equal(w.words[0], wordOf(w.lo, 60));
  assert.equal(w.words.at(-1), wordOf(w.hi, 60));
  assert.equal(wordOf(-1, 1), -1); // negative ticks round down, like the pool's own compress
  assert.equal(wordOf(-60, 60), -1);
  assert.equal(wordOf(255 * 60, 60), 0);
});

test('near maps: planted faults are unread or caught, never a partial number', async () => {
  const pools = world([NEAR, NEAR4]);
  const input = [...pools.values()].map(({ v, id, tickSpacing, tick, liquidity }) => ({ v, id, tickSpacing, tick, liquidity }));
  // a tick read that fails → that pool unread; the other pool unaffected
  const a = await readNearMaps(fakeMc(pools, { dropTick: 300 }), input, { stateView: SV });
  assert.deepEqual(a[0], { unread: 'ticks', missing: 1 });
  assert.equal(a[1].checks.neverNegative, true);
  // a bitmap word unread → unread
  const b = await readNearMaps(fakeMc(pools, { dropWord: 0 }), input, { stateView: SV });
  assert.equal(b[0].unread, 'bitmap');
  // no active liquidity read → unread, not a walk from 0
  const c = await readNearMaps(fakeMc(pools), [{ ...input[0], liquidity: null }], { stateView: SV });
  assert.equal(c[0].unread, 'liquidity');
  // the pool's liquidity disagrees with its ticks so the walk goes negative → unread
  const d = await readNearMaps(fakeMc(pools), [{ ...input[0], liquidity: 10n ** 17n }], { stateView: SV });
  assert.equal(d[0].unread, 'negative');
  // a lost tick inside the window changes the value: the cross-check against the full map catches it
  const p = pools.get(NEAR.id), lossy = new Map(pools);
  lossy.set(p.id, { ...p, net: new Map([...p.net].filter(([t]) => t !== 300)) });
  const [full] = await readMaps(fakeMc(pools), [input[0]], { stateView: SV });
  const [bad] = await readNearMaps(fakeMc(lossy), [input[0]], { stateView: SV });
  const sp = sqrtAtTick(30.4);
  assert.ok(Math.abs(inside(bad.segments, sp, 30, 0.09) / inside(full.segments, sp, 30, 0.09) - 1) > 0.01);
});

test('near maps: the walk splits at the price and signs crossings like the pool', () => {
  const m = walkNear({ ticks: [{ tick: -10, liquidityNet: 5n }, { tick: 10, liquidityNet: -5n }, { tick: 20, liquidityNet: 3n }], tickCurrent: 0, liquidity: 5n, lo: -30, hi: 30 });
  assert.deepEqual(m.segments.map((s) => [s.lo, s.hi, s.L]), [[-30, -10, 0n], [-10, 0, 5n], [0, 10, 5n], [10, 20, 0n], [20, 30, 3n]]);
  // a tick exactly at the price counts as crossed (v3: liquidity at tick t includes t's net)
  const n = walkNear({ ticks: [{ tick: 0, liquidityNet: 5n }], tickCurrent: 0, liquidity: 5n, lo: -10, hi: 10 });
  assert.deepEqual(n.segments.map((s) => [s.lo, s.hi, s.L]), [[-10, 0, 0n], [0, 10, 5n]]);
});
