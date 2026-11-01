// Backtest job: replays each shortlisted pool over the last 24 h, 7 days and 30 days with a
// simulated LP position (lib/backtest*.mjs) and seals out/data/backtest.json (docs/DATA.md) through
// lib/store.mjs.
// Inputs read here: 31 days of Swap logs per pool (chunks ≤ 9,000 blocks, in three pieces so an
// unread old stretch still leaves the short windows), the pool's state at 61 daily blocks through
// archive nodes (window start prices, active liquidity, protocol fee settings by day, and 30 days
// of daily prices before each window for its volatility), block headers for times and base fees.
// Public log: counts, ratios and dates only; the UNI/WETH 0.3% benchmark's results may be printed
// while the ticket is the made-up example.
import fs from 'node:fs';
import { makeRpc, mapLimit, getJson } from '../lib/rpc.mjs';
import { makeMulticall } from '../lib/multicall.mjs';
import { encodeCall, decodeWords, toAddress } from '../lib/abi.mjs';
import { ETHEREUM as C, ZERO, V3_FEES, readV3Slot0, readV4Slot0, readUint, v4Slot0Call, poolKeysCall, readPoolKey, getPoolCall, readGetPool } from '../lib/pools.mjs';
import { SWAP_TOPICS, decodeSwap, swapFees, usdOfPair } from '../lib/swaps.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { dailySigma } from '../lib/flow.mjs';
import { scorePool } from '../lib/score.mjs';
import { runBacktest, swapRateFor, HOLD_DAYS } from '../lib/backtest-run.mjs';
import { auditBacktest } from '../lib/backtest-audit.mjs';
import { loadConfig } from '../lib/config.mjs';
import { openStore } from '../lib/store.mjs';

const DAY_BLOCKS = 7200, DAILY = 61, RERANGE_GAS = 630_000, MAX_SWAPS = 400_000, TOP_FALLBACK = 3, TIME_BUDGET_MS = 45 * 60e3;
const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 };
const BENCH = '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801';
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net', 'https://eth.blockscout.com/api/eth-rpc'];
const ARCHIVE = ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth.blockscout.com/api/eth-rpc']; // serve old state (probes)
const V3_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
const QUOTE = new Map(C.quotes.map((q) => [q.address, q]));
const RANK = { USDC: 0, USDT: 0, DAI: 0, WETH: 1, ETH: 1, WBTC: 2 }; // which side is the reference: stablecoins first
const WETH = C.quotes.find((q) => q.symbol === 'WETH').address;

const T0 = Date.now(), lines = [], timing = {};
const say = (ok, area, msg) => { lines.push({ ok, area, msg }); console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'N/A '} ${area}: ${msg}`); };
const fr = (x) => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(100 * x)}%`);
const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const hex = (n) => '0x' + n.toString(16);
async function timed(name, fn) { const t = Date.now(); try { return await fn(); } finally { timing[name] = (timing[name] || 0) + Math.round((Date.now() - t) / 1000); } }
function finish(code) {
  const count = (k) => lines.filter((l) => l.ok === k).length;
  const summary = `backtest: ${count(true)} pass, ${count(false)} fail, ${count(null)} unread · steps ${Object.entries(timing).map(([k, v]) => `${k} ${v}s`).join(', ')}`;
  console.log('\n' + summary);
  console.log(`::notice title=backtest::${lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '·'} ${l.area}: ${l.msg}`).join(' | ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n| | Area | Result |\n|---|---|---|\n` +
      lines.map((l) => `| ${l.ok === true ? 'PASS' : l.ok === false ? 'FAIL' : 'N/A'} | ${l.area} | ${l.msg} |`).join('\n') + '\n');
  }
  process.exit(code);
}

// The ticket and hold days: the sealed config (lib/config.mjs) when there is one, else its made-up
// public defaults. A sealed config that won't open stops the job: never a silent fallback. Its
// error messages name a field, never a value.
let config, sealed;
try { ({ config, sealed } = loadConfig()); } catch (e) { say(false, 'config', String(e.message).slice(0, 160)); finish(1); }
const ticket = config.ticket, isPublic = !sealed, holdDays = config.holdDays?.ethereum ?? HOLD_DAYS;
// Output is sealed through lib/store.mjs, opened before any work so a wrong passphrase stops the
// pass early. Without a passphrase (an offline run) nothing is written: plaintext never touches the disk.
let store = null;
if (process.env.LOCK_PASSPHRASE) {
  try { store = openStore(); } catch { say(false, 'lock', 'the passphrase does not open lock/lock.json'); finish(1); }
}

