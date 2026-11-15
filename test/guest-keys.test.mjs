// Guest access and the vault, the keys (lib/keyring.mjs, lib/guests.mjs, lib/store.mjs; docs/briefs/guest-access.md): slots
// open only with their own key and kind; the private split round-trips; the store seals market files under the market key
// and owner files under the private key once keys.json exists; the keys step migrates (keeping every cumulative row), adds,
// removes, expires and rotates; a stray slot rotates; a recovery key opens both data keys; a passphrase change keeps the
// old and the new passphrase valid until the loop runs on the new one, then drops the old; a passphrase that opens no slot
// stops everything. Throwaway lock (dummy passphrase, 1,000 rounds), made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLock, readLock, unlock, open, deriveKeys, openLock } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal } from '../lib/inbox.mjs';
import { writeSealed, openStore } from '../lib/store.mjs';
import { KEYS_FILE, wrapSlot, unwrapSlot, isKeysFile, reopen, openVault, masterFrom, openMaster, openGuestSlot, guestKek, buildKeysFile, migrateKeys, readKeysFile, splitPrivate, mergePrivate, privateIn } from '../lib/keyring.mjs';
import { guestStep, parseRequest, guestLine } from '../lib/guests.mjs';

const DUMMY = 'guest keys test dummy passphrase, not a secret';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-guest-'));
const H = 3600e3, NOW = Date.parse('2026-11-15T10:00:00Z');
const hex = (n) => crypto.randomBytes(n).toString('hex');

function lockKeys(pass = DUMMY) {
  const dir = tmp();
  initLock({ dir, passphrase: pass, iterations: 1000 });
  return { dir, lock: readLock(dir), keys: unlock(readLock(dir), pass) };
}
const LK = lockKeys();
const KEYS = LK.keys, AES = KEYS.aes, PUB = inboxKeys(KEYS.token).publicB64;
const K = () => ({ ...KEYS }); // each step gets its own copy: a migration turns the one it gets into the vault

const madeLive = (t = NOW - H) => ({ v: 1, t, phase: 0, build: 'made-up', next: null, ticket: 4321, stopLoss: 0.08, gemAt: 61, windows: ['24h', '7d', '30d'], defaultWindow: '24h',
  health: { loop: null, checks: [] }, bench: 'p1',
  pools: [{ id: 'p1', chain: 'ethereum', pair: 'MADE/UP', w: { '24h': null }, checks: [{ id: 'fee-identity', label: 'fee identity', ok: true }, { id: 'token-age-rank', label: 'tokens ranked and trading 123+ days', ok: true }] },
    { id: 'p2', chain: 'ethereum', pair: 'FAKE/UP', w: { '24h': null }, checks: [] }] });
const madeHist = (t = NOW - H) => ({ v: 1, t, health: [[t - H, 1, 1, 0]], pools: { p1: { h: [[t - 2 * H, 1.5, 2e18, null, 0.2], [t - H, 1.6, 2e18, 12.5, 0.21]], d: [], y: [[t - 48 * H, 33, 'e']] } } });
const madeBt = (t = NOW - H) => ({ v: 1, t, ticket: 4321, provisional: true, pools: { p1: { '24h': null } } });
function legacyDir() {
  const dir = tmp();
  writeSealed('live.json', madeLive(), AES, { outDir: dir });
  writeSealed('history.json', madeHist(), AES, { outDir: dir });
  writeSealed('backtest.json', madeBt(), AES, { outDir: dir });
  writeSealed('snapshots.json', { v: 1, t: NOW - H, fix: 2, pools: {} }, AES, { outDir: dir });
  writeSealed('log.json', { v: 1, t: NOW - H, lines: ['made-up line'], errors: 0, categories: {} }, AES, { outDir: dir });
  return dir;
}
const opens = (dir, name, key) => { try { open(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), key); return true; } catch { return false; } };
const readWith = (dir, name, key) => JSON.parse(open(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), key));
const req = (x) => inboxSeal(JSON.stringify(x), PUB);
const vaultOf = (dir) => reopen(K(), readKeysFile(dir));
// what the owner's page does: open the master slot for the market key, derive the guest key with the guest salt, wrap
function guestItem(dir, { name = 'Made-up Friend', pass = `made up guest ${hex(4)}`, exp = null, slot = hex(8), role = 'guest' } = {}) {
  const kf = readKeysFile(dir), v = vaultOf(dir), kek = guestKek(pass, kf.gsalt, kf.iter);
  const wrap = wrapSlot({ k: v.mdek.toString('base64'), s: slot, n: name, e: exp, g: v.gen }, kek, 'guest');
  return { pass, kek, slot, item: { slot, kek: kek.toString('base64'), name, exp, role, wrap } };
}
function addRequest(dir, o = {}) { // one friend in one request
  const g = guestItem(dir, o);
  return { ...g, env: req({ lps: 'guest-add', id: hex(16), at: o.at ?? NOW, guests: [g.item] }) };
}
const step = (dir, o = {}) => guestStep({ keys: K(), outDir: dir, now: NOW, ...o });

