import test from 'node:test';
import assert from 'node:assert/strict';
import { selector } from '../lib/keccak.mjs';
import { readMaps, wordsFor, readFeeGrowth, feeGrowthCalls } from '../lib/maps.mjs';
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
