// Minimal ABI helpers for the handful of calls the scanner makes. Selectors are derived from
// signatures with keccak, never typed by hand.
import { selector } from './keccak.mjs';

const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const addrWord = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes32Word = (b) => String(b).toLowerCase().replace(/^0x/, '').padStart(64, '0');

// args: [{ t: 'address' | 'uint' | 'int' | 'bytes32', v }]
export function encodeCall(signature, args = []) {
  return selector(signature) + args.map((a) => (a.t === 'address' ? addrWord(a.v) : a.t === 'bytes32' ? bytes32Word(a.v) : word(a.v))).join('');
}

export function decodeWords(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  const h = hex.slice(2);
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
  return out;
}

export const signed = (w, bits = 256) => BigInt.asIntN(bits, w);
export const toAddress = (w) => '0x' + w.toString(16).padStart(64, '0').slice(24);