test('slots open only with their own key and kind; the keys file is strict and shows nothing but wrapped keys', () => {
  const k1 = crypto.randomBytes(32), k2 = crypto.randomBytes(32);
  const s = wrapSlot({ k: 'x', n: 'Made-up Friend' }, k1, 'guest');
  assert.deepEqual(unwrapSlot(s, k1, 'guest'), { k: 'x', n: 'Made-up Friend' });
  assert.throws(() => unwrapSlot(s, k2, 'guest'));
  assert.throws(() => unwrapSlot(s, k1, 'owner'), 'a guest slot never passes as an owner slot');
  const { v, keysFile } = migrateKeys({ pass: AES, token: KEYS.token, iter: 1000, t: NOW });
  const kek = crypto.randomBytes(32);
  const kf = buildKeysFile({ v, owner: keysFile.owner, gsalt: keysFile.gsalt, iter: 1000, guests: [{ s: 'aaaaaaaaaaaaaaaa', n: 'Made-up Friend', e: NOW + 7 * 24 * H, kek }], t: NOW });
  assert.ok(isKeysFile(kf));
  const o = reopen(K(), kf);
  assert.ok(o.mdek.equals(v.mdek) && o.aes.equals(v.aes) && o.token.equals(KEYS.token) && o.pprev[0].equals(AES));
  const g = openGuestSlot(kf, kek);
  assert.ok(g.dek.equals(v.mdek)); assert.equal(g.name, 'Made-up Friend'); assert.equal(g.slot, 'aaaaaaaaaaaaaaaa');
  assert.equal(openGuestSlot(kf, k2), null);
  assert.equal(masterFrom(kf, kek, 'owner'), null, 'a guest key opens no owner slot');
  assert.throws(() => openMaster(kf, kek), /does not open/);
  const text = JSON.stringify(kf);
  assert.ok(!/Made-up|aaaaaaaa|"n"|"e"|"s"/.test(text), 'names, slot ids and expiry stay inside the slots');
  assert.ok(!isKeysFile({ ...kf, guests: 1 }), 'an extra field is refused');
  assert.ok(!isKeysFile({ ...kf, slots: [{ ...kf.owner[0], n: 'x' }] }));
  assert.ok(!isKeysFile({ ...kf, owner: [] }), 'never without an owner slot');
});

test('the private split round-trips, and a market object keeps no owner-only field', () => {
  const live = madeLive();
  const { market, owner } = splitPrivate('live.json', live);
  assert.deepEqual(privateIn('live.json', market), []);
  assert.deepEqual(privateIn('live.json', live), ['ticket', 'stopLoss', 'gemAt', 'ageDays'], 'planted: the unsplit object is caught');
  assert.equal(market.pools[0].checks[1].label, 'tokens ranked and trading long enough');
  assert.ok(!JSON.stringify(market).includes('4321') && !JSON.stringify(market).includes('123+'));
  assert.deepEqual(owner, { v: 1, t: live.t, ticket: 4321, stopLoss: 0.08, gemAt: 61, ageDays: 123 });
  assert.deepEqual(mergePrivate('live.json', market, owner), live);
  const bt = madeBt(), sb = splitPrivate('backtest.json', bt);
  assert.ok(!('ticket' in sb.market));
  assert.deepEqual(mergePrivate('backtest.json', sb.market, owner), bt);
});

