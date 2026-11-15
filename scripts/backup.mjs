// Sealed backups of the published data (.github/workflows/backup.yml). The `data` branch is an orphan that
// every pass overwrites; this keeps dated copies of it apart from it (docs/RESTORE.md):
//   - every copy (about every 50 minutes: the live loop dispatches backup.yml) as an Actions artifact
//     backup-<stamp>, kept 2 days: the hourly tier;
//   - the day's first copy also as a dated folder on the `backup` branch, which keeps what planRetention keeps:
//     every folder of the last 48 hours, the first of each UTC day for 90 days, the first of each ISO week for
//     365 days, and always the newest (tools/backup-trim.mjs folds the branch's history to the same set monthly).
//
//   node scripts/backup.mjs make --data <data branch checkout> --lock <repo lock dir> --out <dir>
//        --stamp YYYY-MM-DDTHHMMZ [--keep-days 30 | --no-prune]
//   node scripts/backup.mjs daily --repo <backup branch clone, trees only is enough> --stage <dir holding <stamp>/>
//        --stamp YYYY-MM-DDTHHMMZ [--remote origin] [--dry-run]
//   node scripts/backup.mjs rehearse --backups <dir of dated folders> --lock <repo lock dir> [--max-age-h 48]
//
// make: copies the data branch's *.json to <stamp>/ and the repo's lock/*.json to <stamp>/lock/, after
//   checking that every data file except lock.json and inbox.json is a sealed envelope ("lock":1), that
//   lock.json is a lock file equal to the repo's, and that inbox.json is a public key only. Anything else
//   (plaintext, a stray field, unparsable JSON) refuses the whole backup and writes nothing. Dated folders
//   older than --keep-days are deleted in the same change (none with --no-prune: a staging folder);
//   other entries (README.md) are never touched.
// daily: puts a staged copy on the backup branch as one new commit on its tip when the tip holds no folder of
//   that UTC day yet, and drops the folders planRetention no longer keeps. Built from git objects only (the
//   branch's files are never checked out or downloaded); every kept folder is the same object as before;
//   a normal push (never a force), started again from the new tip if another push came first.
// rehearse: the structural rehearsal on the newest folder: every envelope parses, every t is sane (after
//   2026-01-01, not after the backup was taken, not in the future), and the backed-up lock files equal the
//   repo's. It never decrypts: there is no passphrase here (the restore drill, scripts/restore.mjs, does).
// Public output: dates, counts and pass/fail only (never a file's content, and no file names).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isEnvelope, isLockFile } from '../lib/lock.mjs';

export const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z$/;
export const DAY = 86400e3;
export const T_FLOOR = Date.parse('2026-01-01T00:00:00Z');   // nothing was sealed before the project began
const SKEW = 10 * 60e3;                                        // clock slack for "not after" checks

export function stampOf(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) throw new Error('bad time');
  return d.toISOString().slice(0, 16).replace(':', '') + 'Z';
}

export function stampTime(stamp) {
  const m = STAMP_RE.exec(String(stamp));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return stampOf(t) === stamp ? t : null;   // rejects 2026-02-31 and 25:00
}

const isInboxKey = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && x.v === 1 && typeof x.x25519 === 'string' &&
  Buffer.from(x.x25519, 'base64').length === 32 && Object.keys(x).every((k) => k === 'v' || k === 'x25519');

const INBOX_KEYS = ['inbox', 'epk', 'iv', 'ct'];
export const isInboxEnvelope = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && x.inbox === 1 &&
  ['epk', 'iv', 'ct'].every((k) => typeof x[k] === 'string' && x[k].length > 0) && Object.keys(x).every((k) => INBOX_KEYS.includes(k));

// A stable string of parsed JSON (key order ignored) for "equals the repo's lock".
export function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// What a file must be, by where it sits and its name. Returns null when it is acceptable, else a reason
// word (for counting; never printed with the file's name or content).
export function fileProblem(where, name, text, repoLock) {
  const x = parse(text);
  if (x === undefined) return 'unparsable';
  if (name === 'lock.json') {
    if (!isLockFile(x)) return 'not-a-lock-file';
    if (repoLock && canon(x) !== canon(repoLock)) return 'lock-mismatch';
    return null;
  }
  if (name === 'inbox.json') return isInboxKey(x) ? null : 'not-a-public-key';
  if (isEnvelope(x)) return null;
  if (where === 'lock' && isInboxEnvelope(x)) return null;   // lock/config.sealed.json is sealed to the inbox
  return 'not-sealed';
}

const jsonFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();

// Read and check one set: { data: {name: text}, lock: {name: text} }. Returns counts and reason tallies.
export function checkSet({ data, lock }, repoLock) {
  const reasons = {};
  let bad = 0;
  for (const [where, files] of [['data', data], ['lock', lock]]) {
    for (const [name, text] of Object.entries(files)) {
      const p = fileProblem(where, name, text, repoLock);
      if (p) { bad++; reasons[p] = (reasons[p] || 0) + 1; }
    }
  }
  const sealed = Object.entries(data).filter(([n, t]) => n !== 'lock.json' && n !== 'inbox.json' && isEnvelope(parse(t))).length;
  if (!('lock.json' in data)) { bad++; reasons['lock-missing-from-data'] = 1; }
  if (!('lock.json' in lock)) { bad++; reasons['lock-missing-from-repo'] = 1; }
  if (sealed === 0) { bad++; reasons['no-sealed-data'] = 1; }
  return { ok: bad === 0, bad, sealed, dataFiles: Object.keys(data).length, lockFiles: Object.keys(lock).length, reasons };
}

const tally = (r) => Object.entries(r).map(([k, n]) => `${k} ${n}`).join(', ');

// Dated folders older than keepDays before `now` (by the folder's own stamp). Non-stamp entries are kept.
export function planPrune(entries, now, keepDays = 30, keep = null) {
  return entries.filter((e) => e !== keep && stampTime(e) != null && stampTime(e) < now - keepDays * DAY).sort();
}

// ---- retention (the owner's 1-year plan, 15 Nov 2026) --------------------------------------------------
// Which dated folders stay: every folder of the last `hours`; the first folder of each UTC day for `dailyDays`;
// the first folder of each ISO week (Monday 00:00 UTC) for `weeklyDays`; always the newest. A day's or week's
// first is taken over every folder given (never only the recent ones), so a folder that is not its day's
// first is never kept again once it leaves the 48 hours: the plan only ever lets folders go.
export const RETENTION = Object.freeze({ hours: 48, dailyDays: 90, weeklyDays: 365 });
const HOUR_MS = 3600e3;
export const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
export const weekKey = (t) => Math.floor((t - 4 * DAY) / (7 * DAY));   // 1970-01-05 was a Monday

export function planRetention(entries, now, policy = RETENTION) {
  if (!Number.isFinite(now)) throw new Error('bad now');
  const { hours, dailyDays, weeklyDays } = policy;
  if (!(hours >= 1 && dailyDays >= 1 && weeklyDays >= dailyDays)) throw new Error('bad retention: hours ≥ 1, days ≥ 1, weeks ≥ days');
  const at = new Map();
  for (const e of entries) if (!at.has(e)) { const t = stampTime(e); if (t != null) at.set(e, t); }
  const all = [...at.keys()].sort();
  const firsts = (key) => { const m = new Map(); for (const s of all) { const k = key(at.get(s)); if (!m.has(k)) m.set(k, s); } return [...m.values()]; };
  const hourly = all.filter((s) => at.get(s) >= now - hours * HOUR_MS);
  const daily = firsts(dayKey).filter((s) => at.get(s) >= now - dailyDays * DAY);
  const weekly = firsts(weekKey).filter((s) => at.get(s) >= now - weeklyDays * DAY);
  const keep = new Set([...hourly, ...daily, ...weekly, ...(all.length ? [all.at(-1)] : [])]);
  return { keep: all.filter((s) => keep.has(s)), drop: all.filter((s) => !keep.has(s)), hourly, daily, weekly };
}

