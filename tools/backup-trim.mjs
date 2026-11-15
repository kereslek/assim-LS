#!/usr/bin/env node
// Trim the `backup` branch's history (.github/workflows/backup-trim.yml; owner-approved, monthly).
//
// The backup job (scripts/backup.mjs daily) adds the day's first copy as a normal commit and drops from the
// tree what planRetention lets go, but every folder it ever wrote stays in the branch's history, so the
// repository only grows. This rewrites that one branch to a single commit whose tree keeps exactly what
// planRetention keeps over every dated folder the history has seen (the owner's 1-year plan, 15 Nov 2026):
//   - every folder of the last 48 hours, the first of each UTC day for 90 days, the first of each ISO week
//     for 365 days, and always the newest, all at the top (folders the plan keeps that only the history still
//     has, e.g. from before the plan or the first trims' monthly/ folder, come back to the top as the same objects);
//   - every other entry of the tree as it is (README.md).
// Everything else leaves the branch's history. Pre-trim tags beyond the newest KEEP_TAGS are deleted once the
// new tip has read back: they hold only folders past the retention (and copies of the rest).
//
// Safety, in this order: the plan is checked against its rules (refuses on any break); the new commit is
// built and checked (every kept folder is the same object as before, the last 48 hours are there); a tag
// backup-pre-trim-YYYYMMDD of the old tip is pushed and read back from the remote; then only
// refs/heads/backup is pushed, with --force-with-lease on the old tip (a backup pushed meanwhile stops it);
// then the older pre-trim tags go. No other ref is ever pushed or deleted: every refspec goes through refspecOk().
//
//   node tools/backup-trim.mjs --repo <clone with the backup branch's full history> [--remote origin]
//        [--now <ms>] [--apply] [--restore <dir>]
//
// Without --apply it is a dry run: it plans, builds and checks the new commit locally and pushes nothing.
// --restore <dir>: also write the new commit's newest folder there (for the restore rehearsal).
// Output: counts and dates only (folder names are dates; no file names, sizes or contents).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stampTime, planRetention, RETENTION, dayKey, weekKey } from '../scripts/backup.mjs';

export const BRANCH = 'refs/heads/backup';
export const MONTHLY = 'monthly';           // the first design's sub-folder: read (its folders count), never written
export const KEEP_TAGS = 2;
export const TAG_RE = /^refs\/tags\/backup-pre-trim-\d{8}(-\d{1,2})?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const H = 3600e3, DAY = 86400e3;

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// ---- the plan (pure) ---------------------------------------------------------------------------------
// stamps: every dated folder name seen anywhere in the branch's history (its commits' trees and their
// monthly/ folders); tip: the names at the top of the tip's tree; now: ms. Returns sorted lists: keep (at the
// top of the new tree), back (kept folders the tip no longer has), dropTip (top-level folders the new tree no
// longer has), dropHistory (no longer on the branch).
export function planTrim({ stamps, tip, now, policy = RETENTION }) {
  if (!Number.isFinite(now)) throw new Error('bad now');
  const p = planRetention([...stamps, ...tip], now, policy);
  const tipStamps = tip.filter((s) => stampTime(s) != null);
  return {
    keep: p.keep,
    back: p.keep.filter((s) => !tipStamps.includes(s)),
    dropTip: tipStamps.filter((s) => !p.keep.includes(s)).sort(),
    dropHistory: p.drop,
    total: p.keep.length + p.drop.length,
  };
}

