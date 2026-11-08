// The chains the scanner reads and how it reads each one: public RPCs (archive nodes for past state),
// block time, how many blocks one eth_getLogs may span, the ids each data source uses for the chain,
// and the per-pass read budget. Contract addresses live in lib/pools.mjs; routers in lib/routers.mjs.
// Public facts only. Blocks per hour and log spans follow docs/handout.md rule 11 (9k blocks on
// Ethereum, 10k on L2s); a chain's blocks are always routed to that chain's own nodes.
import { ETHEREUM, BASE } from './pools.mjs';

export const CHAINS = Object.freeze({
  ethereum: Object.freeze({
    id: 'ethereum', label: 'Ethereum', c: ETHEREUM, secPerBlock: 12,
    rpcs: Object.freeze(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net', 'https://eth.blockscout.com/api/eth-rpc']),
    // nodes that serve old state (probes: state at block 15,000,000)
    archive: Object.freeze(['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth.blockscout.com/api/eth-rpc']),
    // log reads skip rpc.flashbots.net: empty or short answers with no error for ranges it doesn't hold
    noLogs: Object.freeze(['flashbots']),
    swapStep: 1000, logMax: 9000, confirmEmpty: true, // an empty log answer counts once a second node confirms it
    coingecko: 'ethereum', llama: 'ethereum', dexscreener: 'ethereum', gecko: 'eth', etherscan: 1, blockscout: 'https://eth.blockscout.com/api',
    maxWords: 600_000, prefix: '',
  }),
  base: Object.freeze({
    // Base's sequencer stamps blocks on a fixed clock: 2 s a block until block 53,556,126 (5 Nov 2026 18:00
    // UTC), 0.2 s since (block numbers by timestamp, 8 Nov 2026: 432,000 blocks in the last day, 43,200 a day
    // from 90 to 30 days back, both exact). secPerBlock is the current pace; eras give any block's time.
    id: 'base', label: 'Base', c: BASE, secPerBlock: 0.2,
    eras: Object.freeze([Object.freeze({ block: 52375508, t: 1791540364, sec: 2 }), Object.freeze({ block: 53556126, t: 1793901600, sec: 0.2 })]),
    rpcs: Object.freeze(['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org', 'https://1rpc.io/base']),
    // old state (probe, 8 Nov 2026): drpc and mainnet.base.org back to 90 days, publicnode to 30
    archive: Object.freeze(['https://base.drpc.org', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com']),
    noLogs: Object.freeze([]),
    // a probe (8 Nov 2026) found one Base node serving address-filtered logs over 2,000+ blocks, so an
    // empty answer can't wait for a second node's confirmation: it is taken as read
    swapStep: 10000, logMax: 10000, confirmEmpty: false,
    coingecko: 'base', llama: 'base', dexscreener: 'base', gecko: 'base', etherscan: 8453, blockscout: 'https://base.blockscout.com/api',
    maxWords: 250_000, prefix: 'base ',
  }),
});
export const CHAIN_IDS = Object.freeze(Object.keys(CHAINS));

// BNB Chain is left for later: its blocks are under a second apart (over 100k a day), so a day of swap
// logs, archive reads and the backfill would cost several times Base's, and few free nodes keep its
// old state. The scanner's maths would take it as is (PancakeSwap v3 is read on Base and Ethereum).

export const blocksIn = (ch, ms) => Math.round(ms / (ch.secPerBlock * 1000));
export const blocksPerHour = (ch) => blocksIn(ch, 3600e3);
export const blocksPerDay = (ch) => blocksIn(ch, 86400e3);

// A chain with eras has an exact clock: a block's time (s) and the block at a time (s), from the era it
// falls in (before the first era, along the first era's pace). Without eras (Ethereum: missed slots make
// 12 s a block drift) both are null and the scan's anchor-based clock (lib/backfill.mjs) is used.
const eraOfBlock = (ch, b) => { let e = ch.eras[0]; for (const x of ch.eras) if (b >= x.block) e = x; return e; };
const eraOfTime = (ch, t) => { let e = ch.eras[0]; for (const x of ch.eras) if (t >= x.t) e = x; return e; };
export function timeOfBlock(ch, b) {
  if (!ch?.eras?.length || !Number.isFinite(b)) return null;
  const e = eraOfBlock(ch, b);
  return e.t + (b - e.block) * e.sec;
}
export function blockAtTime(ch, tSec) {
  if (!ch?.eras?.length || !Number.isFinite(tSec)) return null;
  const e = eraOfTime(ch, tSec);
  return Math.floor(e.block + (tSec - e.t) / e.sec);
}
// How many blocks back from `block` a moment `secBack` seconds before `nowSec` is (chain-aware).
export function blocksBack(ch, { block, nowSec, secBack }) {
  const b = blockAtTime(ch, nowSec - secBack);
  if (b != null) { const head = blockAtTime(ch, nowSec); return Math.max(0, head - b); }
  return Math.round(secBack / ch.secPerBlock);
}
// The age (s) a block `back` blocks before the head should have: for pastBlockAnswer's ageSec.
export function ageOfBlocksBack(ch, { block, back, nowSec }) {
  const t = timeOfBlock(ch, block - back), t0 = timeOfBlock(ch, block);
  return t != null && t0 != null ? t0 - t : back * ch.secPerBlock;
}
