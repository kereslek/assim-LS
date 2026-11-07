#!/usr/bin/env node
// Live-site audit: opens the deployed dashboard, unlocks it with the real passphrase and clicks every
// visible control, in two profiles (WebKit as an iPhone 15, Chromium at 1440×900).
//
//   LOCK_PASSPHRASE=… node tools/live-audit.mjs [--profile phone|laptop|all] [--url <page>] [--wait 300]
//
// PRIVACY: the unlocked page shows the owner's sealed data. This script prints ONLY pass/fail, counts,
// control kinds and timings: never page text, numbers, names, error messages or screenshots, and it
// saves nothing to disk. Exception messages are reduced to their class name.
// Playwright comes from the environment (NODE_PATH); never npm install in the repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PAGE_URL = opt('url', 'https://kereslek.github.io/assim-LS/442edd62612a5a84cc58/');
const WAIT_S = +opt('wait', '300');
const PROFILE = opt('profile', 'all');
const PASS = process.env.LOCK_PASSPHRASE || '';
const require = createRequire(import.meta.url);
const pw = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCALDBG = process.env.LA_DEBUG === '1' && /^http:\/\/127\.0\.0\.1[:/]/.test(PAGE_URL); // local fixture runs only
const errName = (e) => (LOCALDBG && console.error(e), 0) || String((e && e.name) || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 24) || 'Error';
// where a page error was thrown: the top stack frame's function name and line in the page's own code
// (public code positions, never the message, which can carry page text)
const whereIn = (e) => {
  const st = String((e && e.stack) || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of st) {
    const m = /^at (?:async )?([A-Za-z0-9_$.<>]*) ?\(?.*?:(\d+):\d+\)?$/.exec(l) || /^([A-Za-z0-9_$.<>]*)@.*?:(\d+):\d+$/.exec(l);
    if (m) return ` in ${(m[1] || 'anonymous').replace(/[^A-Za-z0-9_$.]/g, '').slice(0, 40) || 'anonymous'}:${m[2]}`;
  }
  return '';
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const buildOf = (html) => { const m = /const BUILD = '([^']*)'/.exec(html); return m ? m[1] : null; };
const bust = (u) => { const x = new URL(u); x.searchParams.set('la', String(Date.now())); return x.href; };
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1) + ' s';

// ---------- results: fixed check names only ----------
function recorder(tag) {
  const checks = [];
  return {
    checks,
    ok(name, cond) { checks.push({ name, pass: !!cond }); return !!cond; },
    print() {
      const pass = checks.filter((c) => c.pass).length;
      console.log(`[${tag}] checks: ${pass} pass, ${checks.length - pass} fail`);
      for (const c of checks) if (!c.pass) console.log(`[${tag}]   FAIL ${c.name}`);
      return checks.length - pass;
    },
  };
}

