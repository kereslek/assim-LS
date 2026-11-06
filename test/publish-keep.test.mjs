// Publishing to the data branch keeps every job's newest file: the daily backtest's backtest.json lands and
// stays when the loop, which restored an older copy at its start (or none), publishes after it. Throwaway
// lock (dummy passphrase), local bare "origin", made-up files. The planted fault (newest-wins off) drops it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initLock, readLock, unlock, open } from '../lib/lock.mjs';
import { writeSealed } from '../lib/store.mjs';
import { publishData } from '../scripts/publish-data.mjs';

const DUMMY = 'publish keep test dummy passphrase, not a secret';
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-keep-')), work = path.join(root, 'work'), origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', origin);
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'code');
  fs.writeFileSync(path.join(work, '.gitignore'), 'out*/\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'Code');
  git(work, 'remote', 'add', 'origin', origin);
  initLock({ dir: path.join(work, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const { aes } = unlock(readLock(path.join(work, 'lock')), DUMMY);
  const put = (dir, name, t) => writeSealed(name, { v: 1, t, from: dir }, aes, { outDir: path.join(work, dir) });
  const pub = (dir, opts = {}) => publishData({ repo: work, outDir: dir, env: { LOCK_PASSPHRASE: DUMMY }, say: () => {}, ...opts });
  const onBranch = (name) => {
    const blob = git(work, 'rev-parse', `refs/lps/data-old:${name}`, '--');
    return JSON.parse(open(JSON.parse(git(work, 'cat-file', 'blob', blob.split('\n')[0])), aes)).t;
  };
  const fetchNow = () => git(work, 'fetch', '-q', 'origin', '+refs/heads/data:refs/lps/data-old');
  return { put, pub, onBranch, fetchNow };
}

test('the backtest lands and stays: newer files on the branch are kept, missing ones carried forward', () => {
  const s = setup();
  // the loop's first pass: live.json only
  s.put('out-loop', 'live.json', 1000); s.pub('out-loop');
  // the backtest job restored live.json at its start, then wrote backtest.json
  s.put('out-bt', 'live.json', 1000); s.put('out-bt', 'backtest.json', 2000); s.pub('out-bt');
  // the loop's next pass: a newer live.json, and an older backtest.json it restored when its run began
  s.put('out-loop', 'live.json', 3000); s.put('out-loop', 'backtest.json', 500);
  const r = s.pub('out-loop');
  s.fetchNow();
  assert.equal(s.onBranch('backtest.json'), 2000, 'the newer backtest stays');
  assert.equal(s.onBranch('live.json'), 3000, 'the loop\'s newer live.json lands');
  assert.equal(r.keptNewer, 1);
  // a pass without backtest.json at all (e.g. a pools run) carries it forward
  s.put('out-pools', 'live.json', 4000); s.pub('out-pools');
  s.fetchNow();
  assert.equal(s.onBranch('backtest.json'), 2000);
  assert.equal(s.onBranch('live.json'), 4000);
});

test('planted fault: publishing without newest-wins drops the backtest for a stale copy', () => {
  const s = setup();
  s.put('out-bt', 'backtest.json', 2000); s.put('out-bt', 'live.json', 1000); s.pub('out-bt');
  s.put('out-loop', 'live.json', 3000); s.put('out-loop', 'backtest.json', 500);
  s.pub('out-loop', { keepNewer: false });
  s.fetchNow();
  assert.notEqual(s.onBranch('backtest.json'), 2000, 'the fault this guards against: the stale copy replaced the backtest');
});
