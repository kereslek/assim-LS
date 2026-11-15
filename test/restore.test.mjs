// The restore drill and the guarded restore (scripts/restore.mjs): a made-up sealed backup passes the drill end
// to end (decrypted, in its shapes, rebuilt as the data branch, restored and started by the loop's own code,
// counts compared); each planted fault fails it (a corrupt envelope, the wrong key, a truncated file, a missing
// file, a stale backup, a broken shape, a time from the future, counts far from the live data); the restore is a
// dry run unless confirmed exactly, refuses while the loop runs, tags the old tip before it replaces the data
// branch, and stops when the branch moved. Throwaway lock (dummy passphrase), local bare remotes, made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initLock, readLock, unlock, seal, newLockFile } from '../lib/lock.mjs';
import { inboxSeal } from '../lib/inbox.mjs';
import { writeSealed } from '../lib/store.mjs';
import { serializeStore } from '../lib/snapshots.mjs';
import { stampOf } from '../scripts/backup.mjs';
import { drill, restore, restoreRefOk, SHAPES, confirmText, checkBackup, readFolder } from '../scripts/restore.mjs';
import { makeData } from '../tools/fixtures/make-fixture.mjs';

const DUMMY = 'restore test dummy passphrase, not a secret';
const ENV = { LOCK_PASSPHRASE: DUMMY };
const SECRET = '0xMADEUPfeedbeef00000000000000000000000001';
const NOW = Date.parse('2026-11-15T09:30:00Z');
const STAMP = stampOf(NOW - 20 * 60e3);
const H = 3600e3, D = 86400e3;
const G = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } }).trim();
const tmp = (p = 'lps-restore-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// one made-up lock for the whole file (the repo's lock dir), and its keys
const LOCK_DIR = tmp();
initLock({ dir: LOCK_DIR, passphrase: DUMMY, iterations: 1000 });
const KEYS = unlock(readLock(LOCK_DIR), DUMMY);
const PUB = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, 'inbox.json'), 'utf8')).x25519;
fs.writeFileSync(path.join(LOCK_DIR, 'config.sealed.json'), JSON.stringify(inboxSeal(JSON.stringify({ wallet: SECRET }), PUB)));

const row = (t, i) => ({ t, block: 1000 + i, sqrtPriceX96: 79228162514264337593543950336n + BigInt(i), tick: i, L: 10n ** 18n, fg0: BigInt(i + 1), fg1: BigInt(2 * i + 1), parked: 0.25 });
// made-up data in the docs/DATA.md shapes: `pools` pools, t a little before the stamp
function dataSet(pools = 3, t = NOW - 25 * 60e3) {
  const ids = Array.from({ length: pools }, (_, i) => `${SECRET.slice(0, -1)}${i}`);
  const live = { v: 1, t, phase: 0, build: 'made-up', next: t + 6 * 60e3, windows: ['24h', '7d', '30d'], health: { loop: { passes24h: 3, ok24h: 3, lastGapMin: 6, watchdogLast: null, recent: [[t - 12 * 60e3, 1], [t - 6 * 60e3, 1], [t, 1]] }, checks: [] },
    pools: ids.map((id) => ({ id, chain: 'ethereum', pair: 'MADE/UP', w: { '24h': null, '7d': null, '30d': null } })) };
  const day = Math.floor(t / D) * D;
  const history = { v: 1, t, health: [[t - H, 1, 1, 0]], pools: Object.fromEntries(ids.map((id) => [id, {
    h: [[t - 2 * H, 1.5, 2e18, null, 0.2], [t - H, 1.6, 2e18, 12.5, 0.21]], d: [[day - 2 * D, 1.4, null, null, 0.2], [day - D, 1.5, 40, 13000, 0.2]],
    y: [[day - 2 * D, 33, 'e'], [day - D, 41, 'x']], yv: [[11000, 'g'], [13000, 's']], yt: [[2e6, 'b'], [2.1e6, 'r']] }])) };
  const snapshots = { ...serializeStore(new Map(ids.map((id) => [id, { h: [row(t - 2 * H, 1), row(t - H, 2)], d: [row(day - D + 5 * 60e3, 3)] }]))), t, fix: 2 };
  const backtest = { v: 1, t, ticket: 1000, provisional: true, pools: {} };
  return { live, history, snapshots, backtest };
}
// a backup folder as backup.mjs makes it: the data files and lock.json at its root, the lock files under lock/
function backupFolder({ pools = 3, t, mut = null } = {}) {
  const root = tmp(), dir = path.join(root, STAMP), lock = path.join(dir, 'lock');
  const d = dataSet(pools, t);
  for (const [n, obj] of Object.entries({ 'live.json': d.live, 'history.json': d.history, 'snapshots.json': d.snapshots, 'backtest.json': d.backtest })) writeSealed(n, obj, KEYS.aes, { outDir: dir });
  fs.writeFileSync(path.join(dir, 'log.json'), JSON.stringify(seal(JSON.stringify({ v: 1, t: d.live.t, exit: 0, lines: ['made-up log line'], errors: 0, categories: {} }), KEYS.aes, { t: d.live.t })));
  fs.copyFileSync(path.join(LOCK_DIR, 'lock.json'), path.join(dir, 'lock.json'));
  fs.mkdirSync(lock);
  for (const n of fs.readdirSync(LOCK_DIR)) fs.copyFileSync(path.join(LOCK_DIR, n), path.join(lock, n));
  if (mut) mut(dir);
  return dir;
}
// the live data branch's files as a checkout holds them
function liveDir(pools = 3) { const dir = backupFolder({ pools, t: NOW - 5 * 60e3 }); return dir; }
const quiet = () => { const lines = []; return { say: (s) => lines.push(s), lines }; };
const run = async (dir, o = {}) => { const q = quiet(); const r = await drill({ dir, stamp: STAMP, lockDir: LOCK_DIR, liveDir: liveDir(), maxAgeH: 2, env: ENV, now: NOW, say: q.say, ...o }); return { ...r, lines: q.lines }; };
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const clean = (lines) => lines.every((l) => !l.includes(SECRET.slice(2, 14)) && !/made-up log line|MADE\/UP|wallet/.test(l));

