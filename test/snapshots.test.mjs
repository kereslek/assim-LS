// The snapshot store (lib/snapshots.mjs) on made-up rows: downsampling, pruning, backfill without
// duplicates, compact round trip, coverage for young pools, unread rows. Each check also runs against
// a planted fault and must catch it.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  HOUR, DAY, TIERS, normRow, merge, append, prune, coverage, rowsIn, tierFor,
  serializeSeries, parseSeries, serializeStore, parseStore, mergeStore, emptySeries,
} from '../lib/snapshots.mjs';

const T0 = Date.UTC(2026, 9, 1); // a made-up start, 1 Oct 2026 00:00 UTC
const Q = 1n << 128n;
// A made-up row at time t: every field read, values that move with t.
const row = (t, k = Math.round((t - T0) / 60e3)) => ({
  t, block: 20_000_000 + Math.floor((t - T0) / 12e3), sqrtPriceX96: (79228162514264337593543950336n * BigInt(1000 + (k % 50))) / 1000n,
  tick: -200 + (k % 400), L: 10n ** 20n + BigInt(k), fg0: Q * 7n + BigInt(k) * 10n ** 30n, fg1: Q * 3n + BigInt(k) * 10n ** 28n, parked: (k % 100) / 100,
});
// Passes every 6 minutes from `from` for `hours` hours, starting at minute `offset` of the hour.
const passes = (from, hours, offset = 3) => Array.from({ length: Math.floor((hours * 60) / 6) }, (_, i) => row(from + offset * 60e3 + i * 6 * 60e3));
const build = (rows, now) => rows.reduce((s, r) => append(s, r, { now: now ?? r.t }), emptySeries());

// ---- the checks (each takes a series and the input rows; each returns true when it holds) --------
const firstPerBucket = (s, rows, tier) => {
  const { step } = TIERS[tier], want = new Map();
  for (const r of rows) { const b = Math.floor(r.t / step); if (!want.has(b) || r.t < want.get(b)) want.set(b, r.t); }
  const got = s[tier].map((r) => r.t);
  return got.every((t) => want.get(Math.floor(t / step)) === t) && new Set(got.map((t) => Math.floor(t / step))).size === got.length;
};
const sortedUnique = (s) => ['h', 'd'].every((k) => s[k].every((r, i, a) => i === 0 || (a[i - 1].t < r.t && Math.floor(a[i - 1].t / TIERS[k].step) < Math.floor(r.t / TIERS[k].step))));
const prunedAt = (s, now) => ['h', 'd'].every((k) => s[k].every((r) => r.t >= now - TIERS[k].span - TIERS[k].step)) &&
  ['h', 'd'].every((k) => s[k].length && s[k][0].t < now - TIERS[k].span + TIERS[k].step); // and nothing too young was dropped
const sameRows = (a, b) => JSON.stringify(serializeSeries(a)) === JSON.stringify(serializeSeries(b));

test('appending downsamples: the first row of each hour and of each day, nothing else', () => {
  const rows = passes(T0, 30); // 30 hours of passes every 6 minutes
  const s = build(rows);
  assert.equal(s.h.length, 30);
  assert.equal(s.d.length, 2);
  assert.ok(firstPerBucket(s, rows, 'h') && firstPerBucket(s, rows, 'd') && sortedUnique(s));
  assert.equal(s.h[0].t, T0 + 3 * 60e3);
  assert.equal(s.d[1].t, T0 + DAY + 3 * 60e3);
  // planted fault: a store that keeps the LAST row of each hour is caught
  const lastKept = { h: s.h.map((r) => rows.filter((x) => Math.floor(x.t / HOUR) === Math.floor(r.t / HOUR)).at(-1)), d: s.d };
  assert.equal(firstPerBucket(lastKept, rows, 'h'), false);
  // planted fault: two rows in one hour are caught
  assert.equal(sortedUnique({ h: [...s.h.slice(0, 2), { ...s.h[1], t: s.h[1].t + 60e3 }, ...s.h.slice(2)], d: s.d }), false);
});

test('pruning drops rows past each tier span (plus one step), and only those', () => {
  const rows = passes(T0, 40 * 24, 5).filter((_, i) => i % 5 === 0); // 40 days, a pass every 30 minutes
  const now = rows.at(-1).t;
  const s = build(rows);
  assert.ok(prunedAt(s, now));
  assert.ok(s.h.length >= 7 * 24 && s.h.length <= 7 * 24 + 2, `hourly rows ${s.h.length}`);
  assert.ok(s.d.length >= 30 && s.d.length <= 32, `daily rows ${s.d.length}`);
  const later = prune(s, now + 3 * DAY);
  assert.ok(later.h.length < s.h.length && later.d.length < s.d.length && prunedAt(later, now + 3 * DAY));
  // planted fault: no pruning at all is caught
  assert.equal(prunedAt({ h: rows.map(normRow), d: s.d }, now), false);
  // planted fault: pruning a day too early (a full 7-day window would lose its start row) is caught
  assert.equal(prunedAt({ h: s.h.filter((r) => r.t >= now - 6 * DAY), d: s.d }, now), false);
});

test('a backfill merges without duplicates, in any order, and merging twice changes nothing', () => {
  const live = passes(T0 + 2 * DAY, 24);
  const back = passes(T0, 72, 1).filter((_, i) => i % 10 === 0); // older and overlapping, other minutes
  const now = live.at(-1).t;
  const a = merge(build(live), back, { now });
  const b = merge(merge(emptySeries(), back, { now }), live, { now });
  const c = merge(a, back, { now });
  assert.ok(sameRows(a, b), 'order does not matter');
  assert.ok(sameRows(a, c), 'merging the same backfill twice changes nothing');
  assert.ok(sortedUnique(a) && firstPerBucket(a, [...live, ...back], 'h') && firstPerBucket(a, [...live, ...back], 'd'));
  // planted fault: a naive concatenation (duplicates kept) is caught
  assert.equal(sortedUnique({ h: [...a.h, ...back.map(normRow)].sort((x, y) => x.t - y.t), d: a.d }), false);
});

