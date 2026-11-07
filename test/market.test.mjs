// The top strip's market block (lib/market.mjs): the gas band against its own range, the hourly history,
// prices from DefiLlama with CoinGecko filling gaps, and null (never 0) on every failure. Made-up numbers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { quantile, gasBand, addGasSample, cleanHist, gasStats, histDays, parseFeeHistory, readGas, parseLlama, parseCoinGecko, readPrices,
  marketBlock, carryMarket, withTimeout, HOUR, DAY, GAS_MIN_BUCKETS } from '../lib/market.mjs';

const T0 = Date.UTC(2026, 10, 1, 0);
const hx = (n) => '0x' + Math.round(n).toString(16);
const G = 1e9;
// a made-up fee history: n blocks at `base` gwei, tips of `tip` gwei, next base fee `next`
const feeHist = (n, base, tip, next = base) => ({ oldestBlock: '0x1', baseFeePerGas: [...Array(n).fill(hx(base * G)), hx(next * G)], gasUsedRatio: Array(n).fill(0.5), reward: Array(n).fill([hx(tip * G)]) });
const hours = (vals, start = T0) => vals.map((g, i) => [start + i * HOUR, g, 1]);
const fakeRpc = (answers) => ({ calls: [], async call(method, params) { this.calls.push(method); const a = answers[method]; return typeof a === 'function' ? a(params) : a ?? null; } });
const llamaCur = (nowS) => ({ coins: { 'coingecko:ethereum': { price: 3000, timestamp: nowS - 60 }, 'coingecko:bitcoin': { price: 90000, timestamp: nowS - 60 }, 'coingecko:solana': { price: 150, timestamp: nowS - 60 } } });
const llamaPct = { coins: { 'coingecko:ethereum': -3.1, 'coingecko:bitcoin': 1.5, 'coingecko:solana': 0 } };
const cgJson = { ethereum: { usd: 3010, usd_24h_change: -3 }, bitcoin: { usd: 90100, usd_24h_change: 1.4 }, solana: { usd: 151, usd_24h_change: 0.2 } };
const routeJson = (over = {}) => async (url) => {
  for (const [k, v] of Object.entries(over)) if (url.includes(k)) { if (v instanceof Error) throw v; return typeof v === 'function' ? v(url) : v; }
  if (url.includes('/prices/current/')) return llamaCur(T0 / 1000);
  if (url.includes('/percentage/')) return llamaPct;
  if (url.includes('api.coingecko.com')) return cgJson;
  throw new Error('HTTP 404');
};

test('quantiles interpolate; the band follows p25 / p60 / p90 of the reference', () => {
  const s = Array.from({ length: 101 }, (_, i) => i); // 0..100
  assert.equal(quantile(s, 0.25), 25);
  assert.equal(quantile([1, 3], 0.5), 2);
  assert.equal(quantile([], 0.5), null);
  const ref = { p25: 10, p60: 20, p90: 40 };
  assert.equal(gasBand(9.99, ref), 'cheap');
  assert.equal(gasBand(10, ref), 'normal');
  assert.equal(gasBand(20, ref), 'normal');
  assert.equal(gasBand(20.01, ref), 'busy');
  assert.equal(gasBand(40, ref), 'busy');
  assert.equal(gasBand(40.01, ref), 'expensive');
  for (const g of [null, 0, -1, NaN, Infinity]) assert.equal(gasBand(g, ref), null, `gas ${g} has no band`);
  assert.equal(gasBand(15, null), null);
  assert.equal(gasBand(15, { p25: null, p60: 20, p90: 40 }), null);
});

test('the history keeps one mean per hour for 7 days; missing readings add nothing', () => {
  let h = [];
  h = addGasSample(h, T0 + 1 * 60e3, 10);
  h = addGasSample(h, T0 + 7 * 60e3, 20);  // same hour: running mean
  h = addGasSample(h, T0 + 13 * 60e3, 30);
  assert.deepEqual(h, [[T0, 20, 3]]);
  h = addGasSample(h, T0 + HOUR + 60e3, 5);
  assert.deepEqual(h, [[T0, 20, 3], [T0 + HOUR, 5, 1]]);
  for (const g of [null, 0, -3, NaN, undefined]) assert.deepEqual(addGasSample(h, T0 + HOUR + 120e3, g), h, `reading ${g} is not a sample`);
  // a pass every 6 minutes for 9 days: at most 7 days of hourly rows remain
  let long = [];
  for (let t = T0; t < T0 + 9 * DAY; t += 6 * 60e3) long = addGasSample(long, t, 10 + ((t / HOUR) % 24));
  assert.ok(long.length <= 7 * 24 && long.length >= 7 * 24 - 1, `rows ${long.length}`);
  assert.ok(long[0][0] > T0 + 9 * DAY - 7 * DAY - HOUR);
  assert.ok(long.every((r) => r[2] === 10), 'ten 6-minute passes per hour');
  assert.equal(histDays(long), 7);
  assert.equal(histDays([]), 0);
  // a long gap trims old rows even without a new reading
  assert.deepEqual(addGasSample(long, T0 + 30 * DAY, null), []);
});

