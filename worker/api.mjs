// The archive's read API (docs/DATA.md "Archive API", docs/briefs/SQL-plan.md part 2): the Cloudflare Worker assim-ls-api in
// front of the D1 archive assim-ls-archive (lib/d1.mjs). Read-only, GET only, market data only. Plain module syntax, no
// dependencies: worker/index.mjs is the deployed entry (it exports only the handler); this file holds the logic and the SQL
// so the tests run them on SQLite (test/worker.test.mjs).
//   GET /v1/meta                                  coverage, date ranges, the last write
//   GET /v1/days?pool=<id>[&from=YYYY-MM-DD][&to=YYYY-MM-DD]   a pool's daily rows, any range up to ALL
//   GET /v1/hours?pool=<id>&from=<iso|ms>[&to=<iso|ms>]        a pool's hourly rows, at most 8 days a call (default 7)
//   GET /v1/find?q=spikes10x|doubled|quietest|outliers[&days=30][&chain=any]   a ranked list, at most 200
// - Auth: Authorization: Bearer lps1.<43> (lib/apitoken.mjs). KV AUTH holds 't:' + SHA-256(token) → { r: role, e: end ms|null };
//   nothing else about a token is ever kept or logged. An end in the past, a missing hash or a bad shape: 401.
// - CORS: only the dashboard's origin. A request with another Origin is refused (403); one without (a job, curl) needs a token.
// - Rate limits: counters in the isolate, per token hash (and per address for failed tokens, before any KV read).
// - Errors: the body is one category word (auth, rate, input, notfound, method, origin, server, unavailable).
// - Missing is never zero: a null in D1 is null in the answer. Every query is parameterised; every input validated first.
// - Rows read (D1's free plan: 5 million a day): every query seeks by a primary key (the find presets go pool by pool with
//   CROSS JOIN from the small pools table), and meta and find answers are kept in the isolate for a few minutes.
export const ORIGIN = 'https://kereslek.github.io';
export const ROLES = Object.freeze(['owner', 'member', 'guest', 'test']);
export const PRESETS = Object.freeze(['spikes10x', 'doubled', 'quietest', 'outliers']);
const H = 3600e3, D = 86400e3;
export const LIMITS = Object.freeze({
  dayRows: 4000,                       // a /v1/days answer (more: { more: true }, ask again from the last day)
  hoursMaxMs: 8 * D, hoursDefaultMs: 7 * D,
  findMax: 200, findDays: [7, 365], findDefaultDays: 30,
  rate: { windowMs: 60e3, token: 120, find: 20, bad: 60, badWindowMs: 600e3 },
  authCacheMs: 60e3, metaCacheMs: 120e3, findCacheMs: 300e3, kvCacheTtl: 60,
});
// the page's standout rule (site/app/index.html hsMarks): high ≥ 10× the median of the confirmed days, outlier ≥ 3× and
// either unconfirmed or its fee÷vol beyond 2.5× or under 0.4× the median fee÷vol
export const RULE = Object.freeze({ hi: 10, good: 3, rhi: 2.5, rlo: 0.4, doubled: 2, weekMin: 5 });

