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
    swapStep: 1000, logMax: 9000,
    coingecko: 'ethereum', llama: 'ethereum', dexscreener: 'ethereum', gecko: 'eth', etherscan: 1, blockscout: 'https://eth.blockscout.com/api',
    maxWords: 600_000, prefix: '',
  }),
  base: Object.freeze({
    id: 'base', label: 'Base', c: BASE, secPerBlock: 2,
    rpcs: Object.freeze(['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org', 'https://1rpc.io/base']),
    archive: Object.freeze(['https://base.drpc.org', 'https://base-rpc.publicnode.com', 'https://mainnet.base.org']),
    noLogs: Object.freeze([]),
    swapStep: 2000, logMax: 10000,
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
