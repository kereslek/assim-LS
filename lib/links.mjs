// Each token's "read about this coin" links: a CoinMarketCap slug and a CoinGecko id (live.json pool.t0/t1.links,
// docs/DATA.md). The page links the CoinMarketCap page when a slug is known, else the CoinGecko page, else nothing.
//   const cache = makeLinksCache('out/cache/links.json', { now });
//   const r = await resolveLinks(tokens, { getJson, cgKey, cmcKey, cache, now, apis });   // tokens: [{ chain, addr, cg }]
//   r.of(chain, addr) → { cmc: slug|null, cg: id|null }; r.counts → { cg, cmc, none } (the public log prints only these)
// Nothing is guessed from a symbol: a wrapped native token comes from the explicit map below (by chain and address), a
// CoinGecko id from the pool list (the universe's coin) or CoinGecko's own contract lookup, a CoinMarketCap slug only
// from CoinMarketCap's API (with the CMC_API_KEY secret) and only when its answer lists this very contract address.
// Lookups are cached: a found answer for 30 days, a miss (or a failed call) until the next UTC day.
import fs from 'node:fs';
import path from 'node:path';
import { isBudgetError } from './budget.mjs';

const ETH = Object.freeze({ cmc: 'ethereum', cg: 'ethereum' }), BTC = Object.freeze({ cmc: 'bitcoin', cg: 'bitcoin' });
const ZERO = '0x0000000000000000000000000000000000000000';
// wrapped-native (and native) tokens link to the coin they wrap
export const WRAPPED = Object.freeze({
  [`ethereum:${ZERO}`]: ETH, [`base:${ZERO}`]: ETH,                                // native ETH (v4)
  'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ETH,                      // WETH
  'base:0x4200000000000000000000000000000000000006': ETH,                          // WETH on Base
  'ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': BTC,                      // WBTC
  'ethereum:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': BTC,                      // cbBTC
  'base:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': BTC,                          // cbBTC on Base
});
const CG_PLATFORM = { ethereum: 'ethereum', base: 'base' };
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const okSlug = (s) => typeof s === 'string' && SLUG.test(s);
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const FOUND_MS = 30 * 86400e3;

// The page's link for one token: CoinMarketCap first, then CoinGecko, else null (plain text). Also in the page.
export function linkOf(links) {
  if (okSlug(links?.cmc)) return { site: 'CoinMarketCap', url: `https://coinmarketcap.com/currencies/${links.cmc}/` };
  if (okSlug(links?.cg)) return { site: 'CoinGecko', url: `https://www.coingecko.com/en/coins/${links.cg}` };
  return null;
}

// { v: 1, cg: { "chain:addr": { v: id|null, t } }, cmc: { … slug|null … } }. A broken file is an empty cache.
export function makeLinksCache(file, { now = Date.now() } = {}) {
  let c = { v: 1, cg: {}, cmc: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && j.cg && j.cmc) c = { v: 1, cg: j.cg, cmc: j.cmc }; } catch { /* none */ }
  const today = dayOf(now);
  return {
    // the cached answer: undefined = ask (none, an old miss or a found answer over 30 days old)
    get(kind, k) {
      const e = c[kind][k];
      if (!e || !Number.isFinite(e.t)) return undefined;
      if (e.v == null) return dayOf(e.t) === today ? null : undefined;
      return okSlug(e.v) && now - e.t < FOUND_MS ? e.v : undefined;
    },
    old(kind, k) { const e = c[kind][k]; return okSlug(e?.v) ? e.v : null; }, // a found answer of any age
    set(kind, k, v) { c[kind][k] = { v: okSlug(v) ? v : null, t: now }; },
    save() { if (!file) return; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(c)); },
    data: () => c,
  };
}

// CoinGecko's contract lookup: the coin's id only when its own platforms list this address on this chain.
export async function cgByContract(getJson, chain, addr, { key } = {}) {
  const pf = CG_PLATFORM[chain];
  if (!pf) return null;
  const headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  let j;
  try { j = await getJson(`https://api.coingecko.com/api/v3/coins/${pf}/contract/${addr}`, { headers }, 20000); } catch (e) {
    if (e?.status === 404) return null; // CoinGecko does not know it: a miss
    throw e;
  }
  return okSlug(j?.id) && String(j?.platforms?.[pf] || '').toLowerCase() === addr ? j.id : null;
}

