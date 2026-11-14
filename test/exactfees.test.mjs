// Exact fees (lib/exactfees.mjs) on made-up swaps (MOCKUP · MADE-UP NUMBERS): each pool's UTC day summed from its
// own swap events, v3 and v4 sign conventions, the protocol's share read (and followed through the day's changes),
// v4's dynamic fee from each event, PancakeSwap's own protocol part, a day counted only when every chunk and both
// ends were read, a held day never read again, the day's first block found exactly, the swaps over the counters over
// the estimates in history.json y, and a spike the swaps back never unconfirmed. Each safeguard has a planted fault
// it must catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SWAP_TOPICS, EXTRA_TOPICS } from '../lib/swaps.mjs';
import { logsAdaptive } from '../lib/logs-adaptive.mjs';
import { makeBudget } from '../lib/budget.mjs';
import { feeYear } from '../lib/feehist.mjs';
import { feeSpikes, swapEvidence } from '../lib/spikes.mjs';
import { EXACT, SETTING_TOPICS, decodeSetting, filterOf, eventsByPool, dayFees, readStates, firstBlockAt, emptyCache, packSx, unpackSx, planDays, exactFeesChain, exactLine } from '../lib/exactfees.mjs';

const DAY = 86400e3;
const W = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const Q96 = 1n << 96n; // sqrtPriceX96 of price 1 (token1 raw per token0 raw)
const A = (c) => '0x' + c.repeat(40);
const PM = '0x000000000004444c5dc75cb358380d2e3de08a90';
const V4ID = '0x' + 'c4'.repeat(32);
const ADDR = '0x' + W(7);
let li = 0;
const at = (block) => ({ blockNumber: '0x' + block.toString(16), logIndex: '0x' + (li++).toString(16), transactionHash: '0x' + (li * 7919).toString(16).padStart(64, '0') });
// v3 (and PancakeSwap v3): the pool's own side, positive = paid into the pool
const v3swap = (pool, { a0, a1, block, pcs = null }) => ({ address: pool, topics: [pcs ? SWAP_TOPICS.pcs3 : SWAP_TOPICS.v3, ADDR, ADDR], data: '0x' + W(a0) + W(a1) + W(Q96) + W(10n ** 20n) + W(0) + (pcs ? W(pcs[0]) + W(pcs[1]) : ''), ...at(block) });
// v4: the trader's side, negative = paid in by the trader; the event carries the swap's whole fee
const v4swap = ({ a0, a1, fee, block, id = V4ID }) => ({ address: PM, topics: [SWAP_TOPICS.v4, id, ADDR], data: '0x' + W(a0) + W(a1) + W(Q96) + W(10n ** 20n) + W(0) + W(fee), ...at(block) });
const v3set = (pool, [o0, o1, n0, n1], block) => ({ address: pool, topics: [SETTING_TOPICS.v3], data: '0x' + W(o0) + W(o1) + W(n0) + W(n1), ...at(block) });
const v4set = (pf, block, id = V4ID) => ({ address: PM, topics: [SETTING_TOPICS.v4, id], data: '0x' + W(pf), ...at(block) });
const flash = (pool, [p0, p1], block) => ({ address: pool, topics: [EXTRA_TOPICS.flash, ADDR, ADDR], data: '0x' + W(0) + W(0) + W(p0) + W(p1), ...at(block) });
const donate = ([a0, a1], block, id = V4ID) => ({ address: PM, topics: [EXTRA_TOPICS.donate, id, ADDR], data: '0x' + W(a0) + W(a1), ...at(block) });
const E18 = 10n ** 18n;
const st = (setting, sqrt = Q96) => ({ setting, sqrtPriceX96: sqrt });

test('the setting topics are the published event signatures; the log filters carry them beside the swaps', () => {
  assert.equal(SETTING_TOPICS.v3, '0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133'); // SetFeeProtocol(uint8,uint8,uint8,uint8), as Etherscan shows it
  assert.equal(SETTING_TOPICS.v4, '0xe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9'); // ProtocolFeeUpdated(PoolId indexed, uint24)
  const f3 = filterOf(3, [A('a')], PM), f4 = filterOf(4, [V4ID], PM);
  assert.deepEqual(f3.address, [A('a')]);
  assert.ok([SWAP_TOPICS.v3, SWAP_TOPICS.pcs3, EXTRA_TOPICS.flash, SETTING_TOPICS.v3, SETTING_TOPICS.pcs3].every((t) => f3.topics[0].includes(t)));
  assert.equal(f4.address, PM);
  assert.ok([SWAP_TOPICS.v4, EXTRA_TOPICS.donate, SETTING_TOPICS.v4].every((t) => f4.topics[0].includes(t)) && f4.topics[1][0] === V4ID);
  assert.deepEqual(decodeSetting(v3set(A('a'), [0, 0, 4, 5], 9)), { kind: 'setting', v: 3, dex: 'uniswap', pool: A('a'), old: 0, value: 4 + 5 * 16, block: 9, logIndex: li - 1 });
  assert.equal(decodeSetting(v4set(100 | (200 << 12), 9)).value, 100 | (200 << 12));
});

