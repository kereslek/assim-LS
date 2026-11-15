// Guest access, the data branch (scripts/publish-data.mjs, scripts/loop.mjs, scripts/backup.mjs, scripts/restore.mjs,
// lib/guests.mjs readInbox): the loop's first run migrates only when the data branch was read and has no keys.json;
// its publish carries keys.json and the files in one commit; another job's publish keeps the branch's keys and seals
// its own market file under the current data key (owner-only fields split off); a second migration's guest salt is
// refused; a wrong passphrase stops the publish; backups and the drill read keys.json; requests are read from inbox/
// at the code branch's tip. Throwaway lock (dummy passphrase), local bare remotes, made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initLock, readLock, unlock, open } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal } from '../lib/inbox.mjs';
import { writeSealed, openStore } from '../lib/store.mjs';
import { KEYS_FILE, reopen, readKeysFile, wrapSlot, guestKek, openGuestSlot, privateIn } from '../lib/keyring.mjs';
const ownerRing = (keys, kf) => { const v = reopen({ ...keys }, kf); return { ...v, dek: v.mdek }; };
import { guestStep, readInbox } from '../lib/guests.mjs';
import { publishData, restoreData } from '../scripts/publish-data.mjs';
import { runLoop } from '../scripts/loop.mjs';
import { makeBackup } from '../scripts/backup.mjs';
import { checkBackup, readFolder, drill } from '../scripts/restore.mjs';

