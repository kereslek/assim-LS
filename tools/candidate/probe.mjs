#!/usr/bin/env node
// Temporary WebKit probe (deleted once v0.4.1 is live): frame cadence, redraw cost and the pointer events a drag
// delivers, on made-up fixtures. Prints numbers about the page's own timing and event types only.
//   node tools/candidate/probe.mjs --browser webkit --device "iPhone 15" [--page tools/candidate/index.html]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFixtures, FIXTURE_PASSPHRASE } from '../fixtures/make-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PAGE = path.resolve(ROOT, opt('page', 'site/app/index.html'));
const BROWSER = opt('browser', 'chromium'), DEVICE = opt('device');
const pw = createRequire(import.meta.url)('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-probe-'));
writeFixtures(FX);
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = u.pathname === '/app/index.html' ? PROBE_PAGE : u.pathname.startsWith('/fx/') ? path.join(FX, u.pathname.slice(4)) : null;
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
// the probe's copy exposes a few internals (the script hash re-pinned, so the CSP still holds)
let html = fs.readFileSync(PAGE, 'utf8').replace('window.LPS = Object.freeze(', 'window.__P = { pzRedraw, PZA, g: () => G };\nwindow.LPS = Object.freeze(');
html = html.replace(/script-src [^;]*;/, `script-src ${[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`).join(' ')};`);
const PROBE_PAGE = path.join(FX, 'probe.html');
fs.writeFileSync(PROBE_PAGE, html);
const URLP = `http://127.0.0.1:${srv.address().port}/app/index.html?base=/fx/default/`;
const browser = await pw[BROWSER].launch();
const r2 = (x) => Math.round(x * 100) / 100;

