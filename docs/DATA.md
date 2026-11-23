# Data contract (v1): what the scanner publishes and the dashboard reads

This file describes shapes only: it holds no data. Every value below lives sealed.

## Files and where they live

| File | Sealed | Written by | Rewritten |
|---|---|---|---|
| `lock.json` | no (salt, rounds, a sealed check string) | lock init, once | never; a new passphrase means a new lock |
| `live.json` | yes | every scanner pass | each pass |
| `history.json` | yes | scanner | when a pool gains an hourly row, a fee-history day, day volumes or a TVL reading (about hourly; every pass while the backfills catch up) |
| `backtest.json` | yes | backtest job | daily and on demand |
| `snapshots.json` | yes | scanner | when a pool gains an hourly row (about hourly; every pass while the backfill catches up) |
| `inbox.json` | no (the X25519 public key only) | lock init | with `lock.json` |
| `keys.json` | no (wrapped keys only: owner, recovery, master and guest slots) | the loop's keys step | at the first run with slots (migration), when a guest or a passphrase is added or removed, a guest expires, or a recovery key is set |
| `status.json` | no (`{"lock":"mismatch","since"}` only) | the loop's alarm step | while `LOCK_PASSPHRASE` opens no slot; dropped by the next good publish |
| `owner.json` | yes, private key | the store, with `live.json` once `keys.json` exists | each pass |
| `guests.json` | yes, private key | the loop's keys step | when a request is applied or a guest expires |

- **Envelope** (`lib/lock.mjs`): `{"lock":1,"t":<ms>,"z":1,"iv":"<b64>","ct":"<b64>"}`. `z` = gzip before sealing; only `t` is readable, so a staleness check needs no key.
- **Key**: PBKDF2-SHA256(passphrase, salt, `iter` rounds, 64 bytes); the first 32 bytes are the AES-256-GCM key. The page derives it with WebCrypto and inflates with `DecompressionStream('gzip')`.
- **Where**: the data files sit on the `data` branch, one commit that each pass replaces. The page reads `https://raw.githubusercontent.com/<owner>/<repo>/data/<file>?t=<now>` with `cache: 'no-store'`. `lock.json` also ships with the page.
- **Missing is never zero**: an unread value is `null` and the page shows "—". Fractions are 0..1, money in USD, times in ms since epoch, durations in days.

## Key slots: guests, recovery key, passphrase change (docs/briefs/guest-access.md)

Once the data branch holds `keys.json` (the loop's first run on the slot code creates it):
- **Two data keys.** Market files (`live.json`, `history.json`, `backtest.json`) are sealed under a random **market key**. Every other file (`snapshots.json`, `log.json`, `owner.json`, `guests.json`) is sealed under a random **private key**.
- **`keys.json`** = `{ keys: 2, t, iter, gsalt, rsalt, owner: [Slot], recovery: Slot|null, mk: Slot, slots: [Slot] }`, where `Slot = { iv, ct }` is AES-256-GCM over JSON, its kind bound as additional data:
  - **owner slots** (`lps-owner-slot`): one per passphrase, under PBKDF2-SHA256(passphrase, `lock.json` salt, `iter`, 64 bytes)[0..32]. Each holds `{ m: <master key> }`.
  - **the recovery slot** (`lps-recovery-slot`): under PBKDF2(recovery key, `rsalt`). It holds `{ m }`.
  - **the master slot** (`lps-master-slot`): under the master key. It holds `{ k: <market key>, p: [<older market keys>], pk: <private key>, pp: [<older private keys>], tk: <inbox seed>, g }`. `pp` keeps the lock's own key (every older file opens) and `tk` is the lock's token (`lock/inbox.json` is unchanged).
  - **guest slots** (`lps-guest-slot`): under PBKDF2(guest passphrase, `gsalt`). Each holds `{ k: <market key>, s: <slot id>, n: <name>, e: <expiry ms|null>, g }`.
  - The slots are shuffled at each write. A reader without a key sees only the counts.
- **When a passphrase counts:** once `keys.json` exists, it must open an owner slot. `lock.json`'s check decides only before that.
- **`owner.json`** = `{ v: 1, t, ticket, stopLoss, gemAt, ageDays }`, moved out of `live.json` (`lib/store.mjs` splits it on write and merges it on read). The `token-age-rank` label in `live.json` then reads "tokens ranked and trading long enough". `backtest.json` has no `ticket` then.
- **`guests.json`** = `{ v: 1, t, gen, guests: [{ s, n, e, r, x, d, sh?, at, st: "active"|"removed"|"expired", end, kek?, pw? }], done: [<request id>], vault: { change: { at, ct }|null, changedAt, recoveryAt } }`. `kek` is kept unless removed; `pw` is a passphrase the loop made, for the owner's page only.
- **`status.json`** (readable, only while the loop is paused) = `{ "lock": "mismatch", "since": <ms> }`: `LOCK_PASSPHRASE` opens no owner slot. The first publish that opens drops it.
- **Requests** are files in `inbox/` on the code branch, each sealed to `lock/inbox.json`: `guest-add` (a list), `guest-make` / `add-guests` (the loop makes the passphrases), `shared-set` / `add-shared-guest` (the shared guest password, 180 days), `shared-extend` / `extend-shared-guest` (restarts it: 180 days from the pass that applies it, same password and key), `guest-update` (upgrade, extend), `guest-remove`, `guest-reset`, `owner-add`, `recovery-set` (`lib/guests.mjs`).
- **Guest slot fields** besides `k, s, n, e, g`: `r` (`"guest"` or `"member"`), `x` (the last extension), `d` (the device clock's days; 0 for the shared password), `sh: 1` (the shared password; `n` is then its label).
- **Before `keys.json` exists:** every file is sealed under the lock's own key and shaped as described below.

## live.json

```
{
  v: 1,
  t: <ms>,                      // pass time
  phase: 0|1|2|3,               // 0 read-only scanner, 1 paper trading, 2 small live, 3 auto-manage
  build: "<scanner build tag>",
  next: <ms|null>,              // expected next pass
  ticket: <usd>,                // example ticket every pool is scored at
  stopLoss: <fraction>,         // position value drop, measured in the quote token, that closes a position (0.08)
  windows: ["24h", "7d", "30d"],
  defaultWindow: "24h",         // Gem now reads the last day
  gemAt: 60,                    // gem threshold
  chains: [{ id: "ethereum"|"base", pools: <n>, unread: <n>, block: <n>, gasUsd: <re-range gas in $|null>,
             dexes: { "uniswap"|"pancakeswap": <pools> } }],   // one entry per chain scanned this pass
  health: {
    loop: { passes24h: <n>, ok24h: <n>, lastGapMin: <n|null>, watchdogLast: <ms|null>,   // written by the loop, not the pass
            recent: [[<pass start ms>, <1 ok | 0 failed>]] } | null,                  // the last 24 h of passes plus the one before
    checks: [{ id: "<id>", label: "<short label>", ok: true|false|null, value: <0..1|null>, detail: "<one line>" }],
    sealedLog: { lines: <n>, errors: <n>, categories: { "<word>": <n> } },
    cex: { day: "YYYY-MM-DD", calls: <CoinGecko tickers calls this UTC day>, perDay: <budget> },  // carried pass to pass
    apis: { day: "YYYY-MM-DD",                                  // market-data calls this UTC day, by source (lib/apicount.mjs)
            coingecko: { used: <n>, cap: 150,                   // the hard daily CoinGecko budget: past it, no CoinGecko call
                         out: "YYYY-MM"|null },                 // is made (the fallbacks serve, else null); carried pass to pass.
                                                                // out: the UTC month CoinGecko's monthly quota ran out (see below):
                                                                // no CoinGecko call until the 1st, when it clears itself
            defillama: <n>, coinbase: <n>, geckoterminal: <n>,
            kraken: <n>, okx: <n>, gate: <n>, kucoin: <n> }      // the exchange screen's fallback venues
  },
  stored: ["ethereum", "base"?],  // the chains whose rows the snapshot store keeps: Base's only once the live loop
                                  // runs multi-chain code (a loop of older code reads every stored row's block number
                                  // into one Ethereum clock); until then Base windows come from each pass's backfill
  discovery: {                    // the discovery lanes (step 1), pool ids, best first
    newPools: [<id>],             // under 72 hours old (creation event) with ≥ 20 distinct senders (tx.from) in the last day
    cexLed: [<id>],               // the "cexled" lens: pool.cex.cexRatio ≥ 10 and tierVsSigma ≥ 2
    crossChain: [],               // cross-chain gaps: not built yet, always []
    retailUp: [<id>]              // the default window's "retail" lens
  },
  bench: "<pool id>",           // UNI/WETH 0.3% on Ethereum
  pools: [Pool],                // every scored pool, sorted by the default window's gem score
  pairs: { "<addr>-<addr>": Pair },  // every pool of a pair side by side (lib/pairs.mjs); key = the two token
                                     // addresses, lower first, native ETH read as WETH; another chain's pairs are
                                     // their own, keyed "<chain>:<addr>-<addr>" (e.g. "base:0x…-0x…")
  market: Market | null             // the top strip (lib/market.mjs); null only if the block itself broke
}
Market = {
  t: <ms>,                          // read during this pass (same as live.t)
  gas: {                            // Ethereum, in gwei: the next block's base fee + the median recent priority fee
    gwei: <n|null>, p10: <n|null>, p50: <n|null>, p90: <n|null>,
    band: "cheap"|"normal"|"busy"|"expensive"|null,   // vs the reference: < p25 cheap, ≤ p60 normal, ≤ p90 busy, else expensive
    basis: "history"|"blocks"|null,  // history = the hourly samples below (12+ hours of them); blocks = the last ~1024
                                     // blocks (about 3.4 h) while the history is shorter; null = nothing to compare: no band
    histDays: <n>,                   // days the hourly history spans (0 when empty)
    source: "feeHistory"|"gasPrice"|null,   // eth_feeHistory, else the eth_gasPrice fallback (no blocks basis then)
    hist: [[<hour ms>, <mean gwei>, <passes>]]   // the rolling history the scanner carries between passes: one mean
                                     // per UTC hour, last 7 days (≤ 168 rows); percentiles weight each hour once
  },
  px: { ETH|BTC|SOL: { usd: <n|null>, ch24: <fraction|null>, src: "defillama"|"coinbase"|"coingecko"|null } },
                                    // ch24 = 24 h change as a fraction (−0.031 = −3.1%); DefiLlama first, then Coinbase,
                                    // CoinGecko only for a coin both lack (within the daily budget), else null
  xcheck: { day: "YYYY-MM-DD", both: <n>, agree: <n> } | null   // the once-a-UTC-day DefiLlama vs CoinGecko check: coins
                                    // both answered, and those within 2%; carried, asked once on each new day
}
Pair = {
  label: "<SYM>/<SYM>", pools: ["<pool id>"], best: "<pool id>"|null,   // best = highest net APR in the default
                                                                       // window among verified pools with data
  w: { "24h"|"7d"|"30d": { volUsd: <n|null>, lpFeesUsd: <n|null>, unread: <pools without a number>,
       rows: [{ id, volumeShare: <0..1|null>, feesPer1kDay: <USD a day for $1,000 at the price, after dilution|null>, net: <APR|null> }] } }
}
```

`market` feeds the dashboard's top strip, so the page never calls a third party (no CSP holes, no viewer IP sent out). Hosts: gas from the scanner's Ethereum RPCs (`eth_feeHistory` over the last 1024 blocks, or 100 where a node caps the span, with the 50th-percentile reward; `eth_gasPrice` as the fallback); prices from `coins.llama.fi/prices/current` and `coins.llama.fi/percentage?period=24h` (ids `coingecko:ethereum`, `coingecko:bitcoin`, `coingecko:solana`), then for a coin DefiLlama lacks `api.coinbase.com/v2/prices/{ETH|BTC|SOL}-USD/spot` with the 24 h change from `api.exchange.coinbase.com/products/{…}-USD/stats` (open vs last; no key), and `api.coingecko.com/api/v3/simple/price` (the Demo key, in a header) only for a coin both lack and once a UTC day for the agreement check (`xcheck`). Gas and prices each have a 15-second limit and fail separately to `null`; a pass that reads nothing still carries `gas.hist` forward. The countdown uses `next` and "updated" uses `t`.

**CoinGecko's monthly quota out** (lib/apicount.mjs). The free Demo key allows 10,000 calls a month. When CoinGecko refuses for the month (an HTTP 4xx whose answer names the calls limit, as its 429 "You've reached 10,000 calls limit" does, or 6 HTTP 429s in a row over at least 2 minutes, longer than a busy minute lasts; a 500, a timeout or a per-minute "Rate Limit" 429 never counts), `health.apis.coingecko.out` is set to that UTC month, travels with the counts (the cache file from the pool list to the scan, `live.json` from one loop job to the next), and no CoinGecko call is made until the 1st of the next month, when it clears itself. The public log says `coingecko: monthly quota out until 1 Dec; fallbacks serving` (no key, no URL). Meanwhile:
- **the universe** (ranks and platform addresses, `out/cache/universe.json`) is served from its cache up to 45 days old, and the pool list's public line gives its age; with no cache, or one over 45 days, the universe is unread and the pool list stops, never guessing. Both `loop.yml` and `pools.yml` keep the cache (`pools.yml` also takes the loop's when it is newer);
- **prices and price history** come from DefiLlama, Coinbase and GeckoTerminal as before (CoinGecko was already the last resort), and the daily DefiLlama vs CoinGecko agreement check keeps its last day;
- **the exchange screen** (`pool.cex`) falls back to the exchanges' own free, keyless public APIs that answer from GitHub's US runners (Binance and Bybit refuse US addresses): Coinbase Exchange `/products/stats` (else `/products` and `/products/{id}/stats` for the coins wanted), Kraken `/0/public/AssetPairs` and `/0/public/Ticker`, OKX `/api/v5/market/tickers?instType=SPOT`, Gate `/api/v4/spot/tickers` and KuCoin `/api/v1/market/allTickers`: about 6 bulk calls, at most 40 calls and 45 s a pass, read again after 6 hours. A coin's 24 h USD volume is summed over every market of every venue that lists its ticker (a stablecoin quote at $1, another quote at that venue's own price of it), counted only where the ticker is unambiguous (no other coin of the pool lists has it) and the venue's price agrees with the token's market price within 10%. `pool.cex.src` is `"exchanges"` and `venues` the number of venues summed. Same ratio as before (that volume ÷ the value within ±9%), but CoinGecko's tickers cover far more exchanges (Binance, Bybit, Bitget, MEXC and others), so the fallback understates centralised volume and its `cexRatio` is a **lower bound**: a pool it shows as exchange-led is, one it doesn't may still be. A coin no venue lists, or every venue disagrees on, is null, never 0.

