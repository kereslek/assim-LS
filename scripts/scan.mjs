// Phase 0, step 3: liquidity maps and a day of fees for the pools worth a look. Reads the pool list
// that scripts/pools.mjs wrote in the same job, re-reads those pools' state at a fresh block, rebuilds
// each full liquidity map at that block, and replays the last 24 h of swaps for volume and LP fees.
// Step 4 (snapshot): each pair's 30-day volatility, the suggested range, fee APR at an example
// $1,000 ticket, LVR, net APR, edge, walls in volatility terms, and markouts from the day's swaps.
// Public market data only: the log prints counts and distributions, never a pool or an address,
// except the UNI/WETH 0.3% benchmark, which is public and named as the worked example.
import fs from 'node:fs';
import { makeRpc, mapLimit, getJson } from '../lib/rpc.mjs';
import { makeMulticall } from '../lib/multicall.mjs';
import { encodeCall } from '../lib/abi.mjs';
import { ETHEREUM as C, ZERO, readV3Slot0, readV4Slot0, readUint, v4Slot0Call, poolPrice } from '../lib/pools.mjs';
import { readMaps, wordsFor } from '../lib/maps.mjs';
import { sqrtX96ToSqrt, ticksForLog } from '../lib/v3math.mjs';
import { hollowness, shapeTag, bandStats, depthHistogram, nearestWalls } from '../lib/shape.mjs';
import { SWAP_TOPICS, decodeSwap, summarize, usdOfPair, swapFees } from '../lib/swaps.mjs';
import { dailySigma, ratioByDay, markouts } from '../lib/flow.mjs';
import { scorePool, recentMoves } from '../lib/score.mjs';
import { dailyHistory } from '../lib/history.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';

const FLOOR = 300_000, V4_PREFILTER = 100_000, MAX_WORDS = 600_000, DAY_BLOCKS = 7200, GROUP = 40;
const EXAMPLE_TICKET = 1000, HOLD_DAYS = 14, RERANGE_GAS = 630_000, MARKOUT_BLOCKS = 25; // a made-up example size, not anyone's position
const BENCH = '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801';
const V3_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net', 'https://eth.blockscout.com/api/eth-rpc'];

const lines = [], timing = {};
const say = (ok, area, msg) => { lines.push({ ok, area, msg }); console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'N/A '} ${area}: ${msg}`); };
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const fr = (x) => (x == null ? '—' : `${Math.round(100 * x)}%`); // a fraction; missing shows —, never 0%
const usd = (x) => (x == null ? '—' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);
const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
async function timed(name, fn) { const t = Date.now(); try { return await fn(); } finally { timing[name] = Math.round((Date.now() - t) / 1000); } }
function finish(code) {
  const count = (k) => lines.filter((l) => l.ok === k).length;
  const summary = `scan: ${count(true)} pass, ${count(false)} fail, ${count(null)} unread · steps ${Object.entries(timing).map(([k, v]) => `${k} ${v}s`).join(', ')}`;
  console.log('\n' + summary);
  console.log(`::notice title=maps and fees::${lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '·'} ${l.area}: ${l.msg}`).join(' | ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n| | Area | Result |\n|---|---|---|\n` +
      lines.map((l) => `| ${l.ok === true ? 'PASS' : l.ok === false ? 'FAIL' : 'N/A'} | ${l.area} | ${l.msg} |`).join('\n') + '\n');
  }
  process.exit(code);
}

const list = JSON.parse(fs.readFileSync('out/pools-ethereum.json', 'utf8'));
const tok = new Map(list.tokens.map((t) => [t.address, t]));
const B = (x) => (x == null ? null : BigInt(x));
const rpc = makeRpc(RPCS, { timeout: 30000, maxRefusals: 4 });
const mc = makeMulticall(rpc, { chunk: 400, concurrency: 4 });

