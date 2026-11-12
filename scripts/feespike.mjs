// Fee-spike diagnostic (run in GitHub Actions only: it opens the sealed data with the scanner's own lock).
// For one pool named by public market terms (SPIKE_POOL="UNI/WETH 0.01 ethereum 3") and, as a scan, for every
// pool, it finds the days whose LP fees are 20× the 30-day median or more (lib/spikes.mjs) in history.json's
// daily rows (d) and fee history (y), and for the worst ones re-checks the rows they come from at archive nodes.
// The public log gets ONLY: each suspicious day's date, its ratio to the 30-day median, the row's span in hours,
// where its two rows came from (a pass, or a block's own time: backfill or past map) and whether their block
// timestamps and state re-read the same, the day's swap count, and ratios between the counters' fees and the
// swaps' own. Never an amount, an id, an address or a block number. Errors print as a category only.
import fs from 'node:fs';
import { openStore } from '../lib/store.mjs';
import { parseStore } from '../lib/snapshots.mjs';
import { CHAINS } from '../lib/chains.mjs';
import { makeRpc, mapLimit, getJson } from '../lib/rpc.mjs';
import { encodeCall, decodeWords } from '../lib/abi.mjs';
import { feeGrowthCalls } from '../lib/maps.mjs';
import { decodeSwap, decodeExtra, SWAP_TOPICS, EXTRA_TOPICS } from '../lib/swaps.mjs';
import { deltaFg } from '../lib/windows.mjs';
import { rowRates, spikes } from '../lib/spikes.mjs';

const out = [], pub = console.log.bind(console);
// only this script's own lines reach the public log: anything a library prints is dropped
for (const m of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table']) console[m] = () => {};
const say = (msg) => { out.push(msg); pub(msg); };
const done = (code = 0) => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### fee spikes\n\n' + out.map((l) => `- ${l}`).join('\n') + '\n');
  process.exit(code);
};
const cat = (e) => (String(e?.message || e).match(/^[A-Za-z ]+/) || ['error'])[0].trim().split(/\s+/).slice(0, 3).join(' ').slice(0, 30);
process.on('unhandledRejection', (e) => { say(`error: ${cat(e)}`); done(1); });
process.on('uncaughtException', (e) => { say(`error: ${cat(e)}`); done(1); });

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const DAY = 86400e3;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const bar = (s) => day(s.t - s.span); // the page labels a bar by its interval's start
const r1 = (x) => (isNum(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)) : '—');
const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const hex = (n) => '0x' + n.toString(16);

const store = openStore();
const live = store.get('live.json'), hist = store.get('history.json'), snapO = store.get('snapshots.json');
if (!live || !hist || !snapO) { say(`data: live ${!!live}, history ${!!hist}, snapshots ${!!snapO}: nothing to check`); done(1); }
const snaps = parseStore(snapO);
const meta = new Map((live.pools || []).map((p) => [p.id, p]));
say(`data: ${Object.keys(hist.pools || {}).length} pools in history, ${snaps.size} in the snapshot store, ${meta.size} scored; history written ${day(hist.t)} ${new Date(hist.t).toISOString().slice(11, 16)} UTC; snapshot fix ${snapO.fix ?? 'none'}`);

// the target: pair (either order), fee tier, chain, version, from public terms
const [pairQ, feeQ, chainQ, vQ] = String(process.env.SPIKE_POOL || 'UNI/WETH 0.01 ethereum 3').trim().split(/\s+/);
const syms = pairQ.toUpperCase().split('/');
const isTarget = (p) => p && String(p.chain) === chainQ && String(p.v) === vQ && Math.abs((p.feeTier ?? -1) - Number(feeQ)) < 1e-9
  && (p.dex ?? 'uniswap') === 'uniswap' && [p.t0?.sym, p.t1?.sym].map((s) => String(s).toUpperCase()).sort().join('/') === [...syms].sort().join('/');
const targets = [...meta.values()].filter(isTarget).map((p) => p.id);
say(`target: ${pairQ} ${Number(feeQ) * 100}% ${chainQ} v${vQ}: ${targets.length} pool(s) matched`);

