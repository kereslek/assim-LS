#!/usr/bin/env node
// Probe (site.yml input `probe`): the live audit's WebKit phone walk stopped answering right after pressing a chart's
// zoom-out. This replays its first presses (the look switch, a best-find tab, a pool's panel opened and closed, the fee
// history, a favourite, then each chart's zoom-out and zoom-in) on made-up fixtures, in variants, and says after each
// press whether the page's script answers and whether frames are still drawn. Prints timings and counts only.
//   node tools/candidate/probe-hang.mjs --browser webkit --device "iPhone 15" --page tools/candidate/index.html
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const require = createRequire(import.meta.url), pw = require('playwright');
const BROWSER = opt('browser', 'webkit'), DEVICE = opt('device', 'iPhone 15'), PAGE = opt('page', 'tools/candidate/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', [path.join(ROOT, 'tools/serve-fixtures.mjs'), '--page', PAGE, '--port', '8739'], { cwd: ROOT });
const URL0 = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim())));
const browser = await pw[BROWSER].launch();
const within = (pr, ms) => { pr.catch(() => {}); return Promise.race([pr, sleep(ms).then(() => '__timeout')]); };

const VARIANTS = [
  ['3D, switched to 2D', '3d', '', true],
  ['3D, switched, best as a size container', '3d', '#best{container-type:inline-size}', true],
  ['2D from the start', '2d', '', false],
  ['3D throughout', '3d', '', false],
];
const STEPS = [
  ['best tab', () => { const b = document.querySelector('#best [data-act="tab"]:not([aria-selected="true"])'); if (b) b.click(); }],
  ['panel open', () => document.querySelector('#best [data-act="detail"]').click()],
  ['panel close', () => { const c = document.querySelector('#sheet-close'); if (c) c.click(); }],
  ['map zoom-out', () => { const b = document.querySelector('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); b.scrollIntoView({ block: 'center' }); b.click(); }],
  ['map zoom-out again', () => { const b = document.querySelector('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); if (b && !b.disabled) b.click(); }],
  ['map zoom-in', () => document.querySelector('[data-act="zoom"][data-chart="liq-best"][data-dir="1"]').click()],
  ['fees zoom-in', () => { const b = document.querySelector('[data-act="zoom"][data-chart="daily-best"][data-dir="1"]'); b.scrollIntoView({ block: 'center' }); b.click(); }],
  ['fees zoom-out', () => document.querySelector('[data-act="zoom"][data-chart="daily-best"][data-dir="-1"]').click()],
  ['health zoom-in', () => { const b = document.querySelector('[data-act="zoom"][data-chart="health"][data-dir="1"]'); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } }],
  ['health zoom-out', () => { const b = document.querySelector('[data-act="zoom"][data-chart="health"][data-dir="-1"]'); if (b) b.click(); }],
];
for (const [name, mode, css, flip] of VARIANTS) {
  const dev = DEVICE ? { ...pw.devices[DEVICE] } : { viewport: { width: 390, height: 844 } }; delete dev.defaultBrowserType;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript((m) => { localStorage.setItem('lps.view', m); localStorage.setItem('lps.hint', '1'); window.__lpsNoFlash = true; }, mode);
  const p = await ctx.newPage();
  let errs = 0; p.on('pageerror', () => errs++);
  const out = [];
  try {
    await p.goto(URL0);
    await p.waitForSelector('#lockscreen:not([hidden])'); await p.fill('#pass', 'made-up fixture passphrase'); await p.click('#unlock-btn');
    await p.waitForSelector('#app:not([hidden])'); await p.waitForFunction(() => document.querySelector('#best').children.length > 0); await sleep(800);
    if (css) await p.addStyleTag({ content: css });
    if (flip) { await p.evaluate(() => { const b = document.querySelector('#viewseg [aria-pressed="false"]'); if (b) b.click(); }); await sleep(600); }
    for (const [sn, fn] of STEPS) {
      const t0 = Date.now();
      const r = await within(p.evaluate(fn), 20000);
      if (r === '__timeout') { out.push(`${sn}: the press never returned`); break; }
      await sleep(700);
      const js = await within(p.evaluate(() => 1), 15000);
      const fr = js === 1 ? await within(p.evaluate(() => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 2000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); setTimeout(() => res(n), 6000); })), 20000) : '__timeout';
      out.push(`${sn}: ${js === 1 ? 'script answers' : 'SCRIPT STUCK'}, ${fr === '__timeout' ? 'no answer' : fr + ' frames in 2 s'} (${Date.now() - t0} ms)`);
      if (js !== 1) break;
    }
  } catch (e) { out.push('stopped: ' + String(e.name || 'Error').replace(/[^A-Za-z]/g, '')); }
  console.log(`${name}:`); for (const l of out) console.log('   ' + l); console.log(`   errors ${errs}`);
  await within(ctx.close(), 10000);
}
await within(browser.close(), 10000);
srv.kill('SIGTERM');
process.exit(0);
