// Publish the sealed output files to the `data` branch as ONE orphan commit that replaces the last one
// (force-push to `data` only; the owner approved overwriting that branch each pass). Data never lands
// on a code branch. Before anything is pushed: the passphrase must open lock.json, and every file must
// be a known data file sealed under that lock. Files this pass didn't write (e.g. backtest.json from
// the daily job) are carried forward from the current data branch, so one job never deletes another's.
//   node scripts/publish-data.mjs [--dry-run] [--out out/data] [--lock lock/lock.json] [--remote origin]
//   node scripts/publish-data.mjs --restore      copy the data branch's files into out/data (for update())
// Prints counts and yes/no only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isEnvelope, isLockFile, open, passphraseFrom, unlock } from '../lib/lock.mjs';
import { DATA_FILES, OUT_DIR, checkSealedDir } from '../lib/store.mjs';

export const DATA_BRANCH = 'data';
const LOCK_NAME = 'lock.json';
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const OLD_REF = 'refs/lps/data-old';

export function assertDataBranch(branch) {
  if (branch !== DATA_BRANCH) throw new Error(`refusing: data goes only to the "${DATA_BRANCH}" branch, never to a code branch`);
  return branch;
}

function makeGit(repo) {
  return (args, { input, allowFail = false } = {}) => {
    const r = spawnSync('git', args, {
      cwd: repo, input, encoding: input instanceof Buffer ? undefined : 'utf8', maxBuffer: 1 << 30,
      env: { ...process.env, GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email, GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.status !== 0) { if (allowFail) return null; throw new Error(`git ${args[0]} failed`); }
    return typeof r.stdout === 'string' ? r.stdout.trim() : r.stdout;
  };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sameLock = (a, b) => a.salt === b.salt && a.iter === b.iter && a.check.iv === b.check.iv && a.check.ct === b.check.ct;

// Read the current data branch: { sha, lock, files: Map(name -> { blob, env }) } or null if it doesn't exist.
function readRemoteData(git, remote, aes) {
  const line = git(['ls-remote', '--heads', remote, `refs/heads/${DATA_BRANCH}`]);
  if (!line) return null;
  const sha = line.split(/\s+/)[0];
  git(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${DATA_BRANCH}:${OLD_REF}`]);
  const files = new Map();
  let lock = null;
  for (const ent of git(['ls-tree', '-z', OLD_REF]).split('\0').filter(Boolean)) {
    const [meta, name] = ent.split('\t');
    const blob = meta.split(' ')[2];
    let x;
    try { x = JSON.parse(git(['cat-file', 'blob', blob])); } catch { throw new Error('refusing: the data branch holds a file that is not JSON'); }
    if (name === LOCK_NAME) { if (!isLockFile(x)) throw new Error('refusing: the data branch holds a bad lock.json'); lock = x; continue; }
    if (!DATA_FILES.includes(name)) throw new Error('refusing: the data branch holds an unknown file');
    if (!isEnvelope(x)) throw new Error('refusing: the data branch holds a file that is not sealed');
    try { open(x, aes); } catch { throw new Error('refusing: a file on the data branch does not open with this lock'); }
    files.set(name, { blob, env: x });
  }
  return { sha, lock, files };
}

export function publishData({ repo = '.', outDir = OUT_DIR, lockPath = path.join('lock', LOCK_NAME), remote = 'origin', branch = DATA_BRANCH,
  dryRun = false, env = process.env, say = console.log, tries = 4, now = Date.now() } = {}) {
  assertDataBranch(branch);
  const abs = (p) => path.resolve(repo, p);
  if (!fs.existsSync(abs(lockPath))) throw new Error('missing lock: no lock.json to publish with');
  let lockFile;
  try { lockFile = JSON.parse(fs.readFileSync(abs(lockPath), 'utf8')); } catch { throw new Error('bad lock: lock.json is not JSON'); }
  if (!isLockFile(lockFile)) throw new Error('bad lock: lock.json is not a lock file');
  const { aes } = unlock(lockFile, passphraseFrom(env)); // a wrong passphrase stops here, before anything moves
  const names = checkSealedDir(abs(outDir), aes);
  if (!names.length) throw new Error('missing data: no sealed files in the output folder');
  const git = makeGit(repo);
  const inGit = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
  if (inGit && git(['ls-files', '--', 'out'])) throw new Error('refusing: output files are tracked on the code branch');
  say(`sealed files ready: ${names.length} (${names.join(', ')}); every one opens with the lock: yes`);
  if (dryRun) {
    say(`dry run: would replace the "${branch}" branch with one commit (no parent) of ${names.length + 1} files; nothing pushed`);
    return { dryRun: true, files: names.length + 1 };
  }
  if (!inGit) throw new Error('missing repo: not inside a git work tree');
  for (let attempt = 1; attempt <= tries; attempt++) {
    const old = readRemoteData(git, remote, aes);
    if (old?.lock && !sameLock(old.lock, lockFile)) throw new Error('refusing: the data branch carries a different lock');
    const entries = new Map();
    entries.set(LOCK_NAME, git(['hash-object', '-w', abs(lockPath)]));
    for (const n of names) entries.set(n, git(['hash-object', '-w', path.join(abs(outDir), n)]));
    let carried = 0;
    for (const [n, f] of old?.files || []) if (!entries.has(n)) { entries.set(n, f.blob); carried++; }
    const tree = git(['mktree'], { input: [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, b]) => `100644 blob ${b}\t${n}\n`).join('') });
    const commit = git(['commit-tree', tree, '-m', `Sealed data, pass of ${new Date(now).toISOString().slice(0, 16)}Z`]);
    if (git(['rev-list', '--parents', '-n', '1', commit]).split(' ').length !== 1) throw new Error('refusing: the data commit has a parent');
    const pushed = git(['push', '--quiet', `--force-with-lease=refs/heads/${DATA_BRANCH}:${old?.sha || ''}`, remote, `${commit}:refs/heads/${DATA_BRANCH}`], { allowFail: true });
    if (pushed !== null) {
      const now2 = git(['ls-remote', '--heads', remote, `refs/heads/${DATA_BRANCH}`]).split(/\s+/)[0];
      if (now2 !== commit) throw new Error('bad push: the data branch does not point at the new commit');
      say(`published: yes, ${entries.size} files (${carried} carried forward), one commit with no parent, attempt ${attempt}`);
      return { dryRun: false, files: entries.size, carried, commit, attempts: attempt };
    }
    if (attempt < tries) sleepMs(2000 * 2 ** (attempt - 1));
  }
  throw new Error(`bad push: the data branch push failed ${tries} times`);
}

// Copy the data branch's sealed files into out/data where this pass has none yet (so update() can
// append to history.json). Every copied file must open with the lock.
export function restoreData({ repo = '.', outDir = OUT_DIR, lockPath = path.join('lock', LOCK_NAME), remote = 'origin', env = process.env, say = console.log } = {}) {
  const abs = (p) => path.resolve(repo, p);
  let lockFile;
  try { lockFile = JSON.parse(fs.readFileSync(abs(lockPath), 'utf8')); } catch { throw new Error('missing lock: no readable lock.json'); }
  if (!isLockFile(lockFile)) throw new Error('bad lock: lock.json is not a lock file');
  const { aes } = unlock(lockFile, passphraseFrom(env));
  const old = readRemoteData(makeGit(repo), remote, aes);
  let copied = 0;
  for (const [n, f] of old?.files || []) {
    const file = path.join(abs(outDir), n);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(f.env));
    copied++;
  }
  say(`data branch present: ${old ? 'yes' : 'no'}; files restored into the output folder: ${copied}`);
  return { copied };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const opts = { outDir: arg('--out') || OUT_DIR, lockPath: arg('--lock') || path.join('lock', LOCK_NAME), remote: arg('--remote') || 'origin', repo: arg('--repo') || '.' };
  try {
    if (argv.includes('--restore')) restoreData(opts);
    else publishData({ ...opts, branch: arg('--branch') || DATA_BRANCH, dryRun: argv.includes('--dry-run') });
  } catch (e) {
    const m = String(e?.message || '');
    console.log(`publish-data failed: ${/^(missing|bad|refusing|wrong|not a data file|[a-z]+\.json:)/.test(m) ? m : e?.code || e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
