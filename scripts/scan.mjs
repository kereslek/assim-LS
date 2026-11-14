// Phase 0, step 3: liquidity maps and a day of fees for the pools worth a look, on every chain the pool
// lists cover (scripts/pools.mjs writes out/pools-ethereum.json and, when Base was read, out/pools-base.json;
// lib/chains.mjs). Per chain: re-reads those pools' state at a fresh block, rebuilds each full liquidity map
// at that block, and replays the last 24 h of swaps for volume and LP fees (Uniswap v3 and v4, PancakeSwap
// v3: the same maths, PancakeSwap's own protocol cut and Swap event; lib/swaps.mjs).
// Step 4 (snapshot): each pair's 30-day volatility, the suggested range, fee APR at an example
// $1,000 ticket, LVR, net APR, edge, walls in volatility terms, and markouts from the day's swaps.
// Then (outputs) flow quality per window (lib/flowq.mjs), the exchange-led screen (lib/cex.mjs) and the
// discovery lanes. Public market data only: the log prints counts and distributions, never a pool or an
// address, except the UNI/WETH 0.3% benchmark, which is public and named as the worked example.
// Ethereum's check areas keep their names; another chain's carry its prefix ("base maps").
// The parts added after Ethereum's Uniswap scan run within read caps (lib/chains.mjs caps, lib/budget.mjs): a part
// that reaches its time or call limit stops, and what it did not read is null ("not read"); the public log gets
// each capped part's seconds and calls ("caps" lines) and which cap stopped it.
import fs from 'node:fs';
import { makeRpc, mapLimit, getJson as rawGetJson } from '../lib/rpc.mjs';
import { makeMulticall } from '../lib/multicall.mjs';
import { encodeCall } from '../lib/abi.mjs';
import { ZERO, DYNAMIC_FEE, TOPICS, decodeModifyLiquidity, readV3Slot0, readV4Slot0, readUint, v4Slot0Call, poolPrice, extremeFee, PANCAKE_V3, UNISWAP_V3_SPACING, v3LpKeeps } from '../lib/pools.mjs';
import { readMaps, wordsFor, feeGrowthCalls, readFeeGrowth } from '../lib/maps.mjs';
import { sqrtX96ToSqrt, ticksForLog } from '../lib/v3math.mjs';
import { hollowness, shapeTag, bandStats, depthHistogram, nearestWalls, depthProfile, depthFields } from '../lib/shape.mjs';
import { SWAP_TOPICS, EXTRA_TOPICS, decodeSwap, decodeExtra, hookReturnsSwapDelta, summarize, usdOfPair, swapFees } from '../lib/swaps.mjs';
import { dailySigma, ratioByDay, markouts } from '../lib/flow.mjs';
import { scorePool, recentMoves } from '../lib/score.mjs';
import { tokenHistory, makeHistoryCache, ratioAt } from '../lib/history.mjs';
import { makeApiCounter } from '../lib/apicount.mjs';
import { MULTICALL3 } from '../lib/multicall.mjs';
import { verifiedSources, makeVerifiedCache } from '../lib/etherscan.mjs';
import { findBalanceKey, sellTest, SELL_ROUTERS } from '../lib/selltest.mjs';
import { stickyShare, strandedShare } from '../lib/persistence.mjs';
import { persistenceScore, flowScore, gemScore } from '../lib/gem.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { feeIdentity, replayFeeGrowth, feeIdentityPath, pathIndex, priceRatio, creationCheck, feesVsAggregator, tokenAgeRank, lpBook } from '../lib/checks.mjs';
import { installSealedLogs } from '../lib/quietlogs.mjs';
import { openLock } from '../lib/lock.mjs';
import { DEFAULTS as CONFIG_DEFAULTS, loadConfig } from '../lib/config.mjs';
import { openStore } from '../lib/store.mjs';
import { marketBlock, carryMarket } from '../lib/market.mjs';
import { parseStore, serializeStore, mergeStore, pastBlockAnswer } from '../lib/snapshots.mjs';
import { BACKFILL, blockClock, storePoints, planBackfill, runBudgeted, retryJobs, readBackfill, probeMoments, oldestMissing } from '../lib/backfill.mjs';
import { FEEHIST, DEEP_RANK, deepMoments, foldDeep, feeYear, fetchVolumes, packGt, unpackGt, windowSeries, median as midOf } from '../lib/feehist.mjs';
import { exactFeesChain, chainIo, emptyCache, packSx, unpackSx, exactLine } from '../lib/exactfees.mjs';
import { allWindows, gemWarnings, isHooked } from '../lib/windows.mjs';
import { buildPairs } from '../lib/pairs.mjs';
import { historyRows } from '../lib/charts.mjs';
import { feeSpikes } from '../lib/spikes.mjs';
import { CHAINS, CHAIN_IDS, timeOfBlock, blockAtTime, blocksBack, ageOfBlocksBack, chainOn } from '../lib/chains.mjs';
import { classifySwaps, retailShare, driftCorr, routingShare, sendersOf, txSample, dailyFlow, nextFlowDaily, FLOWQ } from '../lib/flowq.mjs';
import { routerName } from '../lib/routers.mjs';
import { cexVolumes, makeCexCache, cexScreen, CEX_BUDGET } from '../lib/cex.mjs';
import { lensCexLed } from '../lib/lenses.mjs';
import { makeBudget, capRpc, UNLIMITED } from '../lib/budget.mjs';

const FLOOR = 300_000, V4_PREFILTER = 100_000, GROUP = 40;
// a pool under YOUNG_DAYS old is scanned from YOUNG_FLOOR (the newPools lane looks for them before liquidity arrives)
const YOUNG_DAYS = 3, YOUNG_FLOOR = 50_000;
const EXAMPLE_TICKET = 1000, HOLD_DAYS = 14, RERANGE_GAS = 630_000, MARKOUT_SEC = 300; // a made-up example size, not anyone's position
const BENCH = '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801';
// Parked liquidity starts beyond max(the suggested ±r, 2%) from the price: closer than that it is serving.
const NEAR_MIN = 0.02;
// Snapshots written before the backfill checked each batch's block time are rebuilt once.
const SNAP_FIX = 2;
// The discovery lanes: a new pool is under 72 hours old and has at least 20 distinct senders in a day.
const NEW_POOL_MS = 72 * 3600e3, NEW_POOL_SENDERS = 20, TX_BUDGET = 3000, YOUNG_TXS = 300;
const nearOf = (p) => Math.max(NEAR_MIN, p.score?.r ?? 0);
const spacingOf = (p) => (p.dex === 'pancakeswap' ? PANCAKE_V3.spacing : UNISWAP_V3_SPACING)[p.fee];

const lines = [], timing = {}, running = new Map();
// With the lock (LOCK_PASSPHRASE set) every detail goes to the sealed log and the public log gets only
// each check's area with pass/fail, counts and step timings. Without it (offline fakes) all prints.
const SEALED = !!process.env.LOCK_PASSPHRASE;
let pub = console.log;
const say = (ok, area, msg) => {
  lines.push({ ok, area, msg });
  const head = `${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'N/A '} ${area}`;
  console.log(`${head}: ${msg}`);
  if (SEALED) pub(head);
};
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const fr = (x) => (x == null ? '—' : `${Math.round(100 * x)}%`); // a fraction; missing shows —, never 0%
const usd = (x) => (x == null ? '—' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);
const tally = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
const top = (m, n = 6) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none';
const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const within = (a, lo, hi) => a.filter((r) => r >= lo && r <= hi).length;
const in2 = (x) => x != null && x >= 0.98 && x <= 1.02;
async function timed(name, fn) { const t = Date.now(); running.set(name, t); try { return await fn(); } finally { running.delete(name); timing[name] = (timing[name] || 0) + Math.round((Date.now() - t) / 1000); } }
// Read caps can be lowered for a diagnostic run or a test: READ_CAPS='{"base":{"swaps":{"ms":2000}}}' (public settings, no data).
const CAP_OVERRIDE = (() => { try { const j = JSON.parse(process.env.READ_CAPS || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } })();
// A watchdog under the job's own time limit: a pass still running at SCAN_LIMIT_MS (default 18 min) stops with its step
// timings in the public log (names and seconds) instead of being cancelled with no log at all.
const SCAN_LIMIT_MS = Number(process.env.SCAN_LIMIT_MS) > 0 ? Number(process.env.SCAN_LIMIT_MS) : 18 * 60e3;
setTimeout(() => {
  const now = Date.now();
  pub(`scan: stopped by the watchdog after ${Math.round(SCAN_LIMIT_MS / 1000)} s · steps ${Object.entries(timing).map(([k, v]) => `${k} ${v}s`).join(', ')} · still running: ${[...running].map(([k, t]) => `${k} ${Math.round((now - t) / 1000)}s`).join(', ') || 'none'}`);
  process.exit(1);
}, SCAN_LIMIT_MS).unref();
function finish(code) {
  const count = (k) => lines.filter((l) => l.ok === k).length;
  const summary = `scan: ${count(true)} pass, ${count(false)} fail, ${count(null)} unread · steps ${Object.entries(timing).map(([k, v]) => `${k} ${v}s`).join(', ')}`;
  const detail = (l) => (SEALED ? '' : `: ${l.msg}`);
  pub('\n' + summary);
  pub(`::notice title=maps and fees::${lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '·'} ${l.area}${detail(l)}`).join(' | ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n| | Area${SEALED ? '' : ' | Result'} |\n|---|---${SEALED ? '' : '|---'}|\n` +
      lines.map((l) => `| ${l.ok === true ? 'PASS' : l.ok === false ? 'FAIL' : 'N/A'} | ${l.area}${SEALED ? '' : ` | ${l.msg}`} |`).join('\n') + '\n');
  }
  process.exit(code);
}
const errWord = (e) => String(e?.message || e).replace(/[^A-Za-z .:]/g, '').slice(0, 60);

// The lock first: a wrong passphrase stops the pass before anything is read or written.
let store = null, logStats = null, config = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
if (SEALED) {
  let keys;
  try { keys = openLock().keys; } catch (e) { console.log(`scan: ${/^(missing|bad|wrong)/.test(String(e?.message)) ? e.message : 'the lock does not open'}`); process.exit(1); }
  const ql = installSealedLogs({ keys });
  pub = ql.publicLog; logStats = ql.stats;
  config = loadConfig({ keys }).config;
  store = openStore({ keys });
}
const B = (x) => (x == null ? null : BigInt(x));
const nowSec = Math.floor(Date.now() / 1000);
const tsCall = { target: MULTICALL3, data: encodeCall('getCurrentBlockTimestamp()') };
// Market history for the volatility cross-check: one cache for every chain (keys carry the chain)
const hcache = makeHistoryCache('out/cache/history.json');
// Every market-data call is counted by source (lib/apicount.mjs) and CoinGecko's stay within the daily budget: the
// pool list's calls come through the cache file, earlier loop jobs' through the last live.json (health.apis).
const apis = makeApiCounter({ file: 'out/cache/apis.json' });
try { apis.seed(store?.get('live.json')?.health?.apis); } catch { /* the counts start from the file */ }
const getJson = apis.wrap(rawGetJson);

// Every chain whose pool list is here. Ethereum's is required; another chain's list over 2 days old is left out.
const ctxs = [];
let passT = null;
for (const id of CHAIN_IDS) {
  const CH = CHAINS[id], file = `out/pools-${id}.json`;
  if (!chainOn(id)) { say(null, `${CH.prefix}scan`, 'switched off for this run (CHAINS_OFF)'); continue; }
  if (!fs.existsSync(file)) { if (id === 'ethereum') { say(null, 'pool list', 'out/pools-ethereum.json missing'); finish(1); } continue; }
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { say(null, `${CH.prefix}pool list`, 'unreadable'); if (id === 'ethereum') finish(1); continue; }
  if (id !== 'ethereum' && !(Date.now() - list.t < 2 * 86400e3)) { say(null, `${CH.prefix}pool list`, 'over 2 days old: this chain is left out of the pass'); continue; }
  if (id === 'ethereum') { const X = await scanChain(CH, list); if (!X) finish(1); ctxs.push(X); passT = X.passT; continue; }
  try { const X = await scanChain(CH, list); if (X) ctxs.push(X); } catch (e) { console.error(e); say(null, `${CH.prefix}scan`, `broke (${errWord(e)}); this chain is left out of the pass`); }
}
try { hcache.save(); } catch { /* the next pass just fetches again */ }
const ETHX = ctxs[0];
const mapped = ctxs.flatMap((X) => X.mapped);
const badMaps = ctxs.reduce((a, X) => a + X.badMaps, 0), unreadMaps = ctxs.reduce((a, X) => a + X.unreadMaps, 0);

