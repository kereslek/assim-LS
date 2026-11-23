// The archive API's tokens in KV (lib/apiauth.mjs), the loop's sync (scripts/loop.mjs) and the worker job (scripts/worker.mjs),
// against a made-up Cloudflare (test/fakes/cloud.mjs) and real key slots (throwaway lock, made-up guests): the loop stores
// the hashes of exactly the tokens the pages derive; a removed or expired guest's hash goes at once and is then refused; the
// live slots keep the generation before for 6 hours, never longer, even across loop runs; test entries are left alone; a sync
// with nothing new sends no request; it never throws, and its line holds counts or one word. The jobs deploy, test, sync and
// clean up, print no id, token, hash or account, and fail on a Worker that serves an ended token or any origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLock, readLock, unlock } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal } from '../lib/inbox.mjs';
import { openStore, writeSealed } from '../lib/store.mjs';
import { guestKek, readKeysFile, reopen, tryUnwrap, unwrapSlot, wrapSlot } from '../lib/keyring.mjs';
import { guestStep } from '../lib/guests.mjs';
import { apiToken, apiTokenFor, slotLabel, tokenHash } from '../lib/apitoken.mjs';
import { GRACE_MS, KV_META_KEY, authSync, counts, plan, slotTokens, syncLine, wanted } from '../lib/apiauth.mjs';
import { runLoop, rehearsalPass } from '../scripts/loop.mjs';
import { run as job } from '../scripts/worker.mjs';
import { makeHandler, ORIGIN } from '../worker/api.mjs';
import { ACCT, DB_ID, HOST, fakeCloud } from './fakes/cloud.mjs';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
const noSql = { skip: !sqlite && 'node:sqlite is not available' };

const DUMMY = 'api auth test dummy passphrase, not a secret';
const H = 3600e3, D = 24 * H, NOW = Date.parse('2026-11-23T10:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-apiauth-'));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const noSleep = async () => {};

