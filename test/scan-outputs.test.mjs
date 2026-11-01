// The scan end to end on the offline fake world (tools/fakes, MOCKUP · MADE-UP NUMBERS) with a throwaway
// lock and a made-up sealed config: the sealed live.json, history.json and snapshots.json follow
// docs/DATA.md, the config reaches the outputs, and the public log holds areas, pass/fail and counts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLock } from '../lib/lock.mjs';
import { openStore } from '../lib/store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DUMMY = 'scan outputs test dummy passphrase, not a secret';
const LIVE_KEYS = ['v', 't', 'phase', 'build', 'next', 'ticket', 'stopLoss', 'windows', 'defaultWindow', 'gemAt', 'chains', 'health', 'bench', 'pools'];
const POOL_KEYS = ['id', 'chain', 'v', 'pair', 't0', 't1', 'feeTier', 'dynamicFee', 'lpKeeps', 'hooks', 'verified', 'firstSeen', 'createdAt', 'pairAgeDays', 'young',
  'tvlUsd', 'mapUsd', 'aggUsd', 'price', 'marketRatio', 'offMarket', 'shape', 'w', 'checks', 'gemFirstAt'];
const WIN_KEYS = ['days', 'partial', 'volUsd', 'lpFeesUsd', 'protocolFeesUsd', 'swaps', 'traders', 'sigma', 'range', 'rerangeDays', 'inRangeUsd', 'feeApr', 'lvr',
  'swapCost', 'gas', 'net', 'edge', 'aggApr', 'parkedAvg', 'strandedShare', 'markout', 'gem', 'lenses', 'spark'];
const finite = (x) => x === null || typeof x !== 'number' || Number.isFinite(x);
const walk = (x) => (Array.isArray(x) ? x.every(walk) : x && typeof x === 'object' ? Object.values(x).every((v) => v !== undefined && walk(v)) : finite(x));
// The contract check.
function contractOk(live) {
  const has = (o, ks) => o && ks.every((k) => k in o);
  return has(live, LIVE_KEYS) && live.v === 1 && Array.isArray(live.pools) && live.pools.length > 0 && walk(live) &&
    live.pools.every((p) => has(p, POOL_KEYS) && live.windows.every((w) => p.w[w] === null || has(p.w[w], WIN_KEYS)));
}

test('the scan writes sealed outputs per docs/DATA.md and prints only areas, pass/fail and counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-scan-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const sealCfg = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seal-input.mjs'), '--out', 'lock/config.sealed.json'],
    { cwd: dir, input: JSON.stringify({ ticket: 2718, gemAt: 57, holdDays: { ethereum: 11 } }), encoding: 'utf8' });
  assert.equal(sealCfg.status, 0, sealCfg.stdout + sealCfg.stderr);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'fakes', 'fake-scan.mjs')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY } });
  assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout + r.stderr);
  const pub = r.stdout.split('\n').filter((l) => l.trim());
  assert.ok(pub.every((l) => !/\$\d|0x[0-9a-f]{6,}|2718|ONE\/WETH/i.test(l)), 'no amounts, addresses, config values or pools in the public log');
  assert.ok(pub.some((l) => /^pass: \d+ lines \(sealed\)/.test(l)));
  const store = openStore({ lockDir: path.join(dir, 'lock'), outDir: path.join(dir, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  const live = store.get('live.json'), hist = store.get('history.json'), snaps = store.get('snapshots.json');
  assert.ok(contractOk(live), 'live.json follows the contract');
  assert.ok(live.pools.every((p) => live.pairs[p.pairKey]?.pools.includes(p.id)), 'every pool sits in its pair');
  assert.equal(live.defaultWindow, '24h');
  assert.ok(live.pools.every((p) => Array.isArray(p.daily) && p.daily.length <= 30 && 'pattern' in p && 'burst' in p && !('daily' in (p.w['24h'] || {}))));
  assert.ok(live.pools.every((p) => p.w['24h'] == null || Array.isArray(p.w['24h'].gem.tags)), 'Gem now carries its tags');
  assert.equal(live.ticket, 2718, 'the sealed config reaches live.json');
  assert.equal(live.gemAt, 57);
  assert.ok(live.pools.every((p) => p.w['30d'] && p.w['30d'].days >= 29), 'the backfill gives a full 30-day window on the first pass');
  assert.ok(live.pools.every((p) => p.w['24h'] && p.w['24h'].days >= 0.95 && p.w['24h'].lpFeesUsd != null), 'the hourly backfill covers the 24-hour window on the first pass');
  assert.ok(hist.v === 1 && Object.keys(hist.pools).length === live.pools.length && Array.isArray(hist.health));
  assert.ok(snaps.v === 1 && Object.keys(snaps.pools).length === live.pools.length);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'out', 'shortlist.json'), 'utf8')).ids.length >= 1);
  for (const f of fs.readdirSync(path.join(dir, 'out', 'data'))) assert.ok(!fs.readFileSync(path.join(dir, 'out', 'data', f), 'utf8').includes('2718'), `${f} is sealed`);
  // planted faults: a missing field, a window field left undefined, or a NaN fails the contract check
  const bad1 = structuredClone(live); delete bad1.pools[0].shape;
  const bad2 = structuredClone(live); delete bad2.pools[0].w['30d'].feeApr;
  const bad3 = structuredClone(live); bad3.pools[0].w['30d'].net = NaN;
  for (const b of [bad1, bad2, bad3]) assert.equal(contractOk(b), false);
});
