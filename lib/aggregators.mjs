// Aggregator pool lists (GeckoTerminal, DexScreener), normalised to one shape for cross-checks:
// { source, dex, venue: 3 | 4 | null, id, base, quote, quoteSymbol, reserveUsd, createdAt }.
// Aggregators list empty pools too, so they are a check on our list, never its source of truth.
import { ZERO } from './pools.mjs';
import { isBudgetError } from './budget.mjs';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const norm = (a) => { const x = String(a || '').toLowerCase(); return x === NATIVE ? ZERO : isAddr(x) ? x : null; };
const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }; // null is not 0
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
      reserveUsd: num(a.reserve_in_usd), volumeUsd24h: num(a.volume_usd?.h24), createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
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
      reserveUsd: num(p.liquidity?.usd), volumeUsd24h: num(p.volume?.h24), createdAt: p.pairCreatedAt ?? null,
    };
  });
}

async function patient(getJson, url, { tries = 3, waitMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { return await getJson(url, { headers: { accept: 'application/json' } }, 20000); } catch (e) { if (isBudgetError(e)) return null; await pause(waitMs * 2 ** i); } // a spent budget: unread, no waiting
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

// Sequential with spacing (GeckoTerminal ≥ 2.3 s apart, DexScreener ≤ 4 a second). budget (lib/budget.mjs): once
// its time or calls are spent the items left are null (unread) at once, with no spacing; fn spends the calls
// (its fetcher wrapped with capGetJson on the same budget), so a retry counts as a call.
export async function eachSpaced(items, spacingMs, fn, { budget = null } = {}) {
  const out = [];
  for (const it of items) {
    if (budget?.over()) { out.push(null); continue; }
    out.push(await fn(it));
    if (!budget?.over()) await pause(spacingMs);
  }
  return out;
}