const ID_RE = /^0x[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TOKEN_RE = /^lps1\.[A-Za-z0-9_-]{43}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/;
const CHAIN_RE = /^[a-z0-9-]{1,24}$/;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const T_MIN = Date.UTC(2015, 0, 1), T_MAX = Date.UTC(2100, 0, 1);

// ---- input -------------------------------------------------------------------------------------------------------
export class InputError extends Error { constructor(word = 'input', status = 400) { super(word); this.word = word; this.status = status; } }
const bad = () => new InputError('input', 400);
// the query's parameters: each at most once, only the allowed names, each at most 200 characters
export function params(url, allowed) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k) || Object.hasOwn(out, k) || v.length > 200) throw bad();
    out[k] = v;
  }
  return out;
}
export function poolParam(x) {
  if (typeof x !== 'string') throw bad();
  const id = x.toLowerCase();
  if (!ID_RE.test(id)) throw bad();
  return id;
}
export function dayParam(x) {
  if (typeof x !== 'string' || !DAY_RE.test(x)) throw bad();
  const t = Date.parse(x + 'T00:00:00Z');
  if (!isNum(t) || dayOf(t) !== x || t < T_MIN || t > T_MAX) throw bad();
  return x;
}
// an instant: 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM[:SS[.sss]]Z' or unix ms (10 to 13 digits); returns ms
export function instantParam(x) {
  if (typeof x !== 'string') throw bad();
  let t;
  if (/^\d{10,13}$/.test(x)) t = Number(x);
  else if (INSTANT_RE.test(x)) { t = Date.parse(x.length === 10 ? x + 'T00:00:00Z' : x); if (x.length === 10 && isNum(t) && dayOf(t) !== x) throw bad(); }
  else throw bad();
  if (!isNum(t) || t < T_MIN || t > T_MAX) throw bad();
  return t;
}
export function findParams(p) {
  if (!PRESETS.includes(p.q)) throw bad();
  let days = LIMITS.findDefaultDays;
  if (p.days !== undefined) {
    if (!/^\d{1,3}$/.test(p.days)) throw bad();
    days = Number(p.days);
    if (days < LIMITS.findDays[0] || days > LIMITS.findDays[1]) throw bad();
  }
  let chain = null;
  if (p.chain !== undefined && p.chain !== 'any') { if (!CHAIN_RE.test(p.chain)) throw bad(); chain = p.chain; }
  return { q: p.q, days, chain };
}

// ---- SQL (parameters ?1..?4 only) ------------------------------------------------------------------------------------
const POOL_COLS = 'pool_key, pool_id, chain, dex, version, fee_tier, token0, token1, symbol0, symbol1, created_at';
export const DAY_COLS = Object.freeze(['day', 'fees_usd', 'fees_src', 'fees_unconfirmed', 'volume_usd', 'volume_src', 'tvl_usd', 'tvl_src', 'price', 'lp_fee_rate', 'valued']);
export const HOUR_COLS = Object.freeze(['t', 'price', 'liquidity', 'fees_usd', 'parked', 'span_s']);
// the window's day rows, pool by pool through the primary key (pools is small; CROSS JOIN keeps it the outer loop)
const WINDOW = `SELECT p.pool_id AS pool, d.day_utc AS day, d.fees_usd AS f, d.volume_usd AS v, d.tvl_usd AS tv, COALESCE(d.fees_unconfirmed, 0) AS u
  FROM pools AS p CROSS JOIN pool_day AS d ON d.pool_id = p.pool_id AND d.day_utc >= ?1 AND d.day_utc <= ?2
  WHERE (?3 IS NULL OR p.chain = ?3) AND d.fees_usd IS NOT NULL`;
// a pool's median: the middle row, or the mean of the two middle rows (as the page's sdMed)
const median = (src, val, out) => `SELECT pool, AVG(${val}) AS ${out} FROM (SELECT pool, ${val}, ROW_NUMBER() OVER (PARTITION BY pool ORDER BY ${val}) AS i, `
  + `COUNT(*) OVER (PARTITION BY pool) AS n FROM ${src}) WHERE i IN ((n + 1) / 2, (n + 2) / 2) GROUP BY pool`;
const MARKS = `WITH w AS (${WINDOW}),
  c AS (SELECT pool, f, CASE WHEN v > 0 THEN f / v END AS r FROM w WHERE u = 0),
  fm AS (${median('c', 'f', 'med')}),
  rm AS (${median('(SELECT pool, r FROM c WHERE r IS NOT NULL)', 'r', 'rmed')}),
  cn AS (SELECT pool, COUNT(*) AS n FROM c GROUP BY pool),
  m AS (SELECT w.pool, w.day, w.f, w.f / fm.med AS x, cn.n AS n,
    CASE WHEN w.u = 1 THEN 1 WHEN rm.rmed > 0 AND w.v > 0 AND (w.f / w.v > rm.rmed * ${RULE.rhi} OR w.f / w.v < rm.rmed * ${RULE.rlo}) THEN 1 ELSE 0 END AS odd
    FROM w JOIN fm ON fm.pool = w.pool JOIN cn ON cn.pool = w.pool LEFT JOIN rm ON rm.pool = w.pool WHERE fm.med > 0)`;
