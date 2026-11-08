// USD price history for the volatility cross-check (tokenHistory), from three sources in this order:
//  - DefiLlama's chart API (coins.llama.fi/chart, daily points, small batches): first, no key.
//  - GeckoTerminal (public API, no key, about 30 calls a minute): for a token DefiLlama lacks, its top pool's
//    hourly USD candles (2 calls a token), a few tokens a pass.
//  - CoinGecko by contract address (Demo key, header x-cg-demo-api-key): /coins/{platform}/contract/
//    {address}/market_chart?vs_currency=usd&days=30 (hourly points), last, within the daily CoinGecko budget
//    (lib/apicount.mjs) and leaving room for the other CoinGecko readers.
// Each token's answer is kept for the UTC day in a small cache file, written as the answers come (every few
// tokens), so a pass that is stopped or a cancelled run resumes where it was instead of fetching everything again;
// a source that said it doesn't know a token is not asked again that day.
// Keys look like "ethereum:0x…". A coin no source answers is absent (unread), never a flat line.
import fs from 'node:fs';
import path from 'node:path';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const category = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || 'error';

export function parseChart(json) {
  const out = new Map();
  for (const [k, v] of Object.entries(json?.coins || {})) {
    const pts = (v?.prices || []).filter((p) => p && p.price > 0 && Number.isFinite(p.timestamp)).map((p) => ({ t: p.timestamp, price: p.price }));
    if (pts.length) out.set(k.toLowerCase(), pts.sort((a, b) => a.t - b.t));
  }
  return out;
}

// CoinGecko market_chart → [{ t (seconds), price }] ascending; null when the answer has no prices.
export function parseMarketChart(json) {
  if (!Array.isArray(json?.prices)) return null;
  const pts = json.prices.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && p[1] > 0).map(([ms, price]) => ({ t: Math.floor(ms / 1000), price }));
  return pts.length ? pts.sort((a, b) => a.t - b.t) : null;
}

// The day's answers on disk: { v: 1, entries: { key: { day: 'YYYY-MM-DD', t: ms, pts: [[t, price]], src?, no?: { source: 1 } } } }.
// A broken or missing file is an empty cache, never an error. With a file, every `saveEvery` answers are written
// at once (the progress survives a pass that is stopped).
export function makeHistoryCache(file, { now = Date.now(), saveEvery = 5 } = {}) {
  let data = { v: 1, entries: {} }, unsaved = 0;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && j.entries && typeof j.entries === 'object') data = j; } catch { /* empty cache */ }
  const today = dayOf(now);
  const cur = (key) => { const e = data.entries[key]; return e && e.day === today ? e : null; };
  const c = {
    today,
    fresh(key) { const e = cur(key); return e && Array.isArray(e.pts) && e.pts.length ? e.pts.map(([t, price]) => ({ t, price })) : null; },
    missedToday(key) { const e = cur(key); return !!(e && (e.miss || e.no?.coingecko)); }, // CoinGecko said it doesn't know this token
    saidNo(key, src) { const e = cur(key); return !!(e && (e.no?.[src] || (src === 'coingecko' && e.miss))); },
    put(key, pts, src = null) { data.entries[key] = { day: today, t: now, pts: pts.map((p) => [p.t, p.price]), ...(src ? { src } : {}) }; c.tick(); },
    miss(key) { c.no(key, 'coingecko'); },
    no(key, src) { const e = cur(key); if (e?.pts?.length) return; data.entries[key] = { day: today, t: now, pts: [], ...(src === 'coingecko' ? { miss: true } : {}), no: { ...(e?.no || {}), [src]: 1 } }; c.tick(); },
    tick() { if (file && saveEvery > 0 && ++unsaved >= saveEvery) { try { c.save(); } catch { /* the end of the pass writes it */ } } },
    save() {
      unsaved = 0;
      for (const [k, e] of Object.entries(data.entries)) if (!(now - e.t < 3 * 86400e3)) delete data.entries[k]; // keep it small
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
    size: () => Object.keys(data.entries).length,
  };
  return c;
}

