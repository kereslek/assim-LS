// One-off discovery (owner's question, 7 Nov 2026): are BTC/ETH pairs a good LP market on Base?
// Lists WBTC, cbBTC, tBTC and LBTC against WETH/ETH on Base (Uniswap v3 and v4, Aerodrome Slipstream,
// PancakeSwap v3) and Ethereum, and BTCB/WBNB and BTCB/ETH on BNB Chain for context. For each pool:
// fee tier and what an LP keeps of it (read on-chain), TVL and 24 h volume (GeckoTerminal), the value
// within ±1% and ±9% of the price (the scanner's tick bitmap reads, near the price only), and a fee APR.
// Then the BTC/ETH ratio's 30-day volatility and LVR, whether the flow is real (swaps, traders, how
// concentrated the last trades are), and the best other pools on Base and on PancakeSwap by volume
// per $ within ±9%. Public market data only: pools, tickers, TVL, volume, fees, counts and ratios.
import fs from 'node:fs';
import { makeRpc, getJson } from '../lib/rpc.mjs';
import { makeMulticall } from '../lib/multicall.mjs';
import { encodeCall, decodeWords, signed, toAddress } from '../lib/abi.mjs';
import { readNearMaps } from '../lib/maps.mjs';
import { poolKeysCall, readPoolKey, readV4Slot0, ZERO, DYNAMIC_FEE } from '../lib/pools.mjs';
import { ticksForLog, valueInRange, sqrtX96ToSqrt } from '../lib/v3math.mjs';
import { bandStats } from '../lib/shape.mjs';
import { dailySigma } from '../lib/flow.mjs';
import { lvrApr } from '../lib/economics.mjs';
import { parseMarketChart } from '../lib/history.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; }; // null is not 0
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const lower = (a) => String(a || '').toLowerCase();
const category = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || 'error';
const EEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const YEAR = 365 * 86400;

