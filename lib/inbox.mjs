// Sealed inbox: anyone can seal a private input (a wallet, a ticket size, a position id) to the
// published X25519 public key; only the scanner, which holds the lock, can open it.
// Private key = X25519 from HKDF-SHA256(lock token, info 'lps-inbox-x25519').
// Seal: ephemeral X25519 -> ECDH -> HKDF(salt = ephemeral public key, info 'lps-inbox') -> AES-256-GCM.
import crypto from 'node:crypto';

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
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pub = crypto.createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(publicB64, 'base64')]), format: 'der', type: 'spki' });
  const k = keyFor(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), epk);
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final(), c.getAuthTag()]);
  return { inbox: 1, epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

export function inboxOpen(env, privateKey) {
  if (!env || env.inbox !== 1) throw new Error('not an inbox envelope');
  const epk = Buffer.from(env.epk, 'base64');
  const pub = crypto.createPublicKey({ key: Buffer.concat([X_SPKI, epk]), format: 'der', type: 'spki' });
  const k = keyFor(crypto.diffieHellman({ privateKey, publicKey: pub }), epk);
  const all = Buffer.from(env.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8');
}
