// Done inbox requests: kept for good (compact keys, no cap), a done id is refused even when its file is still there or
// comes back, done files leave inbox/ on the code branch in one counts-only commit, and only after a real publish.
// Made-up requests and passphrases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initLock, readLock, unlock } from '../lib/lock.mjs';
import { inboxKeys, inboxSeal } from '../lib/inbox.mjs';
import { applyRequests, doneKey, guestLine, guestStep, readInbox, removeInbox } from '../lib/guests.mjs';
import { readKeysFile, reopen, wrapSlot } from '../lib/keyring.mjs';
import { runLoop } from '../scripts/loop.mjs';
import { openStore } from '../lib/store.mjs';

const DUMMY = 'inbox done test dummy passphrase, not a secret';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lps-idone-'));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const NOW = Date.parse('2026-11-20T10:00:00Z');
const K0 = { owner: [{ iv: 'aaaaaaaaaaaaaaaa', ct: 'bbbb' }], recovery: null, rsalt: null };
const G0 = () => ({ v: 1, t: NOW, gen: 0, guests: [], done: [], vault: { change: null, changedAt: null, recoveryAt: null } });
const SLOT = wrapSlot({ m: Buffer.alloc(32, 5).toString('base64') }, Buffer.alloc(32, 9), 'recovery'); // a made-up slot
const recovery = (id, at = NOW) => ({ lps: 'recovery-set', id, at, slot: { iv: SLOT.iv, ct: SLOT.ct }, rsalt: Buffer.alloc(16, 3).toString('base64') });
const reset = (id, at) => ({ lps: 'guest-reset', id, at });

test('done ids are kept for good (1500 and more, no cap), compactly, and a done id is refused', () => {
  const first = hex(16);
  const many = Array.from({ length: 1500 }, (_, i) => reset(hex(16), NOW + 1 + i));
  const a = applyRequests(G0(), K0, [recovery(first), ...many], { now: NOW, known: [] });
  assert.equal(a.recoverySet, 1);
  assert.equal(a.G.done.length, 1501, 'every done id is kept');
  assert.ok(a.G.done.every((x) => /^[0-9a-f]{16}$/.test(x)), 'stored compactly');
  assert.ok(!a.G.done.includes(first) && a.G.done.includes(doneKey(first)), 'the key, not the id');
  // the first request's file is still there (or came back): it is refused, never applied twice
  const b = applyRequests(a.G, a.K, [recovery(first, NOW + 9999)], { now: NOW + 9999, known: [] });
  assert.equal(b.recoverySet, 0, 'a done request was applied again');
  assert.equal(b.again, 1);
  assert.equal(b.G.done.length, 1501);
  // a guests.json of the older format (the ids themselves): still refused, and stored as keys from now on
  const old = { ...G0(), done: [first] };
  const c = applyRequests(old, K0, [recovery(first), reset(hex(16), NOW + 1)], { now: NOW, known: [] });
  assert.equal(c.recoverySet, 0); assert.equal(c.again, 1);
  assert.deepEqual(c.G.done.slice(0, 1), [doneKey(first)]);
  assert.equal(c.G.done.length, 2);
});

function lockAndDir() {
  const ldir = tmp();
  initLock({ dir: ldir, passphrase: DUMMY, iterations: 1000 });
  return { keys: unlock(readLock(ldir), DUMMY), outDir: tmp() };
}

test('the keys step: a done request is refused once its file is gone and it comes back; handled files are named', () => {
  const { keys, outDir } = lockAndDir();
  const K = () => ({ ...keys });
  const m = guestStep({ keys: K(), outDir, now: NOW, allowMigrate: true });
  assert.equal(m.migrated, true);
  const pub = inboxKeys(reopen(K(), readKeysFile(outDir)).token).publicB64;
  const env = inboxSeal(JSON.stringify(recovery(hex(16))), pub);
  const junk = { inbox: 1, epk: 'made-up', iv: 'made-up', ct: 'made-up' };
  const later = inboxSeal(JSON.stringify({ lps: 'made-up-future-kind', id: hex(16), at: NOW }), pub);
  const r1 = guestStep({ keys: K(), outDir, now: NOW + 1, requests: [env, junk, later] });
  assert.equal(r1.recoverySet, 1); assert.equal(r1.bad, 2);
  assert.deepEqual(r1.handled, [0, 1], 'applied and invalid files go; a kind only newer code knows waits');
  // the file was removed: a pass with an empty inbox; then the same sealed request comes back
  const r2 = guestStep({ keys: K(), outDir, now: NOW + 2, requests: [] });
  assert.deepEqual(r2.handled, []);
  const r3 = guestStep({ keys: K(), outDir, now: NOW + 3, requests: [env] });
  assert.equal(r3.recoverySet, 0, 'a done request was applied again');
  assert.equal(r3.again, 1);
  assert.deepEqual(r3.handled, [0], 'its file goes again');
  assert.match(guestLine(r3, { read: true, files: 1, skipped: 0 }), /1 already done/);
  // a step that could not run handles nothing (its files stay for the next pass)
  const skipped = guestStep({ keys: K(), outDir: tmp(), now: NOW, requests: [env] });
  assert.equal(skipped.skipped, 'no keys file'); assert.deepEqual(skipped.handled, []);
});

