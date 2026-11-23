// The archive's read API (worker/api.mjs): the SQL on real SQLite (node:sqlite) with the archive's own schema, the "Find days"
// presets against the page's standout rule (hsMarks, copied below) on random made-up pools, input validation, the auth check
// (ended or removed tokens refused), CORS, rate limits, one-word errors, no-store/noindex, null kept null, every query a
// primary-key seek, and planted faults (each check fails on broken SQL or a broken handler). Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseMigrations, SCHEMA_FILE } from '../lib/d1.mjs';
import {
  DAY_COLS, HOUR_COLS, InputError, LIMITS, ORIGIN, PRESETS, RULE, SQL, dayOf, dayParam, findAnswer, findParams, findWindow, instantParam, makeHandler,
  makeLimiter, params, poolParam, sha256hex,
} from '../worker/api.mjs';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
const noSql = { skip: !sqlite && 'node:sqlite is not available' };

const D = 86400e3, H = 3600e3;
const NOW = Date.UTC(2026, 10, 23, 10, 17);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const rng = (seed) => (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
const pid = (i) => '0x' + i.toString(16).padStart(4, '0').repeat(10);

// ---- the fixture: the archive's schema on SQLite, a D1-like binding over it, a KV-like binding over a Map ------------
function freshDb() {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const m of parseMigrations(fs.readFileSync(SCHEMA_FILE, 'utf8'))) for (const s of m.statements) db.exec(s);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  db.exec('INSERT INTO schema_migrations VALUES (1, 1), (2, 2)');
  return db;
}
export function d1Of(db, { fail = false, counter = { n: 0 } } = {}) {
  return {
    counter,
    prepare(sql) {
      const st = { args: [], bind(...a) { return { ...st, args: a }; }, async all() { counter.n++; if (fail) throw new Error('SQLITE_ERROR: made-up secret detail'); return { results: db.prepare(sql).all(...this.args), success: true }; } };
      return st;
    },
  };
}
const kvOf = (map, gets = { n: 0 }) => ({ gets, async get(key, o) { gets.n++; const v = map.get(key); return v == null ? null : o?.type === 'json' ? JSON.parse(v) : v; } });

