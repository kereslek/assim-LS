// Phase 0, step 2: the pool list for Ethereum. Universe (CoinGecko ranks 100–2000 with an Ethereum
// token, plus the UNI benchmark) × quote tokens × fee tiers, looked up on-chain for Uniswap v3 and v4
// at one block; plus v4 pools with any key from the last week's creation events and, for pools the
// aggregators list, keys read from the v4 PositionManager. Checked three ways: the v3 factory's own
// creation events, a recent window re-read through plain RPC chunks, and GeckoTerminal + DexScreener
// for pools of at least $300k.
// Public market data only: the log shows counts, ratios, dates, venue names and quote symbols, never an address.
import fs from 'node:fs';
import { makeRpc, getJson } from '../lib/rpc.mjs';
import { makeMulticall } from '../lib/multicall.mjs';
import { encodeCall } from '../lib/abi.mjs';
import {
  ETHEREUM as C, ZERO, TOPICS, DYNAMIC_FEE, v3Candidates, v4Candidates, getPoolCall, v4Slot0Call, readGetPool, readV4Slot0,
  readV3Slot0, readUint, decodePoolCreated, decodeInitialize, poolPrice, tvlUsd, baseUsdAtPool, poolKeysCall, readPoolKey,
} from '../lib/pools.mjs';
import { buildUniverse, fetchCoinGecko } from '../lib/universe.mjs';
import { geckoTokenPools, dexScreenerTokenPairs, eachSpaced } from '../lib/aggregators.mjs';
import { pageLogs, rpcLogs } from '../lib/logs.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';

