// v4 pool keys from the PoolManager's Initialize events (lib/discover.mjs keysFromInitialize, initWindow), for
// listed pools the PositionManager can't resolve (a pool initialised straight on the PoolManager). Made-up keys,
// blocks and nodes only (MOCKUP · MADE-UP NUMBERS). Planted faults: a log whose key doesn't hash to its id, a log
// from another contract, a node that ignores the id filter, an unread range, an empty answer no second node
// confirms and a spent budget all leave the pool missing (null), never a guessed key and never "no pool".
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, v4PoolId, ETHEREUM, BASE } from '../lib/pools.mjs';
import { CHAINS } from '../lib/chains.mjs';
import { keysFromInitialize, initWindow } from '../lib/discover.mjs';
import { makeBudget } from '../lib/budget.mjs';

const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const hex = (n) => '0x' + n.toString(16);
const PM = '0x' + 'ab'.repeat(20), OTHER = '0x' + 'cd'.repeat(20);
const KEY_A = { currency0: '0x' + '11'.repeat(20), currency1: '0x' + '22'.repeat(20), fee: 3000, tickSpacing: 60, hooks: '0x' + '33'.repeat(20) };
const KEY_B = { currency0: '0x0000000000000000000000000000000000000000', currency1: '0x' + '44'.repeat(20), fee: 0x800000, tickSpacing: 1, hooks: '0x' + '55'.repeat(20) };
const ID_A = v4PoolId(KEY_A), ID_B = v4PoolId(KEY_B), ID_C = v4PoolId({ ...KEY_A, fee: 500, tickSpacing: 10 });

// an Initialize log as a node returns it; `as` lets a planted fault claim another id with this key
const initLog = (key, block, { as = null, address = PM } = {}) => ({
  address, blockNumber: hex(block), transactionHash: '0x' + w(block), logIndex: '0x0',
  topics: [TOPICS.initialize, as ?? v4PoolId(key), '0x' + w(key.currency0), '0x' + w(key.currency1)],
  data: '0x' + w(key.fee) + w(key.tickSpacing) + w(key.hooks) + w(1n << 96n) + w(0),
});

// Two fake nodes serving eth_getLogs by address, topic0, topic1 (one id or a list) and range.
// refuse(a, b, url): that node doesn't answer the chunk; extra(a, b, url): logs it adds to the answer.
function fakeNodes(logs, { refuse = () => false, extra = () => [], ignoreIds = false } = {}) {
  const asked = [];
  const answer = (url, f) => {
    const a = parseInt(f.fromBlock, 16), b = parseInt(f.toBlock, 16);
    if (refuse(a, b, url)) return null;
    const t1 = f.topics[1], ids = ignoreIds || t1 == null ? null : Array.isArray(t1) ? t1 : [t1];
    const hit = logs.filter((l) => l.address === f.address && l.topics[0] === f.topics[0] && (!ids || ids.includes(l.topics[1])) && parseInt(l.blockNumber, 16) >= a && parseInt(l.blockNumber, 16) <= b);
    return [...hit, ...extra(a, b, url)];
  };
  const node = {
    asked,
    async callWho(method, params, exclude = []) {
      assert.equal(method, 'eth_getLogs');
      for (const u of ['n1', 'n2']) {
        if (exclude.includes(u)) continue;
        const f = params[0];
        asked.push({ url: u, a: parseInt(f.fromBlock, 16), b: parseInt(f.toBlock, 16), ids: f.topics[1] });
        const r = answer(u, f);
        if (r) return { result: r, url: u };
      }
      return { result: null, url: null };
    },
    async call(method, params) { return (await node.callWho(method, params)).result; },
  };
  return node;
}
const opts = (o = {}) => ({ poolManager: PM, from: 1000, to: 100_000, step: 9000, waitMs: 0, ...o });

test('the deployment blocks and chunk sizes the search uses (public contract facts; 9k blocks on Ethereum, 10k on Base)', () => {
  assert.equal(ETHEREUM.v4PoolManagerBlock, 21688329);
  assert.equal(BASE.v4PoolManagerBlock, 25350988);
  assert.ok(ETHEREUM.v4PoolManagerBlock < 21688545, 'before the first ETH/USDC v4 Initialize event (test/pools.test.mjs)');
  assert.equal(CHAINS.ethereum.logMax, 9000);
  assert.equal(CHAINS.base.logMax, 10000);
  assert.ok(CHAINS.ethereum.caps.v4keys.ms > 0 && CHAINS.ethereum.caps.v4keys.calls > 0);
  assert.ok(CHAINS.base.caps.keys.ms > 0 && CHAINS.base.caps.keys.calls > 0);
});

