// The scan end to end on the offline fake world (tools/fakes, MOCKUP · MADE-UP NUMBERS) with a throwaway
// lock and a made-up sealed config: the sealed live.json, history.json and snapshots.json follow
// docs/DATA.md, the config reaches the outputs, and the public log holds areas, pass/fail and counts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLock } from '../lib/lock.mjs';
import { openStore } from '../lib/store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DUMMY = 'scan outputs test dummy passphrase, not a secret';
const LIVE_KEYS = ['v', 't', 'phase', 'build', 'next', 'ticket', 'stopLoss', 'windows', 'defaultWindow', 'gemAt', 'chains', 'health', 'bench', 'pools', 'market'];
const POOL_KEYS = ['id', 'chain', 'v', 'pair', 't0', 't1', 'feeTier', 'dynamicFee', 'lpKeeps', 'hooks', 'verified', 'firstSeen', 'createdAt', 'pairAgeDays', 'young',
  'tvlUsd', 'mapUsd', 'aggUsd', 'price', 'marketRatio', 'offMarket', 'shape', 'w', 'checks', 'gemFirstAt'];
const WIN_KEYS = ['days', 'partial', 'volUsd', 'lpFeesUsd', 'protocolFeesUsd', 'swaps', 'traders', 'sigma', 'range', 'rerangeDays', 'inRangeUsd', 'feeApr', 'lvr',
  'swapCost', 'gas', 'net', 'edge', 'aggApr', 'parkedAvg', 'strandedShare', 'markout', 'gem', 'lenses', 'spark'];
const finite = (x) => x === null || typeof x !== 'number' || Number.isFinite(x);
const walk = (x) => (Array.isArray(x) ? x.every(walk) : x && typeof x === 'object' ? Object.values(x).every((v) => v !== undefined && walk(v)) : finite(x));
// The contract check.
function contractOk(live) {
  const has = (o, ks) => o && ks.every((k) => k in o);
  return has(live, LIVE_KEYS) && live.v === 1 && Array.isArray(live.pools) && live.pools.length > 0 && walk(live) &&
    live.pools.every((p) => has(p, POOL_KEYS) && live.windows.every((w) => p.w[w] === null || has(p.w[w], WIN_KEYS)));
}

