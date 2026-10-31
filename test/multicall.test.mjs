import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAggregate3, decodeAggregate3, makeMulticall, AGGREGATE3 } from '../lib/multicall.mjs';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);

test('aggregate3 selector is the published one', () => {
  assert.equal(AGGREGATE3, '0x82ad56cb');
});

test('encoding matches a vector written out word by word from the ABI spec', () => {
  const one = '0x82ad56cb' + w(0x20) + w(1) + w(0x20) + '0'.repeat(24) + '11'.repeat(20) + w(1) + w(0x60) + w(4) + '313ce567' + '0'.repeat(56);
  assert.equal(encodeAggregate3([{ target: A, data: '0x313ce567' }]), one);
  // two calls of different sizes: element 0 is 5 words (160 bytes), so element 1 starts at 64 + 160
  const data1 = '0x70a08231' + '0'.repeat(24) + '33'.repeat(20);
  const two = encodeAggregate3([{ target: A, data: '0x313ce567' }, { target: B, data: data1, allowFailure: false }]);
  const words = two.slice(10).match(/.{64}/g);
  assert.equal(BigInt('0x' + words[1]), 2n);
  assert.equal(BigInt('0x' + words[2]), 64n);
  assert.equal(BigInt('0x' + words[3]), 224n);
  assert.equal(words[4 + 5], '0'.repeat(24) + '22'.repeat(20)); // element 1 target
  assert.equal(BigInt('0x' + words[4 + 6]), 0n); // allowFailure false
  assert.equal(BigInt('0x' + words[4 + 8]), 36n); // calldata length
  assert.throws(() => encodeAggregate3([{ target: A, data: '0x123' }]));
});

test('decoding a hand-built answer, and refusing a truncated one', () => {
  const blob = '0x' + w(0x20) + w(2) + w(0x40) + w(0xc0) + w(1) + w(0x40) + w(32) + w(18) + w(0) + w(0x40) + w(0);
  assert.deepEqual(decodeAggregate3(blob), [{ ok: true, data: '0x' + w(18) }, { ok: false, data: '0x' }]);
  assert.equal(decodeAggregate3(blob.slice(0, blob.length - 64)), null);
  assert.equal(decodeAggregate3('0x'), null);
  assert.equal(decodeAggregate3(null), null);
  assert.equal(decodeAggregate3('0x' + w(0x20) + w(1) + w(0xffff)), null); // offset past the end
});

// A fake chain: parses aggregate3 calldata independently of the encoder, answers each call with
// its own index, and refuses any eth_call carrying more than 100 calls (to exercise splitting).
function fakeRpc({ maxCalls = 100, dead = false } = {}) {
  let seen = 0;
  return {
    get count() { return seen; },
    async call(method, [{ data }]) {
      seen++;
      if (dead || method !== 'eth_call' || !data.startsWith('0x82ad56cb')) return null;
      const h = data.slice(10), word = (o) => BigInt('0x' + h.slice(o * 2, o * 2 + 64));
      const n = Number(word(32));
      if (n > maxCalls) return null;
      const idx = [];
      for (let i = 0; i < n; i++) {
        const e = 64 + Number(word(64 + 32 * i));
        const len = Number(word(e + Number(word(e + 64))));
        idx.push(BigInt('0x' + h.slice((e + 128) * 2, (e + 128 + len) * 2)) & 0xffffn);
      }
      let off = 32 * n, head = '', body = '';
      for (const v of idx) { head += w(off); const el = w(1) + w(0x40) + w(32) + w(v); body += el; off += el.length / 2; }
      return '0x' + w(0x20) + w(n) + head + body;
    },
  };
}

test('multicall runner: answers come back in order, oversized chunks are split', async () => {
  const rpc = fakeRpc({ maxCalls: 100 });
  const mc = makeMulticall(rpc, { chunk: 400, concurrency: 2 });
  const calls = Array.from({ length: 950 }, (_, i) => ({ target: A, data: '0x' + w(i) }));
  const res = await mc(calls);
  assert.equal(res.length, 950);
  assert.ok(res.every((r, i) => r && r.ok && BigInt(r.data) === BigInt(i)));
  assert.ok(rpc.count > 3); // 400-call chunks were refused and split
});

test('multicall runner: an unanswered chunk is null for every call in it, never empty', async () => {
  const mc = makeMulticall(fakeRpc({ dead: true }), { chunk: 50 });
  const res = await mc(Array.from({ length: 120 }, (_, i) => ({ target: A, data: '0x' + w(i) })));
  assert.equal(res.length, 120);
  assert.ok(res.every((r) => r === null));
});
