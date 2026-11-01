// Diagnostics for the cross-checks (run in GitHub Actions; this session can't reach chain or market
// hosts). Public data only: counts, ratios, block numbers, HTTP status codes and cause categories.
// Never an address, a key or a private value.
//   node scripts/diag.mjs probe    price-history sources: why DefiLlama's chart answers 400, CoinGecko's shape
//   node scripts/diag.mjs events   v3 PoolCreated events per provider: which ranges come back short, and why
import fs from 'node:fs';
import { makeRpc, mapLimit, getJson } from '../lib/rpc.mjs';
import { ETHEREUM as C, TOPICS, decodePoolCreated } from '../lib/pools.mjs';
import { pageLogs } from '../lib/logs.mjs';

const mode = process.argv[2] || 'probe';
const out = [];
const KEY = process.env.COINGECKO_KEY || '';
const scrub = (x) => (KEY ? String(x).split(KEY).join('[key]') : String(x)); // a key never reaches the log, even if an API echoes it
const say = (area, msg) => { const l = scrub(`${area}: ${msg}`); out.push(l); console.log(l); };
const clean = (x, n = 50) => String(x ?? '').replace(/0x[0-9a-fA-F]+/g, '0x…').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const done = () => {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### diag ${mode}\n\n` + out.map((l) => `- ${l}`).join('\n') + '\n');
  process.exit(0);
};

async function raw(url, headers = {}) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: c.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e?.name === 'AbortError' ? 'timeout' : String(e?.cause?.code || e?.message || e) };
  } finally { clearTimeout(t); }
}

if (mode === 'probe') {
  const WETH = C.quotes[0].address, UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
  const now = Math.floor(Date.now() / 1000), start = now - 31 * 86400;
  const many = [...C.quotes.filter((q) => q.address !== '0x0000000000000000000000000000000000000000').map((q) => q.address), UNI,
    '0x514910771af9ca656af840dff83e8264ecf986ca', '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'].map((a) => `ethereum:${a}`).join(',');
  const L = 'https://coins.llama.fi';
  const variants = [
    ['current form, 8 coins', `${L}/chart/${many}?start=${start}&span=32&period=1d&searchWidth=600`],
    ['current form, 1 coin', `${L}/chart/ethereum:${WETH}?start=${start}&span=32&period=1d&searchWidth=600`],
    ['no searchWidth', `${L}/chart/ethereum:${WETH}?start=${start}&span=32&period=1d`],
    ['searchWidth 4h', `${L}/chart/ethereum:${WETH}?start=${start}&span=32&period=1d&searchWidth=4h`],
    ['span 10', `${L}/chart/ethereum:${WETH}?start=${start}&span=10&period=1d`],
    ['no start (end now)', `${L}/chart/ethereum:${WETH}?end=${now}&span=32&period=1d`],
    ['no span', `${L}/chart/ethereum:${WETH}?start=${start}&period=1d`],
    ['coingecko id', `${L}/chart/coingecko:ethereum?start=${start}&span=32&period=1d`],
    ['bare', `${L}/chart/ethereum:${WETH}`],
    ['prices/historical', `${L}/prices/historical/${start}/ethereum:${WETH}`],
    ['prices/current', `${L}/prices/current/ethereum:${WETH}`],
  ];
  for (const [name, url] of variants) {
    const r = await raw(url);
    const coins = r.json?.coins ? Object.values(r.json.coins) : [];
    const pts = coins.reduce((s, c) => s + (Array.isArray(c?.prices) ? c.prices.length : c?.price > 0 ? 1 : 0), 0);
    say(`defillama ${name}`, r.status === 200 ? `HTTP 200, ${coins.length} coins, ${pts} points` : `HTTP ${r.status}: ${clean(r.json?.message || r.json?.error || r.text)}`);
    await pause(1500);
  }
  const key = process.env.COINGECKO_KEY;
  say('coingecko key', key ? 'present' : 'absent');
  const G = 'https://api.coingecko.com/api/v3', H = key ? { 'x-cg-demo-api-key': key } : {};
  for (const [name, path] of [
    ['UNI 30 days', `/coins/ethereum/contract/${UNI}/market_chart?vs_currency=usd&days=30`],
    ['UNI 30 days daily', `/coins/ethereum/contract/${UNI}/market_chart?vs_currency=usd&days=30&interval=daily`],
    ['WETH 30 days', `/coins/ethereum/contract/${WETH}/market_chart?vs_currency=usd&days=30`],
    ['unknown contract', `/coins/ethereum/contract/0x000000000000000000000000000000000000dead/market_chart?vs_currency=usd&days=30`],
  ]) {
    const r = await raw(G + path, H);
    const p = Array.isArray(r.json?.prices) ? r.json.prices : null;
    if (r.status === 200 && p) {
      const gaps = p.slice(1).map((x, i) => (x[0] - p[i][0]) / 60000);
      say(`coingecko ${name}`, `HTTP 200, ${p.length} points, median spacing ${Math.round(median(gaps))} min, newest ${Math.round((Date.now() - p[p.length - 1][0]) / 60000)} min old, oldest ${((Date.now() - p[0][0]) / 86400e3).toFixed(1)} days`);
    } else say(`coingecko ${name}`, `HTTP ${r.status}: ${clean(r.json?.error || r.json?.status?.error_message || r.text)}`);
    await pause(2500);
  }
  done();
}

