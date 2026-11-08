# Scanner WIP: Base, PancakeSwap, flow quality, exchange screen (stopped for the usage cap, 8 Nov 2026)

Public file: no private data. Everything below is pushed and its unit tests pass; what is left is checking it on real data.

## Done (pushed)
- Base (Uniswap v3 and v4, PancakeSwap v3) and PancakeSwap v3 on Ethereum in `scripts/pools.mjs` (writes `out/pools-base.json`) and `scripts/scan.mjs` (steps 1–5 per chain, `lib/chains.mjs`).
- Base's block time changed: 2 s blocks until block 53,556,126 (5 Nov 2026 18:00 UTC), 0.2 s since (432,000 blocks a day). `lib/chains.mjs` eras give exact block ↔ time; the archive probe confirms it (head time within 1 s).
- PancakeSwap fee decode (feeProtocol = two 1/10,000 shares, LPs keep about 66%) confirmed in Actions: our protocol fee ÷ the Swap event's own = 1.0000 on Ethereum and Base.
- Window.flow (retailShare, driftCorr, routing, senders), pool.cex, the cexled and retail lenses, live.json `discovery`; docs/DATA.md updated.
- Base rows stay out of the shared snapshots.json until the live loop runs this code (`MODE=live`), because the pinned loop's Ethereum backfill clock reads every stored row's block number. Re-pinning the loop turns Base history on by itself (live.json `stored`).

## Left to do (next window)
1. Read the `pools` run the push started: the public pool-list log (Base and PancakeSwap counts, recall, events), and the scan's public lines `chains: …` and `flow quality …` (counts only). Check the step timings (Base adds discovery to the 6-hourly list and maps/swaps/backfill/transactions/exchanges to each pass).
2. Sell test through PancakeSwap's Smart Router: if every PancakeSwap pool fails it (`pool checks` tally in the sealed log), switch it off for that venue in `lib/selltest.mjs` SELL_ROUTERS.
3. Contract source on Base: Etherscan v2 (chainid 8453) may refuse a free key, and Blockscout's API answered HTTP errors in the probe. If both stay unread, Base pools stay capped at 40 ("unchecked"): find a source or note it.
4. Only base-rpc.publicnode.com serves Base logs over 1,000+ blocks (probe), so Base log reads take an empty answer without a second node's confirmation (`confirmEmpty: false`).
5. BNB Chain: left for later (sub-second blocks, few free archive nodes), noted in `lib/chains.mjs`.
