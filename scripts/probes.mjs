// Phase 0, step 1: what answers from a GitHub runner, are the contract facts right, and does the
// liquidity-map method reproduce a real pool? Public data only: pass/fail, counts, ratios, block
// numbers and market data. No addresses are printed.
import fs from 'node:fs';
import { makeRpc, getJson, mapLimit } from '../lib/rpc.mjs';
import { encodeCall, decodeWords, signed, toAddress } from '../lib/abi.mjs';
import { topic } from '../lib/keccak.mjs';
import { liquidityMap, ticksInWord, bitmapWordRange, sqrtX96ToSqrt, ticksForLog } from '../lib/v3math.mjs';
import { bandStats, hollowness, depthHistogram, nearestWalls, shapeTag } from '../lib/shape.mjs';
import { readGas, readPrices, gasStats, COINS } from '../lib/market.mjs';
import { CHAINS, ageOfBlocksBack, blocksBack as backFor, timeOfBlock } from '../lib/chains.mjs';
import { ROUTERS, routerName } from '../lib/routers.mjs';
import { PANCAKE_V3, BASE as BASE_C, ETHEREUM as ETH_C, TOPICS as POOL_TOPICS, v3LpKeeps, decodeInitialize } from '../lib/pools.mjs';
import { SWAP_TOPICS, decodeSwap, swapFees } from '../lib/swaps.mjs';
import { parseTickers, VENUES, parseCoinbaseStats, parseCoinbaseProducts, parseKraken, parseOkx, parseGate, parseKucoin, venueVolumes, exchangeVolumes } from '../lib/cex.mjs';
import { dailyHistory, geckoTerminalHistory } from '../lib/history.mjs';
import { parseDexScreenerPairs } from '../lib/aggregators.mjs';
import { pastBlockAnswer } from '../lib/snapshots.mjs';
import { readVerified } from '../lib/etherscan.mjs';