test('a restored history is cleaned row by row, never trusted', () => {
  const junk = [[T0, 10, 1], [T0 + 1, 10, 1], [T0 + HOUR, 0, 1], [T0 + 2 * HOUR, NaN, 1], [T0 + 3 * HOUR, 12, 0], 'x', null, [T0 + 4 * HOUR, 14, 2], [T0, 11, 2]];
  assert.deepEqual(cleanHist(junk), [[T0, 11, 2], [T0 + 4 * HOUR, 14, 2]]);
  for (const x of [null, undefined, 'hist', { a: 1 }]) assert.deepEqual(cleanHist(x), []);
});

test('the gauge uses the hourly history when it has 12+ hours, else recent blocks, else no band', () => {
  const hist = hours(Array.from({ length: 48 }, (_, i) => 10 + (i % 10))); // 10..19 gwei
  const s = gasStats(25, hist);
  assert.equal(s.basis, 'history');
  assert.equal(s.band, 'expensive');
  assert.equal(s.p10, quantile(hist.map((r) => r[1]).sort((a, b) => a - b), 0.1));
  assert.ok(s.p10 < s.p50 && s.p50 < s.p90);
  assert.equal(s.histDays, 2);
  assert.equal(gasStats(10, hist).band, 'cheap');
  assert.equal(gasStats(14, hist).band, 'normal');
  assert.equal(gasStats(18, hist).band, 'busy');
  // short history: the fee-history blocks are the reference
  const short = hours([10, 11, 12]);
  const blocks = Array.from({ length: 200 }, (_, i) => 1 + (i % 4)); // 1..4 gwei
  const sb = gasStats(5, short, blocks);
  assert.equal(sb.basis, 'blocks');
  assert.equal(sb.band, 'expensive');
  assert.equal(sb.histDays, 0.1);
  // nothing to compare with: readings stay, band and percentiles are null (not 0)
  const none = gasStats(5, short, blocks.slice(0, 10));
  assert.deepEqual([none.gwei, none.p10, none.p50, none.p90, none.band, none.basis], [5, null, null, null, null, null]);
  assert.equal(GAS_MIN_BUCKETS, 12);
  // no reading: no band, even with a full history
  const blank = gasStats(null, hist);
  assert.equal(blank.gwei, null);
  assert.equal(blank.band, null);
});

test('fee history: next base fee plus the median recent tip; junk is null', () => {
  const r = parseFeeHistory(feeHist(300, 8, 1, 9));
  assert.equal(r.gwei, 10);
  assert.equal(r.blocks.length, 300);
  assert.equal(r.blocks[0], 9);
  assert.equal(parseFeeHistory(null), null);
  assert.equal(parseFeeHistory({ baseFeePerGas: ['0x1'] }), null);
  assert.equal(parseFeeHistory({ ...feeHist(5, 8, 1), reward: [] }), null, 'no tips: unread, not a zero tip');
  assert.equal(parseFeeHistory({ ...feeHist(5, 8, 1), baseFeePerGas: ['0x1', 'bad', '0x1', '0x1', '0x1', '0x1'] }), null);
  assert.equal(parseFeeHistory(feeHist(5, 0, 0, 0)), null, 'a zero gas price is junk');
});

test('readGas: fee history first, then the pass\'s eth_gasPrice, then null', async () => {
  const a = await readGas(fakeRpc({ eth_feeHistory: feeHist(1024, 5, 0.5) }));
  assert.deepEqual([a.gwei, a.source, a.blocks.length], [5.5, 'feeHistory', 1024]);
  const capped = fakeRpc({ eth_feeHistory: (p) => (p[0] === '0x400' ? null : feeHist(100, 5, 0.5)) });
  assert.equal((await readGas(capped)).blocks.length, 100, 'a node that caps the span answers the short read');
  const b = await readGas(fakeRpc({}), { gasPriceWei: hx(7 * G) });
  assert.deepEqual([b.gwei, b.source, b.blocks], [7, 'gasPrice', null]);
  const c = await readGas(fakeRpc({ eth_gasPrice: hx(3 * G) }));
  assert.equal(c.gwei, 3);
  assert.equal(await readGas(fakeRpc({})), null);
  const hang = { call: () => new Promise(() => {}) };
  const t = Date.now();
  assert.equal(await readGas(hang, { timeoutMs: 50 }), null, 'a hung node is null after the time limit');
  assert.ok(Date.now() - t < 1000);
});

