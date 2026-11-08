// The dashboard's top strip (docs/DATA.md, live.json `market`): Ethereum gas against its own recent
// range, and ETH, BTC and SOL in USD with their 24 h change. The page never calls a third party, so
// the scanner reads these once a pass. Public market data only.
//
// - Gas: eth_feeHistory over the last ~1024 blocks gives the next block's base fee plus a typical
//   priority fee (the median of recent blocks' median tips); eth_gasPrice is the fallback.
// - Gas history: one rolling sample per pass, kept as hourly means ([hourMs, gwei, n]) for 7 days, carried
//   between passes inside the sealed live.json (market.gas.hist). Percentiles use one value per hour, so
//   irregular pass spacing doesn't weight busy stretches. Under 12 hours of history, the band falls back
//   to the fee-history blocks themselves (about the last 3.4 hours); with neither, the band is null.
// - Prices: DefiLlama (coins.llama.fi prices/current and percentage, by coingecko id) first; for a coin it
//   lacks, Coinbase's public spot price (api.coinbase.com, no key) with the 24 h change from its exchange stats
//   (api.exchange.coinbase.com, open vs last); CoinGecko simple/price only for a coin both lack. The DefiLlama
//   vs CoinGecko agreement check runs once a UTC day (market.xcheck carries the day), not every pass.
//   apis (lib/apicount.mjs, optional): the daily CoinGecko budget; spent, CoinGecko is not asked.
// - Missing is never zero: every failure is null, nothing here throws, and each read has a time limit.

export const HOUR = 3600e3, DAY = 24 * HOUR;
export const GAS_KEEP_DAYS = 7, GAS_MIN_BUCKETS = 12, GAS_MIN_BLOCKS = 50, TIP_BLOCKS = 20;
export const COINS = { ETH: 'ethereum', BTC: 'bitcoin', SOL: 'solana' };
const MAX_GWEI = 1e5, PRICE_MAX_AGE_S = 2 * 3600;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sig = (x, n = 4) => (isNum(x) ? Number(x.toPrecision(n)) : null);
const okGwei = (g) => isNum(g) && g > 0 && g < MAX_GWEI;
const hexNum = (h) => (typeof h === 'string' && /^0x[0-9a-f]+$/i.test(h) ? Number(BigInt(h)) : null);

