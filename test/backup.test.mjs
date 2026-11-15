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
import { execFileSync } from 'node:child_process';
import { stampOf, stampTime, planPrune, makeBackup, rehearse, fileProblem, planRetention, RETENTION, dayKey, weekKey, pushDaily, BACKUP_BRANCH } from '../scripts/backup.mjs';

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

// ---- retention: 48 hours of every copy, the day's first for 90 days, the week's first for a year ----------------
const H = 3600e3, D = 86400e3;
// a year and a half of copies: about every 50 minutes for the last 3 days, before that 3 a day (00:10, 09:00, 17:30)
function copies(now = NOW) {
  const out = [];
  for (let t = now - 3 * D; t <= now; t += 50 * 60e3) out.push(stampOf(t));
  for (let d = 3; d < 540; d++) { const day = Math.floor((now - d * D) / D) * D; for (const m of [10, 540, 1050]) out.push(stampOf(day + m * 60e3)); }
  return [...new Set(out)].sort();
}

test('retention: every copy of the last 48 hours, each day\'s first for 90 days, each week\'s first for a year, the newest', () => {
  const all = copies(), p = planRetention(all, NOW);
  assert.deepEqual([...p.keep, ...p.drop].sort(), all, 'every folder is kept or dropped');
  assert.ok(p.keep.every((s) => !p.drop.includes(s)));
  const firstDay = new Map(), firstWeek = new Map();
  for (const s of all) { const t = stampTime(s); if (!firstDay.has(dayKey(t))) firstDay.set(dayKey(t), s); if (!firstWeek.has(weekKey(t))) firstWeek.set(weekKey(t), s); }
  for (const s of all) {
    const t = stampTime(s), age = NOW - t;
    const dayFirst = firstDay.get(dayKey(t)) === s, weekFirst = firstWeek.get(weekKey(t)) === s;
    const want = age <= 48 * H || (dayFirst && age <= 90 * D) || (weekFirst && age <= 365 * D) || s === all.at(-1);
    assert.equal(p.keep.includes(s), want, s);
  }
  // about 58 copies of the last 48 hours, 90 days, 39-40 weeks past the 90 days
  assert.ok(p.hourly.length >= 57 && p.hourly.length <= 59, String(p.hourly.length));
  assert.ok(p.daily.length >= 90 && p.daily.length <= 91);
  const weeksOnly = p.weekly.filter((s) => !p.daily.includes(s) && !p.hourly.includes(s));
  assert.ok(weeksOnly.length >= 38 && weeksOnly.length <= 41, String(weeksOnly.length));
  assert.ok(p.keep.every((s) => NOW - stampTime(s) <= 365 * D), 'nothing older than a year');
  // weeks start on Monday 00:00 UTC
  assert.equal(weekKey(Date.parse('2026-11-16T00:00:00Z')), weekKey(Date.parse('2026-11-22T23:59:00Z')));
  assert.notEqual(weekKey(Date.parse('2026-11-15T23:59:00Z')), weekKey(Date.parse('2026-11-16T00:00:00Z')));
});

test('retention only ever lets folders go: what one plan drops, a later plan never keeps', () => {
  const all = copies();
  let kept = new Set(all);
  for (let t = NOW; t <= NOW + 400 * D; t += 31 * H) {
    const p = planRetention([...kept], t);
    for (const s of p.keep) assert.ok(kept.has(s));
    const again = planRetention(all, t);   // the plan over everything ever made agrees with the plan over what was kept
    assert.deepEqual(again.keep, p.keep, new Date(t).toISOString());
    kept = new Set(p.keep);
  }
  assert.deepEqual([...kept], [all.at(-1)], 'after a year without new copies only the newest stays');
  assert.throws(() => planRetention(all, NOW, { ...RETENTION, weeklyDays: 30 }), /bad retention/);
  assert.deepEqual(planRetention(['README.md', 'monthly'], NOW).keep, [], 'other entries are not the plan\'s');
});

test('make --no-prune stages a copy and deletes nothing', () => {
  const dirs = setup({ backups: { [stampOf(NOW - 400 * D)]: { 'live.json': j(seal('x', AES, { t: NOW - 400 * D })) } } });
  const r = make(dirs, { prune: false, say: () => {} });
  assert.equal(r.pruned, 0);
  assert.ok(fs.existsSync(path.join(dirs.out, stampOf(NOW - 400 * D))));
});

