#!/usr/bin/env node
// Browser tests for the dashboard (site/app/index.html) on made-up, sealed fixture data.
// Prints pass/fail, counts and timings only: the fixtures are made up, but the habit stays.
//
//   node tools/site-test.mjs                         Chromium, widths 360…1920 plus reduced motion
//   node tools/site-test.mjs --browser webkit --device "iPhone 15"     phone = that device; laptop 1440
//   node tools/site-test.mjs --shots <dir>           also save full-page screenshots (cut into parts)
//   node tools/site-test.mjs --only unlock,layout    run some groups: unlock layout windows states tabs daily pairs charts pan depth sheets
//                                                    touch sticky top header zoomfit overlap rows refresh market fav table similar highlight
//                                                    search links terms fold locknote clicks motion history stable chains
//                                                    merge feebar stablewalk flash dates
//   node tools/site-test.mjs --page <file>          test another copy of the page (planted faults)
//   node tools/site-test.mjs --verbose              also list every passing check
//   node tools/site-test.mjs --repeat 3              run the chosen groups 3 times over (a timing fault shows up sooner)
//   node tools/site-test.mjs --fix-csp               rewrite the page's CSP script hash after an edit, then exit
//
// Playwright comes from the environment (NODE_PATH); never npm install in the repo.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFixtures, makeData, oldDepth, FIXTURE_PASSPHRASE, STABLE_PROBE_ADDR } from './fixtures/make-fixture.mjs';
import { TEXT_OVERLAP } from './overlap.mjs';
import { FINGERS, HOST_BOX, STILL_BOX, pinchPts } from './gestures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'site', 'app', 'index.html');
const PAGE_OVERRIDE = (() => { const i = process.argv.indexOf('--page'); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; })();
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);

export function scriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
}
if (flag('fix-csp')) {
  const html = fs.readFileSync(PAGE, 'utf8');
  fs.writeFileSync(PAGE, html.replace(/script-src [^;]*;/, `script-src ${scriptHashes(html).join(' ')};`));
  console.log('csp: script hash updated');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const pw = require('playwright');
const BROWSER = opt('browser', 'chromium');
const DEVICE = opt('device');
const SHOTS = opt('shots');
const ONLY = (opt('only') || 'unlock,layout,windows,market,states,tabs,daily,pairs,charts,pan,depth,history,stable,touch,sheets,sticky,top,header,zoomfit,overlap,rows,refresh,fav,table,similar,chains,highlight,search,links,terms,fold,locknote,clicks,motion,merge,feebar,stablewalk,flash,dates').split(',');
const WIDTHS = DEVICE ? [] : [360, 375, 390, 430, 768, 1024, 1300, 1440, 1920];
const LAPTOP = DEVICE ? [768, 1440] : [];

// the same made-up pass the page reads (pool ids, shapes and history rows don't depend on the time it is made at)
const FXD = makeData({ now: Date.now() });
const poolOf = (id) => FXD.live.pools.find((x) => x.id === id);
const bestId = (page) => page.getAttribute('#best [data-act="detail"]', 'data-id');

// ---------- results: names and short reasons only ----------
const results = [];
const ok = (name, cond, why = '') => { results.push({ name, pass: !!cond, why: cond ? '' : why }); return !!cond; };

// ---------- a static server: the page under /app/, fixture cases under /fx/ ----------
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-site-'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let file = null;
    if (u.pathname === '/app/index.html' && PAGE_OVERRIDE) file = PAGE_OVERRIDE; // a planted-fault copy of the page
    else if (u.pathname.startsWith('/app/')) file = path.join(ROOT, 'site', 'app', u.pathname.slice(5) || 'index.html');
    else if (u.pathname.startsWith('/fx/')) file = path.join(FX, u.pathname.slice(4));
    const inside = file && (file === PAGE_OVERRIDE || file.startsWith(path.join(ROOT, 'site', 'app')) || file.startsWith(FX));
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ---------- helpers ----------
let ORIGIN = '';
const url = (c, q = '') => `${ORIGIN}/app/index.html?base=/fx/${c}/${q}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Most groups read every pool, so their pages start with the stablecoin-pairs switch on; `stableDefault: true` leaves the
// page's own default (off), and the stable group and the overlap walk use it.
// The competition flash (v0.4.5) plays when a pool's detail opens; groups that read the detail's chart at once turn its
// auto-play off (`flash: true` leaves it on: the flash group and the walk-through). A tap on its badge still plays it.
async function newPage(browser, { phone = false, width = 390, height = 860, reducedMotion = 'no-preference', storage = null, stableDefault = false, flash = false } = {}) {
  if (!stableDefault) storage = { 'lps.stable': '1', ...(storage || {}) };
  const base = phone && DEVICE ? { ...pw.devices[DEVICE] } : { viewport: phone ? { width: 390, height: 844 } : { width, height } }; // phone = 390 px here, the device in Actions
  if (BROWSER !== 'chromium') delete base.defaultBrowserType;
  const ctx = await browser.newContext({ ...base, reducedMotion });
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  if (!flash) await ctx.addInitScript(() => { window.__lpsNoFlash = true; });
  await ctx.addInitScript(() => { window.open = (u) => { (window.__opened ||= []).push(String(u)); return null; }; }); // "open in a new window" is recorded, not opened
  await ctx.addInitScript(() => document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[target="_blank"]'); if (a && !window.__allowExt) { e.preventDefault(); (window.__opened ||= []).push(a.href); } }, true)); // explorer links: recorded, never followed
  const page = await ctx.newPage();
  // ST_CPU=6 (Chromium only, local): a slow device, to shake out checks that assume a frame every 16 ms
  if (process.env.ST_CPU && BROWSER === 'chromium') { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +process.env.ST_CPU }); }
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e.message).split('\n')[0].slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console ' + m.text().slice(0, 120)); });
  return { ctx, page, errors };
}
async function unlockWith(page, pass) {
  await page.waitForSelector('#lockscreen:not([hidden])', { timeout: 20000 });
  await page.fill('#pass', pass);
  await page.click('#unlock-btn');
}
async function waitApp(page) {
  await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#best') && document.querySelector('#best').children.length > 0, null, { timeout: 15000 });
  await sleep(250);
}
async function openUnlocked(browser, c = 'default', o = {}) {
  const t = await newPage(browser, o);
  await t.page.goto(url(c, o.q || ''));
  await unlockWith(t.page, FIXTURE_PASSPHRASE);
  await waitApp(t.page);
  const wk = o.win === undefined ? '30d' : o.win; // most checks read the 30-day view; null keeps the page's own default
  if (wk && (await t.page.getAttribute(`#winseg [data-w="${wk}"]`, 'aria-pressed')) !== 'true') await setWin(t.page, wk);
  return t;
}
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const domText = (page) => page.evaluate(() => document.body.textContent); // hidden elements included: locked means gone, not hidden
const noJunk = (txt) => !/\bNaN\b|\bundefined\b|\bInfinity\b|\[object |— of the —|\$1\.0K/.test(txt); // a dash sentence or a rounded ticket is junk too
// type into the table's search, then leave the box (its suggestion list closes and stays out of the way of the rows)
// The table filters 120 ms after the last keystroke (a timer): on a slow WebKit that timer can fire well after 150 ms, and
// the rows read before it are the unfiltered table's. A page timer set after the page's own two (filter, and closing the
// suggestion list 120 ms after the blur) with a longer delay runs after them, however late they fire (HTML timer order).
async function fillQ(page, v) {
  await page.fill('#f-q', v); await page.$eval('#f-q', (e) => e.blur());
  await page.evaluate(() => new Promise((r) => setTimeout(r, 140)));
  await frames(page, 2);
}
async function setWin(page, wk) { await page.click(`#winseg button[data-w="${wk}"]`); await sleep(150); }

// ---------- 1. unlock: wrong, right, kept, locked ----------
async function testUnlock(browser) {
  const { ctx, page, errors } = await newPage(browser, { phone: true });
  await page.goto(url('default'));
  await page.waitForSelector('#lockscreen:not([hidden])');
  ok('unlock: asks for the passphrase on first visit', await page.isVisible('#pass'));
  ok('unlock: no window switch before there is data', !(await page.isVisible('#winseg')));
  ok('unlock: no data before the key', !(await page.isVisible('#app')) && !(await domText(page)).includes('VELNA'));
  await unlockWith(page, 'not the passphrase');
  await page.waitForSelector('#lock-msg.err', { timeout: 20000 });
  ok('unlock: a wrong passphrase gets a clear message', /Wrong passphrase/.test(await page.textContent('#lock-msg')));
  await snap(page, 'state-wrong-pass');
  ok('unlock: a wrong passphrase shows no data', !(await page.isVisible('#app')) && !(await domText(page)).includes('VELNA'));
  await page.fill('#pass', FIXTURE_PASSPHRASE);
  await page.click('#unlock-btn');
  await waitApp(page);
  ok('unlock: the right passphrase opens the data', (await page.textContent('#best h2')) === 'NUMA/USDC');
  ok('unlock: fixture data carries the MOCKUP ribbon', await page.isVisible('#ribbon'));
  ok('unlock: footer shows the BUILD constant', /build v\d/.test(await page.textContent('#foot-l')));
  ok('unlock: opens at the top', (await page.evaluate(() => scrollY)) === 0);
  await page.reload();
  await waitApp(page);
  ok('unlock: the device stays unlocked after a reload', await page.isVisible('#app'));
  // use the page the way the live audit does first: a pool's detail with its similar pools, a note, the search list,
  // a favourite, another best-find tab, the backtest; then sign out: nothing that names a pool may be left anywhere
  // (text, titles, attributes, form values, the tab title), in the main view, the closed panel or the strips
  await page.evaluate(() => document.querySelector('#best [data-act="detail"]').click());
  await page.waitForSelector('#sheet:not([hidden])'); await sleep(300);
  await page.evaluate(() => { const b = document.querySelector('#sim [data-act]'); if (b) b.click(); });
  await sleep(150);
  await page.evaluate(() => { const b = document.querySelector('#sheet [data-act="fav"]'); if (b) b.click(); });
  await page.click('#sheet-close'); await sleep(200);
  await page.evaluate(() => { const b = document.querySelector('#best [data-act="tab"]:not([aria-selected="true"])'); if (b) b.click(); });
  await page.evaluate(() => { const b = document.querySelector('#all tbody .whyb'); if (b) b.click(); }); await sleep(150);
  await page.evaluate(() => document.querySelector('#bt-lead tr.row').click()); await sleep(300);
  await page.fill('#f-q', FXD.live.pools[0].pair.split('/')[0].slice(0, 3)); await sleep(250);
  const NAMES = [...new Set(FXD.live.pools.flatMap((x) => [x.pair, x.id]))];
  const leftover = (page) => page.evaluate((names) => {
    const low = names.map((x) => x.toLowerCase()), hits = new Set(), hit = (v, where) => { const t = String(v || '').toLowerCase(); if (t && low.some((x) => t.includes(x))) hits.add(where); };
    hit(document.title, 'title');
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) if (!n.parentElement.closest('script, style')) hit(n.nodeValue, 'text in ' + (n.parentElement.closest('[id]') || {}).id);
    for (const el of document.body.querySelectorAll('*')) { for (const a of el.attributes) hit(a.value, a.name + ' on ' + (el.closest('[id]') || {}).id); if ('value' in el && el.tagName !== 'BUTTON') hit(el.value, 'value of ' + el.id); }
    return [...hits];
  }, NAMES);
  const before = await leftover(page);
  await page.click('#lockbtn');
  await page.waitForSelector('#lockscreen:not([hidden])');
  const left = await leftover(page);
  ok('lock: "Sign out on this device" removes every number', (await page.textContent('#lockbtn')) === 'Sign out on this device' && !(await page.isVisible('#app')) && !(await domText(page)).includes('VELNA'));
  ok(`lock: after sign-out nothing names a pool anywhere in the page: text, titles, attributes, form values, the tab title (${before.length} places before)`, before.length >= 3 && left.length === 0, left.slice(0, 4).join(', '));
  await page.reload();
  await page.waitForSelector('#lockscreen:not([hidden])');
  ok('lock: after a reload the device asks again', await page.isVisible('#pass'));
  ok('unlock: no page errors', errors.length === 0, errors[0]);
  await ctx.close();
}

// ---------- 2. layout at every width ----------
const AUDIT = () => {
  const vw = document.documentElement.clientWidth, out = { hscroll: document.documentElement.scrollWidth - vw, offRight: [], small: [], short: [], clipped: [], covered: [] };
  const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const inScroll = (el) => !!el.closest('.tbl-box, .heat-box, .sheet-body, .tabs');
  const name = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) + ' "' + (el.textContent || '').trim().slice(0, 24) + '"';
  for (const el of document.querySelectorAll('#app *, header *, #subhead *, footer *, #banner')) {
    if (!vis(el) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue; // an svg's own box counts, its insides don't
    const r = el.getBoundingClientRect();
    if (!inScroll(el) && (r.right > vw + 1 || r.left < -1)) out.offRight.push(name(el));
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), mono = /mono/i.test(cs.fontFamily);
      if (fs < 10 || (fs < 12 && !mono)) out.small.push(name(el) + ' ' + fs + 'px');
      const srOnly = r.width <= 1 && r.height <= 1 && cs.overflow === 'hidden'; // read aloud only: a visually hidden label
      if (!srOnly && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1 && !((el.classList.contains('pn') || (el.classList.contains('pn2') && el.title)) && el.textContent.length > 16)) out.clipped.push(name(el)); // a long pair name ends in … (its title holds it whole)
    }
    if (el.matches('button, select, input, [role="button"]') && el.getBoundingClientRect().height < 43.5) out.short.push(name(el) + ' ' + Math.round(r.height) + 'px');
  }
  // labels and headings must not be hidden under something else
  const labels = [...document.querySelectorAll('#app .lbl, #app h2, #app h3, #app .chip, header .lbl, header h1, #subhead .lbl')].filter((el) => vis(el) && !el.closest('tbody, .tbl-box'));
  for (const el of labels) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect(), x = Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width / 2, 6))), y = r.top + r.height / 2;
    if (y < 0 || y > innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) out.covered.push(name(el) + ' under ' + name(hit));
  }
  scrollTo(0, 0);
  out.labels = labels.length;
  return out;
};
async function shoot(page, tag) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => scrollTo(0, 0));
  const full = path.join(SHOTS, tag + '.png');
  await page.screenshot({ path: full, fullPage: true });
  const h = await page.evaluate(() => document.documentElement.scrollHeight), w = await page.evaluate(() => document.documentElement.clientWidth);
  const part = w < 700 ? 1500 : 1100;
  for (let i = 0, y = 0; y < h; i++, y += part) await page.screenshot({ path: path.join(SHOTS, `${tag}-p${i}.png`), fullPage: true, clip: { x: 0, y, width: w, height: Math.min(part, h - y) } });
}
async function auditAt(page, tag) {
  await sleep(350);
  const a = await page.evaluate(AUDIT);
  ok(`layout ${tag}: no horizontal page scroll`, a.hscroll <= 0, a.hscroll + 'px');
  ok(`layout ${tag}: nothing sticks out of the page`, a.offRight.length === 0, a.offRight.slice(0, 3).join(', '));
  ok(`layout ${tag}: text ≥ 12 px, labels ≥ 10 px`, a.small.length === 0, a.small.slice(0, 3).join(', '));
  ok(`layout ${tag}: buttons ≥ 44 px tall`, a.short.length === 0, a.short.slice(0, 3).join(', '));
  ok(`layout ${tag}: no clipped text`, a.clipped.length === 0, a.clipped.slice(0, 3).join(', '));
  ok(`layout ${tag}: every label visible (${a.labels})`, a.covered.length === 0 && a.labels > 20, a.covered.slice(0, 2).join(', '));
  ok(`layout ${tag}: no NaN / undefined / Infinity`, noJunk(await bodyText(page)));
  await shoot(page, tag);
}
async function testLayout(browser) {
  const t = await openUnlocked(browser, 'default', { width: 1440 });
  for (const w of WIDTHS) { await t.page.setViewportSize({ width: w, height: 900 }); await auditAt(t.page, 'w' + w); }
  for (const w of LAPTOP) { await t.page.setViewportSize({ width: w, height: 900 }); await auditAt(t.page, 'w' + w); }
  // a replay and the detail sheet, opened, at a laptop width
  await t.page.setViewportSize({ width: 1440, height: 900 });
  await t.page.click('#bt-lead tr.row');
  await sleep(500);
  await auditAt(t.page, 'w1440-replay');
  await t.page.click('#best [data-act="detail"]');
  await sleep(300);
  ok('layout w1440: detail sheet has no NaN', noJunk(await t.page.innerText('#sheet')));
  if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'sheet-w1440.png') });
  ok('layout: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  // the phone (a device in Actions, 390 px here), reduced motion included
  const ph = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' });
  await auditAt(ph.page, DEVICE ? DEVICE.replace(/\s+/g, '-').toLowerCase() : 'w390-reduced');
  await ph.page.click('#bt-lead tr.row');
  await sleep(500);
  await auditAt(ph.page, DEVICE ? 'phone-replay' : 'w390-replay');
  await ph.page.click('#best [data-act="detail"]');
  await sleep(300);
  const sheet = await ph.page.evaluate(() => { const b = document.querySelector('#sheet-body'); return { hs: b.scrollWidth - b.clientWidth, txt: b.innerText }; });
  ok('layout phone: detail sheet has no sideways scroll', sheet.hs <= 0, sheet.hs + 'px');
  ok('layout phone: detail sheet has no NaN', noJunk(sheet.txt));
  if (SHOTS) await ph.page.screenshot({ path: path.join(SHOTS, 'sheet-phone.png') });
  ok('layout phone: no page errors', ph.errors.length === 0, ph.errors[0]);
  await ph.ctx.close();
}