const META_OF = (src) => `SELECT r.*, pm.chain, pm.dex, pm.version, pm.fee_tier, pm.symbol0, pm.symbol1 FROM (${src}) AS r JOIN pools AS pm ON pm.pool_id = r.pool`;
export const SQL = Object.freeze({
  pool: `SELECT ${POOL_COLS} FROM pools WHERE pool_id = ?1`,
  days: `SELECT day_utc, fees_usd, fees_src, fees_unconfirmed, volume_usd, volume_src, tvl_usd, tvl_src, price, lp_fee_rate, valued
    FROM pool_day WHERE pool_id = ?1 AND day_utc >= ?2 AND day_utc <= ?3 ORDER BY day_utc LIMIT ?4`,
  hours: `SELECT hour, sec, span_s, fees_usd, price, liquidity, parked FROM pool_hour
    WHERE pool_key = (SELECT pool_key FROM pools WHERE pool_id = ?1) AND hour >= ?2 AND hour < ?3 ORDER BY hour`,
  // every day at or above 10× its pool's median of the window: mark 'h' (★ high), or 'o' (⚠ outlier) when it is odd
  spikes10x: META_OF(`${MARKS} SELECT pool, day, f AS value, x AS multiple, CASE WHEN odd = 1 THEN 'o' ELSE 'h' END AS mark, n FROM m WHERE x >= ${RULE.hi}`)
    + ' ORDER BY multiple DESC, day DESC, pool LIMIT ?4',
  // the page's ⚠: at least 3× the median and either unconfirmed or its fee÷vol out of line
  outliers: META_OF(`${MARKS} SELECT pool, day, f AS value, x AS multiple, 'o' AS mark, n FROM m WHERE x >= ${RULE.good} AND odd = 1`)
    + ' ORDER BY multiple DESC, day DESC, pool LIMIT ?4',
  // week on week (weeks end yesterday, 7 days each): the mean fees a day over the confirmed days read (at least 5 of 7 in both
  // weeks), the week at least twice the one before. mark 'p' when either week has fewer than 7 such days
  doubled: META_OF(`WITH w AS (${WINDOW} AND COALESCE(d.fees_unconfirmed, 0) = 0),
    k AS (SELECT pool, CAST((julianday(?2) - julianday(day)) / 7 AS INTEGER) AS wk, AVG(f) AS a, COUNT(*) AS n FROM w GROUP BY pool, wk)
    SELECT cur.pool AS pool, cur.wk AS wk, cur.a AS value, cur.a / prev.a AS multiple, CASE WHEN cur.n < 7 OR prev.n < 7 THEN 'p' END AS mark, cur.n AS n
    FROM k AS cur JOIN k AS prev ON prev.pool = cur.pool AND prev.wk = cur.wk + 1
    WHERE cur.wk < ?4 AND prev.a > 0 AND cur.n >= ${RULE.weekMin} AND prev.n >= ${RULE.weekMin} AND cur.a >= ${RULE.doubled} * prev.a`)
    + ' ORDER BY multiple DESC, wk, pool LIMIT 200',
  // each pool's fee APR over the window: the mean of its days' fees ÷ TVL × 365 (confirmed days with both read, TVL > 0),
  // pools with at least ?4 such days; lowest first. mark 'p' when it rests on fewer days than the window has
  quietest: META_OF(`SELECT pool, MAX(day) AS day, AVG(365.0 * f / tv) AS value, COUNT(*) AS n FROM (${WINDOW} AND d.tvl_usd > 0 AND COALESCE(d.fees_unconfirmed, 0) = 0)
    GROUP BY pool HAVING COUNT(*) >= ?4`) + ' ORDER BY value, pool',
  meta: `SELECT COUNT(*) AS pools, SUM(dmin IS NOT NULL) AS dpools, MIN(dmin) AS dfrom, MAX(dmax) AS dto, SUM(hmin IS NOT NULL) AS hpools,
    MIN(hmin) AS hfrom, MAX(hmax) AS hto, MAX(MAX(COALESCE(hw, 0), COALESCE(dw, 0))) AS wrote FROM (SELECT
      (SELECT MIN(day_utc) FROM pool_day WHERE pool_id = p.pool_id) AS dmin,
      (SELECT MAX(day_utc) FROM pool_day WHERE pool_id = p.pool_id) AS dmax,
      (SELECT MAX(written_at, COALESCE(revised_at, 0)) FROM pool_day WHERE pool_id = p.pool_id ORDER BY day_utc DESC LIMIT 1) AS dw,
      (SELECT MIN(hour) FROM pool_hour WHERE pool_key = p.pool_key) AS hmin,
      (SELECT MAX(hour) FROM pool_hour WHERE pool_key = p.pool_key) AS hmax,
      (SELECT written_at FROM pool_hour WHERE pool_key = p.pool_key ORDER BY hour DESC LIMIT 1) AS hw
    FROM pools AS p)`,
  metaKv: `SELECT (SELECT MAX(version) FROM schema_migrations) AS schema, (SELECT v FROM meta WHERE k = 'sweep') AS sweep,
    (SELECT n FROM meta WHERE k = ?1) AS written`,
});