test('v3: positive amount = paid into the pool; the protocol keeps 1/N per input token, read, never assumed (planted fault: the full tier)', () => {
  const P = A('a'), pool = { id: P, v: 3, dex: 'uniswap', fee: 3000 };
  const evs = eventsByPool([v3swap(P, { a0: E18, a1: -2n * E18, block: 10 }), v3swap(P, { a0: -E18, a1: 2n * E18, block: 11 })]).get(P);
  assert.deepEqual(evs.map((e) => e.in), [0, 1], 'token0 in, then token1 in');
  const r = dayFees(pool, evs, { start: st(0x44), end: st(0x44) });
  const lp0 = (E18 * 3000n) / 1000000n, lp1 = (2n * E18 * 3000n) / 1000000n;
  assert.equal(r.kind, 'day');
  assert.equal(r.q, Number(((lp0 - lp0 / 4n) + (lp1 - lp1 / 4n)).toString()), 'a quarter of each side to the protocol, at price 1');
  assert.equal(r.px, 1);
  assert.equal(r.swaps, 2);
  const sides = dayFees(pool, evs, { start: st(0x40), end: st(0x40) }); // only token1's side pays the protocol (1/4)
  assert.equal(sides.q, Number((lp0 + lp1 - lp1 / 4n).toString()), 'each input token its own nibble');
  // planted fault: the full tier assumed (no protocol cut) → a third more than the LPs keep, caught
  const assumed = dayFees(pool, evs, { start: st(0), end: st(0) });
  assert.ok(assumed.q / r.q > 1.3, `${assumed.q} vs ${r.q}`);
  // planted fault: v4's sign read on a v3 pool (negative = paid in) → the other side's amounts, caught
  const flipped = eventsByPool([{ ...v3swap(P, { a0: -E18, a1: 2n * E18, block: 12 }) }]).get(P);
  assert.equal(flipped[0].in, 1, 'positive token1 = token1 paid in, never token0');
});

test('v4: negative amount = paid in by the trader; each swap\'s own (dynamic) fee; the protocol\'s 12 bits per direction (planted faults caught)', () => {
  const pool = { id: V4ID, v: 4, dex: 'uniswap', fee: 0x800000 };
  const pf = 100 | (250 << 12); // 0.01% on token0-in swaps, 0.025% on token1-in swaps
  const logs = [v4swap({ a0: -E18, a1: 3n * E18, fee: 3000, block: 20 }), v4swap({ a0: 5n * E18, a1: -2n * E18, fee: 9000, block: 21 })];
  const evs = eventsByPool(logs).get(V4ID);
  assert.deepEqual(evs.map((e) => [e.in, e.fee]), [[0, 3000], [1, 9000]], 'negative token0 = token0 paid in; the fee as each event says');
  const r = dayFees(pool, evs, { start: st(pf), end: st(pf) });
  const lp0 = (E18 * 3000n) / 1000000n - (E18 * 100n) / 1000000n, lp1 = (2n * E18 * 9000n) / 1000000n - (2n * E18 * 250n) / 1000000n;
  assert.equal(r.q, Number((lp0 + lp1).toString()));
  // planted fault: today's lpFee (3000) for every swap instead of the event's own → the dynamic day mis-stated, caught
  const flat = dayFees(pool, evs.map((e) => ({ ...e, fee: 3000 })), { start: st(pf), end: st(pf) });
  assert.notEqual(flat.q, r.q);
  // planted fault: the protocol's direction bits swapped → caught
  const swapped = dayFees(pool, evs, { start: st((pf >> 12) | ((pf & 0xfff) << 12)), end: st((pf >> 12) | ((pf & 0xfff) << 12)) });
  assert.notEqual(swapped.q, r.q);
  // donations go to the LPs whole
  const withGift = dayFees(pool, eventsByPool([...logs, donate([E18, 0n], 22)]).get(V4ID), { start: st(pf), end: st(pf) });
  assert.equal(withGift.q, r.q + 1e18);
});

