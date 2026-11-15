// The backup branch's history trim (tools/backup-trim.mjs): the folders that stay are exactly planRetention's
// (48 hours, the day's first for 90 days, the week's first for a year, the newest), the rules a plan must keep
// (each with a planted fault that breaks it), that only the backup branch and its pre-trim tags are ever pushed
// or deleted, and a whole run on made-up repositories: a dry run changes nothing, a real one rewrites the backup
// branch only, after its old tip is tagged, then deletes all but the newest 2 pre-trim tags; a backup pushed
// meanwhile stops it. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planTrim, planProblems, refspecOk, pushArgs, tagsToPrune, trim, BRANCH, KEEP_TAGS } from './backup-trim.mjs';
import { stampOf, stampTime, planRetention, RETENTION, DAY } from '../scripts/backup.mjs';

const NOW = Date.parse('2026-12-01T03:47:00Z');      // the monthly run
const H = 3600e3;
// `days` days of backups: the day's first at 00:10 and two more (09:00, 17:30), and the last 3 days about every 50 min
function history(days = 140, now = NOW) {
  const out = [];
  for (let d = 0; d < days; d++) { const day = Math.floor((now - d * DAY) / DAY) * DAY; for (const m of [10, 540, 1050]) if (day + m * 60e3 <= now) out.push(stampOf(day + m * 60e3)); }
  for (let t = now - 3 * DAY; t <= now; t += 50 * 60e3) out.push(stampOf(t));
  return [...new Set(out)].sort();
}
// the tip as the daily job leaves it: planRetention applied at every backup since the first
const tipOf = (all, now = NOW) => planRetention(all, now).keep;
const input = (all = history()) => ({ stamps: all, tip: [...tipOf(all), 'README.md'], now: NOW, policy: RETENTION });
const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const quiet = () => { const lines = []; return { say: (s) => lines.push(s), lines }; };

test('the plan keeps planRetention\'s folders at the top; the rest leaves the history', () => {
  const all = history(), inp = input(all), p = planTrim(inp);
  assert.deepEqual(planProblems(p, inp), []);
  assert.deepEqual(p.keep, planRetention(all, NOW).keep);
  assert.deepEqual(p.dropTip, []);
  assert.deepEqual(p.back, []);
  assert.equal(p.dropHistory.length + p.keep.length, all.length);
  assert.ok(p.keep.every((s) => stampTime(s) >= NOW - 365 * DAY));
  const old = p.keep.filter((s) => stampTime(s) < NOW - 90 * DAY);
  assert.ok(old.length >= 6 && old.every((s) => planRetention(all, NOW).weekly.includes(s)), 'past 90 days: the weeks\' firsts only');
  assert.ok(p.keep.includes(history().at(-1)), 'the newest stays');
});

test('a tip from the first design (30 days, monthly/) is folded into the plan: kept folders come back to the top', () => {
  const all = history(140);
  const oldTip = all.filter((s) => stampTime(s) >= NOW - 30 * DAY);   // the old daily job kept 30 days
  const inp = { stamps: all, tip: [...oldTip, 'README.md', 'monthly'], now: NOW, policy: RETENTION }, p = planTrim(inp);
  assert.deepEqual(planProblems(p, inp), []);
  assert.ok(p.back.length > 50, 'days 30 to 90 and the weeks before come back');
  assert.ok(p.dropTip.length > 0, 'the extra copies of each day past 48 hours leave the tip');
});

test('planted faults: each broken plan is caught by the rules', () => {
  const all = history(), inp = input(all), good = planTrim(inp);
  const recent = good.keep.filter((s) => NOW - stampTime(s) <= 48 * H);
  const dayFirst = good.keep.find((s) => NOW - stampTime(s) > 10 * DAY && NOW - stampTime(s) < 80 * DAY);
  const weekOnly = good.keep.find((s) => NOW - stampTime(s) > 100 * DAY);
  const notFirst = all.find((s) => NOW - stampTime(s) > 5 * DAY && NOW - stampTime(s) < 80 * DAY && !good.keep.includes(s));
  const tooOld = all.find((s) => NOW - stampTime(s) > 120 * DAY && !good.keep.includes(s));
  const without = (p, s) => ({ ...p, keep: p.keep.filter((x) => x !== s), dropHistory: [...p.dropHistory, s].sort() });
  const plus = (p, s) => ({ ...p, keep: [...p.keep, s].sort(), dropHistory: p.dropHistory.filter((x) => x !== s) });
  const faults = {
    'a folder of the last 48 hours dropped': without(good, recent[3]),
    'the newest dropped': without(good, good.keep.at(-1)),
    "a day's first dropped": without(good, dayFirst),
    "a week's first dropped": without(good, weekOnly),
    "a folder that is not its day's first kept": plus(good, notFirst),
    'an old non-first folder kept': plus(good, tooOld),
    'a folder lost (neither kept nor dropped)': { ...good, dropHistory: good.dropHistory.slice(1) },
    'a folder kept and dropped': { ...good, dropHistory: [...good.dropHistory, good.keep[0]] },
    'a made-up folder kept': { ...good, keep: [...good.keep, '2027-01-01T0317Z'] },
  };
  for (const [name, p] of Object.entries(faults)) assert.ok(planProblems(p, inp).length > 0, `not caught: ${name}`);
});

