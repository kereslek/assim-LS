// The sealed config: made-up public defaults, overlaid by values sealed to the inbox. Made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLock, readLock, unlock } from '../lib/lock.mjs';
import { inboxSeal, readInboxKey } from '../lib/inbox.mjs';
import { DEFAULTS, configProblems, leakStrings, loadConfig, mergeConfig } from '../lib/config.mjs';

const DUMMY = 'dummy passphrase for config tests';
const env = { LOCK_PASSPHRASE: DUMMY };
const lockDir = () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lps-config-')), 'lock');
  initLock({ dir, passphrase: DUMMY, iterations: 1000 });
  return dir;
};
const MADE_UP = { ticket: 4321, gemAt: 66, minTvlUsd: 250000, holdDays: { base: 5 }, leakSensitive: ['made-up-wallet-label-xyz'] };

test('defaults are complete and valid; every field the brief names is there', () => {
  assert.deepEqual(configProblems(DEFAULTS, { partial: false }), []);
  for (const k of ['ticket', 'gemAt', 'minTvlUsd', 'minPairAgeDays', 'stopLoss', 'priceSanity', 'toxicMarkout', 'holdDays', 'windows', 'leakSensitive']) assert.ok(k in DEFAULTS, k);
  assert.deepEqual(DEFAULTS.leakSensitive, []);
});

test('no sealed file: defaults, marked unsealed, and no passphrase needed', () => {
  const r = loadConfig({ dir: lockDir(), env: {} });
  assert.equal(r.sealed, false);
  assert.deepEqual(r.config, JSON.parse(JSON.stringify(DEFAULTS)));
});

test('a config sealed to the inbox opens with the lock and overlays the defaults', () => {
  const dir = lockDir();
  fs.writeFileSync(path.join(dir, 'config.sealed.json'), JSON.stringify(inboxSeal(JSON.stringify(MADE_UP), readInboxKey(dir))));
  assert.ok(!fs.readFileSync(path.join(dir, 'config.sealed.json'), 'utf8').includes('made-up-wallet'));
  const { config, sealed } = loadConfig({ dir, env });
  assert.equal(sealed, true);
  assert.equal(config.ticket, 4321);
  assert.equal(config.gemAt, 66);
  assert.deepEqual(config.holdDays, { ethereum: DEFAULTS.holdDays.ethereum, base: 5 }, 'holdDays merges per chain');
  assert.equal(config.toxicMarkout, DEFAULTS.toxicMarkout, 'untouched fields keep the default');
  assert.deepEqual(config.leakSensitive, ['made-up-wallet-label-xyz']);
  // the same keys work when passed in
  assert.equal(loadConfig({ dir, keys: unlock(readLock(dir), DUMMY) }).config.ticket, 4321);
});

test('planted faults: wrong or missing passphrase, a tampered file, a key from another lock all stop', () => {
  const dir = lockDir();
  const file = path.join(dir, 'config.sealed.json');
  const sealedEnv = inboxSeal(JSON.stringify(MADE_UP), readInboxKey(dir));
  fs.writeFileSync(file, JSON.stringify(sealedEnv));
  assert.throws(() => loadConfig({ dir, env: { LOCK_PASSPHRASE: 'wrong' } }), /wrong passphrase/);
  assert.throws(() => loadConfig({ dir, env: {} }), /missing passphrase/, 'never falls back to defaults silently');
  const ct = Buffer.from(sealedEnv.ct, 'base64');
  ct[2] ^= 1;
  fs.writeFileSync(file, JSON.stringify({ ...sealedEnv, ct: ct.toString('base64') }));
  assert.throws(() => loadConfig({ dir, env }), /does not open/);
  const other = lockDir();
  fs.writeFileSync(file, JSON.stringify(inboxSeal(JSON.stringify(MADE_UP), readInboxKey(other))));
  assert.throws(() => loadConfig({ dir, env }), /does not open/);
  fs.writeFileSync(file, 'not json');
  assert.throws(() => loadConfig({ dir, env }), /not JSON/);
});

test('validation names the field, never the value', () => {
  const bad = { ticket: -7777, gemAt: 150, stopLoss: 2, windows: ['24h', '24h'], holdDays: { ethereum: 0 }, leakSensitive: 'one-string', secretField: 'made-up-9999' };
  const probs = configProblems(bad);
  assert.equal(probs.length, 7);
  const text = probs.join(' ');
  for (const v of ['7777', '150', 'one-string', 'secretField', 'made-up-9999']) assert.ok(!text.includes(v), `value or unknown key echoed: ${v}`);
  assert.throws(() => mergeConfig(DEFAULTS, bad), (e) => /bad config/.test(e.message) && !e.message.includes('7777'));
  assert.throws(() => mergeConfig(DEFAULTS, [1, 2]), /JSON object/);
  assert.deepEqual(configProblems({ windows: ['24h', '7d', '30d'], priceSanity: 0.02 }), []);
});

test('a sealed config with a bad field stops the load', () => {
  const dir = lockDir();
  fs.writeFileSync(path.join(dir, 'config.sealed.json'), JSON.stringify(inboxSeal(JSON.stringify({ ticket: 'lots' }), readInboxKey(dir))));
  assert.throws(() => loadConfig({ dir, env }), /ticket: must be a positive number/);
});

test('leak strings: short ones are counted, not searched', () => {
  const r = leakStrings({ leakSensitive: ['abc', 'made-up-long-one', 'made-up-long-one', '12345'] });
  assert.deepEqual(r, { strings: ['made-up-long-one'], short: 2 });
  assert.deepEqual(leakStrings(null), { strings: [], short: 0 });
});