Check ids in `health.checks` (each across every chain scanned: false if any chain failed it, true if all passed, else null; `detail` names the chain): `fee-identity`, `price-vs-market`, `volume-vs-aggregator`, `maps-complete`, `lp-book`, `creation-events`, `volatility-xcheck`, `fees-vs-aggregator`.

### Pool

```
{
  id: "<v3 pool address or v4 pool id>", chain: "ethereum"|"base", dex: "uniswap"|"pancakeswap", v: 3|4,   // PancakeSwap: v 3
  pair: "<SYM0>/<SYM1>", pairKey: "<key in pairs>",
  t0: { sym, addr, dec, usd: <n|null>, links }, t1: { sym, addr, dec, usd: <n|null>, links },
                                // links = { cmc: "<CoinMarketCap slug>"|null, cg: "<CoinGecko id>"|null } (from v0.7.8;
                                //   older data has none: plain text). See "Token links" below
  feeTier: <fraction, e.g. 0.003>, dynamicFee: <bool>, lpKeeps: <fraction LPs keep after the protocol's cut|null>,
                                // read per venue: Uniswap v3 1 − 1/N per nibble; PancakeSwap v3 1 − fp/10,000 per 16-bit
                                // share (about 0.66); v4 from slot0's protocolFee and lpFee
  hooks: "<address>"|null,
  verified: true|false|null,    // true = swaps reproduce the fee counters; false = "unverified" (can't be checked, e.g. a hook
                                //   that moves tokens outside the pool's books): never a gem; null = not checked yet
                                //   (too few swaps, or unread): may be a gem, tagged "NOT CHECKED"
  firstSeen: <ms>, createdAt: <ms|null>, pairAgeDays: <n|null>, young: <bool>,   // young = pool under 30 days old
  tvlUsd: <n|null>, mapUsd: <n|null>, aggUsd: <n|null>,
  price: <token1 per token0>, marketRatio: <n|null>, offMarket: <bool>,
  shape: {
    tag: "served"|"mixed"|"stranded"|"one-sided",
    parked: <0..1>,             // share of value parked away from the price
    above: <0..1>,              // share of the parked value above the price
    band9: <0..1>,              // share of value within ±9%
    lpsAtPrice: <n|null>,
    depth: [[<log offset of the bin's centre>, <usd|null>], ...],   // the liquidity chart's bars, ascending (lib/shape.mjs
                                //   depthProfile): the pool's whole LP field, full-range layer left out (fullRangeUsd).
                                //   48 fine bins across ±0.45 and 5 coarser bins a side out to ±0.6375 (same edges as
                                //   before), then "far" bins a side, each twice as wide as the one before, out to the side's
                                //   furthest initialized tick with no cap (the last one cut at the tick limit): 58 to about
                                //   82 bars; a null bar = that stretch of the map was not read (never 0); [] = no map this
                                //   pass, or token1 unpriced
    depthEdges: [<log offset>, ...]|null,   // every bar's edges, ascending, one more than the bars: bar i spans depthEdges[i]
                                //   to depthEdges[i + 1] (draw widths from these: the far bars are 0.075, 0.15, 0.3, 0.6, 1.2,
                                //   2.4, … wide); e.g. [−10.1625, −5.3625, −2.9625, −1.7625, −1.1625, −0.8625, −0.7125,
                                //   −0.6375, −0.6, …, 0.6375, 0.7125, 0.8625, 1.1625, 1.7625, 2.9625, 5.3625]; null when depth is []
    depthSpan: [<min log offset>, <max log offset>]|null,   // the bars' outer edges = depthEdges' first and last: from
                                //   [−0.6375, 0.6375] (price −47% / +89%) for a map that ends inside them, out to the tick
                                //   limits (about ±88.7 from a price near tick 0); per side and per pool; null when depth is []
    depthStep: { fine: 0.01875, coarse: 0.0375, edge: 0.45 }|null,   // kept for the first readers: bar widths in log price, fine
                                //   inside ±edge, coarse from there to ±0.6375 (the far bars' widths are in depthEdges only)
    beyond: { below: <usd|null>, above: <usd|null> },   // everything past depthSpan on that side: 0 (real) when the bars reach
                                //   the side's last tick, which, uncapped, they always do; null = that side has an unread
                                //   stretch, or no map
    fullRangeUsd: <usd|null>,   // the full-range layer the bars leave out: the liquidity present at every tick within ±5 log
                                //   of the price (full-range positions, or a stack of wide positions covering that stretch),
                                //   as far out as the liquidity stays at that level; 0 (real) = none; null = not measured (an
                                //   unread stretch: the bars then hold everything), or no map, or token1 unpriced
    fullRangeSpan: [<min log offset>, <max log offset>]|null,   // the layer's extent (about ±88.7 for MIN..MAX positions near
                                //   tick 0); null when fullRangeUsd is 0 or null
    walls: { below: <log offset|null>, above: <log offset|null> }   // found on the ±0.45 fine bars only, as before
  },
  w: { "24h": Window|null, "7d": Window|null, "30d": Window|null },
  cex: { cexVol24: <USD|null>, cexRatio: <n|null>, tierVsSigma: <n|null>, t: <ms the volume was read|null>, coin: "<CoinGecko id>"|null,
         src: "coingecko"|"exchanges"|null, venues: <n|null> },   // src: whose volume; venues: the fallback's venue count
                                // the exchange-led screen (lib/cex.mjs): the base token's 24 h volume on centralised
                                // exchanges (CoinGecko tickers, DEX and flagged tickers left out; only the 15 coins of the
                                // biggest pools, each at most once in 24 h, within the daily budget, so t can be up to
                                // 48 h old; a coin past the 15 is null), ÷ the value within ±9%, and the fee
                                // tier ÷ the per-block σ (daily σ ÷ √blocks a day: Base's 0.2 s blocks make this larger).
                                // src "exchanges": CoinGecko could not answer (its monthly quota out, or the day's budget
                                // spent), so the volume is the fallback's (below): a lower bound, and cexRatio with it
  flowDaily: [[<UTC day ms>, <retailShare|null>, <lpFeesUsd|null>, <routing|null>]],   // up to 30 days, carried pass to
                                // pass; the 7d and 30d windows' retailShare and routing read it
  checks: [{ id: "<id>", label: "<short>", ok: true|false|null }],   // the per-pool checklist, e.g. "12/12 checks pass"
  gemFirstAt: <ms|null>,        // first pass where the default window's gem reached gemAt ("new since you last looked")
  daily: [{ t, feesPer1k, net }],   // up to 30 days: USD a day for $1,000 at the price after dilution at the ticket, and
                                    // net of LVR and re-range costs; the latest entry is the last 24 hours
  pattern: "steady"|"bursty"|"emerging"|"fading"|"mixed"|null,
  burst: { maxDay, medianDay, burstDays, oneTrader: <share of the biggest day's fees from its largest tx|null> }
}
```

