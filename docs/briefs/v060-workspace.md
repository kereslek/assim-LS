# v0.6.0 · Pool workspace + History (owner's picks, 14 Nov 2026)

Owner's words:
- "B + 1, 2, 3, 4, 6"
- "the open in new window button now only brings a side view on laptop; a fully full view is needed in a new window on laptop too, full screen; History and every full UX/UI feature that is usual, cool and useful should be there too; think a lot, do it and audit it"

Builds on v0.5.1, which makes the chart ⧉ button full-screen with Close, Esc and native fullscreen.

## 0 · Standing rule (owner, 14 Nov 2026)
"Whenever you look at an LP, History must always be prominently available by a click, and be useful and obvious."
- **Every place a pool appears has a visible History button or chip, one tap away:** best find, the top-10 tabs, All pools rows, Discovery lane cards, Favourites, Similar pools, Pair view, Compare, search results, the pool panel and the workspace.
- **Shape:** the same icon and word everywhere (bars icon + "History"), a tap target of at least 44 px, never hidden behind a menu or hover.
- **It opens History in the workspace, already on that pool,** in the last range used, or 90D by default.
- **Tests check it:** for every pool surface, the History control is present, visible and a real button, and it opens that pool's History.

## 0b · Standing rule: every view has a way out (owner, 14 Nov 2026)
"Any new tab or side tab must include an exit or close button. Make sure it takes the user somewhere, not an empty page. Test it too and audit carefully. Think like an Apple / iOS user."
- **A visible close on every overlay, sheet, side panel, full-screen view, workspace tab, help card and popover:**
  - **Done or ✕, top right**, at least 44 px, always on screen. It stays put while the content scrolls.
  - **"‹ Back" top left** wherever the user went one level deeper (e.g. History → a day → back to History; workspace → Compare picker).
- **Every iOS way out works:**
  - **Swipe down** on a sheet's grabber or header dismisses it.
  - **Safari's back gesture or back button** closes the top overlay instead of leaving the dashboard. Opening an overlay pushes a history entry; `popstate` closes it. Each overlay level is one back step, and none is left behind once it's closed.
  - **Esc** and a **tap on the dimmed background** close side panels and popovers on the laptop.
- **It always lands somewhere real:**
  - Closing returns to exactly where the user was: the same scroll, the panel still open if it was open, focus back on the button that opened it.
  - A deep link opened in a new window or tab has no opener page, so its Close goes to the dashboard's main view, never a blank tab. `window.close()` is used only when the script opened that window.
  - A deep link to a pool that no longer exists, or that isn't read yet, shows a clear message and a button back to the main view.
  - A refresh while a view is open reopens the same view, or falls back to the main view, never to an empty page.
- **Tests:**
  1. For every view: the close control exists, is visible inside the viewport, and has an aria label.
  2. Closing restores the scroll position and focus.
  3. On WebKit iPhone: browser back closes overlays one by one and never leaves the page.
  4. On WebKit iPhone: swipe-down dismisses the sheets.
  5. A new-tab deep link's Close lands on the main view.
  6. A dead deep link shows the message.
  7. After any open/close sequence, the page is never blank: the main content is visible and nothing is left dimmed.

## 1 · Ways in
- **Pool panel header**, next to 24H/7D/30D: a big **History ▸** button, a **⤢ Full screen** button (opens the workspace), and **Pair view ▸** kept.
- **Every chart's ⧉** opens the workspace on that chart's tab, already focused.
- **History** on each Similar-pools card (opens the workspace on History with that tier picked), and a **History** chip on the best-find card.
- **Deep link** `#p=<pool key>&v=<tab>`:
  - ⌘/Ctrl-click or middle-click on ⤢ or ⧉ opens a real new window or tab;
  - the device's saved unlock carries over, so the passphrase is never asked again;
  - the hash never leaves the browser and holds only a public pool key, never anything private.

## 2 · The workspace: full window, laptop first
It covers 100vw × 100dvh above everything. It tries native fullscreen and otherwise fills the window.

**Top bar:**
- ‹ › previous and next pool of the list it was opened from (idea 2; keys `[` `]`; "3 / 10")
- the pair, with chain, DEX and tier chips
- gem, ★ favourite
- 24H/7D/30D
- tabs: **Overview · History · Liquidity · Pair · Compare**
- `?` shortcuts help, **Close** (Esc)

**Overview:**
- The **one-line summary** (idea 4) on top.
- The big LP-shape chart (3D/2D), with the 30-day fee strip and hourly fees under it.
- A right rail of key numbers: net APR, fees per $1k a day, TVL, 24h volume, edge, σ, re-range, stop, competition.
- The Similar-tiers list, each tier with its History button.

