// Fake JSON-RPC + API host serving a made-up stranded pool, so scripts/probes.mjs runs end to end offline.
import { selector } from '../../lib/keccak.mjs';
const SP = 60, CUR = 125; // tick spacing, current tick
const positions = [ { lo: -4200, hi: -2400, L: 10n**21n }, { lo: 1800, hi: 3600, L: 8n*10n**20n }, { lo: -300, hi: 300, L: 2n*10n**19n }, { lo: -887220, hi: 887220, L: 10n**18n } ];
const net = new Map(); for (const p of positions) { net.set(p.lo, (net.get(p.lo)||0n) + p.L); net.set(p.hi, (net.get(p.hi)||0n) - p.L); }
const poolL = positions.filter(p => p.lo <= CUR && CUR < p.hi).reduce((s,p) => s + p.L, 0n);
const W = v => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const sqrtX96 = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, CUR)) * 2**96));
const S = { slot0: selector('slot0()'), liq: selector('liquidity()'), ts: selector('tickSpacing()'), bm: selector('tickBitmap(int16)'), ticks: selector('ticks(int24)'), getPool: selector('getPool(address,address,uint24)'), s4: selector('getSlot0(bytes32)') };
const arg = (data) => Number(BigInt.asIntN(256, BigInt('0x' + data.slice(10, 74))));
let calls = 0;
function rpc(q, base) {
  calls++;
  const r = (result) => ({ jsonrpc: '2.0', id: q.id, result });
  switch (q.method) {
    case 'eth_chainId': return r(base ? '0x2105' : '0x1');
    case 'eth_blockNumber': return r('0x1312d00');
    case 'eth_getCode': return r('0x6080');
    case 'eth_getLogs': return r([{}, {}, {}]);
    case 'eth_call': {
      const d = q.params[0].data, sel = d.slice(0, 10);
      if (sel === S.slot0) return r('0x' + W(sqrtX96) + W(CUR) + W(0) + W(0) + W(0) + W(0) + W(1));
      if (sel === S.liq) return r('0x' + W(poolL));
      if (sel === S.ts) return r('0x' + W(SP));
      if (sel === S.bm) { const w = arg(d); let bm = 0n; for (const t of net.keys()) { const c = t / SP, wi = Math.floor(c / 256), bit = c - wi * 256; if (wi === w) bm |= 1n << BigInt(bit); } return r('0x' + W(bm)); }
      if (sel === S.ticks) { const t = arg(d), n = net.get(t) || 0n; return r('0x' + W(n < 0n ? -n : n) + W(n) + W(0).repeat(6)); }
      if (sel === S.getPool) return r('0x' + W(BigInt(base ? '0x' + 'ab'.repeat(20) : '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801')));
      if (sel === S.s4) return r('0x' + W(BigInt(Math.floor(Math.sqrt(3000e-12) * 2**96))) + W(-196000) + W(0) + W(500));
      return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'unknown call ' + sel } };
    }
  }
  return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'no method' } };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), base = /base/.test(u);
  if ((init.method || 'GET') === 'POST') {
    const body = JSON.parse(init.body);
    const out = Array.isArray(body) ? body.map(q => rpc(q, base)) : rpc(body, base);
    return { ok: true, status: 200, json: async () => out };
  }
  if (/llama/.test(u)) return { ok: true, status: 200, json: async () => ({ coins: { 'coingecko:ethereum': { price: 3000 } } }) };
  if (/goplus/.test(u)) return { ok: false, status: 403, json: async () => ({}) }; // a refused API must show as FAIL, not crash
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
};
process.on('exit', () => console.error(`[harness] ${calls} RPC requests answered; expected walk liquidity ${poolL}`));
await import('../../scripts/probes.mjs');
