// A made-up Cloudflare for the archive API's tests (test/apiauth.test.mjs): the REST API (D1 over an in-memory SQLite with the
// archive's schema, a KV namespace, the Workers script upload, settings and workers.dev route) and the Worker's own host,
// served by worker/api.mjs's handler over the same D1 and KV with a clock the test moves. KV here is consistent at once and
// honours expirations. Every request is recorded (method, path) so a test can count them. Made-up ids only.
import fs from 'node:fs';
import { parseMigrations, SCHEMA_FILE } from '../../lib/d1.mjs';
import { makeHandler } from '../../worker/api.mjs';

export const ACCT = '0123456789abcdef0123456789abcdef', CF_TOKEN = 'made-up-cloudflare-token';
export const DB_ID = 'db-made-up-0001', SUB = 'made-up-sub';
export const HOST = `assim-ls-api.${SUB}.workers.dev`;

export function fakeCloud({ sqlite, clock = { t: Date.now() }, dbExists = true, subdomain = SUB, fail = null, handler = null } = {}) {
  const db = new sqlite.DatabaseSync(':memory:');
  for (const m of parseMigrations(fs.readFileSync(SCHEMA_FILE, 'utf8'))) for (const s of m.statements) db.exec(s);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  db.exec('INSERT OR IGNORE INTO schema_migrations VALUES (1, 1), (2, 2)');
  const namespaces = new Map(); // id → { title, keys: Map(name → { value, metadata, exp (ms)|null }) }
  const script = { uploaded: null, subdomain: false };
  const calls = [];
  let nsSeq = 0;
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = (result, extra = {}) => res(200, { success: true, errors: [], result, ...extra });
  const err = (status, code) => res(status, { success: false, errors: [{ code, message: 'made-up error text with a secret-looking 0xabcdef0123' }] });
  const live = (ns) => { const now = clock.t; for (const [k, x] of ns.keys) if (x.exp != null && x.exp <= now) ns.keys.delete(k); return ns.keys; };
  // the bindings the Worker sees
  const DB = {
    prepare(sql) { const st = { args: [], bind(...a) { return { ...st, args: a }; }, async all() { return { results: db.prepare(sql).all(...this.args), success: true }; } }; return st; },
  };
  const kvBinding = () => {
    const id = script.uploaded?.metadata?.bindings?.find((b) => b.type === 'kv_namespace')?.namespace_id;
    const ns = namespaces.get(id);
    return ns ? { async get(key, o) { const x = live(ns).get(key); return x == null ? null : o?.type === 'json' ? JSON.parse(x.value) : x.value; } } : null;
  };
  const worker = handler || makeHandler({ now: () => clock.t });

  async function fetchImpl(url, opts = {}) {
    const u = new URL(url), method = opts.method || 'GET';
    calls.push({ host: u.host, method, path: u.pathname });
    if (fail) { const f = fail(u, opts, calls.length); if (f) return typeof f === 'function' ? f() : f; }
    if (u.host === HOST) {
      if (!script.uploaded || !script.subdomain) return new Response('no such worker', { status: 404 });
      return worker.fetch(new Request(url, { method, headers: opts.headers }), { DB, AUTH: kvBinding(), BUILD: script.uploaded.metadata.bindings.find((b) => b.name === 'BUILD')?.text });
    }
    if (u.host !== 'api.cloudflare.com') throw new TypeError('fetch failed');
    if (opts.headers?.authorization !== `Bearer ${CF_TOKEN}`) return err(403, 10000);
    const p = u.pathname.replace(`/client/v4/accounts/${ACCT}`, '');
    if (p === u.pathname) return err(404, 7003);
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    // D1
    if (p === '/d1/database' && method === 'GET') return ok(dbExists ? [{ uuid: DB_ID, name: 'assim-ls-archive' }].filter((d) => d.name === u.searchParams.get('name')) : []);
    const dm = /^\/d1\/database\/([^/]+)\/(query|raw)$/.exec(p);
    if (dm) {
      if (dm[1] !== DB_ID) return err(404, 7404);
      try {
        const st = db.prepare(body.sql);
        if (/^\s*(select|with)/i.test(body.sql)) {
          const rows = st.all();
          return ok([{ success: true, results: dm[2] === 'raw' ? { columns: rows[0] ? Object.keys(rows[0]) : [], rows: rows.map((r) => Object.values(r)) } : rows, meta: { rows_read: rows.length } }]);
        }
        const info = st.run();
        return ok([{ success: true, results: [], meta: { changes: info.changes, rows_written: info.changes } }]);
      } catch { return err(400, 7500); }
    }
    // KV
    if (p === '/storage/kv/namespaces' && method === 'POST') {
      if ([...namespaces.values()].some((n) => n.title === body.title)) return err(400, 10014);
      const id = (++nsSeq).toString(16).padStart(32, 'e');
      namespaces.set(id, { title: body.title, keys: new Map() });
      return ok({ id, title: body.title });
    }
    const km = /^\/storage\/kv\/namespaces\/([0-9a-f]{32})(\/keys|\/bulk|\/bulk\/delete|\/values\/(.+))?$/.exec(p);
    if (km) {
      const ns = namespaces.get(km[1]);
      if (!ns) return err(404, 10013);
      if (!km[2] && method === 'GET') return ok({ id: km[1], title: ns.title });
      if (km[2] === '/keys' && method === 'GET') {
        const all = [...live(ns)].filter(([k]) => k.startsWith(u.searchParams.get('prefix') || ''));
        const lim = Number(u.searchParams.get('limit') || 1000), from = Number(u.searchParams.get('cursor') || 0);
        const page = all.slice(from, from + lim);
        return ok(page.map(([name, x]) => ({ name, ...(x.metadata ? { metadata: x.metadata } : {}), ...(x.exp != null ? { expiration: Math.floor(x.exp / 1000) } : {}) })),
          { result_info: { count: page.length, cursor: from + lim < all.length ? String(from + lim) : '' } });
      }
      if (km[2] === '/bulk' && method === 'PUT') {
        for (const it of body) {
          if (typeof it.value !== 'string') return err(400, 10001);
          const exp = it.expiration != null ? it.expiration * 1000 : it.expiration_ttl != null ? clock.t + it.expiration_ttl * 1000 : null;
          if (exp != null && exp < clock.t + 60e3) return err(400, 10033); // KV: an expiration at least 60 s ahead
          ns.keys.set(it.key, { value: it.value, metadata: it.metadata ?? null, exp });
        }
        return ok({ successful_key_count: body.length, unsuccessful_keys: [] });
      }
      if (km[2] === '/bulk/delete' && method === 'POST') { for (const k of body) ns.keys.delete(k); return ok({ successful_key_count: body.length, unsuccessful_keys: [] }); }
    }
    // Workers
    if (p === '/workers/scripts/assim-ls-api' && method === 'PUT') {
      if (!(body instanceof FormData)) return err(400, 10021);
      const metadata = JSON.parse(await body.get('metadata').text());
      const modules = {};
      for (const [k, v] of body) if (k !== 'metadata') modules[k] = { text: await v.text(), type: v.type, name: v.name };
      if (!modules[metadata.main_module]) return err(400, 10021);
      script.uploaded = { metadata, modules };
      return ok({ id: 'assim-ls-api' });
    }
    if (p === '/workers/scripts/assim-ls-api/settings' && method === 'GET') return script.uploaded ? ok({ bindings: script.uploaded.metadata.bindings }) : err(404, 10007);
    if (p === '/workers/scripts/assim-ls-api/subdomain' && method === 'POST') { if (!script.uploaded) return err(404, 10007); script.subdomain = !!body.enabled; return ok({ enabled: script.subdomain }); }
    if (p === '/workers/subdomain' && method === 'GET') return subdomain ? ok({ subdomain }) : err(404, 10007);
    return err(404, 7000);
  }
  return { fetchImpl, db, namespaces, script, calls, clock, env: { CF_ACCOUNT_ID: ACCT, CF_API_TOKEN: CF_TOKEN } };
}
