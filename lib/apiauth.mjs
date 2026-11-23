// The archive API's tokens in KV (worker/, lib/apitoken.mjs; docs/DATA.md "Archive API"). The Worker assim-ls-api keeps only
// SHA-256 hashes of the valid tokens, in the KV namespace assim-ls-auth: 't:' + hash → value { r: role, e: end ms|null },
// metadata { r, e, k: 'o' owner | 's' slot | 'p' grace | 'test', g: key generation }, a KV expiration at the end.
// The loop keeps it in sync with the key slots (authSync, after the keys step: scripts/loop.mjs), from what it already holds:
//   the owner   HMAC under the private key of 'owner|g<gen>'
//   each live guest or member slot (keys.json, opened with the guest's key from guests.json): HMAC under the market key of
//               'slot|<slot id>' (exactly what that guest's page derives from its slot), with the slot's role and hard end
//   grace       for 6 hours after the market key changes (a guest removed or expired, "remove all"): the live slots' and the
//               owner's tokens of the generation before, so a page still holding the old keys.json is not refused while the
//               new one reaches it. A removed or expired guest's slot is not live: its hashes go at once.
// Every hash not in that set is deleted ('test' entries excepted: the worker job's own, ending by themselves in 10 minutes).
// 'm:keys' (metadata { g, at }) records when this generation was first seen, so the grace ends 6 hours later even across
// loop runs. Never fails a pass: one public line, counts only, or 'api auth: error <category>' (a word, never a message).
// Only resources named assim-ls* are created, read or changed (the namespace id is kept in D1's meta table, so no listing of
// the account is ever needed). The REST client here also serves the Worker's deploy (scripts/worker.mjs).
import crypto from 'node:crypto';
import { apiToken, ownerLabel, slotLabel, tokenHash } from './apitoken.mjs';
import { b64ok, openGuestSlot, readKeysFile, reopen } from './keyring.mjs';
import { API, DB_NAME, D1Error, categoryOf, makeClient, sqlStr } from './d1.mjs';

