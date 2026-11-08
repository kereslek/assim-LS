// The backup branch's history trim (tools/backup-trim.mjs): which folders stay, the rules a plan must keep
// (each with a planted fault that breaks it), that only the backup branch and its pre-trim tag are ever
// pushed, and a whole run on made-up repositories: a dry run changes nothing, a real one rewrites the backup
// branch only, after its old tip is tagged, and a backup pushed meanwhile stops it. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planTrim, planProblems, refspecOk, pushArgs, trim, BRANCH } from './backup-trim.mjs';
import { stampOf, stampTime, DAY } from '../scripts/backup.mjs';

const NOW = Date.parse('2026-12-01T03:47:00Z');      // the monthly run, 30 min after the daily backup
const TODAY = '2026-12-01T0317Z';
// 75 days of backups: the daily one at 03:17, and a second one (a deploy's) every third day
function history(days = 75) {
  const out = [];
  for (let d = days - 1; d >= 0; d--) {
    const t = Date.parse('2026-12-01T03:17:00Z') - d * DAY;
    out.push(stampOf(t));
    if (d % 3 === 1) out.push(stampOf(t + 9 * 3600e3));
  }
  return out.sort();
}
const inWindow = (all, now = NOW, days = 30) => all.filter((s) => stampTime(s) >= now - days * DAY);
const input = (all = history()) => ({ stamps: all, tip: [...inWindow(all), 'README.md'], now: NOW, days: 30 });
const SHA = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const quiet = () => { const lines = []; return { say: (s) => lines.push(s), lines }; };

test('the plan keeps the last 30 days at the top and each month\'s first backup; the rest leaves the history', () => {
  const all = history(), inp = input(all), p = planTrim(inp);
  assert.deepEqual(planProblems(p, inp), []);
  assert.deepEqual(p.daily, inWindow(all));
  assert.ok(p.daily.includes(TODAY), "today's folder stays");
  assert.deepEqual(p.monthly, ['2026-09-18T0317Z', '2026-10-01T0317Z', '2026-11-01T0317Z', '2026-12-01T0317Z']);
  assert.deepEqual(p.dropTip, []);
  assert.equal(p.dropHistory.length + new Set([...p.daily, ...p.monthly]).size, all.length);
  assert.ok(p.dropHistory.every((s) => !p.daily.includes(s) && !p.monthly.includes(s)));
  assert.ok(!p.dropHistory.includes('2026-10-01T0317Z') && p.dropHistory.includes('2026-10-02T0317Z'));
});

test("today's folders are always kept, even at 00:00 or a little ahead of the clock, and with a 1-day window", () => {
  const all = [...history(10), '2026-12-01T0000Z', '2026-12-01T0350Z'].sort();
  for (const days of [30, 1]) {
    const inp = { stamps: all, tip: inWindow(all, NOW, days).concat('2026-12-01T0000Z', '2026-12-01T0350Z'), now: NOW, days }, p = planTrim(inp);
    for (const s of ['2026-12-01T0000Z', TODAY, '2026-12-01T0350Z']) assert.ok(p.daily.includes(s), `${s} at ${days} days`);
    assert.deepEqual(planProblems(p, inp), []);
  }
});

test('a daily job that stopped for weeks: the trim still keeps the newest backup at the top', () => {
  const all = history(60).filter((s) => stampTime(s) < NOW - 40 * DAY), inp = { stamps: all, tip: inWindow(all, all.at(-1) ? stampTime(all.at(-1)) : NOW), now: NOW, days: 30 }, p = planTrim(inp);
  assert.deepEqual(p.daily, [all.at(-1)]);
  assert.deepEqual(planProblems(p, inp), []);
  assert.ok(planProblems({ ...p, daily: [], dropHistory: [...p.dropHistory, all.at(-1)].sort() }, inp).includes('the newest folder is not kept'));
});

