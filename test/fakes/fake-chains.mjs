// Offline world for scripts/scan.mjs across chains and venues (MOCKUP · MADE-UP NUMBERS): Ethereum's Uniswap
// pools plus a PancakeSwap v3 pool, and Base with a Uniswap v3 pool and a young PancakeSwap v3 pool. A fake
// chain per network (told apart by the RPC host) whose maps, balances, slot0, fee counters, swaps and
// transactions all agree with made-up positions; Base's block clock follows lib/chains.mjs (0.2 s blocks).
// PancakeSwap pools take 33%/34% of the fee for the protocol (feeProtocol 3300 + 3400·65536) and emit
// PancakeSwap's Swap event with its own protocol-fee words. Fake CoinGecko tickers: one coin trades on
// exchanges, one answers 404 (unread), one trades on DEXes only (a real 0).
// FAULT=pcs-nibbles plants a fault: the fake pools book PancakeSwap's cut as Uniswap's 1/N (the scan must
// see its decode disagree with the events). FAULT=base-logs-refuse: every Base node refuses eth_getLogs (the one
// node that serves them is down); FAULT=base-slow: every Base request takes 300 ms (the caps must stop the parts).
// GeckoTerminal day candles: unreachable unless FAKE_GT=<scale> (made-up volumes × scale, 400 days, closes at the
// fake USD prices); the young Base pool gets two planted candles from before it existed. Requests are counted.
// FAULT=deep-today: every node answers a block over 90 days old with today's timestamp (the fee history's deep
// backfill must drop those batches).
import fs from 'node:fs';
import { selector } from '../../lib/keccak.mjs';
import { amountsInRange, sqrtAtTick, amount0Delta } from '../../lib/v3math.mjs';
import { SWAP_TOPICS } from '../../lib/swaps.mjs';
import { ETHEREUM as E, BASE as BC, ZERO } from '../../lib/pools.mjs';
import { CHAINS, blockAtTime, timeOfBlock } from '../../lib/chains.mjs';

const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const A = (c) => '0x' + c.repeat(40);
const NOW = Math.floor(Date.now() / 1000);
const FP_PCS = 3300 + 3400 * 65536;
const ROUTER = { ethereum: '0x111111125421ca6dc452d289314280a0f8842a65', base: '0x6ff5693b99212da76ad316178a184ab56d299b43' };
const T1 = A('1'), T2 = A('2'), T3 = A('3'), UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const WETH = E.quotes[0].address, USDC = E.quotes[2].address, BWETH = BC.quotes[0].address, BUSDC = BC.quotes[2].address;
const USD = { [T1]: 2, [T2]: 0.5, [T3]: 4, [UNI]: 7, [WETH]: 2250, [ZERO]: 2250, [USDC]: 1, [BWETH]: 2250, [BUSDC]: 1 };
const DEC = { [T1]: 18, [T2]: 6, [T3]: 18, [UNI]: 18, [WETH]: 18, [ZERO]: 18, [USDC]: 6, [BWETH]: 18, [BUSDC]: 6 };
const COIN = { [T1]: 'one-coin', [T2]: 'two-coin', [T3]: 'three-coin', [UNI]: 'uniswap', [WETH]: 'ethereum', [ZERO]: 'ethereum', [USDC]: 'usd-coin', [BWETH]: 'ethereum', [BUSDC]: 'usd-coin' };
const SYM = { [T1]: 'ONE', [T2]: 'TWO', [T3]: 'THREE', [UNI]: 'UNI', [WETH]: 'WETH', [ZERO]: 'ETH', [USDC]: 'USDC', [BWETH]: 'WETH', [BUSDC]: 'USDC' };
const r600 = (t) => Math.round(t / 600) * 600;
const SWAP = 10; // token0 per made-up swap, small next to each pool's liquidity
const mk = (tick, wallAbove, k = 1n) => [{ lo: r600(tick) - 1200, hi: r600(tick) + 1200, L: (10n ** 21n) / k }, { lo: -886800, hi: 886800, L: (10n ** 19n) / k }, { lo: r600(tick) + 6000, hi: r600(tick) + 9000, L: wallAbove / k }];
const tickOf = (p) => Math.floor(Math.log(p) / Math.log(1.0001));