**The liquidity chart's bins: the whole field (owner's pick "A · Whole field, grouped", 7 Nov 2026).** The bars, both `beyond` buckets and `fullRangeUsd` add up to `mapUsd` (each value is rounded to 5 significant digits). `parked`, `above`, `band9` and `walls` are computed exactly as before (`test/shape.test.mjs`, `test/scan-outputs.test.mjs`), and the bar edges inside ±0.6375 are the same as before. The full-range layer comes off every bar: old bar = new bar + the layer's share of that bar, bar by bar (tested), so the ±0.45 bars of a pool with full-range positions are lower than before by exactly that share. The layer is constant liquidity, so its share of `fullRangeUsd` between log offsets a < b inside `fullRangeSpan` [lo, hi] is part(a, b) ÷ part(lo, hi), where part(x, y) = e^(y/2) − e^(x/2) for y ≤ 0 and e^(−x/2) − e^(−y/2) for x ≥ 0 (split at 0 otherwise); in dollars per unit of log price that is a density ∝ e^(−\|x\|/2), flat in liquidity terms, so the page can draw it as a flat layer under the bars. Past ±0.6375 the far bars run, on each side, until the side's furthest initialized tick (of what is left after the layer) is inside the last one: a pool whose liquidity ends at +0.80 has two far bars above (to 0.8625) and `beyond.above` = 0; a wall at −8 log gets the bars out to −10.1625; a pool with only full-range positions keeps the 58 bars, all real zeros, and the layer holds everything. Without a cap the bars always reach the last tick, so `beyond` is a real 0 whenever the side was read. The edges follow one ladder for every pool (only how many far bars each side has, and where the last one is cut at the tick limit, differ). The level that counts as the layer is the lowest liquidity within ±5 log of the price, out as far as the liquidity stays at least that high: a full range plus a ±7-log position gives one layer at their sum out to ±7 log, and the full range past ±7 log stays on the bars (exact either way). One-sided wide positions, or any stretch with no liquidity within ±5 log, give no layer (`fullRangeUsd` = 0). The scanner reads each map in full or not at all, so today a pool has either every bar or none; `depthProfile` already takes a list of unread tick chunks for a partial read. An unread chunk hides itself and everything past it on its side (the map is walked out from the price), so those bars and that side's `beyond` are `null`, and that side's far bars run out to the tick limit (where its last tick is, nobody knows); a chunk that holds the price hides every bar; with any unread chunk the layer is not measured (`fullRangeUsd` null, the bars hold everything). A bar past the last tick a pool can use is a real 0. Size (made-up maps, `test/shape.test.mjs`): with a full-range layer the depth fields shrink (about 1.7 KB vs 1.8 KB a pool, fewer far bars); the worst case, liquidity out to both tick limits with no layer, is 80 bars and +296 bytes a pool; the test holds it under +1 KB. Options `{ far: Math.LN10, wide: null }` reproduce the chart before the whole field exactly (tested).

### Window

```
{
  days: <days actually covered>, partial: <bool>,      // a young pool covers fewer days than the window
  volUsd, lpFeesUsd, protocolFeesUsd, swaps, traders,
  sigma: <daily volatility>, range: <half-width r, log>, rerangeDays: <n|null>,
  inRangeUsd: <value already inside ±r: the "V" in fee APR = 365·F/(V+S); shown as ROOM>,
  feeApr, lvr, swapCost, gas, net, edge,               // annualised fractions at the ticket; edge = feeApr ÷ lvr
  aggApr: <fees ÷ total TVL: "what trackers show">,
  parkedAvg: <0..1|null>, strandedShare: <0..1|null>, markout: <markout ÷ fee|null>,
  flow: { retailShare: <0..1|null>, driftCorr: <−1..1|null>, routing: <0..1|null>, senders: <n|null> },   // lib/flowq.mjs:
       // retailShare = the share of LP fees from swaps that are not arb-like (arb-like = moves the pool toward the price
       //   25 Ethereum / 1,500 Base blocks (5 min) later AND leaves the trader ahead at it; the markouts' reference);
       //   24h from the day's swaps, 7d/30d the fee-weighted mean of flowDaily (≥ 3 days)
       // driftCorr = Spearman's ρ of each hour's LP fees vs that hour's |log return| of the pool's own price (hourly
       //   snapshot rows; ≥ 12 hours; 30d reads the 14 days the hourly tier keeps)
       // routing = the share of swaps whose tx.to is a known router or aggregator (lib/routers.mjs), from the 40
       //   smallest tx hashes of the day (a stable sample, cached); null under 10 sampled or half the sample unread
       // senders = distinct tx.from over all the day's transactions (24h only; null unless every one was read)
  gem: { total: <0..100|null>, yield, thinness, flow, staying, warnings: ["..."], missing: ["..."],
         tags: ["unconfirmed"|"one-off"|"unchecked"],
         why: { y, yd, yx, yh, th, mk, tr, ps, sd, ws, ia, sp, sf: [], sn: [], dp, df: [], dn: [], wn: [] } },
       // why (from v0.8.x scanners; older data has none, and the page then hides its "Why ?" link): what each part read and
       // how the gates went, for the dashboard's "Why this pool?" breakdown. Missing is never zero: an input not read is null.
       //   y  the typical day's net per $1,000 a day Yield now read; yd the days its median took (3-7), 0 = too little
       //      history, the window's own net stood in; yx 1 = a one-off day was left out of it; yh 1 = a one-trader day with
       //      no history behind it was halved
       //   th thinness (the day's LP fees ÷ the value at the price); mk markout ÷ fee and tr traders a week (flow; a 7d or
       //      30d window reads the latest replay); ps the persistence score behind staying power (null: not measured, the
       //      part counts 0); sd days stranded of the last 30, ws the nearest wall in σ-weeks (99: none in view), ia the
       //      share held by inactive wallets
       //   sp/dp safety and data checks passed; sf/df the ids that failed (no gem); sn/dn the ids that did not run (a
       //      safety one caps at 40, a data one costs 5); wn the warnings (10 points each). The ids are the pool's checks.
       //   total = max(0, yield + thinness + flow + staying − 10·wn − 5·dn), capped at 40 when sn is not empty; null when
       //   sf or df is not empty (lib/gem.mjs whyTotal; test/gem-why.test.mjs, and the scan end to end)
       // Gem now (lib/gem.mjs gemNow): yield now 45 (the median of the last 7 days' net per $1,000 a day) + thinness 25
       // (the day's LP fees ÷ the value at the price) + flow 20 (markout ÷ fee, traders) + staying power 10 (bonus).
       // A failed check → no gem; a safety check not run → capped at 40 ("unchecked"); a data check not run → −5.
  lenses: ["stranded"|"one-sided"|"fresh"|"bigmove"|"calm"|"toxic"|"cexled"|"retail"],
       // cexled: pool.cex.cexRatio ≥ 10 and tierVsSigma ≥ 2; retail: flow.retailShare ≥ 0.6, or ≥ 0.1 above the next
       // longer window's
  spark: { px: [<n>], fees: [<n>] }                    // about 24 points each, for sparklines
}
```

## history.json

```
{
  v: 1, t: <ms>,
  pools: { "<id>": { h: [[t, price, liquidity, lpFeesUsd, parked]],    // hourly, last 14 days (≤ 337 rows)
                     d: [[t, price, lpFeesUsd, volUsd, parked]],       // daily, last 90 days (≤ 91 rows)
                     y: [[t, feesUsd, src]],                           // the fee history: one row a UTC day, up to 365
                     yp: { exact, est, age, dyn, sw, lim, from },      //   days (yesterday last), its progress, and why older days can't be exact
                     yv: [[volUsd, src]],                              // the day's volume, one row per y row (yv[i] is day y[i][0])
                     yvp: { s, g },                                    //   days from the swaps, from the candles
                     yt: [[tvlUsd, src]],                              // the day's TVL at its end, one row per y row (yt[i] is day y[i][0])
                     ytp: { b, r, m, lim, from },                      //   days by source, and why older days can't be read
                     u: { d: [t], y: [t] } } },                         // unconfirmed fee spikes (absent when none)
  health: [[t, okPasses, passes, unread]]                              // hourly, last 7 days
}
```

