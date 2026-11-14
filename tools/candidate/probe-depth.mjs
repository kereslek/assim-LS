#!/usr/bin/env node
// Probe (site.yml input `probe`): how fast the LP shape's edge step runs in 3D and in Classic 2D, and which part of 3D
// costs the frames, on made-up fixtures. Prints views, frame counts and timings only.
//   node tools/candidate/probe-depth.mjs --browser webkit --device "iPhone 15" --page tools/candidate/index.html
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const require = createRequire(import.meta.url), pw = require('playwright');
const BROWSER = opt('browser', 'webkit'), DEVICE = opt('device', 'iPhone 15'), PAGE = opt('page', 'site/app/index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', [path.join(ROOT, 'tools/serve-fixtures.mjs'), '--page', PAGE, '--port', '8733'], { cwd: ROOT });
const URL0 = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim())));
const browser = await pw[BROWSER].launch();
const VIEW = () => { const h = document.querySelector('[data-pz="liq-best"]'); return h ? +h.dataset.view.split(',')[0] : null; };
const VARIANTS = [
  ['2d', '2d', ''],
  ['3d', '3d', ''],
  ['3d no filter', '3d', '.ring svg{filter:none!important}'],
  ['3d no text glow', '3d', '.bignum,.cmp-b{text-shadow:none!important}'],
  ['3d no shadows', '3d', '.card,.tile,.mc,.best,.best.chs,.mc.chs,.mc.self.chs{box-shadow:none!important}'],
  ['3d no gradients', '3d', '.card,.tile,.mc{background:#114A4E!important}'],
  ['3d no glow loop', '3d', '.cmp-b::after,.dot::after,.newdot::after{display:none!important}'],
  ['3d all 4', '3d', '.ring svg{filter:none!important}.bignum,.cmp-b{text-shadow:none!important}.card,.tile,.mc,.best,.best.chs,.mc.chs,.mc.self.chs{box-shadow:none!important}.cmp-b::after{display:none!important}'],
];
for (const [tag, mode, css] of VARIANTS) {
  const dev = { ...pw.devices[DEVICE] }; delete dev.defaultBrowserType;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript((m) => { localStorage.setItem('lps.view', m); localStorage.setItem('lps.stable', '1'); localStorage.setItem('lps.hint', '1'); window.__lpsNoFlash = true; }, mode);
  const p = await ctx.newPage();
  let errs = 0; p.on('pageerror', () => errs++);
  await p.goto(URL0);
  await p.waitForSelector('#lockscreen:not([hidden])'); await p.fill('#pass', 'made-up fixture passphrase'); await p.click('#unlock-btn');
  await p.waitForSelector('#app:not([hidden])'); await p.waitForFunction(() => document.querySelector('#best').children.length > 0); await sleep(300);
  if (css) await p.addStyleTag({ content: css });
  await p.click('#winseg [data-w="30d"]'); await sleep(300);
  await p.evaluate(() => { window.__f = 0; const f = () => { window.__f++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const frames = () => p.evaluate(() => window.__f);
  let f0 = await frames(); await sleep(1000); const idle = (await frames()) - f0;
  await p.evaluate(() => [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.querySelector('.tn').textContent === 'KOVA/WETH').click()); await sleep(150);
  const out = [];
  for (let k = 0; k < 3; k++) {
    if (!(await p.isVisible('[data-pz="liq-best"] > .pz-edge.r'))) { out.push('end'); break; }
    f0 = await frames();
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector('[data-pz="liq-best"] > .pz-edge.r'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(380);
    out.push(`${(await p.evaluate(VIEW)).toFixed(4)} (${(await frames()) - f0} fr)`);
  }
  f0 = await frames(); await sleep(1000); const idle2 = (await frames()) - f0;
  console.log(`${tag.padEnd(16)} idle ${idle} fr/s at the top, ${idle2} fr/s by the chart · steps to 0.2625: ${out.join(' → ')} · errors ${errs}`);
  await ctx.close();
}
await browser.close();
srv.kill('SIGTERM');
