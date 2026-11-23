// The shared guest password's restart (lib/guests.mjs, docs/briefs/guest-access.md §4b): { action: 'extend-shared-guest', label,
// days: 180, from: 'now' } sets the shared slot's end to the pass that applies it plus 180 days, with the same password and the
// same market key; the owner's slots, the recovery key and named guests never change; an unknown label or a role other than
// guest is refused; a slot past its date that the loop hasn't dropped yet is restarted, one the loop already dropped is refused
// (noted for the owner's page); the same file again does nothing. add-shared-guest without days lasts 180 days.
// Throwaway lock (dummy passphrase, 1,000 rounds), made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLock, readLock, unlock, open } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal } from '../lib/inbox.mjs';
import { writeSealed } from '../lib/store.mjs';
import { KEYS_FILE, wrapSlot, reopen, openGuestSlot, guestKek, readKeysFile } from '../lib/keyring.mjs';
import { guestStep, parseRequest, guestLine } from '../lib/guests.mjs';
import { sealInput } from '../scripts/seal-input.mjs';

const DUMMY = 'shared extend test dummy passphrase, not a secret';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-shx-'));
const H = 3600e3, D = 86400e3, NOW = Date.parse('2026-11-16T10:00:00Z');
const hex = (n) => crypto.randomBytes(n).toString('hex');
const LOCK = (() => { const dir = tmp(); initLock({ dir, passphrase: DUMMY, iterations: 1000 }); return unlock(readLock(dir), DUMMY); })();
const K = () => ({ ...LOCK });
const PUB = inboxKeys(LOCK.token).publicB64, PRIV = inboxKeys(LOCK.token).privateKey;
const req = (x) => inboxSeal(JSON.stringify(x), PUB);
const vaultOf = (dir) => reopen(K(), readKeysFile(dir));
const readWith = (dir, name, key) => JSON.parse(open(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), key));
const guestsOf = (dir) => readWith(dir, 'guests.json', vaultOf(dir).aes);
const bytes = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const step = (dir, o = {}) => guestStep({ keys: K(), outDir: dir, now: NOW, ...o });
// the request as the owner's helper seals it (scripts/seal-input.mjs: no id, no at)
function sealed(obj) {
  const pubDir = tmp(), out = path.join(tmp(), 'made-up-request.json');
  fs.writeFileSync(path.join(pubDir, 'inbox.json'), JSON.stringify({ v: 1, x25519: PUB }));
  sealInput({ text: JSON.stringify(obj), out, pubDir, say: () => {} });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}
const EXTEND = { action: 'extend-shared-guest', label: 'friends', days: 180, from: 'now' };

// a migrated folder with the loop's shared password (30 days, made at NOW), a named guest and a member; a recovery key set
function world() {
  const dir = tmp();
  const t = NOW - H;
  writeSealed('live.json', { v: 1, t, pools: [{ id: 'p1', pair: 'MADE/UP', checks: [] }] }, LOCK.aes, { outDir: dir });
  writeSealed('history.json', { v: 1, t, health: [], pools: {} }, LOCK.aes, { outDir: dir });
  writeSealed('backtest.json', { v: 1, t, pools: {} }, LOCK.aes, { outDir: dir });
  writeSealed('snapshots.json', { v: 1, t, fix: 2, pools: {} }, LOCK.aes, { outDir: dir });
  writeSealed('log.json', { v: 1, t, lines: ['made-up line'], errors: 0, categories: {} }, LOCK.aes, { outDir: dir });
  step(dir, { allowMigrate: true, now: NOW - H });
  const add = sealed({ action: 'add-shared-guest', label: 'friends', days: 30 });
  // a named guest (labelled like a person) and a member, made by the page: their slots wrapped with the market key
  const kf = readKeysFile(dir), v = vaultOf(dir);
  const named = (name, role, pass) => {
    const kek = guestKek(pass, kf.gsalt, kf.iter), slot = hex(8);
    return { pass, slot, item: { slot, kek: kek.toString('base64'), name, exp: NOW + 45 * D, role, wrap: wrapSlot({ k: v.mdek.toString('base64'), s: slot, n: name, e: NOW + 45 * D, g: v.gen }, kek, 'guest') } };
  };
  const ada = named('Made-up Friend', 'guest', `made up guest ${hex(4)}`), dee = named('Made-up Member', 'member', `made up member ${hex(4)}`);
  const people = req({ lps: 'guest-add', id: hex(16), at: NOW - 30 * 60e3, guests: [ada.item, dee.item] });
  const rk = crypto.randomBytes(32), rsalt = crypto.randomBytes(16).toString('base64');
  const rec = req({ lps: 'recovery-set', id: hex(16), at: NOW - 20 * 60e3, rsalt, slot: wrapSlot({ m: v.mk.toString('base64') }, rk, 'recovery') });
  const base = [add, people, rec];
  const r = step(dir, { requests: base, now: NOW });
  assert.equal(r.added, 3); assert.equal(r.recoverySet, 1);
  const sh = guestsOf(dir).guests.find((x) => x.sh);
  assert.ok(sh && sh.e === NOW + 30 * D && /^([a-z]{3,6}-){5}\d\d$/.test(sh.pw));
  return { dir, base, pw: sh.pw, ada, dee };
}
const sharedSlot = (dir, pw) => { const kf = readKeysFile(dir); return openGuestSlot(kf, guestKek(pw, kf.gsalt, kf.iter)); };

