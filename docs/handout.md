# Reference handout: the long parts of CLAUDE.md

> Moved here word for word from CLAUDE.md on 1 Nov 2026 to cut what every turn loads. CLAUDE.md keeps the rules, working style, session operations and the privacy playbook. Same privacy rule: no private data in this file.

## Architecture: an always-on system built from GitHub plus one Cloudflare Worker

**The shape.** There are no servers to run.
- **GitHub Actions is the compute:** the "relay" reads the chains and writes JSON.
- **The `gh-pages` branch is both database and host:** the relay commits its data files there, and GitHub Pages serves them next to one static HTML dashboard.
- **The dashboard reads those files and decrypts them in the browser.**
- **A Cloudflare Worker with a once-a-minute cron and a SQLite-backed Durable Object** records anything that needs minute-level resolution, such as fee income.
- **Languages:** plain JavaScript everywhere. The scripts are Node ESM `.mjs` with no npm dependencies. The front end is a single HTML file with inline CSS and JS. One bash script does the commits.
- **Crypto and encoding are written by hand:** `node:crypto` / WebCrypto, BigInt, base58 and an ed25519 on-curve check for Solana PDAs. Nothing to install, no supply chain.

**Keeping it always on (the tricks that mattered)**
1. **GitHub's cron is unreliable.** The schedule said every 15 minutes, but GitHub fired it about twice a day, with gaps of 9–12 hours observed. So one run stays alive and loops:
   - a pass every 6 minutes (`SPACING=360`) for 5 h 20 min (`timeout-minutes: 350`; a job may run up to 6 h);
   - each pass starts with `git fetch && git reset --hard origin/gh-pages`, then `node scripts/fetch-data.mjs && bash scripts/commit-data.sh`;
   - a failed pass never ends the loop (one rate-limited RPC says nothing about the next pass); the job fails only if every pass failed.
2. **Self-handoff.** The job's last step, under `if: always()`, runs `gh workflow run refresh.yml --ref gh-pages` with `GH_TOKEN: ${{ github.token }}`. A `workflow_dispatch` from the workflow's own token is the one event the default token is allowed to start. Needs `permissions: actions: write`.
   - `concurrency: {group: refresh, cancel-in-progress: false}` queues the next run instead of running two at once.
