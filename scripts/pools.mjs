// Phase 0, step 2: the pool lists. Ethereum: universe (CoinGecko ranks 100–2000 with an Ethereum
// token, plus the UNI benchmark) × quote tokens × fee tiers, looked up on-chain for Uniswap v3 and v4
// at one block; plus v4 pools with any key from the last week's creation events and, for pools the
// aggregators list, keys read from the v4 PositionManager. Checked three ways: the v3 factory's own
// creation events, a recent window re-read through plain RPC chunks, and GeckoTerminal + DexScreener
// for pools of at least $300k. Then PancakeSwap v3 on Ethereum (the same pairs through its factory) and
// Base (Uniswap v3 and v4, PancakeSwap v3; lib/discover.mjs), whose ages come from the last 72 hours of
// creation events and whose cross-check is DexScreener (GeckoTerminal's spacing would cost minutes).
// Those parts run within read caps (lib/chains.mjs caps, lib/budget.mjs): a part that reaches its time or call
// limit stops, what it did not read is null ("not read"), and the log says which cap stopped it.
// Public market data only: the log shows counts, ratios, dates, venue names and quote symbols, never an address.
import fs from 'node:fs';
import { makeRpc, getJson } from '../lib/rpc.mjs';
import { makeMulticall } from '../lib/multicall.mjs';
import { encodeCall } from '../lib/abi.mjs';
import {
  ETHEREUM as C, ZERO, TOPICS, DYNAMIC_FEE, v3Candidates, v4Candidates, getPoolCall, v4Slot0Call, readGetPool, readV4Slot0,
  readV3Slot0, readUint, decodePoolCreated, decodeInitialize, decodeModifyLiquidity, extremeFee, poolPrice, tvlUsd, baseUsdAtPool, poolKeysCall, readPoolKey,
} from '../lib/pools.mjs';
import { buildUniverse, fetchCoinGecko } from '../lib/universe.mjs';
import { geckoTokenPools, dexScreenerTokenPairs, eachSpaced } from '../lib/aggregators.mjs';
import { pageLogs, rpcLogs } from '../lib/logs.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { BASE, PANCAKE_V3, V3_FEES } from '../lib/pools.mjs';
import { CHAINS, timeOfBlock, blocksBack, chainOn } from '../lib/chains.mjs';
import { lookupV3, lookupV4, readState, priceTvl, recentCreations, stampCreations, firstTradedAt } from '../lib/discover.mjs';
import { makeBudget, capRpc, capGetJson } from '../lib/budget.mjs';

const FLOOR = 300_000;
const GECKO_SAMPLE = 40;
// Diagnostic runs can skip the slow parts: POOLS_SKIP=events,gecko,dexscreener (a full run skips nothing).
const SKIP = new Set(String(process.env.POOLS_SKIP || '').split(',').map((x) => x.trim()).filter(Boolean));
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net', 'https://eth.blockscout.com/api/eth-rpc'];

const lines = [], timing = {};
const say = (ok, area, msg) => { lines.push({ ok, area, msg }); console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'N/A '} ${area}: ${msg}`); };
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const usd = (x) => (x == null ? '—' : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}k`);
const top = (m, n = 6) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none';
const tally = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
async function timed(name, fn) { const t = Date.now(); try { return await fn(); } finally { timing[name] = Math.round((Date.now() - t) / 1000); } }

function finish(code) {
  const count = (k) => lines.filter((l) => l.ok === k).length;
  const summary = `pools: ${count(true)} pass, ${count(false)} fail, ${count(null)} unread · steps ${Object.entries(timing).map(([k, v]) => `${k} ${v}s`).join(', ')}`;
  console.log('\n' + summary);
  console.log(`::notice title=pool list::${lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '·'} ${l.area}: ${l.msg}`).join(' | ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${summary}\n\n| | Area | Result |\n|---|---|---|\n` +
      lines.map((l) => `| ${l.ok === true ? 'PASS' : l.ok === false ? 'FAIL' : 'N/A'} | ${l.area} | ${l.msg} |`).join('\n') + '\n');
  }
  process.exit(code);
}

const rpc = makeRpc(RPCS, { timeout: 25000, maxRefusals: 4 });
const mc = makeMulticall(rpc, { chunk: 400, concurrency: 3 });

// 0. One block for every on-chain read, so the lookups and the state agree with each other.
const tag = await rpc.call('eth_blockNumber', []);
if (tag == null) { say(null, 'block', 'no block number'); finish(1); }
const block = parseInt(tag, 16);

// 1. Universe.
const cg = await timed('universe', () => fetchCoinGecko(getJson, { key: process.env.COINGECKO_KEY || undefined }));
if (!cg.list || cg.markets.length === 0) { say(null, 'universe', `unread (markets ${cg.markets.length} rows, list ${cg.list ? 'ok' : 'unread'})`); finish(1); }
const quoteSet = new Set(C.quotes.map((q) => q.address));
const uni = buildUniverse(cg.markets, cg.list, { include: ['uniswap'], exclude: [...quoteSet] });
say(cg.unreadPages.length ? null : true, 'universe', `${uni.counts.ranked} coins (ranks 100–2000 and the UNI benchmark); ${uni.counts.onChain} have an Ethereum token; ${uni.counts.kept} kept` +
  (cg.unreadPages.length ? `; market pages unread: ${cg.unreadPages.join(', ')}` : ''));

