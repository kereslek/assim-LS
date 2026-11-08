// Base and PancakeSwap through the whole scan, on the offline multi-chain fake world (test/fakes/fake-chains.mjs,
// MOCKUP · MADE-UP NUMBERS) with a throwaway lock: Base and PancakeSwap pools reach live.json tagged by chain
// and venue, PancakeSwap's protocol cut is read the PancakeSwap way, the checks run for the new venues, flow
// quality, the exchange screen and the discovery lanes are filled (null where unread, never 0), Base rows
// reach the shared snapshot store only from the live loop, and the public log holds counts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLock } from '../lib/lock.mjs';
import { openStore } from '../lib/store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DUMMY = 'scan chains test dummy passphrase, not a secret';
const A = (c) => '0x' + c.repeat(40);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-chains-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const run = (env = {}, timeout = 0) => spawnSync(process.execPath, [path.join(ROOT, 'test', 'fakes', 'fake-chains.mjs')], { cwd: dir, encoding: 'utf8', timeout, env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY, ...env } });
  const store = openStore({ lockDir: path.join(dir, 'lock'), outDir: path.join(dir, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  return { dir, run, store };
}

test('a Base pool and PancakeSwap pools go through the scan: venues tagged, the fee kept read their own way, checks, flow quality, the exchange screen and the lanes', () => {
  const { dir, run, store } = world();
  const r = run();
  assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout + r.stderr);
  const pub = r.stdout.split('\n').filter((l) => l.trim());
  assert.ok(pub.every((l) => !/\$\d|0x[0-9a-f]{6,}|ONE\/WETH|THREE\/WETH/i.test(l)), 'no amounts, addresses or pools in the public log');
  assert.ok(pub.some((l) => /^chains: ethereum 4 \(.*pancakeswap v3 ×1.*\); base 2 \(/.test(l)), 'the public log counts pools per chain and venue');
  assert.ok(pub.includes('PASS base fee identity') && pub.includes('PASS fee identity') && pub.includes('PASS base maps'), pub.join('\n'));
  const live = store.get('live.json');
  const by = (id) => live.pools.find((p) => p.id === id);
  // venues and chains
  assert.deepEqual(live.chains.map((c) => c.id), ['ethereum', 'base']);
  assert.deepEqual(live.chains.find((c) => c.id === 'base').dexes, { uniswap: 1, pancakeswap: 1 });
  const pcsEth = by(A('d')), baseUni = by(A('e')), basePcs = by(A('f')), one = by(A('a')), uni = by('0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801');
  for (const [p, chain, dex] of [[pcsEth, 'ethereum', 'pancakeswap'], [baseUni, 'base', 'uniswap'], [basePcs, 'base', 'pancakeswap'], [one, 'ethereum', 'uniswap']]) {
    assert.ok(p, `${chain} ${dex} pool scanned`);
    assert.equal(p.chain, chain); assert.equal(p.dex, dex);
  }
  assert.ok(live.pools.every((p) => ['uniswap', 'pancakeswap'].includes(p.dex)));
  // what LPs keep: PancakeSwap's 33%/34% cut (feeProtocol/10,000), Uniswap's 1/4 nibbles
  assert.ok(near(pcsEth.lpKeeps, (0.67 + 0.66) / 2, 1e-9) && near(basePcs.lpKeeps, 0.665, 1e-9), `${pcsEth.lpKeeps} ${basePcs.lpKeeps}`);
  assert.ok(near(one.lpKeeps, 0.75, 1e-9) && near(baseUni.lpKeeps, 0.75, 1e-9));
  assert.equal(pcsEth.feeTier, 0.0025);
  // the checks run for the new venues: the swaps reproduce the fee counters, the windows match the replay
  for (const p of [pcsEth, baseUni, basePcs]) {
    const ck = (id) => p.checks.find((c) => c.id === id)?.ok;
    assert.equal(ck('fee-identity'), true, `${p.chain} ${p.dex} fee identity`);
    assert.equal(ck('window-vs-replay'), true, `${p.chain} ${p.dex} window vs replay`);
    assert.equal(ck('maps-complete'), true);
    assert.ok(p.w['24h'] && p.w['24h'].lpFeesUsd > 0 && p.w['24h'].volUsd > 0, `${p.chain} ${p.dex}: a 24 h window`);
    assert.ok(p.mapUsd > 0 && p.tvlUsd > 0 && p.mapUsd / p.tvlUsd <= 1.02, 'the map within the balances');
  }
  assert.equal(live.health.checks.find((c) => c.id === 'fee-identity').ok, true);
  assert.match(live.health.checks.find((c) => c.id === 'fee-identity').detail, /Base: /);
  // Base on its own clock: a day is 432,000 blocks (0.2 s blocks)
  assert.ok(live.chains.find((c) => c.id === 'base').block > 54_000_000);
  // flow quality in every window: numbers where read, null where not (never undefined)
  for (const p of live.pools) for (const w of live.windows) {
    if (!p.w[w]) continue;
    assert.deepEqual(Object.keys(p.w[w].flow).sort(), ['driftCorr', 'retailShare', 'routing', 'senders']);
    for (const v of Object.values(p.w[w].flow)) assert.ok(v === null || Number.isFinite(v));
  }
  // half of each pool's sampled transactions went to a known router
  for (const p of [one, baseUni, basePcs]) assert.equal(p.w['24h'].flow.routing, 0.5, `${p.chain} ${p.dex} routing`);
  assert.equal(basePcs.w['24h'].flow.senders, 24);
  assert.ok(basePcs.w['24h'].flow.retailShare >= 0 && basePcs.w['24h'].flow.retailShare <= 1);
  // the exchange screen: ONE trades $5M on exchanges (its DEX ticker left out); UNI's tickers unread → null; THREE
  // trades on DEXes only → a real 0
  assert.equal(one.cex.cexVol24, 5e6);
  assert.ok(one.cex.cexRatio > 0 && Number.isFinite(one.cex.tierVsSigma) && one.cex.coin === 'one-coin' && one.cex.t > 0);
  assert.deepEqual([uni.cex.cexVol24, uni.cex.cexRatio, uni.cex.coin], [null, null, null], 'missing tickers: null, never 0');
  assert.equal(baseUni.cex.cexVol24, 0); assert.equal(baseUni.cex.cexRatio, 0);
  assert.ok(basePcs.sigmaChain == null || !('sigmaChain' in basePcs), 'the young pool has no 30-day σ of its own');
  assert.ok(Number.isFinite(basePcs.cex.tierVsSigma), 'its tokens\' market history (DefiLlama first) gives the σ');
  assert.ok(live.health.cex.calls >= 1 && live.health.cex.calls <= live.health.cex.perDay);
  // the lanes
  assert.deepEqual(Object.keys(live.discovery).sort(), ['cexLed', 'crossChain', 'newPools', 'retailUp']);
  assert.deepEqual(live.discovery.newPools, [A('f')], 'the young Base pool with 24 senders');
  assert.deepEqual(live.discovery.crossChain, []);
  for (const id of live.discovery.cexLed) assert.ok(by(id).w[live.defaultWindow].lenses.includes('cexled'));
  for (const id of live.discovery.retailUp) assert.ok(by(id).w[live.defaultWindow].lenses.includes('retail'));
  assert.ok(live.discovery.cexLed.includes(A('a')), 'ONE/WETH: exchange volume far above its value at the price, a wide tier');
  // a pair on Base is its own pair
  assert.ok(baseUni.pairKey.startsWith('base:') && live.pairs[baseUni.pairKey].pools.includes(basePcs.id));
  assert.ok(live.pools.every((p) => live.pairs[p.pairKey]?.pools.includes(p.id)));
  // the backtest's shortlist: Ethereum's Uniswap pools only
  const short = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'shortlist.json'), 'utf8')).ids;
  assert.ok(short.every((id) => by(id)?.chain === 'ethereum' && by(id)?.dex === 'uniswap'));
  // outside the live loop, Base rows stay out of the shared store (an older loop's clock reads every row's block)
  const snaps = store.get('snapshots.json');
  assert.ok(Object.keys(snaps.pools).includes(A('a')) && Object.keys(snaps.pools).includes(A('d')));
  assert.ok(!Object.keys(snaps.pools).includes(A('e')) && !Object.keys(snaps.pools).includes(A('f')), 'no Base rows stored');
  assert.deepEqual(live.stored, ['ethereum']);
  // history.json charts every scanned pool, Base included
  const hist = store.get('history.json');
  assert.ok([A('e'), A('f'), A('d')].every((id) => hist.pools[id]?.h.length >= 1));
});

