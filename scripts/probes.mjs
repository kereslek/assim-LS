// Phase 0, step 1: what answers from a GitHub runner, are the contract facts right, and does the
// liquidity-map method reproduce a real pool? Public data only: pass/fail, counts, ratios, block
// numbers and market data. No addresses are printed.
import fs from 'node:fs';
import { makeRpc, getJson } from '../lib/rpc.mjs';
import { encodeCall, decodeWords, signed, toAddress } from '../lib/abi.mjs';
import { topic } from '../lib/keccak.mjs';
import { liquidityMap, ticksInWord, bitmapWordRange, sqrtX96ToSqrt, ticksForLog } from '../lib/v3math.mjs';
import { bandStats, depthHistogram, nearestWalls, shapeTag } from '../lib/shape.mjs';

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
    say(true, 'shape UNI/WETH 0.3%', `±${Math.round(r * 100)}% holds ${pct(b.total ? b.inside / b.total : null)} of the value, ${pct(b.stranded)} sits outside (${shapeTag(b)})`);
  }
  const w = nearestWalls(depthHistogram(m.segments, sp, 18, tickCurrent));
  const down = (x) => (x == null ? '—' : x === Infinity ? 'none in view' : `−${Math.round((1 - Math.exp(-x)) * 100)}%`);
  const up = (x) => (x == null ? '—' : x === Infinity ? 'none in view' : `+${Math.round((Math.exp(x) - 1) * 100)}%`);
  say(true, 'shape UNI/WETH 0.3%', `price ${(sp * sp).toPrecision(4)} WETH per UNI; ${shape[0.09].total.toFixed(0)} WETH of liquidity mapped; nearest wall ${down(w.below)} and ${up(w.above)}; protocol fee ${feeProtocol ? 'on' : 'off'}`);
  return m.checks;
}

const eth = makeRpc([ETH_RPCS.publicnode, ETH_RPCS.drpc, ETH_RPCS.blockscout, ETH_RPCS['1rpc'], ETH_RPCS.llamarpc], { batchSize: 40 });
const base = makeRpc([BASE_RPCS.base, BASE_RPCS.publicnode, BASE_RPCS.drpc, BASE_RPCS['1rpc']], { batchSize: 40 });

const ethOk = await probeRpcs('eth', ETH_RPCS, '0x1');
const baseOk = await probeRpcs('base', BASE_RPCS, '0x2105');
await probeApis();
await probeContracts(eth, base);
await probeLogs(eth, 'eth', 30);
await probeLogs(base, 'base', 180);
const map = await probeMap(makeRpc(ethOk.length ? ethOk : Object.values(ETH_RPCS), { batchSize: 40 }));

const count = (k) => results.filter((r) => r.ok === k).length;
const summary = `probes: ${count(true)} pass, ${count(false)} fail, ${count(null)} unread · eth rpcs ${ethOk.length}/${Object.keys(ETH_RPCS).length} · base rpcs ${baseOk.length}/${Object.keys(BASE_RPCS).length} · map ${map ? (map.netSumZero && map.matchesPool ? 'complete' : 'INCOMPLETE') : 'unread'}`;
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