const CHAINS = {
  base: { label: 'Base', rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base'],
    wnative: '0x4200000000000000000000000000000000000006', stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', posm: '0x7c5f5a4bbd8fd63184577525326123b519429bdc' },
  eth: { label: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://eth.llamarpc.com', 'https://rpc.mevblocker.io'],
    wnative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', posm: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e' },
  bsc: { label: 'BNB', rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb'],
    wnative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  arbitrum: { label: 'Arbitrum', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org', 'https://1rpc.io/arb'],
    wnative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' },
};
// BTC tokens by chain (public token contracts). Pools found by ticker with another address are flagged.
const BTC = {
  base: { cbBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', WBTC: '0x0555e30da8f98308edb960aa94c0db47230d2b9c', tBTC: '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b', LBTC: '0xecac9c5f704e954931349da37f60e39f515c11c1' },
  eth: { WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', cbBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', tBTC: '0x18084fba666a33d37592fa2633fd49a74dd93a88', LBTC: '0x8236a87084f8b84306f72007f36f2618a5634494' },
  bsc: { BTCB: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c' },
};
// The other side: ETH (wrapped or native), and on BNB Chain also WBNB for context.
const OTHER = {
  base: [CHAINS.base.wnative, ZERO, EEE],
  eth: [CHAINS.eth.wnative, ZERO, EEE],
  bsc: ['0x2170ed0880ac9a755fd29b2688956bd959f933f8', CHAINS.bsc.wnative], // Binance-Peg ETH, WBNB
};
const BTC_SYM = /^(WBTC|cbBTC|tBTC|LBTC|BTCB|BTC\.b)$/i;
const ETH_SYM = /^(WETH|ETH)$/i;
const STABLE = /USD|DAI|EUR|GHO|FRAX|MIM|BOLD|DOLA|XAUT|PAXG/i;
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';

const errors = [];
const note = (area, e) => errors.push(`${area} ${category(e)}`);

// ---------- GeckoTerminal (public API, about 30 calls a minute: one call every 2.6 s, 429 backs off)
const GT = 'https://api.geckoterminal.com/api/v2';
let gtCalls = 0, gtFails = 0, lastGt = 0;
async function gt(path) {
  for (let i = 0; i < 4; i++) {
    const wait = lastGt + 2600 - Date.now();
    if (wait > 0) await pause(wait);
    lastGt = Date.now(); gtCalls++;
    try { return await getJson(GT + path, { headers: { accept: 'application/json;version=20230302' } }, 25000); } catch (e) {
      if (/HTTP 404/.test(String(e.message))) break;
      if (i === 3) note('geckoterminal', e);
      await pause(/HTTP 429/.test(String(e.message)) ? 15000 * (i + 1) : 3000);
    }
  }
  gtFails++;
  return null;
}
const INC = 'include=base_token,quote_token,dex';
const addrOfId = (id) => lower(String(id || '').slice(String(id || '').lastIndexOf('_') + 1));
function parsePools(j, net) {
  if (!j || !Array.isArray(j.data)) return null;
  const inc = new Map((j.included || []).map((x) => [x.id, x.attributes || {}]));
  return j.data.filter((p) => String(p.relationships?.base_token?.data?.id || '').startsWith(net + '_')).map((p) => {
    const a = p.attributes || {}, rel = p.relationships || {}, name = String(a.name || '');
    const bId = String(rel.base_token?.data?.id || ''), qId = String(rel.quote_token?.data?.id || '');
    const parts = name.split('/').map((s) => s.trim());
    const t = a.transactions?.h24 || {};
    const feeM = name.match(/(\d+(?:\.\d+)?)\s*%/);
    return {
      net, dex: String(rel.dex?.data?.id || ''), id: lower(a.address), name,
      base: addrOfId(bId), quote: addrOfId(qId),
      baseSym: inc.get(bId)?.symbol ?? parts[0] ?? '?', quoteSym: inc.get(qId)?.symbol ?? (parts[1] || '?').split(' ')[0],
      basePx: num(a.base_token_price_usd), quotePx: num(a.quote_token_price_usd), baseInQuote: num(a.base_token_price_quote_token),
      tvl: num(a.reserve_in_usd), vol24: num(a.volume_usd?.h24),
      swaps24: num(t.buys) != null && num(t.sells) != null ? num(t.buys) + num(t.sells) : null, buyers24: num(t.buyers), sellers24: num(t.sellers),
      gtFeePct: num(a.pool_fee_percentage) ?? (feeM ? Number(feeM[1]) : null),
      created: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    };
  });
}

// ---------- what each venue is, and how to read it
function kindOf(dex, id) {
  if (/^0x[0-9a-f]{64}$/.test(id)) return /uniswap/i.test(dex) ? 'v4' : 'other'; // PancakeSwap Infinity and other singletons: not read here
  if (!/^0x[0-9a-f]{40}$/.test(id)) return 'other';
  if (/slipstream/i.test(dex)) return 'slip';
  if (/pancakeswap[-_]?v3/i.test(dex)) return 'pcs3';
  if (/(uniswap|sushiswap)[-_]?v3/i.test(dex)) return 'v3';
  if (/v2|^aerodrome-base$|^aerodrome$/i.test(dex)) return 'v2';
  return 'other';
}
function dexLabel(dex) {
  const d = lower(dex);
  if (/slipstream/.test(d)) return 'Aerodrome CL';
  if (/^aerodrome/.test(d)) return 'Aerodrome v2';
  if (/uniswap[-_]?v4/.test(d)) return 'Uniswap v4';
  if (/uniswap[-_]?v3/.test(d)) return 'Uniswap v3';
  if (/uniswap[-_]?v2/.test(d)) return 'Uniswap v2';
  if (/pancakeswap[-_]?v3/.test(d)) return 'PancakeSwap v3';
  if (/pancakeswap.*infinity/.test(d)) return 'PancakeSwap Infinity';
  if (/pancakeswap/.test(d)) return 'PancakeSwap v2';
  if (/sushiswap[-_]?v3/.test(d)) return 'SushiSwap v3';
  return dex;
}

// ---------- formatting (missing shows —, never 0)
const usd = (x) => (!isNum(x) ? '—' : Math.abs(x) >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : Math.abs(x) >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${x.toFixed(0)}`);
const pc = (x, d = 0) => (!isNum(x) ? '—' : Math.abs(x) < 0.1 && d === 0 ? `${(x * 100).toFixed(1)}%` : `${(x * 100).toFixed(d)}%`);
const feeTxt = (x) => (!isNum(x) ? '—' : `${Number((x * 100).toPrecision(3))}%`);
const ratio = (x) => (!isNum(x) ? '—' : x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2));
const cnt = (x) => (!isNum(x) ? '—' : x >= 1e4 ? `${(x / 1e3).toFixed(0)}k` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(Math.round(x)));

// ---------- 1. discovery: the BTC/ETH pools on each chain
const btcSet = (net) => new Set(Object.values(BTC[net] || {}));
const isOther = (net, a) => (OTHER[net] || []).includes(lower(a));
function btcEthOf(row) {
  const bs = btcSet(row.net);
  const btcBase = bs.has(row.base) || BTC_SYM.test(row.baseSym), btcQuote = bs.has(row.quote) || BTC_SYM.test(row.quoteSym);
  if (btcBase && isOther(row.net, row.quote)) return { btc: 'base', listed: bs.has(row.base) };
  if (btcQuote && isOther(row.net, row.base)) return { btc: 'quote', listed: bs.has(row.quote) };
  return null;
}
const rows = new Map(); // net:id → row
const addRows = (list) => { for (const r of list || []) if (r.id && !rows.has(`${r.net}:${r.id}`)) rows.set(`${r.net}:${r.id}`, r); };
let gtTokenReads = 0, gtTokenUnread = 0;
for (const net of ['base', 'eth', 'bsc']) {
  for (const [sym, addr] of Object.entries(BTC[net])) {
    const a = parsePools(await gt(`/networks/${net}/tokens/${addr}/pools?${INC}&page=1&sort=h24_volume_usd_desc`), net);
    if (a) gtTokenReads++; else gtTokenUnread++;
    addRows(a);
    const b = parsePools(await gt(`/search/pools?query=${encodeURIComponent(sym)}&network=${net}&${INC}&page=1`), net);
    addRows(b);
  }
}
const pairs = [...rows.values()].map((r) => ({ ...r, be: btcEthOf(r) })).filter((r) => r.be && (r.be.listed || (r.tvl ?? 0) >= 100_000));
for (const p of pairs) p.group = 'pair';

// ---------- 2. leads: the busiest pools on Base, and PancakeSwap's on any chain
const leadRows = [];
for (let page = 1; page <= 3; page++) leadRows.push(...(parsePools(await gt(`/networks/base/pools?${INC}&page=${page}&sort=h24_volume_usd_desc`), 'base') || []).map((r) => ({ ...r, group: 'base' })));
for (let page = 1; page <= 3; page++) leadRows.push(...(parsePools(await gt(`/networks/bsc/pools?${INC}&page=${page}&sort=h24_volume_usd_desc`), 'bsc') || []).filter((r) => /pancake/i.test(r.dex)).map((r) => ({ ...r, group: 'pcs' })));
let pcsDexes = [];
for (const net of ['base', 'eth', 'arbitrum']) {
  let id = null;
  for (let page = 1; page <= 3 && !id; page++) {
    const j = await gt(`/networks/${net}/dexes?page=${page}`);
    if (!j?.data?.length) break;
    id = j.data.map((d) => String(d.id)).find((d) => /pancake/i.test(d) && /v3/i.test(d)) || null;
  }
  if (!id) continue;
  pcsDexes.push(`${net}:${id}`);
  leadRows.push(...(parsePools(await gt(`/networks/${net}/dexes/${id}/pools?${INC}&page=1&sort=h24_volume_usd_desc`), net) || []).map((r) => ({ ...r, group: 'pcs' })));
}
// Base's own Pancake pools also count for the Pancake list
for (const r of leadRows.filter((x) => x.group === 'base' && /pancake/i.test(x.dex))) leadRows.push({ ...r, group: 'pcs' });
const pairIds = new Set(pairs.map((p) => `${p.net}:${p.id}`));
const leads = [];
const seenLead = new Set();
for (const r of leadRows) {
  const k = `${r.group}:${r.net}:${r.id}`;
  if (seenLead.has(k) || pairIds.has(`${r.net}:${r.id}`)) continue;
  seenLead.add(k);
  if (STABLE.test(r.baseSym) || STABLE.test(r.quoteSym)) continue;
  if ((BTC_SYM.test(r.baseSym) || ETH_SYM.test(r.baseSym)) && (BTC_SYM.test(r.quoteSym) || ETH_SYM.test(r.quoteSym))) continue;
  leads.push({ ...r });
}

// ---------- 3. on-chain: fee, what LPs keep, price, liquidity, and the value near the price
const all = [...pairs, ...leads];
for (const p of all) p.kind = kindOf(p.dex, p.id);
const call = (target, sig, args = []) => ({ target, data: encodeCall(sig, args) });
const words = (r) => (r && r.ok ? decodeWords(r.data) : null);
const word = (r) => { const w = words(r); return w && w.length ? w[0] : null; };
const R9 = 0.09, R1 = 0.01;
const chainState = {};
for (const net of Object.keys(CHAINS)) {
  const C = CHAINS[net], mine = all.filter((p) => p.net === net && ['v3', 'pcs3', 'slip', 'v4'].includes(p.kind) && (p.kind !== 'v4' || C.stateView));
  if (!mine.length) continue;
  const rpc = makeRpc(C.rpcs, { batchSize: 40 }), mc = makeMulticall(rpc, { chunk: 300 });
  const bn = await rpc.call('eth_blockNumber', []);
  chainState[net] = { block: bn == null ? null : parseInt(bn, 16), pools: mine.length };
  const tag = bn ?? 'latest';
  // phase A: pool state
  const planA = mine.map((p) => (p.kind === 'v4'
    ? [call(C.stateView, 'getSlot0(bytes32)', [{ t: 'bytes32', v: p.id }]), call(C.stateView, 'getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]), poolKeysCall(C.posm, p.id)]
    : [call(p.id, 'token0()'), call(p.id, 'token1()'), call(p.id, 'fee()'), call(p.id, 'tickSpacing()'), call(p.id, 'slot0()'), call(p.id, 'liquidity()'),
      ...(p.kind === 'slip' ? [call(p.id, 'unstakedFee()'), call(p.id, 'gauge()'), call(p.id, 'stakedLiquidity()')] : [])]));
  let a;
  try { a = await mc(planA.flat(), tag); } catch (e) { note(`rpc ${net}`, e); a = new Array(planA.flat().length).fill(null); }
  let k = 0;
  for (let i = 0; i < mine.length; i++) {
    const p = mine[i], r = planA[i].map(() => a[k++]);
    if (p.kind === 'v4') {
      const s = readV4Slot0(r[0]), key = readPoolKey(r[2], p.id), L = word(r[1]);
      if (!s) continue;
      p.sqrtX96 = s.sqrtPriceX96; p.tick = s.tick; p.L = L;
      if (key) { p.t0 = lower(key.currency0); p.t1 = lower(key.currency1); p.tickSpacing = key.tickSpacing; p.dynamic = key.fee === DYNAMIC_FEE; p.hooked = key.hooks !== ZERO; }
      const pf = s.protocolFee, pf0 = pf & 0xfff, pf1 = pf >> 12, lp = s.lpFee;
      const tot = (x) => x + lp * (1 - x / 1e6);
      p.feeRate = (tot(pf0) + tot(pf1)) / 2 / 1e6;
      p.lpRate = ((lp * (1 - pf0 / 1e6)) + (lp * (1 - pf1 / 1e6))) / 2 / 1e6;
      p.keepNote = pf ? 'protocol fee on' : '';
      continue;
    }
    const s0 = words(r[4]);
    const t0 = word(r[0]), t1 = word(r[1]), fee = word(r[2]), ts = word(r[3]), L = word(r[5]);
    if (!s0 || s0.length < 6 || t0 == null || t1 == null || fee == null || ts == null) continue;
    p.t0 = toAddress(t0); p.t1 = toAddress(t1); p.tickSpacing = Number(signed(ts)); p.sqrtX96 = s0[0]; p.tick = Number(signed(s0[1])); p.L = L;
    p.feeRate = Number(fee) / 1e6;
    if (p.kind === 'v3' && s0.length >= 7) {
      const fp = Number(s0[5]), f0 = fp % 16, f1 = fp >> 4, share = ((f0 ? 1 / f0 : 0) + (f1 ? 1 / f1 : 0)) / 2;
      p.lpRate = p.feeRate * (1 - share); p.keepNote = fp ? `protocol takes 1/${f0 || '-'}·1/${f1 || '-'}` : '';
    } else if (p.kind === 'pcs3' && s0.length >= 7) {
      const fp = Number(s0[5]), f0 = fp % 65536, f1 = Math.floor(fp / 65536), share = (f0 + f1) / 2 / 10000;
      if (share >= 0 && share <= 1) { p.lpRate = p.feeRate * (1 - share); p.keepNote = `protocol ${Number((share * 100).toFixed(1))}%`; }
    } else if (p.kind === 'slip') {
      const u = word(r[6]), g = word(r[7]), sL = word(r[8]);
      if (u != null && Number(u) <= 1e6) { p.lpRate = p.feeRate * (1 - Number(u) / 1e6); p.keepNote = `unstaked; staked LPs: fees to voters, AERO instead`; }
      p.gauge = g != null && g !== 0n ? toAddress(g) : null; p.stakedL = sL;
    }
  }
  // phase B: decimals, balances (TVL cross-check), gauge emissions
  const toks = [...new Set(mine.flatMap((p) => [p.t0, p.t1]).filter((t) => t && t !== ZERO))];
  const planB = [...toks.map((t) => call(t, 'decimals()')),
    ...mine.filter((p) => p.kind !== 'v4' && p.t0).flatMap((p) => [call(p.t0, 'balanceOf(address)', [{ t: 'address', v: p.id }]), call(p.t1, 'balanceOf(address)', [{ t: 'address', v: p.id }])]),
    ...mine.filter((p) => p.gauge).flatMap((p) => [call(p.gauge, 'rewardRate()'), call(p.gauge, 'periodFinish()')])];
  let b;
  try { b = await mc(planB, tag); } catch (e) { note(`rpc ${net}`, e); b = new Array(planB.length).fill(null); }
  k = 0;
  const dec = new Map([[ZERO, 18]]);
  for (const t of toks) { const v = word(b[k++]); if (v != null && v < 80n) dec.set(t, Number(v)); }
  for (const p of mine.filter((x) => x.kind !== 'v4' && x.t0)) { p.bal0 = word(b[k++]); p.bal1 = word(b[k++]); }
  for (const p of mine.filter((x) => x.gauge)) { p.rewardRate = word(b[k++]); p.periodFinish = word(b[k++]); }
  for (const p of mine) { p.d0 = dec.get(p.t0) ?? null; p.d1 = dec.get(p.t1) ?? null; }
  // phase C: the liquidity within ±9% (a few bitmap words around the price)
  const mapIn = mine.filter((p) => p.tickSpacing > 0 && p.tick != null && p.L != null);
  const near = [];
  for (const v of [3, 4]) {
    const list = mapIn.filter((p) => (p.kind === 'v4') === (v === 4));
    if (!list.length) continue;
    let m;
    try { m = await readNearMaps(mc, list.map((p) => ({ v, id: p.id, tickSpacing: p.tickSpacing, tick: p.tick, liquidity: p.L })), { r: R9 + 0.005, stateView: C.stateView, tag }); } catch (e) { note(`maps ${net}`, e); m = list.map(() => ({ unread: 'error' })); }
    list.forEach((p, i) => { p.near = m[i]; near.push(m[i]); });
  }
  chainState[net].read = mine.filter((p) => p.sqrtX96 != null).length;
  chainState[net].mapped = near.filter((m) => m && !m.unread).length;
  chainState[net].rpcServed = [...rpc.served.values()].reduce((s, x) => s + x, 0);
}

// ---------- 4. per-pool numbers
const nativeLike = (net, a) => a === ZERO || a === EEE || a === CHAINS[net]?.wnative;
function usdOf(p, token) {
  if (!token) return null;
  if (token === p.base || (nativeLike(p.net, token) && nativeLike(p.net, p.base))) return p.basePx;
  if (token === p.quote || (nativeLike(p.net, token) && nativeLike(p.net, p.quote))) return p.quotePx;
  return null;
}
for (const p of all) {
  p.volTvl = isNum(p.vol24) && p.tvl > 0 ? p.vol24 / p.tvl : null;
  if (p.kind === 'v2') {
    // constant product: the value within ±r of the price is (1 − e^(−r/2)) of the pool, exactly
    p.in9 = isNum(p.tvl) ? p.tvl * (1 - Math.exp(-R9 / 2)) : null; p.in1 = isNum(p.tvl) ? p.tvl * (1 - Math.exp(-R1 / 2)) : null;
    p.feeRate = isNum(p.gtFeePct) ? p.gtFeePct / 100 : null;
    p.lpRate = /aerodrome/i.test(p.dex) && p.feeRate != null ? p.feeRate : null; // Uniswap v2's protocol share not read here
    p.keepNote = /aerodrome/i.test(p.dex) ? 'unstaked (assumed: full fee)' : 'LP share not read';
    p.analytic = true;
  } else if (p.near && !p.near.unread && p.d1 != null) {
    const px1 = usdOf(p, p.t1), sp = sqrtX96ToSqrt(p.sqrtX96);
    p.px1 = px1;
    if (isNum(px1) && sp > 0) {
      const v = (r) => { const t = ticksForLog(r); return bandStats(p.near.segments, sp, p.d1, p.tick - t, p.tick + t, p.tick).inside * px1; };
      p.in9 = v(R9); p.in1 = v(R1);
      const t9 = ticksForLog(R9);
      p.unit9 = valueInRange(1n, p.tick - t9, p.tick + t9, sp, p.d1) * px1; // USD per unit of liquidity over ±9%
    }
  }
  p.lpFees24 = isNum(p.vol24) && isNum(p.lpRate) ? p.vol24 * p.lpRate : null;
  p.apr = isNum(p.lpFees24) && p.in9 > 0 ? (365 * p.lpFees24) / p.in9 : null;
  p.share9 = isNum(p.in9) && p.tvl > 0 ? p.in9 / p.tvl : null;
  p.share1 = isNum(p.in1) && p.tvl > 0 ? p.in1 / p.tvl : null;
  // what a new ±9% position would earn per $ (fees shared with the liquidity at the price)
  p.posApr9 = isNum(p.lpFees24) && p.L != null && p.L > 0n && p.unit9 > 0 ? (365 * p.lpFees24) / (Number(p.L) * p.unit9) : null;
  p.volPerIn9 = isNum(p.vol24) && p.in9 > 0 ? p.vol24 / p.in9 : null;
  // TVL cross-check for pool-held balances (v3-style): on-chain balances at GeckoTerminal's prices
  if (p.bal0 != null && p.bal1 != null && p.d0 != null && p.d1 != null) {
    const u0 = usdOf(p, p.t0), u1 = usdOf(p, p.t1);
    if (isNum(u0) && isNum(u1)) p.tvlChain = (Number(p.bal0) / 10 ** p.d0) * u0 + (Number(p.bal1) / 10 ** p.d1) * u1;
  }
}
// Aerodrome emissions for staked liquidity (AERO per second → $ a year, per $ of a staked ±9% position)
const aeroJ = await gt(`/simple/networks/base/token_price/${AERO}`);
const aeroUsd = num(aeroJ?.data?.attributes?.token_prices?.[AERO]);
const nowS = Math.floor(Date.now() / 1000);
for (const p of all.filter((x) => x.rewardRate != null)) {
  const live = p.periodFinish != null && Number(p.periodFinish) > nowS;
  p.emitYearUsd = live && isNum(aeroUsd) ? (Number(p.rewardRate) / 1e18) * YEAR * aeroUsd : live ? null : 0;
  p.emitApr9 = isNum(p.emitYearUsd) && p.stakedL != null && p.stakedL > 0n && p.unit9 > 0 ? p.emitYearUsd / (Number(p.stakedL) * p.unit9) : null;
  p.stakedShare = p.stakedL != null && p.L > 0n ? Number(p.stakedL) / Number(p.L) : null;
}

// ---------- 5. BTC/ETH volatility and LVR (CoinGecko, cross-checked against a pool's own daily prices)
const CG_KEY = process.env.COINGECKO_KEY || '';
const cgH = { accept: 'application/json', ...(CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {}) };
async function cg(path) { try { return await getJson('https://api.coingecko.com/api/v3' + path, { headers: cgH }, 25000); } catch (e) { note('coingecko', e); return null; } finally { await pause(2500); } }
const btcEthD = parseMarketChart(await cg('/coins/bitcoin/market_chart?vs_currency=eth&days=30&interval=daily'));
const btcEthH = parseMarketChart(await cg('/coins/bitcoin/market_chart?vs_currency=eth&days=30'));
const ethUsdD = parseMarketChart(await cg('/coins/ethereum/market_chart?vs_currency=usd&days=30&interval=daily'));
const btcUsdD = parseMarketChart(await cg('/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily'));
function hourlyToDaily(pts) {
  if (!pts || pts.length < 200) return null;
  let s = 0, n = 0;
  for (let i = 1; i < pts.length; i++) { const dt = pts[i].t - pts[i - 1].t; if (dt < 1800 || dt > 5400) continue; const r = Math.log(pts[i].price / pts[i - 1].price); s += r * r; n++; }
  return n >= 200 ? Math.sqrt(s / n) * Math.sqrt(24) : null;
}
const sig = { cg: dailySigma(btcEthD || [], { days: 30 }), cgHourly: hourlyToDaily(btcEthH), eth: dailySigma(ethUsdD || [], { days: 30 }), btc: dailySigma(btcUsdD || [], { days: 30 }) };
const marketRatio = btcEthH?.at(-1)?.price ?? btcEthD?.at(-1)?.price ?? null; // ETH per BTC now
// the busiest BTC/ETH pool on Base: its own daily closes, BTC priced in ETH
const topBase = pairs.filter((p) => p.net === 'base' && isNum(p.vol24)).sort((a, b) => b.vol24 - a.vol24)[0];
if (topBase) {
  const btcAddr = topBase.be.btc === 'base' ? topBase.base : topBase.quote;
  const j = await gt(`/networks/base/pools/${topBase.id}/ohlcv/day?aggregate=1&limit=31&currency=token&token=${btcAddr}`);
  let pts = (j?.data?.attributes?.ohlcv_list || []).filter((x) => Array.isArray(x) && x[4] > 0).map((x) => ({ t: Number(x[0]), price: Number(x[4]) }));
  if (pts.length && pts.reduce((s, x) => s + x.price, 0) / pts.length < 1) pts = pts.map((x) => ({ t: x.t, price: 1 / x.price }));
  sig.pool = dailySigma(pts, { days: 30 });
  sig.poolName = `${dexLabel(topBase.dex)} ${topBase.name}`;
}
const sigma = sig.cg ?? sig.pool ?? null;
const lvr = { full: isNum(sigma) ? (365 * sigma * sigma) / 8 : null, r9: lvrApr(sigma, 0.09), r5: lvrApr(sigma, 0.05), r2: lvrApr(sigma, 0.02), r1: lvrApr(sigma, 0.01) };
for (const p of pairs) {
  // fee ÷ LVR at the same range: the range cancels (both scale with concentration), so one number per pool
  p.edge = isNum(p.posApr9) && isNum(lvr.r9) && lvr.r9 > 0 ? p.posApr9 / lvr.r9 : null;
  p.edgeStaked = isNum(p.emitApr9) && isNum(lvr.r9) && lvr.r9 > 0 ? p.emitApr9 / lvr.r9 : null;
  // the pool's own price vs the market (ETH per BTC), when it is a BTC vs ETH pool
  if (p.sqrtX96 != null && p.d0 != null && p.d1 != null && isNum(marketRatio) && isOther(p.net, p.t0 === ZERO ? ZERO : p.t0) !== isOther(p.net, p.t1)) {
    const s = sqrtX96ToSqrt(p.sqrtX96), raw = s * s * 10 ** (p.d0 - p.d1); // token1 per token0
    const ethPerBtc = isOther(p.net, p.t1) ? raw : 1 / raw;
    if (p.net !== 'bsc' || p.t0 === OTHER.bsc[0] || p.t1 === OTHER.bsc[0]) p.pxDev = ethPerBtc / marketRatio - 1;
  }
}

// ---------- 6. is the flow real? the last trades of the busiest BTC/ETH pools
const flowOf = async (p) => {
  const j = await gt(`/networks/${p.net}/pools/${p.id}/trades`);
  const tr = (j?.data || []).map((x) => x.attributes || {}).filter((a) => isNum(num(a.volume_in_usd)));
  if (!tr.length) return null;
  const by = new Map();
  for (const a of tr) by.set(lower(a.tx_from_address), (by.get(lower(a.tx_from_address)) || 0) + Number(a.volume_in_usd));
  const vols = [...by.values()].sort((x, y) => y - x), tot = vols.reduce((s, x) => s + x, 0);
  const sizes = tr.map((a) => Number(a.volume_in_usd)).sort((x, y) => x - y);
  const ts = tr.map((a) => Date.parse(a.block_timestamp)).filter(isNum);
  return { n: tr.length, traders: by.size, top1: tot > 0 ? vols[0] / tot : null, top3: tot > 0 ? vols.slice(0, 3).reduce((s, x) => s + x, 0) / tot : null,
    median: sizes[Math.floor(sizes.length / 2)], hours: ts.length > 1 ? (Math.max(...ts) - Math.min(...ts)) / 3600e3 : null };
};
const flowPools = [...pairs.filter((p) => p.net === 'base').sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0)).slice(0, 4), ...pairs.filter((p) => p.net === 'eth').sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0)).slice(0, 2)];
for (const p of flowPools) p.flow = await flowOf(p);

// ---------- 7. output: one line per pool, then the verdict numbers
const pairName = (p) => (p.be ? (p.be.btc === 'base' ? `${p.baseSym}/${p.quoteSym}` : `${p.quoteSym}/${p.baseSym}`) : `${p.baseSym}/${p.quoteSym}`);
const age = (p) => (isNum(p.created) ? Math.floor((Date.now() - p.created) / 86400e3) : null);
function line(p) {
  const keep = isNum(p.lpRate) && p.feeRate > 0 ? pc(p.lpRate / p.feeRate) : '?';
  const bits = [CHAINS[p.net]?.label ?? p.net, dexLabel(p.dex) + (p.hooked ? ' (hook)' : '') + (p.dynamic ? ' (dynamic fee)' : ''), pairName(p) + (p.be && !p.be.listed ? ' [ticker match]' : ''),
    `fee ${feeTxt(p.feeRate)} (LP keeps ${keep}${p.keepNote ? ', ' + p.keepNote : ''})`, `TVL ${usd(p.tvl)}`, `vol 24h ${usd(p.vol24)}`, `vol/TVL ${ratio(p.volTvl)}`,
    `LP fees 24h ${usd(p.lpFees24)}`, `fee APR ${pc(p.apr)}${p.analytic ? ' ≈' : ''}`, `±9% ${pc(p.share9)} of TVL`, `±1% ${pc(p.share1)}`,
    `swaps ${cnt(p.swaps24)}, buyers ${cnt(p.buyers24)}, sellers ${cnt(p.sellers24)}`];
  if (isNum(p.posApr9)) bits.push(`new ±9% position: fees ${pc(p.posApr9)}${p.edge != null ? `, fee÷LVR ${p.edge.toFixed(2)}` : ''}`);
  if (p.kind === 'slip') bits.push(`staked ${pc(p.stakedShare)} of active; AERO for a staked ±9% position ${pc(p.emitApr9)}${p.edgeStaked != null ? ` (÷LVR ${p.edgeStaked.toFixed(2)})` : ''}`);
  if (isNum(p.pxDev)) bits.push(`price vs market ${(p.pxDev * 100).toFixed(2)}%`);
  if (p.group !== 'pair' && age(p) != null) bits.push(`age ${age(p)} d`);
  if (p.kind === 'other') bits.push('not read on-chain');
  else if (!p.analytic && p.in9 == null) bits.push(p.sqrtX96 == null ? 'pool state unread' : !(p.tickSpacing > 0) ? 'pool key unread' : p.near?.unread ? `map unread (${p.near.unread})` : p.d1 == null ? 'decimals unread' : 'token unpriced');
  return bits.join(' · ');
}
const sortVol = (a, b) => (b.vol24 ?? -1) - (a.vol24 ?? -1);
const sections = [];
for (const net of ['base', 'eth', 'bsc']) {
  const list = pairs.filter((p) => p.net === net).sort(sortVol);
  sections.push({ short: `BTC-ETH pools ${CHAINS[net].label}`, title: `BTC/ETH pools · ${CHAINS[net].label}${net === 'bsc' ? ' (context: BTCB vs ETH and WBNB)' : ''} · ${list.length} found`, lines: list.length ? list.map(line) : ['none found (GeckoTerminal unread or no pools)'] });
}
const fmtS = (x) => (isNum(x) ? `${(x * 100).toFixed(2)}%` : '—');
sections.push({ short: 'Volatility and LVR', title: 'BTC/ETH volatility and LVR (30 days)', lines: [
  `BTC/ETH daily σ ${fmtS(sig.cg)} (CoinGecko daily), ${fmtS(sig.cgHourly)} (from hourly, ×√24), ${fmtS(sig.pool)} (${sig.poolName ?? 'top Base pool'} daily closes)`,
  `for comparison: ETH/USD ${fmtS(sig.eth)}, BTC/USD ${fmtS(sig.btc)} a day; BTC/ETH variance is ${isNum(sigma) && isNum(sig.eth) ? ((sigma * sigma) / (sig.eth * sig.eth) * 100).toFixed(0) + '%' : '—'} of ETH/USD's`,
  `LVR a year (σ²/8 × 365 × concentration): full range ${pc(lvr.full, 2)}, ±9% ${pc(lvr.r9, 1)}, ±5% ${pc(lvr.r5, 1)}, ±2% ${pc(lvr.r2, 1)}, ±1% ${pc(lvr.r1, 1)}`,
  `market now: ${isNum(marketRatio) ? marketRatio.toFixed(3) : '—'} ETH per BTC`,
] });
sections.push({ short: 'Flow', title: 'Is the flow real? (GeckoTerminal: the last ≤300 trades of 24 h)', lines: flowPools.map((p) => `${CHAINS[p.net].label} · ${dexLabel(p.dex)} · ${pairName(p)} · ${p.flow ? `${p.flow.n} trades over ${isNum(p.flow.hours) ? p.flow.hours.toFixed(1) + ' h' : '—'}, ${p.flow.traders} distinct senders, top sender ${pc(p.flow.top1)} of their volume, top 3 ${pc(p.flow.top3)}, median trade ${usd(p.flow.median)}` : 'trades unread'}`) });
const MIN_TVL = 250_000, MIN_IN9 = 50_000;
const rank = (group) => {
  // concentrated-liquidity pools only: a v2 pool's in-range value is analytic and an LP can't concentrate there
  const c = leads.filter((p) => p.group === group), ok = c.filter((p) => !p.analytic && p.tvl >= MIN_TVL && p.in9 >= MIN_IN9 && isNum(p.volPerIn9));
  return { considered: c.length, readable: c.filter((p) => !p.analytic && p.in9 != null).length, eligible: ok.length, top: ok.sort((a, b) => b.volPerIn9 - a.volPerIn9).slice(0, 5) };
};
const leadLine = (p) => `${(p.volPerIn9 ?? 0).toFixed(1)}× vol per $ within ±9% · ${line(p)}`;
for (const [g, title, short] of [['base', 'Leads · Base, top 5 by 24 h volume per $ within ±9% (no stablecoins, not BTC/ETH)', 'Leads Base'], ['pcs', `Leads · PancakeSwap (BNB Chain, ${pcsDexes.map((x) => x.split(':')[0]).join(', ') || 'no other chains found'}), top 5 by volume per $ within ±9%`, 'Leads PancakeSwap']]) {
  const r = rank(g);
  sections.push({ short, title: `${title} · ${r.considered} considered, ${r.readable} read on-chain, ${r.eligible} with TVL ≥ ${usd(MIN_TVL)} and ≥ ${usd(MIN_IN9)} within ±9%`, lines: r.top.length ? r.top.map(leadLine) : ['none eligible'] });
}
// checks: TVL on-chain vs GeckoTerminal, reads, and errors (categories only)
const tv = all.filter((p) => isNum(p.tvlChain) && p.tvl > 0).map((p) => p.tvlChain / p.tvl);
const within = tv.filter((x) => Math.abs(x - 1) <= 0.1).length;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
sections.push({ short: 'Checks', title: 'Checks', lines: [
  `GeckoTerminal ${gtCalls} calls, ${gtFails} unread; token lists read ${gtTokenReads} of ${gtTokenReads + gtTokenUnread}; Pancake v3 dexes found: ${pcsDexes.join(', ') || 'none'}`,
  ...Object.entries(chainState).map(([net, s]) => `${CHAINS[net].label}: block ${s.block ?? 'unread'}, pool state read ${s.read} of ${s.pools}, near-price maps ${s.mapped}`),
  `TVL from on-chain balances vs GeckoTerminal: ${within} of ${tv.length} pools within 10%, median ratio ${med(tv)?.toFixed(3) ?? '—'}`,
  `AERO ${isNum(aeroUsd) ? '$' + aeroUsd.toPrecision(3) : 'unpriced'}; CoinGecko key ${CG_KEY ? 'set' : 'not set'}; errors: ${errors.length ? [...new Set(errors)].join(', ') : 'none'}`,
] });

// console, the job summary, and one notice per section (read back through the check-run annotations)
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
for (const s of sections) {
  console.log(`\n## ${s.title}\n` + s.lines.map((l) => '- ' + l).join('\n'));
  console.log(`::notice title=${s.short}::${esc(`${s.title}\n` + s.lines.join('\n'))}`);
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, sections.map((s) => `### ${s.title}\n\n${s.lines.map((l) => '- ' + l).join('\n')}\n`).join('\n'));
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/btceth.json', JSON.stringify({ t: Date.now(), sections }, null, 1));
process.exit(0);
