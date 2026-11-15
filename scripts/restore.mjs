// The restore drill and the guarded restore (docs/RESTORE.md; .github/workflows/restore-drill.yml, restore.yml).
//
//   node scripts/restore.mjs drill --backup <dated folder> --stamp YYYY-MM-DDTHHMMZ [--lock lock]
//        [--live <data branch checkout>] [--max-age-h 2] [--label hourly]
//   node scripts/restore.mjs restore --backup <dated folder> --stamp YYYY-MM-DDTHHMMZ [--lock lock] [--remote origin]
//        [--apply --confirm "RESTORE <stamp>"]
//
// drill: with the lock's passphrase (LOCK_PASSPHRASE, as the loop has it), on one backup folder:
//   1. every file is there (the five data files, lock.json, lock/), nothing else; the lock files equal the repo's;
//   2. every data file is a sealed envelope that opens with the lock, in its docs/DATA.md shape (snapshots.json
//      through the scan's own loader); lock/config.sealed.json opens with the inbox key; every time is sane;
//   3. the set is rebuilt in a temp folder exactly as the data branch holds it (one commit with no parent:
//      lock.json and the data files, byte for byte) and pushed to a temp remote's data branch;
//   4. the loop's own code starts from it: runLoop restores it with publish-data's restoreData ("data branch
//      present … files restored"), reads its counters back, runs one pass that loads every file as the scan
//      does, and publishes as a dry run (every file opens with the lock, only known names);
//   5. its counts (pools, rows, days) are compared with the live data branch's current files.
// restore: the same checks 1 to 3 (not the age), then, only with --apply and the exact confirmation, and only
//   while no loop run is queued or in progress: the data branch's tip is tagged data-pre-restore-<now> and read
//   back, then the rebuilt commit replaces the data branch with a lease on that tagged tip, and is read back
//   with restoreData. Without --apply it is a dry run: it checks and builds everything and pushes nothing.
// Public output: pass/fail, counts, dates and ages only; never a value, a name, an id or an amount.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isEnvelope, isLockFile, open, unlock, passphraseFrom, readLock } from '../lib/lock.mjs';
import { inboxKeys, inboxOpen } from '../lib/inbox.mjs';
import { DATA_FILES, openStore } from '../lib/store.mjs';
import { parseStore } from '../lib/snapshots.mjs';
import { unpackGt } from '../lib/feehist.mjs';
import { unpackSx } from '../lib/exactfees.mjs';
import { unpackTv } from '../lib/tvlhist.mjs';
import { canon, isInboxEnvelope, stampTime, stampOf, T_FLOOR, gitIn, mkTree } from './backup.mjs';
import { publishData, restoreData } from './publish-data.mjs';
import { runLoop } from './loop.mjs';

export const DATA_BRANCH = 'refs/heads/data';
export const PRE_RESTORE_RE = /^refs\/tags\/data-pre-restore-\d{8}T\d{4}Z(-\d{1,2})?$/;
export const confirmText = (stamp) => `RESTORE ${stamp}`;
const SKEW = 10 * 60e3, DAY = 86400e3, ROW_SPAN = 400 * DAY;
const SNAP_FIX = 2;   // scripts/scan.mjs: an older store is rebuilt, not read
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
const safeMsg = (e) => { const m = String(e?.message || ''); return /^(missing|bad|refusing|wrong|not a data file|[a-z]+\.json:)/.test(m) ? m.split('\n')[0].slice(0, 200) : e?.code || e?.name || 'Error'; };

// ---- reading a backup folder ---------------------------------------------------------------------------
// Data files at the folder's root (current) or under data/ (the first hand-made backups); lock files under lock/.
export function readFolder(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error('missing backup: no such folder');
  const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort() : []);
  const dataDir = fs.existsSync(path.join(dir, 'data')) ? path.join(dir, 'data') : dir;
  const read = (d) => Object.fromEntries(files(d).map((n) => [n, fs.readFileSync(path.join(d, n), 'utf8')]));
  return { data: read(dataDir), lock: read(path.join(dir, 'lock')) };
}

// ---- shapes (docs/DATA.md), as problem words; a row's time must sit within ROW_SPAN before its file's t ----
const rowsOk = (rows, len, t) => Array.isArray(rows) && rows.every((r, i) => Array.isArray(r) && r.length === len && isNum(r[0]) &&
  r[0] <= t + SKEW && r[0] >= t - ROW_SPAN && (i === 0 || r[0] >= rows[i - 1][0]));
