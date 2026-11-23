// "Why this pool?" (lib/gem.mjs gemNow's why, lib/windows.mjs): the inputs each part of Gem now read and how the gates
// went, so the dashboard can say why in plain words and its breakdown adds up to the score shown elsewhere. Made-up
// numbers. Each check also runs against a planted fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gemNow, whyTotal, SAFETY_CHECKS } from '../lib/gem.mjs';
import { HOUR, DAY, merge, emptySeries } from '../lib/snapshots.mjs';
import { allWindows } from '../lib/windows.mjs';

const T0 = Date.UTC(2026, 9, 20);
const days = (nets) => nets.map((n, i) => ({ t: T0 + (i + 1) * DAY, feesPer1k: n + 0.2, net: n }));
const ok = (id) => ({ id, label: id, ok: true }), no = (id) => ({ id, label: id, ok: false }), un = (id) => ({ id, label: id, ok: null });
const SAFE = SAFETY_CHECKS.map(ok);
const base = { thinness: 0.0038, markoutToFee: 0.22, traders7d: 240, persistence: 0.6 };
// the window's gem, as lib/windows.mjs publishes it (parts flat)
const flat = (g) => ({ total: g.total, ...(g.parts || { yield: null, thinness: null, flow: null, staying: null }), why: g.why });
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

test('a gem: the parts less the deductions give the total, and the why carries what each part read', () => {
  const nets = [1.0, 1.2, 1.1, 0.9, 1.15, 1.05, 1.12];
  const g = gemNow({ ...base, daily: days(nets), checks: [...SAFE, ok('fee-identity'), ok('price-vs-market'), un('volatility-xcheck')] });
  const w = g.why;
  assert.equal(w.y, median(nets), 'Yield now read the median of the last 7 days');
  assert.equal(w.yd, 7);
  assert.deepEqual([w.yx, w.yh, w.th, w.mk, w.tr, w.ps], [0, 0, 0.0038, 0.22, 240, 0.6]);
  assert.deepEqual([w.sp, w.sf, w.sn, w.dp, w.df, w.dn, w.wn], [4, [], [], 2, [], ['volatility-xcheck'], []]);
  const raw = g.parts.yield + g.parts.thinness + g.parts.flow + g.parts.staying;
  assert.equal(g.total, raw - 5, 'one data check not run: −5');
  assert.equal(whyTotal(flat(g)), g.total);
  // planted fault: a breakdown that forgets the data check that did not run would not add up
  const forgot = { ...flat(g), why: { ...w, dn: [] } };
  assert.notEqual(whyTotal(forgot), g.total);
});

test('a failed safety check: no score, and the why names the check', () => {
  const g = gemNow({ ...base, daily: days([1, 1, 1, 1, 1, 1, 1]), checks: [ok('contract-verified'), no('sell-test'), ok('token-age-rank'), ok('verified'), ok('fee-identity')] });
  assert.equal(g.total, null);
  assert.deepEqual([g.why.sp, g.why.sf, g.why.sn, g.why.df], [3, ['sell-test'], [], []]);
  assert.equal(whyTotal(flat(g)), null, 'nothing to add up');
  // a failed data check is told apart from a safety one
  const d = gemNow({ ...base, daily: days([1, 1, 1, 1, 1, 1, 1]), checks: [...SAFE, no('price-vs-market')] });
  assert.deepEqual([d.total, d.why.sf, d.why.df], [null, [], ['price-vs-market']]);
});

