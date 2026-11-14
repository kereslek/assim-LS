#!/usr/bin/env node
// Probe (site.yml input `probe`): which part of the 3D look costs the frames while the page scrolls. The page scrolls at a
// steady 30 px a frame over the best find, Discovery and Next best, in Classic 2D, in 3D, and in 3D with one paint effect
// switched off at a time, on the device and at 1440 px, on made-up fixtures. Prints frame timings only.
//   node tools/candidate/probe-scrollfx.mjs --browser webkit --device "iPhone 15" --page tools/candidate/index.html
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const require = createRequire(import.meta.url), pw = require('playwright');
const BROWSER = opt('browser', 'webkit'), DEVICE = opt('device', 'iPhone 15'), PAGE = opt('page', 'site/app/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', [path.join(ROOT, 'tools/serve-fixtures.mjs'), '--page', PAGE, '--port', '8735'], { cwd: ROOT });
const URL0 = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim())));
const browser = await pw[BROWSER].launch();

const VARIANTS = [
  ['2D', '2d', ''],
  ['3D', '3d', ''],
  ['3D no light layer', '3d', 'html.m3d .fx3d{display:none!important}'],
  ['3D flat cards', '3d', 'html.m3d .card,html.m3d .tile,html.m3d .mc,html.m3d .sim .mc,html.m3d .sheet-card{background:#114A4E!important}'],
  ['3D no shadows', '3d', 'html.m3d *{box-shadow:none!important}'],
  ['3D flat page', '3d', 'html.m3d body{background:#0F4448!important}'],
  ['3D no isolation', '3d', 'html.m3d body{isolation:auto!important}'],
  ['3D no depth canvas', '3d', 'canvas.d3c{display:none!important}'],
  ['3D no radius', '3d', 'html.m3d .card,html.m3d .tile,html.m3d .mc,html.m3d .sub-card{border-radius:8px!important}'],
  ['3D all four off', '3d', 'html.m3d .fx3d{display:none!important}html.m3d .card,html.m3d .tile,html.m3d .mc,html.m3d .sim .mc{background:#114A4E!important}html.m3d *{box-shadow:none!important}html.m3d body{background:#0F4448!important}'],
  ['3D again', '3d', ''],
];
const MEASURE = async ({ n, v, y0 }) => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  scrollTo(0, y0); for (let i = 0; i < 3; i++) await frame();
  const ts = []; let last = performance.now();
  await new Promise((res) => { let i = 0; const f = (t) => { ts.push(t - last); last = t; scrollBy(0, v); if (++i < n) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  return ts.slice(1);
};
const stats = (a) => { const s = [...a].sort((x, y) => x - y), q = (k) => s[Math.min(s.length - 1, Math.floor(k * s.length))]; return `median ${q(0.5).toFixed(0).padStart(4)} ms · p90 ${q(0.9).toFixed(0).padStart(4)} · max ${s[s.length - 1].toFixed(0).padStart(4)} · >100 ms ${a.filter((x) => x > 100).length}/${a.length}`; };

for (const [tag, o] of [[DEVICE || 'phone', null], ['1440', { viewport: { width: 1440, height: 900 } }]]) {
  const dev = o || (DEVICE ? { ...pw.devices[DEVICE] } : { viewport: { width: 390, height: 844 } }); delete dev.defaultBrowserType;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript(() => { localStorage.setItem('lps.view', '3d'); localStorage.setItem('lps.stable', '1'); localStorage.setItem('lps.hint', '1'); window.__lpsNoFlash = true; });
  const p = await ctx.newPage();
  let errs = 0; p.on('pageerror', () => errs++);
  await p.goto(URL0);
  await p.waitForSelector('#lockscreen:not([hidden])'); await p.fill('#pass', 'made-up fixture passphrase'); await p.click('#unlock-btn');
  await p.waitForSelector('#app:not([hidden])'); await p.waitForFunction(() => document.querySelector('#best').children.length > 0); await sleep(800);
  for (const [name, mode, css] of VARIANTS) {
    await p.evaluate(({ mode, css }) => {
      const want = mode === '3d', b = document.querySelector(`#viewseg [data-v="${mode}"]`);
      if (document.documentElement.classList.contains('m3d') !== want && b) b.click();
      let st = document.getElementById('probe-css'); if (!st) { st = document.createElement('style'); st.id = 'probe-css'; document.head.append(st); }
      st.textContent = css;
    }, { mode, css });
    await sleep(600);
    const a = await p.evaluate(MEASURE, { n: 40, v: 30, y0: 300 });
    console.log(`${tag.padEnd(9)} ${name.padEnd(20)} ${stats(a)}`);
  }
  console.log(`${tag.padEnd(9)} errors ${errs}`);
  await ctx.close();
}
await browser.close();
srv.kill('SIGTERM');
