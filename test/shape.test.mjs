import test from 'node:test';
import assert from 'node:assert/strict';
import { liquidityMap, valueInRange, ticksForLog, logForTicks, MIN_TICK, MAX_TICK } from '../lib/v3math.mjs';
import { bandStats, hollowness, depthHistogram, nearestWalls, wallSigma, shapeTag, strandedDays, depthProfile, depthFields, fullRangeLayer, DEPTH } from '../lib/shape.mjs';

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

// ---------- the wider liquidity chart (depthProfile): ±45% fine bins as before, coarser to about ±64%, far bins
// doubling out to the last tick, then beyond. These first tests run it with the options of the version before the
// whole field (far bins capped at ×10 / ÷10, no full-range layer) and show it is unchanged; the whole field follows. ----------
const OLD = { far: Math.LN10, wide: null };
// Made-up maps at two prices: one at tick 0 (18 decimals) and one far from it (6 decimals), so offsets
// and values are checked away from the easy case.
const at = (positions, tick) => positions.map((q) => ({ lo: q.lo + tick, hi: q.hi + tick, L: q.L }));
const spAt = (tick) => Math.pow(1.0001, tick / 2);
const CASES = [[0, 18], [-201000, 6]];
// walls in the coarse zone (+0.55..+0.60 log) and past it (+0.80..+0.90, −0.70..−0.66), plus a thin full range
const widePositions = [...strandedPositions,
  { lo: 5500, hi: 6000, L: 3n * 10n ** 20n }, { lo: 8000, hi: 9000, L: 4n * 10n ** 20n }, { lo: -7000, hi: -6600, L: 2n * 10n ** 20n },
  { lo: -887220, hi: 887220, L: 10n ** 18n }];
const rel = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-30);
// a bin's tick edges, from the edges the profile publishes
const edgesOf = (b, tick) => [tick + ticksForLog(b.a), tick + ticksForLog(b.b)];
const OUTER = 0.6375, LN10 = Math.LN10;
// the far ladder past ±0.6375: widths 0.075, 0.15, 0.3, 0.6, then cut at ln 10
const LADDER = [0.7125, 0.8625, 1.1625, 1.7625, LN10];
// the whole field's ladder: the same widths doubling on with no cap (the last bin is cut at the tick limit, ±88.72 from tick 0)
const WHOLE_LADDER = [0.7125, 0.8625, 1.1625, 1.7625, 2.9625, 5.3625, 10.1625, 19.7625, 38.9625, 77.3625];
// The coarse bins exactly as the first wider chart computed them (copied from that code), to show they are unchanged.
const oldCoarse = (segs, sp, d1, tick) => {
  const half = ticksForLog(0.45), cw = (4 * half) / 48, cl = logForTicks(cw), v = (a, b) => bandStats(segs, sp, d1, a, b, tick).inside;
  return [...[5, 4, 3, 2, 1].map((j) => [-0.45 - (j - 0.5) * cl, v(tick - half - j * cw, tick - half - (j - 1) * cw)]),
    ...[1, 2, 3, 4, 5].map((j) => [0.45 + (j - 0.5) * cl, v(tick + half + (j - 1) * cw, tick + half + j * cw)])];
};