const DUMMY = 'guest publish test dummy passphrase, not a secret';
const ENV = { LOCK_PASSPHRASE: DUMMY };
const H = 3600e3, NOW = Date.parse('2026-11-15T10:00:00Z');
const hex = (n) => crypto.randomBytes(n).toString('hex');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-gpub-')), work = path.join(root, 'work'), origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', origin);
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'code');
  fs.writeFileSync(path.join(work, '.gitignore'), 'out*/\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'Code');
  git(work, 'remote', 'add', 'origin', origin);
  initLock({ dir: path.join(work, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const keys = unlock(readLock(path.join(work, 'lock')), DUMMY);
  const out = (d) => path.join(work, d);
  const pub = (d, o = {}) => publishData({ repo: work, outDir: d, env: ENV, say: () => {}, ...o });
  const restore = (d) => restoreData({ repo: work, outDir: d, env: ENV, say: () => {} });
  const branch = () => {
    git(work, 'fetch', '-q', 'origin', '+refs/heads/data:refs/lps/check');
    const names = git(work, 'ls-tree', '--name-only', 'refs/lps/check').split('\n');
    const text = (n) => git(work, 'cat-file', 'blob', `refs/lps/check:${n}`);
    return { names, text, env: (n) => JSON.parse(text(n)) };
  };
  return { root, work, origin, keys, out, pub, restore, branch };
}
const madeLive = (t) => ({ v: 1, t, phase: 0, build: 'made-up', next: null, ticket: 4321, stopLoss: 0.08, gemAt: 61, windows: ['24h'], health: { loop: null, checks: [] },
  pools: [{ id: 'p1', chain: 'ethereum', w: {}, checks: [{ id: 'token-age-rank', label: 'tokens ranked and trading 123+ days', ok: true }] }] });
const legacyPass = (s, d, t) => {
  writeSealed('live.json', madeLive(t), s.keys.aes, { outDir: s.out(d) });
  writeSealed('history.json', { v: 1, t, health: [], pools: { p1: { h: [[t - H, 1, 1, null, 0]], d: [] } } }, s.keys.aes, { outDir: s.out(d) });
  writeSealed('snapshots.json', { v: 1, t, fix: 2, pools: {} }, s.keys.aes, { outDir: s.out(d) });
};
const opensWith = (env, key) => { try { open(env, key); return true; } catch { return false; } };

test('the loop migrates once, publishes keys and files in one commit; the backtest job keeps the branch\'s keys and is sealed under them', () => {
  const s = setup();
  // the data branch as an older loop leaves it: everything under the owner key
  legacyPass(s, 'out-old', NOW - 2 * H); s.pub('out-old');
  writeSealed('backtest.json', { v: 1, t: NOW - 90 * 60e3, ticket: 4321, provisional: true, pools: {} }, s.keys.aes, { outDir: s.out('out-bt') });
  // the backtest job restored the old format before the loop migrated (its local files are under the owner key)
  s.restore('out-bt');
  // the new loop: restore, keys step (migration), a pass, publish with its own keys
  const r = s.restore('out-loop');
  assert.ok(r.present && !r.keys);
  const g = guestStep({ keys: { ...s.keys }, outDir: s.out('out-loop'), now: NOW, allowMigrate: r.present && !r.keys });
  assert.ok(g.migrated);
  openStore({ keys: { ...s.keys }, outDir: s.out('out-loop') }).put('live.json', madeLive(NOW - H));
  const p = s.pub('out-loop', { ownKeys: true });
  assert.equal(p.keys, 'local');
  let b = s.branch();
  assert.ok(b.names.includes(KEYS_FILE) && b.names.includes('owner.json') && b.names.includes('guests.json'));
  const kf = JSON.parse(b.text(KEYS_FILE)), vault = ownerRing(s.keys, kf), dek = vault.dek, pk = vault.aes;
  for (const n of ['live.json', 'history.json']) { assert.ok(opensWith(b.env(n), dek) && !opensWith(b.env(n), s.keys.aes) && !opensWith(b.env(n), pk), n); }
  for (const n of ['snapshots.json', 'owner.json', 'guests.json']) assert.ok(opensWith(b.env(n), pk) && !opensWith(b.env(n), dek) && !opensWith(b.env(n), s.keys.aes), n);
  assert.deepEqual(privateIn('live.json', JSON.parse(open(b.env('live.json'), dek))), []);
  // the backtest job publishes its backtest.json, sealed under the owner key with its ticket: it lands under the data key, split
  const q = s.pub('out-bt');
  assert.equal(q.keys, 'remote'); assert.ok(q.resealed >= 1);
  b = s.branch();
  assert.deepEqual(JSON.parse(b.text(KEYS_FILE)), kf, 'another job never changes keys.json');
  const bt = b.env('backtest.json');
  assert.ok(opensWith(bt, dek) && !opensWith(bt, s.keys.aes));
  assert.ok(!('ticket' in JSON.parse(open(bt, dek))), 'the ticket never goes under the data key');
  assert.ok(opensWith(b.env('live.json'), dek), 'the loop\'s newer live.json kept');
  // planted: a second migration somewhere (a new guest salt) is refused, nothing pushed
  const tip = git(s.work, 'ls-remote', 'origin', 'refs/heads/data');
  fs.rmSync(s.out('out-2'), { recursive: true, force: true });
  legacyPass(s, 'out-2', NOW);
  guestStep({ keys: { ...s.keys }, outDir: s.out('out-2'), now: NOW, allowMigrate: true });
  assert.throws(() => s.pub('out-2', { ownKeys: true }), /different guest salt/);
  assert.equal(git(s.work, 'ls-remote', 'origin', 'refs/heads/data'), tip);
  // planted: a wrong passphrase stops the publish before anything moves
  assert.throws(() => publishData({ repo: s.work, outDir: s.out('out-loop'), env: { LOCK_PASSPHRASE: 'a made-up wrong passphrase' }, say: () => {}, ownKeys: true }), /wrong passphrase/);
  assert.equal(git(s.work, 'ls-remote', 'origin', 'refs/heads/data'), tip);
});

test('a rotation publishes the new key with every market file under it, including one another job left under the old key', () => {
  const s = setup();
  legacyPass(s, 'out-loop', NOW - 2 * H);
  guestStep({ keys: { ...s.keys }, outDir: s.out('out-loop'), now: NOW - 2 * H, allowMigrate: true });
  s.pub('out-loop', { ownKeys: true });
  // a guest is added
  const kf = readKeysFile(s.out('out-loop')), ring = ownerRing(s.keys, kf), pass = 'made up guest words 42', kek = guestKek(pass, kf.gsalt, kf.iter), slot = hex(8);
  const add = inboxSeal(JSON.stringify({ lps: 'guest-add', id: hex(16), at: NOW - H, slot, kek: kek.toString('base64'), name: 'Made-up Friend', exp: null,
    wrap: wrapSlot({ k: ring.dek.toString('base64'), s: slot, n: 'Made-up Friend', e: null, g: 0 }, kek, 'guest') }), inboxKeys(s.keys.token).publicB64);
  guestStep({ keys: { ...s.keys }, outDir: s.out('out-loop'), now: NOW - H, requests: [add] });
  s.pub('out-loop', { ownKeys: true });
  // the backtest job publishes under the key it restored (the old one)...
  s.restore('out-bt');
  openStore({ keys: { ...s.keys }, outDir: s.out('out-bt') }).put('backtest.json', { v: 1, t: NOW - 30 * 60e3, ticket: 4321, provisional: true, pools: {} });
  s.pub('out-bt');
  // ...then the loop removes the guest (rotation) and publishes: the branch's backtest.json is carried under the new key
  const rm = inboxSeal(JSON.stringify({ lps: 'guest-remove', id: hex(16), at: NOW - 20 * 60e3, slot }), inboxKeys(s.keys.token).publicB64);
  const g = guestStep({ keys: { ...s.keys }, outDir: s.out('out-loop'), now: NOW, requests: [add, rm] });
  assert.ok(g.rotated);
  const p = s.pub('out-loop', { ownKeys: true });
  assert.ok(p.resealed >= 1 && p.carried >= 1);
  const b = s.branch(), nk = JSON.parse(b.text(KEYS_FILE)), nring = ownerRing(s.keys, nk);
  assert.ok(!nring.dek.equals(ring.dek));
  for (const n of ['live.json', 'history.json', 'backtest.json']) {
    assert.ok(opensWith(b.env(n), nring.dek), `${n} under the new key`);
    assert.ok(!opensWith(b.env(n), ring.dek), `${n} not under the removed guest's key`);
  }
  assert.equal(openGuestSlot(nk, kek), null);
  assert.equal(nk.slots.length, 0);
});

test('the loop: migration only after a restore that read the branch and found no keys; a failed keys step publishes nothing', async () => {
  const mk = (restoreRes, guests) => {
    const lines = [], calls = [];
    const deps = { say: (l) => lines.push(l), now: () => NOW, sleep: async () => {}, marker: () => {}, store: { get: () => null, put: () => {} },
      runPass: async () => ({ ok: true }), publish: () => calls.push('publish'), restore: () => { if (restoreRes instanceof Error) throw restoreRes; return restoreRes; },
      guests: (phase, ctx) => { calls.push(`${phase}:${ctx ? `${ctx.remoteRead}/${ctx.remoteKeys}` : ''}`); if (guests && phase === 'pass') throw guests; } };
    return { deps, lines, calls };
  };
  const opts = { passCmd: 'x', mode: 'rehearsal', maxPasses: 1, spacing: 1, deadlineMs: 60e3 };
  let m = mk({ copied: 3, present: true, keys: false });
  await runLoop(opts, m.deps);
  assert.deepEqual(m.calls, ['start:true/false', 'pass:', 'publish']);
  m = mk(new Error('missing lock: made-up'));
  await runLoop(opts, m.deps);
  assert.equal(m.calls[0], 'start:false/false', 'a failed restore never allows the migration');
  m = mk({ copied: 3, present: true, keys: true });
  await runLoop(opts, m.deps);
  assert.equal(m.calls[0], 'start:true/true');
  m = mk({ copied: 3, present: true, keys: false }, new Error('refusing: keys.json does not open with this lock'));
  const r = await runLoop(opts, m.deps);
  assert.ok(!m.calls.includes('publish'), 'nothing published');
  assert.equal(r.ok, 0);
  assert.ok(m.lines.some((l) => /^guests: keys step failed \(refusing: keys.json does not open with this lock\); this pass is not published$/.test(l)));
});

test('backups and the drill take keys.json (the loop\'s own code restores and loads it); a tampered one fails them', async () => {
  const s = setup();
  legacyPass(s, 'out', NOW - H);
  writeSealed('log.json', { v: 1, t: NOW - H, lines: ['made-up'], errors: 0, categories: {} }, s.keys.aes, { outDir: s.out('out') });
  writeSealed('backtest.json', { v: 1, t: NOW - H, ticket: 4321, provisional: true, pools: {} }, s.keys.aes, { outDir: s.out('out') });
  guestStep({ keys: { ...s.keys }, outDir: s.out('out'), now: NOW, allowMigrate: true });
  fs.copyFileSync(path.join(s.work, 'lock', 'lock.json'), path.join(s.out('out'), 'lock.json'));
  const stamp = '2026-11-15T0950Z', backups = s.out('backups');
  fs.mkdirSync(backups);
  makeBackup({ dataDir: s.out('out'), lockDir: path.join(s.work, 'lock'), outDir: backups, stamp, prune: false, say: () => {} });
  const folder = readFolder(path.join(backups, stamp));
  assert.ok(KEYS_FILE in folder.data && 'owner.json' in folder.data && 'guests.json' in folder.data);
  const repoLock = readLock(path.join(s.work, 'lock'));
  const vk = reopen({ ...s.keys }, JSON.parse(folder.data[KEYS_FILE]));
  const c = checkBackup({ folder, stamp, repoLock, keys: vk, now: NOW });
  assert.ok(c.ok, c.checks.filter((k) => !k.ok).map((k) => k.name).join(' | '));
  assert.equal(c.sealedFiles, 7);
  const lines = [];
  const d = await drill({ dir: path.join(backups, stamp), stamp, lockDir: path.join(s.work, 'lock'), maxAgeH: 2, env: ENV, now: NOW, say: (l) => lines.push(l) });
  assert.ok(d.ok, lines.filter((l) => /FAIL/.test(l)).join(' | '));
  assert.ok(lines.some((l) => /restored by the loop's own code \(7 files\): pass; files restored 7/.test(l)));
  // planted: a keys.json from elsewhere (its owner slot does not open) fails the checks and the files do not open
  const kf = JSON.parse(folder.data[KEYS_FILE]);
  const bad = { ...folder, data: { ...folder.data, [KEYS_FILE]: JSON.stringify({ ...kf, mk: { iv: kf.mk.iv, ct: Buffer.from(crypto.randomBytes(80)).toString('base64') } }) } };
  const c2 = checkBackup({ folder: bad, stamp, repoLock, keys: vk, now: NOW });
  assert.ok(!c2.ok);
  assert.ok(c2.checks.some((k) => !k.ok && /keys.json/.test(k.name)));
  assert.ok(c2.checks.some((k) => !k.ok && /opens with the lock/.test(k.name)));
  // planted: a backup whose keys.json is not a keys file is refused by makeBackup
  fs.writeFileSync(path.join(s.out('out'), KEYS_FILE), JSON.stringify({ keys: 1, made: 'up' }));
  assert.throws(() => makeBackup({ dataDir: s.out('out'), lockDir: path.join(s.work, 'lock'), outDir: backups, stamp: '2026-11-15T0955Z', prune: false, say: () => {} }), /not-a-keys-file/);
});

test('requests are read from inbox/ at the code branch\'s tip; an unknown branch reads nothing', () => {
  const s = setup();
  git(s.work, 'push', '-q', 'origin', 'code');
  git(s.work, 'checkout', '-q', '-b', 'made-up-branch');
  fs.mkdirSync(path.join(s.work, 'inbox'));
  const env = inboxSeal(JSON.stringify({ lps: 'guest-reset', id: hex(16), at: NOW }), inboxKeys(s.keys.token).publicB64);
  fs.writeFileSync(path.join(s.work, 'inbox', `${hex(8)}.json`), JSON.stringify(env));
  fs.writeFileSync(path.join(s.work, 'inbox', 'README.txt'), 'not a request');
  git(s.work, 'add', 'inbox'); git(s.work, 'commit', '-q', '-m', 'A made-up request');
  git(s.work, 'push', '-q', 'origin', 'made-up-branch');
  // the loop's checkout is a different clone, at another commit
  const loopDir = path.join(s.root, 'loop');
  git(s.root, 'clone', '-q', '-b', 'code', s.origin, loopDir);
  const r = readInbox({ repo: loopDir, branch: 'made-up-branch' });
  assert.equal(r.read, true); assert.equal(r.files, 1);
  assert.deepEqual(r.envs, [env]);
  assert.equal(readInbox({ repo: loopDir, branch: 'no-such-branch' }).read, false);
  assert.equal(readInbox({ repo: loopDir, branch: '' }).read, false);
  assert.equal(readInbox({ repo: loopDir, branch: 'x;rm -rf /' }).read, false);
});

test('mismatch: the readable flag goes on the data branch with every file as it was; a right passphrase clears it; a wrong one never seals', async () => {
  const { publishStatus } = await import('../scripts/publish-data.mjs');
  const { alarm, TITLE } = await import('../scripts/alarm.mjs');
  const s = setup();
  legacyPass(s, 'out', NOW - H);
  guestStep({ keys: { ...s.keys }, outDir: s.out('out'), now: NOW, allowMigrate: true });
  s.pub('out', { ownKeys: true });
  const blobs = () => { git(s.work, 'fetch', '-q', 'origin', '+refs/heads/data:refs/lps/check'); return git(s.work, 'ls-tree', 'refs/lps/check'); };
  const before = blobs();
  const f = publishStatus({ repo: s.work, now: NOW, say: () => {} });
  assert.ok(f.flagged);
  const after = blobs();
  assert.deepEqual(after.split('\n').filter((l) => !l.endsWith('\tstatus.json')), before.split('\n'), 'every other file byte for byte');
  assert.deepEqual(JSON.parse(s.branch().text('status.json')), { lock: 'mismatch', since: NOW }, 'the flag and nothing else');
  assert.equal(publishStatus({ repo: s.work, now: NOW + H, say: () => {} }).since, NOW, 'kept since it was raised');
  // a wrong passphrase stops before anything is sealed: the branch (and its flag) stay
  assert.throws(() => publishData({ repo: s.work, outDir: s.out('out'), env: { LOCK_PASSPHRASE: 'a made-up wrong passphrase' }, say: () => {}, ownKeys: true }), /^Error: wrong passphrase/);
  assert.equal(blobs(), after);
  // the alarm step raises one issue, not one per run
  const calls = [], open = { n: null };
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[1].includes('issues?state=open')) return { status: 0, stdout: JSON.stringify(open.n ? [{ title: TITLE, number: open.n }] : []) };
    if (args.includes('POST') && args[3].endsWith('/issues')) open.n = 7;
    return { status: 0, stdout: '{}' };
  };
  const flag = () => ({ flagged: true }), say = () => {};
  assert.equal(alarm({ state: 'mismatch', repo: 'made/up', gh, flag, say }).issue, 'opened');
  assert.equal(alarm({ state: 'mismatch', repo: 'made/up', gh, flag, say }).issue, 'open');
  assert.equal(calls.filter((c) => /POST repos\/made\/up\/issues -f/.test(c)).length, 1);
  // the first pass that opens: the publish drops the flag, the alarm step closes the issue
  const p = s.pub('out', { ownKeys: true });
  assert.ok(p.cleared);
  assert.ok(!s.branch().names.includes('status.json'));
  assert.ok(alarm({ state: 'ok', repo: 'made/up', gh, say }).closed);
  assert.ok(calls.some((c) => /PATCH repos\/made\/up\/issues\/7 -f state=closed/.test(c)));
});

test('the loop stops on a passphrase that opens nothing and writes the alarm state; nothing is sealed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-alarm-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const loop = path.resolve('scripts/loop.mjs');
  const r = spawnSync(process.execPath, [loop, '--mode', 'rehearsal', '--pass', 'true', '--max-passes', '1', '--no-restore'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LOCK_PASSPHRASE: 'a made-up wrong passphrase' } });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'loop', 'alarm'), 'utf8').trim(), 'mismatch');
  assert.ok(!fs.existsSync(path.join(dir, 'out', 'data')), 'nothing sealed');
  assert.match(r.stdout, /^loop: wrong passphrase/m);
  const ok = spawnSync(process.execPath, [loop, '--mode', 'rehearsal', '--max-passes', '1', '--no-restore'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LOCK_PASSPHRASE: DUMMY } });
  assert.equal(ok.status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'loop', 'alarm'), 'utf8').trim(), 'ok');
});
