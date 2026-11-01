// The dashboard's fixtures: made-up data that must follow docs/DATA.md exactly and add up, so the page
// is tested against the same shapes the scanner publishes. Plain Node, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeData, writeFixtures, FIXTURE_PASSPHRASE, CASES, PLANTED } from '../tools/fixtures/make-fixture.mjs';
import { unlock, open } from '../lib/lock.mjs';

const NOW = Date.UTC(2026, 10, 1, 13, 6);
const W = ['24h', '7d', '30d'];
const close = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x) => x === null || isNum(x);
const keys = (o, list, where) => { for (const k of list) assert.ok(k in o, `${where} lacks ${k}`); };

const { live, history, backtest } = makeData({ now: NOW });

test('live.json has every field of the contract', () => {
  keys(live, ['v', 't', 'phase', 'build', 'next', 'ticket', 'stopLoss', 'windows', 'defaultWindow', 'gemAt', 'chains', 'health', 'bench', 'pools'], 'live');
  assert.equal(live.v, 1);
  assert.deepEqual(live.windows, W);
  assert.equal(live.fixture, true, 'fixtures carry fixture: true (the page shows the MOCKUP ribbon)');
  for (const c of live.chains) keys(c, ['id', 'pools', 'unread', 'block', 'gasUsd'], 'chain');
  keys(live.health, ['loop', 'checks', 'sealedLog'], 'health');
  const ids = live.health.checks.map((c) => c.id);
  for (const id of ['fee-identity', 'price-vs-market', 'volume-vs-aggregator', 'maps-complete', 'lp-book', 'creation-events', 'volatility-xcheck', 'fees-vs-aggregator']) assert.ok(ids.includes(id), id);
  assert.ok(live.pools.some((p) => p.id === live.bench), 'the benchmark is in the pool list');
  assert.ok(live.pools.length >= 100, 'enough pools to page the table');
});

test('every pool and window follows the contract and adds up', () => {
  let windows = 0;
  for (const p of live.pools) {
    keys(p, ['id', 'chain', 'v', 'pair', 't0', 't1', 'feeTier', 'dynamicFee', 'lpKeeps', 'hooks', 'verified', 'firstSeen', 'createdAt', 'pairAgeDays', 'young',
      'tvlUsd', 'mapUsd', 'aggUsd', 'price', 'marketRatio', 'offMarket', 'shape', 'w', 'checks', 'gemFirstAt'], p.pair);
    keys(p.shape, ['tag', 'parked', 'above', 'band9', 'lpsAtPrice', 'depth', 'walls'], p.pair + ' shape');
    assert.ok(['served', 'mixed', 'stranded', 'one-sided'].includes(p.shape.tag));
    for (const [o, v] of p.shape.depth) assert.ok(Math.abs(o) <= 0.45 && v >= 0);
    assert.deepEqual(Object.keys(p.w), W);
    for (const wk of W) {
      const w = p.w[wk];
      if (w === null) continue;
      windows++;
      keys(w, ['days', 'partial', 'volUsd', 'lpFeesUsd', 'protocolFeesUsd', 'swaps', 'traders', 'sigma', 'range', 'rerangeDays', 'inRangeUsd',
        'feeApr', 'lvr', 'swapCost', 'gas', 'net', 'edge', 'aggApr', 'parkedAvg', 'strandedShare', 'markout', 'gem', 'lenses', 'spark'], `${p.pair} ${wk}`);
      keys(w.gem, ['total', 'stranded', 'yield', 'persistence', 'flow', 'warnings', 'missing'], 'gem');
      for (const k of ['feeApr', 'lvr', 'swapCost', 'gas', 'net', 'edge', 'aggApr', 'sigma', 'range', 'inRangeUsd']) assert.ok(numOrNull(w[k]), `${k} is a number or null`);
      if ([w.feeApr, w.lvr, w.swapCost, w.gas, w.net].every(isNum)) assert.ok(close(w.feeApr - w.lvr - w.swapCost - w.gas, w.net), 'net = fees - LVR - swaps - gas');
      if (isNum(w.feeApr) && isNum(w.lvr)) assert.ok(close(w.feeApr / w.lvr, w.edge, 2e-3), 'edge = feeApr / lvr');
      if (isNum(w.feeApr)) assert.ok(close((365 * w.lpFeesUsd) / w.days / (w.inRangeUsd + live.ticket), w.feeApr), 'fee APR = 365·F/(V+S)');
      assert.equal(w.partial, w.days < { '24h': 1, '7d': 7, '30d': 30 }[wk]);
    }
  }
  assert.ok(windows > 300);
});

