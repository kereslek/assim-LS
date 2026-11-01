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

// Exact integer versions of the pool's own maths (v3-core TickMath and SqrtPriceMath, the same in
// v4-core), for replaying swaps unit for unit. All BigInt; prices are sqrtPriceX96.
const Q96n = 1n << 96n;
const MAX256 = (1n << 256n) - 1n;
const TICK_MULS = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n, 0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n, 0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n, 0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
];
export function sqrtRatioAtTick(tick) {
  const abs = BigInt(Math.abs(tick));
  if (abs > BigInt(MAX_TICK)) throw new Error('tick out of range');
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  TICK_MULS.forEach((m, i) => { if (abs & (1n << BigInt(i + 1))) ratio = (ratio * m) >> 128n; });
  if (tick > 0) ratio = MAX256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
const mulDivUp = (a, b, d) => { const p = a * b; return p / d + (p % d ? 1n : 0n); };
const divUp = (a, d) => a / d + (a % d ? 1n : 0n);
// Token amounts between two prices at liquidity L (SqrtPriceMath.getAmount0Delta / getAmount1Delta).
export function amount0Delta(a, b, L, roundUp) {
  if (a > b) [a, b] = [b, a];
  const n1 = BigInt(L) << 96n, n2 = b - a;
  return roundUp ? divUp(mulDivUp(n1, n2, b), a) : (n1 * n2) / b / a;
}
export function amount1Delta(a, b, L, roundUp) {
  if (a > b) [a, b] = [b, a];
  return roundUp ? mulDivUp(BigInt(L), b - a, Q96n) : (BigInt(L) * (b - a)) / Q96n;
}