const ETH_RPCS = {
  publicnode: 'https://ethereum-rpc.publicnode.com', drpc: 'https://eth.drpc.org', '1rpc': 'https://1rpc.io/eth',
  llamarpc: 'https://eth.llamarpc.com', mevblocker: 'https://rpc.mevblocker.io', flashbots: 'https://rpc.flashbots.net',
  blockscout: 'https://eth.blockscout.com/api/eth-rpc',
};
const BASE_RPCS = {
  base: 'https://mainnet.base.org', publicnode: 'https://base-rpc.publicnode.com', drpc: 'https://base.drpc.org', '1rpc': 'https://1rpc.io/base',
};
const APIS = {
  geckoterminal: 'https://api.geckoterminal.com/api/v2/networks?page=1',
  dexscreener: 'https://api.dexscreener.com/latest/dex/search?q=UNI%20WETH',
  defillama: 'https://coins.llama.fi/prices/current/coingecko:ethereum',
  coingecko: 'https://api.coingecko.com/api/v3/ping',
  coinbase: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
  'coinbase exchange': 'https://api.exchange.coinbase.com/products/ETH-USD/stats',
  goplus: 'https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
};
const ETH = {
  v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  v4StateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  bench: '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801', // UNI/WETH 0.3%, the first v3 pool ever created
  v4EthUsdc: '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27', // ETH/USDC 0.05% pool id
};
const BASE = {
  v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const results = [];
const pct = (x) => (x == null ? '—' : x < 0.1 || x > 0.9 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
function say(ok, area, msg) {
  results.push({ ok, area, msg });
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'N/A '} ${area}: ${msg}`);
}

async function rawBatchWorks(url) {
  try {
    const r = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }]) }, 10000);
    return Array.isArray(r) && r.length === 2 && r.every((x) => x && x.result);
  } catch { return false; }
}

async function probeRpcs(chain, rpcs, chainId) {
  const ok = [];
  for (const [label, url] of Object.entries(rpcs)) {
    const r = makeRpc([url], { timeout: 10000, maxRefusals: 1 });
    const t0 = Date.now();
    const id = await r.call('eth_chainId', []);
    const bn = id === chainId ? await r.call('eth_blockNumber', []) : null;
    const good = bn != null;
    if (good) ok.push(url);
    say(good, `rpc ${chain} ${label}`, good ? `block ${parseInt(bn, 16)}, ${Date.now() - t0} ms, batch ${(await rawBatchWorks(url)) ? 'yes' : 'no'}` : 'no answer');
  }
  return ok;
}

async function probeApis() {
  for (const [label, url] of Object.entries(APIS)) {
    try {
      const j = await getJson(url, { headers: { accept: 'application/json' } }, 12000);
      const fact = label === 'defillama' ? `ETH $${Math.round(j?.coins?.['coingecko:ethereum']?.price ?? NaN)}` : `${Object.keys(j || {}).length} top-level keys`;
      say(true, `api ${label}`, fact);
    } catch (e) {
      say(false, `api ${label}`, String(e.message || e).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 40));
    }
  }
}

// The top strip's market block (lib/market.mjs): which host serves each value. Market data only.
async function probeMarket(rpc) {
  const g = await readGas(rpc, { timeoutMs: 20000 });
  const s = g ? gasStats(g.gwei, [], g.blocks) : null;
  say(g ? g.source === 'feeHistory' : null, 'market gas', g ? `${g.gwei.toFixed(2)} gwei from ${g.source}${g.blocks ? ` over ${g.blocks.length} blocks` : ''}; vs those blocks: ${s.band ?? '—'} (p10 ${s.p10 ?? '—'}, p50 ${s.p50 ?? '—'}, p90 ${s.p90 ?? '—'})` : 'unread');
  const ll = await readPrices(async (url, init, t) => (url.includes('coingecko.com') ? null : getJson(url, init, t)), { timeoutMs: 15000 });
  // the fallback (lib/market.mjs): with DefiLlama and CoinGecko blocked, Coinbase must answer all three
  const cb = await readPrices(async (url, init, t) => (/llama|coingecko\.com/.test(url) ? null : getJson(url, init, t)), { timeoutMs: 15000 });
  const fmt = (r) => Object.keys(COINS).map((k) => `${k} ${r.px[k].usd == null ? '—' : '$' + r.px[k].usd} (${r.px[k].ch24 == null ? '—' : (r.px[k].ch24 * 100).toFixed(1) + '%'})`).join(', ');
  say(ll.read === 3 ? true : ll.read ? null : false, 'market defillama', fmt(ll));
  say(cb.read === 3 && Object.values(cb.px).every((x) => x.src === 'coinbase') ? true : cb.read ? null : false, 'market coinbase', fmt(cb));
  // token history fallbacks (lib/history.mjs) for UNI, the public benchmark token: DefiLlama's chart, then GeckoTerminal's
  const k = `ethereum:${ETH.UNI.toLowerCase()}`;
  const lh = await dailyHistory(getJson, [k], { spacingMs: 0 });
  const lp = lh.series.get(k);
  say(lp?.length >= 25 ? true : lp ? null : false, 'history defillama', lp ? `UNI ${lp.length} daily points` : `unread${lh.lastError ? ` (${lh.lastError})` : ''}`);
  const gt = await geckoTerminalHistory(getJson, [k], { spacingMs: 2500 });
  const gp = gt.series.get(k);
  say(gp?.length >= 500 ? true : gp ? null : false, 'history geckoterminal', gp ? `UNI ${gp.length} hourly points in ${gt.calls} calls, newest ${Math.round((Date.now() / 1000 - gp.at(-1).t) / 60)} min old` : `unread${gt.lastError ? ` (${gt.lastError})` : ''}`);
}

async function probeContracts(eth, base) {
  const hasCode = async (rpc, a) => { const c = await rpc.call('eth_getCode', [a, 'latest']); return c == null ? null : c.length > 2; };
  const pool = decodeWords(await eth.ethCall(ETH.v3Factory, encodeCall('getPool(address,address,uint24)', [{ t: 'address', v: ETH.UNI }, { t: 'address', v: ETH.WETH }, { t: 'uint', v: 3000 }])));
  say(pool ? toAddress(pool[0]) === ETH.bench : null, 'contract eth v3 factory', pool ? `UNI/WETH 0.3% resolves to the benchmark pool: ${toAddress(pool[0]) === ETH.bench ? 'yes' : 'no'}` : 'unread');
  for (const [name, a] of [['multicall3', ETH.multicall3], ['v4 pool manager', ETH.v4PoolManager], ['v4 state view', ETH.v4StateView]]) {
    const c = await hasCode(eth, a);
    say(c, `contract eth ${name}`, c == null ? 'unread' : c ? 'code present' : 'no code');
  }
  const s = decodeWords(await eth.ethCall(ETH.v4StateView, encodeCall('getSlot0(bytes32)', [{ t: 'bytes32', v: ETH.v4EthUsdc }])));
  if (s && s[0] > 0n) {
    const sp = sqrtX96ToSqrt(s[0]);
    say(true, 'contract eth v4 ETH/USDC 0.05%', `slot0 read; ETH ≈ $${Math.round(sp * sp * 1e12)}; lp fee ${Number(s[3]) / 1e4}%`);
  } else say(s ? false : null, 'contract eth v4 ETH/USDC 0.05%', s ? 'empty slot0' : 'unread');
  const bpool = decodeWords(await base.ethCall(BASE.v3Factory, encodeCall('getPool(address,address,uint24)', [{ t: 'address', v: BASE.WETH }, { t: 'address', v: BASE.USDC }, { t: 'uint', v: 500 }])));
  say(bpool ? bpool[0] !== 0n : null, 'contract base v3 factory', bpool ? `WETH/USDC 0.05% pool exists: ${bpool[0] !== 0n ? 'yes' : 'no'}` : 'unread');
  const c = await hasCode(base, BASE.v4PoolManager);
  say(c, 'contract base v4 pool manager', c == null ? 'unread' : c ? 'code present' : 'no code');
}

// Archive state: can the node answer a read at an old block? (Needed for maps from weeks ago.)
async function probeArchive(rpcs) {
  const ok = [];
  for (const [label, url] of Object.entries(rpcs)) {
    const r = makeRpc([url], { timeout: 12000, maxRefusals: 1 });
    const v = await r.call('eth_call', [{ to: ETH.WETH, data: encodeCall('totalSupply()') }, '0x' + (15000000).toString(16)]);
    const good = decodeWords(v)?.length === 1 && decodeWords(v)[0] > 0n;
    if (good) ok.push(label);
    say(good ? true : null, `archive eth ${label}`, good ? 'state at block 15,000,000 served' : 'no archive state');
  }
  return ok;
}

async function probeLogs(rpc, chain, blocks) {
  const bn = await rpc.call('eth_blockNumber', []);
  if (bn == null) return say(null, `logs ${chain}`, 'no block number');
  const to = parseInt(bn, 16), from = to - blocks + 1;
  const logs = await rpc.call('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
    topics: [[topic('Mint(address,address,int24,int24,uint128,uint256,uint256)'), topic('Burn(address,int24,int24,uint128,uint256,uint256)')]] }]);
  say(Array.isArray(logs) ? true : null, `logs ${chain}`, Array.isArray(logs) ? `${logs.length} v3-style Mint/Burn events in the last ${blocks} blocks` : 'unread (not counted as zero)');
}

// Rebuild the benchmark pool's liquidity map at one fixed block and check it reproduces the pool.
async function probeMap(rpc) {
  const started = Date.now();
  const bn = await rpc.call('eth_blockNumber', []);
  if (bn == null) return say(null, 'map UNI/WETH 0.3%', 'no block number'), null;
  const at = (data) => ({ method: 'eth_call', params: [{ to: ETH.bench, data }, bn] });
  const [s0, liq, sp0] = await rpc.batch([at(encodeCall('slot0()')), at(encodeCall('liquidity()')), at(encodeCall('tickSpacing()'))]);
  const w0 = decodeWords(s0), wl = decodeWords(liq), wt = decodeWords(sp0);
  if (!w0 || w0.length < 7 || !wl?.length || !wt?.length) return say(null, 'map UNI/WETH 0.3%', 'pool state unread'), null;
  const sqrtX96 = w0[0], tickCurrent = Number(signed(w0[1])), feeProtocol = Number(w0[5]), liquidity = wl[0], spacing = Number(signed(wt[0]));
  const { lo, hi } = bitmapWordRange(spacing);
  const words = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const maps = await rpc.batch(words.map((w) => at(encodeCall('tickBitmap(int16)', [{ t: 'int', v: w }]))));
  const unreadWords = maps.filter((x) => decodeWords(x)?.length !== 1).length;
  if (unreadWords) return say(null, 'map UNI/WETH 0.3%', `${unreadWords} of ${words.length} bitmap words unread`), null;
  const ticks = words.flatMap((w, i) => ticksInWord(w, decodeWords(maps[i])[0], spacing));
  const rows = await rpc.batch(ticks.map((t) => at(encodeCall('ticks(int24)', [{ t: 'int', v: t }]))));
  const unreadTicks = rows.filter((x) => (decodeWords(x)?.length ?? 0) < 2).length;
  if (unreadTicks) return say(null, 'map UNI/WETH 0.3%', `${unreadTicks} of ${ticks.length} ticks unread`), null;
  const m = liquidityMap({ ticks: ticks.map((t, i) => ({ tick: t, liquidityNet: signed(decodeWords(rows[i])[1]) })), tickCurrent, liquidity });
  const secs = Math.round((Date.now() - started) / 1000);
  say(m.checks.netSumZero, 'map UNI/WETH 0.3%', `${m.checks.initialized} initialized ticks at block ${parseInt(bn, 16)} (${secs} s); liquidity adds up to zero across all ticks: ${m.checks.netSumZero ? 'yes' : 'no'}`);
  say(m.checks.matchesPool, 'map UNI/WETH 0.3%', `walk reproduces the pool's own liquidity at the price: ${m.checks.matchesPool ? 'yes' : 'no'}`);
  say(m.checks.neverNegative, 'map UNI/WETH 0.3%', `liquidity never negative along the walk: ${m.checks.neverNegative ? 'yes' : 'no'}`);
  const sp = sqrtX96ToSqrt(sqrtX96); // UNI and WETH both have 18 decimals
  const shape = {};
  for (const r of [0.09, 0.2]) {
    const t = ticksForLog(r), b = bandStats(m.segments, sp, 18, tickCurrent - t, tickCurrent + t, tickCurrent);
    shape[r] = b;
    say(true, 'shape UNI/WETH 0.3%', `±${Math.round(r * 100)}% band holds ${pct(b.total ? b.inside / b.total : null)} of the value`);
  }
  const h = hollowness(m.segments, sp, 18, tickCurrent, m.checks.walkedLiquidity);
  say(true, 'shape UNI/WETH 0.3%', `stranded (value above the price's own level): ${pct(h.hollow)}, ${pct(h.aboveShare)} of it above the price (${shapeTag(h)})`);
  const w = nearestWalls(depthHistogram(m.segments, sp, 18, tickCurrent));
  const down = (x) => (x == null ? '—' : x === Infinity ? 'none in view' : `−${Math.round((1 - Math.exp(-x)) * 100)}%`);
  const up = (x) => (x == null ? '—' : x === Infinity ? 'none in view' : `+${Math.round((Math.exp(x) - 1) * 100)}%`);
  say(true, 'shape UNI/WETH 0.3%', `price ${(sp * sp).toPrecision(4)} WETH per UNI; ${shape[0.09].total.toFixed(0)} WETH of liquidity mapped; nearest wall ${down(w.below)} and ${up(w.above)}; protocol fee ${feeProtocol ? 'on' : 'off'}`);
  return m.checks;
}

// ---------- Base and PancakeSwap onboarding (8 Nov 2026): what the scanner needs from each chain and venue.
// Public data only: pass/fail, counts, ratios, block ages, router and venue names; no pool or tx addresses.
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const tsCall = encodeCall('getCurrentBlockTimestamp()');
const word0 = (h) => decodeWords(h)?.[0] ?? null;

// Which Base nodes serve old state: Multicall3's block timestamp at 1, 30 and 90 days back must be that old.
async function probeArchiveBase() {
  for (const url of CHAINS.base.rpcs) {
    const r = makeRpc([url], { timeout: 12000, maxRefusals: 3 });
    const bn = await r.call('eth_blockNumber', []);
    if (bn == null) { say(null, `archive base ${new URL(url).host}`, 'no block number'); continue; }
    const head = parseInt(bn, 16), nowSec = Math.floor(Date.now() / 1000), out = [];
    for (const d of [1, 7, 30, 90]) {
      const back = backFor(CHAINS.base, { block: head, nowSec, secBack: d * 86400 }), ts = word0(await r.call('eth_call', [{ to: MC3, data: tsCall }, '0x' + (head - back).toString(16)]));
      const ageSec = ageOfBlocksBack(CHAINS.base, { block: head, back, nowSec });
      out.push(`${d} d ${ts == null ? 'unread' : pastBlockAnswer(ts, { nowSec, blocksBack: back, ageSec }) ? `yes (${((nowSec - Number(ts)) / 86400).toFixed(2)} d old)` : `wrong state (${((nowSec - Number(ts)) / 86400).toFixed(2)} d old)`}`);
    }
    const clock = Math.round(Number((await r.call('eth_getBlockByNumber', [bn, false]))?.timestamp ?? NaN) - (CHAINS.base.eras.at(-1).t + (head - CHAINS.base.eras.at(-1).block) * CHAINS.base.eras.at(-1).sec));
    out.push(`head time vs the era clock ${Number.isFinite(clock) ? clock + ' s' : 'unread'}`);
    say(out.slice(0, 4).every((x) => / yes/.test(x)) ? true : null, `archive base ${new URL(url).host}`, out.join(', '));
  }
}

// How many blocks one eth_getLogs may span on each Base node (a busy pool's swaps).
async function probeLogsBase(base) {
  const pool = toAddress(decodeWords(await base.ethCall(BASE.v3Factory, encodeCall('getPool(address,address,uint24)', [{ t: 'address', v: BASE.WETH }, { t: 'address', v: BASE.USDC }, { t: 'uint', v: 500 }])))[0]);
  for (const url of CHAINS.base.rpcs) {
    const r = makeRpc([url], { timeout: 20000, maxRefusals: 9 });
    const head = parseInt(await r.call('eth_blockNumber', []) ?? '0x0', 16), out = [];
    for (const span of [1000, 2000, 10000]) {
      const logs = head ? await r.call('eth_getLogs', [{ address: pool, topics: [SWAP_TOPICS.v3], fromBlock: '0x' + (head - span + 1).toString(16), toBlock: '0x' + head.toString(16) }]) : null;
      out.push(`${span} blocks ${Array.isArray(logs) ? logs.length + ' swaps' : 'refused'}`);
    }
    say(out.some((x) => x.endsWith('swaps')) ? true : null, `logs base ${new URL(url).host}`, `WETH/USDC 0.05% (Uniswap v3): ${out.join(', ')}`);
  }
}

// A sample of swaps' transactions: which routers they were sent to (names only).
async function routerTally(rpc, chain, logs) {
  const txs = [...new Set(logs.map((l) => l.transactionHash))].slice(0, 30);
  const got = txs.length ? await rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))) : [];
  const read = got.filter((t) => t && t.to), names = new Map();
  for (const t of read) { const n = routerName(chain, t.to) ?? 'other'; names.set(n, (names.get(n) || 0) + 1); }
  return `tx.to read ${read.length} of ${txs.length}: ${[...names].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`;
}