test('a made-up backup passes the drill end to end, and the output is counts, ages and pass/fail only', async () => {
  const r = await run(backupFolder());
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.deepEqual(failed(r), []);
  assert.ok(r.checks.some((c) => /restored by the loop's own code/.test(c.name) && c.ok));
  assert.ok(r.checks.some((c) => /dry-run pass starts from it/.test(c.name) && c.ok));
  assert.ok(r.checks.some((c) => /counts within 25%/.test(c.name) && c.ok));
  assert.ok(r.lines.some((l) => /counts in the backup: live.json pools 3, history pools 3, history rows 18, days 2, snapshot pools 3, snapshot rows 9/.test(l)), r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /restore drill: pass/.test(l)));
  assert.ok(clean(r.lines), 'no ids, names or values in the output');
});

test('planted faults: a corrupt envelope, the wrong key, a truncated file, a missing file, a stale backup', async () => {
  const flip = (dir, n) => { const f = path.join(dir, n), e = JSON.parse(fs.readFileSync(f, 'utf8')); e.ct = (e.ct[0] === 'A' ? 'B' : 'A') + e.ct.slice(1); fs.writeFileSync(f, JSON.stringify(e)); };
  const other = unlock(newLockFile('another made-up passphrase', 1000), 'another made-up passphrase').aes;
  const cases = {
    'corrupt envelope': [(d) => flip(d, 'history.json'), /opens with the lock/],
    'wrong key': [(d) => writeSealed('live.json', dataSet().live, other, { outDir: d }), /opens with the lock/],
    'truncated file': [(d) => { const f = path.join(d, 'snapshots.json'), s = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, s.slice(0, s.length >> 1)); }, /sealed envelope/],
    'missing file': [(d) => fs.rmSync(path.join(d, 'backtest.json')), /every file is there/],
    'missing lock file': [(d) => fs.rmSync(path.join(d, 'lock', 'inbox.json')), /every file is there/],
    'a stray file': [(d) => fs.writeFileSync(path.join(d, 'extra.json'), '{}'), /no unknown files/],
    'a lock that is not the repo\'s': [(d) => fs.writeFileSync(path.join(d, 'lock.json'), JSON.stringify(newLockFile('x', 1000))), /lock.json equals the repo lock/],
    'settings that do not open': [(d) => fs.writeFileSync(path.join(d, 'lock', 'config.sealed.json'), JSON.stringify(inboxSeal('x', Buffer.alloc(32, 7).toString('base64')))), /config.sealed.json opens/],
    'a broken shape': [(d) => { const h = dataSet().history; Object.values(h.pools)[0].yv.pop(); writeSealed('history.json', h, KEYS.aes, { outDir: d }); }, /docs\/DATA.md shape/],
    'a row from the future': [(d) => { const h = dataSet().history; Object.values(h.pools)[0].h.push([NOW + 5 * H, 1, 1, 1, 0.1]); writeSealed('history.json', h, KEYS.aes, { outDir: d }); }, /docs\/DATA.md shape/],
    'a file sealed after the backup': [(d) => writeSealed('backtest.json', { ...dataSet().backtest, t: NOW + H }, KEYS.aes, { outDir: d }), /every time is sane/],
    'a store the scan would not read': [(d) => writeSealed('snapshots.json', { ...dataSet().snapshots, fix: 1 }, KEYS.aes, { outDir: d }), /docs\/DATA.md shape/],
  };
  for (const [name, [mut, re]] of Object.entries(cases)) {
    const r = await run(backupFolder({ mut }));
    assert.equal(r.ok, false, `not caught: ${name}`);
    assert.ok(failed(r).some((c) => re.test(c)), `${name}: ${failed(r).join(' | ')}`);
    assert.ok(clean(r.lines), `${name}: the output stays clean`);
  }
  // a stale backup: the same folder three hours later
  const stale = await run(backupFolder(), { now: NOW + 3 * H });
  assert.deepEqual(failed(stale).filter((c) => !/counts within/.test(c)), ['the backup is recent (at most 2 h old)']);
  // counts far from the live data branch's
  const far = await run(backupFolder(), { liveDir: liveDir(8) });
  assert.deepEqual(failed(far), ['counts within 25% of the live data branch, and the backup not newer than it']);
  // the wrong passphrase stops the drill before anything is read
  await assert.rejects(drill({ dir: backupFolder(), stamp: STAMP, lockDir: LOCK_DIR, env: { LOCK_PASSPHRASE: 'wrong' }, now: NOW, say: () => {} }), /wrong passphrase/);
});

