// Leak check: planted private strings in an old file version on another branch, a commit message, a
// file name, a ref name and a run log must each be found; a clean repo passes. Made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { buildNeedles, hits, leakCheck, scanGit, scanRunLogs, unzip } from '../scripts/leak-check.mjs';
import { initLock } from '../lib/lock.mjs';
import { inboxSeal, readInboxKey } from '../lib/inbox.mjs';

const SECRET = 'made-up-api-key-QWERTY-7531';
const WALLET = '0x00000000000000000000000000000000DeadBeef';
const DUMMY = 'dummy passphrase for leak tests';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-leak-'));
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout; };
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'public text only\n');
  g('add', '.'); g('commit', '-q', '-m', 'Start');
  return { dir, g, write: (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); } };
}

// A zip writer for the test (stored and deflate), so the reader is checked on both kinds.
function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text), body = deflate ? zlib.deflateRawSync(data) : data, nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(zlib.crc32(data), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(zlib.crc32(data), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nm, body); central.push(c, nm);
    off += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

const needles = () => buildNeedles({ leakSensitive: [WALLET, 'abc'], secrets: { COINGECKO_KEY: SECRET, github_token: 'ghs_madeupmadeup', SHORT: '12' } });

test('needles: config strings and secrets, addresses also unprefixed, short ones counted', () => {
  const n = needles();
  assert.deepEqual(n.counts, { config: 1, secrets: 1, short: 2 });
  assert.equal(n.needles.length, 3, 'wallet, wallet without 0x, secret; github_token skipped');
  assert.equal(hits(Buffer.from('topic 000000000000000000000000' + WALLET.slice(2).toLowerCase()), n.needles), 1);
  assert.equal(hits(Buffer.from('nothing here'), n.needles), 0);
});

test('a clean repo passes', () => {
  const r = repo();
  r.write('lib/x.mjs', 'export const a = 1;\n'); r.g('add', '.'); r.g('commit', '-q', '-m', 'Add code');
  const g = scanGit(r.dir, needles().needles);
  assert.equal(g.found, 0);
  assert.ok(g.objects >= 6);
});

test('planted faults: each place a leak can hide is found', () => {
  const places = {
    'old file version on another branch': (r) => { r.g('checkout', '-q', '-b', 'side'); r.write('cfg.txt', `key=${SECRET}\n`); r.g('add', '.'); r.g('commit', '-q', '-m', 'Oops'); r.g('rm', '-q', 'cfg.txt'); r.g('commit', '-q', '-m', 'Remove'); r.g('checkout', '-q', 'main'); },
    'commit message': (r) => { r.write('a.txt', 'x\n'); r.g('add', '.'); r.g('commit', '-q', '-m', `Track ${WALLET.toLowerCase()}`); },
    'file name': (r) => { r.write(`notes/${WALLET}.txt`, 'x\n'); r.g('add', '.'); r.g('commit', '-q', '-m', 'Notes'); },
    'ref name': (r) => { r.g('branch', `wip-${SECRET}`); },
    'tag message': (r) => { r.g('tag', '-a', 'v0', '-m', `release for ${SECRET}`); },
  };
  for (const [what, plant] of Object.entries(places)) {
    const r = repo();
    plant(r);
    assert.ok(scanGit(r.dir, needles().needles).found >= 1, `missed a leak in: ${what}`);
  }
});

test('zip reader: stored and deflate entries', () => {
  const z = zip([['1_job.txt', 'hello stored', false], ['2_job.txt', 'hello deflated '.repeat(50), true]]);
  const e = unzip(z);
  assert.deepEqual(e.map((x) => x.name), ['1_job.txt', '2_job.txt']);
  assert.equal(e[1].data.toString(), 'hello deflated '.repeat(50));
  assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /bad zip/);
});