test('the cases the page must handle are all present', () => {
  const pools = live.pools;
  assert.ok(pools.some((p) => p.young), 'a young pool');
  const velna = pools.filter((p) => p.t0.sym === 'VELNA' && ['WETH', 'ETH'].includes(p.t1.sym));
  const pr = live.pairs[velna[0].pairKey];
  assert.ok(pr && pr.pools.length === velna.length && velna.every((p) => p.pairKey === velna[0].pairKey), 'one pair key for WETH and native ETH');
  for (const wk of W) assert.ok(close(pr.w[wk].rows.reduce((a, r) => a + (r.volumeShare || 0), 0), 1, 2e-3), 'volume shares add to 1');
  assert.ok(pr.best && pools.find((p) => p.id === pr.best).verified !== false, 'best to enter is a verified pool');
  const top = pr.w['30d'].rows.slice().sort((a2, b2) => b2.net - a2.net)[0];
  assert.equal(pools.find((p) => p.id === top.id).verified, false, 'planted: the unverified pool has the highest net, so a guard that slips shows');
  assert.ok(velna.length >= 3 && velna.length <= 4 && velna.some((p) => p.t1.sym === 'ETH') && velna.some((p) => p.verified === false), 'a pair with 3-4 pools, one in native ETH, one unverified');
  assert.ok(pools.some((p) => p.verified === false && p.w['30d']?.gem.total == null), 'an unverified pool without a score');
  assert.ok(pools.some((p) => p.verified === null), 'a pool not checked yet');
  assert.ok(pools.some((p) => p.hooks), 'a hooked pool');
  assert.ok(pools.some((p) => p.tvlUsd === null), 'an unpriced pool');
  assert.ok(pools.some((p) => p.mapUsd === null && p.tvlUsd !== null), 'an unread map');
  assert.ok(pools.some((p) => p.lpKeeps === null), 'an unread protocol cut');
  assert.ok(pools.some((p) => Object.values(p.w).some((w) => w && w.sigma === null)), 'an unread volatility');
  const fresh = pools.find((p) => p.w['30d'] === null && p.w['7d'] && p.w['24h']);
  assert.ok(fresh, 'a fresh pool with only the 24h and 7d windows');
  assert.ok(fresh.w['7d'].partial);
  const planted = pools.find((p) => p.pair === PLANTED.unverifiedGem);
  assert.equal(planted.verified, false);
  assert.ok(planted.w['30d'].gem.total >= live.gemAt, 'planted: an unverified pool carrying a gem score');
  assert.ok(pools.some((p) => p.pair.startsWith(PLANTED.htmlTicker)), 'planted: a ticker that is HTML');
  // a different best find in each window, so the switch visibly changes the page
  const best = W.map((wk) => pools.filter((p) => p.verified !== false && p.w[wk]).sort((a, b) => (b.w[wk].gem.total ?? -1) - (a.w[wk].gem.total ?? -1))[0].pair);
  assert.equal(new Set(best).size, 3, 'three different best finds');
  assert.ok(pools.filter((p) => p.gemFirstAt && NOW - p.gemFirstAt < 24 * 3600e3).length >= 2, 'new gems in the last day');
});