// 6. Outputs (docs/DATA.md): the snapshot store, every config window per pool (lib/windows.mjs), then the
//    sealed live.json, history.json (when a pool gains an hourly row) and snapshots.json, and the plain
//    out/shortlist.json the backtest reads. With the lock only; offline runs stop at the shortlist.
//    Anything this pass could not read is null, never 0.
try {
  await timed('outputs', writeOutputs);
} catch (e) {
  console.error(e);
  say(false, 'outputs', `could not write the outputs (${errWord(e)})`);
  finish(1);
}
finish(badMaps ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------
// Steps 1 to 5 on one chain. Returns the chain's context (everything the outputs need), or null when the
// chain gave no block number.
async function scanChain(CH, list) {
  const C = CH.c, eth = CH.id === 'ethereum';
  const say = (ok, area, msg) => sayRoot(ok, CH.prefix + area, msg);
  const tm = (name, fn) => timed(CH.prefix + name, fn); // step timings per chain ("base swaps"); Ethereum's keep their names
  const tok = new Map(list.tokens.map((t) => [t.address, t]));
  // a chain with a backstop cap (Base: caps.chain) reads steps 1-5 within it: past it every read is unread (null)
  const chainCap = CH.caps?.chain ? makeBudget({ ...CH.caps.chain, ...(CAP_OVERRIDE[CH.id]?.chain || {}) }) : UNLIMITED;
  const rawRpc = makeRpc(CH.rpcs, { timeout: 30000, maxRefusals: 4 }), rawArpc = makeRpc(CH.archive, { timeout: 30000, maxRefusals: 6 });
  const rpc = capRpc(rawRpc, chainCap);
  const mc = makeMulticall(rpc, { chunk: 400, concurrency: 4 });
  const arpc = capRpc(rawArpc, chainCap);
  const amc = makeMulticall(arpc, { chunk: 300, concurrency: 3 }); // serve old state (probes)
  // this chain's read caps (Ethereum: only its new parts; lib/chains.mjs)
  const caps = new Map();
  const cap = (k) => {
    const c = { ...(CH.caps?.[k] || {}), ...(CAP_OVERRIDE[CH.id]?.[k] || {}) };
    if (!c.ms && !c.calls) return UNLIMITED;
    const b = makeBudget(c); caps.set(k, b); return b;
  };
  const X = { CH, list, tok, rpc, mc, amc, arpc, caps, cap };
  if (chainCap !== UNLIMITED) caps.set('chain', chainCap);

  // 1. Which pools: every v3-style pool ≥ $300k by its own balances (and a young one from $50k); v4 pools an
  //    aggregator lists at ≥ $100k, and new v4 pools that hold liquidity (v4 has no per-pool balances: its
  //    value comes from the map). Liquidity only away from the price still counts: that is the one-sided kind.
  const young = (p) => isNum(p.createdAt) && nowSec - p.createdAt < YOUNG_DAYS * 86400 && p.tvl >= YOUNG_FLOOR;
  const pick = [
    ...list.v3.filter((p) => p.tvl >= FLOOR || (eth && p.id === BENCH) || young(p)).map((p) => ({ ...p, v: 3, dex: p.dex ?? 'uniswap' })).map((p) => ({ ...p, tickSpacing: spacingOf(p) })).filter((p) => p.tickSpacing),
    ...list.v4.filter((p) => !extremeFee(p.fee) && (p.aggReserveUsd >= V4_PREFILTER || p.source === 'event')).map((p) => ({ ...p, v: 4, dex: 'uniswap' })),
  ].sort((a, b) => (b.tvl ?? b.aggReserveUsd ?? 0) - (a.tvl ?? a.aggReserveUsd ?? 0));
  let words = 0, skipped = 0, beyondTop = 0;
  const chosen = [];
  for (const p of pick) {
    // a chain with a cap on its pool count (Base: caps.top) scans its largest pools by TVL; the rest wait
    if (CH.caps?.top && chosen.length >= CH.caps.top) { beyondTop++; continue; }
    const w = wordsFor(p.tickSpacing).length;
    if (words + w > CH.maxWords && p.id !== BENCH) { skipped++; continue; }
    words += w; chosen.push({ ...p, chain: CH.id });
  }
  X.beyondTop = beyondTop;

  // 2. Fresh block; state and maps all read there.
  const tag = await rpc.call('eth_blockNumber', []);
  if (tag == null) { say(null, 'block', 'no block number'); return null; }
  const block = parseInt(tag, 16);
  const passT = Date.now(); // the pass time: the state below is read at this block
  Object.assign(X, { tag, block, passT });
  // blocks back to a moment secBack before this block, and the age a block that far back must show
  const backBlocks = (secBack) => (CH.eras ? blocksBack(CH, { block, nowSec: timeOfBlock(CH, block), secBack }) : Math.round(secBack / CH.secPerBlock));
  const ageOk = (ts, back) => pastBlockAnswer(ts, { nowSec, blocksBack: back, secPerBlock: CH.secPerBlock, ageSec: CH.eras ? ageOfBlocksBack(CH, { block, back }) : null });
  const DAY_BLOCKS = backBlocks(86400), MARKOUT_BLOCKS = Math.round(MARKOUT_SEC / CH.secPerBlock);
  Object.assign(X, { backBlocks, ageOk, DAY_BLOCKS, MARKOUT_BLOCKS });
  const stCalls = (p) => (p.v === 3 ? [{ target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') }]
    : [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }]);
  const fgCalls = (p) => feeGrowthCalls(p, C.v4StateView);
  Object.assign(X, { stCalls, fgCalls });
  const st = await tm('state', () => mc(chosen.flatMap(stCalls), tag));
  chosen.forEach((p, i) => { p.s = (p.v === 3 ? readV3Slot0(st[2 * i]) : readV4Slot0(st[2 * i])) || null; p.L = readUint(st[2 * i + 1]); });
  const ready = chosen.filter((p) => p.s && p.L != null);
  const maps = await tm('maps', () => readMaps(mc, ready.map((p) => ({ v: p.v, id: p.id, tickSpacing: p.tickSpacing, tick: p.s.tick, liquidity: p.L })), { stateView: C.v4StateView, tag }));

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
    const h = hollowness(m.segments, sp, d1, p.s.tick, m.checks.walkedLiquidity, { near: NEAR_MIN });
    const per1 = u1 > 0 ? u1 : u0 > 0 && price > 0 ? u0 / price : null; // USD per token1
    p.mapUsd = per1 != null ? h.total * per1 : null;
    p.hollow = h.hollow; p.aboveShare = h.aboveShare; p.tag = shapeTag(h);
    p.sqrt = sp; p.d1 = d1; p.per1 = per1; p.walls = nearestWalls(depthHistogram(m.segments, sp, d1, p.s.tick));
    const t9 = ticksForLog(0.09), b9 = bandStats(m.segments, sp, d1, p.s.tick - t9, p.s.tick + t9, p.s.tick);
    p.band9 = b9.total ? b9.inside / b9.total : null;
    p.in9Usd = per1 != null ? b9.inside * per1 : null;
    tags.set(p.tag, (tags.get(p.tag) || 0) + 1);
    if (p.v === 3 && p.tvl > 0 && p.mapUsd != null) v3Ratio.push(p.mapUsd / p.tvl);
    if (p.v === 4 && p.aggReserveUsd > 0 && p.mapUsd != null) v4Ratio.push(p.mapUsd / p.aggReserveUsd);
  });
  Object.assign(X, { chosen, ready, maps, unreadMaps, unreadState: chosen.length - ready.length, badMaps, skipped });
  const venues = top(tally(ready.map((p) => `${p.dex} v${p.v}`)), 4);
  say(badMaps ? false : unreadMaps ? null : true, 'maps', `${complete} of ${ready.length} maps complete at block ${block} (liquidity sums to zero, never negative, walk = pool liquidity); ${badMaps} failed a check; ${unreadMaps} unread; ${skipped} skipped for the read budget${CH.caps?.top ? `; the largest ${CH.caps.top} pools by TVL scanned, ${beyondTop} smaller ones left out this pass` : ''}; ${words} bitmap words, ${ticksRead} ticks; by venue ${venues}`);
  // The map can't hold more than the pool owns; the pool can own more than its map (fees owed to LPs
  // and to the protocol wait in its balance until collected), so this check is one-sided.
  const over = v3Ratio.filter((r) => r > 1.02).length;
  say(v3Ratio.length ? over / v3Ratio.length <= 0.05 : null, 'map value v3', `map value at most the pool's token balances for ${v3Ratio.length - over} of ${v3Ratio.length}; median map/balances ${median(v3Ratio)?.toFixed(3) ?? '—'}; ${v3Ratio.filter((r) => r < 0.9).length} pools hold more than 10% outside their liquidity (fees not yet collected, or tokens sent to the pool)`);
  const unlisted = ready.filter((p) => p.v === 3 && p.aggReserveUsd == null && p.mapUsd != null);
  say(true, 'unlisted v3', `${unlisted.length} mapped v3 pools no aggregator lists: ${unlisted.filter((p) => p.mapUsd >= FLOOR).length} hold ≥ ${usd(FLOOR)} as liquidity; median map/balances ${median(unlisted.map((p) => p.mapUsd / p.tvl))?.toFixed(3) ?? '—'}`);
  say(v4Ratio.length ? within(v4Ratio, 0.75, 1.25) / v4Ratio.length >= 0.7 : null, 'map value v4', `map value vs aggregators: within ±25% for ${within(v4Ratio, 0.75, 1.25)} of ${v4Ratio.length}; median ${median(v4Ratio)?.toFixed(3) ?? '—'}`);
  const mapped = ready.filter((p) => p.tag);
  X.mapped = mapped;
  // Price check (step 5): a liquid pool's price against the market's (CoinGecko for the token, DefiLlama for quotes).
  const liquid = mapped.filter((p) => p.mapUsd >= 1e6);
  const quoteAddrs = new Set(list.tokens.filter((t) => t.quote).map((t) => t.address));
  X.quoteAddrs = quoteAddrs;
  const pr = liquid.map((p) => priceRatio({ poolPrice: poolPrice(B(p.s.sqrtPriceX96), tok.get(p.t0)?.decimals, tok.get(p.t1)?.decimals), quoteIs: quoteAddrs.has(p.t1) ? 1 : 0, usd0: tok.get(p.t0)?.usd, usd1: tok.get(p.t1)?.usd })).filter((x) => x != null);
  say(pr.length ? within(pr, 0.98, 1.02) / pr.length >= 0.9 : null, 'price check', `pools ≥ $1M priced within 2% of the market: ${within(pr, 0.98, 1.02)} of ${pr.length}; within 5%: ${within(pr, 0.95, 1.05)}; median ratio ${median(pr)?.toFixed(4) ?? '—'}`);
  const strandedPools = mapped.filter((p) => p.hollow >= 0.8);
  say(true, 'shapes', `of ${mapped.length} mapped pools: ${[...tags].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}; median share of value within ±9% of the price ${fr(median(mapped.map((p) => p.band9)))}`);

  // 3. The last 24 h of swaps for the mapped pools: v3-style per pool address (Uniswap's and PancakeSwap's
  //    Swap events), v4 through the PoolManager by pool id.
  const from = block - DAY_BLOCKS + 1;
  X.from = from;
  const v3ids = mapped.filter((p) => p.v === 3).map((p) => p.id), v4ids = mapped.filter((p) => p.v === 4).map((p) => p.id);
  const groups = [];
  // Flash (v3) and Donate (v4) ride along: they move the fee counters without a swap (step 3b).
  for (let i = 0; i < v3ids.length; i += GROUP) groups.push({ address: v3ids.slice(i, i + GROUP), topics: [[SWAP_TOPICS.v3, SWAP_TOPICS.pcs3, EXTRA_TOPICS.flash]] });
  for (let i = 0; i < v4ids.length; i += GROUP) groups.push({ address: C.v4PoolManager, topics: [[SWAP_TOPICS.v4, EXTRA_TOPICS.donate], v4ids.slice(i, i + GROUP)] });
  // Log reads skip nodes known to answer short (lib/chains.mjs noLogs) and, where a second node serves logs,
  // confirm any empty answer with it.
  const logRpc = capRpc(makeRpc(CH.rpcs.filter((u) => !CH.noLogs.some((x) => u.includes(x))), { timeout: 30000, maxRefusals: 1000 }), chainCap);
  X.logRpc = logRpc;
  // Ethereum reads as before; another chain within its swaps cap (a group the cap stops is unread: its pools' fees null)
  const swCap = eth ? null : cap('swaps');
  const got = await tm('swaps', () => mapLimit(groups, 2, (f) => (swCap?.over() ? null : logsAdaptive(logRpc, f, from, block, { step: CH.swapStep, maxStep: CH.swapStep, segments: eth ? 1 : 4, confirmEmpty: CH.confirmEmpty, retries: 2, ...(swCap ? { minStep: 500, budget: swCap } : {}) }))));
  const unreadGroups = got.filter((g) => g == null).length;
  const unreadIds = new Set(groups.flatMap((g, i) => (got[i] == null ? (Array.isArray(g.address) ? g.address : g.topics[1]) : [])));
  const seenLog = new Set();
  let dupLogs = 0;
  const logsRead = got.filter(Boolean).flat().filter((l) => { const k = `${l.transactionHash}:${parseInt(l.logIndex, 16)}`; if (seenLog.has(k)) { dupLogs++; return false; } seenLog.add(k); return true; });
  const swaps = logsRead.map(decodeSwap).filter(Boolean), extras = logsRead.map(decodeExtra).filter(Boolean);
  const byPoolEarly = new Map(), extrasByPool = new Map();
  for (const s of swaps) { if (!byPoolEarly.has(s.pool)) byPoolEarly.set(s.pool, []); byPoolEarly.get(s.pool).push(s); }
  for (const e of extras) { if (!extrasByPool.has(e.pool)) extrasByPool.set(e.pool, []); extrasByPool.get(e.pool).push(e); }
  const meta = new Map(mapped.map((p) => [p.id, p.v === 3 ? { fee: p.fee, feeProtocol: p.s.feeProtocol, dex: p.dex } : { protocolFee: p.s.protocolFee }]));
  const sums = summarize(swaps, meta);
  Object.assign(X, { unreadIds, byPoolEarly, extrasByPool, meta, sums });
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
    p.proto24h = pr;
    if (p.fees24h == null) { unpricedPools++; continue; }
    lpUsd += p.fees24h; protoUsd += pr ?? 0; volUsd += p.vol24h ?? 0;
    if (p.aggVolumeUsd24h > 0 && p.vol24h != null) volRatio.push(p.vol24h / p.aggVolumeUsd24h);
  }
  say(unreadGroups ? null : true, 'swaps', `${swaps.length} swaps in the last ${DAY_BLOCKS} blocks across ${sums.size} of ${mapped.length} pools (plus ${extras.filter((e) => e.kind === 'flash').length} v3 flash loans and ${extras.filter((e) => e.kind === 'donate').length} v4 donations); ${unreadGroups} of ${groups.length} log groups unread; ${dupLogs} duplicate logs dropped`);
  const protoOn = mapped.filter((p) => (p.v === 3 ? p.s.feeProtocol > 0 : p.s.protocolFee > 0));
  // PancakeSwap's Swap event books its own protocol fee: our decode of feeProtocol must reproduce it
  let pcsOurs = 0n, pcsTheirs = 0n, pcsSwaps = 0;
  for (const s of swaps) if (s.dex === 'pancakeswap' && s.protocolFees && meta.get(s.pool)) { const f = swapFees(s, meta.get(s.pool)); if (f) { pcsOurs += f.protocol; pcsTheirs += s.protocolFees[s.in]; pcsSwaps++; } }
  const pcsRatio = pcsTheirs > 0n ? Number(pcsOurs) / Number(pcsTheirs) : null;
  say(pcsRatio == null ? true : Math.abs(pcsRatio - 1) <= 0.02, 'fees', `LP fees ${usd(lpUsd)} and protocol fees ${usd(protoUsd)} on ${usd(volUsd)} of volume in 24 h; protocol fee on in ${protoOn.filter((p) => p.v === 3).length} of ${mapped.filter((p) => p.v === 3).length} v3-style and ${protoOn.filter((p) => p.v === 4).length} of ${mapped.filter((p) => p.v === 4).length} v4 pools; ${unpricedPools} pools unpriced; PancakeSwap protocol fee, our feeProtocol decode ÷ the Swap events' own: ${pcsRatio == null ? `— (${pcsSwaps} swaps)` : `${pcsRatio.toFixed(4)} over ${pcsSwaps} swaps`}`);
  say(volRatio.length ? within(volRatio, 0.75, 1.25) / volRatio.length >= 0.7 : null, 'volume check', `24 h volume vs DexScreener: within ±25% for ${within(volRatio, 0.75, 1.25)} of ${volRatio.length}; median ratio ${median(volRatio)?.toFixed(3) ?? '—'}`);
  const yieldOf = (p) => (p.fees24h != null && p.mapUsd > 0 ? (365 * p.fees24h) / p.mapUsd : null);
  say(true, 'stranded', `${strandedPools.length} pools ≥ ${usd(FLOOR)} have ≥ 80% of their value parked away from the price (${strandedPools.filter((p) => p.tag === 'one-sided').length} one-sided); median fee yield on total value ${fr(median(strandedPools.map(yieldOf)))} vs ${fr(median(mapped.filter((p) => p.hollow < 0.8).map(yieldOf)))} for the rest`);
  // 3b. Cross-check (step 5): the swap replay against the pools' own fee counters over the same blocks
  //     (read through archive nodes at both ends). The replay walks each swap's price path from the
  //     previous swap's price (the window's first from slot0 at its start), so a swap that crosses
  //     ticks books each stretch at that stretch's liquidity, and stretches the end-block map shows
  //     empty book nothing (lib/checks.mjs replayFeeGrowth). v3 flash payments and v4 donations count.
  //     v4 pools whose hook can return swap deltas are "unverified": their hook can settle part of a
  //     swap outside the pool's books, so they are counted apart and never become gems.
  const symOf = (a) => tok.get(a)?.symbol ?? C.quotes.find((q) => q.address === a)?.symbol ?? '?';
  const label = (p) => `${symOf(p.t0)}/${symOf(p.t1)} ${p.dex === 'pancakeswap' ? 'pcs' : 'v' + p.v} ${p.v === 4 && p.fee === DYNAMIC_FEE ? 'dynamic' : `${p.fee / 1e4}%`}`;
  X.symOf = symOf;
  for (const p of mapped) p.verified = p.v === 3 ? true : p.hooks == null ? null : !hookReturnsSwapDelta(p.hooks);
  const hookedOrDynamic = (p) => p.v === 4 && ((p.hooks && p.hooks !== ZERO) || p.fee === DYNAMIC_FEE);
  const fgPlan = mapped.filter((p) => !unreadIds.has(p.id) && sums.get(p.id)?.swaps >= 10);
  const [fgNowR, fgThenR] = await tm('fee counters', () => Promise.all([amc(fgPlan.flatMap(fgCalls), tag), amc(fgPlan.flatMap((p) => [...fgCalls(p), ...stCalls(p)]), '0x' + (from - 1).toString(16))]));
  const segOf = new Map(ready.map((p, i) => [p.id, maps[i]?.segments ?? null]));
  X.segOf = segOf;
  let kn = 0, kt = 0, fgUnread = 0;
  const fgSides = [];
  for (const p of fgPlan) {
    const n = fgCalls(p).length, thenR = fgThenR.slice(kt, kt + n + 2);
    const a = readFeeGrowth(p, fgNowR.slice(kn, kn + n)), z = readFeeGrowth(p, thenR.slice(0, n));
    kn += n; kt += n + 2;
    const s0 = p.v === 3 ? readV3Slot0(thenR[n]) : readV4Slot0(thenR[n]), L0 = readUint(thenR[n + 1]);
    const evs = byPoolEarly.get(p.id) || [], m = meta.get(p.id);
    const rep = s0 && L0 != null ? replayFeeGrowth({ swaps: evs, extras: extrasByPool.get(p.id) || [], meta: m, start: { sqrtPriceX96: s0.sqrtPriceX96, liquidity: L0 }, path: pathIndex(segOf.get(p.id)) }) : null;
    if (s0 && s0.sqrtPriceX96 > 0n) p.startSqrt = s0.sqrtPriceX96; // the price the window's first swap found (flow quality)
    const neu = feeIdentityPath(rep, z, a), old = feeIdentity(evs, m, z, a);
    if (!neu) { fgUnread++; continue; }
    const endGap = rep.end.sqrtPriceX96 !== B(p.s.sqrtPriceX96); // the last swap's price must be the end block's
    const feeMoved = p.v === 3 ? s0.feeProtocol !== p.s.feeProtocol : s0.protocolFee !== p.s.protocolFee;
    for (const side of [0, 1]) if (neu[side] != null || old?.[side] != null) fgSides.push({ p, side, old: old?.[side] ?? null, neu: neu[side], sd: rep.sides[side], endGap, feeMoved });
  }
  X.fgSides = fgSides;
  const cause = (x) => (hookedOrDynamic(x.p) ? 'hooked/dynamic-fee' : x.sd.extras ? 'donations/flash' : x.endGap || x.sd.backwards ? 'missing events'
    : x.feeMoved ? 'fee setting changed' : x.sd.empty ? 'empty-stretch crossings' : x.sd.crossing ? 'crossing swaps' : 'other');
  const oldSides = fgSides.filter((x) => x.old != null), oldMiss = oldSides.filter((x) => !in2(x.old));
  say(true, 'fee identity before', `the old method (each swap's fee ÷ its post-swap liquidity) puts ${oldSides.length - oldMiss.length} of ${oldSides.length} sides within 2%; its misses by cause: ${top(tally(oldMiss.map(cause)), 7)}; the same misses replayed along the price path: ${oldMiss.filter((x) => in2(x.neu)).length} now within 2%`);
  const ver = fgSides.filter((x) => x.neu != null && x.p.verified === true), unver = fgSides.filter((x) => x.neu != null && x.p.verified !== true);
  const hit = ver.filter((x) => in2(x.neu)).length;
  const pcsVer = ver.filter((x) => x.p.dex === 'pancakeswap');
  say(ver.length ? hit / ver.length >= 0.9 : null, 'fee identity', `replayed price paths vs the pools' fee counters over the same ${DAY_BLOCKS} blocks: within 2% for ${hit} of ${ver.length} verifiable pool sides (${pct(hit, ver.length)}), within 10% for ${within(ver.map((x) => x.neu), 0.9, 1.1)}; median ${median(ver.map((x) => x.neu))?.toFixed(4) ?? '—'}; PancakeSwap ${pcsVer.filter((x) => in2(x.neu)).length} of ${pcsVer.length} sides within 2%; unverified (hooks that can return swap deltas, or unknown hooks) ${new Set(unver.map((x) => x.p.id)).size} pools, ${unver.filter((x) => in2(x.neu)).length} of ${unver.length} sides within 2%; ${fgUnread} pools' counters or start state unread`);
  const miss = ver.filter((x) => !in2(x.neu));
  const ex = [...oldMiss.filter((x) => x.p.verified === true && !in2(x.neu)), ...miss.filter((x) => in2(x.old) || x.old == null), ...oldMiss.filter((x) => in2(x.neu))].slice(0, 10);
  const r4 = (x) => (x == null ? '—' : Number.isFinite(x) ? x.toFixed(3) : '∞');
  // kept short: the job notice that carries every line is cut off past a few thousand characters
  const flags = (x) => [[x.sd.crossing, 'cross'], [x.sd.empty, 'empty stretch'], [x.sd.extras, 'flash/donate'], [x.sd.still, 'no move'], [x.sd.backwards, 'against price'], [x.sd.inconsistent || 0, 'over fee rate']].filter(([n]) => n).map(([n, k]) => `${n} ${k}`).join(', ');
  const capped = fgSides.filter((x) => x.sd.inconsistent).length;
  say(true, 'fee identity misses', `left by cause: ${top(tally(miss.map(cause)), 7)}; sides with swaps paying more than the fee rate (capped to their own fee) ${capped}; examples, old → path: ${ex.slice(0, 6).map((x) => `${label(x.p)} ${x.side ? symOf(x.p.t1) : symOf(x.p.t0)} ${r4(x.old)} → ${r4(x.neu)} (${x.sd.swaps} swaps${flags(x) ? ': ' + flags(x) : ''}${x.endGap ? ', end price differs' : ''})`).join('; ') || 'none'}`);

  // 4. Step 4 snapshot: volatility, scores and markouts.
  const WETH = C.quotes.find((q) => q.symbol === 'WETH').address;
  X.WETH = WETH;
  const keyOf = (a) => `${CH.coingecko}:${a === ZERO ? WETH : a}`;
  // Market history for the volatility cross-check: CoinGecko by contract (hourly points over 30 days),
  // each token at most once a UTC day through a cache file the next pass reuses; DefiLlama's chart for
  // the tokens CoinGecko doesn't answer. Never a flat line for a token nobody answered.
  const histKeys = [...new Set(mapped.flatMap((p) => [keyOf(p.t0), keyOf(p.t1)]))];
  // another chain within its history cap: the keys it leaves are asked on later passes (the cache keeps each day's)
  const hiCap = eth ? null : cap('history');
  const th = await tm('history', () => tokenHistory(getJson, histKeys, { key: process.env.COINGECKO_KEY || undefined, cache: hcache, apis, ...(hiCap ? { budget: hiCap } : {}) }));
  const notAsked = new Set(th.skipped);
  const hist = { series: th.series, unread: th.unread };
  // Each pool's own price at 31 daily blocks (archive state): that price is what range exits and LVR
  // follow. Each block's own timestamp comes along (Multicall3), so the market is sampled at the same moments.
  const pxCalls = [tsCall, ...mapped.map((p) => (p.v === 3 ? { target: p.id, data: encodeCall('slot0()') } : v4Slot0Call(C.v4StateView, p.id)))];
  const pxDays = await tm('daily prices', () => mapLimit(Array.from({ length: 31 }, (_, k) => block - backBlocks(k * 86400)), 3, (b) => amc(pxCalls, '0x' + b.toString(16))));
  const dayTs = pxDays.map((res, k) => { const ts = readUint(res[0]); return ts != null ? Number(ts) : nowSec - k * 86400; });
  mapped.forEach((p, i) => {
    p.dailyPx = [];
    pxDays.forEach((res, k) => {
      const s0 = p.v === 3 ? readV3Slot0(res[i + 1]) : readV4Slot0(res[i + 1]);
      if (s0 && s0.sqrtPriceX96 > 0n) { const x = Number(s0.sqrtPriceX96) / 2 ** 96; p.dailyPx.push({ t: dayTs[k], price: x * x }); }
    });
  });
  const gp = await rpc.call('eth_gasPrice', []), ethUsd = tok.get(WETH)?.usd;
  const gasUsd = gp && ethUsd > 0 ? ((parseInt(gp, 16) * RERANGE_GAS) / 1e18) * ethUsd : null;
  Object.assign(X, { gp, gasUsd });
  for (const p of mapped) {
    const a = hist.series.get(keyOf(p.t0)), c = hist.series.get(keyOf(p.t1));
    // the market's token0-in-token1 at the pool's own sample moments (or by UTC day without them)
    const ratio = a && c ? (p.dailyPx.length >= 8 ? ratioAt(a, c, p.dailyPx.map((x) => x.t)) : ratioByDay(a, c)) : null;
    p.sigmaChain = dailySigma(p.dailyPx);
    p.sigmaMarket = ratio ? dailySigma(ratio) : null;
    p.sigma = p.sigmaChain ?? p.sigmaMarket;
    Object.assign(p, p.dailyPx.length >= 8 ? recentMoves(p.dailyPx) : ratio ? recentMoves(ratio) : { move7dLog: null, lastDayLog: null });
    p.score = scorePool({ tick: p.s.tick, sqrt: p.sqrt, d1: p.d1, usdPer1: p.per1, activeL: p.L, feeTier: (p.v === 3 ? p.fee : p.s.lpFee) / 1e6, feesPerDayUsd: p.fees24h, sigma: p.sigma, walls: p.walls },
      { days: HOLD_DAYS, ticket: EXAMPLE_TICKET, gasUsd });
    const feeOf = (s) => swapFees(s, meta.get(p.id))?.total ?? null;
    const m = unreadIds.has(p.id) ? null : markouts(byPoolEarly.get(p.id) || [], { horizon: MARKOUT_BLOCKS, endBlock: block, feeOf });
    p.markout = m ? m.ratio : null;
    // flow quality, the day's retail share (lib/flowq.mjs): the same swaps, the same horizon, each swap's LP fee
    p.retail = unreadIds.has(p.id) ? null : retailShare(classifySwaps(byPoolEarly.get(p.id) || [], { horizon: MARKOUT_BLOCKS, endBlock: block, prev: p.startSqrt ?? null, feeOf: (s) => swapFees(s, meta.get(p.id))?.lp ?? null }));
  }
  // With the suggested range known, measure parked liquidity again beyond max(±r, 2%), and re-tag the shape.
  for (const p of mapped) {
    const seg = segOf.get(p.id);
    if (!seg || !(nearOf(p) > NEAR_MIN)) continue;
    const h = hollowness(seg, p.sqrt, p.d1, p.s.tick, p.L, { near: nearOf(p) });
    p.hollow = h.hollow; p.aboveShare = h.aboveShare; p.tag = shapeTag(h);
  }
  const withSigma = mapped.filter((p) => p.sigma != null), both = mapped.filter((p) => p.sigmaChain > 0 && p.sigmaMarket > 0);
  say(withSigma.length ? true : null, 'volatility', `30-day volatility for ${withSigma.length} of ${mapped.length} pools (${mapped.filter((p) => p.sigmaChain != null).length} from the pool's own daily price, ${withSigma.length - mapped.filter((p) => p.sigmaChain != null).length} from market history); median ${fr(median(withSigma.map((p) => p.sigma)))} a day; re-range gas ${gasUsd == null ? '—' : '$' + gasUsd.toFixed(2)}`);
  {
    // a pool whose token the history cap left for a later pass is not counted against the check (not read is not a miss)
    const sc = mapped.filter((p) => p.score?.net != null && !notAsked.has(keyOf(p.t0)) && !notAsked.has(keyOf(p.t1))), readM = sc.filter((p) => p.sigmaMarket != null), rr = both.map((p) => p.sigmaChain / p.sigmaMarket);
    const calm = both.filter((p) => p.sigmaChain < 0.002 && p.sigmaMarket < 0.002);
    say(sc.length && both.length ? readM.length / sc.length >= 0.9 && within(rr, 0.7, 1.3) / both.length >= 0.7 : null, 'volatility check',
      `market volatility read for ${readM.length} of ${sc.length} scored pools (${pct(readM.length, sc.length)}); pool vs market within 30% for ${within(rr, 0.7, 1.3)} of ${both.length} (${pct(within(rr, 0.7, 1.3), both.length)}), median ratio ${median(rr)?.toFixed(2) ?? '—'}; calm pairs (both under 0.2% a day) ${calm.length}, within 30% ${within(calm.map((p) => p.sigmaChain / p.sigmaMarket), 0.7, 1.3)}` +
      `; history: ${th.by.cache} from today's cache, DefiLlama ${th.by.defillama} (${th.calls.defillama} calls), GeckoTerminal ${th.by.geckoterminal} (${th.calls.geckoterminal} calls), CoinGecko ${th.by.coingecko} (${th.calls.coingecko} calls)${th.lastError ? `, last error ${th.lastError}` : ''}; unread ${hist.unread.length} of ${histKeys.length} tokens${notAsked.size ? ` (${notAsked.size} left by a cap for later passes)` : ''}`);
  }
  const scored = mapped.filter((p) => p.score?.net != null);
  const posN = scored.filter((p) => p.score.net > 0), edgy = scored.filter((p) => p.score.edge > 1);
  say(true, 'scores', `at a $${EXAMPLE_TICKET} example ticket over ${HOLD_DAYS}-day ranges: ${scored.length} pools scored; net APR above zero for ${posN.length}, fees above LVR (edge > 1) for ${edgy.length}; median fee APR ${fr(median(scored.map((p) => p.score.feeApr)))}, LVR ${fr(median(scored.map((p) => p.score.lvr)))}, net ${fr(median(scored.map((p) => p.score.net)))}`);
  const sScored = scored.filter((p) => p.hollow >= 0.8);
  say(true, 'stranded scores', `of the ${strandedPools.length} stranded or one-sided pools, ${sScored.length} scored: net APR above zero for ${sScored.filter((p) => p.score.net > 0).length}; median net ${fr(median(sScored.map((p) => p.score.net)))}, median edge ${median(sScored.map((p) => p.score.edge))?.toFixed(2) ?? '—'}`);
  const mk = mapped.filter((p) => p.markout != null);
  say(true, 'flow', `markouts (${MARKOUT_BLOCKS} blocks after each swap) read for ${mk.length} pools: median ${fr(median(mk.map((p) => p.markout)))} of the fee; ${mk.filter((p) => p.markout <= 0.6).length} pass the toxic-flow filter (≤ 60%); the day's retail share read for ${mapped.filter((p) => p.retail).length} pools, median ${fr(median(mapped.map((p) => p.retail?.share ?? null)))}`);
  const moved = mapped.filter((p) => p.sigma > 0 && p.move7dLog != null && p.lastDayLog != null && Math.abs(p.move7dLog) / (p.sigma * Math.sqrt(7)) >= 2 && Math.abs(p.lastDayLog) <= p.sigma);
  say(true, 'lenses today', `stranded ${strandedPools.filter((p) => p.tag === 'stranded').length}, one-sided ${strandedPools.filter((p) => p.tag === 'one-sided').length}, after a big move ${moved.length} (30-day averages, pool ages and calm-pair kinds come with stored history)`);
  // 5. Persistence from past maps (archive state at 10, 20 and 30 days ago) for the pools that look
  //    stranded or close to it today, plus the benchmark as the worked example; then the gem score.
  let budget = eth ? 250_000 : 100_000;
  const cands = mapped.filter((p) => p.hollow >= 0.5 || p.id === BENCH).filter((p) => { const w = wordsFor(p.tickSpacing).length * 3; if (w > budget && p.id !== BENCH) return false; budget -= w; return true; });
  const nowSeg = new Map(ready.map((p, i) => [p.id, maps[i]?.segments ?? null]));
  X.nowSeg = nowSeg;
  const pastBlocks = [10, 20, 30].map((d) => block - backBlocks(d * 86400));
  let pastRead = 0, pastTried = 0, pastStale = 0;
  // another chain's past maps within its cap (a date the cap stops is unread)
  const paCap = eth ? UNLIMITED : cap('past');
  const pamc = paCap === UNLIMITED ? amc : makeMulticall(capRpc(arpc, paCap), { chunk: 300, concurrency: 3 });
  await tm('past maps', async () => {
    for (const pb of pastBlocks) {
      const ptag = '0x' + pb.toString(16);
      // the block's own timestamp rides along: a node that answers an old block with today's state is not
      // a past map; the fee counters ride along too, so each past map is also a full snapshot row
      const st = await pamc([tsCall, ...cands.flatMap((p) => [...stCalls(p), ...fgCalls(p)])], ptag);
      const ts = readUint(st[0]), real = ts != null && ageOk(ts, block - pb);
      if (!real) pastStale++;
      const alive = [];
      let o = 1;
      cands.forEach((p) => {
        const n = stCalls(p).length + fgCalls(p).length, a = st.slice(o, o + n);
        o += n;
        const s0 = p.v === 3 ? readV3Slot0(a[0]) : readV4Slot0(a[0]), L = readUint(a[1]);
        p.past = p.past || [];
        if (!real) { p.past.push({ hollow: null, segments: null }); return; } // not that block's state: unread
        if (s0 === false) { p.past.push({ hollow: null, segments: null, absent: true }); return; } // the pool did not exist yet
        if (!s0 || L == null || !(s0.sqrtPriceX96 > 0n)) { p.past.push({ hollow: null, segments: null }); return; }
        alive.push({ p, s0, L, a, t: Number(ts) * 1000 });
      });
      pastTried += alive.length;
      const ms = alive.length ? await readMaps(pamc, alive.map(({ p, s0, L }) => ({ v: p.v, id: p.id, tickSpacing: p.tickSpacing, tick: s0.tick, liquidity: L })), { stateView: C.v4StateView, tag: ptag }) : [];
      alive.forEach(({ p, s0, a, t }, i) => {
        const m = ms[i];
        if (!m || m.unread || !(m.checks.netSumZero && m.checks.matchesPool)) { p.past.push({ hollow: null, segments: null }); return; }
        pastRead++;
        const h = hollowness(m.segments, sqrtX96ToSqrt(s0.sqrtPriceX96), p.d1, s0.tick, m.checks.walkedLiquidity, { near: nearOf(p) });
        p.past.push({ hollow: h.hollow, segments: m.segments });
        // the snapshot row at that block, with its parked share (merged with the backfill in the outputs)
        const r = readBackfill(p.v, a);
        if (r.kind === 'row') (p.pastRows ||= []).push({ t, block: pb, ...r.row, parked: Number.isFinite(h.hollow) ? h.hollow : null });
      });
    }
  });
  for (const p of cands) {
    const hs = [p.hollow, ...p.past.map((x) => x.hollow)];
    p.strandedShare = strandedShare(hs);
    p.hollowAvg = hs.filter((h) => h != null).length >= 2 ? hs.filter((h) => h != null).reduce((a, x) => a + x, 0) / hs.filter((h) => h != null).length : null;
    const oldest = [...p.past].reverse().find((x) => x.segments);
    p.sticky = oldest ? stickyShare(nowSeg.get(p.id), oldest.segments, { tick: p.s.tick, activeL: p.L, sp: p.sqrt, d1: p.d1 }) : null;
    const ws = [p.score?.wallSigmaBelow, p.score?.wallSigmaAbove].filter((x) => x != null);
    const wsMin = ws.length ? Math.min(...ws) : null;
    p.persistence = persistenceScore({ strandedDays30: p.strandedShare == null ? null : 30 * p.strandedShare, wallSigma: wsMin === Infinity ? 99 : wsMin, inactiveShare: p.sticky });
    const r = sums.get(p.id);
    p.flow = flowScore({ markoutToFee: p.markout, traders7d: r ? 7 * r.txs : null });
    const warnings = [];
    if (isHooked(p)) warnings.push('hooked pool');
    if (r && r.swaps < 10) warnings.push('thin: under 10 swaps a day');
    if (p.offMarket) warnings.push('pool price more than 10% off market');
    p.gem = gemScore({ stranded: p.hollowAvg, net: p.score?.net ?? null, persistence: p.persistence, flow: p.flow, warnings, fails: p.verified === false ? ['unverified: its hook can settle swaps outside the pool'] : [] });
  }
  const gems = cands.filter((p) => p.gem?.total != null && p.id !== BENCH);
  say(pastRead ? true : null, 'persistence', `past maps read ${pastRead} of ${pastTried} (${cands.length} pools × 3 dates through archive nodes; dates answered with today's state, dropped: ${pastStale} of 3); stranded in every snapshot ${cands.filter((p) => p.strandedShare === 1).length}; median share of today's parked value already there 30 days ago ${fr(median(cands.map((p) => p.sticky)))}`);
  say(true, 'gem scores', `${gems.length} candidates scored: ${gems.filter((p) => p.gem.total >= 60).length} at 60 or more, ${gems.filter((p) => p.gem.total >= 40).length} at 40 or more; median ${median(gems.map((p) => p.gem.total)) ?? '—'}; blank for missing inputs ${cands.filter((p) => p.gem && p.gem.total == null).length} (most often: ${top(tally(cands.flatMap((p) => p.gem?.missing ?? [])), 3)})`);
  if (eth) {
    const b = ready.find((p) => p.id === BENCH);
    if (b && b.tag) {
      say(true, 'benchmark', `UNI/WETH 0.3%: ${usd(b.mapUsd)} mapped, stranded ${fr(b.hollow)} (${b.tag}), ±9% holds ${fr(b.band9)}; 24 h volume ${usd(b.vol24h)}, LP fees ${usd(b.fees24h)}; protocol fee ${b.s.feeProtocol ? 'on' : 'off'}`);
      const k = b.score || {};
      say(true, 'benchmark score', `σ ${fr(b.sigma)} a day → range ±${fr(k.r)}; at $${EXAMPLE_TICKET}: fee APR ${fr(k.feeApr)}, LVR ${fr(k.lvr)}, net ${fr(k.net)}, edge ${k.edge?.toFixed(2) ?? '—'}, re-range every ${k.rerangeDays ? Math.round(k.rerangeDays) + ' days' : '—'}; markouts ${fr(b.markout)} of the fee; nearest walls ${k.wallSigmaBelow == null ? '—' : k.wallSigmaBelow === Infinity ? 'none in view' : k.wallSigmaBelow.toFixed(1) + ' σ-weeks'} below, ${k.wallSigmaAbove == null ? '—' : k.wallSigmaAbove === Infinity ? 'none in view' : k.wallSigmaAbove.toFixed(1) + ' σ-weeks'} above`);
      say(true, 'benchmark persistence', `stranded in ${b.strandedShare == null ? '—' : Math.round(b.strandedShare * (b.past.filter((x) => x.hollow != null).length + 1))} of ${b.past.filter((x) => x.hollow != null).length + 1} snapshots (now, 10, 20, 30 days ago: ${[b.hollow, ...(b.past || []).map((x) => x.hollow)].map(fr).join(', ')}); parked value already there 30 days ago ${fr(b.sticky)}; gem ${b.gem?.total ?? 'blank'}${b.gem?.missing?.length ? ' (missing ' + b.gem.missing.join(', ') + ')' : ''}`);
    } else say(null, 'benchmark', 'not mapped');
  }
  for (const p of mapped) p.X = X;
  // the backstop covers steps 1-5 only: the outputs' reads (fee counters now, backfill, sell tests, transactions)
  // run within their own caps, on the chain's nodes as such
  if (chainCap !== UNLIMITED) {
    Object.assign(X, { rpc: rawRpc, arpc: rawArpc, mc: makeMulticall(rawRpc, { chunk: 400, concurrency: 4 }), amc: makeMulticall(rawArpc, { chunk: 300, concurrency: 3 }) });
    X.chainNote = chainCap.note();
  }
  return X;
}
function sayRoot(ok, area, msg) { return say(ok, area, msg); }

