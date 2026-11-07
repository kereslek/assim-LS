// Backups: the data branch's sealed files and the lock files go into a dated folder on the backup branch;
// anything unsealed refuses the whole backup; folders older than 30 days go; the restore rehearsal checks
// the newest folder without decrypting. Made-up data only: a made-up lock, made-up sealed files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { newLockFile, seal } from '../lib/lock.mjs';
import { inboxSeal } from '../lib/inbox.mjs';
import { stampOf, stampTime, planPrune, makeBackup, rehearse, fileProblem } from '../scripts/backup.mjs';

const NOW = Date.parse('2026-11-07T03:17:00Z');
const STAMP = '2026-11-07T0317Z';
const SECRET = 'MADE-UP-PLAINTEXT-0xfeedbeef';
const LOCK = newLockFile('made-up passphrase', 1000);
const AES = crypto.randomBytes(32);
const INBOX_PUB = crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const j = (x) => JSON.stringify(x);

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lps-backup-')); }
function writeAll(dir, files) { fs.mkdirSync(dir, { recursive: true }); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t); }

// a made-up data branch, repo lock dir and backup branch checkout
function setup({ data = {}, lock = {}, backups = {} } = {}) {
  const root = tmp();
  const dirs = { data: path.join(root, 'data'), lock: path.join(root, 'lock'), out: path.join(root, 'backup') };
  writeAll(dirs.data, {
    'live.json': j(seal({ pools: [SECRET] }, AES, { t: NOW - 5 * 60e3 })),
    'history.json': j(seal({ h: [1, 2, 3] }, AES, { t: NOW - 5 * 60e3 })),
    'log.json': j(seal('made-up log', AES, { t: NOW - 4 * 60e3, gzip: false })),
    'lock.json': JSON.stringify(LOCK, null, 1),
    ...data,
  });
  writeAll(dirs.lock, {
    'lock.json': JSON.stringify(LOCK, null, 1),
    'inbox.json': j({ v: 1, x25519: INBOX_PUB }),
    'config.sealed.json': j(inboxSeal('made-up settings', INBOX_PUB)),
    ...lock,
  });
  writeAll(dirs.out, { 'README.md': 'made-up readme\n' });
  for (const [stamp, files] of Object.entries(backups)) writeAll(path.join(dirs.out, stamp), files);
  return dirs;
}

const quiet = () => { const lines = []; return { say: (s) => lines.push(s), lines }; };
const make = (dirs, o = {}) => makeBackup({ dataDir: dirs.data, lockDir: dirs.lock, outDir: dirs.out, stamp: STAMP, ...o });
const refuses = (dirs, re) => {
  const q = quiet();
  assert.throws(() => make(dirs, { say: q.say }), (e) => {
    assert.match(e.message, /^refusing: \d+ of \d+ files failed the seal check/);
    if (re) assert.match(e.message, re);
    assert.ok(!e.message.includes(SECRET) && !/\.json/.test(e.message), 'the refusal names no file and no content');
    return true;
  });
  assert.ok(!fs.existsSync(path.join(dirs.out, STAMP)), 'nothing written');
};

test('stamps: minute precision in UTC; impossible dates are not stamps', () => {
  assert.equal(stampOf(NOW + 42e3), STAMP);
  assert.equal(stampTime(STAMP), NOW);
  for (const bad of ['2026-02-31T0000Z', '2026-11-07T2500Z', '2026-11-07T03:17Z', 'README.md', '2026-11-07T0317']) assert.equal(stampTime(bad), null, bad);
});

test('a clean set is copied byte for byte into <stamp>/ and <stamp>/lock/; the output is counts only', () => {
  const dirs = setup();
  const q = quiet();
  const r = make(dirs, { say: q.say });
  assert.deepEqual([r.dataFiles, r.sealed, r.lockFiles, r.pruned], [4, 3, 3, 0]);
  for (const n of fs.readdirSync(dirs.data)) assert.equal(fs.readFileSync(path.join(dirs.out, STAMP, n), 'utf8'), fs.readFileSync(path.join(dirs.data, n), 'utf8'));
  for (const n of fs.readdirSync(dirs.lock)) assert.equal(fs.readFileSync(path.join(dirs.out, STAMP, 'lock', n), 'utf8'), fs.readFileSync(path.join(dirs.lock, n), 'utf8'));
  assert.ok(q.lines.some((l) => /seal check: pass/.test(l)));
  assert.ok(q.lines.every((l) => !l.includes(SECRET) && !/\.json/.test(l)));
  // a second backup in the same minute is refused, never overwritten
  assert.throws(() => make(dirs, { say: () => {} }), /already exists/);
});