const rpc = makeRpc(RPCS, { timeout: 30000, maxRefusals: 4 });
const mc = makeMulticall(rpc, { chunk: 300, concurrency: 3 });
const amc = makeMulticall(makeRpc(ARCHIVE, { timeout: 30000, maxRefusals: 6 }), { chunk: 300, concurrency: 3 });

const tag = await rpc.call('eth_blockNumber', []);
if (tag == null) { say(null, 'block', 'no block number'); finish(1); }
const E = parseInt(tag, 16);
const daily = Array.from({ length: DAILY }, (_, k) => E - k * DAY_BLOCKS);

// Prices: DefiLlama, fresh and confident only. ETH (address zero) is priced as WETH.
async function usdPrices(addrs) {
  const keys = [...new Set(addrs.map((a) => (a === ZERO ? WETH : a)))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += 40) {
    const j = await getJson(`https://coins.llama.fi/prices/current/${keys.slice(i, i + 40).map((a) => `ethereum:${a}`).join(',')}`, {}, 20000).catch(() => null);
    for (const [k, v] of Object.entries(j?.coins || {})) if (v.price > 0 && Date.now() / 1000 - v.timestamp < 3600 && (v.confidence ?? 1) >= 0.9) out.set(k.toLowerCase().split(':')[1], v.price);
  }
  if (out.has(WETH)) out.set(ZERO, out.get(WETH));
  return out;
}

// 1. Which pools: the scanner's shortlist, else the benchmark plus the largest quote-token v3 pools.
function readShortlist() {
  try {
    const j = JSON.parse(fs.readFileSync('out/shortlist.json', 'utf8'));
    const rows = Array.isArray(j) ? j : j.ids || j.pools || [];
    return rows.map((x) => (typeof x === 'string' ? { id: x } : x && x.id ? { ...x } : null)).filter(Boolean).map((x) => ({ ...x, id: String(x.id).toLowerCase() }));
  } catch { return null; }
}
let pools = readShortlist(), source = 'shortlist';
if (!pools?.length) {
  source = 'benchmark + largest pools';
  const qs = C.quotes.filter((q) => q.v3), stable = (q) => RANK[q.symbol] === 0, cands = [];
  for (let i = 0; i < qs.length; i++) for (let j = i + 1; j < qs.length; j++) {
    if (stable(qs[i]) && stable(qs[j])) continue; // a pegged pair says little about ranges
    const [t0, t1] = BigInt(qs[i].address) < BigInt(qs[j].address) ? [qs[i].address, qs[j].address] : [qs[j].address, qs[i].address];
    for (const fee of V3_FEES) cands.push({ t0, t1, fee });
  }
  const found = await timed('pool list', () => mc(cands.map((c) => getPoolCall(C.v3Factory, c)), tag));
  const live = cands.map((c, i) => ({ ...c, id: readGetPool(found[i]) })).filter((c) => c.id);
  const bal = await timed('pool list', () => mc(live.flatMap((c) => [c.t0, c.t1].map((t) => ({ target: t, data: encodeCall('balanceOf(address)', [{ t: 'address', v: c.id }]) }))), tag));
  const px = await usdPrices(qs.map((q) => q.address));
  live.forEach((c, i) => {
    const b0 = readUint(bal[2 * i]), b1 = readUint(bal[2 * i + 1]), u0 = px.get(c.t0), u1 = px.get(c.t1);
    c.tvl = b0 != null && b1 != null && u0 > 0 && u1 > 0 ? (Number(b0) / 10 ** QUOTE.get(c.t0).decimals) * u0 + (Number(b1) / 10 ** QUOTE.get(c.t1).decimals) * u1 : null;
  });
  const top = live.filter((c) => c.tvl != null && c.id !== BENCH).sort((a, b) => b.tvl - a.tvl).slice(0, TOP_FALLBACK);
  pools = [{ id: BENCH }, ...top.map((c) => ({ id: c.id }))];
}
for (const p of pools) p.v = p.id.length === 66 ? 4 : 3;

