// The exchange-led screen (pool.cex): how much a pool's token trades on centralised exchanges against the
// liquidity at its price, and how its fee tier compares with one block's price move.
//   cexVol24     USD volume of the pool's base token over 24 h on centralised exchanges: CoinGecko
//                /coins/{id}/tickers (page 1, by volume: the 100 biggest markets), without DEX tickers
//                (by default CoinGecko names a DEX pair's tokens by contract address) and without tickers
//                it flags as anomalous or stale.
//   cexRatio     cexVol24 ÷ the pool's USD value within ±9% of its price.
//   tierVsSigma  fee tier ÷ the per-block σ (daily σ ÷ √blocks a day): ≥ 2 means a typical block's move
//                stays well inside the fee, so the pool is repriced by arbitrage against the exchanges in
//                fewer, larger steps.
// The Demo key allows about 30 calls a minute and 10,000 a month (shared with the price history), so a
// coin is fetched at most once an hour, at most `perPass` coins a pass and `perDay` a UTC day (the count
// travels in live.json), stalest first; a value is used up to `maxAgeMs` old and carries its own time.
// Missing is never zero: a coin nobody answered is null, a pool without in-range value is null.
import fs from 'node:fs';
import path from 'node:path';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const category = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || 'error';
const ADDR = /^0x[0-9a-f]{40}$/i;
const DEX_MARKET = /uniswap|pancake|sushi|curve|balancer|aerodrome|velodrome|raydium|orca|meteora|camelot|trader.?joe|quickswap|kyber|maverick|fluid|ekubo|thena|baseswap|dodo|1inch|paraswap|0x|cow/i;
export const HOUR = 3600e3;

// ms: the pass's time cap for these calls (coins not reached keep their cached value, or stay unread)
export const CEX_BUDGET = Object.freeze({ perPass: 8, perDay: 120, freshMs: HOUR, maxAgeMs: 48 * HOUR, spacingMs: 2200, ms: 40e3, timeoutMs: 15000 });

// One tickers answer → { vol, cex, dex, skipped } (vol: Σ USD over the centralised tickers); null when the
// answer has no ticker list. A list with no centralised market is a real 0.
export function parseTickers(json) {
  if (!Array.isArray(json?.tickers)) return null;
  let vol = 0, cex = 0, dex = 0, skipped = 0;
  for (const t of json.tickers) {
    if (!t || typeof t !== 'object') { skipped++; continue; }
    const isDex = ADDR.test(String(t.base || '')) || ADDR.test(String(t.target || '')) || DEX_MARKET.test(String(t.market?.identifier || '')) || DEX_MARKET.test(String(t.market?.name || ''));
    if (isDex) { dex++; continue; }
    const v = t.converted_volume?.usd;
    if (t.is_anomaly || t.is_stale || !isNum(v) || v < 0) { skipped++; continue; }
    vol += v; cex++;
  }
  return { vol, cex, dex, skipped };
}

// The cache: { v: 1, day, calls, entries: { coinId: { t, vol, cex } } }. seed: [{ coin, t, vol }] from the
// last live.json, so a new loop job starts where the last one stopped. A broken file is an empty cache.
export function makeCexCache(file, { now = Date.now(), seed = [], budget = null } = {}) {
  let data = { v: 1, day: null, calls: 0, entries: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && j.entries && typeof j.entries === 'object') data = { ...data, ...j }; } catch { /* empty cache */ }
  for (const s of seed || []) {
    if (!s?.coin || !isNum(s.t) || !isNum(s.vol)) continue;
    const e = data.entries[s.coin];
    if (!e || !(e.t >= s.t)) data.entries[s.coin] = { t: s.t, vol: s.vol, cex: s.cex ?? null };
  }
  // today's calls: the larger count of the file's and the last live.json's (a new loop job has no file)
  const today = new Date(now).toISOString().slice(0, 10);
  const fileCalls = data.day === today && isNum(data.calls) ? data.calls : 0, liveCalls = budget?.day === today && isNum(budget.calls) ? budget.calls : 0;
  data = { ...data, day: today, calls: Math.max(fileCalls, liveCalls) };
  return {
    today,
    get: (coin) => data.entries[coin] ?? null,
    put(coin, e) { data.entries[coin] = { t: now, vol: e.vol, cex: e.cex }; },
    spend() { data.calls++; },
    calls: () => data.calls,
    save() {
      for (const [k, e] of Object.entries(data.entries)) if (!(now - e.t < CEX_BUDGET.maxAgeMs)) delete data.entries[k];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
  };
}

// coins: CoinGecko ids. Returns { vol: Map(coin → { usd, t, cex } | null), fetched, fresh, stale, unread, calls, lastError }.
export async function cexVolumes(getJson, coins, { key = null, cache, now = Date.now(), budget = CEX_BUDGET } = {}) {
  const out = new Map(), headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  let fetched = 0, fresh = 0, stale = 0, unread = 0, calls = 0, lastError = null;
  const want = [...new Set(coins.filter((c) => typeof c === 'string' && /^[a-z0-9-]{1,80}$/.test(c)))];
  const age = (c) => { const e = cache.get(c); return e ? now - e.t : Infinity; };
  const order = want.filter((c) => !(age(c) < budget.freshMs)).sort((a, b) => age(b) - age(a));
  const room = Math.max(0, Math.min(budget.perPass, budget.perDay - cache.calls()));
  const t0 = Date.now(), timeLeft = () => (isNum(budget.ms) ? budget.ms - (Date.now() - t0) : Infinity);
  for (const c of order.slice(0, room)) {
    if (timeLeft() <= 0) break; // the time cap: the rest keep their cached value (or stay unread)
    calls++; cache.spend();
    try {
      const r = parseTickers(await getJson(`https://api.coingecko.com/api/v3/coins/${c}/tickers?order=volume_desc&depth=false&page=1`, { headers }, Math.max(1000, Math.min(budget.timeoutMs ?? 25000, timeLeft()))));
      if (r) { cache.put(c, r); fetched++; } else lastError = 'no tickers';
    } catch (e) { lastError = category(e); }
    if (timeLeft() > 0) await pause(Math.min(budget.spacingMs, timeLeft()));
  }
  for (const c of want) {
    const e = cache.get(c), a = age(c);
    if (e && a < budget.maxAgeMs && isNum(e.vol)) { out.set(c, { usd: e.vol, t: e.t, cex: e.cex ?? null }); if (a < budget.freshMs) fresh++; else stale++; } else { out.set(c, null); unread++; }
  }
  return { vol: out, fetched, fresh, stale, unread, calls, lastError };
}

// One pool's screen. cexVol24: USD or null; in9Usd: value within ±9%; feeTier: fraction; sigmaDay: daily σ;
// blocksPerDay: the chain's. Every field is null when an input is missing.
export function cexScreen({ cexVol24 = null, in9Usd = null, feeTier = null, sigmaDay = null, blocksPerDay = null, t = null } = {}) {
  const vol = isNum(cexVol24) && cexVol24 >= 0 ? cexVol24 : null;
  const cexRatio = vol != null && isNum(in9Usd) && in9Usd > 0 ? vol / in9Usd : null;
  const perBlock = isNum(sigmaDay) && sigmaDay > 0 && isNum(blocksPerDay) && blocksPerDay > 0 ? sigmaDay / Math.sqrt(blocksPerDay) : null;
  const tierVsSigma = perBlock != null && isNum(feeTier) && feeTier > 0 ? feeTier / perBlock : null;
  return { cexVol24: vol, cexRatio, tierVsSigma, t: vol != null && isNum(t) ? t : null };
}
