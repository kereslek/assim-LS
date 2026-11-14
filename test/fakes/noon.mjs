// Preload for one test world: moves the clock to 12:00 UTC of the current day (FAKE_NOON=1), so a check whose
// outcome depends on the time of day (the deep backfill reads today's 00:05 moment once it has passed; a run that
// starts before HH:05 and one that starts after see a different set of hourly moments) runs the same at any hour.
// FAKE_CLOCK=HH:MM[:SS] moves it to that time of the current UTC day instead: a sweep across the hours runs a test
// at each (test/feehist-scan.test.mjs forwards it to its worlds).
const at = (() => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(process.env.FAKE_CLOCK || '');
  if (m && +m[1] < 24 && +m[2] < 60 && +(m[3] ?? 0) < 60) return ((+m[1] * 60 + +m[2]) * 60 + +(m[3] ?? 0)) * 1000;
  return process.env.FAKE_NOON === '1' ? 43200e3 : null;
})();
if (at != null) {
  const RD = Date, DAY = 86400e3, off = Math.floor(RD.now() / DAY) * DAY + at - RD.now();
  globalThis.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(RD.now() + off); } static now() { return RD.now() + off; } };
}