test('migration: market files under the market key, owner files under the private key, every cumulative row kept', () => {
  const dir = legacyDir();
  const before = openStore({ keys: K(), outDir: dir });
  const L0 = before.get('live.json'), H0 = before.get('history.json'), B0 = before.get('backtest.json'), S0 = before.get('snapshots.json');
  assert.equal(step(dir, { allowMigrate: false }).skipped, 'no keys file', 'no migration unless allowed');
  assert.ok(!fs.existsSync(path.join(dir, KEYS_FILE)));
  const keys = K();
  const r = guestStep({ keys, outDir: dir, now: NOW, allowMigrate: true });
  assert.ok(r.migrated && r.wrote && !r.rotated);
  assert.ok(keys.mdek && keys.mk && !keys.aes.equals(AES), 'the process now holds the vault (its log goes under the private key)');
  const kf = readKeysFile(dir), v = vaultOf(dir);
  assert.equal(kf.slots.length, 0); assert.equal(kf.owner.length, 1); assert.equal(kf.recovery, null);
  for (const n of ['live.json', 'history.json', 'backtest.json']) {
    assert.ok(opens(dir, n, v.mdek), `${n} opens with the market key`);
    assert.ok(!opens(dir, n, AES) && !opens(dir, n, v.aes), `${n} opens with nothing else`);
  }
  for (const n of ['snapshots.json', 'log.json', 'owner.json', 'guests.json']) {
    assert.ok(opens(dir, n, v.aes), `${n} opens with the private key`);
    assert.ok(!opens(dir, n, v.mdek) && !opens(dir, n, AES), `${n} never opens with the market key or the passphrase's own key`);
  }
  assert.deepEqual(privateIn('live.json', readWith(dir, 'live.json', v.mdek)), []);
  assert.ok(!('ticket' in readWith(dir, 'backtest.json', v.mdek)));
  const after = openStore({ keys: K(), outDir: dir });
  assert.deepEqual(after.get('live.json'), L0, 'the owner sees the same live.json');
  assert.deepEqual(after.get('history.json'), H0, 'every history row kept');
  assert.deepEqual(after.get('backtest.json'), B0);
  assert.deepEqual(after.get('snapshots.json'), S0);
  assert.deepEqual(readWith(dir, 'owner.json', v.aes), { v: 1, t: L0.t, ticket: 4321, stopLoss: 0.08, gemAt: 61, ageDays: 123 });
  after.put('live.json', { ...L0, t: NOW });
  assert.equal(after.get('live.json').ticket, 4321);
  assert.deepEqual(privateIn('live.json', readWith(dir, 'live.json', v.mdek)), []);
  assert.ok(after.hasDek());
  // the lock opens the vault from keys.json (the loop's and the scan's openLock), and its token is the lock's (the inbox key is unchanged)
  const ol = openLock({ dir: LK.dir, env: { LOCK_PASSPHRASE: DUMMY }, keysDir: dir });
  assert.ok(ol.keys.aes.equals(v.aes) && ol.keys.token.equals(KEYS.token));
  // a second run never migrates again, and a process holding the vault never makes keys twice
  const again = step(dir, { allowMigrate: true });
  assert.ok(!again.migrated && !again.wrote);
  const empty = tmp();
  assert.throws(() => guestStep({ keys: ol.keys, outDir: empty, now: NOW, allowMigrate: true }), /never made twice/);
});

test('before the migration the store writes exactly as before (an older loop and the page keep working)', () => {
  const dir = legacyDir();
  const s = openStore({ keys: K(), outDir: dir });
  s.put('live.json', madeLive(NOW));
  assert.equal(readWith(dir, 'live.json', AES).ticket, 4321);
  assert.ok(!fs.existsSync(path.join(dir, 'owner.json')));
  assert.ok(!s.hasDek());
});

test('add a guest: their slot opens the market files and nothing of the owner\'s; a replayed or forged request changes nothing', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const a = addRequest(dir, { exp: NOW + 30 * 24 * H });
  const r = step(dir, { requests: [a.env] });
  assert.equal(r.added, 1); assert.equal(r.active, 1); assert.ok(r.wrote && !r.rotated);
  const kf = readKeysFile(dir), v = vaultOf(dir);
  assert.equal(kf.slots.length, 1);
  const g = openGuestSlot(kf, guestKek(a.pass, kf.gsalt, kf.iter));
  assert.ok(g && g.name === 'Made-up Friend' && g.exp === NOW + 30 * 24 * H);
  for (const n of ['live.json', 'history.json', 'backtest.json']) assert.ok(opens(dir, n, g.dek), `the guest opens ${n}`);
  for (const n of ['owner.json', 'guests.json', 'snapshots.json', 'log.json']) assert.ok(!opens(dir, n, g.dek) && !opens(dir, n, a.kek), `the guest never opens ${n}`);
  assert.equal(masterFrom(kf, a.kek, 'owner'), null);
  assert.ok(!openGuestSlot(kf, guestKek('a made-up wrong guess', kf.gsalt, kf.iter)));
  assert.ok(opens(dir, 'guests.json', v.aes));
  const r2 = step(dir, { requests: [a.env] });
  assert.equal(r2.added, 0); assert.ok(!r2.wrote);
  const bad = addRequest(dir);
  const forged = { lps: 'guest-add', id: hex(16), at: NOW, guests: [{ slot: hex(8), kek: bad.kek.toString('base64'), name: 'Made-up Forger', exp: null, role: 'guest',
    wrap: wrapSlot({ k: crypto.randomBytes(32).toString('base64') }, bad.kek, 'guest') }] };
  const r3 = step(dir, { requests: [a.env, req(forged), { inbox: 1, epk: 'x', iv: 'y', ct: 'z' }, null] });
  assert.equal(r3.refused, 1); assert.equal(r3.bad, 2); assert.equal(readKeysFile(dir).slots.length, 1);
  const line = guestLine(r3, { read: true, files: 4 });
  assert.match(line, /^guests: 1 active, 0 added, 0 removed, 0 expired, 1 refused, 2 unreadable; inbox 4 files; data key kept; passphrases 1; recovery key no; keys written: yes$/);
  assert.ok(!/Made-up|Forger/.test(line));
});