export function makeBackup({ dataDir, lockDir, outDir, stamp, keepDays = 30, prune = true, say = console.log }) {
  const now = stampTime(stamp);
  if (now == null) throw new Error('bad stamp: YYYY-MM-DDTHHMMZ');
  if (prune && !(keepDays >= 1)) throw new Error('bad keep days: at least 1');
  for (const d of [dataDir, lockDir, outDir]) if (!d || !fs.existsSync(d)) throw new Error('missing folder');
  const read = (dir) => Object.fromEntries(jsonFiles(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
  const set = { data: read(dataDir), lock: read(lockDir) };
  const repoLock = parse(set.lock['lock.json'] ?? '');
  const c = checkSet(set, isLockFile(repoLock) ? repoLock : null);
  if (!isLockFile(repoLock)) { c.ok = false; c.bad++; c.reasons['repo-lock-unreadable'] = 1; }
  if (!c.ok) throw new Error(`refusing: ${c.bad} of ${c.dataFiles + c.lockFiles} files failed the seal check (${tally(c.reasons)}); nothing written`);
  const dest = path.join(outDir, stamp);
  if (fs.existsSync(dest)) throw new Error('refusing: a backup with this stamp already exists');
  fs.mkdirSync(path.join(dest, 'lock'), { recursive: true });
  for (const [n, t] of Object.entries(set.data)) fs.writeFileSync(path.join(dest, n), t);
  for (const [n, t] of Object.entries(set.lock)) fs.writeFileSync(path.join(dest, 'lock', n), t);
  const old = prune ? planPrune(fs.readdirSync(outDir), now, keepDays, stamp) : [];
  for (const f of old) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
  const kept = fs.readdirSync(outDir).filter((e) => stampTime(e) != null).length;
  say(`backup ${stamp}: ${c.dataFiles} data files (${c.sealed} sealed), ${c.lockFiles} lock files; seal check: pass`);
  if (prune) say(`backup: folders older than ${keepDays} days deleted: ${old.length}; dated folders kept: ${kept}`);
  return { stamp, dataFiles: c.dataFiles, sealed: c.sealed, lockFiles: c.lockFiles, pruned: old.length, kept };
}

// ---- the day's first copy on the backup branch (git objects only) -----------------------------------------
export const BACKUP_BRANCH = 'refs/heads/backup';
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || BOT.name, GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || BOT.email,
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || BOT.name, GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || BOT.email, GIT_TERMINAL_PROMPT: '0' };
export const gitIn = (repo) => (args, input) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8', input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
export const lsTree = (git, tree) => (git(['ls-tree', tree]) || '').split('\n').filter(Boolean).map((l) => {
  const [meta, name] = l.split('\t'); const [mode, type, sha] = meta.split(' '); return { mode, type, sha, name };
});
export const mkTree = (git, entries) => git(['mktree'], entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join('\n') + (entries.length ? '\n' : ''));

// A folder on disk as git objects (files and sub-folders only); returns its tree id.
export function folderTree(git, dir) {
  const entries = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.resolve(dir, e.name);
    if (e.isDirectory()) entries.push({ mode: '040000', type: 'tree', sha: folderTree(git, p), name: e.name });
    else if (e.isFile()) entries.push({ mode: '100644', type: 'blob', sha: git(['hash-object', '-w', p]), name: e.name });
  }
  return mkTree(git, entries);
}