// ---- answers ----------------------------------------------------------------------------------------------------
const num = (x) => (isNum(x) ? x : null);
const int01 = (x) => (x === 0 || x === 1 ? x : null);
const str = (x) => (typeof x === 'string' ? x : null);
export const poolOut = (r) => ({
  id: r.pool_id, chain: str(r.chain), dex: str(r.dex), version: num(r.version), fee_tier: num(r.fee_tier),
  token0: str(r.token0), token1: str(r.token1), symbol0: str(r.symbol0), symbol1: str(r.symbol1),
  created_at: isNum(r.created_at) ? r.created_at * 1000 : null,
});
const metaOut = (r) => ({ chain: str(r.chain), dex: str(r.dex), version: num(r.version), fee_tier: num(r.fee_tier), symbol0: str(r.symbol0), symbol1: str(r.symbol1) });
const all = async (db, sql, args) => (await db.prepare(sql).bind(...args).all()).results || [];

async function poolRow(db, id) {
  const [r] = await all(db, SQL.pool, [id]);
  if (!r) throw new InputError('notfound', 404);
  return r;
}

export async function daysAnswer(db, p) {
  const pool = poolParam(p.pool);
  const from = p.from === undefined ? null : dayParam(p.from), to = p.to === undefined ? null : dayParam(p.to);
  if (from && to && from > to) throw bad();
  const r = await poolRow(db, pool);
  const rows = await all(db, SQL.days, [pool, from ?? '0000-01-01', to ?? '9999-12-31', LIMITS.dayRows + 1]);
  const more = rows.length > LIMITS.dayRows;
  return {
    v: 1, pool: poolOut(r), from, to, cols: DAY_COLS, more,
    rows: rows.slice(0, LIMITS.dayRows).map((x) => [x.day_utc, num(x.fees_usd), str(x.fees_src), int01(x.fees_unconfirmed), num(x.volume_usd), str(x.volume_src),
      num(x.tvl_usd), str(x.tvl_src), num(x.price), num(x.lp_fee_rate), int01(x.valued)]),
  };
}

export async function hoursAnswer(db, p) {
  const pool = poolParam(p.pool);
  if (p.from === undefined) throw bad();
  const from = instantParam(p.from), to = p.to === undefined ? from + LIMITS.hoursDefaultMs : instantParam(p.to);
  if (!(to > from) || to - from > LIMITS.hoursMaxMs) throw bad();
  const r = await poolRow(db, pool);
  const rows = await all(db, SQL.hours, [pool, Math.floor(from / H), Math.ceil(to / H)]);
  return {
    v: 1, pool: poolOut(r), from, to, cols: HOUR_COLS,
    rows: rows.map((x) => [x.hour * H + (Number.isInteger(x.sec) ? x.sec : 0) * 1000, num(x.price), num(x.liquidity), num(x.fees_usd), num(x.parked), num(x.span_s)]),
  };
}

