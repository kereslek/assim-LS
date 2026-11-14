// The volume and TVL history through the whole scan on the offline multi-chain fake world (test/fakes/fake-chains.mjs,
// MOCKUP · MADE-UP NUMBERS): history.json's yv and yt aligned to the y rows for every pool; a v3-style pool's balances
// recorded by the first pass after midnight and backfilled at archive blocks; a v4 pool's map value only; Base's days
// past its archive reach null; nothing before a pool existed; the archive reads within the deep backfill's batches;
// balances × 1,000,000 leave every window and gem as they were; balance reads that revert leave the TVL null, never 0;
// and a public log of counts and two ratios only.
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
const DUMMY = 'tvl history scan test dummy passphrase, not a secret';
const DAY = 86400e3;
const FAST = JSON.stringify({ gt: { spacingMs: 0 } });
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-tvlhist-'));
  initLock({ dir: path.join(dir, 'lock'), passphrase: DUMMY, iterations: 1000 });
  const run = (env = {}) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'fakes', 'fake-chains.mjs')], { cwd: dir, encoding: 'utf8', timeout: 240e3,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCK_PASSPHRASE: DUMMY, MODE: 'live', FAKE_GT: '1', READ_CAPS: FAST, NODE_OPTIONS: `--import ${path.join(ROOT, 'test', 'fakes', 'noon.mjs')}`, ...env } });
    assert.ok(r.stdout.includes('PASS sealed outputs'), r.stdout.slice(-3000) + r.stderr.slice(-3000));
    return { ...r, bal: Number(/balanceOf calls: ethereum (\d+)/.exec(r.stderr)?.[1]) + Number(/balanceOf calls: ethereum \d+, base (\d+)/.exec(r.stderr)?.[1]), pub: r.stdout.split('\n').filter((l) => l.trim()) };
  };
  const store = openStore({ lockDir: path.join(dir, 'lock'), outDir: path.join(dir, 'out', 'data'), env: { LOCK_PASSPHRASE: DUMMY } });
  return { dir, run, store };
}
const line = (r, head) => r.pub.find((l) => l.startsWith(head + ': '));
const TVL_LINE = /^tvl history: \d+ pool-days of \d+ with a value \(\d+ from balances at archive blocks, \d+ recorded by the passes, \d+ from liquidity maps\), \d+ not readable \(\d+ v4 days before recording, \d+ past Base's archive reach\), \d+ still to read; this pass \+\d+ \(\d+ balances, \d+ recorded, \d+ maps\), \d+ reads unread; yesterday ÷ the pool list's TVL median (—|\d+\.\d\d) over \d+ pools$/;
const VOL_LINE = /^volume history: \d+ pool-days of \d+ with a value \(\d+ from swaps, \d+ from candles\), \d+ unread; swaps÷candle median (—|\d+\.\d\d) over \d+ days$/;

test('history.json: yv and yt aligned to y for every pool; v3 balances recorded after midnight and backfilled, v4 maps only, Base within its reach', () => {
  const w = world();
  const r1 = w.run({ FAKE_CLOCK: '00:20' });
  for (const [head, re] of [['tvl history', TVL_LINE], ['volume history', VOL_LINE]]) assert.match(line(r1, head) ?? '', re, r1.pub.join('\n'));
  assert.ok(r1.pub.every((l) => !/\$\d|0x[0-9a-f]{6,}|ONE\/WETH|THREE\/WETH/i.test(l)), 'counts and ratios only in the public log');
  assert.ok(r1.bal > 0, 'balances read');
  const fh = /deep backfill \d+ rows from (\d+) batches planned/.exec(line(r1, 'fee history'));
  assert.ok(fh && Number(fh[1]) <= 40 + 12, 'within the deep backfill\'s batches (Ethereum 40, Base 12)');
  const live = w.store.get('live.json'), hist = w.store.get('history.json'), today = Math.floor(live.t / DAY) * DAY;
  let v3 = 0;
  for (const p of live.pools) {
    const h = hist.pools[p.id];
    assert.ok(Array.isArray(h.yv) && Array.isArray(h.yt) && h.yvp && h.ytp, p.pair);
    assert.equal(h.yv.length, h.y.length, `${p.pair}: one volume row per fee row`);
    assert.equal(h.yt.length, h.y.length, `${p.pair}: one TVL row per fee row`);
    for (const [rows, srcs] of [[h.yv, ['s', 'g']], [h.yt, ['b', 'r', 'm']]]) {
      assert.ok(rows.every((x) => x.length === 2 && (x[0] === null) === (x[1] === null) && (x[0] === null || (x[0] >= 0 && srcs.includes(x[1])))), `${p.pair}: a value with its source, or null with none`);
    }
    assert.deepEqual(h.yvp, { s: h.yv.filter((x) => x[1] === 's').length, g: h.yv.filter((x) => x[1] === 'g').length });
    for (const k of ['b', 'r', 'm']) assert.equal(h.ytp[k], h.yt.filter((x) => x[1] === k).length);
    const yest = h.yt.at(-1);
    if (p.v === 4) {
      assert.equal(h.ytp.lim, 'v4');
      assert.ok(h.yt.every((x) => x[1] === null || x[1] === 'm'), 'a v4 pool: its map only, never a balance');
      assert.equal(yest[1], 'm', 'yesterday\'s end from this pass\'s map');
    } else {
      v3++;
      assert.equal(yest[1], 'r', `${p.pair}: yesterday's end recorded by the pass`);
      assert.ok(Math.abs(yest[0] / p.tvlUsd - 1) < 0.02, `${p.pair}: ${yest[0]} vs the pool list's ${p.tvlUsd}`);
      assert.ok(h.yt.some((x) => x[1] === 'b'), `${p.pair}: past days backfilled from archive blocks`);
    }
    if (p.chain === 'base') {
      assert.equal(h.ytp.lim, 'archive');
      assert.ok(h.ytp.from >= today - 91 * DAY && h.ytp.from <= today - 88 * DAY, 'about 90 days');
      h.y.forEach((row, i) => { if (row[0] < h.ytp.from) assert.equal(h.yt[i][0], null, `${p.pair}: nothing past the archive's reach`); });
    }
    // the young pool's rows start on its creation day: no TVL or volume before it (planted candles from before it exist)
    if (p.createdAt) assert.ok(h.y[0][0] >= Math.floor(p.createdAt / DAY) * DAY);
  }
  assert.ok(v3 >= 4);
  // the next pass in the same hour: yesterday is held, never read or recorded again
  const r2 = w.run({ FAKE_CLOCK: '00:25' });
  assert.match(line(r2, 'tvl history'), /this pass \+\d+ \(\d+ balances, 0 recorded, 0 maps\)/);
  const h2 = w.store.get('history.json');
  for (const p of live.pools) assert.deepEqual(h2.pools[p.id].yt.at(-1), hist.pools[p.id].yt.at(-1));
  const more = (h) => Object.values(h.pools).reduce((a, x) => a + x.ytp.b, 0);
  assert.ok(more(h2) > more(hist), `the backfill went on: ${more(hist)} then ${more(h2)} days from balances`);
});

test('balances × 1,000,000 leave every window and gem as they were; only the TVL history moves', () => {
  const a = world(), b = world();
  a.run({ FAKE_NOON: '1' });
  b.run({ FAKE_NOON: '1', FAKE_BAL: '1000000' });
  const la = a.store.get('live.json'), lb = b.store.get('live.json'), ha = a.store.get('history.json'), hb = b.store.get('history.json');
  const big = (h) => Object.values(h.pools).flatMap((x) => x.yt).filter((x) => x[1] === 'b').map((x) => x[0]);
  assert.ok(big(ha).length && big(hb).length, 'backfilled days in both');
  assert.ok(Math.min(...big(hb)) > 1e4 * Math.max(...big(ha)), 'the absurd balances are there, in yt');
  const pick = (live) => live.pools.map((p) => [p.id, p.tvlUsd, p.mapUsd, Object.entries(p.w).map(([k, x]) => [k, x && [x.lpFeesUsd, x.volUsd, x.feeApr, x.aggApr, x.net, x.gem.total, x.gem.yield, x.lenses]]), p.daily.map((d) => [d.feesPer1k, d.net])]);
  // within 1% of each other (two runs of the fake world differ by a few parts in 10,000), however small: a leak of the
  // TVL into a fraction as small as the fake world's aggApr (about 0.0004) must not hide under an absolute tolerance
  const close = (x, y) => (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) <= 0.01 * Math.max(Math.abs(x), Math.abs(y)) : Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => close(v, y[i])) : x === y);
  const [pa, pb] = [pick(la), pick(lb)];
  assert.ok(pa.length === pb.length && pa.length > 4 && close(pa, pb), JSON.stringify(pb).slice(0, 600) + ' vs ' + JSON.stringify(pa).slice(0, 600));
  // planted fault: a window's aggApr fed from the absurd TVL (÷ 1,000,000) is caught by the same comparison
  const fed = structuredClone(pa), w24 = fed.find((x) => x[3][0][1]?.[3] > 0)[3][0][1];
  w24[3] /= 1e6;
  assert.equal(close(fed, pb), false);
});

test('balance reads that revert: the TVL stays null (never 0), the reads are counted unread, a v4 pool\'s map still counts', () => {
  const w = world();
  const r = w.run({ FAKE_CLOCK: '00:20', FAULT: 'bal-revert' });
  const tl = line(r, 'tvl history');
  assert.match(tl, TVL_LINE);
  assert.ok(Number(/(\d+) reads unread/.exec(tl)[1]) > 0, tl);
  assert.match(tl, /\(0 from balances at archive blocks, 0 recorded by the passes/);
  const live = w.store.get('live.json'), hist = w.store.get('history.json');
  for (const p of live.pools) {
    const yt = hist.pools[p.id].yt;
    if (p.v === 3) assert.ok(yt.every((x) => x[0] === null && x[1] === null), `${p.pair}: null, never 0`);
    else assert.equal(yt.at(-1)[1], 'm');
  }
  assert.ok(live.pools.every((p) => p.w['24h'] && Number.isFinite(p.w['24h'].lpFeesUsd)), 'the windows ran as before');
});