test('a key read from its Initialize event hashes back to the id; the window is read first and the sweep goes back from the head', async () => {
  const node = fakeNodes([initLog(KEY_A, 5000), initLog(KEY_B, 95_500)]);
  const r = await keysFromInitialize(node, opts({ ids: [ID_A.toUpperCase().replace('0X', '0x'), ID_B], windows: new Map([[ID_A, [4000, 6000]]]) }));
  const a = r.keys.get(ID_A), b = r.keys.get(ID_B);
  assert.deepEqual({ ...a, block: undefined, time: undefined }, { ...KEY_A, block: undefined, time: undefined });
  assert.equal(a.block, 5000);
  assert.equal(v4PoolId(a), ID_A, 'keccak256(abi.encode(key)) = the pool id');
  assert.equal(v4PoolId(b), ID_B);
  assert.equal(b.fee, 0x800000, 'a dynamic-fee hooked pool keeps its key exactly');
  assert.equal(r.rejected, 0);
  // the window [4000, 6000] was the first chunk asked, for every id still wanted
  assert.deepEqual([node.asked[0].a, node.asked[0].b], [4000, 6000]);
  assert.ok(node.asked[0].ids.includes(ID_B));
  // the sweep started at the head and stopped once nothing was wanted: B sits in the first chunk back
  const sweep = node.asked.slice(1);
  assert.equal(sweep[0].b, 100_000);
  assert.ok(sweep.every((q) => q.b >= 100_000 - 9000 * 6), `the sweep stopped early (${sweep.length} chunks)`);
  assert.ok(node.asked.length <= 1 + 2 * 6, `${node.asked.length} calls`);
});

test('planted fault: a log whose key does not hash to the id is rejected and the pool stays missing (null), never a guessed key', async () => {
  const forged = initLog({ ...KEY_A, fee: 500 }, 50_000, { as: ID_A }); // claims ID_A with another key
  const r = await keysFromInitialize(fakeNodes([forged]), opts({ ids: [ID_A] }));
  assert.equal(r.keys.get(ID_A), null, 'not invented, and not "no pool" either: that chunk is unread');
  assert.equal(r.rejected, 1);
  assert.equal(r.swept, false);
  // the old shortcut (taking the event's fields as the key) would have produced a key for this id
  assert.notEqual(v4PoolId({ ...KEY_A, fee: 500 }), ID_A);
  // the real event elsewhere in the range still counts; the forged chunk is counted as rejected
  const r2 = await keysFromInitialize(fakeNodes([forged, initLog(KEY_A, 20_000)]), opts({ ids: [ID_A] }));
  assert.equal(v4PoolId(r2.keys.get(ID_A)), ID_A);
  assert.equal(r2.keys.get(ID_A).block, 20_000);
  assert.equal(r2.rejected, 1);
});

test('planted faults: a log from another contract, outside the asked range, or a node ignoring the id filter is rejected', async () => {
  const r = await keysFromInitialize(fakeNodes([initLog(KEY_A, 30_000, { address: OTHER })], { extra: (a, b) => (a <= 30_000 && b >= 30_000 ? [initLog(KEY_A, 30_000, { address: OTHER })] : []) }), opts({ ids: [ID_A] }));
  assert.equal(r.keys.get(ID_A), null);
  assert.ok(r.rejected >= 1);
  const out = await keysFromInitialize(fakeNodes([], { extra: (a) => (a === 91_001 ? [initLog(KEY_A, 5)] : []) }), opts({ ids: [ID_A] }));
  assert.equal(out.keys.get(ID_A), null, 'a log outside its chunk is not taken');
  assert.equal(out.rejected, 1);
  // a node that ignores topic1 answers other pools' events too: the answer is rejected, the wanted key still checked
  const noisy = await keysFromInitialize(fakeNodes([initLog(KEY_B, 60_000)], { ignoreIds: true }), opts({ ids: [ID_A] }));
  assert.equal(noisy.keys.get(ID_A), null);
  assert.equal(noisy.rejected, 1);
});