test('planted faults: each broken plan is caught by the rules (and the script refuses it)', () => {
  const inp = input(), good = planTrim(inp);
  const faults = {
    "today's folder dropped": (p) => ({ ...p, daily: p.daily.filter((s) => s !== TODAY), dropHistory: [...p.dropHistory, TODAY].sort() }),
    'a 29-day window': (p) => { const gone = p.daily.filter((s) => stampTime(s) < NOW - 29 * DAY); assert.ok(gone.length); return { ...p, daily: p.daily.filter((s) => !gone.includes(s)), dropHistory: [...p.dropHistory, ...gone] }; },
    "the month's last backup instead of its first": (p) => ({ ...p, monthly: p.monthly.map((s) => (s === '2026-10-01T0317Z' ? '2026-10-31T0317Z' : s)), dropHistory: p.dropHistory.filter((s) => s !== '2026-10-31T0317Z').concat('2026-10-01T0317Z') }),
    'two folders for one month': (p) => ({ ...p, monthly: [...p.monthly, '2026-10-02T0317Z'].sort(), dropHistory: p.dropHistory.filter((s) => s !== '2026-10-02T0317Z') }),
    'a folder lost (neither kept nor dropped)': (p) => ({ ...p, dropHistory: p.dropHistory.slice(1) }),
    'a folder kept and dropped': (p) => ({ ...p, dropHistory: [...p.dropHistory, p.daily[0]] }),
    'a made-up folder kept': (p) => ({ ...p, monthly: [...p.monthly, '2027-01-01T0317Z'] }),
    'an old folder put back at the top': (p) => ({ ...p, daily: [p.dropHistory[0], ...p.daily], dropHistory: p.dropHistory.slice(1) }),
  };
  for (const [name, f] of Object.entries(faults)) assert.ok(planProblems(f(good), inp).length > 0, `not caught: ${name}`);
});

test('pushes: only the backup branch (with a lease on its old tip) and a pre-trim tag; never another ref', () => {
  assert.ok(refspecOk(`${SHA}:${BRANCH}`));
  assert.ok(refspecOk(`${SHA}:refs/tags/backup-pre-trim-20261201`) && refspecOk(`${SHA}:refs/tags/backup-pre-trim-20261201-2`));
  for (const bad of [`${SHA}:refs/heads/main`, `${SHA}:refs/heads/data`, `${SHA}:refs/heads/gh-pages`, `${SHA}:refs/heads/claude/x`, `+${SHA}:${BRANCH}`,
    `${SHA}:backup`, `${SHA}:refs/heads/backup2`, `${SHA}:refs/heads/backup/x`, `:${BRANCH}`, `${SHA}:refs/tags/v1`, `${SHA}:refs/tags/backup-pre-trim-x`,
    'refs/heads/*:refs/heads/*', `HEAD:${BRANCH}`, `${SHA}:${BRANCH} ${SHA}:refs/heads/main`, `--all`, `--mirror`, `${SHA}:refs/heads/backup\n${SHA}:refs/heads/main`]) {
    assert.ok(!refspecOk(bad), `accepted: ${bad}`);
    assert.throws(() => pushArgs('origin', bad, SHA2), /refusing/);
  }
  assert.throws(() => pushArgs('origin', `${SHA}:${BRANCH}`), /lease/);
  assert.deepEqual(pushArgs('origin', `${SHA}:${BRANCH}`, SHA2), ['push', '--porcelain', `--force-with-lease=${BRANCH}:${SHA2}`, 'origin', `${SHA}:${BRANCH}`]);
  assert.deepEqual(pushArgs('origin', `${SHA}:refs/tags/backup-pre-trim-20261201`), ['push', '--porcelain', 'origin', `${SHA}:refs/tags/backup-pre-trim-20261201`]);
});

