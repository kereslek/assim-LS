// The token universe: CoinGecko market-cap ranks (close to CoinMarketCap's) mapped to each coin's
// token contract on one chain. Coins with no contract on that chain are left out, not guessed.

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
  async function get(path) {
    for (let i = 0; i < tries; i++) {
      try { return await getJson(base + path, { headers }, 30000); } catch { await pause(spacingMs * 4 * 2 ** i); }
    }
    return null;
  }
  const markets = [], unreadPages = [];
  for (let p = 1; p <= pages; p++) {
    const rows = await get(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&sparkline=false`);
    if (Array.isArray(rows)) markets.push(...rows); else unreadPages.push(p);
    await pause(spacingMs);
  }
  const list = await get('/coins/list?include_platform=true');
  return { markets, list: Array.isArray(list) ? list : null, unreadPages };
}