test('PancakeSwap v3: LPs keep the fee less the protocol part each Swap event carries; flash fees less the protocol\'s share', () => {
  const P = A('d'), pool = { id: P, v: 3, dex: 'pancakeswap', fee: 2500 };
  const total = (4n * E18 * 2500n) / 1000000n, prot = (total * 3300n) / 10000n;
  const evs = eventsByPool([v3swap(P, { a0: 4n * E18, a1: -E18, block: 30, pcs: [prot, 0n] }), flash(P, [E18, 0n], 31)]).get(P);
  assert.equal(evs[0].dex, 'pancakeswap');
  const fp = 3300 + 3400 * 65536;
  const r = dayFees(pool, evs, { start: st(fp), end: st(fp) });
  assert.equal(r.q, Number((total - prot + (E18 - (E18 * 3300n) / 10000n)).toString()));
  // a PancakeSwap event on a pool listed as Uniswap's: not this pool's book, unread
  assert.deepEqual(dayFees({ ...pool, dex: 'uniswap' }, evs, { start: st(0), end: st(0) }), { kind: 'unread', why: 'venue' });
});

test('a fee-setting change during the day: swaps before at the old cut, after at the new; a change the logs missed leaves the day unread', () => {
  const P = A('b'), pool = { id: P, v: 3, dex: 'uniswap', fee: 10000 };
  const s1 = v3swap(P, { a0: E18, a1: -E18, block: 40 }), set = v3set(P, [0, 0, 4, 4], 41), s2 = v3swap(P, { a0: E18, a1: -E18, block: 42 });
  const fee = (E18 * 10000n) / 1000000n;
  const r = dayFees(pool, eventsByPool([s1, set, s2]).get(P), { start: st(0), end: st(0x44) });
  assert.equal(r.q, Number((fee + fee - fee / 4n).toString()), 'the first swap before the switch, the second after');
  // the change not in the logs: the day's start and end disagree with what the events say → unread, never a guess
  const missed = dayFees(pool, eventsByPool([s1, s2]).get(P), { start: st(0), end: st(0x44) });
  assert.deepEqual(missed, { kind: 'unread', why: 'setting' });
  // planted fault: the end's setting not checked (taken as whatever the events led to) → a day booked at the wrong cut
  const unchecked = dayFees(pool, eventsByPool([s1, s2]).get(P), { start: st(0), end: st(0) });
  assert.equal(unchecked.kind, 'day');
  assert.notEqual(unchecked.q, r.q, 'what the end check stops');
  // v4: the change event carries only the new value; start and end read, a change between them is followed
  const v = { id: V4ID, v: 4, dex: 'uniswap' };
  const w = dayFees(v, eventsByPool([v4swap({ a0: -E18, a1: E18, fee: 500, block: 43 }), v4set(100, 44), v4swap({ a0: -E18, a1: E18, fee: 500, block: 45 })]).get(V4ID), { start: st(0), end: st(100) });
  assert.equal(w.q, Number(((E18 * 500n) / 1000000n + (E18 * 500n) / 1000000n - (E18 * 100n) / 1000000n).toString()));
});

test('a pool created during the day counts from its creation; one not there by the day\'s end has no day; unread state is unread', () => {
  const v = { id: V4ID, v: 4, dex: 'uniswap' };
  const evs = eventsByPool([v4swap({ a0: -E18, a1: E18, fee: 3000, block: 50 })]).get(V4ID);
  assert.equal(dayFees(v, evs, { start: false, end: st(0) }).kind, 'day', 'created that day: the end\'s setting, no change since');
  // a v4 pool created and its protocol fee changed the same day: the setting before the change is unknown → unread
  assert.deepEqual(dayFees(v, eventsByPool([v4swap({ a0: -E18, a1: E18, fee: 3000, block: 50 }), v4set(100, 51)]).get(V4ID), { start: false, end: st(100) }), { kind: 'unread', why: 'setting' });
  assert.deepEqual(dayFees(v, [], { start: false, end: false }), { kind: 'unborn' });
  assert.deepEqual(dayFees(v, evs, { start: null, end: st(0) }), { kind: 'unread', why: 'state' });
  assert.deepEqual(dayFees(v, evs, { start: st(0), end: null }), { kind: 'unread', why: 'state' });
  // read, and no swaps: a real zero
  assert.equal(dayFees(v, [], { start: st(0), end: st(0) }).q, 0);
});

