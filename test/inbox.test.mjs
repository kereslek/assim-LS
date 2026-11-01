// seal-input: seals JSON to the inbox public key, needs no secret, never prints the plaintext, and
// refuses when the plaintext would show up in its output. Made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLock, readLock, unlock } from '../lib/lock.mjs';
import { echoes, inboxKeys, inboxOpen, inboxSeal, readInboxKey, sealChecked } from '../lib/inbox.mjs';
import { sealInput } from '../scripts/seal-input.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'seal-input.mjs');
const DUMMY = 'dummy passphrase for inbox tests';
const MADE_UP = JSON.stringify({ ticket: 2468, leakSensitive: ['made-up-sensitive-label'] });

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-inbox-'));
  initLock({ dir: path.join(root, 'lock'), passphrase: DUMMY, iterations: 1000 });
  return root;
};
const run = (cwd, args, input, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const privKey = (root) => inboxKeys(unlock(readLock(path.join(root, 'lock')), DUMMY).token).privateKey;

test('CLI from stdin: sealed file opens with the lock; no secret in the environment; nothing private printed', () => {
  const root = setup();
  const r = run(root, ['--out', 'lock/config.sealed.json'], MADE_UP); // env has no LOCK_PASSPHRASE
  assert.equal(r.status, 0, r.stdout);
  for (const s of ['2468', 'made-up-sensitive-label']) assert.ok(!(r.stdout + r.stderr).includes(s), 'printed a private value');
  assert.match(r.stdout, /config fields valid: yes/);
  assert.match(r.stdout, /plaintext in the output: no/);
  const file = fs.readFileSync(path.join(root, 'lock', 'config.sealed.json'), 'utf8');
  assert.ok(!file.includes('made-up-sensitive') && !file.includes('2468'));
  assert.equal(inboxOpen(JSON.parse(file), privKey(root)), MADE_UP);
});

test('CLI from a file, to a non-config output, with --pub pointing at the key file', () => {
  const root = setup();
  fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify({ wallets: ['made-up-wallet-one'] }));
  const r = run(root, ['--in', 'input.json', '--out', 'sealed/wallets.sealed.json', '--pub', 'lock/inbox.json']);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!r.stdout.includes('config fields'));
  const env = JSON.parse(fs.readFileSync(path.join(root, 'sealed', 'wallets.sealed.json'), 'utf8'));
  assert.deepEqual(JSON.parse(inboxOpen(env, privKey(root))), { wallets: ['made-up-wallet-one'] });
});

test('CLI refusals: not JSON, empty input, no inbox key, a bad config field, no --out', () => {
  const root = setup();
  let r = run(root, ['--out', 'x.json'], 'made-up plain text 13579');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /input is not JSON/);
  assert.ok(!r.stdout.includes('13579'));
  r = run(root, ['--out', 'x.json'], '   ');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing input/);
  r = run(root, ['--out', 'x.json', '--pub', 'nowhere/inbox.json'], MADE_UP);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing inbox key/);
  r = run(root, ['--out', 'lock/config.sealed.json'], JSON.stringify({ ticket: -98765 }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a valid config: ticket/);
  assert.ok(!r.stdout.includes('98765'));
  assert.equal(fs.existsSync(path.join(root, 'lock', 'config.sealed.json')), false, 'nothing written on refusal');
  r = run(root, [], MADE_UP);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing --out/);
});

test('planted fault: a seal that echoes the plaintext is refused and nothing is written', () => {
  const root = setup();
  const pub = readInboxKey(path.join(root, 'lock'));
  const leaky = (text, k) => ({ ...inboxSeal(text, k), note: text });
  const partly = (text, k) => ({ ...inboxSeal(text, k), hint: 'made-up-sensitive-label' });
  assert.throws(() => sealChecked(MADE_UP, pub, { sealFn: leaky }), /plaintext shows up/);
  assert.throws(() => sealChecked(MADE_UP, pub, { sealFn: partly }), /plaintext shows up/, 'one leaf string is enough');
  const out = path.join(root, 'lock', 'config.sealed.json');
  assert.throws(() => sealInput({ text: MADE_UP, out, pubDir: path.join(root, 'lock'), say: () => {}, sealFn: leaky }), /plaintext shows up/);
  assert.equal(fs.existsSync(out), false);
  // and the honest seal passes the same check
  assert.equal(sealChecked(MADE_UP, pub).env.inbox, 1);
});

test('echo probe: case-insensitive, short leaves ignored', () => {
  assert.equal(echoes('xx MADE-UP-SENSITIVE-LABEL xx', '{}', { a: 'made-up-sensitive-label' }), true);
  assert.equal(echoes('abc 42', '{"a":"abc","b":42}', { a: 'abc', b: 42 }), false);
  assert.throws(() => inboxSeal('x', Buffer.alloc(16).toString('base64')), /bad inbox key/);
});
