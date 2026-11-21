// Tier-days probe (diag.yml part "tiers"; public market data only, no lock, no sealed file): one pair's pools on
// Ethereum, per UTC day, three ways:
//   1. on-chain, independently: each day's Swap / Flash / Donate logs summed here (fee = amount in × the swap's fee ×
//      what LPs keep after the protocol's cut read from slot0), valued at DefiLlama's daily prices; the fee counters
//      (Δ feeGrowthGlobal × the liquidity at the day's two ends) and the pool's balances at each day's end;
//   2. the aggregators: GeckoTerminal's day candles and DefiLlama's yields chart (TVL and base APY per day);
//   3. the scanner's own code path on those same reads: lib/exactfees.mjs (the swap days, through the scan's own
//      chain reads), lib/feehist.mjs feeYear (the y rows), lib/charts.mjs historyRows (the d rows),
//      lib/spikes.mjs feeSpikes (the `u` flags), lib/tvlhist.mjs volTvlYear (yv, yt).
// Plus a log-node check of the exact fees' own read (why Ethereum's exact-fee jobs come back unread).
// Prints tickers, tiers, days, USD fees, volumes, TVL, ratios, counts and pass/fail only: never an address, a
// position or a wallet; errors as a category of words.
import fs from 'node:fs';
import { CHAINS } from '../lib/chains.mjs';
import { makeRpc, getJson, mapLimit } from '../lib/rpc.mjs';
import { makeMulticall, MULTICALL3 } from '../lib/multicall.mjs';
import { encodeCall, decodeWords, signed } from '../lib/abi.mjs';
import { getPoolCall, readGetPool, v4PoolId, readV4Slot0, readV3Slot0, readUint, v3LpKeeps, poolKeysCall, readPoolKey, sortPair, ZERO, V4_STANDARD, DYNAMIC_FEE, poolPrice } from '../lib/pools.mjs';
import { feeGrowthCalls } from '../lib/maps.mjs';
import { readBackfill } from '../lib/backfill.mjs';
import { firstBlockAt, exactFeesChain, chainIo, emptyCache, filterOf } from '../lib/exactfees.mjs';
import { feeYear, parseOhlcv, gtUrl, baseSide } from '../lib/feehist.mjs';
import { historyRows } from '../lib/charts.mjs';
import { feeSpikes, spikes, rowRates, swapEvidence, volumeEvidence, backed } from '../lib/spikes.mjs';
import { volTvlYear, emptyTv, recordTv, holdings, balanceCalls, readBalances } from '../lib/tvlhist.mjs';
import { parseChart } from '../lib/history.mjs';
import { parseGeckoPools } from '../lib/aggregators.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { SWAP_TOPICS, EXTRA_TOPICS } from '../lib/swaps.mjs';