test('a safety check not run: the parts add up to more than 40, the score is capped at 40, the why says which check', () => {
  const strong = { thinness: 0.01, markoutToFee: 0.05, traders7d: 300, persistence: 1 };
  const g = gemNow({ ...strong, daily: days([2, 2, 2, 2, 2, 2, 2]), checks: [ok('contract-verified'), un('sell-test'), ok('token-age-rank'), ok('verified'), ok('fee-identity')] });
  const raw = g.parts.yield + g.parts.thinness + g.parts.flow + g.parts.staying;
  assert.ok(raw > 40 && g.total === 40 && g.tags.includes('unchecked'), JSON.stringify([raw, g.total, g.tags]));
  assert.deepEqual([g.why.sp, g.why.sn], [3, ['sell-test']]);
  assert.equal(whyTotal(flat(g)), 40);
  // planted fault: without the cap the breakdown would read the raw sum
  assert.notEqual(whyTotal({ ...flat(g), why: { ...g.why, sn: [] } }), g.total);
});

test('a one-off day: left out of Yield now (yx), the typical day is the median of the days before it', () => {
  const nets = [0.6, 0.7, 0.65, 0.62, 0.68, 0.71, 12];
  const g = gemNow({ ...base, daily: days(nets), topTxShare: 0.8, checks: SAFE });
  assert.ok(g.tags.includes('one-off'));
  assert.deepEqual([g.why.yx, g.why.yd, g.why.y], [1, 6, median(nets.slice(0, -1))]);
  assert.equal(whyTotal(flat(g)), g.total);
  // too little history: the window's own net stands in (yd 0) and a one-trader day halves the part (yh)
  const young = gemNow({ ...base, daily: days([3]), netPer1kDay: 1.37, topTxShare: 0.9, checks: SAFE });
  assert.deepEqual([young.why.yd, young.why.yh, young.why.y], [0, 1, 1.37]);
  assert.equal(young.parts.yield, Math.round(45 * 0.5 * Math.min(1, 1.37 / (500 / 365))));
  // planted fault: a many-trader burst is not one-off, so its day stays in
  assert.equal(gemNow({ ...base, daily: days(nets), topTxShare: 0.3, checks: SAFE }).why.yx, 0);
});

test('persistence not measured: the why says null (the page shows a dash), staying power counts 0, and it still adds up', () => {
  const g = gemNow({ ...base, persistence: null, daily: days([1, 1, 1, 1, 1, 1, 1]), checks: SAFE });
  assert.deepEqual([g.why.ps, g.parts.staying], [null, 0]);
  assert.equal(whyTotal(flat(g)), g.total);
  // missing inputs elsewhere: no score, and the why keeps null, never 0
  const m = gemNow({ ...base, thinness: null, markoutToFee: null, daily: [], checks: SAFE });
  assert.deepEqual([m.total, m.why.th, m.why.mk, m.why.y], [null, null, null, null]);
});

test('whyTotal agrees with every score over 2,000 made-up pools (warnings, checks not run, caps, one-offs)', () => {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 2 ** 32; };
  const DATA = ['fee-identity', 'price-vs-market', 'volume-vs-aggregator', 'markouts-read'];
  const W = ['hooked pool', 'thin: under 10 swaps a day', 'pool price more than 10% off market'];
  let scored = 0, capped = 0, faulty = 0;
  for (let i = 0; i < 2000; i++) {
    const nets = Array.from({ length: Math.floor(rnd() * 9) }, () => rnd() * 2.5 - 0.3);
    const checks = [...SAFETY_CHECKS, ...DATA].map((id) => { const u = rnd(); return { id, label: id, ok: u < 0.04 ? false : u < 0.2 ? null : true }; });
    const g = gemNow({ daily: days(nets), netPer1kDay: rnd() < 0.8 ? rnd() * 2 : null, thinness: rnd() < 0.95 ? rnd() * 0.008 : null, markoutToFee: rnd() * 1.2,
      traders7d: Math.floor(rnd() * 400), persistence: rnd() < 0.7 ? rnd() : null, checks, warnings: W.filter(() => rnd() < 0.15), topTxShare: rnd() < 0.2 ? 0.9 : 0.1 });
    if (g.total == null) { assert.equal(whyTotal(flat(g)), null); continue; }
    scored++; if (g.why.sn.length) capped++;
    assert.equal(whyTotal(flat(g)), g.total, JSON.stringify(flat(g)));
    // planted fault: warnings at 5 points each
    const f = flat(g), alt = Math.max(0, f.yield + f.thinness + f.flow + f.staying - 5 * f.why.wn.length - 5 * f.why.dn.length);
    if ((f.why.sn.length ? Math.min(alt, 40) : alt) !== g.total) faulty++;
  }
  assert.ok(scored > 500 && capped > 50, JSON.stringify({ scored, capped }));
  assert.ok(faulty > 20, `the planted fault is caught (${faulty})`);
});

