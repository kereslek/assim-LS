// sell-test: can a small amount of the pool's non-quote token actually be sold through it? One
// eth_call against the latest block with state overrides, no transaction and no funds:
//  1. find the token's balance slot by probing: give Multicall3 a made-up balance at a candidate
//     storage key (Solidity and Vyper mapping layouts for slots 0–15, and OpenZeppelin's namespaced
//     ERC20 storage) and see whether balanceOf reads it back;
//  2. with that balance in place, Multicall3 approves the v3 SwapRouter02, sells through the pool's
//     own fee tier to itself, and reads its quote-token balance before and after.
// Pass: what arrived is at least 95% of what the router said the pool paid. A sell that reverts (a
// honeypot, a transfer tax the pool refuses) fails. A token whose balance slot isn't found, or a node
// that doesn't take overrides, is unread (null), never a pass. v3-style pools: Uniswap's SwapRouter02 on
// Ethereum and Base, PancakeSwap's Smart Router (the same exactInputSingle, no deadline) for its pools.
import { keccakHex } from './keccak.mjs';
import { encodeCall, decodeWords } from './abi.mjs';
import { MULTICALL3, encodeAggregate3, decodeAggregate3 } from './multicall.mjs';

export const SWAP_ROUTER02 = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
// The router each chain's v3-style venue sells through (public contract facts; the probes check they have code).
export const SELL_ROUTERS = Object.freeze({
  ethereum: Object.freeze({ uniswap: SWAP_ROUTER02, pancakeswap: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4' }),
  base: Object.freeze({ uniswap: '0x2626664c2603336e57b271c5c0b26f421741e481', pancakeswap: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4' }),
});
const OZ_ERC20 = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n; // ERC-7201 "openzeppelin.storage.ERC20"
const MC = MULTICALL3.toLowerCase();
const w32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const bytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const mapKey = (keyWord, slotWord) => keccakHex(bytes(keyWord + slotWord));

// The storage keys where balances[holder] may live, in probe order.
export function balanceKeys(holder = MC) {
  const a = w32(BigInt(holder)), out = [];
  for (let s = 0; s < 16; s++) out.push(mapKey(a, w32(s)), mapKey(w32(s), a));
  out.push(mapKey(a, w32(OZ_ERC20)));
  return out;
}
const override = (token, key, value) => ({ [token]: { stateDiff: { [key]: '0x' + w32(value) } } });
const balanceOfCall = (token, who = MC) => ({ to: token, data: encodeCall('balanceOf(address)', [{ t: 'address', v: who }]) });

// rpc: makeRpc instance. Returns the key, or null (not found / overrides not answered).
export async function findBalanceKey(rpc, token, { magic = 0x5eed1234567n } = {}) {
  const keys = balanceKeys();
  const res = await rpc.batch(keys.map((k) => ({ method: 'eth_call', params: [balanceOfCall(token), 'latest', override(token, k, magic)] })));
  const i = res.findIndex((r) => typeof r === 'string' && decodeWords(r)?.[0] === magic);
  return i >= 0 ? keys[i] : null;
}

// The verdict from the simulation's five answers; exported for the planted-fault tests.
export function sellVerdict(ans, amountIn, { min = 0.95 } = {}) {
  if (!Array.isArray(ans) || ans.length !== 5) return { ok: null, why: 'unread' };
  const word = (r) => (r && r.ok ? decodeWords(r.data)?.[0] ?? null : null);
  if (word(ans[0]) !== amountIn) return { ok: null, why: 'balance not set' }; // the override didn't take: can't tell
  if (!ans[2]?.ok) return { ok: null, why: 'approve refused' };
  if (!ans[3]?.ok) return { ok: false, why: 'sell reverted' };
  const quoted = word(ans[3]), before = word(ans[1]), after = word(ans[4]);
  if (quoted == null || before == null || after == null || !(quoted > 0n)) return { ok: null, why: 'unread' };
  const got = after - before, ratio = Number(got) / Number(quoted);
  return { ok: ratio >= min, ratio, why: ratio >= min ? 'sold' : 'less arrived than quoted' };
}

export function sellCalls({ tokenIn, tokenOut, fee, amountIn, router = SWAP_ROUTER02 }) {
  const bal = (t) => ({ target: t, data: encodeCall('balanceOf(address)', [{ t: 'address', v: MC }]) });
  return [
    bal(tokenIn), bal(tokenOut),
    { target: tokenIn, data: encodeCall('approve(address,uint256)', [{ t: 'address', v: router }, { t: 'uint', v: amountIn }]) },
    { target: router, data: encodeCall('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [
      { t: 'address', v: tokenIn }, { t: 'address', v: tokenOut }, { t: 'uint', v: fee }, { t: 'address', v: MC }, { t: 'uint', v: amountIn }, { t: 'uint', v: 0 }, { t: 'uint', v: 0 }]) },
    bal(tokenOut),
  ];
}

export async function sellTest(rpc, { tokenIn, tokenOut, fee, amountIn, key, router = SWAP_ROUTER02 }) {
  if (!key || !(amountIn > 0n)) return { ok: null, why: key ? 'no amount' : 'no balance slot' };
  const r = await rpc.call('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(sellCalls({ tokenIn, tokenOut, fee, amountIn, router })) }, 'latest', override(tokenIn, key, amountIn)]);
  return sellVerdict(decodeAggregate3(r), amountIn);
}