// ---------- 1. wait for the latest deploy to be live ----------
async function waitDeploy(R) {
  // the target is the newest page on the deployed branch, re-read on every try: a push that lands while
  // we wait moves the target (PAGES_BRANCH set in Actions); without it, the checked-out page
  const latest = () => {
    if (process.env.PAGES_BRANCH) {
      try {
        execFileSync('git', ['fetch', '-q', '--depth=1', 'origin', process.env.PAGES_BRANCH], { cwd: ROOT, stdio: 'ignore', timeout: 60000 });
        return execFileSync('git', ['show', 'FETCH_HEAD:site/app/index.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
      } catch (e) { /* fall back to the checkout */ }
    }
    return fs.readFileSync(path.join(ROOT, 'site', 'app', 'index.html'), 'utf8');
  };
  const t0 = Date.now();
  let build = false, bytes = false, tries = 0, want = null, wantSha = null;
  while (true) {
    tries++;
    const local = latest(); want = buildOf(local); wantSha = sha(local);
    try {
      const r = await fetch(bust(PAGE_URL), { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
      if (r.ok) { const html = await r.text(); build = !!want && buildOf(html) === want; bytes = sha(html) === wantSha; }
    } catch (e) { /* network blip: retry */ }
    if ((build && bytes) || Date.now() - t0 > WAIT_S * 1000) break;
    await sleep(15000);
  }
  console.log(`deploy: ${tries} tries, waited ${secs(t0)}`);
  R.ok('deploy: live BUILD matches the latest site commit', build);
  R.ok('deploy: live page bytes match the latest site commit', bytes);
  return want;
}

// ---------- in-page helpers (run in the browser; they return counts and booleans only) ----------
const INIT = () => {
  window.__laOpen = 0;
  const sink = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === 'closed' ? false : sink),
    set: () => true, apply: () => sink, construct: () => sink,
  });
  window.open = function () { window.__laOpen++; return sink; };
  // explorer links (a new tab) are counted like a window, never followed: the audit never leaves the dashboard
  document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[target="_blank"]'); if (a) { e.preventDefault(); window.__laOpen++; } }, true);
};
const SNAP = () => {
  let h = 0; const s = document.body.innerHTML;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  let sc = 0;
  for (const el of document.querySelectorAll('body *')) if (el.scrollTop || el.scrollLeft) sc += el.scrollTop * 7 + el.scrollLeft;
  return [h, s.length, Math.round(scrollX), Math.round(scrollY), sc, window.__laOpen].join('|'); // focus alone is not a change
};
// enumerate the clickable controls of the top layer; mark each with data-la-i for the click
const ENUM = () => {
  const vis = (el) => {
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true;
  };
  const layers = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"], .sheet')].filter((el) => !el.hidden && !el.closest('#lockscreen') && vis(el));
  const layer = layers.length ? layers[layers.length - 1] : document.body;
  const layerId = layer === document.body ? 'page' : (layer.id || layer.className || 'layer');
  const SKIP_ACT = /^(unlock|lock|lock-retry|retry|pass|search|scrub|lens|chain)$/;
  const sel = 'button, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="checkbox"], [data-act], a[href]';
  const out = [];
  document.querySelectorAll('[data-la-i]').forEach((el) => el.removeAttribute('data-la-i'));
  let i = 0;
  for (const el of layer.querySelectorAll(sel)) {
    if (el.matches('input, select, textarea, form, label, option') || el.closest('#lockscreen, #loaderr, header [hidden]')) continue;
    if (el.closest('svg')) continue; // a chart's invisible tap line: its legend button does the same and is pressed instead
    if (el.id === 'lockbtn' || el.id === 'unlock-btn') continue;
    const act = el.dataset.act || '';
    if (SKIP_ACT.test(act)) continue;
    if (el.matches('a[href]') && !el.matches('[target="_blank"]') && !/^#/.test(el.getAttribute('href') || '')) continue; // never navigate away
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !vis(el)) continue;
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.textContent || '')).trim().replace(/\s+/g, ' ').toLowerCase();
    const short = (el.textContent || '').trim();
    let kind;
    if (el.matches('a[target="_blank"]')) kind = 'explorer-link'; // its own kind: links don't use up the open-window presses
    else if (/zoom in|zoom-in/.test(label) || short === '+' || el.dataset.zoom === 'in') kind = 'zoom-in';
    else if (/zoom out|zoom-out/.test(label) || short === '−' || short === '-' || short === '–' || el.dataset.zoom === 'out') kind = 'zoom-out';
    else if (/reset zoom|zoom reset|reset the zoom|^reset$|fit all|^1:1$/.test(label) || el.dataset.zoom === 'reset') kind = 'zoom-reset';
    else if (act === 'openchart' || ((!act || act === 'open') && (/open in (a )?(new )?window|new window|pop ?out|open.*window|in a window/.test(label)))) kind = 'open-window';
    else if (act === 'win') kind = 'window-pill';
    else if (act === 'tab' || el.getAttribute('role') === 'tab') kind = 'best-find-tab';
    else if (act === 'pair') kind = 'pair';
    else if (act === 'pair-row') kind = 'pair-row';
    else if (act === 'detail') kind = /full breakdown/.test(label) ? 'full-breakdown' : el.matches('tr') ? 'table-row' : 'detail';
    else if (act === 'close-detail' || /^close\b|^×$|^✕$/.test(label)) kind = 'close';
    else if (act) kind = act.replace(/[^a-z-]/g, '');
    else if (el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox') kind = 'switch';
    else kind = 'button';
    const key = ['w', 'id', 'key', 'k', 'to', 'zoom'].map((k) => el.dataset[k] || '').join(',');
    const sig = layerId + '|' + kind + '|' + act + '|' + key + '|' + (key.replace(/,/g, '') ? '' : (el.id || label.slice(0, 40)));
    const noop = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true'
      || ['refresh', 'jump', 'zoom-reset', 'open-window', 'explorer-link'].includes(kind);
    el.setAttribute('data-la-i', String(i));
    out.push({ i: i++, kind, sig, noop });
  }
  return { layer: layerId, overlay: layer !== document.body, controls: out };
};
const HSCROLL = () => document.documentElement.scrollWidth - document.documentElement.clientWidth;
// a chart host's view ("<position>,<width>[,<y>]"): compared in memory, never printed
const VIEW = (id) => { const h = document.querySelector(`[data-pz="${id}"]`); return h ? h.dataset.view : null; };
const STUCK = () => { // the All pools header copy: shown at the top, columns over the real ones
  const box = document.querySelector('#all-box'), sh = box && box.parentElement.querySelector(':scope > .sh');
  if (!sh || !sh.classList.contains('on')) return { on: false };
  const real = [...box.querySelectorAll('thead th')], copy = [...sh.querySelectorAll('th')], vw = sh.firstElementChild.getBoundingClientRect();
  let mis = 0;
  real.forEach((th, i) => { const a = th.getBoundingClientRect(), b = copy[i] && copy[i].getBoundingClientRect(); if (!b) { mis++; return; } if (Math.min(a.right, vw.right) - Math.max(a.left, vw.left) > 4 && Math.abs(a.left - b.left) > 1) mis++; });
  return { on: true, top: Math.abs(vw.top) <= 1, mis };
};