// PancakeSwap v3: the factory finds a pool; fee, spacing and feeProtocol read; the Swap event's layout (our
// topic among the pool's logs) and its own protocol fee against our decode of feeProtocol.
async function probePancake(chain, rpc) {
  const ch = CHAINS[chain], q = ch.c.quotes, sym = (a) => q.find((x) => x.address === a)?.symbol;
  const pairs = chain === 'base' ? [[q[0].address, q[2].address], [q[3].address, q[0].address]] : [[q[0].address, q[2].address], [q[0].address, q[3].address], [q[5].address, q[0].address]];
  let pool = null, label = null;
  for (const [a, b] of pairs) for (const fee of [500, 100, 2500]) {
    if (pool) break;
    const w = decodeWords(await rpc.ethCall(PANCAKE_V3.factory, encodeCall('getPool(address,address,uint24)', [{ t: 'address', v: a }, { t: 'address', v: b }, { t: 'uint', v: fee }])));
    if (w && w[0] !== 0n) { pool = toAddress(w[0]); label = `${sym(a)}/${sym(b)} ${fee / 1e4}%`; }
  }
  if (!pool) return say(null, `pancakeswap ${chain}`, 'no pool found through the factory (or unread)');
  const [fee, ts, s0] = await rpc.batch([encodeCall('fee()'), encodeCall('tickSpacing()'), encodeCall('slot0()')].map((d) => ({ method: 'eth_call', params: [{ to: pool, data: d }, 'latest'] })));
  const f = Number(word0(fee) ?? NaN), sp = Number(signed(word0(ts) ?? 0n)), w0 = decodeWords(s0), fp = w0?.length >= 7 ? Number(w0[5]) : null;
  const keeps = fp == null ? null : v3LpKeeps(fp, 'pancakeswap');
  say(keeps && Number.isFinite(f) ? keeps.every((k) => k > 0.5 && k <= 1) && PANCAKE_V3.spacing[f] === sp : null, `pancakeswap ${chain}`, `${label}: fee ${f / 1e4}%, tick spacing ${sp} (expected ${PANCAKE_V3.spacing[f] ?? '—'}); LPs keep ${keeps ? keeps.map((k) => (k * 100).toFixed(1) + '%').join(' / ') : '—'} (as Uniswap nibbles it would read ${fp == null ? '—' : (v3LpKeeps(fp & 0xff) || []).map((k) => (k * 100).toFixed(1) + '%').join(' / ') || 'invalid'})`);
  const head = parseInt(await rpc.call('eth_blockNumber', []) ?? '0x0', 16), span = chain === 'base' ? 5000 : 3000;
  const logs = head ? await rpc.call('eth_getLogs', [{ address: pool, fromBlock: '0x' + (head - span + 1).toString(16), toBlock: '0x' + head.toString(16) }]) : null;
  if (!Array.isArray(logs)) return say(null, `pancakeswap ${chain} events`, 'logs unread');
  const t0 = logs.map((l) => String(l.topics?.[0] || '').toLowerCase());
  const ours = logs.filter((l, i) => t0[i] === SWAP_TOPICS.pcs3), uni = t0.filter((t) => t === SWAP_TOPICS.v3).length;
  const sw = ours.map(decodeSwap).filter((x) => x && x.in != null), meta = { fee: f, feeProtocol: fp, dex: 'pancakeswap' };
  let mine = 0n, theirs = 0n;
  for (const x of sw) { const fs2 = swapFees(x, meta); if (fs2) { mine += fs2.protocol; theirs += x.protocolFees[x.in]; } }
  const ratio = theirs > 0n ? Number(mine) / Number(theirs) : null;
  say(ours.length ? ratio != null && Math.abs(ratio - 1) <= 0.02 : null, `pancakeswap ${chain} events`, `last ${span} blocks: ${logs.length} logs, ${ours.length} with the PancakeSwap Swap topic, ${uni} with Uniswap's; protocol fee from our feeProtocol decode ÷ the event's own ${ratio == null ? '—' : ratio.toFixed(4)}; ${await routerTally(rpc, chain, ours)}`);
}

