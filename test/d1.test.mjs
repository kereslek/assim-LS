// The D1 archive (lib/d1.mjs): SQL literals, rows from history.json, the source-rank rule run on real SQLite (node:sqlite)
// with planted faults, batching, the REST client's retries and categories, and the pass that never fails. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DAY, HOUR, LIMITS, RANK, SCHEMA_FILE, D1Error, archivePools, categoryOf, d1Pass, dayRows, dayStatements, dayUpgrade, hourRows, hourStatements,
  hourUpgrade, makeClient, migrate, parseMigrations, passLine, poolStatements, sqlNum, sqlStr, statements, sync,
} from '../lib/d1.mjs';
import { run as runJob } from '../scripts/d1.mjs';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
const noSql = { skip: !sqlite && 'node:sqlite is not available' };

const ACCT = '0123456789abcdef0123456789abcdef', TOKEN = 'made-up-token-value-xyz';
const ENV = { CF_ACCOUNT_ID: ACCT, CF_API_TOKEN: TOKEN };
const P1 = '0x' + 'a1'.repeat(20), P2 = '0x' + 'b2'.repeat(20), P4 = '0x' + 'c3'.repeat(32), T0 = '0x' + '1'.repeat(40), T1 = '0x' + '2'.repeat(40);
const NOW = Date.UTC(2026, 10, 22, 3, 10), D0 = Date.UTC(2026, 10, 12), nowS = Math.floor(NOW / 1000);
const noSleep = async () => {};
// a seeded generator (mulberry32): rnd(n) is 0..n-1
const rng = (seed) => (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };

// A fake D1 REST API over an in-memory SQLite database: /query runs a statement, /raw returns arrays.
function fakeD1({ fail = null, dbs = [{ uuid: 'db-1', name: 'assim-ls-archive' }] } = {}) {
  const db = new sqlite.DatabaseSync(':memory:');
  const calls = [];
  const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method, body: opts.body, headers: opts.headers });
    const u = new URL(url);
    if (fail) { const f = fail(u, opts, calls.length); if (f) return typeof f === 'function' ? f() : f; }
    if (u.pathname.endsWith('/tokens/verify')) return res(200, { success: true, result: { status: 'active' } });
    if (/\/d1\/database$/.test(u.pathname) && opts.method === 'GET') return res(200, { success: true, result: dbs.filter((d) => d.name.includes(u.searchParams.get('name') || '')) });
    if (/\/d1\/database$/.test(u.pathname) && opts.method === 'POST') { const name = JSON.parse(opts.body).name; dbs.push({ uuid: 'db-new', name }); return res(200, { success: true, result: { uuid: 'db-new', name } }); }
    const m = /\/d1\/database\/[^/]+\/(query|raw)$/.exec(u.pathname);
    if (!m) return res(404, { success: false, errors: [{ message: 'no route' }] });
    const { sql } = JSON.parse(opts.body);
    try {
      const st = db.prepare(sql);
      if (/^\s*(select|with)/i.test(sql)) {
        const rows = st.all();
        const results = m[1] === 'raw' ? { columns: rows[0] ? Object.keys(rows[0]) : [], rows: rows.map((r) => Object.values(r)) } : rows;
        return res(200, { success: true, result: [{ success: true, results, meta: { rows_read: rows.length, rows_written: 0 } }] });
      }
      const info = st.run();
      return res(200, { success: true, result: [{ success: true, results: [], meta: { changes: info.changes, rows_written: info.changes } }] });
    } catch (e) {
      return res(400, { success: false, errors: [{ code: 7500, message: `SQLITE_ERROR: ${e.message}` }] });
    }
  };
  const client = () => makeClient({ accountId: ACCT, token: TOKEN, fetchImpl, sleep: noSleep });
  return { db, fetchImpl, calls, client };
}
async function ready() {
  const f = fakeD1();
  await migrate(f.client(), 'db-1', { nowS });
  return f;
}
const all = (f, sql) => f.db.prepare(sql).all();
const one = (f, sql) => f.db.prepare(sql).get();

