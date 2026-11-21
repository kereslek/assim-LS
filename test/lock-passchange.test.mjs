// After a passphrase change (a new owner slot in keys.json; lock.json's own check still the old passphrase's), the
// tools that check the passphrase outside the loop (lock-init --verify, the leak check's sealed config) must read keys.json
// and accept an owner slot. No keys.json: the lock's own check, as before. Made-up passphrases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initLock, readLock, deriveKeys } from '../lib/lock.mjs';
import { inboxSeal, readInboxKey } from '../lib/inbox.mjs';
import { KEYS_FILE, buildKeysFile, migrateKeys, wrapSlot } from '../lib/keyring.mjs';
import { main as lockInit } from '../scripts/lock-init.mjs';
import { leakCheck } from '../scripts/leak-check.mjs';

const OLD = 'made-up OLD passphrase for the change test', NEW = 'made-up NEW passphrase for the change test';
const WRONG = 'made-up WRONG passphrase';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-pchange-'));

// a lock made with OLD, a sealed config, and (optionally) keys.json whose owner slots are `owners` (passphrases)
function setup(owners) {
  const dir = tmp(), lockDir = path.join(dir, 'lock'), keysDir = path.join(dir, 'keys');
  initLock({ dir: lockDir, passphrase: OLD, iterations: 1000 });
  fs.writeFileSync(path.join(lockDir, 'config.sealed.json'), JSON.stringify(inboxSeal(JSON.stringify({ leakSensitive: ['made-up-sensitive-label'] }), readInboxKey(lockDir))));
  fs.mkdirSync(keysDir);
  if (owners) {
    const lock = readLock(lockDir), d = deriveKeys(OLD, lock.salt, lock.iter);
    const { v } = migrateKeys({ pass: d.aes, token: d.token, iter: 1000 });
    const slot = (p) => wrapSlot({ m: v.mk.toString('base64') }, deriveKeys(p, lock.salt, lock.iter).aes, 'owner');
    const kf = buildKeysFile({ v, owner: owners.map(slot), gsalt: Buffer.alloc(16, 7).toString('base64'), iter: 1000 });
    fs.writeFileSync(path.join(keysDir, KEYS_FILE), JSON.stringify(kf));
  }
  return { dir, lockDir, keysDir };
}
const verify = (s, pass) => {
  const lines = [];
  const code = lockInit(['--dir', s.lockDir, '--verify', '--keys-dir', s.keysDir], { LOCK_PASSPHRASE: pass }, (l) => lines.push(l));
  for (const l of lines) assert.ok(!l.includes(pass), 'printed the passphrase');
  return { code, out: lines.join('\n') };
};

test('lock-init --verify: old format (no keys.json) is the lock check only', () => {
  const s = setup(null);
  assert.equal(verify(s, OLD).code, 0);
  assert.match(verify(s, OLD).out, /key slots \(keys\.json\) read: no/);
  assert.equal(verify(s, NEW).code, 1);
  assert.equal(verify(s, WRONG).code, 1);
});

test('lock-init --verify after a passphrase change: the new owner slot opens, the lock is still the old one', () => {
  // both slots (the loop has not run on the new passphrase yet), then only the new one (the old slot was dropped)
  for (const owners of [[OLD, NEW], [NEW]]) {
    const s = setup(owners);
    const before = fs.readFileSync(path.join(s.lockDir, 'lock.json'), 'utf8');
    const r = verify(s, NEW);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /passphrase opens the lock: yes/);
    assert.match(r.out, /matches the lock: yes/);
    assert.match(r.out, /key slots \(keys\.json\) read: yes/);
    assert.equal(verify(s, WRONG).code, 1, 'a wrong passphrase fails');
    assert.equal(verify(s, OLD).code, owners.includes(OLD) ? 0 : 1, 'the old passphrase opens only while its slot is there');
    assert.equal(fs.readFileSync(path.join(s.lockDir, 'lock.json'), 'utf8'), before, 'the lock was touched');
  }
});

test('leak check after a passphrase change: the sealed config opens with the new passphrase via keys.json', async () => {
  const s = setup([NEW]);
  spawnSync('git', ['init', '-q', s.dir]);
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: s.dir, encoding: 'utf8' });
  g('add', 'lock'); g('commit', '-q', '-m', 'Add the lock');
  const lines = [];
  const res = await leakCheck({ repo: s.dir, keysDir: s.keysDir, logs: false, env: { LOCK_PASSPHRASE: NEW }, say: (l) => lines.push(l) });
  assert.equal(res.found, 0);
  assert.match(lines.join('\n'), /sealed config present: yes/);
  assert.match(lines.join('\n'), /sealed config 1/);
  assert.ok(!lines.join('\n').includes(NEW) && !lines.join('\n').includes('made-up-sensitive-label'), 'printed a private string');
  await assert.rejects(() => leakCheck({ repo: s.dir, keysDir: s.keysDir, logs: false, env: { LOCK_PASSPHRASE: WRONG }, say: () => {} }), /wrong passphrase/);
  // no keys.json: the lock's own check, as before (the old passphrase opens, the new one does not)
  const empty = tmp();
  await leakCheck({ repo: s.dir, keysDir: empty, logs: false, env: { LOCK_PASSPHRASE: OLD }, say: () => {} });
  await assert.rejects(() => leakCheck({ repo: s.dir, keysDir: empty, logs: false, env: { LOCK_PASSPHRASE: NEW }, say: () => {} }), /wrong passphrase/);
});