test('depth profile (old options): the ±45% bins are the old histogram exactly; coarse bins as before; far bins and beyond hold the rest', () => {
  for (const [tick, d1] of CASES) {
    const sp = spAt(tick), m = liquidityMap(poolFrom(at(widePositions, tick), tick));
    const prof = depthProfile(m.segments, sp, d1, tick, OLD);
    const old = depthHistogram(m.segments, sp, d1, tick);
    assert.deepEqual(prof.hist, old, 'the fine part is depthHistogram itself');
    const nc = DEPTH.coarseBins, nf = DEPTH.fineBins, nfar = LADDER.length; // the thin full range reaches past the cap both ways
    assert.equal(prof.bins.length, nf + 2 * nc + 2 * nfar);
    for (let i = 0; i < nf; i++) {
      assert.equal(prof.bins[nfar + nc + i].v, old.buckets[i], `fine bin ${i} value`);
      assert.equal(prof.bins[nfar + nc + i].o, -old.span + (i + 0.5) * old.bucketLog, `fine bin ${i} centre`);
    }
    const coarse = [...prof.bins.slice(nfar, nfar + nc), ...prof.bins.slice(nfar + nc + nf, nfar + 2 * nc + nf)];
    oldCoarse(m.segments, sp, d1, tick).forEach(([o, v], k) => { assert.equal(coarse[k].o, o, `coarse ${k} centre`); assert.ok(rel(coarse[k].v, v, 1e-9), `coarse ${k} value`); });
    for (let k = 1; k < prof.bins.length; k++) {
      assert.ok(prof.bins[k].o > prof.bins[k - 1].o, 'centres ascend');
      assert.ok(Math.abs(prof.bins[k].a - prof.bins[k - 1].b) < 1e-12, 'bins touch: no gap, no overlap');
    }
    // the edges: bins + 1 of them, the far ones doubling in width and cut at ln 10
    assert.equal(prof.edges.length, prof.bins.length + 1);
    const far = prof.edges.slice(-nfar);
    LADDER.forEach((e, k) => { assert.ok(rel(far[k], e, 1e-12), `far edge ${k}: ${far[k]} vs ${e}`); assert.ok(rel(-prof.edges[nfar - 1 - k], e, 1e-12)); });
    assert.ok(rel(prof.span[1], LN10, 1e-12) && rel(prof.span[0], -LN10, 1e-12), `span ${prof.span}`);
    assert.ok(rel(prof.step.coarse, 2 * prof.step.fine, 1e-12) && prof.step.edge === 0.45);
    // every coarse and far bin and each beyond against an independent sum (bandStats clips each segment its own way)
    const inside = (a, b) => bandStats(m.segments, sp, d1, a, b, tick).inside;
    prof.bins.forEach((b, k) => { if (Math.abs(b.o) > 0.45) { const [x, y] = edgesOf(b, tick); assert.ok(rel(b.v, inside(x, y), 1e-9), `bin ${k}`); } });
    const outer = ticksForLog(LN10);
    assert.ok(rel(prof.beyond.below, inside(MIN_TICK, tick - outer), 1e-9) && rel(prof.beyond.above, inside(tick + outer, MAX_TICK), 1e-9));
    // everything adds up to the whole map: nothing lost past the chart, nothing counted twice
    const total = m.segments.reduce((a, s) => a + (s.L > 0n ? valueInRange(s.L, s.lo, s.hi, sp, d1) : 0), 0);
    const sum = prof.bins.reduce((a, b) => a + b.v, 0) + prof.beyond.below + prof.beyond.above;
    assert.ok(rel(sum, total, 1e-9), `bins + beyond ${sum} vs map ${total}`);
    // the walls land where they sit: +0.55..+0.60 in the coarse bins, the far ones in the far bins now (beyond until this change)
    const v = (lo, hi, L) => valueInRange(L, lo + tick, hi + tick, sp, d1);
    const span = (lo, hi) => prof.bins.filter((b) => b.a >= lo - 1e-9 && b.b <= hi + 1e-9).reduce((a, b) => a + b.v, 0);
    assert.ok(span(0.45, OUTER) >= v(5500, 6000, 3n * 10n ** 20n), 'the +55% wall is in the coarse bins');
    assert.ok(span(OUTER, LN10) >= v(8000, 9000, 4n * 10n ** 20n) && span(-LN10, -OUTER) >= v(-7000, -6600, 2n * 10n ** 20n), 'the far walls are on the chart now');
    assert.ok(prof.beyond.above < v(Math.round(outer), 887220, 10n ** 18n) * 1.001 && prof.beyond.below < v(-887220, -Math.round(outer), 10n ** 18n) * 1.001, 'beyond holds only the thin full range past ×10');
  }
});