// Base Uniswap: v4 Initialize events reach the PoolManager; v3 swaps' routers.
async function probeUniBase(base) {
  const head = parseInt(await base.call('eth_blockNumber', []) ?? '0x0', 16);
  const inits = head ? await base.call('eth_getLogs', [{ address: BASE_C.v4PoolManager, topics: [POOL_TOPICS.initialize], fromBlock: '0x' + (head - 1999).toString(16), toBlock: '0x' + head.toString(16) }]) : null;
  const dec = Array.isArray(inits) ? inits.map(decodeInitialize).filter(Boolean) : [];
  say(Array.isArray(inits) ? dec.length > 0 : null, 'uniswap base v4 events', Array.isArray(inits) ? `${inits.length} Initialize events in the last 2000 blocks, ${dec.length} decode; hooked ${dec.filter((e) => e.hooks !== '0x0000000000000000000000000000000000000000').length}` : 'unread');
  const pool = toAddress(decodeWords(await base.ethCall(BASE.v3Factory, encodeCall('getPool(address,address,uint24)', [{ t: 'address', v: BASE.WETH }, { t: 'address', v: BASE.USDC }, { t: 'uint', v: 500 }])))[0]);
  const logs = head ? await base.call('eth_getLogs', [{ address: pool, topics: [SWAP_TOPICS.v3], fromBlock: '0x' + (head - 499).toString(16), toBlock: '0x' + head.toString(16) }]) : null;
  say(Array.isArray(logs) ? true : null, 'uniswap base routers', Array.isArray(logs) ? `WETH/USDC 0.05%, last 500 blocks: ${logs.length} swaps; ${await routerTally(base, 'base', logs)}` : 'unread');
}