// The plan's rules, each checked on its own terms before anything is built (returns the broken ones; empty = good).
export function planProblems(plan, { stamps, tip, now, policy = RETENTION }) {
  const out = [];
  const all = [...new Set([...stamps, ...tip].filter((s) => stampTime(s) != null))].sort();
  const keep = new Set(plan.keep), drop = new Set(plan.dropHistory);
  const age = (s) => now - stampTime(s);
  if (all.some((s) => age(s) <= policy.hours * H && !keep.has(s))) out.push(`a folder of the last ${policy.hours} hours is not kept`);
  if (all.length && !keep.has(all.at(-1))) out.push('the newest folder is not kept');
  const first = (key) => { const m = new Map(); for (const s of all) if (!m.has(key(stampTime(s)))) m.set(key(stampTime(s)), s); return m; };
  const days = first(dayKey), weeks = first(weekKey);
  for (const [d, s] of days) if (age(s) <= policy.dailyDays * DAY && !keep.has(s)) out.push(`day ${d}: its first folder is not kept`);
  for (const s of weeks.values()) if (age(s) <= policy.weeklyDays * DAY && !keep.has(s)) { out.push('a week\'s first folder within the year is not kept'); break; }
  const firsts = new Set([...days.values(), ...weeks.values()]);
  for (const s of keep) {
    if (age(s) <= policy.hours * H || s === all.at(-1)) continue;
    if (!firsts.has(s)) { out.push('keeps a folder that is not its day\'s or week\'s first'); break; }
    if ((days.get(dayKey(stampTime(s))) === s ? age(s) > policy.dailyDays * DAY : true) && (weeks.get(weekKey(stampTime(s))) === s ? age(s) > policy.weeklyDays * DAY : true)) { out.push('keeps a folder past its tier'); break; }
  }
  if ([...keep].some((s) => !all.includes(s))) out.push('keeps a folder that does not exist');
  if ([...keep].some((s) => drop.has(s))) out.push('a folder both kept and dropped');
  if (all.some((s) => !keep.has(s) && !drop.has(s))) out.push('a folder neither kept nor dropped');
  return out;
}

// Only three kinds of push ever leave this script: the new commit to the backup branch, a pre-trim tag, and
// the deletion of an older pre-trim tag.
export function refspecOk(spec) {
  const m = /^([0-9a-f]{40})?:(refs\/[A-Za-z0-9._/-]+)$/.exec(String(spec));
  if (!m) return false;
  if (!m[1]) return TAG_RE.test(m[2]);   // a deletion: only a pre-trim tag
  return m[2] === BRANCH || TAG_RE.test(m[2]);
}
export function pushArgs(remote, spec, lease) {
  if (!refspecOk(spec)) throw new Error('refusing: a push to anything but the backup branch or its pre-trim tags');
  const dst = spec.split(':')[1];
  if (dst === BRANCH && !SHA_RE.test(String(lease))) throw new Error('refusing: the branch is only pushed with a lease on its old tip');
  return ['push', '--porcelain', ...(dst === BRANCH ? [`--force-with-lease=${BRANCH}:${lease}`] : []), remote, spec];
}