test('the windows publish the why with the persistence inputs, and a longer window\'s flow from the latest replay', () => {
  const Q = 1n << 128n, L = 10n ** 18n, NOW = Date.UTC(2026, 10, 1, 18, 0), rows = [];
  let fg1 = 7n * Q;
  for (let t = NOW - 12 * DAY; t <= NOW; t += HOUR) {
    const k = (t - NOW + 12 * DAY) / HOUR;
    rows.push({ t, block: 1 + k * 300, sqrtPriceX96: (1n << 96n) + BigInt(Math.round(Math.sin(k / 5) * 1e25)), tick: 0, L, fg0: 3n * Q, fg1, parked: k % 4 ? 0.9 : 0.5 });
    fg1 += ((125n * 10n ** 6n) * Q) / L;
  }
  const checkList = [...SAFE, ok('fee-identity'), un('volatility-xcheck')];
  const pool = { feeTier: 0.003, lpKeeps: 1, d0: 6, d1: 6, usd0: 1, usd1: 1, tvlUsd: 2e7, gasUsd: 5, walls: { below: 0.3, above: 0.2 }, inactiveShare: 0.55, checkList,
    warnings: ['hooked pool'], flow: { '24h': { swaps: 900, traders: 40, markout: 0.3 }, '7d': { gemFlow: { markoutToFee: 0.25, traders7d: 280 } } } };
  const ws = allWindows({ series: merge(emptySeries(), rows, { now: NOW }), cur: rows.at(-1), chain: 'ethereum', pool, config: { ticket: 1000, holdDays: { ethereum: 14 } } });
  for (const [k, w] of Object.entries(ws)) {
    if (!w) continue;
    const y = w.gem.why;
    assert.ok(y && Array.isArray(y.sf) && Array.isArray(y.dn) && Array.isArray(y.wn), k);
    assert.deepEqual([y.sp, y.dp, y.dn, y.wn], [4, 1, ['volatility-xcheck'], ['hooked pool']], k);
    assert.ok(Math.abs(y.sd - 30 * w.strandedShare) < 0.2 && y.ia === 0.55 && y.ws > 0, JSON.stringify(y));
    if (w.gem.total != null) assert.equal(whyTotal(w.gem), w.gem.total, k);
    assert.ok(JSON.stringify(y).length < 260, `compact: ${JSON.stringify(y).length} bytes`);
  }
  assert.ok(ws['24h'].gem.why.mk === 0.3 && Math.abs(ws['24h'].gem.why.tr - 280) <= 12, 'the day\'s own replay: about 40 traders a day is about 280 a week');
  assert.deepEqual([ws['7d'].gem.why.mk, ws['7d'].gem.why.tr], [0.25, 280], 'the 7-day window scores flow from the latest replay');
  // no walls and no inactive share read: null, never 0
  const bare = allWindows({ series: merge(emptySeries(), rows, { now: NOW }), cur: rows.at(-1), chain: 'ethereum', pool: { ...pool, walls: null, inactiveShare: null }, config: { ticket: 1000, holdDays: { ethereum: 14 } } })['24h'];
  assert.deepEqual([bare.gem.why.ws, bare.gem.why.ia, bare.gem.why.ps, bare.gem.staying], [null, null, null, 0]);
});