test('extend-shared-guest is read as the shared restart; days default to 180; from is "now" only; add-shared-guest without days lasts 180', () => {
  const r = parseRequest(sealed(EXTEND), PRIV, NOW);
  assert.ok(r && r.lps === 'shared-extend' && r.label === 'friends' && r.days === 180 && /^[0-9a-f]{32}$/.test(r.id) && r.at === NOW);
  assert.equal(parseRequest(sealed({ action: 'extend-shared-guest', label: 'friends' }), PRIV, NOW).days, 180);
  assert.equal(parseRequest(sealed({ action: 'extend-shared-guest' }), PRIV, NOW).label, null, 'no label: the only shared password');
  for (const bad of [{ from: 'made' }, { from: 0 }, { days: 0 }, { days: 366 }, { days: 1.5 }, { days: '180' }, { label: '' }, { label: 'x'.repeat(41) }, { role: 7 }]) {
    assert.equal(parseRequest(sealed({ ...EXTEND, ...bad }), PRIV, NOW), null, JSON.stringify(bad));
  }
  const page = parseRequest(req({ lps: 'shared-extend', id: hex(16), at: NOW - H, label: 'friends', days: 180, from: 'now' }), PRIV, NOW);
  assert.ok(page && page.at === NOW - H && page.days === 180, 'the page\'s own form (id and at) reads the same');
  assert.equal(parseRequest(sealed({ action: 'add-shared-guest', label: 'friends' }), PRIV, NOW).days, 180);
});