test('the shapes accept the page fixtures\' made-up data', () => {
  const d = makeData({ now: NOW });
  for (const [n, x] of [['live.json', d.live], ['history.json', d.history], ['backtest.json', d.backtest]]) assert.deepEqual(SHAPES[n](x), [], n);
});

test('the old hand-made layout (<stamp>/data/) reads too', () => {
  const dir = backupFolder(), data = path.join(dir, 'data');
  fs.mkdirSync(data);
  for (const n of fs.readdirSync(dir)) if (n.endsWith('.json')) fs.renameSync(path.join(dir, n), path.join(data, n));
  const c = checkBackup({ folder: readFolder(dir), stamp: STAMP, repoLock: readLock(LOCK_DIR), keys: KEYS, now: NOW });
  assert.equal(c.ok, true, c.checks.filter((x) => !x.ok).map((x) => x.name).join(' | '));
});

// ---- the guarded restore on a made-up remote ---------------------------------------------------------------
function remoteWorld() {
  const root = tmp(), bare = path.join(root, 'remote.git'), work = path.join(root, 'work');
  G(root, 'init', '-q', '--bare', '-b', 'main', bare);
  G(root, 'init', '-q', '-b', 'main', work);
  fs.writeFileSync(path.join(work, 'README.md'), 'made-up\n'); G(work, 'add', '-A'); G(work, 'commit', '-q', '-m', 'main');
  G(work, 'remote', 'add', 'origin', bare); G(work, 'push', '-q', 'origin', 'main');
  // the current (bad) data branch: one commit with no parent, made-up files
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify(seal('made-up bad pass', KEYS.aes, { t: NOW - 60e3 })));
  const tree = execFileSync('git', ['mktree'], { cwd: work, encoding: 'utf8', input: `100644 blob ${G(work, 'hash-object', '-w', bad)}\tlive.json\n` }).trim();
  G(work, 'push', '-q', 'origin', `${G(work, 'commit-tree', tree, '-m', 'bad')}:refs/heads/data`);
  const refs = () => Object.fromEntries(G(bare, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).map((l) => l.split(' ')));
  return { bare, work, refs };
}
const restoreArgs = (W, o = {}) => ({ dir: backupFolder(), stamp: STAMP, lockDir: LOCK_DIR, repo: W.work, remote: 'origin', env: ENV, now: NOW, active: 0, say: () => {}, ...o });

