# Run 2: state at the 2nd-window stop (7 Nov, about 12:30 CET)

## Not yet done
- **Re-pin loop/PIN to 881277c** (more data: depthEdges, 14 d hourly / 90 d daily history), but ONLY after the page handles the new fields:
  - `shape.depthEdges`: bar edges in log offset, one more than the bars. Draw variable widths from them.
  - `depthSpan` is up to ±2.30259 (ln 10).
  - `beyond` 0 = a real 0: draw empty, not "NO DATA". `null` = unread.
  - history.json `h` covers 14 d and `d` 90 d. `lpFeesUsd` per row covers the time since the previous row, so divide by `t − t_prev` for per-hour and per-day bars. The first row's fees are null.
- **Page part 3, v0.4.0** (overlap detector and fixes, iPhone pinch and drag, zoom-out clamp, info pop-ups, slim top bar, "Sign out on this device", the watchdogLast label): if it wasn't pushed, the WIP patch is in the scratchpad at `run2/part3/` (it may be lost if the container was reclaimed; then rebuild it from the brief).
- The discovery tools are waiting for the owner's letter (A/B) and "go".
- **Usage proxy:** a 5-hour window fills at about $75 of session cost_usd. Stop at 70% of it in windows 1–2 and 75% after that.