export const KV_TITLE = 'assim-ls-auth', WORKER = 'assim-ls-api', KV_META_KEY = 'kv:assim-ls-auth';
export const GRACE_MS = 6 * 3600e3, RESYNC_MS = 3 * 3600e3, MIN_LIFE_MS = 120e3;
const NS_RE = /^[0-9a-f]{32}$/, HASH_KEY_RE = /^t:[0-9a-f]{64}$/;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the REST client (api.cloudflare.com, account-scoped) ---------------------------------------------------------------
export class CfError extends Error {
  // codes: Cloudflare's numeric error codes (generic numbers, safe to print); never its message
  constructor(category, status = null, codes = []) { super(`cf ${category}`); this.category = category; this.status = status; this.codes = codes; }
}
export function cfClient({ accountId, token, fetchImpl = globalThis.fetch, sleep = pause, tries = 2, timeoutMs = 15_000, api = API } = {}) {
  if (!accountId || !token) throw new CfError('skipped');
  if (!/^[0-9a-f]{32}$/i.test(String(accountId))) throw new CfError('account');
  const acct = `${api}/accounts/${accountId}`, stats = { calls: 0, retries: 0 };
  async function call(method, path, { json, form, full = false } = {}) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      if (i) { stats.retries++; await sleep(1000 * 3 ** (i - 1)); }
      let res, body = null;
      stats.calls++;
      try {
        res = await fetchImpl(acct + path, { method, headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(json !== undefined ? { body: JSON.stringify(json) } : form ? { body: form } : {}), signal: AbortSignal.timeout(timeoutMs) });
        try { body = await res.json(); } catch { body = null; }
      } catch (e) { last = new CfError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network'); continue; }
      if (res.ok && body && body.success !== false) return full ? body : body.result;
      const codes = (Array.isArray(body?.errors) ? body.errors : []).map((x) => x?.code).filter(Number.isInteger).slice(0, 5);
      last = new CfError(res.ok ? 'answer' : categoryOf(res.status, body), res.status, codes);
      if (!(res.status === 429 || res.status >= 500)) throw last;
    }
    throw last;
  }
  const nsPath = (ns) => { if (!NS_RE.test(String(ns))) throw new CfError('namespace'); return `/storage/kv/namespaces/${ns}`; };
  return {
    stats, call,
    // the namespace's title by its id (only an id this project recorded is ever asked for)
    async nsTitle(ns) { const r = await call('GET', nsPath(ns)); return typeof r?.title === 'string' ? r.title : null; },
    async nsCreate(title = KV_TITLE) {
      if (!/^assim-ls/.test(title)) throw new CfError('name'); // only ever an assim-ls resource
      const r = await call('POST', '/storage/kv/namespaces', { json: { title } });
      if (!NS_RE.test(String(r?.id))) throw new CfError('answer');
      return r.id;
    },
    // every key of our namespace: Map(name → { metadata, expiration })
    async list(ns) {
      const out = new Map();
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const j = await call('GET', `${nsPath(ns)}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { full: true });
        for (const k of Array.isArray(j.result) ? j.result : []) if (k && typeof k.name === 'string') out.set(k.name, { metadata: k.metadata ?? null, expiration: k.expiration ?? null });
        cursor = j.result_info?.cursor || '';
        if (!cursor) return out;
      }
      throw new CfError('answer');
    },
    // items: [{ key, value (string), metadata?, expiration? (unix s) | expiration_ttl? (s) }]
    async put(ns, items) {
      for (let i = 0; i < items.length; i += 1000) {
        const r = await call('PUT', `${nsPath(ns)}/bulk`, { json: items.slice(i, i + 1000) });
        if (Array.isArray(r?.unsuccessful_keys) && r.unsuccessful_keys.length) throw new CfError('answer');
      }
    },
    async del(ns, keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const part = keys.slice(i, i + 1000);
        try { await call('POST', `${nsPath(ns)}/bulk/delete`, { json: part }); }
        catch (e) { if (e.category !== 'notfound' && e.status !== 405) throw e; await call('DELETE', `${nsPath(ns)}/bulk`, { json: part }); } // the older route
      }
    },
    // the Worker (only the script named assim-ls-api)
    async workerSettings() { try { return await call('GET', `/workers/scripts/${WORKER}/settings`); } catch (e) { if (e.category === 'notfound') return null; throw e; } },
    async workerUpload(metadata, modules) {
      const fd = new FormData();
      fd.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      for (const [name, src] of Object.entries(modules)) fd.append(name, new Blob([src], { type: 'application/javascript+module' }), name);
      return call('PUT', `/workers/scripts/${WORKER}`, { form: fd });
    },
    async workerOnSubdomain() { return call('POST', `/workers/scripts/${WORKER}/subdomain`, { json: { enabled: true, previews_enabled: false } }); },
    async accountSubdomain() { const r = await call('GET', '/workers/subdomain'); return typeof r?.subdomain === 'string' && /^[a-z0-9-]{1,63}$/.test(r.subdomain) ? r.subdomain : null; },
  };
}

// The namespace id as recorded in D1's meta (kv:assim-ls-auth), or null. d1: lib/d1.mjs makeClient; db: the database's id.
export async function nsFromD1(d1, db) {
  const r = await d1.raw(db, `SELECT v FROM meta WHERE k = ${sqlStr(KV_META_KEY)}`);
  const v = r.rows[0]?.[0];
  return typeof v === 'string' && NS_RE.test(v) ? v : null;
}
export async function nsToD1(d1, db, ns) {
  if (!NS_RE.test(String(ns))) throw new CfError('namespace');
  await d1.query(db, `INSERT INTO meta (k, v) VALUES (${sqlStr(KV_META_KEY)}, ${sqlStr(ns)}) ON CONFLICT (k) DO UPDATE SET v = excluded.v`);
}

// ---- the tokens the key slots allow -----------------------------------------------------------------------------------
// kf: keys.json; v: the vault (reopen: aes = the private key, mdek, prev, gen); guests: guests.json's list (live ones carry kek).
// Returns { gen, owner, prevOwner, slots: [{ hash, prevHash, role, exp }], unslotted } (hashes only: a token never leaves here).
export async function slotTokens({ kf, v, guests = [], now = Date.now() }) {
  if (!v || !Buffer.isBuffer(v.aes) || !Buffer.isBuffer(v.mdek) || !Number.isInteger(v.gen)) throw new CfError('keys');
  const b64 = (b) => b.toString('base64');
  const hashOf = async (key, label) => tokenHash(await apiToken(b64(key), label));
  const out = { gen: v.gen, owner: await hashOf(v.aes, ownerLabel(v.gen)), prevOwner: v.gen > 0 ? await hashOf(v.aes, ownerLabel(v.gen - 1)) : null, slots: [], unslotted: 0 };
  const prev = Array.isArray(v.prev) && Buffer.isBuffer(v.prev[0]) ? v.prev[0] : null;
  const seen = new Set();
  for (const g of Array.isArray(guests) ? guests : []) {
    if (!g || g.st !== 'active' || !b64ok(g.kek, 32)) continue;
    const o = openGuestSlot(kf, Buffer.from(g.kek, 'base64'));
    if (!o || seen.has(o.slot) || !/^[0-9a-f]{16}$/.test(String(o.slot))) { out.unslotted++; continue; }
    seen.add(o.slot);
    if (isNum(o.exp) && o.exp <= now) continue; // past its hard end: the keys step drops it
    out.slots.push({ hash: await hashOf(o.dek, slotLabel(o.slot)), prevHash: prev ? await hashOf(prev, slotLabel(o.slot)) : null, role: o.role === 'member' ? 'member' : 'guest', exp: isNum(o.exp) ? o.exp : null });
  }
  return out;
}

// The KV entries wanted now: Map(key → { value, metadata, expiration? }). rotAt: when this generation was first seen.
export function wanted(base, rotAt, now) {
  const out = new Map();
  const add = (hash, r, e, k) => {
    if (e != null && e <= now + MIN_LIFE_MS) return; // KV needs an expiration at least a minute ahead; it is over anyway
    out.set(`t:${hash}`, { value: JSON.stringify({ r, e: e ?? null }), metadata: { r, e: e ?? null, k, g: base.gen }, ...(e != null ? { expiration: Math.floor(e / 1000) } : {}) });
  };
  add(base.owner, 'owner', null, 'o');
  for (const s of base.slots) add(s.hash, s.role, s.exp, 's');
  const end = rotAt + GRACE_MS;
  if (now < end) {
    if (base.prevOwner) add(base.prevOwner, 'owner', end, 'p');
    for (const s of base.slots) if (s.prevHash) add(s.prevHash, s.role, s.exp == null ? end : Math.min(s.exp, end), 'p');
  }
  out.set('m:keys', { value: '1', metadata: { g: base.gen, at: rotAt } });
  return out;
}
const sameMeta = (a, b) => !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
export const fingerprint = (want) => crypto.createHash('sha256').update(JSON.stringify([...want].sort((a, b) => (a[0] < b[0] ? -1 : 1)))).digest('hex');

// What to write and delete: listed = Map(name → { metadata, expiration }).
export function plan(want, listed) {
  const puts = [], dels = [];
  for (const [key, w] of want) if (!sameMeta(listed.get(key)?.metadata, w.metadata)) puts.push({ key, ...w });
  for (const [key, x] of listed) if (HASH_KEY_RE.test(key) && !want.has(key) && x?.metadata?.k !== 'test') dels.push(key);
  return { puts, dels };
}
export function counts(want) {
  const c = { tokens: 0, owner: 0, guest: 0, member: 0, grace: 0 };
  for (const [key, w] of want) {
    if (!key.startsWith('t:')) continue;
    c.tokens++;
    if (w.metadata.k === 'p') c.grace++; else if (w.metadata.r === 'owner') c.owner++; else if (w.metadata.r === 'member') c.member++; else c.guest++;
  }
  return c;
}
export const syncLine = (c, w, d) => `api auth: ${c.tokens} tokens (owner ${c.owner}, guests ${c.guest}, members ${c.member}${c.grace ? `, grace ${c.grace}` : ''}); `
  + (w || d ? `${w} written, ${d} removed` : 'in sync');

// The loop's call (and the worker job's sync). keys: openLock's; store: lib/store.mjs over outDir (guests.json is private);
// state: kept by the caller between passes ({ ns, fp, gen, rotAt, at }). Never throws: { line, error?, changed?, skipped? }.
// line is null when nothing changed since the last sync of this process (no request at all then).
export async function authSync({ env = process.env, keys, store, outDir = 'out/data', now = Date.now(), state = {}, fetchImpl, sleep, force = false } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return { line: 'api auth: skipped', skipped: true };
  try {
    const kf = readKeysFile(outDir);
    if (!kf) return { line: 'api auth: skipped (no key slots)', skipped: true };
    let v;
    try { v = reopen(keys, kf); } catch { throw new CfError('keys'); }
    let G;
    try { G = store.get('guests.json'); } catch { throw new CfError('guests'); }
    if (G === undefined || (G == null && kf.slots.length > 0)) throw new CfError('guests');
    const base = await slotTokens({ kf, v, guests: G?.guests || [], now });
    if (!force && state.fp && state.gen === base.gen && isNum(state.rotAt) && now - state.at < RESYNC_MS && fingerprint(wanted(base, state.rotAt, now)) === state.fp) {
      return { line: null, same: true, counts: counts(wanted(base, state.rotAt, now)) };
    }
    const opt = { accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}) };
    if (!state.ns) {
      const d1 = makeClient({ ...opt, tries: 2, timeoutMs: 15_000 });
      const db = await d1.findDb(DB_NAME);
      if (!db) return { line: 'api auth: skipped (no archive database)', skipped: true };
      state.ns = await nsFromD1(d1, db);
      if (!state.ns) return { line: 'api auth: skipped (not deployed yet: worker deploy)', skipped: true };
    }
    const c = cfClient(opt);
    const listed = await c.list(state.ns);
    const mk = listed.get('m:keys')?.metadata;
    const rotAt = mk && mk.g === base.gen && isNum(mk.at) && mk.at <= now ? mk.at : now;
    const want = wanted(base, rotAt, now);
    const { puts, dels } = plan(want, listed);
    if (puts.length) await c.put(state.ns, puts);
    if (dels.length) await c.del(state.ns, dels);
    Object.assign(state, { fp: fingerprint(want), gen: base.gen, rotAt, at: now });
    const n = counts(want);
    return { line: syncLine(n, puts.filter((p) => p.key.startsWith('t:')).length, dels.length), changed: puts.length + dels.length > 0, counts: n, written: puts.length, removed: dels.length, unslotted: base.unslotted };
  } catch (e) {
    const cat = e instanceof CfError || e instanceof D1Error ? e.category : 'internal';
    if (cat === 'notfound') state.ns = null; // the namespace went: look it up again next time
    return { line: cat === 'skipped' ? 'api auth: skipped' : `api auth: error ${cat}`, error: cat };
  }
}
