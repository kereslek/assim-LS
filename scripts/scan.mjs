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
import { ETHEREUM as C, ZERO, DYNAMIC_FEE, readV3Slot0, readV4Slot0, readUint, v4Slot0Call, poolPrice, extremeFee } from '../lib/pools.mjs';
import { readMaps, wordsFor, feeGrowthCalls, readFeeGrowth } from '../lib/maps.mjs';
import { sqrtX96ToSqrt, ticksForLog } from '../lib/v3math.mjs';
import { hollowness, shapeTag, bandStats, depthHistogram, nearestWalls } from '../lib/shape.mjs';
import { SWAP_TOPICS, EXTRA_TOPICS, decodeSwap, decodeExtra, hookReturnsSwapDelta, summarize, usdOfPair, swapFees } from '../lib/swaps.mjs';
import { dailySigma, ratioByDay, markouts } from '../lib/flow.mjs';
import { scorePool, recentMoves } from '../lib/score.mjs';
import { coinGeckoHistory, dailyHistory, makeHistoryCache, ratioAt } from '../lib/history.mjs';
import { MULTICALL3 } from '../lib/multicall.mjs';
import { verifiedSources, makeVerifiedCache } from '../lib/etherscan.mjs';
import { stickyShare, strandedShare } from '../lib/persistence.mjs';
import { persistenceScore, flowScore, gemScore } from '../lib/gem.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { feeIdentity, replayFeeGrowth, feeIdentityPath, pathIndex, priceRatio, creationCheck, feesVsAggregator, tokenAgeRank } from '../lib/checks.mjs';
import { installSealedLogs } from '../lib/quietlogs.mjs';
import { openLock } from '../lib/lock.mjs';
import { DEFAULTS as CONFIG_DEFAULTS, loadConfig } from '../lib/config.mjs';
import { openStore } from '../lib/store.mjs';
import { parseStore, serializeStore, mergeStore, pastBlockAnswer } from '../lib/snapshots.mjs';
import { allWindows, deltaFg, gemWarnings, isHooked } from '../lib/windows.mjs';

const FLOOR = 300_000, V4_PREFILTER = 100_000, MAX_WORDS = 600_000, DAY_BLOCKS = 7200, GROUP = 40;
const EXAMPLE_TICKET = 1000, HOLD_DAYS = 14, RERANGE_GAS = 630_000, MARKOUT_BLOCKS = 25; // a made-up example size, not anyone's position
const BENCH = '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801';
// Parked liquidity starts beyond max(the suggested ±r, 2%) from the price: closer than that it is serving.
const NEAR_MIN = 0.02;
// Snapshots written before the backfill checked each batch's block time are rebuilt once.
const SNAP_FIX = 2;
const nearOf = (p) => Math.max(NEAR_MIN, p.score?.r ?? 0);
const V3_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net', 'https://eth.blockscout.com/api/eth-rpc'];

const lines = [], timing = {};
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
async function timed(name, fn) { const t = Date.now(); try { return await fn(); } finally { timing[name] = Math.round((Date.now() - t) / 1000); } }
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
const list = JSON.parse(fs.readFileSync('out/pools-ethereum.json', 'utf8'));
const tok = new Map(list.tokens.map((t) => [t.address, t]));
const B = (x) => (x == null ? null : BigInt(x));
const rpc = makeRpc(RPCS, { timeout: 30000, maxRefusals: 4 });
const mc = makeMulticall(rpc, { chunk: 400, concurrency: 4 });
const ARCHIVE = ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth.blockscout.com/api/eth-rpc']; // serve old state (probes)
const amc = makeMulticall(makeRpc(ARCHIVE, { timeout: 30000, maxRefusals: 6 }), { chunk: 300, concurrency: 3 });

