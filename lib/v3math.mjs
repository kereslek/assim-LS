// Uniswap v3/v4 concentrated-liquidity maths: ticks, prices, token amounts, and the liquidity
// map rebuilt from initialized ticks. Prices are token1 per token0.

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const LN_BASE = Math.log(1.0001);

export const tickToPrice = (tick, d0 = 0, d1 = 0) => Math.pow(1.0001, tick) * 10 ** (d0 - d1);
export const priceToTick = (p, d0 = 0, d1 = 0) => Math.floor(Math.log(p / 10 ** (d0 - d1)) / LN_BASE);
export const sqrtAtTick = (tick) => Math.pow(1.0001, tick / 2); // sqrt of the raw price
export const sqrtX96ToSqrt = (sqrtPriceX96) => Number(sqrtPriceX96) / 2 ** 96;
export const ticksForLog = (r) => r / LN_BASE; // a log-price distance in ticks
export const logForTicks = (t) => t * LN_BASE;

// Raw token amounts held by liquidity L over ticks [ta, tb) when the pool sits at sqrt price sp.
export function amountsInRange(L, ta, tb, sp) {
  const a = sqrtAtTick(ta), b = sqrtAtTick(tb), l = Number(L);
  if (sp <= a) return [(l * (b - a)) / (a * b), 0]; // range above the price: token0 only
  if (sp >= b) return [0, l * (b - a)]; // range below the price: token1 only
  return [(l * (b - sp)) / (sp * b), l * (sp - a)];
}

// Value of liquidity L over [ta, tb), in human units of token1, at sqrt price sp.
export function valueInRange(L, ta, tb, sp, d1 = 0) {
  const [a0, a1] = amountsInRange(L, ta, tb, sp);
  return (a0 * sp * sp + a1) / 10 ** d1;
}

// Rebuild the active-liquidity map from initialized ticks [{ tick, liquidityNet }] (liquidityNet as BigInt).
// Returns contiguous segments [{ lo, hi, L }] between initialized ticks, plus the checks that prove the
// read was complete: liquidityNet sums to zero, liquidity never goes negative, and the walk reproduces
// the pool's own liquidity at the current tick.
export function liquidityMap({ ticks, tickCurrent, liquidity }) {
  const ts = [...ticks].sort((x, y) => x.tick - y.tick);
  let L = 0n, negative = false, walked = 0n, sum = 0n;
  const segments = [];
  for (let i = 0; i < ts.length; i++) {
    L += BigInt(ts[i].liquidityNet);
    sum += BigInt(ts[i].liquidityNet);
    if (L < 0n) negative = true;
    const lo = ts[i].tick;
    const hi = i + 1 < ts.length ? ts[i + 1].tick : MAX_TICK;
    if (hi > lo) segments.push({ lo, hi, L });
    if (lo <= tickCurrent && tickCurrent < hi) walked = L;
  }
  return {
    segments,
    checks: {
      initialized: ts.length,
      netSumZero: sum === 0n,
      neverNegative: !negative,
      walkedLiquidity: walked,
      matchesPool: liquidity == null ? null : walked === BigInt(liquidity),
    },
  };
}

// Initialized ticks inside one 256-bit tickBitmap word.
export function ticksInWord(wordIndex, bitmap, tickSpacing) {
  const out = [];
  let b = BigInt(bitmap);
  for (let bit = 0; b !== 0n; bit++, b >>= 1n) {
    if (b & 1n) out.push((wordIndex * 256 + bit) * tickSpacing);
  }
  return out;
}

// The bitmap words that cover every usable tick for a spacing.
export function bitmapWordRange(tickSpacing) {
  const lo = Math.floor(Math.floor(MIN_TICK / tickSpacing) / 256);
  const hi = Math.floor(Math.floor(MAX_TICK / tickSpacing) / 256);
  return { lo, hi };
}