test('Base rows reach the store from the live loop, and stay once a live pass has said so', () => {
  const { run, store } = world();
  assert.ok(run({ MODE: 'live' }).stdout.includes('PASS sealed outputs'));
  let live = store.get('live.json'), snaps = store.get('snapshots.json');
  assert.deepEqual(live.stored, ['ethereum', 'base']);
  assert.ok(Object.keys(snaps.pools).includes(A('e')) && Object.keys(snaps.pools).includes(A('f')));
  const hBase = snaps.pools[A('e')].h.t.length;
  // a pass outside the loop after it (a push run): the last live.json says Base rows are kept
  assert.ok(run().stdout.includes('PASS sealed outputs'));
  live = store.get('live.json'); snaps = store.get('snapshots.json');
  assert.deepEqual(live.stored, ['ethereum', 'base']);
  assert.ok(snaps.pools[A('e')].h.t.length >= hBase);
  // the young pool: nothing before its creation (30 h ago) is ever stored
  const ts = snaps.pools[A('f')].h.t.reduce((acc, d, i) => [...acc, i ? acc[i - 1] + d : d], []);
  assert.ok(ts.every((t) => t >= Date.now() - 31 * 3600e3), 'no row before the pool existed');
});

test('planted fault: pools that book PancakeSwap\'s cut as Uniswap\'s 1/N fail the fee identity', () => {
  const { run, store } = world();
  const r = run({ FAULT: 'pcs-nibbles' });
  assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout + r.stderr);
  const live = store.get('live.json');
  for (const id of [A('d'), A('f')]) assert.equal(live.pools.find((p) => p.id === id).checks.find((c) => c.id === 'fee-identity').ok, false, id);
  assert.equal(live.pools.find((p) => p.id === A('e')).checks.find((c) => c.id === 'fee-identity').ok, true, 'the Uniswap pool next to it still passes');
});