// ---- the scan: every pool's d rows and exact y rows ----------------------------------------------------
const label = new Map();
let n = 0;
for (const id of Object.keys(hist.pools || {})) label.set(id, targets.includes(id) ? 'target' : `pool ${++n}`);
const found = [];
const scan = { d: { pools: 0, days: 0, gap: 0 }, y: { pools: 0, days: 0 } };
for (const [id, h] of Object.entries(hist.pools || {})) {
  const ds = spikes(rowRates((h.d || []).map((r) => [r[0], r[2]])));
  if (ds.length) scan.d.pools++;
  for (const s of ds) { scan.d.days++; if (s.span > 28 * 3600e3) scan.d.gap++; found.push({ id, tier: 'd', ...s }); }
  // y: one row a day, fees for that day (exact only)
  const yx = (h.y || []).filter((r) => r[2] === 'x');
  const ys = spikes(yx.map((r) => ({ t: r[0], span: DAY, rate: r[1] })));
  if (ys.length) scan.y.pools++;
  for (const s of ys) { scan.y.days++; found.push({ id, tier: 'y', ...s }); }
}
say(`scan d (90-day chart): ${scan.d.days} days ≥ 20× their 30-day median in ${scan.d.pools} pools; ${scan.d.gap} of them rows spanning over 28 h`);
say(`scan y (fee history, exact days): ${scan.y.days} days ≥ 20× in ${scan.y.pools} pools`);
const dist = (xs) => { const b = { '20-50×': 0, '50-200×': 0, '200×+': 0 }; for (const x of xs) b[x.ratio < 50 ? '20-50×' : x.ratio < 200 ? '50-200×' : '200×+']++; return Object.entries(b).map(([k, v]) => `${k} ${v}`).join(', '); };
say(`scan ratios d: ${dist(found.filter((x) => x.tier === 'd'))}; y: ${dist(found.filter((x) => x.tier === 'y'))}`);
const byDay = new Map();
for (const x of found.filter((x) => x.tier === 'd')) byDay.set(bar(x), (byDay.get(bar(x)) || 0) + 1);
say(`scan d by date (days with 2+ pools): ${[...byDay].filter(([, v]) => v >= 2).sort().map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);

// the target's own worst days, flagged or not
for (const id of targets) {
  const h = hist.pools[id];
  const rr = rowRates((h?.d || []).map((r) => [r[0], r[2]]));
  const sp = spikes(rr, { k: 0 }).sort((a, b) => b.ratio - a.ratio).slice(0, 5);
  say(`target d rows: ${h?.d?.length ?? 0}, read ${rr.filter((r) => isNum(r.rate)).length}; spans over 28 h ${rr.filter((r) => r.span > 28 * 3600e3).length}; worst days: ${sp.map((s) => `${bar(s)} ${r1(s.ratio)}× (span ${r1(s.span / 3600e3)} h)`).join(', ')}`);
  const yx = (h?.y || []).filter((r) => r[2] === 'x');
  const ys = spikes(yx.map((r) => ({ t: r[0], span: DAY, rate: r[1] })), { k: 0 }).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
  say(`target y: ${h?.y?.length ?? 0} rows (${yx.length} exact); worst exact days: ${ys.map((s) => `${day(s.t)} ${r1(s.ratio)}×`).join(', ') || 'none'}`);
  for (const s of sp.filter((x) => x.ratio >= 5)) if (!found.some((f) => f.id === id && f.tier === 'd' && f.t === s.t)) found.push({ id, tier: 'd', ...s });
}

// ---- the deep check of the worst rows: their two raw rows at archive nodes -----------------------------
const pick = [...found.filter((x) => x.tier === 'd' && targets.includes(x.id)), ...found.filter((x) => x.tier === 'd' && !targets.includes(x.id)).sort((a, b) => b.ratio - a.ratio).slice(0, 8)];
const rpcs = new Map();
const rpcOf = (ch) => rpcs.get(ch) || rpcs.set(ch, makeRpc(CHAINS[ch].archive, { timeout: 25000, maxRefusals: 6 })).get(ch);
const logRpcOf = (ch) => rpcs.get(ch + ':logs') || rpcs.set(ch + ':logs', makeRpc(CHAINS[ch].rpcs.filter((u) => !CHAINS[ch].noLogs.some((x) => u.includes(x))), { timeout: 30000, maxRefusals: 6 })).get(ch + ':logs');
const word = (r) => { const w = typeof r === 'string' ? decodeWords(r) : null; return w && w.length ? w : null; };

async function stateAt(p, block) {
  const C = CHAINS[p.chain].c, rpc = rpcOf(p.chain), tag = hex(block);
  const calls = p.v === 3 ? [{ target: p.id, data: encodeCall('liquidity()') }, ...feeGrowthCalls(p, C.v4StateView)]
    : [{ target: C.v4StateView, data: encodeCall('getLiquidity(bytes32)', [{ t: 'bytes32', v: p.id }]) }, ...feeGrowthCalls(p, C.v4StateView)];
  const ans = await Promise.all(calls.map((c) => rpc.call('eth_call', [{ to: c.target, data: c.data }, tag])));
  const w = ans.map(word);
  if (!w[0]) return null;
  return p.v === 3 ? (w[1] && w[2] ? { L: w[0][0], fg0: w[1][0], fg1: w[2][0] } : null) : (w[1]?.length >= 2 ? { L: w[0][0], fg0: w[1][0], fg1: w[1][1] } : null);
}
async function blockTime(chain, block) {
  const b = await rpcOf(chain).call('eth_getBlockByNumber', [hex(block), false]);
  return b?.timestamp ? parseInt(b.timestamp, 16) * 1000 : null;
}
async function swapsBetween(p, from, to) {
  const C = CHAINS[p.chain], step = C.logMax, rpc = logRpcOf(p.chain);
  if ((to - from) / step > 60) return null;
  const filter = p.v === 3 ? { address: p.id, topics: [[SWAP_TOPICS.v3, SWAP_TOPICS.pcs3, EXTRA_TOPICS.flash]] } : { address: C.c.v4PoolManager, topics: [[SWAP_TOPICS.v4, EXTRA_TOPICS.donate], p.id] };
  const logs = [];
  for (let a = from; a <= to; a += step) {
    const r = await rpc.call('eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(Math.min(to, a + step - 1)) }]);
    if (!Array.isArray(r)) return null;
    logs.push(...r);
  }
  return logs;
}
const usd = (p, a0, a1) => {
  const u0 = p.t0?.usd, u1 = p.t1?.usd, d0 = p.t0?.dec, d1 = p.t1?.dec;
  if (!(u0 > 0) || !(u1 > 0) || !Number.isInteger(d0) || !Number.isInteger(d1)) return null;
  return (Number(a0) / 10 ** d0) * u0 + (Number(a1) / 10 ** d1) * u1;
};

async function gtDay(p, t) {
  const net = CHAINS[p.chain].gecko;
  try {
    const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${p.id}/ohlcv/day?aggregate=1&limit=120&currency=usd`, { headers: { accept: 'application/json' } }, 20000);
    const list = j?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return { status: 'no candles' };
    const want = Math.floor(t / DAY) * DAY / 1000;
    const c = list.find((x) => x[0] === want);
    const vols = list.filter((x) => Math.abs(x[0] - want) <= 15 * 86400 && x[0] !== want).map((x) => x[5]);
    return { status: 'read', vol: c ? c[5] : null, med: median(vols) };
  } catch (e) { return { status: cat(e) }; }
}

