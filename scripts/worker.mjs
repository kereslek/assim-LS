// The archive API's jobs (.github/workflows/worker.yml; worker/, lib/apiauth.mjs; docs/DATA.md "Archive API"):
//   node scripts/worker.mjs deploy    the KV namespace assim-ls-auth (created if missing; its id recorded in D1's meta), the
//                                     Worker assim-ls-api uploaded with its bindings (D1, KV, the build), its workers.dev
//                                     route on; prints the Worker's host (public anyway) and a smoke check
//   node scripts/worker.mjs test      every endpoint with made-up test tokens put in KV for 10 minutes (removed at the end)
//   node scripts/worker.mjs sync      the loop's token sync once (needs the restored sealed data and LOCK_PASSPHRASE), then
//                                     the owner's and every slot's token, derived as the pages derive them, must be accepted
//   node scripts/worker.mjs cleanup   remove any test token left in KV (the workflow's safety net)
// Needs CF_ACCOUNT_ID and CF_API_TOKEN. Prints yes/no, status codes, counts, seconds, the host and category words only:
// never the account, a token or its hash, an id, a pool, a value or an API message (Cloudflare's numeric codes at most).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CfError, KV_TITLE, WORKER, authSync, cfClient, nsFromD1, nsToD1 } from '../lib/apiauth.mjs';
import { apiTokenFor, tokenHash } from '../lib/apitoken.mjs';
import { DB_NAME, D1Error, makeClient } from '../lib/d1.mjs';
import { ORIGIN, PRESETS } from '../worker/api.mjs';

export const COMPAT_DATE = '2025-09-01';
const NS_RE = /^[0-9a-f]{32}$/;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const WORD_RE = /^[a-z]+$/;

const testToken = () => 'lps1.' + crypto.randomBytes(32).toString('base64url');

