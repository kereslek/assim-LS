Run 2 part 3 (dashboard v0.4.0): SHIPPED in 217169f (pushed, deployed). wip.patch, overlap.mjs and gestures.mjs here are
now obsolete (applied); delete this folder once site.yml and the live audit are green.

Local: full Chromium site-test 818 checks, 0 fail (all widths + reduced motion, 0 overlaps); planted faults caught.
Backup run 42391353075 green before the push.

Left (CI on 217169f, logs show check names only):
- site.yml Chromium (Pixel 7): 769 checks, 1 fail: "table w360: Pool, Gem, Net APR and Why show without a sideways
  scroll" (Why column ends 6 px past 360 in device mode; local 360 passes). Likely a fixture row with more Why icons.
- site.yml WebKit (iPhone 15): 736 checks, 9 fail: pan phone (drag and the edge button don't move the depth chart;
  spring-back lands 4e-3 off), pan phone daily-detail drag, touch phone (vertical swipe; then a null scrollIntoView
  stopped the group), top phone (back-to-top covers a control at the page bottom), table w360 (as above). The v0.4.0
  touch/pinch work had never run in WebKit before: check pointer handling there first.
- live audit run 42392685986: laptop 68/69, iPhone 42/45. Both: "lock: the unlocked data is gone from the page"
  (some element keeps the best pool's name after Sign out; not seen on fixtures). iPhone only: click failures pan ×1,
  why (not clickable) ×1; overlap: backtest scatter labels text.t-fg × text.t-acc ×7 (WebKit only).
- Re-pin loop/PIN to 0a85d84: the page handles depthEdges (uncapped far bars), fullRangeUsd/fullRangeSpan (thin flat
  band under the bars, bars exclude it), beyond 0 = empty, null = hatched, 14 d / 90 d history.
