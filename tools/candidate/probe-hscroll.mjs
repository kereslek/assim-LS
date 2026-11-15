#!/usr/bin/env node
// Probe (site.yml input `probe`): the live audit on real data saw the iPhone page scroll sideways after a click
// (15 Nov 2026), which the made-up fixtures never did. This presses, on WebKit as an iPhone, up to three controls of
// every kind on the widest fixtures (the "stress" case: 12-letter symbols, long venues, ~1,500 pools), in both looks,
// and after each press says whether the page scrolls sideways and what sticks out: tags, ids and classes only.
//   node tools/candidate/probe-hscroll.mjs --browser webkit --device "iPhone 15" --page tools/candidate/index.html
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BROWSER = opt('browser', 'webkit'), DEVICE = opt('device', 'iPhone 15'), PAGE = opt('page', 'tools/candidate/index.html'), CASE = opt('case', 'stress');
if (BROWSER !== 'webkit' && !args.includes('--any')) { console.log('probe-hscroll: WebKit only'); process.exit(0); }
const require = createRequire(import.meta.url), pw = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', [path.join(ROOT, 'tools/serve-fixtures.mjs'), '--page', PAGE, '--port', '8747'], { cwd: ROOT });
const URL0 = (await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim())))).replace('/fx/default/', `/fx/${CASE}/`);
const browser = await pw[BROWSER].launch();
const HS = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;
const WHO = () => {
  const cw = document.documentElement.clientWidth, ok = (x) => /^[a-z][a-z0-9_-]{0,40}$/i.test(x) && !/^0x|[0-9a-f]{8,}/i.test(x);
  const clips = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.position === 'fixed') return true; } return false; };
  const name = (el) => el.tagName.toLowerCase() + (el.id && ok(el.id) ? '#' + el.id : '') + [...el.classList].filter(ok).slice(0, 3).map((c) => '.' + c).join('');
  let best = null, over = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right - cw <= over + 0.5 || getComputedStyle(el).position === 'fixed' || clips(el)) continue;
    best = el; over = r.right - cw;
  }
  if (!best) return 'nothing found past the edge';
  const chain = []; for (let e = best; e && e !== document.body && chain.length < 4; e = e.parentElement) chain.unshift(name(e));
  return `${Math.round(over)}px · ${chain.join(' > ')} (${Math.round(best.getBoundingClientRect().width)} px wide)`;
};
const SKIP = /^(lock|unlock|lock-retry|retry|pass|search|scrub|lens|chain|openchart|fullclose)$/;
const t0 = Date.now();
for (const mode of ['3d', '2d']) {
  const dev = { ...pw.devices[DEVICE] }; delete dev.defaultBrowserType;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript((m) => { localStorage.setItem('lps.view', m); localStorage.setItem('lps.hint', '1'); window.__lpsNoFlash = true; window.open = () => null; }, mode);
  const p = await ctx.newPage();
  let errs = 0; p.on('pageerror', () => errs++);
  await p.goto(URL0);
  await p.waitForSelector('#lockscreen:not([hidden])'); await p.fill('#pass', 'made-up fixture passphrase'); await p.click('#unlock-btn');
  await p.waitForSelector('#app:not([hidden])', { timeout: 60000 }); await p.waitForFunction(() => document.querySelector('#best').children.length > 0, null, { timeout: 60000 }); await sleep(1500);
  console.log(`${mode}: after unlock the page scrolls sideways ${await p.evaluate(HS)} px`);
  const seen = new Map(), hits = []; let n = 0;
  for (let round = 0; round < 3 && Date.now() - t0 < (mode === '3d' ? 150e3 : 300e3); round++) {
    const acts = await p.evaluate(({ round, skip }) => {
      const re = new RegExp(skip), out = [];
      document.querySelectorAll('[data-pv]').forEach((e) => e.removeAttribute('data-pv'));
      const by = {};
      for (const el of document.querySelectorAll('[data-act]')) {
        const a = el.dataset.act;
        if (re.test(a) || el.closest('[hidden], #lockscreen, #sheet, #pop, #fullv') || el.matches('a[target="_blank"]') || el.disabled) continue;
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        (by[a] ||= []).push(el);
      }
      // the kinds the live audit pressed when it saw the scroll first, then the rest of the page's main controls
      const FIRST = ['qfind', 'dl-all', 'q-reset', 'more', 'why', 'detail', 'term', 'pair', 'view', 'win', 'refresh', 'jump', 'tab', 'bt-row', 'gas', 'stable', 'legend', 'feehist', 'fav', 'sort'];
      let i = 0;
      for (const a of [...FIRST.filter((k) => by[k]), ...Object.keys(by).filter((k) => !FIRST.includes(k))]) { const el = by[a][round]; if (el) { el.setAttribute('data-pv', String(i)); out.push({ i: i++, a }); } }
      return out;
    }, { round, skip: SKIP.source });
    for (const { i, a } of acts) {
      if (Date.now() - t0 > (mode === '3d' ? 150e3 : 300e3)) break;
      const ok = await p.evaluate((i) => { const el = document.querySelector(`[data-pv="${i}"]`); if (!el) return false; window.dispatchEvent(new WheelEvent('wheel')); el.scrollIntoView({ block: 'center' }); el.click(); return true; }, i).catch(() => false);
      if (!ok) continue;
      n++; await sleep(a === 'refresh' ? 2500 : 450);
      const hs = await p.evaluate(HS);
      if (hs > 0) { const w = await p.evaluate(WHO); seen.set(a, (seen.get(a) || 0) + 1); if (hits.length < 8) hits.push(`after ${a}: ${hs} px · ${w}`); }
      // close what opened (a panel, a note, a full view), then go on from the page
      await p.evaluate(() => { const c = document.querySelector('#fullv [data-act="fullclose"]'); if (c) c.click(); });
      if (await p.isVisible('#sheet')) { const hs2 = await p.evaluate(HS); if (hs2 > 0 && hits.length < 8) hits.push(`with the panel open (${a}): ${hs2} px · ${await p.evaluate(WHO)}`); await p.evaluate(() => document.querySelector('#sheet-close').click()); await sleep(300); }
      if (await p.isVisible('#pop')) { await p.keyboard.press('Escape'); await sleep(150); }
    }
  }
  console.log(`${mode}: ${n} presses, sideways after ${[...seen].map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}; errors ${errs}`);
  for (const h of hits) console.log('   ' + h);
  await ctx.close();
}
await browser.close();
srv.kill('SIGTERM');
process.exit(0);