if (mode === 'events') {
  const PROVIDERS = {
    publicnode: 'https://ethereum-rpc.publicnode.com', drpc: 'https://eth.drpc.org', '1rpc': 'https://1rpc.io/eth',
    mevblocker: 'https://rpc.mevblocker.io', flashbots: 'https://rpc.flashbots.net', blockscout: 'https://eth.blockscout.com/api/eth-rpc',
  };
  const any = makeRpc(Object.values(PROVIDERS), { timeout: 20000 });
  const head = parseInt(await any.call('eth_blockNumber', []), 16);
  const START = C.v3FactoryBlock, CH = 9000, BUDGET_MS = 22 * 60e3, t0 = Date.now();
  const chunks = [];
  for (let a = START; a <= head; a += CH) chunks.push([a, Math.min(head, a + CH - 1)]);
  say('range', `blocks ${START}–${head}, ${chunks.length} chunks of ${CH}`);
  const filter = { address: C.v3Factory, topics: [TOPICS.poolCreated] };
  const ids = (logs) => new Set(logs.map(decodePoolCreated).filter(Boolean).map((e) => e.id));
  // Each provider on its own (no rotation), every chunk, one retry; unanswered stays null.
  const res = {}, errs = {};
  await Promise.all(Object.entries(PROVIDERS).map(async ([name, url]) => {
    const one = makeRpc([url], { timeout: 30000, maxRefusals: 1e9 });
    errs[name] = 0;
    res[name] = await mapLimit(chunks, 3, async ([a, b]) => {
      if (Date.now() - t0 > BUDGET_MS) return null;
      for (let k = 0; k < 2; k++) {
        const r = await one.call('eth_getLogs', [{ ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
        if (Array.isArray(r)) return { n: r.length, ids: ids(r) };
        errs[name]++;
        await pause(1500);
      }
      return null;
    });
  }));
  // Blockscout's Etherscan-style API over the range where it served the scan before.
  const bsEnd = Math.min(head, 16_500_000);
  const bs = await pageLogs(getJson, { base: 'https://eth.blockscout.com/api', address: C.v3Factory, fromBlock: START, toBlock: bsEnd, tries: 4, spacingMs: 1200, maxCalls: 40 });
  const bsIds = new Map();
  for (const l of bs.logs) {
    const e = decodePoolCreated(l);
    if (!e) continue;
    const i = Math.floor((e.block - START) / CH);
    if (!bsIds.has(i)) bsIds.set(i, new Set());
    bsIds.get(i).add(e.id);
  }
  const bsDone = bs.complete ? chunks.length : Math.floor((bs.reached - START) / CH); // chunks fully covered by the pager
  say('blockscout api', `${bs.logs.length} events in ${bs.calls} pages, ${bs.complete ? 'complete' : `stopped (${bs.reason}) at block ${bs.reached}`} up to ${bsEnd}`);
  // The union per chunk is the best record; each provider is judged against it.
  const union = chunks.map((_, i) => {
    const u = new Set();
    for (const n of Object.keys(PROVIDERS)) for (const id of res[n][i]?.ids || []) u.add(id);
    for (const id of (i < bsDone ? bsIds.get(i) : null) || []) u.add(id);
    return u;
  });
  const total = union.reduce((s, u) => s + u.size, 0);
  say('union', `${total} distinct pools created across ${chunks.length} chunks; chunks nobody answered ${union.filter((_, i) => Object.keys(PROVIDERS).every((n) => !res[n][i])).length}`);
  const bucket = (i) => `${Math.floor(chunks[i][0] / 1e6)}M`;
  for (const n of Object.keys(PROVIDERS)) {
    const r = res[n];
    const answered = r.filter(Boolean).length;
    const short = r.map((x, i) => (x && x.n < union[i].size ? i : -1)).filter((i) => i >= 0);
    const zero = short.filter((i) => r[i].n === 0).length;
    const lost = short.reduce((s, i) => s + union[i].size - r[i].n, 0);
    const sizes = new Map();
    for (const i of short) sizes.set(r[i].n, (sizes.get(r[i].n) || 0) + 1);
    const byB = new Map();
    for (const i of short) byB.set(bucket(i), (byB.get(bucket(i)) || 0) + 1);
    const maxN = Math.max(0, ...r.filter(Boolean).map((x) => x.n));
    say(`provider ${n}`, `answered ${answered} of ${chunks.length} (errors ${errs[n]}); short ${short.length} chunks (${zero} empty while others had events), ${lost} events lost; largest answer ${maxN}; short answer sizes ${[...sizes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' ') || 'none'}; short by block range ${[...byB].map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);
  }
  if (bsDone) {
    let s = 0, l = 0;
    for (let i = 0; i < bsDone; i++) { const n = bsIds.get(i)?.size || 0; if (n < union[i].size) { s++; l += union[i].size - n; } }
    say('provider blockscout-api', `covered ${bsDone} chunks; short ${s}, ${l} events lost`);
  }
  // Wide ranges at a busy stretch: does any provider cap its answer at a round number?
  const busy = chunks.map((_, i) => i).sort((a, b) => union[b].size - union[a].size)[0];
  for (const span of [50_000, 200_000, 1_000_000]) {
    const a = chunks[busy][0], b = Math.min(head, a + span - 1);
    const truth = union.reduce((s, u, i) => s + (chunks[i][0] >= a && chunks[i][1] <= b ? u.size : 0), 0);
    const covered = chunks.filter(([x, y]) => x >= a && y <= b).length * CH;
    const row = [];
    for (const [n, url] of Object.entries(PROVIDERS)) {
      const r = await raw2(url, { ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) });
      row.push(`${n} ${r}`);
    }
    say(`wide ${span}`, `from block ${a} (union over ${covered} fully covered blocks: ${truth}): ${row.join(', ')}`);
  }
  // Lookup pools no source has an event for: when were they created, and who answered those chunks?
  if (fs.existsSync('out/pools-ethereum.json')) {
    const list = JSON.parse(fs.readFileSync('out/pools-ethereum.json', 'utf8'));
    const all = new Set(union.flatMap((u) => [...u]));
    const missing = list.v3.map((p) => p.id).filter((id) => !all.has(id));
    say('lookups', `${list.v3.length} v3 pools found by lookup; ${missing.length} have no creation event in the union of all providers`);
    const per = Object.keys(PROVIDERS).map((n) => {
      const mine = new Set(res[n].flatMap((x) => (x ? [...x.ids] : [])));
      return `${n} ${list.v3.filter((p) => !mine.has(p.id)).length}`;
    });
    say('lookups per provider', `lookup pools missing from each provider alone (unanswered chunks count as missing): ${per.join(', ')}`);
    const arch = makeRpc(['https://eth.drpc.org', 'https://eth.blockscout.com/api/eth-rpc', 'https://rpc.mevblocker.io'], { timeout: 20000, maxRefusals: 50 });
    const exists = async (id, b) => { const c = await arch.call('eth_getCode', [id, '0x' + b.toString(16)]); return c == null ? null : c !== '0x'; };
    const sample = missing.slice(0, 40);
    const born = await mapLimit(sample, 4, async (id) => {
      let lo = START, hi = head;
      if (!(await exists(id, hi))) return null;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const e = await exists(id, mid); if (e == null) return null; if (e) hi = mid; else lo = mid + 1; }
      return lo;
    });
    const found = born.filter((b) => b != null);
    const byB = new Map();
    for (const b of found) byB.set(`${Math.floor(b / 1e6)}M`, (byB.get(`${Math.floor(b / 1e6)}M`) || 0) + 1);
    say('missing pools born', `${found.length} of ${sample.length} sampled dated by code at archive blocks; by block range ${[...byB].sort().map(([k, v]) => `${k}:${v}`).join(' ')}`);
    const answeredWithout = {};
    for (const b of found) {
      const i = Math.floor((b - START) / CH);
      for (const n of Object.keys(PROVIDERS)) { const x = res[n][i]; answeredWithout[n] = answeredWithout[n] || [0, 0]; if (x) answeredWithout[n][0]++; if (x && union[i].size === x.n) answeredWithout[n][1]++; }
    }
    say('missing pools chunks', `chunks answered / answered and matching the union, per provider: ${Object.entries(answeredWithout).map(([n, [a, m]]) => `${n} ${a}/${m}`).join(', ')}`);
    // Re-read the dated chunks narrowly (100 blocks around each birth) on each provider.
    const narrow = {};
    for (const b of found.slice(0, 15)) {
      for (const [n, url] of Object.entries(PROVIDERS)) {
        const r = await makeRpc([url], { timeout: 20000, maxRefusals: 1e9 }).call('eth_getLogs', [{ ...filter, fromBlock: '0x' + (b - 50).toString(16), toBlock: '0x' + (b + 50).toString(16) }]);
        narrow[n] = narrow[n] || [0, 0, 0];
        if (!Array.isArray(r)) narrow[n][2]++; else if (r.length) narrow[n][0]++; else narrow[n][1]++;
      }
    }
    say('missing pools narrow', `100-block reads around ${Math.min(15, found.length)} births (with events / empty / error): ${Object.entries(narrow).map(([n, [a, e, x]]) => `${n} ${a}/${e}/${x}`).join(', ')}`);
  }
  done();
}

async function raw2(url, f) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 45000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [f] }), signal: c.signal });
    const j = await r.json().catch(() => null);
    if (Array.isArray(j?.result)) return `${j.result.length}`;
    return `error(${clean(j?.error?.message || `HTTP ${r.status}`, 40)})`;
  } catch (e) { return `error(${e?.name === 'AbortError' ? 'timeout' : 'network'})`; } finally { clearTimeout(t); }
}