test('the state at a block carries the block\'s own timestamp: an old block answered with today\'s state is not read (planted fault: no check)', () => {
  const pools = [{ id: A('a'), v: 3 }, { id: A('b'), v: 3 }, { id: V4ID, v: 4 }, { id: A('e'), v: 3 }];
  const ok = (h) => ({ ok: true, data: '0x' + h });
  const slot0 = (sqrt, fp) => ok(W(sqrt) + W(0) + W(0) + W(1) + W(1) + W(fp) + W(1));
  const answers = (ts) => [ok(W(ts)), slot0(Q96, 0x44), ok(''), ok(W(Q96) + W(0) + W(100) + W(3000)), null];
  const m = readStates(pools, answers(1000), [900, 1000]);
  assert.deepEqual(m.get(A('a')), { setting: 0x44, sqrtPriceX96: Q96 });
  assert.equal(m.get(A('b')), false, 'no code at that block: not deployed yet');
  assert.deepEqual(m.get(V4ID), { setting: 100, sqrtPriceX96: Q96 });
  assert.equal(m.get(A('e')), null, 'unanswered: unread, never "not there"');
  assert.equal(readStates(pools, [ok(W(Q96 * 0n)), slot0(0n, 0)].concat([null, null, null]), [-Infinity, Infinity]).get(A('a')), false, 'not initialised: not there');
  assert.equal(readStates(pools, answers(5000), [900, 1000]), null, 'today\'s timestamp for an old block: none of it read');
  // planted fault: the range not checked → today's state taken for the old block, caught by the same call
  assert.notEqual(readStates(pools, answers(5000)), null);
});

// A made-up chain: one block a slot of `spb` seconds, every `miss`-th slot missed (Ethereum-like); Base-like: many
// blocks share a second.
function blocks({ start, end, spb = 12, miss = 7, perSec = null }) {
  const ts = [0];
  if (perSec) { for (let k = 0; start + Math.floor(k / perSec) <= end; k++) ts.push(start + Math.floor(k / perSec)); return ts; }
  for (let slot = 0, t = start; t <= end; slot++, t += spb) if (slot % miss !== 3) ts.push(t);
  return ts;
}
const firstAt = (ts, T) => { for (let b = 1; b < ts.length; b++) if (ts[b] >= T) return b; return null; };

test('a UTC day\'s first block, found exactly from block timestamps: missed slots, many blocks a second, a failed read is null', async () => {
  const T0 = Date.UTC(2026, 9, 1) / 1000;
  const eth = blocks({ start: T0, end: T0 + 40 * 86400 }), head = eth.length - 1;
  let reads = 0, worst = 0;
  for (const k of [1, 7, 20, 39]) {
    const T = T0 + k * 86400 + 0, n0 = reads;
    const got = await firstBlockAt(async (b) => { reads++; return eth[b] ?? null; }, T, { guess: head - Math.ceil((eth[head] - T) / 12), spb: 12, head });
    assert.equal(got, firstAt(eth, T), `day ${k}`);
    assert.ok(eth[got] >= T && eth[got - 1] < T);
    worst = Math.max(worst, reads - n0);
  }
  assert.ok(worst <= 12, `at most 12 reads a day start (${worst})`);
  // five blocks a second: the first of the second's blocks
  const base = blocks({ start: T0, end: T0 + 3 * 86400, perSec: 5 }), bh = base.length - 1;
  for (const T of [T0 + 86400, T0 + 2 * 86400 + 1]) {
    const got = await firstBlockAt(async (b) => base[b] ?? null, T, { guess: bh - Math.ceil((base[bh] - T) / 0.2) + 3, spb: 0.2, head: bh });
    assert.equal(got, firstAt(base, T));
  }
  // a guess just before a run of blocks sharing T's second: the first of them, never one a few blocks in
  for (const T of [T0 + 86400, T0 + 86400 + 7]) {
    const f = firstAt(base, T);
    assert.equal(await firstBlockAt(async (b) => base[b] ?? null, T, { guess: f - 1, spb: 0.2, head: bh }), f);
  }
  // a header nobody answered: null, never a near miss
  assert.equal(await firstBlockAt(async (b) => (b % 2 ? null : eth[b]), T0 + 86400, { guess: 7201, spb: 12, head }), null);
  assert.equal(await firstBlockAt(async (b) => eth[b], eth[head] + 600, { guess: head, spb: 12, head }), null, 'a moment past the head');
});

