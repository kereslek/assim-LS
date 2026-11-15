// Key slots (docs/briefs/guest-access.md). Two random data keys: the market key (MDEK) seals the market files, the private
// key (PDEK) the owner-only files. A random master key (MK) wraps both; keys.json on the data branch wraps MK for each owner
// passphrase and for the recovery key, and wraps the market key alone for each guest. A passphrase change, a new recovery
// key or a guest only adds or drops a slot: no file is sealed again, except the market files when a guest leaves.
// keys.json = { keys: 2, t, iter, gsalt, rsalt, owner: [Slot], recovery: Slot|null, mk: Slot, slots: [Slot] }
//   Slot = { iv, ct }: AES-256-GCM over JSON, its kind bound as additional data
//   owner slot    (aad 'lps-owner-slot')    under PBKDF2(passphrase, lock.json salt, iter): { m: MK }
//   recovery slot (aad 'lps-recovery-slot') under PBKDF2(recovery key, rsalt, iter):       { m: MK }
//   master slot   (aad 'lps-master-slot')   under MK: { k: MDEK, p: [older MDEKs], pk: PDEK, pp: [older PDEKs], tk: inbox token, g }
//   guest slot    (aad 'lps-guest-slot')    under PBKDF2(guest passphrase, gsalt, iter):   { k: MDEK, s: slot id, n: name, e: expiry|null, g }
// Before the first migration there is no keys.json: the lock's own key seals everything, as before. The migration keeps that
// key as the first "older" private key and the lock's token as the inbox token, so older files and the sealed config still open.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveKeys, unlock, ITERATIONS } from './lock.mjs';

export const KEYS_FILE = 'keys.json', STATUS_FILE = 'status.json';
export const MARKET_FILES = Object.freeze(['live.json', 'history.json', 'backtest.json']);
export const OWNER_FILES = Object.freeze(['log.json', 'snapshots.json', 'owner.json', 'guests.json']);
export const MAX_SLOTS = 24, MAX_OWNER = 4, KEEP_PREV = 2;
const AAD = { owner: 'lps-owner-slot', recovery: 'lps-recovery-slot', master: 'lps-master-slot', guest: 'lps-guest-slot' };
export const isMarket = (name) => MARKET_FILES.includes(name);
export const b64ok = (s, len) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && (len == null || Buffer.from(s, 'base64').length === len);
const B = (s) => Buffer.from(s, 'base64'), S64 = (b) => b.toString('base64');