**History = option B:**
- Three synced charts: Fees (bars), Volume (bars), TVL (area). Each has its own $ axis from 0, and they share one date axis.
- **Range:** 30D · 90D · 1Y · All.
- **Tier chips** plus **All combined**, which stacks the tiers. A combined day with any tier unread is a gap, never a smaller total.
- **One crosshair** through all three charts, with a day card showing fees, volume and TVL plus fee÷volume, and each day's source:
  - fees `s/x/e`, volume `s/g`, TVL `b/r/m`;
  - `≈` before estimates;
  - "not read" gaps, never 0;
  - past v4 TVL shows "—" with a note.
- **Mouse:** hover to see a day, drag across the dates to zoom into that range, double-click to reset.
- **Touch:** hold and slide.
- **Keys:** ←/→ steps a day, F/V/T makes one chart big.
- **Day table** on the right: sortable, follows the crosshair, and a click on a row moves the crosshair there. A **CSV download** saves the visible rows.

**Liquidity:** the existing chart, full size, with every control (− + reset, arrows, drag, pinch, tier chips, competition replay).

**Pair:** all tiers of the pair side by side: today's numbers, plus their History in one view.

**Compare (idea 3):**
- Pick up to 3 pools of any pair, through a search box with suggestions.
- Their Fees, Volume and TVL appear as small multiples on the **same** axes, one line per pool, with legend chips.

**On the phone:**
- The same workspace as a full-screen sheet, respecting safe areas. The tabs become a scrollable segmented row.
- Swipe left/right on the header to change pool (idea 2).
- Hold-and-slide on the charts. The day card sits in a sticky strip above the charts, so the finger never covers it.

## 3 · Main page
- **Bottom tab bar on the phone (idea 1):**
  - Top · Discover · Pools · Favourites · History. History opens the last pool's History, or the best find's.
  - It hides while scrolling down and returns on scroll up, and it respects the safe area.
  - It is not shown on the laptop.
- **Hold to explain (idea 6):**
  - Hold (450 ms touch), or click the ⓘ cursor, on any key number to get a card: what it means, where it came from, exact or estimated.
  - One central registry of definitions, reusing the existing term notes.
  - Works in the workspace too.

## 3b · Audit fixes on the page (audit of 14 Nov 2026; the owner's answers)
- **F1 auto-lock:** after **2 weeks idle** (the owner's pick) the device's stored key is deleted and the passphrase is asked again. Idle = no visit and no interaction. The manual Lock button stays.
- **F5 layout shift:**
  - reserve the footer's height, and the subhead's and view switch's space, before the data arrives;
  - target CLS < 0.1 on phone and laptop, measured with the PerformanceObserver check (scratchpad audit/cls.cjs);
  - add a site-test check.
- **F7 framing:** if the page is inside a frame (`top !== self`), hide everything and say "This dashboard can't be shown inside another page". Add a check.
- **F9 contrast:** the active sort header in 3D (`#all-tbl th[aria-sort] .lbl`) reaches at least 4.5:1. Add an axe-core run (WCAG 2.2 AA tags) to site-test for 3D and 2D, locked and unlocked; 0 violations.
- **F11 errors:**
  - a small "Something went wrong · details" badge whenever `window.onerror` or `unhandledrejection` fires: tap it to see the message;
  - plus a sealed error log: the error kind and the page area, never data, sealed to the inbox key and picked up by the loop. No server, never plain text.
- **F6 phone load:** load the 3D code after the first paint (it is one file today, 415 KB, 132 KB gzipped). Target Lighthouse mobile performance ≥ 85, LCP < 2.5 s, run on the fixture page.

## 4 · Quality bar
- **Data honesty everywhere:** missing is never 0, estimates are pale or `≈`, and every source is named.
- **3D and 2D both complete.** Under reduced motion, nothing animates.
- **Accessibility:** focus trapped in the workspace, every control a real button with an aria label, a visible keyboard focus, and taps of at least 44 px on touch.
- **Performance:**
  - 1Y × 3 tiers × 3 charts draws in under 50 ms on a laptop;
  - no frame over 100 ms while scrubbing on WebKit iPhone;
  - canvases are released when hidden.
- **Fixtures:** tools/fixtures adds `yv`/`yt`/`yvp`/`ytp`, with made-up data, nulls, v4 `'m'` and the Base 90-day limit.
- **Tests:** new site-test groups (workspace, history, compare, explain, tabbar, swipe, deeplink). Each check fails on v0.5.1. The live audit's click-through covers every new control.
- **Widths:** WebKit iPhone 15 and laptops at 1300/1440/1920, in both looks.
- **Release path:** candidate → site.yml (4 jobs) → backup → deploy → live-audit → screenshots made with made-up data.
