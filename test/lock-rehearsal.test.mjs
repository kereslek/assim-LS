// Lock rehearsal, end to end, on a throwaway copy with a dummy passphrase, through the real scripts:
// init → seal a config through the inbox → open it → a pass seals its outputs and log → publish (dry
// run, then for real to a local bare "origin") → a second pass replaces the data commit and keeps the
// other job's file → a wrong passphrase stops everything and reseals nothing → data aimed at the code
// branch is refused. Made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { loadConfig } from '../lib/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const S = (n) => path.join(ROOT, 'scripts', n);
const L = (n) => pathToFileURL(path.join(ROOT, 'lib', n)).href;
const DUMMY = 'rehearsal dummy passphrase, not a secret';
const GOOD = { LOCK_PASSPHRASE: DUMMY };
const BAD = { LOCK_PASSPHRASE: 'rehearsal wrong passphrase' };
const CODE = 'code-branch';

const sh = (cwd, cmd, args, { env = {}, input } = {}) => spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
const git = (cwd, ...a) => { const r = sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
const node = (cwd, script, args = [], opts = {}) => sh(cwd, process.execPath, [script, ...args], opts);
const hashDir = (d) => fs.existsSync(d) ? fs.readdirSync(d).sort().map((n) => n + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(d, n))).digest('hex')).join(',') : '';

// One scanner pass, as the scanner will run it: sealed logs first, then the config, then the store.
const PASS = (files) => `
import { installSealedLogs } from '${L('quietlogs.mjs')}';
import { loadConfig } from '${L('config.mjs')}';
import { openStore } from '${L('store.mjs')}';
installSealedLogs();
const { config, sealed } = loadConfig();
const store = openStore();
const t = Date.now();
console.log('pass with a ticket of', config.ticket, 'sealed', sealed);
console.warn('RPC slow at 0x000000000000000000000000000000000000beef');
for (const f of ${JSON.stringify(files)}) store.put(f, { v: 1, t, ticket: config.ticket, pools: [], from: f });
`;

