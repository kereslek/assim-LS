// Per-pool checklist items, each with a planted fault it must catch. Made-up values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { creationCheck, feesVsAggregator, tokenAgeRank } from '../lib/checks.mjs';

test('creation event: found passes; missing from a complete record fails; from a partial one is unread', () => {
  assert.equal(creationCheck({ createdAt: 1.7e9, complete: false }), true);
  assert.equal(creationCheck({ createdAt: null, complete: true }), false); // planted: the event list lost the pool
  assert.equal(creationCheck({ createdAt: null, complete: false }), null);
  assert.equal(creationCheck({ createdAt: undefined }), null);
});

test('fees vs aggregator: within 10% passes; a protocol cut left out, or a wrong tier, is caught', () => {
  assert.equal(feesVsAggregator({ feesUsd: 3000, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, true);
  assert.equal(feesVsAggregator({ feesUsd: 3000 * 0.75, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, false); // LP share only (1/4 to the protocol)
  assert.equal(feesVsAggregator({ feesUsd: 3000, aggVolumeUsd: 1e6, feeTier: 0.0005 }).ok, false);
  assert.equal(feesVsAggregator({ feesUsd: null, aggVolumeUsd: 1e6, feeTier: 0.003 }).ok, null);
  assert.equal(feesVsAggregator({ feesUsd: 10, aggVolumeUsd: 0, feeTier: 0.003 }).ok, null); // no aggregator figure: unread, not a pass
});

test('token age and rank: a ranked token older than the minimum passes; unranked, too young or unknown do not', () => {
  const now = 2e9, old = now - 400 * 86400, young = now - 20 * 86400;
  const q = { quote: true };
  assert.equal(tokenAgeRank([{ rank: 500, firstPoolAt: old }, q], { now, minDays: 180 }), true);
  assert.equal(tokenAgeRank([{ rank: null, firstPoolAt: old }, q], { now, minDays: 180 }), false); // planted: no rank
  assert.equal(tokenAgeRank([{ rank: 500, firstPoolAt: young }, q], { now, minDays: 180 }), false); // planted: a fresh token
  assert.equal(tokenAgeRank([{ rank: 500, firstPoolAt: null }, q], { now, minDays: 180 }), null);
  assert.equal(tokenAgeRank([q, q], { now, minDays: 180 }), true);
});

test('LP book (v4 events): positions at the price add up to the pool liquidity; a lost event or one big LP is caught', async () => {
  const { lpBook } = await import('../lib/checks.mjs');
  const ev = (sender, lo, hi, d, salt = '0') => ({ sender, tickLower: lo, tickUpper: hi, liquidityDelta: BigInt(d), salt });
  const events = [ev('a', -100, 100, 500), ev('b', -50, 60, 300), ev('a', -100, 100, -100), ev('c', 200, 400, 900), ev('d', -10, 10, 250, '7')];
  const r = lpBook(events, { tick: 5, activeL: 950n });
  assert.deepEqual([r.ok, r.lpsAtPrice, r.concentrated], [true, 3, false]);
  assert.equal(lpBook(events.slice(1), { tick: 5, activeL: 950n }).ok, false); // planted: a lost add
  const whale = lpBook([...events, ev('w', -20, 20, 5000)], { tick: 5, activeL: 5950n });
  assert.deepEqual([whale.ok, whale.concentrated], [true, true]); // planted: one LP over 60%
  assert.equal(lpBook(null, { tick: 5, activeL: 1n }), null); // unread history: null, never a pass
});