// A fake GitHub API: runs list (2 pages), log redirects, one log deleted, one in progress.
function fakeGitHub({ leakyRun = null, failRun = null } = {}) {
  const runs = Array.from({ length: 103 }, (_, i) => ({ id: i + 1, status: i === 0 ? 'in_progress' : 'completed', created_at: '2026-10-30T00:00:00Z' }));
  const api = async (method, p) => {
    let m = p.match(/runs\?per_page=(\d+)&page=(\d+)/);
    if (m) { const [n, pg] = [Number(m[1]), Number(m[2])]; return { status: 200, json: { total_count: runs.length, workflow_runs: runs.slice((pg - 1) * n, pg * n) } }; }
    m = p.match(/runs\/(\d+)\/logs/);
    if (m) {
      const id = Number(m[1]);
      if (id === 7) return { status: 404, json: null, headers: { get: () => null } };
      return { status: 302, json: null, headers: { get: (h) => (h === 'location' ? `https://storage.example/${id}` : null) } };
    }
    return { status: 404 };
  };
  const fetchFn = async (url) => {
    const id = Number(url.split('/').pop());
    if (id === failRun) return { ok: false, status: 500 };
    const text = id === leakyRun ? `2026-10-30T00:00:00Z ##[error]RPC failed for ${WALLET}` : '2026-10-30T00:00:00Z all good';
    return { ok: true, arrayBuffer: async () => { const b = zip([['job/1_step.txt', text, id % 2 === 0]]); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
  };
  return { api, fetchFn };
}

test('run logs: every page listed, in-progress skipped, deleted logs counted, a planted leak found', async () => {
  const clean = fakeGitHub();
  let r = await scanRunLogs({ ...clean, repo: 'o/r', needles: needles().needles, maxRuns: 500 });
  assert.deepEqual(r, { runs: 102, read: 101, gone: 1, unread: 0, found: 0 });
  r = await scanRunLogs({ ...fakeGitHub({ leakyRun: 88 }), repo: 'o/r', needles: needles().needles, maxRuns: 500 });
  assert.equal(r.found, 1);
  r = await scanRunLogs({ ...fakeGitHub({ failRun: 5 }), repo: 'o/r', needles: needles().needles, maxRuns: 500 });
  assert.equal(r.unread, 1, 'an unreadable log is unread, not clean');
});

test('the whole check: counts only in its output; fails on a find or on unread logs', async () => {
  const r = repo();
  const lockDir = path.join(r.dir, 'lock');
  initLock({ dir: lockDir, passphrase: DUMMY, iterations: 1000 });
  fs.writeFileSync(path.join(lockDir, 'config.sealed.json'), JSON.stringify(inboxSeal(JSON.stringify({ leakSensitive: [WALLET] }), readInboxKey(lockDir))));
  r.g('add', '.'); r.g('commit', '-q', '-m', 'Add the lock');
  const env = { LOCK_PASSPHRASE: DUMMY, ALL_SECRETS: JSON.stringify({ LOCK_PASSPHRASE: DUMMY, COINGECKO_KEY: SECRET, github_token: 'x' }), GITHUB_REPOSITORY: 'o/r' };
  const lines = [];
  const say = (l) => lines.push(l);
  let res = await leakCheck({ repo: r.dir, env, ...fakeGitHub(), say });
  assert.equal(res.found, 0);
  assert.equal(res.complete, true);
  assert.match(lines.join('\n'), /sealed config present: yes/);
  assert.match(lines.join('\n'), /private strings searched: 4 \(sealed config 1, secrets 2/);
  for (const s of [DUMMY, SECRET, WALLET, WALLET.slice(2)]) assert.ok(!lines.join('\n').toLowerCase().includes(s.toLowerCase()), 'printed a private string');
  // planted leaks: the passphrase in a file, the wallet in a run log
  r.write('debug.txt', `pass=${DUMMY}\n`); r.g('add', '.'); r.g('commit', '-q', '-m', 'Debug');
  res = await leakCheck({ repo: r.dir, env, ...fakeGitHub({ leakyRun: 50 }), say: () => {} });
  assert.equal(res.git.found, 1);
  assert.equal(res.logs.found, 1);
  res = await leakCheck({ repo: r.dir, env, ...fakeGitHub({ failRun: 9 }), say: () => {} });
  assert.equal(res.complete, false);
  // a wrong passphrase can't open the sealed config: the check stops instead of searching less
  await assert.rejects(() => leakCheck({ repo: r.dir, env: { ...env, LOCK_PASSPHRASE: 'wrong' }, ...fakeGitHub(), say: () => {} }), /wrong passphrase/);
  // the workflow's way: secrets as LEAK_SECRET_<NAME> env vars, no ALL_SECRETS
  r.write('debug.txt', `token=${SECRET}\n`); r.g('add', '.'); r.g('commit', '-q', '-m', 'Debug 2');
  const lines2 = [];
  res = await leakCheck({ repo: r.dir, env: { LOCK_PASSPHRASE: DUMMY, LEAK_SECRET_COINGECKO_KEY: SECRET, GITHUB_REPOSITORY: 'o/r' }, ...fakeGitHub(), say: (l) => lines2.push(l) });
  assert.match(lines2.join('\n'), /secrets 2;/);
  assert.equal(res.git.found, 2, 'the passphrase file and the key file');
});