Built by `lib/charts.mjs` from `snapshots.json`, one row per stored snapshot row, ascending by `t` (the row's own time: a pass time, or a backfilled block's timestamp). `price` = token1 per token0 (8 significant digits); `liquidity` = the pool's active liquidity (8 significant digits); `parked` 0..1 (4 decimals). `lpFeesUsd` = the pool's LP fees **from the row before to this one** (fee growth × the interval's liquidity, at the pass's token prices), `volUsd` = those fees ÷ the LP fee rate. Rows are not always exactly an hour or a day apart (a gap the backfill has not filled yet, or a row a few minutes off its mark), so a chart of fees per hour or per day divides by the gap to the row before. `null` = unread: the first row, a row whose counters were not read and the row after it. A pool's rows start where its data starts: hours and days before the pool existed have **no row at all** (absent, never a 0 row), and a pool younger than the span simply has fewer rows. Size, sealed, for about 100 pools: about 0.55 MB with 7 and 30 days, about 1.1 MB with 14 and 90 (made-up data of the same shape; 60 days instead of 90 would save under 10%, the 14 days of hours are most of it).

### Unconfirmed fee spikes: `u` (12 Nov 2026)

A day at **20× its 30-day median** or more (the median of the other rows' fees per day within 15 days either side, at least 5 of them; a day under $10 is never one) is shown as real only when the day's traded volume backs it: GeckoTerminal's day candles (the `gt` cache) × the LP fee rate over the row's own span must reach at least a quarter of the counters' figure (`lib/spikes.mjs`). Otherwise the row's `t` is listed in `u`, and the page marks the bar **unconfirmed**: never shown silently as checked.
- `u.d`: `t` of `d` rows (the row's fees are per its span, so a gap row is judged per day, never as one day); `u.y`: `t` of the counters' exact (`'x'`) `y` days. Estimated days are the volume itself and swap days (`'s'`) are the day's own trades: neither is judged (swap days count in the median around a day, estimated days don't). `u` is absent when nothing is listed; a pool with no candles read yet lists every spike it has.
- **Swaps first (14 Nov 2026).** The evidence is the day's own swaps (the exact fees below, `lib/spikes.mjs` `swapEvidence`: Σ over the UTC days the row spans of each day's swap fees × the share of the day inside it) wherever every day it spans has them, else the day's volume. A spike the swaps back is never unconfirmed; one they contradict is.
- **A sliver of a day (21 Nov 2026).** A daily row ends at about 00:05, five minutes into the next UTC day, whose candle and swap day can't exist until that day ends. A day the row overlaps by an hour or less with nothing read for it is left out of the evidence (the sum is then a lower bound, so the check only gets stricter); before, the newest row had no evidence at all and a real spike on the latest day read unconfirmed until the next day. A longer unread stretch is still no evidence.
- Public log, counts only: `fee spikes: N days at 20× … M backed by the day's swaps or volume (S by its swaps), K marked unconfirmed in P pools`.
- Why (diag run 43303357358, 12 Nov 2026): the UNI/WETH 1% days the owner doubted (26 and 27 Sep, about 900× and 1,200× their median) were real: the rows re-read the same at archive nodes, their block times matched, and that day's 81 and 113 swaps carried exactly the fees the counters show (ratio 1.00). The rule makes the page say so, or say "unconfirmed", instead of leaving it to trust.

### The fee history: `y` and `yp` (the owner's option C, 8 Nov 2026)

Every pool shows up to a year of daily LP fees at once: exact days drawn solid, estimated days pale (`lib/feehist.mjs`).

- **`y` rows** `[t, feesUsd, src]`: `t` = the UTC day's start (ms), one row a day, ascending, from the pool's first day within the year to **yesterday** (today is not complete; at most 365 rows). `feesUsd` = that day's LP fees in USD (4 significant digits). `src`:
  - `'s'` **exact, from the day's swaps** (14 Nov 2026, below): the UTC day's own swap events summed, midnight to midnight. The page draws it as exact (solid), like `'x'`.
  - `'x'` **exact**: the pool's own fee counters, Δ feeGrowthGlobal × the interval's liquidity from the day's row to the next day's (rows 20 to 28 hours apart, scaled to 24 h; anything else is not a day), the same counters the windows read.
  - `'e'` **estimated**: the day's volume × fee tier × the share LPs keep (the pool's own `lpKeeps`, the same rate as `d`'s `volUsd`). Volume = GeckoTerminal's public day candle (USD). A v4 dynamic-fee pool's estimate uses its current lpFee: `yp.dyn` is true.
  - `null` with `feesUsd` `null`: neither was read for that day (**never 0**). A day with no swaps on an exact day is a real `0`.
  - **Precedence: `'s'` over `'x'` over `'e'`** for the same day (the swaps over the counters over the estimate). **A day before the pool existed has no row at all**: the rows start at the pool's creation day (its creation event, else the day of the last moment a read found it not there yet), which is partial and usually estimated.
