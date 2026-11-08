// usage: node shoot.js ID [shots|video|all] [extra-wait-ms]
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, '..'), V = '/tmp/claude-0/-home-user-assim-LS/b080864d-abab-5c34-9e04-d06b579c01fc/scratchpad/vendor';
const [id, mode = 'shots', waitMs = '3800'] = process.argv.slice(2);
const ARGS = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
async function routes(ctx) {
  await ctx.route('https://cdn.jsdelivr.net/npm/three@0.160.0/**', r => { const p = r.request().url().split('three@0.160.0/')[1]; r.fulfill({ path: path.join(V, 'three/package', p), contentType: 'application/javascript' }); });
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/**', r => { const p = r.request().url().split('3.12.5/')[1]; r.fulfill({ path: path.join(V, 'gsap/package/dist', p), contentType: 'application/javascript' }); });
}
const url = 'file://' + path.join(OUT, 'wow-' + id + '.html');
async function shots(b) {
  for (const [w, h, mob] of [[1440, 900, false], [390, 844, true]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mob, hasTouch: mob });
    await routes(ctx);
    const p = await ctx.newPage(); const errs = [];
    p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 200)); });
    p.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await p.goto(url); await p.waitForTimeout(+waitMs);
    await p.screenshot({ path: path.join(OUT, `wow-${id}-${w}-fold.png`) });
    const H = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y <= H; y += h * 0.6) { await p.evaluate(yy => scrollTo(0, yy), y); await p.waitForTimeout(250); }
    await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(1400);
    await p.screenshot({ path: path.join(OUT, `wow-${id}-${w}.png`), fullPage: true });
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    console.log(id, w, 'height', H, 'h-overflow', ov, errs.length ? '\n  ' + [...new Set(errs)].join('\n  ') : 'no errors');
    await ctx.close();
  }
}
async function video(b) {
  const dir = path.join(OUT, '_vid_' + id); fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  await routes(ctx);
  const p = await ctx.newPage(); await p.goto(url);
  const script = path.join(__dirname, 'demo-' + id + '.js');
  if (fs.existsSync(script)) await require(script)(p); else { await p.mouse.move(300, 300); await p.waitForTimeout(1500); await p.mouse.move(1000, 400, { steps: 40 }); await p.waitForTimeout(5500); }
  await ctx.close();
  const f = fs.readdirSync(dir).find(x => x.endsWith('.webm'));
  fs.renameSync(path.join(dir, f), path.join(OUT, `wow-${id}.webm`)); fs.rmSync(dir, { recursive: true, force: true });
  console.log('video', id, (fs.statSync(path.join(OUT, `wow-${id}.webm`)).size / 1024).toFixed(0) + ' KB');
}
(async () => {
  const b = await chromium.launch({ args: ARGS });
  if (mode === 'shots' || mode === 'all') await shots(b);
  if (mode === 'video' || mode === 'all') await video(b);
  await b.close();
})();