// The new commit on `tip` that adds the staged <stamp>/ folder and drops what planRetention lets go, or
// { skip } when the tip already holds a folder of that UTC day. Checked before it is returned.
export function buildDaily({ git, tip, stageDir, stamp, policy = RETENTION }) {
  const now = stampTime(stamp);
  if (now == null) throw new Error('bad stamp: YYYY-MM-DDTHHMMZ');
  const src = path.join(stageDir, stamp);
  if (!fs.existsSync(path.join(src, 'lock', 'lock.json'))) throw new Error('missing staged copy: no <stamp>/lock/lock.json');
  const top = lsTree(git, `${tip}^{tree}`);
  const stamps = top.filter((e) => e.type === 'tree' && stampTime(e.name) != null).map((e) => e.name);
  if (stamps.includes(stamp)) return { skip: 'this stamp is there already' };
  const today = stamps.filter((s) => dayKey(stampTime(s)) === dayKey(now)).sort();
  if (today.length) return { skip: "the day's first copy is there already", first: today[0] };
  const plan = planRetention([...stamps, stamp], now, policy);
  const keep = new Set(plan.keep);
  const folder = folderTree(git, src);
  const entries = top.filter((e) => stampTime(e.name) == null || keep.has(e.name));
  entries.push({ mode: '040000', type: 'tree', sha: folder, name: stamp });
  const tree = mkTree(git, entries);
  // the checks: every entry kept is the same object, the new folder is the staged copy, nothing else changed
  const after = new Map(lsTree(git, tree).map((e) => [e.name, e]));
  const probs = [];
  for (const e of top) if ((stampTime(e.name) == null || keep.has(e.name)) && after.get(e.name)?.sha !== e.sha) probs.push('a kept entry changed');
  if (after.get(stamp)?.sha !== folder) probs.push('the new folder is not the staged copy');
  if ([...after.keys()].filter((n) => stampTime(n) != null).length !== plan.keep.length) probs.push('the top holds other folders than the plan keeps');
  if (!after.has(plan.keep.at(-1))) probs.push('the newest folder is not kept');
  if (probs.length) throw new Error(`refusing: the new commit fails ${probs.length} check(s): ${[...new Set(probs)].join('; ')}`);
  const commit = git(['commit-tree', tree, '-p', tip, '-m', `Backup ${stamp} (sealed, automated; the day's first copy)`]);
  const dropped = stamps.filter((s) => !keep.has(s));
  return { commit, folder, dropped, kept: plan.keep.length, tiers: { hourly: plan.hourly.length, daily: plan.daily.length, weekly: plan.weekly.length } };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Fetch the branch's tip (trees only where the clone is partial), build, push; again from the new tip if a
// push came first. Never a force push, never another ref.
export function pushDaily({ repo, remote = 'origin', stageDir, stamp, policy = RETENTION, dryRun = false, tries = 3, waitMs = 5000, say = console.log }) {
  const git = gitIn(repo);
  let partial = false;
  try { partial = git(['config', `remote.${remote}.promisor`]) === 'true'; } catch { partial = false; }
  for (let attempt = 1; attempt <= tries; attempt++) {
    const line = git(['ls-remote', '--heads', remote, BACKUP_BRANCH]);
    if (!line) throw new Error('missing branch: the backup branch is not on the remote');
    git(['fetch', '-q', '--no-tags', '--depth=1', ...(partial ? ['--filter=blob:none'] : []), remote, `+${BACKUP_BRANCH}:refs/lps/backup-tip`]);
    const tip = git(['rev-parse', '--verify', 'refs/lps/backup-tip^{commit}']);
    const b = buildDaily({ git, tip, stageDir, stamp, policy });
    if (b.skip) {
      say(`daily copy on the backup branch: not needed (${b.skip}${b.first ? `: ${b.first}` : ''})`);
      return { added: false, skip: b.skip };
    }
    say(`daily copy on the backup branch: ${stamp}; folders kept ${b.kept} (last 48 h ${b.tiers.hourly}, days ${b.tiers.daily}, weeks ${b.tiers.weekly}), dropped ${b.dropped.length}; checks: pass`);
    if (dryRun) { say('daily copy: dry run; pushed: no'); return { added: false, dryRun: true, ...b }; }
    let pushed = true;
    try { git(['push', '--porcelain', remote, `${b.commit}:${BACKUP_BRANCH}`]); } catch { pushed = false; }
    if (pushed) {
      const now2 = git(['ls-remote', '--heads', remote, BACKUP_BRANCH]).split(/\s+/)[0];
      if (now2 !== b.commit) throw new Error('bad push: the backup branch does not point at the new commit');
      say(`daily copy: pushed: yes (attempt ${attempt})`);
      return { added: true, attempts: attempt, ...b };
    }
    say(`daily copy: pushed: no (attempt ${attempt}); starting again from the newest tip`);
    if (attempt < tries) sleepMs(waitMs * attempt);
  }
  throw new Error(`bad push: the backup branch push failed ${tries} times`);
}

// ---- the restore rehearsal ---------------------------------------------------------------------------
// Supports both layouts on the backup branch: data files at the folder's root (current) or under data/
// (the first hand-made backups). Lock files are always under lock/.
export function rehearse({ backupsDir, lockDir, now = Date.now(), maxAgeH = 48, say = console.log }) {
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok: !!ok }); return !!ok; };
  let envs = [], lockSealed = [], newest = 0, at = null;
  const stamps = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((e) => stampTime(e) != null).sort() : [];
  if (!check('a dated backup folder exists', stamps.length > 0)) return report();
  const stamp = stamps.at(-1), dir = path.join(backupsDir, stamp);
  at = stampTime(stamp);
  const dataDir = fs.existsSync(path.join(dir, 'data')) ? path.join(dir, 'data') : dir;
  const lockOf = path.join(dir, 'lock');
  const data = Object.fromEntries(jsonFiles(dataDir).map((n) => [n, parse(fs.readFileSync(path.join(dataDir, n), 'utf8'))]));
  const lock = fs.existsSync(lockOf) ? Object.fromEntries(jsonFiles(lockOf).map((n) => [n, parse(fs.readFileSync(path.join(lockOf, n), 'utf8'))])) : {};
  const repoLock = parse(fs.readFileSync(path.join(lockDir, 'lock.json'), 'utf8'));
  const repoInbox = fs.existsSync(path.join(lockDir, 'inbox.json')) ? parse(fs.readFileSync(path.join(lockDir, 'inbox.json'), 'utf8')) : undefined;

  envs = Object.entries(data).filter(([n]) => n !== 'lock.json' && n !== 'inbox.json');
  lockSealed = Object.entries(lock).filter(([n]) => n !== 'lock.json' && n !== 'inbox.json');
  check('newest backup is recent', at <= now + SKEW && now - at <= maxAgeH * 3600e3);
  check('data envelopes present', envs.length > 0);
  check('every data envelope parses', envs.every(([, x]) => isEnvelope(x)));
  check('every t is sane (after 2026-01-01, not after the backup, not in the future)',
    envs.every(([, x]) => isEnvelope(x) && x.t >= T_FLOOR && x.t <= at + 60e3 + SKEW && x.t <= now + SKEW));
  check('every sealed lock file parses', lockSealed.every(([, x]) => isEnvelope(x) || isInboxEnvelope(x)));
  check('the repo lock is a lock file', isLockFile(repoLock));
  check('lock.json equals the repo lock', isLockFile(data['lock.json']) && isLockFile(repoLock) && canon(data['lock.json']) === canon(repoLock));
  check('lock/lock.json equals the repo lock', isLockFile(lock['lock.json']) && isLockFile(repoLock) && canon(lock['lock.json']) === canon(repoLock));
  if (repoInbox !== undefined) check('lock/inbox.json equals the repo inbox key', isInboxKey(lock['inbox.json']) && canon(lock['inbox.json']) === canon(repoInbox));
  newest = envs.reduce((m, [, x]) => (isEnvelope(x) ? Math.max(m, x.t) : m), 0);
  return report();

  function report() {
    const pass = checks.every((c) => c.ok);
    const failed = checks.filter((c) => !c.ok);
    if (stamps.length) {
      say(`rehearsal: dated folders ${stamps.length} (oldest ${stamps[0]}, newest ${stamps.at(-1)}); newest has ${envs.length} data envelopes, ${lockSealed.length} sealed lock files`);
      if (newest) say(`rehearsal: newest data sealed ${Math.round((at - newest) / 6e3) / 10} min before the backup`);
    }
    for (const c of checks) say(`rehearsal: ${c.name}: ${c.ok ? 'pass' : 'FAIL'}`);
    say(`rehearsal: ${checks.length - failed.length} of ${checks.length} checks pass; restore rehearsal: ${pass ? 'pass' : 'FAIL'}`);
    return { ok: pass, checks, stamp: stamps.at(-1) ?? null, folders: stamps.length };
  }
}

// ---- command line --------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  try {
    if (argv[0] === 'make') {
      const outDir = arg('--out');
      if (argv.includes('--no-prune') && outDir) fs.mkdirSync(outDir, { recursive: true });
      makeBackup({ dataDir: arg('--data'), lockDir: arg('--lock', 'lock'), outDir, stamp: arg('--stamp'), keepDays: Number(arg('--keep-days', 30)), prune: !argv.includes('--no-prune') });
    } else if (argv[0] === 'daily') {
      pushDaily({ repo: arg('--repo'), remote: arg('--remote', 'origin'), stageDir: arg('--stage'), stamp: arg('--stamp'), dryRun: argv.includes('--dry-run') });
    } else if (argv[0] === 'rehearse') {
      const r = rehearse({ backupsDir: arg('--backups'), lockDir: arg('--lock', 'lock'), maxAgeH: Number(arg('--max-age-h', 48)) });
      process.exitCode = r.ok ? 0 : 1;
    } else {
      throw new Error('bad command: make, daily or rehearse');
    }
  } catch (e) {
    const m = String(e?.message || '');
    console.log(`backup failed: ${/^(missing|bad|refusing)\b/.test(m) ? m : e?.code || e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
