// Read budgets (lib/budget.mjs) and the readers that take one: each new part of a pass stops at its time or
// call cap and leaves what it did not read null ("not read"), never a zero and never a pass that runs over.
// Planted faults: readers that ignore the budget (the code before the caps) fail these tests, because the fakes
// below would make them call without end, or wait for answers that cannot come.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBudget, capRpc, capGetJson, isBudgetError, UNLIMITED } from '../lib/budget.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { eachSpaced, dexScreenerTokenPairs } from '../lib/aggregators.mjs';

const fakeClock = () => { let t = 0; const c = () => t; c.add = (ms) => { t += ms; }; return c; };

test('a budget says no once its time or its calls are spent, and says which', () => {
  const clock = fakeClock();
  const b = makeBudget({ ms: 1000, calls: 3, clock });
  assert.equal(b.take(), true); assert.equal(b.take(), true); assert.equal(b.take(), true);
  assert.equal(b.take(), false, 'the fourth call is refused');
  assert.equal(b.why(), 'calls'); assert.equal(b.used(), 3);
  const t = makeBudget({ ms: 1000, calls: 100, clock });
  assert.equal(t.take(), true);
  clock.add(1000);
  assert.equal(t.take(), false, 'past its time limit');
  assert.equal(t.why(), 'time');
  assert.match(t.note(), /time cap/);
  assert.equal(UNLIMITED.take(), true); assert.equal(UNLIMITED.over(), false);
  // a part that finished within its time reports no cap, however long after it the note is written
  const done = makeBudget({ ms: 1000, clock });
  done.take(); clock.add(5000);
  assert.equal(done.why(), null); assert.equal(done.note(), '0 s, 1 calls');
});

// a fake RPC that counts what reaches it
function countingRpc({ answer = () => '0x1', batchAnswer = (reqs) => reqs.map(() => '0x1') } = {}) {
  const seen = { calls: 0, batches: 0 };
  const callWho = async (method, params) => { seen.calls++; const r = answer(method, params); return { result: r, url: r == null ? null : 'fake' }; };
  return {
    seen,
    callWho,
    call: async (m, p) => (await callWho(m, p)).result,
    batch: async (reqs) => { seen.batches++; return batchAnswer(reqs); },
  };
}

test('a capped RPC stops calling the nodes once spent and answers null, as a node that did not answer', async () => {
  const raw = countingRpc();
  const b = makeBudget({ calls: 5 });
  const rpc = capRpc(raw, b);
  const got = [];
  for (let i = 0; i < 20; i++) got.push(await rpc.call('eth_blockNumber', []));
  assert.equal(raw.seen.calls, 5, 'five calls reached the nodes, not twenty');
  assert.deepEqual(got.slice(5), new Array(15).fill(null));
  // a batch spends one call per post and one per item the post left unanswered
  const raw2 = countingRpc({ batchAnswer: (reqs) => reqs.map((_, i) => (i % 2 ? null : '0x1')) });
  const b2 = makeBudget({ calls: 4 });
  const out = await capRpc(raw2, b2, { batchSize: 10 }).batch(Array.from({ length: 30 }, () => ({ method: 'eth_call', params: [] })));
  assert.equal(raw2.seen.batches, 1, 'one post');
  assert.equal(raw2.seen.calls, 3, 'then three one-by-one retries, and the budget is spent');
  assert.equal(out.filter((x) => x != null).length, 5 + 3, 'answered: half the first post and the three retries');
  assert.equal(out.slice(10).every((x) => x === null), true, 'the rest is unread (null), never a default');
  assert.equal(capRpc(raw, UNLIMITED), raw, 'no cap: the RPC itself (Ethereum keeps its behaviour)');
});

test('logsAdaptive stops at its call cap on a node that keeps refusing: null (unread), not thousands of calls', async () => {
  const raw = countingRpc({ answer: () => null }); // refuses everything (a Base node that serves no logs)
  const b = makeBudget({ calls: 12 });
  const t0 = Date.now();
  const r = await logsAdaptive(raw, { address: '0x' + '1'.repeat(40) }, 1, 432000, { step: 10000, maxStep: 10000, minStep: 25, segments: 4, retries: 2, waitMs: 50, budget: b });
  assert.equal(r, null, 'unread, never an empty list');
  assert.ok(raw.seen.calls <= 12, `${raw.seen.calls} calls`);
  assert.ok(Date.now() - t0 < 2000, 'no waiting once the budget is spent');
});

test('logsAdaptive stops at its time cap on a slow node: null, within the cap', async () => {
  let calls = 0;
  const slow = { call: async (m, [q]) => { calls++; await new Promise((r) => setTimeout(r, 40)); return []; } };
  const b = makeBudget({ ms: 200 });
  const t0 = Date.now();
  const r = await logsAdaptive(slow, { address: '0x' + '1'.repeat(40) }, 1, 10_000_000, { step: 1000, maxStep: 1000, budget: b });
  const took = Date.now() - t0;
  assert.equal(r, null, 'a read cut by the time cap is unread');
  assert.ok(took < 400, `stopped within the cap (${took} ms)`);
  assert.ok(calls < 10_000, 'far fewer calls than the whole range');
  // and with room enough, the same read completes (the cap is not a fault in itself)
  const ok = await logsAdaptive(slow, { address: '0x' + '1'.repeat(40) }, 1, 3000, { step: 1000, maxStep: 1000, budget: makeBudget({ ms: 5000 }) });
  assert.deepEqual(ok, []);
});

test('eachSpaced leaves the items past its cap null at once, without spacing them out', async () => {
  let n = 0;
  const b = makeBudget({ calls: 10 });
  const gj = capGetJson(async () => { n++; return []; }, b);
  const t0 = Date.now();
  const out = await eachSpaced(Array.from({ length: 100 }, (_, i) => i), 30, async (i) => { await gj('https://example.invalid'); return [i]; }, { budget: b });
  assert.equal(n, 10, 'ten fetched');
  assert.equal(out.length, 100);
  assert.deepEqual(out.slice(10), new Array(90).fill(null), 'the rest unread');
  assert.ok(Date.now() - t0 < 30 * 20, 'no spacing for the items not fetched');
});

test('a spent fetch budget is unread at once: no backoff waiting for an answer that cannot come', async () => {
  const b = makeBudget({ calls: 0 });
  const gj = capGetJson(async () => { throw new Error('should not be called'); }, b);
  await assert.rejects(gj('https://example.invalid'), (e) => isBudgetError(e));
  const t0 = Date.now();
  assert.equal(await dexScreenerTokenPairs(gj, 'base', '0x' + '2'.repeat(40)), null);
  assert.ok(Date.now() - t0 < 500, 'the retry loop does not wait 3 + 6 s for a spent budget');
});
