// The lock: every file the scanner publishes is sealed with AES-256-GCM.
// key = PBKDF2-SHA256(passphrase, salt, 600k rounds, 64 bytes): the first 32 bytes are the AES key,
// the last 32 a token (the inbox key is derived from it). Envelope: {"lock":1,"t":ms,"z":1?,"iv","ct"}
// where only t is readable; z marks gzip-before-seal (the page inflates with DecompressionStream).
//
// lock/lock.json = { lock: 1, salt, iter, check } is created once and never rewritten: a new salt
// would orphan every sealed file. lock/inbox.json = { v: 1, x25519 } is the inbox public key only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { inboxKeys } from './inbox.mjs';

export const ITERATIONS = 600000;
export const LOCK_DIR = 'lock';
const CHECK = 'lps-lock-check-v1';

export function deriveKeys(passphrase, saltB64, iterations = ITERATIONS) {
  const raw = crypto.pbkdf2Sync(String(passphrase), Buffer.from(saltB64, 'base64'), iterations, 64, 'sha256');
  return { aes: raw.subarray(0, 32), token: raw.subarray(32) };
}

export function seal(data, aes, { gzip = true, t = Date.now() } = {}) {
  const plain = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const body = gzip ? zlib.gzipSync(plain) : plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const ct = Buffer.concat([c.update(body), c.final(), c.getAuthTag()]);
  return { lock: 1, t, ...(gzip ? { z: 1 } : {}), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

export function open(env, aes) {
  if (!isEnvelope(env)) throw new Error('not a sealed envelope');
  const iv = Buffer.from(env.iv, 'base64'), all = Buffer.from(env.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aes, iv);
  d.setAuthTag(all.subarray(all.length - 16));
  const body = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
  return (env.z ? zlib.gunzipSync(body) : body).toString('utf8');
}

// A sealed envelope has exactly these keys; anything else (a stray plaintext field) is refused.
const ENV_KEYS = new Set(['lock', 't', 'z', 'iv', 'ct']);
export function isEnvelope(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x) && x.lock === 1 && typeof x.iv === 'string' &&
    typeof x.ct === 'string' && Number.isFinite(x.t) && (x.z === undefined || x.z === 1) &&
    Object.keys(x).every((k) => ENV_KEYS.has(k));
}

export function isLockFile(x) {
  return !!x && typeof x === 'object' && x.lock === 1 && typeof x.salt === 'string' && Buffer.from(x.salt, 'base64').length >= 16 &&
    Number.isInteger(x.iter) && x.iter >= 1000 && isEnvelope(x.check) &&
    Object.keys(x).every((k) => ['lock', 'salt', 'iter', 'check'].includes(k));
}

export function newLockFile(passphrase, iterations = ITERATIONS) {
  const salt = crypto.randomBytes(16).toString('base64');
  const { aes } = deriveKeys(passphrase, salt, iterations);
  return { lock: 1, salt, iter: iterations, check: seal(CHECK, aes, { gzip: false, t: 0 }) };
}

// A wrong passphrase stops everything: it must never reseal files under a new key.
export function unlock(lockFile, passphrase) {
  const keys = deriveKeys(passphrase, lockFile.salt, lockFile.iter);
  let ok = false;
  try { ok = open(lockFile.check, keys.aes) === CHECK; } catch { ok = false; }
  if (!ok) throw new Error('wrong passphrase: refusing to seal or open anything');
  return keys;
}

export function passphraseFrom(env = process.env) {
  const p = env.LOCK_PASSPHRASE;
  if (typeof p !== 'string' || p.length === 0) throw new Error('missing passphrase: LOCK_PASSPHRASE is not set');
  return p;
}

export function readLock(dir = LOCK_DIR) {
  const file = path.join(dir, 'lock.json');
  if (!fs.existsSync(file)) throw new Error('missing lock: no lock.json, run the lock-init workflow first');
  let x;
  try { x = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('bad lock: lock.json is not JSON'); }
  if (!isLockFile(x)) throw new Error('bad lock: lock.json is not a lock file');
  return x;
}

// Read the lock, check the passphrase from the environment, return the keys (or throw).
export function openLock({ dir = LOCK_DIR, env = process.env } = {}) {
  const lockFile = readLock(dir);
  return { lockFile, keys: unlock(lockFile, passphraseFrom(env)) };
}

export function inboxFile(publicB64) {
  return { v: 1, x25519: publicB64 };
}

// Create lock.json and inbox.json once. If lock.json exists it is never touched: the passphrase is
// checked against it and the answer is yes/no. Returns counts and booleans only, never a value.
export function initLock({ dir = LOCK_DIR, passphrase, iterations = ITERATIONS, verifyOnly = false } = {}) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('missing passphrase: LOCK_PASSPHRASE is not set');
  const lockPath = path.join(dir, 'lock.json'), inboxPath = path.join(dir, 'inbox.json');
  const res = { existed: fs.existsSync(lockPath), created: false, opens: false, inboxWritten: false, inboxMatches: false };
  if (!res.existed) {
    if (verifyOnly) throw new Error('missing lock: no lock.json to verify');
    fs.mkdirSync(dir, { recursive: true });
    const lockFile = newLockFile(passphrase, iterations);
    fs.writeFileSync(lockPath, JSON.stringify(lockFile, null, 1) + '\n', { flag: 'wx' }); // never overwrite, even in a race
    res.created = true;
  }
  const lockFile = readLock(dir);
  let keys = null;
  try { keys = unlock(lockFile, passphrase); res.opens = true; } catch { res.opens = false; }
  if (!keys) return res;
  const pub = inboxKeys(keys.token).publicB64;
  let have = null;
  try { have = JSON.parse(fs.readFileSync(inboxPath, 'utf8')); } catch { have = null; }
  if (have && have.x25519 === pub) res.inboxMatches = true;
  else if (!have && !verifyOnly) {
    fs.writeFileSync(inboxPath, JSON.stringify(inboxFile(pub), null, 1) + '\n');
    res.inboxWritten = res.inboxMatches = true;
  }
  return res;
}