// The engine's world: two Uniswap v3 pools and a v4 pool on the made-up chain above, swaps every 300 blocks, and an
// io that serves timestamps, logs (through the real logsAdaptive and a node that can refuse a block) and states.
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const TODAY = Math.floor(NOW / DAY) * DAY;
function world({ refuse = null, partial = false, budget = null } = {}) {
  const start = (TODAY - 6 * DAY) / 1000 - 3600, ts = blocks({ start, end: NOW / 1000 + 2 * 86400 }), head = ts.length - 1;
  const P1 = A('1'), P2 = A('2'), born = firstAt(ts, (TODAY - 3 * DAY) / 1000 + 5 * 3600); // P2 deployed 3 days ago, 05:00
  const logs = [];
  for (let b = 2; b <= head; b += 300) {
    logs.push(v3swap(P1, { a0: E18, a1: -E18, block: b }));
    if (b >= born) logs.push(v3swap(P2, { a0: -E18, a1: 2n * E18, block: b + 1 }));
    logs.push(v4swap({ a0: -E18, a1: E18, fee: 500 + (b % 7) * 100, block: b + 2 }));
  }
  const truth = (id, day) => { // the day's LP fees as the swaps carry them (raw, at price 1)
    const [a, z] = [firstAt(ts, day / 1000), firstAt(ts, (day + DAY) / 1000) - 1];
    let q = 0n;
    for (const l of logs) {
      const b = parseInt(l.blockNumber, 16);
      if (b < a || b > z) continue;
      if (id === P1 && l.address === P1) { const f = (E18 * 3000n) / 1000000n; q += f - f / 4n; }
      if (id === P2 && l.address === P2) { const f = (2n * E18 * 3000n) / 1000000n; q += f - f / 4n; }
      if (id === V4ID && l.address === PM) q += (E18 * BigInt(parseInt(l.data.slice(-8), 16))) / 1000000n;
    }
    return Number(q.toString());
  };
  const n = { ts: 0, logs: 0, state: 0, getLogs: 0 };
  const rpc = { call: async (m, [f]) => {
    n.getLogs++;
    const a = parseInt(f.fromBlock, 16), z = parseInt(f.toBlock, 16);
    if (refuse != null && a <= refuse && refuse <= z) return null;
    return logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= a && b <= z && (Array.isArray(f.address) ? f.address.includes(l.address) : l.address === f.address && f.topics[1].includes(l.topics[1])); });
  } };
  // planted fault for one test: a reader that skips a refused chunk instead of calling the stretch unread
  const partialRead = async (f, a, z) => { const out = []; for (let x = a; x <= z; x += 1000) { const r = await rpc.call('eth_getLogs', [{ ...f, fromBlock: '0x' + x.toString(16), toBlock: '0x' + Math.min(z, x + 999).toString(16) }]); if (r) out.push(...r); } return out; };
  const spend = () => !budget || budget.take();
  const io = {
    head, spb: 12, clock: null,
    blockTs: async (b) => { n.ts++; return spend() ? ts[b] ?? null : null; },
    logs: async (v, ids, a, z) => { n.logs++; const f = filterOf(v, ids, PM); return partial ? partialRead(f, a, z) : logsAdaptive(rpc, f, a, z, { step: 1000, maxStep: 1000, minStep: 250, retries: 0, budget }); },
    state: async (pools, b, [lo, hi]) => {
      n.state++;
      if (!spend()) return null;
      if (!(ts[b] >= lo && ts[b] <= hi)) return null;
      return new Map(pools.map((p) => [p.id, p.id === P2 && b < born ? false : { setting: p.v === 4 ? 0 : 0x44, sqrtPriceX96: Q96 }]));
    },
  };
  const pools = [{ id: P1, v: 3, dex: 'uniswap', fee: 3000, createdAt: null }, { id: V4ID, v: 4, dex: 'uniswap', fee: 0x800000, createdAt: null }, { id: P2, v: 3, dex: 'uniswap', fee: 3000, createdAt: null }];
  return { io, n, pools, truth, ts, P1, P2 };
}
const run = (w, { cache = emptyCache(), now = NOW, budget = null, days = 5 } = {}) => exactFeesChain({ chain: 'ethereum', pools: w.pools, cache, now, io: w.io, budget, days }).then((s) => ({ s, cache }));

test('every pool\'s settled UTC days from its swaps: exact to the unit, newest first, nothing before a pool existed', async () => {
  const w = world();
  const { s, cache } = await run(w);
  assert.equal(s.unread, 0);
  for (const p of w.pools) {
    const e = cache.p.get(p.id);
    for (const [day, [q, px]] of e.d) { assert.equal(px, 1); assert.equal(q, Number(w.truth(p.id, day).toPrecision(6)), `${p.id.slice(0, 6)} ${new Date(day).toISOString()}`); }
  }
  assert.deepEqual([...cache.p.get(w.P1).d.keys()].sort(), [1, 2, 3, 4, 5].map((k) => TODAY - k * DAY).sort(), 'yesterday and the four days before (days: 5)');
  assert.ok(!cache.p.get(w.P1).d.has(TODAY), 'today is not complete: never read');
  // the pool deployed 3 days ago at 05:00: its creation day counts from then, nothing before it
  const p2 = cache.p.get(w.P2);
  assert.deepEqual([...p2.d.keys()].sort(), [1, 2, 3].map((k) => TODAY - k * DAY).sort());
  assert.equal(p2.s0, TODAY - 3 * DAY, 'nothing before its creation day is asked again');
  assert.equal(s.possible, 5 + 5 + 3, 'coverage counts only the days a pool can have');
  assert.equal(s.covered, s.possible);
  // a pass between 00:00 and 00:30 UTC leaves yesterday for later (its last blocks may still move)
  const early = await run(world(), { now: TODAY + 10 * 60e3 });
  assert.ok(!early.cache.p.get(w.P1).d.has(TODAY - DAY) && early.cache.p.get(w.P1).d.has(TODAY - 2 * DAY));
});