const out = [];
const say = (m) => { out.push(m); console.log(m); };
const finish = (code = 0) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### tier days\n\n```\n' + out.join('\n') + '\n```\n');
  process.exit(code);
};
const cat = (e) => String(e?.message || e).replace(/0x[0-9a-fA-F]+/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60) || 'error';
process.on('unhandledRejection', (e) => { say(`error: ${cat(e)}`); finish(1); });
process.on('uncaughtException', (e) => { say(`error: ${cat(e)}`); finish(1); });

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const DAY = 86400e3;
const day = (t) => new Date(t).toISOString().slice(5, 10);
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const usd = (x) => (!isNum(x) ? '—' : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `$${(x / 1e3).toFixed(1)}K` : `$${x.toFixed(0)}`);
const pct = (x, d = 3) => (!isNum(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const r2 = (x) => (!isNum(x) ? '—' : x.toFixed(2));
const hex = (n) => '0x' + n.toString(16);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

const CH = CHAINS.ethereum, C = CH.c;
const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const SYM = new Map([[UNI, 'UNI'], [WETH, 'WETH'], [ZERO, 'ETH']]);
const FROM = Date.parse(`${process.env.TIERS_FROM || '2026-10-25'}T00:00:00Z`), TO = Date.parse(`${process.env.TIERS_TO || '2026-11-03'}T00:00:00Z`);
const NOW = Date.now(), TODAY = Math.floor(NOW / DAY) * DAY;
const B0 = FROM - 16 * DAY, B1 = Math.min(TO + 17 * DAY, TODAY); // day starts read: the spike rule's 15 days either side
const DAYS = []; for (let t = FROM; t <= TO; t += DAY) DAYS.push(t);
const T_ALL = []; for (let t = B0; t <= B1; t += DAY) T_ALL.push(t);

const rpc = makeRpc(CH.rpcs, { timeout: 20000, maxRefusals: 6 });
const amc = makeMulticall(makeRpc(CH.archive, { timeout: 25000, maxRefusals: 6 }), { chunk: 300, concurrency: 2 });
const mc = makeMulticall(rpc, { chunk: 300, concurrency: 2 });
const blockTs = async (b) => { const r = await rpc.call('eth_getBlockByNumber', [hex(b), false]); const t = r && typeof r.timestamp === 'string' ? parseInt(r.timestamp, 16) : null; return Number.isFinite(t) ? t : null; };
const tsCall = { target: MULTICALL3, data: encodeCall('getCurrentBlockTimestamp()') };

say(`tier days: UNI/WETH on Ethereum, days ${day(FROM)} to ${day(TO)} UTC (baseline rows ${day(B0)} to ${day(B1)}); public data only`);
const head = parseInt(await rpc.call('eth_blockNumber', []), 16);
const headTs = await blockTs(head);
if (!Number.isFinite(head) || !isNum(headTs)) { say('head: unread'); finish(1); }

// ---- 1. the pools: v3 by the factory, v4 by standard keys and GeckoTerminal's list of the token's pools -------------
const [a0, a1] = sortPair(UNI, WETH);
const v3fees = [100, 500, 3000, 10000];
const v3ans = await mc(v3fees.map((fee) => getPoolCall(C.v3Factory, { t0: a0, t1: a1, fee })));
const pools = [];
v3fees.forEach((fee, i) => { const a = readGetPool(v3ans[i]); if (a) pools.push({ id: a.toLowerCase(), v: 3, dex: 'uniswap', fee, t0: a0, t1: a1 }); });
const v4keys = [];
for (const [x, y] of [[ZERO, UNI], sortPair(UNI, WETH)]) for (const [fee, ts] of V4_STANDARD) v4keys.push({ currency0: x, currency1: y, fee, tickSpacing: ts, hooks: ZERO });
const gtList = [];
for (const page of [1, 2]) {
  try { gtList.push(...parseGeckoPools(await getJson(`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${UNI}/pools?page=${page}`, { headers: { accept: 'application/json' } }, 20000))); } catch (e) { say(`GeckoTerminal token pools page ${page}: ${cat(e)}`); }
  await pause(4000);
}
const gtV4 = gtList.filter((p) => p.venue === 4 && /^0x[0-9a-f]{64}$/.test(p.id) && [p.base, p.quote].includes(UNI) && [p.base, p.quote].some((x) => x === ZERO || x === WETH));
say(`GeckoTerminal lists ${gtList.length} pools of UNI (2 pages): Uniswap v3 ${gtList.filter((p) => p.venue === 3).length}, v4 ${gtList.filter((p) => p.venue === 4).length}, of them v4 with ETH or WETH ${gtV4.length}`);
const ids4 = new Map(v4keys.map((k) => [v4PoolId(k), k]));
for (const p of gtV4) if (!ids4.has(p.id)) ids4.set(p.id, null);
const id4 = [...ids4.keys()];
const k4 = await mc(id4.flatMap((id) => [{ target: C.v4StateView, data: encodeCall('getSlot0(bytes32)', [{ t: 'bytes32', v: id }]) }, { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: id }]) }, poolKeysCall(C.v4PositionManager, id)]));
id4.forEach((id, i) => {
  const s = readV4Slot0(k4[3 * i]), L = readUint(k4[3 * i + 1]), key = ids4.get(id) || readPoolKey(k4[3 * i + 2], id);
  if (!s || !key) return;
  const g = gtList.find((x) => x.id === id);
  if (!(L > 0n) && !(g?.reserveUsd >= 10000)) return;
  pools.push({ id, v: 4, dex: 'uniswap', fee: null, keyFee: key.fee, hooked: !/^0x0{40}$/.test(key.hooks), t0: key.currency0.toLowerCase(), t1: key.currency1.toLowerCase() });
});

