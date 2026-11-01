// Offline world for scripts/pools.mjs: made-up tokens, pools and API answers (MOCKUP · MADE-UP NUMBERS).
import { selector } from '../../lib/keccak.mjs';
import { v4PoolId, TOPICS, ETHEREUM as C, ZERO } from '../../lib/pools.mjs';
const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const A = (c) => '0x' + c.repeat(40);
const T1 = A('1'), T2 = A('2'), UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const WETH = C.quotes[0].address, USDC = C.quotes[2].address;
const DEC = new Map([[T1, 18], [T2, 6], [UNI, 18], ...C.quotes.map((q) => [q.address, q.decimals])]);
const sort = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
// v3 pools: [tokenA, tokenB, fee, poolAddr, bal0, bal1]; T1/WETH 0.3% holds ~$1.2M, T2/USDC 1% ~$40k
const ETHUSD = 2250;
const v3 = [
  [T1, WETH, 3000, A('a'), 300000n * 10n ** 18n, 2n * 10n ** 17n * 1000n], // 300k T1 ($2) + 200 WETH
  [T2, USDC, 10000, A('b'), 40000n * 10n ** 6n, 20000n * 10n ** 6n],
  [UNI, WETH, 3000, '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801', 100000n * 10n ** 18n, 300n * 10n ** 18n],
].map(([x, y, fee, id, b0, b1]) => { const [t0, t1] = sort(x, y); return { t0, t1, fee, id, b0, b1 }; });
const v4keys = [{ currency0: ZERO, currency1: T1, fee: 3000, tickSpacing: 60 }].map((k) => ({ ...k, id: v4PoolId(k) }));
const hooked = v4PoolId({ currency0: ZERO, currency1: T1, fee: 0x800000, tickSpacing: 60, hooks: A('c') });
const S = { pk: selector('poolKeys(bytes25)'), dec: selector('decimals()'), gp: selector('getPool(address,address,uint24)'), s4: selector('getSlot0(bytes32)'), l4: selector('getLiquidity(bytes32)'), s0: selector('slot0()'), liq: selector('liquidity()'), bal: selector('balanceOf(address)') };
const sqrtFor = (p) => BigInt(Math.floor(Math.sqrt(p) * 2 ** 96)); // p = raw token1 per raw token0
function answer(target, data) {
  const t = target.toLowerCase(), sel = data.slice(0, 10), arg = (i) => data.slice(10 + 64 * i, 74 + 64 * i);
  const addr = (i) => '0x' + arg(i).slice(24);
  if (sel === S.pk && t === C.v4PositionManager) { return data.slice(10, 60) === hooked.slice(2, 52) ? W(0) + W(T1) + W(0x800000) + W(60) + W(A('c')) : W(0).repeat(5); }
  if (sel === S.dec) return DEC.has(t) ? W(DEC.get(t)) : null;
  if (sel === S.gp && t === C.v3Factory) { const p = v3.find((p) => p.t0 === addr(0) && p.t1 === addr(1) && p.fee === Number(BigInt('0x' + arg(2)))); return W(p ? p.id : 0); }
  if (sel === S.s4 && t === C.v4StateView) { const id = '0x' + arg(0); const k = v4keys.find((k) => k.id === id); if (k) return W(sqrtFor(2 / ETHUSD)) + W(-80000) + W(0) + W(3000); if (id === hooked) return W(sqrtFor(2 / ETHUSD)) + W(-80000) + W(0) + W(0x800000); return W(0) + W(0) + W(0) + W(0); }
  if (sel === S.l4) return W(10n ** 20n);
  const pool = v3.find((p) => p.id === t);
  if (pool && sel === S.s0) { const d0 = DEC.get(pool.t0), d1 = DEC.get(pool.t1); const px = pool.t1 === WETH ? (pool.t0 === UNI ? 7 / ETHUSD : 2 / ETHUSD) : 0.5; return W(sqrtFor(px * 10 ** (d1 - d0))) + W(-1000) + W(0) + W(1) + W(1) + W(0) + W(1); }
  if (pool && sel === S.liq) return W(10n ** 18n);
  if (sel === S.bal) { const p = v3.find((p) => p.id === addr(0)); if (!p) return W(0); return W(t === p.t0 ? p.b0 : p.b1); }
  return null;
}
function aggregate3(data) {
  const h = data.slice(10), word = (o) => BigInt('0x' + h.slice(o * 2, o * 2 + 64)), n = Number(word(32));
  let off = 32 * n, head = '', body = '';
  for (let i = 0; i < n; i++) {
    const e = 64 + Number(word(64 + 32 * i)), target = '0x' + h.slice(e * 2 + 24, e * 2 + 64);
    const len = Number(word(e + Number(word(e + 64)))), cd = '0x' + h.slice((e + 128) * 2, (e + 128 + len) * 2);
    const r = answer(target, cd), ok = r != null, d = ok ? r : '', el = W(ok ? 1 : 0) + W(0x40) + W(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    head += W(off); body += el; off += el.length / 2;
  }
  return '0x' + W(0x20) + W(n) + head + body;
}
const BLOCK = 20000000;
const createdLogs = v3.map((p, i) => ({ address: C.v3Factory, topics: [TOPICS.poolCreated, '0x' + W(p.t0), '0x' + W(p.t1), '0x' + W(p.fee)], data: '0x' + W(60) + W(p.id),
  blockNumber: '0x' + (i === 0 ? BLOCK - 1000 : 13000000 + i).toString(16), timeStamp: '0x' + Math.floor(Date.now() / 1000 - (i === 0 ? 3 : 900) * 86400).toString(16), transactionHash: '0xtx' + i, logIndex: '0x0' }));
function rpc(q) {
  const r = (result) => ({ jsonrpc: '2.0', id: q.id, result });
  if (q.method === 'eth_blockNumber') return r('0x' + BLOCK.toString(16));
  if (q.method === 'eth_getBlockByNumber') return r({ number: '0x' + BLOCK.toString(16), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) });
  if (q.method === 'eth_getLogs' && q.params[0].topics?.[0] === TOPICS.initialize) {
    const f = parseInt(q.params[0].fromBlock, 16), t = parseInt(q.params[0].toBlock, 16), b = BLOCK - 500;
    if (b < f || b > t) return r([]);
    const ev = (c0, c1, fee, ts, hk) => ({ address: C.v4PoolManager, topics: [TOPICS.initialize, v4PoolId({ currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks: hk }), '0x' + W(c0), '0x' + W(c1)], data: '0x' + W(fee) + W(ts) + W(hk) + W(1n << 96n) + W(0), blockNumber: '0x' + b.toString(16), logIndex: '0x1', transactionHash: '0xinit' + fee });
    return r([ev(ZERO, T2, 2500, 50, A('d')), ev(ZERO, A('7'), 0, 200, A('d'))]);
  }
  if (q.method === 'eth_call' && q.params[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') return r(aggregate3(q.params[0].data));
  if (q.method === 'eth_getLogs') { const f = parseInt(q.params[0].fromBlock, 16), t = parseInt(q.params[0].toBlock, 16); return r(createdLogs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= f && b <= t; })); }
  return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'no' } };
}
const markets = [{ id: 't1', symbol: 'one', market_cap_rank: 150, current_price: 2 }, { id: 't2', symbol: 'two', market_cap_rank: 900, current_price: 0.5 }, { id: 'uniswap', symbol: 'uni', market_cap_rank: 25, current_price: 7 }, { id: 'nochain', symbol: 'nc', market_cap_rank: 400, current_price: 1 }];
const list = [{ id: 't1', platforms: { ethereum: T1 } }, { id: 't2', platforms: { ethereum: T2 } }, { id: 'uniswap', platforms: { ethereum: UNI } }, { id: 'nochain', platforms: {} }];
const ds = { [T1]: [
  { chainId: 'ethereum', dexId: 'uniswap', labels: ['v3'], pairAddress: A('a'), baseToken: { address: T1 }, quoteToken: { address: WETH, symbol: 'WETH' }, liquidity: { usd: 1.1e6 } },
  { chainId: 'ethereum', dexId: 'uniswap', labels: ['v4'], pairAddress: hooked, baseToken: { address: T1 }, quoteToken: { address: ZERO, symbol: 'ETH' }, liquidity: { usd: 5e5 } },
  { chainId: 'ethereum', dexId: 'uniswap', labels: ['v3'], pairAddress: A('d'), baseToken: { address: T1 }, quoteToken: { address: A('9'), symbol: 'USDe' }, liquidity: { usd: 4e5 } }],
  [UNI]: [{ chainId: 'ethereum', dexId: 'uniswap', labels: ['v3'], pairAddress: '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801', baseToken: { address: UNI }, quoteToken: { address: WETH, symbol: 'WETH' }, liquidity: { usd: 1.4e6 } }] };
