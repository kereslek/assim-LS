// The token universe: CoinGecko market-cap ranks (close to CoinMarketCap's) mapped to each coin's
// token contract on one chain. Coins with no contract on that chain are left out, not guessed.
// The ranks change slowly, so the CoinGecko answer (9 calls) is kept for 24 hours in a small cache file
// (cachedUniverse; while CoinGecko can't answer, its monthly quota out or refusing, the cache serves up to 45 days
// old, and with no cache the universe is unread, never guessed), and the tokens' USD prices come from DefiLlama first, then GeckoTerminal, and only then from
// CoinGecko's own market rows when those are under an hour old (priceTokens).
import fs from 'node:fs';
import path from 'node:path';
import { isBudgetError } from './budget.mjs';

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// markets: /coins/markets rows; list: /coins/list?include_platform=true rows.
export function buildUniverse(markets, list, { rankMin = 100, rankMax = 2000, platform = 'ethereum', include = [], exclude = [] } = {}) {
  const addrOf = new Map(list.map((c) => [c.id, c.platforms?.[platform]]));
  const ex = new Set(exclude.map((a) => a.toLowerCase()));
  const seen = new Set(), tokens = [];
  let ranked = 0, onChain = 0;
  for (const m of markets) {
    const r = m.market_cap_rank, forced = include.includes(m.id);
    if (!forced && !(r >= rankMin && r <= rankMax)) continue;
    ranked++;
    const a = addrOf.get(m.id);
    if (!isAddr(a)) continue;
    onChain++;
    const address = a.toLowerCase();
    if (ex.has(address) || seen.has(address)) continue;
    seen.add(address);
    tokens.push({
      id: m.id, symbol: String(m.symbol || '').toUpperCase(), rank: r ?? null, address,
      usd: m.current_price > 0 ? m.current_price : null, mcap: m.market_cap ?? null, volume24h: m.total_volume ?? null,
    });
  }
  return { tokens, counts: { ranked, onChain, kept: tokens.length } };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch with patience for the free API's rate limit; a page that never answers is reported, not skipped silently.
export async function fetchCoinGecko(getJson, { key, pages = 8, spacingMs = 2500, tries = 4 } = {}) {
  const base = 'https://api.coingecko.com/api/v3';
  const headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  let spent = false; // a budget said no (the day's, or the month's quota): the pages left are not asked
  async function get(p) {
    for (let i = 0; i < tries && !spent; i++) {
      try { return await getJson(base + p, { headers }, 30000); } catch (e) { if (isBudgetError(e)) { spent = true; return null; } await pause(spacingMs * 4 * 2 ** i); }
    }
    return null;
  }
  const markets = [], unreadPages = [];
  for (let p = 1; p <= pages; p++) {
    const rows = spent ? null : await get(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&sparkline=false`);
    if (Array.isArray(rows)) markets.push(...rows); else unreadPages.push(p);
    if (!spent) await pause(spacingMs);
  }
  const list = spent ? null : await get('/coins/list?include_platform=true');
  return { markets, list: Array.isArray(list) ? list : null, unreadPages };
}

// The cache: { v: 1, t: ms, markets: [slim rows], list: [{ id, platforms: { ethereum?, base? } }] } for the coins
// ranked. A broken file is no cache.
export const UNIVERSE_CALLS = 9; // 8 market pages and the coin list
const slim = (markets, list, platforms) => {
  const ids = new Set(markets.map((m) => m.id));
  return {
    markets: markets.map((m) => ({ id: m.id, symbol: m.symbol, market_cap_rank: m.market_cap_rank ?? null, current_price: m.current_price ?? null, market_cap: m.market_cap ?? null, total_volume: m.total_volume ?? null })),
    list: list.filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, platforms: Object.fromEntries(platforms.filter((k) => c.platforms?.[k]).map((k) => [k, c.platforms[k]])) })),
  };
};
// Returns fetchCoinGecko's { markets, list, unreadPages } plus from ('cache' | 'coingecko' | 'none'), ageMs (the
// cache's age, null when there is none) and why ('fresh' | 'no budget' | 'coingecko out' | 'coingecko unread' | null).
// Over 24 h old, CoinGecko is asked again, if the daily budget (apis, lib/apicount.mjs) has room; an incomplete
// answer or no room falls back to a cache up to `staleMs` (45 days) old. While CoinGecko's monthly quota is out
// (apis.isOut()) it is not asked at all: the cache serves up to `staleMs` old, and past that (or with no cache)
// the universe is unread (from 'none': no markets, no list), never guessed.
export const UNIVERSE_STALE_MS = 45 * 86400e3;
export async function cachedUniverse(getJson, { file, key, now = Date.now(), maxAgeMs = 24 * 3600e3, staleMs = UNIVERSE_STALE_MS, apis = null, platforms = ['ethereum', 'base'], fetch = fetchCoinGecko, pages = 8 } = {}) {
  let c = null;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && Number.isFinite(j.t) && Array.isArray(j.markets) && j.markets.length && Array.isArray(j.list)) c = j; } catch { /* no cache */ }
  const age = c ? now - c.t : Infinity;
  const fromCache = (why) => ({ markets: c.markets, list: c.list, unreadPages: [], from: 'cache', ageMs: age, why });
  const none = (why) => ({ markets: [], list: null, unreadPages: Array.from({ length: pages }, (_, i) => i + 1), from: 'none', ageMs: c ? age : null, why });
  if (age < maxAgeMs) return fromCache('fresh');
  const out = !!apis?.isOut?.();
  if (out) return age < staleMs ? fromCache('coingecko out') : none('coingecko out');
  if (apis && apis.left() < UNIVERSE_CALLS && age < staleMs) return fromCache('no budget');
  const r = await fetch(getJson, { key });
  if (!r.unreadPages.length && r.list && r.markets.length) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ v: 1, t: now, ...slim(r.markets, r.list, platforms) })); } catch { /* asked again next run */ }
    return { ...r, from: 'coingecko', ageMs: 0, why: null };
  }
  const outNow = !!apis?.isOut?.(); // the quota may have run out during this very fetch
  if (age < staleMs) return fromCache(outNow ? 'coingecko out' : 'coingecko unread');
  if (outNow && !r.markets.length) return none('coingecko out');
  return { ...r, from: 'coingecko', ageMs: 0, why: outNow ? 'coingecko out' : 'coingecko unread' };
}

// USD prices for tokens on one chain: DefiLlama (fresh within an hour and confident), then GeckoTerminal's
// token_price for the rest. platform: 'ethereum' | 'base'. Returns { usd: Map(address → usd), defillama, geckoterminal }
// (counts of tokens priced by each). A token neither prices is absent, never 0.
const GT_NET = { ethereum: 'eth', base: 'base' };
export async function priceTokens(getJson, platform, addresses, { nowS = Date.now() / 1000, batch = 60, gtBatch = 30, gtMax = 10, spacingMs = 1200 } = {}) {
  const usd = new Map(), list = [...new Set(addresses.map((a) => String(a).toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
  let defillama = 0, geckoterminal = 0;
  for (let i = 0; i < list.length; i += batch) {
    const part = list.slice(i, i + batch);
    const j = await getJson(`https://coins.llama.fi/prices/current/${part.map((a) => `${platform}:${a}`).join(',')}`, {}, 20000).catch(() => null);
    for (const [k, v] of Object.entries(j?.coins || {})) {
      const a = k.toLowerCase().split(':')[1];
      if (part.includes(a) && v?.price > 0 && nowS - v.timestamp < 3600 && (v.confidence ?? 1) >= 0.9 && !usd.has(a)) { usd.set(a, v.price); defillama++; }
    }
    if (i + batch < list.length) await pause(spacingMs);
  }
  const rest = list.filter((a) => !usd.has(a)), net = GT_NET[platform];
  for (let i = 0, n = 0; net && i < rest.length && n < gtMax; i += gtBatch, n++) {
    const part = rest.slice(i, i + gtBatch);
    const j = await getJson(`https://api.geckoterminal.com/api/v2/simple/networks/${net}/token_price/${part.join(',')}`, { headers: { accept: 'application/json' } }, 20000).catch(() => null);
    for (const [a, v] of Object.entries(j?.data?.attributes?.token_prices || {})) {
      const x = Number(v), k = a.toLowerCase();
      if (part.includes(k) && x > 0 && Number.isFinite(x)) { usd.set(k, x); geckoterminal++; }
    }
    await pause(2500);
  }
  return { usd, defillama, geckoterminal };
}
