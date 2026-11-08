#!/usr/bin/env node
// Trim the `backup` branch's history (.github/workflows/backup-trim.yml; owner-approved, monthly).
//
// The daily backup job (scripts/backup.mjs) keeps 30 days of dated folders in the branch's tree, but every
// folder it ever wrote stays in the branch's history, so the repository only grows. This rewrites that one
// branch to a single commit whose tree keeps:
//   - every dated folder of the last 30 days, exactly as the daily job keeps them (the tree's own folders,
//     same objects), and always every folder stamped today and the newest one;
//   - one folder per month, the month's first backup, under monthly/<stamp>/ (a non-stamp entry, which the
//     daily job's 30-day prune never touches);
//   - every other entry of the tree as it is (README.md).
// Everything else (folders that are only in old commits) leaves the branch's history.
//
// Safety, in this order: the plan is checked against its rules (refuses on any break); the new commit is
// built and checked (every kept folder is the same object as before, today's are there); a tag
// backup-pre-trim-YYYYMMDD of the old tip is pushed and read back from the remote; then only
// refs/heads/backup is pushed, with --force-with-lease on the old tip (a backup pushed meanwhile stops it).
// No other ref is ever pushed: every refspec goes through refspecOk().
//
//   node tools/backup-trim.mjs --repo <clone with the backup branch's full history> [--remote origin]
//        [--now <ms>] [--days 30] [--apply] [--restore <dir>]
//
// Without --apply it is a dry run: it plans, builds and checks the new commit locally and pushes nothing.
// --restore <dir>: also write the new commit's newest daily folder there (for the restore rehearsal).
// Output: counts and dates only (folder names are dates; no file names, sizes or contents).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stampTime, DAY } from '../scripts/backup.mjs';

export const BRANCH = 'refs/heads/backup';
export const MONTHLY = 'monthly';
export const TAG_RE = /^refs\/tags\/backup-pre-trim-\d{8}(-\d{1,2})?$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const monthOf = (stamp) => stamp.slice(0, 7);

// ---- the plan (pure) ---------------------------------------------------------------------------------
// stamps: every dated folder name seen anywhere in the branch's history (its commits' trees and their
// monthly/ folders); tip: the names at the top of the tip's tree; now: ms; days: the daily job's window.
// Returns sorted lists: daily (stay at the top), monthly (go under monthly/), dropTip (top-level folders the
// new tree no longer has: always empty while the daily job keeps 30 days), dropHistory (no longer on the branch).
export function planTrim({ stamps, tip, now, days = 30 }) {
  if (!Number.isFinite(now)) throw new Error('bad now');
  if (!(days >= 1)) throw new Error('bad days: at least 1');
  const all = [...new Set([...stamps, ...tip].filter((s) => stampTime(s) != null))].sort();
  const today = dayOf(now), cut = now - days * DAY;
  const tipStamps = tip.filter((s) => stampTime(s) != null);
  // the same rule as the daily job's prune (a folder goes once it is older than `days`), and today's always stay
  // and the newest one always: if the daily job had stopped for a month, the trim still leaves a recent backup
  const newest = tipStamps.slice().sort().at(-1);
  const daily = tipStamps.filter((s) => stampTime(s) >= cut || dayOf(stampTime(s)) === today || s === newest).sort();
  const first = new Map();
  for (const s of all) if (!first.has(monthOf(s))) first.set(monthOf(s), s); // `all` is sorted: the month's first
  const monthly = [...first.values()].sort();
  const keep = new Set([...daily, ...monthly]);
  return {
    daily, monthly,
    dropTip: tipStamps.filter((s) => !daily.includes(s)).sort(),
    dropHistory: all.filter((s) => !keep.has(s)),
    total: all.length,
  };
}

