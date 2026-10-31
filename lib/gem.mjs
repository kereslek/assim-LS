// Gem score v2 (0-100): Stranded 25 + Yield 35 + Persistence 25 + Flow 15, minus 10 per warning.
// A failed check blocks the pool; a missing input leaves the score blank (null), never zero.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Persistence 0-1: half from how many of the last 30 days the pool stayed stranded, a quarter from
// how far the stranded liquidity sits in volatility terms (2 sigma-weeks or more counts in full),
// a quarter from the share of it held by inactive wallets rather than rebalancing vaults.
export function persistenceScore({ strandedDays30, wallSigma, inactiveShare }) {
  if (![strandedDays30, wallSigma, inactiveShare].every(isNum)) return null;
  return 0.5 * clamp(strandedDays30 / 30) + 0.25 * clamp(wallSigma / 2) + 0.25 * clamp(inactiveShare);
}

// Flow 0-1: 70% from low toxicity (markout well under the fee), 30% from breadth (about 100
// distinct traders a week counts in full).
export function flowScore({ markoutToFee, traders7d }) {
  if (![markoutToFee, traders7d].every(isNum)) return null;
  return 0.7 * clamp(1 - markoutToFee) + 0.3 * clamp(Math.log10(Math.max(1, traders7d)) / 2);
}

export function gemScore({ stranded, net, persistence, flow, warnings = [], fails = [] }) {
  if (fails.length) return { total: null, blocked: true, reasons: fails, parts: null, missing: [] };
  const missing = Object.entries({ stranded, net, persistence, flow }).filter(([, v]) => !isNum(v)).map(([k]) => k);
  if (missing.length) return { total: null, blocked: false, reasons: warnings, parts: null, missing };
  const parts = {
    stranded: Math.round(25 * clamp((stranded - 0.8) / 0.15)),
    yield: Math.round(35 * clamp(net / 0.5)),
    persistence: Math.round(25 * clamp(persistence)),
    flow: Math.round(15 * clamp(flow)),
  };
  const total = Math.max(0, parts.stranded + parts.yield + parts.persistence + parts.flow - 10 * warnings.length);
  return { total, blocked: false, reasons: warnings, parts, missing };
}