// ---- real key slots: a throwaway lock, migrated, with made-up guests ----------------------------------------------------
function makeVault() {
  const lockDir = tmp(), out = tmp();
  initLock({ dir: lockDir, passphrase: DUMMY, iterations: 1000 });
  const keys = unlock(readLock(lockDir), DUMMY);
  writeSealed('live.json', { v: 1, t: NOW - H, pools: [] }, keys.aes, { outDir: out });
  const k = { ...keys };
  guestStep({ keys: k, outDir: out, now: NOW - H, allowMigrate: true }); // k becomes the vault
  return { lockDir, out, keys: k, pub: inboxKeys(keys.token).publicB64, store: openStore({ keys: k, outDir: out }) };
}
function addGuest(V, { role = 'guest', exp = null, at = NOW } = {}) {
  const kf = readKeysFile(V.out), v = reopen(V.keys, kf);
  const kek = guestKek(`made up guest ${hex(4)}`, kf.gsalt, kf.iter), slot = hex(8);
  const wrap = wrapSlot({ k: v.mdek.toString('base64'), s: slot, n: 'Made-up Friend', e: exp, g: v.gen }, kek, 'guest');
  const env = inboxSeal(JSON.stringify({ lps: 'guest-add', id: hex(16), at, guests: [{ slot, kek: kek.toString('base64'), name: 'Made-up Friend', exp, role, wrap }] }), V.pub);
  const r = guestStep({ keys: V.keys, outDir: V.out, now: at, requests: [env] });
  assert.equal(r.added, 1);
  return { kek, slot, role };
}
function removeGuest(V, slot, at) {
  const r = guestStep({ keys: V.keys, outDir: V.out, now: at, requests: [inboxSeal(JSON.stringify({ lps: 'guest-remove', id: hex(16), at, slot }), V.pub)] });
  assert.equal(r.removed, 1); assert.equal(r.rotated, true);
}
// what the pages do: the owner opens the master slot, a guest its own slot
const ownerToken = (V) => { const kf = readKeysFile(V.out); return apiTokenFor(unwrapSlot(kf.mk, reopen(V.keys, kf).mk, 'master')); };
async function guestToken(V, kek) {
  for (const s of readKeysFile(V.out).slots) { const o = tryUnwrap(s, kek, 'guest'); if (o) return apiTokenFor(o); }
  return null;
}
const baseOf = (V, now) => { const kf = readKeysFile(V.out); return slotTokens({ kf, v: reopen(V.keys, kf), guests: V.store.get('guests.json').guests, now }); };
const key = async (tok) => `t:${await tokenHash(tok)}`;
// the public line: counts and words only, never an id, a hash, a token, a key or the account
const PUBLIC = /^[\w .,:;()'’\-—–/<>=+·]*$/u;
const publicOnly = (lines) => lines.every((l) => typeof l === 'string' && PUBLIC.test(l) && !/[0-9a-f]{16,}/i.test(l) && !/lps1\./.test(l) && !l.includes(ACCT) && !l.includes(DB_ID) && !/made-up-cloudflare/.test(l));

test('the loop wants the hashes of exactly the tokens the pages derive: the owner and each live guest or member, with its role and end', async () => {
  const V = makeVault();
  const a = addGuest(V), b = addGuest(V, { role: 'member', exp: NOW + 20 * D });
  const w = wanted(await baseOf(V, NOW), NOW, NOW);
  const o = w.get(await key(await ownerToken(V)));
  assert.deepEqual(o?.metadata, { r: 'owner', e: null, k: 'o', g: 0 });
  assert.deepEqual(JSON.parse(o.value), { r: 'owner', e: null });
  assert.equal(o.expiration, undefined, 'the owner\'s has no end');
  assert.deepEqual(w.get(await key(await guestToken(V, a.kek)))?.metadata, { r: 'guest', e: null, k: 's', g: 0 });
  const bm = w.get(await key(await guestToken(V, b.kek)));
  assert.deepEqual(bm?.metadata, { r: 'member', e: NOW + 20 * D, k: 's', g: 0 });
  assert.equal(bm.expiration, Math.floor((NOW + 20 * D) / 1000), 'KV drops it at its hard end by itself');
  assert.deepEqual(counts(w), { tokens: 3, owner: 1, guest: 1, member: 1, grace: 0 });
  assert.deepEqual(w.get('m:keys').metadata, { g: 0, at: NOW });
  // hashes only: no token, no key, no slot id anywhere in what goes to KV
  const all = JSON.stringify([...w]), v = reopen(V.keys, readKeysFile(V.out));
  for (const s of [await ownerToken(V), await guestToken(V, a.kek), v.mdek.toString('base64'), v.aes.toString('base64'), a.slot, b.slot, a.kek.toString('base64')]) assert.ok(!all.includes(s.slice(-20)));
  // a guest at its hard end (within the minute KV needs) is not wanted
  const c = addGuest(V, { exp: NOW + 30e3 });
  assert.equal((await baseOf(V, NOW)).slots.length, 3);
  assert.equal(wanted(await baseOf(V, NOW), NOW, NOW).has(await key(await guestToken(V, c.kek))), false);
});

test('a removal rotates: the removed guest\'s hashes go at once; the others keep the generation before for 6 hours only', async () => {
  const V = makeVault();
  const a = addGuest(V), b = addGuest(V, { role: 'member' });
  const before = { owner: await ownerToken(V), a: await guestToken(V, a.kek), b: await guestToken(V, b.kek) };
  const T = NOW + 2 * H;
  removeGuest(V, a.slot, T);
  const base = await baseOf(V, T);
  assert.equal(base.gen, 1);
  const w = wanted(base, T, T);
  const after = { owner: await ownerToken(V), b: await guestToken(V, b.kek) };
  assert.notEqual(after.owner, before.owner, 'a new generation: a new owner token too');
  assert.notEqual(after.b, before.b, 'a new market key: a new slot token');
  assert.equal(await guestToken(V, a.kek), null, 'the removed guest opens no slot');
  assert.equal(w.has(await key(before.a)), false, 'the removed guest\'s old token: gone at once');
  const v = reopen(V.keys, readKeysFile(V.out));
  for (const k of [v.mdek, v.prev[0]]) assert.equal(w.has(await key(await apiToken(k.toString('base64'), slotLabel(a.slot)))), false, 'no hash for its slot under any key');
  for (const t of [after.owner, after.b]) assert.equal(w.get(await key(t))?.metadata.k === 'o' || w.get(await key(t))?.metadata.k === 's', true);
  for (const t of [before.owner, before.b]) {
    const x = w.get(await key(t));
    assert.equal(x?.metadata.k, 'p', 'grace for the generation before');
    assert.equal(x.expiration, Math.floor((T + GRACE_MS) / 1000));
  }
  assert.deepEqual(counts(w), { tokens: 4, owner: 1, guest: 0, member: 1, grace: 2 });
  const later = wanted(base, T, T + GRACE_MS);
  assert.equal(later.has(await key(before.b)) || later.has(await key(before.owner)), false, 'and gone after 6 hours');
  // planted fault: a grace that kept the removed guest's slot would be caught by the check above
  const leaky = wanted({ ...base, slots: [...base.slots, { hash: 'f'.repeat(64), prevHash: await tokenHash(before.a), role: 'guest', exp: null }] }, T, T);
  assert.equal(leaky.has(await key(before.a)), true);
});

test('plan: writes what changed, deletes hashes no longer wanted, never a test entry or a key of another kind', () => {
  const meta = (r, k, g = 0) => ({ r, e: null, k, g });
  const want = new Map([['t:' + '1'.repeat(64), { value: '{}', metadata: meta('owner', 'o') }], ['t:' + '2'.repeat(64), { value: '{}', metadata: meta('guest', 's') }], ['m:keys', { value: '1', metadata: { g: 0, at: 5 } }]]);
  const listed = new Map([
    ['t:' + '1'.repeat(64), { metadata: meta('owner', 'o') }],          // the same: kept
    ['t:' + '2'.repeat(64), { metadata: meta('member', 's') }],         // its role changed: written
    ['t:' + '3'.repeat(64), { metadata: meta('guest', 's') }],          // no longer wanted: deleted
    ['t:' + '4'.repeat(64), { metadata: { r: 'test', k: 'test' } }],    // the worker job's: left
    ['t:' + '5'.repeat(64), { metadata: null }],                        // unknown: deleted
    ['other', { metadata: null }],                                     // not a hash: left
  ]);
  const p = plan(want, listed);
  assert.deepEqual(p.puts.map((x) => x.key).sort(), ['m:keys', 't:' + '2'.repeat(64)]);
  assert.deepEqual(p.dels.sort(), ['t:' + '3'.repeat(64), 't:' + '5'.repeat(64)]);
  assert.equal(syncLine({ tokens: 3, owner: 1, guest: 1, member: 1, grace: 0 }, 1, 2), 'api auth: 3 tokens (owner 1, guests 1, members 1); 1 written, 2 removed');
  assert.equal(syncLine({ tokens: 4, owner: 1, guest: 1, member: 0, grace: 2 }, 0, 0), 'api auth: 4 tokens (owner 1, guests 1, members 0, grace 2); in sync');
});

test('authSync on a made-up Cloudflare: the Worker then accepts the pages\' tokens, refuses a removed guest\'s, ends the grace; no request when nothing changed', noSql, async () => {
  const clock = { t: NOW };
  const cf = fakeCloud({ sqlite, clock });
  const say = [];
  assert.equal(await job('deploy', { env: cf.env, fetchImpl: cf.fetchImpl, wait: async (ms) => { clock.t += ms; }, clock: () => clock.t, say: (s) => say.push(s) }), 0, say.join('\n'));
  const V = makeVault();
  const a = addGuest(V), b = addGuest(V, { role: 'member' });
  const state = {}, lines = [];
  const sync = async (o = {}) => { const r = await authSync({ env: cf.env, keys: V.keys, store: V.store, outDir: V.out, now: clock.t, state, fetchImpl: cf.fetchImpl, sleep: noSleep, ...o }); if (r.line) lines.push(r.line); return r; };
  const ask = async (tok) => { const r = await cf.fetchImpl(`https://${HOST}/v1/meta`, { headers: { authorization: `Bearer ${tok}` } }); return { status: r.status, json: r.status === 200 ? await r.json() : null }; };
  const r1 = await sync();
  assert.equal(r1.line, 'api auth: 3 tokens (owner 1, guests 1, members 1); 3 written, 0 removed');
  const tA = await guestToken(V, a.kek), tB = await guestToken(V, b.kek), tO = await ownerToken(V);
  assert.equal((await ask(tO)).json.role, 'owner');
  assert.equal((await ask(tA)).json.role, 'guest');
  assert.equal((await ask(tB)).json.role, 'member');
  assert.equal((await ask('lps1.' + 'Q'.repeat(43))).status, 401);
  // nothing changed: no request at all
  const n = cf.calls.length;
  const r2 = await sync();
  assert.equal(r2.line, null); assert.equal(cf.calls.length, n);
  // a test entry of the worker job survives every sync
  const ns = [...cf.namespaces.keys()][0];
  cf.namespaces.get(ns).keys.set('t:' + '9'.repeat(64), { value: '{"r":"test","e":null}', metadata: { r: 'test', k: 'test' }, exp: null });
  // the guest removed: its token refused once the Worker's minute is over; the member's old token in grace, the new one too
  clock.t = NOW + H;
  removeGuest(V, a.slot, clock.t);
  const r3 = await sync();
  assert.equal(r3.changed, true);
  // written: the new owner and member tokens, and the old two again as grace entries; removed: the guest's, its only one
  assert.equal(r3.line, 'api auth: 4 tokens (owner 1, guests 0, members 1, grace 2); 4 written, 1 removed');
  clock.t += 61e3;
  assert.equal((await ask(tA)).status, 401, 'the removed guest is refused');
  assert.equal((await ask(tB)).status, 200, 'the member\'s page still on the old keys: grace');
  assert.equal((await ask(await guestToken(V, b.kek))).status, 200, 'and on the new keys');
  assert.equal((await ask(await ownerToken(V))).json.role, 'owner');
  assert.ok(cf.namespaces.get(ns).keys.has('t:' + '9'.repeat(64)), 'the test entry left alone');
  // a new loop run an hour later: the grace keeps its first start (read back from KV), nothing written
  clock.t = NOW + 2 * H;
  const fresh = {};
  const r4 = await authSync({ env: cf.env, keys: V.keys, store: V.store, outDir: V.out, now: clock.t, state: fresh, fetchImpl: cf.fetchImpl, sleep: noSleep });
  assert.equal(r4.changed, false); assert.match(r4.line, /in sync$/);
  assert.equal(fresh.rotAt, NOW + H);
  // 6 hours after the rotation: the grace entries go (KV's own expiration too)
  clock.t = NOW + H + GRACE_MS + 60e3;
  const r5 = await authSync({ env: cf.env, keys: V.keys, store: V.store, outDir: V.out, now: clock.t, state: fresh, fetchImpl: cf.fetchImpl, sleep: noSleep });
  assert.match(r5.line, /^api auth: 2 tokens \(owner 1, guests 0, members 1\);/);
  assert.equal((await ask(tB)).status, 401, 'the old generation refused after the grace');
  assert.equal((await ask(await guestToken(V, b.kek))).status, 200);
  assert.ok(publicOnly([...lines, r4.line, r5.line, ...say]), [...lines, ...say].join('\n'));
});

test('authSync never throws: no secrets, no key slots, not deployed, a wrong vault, a failing API: one line with a word', noSql, async () => {
  const V = makeVault();
  addGuest(V);
  const base = { keys: V.keys, store: V.store, outDir: V.out, now: NOW, sleep: noSleep };
  const lines = [];
  const go = async (o) => { const r = await authSync({ ...base, state: {}, ...o }); lines.push(r.line); return r; };
  assert.equal((await go({ env: {} })).line, 'api auth: skipped');
  const cf = fakeCloud({ sqlite });
  assert.equal((await go({ env: cf.env, fetchImpl: cf.fetchImpl, outDir: tmp() })).line, 'api auth: skipped (no key slots)');
  assert.equal((await go({ env: cf.env, fetchImpl: cf.fetchImpl })).line, 'api auth: skipped (not deployed yet: worker deploy)');
  assert.equal((await go({ env: cf.env, fetchImpl: fakeCloud({ sqlite, dbExists: false }).fetchImpl })).line, 'api auth: skipped (no archive database)');
  const other = makeVault();
  assert.equal((await go({ env: cf.env, fetchImpl: cf.fetchImpl, keys: other.keys })).line, 'api auth: error keys');
  // deployed, then the API fails in different ways
  const ok = fakeCloud({ sqlite });
  await job('deploy', { env: ok.env, fetchImpl: ok.fetchImpl, wait: noSleep, say: () => {} });
  const failing = (status) => fakeCloud({ sqlite, fail: (u) => (u.pathname.endsWith('/keys') ? new Response('{"success":false,"errors":[{"code":10000,"message":"made-up 0xdeadbeefdeadbeef"}]}', { status }) : null) });
  for (const [status, word] of [[500, 'server'], [429, 'rate'], [403, 'auth']]) {
    const f = failing(status);
    f.db.exec(`INSERT INTO meta (k, v) VALUES ('${KV_META_KEY}', '${'a'.repeat(32)}')`);
    assert.equal((await go({ env: f.env, fetchImpl: f.fetchImpl })).line, `api auth: error ${word}`);
  }
  const net = fakeCloud({ sqlite, fail: (u) => (u.host === 'api.cloudflare.com' ? () => { throw new TypeError('fetch failed: made-up 10.0.0.1'); } : null) });
  assert.equal((await go({ env: net.env, fetchImpl: net.fetchImpl })).line, 'api auth: error network');
  const st = { ns: 'b'.repeat(32) }; // a namespace that went away: looked up again next time
  const r = await authSync({ ...base, env: ok.env, fetchImpl: ok.fetchImpl, state: st });
  assert.equal(r.line, 'api auth: error notfound'); assert.equal(st.ns, null);
  assert.match((await authSync({ ...base, env: ok.env, fetchImpl: ok.fetchImpl, state: st })).line, /^api auth: 2 tokens/);
  assert.ok(publicOnly(lines), lines.join('\n'));
});

test('the loop syncs after the keys step (start and each pass whose keys step went through); a failing sync never fails a pass', async () => {
  const lockDir = tmp(), out = tmp();
  initLock({ dir: lockDir, passphrase: DUMMY, iterations: 1000 });
  const store = openStore({ lockDir, outDir: out, env: { LOCK_PASSPHRASE: DUMMY } });
  let clock = NOW;
  const order = [], lines = [];
  const deps = (o = {}) => ({
    store, say: (s) => lines.push(s), now: () => clock, sleep: async (ms) => { clock += ms; }, marker: () => {}, restore: () => {}, sealedLog: () => ({ lines: 1, errors: 0, categories: {} }),
    publish: () => order.push('publish'),
    runPass: async (cmd, { pass }) => { clock += 40e3; return { ok: rehearsalPass({ env: { LOOP_PASS: String(pass), REHEARSAL_FAIL_PASS: '0' }, store, t: clock }) === 0 }; },
    guests: (phase) => { order.push(`keys ${phase}`); if (o.keysFail && phase === 'pass') throw new Error('bad keys: made up'); },
    apiAuth: async (phase) => { order.push(`auth ${phase}`); if (o.authThrows) throw new Error('made-up 0xdeadbeef secret'); },
  });
  const r = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 2 }, deps());
  assert.equal(r.ok, 2);
  assert.deepEqual(order, ['keys start', 'auth start', 'keys pass', 'auth pass', 'publish', 'keys pass', 'auth pass', 'publish']);
  order.length = 0;
  const f = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 1 }, deps({ keysFail: true }));
  assert.deepEqual(order, ['keys start', 'auth start', 'keys pass'], 'a keys step that failed: no sync, no publish');
  assert.equal(f.ok, 0);
  order.length = 0; lines.length = 0;
  const t = await runLoop({ passCmd: 'made-up pass', mode: 'rehearsal', spacing: 30, maxPasses: 1 }, deps({ authThrows: true }));
  assert.equal(t.ok, 1, 'the pass is still ok and published');
  assert.ok(order.includes('publish'));
  assert.equal(lines.filter((l) => l === 'api auth: error internal').length, 2);
  assert.ok(lines.every((l) => !/deadbeef|secret/.test(l)));
  // the live wiring: the sync is the loop's own dependency, live mode only
  const src = fs.readFileSync(new URL('../scripts/loop.mjs', import.meta.url), 'utf8');
  assert.match(src, /apiAuth: dryRun \? null : async \(phase\) => \{\n\s+const r = await authSync\(\{ keys, store, state: auth\.state \}\);/);
});