// CoinMarketCap's metadata (v2 /cryptocurrency/info, free Basic plan) for one contract address: the slug only when the
// answer lists this address among the coin's contracts, and only one coin does.
export async function cmcByContract(getJson, addr, { key }) {
  const j = await getJson(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?address=${addr}&skip_invalid=true&aux=platform`,
    { headers: { accept: 'application/json', 'X-CMC_PRO_API_KEY': key } }, 20000);
  const rows = Object.values(j?.data || {}).flatMap((x) => (Array.isArray(x) ? x : [x]));
  const hits = rows.filter((r) => okSlug(r?.slug) && [
    r?.platform?.token_address, ...(Array.isArray(r?.contract_address) ? r.contract_address.map((c) => c?.contract_address) : []),
  ].some((a) => String(a || '').toLowerCase() === addr));
  return hits.length === 1 ? hits[0].slug : null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// tokens: [{ chain, addr, cg }] (cg = the pool list's coin id, or null). maxCg / maxCmc: lookups a pass may send.
export async function resolveLinks(tokens, { getJson, cmcGetJson = getJson, cgKey = null, cmcKey = null, cache, apis = null, maxCg = 10, maxCmc = 30, spacingMs = 2100 } = {}) {
  const map = new Map(), sent = { cg: 0, cmc: 0 };
  const list = [];
  for (const t of tokens || []) {
    const addr = String(t?.addr || '').toLowerCase(), k = `${t?.chain}:${addr}`;
    if (!isAddr(addr) || map.has(k)) continue;
    map.set(k, { cmc: null, cg: okSlug(t.cg) ? t.cg : null });
    list.push({ k, chain: t.chain, addr });
  }
  let cgStop = false, cmcStop = !cmcKey;
  for (const { k, chain, addr } of list) {
    const L = map.get(k), w = WRAPPED[k];
    if (w) { L.cmc = cmcKey ? w.cmc : null; L.cg = w.cg; continue; }
    if (addr === ZERO) continue;
    if (!L.cg) {
      const c = cache?.get('cg', k);
      if (c !== undefined) L.cg = c;
      else if (!cgStop && sent.cg < maxCg && (apis?.allow ? apis.allow('coingecko', { reserve: 40 }) : true)) {
        sent.cg++;
        try { L.cg = await cgByContract(getJson, chain, addr, { key: cgKey }); cache?.set('cg', k, L.cg); } catch (e) {
          L.cg = cache?.old('cg', k) ?? null; // a failed call keeps an earlier answer, else no link today
          if (isBudgetError(e)) cgStop = true; else cache?.set('cg', k, L.cg);
        }
        await pause(spacingMs);
      } else L.cg = cache?.old('cg', k) ?? null;
    }
    if (cmcKey) {
      const c = cache?.get('cmc', k);
      if (c !== undefined) L.cmc = c;
      else if (!cmcStop && sent.cmc < maxCmc) {
        sent.cmc++;
        try { L.cmc = await cmcByContract(cmcGetJson, addr, { key: cmcKey }); cache?.set('cmc', k, L.cmc); } catch (e) {
          L.cmc = cache?.old('cmc', k) ?? null;
          if ([401, 402, 403, 429].includes(e?.status)) cmcStop = true; // key refused or credits out: no more this pass
          else cache?.set('cmc', k, L.cmc);
        }
        await pause(spacingMs);
      } else L.cmc = cache?.old('cmc', k) ?? null;
    }
  }
  const vals = [...map.values()];
  const counts = { cg: vals.filter((x) => !x.cmc && x.cg).length, cmc: vals.filter((x) => x.cmc).length, none: vals.filter((x) => !x.cmc && !x.cg).length };
  return {
    of: (chain, addr) => { const L = map.get(`${chain}:${String(addr || '').toLowerCase()}`); return L ? { cmc: L.cmc, cg: L.cg } : { cmc: null, cg: null }; },
    counts, sent,
    line: () => `links: ${counts.cg} cg, ${counts.cmc} cmc, ${counts.none} none · cmc key: ${cmcKey ? 'present' : 'absent'} · lookups ${sent.cg} cg, ${sent.cmc} cmc`,
  };
}