// random made-up pools: days with gaps, unread fees, unconfirmed spikes, odd fee÷vol days, unread or zero volume and TVL
function fill(db, { pools = 40, days = 80, seed = 7 } = {}) {
  const r = rng(seed), today = Math.floor(NOW / D) * D;
  const insP = db.prepare('INSERT INTO pools (pool_key, pool_id, chain, dex, version, fee_tier, symbol0, symbol1, written_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
  const insD = db.prepare('INSERT INTO pool_day (pool_id, day_utc, fees_usd, fees_src, fees_rank, fees_unconfirmed, volume_usd, volume_src, volume_rank, tvl_usd, tvl_src, tvl_rank, price, written_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const out = [];
  for (let i = 1; i <= pools; i++) {
    const id = pid(i), chain = i % 3 ? 'ethereum' : 'base', base = 5 + r(500), rate = 0.001 + r(30) / 10000;
    insP.run(i, id, chain, 'uniswap', 3, 0.003, `MADE${i}`, 'UP', );
    const span = 20 + r(days - 20);
    for (let k = 1; k <= span; k++) {
      if (r(10) === 0) continue; // no row that day
      const day = dayOf(today - k * D);
      let f = r(12) === 0 ? null : r(25) === 0 ? 0 : base * (0.5 + r(100) / 100) * (i % 5 === 0 && k <= 10 ? 3 : 1);
      let u = f == null ? null : 0;
      const spike = r(18);
      if (f != null && spike === 0) f *= 12 + r(30);                        // a real-looking high day
      if (f != null && spike === 1) { f *= 5 + r(40); u = 1; }               // unconfirmed
      let v = r(9) === 0 ? null : r(30) === 0 ? 0 : f == null ? 1000 : f / rate;
      if (f != null && v && spike === 2) { f *= 4 + r(10); }                 // fee÷vol out of line (volume didn't move)
      if (f != null && v && spike === 3) { v *= 6 + r(5); }                  // fee÷vol too low
      const tv = r(11) === 0 ? null : r(40) === 0 ? 0 : 1e4 + r(1e6);
      insD.run(id, day, f, f == null ? null : 'x', f == null ? 0 : 2, u, v, v == null ? null : 'g', v == null ? 0 : 1, tv, tv == null ? null : 'b', tv == null ? 0 : 1, r(3) ? 1 + r(100) / 7 : null, 1795000000);
      out.push({ pool: id, chain, day, f, u, v, tv });
    }
  }
  return out;
}

// ---- the page's rule (site/app/index.html v0.7.7 hsMarks), and references for the other presets ---------------------------
const sdMed = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), i = b.length >> 1; return b.length % 2 ? b[i] : (b[i - 1] + b[i]) / 2; };
function hsMarks(rows) {
  const rs = rows.filter((r) => isNum(r.f)), cf = rs.filter((r) => !r.u);
  const med = sdMed(cf.map((r) => r.f)), rmed = sdMed(cf.filter((r) => isNum(r.v) && r.v > 0).map((r) => r.f / r.v));
  return rs.map((r) => {
    const x = isNum(med) && med > 0 ? r.f / med : null, fv = isNum(r.v) && r.v > 0 ? r.f / r.v : null;
    let k = '';
    if (x != null) {
      const odd = !!r.u || (isNum(rmed) && rmed > 0 && fv != null && (fv > rmed * 2.5 || fv < rmed * 0.4));
      k = x >= 3 && odd ? 'o' : x >= 10 ? 'h' : x >= 3 ? 'g' : x <= 1 / 3 ? 'l' : '';
    }
    return { ...r, x, k, n: cf.length };
  });
}
const byPool = (rows, from, to, chain) => {
  const m = new Map();
  for (const r of rows) if (r.day >= from && r.day <= to && (!chain || r.chain === chain)) { if (!m.has(r.pool)) m.set(r.pool, []); m.get(r.pool).push(r); }
  return m;
};
function reference(rows, q, days, chain = null) {
  const w = findWindow(q, days, NOW);
  const pools = byPool(rows, w.from, w.to, chain);
  let out = [];
  if (q === 'spikes10x' || q === 'outliers') {
    for (const rs of pools.values()) for (const r of hsMarks(rs)) {
      if (q === 'spikes10x' && r.x != null && r.x >= 10) out.push({ pool: r.pool, day: r.day, value: r.f, multiple: r.x, mark: r.k === 'o' ? 'o' : 'h', n: r.n });
      if (q === 'outliers' && r.k === 'o') out.push({ pool: r.pool, day: r.day, value: r.f, multiple: r.x, mark: 'o', n: r.n });
    }
    out.sort((a, b) => b.multiple - a.multiple || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || (a.pool < b.pool ? -1 : 1));
  } else if (q === 'doubled') {
    const end = Date.parse(w.to + 'T00:00:00Z');
    for (const [pool, rs] of pools) {
      const wk = new Map();
      for (const r of rs) {
        if (!isNum(r.f) || r.u) continue;
        const k = Math.floor((end - Date.parse(r.day + 'T00:00:00Z')) / (7 * D));
        if (!wk.has(k)) wk.set(k, []);
        wk.get(k).push(r.f);
      }
      for (const [k, fs] of wk) {
        const pv = wk.get(k + 1);
        if (k >= w.weeks || !pv) continue;
        const a = fs.reduce((s, x) => s + x, 0) / fs.length, b = pv.reduce((s, x) => s + x, 0) / pv.length;
        if (b > 0 && fs.length >= 5 && pv.length >= 5 && a >= 2 * b) out.push({ pool, day: dayOf(end - k * 7 * D), value: a, multiple: a / b, mark: fs.length < 7 || pv.length < 7 ? 'p' : null, n: fs.length, wk: k });
      }
    }
    out.sort((a, b) => b.multiple - a.multiple || a.wk - b.wk || (a.pool < b.pool ? -1 : 1));
    out = out.map(({ wk, ...x }) => x);
  } else if (q === 'quietest') {
    for (const [pool, rs] of pools) {
      const ok = rs.filter((r) => isNum(r.f) && !r.u && isNum(r.tv) && r.tv > 0);
      if (ok.length < w.arg) continue;
      out.push({ pool, day: ok.map((r) => r.day).sort().at(-1), value: ok.reduce((s, r) => s + (365 * r.f) / r.tv, 0) / ok.length, n: ok.length });
    }
    out.sort((a, b) => a.value - b.value || (a.pool < b.pool ? -1 : 1));
    const med = sdMed(out.map((x) => x.value));
    out = out.map((x) => ({ ...x, multiple: med > 0 ? x.value / med : null, mark: x.n < days ? 'p' : null }));
  }
  return out.slice(0, 200);
}
const close = (a, b) => (a == null && b == null) || (isNum(a) && isNum(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
// does an answer's list match the reference, row by row (same pools, days and marks in the same order; numbers within rounding)?
function sameList(got, want) {
  if (got.length !== want.length) return false;
  return got.every((g, i) => g.pool === want[i].pool && g.day === want[i].day && g.mark === want[i].mark && g.n === want[i].n && close(g.value, want[i].value) && close(g.multiple, want[i].multiple));
}

// ---- tests --------------------------------------------------------------------------------------------------------
test('find presets on SQLite agree with the page\'s standout rule and their own definitions, on random made-up pools', noSql, async () => {
  for (const seed of [7, 11, 2026]) {
    const db = freshDb(), rows = fill(db, { seed }), dbx = d1Of(db);
    for (const q of PRESETS) for (const days of [7, 30, 60]) for (const chain of [null, 'base']) {
      const a = await findAnswer(dbx, { q, days: String(days), ...(chain ? { chain } : {}) }, NOW);
      const want = reference(rows, q, days, chain);
      assert.ok(sameList(a.rows, want), `${q} ${days} ${chain} seed ${seed}: ${a.rows.length} vs ${want.length}`);
      assert.ok(a.rows.length <= LIMITS.findMax && a.n === a.rows.length);
      for (const r of a.rows) assert.ok(a.pools[r.pool] && a.pools[r.pool].symbol0, 'each listed pool comes with its metadata');
      if (chain) assert.ok(a.rows.every((r) => a.pools[r.pool].chain === chain));
    }
  }
  // the fixture holds every case: highs, outliers of both kinds, doubled weeks, partial weeks
  const db = freshDb(), rows = fill(db, { seed: 7 }), dbx = d1Of(db);
  const s = await findAnswer(dbx, { q: 'spikes10x', days: '60' }, NOW), o = await findAnswer(dbx, { q: 'outliers', days: '60' }, NOW);
  assert.ok(s.rows.some((r) => r.mark === 'h') && s.rows.some((r) => r.mark === 'o'), 'spikes: both high and odd days');
  assert.ok(o.rows.some((r) => rows.find((x) => x.pool === r.pool && x.day === r.day).u === 1) && o.rows.some((r) => rows.find((x) => x.pool === r.pool && x.day === r.day).u === 0), 'outliers: unconfirmed and fee÷vol ones');
  const dbl = await findAnswer(dbx, { q: 'doubled', days: '30' }, NOW);
  assert.ok(dbl.rows.length > 0, 'doubled weeks are in the fixture');
  const qt = await findAnswer(dbx, { q: 'quietest' }, NOW);
  assert.equal(qt.days, 30, 'the default window is 30 days');
  assert.ok(qt.rows.length > 10 && qt.rows.every((r, i) => i === 0 || r.value >= qt.rows[i - 1].value), 'lowest fee APR first');
});

test('planted faults: each broken preset query disagrees with the reference', noSql, async () => {
  const db = freshDb(), rows = fill(db, { seed: 7 }), dbx = d1Of(db);
  const faulty = (q, from, to) => { assert.ok(SQL[q].includes(from), `${q} holds ${from}`); return { ...SQL, [q]: SQL[q].split(from).join(to) }; };
  const faults = [
    ['spikes10x', '(n + 2) / 2', '(n + 1) / 2'],                  // the lower middle only: not the page's median
    ['spikes10x', 'WHERE u = 0', 'WHERE 1'],                        // unconfirmed days in the median
    ['spikes10x', `x >= ${RULE.hi}`, `x > ${RULE.hi} * 2`],         // a different threshold
    ['outliers', 'AND odd = 1', ''],                                // every 3× day an outlier
    ['outliers', `rm.rmed * ${RULE.rhi}`, 'rm.rmed * 25'],          // fee÷vol bound off
    ['outliers', 'WHEN w.u = 1 THEN 1', 'WHEN w.u = 9 THEN 1'],     // unconfirmed days not odd
    ['doubled', 'AND COALESCE(d.fees_unconfirmed, 0) = 0', ''],     // unconfirmed spikes double a week
    ['doubled', `cur.n >= ${RULE.weekMin}`, 'cur.n >= 1'],          // a week of one day
    ['quietest', 'AND COALESCE(d.fees_unconfirmed, 0) = 0', ''],
    ['quietest', 'AND d.tvl_usd > 0', 'AND d.tvl_usd IS NOT NULL'], // a zero TVL day divides by zero (null), counted
  ];
  for (const [q, from, to] of faults) {
    let ok = false;
    for (const days of [30, 60]) {
      const want = reference(rows, q, days);
      const got = (await findAnswer(dbx, { q, days: String(days) }, NOW, faulty(q, from, to))).rows; // the faulty query still runs
      if (!sameList(got, want)) ok = true;
    }
    assert.ok(ok, `the fault ${q}: ${from} → ${to} is caught`);
  }
});

test('every query seeks by a primary key: no pool_day or pool_hour scan (D1 bills rows read); a scan is caught', noSql, () => {
  const db = freshDb();
  fill(db, { pools: 5 });
  const plan = (sql, args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail);
  const scans = (p) => p.filter((d) => /^SCAN (d|pool_day|pool_hour)\b/.test(d));
  const args = { pool: ['x'], days: ['x', 'a', 'b', 4], hours: ['x', 1, 2], meta: [], metaKv: ['w:x'] };
  for (const k of [...PRESETS, 'pool', 'days', 'hours', 'meta', 'metaKv']) {
    const p = plan(SQL[k], args[k] || ['a', 'b', null, 4]);
    assert.deepEqual(scans(p), [], `${k}: ${p.join(' | ')}`);
    if (PRESETS.includes(k)) assert.ok(p.some((d) => /SEARCH d USING PRIMARY KEY \(pool_id=\? AND day_utc>\? AND day_utc<\?\)/.test(d)), k);
  }
  // planted fault: the window read straight from pool_day (no pool-by-pool seek) is a scan
  assert.notDeepEqual(scans(plan('SELECT pool_id, fees_usd FROM pool_day WHERE day_utc >= ?1 AND day_utc <= ?2', ['a', 'b'])), []);
});

test('inputs: pool ids, days, instants and find parameters are checked before any query', () => {
  const p = (q, allowed) => params(new URL('https://x.test/v1/x?' + q), allowed);
  assert.deepEqual(p('pool=a&from=b', ['pool', 'from']), { pool: 'a', from: 'b' });
  for (const bad of ['pool=a&pool=b', 'x=1', 'pool=' + 'a'.repeat(201)]) assert.throws(() => p(bad, ['pool']), InputError, bad);
  assert.equal(poolParam('0x' + 'AB'.repeat(20)), '0x' + 'ab'.repeat(20), 'ids are lowercased');
  assert.equal(poolParam('0x' + 'ab'.repeat(32)), '0x' + 'ab'.repeat(32), 'a v4 pool id');
  for (const bad of ['', 'xyz', '0x' + 'ab'.repeat(19), '0x' + 'ab'.repeat(21), "0x'; DROP TABLE pools; --", '0x' + 'gg'.repeat(20), undefined]) assert.throws(() => poolParam(bad), InputError, String(bad));
  assert.equal(dayParam('2026-02-28'), '2026-02-28');
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '2014-12-31', '2026-01-01T00:00Z', '']) assert.throws(() => dayParam(bad), InputError, bad);
  assert.equal(instantParam('2026-11-01'), Date.UTC(2026, 10, 1));
  assert.equal(instantParam('2026-11-01T05:30Z'), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(instantParam('2026-11-01T05:30:15.250Z'), Date.UTC(2026, 10, 1, 5, 30, 15, 250));
  assert.equal(instantParam(String(NOW)), NOW);
  for (const bad of ['2026-11-01T05:30', '2026-11-01 05:30Z', '2026-02-30', 'tomorrow', '12', '1e12', '-1', '99999999999999']) assert.throws(() => instantParam(bad), InputError, bad);
  assert.deepEqual(findParams({ q: 'spikes10x' }), { q: 'spikes10x', days: 30, chain: null });
  assert.deepEqual(findParams({ q: 'doubled', days: '365', chain: 'base' }), { q: 'doubled', days: 365, chain: 'base' });
  assert.deepEqual(findParams({ q: 'quietest', chain: 'any' }), { q: 'quietest', days: 30, chain: null });
  for (const bad of [{}, { q: 'nope' }, { q: 'spikes10x', days: '6' }, { q: 'spikes10x', days: '366' }, { q: 'spikes10x', days: '30.5' }, { q: 'spikes10x', days: '0x1e' }, { q: 'spikes10x', chain: 'Base' }, { q: 'spikes10x', chain: "x' OR 1" }]) {
    assert.throws(() => findParams(bad), InputError, JSON.stringify(bad));
  }
  // the windows: whole UTC days ending yesterday; doubled reaches one week further back
  assert.deepEqual(findWindow('spikes10x', 30, NOW), { from: '2026-10-24', to: '2026-11-22', arg: 200 });
  assert.deepEqual(findWindow('doubled', 30, NOW), { from: '2026-10-19', to: '2026-11-22', arg: 4, weeks: 4 });
  assert.deepEqual(findWindow('quietest', 7, NOW), { from: '2026-11-16', to: '2026-11-22', arg: 4 });
});

// ---- the handler ---------------------------------------------------------------------------------------------------
const TOK = 'lps1.' + 'A'.repeat(43), TOK2 = 'lps1.' + 'B'.repeat(43);
async function setup({ seed = 7, rate, clock = { t: NOW }, kv = new Map(), dbFail = false } = {}) {
  const db = freshDb(), rows = sqlite ? fill(db, { seed }) : [];
  kv.set('t:' + (await sha256hex(TOK)), JSON.stringify({ r: 'guest', e: null }));
  const counter = { n: 0 }, gets = { n: 0 };
  const env = { DB: d1Of(db, { fail: dbFail, counter }), AUTH: kvOf(kv, gets), BUILD: 'abcdef0123456789' };
  const h = makeHandler({ now: () => clock.t, ...(rate ? { rate } : {}) });
  const call = async (path, { token = TOK, origin = null, method = 'GET', ip = '198.51.100.7', headers = {} } = {}) => {
    const hd = { 'cf-connecting-ip': ip, ...headers };
    if (token) hd.authorization = `Bearer ${token}`;
    if (origin) hd.origin = origin;
    const res = await h.fetch(new Request('https://assim-ls-api.example.workers.dev' + path, { method, headers: hd }), env);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { json = null; }
    return { status: res.status, body, json, headers: res.headers };
  };
  return { db, rows, kv, env, h, call, clock, counter, gets };
}
const baseHeaders = (r) => r.headers.get('cache-control') === 'no-store' && /noindex/.test(r.headers.get('x-robots-tag') || '') && r.headers.get('x-content-type-options') === 'nosniff' && /Origin/.test(r.headers.get('vary') || '');
const oneWord = (r) => r.status < 400 || /^[a-z]+$/.test(r.body);
const corsRight = (r, origin) => (origin === ORIGIN ? r.headers.get('access-control-allow-origin') === ORIGIN : !r.headers.has('access-control-allow-origin'));

test('auth: a token is its hash in KV; malformed, unknown, ended, badly shaped or removed tokens are refused', noSql, async () => {
  const s = await setup();
  const ok = await s.call('/v1/meta');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.role, 'guest');
  assert.equal(ok.json.api, 'abcdef012345', 'the build, 12 characters');
  for (const t of [null, 'lps1.short', 'lps2.' + 'A'.repeat(43), TOK + 'A', 'Basic ' + TOK, TOK2]) {
    const r = await s.call('/v1/meta', { token: t, ip: '203.0.113.' + (t ? t.length : 0) });
    assert.equal(r.status, 401, String(t)); assert.equal(r.body, 'auth');
  }
  const r0 = await s.h.fetch(new Request('https://x.test/v1/meta', { headers: { authorization: 'Bearer  ' + TOK } }), s.env);
  assert.equal(r0.status, 401, 'two spaces: not a bearer token');
  // an end in the past, a role the API does not know, a bad end: refused
  const h2 = 't:' + (await sha256hex(TOK2));
  for (const v of [{ r: 'guest', e: NOW - 1 }, { r: 'admin', e: null }, { r: 'guest', e: 'soon' }, { e: null }, 'x']) {
    s.kv.set(h2, JSON.stringify(v));
    s.h.state.auth.clear();
    assert.equal((await s.call('/v1/meta', { token: TOK2 })).status, 401, JSON.stringify(v));
  }
  // a token ending while kept in the isolate's cache is refused at its end, not a minute later
  s.kv.set(h2, JSON.stringify({ r: 'member', e: NOW + 30e3 }));
  s.h.state.auth.clear();
  assert.equal((await s.call('/v1/meta', { token: TOK2 })).json.role, 'member');
  s.clock.t = NOW + 30e3;
  assert.equal((await s.call('/v1/meta', { token: TOK2 })).status, 401, 'ended while cached');
  // removed from KV (the loop dropped the guest): refused once the isolate's minute is over
  s.clock.t = NOW;
  s.h.state.auth.clear();
  assert.equal((await s.call('/v1/meta')).status, 200);
  s.kv.delete('t:' + (await sha256hex(TOK)));
  s.clock.t = NOW + LIMITS.authCacheMs + 1;
  const gone = await s.call('/v1/meta');
  assert.equal(gone.status, 401); assert.equal(gone.body, 'auth');
  // KV keeps hashes only: the token's text is never a key or a value
  assert.ok([...s.kv].every(([k, v]) => !k.includes(TOK.slice(5)) && !v.includes(TOK.slice(5))));
  // no KV binding: unavailable, never open
  const noKv = await makeHandler({ now: () => NOW }).fetch(new Request('https://x.test/v1/meta', { headers: { authorization: `Bearer ${TOK}` } }), { DB: s.env.DB });
  assert.equal(noKv.status, 503); assert.equal(await noKv.text(), 'unavailable');
  // planted fault: a Worker that read no end date would serve an ended token, and this check catches it
  const t3 = 'lps1.' + 'C'.repeat(43);
  s.kv.set('t:' + (await sha256hex(t3)), JSON.stringify({ r: 'guest', e: NOW - D }));
  const blind = { ...s.env, AUTH: { async get(k, o) { const v = await s.env.AUTH.get(k, o); return v && { r: v.r }; } } };
  const leak = await makeHandler({ now: () => NOW }).fetch(new Request('https://x.test/v1/meta', { headers: { authorization: `Bearer ${t3}` } }), blind);
  assert.equal(leak.status, 200, 'without its end the token passes: the check above is what catches it');
  assert.equal((await s.call('/v1/meta', { token: t3 })).status, 401);
});