// 2. Static facts: tokens, fee, tick spacing (v3 from the pool, v4 from the position manager's key).
const plan = pools.map((p) => (p.v === 3
  ? ['token0()', 'token1()', 'fee()', 'tickSpacing()'].map((sig) => ({ target: p.id, data: encodeCall(sig) }))
  : [poolKeysCall(C.v4PositionManager, p.id)]));
const stat = await timed('pool facts', () => mc(plan.flat(), tag));
let off = 0;
pools.forEach((p, i) => {
  const r = stat.slice(off, (off += plan[i].length));
  if (p.v === 3) {
    const w = r.map((x) => (x && x.ok ? decodeWords(x.data)?.[0] : null));
    if (w.every((x) => x != null)) Object.assign(p, { t0: toAddress(w[0]), t1: toAddress(w[1]), fee: Number(w[2]), spacing: Number(BigInt.asIntN(24, w[3])) || V3_SPACING[Number(w[2])] });
  } else {
    const k = readPoolKey(r[0], p.id);
    if (k) Object.assign(p, { t0: k.currency0, t1: k.currency1, fee: k.fee, spacing: k.tickSpacing, hooks: k.hooks });
  }
});
const tokens = [...new Set(pools.flatMap((p) => [p.t0, p.t1]).filter((a) => a && a !== ZERO))];
const decs = await timed('pool facts', () => mc(tokens.map((t) => ({ target: t, data: encodeCall('decimals()') })), tag));
const dec = new Map([[ZERO, 18], ...tokens.map((t, i) => [t, readUint(decs[i])]).filter(([, d]) => d != null && d <= 36n).map(([t, d]) => [t, Number(d)])]);
const usd = await timed('prices', () => usdPrices([...tokens, ZERO]));
const ethUsd = usd.get(WETH) ?? null;
for (const p of pools) {
  p.d0 = dec.get(p.t0); p.d1 = dec.get(p.t1);
  const side = [p.t0, p.t1].map((a, i) => ({ i, a, rank: QUOTE.has(a) ? RANK[QUOTE.get(a).symbol] ?? 3 : 4 })).filter((s) => s.a && usd.get(s.a) > 0).sort((x, y) => x.rank - y.rank || y.i - x.i)[0];
  p.ref = side ? side.i : null; p.refUsd = side ? usd.get(side.a) : null;
}
const known = pools.filter((p) => p.t0 && p.d0 != null && p.d1 != null && p.spacing > 0 && p.ref != null);
say(known.length ? true : null, 'pools', `${pools.length} pools (${source}); facts, decimals and a reference price read for ${known.length}; ${pools.filter((p) => p.v === 4).length} v4`);