const NET = {
  ethereum: { block: 20001000, ts: (b) => NOW - (20001000 - b) * 12, dayBlocks: 7200 },
  base: { block: blockAtTime(CHAINS.base, NOW), ts: (b) => Math.round(timeOfBlock(CHAINS.base, b)), dayBlocks: 432000 },
};
const pools = [
  { chain: 'ethereum', dex: 'uniswap', v: 3, id: A('a'), t0: T1, t1: WETH, fee: 3000, ts: 60, tick: tickOf(2 / 2250), wall: 10n ** 23n, fp: 0x44 },
  { chain: 'ethereum', dex: 'uniswap', v: 3, id: '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801', t0: UNI, t1: WETH, fee: 3000, ts: 60, tick: tickOf(7 / 2250), wall: 10n ** 19n, fp: 0 },
  { chain: 'ethereum', dex: 'uniswap', v: 4, id: '0x' + 'c'.repeat(64), t0: ZERO, t1: T1, fee: 3000, ts: 60, tick: tickOf(2250 / 2), wall: 10n ** 20n },
  { chain: 'ethereum', dex: 'pancakeswap', v: 3, id: A('d'), t0: T2, t1: USDC, fee: 2500, ts: 50, tick: tickOf(0.5), wall: 0n, k: 2n * 10n ** 8n, fp: FP_PCS },
  { chain: 'base', dex: 'uniswap', v: 3, id: A('e'), t0: T3, t1: BWETH, fee: 3000, ts: 60, tick: tickOf(4 / 2250), wall: 10n ** 23n, fp: 0x44 },
  { chain: 'base', dex: 'pancakeswap', v: 3, id: A('f'), t0: T3, t1: BWETH, fee: 500, ts: 10, tick: tickOf(4 / 2250), wall: 3n * 10n ** 22n, fp: FP_PCS, young: true },
].map((p) => {
  const positions = mk(p.tick, p.wall, p.k).filter((x) => x.L > 0n);
  const net = new Map();
  for (const q of positions) { net.set(q.lo, (net.get(q.lo) || 0n) + q.L); net.set(q.hi, (net.get(q.hi) || 0n) - q.L); }
  const L = positions.filter((q) => q.lo <= p.tick && p.tick < q.hi).reduce((s, q) => s + q.L, 0n);
  const sp = sqrtAtTick(p.tick + 0.5);
  let a0 = 0, a1 = 0;
  for (const q of positions) { const [x, y] = amountsInRange(q.L, q.lo, q.hi, sp); a0 += x; a1 += y; }
  const tvl = (a0 / 10 ** DEC[p.t0]) * USD[p.t0] + (a1 / 10 ** DEC[p.t1]) * USD[p.t1];
  return { ...p, net, L, sp, bal0: BigInt(Math.floor(a0 * 1.002)), bal1: BigInt(Math.floor(a1 * 1.002)), tvl: tvl * 1.002, n: p.young ? 24 : 12 };
});
// the day's swaps as the pool books them: sells of SWAP token0 from the window-start price, each inside one
// stretch of liquidity; the counter grows by (fee − protocol cut) ÷ liquidity per swap. The cut follows each
// venue's own rule (Uniswap 1/N, PancakeSwap fp/10,000), unless FAULT=pcs-nibbles books PancakeSwap as Uniswap.
const cutOf = (p, f) => {
  if (!p.fp) return 0n;
  if (p.dex === 'pancakeswap' && process.env.FAULT !== 'pcs-nibbles') return (f * BigInt(p.fp % 65536)) / 10000n;
  const n = BigInt(p.fp % 16); return n ? f / n : 0n;
};
const wobble = (p, k) => BigInt(Math.floor(p.sp * Math.exp(k ? (k % 2 ? 0.01 : -0.01) : 0) * 2 ** 96));
for (const p of pools) {
  let P = wobble(p, 1), fg = 0n;
  const amt0 = BigInt(SWAP) * 10n ** BigInt(DEC[p.t0]), fee = BigInt(p.fee), steps = [], cuts = [];
  for (let k = p.n - 1; k >= 0; k--) {
    const lessFee = (amt0 * (1000000n - fee)) / 1000000n, L = p.L;
    const n1 = L << 96n, den = n1 + lessFee * P, next = (n1 * P + den - 1n) / den; // getNextSqrtPriceFromAmount0RoundingUp
    const f = amt0 - amount0Delta(next, P, L, true), cut = cutOf(p, f);
    fg += ((f - cut) << 128n) / L;
    steps[k] = next; cuts[k] = cut; P = next;
  }
  p.sim = { steps, cuts, end: P, fg };
}
const NOW_POOL = (p) => NET[p.chain].block;
const swapBlock = (p, k) => (p.chain === 'base' ? NET.base.block - 600 - k * 15000 : NET.ethereum.block - 100 - k * 500);
const txHash = (p, k) => '0x' + (p.id.slice(2, 12) + k.toString(16).padStart(6, '0')).padEnd(64, '7');
const created = (p) => (p.young ? NOW - 30 * 3600 : null);