// made-up history.json pools (docs/DATA.md shapes)
function hpOf({ days = 10, hours = 30, src = 'e', fees = 10 } = {}) {
  const y = [], yv = [], yt = [], d = [], h = [];
  for (let i = 0; i < days; i++) {
    const t = D0 + i * DAY;
    y.push([t, fees + i, src]); yv.push([1000 + i, 'g']); yt.push([5e5 + i, 'b']);
    d.push([t + DAY + 5 * 60e3, 1.5 + i / 100, fees + i, 1000 + i, 0.2]);
  }
  for (let i = 0; i < hours; i++) { const t = NOW - (hours - i) * HOUR + 30e3; h.push([t, 1.6, 1e20 + i, 0.5 + i / 10, 0.25]); }
  return { h, d, y, yv, yt };
}
const live = [
  { id: P1, chain: 'ethereum', dex: 'uniswap', v: 3, feeTier: 0.003, lpKeeps: 1, t0: { sym: "O'Neil", addr: T0 }, t1: { sym: 'WETH', addr: T1 }, createdAt: D0 - 30 * DAY },
  { id: P2, chain: 'base', dex: 'pancakeswap', v: 3, feeTier: 0.0005, lpKeeps: 0.66, t0: { sym: 'AAA', addr: T1 }, t1: { sym: 'BBB', addr: T0 }, createdAt: null },
  { id: P4, chain: 'ethereum', dex: 'uniswap', v: 4, feeTier: 0.01, lpKeeps: null, t0: { sym: 'ETH', addr: '0x' + '0'.repeat(40) }, t1: { sym: 'CCC', addr: T0 } },
];

test('sqlStr and sqlNum: quotes doubled, control characters and lone surrogates dropped, a non-finite number is NULL', noSql, () => {
  assert.equal(sqlStr("O'Neil"), "'O''Neil'");
  assert.equal(sqlStr(null), 'NULL');
  assert.equal(sqlStr('a\u0000b\nc\u007f'), "'abc'");
  assert.equal(sqlStr('x\ud800y'), "'xy'");
  assert.equal(sqlStr('🦄'.repeat(40), 32), `'${'🦄'.repeat(32)}'`); // cut by characters, never inside one
  for (const x of [NaN, Infinity, -Infinity, null, undefined, '5', 5n]) assert.equal(sqlNum(x), 'NULL');
  assert.equal(sqlNum(0), '0'); assert.equal(sqlNum(-1.5), '-1.5'); assert.equal(sqlNum(1.2345678e25), '1.2345678e+25');
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (s TEXT, n REAL)');
  const evil = "x'); DROP TABLE t; --";
  db.exec(`INSERT INTO t VALUES (${sqlStr(evil)}, ${sqlNum(1.2345678e25)})`);
  assert.deepEqual({ ...db.prepare('SELECT s, n FROM t').get() }, { s: evil, n: 1.2345678e25 }); // stored as text, nothing ran
});

test('archivePools: market metadata from live.json, the owner\'s leak-sensitive pools and tokens left out, ids checked', () => {
  const hist = { [P1]: hpOf(), [P2.toUpperCase().replace('0X', '0x')]: hpOf(), [P4]: hpOf(), 'not-an-id': hpOf(), [`0x${'d'.repeat(40)}`]: null };
  const ps = archivePools(hist, live, []);
  assert.deepEqual(ps.map((p) => p.id), [P1, P2, P4].sort());
  const p1 = ps.find((p) => p.id === P1);
  assert.equal(p1.rate, 0.003);
  assert.deepEqual(p1.meta, { pool_id: P1, chain: 'ethereum', dex: 'uniswap', version: 3, fee_tier: 0.003, token0: T0, token1: T1, symbol0: "O'Neil", symbol1: 'WETH', created_at: Math.floor((D0 - 30 * DAY) / 1000) });
  assert.equal(ps.find((p) => p.id === P4).rate, null); // lpKeeps unread: the rate is unread, never the full tier
  assert.deepEqual(archivePools(hist, live, [P1.toUpperCase().replace('0X', '0x')]).map((p) => p.id), [P2, P4].sort());
  assert.deepEqual(archivePools(hist, live, [T1]).map((p) => p.id), [P4]); // a token of P1 and P2
  assert.equal(archivePools({ [P1]: hpOf() }, [], []).at(0).meta.chain, null); // no live.json entry: metadata unread
});

test('dayRows: null stays null, an unknown source is unread, u.y marks a spike, the day\'s end price, a misaligned list unread', () => {
  const hp = hpOf({ days: 4 });
  hp.y[1] = [hp.y[1][0], null, null];
  hp.y[2] = [hp.y[2][0], 7, 'q'];          // a source this code doesn't know
  hp.y[3] = [hp.y[3][0], 0, 's'];          // a real 0: a swap day with no swaps
  hp.yt[0] = [null, null];
  hp.u = { y: [hp.y[0][0]] };
  hp.d.splice(1, 1, [hp.d[1][0] + 2 * HOUR, 9, 1, 1, 0]); // day 1's end read only at 02:05: not its end price
  const rows = dayRows(P1, hp, 0.003);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { pool_id: P1, day_utc: '2026-11-12', fees_usd: 10, fees_src: 'e', fees_rank: 1, fees_unconfirmed: 1, volume_usd: 1000, volume_src: 'g', volume_rank: 1,
    tvl_usd: null, tvl_src: null, tvl_rank: 0, price: 1.5, lp_fee_rate: 0.003 });
  assert.deepEqual([rows[1].fees_usd, rows[1].fees_src, rows[1].fees_rank, rows[1].fees_unconfirmed, rows[1].price], [null, null, 0, null, null]);
  assert.deepEqual([rows[2].fees_usd, rows[2].fees_src, rows[2].fees_rank], [null, null, 0]);
  assert.deepEqual([rows[3].fees_usd, rows[3].fees_src, rows[3].fees_rank, rows[3].fees_unconfirmed], [0, 's', 3, 0]);
  hp.yv.pop();
  assert.ok(dayRows(P1, hp, null).every((r) => r.volume_usd === null && r.volume_rank === 0 && r.lp_fee_rate === null)); // yv no longer aligned to y
  assert.deepEqual(dayRows(P1, {}, 0.003), []);
});

