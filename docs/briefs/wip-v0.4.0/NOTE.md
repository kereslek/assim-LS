Run 2 part 3 (dashboard v0.4.0) — work in progress, NOT pushed. Working tree left as is.

Files: wip.patch (git diff of tracked files) + new untracked tools/overlap.mjs and tools/gestures.mjs (copies here).

Done (in the working tree):
- site/app/index.html (BUILD v0.4.0, CSP re-hashed):
  - slim sticky bar (#top, ~49 px: mark, freshness, refresh, window pills); hides on scroll down, returns on scroll up
    (--hdr / --hdrh vars); phase line + sealed + market strip moved to #subhead (scrolls away, never sticky);
    strip wraps instead of overlapping/clipping; sticky table copies dock under the bar; jumps/pop-ups respect the bar.
  - zoom model: liquidity level 0 = the map's own depthSpan (no NO-DATA hatch when zoomed out), default = fine edge
    (±45%); continuous levels; pinch (two pointers, zoom around midpoint, two-finger pan), ctrl+wheel trackpad pinch,
    touch-action pan-y (pz-xy: none), non-passive touchmove hold during chart gestures, gesturestart/change blocked on
    charts, smaller rubber band, double-tap kept.
  - one GLOSSARY (GLOSS) + term()/termB() info buttons (44 px tap boxes): tags, meta (fee tier/chain/version), range,
    gem ring, net APR, LVR, chips, breakdown + liquidity legends, panel facts + every-window rows, similar-card
    reasons, sealed badge, watchdog. Watchdog relabelled "Watchdog last restart" (— when null).
  - "Sign out on this device" + new note text; liquidity label declutter (beyond labels move/hide, no-data label hides);
    one-time hint is a coach mark with a backdrop; detail panel top folds on scroll down; fav card names leave room for
    the star.
- tools/site-test.mjs: new groups overlap, touch, header, terms, fold; existing checks updated (sign-out, zoom extent,
  touch-action, sticky under the bar); market moved early in the order (its countdown needs a fresh fixture).
- tools/live-audit.mjs: part3 (fingers: drag, pinch, two-finger pan, pinch-closed stops at the map, double tap,
  gesturestart; bar; term note; panel fold) + overlaps() (safe report: sections and element kinds, never text);
  sign-out wording; STUCK docks under the bar; similar-card check compares pool ids.
- tools/fixtures/make-fixture.mjs: new case "long" (worst-case names/numbers); nomarket also nulls watchdogLast.

Test state (Chromium, local):
- full run before the last two edits: 732 checks, 4 fail — all "market … countdown" (fixture's next pass expired
  because the suite now runs 11 min; fixed by moving market early, verified in a targeted run).
- targeted run after the fav-card fix: market/layout/fav pass; overlap group FAILS only because of the favourites step
  I added last (it stars 5 table rows, then the detector reports "#all: button.star × button.star" and long-case
  "span.pn2 × button.star" in the All pools table). Before that step was added the overlap group was 0 findings.
  Left: find why starred table rows report star-glyph overlaps (likely the starPop scale animation still running,
  or a real collision of the star with long names in td.pool) and fix; then full run, push, check site.yml WebKit
  job and the live audit.
- live-audit dry run on local fixtures (Chromium as both profiles): passes except the fav card overlap (now fixed in CSS)
  and the similar-card name check (now fixed). Not yet run on the deployed page or in WebKit.
- Planted fault: the overlap group FAILS on the old v0.3.2 page (header strip clip at 320, cpill × bylab chart labels).
