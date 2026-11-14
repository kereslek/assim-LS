// CoinGecko's monthly quota out (lib/apicount.mjs, lib/universe.mjs, lib/cex.mjs): the refusal is told apart from a
// busy minute or a server error, the month's mark stops every CoinGecko call until the 1st, the universe serves
// from its cache up to 45 days old, and the exchange screen falls back to the exchanges' own public APIs.
// Planted faults; made-up numbers, tickers and ids only (MOCKUP · MADE-UP NUMBERS).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApiCounter, quotaRefusal, statusOf, untilText, CG_STREAK } from '../lib/apicount.mjs';
import { getJson as realGetJson } from '../lib/rpc.mjs';
import { cachedUniverse, fetchCoinGecko, UNIVERSE_STALE_MS } from '../lib/universe.mjs';
import { BudgetError } from '../lib/budget.mjs';
import {
  cexVolumes, makeCexCache, CEX_BUDGET, exchangeVolumes, venueVolumes, VENUES, FALLBACK_BUDGET,
  parseCoinbaseStats, parseCoinbaseOne, parseCoinbaseProducts, parseKraken, parseOkx, parseGate, parseKucoin,
} from '../lib/cex.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-cgout-'));
const NOW = Date.UTC(2026, 10, 14, 9), DAY = 86400e3;
const CG = 'https://api.coingecko.com/api/v3/coins/markets?page=1';
const QUOTA_BODY = JSON.stringify({ status: { error_code: 429, error_message: "You've reached 10,000 calls limit. You may visit developer dashboard to check your usage." } });
const BUSY_BODY = JSON.stringify({ status: { error_code: 429, error_message: "You've exceeded the Rate Limit. Please visit https://www.coingecko.com/en/api/pricing to subscribe to our API plans for higher rate limits." } });
const httpErr = (status, body = '') => Object.assign(new Error('HTTP ' + status), { status, body });

test('getJson: a refused call carries its status and the first part of the answer; the message is unchanged', async () => {
  const keep = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => QUOTA_BODY + 'x'.repeat(2000) });
    const e = await realGetJson('https://example.invalid/x').catch((x) => x);
    assert.equal(e.message, 'HTTP 429');
    assert.equal(e.status, 429);
    assert.ok(e.body.startsWith(QUOTA_BODY) && e.body.length <= 600);
    assert.equal(quotaRefusal(e), true);
  } finally { globalThis.fetch = keep; }
});

test('the monthly refusal: a quota answer trips it at once; a plain 500 or a busy-minute 429 never does', async () => {
  assert.equal(quotaRefusal(httpErr(429, QUOTA_BODY)), true);
  assert.equal(quotaRefusal(httpErr(429, BUSY_BODY)), false, 'the per-minute limit names "plans" but not the calls limit');
  assert.equal(quotaRefusal(httpErr(500, 'monthly maintenance')), false, 'planted: a 500 that says "monthly" is a server error');
  assert.equal(quotaRefusal(new Error('timeout')), false);
  assert.deepEqual([statusOf(new Error('HTTP 429')), statusOf(httpErr(503)), statusOf(new Error('nope'))], [429, 503, null]);
  assert.equal(untilText('2026-11'), '1 Dec');
  assert.equal(untilText('2026-12'), '1 Jan');
  // a plain 500, many times: never out
  const file = path.join(dir(), 'apis.json');
  let sent = 0, t = NOW;
  const a = makeApiCounter({ file, now: NOW, clock: () => t });
  const down = a.wrap(async () => { sent++; t += 60e3; throw httpErr(500, '<html>monthly report</html>'); });
  for (let i = 0; i < 12; i++) await down(CG).catch(() => {});
  assert.equal(a.isOut(), false, 'planted: a server error is not the quota');
  assert.equal(a.allow('coingecko'), true);
  // the quota answer: out at once; the next call is not sent
  const q = a.wrap(async () => { sent++; throw httpErr(429, QUOTA_BODY); });
  await q(CG).catch(() => {});
  assert.equal(a.isOut(), true);
  const before = sent;
  const e = await q(CG).catch((x) => x);
  assert.equal(e instanceof BudgetError || e.budget === true, true, 'refused here, as a spent budget (the readers treat it as unread)');
  assert.equal(sent, before, 'not sent while the quota is out');
  assert.equal(a.allow('coingecko'), false);
  assert.equal(a.allow('defillama'), true, 'only CoinGecko stops');
  assert.equal(a.left(), 0);
  assert.equal(a.health().coingecko.out, '2026-11');
  assert.equal(a.outLine(), 'coingecko: monthly quota out until 1 Dec; fallbacks serving');
  assert.match(a.line(), /monthly quota out until 1 Dec \(found this run: the refusal names the calls limit\), 1 calls not made/);
  assert.doesNotMatch(a.line() + a.outLine(), /https?:|key/i, 'no URL and no key in the public lines');
  // the next process (the scan after the pool list) reads it from the file, and a new loop job from live.json
  assert.equal(makeApiCounter({ file, now: NOW + 3600e3 }).isOut(), true);
  assert.equal(makeApiCounter({ now: NOW + 3600e3, seed: a.health() }).isOut(), true);
});