test('planted fault: an unsealed data file refuses the whole backup', () => {
  refuses(setup({ data: { 'live.json': j({ pools: [SECRET] }) } }), /not-sealed 1/);
});

test('planted fault: an envelope with a stray plaintext field is refused', () => {
  const env = { ...seal({ x: 1 }, AES, { t: NOW }), note: SECRET };
  refuses(setup({ data: { 'snapshots.json': j(env) } }), /not-sealed 1/);
});

test('planted faults: unparsable JSON, plaintext settings in lock/, a lock that is not the repo lock, a fake public key', () => {
  refuses(setup({ data: { 'history.json': '{"lock":1,' } }), /unparsable 1/);
  refuses(setup({ lock: { 'config.sealed.json': j({ wallet: SECRET }) } }), /not-sealed 1/);
  refuses(setup({ data: { 'lock.json': j(newLockFile('another made-up passphrase', 1000)) } }), /lock-mismatch 1/);
  refuses(setup({ lock: { 'inbox.json': j({ v: 1, x25519: INBOX_PUB, note: SECRET }) } }), /not-a-public-key 1/);
  refuses(setup({ data: { 'inbox.json': j({ wallet: SECRET }) } }), /not-a-public-key 1/);
  // an inbox-sealed file is fine in lock/ but not as published data
  refuses(setup({ data: { 'extra.json': j(inboxSeal('x', INBOX_PUB)) } }), /not-sealed 1/);
  // no data at all, or no lock on the data branch
  const empty = setup(); for (const n of fs.readdirSync(empty.data)) fs.rmSync(path.join(empty.data, n));
  refuses(empty, /no-sealed-data 1/);
  const nolock = setup(); fs.rmSync(path.join(nolock.data, 'lock.json'));
  refuses(nolock, /lock-missing-from-data 1/);
});

test('fileProblem: the rules by place and name', () => {
  const e = j(seal('x', AES, { t: NOW }));
  assert.equal(fileProblem('data', 'live.json', e, LOCK), null);
  assert.equal(fileProblem('data', 'live.json', j({ lock: 1, t: NOW, iv: 'a' }), LOCK), 'not-sealed');
  assert.equal(fileProblem('lock', 'config.sealed.json', j(inboxSeal('x', INBOX_PUB)), LOCK), null);
  assert.equal(fileProblem('data', 'lock.json', j(LOCK), LOCK), null);
  assert.equal(fileProblem('data', 'lock.json', j({ ...LOCK, iter: 999 }), LOCK), 'not-a-lock-file');
});

test('folders older than 30 days go in the same change; README and non-stamp entries stay', () => {
  const old = (d) => stampOf(NOW - d * 86400e3);
  const files = { 'live.json': j(seal('x', AES, { t: NOW - 40 * 86400e3 })) };
  const dirs = setup({ backups: { [old(45)]: files, [old(31)]: files, [old(30)]: files, [old(29)]: files, notes: files } });
  const r = make(dirs, { say: () => {} });
  assert.equal(r.pruned, 2);
  assert.deepEqual(fs.readdirSync(dirs.out).sort(), [old(30), old(29), STAMP, 'README.md', 'notes'].sort());
  assert.equal(r.kept, 3);
  assert.deepEqual(planPrune([old(31), STAMP], NOW, 30, STAMP), [old(31)]);
  assert.deepEqual(planPrune([STAMP], NOW + 60 * 86400e3, 30, STAMP), [], 'the new folder is never pruned');
});