// The plan's rules, checked before anything is built (returns the broken ones; empty = good).
export function planProblems(plan, { stamps, tip, now, days = 30 }) {
  const out = [];
  const all = [...new Set([...stamps, ...tip].filter((s) => stampTime(s) != null))];
  const keep = new Set([...plan.daily, ...plan.monthly]), drop = new Set(plan.dropHistory);
  const today = dayOf(now);
  if (all.some((s) => dayOf(stampTime(s)) === today && !plan.daily.includes(s))) out.push('a folder stamped today is not kept at the top');
  if (tip.filter((s) => stampTime(s) != null && stampTime(s) >= now - days * DAY).some((s) => !plan.daily.includes(s))) out.push('a folder inside the window is not kept');
  const newest = tip.filter((s) => stampTime(s) != null).sort().at(-1);
  if (newest && !plan.daily.includes(newest)) out.push('the newest folder is not kept');
  for (const [m, s] of new Map(all.slice().sort().reverse().map((x) => [monthOf(x), x]))) if (!plan.monthly.includes(s) || plan.monthly.filter((x) => monthOf(x) === m).length !== 1) out.push(`month ${m}: its first backup is not the one kept`);
  if ([...keep].some((s) => !all.includes(s))) out.push('keeps a folder that does not exist');
  if ([...keep].some((s) => drop.has(s))) out.push('a folder both kept and dropped');
  if (all.some((s) => !keep.has(s) && !drop.has(s))) out.push('a folder neither kept nor dropped');
  if (plan.daily.some((s) => !tip.includes(s))) out.push('a daily folder that is not in the tip');
  return out;
}

// Only two kinds of push ever leave this script: the new commit to the backup branch, and the pre-trim tag.
export function refspecOk(spec) {
  const m = /^([0-9a-f]{40}):(refs\/[A-Za-z0-9._/-]+)$/.exec(String(spec));
  return !!m && (m[2] === BRANCH || TAG_RE.test(m[2]));
}
export function pushArgs(remote, spec, lease) {
  if (!refspecOk(spec)) throw new Error('refusing: a push to anything but the backup branch or its pre-trim tag');
  const dst = spec.split(':')[1];
  if (dst === BRANCH && !SHA_RE.test(String(lease))) throw new Error('refusing: the branch is only pushed with a lease on its old tip');
  return ['push', '--porcelain', ...(dst === BRANCH ? [`--force-with-lease=${BRANCH}:${lease}`] : []), remote, spec];
}

