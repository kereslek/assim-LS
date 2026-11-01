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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newLockFile, unlock, seal, ITERATIONS } from '../../lib/lock.mjs';

export const FIXTURE_PASSPHRASE = 'made-up fixture passphrase';
export const CASES = ['default', 'amber', 'stale', 'nogems', 'nofiles', 'rekeyed'];
export const PLANTED = { unverifiedGem: 'TALI/WETH', htmlTicker: '<img src=x onerror="window.__xss=1">' };

const H = 3600e3, D = 24 * H;
const WINDOWS = ['24h', '7d', '30d'];
const SPAN = { '24h': 1, '7d': 7, '30d': 30 };
const TICKET = 2000;
const GEM_AT = 60;
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
    hooks: true, dynamicFee: true, verified: false, plantedGem: 88,
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
  const taken = new Set(HEROES.map((h) => h.base + '/' + h.quote));
  const specs = [...HEROES, ...makeRandomSpecs(r, 120 - HEROES.length, taken)];
  const pools = specs.map((spec) => {
    const q = quotes[spec.quote];
    const young = spec.ageDays < 30;
    const createdAt = Math.round(now - spec.ageDays * D);
    const tvlUsd = spec.usd == null ? null : Math.round(spec.tvl);
    const mapUsd = tvlUsd == null || spec.mapUnread ? null : Math.round(spec.tvl * between(r, 0.96, 1));
    const lpKeeps = 'lpKeeps' in spec ? spec.lpKeeps : spec.v === 3 && r() < 0.25 ? 0.75 : 1;
    const pool = {
      id: spec.v === 4 ? hex(r, 64) : hex(r, 40), chain: spec.chain, v: spec.v, pair: spec.base + '/' + spec.quote,
      t0: { sym: spec.base, addr: hex(r, 40), dec: 18, usd: spec.usd == null ? null : sig(spec.usd, 6) },
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
  });

  // gemFirstAt: the first pass where the default window's gem reached the bar
  for (const p of pools) {
    const g = p.w['30d']?.gem?.total;
    const any = WINDOWS.some((wk) => (p.w[wk]?.gem?.total ?? -1) >= GEM_AT);
    p.gemFirstAt = mode === 'nogems' || p.verified === false ? null
      : p._spec.firstGemAgoH != null && any ? Math.round(now - p._spec.firstGemAgoH * H)
      : g != null && g >= GEM_AT ? Math.round(now - between(r, 2, 12) * D) : null;
  }
  const byGem = (a, b) => (b.w['30d']?.gem?.total ?? -1) - (a.w['30d']?.gem?.total ?? -1);
  pools.sort(byGem);
  const bench = pools.find((p) => p._spec.bench);

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
    windows: [...WINDOWS], defaultWindow: '30d', gemAt: GEM_AT, fixture: true, chains,
    health: {
      loop: { passes24h: 226, ok24h: 223, lastGapMin: 7, watchdogLast: now - 41 * 60e3 },
      checks: checkDefs.map(([id, label, value, detail]) => ({ id, label, ok: value == null ? null : value >= 0.9, value, detail })),
      sealedLog: { lines: 1840, errors: 2, categories: { timeout: 1, HTTP: 1 } },
    },
    bench: bench.id,
    pools: pools.map(({ _spec, ...p }) => p),
  };

  const history = makeHistory(r, pools, now);
  const backtest = mode === 'nogems' ? { v: 1, t: now, ticket: TICKET, provisional: true, pools: {} } : makeBacktest(r, pools, now);
  return { live, history, backtest };
}

function makeChecks(r, spec, pool) {
  const age = Math.round(spec.pairAgeDays);
  const list = [
    ['code', 'code verified', true],
    ['sell', 'sell test', true],
    ['age', `${age}-day token`, age >= 30],
    ['market', pool.offMarket ? 'off market' : 'on market', !pool.offMarket],
    ['fee-days', 'fees on 7/7 days', true],
    ['lp-keeps', pool.lpKeeps == null ? 'LP cut not read' : `LPs keep ${Math.round(pool.lpKeeps * 100)}%`, pool.lpKeeps == null ? null : true],
    ['concentration', 'no LP over 60%', spec.lps == null ? null : spec.lps > 1],
    ['exit', `exit $2k at ${(0.2 + r() * 0.6).toFixed(1)}%`, true],
    ['trend', spec.bigmove ? 'big move' : 'calm trend', !spec.bigmove],
    ['gas', 'gas OK', true],
    ['hook', pool.hooks ? 'unreviewed hook' : 'no hook', !pool.hooks],
    ['fee-check', pool.verified === true ? 'fee check passes' : pool.verified === false ? 'fee check impossible' : 'fee check not run', pool.verified],
  ];
  return list.map(([id, label, ok]) => ({ id, label, ok }));
}

function makeHistory(r, pools, now) {
  const out = { v: 1, t: now, pools: {}, health: [] };
  const hourNow = Math.floor(now / H) * H;
  for (const p of pools.slice(0, 60)) {
    const spec = p._spec;
    const sigma = spec.sigma ?? 0.02;
    const hours = Math.min(168, Math.floor(spec.ageDays * 24));
    const days = Math.min(30, Math.floor(spec.ageDays));
    const h = [];
    let lp = 0;
    const feeH = p.w['7d']?.lpFeesUsd != null ? p.w['7d'].lpFeesUsd / (p.w['7d'].days * 24) : null;
    for (let i = 0; i < hours; i++) {
      h.unshift([hourNow - i * H, sig(p.price * Math.exp(lp), 6), sig(1e18 * between(r, 0.8, 1.2), 4),
        feeH == null ? null : sig(feeH * between(r, 0.3, 1.8), 4), p.shape.parked == null ? null : sig(clamp(p.shape.parked + between(r, -0.03, 0.03)), 3)]);
      lp += (sigma / Math.sqrt(24)) * gauss(r);
    }
    const d = [];
    lp = 0;
    const feeD = p.w['30d']?.lpFeesUsd != null ? p.w['30d'].lpFeesUsd / p.w['30d'].days : feeH != null ? feeH * 24 : null;
    const volD = p.w['30d']?.volUsd != null ? p.w['30d'].volUsd / p.w['30d'].days : spec.volDay;
    const dayNow = Math.floor(now / D) * D;
    for (let i = 0; i < days; i++) {
      d.unshift([dayNow - i * D, sig(p.price * Math.exp(lp), 6), feeD == null ? null : sig(feeD * between(r, 0.4, 1.7), 4),
        Math.round(volD * between(r, 0.4, 1.7)), p.shape.parked == null ? null : sig(clamp(p.shape.parked + between(r, -0.05, 0.05)), 3)]);
      lp += sigma * gauss(r);
    }
    out.pools[p.id] = { h, d };
  }
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
  return { outDir, cases: CASES, passphrase: FIXTURE_PASSPHRASE };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(process.argv[2] || path.join(here, 'out'));
  const t = Date.now();
  writeFixtures(outDir);
  console.log(`fixtures: ${CASES.length} cases written in ${((Date.now() - t) / 1000).toFixed(1)} s (made-up data, dummy passphrase)`);
}