// ---- the day's first copy on the backup branch, from git objects only ------------------------------------------
const G = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } }).trim();
function branchWorld(stamps) {
  const root = tmp(), bare = path.join(root, 'remote.git'), w = path.join(root, 'w');
  G(root, 'init', '-q', '--bare', '-b', 'main', bare);
  G(root, 'init', '-q', '-b', 'backup', w);
  fs.writeFileSync(path.join(w, 'README.md'), 'made-up backups\n');
  for (const s of stamps) { writeAll(path.join(w, s, 'lock'), { 'lock.json': '{"made":"up"}' }); fs.writeFileSync(path.join(w, s, 'live.json'), j(seal(s, AES, { t: stampTime(s) }))); }
  G(w, 'add', '-A'); G(w, 'commit', '-q', '-m', 'made-up backups');
  G(w, 'push', '-q', bare, 'backup');
  const clone = path.join(root, 'clone');
  G(root, 'clone', '-q', '--depth=1', '--branch', 'backup', 'file://' + bare, clone);
  return { root, bare, clone };
}
const stageAt = (stamp) => { const dirs = setup(); makeBackup({ dataDir: dirs.data, lockDir: dirs.lock, outDir: dirs.out, stamp, prune: false, say: () => {} }); return dirs.out; };

test('the day\'s first copy lands on the backup branch as one commit; the plan\'s drops go; kept folders are the same objects', () => {
  const old = ['2025-10-01T0010Z', '2026-07-01T0010Z', '2026-07-01T0900Z', '2026-11-04T0010Z', '2026-11-04T0900Z', '2026-11-06T0010Z', '2026-11-06T0300Z'];
  const W = branchWorld(old), before = G(W.bare, 'rev-parse', BACKUP_BRANCH), q = quiet();
  const objs = Object.fromEntries(old.map((s) => [s, G(W.bare, 'rev-parse', `${BACKUP_BRANCH}:${s}`)]));
  const r = pushDaily({ repo: W.clone, stageDir: stageAt(STAMP), stamp: STAMP, say: q.say });
  assert.equal(r.added, true, q.lines.join('\n'));
  assert.equal(G(W.bare, 'rev-parse', `${BACKUP_BRANCH}^`), before, 'a normal commit on the old tip');
  const top = G(W.bare, 'ls-tree', '--name-only', BACKUP_BRANCH).split('\n');
  assert.deepEqual(top.sort(), ['2026-07-01T0010Z', '2026-11-04T0010Z', '2026-11-06T0010Z', '2026-11-06T0300Z', STAMP, 'README.md'].sort());
  for (const s of ['2026-07-01T0010Z', '2026-11-04T0010Z', '2026-11-06T0010Z', '2026-11-06T0300Z']) assert.equal(G(W.bare, 'rev-parse', `${BACKUP_BRANCH}:${s}`), objs[s]);
  assert.equal(G(W.bare, 'cat-file', '-p', `${BACKUP_BRANCH}:${STAMP}/lock/lock.json`), JSON.stringify(LOCK, null, 1));
  assert.ok(q.lines.every((l) => !/\.json/.test(l) && !l.includes(SECRET)), 'counts and dates only');
  // a second copy the same UTC day is not put on the branch (it is the hourly tier's)
  const later = stampOf(NOW + 3 * H), q2 = quiet();
  assert.equal(pushDaily({ repo: W.clone, stageDir: stageAt(later), stamp: later, say: q2.say }).added, false);
  assert.equal(G(W.bare, 'ls-tree', '--name-only', BACKUP_BRANCH).split('\n').length, 6);
});

test('planted faults: a push that came first is never overwritten; a dry run pushes nothing; no staged copy refuses', () => {
  const W = branchWorld(['2026-11-05T0010Z']);
  const other = path.join(W.root, 'other');
  G(W.root, 'clone', '-q', '--branch', 'backup', W.bare, other);
  writeAll(path.join(other, '2026-11-06T0010Z'), { 'live.json': '{"lock":1}' });
  G(other, 'add', '-A'); G(other, 'commit', '-q', '-m', 'made-up'); G(other, 'push', '-q', 'origin', 'backup');
  const mid = G(W.bare, 'rev-parse', BACKUP_BRANCH);
  // the clone's own tip is stale: pushDaily fetches the newest tip first and builds on it
  const r = pushDaily({ repo: W.clone, stageDir: stageAt(STAMP), stamp: STAMP, say: () => {}, waitMs: 1 });
  assert.equal(r.added, true);
  assert.equal(G(W.bare, 'rev-parse', `${BACKUP_BRANCH}^`), mid, 'built on the newer tip');
  assert.ok(G(W.bare, 'ls-tree', '--name-only', BACKUP_BRANCH).includes('2026-11-06T0010Z'));
  const W2 = branchWorld(['2026-11-05T0010Z']), tip2 = G(W2.bare, 'rev-parse', BACKUP_BRANCH);
  assert.equal(pushDaily({ repo: W2.clone, stageDir: stageAt(STAMP), stamp: STAMP, dryRun: true, say: () => {} }).dryRun, true);
  assert.equal(G(W2.bare, 'rev-parse', BACKUP_BRANCH), tip2);
  assert.throws(() => pushDaily({ repo: W2.clone, stageDir: tmp(), stamp: STAMP, say: () => {} }), /missing staged copy/);
});