// 3. Daily headers (times, base fees) and daily pool state through archive nodes.
const hdrRaw = await timed('headers', () => rpc.batch(daily.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] }))));
const hdr = hdrRaw.map((h) => (h && h.timestamp ? { t: parseInt(h.timestamp, 16) * 1000, baseFee: h.baseFeePerGas ? parseInt(h.baseFeePerGas, 16) : null } : null));
if (!hdr[0]) { say(null, 'headers', 'latest header unread'); finish(1); }
const tOf = (b) => { // ms; linear between the daily headers around the block
  const k = (E - b) / DAY_BLOCKS, k0 = Math.max(0, Math.floor(k)), k1 = Math.min(DAILY - 1, Math.ceil(k));
  if (hdr[k0] && hdr[k1] && k1 !== k0) return hdr[k1].t + ((hdr[k0].t - hdr[k1].t) * (b - daily[k1])) / (daily[k0] - daily[k1]);
  if (hdr[k0]) return hdr[k0].t - (daily[k0] - b) * 12000;
  return hdr[0].t - (E - b) * 12000;
};
const stateCalls = (p) => (p.v === 3
  ? [{ target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') }]
  : [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }]);
const dayState = await timed('daily state', () => mapLimit(daily, 3, (b) => amc(known.flatMap(stateCalls), hex(b))));
known.forEach((p, i) => {
  p.days = dayState.map((res) => {
    const a = res[2 * i], l = res[2 * i + 1];
    if (p.v === 3 && a && a.ok && a.data === '0x') return { absent: true }; // no code yet: the pool didn't exist
    const s0 = p.v === 3 ? readV3Slot0(a) : readV4Slot0(a), L = readUint(l);
    if (s0 === false) return { absent: true };
    return s0 && L != null && s0.sqrtPriceX96 > 0n ? { ...s0, L, meta: p.v === 3 ? { fee: p.fee, feeProtocol: s0.feeProtocol } : { protocolFee: s0.protocolFee } } : null;
  });
});
const stRead = known.reduce((a, p) => a + p.days.filter((d) => d && !d.absent).length, 0), stAbsent = known.reduce((a, p) => a + p.days.filter((d) => d?.absent).length, 0);
say(hdr.every(Boolean) && stRead + stAbsent === known.length * DAILY ? true : null, 'daily state', `${hdr.filter(Boolean).length} of ${DAILY} daily headers; pool state read at ${stRead} of ${known.length * DAILY} pool-days (${stAbsent} before the pool existed)`);
const tipWei = await rpc.call('eth_gasPrice', []).then((g) => (g && hdr[0].baseFee != null ? Math.max(0, parseInt(g, 16) - hdr[0].baseFee) : 0)).catch(() => 0);

// Fee settings for a swap's block: the latest daily read at or before it (settings rarely change).
function metaAt(p, b) {
  const k = Math.min(DAILY - 1, Math.ceil((E - b) / DAY_BLOCKS));
  for (let d = 0; d < DAILY; d++) for (const kk of [k + d, k - d]) { const s = p.days[kk]; if (s && !s.absent) return s.meta; }
  return null;
}

// 4. Swaps: 31 days per pool in three pieces (last day, days 2–8, days 9–31).
const PIECES = [[E - DAY_BLOCKS + 1, E], [E - 8 * DAY_BLOCKS + 1, E - DAY_BLOCKS], [E - 31 * DAY_BLOCKS + 1, E - 8 * DAY_BLOCKS]];
const out = { v: 1, t: Date.now(), ticket, provisional: true, pools: Object.fromEntries(pools.map((p) => [p.id, { '24h': null, '7d': null, '30d': null }])) };
const tally = { swaps: 0, dup: 0, piecesUnread: 0, win: Object.fromEntries(Object.keys(WINDOWS).map((w) => [w, { done: 0, partial: 0, unread: 0, why: {} }])) };
const audits = [], ratios = [], best = {}, bench = {}, forecastGap = [];
for (const w of Object.keys(WINDOWS)) if (pools.length > known.length) { tally.win[w].unread += pools.length - known.length; tally.win[w].why.facts = pools.length - known.length; }
for (const p of known) {
  if (Date.now() - T0 > TIME_BUDGET_MS) { for (const w of Object.keys(WINDOWS)) { tally.win[w].unread++; tally.win[w].why.time = (tally.win[w].why.time || 0) + 1; } continue; }
  const filter = p.v === 3 ? { address: p.id, topics: [SWAP_TOPICS.v3] } : { address: C.v4PoolManager, topics: [SWAP_TOPICS.v4, p.id] };
  const got = await timed('swaps', () => Promise.all(PIECES.map(([a, b], i) => logsAdaptive(rpc, filter, a, b, { step: 2000, maxStep: 9000, segments: i === 2 ? 3 : 1, retries: 2 }))));
  tally.piecesUnread += got.filter((g) => g == null).length;
  const seen = new Set(), swaps = [];
  for (const log of got.filter(Boolean).flat()) {
    const s = decodeSwap(log);
    if (!s || s.pool !== p.id) continue;
    const k = `${s.block}:${s.logIndex}`;
    if (seen.has(k)) { tally.dup++; continue; }
    seen.add(k);
    s.t = tOf(s.block); s.meta = metaAt(p, s.block);
    swaps.push(s);
  }
  swaps.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  tally.swaps += swaps.length;
  const tooMany = swaps.length > MAX_SWAPS;
  for (const [w, n] of Object.entries(WINDOWS)) {
    const W = tally.win[w], miss = (why) => { W.unread++; W.why[why] = (W.why[why] || 0) + 1; };
    if (tooMany) { miss('budget'); continue; }
    if (got.slice(0, n === 1 ? 1 : n === 7 ? 2 : 3).some((g) => g == null)) { miss('logs'); continue; }
    if (p.days[n] == null) { miss('start state'); continue; }
    let k = n;
    while (k > 0 && p.days[k]?.absent) k--; // a young pool starts at its first day
    if (k === 0 || !p.days[k] || p.days[k].absent) { miss(k === 0 ? 'too young' : 'start state'); continue; }
    const partial = k < n, s0 = p.days[k], S = daily[k], start = { t: tOf(S), sqrtPriceX96: s0.sqrtPriceX96, tick: s0.tick }, end = { t: hdr[0].t };
    const ws = swaps.filter((s) => s.block > S && s.block <= E);
    // volatility from the 30 days of daily prices before the window (null for a young pool: the engine then uses the window's own)
    const pts = [];
    for (let d = k; d < DAILY; d++) { const x = p.days[d]; if (x && !x.absent && hdr[d]) { const sp = Number(x.sqrtPriceX96) / 2 ** 96; pts.push({ t: hdr[d].t / 1000, price: sp * sp }); } }
    const sigma = dailySigma(pts, { days: 30, now: start.t / 1000 });
    const fees = hdr.slice(0, k + 1).map((h) => h?.baseFee).filter((x) => x != null);
    const gasUsd = fees.length && ethUsd ? (((fees.reduce((a, x) => a + x, 0) / fees.length + tipWei) * RERANGE_GAS) / 1e18) * ethUsd : null;
    // the scanner's forecast at the window start: the same score from the state then and the day before it
    let forecastNet = null;
    const spS = Number(s0.sqrtPriceX96) / 2 ** 96, Ph = spS * spS * 10 ** (p.d0 - p.d1);
    const u = p.ref === 1 ? [p.refUsd * Ph, p.refUsd] : [p.refUsd, p.refUsd / Ph];
    if (!partial && got[n === 1 ? 1 : n === 7 ? 1 : 2] != null) {
      const prev = swaps.filter((s) => s.block > S - DAY_BLOCKS && s.block <= S), lp = [0n, 0n];
      let ok = true;
      for (const s of prev) { const f = swapFees(s, s.meta); if (!f) { ok = false; break; } lp[s.in] += f.lp; }
      const feesPerDayUsd = ok ? usdOfPair(lp, p.d0, p.d1, u[0], u[1]) : null;
      forecastNet = scorePool({ tick: s0.tick, sqrt: spS, d1: p.d1, usdPer1: u[1], activeL: s0.L, feeTier: (p.v === 3 ? p.fee : s0.lpFee) / 1e6, feesPerDayUsd, sigma, walls: null },
        { days: holdDays, ticket, gasUsd }).net;
    }
    const feeTier = (p.v === 3 ? p.fee : s0.lpFee ?? p.fee) / 1e6;
    const res = runBacktest({ swaps: ws, pool: { d0: p.d0, d1: p.d1, spacing: p.spacing, meta: null, feeTier }, start, end, usd: { ref: p.ref, refUsd: p.refUsd }, sigma, holdDays, ticket, gasUsd, forecastNet, partial });
    if (!res.backtest) { miss(res.reason || 'inputs'); continue; }
    out.pools[p.id][w] = res.backtest;
    W.done++; if (partial) W.partial++;
    const ctx = { start: { t: start.t, sp: spS, tick: s0.tick }, end, d0: p.d0, d1: p.d1, ref: p.ref, refUsd: p.refUsd, gasUsd, swapRate: swapRateFor(feeTier) };
    const a = auditBacktest(res.ours, { prep: res.prep, swaps: ws, meta: null, ctx });
    audits.push(a);
    ratios.push(...a.ratios.filter((x) => x != null));
    const b = res.backtest, top = b.strategies.filter((s) => s.net != null).sort((x, y) => y.net - x.net)[0];
    if (top) { best[w] = best[w] || {}; best[w][top.id] = (best[w][top.id] || 0) + 1; }
    if (b.forecastNet != null && b.net != null) forecastGap.push(b.net - b.forecastNet);
    if (p.id === BENCH) bench[w] = b;
  }
}

// 5. Revert Finance: does a public endpoint answer a backtest? Status classes only.
const REVERT = { backtest: `https://api.revert.finance/v1/backtest?network=mainnet&pool=${BENCH}`, initiator: `https://api.revert.finance/v1/initiator/mainnet/${BENCH}`, pool: `https://api.revert.finance/v1/pools/mainnet/${BENCH}`, site: 'https://revert.finance/' };
const rv = await timed('revert', () => Promise.all(Object.entries(REVERT).map(async ([k, url]) => {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    let j = null;
    if (r.ok && /json/.test(r.headers.get('content-type') || '')) j = await r.json().catch(() => null);
    return { k, cls: `${Math.floor(r.status / 100)}xx`, j };
  } catch { return { k, cls: 'network', j: null }; }
})));
// A backtest answer would carry a net or APR figure for the range; no documented endpoint does yet.
const answered = rv.find((x) => x.k !== 'site' && x.j && ['net_apr', 'netApr', 'apr'].some((f) => Number.isFinite(Number(x.j[f] ?? x.j?.data?.[f]))));
if (answered) say(null, 'revert', `an endpoint answered (${answered.k} ${answered.cls}), but its range and window can't be matched to ours yet; revert left null`);
else say(null, 'revert', `unreachable for backtests: ${rv.map((x) => `${x.k} ${x.cls}`).join(', ')}; revert left null`);