for (const s of pick) {
  const p = meta.get(s.id), series = snaps.get(s.id), lab = label.get(s.id);
  const tag = `${lab} ${p ? `${p.chain} v${p.v}${p.dex === 'pancakeswap' ? ' pcs' : ''}` : ''} ${s.tier === 'y' ? day(s.t) : bar(s)}`;
  const rows = series?.d || [];
  const bi = rows.findIndex((r) => r.t === s.t), b = rows[bi], a = rows[bi - 1];
  const head = `${tag}: ${r1(s.ratio)}× its 30-day median; span ${r1(s.span / 3600e3)} h`;
  if (!p || !b || !a) { say(`${head}; raw rows ${b ? 'this found' : 'this missing'}, ${a ? 'previous found' : 'previous missing'} in the store`); continue; }
  const kind = (r) => (r.t % 1000 === 0 ? 'block-time row (backfill or past map)' : 'pass row');
  const facts = [`this: ${kind(b)} at ${new Date(b.t).toISOString().slice(11, 16)} UTC`, `previous: ${kind(a)} at ${new Date(a.t).toISOString().slice(11, 16)} UTC`];
  try {
    const [ta, tb] = await Promise.all([blockTime(p.chain, a.block), blockTime(p.chain, b.block)]);
    const off = (ts, r) => (ts == null ? 'unread' : `${r1((r.t - ts) / 60e3)} min off`);
    facts.push(`block time vs row time: previous ${off(ta, a)}, this ${off(tb, b)}`);
    const [sa, sb] = await Promise.all([stateAt(p, a.block), stateAt(p, b.block)]);
    const same = (x, r) => (!x ? 'unread' : [x.L === r.L ? null : 'L', x.fg0 === r.fg0 ? null : 'fg0', x.fg1 === r.fg1 ? null : 'fg1'].filter(Boolean).join('+') || 'same');
    facts.push(`state re-read at the rows' blocks: previous ${same(sa, a)}, this ${same(sb, b)}`);
    const back = (b.fg0 != null && a.fg0 != null && b.fg0 < a.fg0) || (b.fg1 != null && a.fg1 != null && b.fg1 < a.fg1);
    if (back) facts.push('a fee counter goes BACK between the rows');
    const Ls = [a.L, b.L], Luse = a.L > 0n && b.L > 0n ? (2n * a.L * b.L) / (a.L + b.L) : a.L > b.L ? a.L : b.L;
    facts.push(`liquidity this ÷ previous ${r1(Number(b.L) / Number(a.L))}`);
    const logs = await swapsBetween(p, a.block + 1, b.block);
    if (!logs) facts.push('swaps: unread');
    else {
      const sw = logs.map(decodeSwap).filter((x) => x && x.pool === String(p.id).toLowerCase()), ex = logs.map(decodeExtra).filter(Boolean);
      const keep = isNum(p.lpKeeps) ? p.lpKeeps : null;
      let e0 = 0n, e1 = 0n, g0 = 0n, g1 = 0n;
      const Lsw = [];
      for (const x of sw) {
        const fee = x.v === 3 ? Math.round((p.feeTier ?? 0) * 1e6) : x.fee;
        const f = (x.amountIn * BigInt(fee)) / 1000000n;
        if (x.in === 0) e0 += f; else if (x.in === 1) e1 += f;
        if (x.liquidity > 0n) { if (x.in === 0) g0 += (f << 128n) / x.liquidity; else if (x.in === 1) g1 += (f << 128n) / x.liquidity; Lsw.push(Number(x.liquidity)); }
      }
      for (const x of ex) { e0 += x.paid[0]; e1 += x.paid[1]; }
      const cUsd = usd(p, (deltaFg(a.fg0, b.fg0) * Luse) >> 128n, (deltaFg(a.fg1, b.fg1) * Luse) >> 128n);
      const eUsd = usd(p, e0, e1), kUsd = eUsd != null && keep != null ? eUsd * keep : null;
      // the counters' own growth against the growth these swaps imply at their own liquidity (protocol cut aside)
      const gUsd = usd(p, (g0 * Luse) >> 128n, (g1 * Luse) >> 128n), gk = gUsd != null && keep != null ? gUsd * keep : null;
      facts.push(`swaps ${sw.length}, flashes/donations ${ex.length}`);
      facts.push(`counter fees ÷ swaps' LP fees ${kUsd ? r1(cUsd / kUsd) : '—'}`);
      facts.push(`fee growth ÷ growth the swaps imply at their own liquidity ${gk ? r1(cUsd / gk) : '—'}`);
      facts.push(`row liquidity ÷ median swap liquidity ${Lsw.length ? r1(Number(Luse) / median(Lsw)) : '—'}`);
    }
    if (lab === 'target') {
      const g = await gtDay(p, b.t - DAY / 2);
      facts.push(g.status === 'read' ? `GeckoTerminal day volume ÷ its 30-day median ${g.vol != null && g.med ? r1(g.vol / g.med) : '—'}` : `GeckoTerminal ${g.status}`);
    }
  } catch (e) { facts.push(`error: ${cat(e)}`); }
  say(`${head}; ${facts.join('; ')}`);
}
done(0);