// the current state and the rate the scan computes (scripts/scan.mjs: feeTier and lpKeeps)
const nowAns = await mc(pools.flatMap((p) => (p.v === 3 ? [{ target: p.id, data: encodeCall('slot0()') }] : [{ target: C.v4StateView, data: encodeCall('getSlot0(bytes32)', [{ t: 'bytes32', v: p.id }]) }])));
pools.forEach((p, i) => {
  const s = p.v === 3 ? readV3Slot0(nowAns[i]) : readV4Slot0(nowAns[i]);
  p.sNow = s;
  let feeTier = null, keeps = null;
  if (p.v === 3 && s) { feeTier = p.fee / 1e6; keeps = v3LpKeeps(s.feeProtocol, 'uniswap'); }
  else if (s && isNum(s.lpFee) && isNum(s.protocolFee)) {
    const lp = s.lpFee / 1e6, pf = [(s.protocolFee & 0xfff) / 1e6, (s.protocolFee >> 12) / 1e6];
    const tiers = pf.map((x) => x + lp - x * lp), lpRate = pf.map((x) => lp * (1 - x));
    feeTier = (tiers[0] + tiers[1]) / 2; keeps = feeTier > 0 ? lpRate.map((r) => r / feeTier) : null;
  }
  p.feeTier = feeTier; p.keeps = keeps; p.lpKeeps = keeps ? (keeps[0] + keeps[1]) / 2 : null;
  p.rate = feeTier && p.lpKeeps ? feeTier * p.lpKeeps : null;
  const tierTxt = p.v === 3 ? `${(p.fee / 1e4).toFixed(2)}%` : p.keyFee === DYNAMIC_FEE ? `dyn ${s ? (s.lpFee / 1e4).toFixed(2) : '?'}%` : `${(p.keyFee / 1e4).toFixed(2)}%`;
  p.label = `v${p.v} ${tierTxt}${p.v === 4 ? ` ${SYM.get(p.t0) || '?'}/${SYM.get(p.t1) || '?'}${p.hooked ? ' hooked' : ''}` : ''}`;
});
for (const p of pools) say(`pool ${p.label}: protocol setting now ${p.v === 3 ? `feeProtocol ${p.sNow?.feeProtocol ?? '—'}` : `protocolFee ${p.sNow?.protocolFee ?? '—'}, lpFee ${p.sNow?.lpFee ?? '—'}`}; LPs keep ${p.keeps ? p.keeps.map((k) => pct(k, 1)).join(' / ') : '—'}; LP fee rate ${pct(p.rate)}`);
if (!pools.length) { say('no pools found'); finish(1); }

// ---- 2. prices: DefiLlama, today's and one a day (12:00 UTC) -------------------------------------------------------
const pk = (a) => `ethereum:${a === ZERO ? WETH : a}`;
let pxNowUsd = new Map(), pxDay = new Map();
try {
  const j = await getJson(`https://coins.llama.fi/prices/current/${pk(UNI)},${pk(WETH)}?searchWidth=4h`, {}, 20000);
  for (const [k, v] of Object.entries(j?.coins || {})) pxNowUsd.set(k.toLowerCase(), v.price);
  const start = Math.floor((B0 + DAY / 2) / 1000), n = Math.round((B1 - B0) / DAY) + 2;
  const ch = parseChart(await getJson(`https://coins.llama.fi/chart/${pk(UNI)},${pk(WETH)}?start=${start}&span=${n}&period=1d&searchWidth=600`, {}, 30000));
  for (const [k, pts] of ch) for (const q of pts) { const d = Math.floor(q.t * 1000 / DAY) * DAY; if (!pxDay.has(d)) pxDay.set(d, new Map()); pxDay.get(d).set(k, q.price); }
} catch (e) { say(`DefiLlama prices: ${cat(e)}`); }
const priceOn = (a, d) => pxDay.get(d)?.get(pk(a)) ?? null;
const priceNow = (a) => pxNowUsd.get(pk(a)) ?? null;
say(`prices: UNI now $${r2(priceNow(UNI))}, ETH now $${(priceNow(WETH) ?? 0).toFixed(0)}; UNI by day ${DAYS.map((d) => `${day(d)} $${r2(priceOn(UNI, d))}`).join(', ')}`);

// ---- 3. day boundaries: the first block at or after each 00:00 UTC (lib/exactfees.mjs firstBlockAt) ------------------
const bound = new Map();
{
  let g = head - Math.ceil((headTs - B1 / 1000) / 12);
  for (let t = B1; t >= B0; t -= DAY) {
    const b = await firstBlockAt(blockTs, t / 1000, { guess: g, spb: 12, head });
    if (b != null) { bound.set(t, b); g = b - 7160; } else g -= 7160;
  }
}
say(`day boundaries: ${bound.size} of ${T_ALL.length} found; blocks a day ${median([...bound].map(([t, b]) => (bound.has(t + DAY) ? bound.get(t + DAY) - b : null))) ?? '—'} (median)`);

// ---- 4. each pool's state at each day start: the scanner's backfill row, the balances, the protocol setting -------------
const callsOf = (p) => (p.v === 3 ? [{ target: p.id, data: encodeCall('slot0()') }, { target: p.id, data: encodeCall('liquidity()') }, ...feeGrowthCalls(p, C.v4StateView), ...balanceCalls(p)]
  : [{ target: C.v4StateView, data: encodeCall('getSlot0(bytes32)', [{ t: 'bytes32', v: p.id }]) }, { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }, ...feeGrowthCalls(p, C.v4StateView)]);
