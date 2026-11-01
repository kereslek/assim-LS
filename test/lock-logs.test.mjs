// Sealed logs: one call, then every console line, uncaught error and rejected promise is sealed to
// out/data/log.json; the public log keeps counts and first-word categories only. Made-up values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initLock } from '../lib/lock.mjs';
import { openStore } from '../lib/store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = pathToFileURL(path.join(ROOT, 'lib', 'quietlogs.mjs')).href;
const DUMMY = 'dummy passphrase for sealed-log tests';
const ADDR = '0x00000000000000000000000000000000000c0ffe'; // made-up

function runChild(body, env = { LOCK_PASSPHRASE: DUMMY }, nodeArgs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-logs-'));
  initLock({ dir: path.join(root, 'lock'), passphrase: DUMMY, iterations: 1000 });
  fs.writeFileSync(path.join(root, 'child.mjs'), `import { installSealedLogs } from '${LIB}';\n${body}\n`);
  const r = spawnSync(process.execPath, [...nodeArgs, 'child.mjs'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { root, ...r };
}
const readLog = (root) => openStore({ lockDir: path.join(root, 'lock'), outDir: path.join(root, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } }).get('log.json');

test('the public log shows counts and categories; the sealed log holds everything', () => {
  const { root, status, stdout, stderr } = runChild(`
    const { publicLog, stats } = installSealedLogs();
    console.log('position at ${ADDR} worth 98765');
    console.warn('RPC slow for ${ADDR}');
    console.error(new Error('Price missing for made-up-token'));
    console.log({ big: 12345678901234567890n });
    publicLog('public line: ' + stats().lines + ' lines so far');
  `);
  assert.equal(status, 0, stdout + stderr);
  const out = stdout + stderr;
  for (const s of [ADDR, ADDR.slice(2, 12), '98765', 'made-up-token', '1234567890']) assert.ok(!out.includes(s), `public log leaked ${s}`);
  assert.match(stdout, /public line: 4 lines so far/);
  assert.match(stdout, /pass: 4 lines \(sealed\), 2 warnings\/errors, exit 0/);
  assert.match(stdout, /· RPC ×1/);
  assert.match(stdout, /· Error ×1/);
  const log = readLog(root);
  assert.equal(log.v, 1);
  assert.equal(log.lines.length, 4);
  assert.ok(log.lines[0].includes(ADDR) && log.lines[0].includes('98765'));
  assert.ok(log.lines[3].includes('12345678901234567890'), 'BigInt logged, not a crash');
  assert.deepEqual(log.categories, { RPC: 1, Error: 1 });
  const raw = fs.readFileSync(path.join(root, 'out', 'data', 'log.json'), 'utf8');
  assert.ok(!raw.includes('c0ffe') && !raw.includes('98765'));
});

test('planted fault: an uncaught error with an address is sealed, not printed, and the exit is 1', () => {
  const { root, status, stdout, stderr } = runChild(`
    installSealedLogs();
    console.log('starting');
    throw new Error('Swap decode failed at ${ADDR}');
  `);
  assert.equal(status, 1);
  assert.ok(!(stdout + stderr).includes('c0ffe'), 'the stack trace reached the public log');
  assert.match(stdout, /exit 1/);
  assert.match(stdout, /· Error ×1/);
  assert.ok(readLog(root).lines.some((l) => l.includes(ADDR)));
});

test('planted fault: a rejected promise is sealed too, whatever the rejection mode', () => {
  // --unhandled-rejections=warn would print the error straight to the public log without our handler
  for (const mode of [[], ['--unhandled-rejections=warn']]) {
    const { root, status, stdout, stderr } = runChild(`
      installSealedLogs();
      Promise.reject(new Error('Timeout reading ${ADDR}'));
    `, { LOCK_PASSPHRASE: DUMMY }, mode);
    assert.equal(status, 1, mode.join(' '));
    assert.ok(!(stdout + stderr).includes('c0ffe'), `leaked with ${mode.join(' ') || 'the default mode'}`);
    assert.ok(readLog(root).lines.some((l) => l.includes(ADDR)));
  }
});

test('a wrong or missing passphrase stops before anything is logged or sealed', () => {
  for (const env of [{ LOCK_PASSPHRASE: 'wrong' }, {}]) {
    const { root, status, stderr } = runChild(`installSealedLogs(); console.log('never ${ADDR}');`, env);
    assert.notEqual(status, 0);
    assert.match(stderr, /wrong passphrase|missing passphrase/);
    assert.ok(!stderr.includes('c0ffe'));
    assert.equal(fs.existsSync(path.join(root, 'out', 'data', 'log.json')), false);
  }
});
