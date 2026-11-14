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
import { TEXT_OVERLAP } from './overlap.mjs';
import { FINGERS, HOST_BOX, pinchPts } from './gestures.mjs';

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
    // LA_PAGE_FILE: a candidate page served from a local fixture server (tools/serve-fixtures.mjs), before it deploys
    return fs.readFileSync(process.env.LA_PAGE_FILE ? path.resolve(ROOT, process.env.LA_PAGE_FILE) : path.join(ROOT, 'site', 'app', 'index.html'), 'utf8');
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
// wait until the page is at rest: every chart's view the same over 3 drawn frames and no animation running (a slow
// WebKit draws a frame every 100–260 ms, so a pan step or a fade can still be under way long after a fixed sleep).
// The wheel event first is what a user's own scroll does: it ends the page's re-aligning after a jump.
const REST = async (ms = 2500) => {
  window.dispatchEvent(new WheelEvent('wheel'));
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const views = () => [...document.querySelectorAll('[data-pz]')].map((h) => h.dataset.view).join('|');
  const busy = () => document.getAnimations().some((a) => (a.playState === 'running' || a.pending) && !(a.effect && a.effect.getComputedTiming().endTime === Infinity)); // a pulse that never ends doesn't count
  let a = views(), same = 0;
  for (const t0 = performance.now(); performance.now() - t0 < ms && (same < 3 || busy());) { await frame(); const b = views(); if (b === a) same++; else { same = 0; a = b; } }
};
// a chart host's view ("<position>,<width>[,<y>]"): compared in memory, never printed
const VIEW = (id) => { const h = document.querySelector(`[data-pz="${id}"]`); return h ? h.dataset.view : null; };
const STUCK = () => { // the All pools header copy: right under the bar on top (at the top while the bar is away), columns over the real ones
  const box = document.querySelector('#all-box'), sh = box && box.parentElement.querySelector(':scope > .sh'), bar = document.querySelector('#top');
  if (!sh || !sh.classList.contains('on')) return { on: false };
  const real = [...box.querySelectorAll('thead th')], copy = [...sh.querySelectorAll('th')], vw = sh.firstElementChild.getBoundingClientRect();
  const dock = !bar || bar.classList.contains('hid') ? 0 : Math.max(0, bar.getBoundingClientRect().bottom);
  let mis = 0;
  real.forEach((th, i) => { const a = th.getBoundingClientRect(), b = copy[i] && copy[i].getBoundingClientRect(); if (!b) { mis++; return; } if (Math.min(a.right, vw.right) - Math.max(a.left, vw.left) > 4 && Math.abs(a.left - b.left) > 1) mis++; });
  return { on: true, top: Math.abs(vw.top - dock) <= 1, mis };
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
      // v0.4.7: a pull down on the content (a chart at its top) never drags or closes the sheet: it scrolls or rubber-bands
      if (await press('#best [data-act="detail"]')) {
        await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(400);
        const moved = await page.evaluate(async () => {
          document.querySelector('#sheet-body').scrollTop = 0;
          const el = document.querySelector('#sheet-body [data-pz]') || document.querySelector('#sheet-body'), r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + Math.min(40, r.height / 2), c = document.querySelector('#sheet .sheet-card');
          let mx = 0;
          const T = (yy) => { try { return new Touch({ identifier: 6, target: el, clientX: x, clientY: yy }); } catch (e) { return { identifier: 6, target: el, clientX: x, clientY: yy }; } };
          const ev = (type, t) => { try { return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }); } catch (e) { const v = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(v, 'touches', { value: type === 'touchend' ? [] : [t] }); Object.defineProperty(v, 'changedTouches', { value: [t] }); return v; } };
          el.dispatchEvent(ev('touchstart', T(y)));
          for (let i = 1; i <= 10; i++) { await new Promise((r2) => setTimeout(r2, 16)); el.dispatchEvent(ev('touchmove', T(y + i * 30))); mx = Math.max(mx, Math.abs(new DOMMatrix(getComputedStyle(c).transform).m42)); }
          el.dispatchEvent(ev('touchend', T(y + 300)));
          await new Promise((r2) => setTimeout(r2, 500));
          return mx;
        });
        run('gestures: a pull down on the panel\'s content (its chart, at the top) never drags or closes it', moved === 0 && (await page.isVisible('#sheet')));
      } else skip();
    } else { skip(); skip(); }
    if (await page.isVisible('#sheet')) { await page.click('#sheet-close').catch(() => {}); await sleep(300); }
  } else skip();
  // the All pools header sticks while its rows scroll by, and leaves at the top
  if ((await page.$$('#all-tbl tbody tr.row')).length >= 12) {
    await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#all-tbl tbody tr.row:nth-child(10)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 120); });
    await sleep(150); await page.evaluate(REST); // the header copy follows the scroll a frame later and slides .22 s
    const s = await page.evaluate(STUCK);
    run('gestures: the All pools header sticks right under the bar on top, columns aligned', s.on && s.top && s.mis === 0);
    await page.evaluate(() => scrollTo(0, 0)); await sleep(150); await page.evaluate(REST);
    run('gestures: …and is gone back at the top', !(await page.evaluate(STUCK)).on);
  } else skip();
  await part2(page, run, skip, box, press);
  await part3(page, run, skip);
  await part4(page, run, skip, press);
  await part5(page, run, skip, press);
  await part6(page, run, skip);
  await overlaps(page, run, tag);
  // back to top
  await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, innerHeight * 1.6); });
  await sleep(150); await page.evaluate(REST);
  const on = () => page.evaluate(() => { const b = document.querySelector('#totop'); if (!b) return false; const cs = getComputedStyle(b), r = b.getBoundingClientRect(); return cs.visibility === 'visible' && +cs.opacity > 0 && r.width >= 44 && r.height >= 44 && r.bottom <= innerHeight && r.right <= innerWidth; });
  run('gestures: a screen down, the ↑ back-to-top button shows (44 px, on screen)', await on());
  await page.click('#totop').catch(() => {});
  await page.waitForFunction(() => scrollY === 0, null, { timeout: 5000 }).catch(() => {});
  await sleep(150); await page.evaluate(REST);
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
        const id0 = await page.evaluate(() => (document.querySelector('#sheet-star [data-id]') || {}).dataset.id || ''); // the pool open now (same-pair cards share its name)
        const want = await page.evaluate(() => document.querySelector('#sim button.mc-name').dataset.id);
        await page.evaluate(() => document.querySelector('#sim button.mc-name').click()); await sleep(500);
        run('part 2: a card\'s name opens that pool, shape first', await page.evaluate(({ id0, want }) => { const id = (document.querySelector('#sheet-star [data-id]') || {}).dataset.id; return id === want && id !== id0 && (document.querySelector('#sheet-main') || document.querySelector('#sheet-body')).firstElementChild.dataset.chartbox === 'liq-detail'; }, { id0, want }));
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
  run('part 2: "Sign out on this device" carries its one-line explanation', (await page.textContent('#lockbtn').catch(() => '')) === 'Sign out on this device' && /Forgets the saved key here\. You’ll need your passphrase next time\./.test(await page.innerText('#lock-note').catch(() => '')));
}
// ---------- 2d. Run 2 part 3: fingers on the charts, the bar on top, info notes, the panel's folding top ----------
// Synthetic fingers (tools/gestures.mjs: pointer events with pointerType 'touch') on the real page. Views are compared in
// memory and never printed; every step is a check, or a skip when the live data lacks that part.
async function part3(page, run, skip) {
  const view = (id) => page.evaluate(VIEW, id);
  const num = (v, i) => Number(String(v).split(',')[i]);
  const fingers = (pts, o = {}) => page.evaluate(FINGERS, { pts, ...o });
  const box = (id, root = '') => page.evaluate(HOST_BOX, { id, root });
  const press = (sel) => page.evaluate((sel) => { const b = document.querySelector(sel); if (!b || b.disabled) return false; window.dispatchEvent(new WheelEvent('wheel')); b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel);
  // a chart's view once at rest: the same over 3 drawn frames and 200 ms (a slow WebKit draws a frame every 100–260 ms)
  const settle = (id) => page.evaluate(async (id) => {
    const rd = () => { const h = document.querySelector(`[data-pz="${id}"]`); return h ? h.dataset.view : null; };
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    let a = (await frame(), rd()), same = 0, since = performance.now();
    for (const t0 = performance.now(); performance.now() - t0 < 4000;) {
      await frame(); await new Promise((r) => setTimeout(r, 25));
      const b = rd();
      if (b !== a) { a = b; same = 0; since = performance.now(); } else if (++same >= 3 && performance.now() - since >= 200) break;
    }
    return a;
  }, id);
  const rest = () => page.evaluate(REST);
  const tas = await page.$$eval('.pz', (hs) => hs.map((h) => [h.classList.contains('pz-xy'), getComputedStyle(h).touchAction]));
  if (tas.length) run('part 3: every chart surface takes sideways drags and pinches, vertical swipes stay the page\'s', tas.every(([xy, ta]) => ta === (xy ? 'none' : 'pan-y')));
  else skip();
  const liq = await page.evaluate(() => { const h = document.querySelector('#best [data-pz^="liq"]'); return h ? h.dataset.pz : null; });
  if (liq) {
    await press(`[data-act="zreset"][data-chart="${liq}"]`); await sleep(250);
    const v0 = await view(liq);
    let b = await box(liq);
    await fingers([{ id: 31, x0: b.x + b.w / 2, y0: b.y + b.h / 2, x1: b.x + b.w / 2 - 110, y1: b.y + b.h / 2 }], { steps: 12, ms: 30 });
    run('part 3: a finger drags the depth chart sideways', num(await settle(liq), 0) !== num(v0, 0));
    await press(`[data-act="zreset"][data-chart="${liq}"]`); await sleep(250);
    b = await box(liq);
    await fingers(pinchPts(b, 2)); await sleep(200);
    const v1 = await settle(liq);
    run('part 3: spreading two fingers zooms the depth chart in (the view about halves)', Math.abs(num(v1, 1) / num(v0, 1) - 0.5) < 0.03);
    b = await box(liq);
    await fingers(pinchPts(b, 1, { mx: 80 })); await sleep(200);
    const v2 = await settle(liq);
    run('part 3: two fingers moved together pan it, at the same zoom', num(v2, 0) !== num(v1, 0) && Math.abs(num(v2, 1) - num(v1, 1)) < 1e-3);
    // pinching closed (a wide field can take a few pinches) stops at the whole field: no hatch, − disabled
    let v3 = v2, rest = null;
    for (let k = 0; k < 5; k++) {
      b = await box(liq);
      await fingers(pinchPts(b, 0.15, { d0: 170 })); await sleep(250);
      v3 = await settle(liq);
      rest = await page.evaluate((id) => ({ hatch: document.querySelectorAll(`[data-pz="${id}"] .pz-end`).length, out: !!(document.querySelector(`[data-act="zoom"][data-chart="${id}"][data-dir="-1"]`) || {}).disabled }), liq);
      if (rest.out) break;
    }
    run('part 3: pinched closed, it stops at the whole field: no hatch, − disabled', rest.hatch === 0 && rest.out && num(v3, 1) >= num(v0, 1));
    b = await box(liq);
    for (let k = 0; k < 2; k++) { await fingers([{ id: 51 + k, x0: b.x + b.w / 2, y0: b.y + 70, x1: b.x + b.w / 2, y1: b.y + 70 }], { steps: 1, ms: 10 }); await sleep(90); }
    run('part 3: a double tap with a finger resets it', (await settle(liq)) === v0);
    const g = await page.evaluate((id) => document.querySelector(`[data-pz="${id}"]`).dispatchEvent(new Event('gesturestart', { bubbles: true, cancelable: true })), liq);
    run('part 3: Safari\'s own pinch (gesturestart) never zooms the page from a chart', g === false);
  } else { skip(); skip(); skip(); skip(); skip(); skip(); }
  if (await page.evaluate(() => !!document.querySelector('#best [data-pz="daily-best"]'))) {
    await press('[data-act="zreset"][data-chart="daily-best"]'); await sleep(200);
    const d0 = await view('daily-best'), b = await box('daily-best');
    await fingers(pinchPts(b, 2, { fx: 0.7 })); await sleep(200);
    const d1 = await settle('daily-best');
    run('part 3: a pinch on the daily strip shows fewer days', num(d1, 1) < num(d0, 1) * 0.75 || num(d0, 1) <= 2.01);
    await press('[data-act="zreset"][data-chart="daily-best"]'); await sleep(200);
  } else skip();
  // the bar on top: slim; away going down, back going up
  const bar = () => page.evaluate(() => { const b = document.querySelector('#top'), r = b.getBoundingClientRect(); return { h: r.height, hid: b.classList.contains('hid'), bottom: r.bottom, top: r.top, strip: document.querySelector('#mstrip').getBoundingClientRect().bottom }; });
  // each read waits for the scroll's frame and the bar's slide to end (fixed sleeps were too short for WebKit on CI)
  await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, 0); }); await sleep(300); await rest();
  const h0 = await bar();
  await page.evaluate(() => scrollTo(0, 1100)); await sleep(150); await rest();
  const h1 = await bar();
  await page.evaluate(() => scrollBy(0, -140)); await sleep(150); await rest();
  const h2 = await bar();
  run('part 3: the bar on top is one slim row (≤ 52 px)', h0.h >= 44 && h0.h <= 52 && !h0.hid);
  run('part 3: scrolling down slides it away and the market strip scrolls off; scrolling up brings the bar back', h1.hid && h1.bottom <= 0 && h1.strip < 0 && !h2.hid && Math.abs(h2.top) <= 1);
  await page.evaluate(() => scrollTo(0, 0)); await sleep(300);
  // an explainable word: a short note inside the screen, closed by Esc
  if (await press('#best [data-act="term"]')) {
    await sleep(200); await rest();
    const pop = await page.evaluate(() => { const e = document.querySelector('#pop'), r = e.getBoundingClientRect(), bb = document.querySelector('#top').classList.contains('hid') ? 0 : document.querySelector('#top').getBoundingClientRect().bottom; return { on: !e.hidden, gl: ((e.querySelector('.gl') || {}).textContent || '').length, inside: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= bb - 1 && r.bottom <= innerHeight + 1 }; });
    await page.keyboard.press('Escape'); await sleep(200);
    run('part 3: a tap on an explainable word opens a short note inside the screen, below the bar; Esc closes it', pop.on && pop.gl >= 25 && pop.inside && !(await page.isVisible('#pop')));
  } else skip();
  // v0.4.7: the detail panel's pinned top is one slim row (≤ 60 px) that keeps its height while the content scrolls
  if (await press('#best [data-act="detail"]')) {
    await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(500);
    const long = await page.evaluate(() => { const b = document.querySelector('#sheet-body'); return b.scrollHeight - b.clientHeight > 400; });
    if (long) {
      const hs = new Set(), jumps = [];
      for (const y of [0, 80, 220, 420, 220, 0]) { await page.evaluate((y) => { document.querySelector('#sheet-body').scrollTop = y; }, y); await sleep(130); await rest(); const r = await page.evaluate(() => { const c = document.querySelector('#sheet .sheet-card'), h = document.querySelector('#sheet .sheet-head').getBoundingClientRect(); return [Math.round(h.bottom - c.getBoundingClientRect().top), document.querySelector('#sheet-body').scrollTop]; }); hs.add(r[0]); jumps.push(Math.abs(r[1] - y) > 1); }
      run('part 3: the panel\'s pinned top is one slim row (≤ 60 px) that keeps its height while the content scrolls, which never jumps', hs.size === 1 && [...hs][0] <= 60 && !jumps.some(Boolean));
    } else skip();
    const lb = await box('liq-detail', '#sheet');
    if (lb) {
      const a = await view('liq-detail');
      await page.evaluate(FINGERS, { pts: pinchPts(lb, 2) }); await sleep(250);
      run('part 3: in the panel a pinch zooms its chart and the panel stays open', num(await settle('liq-detail'), 1) < num(a, 1) * 0.6 && (await page.isVisible('#sheet')));
    } else skip();
    await page.click('#sheet-close').catch(() => {}); await sleep(300);
  } else { skip(); skip(); }
}
// ---------- 2d2. Run 2 part 3: the stablecoin-pairs switch, the whole-field depth chart, the fee history ----------
// Booleans and counts only: how many rows a list has, never which pools.
async function part4(page, run, skip, press) {
  const read = () => page.evaluate(() => {
    const c = document.querySelector('#all-count').textContent, m = /OF (\d+)/.exec(c);
    return { on: document.querySelector('#f-stab').getAttribute('aria-checked'), total: m ? +m[1] : null, hid: parseInt(document.querySelector('#f-stab-n').textContent, 10), flag: /HIDDEN · STABLECOIN PAIRS OFF/.test(c), focus: document.activeElement && document.activeElement.id };
  });
  if (await page.$('#f-stab')) {
    await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-stab').scrollIntoView({ block: 'center' }); }); await sleep(200);
    const s0 = await read();
    await page.click('#f-stab'); await sleep(600);
    const s1 = await read();
    await page.click('#f-stab'); await sleep(600);
    const s2 = await read();
    const [off, on] = s0.on === 'false' ? [s0, s1] : [s1, s0];
    run('part 4: the stablecoin-pairs switch turns on and off and keeps the focus', s1.on !== s0.on && s2.on === s0.on && s1.focus === 'f-stab' && s2.focus === 'f-stab');
    run('part 4: off, the table counts the hidden pairs; on, it lists them all again (counts agree)', off.total != null && on.total === off.total + (off.hid || 0) && (off.hid > 0) === off.flag && !on.flag);
    await press('#all .ibtn'); await sleep(250);
    run('part 4: the switch\'s ⓘ opens a note, Esc closes it', (await page.isVisible('#pop')) && (await page.evaluate(() => document.querySelector('#pop').textContent.length > 80)));
    await page.keyboard.press('Escape'); await sleep(200);
  } else { skip(); skip(); skip(); }
  // the depth chart zoomed all the way out: the whole field, never a "no data" hatch
  const liq = await page.evaluate(() => { const h = document.querySelector('#best [data-pz^="liq"]'); return h ? h.dataset.pz : null; });
  if (liq) {
    await press(`[data-act="zreset"][data-chart="${liq}"]`); await sleep(250);
    let k = 0;
    for (; k < 10 && (await press(`[data-act="zoom"][data-chart="${liq}"][data-dir="-1"]`)); k++) await sleep(200);
    const z = await page.evaluate((id) => { const h = document.querySelector(`[data-pz="${id}"]`); return { hatch: h.querySelectorAll('.pz-end').length, bars: (h.querySelector('svg path') || {}).getAttribute ? h.querySelectorAll('svg path').length : 0, txt: /NO DATA/.test(h.textContent) }; }, liq);
    run('part 4: − steps the depth chart out to its whole field and stops: bars, no hatch, no "no data"', k >= 1 && z.hatch === 0 && z.bars > 0 && !z.txt);
    await press(`[data-act="zreset"][data-chart="${liq}"]`); await sleep(250);
  } else skip();
  // the detail panel's fee history: hourly and daily bars, zoom out stops at their span, a drag pans
  if (await press('#best [data-act="detail"]')) {
    await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(500);
    const ids = await page.$$eval('#sheet [data-pz="d-hr"], #sheet [data-pz="d-day"]', (h) => h.map((x) => x.dataset.pz));
    if (ids.length) {
      let good = 0;
      for (const id of ids) {
        for (let k = 0; k < 6 && (await press(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="-1"]`)); k++) await sleep(120);
        const st = await page.evaluate((id) => { const h = document.querySelector(`[data-pz="${id}"]`), v = h.dataset.view.split(',').map(Number); return { full: Math.abs(v[0] - v[1]) < 1e-3, bars: h.querySelectorAll('svg > rect').length, out: document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="-1"]`).disabled }; }, id);
        if (st.full && st.out && st.bars > 0) good++;
      }
      run(`part 4: the panel's fee history (${ids.length} chart${ids.length === 1 ? '' : 's'}) zooms out to its whole span and stops there`, good === ids.length);
    } else skip();
    await page.click('#sheet-close').catch(() => {}); await sleep(300);
  } else skip();
}
// ---------- 2d3. v0.4.7: the fee charts' scale and pool switch, "$ per day at the ticket" next to every APR ----------
// Booleans and counts only.
async function part5(page, run, skip, press) {
  // every APR the home page shows carries its $/day (found by structure: APR columns, the lists, the bench, the breakdown)
  const apr = await page.evaluate(() => {
    let n = 0, bad = 0;
    const has = (el) => { if (!el || !el.getClientRects().length || !/\d%/.test(el.textContent)) return; n++; if (!/\$[\d.,]+[KMB]?\/day/.test(el.textContent)) bad++; };
    for (const tb of document.querySelectorAll('table')) { const hs = [...(tb.tHead ? tb.tHead.rows[0].cells : [])].map((c) => c.textContent); hs.forEach((h, i) => { if (/APR/.test(h) && !/forecast/.test(h)) for (const tr of tb.tBodies[0] ? tb.tBodies[0].rows : []) has(tr.cells[i]); }); }
    for (const e of document.querySelectorAll('.apr, #bench .big')) has(e);
    const lead = [...document.querySelectorAll('#best [data-lead]')].some((e) => /At \$[\d,]+: fees ≈ .*\/day · LVR .*\/day · net ≈ .*\/day \(.*% a year\)/.test(e.textContent));
    return { n, bad, lead };
  });
  run('part 5: every APR on the home page carries its $ a day at the ticket, and the best find leads with it', apr.n >= 5 && apr.bad === 0 && apr.lead);
  if (!(await press('#best [data-act="detail"]'))) { skip(); skip(); skip(); return; }
  await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(600);
  const fc = () => page.evaluate(() => { const b = document.querySelector('[data-chartbox="d-day"]'); if (!b) return null; const v = b.querySelector('[data-pz="d-day"]').dataset.view.split(',').map(Number);
    return { ys: b.querySelectorAll('.yax > span').length, grid: b.querySelectorAll('line.grid').length, med: !!b.querySelector('line.median'), ttl: /this pool|each tier|whole pair/.test(b.querySelector('.fc-t').textContent), mode: b.dataset.fc, w: v[1], modes: b.querySelectorAll('[data-act="fmode"]').length, log: !!b.querySelector('[data-act="fscale"][data-v="log"][aria-pressed="true"]') }; });
  const a = await fc();
  if (!a) { skip(); skip(); } else {
    run('part 5: the daily fee chart has a $ axis with gridlines, the typical-day line and says which pool it shows', a.ys >= 2 && a.grid === a.ys && a.med && a.ttl);
    const was = a.log;
    await press(`#sheet-body [data-act="fscale"][data-v="${was ? 'lin' : 'log'}"]`); await sleep(400);
    const b = await fc();
    await press(`#sheet-body [data-act="fscale"][data-v="${was ? 'log' : 'lin'}"]`); await sleep(400);
    const c = await fc();
    let modes = true;
    if (a.modes === 3) for (const m of ['tiers', 'pair', 'this']) { await press(`#sheet-body [data-act="fmode"][data-v="${m}"]`); await sleep(400); const x = await fc(); modes = modes && x && x.mode === m && x.ys >= 2; }
    run('part 5: the linear / log switch and the pool switch (this pool · each tier · whole pair) redraw the chart and come back', b && b.log === !was && b.ys >= 2 && c && c.log === was && modes);
  }
  const h = await page.evaluate(() => { const b = document.querySelector('[data-chartbox="d-hr"]'); return b ? b.querySelectorAll('.yax > span').length >= 2 && !!b.querySelector('line.median') : null; });
  if (h == null) skip(); else run('part 5: the hourly fee chart has its $ axis and typical-hour line', h);
  await page.click('#sheet-close').catch(() => {}); await sleep(300);
}
// ---------- 2d4. v0.4.8: the discovery lanes (one swipe strip per tool). Booleans and counts only. ----------
// A pass without live.json discovery (an older scanner) hides the card: nothing more to check then.
async function part6(page, run, skip) {
  await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, 0); }); await sleep(200);
  const a = await page.evaluate(() => {
    const el = document.querySelector('#disc');
    if (!el) return { exists: false };
    const vw = document.documentElement.clientWidth, lanes = [...el.querySelectorAll('.lane')];
    return { exists: true, hidden: el.hidden, lanes: lanes.length, cards: el.querySelectorAll('.mc.dc').length, junk: /NaN|undefined|Infinity/.test(el.innerText),
      out: [el, ...el.querySelectorAll('*')].filter((x) => !x.closest('.mc-track') && x.getBoundingClientRect().right > vw + 0.5).length,
      counted: lanes.every((l) => /^(\d+ ▸|none this pass.*|not built yet|— not in this pass)$/.test(l.querySelector('.lh .cnt').textContent.trim())),
      short: [...el.querySelectorAll('button')].filter((b) => b.getClientRects().length && b.getBoundingClientRect().height < 43.5 && !b.classList.contains('mc-nav')).length };
  });
  run('part 6: the page has the Discovery card (v0.4.8)', a.exists);
  if (!a.exists || a.hidden) { skip(); skip(); return; }
  run(`part 6: Discovery shows 4 lanes with their counts (${a.cards} cards), nothing junk, nothing past the edge, taps ≥ 44 px`, a.lanes === 4 && a.counted && !a.junk && a.out === 0 && a.short === 0);
  if (!a.cards) { skip(); return; }
  await page.evaluate(() => { const c = document.querySelector('#disc .mc.dc'); c.scrollIntoView({ block: 'center', inline: 'nearest' }); }); await sleep(250);
  await page.click('#disc .mc.dc').catch(() => {});
  await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(500);
  run('part 6: a tap on a discovery card opens that pool', await page.evaluate(() => { const c = document.querySelector('#disc .mc.dc'), t = document.querySelector('#sheet-title'); return !document.querySelector('#sheet').hidden && !!t && t.textContent === c.querySelector('.n').textContent; }));
  await page.click('#sheet-close').catch(() => {}); await sleep(300);
}
// ---------- 2e. text that collides or is cut off, in the views a phone and a laptop show ----------
// The report names sections and element kinds (tag and first class) with counts: never a word of the page's text.
async function overlaps(page, run, tag) {
  const rep = {};
  let views = 0;
  const look = async (root) => { views++; for (const x of await page.evaluate(TEXT_OVERLAP, { root, safe: true })) { const k = `${x.kind} ${x.sec}: ${x.a} × ${x.b}`; rep[k] = (rep[k] || 0) + 1; } };
  const press = (sel) => page.evaluate((sel) => { const b = document.querySelector(sel); if (!b || b.disabled) return false; window.dispatchEvent(new WheelEvent('wheel')); b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel);
  const esc = async () => { await page.keyboard.press('Escape'); await sleep(150); };
  await page.evaluate(() => scrollTo(0, 0)); await sleep(250);
  await look();
  // the best find's liquidity chart: every pool tab, every zoom level, both pan ends (the labels must never collide)
  const tabs = await page.$$eval('#best [role="tab"]', (t) => t.length), t0 = Date.now();
  for (let i = 0; i < tabs && Date.now() - t0 < 90e3; i++) {
    await page.evaluate((i) => document.querySelectorAll('#best [role="tab"]')[i].click(), i); await sleep(80);
    for (const dir of [-1, 1]) {
      for (let z = 0; z < 5; z++) {
        for (const side of ['', 'l', 'r']) {
          if (side) for (let k = 0; k < 10 && (await page.evaluate((s) => { const e = document.querySelector(`#best [data-pz^="liq"] > .pz-edge.${s}:not([hidden])`); if (!e) return false; e.click(); return true; }, side)); k++) await sleep(30);
          await sleep(60); await look('#best .best-r');
        }
        if (!(await page.evaluate((d) => { const b = document.querySelector(`#best [data-act="zoom"][data-dir="${d}"][data-chart^="liq"]`); if (!b || b.disabled) return false; b.click(); return true; }, dir))) break;
        await sleep(60);
      }
      await page.evaluate(() => { const b = document.querySelector('#best [data-act="zreset"][data-chart^="liq"]'); if (b) b.click(); }); await sleep(80);
    }
  }
  for (let k = 0; k < 3 && (await press('[data-act="zoom"][data-chart="daily-best"][data-dir="1"]')); k++) await sleep(100);
  await look('#best');
  await press('[data-act="zreset"][data-chart="daily-best"]'); await sleep(100);
  if (await press('#gas')) { await sleep(200); await look(); await esc(); }
  if (await press('#all tbody .whyb')) { await sleep(200); await look(); await esc(); }
  if (await press('#best [data-act="term"]')) { await sleep(200); await look(); await esc(); }
  if (await page.$('#f-q') && await page.$('#best h2')) {
    const q = await page.evaluate(() => { const t = document.querySelector('#best h2').textContent.trim(); return t.slice(0, 2); }); // two letters, kept in memory only
    await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-q').scrollIntoView({ block: 'start' }); });
    await page.click('#f-q'); await page.keyboard.type(q, { delay: 40 }); await sleep(300);
    await look();
    await esc(); await page.fill('#f-q', ''); await page.$eval('#f-q', (e) => e.blur()); await sleep(300);
  }
  if ((await page.$$('#all-tbl tbody tr.row')).length >= 12) {
    await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#all-tbl tbody tr.row:nth-child(12)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 60); });
    await sleep(300); await page.evaluate(REST); await page.evaluate(() => scrollBy(0, -60)); await sleep(150); await page.evaluate(REST);
    await look();
    await page.evaluate(() => scrollTo(0, 0)); await sleep(250);
  }
  if (await press('#best [data-act="detail"]')) {
    await page.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(500);
    await look('#sheet');
    if (await press('#sim [data-act="sim-all"]')) { await sleep(250); await look('#sheet'); await press('#sim [data-act="sim-all"]'); await sleep(150); }
    for (const id of ['liq-detail', 'daily-detail', 'd-px', 'd-fees', 'd-hr', 'd-day']) for (let k = 0; k < 5 && (await page.evaluate((id) => { const b = document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="-1"]`); if (!b || b.disabled) return false; b.click(); return true; }, id)); k++) await sleep(60);
    await look('#sheet');
    for (const id of ['liq-detail', 'daily-detail', 'd-px', 'd-fees', 'd-hr', 'd-day']) for (let k = 0; k < 6 && (await page.evaluate((id) => { const b = document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`); if (!b || b.disabled) return false; b.click(); return true; }, id)); k++) await sleep(60);
    await look('#sheet');
    await page.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 600; }); await sleep(150); await page.evaluate(REST);
    await look('#sheet');
    await page.click('#sheet-close').catch(() => {}); await sleep(250);
  }
  if (await press('#bt-lead tr.row')) { await sleep(1000); await look('#bt'); }
  const n = Object.values(rep).reduce((a, b) => a + b, 0);
  console.log(`[${tag}] overlap: ${views} views, ${n} findings${n ? ': ' + Object.entries(rep).map(([k, v]) => `${k} ×${v}`).join(', ') : ''}`);
  run('overlap: no text collides with other text or is cut off, in every view walked', n === 0);
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
      await page.evaluate(REST);
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
      try { await target.scrollIntoViewIfNeeded({ timeout: 3000 }); await sleep(150); await page.evaluate(REST); } catch (e) { /* the click below reports it */ }
      const before = await page.evaluate(SNAP), e0 = errTotal(), np0 = newPages, open0 = await page.evaluate(() => window.__laOpen);
      try {
        await target.click({ timeout: 5000 });
        counts.clicked++;
      } catch (e) {
        // a control that went away on its own (an edge button hides once its chart reaches the end) is not a failure;
        // one that is still there but can't be pressed (covered, say) is
        const still = await target.isVisible().catch(() => false);
        if (still) failAs(next.kind, 'not clickable'); else counts.gone = (counts.gone || 0) + 1;
        continue;
      }
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
    console.log(`[${tag}] controls: ${counts.found} found, ${counts.clicked} clicked${counts.gone ? `, ${counts.gone} went away before the press` : ''}`);
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

    // close anything open, then "Sign out on this device"
    t = Date.now();
    for (let k = 0; k < 3 && (await page.evaluate(ENUM)).overlay; k++) { await page.keyboard.press('Escape'); await sleep(300); }
    let locked = false;
    try {
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await page.click('#lockbtn', { timeout: 10000 });
      await page.waitForSelector('#lockscreen:not([hidden])', { timeout: 15000 });
      locked = true;
    } catch (e) { console.log(`[${tag}] lock step stopped: ${errName(e)}`); }
    R.ok('lock: "Sign out on this device" shows the lock screen', locked);
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
