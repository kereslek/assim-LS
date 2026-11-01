// USD price history for the volatility cross-check, from two sources:
//  - CoinGecko by contract address (Demo key, header x-cg-demo-api-key): /coins/{platform}/contract/
//    {address}/market_chart?vs_currency=usd&days=30. For 2–90 days it answers hourly points, so the
//    market can be sampled at the same moments as a pool's own daily prices. Demo allows about 30
//    calls a minute and 10,000 a month, so each token is fetched at most once a UTC day: a small
//    cache file keeps the day's answers for every later pass (the always-on loop reuses it).
//  - DefiLlama's chart API as the fallback for tokens CoinGecko doesn't answer.
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

// The day's answers on disk: { v: 1, entries: { key: { day: 'YYYY-MM-DD', t: ms, pts: [[t, price]] } } }.
// A broken or missing file is an empty cache, never an error.
export function makeHistoryCache(file, { now = Date.now() } = {}) {
  let data = { v: 1, entries: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && j.entries && typeof j.entries === 'object') data = j; } catch { /* empty cache */ }
  const today = dayOf(now);
  return {
    today,
    fresh(key) { const e = data.entries[key]; return e && e.day === today && Array.isArray(e.pts) && e.pts.length ? e.pts.map(([t, price]) => ({ t, price })) : null; },
    missedToday(key) { const e = data.entries[key]; return !!(e && e.day === today && e.miss); }, // the source said it doesn't know this token
    put(key, pts) { data.entries[key] = { day: today, t: now, pts: pts.map((p) => [p.t, p.price]) }; },
    miss(key) { data.entries[key] = { day: today, t: now, miss: true, pts: [] }; },
    save() {
      for (const [k, e] of Object.entries(data.entries)) if (!(now - e.t < 3 * 86400e3)) delete data.entries[k]; // keep it small
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
    size: () => Object.keys(data.entries).length,
  };
}

// keys: "ethereum:0x…". Returns { series: Map(key → points), unread: [keys], fetched, cached, calls, lastError }.
export async function coinGeckoHistory(getJson, keys, { key, days = 30, cache = null, spacingMs = 2200, tries = 3, maxCalls = 600 } = {}) {
  const series = new Map(), unread = [];
  let fetched = 0, cached = 0, calls = 0, lastError = null;
  const headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
  for (const k of keys) {
    const hit = cache?.fresh(k);
    if (hit) { series.set(k, hit); cached++; continue; }
    if (cache?.missedToday(k)) { unread.push(k); continue; }
    const [platform, address] = k.split(':');
    if (!platform || !/^0x[0-9a-f]{40}$/.test(address || '') || calls >= maxCalls) { unread.push(k); continue; }
    let pts = null, unknown = false;
    for (let i = 0; i < tries && !pts; i++) {
      calls++;
      try {
        pts = parseMarketChart(await getJson(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${address}/market_chart?vs_currency=usd&days=${days}`, { headers }, 30000));
        if (!pts) { lastError = 'no prices'; break; }
      } catch (e) {
        lastError = category(e);
        if (/404/.test(lastError)) { unknown = true; break; } // CoinGecko doesn't know this contract: no retry today
        await pause(spacingMs * 8 * 2 ** i); // 429 or a hiccup: back off
      }
    }
    if (pts) { series.set(k, pts); cache?.put(k, pts); fetched++; } else { unread.push(k); if (unknown) cache?.miss(k); }
    await pause(spacingMs);
  }
  return { series, unread, fetched, cached, calls, lastError };
}

export async function dailyHistory(getJson, keys, { days = 31, now = Math.floor(Date.now() / 1000), batch = 30, spacingMs = 1200, tries = 3 } = {}) {
  const out = new Map(), unread = [];
  let lastError = null;
  const start = now - days * 86400;
  for (let i = 0; i < keys.length; i += batch) {
    const part = keys.slice(i, i + batch);
    let j = null;
    for (let k = 0; k < tries && !j; k++) {
      try { j = await getJson(`https://coins.llama.fi/chart/${part.join(',')}?start=${start}&span=${days + 1}&period=1d&searchWidth=600`, {}, 30000); } catch (e) { lastError = category(e); await pause(spacingMs * 3 * 2 ** k); }
    }
    if (!j) { unread.push(...part); continue; }
    for (const [k, v] of parseChart(j)) out.set(k, v);
    await pause(spacingMs);
  }
  return { series: out, unread, lastError };
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
