// The permanent history archive in Cloudflare D1 (docs/DATA.md "D1 archive", docs/briefs/SQL-plan.md part 1). Market
// data only: the rows history.json already holds (each pool's days: fees, volume and TVL with their sources, the day's
// end price; its settled hours), plain in D1 so SQL can read them. Never an owner field, a wallet or a key.
// - Nothing is ever overwritten. A row is inserted once and changes only when a field moves from a worse source to a
//   better one (fees 'e' < 'x' < 's', volume 'g' < 's'; TVL has one reading a day, so the first stays), when a null gains
//   a value (price, LP fee rate, an hour's price), or when an hour's span narrows (a gap before it was backfilled: its fees
//   no longer cover that gap, which now has rows of its own). Null never replaces a value; missing stays null, never 0.
//   The SQL guard (the upsert's WHERE) enforces it in D1; dayUpgrade/hourUpgrade mirror it so a sweep sends only upgrades.
// - D1's REST API (api.cloudflare.com: /query to write, /raw to read), one statement a request, values inlined as SQL
//   literals (whitelisted codes, finite numbers, quoted strings), each statement under 90 KB and 400 rows.
// - The free plan's limits: 100,000 rows written a day (the account's). These writers keep to 80,000 (meta 'w:<day>'
//   counts what D1 says it wrote); the daily sweep and the import stop 12,000 short, which the passes' hourly rows keep.
// - Each pass (d1Pass): the settled hours of the last 4 hours, plus once a UTC day (from 01:00) a sweep of every pool's
//   days and hours that sends only what D1 lacks or holds from a worse source, in groups of 40 pools, resumed across
//   passes (meta 'sweep'). The import (scripts/d1.mjs import) is the same sweep over the restored history.json.
// - Never fails a pass: d1Pass returns one public line, counts only ('d1: skipped', 'd1: error <category>').
// Errors carry a category word only: never the account, the token, a URL or a message from the API.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DB_NAME = 'assim-ls-archive';
export const API = 'https://api.cloudflare.com/client/v4';
export const HOUR = 3600e3;
export const DAY = 86400e3;
export const LIMITS = Object.freeze({
  stmtBytes: 90_000, stmtRows: 400, // D1: a statement is at most 100 KB
  daily: 80_000, reserve: 12_000,   // of the free plan's 100,000 rows written a day
  group: 40, keyGroup: 200,         // pools per sweep group; ids per key lookup
  passMs: 25_000, sweepMs: 150_000, // a pass's time for D1, without and with the sweep
  settleMs: 2 * HOUR, passHours: 4, sweepFromHour: 1,
});
export const RANK = Object.freeze({
  fees: Object.freeze({ e: 1, x: 2, s: 3 }),
  volume: Object.freeze({ g: 1, s: 2 }),
  tvl: Object.freeze({ r: 1, b: 1, m: 1 }),
});
export const SCHEMA_FILE = fileURLToPath(new URL('../db/schema.sql', import.meta.url));

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const rankOf = (table, code) => (typeof code === 'string' && Object.hasOwn(table, code) ? table[code] : 0);
const ID_RE = /^0x[0-9a-f]{40}(?:[0-9a-f]{24})?$/, ADDR_RE = /^0x[0-9a-f]{40}$/, WORD_RE = /^[a-z0-9-]{1,24}$/, DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- SQL literals ------------------------------------------------------------------------------------------------
export const sqlNum = (x) => (isNum(x) ? String(x) : 'NULL');
const sqlInt = (x) => (Number.isInteger(x) ? String(x) : 'NULL');
// A string literal: control characters and lone surrogates dropped, at most max characters, quotes doubled (SQLite has
// no backslash escapes, so this is the whole of it).
export function sqlStr(s, max = 64) {
  if (s == null) return 'NULL';
  const t = Array.from(String(s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\ud800-\udfff]/gu, '')).slice(0, max).join('');
  return `'${t.replace(/'/g, "''")}'`;
}
const sqlCode = (c, table) => (rankOf(table, c) ? `'${c}'` : 'NULL');