test('far bins stop at the furthest initialized tick: past it beyond is a real 0, and a near map keeps the old 58 bars', () => {
  // no full range: the last tick above is +0.90 (the far wall's top), below −0.70
  const positions = widePositions.filter((q) => q.lo !== -887220);
  for (const [tick, d1] of CASES) {
    const sp = spAt(tick), m = liquidityMap(poolFrom(at(positions, tick), tick));
    const prof = depthProfile(m.segments, sp, d1, tick);
    // above: 0.7125 < 0.90 → 0.8625 < 0.90 → 1.1625 holds it; below: 0.7125 holds −0.70
    assert.deepEqual(prof.span.map((x) => Number(x.toFixed(4))), [-0.7125, 1.1625]);
    assert.equal(prof.bins.length, 58 + 1 + 3);
    assert.equal(prof.beyond.above, 0, 'nothing past the last tick: a real 0');
    assert.equal(prof.beyond.below, 0);
    const total = m.segments.reduce((a, s) => a + (s.L > 0n ? valueInRange(s.L, s.lo, s.hi, sp, d1) : 0), 0);
    assert.ok(rel(prof.bins.reduce((a, b) => a + b.v, 0), total, 1e-9), 'the bins alone hold the whole map');
  }
  // a map that ends inside ±0.6375 has exactly the bars, span and steps the scan published before
  const m = liquidityMap(poolFrom(strandedPositions, 0));
  const f = depthFields(depthProfile(m.segments, 1, 18, 0), 2250);
  assert.equal(f.depth.length, 58);
  assert.deepEqual(f.depthSpan, [-0.6375, 0.6375]);
  assert.deepEqual(f.depthStep, { fine: 0.01875, coarse: 0.0375, edge: 0.45 });
  assert.equal(f.depthEdges.length, 59);
  assert.deepEqual([f.depthEdges[0], f.depthEdges[5], f.depthEdges[6], f.depthEdges[53], f.depthEdges[58]], [-0.6375, -0.45, -0.43125, 0.45, 0.6375]);
  assert.ok(f.depth.every(([o], i) => o > f.depthEdges[i] && o < f.depthEdges[i + 1]), 'each centre sits between its edges');
});

test('regression: parked, above, band9 and walls are computed exactly as before the wider chart', () => {
  // Golden values from the code before depthProfile existed (same made-up map, same calls as the scan).
  const GOLD = {
    0: { parked: 0.9735775183089591, above: 0.4505966811637053, band9: 0.0042579441713627795, walls: { below: 0.253125, above: 0.196875 } },
    [-201000]: { parked: 0.9735775183089587, above: 0.45059668116370516, band9: 0.004257944171362759, walls: { below: 0.253125, above: 0.196875 } },
  };
  for (const [tick, d1] of CASES) {
    for (const positions of [strandedPositions, widePositions]) {
      const sp = spAt(tick), m = liquidityMap(poolFrom(at(positions, tick), tick));
      const h = hollowness(m.segments, sp, d1, tick, m.checks.walkedLiquidity, { near: 0.02 });
      const t9 = ticksForLog(0.09), b9 = bandStats(m.segments, sp, d1, tick - t9, tick + t9, tick);
      const walls = nearestWalls(depthHistogram(m.segments, sp, d1, tick)), g = GOLD[tick];
      if (positions === strandedPositions) {
        assert.ok(rel(h.hollow, g.parked, 1e-12) && rel(h.aboveShare, g.above, 1e-12) && rel(b9.inside / b9.total, g.band9, 1e-12), `tick ${tick}`);
        assert.deepEqual(walls, g.walls);
      }
      // the profile's own histogram finds the very same walls, with or without the full-range layer taken off the bars
      const prof = depthProfile(m.segments, sp, d1, tick, OLD);
      assert.deepEqual(nearestWalls(prof.hist), walls);
      assert.deepEqual(nearestWalls(depthProfile(m.segments, sp, d1, tick).hist), walls);
      // live.json's ±45% bars are byte for byte what the scan published before (the old formula, copied)
      const per1 = 2250, rnd = (x, n) => (Number.isFinite(x) ? Number(x.toPrecision(n)) : null), hist = depthHistogram(m.segments, sp, d1, tick);
      const before = hist.buckets.map((v, i) => [rnd(-hist.span + (i + 0.5) * hist.bucketLog, 4), rnd(v * per1, 5)]);
      const f = depthFields(prof, per1);
      assert.deepEqual(f.depth.filter(([o]) => Math.abs(o) < 0.45), before, 'the bars inside ±45% are exactly the old ones');
      // and so are the coarse bars out to ±0.6375
      const coarse = oldCoarse(m.segments, sp, d1, tick).map(([o, v]) => [rnd(o, 4), rnd(v * per1, 5)]);
      assert.deepEqual(f.depth.filter(([o]) => Math.abs(o) > 0.45 && Math.abs(o) < OUTER), coarse, 'the coarse bars too');
    }
  }
});