// 2. Decimals (quotes too, as a sanity check on the constants).
const realQuotes = C.quotes.filter((q) => q.address !== ZERO);
const decs = await timed('decimals', () => mc([...uni.tokens, ...realQuotes].map((t) => ({ target: t.address, data: encodeCall('decimals()') })), tag));
uni.tokens.forEach((t, i) => { const d = readUint(decs[i]); t.decimals = d != null && d <= 36n ? Number(d) : null; });
const quotesRight = realQuotes.every((q, i) => readUint(decs[uni.tokens.length + i]) === BigInt(q.decimals));
say(quotesRight, 'quotes', `quote token decimals match the constants: ${quotesRight ? 'yes' : 'no'}`);
const tokens = uni.tokens.filter((t) => t.decimals != null);
say(true, 'tokens', `${tokens.length} of ${uni.tokens.length} tokens answer decimals()`);
const dec = new Map([...C.quotes.map((q) => [q.address, q.decimals]), ...tokens.map((t) => [t.address, t.decimals])]);
const universe = new Set(tokens.map((t) => t.address));

// 3. v3: the factory's getPool for every candidate.
const cand3 = v3Candidates([...universe], C.quotes.filter((q) => q.v3).map((q) => q.address));
const r3 = await timed('v3 lookup', () => mc(cand3.map((c) => getPoolCall(C.v3Factory, c)), tag));
const v3 = [];
let unread3 = 0;
cand3.forEach((c, i) => { const a = readGetPool(r3[i]); if (a === null) unread3++; else if (a) v3.push({ ...c, id: a }); });
say(unread3 ? null : true, 'v3 lookup', `${cand3.length} pair × fee lookups at block ${block}: ${v3.length} pools exist, ${unread3} unread`);

// 4. v4: computed pool ids for the four standard keys (no hooks), checked through StateView.
const cand4 = v4Candidates([...universe], C.quotes.filter((q) => q.v4).map((q) => q.address));
const r4 = await timed('v4 lookup', () => mc(cand4.map((c) => v4Slot0Call(C.v4StateView, c.id)), tag));
const v4 = [];
let unread4 = 0;
cand4.forEach((c, i) => { const s = readV4Slot0(r4[i]); if (s === null) unread4++; else if (s) v4.push({ ...c, slot0: s }); });
say(unread4 ? null : true, 'v4 lookup', `${cand4.length} standard pool keys: ${v4.length} pools initialised, ${unread4} unread`);

// 5. State: v3 price, active liquidity and token balances; v4 active liquidity.
const st3 = await timed('v3 state', () => mc(v3.flatMap((p) => [
  { target: p.id, data: encodeCall('slot0()') },
  { target: p.id, data: encodeCall('liquidity()') },
  { target: p.t0, data: encodeCall('balanceOf(address)', [{ t: 'address', v: p.id }]) },
  { target: p.t1, data: encodeCall('balanceOf(address)', [{ t: 'address', v: p.id }]) },
]), tag));
v3.forEach((p, i) => { p.slot0 = readV3Slot0(st3[4 * i]); p.liquidity = readUint(st3[4 * i + 1]); p.bal0 = readUint(st3[4 * i + 2]); p.bal1 = readUint(st3[4 * i + 3]); });
const st4 = await timed('v4 state', () => mc(v4.map((p) => ({ target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) })), tag));
v4.forEach((p, i) => { p.liquidity = readUint(st4[i]); });
const stateUnread = v3.filter((p) => !p.slot0 || p.liquidity == null || p.bal0 == null || p.bal1 == null).length + v4.filter((p) => p.liquidity == null).length;
say(stateUnread ? null : true, 'state', `v3 pools with liquidity at the price ${v3.filter((p) => p.liquidity > 0n).length} of ${v3.length}; v4 ${v4.filter((p) => p.liquidity > 0n).length} of ${v4.length}; unread ${stateUnread}`);

// 6. Prices: quote tokens from DefiLlama (fresh and confident only), universe tokens from CoinGecko.
const usdOf = new Map();
const lj = await getJson(`https://coins.llama.fi/prices/current/${realQuotes.map((q) => `ethereum:${q.address}`).join(',')}`, {}, 20000).catch(() => null);
const llama = new Map(Object.entries(lj?.coins || {}).map(([k, v]) => [k.toLowerCase(), v]));
for (const q of C.quotes) {
  const c = llama.get(`ethereum:${q.priceAs || q.address}`);
  if (c && c.price > 0 && Date.now() / 1000 - c.timestamp < 3600 && (c.confidence ?? 1) >= 0.9) usdOf.set(q.address, c.price);
}
for (const t of tokens) if (t.usd > 0 && !usdOf.has(t.address)) usdOf.set(t.address, t.usd);
say(usdOf.size >= C.quotes.length ? true : null, 'prices', `quote tokens priced ${C.quotes.filter((q) => usdOf.has(q.address)).length} of ${C.quotes.length} (ETH $${Math.round(usdOf.get(ZERO) ?? NaN)}); universe tokens priced ${tokens.filter((t) => usdOf.has(t.address)).length} of ${tokens.length}`);

// 7. v3 TVL two ways: both sides at market prices, and the base side at the pool's own rate.
let offMarket = 0;
for (const p of v3) {
  const d0 = dec.get(p.t0), d1 = dec.get(p.t1), u0 = usdOf.get(p.t0), u1 = usdOf.get(p.t1);
  p.tvl = tvlUsd({ bal0: p.bal0, bal1: p.bal1, d0, d1, usd0: u0, usd1: u1 });
  const quoteIs = quoteSet.has(p.t1) ? 1 : quoteSet.has(p.t0) ? 0 : null;
  const atPool = baseUsdAtPool({ price: poolPrice(p.slot0?.sqrtPriceX96, d0, d1), quoteIs, quoteUsd: quoteIs === 1 ? u1 : u0 });
  p.tvlAtPool = quoteIs === 1 ? tvlUsd({ bal0: p.bal0, bal1: p.bal1, d0, d1, usd0: atPool, usd1: u1 }) : tvlUsd({ bal0: p.bal0, bal1: p.bal1, d0, d1, usd0: u0, usd1: atPool });
  const market = quoteIs === 1 ? u0 : u1;
  p.offMarket = atPool != null && market > 0 && p.liquidity > 0n ? Math.abs(atPool / market - 1) > 0.1 : null;
  if (p.offMarket) offMarket++;
}
const big3 = v3.filter((p) => p.tvl >= FLOOR);
say(true, 'v3 tvl', `${big3.length} pools ≥ ${usd(FLOOR)} holding ${usd(big3.reduce((s, p) => s + p.tvl, 0))}; ${v3.filter((p) => p.tvl == null).length} unpriced; ${offMarket} trade more than 10% off market`);

