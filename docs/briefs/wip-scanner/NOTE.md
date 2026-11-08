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

## Read caps (8 Nov 2026, after pools run 42472641065 timed out)
- Every part added after Ethereum's Uniswap list now runs within a time and call cap (`lib/budget.mjs`, values in `lib/chains.mjs` `caps`): Base discovery (backstop 240 s; 72 h events, liquidity events, DexScreener), PancakeSwap on Ethereum, and in the scan Base's steps 1-5 (backstop 150 s; swaps, history, past maps), backfill, contract source (with a breaker after 3 unread in a row), sell tests, transactions (Ethereum too) and the exchange tickers (40 s). A capped part leaves the rest null ("not read").
- Base scans its largest 150 pools by TVL (`caps.top`); the public `chains:` line says how many were left out. The public `caps:` line gives each capped part's seconds and calls and which cap stopped it.
- The scan has a watchdog (18 min, `SCAN_LIMIT_MS`): a stuck pass prints its step timings and stops before the job's 55-min limit cancels it with no log. `READ_CAPS` (JSON) lowers caps for a test or diagnostic run; `CHAINS_OFF=base` switches Base off without a code change.
- The block-clock probe (`base clock` in probes.yml) compares Base block timestamps across nodes and Blockscout.

## Real-data runs (8 Nov 2026)
- Root cause of the slow scan (diag run 42479579644, old code, unsealed): Base's day of swaps (432,000 blocks; only base-rpc.publicnode.com serves logs) ran 41 min without finishing; refused chunks were retried and halved down to 25 blocks. Everything before it was fine (Base maps 64 of 64 in 37 s).
- pools run 42481374210 (877f736): scan green in 11 min and published; Base 62 pools (Uniswap v3 33, v4 21, PancakeSwap v3 8), Ethereum 224 (PancakeSwap v3 4). Base swaps hit the 50 s cap (128 calls of about 132 needed: raised to 80 s in c976d4c); the Base backstop also cut the outputs' Base reads (fixed in c4cc8c1). 6 of the 11 min were Ethereum's daily CoinGecko history refetch (the restored cache was a cancelled run's), not Base.
- The job still shows red: the pool list's Ethereum "v3 cross-check" flake (events 2193 vs lookups 2194, "lookups only 1"), the same as run 42347678644 on 7 Nov, both when Blockscout stopped at block 16,410,882. Pre-existing, not Base. Left to do: find that one pool's creation event (probably the Blockscout→RPC hand-off) and make the check tolerate or re-read it.
- "base volatility check" FAILED in that run (sealed detail): look at it in the sealed log (pool vs market σ on Base, or the history cap's partial reads).
- pools run 42485482298 (c976d4c) was started by the last push and was not read before the wrap-up.
- Base block clock (probes run 42481374149): all 4 Base nodes give the same timestamps at 8 sampled blocks; 2.0000 s a block over the day before block 53,556,126 and 0.2000 s over the day after and the last day; the era table is 1 s early around the switch (block 53,556,126 is stamped 17:59:59 UTC), exact after it. Blockscout's block API did not answer (HTTP errors), so the second source is the four nodes plus the runner's clock (head age 1 s on each).
- Live audit on that data (run 42485506836, page v0.4.4): Chromium 69 of 69 pass; WebKit 69 of 70: "no page errors" failed on 3 "Fetch API cannot load https…" errors in the page's getJson (a fetch that did not load; sections, 160 clicks, overlap and gestures all passed). Re-run it once to tell a transient load failure from one the new data causes.