async function run(tag, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(() => { localStorage.setItem('lps.stable', '1'); localStorage.setItem('lps.hint', '1'); });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)));
  await page.goto(URLP);
  await page.waitForSelector('#lockscreen:not([hidden])');
  await page.fill('#pass', FIXTURE_PASSPHRASE); await page.click('#unlock-btn');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await sleep(1500);
  const info = await page.evaluate(() => ({ dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, nodes: document.querySelectorAll('*').length, touch: 'ontouchstart' in window, pe: typeof PointerEvent, mtp: navigator.maxTouchPoints }));
  console.log(`[${tag}] env ${JSON.stringify(info)}`);
  // frame cadence at rest and while a chart redraws every frame
  const cad = await page.evaluate(async () => {
    const h = document.querySelector('[data-pz="liq-best"]'); h.scrollIntoView({ block: 'center' });
    const gaps = async (n, work) => { const out = []; let last = 0; await new Promise((res) => { const f = (ts) => { if (last) out.push(ts - last); last = ts; if (work) work(); if (out.length < n) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); }); out.sort((a, b) => a - b); return { med: out[out.length >> 1], max: out[out.length - 1], min: out[0] }; };
    const idle = await gaps(20);
    const t0 = performance.now(); for (let i = 0; i < 10; i++) __P.pzRedraw('liq-best'); const redraw = (performance.now() - t0) / 10;
    const busy = await gaps(20, () => __P.pzRedraw('liq-best'));
    return { idle, busy, redraw };
  });
  console.log(`[${tag}] frames ms idle med ${r2(cad.idle.med)} max ${r2(cad.idle.max)} · redrawing med ${r2(cad.busy.med)} max ${r2(cad.busy.max)} · one redraw ${r2(cad.redraw)}`);
  // events a mouse drag delivers, and the view over time after release
  await page.evaluate(() => {
    window.__ev = [];
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'lostpointercapture', 'gotpointercapture'])
      document.addEventListener(t, (e) => window.__ev.push([t, e.pointerType || '', e.pointerId == null ? '' : e.pointerId, e.buttons, Math.round(performance.now())]), true);
  });
  const b = await page.locator('[data-pz="liq-best"]').boundingBox();
  const x0 = b.x + b.width / 2, y0 = b.y + b.height / 2;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(x0 + 14 * i, y0); await sleep(16); }
  const mid = await page.evaluate(() => ({ view: document.querySelector('[data-pz="liq-best"]').dataset.view, G: __P.g() ? { drag: __P.g().drag, pid: __P.g().pid } : null }));
  await page.mouse.up();
  const tl = await page.evaluate(async () => { const out = []; const t0 = performance.now(); while (performance.now() - t0 < 2500) { out.push([Math.round(performance.now() - t0), document.querySelector('[data-pz="liq-best"]').dataset.view.split(',')[0], Object.keys(__P.PZA).length]); await new Promise((r) => setTimeout(r, 50)); } return out; });
  const after = await page.evaluate(() => ({ G: __P.g() ? { drag: __P.g().drag, pid: __P.g().pid } : null, ev: window.__ev.reduce((m, e) => { const k = e[0] + ':' + e[1] + ':' + e[2]; m[k] = (m[k] || 0) + 1; return m; }, {}) }));
  console.log(`[${tag}] drag mid view ${mid.view} G ${JSON.stringify(mid.G)} · after release G ${JSON.stringify(after.G)}`);
  console.log(`[${tag}] events ${JSON.stringify(after.ev)}`);
  const ch = []; let prev = null; for (const [t, c, a] of tl) { if (c !== prev) { ch.push(`${t}:${c}${a ? '*' : ''}`); prev = c; } }
  console.log(`[${tag}] view after release (ms:centre, * = animating) ${ch.slice(0, 30).join(' ')} … final ${tl[tl.length - 1][1]} animating ${tl[tl.length - 1][2]}`);
  // synthetic touch fingers: a slow drag left, then sample
  await page.evaluate(() => { window.__ev = []; });
  const fin = await page.evaluate(async ({ x0, y0 }) => {
    const el = document.elementFromPoint(x0, y0);
    const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 31, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y0, bubbles: true, cancelable: true, composed: true, buttons: type === 'pointerup' ? 0 : 1 }));
    const v0 = document.querySelector('[data-pz="liq-best"]').dataset.view;
    fire('pointerdown', x0); for (let k = 1; k <= 12; k++) { await new Promise((r) => setTimeout(r, 30)); fire('pointermove', x0 - (110 * k) / 12); }
    fire('pointerup', x0 - 110);
    const out = []; const t0 = performance.now(); while (performance.now() - t0 < 2500) { out.push([Math.round(performance.now() - t0), document.querySelector('[data-pz="liq-best"]').dataset.view.split(',')[0], Object.keys(__P.PZA).length]); await new Promise((r) => setTimeout(r, 50)); }
    return { v0, out };
  }, { x0, y0 });
  const ch2 = []; prev = null; for (const [t, c, a] of fin.out) { if (c !== prev) { ch2.push(`${t}:${c}${a ? '*' : ''}`); prev = c; } }
  console.log(`[${tag}] finger flick from ${fin.v0.split(',')[0]}: ${ch2.slice(0, 30).join(' ')} … final animating ${fin.out[fin.out.length - 1][2]}`);
  // back to top at the page's bottom: what sits under it
  await page.evaluate(() => scrollTo(0, 0)); await sleep(200);
  await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, document.documentElement.scrollHeight); }); await sleep(600);
  const tt = await page.evaluate(() => { const a = document.querySelector('#totop').getBoundingClientRect(), cs = getComputedStyle(document.querySelector('#totop')); const under = [...document.querySelectorAll('button, a[href], select, input, [data-act]')].filter((e) => e.id !== 'totop' && e.offsetParent !== null).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && a.left < r.right && r.left < a.right && a.top < r.bottom && r.top < a.bottom; }).map((e) => { const r = e.getBoundingClientRect(); return `${e.id || e.dataset.act || e.tagName}@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`; }); const f = document.querySelector('footer').getBoundingClientRect(); return { on: cs.visibility + '/' + cs.opacity, a: [a.left, a.top, a.width, a.height].map(Math.round), under, foot: [f.top, f.height].map(Math.round), sy: Math.round(scrollY), sh: document.documentElement.scrollHeight, vv: window.visualViewport ? [visualViewport.height, visualViewport.offsetTop].map(Math.round) : null }; });
  console.log(`[${tag}] totop ${JSON.stringify(tt)}`);
  console.log(`[${tag}] page errors ${errs.length}${errs.length ? ': ' + errs[0] : ''}`);
  await ctx.close();
}
try {
  const dev = DEVICE ? { ...pw.devices[DEVICE] } : null;
  if (dev) delete dev.defaultBrowserType;
  if (dev) await run(DEVICE, dev);
  if (dev) await run(DEVICE + ' dpr1', { ...dev, deviceScaleFactor: 1 });
  if (dev) await run(DEVICE + ' no-touch', { ...dev, isMobile: false, hasTouch: false });
  await run('laptop', { viewport: { width: 1440, height: 900 } });
} finally { await browser.close(); srv.close(); fs.rmSync(FX, { recursive: true, force: true }); }
