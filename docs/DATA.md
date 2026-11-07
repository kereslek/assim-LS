# Data contract (v1): what the scanner publishes and the dashboard reads

This file describes shapes only: it holds no data. Every value below lives sealed.

## Files and where they live

| File | Sealed | Written by | Rewritten |
|---|---|---|---|
| `lock.json` | no (salt, rounds, a sealed check string) | lock init, once | never; a new passphrase means a new lock |
| `live.json` | yes | every scanner pass | each pass |
| `history.json` | yes | scanner | hourly |
| `backtest.json` | yes | backtest job | daily and on demand |
| `snapshots.json` | yes | scanner | when a pool gains an hourly row (about hourly) |
| `inbox.json` | no (the X25519 public key only) | lock init | with `lock.json` |

- **Envelope** (`lib/lock.mjs`): `{"lock":1,"t":<ms>,"z":1,"iv":"<b64>","ct":"<b64>"}`. `z` = gzip before sealing; only `t` is readable, so a staleness check needs no key.
- **Key**: PBKDF2-SHA256(passphrase, salt, `iter` rounds, 64 bytes); the first 32 bytes are the AES-256-GCM key. The page derives it with WebCrypto and inflates with `DecompressionStream('gzip')`.
- **Where**: the data files sit on the `data` branch, one commit that each pass replaces. The page reads `https://raw.githubusercontent.com/<owner>/<repo>/data/<file>?t=<now>` with `cache: 'no-store'`. `lock.json` also ships with the page.
- **Missing is never zero**: an unread value is `null` and the page shows "—". Fractions are 0..1, money in USD, times in ms since epoch, durations in days.

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
  chains: [{ id: "ethereum"|"base", pools: <n>, unread: <n>, block: <n>, gasUsd: <re-range gas in $|null> }],
  health: {
    loop: { passes24h: <n>, ok24h: <n>, lastGapMin: <n|null>, watchdogLast: <ms|null>,   // written by the loop, not the pass
            recent: [[<pass start ms>, <1 ok | 0 failed>]] } | null,                  // the last 24 h of passes plus the one before
    checks: [{ id: "<id>", label: "<short label>", ok: true|false|null, value: <0..1|null>, detail: "<one line>" }],
    sealedLog: { lines: <n>, errors: <n>, categories: { "<word>": <n> } }
  },
  bench: "<pool id>",           // UNI/WETH 0.3% on Ethereum
  pools: [Pool],                // every scored pool, sorted by the default window's gem score
  pairs: { "<addr>-<addr>": Pair },  // every pool of a pair side by side (lib/pairs.mjs); key = the two token
                                     // addresses, lower first, native ETH read as WETH
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
  px: { ETH|BTC|SOL: { usd: <n|null>, ch24: <fraction|null>, src: "defillama"|"coingecko"|null } }
                                    // ch24 = 24 h change as a fraction (−0.031 = −3.1%); DefiLlama first, CoinGecko fills a gap
}
Pair = {
  label: "<SYM>/<SYM>", pools: ["<pool id>"], best: "<pool id>"|null,   // best = highest net APR in the default
                                                                       // window among verified pools with data
  w: { "24h"|"7d"|"30d": { volUsd: <n|null>, lpFeesUsd: <n|null>, unread: <pools without a number>,
       rows: [{ id, volumeShare: <0..1|null>, feesPer1kDay: <USD a day for $1,000 at the price, after dilution|null>, net: <APR|null> }] } }
}
```

`market` feeds the dashboard's top strip, so the page never calls a third party (no CSP holes, no viewer IP sent out). Hosts: gas from the scanner's Ethereum RPCs (`eth_feeHistory` over the last 1024 blocks, or 100 where a node caps the span, with the 50th-percentile reward; `eth_gasPrice` as the fallback); prices from `coins.llama.fi/prices/current` and `coins.llama.fi/percentage?period=24h` (ids `coingecko:ethereum`, `coingecko:bitcoin`, `coingecko:solana`), cross-checked with `api.coingecko.com/api/v3/simple/price` (the Demo key, in a header, when set). Gas and prices each have a 15-second limit and fail separately to `null`; a pass that reads nothing still carries `gas.hist` forward. The countdown uses `next` and "updated" uses `t`.

Check ids in `health.checks`: `fee-identity`, `price-vs-market`, `volume-vs-aggregator`, `maps-complete`, `lp-book`, `creation-events`, `volatility-xcheck`, `fees-vs-aggregator`.

### Pool

```
{
  id: "<v3 pool address or v4 pool id>", chain: "ethereum"|"base", v: 3|4, pair: "<SYM0>/<SYM1>", pairKey: "<key in pairs>",
  t0: { sym, addr, dec, usd: <n|null> }, t1: { sym, addr, dec, usd: <n|null> },
  feeTier: <fraction, e.g. 0.003>, dynamicFee: <bool>, lpKeeps: <fraction LPs keep after the protocol's cut|null>,
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
    depth: [[<log offset from price>, <usd>], ...],   // histogram, ±45%, for the liquidity chart
    walls: { below: <log offset|null>, above: <log offset|null> }
  },
  w: { "24h": Window|null, "7d": Window|null, "30d": Window|null },
  checks: [{ id: "<id>", label: "<short>", ok: true|false|null }],   // the per-pool checklist, e.g. "12/12 checks pass"
  gemFirstAt: <ms|null>,        // first pass where the default window's gem reached gemAt ("new since you last looked")
  daily: [{ t, feesPer1k, net }],   // up to 30 days: USD a day for $1,000 at the price after dilution at the ticket, and
                                    // net of LVR and re-range costs; the latest entry is the last 24 hours
  pattern: "steady"|"bursty"|"emerging"|"fading"|"mixed"|null,
  burst: { maxDay, medianDay, burstDays, oneTrader: <share of the biggest day's fees from its largest tx|null> }
}
```

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
  gem: { total: <0..100|null>, yield, thinness, flow, staying, warnings: ["..."], missing: ["..."],
         tags: ["unconfirmed"|"one-off"|"unchecked"] },
       // Gem now (lib/gem.mjs gemNow): yield now 45 (the median of the last 7 days' net per $1,000 a day) + thinness 25
       // (the day's LP fees ÷ the value at the price) + flow 20 (markout ÷ fee, traders) + staying power 10 (bonus).
       // A failed check → no gem; a safety check not run → capped at 40 ("unchecked"); a data check not run → −5.
  lenses: ["stranded"|"one-sided"|"fresh"|"bigmove"|"calm"|"toxic"],
  spark: { px: [<n>], fees: [<n>] }                    // about 24 points each, for sparklines
}
```

## history.json

```
{
  v: 1, t: <ms>,
  pools: { "<id>": { h: [[t, price, liquidity, lpFeesUsd, parked]],    // hourly, last 7 days
                     d: [[t, price, lpFeesUsd, volUsd, parked]] } },   // daily, last 30 days
  health: [[t, okPasses, passes, unread]]                              // hourly
}
```

## snapshots.json

The raw state each pass reads, from which every time window is recomputed (`lib/snapshots.mjs`, `lib/windows.mjs`).

```
{
  v: 1, t: <ms>,
  pools: { "<id>": { h: Tier, d: Tier } }   // h: first row of each UTC hour, 7 days; d: first row of each UTC day, 30 days
}
Tier = { t: [<ms, then deltas>], block: [<n, then deltas>], sqrtP: ["<decimal>"], tick: [<n>], L: ["<decimal>"],
         fg0: ["<decimal>"], fg1: ["<decimal>"], parked: [<basis points>] }   // parallel arrays; null = unread
```

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
