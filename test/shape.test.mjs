import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidityMap, valueInRange, ticksForLog } from '../lib/v3math.mjs';
import { bandStats, hollowness, depthHistogram, nearestWalls, wallSigma, shapeTag, strandedDays } from '../lib/shape.mjs';

const shapeOf = (positions, tick = 0) => {
  const m = liquidityMap(poolFrom(positions, tick));
  return hollowness(m.segments, 1, 18, tick, m.checks.walkedLiquidity);
};
import { poolFrom } from './v3math.test.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const band = Math.round(ticksForLog(0.09)); // ±9% in ticks

// Made-up "stranded" pool: big walls far below and above, a thin slice at the price.
const strandedPositions = [
  { lo: -4200, hi: -2400, L: 10n ** 21n },
  { lo: 1800, hi: 3600, L: 8n * 10n ** 20n },
  { lo: -300, hi: 300, L: 2n * 10n ** 19n },
];

test('band split is exact: inside + outside = total, matches an independent sum', () => {
  const m = liquidityMap(poolFrom(strandedPositions, 0));
  const b = bandStats(m.segments, 1, 18, -band, band, 0);
  assert.ok(near(b.inside + b.outside, b.total, 1e-9 * b.total));
  const v = (p) => valueInRange(p.L, p.lo, p.hi, 1, 18);
  const expectedOut = v(strandedPositions[0]) + v(strandedPositions[1]);
  assert.ok(near(b.stranded, expectedOut / (expectedOut + v(strandedPositions[2])), 1e-9));
  assert.ok(b.stranded > 0.9);
});

test('hollowness: walls far from a thin price read as stranded', () => {
  const h = shapeOf(strandedPositions);
  assert.ok(h.hollow > 0.9, `hollow ${h.hollow}`);
  assert.ok(h.aboveShare > 0.15 && h.aboveShare < 0.85);
  assert.equal(shapeTag(h), 'stranded');
  assert.equal(shapeTag(shapeOf([{ lo: 1800, hi: 4200, L: 10n ** 21n }, { lo: -300, hi: 300, L: 10n ** 19n }])), 'one-sided');
  assert.equal(shapeTag({ hollow: null }), null);
});

test('regression: wide positions that include the price are served, not stranded', () => {
  // The first definition (value outside a ±9% band) called this pool stranded; on the real chain it
  // read 80% for UNI/WETH 0.3%. Wide liquidity includes the price, so it must count as zero.
  const wide = [{ lo: -887220, hi: 887220, L: 10n ** 20n }, { lo: -20000, hi: 20000, L: 5n * 10n ** 19n }];
  const m = liquidityMap(poolFrom(wide, 0));
  assert.ok(bandStats(m.segments, 1, 18, -band, band, 0).stranded > 0.8); // the old lens misfires here
  const h = shapeOf(wide);
  assert.ok(h.hollow < 0.01, `hollow ${h.hollow}`);
  assert.equal(shapeTag(h), 'served');
  assert.equal(shapeTag(shapeOf([{ lo: -600, hi: 600, L: 10n ** 21n }, { lo: -4200, hi: 4200, L: 10n ** 19n }])), 'served'); // peaked at the price
});

test('depth histogram and walls: the big walls are found on the right sides', () => {
  const m = liquidityMap(poolFrom(strandedPositions, 0));
  const h = depthHistogram(m.segments, 1, 18, 0, { span: 0.45, buckets: 48 });
  const b = bandStats(m.segments, 1, 18, -ticksForLog(0.45), ticksForLog(0.45), 0);
  assert.ok(near(h.buckets.reduce((x, y) => x + y, 0), b.inside, 1e-6 * b.inside));
  const w = nearestWalls(h);
  assert.ok(w.below > 0.18 && w.below < 0.42, `below ${w.below}`);
  assert.ok(w.above > 0.13 && w.above < 0.36, `above ${w.above}`);
  assert.ok(near(wallSigma(0.21, 0.034, 7), 0.21 / (0.034 * Math.sqrt(7)), 1e-12));
  assert.equal(wallSigma(null, 0.03), null);
  // a single full-range position has no wall in view: far away, not missing
  const flat = liquidityMap(poolFrom([{ lo: -887220, hi: 887220, L: 10n ** 20n }], 0));
  const fw = nearestWalls(depthHistogram(flat.segments, 1, 18, 0));
  assert.equal(fw.below, Infinity);
  assert.equal(fw.above, Infinity);
  assert.equal(wallSigma(Infinity, 0.03), Infinity);
});

test('stranded days: a window needs at least half its days, missing is not zero', () => {
  assert.equal(strandedDays([0.9, 0.95, 0.7, null]), 2);
  assert.equal(strandedDays([0.9, null, null, null]), null);
});