test('an unread range leaves the pool missing (null); only a fully read range says "no Initialize event" (false)', async () => {
  // the event's chunk is never answered: null, never false
  const r = await keysFromInitialize(fakeNodes([initLog(KEY_A, 50_000)], { refuse: (a, b) => a <= 50_000 && b >= 50_000 }), opts({ ids: [ID_A], retries: 1 }));
  assert.equal(r.keys.get(ID_A), null);
  assert.equal(r.swept, false);
  // no event at all, every chunk read: false
  const none = await keysFromInitialize(fakeNodes([]), opts({ ids: [ID_C] }));
  assert.equal(none.keys.get(ID_C), false);
  assert.equal(none.swept, true);
  // no event, one chunk unread: null
  const gap = await keysFromInitialize(fakeNodes([], { refuse: (a) => a === 55_001 }), opts({ ids: [ID_C] }));
  assert.equal(gap.keys.get(ID_C), null);
  // a window only (Base: no sweep back to the deployment) that holds no event: null, not false
  const win = await keysFromInitialize(fakeNodes([initLog(KEY_A, 5000)]), opts({ ids: [ID_A], windows: new Map([[ID_A, [40_000, 45_000]]]), sweep: false }));
  assert.equal(win.keys.get(ID_A), null);
});

test('confirmEmpty: an empty answer counts only once a second node confirms it; a second node that finds the event wins', async () => {
  // n2 is down: every empty chunk is unconfirmed, so a pool with no event stays null (unread), not false
  const lone = await keysFromInitialize(fakeNodes([], { refuse: (a, b, u) => u === 'n2' }), opts({ ids: [ID_C], confirmEmpty: true, retries: 0 }));
  assert.equal(lone.keys.get(ID_C), null);
  // ... but the chunk that holds the event needs no confirmation
  const one = await keysFromInitialize(fakeNodes([initLog(KEY_A, 97_000)], { refuse: (a, b, u) => u === 'n2' }), opts({ ids: [ID_A], confirmEmpty: true }));
  assert.equal(v4PoolId(one.keys.get(ID_A)), ID_A);
  // n1 answers [] for ranges it doesn't hold; n2 has the event
  const both = fakeNodes([initLog(KEY_A, 70_000)]);
  const liar = { async callWho(m, p, ex = []) { return ex.includes('n1') ? both.callWho(m, p, ex) : { result: [], url: 'n1' }; } };
  const fixed = await keysFromInitialize(liar, opts({ ids: [ID_A], confirmEmpty: true }));
  assert.equal(fixed.keys.get(ID_A).block, 70_000);
  const fooled = await keysFromInitialize({ call: (m, p) => liar.callWho(m, p).then((x) => x.result) }, opts({ ids: [ID_A], confirmEmpty: false }));
  assert.equal(fooled.keys.get(ID_A), false, 'without the confirmation a lying node reads as "no event": why Ethereum confirms');
});

test('a spent budget stops the search at once: what it did not read is null, and it never runs past its calls', async () => {
  const node = fakeNodes([initLog(KEY_A, 2000)]);
  const budget = makeBudget({ calls: 5 });
  const r = await keysFromInitialize(node, opts({ ids: [ID_A], budget, confirmEmpty: true, concurrency: 3 }));
  assert.equal(r.keys.get(ID_A), null);
  assert.ok(node.asked.length <= 5, `${node.asked.length} calls`);
  assert.equal(budget.why(), 'calls');
  // a time cap already spent: nothing is asked
  const t = makeBudget({ ms: 0 });
  const quiet = fakeNodes([initLog(KEY_A, 2000)]);
  assert.equal((await keysFromInitialize(quiet, opts({ ids: [ID_A], budget: t }))).keys.get(ID_A), null);
  assert.equal(quiet.asked.length, 0);
});

test('initWindow: the aggregator\'s creation time → a block range that holds the event, chain clock and missed slots included', () => {
  const head = 26_000_000, nowSec = 1_800_000_000;
  // Ethereum's estimate (12 s a slot) runs early: 1% of slots missed puts the real block above it
  const real = (t) => head - Math.round(((nowSec - t) / 12) * 0.99);
  const est = (t) => head - (nowSec - t) / 12;
  const created = nowSec - 200 * 86400;
  const w = initWindow(created * 1000, { head, blockAt: est, back: 86400, ahead: 3600, slack: 0.015 });
  assert.ok(w[0] <= real(created) && real(created) <= w[1], `${w} holds ${real(created)}`);
  assert.ok(real(created - 3600) >= w[0], 'an event an hour before the listed time is inside too');
  const narrow = initWindow(created * 1000, { head, blockAt: est, back: 86400, ahead: 3600 });
  assert.ok(real(created) > narrow[1], 'planted fault: without the slack the 12 s clock misses the block');
  assert.ok(w[1] - w[0] < 30 * 9000, `${Math.ceil((w[1] - w[0]) / 9000)} chunks, not the whole history`);
  // the top never passes the head; no usable time → no window
  assert.equal(initWindow((nowSec + 7200) * 1000, { head, blockAt: est })[1], head);
  assert.equal(initWindow(null, { head, blockAt: est }), null);
  assert.equal(initWindow(1000, { head, blockAt: est }), null, 'seconds mistaken for ms are refused');
});
