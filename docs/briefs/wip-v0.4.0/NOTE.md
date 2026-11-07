Dashboard v0.4.1 (7 Nov, about 22:35 CET): built and green in CI, NOT live. The live page is v0.3.2 (rolled back twice).

The page: tools/candidate/index.html (BUILD v0.4.1, CSP hash fixed). wip.patch here = v0.3.2 → v0.4.1 for site/app/index.html
(`git apply docs/briefs/wip-v0.4.0/wip.patch`, or just `cp tools/candidate/index.html site/app/index.html`).

Fixed in v0.4.1 (all checked):
- WebKit iPhone 15 failures. Root cause, measured with a probe in Actions (tools/candidate/probe.mjs): WebKit on the runner
  paints a frame every 50–260 ms at the phone's 3× pixels (Chromium 16 ms). Pointer events, pointer capture and the drag
  lifecycle work in WebKit (events and state traced). The checks read "at rest" too early (two equal reads 150 ms apart),
  and the detail panel's top-fold slide (220 ms) moved the daily strip after its box was read. Tests now wait for drawn
  frames, running animations and the page's own state (site-test pzView/pzSettled, gestures.mjs STILL_BOX/HOST_BOX, top group).
  Page: a drag now follows the finger from touchdown (a busy phone's first batched move no longer loses its distance).
- 360 px: All pools Why column 6 px past the screen with CI fonts (DejaVu/Liberation): slimmer cells ≤ 400 px, two Why
  icons plus a count, pair name capped (ends in …, title holds it). 9 px spare with CI fonts.
- Sign-out privacy: the closed detail panel kept the pool name (also similar strip, star, titles). lockDevice now resets
  the panel head/body, subhead, notes, footer, tab title, chart state, search and filters, then sweeps any text, attribute
  or form value naming a pool. New site-test check fails on 217169f, passes now.
- Backtest scatter label overlaps: the "±10 pts band" key moved under the chart; labels only for dots in view, never past the plot.
- Chain marks, owner's pick A: one CHAINS map (Ethereum #8A9EF5 diamond, Base #2F6BFF disc, BNB #F0B90B square, Arbitrum
  #28A0F0 ring, unknown grey); stripe + mark on All pools rows, best find (+ tabs), Next best, similar and favourite cards,
  detail header; a key next to "What the Why icons mean"; glossary entries. New site-test group `chains`; static test: one map.

Results: local Chromium 833 checks 0 fail (all widths, 0 overlaps). CI on the candidate (site.yml dispatch, page input):
WebKit iPhone 15 782/0, Chromium Pixel 7 784/0. Live audit walk on fixtures in WebKit (site.yml input audit=yes): 70/0.
Live audit on real data, two deploys: run 1 (560b099) iPhone 69/70, run 2 (70272fe) iPhone 68/70; laptop 69/69 both times;
both times 0 overlaps, 0 page errors, 0 click failures, sign-out check PASSED. The reds were the audit's own fixed sleeps
in WebKit (bar on top while scrolling; then the sticky All pools header). Both now wait for frames and transitions
(tools/live-audit.mjs REST/rest(), every scroll read in gestures/part3/overlaps) — committed, not yet run on real data.

Next (in order):
1. Dispatch site.yml with page=tools/candidate/index.html, only=none, audit=yes; then backup.yml; both green.
2. cp tools/candidate/index.html site/app/index.html, push; wait for pages + live-audit; roll back to 1b050a3's page if red.
3. When green: delete tools/candidate/ and this folder; set loop/PIN to 0a85d840a001d6622f8dbe8e741e88bcaa8be0dc (approved).
