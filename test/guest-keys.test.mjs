// Guest access, the keys (lib/keyring.mjs, lib/guests.mjs, lib/store.mjs; docs/briefs/guest-access.md): slots wrap and
// unwrap only with their own key and kind; the private split round-trips; the store seals market files under the data
// key once keys.json exists and owner-only fields go to owner.json; the keys step migrates (keeping every cumulative
// row), adds, removes, expires and rotates; a stray slot rotates; a keys.json from another lock stops everything.
// Throwaway lock (dummy passphrase, 1,000 rounds), made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLock, readLock, unlock, open } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal } from '../lib/inbox.mjs';
import { writeSealed, openStore, readSealed } from '../lib/store.mjs';
import { KEYS_FILE, wrapSlot, unwrapSlot, isKeysFile, ownerRing, openGuestSlot, guestKek, buildKeysFile, readKeysFile, splitPrivate, mergePrivate, privateIn } from '../lib/keyring.mjs';
import { guestStep, parseRequest, guestLine } from '../lib/guests.mjs';

const DUMMY = 'guest keys test dummy passphrase, not a secret';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-guest-'));
const H = 3600e3, NOW = Date.parse('2026-11-15T10:00:00Z');
const hex = (n) => crypto.randomBytes(n).toString('hex');

function lockKeys(pass = DUMMY) {
  const dir = tmp();
  initLock({ dir, passphrase: pass, iterations: 1000 });
  return { dir, keys: unlock(readLock(dir), pass) };
}
const LK = lockKeys();
const KEYS = LK.keys, AES = KEYS.aes, PUB = inboxKeys(KEYS.token).publicB64;

// made-up market data in the docs/DATA.md shapes, with the owner's settings inside live.json as the scan writes them
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
// what the owner's page does: open the owner slot, derive the guest key with the guest salt, wrap the data key
function addRequest(dir, { name = 'Made-up Friend', pass = `made up guest ${hex(4)}`, exp = null, at = NOW, slot = hex(8) } = {}) {
  const kf = readKeysFile(dir), ring = ownerRing(AES, kf), kek = guestKek(pass, kf.gsalt, kf.iter);
  const wrap = wrapSlot({ k: ring.dek.toString('base64'), s: slot, n: name, e: exp, g: ring.gen }, kek, 'guest');
  return { pass, kek, slot, env: req({ lps: 'guest-add', id: hex(16), at, slot, kek: kek.toString('base64'), name, exp, wrap }) };
}
const step = (dir, o = {}) => guestStep({ keys: KEYS, outDir: dir, now: NOW, ...o });

