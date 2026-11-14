// Preload for one test world: moves the clock to 12:00 UTC of the current day (FAKE_NOON=1), so a check whose
// outcome depends on the time of day (the deep backfill reads today's 00:05 moment once it has passed) runs
// the same at any hour.
if (process.env.FAKE_NOON === '1') {
  const RD = Date, DAY = 86400e3, off = Math.floor(RD.now() / DAY) * DAY + DAY / 2 - RD.now();
  globalThis.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(RD.now() + off); } static now() { return RD.now() + off; } };
}
