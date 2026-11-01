// Price history for the volatility cross-check: CoinGecko by contract with a once-a-day cache,
// sampling at the pool's own moments, and the planted faults each must catch. Made-up prices only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMarketChart, makeHistoryCache, coinGeckoHistory, sampleAt, ratioAt, parseChart } from '../lib/history.mjs';
import { dailySigma } from '../lib/flow.mjs';

const A = (c) => 'ethereum:0x' + c.repeat(40);
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'cache', 'history.json');
const NOW = Date.UTC(2026, 10, 1, 12);
const hourly = (usd, wiggle = 0.02, now = NOW) => ({ prices: Array.from({ length: 721 }, (_, i) => { const t = now - (720 - i) * 3600e3; return [t, usd * Math.exp(wiggle * Math.sin(t / 86400e3 * 2.1))]; }) });

test('market chart parses to seconds, ascending; junk is null, never a flat line', () => {
  const p = parseMarketChart({ prices: [[2000e3, 2], [1000e3, 1], [1500e3, 0], [null, 3]] });
  assert.deepEqual(p, [{ t: 1000, price: 1 }, { t: 2000, price: 2 }]);
  assert.equal(parseMarketChart({ error: 'coin not found' }), null);
  assert.equal(parseMarketChart({ prices: [] }), null);
  assert.equal(parseChart({ coins: { 'ETHEREUM:0xAB': { prices: [{ timestamp: 5, price: 1 }] } } }).has('ethereum:0xab'), true);
});

test('each token is fetched at most once a UTC day; the cache file survives between passes', async () => {
  const file = tmp();
  const seen = [];
  const getJson = async (url, init) => { seen.push({ url, key: init?.headers?.['x-cg-demo-api-key'] }); if (url.includes('dead')) throw new Error('HTTP 404'); return hourly(2); };
  const keys = [A('1'), A('2'), 'ethereum:0x' + 'dead'.repeat(10)];
  const c1 = makeHistoryCache(file, { now: NOW });
  const r1 = await coinGeckoHistory(getJson, keys, { key: 'made-up-key', cache: c1, spacingMs: 0 });
  c1.save();
  assert.deepEqual([r1.fetched, r1.cached, r1.unread.length, seen.length], [2, 0, 1, 3]); // a 404 is not retried
  assert.ok(seen.every((s) => s.key === 'made-up-key' && !s.url.includes('made-up-key'))); // the key travels in a header only
  assert.ok(!fs.readFileSync(file, 'utf8').includes('made-up-key'));
  const c2 = makeHistoryCache(file, { now: NOW + 3600e3 }); // later the same day: no calls at all
  const r2 = await coinGeckoHistory(getJson, keys, { cache: c2, spacingMs: 0 });
  assert.deepEqual([r2.fetched, r2.cached, r2.unread.length, seen.length], [0, 2, 1, 3]);
  const c3 = makeHistoryCache(file, { now: NOW + 86400e3 }); // the next day: fetched again
  const r3 = await coinGeckoHistory(getJson, keys, { cache: c3, spacingMs: 0 });
  assert.equal(r3.fetched, 2);
  fs.writeFileSync(file, '{broken');
  assert.equal(makeHistoryCache(file).size(), 0); // a broken cache is an empty one
});

test('an unanswered token is unread, not a series; unread never becomes a price', async () => {
  const r = await coinGeckoHistory(async () => { throw new Error('HTTP 429'); }, [A('3')], { spacingMs: 0, tries: 2 });
  assert.deepEqual([r.series.size, r.unread.length, r.lastError], [0, 1, 'HTTP 429']);
});

test('sampling at the pool moments: nearest point within tolerance, gaps left out', () => {
  const pts = parseMarketChart(hourly(10, 0));
  const t0 = NOW / 1000;
  const s = sampleAt(pts, [t0, t0 - 86400 + 1200, t0 + 5 * 86400]);
  assert.equal(s.length, 2); // the moment after the series ends has no point near it
  assert.equal(s[1].t, t0 - 86400 + 1200);
  const daily = pts.filter((_, i) => i % 24 === 0);
  assert.equal(sampleAt(daily, [t0 - 3 * 3600]).length, 1); // a daily series takes a wider window
});

test('the cross-check reads like with like: the same moments agree, moments half a day off do not', () => {
  // made-up hourly series with daily moves; the pool's own price is the ratio at its sample moments
  let x = 1, y = 1;
  const a = [], b = [];
  for (let i = 0; i <= 720; i++) { const t = NOW / 1000 - (720 - i) * 3600; x *= Math.exp(0.004 * Math.sin(i * 1.7)); y *= Math.exp(0.002 * Math.cos(i * 0.9)); a.push({ t, price: 3 * x }); b.push({ t, price: 2000 * y }); }
  const times = Array.from({ length: 31 }, (_, k) => NOW / 1000 - k * 86400 - 777);
  const truth = ratioAt(a, b, times);
  const pool = truth.map((p) => ({ t: p.t, price: p.price * 1e-12 })); // raw units: a constant factor
  const sm = dailySigma(ratioAt(a, b, pool.map((p) => p.t))), sp = dailySigma(pool);
  assert.ok(Math.abs(sm / sp - 1) < 1e-9);
  // planted fault: the market read a day apart from the pool's moments breaks the agreement
  const shifted = dailySigma(ratioAt(a, b, pool.map((p) => p.t - 86400 * 0.5)));
  assert.ok(Math.abs(shifted / sp - 1) > 1e-3);
  assert.deepEqual(ratioAt(a, [], times), []);
});
