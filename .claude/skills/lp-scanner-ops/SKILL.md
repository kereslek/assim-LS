---
name: lp-scanner-ops
description: Operate the LP Shape Scanner in this repo. Run a scan in GitHub Actions and read its results, explain a pool's gem score and shape tags, walk the risk checklist before a position is approved, and pause or stop the bot. Use when asked to run, check, explain or pause the scanner, or to review a candidate pool.
---

# LP Shape Scanner operations

The scanner looks for Uniswap pools whose liquidity is parked away from the price, so a position
at the price would earn a large share of the fees. It is read-only until Phase 2. This repo is
public: logs and files here carry market data only. Anything about the owner (watchlist, wallets,
positions, ticket size, personal thresholds) lives sealed, never in code, logs or commits.

## What runs where

| Workflow | Trigger | What it does |
|---|---|---|
| `test` | push to `lib/`, `test/`, `scripts/` | unit tests, made-up data only |
| `probes` | push, dispatch | which RPCs and APIs answer from GitHub; the UNI/WETH 0.3% benchmark map |
| `pools` | push to the scan code, dispatch | step 2: the pool list (`scripts/pools.mjs`); step 3: maps and a day of fees (`scripts/scan.mjs`) |

Every job runs the unit tests first, so a broken check never reads real data.

## Run a scan

1. Dispatch it: `gh api -X POST repos/kereslek/assim-LS/actions/workflows/pools.yml/dispatches -f ref=<branch>`.
2. Wait with a background loop that polls `gh api repos/kereslek/assim-LS/actions/runs/<id>` every 20 s until `completed`. A full run takes about 20 minutes, mostly the DexScreener pass.
3. Read the results from the check-run annotations: `gh api repos/kereslek/assim-LS/check-runs/<job id>/annotations`. The two that matter are titled `pool list` and `maps and fees`; each is a `|`-separated list of `✓` pass, `✗` fail and `·` unread lines.

A healthy run shows:
- 0 unread lookups, and every quote token's decimals as expected;
- recall of listed pools ≥ $300k at or near 100%, with v3 TVL within 15% of the aggregators' (median ratio near 1.00);
- the factory's creation events agreeing with the lookups (no "events only" or "lookups only");
- every map complete (liquidity sums to zero, never negative, the walk equals the pool's liquidity), and map value within −10%…+2% of the pool's balances;
- 24 h volume near DexScreener's.

An unread source shows as `·` and "unread". It is never counted as zero: say what is unread, don't guess.

## Read a pool

**Shape tag** (from the full liquidity map):
- *served*: at most 30% of the value is parked away from the price;
- *mixed*: 30–80%;
- *stranded*: at least 80% parked away, on both sides;
- *one-sided*: at least 80% parked away, almost all of it on one side.

"Parked away" means liquidity above the level active at the price. Wide and full-range positions
include the price, so they count as zero.

**Net APR at the ticket** = fee APR at the ticket − LVR − re-range swap costs − gas.
- Fee APR at the ticket shares the band's fees with the liquidity already there (dilution-aware).
- LVR = 365 · σ² / 8 · C(r), with C(r) = 1 / (1 − e^(−r/2)) for a ±r range.
- The suggested range is r = σ√T, with T = 7 days on Base and 14 on Ethereum.
- Edge = fee APR ÷ LVR. Below 1, the pool pays less than it costs to hold the range.

**Gem score v2** (0–100) = Stranded 25 + Yield 35 + Persistence 25 + Flow 15, minus 10 per warning.
- A failed check blocks the pool (no score).
- A missing input leaves the score blank, never zero.
- Persistence needs 30 days of history, so new pools show it blank until then.

**Lenses:**
- 1 stranded liquidity;
- 2 fresh pool of an old pair (pool ≤ 30 days, pair ≥ 180 days, volume share ≥ 20%, liquidity share ≤ half of it);
- 3 after a big move (≥ 2 σ-weeks in 7 days, last day calm);
- 5 calm pairs (σ ≤ 0.5% a day, staked ETH / BTC wrappers / stables, on peg);
- filter 8 runs on all of them: markouts must take ≤ 60% of the fee.

## Risk checklist before approving a position

Answer each with yes/no; any "no" or "unread" means don't approve yet.

1. Map complete at a recent block, and the pool's price within 2% of the market (independent sources).
2. The protocol's fee cut was read on-chain (v3 `feeProtocol`, v4 `protocolFee`), not assumed.
3. v4 hooks reviewed: a hooked pool can change fees or hold liquidity outside the map. Hooked pools are flagged, never auto-approved.
4. Token checks pass (no transfer tax, no honeypot, not paused or blacklisting), and the pair is at least 6 months old.
5. Net APR positive after LVR, swaps and gas at the actual ticket. Edge comfortably above 1. Markouts under 60% of the fee.
6. The range, the stop-loss (measured in the quote token) and the re-range rule are written down before entry.
7. Gas for entry and exit is small next to the expected fees over the holding period.

## Pause or stop

- Pause scanning: `gh api -X PUT repos/kereslek/assim-LS/actions/workflows/<file>.yml/disable`. Turn it back on with `enable`. Cancel a running run with `gh api -X POST repos/kereslek/assim-LS/actions/runs/<id>/cancel`.
- Phase 2 onwards: the bot acts only through a restricted session key on the owner's Safe. Revoking that key (or the Safe module) from the Safe stops all bot actions at once. Positions stay in the Safe and can be withdrawn by hand in the Uniswap app.
- Ask the owner before any irreversible step: deleting runs or logs, rewriting history, changing the relay.
