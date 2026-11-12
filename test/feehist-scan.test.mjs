// The fee history through the whole scan on the offline multi-chain fake world (test/fakes/fake-chains.mjs,
// MOCKUP · MADE-UP NUMBERS): history.json's y rows and yp per pool, the GeckoTerminal cache in snapshots.json
// reused pass after pass within its per-pass cap, no row before a pool existed, the deep backfill's block-time
// check (planted fault), the estimates leaving the windows and the gem untouched (absurd volumes), and a public
// log of counts and one ratio only.
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
const DUMMY = 'fee history scan test dummy passphrase, not a secret';
const DAY = 86400e3;
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-feehist-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const run = (env = {}) => {
    const t = Date.now();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'fakes', 'fake-chains.mjs')], { cwd: dir, encoding: 'utf8', timeout: 240e3,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY, MODE: 'live', ...env } });
    assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout.slice(-3000) + r.stderr.slice(-3000));
    return { ...r, t, gt: Number(/GeckoTerminal requests: (\d+)/.exec(r.stderr)?.[1]), pub: r.stdout.split('\n').filter((l) => l.trim()) };
  };
  const store = openStore({ lockDir: path.join(dir, 'lock'), outDir: path.join(dir, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  return { dir, run, store };
}
const fast = (calls) => JSON.stringify({ gt: { spacingMs: 0, ...(calls ? { calls } : {}) } });

test('history.json carries a year of daily fees per pool, the candle cache is reused within its cap, and no row predates a pool', () => {
  const w = world();
  const r1 = w.run({ FAKE_GT: '1', READ_CAPS: fast(4) });
  assert.equal(r1.gt, 4, 'the per-pass cap: 4 calls');
  const fh = r1.pub.find((l) => l.startsWith('fee history: '));
  assert.ok(fh, r1.pub.join('\n'));
  assert.ok(/estimated ÷ exact median (—|\d\.\d{3}) over \d+ days/.test(fh) && /4 calls/.test(fh), fh);
  assert.ok(r1.pub.every((l) => !/\$\d|0x[0-9a-f]{6,}|ONE\/WETH|THREE\/WETH/i.test(l)), 'counts and one ratio only in the public log');
  const spl = r1.pub.find((l) => l.startsWith('fee spikes: '));
  assert.ok(spl && /^fee spikes: \d+ days at 20× .* \d+ backed by the day's volume, \d+ marked unconfirmed in \d+ pools$/.test(spl), spl);
  const live = w.store.get('live.json'), hist = w.store.get('history.json'), snaps = w.store.get('snapshots.json');
  const today = Math.floor(live.t / DAY) * DAY;
  assert.equal(Object.keys(snaps.gt).length, 4, 'the cache holds what was fetched');
  for (const p of live.pools) {
    const h = hist.pools[p.id];
    assert.ok(Array.isArray(h.y) && h.yp && ['exact', 'est', 'age', 'dyn'].every((k) => k in h.yp), p.pair);
    assert.ok(h.y.length <= 365 && h.y.length > 0, `${p.pair}: ${h.y.length} rows`);
    assert.ok(h.y.every((r, i) => r.length === 3 && (i === 0 || r[0] - h.y[i - 1][0] === DAY)), 'one row a UTC day');
    assert.equal(h.y.at(-1)[0], today - DAY, 'yesterday last');
    assert.ok(h.y.every((r) => (r[2] === null) === (r[1] === null) && [null, 'x', 'e'].includes(r[2]) && (r[1] === null || r[1] >= 0)), 'null fees only with no source; never a negative');
    assert.equal(h.yp.exact, h.y.filter((r) => r[2] === 'x').length);
    if ('u' in h) assert.ok(Array.isArray(h.u.d) && Array.isArray(h.u.y) && h.u.d.length + h.u.y.length > 0 && [...h.u.d, ...h.u.y].every(Number.isFinite), `${p.pair}: u lists times only`);
    assert.equal(h.yp.est, h.y.filter((r) => r[2] === 'e').length);
    // Ethereum's daily backfill has no cap: its last 20 days are exact on the first pass (Base's fill within its cap)
    if (p.chain === 'ethereum') assert.ok(h.y.slice(-20).every((r) => r[2] === 'x'), `${p.pair}: the recent days are exact`);
    if (p.createdAt) assert.ok(h.y[0][0] >= Math.floor(p.createdAt / DAY) * DAY, `${p.pair}: no row before the pool existed (planted candles before it)`);
  }
  assert.ok(live.pools.some((p) => hist.pools[p.id].yp.est > 300), 'pools the cap reached show older days estimated');
  // pass 2: the two pools the cap left; pass 3: nothing (each pool's candles were fetched once)
  const r2 = w.run({ FAKE_GT: '1', READ_CAPS: fast(4) });
  assert.equal(r2.gt, 2);
  const crossed = (a, b) => Math.floor((a - 30 * 60e3) / DAY) !== Math.floor((b - 30 * 60e3) / DAY); // past 00:30 UTC: the daily top-up is due
  const r3 = w.run({ FAKE_GT: '1', READ_CAPS: fast(4) });
  if (!crossed(r1.t, Date.now())) assert.equal(r3.gt, 0, 'reused, not refetched');
  const h3 = w.store.get('history.json');
  assert.ok(Object.values(h3.pools).every((h) => h.yp.est + h.yp.exact === h.y.length), 'every day of every pool has a value now');
  // the deep backfill kept going: more exact days on pass 3 than on pass 1
  const ex = (h) => Object.values(h.pools).reduce((a, x) => a + x.yp.exact, 0);
  assert.ok(ex(h3) > ex(hist), `exact days ${ex(hist)} then ${ex(h3)}`);
});

test('absurd estimates (volumes × 1,000,000) leave every window and gem as they were', () => {
  const a = world(), b = world();
  a.run({ FAKE_GT: '1', READ_CAPS: fast() });
  b.run({ FAKE_GT: '1000000', READ_CAPS: fast() });
  const la = a.store.get('live.json'), lb = b.store.get('live.json'), hb = b.store.get('history.json');
  assert.ok(Object.values(hb.pools).some((h) => h.y.some((r) => r[2] === 'e' && r[1] > 1e6)), 'the absurd estimates are there, in y');
  // two runs of the fake world differ by a few parts in 10,000 (their clocks); a leak of the estimates would be × 1,000,000
  const pick = (live) => live.pools.map((p) => [p.id, Object.entries(p.w).map(([k, x]) => [k, x && [x.lpFeesUsd, x.volUsd, x.feeApr, x.net, x.gem.total, x.gem.yield]]), p.daily.map((d) => [d.feesPer1k, d.net])]);
  const close = (x, y) => (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) <= 0.01 * Math.max(Math.abs(x), Math.abs(y), 1) : Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => close(v, y[i])) : x === y);
  const [pa, pb] = [pick(la), pick(lb)];
  assert.ok(pa.length === pb.length && pa.length > 4 && close(pa, pb), JSON.stringify(pb).slice(0, 600) + ' vs ' + JSON.stringify(pa).slice(0, 600));
  // planted fault: a 30-day window fed the absurd estimates is caught by the same comparison
  const fed = structuredClone(pa); fed[0][1][2][1][0] = (fed[0][1][2][1][0] ?? 0) + 1e6;
  assert.equal(close(fed, pb), false);
});

test('planted fault: nodes answering old blocks with today\'s state — the deep backfill drops those batches, no exact day from them', () => {
  const w = world();
  const r = w.run({ FAKE_GT: '1', READ_CAPS: fast(), FAULT: 'deep-today' });
  const fh = r.pub.find((l) => l.startsWith('fee history: '));
  assert.match(fh, /deep backfill 0 rows from [1-9]\d* batches planned/);
  const live = w.store.get('live.json'), hist = w.store.get('history.json'), today = Math.floor(live.t / DAY) * DAY;
  for (const h of Object.values(hist.pools)) assert.ok(h.y.every((x) => x[2] !== 'x' || x[0] >= today - 91 * DAY), 'no exact day older than the honest blocks');
});
