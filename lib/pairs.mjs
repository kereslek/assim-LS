// Pairs: every scored pool grouped by its unordered token pair (native ETH counts as WETH), so the page
// can show all of a pair's pools side by side: each pool's share of the pair's volume, what $1,000 at the
// price would earn a day after diluting next to what is already there, net APR, and the best pool to enter.
// Pure: no I/O. Missing is never zero: a pool without a number gets null, and the pair totals add up only
// the pools that have one (with `unread` counting the rest).

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// "<lower address>-<higher address>", with native ETH (the zero address) read as WETH.
export function pairKey(a, b, { weth }) {
  const n = (x) => { const s = String(x || '').toLowerCase(); return s === ZERO_ADDR && weth ? weth.toLowerCase() : s; };
  const [x, y] = [n(a), n(b)].sort();
  return `${x}-${y}`;
}

// pools: live.json Pool objects (t0/t1 with addr and sym, verified, w: { window: Window|null }).
// Returns { pairs: { key: { label, pools, best, w } }, keyOf: Map(pool id → key) }.
export function buildPairs(pools, { weth, windows = ['24h', '7d', '30d'], defaultWindow = '30d' } = {}) {
  const groups = new Map(), keyOf = new Map();
  for (const p of pools) {
    const k = pairKey(p.t0?.addr, p.t1?.addr, { weth });
    keyOf.set(p.id, k);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const pairs = {};
  for (const [k, ps] of groups) {
    const sym = (t) => (String(t?.addr || '').toLowerCase() === ZERO_ADDR ? 'WETH' : t?.sym ?? '?');
    const [a] = k.split('-');
    const first = ps[0], s0 = String(first.t0?.addr || '').toLowerCase() === a || (String(first.t0?.addr || '').toLowerCase() === ZERO_ADDR && a === String(weth || '').toLowerCase());
    const label = s0 ? `${sym(first.t0)}/${sym(first.t1)}` : `${sym(first.t1)}/${sym(first.t0)}`;
    const w = {};
    for (const win of windows) {
      const ws = ps.map((p) => ({ p, x: p.w?.[win] ?? null }));
      const vols = ws.map(({ x }) => (isNum(x?.volUsd) ? x.volUsd : null)), fees = ws.map(({ x }) => (isNum(x?.lpFeesUsd) ? x.lpFeesUsd : null));
      const known = vols.filter((v) => v != null);
      const volUsd = known.length ? known.reduce((s, v) => s + v, 0) : null;
      const kf = fees.filter((v) => v != null);
      w[win] = {
        volUsd, lpFeesUsd: kf.length ? kf.reduce((s, v) => s + v, 0) : null, unread: vols.filter((v) => v == null).length,
        rows: ws.map(({ p, x }, i) => ({
          id: p.id,
          volumeShare: vols[i] != null && volUsd > 0 ? vols[i] / volUsd : null,
          feesPer1kDay: isNum(x?.feeApr) ? (x.feeApr * 1000) / 365 : null, // the fee APR at the ticket, already diluted
          net: isNum(x?.net) ? x.net : null,
        })),
      };
    }
    // the best pool to enter: the highest net APR in the default window among pools whose swaps were verified
    const cand = (w[defaultWindow]?.rows || []).filter((r) => r.net != null && ps.find((p) => p.id === r.id)?.verified === true);
    const best = cand.length ? cand.reduce((m, r) => (r.net > m.net ? r : m)).id : null;
    pairs[k] = { label, pools: ps.map((p) => p.id), best, w };
  }
  return { pairs, keyOf };
}