test('the restart keeps the password and the market key, counts 180 days from the pass that applies it, and touches nothing else', () => {
  const { dir, base, pw, ada, dee } = world();
  const kf0 = readKeysFile(dir), v0 = vaultOf(dir), live0 = bytes(dir, 'live.json'), hist0 = bytes(dir, 'history.json');
  const adaSlot0 = openGuestSlot(kf0, guestKek(ada.pass, kf0.gsalt, kf0.iter)), deeSlot0 = openGuestSlot(kf0, guestKek(dee.pass, kf0.gsalt, kf0.iter));
  // sealed by the page an hour after the password was made; committed and applied five days later
  const ext = req({ action: 'extend-shared-guest', id: hex(16), at: NOW + H, label: 'friends', days: 180, from: 'now' });
  const APPLY = NOW + 5 * D + 7 * H;
  const r = step(dir, { requests: [...base, ext], now: APPLY });
  assert.equal(r.extended, 1); assert.equal(r.refused, 0); assert.equal(r.again, 3);
  assert.ok(!r.rotated && r.wrote, 'no rotation');
  const kf = readKeysFile(dir), v = vaultOf(dir), o = sharedSlot(dir, pw);
  assert.ok(o && o.shared && o.name === 'friends' && o.role === 'guest' && o.soft === 0, 'the same password still opens the shared slot');
  assert.equal(o.exp, APPLY + 180 * D, 'from the pass that applies it, not from when it was sealed or made');
  assert.ok(o.dek.equals(v0.mdek) && v.mdek.equals(v0.mdek) && v.gen === v0.gen, 'the same market key');
  assert.ok(v.aes.equals(v0.aes) && v.token.equals(v0.token), 'the same private key and inbox key');
  assert.equal(bytes(dir, 'live.json'), live0); assert.equal(bytes(dir, 'history.json'), hist0); // nothing sealed again
  assert.deepEqual(kf.owner, kf0.owner, 'the owner slots as they were'); assert.deepEqual(kf.recovery, kf0.recovery, 'the recovery slot as it was');
  assert.equal(kf.rsalt, kf0.rsalt); assert.equal(kf.slots.length, 3);
  const adaSlot = openGuestSlot(kf, guestKek(ada.pass, kf.gsalt, kf.iter)), deeSlot = openGuestSlot(kf, guestKek(dee.pass, kf.gsalt, kf.iter));
  assert.deepEqual({ ...adaSlot, dek: null }, { ...adaSlot0, dek: null }, 'the named guest unchanged'); assert.deepEqual({ ...deeSlot, dek: null }, { ...deeSlot0, dek: null }, 'the member unchanged');
  const g = guestsOf(dir), sh = g.guests.find((x) => x.sh);
  assert.ok(sh.e === APPLY + 180 * D && sh.rx === APPLY && sh.st === 'active' && sh.pw === pw && sh.at === NOW, 'the record: the new end, restarted then, same password, same made date');
  assert.deepEqual(g.shx, { at: APPLY, ok: true });
  assert.equal(g.guests.filter((x) => !x.sh).every((x) => x.e === NOW + 45 * D && !('rx' in x)), true);
  const line = guestLine(r, { read: true, files: 4 });
  assert.match(line, /shared password restarted, /); assert.ok(!line.includes(pw) && !line.includes('friends') && !line.includes('Made-up'), 'the public line: counts and yes/no only');
  // the next pass past the old end (30 days): nothing expires
  const r2 = step(dir, { requests: [...base, ext], now: NOW + 40 * D });
  assert.equal(r2.expired, 0); assert.equal(r2.extended, 0); assert.ok(sharedSlot(dir, pw));
});

test('a wrong label or role is refused: an unknown label, a named guest\'s or a member\'s name, a role other than guest', () => {
  for (const [bad, why] of [[{ label: 'family' }, 'unknown'], [{ label: 'Made-up Friend' }, 'unknown'], [{ label: 'Made-up Member' }, 'unknown'], [{ role: 'member' }, 'role'], [{ role: 'owner' }, 'role']]) {
    const { dir, base, pw, ada } = world();
    const keys0 = bytes(dir, KEYS_FILE), APPLY = NOW + 2 * D;
    const r = step(dir, { requests: [...base, sealed({ ...EXTEND, ...bad })], now: APPLY });
    assert.equal(r.extended, 0, JSON.stringify(bad)); assert.equal(r.refused, 1); assert.equal(r.extEnded, 0);
    assert.equal(bytes(dir, KEYS_FILE), keys0, 'keys.json untouched');
    assert.equal(sharedSlot(dir, pw).exp, NOW + 30 * D);
    const kf = readKeysFile(dir);
    assert.equal(openGuestSlot(kf, guestKek(ada.pass, kf.gsalt, kf.iter)).exp, NOW + 45 * D);
    const g = guestsOf(dir);
    assert.deepEqual(g.shx, { at: APPLY, ok: false, why });
    assert.ok(g.guests.every((x) => !('rx' in x)));
  }
});

test('no label: the only active shared password is restarted', () => {
  const { dir, base, pw } = world();
  const r = step(dir, { requests: [...base, sealed({ action: 'extend-shared-guest', days: 180 })], now: NOW + 3 * D });
  assert.equal(r.extended, 1); assert.equal(sharedSlot(dir, pw).exp, NOW + 3 * D + 180 * D);
});