test('remove a guest: the market key rotates, the removed guest opens nothing new, the others keep access, the owner keeps every row', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const a = addRequest(dir, { name: 'Made-up One', at: NOW - 3 * H }), b = addRequest(dir, { name: 'Made-up Two', at: NOW - 2 * H });
  step(dir, { requests: [a.env, b.env] });
  const v0 = vaultOf(dir), H0 = openStore({ keys: K(), outDir: dir }).get('history.json');
  const rm = req({ lps: 'guest-remove', id: hex(16), at: NOW - H, slot: a.slot });
  const r = step(dir, { requests: [a.env, b.env, rm] });
  assert.ok(r.rotated); assert.equal(r.removed, 1); assert.equal(r.active, 1);
  const k1 = readKeysFile(dir), v1 = vaultOf(dir);
  assert.ok(!v1.mdek.equals(v0.mdek) && v1.prev[0].equals(v0.mdek), 'a new market key; the master slot keeps the old');
  assert.ok(v1.aes.equals(v0.aes) && v1.mk.equals(v0.mk), 'the private and master keys stay');
  assert.equal(v1.gen, 1);
  assert.equal(openGuestSlot(k1, a.kek), null, 'the removed guest has no slot');
  for (const n of ['live.json', 'history.json', 'backtest.json']) {
    assert.ok(!opens(dir, n, v0.mdek), `${n} no longer opens with the old key`);
    assert.ok(opens(dir, n, openGuestSlot(k1, b.kek).dek), `the remaining guest opens ${n}`);
  }
  assert.deepEqual(openStore({ keys: K(), outDir: dir }).get('history.json'), H0);
  const one = readWith(dir, 'guests.json', v1.aes).guests.find((x) => x.s === a.slot);
  assert.equal(one.st, 'removed'); assert.ok(!('kek' in one), 'a removed guest\'s key is forgotten');
  const r2 = step(dir, { requests: [a.env, b.env, rm] });
  assert.ok(!r2.rotated && !r2.wrote);
});

test('expiry removes a guest by itself and rotates; a reset removes everyone', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const a = addRequest(dir, { exp: NOW + H, at: NOW - H }), b = addRequest(dir, { at: NOW - H });
  step(dir, { requests: [a.env, b.env] });
  assert.equal(step(dir, { requests: [a.env, b.env], now: NOW + 30 * 60e3 }).wrote, false, 'not yet');
  const r = step(dir, { requests: [a.env, b.env], now: NOW + 2 * H });
  assert.equal(r.expired, 1); assert.ok(r.rotated); assert.equal(readKeysFile(dir).slots.length, 1);
  assert.equal(readWith(dir, 'guests.json', vaultOf(dir).aes).guests.find((x) => x.s === a.slot).st, 'expired');
  const r2 = step(dir, { requests: [req({ lps: 'guest-reset', id: hex(16), at: NOW + 2 * H })], now: NOW + 3 * H });
  assert.equal(r2.removed, 2, 'everyone, the expired friend too, for good'); assert.ok(r2.rotated); assert.equal(readKeysFile(dir).slots.length, 0);
  assert.equal(openGuestSlot(readKeysFile(dir), b.kek), null);
});

test('a stray guest slot rotates the key away; a lost guest list with slots changes nothing', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const a = addRequest(dir);
  step(dir, { requests: [a.env] });
  const kf = readKeysFile(dir), v = vaultOf(dir), strayKek = crypto.randomBytes(32);
  const planted = { ...kf, slots: [...kf.slots, wrapSlot({ k: v.mdek.toString('base64'), s: hex(8), n: 'Made-up Ghost', e: null, g: v.gen }, strayKek, 'guest')] };
  fs.writeFileSync(path.join(dir, KEYS_FILE), JSON.stringify(planted));
  const r = step(dir, { requests: [a.env] });
  assert.equal(r.stray, 1); assert.ok(r.rotated);
  assert.equal(openGuestSlot(readKeysFile(dir), strayKek), null);
  assert.ok(openGuestSlot(readKeysFile(dir), a.kek));
  fs.rmSync(path.join(dir, 'guests.json'));
  const before = fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8');
  const r2 = step(dir, { requests: [req({ lps: 'guest-reset', id: hex(16), at: NOW })] });
  assert.equal(r2.skipped, 'guests file unread');
  assert.equal(fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8'), before);
});

