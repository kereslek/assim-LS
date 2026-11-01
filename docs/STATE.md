# assim-LS: where things stand (handover, 1 Nov 2026)

This file is public, like the repo: it holds no private data. The owner's brief, decisions,
parameters and results log live in their private strategy doc.

## Where everything is

- **Code:** branch `claude/ecstatic-dirac-wkrqja`, which is also the repo's default branch.
- **Workflows:**
  - `test`: unit tests, made-up data only (222 tests on 1 Nov).
  - `probes`: which RPCs and APIs answer from GitHub; the UNI/WETH benchmark map.
  - `pools`: the pool list (`scripts/pools.mjs`), then maps, fees, scores and cross-checks (`scripts/scan.mjs`). About 35 minutes; runs queue. Dispatch it for lib changes (a push to `lib/` doesn't start it).
  - `diag`: a fast diagnostic run of the cross-checks (skips creation events and GeckoTerminal).
  - `lock`: lock rehearsal with a dummy passphrase, then yes/no that the real lock and the sealed config open. `lock-init`: created the real lock once (refuses to overwrite).
  - `leak` (weekly) and `prune` (daily, runs older than 7 days). A new Actions secret needs one line in `leak.yml`.
  - `backtest`: daily at 04:41 UTC; seals `backtest.json`.
  - `site`: the dashboard's tests in Actions (WebKit as an iPhone 15, Chromium as a Pixel 7) on made-up data.
  - `loop` and `watchdog`: the always-on loop; rehearsed, not live yet (`LIVE_PASS` unset, watchdog cron commented out).
- **Lock:** `lock/lock.json` (salt, rounds, check), `lock/inbox.json` (public key), `lock/config.sealed.json` (the owner's settings, sealed). `scripts/seal-input.mjs` seals new private inputs.
- **Data contract:** `docs/DATA.md`.
- **Dashboard:** `site/app/index.html` (single file); fixtures in `tools/fixtures/`, browser tests in `tools/site-test.mjs` (after editing the page's script, run `node tools/site-test.mjs --fix-csp`).
- **Operating guide:** the `lp-scanner-ops` skill. **Offline fakes:** `tools/fakes/`.

## Status after Run 1's first day (1 Nov 2026, 13:00 Budapest)

Paused for the owner's weekly usage cap; Run 1 resumes on its own on Sat 7 Nov at 06:05.

| Item | State |
|---|---|
| Fee identity | 279 of 280 verifiable pool sides within 2% (diagnostic run 41302360043); 274 of 280 on the last full run. Hook pools that can move tokens outside the pool's books are `verified: false` |
| v3 creation events | 1 lookup pool still missing (was 209). Log reads skip `rpc.flashbots.net` (empty answers with no error); an empty answer counts only when a second node confirms it |
| Price history | CoinGecko hourly history cached daily: read for 95% of scored pools, within 30% of the pool's own volatility for 84%. DefiLlama's 400 came from 30-coin batches: now 8 per call, split on 400 |
| Lock | Done: real lock, sealed settings, sealed store and logs, publish to `data`, leak check clean, pruning |
| Backtest | Engine, strategies, grid, audit and daily job; real positions agree within 2% (12 of 12); entry cost reported apart from the yearly net; RPC rate-limit fix `e2c0a83` awaiting a real run |
| Windows and loop | Part 1 done and rehearsed: `lib/snapshots.mjs`, `lib/windows.mjs`, `scripts/loop.mjs`, `loop.yml`, `watchdog.yml`, `loop/PIN` |
| Dashboard | Built on made-up data: every section, unlock/lock, 171 browser checks, 12 planted faults caught; the Actions device run and a last screenshot pass remain |

## Evening of 1 Nov (16:37 CET)

- Real sealed data on the `data` branch (pools run 41314114983: 26 pass, 0 fail). The live loop (run 41317198288, `loop/PIN` = `f4a0ccf`) published its first pass at 16:35 CET.
- First sealed backup on the `backup` branch (dated folder: data/* and lock/*).
- Dashboard deployed by `pages.yml` (run 41320822386) at `/assim-LS/442edd62612a5a84cc58/`. The owner gave a standing yes: Claude triggers deploys itself and keeps sealed backups.
- Next first: a live-page audit in Actions (WebKit and Pixel unlock with the secret, pass/fail only); `backup.yml` (daily, 30 days, restore rehearsal); the "$1.0K" ticket display; check the loop's 24 h health; enable the watchdog cron.

## Resume notes (in this order)

1. Read pools run 41303327738 (`e9ac205`) and the backtest run after `e2c0a83`; find the last missing creation event.
2. Windows and loop, part 2: the scan becomes the loop's pass (`LIVE_PASS`), emits `live.json`, `history.json` and `out/shortlist.json` per `docs/DATA.md`; add a sealed snapshots file to `lib/store.mjs` (published hourly); per-window swaps/traders/markout, `lpKeeps`, walls, inactive share and segments from the scan; `health.loop.recent` into `docs/DATA.md`; re-pin `loop/PIN`; enable the watchdog cron.
3. Two green full runs in a row, then a milestone ping.
4. Dashboard: the Actions device run, re-run planted faults, last screenshot pass; then deploy to gh-pages (unguessable folder) once `live.json` is real; audit back on iPhone, Android, iPad and laptop; then stop the Saturday reminder.
5. Always-on: 24 hours with ≥ 95% of passes OK; the 14-day clock starts.
6. Base; end-of-run audit twice; report.

## Owner's yeses (1 Nov 2026)

- **Granted:** `gh-pages` for the dashboard and a storage branch for sealed results. Create them when steps 6 and 7 are built.
- **Done:** history rewritten once. The owner's personal notes left CLAUDE.md for the private strategy doc (tab "Owner notes"), and the model name left the first commit.
- **Done:** CLAUDE.md slimmed. The long reference parts moved word for word to `docs/handout.md`.
- **Done (owner):** Actions secrets `LOCK_PASSPHRASE`, `COINGECKO_KEY`, `ETHERSCAN_KEY`; the `secrets` workflow checks they are present (yes/no only).
- **Owner's yes, on a condition:** stop the weekly "LP Shape Scanner reminder" scheduled task once the dashboard is up and running.

## Rules

See "Standing rules from the owner" in CLAUDE.md: usage budget, and assim-LS only.