// Every router in lib/routers.mjs has code on its chain.
async function probeRouters(eth, base) {
  for (const [chain, rpc] of [['ethereum', eth], ['base', base]]) {
    const list = Object.entries(ROUTERS[chain]);
    const codes = await rpc.batch(list.map(([a]) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    const none = list.filter((_, i) => codes[i] != null && codes[i].length <= 2).map(([, n]) => n), unread = codes.filter((c) => c == null).length;
    say(unread ? null : none.length === 0, `routers ${chain}`, `${list.length - none.length - unread} of ${list.length} have code${none.length ? `; no code: ${none.join(', ')}` : ''}${unread ? `; unread ${unread}` : ''}`);
  }
  // the Ethereum benchmark's recent swaps
  const head = parseInt(await eth.call('eth_blockNumber', []) ?? '0x0', 16);
  const logs = head ? await eth.call('eth_getLogs', [{ address: ETH.bench, topics: [SWAP_TOPICS.v3], fromBlock: '0x' + (head - 1999).toString(16), toBlock: '0x' + head.toString(16) }]) : null;
  if (Array.isArray(logs)) say(true, 'routers ethereum benchmark', `UNI/WETH 0.3%, last 2000 blocks: ${logs.length} swaps; ${await routerTally(eth, 'ethereum', logs)}`);
}

// CoinGecko tickers (no key here): the centralised share of a coin's markets, as lib/cex.mjs reads it.
async function probeTickers() {
  const r = parseTickers(await getJson('https://api.coingecko.com/api/v3/coins/uniswap/tickers?order=volume_desc&depth=false&page=1', { headers: { accept: 'application/json' } }, 20000));
  say(r ? r.cex > 0 && r.dex > 0 : null, 'tickers coingecko', r ? `UNI: ${r.cex} centralised markets ($${Math.round(r.vol / 1e3)}k in 24 h), ${r.dex} DEX markets left out, ${r.skipped} anomalous or stale` : 'unread');
}

// The exchange screen's fallback while CoinGecko is out (lib/cex.mjs exchangeVolumes): which venue answers from a
// runner, how many markets each lists, and the 24 h USD volume of a few public benchmark coins. Market data only.
async function probeExchanges() {
  const err = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 30);
  const tryJson = async (url) => { try { return { j: await getJson(url, { headers: { accept: 'application/json' } }, 20000) }; } catch (e) { return { e: err(e) }; } };
  const cbAll = await tryJson(VENUES.coinbase.stats), cbProds = await tryJson(VENUES.coinbase.products);
  const krP = await tryJson(VENUES.kraken.pairs), krT = await tryJson(VENUES.kraken.ticker);
  const prods = parseCoinbaseProducts(cbProds.j);
  const venues = {
    coinbase: [parseCoinbaseStats(cbAll.j), cbAll.e, `bulk stats ${cbAll.j ? 'answer' : `unread (${cbAll.e ?? 'shape'})`}, product list ${prods ? `${prods.size} bases quoted in a stablecoin` : `unread (${cbProds.e ?? 'shape'})`}`],
    kraken: [parseKraken(krP.j, krT.j), krP.e || krT.e, ''],
  };
  for (const k of ['okx', 'gate', 'kucoin']) {
    const r = await tryJson(VENUES[k].tickers);
    venues[k] = [{ okx: parseOkx, gate: parseGate, kucoin: parseKucoin }[k](r.j), r.e, ''];
  }
  const fmtUsd = (x) => (x == null ? '—' : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}k`);
  for (const [k, [rows, e, extra]] of Object.entries(venues)) {
    const v = rows ? venueVolumes(rows) : null;
    say(rows ? true : null, `exchange ${k}`, rows ? `${rows.length} markets, ${v.size} coins priced; 24 h: ETH ${fmtUsd(v.get('ETH')?.usd)}, UNI ${fmtUsd(v.get('UNI')?.usd)}, LINK ${fmtUsd(v.get('LINK')?.usd)}${extra ? `; ${extra}` : ''}` : `unread (${e ?? 'unexpected shape'})${extra ? `; ${extra}` : ''}`);
  }
  // the whole fallback for public benchmark coins, checked against DefiLlama's prices
  const ids = ['ethereum', 'uniswap', 'chainlink', 'aave'], syms = { ethereum: 'WETH', uniswap: 'UNI', chainlink: 'LINK', aave: 'AAVE' };
  const ll = await tryJson(`https://coins.llama.fi/prices/current/${ids.map((i) => `coingecko:${i}`).join(',')}`);
  const meta = new Map(ids.map((i) => [i, { symbol: syms[i], usd: ll.j?.coins?.[`coingecko:${i}`]?.price ?? null }]));
  const r = await exchangeVolumes(getJson, ids, { meta });
  say(r.got ? true : null, 'exchange fallback', `${r.got} of ${r.asked} benchmark coins read (${r.unlisted} listed nowhere, ${r.mismatched} price mismatch, ${r.unpriced} unpriced): ${ids.map((i) => `${syms[i]} ${fmtUsd(r.vol.get(i)?.vol)} over ${r.vol.get(i)?.venues ?? 0} venues`).join(', ')}; venues ${Object.entries(r.venues).map(([k, v]) => `${k} ${v ?? 'unread'}`).join(', ')}; ${r.note}`);
}

async function probeDexScreenerBase() {
  const rows = parseDexScreenerPairs(await getJson(`https://api.dexscreener.com/token-pairs/v1/base/${BASE_C.quotes[3].address}`, { headers: { accept: 'application/json' } }, 20000), 'base');
  const by = new Map();
  for (const p of rows) by.set(p.dex, (by.get(p.dex) || 0) + 1);
  say(rows.length ? true : null, 'dexscreener base', `cbBTC: ${rows.length} pairs; by venue ${[...by].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ×${v}`).join(', ')}; oldest pair ${rows.filter((p) => p.createdAt).length ? Math.floor((Date.now() - Math.min(...rows.filter((p) => p.createdAt).map((p) => p.createdAt))) / 86400e3) + ' days' : '—'}`);
}

// Base's block clock (lib/chains.mjs eras: 2 s blocks until block 53,556,126 at 5 Nov 2026 18:00 UTC, 0.2 s since),
// checked against independent sources: each Base node's own eth_getBlockByNumber timestamps at the same block
// numbers (around the switch, a day either side, and the head), Blockscout's block API where it answers, and the
// runner's own clock against the head. Block numbers and timestamps only (public chain data).
async function probeBaseClock() {
  const B = CHAINS.base, SW = B.eras.at(-1).block, nodes = [];
  for (const url of B.rpcs) {
    const r = makeRpc([url], { timeout: 12000, maxRefusals: 3 });
    const bn = await r.call('eth_blockNumber', []);
    if (bn != null) nodes.push({ host: new URL(url).host, r, head: parseInt(bn, 16), wall: Date.now() / 1000 });
  }
  if (nodes.length < 2) return say(null, 'base clock', `${nodes.length} Base node answered: two are needed to compare`);
  const head = Math.min(...nodes.map((n) => n.head)) - 50; // a block every node already has
  const blocks = [['2 s era, a day before the switch', SW - 43200], ['the block before the switch', SW - 1], ['the switch', SW], ['5 blocks after', SW + 5], ['10 blocks after', SW + 10],
    ['a day after the switch', SW + 432000], ['a day before the head', head - 432000], ['the head − 50', head]];
  const ts = new Map();
  for (const n of nodes) {
    const got = await n.r.batch(blocks.map(([, b]) => ({ method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), false] })));
    n.ts = got.map((x) => (x && x.timestamp ? parseInt(x.timestamp, 16) : null));
  }
  // Blockscout's own index (not an RPC node), where it answers
  const bs = await mapLimit(blocks, 2, async ([, b]) => {
    try { const j = await getJson(`https://base.blockscout.com/api/v2/blocks/${b}`, { headers: { accept: 'application/json' } }, 15000); const t = Date.parse(j?.timestamp); return Number.isFinite(t) ? Math.round(t / 1000) : null; } catch { return null; }
  });
  let agreeAll = true, eraOff = 0, read = 0;
  const rows = blocks.map(([label, b], i) => {
    const vals = nodes.map((n) => n.ts[i]).filter((x) => x != null);
    if (vals.length >= 2) read++;
    const agree = vals.length >= 2 && vals.every((x) => x === vals[0]);
    if (!agree) agreeAll = false;
    const era = timeOfBlock(B, b), off = vals.length ? vals[0] - era : null;
    if (off != null) eraOff = Math.max(eraOff, Math.abs(off));
    ts.set(b, vals[0] ?? null);
    return `${label} (block ${b}): ${vals.length} nodes ${agree ? 'agree' : vals.length >= 2 ? 'DISAGREE ' + [...new Set(vals)].join('/') : 'too few'} at ${vals[0] ?? '—'}, vs the era clock ${off == null ? '—' : (off >= 0 ? '+' : '') + off.toFixed(1) + ' s'}, Blockscout ${bs[i] == null ? 'unread' : bs[i] === vals[0] ? 'same' : `${bs[i] - (vals[0] ?? NaN)} s off`}`;
  });
  const spb = (a, b) => (ts.get(a) != null && ts.get(b) != null ? (ts.get(b) - ts.get(a)) / (b - a) : null);
  const f = (x) => (x == null ? '—' : x.toFixed(4) + ' s');
  const before = spb(SW - 43200, SW), after = spb(SW, SW + 432000), recent = spb(head - 432000, head);
  const wallLag = nodes.map((n) => { const i = blocks.length - 1; return n.ts[i] != null ? Math.round(n.wall - n.ts[i] - (n.head - head) * B.secPerBlock) : null; });
  say(read === blocks.length && agreeAll && eraOff <= 1 && Math.abs(before - 2) < 0.01 && Math.abs(after - 0.2) < 0.01 && Math.abs(recent - 0.2) < 0.01 ? true : null, 'base clock',
    `${nodes.length} Base nodes (${nodes.map((n) => n.host).join(', ')}); seconds a block: ${f(before)} over the day before the switch, ${f(after)} over the day after, ${f(recent)} over the last day; ` +
    `the head's age by the runner's clock ${wallLag.map((x) => (x == null ? '—' : x + ' s')).join(' / ')}; Blockscout read ${bs.filter((x) => x != null).length} of ${blocks.length}`);
  say(agreeAll ? true : null, 'base clock blocks', rows.join(' | '));
}