// ---- rows from history.json (docs/DATA.md) -------------------------------------------------------------------------
// The pools to archive: history.json's pools with their market metadata from live.json, minus any pool whose id or
// token is one of the owner's leak-sensitive strings. [{ id, hp, rate, meta }]
export function archivePools(historyPools, livePools = [], exclude = []) {
  const ex = new Set((exclude || []).filter((s) => typeof s === 'string').map((s) => s.toLowerCase()));
  const meta = new Map((Array.isArray(livePools) ? livePools : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id.toLowerCase(), p]));
  const out = [];
  for (const [raw, hp] of Object.entries(historyPools || {})) {
    const id = String(raw).toLowerCase();
    if (!ID_RE.test(id) || !hp || typeof hp !== 'object') continue;
    const m = meta.get(id) || null;
    const t0 = typeof m?.t0?.addr === 'string' ? m.t0.addr.toLowerCase() : null, t1 = typeof m?.t1?.addr === 'string' ? m.t1.addr.toLowerCase() : null;
    if (ex.has(id) || (t0 && ex.has(t0)) || (t1 && ex.has(t1))) continue;
    const rate = m && isNum(m.feeTier) && isNum(m.lpKeeps) && m.feeTier > 0 && m.lpKeeps > 0 ? Number((m.feeTier * m.lpKeeps).toPrecision(6)) : null;
    out.push({ id, hp, rate, meta: poolRow(id, m) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function poolRow(id, m) {
  const word = (x) => (typeof x === 'string' && WORD_RE.test(x) ? x : null), addr = (x) => (typeof x === 'string' && ADDR_RE.test(x.toLowerCase()) ? x.toLowerCase() : null);
  return {
    pool_id: id, chain: word(m?.chain), dex: word(m?.dex), version: m?.v === 3 || m?.v === 4 ? m.v : null,
    fee_tier: isNum(m?.feeTier) && m.feeTier >= 0 && m.feeTier < 1 ? m.feeTier : null,
    token0: addr(m?.t0?.addr), token1: addr(m?.t1?.addr),
    symbol0: typeof m?.t0?.sym === 'string' ? m.t0.sym : null, symbol1: typeof m?.t1?.sym === 'string' ? m.t1.sym : null,
    created_at: isNum(m?.createdAt) && m.createdAt > 0 ? Math.floor(m.createdAt / 1000) : null,
  };
}

// A pool's day rows from y, yv, yt (aligned to y; a misaligned list is left unread), u.y and the daily rows (the day's
// end price: the row in the next UTC day's first hour). A value with no known source is unread (null), never 0.
export function dayRows(id, hp, rate = null) {
  const y = Array.isArray(hp?.y) ? hp.y : [];
  const yv = Array.isArray(hp?.yv) && hp.yv.length === y.length ? hp.yv : null, yt = Array.isArray(hp?.yt) && hp.yt.length === y.length ? hp.yt : null;
  const uy = new Set(Array.isArray(hp?.u?.y) ? hp.u.y : []);
  const ends = new Map();
  for (const r of [...(Array.isArray(hp?.h) ? hp.h : []), ...(Array.isArray(hp?.d) ? hp.d : [])]) { // the daily tier last: it wins
    if (!Array.isArray(r) || !isNum(r[0]) || !isNum(r[1]) || !(r[1] > 0)) continue;
    const start = Math.floor(r[0] / DAY) * DAY;
    if (r[0] - start < HOUR) ends.set(start - DAY, r[1]);
  }
  const out = [];
  y.forEach((r, i) => {
    if (!Array.isArray(r) || !isNum(r[0]) || r[0] % DAY !== 0) return;
    const [t, f, fs] = r, [v, vs] = Array.isArray(yv?.[i]) ? yv[i] : [], [tv, ts] = Array.isArray(yt?.[i]) ? yt[i] : [];
    const fr = isNum(f) ? rankOf(RANK.fees, fs) : 0, vr = isNum(v) ? rankOf(RANK.volume, vs) : 0, tr = isNum(tv) ? rankOf(RANK.tvl, ts) : 0;
    out.push({
      pool_id: id, day_utc: dayOf(t),
      fees_usd: fr ? f : null, fees_src: fr ? fs : null, fees_rank: fr, fees_unconfirmed: fr ? (uy.has(t) ? 1 : 0) : null,
      volume_usd: vr ? v : null, volume_src: vr ? vs : null, volume_rank: vr,
      tvl_usd: tr ? tv : null, tvl_src: tr ? ts : null, tvl_rank: tr,
      price: ends.get(t) ?? null, lp_fee_rate: isNum(rate) ? rate : null,
    });
  });
  return out;
}

// A pool's hour rows from h ([t, price, liquidity, lpFeesUsd, parked], fees from the row before), the hours starting in
// [from, to). The first row has no row before it: its fees and span are unread.
export function hourRows(key, hp, { from = -Infinity, to = Infinity } = {}) {
  const h = Array.isArray(hp?.h) ? hp.h : [], out = [];
  let prev = null;
  for (const r of h) {
    if (!Array.isArray(r) || !isNum(r[0]) || (prev != null && r[0] <= prev)) continue;
    const hs = Math.floor(r[0] / HOUR) * HOUR, before = prev;
    prev = r[0];
    if (hs < from || hs >= to) continue;
    const fees = before != null && isNum(r[3]) ? r[3] : null;
    out.push({
      pool_key: key, hour: hs / HOUR, sec: Math.floor((r[0] - hs) / 1000), span_s: before != null ? Math.round((r[0] - before) / 1000) : null,
      fees_usd: fees, fees_rank: fees != null ? 1 : 0, price: isNum(r[1]) ? r[1] : null, liquidity: isNum(r[2]) ? r[2] : null, parked: isNum(r[4]) ? r[4] : null,
    });
  }
  return out;
}

// The rule in JS, the same as the SQL guard: would this row change what D1 holds (s: the stored row's ranks and which of
// its nullable fields hold a value; undefined = no row)?
export function dayUpgrade(l, s) {
  return !s || l.fees_rank > s.fr || l.volume_rank > s.vr || l.tvl_rank > s.tr || (!s.hp && l.price != null) || (!s.hr && l.lp_fee_rate != null);
}
export function hourUpgrade(l, s) {
  return !s || l.fees_rank > s.fr || (l.fees_rank === 1 && s.fr === 1 && l.sec === s.sec && l.span_s != null && s.span != null && l.span_s < s.span)
    || (!s.hp && l.price != null) || (!s.hl && l.liquidity != null) || (!s.hk && l.parked != null);
}

// ---- statements ----------------------------------------------------------------------------------------------------
const POOL_COLS = ['chain', 'dex', 'version', 'fee_tier', 'token0', 'token1', 'symbol0', 'symbol1', 'created_at'];
const POOL_HEAD = `INSERT INTO pools (pool_id, ${POOL_COLS.join(', ')}, written_at) VALUES `;
const POOL_TAIL = ` ON CONFLICT (pool_id) DO UPDATE SET ${POOL_COLS.map((c) => `${c} = COALESCE(pools.${c}, excluded.${c})`).join(', ')}`
  + ` WHERE ${POOL_COLS.map((c) => `(pools.${c} IS NULL AND excluded.${c} IS NOT NULL)`).join(' OR ')}`;
export const poolTuple = (r, nowS) => `(${sqlStr(r.pool_id, 66)},${sqlStr(r.chain, 24)},${sqlStr(r.dex, 24)},${sqlInt(r.version)},${sqlNum(r.fee_tier)},`
  + `${sqlStr(r.token0, 42)},${sqlStr(r.token1, 42)},${sqlStr(r.symbol0, 32)},${sqlStr(r.symbol1, 32)},${sqlInt(r.created_at)},${sqlInt(nowS)})`;

const up = (f) => `excluded.${f}_rank > pool_day.${f}_rank`;
const DAY_HEAD = 'INSERT INTO pool_day (pool_id, day_utc, fees_usd, fees_src, fees_rank, fees_unconfirmed, volume_usd, volume_src, volume_rank, '
  + 'tvl_usd, tvl_src, tvl_rank, price, lp_fee_rate, written_at) VALUES ';
const DAY_TAIL = ' ON CONFLICT (pool_id, day_utc) DO UPDATE SET '
  + ['fees', 'volume', 'tvl'].map((f) => `${f}_usd = CASE WHEN ${up(f)} THEN excluded.${f}_usd ELSE pool_day.${f}_usd END, `
    + `${f}_src = CASE WHEN ${up(f)} THEN excluded.${f}_src ELSE pool_day.${f}_src END, `
    + (f === 'fees' ? `fees_unconfirmed = CASE WHEN ${up('fees')} OR (excluded.fees_rank = pool_day.fees_rank AND excluded.fees_rank > 0 AND ${up('volume')}) `
      + 'THEN excluded.fees_unconfirmed ELSE pool_day.fees_unconfirmed END, ' : '')
    + `${f}_rank = MAX(pool_day.${f}_rank, excluded.${f}_rank)`).join(', ')
  + ', price = COALESCE(pool_day.price, excluded.price), lp_fee_rate = COALESCE(pool_day.lp_fee_rate, excluded.lp_fee_rate)'
  + ', revisions = pool_day.revisions + 1, revised_at = excluded.written_at'
  + ` WHERE ${up('fees')} OR ${up('volume')} OR ${up('tvl')} OR (pool_day.price IS NULL AND excluded.price IS NOT NULL)`
  + ' OR (pool_day.lp_fee_rate IS NULL AND excluded.lp_fee_rate IS NOT NULL)';
export const dayTuple = (r, nowS) => `(${sqlStr(r.pool_id, 66)},${sqlStr(DAY_RE.test(r.day_utc) ? r.day_utc : null)},${sqlNum(r.fees_usd)},`
  + `${sqlCode(r.fees_src, RANK.fees)},${sqlInt(r.fees_rank)},${sqlInt(r.fees_unconfirmed)},${sqlNum(r.volume_usd)},${sqlCode(r.volume_src, RANK.volume)},`
  + `${sqlInt(r.volume_rank)},${sqlNum(r.tvl_usd)},${sqlCode(r.tvl_src, RANK.tvl)},${sqlInt(r.tvl_rank)},${sqlNum(r.price)},${sqlNum(r.lp_fee_rate)},${sqlInt(nowS)})`;

const HB = '(excluded.fees_rank > pool_hour.fees_rank OR (excluded.fees_rank = 1 AND pool_hour.fees_rank = 1 AND excluded.sec = pool_hour.sec AND excluded.span_s < pool_hour.span_s))';
const HOUR_HEAD = 'INSERT INTO pool_hour (pool_key, hour, sec, span_s, fees_usd, fees_rank, price, liquidity, parked, written_at) VALUES ';
const HOUR_TAIL = ` ON CONFLICT (pool_key, hour) DO UPDATE SET span_s = CASE WHEN ${HB} THEN excluded.span_s ELSE pool_hour.span_s END, `
  + `fees_usd = CASE WHEN ${HB} THEN excluded.fees_usd ELSE pool_hour.fees_usd END, fees_rank = MAX(pool_hour.fees_rank, excluded.fees_rank), `
  + ['price', 'liquidity', 'parked'].map((c) => `${c} = COALESCE(pool_hour.${c}, excluded.${c})`).join(', ') + ', revisions = pool_hour.revisions + 1'
  + ` WHERE ${HB} OR ` + ['price', 'liquidity', 'parked'].map((c) => `(pool_hour.${c} IS NULL AND excluded.${c} IS NOT NULL)`).join(' OR ');
export const hourTuple = (r, nowS) => `(${sqlInt(r.pool_key)},${sqlInt(r.hour)},${sqlInt(r.sec)},${sqlInt(r.span_s)},${sqlNum(r.fees_usd)},${sqlInt(r.fees_rank)},`
  + `${sqlNum(r.price)},${sqlNum(r.liquidity)},${sqlNum(r.parked)},${sqlInt(nowS)})`;

// Multi-row statements: each under maxBytes and maxRows, every tuple in exactly one, in order.
export function statements(tuples, head, tail, { maxBytes = LIMITS.stmtBytes, maxRows = LIMITS.stmtRows } = {}) {
  const out = [], base = head.length + tail.length;
  let cur = [], bytes = base;
  for (const t of tuples) {
    const b = Buffer.byteLength(t) + 1;
    if (cur.length && (cur.length >= maxRows || bytes + b > maxBytes)) { out.push({ sql: head + cur.join(',') + tail, rows: cur.length }); cur = []; bytes = base; }
    cur.push(t); bytes += b;
  }
  if (cur.length) out.push({ sql: head + cur.join(',') + tail, rows: cur.length });
  return out;
}
export const poolStatements = (rows, nowS, o) => statements(rows.filter((r) => ID_RE.test(r.pool_id)).map((r) => poolTuple(r, nowS)), POOL_HEAD, POOL_TAIL, o);
export const dayStatements = (rows, nowS, o) => statements(rows.filter((r) => ID_RE.test(r.pool_id) && DAY_RE.test(r.day_utc)).map((r) => dayTuple(r, nowS)), DAY_HEAD, DAY_TAIL, o);
export const hourStatements = (rows, nowS, o) => statements(rows.filter((r) => Number.isInteger(r.pool_key) && Number.isInteger(r.hour)).map((r) => hourTuple(r, nowS)), HOUR_HEAD, HOUR_TAIL, o);

// ---- schema migrations (db/schema.sql) ----------------------------------------------------------------------------
export function parseMigrations(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^-- migration: (\d+)\s*$/.exec(line);
    if (m) { cur = { version: Number(m[1]), sql: '' }; out.push(cur); continue; }
    if (cur) cur.sql += line.replace(/--.*$/, '') + '\n'; // the schema's comments hold no quotes or dashes inside strings
  }
  return out.map((x) => ({ version: x.version, statements: x.sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean) }))
    .sort((a, b) => a.version - b.version);
}
export const MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)';
export async function migrate(c, db, { text = fs.readFileSync(SCHEMA_FILE, 'utf8'), nowS = Math.floor(Date.now() / 1000) } = {}) {
  await c.query(db, MIGRATIONS_TABLE);
  const have = new Set((await c.raw(db, 'SELECT version FROM schema_migrations')).rows.map((r) => Number(r[0])));
  const all = parseMigrations(text);
  let applied = 0;
  for (const m of all) {
    if (have.has(m.version)) continue;
    for (const s of m.statements) await c.query(db, s);
    await c.query(db, `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (${sqlInt(m.version)}, ${sqlInt(nowS)})`);
    applied++;
  }
  return { applied, version: all.length ? all.at(-1).version : 0, known: all.length };
}