test('the recovery key opens both data keys and the inbox seed; a wrong one opens nothing', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const v = vaultOf(dir), rsalt = crypto.randomBytes(16).toString('base64'), rkey = 'K7QMX3RAMADEUPFAKERECOVERYKEY234';
  const rk = deriveKeys(rkey, rsalt, 1000).aes;
  // the owner's page: the master key (from its owner slot) wrapped under the recovery key
  const slot = wrapSlot({ m: v.mk.toString('base64') }, rk, 'recovery');
  const r = step(dir, { requests: [req({ lps: 'recovery-set', id: hex(16), at: NOW, rsalt, slot })] });
  assert.equal(r.recoverySet, 1); assert.ok(r.recovery && !r.rotated);
  const kf = readKeysFile(dir);
  assert.equal(kf.rsalt, rsalt);
  const m = masterFrom(kf, deriveKeys(rkey, kf.rsalt, 1000).aes, 'recovery');
  const got = openMaster(kf, m.mk);
  assert.ok(got.mdek.equals(v.mdek) && got.aes.equals(v.aes) && got.token.equals(KEYS.token), 'both data keys and the inbox seed');
  for (const n of ['live.json', 'snapshots.json', 'guests.json']) assert.ok(opens(dir, n, n === 'live.json' ? got.mdek : got.aes));
  assert.equal(masterFrom(kf, deriveKeys('A MADE-UP WRONG RECOVERY KEY', kf.rsalt, 1000).aes, 'recovery'), null);
  assert.equal(masterFrom(kf, rk, 'owner'), null, 'a recovery slot never passes as an owner slot');
  // a later recovery key replaces it: the old one opens nothing
  const rk2 = deriveKeys('ANOTHER-MADE-UP-RECOVERY', rsalt, 1000).aes;
  step(dir, { requests: [req({ lps: 'recovery-set', id: hex(16), at: NOW + 1, rsalt, slot: wrapSlot({ m: v.mk.toString('base64') }, rk2, 'recovery') })] });
  assert.equal(masterFrom(readKeysFile(dir), rk, 'recovery'), null);
  assert.ok(masterFrom(readKeysFile(dir), rk2, 'recovery'));
});

test('a passphrase change: old and new both open until the loop runs on the new one, then the old slot is dropped', () => {
  const L = lockKeys('the made-up OLD passphrase'), NEW = 'the made-up NEW passphrase';
  const keysOld = () => ({ ...L.keys });
  const dir = legacyDir();
  // this folder's files were sealed under the shared test lock: reseal them under this test's own lock first
  for (const n of fs.readdirSync(dir)) writeSealed(n, readWith(dir, n, AES), L.keys.aes, { outDir: dir });
  guestStep({ keys: keysOld(), outDir: dir, now: NOW, allowMigrate: true });
  const v = reopen(keysOld(), readKeysFile(dir));
  const nk = deriveKeys(NEW, L.lock.salt, L.lock.iter).aes;
  const reqNew = inboxSeal(JSON.stringify({ lps: 'owner-add', id: hex(16), at: NOW, slot: wrapSlot({ m: v.mk.toString('base64') }, nk, 'owner') }), inboxKeys(v.token).publicB64);
  // the loop, still on the old passphrase, adds the slot: both open
  const r1 = guestStep({ keys: keysOld(), outDir: dir, now: NOW, requests: [reqNew] });
  assert.equal(r1.ownerAdded, 1); assert.equal(r1.owners, 2); assert.equal(r1.ownerDropped, 0);
  const env = (p) => ({ LOCK_PASSPHRASE: p });
  assert.ok(openLock({ dir: L.dir, env: env('the made-up OLD passphrase'), keysDir: dir }).keys.aes.equals(v.aes));
  assert.ok(openLock({ dir: L.dir, env: env(NEW), keysDir: dir }).keys.aes.equals(v.aes));
  assert.deepEqual(readWith(dir, 'guests.json', v.aes).vault.change.ct, readKeysFile(dir).owner[1].ct, 'the page reads "new passphrase ready"');
  // another pass on the old secret: nothing dropped
  assert.equal(guestStep({ keys: keysOld(), outDir: dir, now: NOW + H, requests: [reqNew] }).ownerDropped, 0);
  // the owner updated the secret: the loop runs on the new passphrase and drops the old slot
  const kNew = openLock({ dir: L.dir, env: env(NEW), keysDir: dir }).keys;
  const r2 = guestStep({ keys: kNew, outDir: dir, now: NOW + 2 * H, requests: [reqNew] });
  assert.equal(r2.ownerDropped, 1); assert.equal(r2.owners, 1);
  assert.throws(() => openLock({ dir: L.dir, env: env('the made-up OLD passphrase'), keysDir: dir }), /^Error: wrong passphrase: it opens no owner slot/);
  assert.ok(openLock({ dir: L.dir, env: env(NEW), keysDir: dir }).keys.aes.equals(v.aes));
  const vault = readWith(dir, 'guests.json', v.aes).vault;
  assert.equal(vault.change, null); assert.equal(vault.changedAt, NOW + 2 * H, 'the page says "done"');
  // nothing was sealed again: the private and market keys are the same
  const v2 = reopen(kNew, readKeysFile(dir));
  assert.ok(v2.mdek.equals(v.mdek) && v2.aes.equals(v.aes));
  // planted: an owner slot that wraps another master key gives nothing
  const fake = wrapSlot({ m: crypto.randomBytes(32).toString('base64') }, deriveKeys('a made-up intruder', L.lock.salt, L.lock.iter).aes, 'owner');
  guestStep({ keys: kNew, outDir: dir, now: NOW + 3 * H, requests: [inboxSeal(JSON.stringify({ lps: 'owner-add', id: hex(16), at: NOW + 3 * H, slot: fake }), inboxKeys(v.token).publicB64)] });
  assert.throws(() => openLock({ dir: L.dir, env: env('a made-up intruder'), keysDir: dir }), /does not open with this lock/);
});

