import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidityMap } from '../lib/v3math.mjs';
import { stickyShare, strandedShare } from '../lib/persistence.mjs';
import { poolFrom } from './v3math.test.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const seg = (positions, tick = 0) => { const m = liquidityMap(poolFrom(positions, tick)); return { s: m.segments, L: m.checks.walkedLiquidity }; };
const at = { tick: 0, sp: 1, d1: 18 };

// Made-up walls: one below the price, one above, a thin slice at the price.
const wallBelow = { lo: -4200, hi: -2400, L: 10n ** 21n }, wallAbove = { lo: 1800, hi: 3600, L: 10n ** 21n }, slice = { lo: -300, hi: 300, L: 10n ** 19n };

test('sticky share: walls that stayed put count in full, walls that arrived since count zero', () => {
  const now = seg([wallBelow, wallAbove, slice]);
  assert.ok(near(stickyShare(now.s, now.s, { ...at, activeL: now.L }), 1, 1e-12));
  const before = seg([wallBelow, slice]); // the wall above arrived later
  const v = stickyShare(now.s, before.s, { ...at, activeL: now.L });
  assert.ok(v > 0.3 && v < 0.7, `share ${v}`);
  const empty = seg([slice]);
  assert.equal(stickyShare(now.s, empty.s, { ...at, activeL: now.L }), 0);
  assert.equal(stickyShare(empty.s, empty.s, { ...at, activeL: empty.L }), null); // nothing parked today
  assert.equal(stickyShare(null, now.s, { ...at, activeL: now.L }), null);
});

test('sticky share: a wall that shrank keeps only what is left of it', () => {
  const now = seg([wallBelow, slice]);
  const half = seg([{ ...wallBelow, L: wallBelow.L / 2n }, slice]);
  // parked today: 1e21 − 1e19 (the level at the price); still there from before: 5e20 − 1e19
  assert.ok(near(stickyShare(now.s, half.s, { ...at, activeL: now.L }), (5e20 - 1e19) / (1e21 - 1e19), 1e-9));
});

test('stranded share: needs half the snapshots read; missing is not zero', () => {
  assert.equal(strandedShare([0.9, 0.85, 0.5, 0.95]), 0.75);
  assert.equal(strandedShare([0.9, null, null, null]), null);
  assert.equal(strandedShare([0.9, null, 0.7, null]), 0.5);
});