test('planted fault: an unread chunk gives null bins and a null beyond, never 0', () => {
  // A wall at +0.37..+0.41 sits in a tick chunk that was not read: its ticks are missing from the map,
  // so the map looks empty there. The old histogram draws that as 0 (a fake drop); the profile must not.
  const tick = 0, sp = 1, d1 = 18, chunk = [3600, 4200];
  const positions = [...strandedPositions.filter((q) => q.lo !== 1800), { lo: 3700, hi: 4100, L: 9n * 10n ** 20n }, { lo: -887220, hi: 887220, L: 10n ** 18n }];
  const read = poolFrom(positions, tick);
  read.ticks = read.ticks.filter((t) => !(t.tick >= chunk[0] && t.tick < chunk[1])); // the unread chunk's ticks never arrive
  const m = liquidityMap(read);
  const naive = depthHistogram(m.segments, sp, d1, tick);
  const prof = depthProfile(m.segments, sp, d1, tick, { unread: [chunk] });
  let nulls = 0, nums = 0, fakeZero = 0;
  prof.bins.forEach((b) => {
    const [, hi] = edgesOf(b, tick);
    if (hi > chunk[0] + 1e-6) { assert.equal(b.v, null, `bin at ${b.o} reaches the unread chunk or past it`); nulls++; }
    else { assert.ok(Number.isFinite(b.v), `bin at ${b.o} was read`); nums++; }
  });
  // the fault the nulls guard against: read naively, the wall in the unread chunk is gone (a fake drop
  // to the thin full range: under 1% of what the complete map holds there)
  const truth = depthHistogram(liquidityMap(poolFrom(positions, tick)).segments, sp, d1, tick);
  naive.buckets.forEach((v, i) => {
    const o = -naive.span + (i + 0.5) * naive.bucketLog;
    if (o > logForTicks(3700) && o < logForTicks(4100)) { assert.ok(v < 0.01 * truth.buckets[i], `naive ${v} vs ${truth.buckets[i]}`); fakeZero++; }
  });
  assert.ok(nulls >= 15 && nums >= 40 && fakeZero >= 2, `${nulls} null, ${nums} read, ${fakeZero} naive drops`);
  assert.equal(prof.beyond.above, null, 'past the unread chunk is unknown');
  assert.equal(prof.beyond.below, 0, 'the other side was read in full: its bins reach its last tick, so beyond is a real 0');
  assert.equal(prof.fullRange.v, null, 'with a chunk unread the full-range layer is not measured');
  // the read side's bins hold everything (no layer taken off): their sum is the whole read side of the map
  const readBelow = m.segments.reduce((a, x) => a + (x.L > 0n && x.lo < tick ? valueInRange(x.L, x.lo, Math.min(x.hi, tick), sp, d1) : 0), 0);
  assert.ok(rel(prof.bins.filter((b) => b.b <= 1e-12).reduce((a, b) => a + b.v, 0), readBelow, 1e-9));
  // the USD fields keep null as null
  const f = depthFields(prof, 2);
  assert.equal(f.beyond.above, null);
  assert.equal(f.beyond.below, 0);
  assert.equal(f.fullRangeUsd, null);
  assert.equal(f.fullRangeSpan, null);
  assert.equal(f.depth.filter(([, v]) => v === null).length, nulls);
  assert.equal(f.depth.filter(([, v]) => v === 0).length, 0, 'no unread bin turned into 0');
  // a chunk below the price hides the bins from it outwards on that side only
  const low = depthProfile(m.segments, sp, d1, tick, { unread: [[-1500, -1200]] });
  assert.ok(low.bins.filter((b) => b.o < logForTicks(-1500)).every((b) => b.v === null) && low.beyond.below === null && low.beyond.above != null);
  assert.ok(low.bins.filter((b) => b.o > 0).every((b) => Number.isFinite(b.v)));
  // a chunk holding the price hides every bin
  const blind = depthProfile(m.segments, sp, d1, tick, { unread: [[-120, 120]] });
  assert.ok(blind.bins.every((b) => b.v === null) && blind.beyond.below === null && blind.beyond.above === null);
});