// A request to the Worker: { status, body (text), json, headers }. Never prints anything.
function worker(host, fetchImpl) {
  return async (path, { token = null, origin = null, method = 'GET', headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (origin) h.origin = origin;
    try {
      const res = await fetchImpl(`https://${host}${path}`, { method, headers: h, signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      let json = null;
      try { json = JSON.parse(body); } catch { json = null; }
      return { status: res.status, body, json, headers: res.headers };
    } catch { return { status: 0, body: '', json: null, headers: new Headers() }; }
  };
}
// poll until ok(answer) or the time is up: { r, s (seconds waited), ok }
async function until(fn, ok, { maxMs, everyMs, wait, clock }) {
  const t0 = clock();
  for (;;) {
    const r = await fn();
    if (ok(r)) return { r, s: Math.round((clock() - t0) / 1000), ok: true };
    if (clock() - t0 + everyMs > maxMs) return { r, s: Math.round((clock() - t0) / 1000), ok: false };
    await wait(everyMs);
  }
}

async function hostOf(c, say) {
  const sub = await c.accountSubdomain();
  if (!sub) { say('workers.dev subdomain of the account: none (set one in the dashboard: Workers & Pages, then deploy again)'); return null; }
  return `${WORKER}.${sub}.workers.dev`;
}

export async function run(mode, { env = process.env, say = (s) => console.log(`worker ${mode}: ${s}`), fetchImpl = globalThis.fetch, wait = pause, clock = Date.now,
  read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), lock = null, outDir = 'out/data' } = {}) {
  const opt = { accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, fetchImpl };
  const c = cfClient({ ...opt, tries: 3, timeoutMs: 30_000, sleep: wait });
  const d1 = makeClient({ ...opt, sleep: wait });
  const db = await d1.findDb(DB_NAME);
  say(`database ${DB_NAME} exists: ${db ? 'yes' : 'no'}`);
  if (!db) return 1;

  if (mode === 'deploy') {
    // the namespace: as recorded in D1, else the Worker's own binding, else made now; its id is recorded (never printed)
    let ns = await nsFromD1(d1, db), how = 'already there';
    const titled = async (id) => { try { return (await c.nsTitle(id)) === KV_TITLE; } catch (e) { if (e.category === 'notfound' || e.category === 'request') return false; throw e; } };
    if (ns && !(await titled(ns))) ns = null;
    if (!ns) {
      const b = (await c.workerSettings())?.bindings?.find((x) => x && x.type === 'kv_namespace' && x.name === 'AUTH');
      if (b && NS_RE.test(String(b.namespace_id)) && (await titled(b.namespace_id))) ns = b.namespace_id;
    }
    if (!ns) { ns = await c.nsCreate(KV_TITLE); how = 'created'; }
    await nsToD1(d1, db, ns);
    say(`KV namespace ${KV_TITLE}: ${how}; its id recorded in the archive's meta: yes`);
    const build = /^[0-9a-f]{40}$/.test(String(env.BUILD)) ? env.BUILD.slice(0, 12) : 'local';
    const modules = { 'index.mjs': read('worker/index.mjs'), 'api.mjs': read('worker/api.mjs') };
    await c.workerUpload({ main_module: 'index.mjs', compatibility_date: COMPAT_DATE, bindings: [
      { type: 'd1', name: 'DB', id: db }, { type: 'kv_namespace', name: 'AUTH', namespace_id: ns }, { type: 'plain_text', name: 'BUILD', text: build },
    ] }, modules);
    say(`Worker ${WORKER}: uploaded (build ${build}; bindings: the archive, the token hashes, the build)`);
    await c.workerOnSubdomain();
    say('workers.dev route: on');
    const host = await hostOf(c, say);
    if (!host) return 1;
    say(`Worker host: ${host}`);
    const call = worker(host, fetchImpl);
    const s = await until(() => call('/v1/meta'), (r) => r.status === 401, { maxMs: 120e3, everyMs: 10e3, wait, clock });
    say(`smoke: /v1/meta without a token answers ${s.r.status} '${WORD_RE.test(s.r.body) ? s.r.body : '?'}' (401 'auth' expected; after ${s.s} s): ${s.ok && s.r.body === 'auth' ? 'pass' : 'FAIL'}`);
    return s.ok && s.r.body === 'auth' ? 0 : 1;
  }

  const ns = await nsFromD1(d1, db);
  say(`KV namespace recorded: ${ns ? 'yes' : 'no (run deploy first)'}`);
  if (!ns) return 1;

  if (mode === 'cleanup') {
    const left = [...(await c.list(ns))].filter(([k, x]) => /^t:/.test(k) && x?.metadata?.k === 'test').map(([k]) => k);
    if (left.length) await c.del(ns, left);
    say(`test tokens removed: ${left.length}`);
    return 0;
  }

  const host = await hostOf(c, say);
  if (!host) return 1;
  const call = worker(host, fetchImpl);
  const results = [];
  const check = (name, ok, info) => { results.push(ok); say(`${name}: ${info}: ${ok ? 'pass' : 'FAIL'}`); return ok; };
  const seen = [];
  const watch = (r) => { seen.push(r); return r; };
  const poll = (fn, ok, maxMs = 150e3) => until(fn, ok, { maxMs, everyMs: 10e3, wait, clock });

  if (mode === 'sync') {
    // the loop's sync, once, from the restored sealed data (inside this job only)
    const { openLock } = await import('../lib/lock.mjs');
    const { openStore } = await import('../lib/store.mjs');
    const { readKeysFile, reopen, unwrapSlot, tryUnwrap } = await import('../lib/keyring.mjs');
    const { keys } = lock || openLock();
    const store = openStore({ keys, outDir });
    const r = await authSync({ env, keys, store, outDir, force: true, fetchImpl, sleep: wait, now: clock() });
    say(r.line);
    if (r.error) return 1;
    // the tokens as the pages derive them: the owner's from the master slot, each friend's from their own slot
    const kf = readKeysFile(outDir), v = reopen(keys, kf);
    const owner = await apiTokenFor(unwrapSlot(kf.mk, v.mk, 'master'));
    const G = store.get('guests.json');
    const slots = [];
    for (const g of (G?.guests || []).filter((x) => x.st === 'active' && typeof x.kek === 'string')) {
      const kek = Buffer.from(g.kek, 'base64');
      for (const s of kf.slots) { const o = tryUnwrap(s, kek, 'guest'); if (o && typeof o.k === 'string') { if (!(Number.isFinite(o.e) && o.e <= clock() + 120e3)) slots.push({ tok: await apiTokenFor(o), role: o.r === 'member' ? 'member' : 'guest' }); break; } }
    }
    const o = await poll(() => call('/v1/meta', { token: owner }), (x) => x.status === 200);
    check(`the owner's token, derived as the page derives it`, o.ok && o.r.json?.role === 'owner', `${o.r.status}, role ${o.r.json?.role === 'owner' ? 'owner' : 'other'} (after ${o.s} s)`);
    let okN = 0, roleN = 0;
    for (const s of slots) {
      const x = await poll(() => call('/v1/meta', { token: s.tok }), (y) => y.status === 200);
      if (x.ok) okN++;
      if (x.r.json?.role === s.role) roleN++;
    }
    check('each live slot\'s token, derived as that guest\'s page derives it', okN === slots.length && roleN === slots.length, `${okN} of ${slots.length} accepted, ${roleN} with the slot's role`);
    const m = await call('/v1/meta', { token: testToken() });
    check('a made-up token', m.status === 401 && m.body === 'auth', `${m.status}`);
    const ok = results.every(Boolean);
    say(ok ? 'PASS' : 'FAIL');
    return ok ? 0 : 1;
  }

  if (mode !== 'test') { say('mode is deploy, test, sync or cleanup: no'); return 1; }
  // three made-up tokens: A for every check, B already ended (its end is in the past), C removed mid-test (then refused)
  const now0 = clock();
  const toks = { A: testToken(), B: testToken(), C: testToken() };
  const hash = {};
  for (const [k, t] of Object.entries(toks)) hash[k] = await tokenHash(t);
  const item = (k, e) => ({ key: `t:${hash[k]}`, value: JSON.stringify({ r: 'test', e }), metadata: { r: 'test', e, k: 'test', g: -1 }, expiration_ttl: 600 });
  await c.put(ns, [item('A', now0 + 600e3), item('B', now0 - 60e3), item('C', now0 + 600e3)]);
  say('test tokens put in KV (they end in 10 minutes by themselves): yes');
  const A = toks.A;
  try {
    let r = watch(await call('/v1/meta', { method: 'OPTIONS', origin: ORIGIN, headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } }));
    check('preflight from the dashboard', r.status === 204 && r.headers.get('access-control-allow-origin') === ORIGIN && /authorization/i.test(r.headers.get('access-control-allow-headers') || ''), `${r.status}`);
    r = watch(await call('/v1/meta', { method: 'OPTIONS', origin: 'https://example.com', headers: { 'access-control-request-method': 'GET' } }));
    check('preflight from another origin', r.status === 403 && !r.headers.get('access-control-allow-origin'), `${r.status}`);
    r = watch(await call('/v1/meta'));
    check('no token', r.status === 401 && r.body === 'auth', `${r.status}`);
    r = watch(await call('/v1/meta', { token: 'lps1.short' }));
    check('a malformed token', r.status === 401, `${r.status}`);
    // KV is eventually consistent: a new hash reaches the Worker within about a minute
    const both = await poll(async () => [await call('/v1/meta', { token: A }), await call('/v1/meta', { token: toks.C })], ([x, y]) => x.status === 200 && y.status === 200, 120e3);
    const [a, cc] = both.r;
    watch(a);
    check('two test tokens accepted', both.ok && a.json?.role === 'test' && cc.json?.role === 'test', `${a.status} and ${cc.status} (after ${both.s} s)`);
    r = watch(await call('/v1/meta', { token: toks.B }));
    check('a token whose end has passed', r.status === 401 && r.body === 'auth', `${r.status}`);
    r = watch(await call('/v1/meta', { token: A, origin: 'https://example.com' }));
    check('a good token from another origin', r.status === 403 && r.body === 'origin', `${r.status}`);
    r = watch(await call('/v1/meta', { token: A, origin: ORIGIN }));
    const m = r.json;
    check('meta from the dashboard', r.status === 200 && r.headers.get('access-control-allow-origin') === ORIGIN && Number.isInteger(m?.pools) && m?.v === 1,
      `${r.status}; ${m?.pools ?? '—'} pools, ${m?.days?.pools ?? '—'} with days, ${m?.hours?.pools ?? '—'} with hours; schema ${m?.schema ?? '—'}`);
    let pool = null;
    for (const q of PRESETS) {
      r = watch(await call(`/v1/find?q=${q}&days=30&chain=any`, { token: A }));
      const rows = Array.isArray(r.json?.rows) ? r.json.rows : null;
      const shaped = !!rows && rows.length <= 200 && rows.every((x) => x && typeof x.pool === 'string' && typeof x.day === 'string' && 'value' in x && 'multiple' in x && 'mark' in x)
        && rows.every((x) => r.json.pools && r.json.pools[x.pool]);
      check(`find ${q}`, r.status === 200 && shaped, `${r.status}, ${rows ? rows.length : '—'} rows`);
      if (!pool && rows?.length) pool = rows[0].pool;
    }
    if (pool) {
      r = watch(await call(`/v1/days?pool=${pool}`, { token: A }));
      const all = r.json?.rows?.length ?? null;
      check('days, ALL (a pool from the find answers)', r.status === 200 && all > 0 && r.json.cols?.length === r.json.rows[0]?.length, `${r.status}, ${all ?? '—'} rows`);
      const to = new Date(now0 - 86400e3).toISOString().slice(0, 10), from = new Date(now0 - 30 * 86400e3).toISOString().slice(0, 10);
      r = watch(await call(`/v1/days?pool=${pool}&from=${from}&to=${to}`, { token: A }));
      check('days, the last 30', r.status === 200 && r.json.rows.length <= 30 && r.json.rows.every((x) => x[0] >= from && x[0] <= to), `${r.status}, ${r.json?.rows?.length ?? '—'} rows`);
      r = watch(await call(`/v1/hours?pool=${pool}&from=${new Date(now0 - 7 * 86400e3).toISOString().slice(0, 13)}:00Z`, { token: A }));
      check('hours, the last 7 days', r.status === 200 && r.json.rows.length <= 7 * 24 + 1 && r.json.cols?.length === 6, `${r.status}, ${r.json?.rows?.length ?? '—'} rows`);
      r = watch(await call(`/v1/hours?pool=${pool}&from=${now0 - 10 * 86400e3}&to=${now0 - 86400e3}`, { token: A }));
      check('hours over 9 days', r.status === 400 && r.body === 'input', `${r.status}`);
    } else check('days and hours', false, 'no pool in any find answer');
    r = watch(await call('/v1/days?pool=xyz', { token: A }));
    check('a bad pool id', r.status === 400 && r.body === 'input', `${r.status}`);
    r = watch(await call(`/v1/days?pool=0x${'0'.repeat(39)}1`, { token: A }));
    check('an unknown pool', r.status === 404 && r.body === 'notfound', `${r.status}`);
    r = watch(await call('/v1/find?q=nope', { token: A }));
    check('an unknown preset', r.status === 400 && r.body === 'input', `${r.status}`);
    r = watch(await call('/v1/find?q=quietest&days=3', { token: A }));
    check('a window under 7 days', r.status === 400 && r.body === 'input', `${r.status}`);
    r = watch(await call('/v1/meta?x=1', { token: A }));
    check('an unknown parameter', r.status === 400 && r.body === 'input', `${r.status}`);
    r = watch(await call('/v1/nope', { token: A }));
    check('an unknown route', r.status === 404 && r.body === 'notfound', `${r.status}`);
    r = watch(await call('/v1/meta', { token: A, method: 'POST' }));
    check('a POST', r.status === 405 && r.body === 'method', `${r.status}`);
    // C removed: refused once KV and the Worker's caches let it go (a minute or two)
    await c.del(ns, [`t:${hash.C}`]);
    const gone = await poll(() => call('/v1/meta', { token: toks.C }), (x) => x.status === 401, 180e3);
    watch(gone.r);
    check('the removed test token', gone.ok, `${gone.r.status} (after ${gone.s} s)`);
    check('no-store and noindex on every answer', seen.every((x) => x.status === 0 || (/no-store/.test(x.headers.get('cache-control') || '') && /noindex/.test(x.headers.get('x-robots-tag') || ''))), `${seen.length} answers`);
    check('every refusal one category word', seen.filter((x) => x.status >= 400).every((x) => WORD_RE.test(x.body)), `${seen.filter((x) => x.status >= 400).length} refusals`);
    // the rate limit (counters in each isolate: shown, not judged)
    let limited = 0;
    for (let i = 0; i < 13; i++) { const rs = await Promise.all(Array.from({ length: 10 }, () => call('/v1/meta', { token: A }))); limited += rs.filter((x) => x.status === 429).length; }
    say(`rate limit seen in 130 quick calls: ${limited ? `yes (${limited} answered 429)` : 'no (spread over isolates)'}`);
    const kv = [...(await c.list(ns))].filter(([k]) => /^t:/.test(k)).map(([, x]) => x?.metadata || {});
    const n = (f) => kv.filter(f).length;
    say(`KV tokens: owner ${n((x) => x.k === 'o')}, guest ${n((x) => x.k === 's' && x.r === 'guest')}, member ${n((x) => x.k === 's' && x.r === 'member')}, grace ${n((x) => x.k === 'p')}, test ${n((x) => x.k === 'test')}`);
  } finally {
    try { await c.del(ns, Object.values(hash).map((h) => `t:${h}`)); say('test tokens removed: yes'); } catch (e) { say(`test tokens removed: no (${e.category || 'internal'}; cleanup runs next)`); }
  }
  const ok = results.length > 0 && results.every(Boolean);
  say(`${results.filter(Boolean).length} of ${results.length} checks pass: ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const mode = process.argv[2];
  run(mode).then((code) => process.exit(code), (e) => {
    const lock = /^(missing|bad|wrong) /.exec(String(e?.message))?.[1]; // the lock's own words (lib/lock.mjs), never a value
    const codes = Array.isArray(e?.codes) && e.codes.length ? ` (codes ${e.codes.join(', ')})` : '';
    console.log(`worker ${mode}: error ${e instanceof CfError || e instanceof D1Error ? e.category + codes : lock ? `lock ${lock}` : 'internal'}`);
    process.exit(1);
  });
}