test('hourRows: fees and span from the row before, the first row unread, the window [from, to)', () => {
  const h = [[Date.UTC(2026, 10, 22, 0, 0, 30), 1.6, 100, 0.4, 0.2], [Date.UTC(2026, 10, 22, 1, 0, 30), null, 101, 0.5, null], [Date.UTC(2026, 10, 22, 3, 1), 1.7, 102, 0.9, 0.3]];
  const rows = hourRows(7, { h });
  assert.deepEqual(rows[0], { pool_key: 7, hour: Date.UTC(2026, 10, 22) / HOUR, sec: 30, span_s: null, fees_usd: null, fees_rank: 0, price: 1.6, liquidity: 100, parked: 0.2 });
  assert.deepEqual([rows[1].span_s, rows[1].fees_usd, rows[1].fees_rank, rows[1].price, rows[1].parked], [3600, 0.5, 1, null, null]);
  assert.deepEqual([rows[2].sec, rows[2].span_s, rows[2].fees_usd], [60, 2 * 3600 + 30, 0.9]); // a gap: the span says so
  const w = hourRows(7, { h }, { from: Date.UTC(2026, 10, 22, 1), to: Date.UTC(2026, 10, 22, 3) });
  assert.deepEqual(w.map((r) => r.sec), [30]);
  assert.equal(w[0].span_s, 3600); // the row before the window still counts for its span
});

