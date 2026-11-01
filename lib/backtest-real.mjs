// Real-position cross-check (Revert has no public backtest API): real positions that stayed in
// range and unchanged through a window earned exactly L × Δ(fee growth inside), which the pool
// books on its own. Their Δ per unit of liquidity is compared with what the engine credits a unit
// of liquidity in the same range (lib/backtest.mjs creditPerL). Pure functions, no I/O.
//
// Positions are the pool's own records: v3 (owner, tickLower, tickUpper), so an NFT manager's
// positions with the same range count as one; v4 (owner, tickLower, tickUpper, salt). Fee growth
// inside is computed live from pool state at both blocks (v3: feeGrowthGlobal and both ticks'
// feeGrowthOutside; v4: StateView.getFeeGrowthInside), never from a position's stored
// feeGrowthInsideLast, which only moves when the position is touched.
import { topic, keccakHex } from './keccak.mjs';
import { decodeWords, signed, toAddress } from './abi.mjs';
import { creditPerL, refValue } from './backtest.mjs';

const Q128 = 2 ** 128, U256 = (x) => BigInt.asUintN(256, x);
const hexNum = (x) => (typeof x === 'number' ? x : parseInt(x, 16));

export const POSITION_TOPICS = {
  mint: topic('Mint(address,address,int24,int24,uint128,uint256,uint256)'),
  burn: topic('Burn(address,int24,int24,uint128,uint256,uint256)'),
  modify: topic('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'),
};

// v3 pool Mint/Burn and v4 ModifyLiquidity → { owner, ta, tb, salt, change (BigInt, signed), block, logIndex }.
// A Burn of 0 or a ModifyLiquidity of 0 is a fee poke (a collect): it changes nothing.
export function decodePositionEvent(log) {
  const t = log?.topics, d = decodeWords(log?.data);
  if (!t || !d) return null;
  const t0 = String(t[0]).toLowerCase(), base = { block: hexNum(log.blockNumber), logIndex: hexNum(log.logIndex) };
  if (t0 === POSITION_TOPICS.mint && t.length >= 4 && d.length >= 4) return { ...base, owner: toAddress(BigInt(t[1])), ta: Number(signed(BigInt(t[2]))), tb: Number(signed(BigInt(t[3]))), salt: null, change: d[1] };
  if (t0 === POSITION_TOPICS.burn && t.length >= 4 && d.length >= 3) return { ...base, owner: toAddress(BigInt(t[1])), ta: Number(signed(BigInt(t[2]))), tb: Number(signed(BigInt(t[3]))), salt: null, change: -d[0] };
  if (t0 === POSITION_TOPICS.modify && t.length >= 3 && d.length >= 4) return { ...base, owner: toAddress(BigInt(t[2])), ta: Number(signed(d[0])), tb: Number(signed(d[1])), salt: '0x' + d[3].toString(16).padStart(64, '0'), change: signed(d[2]) };
  return null;
}

const keyOf = (e) => `${e.owner}|${e.ta}|${e.tb}|${e.salt ?? ''}`;

// Positions that had liquidity added at or before `from` and no liquidity change in (from, to].
// events: decoded position events covering at least (from, to]; an unread stretch must be null upstream.
export function unchangedPositions(events, from, to) {
  const added = new Map(), changed = new Set();
  for (const e of events) {
    if (!e || e.change === 0n) continue;
    const k = keyOf(e);
    if (e.block <= from && e.change > 0n && !added.has(k)) added.set(k, { owner: e.owner, ta: e.ta, tb: e.tb, salt: e.salt });
    if (e.block > from && e.block <= to) changed.add(k);
  }
  return [...added.entries()].filter(([k]) => !changed.has(k)).map(([, v]) => v);
}

// v3 pool position key: keccak256(abi.encodePacked(owner, int24 tickLower, int24 tickUpper)).
export function v3PositionKey(owner, ta, tb) {
  const i24 = (t) => BigInt.asUintN(24, BigInt(t)).toString(16).padStart(6, '0');
  const hex = String(owner).toLowerCase().replace(/^0x/, '').padStart(40, '0') + i24(ta) + i24(tb);
  return keccakHex(Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16))));
}

// v3-core getFeeGrowthInside: global − below − above, all modulo 2^256.
export function feeGrowthInside({ tick, global, outsideLower, outsideUpper, ta, tb }) {
  return [0, 1].map((i) => {
    const below = tick >= ta ? outsideLower[i] : U256(global[i] - outsideLower[i]);
    const above = tick < tb ? outsideUpper[i] : U256(global[i] - outsideUpper[i]);
    return U256(global[i] - below - above);
  });
}

// Positions to test: those whose range held the price at every swap of the window (creditPerL is
// null otherwise), narrowest first (they cross the most ticks inside). Returns [{ ...pos, credit }].
export function inRangeCandidates(prep, win, positions, n = 12) {
  return positions.map((p) => ({ ...p, credit: creditPerL(prep, win, p.ta, p.tb) })).filter((p) => p.credit)
    .sort((a, b) => a.tb - a.ta - (b.tb - b.ta)).slice(0, n);
}

// positions: [{ credit: [c0, c1] (engine, raw per unit L), then: [g0, g1], now: [g0, g1] (fee growth inside, X128 BigInt) }].
// Each ratio = engine ÷ real, both valued in the reference token at the window's last price.
// Returns { positions, within2, median, ratios } or null when nothing could be compared.
export function realCheck(positions, { P, d0 = 0, d1 = 0, ref = 1, max = 5 } = {}) {
  const val = refValue(ref, d0, d1), ratios = [];
  for (const p of positions) {
    if (ratios.length >= max) break;
    if (!p?.credit || !p.then || !p.now) continue;
    const real = [0, 1].map((i) => Number(U256(p.now[i] - p.then[i])) / Q128);
    const want = val(real[0], real[1], P), got = val(p.credit[0], p.credit[1], P);
    if (!(want > 0)) continue; // nothing traded through it: nothing to compare
    ratios.push(got / want);
  }
  if (!ratios.length) return null;
  const s = [...ratios].sort((a, b) => a - b);
  return { positions: ratios.length, within2: ratios.filter((r) => Math.abs(r - 1) <= 0.02).length, median: s[Math.floor(s.length / 2)], ratios };
}

// Pass: at least 4 of 5 within 2% (with fewer positions, all but one in five).
export const realCheckPasses = (rc) => !!rc && rc.within2 >= Math.min(4, Math.ceil(0.8 * rc.positions));