// ---------- 2b. gestures: zoom twice, drag, double-tap, swipe a sheet closed, sticky header, back to top ----------
// Each step is a check, or a skip when the live data doesn't have that part (a pool with no liquidity map, say).
async function gestures(page, R, tag, errTotal) {
  const n = { run: 0, skip: 0 }, e0 = errTotal();
  const run = (name, cond) => { n.run++; R.ok(name, cond); };
  const skip = () => { n.skip++; };
  const box = async (sel) => { await page.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector(sel).scrollIntoView({ block: 'center' }); }, sel); await sleep(150); return page.locator(sel).first().boundingBox(); };
  const drag = async (sel, dx) => { const b = await box(sel), x = b.x + b.width / 2, y = b.y + Math.min(b.height / 2, 70); await page.mouse.move(x, y); await page.mouse.down(); for (let i = 1; i <= 10; i++) { await page.mouse.move(x + (dx * i) / 10, y); await sleep(20); } await sleep(150); await page.mouse.up(); await sleep(500); };
  const press = (sel) => page.evaluate((sel) => { const b = document.querySelector(sel); if (!b || b.disabled) return false; window.dispatchEvent(new WheelEvent('wheel')); b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel);
  // the depth chart: + twice, a drag, a double-tap back to the start
  const liq = await page.evaluate(() => { const h = document.querySelector('#best [data-pz^="liq"]'); return h ? h.dataset.pz : null; });
  if (liq) {
    const v0 = await page.evaluate(VIEW, liq), w = (v) => Number(String(v).split(',')[1]), c = (v) => Number(String(v).split(',')[0]);
    await press(`[data-act="zoom"][data-chart="${liq}"][data-dir="1"]`); await sleep(250);
    const v1 = await page.evaluate(VIEW, liq);
    await press(`[data-act="zoom"][data-chart="${liq}"][data-dir="1"]`); await sleep(250);
    const v2 = await page.evaluate(VIEW, liq);
    run('gestures: + pressed twice zooms the depth chart twice', w(v1) < w(v0) && w(v2) < w(v1));
    await drag(`[data-pz="${liq}"]`, -120);
    run('gestures: dragging the depth chart sideways moves its view', c(await page.evaluate(VIEW, liq)) !== c(v2));
    const b = await box(`[data-pz="${liq}"]`);
    await page.mouse.click(b.x + b.width / 2, b.y + Math.min(b.height / 2, 70)); await sleep(90); await page.mouse.click(b.x + b.width / 2, b.y + Math.min(b.height / 2, 70)); await sleep(400);
    run('gestures: a double-tap resets the depth chart', (await page.evaluate(VIEW, liq)) === v0);
  } else skip();
  // the daily fee strip: zoomed in, a drag to the right shows older days
  if (await page.evaluate(() => !!document.querySelector('#best [data-pz="daily-best"]'))) {
    await press('[data-act="zoom"][data-chart="daily-best"][data-dir="1"]'); await sleep(250);
    const d0 = await page.evaluate(VIEW, 'daily-best');
    await drag('[data-pz="daily-best"]', 140);
    run('gestures: dragging the daily strip shows older days', Number(String(await page.evaluate(VIEW, 'daily-best')).split(',')[0]) < Number(String(d0).split(',')[0]));
    await press('[data-act="zreset"][data-chart="daily-best"]'); await sleep(200);
  } else skip();
  // the detail sheet: on a phone, a swipe down on its handle closes it
  if (await press('#best [data-act="detail"]')) {
    await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {});
    await sleep(400);
    if (await page.isVisible('#sheet .grab')) {
      const how = await page.evaluate(async () => {
        const el = document.querySelector('#sheet .grab'), r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        let T;
        try { T = (yy) => new Touch({ identifier: 5, target: el, clientX: x, clientY: yy }); T(y); } catch (e) { return 'mouse'; }
        const fire = (type, yy) => el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [T(yy)], changedTouches: [T(yy)], bubbles: true, cancelable: true }));
        fire('touchstart', y);
        for (let i = 1; i <= 10; i++) { await new Promise((r2) => setTimeout(r2, 16)); fire('touchmove', y + i * 32); }
        fire('touchend', y + 320);
        return 'touch';
      });
      if (how === 'mouse') { const g = await page.locator('#sheet .grab').boundingBox(); await page.mouse.move(g.x + g.width / 2, g.y + 8); await page.mouse.down(); for (let i = 1; i <= 10; i++) { await page.mouse.move(g.x + g.width / 2, g.y + 8 + i * 32); await sleep(16); } await page.mouse.up(); }
      await sleep(600);
      run('gestures: a swipe down closes the detail sheet', !(await page.isVisible('#sheet')));
    } else skip();
    if (await page.isVisible('#sheet')) { await page.click('#sheet-close').catch(() => {}); await sleep(300); }
  } else skip();
  // the All pools header sticks while its rows scroll by, and leaves at the top
  if ((await page.$$('#all-tbl tbody tr.row')).length >= 12) {
    await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#all-tbl tbody tr.row:nth-child(10)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 120); });
    await sleep(350);
    const s = await page.evaluate(STUCK);
    run('gestures: the All pools header sticks to the top, columns aligned', s.on && s.top && s.mis === 0);
    await page.evaluate(() => scrollTo(0, 0)); await sleep(350);
    run('gestures: …and is gone back at the top', !(await page.evaluate(STUCK)).on);
  } else skip();
  await part2(page, run, skip, box, press);
  // back to top
  await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, innerHeight * 1.6); });
  await sleep(450);
  const on = () => page.evaluate(() => { const b = document.querySelector('#totop'); if (!b) return false; const cs = getComputedStyle(b), r = b.getBoundingClientRect(); return cs.visibility === 'visible' && +cs.opacity > 0 && r.width >= 44 && r.height >= 44 && r.bottom <= innerHeight && r.right <= innerWidth; });
  run('gestures: a screen down, the ↑ back-to-top button shows (44 px, on screen)', await on());
  await page.click('#totop').catch(() => {});
  await page.waitForFunction(() => scrollY === 0, null, { timeout: 5000 }).catch(() => {});
  await sleep(400);
  run('gestures: ↑ scrolls back to the top and hides', (await page.evaluate(() => scrollY)) === 0 && !(await on()));
  run('gestures: no page or console errors', errTotal() === e0);
  console.log(`[${tag}] gestures: ${n.run} checks run, ${n.skip} skipped (not in this data)`);
}
// ---------- 2c. Run 2 part 2: the top strip, favourites, why, new, search, similar pools, highlights, links, the lock note ----------
// Prints booleans and counts only. Page text stays in the browser, except the best find's first letters, which the
// search check types back in: held in memory for that, never printed or saved.
async function part2(page, run, skip, box, press) {
  const vis = (sel) => page.isVisible(sel).catch(() => false);
  const esc = async () => { await page.keyboard.press('Escape'); await sleep(200); };
  // the top strip
  if (await vis('#mstrip')) {
    const st = await page.evaluate(() => { const g = document.querySelector('#gas'), t = g.innerText.replace(/\s+/g, ' ').trim(); return { gas: /^(—|\d+(\.\d+)?) gwei/.test(t) && !/^0(\.0+)? gwei/.test(t), tall: g.getBoundingClientRect().height >= 43.5, px: document.querySelectorAll('#mpx .px').length, zero: [...document.querySelectorAll('#mpx .px .v')].some((v) => /^\$0(\.00)?$/.test(v.textContent)), mt: /next( pass)? (in \S+ min|in <1 min|due now|overdue|—) · updated \d\d:\d\d/.test(document.querySelector('#mt').innerText.replace(/\s+/g, ' ')) }; });
    run('part 2: the top strip shows gas in gwei (a dash, never 0), three prices and the next pass', st.gas && st.tall && st.px === 3 && !st.zero && st.mt);
    await press('#gas'); await sleep(250);
    run('part 2: a tap on the gas gauge opens its range', await vis('#pop'));
    await esc();
    run('part 2: Escape puts that note away', !(await vis('#pop')));
  } else skip();
  // a first visit in this browser marks no pool as new
  run('part 2: a first visit marks no pool as new', (await page.$$('#all .newdot')).length === 0);
  // why: the icons explain themselves; the legend unfolds
  if (await page.$('#all tbody .whyb')) {
    await press('#all tbody .whyb'); await sleep(250);
    const ok1 = await vis('#pop') && !(await vis('#sheet'));
    await esc();
    run('part 2: a Why cell opens a plain-words note and not the pool', ok1 && !(await vis('#pop')));
  } else skip();
  const v0 = await vis('#why-legend'); // the click-through may have left it open (the page remembers it)
  await press('#why-tog'); await sleep(200);
  const v1 = await vis('#why-legend'), lg = await page.evaluate(() => document.querySelectorAll('#why-legend > div').length);
  await press('#why-tog'); await sleep(150);
  run('part 2: the "Why" legend unfolds every icon and folds again', v1 !== v0 && lg >= 10 && (await vis('#why-legend')) === v0);
  // favourites: star the best find, it fills the section and survives a reload; then un-star it
  if (await page.$('#best .ttl .star')) {
    const n0 = (await page.$$('#fav .mc')).length, was = (await page.getAttribute('#best .ttl .star', 'aria-pressed')) === 'true';
    await press('#best .ttl .star'); await sleep(250);
    const n1 = (await page.$$('#fav .mc')).length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app:not([hidden])', { timeout: 60000 }); await page.waitForFunction(() => { const b = document.querySelector('#best'); return b && b.children.length > 0; }, null, { timeout: 30000 }); await sleep(800);
    const n2 = (await page.$$('#fav .mc')).length, on = (await page.getAttribute('#best .ttl .star', 'aria-pressed')) === 'true';
    await press('#best .ttl .star'); await sleep(250);
    run('part 2: a star fills (or empties) Favourites and stays after a reload', n1 === n0 + (was ? -1 : 1) && n2 === n1 && on === !was);
    run('part 2: a second press puts Favourites back as it was', (await page.$$('#fav .mc')).length === n0);
    run('part 2: the "this device only" note is there', /this device only/.test(await page.innerText('#fav .devnote')));
  } else skip();
  // search: the first letters of the best find suggest it; arrows and Enter pick; the table filters
  if (await page.$('#best h2') && await page.$('#f-q')) {
    const q = await page.evaluate(() => { const t = document.querySelector('#best h2').textContent.trim(); return t.slice(0, Math.min(3, t.indexOf('/') > 0 ? t.indexOf('/') : 3)); });
    await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-q').scrollIntoView({ block: 'start' }); });
    await page.click('#f-q'); await page.keyboard.type(q, { delay: 40 }); await sleep(300);
    const opts = (await page.$$('#q-list .qopt')).length;
    await page.keyboard.press('ArrowDown'); await sleep(80);
    const act = await page.getAttribute('#f-q', 'aria-activedescendant');
    await page.keyboard.press('Enter'); await sleep(400);
    const rows = (await page.$$('#all tbody tr.row')).length;
    run('part 2: search suggests as you type, arrows move, Enter picks and filters', opts >= 1 && act === 'qo-0' && rows >= 1 && !(await vis('#q-list')));
    await page.fill('#f-q', ''); await page.$eval('#f-q', (e) => e.blur()); await sleep(300);
  } else skip();
  // similar pools in a pool's detail
  if (await press('#best [data-act="detail"]')) {
    await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(600);
    if (await vis('#sim')) {
      const first = await page.evaluate(() => { const c = document.querySelector('#sim .mc'); return !!c && c.classList.contains('self') && c.dataset.id === document.querySelector('#best [data-act="detail"]').dataset.id; });
      const k = () => page.evaluate(() => (document.querySelector('#sim .mc-v .k') || {}).textContent || '');
      const k0 = await k(), seen = new Set([k0]);
      for (let i = 0; i < 4; i++) { await page.evaluate(() => document.querySelector('#sim .mc-cover').click()); await sleep(150); seen.add(await k()); }
      run('part 2: similar pools: this pool first; a tap cycles 4 figures on every card and comes back', first && seen.size === 4 && (await k()) === k0);
      if (await page.$('#sim [data-act="sim-all"]')) {
        await page.evaluate(() => document.querySelector('#sim [data-act="sim-all"]').click()); await sleep(250);
        const n = (await page.$$('#sim-list .sim-row')).length;
        await page.evaluate(() => document.querySelector('#sim [data-act="sim-all"]').click()); await sleep(200);
        run('part 2: "see all" lists every similar pool and folds again', n > 9 && !(await vis('#sim-list')));
      } else skip();
      if ((await page.$$('#sim .mc-name')).length >= 1) {
        const t0 = await page.evaluate(() => document.querySelector('#sheet-title').textContent);
        await page.evaluate(() => document.querySelector('#sim button.mc-name').click()); await sleep(500);
        run('part 2: a card\'s name opens that pool, shape first', await page.evaluate((t0) => document.querySelector('#sheet-title').textContent !== t0 && document.querySelector('#sheet-body').firstElementChild.dataset.chartbox === 'liq-detail', t0));
      } else skip();
      run('part 2: the window pills look small (≤ 26 px) with 44 px taps', await page.evaluate(() => [...document.querySelectorAll('#sheet-win button')].every((b) => b.getBoundingClientRect().height >= 43.5 && b.firstElementChild.getBoundingClientRect().height <= 26)));
    } else skip();
    const lk = await page.evaluate(() => { const a = [...document.querySelectorAll('#sheet a[href]')]; return { n: a.length, good: a.every((x) => x.target === '_blank' && /noopener/.test(x.rel) && /noreferrer/.test(x.rel) && /^https:\/\/(etherscan\.io|basescan\.org|app\.uniswap\.org)\//.test(x.href)) }; });
    run('part 2: the pool\'s id and addresses link to the explorer in a new tab', lk.n >= 1 && lk.good);
    await page.click('#sheet-close').catch(() => {}); await sleep(300);
  } else skip();
  // backtest highlights
  if (await page.$('#bt-lab button[data-act="hl"]')) {
    const pressed = () => page.evaluate(() => document.querySelectorAll('#bt-lab [aria-pressed="true"]').length);
    await press('#bt-lab button[data-act="hl"]'); await sleep(250);
    const a = await pressed();
    await press('#bt-lab button[data-act="hl"][aria-pressed="true"]'); await sleep(250);
    run('part 2: a strategy row highlights its line, a second tap lets go', a === 1 && (await pressed()) === 0);
    if (await page.$('#bt-lab button.cell')) {
      await press('#bt-lab button.cell'); await sleep(250);
      const c = await page.evaluate(() => document.querySelectorAll('#bt-lab button.cell[aria-pressed="true"]').length === 1 && !!document.querySelector('#bt-lab .heat-detail'));
      await press('#bt-lab button.cell[aria-pressed="true"]'); await sleep(250);
      run('part 2: a grid tile highlights and explains itself, then lets go', c && (await pressed()) === 0);
    } else skip();
  } else skip();
  run('part 2: "Lock this device" carries its one-line explanation', /passphrase is needed next time/.test(await page.innerText('#lock-note').catch(() => '')));
}
const JUNK = () => /\bNaN\b|\bundefined\b|\bInfinity\b|\[object /.test(document.body.innerText);

// ---------- 2. one profile ----------
async function runProfile(tag, browserType, ctxOpts, wantBuild) {
  const R = recorder(tag), t0 = Date.now(), T = {};
  const fails = {}; // kind -> count
  const failAs = (kind, why) => { const k = `${kind} (${why})`; fails[k] = (fails[k] || 0) + 1; };
  const counts = { found: 0, clicked: 0, kinds: {} };
  let browser;
  try {
    browser = await pw[browserType].launch();
    const ctx = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
    await ctx.addInitScript(INIT);
    // --plant (local fixture runs only): planted faults the audit must catch
    if (args.includes('--plant') && /^http:\/\/127\.0\.0\.1[:/]/.test(PAGE_URL)) await ctx.addInitScript(() => {
      document.addEventListener('click', (e) => { if (e.target.closest('[data-act="sort"]')) setTimeout(() => { throw new Error('planted'); }); }, true);
      document.addEventListener('click', (e) => { if (e.target.closest('[data-act="more"]')) e.stopImmediatePropagation(); }, true);
      addEventListener('load', () => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Open in a window'); b.textContent = 'open'; document.querySelector('footer').append(b); });
    });
    const page = await ctx.newPage();
    let newPages = 0; // a page opened by the dashboard itself (open-in-window): counted, then closed
    ctx.on('page', (p) => { if (p !== page) { newPages++; p.close().catch(() => {}); } });
    const errs = { page: 0, console: 0, failedLoads: 0, kinds: {} }; // page errors by class name only
    page.on('pageerror', (e) => { errs.page++; const k = errName(e) + whereIn(e); errs.kinds[k] = (errs.kinds[k] || 0) + 1; });
    page.on('console', (m) => { if (m.type() === 'error') { if (/Failed to load resource/.test(m.text())) errs.failedLoads++; else errs.console++; } });
    const errTotal = () => errs.page + errs.console;

    // unlock
    let t = Date.now();
    await page.goto(bust(PAGE_URL), { waitUntil: 'domcontentloaded', timeout: 60000 });
    let unlocked = false;
    try {
      await page.waitForSelector('#lockscreen:not([hidden])', { timeout: 30000 });
      R.ok('lock: the page asks for the passphrase', await page.isVisible('#pass'));
      R.ok('lock: no data before the key', !(await page.isVisible('#app')));
      await page.fill('#pass', PASS);
      await page.click('#unlock-btn');
      await page.waitForSelector('#app:not([hidden])', { timeout: 60000 });
      await page.waitForFunction(() => { const b = document.querySelector('#best'); return b && b.children.length > 0; }, null, { timeout: 30000 });
      await sleep(800);
      unlocked = true;
    } catch (e) { console.log(`[${tag}] unlock step stopped: ${errName(e)}`); }
    T.unlock = secs(t);
    R.ok('unlock: succeeds with the passphrase', unlocked);
    if (!unlocked) { R.ok('unlock: no page or console errors', errTotal() === 0); return finish(); }
    R.ok('unlock: no wrong-passphrase message', !(await page.isVisible('#lock-msg.err')));
    R.ok('page: BUILD matches the latest site commit', (await page.evaluate(() => (window.LPS && window.LPS.build) || null)) === wantBuild);
    R.ok('page: no load-error card', !(await page.isVisible('#loaderr')));

    // state checks right after unlock
    const sections = await page.evaluate(() => {
      const all = [...document.querySelectorAll('#app section')];
      const shown = all.filter((s) => !s.hidden && !s.closest('[hidden]'));
      const empty = shown.filter((s) => { const r = s.getBoundingClientRect(); return r.width < 1 || r.height < 1 || (s.innerText || '').trim().length === 0; });
      return { total: all.length, shown: shown.length, empty: empty.length };
    });
    console.log(`[${tag}] sections: ${sections.shown} shown of ${sections.total}, ${sections.empty} empty`);
    R.ok('sections: every section rendered', sections.shown >= 5 && sections.empty === 0);
    R.ok('fresh: freshness badge present', await page.evaluate(() => {
      const b = document.querySelector('#fresh'), t = document.querySelector('#fresh-t');
      if (!b || !t) return false; const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !b.closest('[hidden]') && t.textContent.trim().length > 0 && !/NO DATA YET/.test(t.textContent);
    }));
    R.ok('layout: no horizontal scroll after unlock', (await page.evaluate(HSCROLL)) <= 0);
    R.ok('text: no NaN / undefined / Infinity after unlock', !(await page.evaluate(JUNK)));
    R.ok('errors: none after unlock', errTotal() === 0);
    // a probe of the unlocked data, kept in memory only (never printed) to prove the lock removes it
    const probe = await page.evaluate(() => { const h = document.querySelector('#best h2'); return h ? h.textContent.trim() : ''; });

    // click audit
    t = Date.now();
    const visited = new Set(), seen = new Set(), perKind = {}, CAP = 10, MAX = 160, BUDGET = 6 * 60 * 1000;
    let junkAfter = 0, hscrollAfter = 0, stuck = 0;
    while (counts.clicked < MAX && Date.now() - t < BUDGET) {
      const L = await page.evaluate(ENUM);
      const fresh = L.controls.filter((c) => !visited.has(c.sig));
      for (const c of L.controls) if (!seen.has(c.sig)) { seen.add(c.sig); counts.found++; }
      // kinds not pressed yet go first, so a capped run still covers every kind of control
      const next = fresh.filter((c) => (perKind[c.kind] || 0) < CAP).sort((a, b) => (perKind[a.kind] || 0) - (perKind[b.kind] || 0) || a.i - b.i)[0];
      if (!next) {
        if (!L.overlay) break;
        // an overlay with nothing left to press: close it (Escape, then its close control)
        await page.keyboard.press('Escape'); await sleep(350);
        let L2 = await page.evaluate(ENUM);
        if (L2.overlay && L2.layer === L.layer) {
          await page.evaluate(() => { const b = [...document.querySelectorAll('[data-la-i]')].find((el) => /close|×|✕|done|back/i.test((el.getAttribute('aria-label') || '') + el.textContent)); if (b) b.click(); });
          await sleep(350); L2 = await page.evaluate(ENUM);
        }
        if (L2.overlay && L2.layer === L.layer) { failAs('overlay', 'cannot close'); stuck++; break; }
        continue;
      }
      visited.add(next.sig);
      perKind[next.kind] = (perKind[next.kind] || 0) + 1;
      counts.kinds[next.kind] = (counts.kinds[next.kind] || 0) + 1;
      const target = page.locator(`[data-la-i="${next.i}"]`);
      try { await target.scrollIntoViewIfNeeded({ timeout: 3000 }); await sleep(150); } catch (e) { /* the click below reports it */ }
      const before = await page.evaluate(SNAP), e0 = errTotal(), np0 = newPages, open0 = await page.evaluate(() => window.__laOpen);
      try {
        await target.click({ timeout: 5000 });
        counts.clicked++;
      } catch (e) { failAs(next.kind, 'not clickable'); continue; }
      await sleep(next.kind === 'refresh' ? 2500 : 450);
      const after = await page.evaluate(SNAP);
      if (await page.isVisible('#pop')) { await page.keyboard.press('Escape'); await sleep(150); } // a note that opened goes before the next press
      if (errTotal() > e0) failAs(next.kind, 'page error');
      if ((next.kind === 'open-window' || next.kind === 'explorer-link') && (await page.evaluate(() => window.__laOpen)) === open0 && newPages === np0) failAs(next.kind, next.kind === 'explorer-link' ? 'link not followed' : 'window.open not called');
      else if (after === before && !next.noop) failAs(next.kind, 'no change');
      if (await page.evaluate(JUNK)) junkAfter++;
      if ((await page.evaluate(HSCROLL)) > 0) hscrollAfter++;
    }
    T.clicks = secs(t);
    console.log(`[${tag}] controls: ${counts.found} found, ${counts.clicked} clicked`);
    console.log(`[${tag}] clicked by kind: ${Object.entries(counts.kinds).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}`);
    const fl = Object.entries(fails);
    console.log(`[${tag}] click failures: ${fl.length ? fl.map(([k, n]) => `${k} ×${n}`).join(', ') : 'none'}`);
    R.ok('clicks: at least 10 controls clicked', counts.clicked >= 10);
    R.ok('clicks: window pills 24H/7D/30D found', (counts.kinds['window-pill'] || 0) >= 3);
    R.ok('clicks: every control pressed without failure', fl.length === 0);
    R.ok('clicks: no NaN / undefined / Infinity after any click', junkAfter === 0);
    R.ok('clicks: no horizontal scroll after any click', hscrollAfter === 0);
    R.ok('clicks: no overlay left stuck open', stuck === 0);

    // gestures, from a fresh view of the page (the stored key opens it again without the passphrase)
    t = Date.now();
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#app:not([hidden])', { timeout: 60000 });
      await page.waitForFunction(() => { const b = document.querySelector('#best'); return b && b.children.length > 0; }, null, { timeout: 30000 });
      await sleep(800);
      await gestures(page, R, tag, errTotal);
    } catch (e) { console.log(`[${tag}] gestures step stopped: ${errName(e)}`); R.ok('gestures: ran to the end', false); }
    T.gestures = secs(t);

    // close anything open, then "lock this device"
    t = Date.now();
    for (let k = 0; k < 3 && (await page.evaluate(ENUM)).overlay; k++) { await page.keyboard.press('Escape'); await sleep(300); }
    let locked = false;
    try {
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.click('#lockbtn', { timeout: 10000 });
      await page.waitForSelector('#lockscreen:not([hidden])', { timeout: 15000 });
      locked = true;
    } catch (e) { console.log(`[${tag}] lock step stopped: ${errName(e)}`); }
    R.ok('lock: "lock this device" shows the lock screen', locked);
    R.ok('lock: the data is hidden after locking', locked && !(await page.isVisible('#app')));
    R.ok('lock: the unlocked data is gone from the page', locked && (!probe || !(await page.evaluate((p) => document.body.textContent.includes(p), probe))));
    if (locked) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      let asks = false;
      try { await page.waitForSelector('#lockscreen:not([hidden])', { timeout: 30000 }); asks = await page.isVisible('#pass') && !(await page.isVisible('#app')); } catch (e) { /* counted below */ }
      R.ok('lock: after a reload the device asks again', asks);
    }
    T.lock = secs(t);
    const ek = Object.entries(errs.kinds).map(([k, n]) => `${k} ×${n}`).join(', ');
    console.log(`[${tag}] errors: ${errs.page} page${ek ? ' (' + ek + ')' : ''}, ${errs.console} console, ${errs.failedLoads} failed loads (info)`);
    R.ok('errors: no page errors', errs.page === 0);
    R.ok('errors: no console errors', errs.console === 0);
  } catch (e) {
    console.log(`[${tag}] stopped: ${errName(e)}`);
    R.ok('profile ran to the end', false);
  }
  return finish();
  function finish() {
    T.total = secs(t0);
    console.log(`[${tag}] timings: ${Object.entries(T).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const f = R.print();
    if (browser) browser.close().catch(() => {});
    return f;
  }
}

// ---------- main ----------
// anything unexpected prints its class name only: a raw message could carry page text
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, (e) => { console.log(`live audit: FAIL (stopped: ${errName(e)})`); process.exit(1); });
const t0 = Date.now();
if (!PASS) { console.log('FAIL the LOCK_PASSPHRASE secret is not set'); process.exit(1); }
const D = recorder('deploy');
const want = await waitDeploy(D);
let failed = D.print();
// LA_PHONE_BROWSER=chromium: a local fixture run on a machine without WebKit (never for the live page)
const PHONE_BROWSER = process.env.LA_PHONE_BROWSER && /^http:\/\/127\.0\.0\.1[:/]/.test(PAGE_URL) ? process.env.LA_PHONE_BROWSER : 'webkit';
const PROFILES = {
  phone: [`${PHONE_BROWSER} (iPhone 15)`, PHONE_BROWSER, (() => { const d = { ...pw.devices['iPhone 15'] }; delete d.defaultBrowserType; return d; })()],
  laptop: ['chromium (1440×900)', 'chromium', { viewport: { width: 1440, height: 900 } }],
};
for (const k of PROFILE === 'all' ? ['phone', 'laptop'] : [PROFILE]) {
  const [tag, type, o] = PROFILES[k];
  failed += await runProfile(tag, type, o, want);
}
console.log(`live audit: ${failed ? 'FAIL' : 'PASS'} (${failed} failed checks) in ${secs(t0)}`);
process.exit(failed ? 1 : 0);
