// Publish the sealed output files to the `data` branch as ONE orphan commit that replaces the last one
// (force-push to `data` only; the owner approved overwriting that branch each pass). Data never lands
// on a code branch. Before anything is pushed: the passphrase must open lock.json, and every file must
// be a known data file sealed under that lock. Files this pass didn't write (e.g. backtest.json from
// the daily job) are carried forward from the current data branch, so one job never deletes another's.
// Key slots (lib/keyring.mjs): the loop (ownKeys) publishes its own keys.json; every other job keeps the data
// branch's. Each market file is sealed under the data key that keys.json's owner slot holds (sealed again, with
// owner-only fields split off, if a job sealed it under an earlier key), each other file under the lock's key.
//   node scripts/publish-data.mjs [--dry-run] [--own-keys] [--out out/data] [--lock lock/lock.json] [--remote origin]
//                                 --own-keys: this folder's keys.json is published (the loop's; other jobs keep the branch's)
//   node scripts/publish-data.mjs --restore      copy the data branch's files into out/data (for update())
// Prints counts and yes/no only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isEnvelope, isLockFile, open, passphraseFrom, seal, unlock } from '../lib/lock.mjs';
import { ALL_FILES, OUT_DIR, checkSealedDir } from '../lib/store.mjs';
import { KEYS_FILE, isKeysFile, isMarket, ownerRing, privateIn, readKeysFile, splitPrivate, uniq } from '../lib/keyring.mjs';

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