// 8. The v3 factory's own record: every pool created since 2021 (Blockscout first; where it stops,
//    the rest through RPCs), compared with the lookups for our pairs; a recent window re-read through
//    plain RPC chunks. Address only: the factory emits little besides PoolCreated.
// Log reads skip rpc.flashbots.net: it answers [] or a short list for ranges it doesn't hold, with no
// error (a diagnostic run: 243 empty and 16 short chunks of creation events). And an empty answer from
// any node counts only once a second node confirms it (lib/logs-adaptive.mjs confirmEmpty).
const LOG_RPCS = RPCS.filter((u) => !u.includes('flashbots'));
const logRpc = makeRpc(LOG_RPCS, { timeout: 30000, maxRefusals: 1000 }); // range refusals must not drop a node
const logStats = {};
const head = await rpc.call('eth_getBlockByNumber', [tag, false]);
const nowTs = head?.timestamp ? parseInt(head.timestamp, 16) : Math.floor(Date.now() / 1000);
const timeOf = (b) => nowTs - (block - b) * 12; // post-merge slots are 12 s (missed slots make this slightly late)
const ev = SKIP.has('events') ? { logs: [], complete: false, calls: 0, reason: 'skipped', reached: block } : await timed('v3 events', () => pageLogs(getJson, { base: 'https://eth.blockscout.com/api', address: C.v3Factory, fromBlock: C.v3FactoryBlock, toBlock: block, tries: 5, spacingMs: 1500 }));
const created = ev.logs.map(decodePoolCreated).filter(Boolean);
let eventsComplete = ev.complete, via = `Blockscout ${ev.calls} pages`;
if (!ev.complete && !SKIP.has('events')) {
  const rest = await timed('v3 events rpc', () => logsAdaptive(logRpc, { address: C.v3Factory, topics: [TOPICS.poolCreated] }, ev.reached, block, { step: 9000, maxStep: 9000, minStep: 500, segments: 3, retries: 3, waitMs: 3000, confirmEmpty: true, stats: logStats }));
  if (rest) {
    const seen = new Set(created.map((e) => e.id));
    for (const e of rest.map(decodePoolCreated).filter(Boolean)) if (!seen.has(e.id)) { seen.add(e.id); created.push(e); }
    eventsComplete = true;
  }
  via += ` stopped (${ev.reason}) at block ${ev.reached}; RPCs ${rest ? 'read the rest' : 'could not read the rest'}; empty answers confirmed by a second node ${logStats.emptyChecked || 0}, of which wrong ${logStats.emptyWrong || 0}`;
}
for (const e of created) if (e.time == null) e.time = timeOf(e.block);
say(eventsComplete ? true : null, 'v3 events', eventsComplete ? `${created.length} pools created since May 2021 (${via})` : `${created.length} creation events read, then INCOMPLETE (${via})`);
const candKey = new Set(cand3.map((c) => `${c.t0}:${c.t1}:${c.fee}`));
const ours = created.filter((e) => candKey.has(`${e.t0}:${e.t1}:${e.fee}`));
const byId3 = new Map(v3.map((p) => [p.id, p]));
const evIds = new Set(ours.map((e) => e.id));
const onlyEvents = ours.filter((e) => !byId3.has(e.id)).length, onlyLookups = v3.filter((p) => !evIds.has(p.id)).length;
say(eventsComplete ? onlyEvents === 0 && onlyLookups === 0 : null, 'v3 cross-check', `our pairs in the factory's events ${ours.length}, in the lookups ${v3.length}; events only ${onlyEvents}, lookups only ${onlyLookups}`);
for (const e of ours) { const p = byId3.get(e.id); if (p) { p.createdBlock = e.block; p.createdAt = e.time; } }
const WIN = 50000;
const rl = await timed('rpc window', () => rpcLogs(logRpc, { address: C.v3Factory, topics: [TOPICS.poolCreated] }, block - WIN + 1, block, 10000));
const inWin = created.filter((e) => e.block > block - WIN).length;
say(rl && eventsComplete ? rl.length === inWin : null, 'v3 events vs rpc', rl ? `last ${WIN} blocks: event list ${inWin}, plain RPC chunks ${rl.length}` : 'RPC window unread');
const fresh = v3.filter((p) => p.createdAt && nowTs - p.createdAt < 30 * 86400);
if (eventsComplete) say(true, 'v3 ages', `${fresh.length} of our pools are under 30 days old (${fresh.filter((p) => p.tvl >= FLOOR).length} of them ≥ ${usd(FLOOR)})`);
else say(null, 'v3 ages', 'unread (creation events incomplete)');

