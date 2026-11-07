// Sealed backups of the published data (.github/workflows/backup.yml). The `data` branch is an orphan that
// every pass overwrites; this keeps dated copies of it on the `backup` branch, apart from it.
//
//   node scripts/backup.mjs make --data <data branch checkout> --lock <repo lock dir> --out <backup branch checkout>
//        --stamp YYYY-MM-DDTHHMMZ [--keep-days 30]
//   node scripts/backup.mjs rehearse --backups <backup branch checkout> --lock <repo lock dir> [--max-age-h 48]
//
// make: copies the data branch's *.json to <stamp>/ and the repo's lock/*.json to <stamp>/lock/, after
//   checking that every data file except lock.json and inbox.json is a sealed envelope ("lock":1), that
//   lock.json is a lock file equal to the repo's, and that inbox.json is a public key only. Anything else
//   (plaintext, a stray field, unparsable JSON) refuses the whole backup and writes nothing. Dated folders
//   older than --keep-days are deleted in the same change; other entries (README.md) are never touched.
// rehearse: the restore rehearsal on the newest folder: every envelope parses, every t is sane (after
//   2026-01-01, not after the backup was taken, not in the future), and the backed-up lock files equal the
//   repo's. It never decrypts: there is no passphrase here.
// Public output: dates, counts and pass/fail only (never a file's content, and no file names).
import fs from 'node:fs';
import path from 'node:path';
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

export function makeBackup({ dataDir, lockDir, outDir, stamp, keepDays = 30, say = console.log }) {
  const now = stampTime(stamp);
  if (now == null) throw new Error('bad stamp: YYYY-MM-DDTHHMMZ');
  if (!(keepDays >= 1)) throw new Error('bad keep days: at least 1');
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
  const old = planPrune(fs.readdirSync(outDir), now, keepDays, stamp);
  for (const f of old) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
  const kept = fs.readdirSync(outDir).filter((e) => stampTime(e) != null).length;
  say(`backup ${stamp}: ${c.dataFiles} data files (${c.sealed} sealed), ${c.lockFiles} lock files; seal check: pass`);
  say(`backup: folders older than ${keepDays} days deleted: ${old.length}; dated folders kept: ${kept}`);
  return { stamp, dataFiles: c.dataFiles, sealed: c.sealed, lockFiles: c.lockFiles, pruned: old.length, kept };
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
      makeBackup({ dataDir: arg('--data'), lockDir: arg('--lock', 'lock'), outDir: arg('--out'), stamp: arg('--stamp'), keepDays: Number(arg('--keep-days', 30)) });
    } else if (argv[0] === 'rehearse') {
      const r = rehearse({ backupsDir: arg('--backups'), lockDir: arg('--lock', 'lock'), maxAgeH: Number(arg('--max-age-h', 48)) });
      process.exitCode = r.ok ? 0 : 1;
    } else {
      throw new Error('bad command: make or rehearse');
    }
  } catch (e) {
    const m = String(e?.message || '');
    console.log(`backup failed: ${/^(missing|bad|refusing)\b/.test(m) ? m : e?.code || e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