test('prices: DefiLlama first, CoinGecko fills gaps, percentages become fractions', async () => {
  const r = await readPrices(routeJson(), { nowS: T0 / 1000 });
  assert.deepEqual(r.px.ETH, { usd: 3000, ch24: -0.031, src: 'defillama' });
  assert.deepEqual(r.px.SOL, { usd: 150, ch24: 0, src: 'defillama' }, 'a real 0% move stays 0');
  assert.deepEqual([r.read, r.both, r.agree], [3, 3, 3]);
  // DefiLlama down: CoinGecko answers alone
  const g = await readPrices(routeJson({ 'coins.llama.fi': new Error('HTTP 502') }), { nowS: T0 / 1000 });
  assert.deepEqual(g.px.BTC, { usd: 90100, ch24: 0.014, src: 'coingecko' });
  // a stale DefiLlama price is dropped in favour of CoinGecko
  const stale = await readPrices(routeJson({ '/prices/current/': { coins: { 'coingecko:ethereum': { price: 2000, timestamp: T0 / 1000 - 6 * 3600 } } } }), { nowS: T0 / 1000 });
  assert.equal(stale.px.ETH.usd, 3010);
  assert.equal(stale.px.ETH.src, 'coingecko');
  // the key travels in a header only
  const seen = [];
  await readPrices(async (url, init) => { seen.push({ url, key: init?.headers?.['x-cg-demo-api-key'] }); return {}; }, { key: 'made-up-key' });
  assert.ok(seen.find((s) => s.url.includes('coingecko.com')).key === 'made-up-key' && seen.every((s) => !s.url.includes('made-up-key')));
  assert.ok(seen.filter((s) => s.url.includes('llama')).every((s) => s.key === undefined), 'the CoinGecko key never goes to DefiLlama');
});

test('price junk is null, never a number', () => {
  const ll = parseLlama({ coins: { 'coingecko:ethereum': { price: 0 }, 'coingecko:bitcoin': { price: '90000' }, 'coingecko:solana': { price: -1 } } }, { coins: { 'coingecko:ethereum': 'x', 'coingecko:bitcoin': -150 } });
  for (const s of ['ETH', 'BTC', 'SOL']) assert.deepEqual(ll[s], { usd: null, ch24: null });
  const cg = parseCoinGecko({ ethereum: { usd: null, usd_24h_change: NaN } });
  assert.deepEqual(cg.ETH, { usd: null, ch24: null });
  assert.deepEqual(parseCoinGecko(null).SOL, { usd: null, ch24: null });
});

test('planted fault: a broken fetch gives null, not 0, and the pass goes on', async () => {
  const broken = async () => { throw new Error('HTTP 500'); };
  const zeroes = async () => ({ coins: { 'coingecko:ethereum': { price: 0 } }, ethereum: { usd: 0, usd_24h_change: 0 } });
  for (const getJson of [broken, zeroes, async () => null, async () => 'html']) {
    const r = await readPrices(getJson);
    for (const s of ['ETH', 'BTC', 'SOL']) {
      assert.equal(r.px[s].usd, null, `${s} usd`);
      assert.equal(r.px[s].ch24, null, `${s} ch24`);
    }
    assert.equal(r.read, 0);
  }
  // the whole block: gas node down, prices down, no history → nulls, never 0, never a throw
  const { market } = await marketBlock({ rpc: fakeRpc({}), getJson: broken, prev: null, now: T0 });
  assert.equal(market.t, T0);
  assert.deepEqual([market.gas.gwei, market.gas.p10, market.gas.p50, market.gas.p90, market.gas.band], [null, null, null, null, null]);
  assert.equal(market.gas.histDays, 0);
  assert.ok(Object.values(market.px).every((x) => x.usd === null && x.ch24 === null));
  // the planted fault must fail the old behaviour: a fetch defaulting to 0 would show here
  const json = JSON.stringify(market);
  assert.ok(!/"(usd|ch24|gwei|p10|p50|p90)":0[,}]/.test(json), 'no zero stands in for a missing value');
  // a hung source is cut at the time limit
  const t = Date.now();
  const hung = await marketBlock({ rpc: { call: () => new Promise(() => {}) }, getJson: () => new Promise(() => {}), now: T0, timeoutMs: 50 });
  assert.ok(Date.now() - t < 3000);
  assert.equal(hung.market.gas.gwei, null);
  assert.equal(hung.market.px.ETH.usd, null);
  assert.equal(await withTimeout(Promise.reject(new Error('x')), 50, 'fb'), 'fb');
});

test('the history rides between passes in market.gas.hist and survives a pass that reads nothing', async () => {
  const getJson = routeJson();
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const rpc = fakeRpc({ eth_feeHistory: feeHist(400, 10 + (i % 5), 1) });
    prev = (await marketBlock({ rpc, getJson, prev, now: T0 + i * HOUR })).market;
  }
  assert.equal(prev.gas.hist.length, 30);
  assert.equal(prev.gas.basis, 'history');
  assert.ok(['cheap', 'normal', 'busy', 'expensive'].includes(prev.gas.band));
  assert.ok(prev.gas.histDays > 1.2);
  const dead = (await marketBlock({ rpc: fakeRpc({}), getJson: async () => { throw new Error('x'); }, prev, now: T0 + 30 * HOUR })).market;
  assert.equal(dead.gas.gwei, null);
  assert.equal(dead.gas.hist.length, 30, 'kept for the next pass');
  assert.equal(dead.gas.band, null);
  assert.ok(dead.gas.p50 != null, 'the range is still known');
  const carried = carryMarket(prev, T0 + 31 * HOUR);
  assert.equal(carried.gas.hist.length, 30);
  assert.equal(carried.px.BTC.usd, null);
  assert.deepEqual(carryMarket(null, T0).gas.hist, []);
});
