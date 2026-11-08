// The exchange-led screen (lib/cex.mjs) on made-up tickers (MOCKUP · MADE-UP NUMBERS): DEX tickers and flagged
// ones left out, missing tickers give null (never 0), the per-pass and per-day call budget, the hourly cache and
// the seed from the last live.json; the cexled lens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTickers, makeCexCache, cexVolumes, cexScreen, HOUR } from '../lib/cex.mjs';
import { lensCexLed, lensRetail } from '../lib/lenses.mjs';

const tick = (base, target, id, usd, extra = {}) => ({ base, target, market: { name: id, identifier: id }, converted_volume: { usd }, ...extra });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lps-cex-')), 'cex.json');

test('parseTickers: centralised volume only; DEX pairs (named by contract) and flagged tickers left out', () => {
  const j = { tickers: [tick('ONE', 'USDT', 'binance', 1e6), tick('ONE', 'BTC', 'okex', 5e5), tick('0X' + '1'.repeat(40), '0X' + '2'.repeat(40), 'uniswap_v3', 9e6),
    tick('ONE', 'USDC', 'aerodrome-slipstream', 3e6), tick('ONE', 'EUR', 'kraken', 2e5, { is_anomaly: true }), tick('ONE', 'GBP', 'bitstamp', 1e5, { is_stale: true })] };
  assert.deepEqual(parseTickers(j), { vol: 1.5e6, cex: 2, dex: 2, skipped: 2 });
  assert.deepEqual(parseTickers({ tickers: [] }), { vol: 0, cex: 0, dex: 0, skipped: 0 }, 'a coin with no markets: a real 0');
  assert.equal(parseTickers({ error: 'coin not found' }), null);
  assert.equal(parseTickers(null), null);
  // planted fault: counting DEX tickers would add the pool's own volume to the "exchange" side
  const faulty = (x) => x.tickers.reduce((s, t) => s + (t.converted_volume?.usd ?? 0), 0);
  assert.notEqual(faulty(j), parseTickers(j).vol);
});

test('cexScreen: the ratio and tier vs σ; any missing input → null', () => {
  const s = cexScreen({ cexVol24: 5e6, in9Usd: 2.5e5, feeTier: 0.003, sigmaDay: 0.03, blocksPerDay: 7200, t: 1 });
  assert.equal(s.cexRatio, 20);
  assert.ok(Math.abs(s.tierVsSigma - 0.003 / (0.03 / Math.sqrt(7200))) < 1e-12);
  assert.equal(cexScreen({ cexVol24: null, in9Usd: 2.5e5, feeTier: 0.003, sigmaDay: 0.03, blocksPerDay: 7200 }).cexRatio, null, 'missing tickers: null');
  assert.equal(cexScreen({ cexVol24: 5e6, in9Usd: 0, feeTier: 0.003 }).cexRatio, null, 'nothing within ±9%: no ratio');
  assert.equal(cexScreen({ cexVol24: 5e6, in9Usd: 1e5, feeTier: 0.003, sigmaDay: null, blocksPerDay: 7200 }).tierVsSigma, null);
  assert.equal(cexScreen({ cexVol24: 0, in9Usd: 1e5 }).cexRatio, 0, 'no exchange volume: a real 0');
  // Base's 0.2 s blocks: the same daily σ is a smaller step a block
  assert.ok(cexScreen({ feeTier: 0.003, sigmaDay: 0.03, blocksPerDay: 432000 }).tierVsSigma > cexScreen({ feeTier: 0.003, sigmaDay: 0.03, blocksPerDay: 7200 }).tierVsSigma);
});

test('cexVolumes: stalest first within the pass and day budgets; fresh cache hits cost nothing; 404 → null', async () => {
  const file = tmp(), now = Date.UTC(2026, 10, 8, 12), asked = [];
  const getJson = async (url) => {
    const c = url.split('/coins/')[1].split('/')[0];
    asked.push(c);
    if (c === 'gone') throw new Error('HTTP 404');
    return { tickers: [tick(c.toUpperCase(), 'USDT', 'binance', c.length * 1e5)] };
  };
  const seed = [{ coin: 'old', t: now - 30 * HOUR, vol: 7e5 }, { coin: 'warm', t: now - 0.5 * HOUR, vol: 4e5 }, { coin: 'aged', t: now - 50 * HOUR, vol: 1 }];
  const cache = makeCexCache(file, { now, seed });
  const budget = { perPass: 3, perDay: 120, freshMs: HOUR, maxAgeMs: 48 * HOUR, spacingMs: 0 };
  const r = await cexVolumes(getJson, ['warm', 'old', 'gone', 'new1', 'new2', 'aged'], { cache, now, budget });
  assert.equal(r.calls, 3);
  assert.ok(!asked.includes('warm'), 'fresh within the hour: not fetched');
  assert.equal(r.vol.get('warm').usd, 4e5);
  // the never-fetched and the oldest go first; the rest are used from the cache while under 48 h old, else null
  assert.ok(asked.includes('gone') || asked.includes('new1') || asked.includes('new2'));
  assert.equal(r.vol.get('gone'), null, 'a coin CoinGecko does not know: null, never 0');
  assert.equal(r.vol.get('aged') === null || r.vol.get('aged').t === now, true, 'over 48 h old and not refetched: null');
  assert.ok(r.vol.get('old') === null || r.vol.get('old').usd > 0);
  // the day's budget: calls counted across passes (and from the last live.json)
  const c2 = makeCexCache(file, { now, budget: { day: new Date(now).toISOString().slice(0, 10), calls: 119 } });
  const r2 = await cexVolumes(getJson, ['x1', 'x2', 'x3'], { cache: c2, now, budget });
  assert.equal(r2.calls, 1, 'one call left today');
  const c3 = makeCexCache(file, { now: now + 86400e3, budget: { day: '2026-11-08', calls: 120 } });
  assert.equal(c3.calls(), 0, 'a new UTC day starts at 0');
  cache.save();
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).entries.warm);
});

test('the cexled and retail lenses', () => {
  assert.equal(lensCexLed({ cexRatio: 20, tierVsSigma: 2.5 }).on, true);
  assert.equal(lensCexLed({ cexRatio: 20, tierVsSigma: 1.5 }).on, false, 'the tier is not wide against a block');
  assert.equal(lensCexLed({ cexRatio: 5, tierVsSigma: 5 }).on, false, 'the exchange volume is not high');
  assert.equal(lensCexLed({ cexRatio: null, tierVsSigma: 5 }), null);
  assert.equal(lensRetail({ share: 0.7 }).on, true, 'high');
  assert.equal(lensRetail({ share: 0.45, longer: 0.3 }).on, true, 'rising');
  assert.equal(lensRetail({ share: 0.45, longer: 0.4 }).on, false);
  assert.equal(lensRetail({ share: null }), null);
});