export const SHAPES = {
  'live.json': (x) => {
    const p = [];
    if (!Array.isArray(x.pools)) p.push('pools');
    else if (x.pools.some((q) => !isObj(q) || typeof q.id !== 'string' || typeof q.chain !== 'string' || !isObj(q.w))) p.push('a pool');
    else if (new Set(x.pools.map((q) => q.id)).size !== x.pools.length) p.push('pool ids');
    if (!Array.isArray(x.windows) || !x.windows.every((w) => typeof w === 'string')) p.push('windows');
    if (!isObj(x.health)) p.push('health');
    if (x.next != null && !isNum(x.next)) p.push('next');
    return p;
  },
  'history.json': (x) => {
    const p = [];
    if (!isObj(x.pools)) return ['pools'];
    for (const h of Object.values(x.pools)) {
      if (!isObj(h) || !rowsOk(h.h, 5, x.t) || !rowsOk(h.d, 5, x.t)) { p.push('a pool\'s rows'); break; }
      if (h.y != null && !rowsOk(h.y, 3, x.t)) { p.push('a fee history'); break; }
      if ((h.yv != null && (!Array.isArray(h.yv) || h.yv.length !== (h.y || []).length)) || (h.yt != null && (!Array.isArray(h.yt) || h.yt.length !== (h.y || []).length))) { p.push('a volume or TVL history'); break; }
    }
    if (!Array.isArray(x.health)) p.push('health');
    return p;
  },
  'snapshots.json': (x) => {
    if (!isObj(x.pools)) return ['pools'];
    if (!((x.fix ?? 0) >= SNAP_FIX)) return ['an old store (the scan would rebuild it)'];
    let m;
    try { m = parseStore(x); } catch { return ['the store does not parse']; }
    try { unpackGt(x.gt); unpackSx(x.sx); unpackTv(x.tv); } catch { return ['a cache does not unpack']; }
    for (const s of m.values()) for (const r of [...s.h, ...s.d]) if (!(r.t <= x.t + SKEW && r.t >= x.t - ROW_SPAN)) return ['a row\'s time'];
    return [];
  },
  'backtest.json': (x) => (isObj(x.pools) ? [] : ['pools']),
  'log.json': (x) => (Array.isArray(x.lines) && isNum(x.errors) ? [] : ['lines']),
};

// Counts only (pools, rows, days), for the comparison with the live data branch.
export function countsOf(objs) {
  const live = objs['live.json'], hist = objs['history.json'], snap = objs['snapshots.json'];
  const c = { livePools: null, histPools: null, histRows: null, days: null, snapPools: null, snapRows: null };
  if (live && Array.isArray(live.pools)) c.livePools = live.pools.length;
  if (hist && isObj(hist.pools)) {
    const pools = Object.values(hist.pools), days = new Set();
    c.histPools = pools.length;
    c.histRows = pools.reduce((n, h) => n + (h.h?.length || 0) + (h.d?.length || 0) + (h.y?.length || 0), 0);
    for (const h of pools) for (const r of [...(h.d || []), ...(h.y || [])]) if (isNum(r?.[0])) days.add(Math.floor(r[0] / DAY));
    c.days = days.size;
  }
  if (snap && isObj(snap.pools)) {
    const ps = Object.values(snap.pools);
    c.snapPools = ps.length;
    c.snapRows = ps.reduce((n, s) => n + (s?.h?.t?.length || 0) + (s?.d?.t?.length || 0), 0);
  }
  return c;
}

