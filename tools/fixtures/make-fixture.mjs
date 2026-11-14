#!/usr/bin/env node
// Made-up dashboard data: internally consistent, shaped exactly per docs/DATA.md, and sealed with a
// dummy passphrase through lib/lock.mjs. Fictional tickers, except the UNI/WETH 0.3% benchmark.
// Nothing here is real: every pool, price, address and amount comes from a seeded random generator.
//
//   node tools/fixtures/make-fixture.mjs [outDir]        (default tools/fixtures/out, git-ignored)
//
// One folder per case, each with lock.json and the sealed files the page reads:
//   default  every panel filled; young, unverified, not-checked, hooked and unread pools; a fresh pool
//            with only 24h/7d windows; two planted faults (an unverified pool carrying a gem score, and
//            a ticker that is HTML) that the page must refuse
//   amber    the default data, 20 minutes old
//   stale    the default data, 3.2 hours old
//   nogems   no pool reaches the gem bar in any window; no backtests yet
//   nofiles  lock.json and live.json only (history and backtest not published yet)
//   rekeyed  live.json sealed under another passphrase than lock.json (the page must show nothing)
//   nomarket the default data, but the top strip's gas, one price, one 24 h change, the next pass and the watchdog's
//            last restart unread (null, never 0): the page must show dashes
//   olddepth the default data as older scanners published it: a third of the pools without depthEdges and the full-range
//            layer (depthStep and depthSpan only), a third with ±45% fine bars and nothing else (the first contract)
//   nodisc   the default data as scanners before the discovery lanes published it: no discovery, dex, cex or flow, and
//            no cexled or retail lens (the page must hide the Discovery card and show no error)
//   oddlanes the default data with odd discovery lanes: new pools [], exchange-led holding only an id that is no pool,
//            cross-chain [], retailUp missing (the page reads "none this pass", skips the id, dashes the missing lane)
//   long     the default data at its widest: long tickers, billion-dollar pools, five-digit APRs, four-digit gas,
//            six-figure prices (real names and numbers run longer than the fixtures: the overlap audit reads this case)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newLockFile, unlock, seal, ITERATIONS } from '../../lib/lock.mjs';

export const FIXTURE_PASSPHRASE = 'made-up fixture passphrase';
export const CASES = ['default', 'amber', 'stale', 'nogems', 'nofiles', 'rekeyed', 'nomarket', 'long', 'olddepth', 'nodisc', 'oddlanes'];
export const PLANTED = { unverifiedGem: 'TALI/WETH', htmlTicker: '<img src=x onerror="window.__xss=1">' };

const H = 3600e3, D = 24 * H;
const WINDOWS = ['24h', '7d', '30d'];
const SPAN = { '24h': 1, '7d': 7, '30d': 30 };
const TICKET = 1000; // the owner scores every pool at $1,000
const GEM_AT = 60;
const DEFAULT_WINDOW = '24h'; // the owner's default view
// the 30-day daily story of four heroes; every other pool gets a quiet random one
const PATTERN = { VELNA: 'steady', KOVA: 'bursty', NUMA: 'emerging', BOJA: 'one-off', ORVO: 'zero' }; // zero: not a dollar of fees in 30 days
const CHAIN_GAS = { ethereum: 4.1, base: 0.08 };

// ---------- seeded randomness ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const between = (r, a, b) => a + (b - a) * r();
const logBetween = (r, a, b) => Math.exp(between(r, Math.log(a), Math.log(b)));
const hex = (r, n) => { let s = '0x'; for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16); return s; };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const sig = (x, n = 6) => (isNum(x) ? Number(x.toPrecision(n)) : x);
const cents = (x) => Math.round(x * 100) / 100 || 0;

// ---------- mirrors lib/economics.mjs and lib/gem.mjs (inline, so fixtures don't move with the scanner) ----------
const conc = (r) => 1 / (1 - Math.exp(-r / 2));
const suggestRange = (sigma, minDays) => Math.max(0.01, Math.round(sigma * Math.sqrt(minDays) * 100) / 100);
const swapCostPer = (fee) => 0.5 * (Math.min(fee, 0.003) + 0.0005);

function gemOf({ stranded, net, persistence, flow, warnings, blocked }) {
  if (blocked) return { total: null, stranded: null, yield: null, persistence: null, flow: null, warnings, missing: [] };
  const inputs = { stranded, net, persistence, flow };
  const missing = Object.entries(inputs).filter(([, v]) => !isNum(v)).map(([k]) => k);
  const parts = {
    stranded: isNum(stranded) ? Math.round(25 * clamp((stranded - 0.8) / 0.15)) : null,
    yield: isNum(net) ? Math.round(35 * clamp(net / 0.5)) : null,
    persistence: isNum(persistence) ? Math.round(25 * clamp(persistence)) : null,
    flow: isNum(flow) ? Math.round(15 * clamp(flow)) : null,
  };
  const total = missing.length ? null
    : Math.max(0, parts.stranded + parts.yield + parts.persistence + parts.flow - 10 * warnings.length);
  return { total, ...parts, warnings, missing };
}

