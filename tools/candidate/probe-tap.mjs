#!/usr/bin/env node
// Probe (site.yml input `probe`): the deployed page (site/app/index.html) against the candidate, side by side in one job:
// how long a finger's tap on the LP shape lasts between its down and up (the page turns a touch held 420 ms into a scrub),
// whether a double tap resets the chart, and frame times while the page scrolls, in Classic 2D and 3D, on made-up
// fixtures. Prints timings and counts only.
//   node tools/candidate/probe-tap.mjs --browser webkit --device "iPhone 15" --page tools/candidate/index.html
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const require = createRequire(import.meta.url), pw = require('playwright');
const BROWSER = opt('browser', 'webkit'), DEVICE = opt('device', 'iPhone 15'), PAGE = opt('page', 'tools/candidate/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serve = (page, port) => new Promise((res) => { const s = spawn('node', [path.join(ROOT, 'tools/serve-fixtures.mjs'), '--page', page, '--port', String(port)], { cwd: ROOT }); s.stdout.once('data', (d) => res([s, String(d).trim()])); });
const PAGES = [['deployed', 'site/app/index.html', 8736], ['candidate', PAGE, 8737]];
const browser = await pw[BROWSER].launch();
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };

// one double tap as the site test sends it: each tap down, a 10 ms timer, move, up; the second 90 ms after the first
const DTAP = async () => {
  const h = document.querySelector('[data-pz="liq-best"]'), b = h.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + 70, el = document.elementFromPoint(x, y);
  if (!el || !el.closest('[data-pz="liq-best"]')) return { up1: 0, gap: 0, up2: 0, miss: true, inView: b.top >= 0 && b.bottom <= innerHeight }; // nothing of the chart under the finger
  const fire = (t, id) => el.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now(); fire('pointerdown', 71); await wait(10); const t1 = performance.now(); fire('pointermove', 71); fire('pointerup', 71);
  await wait(90); const t2 = performance.now(); fire('pointerdown', 72); await wait(10); const t3 = performance.now(); fire('pointermove', 72); fire('pointerup', 72);
  return { up1: t1 - t0, gap: t2 - t1, up2: t3 - t2 };
};
const MEASURE = async ({ n, v, y0 }) => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  scrollTo(0, y0); for (let i = 0; i < 3; i++) await frame();
  const ts = []; let last = performance.now();
  await new Promise((res) => { let i = 0; const f = (t) => { ts.push(t - last); last = t; scrollBy(0, v); if (++i < n) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  return ts.slice(1);
};

for (const [tag, page, port] of PAGES) {
  const [srv, URL0] = await serve(page, port);
  for (const mode of ['2d', '3d']) {
    const dev = DEVICE ? { ...pw.devices[DEVICE] } : { viewport: { width: 390, height: 844 } }; delete dev.defaultBrowserType;
    const ctx = await browser.newContext(dev);
    await ctx.addInitScript((m) => { localStorage.setItem('lps.view', m); localStorage.setItem('lps.stable', '1'); localStorage.setItem('lps.hint', '1'); window.__lpsNoFlash = true; }, mode);
    const p = await ctx.newPage();
    let errs = 0; p.on('pageerror', () => errs++);
    await p.goto(URL0);
    await p.waitForSelector('#lockscreen:not([hidden])'); await p.fill('#pass', 'made-up fixture passphrase'); await p.click('#unlock-btn');
    await p.waitForSelector('#app:not([hidden])'); await p.waitForFunction(() => document.querySelector('#best').children.length > 0); await sleep(800);
    const fr = await p.evaluate(MEASURE, { n: 40, v: 30, y0: 300 });
    const taps = [];
    for (let k = 0; k < 6; k++) {
      // zoom out a step (a reset then shows), let it rest, then the double tap
      await p.evaluate(() => { const h = document.querySelector('[data-pz="liq-best"]'); h.scrollIntoView({ block: 'center' }); const z = document.querySelector('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); if (z && !z.disabled) z.click(); });
      await sleep(900);
      const before = await p.evaluate(() => document.querySelector('[data-pz="liq-best"]').dataset.view);
      const t = await p.evaluate(DTAP);
      await sleep(900);
      const after = await p.evaluate(() => document.querySelector('[data-pz="liq-best"]').dataset.view);
      taps.push({ ...t, reset: !t.miss && after === '0.0000,0.9000' && before !== after });
    }
    console.log(`${tag.padEnd(9)} ${mode.toUpperCase()} scroll: median ${med(fr)} ms, >100 ms ${fr.filter((x) => x > 100).length}/${fr.length} · tap down→up median ${med(taps.map((x) => x.up1))} ms (max ${Math.round(Math.max(...taps.map((x) => x.up1)))}), taps apart ${med(taps.map((x) => x.gap))} ms · double tap reset ${taps.filter((x) => x.reset).length}/${taps.length} · missed the chart ${taps.filter((x) => x.miss).length} (in view ${taps.filter((x) => x.miss && x.inView).length}) · errors ${errs}`);
    await ctx.close();
  }
  srv.kill('SIGTERM');
}
await browser.close();