test('the scan writes sealed outputs per docs/DATA.md and prints only areas, pass/fail and counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-scan-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const sealCfg = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seal-input.mjs'), '--out', 'lock/config.sealed.json'],
    { cwd: dir, input: JSON.stringify({ ticket: 2718, gemAt: 57, holdDays: { ethereum: 11 } }), encoding: 'utf8' });
  assert.equal(sealCfg.status, 0, sealCfg.stdout + sealCfg.stderr);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fakes', 'fake-scan.mjs')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY } });
  assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout + r.stderr);
  const pub = r.stdout.split('\n').filter((l) => l.trim());
  assert.ok(pub.every((l) => !/\$\d|0x[0-9a-f]{6,}|2718|ONE\/WETH/i.test(l)), 'no amounts, addresses, config values or pools in the public log');
  assert.ok(pub.some((l) => /^pass: \d+ lines \(sealed\)/.test(l)));
  const store = openStore({ lockDir: path.join(dir, 'lock'), outDir: path.join(dir, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  const live = store.get('live.json'), hist = store.get('history.json'), snaps = store.get('snapshots.json');
  assert.ok(contractOk(live), 'live.json follows the contract');
  assert.ok(live.pools.every((p) => live.pairs[p.pairKey]?.pools.includes(p.id)), 'every pool sits in its pair');
  assert.equal(live.defaultWindow, '24h');
  assert.ok(live.pools.every((p) => Array.isArray(p.daily) && p.daily.length <= 30 && 'pattern' in p && 'burst' in p && !('daily' in (p.w['24h'] || {}))));
  assert.ok(live.pools.every((p) => p.w['24h'] == null || Array.isArray(p.w['24h'].gem.tags)), 'Gem now carries its tags');
  // the market block: the fake chain answers eth_gasPrice only and every price host fails, so gas reads
  // 2 gwei with no range yet, and each price is null, never 0
  const m = live.market;
  assert.ok(m && m.t === live.t && m.gas.gwei === 2 && m.gas.source === 'gasPrice' && m.gas.band === null && m.gas.p50 === null, JSON.stringify(m?.gas));
  assert.deepEqual(m.gas.hist.map((r) => r.slice(1)), [[2, 1]]);
  assert.ok(['ETH', 'BTC', 'SOL'].every((s) => m.px[s].usd === null && m.px[s].ch24 === null));
  assert.equal(live.ticket, 2718, 'the sealed config reaches live.json');
  assert.equal(live.gemAt, 57);
  assert.ok(live.pools.every((p) => p.w['30d'] && p.w['30d'].days >= 29), 'the backfill gives a full 30-day window on the first pass');
  assert.ok(live.pools.every((p) => p.w['24h'] && p.w['24h'].days >= 0.95 && p.w['24h'].lpFeesUsd != null), 'the hourly backfill covers the 24-hour window on the first pass');
  assert.ok(hist.v === 1 && Object.keys(hist.pools).length === live.pools.length && Array.isArray(hist.health));
  assert.ok(snaps.v === 1 && Object.keys(snaps.pools).length === live.pools.length);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'shortlist.json'), 'utf8')).ids.length >= 1);
  for (const f of fs.readdirSync(path.join(dir, 'out', 'data'))) assert.ok(!fs.readFileSync(path.join(dir, 'out', 'data', f), 'utf8').includes('2718'), `${f} is sealed`);
  // the liquidity chart's bins (docs/DATA.md): ±45% as before, coarser out to ±0.6375, far bins doubling out to ×10 / ÷10
  // (every fake pool has a thin full range), then one beyond bucket a side; all of it together is the whole map
  const EDGES_FAR = [-2.30259, -1.7625, -1.1625, -0.8625, -0.7125, -0.6375];
  for (const p of live.pools) {
    const s = p.shape;
    assert.equal(s.depth.length, 68, p.pair);
    assert.deepEqual(s.depthSpan, [-2.30259, 2.30259]);
    assert.equal(s.depthEdges.length, 69);
    assert.deepEqual(s.depthEdges.slice(0, 6), EDGES_FAR);
    assert.deepEqual(s.depthEdges.slice(-6), EDGES_FAR.map((x) => -x).reverse());
    assert.deepEqual(s.depthStep, { fine: 0.01875, coarse: 0.0375, edge: 0.45 });
    assert.ok(s.depth.every(([o, v], i) => o > s.depthEdges[i] && o < s.depthEdges[i + 1] && Number.isFinite(v) && v >= 0), p.pair);
    assert.ok(s.beyond.below >= 0 && s.beyond.above >= 0);
    const all = s.depth.reduce((a, d) => a + d[1], 0) + s.beyond.below + s.beyond.above;
    assert.ok(Math.abs(all / p.mapUsd - 1) < 1e-4, `${p.pair}: bars + beyond ${all} vs map ${p.mapUsd}`);
  }
  // the fake world parks a wall at +60..+90%: it was in beyond, now it is on the far bars
  const one = live.pools.find((p) => p.pair === 'ONE/WETH').shape, onFar = one.depth.filter(([o]) => o > 0.45).reduce((a, d) => a + d[1], 0);
  assert.ok(onFar > 0.5 * (onFar + one.beyond.above) && one.beyond.above < onFar, `far bars ${onFar} vs beyond ${one.beyond.above}`);
  // regression: the wider chart left parked, above, band9, walls and the ±45% bars exactly as the scan published
  // them before it (golden values from that scan of the same fake world; fine = a hash of the ±45% bars)
  const GOLD = {
    'ONE/WETH': { parked: 0.9771239018035686, above: 1, band9: 0.008468288551747008, walls: { below: 0.009375, above: 0.009375 }, fine: 'b9e1b94925c76411' },
    'UNI/WETH': { parked: 0, above: null, band9: 0.6464305135146509, walls: { below: 0.009375, above: 0.009375 }, fine: '6492e4ff967a1c32' },
    'ETH/ONE': { parked: 0, above: null, band9: 0.3953119424674881, walls: { below: 0.009375, above: 0.009375 }, fine: 'dc034ec3a670351b' },
  };
  const hash = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
  for (const [pair, g] of Object.entries(GOLD)) {
    const s = live.pools.find((p) => p.pair === pair)?.shape;
    assert.ok(s, pair);
    assert.deepEqual({ parked: s.parked, above: s.above, band9: s.band9, walls: s.walls, fine: hash(s.depth.filter(([o]) => Math.abs(o) < 0.45)) }, g, pair);
  }
  // history.json (lib/charts.mjs) on the first pass: the budgeted backfill fills the 24h and 30d windows' moments first
  for (const [id, hp] of Object.entries(hist.pools)) {
    assert.ok(hp.d.length >= 30 && hp.h.length >= 24, `first pass: ${hp.d.length} days, ${hp.h.length} hours`);
    assert.ok([hp.h, hp.d].every((rows) => rows.every((r, i) => r.length === 5 && (i === 0 || r[0] > rows[i - 1][0]))), id);
  }
  // planted faults: a missing field, a window field left undefined, or a NaN fails the contract check
  const bad1 = structuredClone(live); delete bad1.pools[0].shape;
  const bad2 = structuredClone(live); delete bad2.pools[0].w['30d'].feeApr;
  const bad3 = structuredClone(live); bad3.pools[0].w['30d'].net = NaN;
  for (const b of [bad1, bad2, bad3]) assert.equal(contractOk(b), false);
});