// ---------------------------------------------------------------------------------------------------------
async function writeOutputs() {
  const rnd = (x, n = 6) => (isNum(x) ? Number(x.toPrecision(n)) : null);
  const prev = (() => { try { return store?.get('live.json') ?? null; } catch { return null; } })();
  // the stored snapshots (restored from the data branch); one that won't open or parse is never overwritten
  let snaps = new Map(), snapsOk = true;
  let rebuilt = false;
  let gtCache = new Map(), sxCache = emptyCache();
  if (store) { try { const o = store.get('snapshots.json'); if (o && (o.fix ?? 0) >= SNAP_FIX) snaps = parseStore(o); else if (o) rebuilt = true; gtCache = unpackGt(o?.gt); sxCache = unpackSx(o?.sx); } catch { snapsOk = false; } }
  // Which chains' new rows are kept. A loop pinned to code from before Base reads every stored row's block
  // number into ONE block clock for its Ethereum backfill, so Base rows must not reach the shared store while
  // such a loop may still run: Ethereum's rows always are; another chain's only when this pass runs as the
  // live loop (MODE=live: the loop is pinned to this code), or when the last live.json came from such a pass
  // (it says so in `stored`; a loop of older code rewrites live.json without it every pass). Rows not kept
  // still feed this pass's windows.
  const keepChains = new Set(['ethereum', ...(process.env.MODE === 'live' ? ctxs.map((X) => X.CH.id) : (prev?.stored || []).filter((c) => CHAIN_IDS.includes(c)))]);
  const chainOf = new Map(mapped.map((p) => [p.id, p.chain]));
  const sig = (m) => [...m].map(([id, x]) => `${id}:${x.h.length}:${x.h.at(-1)?.t}:${x.d.length}:${x.d.at(-1)?.t}:${x.y ? `${x.y.f.size}:${x.y.r.length}:${x.y.nb ?? ''}` : ''}`).sort().join('|');
  const before = sig(snaps);
  // The fee history's day volumes (lib/feehist.mjs): GeckoTerminal's public day candles, each pool fetched once and
  // cached in snapshots.json (gt), then only the newest days once a UTC day; about 25 calls a minute and a capped
  // number per pass (FEEHIST.gt; READ_CAPS {"gt": {...}} lowers it for a test), alongside the reads below.
  const gtCap = { ...FEEHIST.gt, ...(CAP_OVERRIDE.gt || {}) };
  const gtPools = mapped.map((p) => ({ id: p.id, network: p.X.CH.gecko, t0: p.t0, t1: p.t1, weth: p.X.WETH, tvl: p.tvl ?? p.mapUsd ?? 0 }));
  const gtRun = store && snapsOk
    ? timed('fee history volumes', () => fetchVolumes(getJson, gtPools, { cache: gtCache, now: passT, budget: makeBudget({ ms: gtCap.ms, calls: gtCap.calls }), spacingMs: gtCap.spacingMs }))
      .catch((e) => ({ pools: gtPools.length, wanted: 0, full: 0, fresh: 0, missed: 0, failed: 0, calls: 0, stopped: 'broke', lastError: errWord(e) }))
    : Promise.resolve(null);
  // fee growth now for every mapped pool (the 24 h check read it only for busy pools)
  const rows = new Map();
  for (const X of ctxs) {
    const fgNow = await X.mc(X.mapped.flatMap(X.fgCalls), X.tag);
    let k = 0;
    for (const p of X.mapped) {
      const n = X.fgCalls(p).length, fg = readFeeGrowth(p, fgNow.slice(k, k + n));
      k += n;
      p.row = { t: X.passT, block: X.block, sqrtPriceX96: B(p.s.sqrtPriceX96), tick: p.s.tick, L: p.L, fg0: fg?.[0] ?? null, fg1: fg?.[1] ?? null, parked: isNum(p.hollow) ? p.hollow : null };
      rows.set(p.id, [p.row]);
    }
    for (const p of X.mapped) if (p.pastRows) rows.get(p.id).push(...p.pastRows);
  }
  // backfill (lib/backfill.mjs), per chain: every hour of the last 14 days and every day of the last 90 that a
  // pool's series is missing, read at that moment's block through archive nodes, the windows' moments first,
  // within a per-pass budget; what is left waits for the next pass. Each batch carries its own block timestamp
  // through Multicall3, and a batch whose node answered with today's state for an old block is dropped. A pool
  // that was not there yet gives no row (absent, never 0), and that moment is remembered so it is not asked
  // for again. Ethereum's clock interpolates the store's own (time, block) pairs, Ethereum's only; a chain
  // with a fixed block clock (Base, lib/chains.mjs eras) needs no probes.
  // The fee history's deep backfill (lib/feehist.mjs) rides on the same reads, after every moment above: one block
  // per past UTC day (00:05) back to the pool's creation, at most 365 days, a few days a pool and a capped number of
  // batches per pass (Ethereum FEEHIST.deep.batches, another chain its caps.backfill.deep), only for the chains whose
  // rows the store keeps. Ethereum's deep moments get their block from a timestamp read at each one first (the
  // anchors can be months apart there); a run of unread deep batches leaves the rest for the next pass.
  const unborn = new Map(), deepUnborn = new Map();
  const bf = { wanted: 0, planned: 0, jobs: 0, retried: 0, skipped: 0, rows: 0, unbornMoments: 0, stale: 0, unread: 0, batches: 0, probesRead: 0, probesTried: 0,
    deepWanted: 0, deepJobs: 0, deepRows: 0, deepUnborn: 0, deepUnread: 0, deepBroke: 0 };
  if (snapsOk) {
    for (const X of ctxs) {
      const eth = X.CH.id === 'ethereum';
      const bfCalls = (p) => [...X.stCalls(p), ...X.fgCalls(p)]; // slot0, liquidity, fee growth
      const byId = new Map(X.mapped.map((p) => [p.id, p]));
      const entries = X.mapped.map((p) => ({ id: p.id, calls: bfCalls(p).length, series: snaps.get(p.id), notBefore: isNum(p.createdAt) ? p.createdAt * 1000 : null }));
      // Ethereum's anchors are the store's Ethereum rows: a stored Base row's block number is always above
      // Ethereum's head (Base counts blocks 10-60 times faster), so the head filters them out exactly
      const anchors = [{ t: X.passT, block: X.block }, ...(eth ? storePoints(snaps).filter((q) => q.block <= X.block) : [])];
      const bfc = X.CH.caps?.backfill;
      const budget = eth ? {} : { maxBatches: bfc?.batches ?? 60 };
      const deadline = eth ? BACKFILL.deadlineMs : bfc?.ms ?? 40e3;
      const deepMax = keepChains.has(X.CH.id) ? (eth ? FEEHIST.deep.batches : bfc?.deep ?? 0) : 0;
      const deepOf = (s, o) => deepMoments(s, { ...o, perPool: FEEHIST.deep.perPool });
      let plan = { jobs: [], wanted: 0, planned: 0 }, deep = { jobs: [], wanted: 0, planned: 0 }, jobs = [], run = { results: [], started: 0, skipped: 0, retried: 0 };
      await timed(X.CH.prefix + 'backfill', async () => {
        let clock, known = anchors;
        const probe = async (blocks) => {
          const pr = await mapLimit(blocks, 3, (b) => X.amc([tsCall], '0x' + b.toString(16)));
          const pairs = [];
          blocks.forEach((b, i) => { const ts = readUint(pr[i]?.[0]); if (ts != null && X.ageOk(ts, X.block - b)) pairs.push({ t: Number(ts) * 1000, block: b }); });
          bf.probesTried += blocks.length; bf.probesRead += pairs.length;
          return pairs;
        };
        if (X.CH.eras) clock = (T) => blockAtTime(X.CH, T / 1000);
        else {
          // block timestamps first where the moments wanted reach past the pairs the store knows (lib/backfill.mjs)
          const clock0 = blockClock(anchors, { secPerBlock: X.CH.secPerBlock });
          const probes = probeMoments(anchors, oldestMissing(entries, { now: X.passT })).map((T) => clock0(T)).filter((b) => Number.isSafeInteger(b) && b > 0 && b < X.block);
          known = [...anchors, ...(await probe(probes))];
          clock = blockClock(known, { secPerBlock: X.CH.secPerBlock });
        }
        plan = planBackfill(entries, { now: X.passT, clock, block: X.block, ...budget });
        if (deepMax > 0) {
          deep = planBackfill(entries, { now: X.passT, clock, block: X.block, maxBatches: deepMax, momentsOf: deepOf });
          if (!X.CH.eras && deep.jobs.length) {
            const blocks = [...new Set(deep.jobs.map((j) => j.block))];
            clock = blockClock([...known, ...(await probe(blocks))], { secPerBlock: X.CH.secPerBlock });
            deep = planBackfill(entries, { now: X.passT, clock, block: X.block, maxBatches: deepMax, momentsOf: deepOf });
          }
        }
        let deepFails = 0;
        const read = async (job) => {
          if (job.rank === DEEP_RANK && deepFails >= FEEHIST.deep.stopAfter) { bf.deepBroke++; return null; }
          const ans = await X.amc([tsCall, ...job.ids.flatMap((id) => bfCalls(byId.get(id)))], '0x' + job.block.toString(16));
          if (job.rank === DEEP_RANK) deepFails = readUint(ans?.[0]) == null ? deepFails + 1 : 0;
          return ans;
        };
        const all = [...plan.jobs, ...deep.jobs];
        const t0 = Date.now(), first = await runBudgeted(all, read, { deadlineMs: deadline });
        // a batch that landed outside its moment's hour is read once more at the block its timestamp points to
        const tsOf = (ans, job) => { const ts = readUint(ans?.[0]); return ts != null && X.ageOk(ts, X.block - job.block) ? Number(ts) * 1000 : null; };
        const again = X.CH.eras ? [] : retryJobs(all, all.map((job, j) => tsOf(first.results[j], job)), { block: X.block, secPerBlock: X.CH.secPerBlock, max: Math.ceil(BACKFILL.maxBatches / 4) });
        const left = deadline - (Date.now() - t0);
        const second = again.length && left > 0 ? await runBudgeted(again, read, { deadlineMs: left }) : { results: again.map(() => null), started: 0, skipped: again.length };
        jobs = [...all, ...again];
        run = { results: [...first.results, ...second.results], started: first.started + second.started, skipped: first.skipped + second.skipped, retried: again.length };
      });
      bf.wanted += plan.wanted; bf.planned += plan.planned; bf.jobs += plan.jobs.length; bf.retried += run.retried; bf.skipped += run.skipped; bf.batches += run.started;
      bf.deepWanted += deep.wanted; bf.deepJobs += deep.jobs.length;
      jobs.forEach((job, j) => {
        const ans = run.results[j], isDeep = job.rank === DEEP_RANK;
        if (!ans) return; // not started within the time budget: next pass
        const ts = readUint(ans[0]);
        if (ts == null) { bf.unread++; if (isDeep) bf.deepUnread++; return; }
        if (!X.ageOk(ts, X.block - job.block)) { bf.stale++; return; } // not that block's state
        let o = 1;
        for (const id of job.ids) {
          const p = byId.get(id), n = bfCalls(p).length, r = readBackfill(p.v, ans.slice(o, o + n));
          o += n;
          if (r.kind === 'row') { rows.get(id).push({ t: Number(ts) * 1000, block: job.block, ...r.row, parked: null }); bf.rows++; if (isDeep) bf.deepRows++; }
          else if (r.kind === 'unborn') {
            const m = isDeep ? deepUnborn : unborn;
            m.set(id, Math.max(m.get(id) ?? 0, Number(ts) * 1000)); bf.unbornMoments++; if (isDeep) bf.deepUnborn++;
          }
        }
      });
    }
  }
  // one store for the windows (every chain's rows), one to keep (the chains whose rows may be stored)
  const keepRows = new Map([...rows].filter(([id]) => keepChains.has(chainOf.get(id))));
  const keepUnborn = new Map([...unborn].filter(([id]) => keepChains.has(chainOf.get(id))));
  const snapsKeep = mergeStore(snapsOk ? snaps : new Map(), keepRows, { now: passT, unborn: keepUnborn });
  const snaps2 = mergeStore(snapsKeep, new Map([...rows].filter(([id]) => !keepRows.has(id))), { now: passT, unborn: new Map([...unborn].filter(([id]) => !keepUnborn.has(id))) });
  // the fee history's deep record per pool (lib/feehist.mjs foldDeep): every exact day of the year, folded from
  // the previous tiers' rows, this pass's and the deep backfill's; kept with the store for the chains it keeps
  for (const p of mapped) {
    const prevS = snaps.get(p.id), passRows = [...(prevS?.h || []), ...(prevS?.d || []), ...(rows.get(p.id) || [])];
    for (const st of keepChains.has(p.chain) ? [snapsKeep, snaps2] : [snaps2]) {
      const s = st.get(p.id);
      if (!s) continue;
      const y = foldDeep(s, passRows, { now: passT, unborn: deepUnborn.get(p.id) ?? null, notBefore: isNum(p.createdAt) ? p.createdAt * 1000 : null });
      if (y) s.y = y; else delete s.y;
    }
  }
  const gt = await gtRun;
  const changed = snapsOk && (rebuilt || sig(snapsKeep) !== before || (gt && gt.full + gt.fresh + gt.missed > 0));

  // contract-verified: both tokens' source (Etherscan v2 for the chain, Blockscout where Etherscan doesn't
  // answer; cached a week; no answer: unread)
  const vCache = makeVerifiedCache('out/cache/etherscan.json');
  const vOfChain = new Map(), vLines = [];
  for (const X of ctxs) {
    const vTok = [...new Set(X.mapped.flatMap((p) => [p.t0, p.t1]).filter((a) => a !== ZERO))];
    // another chain within its cap, and a source that keeps refusing the chain is dropped after 3 tokens in a row
    const scap = X.CH.id === 'ethereum' ? null : X.cap('source');
    const vs = await timed(X.CH.prefix + 'etherscan', () => verifiedSources(getJson, vTok, { key: process.env.ETHERSCAN_KEY || undefined, cache: vCache, chainId: X.CH.etherscan, blockscout: X.CH.id === 'ethereum' ? null : X.CH.blockscout, ...(scap ? { budget: scap, breaker: 3 } : {}) }));
    vOfChain.set(X.CH.id, vs.verified);
    vLines.push({ X, vs, n: vTok.length });
  }
  try { vCache.save(); } catch { /* read again next pass */ }
  for (const { X, vs, n } of vLines) {
    const vals = [...vs.verified.values()];
    say(vs.calls || vs.cached ? true : null, `${X.CH.prefix}contract source`, `tokens with verified source ${vals.filter((x) => x === true).length} of ${n}, unverified ${vals.filter((x) => x === false).length}, unread ${vals.filter((x) => x == null).length} (${vs.fetched} read, ${vs.cached} from the week's cache${vs.lastError ? `, last error ${vs.lastError}` : ''}${vs.off?.length ? `; not asked again this pass after 3 unread in a row: ${vs.off.join(', ')}` : ''})`);
  }
  const vOf = (p, a) => (a === ZERO ? true : vOfChain.get(p.chain)?.get(a) ?? null);
  const bothVerified = (p) => { const v = [vOf(p, p.t0), vOf(p, p.t1)]; return v.includes(false) ? false : v.includes(null) ? null : true; };
  // lp-book and lp-concentration, Ethereum v4: every ModifyLiquidity since the PoolManager went live, summed per
  // position. The events read so far are cached with the block they reach, so a pass reads only new
  // blocks (and a new pool's whole history). A group that stays unread leaves its pools null.
  const V4_FROM = 21_600_000, bookFile = 'out/cache/v4book.json';
  let bc = { v: 1, to: null, ids: [], ev: [] };
  try { const j = JSON.parse(fs.readFileSync(bookFile, 'utf8')); if (j?.v === 1 && Array.isArray(j.ev)) bc = j; } catch { /* start over */ }
  const v4m = ETHX.mapped.filter((p) => p.v === 4).map((p) => p.id), known = new Set(bc.to != null && bc.to <= ETHX.block ? bc.ids : []);
  const bookEv = new Map(), bookUnread = new Set();
  for (const e of bc.to != null && bc.to <= ETHX.block ? bc.ev : []) { if (!bookEv.has(e[0])) bookEv.set(e[0], []); bookEv.get(e[0]).push({ sender: e[1], tickLower: e[2], tickUpper: e[3], liquidityDelta: BigInt(e[4]), salt: e[5] }); }
  // Off unless LP_BOOK=1: a live run (1 Nov 2026) spent 9 minutes and confirmed nothing, because the
  // empty chunks of this history need a second node to confirm them and only one node serves it.
  const bookOn = process.env.LP_BOOK === '1';
  if (bookOn) await timed('lp book', async () => {
    const plans = [[v4m.filter((id) => known.has(id)), (bc.to ?? V4_FROM - 1) + 1], [v4m.filter((id) => !known.has(id)), V4_FROM]];
    for (const [ids, fromB] of plans) for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      if (fromB > ETHX.block) continue;
      const got = await logsAdaptive(ETHX.logRpc, { address: CHAINS.ethereum.c.v4PoolManager, topics: [TOPICS.modifyLiquidity, part] }, fromB, ETHX.block, { step: 9000, maxStep: 9000, minStep: 250, segments: 4, retries: 2, confirmEmpty: true });
      if (!got) { part.forEach((id) => bookUnread.add(id)); continue; }
      for (const m of got.map(decodeModifyLiquidity).filter(Boolean)) { if (!bookEv.has(m.id)) bookEv.set(m.id, []); bookEv.get(m.id).push(m); }
    }
  });
  if (bookOn) try {
    const keep = v4m.filter((id) => !bookUnread.has(id));
    fs.mkdirSync('out/cache', { recursive: true });
    fs.writeFileSync(bookFile, JSON.stringify({ v: 1, to: ETHX.block, ids: keep, ev: keep.flatMap((id) => (bookEv.get(id) || []).map((m) => [id, m.sender, m.tickLower, m.tickUpper, String(m.liquidityDelta), m.salt])) }));
  } catch { /* read again next pass */ }
  const bookOf = new Map(ETHX.mapped.filter((p) => bookOn && p.v === 4).map((p) => [p.id, bookUnread.has(p.id) ? null : lpBook(bookEv.get(p.id) || [], { tick: p.s.tick, activeL: p.L })]));
  // sell-test, v3-style pools: sell about $100 of the non-quote token through the pool's venue router in a
  // simulated call (lib/selltest.mjs). Each token's balance slot is probed once and kept in a cache (keys
  // carry the chain for any chain but Ethereum); a token without one is unread.
  const slotFile = 'out/cache/balance-slots.json';
  let slots = {};
  try { slots = JSON.parse(fs.readFileSync(slotFile, 'utf8')) || {}; } catch { /* probe again */ }
  const sellOf = new Map();
  for (const X of ctxs) {
    // another chain within its sell-test cap: a pool the cap does not reach is unread (null), never a pass
    const sellCap = X.CH.id === 'ethereum' ? UNLIMITED : X.cap('sell');
    const sellRpc = capRpc(makeRpc(X.CH.rpcs, { timeout: 20000, maxRefusals: 1000 }), sellCap); // its own endpoints: override refusals mustn't drop nodes elsewhere
    await timed(X.CH.prefix + 'sell test', () => mapLimit(X.mapped.filter((p) => p.v === 3), 4, async (p) => {
      if (sellCap.over()) { sellOf.set(p.id, null); return; }
      const inIs = X.quoteAddrs.has(p.t0) && !X.quoteAddrs.has(p.t1) ? 1 : 0, tokenIn = inIs ? p.t1 : p.t0, tokenOut = inIs ? p.t0 : p.t1;
      const ti = X.tok.get(tokenIn), router = SELL_ROUTERS[X.CH.id]?.[p.dex];
      const sk = X.CH.id === 'ethereum' ? tokenIn : `${X.CH.id}:${tokenIn}`;
      if (!(ti?.usd > 0) || ti.decimals == null || !router) { sellOf.set(p.id, null); return; }
      try {
        if (slots[sk] == null) { const k = await findBalanceKey(sellRpc, tokenIn); if (k) slots[sk] = k; }
        const amountIn = BigInt(Math.floor((100 / ti.usd) * 10 ** Math.min(ti.decimals, 15))) * 10n ** BigInt(Math.max(0, ti.decimals - 15));
        sellOf.set(p.id, (await sellTest(sellRpc, { tokenIn, tokenOut, fee: p.fee, amountIn, key: slots[sk] ?? null, router })).ok);
      } catch { sellOf.set(p.id, null); }
    }));
  }
  try { fs.mkdirSync('out/cache', { recursive: true }); fs.writeFileSync(slotFile, JSON.stringify(slots)); } catch { /* probe again next pass */ }

  // Flow quality inputs read once per pass: each pool's transactions (tx.to for the routing share from a stable
  // sample; tx.from for every transaction of a young pool, for the newPools lane's distinct senders), through a
  // cache the loop's later passes reuse (a transaction never changes), within a per-pass budget.
  const txFile = 'out/cache/txs.json';
  let txc = {};
  try { const j = JSON.parse(fs.readFileSync(txFile, 'utf8')); if (j?.v === 1 && j.tx) txc = j.tx; } catch { /* read again */ }
  const txMap = new Map(Object.entries(txc).map(([h, v]) => [h, { to: v[0], from: v[1], t: v[2] }]));
  let txRead = 0, txAsked = 0;
  for (const X of ctxs) await timed(X.CH.prefix + 'transactions', async () => {
    {
      const want = new Set();
      for (const p of X.mapped) {
        if (X.unreadIds.has(p.id)) continue;
        const sw = X.byPoolEarly.get(p.id) || [];
        for (const h of txSample(sw)) want.add(h);
        if (isNum(p.createdAt) && X.passT - p.createdAt * 1000 < NEW_POOL_MS) for (const h of [...new Set(sw.map((s) => String(s.tx).toLowerCase()))].slice(0, YOUNG_TXS)) want.add(h);
      }
      // each chain within its transactions cap (lib/chains.mjs caps.txs: time, calls and how many); the rest wait
      // for a later pass (read transactions are cached)
      const tc = X.CH.caps?.txs, txCap = X.cap('txs');
      const ask = [...want].filter((h) => !txMap.has(h)).slice(0, Math.max(0, Math.min(TX_BUDGET - txAsked, tc?.max ?? Infinity)));
      txAsked += ask.length;
      const parts = [];
      for (let i = 0; i < ask.length; i += 250) parts.push(ask.slice(i, i + 250));
      const txRpc = capRpc(X.rpc, txCap);
      const got = await mapLimit(parts, 3, (part) => (txCap.over() ? part.map(() => null) : txRpc.batch(part.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })))));
      parts.forEach((part, i) => part.forEach((h, j) => {
        const t = got[i]?.[j];
        if (t && typeof t.to === 'string' && typeof t.from === 'string') { txMap.set(h, { to: t.to.toLowerCase(), from: t.from.toLowerCase(), t: passT }); txRead++; }
      }));
    }
  });
  try {
    const keepTx = Object.fromEntries([...txMap].filter(([, v]) => passT - v.t < 30 * 3600e3).map(([h, v]) => [h, [v.to, v.from, v.t]]));
    fs.mkdirSync('out/cache', { recursive: true }); fs.writeFileSync(txFile, JSON.stringify({ v: 1, tx: keepTx }));
  } catch { /* read again next pass */ }

  // The exchange-led screen (lib/cex.mjs): each pool's base token's centralised-exchange volume from CoinGecko
  // tickers, within the Demo key's budget; the last live.json carries the values and the day's call count, so a
  // new loop job starts where the last one stopped.
  const coinOfPool = (p) => {
    const tk = p.X.tok, a = tk.get(p.t0), b = tk.get(p.t1);
    const pickT = !a?.quote ? a : !b?.quote ? b : [a, b].find((t) => t && !/^(usd-coin|tether|dai)$/.test(t.cg || '')) ?? null;
    return pickT?.cg ?? null;
  };
  const seed = (prev?.pools || []).filter((x) => x.cex && isNum(x.cex.cexVol24) && isNum(x.cex.t) && x.cex.coin).map((x) => ({ coin: x.cex.coin, t: x.cex.t, vol: x.cex.cexVol24, src: x.cex.src ?? null, venues: x.cex.venues ?? null }));
  const cexCache = makeCexCache('out/cache/cex.json', { now: passT, seed, budget: prev?.health?.cex ?? null });
  // the candidates, biggest pools first: only the top CEX_BUDGET.topN coins are screened
  const cexCoins = [...new Set([...mapped].sort((a, b) => (b.tvl ?? b.mapUsd ?? 0) - (a.tvl ?? a.mapUsd ?? 0)).map(coinOfPool).filter(Boolean))];
  // while CoinGecko can't answer, the exchanges' own APIs (lib/cex.mjs exchangeVolumes): each coin's ticker and price
  const cexMeta = new Map();
  for (const X of ctxs) for (const t of X.tok.values()) if (t?.cg && !cexMeta.has(t.cg)) cexMeta.set(t.cg, { symbol: t.symbol ?? null, usd: isNum(t.usd) ? t.usd : null });
  const cx = await timed('exchanges', () => cexVolumes(getJson, cexCoins, { key: process.env.COINGECKO_KEY || null, cache: cexCache, now: passT, apis, meta: cexMeta }));
  try { cexCache.save(); } catch { /* the live.json copy carries it */ }

  // every window per pool
  const firstAt = new Map((prev?.pools || []).map((x) => [x.id, x.gemFirstAt ?? null]));
  const prevPool = new Map((prev?.pools || []).map((x) => [x.id, x]));
  const windows = config.windows, defaultWindow = windows.includes('24h') ? '24h' : windows[0]; // Gem now reads the last day
  const out = [], sendersOfPool = new Map();
  for (const p of mapped) {
    const X = p.X, tok = X.tok, symOf = X.symOf;
    const t0 = tok.get(p.t0) || {}, t1 = tok.get(p.t1) || {};
    let feeTier = null, keeps = null;
    if (p.v === 3) {
      feeTier = p.fee / 1e6; keeps = v3LpKeeps(p.s.feeProtocol, p.dex);
    } else if (isNum(p.s.lpFee) && isNum(p.s.protocolFee)) {
      const lp = p.s.lpFee / 1e6, pf = [(p.s.protocolFee & 0xfff) / 1e6, (p.s.protocolFee >> 12) / 1e6];
      const tiers = pf.map((x) => x + lp - x * lp), lpRate = pf.map((x) => lp * (1 - x));
      feeTier = (tiers[0] + tiers[1]) / 2; keeps = feeTier > 0 ? lpRate.map((r) => r / feeTier) : null;
    }
    const pxNow = poolPrice(B(p.s.sqrtPriceX96), t0.decimals, t1.decimals);
    const ratio = priceRatio({ poolPrice: pxNow, quoteIs: X.quoteAddrs.has(p.t1) ? 1 : 0, usd0: t0.usd, usd1: t1.usd });
    const offMarket = ratio == null ? null : Math.abs(ratio - 1) > config.priceSanity;
    const r = X.sums.get(p.id);
    const warnings = gemWarnings({ v: p.v, hooks: p.hooks, swaps24h: r ? r.swaps : X.unreadIds.has(p.id) ? null : 0, offMarket });
    const seg = X.segOf.get(p.id);
    // the pool's checklist: a check that did not run is null, never a pass
    const sides = X.fgSides.filter((x) => x.p === p && x.neu != null);
    const inside = (x, lo, hi) => (x == null || !Number.isFinite(x) ? null : x >= lo && x <= hi);
    const fullRecord = X.CH.id === 'ethereum' && p.v === 3 && p.dex === 'uniswap' && X.list.v3EventsComplete === true;
    const checks = [
      { id: 'maps-complete', label: 'map complete', ok: true },
      { id: 'map-vs-balances', label: 'map within the pool balances', ok: p.v === 3 && p.tvl > 0 && p.mapUsd != null ? p.mapUsd / p.tvl <= 1.02 : null },
      { id: 'price-vs-market', label: 'price vs market', ok: inside(ratio, 0.98, 1.02) },
      { id: 'fee-identity', label: 'swaps reproduce the fee counters', ok: sides.length ? sides.every((x) => in2(x.neu)) : null },
      { id: 'verified', label: 'no hook settles swaps outside the pool', ok: p.verified ?? null },
      { id: 'volume-vs-aggregator', label: 'volume vs aggregator', ok: p.aggVolumeUsd24h > 0 && p.vol24h != null ? inside(p.vol24h / p.aggVolumeUsd24h, 0.75, 1.25) : null },
      { id: 'volatility-xcheck', label: 'pool vs market volatility', ok: p.sigmaChain > 0 && p.sigmaMarket > 0 ? inside(p.sigmaChain / p.sigmaMarket, 0.7, 1.3) : null },
      { id: 'swaps-read', label: 'a day of swaps read', ok: X.unreadIds.has(p.id) ? null : true },
      { id: 'markouts-read', label: 'markouts read', ok: p.markout != null ? true : null },
      { id: 'creation-events', label: 'creation event found', ok: creationCheck({ createdAt: p.createdAt, complete: fullRecord }) },
      { id: 'fees-vs-aggregator', label: 'fees vs aggregator', ok: feesVsAggregator({ feesUsd: p.fees24h != null && p.proto24h != null ? p.fees24h + p.proto24h : null, aggVolumeUsd: p.aggVolumeUsd24h, feeTier: p.v === 4 && p.fee === DYNAMIC_FEE ? null : feeTier }).ok },
      { id: 'contract-verified', label: 'both tokens\' source verified', ok: bothVerified(p) },
      ...(p.v === 3 ? [{ id: 'sell-test', label: 'a small sell goes through (≥ 95% of the quote)', ok: sellOf.get(p.id) ?? null }] : []),
      // the LP book is read for Ethereum v4 pools only so far (v3 needs the position manager's history): v3 lists neither
      ...(p.v === 4 && bookOn && X.CH.id === 'ethereum' ? [
        { id: 'lp-book', label: 'LP book adds up', ok: bookOf.get(p.id)?.ok ?? null },
        { id: 'lp-concentration', label: 'no LP over 60% at the price', ok: bookOf.get(p.id)?.concentrated == null ? null : !bookOf.get(p.id).concentrated },
      ] : []),
      { id: 'token-age-rank', label: `tokens ranked and trading ${config.minPairAgeDays}+ days`, ok: tokenAgeRank([tok.get(p.t0), tok.get(p.t1)].map((t) => t && { quote: !!t.quote, rank: t.rank ?? null, firstPoolAt: t.firstPoolAt ?? null }), { now: X.passT / 1000, minDays: config.minPairAgeDays }) },
    ];
    // flow quality per window (lib/flowq.mjs): the day's swaps for 24 h; the hourly snapshot rows for drift;
    // the daily record carried in live.json for the longer windows
    // the raw tiers only (lib/feehist.mjs windowSeries): the fee history's deep record and estimates never reach the
    // windows, the gem or a score
    const series = windowSeries(snaps2.get(p.id));
    const rate = feeTier && keeps ? feeTier * (keeps[0] + keeps[1]) / 2 : null;
    const hrows = series ? historyRows(series, { d0: t0.decimals, d1: t1.decimals, usd0: t0.usd, usd1: t1.usd, rate }).h : [];
    const curRow = [p.row.t, rnd(pxNow, 8), null, null, null];
    if (hrows.length && p.row.t > hrows.at(-1)[0]) {
      // the current state as the last hour's end: its fees since the last stored row
      const last = series.h.at(-1), f = (() => { const x = historyRows({ h: [last, p.row], d: [] }, { d0: t0.decimals, d1: t1.decimals, usd0: t0.usd, usd1: t1.usd, rate }).h[1]; return x?.[3] ?? null; })();
      curRow[3] = f; hrows.push(curRow);
    }
    const sw = X.unreadIds.has(p.id) ? null : X.byPoolEarly.get(p.id) || [];
    const routed = sw ? routingShare(sw, txMap, (to) => routerName(X.CH.id, to) != null) : null;
    const senders = sw ? sendersOf(sw, txMap) : null;
    sendersOfPool.set(p.id, senders);
    const pp = prevPool.get(p.id), dailyRows = nextFlowDaily(pp?.flowDaily, { now: X.passT, retailShare: p.retail?.share ?? null, lpFeesUsd: p.fees24h ?? null, routing: routed?.share ?? null });
    const flowq = {};
    for (const wk of windows) {
      const ms = /^(\d+)([hd])$/.exec(wk), W = ms ? Number(ms[1]) * (ms[2] === 'h' ? 3600e3 : 86400e3) : null;
      if (!W) continue;
      const dc = driftCorr(hrows, { from: X.passT - W, to: X.passT + 1 });
      if (W <= 86400e3) flowq[wk] = { retailShare: p.retail?.share ?? null, driftCorr: dc?.rho ?? null, routing: routed?.share ?? null, senders };
      else { const d = dailyFlow(dailyRows, { from: X.passT - W, to: X.passT + 1 }); flowq[wk] = { retailShare: d.retailShare, driftCorr: dc?.rho ?? null, routing: d.routing, senders: null }; }
    }
    // the exchange-led screen
    const coin = coinOfPool(p), cv = coin ? cx.vol.get(coin) : null;
    const cex = { ...cexScreen({ cexVol24: cv?.usd ?? null, in9Usd: p.in9Usd ?? null, feeTier, sigmaDay: p.sigma ?? null, blocksPerDay: X.DAY_BLOCKS, t: cv?.t ?? null }), coin: cv ? coin : null, src: cv?.src ?? null, venues: cv?.venues ?? null };
    const cur = { ...p.row, aboveShare: p.aboveShare ?? null, segments: seg || undefined };
    const winsWith = (cks) => allWindows({
      series, cur, chain: p.chain, config,
      pool: { feeTier, lpKeeps: keeps, d0: t0.decimals, d1: t1.decimals, usd0: t0.usd ?? null, usd1: t1.usd ?? null, tvlUsd: p.tvl ?? p.mapUsd ?? null,
        gasUsd: X.gasUsd, walls: p.walls ?? null, inactiveShare: p.sticky ?? null, warnings, checkList: cks, flowq, cex,
        flow: (() => {
          if (X.unreadIds.has(p.id)) return {};
          const gemFlow = { markoutToFee: p.markout ?? null, traders7d: r ? 7 * r.txs : 0 }; // the latest day's replay, for the gem of longer windows
          // the day's largest tx's share of its LP fees (a burst one trader paid is a one-off)
          let tot = 0, topv = 0, unpriced = false;
          const byTx = new Map();
          for (const s of X.byPoolEarly.get(p.id) || []) {
            const f = swapFees(s, X.meta.get(p.id)), u = f ? usdOfPair(s.in === 0 ? [f.lp, 0n] : [0n, f.lp], t0.decimals, t1.decimals, t0.usd, t1.usd) : null;
            if (u == null) { unpriced = true; continue; }
            byTx.set(s.tx, (byTx.get(s.tx) || 0) + u); tot += u;
          }
          for (const v of byTx.values()) topv = Math.max(topv, v);
          const topTxShare = !unpriced && tot > 0 ? topv / tot : null;
          return { '24h': { swaps: r ? r.swaps : 0, traders: r ? r.txs : 0, markout: p.markout ?? null, topTxShare }, '7d': { gemFlow }, '30d': { gemFlow } };
        })() },
    });
    // the 24 h window's LP fees (from the fee counters) against the exact swap replay of the same day: within 10%
    const w24 = winsWith([...checks, { id: 'window-vs-replay', ok: null }])['24h'];
    const wr = w24?.lpFeesUsd != null && p.fees24h > 0 ? w24.lpFeesUsd / p.fees24h : null;
    checks.push({ id: 'window-vs-replay', label: '24 h fees from the counters vs the swap replay', ok: wr == null ? null : Math.abs(wr - 1) <= 0.1 });
    p.windowVsReplay = wr;
    const w = winsWith(checks);
    // the chart's bins: ±45% as before (the walls above come from those alone), coarser out to about ±64% log, then beyond
    const prof = seg ? depthProfile(seg, p.sqrt, p.d1, p.s.tick) : null;
    const gem = w[defaultWindow]?.gem?.total ?? null;
    const keptSeries = snapsKeep.get(p.id);
    out.push({
      id: p.id, chain: p.chain, dex: p.dex, v: p.v, pair: `${symOf(p.t0)}/${symOf(p.t1)}`,
      t0: { sym: symOf(p.t0), addr: p.t0, dec: t0.decimals ?? null, usd: t0.usd ?? null }, t1: { sym: symOf(p.t1), addr: p.t1, dec: t1.decimals ?? null, usd: t1.usd ?? null },
      feeTier, dynamicFee: p.v === 4 && p.fee === DYNAMIC_FEE, lpKeeps: keeps ? (keeps[0] + keeps[1]) / 2 : null,
      hooks: p.v === 4 ? p.hooks ?? null : null, verified: p.verified ?? null,
      firstSeen: Math.min(X.passT, pp?.firstSeen ?? X.passT, keptSeries?.d[0]?.t ?? X.passT, keptSeries?.h[0]?.t ?? X.passT),
      createdAt: isNum(p.createdAt) ? p.createdAt * 1000 : null, pairAgeDays: isNum(p.createdAt) ? rnd((X.passT / 1000 - p.createdAt) / 86400, 2) : null, young: isNum(p.createdAt) ? X.passT / 1000 - p.createdAt < 30 * 86400 : null,
      tvlUsd: p.tvl ?? null, mapUsd: p.mapUsd ?? null, aggUsd: p.aggReserveUsd ?? null,
      price: rnd(pxNow, 10), marketRatio: rnd(ratio), offMarket,
      shape: {
        tag: p.tag ?? null, parked: p.hollow ?? null, above: p.aboveShare ?? null, band9: p.band9 ?? null, lpsAtPrice: p.v === 4 ? bookOf.get(p.id)?.lpsAtPrice ?? null : null,
        ...depthFields(prof, p.per1),
        walls: { below: isNum(p.walls?.below) ? p.walls.below : null, above: isNum(p.walls?.above) ? p.walls.above : null },
      },
      cex: { cexVol24: rnd(cex.cexVol24, 5), cexRatio: rnd(cex.cexRatio, 4), tierVsSigma: rnd(cex.tierVsSigma, 4), t: cex.t, coin: cex.coin, src: cex.src, venues: cex.venues },
      w: Object.fromEntries(Object.entries(w).map(([k, x]) => [k, x && (({ daily: _d, ...rest }) => ({ ...rest, flow: Object.fromEntries(Object.entries(rest.flow).map(([fk, fv]) => [fk, fk === 'senders' ? fv : rnd(fv, 4)])) }))(x)])),
      daily: w[defaultWindow]?.daily ?? [], pattern: w[defaultWindow]?.pattern ?? null, burst: w[defaultWindow]?.burst ?? null,
      flowDaily: dailyRows,
      checks,
      gemFirstAt: firstAt.get(p.id) ?? (gem != null && gem >= config.gemAt ? X.passT : null),
    });
  }
  const gemOf = (x) => x.w[defaultWindow]?.gem?.total ?? -1;
  out.sort((a, b) => gemOf(b) - gemOf(a) || (b.tvlUsd ?? b.mapUsd ?? 0) - (a.tvlUsd ?? a.mapUsd ?? 0));

  // the shortlist the backtest reads (plain, local, never printed): the best gem scores among Ethereum's
  // Uniswap pools (the backtest replays Uniswap's events on Ethereum), plus the benchmark
  const short = out.filter((x) => gemOf(x) >= 0 && x.chain === 'ethereum' && x.dex === 'uniswap').slice(0, 20).map((x) => x.id);
  if (!short.includes(BENCH) && out.some((x) => x.id === BENCH)) short.push(BENCH);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/shortlist.json', JSON.stringify({ t: passT, ids: short }));
  const tallyCheck = (id) => { const c = out.map((x) => x.checks.find((k) => k.id === id)?.ok); return `${id} ${c.filter((v) => v === true).length} pass / ${c.filter((v) => v === false).length} fail / ${c.filter((v) => v == null).length} not run`; };
  say(true, 'pool checks', ['creation-events', 'fees-vs-aggregator', 'token-age-rank', 'contract-verified', 'lp-book', 'lp-concentration', 'sell-test', 'window-vs-replay'].map(tallyCheck).join('; '));
  const wvr = mapped.map((p) => p.windowVsReplay).filter((x) => x != null), bm = ETHX.mapped.find((p) => p.id === BENCH);
  say(wvr.length ? wvr.filter((x) => Math.abs(x - 1) <= 0.1).length / wvr.length >= 0.8 : null, 'window vs replay',
    `24 h LP fees from the fee counters within 10% of the swap replay for ${wvr.filter((x) => Math.abs(x - 1) <= 0.1).length} of ${wvr.length} pools; median ratio ${median(wvr)?.toFixed(3) ?? '—'}`);
  // the benchmark (UNI/WETH 0.3%, public market data): 24 h LP fees ÷ (aggregator volume × 0.3% × LP share)
  const b24 = out.find((x) => x.id === BENCH)?.w['24h'];
  const bRatio = b24?.lpFeesUsd != null && bm?.aggVolumeUsd24h > 0 ? b24.lpFeesUsd / (bm.aggVolumeUsd24h * 0.003 * (out.find((x) => x.id === BENCH).lpKeeps ?? 1)) : null;
  pub(`benchmark UNI/WETH 0.3%: 24 h LP fees ÷ (aggregator 24 h volume × 0.3% × LP share) = ${bRatio == null ? 'unread' : bRatio.toFixed(3)}`);
  const nWin = (wk) => out.filter((x) => x.w[wk] != null).length;
  say(true, 'windows', `${out.length} pools: ${windows.map((wk) => `${wk} ${nWin(wk)}`).join(', ')} with a window (under a day of snapshots is blank); ${out.filter((x) => gemOf(x) >= 0).length} with a gem score; shortlist ${short.length}; backfill: ${bf.wanted} pool moments missing, ${bf.planned} planned in ${bf.jobs} batches (${bf.retried} read again at a corrected block; ${bf.skipped} left by the time budget), ${bf.rows} rows read, ${bf.unbornMoments} before a pool existed (no row); block-time probes ${bf.probesRead} of ${bf.probesTried}; batches answered with today's state, dropped: ${bf.stale} of ${bf.batches}, unread ${bf.unread}; rows kept for ${[...keepChains].filter((c) => ctxs.some((X) => X.CH.id === c)).join(', ')}`);
  // flow quality, the exchange screen and the discovery lanes (docs/DATA.md): counts only in the public log
  const dw = (x) => x.w[defaultWindow];
  const fq = (k) => out.filter((x) => dw(x)?.flow?.[k] != null).length;
  const discovery = {
    // distinct senders from the day's swaps themselves: a pool under a day old has no 24 h window yet
    newPools: out.filter((x) => isNum(x.createdAt) && x.createdAt > passT - NEW_POOL_MS && sendersOfPool.get(x.id) >= NEW_POOL_SENDERS).sort((a, b) => (b.w['24h']?.volUsd ?? 0) - (a.w['24h']?.volUsd ?? 0)).map((x) => x.id),
    cexLed: out.filter((x) => lensCexLed(x.cex)?.on).sort((a, b) => b.cex.cexRatio - a.cex.cexRatio).map((x) => x.id),
    crossChain: [], // cross-chain gaps are not built yet
    retailUp: out.filter((x) => dw(x)?.lenses?.includes('retail')).sort((a, b) => (dw(b)?.flow?.retailShare ?? 0) - (dw(a)?.flow?.retailShare ?? 0)).map((x) => x.id),
  };
  const byVenue = (c) => top(tally(out.filter((x) => x.chain === c).map((x) => `${x.dex} v${x.v}`)), 4);
  const chainCounts = ctxs.map((X) => `${X.CH.id} ${out.filter((x) => x.chain === X.CH.id).length} (${byVenue(X.CH.id)})${X.CH.caps?.top ? `, scope the largest ${X.CH.caps.top} by TVL (${X.beyondTop} smaller left out)` : ''}`).join('; ');
  say(true, 'flow quality', `${defaultWindow}: retail share ${fq('retailShare')} of ${out.length} pools, drift correlation ${fq('driftCorr')}, routing ${fq('routing')}; transactions read ${txRead} of ${txAsked} asked (${txMap.size} known)`);
  say(cx.fetched > 0 || cx.fresh + cx.stale > 0 ? true : null, 'exchange screen', `exchange volume for ${out.filter((x) => x.cex.cexVol24 != null).length} of ${out.length} pools (${cx.fresh} coins fresh, ${cx.stale} up to 48 h old, ${cx.unread} unread; ${cx.calls} calls this pass, ${cexCache.calls()} today of ${CEX_BUDGET.perDay}${cx.lastError ? `, last error ${cx.lastError}` : ''}); ratio for ${out.filter((x) => x.cex.cexRatio != null).length}, tier vs σ for ${out.filter((x) => x.cex.tierVsSigma != null).length}`);
  pub(`chains: ${chainCounts}`);
  // the read caps (lib/chains.mjs): each capped part's seconds and calls, and which cap stopped it (names and counts only)
  const capLine = ctxs.map((X) => `${X.CH.id} ${[...X.caps].map(([k, b]) => `${k} ${b.note()}`).join(', ') || 'none'}`).join('; ');
  const capsHit = ctxs.flatMap((X) => [...X.caps].filter(([, b]) => b.why()).map(([k]) => X.CH.prefix + k));
  say(capsHit.length ? null : true, 'read caps', `${capLine}${capsHit.length ? `; stopped by a cap (the rest unread this pass): ${capsHit.join(', ')}` : ''}`);
  pub(`caps: ${capLine}${capsHit.length ? ` · stopped by a cap: ${capsHit.join(', ')}` : ''}`);
  { // the exchange screen's sources, counts only (public market data)
    const f = cx.fallback, srcN = (k) => out.filter((x) => x.cex.cexVol24 != null && x.cex.src === k).length;
    pub(`exchange screen: CoinGecko tickers ${cx.calls} calls this pass${cx.lastError ? ` (${cx.lastError})` : ''}; exchange fallback ${!f ? 'not needed' : !f.asked ? 'all values fresh' :
      `${f.got} of ${f.asked} coins read (${f.unlisted} listed nowhere, ${f.mismatched} price mismatch, ${f.ambiguous} ambiguous ticker, ${f.unpriced} unpriced); venues ${Object.entries(f.venues).map(([k, v]) => `${k} ${v == null ? 'unread' : `${v} markets`}`).join(', ')}; ${f.note}${f.lastError ? `, last error ${f.lastError}` : ''}`}; pools with exchange volume: CoinGecko ${srcN('coingecko')}, exchanges ${srcN('exchanges')}`);
  }
  pub(`flow quality (${defaultWindow}): retail share ${fq('retailShare')}, drift ${fq('driftCorr')}, routing ${fq('routing')} of ${out.length} pools; exchange ratio ${out.filter((x) => x.cex.cexRatio != null).length}; lanes: new ${discovery.newPools.length}, exchange-led ${discovery.cexLed.length}, retail ${discovery.retailUp.length}`);
  // Exact fees (lib/exactfees.mjs, docs/DATA.md history.json y 's'): each pool's settled UTC days summed from its own
  // swaps, read once and kept in snapshots.json sx; newest days first, the pools in the dashboard's order (gem first),
  // within each chain's caps.exact (READ_CAPS {"<chain>": {"exact": {...}}} lowers them), the chains side by side.
  // Then every pool's year of fee rows (lib/feehist.mjs feeYear: swaps over counters over estimates) and the public
  // line: counts, one ratio and seconds only.
  const mById = new Map(mapped.map((p) => [p.id, p]));
  // a part that breaks is "broke" in the line and changes nothing else in the pass
  const exRuns = snapsOk ? await Promise.all(ctxs.map((X) => timed(X.CH.prefix + 'exact fees', async () => {
    try {
      const budget = makeBudget({ ...(X.CH.caps?.exact || {}), ...(CAP_OVERRIDE[X.CH.id]?.exact || {}) });
      const pools = out.filter((x) => x.chain === X.CH.id).map((x) => mById.get(x.id)).map((p) => ({ id: p.id, v: p.v, dex: p.dex, fee: p.fee, createdAt: isNum(p.createdAt) ? p.createdAt * 1000 : null }));
      // a chain whose own 24 h swap read came back unread this pass waits: its log nodes are struggling
      const r = await exactFeesChain({ chain: X.CH.id, pools, cache: sxCache, now: X.passT, io: chainIo(X.CH, { budget, head: X.block }), budget, hold: X.unreadIds.size ? 'swaps unread' : null });
      return { ...r, ms: budget.elapsed(), calls: budget.used() };
    } catch (e) { console.error(e); return { chain: X.CH.id, broke: errWord(e), changed: false }; }
  }))) : [];
  const exChanged = exRuns.some((r) => r.changed);
  const fyOf = new Map();
  for (const p of mapped) {
    const s2 = snaps2.get(p.id), t0 = p.X.tok.get(p.t0) || {}, t1 = p.X.tok.get(p.t1) || {};
    if (!s2) continue;
    const x = out.find((o) => o.id === p.id), rate = x.feeTier && x.lpKeeps ? x.feeTier * x.lpKeeps : null;
    fyOf.set(p.id, feeYear({ series: s2, gt: gtCache.get(p.id) ?? null, sx: sxCache.p.get(p.id) ?? null, now: passT,
      pool: { d0: t0.decimals, d1: t1.decimals, rate, dyn: !!x.dynamicFee, usd0: t0.usd ?? null, usd1: t1.usd ?? null, pxNow: x.price ?? null, createdAt: x.createdAt } }));
  }
  if (exRuns.length) {
    const ef = exactLine(exRuns, { xs: [...fyOf.values()].flatMap((f) => f.xs), sDays: [...fyOf.values()].reduce((a, f) => a + f.yp.sw, 0) });
    say(ef.ok, 'exact fees', ef.line);
    pub(`exact fees: ${ef.line}`);
  }
  if (!store) { say(null, 'sealed outputs', 'no lock in this run: live.json, history.json and snapshots.json not written'); return; }

  // the top strip (lib/market.mjs): gas against its own recent range, ETH/BTC/SOL in USD. Its own time
  // limits; any failure is null and never fails the pass. The gas history rides along in live.json.
  let market = null;
  try {
    const mr = await timed('market', () => marketBlock({ rpc: makeRpc(CHAINS.ethereum.rpcs, { timeout: 8000, maxRefusals: 2 }), getJson, prev: prev?.market ?? null,
      now: passT, key: process.env.COINGECKO_KEY || null, gasPriceWei: ETHX.gp, timeoutMs: 15000, apis }));
    market = mr.market;
    const g = market.gas;
    say(g.gwei != null && mr.log.read === 3 ? true : null, 'market', `gas ${g.gwei ?? '—'} gwei (${mr.log.gas ?? 'unread'}), band ${g.band ?? '—'} vs ${g.basis ?? 'no'} range (p10 ${g.p10 ?? '—'}, p50 ${g.p50 ?? '—'}, p90 ${g.p90 ?? '—'}; ${g.hist.length} hourly samples over ${g.histDays} days); prices ${mr.log.read} of 3 read (${Object.values(market.px).map((x) => x.src ?? 'unread').join(', ')}); daily DefiLlama vs CoinGecko check${mr.log.xcheck ? ' (asked this pass)' : ''}: ${market.xcheck ? `${market.xcheck.agree} of ${market.xcheck.both} agree within 2% on ${market.xcheck.day}` : 'not yet'}`);
  } catch {
    try { market = carryMarket(prev?.market ?? null, passT); } catch { market = null; }
    say(null, 'market', 'the market block broke: every reading null this pass, the gas history carried');
  }
  // a health check across chains: failed on any, passed when every chain that ran it passed, else not run
  const chk = (id, label, a) => {
    const xs = ctxs.map((X) => ({ X, l: lines.find((l) => l.area === X.CH.prefix + a) })).filter((x) => x.l);
    const ok = xs.some((x) => x.l.ok === false) ? false : xs.length && xs.every((x) => x.l.ok === true) ? true : null;
    return { id, label, ok, value: null, detail: xs.map((x) => (x.X.CH.prefix ? `${x.X.CH.label}: ` : '') + x.l.msg).join(' · ') };
  };
  // the pair view: every pool of a pair side by side (native ETH counts as WETH); a pair on another chain is its own
  const pairsAll = {}, keyOfAll = new Map();
  for (const X of ctxs) {
    const { pairs, keyOf } = buildPairs(out.filter((x) => x.chain === X.CH.id), { weth: X.WETH, windows, defaultWindow });
    const pre = X.CH.id === 'ethereum' ? '' : `${X.CH.id}:`;
    for (const [k, v] of Object.entries(pairs)) pairsAll[pre + k] = v;
    for (const [id, k] of keyOf) keyOfAll.set(id, pre + k);
  }
  for (const x of out) x.pairKey = keyOfAll.get(x.id);
  apis.save();
  if (apis.outLine()) pub(apis.outLine());
  pub(`apis: ${apis.line()}`);
  const live = {
    v: 1, t: passT, phase: 0, build: `scan-${(process.env.GITHUB_SHA || 'local').slice(0, 7)}`, next: null,
    ticket: config.ticket, stopLoss: config.stopLoss, windows, defaultWindow, gemAt: config.gemAt,
    chains: ctxs.map((X) => ({ id: X.CH.id, pools: out.filter((x) => x.chain === X.CH.id).length, unread: X.unreadMaps + X.badMaps + X.unreadState, block: X.block, gasUsd: isNum(X.gasUsd) ? X.gasUsd : null,
      dexes: Object.fromEntries([...tally(out.filter((x) => x.chain === X.CH.id).map((x) => x.dex))]) })),
    health: {
      loop: prev?.health?.loop ?? null,
      checks: [chk('fee-identity', 'fee identity', 'fee identity'), chk('price-vs-market', 'price vs market', 'price check'), chk('volume-vs-aggregator', 'volume vs aggregator', 'volume check'),
        chk('maps-complete', 'maps complete', 'maps'), chk('lp-book', 'LP book', 'lp book'), chk('creation-events', 'creation events', 'creation events'),
        chk('volatility-xcheck', 'volatility cross-check', 'volatility check'), chk('fees-vs-aggregator', 'fees vs aggregator', 'fees vs aggregator')],
      sealedLog: logStats ? (({ lines: l, errors, categories }) => ({ lines: l, errors, categories }))(logStats()) : null,
      cex: { day: cexCache.today, calls: cexCache.calls(), perDay: CEX_BUDGET.perDay },
      apis: apis.health(),
    },
    stored: [...keepChains], // the chains whose rows the snapshot store keeps (Base only once the live loop runs this code)
    bench: BENCH, pools: out, pairs: pairsAll, market, discovery,
  };
  store.put('live.json', live);
  let histWritten = false;
  const fh = { pools: 0, exact: 0, est: 0, rows: 0, xc: [], xcPools: 0, aged: 0, full: 0, left: 0, spikes: 0, backed: 0, bySwaps: 0, uPools: 0 };
  if (snapsOk && (changed || exChanged || !fs.existsSync(`${store.outDir}/history.json`))) {
    // history.json's charts (lib/charts.mjs): 14 days hourly, 90 days daily, nothing before a pool existed
    // plus y, up to a year of daily LP fees (lib/feehist.mjs): exact from the fee counters, estimated from the day
    // volumes before that, exact overriding; and yp, the pool's progress (exact days of its age within the year)
    const hp = {};
    for (const p of mapped) {
      const s2 = snaps2.get(p.id), t0 = p.X.tok.get(p.t0) || {}, t1 = p.X.tok.get(p.t1) || {};
      if (!s2) continue;
      const x = out.find((o) => o.id === p.id), rate = x.feeTier && x.lpKeeps ? x.feeTier * x.lpKeeps : null;
      const fy = fyOf.get(p.id);
      const hr = historyRows(windowSeries(s2), { d0: t0.decimals, d1: t1.decimals, usd0: t0.usd, usd1: t1.usd, rate });
      // a day 20× its 30-day median or more stands only with the day's swaps or volume behind it; else it is listed
      // in u (unconfirmed), which the page marks (lib/spikes.mjs)
      const sp = feeSpikes({ d: hr.d, y: fy.y, gt: gtCache.get(p.id) ?? null, rate, su: fy.su });
      fh.spikes += sp.spikes; fh.backed += sp.backedN; fh.bySwaps += sp.bySwaps; if (sp.u) fh.uPools++;
      hp[p.id] = { ...hr, y: fy.y, yp: fy.yp, ...(sp.u ? { u: sp.u } : {}) };
      fh.pools++; fh.exact += fy.yp.exact; fh.est += fy.yp.est; fh.rows += fy.y.length; fh.xc.push(...fy.xc); if (fy.xc.length) fh.xcPools++;
      if (fy.yp.age != null) { fh.aged++; fh.left += fy.yp.age - fy.yp.exact; if (fy.yp.exact === fy.yp.age) fh.full++; }
    }
    let ph = null;
    try { ph = store.get('history.json'); } catch { ph = null; }
    const hour = Math.floor(passT / 3600e3) * 3600e3, health = (ph?.health || []).filter((x) => x[0] >= passT - 7 * 86400e3 && x[0] !== hour);
    const last = (ph?.health || []).find((x) => x[0] === hour);
    health.push([hour, (last?.[1] ?? 0) + (badMaps ? 0 : 1), (last?.[2] ?? 0) + 1, unreadMaps + badMaps]);
    store.put('history.json', { v: 1, t: passT, pools: hp, health });
    histWritten = true;
  }
  if (snapsOk && (changed || exChanged || !fs.existsSync(`${store.outDir}/snapshots.json`))) store.put('snapshots.json', { ...serializeStore(snapsKeep), t: passT, fix: SNAP_FIX, gt: packGt(gtCache, { now: passT }), sx: packSx(sxCache, { now: passT }) });
  // the fee history in the public log: counts, one ratio and seconds only (never a pool, an amount or an address)
  if (histWritten) {
    const xm = midOf(fh.xc), g = gt || {};
    const line = `${fh.pools} pools, days exact ${fh.exact}, estimated ${fh.est}, unread ${fh.rows - fh.exact - fh.est} of ${fh.rows}; ${fh.full} of ${fh.aged} pools of known age exact on every day (${fh.left} pool-days still estimated or unread); `
      + `estimated ÷ exact median ${xm == null ? '—' : xm.toFixed(3)} over ${fh.xc.length} days (${fh.xcPools} pools); `
      + `GeckoTerminal ${g.full ?? 0} pools fetched + ${g.fresh ?? 0} topped up, ${g.missed ?? 0} unknown, ${g.failed ?? 0} unread, ${g.calls ?? 0} calls${g.stopped ? ` (stopped: ${g.stopped})` : ''}, ${gtCache.size} cached (base token matched for ${[...gtCache.values()].filter((e) => e.b === 0 || e.b === 1).length}); `
      + `deep backfill ${bf.deepRows} rows from ${bf.deepJobs} batches planned of ${bf.deepWanted} pool-days wanted (${bf.deepUnborn} before a pool existed, ${bf.deepUnread} unread, ${bf.deepBroke} left after unread ones)`;
    say(xm == null || fh.xc.length < 20 ? null : Math.abs(xm - 1) <= 0.25, 'fee history', line + (g.lastError ? `; last GeckoTerminal error ${g.lastError}` : ''));
    pub(`fee history: ${line}; ${timing['fee history volumes'] ?? 0} s for the volumes`);
    const spl = `${fh.spikes} days at 20× their 30-day median or more (daily chart and exact fee history), ${fh.backed} backed by the day's swaps or volume (${fh.bySwaps} by its swaps), ${fh.spikes - fh.backed} marked unconfirmed in ${fh.uPools} pools`;
    say(true, 'fee spikes', spl);
    pub(`fee spikes: ${spl}`);
  }
  say(snapsOk ? true : false, 'sealed outputs', `live.json written with ${out.length} pools; history.json ${histWritten ? 'written' : 'kept (no new hourly row)'}; snapshots ${snapsOk ? (changed ? 'updated' : 'unchanged') : 'stored copy did not open: left as it was'}`);
}