test('the monthly refusal from 429s in a row: only when they last longer than a busy minute; an answer resets the run', async () => {
  let t = NOW;
  const busy = async () => { t += 2e3; throw httpErr(429, BUSY_BODY); };
  // a burst of 429s inside a minute: the per-minute limit, not the month
  const a = makeApiCounter({ now: NOW, clock: () => t });
  const g = a.wrap(busy);
  for (let i = 0; i < 20; i++) await g(CG).catch(() => {});
  assert.equal(a.isOut(), false, 'planted: 20 refusals within 40 s are a busy minute');
  // the same refusals spread over minutes, as the readers' back-off spaces them: the month
  const b = makeApiCounter({ now: NOW, clock: () => t });
  const slow = b.wrap(async () => { t += 30e3; throw httpErr(429, BUSY_BODY); });
  for (let i = 0; i < CG_STREAK.n - 1; i++) await slow(CG).catch(() => {});
  assert.equal(b.isOut(), false, `${CG_STREAK.n - 1} in a row: not yet`);
  await slow(CG).catch(() => {});
  assert.equal(b.isOut(), true, `${CG_STREAK.n} in a row over ${CG_STREAK.ms / 60e3}+ min: out`);
  // an answer in between starts the count again
  const c = makeApiCounter({ now: NOW, clock: () => t });
  let n = 0;
  const mixed = c.wrap(async () => { t += 30e3; if (++n % 4 === 0) return { ok: 1 }; throw httpErr(429, BUSY_BODY); });
  for (let i = 0; i < 24; i++) await mixed(CG).catch(() => {});
  assert.equal(c.isOut(), false, 'CoinGecko kept answering now and then: a busy key, not an empty one');
  // the run carries from the pool list to the scan through the file
  const file = path.join(dir(), 'apis.json');
  const p = makeApiCounter({ file, now: NOW, clock: () => t });
  const pg = p.wrap(async () => { t += 30e3; throw httpErr(429, ''); });
  for (let i = 0; i < 3; i++) await pg(CG).catch(() => {});
  p.save();
  const s = makeApiCounter({ file, now: NOW, clock: () => t });
  const sg = s.wrap(async () => { t += 30e3; throw httpErr(429, ''); });
  for (let i = 0; i < 3; i++) await sg(CG).catch(() => {});
  assert.equal(s.isOut(), true, '3 in the pool list + 3 in the scan');
});