test('planted fault: an unread chunk in the far zone runs that side to the tick limit as null; read naively it reads as the map ending', () => {
  // no full range; a wall at +1.0..+1.1 log sits in an unread chunk, a smaller one at +0.75..+0.80 is read
  const tick = 0, sp = 1, d1 = 18, chunk = [9500, 12000];
  const positions = [...strandedPositions, { lo: 7500, hi: 8000, L: 10n ** 20n }, { lo: 10000, hi: 11000, L: 5n * 10n ** 20n }];
  const read = poolFrom(positions, tick);
  read.ticks = read.ticks.filter((t) => !(t.tick >= chunk[0] && t.tick < chunk[1]));
  const m = liquidityMap(read);
  const prof = depthProfile(m.segments, sp, d1, tick, { unread: [chunk] });
  // that side runs to the cap, the tick limit itself: where its last tick is, nobody knows
  assert.ok(rel(prof.span[1], logForTicks(MAX_TICK), 1e-12), `span ${prof.span}`);
  const farUp = prof.bins.filter((b) => b.a >= OUTER - 1e-9);
  assert.equal(farUp.length, WHOLE_LADDER.length + 1, 'the uncapped ladder, the last bin cut at the tick limit');
  assert.ok(farUp.every((b) => (edgesOf(b, tick)[1] > chunk[0] ? b.v === null : Number.isFinite(b.v))), 'null from the chunk outwards, read before it');
  assert.ok(farUp.some((b) => b.v === null) && farUp.some((b) => Number.isFinite(b.v) && b.v > 0), 'the +0.75 wall is read, the +1.0 one unknown');
  assert.equal(prof.beyond.above, null);
  // the other side was read in full: its far bins stop at its last tick (−0.42 is inside the coarse bins) and beyond is a real 0
  assert.ok(rel(prof.span[0], -OUTER, 1e-12) && prof.beyond.below === 0);
  // the fault: read without the list of unread chunks, the map seems to end at +0.80 (the wall at +1.0 is gone):
  // the bars stop there and beyond reads a real-looking 0
  const naive = depthProfile(m.segments, sp, d1, tick);
  assert.ok(naive.span[1] < 0.9 && naive.beyond.above === 0, `naive span ${naive.span} beyond ${naive.beyond.above}`);
  assert.equal(naive.bins.filter((b) => b.v === null).length, 0, 'a naive read shows no unread bar at all');
});

test('depth fields: past the last tick is a real 0; no map or no price gives no bars and null span', () => {
  // the price 1000 ticks under the top: the bins past MAX_TICK hold a real 0 (no tick exists there), not null
  const tick = MAX_TICK - 1000, sp = spAt(tick);
  const m = liquidityMap(poolFrom([{ lo: -887220, hi: 887220, L: 10n ** 18n }], tick));
  // the whole field: the only position is full range, so it is all layer; the bars are real zeros and stop at the coarse edge
  const whole = depthFields(depthProfile(m.segments, sp, 0, tick), 1);
  assert.equal(whole.depth.length, DEPTH.fineBins + 2 * DEPTH.coarseBins);
  assert.ok(whole.depth.every(([, v]) => v === 0) && whole.beyond.below === 0 && whole.beyond.above === 0);
  assert.ok(rel(whole.fullRangeUsd, Number(valueInRange(10n ** 18n, -887220, 887220, sp, 0).toPrecision(5)), 1e-12));
  assert.deepEqual(whole.fullRangeSpan, [Number(logForTicks(-887220 - tick).toPrecision(6)), Number(logForTicks(887220 - tick).toPrecision(6))]);
  // the old options, as before
  const prof = depthProfile(m.segments, sp, 0, tick, OLD);
  const past = prof.bins.filter((b) => edgesOf(b, tick)[0] >= MAX_TICK);
  assert.ok(past.length >= 20 && past.every((b) => b.v === 0), `${past.length} bins past the top`);
  assert.equal(prof.beyond.above, 0);
  assert.ok(prof.beyond.below > 0);
  const f = depthFields(prof, 1);
  // above: the last tick is 52 ticks under the top, inside the fine bins, so no far bins; below: out to ÷10
  assert.equal(f.depth.length, DEPTH.fineBins + 2 * DEPTH.coarseBins + LADDER.length);
  assert.deepEqual(f.depthSpan, [-2.30259, 0.6375]);
  assert.equal(f.depthEdges.length, f.depth.length + 1);
  assert.deepEqual(f.depthEdges.slice(0, 6), [-2.30259, -1.7625, -1.1625, -0.8625, -0.7125, -0.6375]);
  assert.ok(f.depthEdges.every((e, i) => i === 0 || e > f.depthEdges[i - 1]), 'edges ascend');
  assert.deepEqual(f.depthStep, { fine: 0.01875, coarse: 0.0375, edge: 0.45 });
  assert.equal(f.fullRangeUsd, null, 'old options: no layer measured');
  const none = { depth: [], depthSpan: null, depthEdges: null, depthStep: null, beyond: { below: null, above: null }, fullRangeUsd: null, fullRangeSpan: null };
  assert.deepEqual(depthFields(null, 2), none, 'map unread');
  assert.deepEqual(depthFields(prof, null), none, 'token1 unpriced');
  assert.deepEqual(depthFields(prof, NaN), none);
});

