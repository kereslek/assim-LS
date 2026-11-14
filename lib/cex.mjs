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
// The Demo key allows about 30 calls a minute and 10,000 a month (shared with every CoinGecko reader, under the
// daily budget of lib/apicount.mjs), so only the `topN` coins the caller lists first are screened, each fetched
// at most once in 24 hours, at most `perPass` coins a pass and `perDay` a UTC day (the count travels in
// live.json), stalest first; a value is used up to `maxAgeMs` old and carries its own time. A coin past the
// top N, or one the budget leaves unread, is null.
// Missing is never zero: a coin nobody answered is null, a pool without in-range value is null.
// The fallback (exchangeVolumes) while CoinGecko can't answer (its monthly quota out, or the day's budget spent):
// the same 24 h centralised volume summed from free, keyless public exchange APIs that answer from GitHub's US
// runners (Binance and Bybit refuse US addresses and are not asked), in one or two bulk calls a venue. A coin is
// matched by its ticker symbol only where that is unambiguous (no other coin of the pool lists has it) and each
// venue's price for it agrees with the token's market price within 10%; it carries src 'exchanges' and venues (how
// many venues it was summed over). The fallback covers fewer exchanges than CoinGecko's tickers, so its volume, and
// the cexRatio from it, is a lower bound. A coin no venue lists, or every venue disagrees on, is null, never 0.
import fs from 'node:fs';
import path from 'node:path';
import { makeBudget, capGetJson } from './budget.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const category = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || 'error';
const ADDR = /^0x[0-9a-f]{40}$/i;
const DEX_MARKET = /uniswap|pancake|sushi|curve|balancer|aerodrome|velodrome|raydium|orca|meteora|camelot|trader.?joe|quickswap|kyber|maverick|fluid|ekubo|thena|baseswap|dodo|1inch|paraswap|0x|cow/i;
export const HOUR = 3600e3;

// ms: the pass's time cap for these calls (coins not reached keep their cached value, or stay unread)
export const CEX_BUDGET = Object.freeze({ topN: 15, perPass: 8, perDay: 30, freshMs: 24 * HOUR, maxAgeMs: 48 * HOUR, spacingMs: 2200, ms: 40e3, timeoutMs: 15000, reserve: 12 });

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

// The cache: { v: 1, day, calls, entries: { coinId: { t, vol, cex, src?, venues? } } } (src 'exchanges' for the
// fallback's values; none for CoinGecko's). seed: [{ coin, t, vol, src?, venues? }] from the last live.json, so a
// new loop job starts where the last one stopped. A broken file is an empty cache.
const srcOf = (e) => (e?.src === 'exchanges' ? { src: 'exchanges', venues: isNum(e.venues) ? e.venues : null } : {});
export function makeCexCache(file, { now = Date.now(), seed = [], budget = null } = {}) {
  let data = { v: 1, day: null, calls: 0, entries: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && j.entries && typeof j.entries === 'object') data = { ...data, ...j }; } catch { /* empty cache */ }
  for (const s of seed || []) {
    if (!s?.coin || !isNum(s.t) || !isNum(s.vol)) continue;
    const e = data.entries[s.coin];
    if (!e || !(e.t >= s.t)) data.entries[s.coin] = { t: s.t, vol: s.vol, cex: s.cex ?? null, ...srcOf(s) };
  }
  // today's calls: the larger count of the file's and the last live.json's (a new loop job has no file)
  const today = new Date(now).toISOString().slice(0, 10);
  const fileCalls = data.day === today && isNum(data.calls) ? data.calls : 0, liveCalls = budget?.day === today && isNum(budget.calls) ? budget.calls : 0;
  data = { ...data, day: today, calls: Math.max(fileCalls, liveCalls) };
  return {
    today,
    get: (coin) => data.entries[coin] ?? null,
    put(coin, e) { data.entries[coin] = { t: now, vol: e.vol, cex: e.cex, ...srcOf(e) }; },
    spend() { data.calls++; },
    calls: () => data.calls,
    save() {
      for (const [k, e] of Object.entries(data.entries)) if (!(now - e.t < CEX_BUDGET.maxAgeMs)) delete data.entries[k];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
  };
}

