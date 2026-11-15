// Key slots (docs/briefs/guest-access.md). A random data key (DEK) seals the market files; keys.json on the
// data branch holds the DEK wrapped for the owner (under the lock's AES key) and for each guest (under the
// first 32 bytes of PBKDF2(guest passphrase, the shared guest salt)). Owner-only files stay under the lock's key.
// keys.json = { keys: 1, t, gsalt, iter, owner: Slot, slots: [Slot] }, Slot = { iv, ct } (AES-256-GCM, JSON inside)
//   owner slot (aad 'lps-owner-slot'): { k: DEK b64, p: [previous DEKs b64, ≤ 2], g: generation }
//   guest slot (aad 'lps-guest-slot'): { k: DEK b64, s: slot id, n: name, e: expiry ms|null, g }
// Before the first migration there is no keys.json and every file is sealed under the lock's key as before.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveKeys, ITERATIONS } from './lock.mjs';

export const KEYS_FILE = 'keys.json';
export const MARKET_FILES = Object.freeze(['live.json', 'history.json', 'backtest.json']);
export const OWNER_FILES = Object.freeze(['log.json', 'snapshots.json', 'owner.json', 'guests.json']);
export const MAX_SLOTS = 24, KEEP_PREV = 2;
const AAD = { owner: Buffer.from('lps-owner-slot'), guest: Buffer.from('lps-guest-slot') };
export const isMarket = (name) => MARKET_FILES.includes(name);
const b64ok = (s, len) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && (len == null || Buffer.from(s, 'base64').length === len);

// ---- slots ----------------------------------------------------------------------------------------------
export function wrapSlot(obj, key, kind) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('bad key: a slot key is 32 bytes');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD[kind]);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}
export function unwrapSlot(slot, key, kind) {
  const all = Buffer.from(slot.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(slot.iv, 'base64'));
  d.setAAD(AAD[kind]);
  d.setAuthTag(all.subarray(all.length - 16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8'));
}
const tryUnwrap = (slot, key, kind) => { try { return unwrapSlot(slot, key, kind); } catch { return null; } };

export const isSlot = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && b64ok(x.iv, 12) && b64ok(x.ct) &&
  Buffer.from(x.ct, 'base64').length > 16 && Object.keys(x).length === 2;

export function isKeysFile(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && x.keys === 1 && Number.isFinite(x.t) && b64ok(x.gsalt, 16) &&
    Number.isInteger(x.iter) && x.iter >= 1000 && isSlot(x.owner) && Array.isArray(x.slots) && x.slots.length <= MAX_SLOTS &&
    x.slots.every(isSlot) && Object.keys(x).every((k) => ['keys', 't', 'gsalt', 'iter', 'owner', 'slots'].includes(k));
}

// The owner's view of a keys file: { dek, prev: [Buffer], gen }. Throws when the owner slot doesn't open.
export function ownerRing(ownerAes, keysFile) {
  if (!isKeysFile(keysFile)) throw new Error('bad keys: keys.json is not a keys file');
  const o = tryUnwrap(keysFile.owner, ownerAes, 'owner');
  if (!o || !b64ok(o.k, 32) || !Array.isArray(o.p) || !o.p.every((x) => b64ok(x, 32)) || !Number.isInteger(o.g)) throw new Error('refusing: keys.json does not open with this lock');
  return { dek: Buffer.from(o.k, 'base64'), prev: o.p.map((x) => Buffer.from(x, 'base64')), gen: o.g, keysFile };
}

// A guest's view: the first slot that opens with this KEK, or null (removed, expired by the loop, or wrong key).
export function openGuestSlot(keysFile, kek) {
  if (!isKeysFile(keysFile)) return null;
  for (const s of keysFile.slots) {
    const g = tryUnwrap(s, kek, 'guest');
    if (g && b64ok(g.k, 32)) return { dek: Buffer.from(g.k, 'base64'), slot: g.s, name: g.n, exp: g.e ?? null, gen: g.g };
  }
  return null;
}

export const guestKek = (passphrase, gsalt, iter = ITERATIONS) => deriveKeys(passphrase, gsalt, iter).aes;

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// guests: [{ s, n, e, kek: Buffer }]; prev: older DEKs, newest first.
export function buildKeysFile({ ownerAes, dek, prev = [], gen = 0, gsalt, iter = ITERATIONS, guests = [], t = Date.now() }) {
  if (guests.length > MAX_SLOTS) throw new Error(`refusing: at most ${MAX_SLOTS} guest slots`);
  const p = prev.filter((x) => !x.equals(dek)).slice(0, KEEP_PREV).map((x) => x.toString('base64'));
  return {
    keys: 1, t, gsalt, iter,
    owner: wrapSlot({ k: dek.toString('base64'), p, g: gen }, ownerAes, 'owner'),
    slots: shuffle(guests.map((g) => wrapSlot({ k: dek.toString('base64'), s: g.s, n: g.n, e: g.e ?? null, g: gen }, g.kek, 'guest'))),
  };
}

export function readKeysFile(dir) {
  const f = path.join(dir, KEYS_FILE);
  if (!fs.existsSync(f)) return null;
  let x;
  try { x = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw new Error('bad keys: keys.json is not JSON'); }
  if (!isKeysFile(x)) throw new Error('bad keys: keys.json is not a keys file');
  return x;
}

// The keys a process holding the lock uses for a folder of sealed files. dek is null before the migration.
export function ringOf(ownerAes, keysFile) {
  const r = keysFile ? ownerRing(ownerAes, keysFile) : { dek: null, prev: [], gen: null, keysFile: null };
  return {
    ...r, owner: ownerAes,
    keyFor: (name) => (isMarket(name) && r.dek ? r.dek : ownerAes),
    // every key that may open a file: its own first, then the others (a file sealed before a rotation or the migration)
    openers: (name) => uniq([isMarket(name) && r.dek ? r.dek : ownerAes, r.dek, ...r.prev, ownerAes]),
  };
}
export const ringFor = (ownerAes, dir) => ringOf(ownerAes, readKeysFile(dir));
export function uniq(keys) {
  const out = [];
  for (const k of keys) if (Buffer.isBuffer(k) && !out.some((x) => x.equals(k))) out.push(k);
  return out;
}

// ---- the private split: owner-only fields never go under the DEK ------------------------------------------
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