// 1. Which pools: every v3 pool ≥ $300k by its own balances; v4 pools an aggregator lists at
//    ≥ $100k, and new v4 pools that hold liquidity (v4 has no per-pool balances: its value comes
//    from the map). Liquidity only away from the price still counts: that is the one-sided kind.
const pick = [
  ...list.v3.filter((p) => p.tvl >= FLOOR || p.id === BENCH).map((p) => ({ ...p, v: 3, tickSpacing: V3_SPACING[p.fee] })),
  ...list.v4.filter((p) => !extremeFee(p.fee) && (p.aggReserveUsd >= V4_PREFILTER || p.source === 'event')).map((p) => ({ ...p, v: 4 })),
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
const passT = Date.now(); // the pass time: the state below is read at this block
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
  const h = hollowness(m.segments, sp, d1, p.s.tick, m.checks.walkedLiquidity, { near: NEAR_MIN });
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
// Price check (step 5): a liquid pool's price against the market's (CoinGecko for the token, DefiLlama for quotes).
const liquid = mapped.filter((p) => p.mapUsd >= 1e6);
const quoteAddrs = new Set(list.tokens.filter((t) => t.quote).map((t) => t.address));
const pr = liquid.map((p) => priceRatio({ poolPrice: poolPrice(B(p.s.sqrtPriceX96), tok.get(p.t0)?.decimals, tok.get(p.t1)?.decimals), quoteIs: quoteAddrs.has(p.t1) ? 1 : 0, usd0: tok.get(p.t0)?.usd, usd1: tok.get(p.t1)?.usd })).filter((x) => x != null);
say(pr.length ? within(pr, 0.98, 1.02) / pr.length >= 0.9 : null, 'price check', `pools ≥ $1M priced within 2% of the market: ${within(pr, 0.98, 1.02)} of ${pr.length}; within 5%: ${within(pr, 0.95, 1.05)}; median ratio ${median(pr)?.toFixed(4) ?? '—'}`);
const strandedPools = mapped.filter((p) => p.hollow >= 0.8);
say(true, 'shapes', `of ${mapped.length} mapped pools: ${[...tags].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}; median share of value within ±9% of the price ${fr(median(mapped.map((p) => p.band9)))}`);

// 3. The last 24 h of swaps for the mapped pools: v3 per pool address, v4 through the PoolManager by pool id.
const from = block - DAY_BLOCKS + 1;
const v3ids = mapped.filter((p) => p.v === 3).map((p) => p.id), v4ids = mapped.filter((p) => p.v === 4).map((p) => p.id);
const groups = [];
// Flash (v3) and Donate (v4) ride along: they move the fee counters without a swap (step 3b).
for (let i = 0; i < v3ids.length; i += GROUP) groups.push({ address: v3ids.slice(i, i + GROUP), topics: [[SWAP_TOPICS.v3, EXTRA_TOPICS.flash]] });
for (let i = 0; i < v4ids.length; i += GROUP) groups.push({ address: C.v4PoolManager, topics: [[SWAP_TOPICS.v4, EXTRA_TOPICS.donate], v4ids.slice(i, i + GROUP)] });
// Log reads skip rpc.flashbots.net (silently empty or short answers) and confirm any empty answer with a second node.
const logRpc = makeRpc(RPCS.filter((u) => !u.includes('flashbots')), { timeout: 30000, maxRefusals: 1000 });
const got = await timed('swaps', () => mapLimit(groups, 2, (f) => logsAdaptive(logRpc, f, from, block, { step: 1000, confirmEmpty: true, retries: 2 })));
const unreadGroups = got.filter((g) => g == null).length;
const unreadIds = new Set(groups.flatMap((g, i) => (got[i] == null ? (Array.isArray(g.address) ? g.address : g.topics[1]) : [])));
const seenLog = new Set();
let dupLogs = 0;
const logsRead = got.filter(Boolean).flat().filter((l) => { const k = `${l.transactionHash}:${parseInt(l.logIndex, 16)}`; if (seenLog.has(k)) { dupLogs++; return false; } seenLog.add(k); return true; });
const swaps = logsRead.map(decodeSwap).filter(Boolean), extras = logsRead.map(decodeExtra).filter(Boolean);
const byPoolEarly = new Map(), extrasByPool = new Map();
for (const s of swaps) { if (!byPoolEarly.has(s.pool)) byPoolEarly.set(s.pool, []); byPoolEarly.get(s.pool).push(s); }
for (const e of extras) { if (!extrasByPool.has(e.pool)) extrasByPool.set(e.pool, []); extrasByPool.get(e.pool).push(e); }
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
  p.proto24h = pr;
  if (p.fees24h == null) { unpricedPools++; continue; }
  lpUsd += p.fees24h; protoUsd += pr ?? 0; volUsd += p.vol24h ?? 0;
  if (p.aggVolumeUsd24h > 0 && p.vol24h != null) volRatio.push(p.vol24h / p.aggVolumeUsd24h);
}
say(unreadGroups ? null : true, 'swaps', `${swaps.length} swaps in the last ${DAY_BLOCKS} blocks across ${sums.size} of ${mapped.length} pools (plus ${extras.filter((e) => e.kind === 'flash').length} v3 flash loans and ${extras.filter((e) => e.kind === 'donate').length} v4 donations); ${unreadGroups} of ${groups.length} log groups unread; ${dupLogs} duplicate logs dropped`);
const protoOn = mapped.filter((p) => (p.v === 3 ? p.s.feeProtocol > 0 : p.s.protocolFee > 0));
say(true, 'fees', `LP fees ${usd(lpUsd)} and protocol fees ${usd(protoUsd)} on ${usd(volUsd)} of volume in 24 h; protocol fee on in ${protoOn.filter((p) => p.v === 3).length} of ${mapped.filter((p) => p.v === 3).length} v3 and ${protoOn.filter((p) => p.v === 4).length} of ${mapped.filter((p) => p.v === 4).length} v4 pools; ${unpricedPools} pools unpriced`);
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
const label = (p) => `${symOf(p.t0)}/${symOf(p.t1)} v${p.v} ${p.v === 4 && p.fee === DYNAMIC_FEE ? 'dynamic' : `${p.fee / 1e4}%`}`;
for (const p of mapped) p.verified = p.v === 3 ? true : p.hooks == null ? null : !hookReturnsSwapDelta(p.hooks);
// A v4 pool with a hook, or whose hook address was not read (it can't be shown to have none).
const hookedPool = isHooked;
const hookedOrDynamic = (p) => p.v === 4 && ((p.hooks && p.hooks !== ZERO) || p.fee === DYNAMIC_FEE);
const fgCalls = (p) => feeGrowthCalls(p, C.v4StateView);
const stCalls = (p) => (p.v === 3 ? [{ target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') }]
  : [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }]);
const fgPlan = mapped.filter((p) => !unreadIds.has(p.id) && sums.get(p.id)?.swaps >= 10);
const [fgNowR, fgThenR] = await timed('fee counters', () => Promise.all([amc(fgPlan.flatMap(fgCalls), tag), amc(fgPlan.flatMap((p) => [...fgCalls(p), ...stCalls(p)]), '0x' + (from - 1).toString(16))]));
const segOf = new Map(ready.map((p, i) => [p.id, maps[i]?.segments ?? null]));
let kn = 0, kt = 0, fgUnread = 0;
const fgSides = [];
for (const p of fgPlan) {
  const n = fgCalls(p).length, thenR = fgThenR.slice(kt, kt + n + 2);
  const a = readFeeGrowth(p, fgNowR.slice(kn, kn + n)), z = readFeeGrowth(p, thenR.slice(0, n));
  kn += n; kt += n + 2;
  const s0 = p.v === 3 ? readV3Slot0(thenR[n]) : readV4Slot0(thenR[n]), L0 = readUint(thenR[n + 1]);
  const evs = byPoolEarly.get(p.id) || [], m = meta.get(p.id);
  const rep = s0 && L0 != null ? replayFeeGrowth({ swaps: evs, extras: extrasByPool.get(p.id) || [], meta: m, start: { sqrtPriceX96: s0.sqrtPriceX96, liquidity: L0 }, path: pathIndex(segOf.get(p.id)) }) : null;
  const neu = feeIdentityPath(rep, z, a), old = feeIdentity(evs, m, z, a);
  if (!neu) { fgUnread++; continue; }
  const endGap = rep.end.sqrtPriceX96 !== B(p.s.sqrtPriceX96); // the last swap's price must be the end block's
  const feeMoved = p.v === 3 ? s0.feeProtocol !== p.s.feeProtocol : s0.protocolFee !== p.s.protocolFee;
  for (const side of [0, 1]) if (neu[side] != null || old?.[side] != null) fgSides.push({ p, side, old: old?.[side] ?? null, neu: neu[side], sd: rep.sides[side], endGap, feeMoved });
}
const in2 = (x) => x != null && x >= 0.98 && x <= 1.02;
const cause = (x) => (hookedOrDynamic(x.p) ? 'hooked/dynamic-fee' : x.sd.extras ? 'donations/flash' : x.endGap || x.sd.backwards ? 'missing events'
  : x.feeMoved ? 'fee setting changed' : x.sd.empty ? 'empty-stretch crossings' : x.sd.crossing ? 'crossing swaps' : 'other');
const oldSides = fgSides.filter((x) => x.old != null), oldMiss = oldSides.filter((x) => !in2(x.old));
say(true, 'fee identity before', `the old method (each swap's fee ÷ its post-swap liquidity) puts ${oldSides.length - oldMiss.length} of ${oldSides.length} sides within 2%; its misses by cause: ${top(tally(oldMiss.map(cause)), 7)}; the same misses replayed along the price path: ${oldMiss.filter((x) => in2(x.neu)).length} now within 2%`);
const ver = fgSides.filter((x) => x.neu != null && x.p.verified === true), unver = fgSides.filter((x) => x.neu != null && x.p.verified !== true);
const hit = ver.filter((x) => in2(x.neu)).length;
say(ver.length ? hit / ver.length >= 0.9 : null, 'fee identity', `replayed price paths vs the pools' fee counters over the same ${DAY_BLOCKS} blocks: within 2% for ${hit} of ${ver.length} verifiable pool sides (${pct(hit, ver.length)}), within 10% for ${within(ver.map((x) => x.neu), 0.9, 1.1)}; median ${median(ver.map((x) => x.neu))?.toFixed(4) ?? '—'}; unverified (hooks that can return swap deltas, or unknown hooks) ${new Set(unver.map((x) => x.p.id)).size} pools, ${unver.filter((x) => in2(x.neu)).length} of ${unver.length} sides within 2%; ${fgUnread} pools' counters or start state unread`);
const miss = ver.filter((x) => !in2(x.neu));
const ex = [...oldMiss.filter((x) => x.p.verified === true && !in2(x.neu)), ...miss.filter((x) => in2(x.old) || x.old == null), ...oldMiss.filter((x) => in2(x.neu))].slice(0, 10);
const r4 = (x) => (x == null ? '—' : Number.isFinite(x) ? x.toFixed(3) : '∞');
// kept short: the job notice that carries every line is cut off past a few thousand characters
const flags = (x) => [[x.sd.crossing, 'cross'], [x.sd.empty, 'empty stretch'], [x.sd.extras, 'flash/donate'], [x.sd.still, 'no move'], [x.sd.backwards, 'against price'], [x.sd.inconsistent || 0, 'over fee rate']].filter(([n]) => n).map(([n, k]) => `${n} ${k}`).join(', ');
const capped = fgSides.filter((x) => x.sd.inconsistent).length;
say(true, 'fee identity misses', `left by cause: ${top(tally(miss.map(cause)), 7)}; sides with swaps paying more than the fee rate (capped to their own fee) ${capped}; examples, old → path: ${ex.slice(0, 6).map((x) => `${label(x.p)} ${x.side ? symOf(x.p.t1) : symOf(x.p.t0)} ${r4(x.old)} → ${r4(x.neu)} (${x.sd.swaps} swaps${flags(x) ? ': ' + flags(x) : ''}${x.endGap ? ', end price differs' : ''})`).join('; ') || 'none'}`);

// 4. Step 4 snapshot: volatility, scores and markouts.
const WETH = C.quotes.find((q) => q.symbol === 'WETH').address;
const keyOf = (a) => `ethereum:${a === ZERO ? WETH : a}`;
// Market history for the volatility cross-check: CoinGecko by contract (hourly points over 30 days),
// each token at most once a UTC day through a cache file the next pass reuses; DefiLlama's chart for
// the tokens CoinGecko doesn't answer. Never a flat line for a token nobody answered.
const histKeys = [...new Set(mapped.flatMap((p) => [keyOf(p.t0), keyOf(p.t1)]))];
const hcache = makeHistoryCache('out/cache/history.json');
const cgHist = await timed('history', () => coinGeckoHistory(getJson, histKeys, { key: process.env.COINGECKO_KEY || undefined, cache: hcache }));
const llHist = cgHist.unread.length ? await timed('history fallback', () => dailyHistory(getJson, cgHist.unread)) : { series: new Map(), unread: [], lastError: null };
try { hcache.save(); } catch { /* the next pass just fetches again */ }
const hist = { series: new Map([...cgHist.series, ...llHist.series]), unread: llHist.unread.length ? llHist.unread : cgHist.unread.filter((k) => !llHist.series.has(k)) };
// Each pool's own price at 31 daily blocks (archive state): that price is what range exits and LVR
// follow. Each block's own timestamp comes along (Multicall3), so the market is sampled at the same moments.
const nowSec = Math.floor(Date.now() / 1000);
const pxCalls = [{ target: MULTICALL3, data: encodeCall('getCurrentBlockTimestamp()') }, ...mapped.map((p) => (p.v === 3 ? { target: p.id, data: encodeCall('slot0()') } : v4Slot0Call(C.v4StateView, p.id)))];
const pxDays = await timed('daily prices', () => mapLimit(Array.from({ length: 31 }, (_, k) => block - k * DAY_BLOCKS), 3, (b) => amc(pxCalls, '0x' + b.toString(16))));
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
const byPool = byPoolEarly;
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
  const m = unreadIds.has(p.id) ? null : markouts(byPool.get(p.id) || [], { horizon: MARKOUT_BLOCKS, endBlock: block, feeOf: (s) => swapFees(s, meta.get(p.id))?.total ?? null });
  p.markout = m ? m.ratio : null;
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
  const sc = mapped.filter((p) => p.score?.net != null), readM = sc.filter((p) => p.sigmaMarket != null), rr = both.map((p) => p.sigmaChain / p.sigmaMarket);
  const calm = both.filter((p) => p.sigmaChain < 0.002 && p.sigmaMarket < 0.002);
  say(sc.length && both.length ? readM.length / sc.length >= 0.9 && within(rr, 0.7, 1.3) / both.length >= 0.7 : null, 'volatility check',
    `market volatility read for ${readM.length} of ${sc.length} scored pools (${pct(readM.length, sc.length)}); pool vs market within 30% for ${within(rr, 0.7, 1.3)} of ${both.length} (${pct(within(rr, 0.7, 1.3), both.length)}), median ratio ${median(rr)?.toFixed(2) ?? '—'}; calm pairs (both under 0.2% a day) ${calm.length}, within 30% ${within(calm.map((p) => p.sigmaChain / p.sigmaMarket), 0.7, 1.3)}` +
    `; history: CoinGecko ${cgHist.fetched} fetched + ${cgHist.cached} from today's cache (${cgHist.calls} calls${cgHist.lastError ? `, last error ${cgHist.lastError}` : ''}), DefiLlama fallback ${llHist.series.size} of ${cgHist.unread.length}${llHist.lastError ? ` (last error ${llHist.lastError})` : ''}, unread ${hist.unread.length} of ${histKeys.length} tokens`);
}
const scored = mapped.filter((p) => p.score?.net != null);
const pos = scored.filter((p) => p.score.net > 0), edgy = scored.filter((p) => p.score.edge > 1);
say(true, 'scores', `at a $${EXAMPLE_TICKET} example ticket over ${HOLD_DAYS}-day ranges: ${scored.length} pools scored; net APR above zero for ${pos.length}, fees above LVR (edge > 1) for ${edgy.length}; median fee APR ${fr(median(scored.map((p) => p.score.feeApr)))}, LVR ${fr(median(scored.map((p) => p.score.lvr)))}, net ${fr(median(scored.map((p) => p.score.net)))}`);
const sScored = scored.filter((p) => p.hollow >= 0.8);
say(true, 'stranded scores', `of the ${strandedPools.length} stranded or one-sided pools, ${sScored.length} scored: net APR above zero for ${sScored.filter((p) => p.score.net > 0).length}; median net ${fr(median(sScored.map((p) => p.score.net)))}, median edge ${median(sScored.map((p) => p.score.edge))?.toFixed(2) ?? '—'}`);
const mk = mapped.filter((p) => p.markout != null);
say(true, 'flow', `markouts (${MARKOUT_BLOCKS} blocks after each swap) read for ${mk.length} pools: median ${fr(median(mk.map((p) => p.markout)))} of the fee; ${mk.filter((p) => p.markout <= 0.6).length} pass the toxic-flow filter (≤ 60%)`);
const moved = mapped.filter((p) => p.sigma > 0 && p.move7dLog != null && p.lastDayLog != null && Math.abs(p.move7dLog) / (p.sigma * Math.sqrt(7)) >= 2 && Math.abs(p.lastDayLog) <= p.sigma);
say(true, 'lenses today', `stranded ${strandedPools.filter((p) => p.tag === 'stranded').length}, one-sided ${strandedPools.filter((p) => p.tag === 'one-sided').length}, after a big move ${moved.length} (30-day averages, pool ages and calm-pair kinds come with stored history)`);
// 5. Persistence from past maps (archive state at 10, 20 and 30 days ago) for the pools that look
//    stranded or close to it today, plus the benchmark as the worked example; then the gem score.
let budget = 250_000;
const cands = mapped.filter((p) => p.hollow >= 0.5 || p.id === BENCH).filter((p) => { const w = wordsFor(p.tickSpacing).length * 3; if (w > budget && p.id !== BENCH) return false; budget -= w; return true; });
const nowSeg = new Map(ready.map((p, i) => [p.id, maps[i]?.segments ?? null]));
const pastBlocks = [10, 20, 30].map((d) => block - d * DAY_BLOCKS);
let pastRead = 0, pastTried = 0;
await timed('past maps', async () => {
  for (const pb of pastBlocks) {
    const ptag = '0x' + pb.toString(16);
    const st = await amc(cands.flatMap((p) => (p.v === 3
      ? [{ target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') }]
      : [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }])), ptag);
    const alive = [];
    cands.forEach((p, i) => {
      const s0 = p.v === 3 ? readV3Slot0(st[2 * i]) : readV4Slot0(st[2 * i]), L = readUint(st[2 * i + 1]);
      p.past = p.past || [];
      if (s0 === false) { p.past.push({ hollow: null, segments: null, absent: true }); return; } // the pool did not exist yet
      if (!s0 || L == null || !(s0.sqrtPriceX96 > 0n)) { p.past.push({ hollow: null, segments: null }); return; }
      alive.push({ p, s0, L });
    });
    pastTried += alive.length;
    const ms = alive.length ? await readMaps(amc, alive.map(({ p, s0, L }) => ({ v: p.v, id: p.id, tickSpacing: p.tickSpacing, tick: s0.tick, liquidity: L })), { stateView: C.v4StateView, tag: ptag }) : [];
    alive.forEach(({ p, s0 }, i) => {
      const m = ms[i];
      if (!m || m.unread || !(m.checks.netSumZero && m.checks.matchesPool)) { p.past.push({ hollow: null, segments: null }); return; }
      pastRead++;
      const h = hollowness(m.segments, sqrtX96ToSqrt(s0.sqrtPriceX96), p.d1, s0.tick, m.checks.walkedLiquidity, { near: nearOf(p) });
      p.past.push({ hollow: h.hollow, segments: m.segments });
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
  if (hookedPool(p)) warnings.push('hooked pool');
  if (r && r.swaps < 10) warnings.push('thin: under 10 swaps a day');
  if (p.offMarket) warnings.push('pool price more than 10% off market');
  p.gem = gemScore({ stranded: p.hollowAvg, net: p.score?.net ?? null, persistence: p.persistence, flow: p.flow, warnings, fails: p.verified === false ? ['unverified: its hook can settle swaps outside the pool'] : [] });
}
const gems = cands.filter((p) => p.gem?.total != null && p.id !== BENCH);
say(pastRead ? true : null, 'persistence', `past maps read ${pastRead} of ${pastTried} (${cands.length} pools × 3 dates through archive nodes); stranded in every snapshot ${cands.filter((p) => p.strandedShare === 1).length}; median share of today's parked value already there 30 days ago ${fr(median(cands.map((p) => p.sticky)))}`);
say(true, 'gem scores', `${gems.length} candidates scored: ${gems.filter((p) => p.gem.total >= 60).length} at 60 or more, ${gems.filter((p) => p.gem.total >= 40).length} at 40 or more; median ${median(gems.map((p) => p.gem.total)) ?? '—'}; blank for missing inputs ${cands.filter((p) => p.gem && p.gem.total == null).length} (most often: ${top(tally(cands.flatMap((p) => p.gem?.missing ?? [])), 3)})`);
const b = ready.find((p) => p.id === BENCH);
if (b && b.tag) {
  say(true, 'benchmark', `UNI/WETH 0.3%: ${usd(b.mapUsd)} mapped, stranded ${fr(b.hollow)} (${b.tag}), ±9% holds ${fr(b.band9)}; 24 h volume ${usd(b.vol24h)}, LP fees ${usd(b.fees24h)}; protocol fee ${b.s.feeProtocol ? 'on' : 'off'}`);
  const k = b.score || {};
  say(true, 'benchmark score', `σ ${fr(b.sigma)} a day → range ±${fr(k.r)}; at $${EXAMPLE_TICKET}: fee APR ${fr(k.feeApr)}, LVR ${fr(k.lvr)}, net ${fr(k.net)}, edge ${k.edge?.toFixed(2) ?? '—'}, re-range every ${k.rerangeDays ? Math.round(k.rerangeDays) + ' days' : '—'}; markouts ${fr(b.markout)} of the fee; nearest walls ${k.wallSigmaBelow == null ? '—' : k.wallSigmaBelow === Infinity ? 'none in view' : k.wallSigmaBelow.toFixed(1) + ' σ-weeks'} below, ${k.wallSigmaAbove == null ? '—' : k.wallSigmaAbove === Infinity ? 'none in view' : k.wallSigmaAbove.toFixed(1) + ' σ-weeks'} above`);
  say(true, 'benchmark persistence', `stranded in ${b.strandedShare == null ? '—' : Math.round(b.strandedShare * (b.past.filter((x) => x.hollow != null).length + 1))} of ${b.past.filter((x) => x.hollow != null).length + 1} snapshots (now, 10, 20, 30 days ago: ${[b.hollow, ...(b.past || []).map((x) => x.hollow)].map(fr).join(', ')}); parked value already there 30 days ago ${fr(b.sticky)}; gem ${b.gem?.total ?? 'blank'}${b.gem?.missing?.length ? ' (missing ' + b.gem.missing.join(', ') + ')' : ''}`);
} else say(null, 'benchmark', 'not mapped');
// 6. Outputs (docs/DATA.md): the snapshot store, every config window per pool (lib/windows.mjs), then the
//    sealed live.json, history.json (when a pool gains an hourly row) and snapshots.json, and the plain
//    out/shortlist.json the backtest reads. With the lock only; offline runs stop at the shortlist.
//    Anything this pass could not read is null, never 0.
try {
  await timed('outputs', writeOutputs);
} catch (e) {
  console.error(e);
  say(false, 'outputs', `could not write the outputs (${String(e?.message || e).replace(/[^A-Za-z .:]/g, '').slice(0, 60)})`);
  finish(1);
}
finish(badMaps ? 1 : 0);

async function writeOutputs() {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const rnd = (x, n = 6) => (isNum(x) ? Number(x.toPrecision(n)) : null);
  // the stored snapshots (restored from the data branch); one that won't open or parse is never overwritten
  let snaps = new Map(), snapsOk = true;
  let rebuilt = false;
  if (store) { try { const o = store.get('snapshots.json'); if (o && (o.fix ?? 0) >= SNAP_FIX) snaps = parseStore(o); else if (o) rebuilt = true; } catch { snapsOk = false; } }
  const sig = (m) => [...m].map(([id, x]) => `${id}:${x.h.length}:${x.h.at(-1)?.t}:${x.d.length}:${x.d.at(-1)?.t}`).sort().join('|');
  const before = sig(snaps);
  // fee growth now for every mapped pool (the 24 h check read it only for busy pools)
  const fgNow = await mc(mapped.flatMap(fgCalls), tag);
  const rows = new Map();
  let k = 0;
  for (const p of mapped) {
    const n = fgCalls(p).length, fg = readFeeGrowth(p, fgNow.slice(k, k + n));
    k += n;
    p.row = { t: passT, block, sqrtPriceX96: B(p.s.sqrtPriceX96), tick: p.s.tick, L: p.L, fg0: fg?.[0] ?? null, fg1: fg?.[1] ?? null, parked: isNum(p.hollow) ? p.hollow : null };
    rows.set(p.id, [p.row]);
  }
  // backfill: a pool with under 20 daily or hourly rows gets the last 24 hours hourly and 30 days daily
  // (archive state). Each batch carries its own block timestamp through Multicall3, and a batch whose
  // node answered with today's state for an old block is dropped: a first version mixed such answers in,
  // so the fee counters barely moved over "30 days" and a busy pool showed a few dollars of fees.
  const need = snapsOk ? mapped.filter((p) => (snaps.get(p.id)?.d.length ?? 0) < 20 || (snaps.get(p.id)?.h.length ?? 0) < 20) : [];
  let backfilled = 0, staleBatches = 0, batches = 0;
  if (need.length) {
    const bfCalls = (p) => [...stCalls(p), ...fgCalls(p)]; // slot0, liquidity, fee growth
    const backs = [...Array.from({ length: 24 }, (_, j) => (j + 1) * 300), ...Array.from({ length: 29 }, (_, j) => (j + 2) * DAY_BLOCKS)];
    const groups = [];
    for (let i = 0, n = 0, g = []; i < need.length; i++) { g.push(need[i]); n += bfCalls(need[i]).length; if (n >= 250 || i === need.length - 1) { groups.push(g); g = []; n = 0; } }
    const jobs = backs.flatMap((back) => groups.map((g) => ({ back, g })));
    const tsCall = { target: MULTICALL3, data: encodeCall('getCurrentBlockTimestamp()') };
    const res = await timed('backfill', () => mapLimit(jobs, 3, ({ back, g }) => amc([tsCall, ...g.flatMap(bfCalls)], '0x' + (block - back).toString(16))));
    jobs.forEach(({ back, g }, j) => {
      batches++;
      const ans = res[j] || [], ts = readUint(ans[0]);
      if (ts == null || !pastBlockAnswer(ts, { nowSec, blocksBack: back })) { staleBatches++; return; } // not that block's state
      let o = 1;
      for (const p of g) {
        const n = bfCalls(p).length, a = ans.slice(o, o + n);
        o += n;
        const s0 = p.v === 3 ? readV3Slot0(a[0]) : readV4Slot0(a[0]), L = readUint(a[1]), fg = readFeeGrowth(p, a.slice(2));
        if (!s0 && !fg) continue; // not born yet, or unread: no row
        const d = back / DAY_BLOCKS;
        const parked = Number.isInteger(d) && d % 10 === 0 ? p.past?.[d / 10 - 1]?.hollow ?? null : null; // the past maps (10, 20, 30 days ago) where read
        rows.get(p.id).push({ t: Number(ts) * 1000, block: block - back, sqrtPriceX96: s0 ? s0.sqrtPriceX96 : null, tick: s0 ? s0.tick : null, L: L ?? null, fg0: fg?.[0] ?? null, fg1: fg?.[1] ?? null, parked });
        backfilled++;
      }
    });
  }
  const snaps2 = mergeStore(snapsOk ? snaps : new Map(), rows, { now: passT });
  const changed = snapsOk && (rebuilt || sig(snaps2) !== before);

  // contract-verified: both tokens' source on Etherscan (cached a week; no key or a refused call: unread)
  const vCache = makeVerifiedCache('out/cache/etherscan.json');
  const vTok = [...new Set(mapped.flatMap((p) => [p.t0, p.t1]).filter((a) => a !== ZERO))];
  const vs = await timed('etherscan', () => verifiedSources(getJson, vTok, { key: process.env.ETHERSCAN_KEY || undefined, cache: vCache }));
  try { vCache.save(); } catch { /* read again next pass */ }
  const vOf = (a) => (a === ZERO ? true : vs.verified.get(a) ?? null);
  const bothVerified = (p) => { const v = [vOf(p.t0), vOf(p.t1)]; return v.includes(false) ? false : v.includes(null) ? null : true; };
  say(vs.calls || vs.cached ? true : null, 'contract source', `tokens with verified source on Etherscan ${[...vs.verified.values()].filter((x) => x === true).length} of ${vTok.length}, unverified ${[...vs.verified.values()].filter((x) => x === false).length}, unread ${[...vs.verified.values()].filter((x) => x == null).length} (${vs.fetched} read, ${vs.cached} from the week's cache${vs.lastError ? `, last error ${vs.lastError}` : ''})`);
  // every window per pool
  const prev = (() => { try { return store?.get('live.json') ?? null; } catch { return null; } })();
  const firstAt = new Map((prev?.pools || []).map((x) => [x.id, x.gemFirstAt ?? null]));
  const windows = config.windows, defaultWindow = windows.includes('30d') ? '30d' : windows[windows.length - 1];
  const out = [];
  for (const p of mapped) {
    const t0 = tok.get(p.t0) || {}, t1 = tok.get(p.t1) || {};
    let feeTier = null, keeps = null;
    if (p.v === 3) {
      const n0 = p.s.feeProtocol % 16, n1 = p.s.feeProtocol >> 4;
      feeTier = p.fee / 1e6; keeps = [n0 ? 1 - 1 / n0 : 1, n1 ? 1 - 1 / n1 : 1];
    } else if (isNum(p.s.lpFee) && isNum(p.s.protocolFee)) {
      const lp = p.s.lpFee / 1e6, pf = [(p.s.protocolFee & 0xfff) / 1e6, (p.s.protocolFee >> 12) / 1e6];
      const tiers = pf.map((x) => x + lp - x * lp), lpRate = pf.map((x) => lp * (1 - x));
      feeTier = (tiers[0] + tiers[1]) / 2; keeps = feeTier > 0 ? lpRate.map((r) => r / feeTier) : null;
    }
    const pxNow = poolPrice(B(p.s.sqrtPriceX96), t0.decimals, t1.decimals);
    const ratio = priceRatio({ poolPrice: pxNow, quoteIs: quoteAddrs.has(p.t1) ? 1 : 0, usd0: t0.usd, usd1: t1.usd });
    const offMarket = ratio == null ? null : Math.abs(ratio - 1) > config.priceSanity;
    const r = sums.get(p.id);
    const warnings = gemWarnings({ v: p.v, hooks: p.hooks, swaps24h: r ? r.swaps : unreadIds.has(p.id) ? null : 0, offMarket });
    const seg = segOf.get(p.id);
    // the pool's checklist: a check that did not run is null, never a pass
    const sides = fgSides.filter((x) => x.p === p && x.neu != null);
    const within = (x, lo, hi) => (x == null || !Number.isFinite(x) ? null : x >= lo && x <= hi);
    const checks = [
      { id: 'maps-complete', label: 'map complete', ok: true },
      { id: 'map-vs-balances', label: 'map within the pool balances', ok: p.v === 3 && p.tvl > 0 && p.mapUsd != null ? p.mapUsd / p.tvl <= 1.02 : null },
      { id: 'price-vs-market', label: 'price vs market', ok: within(ratio, 0.98, 1.02) },
      { id: 'fee-identity', label: 'swaps reproduce the fee counters', ok: sides.length ? sides.every((x) => in2(x.neu)) : null },
      { id: 'verified', label: 'no hook settles swaps outside the pool', ok: p.verified ?? null },
      { id: 'volume-vs-aggregator', label: 'volume vs aggregator', ok: p.aggVolumeUsd24h > 0 && p.vol24h != null ? within(p.vol24h / p.aggVolumeUsd24h, 0.75, 1.25) : null },
      { id: 'volatility-xcheck', label: 'pool vs market volatility', ok: p.sigmaChain > 0 && p.sigmaMarket > 0 ? within(p.sigmaChain / p.sigmaMarket, 0.7, 1.3) : null },
      { id: 'swaps-read', label: 'a day of swaps read', ok: unreadIds.has(p.id) ? null : true },
      { id: 'markouts-read', label: 'markouts read', ok: p.markout != null ? true : null },
      { id: 'creation-events', label: 'creation event found', ok: creationCheck({ createdAt: p.createdAt, complete: p.v === 3 ? list.v3EventsComplete === true : false }) },
      { id: 'fees-vs-aggregator', label: 'fees vs aggregator', ok: feesVsAggregator({ feesUsd: p.fees24h != null && p.proto24h != null ? p.fees24h + p.proto24h : null, aggVolumeUsd: p.aggVolumeUsd24h, feeTier: p.v === 4 && p.fee === DYNAMIC_FEE ? null : feeTier }).ok },
      { id: 'contract-verified', label: 'both tokens\' source verified', ok: bothVerified(p) },
      { id: 'token-age-rank', label: `tokens ranked and trading ${config.minPairAgeDays}+ days`, ok: tokenAgeRank([tok.get(p.t0), tok.get(p.t1)].map((t) => t && { quote: !!t.quote, rank: t.rank ?? null, firstPoolAt: t.firstPoolAt ?? null }), { now: passT / 1000, minDays: config.minPairAgeDays }) },
    ];
    const cur = { ...p.row, aboveShare: p.aboveShare ?? null, segments: seg || undefined };
    const winsWith = (cks) => allWindows({
      series: snaps2.get(p.id), cur, chain: 'ethereum', config,
      pool: { feeTier, lpKeeps: keeps, d0: t0.decimals, d1: t1.decimals, usd0: t0.usd ?? null, usd1: t1.usd ?? null, tvlUsd: p.tvl ?? p.mapUsd ?? null,
        gasUsd, walls: p.walls ?? null, inactiveShare: p.sticky ?? null, warnings, fails: cks.filter((c) => c.ok === false).map((c) => c.label),
        checks: { ran: cks.filter((c) => c.ok != null).length, total: cks.length },
        flow: (() => {
          if (unreadIds.has(p.id)) return {};
          const gemFlow = { markoutToFee: p.markout ?? null, traders7d: r ? 7 * r.txs : 0 }; // the latest day's replay, for the gem of longer windows
          return { '24h': { swaps: r ? r.swaps : 0, traders: r ? r.txs : 0, markout: p.markout ?? null }, '7d': { gemFlow }, '30d': { gemFlow } };
        })() },
    });
    // the 24 h window's LP fees (from the fee counters) against the exact swap replay of the same day: within 10%
    const w24 = winsWith([...checks, { id: 'window-vs-replay', ok: null }])['24h'];
    const wr = w24?.lpFeesUsd != null && p.fees24h > 0 ? w24.lpFeesUsd / p.fees24h : null;
    checks.push({ id: 'window-vs-replay', label: '24 h fees from the counters vs the swap replay', ok: wr == null ? null : Math.abs(wr - 1) <= 0.1 });
    p.windowVsReplay = wr;
    const w = winsWith(checks);
    const hist = seg ? depthHistogram(seg, p.sqrt, p.d1, p.s.tick) : null;
    const gem = w[defaultWindow]?.gem?.total ?? null;
    const series = snaps2.get(p.id);
    out.push({
      id: p.id, chain: 'ethereum', v: p.v, pair: `${symOf(p.t0)}/${symOf(p.t1)}`,
      t0: { sym: symOf(p.t0), addr: p.t0, dec: t0.decimals ?? null, usd: t0.usd ?? null }, t1: { sym: symOf(p.t1), addr: p.t1, dec: t1.decimals ?? null, usd: t1.usd ?? null },
      feeTier, dynamicFee: p.v === 4 && p.fee === DYNAMIC_FEE, lpKeeps: keeps ? (keeps[0] + keeps[1]) / 2 : null,
      hooks: p.v === 4 ? p.hooks ?? null : null, verified: p.verified ?? null,
      firstSeen: Math.min(passT, series?.d[0]?.t ?? passT, series?.h[0]?.t ?? passT),
      createdAt: isNum(p.createdAt) ? p.createdAt * 1000 : null, pairAgeDays: isNum(p.createdAt) ? rnd((passT / 1000 - p.createdAt) / 86400, 2) : null, young: isNum(p.createdAt) ? passT / 1000 - p.createdAt < 30 * 86400 : null,
      tvlUsd: p.tvl ?? null, mapUsd: p.mapUsd ?? null, aggUsd: p.aggReserveUsd ?? null,
      price: rnd(pxNow, 10), marketRatio: rnd(ratio), offMarket,
      shape: {
        tag: p.tag ?? null, parked: p.hollow ?? null, above: p.aboveShare ?? null, band9: p.band9 ?? null, lpsAtPrice: null,
        depth: hist && isNum(p.per1) ? hist.buckets.map((v, i) => [rnd(-hist.span + (i + 0.5) * hist.bucketLog, 4), rnd(v * p.per1, 5)]) : [],
        walls: { below: isNum(p.walls?.below) ? p.walls.below : null, above: isNum(p.walls?.above) ? p.walls.above : null },
      },
      w,
      checks,
      gemFirstAt: firstAt.get(p.id) ?? (gem != null && gem >= config.gemAt ? passT : null),
    });
  }
  const gemOf = (x) => x.w[defaultWindow]?.gem?.total ?? -1;
  out.sort((a, b) => gemOf(b) - gemOf(a) || (b.tvlUsd ?? b.mapUsd ?? 0) - (a.tvlUsd ?? a.mapUsd ?? 0));

  // the shortlist the backtest reads (plain, local, never printed): the best gem scores, plus the benchmark
  const short = out.filter((x) => gemOf(x) >= 0).slice(0, 20).map((x) => x.id);
  if (!short.includes(BENCH) && out.some((x) => x.id === BENCH)) short.push(BENCH);
  fs.mkdirSync('out', { recursive: true });
  fs.writeFileSync('out/shortlist.json', JSON.stringify({ t: passT, ids: short }));
  const tallyCheck = (id) => { const c = out.map((x) => x.checks.find((k) => k.id === id)?.ok); return `${id} ${c.filter((v) => v === true).length} pass / ${c.filter((v) => v === false).length} fail / ${c.filter((v) => v == null).length} not run`; };
  say(true, 'pool checks', ['creation-events', 'fees-vs-aggregator', 'token-age-rank', 'contract-verified', 'window-vs-replay'].map(tallyCheck).join('; '));
  const wvr = mapped.map((p) => p.windowVsReplay).filter((x) => x != null), bm = mapped.find((p) => p.id === BENCH);
  say(wvr.length ? wvr.filter((x) => Math.abs(x - 1) <= 0.1).length / wvr.length >= 0.8 : null, 'window vs replay',
    `24 h LP fees from the fee counters within 10% of the swap replay for ${wvr.filter((x) => Math.abs(x - 1) <= 0.1).length} of ${wvr.length} pools; median ratio ${median(wvr)?.toFixed(3) ?? '—'}`);
  // the benchmark (UNI/WETH 0.3%, public market data): 24 h LP fees ÷ (aggregator volume × 0.3% × LP share)
  const b24 = out.find((x) => x.id === BENCH)?.w['24h'];
  const bRatio = b24?.lpFeesUsd != null && bm?.aggVolumeUsd24h > 0 ? b24.lpFeesUsd / (bm.aggVolumeUsd24h * 0.003 * (out.find((x) => x.id === BENCH).lpKeeps ?? 1)) : null;
  pub(`benchmark UNI/WETH 0.3%: 24 h LP fees ÷ (aggregator 24 h volume × 0.3% × LP share) = ${bRatio == null ? 'unread' : bRatio.toFixed(3)}`);
  const nWin = (wk) => out.filter((x) => x.w[wk] != null).length;
  say(true, 'windows', `${out.length} pools: ${windows.map((wk) => `${wk} ${nWin(wk)}`).join(', ')} with a window (under a day of snapshots is blank); ${out.filter((x) => gemOf(x) >= 0).length} with a gem score; shortlist ${short.length}; snapshot rows backfilled ${backfilled} (batches answered with today's state, dropped: ${staleBatches} of ${batches})`);
  if (!store) { say(null, 'sealed outputs', 'no lock in this run: live.json, history.json and snapshots.json not written'); return; }

  const area = (a) => lines.find((l) => l.area === a);
  const chk = (id, label, a) => ({ id, label, ok: area(a)?.ok ?? null, value: null, detail: area(a)?.msg ?? '' });
  const live = {
    v: 1, t: passT, phase: 0, build: `scan-${(process.env.GITHUB_SHA || 'local').slice(0, 7)}`, next: null,
    ticket: config.ticket, stopLoss: config.stopLoss, windows, defaultWindow, gemAt: config.gemAt,
    chains: [{ id: 'ethereum', pools: out.length, unread: unreadMaps + badMaps + (chosen.length - ready.length), block, gasUsd: isNum(gasUsd) ? gasUsd : null }],
    health: {
      loop: prev?.health?.loop ?? null,
      checks: [chk('fee-identity', 'fee identity', 'fee identity'), chk('price-vs-market', 'price vs market', 'price check'), chk('volume-vs-aggregator', 'volume vs aggregator', 'volume check'),
        chk('maps-complete', 'maps complete', 'maps'), chk('lp-book', 'LP book', 'lp book'), chk('creation-events', 'creation events', 'creation events'),
        chk('volatility-xcheck', 'volatility cross-check', 'volatility check'), chk('fees-vs-aggregator', 'fees vs aggregator', 'fees vs aggregator')],
      sealedLog: logStats ? (({ lines: l, errors, categories }) => ({ lines: l, errors, categories }))(logStats()) : null,
    },
    bench: BENCH, pools: out,
  };
  store.put('live.json', live);
  let histWritten = false;
  if (snapsOk && (changed || !fs.existsSync(`${store.outDir}/history.json`))) {
    const hp = {};
    for (const p of mapped) {
      const s2 = snaps2.get(p.id), t0 = tok.get(p.t0) || {}, t1 = tok.get(p.t1) || {};
      if (!s2) continue;
      const x = out.find((o) => o.id === p.id), rate = x.feeTier && x.lpKeeps ? x.feeTier * x.lpKeeps : null;
      const usd = (a0, a1) => usdOfPair([a0, a1], t0.decimals, t1.decimals, t0.usd, t1.usd);
      const px = (row) => (row.sqrtPriceX96 != null ? rnd(poolPrice(row.sqrtPriceX96, t0.decimals, t1.decimals), 8) : null);
      const fees = (a, b) => {
        if (!a || a.fg0 == null || a.fg1 == null || b.fg0 == null || b.fg1 == null || a.L == null || b.L == null) return null;
        const L = a.L > 0n && b.L > 0n ? (2n * a.L * b.L) / (a.L + b.L) : a.L > b.L ? a.L : b.L;
        return usd((deltaFg(a.fg0, b.fg0) * L) >> 128n, (deltaFg(a.fg1, b.fg1) * L) >> 128n);
      };
      hp[p.id] = {
        h: s2.h.map((row, i) => [row.t, px(row), row.L == null ? null : Number(row.L), rnd(fees(s2.h[i - 1], row), 5), row.parked]),
        d: s2.d.map((row, i) => { const f = fees(s2.d[i - 1], row); return [row.t, px(row), rnd(f, 5), f != null && rate ? rnd(f / rate, 5) : null, row.parked]; }),
      };
    }
    let ph = null;
    try { ph = store.get('history.json'); } catch { ph = null; }
    const hour = Math.floor(passT / 3600e3) * 3600e3, health = (ph?.health || []).filter((x) => x[0] >= passT - 7 * 86400e3 && x[0] !== hour);
    const last = (ph?.health || []).find((x) => x[0] === hour);
    health.push([hour, (last?.[1] ?? 0) + (badMaps ? 0 : 1), (last?.[2] ?? 0) + 1, unreadMaps + badMaps]);
    store.put('history.json', { v: 1, t: passT, pools: hp, health });
    histWritten = true;
  }
  if (snapsOk && (changed || !fs.existsSync(`${store.outDir}/snapshots.json`))) store.put('snapshots.json', { ...serializeStore(snaps2), t: passT, fix: SNAP_FIX });
  say(snapsOk ? true : false, 'sealed outputs', `live.json written with ${out.length} pools; history.json ${histWritten ? 'written' : 'kept (no new hourly row)'}; snapshots ${snapsOk ? (changed ? 'updated' : 'unchanged') : 'stored copy did not open: left as it was'}`);
}