// ---------- the pool list ----------
// Heroes are hand-set so every panel has something to show; the rest are random.
const HEROES = [
  // 30-day best: a stranded book, three LPs at the price
  { base: 'VELNA', quote: 'WETH', chain: 'base', v: 3, fee: 0.003, shape: 'stranded', tvl: 2.9e6, inside9: 116e3, lps: 3,
    sigma: 0.034, volDay: 184e3, ageDays: 412, pairAgeDays: 412, persistence: 0.82, markout: 0.22, traders7d: 160, usd: 0.85,
    vmul: { '24h': 0.45, '7d': 0.78, '30d': 1 }, smul: { '24h': 1.3, '7d': 1.05, '30d': 1 }, firstGemAgoH: 3.5 },
  // young pool, best over 7 days
  { base: 'MIRRA', quote: 'USDC', chain: 'base', v: 3, fee: 0.01, shape: 'stranded', tvl: 1.1e6, inside9: 52e3, lps: 4,
    sigma: 0.036, volDay: 30e3, ageDays: 18, pairAgeDays: 380, persistence: 0.7, markout: 0.3, traders7d: 90, usd: 0.042,
    vmul: { '24h': 0.8, '7d': 2.3, '30d': 1 }, smul: { '24h': 1, '7d': 0.9, '30d': 1 }, firstGemAgoH: 30 },
  { base: 'NUMA', quote: 'USDC', chain: 'base', v: 4, fee: 0.003, shape: 'stranded', tvl: 4.2e6, inside9: 260e3, lps: 6,
    sigma: 0.028, volDay: 300e3, ageDays: 140, pairAgeDays: 600, persistence: 0.75, markout: 0.35, traders7d: 220, usd: 1.92,
    vmul: { '24h': 1.6, '7d': 1.25, '30d': 1 }, smul: { '24h': 0.9, '7d': 1, '30d': 1 }, firstGemAgoH: 1.2, verified: null },
  { base: 'QUARX', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.01, shape: 'stranded', tvl: 6.5e6, inside9: 410e3, lps: 9,
    sigma: 0.031, volDay: 98e3, ageDays: 300, pairAgeDays: 900, persistence: 0.6, markout: 0.4, traders7d: 120, usd: 12.4,
    vmul: { '24h': 1.6, '7d': 1.2, '30d': 1 }, smul: { '24h': 1.1, '7d': 1, '30d': 1 }, firstGemAgoH: 70 },
  { base: 'KOVA', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.003, shape: 'one-sided', tvl: 3.3e6, inside9: 90e3, lps: 5,
    sigma: 0.03, volDay: 160e3, ageDays: 520, pairAgeDays: 520, persistence: 0.55, markout: 0.3, traders7d: 80, usd: 0.31,
    vmul: { '24h': 0.6, '7d': 1.4, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'FENX', quote: 'WETH', chain: 'ethereum', v: 4, fee: 0.003, shape: 'mixed', tvl: 2.2e6, inside9: 420e3, lps: 12,
    sigma: 0.026, volDay: 380e3, ageDays: 75, pairAgeDays: 700, persistence: 0.5, markout: 0.45, traders7d: 140, usd: 3.1,
    hooks: true, vmul: { '24h': 1.3, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'SELT', quote: 'USDC', chain: 'base', v: 3, fee: 0.0005, shape: 'mixed', tvl: 8.8e6, inside9: 2.4e6, lps: 31,
    sigma: 0.012, volDay: 6.2e6, ageDays: 260, pairAgeDays: 260, persistence: 0.45, markout: 0.5, traders7d: 400, usd: 0.998,
    vmul: { '24h': 0.9, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'ORVO', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.01, shape: 'stranded', tvl: 1.6e6, inside9: 70e3, lps: 2,
    sigma: 0.05, volDay: 24e3, ageDays: 210, pairAgeDays: 210, persistence: 0.65, markout: 0.78, traders7d: 40, usd: 0.0071,
    bigmove: true, vmul: { '24h': 2.1, '7d': 1.3, '30d': 1 }, smul: { '24h': 1.4, '7d': 1.2, '30d': 1 } },
  // planted fault: unverified, yet the data carries a gem score; the page must never call it a gem
  { base: 'TALI', quote: 'WETH', chain: 'base', v: 4, fee: 0.003, shape: 'stranded', tvl: 1.9e6, inside9: 80e3, lps: 3,
    sigma: 0.03, volDay: 150e3, ageDays: 95, pairAgeDays: 400, persistence: 0.8, markout: 0.3, traders7d: 100, usd: 0.55,
    hooks: true, dynamicFee: true, verified: false, plantedGem: 95,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'DRUM', quote: 'USDC', chain: 'ethereum', v: 4, fee: 0.01, shape: 'mixed', tvl: 900e3, inside9: 200e3, lps: 7,
    sigma: 0.04, volDay: 30e3, ageDays: 60, pairAgeDays: 300, persistence: 0.4, markout: 0.5, traders7d: 50, usd: 0.12,
    hooks: true, verified: false, vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  // fresh pool: 5 days old, so only the 24h and 7d windows exist
  { base: 'PRAXO', quote: 'USDC', chain: 'base', v: 3, fee: 0.01, shape: 'stranded', tvl: 700e3, inside9: 30e3, lps: 2,
    sigma: 0.05, volDay: 30e3, ageDays: 5, pairAgeDays: 240, persistence: 0.7, markout: 0.3, traders7d: 70, usd: 0.0185,
    vmul: { '24h': 2.6, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 }, firstGemAgoH: 5 },
  // planted fault: a ticker that is HTML; the page must print it as text
  { base: PLANTED.htmlTicker, quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.003, shape: 'served', tvl: 1.2e6, inside9: 800e3,
    lps: 20, sigma: 0.03, volDay: 300e3, ageDays: 40, pairAgeDays: 40, persistence: 0.3, markout: 0.4, traders7d: 60, usd: 0.2,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  // unread values: an unpriced token, an unread map, an unread protocol cut, an unread volatility
  { base: 'ZINTH', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.003, shape: 'mixed', tvl: 1.5e6, inside9: 300e3, lps: 8,
    sigma: 0.03, volDay: 90e3, ageDays: 150, pairAgeDays: 150, persistence: 0.5, markout: 0.4, traders7d: 60, usd: null,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'LOMA', quote: 'USDC', chain: 'base', v: 3, fee: 0.003, shape: 'mixed', tvl: 2.1e6, inside9: 500e3, lps: null,
    sigma: 0.03, volDay: 120e3, ageDays: 330, pairAgeDays: 330, persistence: 0.5, markout: 0.4, traders7d: 60, usd: 0.77,
    mapUnread: true, vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'BRISK', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.003, shape: 'stranded', tvl: 2.4e6, inside9: 140e3, lps: 4,
    sigma: 0.035, volDay: 110e3, ageDays: 280, pairAgeDays: 280, persistence: 0.7, markout: 0.3, traders7d: 90, usd: 1.4,
    lpKeeps: null, vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'CALDO', quote: 'USDC', chain: 'base', v: 3, fee: 0.003, shape: 'served', tvl: 1.3e6, inside9: 900e3, lps: 15,
    sigma: null, volDay: 200e3, ageDays: 90, pairAgeDays: 90, persistence: 0.3, markout: 0.4, traders7d: 60, usd: 0.09,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  // a calm pair and an off-market pool
  { base: 'SOLVA', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.0005, shape: 'served', tvl: 22e6, inside9: 20e6, lps: 25,
    sigma: 0.003, volDay: 4e6, ageDays: 700, pairAgeDays: 700, persistence: 0.2, markout: 0.3, traders7d: 300, usd: 3550,
    vmul: { '24h': 1.1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  { base: 'OBRA', quote: 'USDC', chain: 'base', v: 3, fee: 0.01, shape: 'stranded', tvl: 600e3, inside9: 40e3, lps: 2,
    sigma: 0.06, volDay: 15e3, ageDays: 120, pairAgeDays: 120, persistence: 0.5, markout: 0.5, traders7d: 30, usd: 0.33,
    offMarket: true, vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
  // the benchmark
  { base: 'UNI', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.003, shape: 'served', tvl: 38e6, inside9: 19e6, lps: 140,
    sigma: 0.02, volDay: 11.5e6, ageDays: 2000, pairAgeDays: 2200, persistence: 0.1, markout: 0.55, traders7d: 2500, usd: 7.4,
    bench: true, vmul: { '24h': 0.8, '7d': 1.1, '30d': 1 }, smul: { '24h': 1.2, '7d': 1, '30d': 1 } },
];

// More pools of the VELNA/WETH pair (one quoted in native ETH, which is the same pair), for the pair view.
// They come last so every pool before them keeps its random draws.
const PAIR_EXTRAS = [
  { base: 'VELNA', quote: 'WETH', chain: 'base', v: 3, fee: 0.01, shape: 'mixed', tvl: 640e3, inside9: 150e3, lps: 6,
    sigma: 0.034, volDay: 26e3, ageDays: 300, pairAgeDays: 412, persistence: 0.2, markout: 0.35, traders7d: 60, usd: 0.85,
    vmul: { '24h': 1.4, '7d': 1.1, '30d': 1 }, smul: { '24h': 1.3, '7d': 1.05, '30d': 1 } },
  { base: 'VELNA', quote: 'ETH', chain: 'base', v: 4, fee: 0.003, shape: 'served', tvl: 1.4e6, inside9: 900e3, lps: 14,
    sigma: 0.034, volDay: 1.5e6, ageDays: 120, pairAgeDays: 412, persistence: 0.15, markout: 0.5, traders7d: 300, usd: 0.85,
    hooks: true, verified: false, vmul: { '24h': 0.7, '7d': 1.2, '30d': 1 }, smul: { '24h': 1.3, '7d': 1.05, '30d': 1 } },
  { base: 'VELNA', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.003, shape: 'served', tvl: 3.6e6, inside9: 2.2e6, lps: 22,
    sigma: 0.034, volDay: 420e3, ageDays: 380, pairAgeDays: 412, persistence: 0.2, markout: 0.45, traders7d: 200, usd: 0.85,
    vmul: { '24h': 1.6, '7d': 0.9, '30d': 1 }, smul: { '24h': 1.3, '7d': 1.05, '30d': 1 } },
];

// More pools for the stablecoin-pairs switch: a second NUMA/USDC pool (a pair view of a starred stablecoin pair hides the
// other), and TOVI/MUNT, whose quote token is a stablecoin by its address only. Last too, so no earlier draw moves.
export const STABLE_PROBE_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC on Base
const STABLE_EXTRAS = [
  { base: 'NUMA', quote: 'USDC', chain: 'base', v: 3, fee: 0.0005, shape: 'served', tvl: 2.6e6, inside9: 1.5e6, lps: 19,
    sigma: 0.028, volDay: 900e3, ageDays: 210, pairAgeDays: 600, persistence: 0.3, markout: 0.45, traders7d: 180, usd: 1.92,
    vmul: { '24h': 1.2, '7d': 1, '30d': 1 }, smul: { '24h': 0.9, '7d': 1, '30d': 1 } },
  { base: 'TOVI', quote: 'MUNT', chain: 'base', v: 3, fee: 0.003, shape: 'mixed', tvl: 1.7e6, inside9: 420e3, lps: 9,
    sigma: 0.03, volDay: 140e3, ageDays: 160, pairAgeDays: 160, persistence: 0.5, markout: 0.4, traders7d: 70, usd: 0.64,
    vmul: { '24h': 1.1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 } },
];

// Pools under 72 hours old (the discovery lanes' "new pools"): three with 20 or more distinct senders in the day, one with
// too few (never listed), and a stablecoin pair (hidden while the switch is off). Their own random stream.
const NEW_EXTRAS = [
  { base: 'NOVU', quote: 'WETH', chain: 'ethereum', v: 3, fee: 0.01, shape: 'served', tvl: 380e3, inside9: 260e3, lps: 7,
    sigma: 0.07, volDay: 410e3, ageDays: 31 / 24, pairAgeDays: 31 / 24, persistence: 0.2, markout: 0.45, traders7d: 64, usd: 0.012,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 }, senders: 64, retail: 0.71 },
  { base: 'DEFRA', quote: 'USDC', chain: 'base', v: 3, fee: 0.003, shape: 'mixed', tvl: 120e3, inside9: 50e3, lps: 4,
    sigma: 0.06, volDay: 95e3, ageDays: 9 / 24 + 0.05, pairAgeDays: 9 / 24 + 0.05, persistence: 0.2, markout: 0.5, traders7d: 26, usd: 0.4,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 }, senders: 26, verified: null },
  { base: 'PIKOLA', quote: 'WETH', chain: 'base', v: 3, fee: 0.0025, shape: 'served', tvl: 210e3, inside9: 150e3, lps: 5, dex: 'pancakeswap',
    sigma: 0.08, volDay: 160e3, ageDays: 2.6, pairAgeDays: 2.6, persistence: 0.2, markout: 0.55, traders7d: 41, usd: 0.0031,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 }, senders: 41 },
  { base: 'QUILO', quote: 'WETH', chain: 'ethereum', v: 4, fee: 0.003, shape: 'mixed', tvl: 60e3, inside9: 30e3, lps: 2,
    sigma: 0.09, volDay: 20e3, ageDays: 0.8, pairAgeDays: 0.8, persistence: 0.2, markout: 0.6, traders7d: 8, usd: 0.05,
    vmul: { '24h': 1, '7d': 1, '30d': 1 }, smul: { '24h': 1, '7d': 1, '30d': 1 }, senders: 8 },
];
const NEW_POOL_MS = 72 * H, NEW_POOL_SENDERS = 20, BLOCKS_DAY = { ethereum: 7200, base: 43200 };

// docs/DATA.md: pool.dex, pool.cex (the exchange screen), Window.flow (lib/flowq.mjs) and the cexled / retail lenses
function addLanes(r, pools, now) {
  const order = [...pools].filter((p) => p.tvlUsd != null).sort((a, b) => b.tvlUsd - a.tvlUsd);
  const coins = new Set(order.map((p) => p.t0.sym).slice(0, 40));
  for (const p of pools) {
    const s = p._spec, u = [r(), r(), r(), r(), r()]; // drawn for every pool: the stream never shifts
    p.dex = s.dex || (p.chain === 'base' && p.v === 3 && u[0] < 0.3 ? 'pancakeswap' : 'uniswap');
    const sd = p.w['24h'] && p.w['24h'].sigma, bpd = BLOCKS_DAY[p.chain] || 7200;
    const tvs = isNum(sd) && sd > 0 ? sig(p.feeTier / (sd / Math.sqrt(bpd)), 3) : null;
    const hasCoin = coins.has(p.t0.sym) && u[1] < 0.55;
    const ratio = hasCoin ? sig(Math.exp(Math.log(0.4) + u[2] * Math.log(120 / 0.4)), 3) : null;
    p.cex = { cexVol24: hasCoin ? Math.round(ratio * Math.max(1e4, p.shape.band9 ? p.tvlUsd * p.shape.band9 : p.tvlUsd * 0.2)) : null,
      cexRatio: ratio, tierVsSigma: tvs, t: hasCoin ? Math.round(now - (1 + 40 * u[3]) * H) : null, coin: hasCoin ? p.t0.sym.toLowerCase() : null };
    p.flowDaily = [];
    for (const wk of WINDOWS) {
      const w = p.w[wk];
      if (!w) continue;
      const v = [r(), r(), r(), r(), r()];
      const base = s.retail != null ? s.retail : 0.05 + 0.75 * Math.pow(u[4], 1.6);
      w.flow = {
        retailShare: v[1] < 0.08 ? null : sig(Math.min(0.98, base + (wk === '24h' ? 0.16 * (v[2] - 0.3) : 0.03 * (v[2] - 0.5))), 3),
        driftCorr: v[3] < 0.12 ? null : sig(-0.5 + 1.3 * v[2], 3),
        routing: v[4] < 0.12 ? null : sig(0.15 + 0.8 * v[4], 3),
        senders: wk !== '24h' ? null : s.senders != null ? s.senders : v[1] < 0.15 ? null : Math.max(1, Math.round((w.traders || 10) * (0.6 + 0.5 * v[0]))),
      };
    }
    const cexled = isNum(p.cex.cexRatio) && p.cex.cexRatio >= 10 && isNum(p.cex.tierVsSigma) && p.cex.tierVsSigma >= 2;
    for (const [i, wk] of WINDOWS.entries()) {
      const w = p.w[wk];
      if (!w) continue;
      if (cexled) w.lenses.push('cexled');
      const rs = w.flow.retailShare, nx = WINDOWS[i + 1] && p.w[WINDOWS[i + 1]], rn = nx && nx.flow ? nx.flow.retailShare : null;
      if (isNum(rs) && (rs >= 0.6 || (isNum(rn) && rs >= rn + 0.1))) w.lenses.push('retail');
    }
  }
}
function discoveryOf(pools, now) {
  const w24 = (p) => p.w['24h'];
  return {
    newPools: pools.filter((p) => p.createdAt > now - NEW_POOL_MS && (w24(p)?.flow?.senders ?? 0) >= NEW_POOL_SENDERS)
      .sort((a, b) => (w24(b)?.volUsd ?? 0) - (w24(a)?.volUsd ?? 0)).map((p) => p.id),
    cexLed: pools.filter((p) => w24(p)?.lenses.includes('cexled')).sort((a, b) => b.cex.cexRatio - a.cex.cexRatio).map((p) => p.id),
    crossChain: [],
    retailUp: pools.filter((p) => w24(p)?.lenses.includes('retail')).sort((a, b) => (w24(b).flow.retailShare ?? 0) - (w24(a).flow.retailShare ?? 0)).map((p) => p.id),
  };
}

const SYL = ['AR', 'BO', 'CU', 'DA', 'EL', 'FI', 'GO', 'HU', 'IX', 'JA', 'KE', 'LU', 'MO', 'NI', 'OR', 'PA', 'QI', 'RU',
  'SA', 'TE', 'UL', 'VO', 'WI', 'XA', 'YO', 'ZE'];

function makeRandomSpecs(r, n, taken) {
  const out = [];
  while (out.length < n) {
    const base = SYL[Math.floor(r() * SYL.length)] + SYL[Math.floor(r() * SYL.length)] + (r() < 0.4 ? 'X' : '');
    const quote = r() < 0.6 ? 'WETH' : 'USDC';
    const key = base + '/' + quote;
    if (taken.has(key)) continue;
    taken.add(key);
    const u = r();
    const shape = u < 0.5 ? 'served' : u < 0.8 ? 'mixed' : u < 0.92 ? 'stranded' : 'one-sided';
    const tvl = logBetween(r, 3e5, 3e7);
    const insideShare = { served: between(r, 0.5, 0.8), mixed: between(r, 0.2, 0.45), stranded: between(r, 0.03, 0.12), 'one-sided': between(r, 0.01, 0.06) }[shape];
    const v = r() < 0.75 ? 3 : 4;
    const ageDays = r() < 0.12 ? between(r, 8, 29) : between(r, 30, 900);
    out.push({
      base, quote, chain: r() < 0.62 ? 'ethereum' : 'base', v,
      fee: [0.0005, 0.003, 0.003, 0.01][Math.floor(r() * 4)], shape, tvl, inside9: tvl * insideShare,
      lps: Math.round(between(r, 2, 60)), sigma: between(r, 0.008, 0.07),
      volDay: tvl * ({ served: logBetween(r, 0.02, 0.5), mixed: logBetween(r, 0.01, 0.2) }[shape] ?? logBetween(r, 0.004, 0.04)),
      ageDays, pairAgeDays: ageDays + (r() < 0.5 ? 0 : between(r, 0, 600)), persistence: between(r, 0.1, 0.8),
      markout: between(r, 0.1, 0.9), traders7d: Math.round(logBetween(r, 5, 900)), usd: logBetween(r, 0.002, 40),
      hooks: v === 4 && r() < 0.3, dynamicFee: v === 4 && r() < 0.15, verified: v === 4 && r() < 0.15 ? false : r() < 0.08 ? null : true,
      bigmove: r() < 0.08,
      vmul: { '24h': logBetween(r, 0.4, 2.2), '7d': logBetween(r, 0.7, 1.4), '30d': 1 },
      smul: { '24h': between(r, 0.7, 1.4), '7d': between(r, 0.85, 1.15), '30d': 1 },
    });
  }
  return out;
}

// ---------- the liquidity shape ----------
const BIN = 0.02, BINS = 22; // offsets -0.44 .. +0.44
function makeDepth(r, spec, depthTotal) {
  const offs = [];
  for (let k = -BINS; k <= BINS; k++) offs.push(+(k * BIN).toFixed(2));
  const inside = (o) => Math.abs(o) <= 0.09 + 1e-9;
  const g = (o, m, s) => Math.exp(-0.5 * ((o - m) / s) ** 2);
  const inW = offs.map((o) => (inside(o) ? (spec.shape === 'served' ? g(o, 0, 0.05) : 0.6 + 0.8 * r()) : 0));
  let outW;
  const below = -between(r, 0.16, 0.3), above = between(r, 0.14, 0.28);
  if (spec.shape === 'stranded') outW = offs.map((o) => (inside(o) ? 0 : 0.55 * g(o, below, 0.07) + 0.45 * g(o, above, 0.06) + 0.01));
  else if (spec.shape === 'one-sided') outW = offs.map((o) => (inside(o) || o < 0 ? 0 : g(o, above, 0.07) + 0.005));
  else if (spec.shape === 'mixed') outW = offs.map((o) => (inside(o) ? 0 : (r() < 0.5 ? 0.7 : 0.2) * g(o, below, 0.06) + g(o, 0, 0.12) * 0.5 + 0.01));
  else outW = offs.map((o) => (inside(o) ? 0 : g(o, 0, 0.1) + 0.01));
  const sIn = inW.reduce((a, b) => a + b, 0), sOut = outW.reduce((a, b) => a + b, 0);
  const inUsd = Math.min(spec.inside9, depthTotal * 0.98), outUsd = depthTotal - inUsd;
  return offs.map((o, i) => [o, Math.round(inside(o) ? (inW[i] / sIn) * inUsd : (outW[i] / sOut) * outUsd)]);
}
const insideValue = (depth, rr) => depth.reduce((a, [o, v]) => a + (Math.abs(o) <= rr + 1e-9 ? v : 0), 0);

function shapeOf(r, spec, tvl, mapUsd) {
  if (spec.mapUnread || mapUsd == null) {
    return { tag: 'mixed', parked: null, above: null, band9: null, lpsAtPrice: null, depth: [], walls: { below: null, above: null } };
  }
  const depth = makeDepth(r, spec, mapUsd * 0.95);
  const band9 = insideValue(depth, 0.09) / tvl;
  const parked = 1 - band9;
  const up = depth.reduce((a, [o, v]) => a + (o > 0.09 + 1e-9 ? v : 0), 0);
  const away = depth.reduce((a, [o, v]) => a + (Math.abs(o) > 0.09 + 1e-9 ? v : 0), 0);
  const above = away > 0 ? up / away : null;
  const tag = parked >= 0.8 ? (above != null && (above > 0.92 || above < 0.08) ? 'one-sided' : 'stranded') : parked < 0.5 ? 'served' : 'mixed';
  const med = [...depth.map((d) => d[1])].sort((a, b) => a - b)[Math.floor(depth.length / 2)];
  const wall = (side) => {
    const cand = depth.filter(([o]) => (side < 0 ? o < -0.09 : o > 0.09));
    const top = cand.reduce((a, b) => (b[1] > a[1] ? b : a), [null, -1]);
    return top[0] != null && top[1] > 3 * Math.max(1, med) ? top[0] : null;
  };
  return { tag, parked: sig(parked, 4), above: sig(above, 4), band9: sig(band9, 4), lpsAtPrice: spec.lps ?? null, depth, walls: { below: wall(-1), above: wall(1) } };
}

// ---------- one window ----------
function makeWindow(r, spec, pool, wk, opts) {
  const span = SPAN[wk];
  if (spec.ageDays < span / 3) return null; // too young to say anything about this window
  const days = Math.min(span, +spec.ageDays.toFixed(2));
  const partial = days < span;
  const volUsd = spec.volDay * spec.vmul[wk] * (opts.volScale || 1) * days;
  const sigma = spec.sigma == null ? null : spec.sigma * spec.smul[wk];
  const range = sigma == null ? null : suggestRange(sigma, 7);
  const inRangeUsd = range == null || !pool.shape.depth.length ? null : insideValue(pool.shape.depth, range);
  const keep = pool.lpKeeps;
  const lpFeesUsd = keep == null ? null : volUsd * spec.fee * keep;
  const protocolFeesUsd = keep == null ? null : volUsd * spec.fee * (1 - keep);
  const feeApr = lpFeesUsd == null || inRangeUsd == null ? null : (365 * (lpFeesUsd / days)) / (inRangeUsd + TICKET);
  const lvr = range == null ? null : ((365 * sigma * sigma) / 8) * conc(range);
  const perYear = range == null ? null : (365 * sigma * sigma) / (range * range);
  const swapCost = perYear == null ? null : perYear * swapCostPer(spec.fee);
  const gas = perYear == null ? null : (perYear * CHAIN_GAS[spec.chain]) / TICKET;
  const net = [feeApr, lvr, swapCost, gas].every(isNum) ? feeApr - lvr - swapCost - gas : null;
  const edge = isNum(feeApr) && lvr ? feeApr / lvr : null;
  const aggApr = lpFeesUsd != null && pool.tvlUsd ? (365 * (lpFeesUsd / days)) / pool.tvlUsd : null;
  const parkedAvg = pool.shape.parked == null ? null : clamp(pool.shape.parked + between(r, -0.02, 0.01));
  const strandedShare = parkedAvg;
  const markout = clamp(spec.markout * between(r, 0.85, 1.15), 0, 2);
  const traders = Math.max(1, Math.round((spec.traders7d * Math.min(days, 7)) / 7 * (days > 7 ? 1.8 : 1)));
  const swaps = Math.max(1, Math.round(volUsd / between(r, 800, 4000)));

  const warnings = [];
  if (spec.hooks) warnings.push('hook: unreviewed contract');
  if (spec.dynamicFee) warnings.push('dynamic fee');
  if (pool.offMarket) warnings.push('price off market');
  const persistence = spec.persistence * (opts.persistScale || 1);
  const flow = 0.7 * clamp(1 - markout) + 0.3 * clamp(Math.log10(Math.max(1, spec.traders7d)) / 2);
  let gem;
  if (pool.verified === false) {
    gem = gemOf({ warnings: ['unverified: swaps can’t be checked against the fee counters', ...warnings], blocked: true });
    if (spec.plantedGem && !opts.noPlant) gem = { ...gem, total: spec.plantedGem }; // planted fault
  } else {
    gem = gemOf({ stranded: strandedShare, net, persistence, flow, warnings });
  }

  const lenses = [];
  if (isNum(strandedShare) && strandedShare >= 0.8 && pool.shape.tag !== 'one-sided') lenses.push('stranded');
  if (pool.shape.tag === 'one-sided') lenses.push('one-sided');
  if (spec.ageDays <= 30 && spec.pairAgeDays >= 180) lenses.push('fresh');
  if (spec.bigmove) lenses.push('bigmove');
  if (isNum(sigma) && sigma <= 0.005) lenses.push('calm');
  if (markout > 0.6) lenses.push('toxic');

  // sparklines, about 24 points each, ending at the current price
  const px = [];
  let lp = 0;
  const step = (sigma ?? 0.02) * Math.sqrt(days / 24);
  for (let i = 0; i < 24; i++) { px.unshift(pool.price * Math.exp(lp)); lp += step * gauss(r); }
  const fees = lpFeesUsd == null ? [] : Array.from({ length: 24 }, () => sig((lpFeesUsd / 24) * between(r, 0.4, 1.6), 4));

  return {
    days, partial, volUsd: Math.round(volUsd), lpFeesUsd: lpFeesUsd == null ? null : sig(lpFeesUsd, 6),
    protocolFeesUsd: protocolFeesUsd == null ? null : sig(protocolFeesUsd, 6), swaps, traders,
    sigma: sig(sigma, 4), range, rerangeDays: perYear ? sig(365 / perYear, 4) : null, inRangeUsd: inRangeUsd == null ? null : Math.round(inRangeUsd),
    feeApr: sig(feeApr, 5), lvr: sig(lvr, 5), swapCost: sig(swapCost, 5), gas: sig(gas, 5), net: sig(net, 5), edge: sig(edge, 4),
    aggApr: sig(aggApr, 4), parkedAvg: sig(parkedAvg, 4), strandedShare: sig(strandedShare, 4), markout: sig(markout, 3),
    gem, lenses, spark: { px: px.map((x) => sig(x, 6)), fees },
  };
}

// ---------- the whole pass ----------
export function makeData({ now = Date.now(), seed = 7, mode = 'default' } = {}) {
  const r = rng(seed);
  const opts = mode === 'nogems' ? { volScale: 0.3, persistScale: 0.3, noPlant: true } : {};
  const quotes = {
    WETH: { sym: 'WETH', addr: hex(r, 40), dec: 18, usd: 3400 },
    USDC: { sym: 'USDC', addr: hex(r, 40), dec: 6, usd: 1 },
  };
  quotes.ETH = { sym: 'ETH', addr: '0x' + '0'.repeat(40), dec: 18, usd: 3400 }; // native ETH (v4), the same pair as WETH
  // a ticker that says nothing, at the real address of USDC on Base (public): only the page's address list marks it a stablecoin
  quotes.MUNT = { sym: 'MUNT', addr: STABLE_PROBE_ADDR, dec: 6, usd: 1 };
  const taken = new Set(HEROES.map((h) => h.base + '/' + h.quote));
  const addrs = {}, tokAddr = (sym, fresh) => (addrs[sym] ||= fresh); // the random draw happens either way, so later pools don't shift
  const specs = [...HEROES, ...makeRandomSpecs(r, 120 - HEROES.length, taken), ...PAIR_EXTRAS, ...STABLE_EXTRAS];
  const buildPool = (spec, r) => {
    const q = quotes[spec.quote];
    const young = spec.ageDays < 30;
    const createdAt = Math.round(now - spec.ageDays * D);
    const tvlUsd = spec.usd == null ? null : Math.round(spec.tvl);
    const mapUsd = tvlUsd == null || spec.mapUnread ? null : Math.round(spec.tvl * between(r, 0.96, 1));
    const lpKeeps = 'lpKeeps' in spec ? spec.lpKeeps : spec.v === 3 && r() < 0.25 ? 0.75 : 1;
    const pool = {
      id: spec.v === 4 ? hex(r, 64) : hex(r, 40), chain: spec.chain, v: spec.v, pair: spec.base + '/' + spec.quote,
      t0: { sym: spec.base, addr: tokAddr(spec.base, hex(r, 40)), dec: 18, usd: spec.usd == null ? null : sig(spec.usd, 6) }, // one address per token
      t1: { ...q },
      feeTier: spec.fee, dynamicFee: !!spec.dynamicFee, lpKeeps,
      hooks: spec.hooks ? hex(r, 40) : null,
      verified: 'verified' in spec ? spec.verified : true,
      firstSeen: Math.round(Math.max(createdAt + H, now - 21 * D)), createdAt, pairAgeDays: Math.round(spec.pairAgeDays), young,
      tvlUsd, mapUsd, aggUsd: tvlUsd == null ? null : Math.round(spec.tvl * between(r, 0.97, 1.05)),
      price: sig((spec.usd ?? 1) / q.usd, 6), marketRatio: spec.offMarket ? 1.14 : spec.usd == null ? null : sig(between(r, 0.992, 1.008), 4),
      offMarket: !!spec.offMarket,
    };
    if (spec.usd == null) pool.price = sig(between(r, 0.0001, 0.001), 6); // the pool still has a price; only the dollar value is unread
    pool.shape = tvlUsd == null ? { tag: 'mixed', parked: null, above: null, band9: null, lpsAtPrice: spec.lps ?? null, depth: [], walls: { below: null, above: null } }
      : shapeOf(r, spec, tvlUsd, mapUsd);
    pool.w = Object.fromEntries(WINDOWS.map((wk) => [wk, makeWindow(r, spec, pool, wk, opts)]));
    pool.checks = makeChecks(r, spec, pool);
    pool._spec = spec;
    return pool;
  };
  const pools = specs.map((spec) => buildPool(spec, r));
  // pools under 72 hours old for the discovery lanes: their own stream, so no earlier draw moves
  const rNew = rng(seed + 2203);
  pools.push(...NEW_EXTRAS.map((spec) => buildPool(spec, rNew)));
  addLanes(rng(seed + 2207), pools, now); // dex, the exchange screen, flow quality, the cexled and retail lenses

  // gemFirstAt: the first pass where the default window's gem reached the bar
  for (const p of pools) {
    const g = p.w['30d']?.gem?.total;
    const any = WINDOWS.some((wk) => (p.w[wk]?.gem?.total ?? -1) >= GEM_AT);
    p.gemFirstAt = mode === 'nogems' || p.verified === false ? null
      : p._spec.firstGemAgoH != null && any ? Math.round(now - p._spec.firstGemAgoH * H)
      : g != null && g >= GEM_AT ? Math.round(now - between(r, 2, 12) * D) : null;
  }
  const r2 = rng(seed + 99);
  for (const p of pools) addDaily(r2, p, now);
  const r3 = rng(seed + 501); // its own stream: the published bins never shift the draws above
  for (const p of pools) publishDepth(r3, p);
  const byGem = (a, b) => (b.w[DEFAULT_WINDOW]?.gem?.total ?? -1) - (a.w[DEFAULT_WINDOW]?.gem?.total ?? -1);
  pools.sort(byGem);
  const bench = pools.find((p) => p._spec.bench);
  // pairs, as lib/pairs.mjs publishes them: key = the two token addresses, lower first, native ETH read as WETH
  const addrOf = (t) => (t.sym === 'ETH' ? quotes.WETH.addr : t.addr).toLowerCase();
  const pairs = {};
  for (const p of pools) {
    p.pairKey = [addrOf(p.t0), addrOf(p.t1)].sort().join('-');
    (pairs[p.pairKey] ||= { label: p.pair.replace(/\/ETH$/, '/WETH'), pools: [], best: null, w: {} }).pools.push(p.id);
  }
  for (const pr of Object.values(pairs)) {
    const ps = pr.pools.map((id) => pools.find((p) => p.id === id));
    for (const wk of WINDOWS) {
      const ws = ps.map((p) => p.w[wk]);
      const vols = ws.map((w) => (w && isNum(w.volUsd) ? w.volUsd : null)), tot = vols.reduce((a, v) => a + (v || 0), 0);
      const fees = ws.map((w) => (w && isNum(w.lpFeesUsd) ? w.lpFeesUsd : null));
      pr.w[wk] = {
        volUsd: vols.some(isNum) ? Math.round(tot) : null, lpFeesUsd: fees.some(isNum) ? sig(fees.reduce((a, v) => a + (v || 0), 0), 6) : null,
        unread: vols.filter((v) => v == null).length,
        rows: ps.map((p, i) => {
          const w = ws[i];
          const per1k = w && isNum(w.lpFeesUsd) && isNum(w.inRangeUsd) && w.days > 0 ? sig(((w.lpFeesUsd / w.days) * 1000) / (w.inRangeUsd + 1000), 4) : null;
          return { id: p.id, volumeShare: vols[i] != null && tot > 0 ? sig(vols[i] / tot, 4) : null, feesPer1kDay: per1k, net: w ? w.net : null };
        }),
      };
    }
    const cand = pr.w[DEFAULT_WINDOW].rows.filter((r) => isNum(r.net) && ps.find((p) => p.id === r.id).verified !== false).sort((a, b) => b.net - a.net);
    pr.best = cand.length ? cand[0].id : null;
  }

  const chains = ['ethereum', 'base'].map((id, i) => ({
    id, pools: id === 'ethereum' ? 884 : 428, unread: id === 'ethereum' ? 4 : 2, block: id === 'ethereum' ? 21417733 : 22688410 + i,
    gasUsd: CHAIN_GAS[id],
  }));
  const checkDefs = [
    ['fee-identity', 'Fees match swaps ±2%', 0.93, 'replayed swaps vs the fee counters, per pool side'],
    ['price-vs-market', 'Price vs market ±2%', 0.96, 'pools of $1M or more vs the market price'],
    ['volume-vs-aggregator', 'Volume vs aggregator ±10%', 0.91, 'daily volume vs the aggregator'],
    ['maps-complete', 'Liquidity maps complete', 1, 'every tick read, books sum to the pool'],
    ['lp-book', 'LP book sums to pool L', 0.95, 'position ledger vs active liquidity'],
    ['creation-events', 'Creation events found', 0.88, 'pools found by lookup vs creation events'],
    ['volatility-xcheck', 'Volatility cross-check', null, 'not read this pass'],
    ['fees-vs-aggregator', 'Fees vs aggregator ±10%', 0.97, 'daily fees vs the aggregator'],
  ];
  const live = {
    v: 1, t: now, phase: 0, build: 'scan-fixture', next: now + 6 * 60e3, ticket: TICKET, stopLoss: 0.08,
    windows: [...WINDOWS], defaultWindow: DEFAULT_WINDOW, gemAt: GEM_AT, fixture: true, chains,
    health: {
      loop: { passes24h: 226, ok24h: 223, lastGapMin: 7, watchdogLast: now - 41 * 60e3 },
      checks: checkDefs.map(([id, label, value, detail]) => ({ id, label, ok: value == null ? null : value >= 0.9, value, detail })),
      sealedLog: { lines: 1840, errors: 2, categories: { timeout: 1, HTTP: 1 } },
    },
    discovery: discoveryOf(pools, now),
    bench: bench.id,
    pools: pools.map(({ _spec, ...p }) => p),
    pairs,
    market: makeMarket(rng(seed + 777), now),
  };

  // the pools under 72 hours old take their history from a stream of their own, so every other pool's rows stay as they were
  const isNewP = (p) => NEW_EXTRAS.includes(p._spec), olds = pools.filter((p) => !isNewP(p));
  const history = makeHistory(rng(seed + 1401), olds, now); // its own stream: 14 and 90 days of rows
  Object.assign(history.pools, makeHistory(rng(seed + 2211), pools.filter(isNewP), now).pools);
  const backtest = mode === 'nogems' ? { v: 1, t: now, ticket: TICKET, provisional: true, pools: {} } : makeBacktest(r, olds, now);
  return { live, history, backtest };
}

// ---------- the liquidity chart's published bins (lib/shape.mjs depthProfile / depthFields) ----------
// 48 fine bins across ±0.45 log, then 5 coarse bins a side, twice as wide, out to ±0.6375, then "far" bins doubling in width
// (0.075, 0.15, 0.3, …) out to the side's furthest liquidity, with no cap but the tick limit (about ±88.72 in log price);
// `depthEdges` holds every bar's edges. Full-range liquidity is a layer of its own (`fullRangeUsd`, over `fullRangeSpan`),
// taken out of every bar, so the far bars stop where the rest of the liquidity ends. Then `beyond` a side: a real 0 (the
// bars reach the side's last tick), null where the map wasn't read. Bars + beyond + fullRangeUsd add up to mapUsd.
// - Five heroes and about a quarter of the rest hold full-range liquidity (a few: a stack of wide positions, a narrower layer).
// - ORVO has a stray position near ×200 (far bars out to +5.36); KOVA (one-sided above) has a far wall in the coarse bins
//   and nothing at all below (real zeros, no far bars); QUARX's map is unread from its fourth coarse bin up: null bars, the
//   side's far bars out to the tick limit all null, a null beyond, and no layer (it can't be measured with a chunk unread).
export const DEPTH_FINE = 0.45, DEPTH_FINE_BINS = 48, DEPTH_COARSE_BINS = 5;
export const LOG_MAX = 887272 * Math.log(1.0001); // the tick limit as a log offset (≈ 88.72)
export const DEPTH_FAR = (() => { const e = []; for (let x = 0.6375, w = 0.075; x < LOG_MAX - 1e-9; w *= 2) e.push((x = Math.min(LOG_MAX, x + w))); return e; })(); // far edges
export const FULL_RANGE = ['UNI', 'NUMA', 'SOLVA', 'SELT', 'VELNA']; // heroes holding full-range positions (plus about a quarter of the rest)
const FSTEP = (2 * DEPTH_FINE) / DEPTH_FINE_BINS, CSTEP = 2 * FSTEP;
const eint = (a, b) => (a >= 0 ? 2 * (Math.exp(-a / 2) - Math.exp(-b / 2)) : b <= 0 ? 2 * (Math.exp(b / 2) - Math.exp(a / 2)) : eint(a, 0) + eint(0, b)); // ∫ e^(−|x|/2)
function publishDepth(r, p) {
  const old = p.shape.depth;
  const sym = p.t0.sym, frDraw = r(), frPick = FULL_RANGE.includes(sym) || frDraw < 0.25, spanDraw = [r(), r()];
  const nfDraw = [r(), r()]; // how far each side's liquidity reaches (drawn for every pool: the stream never shifts)
  if (!old.length) { Object.assign(p.shape, { depthEdges: null, depthSpan: null, depthStep: null, beyond: { below: null, above: null }, fullRangeUsd: null, fullRangeSpan: null }); return; }
  const fine = Array(DEPTH_FINE_BINS).fill(0);
  for (const [o, v] of old) {
    const a = o - 0.01, b = o + 0.01;
    for (let i = 0; i < DEPTH_FINE_BINS; i++) { const x = -DEPTH_FINE + i * FSTEP, ov = Math.min(b, x + FSTEP) - Math.max(a, x); if (ov > 0) fine[i] += (v * ov) / 0.02; }
  }
  const tot = old.reduce((s, d) => s + d[1], 0), mapUsd = p.mapUsd ?? tot / 0.95, rest = Math.max(0, mapUsd - tot);
  const oneUp = p.shape.tag === 'one-sided' && (p.shape.above ?? 1) > 0.5;
  const unreadUp = sym === 'QUARX';
  const fr = frPick && !unreadUp && sym !== 'KOVA' && !oneUp ? Math.min(rest * 0.6, mapUsd * (0.02 + 0.04 * frDraw)) : 0;
  const frSpan = !(fr > 0) ? null : FULL_RANGE.includes(sym) || spanDraw[0] < 0.6 ? [-LOG_MAX, LOG_MAX] : [-(1.5 + 2.5 * spanDraw[0]), 1.5 + 2.5 * spanDraw[1]];
  let moved = 0; // KOVA: 40% of what is parked above ±9% really sits further out (band9 and parked stay as they are)
  if (sym === 'KOVA') fine.forEach((v, i) => { if (-DEPTH_FINE + (i + 0.5) * FSTEP > 0.09) { moved += v * 0.4; fine[i] = v * 0.6; } });
  const side = (s, u) => { // s = -1 below, +1 above: five coarse bars, then the far bars as far as the side's liquidity reaches
    const share = oneUp ? (s > 0 ? 1 : 0) : 0.5, pot = (rest - fr) * share + (s > 0 ? moved : 0);
    const nf = !(pot > 0) ? 0 : sym === 'KOVA' ? 1 : sym === 'ORVO' && s > 0 ? 6 : u < 0.3 ? 0 : u < 0.55 ? 1 : u < 0.75 ? 2 : u < 0.9 ? 3 : 4;
    const edges = [DEPTH_FINE, ...Array.from({ length: DEPTH_COARSE_BINS }, (_, j) => DEPTH_FINE + (j + 1) * CSTEP), ...DEPTH_FAR.slice(0, nf)];
    if (!(pot > 0)) return { edges, bars: Array(DEPTH_COARSE_BINS).fill(0), beyond: 0 };
    let w = Array.from({ length: DEPTH_COARSE_BINS }, (_, j) => Math.pow(0.72, j) * between(r, 0.6, 1.4));
    if (sym === 'KOVA' && s > 0) w = w.map((x, j) => x + (j === 2 ? 6 : 0)); // a far wall, about +68% in price
    for (let k = 0; k < nf; k++) w.push(Math.pow(0.6, k + 1) * 0.5 * between(r, 0.6, 1.4) + (sym === 'ORVO' && s > 0 && k === 5 ? 0.4 : 0));
    const sw = w.reduce((a, x) => a + x, 0);
    return { edges, bars: w.map((x) => (x / sw) * pot), beyond: 0 };
  };
  const lo = side(-1, nfDraw[0]), hi = side(1, nfDraw[1]);
  if (unreadUp) { // an unread chunk hides itself and all past it: the side's far bars run out to the tick limit, all unread
    hi.edges = [...hi.edges.slice(0, DEPTH_COARSE_BINS + 1), ...DEPTH_FAR];
    hi.bars = [...hi.bars.slice(0, 3), ...Array(2 + DEPTH_FAR.length).fill(null)];
    hi.beyond = null;
  }
  const usd = (v) => (v == null ? null : sig(v, 5));
  const at = (x) => sig(x, 4), edge = (x) => sig(x, 6);
  const mid = (e, j) => (e[j] + e[j + 1]) / 2;
  p.shape.depth = [
    ...lo.bars.map((v, j) => [at(-mid(lo.edges, j)), usd(v)]).reverse(),
    ...fine.map((v, i) => [at(-DEPTH_FINE + (i + 0.5) * FSTEP), usd(v)]),
    ...hi.bars.map((v, j) => [at(mid(hi.edges, j)), usd(v)]),
  ];
  p.shape.depthEdges = [...lo.edges.slice(1).reverse().map((x) => edge(-x)), ...Array.from({ length: DEPTH_FINE_BINS + 1 }, (_, i) => edge(-DEPTH_FINE + i * FSTEP)), ...hi.edges.slice(1).map(edge)];
  p.shape.depthSpan = [p.shape.depthEdges[0], p.shape.depthEdges[p.shape.depthEdges.length - 1]];
  p.shape.depthStep = { fine: at(FSTEP), coarse: at(CSTEP), edge: DEPTH_FINE };
  p.shape.beyond = { below: usd(lo.beyond), above: usd(hi.beyond) };
  p.shape.fullRangeUsd = unreadUp ? null : fr > 0 ? usd(fr) : 0; // null: not measured (a chunk unread); 0: none
  p.shape.fullRangeSpan = frSpan && frSpan.map(edge);
}
export const fullRangeIn = (fr, span, a, b) => { // the layer's value between offsets a < b (as the page draws it)
  const [la, lb] = span || [-LOG_MAX, LOG_MAX], x = Math.max(a, la), y = Math.min(b, lb);
  return y > x ? (fr * eint(x, y)) / eint(la, lb) : 0;
};

// ---------- the top strip (lib/market.mjs): gas against its own week, three prices with their 24 h change ----------
function makeMarket(r, now) {
  const hour = Math.floor(now / H) * H, hist = [];
  for (let i = 155; i >= 0; i--) { // 6.5 days of hourly means: quiet nights, busier afternoons, one spike
    const day = Math.sin(((hour - i * H) / D) * 2 * Math.PI), spike = i === 40 ? 6 : 1;
    hist.push([hour - i * H, sig((0.32 + 0.18 * day) * spike * between(r, 0.7, 1.35), 4), 1 + Math.floor(r() * 4)]);
  }
  const sorted = hist.map((x) => x[1]).sort((a, b) => a - b), q = (p) => sig(sorted[Math.round((sorted.length - 1) * p)], 4);
  // the middle of the normal band, so the band never hangs on the hour the fixture is made at (it once read busy)
  const gwei = sig((q(0.25) + q(0.6)) / 2, 2), band = gwei < q(0.25) ? 'cheap' : gwei <= q(0.6) ? 'normal' : gwei <= q(0.9) ? 'busy' : 'expensive';
  return {
    t: now,
    gas: { gwei, p10: q(0.1), p50: q(0.5), p90: q(0.9), band, basis: 'history', histDays: 6.5, source: 'feeHistory', hist },
    px: { ETH: { usd: 3400, ch24: 0.0123, src: 'defillama' }, BTC: { usd: 96240, ch24: -0.0041, src: 'coinbase' }, SOL: { usd: 182.4, ch24: 0.031, src: 'coingecko' } },
  };
}
// the same pass with the strip's reads failed: missing is never zero
export function oldDepth(data) {
  const live = structuredClone(data.live);
  live.pools.forEach((p, i) => {
    const sh = p.shape;
    if (!sh.depth.length || i % 3 === 0) return;
    delete sh.depthEdges; delete sh.fullRangeUsd; delete sh.fullRangeSpan; // the second contract: steps and span only
    if (i % 3 === 2) { // the first: the fine bars, nothing about where they end
      sh.depth = sh.depth.filter(([o]) => Math.abs(o) < DEPTH_FINE);
      delete sh.depthStep; delete sh.depthSpan; delete sh.beyond;
    } else { // its coarse bars only: far bars and the layer did not exist yet
      sh.depth = sh.depth.filter(([o]) => Math.abs(o) < 0.6375 + 1e-9);
      sh.depthSpan = [-0.6375, 0.6375];
    }
  });
  return { ...data, live };
}
export function noDiscovery(data) {
  const live = structuredClone(data.live);
  delete live.discovery;
  for (const p of live.pools) {
    delete p.dex; delete p.cex; delete p.flowDaily;
    for (const w of Object.values(p.w)) if (w) { delete w.flow; w.lenses = w.lenses.filter((l) => l !== 'cexled' && l !== 'retail'); }
  }
  return { ...data, live };
}
function unreadMarket(data) {
  const live = structuredClone(data.live);
  live.next = null;
  live.market.gas = { gwei: null, p10: null, p50: null, p90: null, band: null, basis: null, histDays: 0, source: null, hist: [] };
  live.market.px.SOL = { usd: null, ch24: null, src: null };
  live.market.px.BTC.ch24 = null;
  live.health.loop.watchdogLast = null; // the watchdog never had to start a loop: a dash, never a time or 0
  return { ...data, live };
}

// the same pass at its widest: every text the page prints as long as real data makes it (the layout must hold)
export const LONG_PAD = 'WMWMWMWMWMWM';
export function longCase(data) {
  const live = structuredClone(data.live), bt = structuredClone(data.backtest), hist = structuredClone(data.history);
  const grow = (s) => (s.length >= 11 || /[<>]/.test(s) ? s : (s + LONG_PAD).slice(0, 11));
  const QUOTE = { WETH: 'WSTETHW', USDC: 'USDC.EWM', ETH: 'ETH' };
  const BIG = 997; // money: $1M pools become about $1B
  const money = (x) => (isNum(x) ? sig(x * BIG, 6) : x);
  for (const p of live.pools) {
    p.t0.sym = grow(p.t0.sym); p.t1.sym = QUOTE[p.t1.sym] || grow(p.t1.sym);
    p.pair = p.t0.sym + '/' + p.t1.sym;
    for (const k of ['tvlUsd', 'mapUsd', 'aggUsd']) p[k] = money(p[k]);
    const sh = p.shape;
    sh.depth = sh.depth.map(([o, v]) => [o, money(v)]);
    if (sh.beyond) sh.beyond = { below: money(sh.beyond.below), above: money(sh.beyond.above) };
    if (isNum(sh.fullRangeUsd)) sh.fullRangeUsd = money(sh.fullRangeUsd);
    if (isNum(sh.lpsAtPrice)) sh.lpsAtPrice = sh.lpsAtPrice * 137 + 1;
    for (const wk of WINDOWS) {
      const w = p.w[wk];
      if (!w) continue;
      for (const k of ['volUsd', 'lpFeesUsd', 'protocolFeesUsd', 'inRangeUsd']) w[k] = money(w[k]);
      for (const k of ['swaps', 'traders']) if (isNum(w[k])) w[k] = w[k] * 1009;
      for (const k of ['feeApr', 'net', 'aggApr']) if (isNum(w[k])) w[k] = sig(w[k] * 97, 5); // −4,567% and 12,345% APRs
    }
    for (const c of p.checks) c.label = c.label + ' (long label)';
    p.daily = p.daily.map((d) => ({ ...d, feesPer1k: isNum(d.feesPer1k) ? sig(d.feesPer1k * 37, 4) : d.feesPer1k, net: isNum(d.net) ? sig(d.net * 97, 4) : d.net }));
  }
  for (const pr of Object.values(live.pairs)) {
    pr.label = pr.label.split('/').map((x) => QUOTE[x] || grow(x)).join('/');
    for (const w of Object.values(pr.w)) { w.volUsd = money(w.volUsd); w.lpFeesUsd = money(w.lpFeesUsd); for (const r of w.rows) if (isNum(r.net)) r.net = sig(r.net * 97, 5); }
  }
  live.chains = live.chains.map((c) => ({ ...c, pools: c.pools * 97, unread: c.unread * 311, gasUsd: c.gasUsd * 113 }));
  live.next = live.t + 123 * 60e3;
  live.market.gas = { ...live.market.gas, gwei: 1234, p10: 456, p50: 789, p90: 1111, band: 'expensive', histDays: 6.5 };
  live.market.px = { ETH: { usd: 12345.6, ch24: -0.1234, src: 'defillama' }, BTC: { usd: 123456.78, ch24: 0.1987, src: 'defillama' }, SOL: { usd: 1234.5, ch24: -0.0999, src: 'coingecko' } };
  live.health.sealedLog = { lines: 1234567, errors: 12345, categories: { timeout: 1234, HTTP: 5678, parse: 99 } };
  for (const e of Object.values(bt.pools)) for (const b of Object.values(e)) {
    if (!b) continue;
    for (const k of ['fees', 'lvr', 'costs', 'net']) b.series[k] = b.series[k].map((x) => money(x));
    for (const st of b.strategies) { st.netUsd = money(st.netUsd); st.series = st.series.map((x) => money(x)); st.net = sig(st.net * 97, 5); }
    b.net = sig(b.net * 97, 5); if (isNum(b.forecastNet)) b.forecastNet = sig(b.forecastNet * 97, 5);
    for (const k of ['netUsd', 'feesUsd', 'lvrUsd', 'costsUsd', 'entryUsd']) b[k] = money(b[k]);
    b.grid.net = b.grid.net.map((row) => row.map((x) => (isNum(x) ? sig(x * 97, 5) : x)));
  }
  for (const h of Object.values(hist.pools)) { h.d = h.d.map((r) => [r[0], r[1], money(r[2]), money(r[3]), r[4]]); h.h = h.h.map((r) => [r[0], r[1], r[2], money(r[3]), r[4]]); if (h.y) h.y = h.y.map((r) => [r[0], money(r[1]), ...r.slice(2)]); }
  return { live, history: hist, backtest: bt };
}

// 30 days of fees per $1,000 and net, plus the shape of the fee stream (pattern, burst) and the gem's tags.
// Parts are renamed to "Gem now" (yield now 45, thinness 25, flow 20, staying power 10); totals stay as scored.
function addDaily(r, p, now) {
  const kind = PATTERN[p.t0.sym] && p.pair.endsWith(PATTERN[p.t0.sym] === 'steady' ? '/WETH' : '') ? PATTERN[p.t0.sym] : r() < 0.15 ? 'fading' : r() < 0.2 ? 'bursty' : 'steady';
  const w = p.w['30d'] || p.w['7d'] || p.w['24h'];
  const base = w && isNum(w.lpFeesUsd) && isNum(w.inRangeUsd) && w.days > 0 ? ((w.lpFeesUsd / w.days) * 1000) / (w.inRangeUsd + 1000) : null;
  const days = Math.min(30, Math.floor(p.createdAt ? (now - p.createdAt) / D : 30));
  const spike = Math.floor(between(r, 6, 26));
  p.daily = base == null ? [] : Array.from({ length: Math.max(0, days) }, (_, i) => {
    const x = i / 29;
    if (kind === 'zero') return { t: Math.floor(now / D) * D - (days - 1 - i) * D, feesPer1k: 0, net: w && isNum(w.net) ? sig(w.net, 4) : null };
    let m = kind === 'emerging' ? 0.25 + 1.6 * x * x : kind === 'fading' ? 1.6 - 1.3 * x : 1;
    if ((kind === 'bursty' || kind === 'one-off') && i === spike) m = kind === 'one-off' ? 14 : 8;
    else if (kind === 'bursty' || kind === 'one-off') m = 0.5;
    const f = Math.max(0, base * m * between(r, 0.75, 1.25));
    return { t: Math.floor(now / D) * D - (days - 1 - i) * D, feesPer1k: sig(f, 4), net: w && isNum(w.net) ? sig(w.net * m * between(r, 0.8, 1.2), 4) : null };
  });
  const fees = p.daily.map((d) => d.feesPer1k).sort((a, b) => a - b);
  const median = fees.length ? fees[Math.floor(fees.length / 2)] : null, max = fees.length ? fees[fees.length - 1] : null;
  p.pattern = !fees.length || kind === 'zero' ? null : kind === 'one-off' ? 'bursty' : kind;
  p.burst = !fees.length ? null : { maxDay: max, medianDay: median, burstDays: p.daily.filter((d) => d.feesPer1k > 3 * median).length, oneTrader: sig(kind === 'one-off' ? 0.92 : between(r, 0.05, 0.3), 3) };
  for (const wk of WINDOWS) {
    const g = p.w[wk] && p.w[wk].gem;
    if (!g) continue;
    const tags = [];
    if (p.verified === null) tags.push('unchecked');
    if (p.young) tags.push('unconfirmed');
    if (kind === 'one-off') tags.push('one-off');
    const sc = (v, from, to) => (isNum(v) ? Math.round((v / from) * to) : null);
    p.w[wk].gem = { total: g.total, yield: sc(g.yield, 35, 45), thinness: g.stranded, flow: sc(g.flow, 15, 20), staying: sc(g.persistence, 25, 10), warnings: g.warnings, missing: g.missing, tags };
  }
}

function makeChecks(r, spec, pool) {
  const age = Math.round(spec.pairAgeDays);
  const list = [
    ['contract-verified', 'code verified', true],
    ['sell-test', 'sell test', true],
    ['token-age-rank', `${age}-day token`, age >= 30],
    ['market', pool.offMarket ? 'off market' : 'on market', !pool.offMarket],
    ['fee-days', 'fees on 7/7 days', true],
    ['lp-keeps', pool.lpKeeps == null ? 'LP cut not read' : `LPs keep ${Math.round(pool.lpKeeps * 100)}%`, pool.lpKeeps == null ? null : true],
    ['concentration', 'no LP over 60%', spec.lps == null ? null : spec.lps > 1],
    ['exit', `exit $1k at ${(0.2 + r() * 0.6).toFixed(1)}%`, true],
    ['trend', spec.bigmove ? 'big move' : 'calm trend', !spec.bigmove],
    ['gas', 'gas OK', true],
    ['hook', pool.hooks ? 'unreviewed hook' : 'no hook', !pool.hooks],
    ['verified', pool.verified === true ? 'fee check passes' : pool.verified === false ? 'fee check impossible' : 'fee check not run', pool.verified],
  ];
  return list.map(([id, label, ok]) => ({ id, label, ok }));
}

function makeHistory(r, pools, now) {
  // history.json (lib/charts.mjs): hourly rows for 14 days, daily rows for 90, from the pool's first row on (no row before
  // it existed); each row's lpFeesUsd (and the daily volUsd) covers the time since the row before, so the first row's are
  // null. Some pools carry a gap the backfill hasn't filled (the next row covers it all), an unread row (its fees and the
  // next row's are null) and a row a few minutes off its mark.
  const out = { v: 1, t: now, pools: {}, health: [] };
  const ry = rng(9173); // the fee history's own stream: h and d stay as they were
  const hourNow = Math.floor(now / H) * H, dayNow = Math.floor(now / D) * D;
  const pk = (p) => [p.t0.sym, p.t1.sym].sort().join('/'), first = pools.slice(0, 60), fk = new Set(first.map(pk));
  [...first, ...pools.slice(60).filter((p) => fk.has(pk(p)))].forEach((p, k) => { // and the other pools of their pairs (v0.4.7: the fee chart's tiers)
    const spec = p._spec;
    const sigma = spec.sigma ?? 0.02, rate = isNum(p.lpKeeps) ? spec.fee * p.lpKeeps : null;
    const series = (n, step, t0, perStep, lpStep, gap, unread, off) => {
      const rows = [];
      let lp = 0;
      for (let i = n; i >= 0; i--) {
        lp += lpStep * gauss(r);
        const f = perStep == null ? null : perStep * between(r, 0.3, 1.8);
        if (gap && i <= gap[0] && i > gap[1]) continue; // missing rows: the next row's fees cover them
        const t = t0 - i * step + (off && i === off ? 4 * 60e3 : 0);
        rows.push([t, lp, f]);
      }
      return rows.map((row, i) => { // the price walks into today's price
        const prev = rows[i - 1], span = prev ? (row[0] - prev[0]) / step : 0;
        const bad = unread != null && (i === unread || i === unread + 1);
        return [row[0], sig(p.price * Math.exp(row[1] - lp), 6), !prev || bad || row[2] == null ? null : sig(row[2] * span, 4)];
      });
    };
    const feeH = p.w['7d']?.lpFeesUsd != null ? p.w['7d'].lpFeesUsd / (p.w['7d'].days * 24) : null;
    const feeD = p.w['30d']?.lpFeesUsd != null ? p.w['30d'].lpFeesUsd / p.w['30d'].days : feeH != null ? feeH * 24 : null;
    const hours = Math.min(14 * 24, Math.floor(spec.ageDays * 24)), days = Math.min(90, Math.floor(spec.ageDays));
    const h = series(hours, H, hourNow, feeH, sigma / Math.sqrt(24), k % 7 === 3 ? [60, 54] : null, k % 11 === 5 ? hours - 30 : null, k % 5 === 1 ? 20 : 0)
      .map((x) => [x[0], x[1], sig(1e18 * between(r, 0.8, 1.2), 4), x[2], p.shape.parked == null ? null : sig(clamp(p.shape.parked + between(r, -0.03, 0.03)), 3)]);
    const d = series(days, D, dayNow, feeD, sigma, k % 7 === 3 ? [20, 17] : null, k % 11 === 5 ? days - 12 : null, 0)
      .map((x) => [x[0], x[1], x[2], x[2] == null || !rate ? null : Math.round(x[2] / rate), p.shape.parked == null ? null : sig(clamp(p.shape.parked + between(r, -0.05, 0.05)), 3)]);
    out.pools[p.id] = { h, d };
    // the fee history (v0.4.7 fixtures): one row a UTC day to yesterday, up to 365, from the pool's first day; the last 90
    // days exact (the daily rows' own fees), older days mostly estimated, a few unread (null, never 0); some pools have no
    // y at all (the page falls back to d), one pool's start is not known (yp.age null), and one day is a 30× outlier the
    // scanner marks unconfirmed (history.json u.y)
    if (k % 9 === 4) { // no fee history: the page draws d; one d row a 30× spike the scanner lists unconfirmed (u.d)
      const i = d.length - 20;
      if (i > 1 && d[i][2] != null && d[i - 1][0] > d[i][0] - 1.5 * D) { d[i][2] = sig(d[i][2] * 30, 4); out.pools[p.id].u = { d: [d[i][0]] }; }
      return;
    }
    const yd = dayNow - D, ny = Math.min(365, Math.max(1, Math.floor(spec.ageDays))), fromD = new Map();
    d.forEach((row, i) => { if (i && row[0] - d[i - 1][0] < 1.5 * D) fromD.set(Math.floor((row[0] - D / 2) / D) * D, row[2]); });
    const y = [];
    for (let j = ny - 1; j >= 0; j--) {
      const t = yd - j * D, wave = 1 + 0.45 * Math.sin((j / 365) * 2 * Math.PI * 1.5 + k), noise = Math.exp(0.45 * gauss(ry));
      let v = feeD == null ? null : sig(feeD * wave * noise * (j === ny - 1 ? 0.4 : 1), 4), src = j < 90 ? 'x' : ry() < 0.12 ? 'x' : 'e';
      if (j < 90 && fromD.has(t)) v = fromD.get(t);
      if (ry() < (j < 90 ? 0.015 : 0.04) || v == null) { v = null; src = null; }
      if (j === ny - 1 && src) src = 'e'; // the creation day is partial and usually estimated
      if (j < 5 && src === 'x') src = 's'; // the newest exact days from the day's own swaps (history.json y src 's', 14 Nov 2026)
      y.push(v == null ? [t, null, null] : [t, v, src]);
    }
    const out1 = k % 4 === 0 && ny > 60 ? y[y.length - 41] : null; // a 30× day 40 days back, unconfirmed
    if (out1 && out1[1] != null) { const sv = y.map((x) => x[1]).filter((x) => x != null).sort((a, b) => a - b); out1[1] = sig(30 * sv[Math.floor(sv.length / 2)], 4); out1[2] = 'x'; out.pools[p.id].u = { y: [out1[0]] }; }
    const ex = y.filter((x) => x[2] === 'x' || x[2] === 's').length, es = y.filter((x) => x[2] === 'e').length, sw = y.filter((x) => x[2] === 's').length;
    out.pools[p.id].y = y;
    out.pools[p.id].yp = { exact: ex, est: es, age: k % 17 === 6 ? null : ny, dyn: !!p.dynamicFee, sw };
  });
  for (let i = 47; i >= 0; i--) {
    const passes = 9 + (r() < 0.3 ? 1 : 0) - (i === 30 ? 6 : 0);
    out.health.push([hourNow - i * H, passes - (r() < 0.12 ? 1 : 0), passes, Math.round(between(r, 3, 9))]);
  }
  return out;
}

// ---------- backtests: one simulated position per pool and window ----------
function pricePath(r, sigma, n, stepH, endPx) {
  const s = sigma * Math.sqrt(stepH / 24);
  const lx = [0];
  for (let i = 1; i <= n; i++) {
    const phase = i / n;
    const drift = phase < 0.25 ? 0.25 * s : phase < 0.5 ? -0.05 * s : phase < 0.75 ? -0.3 * s : 0.15 * s;
    lx.push(lx[i - 1] + drift + s * gauss(r));
  }
  const k = Math.log(endPx) - lx[n];
  return lx.map((x) => Math.exp(x + k));
}

function simulate({ px, vol, stepH, r: rr, wait = 0, drift = null, weight = 1, inside, feesDay, fee, gasUsd, fullShare }) {
  const full = !Number.isFinite(rr);
  const eff = full ? 1 : conc(rr);
  const share = full ? fullShare : (TICKET * weight) / (inside + TICKET * weight);
  const oneCost = TICKET * weight * swapCostPer(fee) + gasUsd;
  let c = px[0], out = 0, fees = 0, lvr = 0, costs = -oneCost, n = 0, inr = 0;
  const S = { fees: [0], lvr: [0], costs: [costs], net: [costs], lo: [full ? null : c * Math.exp(-rr)], hi: [full ? null : c * Math.exp(rr)] };
  for (let i = 1; i < px.length; i++) {
    const x = Math.log(px[i] / c);
    const inRange = full || Math.abs(x) <= rr;
    if (inRange) {
      inr++;
      fees += feesDay * (stepH / 24) * vol[i] * share;
      const dl = Math.log(px[i] / px[i - 1]);
      lvr -= ((dl * dl) / 8) * TICKET * weight * eff;
      out = 0;
    } else out++;
    let re = false;
    if (!full) re = drift != null ? Math.abs(x) >= drift * rr : !inRange && out > wait;
    if (re) { c = px[i]; n++; costs -= oneCost; out = 0; }
    S.fees.push(fees); S.lvr.push(lvr); S.costs.push(costs); S.net.push(fees + lvr + costs);
    S.lo.push(full ? null : c * Math.exp(-rr)); S.hi.push(full ? null : c * Math.exp(rr));
  }
  S.n = n; S.tir = inr / (px.length - 1); S.share = share;
  return S;
}

function makeBacktest(r, pools, now) {
  const out = { v: 1, t: now, ticket: TICKET, provisional: true, pools: {} };
  const pick = pools.filter((p) => p.verified !== false && WINDOWS.some((wk) => p.w[wk]?.gem?.total != null))
    .sort((a, b) => Math.max(...WINDOWS.map((wk) => b.w[wk]?.gem?.total ?? -1)) - Math.max(...WINDOWS.map((wk) => a.w[wk]?.gem?.total ?? -1)))
    .slice(0, 8);
  const bench = pools.find((p) => p._spec.bench);
  if (!pick.includes(bench)) pick.push(bench);
  for (const p of pick) {
    const entry = {};
    for (const wk of WINDOWS) {
      const w = p.w[wk];
      if (!w || w.range == null || w.inRangeUsd == null || w.lpFeesUsd == null) { entry[wk] = null; continue; }
      const stepH = wk === '24h' ? 1 : 4;
      const n = Math.round((w.days * 24) / stepH);
      const t0 = now - n * stepH * H;
      const px = pricePath(r, w.sigma, n, stepH, p.price);
      const vol = px.map(() => between(r, 0.5, 1.5));
      const feesDay = w.lpFeesUsd / w.days;
      const gasUsd = CHAIN_GAS[p.chain];
      const base = { px, vol, stepH, inside: w.inRangeUsd, feesDay, fee: p.feeTier, gasUsd, fullShare: TICKET / ((p.tvlUsd || 1e6) + TICKET) / conc(w.range) * 3 };
      const apr = (usd, weight = 1) => (usd / (TICKET * weight)) * (365 / w.days);
      const steady = (S) => apr(S.net[n] - S.net[0]); // the entry cost sits in the first step
      const rr = w.range;
      const R = (x) => Math.max(0.01, Math.round(x * 100) / 100);
      const ours = simulate({ ...base, r: rr });
      const strat = (id, name, S) => ({ id, name, net: sig(steady(S), 4), netUsd: cents(S.net[n]), reranges: S.n, series: S.net.map(cents) });
      const pc = (x) => `±${Math.round(x * 100)}%`;
      const tight = simulate({ ...base, r: R(rr * 0.45) });
      const wide = simulate({ ...base, r: R(rr * 2) });
      const gA = simulate({ ...base, r: R(rr * 1.35), weight: 0.7 }), gB = simulate({ ...base, r: R(rr * 0.35), weight: 0.3 });
      const gamma = { n: gA.n + gB.n, net: gA.net.map((v, i) => v + gB.net[i]) };
      const arr = simulate({ ...base, r: R(rr * 0.9), drift: 0.75 });
      const full = simulate({ ...base, r: Infinity });
      const strategies = [
        strat('ours', `Ours: re-centre on exit (${pc(rr)})`, ours),
        strat('tight', `Tight ${pc(R(rr * 0.45))}`, tight),
        strat('wide', `Wide ${pc(R(rr * 2))}`, wide),
        strat('gamma', `Gamma-style: base ${pc(R(rr * 1.35))} + limit ${pc(R(rr * 0.35))}`, gamma),
        strat('arrakis', `Arrakis-style: drift trigger (${pc(R(rr * 0.9))}, 75%)`, arr),
        strat('full', 'Full range, no touch', full),
      ];
      const widths = [...new Set([rr * 0.33, rr * 0.67, rr, rr * 1.67, rr * 2.5, rr * 4].map(R))].sort((a, b) => a - b);
      const trigs = [{ wait: 0 }, { wait: 12 / stepH }, { wait: 24 / stepH }, { drift: 0.5 }, { drift: 0.75 }];
      const grid = {
        widths, triggers: ['exit', 'exit+12h', 'exit+24h', 'drift50', 'drift75'],
        net: widths.map((wd) => trigs.map((tg) => sig(steady(simulate({ ...base, r: wd, ...tg })), 4))),
      };
      const net = steady(ours);
      const forecastNet = w.net == null ? null : sig(w.net + between(r, -0.25, 0.12), 4);
      const rv = p._spec.base === 'VELNA' ? sig(net + between(r, -0.08, 0.08), 4) : null; // Revert has no public API: null but for one pool, to draw both cases
      const positions = Math.round(between(r, 3, 14));
      const within2 = Math.min(positions, Math.round(positions * between(r, 0.6, 1)));
      entry[wk] = {
        days: w.days, partial: w.partial, range: rr, trigger: 'exit',
        forecastNet, net: sig(net, 4), netUsd: cents(cents(ours.fees[n]) + cents(ours.lvr[n]) + cents(ours.costs[n])),
        feesUsd: cents(ours.fees[n]), lvrUsd: cents(ours.lvr[n]), costsUsd: cents(ours.costs[n]), entryUsd: cents(ours.costs[0]),
        sigma: w.sigma, sigmaFrom: r() < 0.7 ? 'pool' : 'market', swaps: w.swaps, tir: sig(ours.tir, 4), reranges: ours.n, share: sig(ours.share, 4),
        series: {
          t: px.map((_, i) => Math.round(t0 + i * stepH * H)), px: px.map((x) => sig(x, 6)),
          lo: ours.lo.map((x) => sig(x, 6)), hi: ours.hi.map((x) => sig(x, 6)),
          fees: ours.fees.map(cents), lvr: ours.lvr.map(cents), costs: ours.costs.map(cents),
          net: ours.net.map((_, i) => cents(cents(ours.fees[i]) + cents(ours.lvr[i]) + cents(ours.costs[i]))),
        },
        strategies, grid,
        revert: rv == null ? { net: null, within10: null } : { net: rv, within10: Math.abs(rv - net) <= 0.1 },
        realCheck: r() < 0.75 ? { positions, within2, median: sig(between(r, 0.97, 1.04), 4) } : null,
      };
    }
    out.pools[p.id] = entry;
  }
  return out;
}

// ---------- seal into case folders ----------
function sealCase(dir, { lock, aes }, data, t, files = ['live', 'history', 'backtest'], liveKey = aes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lock));
  for (const f of files) {
    const key = f === 'live' ? liveKey : aes;
    fs.writeFileSync(path.join(dir, f + '.json'), JSON.stringify(seal(data[f], key, { t })));
  }
}

function aged(data, ageMs) {
  const shift = (x) => (isNum(x) ? x - ageMs : x);
  const live = structuredClone(data.live);
  live.t = shift(live.t); live.next = shift(live.next);
  if (live.market) live.market.t = shift(live.market.t);
  live.health.loop.watchdogLast = shift(live.health.loop.watchdogLast);
  for (const p of live.pools) p.gemFirstAt = shift(p.gemFirstAt);
  return { live, history: { ...data.history, t: shift(data.history.t) }, backtest: { ...data.backtest, t: shift(data.backtest.t) } };
}

export function writeFixtures(outDir, { now = Date.now(), iterations = ITERATIONS } = {}) {
  const lock = newLockFile(FIXTURE_PASSPHRASE, iterations);
  const { aes } = unlock(lock, FIXTURE_PASSPHRASE);
  const keys = { lock, aes };
  const data = makeData({ now });
  const nogems = makeData({ now, mode: 'nogems' });
  sealCase(path.join(outDir, 'default'), keys, data, now);
  const amber = aged(data, 20 * 60e3);
  sealCase(path.join(outDir, 'amber'), keys, amber, amber.live.t);
  const stale = aged(data, 3.2 * H);
  sealCase(path.join(outDir, 'stale'), keys, stale, stale.live.t);
  sealCase(path.join(outDir, 'nogems'), keys, nogems, now);
  sealCase(path.join(outDir, 'nofiles'), keys, data, now, ['live']);
  const other = unlock(newLockFile('a different made-up passphrase', 1000), 'a different made-up passphrase').aes;
  sealCase(path.join(outDir, 'rekeyed'), keys, data, now, ['live', 'history', 'backtest'], other);
  sealCase(path.join(outDir, 'nomarket'), keys, unreadMarket(data), now);
  sealCase(path.join(outDir, 'long'), keys, longCase(data), now);
  sealCase(path.join(outDir, 'olddepth'), keys, oldDepth(data), now);
  sealCase(path.join(outDir, 'nodisc'), keys, noDiscovery(data), now);
  sealCase(path.join(outDir, 'oddlanes'), keys, { ...data, live: { ...data.live, discovery: { newPools: [], cexLed: ['0x' + 'f'.repeat(40)], crossChain: [] } } }, now);
  return { outDir, cases: CASES, passphrase: FIXTURE_PASSPHRASE };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(process.argv[2] || path.join(here, 'out'));
  const t = Date.now();
  writeFixtures(outDir);
  console.log(`fixtures: ${CASES.length} cases written in ${((Date.now() - t) / 1000).toFixed(1)} s (made-up data, dummy passphrase)`);
}
