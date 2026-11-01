// Offline world for scripts/scan.mjs (MOCKUP · MADE-UP NUMBERS): a synthetic pool list plus a fake
// chain whose maps, balances, slot0 and swaps all agree with made-up positions.
import fs from 'node:fs';
import { selector } from '../../lib/keccak.mjs';
import { amountsInRange, sqrtAtTick, amount0Delta } from '../../lib/v3math.mjs';
import { SWAP_TOPICS } from '../../lib/swaps.mjs';
import { ETHEREUM as C, ZERO } from '../../lib/pools.mjs';
const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const A = (c) => '0x' + c.repeat(40);
const T1 = A('1'), T2 = A('2'), UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', WETH = C.quotes[0].address, USDC = C.quotes[2].address;
const USD = { [T1]: 2, [T2]: 0.5, [UNI]: 7, [WETH]: 2250, [ZERO]: 2250, [USDC]: 1 };
const DEC = { [T1]: 18, [T2]: 6, [UNI]: 18, [WETH]: 18, [ZERO]: 18, [USDC]: 6 };
const r600 = (t) => Math.round(t / 600) * 600;
const SWAP = 10; // token0 per made-up swap, small next to each pool's liquidity
const mk = (tick, wallAbove, k = 1n) => [{ lo: r600(tick) - 1200, hi: r600(tick) + 1200, L: (10n ** 21n) / k }, { lo: -886800, hi: 886800, L: (10n ** 19n) / k }, { lo: r600(tick) + 6000, hi: r600(tick) + 9000, L: wallAbove / k }];
const tickOf = (p) => Math.floor(Math.log(p) / Math.log(1.0001));
const pools = [
  { v: 3, id: A('a'), t0: T1, t1: WETH, fee: 3000, ts: 60, tick: tickOf(2 / 2250), wall: 10n ** 23n }, // a big wall away from the price → stranded
  { v: 3, id: '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801', t0: UNI, t1: WETH, fee: 3000, ts: 60, tick: tickOf(7 / 2250), wall: 10n ** 19n },
  { v: 3, id: A('b'), t0: T2, t1: USDC, fee: 10000, ts: 200, tick: tickOf(0.5), wall: 0n, k: 10n ** 13n },
  { v: 4, id: '0x' + 'c'.repeat(64), t0: ZERO, t1: T1, fee: 3000, ts: 60, tick: tickOf(2250 / 2), wall: 10n ** 20n },
].map((p) => {
  const positions = mk(p.tick, p.wall, p.k).filter((x) => x.L > 0n);
  const net = new Map();
  for (const q of positions) { net.set(q.lo, (net.get(q.lo) || 0n) + q.L); net.set(q.hi, (net.get(q.hi) || 0n) - q.L); }
  const L = positions.filter((q) => q.lo <= p.tick && p.tick < q.hi).reduce((s, q) => s + q.L, 0n);
  const sp = sqrtAtTick(p.tick + 0.5);
  let a0 = 0, a1 = 0;
  for (const q of positions) { const [x, y] = amountsInRange(q.L, q.lo, q.hi, sp); a0 += x; a1 += y; }
  const tvl = (a0 / 10 ** DEC[p.t0]) * USD[p.t0] + (a1 / 10 ** DEC[p.t1]) * USD[p.t1];
  return { ...p, net, L, sp, bal0: BigInt(Math.floor(a0 * 1.002)), bal1: BigInt(Math.floor(a1 * 1.002)), tvl: tvl * 1.002 };
});
const list = {
  t: Date.now(), block: 20000000,
  v3: pools.filter((p) => p.v === 3).map((p) => ({ id: p.id, t0: p.t0, t1: p.t1, fee: p.fee, tvl: p.tvl, aggReserveUsd: p.tvl * 0.98, aggVolumeUsd24h: 12 * SWAP * USD[p.t0] })),
  v4: pools.filter((p) => p.v === 4).map((p) => ({ id: p.id, t0: p.t0, t1: p.t1, fee: p.fee, tickSpacing: p.ts, hooks: ZERO, liquidity: String(p.L), aggReserveUsd: 2e6, aggVolumeUsd24h: null })),
  tokens: Object.keys(DEC).map((a) => ({ address: a, decimals: DEC[a], symbol: { [T1]: 'ONE', [T2]: 'TWO', [UNI]: 'UNI', [WETH]: 'WETH', [ZERO]: 'ETH', [USDC]: 'USDC' }[a], usd: USD[a], quote: [WETH, USDC, ZERO].includes(a) })),
};
console.error('[fake] tvl', pools.map((p) => Math.round(p.tvl)).join(', '));
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/pools-ethereum.json', JSON.stringify(list));
const S = { ts: selector('getCurrentBlockTimestamp()'), fg0: selector('feeGrowthGlobal0X128()'), fg1: selector('feeGrowthGlobal1X128()'), fg4: selector('getFeeGrowthGlobals(bytes32)'), s0: selector('slot0()'), liq: selector('liquidity()'), bm3: selector('tickBitmap(int16)'), t3: selector('ticks(int24)'), s4: selector('getSlot0(bytes32)'), l4: selector('getLiquidity(bytes32)'), bm4: selector('getTickBitmap(bytes32,int16)'), t4: selector('getTickLiquidity(bytes32,int24)') };
const wobble = (p, k) => BigInt(Math.floor(p.sp * Math.exp(k ? (k % 2 ? 0.01 : -0.01) : 0) * 2 ** 96));
const sqrtX96 = (p, tag) => { const k = tag ? Math.round((BLOCK - parseInt(tag, 16)) / 7200) : 0; return k === 0 ? p.sim.end : wobble(p, k); };
const BASE_FG = 10n ** 40n;
// The day's swaps as the pool books them: 12 sells of SWAP token0 from the window-start price, each
// inside one stretch of liquidity; the fee counter grows by (fee − protocol cut) ÷ liquidity per swap.
for (const p of pools) {
  let P = wobble(p, 1), fg = 0n;
  const amt0 = BigInt(SWAP) * 10n ** BigInt(DEC[p.t0]), fee = BigInt(p.fee), steps = [];
  for (let k = 11; k >= 0; k--) {
    const lessFee = (amt0 * (1000000n - fee)) / 1000000n, L = p.L;
    const n1 = L << 96n, den = n1 + lessFee * P, next = (n1 * P + den - 1n) / den; // getNextSqrtPriceFromAmount0RoundingUp
    const f = amt0 - amount0Delta(next, P, L, true), cut = p.v === 3 && p.id === A('a') ? f / 4n : 0n;
    fg += ((f - cut) << 128n) / L;
    steps[k] = next; P = next;
  }
  p.sim = { steps, end: P, fg };
}
const fgDelta = (p) => p.sim.fg;
function answer(target, data, tag) {
  const t = target.toLowerCase(), sel = data.slice(0, 10), v4 = [S.s4, S.l4, S.bm4, S.t4, S.fg4].includes(sel);
  if (t === '0xca11bde05977b3631167028862be2a173976ca11' && sel === S.ts) return W(Math.floor(Date.now() / 1000) - (BLOCK - parseInt(tag, 16)) * 12);
  const p = v4 ? pools.find((x) => x.id === '0x' + data.slice(10, 74)) : pools.find((x) => x.id === t);
  if (!p) return null;
  const arg = () => Number(BigInt.asIntN(256, BigInt('0x' + (v4 ? data.slice(74, 138) : data.slice(10, 74)))));
  const isNow = tag === '0x' + BLOCK.toString(16);
  if (sel === S.fg0) return W(BASE_FG + (isNow ? fgDelta(p) : 0n));
  if (sel === S.fg1) return W(BASE_FG);
  if (sel === S.fg4) return W(BASE_FG + (isNow ? fgDelta(p) : 0n)) + W(BASE_FG);
  if (sel === S.s0) return W(sqrtX96(p, tag)) + W(p.tick) + W(0) + W(1) + W(1) + W(p.id === A('a') && process.env.FAULT !== 'protocol' ? 0x44 : 0) + W(1);
  if (sel === S.s4) return W(sqrtX96(p, tag)) + W(p.tick) + W(0) + W(p.fee);
  if (sel === S.liq || sel === S.l4) return W(p.L);
  if (sel === S.bm3 || sel === S.bm4) { let bm = 0n; for (const k of p.net.keys()) { const c = k / p.ts, wi = Math.floor(c / 256); if (wi === arg()) bm |= 1n << BigInt(c - wi * 256); } return W(bm); }
  if (sel === S.t3 || sel === S.t4) { const n = p.net.get(arg()) || 0n; return W(n < 0n ? -n : n) + W(n) + (sel === S.t3 ? W(0).repeat(6) : ''); }
  return null;
}
function aggregate3(data, tag) {
  const h = data.slice(10), word = (o) => BigInt('0x' + h.slice(o * 2, o * 2 + 64)), n = Number(word(32));
  let off = 32 * n, head = '', body = '';
  for (let i = 0; i < n; i++) {
    const e = 64 + Number(word(64 + 32 * i)), target = '0x' + h.slice(e * 2 + 24, e * 2 + 64);
    const len = Number(word(e + Number(word(e + 64)))), cd = '0x' + h.slice((e + 128) * 2, (e + 128 + len) * 2);
    const r = answer(target, cd, tag), ok = r != null, d = ok ? r : '', el = W(ok ? 1 : 0) + W(0x40) + W(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    head += W(off); body += el; off += el.length / 2;
  }
  return '0x' + W(0x20) + W(n) + head + body;
}
const BLOCK = 20001000;
function swapsFor(f) {
  const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16), out = [];
  for (const p of pools) {
    const v4 = p.v === 4;
    if (v4 ? !(typeof f.address === 'string' && f.address.toLowerCase() === C.v4PoolManager && f.topics[1].includes(p.id)) : !(Array.isArray(f.address) && f.address.includes(p.id))) continue;
    for (let k = 0; k < 12; k++) {
      const b = BLOCK - 100 - k * 500;
      if (b < from || b > to) continue;
      const amt0 = BigInt(SWAP) * 10n ** BigInt(DEC[p.t0]); // SWAP token0 in
      const amt1 = BigInt(Math.floor(SWAP * (USD[p.t0] / USD[p.t1]) * 10 ** DEC[p.t1]));
      const data = v4 ? W(-amt0) + W(amt1) + W(p.sim.steps[k]) + W(p.L) + W(p.tick) + W(p.fee) : W(amt0) + W(-amt1) + W(p.sim.steps[k]) + W(p.L) + W(p.tick);
      out.push({ address: v4 ? C.v4PoolManager : p.id, topics: v4 ? [SWAP_TOPICS.v4, p.id, '0x' + W(7)] : [SWAP_TOPICS.v3, '0x' + W(7), '0x' + W(8)], data: '0x' + data, blockNumber: '0x' + b.toString(16), logIndex: '0x' + k.toString(16), transactionHash: '0xt' + p.id.slice(2, 8) + k });
    }
  }
  return out;
}
function rpc(q) {
  const r = (result) => ({ jsonrpc: '2.0', id: q.id, result });
  if (q.method === 'eth_blockNumber') return r('0x' + BLOCK.toString(16));
  if (q.method === 'eth_gasPrice') return r('0x' + (2e9).toString(16));
  if (q.method === 'eth_call' && q.params[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return r(aggregate3(q.params[0].data, q.params[1]));
  if (q.method === 'eth_getLogs') { const f = q.params[0]; if (parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) > 1500) return { jsonrpc: '2.0', id: q.id, error: { code: -32005, message: 'range too large' } }; return r(swapsFor(f)); }
  return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'no' } };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.coingecko.com') && u.includes('/market_chart')) { // hourly for 30 days; UNI is left to the DefiLlama fallback
    const addr = u.split('/contract/')[1].split('/')[0], j = Object.keys(USD).indexOf(addr);
    if (addr === UNI || j < 0) return { ok: false, status: 404, json: async () => ({ error: 'coin not found' }) };
    const now = Date.now();
    const prices = Array.from({ length: 721 }, (_, i) => { const t = now - (720 - i) * 3600e3, d = Math.floor((now - t) / 86400e3); return [t, USD[addr] * Math.exp((d % 2 ? 1 : -1) * 0.01 * (j + 1))]; });
    return { ok: true, status: 200, json: async () => ({ prices }) };
  }
  if (u.includes('coins.llama.fi/chart/')) {
    const keys = decodeURIComponent(u.split('/chart/')[1].split('?')[0]).split(',');
    const now = Math.floor(Date.now() / 1000);
    const coins = Object.fromEntries(keys.map((k, j) => [k, { prices: Array.from({ length: 31 }, (_, i) => ({ timestamp: now - (30 - i) * 86400, price: (USD[k.split(':')[1]] ?? 1) * Math.exp((i % 2 ? 1 : -1) * 0.01 * (j + 1)) })) }]));
    return { ok: true, status: 200, json: async () => ({ coins }) };
  }
  const b = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => (Array.isArray(b) ? b.map(rpc) : rpc(b)) };
};
await import('../../scripts/scan.mjs');
