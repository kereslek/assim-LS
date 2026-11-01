import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveKeys, seal, open, newLockFile, unlock, ITERATIONS, initLock, isEnvelope, isLockFile, openLock, readLock } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal, inboxOpen, readInboxKey } from '../lib/inbox.mjs';
import { categorize } from '../lib/quietlogs.mjs';

const DUMMY = 'dummy passphrase for tests only';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-lock-'));

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

// ---- lock files on disk (made-up passphrases, throwaway folders) ----

test('envelope and lock-file shapes: a stray plaintext field is not an envelope', () => {
  const { aes } = deriveKeys(DUMMY, Buffer.alloc(16, 2).toString('base64'), 1000);
  const env = seal({ a: 1 }, aes, { t: 5 });
  assert.ok(isEnvelope(env));
  assert.ok(!isEnvelope({ ...env, ticket: 1234 }), 'planted fault: an extra readable field');
  assert.ok(!isEnvelope({ ...env, t: undefined }));
  assert.throws(() => open({ ...env, note: 'x' }, aes), /not a sealed envelope/);
  const lock = newLockFile(DUMMY, 1000);
  assert.ok(isLockFile(lock));
  assert.ok(!isLockFile({ ...lock, passphrase: 'x' }), 'planted fault: an extra field in lock.json');
  assert.ok(!isLockFile({ ...lock, iter: 10 }));
});

test('init creates lock.json and inbox.json once; a second init never overwrites', () => {
  const dir = path.join(tmp(), 'lock');
  const r1 = initLock({ dir, passphrase: DUMMY, iterations: 1000 });
  assert.deepEqual(r1, { existed: false, created: true, opens: true, inboxWritten: true, inboxMatches: true });
  const before = fs.readFileSync(path.join(dir, 'lock.json'), 'utf8');
  const r2 = initLock({ dir, passphrase: DUMMY, iterations: 1000 });
  assert.equal(r2.created, false);
  assert.equal(r2.opens, true);
  assert.equal(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'), before, 'the salt must never change');
  // planted fault: a wrong passphrase against an existing lock answers no and writes nothing
  const r3 = initLock({ dir, passphrase: 'wrong passphrase', iterations: 1000 });
  assert.equal(r3.opens, false);
  assert.equal(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'), before);
  // the inbox key is public and matches the lock's token
  const keys = unlock(readLock(dir), DUMMY);
  assert.equal(readInboxKey(dir), inboxKeys(keys.token).publicB64);
  assert.equal(readInboxKey(path.join(dir, 'inbox.json')), inboxKeys(keys.token).publicB64);
  const inbox = JSON.parse(fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8'));
  assert.deepEqual(Object.keys(inbox).sort(), ['v', 'x25519']);
});

test('planted fault: a lock that appears mid-init (a race) is never written through', () => {
  // A dangling link looks absent to the existence check; exclusive create must still refuse it.
  const root = tmp(), dir = path.join(root, 'lock'), target = path.join(root, 'elsewhere.json');
  fs.mkdirSync(dir);
  fs.symlinkSync(target, path.join(dir, 'lock.json'));
  assert.throws(() => initLock({ dir, passphrase: DUMMY, iterations: 1000 }), /EEXIST/);
  assert.equal(fs.existsSync(target), false);
});

test('init: a missing inbox key is rewritten from the lock, a mismatched one is reported', () => {
  const dir = path.join(tmp(), 'lock');
  initLock({ dir, passphrase: DUMMY, iterations: 1000 });
  fs.rmSync(path.join(dir, 'inbox.json'));
  assert.equal(initLock({ dir, passphrase: DUMMY, iterations: 1000 }).inboxWritten, true);
  fs.writeFileSync(path.join(dir, 'inbox.json'), JSON.stringify({ v: 1, x25519: Buffer.alloc(32, 1).toString('base64') }));
  const r = initLock({ dir, passphrase: DUMMY, iterations: 1000 });
  assert.equal(r.inboxMatches, false);
  assert.equal(r.inboxWritten, false);
});

test('missing lock, missing passphrase and verify-only all refuse', () => {
  const dir = path.join(tmp(), 'lock');
  assert.throws(() => readLock(dir), /missing lock/);
  assert.throws(() => openLock({ dir, env: { LOCK_PASSPHRASE: DUMMY } }), /missing lock/);
  assert.throws(() => initLock({ dir, passphrase: DUMMY, verifyOnly: true }), /missing lock/);
  assert.equal(fs.existsSync(path.join(dir, 'lock.json')), false, 'verify-only never creates a lock');
  assert.throws(() => initLock({ dir, passphrase: '' }), /missing passphrase/);
  initLock({ dir, passphrase: DUMMY, iterations: 1000 });
  assert.throws(() => openLock({ dir, env: {} }), /missing passphrase/);
  assert.throws(() => openLock({ dir, env: { LOCK_PASSPHRASE: 'wrong' } }), /wrong passphrase/);
  assert.equal(openLock({ dir, env: { LOCK_PASSPHRASE: DUMMY } }).keys.aes.length, 32);
  fs.writeFileSync(path.join(dir, 'lock.json'), '{"lock":1}');
  assert.throws(() => readLock(dir), /bad lock/);
});