// Resolve to the promise's value, or to `fallback` after ms; a rejection also gives the fallback.
export function withTimeout(promise, ms, fallback = null) {
  let timer;
  const t = new Promise((res) => { timer = setTimeout(() => res(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), t]).finally(() => clearTimeout(timer));
}

// Linear-interpolated quantile of an ascending array; null when empty.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// below p25 cheap, up to p60 normal, up to p90 busy, above p90 expensive
export function gasBand(gwei, ref) {
  if (!okGwei(gwei) || !ref || ![ref.p25, ref.p60, ref.p90].every(isNum)) return null;
  return gwei < ref.p25 ? 'cheap' : gwei <= ref.p60 ? 'normal' : gwei <= ref.p90 ? 'busy' : 'expensive';
}

// A restored history that isn't a list of [t, gwei, n] rows is dropped row by row, never trusted.
export function cleanHist(hist) {
  if (!Array.isArray(hist)) return [];
  const rows = hist.filter((r) => Array.isArray(r) && isNum(r[0]) && r[0] > 0 && r[0] % HOUR === 0 && okGwei(r[1]) && Number.isInteger(r[2]) && r[2] > 0);
  const byT = new Map(rows.map((r) => [r[0], [r[0], r[1], r[2]]]));
  return [...byT.values()].sort((a, b) => a[0] - b[0]);
}

// Add one pass's reading: merged into its hour as a running mean; rows older than keepDays are dropped.
// A missing reading adds nothing (the history is only trimmed).
export function addGasSample(hist, t, gwei, { keepDays = GAS_KEEP_DAYS } = {}) {
  const rows = cleanHist(hist);
  if (isNum(t) && okGwei(gwei)) {
    const h = Math.floor(t / HOUR) * HOUR, row = rows.find((r) => r[0] === h);
    if (row) { row[1] = sig((row[1] * row[2] + gwei) / (row[2] + 1), 5); row[2] += 1; }
    else rows.push([h, sig(gwei, 5), 1]);
    rows.sort((a, b) => a[0] - b[0]);
  }
  const end = isNum(t) ? t : rows.at(-1)?.[0] ?? 0;
  return rows.filter((r) => r[0] > end - keepDays * DAY);
}

export const histDays = (hist) => (hist.length ? Math.round(((hist.at(-1)[0] - hist[0][0] + HOUR) / DAY) * 10) / 10 : 0);

// The gauge: percentiles and band from the hourly history, else from recent blocks, else null.
export function gasStats(gwei, hist, blocks = null) {
  const h = cleanHist(hist);
  let values = null, basis = null;
  if (h.length >= GAS_MIN_BUCKETS) { values = h.map((r) => r[1]); basis = 'history'; }
  else if (Array.isArray(blocks) && blocks.filter(okGwei).length >= GAS_MIN_BLOCKS) { values = blocks.filter(okGwei); basis = 'blocks'; }
  const s = values ? [...values].sort((a, b) => a - b) : null;
  const q = (p) => (s ? sig(quantile(s, p)) : null);
  const ref = s ? { p25: quantile(s, 0.25), p60: quantile(s, 0.6), p90: quantile(s, 0.9) } : null;
  return { gwei: okGwei(gwei) ? sig(gwei) : null, p10: q(0.1), p50: q(0.5), p90: q(0.9), band: gasBand(gwei, ref), histDays: histDays(h), basis };
}

// eth_feeHistory(blocks, 'latest', [50]) → { gwei: next base fee + median recent tip, blocks: [base + tip per block] } | null
export function parseFeeHistory(fh) {
  const base = Array.isArray(fh?.baseFeePerGas) ? fh.baseFeePerGas.map(hexNum) : null;
  if (!base || base.length < 2 || base.some((x) => x == null)) return null;
  const n = base.length - 1; // the last entry is the next block's base fee
  const tips = Array.isArray(fh.reward) && fh.reward.length === n ? fh.reward.map((r) => (Array.isArray(r) ? hexNum(r[0]) : null)) : null;
  if (!tips || tips.some((x) => x == null)) return null;
  const recent = tips.slice(-TIP_BLOCKS).sort((a, b) => a - b);
  const gwei = (base[n] + quantile(recent, 0.5)) / 1e9;
  if (!okGwei(gwei)) return null;
  return { gwei, blocks: base.slice(0, n).map((b, i) => (b + tips[i]) / 1e9) };
}

// rpc: lib/rpc.mjs makeRpc (call → result or null). gasPriceWei: an eth_gasPrice reading the pass already has.
export async function readGas(rpc, { gasPriceWei = null, timeoutMs = 15000 } = {}) {
  const fh = async (n) => parseFeeHistory(await rpc.call('eth_feeHistory', ['0x' + n.toString(16), 'latest', [50]]));
  const run = async () => {
    const r = (await fh(1024)) ?? (await fh(100));
    if (r) return { ...r, source: 'feeHistory' };
    const wei = hexNum(gasPriceWei) ?? (isNum(gasPriceWei) ? gasPriceWei : hexNum(await rpc.call('eth_gasPrice', [])));
    const g = isNum(wei) ? wei / 1e9 : null;
    return okGwei(g) ? { gwei: g, blocks: null, source: 'gasPrice' } : null;
  };
  return withTimeout(run(), timeoutMs, null);
}

const nullPx = () => Object.fromEntries(Object.keys(COINS).map((s) => [s, { usd: null, ch24: null, src: null }]));
const okUsd = (x) => isNum(x) && x > 0;
const okCh = (x) => isNum(x) && x > -1 && x < 10; // a fraction; a 24 h move past these is junk

// DefiLlama prices/current + percentage → { SYM: { usd, ch24 } } (null where unread or stale)
export function parseLlama(cur, pct, { nowS = Date.now() / 1000 } = {}) {
  const out = {};
  for (const [s, id] of Object.entries(COINS)) {
    const c = cur?.coins?.[`coingecko:${id}`], p = pct?.coins?.[`coingecko:${id}`];
    const fresh = isNum(c?.timestamp) ? nowS - c.timestamp <= PRICE_MAX_AGE_S : true;
    out[s] = { usd: okUsd(c?.price) && fresh ? c.price : null, ch24: isNum(p) && okCh(p / 100) ? p / 100 : null };
  }
  return out;
}

// CoinGecko simple/price?ids=…&vs_currencies=usd&include_24hr_change=true → { SYM: { usd, ch24 } }
export function parseCoinGecko(j) {
  const out = {};
  for (const [s, id] of Object.entries(COINS)) {
    const c = j?.[id], ch = isNum(c?.usd_24h_change) ? c.usd_24h_change / 100 : null;
    out[s] = { usd: okUsd(c?.usd) ? c.usd : null, ch24: okCh(ch) ? ch : null };
  }
  return out;
}

// Coinbase: { data: { amount: "3000.1" } } spot, and { open, last } 24 h stats → { usd, ch24 } (null where unread)
export function parseCoinbase(spot, stats) {
  const usd = Number(spot?.data?.amount), o = Number(stats?.open), l = Number(stats?.last);
  const ch = o > 0 && l > 0 ? l / o - 1 : null;
  return { usd: typeof spot?.data?.amount === 'string' && okUsd(usd) ? usd : null, ch24: okCh(ch) ? ch : null };
}

// DefiLlama first; Coinbase for the coins it lacks (and for a missing 24 h change); CoinGecko for the coins both
// lack, within the daily budget. xcheck: also ask CoinGecko for the once-a-day agreement check; `both`/`agree`
// count coins where DefiLlama and CoinGecko both answered and agree within 2% (a cross-check, not a gate).
export async function readPrices(getJson, { key = null, timeoutMs = 15000, nowS = Date.now() / 1000, apis = null, xcheck = false } = {}) {
  const ids = Object.values(COINS).map((id) => `coingecko:${id}`).join(',');
  const get = (url, init) => withTimeout(getJson(url, init, timeoutMs), timeoutMs + Math.min(1000, timeoutMs), null);
  const plain = { headers: { accept: 'application/json' } };
  const [cur, pct] = await Promise.all([
    get(`https://coins.llama.fi/prices/current/${ids}?searchWidth=4h`, plain),
    get(`https://coins.llama.fi/percentage/${ids}?period=24h`, plain),
  ]);
  const ll = parseLlama(cur, pct, { nowS }), cb = {}, px = nullPx();
  const syms = Object.keys(COINS);
  await Promise.all(syms.filter((s) => ll[s].usd == null || ll[s].ch24 == null).map(async (s) => {
    const [spot, stats] = await Promise.all([
      ll[s].usd == null ? get(`https://api.coinbase.com/v2/prices/${s}-USD/spot`, plain) : null,
      get(`https://api.exchange.coinbase.com/products/${s}-USD/stats`, plain),
    ]);
    cb[s] = parseCoinbase(spot, stats);
  }));
  const lacking = syms.filter((s) => ll[s].usd == null && cb[s]?.usd == null);
  let gk = parseCoinGecko(null), cgAsked = false;
  if ((lacking.length || xcheck) && (!apis || apis.allow('coingecko'))) {
    cgAsked = true;
    const headers = { accept: 'application/json', ...(key ? { 'x-cg-demo-api-key': key } : {}) };
    gk = parseCoinGecko(await get(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(COINS).join(',')}&vs_currencies=usd&include_24hr_change=true`, { headers }));
  }
  let agree = 0, both = 0;
  for (const s of syms) {
    const a = ll[s], c = cb[s] || { usd: null, ch24: null }, b = gk[s];
    if (a.usd != null && b.usd != null) { both++; if (Math.abs(a.usd / b.usd - 1) <= 0.02) agree++; }
    const src = a.usd != null ? 'defillama' : c.usd != null ? 'coinbase' : b.usd != null ? 'coingecko' : null;
    const usd = src === 'defillama' ? a.usd : src === 'coinbase' ? c.usd : src === 'coingecko' ? b.usd : null;
    const ch24 = usd == null ? null : src === 'coingecko' ? b.ch24 ?? a.ch24 ?? c.ch24 : src === 'coinbase' ? c.ch24 ?? b.ch24 : a.ch24 ?? c.ch24 ?? b.ch24;
    px[s] = { usd: sig(usd, 6), ch24: sig(ch24, 4), src };
  }
  return { px, read: Object.values(px).filter((x) => x.usd != null).length, both, agree, cgAsked };
}

// The whole block. prev: the previous live.json's market (for the carried history). Never throws:
// gas and prices fail separately to nulls; the history is carried even when this pass reads nothing.
// market.xcheck = { day, both, agree }: the last daily agreement check (carried; asked again on a new UTC day,
// once, whatever it answers).
export async function marketBlock({ rpc, getJson, prev = null, now = Date.now(), key = null, gasPriceWei = null, timeoutMs = 15000, apis = null }) {
  const hist0 = cleanHist(prev?.gas?.hist), today = new Date(now).toISOString().slice(0, 10);
  const xc0 = prev?.xcheck && typeof prev.xcheck.day === 'string' ? prev.xcheck : null, due = xc0?.day !== today;
  const [gas, prices] = await Promise.all([
    rpc ? readGas(rpc, { gasPriceWei, timeoutMs }).catch(() => null) : null,
    getJson ? withTimeout(readPrices(getJson, { key, timeoutMs, nowS: now / 1000, apis, xcheck: due }), 3 * timeoutMs + 2000, null) : null,
  ]);
  const xcheck = due && prices?.cgAsked ? { day: today, both: prices.both, agree: prices.agree } : xc0;
  const hist = addGasSample(hist0, now, gas?.gwei ?? null);
  const stats = gasStats(gas?.gwei ?? null, hist, gas?.blocks ?? null);
  return {
    market: { t: now, gas: { ...stats, source: gas?.source ?? null, hist }, px: prices?.px ?? nullPx(), xcheck },
    log: { gas: gas?.source ?? null, read: prices?.read ?? 0, both: prices?.both ?? 0, agree: prices?.agree ?? 0, xcheck: due && !!prices?.cgAsked },
  };
}

// What a pass writes if marketBlock itself broke: the carried history, every reading null.
export function carryMarket(prev, now = Date.now()) {
  const hist = addGasSample(prev?.gas?.hist, now, null);
  return { t: now, gas: { ...gasStats(null, hist), source: null, hist }, px: nullPx(), xcheck: prev?.xcheck ?? null };
}