test('an unread chunk leaves the whole day unread, never a partial sum (planted fault: the chunk skipped)', async () => {
  const w0 = world(), refuse = firstAt(w0.ts, (TODAY - 2 * DAY) / 1000) + 4000; // a block in the middle of the day before yesterday
  const w = world({ refuse });
  const { s, cache } = await run(w);
  assert.ok(s.unread >= 1 && s.why.logs >= 1, JSON.stringify(s));
  for (const p of w.pools) assert.ok(!cache.p.get(p.id).d.has(TODAY - 2 * DAY), 'the day with the unread chunk is not held');
  assert.ok(cache.p.get(w.P1).d.has(TODAY - DAY), 'the other days are');
  // planted fault: a reader that skips the refused chunk books the day short, caught against the swaps
  const f = await run(world({ refuse, partial: true }));
  const got = f.cache.p.get(w.P1).d.get(TODAY - 2 * DAY)?.[0];
  assert.ok(got != null && got < w.truth(w.P1, TODAY - 2 * DAY), `${got} vs ${w.truth(w.P1, TODAY - 2 * DAY)}`);
});

test('a day held is never read again: the next pass reads nothing, a new day only that day (planted fault: a cache that loses its days)', async () => {
  const w = world();
  const { cache } = await run(w);
  const back = unpackSx(JSON.parse(JSON.stringify(packSx(cache, { now: NOW }))));
  const n0 = { ...w.n };
  const again = await run(w, { cache: back });
  assert.equal(w.n.logs - n0.logs, 0, 'no log read');
  assert.equal(w.n.ts - n0.ts, 0, 'the day starts are kept too');
  assert.equal(again.s.jobs, 0);
  assert.equal(again.s.covered, again.s.possible);
  // a day later: only the new day, one job per kind
  const n1 = { ...w.n };
  const next = await run(w, { cache: back, now: NOW + DAY });
  assert.equal(next.s.jobs, 2);
  assert.equal(w.n.logs - n1.logs, 2);
  // planted fault: the days not packed → every day read again, caught by the same count
  const lossy = unpackSx({ ...packSx(cache, { now: NOW }), p: Object.fromEntries(Object.entries(packSx(cache, { now: NOW }).p).map(([id, e]) => [id, { ...e, q: [], px: [], d0: null }])) });
  const n2 = { ...w.n };
  await run(w, { cache: lossy });
  assert.ok(w.n.logs - n2.logs >= 8, 'the lossy cache reads the days again');
});

test('within the budget: the pass stops asking, what it did not read waits (left, not unread), every day held is whole', async () => {
  for (const calls of [3, 40, 90]) {
    const budget = makeBudget({ calls }), w = world({ budget });
    const { s, cache } = await run(w, { budget });
    assert.ok(s.left > 0 && s.stopped === 'calls', `${calls}: ${JSON.stringify(s)}`);
    assert.equal(s.unread, 0, 'a job the budget cut short is left for later, not counted unread');
    for (const p of w.pools) for (const [day, [q]] of cache.p.get(p.id).d) assert.equal(q, Number(w.truth(p.id, day).toPrecision(6)), 'no partial day');
    if (calls === 90) assert.ok(s.added > 0, 'some days read');
  }
});

