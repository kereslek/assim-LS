# v0.6.0 · Pool workspace + History (owner's picks, 14 Nov 2026)

Owner's words:
- "B + 1, 2, 3, 4, 6"
- "the open in new window button now only brings a side view on laptop; a fully full view is needed in a new window on laptop too, full screen; History and every full UX/UI feature that is usual, cool and useful should be there too; think a lot, do it and audit it"

Builds on v0.5.1, which makes the chart ⧉ button full-screen with Close, Esc and native fullscreen.

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