// a code branch with inbox files on a local bare origin, and a checkout of it (as the loop's pinned checkout)
const BR = 'made-up-code-branch';
function g(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(r.stderr);
  return r.stdout.trim();
}
function codeBranch(n) {
  const root = tmp(), origin = path.join(root, 'origin.git'), dev = path.join(root, 'dev'), loop = path.join(root, 'loop');
  g(root, 'init', '-q', '--bare', origin);
  fs.mkdirSync(path.join(dev, 'inbox'), { recursive: true });
  g(dev, 'init', '-q', '-b', BR);
  fs.writeFileSync(path.join(dev, 'README.md'), 'made up\n');
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dev, 'inbox', `r${String(i).padStart(3, '0')}.json`), JSON.stringify({ inbox: 1, epk: 'x', iv: 'y', ct: String(i) }));
  g(dev, 'add', '.'); g(dev, 'commit', '-q', '-m', 'Code');
  g(dev, 'remote', 'add', 'origin', origin); g(dev, 'push', '-q', 'origin', BR);
  g(root, 'clone', '-q', '-b', BR, origin, loop);
  return { root, origin, dev, loop, files: (ref = BR) => g(origin, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean) };
}

test('the inbox read: at most 200 files, the rest counted (not read), each file named', () => {
  const c = codeBranch(203);
  const ib = readInbox({ repo: c.loop, branch: BR });
  assert.equal(ib.read, true);
  assert.equal(ib.files, 200); assert.equal(ib.envs.length, 200); assert.equal(ib.names.length, 200);
  assert.equal(ib.skipped, 3);
  assert.equal(ib.names[0], 'inbox/r000.json');
  assert.match(guestLine({ active: 0, added: 0, removed: 0, expired: 0, refused: 0, owners: 1 }, ib), /200 files \(3 more not read: over 200\)/);
});

test('done files leave inbox/ in one counts-only commit on the tip; a moved tip is fetched again; nothing else changes', () => {
  const c = codeBranch(4);
  const r = removeInbox({ repo: c.loop, branch: BR, paths: ['inbox/r000.json', 'inbox/r002.json', 'inbox/gone-already.json', 'README.md', 'inbox/../x.json'] });
  assert.equal(r.pushed, true); assert.equal(r.removed, 2);
  assert.deepEqual(c.files(), ['README.md', 'inbox/r001.json', 'inbox/r003.json']);
  assert.equal(g(c.origin, 'log', '-1', '--format=%s', BR), 'inbox: 2 requests done, removed');
  assert.equal(g(c.origin, 'log', '-1', '--format=%b', BR), '', 'the message holds a count only');
  // a developer pushes meanwhile: the first push is refused, the next attempt rebuilds on the new tip and keeps their commit
  let dev = false;
  const r2 = removeInbox({ repo: c.loop, branch: BR, paths: ['inbox/r001.json'], wait: () => {}, beforePush: (attempt) => {
    if (attempt !== 1 || dev) return;
    dev = true;
    g(c.dev, 'pull', '-q', 'origin', BR); fs.writeFileSync(path.join(c.dev, 'made-up.txt'), 'dev\n');
    g(c.dev, 'add', '.'); g(c.dev, 'commit', '-q', '-m', 'Dev work'); g(c.dev, 'push', '-q', 'origin', BR);
  } });
  assert.equal(r2.pushed, true); assert.equal(r2.attempts, 2);
  assert.deepEqual(c.files(), ['README.md', 'inbox/r003.json', 'made-up.txt']);
  assert.equal(g(c.origin, 'log', '-2', '--format=%s', BR), 'inbox: 1 request done, removed\nDev work');
  // nothing left to remove: no commit
  const tip = g(c.origin, 'rev-parse', BR);
  assert.equal(removeInbox({ repo: c.loop, branch: BR, paths: ['inbox/r001.json'] }).pushed, false);
  assert.equal(g(c.origin, 'rev-parse', BR), tip);
});

test('the loop removes done files only after a real (not dry-run) publish that worked', async () => {
  const root = tmp();
  initLock({ dir: path.join(root, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const store = openStore({ lockDir: path.join(root, 'lock'), outDir: path.join(root, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  const run = async ({ dryRun, failPublish = false }) => {
    let clock = NOW;
    const cleaned = [];
    const deps = {
      store, say: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; }, marker: () => {}, restore: () => {},
      sealedLog: () => ({ lines: 1, errors: 0, categories: {} }), guests: () => {},
      publish: () => { if (failPublish) throw new Error('bad push: made up'); },
      runPass: async () => { clock += 1000; return { ok: true, code: 0, timedOut: false }; },
      inboxClean: () => cleaned.push(clock),
    };
    await runLoop({ passCmd: 'made-up pass', mode: dryRun ? 'rehearsal' : 'live', spacing: 30, maxPasses: 2, dryRun, restore: false }, deps);
    return cleaned.length;
  };
  assert.equal(await run({ dryRun: false }), 2);
  assert.equal(await run({ dryRun: true }), 0);
  assert.equal(await run({ dryRun: false, failPublish: true }), 0);
});