// The pre-trim tags to delete: every one but the newest `keep` (by date, then the -n of a second trim that day).
export function tagsToPrune(refs, keep = KEEP_TAGS) {
  const rank = (r) => { const m = /backup-pre-trim-(\d{8})(?:-(\d{1,2}))?$/.exec(r); return [Number(m[1]), Number(m[2] || 1)]; };
  const tags = [...new Set(refs.filter((r) => TAG_RE.test(r)))].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
  return tags.slice(0, Math.max(0, tags.length - keep));
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

export function trim({ repo, remote = 'origin', now = Date.now(), policy = RETENTION, apply = false, restore = null, say = console.log }) {
  const tip = git(repo, ['rev-parse', '--verify', `${BRANCH}^{commit}`]);
  const top = lsTree(repo, `${tip}^{tree}`);
  const { seen, commits } = historyStamps(repo, tip);
  const input = { stamps: [...seen.keys()], tip: top.map((e) => e.name), now, policy };
  const plan = planTrim(input);
  const bad = planProblems(plan, input);
  const oldTags = git(repo, ['ls-remote', '--tags', remote, 'refs/tags/backup-pre-trim-*']).split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]).filter((r) => TAG_RE.test(r));
  say(`trim: ${commits} commits; ${plan.total} dated folders in the history, ${input.tip.filter((s) => stampTime(s) != null).length} in the tip; pre-trim tags on the remote: ${oldTags.length}`);
  say(`trim: keep ${plan.keep.length} (${plan.keep.length ? `${plan.keep[0].slice(0, 10)} … ${plan.keep.at(-1).slice(0, 10)}` : 'none'}; ${plan.back.length} back from the history); drop ${plan.dropHistory.length} from the history (${plan.dropTip.length} of them from the tip)`);
  if (bad.length) throw new Error(`refusing: the plan breaks ${bad.length} rule(s): ${bad.join('; ')}`);
  // nothing would leave the history: a rewrite would only fold the commits together (no space saved, the tag keeps them)
  if (!plan.dropHistory.length && !plan.back.length) { say('trim: nothing to trim (no folder would leave the history); pushed: no'); return { plan, commits, pushed: false, nothing: true }; }

  // the new tree: the tip's other entries as they are, and every kept folder at the top as the same object
  const entries = top.filter((e) => e.name !== MONTHLY && stampTime(e.name) == null);
  for (const s of plan.keep) entries.push({ mode: '040000', type: 'tree', sha: seen.get(s), name: s });
  const tree = mkTree(repo, entries);
  const msg = `Backup history trimmed ${dayOf(now)}: ${plan.keep.length} folders kept (48 hours, 90 days, a year of weeks), ${plan.dropHistory.length} dropped (automated)`;
  const commit = git(repo, ['commit-tree', tree, '-m', msg]);

  // check what was built: the same objects for every kept folder; the last 48 hours at the top; nothing else changed
  const newTop = new Map(lsTree(repo, tree).map((e) => [e.name, e]));
  const probs = [];
  for (const e of top) if (e.name !== MONTHLY && stampTime(e.name) == null && newTop.get(e.name)?.sha !== e.sha) probs.push('a kept entry changed');
  for (const s of plan.keep) if (newTop.get(s)?.sha !== seen.get(s) || !seen.get(s)) probs.push('a kept folder is not the backup it copies');
  for (const s of input.tip) if (stampTime(s) != null && now - stampTime(s) <= policy.hours * H && !newTop.has(s)) probs.push('a folder of the last 48 hours is missing');
  if ([...newTop.keys()].filter((n) => stampTime(n) != null).length !== plan.keep.length) probs.push('the top holds other folders than the kept ones');
  if (newTop.has(MONTHLY)) probs.push('the new tree still has monthly/');
  if (probs.length) throw new Error(`refusing: the new commit fails ${probs.length} check(s): ${[...new Set(probs)].join('; ')}`);
  say(`trim: new commit built and checked (${newTop.size} entries at the top); kept folders are the same objects`);
  if (restore && plan.keep.length) { // the newest folder as the new commit holds it, for the restore rehearsal
    fs.mkdirSync(restore, { recursive: true });
    execFileSync('sh', ['-c', 'git archive "$1" "$2" | tar -x -C "$3"', 'sh', commit, plan.keep.at(-1), path.resolve(restore)], { cwd: repo, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  if (!apply) { say(`trim: dry run; pushed: no; would delete ${tagsToPrune([...oldTags, 'refs/tags/backup-pre-trim-99999999'], KEEP_TAGS).length} older pre-trim tag(s)`); return { plan, commits, pushed: false, commit }; }

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
  // 3. the older pre-trim tags (past the retention): every one but the newest KEEP_TAGS, never the one just made
  const prune = tagsToPrune([...oldTags, tag], KEEP_TAGS).filter((r) => r !== tag);
  for (const r of prune) git(repo, pushArgs(remote, `:${r}`));
  const left = git(repo, ['ls-remote', '--tags', remote, 'refs/tags/backup-pre-trim-*']).split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]);
  if (prune.some((r) => left.includes(r)) || !left.includes(tag)) throw new Error('bad tags: the pre-trim tags did not read back as planned');
  say(`trim: older pre-trim tags deleted: ${prune.length}; kept: ${left.filter((r) => TAG_RE.test(r)).length}`);
  return { plan, commits, pushed: true, commit, tag, tagsDeleted: prune.length };
}

// ---- command line ------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  try {
    trim({ repo: arg('--repo', '.'), remote: arg('--remote', 'origin'), now: Number(arg('--now', Date.now())), apply: argv.includes('--apply'), restore: arg('--restore', null) });
  } catch (e) {
    console.log(`trim: ${String(e.message).split('\n')[0].replace(/[0-9a-f]{40}/g, '<sha>').slice(0, 300)}`);
    process.exitCode = 1;
  }
}
