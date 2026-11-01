// Pair view data (lib/pairs.mjs) on made-up pools: one pair across v3 and v4 tiers with native ETH and
// WETH, volume shares, fees per $1,000 a day, the best verified pool, and nulls for missing numbers.
// Each check also runs against a planted fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPairs, pairKey, ZERO_ADDR } from '../lib/pairs.mjs';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', TOK = '0x1111111111111111111111111111111111111111', USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const win = (volUsd, lpFeesUsd, feeApr, net) => ({ volUsd, lpFeesUsd, feeApr, net });
const pool = (id, t0, t1, verified, w30) => ({ id, verified, t0: { addr: t0, sym: t0 === ZERO_ADDR ? 'ETH' : t0 === WETH ? 'WETH' : 'MADE' }, t1: { addr: t1, sym: t1 === WETH ? 'WETH' : 'MADE' },
  w: { '24h': null, '7d': null, '30d': w30 } });
const pools = [
  pool('v3-005', TOK, WETH, true, win(600e3, 300, 0.10, 0.04)),
  pool('v3-030', TOK, WETH, true, win(300e3, 900, 0.25, 0.12)),
  pool('v3-100', TOK, WETH, true, win(null, null, null, null)),           // unread: never a zero share
  pool('v4-030', ZERO_ADDR, TOK, false, win(100e3, 300, 0.60, 0.40)),     // native ETH, unverified: never the best
  pool('other', USDC, WETH, true, win(5e6, 2500, 0.02, -0.01)),
];

// The checks.
const oneGroup = (r) => r.pairs[pairKey(TOK, WETH, { weth: WETH })]?.pools.length === 4;
const sharesRight = (rows) => Math.abs(rows.filter((x) => x.volumeShare != null).reduce((s, x) => s + x.volumeShare, 0) - 1) < 1e-12 && rows.find((x) => x.id === 'v3-100').volumeShare === null;

test('pools group by unordered pair with ETH as WETH; shares, fees per $1,000 a day and the best verified pool', () => {
  const r = buildPairs(pools, { weth: WETH, defaultWindow: '30d' });
  assert.ok(oneGroup(r));
  assert.equal(Object.keys(r.pairs).length, 2);
  const p = r.pairs[pairKey(WETH, TOK, { weth: WETH })];
  assert.equal(r.keyOf.get('v4-030'), pairKey(TOK, WETH, { weth: WETH }));
  assert.ok(p.label === 'MADE/WETH' || p.label === 'WETH/MADE');
  const w = p.w['30d'];
  assert.equal(w.volUsd, 1e6);
  assert.equal(w.lpFeesUsd, 1500);
  assert.equal(w.unread, 1);
  assert.ok(sharesRight(w.rows));
  assert.ok(Math.abs(w.rows.find((x) => x.id === 'v3-030').volumeShare - 0.3) < 1e-12);
  assert.ok(Math.abs(w.rows.find((x) => x.id === 'v3-030').feesPer1kDay - 250 / 365) < 1e-12);
  assert.equal(p.best, 'v3-030', 'the unverified pool has the higher net APR but is never the best');
  assert.equal(p.w['24h'].volUsd, null, 'no window data: null totals, never 0');
  assert.ok(p.w['24h'].rows.every((x) => x.volumeShare === null && x.feesPer1kDay === null));
  // planted faults: ETH not read as WETH splits the pair; an unread volume counted as 0 gets a share; an
  // unverified pool allowed as best
  const split = buildPairs(pools, { weth: null });
  assert.equal(oneGroup(split), false);
  const zeroed = buildPairs(pools.map((x) => (x.id === 'v3-100' ? { ...x, w: { ...x.w, '30d': win(0, 0, null, null) } } : x)), { weth: WETH });
  assert.equal(sharesRight(zeroed.pairs[pairKey(TOK, WETH, { weth: WETH })].w['30d'].rows), false);
  const anyBest = buildPairs(pools.map((x) => ({ ...x, verified: true })), { weth: WETH }).pairs[pairKey(TOK, WETH, { weth: WETH })].best;
  assert.notEqual(anyBest, p.best);
});
