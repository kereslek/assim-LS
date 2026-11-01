# assim-LS: where things stand (handover, 1 Nov 2026)

This file is public, like the repo: it holds no private data. The owner's brief, decisions,
parameters and results log live in their private strategy doc.

## Where everything is

- **Code:** branch `claude/ecstatic-dirac-wkrqja`, which is also the repo's default branch.
- **Workflows:**
  - `test`: unit tests, made-up data only.
  - `probes`: which RPCs and APIs answer from GitHub, which serve old state, and the UNI/WETH benchmark map.
  - `pools`: the pool list (`scripts/pools.mjs`), then maps, fees, scores and cross-checks (`scripts/scan.mjs`). About 35 minutes; a new run queues behind a running one.
- **Operating guide:** the `lp-scanner-ops` skill (`.claude/skills/lp-scanner-ops`).
- **Offline fakes:** `tools/fakes/` runs each script end to end on made-up data. Run from an empty folder, e.g. `mkdir -p /tmp/run && cd /tmp/run && node <repo>/tools/fakes/fake-scan.mjs`. Their red lines are mismatches planted in the fake data. `FAULT=protocol` plants a misread protocol fee for the fee-identity check to catch.

## Latest run (1 Nov 2026, 01:00 UTC)

- Every Uniswap pool ≥ $300k that DexScreener (137) and GeckoTerminal (61) list on Ethereum is found. v3 TVL is within 15% of theirs for all of them.
- 227 of 227 liquidity maps are complete. Prices are within 2% of market for 75 of 80 pools ≥ $1M.
- 187 pools scored at the example ticket. 34 are stranded or one-sided; 4 of them have a gem score of 60 or more.

## Known issues (next fixes, Phase 0 step 5)

1. **Fee identity:** replayed swaps vs the pools' fee counters agree within 2% for 234 of 288 pool sides. The target is 90%; the median is 1.0000. Suspects:
   - swaps that cross ticks, where the event's liquidity is the post-swap value;
   - hooked or dynamic-fee v4 pools.
2. **v3 creation events:** 228 pools found by lookup are missing from the event list. Blockscout stops after 11 pages at block 16,410,882, and RPCs read the rest. Find which block ranges come back short.
3. **DefiLlama price history:** the chart API returns HTTP 400. Volatility comes from each pool's own daily price meanwhile.

## Next steps: Run 1 (started 1 Nov 2026)

The full plan, its run log and the owner's answers are in the private strategy doc, tab "Run plan". In order:

1. Fee check: fix swaps that cross ticks; label hooked and dynamic-fee v4 pools "unverified" (never gems).
2. v3 creation events: close the gap.
3. Price history: CoinGecko (Demo key) as the volatility cross-check.
4. Lock: sealed config, results and logs; leak check; run pruning.
5. Time windows: every metric at 24 hours, 7 days and 30 days (default).
6. Two green runs in a row.
7. Dashboard v0.1 (layout C) on gh-pages, encrypted, device- and click-audited.
8. Always-on loop, watchdog, storage branch.
9. Visual backtest: replay, leaderboard, strategy lab.
10. Base.
11. Phase 2 design doc (private).
12. End-of-run audit and report.

## Owner's yeses (1 Nov 2026)

- **Granted:** `gh-pages` for the dashboard and a storage branch for sealed results. Create them when steps 6 and 7 are built.
- **Done:** history rewritten once. The owner's personal notes left CLAUDE.md for the private strategy doc (tab "Owner notes"), and the model name left the first commit.
- **Done:** CLAUDE.md slimmed. The long reference parts moved word for word to `docs/handout.md`.
- **Done (owner):** Actions secrets `LOCK_PASSPHRASE`, `COINGECKO_KEY`, `ETHERSCAN_KEY`; the `secrets` workflow checks they are present (yes/no only).
- **Owner's yes, on a condition:** stop the weekly "LP Shape Scanner reminder" scheduled task once the dashboard is up and running.

## Rules

See "Standing rules from the owner" in CLAUDE.md: usage budget, and assim-LS only.