// 9. v4 pools created in the last week, any key (hooks, unusual fees): the feed for new pools.
//    A new pool counts if it holds liquidity anywhere, at the price or away from it (its
//    ModifyLiquidity events add up above zero): a pool with all of it out of range is exactly
//    the one-sided kind this scanner looks for. Fees above 1% are traps, counted and left out.
const inPair = (a, b) => (universe.has(a) || quoteSet.has(a)) && (universe.has(b) || quoteSet.has(b)) && (quoteSet.has(a) || quoteSet.has(b));
const stdIds4 = new Set(v4.map((p) => p.id));
const readV4State = async (ps) => {
  const st = await mc(ps.flatMap((p) => [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }]), tag);
  ps.forEach((p, i) => { p.slot0 = readV4Slot0(st[2 * i]) || null; p.liquidity = readUint(st[2 * i + 1]); });
};
const initLogs = await timed('v4 events', () => logsAdaptive(logRpc, { address: C.v4PoolManager, topics: [TOPICS.initialize] }, block - WIN + 1, block, { step: 9000, maxStep: 9000, minStep: 250, segments: 2, retries: 2, confirmEmpty: true }));
if (initLogs) {
  const inits = initLogs.map(decodeInitialize).filter(Boolean);
  const mine = inits.filter((e) => inPair(e.t0, e.t1));
  const ev4 = mine.filter((e) => !stdIds4.has(e.id)).map((e) => ({ v: 4, id: e.id, t0: e.t0, t1: e.t1, fee: e.fee, tickSpacing: e.tickSpacing, hooks: e.hooks, source: 'event', createdBlock: e.block, createdAt: e.time ?? timeOf(e.block) }));
  for (const e of mine) { const p = v4.find((q) => q.id === e.id); if (p) { p.createdBlock = e.block; p.createdAt = e.time ?? timeOf(e.block); } }
  const ids = ev4.filter((p) => !extremeFee(p.fee)).map((p) => p.id), net = new Map();
  let mlUnread = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const ml = await logsAdaptive(logRpc, { address: C.v4PoolManager, topics: [TOPICS.modifyLiquidity, ids.slice(i, i + 100)] }, block - WIN + 1, block, { step: 9000, maxStep: 9000, minStep: 250, retries: 2, confirmEmpty: true });
    if (!ml) { mlUnread += ids.slice(i, i + 100).length; continue; }
    for (const m of ml.map(decodeModifyLiquidity).filter(Boolean)) net.set(m.id, (net.get(m.id) || 0n) + m.liquidityDelta);
  }
  await readV4State(ev4);
  const extreme = ev4.filter((p) => extremeFee(p.fee)).length;
  const keep = ev4.filter((p) => p.slot0 && !extremeFee(p.fee) && (p.liquidity > 0n || (net.get(p.id) || 0n) > 0n));
  v4.push(...keep);
  const combos = tally(keep.map((p) => `${p.fee === DYNAMIC_FEE ? 'dynamic' : p.fee / 1e4 + '%'}/${p.tickSpacing}${p.hooks !== ZERO ? '+hook' : ''}`));
  say(mlUnread ? null : true, 'v4 events', `${inits.length} v4 pools created in the last ${WIN} blocks; ${mine.length} pair a universe token with a quote token, ${ev4.length} outside the standard keys: ${extreme} charge over 1% (left out), ${keep.length} hold liquidity (${keep.filter((p) => !(p.liquidity > 0n)).length} of them only away from the price); kept by fee/spacing: ${top(combos, 5)}${mlUnread ? `; liquidity events unread for ${mlUnread}` : ''}`);
} else say(null, 'v4 events', 'unread (not counted as zero)');

// 10. Aggregators: DexScreener for every token, GeckoTerminal for a rotating sample of tokens that
//     have a listed Uniswap pool ≥ $300k.
const scoped = (p) => p.base && p.quote && inPair(p.base, p.quote);
const ds = SKIP.has('dexscreener') ? tokens.map(() => null) : await timed('dexscreener', () => eachSpaced(tokens, 260, (t) => dexScreenerTokenPairs(getJson, 'ethereum', t.address)));
const gtTokens = (() => {
  const withBig = tokens.filter((t, i) => (ds[i] || []).some((p) => p.venue && p.reserveUsd >= FLOOR));
  const day = Math.floor(Date.now() / 86400e3), n = withBig.length, k = SKIP.has('gecko') ? 0 : Math.min(GECKO_SAMPLE, n);
  return Array.from({ length: k }, (_, j) => withBig[(day * GECKO_SAMPLE + j) % n]);
})();
const gt = await timed('geckoterminal', () => eachSpaced(gtTokens, 2400, (t) => geckoTokenPools(getJson, 'eth', t.address)));
const bigListed = (lists) => { const m = new Map(); for (const l of lists) for (const p of l || []) if (p.venue && p.reserveUsd >= FLOOR && scoped(p) && !m.has(p.id)) m.set(p.id, p); return m; };

// 11. v4 pools the aggregators list but our list still lacks: their key comes from the v4
//     PositionManager on-chain (poolKeys), and must hash back to the same pool id.
const have4 = new Set(v4.map((p) => p.id));
const want = [...new Set([...bigListed(ds).values(), ...bigListed(gt).values()].filter((p) => p.venue === 4 && !have4.has(p.id)).map((p) => p.id))];
if (want.length) {
  const keys = await mc(want.map((id) => poolKeysCall(C.v4PositionManager, id)), tag);
  let unregistered = 0, unread = 0;
  const found = [];
  want.forEach((id, i) => {
    const k = readPoolKey(keys[i], id);
    if (k === null) { unread++; return; }
    if (k === false) { unregistered++; return; }
    found.push({ v: 4, id, t0: k.currency0, t1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, source: 'aggregator' });
  });
  await readV4State(found);
  v4.push(...found.filter((p) => p.slot0));
  say(unread ? null : true, 'v4 keys', `${want.length} listed v4 pools ≥ ${usd(FLOOR)} not in our list yet: ${found.length} keys read on-chain and matched to their ids, ${unregistered} not registered with the PositionManager, ${unread} unread`);
}
const hooked = v4.filter((p) => p.hooks && p.hooks !== ZERO);
say(true, 'v4 list', `${v4.length} v4 pools: ${v4.filter((p) => !p.source).length} from standard keys, ${v4.filter((p) => p.source === 'event').length} from creation events, ${v4.filter((p) => p.source === 'aggregator').length} from listed ids; ${hooked.length} with hooks, ${v4.filter((p) => p.fee === DYNAMIC_FEE).length} with dynamic fees`);

