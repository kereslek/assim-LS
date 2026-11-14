// The CoinGecko diet (lib/apicount.mjs and its readers): a hard daily CoinGecko budget counted across passes and
// runs, the fallback order DefiLlama → Coinbase / GeckoTerminal → CoinGecko → null, and a stopped run that resumes
// from its cache instead of fetching everything again. Planted faults; made-up numbers and addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApiCounter, sourceOf, CG_DAILY_CAP } from '../lib/apicount.mjs';
import { readPrices, marketBlock } from '../lib/market.mjs';
import { tokenHistory, makeHistoryCache } from '../lib/history.mjs';
import { cexVolumes, makeCexCache, CEX_BUDGET } from '../lib/cex.mjs';
import { cachedUniverse } from '../lib/universe.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-apis-'));
const NOW = Date.UTC(2026, 10, 8, 12), DAY = '2026-11-08';
const A = (c) => 'ethereum:0x' + c.repeat(40);
const ok = (j) => async () => j;

test('sources by host; the daily CoinGecko budget holds across passes, processes and loop jobs', async () => {
  assert.deepEqual(['https://api.coingecko.com/api/v3/ping', 'https://pro-api.coingecko.com/x', 'https://coins.llama.fi/x', 'https://api.exchange.coinbase.com/p', 'https://api.geckoterminal.com/api/v2/x', 'https://evil.com/coingecko.com', 'nonsense'].map(sourceOf),
    ['coingecko', 'coingecko', 'defillama', 'coinbase', 'geckoterminal', null, null]);
  const file = path.join(dir(), 'apis.json');
  let sent = 0;
  const raw = async () => { sent++; return {}; };
  // pass 1: 100 calls go out
  const a = makeApiCounter({ file, now: NOW });
  const g1 = a.wrap(raw);
  for (let i = 0; i < 100; i++) await g1('https://api.coingecko.com/api/v3/x');
  await g1('https://coins.llama.fi/x');
  a.save();
  // pass 2 (a new process): 50 more allowed, then refused without being sent
  const b = makeApiCounter({ file, now: NOW + 3600e3 });
  const g2 = b.wrap(raw);
  let refused = 0;
  for (let i = 0; i < 80; i++) await g2('https://api.coingecko.com/api/v3/x').catch((e) => { if (e.budget) refused++; });
  assert.equal(b.used(), CG_DAILY_CAP);
  assert.equal(refused, 30);
  assert.equal(sent, 151, 'never more than the cap goes out in a day (plus the one DefiLlama call)');
  assert.equal(b.allow('coingecko'), false);
  assert.equal(b.allow('defillama'), true, 'only CoinGecko is capped');
  assert.match(b.line(), /coingecko 50 this pass \(150 of 150 today, 30 refused by the budget\), defillama 0/);
  b.save();
  // a new loop job without the file: the sealed live.json carries the count
  const c = makeApiCounter({ file: path.join(dir(), 'none.json'), now: NOW + 7200e3, seed: b.health() });
  assert.equal(c.left(), 0);
  // the pool list ran first in a new job (no file, no seed): its calls add to the live.json count, not max with it
  const f2 = path.join(dir(), 'apis.json');
  const p = makeApiCounter({ file: f2, now: NOW });
  for (let i = 0; i < 9; i++) await p.wrap(raw)('https://api.coingecko.com/api/v3/x');
  p.save();
  const s = makeApiCounter({ file: f2, now: NOW });
  s.seed({ day: DAY, coingecko: { used: 100, cap: 150 }, defillama: 5 });
  assert.equal(s.used(), 109);
  s.save();
  const s2 = makeApiCounter({ file: f2, now: NOW, seed: { day: DAY, coingecko: { used: 109 } } });
  assert.equal(s2.used(), 109, 'once known, the larger count wins (no double count)');
  // a reserve keeps room for higher-priority readers
  assert.equal(makeApiCounter({ now: NOW, seed: { day: DAY, coingecko: { used: 110 } } }).allow('coingecko', { reserve: 40 }), false);
  // a new UTC day starts at 0
  assert.equal(makeApiCounter({ file, now: NOW + 86400e3 }).used(), 0);
  // a broken file is no count, never a crash
  fs.writeFileSync(file, '{oops');
  assert.equal(makeApiCounter({ file, now: NOW }).used(), 0);
  const h = a.health();
  assert.deepEqual(Object.keys(h), ['day', 'coingecko', 'defillama', 'coinbase', 'geckoterminal', 'kraken', 'okx', 'gate', 'kucoin']);
  assert.deepEqual(Object.keys(h.coingecko), ['used', 'cap', 'out']);
});