// 6. Write and report.
const how = store ? (store.put('backtest.json', out), 'sealed') : 'not written';
const nAud = audits.length, okAud = audits.filter((a) => a.ok).length, failedBy = {};
for (const a of audits) for (const f of a.failed) failedBy[f] = (failedBy[f] || 0) + 1;
say(tally.piecesUnread ? null : true, 'swaps', `${tally.swaps} swaps over 31 days across ${known.length} pools; ${tally.piecesUnread} of ${known.length * 3} log pieces unread; ${tally.dup} repeated logs removed`);
for (const [w, W] of Object.entries(tally.win)) say(W.done ? true : null, `window ${w}`, `${W.done} backtests (${W.partial} partial: younger pools), ${W.unread} unread${W.unread ? ` (${Object.entries(W.why).map(([k, v]) => `${k} ×${v}`).join(', ')})` : ''}`);
say(nAud ? okAud === nAud : null, 'audit', `${okAud} of ${nAud} backtests pass every check (pool fees vs replay, per-swap fees, sums, costs ledger, identity)${nAud - okAud ? `; failing: ${Object.entries(failedBy).map(([k, v]) => `${k} ×${v}`).join(', ')}` : ''}`);
const within = ratios.filter((q) => Math.abs(q - 1) <= 1e-6).length;
say(ratios.length ? within === ratios.length : null, 'fee check', `engine's pool LP fees vs the scan's replay of the same window: within 0.0001% for ${within} of ${ratios.length} pool sides; median ratio ${median(ratios)?.toFixed(6) ?? '—'}`);
if (isPublic) say(true, 'leaders', Object.entries(best).map(([w, m]) => `${w}: ${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')}`).join(' · ') || 'none');
if (isPublic) {
  say(true, 'forecast', `realised minus forecast net APR at the $${ticket} example ticket: median ${fr(median(forecastGap))} over ${forecastGap.length} full windows`);
  for (const [w, b] of Object.entries(bench)) {
    const feeApr = b.feesUsd / ticket * 365 / b.days, lvrApr = b.lvrUsd / ticket * 365 / b.days, costApr = b.costsUsd / ticket * 365 / b.days;
    say(true, `benchmark ${w}`, `UNI/WETH 0.3% at the $${ticket} example ticket, ±${fr(b.range)} (σ ${fr(b.sigma)} a day, ${b.sigmaFrom}): net ${fr(b.net)} a year (fees ${fr(feeApr)}, loss vs holding ${fr(lvrApr)}, costs ${fr(costApr)}); forecast ${fr(b.forecastNet)}; in range ${fr(b.tir)}, ${b.reranges} re-centres, share of pool fees ${b.share == null ? '—' : (100 * b.share).toFixed(3) + '%'}; ${b.swaps} swaps; best strategy ${b.strategies.filter((s) => s.net != null).sort((x, y) => y.net - x.net)[0]?.id ?? '—'}`);
  }
} else say(true, 'benchmark', `UNI/WETH 0.3% backtested for ${Object.keys(bench).join(', ') || 'no window'} (results sealed: the ticket and range are private)`);
say(how === 'sealed' ? true : null, 'output', how === 'sealed' ? 'out/data/backtest.json sealed with the lock (publishing to the data branch comes with the always-on loop)' : 'out/data/backtest.json not written: no passphrase here, and plaintext never touches the disk');
finish(nAud && okAud < nAud ? 1 : 0);