// Read the current data branch: { sha, lock, keys, ring, keysBlob, files: Map(name -> { blob, env, text }) } or null if
// it doesn't exist. Every sealed file must open with the lock's key, the data branch's own data keys or `extra`.
function readRemoteData(git, remote, aes, extra = []) {
  const line = git(['ls-remote', '--heads', remote, `refs/heads/${DATA_BRANCH}`]);
  if (!line) return null;
  const sha = line.split(/\s+/)[0];
  git(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${DATA_BRANCH}:${OLD_REF}`]);
  const files = new Map();
  let lock = null, keys = null, keysBlob = null;
  for (const ent of git(['ls-tree', '-z', OLD_REF]).split('\0').filter(Boolean)) {
    const [meta, name] = ent.split('\t');
    const blob = meta.split(' ')[2];
    const text = git(['cat-file', 'blob', blob]);
    let x;
    try { x = JSON.parse(text); } catch { throw new Error('refusing: the data branch holds a file that is not JSON'); }
    if (name === LOCK_NAME) { if (!isLockFile(x)) throw new Error('refusing: the data branch holds a bad lock.json'); lock = x; continue; }
    if (name === KEYS_FILE) { if (!isKeysFile(x)) throw new Error('refusing: the data branch holds a bad keys.json'); keys = x; keysBlob = blob; continue; }
    if (!ALL_FILES.includes(name)) throw new Error('refusing: the data branch holds an unknown file');
    if (!isEnvelope(x)) throw new Error('refusing: the data branch holds a file that is not sealed');
    files.set(name, { blob, env: x, text });
  }
  let ring = null;
  if (keys) { try { ring = ownerRing(aes, keys); } catch { throw new Error('refusing: the data branch holds a keys.json that does not open with this lock'); } }
  const known = uniq([aes, ring?.dek, ...(ring?.prev || []), ...extra]);
  for (const f of files.values()) if (!known.some((k) => { try { open(f.env, k); return true; } catch { return false; } })) throw new Error('refusing: a file on the data branch does not open with this lock');
  return { sha, lock, keys, ring, keysBlob, files };
}

// ownKeys: this job's keys.json is the one to publish (the loop, which alone adds guests and rotates the data key).
export function publishData({ repo = '.', outDir = OUT_DIR, lockPath = path.join('lock', LOCK_NAME), remote = 'origin', branch = DATA_BRANCH,
  dryRun = false, env = process.env, say = console.log, tries = 4, now = Date.now(), keepNewer = true, ownKeys = false } = {}) {
  assertDataBranch(branch);
  const abs = (p) => path.resolve(repo, p);
  if (!fs.existsSync(abs(lockPath))) throw new Error('missing lock: no lock.json to publish with');
  let lockFile;
  try { lockFile = JSON.parse(fs.readFileSync(abs(lockPath), 'utf8')); } catch { throw new Error('bad lock: lock.json is not JSON'); }
  if (!isLockFile(lockFile)) throw new Error('bad lock: lock.json is not a lock file');
  const { aes } = unlock(lockFile, passphraseFrom(env)); // a wrong passphrase stops here, before anything moves
  const localKeys = readKeysFile(abs(outDir));
  const localRing = localKeys ? ownerRing(aes, localKeys) : null; // a keys.json that doesn't open with the lock stops here
  const names = checkSealedDir(abs(outDir), aes);
  if (!names.length) throw new Error('missing data: no sealed files in the output folder');
  const git = makeGit(repo);
  const inGit = git(['rev-parse', '--is-inside-work-tree'], { allowFail: true }) === 'true';
  if (inGit && git(['ls-files', '--', 'out'])) throw new Error('refusing: output files are tracked on the code branch');
  say(`sealed files ready: ${names.length} (${names.join(', ')}); every one opens with the lock: yes${localKeys ? `; keys file: yes (${localKeys.slots.length} guest slots)` : ''}`);
  if (dryRun) {
    say(`dry run: would replace the "${branch}" branch with one commit (no parent) of ${names.length + 1} files or more; nothing pushed`);
    return { dryRun: true, files: names.length + 1 };
  }
  if (!inGit) throw new Error('missing repo: not inside a git work tree');
  const hashText = (text) => git(['hash-object', '-w', '--stdin'], { input: text });
  for (let attempt = 1; attempt <= tries; attempt++) {
    const old = readRemoteData(git, remote, aes, localRing ? [localRing.dek, ...localRing.prev] : []);
    if (old?.lock && !sameLock(old.lock, lockFile)) throw new Error('refusing: the data branch carries a different lock');
    if (ownKeys && localKeys && old?.keys && old.keys.gsalt !== localKeys.gsalt) throw new Error('refusing: the data branch carries a different guest salt (a second migration?)');
    // the keys this commit carries: the loop's own, else the data branch's, else none (every file under the lock's key)
    const target = ownKeys && localKeys ? 'local' : old?.keys ? 'remote' : null;
    const tRing = target === 'local' ? localRing : target === 'remote' ? old.ring : null;
    const keyFor = (n) => (isMarket(n) && tRing ? tRing.dek : aes);
    const known = uniq([aes, tRing?.dek, ...(tRing?.prev || []), localRing?.dek, ...(localRing?.prev || []), old?.ring?.dek, ...(old?.ring?.prev || [])]);
    let resealed = 0;
    // a file's blob under its own key: kept as it is when it opens with that key (and a market file has no owner-only
    // field), else opened with any key of this lock and sealed again (same t); nothing is published unchecked
    const blobOf = (n, text, blob = null) => {
      const env = JSON.parse(text), want = keyFor(n);
      let plain = null;
      try { plain = open(env, want); } catch { plain = null; }
      const clean = plain != null && !(isMarket(n) && tRing && privateIn(n, JSON.parse(plain)).length);
      if (clean) return blob || hashText(text);
      if (plain == null) for (const k of known) { try { plain = open(env, k); break; } catch { plain = null; } }
      if (plain == null) throw new Error('refusing: a file does not open with any key of this lock');
      if (isMarket(n) && tRing) plain = JSON.stringify(splitPrivate(n, JSON.parse(plain)).market);
      resealed++;
      return hashText(JSON.stringify(seal(plain, want, { t: env.t, gzip: !!env.z })));
    };
    const entries = new Map();
    entries.set(LOCK_NAME, git(['hash-object', '-w', abs(lockPath)]));
    if (target === 'local') entries.set(KEYS_FILE, git(['hash-object', '-w', path.join(abs(outDir), KEYS_FILE)]));
    else if (target === 'remote') entries.set(KEYS_FILE, old.keysBlob);
    // the newest copy of each file wins: a job that restored another job's file at its start never
    // replaces the newer copy that job has published since (e.g. the loop and the daily backtest)
    let carried = 0, keptNewer = 0;
    for (const n of names) {
      const f = old?.files.get(n), text = fs.readFileSync(path.join(abs(outDir), n), 'utf8'), localT = JSON.parse(text).t;
      if (keepNewer && f && f.env.t > localT) { entries.set(n, blobOf(n, f.text, f.blob)); keptNewer++; continue; }
      entries.set(n, blobOf(n, text));
    }
    for (const [n, f] of old?.files || []) if (!entries.has(n)) { entries.set(n, blobOf(n, f.text, f.blob)); carried++; }
    const tree = git(['mktree'], { input: [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, b]) => `100644 blob ${b}\t${n}\n`).join('') });
    const commit = git(['commit-tree', tree, '-m', `Sealed data, pass of ${new Date(now).toISOString().slice(0, 16)}Z`]);
    if (git(['rev-list', '--parents', '-n', '1', commit]).split(' ').length !== 1) throw new Error('refusing: the data commit has a parent');
    const pushed = git(['push', '--quiet', `--force-with-lease=refs/heads/${DATA_BRANCH}:${old?.sha || ''}`, remote, `${commit}:refs/heads/${DATA_BRANCH}`], { allowFail: true });
    if (pushed !== null) {
      const now2 = git(['ls-remote', '--heads', remote, `refs/heads/${DATA_BRANCH}`]).split(/\s+/)[0];
      if (now2 !== commit) throw new Error('bad push: the data branch does not point at the new commit');
      say(`published: yes, ${entries.size} files (${carried} carried forward${keptNewer ? `, ${keptNewer} newer on the branch kept` : ''}${resealed ? `, ${resealed} sealed again under the current key` : ''}), one commit with no parent, attempt ${attempt}`);
      return { dryRun: false, files: entries.size, carried, keptNewer, resealed, keys: target, commit, attempts: attempt };
    }
    if (attempt < tries) sleepMs(2000 * 2 ** (attempt - 1));
  }
  throw new Error(`bad push: the data branch push failed ${tries} times`);
}

// Copy the data branch's sealed files (and keys.json) into out/data where this pass has none yet (so update()
// can append to history.json). Every copied file must open with the lock or the data branch's own data keys.
// Returns { copied, present (the data branch exists), keys (it carries keys.json) }.
export function restoreData({ repo = '.', outDir = OUT_DIR, lockPath = path.join('lock', LOCK_NAME), remote = 'origin', env = process.env, say = console.log } = {}) {
  const abs = (p) => path.resolve(repo, p);
  let lockFile;
  try { lockFile = JSON.parse(fs.readFileSync(abs(lockPath), 'utf8')); } catch { throw new Error('missing lock: no readable lock.json'); }
  if (!isLockFile(lockFile)) throw new Error('bad lock: lock.json is not a lock file');
  const { aes } = unlock(lockFile, passphraseFrom(env));
  const old = readRemoteData(makeGit(repo), remote, aes);
  let copied = 0, keysCopied = false;
  const put = (n, text) => {
    const file = path.join(abs(outDir), n);
    if (fs.existsSync(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return true;
  };
  if (old?.keys) keysCopied = put(KEYS_FILE, JSON.stringify(old.keys));
  for (const [n, f] of old?.files || []) if (put(n, f.text)) copied++;
  say(`data branch present: ${old ? 'yes' : 'no'}; files restored into the output folder: ${copied}${old?.keys ? `; keys file ${keysCopied ? 'restored' : 'already here'}` : ''}`);
  return { copied, present: !!old, keys: !!old?.keys };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const opts = { outDir: arg('--out') || OUT_DIR, lockPath: arg('--lock') || path.join('lock', LOCK_NAME), remote: arg('--remote') || 'origin', repo: arg('--repo') || '.' };
  try {
    if (argv.includes('--restore')) restoreData(opts);
    else publishData({ ...opts, branch: arg('--branch') || DATA_BRANCH, dryRun: argv.includes('--dry-run'), ownKeys: argv.includes('--own-keys') });
  } catch (e) {
    const m = String(e?.message || '');
    console.log(`publish-data failed: ${/^(missing|bad|refusing|wrong|not a data file|[a-z]+\.json:)/.test(m) ? m : e?.code || e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