test('the month rolls over: the mark clears itself on the 1st (UTC), whatever the day it was set', () => {
  const seed = { day: '2026-11-20', coingecko: { used: 3, cap: 150, out: '2026-11' } };
  const nov30 = makeApiCounter({ now: Date.UTC(2026, 10, 30, 23, 59), seed });
  assert.equal(nov30.isOut(), true, 'a mark of an earlier day of the same month still holds');
  assert.equal(nov30.used(), 0, 'the day count is the day\'s own');
  const dec1 = makeApiCounter({ now: Date.UTC(2026, 11, 1, 0, 0), seed: { ...seed, day: '2026-11-30' } });
  assert.equal(dec1.isOut(), false);
  assert.equal(dec1.allow('coingecko'), true);
  assert.equal(dec1.health().coingecko.out, null);
  assert.equal(dec1.outLine(), null);
  // through the file as well
  const file = path.join(dir(), 'apis.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, day: '2026-11-30', coingecko: { used: 0, cap: 150, out: '2026-11' } }));
  assert.equal(makeApiCounter({ file, now: Date.UTC(2026, 10, 30, 12) }).isOut(), true);
  assert.equal(makeApiCounter({ file, now: Date.UTC(2026, 11, 1, 1) }).isOut(), false);
  // a broken mark is no mark
  assert.equal(makeApiCounter({ now: NOW, seed: { day: '2026-11-14', coingecko: { used: 0, out: 'soon' } } }).isOut(), false);
});

test('the universe while the quota is out: the cache up to 45 days old, never a fetch; past that (or none) unread', async () => {
  const file = path.join(dir(), 'universe.json');
  let fetches = 0;
  const fetch = async () => { fetches++; return { markets: [], list: null, unreadPages: [1, 2, 3, 4, 5, 6, 7, 8] }; };
  const write = (ageMs) => fs.writeFileSync(file, JSON.stringify({ v: 1, t: NOW - ageMs, markets: [{ id: 'one', symbol: 'one', market_cap_rank: 150 }], list: [{ id: 'one', platforms: { ethereum: '0x' + '1'.repeat(40) } }] }));
  const out = makeApiCounter({ now: NOW, seed: { day: '2026-11-01', coingecko: { used: 0, out: '2026-11' } } });
  assert.equal(out.isOut(), true);
  write(30 * DAY);
  const a = await cachedUniverse(async () => null, { file, now: NOW, fetch, apis: out });
  assert.deepEqual([a.from, a.why, Math.round(a.ageMs / DAY), fetches], ['cache', 'coingecko out', 30, 0]);
  assert.equal(a.markets.length, 1);
  write(46 * DAY);
  const b = await cachedUniverse(async () => null, { file, now: NOW, fetch, apis: out });
  assert.deepEqual([b.from, b.why, b.markets.length, b.list, fetches], ['none', 'coingecko out', 0, null, 0], 'over 45 days: unread, never guessed');
  fs.rmSync(file);
  const c = await cachedUniverse(async () => null, { file, now: NOW, fetch, apis: out });
  assert.deepEqual([c.from, c.ageMs, c.list, fetches], ['none', null, null, 0], 'no cache at all: unread');
  // not out, CoinGecko unread: a 20-day-old cache still serves (the old 7-day limit dropped the whole pool list)
  write(20 * DAY);
  const ok = makeApiCounter({ now: NOW });
  const d = await cachedUniverse(async () => null, { file, now: NOW, fetch, apis: ok });
  assert.deepEqual([d.from, d.why, fetches], ['cache', 'coingecko unread', 1]);
  assert.equal(UNIVERSE_STALE_MS, 45 * DAY);
  // the quota found during the fetch itself: the cache serves, and the pages left are not asked
  let sent = 0;
  const e = makeApiCounter({ now: NOW });
  const gj = e.wrap(async () => { sent++; throw httpErr(429, QUOTA_BODY); });
  const r = await fetchCoinGecko(gj, { spacingMs: 0, tries: 4 });
  assert.deepEqual([sent, r.markets.length, r.list, r.unreadPages.length], [1, 0, null, 8], 'one call, then nothing more is asked');
  assert.equal(e.isOut(), true);
});

// ---- the exchange fallback: each venue's shape (made-up markets) ----
const CB_ALL = { 'AAA-USD': { stats_24hour: { open: '1.9', high: '2.1', low: '1.8', last: '2', volume: '1000000' }, stats_30day: { volume: '9' } }, 'AAA-EUR': { stats_24hour: { last: '1.8', volume: '10000' } }, 'EUR-USD': { stats_24hour: { last: '1.1', volume: '5' } }, 'BAD-USD': { stats_24hour: { last: 'x', volume: '1' } } };
const KR_PAIRS = { error: [], result: { AAAUSD: { altname: 'AAAUSD', wsname: 'AAA/USD' }, XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD' }, AAAXBT: { altname: 'AAAXBT', wsname: 'AAA/XBT' } } };
const KR_TICK = { error: [], result: { AAAUSD: { c: ['2.0', '1'], v: ['100', '200000'], p: ['2.0', '2.05'] }, XXBTZUSD: { c: ['90000', '1'], v: ['1', '10'], p: ['90000', '90000'] }, AAAXBT: { c: ['0.0000222', '1'], v: ['5', '45000'], p: ['0.0000222', '0.0000222'] } } };
const OKX = { code: '0', msg: '', data: [{ instType: 'SPOT', instId: 'AAA-USDT', last: '2.01', vol24h: '50000', volCcy24h: '100500' }, { instId: 'BBB-USDT', last: '9', volCcy24h: '900' }, { instId: 'weird', last: '1', volCcy24h: '1' }] };
const GATE = [{ currency_pair: 'AAA_USDT', last: '1.99', base_volume: '1000', quote_volume: '1990' }, { currency_pair: 'CCC_USDT', last: '5', quote_volume: '50000' }];
const KUCOIN = { code: '200000', data: { time: 1, ticker: [{ symbol: 'AAA-USDT', last: '2', vol: '10', volValue: '20' }, { symbol: 'AAA-BTC', last: '0.0000222', volValue: '0.01' }, { symbol: 'BTC-USDT', last: '90000', volValue: '1e9' }] } };

test('fallback parsing: Coinbase, Kraken, OKX, Gate and KuCoin shapes; an unreadable answer is null', () => {
  const cb = parseCoinbaseStats(CB_ALL);
  assert.deepEqual(cb.find((r) => r.base === 'AAA' && r.quote === 'USD'), { base: 'AAA', quote: 'USD', last: 2, qvol: 2e6 });
  assert.equal(cb.some((r) => r.base === 'BAD'), false, 'an unreadable price is left out, never 0');
  assert.deepEqual(parseCoinbaseOne('AAA-USD', { last: '2', volume: '10' }), { base: 'AAA', quote: 'USD', last: 2, qvol: 20 });
  assert.equal(parseCoinbaseOne('AAA-USD', { message: 'NotFound' }), null);
  const prods = parseCoinbaseProducts([{ id: 'AAA-USD', base_currency: 'AAA', quote_currency: 'USD', status: 'online' }, { id: 'AAA-EUR', base_currency: 'AAA', quote_currency: 'EUR', status: 'online' }, { id: 'DED-USD', base_currency: 'DED', quote_currency: 'USD', status: 'delisted' }, { id: 'OFF-USD', base_currency: 'OFF', quote_currency: 'USD', status: 'online', trading_disabled: true }]);
  assert.deepEqual([...prods], [['AAA', ['AAA-USD']]]);
  const kr = parseKraken(KR_PAIRS, KR_TICK);
  assert.deepEqual(kr.find((r) => r.base === 'AAA' && r.quote === 'USD'), { base: 'AAA', quote: 'USD', last: 2, qvol: 200000 * 2.05 }, 'Kraken: 24 h volume × 24 h VWAP');
  assert.ok(kr.some((r) => r.base === 'BTC' && r.quote === 'USD'), "Kraken's XBT is BTC");
  assert.equal(parseKraken(KR_PAIRS, { error: ['EGeneral:Too many requests'] }), null);
  assert.deepEqual(parseOkx(OKX).map((r) => [r.base, r.quote, r.qvol]), [['AAA', 'USDT', 100500], ['BBB', 'USDT', 900]]);
  assert.equal(parseOkx({ code: '50011', msg: 'Too Many Requests', data: [] }), null);
  assert.deepEqual(parseGate(GATE).map((r) => [r.base, r.qvol]), [['AAA', 1990], ['CCC', 50000]]);
  assert.equal(parseGate({ label: 'INVALID' }), null);
  assert.equal(parseKucoin(KUCOIN).length, 3);
  assert.equal(parseKucoin({ code: '429000', msg: 'busy' }), null);
  for (const f of [parseCoinbaseStats, parseOkx, parseGate, parseKucoin]) { assert.equal(f(null), null); assert.equal(f('<html>'), null); }
  assert.equal(parseCoinbaseStats({}), null, 'no market at all: unread, not "listed nowhere"');
});

test('venueVolumes: stablecoin quotes at $1, other quotes at the venue\'s own price, an unpriced quote left out', () => {
  const v = venueVolumes(parseKraken(KR_PAIRS, KR_TICK));
  const a = v.get('AAA');
  assert.equal(a.markets, 2, 'AAA/USD and AAA/XBT');
  assert.ok(Math.abs(a.usd - (410000 + 45000 * 0.0000222 * 90000)) < 1e-6, 'the XBT market converted at the venue\'s BTC price');
  assert.equal(a.px, 2, 'the price at the biggest market');
  const cb = venueVolumes(parseCoinbaseStats(CB_ALL));
  assert.ok(Math.abs(cb.get('AAA').usd - (2e6 + 18000 * 1.1)) < 1e-6, 'EUR at the venue\'s EUR-USD');
  const lone = venueVolumes([{ base: 'AAA', quote: 'XYZ', last: 1, qvol: 1e9 }]);
  assert.equal(lone.get('AAA'), undefined, 'planted: a quote the venue cannot price is not counted as dollars');
});

// a routed fake: each venue answers its made-up markets, or is down
const venueFake = (down = {}) => {
  const asked = [];
  const fn = async (u) => {
    asked.push(u);
    const v = u.startsWith('https://api.exchange.coinbase.com/') ? 'coinbase' : u.startsWith('https://api.kraken.com') ? 'kraken' : u === VENUES.okx.tickers ? 'okx' : u === VENUES.gate.tickers ? 'gate' : u === VENUES.kucoin.tickers ? 'kucoin' : u.includes('coingecko') ? 'coingecko' : 'other';
    if (down[v]) throw httpErr(403, 'restricted');
    if (v === 'coinbase') return CB_ALL;
    if (v === 'kraken') return u === VENUES.kraken.pairs ? KR_PAIRS : KR_TICK;
    if (v === 'okx') return OKX;
    if (v === 'gate') return GATE;
    if (v === 'kucoin') return KUCOIN;
    throw httpErr(404, '');
  };
  return { fn, asked };
};
const META = new Map([['aaa-coin', { symbol: 'aaa', usd: 2 }], ['bbb-coin', { symbol: 'BBB', usd: 3 }], ['ccc-coin', { symbol: 'CCC', usd: 5 }], ['ccc-other', { symbol: 'ccc', usd: 0.1 }],
  ['ddd-coin', { symbol: 'DDD', usd: 1 }], ['eee-coin', { symbol: 'AAA2', usd: null }], ['ethereum', { symbol: 'WETH', usd: 3000 }]]);

test('exchangeVolumes: summed over the venues that list the ticker at the right price; null when unread or unknown, never 0', async () => {
  const f = venueFake();
  const r = await exchangeVolumes(f.fn, ['aaa-coin', 'bbb-coin', 'ccc-coin', 'ddd-coin', 'eee-coin'], { meta: META, budget: { ...FALLBACK_BUDGET, spacingMs: 0 } });
  const a = r.vol.get('aaa-coin');
  assert.equal(a.src, 'exchanges');
  assert.equal(a.venues, 5, 'Coinbase, Kraken, OKX, Gate and KuCoin all list AAA near $2');
  assert.ok(a.vol > 2e6 && a.cex >= 6);
  assert.equal(r.vol.get('bbb-coin'), null, 'planted: OKX prices "BBB" at $9 against $3: another coin with that ticker, not counted');
  assert.equal(r.vol.get('ccc-coin'), null, 'two coins of the lists use the ticker CCC: ambiguous, not guessed');
  assert.equal(r.vol.get('ddd-coin'), null, 'listed nowhere: null (the venues read are not every exchange), never 0');
  assert.equal(r.vol.get('eee-coin'), null, 'no market price to check against: null');
  assert.deepEqual([r.got, r.mismatched, r.ambiguous, r.unlisted, r.unpriced], [1, 1, 1, 1, 1]);
  assert.deepEqual(Object.keys(r.venues), ['coinbase', 'kraken', 'okx', 'gate', 'kucoin']);
  assert.ok(r.calls <= FALLBACK_BUDGET.calls && r.calls === 6, 'one bulk call a venue (two for Kraken)');
  // one venue down: the others still sum, with one venue fewer
  const g = venueFake({ okx: 1 });
  const r2 = await exchangeVolumes(g.fn, ['aaa-coin'], { meta: META, budget: { ...FALLBACK_BUDGET, spacingMs: 0 } });
  assert.deepEqual([r2.vol.get('aaa-coin').venues, r2.venues.okx], [4, null]);
  // every venue down: null, never 0
  const h = venueFake({ coinbase: 1, kraken: 1, okx: 1, gate: 1, kucoin: 1 });
  const r3 = await exchangeVolumes(h.fn, ['aaa-coin'], { meta: META, budget: { ...FALLBACK_BUDGET, spacingMs: 0 } });
  assert.equal(r3.vol.get('aaa-coin'), null);
  assert.match(r3.lastError, /HTTP 403/);
  // WETH's coin trades as ETH on the exchanges
  const eth = await exchangeVolumes(async (u) => (u === VENUES.okx.tickers ? { code: '0', data: [{ instId: 'ETH-USDT', last: '3010', volCcy24h: '5e8' }] } : null), ['ethereum'], { meta: META, budget: { ...FALLBACK_BUDGET, spacingMs: 0 } });
  assert.equal(eth.vol.get('ethereum').vol, 5e8);
});

test('Coinbase without the bulk stats: its product list, then the wanted products one by one', async () => {
  const asked = [];
  const fn = async (u) => {
    asked.push(u);
    if (u === VENUES.coinbase.stats) throw httpErr(404, '');
    if (u === VENUES.coinbase.products) return [{ id: 'AAA-USD', base_currency: 'AAA', quote_currency: 'USD', status: 'online' }, { id: 'ZZZ-USD', base_currency: 'ZZZ', quote_currency: 'USD', status: 'online' }];
    if (u === VENUES.coinbase.one('AAA-USD')) return { last: '2', volume: '500' };
    throw httpErr(403, '');
  };
  const r = await exchangeVolumes(fn, ['aaa-coin'], { meta: META, budget: { ...FALLBACK_BUDGET, spacingMs: 0 } });
  assert.deepEqual([r.vol.get('aaa-coin').vol, r.vol.get('aaa-coin').venues], [1000, 1]);
  assert.ok(!asked.includes(VENUES.coinbase.one('ZZZ-USD')), 'only the products of the coins wanted');
});

test('cexVolumes with the quota out: no CoinGecko call, the exchanges serve (src exchanges), cached for the fallback\'s fresh time', async () => {
  const out = makeApiCounter({ now: NOW, seed: { day: '2026-11-14', coingecko: { used: 0, out: '2026-11' } } });
  const f = venueFake();
  const gj = out.wrap(f.fn);
  const file = path.join(dir(), 'cex.json');
  const cache = makeCexCache(file, { now: NOW });
  const budget = { ...CEX_BUDGET, spacingMs: 0 };
  const r = await cexVolumes(gj, ['aaa-coin', 'ddd-coin'], { cache, now: NOW, budget, apis: out, meta: META, fallback: { ...FALLBACK_BUDGET, spacingMs: 0 } });
  assert.equal(f.asked.filter((u) => u.includes('coingecko')).length, 0, 'not one CoinGecko call');
  assert.equal(r.calls, 0);
  assert.equal(r.lastError, 'monthly quota');
  assert.deepEqual([r.vol.get('aaa-coin').src, r.vol.get('aaa-coin').venues], ['exchanges', 5]);
  assert.equal(r.vol.get('ddd-coin'), null, 'listed nowhere: null');
  assert.equal(r.fallback.got, 1);
  assert.equal(cache.calls(), 0, 'the CoinGecko tickers count (health.cex) is not spent by the fallback');
  cache.save();
  // the next pass, an hour later: served from the cache, no venue asked again
  const f2 = venueFake();
  const r2 = await cexVolumes(out.wrap(f2.fn), ['aaa-coin'], { cache: makeCexCache(file, { now: NOW + 3600e3 }), now: NOW + 3600e3, budget, apis: out, meta: META });
  assert.equal(f2.asked.length, 0);
  assert.deepEqual([r2.vol.get('aaa-coin').src, r2.fresh], ['exchanges', 1]);
  // a new loop job (no file): the seed from the last live.json keeps the source
  const seeded = makeCexCache(path.join(dir(), 'none.json'), { now: NOW + 3600e3, seed: [{ coin: 'aaa-coin', t: NOW, vol: 7, src: 'exchanges', venues: 3 }] });
  assert.deepEqual(seeded.get('aaa-coin'), { t: NOW, vol: 7, cex: null, src: 'exchanges', venues: 3 });
  // planted fault: without meta there is no fallback, and the coin stays null (never 0)
  const r3 = await cexVolumes(out.wrap(venueFake().fn), ['bbb-coin'], { cache: makeCexCache(path.join(dir(), 'c3.json'), { now: NOW }), now: NOW, budget, apis: out });
  assert.deepEqual([r3.vol.get('bbb-coin'), r3.fallback], [null, null]);
  // CoinGecko serving (not out, budget room): no fallback, CoinGecko's tickers as before
  const fine = makeApiCounter({ now: NOW });
  const cgFake = async (u) => (u.includes('coingecko') ? { tickers: [{ base: 'AAA', target: 'USDT', market: { name: 'Ex', identifier: 'ex' }, converted_volume: { usd: 1e6 } }] } : venueFake().fn(u));
  const r4 = await cexVolumes(fine.wrap(cgFake), ['aaa-coin'], { cache: makeCexCache(path.join(dir(), 'c4.json'), { now: NOW }), now: NOW, budget, apis: fine, meta: META });
  assert.deepEqual([r4.calls, r4.vol.get('aaa-coin').src, r4.vol.get('aaa-coin').usd, r4.fallback], [1, 'coingecko', 1e6, null]);
});