test('a passphrase that opens no slot, or a keys.json from another lock, stops everything and seals nothing', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const snap = () => fs.readdirSync(dir).sort().map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('|');
  const before = snap();
  assert.throws(() => openLock({ dir: LK.dir, env: { LOCK_PASSPHRASE: 'a made-up wrong passphrase' }, keysDir: dir }), /^Error: wrong passphrase/);
  assert.throws(() => openVault(LK.lock, 'a made-up wrong passphrase', readKeysFile(dir)), /^Error: wrong passphrase/);
  const other = lockKeys('another made-up passphrase, not a secret');
  fs.writeFileSync(path.join(dir, KEYS_FILE), JSON.stringify(migrateKeys({ pass: other.keys.aes, token: other.keys.token, iter: 1000, t: NOW }).keysFile));
  const foreign = snap();
  assert.throws(() => step(dir, { allowMigrate: true }), /wrong passphrase/);
  assert.throws(() => openStore({ keys: K(), outDir: dir }).get('live.json'), /wrong passphrase/);
  assert.equal(snap(), foreign);
  assert.notEqual(before, foreign);
  assert.throws(() => unlock(readLock(LK.dir), 'a made-up wrong passphrase'), /wrong passphrase/);
});

test('requests are checked field by field; a name is cleaned and capped', () => {
  const priv = inboxKeys(KEYS.token).privateKey, kek = crypto.randomBytes(32), wrap = wrapSlot({ k: 'x' }, kek, 'guest');
  const item = { slot: hex(8), kek: kek.toString('base64'), name: ' Made-up\u0007  Friend ', exp: NOW + H, role: 'guest', wrap };
  const base = { lps: 'guest-add', id: hex(16), at: NOW, guests: [item], slot: item.slot };
  assert.equal(parseRequest(req(base), priv).guests[0].name, 'Made-up Friend');
  for (const bad of [{ slot: 'XYZ' }, { kek: 'short' }, { exp: NOW - H }, { name: '' }, { name: 'x'.repeat(41) }, { wrap: { iv: 1 } }, { role: 'owner' }]) {
    assert.equal(parseRequest(req({ ...base, guests: [{ ...item, ...bad }] }), priv), null, JSON.stringify(Object.keys(bad)));
  }
  for (const bad of [{ id: 'x' }, { lps: 'guest-promote' }, { guests: [] }]) assert.equal(parseRequest(req({ ...base, ...bad }), priv), null, JSON.stringify(Object.keys(bad)));
  assert.equal(parseRequest(req({ lps: 'guest-update', id: base.id, at: NOW, slot: item.slot, role: 'owner' }), priv), null, 'never the owner role');
  assert.equal(parseRequest(req(base), crypto.generateKeyPairSync('x25519').privateKey), null, 'sealed to another inbox');
  assert.deepEqual(parseRequest(req({ lps: 'guest-remove', id: base.id, at: NOW, slot: base.slot }), priv), { lps: 'guest-remove', id: base.id, at: NOW, slot: base.slot });
  assert.equal(parseRequest(req({ lps: 'recovery-set', id: base.id, at: NOW, slot: wrap, rsalt: 'short' }), priv), null);
  assert.equal(parseRequest(req({ lps: 'owner-add', id: base.id, at: NOW, slot: { iv: 'x' } }), priv), null);
});