const sortedMedian = (a) => { const b = a.filter(isNum).sort((x, y) => x - y), i = b.length >> 1; return !b.length ? null : b.length % 2 ? b[i] : (b[i - 1] + b[i]) / 2; };
// the window of a preset: [from, to] as UTC days (to = yesterday: today is still open), and ?4
export function findWindow(q, days, now) {
  const today = Math.floor(now / D) * D, to = dayOf(today - D);
  if (q === 'doubled') { const k = Math.max(1, Math.floor(days / 7)); return { from: dayOf(today - 7 * (k + 1) * D), to, arg: k, weeks: k }; }
  if (q === 'quietest') return { from: dayOf(today - days * D), to, arg: Math.max(3, Math.ceil(days / 2)) };
  return { from: dayOf(today - days * D), to, arg: LIMITS.findMax };
}
export async function findAnswer(db, p, now, sql = SQL) {
  const { q, days, chain } = findParams(p);
  const w = findWindow(q, days, now);
  const rows = await all(db, sql[q], [w.from, w.to, chain, w.arg]);
  const pools = {};
  let list;
  if (q === 'quietest') {
    const med = sortedMedian(rows.map((r) => r.value));
    list = rows.slice(0, LIMITS.findMax).map((r) => ({ pool: r.pool, day: r.day, value: num(r.value), multiple: isNum(med) && med > 0 && isNum(r.value) ? r.value / med : null,
      mark: r.n < days ? 'p' : null, n: r.n }));
  } else if (q === 'doubled') {
    const end = Date.parse(w.to + 'T00:00:00Z');
    list = rows.slice(0, LIMITS.findMax).map((r) => ({ pool: r.pool, day: dayOf(end - r.wk * 7 * D), value: num(r.value), multiple: num(r.multiple), mark: r.mark ?? null, n: r.n }));
  } else list = rows.slice(0, LIMITS.findMax).map((r) => ({ pool: r.pool, day: r.day, value: num(r.value), multiple: num(r.multiple), mark: r.mark, n: r.n }));
  for (const r of rows.slice(0, LIMITS.findMax)) pools[r.pool] = metaOut(r);
  return { v: 1, q, days, chain: chain ?? 'any', from: w.from, to: w.to, n: list.length, rows: list, pools };
}

export async function metaAnswer(db, now) {
  const [m] = await all(db, SQL.meta, []);
  const [k] = await all(db, SQL.metaKv, ['w:' + dayOf(now)]);
  return {
    v: 1, t: now, schema: num(k?.schema), pools: num(m?.pools) ?? 0,
    days: { pools: num(m?.dpools) ?? 0, from: str(m?.dfrom), to: str(m?.dto) },
    hours: { pools: num(m?.hpools) ?? 0, from: isNum(m?.hfrom) ? m.hfrom * H : null, to: isNum(m?.hto) ? m.hto * H : null },
    lastWrite: isNum(m?.wrote) && m.wrote > 0 ? m.wrote * 1000 : null, writtenToday: num(k?.written), sweep: str(k?.sweep),
    limits: { dayRows: LIMITS.dayRows, hoursDays: LIMITS.hoursMaxMs / D, findMax: LIMITS.findMax, findDays: LIMITS.findDays },
  };
}

// ---- rate limits, in the isolate ------------------------------------------------------------------------------------------
// A fixed window per key. over(): would the next hit be refused (no count); hit(): count one, true when still allowed.
export function makeLimiter(limit, windowMs, max = 5000) {
  const m = new Map();
  const cur = (key, now) => { const e = m.get(key); return e && now - e.s < windowMs ? e : null; };
  return {
    over: (key, now) => (cur(key, now)?.n ?? 0) >= limit,
    hit(key, now) {
      let e = cur(key, now);
      if (!e) {
        if (m.size >= max) for (const [k, x] of m) if (now - x.s >= windowMs || m.size >= max) m.delete(k);
        e = { s: now, n: 0 };
        m.set(key, e);
      }
      e.n++;
      return e.n <= limit;
    },
    size: () => m.size,
  };
}

// ---- the handler ------------------------------------------------------------------------------------------------
const hex = (buf) => { let h = ''; for (const b of new Uint8Array(buf)) h += b.toString(16).padStart(2, '0'); return h; };
export const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', vary: 'Origin' };
function headersFor(origin, extra = {}) {
  const h = new Headers({ ...BASE_HEADERS, ...extra });
  if (origin === ORIGIN) h.set('access-control-allow-origin', ORIGIN);
  return h;
}
export const failure = (status, word, origin) => new Response(word, { status, headers: headersFor(origin, { 'content-type': 'text/plain; charset=utf-8' }) });
const answer = (obj, origin) => new Response(JSON.stringify(obj), { status: 200, headers: headersFor(origin, { 'content-type': 'application/json; charset=utf-8' }) });

const ROUTES = Object.freeze({ '/v1/meta': [], '/v1/days': ['pool', 'from', 'to'], '/v1/hours': ['pool', 'from', 'to'], '/v1/find': ['q', 'days', 'chain'] });

