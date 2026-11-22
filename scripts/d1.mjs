// The D1 archive's jobs (.github/workflows/d1.yml, lib/d1.mjs, docs/DATA.md "D1 archive"):
//   node scripts/d1.mjs check    does the token work; does the database assim-ls-archive exist (yes/no)
//   node scripts/d1.mjs setup    create assim-ls-archive if missing; apply db/schema.sql's migrations not applied yet
//   node scripts/d1.mjs import   the sweep over the restored history.json (publish-data --restore first): every pool's days
//                                and settled hours D1 lacks or holds from a worse source, within the day's write budget
//   node scripts/d1.mjs verify   row counts and date ranges per table; N random pool-days of history.json against D1
// Needs CF_ACCOUNT_ID and CF_API_TOKEN (and LOCK_PASSPHRASE for import and verify). Prints yes/no, counts, dates and
// category words only: never the account, the token, the database id, a pool, an amount or an API message.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DB_NAME, DAY, HOUR, LIMITS, D1Error, archivePools, dayOf, dayRows, makeClient, migrate, rankOf, RANK, sqlStr, sync } from '../lib/d1.mjs';

const fmt = (n) => Number(n).toLocaleString('en-US');
const hourText = (h) => (h == null ? '—' : new Date(Number(h) * HOUR).toISOString().slice(0, 13) + ':00Z');

