// Cross-checks that compare our numbers with an independent reading (step 5).
import { swapFees } from './swaps.mjs';

const Q128 = 2 ** 128;

// Fee identity: each swap adds its LP fee ÷ the active liquidity to the pool's feeGrowthGlobal,
// so the day's replayed swaps must reproduce the counter's change between the window's ends.
// swaps: one pool's decoded swaps in the window; meta: its fee settings; fgThen/fgNow: [g0, g1].
// Returns the ratio replay ÷ counter per token side (null where nothing moved or unread).
export function feeIdentity(swaps, meta, fgThen, fgNow) {
  if (!fgThen || !fgNow) return null;
  const exp = [0, 0];
  for (const s of swaps) {
    const f = swapFees(s, meta);
    if (!f || !(s.liquidity > 0n)) continue;
    exp[s.in] += (Number(f.lp) * Q128) / Number(s.liquidity);
  }
  return [0, 1].map((side) => {
    const d = Number(BigInt.asUintN(256, fgNow[side] - fgThen[side]));
    return d > 0 && exp[side] > 0 ? exp[side] / d : null;
  });
}

// A pool's price for its base token against the market's, as a ratio (1 = agrees).
export function priceRatio({ poolPrice, quoteIs, usd0, usd1 }) {
  if (!(poolPrice > 0) || !(usd0 > 0) || !(usd1 > 0)) return null;
  const market = usd0 / usd1; // token1 per token0 at market prices
  return quoteIs === 0 ? market / poolPrice : poolPrice / market;
}
