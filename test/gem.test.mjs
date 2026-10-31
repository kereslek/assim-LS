import test from 'node:test';
import assert from 'node:assert/strict';
import { gemScore, persistenceScore, flowScore } from '../lib/gem.mjs';
import { lensStranded, lensFreshPool, lensAfterMove, lensCalmPair, toxicFilter } from '../lib/lenses.mjs';

test('gem v2: the mockup VELNA case scores 83 = 25 + 31 + 17 + 10', () => {
  const g = gemScore({ stranded: 0.96, net: 0.446, persistence: 0.68, flow: 0.667 });
  assert.deepEqual(g.parts, { stranded: 25, yield: 31, persistence: 17, flow: 10 });
  assert.equal(g.total, 83);
});

test('gem v2: warnings cost 10, a failed check blocks, a missing input is blank not zero', () => {
  assert.equal(gemScore({ stranded: 0.96, net: 0.446, persistence: 0.68, flow: 0.667, warnings: ['young pool'] }).total, 73);
  const blocked = gemScore({ stranded: 0.96, net: 0.446, persistence: 0.68, flow: 0.667, fails: ['sell test failed'] });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.total, null);
  const missing = gemScore({ stranded: 0.96, net: null, persistence: 0.68, flow: 0.667 });
  assert.equal(missing.total, null);
  assert.deepEqual(missing.missing, ['net']);
  assert.equal(gemScore({ stranded: 0.5, net: -0.2, persistence: 0, flow: 0, warnings: ['a', 'b'] }).total, 0);
});

test('persistence and flow scores stay within 0..1 and need every input', () => {
  assert.equal(persistenceScore({ strandedDays30: 30, wallSigma: 5, inactiveShare: 1 }), 1);
  assert.equal(persistenceScore({ strandedDays30: 0, wallSigma: 0, inactiveShare: 0 }), 0);
  assert.equal(persistenceScore({ strandedDays30: 30, wallSigma: null, inactiveShare: 1 }), null);
  assert.equal(flowScore({ markoutToFee: 0, traders7d: 100 }), 1);
  assert.equal(flowScore({ markoutToFee: 2, traders7d: 1 }), 0);
  assert.equal(flowScore({ markoutToFee: undefined, traders7d: 10 }), null);
});

test('lenses: each one turns on for its own signal only', () => {
  assert.equal(lensStranded({ stranded30: 0.96 }).on, true);
  assert.equal(lensStranded({ stranded30: 0.6 }).on, false);
  assert.equal(lensStranded({ stranded30: null }), null);
  assert.equal(lensFreshPool({ poolAgeDays: 9, pairAgeDays: 400, volumeShare: 0.4, liquidityShare: 0.1 }).on, true);
  assert.equal(lensFreshPool({ poolAgeDays: 9, pairAgeDays: 40, volumeShare: 0.4, liquidityShare: 0.1 }).on, false); // pair too young
  assert.equal(lensFreshPool({ poolAgeDays: 9, pairAgeDays: 400, volumeShare: 0.4, liquidityShare: 0.3 }).on, false); // liquidity already there
  assert.equal(lensAfterMove({ move7dLog: 0.3, lastDayLog: 0.01, sigma: 0.04 }).on, true);
  assert.equal(lensAfterMove({ move7dLog: 0.3, lastDayLog: 0.08, sigma: 0.04 }).on, false); // still moving
  assert.equal(lensAfterMove({ move7dLog: 0.1, lastDayLog: 0.0, sigma: 0.04 }).on, false); // too small a move
  assert.equal(lensCalmPair({ sigma: 0.002, kind: 'staked-eth' }).on, true);
  assert.equal(lensCalmPair({ sigma: 0.002, kind: 'stable', pegGap: 0.03 }).on, false); // off its peg
  assert.equal(lensCalmPair({ sigma: 0.02, kind: 'stable' }).on, false);
  assert.equal(toxicFilter({ markoutToFee: 0.3 }).pass, true);
  assert.equal(toxicFilter({ markoutToFee: 0.9 }).pass, false);
  assert.equal(toxicFilter({ markoutToFee: null }), null);
});