// the pool lists scripts/pools.mjs would write
fs.mkdirSync('out', { recursive: true });
const listOf = (chain) => {
  const ps = pools.filter((p) => p.chain === chain);
  const quotes = (chain === 'base' ? BC : E).quotes.map((q) => q.address);
  const toks = [...new Set([...ps.flatMap((p) => [p.t0, p.t1]), ...quotes.filter((q) => q in DEC)])];
  return {
    t: Date.now(), chain, block: NET[chain].block - 1000, v3EventsComplete: false,
    v3: ps.filter((p) => p.v === 3).map((p) => ({ id: p.id, dex: p.dex, t0: p.t0, t1: p.t1, fee: p.fee, tvl: p.tvl, aggReserveUsd: p.tvl * 0.98, aggVolumeUsd24h: p.n * SWAP * USD[p.t0], createdAt: created(p) })),
    v4: ps.filter((p) => p.v === 4).map((p) => ({ id: p.id, dex: 'uniswap', t0: p.t0, t1: p.t1, fee: p.fee, tickSpacing: p.ts, hooks: ZERO, liquidity: String(p.L), aggReserveUsd: 2e6, aggVolumeUsd24h: null })),
    tokens: toks.map((a) => ({ address: a, decimals: DEC[a], symbol: SYM[a], usd: USD[a], quote: quotes.includes(a), rank: [T1, T2, T3, UNI].includes(a) ? 500 : null, firstPoolAt: NOW - 400 * 86400, cg: COIN[a] })),
  };
};
fs.writeFileSync('out/pools-ethereum.json', JSON.stringify(listOf('ethereum')));
fs.writeFileSync('out/pools-base.json', JSON.stringify(listOf('base')));