// The restored market files (out/data, scripts/publish-data.mjs --restore), opened inside Actions only.
async function market() {
  const { openLock } = await import('../lib/lock.mjs');
  const { openStore } = await import('../lib/store.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const { keys } = openLock();
  const store = openStore({ keys });
  const h = store.get('history.json'), l = store.get('live.json');
  if (!h?.pools) throw new D1Error('nohistory');
  return { history: h.pools, live: l?.pools || [], exclude: loadConfig({ keys }).config.leakSensitive || [], t: h.t };
}

async function dbOf(c, say) {
  const db = await c.findDb(DB_NAME);
  say(`database ${DB_NAME} exists: ${db ? 'yes' : 'no'}`);
  return db;
}

export async function run(mode, { env = process.env, say = (s) => console.log(`d1 ${mode}: ${s}`), fetchImpl, load = market, sample = 200, now = Date.now() } = {}) {
  const c = makeClient({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, ...(fetchImpl ? { fetchImpl } : {}) });
  if (mode === 'check') {
    const ok = await c.verify();
    say(`token works: ${ok ? 'yes' : 'no'}`);
    if (!ok) return 1;
    const db = await dbOf(c, say);
    if (db) {
      let v = null;
      try { v = (await c.raw(db, 'SELECT MAX(version) FROM schema_migrations')).rows[0]?.[0] ?? null; } catch { v = null; }
      say(`schema version: ${v ?? 'none yet'}`);
    }
    return 0;
  }
  if (mode === 'setup') {
    let db = await c.findDb(DB_NAME);
    if (db) say(`database ${DB_NAME}: already there`);
    else { db = await c.createDb(DB_NAME); say(`database ${DB_NAME}: created`); }
    const m = await migrate(c, db);
    say(`schema: ${m.applied} migration${m.applied === 1 ? '' : 's'} applied now, version ${m.version} of ${m.known} known`);
    const t = (await c.raw(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pools', 'pool_day', 'pool_hour', 'meta', 'schema_migrations')")).rows.length;
    say(`tables present: ${t} of 5`);
    return t === 5 ? 0 : 1;
  }
  if (mode === 'import') {
    const db = await dbOf(c, say);
    if (!db) return 1;
    const m = await load();
    const t0 = Date.now();
    const r = await sync(c, db, { ...m, now, sweep: true, fromGroup: 0, deadline: t0 + 25 * 60e3 });
    say(`${fmt(r.pools)} pools; written: ${fmt(r.poolRows)} pool rows, ${fmt(r.days)} day rows, ${fmt(r.hours)} hour rows (sent ${fmt(r.daysSent)} day and ${fmt(r.hoursSent)} hour rows D1 lacked or held from a worse source)`);
    say(`groups done ${r.groupsDone} of ${r.groups}${r.cut ? `; stopped by the ${r.cut} cap: run import again${r.cut === 'budget' ? ' after 00:00 UTC (the day\'s write budget)' : ''}, it resumes` : '; complete'}; ${Math.round((Date.now() - t0) / 1000)} s, ${c.stats.calls} calls`);
    return 0;
  }
  if (mode === 'verify') {
    const db = await dbOf(c, say);
    if (!db) return 1;
    const q = (await c.raw(db, 'SELECT (SELECT COUNT(*) FROM pools), (SELECT COUNT(*) FROM pool_day), (SELECT MIN(day_utc) FROM pool_day), (SELECT MAX(day_utc) FROM pool_day), '
      + '(SELECT COUNT(*) FROM pool_hour), (SELECT MIN(hour) FROM pool_hour), (SELECT MAX(hour) FROM pool_hour), (SELECT COUNT(*) FROM pool_day WHERE revisions > 0), '
      + "(SELECT COUNT(*) FROM pool_day WHERE fees_rank = 3), (SELECT COUNT(*) FROM pool_day WHERE fees_rank = 2), (SELECT COUNT(*) FROM pool_day WHERE fees_rank = 1), (SELECT n FROM meta WHERE k = " + sqlStr('w:' + dayOf(now)) + ')')).rows[0] || [];
    const [pools, days, dMin, dMax, hours, hMin, hMax, revised, ds, dx, de, wToday] = q;
    say(`pools ${fmt(pools)}; pool_day ${fmt(days)} rows (${dMin ?? '—'} to ${dMax ?? '—'}; fees from swaps ${fmt(ds)}, counters ${fmt(dx)}, estimated ${fmt(de)}, unread ${fmt(days - ds - dx - de)}; revised ${fmt(revised)}); `
      + `pool_hour ${fmt(hours)} rows (${hourText(hMin)} to ${hourText(hMax)}); written today ${fmt(wToday ?? 0)} of the ${fmt(LIMITS.daily)} budget`);
    // the cross-check: random pool-days over 4 days old (a newer day may still gain its candle's prices), D1 against history.json
    const m = await load();
    const cutoff = Math.floor(now / DAY) * DAY - 4 * DAY;
    const cand = archivePools(m.history, m.live, m.exclude).flatMap((p) => dayRows(p.id, p.hp, p.rate)).filter((r) => Date.parse(r.day_utc) < cutoff);
    for (let i = cand.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    const pick = cand.slice(0, sample), got = new Map();
    for (let i = 0; i < pick.length; i += 50) {
      const part = pick.slice(i, i + 50);
      const sql = 'SELECT pool_id, day_utc, fees_usd, fees_src, volume_usd, volume_src, tvl_usd, tvl_src FROM pool_day WHERE '
        + part.map((r) => `(pool_id = ${sqlStr(r.pool_id, 66)} AND day_utc = ${sqlStr(r.day_utc)})`).join(' OR ');
      for (const x of (await c.raw(db, sql)).rows) got.set(`${x[0]}|${x[1]}`, x);
    }
    const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
    let match = 0, behind = 0, differ = 0, missing = 0;
    for (const r of pick) {
      const x = got.get(`${r.pool_id}|${r.day_utc}`);
      if (!x) { missing++; continue; }
      const f = [['fees', RANK.fees, 2, 3], ['volume', RANK.volume, 4, 5], ['tvl', RANK.tvl, 6, 7]];
      if (f.some(([k, t, , si]) => r[`${k}_rank`] > rankOf(t, x[si]))) { behind++; continue; } // history has a better source since: the next sweep takes it
      if (f.every(([k, t, vi, si]) => rankOf(t, x[si]) === r[`${k}_rank`] && x[si] === r[`${k}_src`] && same(x[vi], r[`${k}_usd`]))) match++; else differ++;
    }
    say(`cross-check: ${pick.length} random pool-days (of ${fmt(cand.length)} over 4 days old): ${match} match (value and source), ${behind} behind (a better source since: the next sweep), ${differ} differ, ${missing} missing`);
    const ok = pick.length > 0 && differ === 0 && missing === 0;
    say(ok ? 'PASS' : 'FAIL');
    return ok ? 0 : 1;
  }
  say('mode is check, setup, import or verify: no');
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const mode = process.argv[2];
  run(mode).then((code) => process.exit(code), (e) => {
    const lock = /^(missing|bad|wrong) /.exec(String(e?.message))?.[1]; // the lock's own words (lib/lock.mjs), never a value
    console.log(`d1 ${mode}: error ${e instanceof D1Error ? e.category : lock ? `lock ${lock}` : 'internal'}`);
    process.exit(1);
  });
}
