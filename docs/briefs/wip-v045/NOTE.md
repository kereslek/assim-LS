# v0.4.5 work in progress (paused at the usage cap, 8 Nov 2026)

Nothing here is live: the live page is still v0.4.4 (7546b8a). The patch is against 7546b8a.

## What's done

- `v045.patch` changes `site/app/index.html` (v0.4.5, CSP hash already fixed) and `tools/site-test.mjs`. Apply it with `git apply docs/briefs/wip-v045/v045.patch`.
- `p1-stable.mjs` and `p2-flash.mjs` are the splice scripts that made the page change. Run them on the v0.4.4 page, then run `node tools/site-test.mjs --fix-csp`.
- **Stablecoin switch:**
  - A compact "Stables: off" switch with an ⓘ sits in the top strip next to the gas gauge. It shares one state with the switch above All pools.
  - **What leaked on v0.4.4 with the switch off:** the backtest leaderboard, its scatter, its KPIs (within ±10, median, bias, biggest miss), the replay and the strategy lab's pool. All of these come from `btRows()`, which didn't filter.
  - **Counts that included hidden pairs:** the scanner tile (gems, scored, top), Next best's "All N scored pools" button, and All pools' "(N IN ALL)" and "N NEW".
  - All of these are fixed now.
  - Favourites always show and are marked ★ STABLE.
  - The merge chips of a pool's own pair still show its same-pair pools, as before (the earlier rule).
- **Competition flash (option A, 3.5 s):**
  - It runs grow 0–0.6 s, hold 0.6–2.6 s (gold banner from 0.8 s), fade 2.6–3.5 s, then the end state.
  - The end state is the dashed whole-pair ghost behind this pool's bars plus a "⚠ competition: +N pools · X× liquidity · replay" badge.
  - It plays once per pool per page. Any pointerdown, wheel, key, touch or click ends it at once. Under reduced motion there's no animation.
  - The pop-out window gets the same treatment. The best card shows the badge only, and its "show" opens the pool and plays it.
  - The y-scale includes the ghost, capped at 4× this pool's tallest bar.
- **Tests:**
  - New group `stablewalk`: the walk fails on v0.4.4 as required. It also checks that the two switches stay in sync and that the ⓘ shows the owner's words.
  - New group `flash`: timeline, end state, cancel on 7 kinds of interaction, once per page, no-sibling pool, reduced motion, badge against an independent ±9% model with planted faults, best card, pop-out.
  - Other groups set `window.__lpsNoFlash` through `newPage`, which turns the auto-play off. The merge/depth models are now ghost-aware: `ghostCap`.

## Local results (Chromium)

- `stablewalk` and `flash` pass: 26 + 74 checks over the runs.
- `stable`, `merge` and `depth` pass.
- `node --test test/site*.test.mjs` passes 15/15.
- A full-suite run was started (`run2/v045/full1.txt` in the session scratchpad). It had no failures printed through `zoomfit` when paused, so it is NOT yet confirmed green end to end.

## Next steps (the safe release path)

1. Apply the patch. Run the full local suite (`node tools/site-test.mjs`) and get it green with 0 overlaps.
2. Copy the page to `tools/candidate/index.html` and restore `site/app/index.html` to v0.4.4. Push the candidate plus `tools/site-test.mjs`.
   - The push run of site.yml tests v0.4.4 with the new groups and would go red. The dispatch below cancels it: same concurrency group.
3. Dispatch site.yml with page=tools/candidate/index.html and audit=yes. Wait for WebKit iPhone 15 and Pixel to go green.
4. Dispatch backup.yml and wait for green. Then copy the candidate to `site/app/index.html`, remove `tools/candidate`, and push (this deploys). Wait for pages and the live audit; if either is red, roll back to 7546b8a's page.

## Open points

- On a phone (≤ 400 px) the strip wraps to three rows: prices, gas + Stables, next pass. Its layout groups passed locally.
- WebKit is not available locally. The flash timings in `testFlash` allow up to 9 s on WebKit.