test('the plan: newest day first, the dashboard\'s order kept, groups of 40 by kind, a pool\'s creation day and s0 respected', () => {
  const pools = Array.from({ length: 45 }, (_, i) => ({ id: A((i % 16).toString(16)) + i, v: i === 3 ? 4 : 3, createdAt: i === 5 ? TODAY - 2 * DAY + 3600e3 : null }));
  const cache = emptyCache();
  cache.p.set(pools[6].id, { c: 'ethereum', t: NOW, d: new Map([[TODAY - DAY, [1, 1]]]), s0: TODAY - DAY });
  const { jobs, wanted } = planDays(pools, cache, { last: TODAY / DAY - 1, first: TODAY / DAY - 3 });
  assert.equal(jobs[0].day, TODAY - DAY);
  assert.deepEqual(jobs.slice(0, 3).map((j) => [j.v, j.pools.length]), [[3, 40], [3, 3], [4, 1]], 'yesterday: 43 v3 pools (one held) in two groups, then the v4 pool');
  assert.equal(jobs[0].pools[0].id, pools[0].id, 'the order kept');
  assert.ok(jobs.every((j, i) => i === 0 || j.day <= jobs[i - 1].day), 'newest first');
  assert.ok(!jobs.some((j) => j.day < TODAY - 2 * DAY && j.pools.includes(pools[5])), 'nothing before its creation day');
  assert.ok(!jobs.some((j) => j.pools.includes(pools[6])), 'nothing before s0, and its held day not asked');
  assert.equal(wanted, 44 + 44 + 43);
});

test('history.json y: the swaps over the counters over the estimates; exact counts both; the cross-check ratio (planted fault: counters over swaps)', () => {
  const L = 1n << 64n, day0 = TODAY - 10 * DAY;
  // the counters' rows at 00:05: token1 fees of 100 units (×1e18 raw) a day, price 1
  const d = Array.from({ length: 11 }, (_, k) => ({ t: day0 + k * DAY + 5 * 60e3, block: 1000 + k * 7200, sqrtPriceX96: Q96, tick: 0, L, fg0: 0n, fg1: (BigInt(k * 100) * E18) << 64n, parked: null }));
  const series = { h: [], d };
  const gt = { t: NOW, b: 1, days: new Map(Array.from({ length: 11 }, (_, k) => [day0 + k * DAY, [10000, 1]])) };
  const sx = { d: new Map([[TODAY - DAY, [120 * 1e18, 1]], [TODAY - 2 * DAY, [100 * 1e18, 1]], [day0 - 5 * DAY, [7 * 1e18, 1]]]), s0: null };
  const pool = { d0: 18, d1: 18, rate: 0.01, dyn: false, usd0: 1, usd1: 1, pxNow: 1, createdAt: day0 - 6 * DAY };
  const fy = feeYear({ series, gt, sx, pool, now: NOW });
  const row = (t) => fy.y.find((r) => r[0] === t);
  assert.deepEqual(row(TODAY - DAY), [TODAY - DAY, 120, 's'], 'the swaps\' day wins over the counters\' 100');
  assert.deepEqual(row(TODAY - 3 * DAY), [TODAY - 3 * DAY, 100, 'x'], 'the counters where no swap day is held');
  assert.deepEqual(row(day0 - 5 * DAY), [day0 - 5 * DAY, 7, 's'], 'a swap day before the counters were read');
  assert.equal(row(day0 - 6 * DAY)[2], null, 'neither: null');
  assert.equal(fy.yp.sw, 3);
  assert.equal(fy.yp.exact, fy.y.filter((r) => r[2] === 'x' || r[2] === 's').length);
  assert.deepEqual(fy.xs.map((x) => Number(x.toFixed(2))).sort(), [1, 1.2], 'swap ÷ counters on the two days with both');
  assert.equal(fy.su.get(TODAY - DAY), 120);
  // planted fault: the counters allowed over the swaps → yesterday reads 100, caught
  const xOnly = new Map(feeYear({ series, gt, pool, now: NOW }).y.map((r) => [r[0], r]));
  const fault = fy.y.map((r) => (xOnly.get(r[0])?.[2] === 'x' ? xOnly.get(r[0]) : r));
  assert.notDeepEqual(fault, fy.y);
  assert.equal(fault.find((r) => r[0] === TODAY - DAY)[1], 100);
  // a swap day of 0 fees before the pool existed never moves its start
  const early = feeYear({ series, gt: null, sx: { d: new Map([[day0 - 40 * DAY, [0, 1]]]), s0: null }, pool: { ...pool, createdAt: null }, now: NOW });
  assert.ok(early.y[0][0] >= day0, 'no row from a zero read');
});