// a routed fake: each host can be down
const route = (down = {}) => {
  const asked = { defillama: 0, coinbase: 0, coingecko: 0 };
  const T = NOW / 1000;
  const fn = async (u) => {
    const s = sourceOf(u);
    asked[s]++;
    if (down[s]) throw new Error('HTTP 503');
    if (u.includes('/prices/current/')) return { coins: { 'coingecko:ethereum': { price: 3000, timestamp: T }, 'coingecko:bitcoin': { price: 90000, timestamp: T }, 'coingecko:solana': { price: 150, timestamp: T } } };
    if (u.includes('/percentage/')) return { coins: { 'coingecko:ethereum': 1, 'coingecko:bitcoin': 1, 'coingecko:solana': 1 } };
    if (u.includes('/spot')) return { data: { amount: u.includes('ETH') ? '3001' : u.includes('BTC') ? '90001' : '151' } };
    if (u.includes('/stats')) return { open: '100', last: '102' };
    if (u.includes('simple/price')) return { ethereum: { usd: 3002, usd_24h_change: 1 }, bitcoin: { usd: 90002, usd_24h_change: 1 }, solana: { usd: 152, usd_24h_change: 1 } };
    throw new Error('HTTP 404');
  };
  return { fn, asked };
};

test('top-strip prices: DefiLlama → Coinbase → CoinGecko → null, and the budget spent means null, never 0', async () => {
  const srcs = async (down, apis = null) => { const r = route(down); const p = await readPrices(apis ? apis.wrap(r.fn) : r.fn, { nowS: NOW / 1000, apis }); return { src: Object.values(p.px).map((x) => x.src), usd: p.px.ETH.usd, asked: r.asked }; };
  const up = await srcs({});
  assert.deepEqual(up.src, ['defillama', 'defillama', 'defillama']);
  assert.equal(up.asked.coingecko, 0, 'planted: the old code asked CoinGecko every pass');
  const noLlama = await srcs({ defillama: 1 });
  assert.deepEqual([noLlama.src, noLlama.usd, noLlama.asked.coingecko], [['coinbase', 'coinbase', 'coinbase'], 3001, 0]);
  const noBoth = await srcs({ defillama: 1, coinbase: 1 });
  assert.deepEqual([noBoth.src, noBoth.usd, noBoth.asked.coingecko], [['coingecko', 'coingecko', 'coingecko'], 3002, 1]);
  const spent = makeApiCounter({ now: NOW, seed: { day: DAY, coingecko: { used: CG_DAILY_CAP } } });
  const none = await srcs({ defillama: 1, coinbase: 1 }, spent);
  assert.deepEqual([none.src, none.usd, none.asked.coingecko], [[null, null, null], null, 0]);
  const all = await srcs({ defillama: 1, coinbase: 1, coingecko: 1 });
  assert.deepEqual([all.src, all.usd], [[null, null, null], null]);
});

test('the DefiLlama vs CoinGecko check runs once a UTC day, not every pass', async () => {
  const r = route();
  let prev = null, cg = 0;
  const fn = async (u) => { if (u.includes('coingecko.com')) cg++; return r.fn(u); };
  for (let i = 0; i < 24; i++) prev = (await marketBlock({ rpc: null, getJson: fn, prev, now: NOW + i * 600e3 })).market;
  assert.equal(cg, 1, '24 passes, one CoinGecko call');
  assert.deepEqual(prev.xcheck, { day: DAY, both: 3, agree: 3 });
  await marketBlock({ rpc: null, getJson: fn, prev, now: NOW + 86400e3 });
  assert.equal(cg, 2, 'a new day asks again');
  // CoinGecko down that day: asked once, not every pass
  let down = 0;
  const bad = async (u) => { if (u.includes('coingecko.com')) { down++; throw new Error('HTTP 503'); } return r.fn(u); };
  let p2 = null;
  for (let i = 0; i < 5; i++) p2 = (await marketBlock({ rpc: null, getJson: bad, prev: p2, now: NOW + i * 600e3 })).market;
  assert.equal(down, 1);
  assert.deepEqual(p2.xcheck, { day: DAY, both: 0, agree: 0 });
});