test('a list of friends in one request; roles; the hard cap keeps the friend and their key; an upgrade or an extension brings the same passphrase back', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const names = ['Ada Mock', 'Bo Mock', 'Cy Mock'];
  const items = names.map((name, i) => guestItem(dir, { name, exp: NOW + (i === 0 ? H : 45 * 24 * H), role: i === 2 ? 'member' : 'guest' }));
  const env = req({ lps: 'guest-add', id: hex(16), at: NOW - H, guests: items.map((x) => x.item) });
  const r = step(dir, { requests: [env] });
  assert.equal(r.added, 3); assert.equal(readKeysFile(dir).slots.length, 3);
  const kf = readKeysFile(dir);
  assert.deepEqual(items.map((x) => openGuestSlot(kf, x.kek)).map((g) => [g.name, g.role]), [['Ada Mock', 'guest'], ['Bo Mock', 'guest'], ['Cy Mock', 'member']]);
  // Ada's hard cap passes: her slot goes and the key rotates, but she stays on the list, expired, with her key kept
  const v0 = vaultOf(dir);
  const r2 = step(dir, { requests: [env], now: NOW + 2 * H });
  assert.equal(r2.expired, 1); assert.ok(r2.rotated);
  assert.equal(openGuestSlot(readKeysFile(dir), items[0].kek), null);
  assert.ok(!opens(dir, 'live.json', v0.mdek));
  let list = readWith(dir, 'guests.json', vaultOf(dir).aes).guests;
  const ada = list.find((x) => x.n === 'Ada Mock');
  assert.equal(ada.st, 'expired'); assert.ok(ada.kek, 'her key stays (owner-only file)');
  // the owner upgrades her to a member: the same passphrase opens again, with the new role and no cap
  const up = req({ lps: 'guest-update', id: hex(16), at: NOW + 3 * H, slot: items[0].slot, role: 'member', exp: null });
  const r3 = step(dir, { requests: [env, up], now: NOW + 3 * H });
  assert.equal(r3.updated, 1); assert.ok(!r3.rotated);
  const back = openGuestSlot(readKeysFile(dir), guestKek(items[0].pass, kf.gsalt, kf.iter));
  assert.ok(back && back.role === 'member' && back.exp === null && opens(dir, 'live.json', back.dek));
  // an extension: a later cap, and the device's 30-day clock restarts from it
  const ext = req({ lps: 'guest-update', id: hex(16), at: NOW + 4 * H, slot: items[1].slot, exp: NOW + 90 * 24 * H, ext: true });
  step(dir, { requests: [env, up, ext], now: NOW + 4 * H });
  const bo = openGuestSlot(readKeysFile(dir), items[1].kek);
  assert.equal(bo.exp, NOW + 90 * 24 * H); assert.equal(bo.ext, NOW + 4 * H); assert.equal(bo.role, 'guest');
  // removed for good: the key is forgotten, an update can't bring it back
  const rm = req({ lps: 'guest-remove', id: hex(16), at: NOW + 5 * H, slot: items[1].slot });
  const r4 = step(dir, { requests: [env, up, ext, rm], now: NOW + 5 * H });
  assert.equal(r4.removed, 1); assert.ok(r4.rotated);
  const again = req({ lps: 'guest-update', id: hex(16), at: NOW + 6 * H, slot: items[1].slot, role: 'member' });
  assert.equal(step(dir, { requests: [again], now: NOW + 6 * H }).refused, 1);
  list = readWith(dir, 'guests.json', vaultOf(dir).aes).guests;
  assert.deepEqual(list.map((x) => [x.n, x.st, !!x.kek]), [['Ada Mock', 'active', true], ['Bo Mock', 'removed', false], ['Cy Mock', 'active', true]]);
});