// ---- checks 1 and 2: the folder, the seals, the shapes, the times ----------------------------------------
// keys: { aes, token } from the repo lock and the passphrase. now/maxAgeH: the age check (skipped when maxAgeH is null).
export function checkBackup({ folder, stamp, repoLock, repoInbox = null, keys, now = Date.now(), maxAgeH = null }) {
  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok: !!ok }); return !!ok; };
  const at = stampTime(stamp);
  check('the stamp is a stamp', at != null);
  const { data, lock } = folder;
  const want = [...DATA_FILES, 'lock.json'];
  const missing = want.filter((n) => !(n in data)).length + ['lock.json', 'inbox.json'].filter((n) => !(n in lock)).length;
  check(`every file is there (${DATA_FILES.length} data files, lock.json, lock/)`, missing === 0);
  check('no unknown files', Object.keys(data).every((n) => want.includes(n) || n === 'inbox.json') && Object.keys(lock).every((n) => ['lock.json', 'inbox.json', 'config.sealed.json'].includes(n)));
  check('lock.json equals the repo lock', isLockFile(parse(data['lock.json'])) && canon(parse(data['lock.json'])) === canon(repoLock));
  check('lock/lock.json equals the repo lock', isLockFile(parse(lock['lock.json'])) && canon(parse(lock['lock.json'])) === canon(repoLock));
  const pub = inboxKeys(keys.token);
  check('lock/inbox.json is the lock\'s inbox key', parse(lock['inbox.json'])?.x25519 === pub.publicB64 && (repoInbox == null || canon(parse(lock['inbox.json'])) === canon(repoInbox)));
  if ('config.sealed.json' in lock) {
    let opened = false;
    try { const env = parse(lock['config.sealed.json']); opened = isInboxEnvelope(env) && inboxOpen(env, pub.privateKey).length > 0; } catch { opened = false; }
    check('lock/config.sealed.json opens with the inbox key', opened);
  }
  const envs = {}, objs = {}, shapes = [];
  let sealed = 0, opened = 0, timesOk = true;
  for (const n of DATA_FILES) {
    if (!(n in data)) continue;
    const env = parse(data[n]);
    if (!isEnvelope(env)) continue;
    sealed++; envs[n] = env;
    let x;
    try { x = JSON.parse(open(env, keys.aes)); opened++; } catch { continue; }
    objs[n] = x;
    if (!isObj(x) || x.v !== 1 || !isNum(x.t)) { shapes.push(`${n}: not v1 with a time`); continue; }
    for (const p of SHAPES[n](x)) shapes.push(`${n}: ${p}`);
    // the envelope's readable t is the file's own (the sealed log is sealed a moment after its t)
    if (!(env.t >= T_FLOOR && env.t <= at + 60e3 + SKEW && env.t <= now + SKEW && Math.abs(env.t - x.t) <= 60e3)) timesOk = false;
  }
  const present = DATA_FILES.filter((n) => n in data).length;
  check('every data file is a sealed envelope', present > 0 && sealed === present);
  check('every data file opens with the lock', present > 0 && opened === present);
  check('every data file is in its docs/DATA.md shape', opened === present && present > 0 && shapes.length === 0);
  check('every time is sane (after 2026-01-01, not after the backup, the sealed t is the file\'s own)', opened > 0 && timesOk);
  if (maxAgeH != null) check(`the backup is recent (at most ${maxAgeH} h old)`, at != null && at <= now + SKEW && now - at <= maxAgeH * 3600e3);
  const newest = Math.max(0, ...Object.values(envs).map((e) => e.t));
  return { ok: checks.every((c) => c.ok), checks, objs, counts: countsOf(objs), ageMin: at == null ? null : Math.round((now - at) / 6e3) / 10,
    lagMin: at != null && newest ? Math.round((at - newest) / 6e3) / 10 : null, shapeProblems: shapes.length, missing };
}

// ---- check 3: the set exactly as the data branch holds it --------------------------------------------------
// One commit with no parent: lock.json and the data files, the backup's own bytes. Returns the commit id.
export function dataCommit(git, folder, message) {
  const entries = [];
  for (const n of [...DATA_FILES, 'lock.json']) {
    if (!(n in folder.data)) throw new Error('missing file: the backup is not a complete set');
    entries.push({ mode: '100644', type: 'blob', sha: git(['hash-object', '-w', '--stdin'], folder.data[n]), name: n });
  }
  const tree = mkTree(git, entries.sort((a, b) => (a.name < b.name ? -1 : 1)));
  const commit = git(['commit-tree', tree, '-m', message]);
  if (git(['rev-list', '--parents', '-n', '1', commit]).split(' ').length !== 1) throw new Error('refusing: the data commit has a parent');
  return commit;
}

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function gitInit(dir, bare = false) { fs.mkdirSync(dir, { recursive: true }); gitIn(dir)(['init', '-q', ...(bare ? ['--bare'] : [])]); return dir; }