const rows = new Map(pools.map((p) => [p.id, []])), setting = new Map(pools.map((p) => [p.id, new Map()])), tv = emptyTv();
let stOk = 0;
await mapLimit([...bound], 3, async ([t, b]) => {
  const calls = [tsCall, ...pools.flatMap(callsOf)];
  const ans = await amc(calls, hex(b));
  const ts = readUint(ans?.[0]);
  if (ts == null || Number(ts) < t / 1000 || Number(ts) > t / 1000 + 3600) return;
  stOk++;
  let k = 1;
  for (const p of pools) {
    const n = callsOf(p).length, a = ans.slice(k, k + n); k += n;
    const r = readBackfill(p.v, a.slice(0, p.v === 3 ? 4 : 3));
    if (r.kind !== 'row') continue;
    const row = { t: Number(ts) * 1000, block: b, ...r.row, parked: null };
    rows.get(p.id).push(row);
    const s0 = p.v === 3 ? readV3Slot0(a[0]) : readV4Slot0(a[0]);
    setting.get(p.id).set(t, p.v === 3 ? s0?.feeProtocol : s0?.protocolFee);
    if (p.v === 3) { const h = holdings(readBalances(a.slice(4, 6)), r.row.sqrtPriceX96); if (h) recordTv(tv, p.id, { day: t - DAY, reading: h, src: 'b', now: NOW, chain: 'ethereum' }); }
  }
});
for (const p of pools) rows.get(p.id).sort((x, y) => x.t - y.t);
say(`day-start states: ${stOk} of ${bound.size} blocks read at archive nodes; rows ${pools.map((p) => `${p.label} ${rows.get(p.id).length}`).join(', ')}`);
for (const p of pools) {
  const ch = [...setting.get(p.id)].sort((x, y) => x[0] - y[0]).filter(([, v], i, a) => i === 0 || v !== a[i - 1][1]);
  say(`protocol setting ${p.label}: ${ch.map(([t, v]) => `${day(t)} ${v}`).join(' → ')}${ch.length > 1 ? ' (CHANGED)' : ' (unchanged)'}`);
}

// ---- 5. GeckoTerminal's day candles, one call a pool -----------------------------------------------------------------
const gt = new Map();
for (const p of pools) {
  for (let k = 0; k < 3 && !gt.has(p.id); k++) {
    try {
      const got = parseOhlcv(await getJson(gtUrl('eth', p.id, 70), { headers: { accept: 'application/json' } }, 20000));
      if (got) gt.set(p.id, { t: NOW, b: baseSide(got.base, p.t0, p.t1, WETH), days: new Map([...got.days].filter(([d]) => d < TODAY)) });
    } catch (e) { if (k === 2) say(`GeckoTerminal ${p.label}: ${cat(e)}`); await pause(/429/.test(String(e?.message)) ? 30000 : 5000); }
  }
  await pause(4000);
}
say(`GeckoTerminal candles: ${pools.map((p) => `${p.label} ${gt.get(p.id)?.days.size ?? 'unread'} days (base side ${gt.get(p.id)?.b ?? '—'})`).join(', ')}`);

// ---- 6. the exact fees (the scanner's lib/exactfees.mjs through the scan's own chain reads) ----------------------------
const sx = emptyCache();
sx.b.set('ethereum', new Map(bound));
const io = chainIo(CH, { head });
const caps = [];
const logs0 = io.logs;
io.logs = async (v, ids, from, to) => { const t0 = Date.now(); const r = await logs0(v, ids, from, to); caps.push({ v, from, to, n: r?.length ?? null, ms: Date.now() - t0, logs: r }); return r; };
const fakeNow = TO + DAY + 3600e3; // the pass "an hour into the day after TO": the days FROM..TO, newest first
const t0x = Date.now();
const exSt = await exactFeesChain({ chain: 'ethereum', pools: pools.map((p) => ({ id: p.id, v: p.v, dex: p.dex, fee: p.fee, createdAt: null })), cache: sx, now: fakeNow, io, days: Math.round((TO + DAY - FROM) / DAY), stopAfter: 1000 });
say(`exact fees (scanner path, ${pools.length} pools, stopAfter lifted): jobs ${exSt.jobs}, read ${exSt.read}, unread ${exSt.unread} (${Object.entries(exSt.why).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), pool-days added ${exSt.added}, pool-days unread ${exSt.poolUnread}, ${Math.round((Date.now() - t0x) / 1000)} s; log reads ${caps.length}: ${caps.filter((c) => c.n == null).length} null, ${Math.round(median(caps.map((c) => c.ms)) / 1000)} s median`);