// keys: "ethereum:0x…". Returns { series: Map(key → points), unread: [keys], skipped: [keys], fetched, cached, calls, lastError }.
// budget (lib/budget.mjs): each call spends one; once spent, the keys left are unread and listed in skipped (not
// asked this pass: the day's cache fills over the next passes), with no waiting.
export async function coinGeckoHistory(getJson, keys, { key, days = 30, cache = null, spacingMs = 2200, tries = 3, maxCalls = 600, budget = null } = {}) {
  const series = new Map(), unread = [], skipped = [];
  let fetched = 0, cached = 0, calls = 0, lastError = null;
  const headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  for (const k of keys) {
    const hit = cache?.fresh(k);
    if (hit) { series.set(k, hit); cached++; continue; }
    if (cache?.missedToday(k)) { unread.push(k); continue; }
    const [platform, address] = k.split(':');
    if (!platform || !/^0x[0-9a-f]{40}$/.test(address || '') || calls >= maxCalls) { unread.push(k); continue; }
    if (budget?.over()) { unread.push(k); skipped.push(k); continue; }
    let pts = null, unknown = false;
    for (let i = 0; i < tries && !pts; i++) {
      if (budget && !budget.take()) break;
      calls++;
      try {
        pts = parseMarketChart(await getJson(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}/market_chart?vs_currency=usd&days=${days}`, { headers }, 30000));
        if (!pts) { lastError = 'no prices'; break; }
      } catch (e) {
        lastError = category(e);
        if (/404/.test(lastError)) { unknown = true; break; } // CoinGecko doesn't know this contract: no retry today
        if (/budget/.test(lastError)) break; // the daily budget is spent: not asked again this pass
        await pause(Math.min(spacingMs * 8 * 2 ** i, budget ? budget.left() : Infinity)); // 429 or a hiccup: back off
      }
    }
    if (pts) { series.set(k, pts); cache?.put(k, pts, 'coingecko'); fetched++; } else { unread.push(k); if (unknown) cache?.miss(k); }
    if (!budget?.over()) await pause(spacingMs);
  }
  return { series, unread, skipped, fetched, cached, calls, lastError };
}

// DefiLlama's chart, the fallback. A probe (1 Nov 2026) found calls of 1 to 8 coins answer 200 while
// the scan's 30-coin calls got 400, so batches stay small, and a batch that gets 400 is split in
// halves until a coin it can't take stands alone (unread).
// budget (lib/budget.mjs): each call spends one; once spent, the keys left are unread at once.
export async function dailyHistory(getJson, keys, { days = 31, now = Math.floor(Date.now() / 1000), batch = 8, spacingMs = 1200, tries = 3, budget = null } = {}) {
  const out = new Map(), unread = [];
  let lastError = null, splits = 0;
  const start = now - days * 86400;
  async function read(part) {
    let j = null, bad = false;
    for (let k = 0; k < tries && !j && !bad; k++) {
      if (budget && !budget.take()) break;
      try { j = await getJson(`https://coins.llama.fi/chart/${part.join(',')}?start=${start}&span=${days + 1}&period=1d&searchWidth=600`, {}, 30000); } catch (e) {
        lastError = category(e);
        bad = /400/.test(lastError); // a bad request is not retried as is
        if (!bad) await pause(Math.min(spacingMs * 3 * 2 ** k, budget ? budget.left() : Infinity));
      }
    }
    if (!j && bad && part.length > 1 && !budget?.over()) { splits++; const h = Math.ceil(part.length / 2); await read(part.slice(0, h)); await read(part.slice(h)); return; }
    if (!j) { unread.push(...part); return; }
    for (const [k, v] of parseChart(j)) out.set(k, v);
    await pause(spacingMs);
  }
  for (let i = 0; i < keys.length; i += batch) await read(keys.slice(i, i + batch));
  return { series: out, unread, lastError, splits };
}

// GeckoTerminal: a token's top pool (by GeckoTerminal's own ranking), then that pool's hourly candles priced in
// USD for this token. ohlcv_list rows are [open time s, o, h, l, c, v]; a point is the close at the hour's end.
export const GT_NETWORK = { ethereum: 'eth', base: 'base' };
export function parseGtOhlcv(json, { nowS = Date.now() / 1000 } = {}) {
  const rows = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return null;
  const pts = rows.filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number(r[4]) > 0).map((r) => ({ t: Math.min(r[0] + 3600, Math.floor(nowS)), price: Number(r[4]) })).filter((p) => p.t > 0);
  return pts.length ? pts.sort((a, b) => a.t - b.t) : null;
}
export async function geckoTerminalHistory(getJson, keys, { cache = null, hours = 744, spacingMs = 2500, maxTokens = 6, budget = null, nowS = Date.now() / 1000 } = {}) {
  const series = new Map(), unread = [];
  let calls = 0, asked = 0, lastError = null;
  const call = async (url) => { if (budget && !budget.take()) throw new Error('budget spent'); calls++; const j = await getJson(url, { headers: { accept: 'application/json' } }, 20000); await pause(spacingMs); return j; };
  for (const k of keys) {
    const [platform, address] = k.split(':'), net = GT_NETWORK[platform];
    if (!net || !/^0x[0-9a-f]{40}$/.test(address || '') || asked >= maxTokens || budget?.over()) { unread.push(k); continue; }
    asked++;
    try {
      const pools = await call(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${address}/pools?page=1`);
      const top = Array.isArray(pools?.data) ? pools.data.map((p) => String(p?.attributes?.address || '').toLowerCase()).find((a) => /^0x[0-9a-f]{40,64}$/.test(a)) : null;
      if (!top) { unread.push(k); cache?.no(k, 'geckoterminal'); continue; }
      const pts = parseGtOhlcv(await call(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${top}/ohlcv/hour?aggregate=1&limit=${hours}&currency=usd&token=${address}`), { nowS });
      if (pts) { series.set(k, pts); cache?.put(k, pts, 'geckoterminal'); } else { unread.push(k); cache?.no(k, 'geckoterminal'); }
    } catch (e) {
      lastError = category(e);
      unread.push(k);
      if (/404/.test(lastError)) cache?.no(k, 'geckoterminal');
      if (/429|budget/.test(lastError)) { for (const r of keys.slice(keys.indexOf(k) + 1)) unread.push(r); break; } // rate-limited: the rest wait for a later pass
    }
  }
  return { series, unread, calls, asked, lastError };
}

