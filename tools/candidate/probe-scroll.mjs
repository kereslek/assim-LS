#!/usr/bin/env node
// Probe (site.yml input `probe`): frame times while the page scrolls (flings and wheel bursts), while a pool's panel
// scrolls and while the LP shape is dragged, in 3D and in Classic 2D, on the device and at a laptop width, on made-up
// fixtures. Prints frame counts and timings only.
//   node tools/candidate/probe-scroll.mjs --browser webkit --device "iPhone 15" --page tools/candidate/index.html
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const require = createRequire(import.meta.url), pw = require('playwright');
const BROWSER = opt('browser', 'webkit'), DEVICE = opt('device', 'iPhone 15'), PAGE = opt('page', 'site/app/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', [path.join(ROOT, 'tools/serve-fixtures.mjs'), '--page', PAGE, '--port', '8734'], { cwd: ROOT });
const URL0 = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim())));
const browser = await pw[BROWSER].launch();

// frame intervals between two marks (in the page: a rAF loop records each frame's gap)
const START = () => { window.__ft = []; let last = performance.now(); window.__fon = true; const f = (t) => { if (!window.__fon) return; window.__ft.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); };
const STOP = () => { window.__fon = false; return window.__ft.slice(1); };
const stats = (a) => {
  if (!a.length) return 'no frames';
  const s = [...a].sort((x, y) => x - y), q = (k) => s[Math.min(s.length - 1, Math.floor(k * s.length))];
  let run = 0, long = 0; for (const x of a) { run = x > 100 ? run + 1 : 0; long = Math.max(long, run); }
  return `${a.length} frames · median ${q(0.5).toFixed(0)} ms · p95 ${q(0.95).toFixed(0)} · max ${s[s.length - 1].toFixed(0)} · >100 ms: ${a.filter((x) => x > 100).length} (longest run ${long})`;
};
// a finger's fling: a scroll that starts fast and slows down, one step per drawn frame (mobile WebKit has no wheel)
const FLING = ({ sel, dir, v0 }) => new Promise((res) => {
  const el = sel ? document.querySelector(sel) : null;
  let v = v0;
  const f = () => { if (el) el.scrollBy(0, dir * v); else scrollBy(0, dir * v); v *= 0.95; if (v > 1.5) requestAnimationFrame(f); else res(); };
  requestAnimationFrame(f);
});

for (const mode of ['3d', '2d']) {
  for (const [tag, o] of [[DEVICE || 'phone', null], ['1440', { viewport: { width: 1440, height: 900 } }]]) {
    const dev = o || (DEVICE ? { ...pw.devices[DEVICE] } : { viewport: { width: 390, height: 844 } }); delete dev.defaultBrowserType;
    const ctx = await browser.newContext(dev);
    await ctx.addInitScript((m) => { localStorage.setItem('lps.view', m); localStorage.setItem('lps.stable', '1'); localStorage.setItem('lps.hint', '1'); window.__lpsNoFlash = true; }, mode);
    const p = await ctx.newPage();
    let errs = 0; p.on('pageerror', () => errs++);
    await p.goto(URL0);
    await p.waitForSelector('#lockscreen:not([hidden])'); await p.fill('#pass', 'made-up fixture passphrase'); await p.click('#unlock-btn');
    await p.waitForSelector('#app:not([hidden])'); await p.waitForFunction(() => document.querySelector('#best').children.length > 0); await sleep(600);
    const out = [];
    // 1. the page: six flings down the page, three back up
    await p.evaluate(START);
    for (let i = 0; i < 6; i++) await p.evaluate(FLING, { dir: 1, v0: 60 });
    for (let i = 0; i < 3; i++) await p.evaluate(FLING, { dir: -1, v0: 80 });
    out.push(`page flings: ${stats(await p.evaluate(STOP))}`);
    // 2. wheel bursts (a laptop's trackpad), where the browser has a wheel
    if (o) {
      await p.evaluate(() => scrollTo(0, 0)); await sleep(300); await p.mouse.move(700, 450);
      await p.evaluate(START);
      for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 240); await sleep(16); }
      for (let i = 0; i < 20; i++) { await p.mouse.wheel(0, -360); await sleep(16); }
      await sleep(300);
      out.push(`wheel bursts: ${stats(await p.evaluate(STOP))}`);
    }
    // 3. the LP shape dragged sideways and back, at rest on screen
    await p.evaluate(() => { scrollTo(0, 0); document.querySelector('[data-pz="liq-best"]').scrollIntoView({ block: 'center' }); }); await sleep(800);
    const b = await p.evaluate(() => { const r = document.querySelector('[data-pz="liq-best"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }; });
    await p.evaluate(START);
    await p.mouse.move(b.x, b.y); await p.mouse.down();
    for (let i = 1; i <= 30; i++) { await p.mouse.move(b.x - (i <= 15 ? i : 30 - i) * 8, b.y); await sleep(16); }
    await p.mouse.up(); await sleep(700);
    out.push(`LP shape drag: ${stats(await p.evaluate(STOP))}`);
    // 4. a pool's panel: open it, fling its content down and up
    await p.evaluate(() => scrollTo(0, 0)); await sleep(300);
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(900);
    await p.evaluate(START);
    for (let i = 0; i < 4; i++) await p.evaluate(FLING, { sel: '#sheet-body', dir: 1, v0: 60 });
    for (let i = 0; i < 2; i++) await p.evaluate(FLING, { sel: '#sheet-body', dir: -1, v0: 80 });
    out.push(`panel flings: ${stats(await p.evaluate(STOP))}`);
    for (const l of out) console.log(`${mode.toUpperCase()} ${tag.padEnd(9)} ${l}`);
    console.log(`${mode.toUpperCase()} ${tag.padEnd(9)} errors ${errs}`);
    await ctx.close();
  }
}
await browser.close();
srv.kill('SIGTERM');