// ---- 7. the independent day sums from the logs (own decoding and fee maths) ------------------------------------------
const dayOfBlock = (b) => { for (const [t, x] of bound) if (bound.has(t + DAY) && b >= x && b < bound.get(t + DAY)) return t; return null; };
const logRpc24 = makeRpc(CH.rpcs.filter((u) => !CH.noLogs.some((x) => u.includes(x))), { timeout: 30000, maxRefusals: 1000 });
const ind = new Map(pools.map((p) => [p.id, new Map()])); // id → day → { swaps, fees, vol, hours: [24] }
const byId = new Map(pools.map((p) => [p.id, p]));
const pf4 = (p, side, d) => { const s = setting.get(p.id).get(d); return isNum(s) ? (side === 0 ? s & 0xfff : s >> 12) : null; };
const nib = (p, side, d) => { const s = setting.get(p.id).get(d); return isNum(s) ? (side === 0 ? s % 16 : s >> 4) : null; };
const tokUsd = (a, amt, d) => { const px = priceOn(a, d); return px == null ? null : (Number(amt) / 1e18) * px; };
function addLog(l, d) {
  const t0 = String(l.topics?.[0]).toLowerCase(), w = decodeWords(l.data);
  if (!w) return;
  const v3 = t0 === SWAP_TOPICS.v3 || t0 === EXTRA_TOPICS.flash, id = v3 ? String(l.address).toLowerCase() : String(l.topics?.[1]).toLowerCase(), p = byId.get(id);
  if (!p) return;
  const m = ind.get(id); if (!m.has(d)) m.set(d, { swaps: 0, fees: 0, vol: 0, bad: 0, hours: new Array(24).fill(0) });
  const e = m.get(d), b = parseInt(l.blockNumber, 16), hr = Math.min(23, Math.max(0, Math.floor(((b - bound.get(d)) / (bound.get(d + DAY) - bound.get(d))) * 24)));
  const toks = [p.t0, p.t1];
  if (t0 === SWAP_TOPICS.v3 && w.length >= 5) {
    const x0 = signed(w[0]), x1 = signed(w[1]), side = x0 > 0n ? 0 : x1 > 0n ? 1 : null; if (side == null) return;
    const amt = side === 0 ? x0 : x1, n = nib(p, side, d), u = tokUsd(toks[side], amt, d);
    if (n == null || u == null) { e.bad++; return; }
    const f = u * (p.fee / 1e6) * (n > 0 ? 1 - 1 / n : 1);
    e.swaps++; e.vol += u; e.fees += f; e.hours[hr] += f;
  } else if (t0 === EXTRA_TOPICS.flash && w.length >= 4) {
    for (const side of [0, 1]) { const paid = w[2 + side]; if (!(paid > 0n)) continue; const n = nib(p, side, d), u = tokUsd(toks[side], paid, d); if (n == null || u == null) { e.bad++; continue; } e.fees += u * (n > 0 ? 1 - 1 / n : 1); }
  } else if (t0 === SWAP_TOPICS.v4 && w.length >= 6) {
    const x0 = signed(w[0]), x1 = signed(w[1]), side = x0 < 0n ? 0 : x1 < 0n ? 1 : null; if (side == null) return;
    const amt = side === 0 ? -x0 : -x1, fee = Number(w[5]), pf = pf4(p, side, d), u = tokUsd(toks[side], amt, d);
    if (pf == null || u == null) { e.bad++; return; }
    const f = u * Math.max(0, fee - pf) / 1e6;
    e.swaps++; e.vol += u; e.fees += f; e.hours[hr] += f;
  } else if (t0 === EXTRA_TOPICS.donate && w.length >= 2) {
    for (const side of [0, 1]) { const u = w[side] > 0n ? tokUsd(toks[side], w[side], d) : 0; if (u == null) e.bad++; else e.fees += u; }
  }
}
const readDays = new Set();
for (const c of caps) { if (!c.logs) continue; const d = dayOfBlock(c.from); if (d == null) continue; readDays.add(`${c.v}:${d}`); for (const l of c.logs) addLog(l, d); }
// days the scanner's read left unread: read again with the scan's own 24 h settings (30 s, 2 retries, chunks down to 25)
let again = 0, againNull = 0;
for (const d of DAYS) for (const v of [3, 4]) {
  const ps = pools.filter((p) => p.v === v);
  if (!ps.length || readDays.has(`${v}:${d}`) || !bound.has(d) || !bound.has(d + DAY)) continue;
  again++;
  const r = await logsAdaptive(logRpc24, filterOf(v, ps.map((p) => p.id), C.v4PoolManager), bound.get(d), bound.get(d + DAY) - 1, { step: 1000, maxStep: 1000, confirmEmpty: true, retries: 2 });
  if (!r) { againNull++; continue; }
  for (const l of r) addLog(l, d);
}
say(`independent swap sums: from the scanner's reads ${readDays.size} pool-group days; read again with the 24 h settings ${again} (${againNull} still unread)`);