// The whole history read, in the fallback order DefiLlama → GeckoTerminal → CoinGecko, each token once a UTC day
// (the cache). apis (lib/apicount.mjs): the daily CoinGecko budget; CoinGecko history leaves cgReserve calls of it
// for the pool list, the exchange screen and the market strip, and asks at most cgMax tokens a pass.
// budget (lib/budget.mjs): a part's read cap (another chain's), spent by every call of every source.
// Returns { series, unread, skipped, by: { cache, defillama, geckoterminal, coingecko }, calls: {…}, lastError }.
export async function tokenHistory(getJson, keys, { key, cache = null, apis = null, budget = null, cgReserve = 40, cgMax = 5, gtMax = 6, days = 30,
  llama = {}, gt = {}, cg = {} } = {}) {
  const series = new Map(), by = { cache: 0, defillama: 0, geckoterminal: 0, coingecko: 0 }, calls = { defillama: 0, geckoterminal: 0, coingecko: 0 };
  let lastError = null;
  for (const k of keys) { const hit = cache?.fresh(k); if (hit) { series.set(k, hit); by.cache++; } }
  let rest = keys.filter((k) => !series.has(k));
  // 1. DefiLlama
  const askL = rest.filter((k) => !cache?.saidNo(k, 'defillama'));
  if (askL.length && !budget?.over()) {
    let n = 0;
    const counted = budget ? { over: () => budget.over(), take: () => (budget.take() ? (n++, true) : false), left: () => budget.left() } : { over: () => false, take: () => (n++, true), left: () => Infinity };
    const r = await dailyHistory(getJson, askL, { days: days + 1, ...llama, budget: counted });
    calls.defillama = n;
    const failed = new Set(r.unread);
    for (const k of askL) {
      const pts = r.series.get(k);
      if (pts) { series.set(k, pts); cache?.put(k, pts, 'defillama'); by.defillama++; } else if (!failed.has(k)) cache?.no(k, 'defillama'); // answered without it
    }
    lastError = r.lastError ?? lastError;
  }
  rest = rest.filter((k) => !series.has(k));
  // 2. GeckoTerminal
  const askG = rest.filter((k) => !cache?.saidNo(k, 'geckoterminal'));
  if (askG.length && !budget?.over()) {
    const r = await geckoTerminalHistory(getJson, askG, { cache, maxTokens: gtMax, budget, ...gt });
    calls.geckoterminal = r.calls;
    for (const [k, pts] of r.series) { series.set(k, pts); by.geckoterminal++; }
    lastError = r.lastError ?? lastError;
  }
  rest = rest.filter((k) => !series.has(k));
  // 3. CoinGecko, last, within the day's budget
  const askC = rest.filter((k) => !cache?.missedToday(k));
  const skipped = [];
  if (askC.length) {
    const gate = {
      over: () => !!budget?.over() || (apis ? !apis.allow('coingecko', { reserve: cgReserve }) : false),
      take: () => !gate.over() && (budget ? budget.take() : true),
      left: () => (budget ? budget.left() : Infinity),
    };
    const r = await coinGeckoHistory(getJson, askC, { key, days, cache, tries: 2, maxCalls: cgMax, budget: gate, ...cg });
    calls.coingecko = r.calls;
    for (const [k, pts] of r.series) { series.set(k, pts); by.coingecko++; }
    skipped.push(...r.skipped);
    lastError = r.lastError ?? lastError;
  }
  const unread = keys.filter((k) => !series.has(k));
  return { series, unread, skipped, by, calls, lastError };
}

// A series sampled at given moments: the nearest point within tol seconds (default: 1.5 h, or 60% of
// the series' own spacing when it is coarser). A moment with no point near enough is left out.
export function sampleAt(points, times, tol = null) {
  const pts = points.filter((p) => p.price > 0).sort((a, b) => a.t - b.t);
  if (!pts.length) return [];
  const gaps = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((a, b) => a - b);
  const w = tol ?? Math.max(5400, 0.6 * (gaps[Math.floor(gaps.length / 2)] ?? 0));
  const out = [];
  for (const t of times) {
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t < t) lo = m + 1; else hi = m; }
    const c = [pts[lo], pts[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (c && Math.abs(c.t - t) <= w) out.push({ t, price: c.price });
  }
  return out;
}

// Two USD series → token0 in token1 at the given moments (both sampled the same way).
export function ratioAt(a, b, times, tol = null) {
  const sb = new Map(sampleAt(b, times, tol).map((p) => [p.t, p.price]));
  return sampleAt(a, times, tol).filter((p) => sb.has(p.t)).map((p) => ({ t: p.t, price: p.price / sb.get(p.t) }));
}