// history fakes: DefiLlama's chart answers the keys in `llama`, GeckoTerminal the ones in `gt`, CoinGecko the ones in `cg`
const histFake = ({ llama = [], gt = [], cg = [], down = {} } = {}) => {
  const asked = { defillama: [], geckoterminal: [], coingecko: [] };
  const nowS = Math.floor(Date.now() / 1000);
  const fn = async (u) => {
    const s = sourceOf(u);
    if (down[s]) { asked[s].push('down'); throw new Error('HTTP 503'); }
    if (s === 'defillama') {
      const keys = decodeURIComponent(u.split('/chart/')[1].split('?')[0]).split(',');
      asked.defillama.push(...keys);
      return { coins: Object.fromEntries(keys.filter((k) => llama.includes(k)).map((k) => [k, { prices: Array.from({ length: 31 }, (_, i) => ({ timestamp: nowS - (30 - i) * 86400, price: 1 + (i % 2) * 0.01 })) }])) };
    }
    if (s === 'geckoterminal') {
      const addr = /tokens\/(0x[0-9a-f]+)\/pools/.exec(u)?.[1] ?? /token=(0x[0-9a-f]+)/.exec(u)?.[1];
      asked.geckoterminal.push(addr);
      if (!gt.includes('ethereum:' + addr)) throw new Error('HTTP 404');
      if (u.includes('/pools?')) return { data: [{ attributes: { address: '0x' + 'f'.repeat(40) } }] };
      return { data: { attributes: { ohlcv_list: Array.from({ length: 48 }, (_, i) => [nowS - (48 - i) * 3600, 1, 1, 1, 2 + (i % 2) * 0.01, 5]) } } };
    }
    if (s === 'coingecko') {
      const addr = u.split('/contract/')[1].split('/')[0];
      asked.coingecko.push(addr);
      if (!cg.includes('ethereum:' + addr)) throw new Error('HTTP 404');
      return { prices: Array.from({ length: 48 }, (_, i) => [Date.now() - (48 - i) * 3600e3, 3]) };
    }
    throw new Error('HTTP 404');
  };
  return { fn, asked };
};
const quick = { llama: { spacingMs: 0 }, gt: { spacingMs: 0 }, cg: { spacingMs: 0 } };

test('token history: DefiLlama first, then GeckoTerminal, then CoinGecko; the budget spent leaves it unread', async () => {
  const keys = [A('1'), A('2'), A('3'), A('4')];
  const f = histFake({ llama: [A('1')], gt: [A('2')], cg: [A('3')] });
  const apis = makeApiCounter({ now: NOW });
  const r = await tokenHistory(apis.wrap(f.fn), keys, { cache: makeHistoryCache(path.join(dir(), 'h.json')), apis, ...quick });
  assert.deepEqual(r.by, { cache: 0, defillama: 1, geckoterminal: 1, coingecko: 1 });
  assert.equal(r.series.get(A('2'))[0].price, 2, 'GeckoTerminal answered A2');
  assert.equal(r.series.get(A('3'))[0].price, 3, 'CoinGecko answered A3');
  assert.deepEqual(r.unread, [A('4')], 'nobody knows A4: unread, never a flat line');
  assert.ok(!f.asked.coingecko.includes('1'.repeat(40)) && !f.asked.coingecko.includes('2'.repeat(40)), 'CoinGecko only for what the others lack');
  // DefiLlama down: GeckoTerminal then CoinGecko carry it
  const d = histFake({ gt: [A('1')], cg: [A('2')], down: { defillama: 1 } });
  const r2 = await tokenHistory(d.fn, [A('1'), A('2')], { cache: makeHistoryCache(path.join(dir(), 'h.json')), ...quick });
  assert.deepEqual([r2.by.geckoterminal, r2.by.coingecko, r2.unread.length], [1, 1, 0]);
  // the budget spent: CoinGecko is not asked and the token stays unread (null downstream, never 0)
  const spent = makeApiCounter({ now: NOW, seed: { day: DAY, coingecko: { used: CG_DAILY_CAP } } });
  const e = histFake({ cg: [A('1')], down: { defillama: 1, geckoterminal: 1 } });
  const r3 = await tokenHistory(spent.wrap(e.fn), [A('1')], { cache: makeHistoryCache(path.join(dir(), 'h.json')), apis: spent, ...quick });
  assert.deepEqual([e.asked.coingecko.length, r3.unread], [0, [A('1')]]);
  // CoinGecko history leaves its reserve for the other readers
  const low = makeApiCounter({ now: NOW, seed: { day: DAY, coingecko: { used: CG_DAILY_CAP - 30 } } });
  const e2 = histFake({ cg: [A('1')], down: { defillama: 1, geckoterminal: 1 } });
  await tokenHistory(low.wrap(e2.fn), [A('1')], { cache: null, apis: low, ...quick });
  assert.equal(e2.asked.coingecko.length, 0, '30 left, under the 40 reserve: not asked');
});