// ---------- the whole field (owner's pick "A · Whole field, grouped", 7 Nov 2026): bins out to the furthest tick with no
// ×10 cap, and the full-range layer published on its own instead of smeared over the far bins ----------
// walls at +3.0..+3.5 and −8.0..−7.0 log, the stranded walls near the price, and a thin full range
const wholePositions = [...strandedPositions, { lo: 30000, hi: 35000, L: 10n ** 19n }, { lo: -80000, hi: -70000, L: 5n * 10n ** 18n }, { lo: -887220, hi: 887220, L: 10n ** 18n }];
const mapValue = (m, sp, d1) => m.segments.reduce((a, x) => a + (x.L > 0n ? valueInRange(x.L, x.lo, x.hi, sp, d1) : 0), 0);
// a constant-liquidity layer's share of its value between log offsets a < b, for a layer over [lo, hi] (the page's formula)
const layerShare = (a, b, lo, hi) => {
  const part = (x, y) => (y <= 0 ? Math.exp(y / 2) - Math.exp(x / 2) : x >= 0 ? Math.exp(-x / 2) - Math.exp(-y / 2) : part(x, 0) + part(0, y));
  const x = Math.max(a, lo), y = Math.min(b, hi);
  return y > x ? part(x, y) / part(lo, hi) : 0;
};

test('whole field: bins from the lowest to the highest tick, doubling with no cap; beyond a real 0; bins + layer = the map', () => {
  for (const [tick, d1] of CASES) {
    const sp = spAt(tick), m = liquidityMap(poolFrom(at(wholePositions, tick), tick));
    const prof = depthProfile(m.segments, sp, d1, tick);
    // −8.0 log needs the ladder to 10.1625 below; +3.5 needs it to 5.3625 above
    const below = WHOLE_LADDER.slice(0, 7), above = WHOLE_LADDER.slice(0, 6);
    assert.equal(prof.bins.length, 58 + below.length + above.length);
    assert.ok(prof.bins.length <= 100, 'about 100 bins at most');
    below.forEach((e, k) => assert.ok(rel(-prof.edges[below.length - 1 - k], e, 1e-12), `edge below ${k}`));
    above.forEach((e, k) => assert.ok(rel(prof.edges[prof.edges.length - above.length + k], e, 1e-12), `edge above ${k}`));
    assert.ok(rel(prof.span[0], -10.1625, 1e-12) && rel(prof.span[1], 5.3625, 1e-12));
    for (let k = 1; k < prof.bins.length; k++) assert.ok(Math.abs(prof.bins[k].a - prof.bins[k - 1].b) < 1e-12 && prof.bins[k].o > prof.bins[k - 1].o);
    assert.deepEqual(prof.beyond, { below: 0, above: 0 }, 'the bins reach both last ticks: beyond is a real 0');
    // the layer is the thin full range, exactly
    const Lfr = 10n ** 18n;
    assert.ok(rel(prof.fullRange.v, valueInRange(Lfr, -887220 + tick, 887220 + tick, sp, d1), 1e-12));
    assert.ok(rel(prof.fullRange.a, logForTicks(-887220), 1e-12) && rel(prof.fullRange.b, logForTicks(887220), 1e-12));
    // every bin against an independent sum with the layer taken off (bandStats clips each segment its own way)
    const inside = (a, b) => bandStats(m.segments, sp, d1, a, b, tick).inside;
    prof.bins.forEach((b, k) => {
      const [x, y] = edgesOf(b, tick);
      assert.ok(rel(b.v, inside(x, y) - valueInRange(Lfr, x, y, sp, d1), 1e-9) || Math.abs(b.v) < 1e-9 * prof.fullRange.v, `bin ${k}: ${b.v}`);
      assert.ok(b.v >= -1e-9 * prof.fullRange.v, `bin ${k} not negative`);
    });
    // nothing lost, nothing counted twice
    const sum = prof.bins.reduce((a, b) => a + b.v, 0) + prof.beyond.below + prof.beyond.above + prof.fullRange.v;
    assert.ok(rel(sum, mapValue(m, sp, d1), 1e-9), `bins + beyond + layer ${sum} vs map ${mapValue(m, sp, d1)}`);
    // the far walls land in their bins
    const v = (lo, hi, L) => valueInRange(L, lo + tick, hi + tick, sp, d1);
    const binAt = (o) => prof.bins.find((b) => b.a <= o && o < b.b);
    assert.ok(binAt(3.2).v >= v(30000, 35000, 10n ** 19n) * (1 - 1e-9) && binAt(3.2).a === prof.edges.at(-2), 'the +3.0..+3.5 wall is in the last bin above');
    assert.ok(binAt(-7.5).v >= v(-80000, -70000, 5n * 10n ** 18n) * (1 - 1e-9) && binAt(-7.5).a === prof.edges[0], 'the −8..−7 wall is in the first bin below');
  }
});