test('pushes: only the backup branch (with a lease on its old tip), a pre-trim tag, or deleting a pre-trim tag', () => {
  assert.ok(refspecOk(`${SHA}:${BRANCH}`));
  assert.ok(refspecOk(`${SHA}:refs/tags/backup-pre-trim-20261201`) && refspecOk(`${SHA}:refs/tags/backup-pre-trim-20261201-2`));
  assert.ok(refspecOk(':refs/tags/backup-pre-trim-20261101'));
  for (const bad of [`${SHA}:refs/heads/main`, `${SHA}:refs/heads/data`, `${SHA}:refs/heads/gh-pages`, `${SHA}:refs/heads/claude/x`, `+${SHA}:${BRANCH}`,
    `${SHA}:backup`, `${SHA}:refs/heads/backup2`, `${SHA}:refs/heads/backup/x`, `:${BRANCH}`, ':refs/heads/data', ':refs/tags/v1', ':refs/tags/data-pre-restore-20261115T0900Z',
    `${SHA}:refs/tags/v1`, `${SHA}:refs/tags/backup-pre-trim-x`, 'refs/heads/*:refs/heads/*', `HEAD:${BRANCH}`, `${SHA}:${BRANCH} ${SHA}:refs/heads/main`, '--all', '--mirror',
    `${SHA}:refs/heads/backup\n${SHA}:refs/heads/main`, ':refs/tags/backup-pre-trim-20261101\n:refs/heads/backup']) {
    assert.ok(!refspecOk(bad), `accepted: ${bad}`);
    assert.throws(() => pushArgs('origin', bad, SHA2), /refusing/);
  }
  assert.throws(() => pushArgs('origin', `${SHA}:${BRANCH}`), /lease/);
  assert.deepEqual(pushArgs('origin', `${SHA}:${BRANCH}`, SHA2), ['push', '--porcelain', `--force-with-lease=${BRANCH}:${SHA2}`, 'origin', `${SHA}:${BRANCH}`]);
  assert.deepEqual(pushArgs('origin', ':refs/tags/backup-pre-trim-20261101'), ['push', '--porcelain', 'origin', ':refs/tags/backup-pre-trim-20261101']);
});

test('tag pruning keeps the newest 2 by date (a second trim the same day counts as newer); never another tag', () => {
  const t = (x) => `refs/tags/backup-pre-trim-${x}`;
  assert.equal(KEEP_TAGS, 2);
  assert.deepEqual(tagsToPrune([t('20261201'), t('20261101'), t('20270101')]), [t('20261101')]);
  assert.deepEqual(tagsToPrune([t('20261201-10'), t('20261201-2'), t('20261201'), t('20261101')]), [t('20261101'), t('20261201')]);
  assert.deepEqual(tagsToPrune([t('20261201'), 'refs/tags/v1', 'refs/heads/backup']), []);
  assert.deepEqual(tagsToPrune([t('20261201')]), []);
});

// ---- a whole run on made-up repositories -------------------------------------------------------------------
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } }).trim();
const refs = (bare) => Object.fromEntries(sh(bare, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).map((l) => l.split(' ')));
// a bare "remote" with main, data, gh-pages and two older pre-trim tags, and a backup branch made the way the
// backup job makes it: one commit per backup, each adding its folder and dropping what planRetention lets go
function world(days = 110) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-trim-')), bare = path.join(root, 'remote.git'), w = path.join(root, 'work');
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', w);
  fs.writeFileSync(path.join(w, 'README.md'), 'made-up\n'); sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', 'main');
  for (const b of ['data', 'gh-pages']) { sh(w, 'checkout', '-q', '--orphan', b); sh(w, 'rm', '-rq', '--cached', '.'); fs.writeFileSync(path.join(w, b + '.json'), '{"lock":1,"t":1}'); sh(w, 'add', b + '.json'); sh(w, 'commit', '-q', '-m', b); fs.rmSync(path.join(w, b + '.json')); }
  sh(w, 'checkout', '-q', '--orphan', 'backup'); sh(w, 'rm', '-rq', '--cached', '.');
  for (const f of fs.readdirSync(w)) if (f !== '.git') fs.rmSync(path.join(w, f), { recursive: true });
  fs.writeFileSync(path.join(w, 'README.md'), 'made-up backups\n');
  const all = history(days).filter((s, i, a) => stampTime(s) < NOW - 3 * DAY || i === a.length - 1 || i % 6 === 0);   // fewer commits: same plan shape
  for (const s of all) {
    fs.mkdirSync(path.join(w, s, 'lock'), { recursive: true });
    fs.writeFileSync(path.join(w, s, 'live.json'), JSON.stringify({ lock: 1, t: stampTime(s), iv: 'x', ct: s }));
    fs.writeFileSync(path.join(w, s, 'lock', 'lock.json'), '{"made":"up"}');
    const keep = new Set(planRetention(fs.readdirSync(w), stampTime(s)).keep);
    for (const e of fs.readdirSync(w)) if (stampTime(e) != null && !keep.has(e)) fs.rmSync(path.join(w, e), { recursive: true });
    sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', `Backup ${s}`);
  }
  sh(w, 'push', '-q', bare, 'main', 'data', 'gh-pages', 'backup');
  const first = sh(w, 'rev-list', '--max-parents=0', 'backup');
  for (const tg of ['backup-pre-trim-20261001', 'backup-pre-trim-20261101']) sh(w, 'push', '-q', bare, `${first}:refs/tags/${tg}`);
  const clone = path.join(root, 'clone');
  sh(root, 'clone', '-q', '--branch', 'backup', bare, clone);
  return { root, bare, clone, all };
}
const reach = (repo, ref) => new Set(sh(repo, 'log', '--format=', '--name-only', ref).split('\n').map((l) => l.split('/')[0]).filter((x) => /^\d{4}-/.test(x)));