test('migrations: db/schema.sql parses into versions; applied once, then nothing (idempotent)', noSql, async () => {
  const ms = parseMigrations(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  assert.ok(ms.length >= 1 && ms[0].version === 1);
  assert.ok(ms[0].statements.some((s) => /CREATE TABLE IF NOT EXISTS pool_day/.test(s)) && ms[0].statements.every((s) => !/--/.test(s)));
  const f = fakeD1();
  assert.deepEqual(await migrate(f.client(), 'db-1', { nowS }), { applied: ms.length, version: ms.at(-1).version, known: ms.length });
  assert.deepEqual(await migrate(f.client(), 'db-1', { nowS }), { applied: 0, version: ms.at(-1).version, known: ms.length });
  const tables = all(f, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  assert.deepEqual(tables, ['meta', 'pool_day', 'pool_hour', 'pools', 'schema_migrations']);
  assert.equal(all(f, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('pool_day', 'pool_hour')").length, 0); // no second index: one row written a row
});

// a day row with the given fields (the rest unread)
const day = (o = {}) => ({ pool_id: P1, day_utc: '2026-11-12', fees_usd: null, fees_src: null, fees_rank: 0, fees_unconfirmed: null, volume_usd: null, volume_src: null, volume_rank: 0,
  tvl_usd: null, tvl_src: null, tvl_rank: 0, price: null, lp_fee_rate: null, ...o });
const fee = (src, v, unc = 0) => ({ fees_usd: v, fees_src: src, fees_rank: RANK.fees[src], fees_unconfirmed: unc });
const write = (f, rows, build = dayStatements) => build(rows, nowS).reduce((n, s) => n + f.db.prepare(s.sql).run().changes, 0);
const stored = (f) => ({ ...one(f, `SELECT fees_usd, fees_src, fees_rank, fees_unconfirmed, volume_usd, volume_src, tvl_usd, tvl_src, price, lp_fee_rate, revisions FROM pool_day WHERE pool_id = '${P1}'`) });

test('pool_day: only a better source replaces a field; null never replaces a value; the first TVL reading and price stay', noSql, async () => {
  const f = await ready();
  assert.equal(write(f, [day(fee('e', 10))]), 1);
  assert.equal(write(f, [day(fee('x', 12, 1))]), 1);
  assert.equal(write(f, [day(fee('e', 99))]), 0);           // worse: nothing written
  assert.equal(write(f, [day()]), 0);                       // unread: nothing written
  assert.deepEqual(stored(f), { fees_usd: 12, fees_src: 'x', fees_rank: 2, fees_unconfirmed: 1, volume_usd: null, volume_src: null, tvl_usd: null, tvl_src: null, price: null, lp_fee_rate: null, revisions: 1 });
  assert.equal(write(f, [day({ ...fee('x', 12, 0), volume_usd: 500, volume_src: 'g', volume_rank: 1 })]), 1); // the candle backs the spike
  assert.equal(stored(f).fees_unconfirmed, 0);
  assert.equal(write(f, [day({ ...fee('s', 13), volume_usd: 520, volume_src: 's', volume_rank: 2 })]), 1);
  assert.equal(write(f, [day({ ...fee('x', 50, 1), volume_usd: 1, volume_src: 'g', volume_rank: 1 })]), 0);
  assert.equal(write(f, [day({ tvl_usd: 7e5, tvl_src: 'r', tvl_rank: 1, price: 1.5, lp_fee_rate: 0.003 })]), 1);
  assert.equal(write(f, [day({ tvl_usd: 9e9, tvl_src: 'b', tvl_rank: 1, price: 2, lp_fee_rate: 0.01 })]), 0); // one reading a day: the first stays
  assert.deepEqual(stored(f), { fees_usd: 13, fees_src: 's', fees_rank: 3, fees_unconfirmed: 0, volume_usd: 520, volume_src: 's', tvl_usd: 7e5, tvl_src: 'r', price: 1.5, lp_fee_rate: 0.003, revisions: 4 });
  assert.equal(write(f, [day(fee('s', 0))]), 0); // even a real 0 from the same source never replaces the value held
});

// Random sequences of writes; a downgrade = a field whose rank went down, or a value replaced by one from a source no better.
function downgrades(f, build) {
  const srcs = { fees: [null, 'e', 'x', 's'], volume: [null, 'g', 's'], tvl: [null, 'r', 'b', 'm'] };
  let bad = 0;
  const rnd = rng(7);
  for (let k = 0; k < 40; k++) {
    const id = '0x' + k.toString(16).padStart(40, '0');
    for (let i = 0; i < 12; i++) {
      const o = { pool_id: id };
      for (const [fld, list] of Object.entries(srcs)) {
        const s = list[rnd(list.length)], r = s ? RANK[fld][s] : 0;
        Object.assign(o, { [`${fld}_usd`]: s ? rnd(1000) : null, [`${fld}_src`]: s, [`${fld}_rank`]: r });
      }
      o.fees_unconfirmed = o.fees_rank ? rnd(2) : null;
      o.price = rnd(3) ? null : rnd(100) + 1;
      const before = one(f, `SELECT * FROM pool_day WHERE pool_id = '${id}'`);
      write(f, [day(o)], build);
      const after = one(f, `SELECT * FROM pool_day WHERE pool_id = '${id}'`);
      if (!before) continue;
      for (const fld of Object.keys(srcs)) {
        if (after[`${fld}_rank`] < before[`${fld}_rank`]) bad++;
        if (after[`${fld}_usd`] !== before[`${fld}_usd`] && !(o[`${fld}_rank`] > before[`${fld}_rank`])) bad++;
      }
      if (before.price != null && after.price !== before.price) bad++;
    }
  }
  return bad;
}

test('planted faults: a worse source never overwrites a better one, and the check catches a guard that lets it', noSql, async () => {
  assert.equal(downgrades(await ready(), dayStatements), 0);
  const plant = (from, to) => (rows, s) => dayStatements(rows, s).map((x) => ({ ...x, sql: x.sql.replaceAll(from, to) }));
  assert.ok(downgrades(await ready(), plant('excluded.fees_rank > pool_day.fees_rank', '1 = 1')) > 0);           // no fee guard
  assert.ok(downgrades(await ready(), plant('MAX(pool_day.tvl_rank, excluded.tvl_rank)', 'excluded.tvl_rank')) > 0); // a rank that can fall
  assert.ok(downgrades(await ready(), plant('COALESCE(pool_day.price, excluded.price)', 'excluded.price')) > 0);   // price replaced
});

test('dayUpgrade and hourUpgrade say exactly what the SQL guard writes (random rows on SQLite)', noSql, async () => {
  const f = await ready();
  const rnd = rng(11);
  const rand = () => {
    const fs = [null, 'e', 'x', 's'][rnd(4)], vs = [null, 'g', 's'][rnd(3)], ts = [null, 'r', 'b'][rnd(3)];
    return day({ fees_usd: fs ? rnd(50) : null, fees_src: fs, fees_rank: fs ? RANK.fees[fs] : 0, fees_unconfirmed: fs ? rnd(2) : null, volume_usd: vs ? rnd(50) : null, volume_src: vs,
      volume_rank: vs ? RANK.volume[vs] : 0, tvl_usd: ts ? rnd(50) : null, tvl_src: ts, tvl_rank: ts ? 1 : 0, price: rnd(2) ? null : 1 + rnd(5), lp_fee_rate: rnd(2) ? null : 0.003 });
  };
  for (let i = 0; i < 200; i++) {
    const id = '0x' + i.toString(16).padStart(40, '0'), a = { ...rand(), pool_id: id }, b = { ...rand(), pool_id: id };
    write(f, [a]);
    const s = one(f, `SELECT fees_rank fr, volume_rank vr, tvl_rank tr, price IS NOT NULL hp, lp_fee_rate IS NOT NULL hr FROM pool_day WHERE pool_id = '${id}'`);
    assert.equal(write(f, [b]) === 1, dayUpgrade(b, { ...s, hp: !!s.hp, hr: !!s.hr }));
  }
  for (let i = 0; i < 200; i++) {
    const r = () => { const fr = rnd(2); return { pool_key: i, hour: 500000, sec: rnd(2) * 30, span_s: fr || rnd(2) ? 3000 + rnd(3) * 300 : null, fees_usd: fr ? rnd(9) : null, fees_rank: fr,
      price: rnd(2) ? 1 : null, liquidity: rnd(2) ? 5 : null, parked: rnd(2) ? 0.1 : null }; };
    const a = r(), b = r();
    write(f, [a], hourStatements);
    const s = one(f, `SELECT fees_rank fr, sec, span_s span, price IS NOT NULL hp, liquidity IS NOT NULL hl, parked IS NOT NULL hk FROM pool_hour WHERE pool_key = ${i}`);
    assert.equal(write(f, [b], hourStatements) === 1, hourUpgrade(b, { ...s, hp: !!s.hp, hl: !!s.hl, hk: !!s.hk }));
  }
});

test('pool_hour: a narrower span replaces the row (a backfilled gap), a wider or unread one never does', noSql, async () => {
  const f = await ready();
  const h = (o) => ({ pool_key: 1, hour: 500000, sec: 30, span_s: 7200, fees_usd: 2, fees_rank: 1, price: null, liquidity: 5, parked: 0.1, ...o });
  const row = () => ({ ...one(f, 'SELECT span_s, fees_usd, price, revisions FROM pool_hour') });
  assert.equal(write(f, [h()], hourStatements), 1);
  assert.equal(write(f, [h()], hourStatements), 0);                                             // the same row: nothing
  assert.equal(write(f, [h({ span_s: 9000, fees_usd: 3 })], hourStatements), 0);               // wider: never
  assert.equal(write(f, [h({ span_s: null, fees_usd: null, fees_rank: 0 })], hourStatements), 0); // unread: never
  assert.equal(write(f, [h({ span_s: 3600, fees_usd: 1 })], hourStatements), 1);               // the gap before it got its own row
  assert.equal(write(f, [h({ span_s: 1800, fees_usd: 0.5, sec: 0 })], hourStatements), 0);     // another moment in the hour: not the same row
  assert.equal(write(f, [h({ span_s: 3600, fees_usd: 9, price: 1.7 })], hourStatements), 1);   // a null price gains its value, nothing else moves
  assert.deepEqual(row(), { span_s: 3600, fees_usd: 1, price: 1.7, revisions: 2 });
});

test('statements: every row once and in order, each under the byte and row caps; a full one runs on SQLite', noSql, async () => {
  const tuples = Array.from({ length: 1000 }, (_, i) => `(${i},'${'x'.repeat(i % 37)}')`);
  const st = statements(tuples, 'INSERT INTO t VALUES ', ' ON CONFLICT DO NOTHING', { maxBytes: 2000, maxRows: 50 });
  assert.ok(st.every((s) => Buffer.byteLength(s.sql) <= 2000 && s.rows <= 50));
  assert.equal(st.map((s) => s.sql.slice('INSERT INTO t VALUES '.length, -' ON CONFLICT DO NOTHING'.length)).join(','), tuples.join(','));
  const f = await ready();
  const rows = Array.from({ length: 900 }, (_, i) => day({ pool_id: '0x' + i.toString(16).padStart(64, '0'), ...fee('x', 1234.5678 + i), volume_usd: 99999.99, volume_src: 'g', volume_rank: 1,
    tvl_usd: 12345678.9, tvl_src: 'b', tvl_rank: 1, price: 0.000123456789, lp_fee_rate: 0.00066 }));
  const ds = dayStatements(rows, nowS);
  assert.equal(ds.length, 3);
  assert.ok(ds.every((s) => s.rows <= LIMITS.stmtRows && Buffer.byteLength(s.sql) <= LIMITS.stmtBytes && Buffer.byteLength(s.sql) < 100_000));
  assert.equal(write(f, rows), 900);
  const ps = poolStatements(archivePools({ [P1]: hpOf() }, live).map((p) => p.meta), nowS);
  for (const s of ps) f.db.prepare(s.sql).run();
  assert.equal(one(f, 'SELECT symbol0 FROM pools').symbol0, "O'Neil");
});

test('client: 429 and 5xx retried, a 400 not; the error is a category word, never the token, the account or the API\'s text', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? { ok: false, status: n === 1 ? 429 : 503, json: async () => ({ success: false }) } : { ok: true, status: 200, json: async () => ({ success: true, result: [{ success: true, results: [], meta: { rows_written: 2 } }] }) });
  const c = makeClient({ accountId: ACCT, token: TOKEN, fetchImpl: flaky, sleep: noSleep });
  assert.equal((await c.query('db', 'SELECT 1')).meta.rows_written, 2);
  assert.deepEqual(c.stats, { calls: 3, retries: 2 });
  n = 0;
  const bad = async () => { n++; return { ok: false, status: 400, json: async () => ({ success: false, errors: [{ message: `SQLITE_ERROR near ${ACCT} ${TOKEN}` }] }) }; };
  const e = await makeClient({ accountId: ACCT, token: TOKEN, fetchImpl: bad, sleep: noSleep }).query('db', 'x').catch((x) => x);
  assert.ok(e instanceof D1Error);
  assert.equal(e.category, 'sql');
  assert.equal(n, 1);
  assert.ok(!e.message.includes(ACCT) && !e.message.includes(TOKEN) && !/SQLITE/.test(e.message));
  const net = await makeClient({ accountId: ACCT, token: TOKEN, fetchImpl: async () => { throw new Error(`connect failed https://api.cloudflare.com/client/v4/accounts/${ACCT}`); }, sleep: noSleep }).query('db', 'x').catch((x) => x);
  assert.equal(net.category, 'network');
  assert.ok(!net.message.includes(ACCT));
  assert.deepEqual([categoryOf(401), categoryOf(403), categoryOf(404), categoryOf(429), categoryOf(502), categoryOf(400, { errors: [{ message: 'rows written daily limit exceeded' }] }),
    categoryOf(400, { errors: [{ message: 'SQLITE_TOOBIG' }] }), categoryOf(400, {})], ['auth', 'auth', 'notfound', 'rate', 'server', 'limit', 'size', 'request']);
  assert.throws(() => makeClient({ accountId: 'not-hex', token: TOKEN }), (x) => x.category === 'account');
  assert.throws(() => makeClient({ accountId: ACCT, token: '' }), (x) => x.category === 'skipped');
  let auth = null;
  await makeClient({ accountId: ACCT, token: TOKEN, fetchImpl: async (u, o) => { auth = o.headers.authorization; return { ok: true, status: 200, json: async () => ({ success: true, result: [] }) }; } }).findDb();
  assert.equal(auth, `Bearer ${TOKEN}`); // the token goes in the header only, never the URL
});

test('client: only assim-ls resources are created; a database is found by its exact name', noSql, async () => {
  const f = fakeD1({ dbs: [{ uuid: 'other', name: 'assim-ls-archive-old' }] });
  const c = f.client();
  assert.equal(await c.findDb('assim-ls-archive'), null);
  await assert.rejects(c.createDb('something-else'), (e) => e.category === 'name');
  assert.equal(await c.createDb('assim-ls-archive'), 'db-new');
  assert.equal(await c.findDb('assim-ls-archive'), 'db-new');
  assert.equal(await c.verify(), true);
});

test('d1Pass never fails the pass: no secrets, no database, a network failure, a broken answer', noSql, async () => {
  let called = 0;
  const r0 = await d1Pass({ env: {}, history: { [P1]: hpOf() }, live, now: NOW, fetchImpl: async () => { called++; throw new Error('x'); } });
  assert.equal(r0.line, 'd1: skipped');
  assert.equal(called, 0);
  assert.equal((await d1Pass({ env: { CF_ACCOUNT_ID: ACCT }, history: {}, now: NOW })).line, 'd1: skipped');
  assert.equal((await d1Pass({ env: { ...ENV, CF_ACCOUNT_ID: 'xyz' }, history: {}, now: NOW })).line, 'd1: error account');
  const f = fakeD1({ dbs: [] });
  assert.equal((await d1Pass({ env: ENV, history: { [P1]: hpOf() }, live, now: NOW, fetchImpl: f.fetchImpl, sleep: noSleep })).line, 'd1: error nodb');
  const down = await d1Pass({ env: ENV, history: { [P1]: hpOf() }, live, now: NOW, fetchImpl: async () => { throw new TypeError('fetch failed'); }, sleep: noSleep });
  assert.equal(down.line, 'd1: error network');
  const g = await ready();
  let k = 0, armed = false;
  const mid = fakeD1({ fail: () => (armed && ++k > 4 ? { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } } : null) });
  await migrate(mid.client(), 'db-1', { nowS });
  armed = true;
  const r = await d1Pass({ env: ENV, history: { [P1]: hpOf() }, live, now: NOW, fetchImpl: mid.fetchImpl, sleep: noSleep });
  assert.match(r.line, /^d1: error [a-z]+$/);
  assert.ok(g); // the healthy fake is untouched
});

test('d1Pass end to end: pools, the daily sweep once a day, the passes\' settled hours, idempotent, upgrades the next day', noSql, async () => {
  const f = await ready();
  const hist = { [P1]: hpOf(), [P2]: hpOf({ src: 'x' }), [P4]: hpOf({ days: 3 }) };
  const pass = (now = NOW, h = hist) => d1Pass({ env: ENV, history: h, live, now, fetchImpl: f.fetchImpl, sleep: noSleep });
  const r1 = await pass();
  assert.equal(r1.sweep, true);
  assert.equal(r1.sweepDone, true);
  assert.equal(r1.days, 23);
  // settled hours: the hour started at least 2 h before the pass (the made-up rows reach 02:00:30 on the pass's day)
  const settled = hist[P1].h.filter((x) => Math.floor(x[0] / HOUR) * HOUR + 2 * HOUR <= NOW).length;
  assert.equal(r1.hours, 3 * settled);
  assert.equal(one(f, 'SELECT COUNT(*) n FROM pools').n, 3);
  assert.equal(one(f, 'SELECT COUNT(*) n FROM pool_day').n, 23);
  assert.equal(one(f, 'SELECT COUNT(*) n FROM pool_hour').n, 3 * settled);
  assert.equal(one(f, "SELECT n FROM meta WHERE k = 'w:2026-11-22'").n, 3 + 23 + 3 * settled);
  assert.equal(r1.line, `d1: 3 pools, 23 day rows, ${3 * settled} hour rows written (+3 pool rows) · daily sweep done`);
  assert.ok(!/0x|[0-9a-f]{8}/i.test(r1.line.replace(/\d[\d,]*/g, '')) && !r1.line.includes(ACCT)); // counts only
  // the next pass, same day: no sweep, nothing new
  const r2 = await pass(NOW + 6 * 60e3);
  assert.deepEqual([r2.sweep, r2.days, r2.hours, r2.poolRows], [false, 0, 0, 0]);
  assert.equal(r2.line, 'd1: 3 pools, 0 day rows, 0 hour rows written');
  // a day turns exact later the same day: kept for the next day's sweep; an hour passes: the pass writes it
  const h2 = structuredClone(hist);
  h2[P1].y[0] = [h2[P1].y[0][0], 11.5, 'x'];
  h2[P1].h.push([NOW + 30e3, 1.6, 1e20, 0.7, 0.25]);
  const r3 = await pass(NOW + 2 * HOUR, h2);
  assert.deepEqual([r3.sweep, r3.days, r3.hours], [false, 0, 3 + 1]); // the 02:00 hour of each pool is settled now, and P1's new 03:00 row
  assert.equal(one(f, `SELECT fees_src FROM pool_day WHERE pool_id = '${P1}' AND day_utc = '2026-11-12'`).fees_src, 'e');
  const r4 = await pass(NOW + DAY, h2);
  assert.deepEqual([r4.sweep, r4.sweepDone, r4.days], [true, true, 1]);
  assert.deepEqual({ ...one(f, `SELECT fees_usd, fees_src, revisions FROM pool_day WHERE pool_id = '${P1}' AND day_utc = '2026-11-12'`) }, { fees_usd: 11.5, fees_src: 'x', revisions: 1 });
  // before 01:00 UTC no sweep starts
  assert.equal((await pass(Date.UTC(2026, 10, 24, 0, 30), h2)).sweep, false);
});

test('sync: a sweep cut by the time cap resumes where it stopped; one cut by the budget waits for the next day and leaves the passes room', noSql, async () => {
  const many = {};
  for (let i = 0; i < 90; i++) many['0x' + (i + 1).toString(16).padStart(40, '0')] = hpOf({ days: 2, hours: 3 });
  const f = await ready();
  const c = f.client();
  let t = NOW, ticks = 0;
  const clock = () => { ticks++; return t; };
  // the clock passes the deadline after the first group's writes
  const cutAfter = (n) => () => (++ticks > n ? Infinity : NOW);
  const r1 = await sync(c, 'db-1', { history: many, now: NOW, sweep: 'auto', clock: cutAfter(5), hours: false }); // start, new pools, group 1 (check, pools, days)
  assert.equal(r1.groups, 3);
  assert.equal(r1.cut, 'time');
  assert.equal(r1.groupsDone, 1);
  const sw = one(f, "SELECT v, n FROM meta WHERE k = 'sweep'");
  assert.deepEqual({ ...sw }, { v: '2026-11-22', n: r1.groupsDone });
  ticks = 0;
  const r2 = await sync(c, 'db-1', { history: many, now: NOW + 6 * 60e3, sweep: 'auto', clock, hours: false });
  assert.equal(r2.sweepDone, true);
  assert.equal(one(f, 'SELECT COUNT(*) n FROM pool_day').n, 180); // every day once: none lost, none twice
  assert.equal(r1.days + r2.days, 180);
  // the budget: the sweep stops 12,000 short of the day's cap; the passes keep writing up to it
  const g = await ready();
  const gc = g.client();
  const rb = await sync(gc, 'db-1', { history: many, now: NOW, sweep: true, clock, sweepBudget: 150, hours: false });
  assert.equal(rb.cut, 'budget');
  assert.ok(rb.poolRows + rb.days + rb.hours <= 150);
  assert.equal(one(g, "SELECT n FROM meta WHERE k = 'w:2026-11-22'").n, rb.poolRows + rb.days + rb.hours);
  const rn = await sync(gc, 'db-1', { history: many, now: NOW + 6 * 60e3, sweep: 'auto', clock, sweepBudget: 150 });
  assert.equal(rn.sweep, false); // today's sweep ended at the budget
  assert.equal(rn.hours, 180);   // the passes' hours still go, within the day's whole cap
  const next = await sync(gc, 'db-1', { history: many, now: NOW + DAY, sweep: 'auto', clock });
  assert.equal(next.sweepDone, true);
  assert.equal(one(g, 'SELECT COUNT(*) n FROM pool_day').n, 180);
  t = NOW;
});

test('passLine: counts and caps only', () => {
  assert.equal(passLine({ pools: 50, days: 50, hours: 1200, poolRows: 0, sweep: false }), 'd1: 50 pools, 50 day rows, 1,200 hour rows written');
  assert.equal(passLine({ pools: 300, days: 9000, hours: 0, poolRows: 2, sweep: true, sweepDone: false, groupsDone: 3, groups: 8, cut: 'time' }),
    'd1: 300 pools, 9,000 day rows, 0 hour rows written (+2 pool rows) · daily sweep 3 more of 8 pool groups · stopped by the time cap');
});

test('the d1 job: check, setup (created, then already there), import, verify (PASS; a planted change FAILs); counts and dates only', noSql, async () => {
  const f = fakeD1({ dbs: [] });
  const out = [];
  const job = (mode, o = {}) => runJob(mode, { env: ENV, fetchImpl: f.fetchImpl, say: (s) => out.push(`${mode}: ${s}`), now: NOW, ...o });
  const hist = { [P1]: hpOf({ days: 8 }), [P2]: hpOf({ days: 8, src: 's' }) };
  const load = async () => ({ history: hist, live, exclude: [] });
  assert.equal(await job('check'), 0);
  assert.ok(out.includes('check: token works: yes') && out.includes('check: database assim-ls-archive exists: no'));
  assert.equal(await job('setup'), 0);
  assert.equal(await job('setup'), 0);
  assert.ok(out.includes('setup: database assim-ls-archive: created') && out.includes('setup: database assim-ls-archive: already there') && out.includes('setup: tables present: 5 of 5'));
  assert.equal(await job('import', { load }), 0);
  assert.equal(one(f, 'SELECT COUNT(*) n FROM pool_day').n, 16);
  assert.equal(await job('import', { load }), 0); // idempotent
  assert.equal(one(f, 'SELECT COUNT(*) n FROM pool_day').n, 16);
  assert.equal(one(f, 'SELECT SUM(revisions) n FROM pool_day').n, 0);
  assert.equal(await job('verify', { load }), 0);
  assert.match(out.at(-2), /cross-check: 12 random pool-days of those pools \(of 12 over 4 days old\): 12 match/);
  assert.equal(await job('verify', { load: async () => ({ history: { ...hist, [P4]: hpOf({ days: 8 }) }, live, exclude: [] }) }), 0); // a pool the import hasn't reached
  assert.ok(out.includes("verify: coverage: D1 holds days of 2 of the 3 pools in history.json (the import resumes with its next run or the loop's daily sweep)"));
  assert.equal(out.at(-1), 'verify: PASS');
  f.db.prepare(`UPDATE pool_day SET fees_usd = fees_usd * 2 WHERE pool_id = '${P2}'`).run(); // a planted fault: D1 no longer holds what the history says
  assert.equal(await job('verify', { load }), 1);
  assert.equal(out.at(-1), 'verify: FAIL');
  const text = out.join('\n');
  assert.ok(!text.includes(ACCT) && !text.includes(TOKEN) && !/0x[0-9a-f]/i.test(text) && !text.includes('db-new'));
});
