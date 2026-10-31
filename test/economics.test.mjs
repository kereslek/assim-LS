import test from 'node:test';
import assert from 'node:assert/strict';
import { concentration, lvrApr, rerangesPerYear, suggestRange, swapCostPerRerange, feeAprAtTicket, isEmptyGap, netApr } from '../lib/economics.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('LVR: full range is sigma^2/8 a day; a ±9% range is about 22.7x that', () => {
  assert.ok(near(concentration(60), 1, 1e-9));
  assert.ok(near(concentration(0.09), 22.73, 0.01));
  assert.ok(near(lvrApr(0.034, 60), (365 * 0.034 ** 2) / 8, 1e-9));
  assert.ok(near(lvrApr(0.034, 0.09), 1.199, 0.002)); // the mockup's VELNA: about 120% a year
  assert.equal(lvrApr(null, 0.09), null);
});

test('re-ranges: a ±9% range at 3.4% daily sigma exits about every 7 days', () => {
  assert.ok(near(365 / rerangesPerYear(0.034, 0.09), 7.0, 0.05));
  assert.equal(suggestRange(0.034, 7), 0.09);
  assert.equal(suggestRange(null, 7), null);
  assert.ok(near(swapCostPerRerange(0.003), 0.00175, 1e-12));
  assert.ok(near(swapCostPerRerange(0.01), 0.00175, 1e-12)); // a 1% pool re-centres through a cheaper route
  assert.ok(near(swapCostPerRerange(0.0005), 0.0005, 1e-12));
});

test('fee APR at your ticket: you share fees in proportion to your size', () => {
  assert.ok(near(feeAprAtTicket({ feesPerDay: 10, bandValue: 0, ticket: 1000 }), 3.65, 1e-12)); // an empty range: all fees are yours
  const big = feeAprAtTicket({ feesPerDay: 10, bandValue: 1e9, ticket: 1000 });
  assert.ok(near(big / ((365 * 10) / 1e9), 1, 2e-6)); // a large pool dilutes you to its in-range yield
  assert.ok(near(feeAprAtTicket({ feesPerDay: 552, bandValue: 116000, ticket: 1000 }), (365 * 552) / 117000, 1e-12));
  assert.equal(feeAprAtTicket({ feesPerDay: null, bandValue: 1, ticket: 1 }), null);
});

test('empty gap: almost nothing at the price and almost no fees', () => {
  assert.equal(isEmptyGap({ bandValue: 50, feesPerDay: 0, ticket: 1000 }), true);
  assert.equal(isEmptyGap({ bandValue: 116000, feesPerDay: 552, ticket: 1000 }), false);
  assert.equal(isEmptyGap({ bandValue: 50, feesPerDay: 40, ticket: 1000 }), false);
});

test('net APR: the mockup VELNA case adds up', () => {
  const lvr = lvrApr(0.034, 0.09);
  const n = netApr({ feeApr: 1.45 * lvr, sigma: 0.034, r: 0.09, swapCost: 0.00175, gasUsd: 0.07, ticket: 1000 });
  assert.ok(near(n.feeApr - n.lvr - n.swaps - n.gas, n.net, 1e-12));
  assert.ok(near(n.net, 0.446, 0.003));
  assert.ok(near(n.edge, 1.45, 1e-9));
  assert.ok(near(n.rerangeDays, 7.0, 0.05));
  assert.equal(netApr({ feeApr: 1, sigma: 0.03, r: 0.09, swapCost: 0.00175, gasUsd: 1, ticket: 0 }), null);
});
