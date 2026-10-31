// Aggregator pool lists (GeckoTerminal, DexScreener), normalised to one shape for cross-checks:
// { source, dex, venue: 3 | 4 | null, id, base, quote, quoteSymbol, reserveUsd, createdAt }.
// Aggregators list empty pools too, so they are a check on our list, never its source of truth.
import { ZERO } from './pools.mjs';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const norm = (a) => { const x = String(a || '').toLowerCase(); return x === NATIVE ? ZERO : isAddr(x) ? x : null; };
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export const venueOfGecko = (dex) => (/^uniswap[-_]?v3/i.test(dex) ? 3 : /^uniswap[-_]?v4/i.test(dex) ? 4 : null);

export function parseGeckoPools(json) {
  return (json?.data || []).map((p) => {
    const a = p.attributes || {}, rel = p.relationships || {}, dex = String(rel.dex?.data?.id || '');
    const tok = (r) => norm(String(r?.data?.id || '').split('_').pop());
    const name = String(a.name || '');
    return {
      source: 'geckoterminal', dex, venue: venueOfGecko(dex), id: String(a.address || '').toLowerCase(),
      base: tok(rel.base_token), quote: tok(rel.quote_token), quoteSymbol: name.includes('/') ? name.split('/').pop().trim().split(' ')[0] : null,
      reserveUsd: num(a.reserve_in_usd), createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    };
  });
}

export function parseDexScreenerPairs(json, chainId = 'ethereum') {
  const rows = Array.isArray(json) ? json : json?.pairs || [];
  return rows.filter((p) => p && p.chainId === chainId).map((p) => {
    const labels = (p.labels || []).join(',');
    const venue = p.dexId === 'uniswap' ? (/\bv3\b/.test(labels) ? 3 : /\bv4\b/.test(labels) ? 4 : null) : null;
    return {
      source: 'dexscreener', dex: String(p.dexId || '') + (labels ? ':' + labels : ''), venue, id: String(p.pairAddress || '').toLowerCase(),
      base: norm(p.baseToken?.address), quote: norm(p.quoteToken?.address), quoteSymbol: p.quoteToken?.symbol ?? null,
      reserveUsd: num(p.liquidity?.usd), createdAt: p.pairCreatedAt ?? null,
    };
  });
}

async function patient(getJson, url, { tries = 3, waitMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { return await getJson(url, { headers: { accept: 'application/json' } }, 20000); } catch { await pause(waitMs * 2 ** i); }
  }
  return null;
}

// One token's pools. null = unread (never "no pools").
export async function geckoTokenPools(getJson, network, token) {
  const j = await patient(getJson, `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${token}/pools?page=1`, { waitMs: 6000 });
  return j ? parseGeckoPools(j) : null;
}

export async function dexScreenerTokenPairs(getJson, chainId, token) {
  const j = await patient(getJson, `https://api.dexscreener.com/token-pairs/v1/${chainId}/${token}`);
  return j ? parseDexScreenerPairs(j, chainId) : null;
}

// Sequential with spacing (GeckoTerminal ≥ 2.3 s apart, DexScreener ≤ 4 a second).
export async function eachSpaced(items, spacingMs, fn) {
  const out = [];
  for (const it of items) { out.push(await fn(it)); await pause(spacingMs); }
  return out;
}