// ---- git -------------------------------------------------------------------------------------------------
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const ENV = { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || BOT.name, GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || BOT.email, GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || BOT.name, GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || BOT.email };
const git = (repo, args, input) => execFileSync('git', args, { cwd: repo, env: ENV, encoding: 'utf8', input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const lsTree = (repo, tree) => (git(repo, ['ls-tree', tree]) || '').split('\n').filter(Boolean).map((l) => { const [meta, name] = l.split('\t'); const [mode, type, sha] = meta.split(' '); return { mode, type, sha, name }; });
const mkTree = (repo, entries) => git(repo, ['mktree'], entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join('\n') + (entries.length ? '\n' : ''));

// every dated folder in the branch's history, with the tree it held (backups are written once: the first seen)
export function historyStamps(repo, tip) {
  const seen = new Map();
  const commits = git(repo, ['rev-list', tip]).split('\n').filter(Boolean);
  for (const c of commits) {
    const top = lsTree(repo, `${c}^{tree}`);
    const mon = top.find((e) => e.name === MONTHLY && e.type === 'tree');
    for (const e of [...top, ...(mon ? lsTree(repo, mon.sha) : [])]) if (e.type === 'tree' && stampTime(e.name) != null && !seen.has(e.name)) seen.set(e.name, e.sha);
  }
  return { seen, commits: commits.length };
}

export function trim({ repo, remote = 'origin', now = Date.now(), days = 30, apply = false, restore = null, say = console.log }) {
  const tip = git(repo, ['rev-parse', '--verify', `${BRANCH}^{commit}`]);
  const top = lsTree(repo, `${tip}^{tree}`);
  const { seen, commits } = historyStamps(repo, tip);
  const input = { stamps: [...seen.keys()], tip: top.map((e) => e.name), now, days };
  const plan = planTrim(input);
  const bad = planProblems(plan, input);
  say(`trim: ${commits} commits; ${plan.total} dated folders in the history, ${input.tip.filter((s) => stampTime(s) != null).length} in the tip`);
  say(`trim: keep ${plan.daily.length} daily (last ${days} days${plan.daily.length ? `, ${plan.daily[0].slice(0, 10)} … ${plan.daily.at(-1).slice(0, 10)}` : ''}) + ${plan.monthly.length} monthly (first of each month); drop ${plan.dropHistory.length} from the history (${plan.dropTip.length} of them from the tip)`);
  if (bad.length) throw new Error(`refusing: the plan breaks ${bad.length} rule(s): ${bad.join('; ')}`);
  // nothing would leave the history: a rewrite would only fold the commits together (no space saved, the tag keeps them)
  if (!plan.dropHistory.length) { say('trim: nothing to trim (no folder would leave the history); pushed: no'); return { plan, commits, pushed: false, nothing: true }; }

  // the new tree: the tip's entries minus the dropped folders, and monthly/ with the month's first backups
  const monthlyTree = mkTree(repo, plan.monthly.map((s) => ({ mode: '040000', type: 'tree', sha: seen.get(s), name: s })));
  const entries = top.filter((e) => e.name !== MONTHLY && !plan.dropTip.includes(e.name));
  if (plan.monthly.length) entries.push({ mode: '040000', type: 'tree', sha: monthlyTree, name: MONTHLY });
  const tree = mkTree(repo, entries);
  const msg = `Backup history trimmed ${dayOf(now)}: ${plan.daily.length} daily and ${plan.monthly.length} monthly folders kept, ${plan.dropHistory.length} dropped (automated)`;
  const commit = git(repo, ['commit-tree', tree, '-m', msg]);

  // check what was built: the same objects for every kept folder; today's at the top; nothing else changed
  const newTop = new Map(lsTree(repo, tree).map((e) => [e.name, e]));
  const newMon = new Map(newTop.has(MONTHLY) ? lsTree(repo, newTop.get(MONTHLY).sha).map((e) => [e.name, e.sha]) : []);
  const probs = [];
  for (const e of top) if (e.name !== MONTHLY && !plan.dropTip.includes(e.name) && (!newTop.has(e.name) || newTop.get(e.name).sha !== e.sha)) probs.push('a kept entry changed');
  for (const s of plan.monthly) if (newMon.get(s) !== seen.get(s)) probs.push('a monthly folder is not the backup it copies');
  for (const s of input.tip) if (stampTime(s) != null && dayOf(stampTime(s)) === dayOf(now) && !newTop.has(s)) probs.push("today's folder is missing");
  if ([...newTop.keys()].filter((n) => stampTime(n) != null).length !== plan.daily.length) probs.push('the top holds other folders than the daily ones');
  if (probs.length) throw new Error(`refusing: the new commit fails ${probs.length} check(s): ${[...new Set(probs)].join('; ')}`);
  say(`trim: new commit built and checked (${newTop.size} entries at the top, ${newMon.size} monthly); kept folders are the same objects`);
  if (restore && plan.daily.length) { // the newest daily folder as the new commit holds it, for the restore rehearsal
    fs.mkdirSync(restore, { recursive: true });
    execFileSync('sh', ['-c', 'git archive "$1" "$2" | tar -x -C "$3"', 'sh', commit, plan.daily.at(-1), path.resolve(restore)], { cwd: repo, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  if (!apply) { say('trim: dry run; pushed: no'); return { plan, commits, pushed: false, commit }; }

  // 1. the old tip, kept under a tag on the remote, read back before anything is rewritten
  let tag = `refs/tags/backup-pre-trim-${dayOf(now).replace(/-/g, '')}`;
  for (let i = 2; git(repo, ['ls-remote', remote, tag]) && i < 100; i++) tag = `refs/tags/backup-pre-trim-${dayOf(now).replace(/-/g, '')}-${i}`;
  git(repo, pushArgs(remote, `${tip}:${tag}`));
  const back = git(repo, ['ls-remote', remote, tag]).split(/\s+/)[0];
  if (back !== tip) throw new Error('refusing: the pre-trim tag did not read back as the old tip; the branch is unchanged');
  say('trim: pre-trim tag pushed and read back: yes');
  // 2. only the backup branch, and only if it still is the old tip
  git(repo, pushArgs(remote, `${commit}:${BRANCH}`, tip));
  const now2 = git(repo, ['ls-remote', remote, BRANCH]).split(/\s+/)[0];
  if (now2 !== commit) throw new Error('the backup branch did not read back as the new commit');
  say('trim: backup branch rewritten and read back: yes; pushed: yes');
  return { plan, commits, pushed: true, commit, tag };
}

// ---- command line ------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  try {
    trim({ repo: arg('--repo', '.'), remote: arg('--remote', 'origin'), now: Number(arg('--now', Date.now())), days: Number(arg('--days', 30)), apply: argv.includes('--apply'), restore: arg('--restore', null) });
  } catch (e) {
    console.log(`trim: ${String(e.message).split('\n')[0].replace(/[0-9a-f]{40}/g, '<sha>').slice(0, 300)}`);
    process.exitCode = 1;
  }
}
