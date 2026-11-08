// The chosen lenses: 1 stranded liquidity, 2 fresh pool, 3 after a big move, 5 calm pairs, and
// the toxic-flow filter (8) that runs on all of them. Each returns { on, why } or null when an
// input is missing; thresholds are defaults and the sealed config can override them.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x) => `${Math.round(x * 100)}%`;

export const DEFAULTS = {
  strandedMin: 0.8, // share of value parked away from the price (above its own level), 30-day average
  freshMaxPoolDays: 30,
  freshMinPairDays: 180, // the 2023 rule: the pair has traded for at least six months
  freshMinVolumeShare: 0.2,
  moveSigmas: 2, // a 7-day move of at least 2 sigma-weeks
  calmMaxSigma: 0.005,
  calmKinds: ['staked-eth', 'btc-wrapper', 'stable'],
  calmMaxPegGap: 0.01,
  maxMarkoutToFee: 0.6,
  cexRatioHigh: 10, // a day's exchange volume of the token at least 10× the pool's value within ±9%
  tierVsSigmaMin: 2, // the fee tier at least two blocks' σ
  retailHigh: 0.6, // at least 60% of the LP fees from flow that isn't arbitrage
  retailRise: 0.1, // or up at least 10 points on the next longer window
};

export function lensStranded({ stranded30 }, c = DEFAULTS) {
  if (!isNum(stranded30)) return null;
  return { on: stranded30 >= c.strandedMin, why: `${pct(stranded30)} of value parked away from the price (30-day average)` };
}

// A new pool of an old pair is taking volume before liquidity arrives.
export function lensFreshPool({ poolAgeDays, pairAgeDays, volumeShare, liquidityShare }, c = DEFAULTS) {
  if (![poolAgeDays, pairAgeDays, volumeShare, liquidityShare].every(isNum)) return null;
  const on = poolAgeDays <= c.freshMaxPoolDays && pairAgeDays >= c.freshMinPairDays &&
    volumeShare >= c.freshMinVolumeShare && liquidityShare <= volumeShare / 2;
  return { on, why: `${pct(volumeShare)} of the pair's volume with ${pct(liquidityShare)} of its liquidity, pool ${Math.round(poolAgeDays)} days old` };
}

// A big 7-day move that has stalled: ranges were left behind, and the last day was calm.
export function lensAfterMove({ move7dLog, lastDayLog, sigma }, c = DEFAULTS) {
  if (![move7dLog, lastDayLog, sigma].every(isNum) || sigma <= 0) return null;
  const sigmas = Math.abs(move7dLog) / (sigma * Math.sqrt(7));
  const on = sigmas >= c.moveSigmas && Math.abs(lastDayLog) <= sigma;
  return { on, why: `moved ${sigmas.toFixed(1)} sigma-weeks in 7 days; last day ${Math.abs(lastDayLog) <= sigma ? 'calm' : 'still moving'}` };
}

export function lensCalmPair({ sigma, kind, pegGap = null }, c = DEFAULTS) {
  if (!isNum(sigma) || !kind) return null;
  const pegOk = pegGap == null || Math.abs(pegGap) <= c.calmMaxPegGap;
  return { on: sigma <= c.calmMaxSigma && c.calmKinds.includes(kind) && pegOk, why: `daily sigma ${(sigma * 100).toFixed(2)}%, ${kind}${pegOk ? '' : ', off its peg'}` };
}

// Filter 8: markout = how far the price moves against LPs right after swaps, per unit of volume,
// compared with the fee rate. Above the threshold the flow is mostly informed (arbitrage).
export function toxicFilter({ markoutToFee }, c = DEFAULTS) {
  if (!isNum(markoutToFee)) return null;
  return { pass: markoutToFee <= c.maxMarkoutToFee, why: `markouts take ${pct(markoutToFee)} of the fee` };
}

// Exchange-led: the token trades mostly on centralised exchanges (cexRatio = their 24 h volume ÷ the pool's
// value within ±9%) and the fee tier is wide against one block's move (tierVsSigma): arbitrage against the
// exchanges reprices the pool in steps the fee covers.
export function lensCexLed({ cexRatio, tierVsSigma }, c = DEFAULTS) {
  if (!isNum(cexRatio) || !isNum(tierVsSigma)) return null;
  return { on: cexRatio >= c.cexRatioHigh && tierVsSigma >= c.tierVsSigmaMin, why: `exchange volume ${cexRatio.toFixed(1)}× the value within ±9%; fee tier ${tierVsSigma.toFixed(1)} blocks' σ` };
}

// Retail: most of the LP fees come from flow that doesn't look like arbitrage, or that share is rising
// (this window against the next longer one).
export function lensRetail({ share, longer = null }, c = DEFAULTS) {
  if (!isNum(share)) return null;
  const rising = isNum(longer) && share - longer >= c.retailRise;
  return { on: share >= c.retailHigh || rising, why: `${pct(share)} of LP fees from non-arbitrage flow${isNum(longer) ? ` (${rising ? 'up' : 'vs'} ${pct(longer)} on the longer window)` : ''}` };
}