test('the loop makes the passphrases for a sealed list of names: kept for the owner only, never in a public file or line', async () => {
  const { sealInput } = await import('../scripts/seal-input.mjs');
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  // anyone can seal it (scripts/seal-input.mjs, the inbox public key only); no id, no time, no passphrase in it
  const pubDir = tmp();
  fs.writeFileSync(path.join(pubDir, 'inbox.json'), JSON.stringify({ v: 1, x25519: PUB }));
  const out = path.join(tmp(), 'inbox', 'made-up.json'), said = [];
  sealInput({ text: JSON.stringify({ action: 'add-guests', names: ['Ada Mock', 'Bo Mock', 'Cy Mock'], role: 'guest', softDays: 30, hardDays: 45 }), out, pubDir, say: (l) => said.push(l) });
  const env = JSON.parse(fs.readFileSync(out, 'utf8'));
  const r = step(dir, { requests: [env] });
  assert.equal(r.added, 3);
  const line = guestLine(r, { read: true, files: 1 });
  assert.match(line, /^guests: 3 active, 3 added, /);
  const list = readWith(dir, 'guests.json', vaultOf(dir).aes).guests, kf = readKeysFile(dir);
  assert.equal(list.length, 3);
  for (const g of list) {
    assert.match(g.pw, /^([a-z]{3,6}-){5}\d\d$/, 'five words and two digits');
    const o = openGuestSlot(kf, guestKek(g.pw, kf.gsalt, kf.iter));
    assert.ok(o && o.name === g.n && o.role === 'guest' && o.soft === 30 && Math.abs(o.exp - (NOW + 45 * 86400e3)) < 1000, 'its passphrase opens its own slot');
  }
  const pub = [fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8'), line, ...said, JSON.stringify(env)].join('\n');
  for (const g of list) assert.ok(!pub.includes(g.pw) && !pub.includes(g.pw.split('-')[0] + '-' + g.pw.split('-')[1]), 'never in keys.json, the public line or the sealed request');
  assert.ok(!pub.includes('Ada Mock'));
  // the same sealed file again is the same request: nothing is made twice
  assert.equal(step(dir, { requests: [env] }).added, 0);
  assert.equal(readKeysFile(dir).slots.length, 3);
});

test('one shared guest password: made by the loop or typed by the owner; ends by its date (the key rotates); a change replaces it; end now', async () => {
  const { sealInput } = await import('../scripts/seal-input.mjs');
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const pubDir = tmp();
  fs.writeFileSync(path.join(pubDir, 'inbox.json'), JSON.stringify({ v: 1, x25519: PUB }));
  const out = path.join(tmp(), 'made-up-shared.json');
  sealInput({ text: JSON.stringify({ action: 'add-shared-guest', label: 'friends', days: 30 }), out, pubDir, say: () => {} });
  const env = JSON.parse(fs.readFileSync(out, 'utf8'));
  // (a) the loop makes the password; the owner's file keeps it; the slot carries the label, never a person's name
  const r = step(dir, { requests: [env], now: NOW });
  assert.equal(r.added, 1);
  let kf = readKeysFile(dir), list = readWith(dir, 'guests.json', vaultOf(dir).aes).guests;
  const sh = list[0];
  assert.ok(sh.sh && sh.n === 'friends' && /^([a-z]{3,6}-){5}\d\d$/.test(sh.pw) && sh.e === NOW + 30 * 86400e3);
  const o = openGuestSlot(kf, guestKek(sh.pw, kf.gsalt, kf.iter));
  assert.ok(o && o.shared && o.name === 'friends' && o.role === 'guest' && o.soft === 0 && o.exp === NOW + 30 * 86400e3);
  assert.ok(!fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8').includes(sh.pw));
  // (b) the owner types a new one (a change): the old one stops and the market key rotates; everyone uses the new one
  const v0 = vaultOf(dir), typed = 'a made-up shared password for the test 77', kek = guestKek(typed, kf.gsalt, kf.iter), slot = hex(8);
  const change = req({ lps: 'shared-set', id: hex(16), at: NOW + H, label: 'friends', days: 30, slot, kek: kek.toString('base64'),
    wrap: wrapSlot({ k: v0.mdek.toString('base64'), s: slot, n: 'friends', e: NOW + H + 30 * 86400e3, r: 'guest', sh: 1, g: v0.gen }, kek, 'guest') });
  const r2 = step(dir, { requests: [env, change], now: NOW + H });
  assert.ok(r2.rotated); assert.equal(r2.added, 1); assert.equal(r2.removed, 1);
  kf = readKeysFile(dir);
  assert.equal(kf.slots.length, 1);
  assert.equal(openGuestSlot(kf, guestKek(sh.pw, kf.gsalt, kf.iter)), null, 'the old shared password opens nothing');
  const n = openGuestSlot(kf, kek);
  assert.ok(n && n.shared && opens(dir, 'live.json', n.dek) && !opens(dir, 'live.json', v0.mdek));
  // its date passes: dropped, rotated, the record kept as expired
  const r3 = step(dir, { requests: [env, change], now: NOW + H + 30 * 86400e3 });
  assert.equal(r3.expired, 1); assert.ok(r3.rotated); assert.equal(readKeysFile(dir).slots.length, 0);
  list = readWith(dir, 'guests.json', vaultOf(dir).aes).guests;
  assert.deepEqual(list.map((x) => [x.n, x.st]), [['friends', 'removed'], ['friends', 'expired']]);
  // a new one again, then "end shared access now"
  const again = req({ lps: 'shared-set', id: hex(16), at: NOW + 31 * 86400e3, label: 'friends', days: 30 });
  step(dir, { requests: [env, change, again], now: NOW + 31 * 86400e3 });
  const cur = readWith(dir, 'guests.json', vaultOf(dir).aes).guests.find((x) => x.st === 'active');
  const r4 = step(dir, { requests: [env, change, again, req({ lps: 'guest-remove', id: hex(16), at: NOW + 32 * 86400e3, slot: cur.s })], now: NOW + 32 * 86400e3 });
  assert.equal(r4.removed, 1); assert.ok(r4.rotated); assert.equal(readKeysFile(dir).slots.length, 0);
});