// ---- check 4: the loop's own code starts from it ------------------------------------------------------------
// A temp remote whose data branch is the rebuilt set; runLoop restores from it with restoreData, reads the
// counters back, runs one pass that loads every file as the scan does, and publishes as a dry run.
export async function loopStart({ folder, env, say = () => {} }) {
  const root = tmpDir('lps-drill-'), bare = gitInit(path.join(root, 'remote.git'), true), loopDir = gitInit(path.join(root, 'loop'));
  const git = gitIn(loopDir);
  const commit = dataCommit(git, folder, 'Sealed data, rebuilt from a backup (drill)');
  git(['push', '-q', bare, `${commit}:${DATA_BRANCH}`]);
  fs.mkdirSync(path.join(loopDir, 'lock'), { recursive: true });
  fs.writeFileSync(path.join(loopDir, 'lock', 'lock.json'), folder.data['lock.json']);
  const outDir = path.join(loopDir, 'out', 'data');
  const store = openStore({ lockDir: path.join(loopDir, 'lock'), outDir, env });
  const lines = [];
  const tell = (l) => { lines.push(l); say(l); };
  let loaded = null;
  const scanLoad = () => {   // what a pass reads first (scripts/scan.mjs writeOutputs, lib/charts.mjs), nothing more
    const live = store.get('live.json'), hist = store.get('history.json'), snap = store.get('snapshots.json');
    store.get('backtest.json'); store.get('log.json');
    if (!live || !hist || !snap || !((snap.fix ?? 0) >= SNAP_FIX)) return false;
    const m = parseStore(snap); unpackGt(snap.gt); unpackSx(snap.sx); unpackTv(snap.tv);
    loaded = { pools: m.size };
    return true;
  };
  const res = await runLoop({ passCmd: 'drill: load the restored files as a pass does', mode: 'rehearsal', by: 'manual', spacing: 1, deadlineMs: 10 * 60e3, maxPasses: 1, dryRun: true, restore: true }, {
    say: tell, store, now: Date.now, sleep: async () => {}, marker: () => {}, sealedLog: () => null,
    restore: () => restoreData({ repo: loopDir, outDir, lockPath: path.join(loopDir, 'lock', 'lock.json'), remote: bare, env, say: tell }),
    runPass: async () => { try { return { ok: scanLoad(), code: 0, timedOut: false }; } catch { return { ok: false, code: 1, timedOut: false }; } },
    publish: () => publishData({ repo: loopDir, outDir, lockPath: path.join(loopDir, 'lock', 'lock.json'), remote: bare, dryRun: true, env, say: tell }),
  });
  const restored = Number(/files restored into the output folder: (\d+)/.exec(lines.join('\n'))?.[1] ?? -1);
  fs.rmSync(root, { recursive: true, force: true });
  return { restored, passOk: res.ok === 1, counters: res.restored24, loaded, commit };
}

// ---- check 5: counts against the live data branch -----------------------------------------------------------
export function liveCounts({ dir, keys }) {
  const objs = {};
  let t = null;
  for (const n of DATA_FILES) {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) continue;
    try { const env = JSON.parse(fs.readFileSync(f, 'utf8')); objs[n] = JSON.parse(open(env, keys.aes)); if (n === 'live.json') t = env.t; } catch { /* unread: null counts */ }
  }
  return { counts: countsOf(objs), t };
}
// Each count within 25% of the live one (both present), and the backup not newer than the live data.
export function compareCounts(b, l) {
  const keys = Object.keys(b).filter((k) => b[k] != null && l[k] != null);
  const off = keys.filter((k) => Math.abs(b[k] - l[k]) > 0.25 * Math.max(b[k], l[k]));
  return { ok: keys.length === Object.keys(b).length && off.length === 0, compared: keys.length, off: off.length };
}

const COUNT_LABELS = { livePools: 'live.json pools', histPools: 'history pools', histRows: 'history rows', days: 'days', snapPools: 'snapshot pools', snapRows: 'snapshot rows' };

