# Data contract (v1): what the scanner publishes and the dashboard reads

This file describes shapes only: it holds no data. Every value below lives sealed.

## Files and where they live

| File | Sealed | Written by | Rewritten |
|---|---|---|---|
| `lock.json` | no (salt, rounds, a sealed check string) | lock init, once | never; a new passphrase means a new lock |
| `live.json` | yes | every scanner pass | each pass |
| `history.json` | yes | scanner | when a pool gains an hourly row (about hourly; every pass while the backfill catches up) |
| `backtest.json` | yes | backtest job | daily and on demand |
| `snapshots.json` | yes | scanner | when a pool gains an hourly row (about hourly; every pass while the backfill catches up) |
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
  pools: { "<id>": { h: [[t, price, liquidity, lpFeesUsd, parked]],    // hourly, last 14 days (≤ 337 rows)
                     d: [[t, price, lpFeesUsd, volUsd, parked]] } },   // daily, last 90 days (≤ 91 rows)
  health: [[t, okPasses, passes, unread]]                              // hourly, last 7 days
}
```

Built by `lib/charts.mjs` from `snapshots.json`, one row per stored snapshot row, ascending by `t` (the row's own time: a pass time, or a backfilled block's timestamp). `price` = token1 per token0 (8 significant digits); `liquidity` = the pool's active liquidity (8 significant digits); `parked` 0..1 (4 decimals). `lpFeesUsd` = the pool's LP fees **from the row before to this one** (fee growth × the interval's liquidity, at the pass's token prices), `volUsd` = those fees ÷ the LP fee rate. Rows are not always exactly an hour or a day apart (a gap the backfill has not filled yet, or a row a few minutes off its mark), so a chart of fees per hour or per day divides by the gap to the row before. `null` = unread: the first row, a row whose counters were not read and the row after it. A pool's rows start where its data starts: hours and days before the pool existed have **no row at all** (absent, never a 0 row), and a pool younger than the span simply has fewer rows. Size, sealed, for about 100 pools: about 0.55 MB with 7 and 30 days, about 1.1 MB with 14 and 90 (made-up data of the same shape; 60 days instead of 90 would save under 10%, the 14 days of hours are most of it).

## snapshots.json

The raw state each pass reads, from which every time window is recomputed (`lib/snapshots.mjs`, `lib/windows.mjs`).

```
{
  v: 1, t: <ms>, fix: 2,
  pools: { "<id>": { h: Tier, d: Tier,      // h: first row of each UTC hour, 14 days; d: first row of each UTC day, 90 days
                     nb: <ms> } }           // optional: the latest moment a backfill found the pool not there yet
}
Tier = { t: [<ms, then deltas>], block: [<n, then deltas>], sqrtP: ["<decimal>"], tick: [<n>], L: ["<decimal>"],
         fg0: ["<decimal>"], fg1: ["<decimal>"], parked: [<basis points>] }   // parallel arrays; null = unread
```

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
