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

// Two made-up endpoints: "quiet" answers [] with no error for half the ranges, "good" answers all.
function twoNodes({ goodDown = false } = {}) {
  const logs = Array.from({ length: 900 }, (_, i) => ({ blockNumber: '0x' + (1000 + 11 * i).toString(16), logIndex: '0x0', transactionHash: '0x' + i }));
  const serve = (url, [{ fromBlock, toBlock }]) => {
    const a = parseInt(fromBlock, 16), b = parseInt(toBlock, 16);
    if (url === 'quiet' && Math.floor(a / 1000) % 2 === 0) return [];
    if (url === 'good' && goodDown) return null;
    return logs.filter((l) => { const n = parseInt(l.blockNumber, 16); return n >= a && n <= b; }).concat(url === 'quiet' ? [{ blockNumber: '0x1', logIndex: '0x0', transactionHash: '0xstray' }] : []);
  };
  const order = ['quiet', 'good'];
  return {
    total: logs.length,
    async call(m, p) { for (const u of order) { const r = serve(u, p); if (r) return r; } return null; },
    async callWho(m, p, exclude = []) { for (const u of order) { if (exclude.includes(u)) continue; const r = serve(u, p); if (r) return { result: r, url: u }; } return { result: null, url: null }; },
  };
}

test('log reader: an empty answer counts only when a second endpoint confirms it; strays outside the range are dropped', async () => {
  const n = twoNodes(), stats = {};
  const r = await logsAdaptive(n, {}, 1000, 11000, { step: 1000, maxStep: 1000, confirmEmpty: true, stats });
  assert.equal(r.length, n.total);
  assert.ok(stats.emptyWrong > 0);
  assert.ok(r.every((l) => l.transactionHash !== '0xstray'));
  // planted fault: the old reader takes the quiet node's [] as "no events"
  const old = await logsAdaptive(twoNodes(), {}, 1000, 11000, { step: 1000, maxStep: 1000 });
  assert.ok(old.length < n.total);
  // nobody else to confirm: unread, never "no events"
  assert.equal(await logsAdaptive(twoNodes({ goodDown: true }), {}, 1000, 11000, { step: 1000, maxStep: 1000, minStep: 500, confirmEmpty: true }), null);
});
