// The sealed store: out/data files are lock envelopes only, readable t, everything else sealed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLock, readLock, unlock, seal } from '../lib/lock.mjs';
import { DATA_FILES, checkSealedDir, openStore, readSealed, writeSealed } from '../lib/store.mjs';

const DUMMY = 'dummy passphrase for store tests';
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-store-'));
  const lockDir = path.join(root, 'lock'), outDir = path.join(root, 'out', 'data');
  initLock({ dir: lockDir, passphrase: DUMMY, iterations: 1000 });
  return { root, lockDir, outDir, env: { LOCK_PASSPHRASE: DUMMY } };
};
const live = { v: 1, t: 1761955200000, build: 'test', ticket: 1357, pools: [{ id: 'made-up-pool', pair: 'MADEUP/WETH' }] };

test('put and get round-trip; on disk only the envelope, and only t is readable', () => {
  const s = setup();
  const store = openStore({ lockDir: s.lockDir, outDir: s.outDir, env: s.env });
  assert.deepEqual(store.put('live.json', live), { name: 'live.json', t: live.t });
  const raw = fs.readFileSync(path.join(s.outDir, 'live.json'), 'utf8');
  const env = JSON.parse(raw);
  assert.deepEqual(Object.keys(env).sort(), ['ct', 'iv', 'lock', 't', 'z']);
  assert.equal(env.t, live.t);
  for (const v of ['1357', 'made-up-pool', 'MADEUP']) assert.ok(!raw.includes(v));
  assert.deepEqual(store.get('live.json'), live);
  assert.equal(store.get('history.json'), null, 'missing is null, never an empty object');
  assert.deepEqual(checkSealedDir(s.outDir, store.keys.aes), ['live.json']);
});

test('update appends to the previous object', () => {
  const s = setup();
  const store = openStore({ lockDir: s.lockDir, outDir: s.outDir, env: s.env });
  store.update('history.json', (prev) => ({ v: 1, t: 1, pools: {}, health: [...(prev?.health || []), [1, 1, 1, 0]] }));
  store.update('history.json', (prev) => ({ v: 1, t: 2, pools: {}, health: [...(prev?.health || []), [2, 1, 1, 0]] }));
  assert.deepEqual(store.get('history.json').health, [[1, 1, 1, 0], [2, 1, 1, 0]]);
});

test('planted faults: wrong passphrase, unknown name, bad shape, tampered or foreign file', () => {
  const s = setup();
  assert.throws(() => openStore({ lockDir: s.lockDir, outDir: s.outDir, env: { LOCK_PASSPHRASE: 'wrong' } }), /wrong passphrase/);
  assert.equal(fs.existsSync(s.outDir), false, 'a wrong passphrase writes nothing');
  assert.throws(() => openStore({ lockDir: path.join(s.root, 'nolock'), outDir: s.outDir, env: s.env }), /missing lock/);
  const { aes } = unlock(readLock(s.lockDir), DUMMY);
  assert.throws(() => writeSealed('wallets.json', live, aes, { outDir: s.outDir }), /not a data file/);
  assert.throws(() => writeSealed('../live.json', live, aes, { outDir: s.outDir }), /not a data file/);
  assert.throws(() => writeSealed('live.json', { ...live, v: 2 }, aes, { outDir: s.outDir }), /v: 1/);
  assert.throws(() => writeSealed('live.json', { v: 1 }, aes, { outDir: s.outDir }), /needs t/);
  writeSealed('live.json', live, aes, { outDir: s.outDir });
  const file = path.join(s.outDir, 'live.json');
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(env.ct, 'base64');
  ct[ct.length - 1] ^= 1;
  fs.writeFileSync(file, JSON.stringify({ ...env, ct: ct.toString('base64') }));
  assert.throws(() => readSealed('live.json', aes, { outDir: s.outDir }));
  assert.throws(() => checkSealedDir(s.outDir, aes), /does not open/);
  const other = unlock(readLock(setup().lockDir), DUMMY); // same passphrase, another salt
  fs.writeFileSync(file, JSON.stringify(seal(live, other.aes, { t: live.t })));
  assert.throws(() => checkSealedDir(s.outDir, aes), /does not open/);
  fs.writeFileSync(file, JSON.stringify(live));
  assert.throws(() => checkSealedDir(s.outDir, aes), /not a sealed envelope/);
  fs.writeFileSync(file, JSON.stringify(seal(live, aes, { t: live.t })));
  fs.writeFileSync(path.join(s.outDir, 'notes.json'), '{}');
  assert.throws(() => checkSealedDir(s.outDir, aes), /not a data file/);
});

test('the data file list matches the data contract plus the sealed log', () => {
  assert.deepEqual([...DATA_FILES], ['live.json', 'history.json', 'backtest.json', 'log.json']);
});