// ---- 8. the scanner's rows on these reads ---------------------------------------------------------------------------
const pair = new Map(DAYS.map((d) => [d, { x: 0, xN: 0, s: 0, sN: 0, g: 0, gN: 0, i: 0, iN: 0, iv: 0, tv: 0, tvN: 0 }]));
for (const p of pools) {
  const series = { h: [], d: rows.get(p.id) };
  const d0 = 18, d1 = 18, u0 = priceNow(p.t0), u1 = priceNow(p.t1), pxNow = p.sNow ? poolPrice(p.sNow.sqrtPriceX96, d0, d1) : null;
  const poolArg = { d0, d1, rate: p.rate, dyn: p.v === 4 && p.keyFee === DYNAMIC_FEE, usd0: u0, usd1: u1, pxNow, createdAt: null };
  const g = gt.get(p.id) ?? null, sxe = sx.p.get(p.id) ?? null;
  const A = feeYear({ series, gt: g, sx: sxe, pool: poolArg, now: NOW }); // the swaps over the counters (as once exact fees read these days)
  const B = feeYear({ series, gt: g, sx: null, pool: poolArg, now: NOW }); // the counters only (the 'x' days the page showed)
  const hr = historyRows(series, { d0, d1, usd0: u0, usd1: u1, rate: p.rate });
  const spA = feeSpikes({ d: hr.d, y: A.y, gt: g, rate: p.rate, su: A.su }), spB = feeSpikes({ d: hr.d, y: B.y, gt: g, rate: p.rate, su: B.su });
  const vt = volTvlYear({ y: A.y, gt: g, sx: sxe, tv: tv.get(p.id) ?? null, now: NOW, pool: { v: p.v, d0, d1, usd0: u0, usd1: u1, pxNow } });
  const rowOf = (Y, t) => Y.y.find((r) => r[0] === t);
  const yi = new Map(A.y.map((r, i) => [r[0], i]));
  const L = new Map(rows.get(p.id).map((r) => [Math.floor(r.t / DAY) * DAY, r]));
  say(`--- ${p.label}: rate ${pct(p.rate)}; y rows ${A.y.length} (${A.yp.exact} exact, ${A.yp.sw} from swaps); u with swaps: d ${spA.u?.d.map(day).join(' ') || 'none'} · y ${spA.u?.y.map(day).join(' ') || 'none'}; u counters only: d ${spB.u?.d.map(day).join(' ') || 'none'} · y ${spB.u?.y.map(day).join(' ') || 'none'}`);
  say(`    day   swaps | swap fees  swap vol  f÷v      | counters x  L end÷start | scanner y src | GT vol   x÷GT     | TVL end  APR x  | ratio swaps÷x`);
  for (const d of DAYS) {
    const e = ind.get(p.id).get(d), xb = rowOf(B, d), ya = rowOf(A, d), gv = g?.days.get(d)?.[0] ?? null, i = yi.get(d);
    const tvl = i != null ? vt.yt[i][0] : null, la = L.get(d)?.L, lb = L.get(d + DAY)?.L;
    const xv = xb && xb[2] === 'x' ? xb[1] : null;
    const fv = e && e.vol > 0 ? e.fees / e.vol : null, xg = isNum(xv) && gv > 0 ? xv / gv : null;
    const flag = (r) => (isNum(r) && p.rate ? (Math.abs(r / p.rate - 1) > 0.15 ? ' !' : '  ') : '  ');
    say(`    ${day(d)} ${String(e?.swaps ?? '—').padStart(6)} | ${usd(e?.fees).padStart(9)} ${usd(e?.vol).padStart(9)} ${pct(fv).padStart(7)}${flag(fv)}| ${usd(xv).padStart(9)}  ${la && lb ? (Number(lb) / Number(la)).toFixed(2).padStart(6) : '     —'}     | ${usd(ya?.[1]).padStart(8)} ${ya?.[2] ?? '—'}   | ${usd(gv).padStart(8)} ${pct(xg).padStart(7)}${flag(xg)}| ${usd(tvl).padStart(8)} ${pct(isNum(xv) && tvl > 0 ? (xv / tvl) * 365 : null, 0).padStart(6)} | ${isNum(xv) && e?.fees ? r2(e.fees / xv) : '—'}${e?.bad ? ` (${e.bad} unpriced)` : ''}`);
    const P = pair.get(d);
    if (isNum(xv)) { P.x += xv; P.xN++; }
    if (ya?.[2] === 's') { P.s += ya[1]; P.sN++; }
    if (isNum(gv)) { P.g += gv; P.gN++; }
    if (e) { P.i += e.fees; P.iv += e.vol; P.iN++; }
    if (isNum(tvl)) { P.tv += tvl; P.tvN++; }
  }
  // each spike the rule finds on the y rows, with its evidence (counters only: as the page had it)
  const ySp = spikes(B.y.filter((r) => r[2] === 'x' || r[2] === 's').map((r) => ({ t: r[0], span: DAY, rate: isNum(r[1]) ? r[1] : null, src: r[2] })));
  for (const s of ySp.filter((q) => q.t >= FROM - 5 * DAY && q.t <= TO + 5 * DAY)) {
    const ev = swapEvidence(A.su, s.t, s.t + DAY), vev = volumeEvidence(g?.days, s.t, s.t + DAY, p.rate);
    say(`    spike y ${day(s.t)}: ${r2(s.ratio)}× its 30-day median (${usd(s.base)} a day); volume evidence ÷ counters ${isNum(vev) ? r2(vev / s.rate) : '—'} → ${backed(s.rate, vev) === true ? 'backed' : backed(s.rate, vev) === false ? 'CONTRADICTED' : 'NO EVIDENCE'}; swap evidence ÷ counters ${isNum(ev) ? r2(ev / s.rate) : '—'}`);
  }
  const dSp = spikes(rowRates(hr.d.map((r) => [r[0], r[2]])));
  for (const s of dSp.filter((q) => q.t >= FROM && q.t <= TO + 2 * DAY)) say(`    spike d row ending ${iso(s.t)}: ${r2(s.ratio)}× (span ${(s.span / 3600e3).toFixed(1)} h)`);
  // the spike day's hours (UTC) from its swaps
  const top = [...ind.get(p.id)].sort((x, y) => y[1].fees - x[1].fees)[0];
  if (top && top[1].fees > 0) { const h = top[1].hours.map((f, k) => [k, f]).sort((x, y) => y[1] - x[1]).slice(0, 4); say(`    busiest day ${day(top[0])}: top hours UTC ${h.map(([k, f]) => `${String(k).padStart(2, '0')}h ${usd(f)} (${pct(f / top[1].fees, 0)})`).join(', ')}`); }
}
say(`--- pair totals (tiers summed; n = tiers with a value): day | swaps fees (n) | counters x (n) | from swaps s (n) | GT volume (n) | x÷GT | TVL v3 (n)`);
for (const d of DAYS) { const P = pair.get(d); say(`    ${day(d)} | ${usd(P.i)} (${P.iN}) on ${usd(P.iv)} | ${usd(P.x)} (${P.xN}) | ${usd(P.s)} (${P.sN}) | ${usd(P.g)} (${P.gN}) | ${pct(P.gN ? P.x / P.g : null)} | ${usd(P.tv)} (${P.tvN})`); }