test('the restore rehearsal passes on a fresh backup and reads the old data/ layout too', () => {
  const dirs = setup();
  make(dirs, { say: () => {} });
  const q = quiet();
  const r = rehearse({ backupsDir: dirs.out, lockDir: dirs.lock, now: NOW + 2 * 60e3, say: q.say });
  assert.equal(r.ok, true, q.lines.join('\n'));
  assert.equal(r.stamp, STAMP);
  assert.ok(q.lines.every((l) => !l.includes(SECRET) && !/\.json\b/.test(l.replace(/(lock|inbox)\.json/g, ''))), 'counts, dates and pass/fail only');
  // the first hand-made layout: <stamp>/data/*.json and <stamp>/lock/*.json
  const older = setup();
  const st = '2026-11-06T2048Z', at = stampTime(st);
  writeAll(path.join(older.out, st, 'data'), { 'live.json': j(seal('x', AES, { t: at - 60e3 })), 'lock.json': j(LOCK) });
  writeAll(path.join(older.out, st, 'lock'), Object.fromEntries(fs.readdirSync(older.lock).map((n) => [n, fs.readFileSync(path.join(older.lock, n), 'utf8')])));
  assert.equal(rehearse({ backupsDir: older.out, lockDir: older.lock, now: at + 3600e3, say: () => {} }).ok, true);
});

test('planted faults the rehearsal must catch', () => {
  const at = NOW;
  const fresh = (mut) => {
    const dirs = setup();
    make(dirs, { say: () => {} });
    mut(path.join(dirs.out, STAMP), dirs);
    return rehearse({ backupsDir: dirs.out, lockDir: dirs.lock, now: at + 60e3, say: () => {} });
  };
  const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.equal(fresh(() => {}).ok, true, 'the control passes');
  // a t from the future, a t before the project, a t of 0
  for (const t of [at + 3600e3, Date.parse('2025-06-01T00:00:00Z'), 0]) {
    const r = fresh((d) => fs.writeFileSync(path.join(d, 'history.json'), j(seal('x', AES, { t }))));
    assert.deepEqual(failed(r), ['every t is sane (after 2026-01-01, not after the backup, not in the future)'], String(t));
  }
  // a truncated envelope; plaintext data
  assert.ok(failed(fresh((d) => fs.writeFileSync(path.join(d, 'live.json'), '{"lock":1,"t":1'))).includes('every data envelope parses'));
  assert.ok(failed(fresh((d) => fs.writeFileSync(path.join(d, 'live.json'), j({ pools: [] })))).includes('every data envelope parses'));
  // backed-up locks that differ from the repo's
  assert.deepEqual(failed(fresh((d) => fs.writeFileSync(path.join(d, 'lock.json'), j(newLockFile('other', 1000))))), ['lock.json equals the repo lock']);
  assert.deepEqual(failed(fresh((d) => fs.writeFileSync(path.join(d, 'lock', 'lock.json'), j(newLockFile('other', 1000))))), ['lock/lock.json equals the repo lock']);
  assert.deepEqual(failed(fresh((d) => fs.writeFileSync(path.join(d, 'lock', 'config.sealed.json'), j({ wallet: SECRET })))), ['every sealed lock file parses']);
  assert.deepEqual(failed(fresh((d) => fs.writeFileSync(path.join(d, 'lock', 'inbox.json'), j({ v: 1, x25519: crypto.randomBytes(32).toString('base64') })))), ['lock/inbox.json equals the repo inbox key']);
  // the newest folder is the one checked: a later, broken folder fails even when an older one is fine
  const dirs = setup();
  make(dirs, { say: () => {} });
  writeAll(path.join(dirs.out, '2026-11-07T0318Z'), { 'live.json': j({ pools: [] }) });
  assert.equal(rehearse({ backupsDir: dirs.out, lockDir: dirs.lock, now: at + 120e3, say: () => {} }).ok, false);
  // a stale newest backup, and no backup at all
  const stale = setup(); make(stale, { say: () => {} });
  assert.deepEqual(failed(rehearse({ backupsDir: stale.out, lockDir: stale.lock, now: at + 49 * 3600e3, say: () => {} })), ['newest backup is recent']);
  const none = setup();
  assert.equal(rehearse({ backupsDir: none.out, lockDir: none.lock, now: at, say: () => {} }).ok, false);
});

test('the backup never decrypts: no passphrase, no key derivation, no open()', () => {
  const src = fs.readFileSync(new URL('../scripts/backup.mjs', import.meta.url), 'utf8');
  const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
  assert.ok(!/\b(open|deriveKeys|unlock|openLock|inboxOpen|inboxKeys|openStore)\b/.test(imports));
  assert.ok(!/LOCK_PASSPHRASE|passphraseFrom/.test(src));
});
