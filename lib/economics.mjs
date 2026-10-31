// LP economics at a given ticket: LVR, re-range costs, dilution-aware fee APR, net APR.
// sigma = daily log volatility of the pair's own price; r = range half-width in log terms.
// Every function returns null when an input is missing: missing is never zero.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Concentration of a ±r range versus full range.
export const concentration = (r) => 1 / (1 - Math.exp(-r / 2));

// LVR per year while in range (textbook form; cautious for high fee tiers and fast chains).
export const lvrApr = (sigma, r) => (isNum(sigma) && isNum(r) && r > 0 ? ((365 * sigma * sigma) / 8) * concentration(r) : null);

// Expected re-ranges per year when the position is re-centred on every exit (driftless price).
export const rerangesPerYear = (sigma, r) => (isNum(sigma) && isNum(r) && r > 0 ? (365 * sigma * sigma) / (r * r) : null);

// Range half-width so that a re-range is expected about every minDays, rounded to whole percent.
export const suggestRange = (sigma, minDays) =>
  isNum(sigma) && sigma > 0 ? Math.max(0.01, Math.round(sigma * Math.sqrt(minDays) * 100) / 100) : null;

// Swap cost of one re-centre, as a share of the position: half the position swapped at the best
// route, paying at most a 0.3% pool fee plus about 0.05% price impact.
export const swapCostPerRerange = (feeTier) => (isNum(feeTier) ? 0.5 * (Math.min(feeTier, 0.003) + 0.0005) : null);

// Fee APR at your ticket. feesPerDay = LP fees the pool pays per day to liquidity in your range;
// bandValue = value already in that range. You earn feesPerDay * ticket / (bandValue + ticket).
export function feeAprAtTicket({ feesPerDay, bandValue, ticket }) {
  if (![feesPerDay, bandValue, ticket].every(isNum) || ticket <= 0) return null;
  return (365 * feesPerDay) / (bandValue + ticket);
}

// An empty gap: almost nothing at the price and almost no fees. Its value is the flow you would
// attract, which needs a capture estimate (pair volume elsewhere) and a small live test.
export const isEmptyGap = ({ bandValue, feesPerDay, ticket }) =>
  isNum(bandValue) && isNum(feesPerDay) && isNum(ticket) && bandValue < ticket / 10 && feesPerDay * 365 < 0.05 * ticket;

export function netApr({ feeApr, sigma, r, swapCost, gasUsd, ticket }) {
  if (![feeApr, sigma, r, swapCost, gasUsd, ticket].every(isNum) || ticket <= 0) return null;
  const lvr = lvrApr(sigma, r), n = rerangesPerYear(sigma, r);
  if (lvr == null || n == null) return null;
  const swaps = n * swapCost, gas = (n * gasUsd) / ticket;
  return { feeApr, lvr, swaps, gas, net: feeApr - lvr - swaps - gas, edge: feeApr / lvr, rerangeDays: 365 / n };
}