test('restore: a dry run builds everything and pushes nothing; a real one needs the exact confirmation and an idle loop', () => {
  const W = remoteWorld(), before = W.refs(), q = quiet();
  const r = restore(restoreArgs(W, { say: q.say }));
  assert.equal(r.dryRun, true);
  assert.deepEqual(W.refs(), before);
  assert.ok(q.lines.some((l) => /dry run; would tag the data branch's tip as data-pre-restore-20261115T0930Z, then replace the data branch/.test(l)), q.lines.join('\n'));
  assert.ok(clean(q.lines));
  for (const confirm of ['', 'RESTORE', `restore ${STAMP}`, `RESTORE ${STAMP} `, `RESTORE ${stampOf(NOW)}`]) {
    assert.throws(() => restore(restoreArgs(W, { apply: true, confirm })), /confirmation does not match/, JSON.stringify(confirm));
  }
  for (const active of [1, null]) assert.throws(() => restore(restoreArgs(W, { apply: true, confirm: confirmText(STAMP), active })), /loop run is queued or in progress/);
  assert.throws(() => restore(restoreArgs(W, { dir: backupFolder({ mut: (d) => fs.rmSync(path.join(d, 'log.json')) }), apply: true, confirm: confirmText(STAMP) })), /failed its checks/);
  assert.deepEqual(W.refs(), before, 'nothing pushed by any refusal');
});

test('restore for real (made-up remote only): the old tip is tagged and read back first, then the data branch is the backup', () => {
  const W = remoteWorld(), before = W.refs(), q = quiet();
  const r = restore(restoreArgs(W, { apply: true, confirm: confirmText(STAMP), say: q.say, remote: W.bare }));
  const after = W.refs();
  assert.equal(r.dryRun, false, q.lines.join('\n'));
  assert.equal(after['refs/tags/data-pre-restore-20261115T0930Z'], before['refs/heads/data'], 'the old tip is kept under the tag');
  assert.equal(after['refs/heads/main'], before['refs/heads/main']);
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'refs/tags/data-pre-restore-20261115T0930Z'].sort());
  assert.equal(G(W.bare, 'rev-list', '--count', 'refs/heads/data'), '1', 'one commit with no parent');
  const files = G(W.bare, 'ls-tree', '--name-only', 'refs/heads/data').split('\n').sort();
  assert.deepEqual(files, ['backtest.json', 'history.json', 'live.json', 'lock.json', 'log.json', 'snapshots.json']);
  const dir = backupFolder();   // same lock, so the files are byte for byte the backup's (checked on one)
  assert.equal(G(W.bare, 'cat-file', '-p', 'refs/heads/data:lock.json'), fs.readFileSync(path.join(dir, 'lock.json'), 'utf8').trim());
  assert.ok(q.lines.some((l) => /read back with the lock \(5 files\): yes; pushed: yes/.test(l)));
});

test('planted fault: a data branch that moved after the check is never overwritten (the lease stops it)', () => {
  const W = remoteWorld();
  const args = restoreArgs(W, { apply: true, confirm: confirmText(STAMP), remote: W.bare });
  // another publish lands between the tag and the push: simulated by a remote that moves on ls-remote
  const other = path.join(path.dirname(W.work), 'other');
  G(path.dirname(W.work), 'clone', '-q', '--branch', 'data', W.bare, other);
  fs.writeFileSync(path.join(other, 'live.json'), JSON.stringify(seal('made-up newer pass', KEYS.aes, { t: NOW })));
  G(other, 'commit', '-qam', 'newer');
  const hook = path.join(W.bare, 'hooks', 'post-receive');
  fs.writeFileSync(hook, `#!/bin/sh\nunset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\nwhile read old new ref; do case "$ref" in refs/tags/*) (cd "${other}" && git push -q origin HEAD:data) >/dev/null 2>&1;; esac; done\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  const moved = () => G(W.bare, 'rev-parse', 'refs/heads/data');
  const tip0 = moved();
  assert.throws(() => restore(args), /data branch moved after it was tagged/);
  assert.notEqual(moved(), tip0, 'the planted publish did land');
  assert.notEqual(G(W.bare, 'rev-parse', 'refs/heads/data'), G(W.bare, 'rev-parse', 'refs/tags/data-pre-restore-20261115T0930Z'), 'the newer publish stays');
});

test('restore pushes only the data branch and its pre-restore tags', () => {
  const S = 'c'.repeat(40);
  assert.ok(restoreRefOk(`${S}:refs/heads/data`) && restoreRefOk(`${S}:refs/tags/data-pre-restore-20261115T0930Z`) && restoreRefOk(`${S}:refs/tags/data-pre-restore-20261115T0930Z-2`));
  for (const bad of [`${S}:refs/heads/main`, `${S}:refs/heads/backup`, `${S}:refs/heads/claude/ecstatic-dirac-wkrqja`, `+${S}:refs/heads/data`, `:refs/heads/data`,
    `${S}:refs/tags/backup-pre-trim-20261201`, `${S}:refs/tags/data-pre-restore-x`, `${S}:data`, `${S}:refs/heads/data\n${S}:refs/heads/main`]) assert.ok(!restoreRefOk(bad), bad);
  const src = fs.readFileSync(new URL('../scripts/restore.mjs', import.meta.url), 'utf8');
  assert.ok(!/console\.log\([^)]*(open\(|\.pools|JSON\.stringify)/.test(src), 'nothing decrypted is ever printed');
});
