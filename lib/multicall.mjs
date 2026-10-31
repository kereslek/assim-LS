// Multicall3 aggregate3: many read calls in one eth_call. A call that reverts comes back
// { ok: false }; a chunk the RPC could not answer comes back null for every call in it
// (unread, never "empty" and never "no pool").
import { selector } from './keccak.mjs';
import { mapLimit } from './rpc.mjs';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const AGGREGATE3 = selector('aggregate3((address,bool,bytes)[])');

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

// calls: [{ target, data, allowFailure = true }]
export function encodeAggregate3(calls) {
  const elems = calls.map(({ target, data, allowFailure = true }) => {
    const d = strip(data);
    if (d.length % 2 || /[^0-9a-f]/.test(d)) throw new Error('bad calldata');
    return strip(target).padStart(64, '0') + w(allowFailure ? 1 : 0) + w(0x60) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
  });
  let off = 32 * calls.length;
  const offsets = elems.map((e) => { const o = off; off += e.length / 2; return w(o); });
  return AGGREGATE3 + w(0x20) + w(calls.length) + offsets.join('') + elems.join('');
}

// Returns [{ ok, data }] or null when the answer is malformed or truncated.
export function decodeAggregate3(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  const h = hex.slice(2), size = h.length / 2;
  const word = (o) => (o >= 0 && o + 32 <= size ? BigInt('0x' + h.slice(o * 2, o * 2 + 64)) : null);
  const num = (o) => { const v = word(o); return v == null || v > BigInt(size) ? null : Number(v); };
  const arr = num(0);
  const n = arr == null ? null : num(arr);
  if (n == null) return null;
  const base = arr + 32, out = [];
  for (let i = 0; i < n; i++) {
    const rel = num(base + 32 * i);
    if (rel == null) return null;
    const e = base + rel, ok = word(e), bo = num(e + 32);
    if (ok == null || bo == null) return null;
    const len = num(e + bo);
    if (len == null || e + bo + 32 + len > size) return null;
    out.push({ ok: ok === 1n, data: '0x' + h.slice((e + bo + 32) * 2, (e + bo + 32 + len) * 2) });
  }
  return out;
}

// run(calls, tag) → one { ok, data } per call, or null for calls in a chunk nobody answered.
// A chunk that fails is split in half and retried, so one oversized request doesn't lose the rest.
export function makeMulticall(rpc, { address = MULTICALL3, chunk = 400, concurrency = 3, minSplit = 25 } = {}) {
  async function one(calls, tag) {
    const r = await rpc.call('eth_call', [{ to: address, data: encodeAggregate3(calls) }, tag]);
    const d = decodeAggregate3(r);
    if (d && d.length === calls.length) return d;
    if (calls.length <= minSplit) return new Array(calls.length).fill(null);
    const mid = Math.ceil(calls.length / 2);
    return [...(await one(calls.slice(0, mid), tag)), ...(await one(calls.slice(mid), tag))];
  }
  return async function run(calls, tag = 'latest') {
    const chunks = [];
    for (let i = 0; i < calls.length; i += chunk) chunks.push(calls.slice(i, i + chunk));
    return (await mapLimit(chunks, concurrency, (c) => one(c, tag))).flat();
  };
}