// coins: CoinGecko ids, most important first (only the first budget.topN are screened). apis (lib/apicount.mjs):
// the daily CoinGecko budget, leaving budget.reserve calls for the pool list and the market strip.
// meta: Map(coin → { symbol, usd }) for the fallback: when CoinGecko can't answer this pass (the month's quota out,
// the day's budget spent, or every call this pass refused), the wanted coins without a value fresher than
// fallback.freshMs are read from the exchanges (exchangeVolumes) instead; without meta there is no fallback.
// Returns { vol: Map(coin → { usd, t, cex, src, venues } | null), fetched, fresh, stale, unread, calls, lastError,
// fallback: exchangeVolumes' counts | null }. src: 'coingecko' | 'exchanges'; venues: null for CoinGecko's.
export async function cexVolumes(getJson, coins, { key = null, cache, now = Date.now(), budget = CEX_BUDGET, apis = null, meta = null, fallback = FALLBACK_BUDGET } = {}) {
  const out = new Map(), headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  let fetched = 0, fresh = 0, stale = 0, unread = 0, calls = 0, lastError = null;
  const valid = [...new Set(coins.filter((c) => typeof c === 'string' && /^[a-z0-9-]{1,80}$/.test(c)))];
  const want = valid.slice(0, budget.topN ?? Infinity);
  const age = (c) => { const e = cache.get(c); return e ? now - e.t : Infinity; };
  const order = want.filter((c) => !(age(c) < budget.freshMs)).sort((a, b) => age(b) - age(a));
  const room = Math.max(0, Math.min(budget.perPass, budget.perDay - cache.calls()));
  const t0 = Date.now(), timeLeft = () => (isNum(budget.ms) ? budget.ms - (Date.now() - t0) : Infinity);
  for (const c of order.slice(0, room)) {
    if (timeLeft() <= 0) break; // the time cap: the rest keep their cached value (or stay unread)
    if (apis && !apis.allow('coingecko', { reserve: budget.reserve ?? 0 })) { lastError = apis.isOut?.() ? 'monthly quota' : 'daily budget'; break; }
    calls++; cache.spend();
    try {
      const r = parseTickers(await getJson(`https://api.coingecko.com/api/v3/coins/${c}/tickers?order=volume_desc&depth=false&page=1`, { headers }, Math.max(1000, Math.min(budget.timeoutMs ?? 25000, timeLeft()))));
      if (r) { cache.put(c, r); fetched++; } else lastError = 'no tickers';
    } catch (e) { lastError = category(e); }
    if (timeLeft() > 0) await pause(Math.min(budget.spacingMs, timeLeft()));
  }
  // the fallback: CoinGecko can't answer this pass → the exchanges, for the wanted coins without a fresh value
  const cgDown = (apis && (apis.isOut?.() || !apis.allow('coingecko', { reserve: budget.reserve ?? 0 }))) || (calls > 0 && fetched === 0);
  let fb = null;
  if (meta && cgDown) {
    // a CoinGecko value stays while under its own fresh time (24 h); the fallback's is read again after its own (6 h)
    const need = want.filter((c) => !(age(c) < (cache.get(c)?.src === 'exchanges' ? fallback.freshMs : budget.freshMs)));
    if (need.length) {
      const r = await exchangeVolumes(getJson, need, { meta, budget: fallback });
      for (const [c, e] of r.vol) if (e) cache.put(c, e);
      fb = { ...r, vol: undefined };
    } else fb = { asked: 0, got: 0, calls: 0, venues: {} };
  }
  for (const c of valid.slice(want.length)) { out.set(c, null); unread++; } // past the top N: not screened
  for (const c of want) {
    const e = cache.get(c), a = age(c);
    if (e && a < budget.maxAgeMs && isNum(e.vol)) {
      out.set(c, { usd: e.vol, t: e.t, cex: e.cex ?? null, src: e.src === 'exchanges' ? 'exchanges' : 'coingecko', venues: e.src === 'exchanges' ? e.venues ?? null : null });
      if (a < budget.freshMs) fresh++; else stale++;
    } else { out.set(c, null); unread++; }
  }
  return { vol: out, fetched, fresh, stale, unread, calls, lastError, fallback: fb };
}