// 12. Recall: which listed pools ≥ $300k do we have — with the standard keys alone, and now.
const stdIds = new Set([...v3.map((p) => p.id), ...v4.filter((p) => !p.source).map((p) => p.id)]);
const allIds = new Map([...v3.map((p) => [p.id, p]), ...v4.map((p) => [p.id, p])]);
function recall(name, lists, tokenCount) {
  const read = lists.filter(Boolean).length;
  if (!read) { say(null, `${name} recall`, tokenCount ? `unread (0 of ${tokenCount} tokens answered)` : 'no tokens to sample'); return null; }
  const all = new Map();
  for (const l of lists) for (const p of l || []) if (p.venue && p.reserveUsd >= FLOOR && !all.has(p.id)) all.set(p.id, p);
  const big = [...all.values()], inScope = big.filter(scoped), out = big.filter((p) => !scoped(p));
  const have = inScope.filter((p) => allIds.has(p.id)), std = inScope.filter((p) => stdIds.has(p.id));
  const miss = inScope.filter((p) => !allIds.has(p.id));
  const both = have.filter((p) => p.venue === 3 && allIds.get(p.id).tvl != null);
  const close = both.filter((p) => Math.abs(allIds.get(p.id).tvl / p.reserveUsd - 1) <= 0.15);
  say(read === tokenCount ? have.length === inScope.length : null, `${name} recall`, `${read} of ${tokenCount} tokens read; ${inScope.length} Uniswap pools ≥ ${usd(FLOOR)} in scope (v3 ${inScope.filter((p) => p.venue === 3).length}, v4 ${inScope.filter((p) => p.venue === 4).length}): we have ${have.length} (${pct(have.length, inScope.length)}; standard keys alone ${pct(std.length, inScope.length)}); missing v3 ${miss.filter((p) => p.venue === 3).length}, v4 ${miss.filter((p) => p.venue === 4).length}`);
  say(both.length ? close.length / both.length >= 0.9 : null, `${name} tvl`, `v3 TVL within 15% of theirs for ${close.length} of ${both.length} (${pct(close.length, both.length)}); median ratio ours/theirs ${both.length ? (both.map((p) => allIds.get(p.id).tvl / p.reserveUsd).sort((x, y) => x - y)[Math.floor(both.length / 2)]).toFixed(3) : '—'}`);
  say(true, `${name} scope`, `${out.length} pools ≥ ${usd(FLOOR)} pair with other quote tokens: ${top(tally(out.map((p) => p.quoteSymbol || '?')))}`);
  return { big, inScope, have };
}
const dsr = recall('dexscreener', ds, tokens.length);
recall('geckoterminal', gt, gtTokens.length);
if (dsr) {
  const dsIds = new Set(dsr.big.map((p) => p.id));
  const extra = big3.filter((p) => !dsIds.has(p.id));
  say(true, 'on-chain only', `${extra.length} of our ${big3.length} v3 pools ≥ ${usd(FLOOR)} are not in DexScreener's lists`);
} else say(null, 'on-chain only', 'unread (no DexScreener lists)');

// 12b. PancakeSwap v3 on Ethereum: the same pairs through PancakeSwap's factory (tiers 0.01/0.05/0.25/1%),
//      state and TVL at the same block, ages from the last WIN blocks of its creation events (an older
//      pool's age stays unknown), and the DexScreener lists already read. DexScreener labels PancakeSwap
//      rows without v2/v3, so its listed pairs are counted against ours, not judged.
const pcs = [];
const pcsCap = makeBudget(CHAINS.ethereum.caps.pancakeswap);
const pcsRows = (lists) => { const m = new Map(); for (const l of lists) for (const p of l || []) if (/^pancakeswap/.test(p.dex) && p.reserveUsd >= FLOOR && scoped(p) && /^0x[0-9a-f]{40}$/.test(p.id)) m.set(p.id, p); return m; };
try {
  await timed('pancakeswap', async () => {
    const pmc = makeMulticall(capRpc(rpc, pcsCap), { chunk: 400, concurrency: 3 });
    const lk = await lookupV3(pmc, tag, { factory: PANCAKE_V3.factory, fees: PANCAKE_V3.fees, tokens: [...universe], quotes: C.quotes.filter((q) => q.v3).map((q) => q.address), dex: 'pancakeswap' });
    pcs.push(...lk.pools);
    const un = await readState(pmc, tag, { v3: pcs, stateView: C.v4StateView });
    const { offMarket: off } = priceTvl(pcs, { dec, usd: usdOf, quoteSet });
    const ev = SKIP.has('events') ? null : await recentCreations(logRpc, { address: PANCAKE_V3.factory, kind: 'v3', from: block - WIN + 1, to: block, step: 9000, timeOf, budget: pcsCap });
    const aged = ev ? stampCreations(pcs, ev) : 0;
    const listed = [...pcsRows(ds).values()], ours = new Set(pcs.map((p) => p.id)), big = pcs.filter((p) => p.tvl >= FLOOR);
    say(lk.unread || un ? null : true, 'pancakeswap', `${lk.candidates} pair × fee lookups through PancakeSwap v3's factory: ${pcs.length} pools exist (${lk.unread} unread, state unread ${un}); ${big.length} ≥ ${usd(FLOOR)} holding ${usd(big.reduce((a, p) => a + p.tvl, 0))}; ${off} trade more than 10% off market; creation events in the last ${WIN} blocks ${ev ? ev.length : 'unread'} (${aged} of our pools); DexScreener lists ${listed.length} PancakeSwap pairs ≥ ${usd(FLOOR)} in scope, ${listed.filter((p) => ours.has(p.id)).length} of them in our v3 list (the rest v2 or other pairs); reads ${pcsCap.note()}`);
  });
} catch (e) { say(null, 'pancakeswap', `broke (${String(e?.message || e).replace(/[^A-Za-z ]/g, '').slice(0, 40)}); left out this run`); pcs.length = 0; }