3. **A backup route.** A second workflow on a `*/10` cron refreshes only when the data is stale. Sealed files keep one plain field, their timestamp `t`, so this check can run without the key.
4. **Month-boundary crons** (`52 23 * * *`, `4 0 * * *`) put a reading close to UTC midnight. GitHub may ignore them too, so totals that span the cut are prorated anyway.
5. **Data and code share a branch.**
   - Reset first, generate second, commit third. The opposite order once reverted a hand-repaired cumulative ledger with a 40-minute-old copy.
   - Add each file group separately and tolerantly: one `git add` with a glob that matches nothing aborts the whole commit.
   - If the push loses a race: rebase and push only when everything the remote gained is on a SAFE list (files the pass never reads: the page, docs, workflow files, audit scripts, other jobs' outputs). Otherwise exit and let the next pass regenerate.
   - **Deploy rule that follows from this:** push code to `gh-pages` right after a relay "data refresh" commit, or touch only SAFE-list files. A push to a non-SAFE file mid-pass makes that pass throw its output away, by design.
6. **A minute-level recorder in Cloudflare:**
   - `crons = ["* * * * *"]` hands over to one Durable Object (`new_sqlite_classes`);
   - it keeps 24 h of minutes and serves `GET /m?n=60`; the open dashboard polls `&live=1` every 3 s;
   - a failed read keeps the previous reading, and the next good one spreads its fees evenly over the minutes it covers (no spike beside a hole); gaps over 30 min are dropped, not smeared;
   - deployed from a workflow with one `CLOUDFLARE_API_TOKEN` secret (template "Edit Cloudflare Workers"), and tested in Cloudflare's local runtime in CI first;
   - it is given the derived key, never the passphrase.

**Secrets live only in GitHub Actions secrets:**
- the passphrase;
- the paid Solana RPC URL (optional: it goes in front of the public endpoints);
- an NFT API key;
- the Cloudflare token.

The Claude session never sees their values.

**Workflow set worth copying** (relay plus a ring of read-only checks; public logs show counts and yes/no only):

| Kind | Trigger | Job |
|---|---|---|
| relay | cron + self-dispatch + push to scripts | read the chains, seal, commit (above) |
| backup relay | `*/10` cron | refresh only if the data is stale |
| daily audit | daily cron + push | the live page against the relay: same pass, same numbers |
| click audit | daily cron | press every control at phone and desktop width; every jump lands where it says |
| device audits | push / dispatch | open the live page as an iPhone (WebKit), an Android phone and a laptop |
| leak check | dispatch + after other workflows | search every branch, every file version, commit messages and run logs for any of the deck's wallet addresses |
| prune runs | dispatch | delete finished runs before a cutoff (a public repo's run logs are public) |
| lock rehearsal | push | the whole lock end to end on a throwaway copy with a dummy passphrase |
| census / replay | cron twice a day | heavy market-wide reads (every pool of a token, swaps rebuilt from chain), written sealed |
| probes | push / dispatch | one-off questions answered from public data only (market data in the log, nothing of the owner's) |
| activity audit | push / dispatch with a sealed input | "I just did X": check the dashboard booked it, answered yes/no |

## On-chain facts and decoding (copy-ready)

**EVM: Uniswap v3 positions**
- NonfungiblePositionManager: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` on Ethereum, Arbitrum, Optimism and Polygon; `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` on Base.
- Calls:
  - `positions(uint256)` = `0x99fbab88`: 12 words; liquidity is word 7 (0-based).
  - `ownerOf(uint256)` = `0x6352211e`.
  - Pass a block tag (`'0x'+(block-1).toString(16)`) to read state just before an event.
- Events:
  - `Collect` `0x40d0efd1…8b8f01` (data word 0 = recipient);
  - `IncreaseLiquidity` `0x3067048b…47e35f`;
  - `DecreaseLiquidity` `0x26f6a048…2377b4`;
  - Swap v3 `0xc42079f9…fbcca67` (data words: amount0, amount1, sqrtPriceX96, liquidity, tick; sign-extend the int24 tick from the 256-bit word);
  - Swap v4 `0x40e9cecb…ad7112f`;
  - Swap v2-style `0xd78ad95f…159d822`;
  - ERC-20 Transfer `0xddf252ad…523b3ef`;
  - WETH Withdrawal `0x7fcf532c…5081b65`.
- **A withdrawal made through the Uniswap app on an ETH pair** collects to the position manager itself (recipient = manager or zero). The manager then unwraps WETH and sweeps the other token to the caller, in the same transaction. To see where the tokens went, read the receipt; don't trust the Collect recipient.
- **Fees from fee growth:** fees earned = liquidity × Δ(feeGrowthInside), wrapping at 2^256 (Q128).
  - Collecting, adding or withdrawing changes the owed balance, never the pool's fee growth. So sampling fee growth gives income only: this is the cleanest income signal there is.
- **Tick ↔ price:** tick = round(ln(price / 10^(d0−d1)) / ln 1.0001). A position is in range when `lower ≤ tick < upper` and its liquidity > 0.
- **`eth_getLogs`:** public RPCs cap the block span, so read in chunks: 9,000 blocks on Ethereum, 10,000 elsewhere.
  - A chunk that fails is **unread, never zero events**. Return null for the window, and say so. Getting this wrong showed real activity as "nothing happened".
- **Blocks per hour (for windows):** Ethereum 300 · Arbitrum 14,400 · Base 1,800 · Optimism 1,800 · Polygon 1,700.
- **Public RPCs used, in rotation:**
  - Ethereum: publicnode, drpc, 1rpc, llamarpc, meowrpc, blastapi, mevblocker, flashbots, and Blockscout's `/api/eth-rpc`;
  - each L2's own public endpoint plus publicnode and drpc.
- **Valuing a pool:** pair a reference token (ETH, BTC, a dollar stablecoin), priced from a feed, with the other token valued at the pool's own rate: what the position could be swapped out at.

**Solana: CLMM positions (Raydium CLMM and Orca Whirlpools), no SDK**
- Programs:
  - Raydium CLMM `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`;
  - Orca Whirlpools `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`;
  - Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`;
  - Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`;
  - wSOL `So11111111111111111111111111111111111111112`.
- **Finding positions:** a wallet's token accounts with amount `'1'` and decimals 0, under both token programs, are candidate position NFTs.
  - The position account is the PDA with seeds `['position', nftMint]` under each program.
  - Fetch with `getMultipleAccounts`, 100 at a time, `encoding: base64`, and check `owner`.
- **Raydium personal position (byte offsets):**

| Field | Offset |
|---|---|
| nftMint | 9 |
| poolId | 41 |
| tickLower (i32) | 73 |
| tickUpper (i32) | 77 |
| liquidity (u128) | 81 |
| feeGrowthInsideLast0 (u128) | 97 |
| feeGrowthInsideLast1 (u128) | 113 |
| feesOwed0 (u64) | 129 |
| feesOwed1 (u64) | 137 |

  Fee growth is Q64 in a u128, wrapping at 2^128.
- **Orca position:**

| Field | Offset |
|---|---|
| whirlpool | 8 |
| positionMint | 40 |
| liquidity (u128) | 72 |
| tickLower | 88 |
| tickUpper | 92 |
| feeGrowthCheckpointA (u128) | 96 |
| feeOwedA (u64) | 112 |
| feeGrowthCheckpointB | 120 |
| feeOwedB | 136 |

- **Whirlpool:**

| Field | Offset |
|---|---|
| tickSpacing (u16) | 41 |
| feeRate (u16) | 45 |
| liquidity (u128) | 49 |
| sqrtPriceX64 (u128) | 65 |
| tickCurrent (i32) | 81 |
| mintA | 101 |
| feeGrowthGlobalA | 165 |
| mintB | 181 |
| feeGrowthGlobalB | 245 |

- **Tick arrays:**
  - Orca seeds: `['tick_array', whirlpool, String(startTick)]` (the start tick as a decimal string);
  - Raydium seeds: `['tick_array', poolId, i32 big-endian startTick]`.
- **A PDA without a library:** for bump 255→0, take SHA-256 of seeds‖bump‖programId‖"ProgramDerivedAddress" and accept the first hash that is *not* on the ed25519 curve. The on-curve test is BigInt math.
- **Solana network fees:**
  - base fee 5,000 lamports per signature;
  - priority fee from the p90 of `getRecentPrioritizationFees` over the pools' accounts;
  - a re-range's cost = signatures × base + compute units × priority price.

**Other chains seen:** Sui (fullnode/publicnode/blockvision RPCs; NFT floors from a marketplace API that once changed shape) and Tron (trongrid).

## Data sources (public endpoints the code uses)

| Source | Used for | Notes |
|---|---|---|
| `lite-api.jup.ag/price/v3`, `/tokens/v2/search`, `/swap/v1/quote` | Solana prices, token metadata, executable quotes (routes cover Orca, Raydium, Meteora) | Falls back to DefiLlama when Jupiter is more than 2% off it |
| `coins.llama.fi/prices/current`, `/prices/historical`, `/chart/` · `yields.llama.fi/pools` | Prices on any chain, history, pool APYs | Keys look like `ethereum:0x…`, `solana:<mint>`, `coingecko:<id>` |
| `api-v3.raydium.io/pools/info/ids`, `/pools/info/mint` | Raydium pool info and lists per mint | |
| `api.geckoterminal.com/api/v2`, `api.dexscreener.com/tokens/v1` | Every pool of a token, volumes, cross-checks | Rate-limited: pace it |
| `eth.blockscout.com/api/v2` (+ `/api/eth-rpc`) | Address transactions, token transfers, a transaction's logs; also works as an RPC | Free, no key; paginated |
| `api.paraswap.io/prices` | Executable Ethereum routes for price-gap checks | |
| Exchange public order books and tickers (Coinbase, Kraken, Bybit, KuCoin, Gate, MEXC, Bitget) | Market median, walking a book to a set size, price gaps | Public endpoints, no keys |
| `mempool.space/api/v1/fees/recommended` → `blockstream.info/api/fee-estimates` | Bitcoin fee rates (fastest, half-hour, hour, economy, minimum) | Fill missing rates from the half-hour rate |
| `api.opensea.io/api/v2`, Magic Eden, TradePort | NFT floors | OpenSea needs a key; TradePort changed its API once |
| Solana: `api.mainnet-beta.solana.com`, publicnode, leorpc, solanatracker, tatum (+ an optional paid RPC in front) | All Solana reads | Rotate; public endpoints rate-limit `getProgramAccounts` |

## Deeper details: always-on, on-chain and data sources

**More always-on details**
- **Make `gh-pages` the default branch.** Scheduled workflows and dispatches run from the default branch's workflow files.
- **Watchdog:** a `*/10` cron with `STALE_MIN=20` starts the relay when nothing is running and the data is older than that.
- **Pass time went from 23 min to about 4.5 min:**
  - balances read 5 at a time;
  - slow wallets rotated through a cache (25-min TTL, at most 8 per pass);
  - position lists reused for 6 h while the counts hold;
  - closed, empty positions skipped for 3–4 h.
  - The caches live in a sealed `blockcache` file. A source that fails keeps its last value, flagged stale, never zero.
- **Side jobs run at odd minutes** to dodge the top-of-hour rush (e.g. `41 3 * * *`, `23 3,15 * * *`, `17 5 * * *`).
  - Each writes sealed output and commits with rebase-and-retry.
  - Long ones get a work budget (270 min dispatched, 40 min scheduled), a resumable cursor, and a backfill file promoted once it catches up.
- **Freshness on the page:** read both `raw.githubusercontent.com` and Pages (`?t=` cache-buster, `cache: 'no-store'`) and keep the copy with the newer `t`. The page also reads chains itself and uses relay data only when a read fails or the relay copy is over 10 min old.
- **Recorder details:**
  - Token-protected, `no-store` routes (the token is a slice of the derived key).
  - A heavy job is its own budgeted request: the cron calls `ctx.waitUntil(stub.fetch('https://pulse/mine'))`.
  - State is versioned (`v!==2` → reset) and pruned on every write.
  - A second Worker cron never reached the Durable Object; the fix was to run that job from the minute cron on even minutes, with a fallback and a run record.
  - Local e2e: `wrangler dev` plus `/__scheduled?cron=…`.
  - Mask the Cloudflare account ID in deploy logs with `::add-mask::`.

**More on-chain facts (all used by the old code unless marked)**
- **Uniswap v3 Factory:** `0x1F98431c8aD98523631AE4a59f267346ea31F984` (Ethereum).
- **Uniswap v4 (Ethereum):** PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`, StateView `0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227`.
- **Selectors:**
  - pools: `slot0()` `0x3850c7bd`, `liquidity()` `0x1a686502`;
  - factory: `getPool(address,address,uint24)` `0x1698ee82`;
  - StateView: `getSlot0(bytes32)` `0xc815641c`, `getLiquidity(bytes32)` `0xfa6793d5`;
  - NPM: `collect` `0xfc6f7865`, `decreaseLiquidity` `0x0c49ccbe`, `multicall` `0xac9650d8`, `unwrapWETH9` `0x49404b7c`, `sweepToken` `0xdf2ab5bb`.
  - Decode a multicall's inner selectors to tell a harvest from a re-range.
- **More topics:**
  - v3 pool `Mint` `0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde`;
  - v3 pool `Burn` `0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c`;
  - v4 `ModifyLiquidity` `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec` (topic1 = PoolId);
  - v4 `Initialize` `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438` *(verify)*;
  - v3 `PoolCreated` `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118` *(verify)*.
  - Full values of the shorter ones: Collect `0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01`, IncreaseLiquidity `0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f`, DecreaseLiquidity `0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4`, Swap v3 `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`, Swap v4 `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f`, Swap v2 `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`, Transfer `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`, WETH Withdrawal `0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65`.
- **v4 Swap data:** amount0, amount1, sqrtPriceX96, liquidity, tick, and **fee as word 5**. Reading word 6 was a real bug. v4 pools can charge a protocolFee on top of the lpFee.
- **v3 protocol fee:** `slot0.feeProtocol` packs token0's divisor in the low nibble (`fp%16`) and token1's in the high nibble (`fp>>4`).
  - The protocol takes 1/N, so the LP keeps 1 − 1/N. A value of `0x66` means N = 6, so LPs keep 83.3%.
  - 0 means the switch is off.
- **ERC-20 vs ERC-721 Transfer** share topic0: ERC-20 has 3 topics, ERC-721 has 4 (tokenId indexed). Pad before reading `topics[3]`.
- **Archive reads:**
  - Test archive support first (e.g. WETH `totalSupply` at an old block).
  - For `positions(id)` at a block, a revert means the position didn't exist yet, while silence or an error means abort.
- **The v3 LP book (who holds liquidity at the price):** the basis for spotting one-sided or L-shaped liquidity.
  1. `Mint` logs on the pool with topic1 = the NPM.
  2. In each receipt, `IncreaseLiquidity` gives the tokenIds.
  3. Call `positions()` and keep those matching token0/token1/fee.
  4. Keep the ones in range (tickLower ≤ tick < tickUpper); `ownerOf` gives the holder.
  5. Completeness check: Σ in-range L = pool `liquidity()`.
  - It needed reason codes, adaptive block ranges, a 12-min budget and concurrency 6.
- **Gas units, measured:**

| Action | Cost |
|---|---|
| v3 NPM collect | ≈166–183k gas |
| re-range (collect + decrease + mint) | ≈612–655k gas |
| BTC send (1 in / 2 out SegWit) | ≈141 vB |
| Raydium transaction | requests 600k CU |
| Solana re-range | about 3 signatures / 1.2M CU |

  EVM cost = gas × gwei × ETH-USD / 1e9. `eth_gasPrice` was within a few % of what blocks actually paid.

**Raydium CLMM, deeper** (offsets used in the code; Anchor accounts start with an 8-byte discriminator)

| Account | Field | Offset |
|---|---|---|
| PoolState | amm_config | 9 |
| | token_mint_0 | 73 |
| | token_mint_1 | 105 |
| | liquidity (u128) | 237 |
| | sqrt_price_x64 (u128) | 253 |
| | tick_current (i32) | 269 |
| AmmConfig | protocol_fee_rate (u32) | 43 |
| | fund_fee_rate (u32) | 53 |

- PoolState also has mint decimals at 233/234 and tick_spacing (u16) at 235 *(verify)*.
- AmmConfig also has trade_fee_rate (u32) at 47 *(verify)*.
- LP keeps 1 − (protocol + fund)/1e6 of the trade fee: 84% at the time.
- **Every position in a pool:** `getProgramAccounts(CLMM, {filters: [{dataSize: 281}, {memcmp: {offset: 41, bytes: poolId}}]})` on PersonalPositionState.
- **Anchor events** are base64 in "Program data:" log lines; the discriminator = sha256("event:Name")[0..8]:

| Event | Discriminator |
|---|---|
| SwapEvent | `40c6cde8260871e2` |
| LiquidityChangeEvent | `7ef0afce9e58996b` |
| IncreaseLiquidityEvent | `314f69d420221e54` |
| DecreaseLiquidityEvent | `3ade563a44325538` |
| CreatePersonalPositionEvent | `641e57f9c4df9ace` |

- **SwapEvent layout:**

| Field | Offset |
|---|---|
| pool | 8–40 |
| amount_0 (u64) | 136 |
| amount_1 (u64) | 152 |
| zero_for_one | 168 |
| sqrt_price_x64 (u128) | 169 |
| liquidity (u128) | 185 |
| tick (i32) | 201 |

  205 bytes (221 in newer versions). The event carries the active liquidity, so per-swap share = your in-range L ÷ event liquidity.
- **CreatePersonalPositionEvent:** owner at 72–104, tick_lower at 104, tick_upper at 108, liquidity at 112. Opening a position also emits an increase in the same transaction: dedupe.
- **Transaction history:**
  - `getSignaturesForAddress` in batches of 200 with a cursor `{sig, slot, t}`, then `getTransaction` with `maxSupportedTransactionVersion: 0`.
  - About ⅓ of a busy pool's transactions had failed: check `meta.err`.
  - Re-pass unserved ones; count log-truncated ones.
  - Free RPCs gave about 0.6 `getTransaction`/s.
- **A position's liquidity at a past date:** back-compute it from the position PDA's own transaction history.
- **A mint's holders:** `getTokenLargestAccounts` plus jsonParsed `getAccountInfo`.
- **Priority fees:** `getRecentPrioritizationFees([poolAccount])` covers about 150 slots. Take the p90 and require ≥ 20 values. **Without account keys it returned 0 in 100% of slots: always pass the pool's accounts.**

**Data-source quirks learned the hard way**
- **Public Ethereum RPCs (Oct 2026):**
  - publicnode needs a token for archive data;
  - drpc's free plan allows at most 10,000 blocks per getLogs;
  - llamarpc returned 403 and 1rpc 503 at times;
  - Blockscout's `/api/eth-rpc` served archive calls.
  - Order that worked: Blockscout eth-rpc → drpc → publicnode → 1rpc → llamarpc. Drop a node after 3 refusals with nothing served.
- **Blockscout:**
  - Etherscan-style `module=logs` (paginate by advancing `fromBlock`), `/api/v2/transactions/{hash}`, v2 address logs and transactions.
  - topic1 filters are fast. Address+topic0 over long ranges is refused, and address-only queries on busy pools time out: halve the range adaptively, using about 25k-block windows.
- **Solana public RPCs:** "Too many requests" is routine.
  - Retry 5× at 1/2/4/8/16 s on null or `/too many|rate|429|busy/`.
  - Concurrency 2 (4 with a keyed RPC).
  - Classify errors as request limit, rate limit, timeout or RPC error, and remember the best endpoint per method.
  - Holder lookups and `getProgramAccounts` need a private RPC (free tiers exist).
- **DefiLlama:**
  - `coins.llama.fi/prices/current/{ids}`: batches of 40; returns price, timestamp, confidence. Trust < 1 h old and confidence ≥ 0.9.
  - History: `/chart/{ids}?start=…&span≤365&period=1d&searchWidth=600`. It has missing days: bridge gaps of ≤ 7 days.
  - IDs: `coingecko:<id>`, `ethereum:0x…`, `solana:<mint>` (**mints are case-sensitive**), `sui:<type>`. Polygon's native token is `coingecko:polygon-ecosystem-token`.
- **Jupiter:** thin tokens echo the last trade, even your own. Apply the 2% guard against DefiLlama at every point a Solana price enters the system.
- **GeckoTerminal:** token pools and daily OHLCV (`limit=130`); keep calls ≥ 2.3 s apart.
- **DexScreener:** cross-check, and use the busiest pool above a liquidity floor as a market reference. Aggregator pool lists include empty pools, so cross-check TVL with the DEX's own API, or market shares come out tens of times too small.
- **Raydium API v3:** TVL plus day/week/month volume and fees per pool.
- **Exchange books (public):**
  - Walk levels to the trade size, minus the taker fee.
  - Retry a 429 once after about 700 ms. Coinbase has an alternate book endpoint (`/api/v3/brokerage/market/product_book`) for 429s.
  - Some exchanges geo-block GitHub's US runners: remember the block for 1 h instead of hammering.
- **ParaSwap:** exact-in quotes with `gasCostUSD`. **Jupiter quotes** already include pool fees and slippage, and route through Orca, Raydium and Meteora.
- **Sui:** the fullnode's JSON-RPC went away, then BlockVision, then publicnode. A marketplace without an API was read by capturing its site's JSON in a headless browser once a day. That's fragile, so make it fail visibly.
- **Bitcoin fees:** mempool.space, else blockstream (keyed by block target).

## Accounting rules for LP fees, positions and portfolios

**What counts as earned**
- **Earned** = fees other traders paid into your in-range liquidity, after the protocol's cut. The protocol cut is a cost: read it, never assume it.
- **Unclaimed** = exactly what is claimable on-chain now. Label it as such. It includes fees from your own swaps.
- **Earned, APR and P&L exclude your own swaps.** The fee your swap pays into your own pool comes back to you, and that is not income.
  - Detect own swaps across every tracked wallet.
  - Keep them as "YOU" rows: shown, never counted.
  - Track them `pending → done`; a position's fee total may fall only through these deductions.
- **Separating bots' fees from yours:**
  - taken out = fees seen landing in the minute record − rise in the booked total;
  - other traders' fees in the same window cancel out;
  - measure only between quiet edges: 10 min with no fees and every minute actually read;
  - a minute counts as read only when its coverage ≥ the number of positions. Unread minutes were once wrongly counted as quiet.
- **Bot-reaction tags:** mark trades within 5 min after an own swap in the same token. A 15-min window was noise.

**Invariants an audit can enforce**
- Per position, collected + uncollected never steps down.
- Month-to-date never steps down.
- A harvest moves unclaimed to collected, and lifetime stays the same.
- A withdrawal also collects fees.
- A deposit is not credited with earlier fees.

**Transfers and wrapped tokens**
- Transfers between your own wallets are neutral.
- Sending to your own exchange deposit address is a transfer; anything else is spending.
- Wrapped native = native: merge WETH/WSOL before any index.
- The same ticker on two chains is two tokens. Each chain has its own native token (Polygon's is POL).

**Steps in the history**
- A newly tracked wallet or category is a marked step on the chart, not a gain.
- The monthly bridge (pools / costs / price change on starting holdings / money in and out, with the rest as the remainder) must always sum.

**Verifying an action the user reports** (harvest, partial withdrawal, swap). Check it on the position's own chain; the answer is yes/no only.
1. The events happened today (Collect / Increase / Decrease, read in chunks).
2. The booked fee total never fell.
3. The relay read it after the transaction.
4. After a harvest: unclaimed ≈ 0% of lifetime.
5. After a withdrawal:
   - liquidity is X% of what it was (read `positions()` at the block before);
   - the dashboard shows that liquidity;
   - the tokens reached a wallet: follow the receipt through the position manager;
   - the portfolio total didn't dip by more than 2% across it, skipping stale readings.
6. Token arrivals:
   - a Collect topic in the same transaction means a payout from a position, not a swap;
   - otherwise classify the venue: own pool / another v3 pool / v4 / v2-style / aggregator or filled order.

**Valuation**
- **EVM pools:** pair a reference token, priced by a feed, with the other token valued at the pool's own rate.
- **Solana pools:** value at the guarded market price, and keep the pool's own rate beside it as a "pool gap".
- **Off-market pools:**
  - cost = (token amounts at the market price − at the pool price) × market prices;
  - flag only if cost < −$1, or if the position is in range and the cost is unknown;
  - flagging on the price gap alone was noise for one-sided ranges resting at an edge.
- **Unknown price:**
  - never $0; a marketplace floor of 0 means "no market price";
  - LP receipt NFTs are listed, never valued (Uniswap V3/V4, PancakeSwap V3, SushiSwap V3 managers plus a name regex);
  - never reprice LP legs from per-raw-unit reference prices: that once drew a 100× peak; reject unit ratios above 20×.
- **A holding that was ≥ 2% of the previous total and comes back unpriced:** keep the previous total, marked stale. Otherwise one pass draws a fake crash.
- **Missing days:**
  - Days before a source began are null.
  - A pool without a figure is dropped from both "yours" and "total", but only while it is under 5% of that day's total; otherwise the whole day is null.
  - A window needs at least half its days.

## Analytics worth reusing in a scanner

- **Volume without an indexer:**
  - fees accrue in the **input** token, so the side whose fee growth rose tells the direction;
  - gross volume ≈ fee ÷ LP fee rate;
  - only net flow moves price.
  - Liquidity isn't consumed: round trips let a pool trade many times its TVL a day, but it can't absorb a one-way sale larger than the opposite in-range reserve.
- **Arbitrage band:** the same pair at different fee tiers or venues stays within about one round-trip fee of each other. Thin high-fee pools can sit off market for long stretches.
- **Routing competition:** turnover (volume ÷ TVL) by pool. A deep new v4 pool took most of a pair's flow within days.
- **"On the market" rule:** count a pool's price on a day only if it traded within 10% of the liquidity-weighted market price that day. Never apply today's filter retroactively.
- **Share of fees:**
  - snapshot share = your in-range L ÷ pool L (null when the pool L is 0);
  - per swap (replay) = ½(pre + post) of your in-range L ÷ the event's active L;
  - fee- and time-weighted shares per day, time in range, coverage.
  - Multi-pool share: a day counts only when every pool has a reading. Cap at 100% and name the record that ran over; a simulated sole-LP test must read exactly 100%.
  - Label the scope: a share of one pool is not a share of a token's LP fees across venues.
- **"Why fees moved"** (a log decomposition whose terms multiply to the change):
  - fees = token volume (all pools) × the pool's routing share × your in-range L share × LP fee rate;
  - the terms are MARKET, ROUTING, OTHER LPs, YOU, REST;
  - default to week vs week (last 7 full UTC days vs the 7 before), because days swing 5–20×;
  - lead with the biggest cause; show a second only if it's ≥ ⅓ as big; drop anything under 3%; mark "Thin" under about 10 swaps;
  - one basis per comparison: fee counters > swap replay > share estimate > pool only;
  - start recording early: share history exists only from day one, while public volume can be back-filled.
- **Swap replay** (rebuild trading from chain records, check it against the live counters):
  - trust a pool only when share agrees within 0.1% and fees within 3%;
  - there are three reconciliation layers:
    - public vs public: index vs DEX API, fees ÷ volume = tier, LP book = 100%;
    - yours vs the pool;
    - your yield vs the pool's.
- **Range analytics:**
  - σ = daily log-return volatility; over 7 days, s = σ√7;
  - P(stay in range 7 days) = Φ(ln(up/p)/s) − Φ(−ln(p/lo)/s);
  - suggested ranges p·e^(±k·s) with k = 0.68 (tight), 1.282 (balanced), 2.0 (wide).
- **Momentum levels:**
  - build a price-only index: yesterday's holdings × today's price change, so deposits and withdrawals never move it;
  - z = ln(I_d / I_{d−n}) / (σ√n) for n ∈ {3, 6, 10}, with σ over days d−32…d−3 (≥ 20 values, floor 0.004);
  - level = sign × min(10, ⌊|z| / 0.5⌋), on a two-sided −10…+10 scale (4 levels were too coarse);
  - a run opens at |level| ≥ 5 and ends 5% off its extreme;
  - a level must hold for 2 refreshes before it shows; "since you last looked ▲5 → ▲6".
- **Price hygiene:**
  - Calibrate an outside series to your own records by the median ratio.
  - Hampel-style filter: flag a read 12% off the median of the ±3 around it (≥ 4 neighbours).
  - Replace a spike only if both neighbours disagree with it by more than 1.5× while agreeing with each other within 1.25×.
  - Bridge gaps of ≤ 7 days.
  - Chain a migrated token contract onto the old one by the median ratio over their overlap.
  - Reconcile from the git history of the data branch (`fetch-depth: 0`) to rebuild totals, using an hourly median over ±36 h as the reference.
- **Gas, "is now a good time?":**
  - ETH gas has a daily rhythm about 6× from trough to peak.
  - "Usual" = median of the same local hour over 14 days (≥ 6 readings, else the overall median).
  - Cheapest window = the longest run within 1.3× of the lowest hour.
  - A spike is ≥ 10× usual.
  - Words: WAIT when x ≥ 10 and cost ≥ $5; PRICEY when x ≥ 3 and cost ≥ $1; else OK.
  - Show the cost of the real action (re-range, harvest, send) in dollars on a log dial from $0.01 to $30.
  - Solana: compare with the base fee (signatures only) and the share of readings that needed a priority fee.
  - Bitcoin: a typical send at the half-hour rate.
- **Price-gap engine:**
  - qty = size / median mid;
  - profit = (size / buyPx) · sellPx − size − gas, with DEX quotes in raw units;
  - alert only after a gap has held ≥ 10 min on readings < 8 min old;
  - a 429 is a missed reading, never a closed gap (close only after 2 misses).

## Testing, audits and verification

**Local, before every deploy (Playwright in the session)**
- Serve a fixture site with a fresh `t`, or inject demo data (`demoPositions()`) when there is none.
- Widths 360/375/390/430 and 1300/1440/1500+.
- Assert:
  - no horizontal scroll;
  - every label on screen;
  - no `NaN`;
  - no page errors;
  - folds measured about 900 ms after they open.
- Take element screenshots and actually look at them.
- Mockup screenshots use made-up data and a "MOCKUP · MADE-UP NUMBERS" ribbon.
- Wait about 8 s after load for async renders. Dispatch hover and tap events for tooltips.
- GIFs, when motion matters: Playwright frames + `gifenc` + `pngjs`.

**Live audits (Actions, after every build; report "0 fail / 0 warn")**

| Audit | What it checks |
|---|---|
| Daily | Every panel vs the relay data, from the *same pass*: read raw and Pages, take the newer, run the page's own scan with the relay timestamp matched. Identities hold: causes multiply to the change, parts add up, total − without = pools ≤ fee ledger. Freshness, no one-point dips, no horizontal scroll. |
| Click | `addInitScript` tags handlers and stubs `window.open` and the clipboard. Press every control at phone and desktop width, diff the DOM mutations against a baseline, re-find controls by signature, skip DANGER controls. Every jump lands with its heading under the sticky nav. Every link's domain, status and `target=_blank`. |
| Device | WebKit as an iPhone 15, a Pixel 7, a 1440 laptop, reduced motion. Font ≥ 12 px, buttons ≥ 28 px, labels ≥ 8 px, taps give tooltips. |
| Track | Every price the page shows vs the market now (Coinbase, the busiest DEX pool above a liquidity floor, DefiLlama), within 2%. Gauges agree with range bars. Dial needle angle read back from the SVG (`p = 1 − atan2(y1−y2, x2−x1)/π`). Models recomputed independently (e.g. the hour-of-day gas model). External rates within sane bounds (BTC rate within `min×0.5 … fast×2`). |
| Leak | No private value in any branch, file version, commit message or run log. |
| Activity | "I just did X" verified with yes/no lines (see Accounting). |

**Make the audits trustworthy**
- **Plant faults** and assert each one is caught: the gas audit had 13 planted faults. Reload the page between fault scenarios so monkeypatches don't leak into each other.
- **A new check must fail on the old build and pass on the new one.**
- **Unit tests run first in each workflow** (e.g. 31 momentum checks, 16 own-swap checks on made-up days). A broken check never reads real data.
- **Price-gap engine tests:**
  - faked fetches (OK, 403 remembered, 429 fallback, unpriced miss);
  - independent re-reads of each venue (fresh < 5 min; within ±25% of the median);
  - a 40-round soak test;
  - a "readings by trigger" counter.
- **Regression cases shaped like each bug you fix.**
- **After a deploy, wait for the "pages build and deployment" run before auditing,** or you test the old build. Then confirm the page's `BUILD` constant.
- **Jump races:** a "settle" routine keeps re-aligning the scroll for about 4 s after a jump and is cancelled only by real input. Audits dispatch `new WheelEvent('wheel')` before `scrollIntoView`.

## GitHub Actions / Pages gotchas

- **Dispatch 404s for a workflow that exists only on a non-default branch** until it has run once. Give dev-only workflows a `push` trigger with path filters.
- **Scheduled workflows run from the default branch.**
- **A secret added while a job is running is invisible to that job.** Restart it after the current pass.
- **Jobs are capped at 6 h.** Use bounded loops with a work budget and a resumable cursor.
- **Runs can't start other runs**, except `workflow_dispatch` (or `repository_dispatch`) called with the default `GITHUB_TOKEN`. That exception is what makes self-restarting loops possible.
- **Pages lags commits by minutes and sometimes gets stuck;** a new push cancels a stuck deploy. Page-side, read raw.githubusercontent too.
- **Filtered run listings showed about half the real total:** page through everything. Mass deletes hit rate limits, so run them inside Actions.
- **Workflow inputs and `env` are printed in the job log.** Mask anything sensitive with `::add-mask::` before it goes into `GITHUB_ENV`, or better, never pass it.
- **A relay pass that started seconds before a code push is discarded** (about a 15-min gap in data). That is by design.
- **On a public repo, run logs are public:** prune old runs with a job, and delete a leaky log at once (then confirm it returns 404).

## Bugs hit → root cause → fix

**Data and chain reads**
- Activity looked like "nothing happened" → a failed `getLogs` chunk was counted as 0 events, and every position was assumed to be on mainnet → use each chain's own contract, and return `null` ("could not read") when any chunk fails.
- "The withdrawn tokens never reached your wallet" (false alarm) → the Collect went to the position manager, which unwrapped the ETH and swept both tokens on → follow the receipt (Transfers *from* the manager + WETH `Withdrawal(src=manager)` + a caller who is yours).
- Position payouts were counted as swaps → check for a Collect topic in the same transaction.
- The LP fee cut read as 100% → a failed `eth_call` defaulted to 1 → call several nodes, read the real `feeProtocol`, never default.
- A v4 fee value was wrong → it was read from data word 6 → the fee is word 5.
- An audit missed v4 swaps and ERC-20 transfers → it didn't count v4 and didn't pad topics → count v4, pad topics.
- A program constant was guessed wrong → found it via `getProgramAccounts`; PDA plus a fallback, carrying the last value forward marked stale.
- The own-swap list stayed empty → a cached source lacked new fields, so the scan skipped silently, and one failure threw away everything found → a budgeted, resumable request (18 tries per chain), keep partial finds, versioned state, diagnostics and an audit line.

**Prices and history**
- A fake portfolio crash → one token came back unpriced for one pass. Fixes:
  - relay: fall back to the LP-implied price, and hold the total when a holding ≥ 2% comes back unpriced;
  - reconcile: an "unpriced" correction;
  - page: a misread filter;
  - audit: a dip check.
- A Jupiter outlier was shown → a thin token echoed its last trade → the DefiLlama 2% guard at every entry point.
- 40 misread prices on the first live run of a long backtest → calibrate by the median ratio, plus the neighbour spike rule.
- A long test was truncated → single-day gaps in the price history → bridge gaps of ≤ 7 days.
- Share history overstated past months → high-fee pools were counted on days they traded off market → the per-day 10% market rule, recomputed backwards.
- A sole LP was shown with only part of the fees → a pool whose share history started late counted in "total" but not in "yours" → per-day completeness rules.

**Pipeline and operations**
- Cumulative files were reverted by an old copy → snapshot → reset → copy-back overwrote newer state → reset first, generate second, commit third.
- Data went an hour stale twice in one evening → code pushes and another job's frequent pushes made relay passes discard their output → the SAFE list, and deploy timing right after a data commit.
- Momentum went stale → the cron was unreliable → a self-restarting loop.
- The gap audit failed every run → the recorder's log wasn't pruned on quiet readings → prune on every write.
- An audit went red right after a deploy → Pages wasn't finished → wait for the pages run.
- The audit read an older pass than the page → read both sources and match the relay timestamp.
- A Coinbase 429 closed an open price gap → count an unpriced route as a miss, close only after 2, and use the fallback endpoint.

**UI**
- The click audit said controls were "covered" → the scroll-settle race → dispatch a wheel event first.
- A dropdown was hidden under the nav → `header, main, footer {z-index: 1}` creates stacking contexts → raise the header while the box is open (`header.x-open {z-index: 60}`).
- `display` beat `[hidden]` → add `[hidden]{display:none}`.
- A fold stuck at 8 px on WebKit → no margin in the `0fr` row, `min-height: 0`, a snap class.
- SVG lines ate taps → `svg :not(.hit) {pointer-events: none}`.
- The page opened mid-page → `history.scrollRestoration = 'manual'`, hold at the top until touch, wheel or key.
- A gauge disagreed with the range bar → one was linear, the other log → one shared log fraction.
- The gas chart was "too flat" → one spike stretched the scale, and "usual" ignored the hour of day → an hour-aware usual plus a forward 24 h strip, then dials.
- Labels were misread ("FEES" taken as earnings, "FLOOR" as an NFT floor) → "RE-RANGE GAS" with OK / PRICEY / WAIT.

## Design lessons from the dashboard

**Worked**
- **Single-file page:** a `state` object, render functions per panel, a `BUILD` constant shown on the page, times through `Intl.DateTimeFormat` in the owner's time zone.
- **Strips:**
  - a thin split bar plus one line of per-token amounts that sums exactly to its column, hidden when empty;
  - "book + rows" lists: a header total and split bar, then rows with a sparkline, value and tags.
- **Pro chart:**
  - tall aspect;
  - scale fitted to the period's high and low, so moves look their real size;
  - big value, change, high/low;
  - 7D / 30D / ALL;
  - ↗ opens its own window;
  - right axis, dashed start line, last-value tag, crosshair;
  - a "counted from here" marker instead of a fake gain;
  - a RECONCILED badge.
- **Contribution view:** total + a dashed "without X" line + the shaded gap, with a small aligned pane on its own scale and a shared crosshair.
- **Odometer numbers:**
  - roll from the last-seen value in ≤ 1.5 s;
  - numbers below the fold wait, marked with a dot;
  - fade under reduced motion;
  - the DOM text stays the plain number.
- **Navigation:**
  - floating TOP / LIVE / feature buttons that hide when their target is visible;
  - jumps land with the heading just under the sticky nav (not centred);
  - collapsible, draggable panels, remembered per device.
- **Insight one-liners:** biggest cause first, with cause tags. "Thin" or "not read" instead of guessing. High-level card first, detail folded.
- **Signals:** two-sided −10…+10 scale; a dial against a generic reference ("last top", not a date); stale badges ("· 3.2 h old").
- **Own swaps shown, not hidden:** violet YOU rows, never income, price before and after, "⟲ 40 s after your swap" on the bots' follow-up trades.
- **Minimal-space indicators:**
  - the final gas design was a tiny dial *inside* an existing price tile (28×16 px; smaller under 400 px);
  - log scale with the arc lit by band;
  - the tile's top edge tinted amber/red;
  - tap for a small box with the figures; tap again, an outside click or Escape closes it.

**Rejected or fixed**
- A big number that isn't what its label says ("■ 0%" under YOUR SHARE when it was the change) → "■ unchanged" + "X% last week → Y% this week".
- Words that clash with domain meanings (see the label bug above). Spell the scope out: "LP VALUE + UNCLAIMED FEES".
- Nudging the user to wait to save cents → say "even the peak is under $1".
- Stuck or flat needles: bands from another era, weekly averages that ignore the daily rhythm, spikes squashing sparklines, linear gauges on wide ranges.
- Full-width tiles for small facts → shrink them into existing tiles.
- Fake or back-filled data, unknown prices as $0, valuing LP receipt NFTs, and metrics that mean nothing until weeks of data exist (prefer metrics that are meaningful from day one).
- A Telegram bot, declined. Browser notifications fire only while the page is open.

## Starter plan for the pool / liquidity scanner (what to reuse, in order)

These are recommendations built on what worked. Agree scope with the user first: mockups before building.

1. **Repo and hosting.**
   - Same shape as before: a dev branch for code, `gh-pages` for the published page and data.
   - Market-wide pool data is public, so it can be published plain.
   - Anything that reveals the user — watchlists, their wallets or positions, the thresholds they trade on — gets the lock (AES-GCM files plus a sealed inbox) from day one.
   - Retrofitting encryption later meant a history wipe: don't repeat that.
2. **Always-on scanning.**
   - A looping Actions job (passes every few minutes, about 5 h 20 min per run, then it starts the next run itself), plus a staleness badge on the page.
   - A Cloudflare Durable Object on a once-a-minute cron for anything minute-level: fee growth, price gaps, new pools.
   - Never rely on GitHub's cron alone.
3. **Pool discovery.**
   - EVM:
     - v3 `PoolCreated` logs from each factory;
     - v4 `Initialize` logs on the PoolManager;
     - v2 `PairCreated`;
     - plus GeckoTerminal/DexScreener lists, cross-checked: aggregator lists include empty pools.
   - Solana:
     - the Raydium API (`/pools/info/mint`, `/pools/info/ids`);
     - Orca whirlpools, either through their API (verify it before relying on it) or `getProgramAccounts` filtered by data size and memcmp on the mints. Public RPCs throttle this, so use a private RPC secret.
4. **Pool state.**
   - v3: `slot0()` (`0x3850c7bd`) and `liquidity()`.
   - v4: StateView `getSlot0` / `getLiquidity` by poolId.
   - Whirlpool: tickCurrent at offset 81, sqrtPriceX64 at 65, liquidity at 49.
   - Raydium CLMM: read the pool account (check the layout against the official IDL).
   - Always read `feeProtocol` / `protocolFee`; never assume the LP gets the full fee tier.
5. **Liquidity shape (the "L-shaped / funny-shaped" part).**
   - Rebuild active liquidity per tick:
     - v3: walk the initialized ticks (`tickBitmap(int16)`, then `ticks(int24)` → liquidityNet) out from the current tick, adding liquidityNet when crossing up and subtracting it when crossing down;
     - Orca/Raydium: read the tick-array PDAs around the current tick (seeds above).
   - From the curve:
     - depth within ±x% of price;
     - one-sidedness (liquidity mass above vs below the price);
     - walls and gaps;
     - concentration (share of liquidity in the N densest ticks);
     - how many LPs hold the price (position-level sum of in-range L = pool L, as a completeness check).
   - The old project never built the depth chart (the user liked the mockup). This is standard Uniswap v3 mechanics: verify against a known pool before trusting it.
6. **Volume and yield without an indexer.**
   - Fee growth per token gives fees, and fees ÷ LP fee rate gives gross volume. The side whose fee grew is the input side.
   - Turnover (volume ÷ TVL) shows routing competition.
   - The same pair at different fee tiers stays within roughly one round-trip fee of each other.
   - Count a pool's price only on days it traded within 10% of market.
7. **Prices.**
   - DefiLlama current/historical (batches of 40; trust < 1 h old and confidence ≥ 0.9). Jupiter for Solana, but switch to DefiLlama when they differ by more than 2%.
   - Coinbase/the exchanges' books for majors; ParaSwap and Jupiter quotes for executable prices.
   - Every number must come from a real reading: missing shows "—", never 0.
8. **Verification before showing anything.**
   - Three-way cross-checks (on-chain vs the DEX's API vs an aggregator).
   - Audits that print only counts and yes/no.
   - Fault injection into the audits themselves.
   - Playwright at 360–430 px and laptop widths after every deploy.
   - Wait for the Pages deploy run to finish before auditing.

## Reusable snippets (condensed from the working code; no dependencies)

```js
// 1) JSON with a timeout; try sources in order, keep the last error (one error per source chain, not one per try)
async function getJson(url, timeout=15000, init){ const c=new AbortController(), t=setTimeout(()=>c.abort(), timeout);
  try{ const r=await fetch(url,{...init, signal:c.signal}); if(!r.ok) throw new Error('HTTP '+r.status); return await r.json(); }
  finally{ clearTimeout(t); } }
async function firstGood(tries){ let last; for(const f of tries){ try{ const v=await f(); if(v!=null) return v; }catch(e){ last=e; } } throw last||new Error('no answer'); }
```

```js
// 2) JSON-RPC across several public endpoints: first real result wins; a failure is null, NEVER a default value
async function rpc(urls, method, params){
  for(const u of urls){ try{ const r=await getJson(u,12000,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); if(r&&r.result!==undefined&&!r.error) return r.result; }catch(e){} }
  return null; }
```

```js
// 3) eth_getLogs in chunks (9000 blocks on Ethereum, 10000 on L2s). One unread chunk makes the whole window unread.
async function logsIn(urls, filter, from, to, step){ const out=[];
  for(let a=from; a<=to; a+=step){
    const r=await rpc(urls,'eth_getLogs',[{...filter, fromBlock:'0x'+a.toString(16), toBlock:'0x'+Math.min(to,a+step-1).toString(16)}]);
    if(!Array.isArray(r)) return null;          // say "could not read", never "0 events"
    out.push(...r); }
  return out; }
const topicOf=id=>'0x'+BigInt(id).toString(16).padStart(64,'0');   // a uint256 tokenId as an indexed topic
```

```js
// 4) Concurrency limiter: run fn over items with at most n in flight, results in order
const pool=async(items,n,fn)=>{ const res=new Array(items.length); let i=0;
  await Promise.all(Array.from({length:Math.min(n,items.length)}, async()=>{ while(i<items.length){ const k=i++; res[k]=await fn(items[k]); } }));
  return res; };
```

```js
// 5) Little-endian readers for Solana account data (Buffer/Uint8Array), then e.g. Raydium position liquidity = leU128(b,81)
const leU16=(b,o)=>b[o]|(b[o+1]<<8);
const leI32=(b,o)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24));             // JS bit ops give a signed 32-bit result
const leU64=(b,o)=>{ let n=0n; for(let i=7;i>=0;i--) n=(n<<8n)|BigInt(b[o+i]); return n; };
const leU128=(b,o)=>{ let n=0n; for(let i=15;i>=0;i--) n=(n<<8n)|BigInt(b[o+i]); return n; };
// PDA: for bump 255..0, h = sha256(seeds‖[bump]‖programId‖"ProgramDerivedAddress"); the first h NOT on the ed25519 curve is the address.
// (The old code did the on-curve test in ~15 lines of BigInt; with dependencies allowed, use PublicKey.findProgramAddressSync.)
```

```js
// 6) Uniswap v3/v4 and CLMM math: tick <-> price (token1 per token0, adjusted for decimals), in range, amounts held by L
const tickToPrice=(tick,d0,d1)=>Math.pow(1.0001,tick)*10**(d0-d1);
const priceToTick=(p,d0,d1)=>Math.round(Math.log(p/10**(d0-d1))/Math.log(1.0001));
const inRange=(tick,lo,hi,L)=>lo<=tick && tick<hi && L>0n;
// amounts of liquidity L in [pa,pb] at price p (raw units; sqrt of raw prices): standard v3 formulas
function amounts(L,p,pa,pb){ const s=Math.sqrt(p), a=Math.sqrt(pa), b=Math.sqrt(pb), l=Number(L);
  if(s<=a) return [l*(b-a)/(a*b), 0]; if(s>=b) return [0, l*(b-a)];
  return [l*(b-s)/(s*b), l*(s-a)]; }
// where the price sits inside a range: use tick (log) space, not linear price; linear crowds wide ranges toward the low edge
const rangePos=(tick,lo,hi)=>(tick-lo)/(hi-lo);
```

```js
// 7) A sealed inbox: anyone seals to a published X25519 public key; only the key holder opens (Node crypto, no deps)
const X_SPKI=Buffer.from('302a300506032b656e032100','hex');
function inboxSeal(str, pubB64){
  const eph=crypto.generateKeyPairSync('x25519'), epk=eph.publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const pub=crypto.createPublicKey({key:Buffer.concat([X_SPKI, Buffer.from(pubB64,'base64')]), format:'der', type:'spki'});
  const k=Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({privateKey:eph.privateKey, publicKey:pub}), epk, Buffer.from('my-inbox'), 32));
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct=Buffer.concat([c.update(String(str),'utf8'), c.final(), c.getAuthTag()]);
  return JSON.stringify({inbox:1, epk:epk.toString('base64'), iv:iv.toString('base64'), ct:ct.toString('base64')}); }
// The private key: X25519 from an HKDF seed of the main key (PKCS8 prefix 302e020100300506032b656e04220420 + 32-byte seed).
```

```js
// 8) Sealed logs on a public repo: keep the real log encrypted, print only counts and error categories
function quietLogs(sealFn, file){ const buf=[], errs=[], real=console.log;
  const put=(lvl,a)=>{ const s=a.map(x=>typeof x==='string'?x:(x&&x.stack)||JSON.stringify(x)).join(' '); buf.push(lvl+' '+s); if(lvl!=='log') errs.push(s); };
  console.log=(...a)=>put('log',a); console.warn=(...a)=>put('warn',a); console.error=(...a)=>put('error',a);
  process.on('exit',code=>{ try{ fs.writeFileSync(file, sealFn(JSON.stringify(buf.slice(-4000)))); }catch(e){}
    const cat={}; for(const e of errs){ const k=(String(e).match(/^[A-Za-z]+/)||['other'])[0]; cat[k]=(cat[k]||0)+1; }   // first word, letters only
    real('pass: '+buf.length+' lines (sealed), '+errs.length+' warnings/errors, exit '+code); for(const [k,n] of Object.entries(cat)) real('  · '+k+' ×'+n); }); }
```

```js
// 9) Local-hour bucketing (whole-hour time zones): format each UTC hour once, then "usual for this hour" = median over 14 days (>= 6 readings)
const fmtH=new Intl.DateTimeFormat('en-GB',{timeZone:OWNER_TZ,hour:'2-digit',hourCycle:'h23'}), hc=new Map();
const localHour=t=>{ const k=Math.floor(t/3600e3); let h=hc.get(k); if(h==null){ h=+fmtH.format(new Date(k*3600e3)); hc.set(k,h); } return h; };
const median=a=>{ const s=[...a].sort((x,y)=>x-y); return s.length?s[Math.floor(s.length/2)]:null; };
```

```yaml
# 10) Always-on loop in GitHub Actions: many passes per run, then start the next run yourself
concurrency: { group: relay, cancel-in-progress: false }
permissions: { contents: write, actions: write }
jobs:
  relay:
    runs-on: ubuntu-latest
    timeout-minutes: 350                      # a job may run 6 h
    steps:
      - uses: actions/checkout@v4
      - run: |
          SPACING=360; END=$(( $(date +%s) + 320*60 )); ok=0; i=0
          while [ "$(date +%s)" -lt "$END" ]; do i=$((i+1)); s=$(date +%s)
            git fetch -q origin gh-pages && git reset -q --hard origin/gh-pages      # reset FIRST, then generate
            if node scripts/relay.mjs && bash scripts/commit.sh; then ok=$((ok+1)); fi   # a failed pass never ends the loop
            left=$(( SPACING-($(date +%s)-s) )); [ $left -lt 60 ] && left=60
            [ $(( $(date +%s)+left )) -lt "$END" ] && sleep $left || break; done
          [ "$ok" -gt 0 ]
      - if: always()
        env: { GH_TOKEN: '${{ github.token }}' }
        run: gh workflow run relay.yml --ref gh-pages || true   # the one event the default token may start
```

## Ideas the user liked but never had built (candidates for the scanner)

- **LP depth chart** around the price plus a list of the other LPs near it. The mockup was liked; only a text list shipped.
- **Alerts:**
  - a share drop;
  - a new pool taking a pair's flow;
  - checks stuck amber;
  - CEX↔DEX gaps beyond "alert when a gap holds".
- **Momentum step 2:**
  - a sell trigger sized to each token's normal daily swing;
  - what the ranges already sold during a run, where each range ends, and the fees earned meanwhile;
  - a user-written rule in the config plus an optional alert.
- **Excluding pools that charge more than 5%** from share history.
- **Booking own swaps made from holdings-only wallets** (a known gap: the swap sweep skipped them).
- **A daily-audit warning** when the minute recorder's Ethereum scan reports "blocks still to look through".
- **A sealed "burst inspector"** for individual trades.
- **Read-only exchange balances and a running total of exchange sends.** Read-only exchange keys reveal no wallets, but deposits do link wallets publicly: use a separate wallet.
- **Longer "why fees moved" windows** from the swap replay (a month view, back-fill to August).

## Timeline of the old project (2026)

| When | What |
|---|---|
| Late Jul – early Oct | Relay data starts; the encryption lock goes on (4 Oct); more wallets added through the sealed inbox; about v38 |
| 6 Oct | CEX/DEX price-gap recorder with a hold-rule alert; 3-h soak |
| 7 Oct | Unclaimed-by-token strip; LP-receipt double count removed; NFT floors; pro chart; total view (to v39.1) |
| 8 Oct | History rebuilt from snapshots; pools-contribution view; LIVE button; odometer numbers; click audit (to v39.7) |
| 9 Oct | Privacy clean-up (history wipe) and the leak-check job; relay-restart and open-at-top fixes |
| 11–13 Oct | Market-share analysis with mockups A–G; WHY YOUR FEES MOVED; sealed pool census and swap replay; share-summing and protocol-fee fixes (to v40.7) |
| 14–17 Oct | Missing-price fake dip fixed; wording; worker pruning; full-screen big-fee effect; deploy-log leak fixed; own swaps as YOU rows |
| 21–22 Oct | Share history reconciled backwards; the per-day market-price rule (v40.14) |
| 22–24 Oct | Momentum: 9-design studio, placement view, step 1 with a 3-year backtest; tracking audit; off-market valuation; log-scale gauges (to v40.18) |
| 25 Oct | Thin-token price guard; tighter own-swap check; addresses added through the sealed inbox |
| 29–31 Oct | Gas audit → NETWORK FEES tile → hour-of-day baseline → RE-RANGE GAS → dials in the price tiles → BTC dial (v40.21–v40.25); activity audit with sealed requests |
