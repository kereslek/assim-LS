// Fee spikes: a day whose LP fees are far above the days around it. Such a day is shown only when other
// evidence backs it (that day's swaps or its traded volume); otherwise it is marked unconfirmed, never shown
// silently as real (docs/DATA.md history.json `u`).
//
// rates: each row's fees per day, from its fees over its own span (a row after a gap covers several days: its
// fees are an average over them, never one day's). The baseline is the median of the other rows' rates within
// 15 days either side (the 30-day median); a day at or above SPIKE.k times it is a spike. With fewer than
// SPIKE.minBase other rows read, or a zero median, a day is never a spike: there is no baseline to judge it by.
// Pure.
import { DAY } from './snapshots.mjs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const SPIKE = Object.freeze({
  k: 20, // a day at or above 20 times the 30-day median needs evidence
  half: 15 * DAY, // the median's window: 15 days either side
  minBase: 5, // rows needed around a day for a median
  minUsd: 10, // a day under $10 of fees is never a spike: noise next to a pool that barely trades
  // evidence: the day's fees from its own swaps (or its volume × the LP fee rate) at least this share of the
  // counters' figure. Under it, the counters' day is not backed by trading: unconfirmed.
  backed: 0.25,
});

const median = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// rows: [[t, fees|null]] ascending, fees from the row before to this one. Returns [{ i, t, span, rate }] for
// every row with a row before it (span ms; rate = fees per day, null when unread).
export function rowRates(rows) {
  const out = [];
  for (let i = 1; i < (rows || []).length; i++) {
    const t = rows[i][0], span = t - rows[i - 1][0], f = rows[i][1];
    out.push({ i, t, span, rate: isNum(f) && f >= 0 && span > 0 ? (f * DAY) / span : null });
  }
  return out;
}

// The spikes among rate rows: [{ i, t, span, rate, base, ratio }], base = the 30-day median of the others.
export function spikes(rates, { k = SPIKE.k, half = SPIKE.half, minBase = SPIKE.minBase, minUsd = SPIKE.minUsd } = {}) {
  const out = [];
  for (const r of rates || []) {
    if (!isNum(r.rate) || r.rate <= 0 || r.rate < minUsd) continue;
    const around = rates.filter((q) => q !== r && isNum(q.rate) && Math.abs(q.t - r.t) <= half).map((q) => q.rate);
    if (around.length < minBase) continue;
    const base = median(around);
    if (!(base > 0)) continue;
    const ratio = r.rate / base;
    if (ratio >= k) out.push({ ...r, base, ratio });
  }
  return out;
}

// Whether a spike is backed: evidence = the same interval's fees from another source (its swaps' fees, or the
// day's volume × the LP fee rate), in the same units as the counters' figure. true = backed, false = the
// evidence contradicts it, null = no evidence read (unconfirmed too: never shown as if checked).
export function backed(counters, evidence, { share = SPIKE.backed } = {}) {
  if (!isNum(counters) || !isNum(evidence) || evidence < 0) return null;
  if (counters <= 0) return true;
  return evidence >= counters * share;
}

// Volume evidence for the interval from a to b (ms): the LP fees its traded volume implies, Σ over the UTC days
// it overlaps of the day's volume × the share of that day inside the interval × rate (the LP fee rate). days =
// Map(UTC day ms → [volume USD|null, …]) (lib/feehist.mjs, GeckoTerminal's day candles). null when a day it
// needs has no volume read, or there is no rate: no evidence, never 0.
export function volumeEvidence(days, a, b, rate) {
  if (!days || !(isNum(rate) && rate > 0) || !(isNum(a) && isNum(b) && b > a)) return null;
  let sum = 0;
  for (let d = Math.floor(a / DAY) * DAY; d < b; d += DAY) {
    const part = (Math.min(b, d + DAY) - Math.max(a, d)) / DAY, v = days.get(d)?.[0];
    if (part <= 0) continue;
    if (!isNum(v) || v < 0) return null;
    sum += v * part;
  }
  return sum * rate;
}

// The rows to mark unconfirmed: the spikes (rows [[t, fees]] as rowRates) that the evidence does not back.
// evidenceOf(a, b) = the interval's fees from another source, or null. Returns [t] ascending.
export function unconfirmed(rows, evidenceOf, opts = {}) {
  const out = [];
  for (const s of spikes(rowRates(rows), opts)) {
    const ev = evidenceOf ? evidenceOf(rows[s.i - 1][0], s.t) : null;
    if (backed(rows[s.i][1], ev, opts) !== true) out.push(s.t);
  }
  return out;
}

// history.json's `u` for one pool: { d: [t], y: [t] } of the daily chart's rows and the fee history's exact days
// that are spikes no evidence backs, or null when there are none. d = history rows [t, price, fees, vol, parked];
// y = [t, fees, src] (only exact days are judged: an estimate is the volume itself); gt = the pool's
// GeckoTerminal cache entry ({ days }) or null; rate = the LP fee rate. Also { spikes, backedN } for the log.
export function feeSpikes({ d = [], y = [], gt = null, rate = null } = {}) {
  const days = gt && gt.days instanceof Map ? gt.days : null;
  const ev = (a, b) => volumeEvidence(days, a, b, rate);
  const dRows = d.map((r) => [r[0], r[2]]);
  const nD = spikes(rowRates(dRows)).length, uD = unconfirmed(dRows, ev);
  // y: each exact day's fees are that UTC day's (t to t + 1 day), whatever gaps lie between the days
  const ySp = spikes(y.filter((r) => r[2] === 'x').map((r) => ({ t: r[0], span: DAY, rate: isNum(r[1]) ? r[1] : null })));
  const uY = ySp.filter((s) => backed(s.rate, ev(s.t, s.t + DAY)) !== true).map((s) => s.t);
  const n = nD + ySp.length, u = uD.length + uY.length;
  return { u: u ? { d: uD, y: uY } : null, spikes: n, backedN: n - u };
}