// ---- 9. DefiLlama's yields chart: TVL and base APY a day → implied fees ------------------------------------------------
try {
  const all = await getJson('https://yields.llama.fi/pools', {}, 90000);
  const ok = (all?.data || []).filter((x) => x && x.chain === 'Ethereum' && /uniswap/i.test(x.project || '') && (x.underlyingTokens || []).map((a) => String(a).toLowerCase()).includes(UNI) && /UNI/.test(x.symbol || '') && /ETH/.test(x.symbol || ''));
  say(`DefiLlama yields: ${ok.length} UNI/ETH Uniswap pools on Ethereum: ${ok.map((x) => `${x.project} ${x.poolMeta ?? '?'} TVL ${usd(x.tvlUsd)} vol 1d ${usd(x.volumeUsd1d)}`).join('; ')}`);
  for (const x of ok.slice(0, 6)) {
    await pause(1500);
    const ch = await getJson(`https://yields.llama.fi/chart/${x.pool}`, {}, 30000);
    const pts = (ch?.data || []).filter((q) => { const t = Date.parse(q.timestamp); return t >= FROM - DAY && t <= TO + 2 * DAY; });
    say(`  ${x.project} ${x.poolMeta ?? '?'} (fields ${Object.keys((ch?.data || [])[0] || {}).join(',')}): ${pts.map((q) => `${String(q.timestamp).slice(5, 13)} TVL ${usd(q.tvlUsd)} apyBase ${r2(q.apyBase)} → ${usd(isNum(q.apyBase) && isNum(q.tvlUsd) ? (q.apyBase / 100) * q.tvlUsd / 365 : null)}/d${isNum(q.volumeUsd1d) ? ` vol ${usd(q.volumeUsd1d)}` : ''}`).join('; ')}`);
  }
} catch (e) { say(`DefiLlama yields: ${cat(e)}`); }