// 13. The list itself stays on the runner for the next steps (public data, nothing committed yet),
//     with what the aggregators said about each pool for later cross-checks.
const aggOf = (lists) => {
  const agg = new Map();
  for (const l of lists) for (const p of l || []) {
    const a = agg.get(p.id) || { reserveUsd: null, volumeUsd24h: null };
    if (p.reserveUsd != null) a.reserveUsd = Math.max(a.reserveUsd ?? 0, p.reserveUsd);
    if (p.volumeUsd24h != null) a.volumeUsd24h = Math.max(a.volumeUsd24h ?? 0, p.volumeUsd24h);
    agg.set(p.id, a);
  }
  return agg;
};
const agg = aggOf([...ds, ...gt]);
for (const p of [...v3, ...v4, ...pcs]) { const a = agg.get(p.id); p.aggReserveUsd = a?.reserveUsd ?? null; p.aggVolumeUsd24h = a?.volumeUsd24h ?? null; }
fs.mkdirSync('out', { recursive: true });
const big = (x) => (typeof x === 'bigint' ? x.toString() : x);
const symOf = new Map([...C.quotes.map((q) => [q.address, q.symbol]), ...tokens.map((t) => [t.address, t.symbol])]); // public tickers, for pair labels
const rankOf = new Map(tokens.map((t) => [t.address, t.rank ?? null]));
// Each universe token's first Uniswap v3 pool (any pair): how long it has traded there. Only from a complete event record.
const firstPoolAt = new Map();
if (eventsComplete) for (const e of created) for (const a of [e.t0, e.t1]) if (universe.has(a) && e.time != null && !(firstPoolAt.get(a) <= e.time)) firstPoolAt.set(a, e.time);
// CoinGecko ids (for the exchange tickers, lib/cex.mjs); a quote token's is the coin the exchanges trade
const QUOTE_COIN = { WETH: 'ethereum', ETH: 'ethereum', USDC: 'usd-coin', USDT: 'tether', DAI: 'dai', WBTC: 'bitcoin', cbBTC: 'bitcoin' };
const coinOf = new Map([...C.quotes.map((q) => [q.address, QUOTE_COIN[q.symbol] ?? null]), ...tokens.map((t) => [t.address, t.id ?? null])]);
fs.writeFileSync('out/pools-ethereum.json', JSON.stringify({
  t: Date.now(), chain: 'ethereum', block, v3: [...v3.map((p) => ({ ...p, dex: 'uniswap' })), ...pcs], v4: v4.map((p) => ({ ...p, dex: 'uniswap' })),
  v3EventsComplete: eventsComplete, v4EventsFrom: block - WIN + 1, pcsEventsFrom: block - WIN + 1,
  tokens: [...dec].map(([address, decimals]) => ({ address, decimals, symbol: symOf.get(address) ?? null, usd: usdOf.get(address) ?? null, quote: quoteSet.has(address), rank: rankOf.get(address) ?? null, firstPoolAt: firstPoolAt.get(address) ?? null, cg: coinOf.get(address) ?? null })),
}, (k, v) => big(v)));

// 14. Base: Uniswap v3 and v4 and PancakeSwap v3, the same method on Base's own nodes and contracts. A broken
//     Base read never costs the Ethereum list: it is reported and the Base list is left as it was.
if (!chainOn('base')) say(null, 'base', 'switched off for this run (CHAINS_OFF): the Base list is not rewritten');
else try {
  await timed('base', () => discoverBase());
} catch (e) { say(null, 'base', `broke (${String(e?.message || e).replace(/[^A-Za-z ]/g, '').slice(0, 40)}); the Base list is not rewritten this run`); }

