// history.json's rows for one pool (docs/DATA.md), from its snapshot series (lib/snapshots.mjs):
//   h: [t, price, liquidity, lpFeesUsd, parked]   one row a UTC hour, the last 14 days
//   d: [t, price, lpFeesUsd, volUsd, parked]      one row a UTC day, the last 90 days
// price = token1 per token0 from that row's sqrtPriceX96; lpFeesUsd = the pool's LP fees from the row
// before to this one (fee growth × the interval's liquidity, at today's token prices); volUsd = those
// fees ÷ the LP fee rate. A row's fees need both rows' counters: the first row, or one after an unread
// row, has null fees, never 0. A pool's rows start where its series starts: before the pool existed
// there are no rows at all (absent, not zero). Pure.
import { deltaFg } from './windows.mjs';
import { usdOfPair } from './swaps.mjs';
import { poolPrice } from './pools.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const rnd = (x, n) => (isNum(x) ? Number(x.toPrecision(n)) : null);

// The LP fees between two rows, in USD; null when either row's counters or liquidity are unread.
export function intervalFeesUsd(a, b, { d0, d1, usd0, usd1 }) {
  if (!a || a.fg0 == null || a.fg1 == null || b.fg0 == null || b.fg1 == null || a.L == null || b.L == null) return null;
  const L = a.L > 0n && b.L > 0n ? (2n * a.L * b.L) / (a.L + b.L) : a.L > b.L ? a.L : b.L;
  return usdOfPair([(deltaFg(a.fg0, b.fg0) * L) >> 128n, (deltaFg(a.fg1, b.fg1) * L) >> 128n], d0, d1, usd0, usd1);
}

// series: { h, d } rows; pool: { d0, d1, usd0, usd1, rate (the LP fee rate: fee tier × the LPs' share) }.
export function historyRows(series, pool) {
  const { d0, d1, rate } = pool;
  const px = (row) => (row.sqrtPriceX96 != null ? rnd(poolPrice(row.sqrtPriceX96, d0, d1), 8) : null);
  const h = series?.h || [], d = series?.d || [];
  return {
    h: h.map((row, i) => [row.t, px(row), row.L == null ? null : rnd(Number(row.L), 8), rnd(intervalFeesUsd(h[i - 1], row, pool), 5), row.parked == null ? null : rnd(row.parked, 4)]),
    d: d.map((row, i) => { const f = intervalFeesUsd(d[i - 1], row, pool); return [row.t, px(row), rnd(f, 5), f != null && rate ? rnd(f / rate, 5) : null, row.parked == null ? null : rnd(row.parked, 4)]; }),
  };
}