async function probeBlockscoutBase() {
  const j = await getJson(`https://base.blockscout.com/api?module=contract&action=getsourcecode&address=${BASE.USDC}`, { headers: { accept: 'application/json' } }, 20000);
  const v = readVerified(j);
  say(v == null ? null : v === true, 'blockscout base', `USDC source verified: ${v == null ? 'unreadable answer' : v ? 'yes' : 'no'}`);
}

const eth = makeRpc([ETH_RPCS.publicnode, ETH_RPCS.drpc, ETH_RPCS.blockscout, ETH_RPCS['1rpc'], ETH_RPCS.llamarpc], { batchSize: 40 });
const base = makeRpc([BASE_RPCS.base, BASE_RPCS.publicnode, BASE_RPCS.drpc, BASE_RPCS['1rpc']], { batchSize: 40 });

const ethOk = await probeRpcs('eth', ETH_RPCS, '0x1');
const baseOk = await probeRpcs('base', BASE_RPCS, '0x2105');
await probeApis();
await probeMarket(eth);
await probeContracts(eth, base);
const archive = await probeArchive(ETH_RPCS);
await probeLogs(eth, 'eth', 30);
await probeLogs(base, 'base', 180);
const map = await probeMap(makeRpc(ethOk.length ? ethOk : Object.values(ETH_RPCS), { batchSize: 40 }));
const guard = async (area, fn) => { try { await fn(); } catch (e) { say(null, area, `probe broke (${String(e?.message || e).replace(/[^A-Za-z ]/g, '').slice(0, 40)})`); } };
await guard('archive base', () => probeArchiveBase());
await guard('logs base', () => probeLogsBase(base));
await guard('pancakeswap eth', () => probePancake('ethereum', eth));
await guard('pancakeswap base', () => probePancake('base', base));
await guard('uniswap base', () => probeUniBase(base));
await guard('routers', () => probeRouters(eth, base));
await guard('tickers', () => probeTickers());
await guard('exchanges', () => probeExchanges());
await guard('dexscreener base', () => probeDexScreenerBase());
await guard('blockscout base', () => probeBlockscoutBase());
await guard('base clock', () => probeBaseClock());

const count = (k) => results.filter((r) => r.ok === k).length;
const summary = `probes: ${count(true)} pass, ${count(false)} fail, ${count(null)} unread · eth rpcs ${ethOk.length}/${Object.keys(ETH_RPCS).length} · base rpcs ${baseOk.length}/${Object.keys(BASE_RPCS).length} · archive ${archive.length ? archive.join(', ') : 'none'} · map ${map ? (map.netSumZero && map.matchesPool ? 'complete' : 'INCOMPLETE') : 'unread'}`;
console.log('\n' + summary);
console.log(`::notice title=probes::${summary}`);
const mapLines = results.filter((r) => r.area.startsWith('map') || r.area.startsWith('shape')).map((r) => r.msg);
if (mapLines.length) console.log(`::notice title=benchmark map::${mapLines.join(' | ')}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n| | Area | Result |\n|---|---|---|\n` +
    results.map((r) => `| ${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'N/A'} | ${r.area} | ${r.msg} |`).join('\n') + '\n');
}
// Only a wrong map fails the job; unreachable hosts are information, not failure.
process.exit(map && !(map.netSumZero && map.matchesPool && map.neverNegative) ? 1 : 0);