export async function drill({ dir, stamp, lockDir = 'lock', liveDir = null, maxAgeH = 2, label = 'backup', env = process.env, now = Date.now(), say = console.log }) {
  const repoLock = readLock(lockDir);
  const keys = unlock(repoLock, passphraseFrom(env));
  let repoInbox = null;
  try { repoInbox = JSON.parse(fs.readFileSync(path.join(lockDir, 'inbox.json'), 'utf8')); } catch { repoInbox = null; }
  const folder = readFolder(dir);
  const c = checkBackup({ folder, stamp, repoLock, repoInbox, keys, now, maxAgeH });
  say(`drill ${label} ${stamp}: ${c.ageMin} min old; its newest file sealed ${c.lagMin ?? '—'} min before it`);
  for (const k of c.checks) say(`drill ${label}: ${k.name}: ${k.ok ? 'pass' : 'FAIL'}`);
  const checks = [...c.checks];
  if (c.missing === 0 && c.checks.find((k) => k.name.startsWith('every data file opens'))?.ok) {
    let ls = null;
    try { ls = await loopStart({ folder, env }); } catch (e) { say(`drill ${label}: rebuild failed: ${safeMsg(e)}`); }
    const a = { name: `rebuilt as the data branch and restored by the loop's own code (${DATA_FILES.length} files)`, ok: !!ls && ls.restored === DATA_FILES.length };
    const b = { name: 'a dry-run pass starts from it (counters read, every file loads as the scan reads it, publish dry run)', ok: !!ls && ls.passOk && !!ls.loaded };
    checks.push(a, b);
    say(`drill ${label}: ${a.name}: ${a.ok ? 'pass' : 'FAIL'}${ls ? `; files restored ${ls.restored}` : ''}`);
    say(`drill ${label}: ${b.name}: ${b.ok ? 'pass' : 'FAIL'}${ls ? `; counters restored: ${ls.counters} passes in the last 24 h; snapshot pools loaded ${ls.loaded?.pools ?? '—'}` : ''}`);
  }
  const cs = Object.entries(c.counts).map(([k, v]) => `${COUNT_LABELS[k]} ${v ?? '—'}`).join(', ');
  say(`drill ${label}: counts in the backup: ${cs}`);
  if (liveDir) {
    const l = liveCounts({ dir: liveDir, keys });
    const cmp = compareCounts(c.counts, l.counts);
    const newer = l.t != null && Object.values(c.objs).every((x) => !isNum(x?.t) || x.t <= l.t + SKEW);
    say(`drill ${label}: counts on the live data branch now: ${Object.entries(l.counts).map(([k, v]) => `${COUNT_LABELS[k]} ${v ?? '—'}`).join(', ')}; live data ${l.t ? Math.round((now - l.t) / 6e3) / 10 : '—'} min old`);
    const k = { name: 'counts within 25% of the live data branch, and the backup not newer than it', ok: cmp.ok && newer };
    checks.push(k);
    say(`drill ${label}: ${k.name}: ${k.ok ? 'pass' : 'FAIL'} (${cmp.compared} counts compared, ${cmp.off} apart)`);
  }
  const ok = checks.every((k) => k.ok);
  say(`drill ${label}: ${checks.filter((k) => k.ok).length} of ${checks.length} checks pass; restore drill: ${ok ? 'pass' : 'FAIL'}`);
  return { ok, checks, counts: c.counts };
}

// ---- the guarded restore ---------------------------------------------------------------------------------------
export function restoreRefOk(spec) {
  const m = /^([0-9a-f]{40}):(refs\/[A-Za-z0-9._/-]+)$/.exec(String(spec));
  return !!m && (m[2] === DATA_BRANCH || PRE_RESTORE_RE.test(m[2]));
}
const tagStamp = (t) => stampOf(t).replace(/-/g, '');   // 20261115T0930Z

const ghCall = (args) => spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
export function loopActive({ repo, gh = ghCall }) {
  const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
  const r = gh(['api', `repos/${repo}/actions/workflows/loop.yml/runs?per_page=30`]);
  try { if (r.status === 0) return JSON.parse(r.stdout).workflow_runs.filter((x) => ACTIVE.has(x.status)).length; } catch { /* unread */ }
  return null;
}