test('a dry run plans, builds and checks the new commit and pushes nothing', () => {
  const W = world(), before = refs(W.bare), q = quiet();
  const r = trim({ repo: W.clone, now: NOW, say: q.say });
  assert.equal(r.pushed, false);
  assert.deepEqual(refs(W.bare), before, 'the remote is untouched');
  assert.ok(q.lines.some((l) => /dry run; pushed: no; would delete 1 older pre-trim tag/.test(l)), q.lines.join('\n'));
  assert.ok(q.lines.every((l) => !/[0-9a-f]{40}/.test(l)), 'no object ids in the output');
  assert.deepEqual(r.plan.keep, planRetention(W.all, NOW).keep);
});

test('a real run: the old tip is tagged first, then only the backup branch is rewritten, then the oldest tag goes', () => {
  const W = world(), before = refs(W.bare), q = quiet();
  const oldTip = before[BRANCH];
  const r = trim({ repo: W.clone, now: NOW, apply: true, say: q.say });
  const after = refs(W.bare);
  assert.equal(r.pushed, true, q.lines.join('\n'));
  for (const k of Object.keys(before)) if (k !== BRANCH && k !== 'refs/tags/backup-pre-trim-20261001') assert.equal(after[k], before[k], `${k} untouched`);
  assert.equal(after['refs/tags/backup-pre-trim-20261201'], oldTip, 'the pre-trim tag is the old tip');
  assert.ok(!('refs/tags/backup-pre-trim-20261001' in after), 'the oldest pre-trim tag is deleted');
  assert.deepEqual(Object.keys(after).filter((k) => k.startsWith('refs/tags/')).sort(), ['refs/tags/backup-pre-trim-20261101', 'refs/tags/backup-pre-trim-20261201']);
  assert.equal(sh(W.bare, 'rev-list', '--count', BRANCH), '1');
  const top = sh(W.bare, 'ls-tree', '--name-only', BRANCH).split('\n');
  assert.deepEqual(top.filter((s) => stampTime(s) != null), r.plan.keep);
  assert.ok(top.includes('README.md'));
  for (const s of r.plan.keep) assert.equal(sh(W.bare, 'rev-parse', `${BRANCH}:${s}`), sh(W.bare, 'rev-parse', `${oldTip}:${s}`), `${s} is the same object`);
  const kept = reach(W.bare, BRANCH);
  for (const s of r.plan.dropHistory) assert.ok(!kept.has(s), `${s} left the history`);
  assert.ok(r.plan.dropHistory.length > 50);
  // a second run the same day has nothing left to drop
  sh(W.clone, 'fetch', '-q', '--update-head-ok', 'origin', `+${BRANCH}:${BRANCH}`);
  const again = trim({ repo: W.clone, now: NOW + 60e3, apply: true, say: quiet().say });
  assert.equal(again.nothing, true);
  assert.equal(refs(W.bare)[BRANCH], after[BRANCH]);
});

test('planted fault: a backup pushed while the trim runs is never overwritten (the lease stops the push)', () => {
  const W = world(40), other = path.join(W.root, 'other');
  sh(W.root, 'clone', '-q', '--branch', 'backup', W.bare, other);
  fs.mkdirSync(path.join(other, '2026-12-01T0346Z')); fs.writeFileSync(path.join(other, '2026-12-01T0346Z', 'live.json'), '{"lock":1}');
  sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'Backup 2026-12-01T0346Z'); sh(other, 'push', '-q', 'origin', 'backup');
  const mid = refs(W.bare)[BRANCH], tags = Object.keys(refs(W.bare)).filter((k) => k.includes('pre-trim'));
  assert.throws(() => trim({ repo: W.clone, now: NOW, apply: true, say: quiet().say }));
  assert.equal(refs(W.bare)[BRANCH], mid, 'the newer backup stays');
  for (const k of tags) assert.ok(k in refs(W.bare), 'no tag deleted when the branch push failed');
});