// ---- slots ----------------------------------------------------------------------------------------------
export function wrapSlot(obj, key, kind) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('bad key: a slot key is 32 bytes');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(AAD[kind]));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: S64(iv), ct: S64(ct) };
}
export function unwrapSlot(slot, key, kind) {
  const all = B(slot.ct);
  const d = crypto.createDecipheriv('aes-256-gcm', key, B(slot.iv));
  d.setAAD(Buffer.from(AAD[kind]));
  d.setAuthTag(all.subarray(all.length - 16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8'));
}
export const tryUnwrap = (slot, key, kind) => { try { return unwrapSlot(slot, key, kind); } catch { return null; } };

export const isSlot = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && b64ok(x.iv, 12) && b64ok(x.ct) && B(x.ct).length > 16 && Object.keys(x).length === 2;
const KEYS_FIELDS = ['keys', 't', 'iter', 'gsalt', 'rsalt', 'owner', 'recovery', 'mk', 'slots'];
export function isKeysFile(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && x.keys === 2 && Number.isFinite(x.t) && Number.isInteger(x.iter) && x.iter >= 1000 &&
    b64ok(x.gsalt, 16) && (x.rsalt === null || b64ok(x.rsalt, 16)) && Array.isArray(x.owner) && x.owner.length >= 1 && x.owner.length <= MAX_OWNER &&
    x.owner.every(isSlot) && (x.recovery === null || isSlot(x.recovery)) && (x.recovery === null) === (x.rsalt === null) && isSlot(x.mk) &&
    Array.isArray(x.slots) && x.slots.length <= MAX_SLOTS && x.slots.every(isSlot) && Object.keys(x).length === KEYS_FIELDS.length && KEYS_FIELDS.every((k) => k in x);
}

// ---- the vault: what the master key opens ------------------------------------------------------------------
// { aes: PDEK (owner files), token (the inbox key's seed), mdek, prev, pprev, gen, mk, pass?, slotCt? }
export function openMaster(keysFile, mk) {
  const m = tryUnwrap(keysFile.mk, mk, 'master');
  const keys = (a) => Array.isArray(a) && a.every((x) => b64ok(x, 32));
  if (!m || !b64ok(m.k, 32) || !b64ok(m.pk, 32) || !b64ok(m.tk, 32) || !keys(m.p) || !keys(m.pp) || !Number.isInteger(m.g)) throw new Error('refusing: keys.json does not open with this lock');
  return { aes: B(m.pk), token: B(m.tk), mdek: B(m.k), prev: m.p.map(B), pprev: m.pp.map(B), gen: m.g, mk };
}
// The master key from a passphrase's key (any owner slot) or from the recovery key.
export function masterFrom(keysFile, key, kind = 'owner') {
  const list = kind === 'owner' ? keysFile.owner : keysFile.recovery ? [keysFile.recovery] : [];
  for (const s of list) { const o = tryUnwrap(s, key, kind); if (o && b64ok(o.m, 32)) return { mk: B(o.m), slotCt: s.ct }; }
  return null;
}
// What a passphrase opens: with keys.json, any owner slot (and only an owner slot); without it, the lock's own check.
// A passphrase that opens nothing throws "wrong passphrase" and nothing is read or sealed.
export function openVault(lockFile, passphrase, keysFile) {
  const d = deriveKeys(passphrase, lockFile.salt, lockFile.iter);
  if (!keysFile) { unlock(lockFile, passphrase); return { aes: d.aes, token: d.token, pass: d.aes, mdek: null, prev: [], pprev: [], gen: null, mk: null, legacy: true }; }
  if (!isKeysFile(keysFile)) throw new Error('bad keys: keys.json is not a keys file');
  const m = masterFrom(keysFile, d.aes, 'owner');
  if (!m) throw new Error('wrong passphrase: it opens no owner slot of keys.json (refusing to seal or open anything)');
  return { ...openMaster(keysFile, m.mk), pass: d.aes, slotCt: m.slotCt };
}
// The vault again for a newer keys.json, from what this process already holds (the master key, or the passphrase's key).
export function reopen(keys, keysFile) {
  if (!keysFile) return keys.mdek ? null : { ...keys, legacy: true };
  if (!isKeysFile(keysFile)) throw new Error('bad keys: keys.json is not a keys file');
  const pass = keys.pass || (keys.mdek ? null : keys.aes); // a key from before the migration is the passphrase's own
  if (keys.mk) { try { return { ...openMaster(keysFile, keys.mk), pass, slotCt: pass ? masterFrom(keysFile, pass)?.slotCt ?? null : null }; } catch { /* a new master key: try the passphrase */ } }
  if (pass) { const m = masterFrom(keysFile, pass, 'owner'); if (m) return { ...openMaster(keysFile, m.mk), pass, slotCt: m.slotCt }; }
  throw new Error('wrong passphrase: it opens no owner slot of keys.json (refusing to seal or open anything)');
}

// A guest's view: the first slot that opens with this key, or null (removed, expired by the loop, or a wrong passphrase).
export function openGuestSlot(keysFile, kek) {
  if (!isKeysFile(keysFile)) return null;
  for (const s of keysFile.slots) {
    const g = tryUnwrap(s, kek, 'guest');
    if (g && b64ok(g.k, 32)) return { dek: B(g.k), slot: g.s, name: g.n, exp: g.e ?? null, gen: g.g };
  }
  return null;
}
export const guestKek = (passphrase, gsalt, iter = ITERATIONS) => deriveKeys(passphrase, gsalt, iter).aes;

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const older = (list, cur) => list.filter((x) => !x.equals(cur)).slice(0, KEEP_PREV).map(S64);

// v: { mk, mdek, prev, aes (PDEK), pprev, token, gen }; owner: the owner slots as they are (opaque); guests: [{ s, n, e, kek }]
export function buildKeysFile({ v, owner, recovery = null, rsalt = null, gsalt, iter = ITERATIONS, guests = [], t = Date.now() }) {
  if (guests.length > MAX_SLOTS) throw new Error(`refusing: at most ${MAX_SLOTS} guest slots`);
  if (!owner.length || owner.length > MAX_OWNER) throw new Error(`refusing: 1 to ${MAX_OWNER} owner slots`);
  return {
    keys: 2, t, iter, gsalt, rsalt: recovery ? rsalt : null, owner: owner.map((s) => ({ iv: s.iv, ct: s.ct })), recovery: recovery ? { iv: recovery.iv, ct: recovery.ct } : null,
    mk: wrapSlot({ k: S64(v.mdek), p: older(v.prev, v.mdek), pk: S64(v.aes), pp: older(v.pprev, v.aes), tk: S64(v.token), g: v.gen }, v.mk, 'master'),
    slots: shuffle(guests.map((g) => wrapSlot({ k: S64(v.mdek), s: g.s, n: g.n, e: g.e ?? null, g: v.gen }, g.kek, 'guest'))),
  };
}
// The first keys.json: fresh master, market and private keys; the lock's key stays as the older private key (every file sealed
// before keeps opening) and its token stays the inbox's seed (lock/inbox.json and the sealed config don't change).
export function migrateKeys({ pass, token, iter = ITERATIONS, t = Date.now(), rand = crypto.randomBytes }) {
  const v = { mk: rand(32), mdek: rand(32), prev: [], aes: rand(32), pprev: [pass], token, gen: 0 };
  return { v, keysFile: buildKeysFile({ v, owner: [wrapSlot({ m: S64(v.mk) }, pass, 'owner')], gsalt: S64(rand(16)), iter, t }) };
}

export function readKeysFile(dir) {
  const f = path.join(dir, KEYS_FILE);
  if (!fs.existsSync(f)) return null;
  let x;
  try { x = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error('bad keys: keys.json is not JSON'); }
  if (!isKeysFile(x)) throw new Error('bad keys: keys.json is not a keys file');
  return x;
}

// The keys a process holding the lock uses for a folder of sealed files. keys: openLock's (the vault, or the lock's own key
// before the migration). Market files: the market key once there is one; every other file: the private key.
export function ringOf(keys, keysFile) {
  const v = keysFile ? reopen(keys, keysFile) : { aes: keys.pass || keys.aes, mdek: null, prev: [], pprev: keys.pprev || [], token: keys.token };
  const own = v.aes, dek = v.mdek || null;
  return {
    ...v, dek, owner: own,
    keyFor: (name) => (isMarket(name) && dek ? dek : own),
    // every key that may open a file: its own first, then the others (a file sealed before a rotation or the migration)
    openers: (name) => uniq([isMarket(name) && dek ? dek : own, dek, ...(v.prev || []), own, ...(v.pprev || []), keys.aes, keys.mdek, ...(keys.prev || [])]),
  };
}
export const ringFor = (keys, dir) => ringOf(keys, readKeysFile(dir));
export function uniq(keys) {
  const out = [];
  for (const k of keys) if (Buffer.isBuffer(k) && !out.some((x) => x.equals(k))) out.push(k);
  return out;
}

// ---- the private split: owner-only fields never go under the market key ----------------------------------------
export const PRIVATE_FIELDS = Object.freeze({ 'live.json': Object.freeze(['ticket', 'stopLoss', 'gemAt']), 'backtest.json': Object.freeze(['ticket']) });
const AGE_ID = 'token-age-rank', AGE_RE = /^(tokens ranked and trading )(\d+)\+ days$/, AGE_PLAIN = 'tokens ranked and trading long enough';

// { market, owner }: market is obj without the owner's fields; owner is what moved (live.json only; null otherwise).
export function splitPrivate(name, obj) {
  const fields = PRIVATE_FIELDS[name];
  if (!fields || !obj || typeof obj !== 'object') return { market: obj, owner: null };
  const market = { ...obj };
  for (const f of fields) delete market[f];
  if (name !== 'live.json') return { market, owner: null };
  const owner = { v: 1, t: obj.t };
  for (const f of fields) owner[f] = obj[f] ?? null;
  owner.ageDays = null;
  if (Array.isArray(obj.pools)) {
    market.pools = obj.pools.map((p) => {
      if (!p || !Array.isArray(p.checks) || !p.checks.some((c) => c && c.id === AGE_ID && AGE_RE.test(c.label))) return p;
      return { ...p, checks: p.checks.map((c) => {
        const m = c && c.id === AGE_ID ? AGE_RE.exec(c.label) : null;
        if (!m) return c;
        owner.ageDays = Number(m[2]);
        return { ...c, label: AGE_PLAIN };
      }) };
    });
  }
  return { market, owner };
}

// The inverse: the owner's process sees the objects it always saw.
export function mergePrivate(name, market, owner) {
  if (!market || typeof market !== 'object' || !owner) return market;
  const out = { ...market };
  if (name === 'live.json') {
    for (const f of PRIVATE_FIELDS[name]) if (!(f in out)) out[f] = owner[f] ?? null;
    if (Number.isInteger(owner.ageDays) && Array.isArray(out.pools)) {
      out.pools = out.pools.map((p) => (!p || !Array.isArray(p.checks) || !p.checks.some((c) => c && c.id === AGE_ID && c.label === AGE_PLAIN) ? p
        : { ...p, checks: p.checks.map((c) => (c && c.id === AGE_ID && c.label === AGE_PLAIN ? { ...c, label: `tokens ranked and trading ${owner.ageDays}+ days` } : c)) }));
    }
  } else if (name === 'backtest.json' && !('ticket' in out) && owner.ticket != null) out.ticket = owner.ticket;
  return out;
}

// Owner-only fields still in a market object (by name only): [] when clean.
export function privateIn(name, obj) {
  if (!obj || typeof obj !== 'object') return [];
  const hit = (PRIVATE_FIELDS[name] || []).filter((f) => f in obj);
  if (name === 'live.json' && Array.isArray(obj.pools) && obj.pools.some((p) => Array.isArray(p?.checks) && p.checks.some((c) => c && c.id === AGE_ID && AGE_RE.test(c.label)))) hit.push('ageDays');
  return hit;
}

// The status flag (status.json on the data branch, readable): the loop's passphrase opens no slot. Nothing else is in it.
export const isStatusFile = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && x.lock === 'mismatch' && Number.isFinite(x.since) && Object.keys(x).length === 2;