let n = 0; const MODE = process.env.FAKE_MODE || '';
globalThis.fetch = async (url, init = {}) => {
  n++;
  const u = String(url), json = (x) => ({ ok: true, status: 200, json: async () => x });
  if ((init.method || 'GET') === 'POST') { const b = JSON.parse(init.body); return json(Array.isArray(b) ? b.map(rpc) : rpc(b)); }
  if (u.includes('/coins/markets')) return json(u.includes('page=1&') ? markets : []);
  if (u.includes('/coins/list')) return json(list);
  if (u.includes('coins.llama.fi')) return json({ coins: Object.fromEntries(C.quotes.filter((q) => q.address !== ZERO).map((q) => [`ethereum:${q.address}`, { price: q.symbol === 'WETH' ? ETHUSD : q.symbol === 'WBTC' ? 70000 : 1, timestamp: Date.now() / 1000 - 60, confidence: 0.99 }])) });
  if (u.includes('eth.blockscout.com/api?') && MODE === 'refuse') return json({ status: '0', message: 'NOTOK', result: 'Query timeout' });
  if (u.includes('eth.blockscout.com/api?')) { const q = new URL(u).searchParams, f = +q.get('fromBlock'), t = +q.get('toBlock'); const rows = createdLogs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= f && b <= t; }).sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)); return json(rows.length ? { status: '1', result: rows } : { status: '0', message: 'No logs found', result: [] }); }
  if (u.includes('dexscreener') && MODE === 'refuse') throw new Error('HTTP 429');
  if (u.includes('dexscreener')) { const tok = u.split('/').pop(); return json(ds[tok] || []); }
  if (u.includes('geckoterminal')) { const tok = u.split('/tokens/')[1].split('/')[0]; return json({ data: (ds[tok] || []).map((p) => ({ attributes: { address: p.pairAddress, name: `X / ${p.quoteToken.symbol}`, reserve_in_usd: String(p.liquidity.usd) }, relationships: { base_token: { data: { id: 'eth_' + p.baseToken.address } }, quote_token: { data: { id: 'eth_' + p.quoteToken.address } }, dex: { data: { id: p.labels[0] === 'v4' ? 'uniswap-v4-ethereum' : 'uniswap_v3' } } } })) }); }
  return { ok: false, status: 404, json: async () => ({}) };
};
process.on('exit', () => console.error(`[fake] ${n} requests`));
await import('../../scripts/pools.mjs');
