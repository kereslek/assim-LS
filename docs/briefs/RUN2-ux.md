# Run 2 brief: dashboard UX build (owner's asks, 6 Nov 2026 evening)

Starts automatically Sat 7 Nov 06:07 CET. No private data in this file; mockups and screenshots use made-up numbers.

## Usage for this run (owner, 6 Nov)
- 1st and 2nd 5-hour windows: stop at 70% of the window. Later windows: up to 75%, then carry on in the next window.
- Weekly: stop at a projected 80%. At most 4 helpers.

## Order of work
1. This UX build (below), with a visual click-through audit on iPhone (WebKit, 390 px) and laptop (1440 px) after each part, then the live audit after the deploy.
2. Then the pool-hunting memo analysis and the discovery tools (examples called X and Y only).
3. Then the rest of Run 1.

## Build list
1. **Similar pools, option B, polished.** A swipe strip of mini cards under the pool header, with this pool first. Tapping a card switches the metric on all cards (net APR → volume → gem → TVL), with a small metric label and dots. Snap scrolling, edge fades, a "see all" end card. Tapping a card's name opens that pool (shape first). Ranking: same pair at another tier, then same tier with a shared token, then same tier, then a shared token; higher volume first within each group; unverified pools last. The 24H/7D/30D switch shrinks to a small pill, with the tap area padded to 44 px.
2. **Pan and zoom on every chart where it makes sense.** Drag or swipe left/right (and up/down where useful) on liquidity shapes, so more liquidity shows at the edges. Use touch-action, pointer events and momentum, with no fight against page scroll: horizontal drags pan the chart, vertical ones scroll the page. − and + zoom works step after step, also in pop-out windows. A double-tap or reset returns to the default view. Re-check this on a phone.
3. **Bar charts (fees per $1,000 and similar):** drag to see more history (the full 30 days), with a small "◀ older" hint and a scrollbar.
4. **Sheets and pop-ups:** swipe down to close on a phone, with a grab handle and rubber-banding; the close button stays.
5. **All pools table:**
   - A "why it's interesting" pictogram per row (one-sided, stranded, fresh, big move, calm, toxic flow…), with a legend in plain words. "Toxic flow" = the traders tend to be better informed than the LPs: right after their swaps the price moves against the LP, so the fees don't cover the loss.
   - Better column choice and widths.
   - A tiny "new" dot for pools new since the last page load (remember the ids seen in localStorage).
6. **Favourites:** a star on every pool, saved per device (in the browser's localStorage, because a static page can't see IP addresses; say so in the UI), plus a "★ Favourites" section near the top.
7. **"Lock this device":** a one-line explanation on the dashboard: it forgets the saved key on this device, and the passphrase is needed again.
8. **Back to top:** a small ↑ button that appears after scrolling.
9. **Sticky table and list headers** while scrolling long lists; audit that they don't stick wrongly or overlap.
10. **Top strip (tiny):**
    - an ETH gas gauge (cheap / normal / expensive against its own recent range);
    - ETH, SOL and BTC prices with a tiny ↑/↓ 24 h arrow;
    - a countdown to the next auto-refresh plus "updated hh:mm" (CET).

    The data comes from the scanner (live.json gains a `market` block; DATA.md is updated), not from page requests to third parties: that keeps the CSP and avoids leaking the viewer's IP.
11. **Backtest:**
    - the grid tiles (range width × re-centre trigger → net APR) can be clicked to highlight that strategy on the charts;
    - strategy-lab lines and "cumulative $ vs holding" legend lines toggle a highlight on click and release it on a second click.
12. **Smart search:** an autocomplete of the likeliest pairs and tokens from the loaded pools as the user types (keyboard and touch friendly).
13. **Zoom robustness:** browser pinch zoom and the in-app zoom must never break the layout. Audit every button at 360, 390, 430, 768, 1300 and 1920 px, plus reduced motion.

## Done means
- site-test is green; the live audit passes on iPhone and laptop with 0 errors; every new control has been clicked in the audit.
- Screenshots go into the end report (chat table plus a private page).