async function discoverBase() {
  const B = CHAINS.base, BC = B.c, CAP = B.caps;
  // the caps (lib/chains.mjs): the whole discovery's time backstop, and each part's own time and calls within it
  const all = makeBudget(CAP.list);
  const part = (c) => makeBudget({ ms: Math.min(c.ms ?? Infinity, all.left()), calls: c.calls });
  const brpc = capRpc(makeRpc(B.rpcs, { timeout: 25000, maxRefusals: 4 }), all), bmc = makeMulticall(brpc, { chunk: 400, concurrency: 3 });
  const btag = await brpc.call('eth_blockNumber', []);
  if (btag == null) { say(null, 'base block', 'no block number'); return; }
  const bblock = parseInt(btag, 16), bq = new Set(BC.quotes.map((q) => q.address));
  const bu = buildUniverse(cg.markets, cg.list, { platform: 'base', exclude: [...bq] });
  const realQ = BC.quotes.filter((q) => q.address !== ZERO);
  const d = await bmc([...bu.tokens, ...realQ].map((t) => ({ target: t.address, data: encodeCall('decimals()') })), btag);
  bu.tokens.forEach((t, i) => { const x = readUint(d[i]); t.decimals = x != null && x <= 36n ? Number(x) : null; });
  const qOk = realQ.every((q, i) => readUint(d[bu.tokens.length + i]) === BigInt(q.decimals));
  // best-ranked first: a capped read (DexScreener) covers the coins that matter most
  const btoks = bu.tokens.filter((t) => t.decimals != null).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  say(qOk ? true : null, 'base universe', `${bu.counts.ranked} coins ranked 100–2000; ${bu.counts.onChain} have a Base token; ${btoks.length} answer decimals(); quote token decimals match the constants: ${qOk ? 'yes' : 'no'}`);
  const bdec = new Map([...BC.quotes.map((q) => [q.address, q.decimals]), ...btoks.map((t) => [t.address, t.decimals])]);
  const buniv = new Set(btoks.map((t) => t.address)), q3 = BC.quotes.filter((q) => q.v3).map((q) => q.address), q4 = BC.quotes.filter((q) => q.v4).map((q) => q.address);
  const u3 = await lookupV3(bmc, btag, { factory: BC.v3Factory, fees: V3_FEES, tokens: [...buniv], quotes: q3, dex: 'uniswap' });
  const p3 = await lookupV3(bmc, btag, { factory: PANCAKE_V3.factory, fees: PANCAKE_V3.fees, tokens: [...buniv], quotes: q3, dex: 'pancakeswap' });
  const u4 = await lookupV4(bmc, btag, { stateView: BC.v4StateView, tokens: [...buniv], quotes: q4 });
  const bv3 = [...u3.pools, ...p3.pools], bv4 = u4.pools;
  const un = await readState(bmc, btag, { v3: bv3, v4: bv4, stateView: BC.v4StateView });
  const lookUnread = u3.unread + p3.unread + u4.unread;
  say(lookUnread || un ? null : true, 'base lookups', `at block ${bblock}: Uniswap v3 ${u3.candidates} pair × fee lookups, ${u3.pools.length} pools exist; PancakeSwap v3 ${p3.candidates}, ${p3.pools.length}; Uniswap v4 ${u4.candidates} standard keys, ${u4.pools.length} initialised; unread: ${lookUnread} lookups, ${un} pool states`);
  // prices: quote tokens from DefiLlama (fresh and confident only), universe tokens from CoinGecko
  const busd = new Map();
  const lj = await getJson(`https://coins.llama.fi/prices/current/${realQ.map((q) => `base:${q.address}`).join(',')}`, {}, 20000).catch(() => null);
  const llama = new Map(Object.entries(lj?.coins || {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const q of BC.quotes) {
    const c = llama.get(`base:${q.priceAs || q.address}`);
    if (c && c.price > 0 && Date.now() / 1000 - c.timestamp < 3600 && (c.confidence ?? 1) >= 0.9) busd.set(q.address, c.price);
  }
  for (const t of btoks) if (t.usd > 0 && !busd.has(t.address)) busd.set(t.address, t.usd);
  const { offMarket: off } = priceTvl(bv3, { dec: bdec, usd: busd, quoteSet: bq });
  const bigU = u3.pools.filter((p) => p.tvl >= FLOOR), bigP = p3.pools.filter((p) => p.tvl >= FLOOR);
  say(BC.quotes.every((q) => busd.has(q.address)) ? true : null, 'base tvl', `quote tokens priced ${BC.quotes.filter((q) => busd.has(q.address)).length} of ${BC.quotes.length} (ETH $${Math.round(busd.get(ZERO) ?? NaN)}); universe tokens priced ${btoks.filter((t) => busd.has(t.address)).length} of ${btoks.length}; pools ≥ ${usd(FLOOR)}: Uniswap v3 ${bigU.length} holding ${usd(bigU.reduce((a, p) => a + p.tvl, 0))}, PancakeSwap v3 ${bigP.length} holding ${usd(bigP.reduce((a, p) => a + p.tvl, 0))}; ${bv3.filter((p) => p.tvl == null).length} unpriced; ${off} trade more than 10% off market`);
  // creation events of the last 72 hours: the young pools' ages (and the feed for new v4 pools with any key);
  // the three emitters side by side, each within a third of the events cap (an emitter cut short is unread)
  const from = bblock - blocksBack(B, { block: bblock, nowSec: timeOfBlock(B, bblock), secBack: 3 * 86400 }) + 1;
  const blogRpc = makeRpc(B.rpcs.filter((u) => !B.noLogs.some((x) => u.includes(x))), { timeout: 30000, maxRefusals: 1000 });
  const timeOfB = (b) => Math.round(timeOfBlock(B, b));
  const evCaps = [0, 1, 2].map(() => part({ ms: CAP.events.ms, calls: Math.floor(CAP.events.calls / 3) }));
  const evOpt = { from, to: bblock, step: B.logMax, minStep: 1000, timeOf: timeOfB, confirmEmpty: B.confirmEmpty };
  const [evU, evP, evV] = await timed('base events', () => Promise.all([
    recentCreations(blogRpc, { address: BC.v3Factory, kind: 'v3', ...evOpt, budget: evCaps[0] }),
    recentCreations(blogRpc, { address: PANCAKE_V3.factory, kind: 'v3', ...evOpt, budget: evCaps[1] }),
    recentCreations(blogRpc, { address: BC.v4PoolManager, kind: 'v4', ...evOpt, budget: evCaps[2] }),
  ]));
  const agedU = evU ? stampCreations(u3.pools, evU) : 0, agedP = evP ? stampCreations(p3.pools, evP) : 0;
  if (evV) stampCreations(bv4, evV);
  // v4 pools of the window outside the standard keys: a universe token with a quote token, fee ≤ 1%, holding liquidity
  const inPairB = (a, b) => (buniv.has(a) || bq.has(a)) && (buniv.has(b) || bq.has(b)) && (bq.has(a) || bq.has(b));
  const std4 = new Set(bv4.map((p) => p.id));
  let keep4 = [], mlUnread = 0, mine4 = 0;
  const mlCap = part(CAP.liquidity);
  if (evV) await timed('base liquidity events', async () => {
    const mine = evV.filter((e) => inPairB(e.t0, e.t1)), ev4 = mine.filter((e) => !std4.has(e.id) && !extremeFee(e.fee));
    mine4 = mine.length;
    // a pool whose liquidity events stay unread (the cap) is kept only with liquidity at the price
    const net = new Map(), ids = ev4.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 100) {
      const ml = mlCap.over() ? null : await logsAdaptive(blogRpc, { address: BC.v4PoolManager, topics: [TOPICS.modifyLiquidity, ids.slice(i, i + 100)] }, from, bblock, { step: B.logMax, maxStep: B.logMax, minStep: 1000, segments: 4, retries: 2, confirmEmpty: B.confirmEmpty, budget: mlCap });
      if (!ml) { mlUnread += ids.slice(i, i + 100).length; continue; }
      for (const m of ml.map(decodeModifyLiquidity).filter(Boolean)) net.set(m.id, (net.get(m.id) || 0n) + m.liquidityDelta);
    }
    const fresh4 = ev4.map((e) => ({ v: 4, dex: 'uniswap', id: e.id, t0: e.t0, t1: e.t1, fee: e.fee, tickSpacing: e.tickSpacing, hooks: e.hooks, source: 'event', createdBlock: e.block, createdAt: e.time }));
    await readState(bmc, btag, { v4: fresh4, stateView: BC.v4StateView });
    keep4 = fresh4.filter((p) => p.slot0 && (p.liquidity > 0n || (net.get(p.id) || 0n) > 0n));
    bv4.push(...keep4);
  });
  say(evU && evP && evV && !mlUnread ? true : null, 'base events', `last 72 hours (${bblock - from + 1} blocks): Uniswap v3 ${evU ? evU.length : 'unread'} pools created (${agedU} of ours), PancakeSwap v3 ${evP ? evP.length : 'unread'} (${agedP} of ours), Uniswap v4 ${evV ? evV.length : 'unread'} (${mine4} pair a universe token with a quote token; ${keep4.length} outside the standard keys hold liquidity${mlUnread ? `; liquidity events unread for ${mlUnread}` : ''})`);
  // DexScreener for every Base token, best-ranked first: the cross-check, and listed v4 pools our keys missed
  const dsCap = part(CAP.dexscreener), dsGet = capGetJson(getJson, dsCap);
  const bds = SKIP.has('dexscreener') ? btoks.map(() => null) : await timed('base dexscreener', () => eachSpaced(btoks, 260, (t) => dexScreenerTokenPairs(dsGet, 'base', t.address), { budget: dsCap }));
  const scopedB = (p) => p.base && p.quote && inPairB(p.base, p.quote);
  const listedB = new Map();
  for (const l of bds) for (const p of l || []) if (p.venue && p.reserveUsd >= FLOOR && scopedB(p) && !listedB.has(p.id)) listedB.set(p.id, p);
  const have4 = new Set(bv4.map((p) => p.id)), want = [...listedB.values()].filter((p) => p.venue === 4 && !have4.has(p.id)).map((p) => p.id);
  let keyFound = 0;
  if (want.length) {
    const keys = await bmc(want.map((id) => poolKeysCall(BC.v4PositionManager, id)), btag);
    const found = [];
    want.forEach((id, i) => { const k = readPoolKey(keys[i], id); if (k) found.push({ v: 4, dex: 'uniswap', id, t0: k.currency0, t1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, source: 'aggregator' }); });
    await readState(bmc, btag, { v4: found, stateView: BC.v4StateView });
    const ok = found.filter((p) => p.slot0);
    bv4.push(...ok);
    keyFound = ok.length;
  }
  const allB = new Map([...bv3, ...bv4].map((p) => [p.id, p]));
  const inScope = [...listedB.values()], haveB = inScope.filter((p) => allB.has(p.id));
  const pcsListed = [...pcsRows(bds).values()].filter((p) => scopedB(p));
  const readB = bds.filter(Boolean).length;
  say(readB ? haveB.length >= 0.9 * inScope.length : null, 'base recall', `DexScreener: ${readB} of ${btoks.length} tokens read; ${inScope.length} Uniswap pools ≥ ${usd(FLOOR)} in scope (v3 ${inScope.filter((p) => p.venue === 3).length}, v4 ${inScope.filter((p) => p.venue === 4).length}): we have ${haveB.length} (${pct(haveB.length, inScope.length)}), ${keyFound} v4 keys read from the PositionManager; PancakeSwap pairs ≥ ${usd(FLOOR)} listed ${pcsListed.length}, in our v3 list ${pcsListed.filter((p) => allB.has(p.id)).length}`);
  const caps = [['events: Uniswap v3', evCaps[0]], ['PancakeSwap v3', evCaps[1]], ['Uniswap v4', evCaps[2]], ['liquidity events', mlCap], ['DexScreener', dsCap], ['the whole list', all]];
  const hit = caps.filter(([, b]) => b.why());
  say(hit.length ? null : true, 'base caps', `${caps.map(([k, b]) => `${k} ${b.note()}`).join('; ')}${hit.length ? ` — what a cap stopped is unread (null) this run: ${hit.map(([k]) => k).join(', ')}` : ''}`);
  const bagg = aggOf(bds);
  for (const p of [...bv3, ...bv4]) { const a = bagg.get(p.id); p.aggReserveUsd = a?.reserveUsd ?? null; p.aggVolumeUsd24h = a?.volumeUsd24h ?? null; }
  // each token's first trading day: Ethereum's record for the same coin, or the oldest pair DexScreener lists on Base
  const ethFirstByCoin = new Map(tokens.map((t) => [t.id, firstPoolAt.get(t.address) ?? null]));
  const bsym = new Map([...BC.quotes.map((q) => [q.address, q.symbol]), ...btoks.map((t) => [t.address, t.symbol])]);
  const bcoin = new Map([...BC.quotes.map((q) => [q.address, QUOTE_COIN[q.symbol] ?? null]), ...btoks.map((t) => [t.address, t.id ?? null])]);
  const bfirst = new Map(btoks.map((t, i) => [t.address, firstTradedAt({ dsPairs: bds[i], ethFirst: ethFirstByCoin.get(t.id) })]));
  const brank = new Map(btoks.map((t) => [t.address, t.rank ?? null]));
  fs.writeFileSync('out/pools-base.json', JSON.stringify({
    t: Date.now(), chain: 'base', block: bblock, v3: bv3, v4: bv4, v3EventsComplete: false, eventsFrom: from,
    tokens: [...bdec].map(([address, decimals]) => ({ address, decimals, symbol: bsym.get(address) ?? null, usd: busd.get(address) ?? null, quote: bq.has(address), rank: brank.get(address) ?? null, firstPoolAt: bfirst.get(address) ?? null, cg: bcoin.get(address) ?? null })),
  }, (k, v) => big(v)));
}

const ok = !unread3 && !unread4 && quotesRight;
finish(ok && !(eventsComplete && (onlyEvents || onlyLookups)) ? 0 : 1);
