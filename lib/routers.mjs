// Known swap routers and aggregators, per chain: the one list the `routing` share reads (lib/flowq.mjs).
// A swap whose transaction was sent (tx.to) to one of these came through a wallet, a router or an
// aggregator: order flow that was routed, not sent straight from a searcher's own contract. Public
// contract facts (verify): the probes workflow checks that each address has code on its chain and
// tallies which ones real swaps were sent to. 0x's Settler contracts move with each release, so 0x
// swaps sent to a Settler directly (not through the AllowanceHolder) are missed: the share is a floor.
const R = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([a, n]) => [a.toLowerCase(), n])));

const EVERYWHERE = {
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch v6',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch v5',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  '0x0000000000001ff3684f28c67538d4d072c22734': '0x AllowanceHolder',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW Protocol settlement',
  '0x6a000f20005980200259b80c5102003040001068': 'ParaSwap Augustus v6.2',
  '0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05': 'Odos v3',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router (2023)',
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'PancakeSwap Smart Router',
  '0x1b81d678ffb9c0263b24a97847620c99d213eb14': 'PancakeSwap v3 Router',
};

export const ROUTERS = Object.freeze({
  ethereum: R({
    ...EVERYWHERE,
    '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router (v4)',
    '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap Universal Router (2022)',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap SwapRouter02',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap SwapRouter',
    '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'ParaSwap Augustus v5',
    '0xcf5540fffcdc3d510b18bfca6d2b9987b0772559': 'Odos v2',
    '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swaps',
  }),
  base: R({
    ...EVERYWHERE,
    '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap Universal Router (v4)',
    '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc': 'Uniswap Universal Router (2024)',
    '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap SwapRouter02',
    '0x59c7c832e96d2568bea6db468c1aadcbbda08a52': 'ParaSwap Augustus v5',
    '0x19ceead7105607cd444f5ad10dd51356436095a1': 'Odos v2',
  }),
});

// The router's name for a tx.to on a chain; null for anything else (a searcher, a wallet, a contract we don't know).
export const routerName = (chain, to) => (to == null ? null : ROUTERS[chain]?.[String(to).toLowerCase()] ?? null);