const FLOOR = 300_000;
const GECKO_SAMPLE = 40;
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
const logRpc = makeRpc(RPCS, { timeout: 30000, maxRefusals: 1000 }); // range refusals must not drop a node
const head = await rpc.call('eth_getBlockByNumber', [tag, false]);
const nowTs = head?.timestamp ? parseInt(head.timestamp, 16) : Math.floor(Date.now() / 1000);
const timeOf = (b) => nowTs - (block - b) * 12; // post-merge slots are 12 s (missed slots make this slightly late)
const ev = await timed('v3 events', () => pageLogs(getJson, { base: 'https://eth.blockscout.com/api', address: C.v3Factory, fromBlock: C.v3FactoryBlock, toBlock: block, tries: 5, spacingMs: 1500 }));
const created = ev.logs.map(decodePoolCreated).filter(Boolean);
let eventsComplete = ev.complete, via = `Blockscout ${ev.calls} pages`;
if (!ev.complete) {
  const rest = await timed('v3 events rpc', () => logsAdaptive(logRpc, { address: C.v3Factory, topics: [TOPICS.poolCreated] }, ev.reached, block, { step: 9000, maxStep: 9000, minStep: 500, segments: 8 }));
  if (rest) {
    const seen = new Set(created.map((e) => e.id));
    for (const e of rest.map(decodePoolCreated).filter(Boolean)) if (!seen.has(e.id)) { seen.add(e.id); created.push(e); }
    eventsComplete = true;
  }
  via += ` stopped (${ev.reason}) at block ${ev.reached}; RPCs ${rest ? 'read the rest' : 'could not read the rest'}`;
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
const rl = await timed('rpc window', () => rpcLogs(rpc, { address: C.v3Factory, topics: [TOPICS.poolCreated] }, block - WIN + 1, block, 10000));
const inWin = created.filter((e) => e.block > block - WIN).length;
say(rl && eventsComplete ? rl.length === inWin : null, 'v3 events vs rpc', rl ? `last ${WIN} blocks: event list ${inWin}, plain RPC chunks ${rl.length}` : 'RPC window unread');
const fresh = v3.filter((p) => p.createdAt && nowTs - p.createdAt < 30 * 86400);
if (eventsComplete) say(true, 'v3 ages', `${fresh.length} of our pools are under 30 days old (${fresh.filter((p) => p.tvl >= FLOOR).length} of them ≥ ${usd(FLOOR)})`);
else say(null, 'v3 ages', 'unread (creation events incomplete)');

// 9. v4 pools created in the last week, any key (hooks, unusual fees): the feed for new pools.
const inPair = (a, b) => (universe.has(a) || quoteSet.has(a)) && (universe.has(b) || quoteSet.has(b)) && (quoteSet.has(a) || quoteSet.has(b));
const byId4 = new Map(v4.map((p) => [p.id, p]));
const added4 = [];
const initLogs = await timed('v4 events', () => logsAdaptive(logRpc, { address: C.v4PoolManager, topics: [TOPICS.initialize] }, block - WIN + 1, block, { step: 9000, maxStep: 9000, minStep: 250, segments: 2 }));
if (initLogs) {
  const inits = initLogs.map(decodeInitialize).filter(Boolean);
  const mine = inits.filter((e) => inPair(e.t0, e.t1));
  for (const e of mine) if (!byId4.has(e.id)) { const p = { v: 4, id: e.id, t0: e.t0, t1: e.t1, fee: e.fee, tickSpacing: e.tickSpacing, hooks: e.hooks, source: 'event', createdBlock: e.block, createdAt: e.time ?? timeOf(e.block) }; byId4.set(e.id, p); added4.push(p); }
  for (const e of mine) { const p = byId4.get(e.id); if (p && p.createdBlock == null) { p.createdBlock = e.block; p.createdAt = e.time ?? timeOf(e.block); } }
  say(true, 'v4 events', `${inits.length} v4 pools created in the last ${WIN} blocks; ${mine.length} pair a universe token with a quote token (${mine.filter((e) => e.hooks !== ZERO).length} with hooks); ${added4.length} are outside the standard keys`);
} else say(null, 'v4 events', 'unread (not counted as zero)');

// 10. Aggregators: DexScreener for every token, GeckoTerminal for a rotating sample of tokens that
//     have a listed Uniswap pool ≥ $300k.
const scoped = (p) => p.base && p.quote && inPair(p.base, p.quote);
const ds = await timed('dexscreener', () => eachSpaced(tokens, 260, (t) => dexScreenerTokenPairs(getJson, 'ethereum', t.address)));
const gtTokens = (() => {
  const withBig = tokens.filter((t, i) => (ds[i] || []).some((p) => p.venue && p.reserveUsd >= FLOOR));
  const day = Math.floor(Date.now() / 86400e3), n = withBig.length, k = Math.min(GECKO_SAMPLE, n);
  return Array.from({ length: k }, (_, j) => withBig[(day * GECKO_SAMPLE + j) % n]);
})();
const gt = await timed('geckoterminal', () => eachSpaced(gtTokens, 2400, (t) => geckoTokenPools(getJson, 'eth', t.address)));
const bigListed = (lists) => { const m = new Map(); for (const l of lists) for (const p of l || []) if (p.venue && p.reserveUsd >= FLOOR && scoped(p) && !m.has(p.id)) m.set(p.id, p); return m; };

// 11. v4 pools the aggregators list but our lookups missed: their key comes from the v4
//     PositionManager on-chain (poolKeys), and must hash back to the same pool id.
const want = [...new Set([...bigListed(ds).values(), ...bigListed(gt).values()].filter((p) => p.venue === 4 && !byId4.has(p.id)).map((p) => p.id))];
if (want.length) {
  const keys = await mc(want.map((id) => poolKeysCall(C.v4PositionManager, id)), tag);
  let resolved = 0, unregistered = 0, unread = 0;
  want.forEach((id, i) => {
    const k = readPoolKey(keys[i], id);
    if (k === null) { unread++; return; }
    if (k === false) { unregistered++; return; }
    resolved++;
    const p = { v: 4, id, t0: k.currency0, t1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, source: 'aggregator' };
    byId4.set(id, p); added4.push(p);
  });
  say(unread ? null : true, 'v4 keys', `${want.length} listed v4 pools ≥ ${usd(FLOOR)} outside our lookups: ${resolved} keys read on-chain and matched to their ids, ${unregistered} not registered with the PositionManager, ${unread} unread`);
}
if (added4.length) {
  const st = await mc(added4.flatMap((p) => [v4Slot0Call(C.v4StateView, p.id), { target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }]), tag);
  added4.forEach((p, i) => { p.slot0 = readV4Slot0(st[2 * i]) || null; p.liquidity = readUint(st[2 * i + 1]); });
  // an empty new pool is counted, not listed: it has no liquidity to map and no fees to share
  const ev4 = added4.filter((p) => p.source === 'event'), live4 = ev4.filter((p) => p.slot0 && p.liquidity > 0n);
  const combos = tally(ev4.map((p) => `${p.fee / 1e4}%/${p.tickSpacing}${p.hooks !== ZERO ? '+hook' : ''}`));
  if (ev4.length) say(true, 'v4 new keys', `${ev4.length} new v4 pools outside the standard keys: ${live4.length} hold liquidity; most common fee/spacing: ${top(combos, 5)}`);
  v4.push(...added4.filter((p) => p.slot0 && (p.source === 'aggregator' || p.liquidity > 0n)));
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

// 13. The list itself stays on the runner for the next steps (public data, nothing committed yet),
//     with what the aggregators said about each pool for later cross-checks.
const agg = new Map();
for (const l of [...ds, ...gt]) for (const p of l || []) {
  const a = agg.get(p.id) || { reserveUsd: null, volumeUsd24h: null };
  if (p.reserveUsd != null) a.reserveUsd = Math.max(a.reserveUsd ?? 0, p.reserveUsd);
  if (p.volumeUsd24h != null) a.volumeUsd24h = Math.max(a.volumeUsd24h ?? 0, p.volumeUsd24h);
  agg.set(p.id, a);
}
for (const p of [...v3, ...v4]) { const a = agg.get(p.id); p.aggReserveUsd = a?.reserveUsd ?? null; p.aggVolumeUsd24h = a?.volumeUsd24h ?? null; }
fs.mkdirSync('out', { recursive: true });
const big = (x) => (typeof x === 'bigint' ? x.toString() : x);
fs.writeFileSync('out/pools-ethereum.json', JSON.stringify({
  t: Date.now(), block, v3, v4,
  tokens: [...dec].map(([address, decimals]) => ({ address, decimals, usd: usdOf.get(address) ?? null, quote: quoteSet.has(address) })),
}, (k, v) => big(v)));
const ok = !unread3 && !unread4 && quotesRight;
finish(ok && !(eventsComplete && (onlyEvents || onlyLookups)) ? 0 : 1);