test('a spike the day\'s own swaps back is never unconfirmed; one they contradict is (planted fault: swap evidence ignored)', () => {
  const T0 = TODAY - 60 * DAY + 5 * 60e3;
  const d = [[T0, 1, null, null, null], ...Array.from({ length: 59 }, (_, i) => [T0 + (i + 1) * DAY, 1, i + 1 === 40 ? 10000 : 100, null, null])];
  const spikeDay = Math.floor(d[39][0] / DAY) * DAY; // the spike row spans day 39 00:05 → day 40 00:05
  const su = (big) => new Map([[spikeDay, big], [spikeDay + DAY, 100]]);
  const backedBySwaps = feeSpikes({ d, gt: null, rate: 0.01, su: su(9990) });
  assert.equal(backedBySwaps.u, null, 'the swaps carry the day');
  assert.equal(backedBySwaps.bySwaps, 1);
  assert.deepEqual(feeSpikes({ d, gt: null, rate: 0.01, su: su(100) }).u, { d: [d[40][0]], y: [] }, 'the swaps contradict it');
  // planted fault: the swap evidence ignored → the backed spike shows unconfirmed (no volume read), caught
  assert.notDeepEqual(feeSpikes({ d, gt: null, rate: 0.01, su: null }).u, backedBySwaps.u);
  // y: a swap day is its own trades: never judged; the counters' spike still is
  const day0 = TODAY - 60 * DAY, y = Array.from({ length: 60 }, (_, i) => [day0 + i * DAY, i === 30 || i === 45 ? 9000 : 100, i === 45 ? 's' : 'x']);
  const fy = feeSpikes({ y, gt: null, rate: 0.01 });
  assert.deepEqual(fy.u, { d: [], y: [day0 + 30 * DAY] });
  assert.equal(fy.spikes, 2);
  assert.equal(swapEvidence(su(50), spikeDay + 12 * 3600e3, spikeDay + 36 * 3600e3), 75, 'half of each day');
  assert.equal(swapEvidence(su(50), spikeDay + DAY, spikeDay + 3 * DAY), null, 'a day without its swaps: no evidence');
});

test('the cache round-trips through snapshots.json; malformed entries are dropped; a pool not scanned for 30 days leaves', () => {
  const c = emptyCache();
  c.p.set(A('a'), { c: 'ethereum', t: NOW, d: new Map([[TODAY - DAY, [5, 1.5]], [TODAY - 3 * DAY, [0, null]], [TODAY - 400 * DAY, [9, 1]]]), s0: TODAY - 300 * DAY });
  c.p.set(A('b'), { c: 'base', t: NOW - 31 * DAY, d: new Map([[TODAY - DAY, [1, 1]]]), s0: null });
  c.b.set('ethereum', new Map([[TODAY - DAY, 123], [TODAY, 456]]));
  const packed = JSON.parse(JSON.stringify(packSx(c, { now: NOW })));
  assert.deepEqual(Object.keys(packed.p), [A('a')], 'the pool not scanned for 31 days is dropped');
  assert.deepEqual(packed.p[A('a')].q, [0, null, 5], 'columns from the first day held, null where none');
  const back = unpackSx(packed);
  assert.deepEqual([...back.p.get(A('a')).d], [[TODAY - 3 * DAY, [0, null]], [TODAY - DAY, [5, 1.5]]], 'older than the year: gone');
  assert.equal(back.p.get(A('a')).s0, TODAY - 300 * DAY);
  assert.deepEqual([...back.b.get('ethereum')], [[TODAY - DAY, 123], [TODAY, 456]]);
  const bad = unpackSx({ p: { x: { t: NOW, d0: 5, q: [1], px: [1] }, y: { t: NOW, d0: TODAY, q: [-1, 'a'], px: [1, 1] } }, b: { base: { d0: 7, n: [1] } } });
  assert.equal(bad.p.has('x'), false, 'a d0 off a UTC day: dropped');
  assert.equal(bad.p.get('y').d.size, 0, 'a negative or junk fee: not a day');
  assert.equal(bad.b.has('base'), false);
  assert.equal(unpackSx(null).p.size, 0);
});

test('the public line: counts, one ratio and seconds only; the check needs 20 days with both', () => {
  const runs = [{ chain: 'ethereum', added: 12, read: 6, jobs: 7, unread: 1, why: { logs: 1 }, left: 30, stopped: 'time', covered: 400, possible: 9000, ms: 58000, calls: 412 },
    { chain: 'base', broke: 'fetch failed' }];
  const { line, ok } = exactLine(runs, { xs: [1, 1.02, 0.98, 1.5], sDays: 400 });
  assert.equal(line, '400 pool-days from swaps, median swap÷growth 1.01x over 4 days, 1 days differ >20%; ethereum +12 days in 6 of 7 jobs read (1 unread: logs 1; 30 left by time), coverage 400 of 9000 pool-days, 58 s, 412 calls; base broke (fetch failed)');
  assert.equal(ok, null, 'under 20 days with both: no verdict');
  assert.ok(!/\$|0x[0-9a-f]{6,}/i.test(line));
  assert.equal(exactLine(runs, { xs: Array(30).fill(1.01) }).ok, true);
  assert.equal(exactLine(runs, { xs: Array(30).fill(1.3) }).ok, false, 'swaps and counters a third apart: fails');
  assert.equal(EXACT.settleMs, 30 * 60e3);
});