test('whole field: the layer comes off each bar exactly (old bar = new bar + the layer\'s share); walls, parked and band9 unchanged', () => {
  for (const [tick, d1] of CASES) {
    for (const positions of [widePositions, wholePositions]) {
      const sp = spAt(tick), m = liquidityMap(poolFrom(at(positions, tick), tick));
      const now = depthProfile(m.segments, sp, d1, tick), old = depthProfile(m.segments, sp, d1, tick, { far: Infinity, wide: null });
      assert.ok(now.fullRange.v > 0);
      // same edges as far as the new bins go (the old ones run on to the tick limit, smeared with the layer)
      const lo = now.fullRange.a, hi = now.fullRange.b;
      const off = old.bins.findIndex((b) => Math.abs(b.a - now.bins[0].a) < 1e-12);
      assert.ok(off >= 0);
      now.bins.forEach((b, k) => {
        const o = old.bins[off + k], [x, y] = edgesOf(b, tick);
        assert.ok(Math.abs(o.a - b.a) < 1e-12 && Math.abs(o.b - b.b) < 1e-12, `edges of bin ${k}`);
        const share = valueInRange(10n ** 18n, Math.max(x, tick - 887220 + 0), Math.min(y, tick + 887220), sp, d1);
        assert.ok(rel(b.v + (y > tick - 887220 && x < tick + 887220 ? share : 0), o.v, 1e-9), `bin ${k}: ${b.v} + layer = ${o.v}`);
        // the page's formula from log offsets alone gives the same share (to the tick's rounding)
        assert.ok(Math.abs(now.fullRange.v * layerShare(b.a, b.b, lo, hi) - share) <= 1e-3 * now.fullRange.v * Math.max(layerShare(b.a, b.b, lo, hi), 1e-6) + 1e-12 * now.fullRange.v, `formula, bin ${k}`);
      });
      // the walls are found on the whole map's histogram, as before
      assert.deepEqual(nearestWalls(now.hist), nearestWalls(depthHistogram(m.segments, sp, d1, tick)));
    }
  }
});

test('planted fault: left in the bars, a full-range position smears over far bins out to the tick limit', () => {
  const tick = 0, sp = 1, d1 = 18;
  const m = liquidityMap(poolFrom(widePositions, tick)); // walls end at +0.90 and −0.70; a thin full range
  const now = depthProfile(m.segments, sp, d1, tick);
  const smeared = depthProfile(m.segments, sp, d1, tick, { wide: null }); // the fault: no layer
  assert.deepEqual(now.span.map((x) => Number(x.toFixed(4))), [-0.7125, 1.1625], 'with the layer the bins stop where the walls end');
  assert.ok(rel(smeared.span[1], logForTicks(MAX_TICK), 1e-12) && rel(smeared.span[0], -logForTicks(-MIN_TICK), 1e-12), 'without it they run to the tick limit');
  const tail = smeared.bins.filter((b) => b.a >= 1.1625 - 1e-9 || b.b <= -0.7125 + 1e-9);
  assert.ok(tail.length >= 15 && tail.every((b) => b.v > 0), `${tail.length} far bins hold nothing but slices of the full range`);
  assert.equal(smeared.fullRange.v, null);
  assert.ok(now.bins.length < smeared.bins.length);
});