// ---- the cross-check (scripts/d1.mjs verify) -------------------------------------------------------------------
// D1's rows against history.json's, field by field. got: Map(`${pool_id}|${day_utc}` → [pool_id, day_utc, fees_usd,
// fees_src, volume_usd, volume_src, tvl_usd, tvl_src, price]). Counts and ratios only, never a value or a pool.
export const AGE_BUCKETS = Object.freeze([[4, 7], [8, 30], [31, 90], [91, 400]]);
const FIELDS = Object.freeze([['fees', RANK.fees, 2, 3], ['volume', RANK.volume, 4, 5], ['tvl', RANK.tvl, 6, 7]]);
const sameNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
const quant = (xs, q) => { const s = xs.filter(isNum).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
export function compareDays(pick, got, { now = Date.now() } = {}) {
  const field = () => ({ same: 0, behind: 0, ahead: 0, srcdiff: 0, value: 0, bySrc: {}, byAge: AGE_BUCKETS.map(() => 0), dev: [], tiny: 0 });
  const st = { sampled: pick.length, missing: 0, rows: 0, match: 0, behind: 0, differ: 0, ageN: AGE_BUCKETS.map(() => 0),
    f: { fees: field(), volume: field(), tvl: field() }, price: { same: 0, value: 0, d1Lacks: 0, histLacks: 0, dev: [] }, poolRatios: new Map(), feeTvl: { both: 0, same: 0 } };
  const today = Math.floor(now / DAY) * DAY;
  for (const r of pick) {
    const x = got.get(`${r.pool_id}|${r.day_utc}`);
    if (!x) { st.missing++; continue; }
    st.rows++;
    const age = Math.round((today - Date.parse(r.day_utc)) / DAY), ai = AGE_BUCKETS.findIndex(([a, b]) => age >= a && age <= b);
    if (ai >= 0) st.ageN[ai]++;
    let behind = false, differ = false;
    const ratio = {};
    for (const [k, t, vi, si] of FIELDS) {
      const F = st.f[k], dr = rankOf(t, x[si]), hr = r[`${k}_rank`];
      if (hr > dr) { F.behind++; behind = true; continue; }
      if (dr > hr) { F.ahead++; differ = true; continue; }
      if (x[si] !== r[`${k}_src`]) { F.srcdiff++; differ = true; continue; }
      if (sameNum(x[vi], r[`${k}_usd`])) { F.same++; continue; }
      F.value++; differ = true;
      F.bySrc[x[si]] = (F.bySrc[x[si]] || 0) + 1;
      if (ai >= 0) F.byAge[ai]++;
      if (isNum(x[vi]) && isNum(r[`${k}_usd`]) && r[`${k}_usd`] !== 0) {
        const q = x[vi] / r[`${k}_usd`];
        ratio[k] = q; F.dev.push(Math.abs(q - 1)); if (Math.abs(q - 1) < 1e-3) F.tiny++;
      }
    }
    const pd = x[8], ph = r.price;
    if (sameNum(pd, ph)) st.price.same++;
    else if (pd == null) st.price.d1Lacks++;
    else if (ph == null) st.price.histLacks++;
    else { st.price.value++; st.price.dev.push(Math.abs(pd / ph - 1)); }
    if (isNum(ratio.fees)) { const a = st.poolRatios.get(r.pool_id) || []; a.push(ratio.fees); st.poolRatios.set(r.pool_id, a); }
    if (isNum(ratio.fees) && isNum(ratio.tvl)) { st.feeTvl.both++; if (Math.abs(ratio.fees / ratio.tvl - 1) < 2e-3) st.feeTvl.same++; }
    if (behind && !differ) st.behind++; else if (differ) st.differ++; else st.match++;
  }
  const multi = [...st.poolRatios.values()].filter((a) => a.length >= 2);
  st.common = { pools: multi.length, one: multi.filter((a) => Math.max(...a) / Math.min(...a) - 1 < 2e-3).length };
  for (const F of [...Object.values(st.f), st.price]) { F.p50 = quant(F.dev, 0.5); F.p90 = quant(F.dev, 0.9); delete F.dev; }
  delete st.poolRatios;
  return st;
}
const pc = (x) => (x == null ? '—' : `${(100 * x).toFixed(x < 0.001 ? 3 : 1)}%`);
export function compareLines(st) {
  const ages = AGE_BUCKETS.map(([a, b]) => `${a}–${b} d`);
  const f = (k) => { const F = st.f[k]; const src = Object.entries(F.bySrc).sort().map(([c, n]) => `${c} ${n}`).join(', ') || 'none';
    return `${k}: ${F.value} differ in value (by source ${src}; by age ${F.byAge.map((n, i) => `${ages[i]} ${n}`).join(', ')}; |ratio − 1| median ${pc(F.p50)}, p90 ${pc(F.p90)}; under 0.1% ${F.tiny}), `
      + `${F.ahead} D1 ahead, ${F.srcdiff} other source at the same rank, ${F.behind} behind, ${F.same} same`; };
  return [
    `sampled pool-days by age: ${st.ageN.map((n, i) => `${ages[i]} ${n}`).join(', ')}`,
    f('fees'), f('volume'), f('tvl'),
    `price: ${st.price.value} differ (|ratio − 1| median ${pc(st.price.p50)}, p90 ${pc(st.price.p90)}), D1 lacks ${st.price.d1Lacks}, history lacks ${st.price.histLacks}, ${st.price.same} same`,
    `common factor: ${st.common.one} of ${st.common.pools} pools with 2+ fee days differing share one ratio within 0.2%; ${st.feeTvl.same} of ${st.feeTvl.both} days with fees and TVL both differing differ by the same ratio`,
  ];
}

// ---- the REST client ---------------------------------------------------------------------------------------------
export class D1Error extends Error {
  constructor(category, status = null) { super(`d1 ${category}`); this.category = category; this.status = status; }
}
// A category word from the status and the API's own error text (matched, never passed on).
export function categoryOf(status, json) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  const text = JSON.stringify(json?.errors || '').slice(0, 2000);
  if (/limit|exceeded|quota/i.test(text)) return 'limit';
  if (/too (big|large|long)|toobig/i.test(text)) return 'size';
  if (/sqlite|syntax|no such|constraint|parse/i.test(text)) return 'sql';
  return 'request';
}
export function makeClient({ accountId, token, fetchImpl = globalThis.fetch, sleep = pause, tries = 3, timeoutMs = 25_000, api = API } = {}) {
  if (!accountId || !token) throw new D1Error('skipped');
  if (!/^[0-9a-f]{32}$/i.test(String(accountId))) throw new D1Error('account');
  const acct = `/accounts/${accountId}`;
  const stats = { calls: 0, retries: 0 };
  async function call(method, path, body) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      if (i) { stats.retries++; await sleep(1000 * 3 ** (i - 1)); }
      let res, json = null;
      stats.calls++;
      try {
        res = await fetchImpl(api + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
        try { json = await res.json(); } catch { json = null; }
      } catch (e) { last = new D1Error(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network'); continue; }
      if (res.ok && json && json.success !== false) return json.result;
      last = new D1Error(res.ok ? 'answer' : categoryOf(res.status, json), res.status);
      if (!(res.status === 429 || res.status >= 500)) throw last; // a bad request is not retried as is
    }
    throw last;
  }
  const one = (result) => {
    const r = Array.isArray(result) ? result[0] : null;
    if (!r || r.success === false) throw new D1Error('answer');
    return r;
  };
  return {
    stats,
    // does the token work? A user token answers /user/tokens/verify, an account token its account's
    async verify() {
      for (const p of ['/user/tokens/verify', `${acct}/tokens/verify`]) {
        try { const r = await call('GET', p); if (r?.status === 'active') return true; } catch (e) { if (!['auth', 'notfound', 'request'].includes(e.category)) throw e; }
      }
      return false;
    },
    // the database's id by its exact name, or null (only names asked for are listed: never another resource)
    async findDb(name = DB_NAME) {
      const r = await call('GET', `${acct}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
      const hit = (Array.isArray(r) ? r : []).find((d) => d && d.name === name);
      return hit?.uuid ?? null;
    },
    async createDb(name = DB_NAME) {
      if (!/^assim-ls/.test(name)) throw new D1Error('name'); // only ever an assim-ls resource
      const r = await call('POST', `${acct}/d1/database`, { name });
      if (!r?.uuid) throw new D1Error('answer');
      return r.uuid;
    },
    async query(db, sql) { return one(await call('POST', `${acct}/d1/database/${db}/query`, { sql })); },
    async raw(db, sql) {
      const r = one(await call('POST', `${acct}/d1/database/${db}/raw`, { sql }));
      return { columns: r.results?.columns || [], rows: Array.isArray(r.results?.rows) ? r.results.rows : [], meta: r.meta || {} };
    },
  };
}
const written = (r) => (isNum(r?.meta?.rows_written) ? r.meta.rows_written : isNum(r?.meta?.changes) ? r.meta.changes : 0);
const inList = (xs, f = sqlStr) => xs.map((x) => f(x)).join(',');

// ---- the sync --------------------------------------------------------------------------------------------------
async function poolKeys(c, db, ids) {
  const keys = new Map();
  for (let i = 0; i < ids.length; i += LIMITS.keyGroup) {
    const part = ids.slice(i, i + LIMITS.keyGroup);
    for (const [k, id] of (await c.raw(db, `SELECT pool_key, pool_id FROM pools WHERE pool_id IN (${inList(part, (x) => sqlStr(x, 66))})`)).rows) keys.set(id, Number(k));
  }
  return keys;
}
async function readMeta(c, db, today) {
  const m = new Map((await c.raw(db, `SELECT k, v, n FROM meta WHERE k IN ('sweep', ${sqlStr('w:' + today)})`)).rows.map((r) => [r[0], { v: r[1], n: r[2] }]));
  const sw = m.get('sweep');
  return { written: Number(m.get('w:' + today)?.n) || 0, sweepDay: sw?.v ?? null, sweepNext: Number(sw?.n) || 0 };
}

// One sync: the pass's settled hours, and the sweep's groups. sweep: true (the import: every group from fromGroup), false,
// or 'auto' (the pass: due once a UTC day from 01:00, resumed where the last pass left it). Returns counts only:
// { pools, poolRows, days, hours (rows D1 wrote), daysSent, hoursSent, sweep, groups, groupsDone, sweepDone, cut: null|'time'|'budget', left }
export async function sync(c, db, { history, live = [], exclude = [], now, sweep = false, fromGroup = 0, hours = true, clock = Date.now,
  deadline = null, passMs = LIMITS.passMs, sweepMs = LIMITS.sweepMs, budget = LIMITS.daily, sweepBudget = LIMITS.daily - LIMITS.reserve } = {}) {
  const t0 = clock(), nowS = Math.floor(t0 / 1000), today = dayOf(now);
  const pools = archivePools(history, live, exclude);
  const r = { pools: pools.length, poolRows: 0, days: 0, hours: 0, daysSent: 0, hoursSent: 0, sweep: false, groups: Math.ceil(pools.length / LIMITS.group), groupsDone: 0, sweepDone: false, cut: null, left: 0 };
  const meta = await readMeta(c, db, today);
  if (sweep === 'auto') {
    const resume = meta.sweepDay === today;
    sweep = new Date(now).getUTCHours() >= LIMITS.sweepFromHour && !(resume && meta.sweepNext >= r.groups);
    fromGroup = resume ? meta.sweepNext : 0;
  }
  r.sweep = !!sweep;
  if (deadline == null) deadline = t0 + (sweep ? sweepMs : passMs);
  let left = budget - meta.written, sweepLeft = sweepBudget - meta.written;
  const run = async (stmts, kind, sweeping) => {
    for (const s of stmts) {
      if (clock() > deadline) { r.cut = 'time'; return false; }
      if (s.rows > (sweeping ? sweepLeft : left)) { r.cut = 'budget'; return false; }
      const w = written(await c.query(db, s.sql));
      left -= w; sweepLeft -= w; r[kind] += w;
    }
    return true;
  };
  // the pools: new ones first, so every hour row has its key
  let keys = await poolKeys(c, db, pools.map((p) => p.id));
  const fresh = pools.filter((p) => !keys.has(p.id));
  if (fresh.length) {
    const before = left;
    await run(poolStatements(fresh.map((p) => p.meta), nowS), 'poolRows', false);
    if (left !== before) keys = await poolKeys(c, db, pools.map((p) => p.id));
  }
  // the pass: the settled hours of the last few hours (the guard skips what D1 holds)
  const to = Math.floor((now - LIMITS.settleMs) / HOUR) * HOUR + HOUR;
  if (hours && !r.cut) {
    const rows = pools.flatMap((p) => (keys.has(p.id) ? hourRows(keys.get(p.id), p.hp, { from: to - LIMITS.passHours * HOUR, to }) : []));
    r.hoursSent += rows.length;
    await run(hourStatements(rows, nowS), 'hours', false);
  }
  // the sweep, a group of pools at a time: what D1 lacks or holds from a worse source
  let g = sweep ? Math.max(0, fromGroup) : r.groups;
  for (; g < r.groups && !r.cut; g++) {
    if (clock() > deadline) { r.cut = 'time'; break; }
    if (sweepLeft <= 0) { r.cut = 'budget'; break; }
    const part = pools.slice(g * LIMITS.group, (g + 1) * LIMITS.group);
    if (!(await run(poolStatements(part.map((p) => p.meta), nowS), 'poolRows', true))) break;
    const ids = part.map((p) => p.id), ks = part.filter((p) => keys.has(p.id)).map((p) => keys.get(p.id));
    const sd = new Map((await c.raw(db, `SELECT pool_id, day_utc, fees_rank, volume_rank, tvl_rank, price IS NOT NULL, lp_fee_rate IS NOT NULL FROM pool_day WHERE pool_id IN (${inList(ids, (x) => sqlStr(x, 66))})`)).rows
      .map((x) => [`${x[0]}|${x[1]}`, { fr: x[2], vr: x[3], tr: x[4], hp: !!x[5], hr: !!x[6] }]));
    const days = part.flatMap((p) => dayRows(p.id, p.hp, p.rate)).filter((x) => dayUpgrade(x, sd.get(`${x.pool_id}|${x.day_utc}`)));
    r.daysSent += days.length;
    if (!(await run(dayStatements(days, nowS), 'days', true))) break;
    if (hours && ks.length) {
      const sh = new Map((await c.raw(db, `SELECT pool_key, hour, fees_rank, sec, span_s, price IS NOT NULL, liquidity IS NOT NULL, parked IS NOT NULL FROM pool_hour WHERE pool_key IN (${inList(ks, sqlInt)}) AND hour >= ${sqlInt(Math.floor((now - 15 * DAY) / HOUR))}`)).rows
        .map((x) => [`${x[0]}|${x[1]}`, { fr: x[2], sec: x[3], span: x[4], hp: !!x[5], hl: !!x[6], hk: !!x[7] }]));
      const hrs = part.flatMap((p) => (keys.has(p.id) ? hourRows(keys.get(p.id), p.hp, { to }) : [])).filter((x) => hourUpgrade(x, sh.get(`${x.pool_key}|${x.hour}`)));
      r.hoursSent += hrs.length;
      if (!(await run(hourStatements(hrs, nowS), 'hours', true))) break;
    }
    r.groupsDone++;
  }
  if (sweep) r.sweepDone = g >= r.groups;
  // what was written today, and where the sweep is (a budget cut ends today's sweep: tomorrow's starts again)
  const total = r.poolRows + r.days + r.hours;
  const marks = [];
  if (total > 0) marks.push(`(${sqlStr('w:' + today)}, NULL, ${sqlInt(total)})`);
  if (sweep) marks.push(`('sweep', ${sqlStr(today)}, ${sqlInt(r.cut === 'budget' ? r.groups : g)})`);
  if (marks.length) {
    await c.query(db, `INSERT INTO meta (k, v, n) VALUES ${marks.join(', ')} ON CONFLICT (k) DO UPDATE SET `
      + "v = CASE WHEN meta.k = 'sweep' THEN excluded.v ELSE meta.v END, n = CASE WHEN meta.k = 'sweep' THEN excluded.n ELSE COALESCE(meta.n, 0) + excluded.n END");
  }
  if (sweep && r.groups === 0) r.sweepDone = true;
  r.left = Math.max(0, left);
  return r;
}

const fmt = (n) => Number(n).toLocaleString('en-US');
export function passLine(r) {
  const sw = r.sweep ? ` · daily sweep ${r.sweepDone ? 'done' : `${r.groupsDone} more of ${r.groups} pool groups`}` : '';
  return `d1: ${fmt(r.pools)} pools, ${fmt(r.days)} day rows, ${fmt(r.hours)} hour rows written${r.poolRows ? ` (+${fmt(r.poolRows)} pool rows)` : ''}${sw}${r.cut ? ` · stopped by the ${r.cut} cap` : ''}`;
}

// The scanner's call, once a pass after history.json is built. Never throws, never fails the pass: one public line.
export async function d1Pass({ env = process.env, history, live = [], exclude = [], now = Date.now(), clock = Date.now, fetchImpl, sleep } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return { line: 'd1: skipped', skipped: true };
  try {
    const c = makeClient({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}), timeoutMs: 15_000, tries: 2 });
    const db = await c.findDb(DB_NAME);
    if (!db) return { line: 'd1: error nodb', error: 'nodb' };
    const r = await sync(c, db, { history, live, exclude, now, clock, sweep: 'auto' });
    return { ...r, line: passLine(r) };
  } catch (e) {
    const cat = e instanceof D1Error ? e.category : 'internal';
    return { line: cat === 'skipped' ? 'd1: skipped' : `d1: error ${cat}`, error: cat };
  }
}