// ---- a whole run on made-up repositories -------------------------------------------------------------------
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } }).trim();
const refs = (bare) => Object.fromEntries(sh(bare, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean).map((l) => l.split(' ')));
// a bare "remote" with main, data and gh-pages, and a backup branch made the way the daily job makes it:
// one commit per backup, each adding its folder and deleting the folders older than 30 days
function world(days = 75) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-trim-')), bare = path.join(root, 'remote.git'), w = path.join(root, 'work');
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', w);
  fs.writeFileSync(path.join(w, 'README.md'), 'made-up\n'); sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', 'main');
  for (const b of ['data', 'gh-pages']) { sh(w, 'checkout', '-q', '--orphan', b); sh(w, 'rm', '-rq', '--cached', '.'); fs.writeFileSync(path.join(w, b + '.json'), '{"lock":1,"t":1}'); sh(w, 'add', b + '.json'); sh(w, 'commit', '-q', '-m', b); fs.rmSync(path.join(w, b + '.json')); }
  sh(w, 'checkout', '-q', '--orphan', 'backup'); sh(w, 'rm', '-rq', '--cached', '.');
  for (const f of fs.readdirSync(w)) if (f !== '.git') fs.rmSync(path.join(w, f), { recursive: true });
  fs.writeFileSync(path.join(w, 'README.md'), 'made-up backups\n');
  for (const s of history(days)) {
    fs.mkdirSync(path.join(w, s, 'lock'), { recursive: true });
    fs.writeFileSync(path.join(w, s, 'live.json'), JSON.stringify({ lock: 1, t: Date.parse('2026-12-01T00:00:00Z'), iv: 'x', ct: s }));
    fs.writeFileSync(path.join(w, s, 'lock', 'lock.json'), '{"made":"up"}');
    for (const e of fs.readdirSync(w)) if (stampTime(e) != null && stampTime(e) < stampTime(s) - 30 * DAY) fs.rmSync(path.join(w, e), { recursive: true });
    sh(w, 'add', '-A'); sh(w, 'commit', '-q', '-m', `Backup ${s}`);
  }
  sh(w, 'push', '-q', bare, 'main', 'data', 'gh-pages', 'backup');
  const clone = path.join(root, 'clone');
  sh(root, 'clone', '-q', '--branch', 'backup', bare, clone);
  return { root, bare, clone };
}
const reach = (repo, ref) => new Set(sh(repo, 'log', '--format=', '--name-only', ref).split('\n').map((l) => l.split('/')[0]).filter((x) => /^\d{4}-/.test(x)));

test('a dry run plans, builds and checks the new commit and pushes nothing', () => {
  const W = world(), before = refs(W.bare), q = quiet();
  const r = trim({ repo: W.clone, now: NOW, say: q.say });
  assert.equal(r.pushed, false);
  assert.deepEqual(refs(W.bare), before, 'the remote is untouched');
  assert.ok(q.lines.some((l) => /dry run; pushed: no/.test(l)));
  assert.ok(q.lines.every((l) => !/[0-9a-f]{40}/.test(l)), 'no object ids in the output');
  assert.equal(r.plan.daily.length, inWindow(history()).length);
});

test('a real run: the old tip is tagged first, then only the backup branch is rewritten; today and each month stay', () => {
  const W = world(), before = refs(W.bare), q = quiet();
  const oldTip = before[BRANCH];
  const r = trim({ repo: W.clone, now: NOW, apply: true, say: q.say });
  const after = refs(W.bare);
  assert.equal(r.pushed, true);
  for (const k of Object.keys(before)) if (k !== BRANCH) assert.equal(after[k], before[k], `${k} untouched`);
  assert.equal(after['refs/tags/backup-pre-trim-20261201'], oldTip, 'the pre-trim tag is the old tip');
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), 'refs/tags/backup-pre-trim-20261201'].sort(), 'no other ref appears');
  assert.notEqual(after[BRANCH], oldTip);
  assert.equal(sh(W.bare, 'rev-list', '--count', BRANCH), '1');
  const top = sh(W.bare, 'ls-tree', '--name-only', BRANCH).split('\n'), mon = sh(W.bare, 'ls-tree', '--name-only', `${BRANCH}:monthly`).split('\n');
  assert.ok(top.includes(TODAY) && top.includes('README.md'));
  assert.deepEqual(mon, r.plan.monthly);
  for (const s of r.plan.daily) assert.equal(sh(W.bare, 'rev-parse', `${BRANCH}:${s}`), sh(W.bare, 'rev-parse', `${oldTip}:${s}`), `${s} is the same object`);
  const kept = reach(W.bare, BRANCH);
  for (const s of r.plan.dropHistory) assert.ok(!kept.has(s), `${s} left the history`);
  assert.ok(reach(W.bare, 'refs/tags/backup-pre-trim-20261201').size === history().length, 'the tag still holds every folder');
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
  const mid = refs(W.bare)[BRANCH];
  assert.throws(() => trim({ repo: W.clone, now: NOW, apply: true, say: quiet().say }));
  assert.equal(refs(W.bare)[BRANCH], mid, 'the newer backup stays');
});