// The read caps (lib/chains.mjs caps, lib/budget.mjs). Planted faults: the scan before the caps retried and halved a
// refused Base log read for many minutes, and read every slow Base answer without end; these runs would time out.
test('planted fault: every Base node refuses logs — the swaps cap stops the read in time, its pools\' swap values are null (not read), never 0', () => {
  const { run, store } = world();
  const t0 = Date.now();
  const r = run({ FAULT: 'base-logs-refuse', READ_CAPS: JSON.stringify({ base: { swaps: { ms: 3000, calls: 60 } } }) }, 90e3);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 < 60e3, 'the pass did not run over');
  const pub = r.stdout.split('\n');
  assert.ok(pub.includes('N/A  base swaps'), 'the Base swaps are unread, not failed');
  assert.ok(pub.some((l) => /^caps: .*base .*swaps \d+ s, \d+ calls \((time|calls) cap\)/.test(l) && /stopped by a cap: base swaps/.test(l)), pub.join('\n'));
  assert.ok(pub.includes('PASS swaps') && pub.includes('PASS fee identity'), 'Ethereum is untouched');
  const live = store.get('live.json');
  for (const id of [A('e'), A('f')]) {
    const p = live.pools.find((x) => x.id === id), ck = (k) => p.checks.find((c) => c.id === k)?.ok;
    assert.equal(ck('swaps-read'), null, `${id}: a day of swaps not read`);
    assert.equal(ck('markouts-read'), null);
    assert.equal(ck('fee-identity'), null, 'no replay: the check did not run (null), never a pass or a fail');
    assert.equal(p.w['24h']?.flow?.retailShare ?? null, null, 'retail share not read: null, never 0');
  }
  assert.ok(live.pools.filter((p) => p.chain === 'ethereum').every((p) => p.checks.find((c) => c.id === 'swaps-read').ok === true));
});

test('planted fault: the Base backstop spent during steps 1-5 does not cut the outputs\' own reads (fee counters now stay read)', () => {
  const { run, store } = world();
  // a backstop so short that Base's steps 1-5 read nothing past the first calls: maps unread, no Base pools
  const r = run({ READ_CAPS: JSON.stringify({ base: { chain: { ms: 1 } } }) }, 90e3);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('PASS sealed outputs'));
  const live = store.get('live.json');
  assert.ok(live.pools.filter((p) => p.chain === 'ethereum').length >= 4, 'Ethereum untouched');
  assert.equal(live.pools.filter((p) => p.chain === 'base').length, 0, 'Base pools not read this pass: left out, never zeros');
  // and with room for steps 1-5, the outputs read the counters as usual (rows carry fee growth)
  const ok = run({ READ_CAPS: JSON.stringify({ base: { chain: { ms: 60000 } } }) }, 90e3);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const p = store.get('live.json').pools.find((x) => x.id === A('e'));
  assert.ok(p && p.w['24h'] && p.w['24h'].lpFeesUsd > 0, 'the Base pool has its 24 h fees from the counters');
});
