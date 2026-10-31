// The lock: every file the scanner publishes is sealed with AES-256-GCM.
// key = PBKDF2-SHA256(passphrase, salt, 600k rounds, 64 bytes): the first 32 bytes are the AES key,
// the last 32 a token (the inbox key is derived from it). Envelope: {"lock":1,"t":ms,"z":1?,"iv","ct"}
// where only t is readable; z marks gzip-before-seal (the page inflates with DecompressionStream).
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const ITERATIONS = 600000;
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
  if (!env || env.lock !== 1 || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new Error('not a sealed envelope');
  const iv = Buffer.from(env.iv, 'base64'), all = Buffer.from(env.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aes, iv);
  d.setAuthTag(all.subarray(all.length - 16));
  const body = Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
  return (env.z ? zlib.gunzipSync(body) : body).toString('utf8');
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