// opts: now (a clock), sql (the queries: tests plant faults through it), limits (rate limits)
export function makeHandler({ now = () => Date.now(), sql = SQL, rate = LIMITS.rate } = {}) {
  const st = {
    token: makeLimiter(rate.token, rate.windowMs), find: makeLimiter(rate.find, rate.windowMs), bad: makeLimiter(rate.bad, rate.badWindowMs),
    auth: new Map(), cache: new Map(),
  };
  const cached = async (key, ms, t, make) => {
    const c = st.cache.get(key);
    if (c && c.until > t) return c.v;
    const v = await make();
    if (st.cache.size > 64) st.cache.clear();
    st.cache.set(key, { v, until: t + ms });
    return v;
  };
  // A token known good in this isolate passes at once; any other costs a KV read, so an address with too many refused tokens
  // (malformed, unknown or ended) waits before another read.
  async function authorize(req, env, t) {
    const ip = req.headers.get('cf-connecting-ip') || 'none';
    const refuse = () => { st.bad.hit(ip, t); return { status: 401, word: 'auth' }; };
    const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
    if (!m || !TOKEN_RE.test(m[1])) return st.bad.over(ip, t) ? { status: 429, word: 'rate' } : refuse();
    const hash = await sha256hex(m[1]);
    let a = st.auth.get(hash);
    if (!a || a.until <= t) {
      if (st.bad.over(ip, t)) return { status: 429, word: 'rate' };
      if (!env.AUTH) return { status: 503, word: 'unavailable' };
      let v;
      try { v = await env.AUTH.get('t:' + hash, { type: 'json', cacheTtl: LIMITS.kvCacheTtl }); } catch { return { status: 503, word: 'unavailable' }; }
      if (!v || typeof v !== 'object' || !ROLES.includes(v.r) || !(v.e === null || v.e === undefined || isNum(v.e))) { st.auth.delete(hash); return refuse(); }
      a = { r: v.r, e: v.e ?? null, until: t + LIMITS.authCacheMs };
      if (st.auth.size > 1000) st.auth.clear();
      st.auth.set(hash, a);
    }
    if (a.e !== null && a.e <= t) return refuse(); // ended: the hash may linger in a cache, the end date never does
    return { hash, role: a.r };
  }
  async function fetch(req, env) {
    const origin = req.headers.get('origin');
    try {
      if (origin !== null && origin !== ORIGIN) return failure(403, 'origin', origin);
      if (req.method === 'OPTIONS') {
        if (origin !== ORIGIN) return failure(403, 'origin', origin);
        return new Response(null, { status: 204, headers: headersFor(origin, { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '600' }) });
      }
      if (req.method !== 'GET') return failure(405, 'method', origin);
      const t = now();
      const a = await authorize(req, env, t);
      if (a.word) return failure(a.status, a.word, origin);
      const url = new URL(req.url);
      if (!Object.hasOwn(ROUTES, url.pathname)) return failure(404, 'notfound', origin);
      const allowed = ROUTES[url.pathname];
      if (!st.token.hit(a.hash, t) || (url.pathname === '/v1/find' && !st.find.hit(a.hash, t))) return failure(429, 'rate', origin);
      if (!env.DB) return failure(503, 'unavailable', origin);
      const p = params(url, allowed);
      let out;
      if (url.pathname === '/v1/meta') out = { ...(await cached(`meta|${dayOf(t)}`, LIMITS.metaCacheMs, t, () => metaAnswer(env.DB, t))), role: a.role, api: typeof env.BUILD === 'string' ? env.BUILD.slice(0, 12) : null };
      else if (url.pathname === '/v1/days') out = await daysAnswer(env.DB, p);
      else if (url.pathname === '/v1/hours') out = await hoursAnswer(env.DB, p);
      else { const f = findParams(p); out = await cached(`find|${f.q}|${f.days}|${f.chain}|${dayOf(t)}`, LIMITS.findCacheMs, t, () => findAnswer(env.DB, p, t, sql)); }
      return answer(out, origin);
    } catch (e) {
      if (e instanceof InputError) return failure(e.status, e.word, origin);
      return failure(500, 'server', origin); // never the error's text
    }
  }
  return { fetch, state: st };
}