const S = { ts: selector('getCurrentBlockTimestamp()'), fg0: selector('feeGrowthGlobal0X128()'), fg1: selector('feeGrowthGlobal1X128()'), fg4: selector('getFeeGrowthGlobals(bytes32)'), s0: selector('slot0()'), liq: selector('liquidity()'), bm3: selector('tickBitmap(int16)'), t3: selector('ticks(int24)'), s4: selector('getSlot0(bytes32)'), l4: selector('getLiquidity(bytes32)'), bm4: selector('getTickBitmap(bytes32,int16)'), t4: selector('getTickLiquidity(bytes32,int24)') };
const BASE_FG = 10n ** 40n;
const ageDays = (chain, tag) => Math.round((NOW - NET[chain].ts(parseInt(tag, 16))) / 86400);
const sqrtX96 = (p, tag) => { const k = tag ? ageDays(p.chain, tag) : 0; return k === 0 ? p.sim.end : wobble(p, k); };
function answer(chain, target, data, tag) {
  const t = target.toLowerCase(), sel = data.slice(0, 10), v4 = [S.s4, S.l4, S.bm4, S.t4, S.fg4].includes(sel), b = parseInt(tag, 16);
  // FAULT=deep-today: the nodes answer blocks over 90 days old with today's state (and timestamp)
  if (t === '0xca11bde05977b3631167028862be2a173976ca11' && sel === S.ts) return W(process.env.FAULT === 'deep-today' && NOW - NET[chain].ts(b) > 90 * 86400 ? NOW : NET[chain].ts(b));
  const p = v4 ? pools.find((x) => x.chain === chain && x.id === '0x' + data.slice(10, 74)) : pools.find((x) => x.chain === chain && x.id === t);
  if (!p) return null;
  if (isFinite(created(p)) && NET[chain].ts(b) < created(p)) return sel === S.s0 ? '' : null; // not deployed yet: no code
  const arg = () => Number(BigInt.asIntN(256, BigInt('0x' + (v4 ? data.slice(74, 138) : data.slice(10, 74)))));
  const isNow = b === NOW_POOL(p);
  if (sel === S.fg0) return W(BASE_FG + (isNow ? p.sim.fg : 0n));
  if (sel === S.fg1) return W(BASE_FG);
  if (sel === S.fg4) return W(BASE_FG + (isNow ? p.sim.fg : 0n)) + W(BASE_FG);
  if (sel === S.s0) return W(sqrtX96(p, tag)) + W(p.tick) + W(0) + W(1) + W(1) + W(p.fp ?? 0) + W(1);
  if (sel === S.s4) return W(sqrtX96(p, tag)) + W(p.tick) + W(0) + W(p.fee);
  if (sel === S.liq || sel === S.l4) return W(p.L);
  if (sel === S.bm3 || sel === S.bm4) { let bm = 0n; for (const k of p.net.keys()) { const c = k / p.ts, wi = Math.floor(c / 256); if (wi === arg()) bm |= 1n << BigInt(c - wi * 256); } return W(bm); }
  if (sel === S.t3 || sel === S.t4) { const n = p.net.get(arg()) || 0n; return W(n < 0n ? -n : n) + W(n) + (sel === S.t3 ? W(0).repeat(6) : ''); }
  return null;
}
function aggregate3(chain, data, tag) {
  const h = data.slice(10), word = (o) => BigInt('0x' + h.slice(o * 2, o * 2 + 64)), n = Number(word(32));
  let off = 32 * n, head = '', body = '';
  for (let i = 0; i < n; i++) {
    const e = 64 + Number(word(64 + 32 * i)), target = '0x' + h.slice(e * 2 + 24, e * 2 + 64);
    const len = Number(word(e + Number(word(e + 64)))), cd = '0x' + h.slice((e + 128) * 2, (e + 128 + len) * 2);
    const r = answer(chain, target, cd, tag), ok = r != null, d = ok ? r : '', el = W(ok ? 1 : 0) + W(0x40) + W(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    head += W(off); body += el; off += el.length / 2;
  }
  return '0x' + W(0x20) + W(n) + head + body;
}
const PM = { ethereum: E.v4PoolManager, base: BC.v4PoolManager };
function swapsFor(chain, f) {
  const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16), out = [];
  for (const p of pools.filter((x) => x.chain === chain)) {
    const v4 = p.v === 4;
    if (v4 ? !(typeof f.address === 'string' && f.address.toLowerCase() === PM[chain] && f.topics[1].includes(p.id)) : !(Array.isArray(f.address) && f.address.includes(p.id))) continue;
    for (let k = 0; k < p.n; k++) {
      const b = swapBlock(p, k);
      if (b < from || b > to) continue;
      const amt0 = BigInt(SWAP) * 10n ** BigInt(DEC[p.t0]);
      const amt1 = BigInt(Math.floor(SWAP * (USD[p.t0] / USD[p.t1]) * 10 ** DEC[p.t1]));
      const pcs = p.dex === 'pancakeswap';
      const data = v4 ? W(-amt0) + W(amt1) + W(p.sim.steps[k]) + W(p.L) + W(p.tick) + W(p.fee)
        : W(amt0) + W(-amt1) + W(p.sim.steps[k]) + W(p.L) + W(p.tick) + (pcs ? W(process.env.FAULT === 'pcs-nibbles' ? (BigInt(SWAP) * 10n ** BigInt(DEC[p.t0]) * BigInt(p.fee) / 1000000n) * BigInt(p.fp % 65536) / 10000n : p.sim.cuts[k]) + W(0) : '');
      out.push({ address: v4 ? PM[chain] : p.id, topics: v4 ? [SWAP_TOPICS.v4, p.id, '0x' + W(7)] : [pcs ? SWAP_TOPICS.pcs3 : SWAP_TOPICS.v3, '0x' + W(7), '0x' + W(8)], data: '0x' + data, blockNumber: '0x' + b.toString(16), logIndex: '0x' + k.toString(16), transactionHash: txHash(p, k) });
    }
  }
  return out;
}
const txOf = (chain, h) => {
  for (const p of pools.filter((x) => x.chain === chain)) for (let k = 0; k < p.n; k++) if (txHash(p, k) === h) return { hash: h, to: k % 2 ? ROUTER[chain] : '0x' + 'ee'.repeat(20), from: '0x' + (k + 1).toString(16).padStart(40, '0') };
  return null;
};
let calls = { ethereum: 0, base: 0 };
function rpc(chain, q) {
  calls[chain]++;
  if (chain === 'base' && process.env.FAULT === 'base-logs-refuse' && q.method === 'eth_getLogs') return { jsonrpc: '2.0', id: q.id, error: { code: -32005, message: 'logs not served' } };
  const r = (result) => ({ jsonrpc: '2.0', id: q.id, result });
  const N = NET[chain];
  if (q.method === 'eth_blockNumber') return r('0x' + N.block.toString(16));
  if (q.method === 'eth_gasPrice') return r('0x' + (chain === 'base' ? 5e6 : 2e9).toString(16));
  if (q.method === 'eth_getBlockByNumber') { const b = parseInt(q.params[0], 16); return r(b >= 0 && b <= N.block ? { number: '0x' + b.toString(16), timestamp: '0x' + Math.floor(N.ts(b)).toString(16) } : null); }
  if (q.method === 'eth_call' && q.params[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return r(aggregate3(chain, q.params[0].data, q.params[1]));
  if (q.method === 'eth_getLogs') { const f = q.params[0], span = parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16); if (span > (chain === 'base' ? 10000 : 1500)) return { jsonrpc: '2.0', id: q.id, error: { code: -32005, message: 'range too large' } }; return r(swapsFor(chain, f)); }
  if (q.method === 'eth_getTransactionByHash') { const t = txOf(chain, q.params[0]); return t ? r(t) : r(null); }
  return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'no' } };
}
const json = (j) => ({ ok: true, status: 200, json: async () => j });
const notFound = { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
let gtCalls = 0;
const gtCandles = (p, limit, scale) => {
  const day = Math.floor(NOW / 86400) * 86400, out = [];
  for (let k = 0; k < Math.min(limit, 400); k++) {
    const t = day - k * 86400;
    if (p.young && t < created(p) - 2 * 86400) break; // two planted candles from before the pool existed
    out.push([t, 1, 1, 1, USD[p.t0], scale * (1000 + 10 * (k % 7))]);
  }
  return out;
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.geckoterminal.com') && u.includes('/ohlcv/')) {
    gtCalls++;
    if (!process.env.FAKE_GT) throw new TypeError('fetch failed'); // the host unreachable: the scan stops asking at once
    const [, net, id] = /networks\/([^/]+)\/pools\/([^/]+)\//.exec(u), p = pools.find((x) => x.id === id && (x.chain === 'base') === (net === 'base'));
    if (!p) return notFound;
    const limit = Number(/limit=(\d+)/.exec(u)?.[1] ?? 100);
    return json({ data: { attributes: { ohlcv_list: gtCandles(p, limit, Number(process.env.FAKE_GT)) } }, meta: { base: { address: p.t0 }, quote: { address: p.t1 } } });
  }
  if (u.includes('api.coingecko.com') && u.includes('/market_chart')) { // hourly for 30 days; UNI is left to the DefiLlama fallback
    const addr = u.split('/contract/')[1].split('/')[0], j = Object.keys(USD).indexOf(addr);
    if (addr === UNI || j < 0) return notFound;
    const now = Date.now();
    const prices = Array.from({ length: 721 }, (_, i) => { const t = now - (720 - i) * 3600e3, d = Math.floor((now - t) / 86400e3); return [t, USD[addr] * Math.exp((d % 2 ? 1 : -1) * 0.01 * (j + 1))]; });
    return json({ prices });
  }
  if (u.includes('api.coingecko.com') && u.includes('/tickers')) { // exchange tickers: ONE trades on exchanges, THREE on DEXes only, the rest 404
    const coin = u.split('/coins/')[1].split('/')[0];
    if (coin === 'one-coin') return json({ tickers: [{ base: 'ONE', target: 'USDT', market: { name: 'Exchange A', identifier: 'exa' }, converted_volume: { usd: 4e6 } }, { base: 'ONE', target: 'BTC', market: { name: 'Exchange B', identifier: 'exb' }, converted_volume: { usd: 1e6 } }, { base: T1.toUpperCase(), target: WETH, market: { name: 'Uniswap V3', identifier: 'uniswap_v3' }, converted_volume: { usd: 9e6 } }] });
    if (coin === 'three-coin') return json({ tickers: [{ base: T3, target: BWETH, market: { name: 'Uniswap V3 (Base)', identifier: 'uniswap-v3-base' }, converted_volume: { usd: 2e5 } }] });
    if (coin === 'ethereum') return json({ tickers: [{ base: 'ETH', target: 'USDT', market: { name: 'Exchange A', identifier: 'exa' }, converted_volume: { usd: 5e9 } }] });
    return notFound;
  }
  if (u.includes('coins.llama.fi/chart/')) {
    const keys = decodeURIComponent(u.split('/chart/')[1].split('?')[0]).split(',');
    const now = Math.floor(Date.now() / 1000);
    const coins = Object.fromEntries(keys.map((k, j) => [k, { prices: Array.from({ length: 31 }, (_, i) => ({ timestamp: now - (30 - i) * 86400, price: (USD[k.split(':')[1]] ?? 1) * Math.exp((i % 2 ? 1 : -1) * 0.01 * (j + 1)) })) }]));
    return json({ coins });
  }
  if ((init.method || 'GET') !== 'POST') return notFound;
  const chain = /base/.test(u) ? 'base' : 'ethereum';
  if (chain === 'base' && process.env.FAULT === 'base-slow') await new Promise((r) => setTimeout(r, 300));
  const b = JSON.parse(init.body);
  return json(Array.isArray(b) ? b.map((q) => rpc(chain, q)) : rpc(chain, b));
};
process.on('exit', () => process.stderr.write(`[fake-chains] RPC requests: ethereum ${calls.ethereum}, base ${calls.base}; GeckoTerminal requests: ${gtCalls}\n`)); // past the sealed log's console
await import('../../scripts/scan.mjs');