export function restore({ dir, stamp, lockDir = 'lock', repo = '.', remote, apply = false, confirm = '', env = process.env, now = Date.now(), active = null, say = console.log }) {
  if (!remote) throw new Error('missing remote: name the remote to restore');
  const repoLock = readLock(lockDir);
  const keys = unlock(repoLock, passphraseFrom(env));
  const folder = readFolder(dir);
  const c = checkBackup({ folder, stamp, repoLock, keys, now, maxAgeH: null });
  for (const k of c.checks) say(`restore: ${k.name}: ${k.ok ? 'pass' : 'FAIL'}`);
  say(`restore: backup ${stamp}, ${c.ageMin} min old; counts: ${Object.entries(c.counts).map(([k, v]) => `${COUNT_LABELS[k]} ${v ?? '—'}`).join(', ')}`);
  if (!c.ok) throw new Error('refusing: the backup failed its checks; nothing restored');
  if (apply && confirm !== confirmText(stamp)) throw new Error('refusing: the confirmation does not match; nothing restored');
  const git = gitIn(repo);
  const commit = dataCommit(git, folder, `Sealed data, restored from backup ${stamp}`);
  const line = git(['ls-remote', '--heads', remote, DATA_BRANCH]);
  const old = line ? line.split(/\s+/)[0] : null;
  say(`restore: rebuilt as one commit with no parent (${DATA_FILES.length + 1} files); the data branch is ${old ? 'there' : 'missing'}; loop runs queued or in progress: ${active ?? 'unread'}`);
  let tag = `refs/tags/data-pre-restore-${tagStamp(now)}`;
  for (let i = 2; git(['ls-remote', remote, tag]) && i < 100; i++) tag = `refs/tags/data-pre-restore-${tagStamp(now)}-${i}`;
  if (!apply) {
    say(`restore: dry run; would ${old ? `tag the data branch's tip as ${tag.slice(10)}, then ` : ''}replace the data branch with backup ${stamp}${active === 0 ? '' : ' (a real restore would refuse now: the loop must be stopped first)'}; pushed: no`);
    return { dryRun: true, commit, old };
  }
  if (active !== 0) throw new Error('refusing: a loop run is queued or in progress (or unread): stop the loop first; nothing restored');
  const push = (spec, lease) => {
    if (!restoreRefOk(spec)) throw new Error('refusing: a push to anything but the data branch or its pre-restore tag');
    git(['push', '--porcelain', ...(lease !== undefined ? [`--force-with-lease=${DATA_BRANCH}:${lease}`] : []), remote, spec]);
  };
  if (old) {
    push(`${old}:${tag}`);
    if (git(['ls-remote', remote, tag]).split(/\s+/)[0] !== old) throw new Error('refusing: the pre-restore tag did not read back; the data branch is unchanged');
    say('restore: pre-restore tag pushed and read back: yes');
  }
  try { push(`${commit}:${DATA_BRANCH}`, old || ''); } catch (e) { if (/^refusing/.test(e.message)) throw e; throw new Error('refusing: the data branch moved after it was tagged; nothing restored (run again)'); }
  if (git(['ls-remote', '--heads', remote, DATA_BRANCH]).split(/\s+/)[0] !== commit) throw new Error('bad push: the data branch does not point at the restored commit');
  const back = tmpDir('lps-restore-');
  gitInit(back);
  const r = restoreData({ repo: back, outDir: path.join(back, 'out'), lockPath: path.resolve(lockDir, 'lock.json'), remote: path.isAbsolute(remote) || /:\/\//.test(remote) ? remote : git(['remote', 'get-url', remote]), env, say: () => {} });
  fs.rmSync(back, { recursive: true, force: true });
  if (r.copied !== DATA_FILES.length) throw new Error('bad restore: the restored data branch did not read back with the lock');
  say(`restore: data branch replaced with backup ${stamp} and read back with the lock (${r.copied} files): yes; pushed: yes`);
  return { dryRun: false, commit, old, tag: old ? tag : null };
}

// ---- command line --------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  try {
    if (argv[0] === 'drill') {
      const r = await drill({ dir: arg('--backup'), stamp: arg('--stamp'), lockDir: arg('--lock', 'lock'), liveDir: arg('--live', null),
        maxAgeH: Number(arg('--max-age-h', 2)), label: arg('--label', 'backup') });
      process.exitCode = r.ok ? 0 : 1;
    } else if (argv[0] === 'restore') {
      const apply = argv.includes('--apply');
      const active = process.env.GITHUB_REPOSITORY ? loopActive({ repo: process.env.GITHUB_REPOSITORY }) : null;
      restore({ dir: arg('--backup'), stamp: arg('--stamp'), lockDir: arg('--lock', 'lock'), remote: arg('--remote', 'origin'), apply, confirm: arg('--confirm', ''), active });
    } else {
      throw new Error('bad command: drill or restore');
    }
  } catch (e) {
    console.log(`restore failed: ${safeMsg(e)}`);
    process.exitCode = 1;
  }
}