test('slots open only with their own key and kind; the keys file is strict and shows nothing but wrapped keys', () => {
  const k1 = crypto.randomBytes(32), k2 = crypto.randomBytes(32);
  const s = wrapSlot({ k: 'x', n: 'Made-up Friend' }, k1, 'guest');
  assert.deepEqual(unwrapSlot(s, k1, 'guest'), { k: 'x', n: 'Made-up Friend' });
  assert.throws(() => unwrapSlot(s, k2, 'guest'));
  assert.throws(() => unwrapSlot(s, k1, 'owner'), 'a guest slot never passes as the owner slot');
  const dek = crypto.randomBytes(32), kek = crypto.randomBytes(32);
  const kf = buildKeysFile({ ownerAes: AES, dek, gsalt: crypto.randomBytes(16).toString('base64'), iter: 1000, guests: [{ s: 'aaaaaaaaaaaaaaaa', n: 'Made-up Friend', e: NOW + 7 * 24 * H, kek }], t: NOW });
  assert.ok(isKeysFile(kf));
  assert.ok(ownerRing(AES, kf).dek.equals(dek));
  const g = openGuestSlot(kf, kek);
  assert.ok(g.dek.equals(dek)); assert.equal(g.name, 'Made-up Friend'); assert.equal(g.slot, 'aaaaaaaaaaaaaaaa');
  assert.equal(openGuestSlot(kf, k2), null);
  assert.throws(() => ownerRing(kek, kf), /does not open with this lock/);
  const text = JSON.stringify(kf);
  assert.ok(!/Made-up|aaaaaaaa|"n"|"e"|"s"/.test(text), 'names, slot ids and expiry stay inside the slots');
  assert.ok(!isKeysFile({ ...kf, guests: 1 }), 'an extra field is refused');
  assert.ok(!isKeysFile({ ...kf, slots: [{ ...kf.owner, n: 'x' }] }));
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

test('migration: the data key is created, market files move under it, every cumulative row is kept, owner files stay owner-only', () => {
  const dir = legacyDir();
  const before = openStore({ keys: KEYS, outDir: dir });
  const L0 = before.get('live.json'), H0 = before.get('history.json'), B0 = before.get('backtest.json');
  assert.equal(step(dir, { allowMigrate: false }).skipped, 'no keys file', 'no migration unless allowed');
  assert.ok(!fs.existsSync(path.join(dir, KEYS_FILE)));
  const r = step(dir, { allowMigrate: true });
  assert.ok(r.migrated && r.wrote && !r.rotated);
  const kf = readKeysFile(dir), ring = ownerRing(AES, kf);
  assert.equal(kf.slots.length, 0);
  for (const n of ['live.json', 'history.json', 'backtest.json']) {
    assert.ok(opens(dir, n, ring.dek), `${n} opens with the data key`);
    assert.ok(!opens(dir, n, AES), `${n} no longer opens with the owner key`);
  }
  for (const n of ['snapshots.json', 'log.json', 'owner.json', 'guests.json']) {
    assert.ok(opens(dir, n, AES), `${n} opens with the owner key`);
    assert.ok(!opens(dir, n, ring.dek), `${n} never opens with the data key`);
  }
  const m = readWith(dir, 'live.json', ring.dek);
  assert.deepEqual(privateIn('live.json', m), []);
  assert.ok(!('ticket' in readWith(dir, 'backtest.json', ring.dek)));
  const after = openStore({ keys: KEYS, outDir: dir });
  assert.deepEqual(after.get('live.json'), L0, 'the owner sees the same live.json');
  assert.deepEqual(after.get('history.json'), H0, 'every history row kept');
  assert.deepEqual(after.get('backtest.json'), B0);
  assert.deepEqual(readWith(dir, 'owner.json', AES), { v: 1, t: L0.t, ticket: 4321, stopLoss: 0.08, gemAt: 61, ageDays: 123 });
  // a later pass writes through the store: still split, still the same for the owner
  after.put('live.json', { ...L0, t: NOW });
  assert.equal(after.get('live.json').ticket, 4321);
  assert.deepEqual(privateIn('live.json', readWith(dir, 'live.json', ring.dek)), []);
  assert.ok(after.hasDek());
  // a second run never migrates again
  const again = step(dir, { allowMigrate: true });
  assert.ok(!again.migrated && !again.wrote);
  assert.ok(ownerRing(AES, readKeysFile(dir)).dek.equals(ring.dek));
});

test('before the migration the store writes exactly as before (an older loop and the page keep working)', () => {
  const dir = legacyDir();
  const s = openStore({ keys: KEYS, outDir: dir });
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
  const kf = readKeysFile(dir);
  assert.equal(kf.slots.length, 1);
  const kek = guestKek(a.pass, kf.gsalt, kf.iter), g = openGuestSlot(kf, kek);
  assert.ok(g && g.name === 'Made-up Friend' && g.exp === NOW + 30 * 24 * H);
  for (const n of ['live.json', 'history.json', 'backtest.json']) assert.ok(opens(dir, n, g.dek), `the guest opens ${n}`);
  for (const n of ['owner.json', 'guests.json', 'snapshots.json', 'log.json']) assert.ok(!opens(dir, n, g.dek) && !opens(dir, n, kek), `the guest never opens ${n}`);
  assert.ok(!openGuestSlot(kf, guestKek('a made-up wrong guess', kf.gsalt, kf.iter)));
  // the same request again: already done
  const r2 = step(dir, { requests: [a.env] });
  assert.equal(r2.added, 0); assert.ok(!r2.wrote);
  // planted: a request whose slot holds a key that is not the data key is refused
  const bad = addRequest(dir);
  const forged = { lps: 'guest-add', id: hex(16), at: NOW, slot: hex(8), kek: bad.kek.toString('base64'), name: 'Made-up Forger', exp: null,
    wrap: wrapSlot({ k: crypto.randomBytes(32).toString('base64') }, bad.kek, 'guest') };
  const r3 = step(dir, { requests: [a.env, req(forged), { inbox: 1, epk: 'x', iv: 'y', ct: 'z' }, null] });
  assert.equal(r3.refused, 1); assert.equal(r3.bad, 2); assert.equal(readKeysFile(dir).slots.length, 1);
  const line = guestLine(r3, { read: true, files: 4 });
  assert.match(line, /^guests: 1 active, 0 added, 0 removed, 0 expired, 1 refused, 2 unreadable; inbox 4 files; data key kept; keys written: yes$/);
  assert.ok(!/Made-up|Forger/.test(line));
});

test('remove a guest: the data key rotates, the removed guest opens nothing new, the others keep access, the owner keeps every row', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const a = addRequest(dir, { name: 'Made-up One', at: NOW - 3 * H }), b = addRequest(dir, { name: 'Made-up Two', at: NOW - 2 * H });
  step(dir, { requests: [a.env, b.env] });
  const k0 = readKeysFile(dir), dek0 = ownerRing(AES, k0).dek, H0 = openStore({ keys: KEYS, outDir: dir }).get('history.json');
  assert.equal(k0.slots.length, 2);
  const rm = req({ lps: 'guest-remove', id: hex(16), at: NOW - H, slot: a.slot });
  const r = step(dir, { requests: [a.env, b.env, rm] });
  assert.ok(r.rotated); assert.equal(r.removed, 1); assert.equal(r.active, 1);
  const k1 = readKeysFile(dir), ring = ownerRing(AES, k1);
  assert.ok(!ring.dek.equals(dek0), 'a new data key');
  assert.ok(ring.prev[0].equals(dek0), 'the owner slot keeps the old one');
  assert.equal(ring.gen, 1);
  assert.equal(openGuestSlot(k1, a.kek), null, 'the removed guest has no slot');
  for (const n of ['live.json', 'history.json', 'backtest.json']) {
    assert.ok(!opens(dir, n, dek0), `${n} no longer opens with the old key`);
    assert.ok(opens(dir, n, openGuestSlot(k1, b.kek).dek), `the remaining guest opens ${n}`);
  }
  assert.deepEqual(openStore({ keys: KEYS, outDir: dir }).get('history.json'), H0);
  const G = readWith(dir, 'guests.json', AES);
  const one = G.guests.find((x) => x.s === a.slot);
  assert.equal(one.st, 'removed'); assert.ok(!('kek' in one), 'a removed guest\'s key is forgotten');
  // the same requests again (a restored older guests.json would replay them): same result, no new rotation
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
  assert.equal(readWith(dir, 'guests.json', AES).guests.find((x) => x.s === a.slot).st, 'expired');
  const r2 = step(dir, { requests: [req({ lps: 'guest-reset', id: hex(16), at: NOW + 2 * H })], now: NOW + 3 * H });
  assert.equal(r2.removed, 1); assert.ok(r2.rotated); assert.equal(readKeysFile(dir).slots.length, 0);
  assert.equal(openGuestSlot(readKeysFile(dir), b.kek), null);
});

test('a stray slot (a guest the list no longer holds) rotates the key away; a lost guest list with slots changes nothing', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const a = addRequest(dir);
  step(dir, { requests: [a.env] });
  // plant a slot nobody in guests.json owns (e.g. keys restored from before a removal)
  const kf = readKeysFile(dir), ring = ownerRing(AES, kf), strayKek = crypto.randomBytes(32);
  const planted = { ...kf, slots: [...kf.slots, wrapSlot({ k: ring.dek.toString('base64'), s: hex(8), n: 'Made-up Ghost', e: null, g: ring.gen }, strayKek, 'guest')] };
  fs.writeFileSync(path.join(dir, KEYS_FILE), JSON.stringify(planted));
  const r = step(dir, { requests: [a.env] });
  assert.equal(r.stray, 1); assert.ok(r.rotated);
  assert.equal(openGuestSlot(readKeysFile(dir), strayKek), null);
  assert.ok(openGuestSlot(readKeysFile(dir), a.kek));
  // planted: guests.json gone while slots exist: skipped, nothing written
  fs.rmSync(path.join(dir, 'guests.json'));
  const before = fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8');
  const r2 = step(dir, { requests: [req({ lps: 'guest-reset', id: hex(16), at: NOW })] });
  assert.equal(r2.skipped, 'guests file unread');
  assert.equal(fs.readFileSync(path.join(dir, KEYS_FILE), 'utf8'), before);
});

