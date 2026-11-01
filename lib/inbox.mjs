// Sealed inbox: anyone can seal a private input (a wallet, a ticket size, a position id) to the
// published X25519 public key; only the scanner, which holds the lock, can open it.
// Private key = X25519 from HKDF-SHA256(lock token, info 'lps-inbox-x25519').
// Seal: ephemeral X25519 -> ECDH -> HKDF(salt = ephemeral public key, info 'lps-inbox') -> AES-256-GCM.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function inboxKeys(token) {
  const seed = Buffer.from(crypto.hkdfSync('sha256', token, Buffer.alloc(0), Buffer.from('lps-inbox-x25519'), 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const publicB64 = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { privateKey, publicB64 };
}

const keyFor = (shared, epk) => Buffer.from(crypto.hkdfSync('sha256', shared, epk, Buffer.from('lps-inbox'), 32));

export function inboxSeal(text, publicB64) {
  const raw = Buffer.from(String(publicB64), 'base64');
  if (raw.length !== 32) throw new Error('bad inbox key: not a 32-byte X25519 public key');
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pub = crypto.createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: 'der', type: 'spki' });
  const k = keyFor(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), epk);
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final(), c.getAuthTag()]);
  return { inbox: 1, epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

export function inboxOpen(env, privateKey) {
  if (!env || env.inbox !== 1 || typeof env.epk !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new Error('not an inbox envelope');
  const epk = Buffer.from(env.epk, 'base64');
  const pub = crypto.createPublicKey({ key: Buffer.concat([X_SPKI, epk]), format: 'der', type: 'spki' });
  const k = keyFor(crypto.diffieHellman({ privateKey, publicKey: pub }), epk);
  const all = Buffer.from(env.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
}

// The published public key (lock/inbox.json, written by lock init). Needs no secret.
// Takes the lock folder or the inbox file's own path.
export function readInboxKey(dir = 'lock') {
  const file = String(dir).endsWith('.json') ? dir : path.join(dir, 'inbox.json');
  if (!fs.existsSync(file)) throw new Error('missing inbox key: no inbox.json, run the lock-init workflow first');
  let x;
  try { x = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('bad inbox key: inbox.json is not JSON'); }
  if (!x || x.v !== 1 || typeof x.x25519 !== 'string' || Buffer.from(x.x25519, 'base64').length !== 32) throw new Error('bad inbox key: inbox.json holds no X25519 public key');
  return x.x25519;
}

// Every string leaf of a JSON value (keys included), for the plaintext-echo check.
export function leafStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number' || typeof v === 'bigint') out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) leafStrings(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); leafStrings(x, out); }
  return out;
}

// Probes are the whole plaintext and each leaf at least 6 characters long (shorter ones would match
// random base64 by chance). A probe found in the output means the seal leaked: refuse.
export const ECHO_MIN = 6;
export function echoes(outputText, plaintext, parsed) {
  const hay = String(outputText).toLowerCase();
  const probes = [String(plaintext).trim(), ...leafStrings(parsed)].filter((s) => s.length >= ECHO_MIN);
  return probes.some((s) => hay.includes(s.toLowerCase()));
}

// Seal a JSON string to the inbox and prove the output does not carry it. Never returns or throws
// with the plaintext in a message.
export function sealChecked(text, publicB64, { sealFn = inboxSeal } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('input is not JSON: nothing sealed'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('input must be a JSON object or array: nothing sealed');
  const env = sealFn(text, publicB64);
  const out = JSON.stringify(env);
  if (!env || env.inbox !== 1 || typeof env.ct !== 'string') throw new Error('seal failed: not an inbox envelope');
  if (echoes(out, text, parsed)) throw new Error('refusing: the plaintext shows up in the sealed output');
  return { env, parsed };
}