test('backtests add up: series signs, net = fees + lvr + costs, strategies and grid', () => {
  const ids = Object.keys(backtest.pools);
  assert.ok(ids.length >= 5 && ids.includes(live.bench));
  for (const id of ids) {
    for (const wk of W) {
      const b = backtest.pools[id][wk];
      if (b === null) continue;
      keys(b, ['days', 'partial', 'range', 'trigger', 'forecastNet', 'net', 'netUsd', 'feesUsd', 'lvrUsd', 'costsUsd', 'entryUsd', 'tir', 'reranges', 'share',
        'sigma', 'sigmaFrom', 'swaps', 'series', 'strategies', 'grid', 'revert', 'realCheck'], 'backtest');
      assert.ok(b.lvrUsd <= 0 && b.costsUsd <= 0 && b.entryUsd <= 0 && b.feesUsd >= 0);
      assert.ok(close(b.feesUsd + b.lvrUsd + b.costsUsd, b.netUsd, 1e-3), 'netUsd = fees + lvr + costs (entry included)');
      assert.ok(close(((b.netUsd - b.entryUsd) / backtest.ticket) * (365 / b.days), b.net, 3e-3), 'net APR leaves out the entry cost');
      assert.ok(['pool', 'market'].includes(b.sigmaFrom));
      const s = b.series, n = s.t.length;
      for (const k of ['px', 'lo', 'hi', 'fees', 'lvr', 'costs', 'net']) assert.equal(s[k].length, n, k);
      for (let i = 0; i < n; i++) {
        assert.ok(s.fees[i] >= 0 && s.lvr[i] <= 0 && s.costs[i] <= 0);
        assert.ok(close(s.fees[i] + s.lvr[i] + s.costs[i], s.net[i], 1e-3));
        assert.ok(s.lo[i] < s.hi[i]);
      }
      assert.ok(close(s.net[n - 1], b.netUsd));
      assert.deepEqual(b.strategies.map((x) => x.id), ['ours', 'tight', 'wide', 'gamma', 'arrakis', 'full']);
      for (const st of b.strategies) assert.equal(st.series.length, n);
      assert.equal(b.grid.net.length, b.grid.widths.length);
      for (const row of b.grid.net) assert.equal(row.length, b.grid.triggers.length);
      assert.ok(b.grid.widths.includes(b.range), 'the grid holds our own width');
    }
  }
});

test('history.json follows the contract', () => {
  assert.equal(history.v, 1);
  for (const e of Object.values(history.pools)) {
    for (const row of e.h) assert.equal(row.length, 5);
    for (const row of e.d) assert.equal(row.length, 5);
  }
  for (const row of history.health) assert.equal(row.length, 4);
});

test('the no-gems case has no pool at or above the bar, and no backtests', () => {
  const d = makeData({ now: NOW, mode: 'nogems' });
  for (const p of d.live.pools) for (const wk of W) assert.ok((p.w[wk]?.gem.total ?? 0) < d.live.gemAt, `${p.pair} ${wk}`);
  assert.deepEqual(d.backtest.pools, {});
});

test('sealed case folders: the dummy passphrase opens them; stale, missing and re-keyed cases differ as planned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-fx-'));
  try {
    writeFixtures(dir, { now: NOW, iterations: 1000 });
    for (const c of CASES) assert.ok(fs.existsSync(path.join(dir, c, 'lock.json')), c);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'default', 'lock.json')));
    assert.throws(() => unlock(lock, 'wrong'), /wrong passphrase/);
    const { aes } = unlock(lock, FIXTURE_PASSPHRASE);
    const read = (c, f) => JSON.parse(fs.readFileSync(path.join(dir, c, f + '.json')));
    for (const f of ['live', 'history', 'backtest']) {
      const env = read('default', f);
      assert.deepEqual(Object.keys(env).sort(), ['ct', 'iv', 'lock', 't', 'z']);
      assert.equal(JSON.parse(open(env, aes)).v, 1);
    }
    assert.ok(!JSON.stringify(read('default', 'live')).includes('VELNA'), 'nothing readable outside the seal');
    assert.equal(read('stale', 'live').t, NOW - 3.2 * 3600e3);
    assert.equal(JSON.parse(open(read('stale', 'live'), aes)).t, NOW - 3.2 * 3600e3);
    assert.equal(read('amber', 'live').t, NOW - 20 * 60e3);
    assert.ok(!fs.existsSync(path.join(dir, 'nofiles', 'history.json')) && !fs.existsSync(path.join(dir, 'nofiles', 'backtest.json')));
    assert.throws(() => open(read('rekeyed', 'live'), aes));
    assert.equal(JSON.parse(open(read('rekeyed', 'history'), aes)).v, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
