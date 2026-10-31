// The chosen lenses: 1 stranded liquidity, 2 fresh pool, 3 after a big move, 5 calm pairs, and
// the toxic-flow filter (8) that runs on all of them. Each returns { on, why } or null when an
// input is missing; thresholds are defaults and the sealed config can override them.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x) => `${Math.round(x * 100)}%`;

export const DEFAULTS = {
  strandedMin: 0.8, // share of value outside the suggested range, 30-day average
  freshMaxPoolDays: 30,
  freshMinPairDays: 180, // the 2023 rule: the pair has traded for at least six months
  freshMinVolumeShare: 0.2,
  moveSigmas: 2, // a 7-day move of at least 2 sigma-weeks
  calmMaxSigma: 0.005,
  calmKinds: ['staked-eth', 'btc-wrapper', 'stable'],
  calmMaxPegGap: 0.01,
  maxMarkoutToFee: 0.6,
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