test('past its date but still there (the loop hasn\'t dropped it yet): restarted, the same password, no rotation', () => {
  const { dir, base, pw } = world();
  const v0 = vaultOf(dir), APPLY = NOW + 30 * D + 2 * H; // its 30 days are over; no pass has run since
  assert.ok(sharedSlot(dir, pw), 'the slot is still in keys.json');
  const r = step(dir, { requests: [...base, sealed(EXTEND)], now: APPLY });
  assert.equal(r.extended, 1); assert.equal(r.expired, 0); assert.ok(!r.rotated);
  const o = sharedSlot(dir, pw);
  assert.ok(o && o.exp === APPLY + 180 * D && o.dek.equals(v0.mdek));
  assert.equal(guestsOf(dir).guests.find((x) => x.sh).st, 'active');
});

test('a shared password the loop already dropped is refused, with a clear status; it stays ended', () => {
  // (a) it expired: the loop dropped its slot and rotated the key on an earlier pass
  let { dir, base, pw } = world();
  const r0 = step(dir, { requests: base, now: NOW + 30 * D + H });
  assert.equal(r0.expired, 1); assert.ok(r0.rotated); assert.equal(sharedSlot(dir, pw), null);
  const keys0 = bytes(dir, KEYS_FILE), APPLY = NOW + 31 * D;
  const r = step(dir, { requests: [...base, sealed(EXTEND)], now: APPLY });
  assert.equal(r.extended, 0); assert.equal(r.refused, 1); assert.equal(r.extEnded, 1);
  assert.equal(sharedSlot(dir, pw), null, 'still ended: the password opens nothing'); assert.equal(bytes(dir, KEYS_FILE), keys0);
  const g = guestsOf(dir);
  assert.deepEqual(g.shx, { at: APPLY, ok: false, why: 'ended' });
  assert.equal(g.guests.find((x) => x.sh).st, 'expired');
  assert.match(guestLine(r), /1 refused \(a shared password restart came after it had ended: make a new one\)/);
  // (b) the owner ended it ("End shared access now")
  ({ dir, base, pw } = world());
  const slot = guestsOf(dir).guests.find((x) => x.sh).s;
  const end = req({ lps: 'guest-remove', id: hex(16), at: NOW + H, slot });
  step(dir, { requests: [...base, end], now: NOW + 2 * H });
  const r2 = step(dir, { requests: [...base, end, sealed(EXTEND)], now: NOW + 3 * H });
  assert.equal(r2.refused, 1); assert.equal(r2.extEnded, 1); assert.equal(sharedSlot(dir, pw), null);
});

test('replay-safe: the same sealed file again does nothing; a later restart counts from its own pass', () => {
  const { dir, base, pw } = world();
  const ext = sealed(EXTEND), A1 = NOW + 2 * D;
  step(dir, { requests: [...base, ext], now: A1 });
  const keys1 = bytes(dir, KEYS_FILE), g1 = guestsOf(dir);
  const r = step(dir, { requests: [...base, ext], now: NOW + 9 * D });
  assert.equal(r.again, 4); assert.equal(r.extended, 0); assert.equal(r.refused, 0);
  assert.equal(bytes(dir, KEYS_FILE), keys1, 'keys.json untouched'); assert.equal(sharedSlot(dir, pw).exp, A1 + 180 * D);
  const g2 = guestsOf(dir);
  assert.deepEqual(g2.guests, g1.guests); assert.deepEqual(g2.shx, g1.shx);
  // the file is handled (removed after the publish) and its id is kept for good
  assert.deepEqual(r.handled, [0, 1, 2, 3]);
  // a new restart (a new file) is a new request: 180 days from its own pass
  const r3 = step(dir, { requests: [...base, ext, sealed(EXTEND)], now: NOW + 20 * D });
  assert.equal(r3.extended, 1); assert.equal(sharedSlot(dir, pw).exp, NOW + 20 * D + 180 * D);
});