// ---------- 3. the window switch changes every tile ----------
const TILES = ['#scanner', '#bench', '#best', '#next', '#all tbody', '#bt-lead', '#bt-lab', '#ns-body'];
async function testWindows(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, win: null });
    const tag = phone ? 'phone' : 'laptop';
    ok(`windows ${tag}: 24H is the default (the data's own)`, (await t.page.getAttribute('#winseg [data-w="24h"]', 'aria-pressed')) === 'true');
    const seen = {};
    for (const wk of ['24h', '7d', '30d']) {
      await setWin(t.page, wk);
      ok(`windows ${tag}: ${wk} is pressed`, (await t.page.getAttribute(`#winseg [data-w="${wk}"]`, 'aria-pressed')) === 'true');
      for (const sel of TILES) (seen[sel] ||= []).push((await t.page.innerText(sel)).replace(/24-hour|7-day|30-day|24H|7D|30D|\b(24h|7d|30d)\b/gi, '·'));
      ok(`windows ${tag}: ${wk} has no NaN`, noJunk(await bodyText(t.page)));
    }
    for (const sel of TILES) ok(`windows ${tag}: ${sel} changes with the window`, new Set(seen[sel]).size === 3);
    await setWin(t.page, '7d');
    await t.page.reload();
    await waitApp(t.page);
    ok(`windows ${tag}: the choice is remembered on this device`, (await t.page.getAttribute('#winseg [data-w="7d"]', 'aria-pressed')) === 'true');
    ok(`windows ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4. states: fresh, late, stale, empty, missing, re-keyed, failing, planted faults ----------
async function snap(page, tag, sel) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await (sel ? page.locator(sel).first().screenshot({ path: path.join(SHOTS, tag + '.png') }) : page.screenshot({ path: path.join(SHOTS, tag + '.png') })); } }
async function badge(page) { return { cls: await page.getAttribute('#fresh', 'class'), txt: await page.textContent('#fresh-t') }; }
async function testStates(browser) {
  let t = await openUnlocked(browser, 'default');
  let b = await badge(t.page);
  ok('states: a fresh pass shows FRESH in green', /fresh/.test(b.cls) && /^FRESH · \d\d:\d\d · /.test(b.txt), b.txt);
  // failing refresh: keep the last good data, marked stale
  await t.page.route('**/live.json*', (r) => r.abort());
  await t.page.evaluate(() => window.LPS.refresh());
  await t.page.waitForSelector('#banner:not([hidden])', { timeout: 10000 });
  b = await badge(t.page);
  await snap(t.page, 'state-refresh-failed');
  ok('states: a failed refresh keeps the last good data', (await t.page.textContent('#best h2')) === 'VELNA/WETH' && (await t.page.isVisible('#app')));
  ok('states: …marked stale with a banner', /stale/.test(b.cls) && /REFRESH FAILED/.test(b.txt) && /Couldn’t refresh/.test(await t.page.textContent('#banner')), b.txt);
  await t.page.unroute('**/live.json*');
  await t.page.evaluate(() => window.LPS.refresh());
  await t.page.waitForSelector('#banner', { state: 'hidden', timeout: 10000 });
  ok('states: the banner clears when the data comes back', /fresh/.test((await badge(t.page)).cls));
  // planted faults
  await fillQ(t.page, 'onerror');
  await sleep(300);
  ok('planted: an HTML ticker is printed as text, never run', (await t.page.evaluate(() => window.__xss)) === undefined && (await t.page.$$('#app img')).length === 0);
  ok('planted: …and shows up literally in the table', (await t.page.innerText('#all tbody')).includes('<img src=x'));
  await fillQ(t.page, 'TALI');
  await sleep(300);
  await fillQ(t.page, '');
  await sleep(300);
  if (await t.page.isVisible('#all-more button')) { await t.page.click('#all-more button'); await sleep(200); }
  for (const wk of ['24h', '7d', '30d']) {
    await setWin(t.page, wk);
    const gems = await t.page.evaluate(() => ({ head: +((document.querySelector('#next .sub').textContent.match(/(\d+) gems?/) || [])[1]), pills: document.querySelectorAll('#all tbody .pill.gem').length }));
    ok(`planted ${wk}: the gem count never includes an unverified pool`, gems.head === gems.pills, `${gems.head} vs ${gems.pills}`);
  }
  await fillQ(t.page, 'TALI');
  await sleep(300);
  for (const wk of ['24h', '7d', '30d']) {
    await setWin(t.page, wk);
    ok(`planted ${wk}: an unverified pool is never the best find`, (await t.page.textContent('#best h2')) !== 'TALI/WETH');
    ok(`planted ${wk}: …and carries UNVERIFIED with a void score`, (await t.page.innerText('#all tbody')).includes('UNVERIFIED') && (await t.page.$$('#all tbody .pill.void')).length > 0);
  }
  for (const [q, cols] of [['ZINTH', ['tvl', 'room', 'net']], ['CALDO', ['sigma', 'edge', 'net']], ['BRISK', ['feeApr', 'net', 'edge']], ['LOMA', ['room', 'net']]]) {
    await fillQ(t.page, q);
    await sleep(300);
    const cells = await t.page.evaluate((cols) => {
      const keys = [...document.querySelectorAll('#all thead button')].map((b) => b.dataset.k), tr = document.querySelector('#all tbody tr');
      return cols.map((k) => tr && tr.children[keys.indexOf(k)] ? tr.children[keys.indexOf(k)].textContent.trim() : '?');
    }, cols);
    ok(`missing is never zero: ${q} shows — for ${cols.join(', ')}`, cells.every((c) => c === '—'), cells.join(' '));
  }
  await fillQ(t.page, '');
  await setWin(t.page, '24h');
  ok('states: a not-checked pool may be a gem, tagged NOT CHECKED', (await t.page.textContent('#best h2')) === 'NUMA/USDC' && (await t.page.innerText('#best')).includes('NOT CHECKED'));
  await setWin(t.page, '30d');
  await fillQ(t.page, 'PRAXO');
  await sleep(300);
  ok('states: a fresh pool without a 30-day window shows dashes and a tag', /NO 30D DATA/.test(await t.page.innerText('#all tbody')) && (await t.page.innerText('#all tbody')).includes('—'));
  ok('states: no page errors (default)', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();

  for (const [c, cls, re] of [['amber', 'late', /^LATE · \d\d:\d\d · 2\d MIN AGO/], ['stale', 'stale', /^STALE · \d\d:\d\d · 3\.2 h old/]]) {
    t = await openUnlocked(browser, c);
    b = await badge(t.page);
    ok(`states: ${c} data shows ${cls}`, b.cls.includes(cls) && re.test(b.txt), b.txt);
    await snap(t.page, 'state-' + c, 'header');
    await t.ctx.close();
  }
  t = await openUnlocked(browser, 'nogems');
  ok('states: no gems → an honest empty best find', /No gem in the/.test(await t.page.innerText('#best')));
  await snap(t.page, 'state-nogems');
  ok('states: no gems → no backtests yet', /No backtests/.test(await t.page.innerText('#bt')));
  ok('states: the backtest badge names the 3-day gate', /PROVISIONAL UNTIL THE 3-DAY GATE/.test(await t.page.innerText('#bt')));
  ok('states: no gems → no NaN', noJunk(await bodyText(t.page)));
  ok('states: no page errors (nogems)', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  t = await openUnlocked(browser, 'nofiles');
  ok('states: missing backtest file → "not published yet"', /No backtests published yet/.test(await t.page.innerText('#bt')));
  ok('states: missing history file → health says so', /history not published yet/.test(await t.page.innerText('#health')));
  await snap(t.page, 'state-nofiles-bt', '#bt');
  ok('states: no page errors (nofiles)', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  // re-keyed data: the lock opens, the data doesn't, nothing shows
  t = await newPage(browser);
  await t.page.goto(url('rekeyed'));
  await unlockWith(t.page, FIXTURE_PASSPHRASE);
  await t.page.waitForSelector('#loaderr:not([hidden])', { timeout: 20000 });
  await snap(t.page, 'state-rekeyed');
  ok('states: data sealed under another key shows nothing', !(await t.page.isVisible('#app')) && /different passphrase/.test(await t.page.textContent('#loaderr')) && !(await domText(t.page)).includes('VELNA'));
  await t.ctx.close();
  // no lock file at all
  t = await newPage(browser);
  await t.page.goto(url('missing-case'));
  await t.page.waitForSelector('#lock-msg.err', { timeout: 20000 });
  await snap(t.page, 'state-nolock');
  ok('states: a missing lock file is said plainly, with a retry', /Can’t load the lock file/.test(await t.page.textContent('#lock-msg')) && (await t.page.isVisible('#lock-retry')));
  await t.ctx.close();
  // new since you last looked: per device
  const now = Date.now();
  t = await openUnlocked(browser, 'default', { storage: { 'lps.lastVisit': String(now - 2 * 3600e3) } });
  const ns = await t.page.innerText('#ns-body');
  ok('states: new since 2 h ago lists only the newer gem', ns.includes('NUMA/USDC') && !ns.includes('VELNA/WETH'), ns.slice(0, 40));
  await t.ctx.close();
  t = await openUnlocked(browser, 'default', { storage: { 'lps.lastVisit': String(now + 60e3) } });
  ok('states: nothing new says "Nothing new"', /Nothing new/.test(await t.page.innerText('#ns-body')));
  await t.ctx.close();
}

// ---------- 4b. best-find tabs: every tab swaps the whole card ----------
async function testTabs(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const tabs = await p.$$eval('#best [role="tab"]', (ts) => ts.map((x) => ({ id: x.dataset.id, pair: x.querySelector('.tn').textContent, tags: x.innerText })));
    ok(`tabs ${tag}: ten pools of the window`, tabs.length === 10, tabs.length);
    ok(`tabs ${tag}: the best find is selected first`, (await p.textContent('#best h2')) === 'VELNA/WETH' && (await p.getAttribute('#best [aria-selected="true"]', 'data-id')) === tabs.find((x) => x.pair === 'VELNA/WETH').id);
    const cards = new Set(), bad = [];
    for (const x of tabs) {
      await p.evaluate((id) => { window.dispatchEvent(new WheelEvent('wheel')); const b = [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.dataset.id === id); b.scrollIntoView({ block: 'center', inline: 'nearest' }); b.click(); }, x.id);
      await sleep(120);
      const c = await p.evaluate(() => ({ h: document.querySelector('#best h2').textContent, sel: document.querySelector('#best [aria-selected="true"]').dataset.id, body: document.querySelector('#best .best-body').innerText + document.querySelector('#best .checks').innerText, full: document.querySelector('#best [data-act="detail"]').dataset.id }));
      if (c.h !== x.pair || c.sel !== x.id || c.full !== x.id) bad.push(x.pair);
      cards.add(c.body);
    }
    ok(`tabs ${tag}: every tab swaps the whole card (${tabs.length} pressed)`, bad.length === 0 && cards.size === tabs.length, bad.join(', ') + ` ${cards.size} cards`);
    const tali = tabs.find((x) => x.pair === 'TALI/WETH');
    ok(`tabs ${tag}: an unverified pool sits last, tagged, never a gem`, tali && /UNVERIFIED/.test(tali.tags) && /HOOK/.test(tali.tags) && tabs[tabs.length - 1].pair === 'TALI/WETH');
    await p.evaluate((id) => [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.dataset.id === id).click(), tali.id);
    await sleep(120);
    ok(`tabs ${tag}: …its card says so`, /NEVER A GEM/.test(await p.innerText('#best')));
    const numa = tabs.find((x) => x.pair === 'NUMA/USDC');
    await p.evaluate((id) => [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.dataset.id === id).click(), numa.id);
    await sleep(120);
    ok(`tabs ${tag}: checks read "Safe ? 3/4 · Data 8/8" (not run is never a pass)`, /Safe \? 3\/4 · Data 8\/8 · 1 not run/.test(await p.innerText('#best .checks')), (await p.innerText('#best .checks')).slice(0, 40));
    // keyboard: arrows move along the tabs
    await p.focus('#best [aria-selected="true"]');
    const before = await p.getAttribute('#best [aria-selected="true"]', 'data-id');
    await p.keyboard.press('ArrowRight');
    await sleep(120);
    const after = await p.evaluate(() => ({ sel: document.querySelector('#best [aria-selected="true"]').dataset.id, focus: document.activeElement && document.activeElement.dataset.id }));
    ok(`tabs ${tag}: arrow keys move the selection and the focus`, after.sel !== before && after.focus === after.sel);
    // remembered per device; reset when the window's top 10 doesn't hold it
    const kova = tabs.find((x) => x.pair === 'KOVA/WETH');
    await p.evaluate((id) => [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.dataset.id === id).click(), kova.id);
    await p.reload();
    await waitApp(p);
    ok(`tabs ${tag}: the choice is remembered after a reload`, (await p.textContent('#best h2')) === 'KOVA/WETH');
    await setWin(p, '24h');
    ok(`tabs ${tag}: a pool outside the new window's top 10 resets to its best find`, (await p.textContent('#best h2')) === 'NUMA/USDC' && (await p.evaluate(() => localStorage.getItem('lps.best'))) === null);
    ok(`tabs ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4a. daily fees, pattern, one-off, gem-now parts ----------
async function testDaily(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const pick = async (pair) => { await p.evaluate((pair) => [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.querySelector('.tn').textContent === pair).click(), pair); await sleep(120); };
    const read = () => p.evaluate(() => ({ chip: (document.querySelector('#best .chips [class*="p-"]') || {}).textContent, bars: document.querySelectorAll('#best .daily svg rect').length,
      median: !!document.querySelector('#best .daily line.median'), lab: document.querySelector('#best .daily .pane-title').innerText, oneoff: !!document.querySelector('#best .oneoff'),
      gem: (document.querySelector('#best .gemnow') || {}).innerText || '', checks: document.querySelector('#best .checks').innerText, tags: document.querySelector('#best .tags').innerText }));
    let a = await read();
    ok(`daily ${tag}: a 30-day strip of fees per $1,000, median marked, max labelled`, a.bars === 30 && a.median && /median \$\d+\.\d\d · max \$\d+\.\d\d on \d+ \w+/i.test(a.lab), `${a.bars} ${a.median} ${a.lab}`);
    ok(`daily ${tag}: a steady pool says STEADY`, a.chip === 'STEADY' && !a.oneoff);
    ok(`daily ${tag}: gem now parts carry the new names`, ['Yield now', 'Thinness', 'Flow', 'Staying power'].every((n) => a.gem.toLowerCase().includes(n.toLowerCase())) && /\/45/.test(a.gem) && /\/10/.test(a.gem));
    ok(`daily ${tag}: checks read "Safe ✓ 4/4 · Data 8/8"`, /Safe ✓ 4\/4 · Data 8\/8/.test(a.checks), a.checks.slice(0, 30));
    await pick('KOVA/WETH'); a = await read();
    ok(`daily ${tag}: a one-day spike says BURSTY`, a.chip === 'BURSTY');
    await pick('NUMA/USDC'); a = await read();
    ok(`daily ${tag}: a rising pool says EMERGING`, a.chip === 'EMERGING');
    await pick('BOJA/USDC'); a = await read();
    ok(`daily ${tag}: a one-trader day carries a one-off warning and tag`, a.oneoff && /ONE-OFF/.test(a.tags));
    ok(`daily ${tag}: no NaN`, noJunk(await p.innerText('#best')));
    ok(`daily ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4b2. the pair view ----------
async function testPairs(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    await p.click('#best h2 button[data-act="pair"]');
    await p.waitForSelector('#sheet:not([hidden])');
    const read = () => p.evaluate(() => {
      const rows = [...document.querySelectorAll('#sheet tr[data-act="pair-row"]')];
      return { title: document.querySelector('#sheet-title').textContent, n: rows.length, gold: rows.filter((r) => r.classList.contains('gold')).map((r) => ({ id: r.dataset.id, txt: r.innerText })),
        segs: document.querySelectorAll('#sheet .pv-bar > div').length, shares: rows.map((r) => parseFloat(r.children[1].textContent) || 0), body: document.querySelector('#sheet-body').innerText };
    });
    let a = await read();
    await snap(p, 'pair-' + tag);
    ok(`pairs ${tag}: the title opens the pair view, one row per pool`, a.title === 'VELNA/WETH' && a.n === 4, `${a.title} ${a.n}`);
    ok(`pairs ${tag}: one gold BEST TO ENTER row, never an unverified pool`, a.gold.length === 1 && /BEST TO ENTER/.test(a.gold[0].txt) && !/UNVERIFIED/.test(a.gold[0].txt), a.gold.map((g) => g.txt.slice(0, 30)).join('|'));
    ok(`pairs ${tag}: unverified pools are tagged`, /UNVERIFIED/.test(a.body));
    ok(`pairs ${tag}: the volume bar splits across the pools and adds up`, a.segs === 4 && Math.abs(a.shares.reduce((x, y) => x + y, 0) - 100) <= 3, a.shares.join('+'));
    ok(`pairs ${tag}: no NaN`, noJunk(a.body));
    await p.click('#sheet-win [data-w="24h"]');
    await sleep(200);
    const b = await read();
    ok(`pairs ${tag}: it follows the window switch`, b.body !== a.body && b.gold.length === 1 && b.gold[0].id !== a.gold[0].id);
    ok(`pairs ${tag}: …and in every window the best to enter is never unverified`, b.gold.length === 1 && !/UNVERIFIED/.test(b.gold[0].txt));
    // a row opens that pool in the best-find card
    const pick = await p.evaluate(() => { const r = [...document.querySelectorAll('#sheet tr[data-act="pair-row"]')].find((x) => !x.classList.contains('gold') && /ETH · v3|ETH$/.test(x.children[0].textContent) && /· ETH/.test(x.children[0].textContent)); return r ? r.dataset.id : document.querySelector('#sheet tr[data-act="pair-row"]:not(.gold)').dataset.id; });
    await p.evaluate((id) => document.querySelector(`#sheet tr[data-id="${id}"]`).click(), pick);
    await sleep(1400);
    const c = await p.evaluate(() => ({ open: !document.querySelector('#sheet').hidden, full: document.querySelector('#best [data-act="detail"]').dataset.id, h: document.querySelector('#best h2').textContent, kick: document.querySelector('#best').innerText, top: document.querySelector('#best').getBoundingClientRect().top }));
    ok(`pairs ${tag}: a row opens that pool in the best-find card`, !c.open && c.full === pick && c.h === 'VELNA/WETH' && c.top >= -2 && c.top < 400, `${c.open} ${c.h} ${Math.round(c.top)}`);
    // the pair name opens the view from the table and from next best too
    await setWin(p, '30d');
    await fillQ(p, 'VELNA');
    await sleep(300);
    await p.click('#all tbody tr.row td:nth-child(3)');
    await p.waitForSelector('#sheet:not([hidden])');
    await p.click('#sheet-pair');
    await sleep(150);
    ok(`pairs ${tag}: a pool's detail links to its pair view`, (await p.textContent('#sheet-title')) === 'VELNA/WETH' && (await p.$$('#sheet tr[data-act="pair-row"]')).length === 4);
    await p.click('#sheet-close');
    // a pool with no data in this window opens from the pair view with dashes (it used to throw in the best-find card)
    await fillQ(p, 'PRAXO');
    await sleep(300);
    await p.click('#all tbody tr.row td:nth-child(3)');
    await p.waitForSelector('#sheet:not([hidden])');
    await p.click('#sheet-pair');
    await sleep(150);
    const bare = await p.evaluate(() => { const r = [...document.querySelectorAll('#sheet tr[data-act="pair-row"]')].find((x) => /NO 30D DATA/.test(x.innerText)); return r ? r.dataset.id : null; });
    if (bare) { await p.evaluate((id) => document.querySelector(`#sheet tr[data-id="${id}"]`).click(), bare); await sleep(1400); }
    const card = await p.innerText('#best');
    ok(`pairs ${tag}: a pool with no data in the window opens from the pair view, with dashes`, !!bare && t.errors.length === 0 && /NO 30D DATA/.test(card) && noJunk(card), bare ? t.errors[0] : 'no such row');
    await fillQ(p, '');
    ok(`pairs ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4d. chart tools: zoom steps, the detail panel's charts, the window of one chart ----------
async function testCharts(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const span = () => p.evaluate(() => document.querySelector('[data-chartbox="liq-best"] .chart-head').innerText.match(/±(\d+)%/)[1]);
    const press = (sel) => p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(sel); b.scrollIntoView({ block: 'center' }); b.click(); }, sel);
    ok(`charts ${tag}: the liquidity chart opens at ±45%`, (await span()) === '45');
    const geo = await p.evaluate(() => [...document.querySelectorAll('.ctools')].filter((c) => c.offsetParent).map((c) => { const z = c.querySelector('.zseg').getBoundingClientRect(), o = c.querySelector('.openwin').getBoundingClientRect(); return { gap: o.left - z.right, h: o.height, w: o.width }; }));
    ok(`charts ${tag}: on every chart the open button stands ≥ 12 px from the zoom pair, 44×44 (${geo.length})`, geo.length >= 3 && geo.every((g) => g.gap >= 12 && g.h >= 43.5 && g.w >= 43.5), JSON.stringify(geo[0]));
    await press('[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(100);
    const s1 = await span();
    await press('[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(100);
    const s2 = await span();
    ok(`charts ${tag}: + zooms in around the price (±25% then ±12%)`, s1 === '25' && s2 === '12', `${s1} ${s2}`);
    ok(`charts ${tag}: …keeps the focus on the button for the keyboard`, (await p.evaluate(() => document.activeElement && document.activeElement.dataset.act)) === 'zoom');
    await press('[data-act="zreset"][data-chart="liq-best"]'); await sleep(100);
    const sp0 = poolOf(await bestId(p)).shape.depthSpan, ws = [(await pzView(p, 'liq-best')).w];
    for (let k = 0; k < 8 && (await p.isEnabled('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]')); k++) { await press('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); await sleep(100); ws.push((await pzView(p, 'liq-best')).w); }
    const capW = await p.evaluate(() => document.querySelector('[data-chartbox="liq-best"] .pz-cap1').textContent);
    ok(`charts ${tag}: reset, then − steps out (at most ×4 a press) to the whole field, no further (${capW})`, ws.length >= 2 && ws.slice(1).every((w, i) => w > ws[i] && w / ws[i] <= 4.01) && near(ws.at(-1), sp0[1] - sp0[0], 2e-3) && /[÷−].*…\s×/.test(capW), ws.map((w) => w.toFixed(3)).join('→') + ' ' + capW);
    // the detail panel's charts
    await p.click('#best [data-act="detail"]');
    await p.waitForSelector('#sheet:not([hidden])');
    const ids = await p.$$eval('#sheet [data-act="zoom"][data-dir="1"]', (b) => b.map((x) => x.dataset.chart));
    let bad = [];
    for (const id of ids) {
      const before = await p.innerText(`#sheet [data-chartbox="${id}"]`);
      await p.evaluate((id) => document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`).click(), id); await sleep(80);
      const after = await p.innerText(`#sheet [data-chartbox="${id}"]`);
      await p.evaluate((id) => document.querySelector(`#sheet [data-act="openchart"][data-chart="${id}"]`).click(), id);
      const u = await p.evaluate(() => window.__opened.slice(-1)[0]);
      if (before === after || !u.includes('view=' + id) || !/pool=/.test(u)) bad.push(id);
    }
    ok(`charts ${tag}: every chart in the detail panel zooms and opens (${ids.length})`, ids.length >= 4 && bad.length === 0, bad.join(','));
    await p.click('#sheet-close');
    // the window of one chart: same sealed data, no passphrase while this browser keeps the key
    const pool = await p.getAttribute('#best [data-act="detail"]', 'data-id');
    const w2 = await t.ctx.newPage();
    await w2.goto(url('default', `&view=liq-best&pool=${pool}&w=30d&z=3`));
    await w2.waitForSelector('.solo-box', { timeout: 20000 });
    const solo = await w2.evaluate(() => ({ lock: !document.querySelector('#lockscreen').hidden, all: document.querySelector('#all').offsetParent !== null, box: !!document.querySelector('.solo-box .liq'), h: document.querySelector('.solo-box .liq').getBoundingClientRect().height, lab: document.querySelector('[data-chartbox="liq-best"] .chart-head').innerText }));
    ok(`charts ${tag}: "open" shows just that chart, large, at its zoom, without the passphrase`, !solo.lock && !solo.all && solo.box && solo.h > 250 && /±12%/.test(solo.lab), JSON.stringify(solo).slice(0, 80));
    ok(`charts ${tag}: …no sideways scroll there`, (await w2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
    await w2.close();
    ok(`charts ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  const fresh = await newPage(browser);
  await fresh.page.goto(url('default', '&view=liq-best&w=30d'));
  await fresh.page.waitForSelector('#lockscreen:not([hidden])', { timeout: 20000 });
  ok('charts: a chart window without a stored key asks for the passphrase', await fresh.page.isVisible('#pass'));
  await fresh.ctx.close();
}

// ---------- 4f. pan and zoom: drag, rubber band, flick, edge buttons, double-tap, wheel, pop-out windows ----------
// Each chart that pans carries data-view="<position>,<view width>[,<y>]" on its host [data-pz]: the checks read it.
// The page draws a chart's view in the next animation frame (and writes data-view then), so every read waits for one.
// WebKit on a CI runner paints a frame every 50–260 ms (software rendering at the phone's 3× pixels; Chromium keeps
// 16 ms): checks wait for frames and for the page's own state, never for a fixed time.
const pzView = (page, id) => page.evaluate(async (id) => { await new Promise((r) => requestAnimationFrame(() => r())); const h = document.querySelector(`[data-pz="${id}"]`); if (!h) return null; const [c, w, y] = h.dataset.view.split(',').map(Number); return { c, w, y }; }, id);
async function pzBox(page, id) {
  return page.evaluate(STILL_BOX, { sel: `[data-pz="${id}"]` }).then((b) => b && { x: b.x, y: b.y, width: b.w, height: b.h });
}
// a mouse drag across a chart (pointer events, as a finger gives them): dx, dy in px; `up: false` keeps the button down
async function pzDrag(page, id, dx, { dy = 0, steps = 10, ms = 16, y = 0.5, up = true, settle = 650, hold = 0 } = {}) {
  const b = await pzBox(page, id), x0 = b.x + b.width / 2, y0 = b.y + b.height * y;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps); await sleep(ms); }
  if (hold) await sleep(hold); // the finger stops before it lifts: no flick
  if (up) { await page.mouse.up(); if (settle) { await sleep(Math.min(settle, 250)); await pzSettled(page, id); } }
}
// wait until a chart's view has come to rest: the page's own coast or step for it is over, which (its state is private to
// its script) shows as the view being the same over 3 drawn frames and at least 200 ms (an edge button's first frame is
// its start).
// A coast counts time per frame at most 40 ms, so where WebKit draws a frame every 260 ms a 0.9 s flick runs ~6 s of
// wall time: hence the long limit. Waiting less read a view mid-coast, and the next touch then caught the coast.
async function pzSettled(page, id, ms = 15000) {
  return page.evaluate(async ({ id, ms }) => {
    const rd = () => { const h = document.querySelector(`[data-pz="${id}"]`); return h ? h.dataset.view : null; };
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const t0 = performance.now();
    let a = (await frame(), rd()), same = 0, since = performance.now();
    while (performance.now() - t0 < ms) {
      await frame(); await new Promise((r) => setTimeout(r, 25));
      const b = rd();
      if (b !== a) { a = b; same = 0; since = performance.now(); } else if (++same >= 3 && performance.now() - since >= 200) break;
    }
    if (a == null) return null;
    const [c, w, y] = a.split(',').map(Number);
    return { c, w, y };
  }, { id, ms });
}
const wheel = (page, id, dx, dy) => page.evaluate(({ id, dx, dy }) => { const h = document.querySelector(`[data-pz="${id}"]`), r = h.getBoundingClientRect(); h.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, clientX: r.left + r.width / 2, clientY: r.top + 60, bubbles: true, cancelable: true })); }, { id, dx, dy });
const pzClick = (page, sel) => page.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(sel); b.scrollIntoView({ block: 'center' }); b.click(); }, sel);
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
async function testPan(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    // the liquidity chart: the bars reach ±64% (coarser past ±45%), so at its ±45% default a drag shows more; past the
    // last bars it rubber-bands over a "no data" hatch, then springs back to the data's edge
    // the one-time "drag" hint on the first chart that can pan: hidden while it is dragged (nothing removed mid-drag),
    // gone and remembered once the drag ends
    const hid = await p.evaluate(() => { const h = document.querySelector('#best .pz-hint'); return h ? h.closest('[data-pz]').dataset.pz : null; });
    if (hid) {
      await pzDrag(p, hid, 120, { up: false }); await sleep(60);
      const disp = await p.$$eval(`[data-pz="${hid}"] > .pz-hint`, (e) => e.map((x) => getComputedStyle(x).display).join());
      await p.mouse.up(); await pzSettled(p, hid);
      ok(`pan ${tag}: the one-time "drag" hint hides while dragging and is gone (remembered) after it (${hid})`, disp === 'none' && (await p.$$('.pz-hint')).length === 0 && (await p.evaluate(() => localStorage.getItem('lps.hint'))) === '1', disp);
      if (await p.$(`[data-act="zreset"][data-chart="${hid}"]`)) { await pzClick(p, `[data-act="zreset"][data-chart="${hid}"]`); await sleep(200); }
    } else ok(`pan ${tag}: the one-time "drag" hint shows on the first chart that can pan`, false, 'no hint');
    const ta = await p.$eval('[data-pz="liq-best"]', (h) => getComputedStyle(h).touchAction);
    ok(`pan ${tag}: charts take sideways drags and pinches, vertical swipes stay the page's (touch-action ${ta})`, ta === 'pan-y');
    let v = await pzView(p, 'liq-best');
    ok(`pan ${tag}: the liquidity chart opens on the price, ±45% wide`, near(v.c, 0) && near(v.w, 0.9), JSON.stringify(v));
    const SP = poolOf(await bestId(p)).shape.depthSpan, edge0 = SP[0] + 0.45; // the view's centre can go no lower
    await pzDrag(p, 'liq-best', phone ? 140 : 260, { up: false });
    await sleep(60);
    const mid = await pzView(p, 'liq-best'), end = await p.$$eval('[data-pz="liq-best"] .pz-end', (e) => e.map((x) => x.className + '|' + x.textContent).join());
    await p.mouse.up();
    v = await pzSettled(p, 'liq-best');
    ok(`pan ${tag}: the bars past ±45% are reachable, and past the map's end a drag rubber-bands over a plain end (nothing lies beyond: no hatch, no "no data"), then springs back`, mid.c < edge0 - 0.005 && /pz-end l none\|$/.test(end) && near(v.c, edge0, 2e-3), `${mid.c} ${end} ${v.c}`);
    if (await p.$('[data-act="zreset"][data-chart="liq-best"]')) { await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]'); await sleep(150); }
    // + twice: two zoom steps around the view's centre
    await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(120);
    const z1 = await pzView(p, 'liq-best');
    await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(120);
    const z2 = await pzView(p, 'liq-best');
    ok(`pan ${tag}: + pressed twice zooms twice (±25%, then ±12%)`, near(z1.w, 0.5) && near(z2.w, 0.24), `${z1.w} ${z2.w}`);
    ok(`pan ${tag}: zoomed in, edge buttons show more on both sides`, (await p.$$('[data-pz="liq-best"] > .pz-edge:not([hidden])')).length === 2);
    // a slow drag pans by the distance dragged; no coasting after a slow release
    await pzDrag(p, 'liq-best', -100, { steps: 12, ms: 30, settle: 0, hold: 160 });
    const d1 = await pzView(p, 'liq-best');
    const d2 = await pzSettled(p, 'liq-best');
    ok(`pan ${tag}: dragging left shows higher prices, by the distance dragged`, d1.c > 0.02 && d1.c < 0.2 && near(d1.c, d2.c, 2e-3), `${d1.c} ${d2.c}`);
    ok(`pan ${tag}: a panned chart shows "reset"`, await p.isVisible('[data-chartbox="liq-best"] [data-act="zreset"]'));
    // zoom keeps the view's centre
    await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(120);
    const z3 = await pzView(p, 'liq-best');
    ok(`pan ${tag}: + zooms around the view's centre, not back to the price`, near(z3.w, 0.12) && near(z3.c, d2.c, 2e-3), `${z3.c} vs ${d2.c}`);
    await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); await sleep(120);
    // an edge button moves half a view
    const e0 = await pzView(p, 'liq-best');
    await pzClick(p, '[data-pz="liq-best"] > .pz-edge.l'); await sleep(150);
    const e1 = await pzSettled(p, 'liq-best');
    ok(`pan ${tag}: the ◂ edge button moves half a view towards lower prices`, e1.c < e0.c - 0.05, `${e0.c} → ${e1.c}`);
    // a flick coasts on after the release and slows down
    await pzDrag(p, 'liq-best', 160, { steps: 5, ms: 8, settle: 0 });
    const f0 = await pzView(p, 'liq-best'); await sleep(250);
    const f1 = await pzView(p, 'liq-best');
    const f2 = await pzSettled(p, 'liq-best'), lo = SP[0] + 0.12; // the left limit at ±12% for the map's span
    ok(`pan ${tag}: a flick coasts after the release, then stops inside the data`, f1.c < f0.c - 1e-3 && f2.c >= lo - 1e-3, `${f0.c} ${f1.c} ${f2.c}`);
    // a mostly vertical drag doesn't pan
    const s0 = await pzView(p, 'liq-best');
    await pzDrag(p, 'liq-best', 8, { dy: 90, settle: 300 });
    ok(`pan ${tag}: a mostly vertical swipe leaves the chart alone`, near((await pzView(p, 'liq-best')).c, s0.c));
    // a sideways wheel (trackpad) pans; an up-down wheel doesn't
    await pzBox(p, 'liq-best');
    await wheel(p, 'liq-best', 0, 120); await sleep(150);
    const w0 = await pzSettled(p, 'liq-best');
    ok(`pan ${tag}: an up-down wheel over a chart doesn't pan it`, near(w0.c, s0.c));
    await wheel(p, 'liq-best', 80, 2); await sleep(150);
    ok(`pan ${tag}: a sideways wheel (trackpad) pans`, (await pzSettled(p, 'liq-best')).c > w0.c + 1e-3);
    // a double-tap returns to the default view
    const c = await pzBox(p, 'liq-best');
    await p.mouse.click(c.x + c.width / 2, c.y + 70); await sleep(90); await p.mouse.click(c.x + c.width / 2, c.y + 70); await sleep(200);
    v = await pzSettled(p, 'liq-best');
    ok(`pan ${tag}: a double-tap resets zoom and pan`, near(v.c, 0) && near(v.w, 0.9) && !(await p.isVisible('[data-chartbox="liq-best"] [data-act="zreset"]')), JSON.stringify(v));
    // the daily strip: the newest day shows by default; a drag shows older days; "older" and "newer" edge buttons
    let dv = await pzView(p, 'daily-best');
    const days = await p.evaluate(() => document.querySelectorAll('[data-pz="daily-best"] rect').length);
    ok(`pan ${tag}: the daily strip shows the newest day by default (${phone ? '15' : '30'} of ${days} days)`, near(dv.c, days) && near(dv.w, phone ? 15 : 30), JSON.stringify(dv));
    if (!phone) { await pzClick(p, '[data-act="zoom"][data-chart="daily-best"][data-dir="1"]'); await sleep(150); dv = await pzView(p, 'daily-best'); }
    ok(`pan ${tag}: …with a "◂ older" button and no "newer" one`, (await p.isVisible('[data-pz="daily-best"] > .pz-edge.l')) && !(await p.isVisible('[data-pz="daily-best"] > .pz-edge.r')) && /older/i.test(await p.innerText('[data-pz="daily-best"] > .pz-edge.l')));
    const cap0 = await p.innerText('[data-chartbox="daily-best"] .pane-title');
    await pzDrag(p, 'daily-best', 150);
    const dv2 = await pzView(p, 'daily-best'), cap1 = await p.innerText('[data-chartbox="daily-best"] .pane-title');
    ok(`pan ${tag}: dragging the strip right shows older days, and its labels follow`, dv2.c < dv.c - 1 && cap1 !== cap0 && /→/.test(cap1) && (await p.isVisible('[data-pz="daily-best"] > .pz-edge.r')), `${dv.c} → ${dv2.c}`);
    for (let k = 0; k < 6 && (await p.isVisible('[data-pz="daily-best"] > .pz-edge.l')); k++) { await pzClick(p, '[data-pz="daily-best"] > .pz-edge.l'); await sleep(380); }
    dv = await pzView(p, 'daily-best');
    ok(`pan ${tag}: "◂ older" pans step by step back to the first day, then hides`, near(dv.c, dv.w) && !(await p.isVisible('[data-pz="daily-best"] > .pz-edge.l')), JSON.stringify(dv));
    // the detail panel's time charts pan once zoomed in
    await p.click('#best [data-act="detail"]');
    await p.waitForSelector('#sheet:not([hidden])');
    const bad = [];
    for (const id of await p.$$eval('#sheet [data-pz]', (h) => h.map((x) => x.dataset.pz).filter((x) => x !== 'liq-detail'))) {
      if (!(await p.isEnabled(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`))) continue;
      await p.evaluate((id) => document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`).click(), id); await sleep(120);
      const a = await pzView(p, id);
      await pzDrag(p, id, 120, { y: 0.4 });
      const z = await pzView(p, id);
      if (!(z.c < a.c - 0.01)) bad.push(id);
    }
    ok(`pan ${tag}: every time chart in the detail panel drags to earlier data once zoomed in`, bad.length === 0, bad.join(','));
    await p.click('#sheet-close');
    // replay, strategy lab and the scatter
    await p.click('#bt-lead tr.row'); await sleep(900);
    const bt = [];
    for (const id of ['rp', 'rp-money', 'lab']) {
      await pzClick(p, `[data-act="zoom"][data-chart="${id}"][data-dir="1"]`); await sleep(150);
      const a = await pzView(p, id);
      await pzDrag(p, id, 120, { y: 0.45 });
      if (!((await pzView(p, id)).c < a.c - 0.01)) bt.push(id);
    }
    ok(`pan ${tag}: the replay's price, money and strategy-lab charts drag to earlier data`, bt.length === 0, bt.join(','));
    await pzClick(p, '[data-act="zoom"][data-chart="scatter"][data-dir="1"]'); await sleep(150);
    const sc0 = await pzView(p, 'scatter');
    ok(`pan ${tag}: a zoomed scatter takes drags and pinches both ways (touch-action none)`, (await p.$eval('[data-pz="scatter"]', (h) => getComputedStyle(h).touchAction)) === 'none');
    await pzDrag(p, 'scatter', -60, { dy: -50, steps: 8 });
    const sc1 = await pzView(p, 'scatter');
    ok(`pan ${tag}: …and moves right and up, inside the full view`, sc1.c > sc0.c + 0.1 && sc1.y < sc0.y - 0.1, `${JSON.stringify(sc0)} ${JSON.stringify(sc1)}`);
    // pop-out window: it opens on the same zoom and pan, and drags and zooms there too
    await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(120);
    await pzDrag(p, 'liq-best', -60, { steps: 12, ms: 30, hold: 160 });
    const here = await pzView(p, 'liq-best');
    await pzClick(p, '[data-act="openchart"][data-chart="liq-best"]');
    const u = await p.evaluate(() => window.__opened.slice(-1)[0]);
    ok(`pan ${tag}: "open in a new window" carries the zoom and the pan`, /[?&]z=2(&|$)/.test(u) && /[?&]pan=-?\d/.test(u), u.replace(/^.*\?/, '').slice(0, 80));
    const w2 = await t.ctx.newPage();
    await w2.goto(u);
    await w2.waitForSelector('.solo-box [data-pz="liq-best"]', { timeout: 20000 });
    await sleep(300);
    const s1 = await pzView(w2, 'liq-best');
    ok(`pan ${tag}: the window opens on that very view`, near(s1.c, here.c, 2e-3) && near(s1.w, here.w), `${JSON.stringify(s1)} vs ${JSON.stringify(here)}`);
    for (let k = 0; k < 2; k++) { await w2.click('[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(150); }
    const s2 = await pzView(w2, 'liq-best');
    await pzDrag(w2, 'liq-best', 120, { y: 0.4 });
    const s3 = await pzView(w2, 'liq-best');
    ok(`pan ${tag}: in the window + zooms step after step and a drag pans`, near(s2.w, 0.12) && s3.c < s2.c - 0.01, `${s2.w} ${s2.c}→${s3.c}`);
    ok(`pan ${tag}: …no sideways scroll there`, (await w2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
    await w2.close();
    ok(`pan ${tag}: no NaN`, noJunk(await bodyText(p)));
    ok(`pan ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    if (SHOTS) {
      await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(200);
      await snap(p, `pan-${tag}-liq-zoomed`, '[data-chartbox="liq-best"]');
      await snap(p, `pan-${tag}-daily`, '[data-chartbox="daily-best"]');
    }
    await t.ctx.close();
  }
  // reduced motion: no coasting and no animated steps
  const r = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' }), p = r.page;
  await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]'); await sleep(120);
  await pzDrag(p, 'liq-best', 160, { steps: 5, ms: 8, settle: 0 });
  const a = await pzView(p, 'liq-best'); await sleep(300);
  ok('pan: under reduced motion a flick stops where the finger lifts', near((await pzView(p, 'liq-best')).c, a.c));
  await pzClick(p, '[data-pz="liq-best"] > .pz-edge.r:not([hidden])');
  await sleep(30);
  ok('pan: under reduced motion an edge button jumps at once', (await pzView(p, 'liq-best')).c > a.c + 0.05 && (await p.evaluate(() => document.getAnimations().length)) === 0);
  ok('pan: reduced motion, no page errors', r.errors.length === 0, r.errors[0]);
  await r.ctx.close();
}

// ---------- 4f2. the liquidity chart's whole field: depthEdges, far bars, the full-range layer, unread bars, beyond ----------
// The bars are checked against an independent reading of the data: each bar spans its own depthEdges and its height is its
// own value per fine-bar width (the scanner took the full-range layer out of it); the layer is a thin flat band under the
// bars, across its span, as thick as its dollars at the price (constant liquidity: ∝ e^(−|x|/2)) on the bars' scale, 2 to 12
// units; a real 0 past the bars draws nothing and an unread stretch is hatched.
const eInt = (a, b) => (b <= a ? 0 : a >= 0 ? 2 * (Math.exp(-a / 2) - Math.exp(-b / 2)) : b <= 0 ? 2 * (Math.exp(b / 2) - Math.exp(a / 2)) : eInt(a, 0) + eInt(0, b));
function liqExpect(pool, view, detail = false) { // what the page should draw for this view: [{ x, y, w, h }] in the chart's 480 × 120 box
  const sh = pool.shape, E = sh.depthEdges, step = sh.depthStep.fine, [v0, v1] = view, X = (o) => ((o - v0) / (v1 - v0)) * 480;
  const fr = sh.fullRangeUsd > 0 ? sh.fullRangeUsd : 0, [la, lb] = sh.fullRangeSpan || [0, 0], c = fr ? fr / eInt(la, lb) : 0;
  const bars = sh.depth.map(([o, v], i) => ({ a: E[i], b: E[i + 1], v })).filter((b) => b.b > v0 && b.a < v1);
  const dens = (b) => (b.v * step) / (b.b - b.a);
  const max = Math.max(1, ...bars.filter((b) => b.v != null).map(dens), detail ? ghostCap(pool, view) : 0);
  const hb = fr && Math.min(v1, lb) > Math.max(v0, la) ? Math.min(12, Math.max(2, ((c * step) / max) * 116)) : 0;
  const out = bars.filter((b) => b.v > 0).map((b) => { const full = X(b.b) - X(b.a), g = Math.min(2, full * 0.2); return { x: X(b.a) + g / 2, y: 120 - hb, w: Math.max(1, full - g), h: Math.max(1.5, (dens(b) / max) * (116 - hb)) }; });
  out.band = hb ? { x: X(Math.max(v0, la)), w: X(Math.min(v1, lb)) - X(Math.max(v0, la)), h: hb } : null;
  return out;
}
const LIQ_LOOK = (id) => {
  const h = document.querySelector(`[data-pz="${id}"]`), hr = h.getBoundingClientRect(), d = [...h.querySelectorAll('.pz-c svg path')].map((x) => x.getAttribute('d')).join('');
  return { view: h.dataset.view, edges: [...h.querySelectorAll(':scope > .pz-edge:not([hidden])')].length,
    bars: [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)v(-?[\d.]+)h([\d.]+)v/g)].map((m) => ({ x: +m[1], y: +m[2], h: -m[3], w: +m[4] })),
    band: [...h.querySelectorAll('.pz-c svg rect.fr')].map((r) => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }))[0] || null,
    by: [...h.querySelectorAll('.bylab')].map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, inside: r.left >= hr.left - 1 && r.right <= hr.right + 1, shown: e.style.visibility !== 'hidden' }; }),
    mlab: [...h.querySelectorAll('.mlab')].map((e) => e.textContent), legend: h.closest('[data-chartbox]').querySelector('.legend').innerText,
    unread: h.querySelectorAll('rect.unread').length, hatch: h.querySelectorAll('.pz-end').length, fr: h.querySelectorAll('rect.fr').length,
    frlab: [...h.querySelectorAll('.frlab')].map((e) => e.style.visibility === 'hidden' ? '' : e.textContent).join(''), cap: h.closest('[data-chartbox]').querySelector('.pz-cap1').textContent,
    ticks: [...h.querySelectorAll('.tick')].map((e) => e.textContent) };
};
function barsMatch(got, want, band) { // every expected bar drawn where its edges say, on the band, as wide and as tall (0.16 of the box's units)
  const bad = [], used = new Set();
  if (want.band || band) { // the full-range band: under the bars, flat, across the layer's span in view
    const e = want.band;
    if (!e || !band || Math.abs(band.x - e.x) > 0.16 || Math.abs(band.w - e.w) > 0.16 || Math.abs(band.h - e.h) > 0.16 || Math.abs(band.y + band.h - 120) > 0.16) bad.push(`band ${JSON.stringify(e)} got ${JSON.stringify(band)}`);
  }
  for (const e of want) { // the closest unused bar at that spot (zoomed far out, bars sit a fraction of a unit apart)
    const g = got.filter((b) => !used.has(b) && Math.abs(b.x - e.x) < 0.16).sort((p, q) => Math.abs(p.h - e.h) + Math.abs(p.w - e.w) - Math.abs(q.h - e.h) - Math.abs(q.w - e.w))[0];
    if (g) used.add(g);
    if (!g || Math.abs(g.w - e.w) > 0.16 || Math.abs(g.h - e.h) > 0.16 || Math.abs(g.y - e.y) > 0.16) bad.push(`x ${e.x.toFixed(1)} w ${e.w.toFixed(1)} h ${e.h.toFixed(1)} got ${g ? `w ${g.w} h ${g.h}` : 'none'}`);
  }
  return { ok: !bad.length && got.length === want.length, why: `${got.length}/${want.length} bars · ${bad.slice(0, 2).join(' | ')}` };
}
const viewOf = (a) => { const [c, w] = a.view.split(',').map(Number); return [c - w / 2, c + w / 2]; };
async function zoomAllOut(p, id, root = '') {
  const ws = [];
  for (let k = 0; k < 10; k++) {
    const go = await p.evaluate(({ id, root }) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(`${root} [data-act="zoom"][data-chart="${id}"][data-dir="-1"]`); if (!b || b.disabled) return false; b.click(); return true; }, { id, root });
    if (!go) break;
    await sleep(120); ws.push(+(await p.getAttribute(`[data-pz="${id}"]`, 'data-view')).split(',')[1]);
  }
  return ws;
}
async function openPool(p, sel) { // a pool's detail panel through the table's search (a pair name or the start of its id)
  await fillQ(p, sel); await sleep(250);
  await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#all tbody tr.row td:nth-child(3)').click(); });
  await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
}
async function closePool(p) { await p.click('#sheet-close'); await sleep(120); await fillQ(p, ''); }
async function testDepth(browser) {
  const { live } = FXD;
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const pick = async (pair) => { await p.evaluate((pair) => { window.dispatchEvent(new WheelEvent('wheel')); [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.querySelector('.tn').textContent === pair).click(); }, pair); await sleep(150); };
    const look = (id = 'liq-best') => p.evaluate(LIQ_LOOK, id);
    const bp = poolOf(await bestId(p)), sp = bp.shape.depthSpan;
    let a = await look();
    ok(`depth ${tag}: the default view is ±45% around the price, with more to see both ways`, /^0\.0000,0\.9000$/.test(a.view) && a.edges === 2, a.view + ' ' + a.edges);
    let m = barsMatch(a.bars, liqExpect(bp, viewOf(a)), a.band);
    ok(`depth ${tag}: at ±45% every bar sits on its own edges at its own value per width, on a thin flat full-range band under them (${bp.pair})`, m.ok && !!a.band, m.why);
    ok(`depth ${tag}: the full-range layer is drawn and named (legend and label), and nothing is "past the bars" when both sides end at a real 0`, a.fr === 1 && /Full range \$[\d.]+[KM]?/.test(a.legend) && !/Past the bars/.test(a.legend) && a.by.length === 0, a.legend.replace(/\n/g, ' / ').slice(-90) + ' ' + a.fr);
    const ws = await zoomAllOut(p, 'liq-best');
    a = await look();
    ok(`depth ${tag}: − steps out to the whole field (${a.cap}): every bar, no hatch, no "beyond" label`, near(+a.view.split(',')[1], sp[1] - sp[0], 2e-3) && near(+a.view.split(',')[0], (sp[0] + sp[1]) / 2, 2e-3) && a.hatch === 0 && a.by.length === 0 && ws.length >= 1, a.view + ' ' + a.hatch + ' ' + JSON.stringify(a.by));
    m = barsMatch(a.bars, liqExpect(bp, viewOf(a)), a.band);
    const wr = Math.max(...a.bars.map((b) => b.w)) / Math.min(...a.bars.map((b) => b.w));
    ok(`depth ${tag}: …the far bars are as wide as their edges (widest ${wr.toFixed(0)}× the narrowest), drawn by value per width, the band across the whole field`, m.ok && wr > 8, m.why);
    ok(`depth ${tag}: …on a log axis marked as moves of the price (${a.ticks.join(' ')})`, a.ticks.includes('PRICE') && a.ticks.some((x) => /^×\d/.test(x)), a.ticks.join(' '));
    // past the right end a drag rubber-bands over a plain end: nothing lies beyond (a real 0), never "no data"
    await pzDrag(p, 'liq-best', -160, { up: false }); await sleep(60);
    const endR = await p.$$eval('[data-pz="liq-best"] .pz-end.r', (e) => e.map((x) => x.className + '|' + x.textContent).join());
    await p.mouse.up(); await pzSettled(p, 'liq-best');
    ok(`depth ${tag}: past the end of the field a drag shows a plain end (no hatch: nothing is there)`, endR === 'pz-end r none|', endR);
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]'); await sleep(150);
    // KOVA: 40% of its parked value above sits past ±45%; the "parked" label reads the fine bars only
    await pick('KOVA/WETH');
    const kp = poolOf(await bestId(p));
    const r30 = kp.w['30d'].range, fineUp = kp.shape.depth.filter(([o, v]) => o > r30 + 1e-9 && o <= 0.45 && v != null).reduce((s2, d) => s2 + d[1], 0);
    const allUp = kp.shape.depth.filter(([o, v]) => o > r30 + 1e-9 && v != null).reduce((s2, d) => s2 + d[1], 0);
    a = await look();
    const parsed = (txt) => { const mm = /\$([\d.]+)([KM]?)/.exec(txt || ''); return mm ? +mm[1] * ({ K: 1e3, M: 1e6 }[mm[2]] || 1) : null; };
    const up = parsed(a.mlab[a.mlab.length - 1]);
    ok(`depth ${tag}: the default view's "parked" label counts the ±45% bars only (KOVA)`, up != null && Math.abs(up - fineUp) / fineUp < 0.06 && Math.abs(up - allUp) / allUp > 0.15, `${up} vs fine ${Math.round(fineUp)} / all ${Math.round(allUp)}`);
    ok(`depth ${tag}: no layer drawn where the pool has none (KOVA: fullRangeUsd 0)`, a.fr === 0 && !/Full range/.test(a.legend), a.legend.slice(-60));
    for (let k = 0; k < 6 && (await p.isVisible('[data-pz="liq-best"] > .pz-edge.r')); k++) { await pzClick(p, '[data-pz="liq-best"] > .pz-edge.r'); await sleep(380); }
    a = await look();
    ok(`depth ${tag}: panned to the right end the view stops at the last bar (+${kp.shape.depthSpan[1]})`, near(+a.view.split(',')[0], kp.shape.depthSpan[1] - 0.45, 2e-3), a.view);
    // QUARX: unread from its fourth coarse bar up: hatched out to the tick limit, "not read beyond", never a bar of 0, no layer
    const qp = live.pools.find((x) => x.t0.sym === 'QUARX');
    await openPool(p, 'QUARX');
    await zoomAllOut(p, 'liq-detail', '#sheet');
    a = await look('liq-detail');
    const nulls = qp.shape.depth.filter((d) => d[1] === null).length;
    ok(`depth ${tag}: unread bars are hatched (${a.unread} of ${nulls}) and the unread "beyond" says so, never $0; no layer where it couldn't be measured`, a.unread === nulls && a.by.some((x) => /not read beyond/.test(x.t)) && /Not read/.test(a.legend) && !/\$0 /.test(a.by.map((x) => x.t).join(' ')) && a.fr === 0 && /×10/.test(a.cap), JSON.stringify({ u: a.unread, by: a.by, cap: a.cap }));
    m = barsMatch(a.bars, liqExpect(qp, viewOf(a), true), a.band);
    ok(`depth ${tag}: …its read bars still sit on their edges at ×${a.cap.split('×').pop()}`, m.ok, m.why);
    await pzDrag(p, 'liq-detail', -160, { up: false }); await sleep(60);
    const endQ = await p.$$eval('[data-pz="liq-detail"] .pz-end.r', (e) => e.map((x) => x.className + '|' + x.textContent).join());
    await p.mouse.up(); await sleep(400);
    ok(`depth ${tag}: …past its unread end a drag shows the hatch, marked "not read" (never "no data")`, endQ === 'pz-end r|NOT READ' || endQ === 'pz-end r|', endQ);
    await closePool(p);
    // ORVO: a stray position near ×200: the whole field reaches it, and its far bar shows (a sliver at least)
    const op = live.pools.find((x) => x.t0.sym === 'ORVO');
    await openPool(p, 'ORVO');
    await zoomAllOut(p, 'liq-detail', '#sheet');
    a = await look('liq-detail');
    m = barsMatch(a.bars, liqExpect(op, viewOf(a), true), a.band);
    ok(`depth ${tag}: a stray far position stretches the field (${a.cap}) and its bar is drawn out to the end`, /×2\d\d$/.test(a.cap) && m.ok && a.bars.some((b) => b.x + b.w > 470), a.cap + ' ' + m.why);
    await closePool(p);
    ok(`depth ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  // older scanners' data: without depthEdges and the layer (steps and span), or with the ±45% bars only: still drawn, no hatch
  const od = await openUnlocked(browser, 'olddepth', { width: 1440 }), p = od.page;
  const oldPools = oldDepth(FXD).live.pools, res = [], genOf = (x) => (x.shape.depthEdges ? 'edges' : x.shape.depthStep ? 'steps' : 'fine only');
  const picks = ['edges', 'steps', 'fine only'].flatMap((g) => oldPools.filter((x) => x.shape.depth.length && genOf(x) === g).slice(0, 2));
  for (const op of picks) {
    await openPool(p, op.id.slice(0, 12));
    await zoomAllOut(p, 'liq-detail', '#sheet');
    const a = await p.evaluate(LIQ_LOOK, 'liq-detail');
    const gen = op.shape.depthEdges ? 'edges' : op.shape.depthStep ? 'steps' : 'fine only', ws2 = a.bars.map((b) => b.w);
    const exp = gen === 'edges' ? op.shape.depthSpan[1] - op.shape.depthSpan[0] : gen === 'steps' ? 1.275 : null;
    res.push({ sym: op.t0.sym.slice(0, 8), gen, ok: a.bars.length > 20 && a.hatch === 0 && (exp == null || near(+a.view.split(',')[1], exp, 2e-3)) && (gen !== 'steps' || Math.max(...ws2) / Math.min(...ws2) > 1.7), view: a.view });
    await closePool(p);
  }
  ok(`depth: older data still draws (${[...new Set(res.map((r) => r.gen))].join(', ')}): bars, the map's own extent, no hatch`, res.every((r) => r.ok) && new Set(res.map((r) => r.gen)).size === 3, JSON.stringify(res.filter((r) => !r.ok)));
  ok('depth: older data, no page errors, no NaN', od.errors.length === 0 && noJunk(await bodyText(p)), od.errors[0]);
  await od.ctx.close();
}

// ---------- 4f3. history.json: LP fees per hour (14 days) and per day (90 days) ----------
// Each row's fees cover the time since the row before: a bar spans that stretch at fees ÷ its hours or days (a gap the
// backfill hasn't filled is one wide bar at its average), the first row draws nothing, an unread row is hatched; the
// view pans and zooms in time and zooming out stops at the rows' own span.
const RATE_LOOK = (id) => {
  const h = document.querySelector(`[data-pz="${id}"]`), box = h.closest('[data-chartbox]');
  return { view: h.dataset.view, rects: [...h.querySelectorAll('.pz-c svg > rect:not(.unread)')].map((r) => ({ x: +r.getAttribute('x'), w: +r.getAttribute('width'), h: +r.getAttribute('height') })),
    unread: h.querySelectorAll('.pz-c svg > rect.unread').length, title: box.querySelector('.pane-title > .lbl').textContent, cap: (box.querySelector('.pz-cap2') || {}).textContent || '',
    out: box.querySelector('[data-act="zoom"][data-dir="-1"]').disabled };
};
function rateExpect(rows, vi, unit, view) {
  const t0 = rows[0][0], U = (t) => (t - t0) / unit, bars = [];
  for (let i = 1; i < rows.length; i++) { const a = rows[i - 1][0], b = rows[i][0], v = rows[i][vi]; bars.push({ a: U(a), b: U(b), r: typeof v === 'number' ? v / ((b - a) / unit) : null }); }
  const mx = Math.max(...bars.filter((x) => x.r != null).map((x) => x.r)), [c, len] = view, v0 = c - len;
  const seen = bars.filter((x) => x.b >= v0 && x.a <= c);
  return { n: U(rows.at(-1)[0]), unread: seen.filter((x) => x.r == null).length, max: Math.max(...seen.filter((x) => x.r != null).map((x) => x.r)),
    bars: seen.filter((x) => x.r > 0).map((x) => { const full = ((x.b - x.a) / len) * 300; return { x: ((x.a - v0) / len) * 300, w: Math.max(0.4, full - Math.min(1, full * 0.25)), h: (x.r / mx) * 64 }; }) };
}
function rectsMatch(got, want) {
  const bad = [], used = new Set();
  for (const e of want) {
    const g = got.filter((b) => !used.has(b) && Math.abs(b.x - e.x) < 0.02).sort((p, q) => Math.abs(p.h - e.h) - Math.abs(q.h - e.h))[0];
    if (g) used.add(g);
    if (!g || Math.abs(g.w - e.w) > 0.02 || Math.abs(g.h - e.h) > 0.06) bad.push(`x ${e.x.toFixed(2)} w ${e.w.toFixed(2)} h ${e.h.toFixed(2)} got ${g ? `w ${g.w} h ${g.h}` : 'none'}`);
  }
  return { ok: !bad.length && got.length === want.length, why: `${got.length}/${want.length} · ${bad.slice(0, 2).join(' | ')}` };
}
const money = (txt) => { const m = /\$([\d.,]+)([KMB]?)/.exec(txt || ''); return m ? +m[1].replace(/,/g, '') * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1) : null; };
async function testHistory(browser) {
  const H = 3600e3, D = 24 * H, ents = Object.entries(FXD.history.pools);
  const gapP = ents.find(([, e]) => e.d.length >= 80 && e.d.some((r, i) => i && r[0] - e.d[i - 1][0] > 1.5 * D) && e.h.some((r, i) => i && r[0] - e.h[i - 1][0] > 1.5 * H));
  const nrP = ents.find(([, e]) => e.h.slice(1).some((r) => r[3] === null) && e.h.length > 300);
  for (const phone of [false, true]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    for (const [id, e] of [gapP, nrP]) {
      await openPool(p, id.slice(0, 12));
      for (const [cid, rows, vi, unit, word, days] of [['d-hr', e.h, 3, H, 'hour', 14], ['d-day', e.d, 2, D, 'day', 90]]) {
        let a = await p.evaluate(RATE_LOOK, cid);
        const view = a.view.split(',').map(Number), x = rateExpect(rows, vi, unit, view), m = rectsMatch(a.rects, x.bars);
        const lv = phone && cid === 'd-hr' ? 2 : 1; // a phone opens the hourly fees on their latest 7 days
        ok(`history ${tag}: fees per ${word} over ${days} days, one bar per row at fees ÷ the ${word}s since the row before (${a.title})`, new RegExp(`per ${word} · ${days} d$`).test(a.title) && near(view[1], x.n / lv, 0.02) && m.ok, a.title + ' ' + a.view + ' ' + m.why);
        ok(`history ${tag}: …unread rows hatched (${x.unread}), the first row and gaps never drawn as 0, its max ${a.cap} the data's`, a.unread === x.unread && Math.abs(money(a.cap) - x.max) / x.max < 0.06, `${a.unread}/${x.unread} ${a.cap} vs ${x.max.toFixed(2)}`);
        if (lv === 1) {
          ok(`history ${tag}: …zoomed all the way out it shows the whole span and − stops there`, a.out && near(view[1], x.n, 0.02), a.view);
        } else {
          await zoomAllOut(p, cid, '#sheet');
          a = await p.evaluate(RATE_LOOK, cid);
          ok(`history ${tag}: …− shows the rest of the span, then stops at it`, a.out && near(+a.view.split(',')[1], x.n, 0.02), a.view);
          await p.evaluate((cid) => document.querySelector(`#sheet [data-act="zreset"][data-chart="${cid}"]`).click(), cid); await sleep(120); // zoom is kept per chart
        }
      }
      await closePool(p);
    }
    ok(`history ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4f4. the stablecoin-pairs switch: off by default, those pairs hidden everywhere but favourites and the benchmark ----------
// Fixture pairs quoted in USDC (and TOVI/MUNT, whose quote is a stablecoin by its address only) are the stablecoin pairs.
const isStableFx = (p) => p.t1.sym === 'USDC' || p.t1.addr === STABLE_PROBE_ADDR;
const SEEN_LISTS = () => ({
  tabs: [...document.querySelectorAll('#best [role="tab"] .tn')].map((e) => e.textContent), kick: document.querySelector('#best .lbl.acc').textContent,
  next: [...document.querySelectorAll('#next .nb-row .pn')].map((e) => e.textContent), nextSub: document.querySelector('#next .sub').textContent,
  rows: [...document.querySelectorAll('#all tbody tr.row .pn2')].map((e) => e.textContent), count: document.querySelector('#all-count').textContent,
  sw: document.querySelector('#f-stab').getAttribute('aria-checked'), swText: document.querySelector('#f-stab').textContent.trim(), n: document.querySelector('#f-stab-n').textContent,
  fav: [...document.querySelectorAll('#fav .mc .n')].map((e) => e.textContent), bench: document.querySelector('#bench').textContent,
});
async function testStable(browser) {
  const pools = FXD.live.pools, stab = pools.filter(isStableFx), N = stab.length, isStPair = (name) => /\/(USDC|MUNT)$/.test(name);
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, stableDefault: true }), p = t.page;
    await p.click('[data-act="more"]').catch(() => {}); await sleep(150);
    let a = await p.evaluate(SEEN_LISTS);
    ok(`stable ${tag}: the switch is off by default, a switch for assistive tech, and says how many pairs it hides (${a.n})`, a.sw === 'false' && /Off/.test(a.swText) && a.n === `${N} hidden` && (await p.getAttribute('#f-stab', 'role')) === 'switch', JSON.stringify([a.sw, a.swText, a.n, N]));
    ok(`stable ${tag}: All pools lists no stablecoin pair, and counts them hidden`, a.rows.length === pools.length - N && !a.rows.some(isStPair) && a.count.includes(`${N} HIDDEN · STABLECOIN PAIRS OFF`), `${a.rows.length}/${pools.length - N} ${a.count}`);
    ok(`stable ${tag}: Next best and the best-find tabs list none, with the hidden count`, a.next.length > 0 && !a.next.some(isStPair) && /hidden · stablecoin pairs off/.test(a.nextSub) && a.tabs.length > 0 && !a.tabs.some(isStPair) && /HIDDEN · STABLECOIN PAIRS OFF/.test(a.kick), JSON.stringify({ next: a.next, tabs: a.tabs, kick: a.kick }));
    ok(`stable ${tag}: the benchmark stays (${a.bench.slice(0, 20)})`, /UNI\/WETH/.test(a.bench));
    // a stablecoin known only by its address (TOVI/MUNT: MUNT sits at USDC's address on Base)
    await fillQ(p, 'TOVI');
    ok(`stable ${tag}: a pair whose stablecoin is known by its contract address only is hidden too`, (await p.$$('#all tbody tr.row')).length === 0);
    await fillQ(p, '');
    // the search's suggestions leave them out and say so
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-q').scrollIntoView({ block: 'start' }); });
    await p.click('#f-q'); await p.keyboard.type('usdc', { delay: 15 }); await sleep(250);
    const q = await p.evaluate(() => ({ opts: [...document.querySelectorAll('#q-list .qopt')].map((e) => e.textContent), note: (document.querySelector('#q-list .qnote') || {}).textContent || '', open: !document.querySelector('#q-list').hidden }));
    ok(`stable ${tag}: search suggestions leave stablecoin pairs out and say how many (${q.note})`, q.open && !q.opts.some((x) => /USDC/i.test(x)) && new RegExp(`^${N - 1} hidden · stablecoin pairs off$`).test(q.note), JSON.stringify(q));
    await p.keyboard.press('Escape'); await p.fill('#f-q', ''); await p.$eval('#f-q', (e) => e.blur()); await sleep(150);
    // similar pools under the best find's detail
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    const sim = await p.evaluate(() => ({ cards: [...document.querySelectorAll('#sim .mc .n')].map((e) => e.textContent), head: document.querySelector('#sim .mc-head').textContent }));
    ok(`stable ${tag}: similar pools leave them out, with the hidden count`, sim.cards.length > 1 && !sim.cards.some(isStPair) && /hidden · stablecoin pairs off/.test(sim.head), JSON.stringify(sim).slice(0, 160));
    await p.click('#sheet-close'); await sleep(120);
    // the info note
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-stab').scrollIntoView({ block: 'center' }); });
    await p.click('#all .ibtn'); await sleep(150);
    const note = await p.evaluate(() => !document.querySelector('#pop').hidden && document.querySelector('#pop').textContent);
    ok(`stable ${tag}: its ⓘ explains the switch in plain words`, /Stablecoin pairs/.test(note || '') && /favourites always show/i.test(note || '') && /this device/.test(note || ''), String(note).slice(0, 80));
    await p.keyboard.press('Escape'); await sleep(100);
    if (!phone) await auditAt(p, 'stable-off-w1440');
    // switch on: they all come back; kept on this device; the keyboard stays on the switch
    await p.click('#f-stab'); await sleep(300);
    const st = await p.evaluate(() => ({ ls: localStorage.getItem('lps.stable'), focus: document.activeElement && document.activeElement.id }));
    await p.click('[data-act="more"]').catch(() => {}); await sleep(150);
    a = await p.evaluate(SEEN_LISTS);
    ok(`stable ${tag}: switched on, every pool is listed again (${a.n}), kept on this device, focus stays on the switch`, a.sw === 'true' && /On/.test(a.swText) && a.rows.length === pools.length && a.rows.some(isStPair) && !/HIDDEN/.test(a.count) && st.ls === '1' && st.focus === 'f-stab', JSON.stringify([a.sw, a.rows.length, a.count, st]));
    await p.reload(); await waitApp(p); await sleep(200);
    ok(`stable ${tag}: …and stays on after a reload`, (await p.getAttribute('#f-stab', 'aria-checked')) === 'true');
    await p.click('#f-stab'); await sleep(250);
    ok(`stable ${tag}: switched off again, they hide again`, (await p.getAttribute('#f-stab', 'aria-checked')) === 'false' && (await p.evaluate(() => localStorage.getItem('lps.stable'))) === '0');
    ok(`stable ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  // a starred stablecoin pair always shows: in All pools, the tabs and the favourites strip; its pair view hides the other pool
  const numa = pools.filter((x) => x.pair === 'NUMA/USDC').sort((x, y) => (y.w['30d']?.gem?.total ?? -1) - (x.w['30d']?.gem?.total ?? -1));
  const f = await openUnlocked(browser, 'default', { width: 1440, stableDefault: true, storage: { 'lps.hint': '1', 'lps.fav': JSON.stringify([numa[0].id]) } }), p = f.page;
  await p.click('[data-act="more"]').catch(() => {}); await sleep(150);
  let a = await p.evaluate(SEEN_LISTS);
  ok('stable: a starred stablecoin pair still shows (table, best-find tabs, favourites), its twin pool stays hidden', a.rows.filter((x) => x === 'NUMA/USDC').length === 1 && a.tabs.includes('NUMA/USDC') && a.fav.includes('NUMA/USDC') && a.n === `${N - 1} hidden`, JSON.stringify({ rows: a.rows.filter((x) => x === 'NUMA/USDC').length, tabs: a.tabs, fav: a.fav, n: a.n }));
  await fillQ(p, numa[0].id.slice(0, 12));
  await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#all tbody tr.row td:nth-child(3)').click(); });
  await p.waitForSelector('#sheet:not([hidden])'); await sleep(250);
  await p.click('#sheet-pair'); await sleep(350);
  const pv = await p.evaluate(() => ({ rows: document.querySelectorAll('#sheet-body table.pv tbody tr').length, meta: document.querySelector('#sheet-meta').textContent, btn: !!document.querySelector('#sheet-body [data-act="stable-on"]') }));
  ok('stable: the pair view of a starred stablecoin pair lists the starred pool, says one is hidden and offers to show it', pv.rows === 1 && /1 hidden · stablecoin pairs off/.test(pv.meta) && pv.btn, JSON.stringify(pv));
  await p.click('#sheet-body [data-act="stable-on"]'); await sleep(350);
  const pv2 = await p.evaluate(() => ({ rows: document.querySelectorAll('#sheet-body table.pv tbody tr').length, sw: document.querySelector('#f-stab').getAttribute('aria-checked') }));
  ok('stable: …"Show stablecoin pairs" turns the switch on and lists both', pv2.rows === 2 && pv2.sw === 'true', JSON.stringify(pv2));
  ok('stable: favourites, no page errors', f.errors.length === 0, f.errors[0]);
  await f.ctx.close();
  // the 24-hour window with them off: its gems are all stablecoin pairs in the fixture, so the best find says none, cleanly
  const d = await openUnlocked(browser, 'default', { phone: true, win: '24h', stableDefault: true, reducedMotion: 'reduce' }), pd = d.page;
  ok('stable: a window whose every gem is hidden says "No gem", lists the rest, no NaN', /No gem in the 24-hour window/.test(await pd.textContent('#best')) && (await pd.$$('#best [role="tab"]')).length > 0 && noJunk(await bodyText(pd)));
  await auditAt(pd, 'stable-off-phone-24h');
  await d.ctx.close();
  // storage blocked (a private window): the switch still works for the visit, nothing breaks
  const b = await newPage(browser, { width: 1440, stableDefault: true });
  await b.ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await b.page.goto(url('default')); await unlockWith(b.page, FIXTURE_PASSPHRASE); await waitApp(b.page);
  const off = await b.page.getAttribute('#f-stab', 'aria-checked');
  await b.page.click('#f-stab'); await sleep(250);
  ok('stable: with storage blocked it starts off and still switches, without errors', off === 'false' && (await b.page.getAttribute('#f-stab', 'aria-checked')) === 'true' && b.errors.length === 0, b.errors[0]);
  await b.ctx.close();
}

// ---------- 4g. sheets: swipe down to close on a phone ----------
// touch events are made in the page (Playwright has no touch drag); a mouse on the grab handle is the fallback
async function swipe(page, sel, dy, { ms = 16, steps = 10, dx = 0, at = 0.5 } = {}) {
  return page.evaluate(async ({ sel, dy, ms, steps, dx, at }) => {
    const el = document.querySelector(sel), r = el.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + Math.min(r.height * at, 40);
    const target = document.elementFromPoint(x0, y0) || el;
    let T;
    try { T = (x, y) => new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y }); T(0, 0); } catch (e) { return 'no-touch'; }
    const fire = (type, x, y) => { const t = T(x, y); target.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); };
    fire('touchstart', x0, y0);
    for (let i = 1; i <= steps; i++) { await new Promise((r2) => setTimeout(r2, ms)); fire('touchmove', x0 + (dx * i) / steps, y0 + (dy * i) / steps); }
    fire('touchend', x0 + dx, y0 + dy);
    return 'touch';
  }, { sel, dy, ms, steps, dx, at });
}
// a pull: touch events where the browser can make them, else a mouse drag on the grab handle (WebKit has no Touch())
async function pull(page, sel, dy, o = {}) {
  const how = await swipe(page, sel, dy, o);
  if (how !== 'no-touch') return how;
  if (sel !== '#sheet .grab') return 'none';
  const { ms = 16, steps = 10 } = o, b = await page.locator(sel).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x, y + (dy * i) / steps); await sleep(ms); }
  await page.mouse.up();
  return 'mouse';
}
async function testSheets(browser) {
  const t = await openUnlocked(browser, 'default', { phone: true }), p = t.page;
  const open = async () => { await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(320); };
  const isOpen = () => p.isVisible('#sheet');
  const ty = () => p.$eval('#sheet .sheet-card', (c) => new DOMMatrix(getComputedStyle(c).transform).m42);
  await open();
  const g = await p.$eval('#sheet .grab', (e) => { const r = e.getBoundingClientRect(); return { h: r.height, w: r.width, top: r.top, ta: getComputedStyle(e).touchAction }; });
  ok('sheets phone: a grab handle tops the sheet', g.h >= 16 && g.top >= 0 && g.top < 40 && g.ta === 'none', JSON.stringify(g));
  ok('sheets phone: the close button stays', await p.isVisible('#sheet-close'));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'sheet-phone-handle.png') });
  // a short, slow pull springs back
  let how = await pull(p, '#sheet .grab', 50, { ms: 40, steps: 6 });
  await sleep(450);
  ok(`sheets phone: a short slow pull springs back (${how})`, (await isOpen()) && (await ty()) === 0);
  // mid-pull the sheet follows the finger (mouse on the handle: the same code path past the first move)
  const gb = await p.locator('#sheet .grab').boundingBox(), gx = gb.x + gb.width / 2, gy = gb.y + gb.height / 2;
  await p.mouse.move(gx, gy); await p.mouse.down();
  for (let i = 1; i <= 8; i++) { await p.mouse.move(gx, gy + i * 15); await sleep(20); }
  const mid = await ty();
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'sheet-phone-mid-swipe.png') });
  for (let i = 7; i >= 0; i--) { await p.mouse.move(gx, gy + i * 15); await sleep(40); }
  await sleep(150); await p.mouse.up(); await sleep(450);
  ok('sheets phone: the sheet follows the finger down, then springs back when let go near the top', mid > 100 && mid < 140 && (await isOpen()) && (await ty()) === 0, String(mid));
  // a long pull from the handle closes it
  how = await pull(p, '#sheet .grab', 320);
  await sleep(500);
  ok(`sheets phone: a long pull down closes the sheet (${how})`, !(await isOpen()));
  // from the content: only when it is scrolled to the top (touch only: a mouse doesn't drag content)
  await open();
  await p.$eval('#sheet-body', (b) => { b.scrollTop = 300; });
  await sleep(100);
  how = await pull(p, '#sheet-body', 260, { at: 0.5 });
  await sleep(500);
  if (how === 'none') ok('sheets phone: pulls inside the content (no synthetic touch in this browser: skipped)', true);
  else {
    ok('sheets phone: a pull inside scrolled content doesn\'t close (it scrolls)', await isOpen());
    await p.$eval('#sheet-body', (b) => { b.scrollTop = 0; });
    await sleep(100);
    await pull(p, '#sheet-body', 260, { at: 0.5 });
    await sleep(500);
    ok('sheets phone: …at the top of the content, the same pull closes it', !(await isOpen()));
    await open();
    await pull(p, '#sheet-body', 30, { dx: 200, at: 0.5 });
    await sleep(450);
    ok('sheets phone: a sideways swipe doesn\'t close it', await isOpen());
  }
  // the similar-pools list scrolls inside the sheet's header: a pull there scrolls it back up before it drags the sheet
  if (!(await isOpen())) await open();
  await p.evaluate(() => document.querySelector('#sim [data-act="sim-all"]').click()); await sleep(200);
  await p.$eval('#sim-list', (l) => { l.scrollTop = 80; });
  how = await pull(p, '#sim-list', 260, { at: 0.5 });
  await sleep(500);
  if (how === 'none') ok('sheets phone: a pull inside the similar-pools list (no synthetic touch here: skipped)', true);
  else ok('sheets phone: a pull inside the scrolled similar-pools list doesn\'t close the sheet', (await isOpen()) && (await ty()) === 0);
  await p.evaluate(() => { const b = document.querySelector('#sim [data-act="sim-all"]'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); }); await sleep(150);
  // a quick flick closes even when short
  if (!(await isOpen())) await open();
  await pull(p, '#sheet .grab', 70, { ms: 8, steps: 4 });
  await sleep(500);
  ok('sheets phone: a quick short flick down closes it', !(await isOpen()));
  // the pair view is the same sheet
  await p.evaluate(() => document.querySelector('#best h2 button[data-act="pair"]').click());
  await p.waitForSelector('#sheet:not([hidden])'); await sleep(320);
  await pull(p, '#sheet .grab', 320);
  await sleep(500);
  ok('sheets phone: the pair view closes with a swipe as well', !(await isOpen()));
  ok('sheets phone: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  // reduced motion: closes at once, nothing animates
  const r = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' });
  await r.page.click('#best [data-act="detail"]'); await r.page.waitForSelector('#sheet:not([hidden])');
  await pull(r.page, '#sheet .grab', 320);
  await sleep(40);
  ok('sheets: under reduced motion a swipe closes at once, unanimated', !(await r.page.isVisible('#sheet')) && (await r.page.evaluate(() => document.getAnimations().length)) === 0);
  await r.ctx.close();
  // a laptop's side panel has no handle and ignores swipes
  const l = await openUnlocked(browser, 'default', { width: 1440 });
  await l.page.click('#best [data-act="detail"]'); await l.page.waitForSelector('#sheet:not([hidden])');
  ok('sheets laptop: the side panel has no grab handle', !(await l.page.isVisible('#sheet .grab')));
  await swipe(l.page, '#sheet-body', 320, { at: 0.2 });
  await sleep(400);
  ok('sheets laptop: …and a swipe doesn\'t close it', await l.page.isVisible('#sheet'));
  await l.ctx.close();
}

// ---------- 4h. sticky table headers and back to top ----------
const STICKY = (sel) => {
  const box = document.querySelector(sel), sh = box.parentElement.querySelector(':scope > .sh'), real = [...box.querySelectorAll('thead th')], copy = sh ? [...sh.querySelectorAll('th')] : [];
  const bar = document.querySelector('#top'), sc = box.closest('.sheet-body'), top = sc ? sc.getBoundingClientRect().top : bar.classList.contains('hid') ? 0 : Math.max(0, bar.getBoundingClientRect().bottom); // the copy docks under the bar on top
  const on = !!sh && sh.classList.contains('on') && getComputedStyle(sh.firstElementChild).display !== 'none';
  const cr = on ? sh.firstElementChild.getBoundingClientRect() : null, br = box.getBoundingClientRect();
  const vw = sh ? sh.firstElementChild.getBoundingClientRect() : br;
  // every column the user can see lines up with the real one under it
  let mis = 0;
  if (on) real.forEach((th, i) => { const a = th.getBoundingClientRect(), b = copy[i] && copy[i].getBoundingClientRect(); if (!b) { mis++; return; } const seen = Math.min(a.right, vw.right) - Math.max(a.left, vw.left) > 4; if (seen && (Math.abs(a.left - b.left) > 1 || Math.abs(a.width - b.width) > 1)) mis++; });
  return { on, top: cr ? cr.top - top : null, bottom: cr ? cr.bottom : null, boxBottom: br.bottom, mis, cols: real.length, sl: Math.round(box.scrollLeft), csl: sh ? Math.round(sh.firstElementChild.scrollLeft) : null };
};
async function testSticky(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, 0); });
    await calm(p, BAR_MOVES);
    let s = await p.evaluate(STICKY, '#all-box');
    ok(`sticky ${tag}: no header copy at the top of the page`, !s.on);
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#all-tbl tbody tr:nth-child(10)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 120); });
    await calm(p, BAR_MOVES);
    s = await p.evaluate(STICKY, '#all-box');
    ok(`sticky ${tag}: inside All pools the header row sticks to the top, columns aligned (${s.cols})`, s.on && Math.abs(s.top) <= 1 && s.mis === 0, JSON.stringify(s));
    const hit = await p.evaluate(() => { const r = document.querySelector('#all .sh .sh-in').getBoundingClientRect(), e = document.elementFromPoint(r.left + 40, r.top + r.height / 2); return !!e && !!e.closest('.sh'); });
    ok(`sticky ${tag}: …on top of the rows, not under them`, hit);
    await p.evaluate(() => { const b = document.querySelector('#all-box'); b.scrollLeft = Math.min(260, b.scrollWidth - b.clientWidth); });
    for (let k = 0; k < 15; k++) { await sleep(100); s = await p.evaluate(STICKY, '#all-box'); if (s.on && s.mis === 0) break; }
    ok(`sticky ${tag}: …and follows the table's sideways scroll`, s.on && s.mis === 0, JSON.stringify(s));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `sticky-${tag}.png`) });
    // a sort from the stuck header works and the header stays
    const before = await p.getAttribute('#all-tbl thead th:nth-child(3)', 'aria-sort');
    await p.evaluate(() => document.querySelector('#all .sh button[data-k="net"]').click());
    await calm(p, BAR_MOVES);
    ok(`sticky ${tag}: sorting from the stuck header sorts the table`, before === 'none' && (await p.getAttribute('#all-tbl thead th:nth-child(3)', 'aria-sort')) !== 'none' && (await p.evaluate(STICKY, '#all-box')).on);
    // at the end of the table it leaves with the table: never over what follows
    await p.evaluate(() => { const b = document.querySelector('#all-box').getBoundingClientRect(); scrollTo(0, scrollY + b.bottom - 30); });
    await calm(p, BAR_MOVES);
    s = await p.evaluate(STICKY, '#all-box');
    ok(`sticky ${tag}: at the table's end the header goes with it, never past it`, !s.on || s.bottom <= s.boxBottom + 1, JSON.stringify(s));
    await p.evaluate(() => { const b = document.querySelector('#all-box').getBoundingClientRect(); scrollTo(0, scrollY + b.bottom + 40); });
    await calm(p, BAR_MOVES);
    ok(`sticky ${tag}: past the table no header copy is left behind`, !(await p.evaluate(STICKY, '#all-box')).on);
    await p.evaluate(() => scrollTo(0, 0)); await calm(p, BAR_MOVES);
    ok(`sticky ${tag}: back at the top it is gone (not stuck)`, !(await p.evaluate(STICKY, '#all-box')).on);
    // the detail panel's long "every window" table sticks inside the panel's own scroll
    await p.click('#best [data-act="detail"]');
    await p.waitForSelector('#sheet:not([hidden])'); await calm(p, ['#sheet .sheet-card', '#sheet .sheet-head']);
    const wsel = '#sheet-body .tbl-box:not(.sh-in) > .wtbl';
    await p.evaluate((sel) => { const b = document.querySelector('#sheet-body'), tb = document.querySelector(sel).closest('.tbl-box'), r = tb.querySelector('tbody tr:nth-child(8)').getBoundingClientRect(); b.scrollTop += r.top - b.getBoundingClientRect().top - 40; }, wsel);
    await calm(p, ['#sheet .sheet-card', '#sheet .sheet-head', '.sh']);
    const ws = await p.evaluate((sel) => { const tb = document.querySelector(sel).closest('.tbl-box'); tb.id ||= 'wtbl-box'; return '#' + tb.id; }, wsel);
    s = await p.evaluate(STICKY, ws);
    ok(`sticky ${tag}: in the detail panel the window table's header sticks to the panel's top`, s.on && Math.abs(s.top) <= 1 && s.mis === 0, JSON.stringify(s));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `sticky-sheet-${tag}.png`) });
    await p.click('#sheet-close');
    ok(`sticky ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}
const TOTOP = () => { const b = document.querySelector('#totop'), r = b.getBoundingClientRect(), cs = getComputedStyle(b); return { on: cs.visibility === 'visible' && +cs.opacity > 0, w: r.width, h: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, y: scrollY, label: b.getAttribute('aria-label') }; };
// the button follows the scroll in the next drawn frame and fades in .18 s: wait for that many frames (a slow WebKit draws
// one every 100–260 ms), then for the state, up to 3 s
const frames = (page, n = 3) => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); }, n);
// after a scroll: the page reacts in its next drawn frames (the scroll event, then its own frame: the bar slides, the
// table header copy moves to dock under it, the panel's top folds), and those slides take .22 s each. On a slow WebKit
// that is 1–3 frames of 50–260 ms, after a scroll event that itself waits for a frame. So: a few frames, then until
// no finite animation on these elements (all, when none are named) is still going, then one more frame; up to `ms`.
// Returns how many were still going at the end (0 when calm).
const calm = (page, sels = [], ms = 5000) => page.evaluate(async ({ sels, ms }) => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) await frame();
  const going = () => (sels.length ? sels.flatMap((s) => [...document.querySelectorAll(s)]).flatMap((e) => e.getAnimations()) : document.getAnimations())
    .filter((a) => a.playState !== 'finished' && a.playState !== 'idle' && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime));
  while (going().length && performance.now() - t0 < ms) await frame();
  await frame();
  return going().length;
}, { sels, ms });
const BAR_MOVES = ['#top', '.sh'];
async function totopIs(page, on) {
  await frames(page);
  await page.waitForFunction((on) => { const b = document.querySelector('#totop'), cs = getComputedStyle(b); return (cs.visibility === 'visible' && +cs.opacity > 0.98) === on || (!on && cs.visibility === 'hidden'); }, on, { timeout: 3000 }).catch(() => {});
  return page.evaluate(TOTOP);
}
async function testTop(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['laptop', { width: 1440 }], ['phone reduced', { phone: true, reducedMotion: 'reduce' }]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    let b = await p.evaluate(TOTOP);
    ok(`top ${tag}: no ↑ button at the top of the page`, !b.on);
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, innerHeight * 0.5); });
    await sleep(350); await frames(p);
    ok(`top ${tag}: …nor half a screen down`, !(await p.evaluate(TOTOP)).on);
    await p.evaluate(() => scrollTo(0, innerHeight * 1.6));
    b = await totopIs(p, true);
    ok(`top ${tag}: after a screen a round ↑ button appears, 44×44, inside the screen`, b.on && b.w >= 44 && b.h >= 44 && b.inside && b.label === 'Back to top', JSON.stringify(b));
    if (SHOTS && tag !== 'phone reduced') await p.screenshot({ path: path.join(SHOTS, `totop-${tag}.png`) });
    await p.click('#totop');
    if (/reduced/.test(tag)) { await sleep(60); ok(`top ${tag}: under reduced motion it jumps to the top at once`, (await p.evaluate(() => scrollY)) === 0); }
    else { await p.waitForFunction(() => scrollY === 0, null, { timeout: 4000 }).catch(() => {}); ok(`top ${tag}: it scrolls smoothly back to the top`, (await p.evaluate(() => scrollY)) === 0); }
    ok(`top ${tag}: …and hides again`, !(await totopIs(p, false)).on);
    // at the very bottom of the page the button covers no control (the footer keeps room for it)
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, document.documentElement.scrollHeight); });
    await totopIs(p, true);
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(p); // the bar on top slid away: the bottom again
    const under = await p.evaluate(() => { const a = document.querySelector('#totop').getBoundingClientRect(); return [...document.querySelectorAll('button, a[href], select, input, [data-act]')].filter((e) => e.id !== 'totop' && e.offsetParent !== null).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && a.left < r.right && r.left < a.right && a.top < r.bottom && r.top < a.bottom; }).map((e) => e.id || e.dataset.act || e.tagName); });
    ok(`top ${tag}: at the bottom of the page it covers no control`, (await p.evaluate(TOTOP)).on && under.length === 0, under.join(','));
    ok(`top ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4i. zoom robustness: every zoom level and both pan ends, at every width, never break the layout ----------
const CHART_AUDIT = (id) => {
  const box = document.querySelector(`[data-chartbox="${id}"]`), host = box && box.querySelector(`[data-pz="${id}"]`);
  if (!box || !host) return { missing: true };
  const hr = host.getBoundingClientRect(), out = { hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, w: Math.round(hr.width), over: [], outside: [], junk: /\bNaN\b|\bundefined\b|\bInfinity\b/.test(box.textContent) };
  const head = box.querySelector(':scope > .chart-head, :scope > .pane-title');
  const parts = head ? [...head.children].filter((e) => e.getBoundingClientRect().width > 0) : [];
  const ctl = head ? [...head.querySelectorAll('.zseg, .zreset, .openwin')] : [];
  const items = [...parts.filter((e) => !e.classList.contains('ctools')), ...ctl];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
    if (a.right - 1 > b.left && b.right - 1 > a.left && a.bottom - 1 > b.top && b.bottom - 1 > a.top) out.over.push((items[i].className || items[i].tagName) + '×' + (items[j].className || items[j].tagName));
  }
  const ticks = [...host.querySelectorAll('.tick')].map((e) => e.getBoundingClientRect()).sort((a, b) => a.left - b.left);
  for (const r of ticks) if (r.left < hr.left - 1 || r.right > hr.right + 1) out.outside.push('tick');
  for (let i = 1; i < ticks.length; i++) if (ticks[i].left < ticks[i - 1].right - 1 && Math.abs(ticks[i].top - ticks[i - 1].top) < 4) out.over.push('tick×tick');
  for (const e of host.querySelectorAll(':scope > .pz-edge:not([hidden]), .mlab, .cpill, .bylab')) { const r = e.getBoundingClientRect(); if (r.left < hr.left - 1 || r.right > hr.right + 1) out.outside.push(e.className.split(' ')[0]); }
  return out;
};
async function testZoomFit(browser) {
  const widths = DEVICE ? [0, 1300, 1440, 1920] : [360, 390, 430, 768, 1300, 1440, 1920];
  const bad = [];
  let checks = 0;
  for (const w of widths) {
    const still = w && w !== 390 && w !== 1440; // reduced motion at the other widths: edge steps land at once (and that mode is covered too)
    const t = await openUnlocked(browser, 'default', w ? { width: w, height: 900, reducedMotion: still ? 'reduce' : 'no-preference' } : { phone: true }), p = t.page, tag = (w ? 'w' + w : 'phone') + (still ? ' reduced' : '');
    for (const id of ['liq-best', 'daily-best']) {
      const look = async (when) => {
        const a = await p.evaluate(CHART_AUDIT, id);
        checks++;
        if (a.missing || a.hscroll > 0 || a.over.length || a.outside.length || a.junk) bad.push(`${tag} ${id} ${when}: ${a.missing ? 'missing' : [a.hscroll > 0 ? 'page scrolls sideways' : '', ...a.over, ...a.outside, a.junk ? 'NaN' : ''].filter(Boolean).join(' ')}`);
        return a;
      };
      const w0 = (await look('default')).w;
      for (let k = 0; k < 5 && (await p.isEnabled(`[data-act="zoom"][data-chart="${id}"][data-dir="-1"]`)); k++) { await pzClick(p, `[data-act="zoom"][data-chart="${id}"][data-dir="-1"]`); await sleep(90); await look('out ' + k); }
      for (let k = 0; k < 6 && (await p.isEnabled(`[data-act="zoom"][data-chart="${id}"][data-dir="1"]`)); k++) {
        await pzClick(p, `[data-act="zoom"][data-chart="${id}"][data-dir="1"]`); await sleep(90);
        const a = await look('in ' + k);
        if (a.w !== w0) bad.push(`${tag} ${id}: the chart changed width when zoomed (${w0} → ${a.w})`);
        for (const side of ['l', 'r']) {
          for (let s = 0; s < 8 && (await p.isVisible(`[data-pz="${id}"] > .pz-edge.${side}`)); s++) { await pzClick(p, `[data-pz="${id}"] > .pz-edge.${side}`); await sleep(still ? 40 : 320); }
          await look(`in ${k} at the ${side === 'l' ? 'left' : 'right'} end`);
        }
      }
      if (SHOTS && !still) await snap(p, `zoomfit-${tag}-${id}-max`, `[data-chartbox="${id}"]`);
      await pzClick(p, `[data-act="zreset"][data-chart="${id}"]`).catch(() => {});
      await sleep(120);
    }
    if (t.errors.length) bad.push(`${tag}: page error ${t.errors[0]}`);
    await t.ctx.close();
  }
  ok(`zoomfit: every zoom level and both pan ends keep the layout whole (${checks} views, widths ${widths.map((x) => x || 'phone').join('/')})`, bad.length === 0, bad.slice(0, 3).join(' | '));
  // the detail panel's charts at their deepest zoom, phone and laptop, plus reduced motion
  for (const [tag, o] of [['phone', { phone: true }], ['laptop', { width: 1440 }], ['phone reduced', { phone: true, reducedMotion: 'reduce' }]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])');
    for (const id of await p.$$eval('#sheet [data-pz]', (h) => h.map((x) => x.dataset.pz))) {
      for (let k = 0; k < 6 && (await p.isEnabled(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`)); k++) { await p.evaluate((id) => document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`).click(), id); await sleep(80); }
    }
    const a = await p.evaluate(() => { const b = document.querySelector('#sheet-body'); return { hs: b.scrollWidth - b.clientWidth, txt: b.innerText }; });
    const over = [];
    for (const id of await p.$$eval('#sheet [data-pz]', (h) => h.map((x) => x.dataset.pz))) { const c = await p.evaluate(CHART_AUDIT, id); if (c.over.length || c.outside.length) over.push(id + ' ' + [...c.over, ...c.outside].join(' ')); }
    ok(`zoomfit ${tag}: the detail panel at full zoom: no sideways scroll, nothing overlapping`, a.hs <= 0 && over.length === 0 && noJunk(a.txt), `${a.hs}px ${over.slice(0, 2).join(' | ')}`);
    if (SHOTS && tag === 'phone') await p.screenshot({ path: path.join(SHOTS, 'zoomfit-sheet-phone.png') });
    await t.ctx.close();
  }
}

