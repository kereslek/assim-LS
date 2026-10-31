import test from 'node:test';
import assert from 'node:assert/strict';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';

// A fake node over made-up logs (one every 7 blocks), with the failure modes seen on real nodes.
function fakeNode({ refuseOver = Infinity, cutAt = Infinity, dead = false } = {}) {
  const logs = Array.from({ length: 3000 }, (_, i) => ({ blockNumber: '0x' + (1000 + 7 * i).toString(16), logIndex: '0x0', transactionHash: '0x' + i }));
  const seen = { widest: 0, calls: 0 };
  return {
    seen,
    async call(method, [{ fromBlock, toBlock }]) {
      seen.calls++;
      if (dead) return null;
      const a = parseInt(fromBlock, 16), b = parseInt(toBlock, 16);
      seen.widest = Math.max(seen.widest, b - a + 1);
      if (b - a + 1 > refuseOver) return null; // "range too large"
      const r = logs.filter((l) => { const n = parseInt(l.blockNumber, 16); return n >= a && n <= b; });
      return r.slice(0, cutAt); // a node that cuts results short without an error
    },
    total: logs.length,
  };
}

test('log reader: refused ranges are halved and every log is read exactly once', async () => {
  const n = fakeNode({ refuseOver: 2000 });
  const r = await logsAdaptive(n, {}, 0, 30000, { step: 9000, maxStep: 9000, minStep: 100 });
  assert.equal(r.length, n.total);
  assert.equal(new Set(r.map((l) => l.transactionHash)).size, n.total);
});

test('log reader: chunks never exceed the cap, even after quiet answers', async () => {
  const n = fakeNode();
  await logsAdaptive(n, {}, 0, 30000, { step: 9000, maxStep: 9000 });
  assert.ok(n.seen.widest <= 9000, `widest ${n.seen.widest}`);
});

test('log reader: a full-looking answer is read again in halves, so a cut-off node loses nothing', async () => {
  const n = fakeNode({ cutAt: 100 });
  const r = await logsAdaptive(n, {}, 0, 30000, { step: 9000, maxStep: 9000, minStep: 50, maxLogs: 100 });
  assert.equal(r.length, n.total);
});

test('log reader: a node that never answers gives null, not "no events"', async () => {
  assert.equal(await logsAdaptive(fakeNode({ dead: true }), {}, 0, 30000, { step: 9000, minStep: 1000 }), null);
  assert.deepEqual(await logsAdaptive(fakeNode(), {}, 10, 5, {}), []);
});