test('the backfill resumes pass after pass until history.json holds 90 days and 14 days of hours, the windows unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-scan-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const pass = () => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fakes', 'fake-scan.mjs')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY } });
  const store = openStore({ lockDir: path.join(dir, 'lock'), outDir: path.join(dir, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  const counts = [];
  let first = null;
  for (let k = 0; k < 5; k++) {
    const r = pass();
    assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout + r.stderr);
    const h = store.get('history.json');
    if (k === 0) first = store.get('live.json');
    counts.push(Object.values(h.pools).map((p) => [p.d.length, p.h.length]));
  }
  // each pass adds rows until both tiers are full; then nothing more is asked for
  const days = counts.map((c) => Math.min(...c.map((x) => x[0]))), hours = counts.map((c) => Math.min(...c.map((x) => x[1])));
  assert.ok(days.every((d, i) => i === 0 || d >= days[i - 1]) && hours.every((h, i) => i === 0 || h >= hours[i - 1]), `days ${days}, hours ${hours}`);
  assert.ok(days.at(-1) >= 90 && hours.at(-1) >= 14 * 24, `after 5 passes: ${days.at(-1)} days, ${hours.at(-1)} hours`);
  assert.ok(days[0] < days.at(-1) || hours[0] < hours.at(-1), 'one pass does not do it all: the budget holds');
  // the windows read only what they always read: the 30d window covers 30 days, not 90
  const live = store.get('live.json');
  assert.ok(live.pools.every((p) => p.w['30d'] && p.w['30d'].days <= 31 && p.w['7d'].days <= 7.1), 'windows keep their spans');
  assert.ok(live.pools.every((p) => p.daily.length <= 30));
  for (const p of live.pools) assert.equal(p.w['30d'].lpFeesUsd, first.pools.find((x) => x.id === p.id).w['30d'].lpFeesUsd, `${p.pair}: the 30d fees do not see the older rows`);
});