// 1. Which pools: every v3 pool ≥ $300k by its own balances; v4 pools with liquidity that an
//    aggregator lists at ≥ $100k (v4 has no per-pool balances: its value comes from the map).
const pick = [
  ...list.v3.filter((p) => p.tvl >= FLOOR || p.id === BENCH).map((p) => ({ ...p, v: 3, tickSpacing: V3_SPACING[p.fee] })),
  ...list.v4.filter((p) => B(p.liquidity) > 0n && p.aggReserveUsd >= V4_PREFILTER).map((p) => ({ ...p, v: 4 })),
].sort((a, b) => (b.tvl ?? b.aggReserveUsd ?? 0) - (a.tvl ?? a.aggReserveUsd ?? 0));
let words = 0, skipped = 0;
const chosen = [];
for (const p of pick) {
  const w = wordsFor(p.tickSpacing).length;
  if (words + w > MAX_WORDS && p.id !== BENCH) { skipped++; continue; }
  words += w; chosen.push(p);
}

// 2. Fresh block; state and maps all read there.
const tag = await rpc.call('eth_blockNumber', []);
if (tag == null) { say(null, 'block', 'no block number'); finish(1); }
const block = parseInt(tag, 16);
const st = await timed('state', () => mc(chosen.flatMap((p) => (p.v === 3
  ? [{ target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') }]
  : [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }])), tag));
chosen.forEach((p, i) => { p.s = (p.v === 3 ? readV3Slot0(st[2 * i]) : readV4Slot0(st[2 * i])) || null; p.L = readUint(st[2 * i + 1]); });
const ready = chosen.filter((p) => p.s && p.L != null);
const maps = await timed('maps', () => readMaps(mc, ready.map((p) => ({ v: p.v, id: p.id, tickSpacing: p.tickSpacing, tick: p.s.tick, liquidity: p.L })), { stateView: C.v4StateView, tag }));

let complete = 0, unreadMaps = 0, badMaps = 0, ticksRead = 0;
const tags = new Map(), v3Ratio = [], v4Ratio = [];
ready.forEach((p, i) => {
  const m = maps[i];
  if (m.unread) { unreadMaps++; return; }
  ticksRead += m.checks.initialized;
  if (!(m.checks.netSumZero && m.checks.neverNegative && m.checks.matchesPool)) { badMaps++; return; }
  complete++;
  const d0 = tok.get(p.t0)?.decimals, d1 = tok.get(p.t1)?.decimals, u0 = tok.get(p.t0)?.usd, u1 = tok.get(p.t1)?.usd;
  const sp = sqrtX96ToSqrt(B(p.s.sqrtPriceX96)), price = poolPrice(B(p.s.sqrtPriceX96), d0, d1);
  const h = hollowness(m.segments, sp, d1, p.s.tick, m.checks.walkedLiquidity);
  const per1 = u1 > 0 ? u1 : u0 > 0 && price > 0 ? u0 / price : null; // USD per token1
  p.mapUsd = per1 != null ? h.total * per1 : null;
  p.hollow = h.hollow; p.aboveShare = h.aboveShare; p.tag = shapeTag(h);
  p.sqrt = sp; p.d1 = d1; p.per1 = per1; p.walls = nearestWalls(depthHistogram(m.segments, sp, d1, p.s.tick));
  const t9 = ticksForLog(0.09), b9 = bandStats(m.segments, sp, d1, p.s.tick - t9, p.s.tick + t9, p.s.tick);
  p.band9 = b9.total ? b9.inside / b9.total : null;
  tags.set(p.tag, (tags.get(p.tag) || 0) + 1);
  if (p.v === 3 && p.tvl > 0 && p.mapUsd != null) v3Ratio.push(p.mapUsd / p.tvl);
  if (p.v === 4 && p.aggReserveUsd > 0 && p.mapUsd != null) v4Ratio.push(p.mapUsd / p.aggReserveUsd);
});
say(badMaps ? false : unreadMaps ? null : true, 'maps', `${complete} of ${ready.length} maps complete at block ${block} (liquidity sums to zero, never negative, walk = pool liquidity); ${badMaps} failed a check; ${unreadMaps} unread; ${skipped} skipped for the read budget; ${words} bitmap words, ${ticksRead} ticks`);
const within = (a, lo, hi) => a.filter((r) => r >= lo && r <= hi).length;
// The map can't hold more than the pool owns; the pool can own more than its map (fees owed to LPs
// and to the protocol wait in its balance until collected), so this check is one-sided.
const over = v3Ratio.filter((r) => r > 1.02).length;
say(v3Ratio.length ? over / v3Ratio.length <= 0.05 : null, 'map value v3', `map value at most the pool's token balances for ${v3Ratio.length - over} of ${v3Ratio.length}; median map/balances ${median(v3Ratio)?.toFixed(3) ?? '—'}; ${v3Ratio.filter((r) => r < 0.9).length} pools hold more than 10% outside their liquidity (fees not yet collected, or tokens sent to the pool)`);
const unlisted = ready.filter((p) => p.v === 3 && p.aggReserveUsd == null && p.mapUsd != null);
say(true, 'unlisted v3', `${unlisted.length} mapped v3 pools no aggregator lists: ${unlisted.filter((p) => p.mapUsd >= FLOOR).length} hold ≥ ${usd(FLOOR)} as liquidity; median map/balances ${median(unlisted.map((p) => p.mapUsd / p.tvl))?.toFixed(3) ?? '—'}`);
say(v4Ratio.length ? within(v4Ratio, 0.75, 1.25) / v4Ratio.length >= 0.7 : null, 'map value v4', `map value vs aggregators: within ±25% for ${within(v4Ratio, 0.75, 1.25)} of ${v4Ratio.length}; median ${median(v4Ratio)?.toFixed(3) ?? '—'}`);
const mapped = ready.filter((p) => p.tag);
const strandedPools = mapped.filter((p) => p.hollow >= 0.8);
say(true, 'shapes', `of ${mapped.length} mapped pools: ${[...tags].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}; median share of value within ±9% of the price ${fr(median(mapped.map((p) => p.band9)))}`);

// 3. The last 24 h of swaps for the mapped pools: v3 per pool address, v4 through the PoolManager by pool id.
const from = block - DAY_BLOCKS + 1;
const v3ids = mapped.filter((p) => p.v === 3).map((p) => p.id), v4ids = mapped.filter((p) => p.v === 4).map((p) => p.id);
const groups = [];
for (let i = 0; i < v3ids.length; i += GROUP) groups.push({ address: v3ids.slice(i, i + GROUP), topics: [SWAP_TOPICS.v3] });
for (let i = 0; i < v4ids.length; i += GROUP) groups.push({ address: C.v4PoolManager, topics: [SWAP_TOPICS.v4, v4ids.slice(i, i + GROUP)] });
const got = await timed('swaps', () => mapLimit(groups, 2, (f) => logsAdaptive(rpc, f, from, block, { step: 1000 })));
const unreadGroups = got.filter((g) => g == null).length;
const unreadIds = new Set(groups.flatMap((g, i) => (got[i] == null ? (Array.isArray(g.address) ? g.address : g.topics[1]) : [])));
const swaps = got.filter(Boolean).flat().map(decodeSwap).filter(Boolean);
const meta = new Map(mapped.map((p) => [p.id, p.v === 3 ? { fee: p.fee, feeProtocol: p.s.feeProtocol } : { protocolFee: p.s.protocolFee }]));
const sums = summarize(swaps, meta);
let lpUsd = 0, protoUsd = 0, volUsd = 0, unpricedPools = 0;
const volRatio = [];
for (const p of mapped) {
  if (unreadIds.has(p.id)) { p.fees24h = null; continue; }
  const r = sums.get(p.id);
  const d0 = tok.get(p.t0)?.decimals, d1 = tok.get(p.t1)?.decimals, u0 = tok.get(p.t0)?.usd, u1 = tok.get(p.t1)?.usd;
  if (!r) { p.fees24h = 0; p.vol24h = 0; continue; } // read, and no swaps: a real zero
  p.fees24h = r.unpriced ? null : usdOfPair(r.lp, d0, d1, u0, u1);
  p.vol24h = usdOfPair(r.volume, d0, d1, u0, u1);
  const pr = usdOfPair(r.protocol, d0, d1, u0, u1);
  if (p.fees24h == null) { unpricedPools++; continue; }
  lpUsd += p.fees24h; protoUsd += pr ?? 0; volUsd += p.vol24h ?? 0;
  if (p.aggVolumeUsd24h > 0 && p.vol24h != null) volRatio.push(p.vol24h / p.aggVolumeUsd24h);
}
say(unreadGroups ? null : true, 'swaps', `${swaps.length} swaps in the last ${DAY_BLOCKS} blocks across ${sums.size} of ${mapped.length} pools; ${unreadGroups} of ${groups.length} log groups unread`);
const protoOn = mapped.filter((p) => (p.v === 3 ? p.s.feeProtocol > 0 : p.s.protocolFee > 0));
say(true, 'fees', `LP fees ${usd(lpUsd)} and protocol fees ${usd(protoUsd)} on ${usd(volUsd)} of volume in 24 h; protocol fee on in ${protoOn.filter((p) => p.v === 3).length} of ${mapped.filter((p) => p.v === 3).length} v3 and ${protoOn.filter((p) => p.v === 4).length} of ${mapped.filter((p) => p.v === 4).length} v4 pools; ${unpricedPools} pools unpriced`);
say(volRatio.length ? within(volRatio, 0.75, 1.25) / volRatio.length >= 0.7 : null, 'volume check', `24 h volume vs DexScreener: within ±25% for ${within(volRatio, 0.75, 1.25)} of ${volRatio.length}; median ratio ${median(volRatio)?.toFixed(3) ?? '—'}`);
const yieldOf = (p) => (p.fees24h != null && p.mapUsd > 0 ? (365 * p.fees24h) / p.mapUsd : null);
say(true, 'stranded', `${strandedPools.length} pools ≥ ${usd(FLOOR)} have ≥ 80% of their value parked away from the price (${strandedPools.filter((p) => p.tag === 'one-sided').length} one-sided); median fee yield on total value ${fr(median(strandedPools.map(yieldOf)))} vs ${fr(median(mapped.filter((p) => p.hollow < 0.8).map(yieldOf)))} for the rest`);
// 4. Step 4 snapshot: volatility, scores and markouts.
const WETH = C.quotes.find((q) => q.symbol === 'WETH').address;
const keyOf = (a) => `ethereum:${a === ZERO ? WETH : a}`;
const hist = await timed('history', () => dailyHistory(getJson, [...new Set(mapped.flatMap((p) => [keyOf(p.t0), keyOf(p.t1)]))]));
const gp = await rpc.call('eth_gasPrice', []), ethUsd = tok.get(WETH)?.usd;
const gasUsd = gp && ethUsd > 0 ? ((parseInt(gp, 16) * RERANGE_GAS) / 1e18) * ethUsd : null;
const byPool = new Map();
for (const s of swaps) { if (!byPool.has(s.pool)) byPool.set(s.pool, []); byPool.get(s.pool).push(s); }
for (const p of mapped) {
  const a = hist.series.get(keyOf(p.t0)), c = hist.series.get(keyOf(p.t1));
  const ratio = a && c ? ratioByDay(a, c) : null;
  p.sigma = ratio ? dailySigma(ratio) : null;
  Object.assign(p, ratio ? recentMoves(ratio) : { move7dLog: null, lastDayLog: null });
  p.score = scorePool({ tick: p.s.tick, sqrt: p.sqrt, d1: p.d1, usdPer1: p.per1, activeL: p.L, feeTier: (p.v === 3 ? p.fee : p.s.lpFee) / 1e6, feesPerDayUsd: p.fees24h, sigma: p.sigma, walls: p.walls },
    { days: HOLD_DAYS, ticket: EXAMPLE_TICKET, gasUsd });
  const m = unreadIds.has(p.id) ? null : markouts(byPool.get(p.id) || [], { horizon: MARKOUT_BLOCKS, endBlock: block, feeOf: (s) => swapFees(s, meta.get(p.id))?.total ?? null });
  p.markout = m ? m.ratio : null;
}
const withSigma = mapped.filter((p) => p.sigma != null);
say(hist.unread.length ? null : true, 'volatility', `30-day volatility read for ${withSigma.length} of ${mapped.length} pools (median ${fr(median(withSigma.map((p) => p.sigma)))} a day); ${hist.unread.length} price histories unread; re-range gas ${gasUsd == null ? '—' : '$' + gasUsd.toFixed(2)}`);
const scored = mapped.filter((p) => p.score?.net != null);
const pos = scored.filter((p) => p.score.net > 0), edgy = scored.filter((p) => p.score.edge > 1);
say(true, 'scores', `at a $${EXAMPLE_TICKET} example ticket over ${HOLD_DAYS}-day ranges: ${scored.length} pools scored; net APR above zero for ${pos.length}, fees above LVR (edge > 1) for ${edgy.length}; median fee APR ${fr(median(scored.map((p) => p.score.feeApr)))}, LVR ${fr(median(scored.map((p) => p.score.lvr)))}, net ${fr(median(scored.map((p) => p.score.net)))}`);
const sScored = scored.filter((p) => p.hollow >= 0.8);
say(true, 'stranded scores', `of the ${strandedPools.length} stranded or one-sided pools, ${sScored.length} scored: net APR above zero for ${sScored.filter((p) => p.score.net > 0).length}; median net ${fr(median(sScored.map((p) => p.score.net)))}, median edge ${median(sScored.map((p) => p.score.edge))?.toFixed(2) ?? '—'}`);
const mk = mapped.filter((p) => p.markout != null);
say(true, 'flow', `markouts (${MARKOUT_BLOCKS} blocks after each swap) read for ${mk.length} pools: median ${fr(median(mk.map((p) => p.markout)))} of the fee; ${mk.filter((p) => p.markout <= 0.6).length} pass the toxic-flow filter (≤ 60%)`);
const moved = mapped.filter((p) => p.sigma > 0 && p.move7dLog != null && p.lastDayLog != null && Math.abs(p.move7dLog) / (p.sigma * Math.sqrt(7)) >= 2 && Math.abs(p.lastDayLog) <= p.sigma);
say(true, 'lenses today', `stranded ${strandedPools.filter((p) => p.tag === 'stranded').length}, one-sided ${strandedPools.filter((p) => p.tag === 'one-sided').length}, after a big move ${moved.length} (30-day averages, pool ages and calm-pair kinds come with stored history)`);
const b = ready.find((p) => p.id === BENCH);
if (b && b.tag) {
  say(true, 'benchmark', `UNI/WETH 0.3%: ${usd(b.mapUsd)} mapped, stranded ${fr(b.hollow)} (${b.tag}), ±9% holds ${fr(b.band9)}; 24 h volume ${usd(b.vol24h)}, LP fees ${usd(b.fees24h)}; protocol fee ${b.s.feeProtocol ? 'on' : 'off'}`);
  const k = b.score || {};
  say(true, 'benchmark score', `σ ${fr(b.sigma)} a day → range ±${fr(k.r)}; at $${EXAMPLE_TICKET}: fee APR ${fr(k.feeApr)}, LVR ${fr(k.lvr)}, net ${fr(k.net)}, edge ${k.edge?.toFixed(2) ?? '—'}, re-range every ${k.rerangeDays ? Math.round(k.rerangeDays) + ' days' : '—'}; markouts ${fr(b.markout)} of the fee; nearest walls ${k.wallSigmaBelow == null ? '—' : k.wallSigmaBelow === Infinity ? 'none in view' : k.wallSigmaBelow.toFixed(1) + ' σ-weeks'} below, ${k.wallSigmaAbove == null ? '—' : k.wallSigmaAbove === Infinity ? 'none in view' : k.wallSigmaAbove.toFixed(1) + ' σ-weeks'} above`);
} else say(null, 'benchmark', 'not mapped');
finish(badMaps ? 1 : 0);