test('a keys.json from another lock, or a wrong passphrase, stops everything and seals nothing', () => {
  const dir = legacyDir();
  step(dir, { allowMigrate: true });
  const other = lockKeys('another made-up passphrase, not a secret');
  const foreign = buildKeysFile({ ownerAes: other.keys.aes, dek: crypto.randomBytes(32), gsalt: crypto.randomBytes(16).toString('base64'), iter: 1000, t: NOW });
  fs.writeFileSync(path.join(dir, KEYS_FILE), JSON.stringify(foreign));
  const snap = () => fs.readdirSync(dir).sort().map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('|');
  const before = snap();
  assert.throws(() => step(dir, { allowMigrate: true }), /refusing: keys.json does not open with this lock/);
  assert.throws(() => openStore({ keys: KEYS, outDir: dir }).get('live.json'), /refusing/);
  assert.equal(snap(), before);
  assert.throws(() => unlock(readLock(LK.dir), 'a made-up wrong passphrase'), /wrong passphrase/);
});

test('requests are checked field by field; a name is cleaned and capped', () => {
  const priv = inboxKeys(KEYS.token).privateKey, kek = crypto.randomBytes(32), wrap = wrapSlot({ k: 'x' }, kek, 'guest');
  const base = { lps: 'guest-add', id: hex(16), at: NOW, slot: hex(8), kek: kek.toString('base64'), name: ' Made-up\u0007  Friend ', exp: NOW + H, wrap };
  assert.equal(parseRequest(req(base), priv).name, 'Made-up Friend');
  for (const bad of [{ id: 'x' }, { slot: 'XYZ' }, { kek: 'short' }, { exp: NOW - H }, { name: '' }, { name: 'x'.repeat(41) }, { lps: 'guest-promote' }, { wrap: { iv: 1 } }]) {
    assert.equal(parseRequest(req({ ...base, ...bad }), priv), null, JSON.stringify(Object.keys(bad)));
  }
  assert.equal(parseRequest(req(base), crypto.generateKeyPairSync('x25519').privateKey), null, 'sealed to another inbox');
  assert.deepEqual(parseRequest(req({ lps: 'guest-remove', id: base.id, at: NOW, slot: base.slot }), priv), { lps: 'guest-remove', id: base.id, at: NOW, slot: base.slot });
});