test('the whole lock, end to end, on a throwaway copy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-rehearsal-'));
  const origin = path.join(tmp, 'origin.git'), work = path.join(tmp, 'work');
  git(tmp, 'init', '-q', '--bare', origin);
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', CODE);
  fs.writeFileSync(path.join(work, '.gitignore'), 'out/\n');
  fs.writeFileSync(path.join(work, 'pass.mjs'), PASS(['live.json', 'history.json', 'backtest.json']));
  fs.writeFileSync(path.join(work, 'pass2.mjs'), PASS(['live.json']));
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'Code');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', CODE);
  const codeTip = git(origin, 'rev-parse', `refs/heads/${CODE}`);

  // 1. init: production refuses low rounds without --throwaway; the throwaway lock is created once
  let r = node(work, S('lock-init.mjs'), ['--iter', '1000'], { env: GOOD });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refusing: fewer than 600000 rounds/);
  r = node(work, S('lock-init.mjs'), ['--iter', '1000', '--throwaway'], { env: GOOD });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /lock created now: yes/);
  assert.match(r.stdout, /passphrase opens the lock: yes/);
  const lockBefore = fs.readFileSync(path.join(work, 'lock', 'lock.json'), 'utf8');
  r = node(work, S('lock-init.mjs'), ['--iter', '1000', '--throwaway'], { env: GOOD });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /lock existed before: yes/);
  assert.match(r.stdout, /lock created now: no/);
  assert.equal(fs.readFileSync(path.join(work, 'lock', 'lock.json'), 'utf8'), lockBefore, 'overwrote an existing lock');
  r = node(work, S('lock-init.mjs'), ['--verify'], { env: GOOD });
  assert.equal(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(DUMMY));

  // 2. seal a made-up config through the inbox (no secret needed), 3. open it with the lock
  r = node(work, S('seal-input.mjs'), ['--out', 'lock/config.sealed.json'], { input: JSON.stringify({ ticket: 3141, leakSensitive: ['made-up-rehearsal-label'] }) });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!fs.readFileSync(path.join(work, 'lock', 'config.sealed.json'), 'utf8').includes('rehearsal-label'));
  const cfg = loadConfig({ dir: path.join(work, 'lock'), env: GOOD });
  assert.equal(cfg.sealed, true);
  assert.equal(cfg.config.ticket, 3141);

  // 4. a pass seals its outputs and its log
  r = node(work, 'pass.mjs', [], { env: GOOD });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('3141') && !r.stdout.includes('beef'), 'the pass printed a private value');
  assert.match(r.stdout, /pass: 2 lines \(sealed\), 1 warnings\/errors, exit 0/);
  const out = path.join(work, 'out', 'data');
  assert.deepEqual(fs.readdirSync(out).sort(), ['backtest.json', 'history.json', 'live.json', 'log.json']);
  const store = openStore({ lockDir: path.join(work, 'lock'), outDir: out, env: GOOD });
  assert.equal(store.get('live.json').ticket, 3141);
  assert.ok(store.get('log.json').lines.some((l) => l.includes('beef')));

  // 5. publish, dry run: nothing reaches origin
  r = node(work, S('publish-data.mjs'), ['--dry-run'], { env: GOOD });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /dry run: would replace the "data" branch with one commit \(no parent\) of 5 files/);
  assert.equal(sh(origin, 'git', ['rev-parse', '--verify', '-q', 'refs/heads/data']).status, 1);

  // 6. publish for real: one commit, no parent, five files, the code branch untouched
  r = node(work, S('publish-data.mjs'), [], { env: GOOD });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /published: yes, 5 files \(0 carried forward\)/);
  const tip1 = git(origin, 'rev-parse', 'refs/heads/data');
  assert.equal(git(origin, 'rev-list', '--count', 'refs/heads/data'), '1');
  assert.equal(git(origin, 'ls-tree', '--name-only', 'refs/heads/data').split('\n').join(','), 'backtest.json,history.json,live.json,lock.json,log.json');
  assert.equal(git(origin, 'show', 'refs/heads/data:lock.json'), lockBefore.trim());
  assert.equal(git(origin, 'rev-parse', `refs/heads/${CODE}`), codeTip);
  assert.ok(!git(origin, 'show', 'refs/heads/data:live.json').includes('3141'));

  // 7. the next pass writes only live.json: the data commit is replaced, the other files carried forward
  const backtestBlob = git(origin, 'rev-parse', 'refs/heads/data:backtest.json');
  fs.rmSync(out, { recursive: true });
  r = node(work, 'pass2.mjs', [], { env: GOOD });
  assert.equal(r.status, 0);
  r = node(work, S('publish-data.mjs'), [], { env: GOOD });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /published: yes, 5 files \(2 carried forward\)/);
  assert.notEqual(git(origin, 'rev-parse', 'refs/heads/data'), tip1);
  assert.equal(git(origin, 'rev-list', '--count', 'refs/heads/data'), '1', 'the data branch grew a history');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/data:backtest.json'), backtestBlob);

  // 8. restore pulls the carried files back into a fresh output folder
  fs.rmSync(out, { recursive: true });
  r = node(work, S('publish-data.mjs'), ['--restore'], { env: GOOD });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /files restored into the output folder: 4/);
  assert.equal(openStore({ lockDir: path.join(work, 'lock'), outDir: out, env: GOOD }).get('backtest.json').from, 'backtest.json');

  // 9. a wrong passphrase stops everything: no reseal, no publish, the lock and data untouched
  const outHash = hashDir(out), tip2 = git(origin, 'rev-parse', 'refs/heads/data');
  r = node(work, S('lock-init.mjs'), [], { env: BAD });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /passphrase opens the lock: no/);
  r = node(work, 'pass.mjs', [], { env: BAD });
  assert.notEqual(r.status, 0);
  r = node(work, S('publish-data.mjs'), [], { env: BAD });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /wrong passphrase/);
  r = node(work, S('publish-data.mjs'), [], { env: {} });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing passphrase/);
  assert.equal(hashDir(out), outHash, 'a wrong passphrase rewrote an output file');
  assert.equal(fs.readFileSync(path.join(work, 'lock', 'lock.json'), 'utf8'), lockBefore);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/data'), tip2);

  // 10. data aimed at the code branch is refused; data tracked on the code branch is refused
  r = node(work, S('publish-data.mjs'), ['--branch', CODE], { env: GOOD });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refusing: data goes only to the "data" branch/);
  assert.equal(git(origin, 'rev-parse', `refs/heads/${CODE}`), codeTip);
  git(work, 'add', '-f', 'out/data/live.json');
  r = node(work, S('publish-data.mjs'), [], { env: GOOD });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /output files are tracked on the code branch/);
  git(work, 'rm', '-q', '--cached', 'out/data/live.json');

  // 11. a plaintext file in the output folder is never published
  fs.writeFileSync(path.join(out, 'live.json'), JSON.stringify({ v: 1, t: 1, ticket: 3141 }));
  r = node(work, S('publish-data.mjs'), [], { env: GOOD });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a sealed envelope/);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/data'), tip2);

  // and nothing printed along the way carried the passphrase
  assert.ok(!r.stdout.includes(DUMMY));
});
