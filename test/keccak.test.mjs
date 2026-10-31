import test from 'node:test';
import assert from 'node:assert/strict';
import { keccakHex, sha3Hex, selector, topic } from '../lib/keccak.mjs';

test('the sponge matches standard SHA3-256 (same permutation and rate), including multi-block input', () => {
  // reference values from Python's hashlib.sha3_256
  assert.equal(sha3Hex(''), '0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  assert.equal(sha3Hex('x'.repeat(300)), '0x34ed36d4d71d1a9a582cce5a006d6102d173fd867a27be7b2fe5d854587ddba2');
});

test('keccak-256 known vectors', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex('The quick brown fox jumps over the lazy dog'), '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15');
});

test('event topics match what the chain emits', () => {
  assert.equal(topic('Transfer(address,address,uint256)'), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  // Both confirmed against on-chain logs on 31 Oct 2026 (Ethereum and Base).
  assert.equal(topic('PoolCreated(address,address,uint24,int24,address)'), '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118');
  assert.equal(topic('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'), '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438');
  assert.equal(topic('Swap(address,address,int256,int256,uint160,uint128,int24)'), '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  assert.equal(topic('Mint(address,address,int24,int24,uint128,uint256,uint256)'), '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde');
  assert.equal(topic('Burn(address,int24,int24,uint128,uint256,uint256)'), '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c');
});

test('function selectors match the handout', () => {
  assert.equal(selector('slot0()'), '0x3850c7bd');
  assert.equal(selector('liquidity()'), '0x1a686502');
  assert.equal(selector('getPool(address,address,uint24)'), '0x1698ee82');
  assert.equal(selector('positions(uint256)'), '0x99fbab88');
  assert.equal(selector('getSlot0(bytes32)'), '0xc815641c');
  assert.equal(selector('getLiquidity(bytes32)'), '0xfa6793d5');
});

test('inputs longer than one block (136 bytes) hash differently from their prefix', () => {
  const a = keccakHex('x'.repeat(300)), b = keccakHex('x'.repeat(299));
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