- **Valued at the day's prices** (unlike `h` and `d`, which use the pass's prices): an exact day's token amounts at the candle's close for GeckoTerminal's base token and the pool's own on-chain price at the day's end for the other token; with no candle within 3 days, at the pass's prices. So a token's later price move never redraws its past, and the pale and solid bars meet without a jump.
- **`yp`** `{ exact, est, age, dyn, sw }`: `exact` = days with an `'s'` or `'x'` row, `sw` = those with an `'s'` row, `est` = days with an `'e'` row, `age` = the pool's age in days within the year (= `y.length`; 365 for an older pool) when its start is known (a creation event, a read that found it not there yet, or data reaching the year's start), else `null`; the progress bar is `exact` of `age`. `dyn` = the estimates use the current dynamic fee. `lim` = `'archive'` on a chain whose archive nodes keep only part of the year (Base, `lib/chains.mjs` `archiveDays`, about 90 days), else `null`; `from` = the first UTC day (ms) whose exact fees can still be read (its 00:05 moment within the reach), else `null`. A day before `from` that is not exact yet never will be: it stays estimated, or null with no candle (never 0); a day read while it was still in reach stays exact.
- **How it fills.** Exact days come from the snapshot tiers (14 days of hours, 90 days of days) and a **deep backfill** that reads one archive block per past day (00:05 UTC), newest first, back to the pool's creation and at most 365 days, after every moment the windows and the 90-day chart need (`lib/backfill.mjs` ranks; a day whose only row is far from its start, e.g. a pass at 13:00, is read again at 00:05). Per pass: at most 10 days a pool, 40 batches on Ethereum, 12 on Base (`lib/chains.mjs` `caps.backfill.deep`), within the backfill's own time budget; 3 unread batches in a row leave the rest for the next pass. Each batch carries its own block timestamp (Multicall3) and a batch answered with today's state is dropped, as for the backfill; Ethereum's deep moments get their block from a timestamp read at each one first, Base's from its two-era clock. Only for the chains whose rows the store keeps (`live.json` `stored`), and never past a chain's archive reach (Base: no moment older than `archiveDays`, and a day past it no longer makes the next day wanted). With about 224 Ethereum pools, about 4 batches a past day: the year takes about 28 passes.
- **Volumes**: `https://api.geckoterminal.com/api/v2/networks/{eth|base}/pools/{pool address or v4 pool id}/ohlcv/day?aggregate=1&limit=366&currency=usd` (public, no key), fetched **once per pool**, the largest pools first, and cached in `snapshots.json` `gt`; after that, once a UTC day from 00:30, only the newest days (`limit` = the days since the last held + 1). 3 s apart (20 a minute, under the public 30, which the runners' shared addresses also spend: a real run got a 429 at its 6th call 2.4 s apart), at most 20 calls and 60 s a pass, alongside the backfill's reads (no wall time added); a 429 waits 30 s once (within the 60 s) and asks again, a second stops the pass, as does an unreachable host or 3 other errors in a row; a pool GeckoTerminal does not know (404) is asked again after a week. About 15 to 30 passes fetch 300 pools. No key: never the CoinGecko key.
- **Never in a score.** The estimates (and the deep record) feed only `y`, `yp` and one public sanity number: never the windows, the gem, the lenses, the backtest or any score. The windows are given the raw tiers only (`windowSeries`); `test/feehist.test.mjs` proves it statically (no scoring module can see the fee history) and by taint (estimates × 1,000 change no window or gem), each with a planted leak it catches, and `test/feehist-scan.test.mjs` runs the scan with absurd volumes and finds every window and gem unchanged.
- **Sanity check** (public log, one line `fee history: …`, counts and one ratio only): the median of estimated ÷ exact over every pool-day with both (exact valued at that day's own close, exact ≥ $10, dynamic-fee pools left out); it should be near 1 (sealed check `fee history`: within 25% once 20 days have both).
- **Size**, sealed, made-up data of the same shape, 300 pools with a full year: `y` + `yp` add about 0.8 MB to `history.json` (about 2.7 KB a pool); in `snapshots.json` the deep record adds about 1.05 MB and the candle cache about 0.9 MB. `y` rides in `history.json` rather than a separate `feehist.json`: the page already fetches it, it is rewritten as often (about hourly), and a new file name would stop a loop of older code from publishing (its data branch check refuses unknown files).

### Volume and TVL: `yv`, `yt` (the owner's "yes to TVL recording", 14 Nov 2026)

Every pool's fee history (`y`) gets the same days' volume and TVL beside it, for the page's three synced charts (Fees, Volume, TVL; `lib/tvlhist.mjs`).

- **Aligned to `y`.** `yv` and `yt` have exactly `y.length` rows, and row `i` is day `y[i][0]` (no `t` of their own: repeating it would cost about 0.75 MB more for 300 pools). So they start on the pool's first day (its creation day; nothing before a pool existed) and end with **yesterday**, like `y`. A row is `[usd, src]`, 4 significant digits; `[null, null]` = not read (**never 0**). A real 0 is a day read with nothing in it (a swap day with no swaps; a pool holding nothing).
- **`yv` volume**, `src`:
  - `'s'` **the day's own swaps**: the exact fees (below) sum each UTC day's swaps, and with them now Σ each swap's input amount (the fee included, as the 24 h volume counts it), token0's side converted at the day's end price, valued at the day's prices like an exact fee day. Kept in `snapshots.json` `sx` (`v`). Days the exact fees read before 14 Nov 2026 carry no volume and are never read again: those days show the candle.
  - `'g'` **GeckoTerminal's day candle** (USD), the `gt` cache (up to 366 days).
  - Precedence **`'s'` over `'g'`**. `yvp` = `{ s, g }`: days from each.
- **`yt` TVL** = what the pool holds at the **day's end**, valued at **that day's prices** (the rule of an exact fee day, `lib/feehist.mjs` `exactUsd`: the candle's close for GeckoTerminal's base token, the pool's own price at the reading for the other; no close within 3 days: the pass's prices). A reading taken **within the first hour of a UTC day** is the day before's end (the `y` days run from one 00:05 to the next, and the candle closes at 00:00). `src`:
  - `'r'` **recorded**: a v3-style pool's two token balances, `balanceOf(pool)` on token0 and token1, read by **the pass itself** at its block, in the same multicall as its fee counters, by the first pass in the hour after midnight (from now on).
  - `'b'` **backfilled**: the same two balances at an **archive block**: they ride in the backfills' 00:05 reads (the batch that reads the pool's row at that block, so one multicall per pool-day), while that day has no reading. The deep backfill asks those days too (`lib/tvlhist.mjs` `tvlMoments`), newest first, the largest pools first, within its own caps (below). The balances count only with the pool there at that block (its slot0 shows it; a token answers 0 for an address with no code, which is never taken as a TVL of 0).
  - `'m'` **map**: a **v4 pool's** tokens sit in the shared PoolManager, so no balance is its own. Its TVL is the value of its **liquidity map** (the positions' principal at the reading's price): the pass's own map (from now on, first hour after midnight), or a past map the persistence check reads (10, 20 and 30 days back) when that moment falls in a day's first hour. Every other past v4 day is null and counted **not readable** (reading a whole map at one block a day is hundreds of calls a pool-day; nothing is estimated).
  - **What balanceOf counts**: everything the pool contract holds: the positions' principal, LP fees earned and **not yet collected**, the **protocol's cut not yet collected** (v3 `protocolFees`), and any tokens sent to the pool by mistake. So a v3 day reads a little above its map (the scan's `map value v3` check: the map is at most the balances). A map (`'m'`) counts the principal only.
  - **One reading a pool-day**: the first taken, never replaced or read again.
  - **Base**: its archive nodes keep about 90 days (`lib/chains.mjs` `archiveDays`). No balance is asked for an older day, by either backfill; those days stay null and are counted not readable. `ytp.from` = the first day still readable, and it moves forward a day a day, so a Base day not read in time stays null.
  - `ytp` = `{ b, r, m, lim, from }`: days from each source; `lim` = `null` (every past day can be read: Ethereum v3), `'archive'` (days before `from` are past the archive's reach: Base v3), `'v4'` (no past balance: map readings only); `from` = that first readable UTC day (ms) for `'archive'`, else `null`.
- **Caps.** The pass's own balances add 2 calls a v3 pool to a multicall it makes anyway, once a day. The archive days share the deep backfill's budget (`FEEHIST.deep`: at most 10 days a pool a pass, the fee history's and the TVL's together, newest first; 40 batches on Ethereum, 12 on Base; at most 250 calls a batch, the balances counted; within the backfill's 60 s on Ethereum, 25 s on Base). A day the regular backfill reads at 00:05 carries the balances in the same batch. Which pool-days ask for balances is fixed before the plan, so a batch's calls are the same when planned, read and parsed. The deep backfill's public counts (`fee history: … deep backfill …`) include the TVL's archive days. The first real pass (pools run 43637562059, 14 Nov 2026) read 1,390 pool-days in its 52 deep batches, in 8 s on Ethereum and 1 s on Base (the scan step 344 s, as before), with about 37,400 readable pool-days left: about 27 passes (3 to 4 hours of the loop) for the year, Base's 90 days sooner. Its median of yesterday's TVL ÷ the pool list's was 1.05 over 139 pools. Only about half the pool-days had a candle volume then (cause not checked: GeckoTerminal's free candles may reach about 6 months, and some v4 pools are not on it); those days stay null until the swaps fill them.
- **Kept** in `snapshots.json` `tv` (below); the year of rows is rebuilt from it every time `history.json` is written.
- **Public log**, counts and two ratios only: `tvl history: N pool-days of D with a value (B from balances at archive blocks, R recorded by the passes, M from liquidity maps), G not readable (V v4 days before recording, A past Base's archive reach), O still to read; this pass +n (b balances, r recorded, m maps), U reads unread; yesterday ÷ the pool list's TVL median R over P pools` and `volume history: N pool-days of D with a value (S from swaps, G from candles), U unread; swaps÷candle median R over K days` (candle days of $1,000 or more). Sealed checks `tvl history` and `volume history`: each median within 25% of 1, once 20 pools or days have both.
- **Never in a score.** `yv`, `yt` and the `tv` cache feed `history.json` only: never the windows, the gem, the lenses, the backtest or any score (the windows' `tvlUsd` stays the pool list's balances, or the map). `test/tvlhist.test.mjs` proves it statically (no scoring module, nor anything it imports, can see `lib/tvlhist.mjs` or these fields) and by taint (the history × 1,000 changes no window, gem or lens), each with a planted leak it catches; `test/tvlhist-scan.test.mjs` runs the scan with every balance × 1,000,000 and finds every window and gem unchanged.
- **Size**, sealed, made-up data of the same shape (`test/tvlhist.test.mjs`), 300 pools with a full year: `yv` + `yt` + `yvp` + `ytp` add about 0.9 MB to `history.json` (about 3 KB a pool; `y` + `yp` alone are about 0.8 MB); in `snapshots.json`, `tv` adds about 1.0 MB (one value, one price and one character a pool-day, like `sx`).

- **On the page (v0.6.0)**: the pool workspace's History tab draws `y`, `yv` and `yt` as three charts on one date axis (Fees and Volume as bars, TVL as a stepped area), each with its own $ axis from 0. The day card and the day table name each day's source (`s`/`x`/`e`, `s`/`g`, `b`/`r`/`m`); `[null, null]` is a hatched gap and reads "not read", never 0; a `null` TVL day that `ytp` says can't be read (`lim` `'v4'`, or `'archive'` before `from`) reads "—" with that reason. "All combined" stacks the pair's pools: a day with any pool that existed but wasn't read is a gap, never a smaller total; a pool before its first row (its `yp.age` known) adds nothing. The made-up fixtures (`tools/fixtures/make-fixture.mjs`) carry all four fields with unread days, a v4 pool with map days only recently and on the 10/20/30-day marks, and Base pools limited to 90 days.

### Exact fees from the swaps: `'s'` (the owner's "exact fees", 14 Nov 2026)

The counters' day (Δ feeGrowth × the interval's liquidity) uses one liquidity figure for the whole day, so a day on which a large LP adds or removes liquidity is mis-stated. The swaps don't depend on liquidity: `lib/exactfees.mjs` sums each pool's UTC day from its own events.

- **A day's LP fees** = Σ over its swaps of the input amount × the swap's fee rate × (1 − the protocol's share), plus v3 flash-loan fees (less the protocol's share) and v4 donations (both go to the LPs, as in the counters). Signs as `lib/swaps.mjs` (v3: the pool's side, positive = paid in; v4: the trader's side, negative = paid in). Uniswap v3: the pool's tier, the protocol's 1/N per input token from `slot0.feeProtocol`; PancakeSwap v3: the pool's tier less the protocol part each Swap event carries; v4: each event's own fee (dynamic fees included) less `slot0.protocolFee` for the direction. **Read, never assumed:** the setting at the block before the day, followed through the day's `SetFeeProtocol` / `ProtocolFeeUpdated` events (read with the swaps), must arrive at the setting read at the day's last block; anything else leaves the day unread. A pool created during the day counts from its creation (the setting at the day's end, or a v3 change event's old value; a v4 pool whose protocol fee changed on its creation day is unread).
- **A day counts only when all of it was read:** its first block (the first with a timestamp at or after 00:00 UTC, found from block headers, `firstBlockAt`) and last (the block before the next day's first), every log chunk in between (1,000-block chunks on Ethereum, 10,000 on Base, `lib/logs-adaptive.mjs`, read with the scan's own 24 h settings since 21 Nov 2026: 30 s a call, a chunk asked 3 times before it is halved, down to 25 blocks on Ethereum, `EXACT_LOGS`; an unread stretch is null, never "no events"), and the pool's state at both ends through archive nodes with each block's own timestamp (a node answering an old block with today's state is dropped). Anything less leaves the day unread: never a partial sum. A pool not there by a day's end has no day (`s0`).
- **Read once, kept:** a UTC day is read 30 minutes after it ends, and kept in `snapshots.json` `sx`; a day held is never read again (each new day costs one read per group of 40 pools; since 21 Nov 2026 a group also holds at most 15,000 swaps a day by the scan's own 24 h count, `EXACT.maxWeight`, so a busy pool's day is a job of its own: a probe read one day of 40 busy pools in 83 s, over Ethereum's 60 s, and such a job, read again from its start each pass, had held its slot every pass). Newest days first, the pools in the dashboard's order (gem first), back to a pool's creation and at most 365 days, within each chain's caps per pass (`lib/chains.mjs` `caps.exact`: Ethereum 60 s and 600 calls, Base 45 s and 400; the two chains side by side); the rest waits for the next pass. A chain whose own 24 h swap read got no answer at all that pass waits (its log nodes are not serving); one its swaps cap cut short still reads within its own cap. Base's archive nodes keep about 90 days (`lib/chains.mjs` `archiveDays`): a day whose start state they no longer serve (its start minus an hour, the state read's range, older than the reach) is never asked, by the exact fees or by the fee counters' deep backfill, so no call is spent on a read that would only fail. Those days stay null in `sx` (estimated in `y` where a candle has them); the public line's coverage counts the readable days, and `(N past the archive's reach)` the pool-days not held before it.
- **Valued** as the counters' days are: kept as `[q, px]` (`q` = token1 raw units with token0's side converted at `px`, the pool's own price at the day's last block), priced at the day's close (`lib/feehist.mjs` `exactUsd`).
- **Cross-check** (public log, one line `exact fees: …`, counts, one ratio and seconds only): `N pool-days from swaps, median swap÷growth R over M days, K days differ >20%` on the days with both (the counters' ≥ $10), then per chain the days added, jobs read and unread (with why), jobs left and by which cap, coverage (days held of the days each pool can have since its creation, within the year) and seconds and calls. The sealed check `exact fees` passes with the median within 10% of 1 over 20 days or more; a day far apart is expected where liquidity moved within it.
- **The day's volume too** (14 Nov 2026): Σ each counted swap's input amount, token0's side at `px` (`sx` `v`), drawn as `yv` `'s'` (above). Days held from before have none and keep the candle.
- **Never in a score**, as the rest of `y`: the windows read the raw tiers only.

## snapshots.json

The raw state each pass reads, from which every time window is recomputed (`lib/snapshots.mjs`, `lib/windows.mjs`).

```
{
  v: 1, t: <ms>, fix: 2,
  pools: { "<id>": { h: Tier, d: Tier,      // h: first row of each UTC hour, 14 days; d: first row of each UTC day, 90 days
                     nb: <ms>,              // optional: the latest moment a backfill found the pool not there yet
                     y: Deep } },           // optional: the fee history's deep record (lib/feehist.mjs)
  gt: { "<id>": { t: <ms fetched>, b: 0|1|null, d0: <UTC day ms>|null, v: [<volume USD|null>], c: [<close USD|null>] }
              | { t: <ms>, miss: <ms> } },  // GeckoTerminal's day candles, the last 366 days; miss = not on GeckoTerminal
  sx: { p: { "<id>": { c: "<chain>", t: <ms last scanned>, d0: <UTC day ms>|null, q: [<n|null>], px: [<n|null>], v: [<n|null>]?, s0: <ms>? } },
        b: { "<chain>": { d0: <UTC day ms>, n: [<block|null>] } } }   // the exact fees (lib/exactfees.mjs)
  tv: { "<id>": { c: "<chain>", t: <ms last scanned>, d0: <UTC day ms>|null, q: [<n|null>], px: [<n|null>], s: "<r|b|m|. a day>" } }   // the TVL readings (lib/tvlhist.mjs)
}
Tier = { t: [<ms, then deltas>], block: [<n, then deltas>], sqrtP: ["<decimal>"], tick: [<n>], L: ["<decimal>"],
         fg0: ["<decimal>"], fg1: ["<decimal>"], parked: [<basis points>] }   // parallel arrays; null = unread
Deep = { d0: <UTC day ms>|null, q: [<n|null>], px: [<n|null>], r: Tier, nb: <ms>? }
```

- **`y` (Deep)**: every exact day of the year, as columns from `d0`: `q` = the day's LP fees in token1 raw units (token0's side converted at `px`), scaled to 24 h; `px` = token1 raw per token0 raw at the day's end (6 significant digits; `null` = no exact fee that day). Kept once the tiers let a day's rows go. `r` = the few raw rows (near 00:05) the deep backfill still pairs (the frontier, usually 0 to 2). `nb` = the latest moment a deep read found the pool not there yet: nothing at or before it is asked for again. `merge` carries it unchanged; the windows never read it. Base's goes with Base's rows (`live.json` `stored`).
- **`sx`**: the exact fees' days, one entry a pool: `q`/`px` columns from `d0` as the deep record (`null` = not read or not held: never 0; a real 0 is a day read with no swaps), `s0` = the first day the pool can have (its creation day, or the day after one a read found it not there by its end). `b` = each chain's UTC day starts (the day's first block), so a day's blocks are found once. A pool not scanned for 30 days is dropped; a loop of older code rewrites `snapshots.json` without `sx` (it comes back as the new code reads).
- **`sx` `v`**: the day's swap volume (`yv` `'s'`), in token1 raw units with token0's side at `px`; present only when a day has one (days read before 14 Nov 2026 have none).
- **`tv`**: the TVL readings, one entry a pool: `q` = what the pool held at the day's end in token1 raw units (token0's side converted at `px`), `px` = token1 raw per token0 raw at the reading (6 significant digits), `s` = one character a day, its source (`r`, `b`, `m`; `.` = no reading: never 0). A pool not scanned for 30 days is dropped; a loop of older code rewrites `snapshots.json` without `tv` (the readings come back as the new code reads, the past ones from archive blocks again).
- **`gt`**: the candle cache, one entry a pool: `b` = which of the pool's tokens GeckoTerminal's base is (its close values that side), `v`/`c` columns from `d0` (`null` = no candle that day: never 0). Kept for 30 days after a pool was last asked for. A loop of older code rewrites `snapshots.json` without `y` and `gt` (they come back as the new code runs).

- **What reads what.** `history.json` charts every row. The time windows read exactly what they always read: 7 days of the hourly tier (windows up to 7 days) and 30 days of the daily one, each plus one step (`lib/windows.mjs` `READS`), so `24h`, `7d` and `30d` are unchanged by the longer store (`test/windows.test.mjs`); a configured window longer than 30 days would read its own span of daily rows.
- **Never a pre-creation row.** A row with no price read and both fee counters at exactly 0 is what a pool that did not exist yet answers (a v4 pool before its initialisation reads 0 everywhere); it is never stored, and an older store holding one loses it on load. Stored, it would book the pool's whole lifetime of fees into its first real interval.
- **Backfill** (`lib/backfill.mjs`, run by the scan through archive nodes: drpc, mevblocker, blockscout). Each pass asks for the moments a pool's series is missing: 5 minutes past each empty UTC hour of the last 14 days and past the first hour of each empty UTC day of the last 90 (one read fills a day and its first hour). Order: the 24h window's hours, the 30d window's days, the 7d window's hours, then the older days, then the older hours; newest first. Budget per pass: at most 120 batches (one block and up to 250 calls each, 3 at a time) and none started after 60 seconds; whatever is left is still missing next pass, so the backfill resumes by itself until both tiers are full, and costs nothing once they are. Each moment's block comes from the (time, block) pairs the store holds; where the moments reach past them, a few block timestamps are read first, one every 3 days, so the clock interpolates instead of extrapolating (missed slots make a plain 12 s a block land hours off at 90 days). Each batch's own block timestamp (Multicall3) must be about as old as its block: a node that answers an old block with today's state is dropped. A pool not there yet at a moment (a v3 address with no code, a pool not initialised, a v4 pool StateView reads 0 for) gives no row; the moment becomes `nb`, and nothing at or before it, or before the pool's creation event, is asked for again. A row a few minutes off its mark is real data and is kept. The past maps (10, 20 and 30 days ago, for the persistence check) now carry their block timestamp too, and become full snapshot rows with their parked share.
- **Size**, sealed, for about 100 pools: about 1.7 MB with 7 and 30 days, about 3.6–3.8 MB with 14 and 90 (made-up data of the same shape).

## backtest.json

```
{
  v: 1, t: <ms>, ticket: <usd>, provisional: true,     // provisional until the 14-day gate
  pools: { "<id>": { "24h": Backtest|null, "7d": Backtest|null, "30d": Backtest|null } }
}
Backtest = {
  days: <days covered>, partial: <bool>, range: <half-width r, log>, trigger: "exit",   // the "ours" strategy's settings
  forecastNet: <the scanner's net APR at the window start>,
  net: <annualised, steady state: excludes the one-time entry cost, like the forecast>,
  netUsd, feesUsd, lvrUsd, costsUsd, entryUsd,          // $ over the window; lvrUsd and costsUsd ≤ 0; netUsd includes entryUsd (≤ 0)
  tir: <time in range 0..1>, reranges, share: <share of pool fees>, sigma, sigmaFrom: "pool"|"market", swaps,
  series: { t: [], px: [], lo: [], hi: [], fees: [], lvr: [], costs: [], net: [] },   // cumulative $ vs holding the
                                // starting tokens: fees ≥ 0, lvr ≤ 0, costs ≤ 0, net = fees + lvr + costs; lo/hi = range edges
  strategies: [{ id, name, net, netUsd, reranges, series: [] }],                       // ours, tight, wide, gamma, arrakis, full
  grid: { widths: [<r>], triggers: ["exit", "exit+12h", "exit+24h", "drift50", "drift75"], net: [[<apr>]] },
  revert: { net: <n|null>, within10: <bool|null> },     // Revert's backtest of the same range: no public API, so null
  realCheck: { positions: <n>, within2: <n>, median: <ratio|null> } | null   // simulated fee per unit L vs real
                                // in-range positions' actual fee growth over the same window
}
```

### Token links (`pool.t0/t1.links`, lib/links.mjs)

The page makes a token's symbol a link to read about the coin: `https://coinmarketcap.com/currencies/<cmc>/` when `cmc` is set, else `https://www.coingecko.com/en/coins/<cg>`, else plain text (also for data published before the field, which has no `links`). Nothing is guessed from a symbol:
- **Wrapped and native tokens** come from an explicit map by chain and address (`WRAPPED`): WETH (Ethereum, Base) and native ETH → Ethereum; WBTC and cbBTC → Bitcoin.
- **`cg`** is the pool list's coin id (the universe's CoinGecko coin, or the quote's); when that is missing, CoinGecko's contract lookup (`/coins/{ethereum|base}/contract/{address}`, the Demo key in a header, within the daily budget, at most 10 a pass), kept only when the answer lists that very address.
- **`cmc`** only with the Actions secret **`CMC_API_KEY`** (passed to the scan in `loop.yml`, `pools.yml` and `diag.yml`; never a dispatch input, never printed): CoinMarketCap's `/v2/cryptocurrency/info?address=<address>` (free Basic plan, header `X-CMC_PRO_API_KEY`), one address a call, at most 30 a pass, kept only when exactly one coin answers and it lists that address among its contracts. Without the key `cmc` is null and the page links CoinGecko. A 401/402/403/429 stops the lookups for the pass.
- **Cache** `out/cache/links.json` (`{ v: 1, cg: { "chain:addr": { v, t } }, cmc: { … } }`, public market data, kept with the loop's other caches): a found answer for 30 days, a miss or a failed call until the next UTC day; a failed call keeps an earlier answer.
- **Public log:** counts only, e.g. `links: 48 cg, 0 cmc, 2 none · cmc key: absent · lookups 2 cg, 0 cmc` (`cmc key: present|absent` doubles as the key check; `lookups` = calls sent this pass) (`cg` = tokens whose link goes to CoinGecko).


## D1 archive: the permanent history (lib/d1.mjs, db/schema.sql; docs/briefs/SQL-plan.md part 1, 22 Nov 2026)

`history.json` keeps a year of days and 14 days of hours; the archive keeps both **for good**, in a Cloudflare D1 database named **`assim-ls-archive`** (with the read API's Worker `assim-ls-api` and KV namespace `assim-ls-auth`, the only Cloudflare resources this project creates or touches: anything not named `assim-ls*` is never listed, read or changed). **Market data only**, plain so SQL can read it: exactly the rows `history.json` holds, never an owner field, a guest, a key or the inbox. A pool whose id or token is one of the sealed config's `leakSensitive` strings is never written. Nothing is published: the rows are reached with the Actions secrets, or read-only through the Worker behind a login ("Archive API" below).

- **Tables** (`db/schema.sql`, versioned `-- migration: N` blocks applied once each, recorded in `schema_migrations`; WITHOUT ROWID, so one row written a row):
  - `pools(pool_key, pool_id, chain, dex, version, fee_tier, token0, token1, symbol0, symbol1, created_at, written_at)`: `pool_key` a short integer for `pool_hour`; `pool_id` = `history.json`'s key (lowercase hex).
  - `pool_day(pool_id, day_utc, fees_usd, fees_src, fees_rank, fees_unconfirmed, volume_usd, volume_src, volume_rank, tvl_usd, tvl_src, tvl_rank, price, lp_fee_rate, revisions, written_at, revised_at)`, key (`pool_id`, `day_utc` `'YYYY-MM-DD'`): `y`, `yv`, `yt` row by row (the same codes: fees `'e'`, `'x'`, `'s'`; volume `'g'`, `'s'`; TVL `'r'`, `'b'`, `'m'`), `fees_unconfirmed` = 1 when the day is in `u.y`, `price` = the daily row in the next UTC day's first hour (the day's end), `lp_fee_rate` = fee tier × `lpKeeps` as known when first written (null when either is unread).
  - `pool_hour(pool_key, hour, sec, span_s, fees_usd, fees_rank, price, liquidity, parked, revisions, written_at)`, key (`pool_key`, `hour` = the UTC hour's start in hours since 1970): one `h` row; `sec` = the row's own time within the hour, `span_s` = seconds since the row before (its `lpFeesUsd` covers them; null for a pool's first row), fees at the prices of the pass that first wrote it. Only **settled** hours: the hour started at least 2 hours before the pass.
  - `meta(k, v, n)`: `w:YYYY-MM-DD` = rows written that UTC day; `sweep` = the daily sweep's day and its next pool group; `kv:assim-ls-auth` = the id of the API's KV namespace (written by the worker job's deploy, read by the loop's token sync, never printed: "Archive API" below).
  - `pool_day.valued` (migration 2, 23 Nov 2026): how the day's USD figures were valued when written. `1` = at the day's own prices (GeckoTerminal's base token known and a candle closing within 3 days, the rule of `lib/feehist.mjs` `exactUsd`): a fact, frozen. `0` = at the prices of the pass that wrote it (no such close): `history.json` values those days at each new pass's prices, so its figure drifts with the token price; the archive keeps the first. `NULL` = written before migration 2, treated as `0`.
- **Nothing is ever overwritten.** A row is inserted once. A field changes only when the new row's source **ranks higher**: fees `'e'` 1 < `'x'` 2 < `'s'` 3, volume `'g'` 1 < `'s'` 2, TVL any reading 1 (one reading a day: the first stays), unread 0. A figure valued at a pass's prices (`valued` 0 or NULL) is replaced by the **same source valued at the day's close** (`valued` 1) when that figure differs, and never otherwise: a pass's prices never replace the day's close, nor another pass's prices. A null gains a value (`price`, `lp_fee_rate`, an hour's price, liquidity or parked) but never replaces one, and a value is never replaced by null or by a source no better: missing stays null, never 0. `fees_unconfirmed` moves with its fee (or with a better volume for the same fee source, the evidence behind the flag). An hour's fees are replaced only by a **narrower span** at the same moment (a gap before it was backfilled: the gap now has rows of its own, so the old figure would count it twice). Each change adds 1 to `revisions` (days also set `revised_at`). The rule is the upsert's own `WHERE` in D1, so a writer of older code can't break it; `dayUpgrade`/`hourUpgrade` mirror it so the sweep sends only upgrades (`test/d1.test.mjs` runs both on SQLite and proves they agree; planted faults (no fee guard, a rank that can fall, a price replaced) are each caught).
- **Writer in the loop** (`scripts/scan.mjs`, after every sealed file of a pass that rebuilt `history.json`, about hourly): the settled hours of the last 4 hours (about 1,200 rows for 300 pools, written only when new); plus **once a UTC day from 01:00** the **sweep**: groups of 40 pools, each group's stored ranks read (`/raw`) and only the rows D1 lacks or holds from a worse source written, resumed by the next pass where a 150 s cap stopped it. A day that turns exact later in the day is written by the next day's sweep. Secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN` reach the scan step through `loop.yml`'s env only.
- **Never fails the pass.** One public line, counts only: `d1: 300 pools, 300 day rows, 1,200 hour rows written · daily sweep done` (`(+N pool rows)` for new pools; `· stopped by the time|budget cap`), `d1: skipped` without the secrets, `d1: error <category>` (`auth`, `network`, `timeout`, `rate`, `server`, `limit`, `size`, `sql`, `nodb`, `account`, `answer`, `request`, `internal`: a word from the status and fixed patterns, never the API's text, the account, the token or a URL), `d1: idle (history.json unchanged this pass)`. Each request has a 15 s limit and one retry (429 and 5xx only).
- **Limits** (D1 free plan): a statement is at most 100 KB, so each is under 90 KB and 400 rows, values inlined as SQL literals (whitelisted source codes, finite numbers, strings with control characters dropped and quotes doubled). The account may write 100,000 rows a day: these writers keep to **80,000** (`meta` counts what D1 reports written), and the sweep and the import stop **12,000** short of that, which the passes' hours keep. Rows read: the sweep reads each pool's stored ranks once a day (about 200,000 rows), the passes about 1,500 rows each, far under the free 5 million. **Storage**: about 110,000 day rows (about 15 MB) and 2.6 million hour rows (about 170 MB) a year for 300 pools, against the free plan's 500 MB a database: the hours fill it in about 2.5 years (then a yearly hours database, or a coarser tier, is the owner's call).
- **Jobs** (`.github/workflows/d1.yml`, dispatch only, `scripts/d1.mjs`): `check` (the token works; the database exists: yes/no; its schema version), `setup` (create it if missing; apply the migrations not applied yet), `import` (the sweep over the data branch's `history.json`, restored and opened inside the job; idempotent; resumes after a cap: run it again, the next UTC day for the budget), `verify` (rows, date ranges and source counts per table; coverage: how many of `history.json`'s pools D1 holds days of; 1,000 random pool-days over 4 days old of those pools (`sample` input, up to 2,000), D1 against `history.json` like with like, field by field: `match`; `revalued` (both at a pass's prices: D1 keeps the first figure, and every figure of a pool written together (fees, swap volume and TVL, the same 10 minutes) must move by one ratio within 0.3%, or the group counts as `differ`); `behind` (the history has a better source or the day's close since: the next sweep takes it); `differ` (a figure at the day's close moved, another source at the same rank, D1 ahead, or an inconsistent revaluation); `missing`; FAIL on any `differ` or `missing`. Each field's figures that differ are counted by source and age with the median and p90 of |ratio − 1|; counts and ratios only).
- **Why (verify run 45133162501, 23 Nov 2026):** 477 of 1,500 pool-days differed, all fees `'x'` and TVL `'b'` at the same source, 418 of the 1,103 sampled days over 90 days old and almost none younger, median |ratio − 1| 0.7% (p90 1.2%), and in every pool one ratio for all its differing days, fees and TVL alike (95 of 95 pools, 212 of 212 days): `history.json` revaluing days with no candle close at each pass's prices, not a writer fault, a source revision, the TVL's first reading or rounding (volume and price: 0 differ). The first import (run 45064690647, 22 Nov 2026) wrote 37,045 day rows and 30,456 hour rows for 212 pools in 45 s and stopped at the day's budget after 2 of 6 groups: the next run, or the loop's daily sweep, takes the rest. A new pool costs 2 rows written (its row and the `pool_id` index). Public log: yes/no, counts, dates and category words only.

## Archive API: the D1 archive, read-only, behind a login (worker/, lib/apitoken.mjs, lib/apiauth.mjs; docs/briefs/SQL-plan.md part 2, 23 Nov 2026)

The owner's picks for the History archive views: **A** (History ranges extend to ALL, with an hourly zoom on any past week) and **C** ("Find days" presets). This is their backend: the Cloudflare Worker **`assim-ls-api`** on the account's workers.dev subdomain (the token has no zone rights), bound to the D1 archive (`DB`), the KV namespace **`assim-ls-auth`** (`AUTH`, token hashes only) and the build (`BUILD`). Plain module syntax, no dependencies, uploaded through the REST API (`worker/index.mjs`, the entry, exports only the handler; `worker/api.mjs` holds the logic and the SQL). Market data only: exactly what the archive holds.

- **Requests:** `GET` only, `Authorization: Bearer <token>`. Answers are JSON with `cache-control: no-store`, `x-robots-tag: noindex, nofollow`, `nosniff`, `referrer-policy: no-referrer`. **CORS:** only `https://kereslek.github.io` (a preflight from it may send `authorization`); a request with any other `Origin` is refused (403 `origin`); one with no `Origin` (a job) needs a token like any other. **Errors:** the body is one word: `auth` 401, `rate` 429, `input` 400, `notfound` 404, `method` 405, `origin` 403, `server` 500 (never the error's text), `unavailable` 503. Every input is validated before any query, unknown or repeated parameters included; every query is parameterised.
- **`/v1/meta`** → `{ v: 1, t, role, api (the build, 12 characters), schema, pools, days: { pools, from, to (YYYY-MM-DD) }, hours: { pools, from, to (ms, hour starts) }, lastWrite (ms), writtenToday, sweep (YYYY-MM-DD), limits: { dayRows, hoursDays, findMax, findDays: [7, 365] } }`. Kept 2 minutes in the isolate.
- **`/v1/days?pool=<id>[&from=YYYY-MM-DD][&to=YYYY-MM-DD]`** (both optional: ALL) → `{ v: 1, pool: { id, chain, dex, version, fee_tier, token0, token1, symbol0, symbol1, created_at (ms) }, from, to, more, cols, rows }`, `cols` = `day, fees_usd, fees_src, fees_unconfirmed, volume_usd, volume_src, tvl_usd, tvl_src, price, lp_fee_rate, valued` (the archive's own fields and codes, "D1 archive" above), oldest first, at most 4,000 rows (`more: true`: ask again from the last day). An unknown pool: 404.
- **`/v1/hours?pool=<id>&from=<instant>[&to=<instant>]`**, an instant being `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS[.sss]]Z` or unix ms; `to` defaults to `from` + 7 days, at most 8 days a call → `{ v: 1, pool, from, to (ms), cols, rows }`, `cols` = `t, price, liquidity, fees_usd, parked, span_s`: `history.json`'s `h` row shape (`t` = the row's own time, `fees_usd` covering the `span_s` seconds before it, at the prices of the pass that first wrote it), plus `span_s`. The hour holding `from` is in, the hour starting at `to` is not.
- **`/v1/find?q=<preset>[&days=30][&chain=any|<chain>]`** (`days` 7 to 365) → `{ v: 1, q, days, chain, from, to, n, rows: [{ pool, day, value, multiple, mark, n }], pools: { <id>: { chain, dex, version, fee_tier, symbol0, symbol1 } } }`, at most 200 rows, ranked. The window is whole UTC days ending yesterday (today is still open); only days whose fees were read count (missing is never zero). Kept 5 minutes in the isolate.
  - `spikes10x`: every day at or above **10×** its pool's median of the window, highest multiple first. The median is the page's (v0.7.7 `hsMarks`): over the **confirmed** days (fees read, not unconfirmed), the middle one or the mean of the two middle ones. `value` = the day's fees, `multiple` = ÷ the median, `mark` `'h'` (★ high) or `'o'` (⚠ outlier: see below; it wins, so a glitch never looks like a great day), `n` = the confirmed days behind the median.
  - `outliers`: the page's ⚠: at least **3×** the median **and** either unconfirmed (`fees_unconfirmed` 1) or its fee÷vol over **2.5×** or under **0.4×** the median fee÷vol of the confirmed days with volume. `mark` `'o'`.
  - `doubled`: week on week, the weeks ending yesterday (7 days each, `floor(days / 7)` weeks compared, each with the week before it): a week's mean fees a day over its confirmed days with fees read, **at least 5 of 7** in both weeks, at least **2×** the week before. `day` = the week's last day, `value` = its mean fees a day, `multiple` = ÷ the week before, `mark` `'p'` when either week has fewer than 7 such days, `n` = this week's days.
  - `quietest`: each pool's fee APR over the window, the mean of its days' fees ÷ TVL × 365 (confirmed days with both read and TVL > 0), among pools with at least half the window's days (3 at least); lowest first. `day` = its last such day, `multiple` = ÷ the median APR of every pool that qualified, `mark` `'p'` when it rests on fewer days than the window, `n` = its days.
  - `test/worker.test.mjs` runs each preset on SQLite with the archive's schema and random made-up pools against the page's rule (copied) and these definitions, row by row; planted faults (another median, unconfirmed days in it, no fee÷vol test, a different threshold, a week of one day, unconfirmed days doubling a week, a zero TVL) each disagree.
- **Rows read** (D1's free plan: 5 million a day): every query seeks by a primary key; the presets go pool by pool from the small `pools` table (`CROSS JOIN`, so SQLite keeps it the outer loop), and `meta`'s ranges come from per-pool `MIN`/`MAX` seeks, never a scan (the test checks each query plan). A 30-day find reads about the window's rows (300 pools × 30 days) a few times over.
- **Tokens** (`lib/apitoken.mjs`, the function the page build copies, plain WebCrypto): `lps1.` + base64url(HMAC-SHA256(key, `'assim-ls-api/v1|' + label`)), 48 characters. The **owner**: key = the private key, label `owner|g<gen>` (from the master slot: `apiTokenFor(m)`, i.e. `apiToken(m.pk, ownerLabel(m.g))`). A **guest or member**: key = the market key, label `slot|<slot id>` (from their own slot: `apiTokenFor(g)`, i.e. `apiToken(g.k, slotLabel(g.s))`). No key that decrypts data is ever sent; only the owner holds the private key, so no slot holder can make the owner's token, and a slot id sits inside its own slot, so no guest can make another's. A new market key (a guest removed or expired, "remove all guests") changes every slot's token, and the owner's through the generation.
- **KV `assim-ls-auth`** holds `t:<SHA-256 of the token, hex>` → `{ r: 'owner'|'member'|'guest', e: <hard end, ms>|null }` (metadata `{ r, e, k: 'o'|'s'|'p', g }`, a KV expiration at the end), plus `m:keys` (when this generation was first seen). Nothing else about a token is kept or logged. The Worker refuses a malformed token, an unknown hash, a bad shape or a role it doesn't know, and an end in the past (checked on every request, cached or not); a valid hash is kept a minute in the isolate (KV's own edge cache another minute), so a removed hash stops working within about two minutes. The guest's 30-day device clock stays the page's: the API knows the hard end only.
- **The loop keeps it in sync** (`lib/apiauth.mjs` `authSync`, called by `scripts/loop.mjs` after the keys step at the start and after each pass's keys step that went through, live mode only, before the publish): the owner's hash, each live guest's or member's (from `keys.json`, opened with their key from `guests.json`: the very token their page derives) with its role and hard end, and for **6 hours** after the market key changes the live slots' and the owner's hashes of the generation before (a page still holding the old `keys.json` is not refused while the new one reaches it; the start is kept in `m:keys`, so a new loop run never extends it). A removed or expired guest's slot is not live: its hashes go at once. Any other `t:` hash is deleted, except the worker job's own test entries (`k: 'test'`, 10 minutes). It sends a request only when the wanted set changed (or every 3 hours, and at each loop run's start). Never fails a pass: one public line, counts only: `api auth: 3 tokens (owner 1, guests 1, members 1); 3 written, 0 removed` (`; in sync`, `, grace 2`), `api auth: skipped` (no secrets, `(no key slots)`, `(no archive database)`, `(not deployed yet: worker deploy)`), `api auth: error <category>` (`auth`, `network`, `timeout`, `rate`, `server`, `notfound`, `request`, `answer`, `keys`, `guests`, `internal`), printed at the start, on a change and on a new error.
- **Rate limits** (counters in each isolate): 120 requests a minute per token hash, 20 finds a minute; an address with 60 refused tokens in 10 minutes gets 429 before any KV read (a token already known good still passes).
- **Jobs** (`.github/workflows/worker.yml`, dispatch only, `scripts/worker.mjs`; the API's tests run first): `deploy` (the namespace: its id from the archive's `meta`, else the Worker's own binding, else made now, and recorded; never a listing of the account; the Worker uploaded with its bindings and compatibility date, its workers.dev route on; prints the host, public anyway, and a smoke check: no token → 401), `test` (three made-up tokens put in KV for 10 minutes: preflights, no, malformed and ended tokens, another origin, meta, the four presets, days ALL and a range from a pool the presets name, hours, the 8-day limit, bad and unknown pools, presets, parameters, routes and methods, headers and one-word refusals on every answer, a token removed mid-test refused within 3 minutes; the rate limit shown, not judged; the KV entries counted by kind; status codes, row counts and pass/fail only; the tokens removed at the end, and a `cleanup` step after it always), `sync` (the loop's sync once, inside the job, from the restored sealed key slots, then the owner's and every live slot's token, derived as the pages derive them, must be accepted with their roles), `cleanup` (any test entry left). Public log: yes/no, status codes, counts, seconds, the host and category words (Cloudflare's numeric error codes at most): never the account, an id, a token, a hash or a value.
