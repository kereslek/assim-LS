// Page-side check: the browser dashboard opens envelopes with WebCrypto (PBKDF2-SHA256, AES-GCM) and
// inflates with DecompressionStream('gzip'). webOpen below uses only those web APIs, nothing from
// node:crypto or node:zlib, so the page's code can mirror it line for line. It must open what
// lib/lock.mjs seals, and refuse a wrong passphrase or a tampered file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newLockFile, seal, unlock } from '../lib/lock.mjs';

const DUMMY = 'dummy passphrase for the page-side check';

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function webKey(passphrase, lockFile) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(lockFile.salt), iterations: lockFile.iter }, base, 512));
  return subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['decrypt']);
}

async function webOpenWith(key, env) {
  const plain = new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.ct)));
  if (!env.z) return new TextDecoder().decode(plain);
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// What the page does: derive once, prove the passphrase on lock.check, then open each file.
async function webUnlock(passphrase, lockFile) {
  const key = await webKey(passphrase, lockFile);
  let ok = false;
  try { ok = (await webOpenWith(key, lockFile.check)) === 'lps-lock-check-v1'; } catch { ok = false; }
  if (!ok) throw new Error('wrong passphrase');
  return key;
}

test('WebCrypto opens what lib/lock.mjs seals (gzip and plain), at production rounds', async () => {
  assert.equal(typeof globalThis.crypto?.subtle?.deriveBits, 'function');
  assert.equal(typeof DecompressionStream, 'function');
  const lockFile = newLockFile(DUMMY); // 600k rounds, as the real lock
  const { aes } = unlock(lockFile, DUMMY);
  const live = { v: 1, t: 1700000000000, ticket: 1000, pools: [{ id: 'made-up', pair: 'MADEUP/WETH', gem: 71, note: 'ü→ unicode' }] };
  const key = await webUnlock(DUMMY, lockFile);
  for (const gzip of [true, false]) {
    const env = seal(live, aes, { gzip, t: live.t });
    assert.deepEqual(JSON.parse(await webOpenWith(key, env)), live);
  }
});

test('planted faults: the page refuses a wrong passphrase and a tampered envelope', async () => {
  const lockFile = newLockFile(DUMMY, 2000);
  const { aes } = unlock(lockFile, DUMMY);
  await assert.rejects(() => webUnlock('wrong passphrase', lockFile), /wrong passphrase/);
  const key = await webUnlock(DUMMY, lockFile);
  const env = seal({ v: 1, t: 1, x: 'made-up' }, aes);
  const ct = b64(env.ct);
  ct[5] ^= 1;
  const bad = { ...env, ct: btoa(String.fromCharCode(...ct)) };
  await assert.rejects(() => webOpenWith(key, bad));
  // and an envelope sealed under another lock does not open with this key
  const other = unlock(newLockFile('another made-up passphrase', 2000), 'another made-up passphrase');
  await assert.rejects(() => webOpenWith(key, seal({ v: 1, t: 1 }, other.aes)));
});
