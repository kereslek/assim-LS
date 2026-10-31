import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKeys, seal, open, newLockFile, unlock, ITERATIONS } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal, inboxOpen } from '../lib/inbox.mjs';
import { categorize } from '../lib/quietlogs.mjs';

const DUMMY = 'dummy passphrase for tests only';

test('seal and open round-trip, with and without gzip; only t is readable', () => {
  const { aes } = deriveKeys(DUMMY, Buffer.alloc(16, 7).toString('base64'), 1000);
  const data = { pools: [{ pair: 'MADEUP/WETH', gem: 83 }], ticket: 1234 };
  for (const gzip of [true, false]) {
    const env = seal(data, aes, { gzip, t: 42 });
    assert.equal(env.t, 42);
    assert.deepEqual(JSON.parse(open(env, aes)), data);
    const text = JSON.stringify(env);
    assert.ok(!text.includes('MADEUP') && !text.includes('1234'));
  }
});

test('planted fault: a tampered envelope or a wrong key fails loudly', () => {
  const { aes } = deriveKeys(DUMMY, Buffer.alloc(16, 1).toString('base64'), 1000);
  const env = seal('secret', aes);
  const bad = { ...env, ct: Buffer.from(Buffer.from(env.ct, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64') };
  assert.throws(() => open(bad, aes));
  const other = deriveKeys('another passphrase', Buffer.alloc(16, 1).toString('base64'), 1000);
  assert.throws(() => open(env, other.aes));
  assert.throws(() => open({ t: 1 }, aes), /not a sealed envelope/);
});

test('lock file: the right passphrase unlocks, a wrong one refuses to seal anything', () => {
  const lock = newLockFile(DUMMY, 1000);
  assert.equal(lock.iter, 1000);
  assert.ok(unlock(lock, DUMMY).aes.length === 32);
  assert.throws(() => unlock(lock, 'wrong'), /wrong passphrase/);
});

test('the production lock uses 600k PBKDF2 rounds', () => {
  assert.equal(ITERATIONS, 600000);
  const lock = newLockFile(DUMMY);
  assert.equal(lock.iter, 600000);
  assert.ok(unlock(lock, DUMMY));
});

test('sealed inbox: only the lock holder opens it', () => {
  const { token } = deriveKeys(DUMMY, Buffer.alloc(16, 9).toString('base64'), 1000);
  const keys = inboxKeys(token);
  const env = inboxSeal('a private input', keys.publicB64);
  assert.ok(!JSON.stringify(env).includes('private'));
  assert.equal(inboxOpen(env, keys.privateKey), 'a private input');
  const stranger = inboxKeys(deriveKeys('someone else', Buffer.alloc(16, 9).toString('base64'), 1000).token);
  assert.throws(() => inboxOpen(env, stranger.privateKey));
});

test('sealed logs: public categories never carry addresses or numbers', () => {
  const cat = categorize(['RPC timeout on 0xabc123', '0xdeadbeef failed', '42 pools unread', 'Price missing for token']);
  assert.deepEqual(Object.keys(cat).sort(), ['Price', 'RPC', 'other']);
  for (const k of Object.keys(cat)) assert.match(k, /^[A-Za-z]+$/);
});