test('CORS: only the dashboard origin; a preflight for it allows GET with authorization; any other origin is refused', noSql, async () => {
  const s = await setup();
  const pre = await s.call('/v1/days', { method: 'OPTIONS', origin: ORIGIN, token: null, headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.match(pre.headers.get('access-control-allow-methods'), /GET/);
  for (const o of ['https://example.com', 'https://kereslek.github.io.evil.example', 'http://kereslek.github.io', 'null']) {
    const r = await s.call('/v1/meta', { origin: o });
    assert.equal(r.status, 403, o); assert.equal(r.body, 'origin'); assert.ok(corsRight(r, o) && baseHeaders(r));
    const p = await s.call('/v1/meta', { method: 'OPTIONS', origin: o, token: null });
    assert.equal(p.status, 403); assert.ok(corsRight(p, o));
  }
  assert.equal((await s.call('/v1/meta', { method: 'OPTIONS', token: null })).status, 403, 'a preflight names its origin');
  const good = await s.call('/v1/meta', { origin: ORIGIN });
  assert.equal(good.status, 200); assert.ok(corsRight(good, ORIGIN));
  const none = await s.call('/v1/meta');
  assert.equal(none.status, 200); assert.ok(corsRight(none, null), 'no origin (a job): no CORS header at all');
  // planted fault: a wildcard answer is caught by the check
  const star = { headers: new Headers({ 'access-control-allow-origin': '*' }) };
  assert.equal(corsRight(star, 'https://example.com'), false);
  assert.equal(corsRight(star, ORIGIN), false);
});

test('rate limits: per token hash, a lower one for find, and refused tokens per address before any KV read', noSql, async () => {
  const s = await setup({ rate: { windowMs: 60e3, token: 5, find: 2, bad: 3, badWindowMs: 600e3 } });
  const st = [];
  for (let i = 0; i < 7; i++) st.push((await s.call('/v1/meta')).status);
  assert.deepEqual(st, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await s.call('/v1/meta')).body, 'rate');
  s.clock.t += 60e3;
  assert.equal((await s.call('/v1/meta')).status, 200, 'a new window');
  const f = [];
  for (let i = 0; i < 3; i++) f.push((await s.call('/v1/find?q=quietest')).status);
  assert.deepEqual(f, [200, 200, 429]);
  // another token has its own count
  s.kv.set('t:' + (await sha256hex(TOK2)), JSON.stringify({ r: 'owner', e: null }));
  assert.equal((await s.call('/v1/meta', { token: TOK2 })).status, 200);
  // refused tokens from one address: after 3, no more KV reads from it, even for a well-formed new token
  const ip = '192.0.2.9';
  for (let i = 0; i < 3; i++) assert.equal((await s.call('/v1/meta', { ip, token: 'lps1.' + String(i).repeat(43) })).status, 401);
  const reads = s.gets.n;
  const r = await s.call('/v1/meta', { ip, token: 'lps1.' + 'z'.repeat(43) });
  assert.equal(r.status, 429); assert.equal(r.body, 'rate');
  assert.equal(s.gets.n, reads, 'no KV read for that address');
  assert.equal((await s.call('/v1/meta', { ip, token: TOK2 })).status, 200, 'a token already known good passes');
  // the limiter itself, and a planted fault: a limiter that never says no is caught
  const l = makeLimiter(2, 1000);
  assert.deepEqual([l.hit('a', 0), l.hit('a', 1), l.hit('a', 2), l.over('a', 3), l.hit('b', 3), l.hit('a', 1000)], [true, true, false, true, true, true]);
  const never = makeLimiter(Infinity, 1000);
  assert.ok([1, 2, 3, 4].every((i) => never.hit('a', i)), 'an unlimited limiter answers yes to all: the 429 checks above would fail on it');
  const big = makeLimiter(1, 1000, 10);
  for (let i = 0; i < 50; i++) big.hit('k' + i, i);
  assert.ok(big.size() <= 10, 'the map stays bounded');
});

test('days: a pool\'s rows from its first day up to ALL, or a range; nulls stay null; unknown pools 404', noSql, async () => {
  const s = await setup();
  const id = pid(3), mine = s.rows.filter((r) => r.pool === id).sort((a, b) => (a.day < b.day ? -1 : 1));
  const all = await s.call(`/v1/days?pool=${id.toUpperCase().replace('0X', '0x')}`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.cols, DAY_COLS);
  assert.equal(all.json.pool.id, id); assert.equal(all.json.pool.chain, 'base'); assert.equal(all.json.more, false);
  assert.equal(all.json.rows.length, mine.length);
  all.json.rows.forEach((r, i) => {
    const m = mine[i];
    assert.equal(r[0], m.day);
    assert.ok(close(r[1], m.f) && close(r[4], m.v) && close(r[6], m.tv), m.day);
    assert.equal(r[3], m.f == null ? null : m.u);
    if (m.f == null) assert.equal(r[1], null, 'unread fees: null, never 0');
    if (m.tv == null) assert.equal(r[6], null, 'unread TVL: null, never 0');
  });
  assert.ok(all.json.rows.some((r) => r[1] === null) && all.json.rows.some((r) => r[1] === 0), 'the fixture has both an unread and a zero day');
  const from = mine[5].day, to = mine[15].day;
  const part = await s.call(`/v1/days?pool=${id}&from=${from}&to=${to}`);
  assert.equal(part.json.rows.length, 11);
  assert.ok(part.json.rows.every((r) => r[0] >= from && r[0] <= to));
  assert.equal((await s.call(`/v1/days?pool=${id}&from=${to}&to=${from}`)).status, 400, 'from after to');
  const unk = await s.call(`/v1/days?pool=0x${'0'.repeat(39)}1`);
  assert.equal(unk.status, 404); assert.equal(unk.body, 'notfound');
  assert.equal((await s.call('/v1/days')).status, 400, 'pool is required');
  // more rows than one answer holds: the first part, and more: true
  const big = pid(999), today = Math.floor(NOW / D) * D, ins = s.db.prepare('INSERT INTO pool_day (pool_id, day_utc, written_at) VALUES (?, ?, 1)');
  s.db.prepare("INSERT INTO pools (pool_key, pool_id, written_at) VALUES (9999, ?, 1)").run(big);
  for (let i = 1; i <= LIMITS.dayRows + 5; i++) ins.run(big, dayOf(today - i * D));
  const b = await s.call(`/v1/days?pool=${big}`);
  assert.equal(b.json.rows.length, LIMITS.dayRows); assert.equal(b.json.more, true);
  assert.ok(b.json.rows[0].slice(1).every((x) => x === null), 'a row with nothing read: every figure null');
});

test('hours: up to 8 days a call (7 by default), rows at their own time, the hour of from included and to excluded', noSql, async () => {
  const s = await setup();
  const ins = s.db.prepare('INSERT INTO pool_hour (pool_key, hour, sec, span_s, fees_usd, fees_rank, price, liquidity, parked, written_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)');
  const h0 = Math.floor(NOW / H) - 10 * 24;
  for (let i = 0; i < 10 * 24; i++) ins.run(2, h0 + i, 90, i ? 3600 : null, i % 7 ? 1.25 : null, i % 7 ? 1 : 0, 2.5, i % 5 ? 1e18 : null, 0.3);
  const from = (h0 + 24) * H + 1800e3;
  const r = await s.call(`/v1/hours?pool=${pid(2)}&from=${from}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.cols, HOUR_COLS);
  assert.equal(r.json.to, from + 7 * D);
  assert.equal(r.json.rows.length, 7 * 24 + 1, 'the hour holding from, then 7 days of hours');
  assert.equal(r.json.rows[0][0], (h0 + 24) * H + 90e3, 'the row\'s own time: its hour plus its seconds');
  assert.ok(r.json.rows.some((x) => x[3] === null) && r.json.rows.some((x) => x[2] === null), 'unread fees and liquidity stay null');
  const iso = new Date((h0 + 48) * H).toISOString().slice(0, 16) + 'Z';
  const r2 = await s.call(`/v1/hours?pool=${pid(2)}&from=${iso}&to=${(h0 + 50) * H}`);
  assert.equal(r2.json.rows.length, 2, 'to on an hour: that hour is not in');
  for (const q of [`from=${from}&to=${from + 8 * D + 1}`, `from=${from}&to=${from}`, `from=${from}&to=${from - H}`, 'to=2026-11-01', `from=${from}&to=${from + H}&x=1`]) {
    const b = await s.call(`/v1/hours?pool=${pid(2)}&${q}`);
    assert.equal(b.status, 400, q); assert.equal(b.body, 'input');
  }
  assert.equal((await s.call(`/v1/hours?pool=${pid(2)}&from=${from}&to=${from + 8 * D}`)).status, 200, 'exactly 8 days');
  assert.equal((await s.call(`/v1/hours?pool=${pid(1)}&from=${from}`)).json.rows.length, 0, 'a pool with no hours: an empty list');
});

test('meta: coverage, date ranges, the last write and the build; kept a couple of minutes in the isolate', noSql, async () => {
  const s = await setup();
  s.db.prepare("INSERT INTO meta (k, v, n) VALUES ('sweep', '2026-11-23', 2), (?, NULL, 1234)").run('w:2026-11-23');
  s.db.prepare('INSERT INTO pool_hour (pool_key, hour, sec, written_at) VALUES (1, ?, 5, 1795400000), (2, ?, 5, 1795300000)').run(Math.floor(NOW / H) - 3, Math.floor(NOW / H) - 30);
  const r = await s.call('/v1/meta');
  const days = [...new Set(s.rows.map((x) => x.day))].sort();
  assert.equal(r.json.pools, 40); assert.equal(r.json.days.pools, 40); assert.equal(r.json.hours.pools, 2);
  assert.equal(r.json.days.from, days[0]); assert.equal(r.json.days.to, days.at(-1));
  assert.equal(r.json.hours.to, (Math.floor(NOW / H) - 3) * H);
  assert.equal(r.json.lastWrite, 1795400000e3);
  assert.equal(r.json.writtenToday, 1234); assert.equal(r.json.sweep, '2026-11-23'); assert.equal(r.json.schema, 2);
  const n = s.counter.n;
  await s.call('/v1/meta');
  assert.equal(s.counter.n, n, 'the second answer came from the isolate');
  s.clock.t += LIMITS.metaCacheMs + 1;
  await s.call('/v1/meta');
  assert.ok(s.counter.n > n, 'and later from D1 again');
  // find answers are kept too
  const f0 = s.counter.n;
  await s.call('/v1/find?q=spikes10x'); await s.call('/v1/find?q=spikes10x&days=30&chain=any');
  assert.equal(s.counter.n, f0 + 1);
});

test('every answer: no-store, noindex, nosniff; every refusal one category word; a D1 error never shows its text', noSql, async () => {
  const s = await setup();
  const seen = [];
  for (const [p, o] of [['/v1/meta', {}], ['/v1/nope', {}], ['/v1/nope', { token: null }], ['/', {}], ['/v1/meta', { method: 'POST' }], ['/v1/meta', { method: 'HEAD' }],
    ['/v1/meta', { method: 'DELETE' }], ['/v1/days?pool=x', {}], ['/v1/find?q=doubled', {}], ['/v1/find?q=x', {}], ['/v1/meta', { origin: 'https://example.com' }]]) seen.push(await s.call(p, o));
  assert.deepEqual(seen.map((r) => r.status), [200, 404, 401, 404, 405, 405, 405, 400, 200, 400, 403]);
  assert.ok(seen.every(baseHeaders), 'headers on every answer');
  assert.ok(seen.filter((r) => r.status >= 400).every(oneWord));
  assert.equal(seen[4].body, 'method');
  const f = await setup({ dbFail: true });
  const e = await f.call('/v1/find?q=outliers');
  assert.equal(e.status, 500); assert.equal(e.body, 'server'); assert.ok(baseHeaders(e));
  assert.ok(!e.body.includes('secret') && !e.body.includes('SQLITE'));
  assert.equal(seen[0].headers.get('content-type'), 'application/json; charset=utf-8');
  // planted faults: a refusal carrying a message, or an answer without no-store, is caught
  assert.equal(oneWord({ status: 500, body: 'server: SQLITE_ERROR near x' }), false);
  assert.equal(baseHeaders({ headers: new Headers({ 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff', vary: 'Origin' }) }), false);
});

test('the deployed entry exports only its handler, and the module has no imports (it is uploaded as it is)', async () => {
  const entry = fs.readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8'), api = fs.readFileSync(new URL('../worker/api.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...entry.matchAll(/^export\s+(\w+)/gm)].map((m) => m[1]), ['default']);
  assert.deepEqual([...entry.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./api.mjs']);
  assert.equal(/^import /m.test(api), false, 'worker/api.mjs imports nothing');
  assert.equal(/console\.|process\./.test(api + entry), false, 'no logging, no Node globals');
  const mod = await import('../worker/index.mjs');
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(typeof mod.default.fetch, 'function');
});