test('the worker job: deploy (namespace made once, its id recorded, the modules and bindings uploaded), test, cleanup and sync; public lines only', noSql, async () => {
  const clock = { t: NOW };
  const cf = fakeCloud({ sqlite, clock });
  // made-up archive rows so the find answers and the day and hour checks have a pool
  const today = Math.floor(NOW / D) * D, pid = '0x' + 'ab'.repeat(20);
  cf.db.prepare("INSERT INTO pools (pool_key, pool_id, chain, symbol0, symbol1, written_at) VALUES (1, ?, 'base', 'MADE', 'UP', 1)").run(pid);
  for (let i = 1; i <= 40; i++) cf.db.prepare("INSERT INTO pool_day (pool_id, day_utc, fees_usd, fees_src, fees_rank, fees_unconfirmed, volume_usd, tvl_usd, written_at) VALUES (?, ?, ?, 'x', 2, 0, ?, 1e5, 1)")
    .run(pid, new Date(today - i * D).toISOString().slice(0, 10), i === 4 ? 900 : 10 + (i % 4), 1e4);
  for (let i = 3; i < 200; i++) cf.db.prepare('INSERT INTO pool_hour (pool_key, hour, sec, written_at) VALUES (1, ?, 30, 1)').run(Math.floor(NOW / H) - i);
  const lines = [];
  const opts = (o = {}) => ({ env: { ...cf.env, BUILD: 'c'.repeat(40) }, fetchImpl: cf.fetchImpl, wait: async (ms) => { clock.t += ms; }, clock: () => clock.t, say: (s) => lines.push(s), ...o });
  assert.equal(await job('deploy', opts()), 0, lines.join('\n'));
  assert.ok(lines.includes('KV namespace assim-ls-auth: created; its id recorded in the archive\'s meta: yes'));
  assert.ok(lines.includes(`Worker host: ${HOST}`));
  assert.ok(lines.some((l) => /^smoke: .* 401 'auth' .*: pass$/.test(l)));
  const up = cf.script.uploaded;
  assert.equal(up.metadata.main_module, 'index.mjs');
  const ns = [...cf.namespaces.keys()][0];
  assert.deepEqual(up.metadata.bindings, [{ type: 'd1', name: 'DB', id: DB_ID }, { type: 'kv_namespace', name: 'AUTH', namespace_id: ns }, { type: 'plain_text', name: 'BUILD', text: 'c'.repeat(12) }]);
  assert.equal(up.modules['index.mjs'].text, fs.readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8'));
  assert.equal(up.modules['api.mjs'].text, fs.readFileSync(new URL('../worker/api.mjs', import.meta.url), 'utf8'));
  assert.ok(Object.values(up.modules).every((m) => m.type === 'application/javascript+module'));
  assert.equal(cf.db.prepare('SELECT v FROM meta WHERE k = ?').get(KV_META_KEY).v, ns);
  // again: the same namespace; with its record lost, found through the Worker's own binding (no listing of the account)
  assert.equal(await job('deploy', opts()), 0);
  cf.db.prepare('DELETE FROM meta WHERE k = ?').run(KV_META_KEY);
  assert.equal(await job('deploy', opts()), 0);
  assert.equal(cf.namespaces.size, 1);
  assert.ok(!cf.calls.some((c) => c.method === 'GET' && c.path.endsWith('/storage/kv/namespaces')), 'the account\'s namespaces are never listed');
  // test: every check passes; the test tokens are gone afterwards
  lines.length = 0;
  assert.equal(await job('test', opts()), 0, lines.join('\n'));
  assert.ok(lines.at(-1).endsWith('PASS'));
  assert.ok(!lines.some((l) => l.endsWith(': FAIL')));
  assert.equal([...cf.namespaces.get(ns).keys.values()].filter((x) => x.metadata?.k === 'test').length, 0);
  assert.ok(publicOnly(lines), lines.join('\n'));
  // planted faults: a Worker that serves an ended token, or answers any origin, fails the test
  for (const bad of [
    { fetch: (req, env) => makeHandler({ now: () => clock.t }).fetch(req, { ...env, AUTH: { get: async (k, o) => { const v = await env.AUTH.get(k, o); return v && { r: v.r }; } } }) },
    { fetch: async (req, env) => { const r = await makeHandler({ now: () => clock.t }).fetch(new Request(req.url, { method: req.method, headers: [...req.headers].filter(([k]) => k !== 'origin') }), env); const h = new Headers(r.headers); h.set('access-control-allow-origin', '*'); return new Response(r.body, { status: r.status, headers: h }); } },
  ]) {
    const c2 = fakeCloud({ sqlite, clock, handler: bad });
    await job('deploy', { ...opts(), env: c2.env, fetchImpl: c2.fetchImpl, say: () => {} });
    const l2 = [];
    assert.equal(await job('test', { ...opts(), env: c2.env, fetchImpl: c2.fetchImpl, say: (s) => l2.push(s) }), 1);
    assert.ok(l2.some((l) => l.endsWith(': FAIL')) && l2.at(-1).endsWith('FAIL'));
  }
  // cleanup: a test token left behind is removed
  cf.namespaces.get(ns).keys.set('t:' + '7'.repeat(64), { value: '{"r":"test","e":null}', metadata: { r: 'test', k: 'test' }, exp: null });
  lines.length = 0;
  assert.equal(await job('cleanup', opts()), 0);
  assert.ok(lines.includes('test tokens removed: 1'));
  // sync: the loop's sync once, then the owner's and every slot's token, derived as the pages derive them, accepted
  const V = makeVault();
  addGuest(V); addGuest(V, { role: 'member' });
  lines.length = 0;
  assert.equal(await job('sync', opts({ lock: { keys: V.keys }, outDir: V.out })), 0, lines.join('\n'));
  assert.ok(lines.includes('api auth: 3 tokens (owner 1, guests 1, members 1); 3 written, 0 removed'));
  assert.ok(lines.some((l) => /^each live slot's token, .*: 2 of 2 accepted, 2 with the slot's role: pass$/.test(l)));
  assert.ok(publicOnly(lines), lines.join('\n'));
  // no database: stops at once
  const none = fakeCloud({ sqlite, dbExists: false });
  lines.length = 0;
  assert.equal(await job('test', opts({ env: none.env, fetchImpl: none.fetchImpl })), 1);
  assert.deepEqual(lines, ['database assim-ls-archive exists: no']);
});

test('the workflow: dispatch only, secrets through env only, tests first, cleanup always after a test', () => {
  const y = fs.readFileSync(new URL('../.github/workflows/worker.yml', import.meta.url), 'utf8');
  assert.match(y, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(y, /schedule:|push:|pull_request/);
  assert.match(y, /options: \[deploy, test, sync, cleanup\]/);
  assert.equal(/run:[^\n]*\$\{\{\s*secrets\./.test(y), false, 'never a secret inside a run line');
  for (const l of y.split('\n').filter((x) => /secrets\./.test(x))) assert.match(l, /^\s+[A-Z_]+: \$\{\{ (?:\(.*\) && )?secrets\.[A-Z_]+(?: \|\| '')? \}\}\s*(#.*)?$/, l);
  assert.match(y, /node --test test\/worker\.test\.mjs test\/apitoken\.test\.mjs test\/apiauth\.test\.mjs/);
  assert.match(y, /if: always\(\) && inputs\.mode == 'test'[\s\S]*node scripts\/worker\.mjs cleanup/);
  assert.match(y, /permissions:\n {2}contents: read/);
});