// ---- 10. why the exact fees' log reads fail: the same read for a 40-pool group, and each node on one chunk --------------
try {
  const toks = [WETH, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    UNI, '0x514910771af9ca656af840dff83e8264ecf986ca', '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
    '0x6982508145454ce325ddbe47a25d4ec3d2311933', '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', '0xd533a949740bb3306d119cc777fa900ba034cd52'];
  const qs = toks.slice(0, 3), cand = [];
  for (const q of qs) for (const t of toks) if (q !== t) for (const fee of [500, 3000, 10000, 100]) { const [x, y] = sortPair(q, t); if (!cand.some((c) => c.t0 === x && c.t1 === y && c.fee === fee)) cand.push({ t0: x, t1: y, fee }); }
  const ga = await mc(cand.map((c) => getPoolCall(C.v3Factory, c)));
  const v3ids = [...new Set(cand.map((c, i) => readGetPool(ga[i])).filter(Boolean).map((a) => a.toLowerCase()))].slice(0, 40);
  const keys = []; for (const q of [ZERO, ...qs]) for (const t of toks) if (q !== t) for (const [fee, ts] of V4_STANDARD) { const [x, y] = sortPair(q, t); keys.push(v4PoolId({ currency0: x, currency1: y, fee, tickSpacing: ts, hooks: ZERO })); }
  const ka = await mc([...new Set(keys)].map((id) => ({ target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: id }]) })));
  const v4ids = [...new Set(keys)].filter((id, i) => readUint(ka[i]) > 0n).slice(0, 40);
  const d = DAYS.find((t) => t === Date.parse('2026-10-29T00:00:00Z')) ?? DAYS[0], from = bound.get(d), to = bound.get(d + DAY) - 1;
  say(`log check on ${day(d)}: a v3 group of ${v3ids.length} busy public pools, a v4 group of ${v4ids.length}`);
  for (const [name, v, ids] of [['v3', 3, v3ids], ['v4', 4, v4ids]]) {
    for (const [mode, o] of [['exact-fees settings', { timeout: 20000, opts: { step: CH.swapStep, maxStep: CH.swapStep, minStep: 250, segments: 1, confirmEmpty: CH.confirmEmpty, retries: 1 } }], ['24 h settings', { timeout: 30000, opts: { step: CH.swapStep, maxStep: CH.swapStep, segments: 1, confirmEmpty: CH.confirmEmpty, retries: 2 } }]]) {
      const lr = makeRpc(CH.rpcs.filter((u) => !CH.noLogs.some((x) => u.includes(x))), { timeout: o.timeout, maxRefusals: 1000 });
      const st = {}, t0 = Date.now();
      const r = await logsAdaptive(lr, filterOf(v, ids, C.v4PoolManager), from, to, { ...o.opts, stats: st });
      const host = (u) => new URL(u).hostname.split('.').slice(-2, -1)[0];
      say(`  ${name} ${mode}: ${r == null ? 'UNREAD (null)' : `${r.length} logs`} in ${Math.round((Date.now() - t0) / 1000)} s; answers by node ${[...lr.served].map(([u, n]) => `${host(u)} ${n}`).join(', ') || 'none'}; empty checked ${st.emptyChecked ?? 0}`);
    }
    const f = filterOf(v, ids, C.v4PoolManager), base3 = v === 3 ? { address: ids, topics: [[SWAP_TOPICS.v3, SWAP_TOPICS.pcs3, EXTRA_TOPICS.flash]] } : { address: C.v4PoolManager, topics: [[SWAP_TOPICS.v4, EXTRA_TOPICS.donate], ids] };
    for (const u of CH.rpcs) {
      const res = [];
      for (const [lab, fl] of [['exact filter', f], ['24 h filter', base3]]) {
        const t0 = Date.now();
        try {
          const j = await getJson(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ ...fl, fromBlock: hex(from), toBlock: hex(from + 999) }] }) }, 30000);
          res.push(`${lab} ${Array.isArray(j?.result) ? `${j.result.length} logs` : `error "${cat(j?.error?.message ?? 'no result')}"`} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        } catch (e) { res.push(`${lab} ${cat(e)} ${((Date.now() - t0) / 1000).toFixed(1)} s`); }
      }
      say(`  ${name} node ${new URL(u).hostname}: ${res.join('; ')}`);
    }
  }
} catch (e) { say(`log check: ${cat(e)}`); }
finish(0);
