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
//                                                    merge feebar stablewalk flash dates feescale perday disc view
//                                                    balance wraps floorlab iphone back pull full way qsearch (v0.5.1) stress (v0.5.2)
//                                                    workspace compare deeplink tiers (v0.6.0; history, way and flash follow the workspace and the tiers' build-up)
//                                                    tools (v0.6.2: the chart toolbar everywhere, the replay's labels, quiet hours)
//                                                    guest member guestend guestadmin recovery passchange mismatch (v0.7.0: key slots, the alarm)
//                                                    histbtn (every History button clear of its neighbours; All combined a toggle)
//                                                    apr (v0.7.1: APR up front: the workspace chip, the Overview hero, the count-up, History's fee APR chart, every pool row)
//                                                    errbadge (v0.7.2: a page error shows a calm badge by the version; its sheet sanitized, Copy, Close, Dismiss)
//   node tools/site-test.mjs --page <file>          test another copy of the page (planted faults)
//   node tools/site-test.mjs --verbose              also list every passing check
//   node tools/site-test.mjs --repeat 3              run the chosen groups 3 times over (a timing fault shows up sooner)
//   node tools/site-test.mjs --fix-csp               rewrite the page's CSP script hash after an edit (the --page copy if given), then exit
//   node tools/site-test.mjs --mode 3d|2d            v0.5.0: every page starts in that look (3D or Classic 2D), kept as if chosen;
//                                                    without it each page takes its own default (3D, Classic 2D under reduced motion)
//
// Playwright comes from the environment (NODE_PATH); never npm install in the repo.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFixtures, makeData, oldDepth, tinyCase, FIXTURE_PASSPHRASE, STABLE_PROBE_ADDR, GUEST_PASS, EXPIRED_PASS, GUEST_NAME, NEW_PASS, RECOVERY_KEY, OWNER_TICKET, SHARED_PASS, MEMBER_PASS, MEMBER_NAME, ELI_PASS } from './fixtures/make-fixture.mjs';
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
  const html = fs.readFileSync(PAGE_OVERRIDE || PAGE, 'utf8');
  fs.writeFileSync(PAGE_OVERRIDE || PAGE, html.replace(/script-src [^;]*;/, `script-src ${scriptHashes(html).join(' ')};`));
  console.log('csp: script hash updated');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const pw = require('playwright');
const BROWSER = opt('browser', 'chromium');
const DEVICE = opt('device');
const SHOTS = opt('shots');
const ONLY = (opt('only') || 'unlock,layout,windows,market,states,tabs,daily,pairs,charts,pan,depth,history,stable,touch,sheets,sticky,top,header,zoomfit,overlap,rows,refresh,fav,table,similar,chains,highlight,search,links,terms,fold,locknote,clicks,motion,merge,feebar,stablewalk,flash,dates,feescale,perday,disc,view,balance,wraps,floorlab,iphone,back,pull,full,way,qsearch,stress,workspace,compare,deeplink,tiers,tools,guest,member,guestend,guestadmin,recovery,passchange,mismatch,histbtn,apr,errbadge').split(',');
const MODE = ['3d', '2d'].includes(opt('mode')) ? opt('mode') : null; // v0.5.0: the look every page starts in (null: the page's own default)
const WIDTHS = DEVICE ? [] : [360, 375, 390, 430, 768, 1024, 1300, 1440, 1920];
const LAPTOP = DEVICE ? [768, 1440] : [];

// the same made-up pass the page reads (pool ids, shapes and history rows don't depend on the time it is made at)
const FXD = makeData({ now: Date.now() });
const poolOf = (id) => FXD.live.pools.find((x) => x.id === id);
const FXT = tinyCase(FXD); // v0.6.2: the tiny case (four tiers, quiet hours, sub-cent replays)
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
async function newPage(browser, { phone = false, width = 390, height = 860, reducedMotion = 'no-preference', storage = null, stableDefault = false, flash = false, mode = MODE, dpr = null, mg = false } = {}) {
  if (!stableDefault) storage = { 'lps.stable': '1', ...(storage || {}) };
  if (mode) storage = { 'lps.view': mode, ...(storage || {}) }; // the look (--mode): set before the page's script reads it
  const base = phone && DEVICE ? { ...pw.devices[DEVICE] } : { viewport: phone ? { width: 390, height: 844 } : { width, height } }; // phone = 390 px here, the device in Actions
  if (BROWSER !== 'chromium') delete base.defaultBrowserType;
  const ctx = await browser.newContext({ ...base, reducedMotion, ...(dpr ? { deviceScaleFactor: dpr } : {}) });
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  if (!flash) await ctx.addInitScript(() => { window.__lpsNoFlash = true; });
  // v0.6.0: every tier of a pair is on by default; groups that read one pool's own bars start with them off (`mg: true` leaves
  // the page's default: the tiers group and the flash's build-up)
  if (!mg) await ctx.addInitScript(() => { window.__lpsMgOff = true; });
  await ctx.addInitScript(() => { window.__lpsHooks = {}; }); // the page hands its time axis to the dates check
  await ctx.addInitScript(() => { window.open = (u) => { (window.__opened ||= []).push(String(u)); return null; }; }); // "open in a new window" is recorded, not opened
  await ctx.addInitScript(() => new MutationObserver(() => { // a chart's full view (v0.5.1): its address is recorded the same way (without full=1)
    const f = document.querySelector('#fullv iframe');
    if (!f || f.dataset.rec) return;
    f.dataset.rec = '1'; const u = new URL(f.src); u.searchParams.delete('full'); (window.__opened ||= []).push(u.toString());
    if (!window.__keepFull) { const c = document.querySelector('#fullv [data-act="fullclose"]'); if (c) c.click(); }
  }).observe(document, { childList: true, subtree: true }));
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
  await page.evaluate(() => { const b = document.querySelector('#sim [data-act]:not([data-act="ws-hist"])'); if (b) b.click(); }); // a similar pool (v0.6.0: its head's first button is History)
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
  const inScroll = (el) => !!el.closest('.tbl-box, .heat-box, .sheet-body, .tabs, .mc-track'); // a swipe strip's cards (v0.4.8: the discovery lanes)
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
    const pick = await p.evaluate(() => { const r = [...document.querySelectorAll('#sheet tr[data-act="pair-row"]')].find((x) => !x.classList.contains('gold') && /ETH · v3|ETH$/.test(x.children[0].textContent.replace(/History$/, '')) && /· ETH/.test(x.children[0].textContent.replace(/History$/, ''))); return r ? r.dataset.id : document.querySelector('#sheet tr[data-act="pair-row"]:not(.gold)').dataset.id; });
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
    const geo = await p.evaluate(() => [...document.querySelectorAll('.ctools')].filter((c) => c.offsetParent).map((c) => { const z = c.querySelector('.zseg').getBoundingClientRect(), o = c.querySelector('.openwin').getBoundingClientRect(); return { gap: o.left - z.right, h: o.height, w: o.width, mw: matchMedia('(pointer:coarse)').matches ? 43.5 : 31.5 }; }));
    ok(`charts ${tag}: on every chart the open button stands ≥ 10 px from the zoom pair, 44 px tall, 44 wide on touch (${geo.length})`, geo.length >= 3 && geo.every((g) => g.gap >= 10 && g.h >= 43.5 && g.w >= g.mw), JSON.stringify(geo[0]));
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
      const n0 = await p.evaluate(() => (window.__opened || []).length);
      await p.evaluate((id) => document.querySelector(`#sheet [data-act="openchart"][data-chart="${id}"]`).click(), id);
      // v0.6.0: a pool's chart opens the pool's workspace on that chart's tab; any other, its own page (the full view). A slow
      // WebKit can take longer than a fixed wait to draw a year of History: wait for either, never a set time
      await p.waitForFunction((n0) => { const w = document.querySelector('#ws'); return (w && !w.hidden) || (window.__opened || []).length > n0; }, n0, { timeout: 6000 }).catch(() => {});
      await sleep(100);
      const wsTab = await p.evaluate(() => { const w = document.querySelector('#ws'); return w && !w.hidden && window.__lpsHooks.ws ? window.__lpsHooks.ws().tab : null; });
      if (wsTab) { if (before === after || !['overview', 'history', 'liquidity'].includes(wsTab)) bad.push(id + ':' + wsTab); await p.keyboard.press('Escape'); await sleep(250); continue; }
      const u = await p.evaluate(() => (window.__opened || []).slice(-1)[0] || '');
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
// the rubber-band end a held drag shows: wait (frames, up to 2 s) until the page has drawn it, then read it; WebKit on a
// CI runner can take longer than any fixed sleep to paint the frame that adds it
const pzEndRead = (page, id, side) => page.evaluate(async ({ id, side }) => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r())), t0 = performance.now(), sel = `[data-pz="${id}"] .pz-end${side ? '.' + side : ''}`;
  await frame(); await frame();
  while (!document.querySelector(sel) && performance.now() - t0 < 2000) await frame();
  await frame();
  return [...document.querySelectorAll(sel)].map((x) => x.className + '|' + x.textContent).join();
}, { id, side });
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
    const end = await pzEndRead(p, 'liq-best', ''), mid = await pzView(p, 'liq-best');
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
    await pzClick(p, '[data-act="openchart"][data-chart="liq-best"]'); await sleep(250);
    // v0.6.0: ⧉ opens the pool's workspace on Liquidity, on that very view; the chart's own page keeps the same address
    const inWs = await p.evaluate(() => { const w = document.querySelector('#ws'); return !!w && !w.hidden; });
    if (inWs) {
      const wv = await pzView(p, 'liq-ws');
      ok(`pan ${tag}: ⧉ opens the workspace on that very view (zoom and pan carried)`, !!wv && near(wv.c, here.c, 2e-3) && near(wv.w, here.w), `${JSON.stringify(wv)} vs ${JSON.stringify(here)}`);
      await p.keyboard.press('Escape'); await sleep(250);
    }
    const u = inWs ? await p.evaluate((id) => window.__lpsHooks.soloUrl('liq-best', id), await p.getAttribute('#best [data-act="detail"]', 'data-id')) : await p.evaluate(() => window.__opened.slice(-1)[0]);
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
  // a tap, as a finger makes it, if a synthetic click alone didn't open it (a drag just before leaves the page reading the next click as its end)
  if (!(await p.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => null))) {
    const st = await p.evaluate(() => ({ rows: document.querySelectorAll('#all tbody tr.row').length, q: document.querySelector('#f-q').value.length }));
    console.log(`  openPool: a second try (${st.rows} rows, ${st.q} characters searched)`);
    await p.locator('#all tbody tr.row td:nth-child(3)').first().click();
    await p.waitForSelector('#sheet:not([hidden])');
  }
  await sleep(300);
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
    await pzDrag(p, 'liq-best', -160, { up: false });
    const endR = await pzEndRead(p, 'liq-best', 'r');
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
    await pzDrag(p, 'liq-detail', -160, { up: false });
    const endQ = await pzEndRead(p, 'liq-detail', 'r');
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

// ---------- 4f3. history.json: LP fees per hour (14 days) ----------
// Each row's fees cover the time since the row before: a bar spans that stretch at fees ÷ its hours (a gap the backfill
// hasn't filled is one wide bar at its average), the first row draws nothing, an unread row is hatched; the view pans and
// zooms in time and zooming out stops at the rows' own span. v0.4.7: heights on the view's own $ scale (0 to a round top).
// The day chart (the fee history) has its own group: feescale.
const RATE_LOOK = (id) => {
  const h = document.querySelector(`[data-pz="${id}"]`), box = h.closest('[data-chartbox]');
  return { view: h.dataset.view, rects: [...h.querySelectorAll('.pz-c svg > rect[class^="b-"]')].map((r) => ({ x: +r.getAttribute('x'), w: +r.getAttribute('width'), h: +r.getAttribute('height') })),
    unread: h.querySelectorAll('.pz-c svg > rect.unread').length, title: box.querySelector('.pane-title > .lbl').textContent, cap: (box.querySelector('.pz-cap2') || {}).textContent || '',
    out: box.querySelector('[data-act="zoom"][data-dir="-1"]').disabled, Ht: +h.querySelector('.pz-c svg').getAttribute('height') };
};
function rateExpect(rows, vi, unit, view, Ht) {
  const t0 = rows[0][0], U = (t) => (t - t0) / unit, bars = [];
  for (let i = 1; i < rows.length; i++) { const a = rows[i - 1][0], b = rows[i][0], v = rows[i][vi]; bars.push({ a: U(a), b: U(b), r: typeof v === 'number' ? v / ((b - a) / unit) : null }); }
  const [c, len] = view, v0 = c - len, seen = bars.filter((x) => x.b > v0 && x.a < c), mx = Math.max(...seen.filter((x) => x.r != null).map((x) => x.r));
  const step = fcNiceT(mx / 3), top = Math.ceil(mx / step - 1e-9) * step;
  return { n: U(rows.at(-1)[0]), unread: seen.filter((x) => x.r == null).length, max: mx,
    bars: seen.filter((x) => x.r > 0).map((x) => { const full = ((x.b - x.a) / len) * 300; return { x: ((x.a - v0) / len) * 300, w: Math.max(0.4, full - Math.min(1, full * 0.25)), h: (x.r / top) * Ht }; }) };
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
  const H = 3600e3, ents = Object.entries(FXD.history.pools);
  const gapP = ents.find(([, e]) => e.h.some((r, i) => i && r[0] - e.h[i - 1][0] > 1.5 * H) && e.h.length > 300);
  const nrP = ents.find(([, e]) => e.h.slice(1).some((r) => r[3] === null) && e.h.length > 300);
  for (const phone of [false, true]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    for (const [id, e] of [gapP, nrP]) {
      await openPool(p, id.slice(0, 12));
      const cid = 'd-hr', rows = e.h;
      let a = await p.evaluate(RATE_LOOK, cid);
      const view = a.view.split(',').map(Number), x = rateExpect(rows, 3, H, view, a.Ht), m = rectsMatch(a.rects, x.bars);
      const lv = phone ? 2 : 1; // a phone opens the hourly fees on their latest 7 days
      ok(`history ${tag}: fees per hour over 14 days, one bar per row at fees ÷ the hours since the row before, on the view's $ scale (${a.title.slice(0, 40)})`, /^LP fees per hour · 14 d · /.test(a.title) && near(view[1], x.n / lv, 0.02) && m.ok, a.title + ' ' + a.view + ' ' + m.why);
      ok(`history ${tag}: …unread rows hatched (${x.unread}), the first row and gaps never drawn as 0, its max ${a.cap} the data's`, a.unread === x.unread && Math.abs(money(a.cap) - x.max) / x.max < 0.06, `${a.unread}/${x.unread} ${a.cap} vs ${x.max.toFixed(2)}`);
      if (lv === 1) ok(`history ${tag}: …zoomed all the way out it shows the whole span and − stops there`, a.out && near(view[1], x.n, 0.02), a.view);
      else {
        await zoomAllOut(p, cid, '#sheet');
        a = await p.evaluate(RATE_LOOK, cid);
        ok(`history ${tag}: …− shows the rest of the span, then stops at it`, a.out && near(+a.view.split(',')[1], x.n, 0.02), a.view);
        await p.evaluate((cid) => document.querySelector(`#sheet [data-act="zreset"][data-chart="${cid}"]`).click(), cid); await sleep(120); // zoom is kept per chart
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
    const q = await p.evaluate(() => ({ opts: [...document.querySelectorAll('#q-list .qopt')].map((e) => e.textContent), note: (document.querySelector('#q-stat .qnote') || {}).textContent || '', open: !document.querySelector('#q-bar').hidden }));
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
    let T, real = true;
    try { T = (x, y) => new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y }); T(0, 0); } catch (e) { real = false; T = (x, y) => ({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y }); }
    // WebKit has no Touch(): the same events as plain events carrying their touches, so the sheet's own handlers run there too
    const mk = (type, init) => { if (real) return new TouchEvent(type, init); const e = new Event(type, { bubbles: true, cancelable: true }); for (const k of ['touches', 'targetTouches', 'changedTouches']) Object.defineProperty(e, k, { value: init[k] }); return e; };
    const fire = (type, x, y) => { const t = T(x, y); target.dispatchEvent(mk(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })); };
    fire('touchstart', x0, y0);
    for (let i = 1; i <= steps; i++) { await new Promise((r2) => setTimeout(r2, ms)); fire('touchmove', x0 + (dx * i) / steps, y0 + (dy * i) / steps); }
    fire('touchend', x0 + dx, y0 + dy);
    return real ? 'touch' : 'touch-like';
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
  ok('sheets phone: a grab handle tops the sheet', g.h >= 15.9 && g.top >= 0 && g.top < 40 && g.ta === 'none', JSON.stringify(g));
  ok('sheets phone: the close button stays', await p.isVisible('#sheet-close'));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'sheet-phone-handle.png') });
  // a short, slow pull springs back
  let how = await pull(p, '#sheet .grab', 50, { ms: 40, steps: 6 });
  await p.waitForFunction(() => { const c = document.querySelector('#sheet .sheet-card'); return !c.getAnimations().some((a) => a.playState === 'running') && new DOMMatrix(getComputedStyle(c).transform).m42 === 0; }, null, { timeout: 4000 }).catch(() => {});
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
  // from the content: never (v0.4.7, the owner's iPhone: a drag down on a chart at the top made it "disappear into nothing");
  // a downward drag there scrolls or rubber-bands. Only the handle and the header row drag the sheet.
  await open();
  for (const [st, sel, what] of [[300, '#sheet-body', 'scrolled content'], [0, '#sheet-body', 'content at its top'], [0, '#sheet-body [data-pz="liq-detail"]', 'chart at the top of the content']]) {
    await p.$eval('#sheet-body', (b, st) => { b.scrollTop = st; }, st); await sleep(100);
    const mv = await p.evaluate(() => { window.__swMax = 0; const c = document.querySelector('#sheet .sheet-card'), f = () => { if (!window.__swOn) return; window.__swMax = Math.max(window.__swMax, Math.abs(new DOMMatrix(getComputedStyle(c).transform).m42)); requestAnimationFrame(f); }; window.__swOn = true; requestAnimationFrame(f); return true; });
    how = await pull(p, sel, 260, { at: 0.5 });
    await sleep(500);
    const moved = await p.evaluate(() => { window.__swOn = false; return window.__swMax; });
    ok(`sheets phone: a pull down on the ${what} never moves or closes the sheet (${how})`, mv && (await isOpen()) && (await ty()) === 0 && moved === 0, String(moved));
  }
  how = await pull(p, '#sheet .sheet-head h2', 320);
  await sleep(500);
  ok(`sheets phone: a pull down on the header row closes it (${how})`, !(await isOpen()));
  await open();
  await pull(p, '#sheet .sheet-head h2', 30, { dx: 200 });
  await sleep(450);
  ok('sheets phone: a sideways swipe on the header doesn\'t close it', await isOpen());
  // the similar-pools list scrolls inside the content: a pull there scrolls it, never drags the sheet
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
  const ctl = head ? [...head.querySelectorAll('.ctools > *')] : []; // its groups (v0.6.2: reset sits in the zoom pill)
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
        && (await p.evaluate(() => document.querySelector('#sheet-main').firstElementChild.dataset.chartbox)) === 'liq-detail';
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
    ok(`market ${tag}: ETH, BTC and SOL with a 24 h arrow each (▲ up, ▼ down), a price from Coinbase labelled "coinbase" ("cb" under 380 px)`, a.px.map((x) => x.c).join() === 'ETH,BTC,SOL' && a.px[0].up && a.px[1].dn && a.px[2].up
      && /^ETH \$3,400 ▲1\.2%$/.test(a.px[0].t) && /^BTC \$96\.2K ▼0\.4% (coinbase|cb)$/.test(a.px[1].t) && (tag === 'w360') === / cb$/.test(a.px[1].t) && /^SOL \$182 ▲3\.1%$/.test(a.px[2].t), a.px.map((x) => x.t).join(' | '));
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
  ok('market: an unread price and an unread 24 h change show —, never 0', /^SOL — —$/.test(a.px[2].t) && /^BTC \$96\.2K —( coinbase)?$/.test(a.px[1].t) && !/\$0\b|0\.0%|\b0 gwei/.test(a.px.map((x) => x.t).join(' ') + a.gas), a.px.map((x) => x.t).join(' | '));
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
    ok(`fav ${tag}: a favourite card opens that pool, shape first`, (await p.isVisible('#sheet')) && (await p.evaluate(() => document.querySelector('#sheet-main').firstElementChild.dataset.chartbox)) === 'liq-detail');
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
    ok(`table ${tag}: "What the Why icons mean" unfolds a plain-words legend (${lg.n})`, (await p.getAttribute('#why-tog', 'aria-expanded')) === 'true' && lg.n === 15 && /Toxic flow: Traders here tend to know/.test(lg.t) && /Stranded: Most of the money sits far from the price/.test(lg.t), lg.t.slice(0, 60));
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
      end: (document.querySelector('#sim [data-act="sim-all"]') || {}).innerText, head: document.querySelector('#sim .mc-head').innerText, inHead: !!document.querySelector('#sheet-info #sim') && !document.querySelector('.sheet-head #sim'),
      first: document.querySelector('#sheet-main').firstElementChild.dataset.chartbox }));
    let a = await read();
    const want = expectSimilar(live, pool, '30d');
    ok(`similar ${tag}: a strip of mini cards sits at the top of the pool's content (under the slim header), this pool first and outlined`, a.inHead && a.self.length === 1 && a.ids[0] === id && a.self[0] === id && a.first === 'liq-detail', JSON.stringify(a).slice(0, 100));
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
    const fades = await p.evaluate(async () => { const t = document.querySelector('#sim .mc-track'), w = t.parentElement, a = [w.classList.contains('fl'), w.classList.contains('fr')]; t.scrollLeft = t.scrollWidth; for (let i = 0; i < 30 && !(w.classList.contains('fl') && !w.classList.contains('fr')); i++) await new Promise((r) => setTimeout(r, 50)); /* the strip's scroll event comes a frame or more later on a slow WebKit */ return [...a, w.classList.contains('fl'), w.classList.contains('fr'), getComputedStyle(t).scrollSnapType]; });
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
      act: document.querySelector('#f-q').getAttribute('aria-activedescendant'), exp: document.querySelector('#f-q').getAttribute('aria-expanded'), hint: (document.querySelector('#q-hint') || {}).textContent || '', v: document.querySelector('#f-q').value, focus: document.activeElement === document.querySelector('#f-q'),
      rows: [...document.querySelectorAll('#all tbody tr.row .pn2')].map((x) => x.textContent) }));
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('#f-q').scrollIntoView({ block: 'start' }); });
    await p.click('#f-q'); await p.keyboard.type('vel', { delay: 30 }); await sleep(200);
    let a = await list();
    ok(`search ${tag}: typing opens suggestions, likeliest first (prefix, then volume)`, a.on && a.exp === 'true' && a.items[0] === 'PAIR VELNA/WETH' && a.items[1] === 'TOKEN VELNA', a.items.join(' | '));
    ok(`search ${tag}: no greyed completion: the field holds exactly what was typed`, a.hint === '' && a.v === 'vel', JSON.stringify({ hint: a.hint, v: a.v }));
    if (SHOTS) await snap(p, `p2-search-${tag}`, '#all');
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await sleep(80);
    a = await list();
    ok(`search ${tag}: arrow keys move through the list (aria-activedescendant)`, a.act === 'qo-1');
    await p.keyboard.press('ArrowUp'); await p.keyboard.press('Enter'); await sleep(250);
    a = await list();
    ok(`search ${tag}: Enter picks it: the table filters to that pair (native ETH included)`, !a.on && a.v === 'VELNA/WETH' && a.rows.length === 4 && a.rows.every((x) => /^VELNA\/(W?ETH)$/.test(x)), a.rows.join(','));
    // Enter (the Search key) keeps what was typed and only puts the keyboard away
    await p.focus('#f-q'); await p.fill('#f-q', ''); await p.keyboard.type('num', { delay: 30 }); await sleep(150);
    await p.keyboard.press('Enter'); await sleep(250);
    a = await list();
    ok(`search ${tag}: Enter keeps the text, filters and leaves the field (the keyboard goes)`, a.v === 'num' && !a.focus && !a.on && a.rows.length >= 1 && a.rows.every((x) => x.includes('NUMA')), JSON.stringify({ v: a.v, focus: a.focus, rows: a.rows.length }));
    await p.focus('#f-q');
    // a tap picks too; a token beats pairs on a word start
    await p.fill('#f-q', ''); await p.keyboard.type('wet', { delay: 20 }); await sleep(150);
    a = await list();
    ok(`search ${tag}: a token that matches from its start ranks first ("wet")`, a.items[0] === 'TOKEN WETH', a.items.slice(0, 3).join(' | '));
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
    await p.focus('#f-q'); await p.fill('#f-q', ''); await p.keyboard.type('<img', { delay: 20 }); await sleep(150);
    a = await list();
    ok(`search ${tag}: planted: an HTML ticker is suggested as text, never run`, a.items.some((x) => x.includes('<img src=x')) && (await p.evaluate(() => window.__xss)) === undefined && (await p.$$('#q-list img')).length === 0);
    await p.keyboard.press('Escape'); await sleep(150);
    const e1 = await list();
    await p.keyboard.press('Escape'); await sleep(80);
    const e2 = await list();
    ok(`search ${tag}: Esc clears the field (the rows come back), a second Esc leaves it`, !e1.on && e1.v === '' && e1.focus && !e2.focus && e2.rows.length > 2, JSON.stringify({ v: e1.v, f1: e1.focus, f2: e2.focus }));
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
    // (v0.6.0: the overlap walk counts an icon's glyph unclipped; a chart's edge arrow half under the panel's top edge is hidden
    // by the scroll there, so the fold moves on until none straddles it)
    await p.evaluate(() => { const b = document.querySelector('#sheet-body'); b.scrollTop = 500; const top = b.getBoundingClientRect().top; for (let k = 0; k < 8; k++) { const s = [...b.querySelectorAll('.pz-edge:not([hidden])')].map((e) => e.getBoundingClientRect()).find((r) => r.top < top && r.bottom > top); if (!s) break; b.scrollTop += s.bottom - top + 2; } }); await sleep(380);
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
    const sb = await p.evaluate(STILL_BOX, { sel: '[data-pz="liq-best"]' }), hb = { x: sb.x + sb.w / 2, y: sb.y + 70 }; // in view and at rest first, as the live audit does
    // both taps (down, move, up each) dispatched back to back in one task: a slow WebKit can paint for 300-700 ms between a
    // tap's down and up when they are apart, and the page turns a touch held 420 ms into a scrub (its note) on purpose
    const onChart = await p.evaluate((hb) => { const el = document.elementFromPoint(hb.x, hb.y); if (!el || !el.closest('[data-pz="liq-best"]')) return false; for (const id of [51, 52]) for (const t of ['pointerdown', 'pointermove', 'pointerup']) el.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', isPrimary: true, clientX: hb.x, clientY: hb.y, bubbles: true, cancelable: true })); return true; }, hb);
    v1 = await pzSettled(p, 'liq-best');
    ok(`touch ${tag}: a double tap resets the chart`, onChart && near(v1.c, 0) && near(v1.w, 0.9), JSON.stringify({ ...v1, onChart }));
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

// ---------- 4n. v0.4.7: the detail panel's pinned top is one slim row that never changes height ----------
// The owner's iPhone: a top of about 320 px that folded part-way while scrolling made the scroll jump. Now one row (chain
// mark, pair, window, close) of 60 px at most; the kicker, meta, star, pair view, fee bar and similar pools scroll as content.
const SLIM = () => {
  const c = document.querySelector('#sheet .sheet-card'), h = document.querySelector('#sheet .sheet-head'), r = h.getBoundingClientRect(), b = document.querySelector('#sheet-body');
  return { pinned: Math.round(r.bottom - c.getBoundingClientRect().top), h: Math.round(r.height * 10) / 10, bodyTop: Math.round(b.getBoundingClientRect().top * 10) / 10, st: b.scrollTop, cls: c.className, tf: getComputedStyle(c).transform,
    mark: !!h.querySelector('.ttl > .cg'), title: !!h.querySelector('#sheet-title') && h.querySelector('#sheet-title').textContent.length > 2, win: h.querySelectorAll('#sheet-win button').length, close: !!h.querySelector('#sheet-close'),
    info: !!h.querySelector('#sheet-kicker, #sheet-meta, #sim, #sheet-fee, #sheet-star, #sheet-pair'), inBody: !!b.querySelector('#sheet-info #sheet-kicker') && !!b.querySelector('#sheet-info #sim') };
};
async function testFold(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['w360', { width: 360, height: 760 }], ['laptop', { width: 1440 }], ['phone reduced', { phone: true, reducedMotion: 'reduce' }]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page, lap = tag === 'laptop';
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(400);
    const s0 = await p.evaluate(SLIM);
    ok(`slim ${tag}: the pinned top is one row of ${s0.pinned} px (≤ 60): chain mark, pair, 24H/7D/30D, close`, s0.pinned <= 60 && s0.h <= 60 && s0.mark && s0.title && s0.win === 3 && s0.close, JSON.stringify(s0));
    ok(`slim ${tag}: the kicker, meta, star, pair view, fee bar and similar pools sit in the scrolling content`, !s0.info && s0.inBody, JSON.stringify(s0));
    // scroll the content a frame at a time: the top keeps its height, the content's box never moves, scrollTop follows exactly
    const walk = await p.evaluate(async (SLIMs) => {
      const SL = new Function('return (' + SLIMs + ')()'), b = document.querySelector('#sheet-body'), out = { jumps: 0, hs: new Set(), tops: new Set(), cls: new Set(), max: b.scrollHeight - b.clientHeight };
      const mo = new MutationObserver(() => { out.mut = (out.mut || 0) + 1; }); mo.observe(document.querySelector('#sheet .sheet-card'), { attributes: true, attributeFilter: ['class', 'style'] });
      mo.observe(document.querySelector('#sheet .sheet-head'), { attributes: true, attributeFilter: ['class', 'style'] });
      for (let y = 0; y <= Math.min(900, out.max); y += 18) {
        b.scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        const s = SL();
        if (Math.abs(s.st - y) > 1) out.jumps++;
        out.hs.add(s.h); out.tops.add(s.bodyTop); out.cls.add(s.cls);
      }
      for (let y = Math.min(900, out.max); y >= 0; y -= 30) { b.scrollTop = y; await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); const s = SL(); if (Math.abs(s.st - y) > 1) out.jumps++; out.hs.add(s.h); out.tops.add(s.bodyTop); }
      mo.disconnect();
      return { jumps: out.jumps, hs: [...out.hs], tops: [...out.tops], cls: [...out.cls], mut: out.mut || 0, max: out.max };
    }, SLIM.toString());
    ok(`slim ${tag}: scrolling down and back up, the top keeps one height (${walk.hs.join('/')} px), the content's box never moves and scrollTop never jumps`, walk.max > 400 && walk.hs.length === 1 && walk.tops.length === 1 && walk.cls.length === 1 && walk.jumps === 0 && walk.mut === 0, JSON.stringify(walk));
    // the wheel (a laptop) or a real scroll (WebKit too): it only ever moves the way it was pushed
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 0; }); await sleep(100);
    const bb = await p.locator('#sheet-body').boundingBox(), seq = [];
    await p.mouse.move(bb.x + bb.width / 2, bb.y + Math.min(300, bb.height / 2));
    // mobile WebKit has no wheel: a smooth scroll, which waits until it has stopped (on a slow runner a new smooth scroll
    // cancels the one still running, and eight of them once covered only 191 px: a test artefact, not the page)
    const push = async () => { try { await p.mouse.wheel(0, 90); } catch (e) { await p.evaluate(async () => { const b = document.querySelector('#sheet-body'), frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); b.scrollBy({ top: 90, behavior: 'smooth' }); let a = b.scrollTop, same = 0; for (const t0 = performance.now(); same < 3 && performance.now() - t0 < 1500;) { await frame(); if (Math.abs(b.scrollTop - a) < 0.5) same++; else { same = 0; a = b.scrollTop; } } }); } };
    for (let i = 0; i < 8; i++) { await push(); await sleep(60); seq.push(await p.evaluate(() => [document.querySelector('#sheet-body').scrollTop, Math.round(document.querySelector('#sheet .sheet-head').getBoundingClientRect().height)])); }
    // where it ends: once the last smooth scroll has stopped (the same scrollTop over 3 drawn frames, up to 4 s)
    seq.push(await p.evaluate(async () => { const b = document.querySelector('#sheet-body'), frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); let a = b.scrollTop, same = 0; for (const t0 = performance.now(); same < 3 && performance.now() - t0 < 4000;) { await frame(); if (Math.abs(b.scrollTop - a) < 0.5) same++; else { same = 0; a = b.scrollTop; } } return [b.scrollTop, Math.round(document.querySelector('#sheet .sheet-head').getBoundingClientRect().height)]; }));
    ok(`slim ${tag}: the wheel (or a smooth scroll) moves the content evenly down, never back (${seq.map((x) => Math.round(x[0])).join(',')}), the top unchanged`, seq.every((x, i) => !i || x[0] >= seq[i - 1][0] - 0.5) && seq[seq.length - 1][0] > 200 && new Set(seq.map((x) => x[1])).size === 1, JSON.stringify(seq));
    if (SHOTS && tag === 'phone') { await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 520; }); await sleep(200); await p.screenshot({ path: path.join(SHOTS, 'slim-phone-scrolled.png') }); }
    // the pair view: the same slim top
    await p.click('#sheet-close'); await sleep(120);
    await p.evaluate(() => document.querySelector('#best h2 button[data-act="pair"]').click()); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    const pv = await p.evaluate(SLIM);
    ok(`slim ${tag}: the pair view has the same slim top (${pv.pinned} px)`, pv.pinned <= 60 && pv.win === 3 && pv.close && !pv.info, JSON.stringify(pv));
    ok(`slim ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}


// ---------- 5. click audit: press every control, check the DOM answered ----------
const SIG = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '') + (el.dataset.chart ? ':' + el.dataset.chart : '') + (el.dataset.dir ? ':' + el.dataset.dir : '') + (el.dataset.v ? ':' + el.dataset.v : '');
async function controls(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; };
    const all = [...document.querySelectorAll('button, select, input, [tabindex="0"], a[href]')].filter(vis);
    const sig = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '') + (el.dataset.chart ? ':' + el.dataset.chart : '') + (el.dataset.dir ? ':' + el.dataset.dir : '') + (el.dataset.v ? ':' + el.dataset.v : '');
    return { untagged: all.filter((el) => !el.dataset.act && !el.disabled).map((el) => el.outerHTML.slice(0, 60)), sigs: [...new Set(all.filter((el) => el.dataset.act && !el.disabled).map(sig))], disabled: all.filter((el) => el.disabled).map((el) => el.textContent.trim()) };
  });
}
async function press(page, sig) {
  // beat scroll-settle races: a wheel event first, then bring the control into view
  return page.evaluate((sig) => {
    const sigOf = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '') + (el.dataset.chart ? ':' + el.dataset.chart : '') + (el.dataset.dir ? ':' + el.dataset.dir : '') + (el.dataset.v ? ':' + el.dataset.v : '');
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
      if (!(await press(p, real))) { if (!/^(pan:|q-reset|q-clear)/.test(sig)) bad.push(sig + ' not found'); continue; } // an edge button shows only while there is more that way: testPan presses them; the search's Clear only while a filter is on: testQsearch presses it
      const act = real.split(':')[0];
      const handle = await p.evaluateHandle((sig) => [...document.querySelectorAll('[data-act]')].find((e) => (e.dataset.act + (e.dataset.w ? ':' + e.dataset.w : '') + (e.dataset.k ? ':' + e.dataset.k : '') + (e.dataset.to ? ':' + e.dataset.to : '') + (e.dataset.chart ? ':' + e.dataset.chart : '') + (e.dataset.dir ? ':' + e.dataset.dir : '') + (e.dataset.v ? ':' + e.dataset.v : '')) === sig && !e.disabled && !e.closest('svg') && e.offsetParent !== null), real); // (data-v too, as SIG: the look switch's two pills)
      if (act === 'lens' || act === 'chain') {
        const v = await handle.evaluate((s) => s.options[Math.min(1, s.options.length - 1)].value);
        await handle.asElement().selectOption(v);
      } else if (act === 'search') await handle.asElement().fill('VEL');
      else if (act === 'scrub') await handle.evaluate((s) => { s.value = String(Math.max(1, Math.floor(+s.max / 2))); s.dispatchEvent(new Event('input', { bubbles: true })); });
      const wasOn = act === 'view' && !!handle.asElement() && (await handle.evaluate((e) => e.getAttribute('aria-pressed') === 'true'));
      if (!['lens', 'chain', 'search', 'scrub'].includes(act)) { try { await handle.asElement().click({ timeout: 5000 }); } catch (er) { bad.push(sig + ' not clickable'); continue; } }
      await sleep(act === 'jump' || act === 'bt-row' ? 1400 : act === 'play' ? 800 : 350);
      const mut = await p.evaluate(() => window.__mut);
      let good = mut > 0;
      if (act === 'jump') good = await headingInView(p, real.split(':')[1]);
      // v0.6.0: History, ⤢ and a pool chart's ⧉ open the pool's workspace (then Esc closes it); other charts' ⧉ their own page
      const wsOn = () => p.evaluate(() => { const w = document.querySelector('#ws'); return !!w && !w.hidden; });
      if ((act === 'openchart' || act === 'ws-hist' || act === 'ws-open') && (await wsOn())) {
        const tb = await p.evaluate(() => window.__lpsHooks.ws().tab);
        await p.keyboard.press('Escape'); await sleep(300);
        good = ['overview', 'history', 'liquidity'].includes(tb) && (act !== 'ws-hist' || tb === 'history') && !(await wsOn());
      } else if (act === 'ws-hist' || act === 'ws-open') good = false;
      else if (act === 'openchart') {
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
      if (act === 'qfind') { good = await p.evaluate(() => document.activeElement === document.querySelector('#f-q')); await p.$eval('#f-q', (e) => e.blur()); } // the 🔍: to the search, ready to type
      if (act === 'win') good = good && (await p.getAttribute(`#winseg [data-w="${real.split(':')[1]}"]`, 'aria-pressed')) === 'true';
      if (act === 'sort') good = good && (await p.$$('#all-tbl thead th[aria-sort="ascending"], #all-tbl thead th[aria-sort="descending"]')).length === 1;
      // the look already on stays on (a no-op, like the other pressed pills); the other pill switches
      if (act === 'view') { const v = real.split(':')[1], on = await p.evaluate(() => (document.documentElement.classList.contains('m3d') ? '3d' : '2d')); good = (good || wasOn) && on === v; }
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
    const look = () => p.evaluate(MG_LOOK, ID), tap = async (qid) => { await p.evaluate((qid) => document.querySelector(`#sheet-body [data-act="merge"][data-id="${qid}"]`).click(), qid); await sleep(420); }; // (v0.6.0: a layer shrinks or grows in 280 ms)
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
    const hb = await p.evaluate(() => { const b = document.querySelector('#sheet-fee [data-act="ws-hist"]'); return b ? { w: +b.querySelector('svg').getAttribute('width'), t: b.textContent, h: b.getBoundingClientRect().height } : null; });
    ok(`feebar ${tag}: the pool header has a bigger bar (${hb && hb.w} px) that is a 44 px button to History (v0.6.0)`, hb && hb.w >= 140 && hb.h >= 43.5 && /\/d/.test(hb.t) && /History ›/.test(hb.t), JSON.stringify(hb));
    await pzClick(p, '#sheet-body [data-act="zoom"][data-chart="d-day"][data-dir="1"]'); await sleep(150);
    await pzClick(p, '#sheet-body [data-act="zoom"][data-chart="d-day"][data-dir="1"]'); await sleep(150);
    const zin = +(await p.getAttribute('[data-pz="d-day"]', 'data-view')).split(',')[1];
    await p.evaluate(() => document.querySelector('#sheet-body').scrollTo(0, 0)); await sleep(150);
    await p.click('#sheet-fee [data-act="ws-hist"]'); await sleep(600);
    const land = await p.evaluate(() => { const w = document.querySelector('#ws'); return { ws: !!w && !w.hidden, tab: window.__lpsHooks.ws ? window.__lpsHooks.ws().tab : null, tiers: window.__lpsHooks.ws ? window.__lpsHooks.ws().tiers : 'x' }; });
    ok(`feebar ${tag}: a tap opens the pool's History, every tier on (v0.6.0; the daily chart was zoomed to ${zin.toFixed(1)} days and stays)`, land.ws && land.tab === 'history' && land.tiers === null, JSON.stringify(land));
    await p.keyboard.press('Escape'); await sleep(300);
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
    // a time axis always shows at least two dates, whatever day it is (v0.5.1: on a phone the 30-day replay showed only
    // "1 Nov" for a day each month, from just after the 16th: the CI run of 14 Nov 2026 at 22:00 UTC found it)
    if (phone) {
      const one = await p.evaluate(() => {
        const D = 864e5, bad = [], timeTicks = window.__lpsHooks && window.__lpsHooks.timeTicks;
        if (!timeTicks) return { n: -1, first: 'the page has no axis to ask' };
        for (let s = Date.UTC(2026, 8, 1); s < Date.UTC(2026, 11, 1); s += 3 * 36e5)
          for (const days of [7, 14, 30]) for (const W of [200, 240, 280, 320, 360]) for (const px of [66, 78]) {
            const n = timeTicks(s, s + days * D, W, false, px).length;
            if (n < 2) bad.push(`${new Date(s).toISOString().slice(0, 13)} ${days} d ${W} px: ${n}`);
          }
        return { n: bad.length, first: bad[0] || '' };
      });
      ok(`dates ${tag}: a 7-, 14- or 30-day axis 200-360 px wide shows at least two dates on every start hour of three months`, one.n === 0, JSON.stringify(one));
    }
    // the main page: the best find's daily strip, the scanner's health, the scatter and the liquidity chart
    const shot = async (name) => { if (!SHOTS) return; await p.evaluate(() => { if (!document.querySelector('#fx-rib')) document.body.insertAdjacentHTML('beforeend', '<div id="fx-rib" style="position:fixed;left:0;right:0;bottom:0;z-index:99;padding:3px;text-align:center;font:700 11px/1.3 monospace;letter-spacing:.08em;background:#E8B84A;color:#06080B;pointer-events:none">TEST FIXTURES · MADE-UP NUMBERS</div>'); }); await snap(p, name); };
    for (const id of ['daily-best', 'health']) { await axisAt(id); await tipAt2(id, DATE_RE); if (id === 'daily-best') await shot(`dates-${tag}-daily`); }
    const d1 = tips[0] || '';
    ok(`dates ${tag}: a daily fee bar's note says the day, its fees per $1,000 and how it compares with the median`, /\$\d+\.\d\d per \$1,000/.test(d1) && /× the median/.test(d1) && DATE_RE.test(d1), d1.slice(0, 120));
    await tipAt2('liq-best', /liquidity .*(of the pool|not read)/);
    // a day whose fees come from its own swaps (history.json y src 's', 14 Nov 2026): exact, like the counters' days
    { const bp = poolOf(await bestId(p)), ys = (FXD.history.pools[bp.id] || {}).y || [], dd = bp.daily || [], i = dd.map((x) => x.t).findLastIndex((t) => ys.some((r) => r[0] === t && r[2] === 's'));
      const row = i >= 0 ? ys.find((r) => r[0] === dd[i].t) : null, vw = String(await p.getAttribute('[data-pz="daily-best"]', 'data-view')).split(',').map(Number), nt = i >= 0 ? await pointAt(p, 'daily-best', phone, { fx: (i + 0.5 - (vw[0] - vw[1])) / vw[1] }) : null, fee = row && /LP fees \$([\d,.]+)([KM]?)/.exec((nt && nt.txt) || '');
      const got = fee ? +fee[1].replace(/,/g, '') * ({ K: 1e3, M: 1e6 }[fee[2]] || 1) : null;
      ok(`dates ${tag}: a day whose fees come from its swaps reads exact in its note ("exact · from swaps"), with its fees`, !!nt && /exact · from swaps/.test(nt.txt) && !/estimated/.test(nt.txt) && got != null && Math.abs(got - row[1]) <= Math.max(0.006, row[1] * 0.051), JSON.stringify([i, row, nt && nt.txt]).slice(0, 200)); }
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
    // (v0.6.0: ⧉ opens the pool's workspace; the chart's own page keeps its address)
    const u = await p.evaluate(() => { const b = document.querySelector('#best [data-act="openchart"][data-chart="daily-best"]'); if (window.__lpsHooks.soloUrl) return window.__lpsHooks.soloUrl('daily-best', b.dataset.pool); window.dispatchEvent(new WheelEvent('wheel')); b.click(); return null; }) || (await sleep(150), await p.evaluate(() => (window.__opened || []).slice(-1)[0] || ''));
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

// ---------- 4p. v0.4.7: the fee charts' scale, which pool the bars are for, and a year of fee history ----------
const FCLOOK = (id) => {
  const box = document.querySelector(`[data-chartbox="${id}"]`), h = box.querySelector(`[data-pz="${id}"]`), svg = h.querySelector('.pz-c svg');
  const rc = (sel) => [...svg.querySelectorAll(sel)].map((r) => ({ x: +r.getAttribute('x'), w: +r.getAttribute('width'), y: +r.getAttribute('y'), h: +r.getAttribute('height'), f: r.getAttribute('fill'), op: r.getAttribute('fill-opacity'), cls: r.getAttribute('class') || '' }));
  const yb = box.querySelector('.yax').getBoundingClientRect();
  return { view: h.dataset.view.split(',').map(Number), title: box.querySelector('.fc-t').textContent, mode: box.dataset.fc, Ht: +svg.getAttribute('height'),
    ys: [...box.querySelectorAll('.yax > span')].map((s) => ({ t: s.textContent, y: s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2 - yb.top })),
    grid: [...svg.querySelectorAll('line.grid')].map((l) => +l.getAttribute('y1')), med: svg.querySelector('line.median') ? +svg.querySelector('line.median').getAttribute('y1') : null,
    bars: rc('rect[class^="b-"]'), unread: rc('rect.unread').length, legend: box.querySelector('.fc-leg').textContent, prog: (box.querySelector('.fc-prog') || {}).textContent || '',
    cap3: (box.querySelector('.pz-cap3') || {}).textContent || '', btn: [...box.querySelectorAll('.fc-ctl button')].map((b) => b.dataset.act + ':' + b.dataset.v + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')),
    tax: [...box.querySelectorAll('.tax > span')].map((s) => s.textContent).join('|') };
};
const fcNiceT = (x) => { const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; };
const medOf = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const closeTo = (txtV, v) => txtV != null && v != null && Math.abs(txtV - v) <= Math.max(0.006, Math.abs(v) * 0.051);
async function fcPick(p, act, v) { await p.evaluate(({ act, v }) => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector(`#sheet-body [data-act="${act}"][data-v="${v}"]`).click(); }, { act, v }); await sleep(250); }
async function testFeeScale(browser) {
  const D = 864e5, HP = FXD.history.pools, pools = FXD.live.pools;
  const self = pools.find((q) => q.pair === 'NUMA/USDC' && HP[q.id] && HP[q.id].y && q.feeTier === 0.003), peer = pools.find((q) => q.pair === 'NUMA/USDC' && q.id !== self.id && HP[q.id] && HP[q.id].y);
  const noY = pools.find((q) => HP[q.id] && !HP[q.id].y && HP[q.id].d.length > 30 && HP[q.id].u) || pools.find((q) => HP[q.id] && !HP[q.id].y && HP[q.id].d.length > 30);
  for (const phone of [true, false]) {
    const tag = phone ? 'phone' : 'laptop', t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page;
    await openPool(p, self.id.slice(0, 12));
    const ys = HP[self.id].y, N = ys.length;
    let a = await p.evaluate(FCLOOK, 'd-day');
    // the title says which pool; the default view is the latest 90 days of the year's fee history
    ok(`feescale ${tag}: the fee chart's title says which pool the bars are for (${a.title.slice(0, 70)})`, /LP fees per day · \d+ d · NUMA\/USDC · 0\.30% v4 · this pool$/.test(a.title) && a.mode === 'this', a.title);
    ok(`feescale ${tag}: it reads the fee history (y, ${N} days) and opens on the latest 90 (view ${a.view.map((x) => x.toFixed(1)).join(',')})`, near(a.view[0], N, 0.01) && near(a.view[1], 90, 0.2), JSON.stringify(a.view));
    // what is in view, from the made-up data: exact solid, estimated pale, unread hatched, unconfirmed hatched
    const inV = (v) => ys.filter((r, i) => i + 1 > v[0] - v[1] + 1e-9 && i < v[0] - 1e-9);
    const uy = new Set((HP[self.id].u && HP[self.id].u.y) || []), isU = (r) => uy.has(r[0]); // history.json u.y: unconfirmed days
    let vis = inV(a.view), vals = vis.map((r) => r[1]).filter((x) => typeof x === 'number');
    const mx = Math.max(...vis.filter((r) => typeof r[1] === 'number' && !isU(r)).map((r) => r[1])), step = fcNiceT(mx / 3), top = Math.ceil(mx / step - 1e-9) * step; // the scale: confirmed days only (an unconfirmed outlier runs off the top)
    const nx = vis.filter((r) => (r[2] === 'x' || r[2] === 's') && r[1] > 0).length, ne = vis.filter((r) => r[2] === 'e' && r[1] > 0).length, nn = vis.filter((r) => r[1] == null).length, nu = vis.filter(isU).length;
    ok(`feescale ${tag}: one bar a day in view: ${nx} exact solid, ${ne} estimated pale, ${nn} unread hatched (never 0)`, a.bars.filter((b) => b.cls.startsWith('b-x')).length === nx && a.bars.filter((b) => b.cls.startsWith('b-e') && b.op === '.38').length === ne && a.unread === nn && a.bars.filter((b) => / uc/.test(b.cls)).length === nu, JSON.stringify([a.bars.length, nx, ne, a.unread, nn, nu]));
    const yv = a.ys.map((x) => money(x.t) ?? (x.t === '$0' ? 0 : null));
    ok(`feescale ${tag}: a $ y-axis (${a.ys.map((x) => x.t).join(' ')}) with a gridline at each tick, 0 to ${money(a.ys[0] && a.ys[a.ys.length - 1].t) ?? '?'} ≥ the view's max`, a.ys.length >= 3 && a.grid.length === a.ys.length && yv[0] === 0 && closeTo(yv[yv.length - 1], top) && yv.every((v, i) => !i || v > yv[i - 1]) && a.ys.every((x, i) => !i || x.y < a.ys[i - 1].y), JSON.stringify([a.ys, top]));
    const tall = a.bars.filter((b) => b.cls.startsWith('b-x') && !/uc/.test(b.cls)).sort((x, y) => y.h - x.h)[0];
    ok(`feescale ${tag}: bar heights follow that scale (the tallest ${tall ? tall.h.toFixed(1) : '-'} px of ${a.Ht})`, tall && Math.abs(tall.h - (Math.max(...vis.filter((r) => (r[2] === 'x' || r[2] === 's') && !isU(r)).map((r) => r[1])) / top) * a.Ht) < 0.2, JSON.stringify([tall, top]));
    const med = medOf(vals);
    ok(`feescale ${tag}: a dashed "typical day (median)" line at the view's median with its value (${a.cap3})`, a.med != null && Math.abs(a.med - (a.Ht - (med / top) * a.Ht)) < 0.2 && /typical day \(median\)/.test(a.cap3) && closeTo(money(a.cap3), med) && /exact/.test(a.legend) && /estimated/.test(a.legend), JSON.stringify([a.med, med, a.cap3]));
    const yp = HP[self.id].yp;
    ok(`feescale ${tag}: the progress reads "exact ${yp.exact} of ${yp.age} days"`, a.prog.includes(`exact ${yp.exact} of ${yp.age} days`) && a.prog.includes(`${yp.est} estimated`), a.prog);
    // the note: the day, its fees, exact or estimated, ×median
    let r = await pointAt(p, 'd-day', phone, { fx: 0.995, root: '#sheet' });
    const last = ys[N - 1];
    ok(`feescale ${tag}: the latest day's note: its date, fees, "exact" and ×median (${r ? r.txt.slice(0, 70) : '-'})`, r && DATE_RE.test(r.txt) && closeTo(money(r.txt), last[1]) && /exact/.test(r.txt) && new RegExp(`${(last[1] / med >= 10 ? Math.round(last[1] / med) : (last[1] / med).toFixed(1)).toString().replace('.', '\\.')}× the median`).test(r.txt) && r.inside, JSON.stringify(r).slice(0, 200));
    await p.evaluate(() => { const c = document.querySelector('#ctip'); if (c) c.hidden = true; }); // (Escape would close the panel too)
    // log: decades, remembered on this device
    await fcPick(p, 'fscale', 'log');
    a = await p.evaluate(FCLOOK, 'd-day');
    const lv = a.ys.map((x) => money(x.t)), dec = lv.every((v) => v > 0 && Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-6 || Math.abs(Math.log10(v / 3) - Math.round(Math.log10(v / 3))) < 1e-6);
    ok(`feescale ${tag}: "log" turns the scale to decades (${a.ys.map((x) => x.t).join(' ')}), kept on this device`, dec && a.ys.length >= 2 && a.btn.includes('fscale:log*') && (await p.evaluate(() => localStorage.getItem('lps.flog'))) === '1', JSON.stringify([a.ys, a.btn]));
    const p2 = await t.ctx.newPage();
    await p2.goto(url('default')); await waitApp(p2); await openPool(p2, self.id.slice(0, 12));
    ok(`feescale ${tag}: …and still log after a reload`, (await p2.evaluate(FCLOOK, 'd-day')).btn.includes('fscale:log*'));
    await p2.close();
    await fcPick(p, 'fscale', 'lin');
    // zoom chips: 14 D · 90 D · 1 Y · ALL, the date axis follows
    const views = {};
    for (const [v, want] of [['14', 14], ['0', N], ['90', 90]]) { await fcPick(p, 'fzc', v); a = await p.evaluate(FCLOOK, 'd-day'); views[v] = { w: a.view[1], tax: a.tax, on: a.btn.includes(`fzc:${v}*`), want }; }
    ok(`feescale ${tag}: the chips show 14 days, all ${N} and 90 again, each pressed, the date axis following`, Object.values(views).every((x) => Math.abs(x.w - x.want) < 0.3 && x.on) && views['14'].tax !== views['0'].tax, JSON.stringify(views).slice(0, 300));
    // which pools: each tier side by side in its own colour; the whole pair stacked, the total in the note
    await fcPick(p, 'fmode', 'tiers');
    a = await p.evaluate(FCLOOK, 'd-day');
    const cols = new Set(a.bars.map((b) => (b.f.startsWith('url(') ? b.f.replace(/^url\(#uc-d-day-(\w+)\)$/, '#$1') : b.f).toUpperCase()));
    ok(`feescale ${tag}: "each tier" draws both NUMA/USDC pools side by side in their colours (${[...cols].join(' ')})`, a.mode === 'tiers' && /each tier \(2 pools\)$/.test(a.title) && cols.has('#16C784') && cols.has('#6EA9FF') && /0\.30% v4 this/.test(a.legend) && /0\.05% v3/.test(a.legend), JSON.stringify([a.title, [...cols], a.legend.slice(0, 80)]));
    await fcPick(p, 'fmode', 'pair');
    a = await p.evaluate(FCLOOK, 'd-day');
    r = await pointAt(p, 'd-day', phone, { fx: 0.995, root: '#sheet' });
    const lt = ys[N - 1][0], pv = (HP[peer.id].y.find((x) => x[0] === lt) || [])[1], want = typeof pv === 'number' && typeof last[1] === 'number' ? pv + last[1] : null;
    ok(`feescale ${tag}: "whole pair" stacks them, the note gives the total (${r ? r.txt.slice(0, 60) : '-'} vs ${want && want.toFixed(2)})`, a.mode === 'pair' && /whole pair \(2 pools combined\)$/.test(a.title) && r && closeTo(money((/whole pair (\S+)/.exec(r.txt) || [])[1]), want), JSON.stringify([a.title, r && r.txt.slice(0, 120)]));
    await p.evaluate(() => { const c = document.querySelector('#ctip'); if (c) c.hidden = true; });
    if (SHOTS && phone) { await p.evaluate(() => document.querySelector('[data-chartbox="d-day"]').scrollIntoView({ block: 'center' })); await sleep(200); await p.screenshot({ path: path.join(SHOTS, 'feescale-phone-pair.png') }); }
    await fcPick(p, 'fmode', 'tiers');
    if (SHOTS && phone) { await p.evaluate(() => document.querySelector('[data-chartbox="d-day"]').scrollIntoView({ block: 'center' })); await sleep(200); await p.screenshot({ path: path.join(SHOTS, 'feescale-phone-tiers.png') }); }
    await fcPick(p, 'fmode', 'this');
    // an outlier the scanner marked unconfirmed: hatched, ⚠ in the legend and the note
    await closePool(p); await openPool(p, peer.id.slice(0, 12)); await fcPick(p, 'fzc', '0');
    a = await p.evaluate(FCLOOK, 'd-day');
    const uc = a.bars.find((b) => / uc/.test(b.cls));
    if (uc) { r = await pointAt(p, 'd-day', phone, { fx: (uc.x + uc.w / 2) / 300, root: '#sheet' }); }
    ok(`feescale ${tag}: a 30× day the scanner lists in u.y is hatched, with ⚠ in the legend and "unconfirmed: no matching trading volume found yet" in its note (${r ? r.txt.slice(0, 60) : '-'})`, uc && uc.f.startsWith('url(#uc-') && /⚠ unconfirmed/.test(a.legend) && r && /⚠ unconfirmed: no matching trading volume found yet/.test(r.txt), JSON.stringify([uc, a.legend.slice(-60), r && r.txt.slice(0, 100)]));
    await p.evaluate(() => { const c = document.querySelector('#ctip'); if (c) c.hidden = true; });
    if (SHOTS && !phone) await snap(p, 'feescale-laptop-year', '[data-chartbox="d-day"]');
    // no fee history yet: the daily rows draw it, no progress line
    await closePool(p); await openPool(p, noY.id.slice(0, 12));
    a = await p.evaluate(FCLOOK, 'd-day');
    const ud = HP[noY.id].u && HP[noY.id].u.d;
    ok(`feescale ${tag}: without a fee history the daily rows draw it (${a.bars.length} bars, no progress line)${ud ? ', a row listed in u.d hatched unconfirmed' : ''}`, a.bars.length > 20 && a.prog === '' && a.ys.length >= 3 && /this pool$/.test(a.title) && (!ud || (a.bars.some((b) => / uc/.test(b.cls)) && /⚠ unconfirmed/.test(a.legend))), JSON.stringify([a.bars.length, a.prog, a.title, !!ud]));
    // the hourly chart has the same scale
    const hh = await p.evaluate(FCLOOK, 'd-hr');
    ok(`feescale ${tag}: the hourly fees have the $ axis, gridlines and the typical hour too (${hh.ys.map((x) => x.t).join(' ')})`, hh.ys.length >= 3 && hh.grid.length === hh.ys.length && hh.med != null && /typical hour \(median\)/.test(hh.cap3) && /LP fees per hour · 14 d · .* · this pool$/.test(hh.title), JSON.stringify([hh.ys, hh.cap3, hh.title]));
    await closePool(p);
    ok(`feescale ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- 4q. v0.4.7: "$ per day at $1,000" next to every APR ----------
// Every APR the page shows carries what the example ticket earns a day (APR × ticket ÷ 365, one formatter). Found by
// structure, not by the formatter's own marks: every table column headed APR, every window-table row of an APR, the
// lists' APR figures, the bench, the breakdown and the lead line.
const APR_AUDIT = ({ ticket, txt: LOCAL_TXT = false }) => { // LOCAL_TXT: name the failing figure (made-up fixtures only)
  const bad = [], seen = { n: 0 };
  const mon = (t) => { const m = /(−|-)?\$([\d.,]+)([KMB]?)\/day/.exec(t || ''); return m ? (m[1] ? -1 : 1) * +m[2].replace(/,/g, '') * ({ K: 1e3, M: 1e6, B: 1e9 }[m[3]] || 1) : null; };
  const pctOf = (t) => { const m = /(−|-|\+)?([\d.,]+)%/.exec(t || ''); return m ? (m[1] === '−' || m[1] === '-' ? -1 : 1) * +m[2].replace(/,/g, '') / 100 : null; };
  const check = (el, where) => {
    if (!el || !el.getClientRects().length) return;
    const t = el.textContent, ex = el.matches('[data-apr]') ? el : el.querySelector('[data-apr]'), a = ex && ex.dataset.apr !== '' ? +ex.dataset.apr : pctOf(t); // the rate itself where marked, else the % shown
    if (a == null) return; // a dash: nothing to give a day
    seen.n++;
    const d = mon(t), want = (a * ticket) / 365;
    if (d == null || Math.abs(d - want) > Math.max(0.006, Math.abs(want) * 0.051) + Math.abs(want) * 0.005 + 0.6 * (Math.abs(want) >= 9.995)) bad.push(where + (LOCAL_TXT ? ' ' + t.replace(/\s+/g, ' ').slice(0, 40) : ''));
  };
  for (const tb of document.querySelectorAll('table')) {
    if (!tb.tBodies[0] || tb.closest('.sh')) continue; // a sticky header's copy has no rows
    const hs = [...(tb.tHead ? tb.tHead.rows[0].cells : [])].map((c) => c.textContent);
    if (tb.classList.contains('wtbl')) { for (const tr of tb.tBodies[0].rows) if (/APR|^LVR|Re-centre|^Gas/.test(tr.cells[0].textContent.trim())) [...tr.cells].slice(1).forEach((c) => check(c, 'window table ' + tr.cells[0].textContent.trim())); continue; }
    hs.forEach((h, i) => { if (!/APR/.test(h) || /forecast/.test(h)) return; for (const tr of tb.tBodies[0] ? tb.tBodies[0].rows : []) if (tr.cells[i]) check(tr.cells[i], 'column ' + h.trim()); });
  }
  for (const e of document.querySelectorAll('.apr, #bench .big, .lab-legend .ap, #rp-strip .v.acc')) check(e, e.className);
  for (const e of document.querySelectorAll('.bar + .legend > button > span, .bar + .legend > span')) if (/Net to you|LVR|swaps|Gas|Fees/.test(e.textContent)) check(e, 'breakdown');
  const leads = [...document.querySelectorAll('[data-lead]')].filter((e) => e.getClientRects().length).map((e) => e.textContent.replace(/\s+/g, ' '));
  return { n: seen.n, bad, leads };
};
const LEAD_RE = /At \$1,000: fees ≈ \$[\d.,]+K?\/day · LVR −\$[\d.,]+K?\/day · net ≈ −?\$[\d.,]+K?\/day \(−?[\d.,]+% a year\)/;
async function testPerDay(browser, html = null) {
  const planted = html != null, ticket = FXD.live.ticket;
  for (const [tag, o] of planted ? [['laptop', { width: 1440 }]] : [['phone', { phone: true }], ['laptop', { width: 1440 }]]) {
    const t = await newPage(browser, o), p = t.page;
    if (planted) await t.ctx.route((u) => new URL(u).pathname === '/app/index.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await p.goto(url('default')); await unlockWith(p, FIXTURE_PASSPHRASE); await waitApp(p); await setWin(p, '30d');
    await p.click('[data-act="more"]').catch(() => {}); await sleep(200);
    const home = await p.evaluate(APR_AUDIT, { ticket, txt: true });
    if (planted) { ok('perday: planted: an APR column without its $/day is caught', home.bad.length > 0, JSON.stringify(home.bad.slice(0, 3))); await t.ctx.close(); return; }
    ok(`perday ${tag}: the home page's ${home.n} APR figures (table columns, lists, bench, breakdown) each carry $/day at $1,000`, home.n >= 40 && !home.bad.length, JSON.stringify(home.bad.slice(0, 4)));
    ok(`perday ${tag}: the best find's lead line (${(home.leads[0] || '').slice(0, 90)})`, home.leads.length >= 1 && LEAD_RE.test(home.leads[0]), JSON.stringify(home.leads));
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    const det = await p.evaluate(APR_AUDIT, { ticket, txt: true });
    ok(`perday ${tag}: the pool panel's ${det.n} APR figures (every window, breakdown) and its lead line`, det.n >= 18 && !det.bad.length && det.leads.some((x) => LEAD_RE.test(x)), JSON.stringify([det.n, det.bad.slice(0, 3), det.leads]));
    await p.click('#sheet-pair'); await sleep(300);
    const pv = await p.evaluate(APR_AUDIT, { ticket, txt: true });
    ok(`perday ${tag}: the pair view's Net APR column (${pv.n})`, pv.n >= 1 && !pv.bad.length, JSON.stringify(pv.bad));
    await p.click('#sheet-close'); await sleep(150);
    const bt = await p.evaluate(() => { const r = document.querySelector('#bt-lead tr.row'); if (r) r.click(); return !!r; }); await sleep(400);
    const b2 = await p.evaluate(APR_AUDIT, { ticket, txt: true });
    ok(`perday ${tag}: the backtest's net APRs (leaderboard, replay, strategies: ${b2.n})`, bt && b2.n >= home.n && !b2.bad.length, JSON.stringify(b2.bad.slice(0, 3)));
    ok(`perday ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  if (!planted) { // the planted fault: the table's Net APR column printed as a bare percentage
    const h0 = fs.readFileSync(PAGE_OVERRIDE || PAGE, 'utf8'), cut = h0.replace("v: (p, w) => w && w.net, f: (x) => aprPd(x, { block: true }) },", "v: (p, w) => w && w.net, f: (x) => pct(x) },");
    if (cut === h0) ok('perday: planted: the line to change is in the page', false);
    else await testPerDay(browser, cut.replace(/script-src [^;]*;/, `script-src ${scriptHashes(cut).join(' ')};`));
  }
}

// ---------- discovery lanes (v0.4.8): one swipe strip per tool, the owner's pick "A · Lanes per tool" ----------
// live.json discovery = pool ids, best first. Lens lanes show 8 cards and a "see all" card (All pools, that lens); new pools
// all of them; cross-chain gaps "not built yet". A tap opens the pool. Stablecoin pairs follow the switch; an older pass
// without discovery hides the card. Also: the cexled / retail lens icons in the Why column, and the venue in each row.
const DL_KEYS = ['newPools', 'cexLed', 'crossChain', 'retailUp'];
const isStableFxP = (q) => ['USDC', 'USDT', 'DAI', 'MUNT'].includes(q.t1.sym) || ['USDC', 'USDT', 'DAI'].includes(q.t0.sym);
const DL_READ = () => {
  const el = document.querySelector('#disc');
  if (!el) return { exists: false };
  return { exists: true, hidden: el.hidden, h2: (el.querySelector('h2') || {}).textContent,
    lanes: [...el.querySelectorAll('.lane')].map((l) => ({ k: l.dataset.lane, cnt: l.querySelector('.lh .cnt').textContent, ids: [...l.querySelectorAll('.mc.dc')].map((c) => c.dataset.id),
      end: (l.querySelector('[data-act="dl-all"]') || {}).innerText || null, txt: l.innerText })) };
};
async function testDisc(browser) {
  const L = FXD.live, d = L.discovery;
  ok('disc: the fixture fills three lanes, crossChain empty, and has stablecoin pairs and an unverified pool in them', d && d.newPools.length >= 2 && d.cexLed.length > 8 && d.retailUp.length > 8 && d.crossChain.length === 0
    && DL_KEYS.some((k) => d[k].some((id) => isStableFxP(poolOf(id)))), JSON.stringify(d && Object.values(d).map((x) => x.length)));
  for (const [tag, o, w] of [['phone', { phone: true }, null], ['laptop', { width: 1440 }, 1440]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    let a = await p.evaluate(DL_READ);
    const want = (k) => d[k].map(poolOf).filter(Boolean);
    const lane = (k) => a.lanes && a.lanes.find((x) => x.k === k);
    ok(`disc ${tag}: a Discovery card with four lanes in order`, a.exists && !a.hidden && a.h2 === 'Discovery' && JSON.stringify(a.lanes.map((x) => x.k)) === JSON.stringify(DL_KEYS), String(JSON.stringify(a)).slice(0, 160));
    if (!a.exists || a.hidden) { await t.ctx.close(); continue; }
    for (const k of ['newPools', 'cexLed', 'retailUp']) {
      const ws = want(k), x = lane(k), cap = k === 'newPools' ? ws.length : Math.min(8, ws.length);
      ok(`disc ${tag}: lane ${k} counts ${ws.length} and shows ${cap} cards best first${ws.length > cap ? ', then "see all"' : ''}`, x && x.cnt.startsWith(String(ws.length)) && JSON.stringify(x.ids) === JSON.stringify(ws.slice(0, cap).map((q) => q.id))
        && (ws.length > cap ? new RegExp('^' + ws.length + '\\s+see all$').test((x.end || '').trim()) : x.end === null), JSON.stringify(x && [x.cnt, x.ids.length, x.end]));
    }
    ok(`disc ${tag}: cross-chain gaps say "not built yet", no cards`, lane('crossChain') && /not built yet/.test(lane('crossChain').cnt) && lane('crossChain').ids.length === 0);
    // each card: pair, chain mark and edge, fee and venue, the lane's evidence, net with its $/day at the ticket; missing reads —
    const cards = await p.evaluate(() => [...document.querySelectorAll('#disc .mc.dc')].map((c) => ({ id: c.dataset.id, lane: c.closest('.lane').dataset.lane, n: c.querySelector('.n').textContent, m: c.querySelector('.m').textContent,
      mark: !!c.querySelector('.m .cg[aria-label]'), cc: getComputedStyle(c).getPropertyValue('--cc').trim(), stripe: /inset 3px/.test(getComputedStyle(c).boxShadow) || /3px 0px 0px/.test(getComputedStyle(c).boxShadow), txt: c.innerText, h: c.getBoundingClientRect().height })));
    const bad = cards.filter((c) => { const q = poolOf(c.id); return !q || c.n !== q.pair || !c.mark || !c.cc || !c.stripe || !/v[34]/.test(c.m) || !/net\s+(—|(≈\s*)?−?[\d.,]+%[\s\S]*\/day)/.test(c.txt) || /NaN|undefined|null/.test(c.txt) || c.h < 44; });
    ok(`disc ${tag}: ${cards.length} cards carry pair, chain mark + edge, fee · venue, net with $/day, nothing junk, ≥ 44 px`, cards.length >= 15 && !bad.length, String(JSON.stringify(bad[0])).slice(0, 160));
    const c1 = cards.find((c) => c.lane === 'newPools'), q1 = c1 && poolOf(c1.id), age = q1 && Math.round((L.t - q1.createdAt) / 3600e3);
    ok(`disc ${tag}: a new pool's card reads its age in hours and its swaps · distinct traders (senders)`, c1 && new RegExp(age + ' h old').test(c1.m.replace(/\s+/g, ' ')) && new RegExp(`${q1.w['24h'].swaps.toLocaleString('en-US')} swaps · ${q1.w['24h'].flow.senders} traders`).test(c1.txt), c1 && c1.txt.replace(/\n/g, ' | '));
    const cx = cards.filter((c) => c.lane === 'cexLed');
    ok(`disc ${tag}: exchange-led cards read CEX ÷ DEX, tier vs σ/block (green ≥ 1) and the retail share`, cx.length && cx.every((c) => /CEX ÷ DEX [\d,.]+×/.test(c.txt) && /tier [\d,.]+× σ\/block/.test(c.txt) && /retail (—|\d+%) of fees/.test(c.txt))
      && (await p.evaluate(() => [...document.querySelectorAll('#disc [data-lane="cexLed"] .k')].filter((k) => /tier/.test(k.textContent)).every((k) => k.classList.contains('g') === (parseFloat(k.textContent.replace(/[^\d.]/g, '')) >= 1)))), cx[0] && cx[0].txt.replace(/\n/g, ' | '));
    const rt = cards.filter((c) => c.lane === 'retailUp');
    ok(`disc ${tag}: retail cards read the retail share, routing and a drift note`, rt.length && rt.every((c) => /retail (\d+→)?\d+%/.test(c.txt) && /routing (—|\d+%)/.test(c.txt) && /drift|price moves|calm hours/.test(c.txt)), rt[0] && rt[0].txt.replace(/\n/g, ' | '));
    // the strip scrolls sideways inside itself; the page does not
    const sc = await p.evaluate(() => { const t = document.querySelector('#dl-retailUp'); const s = getComputedStyle(t); return { sx: t.scrollWidth > t.clientWidth, snap: s.scrollSnapType, hs: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
    ok(`disc ${tag}: each lane is a snap strip that swipes on its own, the page never scrolls sideways`, sc.sx && /x mandatory/.test(sc.snap) && sc.hs <= 0, JSON.stringify(sc));
    // a tap on a card opens that pool's detail
    const pick = cx[1] || cx[0];
    await p.evaluate((id) => { const b = document.querySelector(`#disc .mc.dc[data-id="${id}"]`); b.scrollIntoView({ block: 'center', inline: 'nearest' }); }, pick.id); await sleep(200);
    await p.click(`#disc .mc.dc[data-id="${pick.id}"]`); await p.waitForSelector('#sheet:not([hidden])', { timeout: 5000 }).catch(() => {}); await sleep(350);
    ok(`disc ${tag}: a tap on a card opens that pool (${poolOf(pick.id).pair})`, (await p.isVisible('#sheet')) && (await p.textContent('#sheet-title')) === poolOf(pick.id).pair);
    if (SHOTS) await snap(p, `disc-${tag}-opened`);
    await p.click('#sheet-close').catch(() => {}); await sleep(200);
    ok(`disc ${tag}: closing returns the focus to the card`, (await p.evaluate(() => { const a = document.activeElement; return a && a.closest && !!a.closest('#disc'); })));
    // "see all" on a lens lane: All pools, filtered to that lens
    await p.evaluate(() => document.querySelector('#disc [data-lane="retailUp"] [data-act="dl-all"]').click()); await sleep(900);
    const all = await p.evaluate(() => ({ lens: document.querySelector('#f-lens').value, top: document.querySelector('#all').getBoundingClientRect().top, ids: [...document.querySelectorAll('#all tbody tr.row')].map((r) => r.dataset.id) }));
    const wk = await p.evaluate(() => document.querySelector('#winseg [aria-pressed="true"]').dataset.w);
    ok(`disc ${tag}: "see all" filters All pools to that lens (${all.ids.length} rows) and goes there`, all.lens === 'retail' && all.ids.length > 0 && all.ids.every((id) => poolOf(id).w[wk].lenses.includes('retail')) && all.top < 300, JSON.stringify([all.lens, all.ids.length, all.top]));
    await p.selectOption('#f-lens', 'all'); await sleep(150);
    // the Why column shows the cexled / retail icons where those lenses fire, and every row names its venue
    await p.click('[data-act="more"]').catch(() => {}); await sleep(250);
    const rows = await p.evaluate(() => [...document.querySelectorAll('#all tbody tr.row')].map((r) => ({ id: r.dataset.id, why: (r.querySelector('.whyb') || { getAttribute: () => '' }).getAttribute('aria-label') || '', pm: r.querySelector('.pm').textContent })));
    const lensBad = rows.filter((r) => { const lz = poolOf(r.id).w[wk] ? poolOf(r.id).w[wk].lenses : []; return /Exchange-led/.test(r.why) !== lz.includes('cexled') || /Retail flow/.test(r.why) !== lz.includes('retail'); });
    ok(`disc ${tag}: the Why column carries the exchange-led and retail icons exactly where those lenses fire (${rows.filter((r) => /Exchange-led|Retail flow/.test(r.why)).length} rows)`, rows.length > 100 && !lensBad.length && rows.some((r) => /Exchange-led/.test(r.why)) && rows.some((r) => /Retail flow/.test(r.why)), JSON.stringify(lensBad[0]));
    const dexBad = rows.filter((r) => !new RegExp((poolOf(r.id).dex === 'pancakeswap' ? 'Pancake' : 'Uni') + ' v' + poolOf(r.id).v + '$').test(r.pm.trim()));
    ok(`disc ${tag}: every row names its venue (Uni / Pancake) with the version`, !dexBad.length && rows.some((r) => /Pancake/.test(r.pm)), JSON.stringify(dexBad[0]));
    ok(`disc ${tag}: the lens filter offers Exchange-led and Retail flow`, await p.evaluate(() => ['cexled', 'retail'].every((v) => !!document.querySelector(`#f-lens option[value="${v}"]`))));
    if (SHOTS) await snap(p, `disc-${tag}`, '#disc');
    ok(`disc ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // stablecoin pairs off (the page's default): those cards go, favourites stay, the card says how many are hidden
  {
    const fav = DL_KEYS.flatMap((k) => d[k]).map(poolOf).find(isStableFxP);
    const t = await openUnlocked(browser, 'default', { phone: true, stableDefault: true, storage: { 'lps.fav': JSON.stringify([fav.id]) } }), p = t.page;
    const a = await p.evaluate(DL_READ), shown = a.lanes ? a.lanes.flatMap((x) => x.ids) : [];
    const leak = shown.filter((id) => isStableFxP(poolOf(id)) && id !== fav.id);
    const hid = DL_KEYS.flatMap((k) => d[k]).filter((id) => isStableFxP(poolOf(id)) && id !== fav.id);
    ok('disc stable off: no stablecoin pair in the lanes but the favourite one, counts drop, the card says how many are hidden', a.exists && !leak.length && shown.includes(fav.id) && new RegExp(hid.length + ' hidden').test(await p.textContent('#disc .sec-head'))
      && a.lanes.filter((x) => x.k !== 'crossChain').every((x) => x.cnt.startsWith(String(d[x.k].filter((id) => !isStableFxP(poolOf(id)) || id === fav.id).length)) || /none/.test(x.cnt)), JSON.stringify([leak.length, hid.length, a.lanes && a.lanes.map((x) => x.cnt)]));
    ok('disc stable off: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // empty and odd lanes (fixture case oddlanes): [] reads "none this pass", an id that is no pool is skipped, a missing lane —
  {
    const t = await openUnlocked(browser, 'oddlanes', { phone: true }), p = t.page;
    const e = await p.evaluate(DL_READ);
    ok('disc oddlanes: empty lanes read "none this pass", a missing lane "— not in this pass", an unknown id is skipped', e.exists && !e.hidden && /none this pass/.test(e.lanes[0].cnt) && /none this pass/.test(e.lanes[1].cnt) && e.lanes[1].ids.length === 0 && /not built yet/.test(e.lanes[2].cnt) && /— not in this pass/.test(e.lanes[3].cnt), JSON.stringify(e.lanes && e.lanes.map((x) => x.cnt)));
    ok('disc oddlanes: no page errors', t.errors.length === 0, t.errors[0]);
    if (SHOTS) await snap(p, 'disc-oddlanes', '#disc');
    await t.ctx.close();
  }
  // an older pass without discovery, dex, cex or flow: no card, no error, rows read the version alone
  {
    const t = await openUnlocked(browser, 'nodisc', { phone: true }), p = t.page;
    const a = await p.evaluate(DL_READ);
    const pm = await p.evaluate(() => [...document.querySelectorAll('#all tbody .pm')].map((x) => x.textContent.trim()));
    ok('disc nodisc: an older pass without discovery hides the card, rows show the version alone, no Why lens icons', a.exists && a.hidden && pm.length > 20 && pm.every((x) => / · v[34]$/.test(x)) && !(await p.evaluate(() => /Exchange-led|Retail flow/.test([...document.querySelectorAll('#all .whyb')].map((b) => b.getAttribute('aria-label')).join()))), JSON.stringify([a.hidden, pm[0]]));
    ok('disc nodisc: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // narrow phones: no sideways page scroll and no text overlap in the card, the default and the longest names
  for (const c of ['default', 'long']) {
    const t = await openUnlocked(browser, c, { width: 390 }), p = t.page;
    for (const w of DEVICE ? [0] : [360, 390, 430]) {
      if (w) await p.setViewportSize({ width: w, height: 860 });
      await sleep(250);
      for (const k of ['newPools', 'cexLed', 'retailUp']) await p.evaluate((k) => { const x = document.querySelector('#dl-' + k); if (x) x.scrollLeft = x.scrollWidth; }, k);
      await sleep(200);
      // the page's own sideways scroll (default case; the long case's bench tile runs 6 px over at 360, as in v0.4.7), and
      // anything of the card past the screen's edge outside its strips (both cases)
      const hs = await p.evaluate(() => { const vw = document.documentElement.clientWidth, el = document.querySelector('#disc');
        return { page: document.documentElement.scrollWidth - vw, out: [el, ...el.querySelectorAll('*')].filter((x) => !x.closest('.mc-track') && x.getBoundingClientRect().right > vw + 0.5).length }; });
      const ov = await OVL(p, '#disc');
      ok(`disc ${c} ${w || DEVICE}: no sideways page scroll, nothing of the card past the edge, no text overlap or clipped text`, (await p.isVisible('#disc')) && (c === 'long' || hs.page <= 0) && !hs.out && !ov.length, JSON.stringify([hs, ov[0]]));
      for (const k of ['newPools', 'cexLed', 'retailUp']) await p.evaluate((k) => { const x = document.querySelector('#dl-' + k); if (x) x.scrollLeft = 0; }, k);
    }
    if (SHOTS) await snap(p, `disc-${c}-narrow`, '#disc');
    await t.ctx.close();
  }
}

// ---------- v0.5.0: the look switch, 3D (the owner's pick "B · Teal Depth") or Classic 2D (the v0.4.8 look) ----------
// A switch in the bar (and one in the footer), kept on this device; no choice kept: 3D, or Classic 2D under reduced motion.
// Switching is instant: nothing reloads or re-renders, and the open panel, the scroll, the window and the search stay.
// 3D puts a depth canvas behind every bar chart (the drawing on top unchanged: one axis, bars from 0, exact heights); a
// hover or a tap shows the same note as 2D and lights that bar, out of the fog. Canvases at most 2× the CSS pixels.
const LOOK = () => {
  const r = document.documentElement, seg = document.querySelector('#top #viewseg'), vw = document.documentElement.clientWidth;
  const btns = seg ? [...seg.querySelectorAll('[data-act="view"]')] : [];
  const shown = btns.filter((b) => b.getClientRects().length);
  return { m3d: r.classList.contains('m3d'), seg: !!seg, n: btns.length, shown: shown.map((b) => b.dataset.v), pressed: btns.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.v),
    tall: shown.every((b) => b.getBoundingClientRect().height >= 43.5), inside: shown.every((b) => { const q = b.getBoundingClientRect(); return q.left >= 0 && q.right <= vw + 0.5; }),
    foot: [...document.querySelectorAll('footer [data-act="view"]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.v),
    canv: document.querySelectorAll('canvas.d3c').length, hosts: [...document.querySelectorAll('.pz.liq, .pz.pz-bars')].filter((h) => h.getClientRects().length).length,
    hs: document.documentElement.scrollWidth - vw };
};
// every bar chart on screen: its canvas sits behind the drawing, takes no tap, drew its towers, at most 2× the CSS pixels
const DEPTH = (sel = '.pz.liq, .pz.pz-bars') => [...document.querySelectorAll(sel)].filter((h) => h.getClientRects().length && h.getBoundingClientRect().width > 20).map((h) => {
  const c = h.querySelector(':scope > canvas.d3c'), r = h.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const on = r.bottom > 0 && r.top < innerHeight;
  return { id: h.dataset.pz, c: !!c, first: !!c && h.firstElementChild === c, pe: c ? getComputedStyle(c).pointerEvents : null, hit: on ? (hit ? (hit === c ? 'canvas' : 'ok') : 'none') : 'off',
    px: c ? Math.max(c.width / Math.max(1, r.width), c.height / Math.max(1, r.height)) : 0, d3: c && c.__d3 ? { ...c.__d3 } : null };
});
// the chart's own drawing, attribute by attribute (the same in both looks: exact heights, bars from 0)
const DRAWN = (id) => { const h = document.querySelector(`[data-pz="${id}"]`); if (!h) return null; const s = h.querySelector('.pz-c svg'), y = document.querySelector(`[data-yax="${id}"]`); return { svg: s ? s.outerHTML.length + ':' + [...s.querySelectorAll('rect, path')].map((e) => ['x', 'y', 'width', 'height', 'd', 'fill', 'fill-opacity'].map((a) => e.getAttribute(a)).join(',')).join('|') : null, yax: y ? y.innerText : null, view: h.dataset.view }; };
async function viewCtx(browser, o = {}) { // a page with no look chosen by the test run (the page's own default), unlocked on the 30-day view
  const t = await newPage(browser, { mode: null, ...o, storage: { 'lps.hint': '1', ...(o.storage || {}) } });
  if (o.blockStorage) await t.ctx.addInitScript(() => { const thrower = () => { throw new DOMException('blocked', 'SecurityError'); }; try { Object.defineProperty(window, 'localStorage', { get: thrower, configurable: true }); } catch (e) { /* ignore */ } });
  await t.page.goto(url('default'));
  await unlockWith(t.page, FIXTURE_PASSPHRASE);
  await waitApp(t.page);
  if ((await t.page.getAttribute('#winseg [data-w="30d"]', 'aria-pressed')) !== 'true') await setWin(t.page, '30d');
  return t;
}
async function testView(browser) {
  // 1. the switch: in the bar, one slim row with it, 44 px taps, inside the screen, no sideways scroll; a narrow phone one pill
  for (const [tag, o] of [['w360', { width: 360, height: 760 }], ['w390', { width: 390 }], ['w430', { width: 430 }], ['phone', { phone: true }], ['laptop', { width: 1440 }]]) {
    if (tag === 'phone' && !DEVICE) continue;
    const t = await viewCtx(browser, o), p = t.page;
    const a = await p.evaluate(LOOK), b = await p.evaluate(BAR);
    const w = await p.evaluate(() => document.documentElement.clientWidth);
    ok(`view ${tag}: a 3D ⇄ 2D switch sits in the bar (${a.shown.join('+')}), the bar still one slim row (${b.h} px), taps 44 px, inside the screen`,
      a.seg && a.n === 2 && a.shown.length === (w < 380 ? 1 : 2) && a.tall && a.inside && b.oneRow && b.h >= 44 && b.h <= 52, JSON.stringify([a, b.h, b.oneRow]));
    ok(`view ${tag}: with no look chosen the page starts in 3D (the pressed pill says so, the footer's too)`, a.m3d && a.pressed.join() === '3d' && a.foot.join() === '3d', JSON.stringify(a));
    ok(`view ${tag}: no sideways page scroll in 3D`, a.hs <= 0, String(a.hs));
    // a narrow phone's single pill switches to the other look; a wider screen's other pill does
    await p.click(a.shown.length === 1 ? '#viewseg [data-act="view"][data-v="3d"]' : '#viewseg [data-act="view"][data-v="2d"]', { timeout: 5000 }).catch(() => {});
    const c = await p.evaluate(LOOK);
    ok(`view ${tag}: a tap switches to Classic 2D at once (${c.shown.join('+')} shown, pressed ${c.pressed.join()})`, !c.m3d && c.pressed.join() === '2d' && c.foot.join() === '2d' && c.canv === 0 && c.hs <= 0 && (c.shown.length === (w < 380 ? 1 : 2)), JSON.stringify(c));
    // text overlap and clipped text in 3D at the phone widths (the page, then a pool's panel)
    if (tag !== 'laptop') {
      await p.click(c.shown.length === 1 ? '#viewseg [data-act="view"][data-v="2d"]' : '#viewseg [data-act="view"][data-v="3d"]', { timeout: 5000 }).catch(() => {});
      const ov = await p.evaluate(TEXT_OVERLAP);
      await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
      const ov2 = await p.evaluate(TEXT_OVERLAP, { root: '#sheet' });
      ok(`view ${tag}: in 3D no text collides or is cut off (page ${ov.length}, panel ${ov2.length}), nothing past the edge`, (await p.evaluate(LOOK)).m3d && !ov.length && !ov2.length && (await p.evaluate(LOOK)).hs <= 0, JSON.stringify(ov[0] || ov2[0] || {}));
      await p.click('#sheet-close'); await calm(p, SHEET_MOVES);
    }
    ok(`view ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 2. reduced motion starts in Classic 2D; 3D chosen there is still (no animation at all), its towers already standing
  {
    const t = await viewCtx(browser, { phone: true, reducedMotion: 'reduce' }), p = t.page;
    const a = await p.evaluate(LOOK);
    ok('view reduced: a device set to reduce motion starts in Classic 2D, no depth canvas', !a.m3d && a.pressed.join() === '2d' && a.canv === 0, JSON.stringify(a));
    await p.evaluate(() => { const b = document.querySelector('#viewseg [data-v="3d"]'); if (b) b.click(); }); await frames(p, 2);
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    const d = await p.evaluate(DEPTH), n = await p.evaluate(() => document.getAnimations().length);
    ok(`view reduced: 3D chosen there draws its depth (${d.filter((x) => x.c).length} charts) with nothing moving (${n} animations), every tower standing`, (await p.evaluate(LOOK)).m3d && n === 0 && d.length >= 4 && d.filter((x) => x.hit !== 'off').length >= 1 && d.every((x) => x.c && (x.hit === 'off' || (x.d3 && x.d3.k === 1))), JSON.stringify([n, d.find((x) => !x.c || (x.hit !== 'off' && (!x.d3 || x.d3.k !== 1)))]));
    await t.ctx.close();
    const r = await viewCtx(browser, { phone: true, reducedMotion: 'reduce', storage: { 'lps.view': '3d' } });
    ok('view reduced: 3D kept on the device wins over the default', (await r.page.evaluate(LOOK)).m3d && (await r.page.evaluate(() => document.getAnimations().length)) === 0);
    await r.ctx.close();
  }
  // 3. switching keeps everything: no reload, no fetch, the open panel and its scroll, the page's scroll, the window, the search
  {
    const t = await viewCtx(browser, { phone: true }), p = t.page;
    await setWin(p, '7d'); await fillQ(p, 'VEL');
    await p.evaluate(() => { window.__lpsKeep = 1; scrollTo(0, 700); });
    await calm(p, BAR_MOVES);
    const was3d = (await p.evaluate(LOOK)).m3d;
    const keep0 = await p.evaluate(() => ({ y: Math.round(scrollY), rows: document.querySelectorAll('#all tbody tr.row').length, q: document.querySelector('#f-q').value, w: document.querySelector('#winseg [aria-pressed="true"]').dataset.w, res: performance.getEntriesByType('resource').length }));
    await p.evaluate(() => { const b = document.querySelector('#viewseg [data-v="2d"]'); if (b) b.click(); }); await frames(p, 2);
    const keep1 = await p.evaluate(() => ({ y: Math.round(scrollY), rows: document.querySelectorAll('#all tbody tr.row').length, q: document.querySelector('#f-q').value, w: document.querySelector('#winseg [aria-pressed="true"]').dataset.w, res: performance.getEntriesByType('resource').length, mark: window.__lpsKeep }));
    ok('view switch: to Classic 2D in place: the same scroll, window and search rows, no reload and nothing fetched', was3d && keep1.mark === 1 && keep1.y === keep0.y && keep1.rows === keep0.rows && keep1.q === keep0.q && keep1.w === keep0.w && keep1.res === keep0.res && !(await p.evaluate(LOOK)).m3d, JSON.stringify([keep0, keep1]));
    await fillQ(p, '');
    await p.evaluate(() => scrollTo(0, 0)); await calm(p, BAR_MOVES);
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
    await p.evaluate(() => { document.querySelector('#sheet-body').scrollTop = 420; }); await frames(p, 3);
    const s0 = await p.evaluate(() => ({ top: Math.round(document.querySelector('#sheet-body').scrollTop), ttl: document.querySelector('#sheet-title').textContent, n: document.querySelectorAll('#sheet [data-pz]').length }));
    const before = await p.evaluate(DRAWN, 'd-day');
    await p.evaluate(() => { const b = document.querySelector('footer [data-act="view"][data-v="3d"]'); if (b) b.click(); }); await frames(p, 2);
    const s1 = await p.evaluate(() => ({ top: Math.round(document.querySelector('#sheet-body').scrollTop), ttl: document.querySelector('#sheet-title').textContent, n: document.querySelectorAll('#sheet [data-pz]').length, open: !document.querySelector('#sheet').hidden }));
    const after = await p.evaluate(DRAWN, 'd-day'), l = await p.evaluate(LOOK);
    ok('view switch: the footer\'s switch turns 3D on with the panel open: the same pool, the same scroll in it, both switches agree', l.m3d && l.pressed.join() === '3d' && l.foot.join() === '3d' && s1.open && s1.ttl === s0.ttl && s1.top === s0.top && s1.n === s0.n, JSON.stringify([s0, s1, l.pressed, l.foot]));
    ok('view switch: the fee chart is drawn the same in both looks: the same bars (x, y, width, height), the same $ axis, from $0', l.m3d && l.canv > 0 && !!before && before.svg && before.svg === after.svg && before.yax === after.yax && /\$0/.test(after.yax), JSON.stringify([before && before.yax, after && after.yax]));
    ok('view switch: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 4. kept on this device: a reload opens the look chosen last; with storage blocked the page still works (3D, switchable)
  {
    const t = await viewCtx(browser, { width: 1440 }), p = t.page;
    await p.click('#viewseg [data-v="2d"]', { timeout: 5000 }).catch(() => {});
    await p.reload(); await p.waitForSelector('#app:not([hidden])', { timeout: 30000 }); await waitApp(p);
    const a = await p.evaluate(LOOK);
    await p.click('#viewseg [data-v="3d"]', { timeout: 5000 }).catch(() => {});
    await p.reload(); await p.waitForSelector('#app:not([hidden])', { timeout: 30000 }); await waitApp(p);
    const b = await p.evaluate(LOOK);
    ok('view kept: a reload opens the look chosen last (Classic 2D, then 3D)', !a.m3d && a.pressed.join() === '2d' && b.m3d && b.pressed.join() === '3d', JSON.stringify([a.pressed, b.pressed]));
    ok('view kept: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
    const x = await viewCtx(browser, { width: 1440, blockStorage: true }), q = x.page;
    const c = await q.evaluate(LOOK);
    await q.click('#viewseg [data-v="2d"]', { timeout: 5000 }).catch(() => {});
    const d = await q.evaluate(LOOK);
    ok('view kept: with the browser\'s storage blocked the page opens in 3D and still switches', c.m3d && !d.m3d && x.errors.length === 0, JSON.stringify([c.m3d, d.m3d, x.errors[0]]));
    await x.ctx.close();
  }
  // 5. 3D's depth: a canvas behind every bar chart, never in the way, at most 2× even on a 3× phone; Classic 2D has none
  {
    const t = await viewCtx(browser, { phone: true, dpr: 3 }), p = t.page;
    // each chart in turn, scrolled to the middle (a chart below the fold is drawn once it scrolls into view)
    const each = async (root) => {
      const out = [];
      for (const id of await p.evaluate((root) => [...document.querySelectorAll(`${root} .pz.liq, ${root} .pz.pz-bars`)].filter((h) => h.getClientRects().length).map((h) => h.dataset.pz), root)) {
        const sel = `${root} [data-pz="${id}"]`;
        await p.evaluate(STILL_BOX, { sel });
        await p.waitForFunction((sel) => { const c = document.querySelector(`${sel} > canvas.d3c`); return !!c && !!c.__d3; }, sel, { timeout: 4000 }).catch(() => {});
        out.push(...(await p.evaluate(DEPTH, sel)));
      }
      return out;
    };
    let d = await each('main');
    await p.evaluate(() => scrollTo(0, 0));
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
    d = d.concat(await each('#sheet'));
    const bad = d.filter((x) => !x.c || !x.first || x.pe !== 'none' || x.hit === 'canvas' || x.px > 2.01 || !x.d3 || (x.d3.towers < 1 && x.id !== 'health'));
    ok(`view depth: every bar chart in 3D has its canvas behind the drawing (${d.length}: ${[...new Set(d.map((x) => x.id))].join(' ')}), never under a finger, ≤ 2× pixels on a 3× screen`, d.length >= 6 && !bad.length, JSON.stringify(bad[0] || d[0]));
    const lq = d.find((x) => x.id === 'liq-detail');
    ok(`view depth: the LP shape's floor shows where the price was, day by day (${lq && lq.d3 && lq.d3.trail} days back), on ${lq && lq.d3 && lq.d3.rows} rows`, !!lq && !!lq.d3 && lq.d3.kind === 'liq' && lq.d3.rows >= 7 && lq.d3.trail >= 7, JSON.stringify(lq && lq.d3));
    const fd = d.find((x) => x.id === 'd-day');
    ok('view depth: the fee history\'s older days fade back (the oldest in fog, the newest clear)', !!fd && !!fd.d3 && fd.d3.fog[0] < 0.5 && fd.d3.fog[1] > 0.9, JSON.stringify(fd && fd.d3));
    ok('view depth: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 6. a hover or a tap in 3D shows the exact value and date (the same note as 2D) and that bar comes out of the fog
  for (const phone of [true, false]) {
    const t = await viewCtx(browser, { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES); await sleep(700);
    const res = {};
    for (const [id, fx] of [['d-day', 0.5], ['liq-detail', 0.62]]) { // (the middle: clear of the edge buttons)
      const n3 = await pointAt(p, id, phone, { fx, root: '#sheet' });
      const c3 = await p.evaluate((id) => { const c = document.querySelector(`[data-pz="${id}"] > canvas.d3c`), cur = document.querySelector(`[data-pz="${id}"] > .pz-cur`); return { d3: c && c.__d3 ? { ...c.__d3 } : null, cur: cur ? parseFloat(cur.style.left) : null, m3d: document.documentElement.classList.contains('m3d') }; }, id);
      await p.evaluate(() => { document.querySelector('#ctip').hidden = true; });
      await p.evaluate(() => { const b = document.querySelector('footer [data-act="view"][data-v="2d"]'); if (b) b.click(); }); await frames(p, 2);
      await sleep(450); // a second tap on the same spot sooner is a double tap (it resets the chart)
      const n2 = await pointAt(p, id, phone, { fx, root: '#sheet' });
      await p.evaluate(() => { const b = document.querySelector('footer [data-act="view"][data-v="3d"]'); if (b) b.click(); }); await frames(p, 2); await sleep(450);
      res[id] = { m3d: c3.m3d, n3: n3 && n3.txt, n2: n2 && n2.txt, hl: c3.d3 && c3.d3.hl, cur: c3.cur, fog: c3.d3 && c3.d3.fog, dbg: n3 && n3.dbg };
      if (!(await p.isVisible('#sheet'))) { await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES); }
    }
    const fee = res['d-day'], liq = res['liq-detail'];
    ok(`view note ${tag}: on the fee history a ${phone ? 'tap' : 'hover'} in 3D shows the day and its exact $ (the same note as 2D: "${(fee.n3 || '').slice(0, 44)}")`, fee.m3d && !!fee.n3 && fee.n3 === fee.n2 && DATE_RE.test(fee.n3) && /\$[\d,.]+/.test(fee.n3), JSON.stringify(fee));
    ok(`view note ${tag}: …and that bar comes to the front, out of the fog, right under the note's line`, !!fee.hl && fee.hl.a === 1 && fee.fog[0] < 0.5 && fee.cur >= fee.hl.x0 - 1.5 && fee.cur <= fee.hl.x1 + 1.5, JSON.stringify(fee));
    ok(`view note ${tag}: on the LP shape the same: the exact liquidity at that price, as in 2D, and its tower lit`, !!liq.n3 && liq.n3 === liq.n2 && /liquidity (\$[\d.]+[KM]?|—)/.test(liq.n3) && !!liq.hl && liq.cur >= liq.hl.x0 - 1.5 && liq.cur <= liq.hl.x1 + 1.5, JSON.stringify(liq));
    ok(`view note ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 7. motion in 3D: a pool's towers rise as it opens and settle; the ambient light stops while the tab is hidden
  {
    const t = await viewCtx(browser, { width: 1440 }), p = t.page;
    {
      const h = await p.evaluate(STILL_BOX, { sel: '[data-pz="liq-best"]' }), x0 = h.x + h.w / 2, y0 = h.y + h.h / 2;
      await p.mouse.move(x0, y0); await p.mouse.down();
      for (let i = 1; i <= 8; i++) { await p.mouse.move(x0 - i * 12, y0); await sleep(16); }
      // still held: the next drawn frame of the drag hides the depth (a slow WebKit may not have drawn one yet: keep moving a little)
      let mid = null;
      for (let i = 0; i < 40; i++) {
        mid = await p.evaluate(() => { const c = document.querySelector('[data-pz="liq-best"] > canvas.d3c'); return c ? getComputedStyle(c).opacity : null; });
        if (mid === '0') break;
        await p.mouse.move(x0 - 96 - (i % 2 ? 2 : 0), y0); await sleep(50);
      }
      await p.mouse.up(); await pzSettled(p, 'liq-best');
      await p.waitForFunction(() => { const c = document.querySelector('[data-pz="liq-best"] > canvas.d3c'); return c && !c.classList.contains('mv') && getComputedStyle(c).opacity === '1'; }, null, { timeout: 4000 }).catch(() => {});
      const rest = await p.evaluate(() => { const c = document.querySelector('[data-pz="liq-best"] > canvas.d3c'), h = c && c.parentElement; return c ? { op: getComputedStyle(c).opacity, view: h.dataset.view, drawn: c.__m && c.__m.X ? true : false, towers: c.__d3 && c.__d3.towers } : null; });
      ok(`view motion: while the LP shape is dragged its depth steps aside (each frame costs what 2D's does) and comes back where it rests`, mid === '0' && !!rest && rest.op === '1' && rest.drawn && rest.towers > 0, JSON.stringify([mid, rest]));
      await p.evaluate(() => scrollTo(0, 0));
    }
    // every drawn frame from before the tap: the lowest rise seen (a slow WebKit draws a frame every 100-260 ms, so no fixed wait)
    await p.evaluate(() => { window.__k = []; const t0 = performance.now(); const f = () => { const c = document.querySelector('[data-pz="liq-detail"] > canvas.d3c'); if (c && c.__d3) window.__k.push(c.__d3.k); if (performance.now() - t0 < 6000) requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await p.click('#best [data-act="detail"]');
    await p.waitForFunction(() => { const c = document.querySelector('[data-pz="liq-detail"] > canvas.d3c'); return c && c.__d3 && c.__d3.k === 1; }, null, { timeout: 8000 }).catch(() => {});
    const k = await p.evaluate(() => { const c = document.querySelector('[data-pz="liq-detail"] > canvas.d3c'); return { min: window.__k.length ? Math.min(...window.__k) : null, n: window.__k.length, end: c && c.__d3 ? c.__d3.k : null, rise: c ? c.__rise : null }; });
    ok(`view motion: a pool's towers rise as its panel opens (from ${k.min} to ${k.end} over ${k.rise} ms, ${k.n} frames seen)`, k.min != null && k.min < 0.5 && k.end === 1 && k.rise === 600, JSON.stringify(k));
    await p.evaluate(() => scrollTo(0, 0));
    await p.waitForFunction(() => !document.documentElement.classList.contains('d3-busy'), null, { timeout: 8000 }).catch(() => {}); // 2.5 s after the last scroll or tap
    const amb = await p.evaluate(async () => {
      const st = () => { const i = document.querySelector('.fx3d i'); return i ? getComputedStyle(i).animationPlayState : null; };
      const a = st();
      Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
      const b = st();
      Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
      return [a, b, st(), document.getAnimations().filter((x) => x.effect && x.effect.getComputedTiming().endTime === Infinity).length];
    });
    const busy = await p.evaluate(async () => { const st = () => { const i = document.querySelector('.fx3d i'); return i ? getComputedStyle(i).animationPlayState : null; }; window.dispatchEvent(new WheelEvent('wheel')); const a = st(); await new Promise((r) => setTimeout(r, 2900)); return [a, st()]; });
    const deep = await p.evaluate(async () => { const st = () => { const i = document.querySelector('.fx3d i'); return i ? getComputedStyle(i).animationPlayState : null; }; const deepNow = () => document.documentElement.classList.contains('d3-deep'), until = async (f) => { for (let i = 0; i < 60 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); }; window.scrollTo(0, document.documentElement.scrollHeight); await until(deepNow); const a = [st(), deepNow()]; window.scrollTo(0, 0); await until(() => !deepNow()); return [...a, deepNow()]; });
    ok(`view motion: while you scroll or drag the light holds still, and moves again a moment after (${busy.join(' → ')})`, busy[0] === 'paused' && busy[1] === 'running', JSON.stringify(busy));
    ok(`view motion: scrolled away from the top, the light stops (nothing drawn off screen) and comes back at the top`, deep[0] === 'paused' && deep[1] === true && deep[2] === false, JSON.stringify(deep));
    ok(`view motion: the deep's slow light runs (${amb[3]} loops), pauses while the tab is hidden and comes back`, amb[0] === 'running' && amb[1] === 'paused' && amb[2] === 'running' && amb[3] >= 2, JSON.stringify(amb));
    ok('view motion: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- v0.5.1: round-1 design fixes (each check failed on v0.5.0) ----------
// balance: on a laptop the best find's two columns end together (v0.4.8-v0.5.0 left a hole of about 330 px under the
// liquidity map: the fees per $1,000 now stand under the map), and the strategy lab's chart fills the height of the list
// and the grid beside it (it left about 270 px empty). One column (a phone, a narrow window) keeps v0.5.0's order.
const BEST_COLS = () => {
  const q = (s) => document.querySelector(s), r = (e) => (e ? e.getBoundingClientRect() : null);
  const body = q('#best .best-body'), l = q('#best .best-l'), lq = q('#best .best-r'), dl = q('#best .daily'), gm = q('#best .gemnow');
  if (!body || !l || !lq || !dl) return null;
  // a column's box can stretch to its row (v0.5.0's flex row did): what counts is where its content ends
  const inner = (e) => { const b = r(e), k = [...e.children].map((c) => c.getBoundingClientRect()).filter((x) => x.height > 0); return k.length ? { left: b.left, right: b.right, top: b.top, width: b.width, bottom: Math.max(...k.map((x) => x.bottom)) } : b; };
  const B = r(body), L = inner(l), R = inner(lq), D = r(dl), G = gm ? r(gm) : null, side = Math.abs(L.top - R.top) < 1.5 && R.left > L.right;
  // what ends each column: everything of the card's body on the right of the left column's edge, and on its left
  const parts = [L, R, D, G].filter(Boolean), right = parts.filter((x) => x.left >= R.left - 1), left = parts.filter((x) => x.right <= L.right + 1);
  const end = (xs) => Math.max(...xs.map((x) => x.bottom));
  return { side, lw: Math.round(L.width), rw: Math.round(R.width), bodyB: Math.round(B.bottom), leftB: Math.round(end(left)), rightB: Math.round(end(right)), gemGap: G ? Math.round(G.top - L.bottom) : null,
    order: [['map', R.top], ['words', r(q('#best .bigline')).top], ['fees', D.top], ['gem', G ? G.top : Infinity]].sort((a, b) => a[1] - b[1]).map((x) => x[0]).join('>') };
};
const LAB_COLS = () => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const c = r('#bt-lab .lab-chart'), lg = r('#bt-lab .lab-legend'), ht = r('#bt-lab .lab-heat'), sv = r('[data-pz="lab"] svg');
  if (!c || !lg || !sv) return null;
  return { side: lg.left > c.right, chartB: Math.round(c.bottom), sideB: Math.round(Math.max(lg.bottom, ht ? ht.bottom : 0)), svgH: Math.round(sv.height), svgW: Math.round(sv.width) };
};
async function testBalance(browser) {
  const t = await openUnlocked(browser, 'default', { width: 1440 }), p = t.page;
  for (const w of [820, 1180, 1300, 1440, 1920]) {
    await p.setViewportSize({ width: w, height: 900 });
    // the page re-draws 120 ms after a resize (a timer): wait for the columns to settle, never a fixed time
    await p.waitForFunction(() => new Promise((res) => { const a = document.querySelector('#best .best-body').getBoundingClientRect().height; setTimeout(() => requestAnimationFrame(() => res(document.querySelector('#best .best-body').getBoundingClientRect().height === a)), 300); }), null, { timeout: 8000 }).catch(() => {});
    const a = await p.evaluate(BEST_COLS);
    ok(`balance w${w}: the best find stands in two columns, the map ${a && a.rw} px and the words ${a && a.lw} px wide (as before)`, !!a && a.side && a.rw >= 400 && a.lw >= 300 && a.rw > a.lw, JSON.stringify(a));
    ok(`balance w${w}: no hole under the liquidity map: both columns end within 48 px of each other (left ${a && a.leftB}, right ${a && a.rightB}, card body ${a && a.bodyB})`,
      !!a && Math.abs(a.leftB - a.rightB) <= 48 && a.bodyB - Math.max(a.leftB, a.rightB) <= 2, JSON.stringify(a));
    ok(`balance w${w}: …and no hole inside a column either: the gem's parts follow the words (${a && a.gemGap} px below them)`, !!a && a.gemGap != null && a.gemGap <= 40, JSON.stringify(a));
    const g = await p.evaluate(() => { const top = (s) => [...document.querySelectorAll('#best .gemnow ' + s)].map((e) => e.getBoundingClientRect().top), sp = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : null); return { n: top('.v').length, v: sp(top('.v')), bar: sp(top('.track')), two: [...document.querySelectorAll('#best .gemnow .lbl')].filter((e) => e.getClientRects().length > 1 || e.getBoundingClientRect().height > 20).length }; });
    ok(`balance w${w}: the gem's four parts keep their bars and values on one line (${g.two} label on two lines)`, g.n === 4 && g.v <= 1 && g.bar <= 1, JSON.stringify(g));
    if (w >= 1300) {
      await p.evaluate(() => document.querySelector('#bt-lab').scrollIntoView({ block: 'start' }));
      await p.waitForFunction(() => { const c = document.querySelector('#bt-lab .lab-chart'), l = document.querySelector('#bt-lab .lab-legend'); return c && l && document.querySelector('[data-pz="lab"] svg'); }, null, { timeout: 8000 }).catch(() => {});
      await frames(p, 2);
      const b = await p.evaluate(LAB_COLS);
      ok(`balance w${w}: the strategy lab's chart fills the height of the list and grid beside it (chart ends ${b && b.chartB}, they end ${b && b.sideB}), never taller than wide`,
        !!b && b.side && Math.abs(b.chartB - b.sideB) <= 24 && b.svgH >= 440 && b.svgH <= b.svgW * 1.06, JSON.stringify(b));
      await p.evaluate(() => scrollTo(0, 0));
    }
  }
  // one column: the words, the fees per $1,000, the gem's parts, then the map (a phone: the map first), as in v0.5.0
  await p.setViewportSize({ width: 700, height: 900 });
  await p.waitForFunction(() => { const l = document.querySelector('#best .best-l'), r = document.querySelector('#best .best-r'); return l && r && r.getBoundingClientRect().top > l.getBoundingClientRect().bottom; }, null, { timeout: 8000 }).catch(() => {});
  const n = await p.evaluate(BEST_COLS);
  ok(`balance w700: one column keeps its order (${n && n.order})`, !!n && !n.side && n.order === 'words>fees>gem>map', JSON.stringify(n));
  // a chart opened in a window of its own stands alone across the whole width (never in the grid's column)
  const pid = await bestId(p);
  for (const v of ['liq-best', 'daily-best']) {
    const s = await t.ctx.newPage();
    await s.setViewportSize({ width: 1440, height: 900 });
    await s.goto(url('default', `&view=${v}&pool=${encodeURIComponent(pid)}`));
    const w = await s.waitForSelector('.solo-box', { timeout: 20000 }).then(() => s.evaluate((v) => { const e = document.querySelector(`[data-chartbox="${v}"]`); return e ? Math.round(e.getBoundingClientRect().width) / document.documentElement.clientWidth : 0; }, v)).catch(() => 0);
    ok(`balance: "${v}" opened in a window of its own spans the window (${(w * 100).toFixed(0)}% of it; v0.5.0: 69%, the hidden side column kept its 400 px)`, w >= 0.9, String(w));
    if (v === 'liq-best') { // the map's drawing fills its taller box: its floor on its axis, the full-range label and the pill by the bars
      await frames(s, 3);
      const m = await s.evaluate(() => {
        const h = document.querySelector('[data-pz="liq-best"]'), r = (q) => { const e = h.querySelector(q); return e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' ? e.getBoundingClientRect() : null; };
        const sv = r('.pz-c > svg'), tk = r('.tick'), fr = r('.frlab'), cp = r('.cpill');
        return { axis: sv && tk ? Math.round(tk.top - sv.bottom) : null, fr: sv && fr ? Math.round(sv.bottom - fr.bottom) : null, pill: sv && cp ? Math.round(sv.bottom - cp.bottom) : null, plot: sv ? Math.round(sv.height) : null };
      });
      ok(`balance: the map in a window of its own: its floor sits on its axis (${m.axis} px apart; v0.5.0: 104), the full-range label on the floor (${m.fr} px above it; v0.5.0: about 300)`,
        m.axis != null && m.axis >= 0 && m.axis <= 12 && m.fr != null && m.fr >= 0 && m.fr <= 40 && m.pill != null && m.pill >= 0 && m.pill < m.plot * 0.6, JSON.stringify(m));
    }
    await s.close();
  }
  ok('balance: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  const ph = await openUnlocked(browser, 'default', { phone: true });
  const m = await ph.page.evaluate(BEST_COLS);
  ok(`balance phone: the map first, then the words, the fees per $1,000 and the gem's parts (${m && m.order})`, !!m && !m.side && m.order === 'map>words>fees>gem', JSON.stringify(m));
  ok('balance phone: no page errors', ph.errors.length === 0, ph.errors[0]);
  await ph.ctx.close();
}

// wraps: short phrases never split over two lines ("LP fees · 30 | d", "since | 15:44", "31 h | old", "gas | OK"), the
// strategy list's columns line up on every row (the baseline's Net APR stood 10-20 px off), and no scatter label sits on
// another pool's dot (a phone drew "IXPAX" over ORARX's)
const SPLITS = () => {
  const lines = (node, a, b) => { const r = document.createRange(); r.setStart(node, a); r.setEnd(node, b); const tops = []; for (const q of r.getClientRects()) if (q.width > 0.5 && !tops.some((t) => Math.abs(t - q.top) < 3)) tops.push(q.top); return tops.length; };
  const out = [], seen = { fees: 0, since: 0, old: 0, ck: 0 };
  const scan = (sel, re, key) => {
    for (const el of document.querySelectorAll(sel)) {
      if (!el.getClientRects().length) continue;
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) { re.lastIndex = 0; for (let m; (m = re.exec(n.textContent));) { seen[key]++; if (lines(n, m.index, m.index + m[0].length) > 1) out.push(key + ' "' + m[0] + '"'); } }
    }
  };
  scan('.fmrow > .lbl', /LP fees · \d+ d/g, 'fees');
  scan('.ns-row .lbl', /since [^·]*?\d\d:\d\d/g, 'since');
  scan('#disc .dc .m', /\d+ h old/g, 'old');
  for (const el of document.querySelectorAll('.checks .ck-ok, .checks .ck-bad, .checks .ck-null')) { if (!el.getClientRects().length) continue; seen.ck++; const n = el.lastChild; if (n && n.nodeType === 3 && n.textContent.trim() && lines(n, 0, n.textContent.length) > 1) out.push('check "' + n.textContent.trim().slice(0, 30) + '"'); }
  return { out, seen };
};
const LEGEND_COLS = () => {
  const rows = [...document.querySelectorAll('#bt-lab .lab-legend .strat')].filter((r) => r.getClientRects().length);
  const right = (s) => rows.map((r) => r.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect().right);
  const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : null);
  return { rows: rows.length, ap: spread(right('.ap')), rr: spread(right('.rr')) };
};
const SC_HITS = () => {
  const svg = document.querySelector('[data-pz="scatter"] svg');
  if (!svg) return null;
  const dots = [...svg.querySelectorAll('circle')].map((c) => c.getBoundingClientRect()), hits = [];
  const labels = [...svg.querySelectorAll('g text')];
  for (const t of labels) {
    const r = t.getBoundingClientRect(), y0 = r.top + r.height * 0.18, y1 = r.bottom - r.height * 0.18;
    const n = dots.filter((c) => c.left < r.right - 0.5 && c.right > r.left + 0.5 && c.top < y1 && c.bottom > y0).length;
    if (n) hits.push(t.textContent);
  }
  return { labels: labels.length, hits };
};
async function testWraps(browser) {
  for (const [tag, o] of [['w360', { width: 360, height: 760 }], ['phone', { phone: true }], ['w1440', { width: 1440 }]].slice(BROWSER === 'webkit' ? 1 : 0)) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    const a = await p.evaluate(SPLITS);
    ok(`wraps ${tag}: no short phrase splits over two lines (${a.seen.fees} fee labels, ${a.seen.since} "since", ${a.seen.old} "h old", ${a.seen.ck} checks)`, a.out.length === 0 && a.seen.fees >= 1 && a.seen.since >= 1 && a.seen.old >= 1 && a.seen.ck >= 5, a.out.slice(0, 3).join(', '));
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
    const s = await p.evaluate(SPLITS);
    ok(`wraps ${tag}: in a pool's panel too (${s.seen.ck} checks)`, s.out.length === 0 && s.seen.ck >= 5, s.out.slice(0, 3).join(', '));
    await p.click('#sheet-close'); await calm(p, SHEET_MOVES);
    await p.evaluate(() => document.querySelector('#bt-lab').scrollIntoView({ block: 'center' })); await frames(p, 2);
    const l = await p.evaluate(LEGEND_COLS);
    ok(`wraps ${tag}: the strategy list's Net APR and Re-rng · net line up on all ${l.rows} rows (off by ${l.ap} and ${l.rr} px)`, l.rows >= 5 && l.ap != null && l.ap <= 1 && l.rr <= 1, JSON.stringify(l));
    await p.evaluate(() => document.querySelector('[data-pz="scatter"]').scrollIntoView({ block: 'center' })); await frames(p, 2);
    const c = await p.evaluate(SC_HITS);
    ok(`wraps ${tag}: no scatter label sits on another pool's dot (${c && c.labels} labels)`, !!c && c.labels >= 5 && c.hits.length === 0, JSON.stringify(c));
    if (tag === 'w1440') { // the price pill never covers a pan arrow at the map's edge (panned so the price sits by it: v0.5.0 did, in 22 views)
      await setWin(p, '24h');
      const n = await p.$$eval('#best [data-act="tab"]', (e) => e.length), seen = { near: 0, hit: [] };
      for (let i = 0; i < n; i++) {
        await p.evaluate((i) => { document.querySelectorAll('#best [data-act="tab"]')[i].click(); document.querySelector('[data-pz="liq-best"]').scrollIntoView({ block: 'center' }); }, i); await frames(p, 2);
        for (const side of ['r', 'l']) for (let s = 0; s < 2; s++) {
          const went = await p.evaluate((side) => { const e = document.querySelector(`[data-pz="liq-best"] > .pz-edge.${side}`); if (!e || e.hidden || !e.getClientRects().length) return false; e.click(); return true; }, side);
          if (!went) break;
          await pzSettled(p, 'liq-best');
          const r = await p.evaluate(() => { const h = document.querySelector('[data-pz="liq-best"]'), c = h.querySelector('.cpill'); if (!c || !c.getClientRects().length) return null; const a = c.getBoundingClientRect(), es = [...h.querySelectorAll(':scope > .pz-edge')].filter((e) => !e.hidden && e.getClientRects().length).map((e) => e.getBoundingClientRect()); return { near: es.some((x) => a.left < x.right + 40 && a.right > x.left - 40), hit: es.some((x) => a.left < x.right && a.right > x.left && a.top < x.bottom && a.bottom > x.top) }; });
          if (r && r.near) seen.near++;
          if (r && r.hit) seen.hit.push(`${i}${side}${s}`);
        }
        await p.evaluate(() => { const z = document.querySelector('[data-act="zreset"][data-chart="liq-best"]'); if (z) z.click(); });
      }
      ok(`wraps ${tag}: the price pill never covers a pan arrow at the map's edge (${seen.near} views with it by an arrow)`, seen.near >= 3 && seen.hit.length === 0, JSON.stringify(seen));
    }
    ok(`wraps ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// floorlab (3D): the floor's "14 d ago" keeps clear of the LP shape's own lines (the price now, the walls), of every
// bar and of the pan arrows, which are drawn over it (v0.5.0 let the price line cross it on a laptop and a bar hide its "1" on a phone);
// on a narrow chart it may shorten to "14 d" or sit by the price line; it still shows wherever it finds room
const FLOOR_CLEAR = (pz) => {
  const h = document.querySelector(`[data-pz="${pz}"]`), c = h && h.querySelector(':scope > canvas.d3c'), info = c && c.__d3;
  if (!info || info.kind !== 'liq' || info.k !== 1) return null;
  if (!info.trail) return { trail: 0 };
  if (!info.lab) return { trail: info.trail, lab: false };
  if (!Array.isArray(info.labBox)) return { trail: info.trail, lab: true, box: false }; // drawn, but where is not told
  const hr = h.getBoundingClientRect(), svg = h.querySelector(':scope > .pz-c > svg'), vb = svg.viewBox.baseVal, sr = svg.getBoundingClientRect();
  const sx = sr.width / vb.width, sy = sr.height / vb.height, L = sr.left - hr.left, T = sr.top - hr.top, [a, b, c2, d] = info.labBox, hits = [];
  const hit = (x0, y0, x1, y1, what) => { if (x0 < c2 && x1 > a && y0 < d && y1 > b) hits.push(what); };
  for (const r of svg.querySelectorAll(':scope > rect')) {
    const w = +r.getAttribute('width'), hh = +r.getAttribute('height');
    if (!(w > 0 && w <= 2 && hh >= vb.height / 2)) continue; // the price now and the walls
    const x0 = L + (+r.getAttribute('x') - vb.x) * sx, y0 = T + (+r.getAttribute('y') - vb.y) * sy;
    hit(x0, y0, x0 + w * sx, y0 + hh * sy, 'line');
  }
  for (const e of h.querySelectorAll(':scope > .pz-edge')) { const r = e.getBoundingClientRect(); if (r.width > 0) hit(r.left - hr.left, r.top - hr.top, r.right - hr.left, r.bottom - hr.top, 'arrow'); } // the pan arrows sit over it too
  for (const el of svg.querySelectorAll(':scope > path')) {
    const f = el.getAttribute('fill');
    if (!(f === '#16C784' || f === '#3A4452' || el.classList.contains('mg'))) continue;
    for (const q of (el.getAttribute('d') || '').matchAll(/M(-?[\d.]+) (-?[\d.]+)v(-?[\d.]+)h([\d.]+)v/g)) {
      const x0 = L + (+q[1] - vb.x) * sx, yb = T + (+q[2] - vb.y) * sy, hh = -q[3] * sy;
      if (hh > 0.05) hit(x0, yb - hh, x0 + +q[4] * sx, yb, 'bar');
    }
  }
  return { trail: info.trail, lab: true, box: true, txt: info.labTxt || null, hits };
};
async function floorAt(p, pz) {
  await p.evaluate((pz) => { const h = document.querySelector(`[data-pz="${pz}"]`); if (h) h.scrollIntoView({ block: 'center' }); }, pz);
  await p.waitForFunction((pz) => { const c = document.querySelector(`[data-pz="${pz}"] > canvas.d3c`); return !!(c && c.__d3 && c.__d3.kind === 'liq' && c.__d3.k === 1); }, pz, { timeout: 10000 }).catch(() => {});
  return p.evaluate(FLOOR_CLEAR, pz);
}
async function testFloorLab(browser) {
  if (MODE === '2d') return; // a 3D drawing (the Classic 2D job has no floor)
  for (const [tag, o] of [['phone', { phone: true }], ['w1440', { width: 1440 }]].slice(0, BROWSER === 'webkit' ? 1 : 2)) { // WebKit: the phone (its job runs within 45 minutes)
    const t = await openUnlocked(browser, 'default', { ...o, mode: '3d' }), p = t.page;
    const n = await p.$$eval('#best [data-act="tab"]', (e) => e.length), res = [];
    for (let i = 0; i < n; i++) {
      await p.evaluate((i) => document.querySelectorAll('#best [data-act="tab"]')[i].click(), i);
      await frames(p, 2);
      res.push(await floorAt(p, 'liq-best'));
    }
    await p.evaluate(() => scrollTo(0, 0));
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
    res.push(await floorAt(p, 'liq-detail'));
    const read = res.filter(Boolean), trails = read.filter((x) => x.trail > 0), shown = trails.filter((x) => x.lab), bad = shown.filter((x) => !x.box || x.hits.length);
    ok(`floorlab ${tag}: the 3D floor's "N d ago" never sits under a bar or across the price line or a wall (${shown.length} of ${trails.length} charts with a trail labelled, ${read.length} of ${res.length} read)`,
      read.length === res.length && trails.length >= 4 && bad.length === 0, JSON.stringify(bad.slice(0, 2)));
    ok(`floorlab ${tag}: …and it is still drawn where it finds room (${shown.length} of ${trails.length} charts; v0.5.0: 4-5 of 11)`, shown.length >= Math.ceil(trails.length * 0.3), JSON.stringify(trails.map((x) => x.txt || '-')));
    ok(`floorlab ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- v0.5.1: the owner's iPhone (each check failed on v0.5.0) ----------
// iphone: the page opens fitting the screen and stays so: every field is 16 px on a touch screen (iOS Safari zooms into a
// smaller one when tapped and keeps that zoom, even on the next visit), every control takes a quick second tap as a tap
// (touch-action manipulation, never a double-tap zoom), pinch zoom stays allowed, nothing is wider than the screen; a laptop
// keeps its 13 px fields
const FIT = () => {
  const vis = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const fields = [...document.querySelectorAll('input:not([type="range"]):not([type="checkbox"]), select, textarea')].filter(vis);
  const ctrls = [...document.querySelectorAll('button, a[href], select, input, textarea, [data-act], [role="button"], [role="tab"]')].filter(vis);
  const vp = (document.querySelector('meta[name="viewport"]') || {}).content || '';
  const ms = /maximum-scale\s*=\s*([\d.]+)/.exec(vp);
  return {
    small: fields.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => (e.id || e.tagName.toLowerCase()) + ' ' + getComputedStyle(e).fontSize),
    nFields: fields.length, nCtrl: ctrls.length,
    zoomy: ctrls.filter((e) => getComputedStyle(e).touchAction === 'auto').map((e) => e.id || (e.dataset.act ? 'data-act=' + e.dataset.act : e.tagName.toLowerCase())).slice(0, 6),
    pinch: !/user-scalable\s*=\s*(no|0)/.test(vp) && (!ms || +ms[1] >= 2),
    scale: window.visualViewport ? Math.round(visualViewport.scale * 1000) / 1000 : 1, sw: document.documentElement.scrollWidth, iw: innerWidth,
  };
};
async function testIphone(browser) {
  const t = await openUnlocked(browser, 'default', { phone: true }), p = t.page, touch = !!(DEVICE || false);
  const a = await p.evaluate(FIT);
  ok(`iphone: every field is 16 px or more on a phone (${a.nFields} fields${a.small.length ? '; ' + a.small.join(', ') : ''})`, a.nFields >= 3 && a.small.length === 0, a.small.join(', '));
  ok(`iphone: every control takes a quick second tap as a tap, never a double-tap zoom (${a.nCtrl} controls)`, a.nCtrl > 40 && a.zoomy.length === 0, a.zoomy.join(', '));
  ok('iphone: pinch zoom stays allowed (the viewport neither fixes the scale nor turns zoom off)', a.pinch);
  // v0.6.1 (owner, 15 Nov 2026: the iPhone opened the page zoomed in, cut off at the right; "show which version runs")
  const v61 = await p.evaluate(async () => {
    const small = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea')]
      .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.className || e.tagName.toLowerCase());
    const ver = document.querySelector('#ver'), r = ver && ver.getBoundingClientRect();
    const verOk = !!ver && /^v\d+\.\d+\.\d+$/.test(ver.textContent.trim()) && ver.getClientRects().length > 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    // a made-up zoom: the page resets it once, then lifts the cap again so pinch-zoom still works
    let zoom = false;
    if (typeof window.__lpsFitZoom === 'function') {
      const m = document.querySelector('meta[name="viewport"]'), c0 = m.getAttribute('content');
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { scale: 1.3 } });
      const did = window.__lpsFitZoom(), capped = /maximum-scale=1/.test(m.getAttribute('content'));
      await new Promise((res) => setTimeout(res, 600));
      zoom = did && capped && m.getAttribute('content') === c0;
      delete window.visualViewport; // the browser's own again for the checks that follow
    }
    return { small, verOk, zoom };
  });
  ok(`iphone: every field, hidden ones too (the Compare picker), is 16 px or more, so a tap never zooms in${v61.small.length ? ' (' + v61.small.join(', ') + ')' : ''}`, v61.small.length === 0, v61.small.join(', '));
  ok('iphone: the running version shows small at the top of the first screen', v61.verOk);
  ok('iphone: a page that opens zoomed in fits the screen again, and pinch-zoom stays allowed afterwards', v61.zoom);
  // tap into the search, then double-tap the bar's switches, the map's zoom, its arrows and the best find's tabs, as a quick finger does
  const dbl = async (sel) => { const l = p.locator(sel).first(); if (!(await l.isVisible().catch(() => false))) return 0; await l.scrollIntoViewIfNeeded().catch(() => {}); if (touch) { await l.tap({ timeout: 5000 }).catch(() => {}); await l.tap({ timeout: 5000 }).catch(() => {}); } else await l.dblclick({ timeout: 5000 }).catch(() => {}); return 1; };
  if (touch) await p.tap('#f-q').catch(() => {}); else await p.click('#f-q');
  await p.$eval('#f-q', (e) => e.blur());
  let n = 0;
  for (const sel of ['#winseg [data-w="7d"]', '#winseg [data-w="30d"]', '#viewseg [aria-pressed="false"]', '[data-act="zoom"][data-chart="liq-best"][data-dir="1"]', '[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]', '[data-pz="liq-best"] > .pz-edge.l', '[data-pz="liq-best"] > .pz-edge.r', '#best [data-act="tab"]:not([aria-selected="true"])', '[data-act="stable"]', '[data-act="zoom"][data-chart="daily-best"][data-dir="1"]']) n += await dbl(sel);
  await frames(p, 3);
  const b = await p.evaluate(FIT);
  ok(`iphone: after a tap in the search and double taps on ${n} controls the page is still at scale ${b.scale} and fits the screen (${b.sw} ≤ ${b.iw} px)`, n >= 6 && b.scale === 1 && b.sw <= b.iw, JSON.stringify(b));
  // the pool panel too
  await p.evaluate(() => scrollTo(0, 0));
  await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
  let m = 0;
  for (const sel of ['#sheet-win [data-w="7d"]', '#sheet-win [data-w="24h"]', '#sheet [data-act="zoom"][data-chart="liq-detail"][data-dir="1"]', '#sheet [data-act="zoom"][data-chart="liq-detail"][data-dir="-1"]']) m += await dbl(sel);
  await frames(p, 3);
  const c = await p.evaluate(() => { const sb = document.querySelector('#sheet-body'); return { scale: window.visualViewport ? Math.round(visualViewport.scale * 1000) / 1000 : 1, sw: document.documentElement.scrollWidth, iw: innerWidth, hs: sb.scrollWidth - sb.clientWidth }; });
  ok(`iphone: in a pool's panel double taps on ${m} controls keep the scale at ${c.scale} and nothing sideways (page ${c.sw} ≤ ${c.iw}, panel ${c.hs} px)`, m >= 3 && c.scale === 1 && c.sw <= c.iw && c.hs <= 0, JSON.stringify(c));
  ok('iphone: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
  const l = await openUnlocked(browser, 'default', { width: 1440 });
  const f = await l.page.evaluate(() => [...document.querySelectorAll('.filters select, .filters input')].map((e) => getComputedStyle(e).fontSize));
  ok(`iphone: a laptop keeps its 13 px fields (${f.join(', ')})`, f.length >= 3 && f.every((x) => x === '13px'), f.join());
  await l.ctx.close();
}

// back: coming back to the page reads the sealed files again without asking (a hidden tab shown again, a page restored from
// the back-forward cache); after 5 minutes away, or with the next pass overdue, it is the refresh button's own refresh
// with its "Updated hh:mm" chip; every read bypasses the cache, the first one too
const COUNT_FETCH = () => { window.__lf = []; const of = window.fetch; window.fetch = (u, o) => { if (/live\.json/.test(String(u))) window.__lf.push((o && o.cache) || 'default'); return of(u, o); }; };
async function backCtx(browser, c) {
  const t = await newPage(browser, { phone: true });
  await t.ctx.addInitScript(COUNT_FETCH);
  await t.page.goto(url(c)); await unlockWith(t.page, FIXTURE_PASSPHRASE); await waitApp(t.page);
  return t;
}
const HIDE = () => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
const SHOW = () => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
async function backStep(p, fn, arg) {
  const n0 = await p.evaluate(() => window.__lf.length);
  await p.evaluate(() => { const m = document.querySelector('#refresh-msg'); m.hidden = true; m.textContent = ''; });
  await p.evaluate(fn, arg);
  await p.waitForFunction((n0) => window.__lf.length > n0, n0, { timeout: 8000 }).catch(() => {});
  await p.waitForFunction(() => !document.querySelector('#refresh').disabled, null, { timeout: 15000 }).catch(() => {}); // its refresh done
  await frames(p, 2);
  return p.evaluate((n0) => ({ n: window.__lf.length - n0, chip: document.querySelector('#refresh-msg').hidden ? '' : document.querySelector('#refresh-msg').textContent }), n0);
}
async function testBack(browser) {
  {
    const t = await backCtx(browser, 'default'), p = t.page;
    const modes = await p.evaluate(() => window.__lf.slice());
    ok(`back: the first read on opening bypasses the cache (${modes.join(', ')})`, modes.length >= 1 && modes.every((m) => m === 'no-store'), modes.join());
    const a = await backStep(p, ({ H, S }) => { new Function('return (' + H + ')')()(); new Function('return (' + S + ')')()(); }, { H: HIDE.toString(), S: SHOW.toString() });
    ok(`back: a tab shown again after a moment reads the data again, quietly (${a.n} read)`, a.n >= 1 && a.chip === '', JSON.stringify(a));
    const b = await backStep(p, ({ H, S }) => { new Function('return (' + H + ')')()(); const r = Date.now; Date.now = () => r() + 6 * 60e3; new Function('return (' + S + ')')()(); }, { H: HIDE.toString(), S: SHOW.toString() });
    ok(`back: after 6 minutes away it refreshes as the button does, with its chip ("${b.chip}")`, b.n >= 1 && /^Updated \d\d:\d\d/.test(b.chip), JSON.stringify(b));
    const c = await backStep(p, () => { const e = new Event('pageshow'); Object.defineProperty(e, 'persisted', { value: true }); dispatchEvent(e); });
    ok(`back: a page restored from the back-forward cache reads the data again (${c.n} read)`, c.n >= 1, JSON.stringify(c));
    const all = await p.evaluate(() => window.__lf.slice());
    ok(`back: every read bypasses the cache (${all.length} reads)`, all.every((m) => m === 'no-store'), [...new Set(all)].join());
    ok('back: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  {
    const t = await backCtx(browser, 'stale'), p = t.page; // the next pass is long overdue there
    const d = await backStep(p, () => { const r = Date.now; Date.now = () => r() + 2 * 60e3; dispatchEvent(new Event('focus')); });
    ok(`back: with the next pass overdue, coming back to the window refreshes with the chip ("${d.chip}")`, d.n >= 1 && /^Updated \d\d:\d\d/.test(d.chip), JSON.stringify(d));
    ok('back stale: no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// pull: on a phone, a finger pulling the page down from the very top shows a pill under the bar ("Pull to refresh",
// "Release to refresh", "Refreshing…", "Updated hh:mm") and runs one refresh; lower on the page, or with the panel open,
// a pull does nothing; under reduced motion nothing spins
const PULL = async ({ x, y0, y1, steps }) => {
  const el = document.elementFromPoint(x, y0);
  const mk = (type, y, down = true) => { const ev = new Event(type, { bubbles: true, cancelable: true }), t = { identifier: 5, clientX: x, clientY: y, target: el }; Object.defineProperty(ev, 'touches', { value: down ? [t] : [] }); Object.defineProperty(ev, 'changedTouches', { value: [t] }); return ev; };
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))), seen = [], q = document.querySelector('#ptr');
  el.dispatchEvent(mk('touchstart', y0));
  for (let i = 1; i <= steps; i++) { await frame(); el.dispatchEvent(mk('touchmove', y0 + ((y1 - y0) * i) / steps)); if (q) seen.push(q.hidden ? '-' : q.dataset.s + ':' + q.querySelector('.pt').textContent); }
  el.dispatchEvent(mk('touchend', y1, false));
  await frame();
  if (q) seen.push(q.hidden ? '-' : q.dataset.s + ':' + q.querySelector('.pt').textContent + ':' + getComputedStyle(q.querySelector('.sp')).display + ':' + getComputedStyle(q.querySelector('.sp')).animationName);
  return [...new Set(seen)];
};
async function testPull(browser) {
  for (const [tag, red] of [['phone', 'no-preference'], ['phone reduced', 'reduce']]) {
    const t = await newPage(browser, { phone: true, reducedMotion: red });
    await t.ctx.addInitScript(COUNT_FETCH);
    const p = t.page;
    await p.goto(url('default')); await unlockWith(p, FIXTURE_PASSPHRASE); await waitApp(p);
    await p.route('**/live.json*', async (r) => { await sleep(1200); await r.continue(); }); // a slow network: "Refreshing…" shows
    await p.evaluate(() => scrollTo(0, 0)); await calm(p, BAR_MOVES);
    const n0 = await p.evaluate(() => window.__lf.length);
    const seen = await p.evaluate(PULL, { x: 200, y0: 190, y1: 330, steps: 8 });
    await p.waitForFunction(() => document.querySelector('#ptr') && document.querySelector('#ptr').dataset.s === 'done', null, { timeout: 15000 }).catch(() => {});
    const end = await p.evaluate(() => { const q = document.querySelector('#ptr'); return q ? { s: q.dataset.s, t: q.querySelector('.pt').textContent, hid: q.hidden, top: Math.round(q.getBoundingClientRect().top), bar: Math.round(document.querySelector('#top').getBoundingClientRect().bottom) } : null; });
    await sleep(400);
    const n1 = await p.evaluate(() => window.__lf.length);
    const busy = seen[seen.length - 1] || '';
    ok(`pull ${tag}: pulled down from the very top, a pill under the bar says "Pull to refresh", then "Release to refresh" (${seen.slice(0, 3).join(' → ')})`, seen.some((x) => /^pull:Pull to refresh$/.test(x)) && seen.some((x) => /^release:Release to refresh$/.test(x)), JSON.stringify(seen));
    ok(`pull ${tag}: let go, it says "Refreshing…" (${red === 'reduce' ? 'nothing spinning' : 'spinning'}), runs one refresh (${n1 - n0} read) and says "${end && end.t}"`,
      /^busy:Refreshing…:/.test(busy) && (red === 'reduce' ? /:none:/.test(busy + ':') || /:none$/.test(busy) : /:block:spin$/.test(busy)) && n1 - n0 === 1 && !!end && end.s === 'done' && /^Updated \d\d:\d\d$/.test(end.t) && !end.hid && end.top >= end.bar, JSON.stringify([busy, n1 - n0, end]));
    await p.unroute('**/live.json*');
    await p.waitForFunction(() => document.querySelector('#ptr').hidden, null, { timeout: 8000 }).catch(() => {});
    // lower on the page: an ordinary scroll, nothing shown, nothing read
    await p.evaluate(() => scrollTo(0, 900)); await calm(p, BAR_MOVES);
    const m0 = await p.evaluate(() => window.__lf.length);
    const low = await p.evaluate(PULL, { x: 200, y0: 300, y1: 440, steps: 8 });
    await sleep(500);
    ok(`pull ${tag}: lower on the page a pull is a plain scroll: no pill, no refresh`, low.every((x) => x === '-') && (await p.evaluate(() => window.__lf.length)) === m0, JSON.stringify(low));
    if (red !== 'reduce') { // the open panel keeps its own drag
      await p.evaluate(() => scrollTo(0, 0)); await calm(p, BAR_MOVES);
      await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await calm(p, SHEET_MOVES);
      const k0 = await p.evaluate(() => window.__lf.length);
      const sh = await p.evaluate(PULL, { x: 200, y0: 300, y1: 440, steps: 8 });
      await sleep(500);
      ok(`pull ${tag}: with a pool's panel open a pull is the panel's: no pill, no refresh`, sh.every((x) => x === '-') && (await p.evaluate(() => window.__lf.length)) === k0, JSON.stringify(sh));
    }
    ok(`pull ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// full (v0.5.1, the owner's laptop): the ⧉ button opens a chart in a view that fills the whole window, edge to edge,
// above the bar and the pool panel, with the chart redrawn at that size (not a side view); Close, Esc, leaving the
// browser's fullscreen and Back each bring you back to the same scroll with the panel still open. Laptop widths in
// Chromium; WebKit: the phone (its job runs close to its time limit), where the view fills the screen as well.
const FULLV = () => { // the open view, measured: its cover of the window and the chart's width inside it
  const ws = document.querySelector('#ws');
  if (ws && !ws.hidden) { // v0.6.0: a pool's chart opens the pool's workspace on that chart's tab (the chart focused there)
    const r = ws.querySelector('.ws-card').getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
    const x = ws.querySelector('#ws-close'), xr = x.getBoundingClientRect(), top = [...document.elementsFromPoint(vw / 2, Math.min(vh - 2, r.top + 80))][0];
    let cw = 0;
    for (const el of document.querySelectorAll('#ws-body [data-pz], #ws-body .hs-stack')) { const q = el.getBoundingClientRect(); if (q.height > 40) cw = Math.max(cw, q.width); }
    const f = cw > 0;
    return { ws: true, cover: +cover.toFixed(3), onTop: !!top && ws.contains(top), cw: Math.round(cw), vw, fr: Math.round(r.width),
      x: xr.width >= 44 && xr.height >= 44 && xr.right <= vw + 0.5 && xr.top >= -0.5 && xr.bottom <= vh && !!x.getAttribute('aria-label'), xRight: xr.left > vw / 2, solo: !!f, bar: false };
  }
  const ov = document.querySelector('#fullv'), f = ov && ov.querySelector('iframe');
  if (!ov || !f) return null;
  const r = ov.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
  const x = ov.querySelector('[data-act="fullclose"]'), xr = x && x.getBoundingClientRect();
  const top = [...document.elementsFromPoint(vw / 2, Math.min(vh - 2, r.top + 80))][0];
  const d = f.contentDocument, box = d && d.querySelector('.solo-box');
  let cw = 0;
  if (box) for (const el of box.querySelectorAll('svg, canvas')) { const q = el.getBoundingClientRect(); if (q.height > 60) cw = Math.max(cw, q.width); }
  return { cover: +cover.toFixed(3), onTop: !!top && ov.contains(top), cw: Math.round(cw), vw, fr: Math.round(f.getBoundingClientRect().width),
    x: !!xr && xr.width >= 44 && xr.height >= 44 && xr.right <= vw + 0.5 && xr.top >= -0.5 && xr.bottom <= vh && !!x.getAttribute('aria-label'),
    xRight: !!xr && xr.left > vw / 2, solo: !!(d && d.body.classList.contains('full')), bar: !!(d && d.querySelector('header.top') && d.querySelector('header.top').offsetHeight) };
};
async function fullWait(p) {
  await p.waitForFunction(() => { const ws = document.querySelector('#ws'); if (ws && !ws.hidden && document.querySelector('#ws-body > .ws-in')) return true; const f = document.querySelector('#fullv iframe'); const d = f && !f.classList.contains('wait') && f.contentDocument; return !!(d && d.querySelector('.solo-box')); }, null, { timeout: BROWSER === 'webkit' ? 30000 : 20000 }).catch(() => {});
  await sleep(250);
}
const FULL_X = '#fullv [data-act="fullclose"], #ws:not([hidden]) #ws-close'; // the open view's Close (v0.6.0: the workspace's)
const fullGone = () => !document.querySelector('#fullv') && !(document.querySelector('#ws') && !document.querySelector('#ws').hidden);
async function testFull(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['w1300', { width: 1300, height: 820 }], ['w1440', { width: 1440 }], ['w1920', { width: 1920, height: 1080 }], ['phone', { phone: true }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', o), p = t.page, lap = tag !== 'phone';
    await p.evaluate(() => { window.__keepFull = true; });
    const ways = ['close', 'esc', 'fs', 'back'];
    let n = 0;
    const bad = [], miss = [], wayBad = [], seen = [];
    // the main page's charts, then a pool's panel's (the panel stays open under the view)
    for (const where of ['main', 'sheet']) {
      if (where === 'sheet') { await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(400); }
      if (where === 'main' && lap && BROWSER !== 'webkit') { await p.evaluate(() => { const r = document.querySelector('[data-act="bt-row"]'); if (r) r.click(); }); await sleep(600); } // the replay's charts too
      const ids = await p.evaluate((w) => [...document.querySelectorAll('[data-act="openchart"]')].filter((b) => b.offsetParent && (w === 'sheet') === !!b.closest('#sheet')).map((b) => b.dataset.chart + '|' + (b.dataset.pool || '')), where);
      const pick = BROWSER === 'webkit' ? ids.slice(0, 2) : lap ? ids : ids.slice(0, 3);
      for (const key of pick) {
        const [id, pool] = key.split('|');
        const y0 = await p.evaluate(({ id, pool, where }) => {
          const b = [...document.querySelectorAll(`[data-act="openchart"][data-chart="${id}"]`)].find((e) => e.offsetParent && (e.dataset.pool || '') === pool && (where === 'sheet') === !!e.closest('#sheet'));
          if (!b) return null;
          b.scrollIntoView({ block: 'center' }); window.dispatchEvent(new WheelEvent('wheel')); b.setAttribute('data-fv-t', '1');
          return { y: Math.round(scrollY), sb: Math.round(document.querySelector('#sheet-body').scrollTop) };
        }, { id, pool, where });
        if (!y0) { miss.push(id); continue; }
        await sleep(150);
        const pos = await p.evaluate(() => ({ y: Math.round(scrollY), sb: Math.round(document.querySelector('#sheet-body').scrollTop) }));
        await p.click('[data-fv-t="1"]'); await p.evaluate(() => document.querySelector('[data-fv-t]').removeAttribute('data-fv-t'));
        await fullWait(p);
        const m = await p.evaluate(FULLV);
        n++; seen.push(id);
        if (!m || m.cover < 0.98 || !m.onTop || !m.x || !m.xRight || !m.solo || m.bar || m.cw < (m.ws ? 0.6 : 0.9) * m.vw - (lap ? 0 : 24)) bad.push(`${where}:${id} ${JSON.stringify(m)}`); // v0.6.0: a pool's chart: its workspace (a column of it)
        // the way out, in turn: Close, Esc, the browser's fullscreen exit, Back
        const way = ways[n % ways.length];
        if (way === 'close') await p.click(FULL_X);
        else if (way === 'esc') await p.keyboard.press('Escape');
        else if (way === 'fs') await p.evaluate((x) => { if (document.fullscreenElement) document.exitFullscreen(); else document.querySelector(x).click(); }, FULL_X);
        else await p.evaluate(() => history.back());
        await p.waitForFunction(fullGone, null, { timeout: 5000 }).catch(() => {});
        await sleep(250);
        const back = await p.evaluate(({ id, G }) => ({ gone: new Function('return (' + G + ')')()(), y: Math.round(scrollY), sb: Math.round(document.querySelector('#sheet-body').scrollTop), sheet: !document.querySelector('#sheet').hidden, lock: document.documentElement.classList.contains('full-open') || document.documentElement.classList.contains('ws-open'),
          focus: !!document.activeElement && document.activeElement.dataset.act === 'openchart' && document.activeElement.dataset.chart === id, lv: history.state && history.state.lps ? history.state.lv : 0 }), { id, G: fullGone.toString() });
        const wantLv = where === 'sheet' ? 1 : 0;
        if (!back.gone || back.lock || Math.abs(back.y - pos.y) > 2 || Math.abs(back.sb - pos.sb) > 2 || back.sheet !== (where === 'sheet') || (way !== 'back' && way !== 'fs' && !back.focus) || back.lv !== wantLv) wayBad.push(`${where}:${id} by ${way} ${JSON.stringify(back)} vs ${JSON.stringify(pos)}`);
      }
    }
    ok(`full ${tag}: every chart's ⧉ opens a view over the whole window (≥98%, above the bar and the panel), the chart ${lap ? '≥90% of its width' : 'the screen wide'}, Close top right (${n} charts)`, n >= (BROWSER === 'webkit' ? 4 : lap ? 12 : 6) && bad.length === 0 && miss.length === 0, (bad[0] || '') + (miss.length ? ' missing ' + miss.join(',') : '') + ` (${seen.join(',')})`);
    ok(`full ${tag}: Close, Esc, leaving fullscreen and Back each return to the same scroll, the panel still open, focus on ⧉`, n > 0 && wayBad.length === 0, wayBad.slice(0, 2).join(' | '));
    ok(`full ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    if (SHOTS && tag === 'w1440') {
      await p.evaluate(() => document.querySelector('#sheet [data-act="openchart"]').click()); await fullWait(p);
      await p.screenshot({ path: path.join(SHOTS, 'full-view-w1440.png') }); await p.keyboard.press('Escape');
    }
    await t.ctx.close();
  }
}

// way (v0.5.1, the owner's standing rule: every view has a way out that lands somewhere real; think like an iOS user):
// every note, the pool panel, its pair view and a full view have a visible close (44 px, labelled, on screen); Back
// closes them one level per step and never leaves the dashboard; a view closed by its Close, Esc, the dimmed
// background or a swipe takes its history entry with it; closing gives back the scroll and the focus; a chart's own
// page (a link opened on its own) closes onto the dashboard; a link to a chart that is gone says so, with a way to the
// main view; after any mix of opening and closing nothing is left blank or dimmed.
const WAY_LOOK = () => {
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const sheet = document.querySelector('#sheet'), pop = document.querySelector('#pop'), scrim = document.querySelector('#sheet .scrim');
  return { sheet: vis(sheet), pair: vis(sheet) && /PAIR VIEW/.test(document.querySelector('#sheet-kicker').textContent), pop: vis(pop), full: !!document.querySelector('#fullv') || vis(document.querySelector('#ws')), // v0.6.0: a pool's ⧉ opens its workspace
    dim: vis(scrim) || document.documentElement.classList.contains('modal-open') || document.documentElement.classList.contains('full-open') || document.documentElement.classList.contains('ws-open'),
    lv: history.state && history.state.lps ? history.state.lv : 0, len: history.length, mark: window.__wayMark === 1, solo: document.body.classList.contains('solo') };
};
const CLOSE_OK = (sel) => { // a close control: there, visible, 44 px, labelled, inside the window
  const el = document.querySelector(sel);
  if (!el || el.closest('[hidden]')) return 'missing';
  const r = el.getBoundingClientRect();
  if (r.width < 43.5 || r.height < 43.5) return `small ${Math.round(r.width)}x${Math.round(r.height)}`; // 44 px, give or take a device pixel
  if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) return 'off screen';
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || !(el === hit || el.contains(hit))) return 'covered';
  return el.getAttribute('aria-label') ? '' : 'no label';
};
async function wayBack(p) { // the browser's Back, then the page settles
  await p.evaluate(() => history.back());
  await p.waitForFunction(() => !window.__wayPop0 || window.__wayPops > window.__wayPop0, null, { timeout: 3000 }).catch(() => {});
  await sleep(250);
}
async function testWay(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['phone', { phone: true }], ['w1440', { width: 1440 }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', o), p = t.page, phone = tag === 'phone';
    await p.evaluate(() => { window.__wayMark = 1; window.__keepFull = true; window.__wayPops = 0; addEventListener('popstate', () => { window.__wayPops++; }); });
    const settle = async () => { await p.evaluate(() => { window.__wayPop0 = window.__wayPops; }); };
    const L0 = (await p.evaluate(WAY_LOOK)).len;
    // 1. every view's close: the note (ⓘ), the panel, its pair view, a full view
    const closes = {};
    await p.evaluate(() => { const b = document.querySelector('main [data-act="term"], main [data-act="why"]'); b.scrollIntoView({ block: 'center' }); }); await sleep(200);
    await p.locator('main [data-act="term"], main [data-act="why"]').first().click(); await sleep(200);
    closes.note = await p.evaluate(CLOSE_OK, '#pop [data-act="popclose"]');
    await p.evaluate(() => { const b = document.querySelector('#pop [data-act="popclose"]'); if (b) b.click(); }); await sleep(150);
    const noteBack = await p.evaluate(() => ({ pop: !document.querySelector('#pop').hidden, focus: !!document.activeElement && ['term', 'why'].includes(document.activeElement.dataset.act) }));
    await p.evaluate(() => scrollTo(0, 0)); await sleep(150);
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(450);
    closes.panel = await p.evaluate(CLOSE_OK, '#sheet-close');
    // 2. Back closes them one level per step (a full view over the panel → the panel; the pair view → its pool; the
    // panel → the dashboard), never the page
    const steps = [];
    await p.evaluate(() => document.querySelector('#sheet [data-act="openchart"]').click()); await fullWait(p);
    closes.full = await p.evaluate(CLOSE_OK, (await p.$('#fullv')) ? '#fullv [data-act="fullclose"]' : '#ws-close');
    await settle(); await wayBack(p); steps.push(['full', await p.evaluate(WAY_LOOK), true, false]);
    const hasPair = await p.evaluate(() => { const b = document.querySelector('#sheet-pair'); return !!b && !b.hidden; });
    if (hasPair) {
      await p.click('#sheet-pair'); await sleep(350); closes.pair = await p.evaluate(CLOSE_OK, '#sheet-close');
      await settle(); await wayBack(p); steps.push(['pair', await p.evaluate(WAY_LOOK), true, false]);
    }
    await settle(); await wayBack(p); steps.push(['panel', await p.evaluate(WAY_LOOK), false, false]);
    const badClose = Object.entries(closes).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    ok(`way ${tag}: every view has a visible, labelled close of 44 px on screen (${Object.keys(closes).join(', ')})`, Object.keys(closes).length >= 3 && badClose.length === 0 && !noteBack.pop && noteBack.focus, badClose.join(' | ') + ' ' + JSON.stringify(noteBack));
    const last = steps[steps.length - 1][1];
    const stepOk = steps.every(([, s, sh, pr]) => s.mark && !s.full && s.sheet === sh && s.pair === pr) && !last.dim && last.lv === 0;
    ok(`way ${tag}: Back closes the top view one level at a time (${steps.map((x) => x[0]).join(' → ')}) and the dashboard stays`, stepOk, JSON.stringify(steps.map(([k, s]) => [k, s.full, s.pair, s.sheet, s.lv, s.mark])));
    // 3. closing any other way leaves no entry behind: Back afterwards does nothing, and the history doesn't grow
    const others = [];
    const L1 = (await p.evaluate(WAY_LOOK)).len;
    for (const how of ['close', 'esc', phone ? 'swipe' : 'scrim', 'note']) {
      await p.evaluate(() => scrollTo(0, 400)); await sleep(150);
      const y = await p.evaluate(() => Math.round(scrollY));
      if (how === 'note') {
        await p.evaluate(() => { const b = [...document.querySelectorAll('main [data-act="term"], main [data-act="why"], main [data-act="gas"]')].find((e) => e.offsetParent); b.scrollIntoView({ block: 'center' }); b.click(); }); await sleep(200);
        await p.evaluate(() => document.querySelector('#foot-l').click()); await sleep(200); // a tap elsewhere puts it away
        const after = await p.evaluate(WAY_LOOK);
        others.push({ how, ok: !after.pop && after.lv === 0 });
        continue;
      }
      await p.evaluate(() => document.querySelector('#best [data-act="detail"]').click()); await p.waitForSelector('#sheet:not([hidden])'); await sleep(450);
      if (how === 'close') await p.click('#sheet-close');
      else if (how === 'esc') await p.keyboard.press('Escape');
      else if (how === 'scrim') await p.mouse.click(30, 300);
      else await pull(p, '#sheet .grab', 420, { ms: 16, steps: 8 });
      await p.waitForFunction(() => document.querySelector('#sheet').hidden, null, { timeout: 4000 }).catch(() => {});
      await sleep(300);
      const after = await p.evaluate(WAY_LOOK);
      others.push({ how, ok: !after.sheet && !after.dim && after.lv === 0 && Math.abs((await p.evaluate(() => Math.round(scrollY))) - y) <= 2 });
    }
    const L2 = (await p.evaluate(WAY_LOOK)).len, still = await p.evaluate(WAY_LOOK);
    ok(`way ${tag}: closed by Close, Esc, ${phone ? 'a swipe down' : 'the dimmed background'} or a tap elsewhere, a view takes its history entry with it (same scroll, nothing dimmed)`,
      others.every((x) => x.ok) && L2 <= L1 + 1 && still.mark && !still.sheet && !still.dim, JSON.stringify(others) + ` history ${L0}/${L1}/${L2}`);
    // 4. any mix of opening and closing ends on the dashboard, visible, nothing dimmed (a made-up but fixed sequence)
    let seed = 7; const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    for (let k = 0; k < 14; k++) {
      const look = await p.evaluate(WAY_LOOK), r = rnd(6);
      if (r === 0 && !look.sheet && !look.full) await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); });
      else if (r === 1 && look.sheet && !look.pair && !look.full) await p.evaluate(() => { const b = document.querySelector('#sheet-pair'); if (b && !b.hidden) b.click(); });
      else if (r === 2 && !look.full) await p.evaluate((sh) => { const b = document.querySelector(sh ? '#sheet [data-act="openchart"]' : 'main [data-act="openchart"]'); if (b) b.click(); }, look.sheet);
      else if (r === 3 && look.lv > 0) { await settle(); await wayBack(p); }
      else if (r === 4) await p.keyboard.press('Escape');
      else if (r === 5 && !look.full) await p.evaluate((sh) => { const b = [...document.querySelectorAll(sh ? '#sheet [data-act="term"], #sheet [data-act="why"]' : 'main [data-act="term"], main [data-act="why"]')].find((e) => e.offsetParent); if (b) b.click(); }, look.sheet);
      await sleep(350);
    }
    for (let k = 0; k < 4 && (await p.evaluate(WAY_LOOK)).lv > 0; k++) { await settle(); await wayBack(p); }
    await p.evaluate(() => scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);
    const fin = await p.evaluate(() => { const b = document.querySelector('#best'); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { best: r.height > 100, el: !!hit && !!hit.closest('main'), at: [Math.round(r.top), Math.round(r.height), Math.round(scrollY)], hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 20) + '#' + hit.id : '' }; });
    const end = await p.evaluate(WAY_LOOK);
    ok(`way ${tag}: after a mix of opening and closing, Back leads to the dashboard: visible, nothing open or dimmed, never left`, end.mark && !end.sheet && !end.pop && !end.full && !end.dim && end.lv === 0 && fin.best && fin.el, JSON.stringify({ ...end, ...fin }));
    // 5. a reload while the panel is open opens on the main view, with nothing dimmed
    await p.evaluate(() => document.querySelector('#best [data-act="detail"]').click()); await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    await p.reload(); await p.waitForSelector('#app:not([hidden]), #lockscreen:not([hidden])', { timeout: 30000 });
    if (await p.isVisible('#lockscreen')) await unlockWith(p, FIXTURE_PASSPHRASE);
    await waitApp(p);
    const rl = await p.evaluate(WAY_LOOK);
    ok(`way ${tag}: a reload with the panel open opens on the dashboard's main view`, !rl.sheet && !rl.dim && rl.lv === 0, JSON.stringify(rl));
    ok(`way ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 6. a chart's own page, opened from a link on its own (no opener): Close lands on the dashboard's main view; a link to
  // a chart that is gone says so and offers the main view
  {
    const t = await openUnlocked(browser, 'default', { phone: true }), p = t.page;
    const pool = await p.getAttribute('#best [data-act="detail"]', 'data-id');
    await p.goto(url('default', `&view=liq-detail&pool=${pool}&w=30d`));
    await p.waitForSelector('.solo-box', { timeout: 30000 }).catch(() => {});
    const cap = await p.evaluate(CLOSE_OK, '.solo-cap [data-act="soloclose"]');
    await p.click('.solo-cap [data-act="soloclose"]').catch(() => {});
    await p.waitForFunction(() => !/[?&]view=/.test(location.search) && document.querySelector('#best') && document.querySelector('#best').children.length > 0, null, { timeout: 30000 }).catch(() => {});
    const main = await p.evaluate(() => ({ view: /[?&]view=/.test(location.search), solo: document.body.classList.contains('solo'), best: !!document.querySelector('#best') && document.querySelector('#best').getBoundingClientRect().height > 100 }));
    ok('way: a chart opened from a link on its own has a Close that lands on the dashboard\'s main view', !cap && !main.view && !main.solo && main.best, cap + ' ' + JSON.stringify(main));
    await p.goto(url('default', '&view=liq-detail&pool=0x00000000000000000000000000000000000000ff&w=30d'));
    await p.waitForSelector('#solo-dead', { timeout: 30000 }).catch(() => {});
    const dead = await p.evaluate(() => { const d = document.querySelector('#solo-dead'); const b = d && d.querySelector('[data-act="soloclose"]'); const r = d && d.getBoundingClientRect(); return { msg: !!d && /isn.t in the latest data/.test(d.textContent), btn: !!b, top: r ? Math.round(r.top) : null, vh: innerHeight }; });
    if (dead.btn) await p.click('#solo-dead [data-act="soloclose"]');
    await p.waitForFunction(() => !/[?&]view=/.test(location.search) && document.querySelector('#best') && document.querySelector('#best').children.length > 0, null, { timeout: 30000 }).catch(() => {});
    const home = await p.evaluate(() => !/[?&]view=/.test(location.search) && !document.querySelector('#solo-dead'));
    ok('way: a link to a chart that is gone says so, on screen, with a button to the main view that works', dead.msg && dead.btn && dead.top != null && dead.top < dead.vh && home, JSON.stringify(dead) + ' ' + home);
    ok('way: no page errors on the chart\'s own page', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// qsearch (v0.5.1, the owner: "I fill in just 'uni' and it feels odd … I'd have to click and confirm"): the search works
// like iOS: no greyed completion; as you type, a line says how many pools match and the matching rows show right under
// it, in view (above where the keyboard sits) and never covered by the suggestions; a suggestion acts when tapped; the
// Search key puts the keyboard away; ✕ clears; the 🔍 in the bar (and "/" on a laptop) goes to the search, ready to type.
async function testQsearch(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const look = () => p.evaluate(() => {
      const inp = document.querySelector('#f-q'), vh = innerHeight, kb = navigator.maxTouchPoints > 0 ? vh * 0.6 : vh; // a phone's keyboard takes about the lower 40%
      const st = document.querySelector('#q-stat'), sr = st && st.getBoundingClientRect(), rows = [...document.querySelectorAll('#all tbody tr.row')];
      const r0 = rows[0] && rows[0].querySelector('.pn2'), rr = r0 && r0.getBoundingClientRect();
      const hit = rr ? document.elementFromPoint(rr.left + Math.min(20, rr.width / 2), rr.top + rr.height / 2) : null;
      const ghost = document.querySelector('#q-hint'), x = document.querySelector('#q-x'), xr = x && x.getBoundingClientRect();
      return { v: inp.value, focus: document.activeElement === inp, ghost: !!ghost && !!ghost.textContent, top: Math.round(inp.getBoundingClientRect().top), vh: Math.round(vh), kb: Math.round(kb),
        stat: st && !st.closest('[hidden]') && sr.height > 0 ? st.textContent : '', statIn: !!sr && sr.top >= 0 && sr.bottom <= kb,
        rows: rows.length, rowIn: !!rr && rr.top >= 0 && rr.bottom <= kb, rowSeen: !!hit && !!r0 && r0.contains(hit), lit: !!(r0 && r0.querySelector('b')),
        chips: [...document.querySelectorAll('#q-list .qopt')].filter((o) => o.getClientRects().length).length, x: !!xr && !x.hidden && xr.width >= 44 && xr.height >= 44 };
    });
    // the 🔍 in the bar, from the top of the page
    await p.evaluate(() => scrollTo({ top: 0, behavior: 'instant' })); await sleep(200);
    const fb = await p.$('#qfind');
    const fbOk = !!fb && (await fb.isVisible());
    if (fbOk) await p.click('#qfind'); else { await p.evaluate(() => document.querySelector('#f-q').scrollIntoView({ block: 'center' })); await p.click('#f-q'); }
    await sleep(300);
    let a = await look();
    ok(`qsearch ${tag}: the 🔍 in the bar goes to the search, ready to type, near the top`, fbOk && a.focus && a.top >= 0 && a.top < a.vh * 0.4, JSON.stringify({ fbOk, focus: a.focus, top: a.top, vh: a.vh }));
    await p.keyboard.type('ko', { delay: 60 }); await sleep(350);
    a = await look();
    ok(`qsearch ${tag}: no greyed completion: the field holds exactly "ko"`, a.v === 'ko' && !a.ghost, JSON.stringify({ v: a.v, ghost: a.ghost }));
    ok(`qsearch ${tag}: as you type, a line says how many match and the first matching row (its match lit) shows in view${phone ? ' above the keyboard' : ''}, not under the suggestions`,
      /^\d+ pools? match(es)? “ko”/.test(a.stat) && a.statIn && a.rows >= 1 && a.rowIn && a.rowSeen && a.lit, JSON.stringify(a));
    ok(`qsearch ${tag}: ✕ shows while there is text, 44 px`, a.x, JSON.stringify(a.x));
    // a suggestion acts when tapped: a pair filters to it, and the keyboard goes
    const chip = await p.$('#q-list .qopt');
    if (chip) { if (phone) await chip.tap().catch(() => chip.click()); else await chip.click(); }
    await sleep(350);
    a = await look();
    ok(`qsearch ${tag}: tapping a suggestion acts: the rows filter to it and the keyboard goes`, !!chip && a.v.length > 2 && !a.focus && a.rows >= 1 && /match/.test(a.stat), JSON.stringify({ v: a.v, focus: a.focus, rows: a.rows }));
    // ✕ clears and keeps the field
    if (await p.isVisible('#q-x')) await p.click('#q-x');
    await sleep(250);
    a = await look();
    ok(`qsearch ${tag}: ✕ clears the field and every row comes back`, a.v === '' && a.rows > 2 && !a.stat, JSON.stringify({ v: a.v, rows: a.rows, stat: a.stat }));
    // the Search key (Enter): nothing to confirm, the keyboard goes, the rows stay
    await p.focus('#f-q'); await p.keyboard.type('xyz', { delay: 40 }); await sleep(300);
    const none = await look();
    await p.keyboard.press('Enter'); await sleep(250);
    a = await look();
    ok(`qsearch ${tag}: no match says so with a way back; Enter only puts the keyboard away`, /^No pools match “xyz”/.test(none.stat) && /Clear filters/.test(none.stat) && a.v === 'xyz' && !a.focus, JSON.stringify({ stat: none.stat, v: a.v, focus: a.focus }));
    await p.evaluate(() => { const b = [...document.querySelectorAll('#q-stat .linkbtn')].pop(); if (b) b.click(); }); await sleep(250);
    a = await look();
    ok(`qsearch ${tag}: "Clear filters" brings every row back`, a.v === '' && a.rows > 2, JSON.stringify({ v: a.v, rows: a.rows }));
    if (!phone) { // the laptop's keys: "/" goes to the search; Esc clears, then leaves
      await p.evaluate(() => { document.activeElement && document.activeElement.blur(); scrollTo({ top: 0, behavior: 'instant' }); }); await sleep(150);
      await p.keyboard.press('/'); await sleep(250);
      const sl = await look();
      await p.keyboard.type('vel', { delay: 30 }); await sleep(250);
      await p.keyboard.press('Escape'); await sleep(150);
      const e1 = await look();
      await p.keyboard.press('Escape'); await sleep(150);
      const e2 = await look();
      ok('qsearch laptop: "/" goes to the search; Esc clears it, a second Esc leaves it', sl.focus && sl.v === '' && e1.v === '' && e1.focus && !e2.focus, JSON.stringify({ s: sl.focus, e1: [e1.v, e1.focus], e2: e2.focus }));
    }
    // the filters say what they did at once, the same way
    await p.selectOption('#f-chain', { index: 1 }); await sleep(150);
    a = await look();
    ok(`qsearch ${tag}: a chain picked says at once how many pools it leaves`, /^\d+ pools? match(es)? [A-Z]/.test(a.stat), a.stat);
    await p.selectOption('#f-chain', 'all'); await sleep(150);
    ok(`qsearch ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// stress (v0.5.2): on the widest fixtures (12-letter symbols, long venues and check labels, ~1,500 pools) a phone's page
// never scrolls sideways after a press: every best-find tab, each window, a pool's panel, "Show all", a Discovery lane's
// "see all" and its Clear, the 🔍, the notes (the live iPhone audit on real data scrolled 101 px after a tab: a check
// label that could not wrap). A failure names what sticks out by structure only (tags, ids, classes).
const HS_WHO = () => {
  const cw = document.documentElement.clientWidth, hs = document.documentElement.scrollWidth - cw;
  if (hs <= 0) return null;
  const ok = (x) => /^[a-z][a-z0-9_-]{0,40}$/i.test(x) && !/^0x|[0-9a-f]{8,}/i.test(x);
  const clips = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.position === 'fixed') return true; } return false; };
  const name = (el) => el.tagName.toLowerCase() + (el.id && ok(el.id) ? '#' + el.id : '') + [...el.classList].filter(ok).slice(0, 3).map((c) => '.' + c).join('');
  let best = null, over = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right - cw <= over + 0.5 || getComputedStyle(el).position === 'fixed' || clips(el)) continue;
    best = el; over = r.right - cw;
  }
  const chain = []; for (let e = best; e && e !== document.body && chain.length < 3; e = e.parentElement) chain.unshift(name(e));
  return `${hs}px · ${chain.join(' > ') || 'nothing found past the edge'}`;
};
async function testStress(browser) {
  const t = await openUnlocked(browser, 'stress', { phone: true }), p = t.page, bad = [];
  let n = 0;
  const after = async (kind) => { n++; await frames(p, 2); await sleep(120); const w = await p.evaluate(HS_WHO); if (w && bad.length < 3) bad.push(`after ${kind} · ${w}`); };
  const press = (sel, i = 0) => p.evaluate(({ sel, i }) => { const el = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length)[i]; if (!el) return false; window.dispatchEvent(new WheelEvent('wheel')); el.scrollIntoView({ block: 'center' }); el.click(); return true; }, { sel, i });
  await after('unlock');
  const tabs = await p.$$eval('#best [role="tab"]', (x) => x.length);
  for (let i = 0; i < Math.min(tabs, 12); i++) if (await press('#best [role="tab"]', i)) await after('tab');
  for (const wk of ['24h', '7d', '30d']) { await setWin(p, wk); await after('win'); }
  for (const v of ['2d', '3d']) { if (await press(`#viewseg [data-v="${v}"]`)) { await sleep(300); await after('view'); } }
  for (let i = 0; i < 3; i++) if (await press('main [data-act="why"]', i)) { await after('why'); await p.keyboard.press('Escape'); await sleep(100); }
  if (await press('#best [data-act="detail"]')) { await p.waitForSelector('#sheet:not([hidden])').catch(() => {}); await sleep(300); await after('detail'); await p.click('#sheet-close').catch(() => {}); await sleep(200); await after('close'); }
  if (await press('[data-act="more"]')) await after('more');
  if (await press('[data-act="dl-all"]')) { await sleep(400); await after('dl-all'); if (await press('#q-stat [data-act="q-reset"]')) await after('q-reset'); }
  if (await press('#qfind')) { await after('qfind'); await p.$eval('#f-q', (e) => e.blur()); }
  // v0.5.3: the scrubber's labels in a backtest replay sat right of the line at the chart's right edge; real dollar amounts
  // ran past the chart and the iPhone page scrolled sideways (live audit, 15 Nov 2026). No chart text may pass its chart.
  // Its own page with the page's defaults (no stable filter, no window picked), the way the live audit opened it.
  const t2 = await newPage(browser, { phone: true, stableDefault: true }), p2 = t2.page;
  await p2.goto(url('stress')); await unlockWith(p2, FIXTURE_PASSPHRASE); await waitApp(p2);
  const PAST = () => Math.max(0, ...[...document.querySelectorAll('.pz-c svg text')].filter((t) => t.getClientRects().length).map((t) => t.getBoundingClientRect().right - t.ownerSVGElement.getBoundingClientRect().right));
  let past = 0, opened = 0;
  for (let i = 0; i < 3; i++) {
    const hit = await p2.evaluate((i) => { const el = [...document.querySelectorAll('[data-act="bt-row"]')].filter((e) => e.getClientRects().length)[i]; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; }, i);
    if (!hit) continue;
    opened++; await sleep(500); past = Math.max(past, await p2.evaluate(PAST));
    await p2.$eval('#rp-scrub', (e) => { e.value = e.max; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(150);
    past = Math.max(past, await p2.evaluate(PAST));
    const hs = await p2.evaluate(HS_WHO); if (hs && bad.length < 3) bad.push(`after bt-row · ${hs}`);
  }
  // v0.5.4: one wide item in a backtest pane (live data: the strategy lab's heat pane, 627 px on a 393 px iPhone) must
  // not stretch the pane's other content or its card past the screen. Plant a wide item and measure the rest.
  const blow = await p2.evaluate(() => {
    const pane = document.querySelector('#bt-lab .lab-heat') || document.querySelector('#bt-lab .pane');
    if (!pane) return null;
    const w = document.createElement('div'); w.style.cssText = 'width:700px;height:4px'; w.dataset.plant = '1';
    pane.insertBefore(w, pane.firstChild);
    const cw = document.documentElement.clientWidth, card = pane.closest('.sub-card').getBoundingClientRect();
    const others = [...pane.children].filter((e) => !e.dataset.plant).map((e) => Math.round(e.getBoundingClientRect().right - card.right));
    const out = { card: Math.round(card.right - cw), others: Math.max(0, ...others) };
    w.remove();
    return out;
  });
  await t2.ctx.close();
  ok('stress phone: a wide item in a backtest pane stretches neither the pane\'s other content nor its card', blow && blow.card <= 1 && blow.others <= 1, JSON.stringify(blow));
  ok('stress phone: backtest replay labels stay inside their chart', opened > 0 && past <= 1, `${opened} replays opened · ${Math.round(past)} px past the chart`);
  ok(`stress phone: on the widest data the page never scrolls sideways after a press (${n} presses)`, n >= 15 && bad.length === 0, bad.join(' | '));
  ok('stress phone: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
}

// v060-tests
// ---------- v0.6.0 · the pool workspace, History "B", Compare, deep links, and History on every pool surface ----------
// The owner's picks of 14 Nov 2026 (docs/briefs/v060-workspace.md). Made-up fixtures only; counts, dates and short reasons out.
const D = 864e5; // a day (ms)
const WSH = () => (window.__lpsHooks && window.__lpsHooks.ws ? window.__lpsHooks.ws() : null);
async function wsWait(p, open = true, ms = 8000) {
  await p.waitForFunction((o) => { const w = document.querySelector('#ws'); return o ? !!w && !w.hidden && !!document.querySelector('#ws-body > .ws-in') : !w || w.hidden; }, open, { timeout: ms }).catch(() => {});
  await sleep(250);
}
const WS_LOOK = () => {
  const ws = document.querySelector('#ws');
  if (!ws || ws.hidden) return null;
  const card = ws.querySelector('.ws-card'), r = card.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
  const cover = (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh);
  const top = document.elementFromPoint(vw / 2, Math.min(vh - 2, r.top + 30)), x = document.querySelector('#ws-close').getBoundingClientRect();
  const h = window.__lpsHooks && window.__lpsHooks.ws ? window.__lpsHooks.ws() : {};
  const sel = ws.querySelector('#ws-tabs [aria-selected="true"]');
  return { cover: +cover.toFixed(3), onTop: !!top && ws.contains(top), xRight: x.left > vw / 2, modal: card.getAttribute('aria-modal') === 'true', tab: h.tab, id: h.id, lvl: h.lvl, hash: location.hash,
    lv: history.state && history.state.lps ? history.state.lv : 0, tabs: [...ws.querySelectorAll('#ws-tabs [role="tab"]')].map((b) => b.dataset.v), sel: sel ? sel.dataset.v : null, n: h.list, pos: document.querySelector('#ws-pos').textContent };
};
const WS_GONE = () => { const ws = document.querySelector('#ws'); return { hidden: !ws || ws.hidden, lock: document.documentElement.classList.contains('ws-open'), kept: ws ? ws.querySelectorAll('#ws-body *').length : 0, lv: history.state && history.state.lps ? history.state.lv : 0, hash: location.hash, y: Math.round(scrollY) }; };
// a History control, judged where it sits: a real button, visible (not behind a hover or a menu), 44 px, the icon and the word
const HIST_OK = (el) => {
  if (!el) return 'missing';
  if (el.tagName !== 'BUTTON') return 'not a button';
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  if (r.width < 43.5 || r.height < 43.5) return `small ${Math.round(r.width)}x${Math.round(r.height)}`;
  if (cs.visibility !== 'visible' || +cs.opacity < 0.9 || el.closest('[hidden]')) return 'hidden';
  if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) return 'off screen';
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit || !(hit === el || el.contains(hit))) return 'covered';
  if (!/^(History of |Open this pool's history)/.test(el.getAttribute('aria-label') || '')) return 'no label';
  if (!/History/.test(el.textContent) || !el.querySelector('svg')) return 'no icon or word';
  return '';
};
async function histPress(p, sel, i = 0) { // judge the i-th visible match, press it: the workspace must open on that pool's History
  const got = await p.evaluate(({ sel, i, F }) => {
    const ok = new Function('return (' + F + ')')();
    const el = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length)[i];
    if (!el) return { why: 'missing' };
    window.dispatchEvent(new WheelEvent('wheel'));
    const why = ok(el);
    el.setAttribute('data-h0', '1');
    return { why, id: el.dataset.id };
  }, { sel, i, F: HIST_OK.toString() });
  if (got.why) { await p.evaluate(() => { const e = document.querySelector('[data-h0]'); if (e) e.removeAttribute('data-h0'); }); return got; }
  await p.click('[data-h0="1"]');
  await p.evaluate(() => { const e = document.querySelector('[data-h0]'); if (e) e.removeAttribute('data-h0'); });
  await wsWait(p);
  const w = await p.evaluate(WS_LOOK);
  if (!w || w.tab !== 'history' || w.id !== got.id) got.why = 'opened ' + JSON.stringify(w && { tab: w.tab, same: w.id === got.id });
  await p.keyboard.press('Escape'); await wsWait(p, false);
  const g = await p.evaluate(WS_GONE);
  if (!got.why && !g.hidden) got.why = 'did not close';
  return got;
}
// rule 0 (the owner, 14 Nov 2026): every place a pool appears has a visible History button that opens that pool's History
async function testHist0(browser, tag, o) {
  const t = await openUnlocked(browser, 'default', o), p = t.page, res = {};
  res.best = await histPress(p, '#best [data-act="ws-hist"]');
  await p.evaluate(() => { const b = document.querySelectorAll('#best [role="tab"]')[2]; b.scrollIntoView({ block: 'center' }); b.click(); }); await sleep(250);
  const tabId = await p.evaluate(() => document.querySelectorAll('#best [role="tab"]')[2].dataset.id);
  res.tabs = await histPress(p, '#best [data-act="ws-hist"]');
  if (!res.tabs.why && res.tabs.id !== tabId) res.tabs.why = 'not the tab\'s pool';
  res.rows = await histPress(p, '#all-tbl tbody tr.row [data-act="ws-hist"]', 1);
  res.disc = await histPress(p, '#disc [data-act="ws-hist"]');
  await p.evaluate(() => { const s = document.querySelector('#best .star'); if (s && s.getAttribute('aria-pressed') !== 'true') s.click(); }); await sleep(250);
  res.fav = await histPress(p, '#fav .hbtn[data-act="ws-hist"]');
  await fillQ(p, 'VEL'); await sleep(300);
  res.search = await histPress(p, '#all-tbl tbody tr.row [data-act="ws-hist"]');
  await fillQ(p, ''); await sleep(200);
  await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(450);
  res.panel = await histPress(p, '#sheet-hist');
  res.similar = await histPress(p, '#sim .mc:not(.self) [data-act="ws-hist"]');
  const hasPair = await p.evaluate(() => { const b = document.querySelector('#sheet-pair'); return !!b && !b.hidden; });
  if (hasPair) { await p.click('#sheet-pair'); await sleep(400); res.pair = await histPress(p, '#sheet-main [data-act="ws-hist"]'); }
  await p.keyboard.press('Escape'); await sleep(250);
  // inside the workspace: its History tab, each similar tier, each compared pool
  await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="ws-hist"]').click(); }); await wsWait(p);
  await p.click('#ws-tabs [data-v="overview"]'); await sleep(250);
  const tierBtn = await p.evaluate((F) => { const ok = new Function('return (' + F + ')')(); return ok(document.querySelector('#ws .ws-sim [data-act="ws-hist"]')); }, HIST_OK.toString());
  await p.evaluate(() => document.querySelector('#ws .ws-sim [data-act="ws-hist"]').click()); await sleep(300);
  const tierW = await p.evaluate(WS_LOOK);
  res.tiers = { why: tierBtn || (tierW && tierW.tab === 'history' ? '' : 'no History tab') };
  await p.click('#ws-tabs [data-v="compare"]'); await sleep(250);
  const cmpBtn = await p.evaluate((F) => { const ok = new Function('return (' + F + ')')(); return ok(document.querySelector('#ws .ws-cc [data-act="ws-hist"]')); }, HIST_OK.toString());
  res.compare = { why: cmpBtn };
  const tabOk = await p.evaluate(() => { const b = document.querySelector('#ws-tabs [data-v="history"]'); return !!b && b.tagName === 'BUTTON' && /History/.test(b.textContent) && !!b.querySelector('svg'); });
  res.workspace = { why: tabOk ? '' : 'no History tab' };
  await p.keyboard.press('Escape'); await wsWait(p, false);
  const bad = Object.entries(res).filter(([, v]) => v.why).map(([k, v]) => `${k}: ${v.why}`);
  ok(`hist0 ${tag}: every pool surface has a visible History button (bars + word, 44 px, labelled) that opens that pool's History (${Object.keys(res).join(', ')})`, Object.keys(res).length >= (hasPair ? 12 : 11) && bad.length === 0, bad.join(' | '));
  ok(`hist0 ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
}
async function testWorkspace(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['w1440', { width: 1440 }], ['w1300', { width: 1300, height: 820 }], ['w1920', { width: 1920, height: 1080 }], ['phone', { phone: true }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', o), p = t.page, phone = tag === 'phone';
    const best = await bestId(p);
    await p.evaluate(() => { const b = document.querySelector('#best [data-act="ws-hist"]'); window.dispatchEvent(new WheelEvent('wheel')); b.scrollIntoView({ block: 'center' }); }); await sleep(250);
    const y0 = await p.evaluate(() => Math.round(scrollY));
    await p.click('#best [data-act="ws-hist"]'); await wsWait(p);
    const m = await p.evaluate(WS_LOOK);
    ok(`workspace ${tag}: History on the best find opens the workspace over the whole window (≥98%, above the bar), modal, on that pool's History`, !!m && m.cover >= 0.98 && m.onTop && m.modal && m.tab === 'history' && m.sel === 'history' && m.id === best, JSON.stringify(m && { ...m, id: m.id === best }));
    ok(`workspace ${tag}: Close top right, 44 px, labelled, on screen; the five tabs`, (await p.evaluate(CLOSE_OK, '#ws-close')) === '' && m && m.xRight && m.tabs.join() === 'overview,history,liquidity,pair,compare', JSON.stringify(m && m.tabs));
    ok(`workspace ${tag}: its address is #p=<pool>&v=<tab> and it is one history entry`, !!m && m.hash === `#p=${best}&v=history` && m.lv === 1, m && `${m.hash.replace(/0x[0-9a-f]+/, 'ID')} lv ${m.lv}`);
    // the tabs: each draws its view, the address follows
    const tabs = {};
    for (const v of ['overview', 'liquidity', 'pair', 'compare', 'history']) {
      await p.click(`#ws-tabs [data-v="${v}"]`); await sleep(350);
      tabs[v] = await p.evaluate((v) => {
        const q = (s) => document.querySelector('#ws-body ' + s), hashOk = location.hash.endsWith('&v=' + v);
        const okv = v === 'overview' ? !!q('[data-ws-sum]') && q('[data-ws-sum]').textContent.length > 20 && !!q('[data-pz="liq-ws"]') && document.querySelectorAll('#ws .ws-rail .ws-k').length >= 8
          : v === 'liquidity' ? !!q('.ws-liqtab [data-pz="liq-ws"]') && q('.ws-liqtab .liq').getBoundingClientRect().height >= 200
            : v === 'pair' ? document.querySelectorAll('#ws .ws-pt tbody tr').length >= 1 && !!q('.hs-stack')
              : v === 'compare' ? document.querySelectorAll('#ws .ws-cc').length === 1 && !!q('.hs-stack')
                : document.querySelectorAll('#ws .hs-stack svg[data-k]:not([data-k="a"])').length === 3;
        return okv && hashOk;
      }, v);
    }
    ok(`workspace ${tag}: Overview, Liquidity, Pair, Compare and History each draw their view, and the address follows the tab`, Object.values(tabs).every(Boolean), JSON.stringify(tabs));
    // the hourly fee chart on Overview has the panel's linear/log switch: inside the workspace it redraws that chart too
    await p.click('#ws-tabs [data-v="overview"]'); await sleep(300);
    if (await p.$('#ws [data-act="fscale"]')) {
      const fs = () => p.evaluate(() => { const b = document.querySelector('#ws [data-act="fscale"][aria-pressed="true"]'), w = document.querySelector('#ws'); return { on: b ? b.dataset.v : '', foc: (document.activeElement && document.activeElement.dataset.act) || '', svg: (document.querySelector('#ws [data-pz="ws-hr"]') || { innerHTML: '' }).innerHTML, open: !!w && !w.hidden }; });
      const f0 = await fs(), want = f0.on === 'log' ? 'lin' : 'log';
      await p.click(`#ws [data-act="fscale"][data-v="${want}"]`); await sleep(350);
      const f1 = await fs();
      await p.click(`#ws [data-act="fscale"][data-v="${f0.on}"]`); await sleep(250);
      const f2 = await fs();
      ok(`workspace ${tag}: the hourly fee chart's linear/log switch works inside it (redraws, keeps focus, switches back)`, f1.on === want && f1.foc === 'fscale' && f1.svg !== f0.svg && f2.on === f0.on && f2.open, `${f0.on}→${f1.on}→${f2.on} · ${f1.foc}`);
    } else ok(`workspace ${tag}: the hourly fee chart (and its linear/log switch) is on Overview`, false, 'no switch');
    // ‹ › through the list it came from ([ and ] on a laptop, a swipe sideways on the header of a phone)
    const n = m ? m.n : 0;
    if (n > 1) {
      if (phone) await swipe(p, '#ws-head', 0, { dx: -160, at: 0.6 }); else { await p.focus('#ws-tabs [data-v="history"]'); await p.keyboard.press(']'); }
      await sleep(400);
      const a = await p.evaluate(WS_LOOK);
      if (phone) await swipe(p, '#ws-head', 0, { dx: 160, at: 0.6 }); else await p.keyboard.press('[');
      await sleep(400);
      const b = await p.evaluate(WS_LOOK);
      ok(`workspace ${tag}: ${phone ? 'a swipe sideways on the header' : '] and ['} step to the next and back to the previous pool of the list ("${a && a.pos}")`, !!a && a.id !== best && a.pos === `2 / ${n}` && !!b && b.id === best && b.pos === `1 / ${n}` && a.hash.includes(a.id), JSON.stringify({ a: a && a.pos, b: b && b.pos }));
    } else ok(`workspace ${tag}: the best find opens with its list (${n})`, false, 'list of ' + n);
    // the keyboard stays inside; every control a labelled button; 44 px taps on touch
    await p.focus('#ws-close');
    let out = 0;
    for (let i = 0; i < 45; i++) { await p.keyboard.press(i % 9 === 8 ? 'Shift+Tab' : 'Tab'); if (!(await p.evaluate(() => !!document.activeElement && (document.querySelector('#ws').contains(document.activeElement) || document.querySelector('#pop').contains(document.activeElement))))) out++; }
    const a11y = await p.evaluate(() => {
      const coarse = matchMedia('(pointer:coarse)').matches, bad = [];
      for (const el of document.querySelectorAll('#ws [data-act]')) {
        if (!el.getClientRects().length || el.closest('[hidden]') || el.tagName === 'TR') continue;
        if (!['BUTTON', 'INPUT'].includes(el.tagName)) bad.push('not a button ' + el.dataset.act);
        else if (!(el.getAttribute('aria-label') || el.textContent.trim())) bad.push('no label ' + el.dataset.act);
        if (coarse && el.tagName === 'BUTTON' && el.dataset.act.startsWith('ws-')) { const r = el.getBoundingClientRect(); if (r.width < 43.5 || r.height < 43.5) bad.push(`small ${el.dataset.act} ${Math.round(r.width)}x${Math.round(r.height)}`); }
      }
      return { bad: [...new Set(bad)], coarse };
    });
    ok(`workspace ${tag}: focus stays inside it (45 Tab presses), every control a labelled button${a11y.coarse ? ', 44 px on touch' : ''}`, out === 0 && a11y.bad.length === 0, `${out} out · ${a11y.bad.slice(0, 3).join(', ')}`);
    // 3D or 2D: complete in both (3D's depth on its charts); under either, Esc closes and gives everything back
    const look = await p.evaluate(() => (document.documentElement.classList.contains('m3d') ? '3d' : '2d'));
    await p.click('#ws-tabs [data-v="liquidity"]'); await sleep(900);
    const depth = await p.evaluate(() => !!document.querySelector('#ws [data-pz="liq-ws"] canvas.d3c'));
    ok(`workspace ${tag}: in ${look.toUpperCase()} its liquidity chart ${look === '3d' ? 'has the 3D depth' : 'is the flat 2D drawing'}`, look === '3d' ? depth : !depth, String(depth));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    const g = await p.evaluate(WS_GONE), foc = await p.evaluate(() => !!document.activeElement && document.activeElement.dataset.act === 'ws-hist' && !!document.activeElement.closest('#best'));
    ok(`workspace ${tag}: Esc closes it: the same scroll, focus back on the History button, its charts let go, no entry left`, g.hidden && !g.lock && g.kept === 0 && g.lv === 0 && g.hash === '' && Math.abs(g.y - y0) <= 2 && foc, JSON.stringify({ ...g, y0, foc }));
    // ⤢ in the pool panel: the workspace on Overview; Close: the panel still open, focus on ⤢
    await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(450);
    await p.click('#sheet-ws'); await wsWait(p);
    const fsl = await p.evaluate(WS_LOOK);
    await p.click('#ws-close'); await wsWait(p, false);
    const fsb = await p.evaluate(() => ({ sheet: !document.querySelector('#sheet').hidden, foc: document.activeElement && document.activeElement.id === 'sheet-ws', lv: history.state && history.state.lps ? history.state.lv : 0 }));
    ok(`workspace ${tag}: ⤢ Full screen in the pool panel opens it on Overview; Close: the panel still open, focus on ⤢`, !!fsl && fsl.tab === 'overview' && fsl.id === best && fsl.cover >= 0.98 && fsb.sheet && fsb.foc && fsb.lv === 1, JSON.stringify({ tab: fsl && fsl.tab, ...fsb }));
    // a chart's ⧉: the workspace on that chart's tab, on the same view (zoom and stretch carried), focused there
    await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="zoom"][data-chart="liq-detail"][data-dir="1"]'); if (b && !b.disabled) b.click(); }); await sleep(250);
    const before = await pzView(p, 'liq-detail');
    await p.evaluate(() => document.querySelector('#sheet [data-act="openchart"][data-chart="liq-detail"]').click()); await wsWait(p);
    const lq = await p.evaluate(WS_LOOK), after = await pzView(p, 'liq-ws'), lf = await p.evaluate(() => !!document.activeElement && !!document.activeElement.closest('[data-chartbox="liq-ws"]'));
    ok(`workspace ${tag}: a pool chart's ⧉ opens it on that chart's tab (Liquidity), on the same zoom, focused there`, !!lq && lq.tab === 'liquidity' && !!before && !!after && near(after.w, before.w, 2e-3) && near(after.c, before.c, 2e-3) && lf, JSON.stringify({ tab: lq && lq.tab, before, after, lf }));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    const lb = await p.evaluate(() => ({ sheet: !document.querySelector('#sheet').hidden, foc: !!document.activeElement && document.activeElement.dataset.act === 'openchart' }));
    ok(`workspace ${tag}: …and Esc brings back the panel with focus on ⧉`, lb.sheet && lb.foc, JSON.stringify(lb));
    await p.click('#sheet-close'); await sleep(250);
    if (phone) { // a swipe down on its header closes it, as a sheet
      await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="ws-hist"]').click(); }); await wsWait(p);
      await swipe(p, '#ws-head', 260, { at: 0.3 }); await wsWait(p, false);
      const sw = await p.evaluate(WS_GONE);
      ok('workspace phone: a swipe down on its header closes it, leaving no entry', sw.hidden && sw.lv === 0 && !sw.lock, JSON.stringify(sw));
    }
    ok(`workspace ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  { // reduced motion: nothing in it animates
    const t = await openUnlocked(browser, 'default', { phone: BROWSER === 'webkit', width: 1440, reducedMotion: 'reduce' }), p = t.page;
    await p.evaluate(() => { document.querySelector('#best [data-act="ws-hist"]').click(); }); await wsWait(p);
    for (const v of ['overview', 'liquidity', 'history']) { await p.click(`#ws-tabs [data-v="${v}"]`); await sleep(200); }
    const an = await p.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && document.querySelector('#ws').contains(a.effect.target) && a.playState === 'running').length);
    ok('workspace reduced motion: nothing in it animates', an === 0, an + ' running');
    await t.ctx.close();
  }
  for (const [tag, o] of BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['w1440', { width: 1440 }], ['phone', { phone: true }]]) await testHist0(browser, tag, o);
}
// History (option B): three synced charts, one crosshair, the day card, the day table; missing is never 0
const CARD = () => {
  const c = document.querySelector('#hs-card'), g = (k) => { const d = c && c.querySelector(`[data-k="${k}"]`); return d ? { v: d.querySelector('b').textContent.trim(), q: d.querySelector('.q').textContent.trim() } : null; };
  return { day: c && c.querySelector('.hs-dd') ? c.querySelector('.hs-dd').firstChild.textContent : '', f: g('f'), v: g('v'), tv: g('tv'), r: g('r'), pre: c && c.querySelector('.hs-pre') ? c.querySelector('.hs-pre').textContent : '' };
};
async function wsDay(p, t) { // the crosshair to day t through its row in the day table
  const hit = await p.evaluate((t) => { const b = document.querySelector(`#ws button.rb[data-t="${t}"]`); if (!b) return false; b.click(); return true; }, t);
  await sleep(60);
  return hit ? p.evaluate(CARD) : null;
}
async function wsRange(p, d) { await p.click(`#ws [data-act="ws-range"][data-v="${d}"]`); await sleep(300); }
const HS_SVG = () => { const o = {}; for (const s of document.querySelectorAll('#ws .hs-stack svg[data-k]')) o[s.dataset.k] = { n: +s.dataset.n, gaps: +s.dataset.gaps, na: +(s.dataset.na || 0), part: +(s.dataset.part || 0), h: s.getBoundingClientRect().height, w: Math.round(s.getBoundingClientRect().width), zero: [...s.querySelectorAll('text')].some((t) => t.textContent === '$0') }; o.ax = document.querySelectorAll('#ws [data-svg="ax"] text').length; o.rows = +document.querySelector('#ws .hs').dataset.rows; o.ms = +document.querySelector('#ws .hs').dataset.ms; return o; };
async function wsHistOf(p, id, alone = true) { await openPool(p, id.slice(0, 12)); await p.click('#sheet-hist'); await wsWait(p); if (alone) await wsOnly(p, id); } // (every tier on at first: this pool alone for its own checks)
async function testWsHistory(browser) {
  const ents = Object.entries(FXD.history.pools), pick = (f) => ents.find(([id, h]) => poolOf(id) && f(h, poolOf(id)));
  const v4 = pick((h) => h.ytp && h.ytp.lim === 'v4' && h.y.length >= 120 && h.yv.slice(-90).some((r) => r[0] === null) && h.y.some((r) => r[2] === 'e'));
  const arch = pick((h) => h.ytp && h.ytp.lim === 'archive' && h.y.length >= 300);
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['laptop', { width: 1440 }], ['phone', { phone: true }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', o), p = t.page, phone = tag === 'phone';
    if (!v4 || !arch) { ok('history ws: the fixtures carry a v4 pool and a Base pool with volume and TVL', false, `${!!v4} ${!!arch}`); await t.ctx.close(); return; }
    // a v4 pool: 90 days by default, three charts on one date axis, each $ axis from $0
    const [id, h] = v4, n90 = Math.min(90, h.y.length);
    await wsHistOf(p, id);
    let s = await p.evaluate(HS_SVG);
    ok(`history ws ${tag}: three charts (fees, volume, TVL), ${n90} days by default, one date axis, each $ axis from $0, the same width`, s.f && s.v && s.tv && s.rows === n90 && s.f.n === n90 && s.v.n === n90 && s.tv.n === n90 && s.ax >= 3 && s.f.zero && s.v.zero && s.tv.zero && s.f.w === s.v.w && s.v.w === s.tv.w, JSON.stringify(s));
    const nullV = h.yv.slice(-n90).filter((r) => r[0] === null).length;
    ok(`history ws ${tag}: every day of volume not read is a gap on the chart (${nullV}), never a 0 bar`, s.v.gaps === nullV, `${s.v.gaps} vs ${nullV}`);
    const iv = h.yv.map((r, i) => (r[0] === null && i >= h.y.length - n90 ? i : -1)).filter((i) => i >= 0).pop();
    let c = await wsDay(p, h.y[iv][0]);
    const cell = await p.evaluate((t) => { const r = document.querySelector(`#ws tr[data-t="${t}"]`); return r ? r.children[2].textContent : ''; }, h.y[iv][0]);
    ok(`history ws ${tag}: the crosshair on a day not read: the day card and the table say "not read", never $0`, !!c && c.v && c.v.v === 'not read' && /never counted as 0/.test(c.v.q) && cell === 'not read', JSON.stringify(c && c.v) + ' ' + cell);
    // a whole year: estimated days marked ≈, every source named, past v4 TVL "—" with its note
    await wsRange(p, 365);
    s = await p.evaluate(HS_SVG);
    const nY = 365; // the range is the range (v0.6.0, D): days before the pool are a labelled band
    const ie = h.y.findIndex((r, i) => r[2] === 'e' && h.yv[i][0] !== null), is = h.y.findIndex((r, i) => r[2] === 's' && h.yv[i][1] === 's');
    const im = h.yt.findIndex((r) => r[1] === 'm'), ina = h.yt.findIndex((r, i) => r[0] === null && i < h.y.length - 30);
    const ce = await wsDay(p, h.y[ie][0]), cs = await wsDay(p, h.y[is][0]), cm = await wsDay(p, h.y[im][0]), cn = await wsDay(p, h.y[ina][0]);
    const note = await p.evaluate(() => [...document.querySelectorAll('#ws .hs-note')].map((x) => x.textContent).join(' '));
    ok(`history ws ${tag}: 1Y shows ${nY} days; an estimated day reads "≈" with its source, a swap day "s · swaps" twice`, s.rows === nY && !!ce && /^≈ \$/.test(ce.f.v) && /e · ≈ estimate/.test(ce.f.q) && /g · candles/.test(ce.v.q) && !!cs && /s · swaps/.test(cs.f.q) && /s · swaps/.test(cs.v.q), JSON.stringify({ rows: s.rows, ce: ce && [ce.f.v.slice(0, 2), ce.f.q, ce.v.q], cs: cs && [cs.f.q, cs.v.q] }));
    ok(`history ws ${tag}: past v4 TVL shows "—" with its note; a map day says "m · map"`, !!cn && cn.tv.v === '—' && /not readable/.test(cn.tv.q) && !!cm && /m · map/.test(cm.tv.q) && /past v4 TVL isn.t readable/.test(note) && s.tv.na > 0, JSON.stringify({ cn: cn && cn.tv, cm: cm && cm.tv.q, na: s.tv.na }));
    // the crosshair: ← → steps a day, the table follows; a row moves it
    await wsDay(p, h.y[h.y.length - 40][0]); await p.focus('#ws .hs-stack');
    const k0 = await p.evaluate(WSH);
    await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowRight');
    const k1 = await p.evaluate(WSH), on = await p.evaluate(() => { const r = document.querySelector('#ws .hst tr.on'); return r ? +r.dataset.t : null; });
    ok(`history ws ${tag}: ← → step the crosshair a day, and the day table's row follows`, k1.cur === k0.cur - D && on === k1.cur, `${(k1.cur - k0.cur) / D} d · row ${on === k1.cur}`);
    // scrubbing stays smooth: 60 steps of the crosshair, each well inside a frame
    const scrub = await p.evaluate(() => { const st = document.querySelector('#ws .hs-stack'), t0 = performance.now(); for (let i = 0; i < 60; i++) st.dispatchEvent(new KeyboardEvent('keydown', { key: i % 2 ? 'ArrowLeft' : 'ArrowLeft', bubbles: true })); return (performance.now() - t0) / 60; });
    ok(`history ws ${tag}: scrubbing costs ${scrub.toFixed(1)} ms a step (under ${phone ? 16 : 8})`, scrub < (phone ? 16 : 8), scrub.toFixed(2));
    // F V T: one chart big, then back
    await p.focus('#ws .hs-stack'); await p.keyboard.press('v'); await sleep(250);
    const big = await p.evaluate(HS_SVG); await p.focus('#ws .hs-stack'); await p.keyboard.press('v'); await sleep(250);
    const eq = await p.evaluate(HS_SVG);
    ok(`history ws ${tag}: V makes the volume chart big, V again puts the three back`, big.v.h > 2 * big.f.h && near(eq.v.h, eq.f.h, 1), `${Math.round(big.v.h)}/${Math.round(big.f.h)} → ${Math.round(eq.v.h)}/${Math.round(eq.f.h)}`);
    // sort the table by fees: highest first, days not read last
    await p.click('#ws [data-act="ws-sort"][data-k="f"]'); await sleep(250);
    const so = await p.evaluate(() => { const th = document.querySelector('#ws [data-act="ws-sort"][data-k="f"]').closest('th'), vals = [...document.querySelectorAll('#ws .hst tbody tr')].map((r) => r.children[1].textContent); return { sort: th.getAttribute('aria-sort'), first: vals.slice(0, 5), last: vals[vals.length - 1] }; });
    const mv = so.first.map((x) => money(x));
    ok(`history ws ${tag}: the day table sorts by fees, highest first, a day not read last`, so.sort === 'descending' && mv.every((x, i) => i === 0 || x <= mv[i - 1] * 1.06) && (h.y.some((r) => r[1] === null) ? ['not read', '—'].includes(so.last) : true), JSON.stringify(so).slice(0, 160));
    await p.click('#ws [data-act="ws-sort"][data-k="t"]'); await sleep(200);
    if (!phone) {
      // a drag across the dates zooms into them; a double-click resets
      const b = await p.locator('#ws .hs-stack').boundingBox();
      await p.mouse.move(b.x + b.width * 0.35, b.y + 80); await p.mouse.down(); await p.mouse.move(b.x + b.width * 0.5, b.y + 80, { steps: 4 }); await p.mouse.move(b.x + b.width * 0.65, b.y + 80, { steps: 4 }); await p.mouse.up(); await sleep(350);
      const z = await p.evaluate(HS_SVG);
      await p.mouse.dblclick(b.x + b.width * 0.5, b.y + 80); await sleep(350);
      const z2 = await p.evaluate(HS_SVG);
      ok(`history ws ${tag}: a drag across the dates zooms into them (${z.rows} days), a double-click resets (${z2.rows})`, z.rows > nY * 0.2 && z.rows < nY * 0.45 && z2.rows === nY, `${z.rows} → ${z2.rows}`);
      // the CSV: the days in view, nulls empty (never 0)
      await wsRange(p, 90);
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click('#ws [data-act="ws-csv"]')]);
      let csv = '';
      if (dl) { const f = await dl.path().catch(() => null); if (f) csv = fs.readFileSync(f, 'utf8'); }
      const lines = csv.trim().split('\n'), row = lines.find((l) => l.startsWith(new Date(h.y[iv][0]).toISOString().slice(0, 10)));
      ok(`history ws ${tag}: CSV saves the ${n90} days in view, a volume not read is an empty cell`, lines[0] === 'day_utc,fees_usd,fees_src,volume_usd,volume_src,tvl_usd,tvl_src,fee_per_volume' && lines.length === n90 + 1 && !!row && row.split(',')[3] === '', `${lines.length} lines · ${row ? row.split(',').slice(3, 5).join('|') : 'no row'}`);
    } else {
      // a finger: hold, then slide: the crosshair follows, the page doesn't scroll
      const before = await p.evaluate(() => ({ cur: window.__lpsHooks.ws().cur, sb: document.querySelector('#ws-body').scrollTop }));
      const r = await p.evaluate(async () => {
        const st = document.querySelector('#ws .hs-stack'), b = st.getBoundingClientRect(), y = b.top + 60, x0 = b.left + b.width * 0.8, x1 = b.left + b.width * 0.3, target = document.elementFromPoint(x0, y) || st;
        const mk = (type, x) => { const ev = new Event(type, { bubbles: true, cancelable: true }), tt = { identifier: 9, clientX: x, clientY: y, target }; Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [tt] }); Object.defineProperty(ev, 'changedTouches', { value: [tt] }); return ev; };
        target.dispatchEvent(mk('touchstart', x0));
        await new Promise((r2) => setTimeout(r2, 320));
        const held = window.__lpsHooks.ws().cur;
        let prevented = 0;
        for (let i = 1; i <= 8; i++) { await new Promise((r2) => requestAnimationFrame(() => r2())); const ev = mk('touchmove', x0 + ((x1 - x0) * i) / 8); target.dispatchEvent(ev); if (ev.defaultPrevented) prevented++; }
        target.dispatchEvent(mk('touchend', x1));
        return { prevented, held };
      });
      const after = await p.evaluate(() => ({ cur: window.__lpsHooks.ws().cur, sb: document.querySelector('#ws-body').scrollTop }));
      ok('history ws phone: hold, then slide: the crosshair follows the finger and the page stays', after.cur < r.held - 30 * D && r.prevented >= 7 && Math.abs(after.sb - before.sb) <= 1, `${Math.round((r.held - after.cur) / D)} d · ${r.prevented} held`);
    }
    // one level deeper: a day's every pool; ‹ Back (and the browser's Back) return to History
    await p.evaluate(() => document.querySelector('#ws [data-act="ws-day"]').click()); await sleep(350);
    const lv = await p.evaluate(() => ({ lvl: window.__lpsHooks.ws().lvl, rows: document.querySelectorAll('#ws .hs-day tbody tr').length, lv: history.state && history.state.lps ? history.state.lv : 0 }));
    const backOk = await p.evaluate(CLOSE_OK, '#ws-back');
    await p.evaluate(() => history.back()); await sleep(450);
    const lv2 = await p.evaluate(() => ({ lvl: window.__lpsHooks.ws().lvl, tab: window.__lpsHooks.ws().tab, open: window.__lpsHooks.ws().open, stack: !!document.querySelector('#ws .hs-stack'), lv: history.state && history.state.lps ? history.state.lv : 0 }));
    ok(`history ws ${tag}: Day detail goes one level deeper (‹ Back, 44 px), and the browser's Back returns to History`, lv.lvl === 'day' && lv.rows >= 2 && lv.lv === lv2.lv + 1 && !backOk && lv2.open && !lv2.lvl && lv2.tab === 'history' && lv2.stack, JSON.stringify({ lv, lv2, backOk }));
    await p.keyboard.press('Escape'); await wsWait(p, false); await p.click('#sheet-close').catch(() => {}); await sleep(200);
    // a Base pool: TVL before the archive's reach is "—" with its note; the pair combined: a day with any pool not read is a gap
    const [aid, ah] = arch;
    await fillQ(p, ''); await wsHistOf(p, aid, false); await wsRange(p, 365); await wsOnly(p, aid);
    const ia = ah.yt.findIndex((r, i) => r[0] === null && ah.y[i][0] < ah.ytp.from), ib = ah.yt.findIndex((r) => r[1] === 'b'), ir = ah.yt.findIndex((r) => r[1] === 'r');
    const ca = await wsDay(p, ah.y[ia][0]), cb = await wsDay(p, ah.y[ib][0]), cr = await wsDay(p, ah.y[ir][0]);
    ok(`history ws ${tag}: a Base pool's TVL before the archive's reach is "—" with its note; balances "b", recorded "r"`, !!ca && ca.tv.v === '—' && /archive/.test(ca.tv.q) && !!cb && /b · balances/.test(cb.tv.q) && !!cr && /r · recorded/.test(cr.tv.q), JSON.stringify({ ca: ca && ca.tv, cb: cb && cb.tv.q, cr: cr && cr.tv.q }));
    const tiers = await p.$$eval('#ws [data-act="ws-tier"]', (b) => b.map((x) => x.dataset.v).filter((v) => v !== 'all'));
    if (tiers.length >= 2) {
      await p.click('#ws [data-act="ws-tier"][data-v="all"]'); await sleep(350);
      const hs = tiers.map((x) => FXD.history.pools[x]), days = ah.y.map((r) => r[0]).slice(-365);
      const at = (hh, d) => { const i = hh.y.findIndex((r) => r[0] === d); return i < 0 ? undefined : hh.y[i]; };
      const gapDay = days.find((d) => { const xs = hs.map((hh) => at(hh, d)); return d >= ((ah.yp && ah.yp.from) || 0) && xs.every(Boolean) && xs.filter((x) => x[1] === null).length === 1; }); // within the archive's reach: not read (older: not readable)
      const fullDay = days.find((d) => { const xs = hs.map((hh) => at(hh, d)); return xs.every((x) => x && x[1] !== null); });
      const cg = gapDay ? await wsDay(p, gapDay) : null, cf = fullDay ? await wsDay(p, fullDay) : null, sum = fullDay ? hs.reduce((a, hh) => a + at(hh, fullDay)[1], 0) : null;
      const sc = await p.evaluate(HS_SVG), mode = await p.evaluate(() => document.querySelector('#ws .hs').dataset.mode);
      const part = gapDay ? hs.reduce((a, hh) => a + (at(hh, gapDay)[1] || 0), 0) : null;
      ok(`history ws ${tag}: All combined stacks the ${tiers.length} tiers: a day with one tier not read is partial ("${tiers.length - 1} of ${tiers.length} tiers", the tiers read), never the day's total; a full day is the sum (v0.6.2)`, mode === 'all' && !!cg && Math.abs(money(cg.f.v) - part) / part < 0.06 && new RegExp(`^${tiers.length - 1} of ${tiers.length} tiers · .*not read`).test(cg.f.q) && !!cf && Math.abs(money(cf.f.v) - sum) / sum < 0.06 && sc.f.part >= 1, JSON.stringify({ mode, cg: cg && cg.f, part: part && usdFx(part), cf: cf && cf.f.v, sum: sum && usdFx(sum), part: sc.f.part }));
      // the drawing's budget: a year of three tiers in three charts
      await wsRange(p, 365);
      const ms = await p.evaluate(() => window.__lpsHooks.ws().ms);
      ok(`history ws ${tag}: 1Y × ${tiers.length} tiers × 3 charts draws in ${ms.toFixed(1)} ms${BROWSER === 'chromium' && !phone ? ' (under 50)' : ''}`, BROWSER === 'chromium' && !phone ? ms < 50 : ms < 200, ms.toFixed(1));
    } else ok(`history ws ${tag}: the Base pool's pair has tiers to combine`, false, String(tiers.length));
    // hidden: its charts go
    await p.click('#ws-tabs [data-v="overview"]'); await sleep(250);
    ok(`history ws ${tag}: another tab lets go of the three charts`, (await p.evaluate(() => document.querySelectorAll('#ws .hs-stack, #ws svg[data-k]').length)) === 0);
    await p.keyboard.press('Escape'); await wsWait(p, false);
    ok(`history ws ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
}
// Compare (idea 3): up to 3 pools of any pair, picked through a search, small multiples on the same axes
async function testCompare(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['laptop', { width: 1440 }], ['phone', { phone: true }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    const best = await bestId(p), bh = FXD.history.pools[best];
    await p.evaluate(() => document.querySelector('#best [data-act="ws-hist"]').click()); await wsWait(p);
    await p.click('#ws-tabs [data-v="compare"]'); await sleep(300);
    const c0 = await p.evaluate(() => ({ chips: document.querySelectorAll('#ws .ws-cc').length, lines: [...document.querySelectorAll('#ws .hs-stack svg[data-k]:not([data-k="a"])')].map((s) => +s.dataset.lines), lv: history.state && history.state.lps ? history.state.lv : 0 }));
    await p.click('#ws [data-act="ws-cmp-add"]'); await sleep(350);
    const pk = await p.evaluate(() => ({ lvl: window.__lpsHooks.ws().lvl, focus: document.activeElement && document.activeElement.id, back: !document.querySelector('#ws-back').hidden, lv: history.state && history.state.lps ? history.state.lv : 0 }));
    ok(`compare ${tag}: + Add a pool opens the picker one level deeper (‹ Back), the search ready to type`, c0.chips === 1 && pk.lvl === 'pick' && pk.focus === 'ws-q' && pk.back && pk.lv === c0.lv + 1, JSON.stringify({ c0, pk }));
    await p.keyboard.type('VEL', { delay: 30 }); await sleep(250);
    const sug = await p.evaluate(() => [...document.querySelectorAll('#ws .ws-sug [data-act="ws-cmp-pick"]')].map((b) => ({ id: b.dataset.id, lab: b.getAttribute('aria-label') })));
    ok(`compare ${tag}: typing narrows the suggestions to matching pools, each a labelled button (${sug.length})`, sug.length >= 2 && sug.every((s) => /^Compare \S*VEL/i.test(s.lab)), JSON.stringify(sug.map((s) => s.lab.slice(0, 24))));
    await p.click(`#ws .ws-sug [data-act="ws-cmp-pick"][data-id="${sug[0].id}"]`); await sleep(450);
    const c1 = await p.evaluate(() => ({ lvl: window.__lpsHooks.ws().lvl, chips: document.querySelectorAll('#ws .ws-cc').length, lv: history.state && history.state.lps ? history.state.lv : 0 }));
    // the browser's Back closes only the picker
    await p.click('#ws [data-act="ws-cmp-add"]'); await sleep(300);
    await p.evaluate(() => history.back()); await sleep(450);
    const c2 = await p.evaluate(() => ({ lvl: window.__lpsHooks.ws().lvl, open: window.__lpsHooks.ws().open, chips: document.querySelectorAll('#ws .ws-cc').length }));
    ok(`compare ${tag}: a pick returns to Compare with it added; the browser's Back closes only the picker`, c1.lvl === null && c1.chips === 2 && c1.lv === c0.lv && c2.open && c2.lvl === null && c2.chips === 2, JSON.stringify({ c1, c2 }));
    await p.click('#ws [data-act="ws-cmp-add"]'); await sleep(300);
    await p.evaluate(() => document.querySelector('#ws .ws-sug [data-act="ws-cmp-pick"]').click()); await sleep(450);
    const c3 = await p.evaluate(() => ({ chips: document.querySelectorAll('#ws .ws-cc').length, add: !!document.querySelector('#ws [data-act="ws-cmp-add"]'), svgs: [...document.querySelectorAll('#ws .hs-stack svg[data-k]:not([data-k="a"])')].map((s) => ({ k: s.dataset.k, lines: +s.dataset.lines, gaps: +s.dataset.gaps, zero: [...s.querySelectorAll('text')].some((x) => x.textContent === '$0') })), card: document.querySelectorAll('#ln-card .hs-dv').length, rm: [...document.querySelectorAll('#ws [data-act="ws-cmp-rm"]')].every((b) => /^Remove /.test(b.getAttribute('aria-label'))) }));
    const nullV = bh && bh.yv ? bh.yv.slice(-90).filter((r) => r[0] === null).length : 0;
    ok(`compare ${tag}: three pools at most: Fees, Volume and TVL each one chart with a line per pool on the same axes from $0, one day card for all`, c3.chips === 3 && !c3.add && c3.svgs.length === 3 && c3.svgs.every((s) => s.lines === 3 && s.zero) && c3.card === 3 && c3.rm, JSON.stringify(c3).slice(0, 220));
    ok(`compare ${tag}: a day not read breaks its line (never a 0): volume gaps ≥ the first pool's (${nullV})`, c3.svgs.find((s) => s.k === 'v').gaps >= nullV, String(c3.svgs.find((s) => s.k === 'v').gaps));
    await p.evaluate(() => document.querySelectorAll('#ws [data-act="ws-cmp-rm"]')[1].click()); await sleep(300);
    ok(`compare ${tag}: ✕ removes a pool`, (await p.evaluate(() => document.querySelectorAll('#ws .ws-cc').length)) === 2);
    // the Pair tab: every tier, today's numbers and their History lines together
    await p.click('#ws-tabs [data-v="pair"]'); await sleep(350);
    const pr = await p.evaluate(() => ({ rows: document.querySelectorAll('#ws .ws-pt tbody tr').length, hb: document.querySelectorAll('#ws .ws-pt [data-act="ws-hist"]').length, lines: [...document.querySelectorAll('#ws .hs-stack svg[data-k]:not([data-k="a"])')].map((s) => +s.dataset.lines) }));
    ok(`compare ${tag}: Pair lists every pool of the pair with its History, and draws each as a line (${pr.rows})`, pr.rows >= 2 && pr.hb === pr.rows && pr.lines.length === 3 && pr.lines.every((x) => x === pr.rows), JSON.stringify(pr));
    // Esc: the picker first, then the workspace
    await p.click('#ws-tabs [data-v="compare"]'); await sleep(250); await p.click('#ws [data-act="ws-cmp-add"]'); await sleep(300);
    await p.keyboard.press('Escape'); await sleep(250);
    const e1 = await p.evaluate(() => ({ lvl: window.__lpsHooks.ws().lvl, open: window.__lpsHooks.ws().open }));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    const e2 = await p.evaluate(WS_GONE);
    ok(`compare ${tag}: Esc closes the picker first, then the workspace, leaving no entry`, e1.open && e1.lvl === null && e2.hidden && e2.lv === 0, JSON.stringify({ e1, e2 }));
    ok(`compare ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
}
// deep links: #p=<pool>&v=<tab> opens the workspace in a new tab with the key this browser keeps; Close lands on the main view
async function testDeeplink(browser) {
  const o = BROWSER === 'webkit' ? { phone: true } : { width: 1440 };
  const t = await openUnlocked(browser, 'default', o), p = t.page, best = await bestId(p);
  const MAIN = () => { const b = document.querySelector('#best'), hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { lock: !document.querySelector('#lockscreen').hidden, ws: !document.querySelector('#ws').hidden, best: !!b && b.getBoundingClientRect().height > 100, main: !!hit && !!hit.closest('main'), hash: location.hash, href: location.href.startsWith('http'), lv: history.state && history.state.lps ? history.state.lv : 0, dim: document.documentElement.classList.contains('ws-open') || document.documentElement.classList.contains('modal-open') }; };
  // a new tab on the link: no passphrase, the workspace on that pool's History; Close: the dashboard's main view
  const q = await t.ctx.newPage(), qe = [];
  q.on('pageerror', (e) => qe.push(String(e.message).slice(0, 100)));
  await q.goto(url('default') + `#p=${best}&v=history`);
  await q.waitForSelector('#app:not([hidden]), #lockscreen:not([hidden])', { timeout: 30000 }); await wsWait(q);
  const d1 = await q.evaluate(WS_LOOK), l1 = await q.evaluate(() => !document.querySelector('#lockscreen').hidden);
  ok('deeplink: a link opens the workspace on that pool and tab, with the key this browser keeps (no passphrase)', !!d1 && !l1 && d1.id === best && d1.tab === 'history' && d1.hash === `#p=${best}&v=history`, JSON.stringify({ tab: d1 && d1.tab, same: d1 && d1.id === best, l1 }));
  await q.click('#ws-close'); await wsWait(q, false); await sleep(300);
  const m1 = await q.evaluate(MAIN);
  ok('deeplink: its Close lands on the dashboard\'s main view (never a blank tab)', !m1.lock && !m1.ws && m1.best && m1.main && m1.hash === '' && m1.href && m1.lv === 0 && !m1.dim, JSON.stringify(m1));
  // the browser's Back closes it and stays on the dashboard
  await q.evaluate(() => { window.__dlMark = 1; });
  await q.goto(url('default') + `#p=${best}&v=pair`); await q.waitForSelector('#app:not([hidden])', { timeout: 30000 }); await wsWait(q);
  await q.evaluate(() => { window.__dlMark = 2; });
  await q.evaluate(() => history.back()); await sleep(600);
  const m2 = await q.evaluate(() => ({ mark: window.__dlMark, ws: !document.querySelector('#ws').hidden, best: document.querySelector('#best').getBoundingClientRect().height > 100 }));
  ok('deeplink: the browser\'s Back closes it and the dashboard stays', m2.mark === 2 && !m2.ws && m2.best, JSON.stringify(m2));
  // a refresh with it open reopens the same view
  await q.evaluate(() => { document.querySelector('#best [data-act="ws-hist"]').click(); }); await wsWait(q);
  await q.click('#ws-tabs [data-v="liquidity"]'); await sleep(300);
  await q.reload(); await q.waitForSelector('#app:not([hidden]), #lockscreen:not([hidden])', { timeout: 30000 }); await wsWait(q);
  const r1 = await q.evaluate(WS_LOOK);
  ok('deeplink: a refresh with the workspace open reopens the same pool and tab', !!r1 && r1.id === best && r1.tab === 'liquidity', JSON.stringify(r1 && { tab: r1.tab, same: r1.id === best }));
  // a link to a pool that is gone: a message on screen, a button to the main view that works
  await q.close();
  const q2 = await t.ctx.newPage(); q2.on('pageerror', (e) => qe.push(String(e.message).slice(0, 100)));
  await q2.goto(url('default') + '#p=0x00000000000000000000000000000000000000ff&v=history'); await q2.waitForSelector('#app:not([hidden])', { timeout: 30000 }); await wsWait(q2);
  const dead = await q2.evaluate(() => { const d = document.querySelector('#ws-dead'), r = d && d.getBoundingClientRect(); return { msg: !!d && /isn.t in the latest data/.test(d.textContent), on: !!r && r.top >= 0 && r.top < innerHeight }; });
  const homeOk = await q2.evaluate(CLOSE_OK, '#ws-home');
  await q2.click('#ws-home').catch(() => {}); await wsWait(q2, false);
  const m3 = await q2.evaluate(MAIN);
  ok('deeplink: a link to a pool no longer in the data says so, on screen, with a button to the main view that works', dead.msg && dead.on && homeOk === '' && !m3.ws && m3.best && m3.lv === 0, JSON.stringify({ ...dead, homeOk, ...m3 }));
  ok('deeplink: no page errors in the linked tab', qe.length === 0, qe[0]);
  await q2.close();
  // ⌘/Ctrl-click or a middle click: a real new tab on the link (recorded here), nothing opens in place; the hash holds a pool key and a tab only
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control', pools = new Set(FXD.live.pools.map((x) => x.id));
  const got = [];
  for (const [how, sel, tab] of [['ctrl', '#best [data-act="ws-hist"]', 'history'], ['ctrl', '#best [data-act="openchart"][data-chart="liq-best"]', 'liquidity'], [BROWSER === 'chromium' ? 'middle' : 'ctrl', '#sheet-ws', 'overview']]) { // (a middle click: Chromium; WebKit's iPhone has no middle button)
    if (sel === '#sheet-ws') { await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(400); }
    await p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector(sel).scrollIntoView({ block: 'center' }); }, sel); await sleep(150);
    const n0 = await p.evaluate(() => (window.__opened || []).length);
    await p.click(sel, how === 'ctrl' ? { modifiers: [mod] } : { button: 'middle' }); await sleep(300);
    const r = await p.evaluate((n0) => ({ u: (window.__opened || []).slice(n0)[0] || '', ws: !document.querySelector('#ws').hidden }), n0);
    let okU = false;
    try { const u = new URL(r.u), hp = new URLSearchParams(u.hash.slice(1)); okU = [...hp.keys()].join() === 'p,v' && pools.has(hp.get('p')) && hp.get('v') === tab && !u.searchParams.has('view'); } catch (e) { okU = false; }
    got.push({ how, tab, okU, inPlace: r.ws });
    if (r.ws) { await p.keyboard.press('Escape'); await wsWait(p, false); }
  }
  ok('deeplink: ⌘/Ctrl-click on History or ⧉ and a middle click on ⤢ open a new tab on #p=<pool>&v=<tab> (a public pool key and a tab, nothing else), nothing in place', got.every((g) => g.okU && !g.inPlace), JSON.stringify(got));
  ok('deeplink: no page errors', t.errors.length === 0, t.errors[0]);
  await t.ctx.close();
}
// way, v0.6.0: the workspace and its levels keep every way out (rule 0b)
async function testWayWs(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['phone', { phone: true }], ['w1440', { width: 1440 }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', o), p = t.page, phone = tag === 'phone';
    await p.evaluate(() => { window.__wayMark = 1; });
    const look = () => p.evaluate(() => ({ mark: window.__wayMark === 1, sheet: !document.querySelector('#sheet').hidden, ws: !document.querySelector('#ws').hidden, lvl: window.__lpsHooks.ws().lvl, lv: history.state && history.state.lps ? history.state.lv : 0, dim: document.documentElement.classList.contains('ws-open') || document.documentElement.classList.contains('modal-open') }));
    // the panel → ⤢ the workspace → History → a day: Back closes them one level a step
    await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(450);
    await p.click('#sheet-ws'); await wsWait(p);
    await p.click('#ws-tabs [data-v="history"]'); await sleep(300);
    await p.evaluate(() => { const b = document.querySelector('#ws-body'); b.scrollTop = b.scrollHeight; }); await sleep(150);
    const xScrolled = await p.evaluate(CLOSE_OK, '#ws-close');
    await p.evaluate(() => document.querySelector('#ws [data-act="ws-day"]').click()); await sleep(350);
    const closes = { close: xScrolled, back: await p.evaluate(CLOSE_OK, '#ws-back') };
    await p.click('#ws [data-act="ws-help"]'); await sleep(200);
    closes.help = await p.evaluate(CLOSE_OK, '#pop [data-act="popclose"]');
    await p.click('#ws-title'); await sleep(200); // a tap elsewhere puts the note away
    const helpGone = await p.evaluate(() => document.querySelector('#pop').hidden && !document.querySelector('#ws').hidden);
    const bad = Object.entries(closes).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    ok(`way ws ${tag}: the workspace's Close (even scrolled), a level's ‹ Back and its notes' ✕ are visible, labelled, 44 px`, bad.length === 0 && helpGone, bad.join(' | ') + ' ' + helpGone);
    const steps = [await look()];
    for (let i = 0; i < 3; i++) { await p.evaluate(() => history.back()); await sleep(500); steps.push(await look()); }
    const want = [['day', true, true], [null, true, true], [null, false, true], [null, false, false]];
    const stOk = steps.every((s, i) => s.mark && s.lvl === want[i][0] && s.ws === want[i][1] && s.sheet === want[i][2]) && steps[3].lv === 0 && !steps[3].dim;
    ok(`way ws ${tag}: Back closes a day, then the workspace, then the panel, one a step, and never leaves the dashboard`, stOk, JSON.stringify(steps.map((s) => [s.lvl, s.ws, s.sheet, s.lv])));
    // closed by Close, Esc${phone ? ', a swipe down' : ''}: no history entry left behind
    const L1 = await p.evaluate(() => history.length), other = [];
    for (const how of ['close', 'esc', phone ? 'swipe' : 'esc']) {
      await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="ws-hist"]').click(); }); await wsWait(p);
      if (how === 'close') await p.click('#ws-close'); else if (how === 'esc') await p.keyboard.press('Escape'); else await swipe(p, '#ws-head', 260, { at: 0.3 });
      await wsWait(p, false);
      const s = await look();
      other.push({ how, ok: !s.ws && s.lv === 0 && !s.dim });
    }
    const L2 = await p.evaluate(() => history.length);
    ok(`way ws ${tag}: closed by Close, Esc${phone ? ' or a swipe down' : ''}, the workspace takes its entry with it`, other.every((x) => x.ok) && L2 <= L1 + 1, JSON.stringify(other) + ` ${L1}/${L2}`);
    // a mix of opening and closing ends on the dashboard, nothing open or dimmed
    let seed = 11; const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
    for (let k = 0; k < 16; k++) {
      const s = await look(), r = rnd(7);
      if (r === 0 && !s.ws) await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="ws-hist"]').click(); });
      else if (r === 1 && !s.ws && !s.sheet) await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); });
      else if (r === 2 && s.sheet && !s.ws) await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="openchart"]'); if (b) b.click(); });
      else if (r === 3 && s.ws && !s.lvl) await p.evaluate(() => { const b = document.querySelector('#ws [data-act="ws-day"]') || document.querySelector('#ws-tabs [data-v="history"]'); if (b) b.click(); });
      else if (r === 4 && s.lv > 0) await p.evaluate(() => history.back());
      else if (r === 5) await p.keyboard.press('Escape');
      else if (r === 6 && s.ws) await p.evaluate(() => document.querySelector('#ws-close').click());
      await sleep(400);
    }
    for (let k = 0; k < 5 && (await look()).lv > 0; k++) { await p.evaluate(() => history.back()); await sleep(450); }
    await p.evaluate(() => scrollTo({ top: 0, behavior: 'instant' })); await sleep(250);
    const end = await look(), fin = await p.evaluate(() => { const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return !!hit && !!hit.closest('main') && document.querySelector('#best').getBoundingClientRect().height > 100; });
    ok(`way ws ${tag}: after a mix of opening and closing with the workspace, Back leads to the dashboard: visible, nothing open or dimmed`, end.mark && !end.ws && !end.sheet && !end.dim && end.lv === 0 && fin, JSON.stringify({ ...end, fin }));
    ok(`way ws ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- v0.6.0 · A: every tier on, and the build-up (the owner, 15 Nov 2026) ----------
// Opening a pool's liquidity chart: the whole stack flashes, collapses to the baseline, then builds back a tier at a time
// (this pool first, then the others by liquidity), each chip lit as its layer grows; it ends with every tier on, in under
// 2.5 s; once per pool in a page's life (▶ replay plays it again); a touch ends it at once on that end state; under
// reduced motion the end state shows at once. Chips switch a tier off and on with an animated shrink and growth.
const TIER_LOOK = (root) => {
  const box = document.querySelector(`${root} [data-chartbox^="liq-"]`);
  if (!box) return null;
  const c = box.querySelector('.mgchips'), chips = [...box.querySelectorAll('[data-act="merge"]')];
  const h = (pid) => { const pa = box.querySelector(`path.mg[data-pid="${pid}"]`); return pa ? [...pa.getAttribute('d').matchAll(/v(-?[\d.]+)h/g)].reduce((a, m) => a + Math.abs(+m[1]), 0) / 2 : 0; };
  return { ph: c ? c.dataset.ph || 'end' : null, chips: chips.length, pressed: chips.filter((b) => b.getAttribute('aria-pressed') === 'true').length, wait: box.querySelectorAll('.mgc.fl-wait').length, lit: box.querySelectorAll('.mgc.fl-on').length,
    selfWait: !!box.querySelector('.mgc.self.fl-wait'), layers: box.querySelectorAll('path.mg').length, ids: chips.map((b) => b.dataset.id), hs: Object.fromEntries(chips.map((b) => [b.dataset.id, h(b.dataset.id)])),
    line: (box.querySelector('.mgline') || {}).textContent || '', leg: [...box.querySelectorAll('[data-mgleg]')].filter((x) => !x.hidden).length, replay: !!c && !!c.querySelector('[data-act="flash"]') };
};
const tierWatch = (p, root, ms = 4000) => p.evaluate(({ root, ms, F }) => new Promise((res) => {
  const look = new Function('return (' + F + ')')(), t0 = performance.now(), out = [];
  const f = () => { const a = look(root); if (a) out.push({ t: Math.round(performance.now() - t0), ph: a.ph, wait: a.wait, lit: a.lit, self: a.selfWait, layers: a.layers, pressed: a.pressed, line: (a.line.match(/·/g) || []).length });
    if (a && a.ph === 'end' && out.length > 2 && out.some((x) => x.ph !== 'end')) { res(out); return; } if (performance.now() - t0 > ms) { res(out); return; } requestAnimationFrame(f); };
  requestAnimationFrame(f);
}), { root, ms, F: TIER_LOOK.toString() });
// The build-up's steps in a run of frames (n other tiers): its phases in order, and each step seen. The page's build-ups (the
// tiers' chart, History's chips) keep their own clock and a frame moves it on at most 120 ms (v0.7.3), so every phase (the
// 250 ms collapse, this pool's own growth: 180 ms or more) shows in at least one frame however slow the runner. On the wall
// clock a long frame (WebKit drawing the 3D map of the panel it just opened) jumped from the flash past the collapse and this
// pool's growth to the next tier's. Its time is the page's clock: the wall time less what long frames held back (each
// frame's time past 120 ms).
const fbSteps = (fr, n) => {
  const seq = fr.map((x) => x.ph).filter((x, i, a) => !i || x !== a[i - 1]), ORD = ['flash', 'collapse', 'build', 'end'];
  const mid = fr.filter((x) => x.ph === 'build'), iB = fr.findIndex((x) => x.ph === 'build');
  return {
    seq, mid, tEnd: (fr.find((x) => x.ph === 'end') || {}).t, gap: Math.max(0, ...fr.slice(1).map((x, i) => x.t - fr[i].t)), // the longest frame
    held: fr.slice(1).reduce((h, x, i) => h + Math.max(0, x.t - fr[i].t - 120), 0),
    inOrder: seq.every((x, i) => !i || ORD.indexOf(x) > ORD.indexOf(seq[i - 1])) && ORD.every((x) => seq.includes(x)),
    // tiers to come wait dim while one grows lit; this pool's chip dims in the collapse, then it grows alone, every other tier still dim
    steps: mid.some((x) => x.wait >= 1 && x.lit >= 1) && fr.some((x) => x.ph === 'collapse' && x.self) && mid.some((x) => !x.self && x.wait === n),
    near: JSON.stringify(fr.slice(Math.max(0, iB - 3), iB + 3).map((x) => [x.t, x.ph, x.wait, x.lit, x.self ? 1 : 0])), // around the build's start: ms, phase, dim, lit, this pool dim
  };
};
async function testFlash(browser) {
  const pools = FXD.live.pools;
  const base = pools.find((q) => q.pair === 'VELNA/WETH' && q.chain === 'ethereum'), peers = pools.filter((q) => q.id !== base.id && samePairFx(base, q));
  const lim = BROWSER === 'webkit' ? 3600 : 2600;
  for (const phone of [true, false]) {
    const tag = phone ? 'phone' : 'laptop';
    const t = await openUnlocked(browser, 'default', { phone, width: 1440, flash: true, mg: true }), p = t.page;
    // 1. the build-up as the panel opens: flash → collapse → build → end, every tier on at the end, in under 2.5 s
    await fillQ(p, base.id.slice(0, 10)); await sleep(250);
    const watch = tierWatch(p, '#sheet', 10000); // a window past any long frame: the time is judged on the page's clock below
    await p.evaluate(() => document.querySelector('#all tbody tr.row td:nth-child(3)').click());
    const fr = await watch, end = await p.evaluate(TIER_LOOK, '#sheet');
    const { seq, mid, tEnd, gap, held, inOrder, steps, near } = fbSteps(fr, peers.length); // no phase may be skipped, however long a frame
    ok(`flash ${tag}: opening a pool with ${peers.length} other tiers plays flash → collapse → build → end (${seq.join('>')}) in ${tEnd} ms, ${held} of them held by long frames (under ${lim})`, inOrder && Number.isFinite(tEnd) && tEnd - held < lim, JSON.stringify(seq) + ' ' + tEnd + ` (longest frame ${gap} ms) ` + near);
    ok(`flash ${tag}: while it builds, tiers still to come wait dim, the one growing is lit, this pool's first (${mid.length} frames)`, steps, `longest frame ${gap} ms; [ms, phase, dim, lit, this dim]: ${near}`);
    ok(`flash ${tag}: …and the ±9% line counts each tier as it lands (${[...new Set(fr.map((x) => x.line))].join(',')} parts)`, new Set(fr.filter((x) => x.ph === 'build').map((x) => x.line)).size >= 2, JSON.stringify(fr.map((x) => x.line)).slice(0, 120));
    ok(`flash ${tag}: it ends with every tier on: ${peers.length} chips pressed, ${peers.length} layers stacked, none dim, the line and the legend complete`, end.ph === 'end' && end.pressed === peers.length && end.layers === peers.length && end.wait === 0 && end.lit === 0 && /total \$/.test(end.line) && end.leg === peers.length && end.replay, JSON.stringify(end).slice(0, 220));
    for (const x of await p.evaluate(TEXT_OVERLAP, { root: '#sheet' })) ok(`flash ${tag}: end state, no text collides`, false, `${x.kind}: ${x.a} × ${x.b}`);
    // 1b. a slow phone's long redraw, planted: ▶ replay with one frame held 900 ms just after it starts still shows every step in
    // order and ends all on, only later (on the old wall clock this frame jumped past the collapse and this pool's own growth)
    const w2 = tierWatch(p, '#sheet', 10000);
    await p.evaluate(() => { document.querySelector('#sheet .mgchips [data-act="flash"]').click(); requestAnimationFrame(() => { const t = performance.now(); while (performance.now() - t < 900) { /* a long redraw */ } }); });
    const fr2 = await w2, i0 = fr2.findIndex((x) => x.ph !== 'end'), s2 = fbSteps(i0 < 0 ? [] : fr2.slice(i0), peers.length), end2 = await p.evaluate(TIER_LOOK, '#sheet');
    ok(`flash ${tag}: a long frame (${s2.gap} ms, a slow phone's redraw) skips no step: ${s2.seq.join('>')}, this pool alone first, then the others, all on in ${s2.tEnd} ms (${s2.held} held)`,
      s2.gap >= 850 && s2.inOrder && s2.steps && s2.tEnd - s2.held < lim && end2.ph === 'end' && end2.pressed === peers.length && end2.layers === peers.length && end2.wait === 0 && end2.lit === 0, `${s2.tEnd} ms; [ms, phase, dim, lit, this dim]: ${s2.near}`);
    // 2. the badge's maths against the independent model
    const m = cmpModel(base), bn = badgeNum((await flLook(p)).badgeTxt);
    ok(`flash ${tag}: the badge says +${m.n} pools · ${m.txt} liquidity, as the independent model reads the fixture`, bn && bn.n === m.n && bn.x === m.txt, `${bn && bn.x} vs ${m.n} ${m.txt}`);
    // 3. switching a tier off shrinks its layer away; on grows it back
    const id = end.ids[0], h0 = end.hs[id];
    const track = () => p.evaluate(({ id, F }) => new Promise((res) => { const look = new Function('return (' + F + ')')(), out = [], t0 = performance.now(); const f = () => { out.push(Math.round(look('#sheet').hs[id])); if (performance.now() - t0 > 700) { res(out); return; } requestAnimationFrame(f); }; requestAnimationFrame(f); }), { id, F: TIER_LOOK.toString() });
    let tr = track(); await p.evaluate((id) => document.querySelector(`#sheet [data-act="merge"][data-id="${id}"]`).click(), id);
    const shr = await tr, off = await p.evaluate(TIER_LOOK, '#sheet');
    tr = track(); await p.evaluate((id) => document.querySelector(`#sheet [data-act="merge"][data-id="${id}"]`).click(), id);
    const grw = await tr, on = await p.evaluate(TIER_LOOK, '#sheet');
    const between = (xs, full) => xs.some((x) => x > full * 0.05 && x < full * 0.95);
    ok(`flash ${tag}: a chip switches its tier off with a shrink, and back on with a growth (${shr.length} and ${grw.length} frames)`, between(shr, h0) && off.hs[id] === 0 && off.pressed === peers.length - 1 && between(grw, on.hs[id]) && on.pressed === peers.length && on.layers === peers.length,
      JSON.stringify({ h0: Math.round(h0), shr: shr.slice(0, 8), off: off.hs[id], grw: grw.slice(0, 8), on: Math.round(on.hs[id]) }));
    // 4. once per pool: closed and opened again it doesn't play (the choice holds while open; a new opening starts all on)
    await p.evaluate((id) => document.querySelector(`#sheet [data-act="merge"][data-id="${id}"]`).click(), id); await sleep(350);
    await closePool(p); await openPool(p, base.id.slice(0, 10)); await sleep(500);
    let a = await p.evaluate(TIER_LOOK, '#sheet');
    ok(`flash ${tag}: opened again it doesn't replay by itself, and starts with every tier on again`, a.ph === 'end' && a.pressed === peers.length && a.layers === peers.length && a.wait === 0, JSON.stringify(a).slice(0, 160));
    // 5. ▶ replay plays it again; a touch, a zoom or a key ends it at once on every tier on
    const ends = {};
    for (const [k, how] of [['zoom', () => p.evaluate(() => document.querySelector('#sheet [data-act="zoom"][data-chart="liq-detail"][data-dir="1"]').click())], ['key', () => p.keyboard.press('Shift')], ['touch', () => p.evaluate(() => document.querySelector('#sheet-body').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))]]) {
      await p.evaluate(() => document.querySelector('#sheet .mgchips [data-act="flash"]').click());
      const ran = await p.waitForFunction(() => { const c = document.querySelector('#sheet .mgchips'); return !!c && c.dataset.ph && c.dataset.ph !== 'end'; }, null, { polling: 'raf', timeout: 3000 }).then(() => true, () => false);
      await how(); await frames(p, 2);
      a = await p.evaluate(TIER_LOOK, '#sheet'); ends[k] = ran && a.ph === 'end' && a.pressed === peers.length && a.layers === peers.length && a.wait === 0;
      await pzClick(p, '#sheet [data-act="zreset"][data-chart="liq-detail"]').catch(() => {}); await sleep(150);
    }
    ok(`flash ${tag}: ▶ replay plays it again; a zoom, a key or a touch ends it at once on every tier on (${Object.keys(ends).join(', ')})`, Object.values(ends).length === 3 && Object.values(ends).every(Boolean), JSON.stringify(ends));
    // 6. a pool with no other pool of its pair: no chips, no badge, no ghost
    await closePool(p);
    await openPool(p, 'QUARX'); await sleep(300);
    const s0 = await p.evaluate(() => { const b = document.querySelector('#sheet [data-chartbox="liq-detail"]'); return { cmp: !!b.querySelector('.cmp'), ghost: !!b.querySelector('path.ghost'), chips: b.querySelectorAll('.mgchips').length }; });
    ok(`flash ${tag}: a pool with no other pool of its pair shows no chips, badge or ghost`, !s0.cmp && !s0.ghost && !s0.chips, JSON.stringify(s0));
    await closePool(p);
    ok(`flash ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  // 7. the badge's maths on every pool of the pair; the best find's map stays the pool's own, and its History has every tier
  {
    const t = await openUnlocked(browser, 'default', { width: 1440, mg: true }), p = t.page, res = [];
    for (const q of [base, ...peers]) {
      await openPool(p, q.id.slice(0, 10));
      const b = badgeNum((await flLook(p)).badgeTxt), m = cmpModel(q);
      res.push({ got: b && b.x, n: b && b.n, want: m.txt, ok: !!b && b.n === m.n && b.x === m.txt, noFr: cmpModel(q, { fr: false }).txt, b10: cmpModel(q, { B: 0.1 }).txt });
      await closePool(p);
    }
    ok(`flash: the badge matches the independent model on every pool of the pair (${res.map((r) => r.got).join(', ')})`, res.every((r) => r.ok) && res.some((r) => parseFloat(r.want) < 1) && res.some((r) => parseFloat(r.want) >= 10), JSON.stringify(res.filter((r) => !r.ok)).slice(0, 160));
    ok('flash: planted: a model without the full-range layer, or reading ±10%, is caught somewhere on the pair', res.some((r) => r.noFr !== r.got) && res.some((r) => r.b10 !== r.got), JSON.stringify(res.map((r) => [r.got, r.noFr, r.b10])));
    const tabOk = await p.evaluate(() => { const x = [...document.querySelectorAll('#best [role="tab"]')].find((e) => /VELNA/.test(e.textContent)); if (!x) return false; x.click(); return true; });
    await sleep(300);
    const card = await p.evaluate((F) => new Function('return (' + F + ')')()('#best'), TIER_LOOK.toString());
    const bid = await p.evaluate(() => document.querySelector('#best [data-act="detail"]').dataset.id);
    const hb0 = await p.evaluate(() => { const b = document.querySelector('#best [data-chartbox="liq-best"] .ctools [data-act="ws-hist"]'); if (!b) return null; b.click(); return true; });
    if (hb0) await wsWait(p);
    const hw = await p.evaluate(() => (window.__lpsHooks.ws ? window.__lpsHooks.ws() : null));
    ok(`flash: the best find's map stays the pool's own (no tier chips, no stack); its title row's History opens every tier combined`, tabOk && !!card && card.chips === 0 && card.layers === 0 && !!hb0 && !!hw && hw.open && hw.tab === 'history' && hw.id === bid && hw.tiers === null, JSON.stringify({ card: card && [card.chips, card.layers], hb0, hw: hw && [hw.open, hw.tab, hw.tiers, hw.id === bid] }));
    if (hw && hw.open) { await p.keyboard.press('Escape'); await wsWait(p, false); }
    ok('flash: card and model, no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 8. reduced motion: never animated, every tier on at once, no replay
  {
    const t = await openUnlocked(browser, 'default', { phone: true, flash: true, mg: true, reducedMotion: 'reduce' }), p = t.page;
    await fillQ(p, base.id.slice(0, 10)); await sleep(250);
    const watch = tierWatch(p, '#sheet', 1500);
    await p.evaluate(() => document.querySelector('#all tbody tr.row td:nth-child(3)').click());
    const fr = await watch, a = await p.evaluate(TIER_LOOK, '#sheet');
    ok('flash: under reduced motion nothing animates and every tier shows on at once (no replay)', fr.length > 3 && fr.every((x) => x.ph === 'end' && x.wait === 0 && x.lit === 0) && a.pressed === peers.length && a.layers === peers.length && !a.replay, JSON.stringify({ n: fr.length, a }).slice(0, 200));
    ok('flash: reduced motion, no page errors', t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // 9. the chart's own page: it builds up there too, once, ending all on
  {
    const t = await openUnlocked(browser, 'default', { width: 1440, flash: true, mg: true }), p = t.page;
    const u = await p.evaluate((id) => window.__lpsHooks.soloUrl('liq-detail', id), base.id);
    const w2 = await t.ctx.newPage(), e2 = [];
    w2.on('pageerror', (e) => e2.push(String(e.message).slice(0, 100)));
    await w2.goto(u);
    await w2.waitForSelector('.solo-box [data-pz="liq-detail"]', { timeout: 20000 }).catch(() => {});
    const built = await w2.waitForFunction(() => { const c = document.querySelector('[data-chartbox="liq-detail"] .mgchips'); return !!c && c.dataset.ph === 'build'; }, null, { polling: 'raf', timeout: 15000 }).then(() => true, () => false);
    await w2.waitForFunction(() => { const c = document.querySelector('[data-chartbox="liq-detail"] .mgchips'); return !!c && c.dataset.ph === 'end'; }, null, { polling: 'raf', timeout: 10000 }).catch(() => {}); // a long frame only makes it end later
    const end = await w2.evaluate((F) => new Function('return (' + F + ')')()('#sheet'), TIER_LOOK.toString()); // the chart the page stands for (the panel's map; the best find's has no tiers)
    ok('flash: the chart\'s own page builds it up too and ends with every tier on', built && !!end && end.ph === 'end' && end.pressed === end.chips && end.layers === end.chips && e2.length === 0, JSON.stringify(end).slice(0, 160) + ' ' + (e2[0] || ''));
    await w2.close();
    await t.ctx.close();
  }
}
// ---------- v0.6.0 · B, C, D: History from the tiers' chart, the fee row, the strip's end; bands that never read as 0 ----------
async function wsOnly(p, id) { // keep one tier alone in History (a double-click on its chip)
  await p.evaluate((id) => { const c = document.querySelector(`#ws .hs-chip[data-v="${id}"]`); if (c) c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, id); await sleep(250);
}
const LINK_OK = (sel) => { // a link to History: a real button, 44 px tall, labelled, the bars icon and "History"
  const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length);
  if (!el) return 'missing';
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (el.tagName !== 'BUTTON') return 'not a button';
  if (r.height < 43.5) return 'short ' + Math.round(r.height);
  if (!/history/i.test(el.getAttribute('aria-label') || '')) return 'no label';
  if (!/History/.test(el.textContent) || !el.querySelector('svg')) return 'no icon or word';
  return '';
};
async function testTiers(browser) {
  const pools = FXD.live.pools, base = pools.find((q) => q.pair === 'VELNA/WETH' && q.chain === 'ethereum'), peers = pools.filter((q) => q.id !== base.id && samePairFx(base, q));
  const born = pools.find((q) => q.pair === 'BORNA/WETH'), ents = Object.entries(FXD.history.pools);
  const arch = ents.find(([id, h]) => poolOf(id) && h.yp && h.yp.lim === 'archive' && h.y.length >= 300 && h.y.some((r) => r[1] === null && r[0] < h.yp.from));
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['laptop', { width: 1440 }], ['phone', { phone: true }]];
  for (const [tag, o] of SETS) {
    const t = await openUnlocked(browser, 'default', { ...o, mg: true }), p = t.page, phone = tag === 'phone';
    const H = () => p.evaluate(() => (window.__lpsHooks.ws ? window.__lpsHooks.ws() : null));
    // B · the liquidity pane's own History: every tier on → History all combined; one tier on (this pool) → that tier
    await openPool(p, base.id.slice(0, 10));
    const pane = await p.evaluate(LINK_OK, '#sheet [data-chartbox="liq-detail"] .ctools [data-act="ws-hist"]');
    await p.evaluate(() => document.querySelector('#sheet [data-chartbox="liq-detail"] .ctools [data-act="ws-hist"]').click()); await wsWait(p);
    const h1 = await H(), m1 = await p.evaluate(() => ({ mode: document.querySelector('#ws .hs').dataset.mode, pressed: [...document.querySelectorAll('#ws .hs-chip[data-act="ws-tier"]')].filter((b) => b.getAttribute('aria-pressed') === 'true').length, chips: document.querySelectorAll('#ws .hs-chip[data-act="ws-tier"]').length }));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    for (const q of peers) await p.evaluate((id) => { const b = document.querySelector(`#sheet [data-act="merge"][data-id="${id}"][aria-pressed="true"]`); if (b) b.click(); }, q.id);
    await sleep(400);
    await p.evaluate(() => document.querySelector('#sheet [data-chartbox="liq-detail"] .ctools [data-act="ws-hist"]').click()); await wsWait(p);
    const h2 = await H(), m2 = await p.evaluate(() => document.querySelector('#ws .hs').dataset.mode);
    ok(`tiers ${tag}: the liquidity pane has its own History (${pane || 'a labelled 44 px button'}): all tiers on → History all combined; only this pool → this pool alone`, !pane && h1.tab === 'history' && h1.tiers === null && m1.mode === 'all' && m1.pressed === m1.chips && h2.tiers && h2.tiers.length === 1 && h2.tiers[0] === base.id && m2 === 'one', JSON.stringify({ pane, h1: h1 && h1.tiers, m1, h2: h2 && h2.tiers && h2.tiers.length, m2 }));
    // History's own chips: a tier switches off and on, All combined puts every one back, a double-click keeps one
    await p.evaluate(() => { const b = document.querySelector('#ws [data-act="ws-tier"][data-v="all"]'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); }); await sleep(250); // every tier on (pressed again it would keep this pool alone)
    await p.click(`#ws [data-act="ws-tier"][data-v="${peers[0].id}"]`); await sleep(250);
    const tg = await p.evaluate(() => ({ mode: document.querySelector('#ws .hs').dataset.mode, off: [...document.querySelectorAll('#ws .hs-chip[data-act="ws-tier"]')].filter((b) => b.getAttribute('aria-pressed') === 'false').length }));
    await wsOnly(p, peers[0].id);
    const iso = await H();
    ok(`tiers ${tag}: History's tier chips switch a tier off and on (${tg.mode}), All combined brings every one back, a double-click keeps one alone`, tg.mode === 'some' && tg.off >= 1 && iso.tiers && iso.tiers.length === 1 && iso.tiers[0] === peers[0].id, JSON.stringify({ tg, iso: iso && iso.tiers }));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    // B · the pair view and the similar pools carry History too
    await p.evaluate(() => { const b = document.querySelector('#sheet-pair'); if (b && !b.hidden) b.click(); }); await sleep(400);
    const pv = await p.evaluate(LINK_OK, '#sheet-hist');
    await p.evaluate(() => document.querySelector('#sheet-hist').click()); await wsWait(p);
    const hp = await H();
    await p.keyboard.press('Escape'); await wsWait(p, false); await p.keyboard.press('Escape'); await sleep(300);
    await openPool(p, base.id.slice(0, 10));
    const sm = await p.evaluate(LINK_OK, '#sim .mc-head [data-act="ws-hist"]');
    ok(`tiers ${tag}: the pair view's header and the similar pools' head each have a History (all tiers combined)`, !pv && !sm && hp && hp.tab === 'history' && hp.tiers === null, JSON.stringify({ pv, sm, hp: hp && [hp.tab, hp.tiers] }));
    // C · the panel's "LP fees" bar is a link to History
    const fb = await p.evaluate(LINK_OK, '#sheet-fee [data-act="ws-hist"]');
    await p.evaluate(() => document.querySelector('#sheet-fee [data-act="ws-hist"]').click()); await wsWait(p);
    const hf = await H();
    ok(`tiers ${tag}: the pool panel's fee bar opens its History, every tier on (${fb || 'a labelled 44 px button'})`, !fb && hf.tab === 'history' && hf.tiers === null && hf.id === base.id, JSON.stringify({ fb, hf: hf && [hf.tab, hf.tiers] }));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    // D · the daily strip's left end: older days live in History (a tappable marker)
    for (let k = 0; k < 6 && (await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="zoom"][data-chart="daily-detail"][data-dir="-1"]'); if (!b || b.disabled) return false; b.click(); return true; })); k++) await sleep(100);
    const mk = await p.evaluate(() => { const b = document.querySelector('#sheet [data-chartbox="daily-detail"] .pz-hist'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { txt: b.textContent, on: !!hit && b.contains(hit), h: Math.round(r.height), coarse: matchMedia('(pointer:coarse)').matches }; });
    if (mk && mk.on) { await p.evaluate(() => document.querySelector('#sheet [data-chartbox="daily-detail"] .pz-hist').click()); await wsWait(p); }
    const hd = await H();
    ok(`tiers ${tag}: at the strip's left end a marker says "30-day view · older days in History ›" and opens History`, !!mk && /^30-day view · older days in History ›$/.test(mk.txt) && mk.on && (!mk.coarse || mk.h >= 44) && hd.open && hd.tab === 'history', JSON.stringify({ mk, hd: hd && [hd.open, hd.tab] }));
    if (hd.open) { await p.keyboard.press('Escape'); await wsWait(p, false); }
    await closePool(p);
    // C · the best find's "LP fees · 30 d" row: one link to History (90 days); a favourite's bar too
    const bl = await p.evaluate(LINK_OK, '#best .fmlink');
    const blab = await p.evaluate(() => { const b = document.querySelector('#best .fmlink'); return b && b.getAttribute('aria-label') === 'Open this pool\'s history: fees, volume and TVL' && /History ›/.test(b.textContent); });
    await p.evaluate(() => document.querySelector('#best .fmlink').click()); await wsWait(p);
    const hb = await H(), rows = await p.evaluate(() => +document.querySelector('#ws .hs').dataset.rows);
    ok(`tiers ${tag}: the best find's "LP fees · 30 d" row is one History link ("History ›", its own label), every tier on, 90 days`, !bl && blab && hb.tab === 'history' && hb.tiers === null && hb.range === 90 && rows === 90, JSON.stringify({ bl, blab, hb: hb && [hb.tab, hb.tiers, hb.range], rows }));
    await p.keyboard.press('Escape'); await wsWait(p, false);
    await p.evaluate(() => { const s = document.querySelector('#best .star'); if (s && s.getAttribute('aria-pressed') !== 'true') s.click(); }); await sleep(250);
    const fv = await p.evaluate(() => { const b = document.querySelector('#fav .fmbtn[data-act="ws-hist"]'); if (!b) return 'missing'; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.height >= 43.5 && hit && b.contains(hit) && /history/i.test(b.getAttribute('aria-label')) ? '' : 'covered or small'; });
    if (!fv) { await p.evaluate(() => document.querySelector('#fav .fmbtn[data-act="ws-hist"]').click()); await wsWait(p); }
    const hv = await H();
    ok(`tiers ${tag}: a favourite's fee bar opens its History`, !fv && hv.open && hv.tab === 'history', fv + ' ' + JSON.stringify(hv && [hv.open, hv.tab]));
    if (hv.open) { await p.keyboard.press('Escape'); await wsWait(p, false); }
    // D · a pool born 12 days ago: its strip says so; History's 90 days show the days before it as a labelled band, never 0;
    // its fee link opens all of it (shorter than 90 days)
    if (born) {
      await openPool(p, born.id.slice(0, 10));
      const bm = await p.evaluate(() => { const b = document.querySelector('#sheet [data-chartbox="daily-detail"] .pz-born'); return b ? b.textContent : null; });
      ok(`tiers ${tag}: a pool born inside the window says "Pool created <date> · no earlier history" at the strip's start`, !!bm && /^Pool created \d{1,2} [A-Z][a-z]{2,3} · no earlier history$/.test(bm), String(bm));
      await p.evaluate(() => document.querySelector('#sheet-hist').click()); await wsWait(p);
      await p.click('#ws [data-act="ws-range"][data-v="90"]'); await sleep(300);
      const by = FXD.history.pools[born.id], first = by.y[0][0];
      const sv = await p.evaluate(() => { const o = {}; for (const s of document.querySelectorAll('#ws .hs-stack svg[data-k]')) o[s.dataset.k] = { n: +s.dataset.n, pre: +s.dataset.pre, label: [...s.querySelectorAll('text.hs-bl')].map((x) => x.textContent).join('|') }; o.rows = document.querySelectorAll('#ws .hst tbody tr').length; return o; });
      await p.focus('#ws .hs-stack'); for (let k = 0; k < 80; k++) await p.keyboard.press('ArrowLeft');
      const cc = await p.evaluate(CARD);
      ok(`tiers ${tag}: History's 90 days of a 12-day pool: the days before it are a labelled band ("pool created …"), never 0 bars; the day card says so`, sv.f && sv.f.n === 90 && sv.f.pre >= 75 && /pool created \d{1,2} [A-Z][a-z]{2,3}/.test(sv.f.label) && sv.v.pre === sv.f.pre && sv.rows <= 14 && cc.f && cc.f.v === '—' && cc.v && cc.v.v === '—' && cc.tv && cc.tv.v === '—' && /^before the pool existed \(created \d{1,2} [A-Z][a-z]{2,3}\)/.test(cc.pre), JSON.stringify({ sv, cc: cc && [cc.f, cc.pre] }));
      await p.keyboard.press('Escape'); await wsWait(p, false);
      await closePool(p);
    } else ok(`tiers ${tag}: the fixtures carry a pool born 12 days ago`, false);
    // D · a Base pool: fee days past its 90-day archive that weren't estimated are a labelled band, "not readable"
    if (arch) {
      const [aid, ah] = arch;
      await openPool(p, aid.slice(0, 10));
      await p.evaluate(() => document.querySelector('#sheet-hist').click()); await wsWait(p);
      await wsOnly(p, aid); await p.click('#ws [data-act="ws-range"][data-v="365"]'); await sleep(300);
      const nd = ah.y.filter((r) => r[1] === null && r[0] < ah.yp.from).map((r) => r[0]), want = nd.filter((d) => d >= ah.y[Math.max(0, ah.y.length - 365)][0]).length;
      const cd = await wsDay(p, nd[nd.length - 1]);
      const fs2 = await p.evaluate(() => { const s = document.querySelector('#ws .hs-stack svg[data-k="f"]'); return { na: +s.dataset.na, gaps: +s.dataset.gaps }; });
      ok(`tiers ${tag}: a Base pool's fee days past the archive, not estimated, are a "not readable" band (${fs2.na} of ${want}), the day card says why`, fs2.na === want && !!cd && cd.f.v === '—' && /older than Base.s 90-day archive · not readable/.test(cd.f.q), JSON.stringify({ fs2, want, cd: cd && cd.f }));
      await p.keyboard.press('Escape'); await wsWait(p, false); await closePool(p);
    } else ok(`tiers ${tag}: the fixtures carry a Base pool with fee days past its archive`, false);
    ok(`tiers ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  // B · History's chips build up the first time several tiers show, once; under reduced motion at once. Its time is the page's
  // clock (v0.7.3: the wall time less what long frames held back), and a planted 1 s frame early in it skips no step (on the
  // old wall clock that frame jumped past the collapse and this pool's own growth)
  const HS_WATCH = ({ stall, ms }) => new Promise((res) => {
    const t0 = performance.now(), out = []; let planted = !stall;
    const f = () => {
      const h = document.querySelector('#ws .hs');
      if (h) {
        const me = window.__lpsHooks.ws ? window.__lpsHooks.ws().id : null, cs = [...h.querySelectorAll('.hs-chip[data-act="ws-tier"]')].filter((b) => b.dataset.v !== 'all'), self = cs.find((b) => b.dataset.v === me);
        out.push({ t: Math.round(performance.now() - t0), ph: h.dataset.ph || null, wait: cs.filter((b) => b.classList.contains('fl-wait')).length, lit: cs.filter((b) => b.classList.contains('fl-on')).length, self: !!self && self.classList.contains('fl-wait'), n: cs.length });
        if (!planted && h.dataset.ph === 'flash') { planted = true; requestAnimationFrame(() => { const s = performance.now(); while (performance.now() - s < stall) { /* a long redraw */ } }); }
        if (h.dataset.ph === 'end' && out.some((x) => x.ph && x.ph !== 'end')) { res(out); return; }
      }
      if (performance.now() - t0 > ms) { res(out); return; }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  for (const how of ['plain', 'stall', 'reduce']) {
    const red = how === 'reduce';
    const t = await openUnlocked(browser, 'default', { width: 1440, flash: true, mg: true, reducedMotion: red ? 'reduce' : 'no-preference' }), p = t.page;
    await openPool(p, base.id.slice(0, 10));
    const watch = p.evaluate(HS_WATCH, { stall: how === 'stall' ? 1000 : 0, ms: red ? 4000 : 10000 }); // a window past any long frame
    await p.evaluate(() => document.querySelector('#sheet-hist').click());
    const all = await watch; await wsWait(p);
    const i0 = all.findIndex((x) => x.ph && x.ph !== 'end'), fr = i0 < 0 ? [] : all.slice(i0), s = fbSteps(fr, fr.length ? fr[0].n - 1 : -1);
    const lim = BROWSER === 'webkit' ? 3800 : 2800, mode = await p.evaluate(() => document.querySelector('#ws .hs').dataset.mode);
    const why = JSON.stringify({ seq: s.seq, t: s.tEnd, held: s.held, gap: s.gap }) + ' [ms, phase, dim, lit, this dim]: ' + s.near;
    if (how === 'plain') ok(`tiers: History's tiers build up the first time (${s.seq.join('>')}) in ${s.tEnd} ms, ${s.held} of them held by long frames, this pool first, ending every tier on`, s.inOrder && s.steps && s.tEnd > 0 && s.tEnd - s.held < lim && mode === 'all', why);
    else if (how === 'stall') ok(`tiers: a long frame early in History's build-up (${s.gap} ms, a slow phone's redraw) skips no step: ${s.seq.join('>')}, this pool alone first, then the others, ending every tier on`, s.gap >= 950 && s.inOrder && s.steps && s.tEnd - s.held < lim && mode === 'all', why);
    else ok('tiers: under reduced motion History shows every tier at once', !all.some((x) => x.ph === 'build' || x.ph === 'collapse'), JSON.stringify(all.map((x) => x.ph)).slice(0, 120));
    await t.ctx.close();
  }
}

// /v060-tests
// ---------- v0.6.2 · tools: the chart toolbar (the owner, 15 Nov 2026: "these plus-minus buttons look bad, they don't fit
// and slightly overlap ... click through them, everywhere") and what the live audit of v0.6.0 met on real data ----------
// Every chart's tool buttons (zoom − + ↺, History, ⤢), the round icon buttons and the replay's ▶, judged where they sit:
//  1. in every pane title the toolbar never covers the label's text, and no button sticks out of the screen
//  2. every one has a label and a 44 px tap box on touch (44 tall, 32 wide with a mouse)
//  3. what is drawn is small: no outline, fill or group pill taller than 34 px
//  4. at the zoom limits − or + is disabled (and looks it), the other works; reset restores the view
//  5. a term in a title (LOG …) can be tapped: nothing lies over its middle (the live iPhone audit: "term not clickable")
// and, on the tiny case (sub-cent prices, quiet hours): the replay's labels stay inside their charts with nothing cut or
// scrolling sideways, and the hourly fee chart keeps its $ axis and its typical-hour line when the typical hour is $0.
// History (the owner, 15 Nov 2026): the crosshair runs through the middle of its day's bar; All combined with a v4 tier
// whose past TVL was never recorded draws the other tiers' TVL, marks those days partial and says "3 of 4 tiers".
const TOOL_AUDIT = (root) => {
  const R = root ? document.querySelector(root) : document, bad = [], vw = innerWidth, coarse = matchMedia('(pointer:coarse)').matches;
  if (!R) return { n: 0, bad: ['no ' + root] };
  const on = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility === 'visible' && !e.closest('[hidden]');
  const clear = (c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c);
  const drawn = (el, ps) => { // the height of what is drawn (an outline or a fill), 0 when nothing is
    const cs = getComputedStyle(el, ps);
    if (ps && (cs.content === 'none' || cs.content === 'normal')) return 0;
    const line = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && !clear(cs.borderTopColor), fill = !clear(cs.backgroundColor);
    if (!line && !fill) return 0;
    const h = el.getBoundingClientRect().height;
    if (!ps) return h;
    const t = parseFloat(cs.top), b = parseFloat(cs.bottom);
    return cs.position === 'absolute' && isFinite(t) && isFinite(b) ? h - t - b : parseFloat(cs.height) || h;
  };
  const textRects = (el) => { const out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width > 0) out.push(q); } return out; };
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const btns = [...R.querySelectorAll('.ctools button, .iconbtn, .play')].filter(on);
  for (const b of btns) {
    const r = b.getBoundingClientRect(), name = (b.dataset.act || b.className.split(' ')[0]) + (b.dataset.chart ? ':' + b.dataset.chart : '');
    if (!(b.getAttribute('aria-label') || '').trim()) bad.push(name + ' no label');
    if (r.height < 43.5 || r.width < (coarse ? 43.5 : 31.5)) bad.push(`${name} box ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (r.left < -0.5 || r.right > vw + 0.5) bad.push(name + ' off screen');
    const g = b.closest('.ctools > *');
    const hs = [drawn(b), drawn(b, '::before'), drawn(b, '::after'), ...[...b.children].filter((c) => c.tagName === 'SPAN').map((c) => drawn(c)), ...(g && g !== b ? [drawn(g), drawn(g, '::before')] : [])];
    const dh = Math.max(...hs);
    if (dh > 34.5) bad.push(`${name} drawn ${Math.round(dh)} px`);
  }
  let titles = 0;
  for (const t of [...R.querySelectorAll('.ctools')].filter(on)) {
    const head = t.parentElement; titles++;
    const txt = [...head.children].filter((c) => c !== t && on(c)).flatMap(textRects);
    for (const b of [...t.querySelectorAll('button')].filter(on)) { const r = b.getBoundingClientRect(); if (txt.some((q) => hit(q, r))) bad.push(`${b.dataset.act}:${b.dataset.chart || ''} over the title`); }
  }
  let terms = 0;
  for (const e of [...R.querySelectorAll('[data-act="term"]')].filter(on)) {
    if (e.closest('#pop, .pop')) continue;
    const r0 = e.getBoundingClientRect(); if (r0.width < 1) continue;
    e.scrollIntoView({ block: 'center', inline: 'center' });
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || x > vw || y < 0 || y > innerHeight) continue;
    let seen = true; // scrolled out of a strip or a panel that clips it: not in sight
    for (let a = e.parentElement; a && seen; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = a.getBoundingClientRect(); if (x < q.left || x > q.right || y < q.top || y > q.bottom) seen = false; } }
    if (!seen) continue;
    terms++;
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === e || e.contains(top))) bad.push(`term "${e.textContent.trim().slice(0, 12)}" covered by ${top ? (top.dataset.act || top.className || top.tagName).toString().split(' ')[0] : 'nothing'}`);
  }
  return { n: btns.length, titles, terms, bad };
};
async function toolSteps(p, tag, out) {
  const look = async (step, root) => { const a = await p.evaluate(TOOL_AUDIT, root); out.views++; out.btns += a.n; out.titles += a.titles; out.terms += a.terms; for (const x of a.bad) out.bad.push(`${tag} ${step}: ${x}`); };
  const click = (sel) => p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(sel); if (!b || b.disabled) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel);
  const allOut = async (root, id) => { for (let k = 0; k < 9 && (await click(`${root} [data-act="zoom"][data-chart="${id}"][data-dir="-1"]`)); k++) await sleep(90); };
  await look('home', '#best');
  await allOut('#best', 'liq-best'); await allOut('#best', 'daily-best');
  await look('home zoomed out', '#best');
  if (await click('#bt-lead tr.row')) { await sleep(900); await look('replay', '#bt'); await allOut('#bt', 'liq-replay'); await look('replay zoomed out', '#bt'); }
  await p.evaluate(() => scrollTo(0, 0));
  if (await click('#best [data-act="detail"]')) {
    await p.waitForSelector('#sheet:not([hidden])'); await sleep(500);
    await look('pool panel', '#sheet');
    for (const id of ['liq-detail', 'daily-detail', 'd-px', 'd-hr', 'd-day']) await allOut('#sheet', id);
    await look('pool panel zoomed out', '#sheet');
    if (await click('#sheet-ws')) {
      await wsWait(p); await look('workspace overview', '#ws');
      for (const v of ['liquidity', 'history', 'pair']) {
        if (!(await click(`#ws-tabs [data-v="${v}"]`))) continue;
        await sleep(600); if (v === 'liquidity') await allOut('#ws', 'liq-ws');
        await look('workspace ' + v, '#ws');
      }
      await p.keyboard.press('Escape'); await wsWait(p, false);
    }
    await p.click('#sheet-close').catch(() => {}); await sleep(200);
  }
}
async function testTools(browser) {
  // 1, 2, 3, 5: everywhere the buttons appear, at a phone and a laptop
  for (const o of DEVICE ? [{ phone: true }, { width: 1440 }] : [{ width: 360 }, { width: 393 }, { width: 1440 }]) {
    const t = await openUnlocked(browser, 'long', { ...o, height: 860, mg: true, storage: { 'lps.hint': '1' } }), p = t.page, tag = o.width ? 'w' + o.width : 'phone';
    const out = { views: 0, btns: 0, titles: 0, terms: 0, bad: [] };
    try { await toolSteps(p, tag, out); } catch (e) { out.bad.push('ran: ' + String(e.message).split('\n')[0].slice(0, 90)); }
    ok(`tools ${tag}: every chart toolbar sits beside or under its title, never over its text, inside the screen (${out.titles} toolbars, ${out.views} views)`, out.titles >= 12 && !out.bad.some((x) => / over the title| off screen|ran:/.test(x)), out.bad.filter((x) => / over the title| off screen|ran:/.test(x)).slice(0, 3).join(' | '));
    ok(`tools ${tag}: every tool button is labelled, a 44 px tap box on touch (${out.btns} buttons)`, out.btns >= 30 && !out.bad.some((x) => / no label| box /.test(x)), out.bad.filter((x) => / no label| box /.test(x)).slice(0, 3).join(' | '));
    ok(`tools ${tag}: what each button draws is small (≤ 34 px)`, !out.bad.some((x) => / drawn /.test(x)), out.bad.filter((x) => / drawn /.test(x)).slice(0, 3).join(' | '));
    ok(`tools ${tag}: every term in sight can be tapped, nothing over it (${out.terms})`, out.terms >= 3 && !out.bad.some((x) => /term "/.test(x)), out.bad.filter((x) => /term "/.test(x)).slice(0, 3).join(' | '));
    if (t.errors.length) ok(`tools ${tag}: no page errors`, false, t.errors[0]);
    await t.ctx.close();
  }
  // the History tab (the owner, 15 Nov 2026): the crosshair through the middle of its day's bar in all three charts, at every
  // range, on a tap and a drag; combined, a v4 tier whose past TVL was never recorded leaves the other tiers' TVL drawn
  // (the WebKit 3D job, near its time limit, reads it on the iPhone only)
  for (const o of DEVICE ? (BROWSER === 'webkit' && MODE === '3d' && !opt('only') ? [{ phone: true }] : [{ phone: true }, { width: 1440 }]) : [{ width: 393 }, { width: 1440 }]) {
    const t = await openUnlocked(browser, 'tiny', { ...o, height: 860, mg: true }), p = t.page, tag = o.width ? 'w' + o.width : 'phone';
    const pk = (q) => [q.t0.sym, q.t1.sym].sort().join('/') + '@' + q.chain;
    const v4 = FXT.live.pools.find((q) => q.v === 4 && FXT.history.pools[q.id] && FXT.history.pools[q.id].ytp && FXT.history.pools[q.id].ytp.lim === 'v4' && FXT.live.pools.filter((x) => pk(x) === pk(q)).length >= 4);
    await openPool(p, v4.id.slice(0, 10));
    await p.evaluate(() => document.querySelector('#sheet-hist').click()); await wsWait(p);
    await p.evaluate(() => { const b = document.querySelector('#ws [data-act="ws-tier"][data-v="all"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); }); await sleep(400);
    const off = [];
    let seen = 0;
    for (const R of ['30', '90', '365', '0']) {
      if (!(await p.$(`#ws [data-act="ws-range"][data-v="${R}"]`))) continue;
      await p.click(`#ws [data-act="ws-range"][data-v="${R}"]`); await sleep(400);
      const bb = await (await p.$('#ws .hs-stack')).boundingBox();
      for (const fx of [0.3, 0.62, 0.9]) {
        const x = bb.x + bb.width * fx, y = bb.y + 50;
        if (fx === 0.9) { await p.mouse.move(bb.x + bb.width * 0.5, y); await p.mouse.down(); await p.mouse.move(x, y, { steps: 6 }); } else await p.mouse.click(x, y);
        await sleep(120);
        const d = await p.evaluate(() => {
          const xr = document.querySelector('#ws .hs-x').getBoundingClientRect(), xc = xr.left + xr.width / 2, out = [];
          for (const s of document.querySelectorAll('#ws .hs-stack svg[data-k]')) {
            const sr = s.getBoundingClientRect(), k = sr.width / +s.getAttribute('width'), X = (xc - sr.left) / k;
            const segs = [...s.querySelectorAll('path.hs-b')].flatMap((pa) => [...pa.getAttribute('d').matchAll(/M([\d.]+) [\d.]+h([\d.]+)/g)].map((m) => [+m[1], +m[2]]));
            const seg = segs.filter((g) => g[0] - 0.5 <= X && X <= g[0] + g[1] + 0.5).sort((g, h) => Math.abs(g[0] + g[1] / 2 - X) - Math.abs(h[0] + h[1] / 2 - X))[0]; // its own day's (a year on a phone: bars under 1 px)
            if (seg) out.push([s.dataset.k, +((X - (seg[0] + seg[1] / 2)) * k).toFixed(2)]);
          }
          return out;
        });
        if (fx === 0.9) await p.mouse.up();
        seen += d.length;
        for (const [k, dx] of d) if (Math.abs(dx) > 0.5) off.push(`${R}d ${fx} ${k} ${dx}px`);
      }
    }
    ok(`tools ${tag}: History's crosshair runs through the middle of its day's bar in every chart, any range, tapped or dragged (${seen} bars)`, seen >= 12 && off.length === 0, off.slice(0, 4).join(' | '));
    // combined TVL with a v4 tier never recorded in the past: the other tiers' TVL drawn, the days marked partial, "3 of 4 tiers"
    await p.click('#ws [data-act="ws-range"][data-v="30"]'); await sleep(400);
    const hv = FXT.history.pools[v4.id], day = hv.y.map((r, i) => (hv.yt[i] && hv.yt[i][0] === null ? r[0] : null)).slice(-25).filter(Boolean).at(-1); // a recent day without the v4's TVL
    const cd = day ? await wsDay(p, day) : null;
    const sv = await p.evaluate(HS_SVG), tvBars = await p.evaluate(() => [...document.querySelectorAll('#ws .hs-stack svg[data-k="tv"] path.hs-b')].reduce((a, e) => a + (e.getAttribute('d').match(/M/g) || []).length, 0));
    const note = await p.evaluate(() => [...document.querySelectorAll('#ws .hs-note')].map((e) => e.textContent).join(' '));
    const tiers = await p.$$eval('#ws [data-act="ws-tier"]', (b) => b.filter((x) => x.dataset.v !== 'all').length);
    ok(`tools ${tag}: All combined (${tiers} tiers, a v4 without past TVL) draws the other tiers' TVL, marks those days partial and says so`, tiers === 4 && tvBars >= 20 && sv.tv.part >= 20 && /v4 TVL not recorded before .* · shown without it/.test(note), JSON.stringify({ tiers, tvBars, part: sv.tv.part, na: sv.tv.na, note: note.slice(0, 90) }));
    ok(`tools ${tag}: that day's card gives the known tiers' TVL as "3 of 4 tiers · … v4 not recorded", never "—" and never as the total`, !!cd && /^\$/.test(cd.tv.v) && /^3 of 4 tiers · .*v4 not recorded/.test(cd.tv.q), JSON.stringify(cd && cd.tv));
    if (t.errors.length) ok(`tools ${tag}: History without page errors`, false, t.errors[0]);
    await t.ctx.close();
  }
  // the rest doesn't depend on the look: the WebKit 3D job (near its time limit) leaves it to the 2D job
  if (BROWSER === 'webkit' && MODE === '3d' && !opt('only')) { console.log('  · tools (buttons at work, tiny case): in the WebKit 2D job'); return; }
  // 4: the zoom limits, reset, ⤢, History and ▶ do their jobs
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop', B = '[data-act="zoom"][data-chart="liq-best"]';
    const st = () => p.evaluate((B) => { const m = document.querySelector(B + '[data-dir="-1"]'), q = document.querySelector(B + '[data-dir="1"]'), op = (b) => +getComputedStyle(b.querySelector('svg') || b).opacity * +getComputedStyle(b).opacity;
      return { m: m.disabled, q: q.disabled, mo: op(m), qo: op(q), reset: !!document.querySelector('[data-act="zreset"][data-chart="liq-best"]'), v: document.querySelector('[data-pz="liq-best"]').dataset.view }; }, B);
    const press = (sel) => p.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(sel); if (!b || b.disabled) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel);
    const s0 = await st();
    let k = 0; while (k < 12 && (await press(B + '[data-dir="-1"]'))) { k++; await sleep(90); }
    const lo = await st();
    k = 0; while (k < 16 && (await press(B + '[data-dir="1"]'))) { k++; await sleep(90); }
    const hi = await st();
    await press('[data-act="zreset"][data-chart="liq-best"]'); await sleep(150);
    const s1 = await st();
    ok(`tools ${tag}: − stops at the widest view (disabled, dimmed), + then zooms to its limit (disabled), reset brings the view back`,
      !s0.m && !s0.q && !s0.reset && lo.m && !lo.q && lo.mo <= 0.5 && lo.qo > 0.9 && lo.reset && lo.v !== s0.v && hi.q && !hi.m && hi.qo <= 0.5 && hi.v !== lo.v && !s1.reset && s1.v === s0.v && !s1.m && !s1.q, JSON.stringify({ s0, lo, hi, s1 }));
    await press('[data-chartbox="liq-best"] .ctools [data-act="openchart"]'); await wsWait(p);
    const w1 = await p.evaluate(WS_LOOK); await p.keyboard.press('Escape'); await wsWait(p, false);
    await press('[data-chartbox="liq-best"] .ctools [data-act="ws-hist"]'); await wsWait(p);
    const w2 = await p.evaluate(WS_LOOK); await p.keyboard.press('Escape'); await wsWait(p, false);
    ok(`tools ${tag}: ⤢ opens the pool full screen on its liquidity, History on its History`, w1 && w1.tab === 'liquidity' && w2 && w2.tab === 'history', JSON.stringify([w1 && w1.tab, w2 && w2.tab]));
    let pl = null;
    if (await press('#bt-lead tr.row')) {
      await sleep(800); const a = await p.getAttribute('#rp-play', 'aria-label'); await press('#rp-play'); await sleep(500);
      const b = await p.getAttribute('#rp-play', 'aria-label'); await press('#rp-play'); await sleep(200);
      pl = [a, b, await p.getAttribute('#rp-play', 'aria-label')];
    }
    ok(`tools ${tag}: ▶ plays the replay and pauses it`, pl && pl[0] === 'Play the replay' && pl[1] === 'Pause the replay' && pl[2] === 'Play the replay', JSON.stringify(pl));
    await t.ctx.close();
  }
  // the tiny case: the replay's labels inside their charts; the hourly fee chart's axis and typical line at a $0 median
  for (const o of DEVICE ? [{ phone: true }, { width: 1440 }] : [{ width: 360 }, { width: 1440 }]) {
    const t = await openUnlocked(browser, 'tiny', { ...o, height: 860 }), p = t.page, tag = o.width ? 'w' + o.width : 'phone';
    await p.evaluate(() => { const r = document.querySelector('#bt-lead tr.row'); r.scrollIntoView({ block: 'center' }); r.click(); }); await sleep(1200);
    const rp = await p.evaluate(() => {
      const out = { n: 0, cut: [], hs: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      for (const s of ['#rp-price', '#rp-money', '#lab-lines']) { const box = document.querySelector(s); if (!box || !box.getClientRects().length) { out.cut.push(s + ' missing'); continue; } const br = box.getBoundingClientRect();
        for (const e of box.querySelectorAll('text')) { const r = e.getBoundingClientRect(); if (!r.width) continue; out.n++; if (r.left < br.left - 0.5 || r.right > br.right + 0.5) out.cut.push(`${s} "${e.textContent.slice(0, 12)}" ${Math.round(r.left - br.left)}…${Math.round(r.right - br.right)}`); } }
      return out; });
    ok(`tools ${tag}: the replay's labels (sub-cent prices) stay inside their charts, nothing scrolls sideways (${rp.n} labels)`, rp.n >= 10 && rp.cut.length === 0 && rp.hs <= 0, `${rp.cut.length} out, hscroll ${rp.hs}: ${rp.cut.slice(0, 3).join(' | ')}`);
    await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="detail"]').click(); }); await p.waitForSelector('#sheet:not([hidden])'); await sleep(600);
    const hr = await p.evaluate(() => { const b = document.querySelector('[data-chartbox="d-hr"]'); return b ? { ys: b.querySelectorAll('.yax > span').length, med: !!b.querySelector('line.median'), cap: b.textContent.match(/typical hour \(median\) \S+/) } : null; });
    ok(`tools ${tag}: a quiet pool's hourly fee chart keeps its $ axis and its typical-hour line at a $0 median`, hr && hr.ys >= 2 && hr.med && hr.cap && /\$0\b/.test(hr.cap[0]), JSON.stringify(hr));
    await t.ctx.close();
  }
}

// ---------- v0.7.0 · key slots: the shared guest password and personal guests (A, B, D, E, the end), members, the owner's Guests,
// the owner after the migration, the recovery key, a passphrase change, the mismatch alarm (docs/briefs/guest-access.md). Made-up
// fixtures (keyed, keyedgone, keyedup, keyedchange, mismatch): every name and password in them is made up ----------
// what the loop would do with a request the page sealed: open it with the fixture lock's inbox key, apply it to a copy of keyed
async function loopApplies(env, caseDir = 'keyed') {
  const { unlock: un } = await import('../lib/lock.mjs');
  const { openVault } = await import('../lib/keyring.mjs');
  const { guestStep, parseRequest } = await import('../lib/guests.mjs');
  const { inboxKeys: ik } = await import('../lib/inbox.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-gq-'));
  for (const n of fs.readdirSync(path.join(FX, caseDir))) fs.copyFileSync(path.join(FX, caseDir, n), path.join(dir, n));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'));
  const req = parseRequest(env, ik(un(lock, FIXTURE_PASSPHRASE).token).privateKey);
  const keys = openVault(lock, FIXTURE_PASSPHRASE, JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')));
  const r = req ? guestStep({ keys, outDir: dir, requests: [env], now: Date.now() }) : null;
  return { req, r, dir, lock, keys, kf: JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')) };
}
const slotFor = async (kf, pass) => { const { openGuestSlot: og, guestKek: gk } = await import('../lib/keyring.mjs'); return og(kf, gk(pass, kf.gsalt, kf.iter)); };
const sealedOf = (href) => { try { return JSON.parse(new URL(href).searchParams.get('value')); } catch (e) { return null; } };
async function unlockAs(browser, c, pass, o = {}) {
  const t = await newPage(browser, o);
  t.reqs = [];
  t.page.on('request', (r) => t.reqs.push(new URL(r.url()).pathname));
  if (o.first) await t.ctx.addInitScript((m) => localStorage.setItem('lps.gfirst', m), JSON.stringify(o.first));
  await t.page.goto(url(c));
  await unlockWith(t.page, pass);
  return t;
}
const GLOOK = () => {
  const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  const line = document.querySelector('#gline'), ls = line && getComputedStyle(line), pill = document.querySelector('#gpill'), ver = document.querySelector('#ver');
  const pr = pill && pill.getBoundingClientRect(), vr = ver && ver.getBoundingClientRect();
  return {
    line: !!ls && ls.display === 'block' && ls.position === 'fixed' && line.getBoundingClientRect().top === 0 && Math.round(line.getBoundingClientRect().height) >= 3 && line.getBoundingClientRect().width >= innerWidth - 1 && +ls.zIndex >= 95,
    pill: vis(pill) ? pill.querySelector('.gp-n').textContent.trim() : '', pillNear: !!pr && !!vr && pill.parentElement === ver.parentElement && pill.previousElementSibling === ver && pr.top - vr.bottom < 40,
    pillTall: !!pr && pr.height >= 30, violet: !!pill && /179, 157, 255/.test(getComputedStyle(pill).color), pillOff: !!pill && pill.disabled,
    stars: document.querySelectorAll('.star').length, locked: document.querySelectorAll('.star.glk .glock').length, fav: document.querySelectorAll('.star[data-act="fav"]').length,
    favMsg: (document.querySelector('#fav-body') || {}).textContent || '', needs: vis(document.querySelector('#needs')), positions: vis(document.querySelector('#positions')),
    settings: vis(document.querySelector('#settings')), lensFav: !!document.querySelector('#f-lens option[value="fav"]'),
    welcome: vis(document.querySelector('#gwel')) ? document.querySelector('#gw-h').textContent : '', text: document.body.innerText,
  };
};
const noOwnerFiles = (t) => !t.reqs.some((r) => /\/(owner|guests)\.json$/.test(r)) && t.reqs.some((r) => /\/keys\.json$/.test(r));
async function testGuest(browser) {
  for (const [tag, o] of BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['phone', { phone: true }], ['w1440', { width: 1440 }]]) {
    // the main path: one shared guest password, no name anywhere on the device
    const t = await unlockAs(browser, 'keyed', SHARED_PASS, o), p = t.page;
    await waitApp(p);
    let g = await p.evaluate(GLOOK);
    ok(`guest ${tag}: E · the welcome card after the first unlock, with no name: "Welcome! You’re browsing as a guest"`, g.welcome === 'Welcome! You’re browsing as a guest' && /Saving is off: no favourites, notes or settings\./.test(g.text) && /Your access ends on \d+ \w{3}\./.test(g.text), g.welcome);
    await snap(p, `guest-${tag}-welcome`);
    await p.click('#gw-ok'); await sleep(200);
    g = await p.evaluate(GLOOK);
    ok(`guest ${tag}: A · a violet "GUEST" pill with no name, by the version badge, 30 px tall at least`, g.pill === 'GUEST' && g.pillNear && g.pillTall && g.violet, `${g.pill} near ${g.pillNear}`);
    ok(`guest ${tag}: B · a violet line of 3 px or more along the very top, over everything`, g.line);
    ok(`guest ${tag}: D · every ★ is there with a violet lock, none saves; Favourites says why`, g.stars > 0 && g.locked === g.stars && g.fav === 0 && /Saving isn’t on for guests\. Ask the admin for your own login\./.test(g.favMsg), `${g.locked}/${g.stars}`);
    ok(`guest ${tag}: the owner's parts are gone: no Settings, no "Needs you", no Positions, no favourites lens`, !g.settings && !g.needs && !g.positions && !g.lensFav);
    ok(`guest ${tag}: no owner ticket, stop-loss or threshold anywhere: the example is $1,000`, !g.text.includes(`$${OWNER_TICKET.toLocaleString('en-US')}`) && /\$1,000/.test(g.text) && !/STOP [−-]/.test(g.text));
    ok(`guest ${tag}: the owner's files are never fetched`, noOwnerFiles(t), t.reqs.filter((r) => /json$/.test(r)).map((r) => r.split('/').pop()).join(','));
    ok(`guest ${tag}: no friend's name or label on the page but the sheet's`, !/Ada Mock|Dee Mock|Eli Mock/.test(await domText(p)));
    await snap(p, `guest-${tag}-home`);
    await p.click('#best .star.glk'); await sleep(200);
    ok(`guest ${tag}: D · a tap on the locked ★ says "Saving isn’t on for guests"`, /Saving isn’t on for guests[\s\S]*Ask the admin for your own login\./.test(await p.textContent('#pop').catch(() => '')));
    await snap(p, `guest-${tag}-star`);
    await p.keyboard.press('Escape'); await sleep(150);
    await p.click('#gpill'); await sleep(250);
    const sh = await p.evaluate(() => ({ open: !document.querySelector('#gsheet').hidden, h: document.querySelector('#gs-h').textContent, meta: document.querySelector('#gs-meta').textContent, txt: document.querySelector('#gsheet').innerText }));
    ok(`guest ${tag}: A · the sheet: "Guest access · friends", when it ends (its date), what guests can and can't do, Done`, sh.open && sh.h === 'Guest access · friends' && /^ENDS \d+ [A-Z]{3} · 28 DAYS LEFT$/.test(sh.meta) && /Search every pool/.test(sh.txt) && /Positions/.test(sh.txt), sh.meta);
    await snap(p, `guest-${tag}-sheet`);
    await p.click('#gs-done'); await sleep(200);
    ok(`guest ${tag}: A · Done closes the sheet`, await p.evaluate(() => document.querySelector('#gsheet').hidden));
    await fillQ(p, 'NUMA');
    const rows = await p.evaluate(() => document.querySelectorAll('#all tbody tr[data-id]').length);
    ok(`guest ${tag}: search finds pools`, rows > 0, String(rows));
    await fillQ(p, '');
    await p.evaluate(() => { const b = document.querySelector('#best [data-act="ws-hist"]'); window.dispatchEvent(new WheelEvent('wheel')); b.scrollIntoView({ block: 'center' }); }); await sleep(200);
    await p.click('#best [data-act="ws-hist"]'); await wsWait(p);
    const views = {};
    for (const v of ['history', 'compare']) {
      await p.click(`#ws-tabs [data-v="${v}"]`); await sleep(400);
      views[v] = await p.evaluate((v) => (v === 'compare' ? document.querySelectorAll('#ws .ws-cc').length === 1 && !!document.querySelector('#ws-body .hs-stack') : document.querySelectorAll('#ws .hs-stack svg[data-k]:not([data-k="a"])').length === 3), v);
    }
    const ws = await p.evaluate(GLOOK);
    ok(`guest ${tag}: the workspace opens with History and Compare drawn, the violet line still on top and its ★ locked`, views.history && views.compare && ws.line && (await p.evaluate(() => !!document.querySelector('#ws-star .star.glk'))), JSON.stringify(views));
    await snap(p, `guest-${tag}-workspace`);
    await p.reload(); await waitApp(p);
    g = await p.evaluate(GLOOK);
    ok(`guest ${tag}: the key stays on this device and E never comes back`, g.welcome === '' && g.pill === 'GUEST');
    ok(`guest ${tag}: no page errors`, t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
    await t.ctx.close();
  }
  // a personal guest: their name on the pill and the sheet, and 30 days on this device's own clock (the outer limit is 45)
  const t = await unlockAs(browser, 'keyed', GUEST_PASS, { phone: true }), p = t.page;
  await waitApp(p);
  const g = await p.evaluate(GLOOK);
  await p.click('#gw-ok'); await sleep(150); await p.click('#gpill'); await sleep(250);
  ok('guest: a personal guest\'s pill and sheet carry their name; their device\'s 30 days come first', g.welcome === `Welcome, ${GUEST_NAME}` && g.pill === `GUEST · ${GUEST_NAME.toUpperCase()}`
    && (await p.textContent('#gs-h')) === `${GUEST_NAME}’s guest access` && /· 30 DAYS LEFT$/.test(await p.textContent('#gs-meta')), g.pill);
  await t.ctx.close();
}
async function testMember(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['w1440', { width: 1440 }]]) {
    const t = await unlockAs(browser, 'keyed', MEMBER_PASS, o), p = t.page;
    await waitApp(p);
    const g = await p.evaluate(GLOOK);
    ok(`member ${tag}: a quiet "MEMBER · DEE MOCK" chip, no violet, no top line, no welcome card`, g.pill === `MEMBER · ${MEMBER_NAME.toUpperCase()}` && !g.violet && !g.line && g.pillOff && g.welcome === '', g.pill);
    ok(`member ${tag}: favourites are on (★ saves on this device), the owner's parts are not`, g.fav > 0 && g.locked === 0 && !g.settings && !g.needs && !g.positions && g.lensFav);
    ok(`member ${tag}: no owner ticket, and the owner's files are never fetched`, !g.text.includes(`$${OWNER_TICKET.toLocaleString('en-US')}`) && noOwnerFiles(t));
    await p.click('#best .star[data-act="fav"]'); await sleep(250);
    ok(`member ${tag}: a ★ tap saves the pool in Favourites on this device`, (await p.getAttribute('#best .star[data-act="fav"]', 'aria-pressed')) === 'true' && (await p.evaluate(() => document.querySelectorAll('#fav .mc').length)) >= 1);
    await snap(p, `member-${tag}-home`);
    ok(`member ${tag}: no page errors`, t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
    await t.ctx.close();
  }
}
async function testGuestEnd(browser) {
  // past its outer limit: the calm end at once, nothing kept
  let t = await unlockAs(browser, 'keyed', EXPIRED_PASS, { phone: true });
  await t.page.waitForSelector('#gend:not([hidden])', { timeout: 30000 });
  const e1 = await t.page.evaluate(() => ({ h: document.querySelector('#ge-h').textContent, m: document.querySelector('#ge-msg').textContent, app: !document.querySelector('#app').hidden, lock: !document.querySelector('#lockscreen').hidden }));
  ok('guestend: past the outer limit: "Your guest access has ended", when, and no data', e1.h === 'Your guest access has ended' && /^It reached its end date on \d+ \w{3}\. Ask the owner if you need it again\.$/.test(e1.m) && !e1.app && !e1.lock, e1.m);
  await snap(t.page, 'guestend-expired');
  await t.page.click('#ge-new');
  await t.page.waitForSelector('#lockscreen:not([hidden])', { timeout: 10000 });
  ok('guestend: "Use a different passphrase" goes back to the unlock form', await t.page.isVisible('#pass'));
  await t.ctx.close();
  // the device's own 30 days: first unlocked here 31 days ago; then the owner upgrades them: the same device opens as a member
  t = await unlockAs(browser, 'keyed', GUEST_PASS, { phone: true, first: { '0a0a0a0a0a0a0a0a': Date.now() - 31 * 86400e3 } });
  await t.page.waitForSelector('#gend:not([hidden])', { timeout: 30000 });
  const e3 = await t.page.evaluate(() => ({ h: document.querySelector('#ge-h').textContent, m: document.querySelector('#ge-msg').textContent }));
  ok('guestend: 30 days after this device\'s first unlock: "Your 30-day guest access has ended. Ask the admin to upgrade you to a full account."', e3.h === 'Your 30-day guest access has ended' && e3.m === 'Ask the admin to upgrade you to a full account.', `${e3.h} | ${e3.m}`);
  await snap(t.page, 'guestend-soft');
  await t.page.goto(url('keyedup'));
  await waitApp(t.page);
  const up = await t.page.evaluate(GLOOK), clock = await t.page.evaluate(() => JSON.parse(localStorage.getItem('lps.gfirst') || '{}'));
  ok('guestend: upgraded: the same device opens as a member with the same passphrase, its clock cleared, favourites on', up.pill === `MEMBER · ${GUEST_NAME.toUpperCase()}` && !up.line && up.fav > 0 && !('0a0a0a0a0a0a0a0a' in clock));
  await t.ctx.close();
  // removed: the shared password ended (the key rotated): the end, never an error
  for (const [tag, o] of [['phone', { phone: true }], ['w1440', { width: 1440 }]]) {
    t = await unlockAs(browser, 'keyed', SHARED_PASS, o);
    await waitApp(t.page);
    await t.page.goto(url('keyedgone'));
    await t.page.waitForSelector('#gend:not([hidden])', { timeout: 30000 });
    const e2 = await t.page.evaluate(() => ({ m: document.querySelector('#ge-msg').textContent, txt: document.body.textContent, line: getComputedStyle(document.querySelector('#gline')).display }));
    ok(`guestend ${tag}: ended or removed: "The owner ended it", no pool left in the page, no violet line`, e2.m === 'The owner ended it. Ask them if you need it again.' && !e2.txt.includes('NUMA') && e2.line === 'none', e2.m);
    await snap(t.page, `guestend-${tag}-removed`);
    await t.page.reload(); await t.page.waitForSelector('#gend:not([hidden])', { timeout: 30000 });
    ok(`guestend ${tag}: the end stays the end after a reload (calm, one way forward)`, await t.page.isVisible('#ge-new'));
    ok(`guestend ${tag}: no page errors`, t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
    await t.ctx.close();
  }
}
async function testGuestAdmin(browser) {
  // the owner: unlocked before the migration, still unlocked after it (no re-unlock), with the settings back
  const t = await newPage(browser, { phone: true }), p = t.page;
  await p.goto(url('default')); await unlockWith(p, FIXTURE_PASSPHRASE); await waitApp(p);
  await p.goto(url('keyed'));
  await waitApp(p);
  const o = await p.evaluate(GLOOK);
  ok('guestadmin: the owner keeps working after the migration with no re-unlock: data, the own ticket, Settings, no guest signal', !(await p.isVisible('#lockscreen')) && o.text.includes(`$${OWNER_TICKET.toLocaleString('en-US')}`) && o.settings && !o.pill && !o.line && o.fav > 0 && o.locked === 0);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#g-list .g-row')].map((r) => ({ who: [...r.querySelector('.g-who').children].map((c) => c.textContent.trim()).join(' '), meta: r.querySelector('.g-meta').textContent.replace(/\s+/g, ' '), acts: [...r.querySelectorAll('[data-act]')].map((b) => b.dataset.act).join(','), pw: (r.querySelector('.g-pw .g-pass') || {}).textContent || '' })));
  const row = (n) => rows.find((r) => r.who.startsWith(n)) || {};
  ok('guestadmin: one row per friend: name and role, created, first login "—", status; Upgrade, Extend, Remove for good', rows.length === 5 && row('Ada Mock').who === 'Ada Mock GUEST' && /created \d+ \w{3}/.test(row('Ada Mock').meta) && /first login —/.test(row('Ada Mock').meta) && /active · limit/.test(row('Ada Mock').meta)
    && row('Dee Mock').who === 'Dee Mock MEMBER' && row('Ada Mock').acts === 'g-up,g-ext,g-rm' && row('Dee Mock').acts === 'g-ext,g-rm' && /removed/.test(row('Bo Mock').meta) && row('Bo Mock').acts === '', JSON.stringify(rows.map((r) => r.who + ' ' + r.acts)));
  ok('guestadmin: a passphrase the loop made shows to the owner with Copy and a share text', row('Eli Mock').pw === ELI_PASS && /data-act="g-copy"/.test(await p.innerHTML('#g-list')));
  const shs = await p.evaluate(() => ({ st: document.querySelector('#sh-state').textContent, pw: (document.querySelector('#sh-body .g-pass') || {}).textContent || '', end: !document.querySelector('#sh-end').hidden }));
  ok('guestadmin: the shared guest password: active, its end date, the password the loop made with Copy, and "End shared access now"', /^ACTIVE · ENDS \d+ [A-Z]{3}$/.test(shs.st) && shs.pw === SHARED_PASS && shs.end, shs.st);
  await snap(p, 'owner-settings', '#settings');
  await p.click('#g-list .g-row[data-slot="0e0e0e0e0e0e0e0e"] [data-act="g-sentok"]'); await sleep(150);
  const hidden = !(await p.textContent('#g-list')).includes(ELI_PASS);
  await p.click('#g-list .g-row[data-slot="0e0e0e0e0e0e0e0e"] [data-act="g-show"]'); await sleep(150);
  ok('guestadmin: "Mark as sent" hides the passphrase, "Show the passphrase again" brings it back', hidden && (await p.textContent('#g-list')).includes(ELI_PASS));
  // a list of friends at once: one passphrase each, a share text each, ONE sealed request; the loop's own code adds them all
  await p.click('#settings [data-act="g-add"]');
  await p.fill('#g-name', 'Fay Mock, Gil Mock\nHal Mock');
  await p.click('#settings [data-act="g-create"]');
  await p.waitForSelector('#g-out .g-plist', { timeout: 60000 });
  const made = await p.evaluate(() => ({ items: [...document.querySelectorAll('#g-out .g-plist li')].map((l) => ({ n: l.querySelector('.g-n').textContent, pass: l.querySelector('.g-pass').textContent, share: l.querySelectorAll('[data-act="g-copy"]')[1].dataset.copy })), links: [...document.querySelectorAll('#g-out a.g-send')].map((a) => a.href) }));
  const lp = await loopApplies(sealedOf(made.links[0]));
  const opened = await Promise.all(made.items.map((x) => slotFor(lp.kf, x.pass)));
  ok('guestadmin: Add guests: three names, three passphrases (5 words and 2 digits), each with a share text holding the link and the passphrase, and one link', made.items.length === 3 && made.links.length === 1 && made.items.every((x) => /^([a-z]{3,6}-){5}\d\d$/.test(x.pass) && x.share.includes(x.pass) && x.share.includes('/app/index.html') && x.share.startsWith(`Hi ${x.n}!`)));
  ok('guestadmin: the loop\'s own code adds all three from the one request; each passphrase opens its own slot, read-only', !!lp.r && lp.r.added === 3 && opened.every((s, i) => s && s.name === made.items[i].n && s.role === 'guest'));
  { // whole names and passphrases only: a bare 3-letter run can turn up in random base64 by chance
    const env = sealedOf(made.links[0]) || {}, plain = [decodeURIComponent(made.links[0]), new URL(made.links[0]).searchParams.get('value') || '', Buffer.from(String(env.ct || ''), 'base64').toString('latin1')];
    ok('guestadmin: the sealed request carries no name or passphrase in the clear', Object.keys(env).sort().join() === 'ct,epk,inbox,iv' && made.items.every((x) => plain.every((t) => !t.includes(x.n) && !t.includes(x.pass))), Object.keys(env).sort().join());
  }
  // upgrade and extend: sealed, and the loop gives back the same passphrase with the new role or limit
  await p.click('#g-out [data-act="g-cancel"]'); // the list's own result goes first (its link must never be read as the next one's)
  const sealedAs = (lbl) => p.waitForFunction((l) => { const x = document.querySelector('#g-out .lbl'); return !!x && x.textContent === l && !!document.querySelector('#g-out a.g-send'); }, lbl, { timeout: 20000 });
  await p.click('#g-list .g-row[data-slot="0a0a0a0a0a0a0a0a"] [data-act="g-up"]');
  await sealedAs('UPGRADE SEALED');
  let q = await loopApplies(sealedOf(await p.getAttribute('#g-out a.g-send', 'href')));
  const ada = await slotFor(q.kf, GUEST_PASS);
  ok('guestadmin: "Upgrade to member": the same passphrase opens as a member', q.r.updated === 1 && ada && ada.role === 'member' && ada.exp === null);
  await p.click('#g-out [data-act="g-cancel"]');
  await p.click('#g-list .g-row[data-slot="0e0e0e0e0e0e0e0e"] [data-act="g-ext"]');
  await sealedAs('EXTENSION SEALED');
  q = await loopApplies(sealedOf(await p.getAttribute('#g-out a.g-send', 'href')));
  const eli = await slotFor(q.kf, ELI_PASS);
  ok('guestadmin: "Extend 30 days": a later limit, and the device\'s clock restarts', q.r.updated === 1 && eli && eli.exp > Date.now() + 65 * 86400e3 && Math.abs(eli.ext - Date.now()) < 600e3);
  await p.click('#g-out [data-act="g-cancel"]');
  // the shared password: typed here (a weak one refused), or made by the loop; ended now
  await p.click('#sh-set');
  await p.fill('#sh-new', 'friends2026'); await p.fill('#sh-new2', 'friends2026'); await p.click('#sh-out [data-act="sh-save"]');
  ok('guestadmin: a weak shared password is refused (names and short words never pass)', /Too weak/.test(await p.textContent('#sh-msg')) && !(await p.$('#sh-out a.g-send')));
  const typed = 'made-up strong shared words for the test 2026';
  await p.fill('#sh-new', typed); await p.fill('#sh-new2', typed); await p.click('#sh-out [data-act="sh-save"]');
  await p.waitForSelector('#sh-out a.g-send', { timeout: 30000 });
  q = await loopApplies(sealedOf(await p.getAttribute('#sh-out a.g-send', 'href')));
  const ns = await slotFor(q.kf, typed), old = await slotFor(q.kf, SHARED_PASS);
  ok('guestadmin: "Change the shared password": the loop replaces it (the old one stops, the key rotates), the new one opens as "friends"', q.r.added === 1 && q.r.removed === 1 && q.r.rotated && ns && ns.shared && ns.name === 'friends' && !old);
  await p.click('#sh-out [data-act="g-cancel"]');
  await p.click('#sh-set'); await p.click('#sh-out [data-act="sh-loop"]');
  await p.waitForSelector('#sh-out a.g-send', { timeout: 30000 });
  q = await loopApplies(sealedOf(await p.getAttribute('#sh-out a.g-send', 'href')));
  const { readSealed: rs } = await import('../lib/store.mjs');
  const kept = rs('guests.json', [q.keys.aes], { outDir: q.dir }).guests.find((x) => x.sh && x.st === 'active');
  ok('guestadmin: "Let the loop make a strong one": the loop makes it and keeps it for the owner only', q.r.added === 1 && /^([a-z]{3,6}-){5}\d\d$/.test(kept.pw) && !!(await slotFor(q.kf, kept.pw)) && !fs.readFileSync(path.join(q.dir, 'keys.json'), 'utf8').includes(kept.pw));
  await p.click('#sh-out [data-act="g-cancel"]');
  await p.click('#sh-end'); await p.click('#sh-out [data-act="g-rmok"]');
  await p.waitForSelector('#sh-out a.g-send', { timeout: 20000 });
  q = await loopApplies(sealedOf(await p.getAttribute('#sh-out a.g-send', 'href')));
  ok('guestadmin: "End shared access now": the slot goes and the key rotates', q.r.removed === 1 && q.r.rotated && !(await slotFor(q.kf, SHARED_PASS)));
  ok('guestadmin: owner pages have no errors', t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
  await t.ctx.close();
}
async function testRecovery(browser) {
  const t = await newPage(browser, { phone: true }), p = t.page;
  await p.goto(url('keyed'));
  await p.waitForSelector('#lockscreen:not([hidden])');
  await p.click('#lockscreen [data-act="rk-use"]');
  await p.fill('#rk-in', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
  await p.click('#rk-form [data-act="rk-open"]');
  await p.waitForFunction(() => /opens nothing/.test(document.querySelector('#rk-umsg').textContent), null, { timeout: 30000 });
  ok('recovery: a wrong recovery key opens nothing and says so', !(await p.isVisible('#app')));
  await p.fill('#rk-in', RECOVERY_KEY.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')); // any case, spaces, an o for a 0
  await p.click('#rk-form [data-act="rk-open"]');
  await waitApp(p);
  await p.waitForSelector('#pw-new', { timeout: 15000 });
  ok('recovery: the recovery key (any case, any spacing) opens everything and goes straight to a new passphrase', await p.isVisible('#settings') && /Opened with your recovery key/.test(await p.textContent('#pw-out')));
  await snap(p, 'recovery-newpass');
  await p.fill('#pw-new', 'ada mock 2026'); await p.fill('#pw-new2', 'ada mock 2026'); await p.click('#pw-out [data-act="pw-save"]');
  ok('recovery: a weak new passphrase is refused', /Too weak/.test(await p.textContent('#pw-msg')));
  await p.fill('#pw-new', NEW_PASS); await p.fill('#pw-new2', NEW_PASS); await p.click('#pw-out [data-act="pw-save"]');
  await p.waitForSelector('#pw-out a.g-send', { timeout: 30000 });
  const lp = await loopApplies(sealedOf(await p.getAttribute('#pw-out a.g-send', 'href')));
  const { openVault: ov } = await import('../lib/keyring.mjs');
  let opens = false;
  try { opens = !!ov(lp.lock, NEW_PASS, lp.kf).mdek; } catch (e) { opens = false; }
  ok('recovery: the new passphrase goes to the loop as an owner slot; with it, the new passphrase opens the data', !!lp.req && lp.req.lps === 'owner-add' && lp.r.ownerAdded === 1 && opens);
  await p.reload(); await waitApp(p);
  ok('recovery: this device stays unlocked (it keeps the master key)', !(await p.isVisible('#lockscreen')) && await p.isVisible('#settings'));
  ok('recovery: no page errors', t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
  await t.ctx.close();
}
async function testPassChange(browser) {
  let t = await openUnlocked(browser, 'keyed', { phone: true, win: null });
  let p = t.page;
  await p.evaluate(() => document.querySelector('#settings').scrollIntoView());
  ok('passchange: Settings shows the recovery key and the passphrase', /SET/.test(await p.textContent('#rk-state')) && /1 IN USE/.test(await p.textContent('#pw-state')));
  await p.click('#rk-create');
  await p.waitForSelector('#rk-key', { timeout: 15000 });
  const rk = await p.textContent('#rk-key'), asks = await p.evaluate(() => [...document.querySelectorAll('#rk-out label')].map((l) => Number(l.textContent.replace(/\D/g, '')) - 1));
  ok('passchange: the recovery key is 8 groups of 4 (160 bits, no I, L, O or U), with "Write this down and keep it at home"', /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/.test(rk) && /Write this down and keep it at home/.test(await p.textContent('#rk-out')));
  await snap(p, 'recovery-create', '#settings');
  const g = rk.split('-');
  await p.fill('#rk-a', g[asks[0]] === 'AAAA' ? 'BBBB' : 'AAAA'); await p.fill('#rk-b', g[asks[1]]); await p.click('#rk-out [data-act="rk-check"]');
  ok('passchange: a wrong group is refused before anything is sealed', /don’t match/.test(await p.textContent('#rk-msg')) && !(await p.$('#rk-out a.g-send')));
  await p.fill('#rk-a', g[asks[0]].toLowerCase()); await p.click('#rk-out [data-act="rk-check"]');
  await p.waitForSelector('#rk-out a.g-send', { timeout: 30000 });
  const lp = await loopApplies(sealedOf(await p.getAttribute('#rk-out a.g-send', 'href')));
  const { masterFrom: mf, openMaster: om } = await import('../lib/keyring.mjs');
  const { deriveKeys: dk } = await import('../lib/lock.mjs');
  let both = false;
  try { const m = mf(lp.kf, dk(rk.replace(/-/g, ''), lp.kf.rsalt, lp.kf.iter).aes, 'recovery'); const v = om(lp.kf, m.mk); both = !!v.mdek && !!v.aes; } catch (e) { both = false; }
  ok('passchange: the loop sets the recovery key, and it opens both data keys', !!lp.req && lp.req.lps === 'recovery-set' && lp.r.recoverySet === 1 && both);
  await t.ctx.close();
  t = await openUnlocked(browser, 'keyedchange', { phone: true, win: null });
  p = t.page;
  await p.evaluate(() => document.querySelector('#settings').scrollIntoView());
  const ready = await p.evaluate(() => ({ st: document.querySelector('#pw-state').textContent, txt: document.querySelector('#pw-body').innerText, href: (document.querySelector('#pw-body a.g-send') || {}).href || '' }));
  ok('passchange: once the loop has the new slot: "New passphrase ready", both work, and the exact GitHub steps', ready.st === 'NEW PASSPHRASE READY' && /Both the old and the new one open everything now/.test(ready.txt) && /Update secret/.test(ready.txt) && ready.href === 'https://github.com/kereslek/assim-LS/settings/secrets/actions/LOCK_PASSPHRASE', ready.st);
  await snap(p, 'passchange-ready', '#settings');
  await t.ctx.close();
  t = await newPage(browser, { width: 1440 });
  await t.page.goto(url('keyedchange')); await unlockWith(t.page, NEW_PASS); await waitApp(t.page);
  ok('passchange: the new passphrase unlocks as the owner while the change is under way', await t.page.isVisible('#settings') && !(await t.page.isVisible('#gpill')));
  ok('passchange: no page errors', t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
  await t.ctx.close();
}
async function testMismatch(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['w1440', { width: 1440 }]]) {
    const t = await newPage(browser, o), p = t.page;
    await p.goto(url('mismatch'));
    await p.waitForSelector('#alarm:not([hidden])', { timeout: 20000 });
    const a = await p.evaluate(() => { const el = document.querySelector('#alarm'), r = el.getBoundingClientRect(); return { txt: el.innerText, red: /226, 102, 76/.test(getComputedStyle(el).borderTopColor), w: r.width, vw: innerWidth, lock: !document.querySelector('#lockscreen').hidden }; });
    ok(`mismatch ${tag}: locked, every device shows the red banner: paused, nothing lost, the fix`, a.lock && a.red && /The scanner is paused:.*the passphrase in GitHub doesn’t match your data\. Nothing is lost\./s.test(a.txt) && /use your recovery key/.test(a.txt) && a.w <= a.vw, a.txt.slice(0, 80));
    await p.click('#alarm [data-act="al-more"]');
    ok(`mismatch ${tag}: its steps open on a tap`, /LOCK_PASSPHRASE/.test(await p.textContent('#al-steps')) && await p.isVisible('#al-steps'));
    await snap(p, `mismatch-${tag}-locked`);
    await unlockWith(p, FIXTURE_PASSPHRASE); await waitApp(p);
    ok(`mismatch ${tag}: unlocked, the banner stays`, await p.isVisible('#alarm'));
    await snap(p, `mismatch-${tag}-unlocked`);
    await p.goto(url('keyed')); await waitApp(p);
    ok(`mismatch ${tag}: without the flag there is no banner`, !(await p.isVisible('#alarm')));
    ok(`mismatch ${tag}: no page errors`, t.errors.length === 0, t.errors.slice(0, 3).join(' | '));
    await t.ctx.close();
  }
}

// ---------- v0.7.x · every History button clear of its neighbours, and All combined as a toggle (the owner, 16 Nov 2026) ----------
// "The History button in several places runs into something else or is covered": every visible History control, on every
// pool surface, in the long and stress cases (long names cause most collisions). Counts and short reasons out, never text.
const HB_AUDIT = async (o) => {
  const out = [], seenKeys = {};
  const vis = (e) => { if (!e || e.closest('[hidden]')) return false; if (e.checkVisibility && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const LAYER = '#ws, #sheet, #pop, #q-list, header.top, .sh, #fullv, #ctip';
  const layer = (e) => e.closest(LAYER) || document.body;
  const clipR = (e, r) => { // trimmed to what its clipping boxes still show
    r = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      r = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
      if (r.right - r.left < 0.5 || r.bottom - r.top < 0.5) return null;
    }
    return r;
  };
  const painted = (e) => { const cs = getComputedStyle(e); return !/^(rgba\(0, 0, 0, 0\)|transparent)$/.test(cs.backgroundColor) || cs.backgroundImage !== 'none' || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0 || cs.boxShadow !== 'none' || /^(svg|IMG|CANVAS)$/.test(e.tagName); };
  const paintRects = (e, acc = []) => { // what a control draws: its painted boxes, text lines (less the font's leading), icons
    if (!vis(e)) return acc;
    if (painted(e)) { acc.push(e.getBoundingClientRect()); if (/^(svg|IMG)$/.test(e.tagName)) return acc; }
    for (const n of e.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim()) { const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) { const h = r.bottom - r.top; acc.push({ left: r.left, right: r.right, top: r.top + h * 0.16, bottom: r.bottom - h * 0.16 }); } }
      else if (n.nodeType === 1) paintRects(n, acc);
    }
    return acc;
  };
  const union = (rs) => (rs.length ? rs.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 }) : null);
  const inter = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const kind = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : ''));
  const where = (e) => { const s = e.closest('#ws-tabs, #ws .ws-in > *, .sheet-ctl, #sim, #sheet-main, #sheet-body, #best, #fav, #disc, #all, section[id], #ws'); return s ? kind(s) : 'page'; };
  const root = document.querySelector(o.root);
  if (!root) return [{ where: o.root, el: '-', probs: ['missing'] }];
  const layerEl = o.layer ? document.querySelector(o.layer) : document.body;
  const els = [...root.querySelectorAll('[data-act="ws-hist"], #ws-tabs [data-v="history"]')].filter(vis).filter((e) => layer(e) === layerEl);
  for (const el of els) {
    const wk = where(el) + ' ' + kind(el);
    if ((seenKeys[wk] = (seenKeys[wk] || 0) + 1) > (o.cap || 4)) continue; // a few of each kind (a table's rows are all alike)
    const card = el.closest('.mc-track') && el.closest('.mc, .dcw');
    (card || el).scrollIntoView({ block: 'center', inline: card ? 'start' : 'nearest', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, card ? 160 : 40)); // a strip's snap settles
    const r = el.getBoundingClientRect(), vr = union(paintRects(el)) || r, L = layer(el), probs = [], hits = [];
    for (const c of L.querySelectorAll('button, a[href], input, select, [role="tab"], [role="button"], summary, label')) {
      if (c === el || c.contains(el) || el.contains(c) || !vis(c) || layer(c) !== L) continue;
      const pr = paintRects(c).map((x) => clipR(c, x)).filter(Boolean);
      if (pr.some((x) => inter(vr, x))) { hits.push('control ' + kind(c)); continue; }
      for (const x of pr) if (inter(r, x)) { // its tap box over another control's drawing: does a tap there land on History?
        const h = document.elementFromPoint((Math.max(r.left, x.left) + Math.min(r.right, x.right)) / 2, (Math.max(r.top, x.top) + Math.min(r.bottom, x.bottom)) / 2);
        if (h && (h === el || el.contains(h))) { hits.push('takes taps of ' + kind(c)); break; }
      }
    }
    const tw = document.createTreeWalker(L, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? 1 : 2) });
    const cell = el.closest('td, th'), stickyCell = cell && getComputedStyle(cell).position === 'sticky' ? cell : null; // a table's sticky History column: cells scroll under it
    for (let n; (n = tw.nextNode());) {
      const pe = n.parentElement;
      if (!pe || el.contains(pe) || pe.closest('button, a[href], [role="tab"], [role="button"], label, summary') || !vis(pe) || layer(pe) !== L) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      if ([...rg.getClientRects()].some((q) => {
        const h = q.bottom - q.top, x = clipR(pe, { left: q.left, right: q.right, top: q.top + h * 0.16, bottom: q.bottom - h * 0.16 });
        if (!x || !inter(vr, x)) return false;
        if (!stickyCell) return true;
        const top = document.elementFromPoint((Math.max(vr.left, x.left) + Math.min(vr.right, x.right)) / 2, (Math.max(vr.top, x.top) + Math.min(vr.bottom, x.bottom)) / 2);
        return !(top && stickyCell.contains(top));
      })) hits.push('text ' + kind(pe));
    }
    for (const c of L.querySelectorAll('svg, i, .sq, .cg, img, canvas')) {
      if (el.contains(c) || c.contains(el) || c.closest('button, a[href], [role="tab"], .fx3d, [aria-hidden="true"]:not(svg)') || (c.parentElement && c.parentElement.closest('svg')) || !vis(c) || layer(c) !== L) continue;
      const x = clipR(c, c.getBoundingClientRect()); if (x && inter(vr, x)) hits.push('icon ' + kind(c));
    }
    if (hits.length) probs.push('runs into ' + [...new Set(hits)].slice(0, 3).join(', '));
    const pts = [[0.5, 0.5], [0.2, 0.25], [0.8, 0.25], [0.2, 0.75], [0.8, 0.75]], cov = new Set();
    for (const [fx, fy] of pts) for (const R of [vr, r]) { const h = document.elementFromPoint(R.left + (R.right - R.left) * fx, R.top + (R.bottom - R.top) * fy); if (!h || !(h === el || el.contains(h))) cov.add(h ? kind(h) : 'nothing'); }
    if (cov.size) probs.push('covered by ' + [...cov].slice(0, 2).join(', '));
    let box = null;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (painted(a) || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { box = a; break; } }
    if (box) { const b = box.getBoundingClientRect(); if (vr.left < b.left - 1 || vr.right > b.right + 1 || vr.top < b.top - 1 || vr.bottom > b.bottom + 1) probs.push('outside its ' + kind(box)); }
    if (vr.left < -0.5 || vr.right > innerWidth + 0.5 || vr.top < -0.5 || vr.bottom > innerHeight + 0.5) probs.push('off screen');
    if (o.touch && (r.width < 43.5 || r.height < 43.5)) probs.push(`tap box ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (!(el.getAttribute('aria-label') || (el.getAttribute('role') === 'tab' ? el.textContent : '') || '').trim()) probs.push('no label');
    if (probs.length) out.push({ where: where(el), el: kind(el), probs });
  }
  return out.length ? out : els.length ? [] : [{ where: o.root, el: '-', probs: ['no History control'] }];
};
// the "Within ±x%" line: each chain icon centred on its text (±1.5 px) and clear of it on both sides (≥ 2 px)
const HB_LEGEND = () => [...document.querySelectorAll('.mgline')].filter((e) => e.getClientRects().length && !e.closest('[hidden]')).flatMap((ml) => [...ml.querySelectorAll('.cg')].map((c) => {
  const sp = c.parentElement, tn = [...sp.childNodes].find((x) => x.nodeType === 3 && x.nodeValue.trim()), sq = sp.querySelector('.sq');
  if (!tn) return null;
  const rg = document.createRange(); rg.selectNodeContents(tn); const t = rg.getClientRects()[0], i = c.getBoundingClientRect(), s = sq ? sq.getBoundingClientRect() : null;
  const dy = (i.top + i.bottom) / 2 - (t.top + t.bottom) / 2, gapR = t.left - i.right, gapL = s ? i.left - s.right : 9;
  return Math.abs(dy) <= 1.5 && gapR >= 2 && gapL >= 2 ? null : `dy ${dy.toFixed(1)} gaps ${gapL.toFixed(1)}/${gapR.toFixed(1)}`;
})).filter(Boolean);
const HB_WHERE = () => { const s = document.querySelector('#sheet'), b = document.querySelector('#sheet-body'); return { y: Math.round(scrollY), sheet: !!s && !s.hidden, sb: b ? Math.round(b.scrollTop) : 0 }; };
async function hbPress(p, sel) { // press the first visible match: the workspace opens on that pool's History; Close comes back to where it was
  const got = await p.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length && !e.closest('[hidden]'));
    if (!el) return null;
    window.dispatchEvent(new WheelEvent('wheel'));
    const card = el.closest('.mc-track') && el.closest('.mc, .dcw');
    (card || el).scrollIntoView({ block: 'center', inline: card ? 'start' : 'nearest', behavior: 'instant' });
    for (const e of document.querySelectorAll('[data-hb]')) e.removeAttribute('data-hb');
    el.setAttribute('data-hb', '1');
    return { id: el.dataset.id || null };
  }, sel);
  if (!got) return 'missing';
  await sleep(200);
  const before = await p.evaluate(HB_WHERE), want = got.id;
  const clicked = await p.click('[data-hb="1"]', { timeout: 4000 }).then(() => true, () => false);
  if (!clicked) return 'not clickable';
  await wsWait(p);
  const w = await p.evaluate(WS_LOOK);
  if (!w || w.tab !== 'history' || (want && w.id !== want)) { await p.keyboard.press('Escape'); await wsWait(p, false); return 'opened ' + JSON.stringify(w && { tab: w.tab, same: w.id === want }); }
  await p.keyboard.press('Escape'); await wsWait(p, false);
  const after = await p.evaluate(HB_WHERE), g = await p.evaluate(WS_GONE);
  if (!g.hidden) return 'did not close';
  if (after.sheet !== before.sheet || Math.abs(after.y - before.y) > 2 || Math.abs(after.sb - before.sb) > 2) return 'came back elsewhere ' + JSON.stringify({ dy: after.y - before.y, sheet: [before.sheet, after.sheet], dsb: after.sb - before.sb });
  return '';
}
async function testHistBtn(browser) {
  const looks = MODE && !(BROWSER === 'webkit' && MODE === '2d') ? [MODE] : ['3d', '2d']; // the WebKit 3D job leaves both looks to its 2D job
  for (const look of looks) for (const [tag, c, o] of [['phone', 'stress', { phone: true }], ['w1440', 'long', { width: 1440, height: 900 }]]) {
    const t = await openUnlocked(browser, c, { ...o, mode: look, mg: true }), p = t.page, touch = tag === 'phone', T = `${look} ${tag} ${c}`;
    const bad = [], clicks = {}, A = async (name, root, layer) => {
      // a panel sliding in or a tab fading over (3D, a slow WebKit) is not seen yet: wait for one History control to show
      await p.waitForFunction((root) => [...document.querySelectorAll(`${root} [data-act="ws-hist"]`)].some((e) => !e.closest('[hidden]') && e.getClientRects().length && (!e.checkVisibility || e.checkVisibility({ opacityProperty: true, visibilityProperty: true }))), root, { timeout: 6000 }).catch(() => {});
      await sleep(250);
      for (const f of await p.evaluate(HB_AUDIT, { root, layer, touch, cap: 4 })) bad.push(`${name} ${f.where} ${f.el}: ${f.probs.join('; ')}`);
    };
    if (!(await p.$('#best [data-act="ws-hist"]'))) { await p.evaluate(() => document.querySelector('#best [role="tab"]').click()); await sleep(400); } // the stress case's best waits for a tab
    await A('main', '#app', 'body');
    for (const s of ['#best .fmlink', '#best .ctools [data-act="ws-hist"]', '#best .pz-hist', '#disc [data-act="ws-hist"]']) clicks[s] = await hbPress(p, s);
    await p.evaluate(() => { const b = document.querySelectorAll('#best [role="tab"]')[2]; if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } }); await sleep(300);
    await A('tab', '#best', 'body');
    clicks['#best tab'] = await hbPress(p, '#best .ctools [data-act="ws-hist"]');
    await p.evaluate(() => { const s = document.querySelector('#best .star'); if (s && s.getAttribute('aria-pressed') !== 'true') s.click(); }); await sleep(300);
    await A('fav', '#fav', 'body');
    clicks['#fav'] = await hbPress(p, '#fav .hbtn[data-act="ws-hist"]');
    await fillQ(p, 'WMW'); await sleep(300);
    await A('search', '#all', 'body');
    clicks['search'] = await hbPress(p, '#all-tbl tbody tr.row [data-act="ws-hist"]');
    const bid = await p.getAttribute('#best [data-act="ws-hist"]', 'data-id');
    await openPool(p, bid.slice(0, 12));
    await A('panel', '#sheet', '#sheet');
    const leg = await p.evaluate(HB_LEGEND);
    for (const s of ['#sheet-hist', '#sim .mc:not(.self) [data-act="ws-hist"]', '#sheet .ctools [data-act="ws-hist"]', '#sheet .pz-hist']) clicks[s] = await hbPress(p, s);
    if (await p.evaluate(() => { const b = document.querySelector('#sheet-pair'); return !!b && !b.hidden; })) {
      await p.click('#sheet-pair'); await sleep(400);
      await A('pair view', '#sheet', '#sheet');
      clicks['pair view'] = await hbPress(p, '#sheet-main [data-act="ws-hist"]');
    }
    await p.keyboard.press('Escape'); await sleep(300); await fillQ(p, '');
    await p.evaluate(() => { scrollTo(0, 0); document.querySelector('#best [data-act="ws-hist"]').click(); }); await wsWait(p);
    for (const v of ['overview', 'history', 'liquidity', 'pair', 'compare']) {
      await p.click(`#ws-tabs [data-v="${v}"]`); await sleep(400);
      await A('workspace ' + v, '#ws', '#ws');
      if (v === 'liquidity') leg.push(...(await p.evaluate(HB_LEGEND)));
      if (v === 'pair') { // a row's History in the pair table opens History on that row's pool
        const id = await p.evaluate(() => { const b = [...document.querySelectorAll('#ws .ws-pt [data-act="ws-hist"]')].pop(); if (!b) return null; b.scrollIntoView({ block: 'center', inline: 'nearest' }); return b.dataset.id; });
        if (id) { await p.evaluate(() => [...document.querySelectorAll('#ws .ws-pt [data-act="ws-hist"]')].pop().setAttribute('data-hb', '2')); await p.click('[data-hb="2"]', { timeout: 4000 }).catch(() => {}); await sleep(400); const w = await p.evaluate(WS_LOOK); clicks['workspace pair'] = w && w.tab === 'history' && w.id === id ? '' : 'opened ' + JSON.stringify(w && { tab: w.tab, same: w.id === id }); await p.click('#ws-tabs [data-v="pair"]'); await sleep(300); }
      }
    }
    await p.keyboard.press('Escape'); await wsWait(p, false);
    const cbad = Object.entries(clicks).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    ok(`histbtn ${T}: every visible History control is clear of other text and controls, uncovered, inside its box and the screen${touch ? ', a 44 px tap box' : ''}, labelled (${bad.length} findings)`, bad.length === 0, bad.slice(0, 6).join(' | '));
    ok(`histbtn ${T}: each History control opens the workspace's History on its own pool, and Close comes back to where it was (${Object.keys(clicks).length} surfaces)`, Object.keys(clicks).length >= 10 && cbad.length === 0, cbad.slice(0, 4).join(' | '));
    ok(`histbtn ${T}: the "Within ±9%" line's chain icons sit centred on their text and clear of it (${leg.length} off)`, leg.length === 0, leg.slice(0, 3).join(' | '));
    ok(`histbtn ${T}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
  // All combined is a toggle (the owner, 16 Nov 2026): every tier on → the others leave, animated, this pool stays; again → all
  const v4 = FXT.live.pools.find((q) => { const k = (x) => [x.t0.sym, x.t1.sym].sort().join('/') + '@' + x.chain; return FXT.history.pools[q.id] && FXT.live.pools.filter((x) => k(x) === k(q) && FXT.history.pools[x.id]).length >= 3; });
  const CHIPS = () => { const a = document.querySelector('#ws [data-act="ws-tier"][data-v="all"]'), cs = [...document.querySelectorAll('#ws .hs-chip[data-act="ws-tier"]:not([data-v="all"])')], hs = document.querySelector('#ws .hs');
    return { all: a && a.getAttribute('aria-pressed'), word: a ? a.textContent.trim() : '', said: a ? a.getAttribute('aria-label') + ' ' + (a.getAttribute('title') || '') : '', on: cs.filter((b) => b.getAttribute('aria-pressed') === 'true').length, n: cs.length, self: cs.filter((b) => b.getAttribute('aria-pressed') === 'true' && /\(this pool\)/.test(b.getAttribute('aria-label') || '')).length, ph: hs ? hs.dataset.ph || '' : '', mode: hs ? hs.dataset.mode : '' }; };
  for (const [tag, rm] of [['motion', 'no-preference'], ['reduced', 'reduce']]) {
    const t = await openUnlocked(browser, 'tiny', { phone: true, mg: true, flash: true, reducedMotion: rm, mode: MODE || '2d' }), p = t.page;
    await openPool(p, v4.id.slice(0, 10));
    await p.evaluate(() => document.querySelector('#sheet-hist').click()); await wsWait(p);
    await p.waitForFunction(() => { const h = document.querySelector('#ws .hs'); return h && (!h.dataset.ph || h.dataset.ph === 'end'); }, null, { timeout: 8000 }).catch(() => {}); // its own build-up first
    const s0 = await p.evaluate(CHIPS);
    const seq = [], t0 = Date.now();
    await p.click('#ws [data-act="ws-tier"][data-v="all"]');
    let s1 = null;
    while (Date.now() - t0 < 5000) { s1 = await p.evaluate(CHIPS); seq.push(`${s1.on}${s1.ph === 'drop' ? 'd' : ''}`); if (s1.mode === 'one' && s1.ph !== 'drop') break; await sleep(40); }
    const ms1 = Date.now() - t0, steps = [...new Set(seq)];
    const t1 = Date.now();
    await p.click('#ws [data-act="ws-tier"][data-v="all"]');
    let s2 = null;
    while (Date.now() - t1 < 6000) { s2 = await p.evaluate(CHIPS); if (s2.on === s2.n && (!s2.ph || s2.ph === 'end')) break; await sleep(40); }
    const ms2 = Date.now() - t1;
    const r = { s0: [s0.all, s0.on, s0.n, s0.word], s1: [s1.all, s1.on, s1.self, s1.word, s1.mode], ms1, steps: steps.join(' '), s2: [s2.all, s2.on, s2.n, s2.word], ms2 };
    ok(`histbtn all ${tag}: All combined reads pressed "All combined ✓" with every tier on, says a press shows only this pool; a press leaves only "this" on, unpressed "All combined"`, s0.n >= 2 && s0.all === 'true' && s0.on === s0.n && /✓/.test(s0.word) && /only this pool/i.test(s0.said) && s1.all === 'false' && s1.on === 1 && s1.self === 1 && !/✓/.test(s1.word) && s1.mode === 'one', JSON.stringify(r));
    if (rm === 'reduce') ok(`histbtn all ${tag}: under reduced motion the end state comes at once (no drop phase, ${ms1} ms)`, !seq.some((x) => /d/.test(x)) && ms1 < 700, JSON.stringify(r));
    else ok(`histbtn all ${tag}: the other tiers leave one at a time (a drop phase, ${steps.length} steps), done in under 2 s (${ms1} ms)`, seq.some((x) => /d/.test(x)) && steps.filter((x) => /d/.test(x)).length >= Math.min(2, s0.n - 1) && ms1 < 2200, JSON.stringify(r));
    ok(`histbtn all ${tag}: pressed again, every tier comes back (the build-up), pressed and "All combined ✓" (${ms2} ms)`, s2.all === 'true' && s2.on === s2.n && /✓/.test(s2.word) && ms2 < (rm === 'reduce' ? 700 : 3500), JSON.stringify(r));
    ok(`histbtn all ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
}

// ---------- v0.7.1: APR up front (the owner's A+B+C+E+F, 20 Nov 2026) ----------
// A: a net APR chip under the pool's name on every workspace tab, pinned while the body scrolls, following the window, its tap
// explaining it; B: Overview opens with an APR hero; C: A's and B's numbers roll to their value in under a second (at once under
// reduced motion); E: History's fourth synced chart "Fee APR a day" (fees ÷ TVL × 365, % axis from 0%, gaps for days not read),
// the tiers' APR chips with one BEST, the day card's Fee APR and the range header; the liquidity legend's in-range fee APR;
// F: an APR on every pool row and card. Missing is a dash or "not read", never 0%.
const APR_SURF = () => { // the home page's pool rows and cards, each with an APR
  const q = (s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length);
  return { next: q('#next .nb-row [data-aprb]').length, nextRows: q('#next .nb-row').length, disc: q('#disc .dcw [data-aprb]').length, discCards: q('#disc .dcw').length,
    all: q('#all tbody tr [data-aprb]').length, allRows: q('#all tbody tr').length, tabs: q('#best .tabs .tab [data-aprb]').length, tabN: q('#best .tabs .tab').length,
    fav: q('#fav .mc [data-aprb]').length, favN: q('#fav .mc').length };
};
const APR_ZERO = (root) => { // a figure marked unread that reads 0%, or a dash-less unread figure: never
  const bad = [];
  for (const e of document.querySelectorAll(`${root} [data-aprb]`)) {
    const t = e.textContent.replace(/\s+/g, ' ').trim();
    if (e.dataset.aprb === '' && t !== '—') bad.push('unread ' + t.slice(0, 20));
    if (e.dataset.aprb !== '' && !/%/.test(t)) bad.push('no % ' + t.slice(0, 20));
    if (e.dataset.aprb !== '' && Math.abs(+e.dataset.aprb) >= 0.001 && /(^|[^\d.,])0%/.test(t)) bad.push('0% ' + t.slice(0, 20));
  }
  return bad;
};
const APR_FIT = () => { // no sideways scroll on the page or in the workspace body
  const b = document.querySelector('#ws-body'), d = document.documentElement;
  return { page: d.scrollWidth - innerWidth, ws: b && !document.querySelector('#ws').hidden ? b.scrollWidth - b.clientWidth : 0 };
};
const APR_ROLL = (o) => new Promise((res) => { // click (or not) and record the chip's and hero's text every frame for 1.1 s
  const el = o.sel ? document.querySelector(o.sel) : null;
  if (el) el.click();
  const t0 = performance.now(), seen = [];
  const f = () => {
    const t = performance.now() - t0, a = document.querySelector('#ws-apr [data-roll="a"]'), b = document.querySelector('#ws [data-roll="b"]');
    seen.push([Math.round(t), a ? a.textContent : null, b ? b.textContent : null]);
    if (t < 1600) requestAnimationFrame(f); else res({ seen, to: a ? a.dataset.to : null, fin: a ? a.textContent : null, finB: b ? b.textContent : null });
  };
  requestAnimationFrame(f);
});
const rollOk = (r, k = 1) => { // it moved (3+ distinct texts) and reached its last text by 1 s, then stayed
  const xs = r.seen.map((s) => s[k]), last = xs[xs.length - 1], i = xs.findIndex((x, j) => xs.slice(j).every((y) => y === last)), s0 = xs.findIndex((x) => x !== xs[0]);
  // timed in frames from the last one before it moved, each gap counted up to 120 ms as the page's own clock does: a test
  // runner's stalled main thread (WebKit in Actions stalls 0.3 to 0.8 s after a window switch) is not the roll's length
  let at = null; if (i >= 0) { at = 0; for (let j = Math.max(1, s0); j <= i; j++) at += Math.min(120, r.seen[j][0] - r.seen[j - 1][0]); }
  return { moved: new Set(xs).size >= 3, at, ok: new Set(xs).size >= 3 && i >= 0 && at < 1000 && /%$/.test(last) };
};
function aprPools() { // made-up fixtures: a pair with two pools or more, and a pool with days whose fees or TVL weren't read
  const live = FXD.live.pools, H = FXD.history.pools, key = (q) => String(q.pair).toUpperCase().split('/').map((x) => (x === 'ETH' ? 'WETH' : x)).sort().join('/');
  const by = new Map(); for (const q of live) { if (!H[q.id]) continue; const k = key(q); if (!by.has(k)) by.set(k, []); by.get(k).push(q); }
  const multi = [...by.values()].find((g) => g.length >= 2);
  const gap = live.find((q) => { const h = H[q.id]; if (!h || !Array.isArray(h.y) || !Array.isArray(h.yt) || (h.ytp && h.ytp.lim) || (h.yp && h.yp.lim)) return false; const n = h.y.length; for (let i = Math.max(0, n - 80); i < n; i++) if (h.y[i][1] == null || !h.yt[i] || h.yt[i][0] == null) return true; return false; });
  return { multi: multi ? multi[0] : null, gap: gap || null };
}
async function wsHashOpen(p, id, v) { await p.evaluate(([id, v]) => { location.hash = `p=${id}&v=${v}`; }, [id, v]); await wsWait(p); }
async function testApr(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true }]] : [['w393', { width: 393, height: 852 }], ['w1440', { width: 1440 }]];
  const { multi, gap } = aprPools();
  for (const [tag, o] of SETS) {
    const favIds = FXD.live.pools.slice(0, 3).map((q) => q.id);
    const t = await openUnlocked(browser, 'default', { ...o, win: '24h', storage: { 'lps.fav': JSON.stringify(favIds) } }), p = t.page;
    // F: the home page
    await p.click('[data-act="more"]').catch(() => {}); await sleep(200);
    const h = await p.evaluate(APR_SURF);
    ok(`apr ${tag}: F · every home row and card carries an APR: Next best ${h.next}/${h.nextRows}, Discovery ${h.disc}/${h.discCards}, All pools ${h.all}/${h.allRows}, top-10 tabs ${h.tabs}/${h.tabN}, Favourites ${h.fav}/${h.favN}`,
      h.nextRows > 0 && h.next === h.nextRows && h.discCards > 0 && h.disc === h.discCards && h.allRows > 0 && h.all === h.allRows && h.tabN > 0 && h.tabs === h.tabN && h.favN > 0 && h.fav === h.favN, JSON.stringify(h));
    const z0 = await p.evaluate(APR_ZERO, 'body');
    ok(`apr ${tag}: F · an unread APR is a dash, never 0%, and every read one has its %`, z0.length === 0 && (await p.evaluate(() => document.querySelectorAll('[data-aprb]').length)) > 0, z0.slice(0, 4).join(' | '));
    await p.focus('#f-q'); await p.keyboard.type(String(FXD.live.pools[0].pair).split('/')[0].slice(0, 3), { delay: 20 }); await sleep(300);
    const qs = await p.evaluate(() => ({ n: document.querySelectorAll('#q-list .qopt').length, a: document.querySelectorAll('#q-list .qopt [data-aprb]').length }));
    ok(`apr ${tag}: F · each search suggestion carries an APR (${qs.a}/${qs.n})`, qs.n > 0 && qs.a === qs.n, JSON.stringify(qs));
    await fillQ(p, ''); await p.keyboard.press('Escape').catch(() => {}); await sleep(150);
    // the pool panel: Similar pools, the in-range fee APR beside the range legend, the pair view's rows
    await p.click('#best [data-act="detail"]'); await p.waitForSelector('#sheet:not([hidden])'); await sleep(350);
    const sh = await p.evaluate(() => ({ sim: document.querySelectorAll('#sim .mc[data-id] [data-aprb]').length, simN: document.querySelectorAll('#sim .mc[data-id]').length, liq: [...document.querySelectorAll('#sheet [data-liqapr]')].map((e) => e.textContent) }));
    ok(`apr ${tag}: F + E · the pool panel: every Similar pools card has an APR (${sh.sim}/${sh.simN}); the range legend says "In the suggested ±x% range: fee APR y%"`, sh.simN > 0 && sh.sim === sh.simN && sh.liq.length >= 1 && /^In the suggested ±[\d.]+% range: fee APR [\d.,]+%$/.test(sh.liq[0]), JSON.stringify(sh));
    await p.click('#sheet-pair'); await sleep(300);
    const pv = await p.evaluate(() => ({ rows: document.querySelectorAll('#sheet table.pv tbody tr').length, a: document.querySelectorAll('#sheet table.pv tbody tr [data-aprb]').length }));
    ok(`apr ${tag}: F · the pair view: an APR on every row (${pv.a}/${pv.rows})`, pv.rows > 0 && pv.a === pv.rows, JSON.stringify(pv));
    await p.click('#sheet-close'); await sleep(200);
    const fit0 = await p.evaluate(APR_FIT), ov0 = [...await OVL(p, '#next'), ...await OVL(p, '#best .tabs')];
    ok(`apr ${tag}: the home page: no sideways scroll, no text on text in Next best and the top-10 tabs`, fit0.page <= 1 && ov0.length === 0, JSON.stringify([fit0, ov0.slice(0, 2)]));
    if (SHOTS) { await p.evaluate(() => document.querySelector('#next').scrollIntoView({ block: 'start' })); await sleep(250); await snap(p, `apr-${tag}-lists`); await p.evaluate(() => scrollTo(0, 0)); await sleep(150); }
    // A + C: the workspace on the best find; the chip rolls on open
    const r0 = await p.evaluate(APR_ROLL, { sel: '#best [data-act="ws-hist"]' }); await wsWait(p);
    const ro = rollOk(r0);
    ok(`apr ${tag}: C · on open the chip's net APR rolls to its value in under 1 s (${ro.at} ms, ${new Set(r0.seen.map((s) => s[1])).size} steps) and stays`, ro.ok, JSON.stringify([ro, r0.seen.slice(0, 3), r0.fin]));
    const tabs = {};
    for (const v of ['overview', 'history', 'liquidity', 'pair', 'compare']) {
      await p.click(`#ws-tabs [data-v="${v}"]`); await sleep(300);
      tabs[v] = await p.evaluate(() => {
        const c = document.querySelector('#ws-apr .aprchip'), b = document.querySelector('#ws-body'), r0 = c && c.getBoundingClientRect();
        if (!c) return null;
        b.scrollTop = 600; const r1 = c.getBoundingClientRect(), hd = document.querySelector('#ws-head').getBoundingClientRect(), bt = b.getBoundingClientRect();
        const v = c.querySelector('[data-roll="a"]'), k = c.querySelector('.k').textContent;
        const out = { v: v.textContent, to: v.dataset.to, k, pinned: Math.abs(r1.top - r0.top) < 0.5 && r1.bottom <= bt.top + 0.5 && r1.top >= hd.top - 0.5 && r0.height >= 30, scrolled: b.scrollTop };
        b.scrollTop = 0; return out;
      });
    }
    const tv = Object.values(tabs);
    ok(`apr ${tag}: A · the chip under the pool's name on all five tabs, pinned while the body scrolls: ${tv.filter((x) => x && x.pinned).length}/5`, tv.every((x) => x && x.pinned && /^(≈ )?−?[\d.,]+%$|^—$/.test(x.v) && /NET APR · 24H/.test(x.k)), JSON.stringify(tabs).slice(0, 300));
    const pd = await p.evaluate(() => { const c = document.querySelector('#ws-apr [data-roll="a"]'); return { to: +c.dataset.to, k: document.querySelector('#ws-apr .k').textContent }; });
    const want = (pd.to * FXD.live.ticket) / 365, got = (/≈ (−)?\$([\d.,]+)(K?)\/DAY/.exec(pd.k) || []);
    ok(`apr ${tag}: A · its $/day is the rate at the example ticket (${pd.k.replace(/^.*\n?/, '').slice(-16)})`, got.length && Math.abs((got[1] ? -1 : 1) * +got[2].replace(/,/g, '') * (got[3] ? 1e3 : 1) - want) <= Math.max(0.006, Math.abs(want) * 0.06), JSON.stringify(pd));
    await p.click('#ws-apr .aprchip'); await sleep(250);
    const pop = await p.evaluate(() => { const e = document.querySelector('#pop'); return e && !e.hidden ? e.textContent.replace(/\s+/g, ' ') : ''; });
    ok(`apr ${tag}: A · a tap on the chip explains it (net APR = fee APR − LVR − swaps − gas)`, /fee APR − LVR − re-centre swaps − gas/.test(pop), pop.slice(0, 120));
    await p.keyboard.press('Escape').catch(() => {}); await sleep(150);
    if (!(await p.isVisible('#ws'))) { await p.click('#best [data-act="ws-hist"]'); await wsWait(p); }
    // B: the Overview hero
    await p.click('#ws-tabs [data-v="overview"]'); await sleep(300);
    const hero = await p.evaluate(() => {
      const e = document.querySelector('#ws-body [data-aprhero]'), first = document.querySelector('#ws-body .ws-in').firstElementChild;
      return e && { first: first === e, big: e.querySelector('.aprh-big [data-roll="b"]').textContent, day: e.querySelector('.aprh-big small').textContent, tr: e.querySelector('.aprh-tr').textContent, bar: !!e.querySelector('.aprh-bar'), mini: [...e.querySelectorAll('.aprh-mini div')].map((d) => d.textContent), chip: document.querySelector('#ws-apr [data-roll="a"]').textContent };
    });
    ok(`apr ${tag}: B · Overview opens with the APR hero: big net APR ${hero && hero.big} with $/day, the trend vs its 7-day average, where the fee APR goes, Fee APR · 7D net · 30D net`,
      !!hero && hero.first && hero.big === hero.chip && /\/day$|not read yet|—/.test(hero.day) && /vs its 7-day average/.test(hero.tr) && hero.mini.length === 3 && /^Fee APR 24H/.test(hero.mini[0]) && /^7D net/.test(hero.mini[1]) && /^30D net/.test(hero.mini[2]), JSON.stringify(hero));
    await snap(p, `apr-${tag}-overview`);
    const ovB = await OVL(p, '[data-aprhero]'), ovA = await OVL(p, '#ws-head');
    ok(`apr ${tag}: A + B · no text on text in the workspace head or the hero`, ovA.length === 0 && ovB.length === 0, JSON.stringify([...ovA, ...ovB].slice(0, 3)));
    // C: a window switch rolls both from the old value to the new one
    const r1 = await p.evaluate(APR_ROLL, { sel: '#ws-win [data-w="7d"]' }), ra = rollOk(r1), rb = rollOk(r1, 2);
    ok(`apr ${tag}: C · 24H → 7D rolls the chip and the hero to the new value in under 1 s (${ra.at} / ${rb.at} ms), once`, (ra.ok || r1.seen[0][1] === r1.fin) && rb.ok && r1.fin === r1.finB && /NET APR · 7D/.test(await p.textContent('#ws-apr .k')), JSON.stringify([ra, rb, r1.seen.filter((s, i, a) => !i || s[1] !== a[i - 1][1]).slice(0, 12)]));
    const r2 = await p.evaluate(APR_ROLL, { sel: '#ws-tabs [data-v="liquidity"]' });
    ok(`apr ${tag}: C · a tab switch (same pool and window) draws it final: no roll`, new Set(r2.seen.map((s) => s[1])).size === 1, JSON.stringify(r2.seen.slice(0, 3)));
    await p.click('#ws-win [data-w="24h"]'); await sleep(900);
    // E: History's fourth chart (on a pool whose TVL is read day by day: a v4 pool's comes from its map, a few days only)
    if (gap) await wsHashOpen(p, gap.id, 'history'); else { await p.click('#ws-tabs [data-v="history"]'); await sleep(450); }
    const e1 = await p.evaluate(() => {
      const s = document.querySelector('#ws .hs-stack svg[data-k="a"]'), f = document.querySelector('#ws .hs-stack svg[data-k="f"]'), x = document.querySelector('#ws .hs-x');
      if (!s || !f) return null;
      const sr = s.getBoundingClientRect(), xr = x.getBoundingClientRect(), ax = [...s.querySelectorAll(':scope > text')].map((e) => e.textContent);
      return { n: +s.dataset.n, fn: +f.dataset.n, w: s.getAttribute('width'), fw: f.getAttribute('width'), ax, avg: +s.dataset.avg, bars: s.querySelectorAll('path.hs-b').length,
        cross: !x.hidden && xr.top <= sr.top + 0.5 && xr.bottom >= sr.bottom - 0.5, title: s.closest('.hs-ch').querySelector('.hs-ct').textContent, head: (document.querySelector('#ws [data-aprh]') || {}).textContent || '',
        card: (document.querySelector('#hs-card .hs-dv[data-k="a"]') || {}).textContent || '' };
    });
    ok(`apr ${tag}: E · a fourth synced chart "Fee APR a day" on the same days and width, its own % axis from 0% (${e1 && e1.ax.join(' ')}), a 7-day average line, the crosshair through it`,
      !!e1 && e1.n === e1.fn && e1.w === e1.fw && e1.ax[0] === '0%' && e1.ax.length >= 3 && e1.ax.every((a) => /%$/.test(a)) && e1.avg > 0 && e1.bars >= 1 && e1.cross && /Fee APR a day/.test(e1.title) && /7-day avg/.test(e1.title), JSON.stringify(e1));
    ok(`apr ${tag}: E · the range header "${e1 && e1.head}" and the day card's Fee APR`, !!e1 && /^(30D|90D|1Y|All|\d+D zoom) avg fee APR (—|[\d.,]+%) · now (—|[\d.,]+%)( [▲▼])?$/.test(e1.head) && /^Fee APR/.test(e1.card), JSON.stringify(e1 && [e1.head, e1.card]));
    if (SHOTS) { await p.evaluate(() => { const c = document.querySelector('#ws .hs-ch[data-k="a"]'); if (c && innerWidth < 700) c.scrollIntoView({ block: 'end' }); }); await sleep(250); await snap(p, `apr-${tag}-history`); await p.evaluate(() => { document.querySelector('#ws-body').scrollTop = 0; }); }
    const fit1 = await p.evaluate(APR_FIT), ov1 = [...await OVL(p, '#ws .hs-ctl'), ...await OVL(p, '#hs-card')];
    ok(`apr ${tag}: E · History: no sideways scroll, no text on text in the header or the day card`, fit1.page <= 1 && fit1.ws <= 1 && ov1.length === 0, JSON.stringify([fit1, ov1.slice(0, 2)]));
    // E: a pool with days not read: each is a gap labelled "not read", never 0%
    if (gap) {
      await wsHashOpen(p, gap.id, 'history');
      await p.click('#ws [data-act="ws-range"][data-v="90"]').catch(() => {}); await sleep(300);
      await p.focus('#ws .hs-stack'); await p.keyboard.press('End'); await sleep(80);
      const g = await p.evaluate(() => {
        const s = document.querySelector('#ws .hs-stack svg[data-k="a"]'), out = { gaps: s ? +s.dataset.gaps + +s.dataset.na : -1, lab: s ? s.querySelectorAll('text.hs-nrl').length : 0, days: 0, unread: 0, bad: [] };
        const st = document.querySelector('#ws .hs-stack'), n = +st.dataset.n;
        for (let i = 0; i < n; i++) {
          const v = (k) => { const e = document.querySelector(`#hs-card .hs-dv[data-k="${k}"] b`); return e ? e.textContent : null; };
          const f = v('f'), tv = v('tv'), a = v('a');
          if (f !== '—' || tv !== '—') {
            out.days++;
            const un = f === 'not read' || tv === 'not read' || tv === '—' || f === '—';
            if (un) { out.unread++; if (a !== 'not read' && a !== '—') out.bad.push(`${f}|${tv}|${a}`); } else if (!/%$/.test(a || '')) out.bad.push(`${f}|${tv}|${a}`);
          }
          st.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        }
        return out;
      });
      ok(`apr ${tag}: E · a day with its fees or TVL not read is a gap (${g.gaps} in the chart, ${g.lab} labelled "not read"), its card "not read", never 0% (${g.unread} of ${g.days} days)`, g.gaps >= 1 && g.unread >= 1 && g.days >= 30 && g.bad.length === 0, JSON.stringify(g).slice(0, 240));
    } else ok(`apr ${tag}: E · the fixtures hold a pool with a day not read`, false);
    // E: the tiers' chips: each with its fee APR over the range, one BEST
    if (multi) {
      await wsHashOpen(p, multi.id, 'history');
      const ch = await p.evaluate(() => ({ chips: [...document.querySelectorAll('#ws .hs-chip[data-act="ws-tier"]:not([data-v="all"])')].map((b) => ({ a: (b.querySelector('.hs-ca') || {}).textContent || null, best: !!b.querySelector('.hs-best'), v: b.querySelector('.hs-ca') ? b.querySelector('.hs-ca').dataset.ca : '' })) }));
      await snap(p, `apr-${tag}-tiers`);
      const nums = ch.chips.filter((c) => c.v !== '').map((c) => +c.v), top = Math.max(...nums), bests = ch.chips.filter((c) => c.best);
      ok(`apr ${tag}: E · each tier chip shows its fee APR over the range (${ch.chips.map((c) => c.a).join(', ')}), the top one tagged BEST`, ch.chips.length >= 2 && ch.chips.every((c) => c.a && (/%$/.test(c.a) || c.a === '—')) && (nums.length < 2 ? bests.length === 0 : bests.length === 1 && +bests[0].v === top), JSON.stringify(ch));
      // F: Compare's chips and the Pair table
      await p.click('#ws-tabs [data-v="pair"]'); await sleep(300);
      const pr = await p.evaluate(() => ({ rows: document.querySelectorAll('#ws .ws-pt tbody tr').length, a: document.querySelectorAll('#ws .ws-pt tbody tr [data-aprb]').length, ln: document.querySelectorAll('#ws .hs-stack svg[data-k="a"]').length }));
      await p.click('#ws-tabs [data-v="compare"]'); await sleep(300);
      const cp = await p.evaluate(() => ({ chips: document.querySelectorAll('#ws .ws-cc').length, a: document.querySelectorAll('#ws .ws-cc [data-aprb]').length, ln: document.querySelectorAll('#ws .hs-stack svg[data-k="a"]').length }));
      ok(`apr ${tag}: F · Pair rows (${pr.a}/${pr.rows}) and Compare chips (${cp.a}/${cp.chips}) carry an APR; both draw the fee APR line chart`, pr.rows >= 2 && pr.a === pr.rows && cp.chips >= 1 && cp.a === cp.chips && pr.ln === 1 && cp.ln === 1, JSON.stringify({ pr, cp }));
      await p.click('#ws-tabs [data-v="overview"]'); await sleep(300); // v0.7.2: Similar tiers wear the same badge, once a row
      const st = await p.evaluate(() => { const r = [...document.querySelectorAll('#ws-body .ws-tr')]; return { n: r.length, a: r.filter((x) => x.querySelectorAll('[data-aprb]').length === 1).length, twice: r.filter((x) => x.querySelectorAll('.apr-v').length > 1).length, net: r.filter((x) => /\bnet \S/.test(x.textContent)).length }; });
      ok(`apr ${tag}: F · Similar tiers: every row carries the APR badge, once (${st.a}/${st.n})`, st.n >= 2 && st.a === st.n && st.twice === 0 && st.net === 0, JSON.stringify(st));
      const z1 = await p.evaluate(APR_ZERO, '#ws');
      ok(`apr ${tag}: no 0% for an unread APR in the workspace`, z1.length === 0, z1.slice(0, 3).join(' | '));
    } else ok(`apr ${tag}: E · the fixtures hold a pair with two pools`, false);
    ok(`apr ${tag}: no page errors, no NaN`, t.errors.length === 0 && noJunk(await bodyText(p)), t.errors[0]);
    await t.ctx.close();
  }
  // C under reduced motion: the numbers appear at once
  const t = await openUnlocked(browser, 'default', { width: 1440, reducedMotion: 'reduce', win: '24h' }), p = t.page;
  const r = await p.evaluate(APR_ROLL, { sel: '#best [data-act="ws-hist"]' }); await wsWait(p);
  const r2 = await p.evaluate(APR_ROLL, { sel: '#ws-win [data-w="7d"]' });
  ok('apr reduced: C · under reduced motion the chip and the hero show their value at once (no roll) on open and on a window switch',
    new Set(r.seen.map((s) => s[1])).size === 1 && /%$|—/.test(r.fin) && new Set(r2.seen.map((s) => s[1])).size === 1 && /NET APR · 7D/.test(await p.textContent('#ws-apr .k')), JSON.stringify([r.seen.slice(0, 2), r2.seen.slice(0, 2)]));
  await t.ctx.close();
  // guests: the same APRs (market data), the $/day at the public $1,000
  const g = await unlockAs(browser, 'keyed', SHARED_PASS, { width: 1440 }), gp = g.page;
  await waitApp(gp); await gp.click('#gw-ok').catch(() => {}); await sleep(200);
  const gs = await gp.evaluate(() => { const e = document.querySelector('#next .aprb[data-aprb]:not([data-aprb=""])'); return e ? { v: +e.dataset.aprb, t: e.textContent } : null; });
  await gp.click('#best [data-act="ws-hist"]'); await wsWait(gp);
  const gc = await gp.evaluate(() => ({ chip: !!document.querySelector('#ws-apr .aprchip'), k: (document.querySelector('#ws-apr .k') || {}).textContent || '' }));
  const gm = gs && /(−)?\$([\d.,]+)\/day/.exec(gs.t), gw = gs ? (gs.v * 1000) / 365 : null;
  ok('apr guest: the APR badges and the chip work for a guest, the $/day at the public $1,000', !!gs && !!gm && Math.abs((gm[1] ? -1 : 1) * +gm[2].replace(/,/g, '') - gw) <= Math.max(0.006, Math.abs(gw) * 0.06) && gc.chip && /NET APR/.test(gc.k), JSON.stringify([gs, gc]));
  await g.ctx.close();
}

// ---------- v0.7.2 · F11: the error badge (a page error shows calmly by the version; its sheet lists them sanitized) ----------
const EB_PLANT = () => { // made-up values that must never reach the badge: an address, an amount, a long number, a URL query
  setTimeout(() => { throw new TypeError('pool 0x1234567890abcdef broke at $12,345 for 987654 units via https://example.test/a?pool=XYZ123&k=1'); }, 0);
  Promise.reject(new RangeError('second fault in the test'));
};
const EB_LEAK = /0x1234567890abcdef|\$12,345|12,345|987654|XYZ123|pool=/;
const EB_BADGE = () => {
  const w = document.querySelector('#ebw');
  if (!w) return { el: false };
  const r = w.getBoundingClientRect(), vis = !w.hidden && w.getClientRects().length > 0;
  const ctl = [...document.querySelectorAll('header button, header input, header a, #subhead button, #subhead a, #subhead [data-act]')].filter((e) => !w.contains(e) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const box = (e) => { const g = document.createRange(); g.selectNodeContents(e); const q = g.getBoundingClientRect(); return q.width > 0 && q.height > 0 ? q : e.getBoundingClientRect(); }; // what shows (a control's tap box may reach past it, as the page's do)
  const hit = vis ? ctl.filter((e) => { const q = box(e); return q.width > 0 && q.height > 0 && q.left < r.right - 0.5 && q.right > r.left + 0.5 && q.top < r.bottom - 0.5 && q.bottom > r.top + 0.5; }).map((e) => e.id || e.className || e.tagName) : [];
  const cover = vis ? ctl.filter((e) => { const q = box(e); if (!q.width || q.top < 0 || q.top > innerHeight) return false; const x = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return x && w.contains(x); }).map((e) => e.id || e.className) : [];
  return { el: true, vis, text: w.textContent.replace(/\s+/g, ' ').trim(), right: Math.round(r.right), vw: innerWidth, h: Math.round(r.height), hit, cover, sx: document.documentElement.scrollWidth - innerWidth };
};
const EB_SHEET = () => {
  const sh = document.querySelector('#ebsheet'), li = [...sh.querySelectorAll('#eb-list li')], c = document.querySelector('#eb-close').getBoundingClientRect(), k = document.querySelector('.eb-card').getBoundingClientRect();
  return { open: !sh.hidden, n: li.length, kinds: li.map((l) => l.querySelector('.eb-k').textContent), areas: li.map((l) => l.querySelector('.eb-a').textContent), msgs: li.map((l) => l.querySelector('.eb-m').textContent),
    txt: sh.textContent, close: [Math.round(c.width), Math.round(c.height)], fit: k.left >= -0.5 && k.right <= innerWidth + 0.5, focus: (document.activeElement || {}).id || '' };
};
const ebOk = (b) => b.vis && /Something went wrong · details/.test(b.text) && b.hit.length === 0 && b.cover.length === 0 && b.right <= b.vw && b.sx <= 1;
async function testErrBadge(browser) {
  const SETS = BROWSER === 'webkit' ? [['phone', { phone: true, mode: '3d' }], ['w1440', { width: 1440, mode: '2d' }]] : [['w393', { width: 393, height: 852, mode: '2d' }], ['w1440', { width: 1440, mode: '3d' }]];
  for (const [tag, o] of SETS) {
    const look = o.mode.toUpperCase(), t = await openUnlocked(browser, 'default', o), p = t.page;
    const b0 = await p.evaluate(EB_BADGE);
    ok(`errbadge ${tag} ${look}: a normal load shows no error badge`, b0.el && !b0.vis, JSON.stringify(b0));
    await p.evaluate(EB_PLANT); await sleep(300);
    const b1 = await p.evaluate(EB_BADGE);
    ok(`errbadge ${tag} ${look}: an uncaught error and a rejection show "⚠ Something went wrong · details" by the version, covering no control, inside the screen`, ebOk(b1), JSON.stringify(b1));
    await snap(p, `errbadge-${tag}-badge`);
    await p.click('#eb-open'); await sleep(250);
    const s1 = await p.evaluate(EB_SHEET);
    ok(`errbadge ${tag} ${look}: the sheet lists both (${s1.kinds.join(', ')}) with the time, the kind, the area and a short message`, s1.open && s1.n === 2 && s1.kinds.includes('TypeError') && s1.kinds.includes('RangeError') && s1.areas.every((a) => a.length > 0) && s1.msgs.every((m) => m.length > 0 && m.length <= 120) && s1.fit, JSON.stringify(s1));
    ok(`errbadge ${tag} ${look}: the planted address, amount, long number and URL query never show`, !EB_LEAK.test(s1.txt) && /0x…/.test(s1.txt) && /\$…/.test(s1.txt), s1.msgs.join(' | ').slice(0, 160));
    ok(`errbadge ${tag} ${look}: Close is 44 px or more and takes the focus`, s1.close[0] >= 44 && s1.close[1] >= 44 && s1.focus === 'eb-close', JSON.stringify([s1.close, s1.focus]));
    await snap(p, `errbadge-${tag}-sheet`);
    await p.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (x) => { window.__ebCopied = String(x); } } }); });
    await p.click('#eb-copy'); await sleep(150);
    const cp = await p.evaluate(() => ({ t: window.__ebCopied || '', b: document.querySelector('#eb-copy').textContent }));
    ok(`errbadge ${tag} ${look}: "Copy for the admin" copies the sanitized list`, cp.b === 'Copied' && /TypeError/.test(cp.t) && /RangeError/.test(cp.t) && !EB_LEAK.test(cp.t) && cp.t.split('\n').length === 3, JSON.stringify({ b: cp.b, n: cp.t.split('\n').length, leak: EB_LEAK.test(cp.t) }));
    await p.keyboard.press('Escape'); await sleep(150);
    const esc1 = await p.evaluate(() => document.querySelector('#ebsheet').hidden);
    await p.click('#eb-open'); await sleep(200); await p.evaluate(() => history.back()); await sleep(450);
    const back = await p.evaluate(() => ({ hid: document.querySelector('#ebsheet').hidden, app: !document.querySelector('#app').hidden, badge: !document.querySelector('#ebw').hidden }));
    await p.click('#eb-open'); await sleep(200); await p.mouse.click(4, 4); await sleep(200);
    const scrim = await p.evaluate(() => document.querySelector('#ebsheet').hidden);
    await p.click('#eb-open'); await sleep(200); await p.click('#eb-close'); await sleep(200);
    const cl = await p.evaluate(() => document.querySelector('#ebsheet').hidden);
    ok(`errbadge ${tag} ${look}: the sheet closes with Esc, the browser's Back (staying on the dashboard), the dimmed background and Close`, esc1 && back.hid && back.app && back.badge && scrim && cl, JSON.stringify({ esc1, back, scrim, cl }));
    await p.click('#ebw .ebx'); await sleep(150);
    const d1 = await p.evaluate(EB_BADGE);
    await p.evaluate(() => { setTimeout(() => { throw new Error('a third fault'); }, 0); }); await sleep(250);
    const d2 = await p.evaluate(EB_BADGE);
    ok(`errbadge ${tag} ${look}: dismissed, it goes; a new error brings it back`, !d1.vis && ebOk(d2), JSON.stringify([d1.vis, d2.vis]));
    // no loops: a fault inside the badge's own code switches it off; later errors don't recurse or pile up
    await p.evaluate(() => { const l = document.querySelector('#eb-list'); l.remove(); });
    await p.click('#eb-open').catch(() => {}); await sleep(150);
    await p.evaluate(() => { for (let i = 0; i < 5; i++) setTimeout(() => { throw new Error('fault ' + i); }, 0); }); await sleep(300);
    const lp = await p.evaluate(() => ({ badge: !document.querySelector('#ebw').hidden, sheet: !document.querySelector('#ebsheet').hidden, alive: 1 + 1 }));
    ok(`errbadge ${tag} ${look}: a fault inside the badge turns it off quietly (no loop, the page keeps working)`, !lp.badge && !lp.sheet && lp.alive === 2, JSON.stringify(lp));
    await t.ctx.close();
  }
  // a guest sees it the same way
  const g = await unlockAs(browser, 'keyed', SHARED_PASS, { width: 393, height: 852 }), gp = g.page;
  await waitApp(gp); await gp.click('#gw-ok').catch(() => {}); await sleep(200);
  const g0 = await gp.evaluate(EB_BADGE);
  await gp.evaluate(EB_PLANT); await sleep(300);
  const g1 = await gp.evaluate(EB_BADGE);
  await gp.click('#eb-open'); await sleep(250);
  const gs = await gp.evaluate(EB_SHEET);
  ok('errbadge guest: no badge on a normal load; an error shows the same badge and sanitized sheet', !g0.vis && ebOk(g1) && gs.open && gs.n === 2 && !EB_LEAK.test(gs.txt), JSON.stringify([g0.vis, g1, gs.n]));
  await g.ctx.close();
}

const groups = { unlock: testUnlock, layout: testLayout, windows: testWindows, states: testStates, tabs: testTabs, daily: testDaily, pairs: testPairs, charts: testCharts, pan: testPan, depth: testDepth, history: async (b) => { await testHistory(b); if (!(BROWSER === 'webkit' && MODE === '3d' && !opt('only'))) await testWsHistory(b); else console.log('  · history (workspace): in the WebKit 2D job'); }, stable: testStable, touch: testTouch, sheets: testSheets, sticky: testSticky, top: testTop, header: testHeader, zoomfit: testZoomFit, overlap: testOverlap, rows: testRows, refresh: testRefresh, market: testMarket, fav: testFav, table: testTable2, similar: testSimilar, chains: testChains, highlight: testHighlight, search: testSearch, links: testLinks, terms: testTerms, fold: testFold, locknote: testLockNote, clicks: testClicks, motion: testMotion, merge: testMerge, feebar: testFeeBar, stablewalk: testStableWalk, flash: testFlash, dates: testDates, feescale: testFeeScale, perday: testPerDay, disc: testDisc, view: testView , balance: testBalance, wraps: testWraps, floorlab: testFloorLab, iphone: testIphone, back: testBack, pull: testPull, full: testFull, way: async (b) => { await testWay(b); await testWayWs(b); }, qsearch: testQsearch, stress: testStress,
  workspace: testWorkspace, compare: testCompare, deeplink: testDeeplink, tiers: testTiers, tools: testTools,
  guest: testGuest, member: testMember, guestend: testGuestEnd, guestadmin: testGuestAdmin, recovery: testRecovery, passchange: testPassChange, mismatch: testMismatch, histbtn: testHistBtn, apr: testApr, errbadge: testErrBadge }; // v0.7.0 // v0.6.0 (the history group adds the workspace's History, way the workspace's ways out)
const WK_2D_ONLY = new Set(['iphone', 'full', 'way', 'qsearch', 'stress', 'compare', 'deeplink', 'tiers', 'guest', 'member', 'guestend', 'guestadmin', 'recovery', 'passchange', 'mismatch', 'histbtn', 'apr', 'errbadge']); // look-independent (histbtn walks both looks in the WebKit 2D job) (the fit, the full view, the ways out)
const REPEAT = Math.max(1, Math.min(9, +opt('repeat', 1) || 1)); // --repeat N: the groups N times over (hunting a timing fault)
try {
  for (let rep = 0; rep < REPEAT; rep++) for (const g of ONLY) {
    if (!groups[g]) continue;
    // the WebKit 3D job also runs the live audit and ends within a minute or two of its time limit: checks that don't
    // depend on the look run on WebKit in its 2D job (the same iPhone), unless asked for by name
    if (BROWSER === 'webkit' && MODE === '3d' && !opt('only') && WK_2D_ONLY.has(g)) { console.log(`  · ${g}: in the WebKit 2D job`); continue; }
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
console.log(`site-test ${BROWSER}${DEVICE ? ' as ' + DEVICE : ''}${MODE ? ' · ' + MODE.toUpperCase() : ''}: ${results.length} checks · ${fails.length} fail · widths ${[...WIDTHS, ...LAPTOP].join('/') || '-'} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(fails.length ? 1 : 0);