test('full-range layer: what spans ±5 log counts; one-sided width, gaps and lower levels do not', () => {
  const T = (r) => Math.round(ticksForLog(r));
  const layerOf = (positions, tick = 0) => fullRangeLayer(liquidityMap(poolFrom(positions, tick)).segments, tick);
  // a position from −6 to +7 log (not MIN..MAX) is a layer of its own, over exactly its range
  const a = layerOf([{ lo: -T(6), hi: T(7), L: 3n }, { lo: -600, hi: 600, L: 50n }]);
  assert.deepEqual(a, { L: 3n, lo: -T(6), hi: T(7) });
  // wide on one side only: no layer
  assert.equal(layerOf([{ lo: -T(6), hi: T(2), L: 3n }]).L, 0n);
  assert.equal(layerOf([{ lo: -T(4), hi: 887220, L: 3n }]).L, 0n);
  // a stretch with no liquidity inside ±5 log: nothing spans it, however big the sides
  assert.equal(layerOf([{ lo: -887220, hi: -T(2), L: 9n }, { lo: -T(1), hi: 887220, L: 9n }]).L, 0n);
  // a full range plus a ±7 log position: the level present everywhere within ±5 log is both, out to ±7 log;
  // the full range past ±7 log stays in the bars (exact either way: bars + layer = the map)
  const b = layerOf([{ lo: -887220, hi: 887220, L: 2n }, { lo: -T(7), hi: T(7), L: 5n }]);
  assert.deepEqual(b, { L: 7n, lo: -T(7), hi: T(7) });
  // a stack covering ±5 log counts at its lowest level
  assert.deepEqual(layerOf([{ lo: -T(6), hi: T(1), L: 4n }, { lo: -T(1), hi: T(6), L: 6n }]), { L: 4n, lo: -T(6), hi: T(6) });
  // the price near the bottom tick: the band is clipped at the usable edge, the full range still found
  const low = MIN_TICK + 2000;
  assert.equal(layerOf([{ lo: -887220, hi: 887220, L: 2n }], low).L, 2n);
  // ... and the band always holds the price: liquidity only far above it is no layer
  assert.equal(layerOf([{ lo: MIN_TICK + 30000, hi: 887220, L: 2n }], low).L, 0n);
  // nothing at all
  assert.equal(fullRangeLayer([], 0).L, 0n);
  assert.equal(fullRangeLayer(liquidityMap(poolFrom([{ lo: -887220, hi: 887220, L: 2n }], 0)).segments, 0, { wide: null }).L, 0n);
});

test('whole field: size stays within +1 KB a pool (worst case: liquidity out to both tick limits)', () => {
  const worst = [{ lo: -887220, hi: -12000, L: 10n ** 18n }, { lo: 12000, hi: 887220, L: 10n ** 18n }, { lo: -600, hi: 600, L: 10n ** 20n }, ...strandedPositions];
  for (const [tick, d1] of CASES) {
    for (const positions of [worst, wholePositions, widePositions, strandedPositions]) {
      const sp = spAt(tick), m = liquidityMap(poolFrom(at(positions, tick), tick));
      const size = (o) => JSON.stringify(depthFields(depthProfile(m.segments, sp, d1, tick, o), 2250)).length;
      assert.ok(size({}) - size(OLD) <= 1024, `+${size({}) - size(OLD)} bytes`);
    }
    const m = liquidityMap(poolFrom(at(worst, tick), tick));
    const f = depthFields(depthProfile(m.segments, spAt(tick), d1, tick), 2250);
    assert.ok(f.depth.length >= 78 && f.depth.length <= 82, `${f.depth.length} bars`);
    assert.equal(f.fullRangeUsd, 0, 'no layer: a real 0');
    assert.equal(f.fullRangeSpan, null);
    assert.deepEqual(f.beyond, { below: 0, above: 0 });
  }
});