test('serialisation: parallel arrays, BigInts as decimal strings, exact round trip, small after gzip', () => {
  const rows = passes(T0, 7 * 24);
  const s = build(rows);
  const o = serializeSeries(s), text = JSON.stringify(o);
  assert.deepEqual(Object.keys(o.h), ['t', 'block', 'sqrtP', 'tick', 'L', 'fg0', 'fg1', 'parked']);
  assert.ok(o.h.fg0.every((x) => typeof x === 'string' && /^\d+$/.test(x)));
  assert.equal(o.h.t[1], o.h.t[2], 'hourly t deltas repeat (gzip-friendly)');
  assert.ok(!text.includes('"sqrtPriceX96"'), 'no per-row objects');
  const back = parseSeries(JSON.parse(text));
  assert.ok(sameRows(back, s));
  assert.equal(back.h[5].fg0, s.h[5].fg0);
  assert.equal(typeof back.h[5].fg0, 'bigint');
  const naive = JSON.stringify(s.h.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))));
  assert.ok(zlib.gzipSync(text).length < zlib.gzipSync(naive).length, 'smaller than one object per row');
  // a store of pools round-trips too; a corrupt column is refused, never read as zero
  const store = new Map([['made-up-pool-a', s], ['made-up-pool-b', build(rows.slice(0, 50))]]);
  const st = parseStore(JSON.parse(JSON.stringify(serializeStore(store))));
  assert.ok(sameRows(st.get('made-up-pool-a'), s) && st.size === 2);
  const bad = JSON.parse(text); bad.h.fg0.pop();
  assert.throws(() => parseSeries(bad), /column fg0/);
  const bad2 = JSON.parse(text); bad2.h.L[3] = '12.5';
  assert.throws(() => parseSeries(bad2), /whole number/);
  // planted fault: BigInts written as JS numbers lose digits and are caught by the round trip
  const lossy = JSON.parse(text); lossy.h.fg0 = lossy.h.fg0.map((x) => Number(x));
  assert.throws(() => parseSeries(lossy), /whole number/);
});

test('coverage tells how much of a window a young pool covers', () => {
  const now = T0 + 10 * DAY;
  const young = build(passes(now - 3.5 * DAY, 3.5 * 24 - 0.2), now);
  const c7 = coverage(young, 7 * DAY, { now }), c24 = coverage(young, DAY, { now }), c30 = coverage(young, 30 * DAY, { now });
  const youngOk = (c) => Math.abs(c.days - 3.5) < 0.1 && Math.abs(c.span - 0.5) < 0.02;
  assert.ok(youngOk(c7), JSON.stringify(c7));
  assert.ok(c24.span === 1 && c24.filled > 0.95, JSON.stringify(c24));
  assert.ok(Math.abs(c30.days - 3.5) < 1.1 && c30.span < 0.13, JSON.stringify(c30));
  assert.equal(tierFor(DAY), 'h'); assert.equal(tierFor(7 * DAY), 'h'); assert.equal(tierFor(30 * DAY), 'd');
  assert.deepEqual(coverage(emptySeries(), DAY, { now }), { span: 0, days: 0, filled: 0, rows: 0, from: null });
  // a gap shows in `filled`, not in `span`
  const gappy = build(passes(now - DAY, 24).filter((r) => r.t < now - 15 * HOUR || r.t > now - 5 * HOUR), now);
  const cg = coverage(gappy, DAY, { now });
  assert.ok(cg.span > 0.99 && cg.filled < 0.65, JSON.stringify(cg));
  // planted fault: coverage counted from the window start instead of the first row reads a young pool as full
  assert.equal(youngOk({ ...c7, span: 1, days: 7 }), false);
});

test('unread fields stay null; an empty row is not stored; a fuller row replaces a thinner one in its hour', () => {
  const t = T0 + 3 * 60e3;
  assert.equal(normRow({ t }), null, 'nothing read: not stored');
  const thin = { t, block: 1, sqrtPriceX96: null, tick: null, L: null, fg0: null, fg1: null, parked: null };
  const s = append(append(emptySeries(), thin), row(t + 6 * 60e3));
  assert.equal(s.h.length, 1);
  assert.equal(s.h[0].t, t + 6 * 60e3, 'the read row wins the hour');
  const s2 = append(emptySeries(), { ...row(t), fg0: null });
  assert.equal(s2.h[0].fg0, null, 'unread stays null');
  assert.notEqual(s2.h[0].fg1, null);
  const back = parseSeries(JSON.parse(JSON.stringify(serializeSeries(s2))));
  assert.equal(back.h[0].fg0, null, 'and survives the round trip as null, never 0');
  assert.throws(() => normRow({ t: 'yesterday', L: 1n }), /needs t/);
  assert.throws(() => normRow({ t, L: -1n }), /out of range/);
  assert.throws(() => normRow({ t, parked: 1.5 }), /0\.\.1/);
  // mergeStore drops pools whose rows have all aged out
  const st = mergeStore(new Map([['old-pool', s]]), { 'new-pool': row(T0 + 40 * DAY) }, { now: T0 + 40 * DAY });
  assert.deepEqual([...st.keys()], ['new-pool']);
  assert.equal(rowsIn(st.get('new-pool'), 'h').length, 1);
});