// ---- the exchange fallback ----
// ms / calls: the whole fallback's time and call cap (lib/budget.mjs); freshMs: a coin's fallback value is read again
// after this long; priceTol: a venue's price for the coin must agree with the token's market price within this.
export const FALLBACK_BUDGET = Object.freeze({ freshMs: 6 * HOUR, ms: 45e3, calls: 40, timeoutMs: 15000, priceTol: 0.1, spacingMs: 250 });
export const VENUES = Object.freeze({
  coinbase: Object.freeze({ products: 'https://api.exchange.coinbase.com/products', stats: 'https://api.exchange.coinbase.com/products/stats', one: (id) => `https://api.exchange.coinbase.com/products/${id}/stats` }),
  kraken: Object.freeze({ pairs: 'https://api.kraken.com/0/public/AssetPairs', ticker: 'https://api.kraken.com/0/public/Ticker' }),
  okx: Object.freeze({ tickers: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT' }),
  gate: Object.freeze({ tickers: 'https://api.gateio.ws/api/v4/spot/tickers' }),
  kucoin: Object.freeze({ tickers: 'https://api.kucoin.com/api/v1/market/allTickers' }),
});
// quotes counted at $1; any other quote is converted at the venue's own price of it against one of these
export const STABLE_QUOTES = new Set(['USD', 'USDT', 'USDC']);
const ALIAS = { XBT: 'BTC', XDG: 'DOGE' }; // Kraken's names
// the coins the exchanges trade under another ticker than the pool lists' token (WETH, cbBTC)
const COIN_SYMBOL = { ethereum: 'ETH', bitcoin: 'BTC', 'usd-coin': 'USDC', tether: 'USDT', dai: 'DAI' };
const num = (x) => { if (x == null || x === '') return null; const v = Number(x); return Number.isFinite(v) && v >= 0 ? v : null; };
const sym = (x) => { const s = String(x ?? '').trim().toUpperCase(); return ALIAS[s] ?? s; };
// one market: { base, quote, last (in the quote), qvol (24 h volume in the quote) }, or null when unreadable
const market = (base, quote, last, qvol) => {
  const b = sym(base), q = sym(quote), l = num(last), v = num(qvol);
  return b && q && /^[A-Z0-9]{1,20}$/.test(b) && /^[A-Z0-9]{1,20}$/.test(q) && l > 0 && v != null ? { base: b, quote: q, last: l, qvol: v } : null;
};
const rowsOf = (list) => { const r = list.filter(Boolean); return r; };

// Coinbase Exchange: GET /products/stats → { "AAA-USD": { stats_24hour: { last, volume (base) } } } (every product
// at once), or GET /products/{id}/stats → { last, volume } for one. Volume × last is the quote volume.
export function parseCoinbaseStats(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const rows = [];
  for (const [id, v] of Object.entries(json)) {
    const s = v?.stats_24hour, [b, q] = String(id).split('-');
    if (s && b && q) rows.push(market(b, q, s.last, num(s.volume) != null && num(s.last) != null ? num(s.volume) * num(s.last) : null));
  }
  const r = rowsOf(rows);
  return r.length ? r : null;
}
export function parseCoinbaseOne(id, json) {
  const [b, q] = String(id).split('-'), l = num(json?.last), v = num(json?.volume);
  return b && q && l != null && v != null ? market(b, q, l, v * l) : null;
}
// GET /products → [{ id: "AAA-USD", base_currency, quote_currency, status, trading_disabled }]: the online products
// quoted in a stablecoin, by base → [ids]
export function parseCoinbaseProducts(json) {
  if (!Array.isArray(json)) return null;
  const by = new Map();
  for (const p of json) {
    if (!p || p.status !== 'online' || p.trading_disabled === true) continue;
    const b = sym(p.base_currency), q = sym(p.quote_currency);
    if (!b || !STABLE_QUOTES.has(q) || typeof p.id !== 'string') continue;
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(p.id);
  }
  return by;
}
// Kraken: AssetPairs → { error: [], result: { KEY: { altname, wsname: "AAA/USD", ... } } }; Ticker (every pair) →
// { error: [], result: { KEY: { c: [last, lot], v: [today, 24 h], p: [vwap today, vwap 24 h] } } }.
export function parseKraken(pairs, ticker) {
  const P = pairs?.result, T = ticker?.result;
  if (!P || !T || typeof P !== 'object' || typeof T !== 'object' || (Array.isArray(ticker?.error) && ticker.error.length)) return null;
  const byKey = new Map();
  for (const [k, p] of Object.entries(P)) { if (p?.wsname) { byKey.set(k, p); if (p.altname) byKey.set(p.altname, p); } }
  const rows = [];
  for (const [k, t] of Object.entries(T)) {
    const p = byKey.get(k), [b, q] = String(p?.wsname || '').split('/');
    const v = num(t?.v?.[1]), vw = num(t?.p?.[1]), l = num(t?.c?.[0]);
    if (b && q) rows.push(market(b, q, l, v != null && (vw > 0 || l > 0) ? v * (vw > 0 ? vw : l) : null));
  }
  const r = rowsOf(rows);
  return r.length ? r : null;
}
// OKX: { code: "0", data: [{ instId: "AAA-USDT", last, volCcy24h (quote volume for spot) }] }
export function parseOkx(json) {
  if (String(json?.code) !== '0' || !Array.isArray(json?.data)) return null;
  const r = rowsOf(json.data.map((t) => { const [b, q] = String(t?.instId || '').split('-'); return market(b, q, t?.last, t?.volCcy24h); }));
  return r.length ? r : null;
}
// Gate: [{ currency_pair: "AAA_USDT", last, quote_volume }]
export function parseGate(json) {
  if (!Array.isArray(json)) return null;
  const r = rowsOf(json.map((t) => { const [b, q] = String(t?.currency_pair || '').split('_'); return market(b, q, t?.last, t?.quote_volume); }));
  return r.length ? r : null;
}
// KuCoin: { code: "200000", data: { ticker: [{ symbol: "AAA-USDT", last, volValue (quote volume) }] } }
export function parseKucoin(json) {
  if (String(json?.code) !== '200000' || !Array.isArray(json?.data?.ticker)) return null;
  const r = rowsOf(json.data.ticker.map((t) => { const [b, q] = String(t?.symbol || '').split('-'); return market(b, q, t?.last, t?.volValue); }));
  return r.length ? r : null;
}

// One venue's markets → Map(SYMBOL → { usd, markets, px }): each market's 24 h volume in USD (a stablecoin quote at
// $1, any other quote at the venue's own price of it against a stablecoin; a market whose quote the venue doesn't
// price is left out), summed by base; px: the coin's USD price at its biggest market.
export function venueVolumes(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  const best = new Map();
  for (const r of rows) if (r && STABLE_QUOTES.has(r.quote) && !STABLE_QUOTES.has(r.base)) { const b = best.get(r.base); if (!b || r.qvol > b.qvol) best.set(r.base, r); }
  const usdOf = (q) => (STABLE_QUOTES.has(q) ? 1 : best.get(q)?.last ?? null);
  for (const r of rows) {
    if (!r) continue;
    const rate = usdOf(r.quote);
    if (!(rate > 0)) continue;
    const usd = r.qvol * rate, o = out.get(r.base) || { usd: 0, markets: 0, px: null, top: -1 };
    o.usd += usd; o.markets++;
    if (usd > o.top) { o.top = usd; o.px = r.last * rate; }
    out.set(r.base, o);
  }
  for (const o of out.values()) delete o.top;
  return out;
}

// coins: CoinGecko ids; meta: Map(coin → { symbol, usd }). Reads each venue once (time and calls capped by
// budget), then sums each coin over the venues that list its symbol at a price within budget.priceTol of usd.
// Returns { vol: Map(coin → { vol, cex: markets, venues, src: 'exchanges' } | null), asked, got, unlisted,
// mismatched, ambiguous, unpriced, venues: { name: markets read | null (unread) }, calls, note, lastError }.
export async function exchangeVolumes(getJson, coins, { meta, budget = FALLBACK_BUDGET } = {}) {
  const b = makeBudget({ ms: budget.ms, calls: budget.calls }), gj = capGetJson(getJson, b);
  const t = budget.timeoutMs ?? 15000, H = { headers: { accept: 'application/json' } };
  let lastError = null;
  const get = async (url) => { try { return await gj(url, H, Math.max(1000, Math.min(t, b.left()))); } catch (e) { lastError = category(e); return null; } };
  // the symbols: a coin's own ticker, unless another coin of the lists has the same one
  const symOf = (c) => COIN_SYMBOL[c] ?? sym(meta?.get(c)?.symbol);
  const owners = new Map();
  for (const c of new Set([...(meta?.keys() ?? []), ...coins])) { const s = symOf(c); if (s) owners.set(s, (owners.get(s) || new Set()).add(c)); }
  const wantSyms = new Set(coins.map(symOf).filter((s) => s && owners.get(s)?.size === 1));
  // every venue at once (different hosts); Coinbase's bulk stats first, else its products one by one
  async function coinbase() {
    const all = parseCoinbaseStats(await get(VENUES.coinbase.stats));
    if (all) return all;
    const prods = parseCoinbaseProducts(await get(VENUES.coinbase.products));
    if (!prods) return null;
    const rows = [];
    for (const s of wantSyms) for (const id of prods.get(s) || []) {
      if (b.over()) break;
      const r = parseCoinbaseOne(id, await get(VENUES.coinbase.one(id)));
      if (r) rows.push(r);
      await pause(budget.spacingMs ?? 0);
    }
    return rows; // the venue answered: a coin it doesn't list is simply absent
  }
  const kraken = async () => { const [p, k] = await Promise.all([get(VENUES.kraken.pairs), get(VENUES.kraken.ticker)]); return parseKraken(p, k); };
  const [cb, kr, ok, ga, ku] = await Promise.all([coinbase(), kraken(), get(VENUES.okx.tickers).then(parseOkx), get(VENUES.gate.tickers).then(parseGate), get(VENUES.kucoin.tickers).then(parseKucoin)]);
  const read = { coinbase: cb, kraken: kr, okx: ok, gate: ga, kucoin: ku };
  const maps = Object.entries(read).filter(([, rows]) => rows).map(([name, rows]) => [name, venueVolumes(rows)]);
  const vol = new Map();
  let got = 0, unlisted = 0, mismatched = 0, ambiguous = 0, unpriced = 0;
  for (const c of coins) {
    const s = symOf(c), ref = num(meta?.get(c)?.usd);
    if (!s || owners.get(s)?.size !== 1) { vol.set(c, null); ambiguous++; continue; }
    if (!(ref > 0)) { vol.set(c, null); unpriced++; continue; }
    if (!maps.length) { vol.set(c, null); continue; }
    let usd = 0, markets = 0, venues = 0, listed = 0;
    for (const [, m] of maps) {
      const v = m.get(s);
      if (!v) continue;
      listed++;
      if (!(v.px > 0) || Math.abs(v.px / ref - 1) > budget.priceTol) continue; // another coin with this ticker, or a stale market
      usd += v.usd; markets += v.markets; venues++;
    }
    if (venues) { vol.set(c, { vol: usd, cex: markets, venues, src: 'exchanges' }); got++; } else { vol.set(c, null); if (listed) mismatched++; else unlisted++; }
  }
  return { vol, asked: coins.length, got, unlisted, mismatched, ambiguous, unpriced,
    venues: Object.fromEntries(Object.entries(read).map(([k, rows]) => [k, rows ? rows.length : null])), calls: b.used(), note: b.note(), lastError };
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