test('a stopped run resumes from its cache: nothing fetched twice the same day, and a source that said no is not asked again', async () => {
  const file = path.join(dir(), 'history.json');
  const keys = Array.from({ length: 12 }, (_, i) => A((i + 1).toString(16)));
  // a pass stopped after the first 6 tokens were answered by GeckoTerminal (DefiLlama knows none of them)
  const f = histFake({ gt: keys });
  const c1 = makeHistoryCache(file, { now: NOW, saveEvery: 3 });
  await tokenHistory(f.fn, keys, { cache: c1, gtMax: 6, ...quick });
  // no c1.save(): the process was killed here. The next pass (a new process) reads what was written along the way.
  const g = histFake({ gt: keys });
  const c2 = makeHistoryCache(file, { now: NOW + 600e3 });
  const r = await tokenHistory(g.fn, keys, { cache: c2, gtMax: 6, ...quick });
  assert.equal(r.by.cache, 6, 'the 6 answered before the stop come from the cache');
  assert.equal(r.by.geckoterminal, 6);
  assert.equal(g.asked.defillama.length, 0, 'DefiLlama said no to these today: not asked again');
  assert.equal(new Set(g.asked.geckoterminal).size, 6, 'only the 6 missing ones asked');
  // planted fault: without the saves along the way, the second pass would ask all 12 again
  const h = histFake({ gt: keys });
  await tokenHistory(h.fn, keys, { cache: makeHistoryCache(path.join(dir(), 'x.json'), { now: NOW, saveEvery: 0 }), gtMax: 6, ...quick });
  const h2 = histFake({ gt: keys });
  await tokenHistory(h2.fn, keys, { cache: makeHistoryCache(path.join(dir(), 'x.json'), { now: NOW }), gtMax: 12, ...quick });
  assert.equal(new Set(h2.asked.geckoterminal).size, 12);
});

test('exchange tickers: only the top N coins, each once in 24 h, within the daily budget', async () => {
  const asked = [];
  const getJson = async (u) => { asked.push(u.split('/coins/')[1].split('/')[0]); return { tickers: [{ base: 'X', target: 'USDT', market: { name: 'Ex', identifier: 'ex' }, converted_volume: { usd: 1e6 } }] }; };
  const coins = Array.from({ length: 40 }, (_, i) => `coin-${i}`);
  const file = path.join(dir(), 'cex.json'), budget = { ...CEX_BUDGET, perPass: 40, spacingMs: 0 };
  let calls = 0;
  for (let pass = 0; pass < 30; pass++) { // a day of passes
    const cache = makeCexCache(file, { now: NOW + pass * 360e3 });
    calls += (await cexVolumes(getJson, coins, { cache, now: NOW + pass * 360e3, budget })).calls;
    cache.save();
  }
  assert.equal(calls, CEX_BUDGET.topN, 'each of the top 15 once, then served from the 24 h cache');
  assert.ok(asked.every((c) => coins.indexOf(c) < CEX_BUDGET.topN));
  const r = await cexVolumes(getJson, coins, { cache: makeCexCache(file, { now: NOW + 3 * 3600e3 }), now: NOW + 3 * 3600e3, budget });
  assert.equal(r.vol.get('coin-20'), null, 'past the top N: null, never 0');
  // the daily budget spent: no call, the cached values still serve
  const spent = makeApiCounter({ now: NOW, seed: { day: DAY, coingecko: { used: CG_DAILY_CAP - 5 } } });
  const r2 = await cexVolumes(getJson, ['fresh-coin'], { cache: makeCexCache(path.join(dir(), 'c2.json'), { now: NOW }), now: NOW, budget, apis: spent });
  assert.deepEqual([r2.calls, r2.vol.get('fresh-coin')], [0, null]);
});

test('the universe: CoinGecko once a day through the cache; no budget room → the older cache', async () => {
  const file = path.join(dir(), 'universe.json');
  let fetches = 0;
  const fetch = async () => { fetches++; return { markets: [{ id: 'one', symbol: 'one', market_cap_rank: 150, current_price: 2 }], list: [{ id: 'one', platforms: { ethereum: '0x' + '1'.repeat(40), solana: 'x' } }, { id: 'other', platforms: {} }], unreadPages: [] }; };
  const a = await cachedUniverse(ok(null), { file, now: NOW, fetch });
  const b = await cachedUniverse(ok(null), { file, now: NOW + 20 * 3600e3, fetch });
  assert.deepEqual([fetches, a.from, b.from], [1, 'coingecko', 'cache']);
  assert.deepEqual(b.list, [{ id: 'one', platforms: { ethereum: '0x' + '1'.repeat(40) } }], 'the cache keeps only the ranked coins and the chains scanned');
  const spent = makeApiCounter({ now: NOW, seed: { day: DAY, coingecko: { used: CG_DAILY_CAP - 3 } } });
  const c = await cachedUniverse(ok(null), { file, now: NOW + 30 * 3600e3, fetch, apis: spent });
  assert.deepEqual([fetches, c.from], [1, 'cache']);
  const d = await cachedUniverse(ok(null), { file, now: NOW + 30 * 3600e3, fetch });
  assert.deepEqual([fetches, d.from], [2, 'coingecko']);
});