// ---------- 4e. every way into a pool lands on its liquidity shape ----------
async function testRows(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const shapeIn = (sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.height > 40 && r.top >= -2 && r.top < innerHeight - 60; }, sel);
    const tap = async (sel) => {
      await p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector(sel).scrollIntoView({ block: 'center' }); }, sel);
      const b = await p.locator(sel).first().boundingBox();
      await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    const close = async () => { if (await p.isVisible('#sheet')) { await p.click('#sheet-close'); await sleep(100); } };
    const into = [];
    for (const [name, sel] of [['a table row, by its name', '#all tbody tr.row td:nth-child(1)'], ['by its gem', '#all tbody tr.row td:nth-child(2)'],
      ['by a number', '#all tbody tr.row td:nth-child(5)'], ['by a tag', '#all tbody tr.row .tag'], ['a next-best row', '#next .nb-row'],
      ['a new-since row', '#ns-body .ns-row'], ['the bench tile', '#bench'], ['full breakdown', '#best [data-act="detail"]']]) {
      await tap(sel);
      await sleep(400);
      const good = (await p.isVisible('#sheet')) && (await shapeIn('#sheet [data-chartbox="liq-detail"]'))
        && (await p.evaluate(() => document.querySelector('#sheet-body').firstElementChild.dataset.chartbox)) === 'liq-detail';
      into.push([name, good]);
      await close();
    }
    const missed = into.filter((x) => !x[1]).map((x) => x[0]);
    ok(`rows ${tag}: every way into a pool opens it on its shape within 400 ms (${into.length})`, missed.length === 0, missed.join(', '));
    await tap('#best [role="tab"]:nth-child(2)');
    await sleep(400);
    ok(`rows ${tag}: a best-find tab lands on the card's shape`, await shapeIn('[data-chartbox="liq-best"] .liq'));
    await tap('#bt-lead tr.row td:nth-child(1)');
    await sleep(1400);
    ok(`rows ${tag}: a backtest row opens its replay on the pool's shape`, await shapeIn('#rp-shape .liq'));
    await p.click('#bt-replay [data-act="bt-close"]');
    // a swipe across a row scrolls the table; it doesn't open the pool
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#all tbody tr.row').scrollIntoView({ block: 'center' }); });
    const c2 = await p.locator('#all tbody tr.row td:nth-child(3)').first().boundingBox();
    await p.mouse.move(c2.x + 20, c2.y + c2.height / 2); await p.mouse.down(); await p.mouse.move(c2.x + 60, c2.y + c2.height / 2, { steps: 4 }); await p.mouse.up();
    await sleep(300);
    ok(`rows ${tag}: a swipe (10 px or more) is not a tap`, !(await p.isVisible('#sheet')));
    const c3 = await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); getSelection().removeAllRanges(); document.querySelector('#all-box').scrollLeft = 0; const td = document.querySelector('#all tbody tr.row td:nth-child(2)'); td.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = td.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    await p.mouse.move(c3.x + 10, c3.y + c3.height / 2); await p.mouse.down(); await p.mouse.move(c3.x + 14, c3.y + c3.height / 2); await p.mouse.up();
    await sleep(300);
    ok(`rows ${tag}: a tap that wobbles under 10 px still opens the pool`, await p.isVisible('#sheet'));
    await close();
    // a pool with no fees in 30 days opens like any other (it used to throw)
    await fillQ(p, 'ORVO');
    await sleep(300);
    await tap('#all tbody tr.row td:nth-child(2)');
    await sleep(400);
    ok(`rows ${tag}: a pool with no fees in 30 days opens and says so`, (await p.isVisible('#sheet')) && /no fees in \d+ days/i.test(await p.innerText('#sheet .daily')));
    await close();
    await fillQ(p, '');
    ok(`rows ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  const r = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' });
  await r.page.click('#best [data-act="detail"]');
  await sleep(50);
  ok('rows: reduced motion runs no animation', (await r.page.evaluate(() => document.getAnimations().length)) === 0);
  await r.ctx.close();
  const m = await openUnlocked(browser, 'default', { phone: true });
  await m.page.click('#best [data-act="detail"]');
  await sleep(30);
  ok('rows: otherwise the panel slides in', (await m.page.evaluate(() => document.getAnimations().length)) > 0);
  await m.ctx.close();
}

// ---------- 4c. the refresh button ----------
async function testRefresh(browser) {
  const t = await openUnlocked(browser, 'default', { phone: true }), p = t.page;
  let n = 0;
  p.on('request', (r) => { if (/\/(live|history|backtest)\.json\?t=/.test(r.url())) n++; });
  ok('refresh: a labelled icon button, 44 px', (await p.getAttribute('#refresh', 'aria-label')) === 'Refresh' && (await p.$eval('#refresh', (b) => b.getBoundingClientRect().height)) >= 43.5);
  await p.route('**/live.json*', async (r) => { await sleep(700); await r.continue(); });
  await p.click('#refresh');
  await sleep(150);
  ok('refresh: spins while loading', (await p.getAttribute('#refresh', 'class')).includes('spin'));
  await p.click('#refresh', { force: true }).catch(() => {});
  await p.waitForFunction(() => /Updated \d\d:\d\d/.test(document.querySelector('#refresh-msg').textContent), null, { timeout: 8000 });
  ok('refresh: re-fetches live, history and backtest at once, double taps ignored', n === 3, n + ' requests');
  ok('refresh: says "Updated hh:mm" in the owner’s time zone', /^Updated \d\d:\d\d (CET|CEST|GMT\+\d)$/.test(await p.textContent('#refresh-msg')), await p.textContent('#refresh-msg'));
  await p.unroute('**/live.json*');
  await p.route('**/live.json*', (r) => r.abort());
  await sleep(1600);
  await p.click('#refresh');
  await p.waitForFunction(() => /Refresh failed/.test(document.querySelector('#refresh-msg').textContent), null, { timeout: 8000 });
  ok('refresh: a failure keeps the last good data and says so', /^Refresh failed — showing data from \d\d:\d\d$/.test(await p.textContent('#refresh-msg')) && (await p.textContent('#best h2')) === 'VELNA/WETH');
  ok('refresh: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
}

// ---------- 7. Part 2: the top strip, favourites, the table's why and new, similar pools, highlights, search, links ----------
const SEEN_KEY = (id) => String(id).slice(0, 18).toLowerCase();
const STRIP = () => {
  const g = document.querySelector('#gas'), m = document.querySelector('#mstrip'), r = g.getBoundingClientRect(), mr = m.getBoundingClientRect();
  return { shown: !m.hidden && mr.height > 0, h: r.height, gas: g.innerText.replace(/\s+/g, ' ').trim(), cls: g.className, title: g.title,
    px: [...document.querySelectorAll('#mpx .px')].map((e) => ({ c: e.dataset.c, t: e.innerText.replace(/\s+/g, ' ').trim(), up: !!e.querySelector('.up'), dn: !!e.querySelector('.dn') })),
    pxFit: (() => { const x = document.querySelector('#mpx'); return x.scrollWidth <= x.clientWidth + 1; })(), mt: document.querySelector('#mt').innerText.replace(/\s+/g, ' ').trim(),
    stripH: Math.round(mr.height) };
};
async function testMarket(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['w360', { width: 360, height: 800 }], ['w768', { width: 768 }], ['laptop', { width: 1440 }]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    const a = await p.evaluate(STRIP);
    ok(`market ${tag}: a slim strip tops the page once unlocked`, a.shown && a.stripH <= (tag === 'laptop' ? 34 : 60), JSON.stringify(a).slice(0, 120));
    ok(`market ${tag}: gas shows 2 significant digits in gwei, coloured by its band`, /^0\.\d\d gwei( normal)?$/.test(a.gas) && /g-normal/.test(a.cls), a.gas + ' ' + a.cls);
    ok(`market ${tag}: the gas button is a 44 px tap target`, a.h >= 43.5, String(a.h));
    ok(`market ${tag}: its tooltip gives p10 / p50 / p90 and what it is compared with`, /p10 0\.\d+ · p50 0\.\d+ · p90 0\.\d+ gwei/.test(a.title) && /days of hourly readings/.test(a.title), a.title);
    ok(`market ${tag}: ETH, BTC and SOL with a 24 h arrow each (▲ up, ▼ down)`, a.px.map((x) => x.c).join() === 'ETH,BTC,SOL' && a.px[0].up && a.px[1].dn && a.px[2].up
      && /^ETH \$3,400 ▲1\.2%$/.test(a.px[0].t) && /^BTC \$96\.2K ▼0\.4%$/.test(a.px[1].t) && /^SOL \$182 ▲3\.1%$/.test(a.px[2].t), a.px.map((x) => x.t).join(' | '));
    ok(`market ${tag}: the three prices fit without scrolling`, a.pxFit);
    ok(`market ${tag}: a countdown to the next pass and "updated hh:mm" CET`, /next( pass)? in ([1-7] min|<1 min) · updated \d\d:\d\d( (CET|CEST))?$/.test(a.mt) && (tag !== 'laptop' || / (CET|CEST)$/.test(a.mt)), a.mt); // the fixture's next pass is 6 min after it was written
    await p.click('#gas'); await sleep(200);
    const pop = await p.evaluate(() => { const e = document.querySelector('#pop'); return { on: !e.hidden, t: e.innerText, exp: document.querySelector('#gas').getAttribute('aria-expanded') }; });
    ok(`market ${tag}: a tap on the gauge opens a note with the range`, pop.on && pop.exp === 'true' && /p10 0\.\d+ · median 0\.\d+ · p90 0\.\d+ gwei/.test(pop.t) && /cheap below p25/.test(pop.t), pop.t.slice(0, 60));
    await p.keyboard.press('Escape'); await sleep(100);
    ok(`market ${tag}: Escape puts the note away and the focus back on the gauge`, !(await p.isVisible('#pop')) && (await p.evaluate(() => document.activeElement && document.activeElement.id)) === 'gas');
    if (tag === 'phone' && SHOTS) await snap(p, 'p2-strip-phone', 'header');
    ok(`market ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // unread: dashes, never 0
  const t = await openUnlocked(browser, 'nomarket', { phone: true }), p = t.page, a = await p.evaluate(STRIP);
  ok('market: unread gas shows — gwei, uncoloured, with no band', /^— gwei$/.test(a.gas) && /g-none/.test(a.cls), a.gas);
  ok('market: an unread price and an unread 24 h change show —, never 0', /^SOL — —$/.test(a.px[2].t) && /^BTC \$96\.2K —$/.test(a.px[1].t) && !/\$0\b|0\.0%|\b0 gwei/.test(a.px.map((x) => x.t).join(' ') + a.gas), a.px.map((x) => x.t).join(' | '));
  ok('market: no next pass known → the countdown says —', /next( pass)? — · updated \d\d:\d\d/.test(a.mt), a.mt);
  await p.click('#gas'); await sleep(150);
  ok('market: the unread gauge’s note says so plainly', /— gwei/.test(await p.innerText('#pop')) && /Not enough history/.test(await p.innerText('#pop')));
  if (SHOTS) await snap(p, 'p2-strip-unread', 'header');
  ok('market: no page errors (nomarket)', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  // reduced motion: the countdown ring stands still
  const r = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' });
  ok('market: under reduced motion nothing animates', (await r.page.evaluate(() => document.getAnimations().length)) === 0);
  await r.ctx.close();
}

async function testFav(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const favNow = () => p.evaluate(() => ({ cards: [...document.querySelectorAll('#fav .mc')].map((c) => c.dataset.id), empty: !!document.querySelector('#fav .empty'), count: document.querySelector('#fav-count').textContent, note: document.querySelector('#fav .devnote').innerText }));
    let f = await favNow();
    ok(`fav ${tag}: an empty Favourites section near the top says how to star a pool`, f.empty && f.cards.length === 0 && /Tap the ☆/.test(await p.innerText('#fav')), JSON.stringify(f).slice(0, 80));
    ok(`fav ${tag}: …and that stars stay on this device only`, /this device only/.test(f.note) && /can’t recognise you/.test(f.note));
    const near = await p.evaluate(() => { const a = document.querySelector('#fav').getBoundingClientRect(), b = document.querySelector('#all').getBoundingClientRect(); return a.top < b.top && a.top < innerHeight * (innerWidth < 700 ? 2.2 : 1); });
    ok(`fav ${tag}: the section sits near the top, above All pools`, near);
    // star from the table, the best-find header and the detail header
    const id1 = await p.getAttribute('#all tbody tr.row:nth-child(3)', 'data-id');
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector('#all tbody tr.row:nth-child(3) .star'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(150);
    ok(`fav ${tag}: a row's ☆ turns gold (pressed) without opening the pool`, (await p.getAttribute('#all tbody tr.row:nth-child(3) .star', 'aria-pressed')) === 'true' && !(await p.isVisible('#sheet')));
    const bestId = await p.getAttribute('#best [data-act="detail"]', 'data-id');
    await p.evaluate(() => document.querySelector('#best .ttl .star').click()); await sleep(150);
    f = await favNow();
    ok(`fav ${tag}: the best-find star adds it too; the section fills, newest first`, f.cards.length === 2 && f.cards[0] === bestId && f.cards[1] === id1 && !f.empty && /2 STARRED/.test(f.count), JSON.stringify(f.cards));
    ok(`fav ${tag}: the Lens filter's "★ Favourites" count follows at once`, /\(2\)$/.test(await p.$eval('#f-lens option[value="fav"]', (o) => o.textContent)));
    await p.evaluate(() => document.querySelector('#best [data-act="detail"]').click()); await p.waitForSelector('#sheet:not([hidden])');
    ok(`fav ${tag}: the detail header's star shows it is starred`, (await p.getAttribute('#sheet-star .star', 'aria-pressed')) === 'true');
    await p.click('#sheet-star .star'); await sleep(150);
    ok(`fav ${tag}: …and un-stars it everywhere at once`, (await p.getAttribute('#best .ttl .star', 'aria-pressed')) === 'false' && (await favNow()).cards.length === 1);
    await p.click('#sheet-star .star'); await sleep(100);
    await p.click('#sheet-close');
    await p.reload(); await waitApp(p);
    f = await favNow();
    ok(`fav ${tag}: stars survive a reload (this browser keeps them)`, f.cards.length === 2 && f.cards.includes(id1) && f.cards.includes(bestId));
    if (SHOTS) await snap(p, `p2-fav-${tag}`, '#fav');
    // a card opens its pool; its star removes it, the keyboard stays in the section
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#fav .mc-name').click(); }); await sleep(300);
    ok(`fav ${tag}: a favourite card opens that pool, shape first`, (await p.isVisible('#sheet')) && (await p.evaluate(() => document.querySelector('#sheet-body').firstElementChild.dataset.chartbox)) === 'liq-detail');
    await p.click('#sheet-close');
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#fav').scrollIntoView({ block: 'center' }); }); await sleep(150);
    const cb = await p.locator('#fav .mc .mc-v').first().boundingBox();
    await p.mouse.click(cb.x + 10, cb.y + cb.height / 2); await sleep(300);
    ok(`fav ${tag}: a tap anywhere on the card opens it (one control: the name's link)`, (await p.isVisible('#sheet')) && (await p.$$('#fav .mc-cover')).length === 0);
    await p.click('#sheet-close');
    await p.focus('#fav .mc .star'); await p.keyboard.press('Enter'); await sleep(150);
    ok(`fav ${tag}: un-starring from the card removes it; the focus stays in Favourites`, (await favNow()).cards.length === 1 && (await p.evaluate(() => !!document.activeElement.closest('#fav'))));
    // the lens filter lists only favourites
    await p.selectOption('#f-lens', 'fav'); await sleep(200);
    ok(`fav ${tag}: the Lens filter "★ Favourites" lists the starred pools only`, (await p.$$('#all tbody tr.row')).length === 1);
    await p.selectOption('#f-lens', 'all'); await sleep(150);
    ok(`fav ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // planted: garbage in storage never breaks the page
  const g = await openUnlocked(browser, 'default', { phone: true, storage: { 'lps.fav': '{"not":"a list"', 'lps.seen': '"garbage"', 'lps.simm': '99' } });
  ok('fav planted: unreadable stored favourites and seen ids are ignored, not fatal', (await g.page.isVisible('#fav .empty')) && (await g.page.$$('#all .newdot')).length === 0 && g.errors.length === 0, g.errors[0]);
  await g.ctx.close();
  const h = await openUnlocked(browser, 'default', { phone: true, storage: { 'lps.fav': JSON.stringify(['<img src=x onerror="window.__xss=1">', '0xNOTHEX']) } });
  ok('fav planted: stored ids that are not pool ids are dropped', (await h.page.isVisible('#fav .empty')) && (await h.page.evaluate(() => window.__xss)) === undefined && h.errors.length === 0);
  await h.ctx.close();
}

async function testTable2(browser) {
  const { live } = makeData({ now: Date.now() });
  // the key columns fit a phone without a sideways scroll
  for (const w of [360, 390, 430]) {
    const t = await openUnlocked(browser, 'default', { width: w, height: 800 }), p = t.page;
    const fit = await p.evaluate(() => { const box = document.querySelector('#all-box'), b = box.getBoundingClientRect(), ths = [...box.querySelectorAll('thead th')]; return { keys: ths.slice(0, 4).map((x) => x.querySelector('button').dataset.k).join(), right: Math.round(ths[3].getBoundingClientRect().right - b.right), sl: box.scrollLeft, more: box.scrollWidth > box.clientWidth }; });
    ok(`table w${w}: Pool, Gem, Net APR and Why show without a sideways scroll; the rest scroll`, fit.keys === 'pair,gem,net,why' && fit.right <= 1 && fit.sl === 0 && fit.more, JSON.stringify(fit));
    await t.ctx.close();
  }
  const l = await openUnlocked(browser, 'default', { width: 1440 });
  ok('table laptop: every column fits a laptop, no sideways scroll', await l.page.evaluate(() => { const b = document.querySelector('#all-box'); return b.scrollWidth <= b.clientWidth + 1; }));
  ok('table laptop: fewer, better columns (12: the 30-day fee bar after Why, since v0.4.2)', (await l.page.$$eval('#all-tbl thead th', (x) => x.map((e) => e.querySelector('button').dataset.k).join())) === 'pair,gem,net,why,fees,vol,tvl,room,feeApr,edge,sigma,age');
  await l.ctx.close();
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    // why: pictograms with a note; toxic flow explained
    const tox = live.pools.find((x) => x.w['30d'] && x.w['30d'].lenses.includes('toxic') && x.verified !== false);
    await fillQ(p, tox.pair);
    const cell = await p.evaluate(() => { const b = document.querySelector('#all tbody tr.row td.why .whyb'); return b ? { icons: b.querySelectorAll('svg.wi').length, red: !!b.querySelector('svg.wi.r'), label: b.getAttribute('aria-label') } : null; });
    ok(`table ${tag}: a toxic pool's Why cell shows a red pictogram with a spoken label`, cell && cell.icons >= 1 && cell.red && /Toxic flow/.test(cell.label), JSON.stringify(cell));
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector('#all tbody tr.row td.why .whyb'); b.scrollIntoView({ block: 'center' }); b.click(); });
    await sleep(200);
    const pop = await p.evaluate(() => ({ on: !document.querySelector('#pop').hidden, t: document.querySelector('#pop').innerText, sheet: !document.querySelector('#sheet').hidden }));
    ok(`table ${tag}: a tap on the icons explains them in plain words (and doesn't open the pool)`, pop.on && !pop.sheet && /Toxic flow\. Traders here tend to know where the price is going: right after their swaps the price moves against LPs, so fees don’t cover the loss \(markout ÷ fee high\)\./.test(pop.t), pop.t.slice(0, 90));
    if (SHOTS) await snap(p, `p2-why-${tag}`);
    await p.evaluate(() => document.querySelector('#all h2').click()); await sleep(120);
    ok(`table ${tag}: a tap elsewhere puts the note away`, !(await p.isVisible('#pop')));
    await fillQ(p, '');
    // the legend
    ok(`table ${tag}: the legend starts folded`, !(await p.isVisible('#why-legend')) && (await p.getAttribute('#why-tog', 'aria-expanded')) === 'false');
    await p.evaluate(() => document.querySelector('#why-tog').click()); await sleep(120);
    const lg = await p.evaluate(() => ({ n: document.querySelectorAll('#why-legend > div').length, t: document.querySelector('#why-legend').innerText }));
    ok(`table ${tag}: "What the Why icons mean" unfolds a plain-words legend (${lg.n})`, (await p.getAttribute('#why-tog', 'aria-expanded')) === 'true' && lg.n === 13 && /Toxic flow: Traders here tend to know/.test(lg.t) && /Stranded: Most of the money sits far from the price/.test(lg.t), lg.t.slice(0, 60));
    if (SHOTS) await snap(p, `p2-legend-${tag}`, '#all');
    await p.evaluate(() => document.querySelector('#why-tog').click()); await sleep(100);
    ok(`table ${tag}: …and folds again`, !(await p.isVisible('#why-legend')));
    ok(`table ${tag}: the first visit marks nothing as new`, (await p.$$('#all .newdot')).length === 0 && !/NEW/.test(await p.textContent('#all-count')));
    ok(`table ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // the new dot: two pools not seen at the last page load
  const g30 = (x) => (x.verified === false || !x.w['30d'] || x.w['30d'].gem.total == null ? -1 : x.w['30d'].gem.total);
  const fresh = live.pools.slice().sort((a, b) => g30(b) - g30(a)).slice(0, 2).map((x) => x.id); // two pools near the top of the 30-day table
  const seen = live.pools.filter((x) => !fresh.includes(x.id)).map((x) => SEEN_KEY(x.id));
  const t = await openUnlocked(browser, 'default', { phone: true, storage: { 'lps.seen': JSON.stringify(seen) } }), p = t.page;
  const dots = await p.$$eval('#all tbody tr.row', (rs) => rs.filter((r) => r.querySelector('.newdot')).map((r) => r.dataset.id));
  ok('table: pools new since the last page load carry a small dot, the rest none', dots.length === 2 && fresh.every((id) => dots.includes(id)) && /· 2 NEW$/.test(await p.textContent('#all-count')), `${dots.length} dots`);
  if (SHOTS) await snap(p, 'p2-newdot', '#all');
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('lps.seen')).length);
  ok('table: this load\'s pools are remembered as seen', saved === live.pools.length, String(saved));
  await t.ctx.close();
}

// the similar-pools ranking, written out again on its own: same pair (native ETH = WETH), then the same tier with a shared
// token, then the same tier, then a shared token; higher volume per day first; unverified last
function expectSimilar(live, p, wk) {
  const n = (s) => (String(s).toUpperCase() === 'ETH' ? 'WETH' : String(s).toUpperCase()), syms = (q) => [n(q.t0.sym), n(q.t1.sym)];
  const key = (q) => syms(q).slice().sort().join('/'), mine = syms(p);
  return live.pools.filter((q) => q.id !== p.id).map((q) => {
    const pair = key(q) === key(p) || q.pairKey === p.pairKey, tier = q.feeTier === p.feeTier, share = syms(q).some((x) => mine.includes(x)), w = q.w[wk];
    return { id: q.id, uv: q.verified === false ? 1 : 0, g: pair ? 0 : tier && share ? 1 : tier ? 2 : share ? 3 : -1, v: w && w.volUsd != null && w.days > 0 ? w.volUsd / w.days : -1 };
  }).filter((x) => x.g >= 0).sort((a, b) => a.uv - b.uv || a.g - b.g || b.v - a.v).map((x) => x.id);
}
async function testSimilar(browser) {
  const { live } = makeData({ now: Date.now() });
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const id = await p.getAttribute('#best [data-act="detail"]', 'data-id'), pool = live.pools.find((x) => x.id === id);
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])');
    const anims = await p.evaluate(() => document.querySelectorAll('#sim .mc').length && document.querySelector('#sim .mc').getAnimations().length);
    await sleep(500);
    const read = () => p.evaluate(() => ({ ids: [...document.querySelectorAll('#sim .mc[data-id]')].map((c) => c.dataset.id), self: [...document.querySelectorAll('#sim .mc.self')].map((c) => c.dataset.id),
      ks: [...new Set([...document.querySelectorAll('#sim .mc-v .k')].map((k) => k.textContent))], dots: [...document.querySelectorAll('#sim .mdots i')].findIndex((i) => i.classList.contains('on')),
      end: (document.querySelector('#sim [data-act="sim-all"]') || {}).innerText, head: document.querySelector('#sim .mc-head').innerText, inHead: !!document.querySelector('.sheet-head #sim'),
      first: document.querySelector('#sheet-body').firstElementChild.dataset.chartbox }));
    let a = await read();
    const want = expectSimilar(live, pool, '30d');
    ok(`similar ${tag}: a strip of mini cards sits under the pool's header, this pool first and outlined`, a.inHead && a.self.length === 1 && a.ids[0] === id && a.self[0] === id && a.first === 'liq-detail', JSON.stringify(a).slice(0, 100));
    ok(`similar ${tag}: ranked same pair, then tier + token, then tier, then token; by volume; unverified last (fixture order)`, JSON.stringify(a.ids.slice(1)) === JSON.stringify(want.slice(0, 8)), `${a.ids.slice(1, 4).map((x) => x.slice(0, 8))} vs ${want.slice(0, 3).map((x) => x.slice(0, 8))}`);
    const uv = live.pools.filter((x) => x.verified === false && want.includes(x.id)).map((x) => x.id);
    ok(`similar ${tag}: planted: the pair's unverified pool has the most volume, yet ranks after every verified one`, uv.length > 0 && want.slice(-uv.length).every((x) => uv.includes(x)) && live.pools.find((x) => x.pairKey === pool.pairKey && x.verified === false).w['30d'].volUsd > pool.w['30d'].volUsd);
    ok(`similar ${tag}: the strip ends in a "see all ${want.length}" card`, new RegExp(`^${want.length}\\s+see all$`).test(a.end.trim()) && new RegExp(`Similar pools · ${want.length}`, 'i').test(a.head), a.end);
    ok(`similar ${tag}: the cards slide in (motion allowed)`, anims > 0, String(anims));
    // tapping a card's body cycles the figure on every card: net APR → volume / day → gem → TVL → net APR
    const seq = [];
    for (let k = 0; k < 4; k++) {
      await p.evaluate((k) => document.querySelectorAll('#sim .mc-cover')[k % 3].click(), k); await sleep(120);
      a = await read(); seq.push(a.ks.join('|') + '@' + a.dots);
    }
    ok(`similar ${tag}: a tap on any card's body changes the figure on all cards, with a label and dots`, seq.join(' ') === 'volume / day@1 gem@2 TVL@3 net APR@0', seq.join(' '));
    await p.evaluate(() => document.querySelector('#sim .mc-cover').click()); await sleep(100); // leave it on volume / day
    ok(`similar ${tag}: the choice is spoken (aria-live) and kept on this device`, (await p.getAttribute('#sim-m', 'aria-live')) === 'polite' && (await p.evaluate(() => localStorage.getItem('lps.simm'))) === '1');
    // edge fades
    const fades = await p.evaluate(async () => { const t = document.querySelector('#sim .mc-track'), w = t.parentElement, a = [w.classList.contains('fl'), w.classList.contains('fr')]; t.scrollLeft = t.scrollWidth; await new Promise((r) => setTimeout(r, 120)); return [...a, w.classList.contains('fl'), w.classList.contains('fr'), getComputedStyle(t).scrollSnapType]; });
    ok(`similar ${tag}: snap scrolling with soft fades only where more cards lie`, !fades[0] && fades[1] && fades[2] && !fades[3] && /x mandatory/.test(fades[4]), JSON.stringify(fades));
    // see all: a list, again to fold it
    await p.evaluate(() => document.querySelector('#sim [data-act="sim-all"]').click()); await sleep(150);
    const lst = await p.evaluate(() => ({ on: !document.querySelector('#sim-list').hidden, n: document.querySelectorAll('#sim-list .sim-row').length, exp: document.querySelector('#sim [data-act="sim-all"]').getAttribute('aria-expanded'), v: document.querySelector('#sim-list .sim-row .v').textContent }));
    ok(`similar ${tag}: "see all" opens the whole list (${lst.n} rows), with the chosen figure`, lst.on && lst.n === want.length + 1 && lst.exp === 'true' && /^\$/.test(lst.v), JSON.stringify(lst));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `p2-similar-list-${tag}.png`) });
    await p.evaluate(() => document.querySelector('#sim [data-act="sim-all"]').click()); await sleep(120);
    ok(`similar ${tag}: …and folds it again`, !(await p.isVisible('#sim-list')));
    // a card's pair name opens that pool's detail, shape first
    const second = (await read()).ids[1];
    await p.evaluate(() => { const t = document.querySelector('#sim .mc-track'); t.scrollLeft = 0; document.querySelectorAll('#sim .mc-name')[1].click(); });
    await sleep(400);
    a = await read();
    const opened = live.pools.find((x) => x.id === second);
    ok(`similar ${tag}: a card's name opens that pool, shape first, now first in its own strip`, a.ids[0] === second && (await p.textContent('#sheet-title')) === opened.pair && a.first === 'liq-detail' && (await p.evaluate(() => document.querySelector('#sheet-body').scrollTop)) === 0, `${a.ids[0] === second}`);
    // the small window pills
    const pill = await p.evaluate(() => [...document.querySelectorAll('#sheet-win button')].map((b) => ({ b: b.getBoundingClientRect().height, s: b.firstElementChild.getBoundingClientRect().height })));
    ok(`similar ${tag}: the 24H/7D/30D switch is a small pill (~22 px) with 44 px tap areas`, pill.length === 3 && pill.every((x) => x.b >= 43.5 && x.s >= 19 && x.s <= 25), JSON.stringify(pill));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `p2-similar-${tag}.png`) });
    await p.click('#sheet-close');
    ok(`similar ${tag}: closing returns the focus to where the pool was opened`, (await p.evaluate(() => document.activeElement && document.activeElement.dataset.act)) === 'detail');
    ok(`similar ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  const r = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' });
  await r.page.click('#best [data-act="detail"]'); await sleep(60);
  ok('similar: under reduced motion the cards appear without sliding', (await r.page.evaluate(() => document.getAnimations().length)) === 0 && (await r.page.$$('#sim .mc')).length > 1);
  await r.ctx.close();
}

async function testHighlight(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    await p.click('#bt-lead tr.row'); await sleep(900);
    const lab = () => p.evaluate(() => ({ pressed: [...document.querySelectorAll('#bt-lab button[data-act="hl"]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.s),
      dim: [...document.querySelectorAll('[data-pz="lab"] path.ln')].filter((x) => x.getAttribute('stroke-opacity') === '0.18').map((x) => x.dataset.s), lines: document.querySelectorAll('[data-pz="lab"] path.ln').length,
      hits: document.querySelectorAll('[data-pz="lab"] path.hit').length, cell: [...document.querySelectorAll('#bt-lab button.cell')].filter((b) => b.getAttribute('aria-pressed') === 'true').length, det: (document.querySelector('#bt-lab .heat-detail') || {}).textContent || '' }));
    await p.evaluate(() => document.querySelector('#bt-lab button[data-act="hl"][data-s="tight"]').click()); await sleep(150);
    let a = await lab();
    ok(`highlight ${tag}: a strategy row highlights its line and dims the other ${a.lines - 1}`, a.pressed.join() === 'tight' && a.dim.length === a.lines - 1 && !a.dim.includes('tight'), JSON.stringify(a));
    await p.evaluate(() => document.querySelector('#bt-lab button[data-act="hl"][data-s="tight"]').click()); await sleep(150);
    a = await lab();
    ok(`highlight ${tag}: a second tap releases it`, a.pressed.length === 0 && a.dim.length === 0);
    // keyboard
    await p.focus('#bt-lab button[data-act="hl"][data-s="wide"]'); await p.keyboard.press('Enter'); await sleep(150);
    const k1 = await lab(), f1 = await p.evaluate(() => document.activeElement.dataset.s);
    await p.keyboard.press(' '); await sleep(150);
    const k2 = await lab();
    ok(`highlight ${tag}: keyboard: Enter highlights, Space releases, the focus stays on the row`, k1.pressed.join() === 'wide' && f1 === 'wide' && k2.pressed.length === 0);
    // a tap on the line itself
    ok(`highlight ${tag}: every line has a wide invisible tap target`, a.hits === a.lines);
    await p.evaluate(() => document.querySelector('[data-pz="lab"] path.hit[data-s="full"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await sleep(150);
    ok(`highlight ${tag}: tapping a line highlights it`, (await lab()).pressed.join() === 'full');
    await p.evaluate(() => document.querySelector('[data-pz="lab"] path.hit[data-s="full"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))); await sleep(150);
    // grid tiles
    await p.evaluate(() => document.querySelector('#bt-lab button.cell[data-ours="1"]').click()); await sleep(150);
    a = await lab();
    ok(`highlight ${tag}: the grid's "ours" tile highlights our line on the chart and says so`, a.cell === 1 && a.pressed.join() === 'ours' && /this is ours, highlighted on the chart/.test(a.det), JSON.stringify(a).slice(0, 120));
    if (SHOTS) await snap(p, `p2-highlight-${tag}`, '#bt-lab');
    await p.evaluate(() => document.querySelector('#bt-lab button.cell[data-ours="1"]').click()); await sleep(150);
    a = await lab();
    ok(`highlight ${tag}: tapping the tile again releases tile and line`, a.cell === 0 && a.pressed.length === 0 && !a.det);
    await p.evaluate(() => document.querySelector('#bt-lab button.cell:not([data-ours])').click()); await sleep(150);
    a = await lab();
    ok(`highlight ${tag}: another tile shows its own numbers (no line runs it)`, a.cell === 1 && a.pressed.length === 0 && /net APR, [+−]\d+ pts vs ours\. No strategy line runs these settings/.test(a.det), a.det);
    await p.evaluate(() => document.querySelector('#bt-lab button.cell[aria-pressed="true"]').click()); await sleep(120);
    ok(`highlight ${tag}: every tile is a 44 px button`, await p.evaluate(() => [...document.querySelectorAll('#bt-lab button.cell')].every((b) => b.getBoundingClientRect().height >= 43.5)));
    ok(`highlight ${tag}: a loss to holding is a red tile`, await p.evaluate(() => [...document.querySelectorAll('#bt-lab button.cell')].some((b) => /226, 102, 76/.test(getComputedStyle(b).backgroundColor) && /^−/.test(b.textContent))));
    // the money chart's legend
    const money = () => p.evaluate(() => ({ pressed: [...document.querySelectorAll('#rp-mleg button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.s), dim: [...document.querySelectorAll('[data-pz="rp-money"] path.ln')].filter((x) => x.getAttribute('stroke-opacity') === '0.18').map((x) => x.dataset.s) }));
    await p.evaluate(() => document.querySelector('#rp-mleg button[data-s="lvr"]').click()); await sleep(150);
    const m1 = await money();
    await p.evaluate(() => document.querySelector('#rp-mleg button[data-s="lvr"]').click()); await sleep(150);
    const m2 = await money();
    ok(`highlight ${tag}: "cumulative $ vs holding" legend highlights a line, then lets go`, m1.pressed.join() === 'lvr' && m1.dim.sort().join() === 'costs,fees,net' && m2.pressed.length === 0 && m2.dim.length === 0, JSON.stringify([m1, m2]));
    // a scrub keeps the highlight
    await p.evaluate(() => document.querySelector('#rp-mleg button[data-s="net"]').click()); await sleep(100);
    await p.evaluate(() => { const s = document.querySelector('#rp-scrub'); s.value = '3'; s.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
    ok(`highlight ${tag}: scrubbing the replay keeps the highlight`, (await money()).pressed.join() === 'net');
    ok(`highlight ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

async function testSearch(browser) {
  const { live } = makeData({ now: Date.now() });
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const list = () => p.evaluate(() => ({ on: !document.querySelector('#q-list').hidden, items: [...document.querySelectorAll('#q-list .qopt')].map((o) => o.querySelector('.qk').textContent + ' ' + o.querySelector('.qt').textContent),
      act: document.querySelector('#f-q').getAttribute('aria-activedescendant'), exp: document.querySelector('#f-q').getAttribute('aria-expanded'), hint: document.querySelector('#q-hint').textContent, v: document.querySelector('#f-q').value,
      rows: [...document.querySelectorAll('#all tbody tr.row .pn2')].map((x) => x.textContent) }));
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-q').scrollIntoView({ block: 'start' }); });
    await p.click('#f-q'); await p.keyboard.type('vel', { delay: 30 }); await sleep(200);
    let a = await list();
    ok(`search ${tag}: typing opens suggestions, likeliest first (prefix, then volume)`, a.on && a.exp === 'true' && a.items[0] === 'PAIR VELNA/WETH' && a.items[1] === 'TOKEN VELNA', a.items.join(' | '));
    ok(`search ${tag}: the top match shows inline as a hint`, a.hint === 'velNA/WETH', a.hint);
    if (SHOTS) await snap(p, `p2-search-${tag}`, '#all');
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await sleep(80);
    a = await list();
    ok(`search ${tag}: arrow keys move through the list (aria-activedescendant)`, a.act === 'qo-1');
    await p.keyboard.press('ArrowUp'); await p.keyboard.press('Enter'); await sleep(250);
    a = await list();
    ok(`search ${tag}: Enter picks it: the table filters to that pair (native ETH included)`, !a.on && a.v === 'VELNA/WETH' && a.rows.length === 4 && a.rows.every((x) => /^VELNA\/(W?ETH)$/.test(x)), a.rows.join(','));
    // Enter takes the inline hint
    await p.fill('#f-q', ''); await p.keyboard.type('num', { delay: 30 }); await sleep(150);
    await p.keyboard.press('Enter'); await sleep(250);
    a = await list();
    ok(`search ${tag}: Enter with the hint showing takes the top match`, a.v === 'NUMA/USDC' && a.rows.length >= 1 && a.rows.every((x) => x.includes('NUMA')), a.v);
    // a tap picks too; a token beats pairs on a word start
    await p.fill('#f-q', ''); await p.keyboard.type('weth', { delay: 20 }); await sleep(150);
    a = await list();
    ok(`search ${tag}: a token that matches from its start ranks first ("weth")`, a.items[0] === 'TOKEN WETH', a.items.slice(0, 3).join(' | '));
    await p.fill('#f-q', ''); await p.keyboard.type('kov', { delay: 20 }); await sleep(150);
    const o = await p.locator('#q-list .qopt').first().boundingBox();
    await p.mouse.click(o.x + o.width / 2, o.y + o.height / 2); await sleep(250);
    a = await list();
    ok(`search ${tag}: a tap on a suggestion picks it`, a.v === 'KOVA/WETH' && !a.on && a.rows.length >= 1 && a.rows.every((x) => x.startsWith('KOVA')), a.v);
    // a pool id opens that pool
    const pool = live.pools.find((x) => x.t0.sym === 'SELT');
    await p.fill('#f-q', ''); await p.keyboard.type(pool.id.slice(0, 7), { delay: 20 }); await sleep(150);
    a = await list();
    ok(`search ${tag}: a pool id's first characters suggest that pool`, a.items[0] && a.items[0].startsWith('POOL ' + pool.id.slice(0, 6)), a.items[0]);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter'); await sleep(400);
    ok(`search ${tag}: …and picking it opens it, shape first`, (await p.isVisible('#sheet')) && (await p.textContent('#sheet-title')) === pool.pair);
    await p.click('#sheet-close');
    // Escape; planted HTML ticker
    await p.fill('#f-q', ''); await p.keyboard.type('<img', { delay: 20 }); await sleep(150);
    a = await list();
    ok(`search ${tag}: planted: an HTML ticker is suggested as text, never run`, a.items.some((x) => x.includes('<img src=x')) && (await p.evaluate(() => window.__xss)) === undefined && (await p.$$('#q-list img')).length === 0);
    await p.keyboard.press('Escape'); await sleep(80);
    ok(`search ${tag}: Escape closes the list and keeps the text`, !(await list()).on && (await p.inputValue('#f-q')) === '<img');
    await fillQ(p, '');
    ok(`search ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

async function testLinks(browser) {
  const t = await openUnlocked(browser, 'default', { width: 1440 }), p = t.page;
  const links = async (q) => {
    await fillQ(p, q);
    await p.evaluate(() => document.querySelector('#all tbody tr.row td:nth-child(3)').click());
    await p.waitForSelector('#sheet:not([hidden])');
    const l = await p.$$eval('#sheet a[href]', (as) => as.map((a) => ({ href: a.href, t: a.target, rel: a.rel, act: a.dataset.act, rp: a.referrerPolicy })));
    const txt = await p.innerText('#sheet .facts');
    await p.click('#sheet-close');
    return { l, txt };
  };
  let a = await links('VELNA/WETH'); // the first row: VELNA/WETH 0.30% on Base, v3
  const ok3 = (x) => x.t === '_blank' && x.rel === 'noopener noreferrer' && x.act === 'ext' && x.rp === 'no-referrer';
  ok('links: a v3 pool on Base links to Basescan (pool, tokens) and to Uniswap, all in a new tab, no referrer', a.l.length >= 4 && a.l.every(ok3)
    && a.l.some((x) => /^https:\/\/basescan\.org\/address\/0x[0-9a-f]{40}$/.test(x.href)) && a.l.filter((x) => /^https:\/\/basescan\.org\/token\/0x[0-9a-f]{40}$/.test(x.href)).length === 2
    && a.l.some((x) => /^https:\/\/app\.uniswap\.org\/explore\/pools\/base\/0x[0-9a-f]{40}$/.test(x.href)), JSON.stringify(a.l.map((x) => x.href.replace(/0x[0-9a-f]+/, '0x…'))));
  a = await links('FENX'); // v4 on Ethereum, with a hook
  ok('links: a v4 pool id opens its Uniswap page; its hook and tokens open Etherscan', a.l.every(ok3) && a.l.some((x) => /^https:\/\/app\.uniswap\.org\/explore\/pools\/ethereum\/0x[0-9a-f]{64}$/.test(x.href))
    && a.l.some((x) => /^https:\/\/etherscan\.io\/address\/0x[0-9a-f]{40}$/.test(x.href)) && a.l.filter((x) => /^https:\/\/etherscan\.io\/token\//.test(x.href)).length === 2, JSON.stringify(a.l.map((x) => x.href.slice(0, 40))));
  a = await links('VELNA/ETH');
  ok('links: native ETH has no contract: said so, no link', /native ETH \(no contract\)/.test(a.txt) && a.l.filter((x) => /\/token\//.test(x.href)).length === 1);
  // the CSP lets the link open (the explorer is answered locally: nothing leaves this machine)
  await t.ctx.route('https://basescan.org/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>made-up explorer</p>' }));
  await fillQ(p, 'VELNA/WETH');
  await p.evaluate(() => document.querySelector('#all tbody tr.row td:nth-child(3)').click());
  await p.waitForSelector('#sheet:not([hidden])');
  await p.evaluate(() => { window.__allowExt = true; });
  const [pop] = await Promise.all([t.ctx.waitForEvent('page', { timeout: 8000 }), p.evaluate(() => document.querySelector('#sheet a[href^="https://basescan.org/address/"]').click())]);
  await pop.waitForLoadState('domcontentloaded').catch(() => {});
  ok('links: the page\'s CSP lets an explorer link open in a new tab (no opener)', /^https:\/\/basescan\.org\/address\//.test(pop.url()) && (await pop.evaluate(() => window.opener === null)), pop.url().slice(0, 40));
  await pop.close();
  ok('links: every link on the page is an explorer link in a new tab', await p.evaluate(() => [...document.querySelectorAll('a[href]')].every((a) => a.target === '_blank' && /noopener/.test(a.rel) && /^https:\/\/(etherscan\.io|basescan\.org|app\.uniswap\.org)\//.test(a.href))));
  ok('links: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
}

async function testLockNote(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const n = await p.evaluate(() => { const b = document.querySelector('#lockbtn').getBoundingClientRect(), e = document.querySelector('#lock-note'), r = e.getBoundingClientRect(); return { t: e.innerText, on: !e.hidden && r.height > 0, near: Math.abs(r.top - b.top) < 80 && r.left < b.right + 200, desc: document.querySelector('#lockbtn').getAttribute('aria-describedby'), btn: document.querySelector('#lockbtn').textContent }; });
    ok(`lock note ${tag}: the button reads "Sign out on this device"`, n.btn === 'Sign out on this device', n.btn);
    ok(`lock note ${tag}: next to "Sign out on this device", one plain line on what it does`, n.on && n.near && n.desc === 'lock-note' && n.t === 'Forgets the saved key here. You’ll need your passphrase next time. Your data stays encrypted either way.', JSON.stringify(n).slice(0, 100));
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await sleep(200);
    if (SHOTS) await snap(p, `p2-lock-note-${tag}`, 'footer');
    await p.click('#lockbtn'); await p.waitForSelector('#lockscreen:not([hidden])');
    ok(`lock note ${tag}: locked, the note, the strip and every star go`, !(await p.isVisible('#lock-note')) && !(await p.isVisible('#mstrip')) && (await p.$$('.star')).length === 0);
    await t.ctx.close();
  }
}

// ---------- 4o. chain marks: a colour edge and a mark on every pool row and card, and in the detail header ----------
const CHAIN_COL = { ethereum: '#8A9EF5', base: '#2F6BFF', bsc: '#F0B90B', arbitrum: '#28A0F0' }, CHAIN_NAME = { ethereum: 'Ethereum', base: 'Base' };
const CHAIN_SEEN = () => {
  const one = (el) => { if (!el) return null; const m = el.querySelector('.cg'); return { cc: getComputedStyle(el).getPropertyValue('--cc').trim().toUpperCase(), stripe: /inset/.test(getComputedStyle(el).boxShadow) && getComputedStyle(el).boxShadow.includes('3px 0px 0px'), mark: m ? m.getAttribute('aria-label') : null, markW: m ? Math.round(m.getBoundingClientRect().width) : 0 }; };
  return {
    rows: [...document.querySelectorAll('#all-tbl tbody tr.row')].map((r) => ({ id: r.dataset.id, ...one(r.querySelector('td.pool')) })),
    best: { id: document.querySelector('#best [data-act="detail"]') && document.querySelector('#best [data-act="detail"]').dataset.id, ...one(document.querySelector('#best')), mark: (document.querySelector('#best .ttl > .cg') || { getAttribute: () => null }).getAttribute('aria-label') },
    tabs: [...document.querySelectorAll('#best .tab')].map((t) => ({ id: t.dataset.id, mark: (t.querySelector('.cg') || { getAttribute: () => null }).getAttribute('aria-label') })),
    next: [...document.querySelectorAll('#next .nb-row')].map((r) => ({ id: r.dataset.id, ...one(r) })),
    fav: [...document.querySelectorAll('#fav .mc[data-id]')].map((c) => ({ id: c.dataset.id, ...one(c) })),
    key: [...document.querySelectorAll('#ch-key > span')].map((x) => x.textContent.trim()),
  };
};
async function testChains(browser) {
  const chainOk = (x) => { const p = poolOf(x.id); return p && x.cc === CHAIN_COL[p.chain] && x.stripe && x.mark === CHAIN_NAME[p.chain] && x.markW >= 10; };
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    await p.evaluate(() => { for (const b of [...document.querySelectorAll('#all tbody .star')].slice(0, 3)) b.click(); });
    await sleep(250);
    const c = await p.evaluate(CHAIN_SEEN);
    const bad = c.rows.filter((x) => !chainOk(x));
    ok(`chains ${tag}: every All pools row carries its chain's colour edge and mark (${c.rows.length} rows, ${new Set(c.rows.map((x) => x.cc)).size} chains)`, c.rows.length >= 20 && bad.length === 0 && new Set(c.rows.map((x) => x.cc)).size >= 2, JSON.stringify(bad[0] || {}));
    ok(`chains ${tag}: the best find carries its pool's colour edge and mark, and every tab its mark`, chainOk(c.best) && c.tabs.length >= 3 && c.tabs.every((x) => x.mark === CHAIN_NAME[poolOf(x.id).chain]), JSON.stringify(c.best));
    ok(`chains ${tag}: Next best rows and favourite cards carry them too`, c.next.length >= 3 && c.next.every(chainOk) && c.fav.length === 3 && c.fav.every(chainOk), JSON.stringify([c.next.find((x) => !chainOk(x)), c.fav.find((x) => !chainOk(x))]));
    ok(`chains ${tag}: a small key names the chains in this pass`, c.key.join() === 'Ethereum,Base', c.key.join());
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    const d = await p.evaluate(() => { const h = document.querySelector('#sheet .sheet-head'), m = h.querySelector('.ttl > .cg'); return { cc: getComputedStyle(h).getPropertyValue('--cc').trim().toUpperCase(), mark: m && m.getAttribute('aria-label'), sim: [...document.querySelectorAll('#sim .mc[data-id]')].map((c) => ({ id: c.dataset.id, cc: getComputedStyle(c).getPropertyValue('--cc').trim().toUpperCase(), mark: (c.querySelector('.cg') || { getAttribute: () => null }).getAttribute('aria-label') })) }; });
    const bp = poolOf(await bestId(p));
    ok(`chains ${tag}: the detail header carries the pool's mark and colour edge, and every similar pool card its own`, d.cc === CHAIN_COL[bp.chain] && d.mark === CHAIN_NAME[bp.chain] && d.sim.length >= 2 && d.sim.every((x) => x.cc === CHAIN_COL[poolOf(x.id).chain] && x.mark === CHAIN_NAME[poolOf(x.id).chain]), JSON.stringify(d).slice(0, 160));
    if (SHOTS) await snap(p, `chains-${tag}-detail`);
    await p.click('#sheet-close');
    // the pair view shows no single chain: its header has no mark and no edge
    await p.click('#best .best-h-btn'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(250);
    ok(`chains ${tag}: the pair view's header has no chain mark (it spans chains)`, await p.evaluate(() => !document.querySelector('#sheet .ttl > .cg') && !document.querySelector('#sheet .sheet-head').classList.contains('chs')));
    await p.click('#sheet-close');
    if (SHOTS) { await snap(p, `chains-${tag}-best`, '#best'); await snap(p, `chains-${tag}-all`, '#all'); }
    ok(`chains ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4j. text overlap: no text collides with other text or is cut off, at every width, before and after interactions ----------
// tools/overlap.mjs reads every visible text's line boxes (Range.getClientRects) and an icon-only control's glyph, per
// layer (the page, the panel, a note, the search list, a sticky header copy and the bar are layers of their own). The
// "long" fixture carries worst-case names and numbers: real data runs longer than the made-up default.
const OVL = (page, root) => page.evaluate(TEXT_OVERLAP, { root });
async function overlapSteps(p, tag, found, views) {
  const look = async (step, root) => { views.n++; for (const x of await OVL(p, root)) found.push(`${tag} ${step} · ${x.kind} ${x.sec}: ${x.a} × ${x.b}`); };
  const click = (sel) => p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(sel); if (!b || b.disabled) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel);
  const esc = async () => { await p.keyboard.press('Escape'); await sleep(120); };
  await look('top');
  // favourites: a few starred pools fill the strip near the top (long names next to their stars)
  for (const i of [1, 2, 3, 4, 7]) await p.evaluate((i) => { const b = document.querySelector(`#all tbody tr.row:nth-child(${i}) .star`); if (b) b.click(); }, i);
  await sleep(150);
  await look('favourites', '#fav');
  for (let k = 0; k < 4 && (await click('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]')); k++) await sleep(80);
  await look('chart zoomed out', '#best');
  for (let k = 0; k < 6 && (await click('[data-act="zoom"][data-chart="liq-best"][data-dir="1"]')); k++) await sleep(80);
  for (let k = 0; k < 8 && (await click('[data-pz="liq-best"] > .pz-edge.r:not([hidden])')); k++) await sleep(40);
  await look('chart zoomed in, right end', '#best');
  await click('[data-act="zreset"][data-chart="liq-best"]'); await sleep(100);
  for (let k = 0; k < 3 && (await click('[data-act="zoom"][data-chart="daily-best"][data-dir="1"]')); k++) await sleep(80);
  await look('daily strip zoomed in', '#best');
  await click('[data-act="zreset"][data-chart="daily-best"]'); await sleep(100);
  if (await click('#best .tags [data-term="hook"], #best .best-meta [data-act="term"]')) { await sleep(150); await look('a term\'s note'); await esc(); }
  if (await click('#gas')) { await sleep(150); await look('gas note'); await esc(); }
  if (await click('#all tbody .whyb')) { await sleep(150); await look('why note'); await esc(); }
  await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-q').scrollIntoView({ block: 'start' }); });
  await p.click('#f-q'); await p.keyboard.type('ve', { delay: 20 }); await sleep(200);
  await look('search list');
  await esc(); await p.fill('#f-q', ''); await p.$eval('#f-q', (e) => e.blur()); await sleep(150);
  if (await click('#why-tog')) { await sleep(120); await look('why legend', '#all'); await click('#why-tog'); }
  // the stablecoin-pairs switch: its note, then the page with the switch the other way (counts appear or go)
  if (await click('#all .ibtn')) { await sleep(150); await look('stablecoin note'); await esc(); }
  if (await click('#f-stab')) { await sleep(350); await look('stablecoin pairs switched'); await click('#f-stab'); await sleep(350); }
  // scrolled into the table, the bar back on top: the sticky header copy and the bar are layers over the rows
  await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#all-tbl tbody tr:nth-child(12)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 60); });
  await sleep(250); await p.evaluate(() => scrollBy(0, -60)); await sleep(380);
  await look('table scrolled, sticky header');
  await p.evaluate(() => scrollTo(0, 0)); await sleep(200);
  if (await click('#bt-lead tr.row')) { await sleep(800); await look('replay', '#bt'); }
  if (await click('#best [data-act="detail"]')) {
    await p.waitForSelector('#sheet:not([hidden])'); await sleep(400);
    await look('detail panel', '#sheet');
    if (await click('#sim [data-act="sim-all"]')) { await sleep(200); await look('similar list', '#sheet'); await click('#sim [data-act="sim-all"]'); }
    if (await click('#sheet .tags [data-act="term"], #sheet-meta [data-act="term"]')) { await sleep(150); await look('a term\'s note in the panel'); await esc(); }
    for (const id of ['liq-detail', 'daily-detail', 'd-px', 'd-fees', 'd-hr', 'd-day']) {
      for (let k = 0; k < 5 && (await p.evaluate((id) => { const b = document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="-1"]`); if (!b || b.disabled) return false; b.click(); return true; }, id)); k++) await sleep(60);
    }
    await look('panel charts zoomed out', '#sheet');
    for (const id of ['liq-detail', 'daily-detail', 'd-px', 'd-fees', 'd-hr', 'd-day']) {
      for (let k = 0; k < 6 && (await p.evaluate((id) => { const b = document.querySelector(`#sheet [data-act="zoom"][data-chart="${id}"][data-dir="1"]`); if (!b || b.disabled) return false; b.click(); return true; }, id)); k++) await sleep(60);
    }
    await look('panel charts zoomed in', '#sheet');
    await p.evaluate(() => { const b = document.querySelector('#sheet-body'); b.scrollTop = 500; }); await sleep(380);
    await look('panel scrolled (its top folded)', '#sheet');
    await p.click('#sheet-close'); await sleep(150);
  }
  if (await click('#best h2 button[data-act="pair"]')) { await sleep(350); await look('pair view', '#sheet'); await p.click('#sheet-close'); await sleep(120); }
}
async function testOverlap(browser) {
  const widths = DEVICE ? [0, 768, 1300, 1440, 1920] : [320, 360, 375, 390, 430, 768, 1300, 1440, 1920];
  for (const c of ['default', 'long']) {
    const found = [], views = { n: 0 }, errs = [];
    for (const w of widths) {
      const t = await openUnlocked(browser, c, { ...(w ? { width: w, height: 860 } : { phone: true }), storage: { 'lps.hint': '1' }, stableDefault: c === 'default' }), p = t.page; // default: stablecoin pairs off
      try { await overlapSteps(p, w ? 'w' + w : 'phone', found, views); } catch (e) { errs.push(String(e.message).split('\n')[0].slice(0, 100)); }
      if (SHOTS && (w === 390 || w === 1440 || !w)) await snap(p, `overlap-${c}-${w || 'phone'}`);
      if (t.errors.length) errs.push(t.errors[0]);
      await t.ctx.close();
    }
    const secs = [...new Set(found.map((f) => f.replace(/^.*· \w+ ([^:]+):.*$/, '$1')))];
    ok(`overlap ${c}: no text collides or is cut off (${views.n} views, widths ${widths.map((x) => x || 'phone').join('/')})`, found.length === 0, `${found.length} in ${secs.join(', ')}: ${found.slice(0, 3).join(' | ')}`);
    ok(`overlap ${c}: the walk-through ran without page errors`, errs.length === 0, errs[0]);
  }
  // the long case's liquidity chart, every best-find pool at every zoom level and both pan ends: the price pill, the
  // "parked" and "beyond" labels and the ticks never sit on each other
  const found = [];
  let views = 0;
  for (const o of DEVICE ? [{ phone: true }, { width: 1440 }] : [{ width: 360 }, { width: 390 }, { width: 1440 }]) {
    const t = await openUnlocked(browser, 'long', { ...o, height: 860, reducedMotion: 'reduce', storage: { 'lps.hint': '1' } }), p = t.page, tag = o.width ? 'w' + o.width : 'phone';
    for (const wk of ['24h', '30d']) {
      await setWin(p, wk);
      const n = await p.$$eval('#best [role="tab"]', (x) => x.length);
      for (let i = 0; i < n; i++) {
        await p.evaluate((i) => document.querySelectorAll('#best [role="tab"]')[i].click(), i); await sleep(40);
        for (const dir of [-1, 1]) {
          for (let z = 0; z < 5; z++) {
            for (const side of ['', 'l', 'r']) {
              if (side) for (let k = 0; k < 10 && (await p.evaluate((s) => { const e = document.querySelector(`[data-pz="liq-best"] > .pz-edge.${s}:not([hidden])`); if (!e) return false; e.click(); return true; }, side)); k++);
              views++;
              for (const x of await p.evaluate(TEXT_OVERLAP, { root: '[data-chartbox="liq-best"]' })) found.push(`${tag} ${wk} tab ${i} z${dir}${z}${side} · ${x.kind}: ${x.a} × ${x.b}`);
            }
            if (!(await p.evaluate((d) => { const b = document.querySelector(`[data-act="zoom"][data-chart="liq-best"][data-dir="${d}"]`); if (!b || b.disabled) return false; b.click(); return true; }, dir))) break;
          }
          await p.evaluate(() => { const b = document.querySelector('[data-act="zreset"][data-chart="liq-best"]'); if (b) b.click(); });
        }
      }
    }
    await t.ctx.close();
  }
  ok(`overlap: the liquidity chart's labels never collide, any pool, zoom or pan (${views} views of the long case)`, found.length === 0, `${found.length}: ${found.slice(0, 3).join(' | ')}`);
}

// ---------- 4k. touch: one finger drags, two fingers pinch and pan, as pointer events with pointerType 'touch' ----------
// The page sees what a phone sends (tools/gestures.mjs: pointerdown / move / up per finger, each with its own
// pointerId); WebKit in Actions runs these same events. What they can't show: that a real iPhone's Safari hands the
// gesture to the page at all (that rests on touch-action: pan-y, checked below, and on preventDefault of its touchmove
// and gesture events, also checked).
// a pinch on a chart: two fingers `d0` px apart around (fx, fy) of the host, spread by `k`, the middle moved by (mx, my)
async function pinch(page, id, k, { root = '', steps = 10, end = 'pointerup', ...o } = {}) {
  const b = await page.evaluate(HOST_BOX, { id, root });
  await sleep(60);
  return page.evaluate(FINGERS, { steps, end, pts: pinchPts(b, k, o) });
}
async function finger(page, id, dx, { dy = 0, fy = 0.5, steps = 10, ms = 16, end = 'pointerup', root = '' } = {}) {
  const b = await page.evaluate(HOST_BOX, { id, root });
  await sleep(60);
  const x0 = b.x + b.w / 2, y0 = b.y + b.h * fy;
  return page.evaluate(FINGERS, { steps, ms, end, pts: [{ id: 31, x0, y0, x1: x0 + dx, y1: y0 + dy }] });
}
const liqSpan = (page, id) => page.evaluate((id) => (document.querySelector(`[data-chartbox="${id}"] .pz-cap1`) || {}).textContent || '', id);
async function testTouch(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, storage: { 'lps.hint': '1' } }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const tas = await p.$$eval('.pz', (hs) => hs.map((h) => [h.classList.contains('pz-xy'), getComputedStyle(h).touchAction]));
    ok(`touch ${tag}: every chart surface leaves vertical swipes to the page and takes sideways drags and pinches (touch-action pan-y) (${tas.length})`, tas.length >= 3 && tas.every(([xy, ta]) => ta === (xy ? 'none' : 'pan-y')), JSON.stringify(tas.slice(0, 3)));
    // one finger
    let v0 = await pzView(p, 'liq-best');
    await finger(p, 'liq-best', -110, { steps: 12, ms: 30 }); await sleep(60);
    let v1 = await pzSettled(p, 'liq-best');
    ok(`touch ${tag}: a finger dragged left shows higher prices`, v1.c > v0.c + 0.05 && near(v1.w, v0.w), `${v0.c} → ${v1.c}`);
    await finger(p, 'liq-best', 8, { dy: 90 }); await sleep(60);
    ok(`touch ${tag}: a mostly vertical swipe leaves the chart alone (the page scrolls)`, near((await pzSettled(p, 'liq-best')).c, v1.c));
    // the page doesn't scroll under a chart being dragged; iOS's own pinch events never reach the page from a chart
    const blocked = await p.evaluate(async () => {
      const h = document.querySelector('[data-pz="liq-best"]'), r = h.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, el = document.elementFromPoint(x, y);
      const pe = (type, xx) => el.dispatchEvent(new PointerEvent(type, { pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: xx, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointerup' ? 0 : 1 }));
      const tm = () => document.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }));
      const before = tm(); // nothing dragged: a touchmove is left alone (the page scrolls)
      pe('pointerdown', x); for (let i = 1; i <= 4; i++) { pe('pointermove', x - i * 8); await new Promise((r2) => setTimeout(r2, 16)); }
      const during = tm(); pe('pointerup', x - 32);
      const g1 = h.dispatchEvent(new Event('gesturestart', { bubbles: true, cancelable: true })), g2 = h.dispatchEvent(new Event('gesturechange', { bubbles: true, cancelable: true }));
      const g3 = document.querySelector('#all h2').dispatchEvent(new Event('gesturestart', { bubbles: true, cancelable: true }));
      return { before, during, g1, g2, g3 };
    });
    ok(`touch ${tag}: while a chart is dragged its touchmoves are held (no page scroll), otherwise not`, blocked.before === true && blocked.during === false, JSON.stringify(blocked));
    ok(`touch ${tag}: Safari's pinch events (gesturestart / gesturechange) are stopped on charts only`, blocked.g1 === false && blocked.g2 === false && blocked.g3 === true, JSON.stringify(blocked));
    await pzSettled(p, 'liq-best');
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]'); await sleep(150);
    // a tap that catches a coasting chart (the way a phone stops a flick) leaves it at rest where it stopped: inside the
    // data, and the reset button shown since it is no longer on its default view (v0.4.3 stopped the coast and then left
    // the chart in the middle of it: no reset button, and past an end it stayed past it)
    const hc = await p.evaluate(HOST_BOX, { id: 'liq-best' }), cx = hc.x + hc.w / 2, cy = hc.y + hc.h / 2;
    let coasting = false;
    for (let k = 0; k < 3 && !coasting; k++) { // a busy machine can stretch the flick past the page's 100 ms speed window: then it doesn't coast, and the flick goes again
      if (k) { await pzSettled(p, 'liq-best'); await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]').catch(() => {}); await sleep(150); }
      await p.evaluate(FINGERS, { steps: 4, ms: 12, pts: [{ id: 61, x0: cx, y0: cy, x1: cx - 50, y1: cy }] });
      coasting = await p.evaluate(async () => { const v = () => document.querySelector('[data-pz="liq-best"]').dataset.view, a = v(); await new Promise((r) => requestAnimationFrame(() => r())); return v() !== a; }); // still moving: the tap below lands mid-coast
    }
    await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 62, x0: cx + 40, y0: cy, x1: cx + 40, y1: cy }] });
    const cv = await pzSettled(p, 'liq-best');
    const caught = await p.evaluate(() => { const P = document.querySelector('[data-chartbox="liq-best"]'); return { reset: !!P.querySelector('.ctools [data-act="zreset"]'), drag: !!P.querySelector('.dragging') }; });
    ok(`touch ${tag}: a tap that catches a coasting chart leaves it at rest, off its default view, with its reset button`, coasting && caught.reset && !caught.drag && cv.c > 0.02, JSON.stringify({ coasting, ...caught, c: cv.c }));
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]').catch(() => {}); await sleep(150);
    // two fingers: spread to zoom in around the point between them
    v0 = await pzView(p, 'liq-best');
    await pinch(p, 'liq-best', 2); await sleep(120);
    v1 = await pzSettled(p, 'liq-best');
    const cap1 = await liqSpan(p, 'liq-best');
    ok(`touch ${tag}: spreading two fingers zooms in (the view halves, the price stays in the middle)`, near(v1.w, v0.w / 2, 0.01) && near(v1.c, v0.c, 0.01) && /^±2[23]%$/.test(cap1), `${JSON.stringify(v0)} → ${JSON.stringify(v1)} ${cap1}`);
    ok(`touch ${tag}: …and the zoom buttons follow (reset shows, − and + both work)`, (await p.isVisible('[data-chartbox="liq-best"] [data-act="zreset"]')) && (await p.isEnabled('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]')) && (await p.isEnabled('[data-act="zoom"][data-chart="liq-best"][data-dir="1"]')));
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]'); await sleep(150);
    // off-centre: the price under the fingers' midpoint stays under it
    v0 = await pzView(p, 'liq-best');
    const want = v0.c - v0.w / 2 + 0.25 * v0.w, wantC = want + (0.5 - 0.25) * (v0.w / 2);
    await pinch(p, 'liq-best', 2, { fx: 0.25 }); await sleep(120);
    v1 = await pzSettled(p, 'liq-best');
    ok(`touch ${tag}: a pinch zooms around the point between the fingers, not the middle of the chart`, near(v1.w, v0.w / 2, 0.01) && near(v1.c, wantC, 0.012), `${v1.c} vs ${wantC}`);
    // both fingers moving together pan the zoomed chart
    v0 = v1;
    await pinch(p, 'liq-best', 1, { mx: 90 }); await sleep(120);
    v1 = await pzSettled(p, 'liq-best');
    ok(`touch ${tag}: two fingers moved together pan the chart (no zoom change)`, near(v1.w, v0.w, 0.005) && v1.c < v0.c - 0.03, `${JSON.stringify(v0)} → ${JSON.stringify(v1)}`);
    // pinching closed stops at the whole field (a wide field can take two pinches): all the data, no hatch, − disabled
    let rest = null;
    for (let k = 0; k < 3 && !(rest && rest.out); k++) {
      await pinch(p, 'liq-best', 0.2, { d0: 160 }); await sleep(120);
      v1 = await pzSettled(p, 'liq-best');
      rest = await p.evaluate(() => ({ hatch: document.querySelectorAll('[data-pz="liq-best"] .pz-end').length, out: document.querySelector('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]').disabled }));
    }
    const SPt = poolOf(await bestId(p)).shape.depthSpan, capT = await liqSpan(p, 'liq-best');
    ok(`touch ${tag}: pinched closed, the view stops at the whole field (${capT}): every bar, no hatch, − disabled`, near(v1.c, (SPt[0] + SPt[1]) / 2, 2e-3) && near(v1.w, SPt[1] - SPt[0], 2e-3) && rest.hatch === 0 && rest.out && /…/.test(capT), `${JSON.stringify(v1)} ${JSON.stringify(rest)} ${capT}`);
    // a double tap (two finger taps) resets
    const hb = await p.evaluate(() => { const r = document.querySelector('[data-pz="liq-best"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 70 }; });
    for (let k = 0; k < 2; k++) { await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 51 + k, x0: hb.x, y0: hb.y, x1: hb.x, y1: hb.y }] }); await sleep(90); }
    v1 = await pzSettled(p, 'liq-best');
    ok(`touch ${tag}: a double tap resets the chart`, near(v1.c, 0) && near(v1.w, 0.9), JSON.stringify(v1));
    // a cancelled touch (the browser took the gesture) ends the drag cleanly
    await finger(p, 'liq-best', 260, { end: 'pointercancel' }); await sleep(80);
    v1 = await pzSettled(p, 'liq-best');
    ok(`touch ${tag}: a cancelled drag ends cleanly and springs back inside the data`, !(await p.$('[data-pz="liq-best"].dragging')) && v1.c >= SPt[0] + 0.45 - 2e-3, JSON.stringify(v1));
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]').catch(() => {}); await sleep(120);
    // the daily strip: a pinch shows fewer, wider days; a finger drag shows older ones
    let dv = await pzView(p, 'daily-best');
    await pinch(p, 'daily-best', 2, { fx: 0.75 }); await sleep(120);
    let dv2 = await pzSettled(p, 'daily-best');
    ok(`touch ${tag}: a pinch on the daily strip shows fewer, wider days`, near(dv2.w, dv.w / 2, 0.6), `${dv.w} → ${dv2.w}`);
    dv = dv2;
    await finger(p, 'daily-best', 120, { steps: 12, ms: 30 }); await sleep(60);
    dv2 = await pzSettled(p, 'daily-best');
    ok(`touch ${tag}: a finger dragged right on the strip shows older days`, dv2.c < dv.c - 1, `${dv.c} → ${dv2.c}`);
    // the detail panel: its charts pinch too, and the panel stays open
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(350);
    v0 = await pzView(p, 'liq-detail');
    await pinch(p, 'liq-detail', 2, { root: '#sheet' }); await sleep(120);
    v1 = await pzSettled(p, 'liq-detail');
    await finger(p, 'liq-detail', -80, { root: '#sheet', steps: 12, ms: 30 }); await sleep(60);
    const v2 = await pzSettled(p, 'liq-detail');
    ok(`touch ${tag}: in the detail panel a pinch zooms and a finger drags the chart; the panel stays open`, near(v1.w, v0.w / 2, 0.01) && v2.c > v1.c + 0.02 && (await p.isVisible('#sheet')), `${v0.w}→${v1.w} ${v1.c}→${v2.c}`);
    await p.click('#sheet-close');
    // the scatter: a pinch zooms both axes, then it takes drags both ways
    await p.click('#bt-lead tr.row'); await sleep(900);
    await pinch(p, 'scatter', 2); await sleep(200);
    const sc = await p.evaluate(() => { const h = document.querySelector('[data-pz="scatter"]'); return { xy: h.classList.contains('pz-xy'), ta: getComputedStyle(h).touchAction, view: h.dataset.view }; });
    ok(`touch ${tag}: a pinch on the scatter zooms it; zoomed, it takes drags both ways (touch-action none)`, sc.xy && sc.ta === 'none' && sc.view.split(',').length === 3, JSON.stringify(sc));
    // a pop-out window: the same gestures
    const pool = await p.getAttribute('#best [data-act="detail"]', 'data-id');
    const w2 = await t.ctx.newPage();
    await w2.goto(url('default', `&view=liq-best&pool=${pool}&w=30d`));
    await w2.waitForSelector('.solo-box [data-pz="liq-best"]', { timeout: 20000 }); await sleep(300);
    const s0 = await pzView(w2, 'liq-best');
    await pinch(w2, 'liq-best', 2); await sleep(150);
    const s1 = await pzSettled(w2, 'liq-best');
    await finger(w2, 'liq-best', -100, { steps: 12, ms: 30 }); await sleep(60);
    const s2 = await pzSettled(w2, 'liq-best');
    ok(`touch ${tag}: in a chart's own window a pinch zooms and a finger drags`, near(s1.w, s0.w / 2, 0.01) && s2.c > s1.c + 0.02, `${JSON.stringify(s0)} ${JSON.stringify(s1)} ${JSON.stringify(s2)}`);
    await w2.close();
    ok(`touch ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // reduced motion: a pinch still zooms, nothing animates after it
  const r = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce', storage: { 'lps.hint': '1' } }), p = r.page;
  const v0 = await pzView(p, 'liq-best');
  await pinch(p, 'liq-best', 2); await sleep(60);
  ok('touch: under reduced motion a pinch zooms at once and nothing animates', near((await pzView(p, 'liq-best')).w, v0.w / 2, 0.01) && (await p.evaluate(() => document.getAnimations().length)) === 0);
  await r.ctx.close();
}

// ---------- 4l. the bar on top: one slim row; it slides away going down and comes back going up; the strip scrolls away ----------
const BAR = () => {
  const b = document.querySelector('#top'), r = b.getBoundingClientRect(), m = document.querySelector('#mstrip').getBoundingClientRect();
  const kids = [...b.children].filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).position !== 'absolute').map((e) => { const q = e.getBoundingClientRect(); return q.top + q.height / 2; });
  return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), hid: b.classList.contains('hid'), pos: getComputedStyle(b).position, oneRow: kids.length >= 3 && Math.max(...kids) - Math.min(...kids) <= 4, strip: Math.round(m.bottom), y: scrollY, anim: document.getAnimations().length };
};
async function testHeader(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['w360', { width: 360, height: 760 }], ['w768', { width: 768 }], ['laptop', { width: 1440 }], ['phone reduced', { phone: true, reducedMotion: 'reduce' }]]) {
    const t = await openUnlocked(browser, 'default', { ...o, storage: { 'lps.hint': '1' } }), p = t.page;
    let b = await p.evaluate(BAR);
    ok(`header ${tag}: the bar on top is one slim row (${b.h} px: mark, freshness, refresh, window), sticky`, b.oneRow && b.h >= 44 && b.h <= 52 && b.pos === 'sticky' && !b.hid && b.top >= 0 && b.top <= 30, JSON.stringify(b)); // under the MOCKUP ribbon
    if (SHOTS && !/reduced/.test(tag)) await snap(p, `header-${tag.replace(' ', '-')}-top`, 'body');
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, 900); });
    // the moment the page has acted on the scroll (the bar marked away), count what animates: under reduced motion, nothing
    await p.waitForFunction(() => document.querySelector('#top').classList.contains('hid'), null, { timeout: 5000 }).catch(() => {});
    const anim0 = await p.evaluate(() => document.getAnimations().filter((a) => a.playState !== 'finished' && a.playState !== 'idle').length);
    await calm(p, BAR_MOVES);
    b = await p.evaluate(BAR);
    ok(`header ${tag}: scrolling down slides the bar away${tag.startsWith('phone') || tag === 'w360' ? ' and the market strip scrolls off with the page' : ''}`, b.hid && b.bottom <= 0 && b.strip < 0, JSON.stringify(b));
    if (/reduced/.test(tag)) ok(`header ${tag}: under reduced motion it goes at once (nothing animates)`, anim0 === 0 && b.anim === 0, `${anim0} ${b.anim}`);
    await p.evaluate(() => scrollBy(0, -120)); await calm(p, BAR_MOVES);
    b = await p.evaluate(BAR);
    ok(`header ${tag}: a little scroll up brings it back`, !b.hid && b.top === 0 && b.bottom >= 44, JSON.stringify(b));
    // the All pools header copy docks right under the bar, never under it
    await p.evaluate(() => { const r = document.querySelector('#all-tbl tbody tr:nth-child(12)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 40); }); await calm(p, BAR_MOVES);
    await p.evaluate(() => scrollBy(0, -50)); await calm(p, BAR_MOVES);
    const d = await p.evaluate(() => { const bar = document.querySelector('#top').getBoundingClientRect(), sh = document.querySelector('#all .sh'), r = sh && sh.firstElementChild.getBoundingClientRect(), on = !!sh && sh.classList.contains('on'); const e = on ? document.elementFromPoint(r.left + 40, r.top + r.height / 2) : null; return { on, gap: on ? Math.round(r.top - bar.bottom) : null, mine: !!e && !!e.closest('.sh') }; });
    ok(`header ${tag}: with the bar back, the sticky table header docks right under it, not under it`, d.on && Math.abs(d.gap) <= 1 && d.mine, JSON.stringify(d));
    if (SHOTS && !/reduced/.test(tag)) await p.screenshot({ path: path.join(SHOTS, `header-${tag.replace(' ', '-')}-docked.png`) });
    // the keyboard brings the bar back
    await p.evaluate(() => scrollBy(0, 400)); await calm(p, BAR_MOVES);
    const hid = (await p.evaluate(BAR)).hid;
    await p.evaluate(() => document.querySelector('#refresh').focus()); await calm(p, BAR_MOVES);
    ok(`header ${tag}: focusing a control in the hidden bar brings it back`, hid && !(await p.evaluate(BAR)).hid);
    await p.evaluate(() => scrollTo(0, 0)); await calm(p, BAR_MOVES);
    b = await p.evaluate(BAR);
    ok(`header ${tag}: at the top it shows, flat (no shadow)`, !b.hid && b.top >= 0 && !(await p.$eval('#top', (e) => e.classList.contains('stuck'))));
    ok(`header ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// press a control once it has stopped moving: scrolled to the middle (the first one on screen), then the same over two
// drawn frames with nothing sliding around it. A scroll folds the panel's top or slides the bar a frame or two later,
// and a note whose word has left the screen closes itself: a word pressed mid-scroll had its note shut by the scroll's
// late frame, and the next Esc closed the panel instead. Returns whether there was one to press.
const TAP_STILL = async ({ sel, ms = 3000 }) => {
  const el = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length);
  if (!el) return false;
  window.dispatchEvent(new WheelEvent('wheel'));
  el.scrollIntoView({ block: 'center' });
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const box = () => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const sliding = () => document.getAnimations().some((x) => x.playState !== 'finished' && x.playState !== 'idle' && x.effect && Number.isFinite(x.effect.getComputedTiming().endTime) && x.effect.target && x.effect.target.contains && (x.effect.target.contains(el) || x.effect.target.id === 'top'));
  let a = box(), same = 0;
  for (const t0 = performance.now(); performance.now() - t0 < ms && (same < 2 || sliding());) {
    await frame();
    const b = box();
    if (b.every((v, i) => Math.abs(v - a[i]) < 0.5)) same++; else { same = 0; a = b; }
  }
  el.click();
  return true;
};
const SHEET_MOVES = ['#sheet', '#sheet .sheet-card', '#sheet .sheet-head', '#sheet .sheet-scrim', '.sh'];
// ---------- 4m. info notes: one glossary, a small note for each explainable word ----------
const POP = () => { const e = document.querySelector('#pop'), r = e.getBoundingClientRect(), bar = document.querySelector('#top'), bb = bar.classList.contains('hid') ? 0 : bar.getBoundingClientRect().bottom, inSheet = !document.querySelector('#sheet').hidden;
  return { on: !e.hidden, t: e.innerText, lbl: !!e.querySelector('.lbl'), gl: (e.querySelector('.gl') || {}).textContent || '', inside: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight + 1 && r.top >= (inSheet ? 0 : bb) - 1, top: Math.round(r.top), bb: Math.round(bb) }; };
async function testTerms(browser) {
  const HOOK = 'A hook is extra code attached to a Uniswap v4 pool. It can change fees or move tokens; unverified hooks are a risk.';
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, storage: { 'lps.hint': '1' } }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const press = (sel) => p.evaluate(TAP_STILL, { sel });
    const keys = () => p.evaluate((root) => [...new Set([...document.querySelectorAll(`${root} [data-act="term"]`)].filter((b) => b.getClientRects().length).map((b) => b.dataset.term))], phone ? '#best' : '#best');
    const best = await keys();
    ok(`terms ${tag}: the best find explains its fee tier, chain, version, range, gem, net APR, LVR and chips`, ['fee', 'v3', 'range', 'gem', 'net', 'lvr', 'edge', 'sigma', 'room', 'stop'].every((k) => best.includes(k)) && (best.includes('base') || best.includes('ethereum')), best.join(','));
    // the hook, in plain words
    await p.evaluate(() => [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.querySelector('.tn').textContent === 'TALI/WETH').click()); await sleep(150);
    await press('#best .tags [data-term="hook"]');
    let a = await p.evaluate(POP);
    ok(`terms ${tag}: tapping "hook" opens a small note: "${HOOK.slice(0, 40)}…"`, a.on && a.gl === HOOK && a.inside, JSON.stringify(a).slice(0, 140));
    ok(`terms ${tag}: …the word shows it is open (aria-expanded)`, (await p.getAttribute('#best .tags [data-term="hook"]', 'aria-expanded')) === 'true');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `terms-hook-${tag}.png`) });
    await press('#best .tags [data-term="hook"]');
    ok(`terms ${tag}: a second tap closes it`, !(await p.evaluate(POP)).on && (await p.getAttribute('#best .tags [data-term="hook"]', 'aria-expanded')) === 'false');
    await press('#best .tags [data-term="hook"]');
    await p.evaluate(() => document.querySelector('#all h2').click()); await sleep(120);
    ok(`terms ${tag}: a tap elsewhere closes it`, !(await p.evaluate(POP)).on);
    await p.focus('#best .tags [data-term="hook"]'); await p.keyboard.press('Enter'); await sleep(120);
    const kb = (await p.evaluate(POP)).on;
    await p.keyboard.press('Escape'); await sleep(120);
    ok(`terms ${tag}: the keyboard opens it (Enter) and Esc closes it, the focus back on the word`, kb && !(await p.evaluate(POP)).on && (await p.evaluate(() => document.activeElement && document.activeElement.dataset.term)) === 'hook');
    // every explainable word on the card and in the panel: a label and a plain sentence, on screen, below the bar
    const bad = [];
    let n = 0;
    const each = async (root) => {
      for (const k of await p.evaluate((root) => [...new Set([...document.querySelectorAll(`${root} [data-act="term"]`)].filter((b) => b.getClientRects().length).map((b) => b.dataset.term))], root)) {
        // (the panel's top folds while its content scrolls: a word up there is pressed with the content back at the top)
        const sel = `${root} [data-act="term"][data-term="${k}"]`;
        n++;
        if (!(await p.evaluate(TAP_STILL, { sel }))) {
          await p.evaluate(() => { const sb = document.querySelector('#sheet-body'); if (sb) sb.scrollTop = 0; });
          await calm(p, SHEET_MOVES);
          await p.evaluate(TAP_STILL, { sel });
        }
        const q = await p.evaluate(POP);
        if (!q.on || !q.lbl || q.gl.length < 25 || !q.inside) bad.push(`${k} ${JSON.stringify(q).slice(0, 60)}`);
        if (q.on) { await p.keyboard.press('Escape'); await sleep(60); }
      }
    };
    await each('#best'); await each('#subhead'); await each('#health');
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
    await each('#sheet');
    ok(`terms ${tag}: every explainable word opens its note: a name and a plain sentence, inside the screen, never under the bar (${n} kinds)`, bad.length === 0 && n >= 30, bad.slice(0, 3).join(' | '));
    // the similar pools' reasons
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 0; }); await calm(p, SHEET_MOVES);
    await p.evaluate(TAP_STILL, { sel: '#sim .mc-relb' });
    const k0 = await p.evaluate(() => document.querySelector('#sim .mc-v .k').textContent);
    a = await p.evaluate(POP);
    ok(`terms ${tag}: a similar pool's reason ("this pool", "same pair"…) explains itself, without switching the cards' figure`, a.on && /this pool|same pair|tier \+ token|same tier|shared token|unverified/i.test(a.t) && k0 === (await p.evaluate(() => document.querySelector('#sim .mc-v .k').textContent)), a.t.slice(0, 60));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `terms-sim-${tag}.png`) });
    await p.keyboard.press('Escape'); await sleep(80);
    // one glossary: the same word gives the same note everywhere (Esc only puts an open note away: with none open it
    // closes the panel)
    await press('#sheet [data-term="net"]');
    const g1 = await p.evaluate(POP), n1 = g1.gl;
    if (g1.on) await p.keyboard.press('Escape');
    await p.click('#sheet-close'); await calm(p, SHEET_MOVES);
    await press('#best [data-term="net"]');
    ok(`terms ${tag}: one glossary: "net APR" reads the same in the card and the panel`, n1.length > 20 && n1 === (await p.evaluate(POP)).gl);
    await p.keyboard.press('Escape');
    // a note near the top of the screen stays below the bar
    await p.evaluate(() => { const b = document.querySelector('#best .best-meta [data-term="fee"]'); scrollTo(0, scrollY + b.getBoundingClientRect().top - 400); }); await calm(p, BAR_MOVES);
    await p.evaluate(() => scrollBy(0, -40)); await calm(p, BAR_MOVES);
    await p.evaluate(() => { const b = document.querySelector('#best .best-meta [data-term="fee"]'); scrollTo(0, scrollY + b.getBoundingClientRect().top - document.querySelector('#top').getBoundingClientRect().bottom - 4); }); await calm(p, BAR_MOVES);
    await p.evaluate(() => document.querySelector('#best .best-meta [data-term="fee"]').click()); await frames(p, 1);
    a = await p.evaluate(POP);
    ok(`terms ${tag}: a note opened right under the bar sits below it, inside the screen`, a.on && a.inside, JSON.stringify(a).slice(0, 120));
    await p.keyboard.press('Escape');
    // the gas gauge and the watchdog
    await press('#gas');
    ok(`terms ${tag}: the gas gauge's note starts with what gas is`, /^Ethereum gas · next block\s*What Ethereum charges to run a transaction/i.test((await p.evaluate(POP)).t), (await p.evaluate(POP)).t.slice(0, 60));
    await p.keyboard.press('Escape');
    const wd = await p.evaluate(() => { const dt = [...document.querySelectorAll('#health dt')].find((x) => /Watchdog/.test(x.textContent)); return dt ? [dt.textContent, dt.nextElementSibling.textContent] : null; });
    ok(`terms ${tag}: health says "Watchdog last restart" with a time, and explains it`, wd && wd[0] === 'Watchdog last restart' && /^\d\d:\d\d$|^\d+ \w+ \d\d:\d\d$/.test(wd[1]), JSON.stringify(wd));
    ok(`terms ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  const m = await openUnlocked(browser, 'nomarket', { phone: true });
  const wd = await m.page.evaluate(() => { const dt = [...document.querySelectorAll('#health dt')].find((x) => /Watchdog/.test(x.textContent)); return dt ? dt.nextElementSibling.textContent : null; });
  ok('terms: a watchdog that never restarted the loop shows —, never a time or 0', wd === '—', wd);
  await m.ctx.close();
}

// ---------- 4n. the detail panel's top folds while its content scrolls down, and opens again on the way up ----------
const FOLD = () => { const c = document.querySelector('#sheet .sheet-card'), h = document.querySelector('#sheet .sheet-head'); return { cond: c.classList.contains('cond'), h: Math.round(h.getBoundingClientRect().height), sim: !document.querySelector('#sim').hidden && document.querySelector('#sim').getBoundingClientRect().height > 0, st: document.querySelector('#sheet-body').scrollTop, anim: document.getAnimations().length }; };
async function testFold(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['laptop', { width: 1440 }], ['phone reduced', { phone: true, reducedMotion: 'reduce' }]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(400);
    const f0 = await p.evaluate(FOLD);
    for (const y of [80, 200, 400]) { await p.evaluate((y) => { document.querySelector('#sheet-body').scrollTop = y; }, y); await sleep(120); }
    await sleep(300);
    const f1 = await p.evaluate(FOLD);
    ok(`fold ${tag}: scrolling the panel's content down folds its top (${f0.h} → ${f1.h} px; the similar pools tuck away)`, f0.sim && !f0.cond && f1.cond && !f1.sim && f1.h < f0.h - 60, JSON.stringify([f0, f1]));
    if (/reduced/.test(tag)) ok(`fold ${tag}: under reduced motion it folds without sliding`, f1.anim === 0, String(f1.anim));
    if (SHOTS && tag === 'phone') await p.screenshot({ path: path.join(SHOTS, 'fold-phone-folded.png') });
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop -= 30; }); await sleep(80);
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop -= 30; }); await sleep(380);
    const f2 = await p.evaluate(FOLD);
    ok(`fold ${tag}: a scroll back up opens it again`, !f2.cond && f2.sim, JSON.stringify(f2));
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 600; }); await sleep(420);
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 0; }); await sleep(380);
    ok(`fold ${tag}: back at the top it is open`, !(await p.evaluate(FOLD)).cond);
    // a short panel (the pair view) never folds back and forth
    await p.click('#sheet-close'); await sleep(120);
    await p.evaluate(() => document.querySelector('#best h2 button[data-act="pair"]').click()); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    const flips = await p.evaluate(async () => { let n = 0; const mo = new MutationObserver(() => n++); mo.observe(document.querySelector('#sheet .sheet-card'), { attributes: true, attributeFilter: ['class'] }); const b = document.querySelector('#sheet-body'); for (let i = 0; i < 12; i++) { b.scrollTop = i % 2 ? b.scrollHeight : b.scrollHeight - 30; await new Promise((r) => setTimeout(r, 60)); } await new Promise((r) => setTimeout(r, 400)); mo.disconnect(); return n; });
    ok(`fold ${tag}: a short panel never flips between folded and open`, flips <= 2, String(flips));
    ok(`fold ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 5. click audit: press every control, check the DOM answered ----------
const SIG = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '') + (el.dataset.chart ? ':' + el.dataset.chart : '') + (el.dataset.dir ? ':' + el.dataset.dir : '');
async function controls(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; };
    const all = [...document.querySelectorAll('button, select, input, [tabindex="0"], a[href]')].filter(vis);
    const sig = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '') + (el.dataset.chart ? ':' + el.dataset.chart : '') + (el.dataset.dir ? ':' + el.dataset.dir : '');
    return { untagged: all.filter((el) => !el.dataset.act && !el.disabled).map((el) => el.outerHTML.slice(0, 60)), sigs: [...new Set(all.filter((el) => el.dataset.act && !el.disabled).map(sig))], disabled: all.filter((el) => el.disabled).map((el) => el.textContent.trim()) };
  });
}
async function press(page, sig) {
  // beat scroll-settle races: a wheel event first, then bring the control into view
  return page.evaluate((sig) => {
    const sigOf = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '') + (el.dataset.chart ? ':' + el.dataset.chart : '') + (el.dataset.dir ? ':' + el.dataset.dir : '');
    const el = [...document.querySelectorAll('[data-act]')].find((e) => sigOf(e) === sig && !e.disabled && !e.closest('svg') && e.getBoundingClientRect().width > 0 && e.offsetParent !== null); // a chart's tap line: its legend button is pressed instead
    if (!el) return false;
    window.dispatchEvent(new WheelEvent('wheel'));
    el.scrollIntoView({ block: 'center' });
    window.__mut = 0;
    if (!window.__mo) { window.__mo = new MutationObserver((m) => { window.__mut += m.length; }); window.__mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); }
    window.__y = scrollY;
    return true;
  }, sig);
}
async function headingInView(page, sel) {
  return page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top >= -2 && r.top <= innerHeight * 0.4; }, sel);
}
async function testClicks(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 });
    const tag = phone ? 'phone' : 'laptop', p = t.page;
    const first = await controls(p);
    ok(`clicks ${tag}: every control is wired (data-act)`, first.untagged.length === 0, first.untagged[0]);
    ok(`clicks ${tag}: the phase buttons are disabled and labelled`, first.disabled.includes('Paper-trade · Phase 1') && first.disabled.includes('Propose live · Phase 2'));
    const done = new Set(), bad = [];
    const queue = [...first.sigs];
    while (queue.length) {
      const sig = queue.shift();
      if (done.has(sig) || /^(lock|retry|lock-retry|pass|unlock)$/.test(sig)) continue;
      if (sig === 'refresh') await sleep(1600); // the button ignores taps within 1.5 s of the last // lock is a danger control: tested on its own
      done.add(sig);
      const real = sig.replace(/~2$/, ''); // "~2": the same control pressed a second time
      if (!(await press(p, real))) { if (!/^pan:/.test(sig)) bad.push(sig + ' not found'); continue; } // an edge button shows only while there is more that way: testPan presses them
      const act = real.split(':')[0];
      const handle = await p.evaluateHandle((sig) => [...document.querySelectorAll('[data-act]')].find((e) => (e.dataset.act + (e.dataset.w ? ':' + e.dataset.w : '') + (e.dataset.k ? ':' + e.dataset.k : '') + (e.dataset.to ? ':' + e.dataset.to : '') + (e.dataset.chart ? ':' + e.dataset.chart : '') + (e.dataset.dir ? ':' + e.dataset.dir : '')) === sig && !e.disabled && !e.closest('svg') && e.offsetParent !== null), real);
      if (act === 'lens' || act === 'chain') {
        const v = await handle.evaluate((s) => s.options[Math.min(1, s.options.length - 1)].value);
        await handle.asElement().selectOption(v);
      } else if (act === 'search') await handle.asElement().fill('VEL');
      else if (act === 'scrub') await handle.evaluate((s) => { s.value = String(Math.max(1, Math.floor(+s.max / 2))); s.dispatchEvent(new Event('input', { bubbles: true })); });
      else { try { await handle.asElement().click({ timeout: 5000 }); } catch (er) { bad.push(sig + ' not clickable'); continue; } }
      await sleep(act === 'jump' || act === 'bt-row' ? 1400 : act === 'play' ? 800 : 350);
      const mut = await p.evaluate(() => window.__mut);
      let good = mut > 0;
      if (act === 'jump') good = await headingInView(p, real.split(':')[1]);
      if (act === 'openchart') {
        const u = await p.evaluate(() => (window.__opened || []).slice(-1)[0] || '');
        const want = real.split(':')[1];
        good = new RegExp(`[?&]view=${want}(&|$)`).test(u) && /[?&]w=(24h|7d|30d)/.test(u) && /[?&]z=\d/.test(u) && (['scatter', 'health'].includes(want) || /[?&]pool=[0-9a-fx]+/.test(u));
      }
      if (act === 'ext') good = /^https:\/\/(etherscan\.io|basescan\.org|app\.uniswap\.org)\//.test(await p.evaluate(() => (window.__opened || []).slice(-1)[0] || ''));
      if (act === 'why' || act === 'gas' || act === 'term') { good = await p.isVisible('#pop'); await p.keyboard.press('Escape'); await sleep(100); }
      if (act === 'fav') good = good && (await p.$$('#fav .mc')).length > 0;
      if (act === 'detail' || act === 'pair' || act === 'flash-open') { good = await p.isVisible('#sheet'); if (good) { done.add('close-detail'); await p.click('#sheet-close'); await sleep(200); good = !(await p.isVisible('#sheet')); } }
      if (act === 'bt-row') good = (await p.isVisible('#bt-replay')) && (await headingInView(p, '#bt-replay'));
      if (act === 'bt-close') good = !(await p.isVisible('#bt-replay'));
      if (act === 'win') good = good && (await p.getAttribute(`#winseg [data-w="${real.split(':')[1]}"]`, 'aria-pressed')) === 'true';
      if (act === 'sort') good = good && (await p.$$('#all-tbl thead th[aria-sort="ascending"], #all-tbl thead th[aria-sort="descending"]')).length === 1;
      if (!good) bad.push(sig);
      // put filters back so later controls see the full table
      if (act === 'lens' || act === 'chain') { await handle.asElement().selectOption('all'); await sleep(150); }
      if (act === 'search') { await handle.asElement().fill(''); await sleep(250); }
      if (act === 'play') { await sleep(200); }
      for (const s of (await controls(p)).sigs) if (!done.has(s) && !queue.includes(s)) queue.push(s);
      if (act === 'bt-row' && !done.has('play')) queue.unshift('play', 'scrub', 'zoom:liq-replay:-1', 'zoom:liq-replay:1', 'openchart:liq-replay', 'zoom:rp:1', 'openchart:rp', 'zoom:rp-money:1', 'openchart:rp-money', 'bt-close');
      if (act === 'zoom' && real.endsWith(':1') && !sig.endsWith('~2')) { const c = real.split(':')[1]; queue.unshift(`zreset:${c}`, `zoom:${c}:1~2`, `zoom:${c}:-1`); }
      if (act === 'zoom') { const c = real.split(':')[1]; if (!done.has(`zreset:${c}`) && (await p.$(`[data-act="zreset"][data-chart="${c}"]`))) queue.unshift(`zreset:${c}`); }
    }
    ok(`clicks ${tag}: ${done.size} kinds of control pressed, each answered`, bad.length === 0 && done.size >= 25, bad.join(', ') + ` (${done.size} kinds)`);
    ok(`clicks ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 6. reduced motion: the replay jumps to the end instead of playing ----------
async function testMotion(browser) {
  const t = await openUnlocked(browser, 'default', { phone: true, reducedMotion: 'reduce' });
  await t.page.click('#bt-lead tr.row');
  await sleep(400);
  await t.page.evaluate(() => { const s = document.querySelector('#rp-scrub'); s.value = '3'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await t.page.click('#rp-play');
  await sleep(120);
  const v = await t.page.evaluate(() => { const s = document.querySelector('#rp-scrub'); return [+s.value, +s.max]; });
  ok('motion: reduced motion shows the end at once', v[0] === v[1], v.join('/'));
  await t.ctx.close();
  const m = await openUnlocked(browser, 'default', { phone: true });
  await m.page.click('#bt-lead tr.row');
  await sleep(400);
  await m.page.evaluate(() => { const s = document.querySelector('#rp-scrub'); s.value = '1'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await m.page.evaluate(() => { window.__keepBtns = [...document.querySelectorAll('#bt-replay .openwin, #bt-replay [data-act="zoom"], #rp-mleg button')]; });
  await m.page.click('#rp-play');
  await sleep(900);
  const w = await m.page.evaluate(() => { const s = document.querySelector('#rp-scrub'); return [+s.value, +s.max]; });
  ok('motion: otherwise the replay plays as a time-lapse', w[0] > 1 && w[0] < w[1], w.join('/'));
  const kept = await m.page.evaluate(() => window.__keepBtns.length > 6 && window.__keepBtns.every((b) => b.isConnected));
  ok('motion: while it plays, the replay\'s buttons stay put (a press mid-play lands)', kept);
  await m.ctx.close();
}


// ---------- the pair's other pools stacked in the detail's liquidity chart (v0.4.2, owner's pick 1A) ----------
// An independent model of what the page should stack: every pool's bars on its own edges (offsets from its own price), turned
// to the open pool's token order, shared onto the open pool's edges by overlap, then drawn on one scale for the stack's totals.
const symNx = (s) => (String(s).toUpperCase() === 'ETH' ? 'WETH' : String(s).toUpperCase());
const pairOfFx = (p) => [p.t0.sym, p.t1.sym].map(symNx);
const samePairFx = (a, b) => a.pairKey === b.pairKey || pairOfFx(a).slice().sort().join('/') === pairOfFx(b).slice().sort().join('/');
// the detail chart's ghost (v0.4.5): every pool of the pair onto the open pool's edges, summed bar by bar (unknown where any
// bar wasn't read); the scale takes the ghost's tallest bar in view, but never more than 4× this pool's own tallest
function ontoFx(base, q, shift = 0) {
  const E = base.shape.depthEdges, tg = base.shape.depth.map(([, v], i) => ({ a: E[i], b: E[i + 1], v }));
  const flip = pairOfFx(q)[0] === pairOfFx(base)[1] && pairOfFx(q)[1] === pairOfFx(base)[0];
  let src = q.shape.depth.map(([, v], i) => ({ a: q.shape.depthEdges[i] + shift, b: q.shape.depthEdges[i + 1] + shift, v }));
  if (flip) src = src.map((x) => ({ a: -x.b, b: -x.a, v: x.v })).reverse();
  return tg.map((t) => { let v = 0; for (const x of src) { const ov = Math.min(t.b, x.b) - Math.max(t.a, x.a); if (ov > 1e-12) { if (x.v == null) return null; v += (x.v * ov) / (x.b - x.a); } } return v; });
}
function ghostOf(base) {
  const peers = FXD.live.pools.filter((q) => q.id !== base.id && samePairFx(base, q) && q.shape.depth.some((d) => d[1] != null));
  if (!peers.length) return null;
  const L = peers.map((q) => ontoFx(base, q));
  return base.shape.depth.map(([, v], i) => (v != null && L.every((l) => l[i] != null) ? v + L.reduce((s, l) => s + l[i], 0) : null));
}
function ghostCap(base, view) {
  const g = ghostOf(base);
  if (!g) return 0;
  const sh = base.shape, E = sh.depthEdges, step = sh.depthStep.fine, [v0, v1] = view, inV = (i) => E[i + 1] > v0 && E[i] < v1, dn = (v, i) => (v * step) / (E[i + 1] - E[i]);
  const own = Math.max(1, ...sh.depth.map(([, v], i) => (inV(i) && v != null ? dn(v, i) : 0)));
  const gw = Math.max(0, ...g.map((v, i) => (inV(i) && v != null ? dn(v, i) : 0)));
  return Math.min(gw, 4 * own);
}
function mgModel(base, layers, view, shift = 0) { // layers: pools in stack order; shift: a planted misalignment (log units)
  const sh = base.shape, E = sh.depthEdges, step = sh.depthStep.fine, [v0, v1] = view, X = (o) => ((o - v0) / (v1 - v0)) * 480;
  const tg = sh.depth.map(([, v], i) => ({ a: E[i], b: E[i + 1], v }));
  const onto = (q) => {
    const flip = pairOfFx(q)[0] === pairOfFx(base)[1] && pairOfFx(q)[1] === pairOfFx(base)[0];
    let src = q.shape.depth.map(([, v], i) => ({ a: q.shape.depthEdges[i] + shift, b: q.shape.depthEdges[i + 1] + shift, v }));
    if (flip) src = src.map((x) => ({ a: -x.b, b: -x.a, v: x.v })).reverse();
    return tg.map((t) => { let v = 0; for (const x of src) { const ov = Math.min(t.b, x.b) - Math.max(t.a, x.a); if (ov > 1e-12) { if (x.v == null) return null; v += (x.v * ov) / (x.b - x.a); } } return v; });
  };
  const L = layers.map(onto), inV = (t) => t.b > v0 && t.a < v1;
  const max = Math.max(1, ...tg.map((t, i) => (inV(t) ? (((t.v ?? 0) + L.reduce((s, l) => s + (l[i] ?? 0), 0)) * step) / (t.b - t.a) : 0)), ghostCap(base, view));
  const at0 = [base, ...layers].reduce((s, q) => s + (q.shape.fullRangeUsd > 0 ? q.shape.fullRangeUsd / eInt(...(q.shape.fullRangeSpan || [-Infinity, Infinity])) : 0), 0);
  const hb = at0 > 0 ? Math.min(12, Math.max(2, ((at0 * step) / max) * 116)) : 0, H = 116 - hb;
  const top = tg.map(() => 120 - hb), segs = { base: [], layers: L.map(() => []) };
  tg.forEach((t, i) => { if (!inV(t) || !(t.v > 0)) return; const h = Math.max(1.5, ((t.v * step) / (t.b - t.a) / max) * H), full = X(t.b) - X(t.a), g = Math.min(2, full * 0.2); segs.base.push({ x: X(t.a) + g / 2, y: top[i], w: Math.max(1, full - g), h }); top[i] -= h; });
  L.forEach((l, k) => tg.forEach((t, i) => { if (!inV(t) || !(l[i] > 0)) return; const h = ((l[i] * step) / (t.b - t.a) / max) * H; if (h < 0.05) return; const full = X(t.b) - X(t.a), g = Math.min(2, full * 0.2); segs.layers[k].push({ x: X(t.a) + g / 2, y: top[i], w: Math.max(1, full - g), h }); top[i] -= h; }));
  return segs;
}
const MG_LOOK = (id) => {
  const h = document.querySelector(`[data-pz="${id}"]`), box = h.closest('[data-chartbox]'), seg = (d) => [...String(d).matchAll(/M(-?[\d.]+) (-?[\d.]+)v(-?[\d.]+)h([\d.]+)v/g)].map((m) => ({ x: +m[1], y: +m[2], h: -m[3], w: +m[4] }));
  return { view: h.dataset.view, chips: [...box.querySelectorAll('[data-act="merge"]')].map((b) => ({ id: b.dataset.id, on: b.getAttribute('aria-pressed') === 'true', txt: b.textContent, chain: !!b.querySelector('.cg') })),
    base: seg([...h.querySelectorAll('.pz-c svg path:not(.mg)')].map((x) => x.getAttribute('d')).join('')),
    layers: [...h.querySelectorAll('.pz-c svg path.mg')].map((x) => ({ id: x.dataset.pid, segs: seg(x.getAttribute('d')) })),
    line: (box.querySelector('.mgline') || {}).textContent || '', unread: h.querySelectorAll('rect.mg-nr').length };
};
function segsMatch(got, want) {
  const bad = [];
  if (got.length !== want.length) bad.push(`${got.length}/${want.length} segments`);
  for (const e of want) { const g = got.find((b) => Math.abs(b.x - e.x) < 0.16); if (!g || Math.abs(g.h - e.h) > 0.16 || Math.abs(g.y - e.y) > 0.16 || Math.abs(g.w - e.w) > 0.16) bad.push(`x ${e.x.toFixed(1)} h ${e.h.toFixed(2)} y ${e.y.toFixed(1)} got ${g ? `h ${g.h} y ${g.y}` : 'none'}`); }
  return { ok: !bad.length, why: bad.slice(0, 2).join(' | ') };
}
function stackOk(a) { // every segment starts where the one under it ends: the stack's height is the sum of its parts
  const all = [...a.base, ...a.layers.flatMap((l) => l.segs)], byX = new Map();
  for (const s of all) { const k = s.x.toFixed(1); (byX.get(k) || byX.set(k, []).get(k)).push(s); }
  let bad = 0, n = 0;
  for (const col of byX.values()) { col.sort((p, q) => q.y - p.y); for (let i = 1; i < col.length; i++) { n++; if (Math.abs(col[i].y - (col[i - 1].y - col[i - 1].h)) > 0.16) bad++; } }
  return { ok: bad === 0 && n > 0, why: `${bad} of ${n} joins off` };
}
async function testMerge(browser) {
  const pools = FXD.live.pools;
  // the pair with the most pools: VELNA/WETH (two tiers on Base, a v4 pool in native ETH, and Ethereum)
  const base = pools.find((q) => q.pair === 'VELNA/WETH' && q.chain === 'ethereum'), peers = pools.filter((q) => q.id !== base.id && samePairFx(base, q));
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop', ID = 'liq-detail';
    await openPool(p, base.id.slice(0, 10));
    const look = () => p.evaluate(MG_LOOK, ID), tap = async (qid) => { await p.evaluate((qid) => document.querySelector(`#sheet-body [data-act="merge"][data-id="${qid}"]`).click(), qid); await sleep(200); };
    let a = await look();
    ok(`merge ${tag}: a chip for each other pool of the pair (${a.chips.length}: other tiers, v4 and another chain), each with its chain mark, all off by default`, a.chips.length === peers.length && peers.length >= 3 && a.chips.every((c) => !c.on && c.chain) && new Set(a.chips.map((c) => c.id)).size === peers.length && a.chips.some((c) => pools.find((q) => q.id === c.id).chain !== base.chain), JSON.stringify(a.chips.map((c) => c.txt)));
    ok(`merge ${tag}: by default the chart is this pool only, and the ±9% line names this pool alone`, a.layers.length === 0 && /Within ±9%/.test(a.line) && /this/.test(a.line) && !/total/.test(a.line), a.line);
    const order = a.chips.map((c) => pools.find((q) => q.id === c.id)), q1 = order[0], q2 = order[order.length - 1];
    await tap(q1.id);
    a = await look();
    let want = mgModel(base, [q1], viewOf(a)), m = segsMatch(a.layers[0] ? a.layers[0].segs : [], want.layers[0]);
    ok(`merge ${tag}: a tap stacks that pool (${q1.chain} ${q1.feeTier * 100}% v${q1.v}) in its own colour, each bar on its own log offset (${want.layers[0].length} segments)`, a.chips[0].on && a.layers.length === 1 && a.layers[0].id === q1.id && m.ok, m.why);
    m = segsMatch(a.base, want.base);
    ok(`merge ${tag}: …this pool's bars rescale under the stack (one scale for the totals)`, m.ok, m.why);
    let st = stackOk(a);
    ok(`merge ${tag}: …every stacked segment sits on top of the bar under it: the stack is the sum of its parts`, st.ok, st.why);
    // planted fault: the same pool one fine bar off its edges must not pass the comparison
    const bad = segsMatch(a.layers[0].segs, mgModel(base, [q1], viewOf(a), 0.01875).layers[0]);
    ok(`merge ${tag}: planted: a stack misaligned by one bar is caught`, !bad.ok, 'the shifted model matched');
    await tap(q2.id);
    a = await look();
    want = mgModel(base, [q1, q2], viewOf(a));
    const m1 = segsMatch(a.layers.find((l) => l.id === q1.id).segs, want.layers[0]), m2 = segsMatch((a.layers.find((l) => l.id === q2.id) || { segs: [] }).segs, want.layers[1]);
    st = stackOk(a);
    ok(`merge ${tag}: a second chip stacks a third pool on top (any number at once), still the sum of its parts`, a.layers.length === 2 && m1.ok && m2.ok && st.ok, m1.why || m2.why || st.why);
    // the ±9% line: one share per pool, adding up to 100%, and a total
    const parts = a.line.replace(/^Within ±9%: /, '').split(' · ').filter((x) => /%$/.test(x.trim())).map((x) => +x.trim().match(/([\d.]+)%$/)[1]);
    ok(`merge ${tag}: …the line under the chart gives each pool's share of the value within ±9% (${parts.join(' + ')}) and the total`, parts.length === 3 && Math.abs(parts.reduce((s, x) => s + x, 0) - 100) <= 1.5 && /total \$[\d.]+[KMB]?/.test(a.line), a.line);
    // pan and zoom with the stack on: zoom out to the whole field, then drag; the stack follows
    await zoomAllOut(p, ID, '#sheet-body');
    a = await look(); want = mgModel(base, [q1, q2], viewOf(a));
    const z1 = segsMatch(a.layers.find((l) => l.id === q1.id).segs, want.layers[0]), z0 = segsMatch(a.base, want.base);
    ok(`merge ${tag}: zoomed out to the whole field the stack is still aligned bar for bar`, z1.ok && z0.ok && stackOk(a).ok, z1.why || z0.why);
    await pzClick(p, `#sheet-body [data-act="zoom"][data-chart="${ID}"][data-dir="1"]`); await sleep(150);
    await pzClick(p, `#sheet-body [data-act="zoom"][data-chart="${ID}"][data-dir="1"]`); await sleep(150);
    await pzDrag(p, ID, 120); await pzSettled(p, ID);
    a = await look(); want = mgModel(base, [q1, q2], viewOf(a));
    const d1 = segsMatch(a.layers.find((l) => l.id === q1.id).segs, want.layers[0]);
    ok(`merge ${tag}: zoomed in and dragged, the stack moves with the bars (${a.view})`, d1.ok && stackOk(a).ok && !/^0\.0000,/.test(a.view), d1.why);
    await pzClick(p, `#sheet-body [data-act="zreset"][data-chart="${ID}"]`).catch(() => {}); await sleep(150);
    // off again, one at a time
    await tap(q1.id);
    a = await look(); want = mgModel(base, [q2], viewOf(a));
    const o2 = segsMatch((a.layers[0] || { segs: [] }).segs, want.layers[0]);
    ok(`merge ${tag}: a second tap takes that pool off (the other stays)`, a.layers.length === 1 && a.layers[0].id === q2.id && !a.chips[0].on && o2.ok, o2.why);
    await tap(q2.id);
    a = await look();
    const back = barsMatch((await p.evaluate(LIQ_LOOK, ID)).bars, liqExpect(base, viewOf(a), true), (await p.evaluate(LIQ_LOOK, ID)).band);
    ok(`merge ${tag}: with every chip off the chart is this pool alone again, exactly as before`, a.layers.length === 0 && a.chips.every((c) => !c.on) && back.ok, back.why);
    // another pool opens on itself only
    await tap(q1.id); await closePool(p);
    await openPool(p, q2.id.slice(0, 10));
    a = await look();
    ok(`merge ${tag}: another pool's detail opens on itself only`, a.layers.length === 0 && a.chips.length === peers.length, String(a.layers.length));
    await closePool(p);
    // a stablecoin pair: its other pool is a chip even while the stablecoin switch hides both from the lists
    const nm = pools.filter((q) => q.pair === 'NUMA/USDC');
    await openPool(p, nm[0].id.slice(0, 10));
    await p.evaluate(() => document.querySelector('#f-stab').click()); await sleep(300);
    a = await look();
    const hidden = await p.evaluate(() => document.querySelector('#f-stab').getAttribute('aria-checked'));
    ok(`merge ${tag}: pools the stablecoin switch hides still appear as chips here (same pair)`, hidden === 'false' && a.chips.length === nm.length - 1, `${hidden} ${a.chips.length}`);
    ok(`merge ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    if (SHOTS && !phone) { await p.evaluate(() => document.querySelector('#f-stab').click()); await closePool(p); await openPool(p, base.id.slice(0, 10)); await tap(q1.id); await tap(q2.id); await snap(p, 'merge-laptop', '#sheet .sheet-card'); }
    if (SHOTS && phone) { await p.evaluate(() => document.querySelector('#f-stab').click()); await closePool(p); await openPool(p, base.id.slice(0, 10)); await tap(q1.id); await snap(p, 'merge-phone'); }
    await t.ctx.close();
  }
}

// ---------- the fee-history mini bar (v0.4.2): lists, cards and the pool header ----------
function feeModel(rows) { // the last 7 days' fees a day and the change on the 7 before, straight from history.json's rows
  const r = rows.filter((x) => typeof x[0] === 'number').sort((a, b) => a[0] - b[0]), t1 = r[r.length - 1][0], bars = [];
  for (let i = 1; i < r.length; i++) if (r[i][0] > r[i - 1][0]) bars.push({ a: r[i - 1][0], b: r[i][0], v: typeof r[i][2] === 'number' ? r[i][2] / ((r[i][0] - r[i - 1][0]) / 864e5) : null });
  const per = (a, b) => { let f = 0, d = 0; for (const x of bars) { if (x.v == null) continue; const ov = Math.min(b, x.b) - Math.max(a, x.a); if (ov > 0) { f += (x.v * ov) / 864e5; d += ov / 864e5; } } return d >= 3 - 1e-9 ? f / d : null; };
  const day = per(t1 - 7 * 864e5, t1), prev = per(t1 - 14 * 864e5, t1 - 7 * 864e5);
  return { day, ch: day != null && prev > 0 ? day / prev - 1 : null, n: bars.filter((x) => x.b > t1 - 30 * 864e5).length };
}
const usdFx = (x) => { const a = Math.abs(x); return '$' + (a >= 999.5e6 ? (a / 1e9).toFixed(a >= 9.95e9 ? 0 : 1) + 'B' : a >= 999.5e3 ? (a / 1e6).toFixed(a >= 9.95e6 ? 0 : 1) + 'M' : a >= 9995 ? Math.round(a / 1e3) + 'K' : a >= 999.5 ? (a / 1e3).toFixed(1) + 'K' : a >= 9.995 ? String(Math.round(a)) : a.toFixed(2)); }; // the page's own rounding (not under test here)
const moneyOf = (s) => { const m = /\$([\d.]+)([KMB]?)/.exec(s); return m ? +m[1] * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1) : null; };
async function testFeeBar(browser) {
  const H = FXD.history.pools, pools = FXD.live.pools;
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    await p.click('[data-act="more"]').catch(() => {}); await sleep(150);
    const rows = await p.evaluate(() => [...document.querySelectorAll('#all tbody tr.row')].map((r) => { const f = r.querySelector('td.fees .fmini'); return { id: r.dataset.id, txt: f ? f.querySelector('.fm-t').textContent : null, n: f ? +f.dataset.fm : -1, svg: f ? [f.querySelector('svg').getAttribute('width'), f.querySelector('svg').getAttribute('height')].join('×') : '' }; }));
    const head = await p.evaluate(() => [...document.querySelectorAll('#all-tbl thead th')].map((e) => e.textContent));
    let bad = [], dash = 0, withCh = 0;
    for (const r of rows) {
      const h = H[r.id], e = h && Array.isArray(h.d) && h.d.some((x) => typeof x[2] === 'number') ? feeModel(h.d) : null;
      if (!e) { if (r.txt !== '—') bad.push('no history but ' + r.txt); else dash++; continue; }
      const got = moneyOf(r.txt), chm = /([▲▼]) (\d+)%/.exec(r.txt);
      if (e.day == null ? got != null : !r.txt.startsWith(usdFx(e.day) + '/d')) bad.push(`day ${r.txt} vs ${e.day}`);
      if (e.ch == null ? !!chm : !(chm && (chm[1] === '▲') === (e.ch >= 0) && Math.abs(+chm[2] - Math.round(Math.abs(e.ch) * 100)) <= 0)) bad.push(`change ${r.txt} vs ${e.ch}`);
      if (chm) withCh++;
      if (r.n !== e.n || r.svg !== '90×22') bad.push(`bars ${r.n}/${e.n} ${r.svg}`);
    }
    ok(`feebar ${tag}: All pools has a "Fees 30 d" column after Why: a 90×22 bar of 30 days and "$X/d · ▲/▼ N%", matching history.json's daily rows ÷ their gaps (${rows.length} rows, ${withCh} with a change)`, head.some((x) => /Fees 30 d/.test(x)) && head.findIndex((x) => /Fees 30 d/.test(x)) === head.findIndex((x) => /^Why/.test(x)) + 1 && rows.length > 50 && !bad.length && withCh > 20, bad.slice(0, 2).join(' | '));
    // a pool with no daily rows: a dash, never $0
    const noHist = pools.filter((q) => !H[q.id] || !(H[q.id].d || []).some((x) => typeof x[2] === 'number'));
    ok(`feebar ${tag}: a pool without history shows a dash (${dash} in the table, ${noHist.length} in the data)`, dash === rows.filter((r) => noHist.some((q) => q.id === r.id)).length, String(dash));
    // sorting by the column: highest first, dashes last
    await p.click('#all-tbl thead [data-k="fees"]'); await sleep(200);
    const sorted = await p.evaluate(() => [...document.querySelectorAll('#all tbody tr.row td.fees .fm-t')].map((e) => e.textContent));
    const vals = sorted.map(moneyOf), firstNull = vals.findIndex((x) => x == null);
    ok(`feebar ${tag}: the column sorts by fees a day, a dash sinks`, vals.slice(0, firstNull < 0 ? vals.length : firstNull).every((x, i, a) => !i || x <= a[i - 1] * 1.051) && (firstNull < 0 || vals.slice(firstNull).every((x) => x == null)), sorted.slice(0, 4).join(' '));
    // best find and favourites/similar cards carry it; Next best only where the row has room
    const cards = await p.evaluate(() => ({ best: !!document.querySelector('#best .fmrow .fmini svg'), next: [...document.querySelectorAll('#next .nb-row .fmini')].map((e) => getComputedStyle(e).display !== 'none'), nextW: document.querySelector('#next').clientWidth }));
    ok(`feebar ${tag}: the best find carries the mini bar`, cards.best);
    ok(`feebar ${tag}: Next best shows it only where the row has room (${cards.nextW} px wide: ${cards.next.filter(Boolean).length}/${cards.next.length})`, cards.next.length > 0 && cards.next.every((x) => x === cards.nextW >= 500), JSON.stringify(cards));
    const pick = pools.find((q) => H[q.id] && H[q.id].d && H[q.id].d.length > 80 && !isStableFx(q) && q.pair === 'VELNA/WETH') || pools.find((q) => H[q.id] && H[q.id].d && H[q.id].d.length > 80);
    await openPool(p, pick.id.slice(0, 10));
    const sim = await p.evaluate(() => [...document.querySelectorAll('#sim .mc:not(.end)')].map((c) => !!c.querySelector('.fmini svg')));
    ok(`feebar ${tag}: the similar-pool cards carry it (${sim.length} cards)`, sim.length > 0 && sim.every(Boolean), JSON.stringify(sim));
    // the header's bigger bar: a tap lands on the full daily fee chart, zoomed out to every day it has
    const hb = await p.evaluate(() => { const b = document.querySelector('#sheet-fee [data-act="feehist"]'); return b ? { w: +b.querySelector('svg').getAttribute('width'), t: b.textContent, h: b.getBoundingClientRect().height } : null; });
    ok(`feebar ${tag}: the pool header has a bigger bar (${hb && hb.w} px) that is a 44 px button`, hb && hb.w >= 140 && hb.h >= 43.5 && /\/d/.test(hb.t), JSON.stringify(hb));
    await pzClick(p, '#sheet-body [data-act="zoom"][data-chart="d-day"][data-dir="1"]'); await sleep(150);
    await pzClick(p, '#sheet-body [data-act="zoom"][data-chart="d-day"][data-dir="1"]'); await sleep(150);
    const zin = +(await p.getAttribute('[data-pz="d-day"]', 'data-view')).split(',')[1];
    await p.evaluate(() => document.querySelector('#sheet-body').scrollTo(0, 0)); await sleep(150);
    await p.click('#sheet-fee [data-act="feehist"]'); await sleep(900);
    const land = await p.evaluate(() => { const b = document.querySelector('#sheet-body [data-chartbox="d-day"]').getBoundingClientRect(), sb = document.querySelector('#sheet-body').getBoundingClientRect(); return { top: b.top - sb.top, h: sb.height, view: document.querySelector('[data-pz="d-day"]').dataset.view }; });
    const rr = pick && H[pick.id].d.filter((x) => typeof x[0] === 'number'), span = (rr[rr.length - 1][0] - rr[0][0]) / 864e5;
    ok(`feebar ${tag}: a tap scrolls to the daily fee chart and zooms it out to all ${Math.round(span)} days (was ${zin.toFixed(1)})`, land.top >= -4 && land.top < land.h * 0.5 && Math.abs(+land.view.split(',')[1] - span) < 0.05 && span > 85 && zin < span - 1, JSON.stringify(land));
    await pzClick(p, '#sheet-body [data-act="zoom"][data-chart="d-day"][data-dir="1"]'); await sleep(150);
    const v0 = await p.getAttribute('[data-pz="d-day"]', 'data-view');
    await pzDrag(p, 'd-day', 120); await pzSettled(p, 'd-day');
    const v1 = await p.getAttribute('[data-pz="d-day"]', 'data-view');
    ok(`feebar ${tag}: …and it zooms in and pans back in time`, v0 !== v1 && +v1.split(',')[0] < +v0.split(',')[0], v0 + ' → ' + v1);
    if (SHOTS) await snap(p, `feebar-${tag}`);
    await closePool(p);
    ok(`feebar ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // history not published yet: every bar is a dash, nothing breaks
  const n = await openUnlocked(browser, 'nofiles', { width: 1300 });
  const txt = await n.page.evaluate(() => [...document.querySelectorAll('#all tbody td.fees .fm-t')].map((e) => e.textContent));
  ok('feebar: with no history.json every mini bar is a dash, never $0', txt.length > 0 && txt.every((x) => x === '—'), txt.slice(0, 3).join(' '));
  await n.ctx.close();
}

// ---------- run ----------
const t0 = Date.now();
writeFixtures(FX);
const srv = await serve();
ORIGIN = `http://127.0.0.1:${srv.address().port}`;
const browser = await pw[BROWSER].launch();
// ---------- 4f5. v0.4.5: every place that names a pool, walked with the stablecoin switch off ----------
// The owner still saw stablecoin pairs with the switch off (the backtest leaderboard, a pools section). This walk goes through
// every window, every best-find tab, the whole table, New since, Next best, the backtests (leaderboard, scatter, each replay,
// the strategy lab), search, a pool's detail (similar pools, its list) and a pair view, with one stablecoin pair starred, and
// reads what is on screen: no other stablecoin pair may show, by its name or (the scatter's labels) by its token. With the
// switch on, the same reading must find them (the walk sees what it claims to see).
const WALK_TXT = () => document.body.innerText + '\n' + [...document.querySelectorAll('svg text')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent).join('\n');
async function testStableWalk(browser) {
  const pools = FXD.live.pools, fav = pools.filter((q) => q.pair === 'NUMA/USDC')[0];
  const okSyms = new Set(pools.filter((q) => !isStableFx(q) || q.pair === fav.pair).flatMap((q) => [q.t0.sym, q.t1.sym]));
  const hidden = pools.filter((q) => isStableFx(q) && q.pair !== fav.pair);
  const names = [...new Set(hidden.map((q) => q.pair))], syms = [...new Set(hidden.map((q) => q.t0.sym))].filter((s) => !okSyms.has(s));
  const leaksIn = (txt) => [...names.filter((n) => txt.includes(n)), ...syms.filter((s) => new RegExp(`(^|[^A-Z0-9])${s}([^A-Z0-9]|$)`).test(txt))];
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'laptop';
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, stableDefault: true, storage: { 'lps.hint': '1', 'lps.fav': JSON.stringify([fav.id]) } }), p = t.page;
    const where = new Map(), seen = { n: 0 };
    const read = async (place) => { seen.n++; for (const x of leaksIn(await p.evaluate(WALK_TXT))) if (!where.has(x)) where.set(x, place); };
    const tap = async (sel) => { const hit = await p.evaluate((s) => { window.dispatchEvent(new WheelEvent('wheel')); const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel); await sleep(250); return hit; };
    for (const wk of phone ? ['30d'] : ['24h', '7d', '30d']) {
      await setWin(p, wk);
      await tap('#all-more .btn');
      await read(`${wk} page`);
      const tabs = await p.$$eval('#best [role="tab"]', (x) => x.length);
      for (let i = 0; i < tabs; i++) { await p.evaluate((i) => document.querySelectorAll('#best [role="tab"]')[i].click(), i); await sleep(60); await read(`${wk} best tab ${i}`); }
      const bt = await p.$$eval('#bt-lead tr.row', (x) => x.length);
      for (let i = 0; i < bt; i++) { await p.evaluate((i) => document.querySelectorAll('#bt-lead tr.row')[i].click(), i); await sleep(250); await read(`${wk} replay ${i}`); }
      await tap('#bt-replay [data-act="bt-close"]');
    }
    // search: a stablecoin's ticker suggests nothing hidden (the starred pair may show)
    await p.fill('#f-q', 'USDC'); await sleep(300);
    const sugg = await p.evaluate(() => document.querySelector('#q-list').innerText);
    for (const x of leaksIn(sugg)) where.set(x, 'search');
    await fillQ(p, '');
    // a pool's detail (similar pools, also as a list) and its pair view
    await tap('#next .nb-row[data-act="detail"]');
    await read('detail');
    if (await tap('#sim [data-act="sim-all"]')) await read('similar list');
    await tap('#sheet-pair'); await read('pair view');
    await p.click('#sheet-close'); await sleep(200);
    const a = await p.evaluate(() => ({ tile: document.querySelector('#scanner').innerText, favRow: [...document.querySelectorAll('#all tbody tr.row')].filter((r) => /NUMA\/USDC/.test(r.textContent)).map((r) => /★ STABLE/.test(r.textContent)),
      favCard: [...document.querySelectorAll('#fav .mc')].map((c) => /★ STABLE/.test(c.textContent)), nb: document.querySelector('#next .foot .btn').textContent, count: document.querySelector('#all-count').textContent }));
    ok(`stablewalk ${tag}: with the switch off no stablecoin pair shows anywhere but the starred one (${seen.n} views: every window, tab, replay, the table, search, a detail and a pair view)`, where.size === 0 && seen.n >= (phone ? 4 : 12), JSON.stringify([...where].slice(0, 4)));
    ok(`stablewalk ${tag}: the starred stablecoin pair stays, marked ★ STABLE (table row, favourites card)`, a.favRow.length === 1 && a.favRow[0] && a.favCard.length === 1 && a.favCard[0], JSON.stringify(a));
    const nVis = pools.length - pools.filter((q) => isStableFx(q) && q.id !== fav.id).length;
    ok(`stablewalk ${tag}: the scanner tile counts the hidden ones; Next best's button and the table's count leave them out (${nVis} shown)`, /\d+ hidden · stablecoin pairs off/.test(a.tile) && a.nb.includes(`All ${nVis} scored pools`) && new RegExp(`OF ${nVis}( |$)`).test(a.count), `${a.nb} | ${a.count}`);
    // switched on (from the strip): the same reading finds them, so the walk can see them
    await p.evaluate(() => scrollTo(0, 0));
    await p.click('#t-stab'); await sleep(350);
    const found = new Set();
    for (const wk of ['24h', '30d']) {
      await setWin(p, wk); await tap('#all-more .btn');
      for (const x of leaksIn(await p.evaluate(WALK_TXT))) found.add(x);
      const lead = await p.$$eval('#bt-lead tr.row .pn2', (x) => x.map((e) => e.textContent));
      if (lead.some((n) => names.includes(n))) found.add('leaderboard');
    }
    ok(`stablewalk ${tag}: switched on, the same walk finds them (the table, the leaderboard: ${found.size} names)`, found.size >= 5 && found.has('leaderboard'), [...found].slice(0, 5).join(' '));
    ok(`stablewalk ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    if (!phone) await snap(p, 'stablewalk-on-laptop');
    await t.ctx.close();
  }
  // the strip's switch and the table's: one state, both ways, the focus stays where it was pressed, kept on this device
  for (const phone of [true, false]) {
    const tag = phone ? 'phone' : 'laptop';
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, stableDefault: true }), p = t.page;
    const st = () => p.evaluate(() => ({ top: document.querySelector('#t-stab').getAttribute('aria-checked'), topTxt: document.querySelector('#t-stab').textContent.replace(/\s+/g, ' ').trim(),
      row: document.querySelector('#f-stab').getAttribute('aria-checked'), focus: document.activeElement && document.activeElement.id, ls: localStorage.getItem('lps.stable'),
      lead: [...document.querySelectorAll('#bt-lead tr.row .pn2')].map((e) => e.textContent) }));
    const box = await p.evaluate(() => { const r = document.querySelector('#t-stab').getBoundingClientRect(), g = document.querySelector('#gas').getBoundingClientRect(), s = document.querySelector('#mstrip').getBoundingClientRect(); return { vis: r.width > 40 && r.height >= 44 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, inStrip: r.top >= s.top - 14 && r.bottom <= s.bottom + 14, dy: Math.abs((r.top + r.bottom) / 2 - (g.top + g.bottom) / 2) }; });
    let a = await st();
    ok(`stablewalk ${tag}: the strip has the switch next to the gas gauge, in view on load ("${a.topTxt}"), a switch for assistive tech`, box.vis && box.inStrip && a.top === 'false' && /^Stables: off$/.test(a.topTxt) && (await p.getAttribute('#t-stab', 'role')) === 'switch', JSON.stringify(box));
    await p.click('#t-stab'); await sleep(350);
    a = await st();
    ok(`stablewalk ${tag}: the strip's switch turns both on, keeps its focus and the choice`, a.top === 'true' && a.row === 'true' && /Stables: on/.test(a.topTxt) && a.focus === 't-stab' && a.ls === '1' && a.lead.some((n) => /\/(USDC|MUNT)$/.test(n)), JSON.stringify(a).slice(0, 200));
    await p.evaluate(() => document.querySelector('#f-stab').scrollIntoView({ block: 'center' })); await p.click('#f-stab'); await sleep(350);
    a = await st();
    ok(`stablewalk ${tag}: the table's switch turns both off again (one state)`, a.top === 'false' && a.row === 'false' && /Stables: off/.test(a.topTxt) && a.focus === 'f-stab' && a.ls === '0' && !a.lead.some((n) => /\/(USDC|MUNT)$/.test(n)), JSON.stringify(a).slice(0, 200));
    await p.evaluate(() => scrollTo(0, 0)); await sleep(150);
    await p.click('#mstrip [data-term="stabtop"]'); await sleep(200);
    const note = await p.evaluate(() => { const e = document.querySelector('#pop'); return e && !e.hidden ? e.textContent : ''; });
    ok(`stablewalk ${tag}: its ⓘ says it in plain words`, note.includes('Pairs with a stablecoin (USDC, USDT, DAI…) are hidden by default. Turn on to include them.'), note.slice(0, 80));
    await p.keyboard.press('Escape'); await sleep(100);
    if (!phone) await auditAt(p, 'stable-strip-w1440'); else await auditAt(p, 'stable-strip-phone');
    ok(`stablewalk ${tag}: switches, no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4m. v0.4.5: the competition flash (owner's pick A, 3.5 s) ----------
// An independent reading of the badge: each pool's value within ±9% of its own price (its bars by overlap, the full-range
// layer's share), the others' sum over this pool's. The flash itself is read through the chart: the stacked layers (path.mg),
// the chips' light (.fl-on), the banner, the ghost (path.ghost) and the slot's phase (data-ph: grow, hold, fade, end).
const v9Fx = (q, B = 0.09, withFr = true) => {
  const sh = q.shape, E = sh.depthEdges;
  if (!sh.depth.some((d) => d[1] != null)) return null;
  let v = 0;
  for (let i = 0; i < sh.depth.length; i++) { const ov = Math.min(B, E[i + 1]) - Math.max(-B, E[i]); if (ov <= 1e-12) continue; if (sh.depth[i][1] == null) return null; v += (sh.depth[i][1] * ov) / (E[i + 1] - E[i]); }
  if (withFr && sh.fullRangeUsd > 0) { const s = sh.fullRangeSpan && sh.fullRangeSpan[0] < 0 && sh.fullRangeSpan[1] > 0 ? sh.fullRangeSpan : [-Infinity, Infinity]; v += (sh.fullRangeUsd * eInt(Math.max(-B, s[0]), Math.min(B, s[1]))) / eInt(s[0], s[1]); }
  return v;
};
function cmpModel(base, o = {}) {
  const peers = FXD.live.pools.filter((q) => q.id !== base.id && samePairFx(base, q)), vs = peers.map((q) => v9Fx(q, o.B, o.fr));
  const own = v9Fx(base, o.B, o.fr), known = vs.filter((v) => v != null);
  const x = own > 0 && known.length ? known.reduce((s, v) => s + v, 0) / own : null;
  return { n: peers.length, x, ge: known.length < peers.length, txt: x == null ? null : (known.length < peers.length ? '≥' : '') + (x >= 9.95 ? String(Math.round(x)) : x >= 0.095 ? x.toFixed(1) : '<0.1') + '×' };
}
const FL_LOOK = (root) => {
  const box = document.querySelector(`${root} [data-chartbox="liq-detail"]`) || document.querySelector('[data-chartbox="liq-detail"]');
  if (!box) return null;
  const c = box.querySelector('.cmp'), ban = c && c.querySelector('.cmp-ban'), b = c && c.querySelector('.cmp-b'), gh = box.querySelector('path.ghost');
  return { ph: c ? c.dataset.ph : null, layers: box.querySelectorAll('path.mg').length, lit: box.querySelectorAll('.mgc.fl-on').length,
    pressed: [...box.querySelectorAll('[data-act="merge"]')].filter((x) => x.getAttribute('aria-pressed') === 'true').length, chips: box.querySelectorAll('[data-act="merge"]').length,
    ban: !!ban && getComputedStyle(ban).visibility === 'visible', banTxt: ban ? ban.textContent : '', badge: !!b && getComputedStyle(b).visibility === 'visible', badgeTxt: b ? b.textContent : '', replay: !!(b && b.matches('button[data-act="flash"]')),
    ghost: gh ? +gh.getAttribute('opacity') : 0, legend: /Whole pair · \d+ pools/.test(box.querySelector('.legend').textContent) };
};
const flLook = (p, root = '#sheet') => p.evaluate(FL_LOOK, root);
// waits for the slot's phase (polled every frame inside the page, so a slow browser can't skip past it unseen)
const flWait = (p, ph, ms = 8000) => p.waitForFunction((ph) => { const c = document.querySelector('[data-chartbox="liq-detail"] .cmp'); return !!c && c.dataset.ph === ph; }, ph, { polling: 'raf', timeout: ms }).then(() => true, () => false);
const badgeNum = (txt) => { const m = /\+(\d+) pools? · (≥?(?:[\d.]+|<0\.1)×) liquidity/.exec(txt || ''); return m ? { n: +m[1], x: m[2] } : null; };
async function testFlash(browser) {
  const pools = FXD.live.pools;
  const base = pools.find((q) => q.pair === 'VELNA/WETH' && q.chain === 'ethereum'), peers = pools.filter((q) => q.id !== base.id && samePairFx(base, q));
  for (const phone of [true, false]) {
    const tag = phone ? 'phone' : 'laptop';
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, flash: true }), p = t.page;
    // 1. the timeline: grow → hold (every other pool stacked, chips lit, gold banner) → fade → end, once
    await fillQ(p, base.id.slice(0, 10)); await sleep(250);
    const t0 = Date.now();
    await p.evaluate(() => document.querySelector('#all tbody tr.row td:nth-child(3)').click());
    const samples = [];
    const watcher = p.evaluate(() => new Promise((res) => { const out = [], t0 = performance.now(); const f = () => { const box = document.querySelector('[data-chartbox="liq-detail"]'), c = box && box.querySelector('.cmp'); if (c) out.push([Math.round(performance.now() - t0), c.dataset.ph, box.querySelectorAll('path.mg').length, [...box.querySelectorAll('[data-act="merge"]')].filter((x) => x.getAttribute('aria-pressed') === 'true').length]); if (performance.now() - t0 < 5500) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); }));
    const sawHold = await p.waitForFunction(() => document.querySelector('[data-chartbox="liq-detail"] .cmp.ban'), null, { polling: 'raf', timeout: 8000 }).then(() => true, () => false); // the banner joins at 0.8 s
    const hold = await flLook(p);
    const sawEnd = await flWait(p, 'end'), tEnd = Date.now() - t0;
    const end = await flLook(p);
    samples.push(...(await watcher));
    const seq = samples.map((s) => s[1]).filter((x, i, a) => !i || x !== a[i - 1]), phases = seq.join('>'), ORD = ['grow', 'hold', 'fade', 'end'];
    const inOrder = seq.every((x, i) => !i || ORD.indexOf(x) > ORD.indexOf(seq[i - 1])) && ['hold', 'fade', 'end'].every((x) => seq.includes(x)) && (BROWSER === 'webkit' || seq[0] === 'grow');
    ok(`flash ${tag}: a pool with ${peers.length} other pools of its pair plays grow → hold → fade → end once (${phases}), about 3.5 s (${(tEnd / 1000).toFixed(1)} s)`, sawHold && sawEnd && inOrder && tEnd >= 3300 && tEnd < (BROWSER === 'webkit' ? 9000 : 6000), phases + ' ' + tEnd);
    ok(`flash ${tag}: in the hold every other pool is stacked, its chip lit, under a gold banner ("${hold.banTxt.slice(0, 60)}")`, hold.layers === peers.length && hold.lit === peers.length && hold.ban && !hold.badge && hold.pressed === 0 && /^This pair: \d+ other pools hold/.test(hold.banTxt), JSON.stringify(hold).slice(0, 220));
    ok(`flash ${tag}: the end state is this pool alone, chips off and unlit, the ghost and the badge (with replay) shown, the banner gone`, end.ph === 'end' && end.layers === 0 && end.lit === 0 && end.pressed === 0 && !end.ban && end.badge && end.replay && end.ghost > 0.8 && end.legend, JSON.stringify(end).slice(0, 220));
    ok(`flash ${tag}: never a stack the chips don't own once it has ended (${samples.length} frames read)`, samples.every((s) => s[3] === 0) && samples.filter((s) => s[1] === 'end').every((s) => s[2] === 0) && samples.some((s) => s[2] === peers.length), JSON.stringify(samples.filter((s) => s[1] === 'end' && s[2]).slice(0, 3)));
    for (const x of await p.evaluate(TEXT_OVERLAP, { root: '#sheet' })) ok(`flash ${tag}: end state, no text collides`, false, `${x.kind}: ${x.a} × ${x.b}`);
    if (phone) await snap(p, 'flash-end-phone', '#sheet [data-chartbox="liq-detail"]'); else await snap(p, 'flash-end-laptop', '#sheet [data-chartbox="liq-detail"]');
    // 2. the badge's maths against the independent model
    const m = cmpModel(base), bn = badgeNum(end.badgeTxt);
    ok(`flash ${tag}: the badge says +${m.n} pools · ${m.txt} liquidity, as the independent model reads the fixture`, bn && bn.n === m.n && bn.x === m.txt, `${end.badgeTxt} vs ${m.n} ${m.txt}`);
    // 3. once per pool per page: closed and opened again, it doesn't play; the replay plays it
    await closePool(p); await openPool(p, base.id.slice(0, 10));
    await sleep(500);
    let a = await flLook(p);
    ok(`flash ${tag}: opened again in the same page it doesn't replay by itself`, a.ph === 'end' && a.layers === 0 && a.ghost > 0.8, JSON.stringify(a).slice(0, 120));
    // 4. any interaction ends it at once on the end state: a chip, a zoom, a drag, a wheel, a key, close
    const replay = async () => { await p.evaluate(() => document.querySelector('#sheet [data-act="flash"]').click()); return flWait(p, 'hold'); };
    const ends = {};
    if (await replay()) { await p.evaluate(() => document.querySelector('#sheet [data-act="merge"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); await p.evaluate(() => document.querySelector('#sheet [data-act="merge"]').click()); await frames(p, 2); a = await flLook(p); ends.chip = a.ph === 'end' && a.layers === 1 && a.pressed === 1 && a.lit === 0 && !a.ban; }
    if (await replay()) { await frames(p, 1); a = await flLook(p); const mid = a.layers; await sleep(BROWSER === 'webkit' ? 4500 : 3800); a = await flLook(p); ends.keepChip = mid >= 1 && a.ph === 'end' && a.layers === 1 && a.pressed === 1; } // a chip on before the replay is still on after
    await p.evaluate(() => document.querySelector('#sheet [data-act="merge"][aria-pressed="true"]').click()); await sleep(200);
    if (await replay()) { await p.evaluate(() => document.querySelector('#sheet [data-act="zoom"][data-chart="liq-detail"][data-dir="1"]').click()); await frames(p, 2); a = await flLook(p); ends.zoom = a.ph === 'end' && a.layers === 0 && !a.ban; }
    await pzClick(p, '#sheet [data-act="zreset"][data-chart="liq-detail"]').catch(() => {}); await sleep(150);
    if (await replay()) { await finger(p, 'liq-detail', -60, { root: '#sheet', steps: 4 }); await frames(p, 2); a = await flLook(p); ends.drag = a.ph === 'end' && a.layers === 0; }
    await pzClick(p, '#sheet [data-act="zreset"][data-chart="liq-detail"]').catch(() => {}); await sleep(150);
    if (await replay()) { await p.evaluate(() => document.querySelector('#sheet-body').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }))); await frames(p, 2); a = await flLook(p); ends.wheel = a.ph === 'end' && a.layers === 0; }
    if (await replay()) { await p.keyboard.press('Shift'); await frames(p, 2); a = await flLook(p); ends.key = a.ph === 'end' && a.layers === 0; }
    if (await replay()) { await p.click('#sheet-close'); await sleep(150); const s = await p.evaluate(() => ({ hidden: document.querySelector('#sheet').hidden })); await openPool(p, base.id.slice(0, 10)); a = await flLook(p); ends.close = s.hidden && a.ph === 'end' && a.layers === 0 && a.lit === 0; }
    ok(`flash ${tag}: a chip, a zoom, a drag, a wheel, a key or close ends it at once on the end state (${Object.keys(ends).join(', ')})`, Object.keys(ends).length === 7 && Object.values(ends).every(Boolean), JSON.stringify(ends));
    // 5. a pool with no other pool of its pair: nothing (no badge, no ghost, no chips)
    await closePool(p);
    const solo = pools.find((q) => q.t0.sym === 'QUARX');
    await openPool(p, 'QUARX'); await sleep(300);
    const s0 = await p.evaluate(() => { const b = document.querySelector('#sheet [data-chartbox="liq-detail"]'); return { cmp: !!b.querySelector('.cmp'), ghost: !!b.querySelector('path.ghost'), chips: b.querySelectorAll('.mgchips').length, legend: /Whole pair/.test(b.textContent) }; });
    ok(`flash ${tag}: a pool with no other pool of its pair (${solo.pair}) shows nothing of it`, !s0.cmp && !s0.ghost && !s0.chips && !s0.legend, JSON.stringify(s0));
    await closePool(p);
    ok(`flash ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  // 6. the badge's maths on the other pools of the pair (one under 1×, one over 10×); planted faults must be caught
  {
    const t = await openUnlocked(browser, 'default', { width: 1440 }), p = t.page, res = [];
    for (const q of [base, ...peers]) {
      await openPool(p, q.id.slice(0, 10));
      const b = badgeNum((await flLook(p)).badgeTxt), m = cmpModel(q);
      res.push({ pair: q.pair, tier: q.feeTier, v: q.v, chain: q.chain, got: b && b.x, n: b && b.n, want: m.txt, ok: !!b && b.n === m.n && b.x === m.txt, noFr: cmpModel(q, { fr: false }).txt, b10: cmpModel(q, { B: 0.1 }).txt });
      await closePool(p);
    }
    ok(`flash: the badge matches the independent model on every pool of the pair (${res.map((r) => r.got).join(', ')})`, res.every((r) => r.ok) && res.some((r) => parseFloat(r.want) < 1) && res.some((r) => parseFloat(r.want) >= 10), JSON.stringify(res.filter((r) => !r.ok)));
    ok('flash: planted: a model without the full-range layer, or reading ±10%, is caught somewhere on the pair', res.some((r) => r.noFr !== r.got) && res.some((r) => r.b10 !== r.got), JSON.stringify(res.map((r) => [r.got, r.noFr, r.b10])));
    // the best-find card: the badge only (no flash there); its tap opens the pool and plays it
    await setWin(p, '30d');
    const tabOk = await p.evaluate(() => { const t = [...document.querySelectorAll('#best [role="tab"]')].find((e) => /VELNA/.test(e.textContent)); if (!t) return false; t.click(); return true; });
    await sleep(250);
    const card = await p.evaluate(() => { const b = document.querySelector('#best .cmp-b'); return { txt: b ? b.textContent : '', act: b && b.dataset.act, mg: document.querySelectorAll('#best path.mg, #best path.ghost').length, chips: document.querySelectorAll('#best .mgchips').length, id: b && b.dataset.id }; });
    const cm = card.id && cmpModel(pools.find((q) => q.id === card.id)), cb = badgeNum(card.txt);
    ok(`flash: the best-find card carries the badge only (${card.txt.slice(0, 50)}), as the model reads it`, tabOk && card.act === 'flash-open' && card.mg === 0 && card.chips === 0 && cb && cm && cb.n === cm.n && cb.x === cm.txt, JSON.stringify(card));
    await p.evaluate(() => document.querySelector('#best .cmp-b').click());
    const played = await flWait(p, 'hold', 6000) || (await flWait(p, 'grow', 100));
    ok('flash: the card\'s badge opens that pool and plays it there (even with the auto-play off)', (await p.isVisible('#sheet')) && played);
    await p.click('#sheet-close'); await sleep(200);
    ok('flash: card and model, no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 7. reduced motion: never animated, the ghost and the badge (no replay) at once
  {
    const t = await openUnlocked(browser, 'default', { phone: true, flash: true, reducedMotion: 'reduce' }), p = t.page;
    await fillQ(p, base.id.slice(0, 10)); await sleep(250);
    const watcher = p.evaluate(() => new Promise((res) => { let worst = 0; const t0 = performance.now(); const f = () => { const b = document.querySelector('[data-chartbox="liq-detail"]'); if (b) worst = Math.max(worst, b.querySelectorAll('path.mg, .mgc.fl-on').length + (b.querySelector('.cmp.ban') ? 1 : 0)); if (performance.now() - t0 < 2500) requestAnimationFrame(f); else res(worst); }; requestAnimationFrame(f); }));
    await p.evaluate(() => document.querySelector('#all tbody tr.row td:nth-child(3)').click());
    const worst = await watcher, a = await flLook(p);
    ok('flash: under reduced motion nothing animates (no stack, no light, no banner), the ghost and the badge show at once, without a replay', worst === 0 && a.ph === 'end' && a.ghost > 0.8 && a.badge && !a.replay, JSON.stringify({ worst, a }).slice(0, 200));
    ok('flash: reduced motion, no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 8. the pop-out window: the same flash on its own (a page of its own: it plays there once too)
  {
    const t = await openUnlocked(browser, 'default', { width: 1440, flash: true }), p = t.page;
    await openPool(p, base.id.slice(0, 10)); await flWait(p, 'end');
    await p.evaluate(() => document.querySelector('#sheet [data-act="openchart"][data-chart="liq-detail"]').click()); await sleep(200);
    const u = await p.evaluate(() => (window.__opened || []).slice(-1)[0] || '');
    const w2 = await t.ctx.newPage(), e2 = [];
    w2.on('pageerror', (e) => e2.push(String(e.message).slice(0, 100)));
    await w2.goto(u);
    await w2.waitForSelector('.solo-box[data-chartbox="liq-detail"], .solo-box [data-pz="liq-detail"]', { timeout: 20000 }).catch(() => {});
    const hold = await flWait(w2, 'hold', 15000), end = (await flWait(w2, 'end')) && (await flLook(w2, 'body'));
    ok('flash: the pop-out window plays it as well and ends on the ghost and the badge', hold && end && end.layers === 0 && end.ghost > 0.8 && end.badge && e2.length === 0, JSON.stringify(end).slice(0, 160) + ' ' + (e2[0] || ''));
    await w2.close();
    await t.ctx.close();
  }
}

// ---------- 4z. dates (v0.4.6): every chart over time has a date axis, and a hover or a tap shows the date and the values there ----------
const DATE_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2,3}\b|\b\d{1,2} [A-Z][a-z]{2,3}\b/;
// a chart's axis: the visible tick labels, whether they read as dates or hours, and whether any two touch or leave the box
const AXIS = ({ id }) => {
  const h = document.querySelector(`[data-pz="${id}"]`);
  if (!h) return { n: -1, labs: [], ok: false, clash: 0, out: 0 };
  const tx = document.querySelector(`[data-tax="${id}"]`);
  const els = tx ? [...tx.children].filter((s) => s.style.visibility !== 'hidden' && s.offsetWidth > 0) : [...h.querySelectorAll('svg text.dt')];
  const rs = els.map((e) => e.getBoundingClientRect()), box = (tx || h).getBoundingClientRect();
  let clash = 0;
  for (let i = 1; i < rs.length; i++) if (rs[i].left < rs[i - 1].right + 1) clash++;
  const labs = els.map((e) => e.textContent);
  return { n: labs.length, labs, ok: labs.length >= 2 && labs.every((l) => /^(\d{1,2} [A-Z][a-z]{2,3}( \d\d:\d\d)?|\d\d:\d\d)$/.test(l)), clash, out: rs.filter((r) => r.left < box.left - 1 || r.right > box.right + 1).length };
};
const TIPR = () => {
  const e = document.querySelector('#ctip');
  if (!e || e.hidden) return null;
  const r = e.getBoundingClientRect(), hd = document.querySelector('#sheet').hidden ? document.querySelector('header.top') : document.querySelector('#sheet .sheet-head');
  return { txt: e.innerText.replace(/\s+/g, ' '), inside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5, below: !hd || r.top >= hd.getBoundingClientRect().bottom - 1 };
};
// point at a chart: a mouse hover (laptop) or a finger's tap (phone), at a share fx of its width
async function pointAt(p, id, phone, { fx = 0.5, fy = 0.5, root = '' } = {}) {
  const b = await p.evaluate(HOST_BOX, { id, root });
  if (!b) return null;
  const x = b.x + b.w * fx, y = b.y + b.h * fy;
  let dbg = null;
  if (phone) {
    await p.evaluate(() => { // which code put the note away (a trace for a failing check only)
      const c = document.querySelector('#ctip'); if (c.__traced) return; c.__traced = true;
      const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
      Object.defineProperty(c, 'hidden', { get() { return d.get.call(this); }, set(v) { if (v && !d.get.call(this)) window.__hid = String(new Error().stack).split('\n').slice(1, 6).map((l) => l.replace(/@.*$|\(.*\)|^\s*at /g, '').trim()).join('<'); d.set.call(this, v); } });
      for (const t of ['pointerdown', 'pointerup', 'pointercancel']) document.addEventListener(t, (e) => { (window.__ev ||= []).push(t[7] + (e.pointerType || '?')[0] + (e.isTrusted ? 'T' : '')); if (window.__ev.length > 8) window.__ev.shift(); }, true);
    });
    await p.evaluate(() => { window.__hid = ''; window.__ev = []; });
    const el = await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + String(e.getAttribute('class') || '').slice(0, 24) + (e.closest('.pz') ? ' in ' + e.closest('.pz').dataset.pz : '') : null; }, { x, y });
    await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 71, x0: x, y0: y, x1: x, y1: y }] });
    dbg = { el, y: Math.round(y), tip0: await p.evaluate(() => !document.querySelector('#ctip').hidden), ih: await p.evaluate(() => innerHeight) };
  }
  else { await p.mouse.move(x - 3, y); await p.mouse.move(x, y); }
  await sleep(90);
  const r = await p.evaluate(TIPR);
  if (dbg) Object.assign(dbg, await p.evaluate(() => ({ hid: window.__hid, ev: (window.__ev || []).join(' ') })));
  return r || (dbg ? { dbg } : null);
}
async function testDates(browser, page = null) {
  const planted = page != null;
  for (const phone of planted ? [false] : [true, false]) {
    let t;
    if (planted) { // a copy of the page with one chart's axis taken out: the axis check must catch it
      t = await newPage(browser, { width: 1440, storage: { 'lps.hint': '1' } });
      await t.ctx.route((u) => new URL(u).pathname === '/app/index.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page }));
      await t.page.goto(url('default')); await unlockWith(t.page, FIXTURE_PASSPHRASE); await waitApp(t.page); await setWin(t.page, '30d');
    } else t = await openUnlocked(browser, 'default', { phone, width: 1440, storage: { 'lps.hint': '1' } });
    const p = t.page, tag = planted ? 'planted' : phone ? 'phone' : 'laptop', bad = [], tips = [];
    const axisAt = async (id) => { const a = await p.evaluate(AXIS, { id }); if (!(a.ok && a.clash === 0 && a.out === 0)) bad.push(`${id} ${JSON.stringify(a).slice(0, 120)}`); return a; };
    const tipAt2 = async (id, re, o) => { const r = await pointAt(p, id, phone, o); tips.push(r && r.txt); if (!(r && re.test(r.txt) && r.inside && r.below)) bad.push(`${id} tip ${JSON.stringify(r).slice(0, 140)}`); return r; };
    if (planted) {
      await axisAt('daily-best');
      ok('dates: planted: a daily strip without its axis is caught', bad.length > 0, 'not caught');
      await t.ctx.close();
      return;
    }
    // the main page: the best find's daily strip, the scanner's health, the scatter and the liquidity chart
    const shot = async (name) => { if (!SHOTS) return; await p.evaluate(() => { if (!document.querySelector('#fx-rib')) document.body.insertAdjacentHTML('beforeend', '<div id="fx-rib" style="position:fixed;left:0;right:0;bottom:0;z-index:99;padding:3px;text-align:center;font:700 11px/1.3 monospace;letter-spacing:.08em;background:#E8B84A;color:#06080B;pointer-events:none">TEST FIXTURES · MADE-UP NUMBERS</div>'); }); await snap(p, name); };
    for (const id of ['daily-best', 'health']) { await axisAt(id); await tipAt2(id, DATE_RE); if (id === 'daily-best') await shot(`dates-${tag}-daily`); }
    const d1 = tips[0] || '';
    ok(`dates ${tag}: a daily fee bar's note says the day, its fees per $1,000 and how it compares with the median`, /\$\d+\.\d\d per \$1,000/.test(d1) && /× the median/.test(d1) && DATE_RE.test(d1), d1.slice(0, 120));
    await tipAt2('liq-best', /liquidity .*(of the pool|not read)/);
    // the replay, its money pane and the strategy lab
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#bt-lead tr.row'); r.scrollIntoView({ block: 'center' }); r.click(); }); await sleep(900);
    for (const id of ['rp', 'rp-money', 'lab']) { await axisAt(id); await tipAt2(id, DATE_RE); }
    const rp = tips[tips.length - 3] || '', mo = tips[tips.length - 2] || '';
    ok(`dates ${tag}: the replay's notes give the price and whether it was in range, and net, fees, LVR and costs`, /price .* in range (yes|no)/.test(rp) && /net .*fees .*LVR .*costs/.test(mo), rp.slice(0, 80) + ' | ' + mo.slice(0, 80));
    // the scatter: the dot nearest the pointer
    const dot = await p.evaluate(() => { const c = document.querySelector('#bt-scatter circle'); if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (dot) {
      if (phone) await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 72, x0: dot.x + 2, y0: dot.y, x1: dot.x + 2, y1: dot.y }] }); else await p.mouse.move(dot.x + 2, dot.y);
      await sleep(90);
      const r = await p.evaluate(TIPR); tips.push(r && r.txt);
      ok(`dates ${tag}: a dot of the forecast-vs-backtest scatter names its pool, forecast and backtest`, r && /forecast .*backtest .*miss/.test(r.txt) && r.inside, JSON.stringify(r));
    } else ok(`dates ${tag}: the scatter has dots`, false);
    // dismissed: a tap elsewhere, or Esc
    if (phone) {
      await pointAt(p, 'rp', true);
      const h = await p.evaluate(() => { const r = document.querySelector('#rp-pl').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; });
      const pre = await p.evaluate(TIPR), hit = await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? e.tagName + '.' + e.className : null; }, h);
      await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 73, x0: h.x, y0: h.y, x1: h.x, y1: h.y }] }); await sleep(80);
      ok(`dates ${tag}: a tap elsewhere puts the note away`, pre && !(await p.evaluate(TIPR)), JSON.stringify({ pre: !!pre, hit, h, after: await p.evaluate(TIPR) }));
      // a sideways drag still pans and shows no note; a finger held still, then slid, scrubs the note along and pans nothing
      const b = await p.evaluate(HOST_BOX, { id: 'rp' }), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const res = await p.evaluate(async ({ cx, cy }) => {
        const h = document.querySelector('[data-pz="rp"]'), el = document.elementFromPoint(cx, cy), view = () => h.dataset.view;
        const pe = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 74, pointerType: 'touch', isPrimary: true, clientX: x, clientY: cy, bubbles: true, cancelable: true, buttons: /up/.test(type) ? 0 : 1 }));
        const tip = () => { const e = document.querySelector('#ctip'); return e && !e.hidden ? e.innerText : ''; };
        const v0 = view(); pe('pointerdown', cx); await new Promise((r) => setTimeout(r, 560));
        const t0 = tip(), tr = []; for (let i = 1; i <= 6; i++) { pe('pointermove', cx + i * 14); tr.push(tip().slice(0, 20)); await new Promise((r) => setTimeout(r, 20)); }
        window.__tr = tr;
        const t1 = tip(), v1 = view(); pe('pointerup', cx + 84); await new Promise((r) => setTimeout(r, 60));
        return { held: !!t0, moved: t1 && t1 !== t0, still: v0 === v1, kept: !!tip(), tr: window.__tr, t0 };
      }, { cx, cy });
      ok(`dates ${tag}: a finger held on a chart shows the note, sliding scrubs it along without panning, and it stays after the finger lifts`, res.held && res.moved && res.still && res.kept, JSON.stringify(res));
      await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 75, x0: 5, y0: 300, x1: 5, y1: 300 }] }); await sleep(60);
      const v0 = await pzSettled(p, 'rp');
      await p.evaluate(() => document.querySelector('[data-act="zoom"][data-chart="rp"][data-dir="1"]').click()); await sleep(200);
      const v1 = await pzSettled(p, 'rp');
      await finger(p, 'rp', 120, { steps: 10, ms: 20 }); await sleep(80);
      const v2 = await pzSettled(p, 'rp'), after = await p.evaluate(TIPR);
      ok(`dates ${tag}: a sideways drag still pans the chart, with no note left behind`, v1 && v2 && v2.c < v1.c - 0.5 && !after, JSON.stringify({ v0, v1, v2, after }));
    } else {
      await pointAt(p, 'rp', false); await p.keyboard.press('Escape'); await sleep(60);
      ok(`dates ${tag}: Esc puts the note away`, !(await p.evaluate(TIPR)));
      await p.mouse.move(5, 5); await sleep(60);
    }
    // the leaderboard's net sparkline and the table's fee bars: their dates in their label, a note on hover or a long press
    const mini = async (sel) => {
      const b = await p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const e = document.querySelector(sel); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = (e.querySelector('svg') || e).getBoundingClientRect(); return { x: r.left + r.width * 0.8, y: r.top + r.height / 2, aria: e.getAttribute('aria-label') }; }, sel);
      if (!b) return null;
      await sleep(60);
      if (phone) await p.evaluate(async ({ x, y }) => { const el = document.elementFromPoint(x, y), pe = (type) => el.dispatchEvent(new PointerEvent(type, { pointerId: 76, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointerup' ? 0 : 1 })); pe('pointerdown'); await new Promise((r) => setTimeout(r, 520)); pe('pointerup'); }, b);
      else await p.mouse.move(b.x, b.y);
      await sleep(90);
      return { ...b, tip: await p.evaluate(TIPR), sheet: await p.isVisible('#sheet') };
    };
    const sp = await mini('#bt-lead .spk'), fm = await mini('#all tbody tr.row td.fees .fmini');
    ok(`dates ${tag}: the leaderboard's sparkline says its dates and shows the date and net there`, sp && / to /.test(sp.aria) && DATE_RE.test(sp.aria) && sp.tip && DATE_RE.test(sp.tip.txt) && /net /.test(sp.tip.txt), JSON.stringify(sp).slice(0, 160));
    ok(`dates ${tag}: a row's fee bar says its dates and shows the day and its LP fees${phone ? ' (a long press, which opens nothing)' : ''}`, fm && / to /.test(fm.aria) && fm.tip && DATE_RE.test(fm.tip.txt) && /LP fees/.test(fm.tip.txt) && !fm.sheet, JSON.stringify(fm).slice(0, 160));
    if (phone) { await p.evaluate(FINGERS, { steps: 1, ms: 10, pts: [{ id: 77, x0: 5, y0: 300, x1: 5, y1: 300 }] }); await sleep(60); }
    // the detail panel: its daily strip, price and fee sparklines, the hourly and daily fee history
    const nr = Object.entries(FXD.history.pools).find(([, h]) => Array.isArray(h.h) && h.h.slice(2, -2).some((r) => r[3] === null));
    await openPool(p, nr ? nr[0].slice(0, 10) : FXD.live.pools[0].id.slice(0, 10));
    for (const id of ['daily-detail', 'd-px', 'd-fees', 'd-hr', 'd-day']) { await axisAt(id); await tipAt2(id, DATE_RE, { root: '#sheet' }); if (id === 'd-hr') await shot(`dates-${tag}-hourly`); }
    const px1 = tips[tips.length - 4] || '';
    ok(`dates ${tag}: a price point's note gives the price and whether today's range holds it`, /price .*range .*(yes|no)/.test(px1), px1.slice(0, 100));
    await tipAt2('liq-detail', /liquidity/);
    // an unread hour reads as a dash, never as 0 (zoomed in, so its bar is wide enough to point at on any screen)
    for (let k = 0; k < 3 && (await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="zoom"][data-chart="d-hr"][data-dir="1"]'); if (!b || b.disabled) return false; b.click(); return true; })); k++) await sleep(80);
    for (let k = 0; k < 12 && (await p.evaluate(() => { const h = document.querySelector('#sheet [data-pz="d-hr"]'), hr = h.getBoundingClientRect(), r = [...h.querySelectorAll('rect.unread')].find((x) => { const b = x.getBoundingClientRect(); return b.left > hr.left + 40 && b.right < hr.right - 40; }); if (r) return false; const e = h.querySelector(':scope > .pz-edge.l:not([hidden])'); if (!e) return false; e.click(); return true; })); k++) await pzSettled(p, 'd-hr');
    const un = await p.evaluate(() => { const h0 = document.querySelector('#sheet [data-pz="d-hr"]').getBoundingClientRect(), r = [...document.querySelectorAll('#sheet [data-pz="d-hr"] rect.unread')].find((x) => { const b = x.getBoundingClientRect(); return b.left > h0.left + 40 && b.right < h0.right - 40; }); if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(), h = document.querySelector('#sheet [data-pz="d-hr"]').getBoundingClientRect(); return { fx: (b.left + b.width / 2 - h.left) / h.width }; });
    if (un) { const r = await pointAt(p, 'd-hr', phone, { fx: un.fx, root: '#sheet' }); ok(`dates ${tag}: an unread hour's note says ${'—'} (not read), never $0`, r && /LP fees — \(not read\)/.test(r.txt) && !/\$0\b/.test(r.txt), JSON.stringify(r)); }
    else ok(`dates ${tag}: the pool with an unread hour shows it`, false, 'no unread bar ' + JSON.stringify(await p.evaluate(() => { const h = document.querySelector('#sheet [data-pz="d-hr"]'), hr = h.getBoundingClientRect(); return { view: h.dataset.view, hw: Math.round(hr.width), hl: Math.round(hr.left), un: [...h.querySelectorAll('rect.unread')].map((x) => { const b = x.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; }).slice(0, 6), edge: !!h.querySelector(':scope > .pz-edge.l:not([hidden])') }; })));
    // zoomed all the way in, the hourly fees show hours; zoomed out, days
    for (let k = 0; k < 6 && (await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="zoom"][data-chart="d-hr"][data-dir="1"]'); if (!b || b.disabled) return false; b.click(); return true; })); k++) await sleep(80);
    const zin = await axisAt('d-hr');
    for (let k = 0; k < 6 && (await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="zoom"][data-chart="d-hr"][data-dir="-1"]'); if (!b || b.disabled) return false; b.click(); return true; })); k++) await sleep(80);
    const zout = await axisAt('d-hr');
    ok(`dates ${tag}: the axis follows the zoom: hours zoomed in (${zin.labs.slice(0, 3).join(', ')}), days zoomed out (${zout.labs.slice(0, 3).join(', ')})`, zin.labs.some((l) => /\d\d:\d\d/.test(l)) && zout.labs.every((l) => !/^\d\d:\d\d$/.test(l)), JSON.stringify([zin.labs, zout.labs]));
    // panned, the ticks move with the data and stay inside the box, none touching
    await p.evaluate(() => { const b = document.querySelector('#sheet [data-pz="d-day"] > .pz-edge.l:not([hidden])'); if (b) b.click(); }); await sleep(500);
    const pan = await axisAt('d-day');
    ok(`dates ${tag}: every time chart has a date axis, none touching or past its box, zoomed or panned, and every note has a date (${tips.length} notes)`, bad.length === 0 && pan.ok, bad.slice(0, 3).join(' | '));
    ok(`dates ${tag}: no note reads NaN, undefined or a blank`, tips.every((x) => x && !/NaN|undefined|Infinity|null/.test(x)), JSON.stringify(tips.filter((x) => !x || /NaN|undefined|Infinity|null/.test(x))).slice(0, 160));
    await p.click('#sheet-close'); await sleep(120);
    // the pop-out window (the owner's screenshot: a daily strip opened from the dashboard): the same axis and notes there
    await fillQ(p, '');
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#best [data-act="openchart"][data-chart="daily-best"]').click(); }); await sleep(150);
    const u = await p.evaluate(() => (window.__opened || []).slice(-1)[0] || '');
    const w2 = await t.ctx.newPage(), e2 = [];
    w2.on('pageerror', (e) => e2.push(String(e.message).slice(0, 100)));
    await w2.goto(u);
    await w2.waitForSelector('.solo-box [data-pz="daily-best"]', { timeout: 20000 }).catch(() => {});
    await sleep(300);
    const sa = await w2.evaluate(AXIS, { id: 'daily-best' }), st = await pointAt(w2, 'daily-best', phone, { fx: 0.3 });
    ok(`dates ${tag}: the pop-out window's daily strip has its date axis (${sa.labs.join(', ')}) and its note (${st ? st.txt.slice(0, 40) : '-'})`, sa.ok && sa.clash === 0 && sa.out === 0 && st && DATE_RE.test(st.txt) && /per \$1,000/.test(st.txt) && st.inside && e2.length === 0, JSON.stringify({ sa, st, e: e2[0] }).slice(0, 200));
    if (!phone) await (async () => { if (!SHOTS) return; await w2.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;left:0;right:0;bottom:0;z-index:99;padding:3px;text-align:center;font:700 11px/1.3 monospace;letter-spacing:.08em;background:#E8B84A;color:#06080B;pointer-events:none">TEST FIXTURES · MADE-UP NUMBERS</div>')); await snap(w2, `dates-${tag}-popout`); })();
    await w2.close();
    ok(`dates ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // the planted fault: the same check on a page whose daily strip lost its axis
  const html = fs.readFileSync(PAGE_OVERRIDE || PAGE, 'utf8'), cut = html.replace('mid: true, tAt: (u) => kAt(ts, u, D), uAt: (t) => kU(ts, t, D), axis: () => taxOf(id), ', 'mid: true, tAt: (u) => kAt(ts, u, D), uAt: (t) => kU(ts, t, D), ');
  if (cut === html) ok('dates: planted: the axis line to take out is in the page', false);
  else await testDates(browser, cut.replace(/script-src [^;]*;/, `script-src ${scriptHashes(cut).join(' ')};`));
}

const groups = { unlock: testUnlock, layout: testLayout, windows: testWindows, states: testStates, tabs: testTabs, daily: testDaily, pairs: testPairs, charts: testCharts, pan: testPan, depth: testDepth, history: testHistory, stable: testStable, touch: testTouch, sheets: testSheets, sticky: testSticky, top: testTop, header: testHeader, zoomfit: testZoomFit, overlap: testOverlap, rows: testRows, refresh: testRefresh, market: testMarket, fav: testFav, table: testTable2, similar: testSimilar, chains: testChains, highlight: testHighlight, search: testSearch, links: testLinks, terms: testTerms, fold: testFold, locknote: testLockNote, clicks: testClicks, motion: testMotion, merge: testMerge, feebar: testFeeBar, stablewalk: testStableWalk, flash: testFlash, dates: testDates };
const REPEAT = Math.max(1, Math.min(9, +opt('repeat', 1) || 1)); // --repeat N: the groups N times over (hunting a timing fault)
try {
  for (let rep = 0; rep < REPEAT; rep++) for (const g of ONLY) {
    if (!groups[g]) continue;
    const s = Date.now();
    try { await groups[g](browser); } catch (e) { if (process.env.ST_DEBUG) console.error(e.stack); ok(`${g}: ran to the end`, false, String(e.message).split('\n')[0].slice(0, 160)); }
    console.log(`  · ${g} ${((Date.now() - s) / 1000).toFixed(1)} s`);
  }
} finally {
  await browser.close();
  srv.close();
  fs.rmSync(FX, { recursive: true, force: true });
}
const fails = results.filter((r) => !r.pass);
if (flag('verbose')) for (const r of results.filter((x) => x.pass)) console.log(`pass ${r.name}`);
for (const f of fails) console.log(`FAIL ${f.name}${f.why ? ' · ' + f.why : ''}`);
console.log(`site-test ${BROWSER}${DEVICE ? ' as ' + DEVICE : ''}: ${results.length} checks · ${fails.length} fail · widths ${[...WIDTHS, ...LAPTOP].join('/') || '-'} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(fails.length ? 1 : 0);
