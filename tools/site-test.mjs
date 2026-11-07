#!/usr/bin/env node
// Browser tests for the dashboard (site/app/index.html) on made-up, sealed fixture data.
// Prints pass/fail, counts and timings only: the fixtures are made up, but the habit stays.
//
//   node tools/site-test.mjs                         Chromium, widths 360…1920 plus reduced motion
//   node tools/site-test.mjs --browser webkit --device "iPhone 15"     phone = that device; laptop 1440
//   node tools/site-test.mjs --shots <dir>           also save full-page screenshots (cut into parts)
//   node tools/site-test.mjs --only unlock,layout    run some groups: unlock layout windows states tabs daily pairs charts pan depth sheets sticky top zoomfit rows refresh clicks motion
//   node tools/site-test.mjs --page <file>          test another copy of the page (planted faults)
//   node tools/site-test.mjs --verbose              also list every passing check
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
import { writeFixtures, makeData, FIXTURE_PASSPHRASE } from './fixtures/make-fixture.mjs';

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
const ONLY = (opt('only') || 'unlock,layout,windows,states,tabs,daily,pairs,charts,pan,depth,sheets,sticky,top,zoomfit,rows,refresh,clicks,motion').split(',');
const WIDTHS = DEVICE ? [] : [360, 375, 390, 430, 768, 1024, 1300, 1440, 1920];
const LAPTOP = DEVICE ? [768, 1440] : [];

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
async function newPage(browser, { phone = false, width = 390, height = 860, reducedMotion = 'no-preference', storage = null } = {}) {
  const base = phone && DEVICE ? { ...pw.devices[DEVICE] } : { viewport: phone ? { width: 390, height: 844 } : { width, height } }; // phone = 390 px here, the device in Actions
  if (BROWSER !== 'chromium') delete base.defaultBrowserType;
  const ctx = await browser.newContext({ ...base, reducedMotion });
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await ctx.addInitScript(() => { window.open = (u) => { (window.__opened ||= []).push(String(u)); return null; }; }); // "open in a new window" is recorded, not opened
  const page = await ctx.newPage();
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
  await page.click('#lockbtn');
  await page.waitForSelector('#lockscreen:not([hidden])');
  ok('lock: "lock this device" removes every number', !(await page.isVisible('#app')) && !(await domText(page)).includes('VELNA'));
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
  for (const el of document.querySelectorAll('#app *, header *, footer *, #banner')) {
    if (!vis(el) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg')) continue; // an svg's own box counts, its insides don't
    const r = el.getBoundingClientRect();
    if (!inScroll(el) && (r.right > vw + 1 || r.left < -1)) out.offRight.push(name(el));
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), mono = /mono/i.test(cs.fontFamily);
      if (fs < 10 || (fs < 12 && !mono)) out.small.push(name(el) + ' ' + fs + 'px');
      if ((cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1 && !(el.classList.contains('pn') && el.textContent.length > 16)) out.clipped.push(name(el));
    }
    if (el.matches('button, select, input, [role="button"]') && el.getBoundingClientRect().height < 43.5) out.short.push(name(el) + ' ' + Math.round(r.height) + 'px');
  }
  // labels and headings must not be hidden under something else
  const labels = [...document.querySelectorAll('#app .lbl, #app h2, #app h3, #app .chip, header .lbl, header h1')].filter((el) => vis(el) && !el.closest('tbody, .tbl-box'));
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
  await t.page.fill('#f-q', 'onerror');
  await sleep(300);
  ok('planted: an HTML ticker is printed as text, never run', (await t.page.evaluate(() => window.__xss)) === undefined && (await t.page.$$('#app img')).length === 0);
  ok('planted: …and shows up literally in the table', (await t.page.innerText('#all tbody')).includes('<img src=x'));
  await t.page.fill('#f-q', 'TALI');
  await sleep(300);
  await t.page.fill('#f-q', '');
  await sleep(300);
  if (await t.page.isVisible('#all-more button')) { await t.page.click('#all-more button'); await sleep(200); }
  for (const wk of ['24h', '7d', '30d']) {
    await setWin(t.page, wk);
    const gems = await t.page.evaluate(() => ({ head: +((document.querySelector('#next .sub').textContent.match(/(\d+) gems?/) || [])[1]), pills: document.querySelectorAll('#all tbody .pill.gem').length }));
    ok(`planted ${wk}: the gem count never includes an unverified pool`, gems.head === gems.pills, `${gems.head} vs ${gems.pills}`);
  }
  await t.page.fill('#f-q', 'TALI');
  await sleep(300);
  for (const wk of ['24h', '7d', '30d']) {
    await setWin(t.page, wk);
    ok(`planted ${wk}: an unverified pool is never the best find`, (await t.page.textContent('#best h2')) !== 'TALI/WETH');
    ok(`planted ${wk}: …and carries UNVERIFIED with a void score`, (await t.page.innerText('#all tbody')).includes('UNVERIFIED') && (await t.page.$$('#all tbody .pill.void')).length > 0);
  }
  for (const [q, cols] of [['ZINTH', ['tvl', 'room', 'net']], ['CALDO', ['sigma', 'range', 'lvr', 'net']], ['BRISK', ['feeApr', 'net', 'aggApr']], ['LOMA', ['room', 'parked', 'net']]]) {
    await t.page.fill('#f-q', q);
    await sleep(300);
    const cells = await t.page.evaluate((cols) => {
      const keys = [...document.querySelectorAll('#all thead button')].map((b) => b.dataset.k), tr = document.querySelector('#all tbody tr');
      return cols.map((k) => tr && tr.children[keys.indexOf(k)] ? tr.children[keys.indexOf(k)].textContent.trim() : '?');
    }, cols);
    ok(`missing is never zero: ${q} shows — for ${cols.join(', ')}`, cells.every((c) => c === '—'), cells.join(' '));
  }
  await t.page.fill('#f-q', '');
  await setWin(t.page, '24h');
  ok('states: a not-checked pool may be a gem, tagged NOT CHECKED', (await t.page.textContent('#best h2')) === 'NUMA/USDC' && (await t.page.innerText('#best')).includes('NOT CHECKED'));
  await setWin(t.page, '30d');
  await t.page.fill('#f-q', 'PRAXO');
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
    await p.fill('#f-q', 'VELNA');
    await sleep(300);
    await p.click('#all tbody tr.row td:nth-child(3)');
    await p.waitForSelector('#sheet:not([hidden])');
    await p.click('#sheet-pair');
    await sleep(150);
    ok(`pairs ${tag}: a pool's detail links to its pair view`, (await p.textContent('#sheet-title')) === 'VELNA/WETH' && (await p.$$('#sheet tr[data-act="pair-row"]')).length === 4);
    await p.click('#sheet-close');
    // a pool with no data in this window opens from the pair view with dashes (it used to throw in the best-find card)
    await p.fill('#f-q', 'PRAXO');
    await sleep(300);
    await p.click('#all tbody tr.row td:nth-child(3)');
    await p.waitForSelector('#sheet:not([hidden])');
    await p.click('#sheet-pair');
    await sleep(150);
    const bare = await p.evaluate(() => { const r = [...document.querySelectorAll('#sheet tr[data-act="pair-row"]')].find((x) => /NO 30D DATA/.test(x.innerText)); return r ? r.dataset.id : null; });
    if (bare) { await p.evaluate((id) => document.querySelector(`#sheet tr[data-id="${id}"]`).click(), bare); await sleep(1400); }
    const card = await p.innerText('#best');
    ok(`pairs ${tag}: a pool with no data in the window opens from the pair view, with dashes`, !!bare && t.errors.length === 0 && /NO 30D DATA/.test(card) && noJunk(card), bare ? t.errors[0] : 'no such row');
    await p.fill('#f-q', '');
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
    await press('[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); await sleep(100);
    ok(`charts ${tag}: reset, then − zooms out to ±90%`, (await span()) === '90');
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
const pzView = (page, id) => page.evaluate((id) => { const h = document.querySelector(`[data-pz="${id}"]`); if (!h) return null; const [c, w, y] = h.dataset.view.split(',').map(Number); return { c, w, y }; }, id);
async function pzBox(page, id) {
  await page.evaluate((id) => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector(`[data-pz="${id}"]`).scrollIntoView({ block: 'center' }); }, id);
  await sleep(80);
  return page.locator(`[data-pz="${id}"]`).boundingBox();
}
// a mouse drag across a chart (pointer events, as a finger gives them): dx, dy in px; `up: false` keeps the button down
async function pzDrag(page, id, dx, { dy = 0, steps = 10, ms = 16, y = 0.5, up = true, settle = 650, hold = 0 } = {}) {
  const b = await pzBox(page, id), x0 = b.x + b.width / 2, y0 = b.y + b.height * y;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x0 + (dx * i) / steps, y0 + (dy * i) / steps); await sleep(ms); }
  if (hold) await sleep(hold); // the finger stops before it lifts: no flick
  if (up) { await page.mouse.up(); if (settle) { await sleep(Math.min(settle, 250)); await pzSettled(page, id); } }
}
// wait until a chart's view has come to rest (CI browsers can draw slowly: never trust a fixed sleep for motion)
async function pzSettled(page, id, ms = 3000) {
  let a = await pzView(page, id);
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    await sleep(150);
    const b = await pzView(page, id);
    if (a && b && b.c === a.c && b.w === a.w && b.y === a.y) return b;
    a = b;
  }
  return a;
}
const wheel = (page, id, dx, dy) => page.evaluate(({ id, dx, dy }) => { const h = document.querySelector(`[data-pz="${id}"]`), r = h.getBoundingClientRect(); h.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: dy, clientX: r.left + r.width / 2, clientY: r.top + 60, bubbles: true, cancelable: true })); }, { id, dx, dy });
const pzClick = (page, sel) => page.evaluate((sel) => { window.dispatchEvent(new WheelEvent('wheel')); const b = document.querySelector(sel); b.scrollIntoView({ block: 'center' }); b.click(); }, sel);
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const SPAN = 0.6375; // the fixture's depthSpan: 48 fine bars across ±0.45, five coarse ones a side out to ±0.6375
async function testPan(browser) {
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    // the liquidity chart: the bars reach ±64% (coarser past ±45%), so at its ±45% default a drag shows more; past the
    // last bars it rubber-bands over a "no data" hatch, then springs back to the data's edge
    const ta = await p.$eval('[data-pz="liq-best"]', (h) => getComputedStyle(h).touchAction);
    ok(`pan ${tag}: charts pan sideways and leave vertical swipes and pinch to the page (touch-action ${ta})`, /pan-y/.test(ta) && /pinch-zoom/.test(ta));
    let v = await pzView(p, 'liq-best');
    ok(`pan ${tag}: the liquidity chart opens on the price, ±45% wide`, near(v.c, 0) && near(v.w, 0.9), JSON.stringify(v));
    const edge0 = -SPAN + 0.45; // the view's centre can go no lower
    await pzDrag(p, 'liq-best', phone ? 140 : 260, { up: false });
    await sleep(60);
    const mid = await pzView(p, 'liq-best'), hatch = await p.$$eval('[data-pz="liq-best"] .pz-end', (e) => e.length);
    await p.mouse.up();
    v = await pzSettled(p, 'liq-best');
    ok(`pan ${tag}: the bars past ±45% are reachable, and past them a drag rubber-bands over a "no data" hatch, then springs back`, mid.c < edge0 - 0.005 && hatch > 0 && near(v.c, edge0, 2e-3), `${mid.c} ${hatch} ${v.c}`);
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]'); await sleep(150);
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
    const f2 = await pzSettled(p, 'liq-best', 5000), lo = -SPAN + 0.12; // the left limit at ±12% for the map's span
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
    ok(`pan ${tag}: a zoomed scatter takes drags both ways (touch-action pinch-zoom)`, (await p.$eval('[data-pz="scatter"]', (h) => getComputedStyle(h).touchAction)) === 'pinch-zoom');
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

// ---------- 4f2. the liquidity chart's wider bins: depthStep, depthSpan, unread bars, beyond buckets ----------
async function testDepth(browser) {
  const { live } = makeData({ now: Date.now() });
  for (const phone of [true, false]) {
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 }), p = t.page, tag = phone ? 'phone' : 'laptop';
    const pick = async (pair) => { await p.evaluate((pair) => { window.dispatchEvent(new WheelEvent('wheel')); [...document.querySelectorAll('#best [role="tab"]')].find((e) => e.querySelector('.tn').textContent === pair).click(); }, pair); await sleep(150); };
    const look = () => p.evaluate(() => {
      const h = document.querySelector('[data-pz="liq-best"]'), hr = h.getBoundingClientRect();
      const bars = [...h.querySelectorAll('svg path')].map((x) => x.getAttribute('d')).join('');
      const widths = [...bars.matchAll(/h(\d+(?:\.\d+)?)v/g)].map((m) => +m[1]);
      return { view: h.dataset.view, edges: [...h.querySelectorAll(':scope > .pz-edge:not([hidden])')].length, by: [...h.querySelectorAll('.bylab')].map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent, inside: r.left >= hr.left - 1 && r.right <= hr.right + 1 }; }),
        mlab: [...h.querySelectorAll('.mlab')].map((e) => e.textContent), widths, legend: h.closest('[data-chartbox]').querySelector('.legend').innerText, unread: h.querySelectorAll('rect.unread').length };
    });
    let a = await look();
    ok(`depth ${tag}: the default view is ±45% around the price, with more to see both ways`, /^0\.0000,0\.9000$/.test(a.view) && a.edges === 2, a.view + ' ' + a.edges);
    ok(`depth ${tag}: the legend names what lies past the bars, in dollars`, /Past the bars: \$[\d.]+[KM]? further down · \$[\d.]+[KM]? further up/.test(a.legend), a.legend.slice(-60));
    await pzClick(p, '[data-act="zoom"][data-chart="liq-best"][data-dir="-1"]'); await sleep(150);
    a = await look();
    const ws = [...new Set(a.widths.map((x) => Math.round(x)))].sort((x, y) => x - y);
    ok(`depth ${tag}: zoomed out to ±90%, both "beyond" buckets are labelled at the data's edges, inside the chart`, a.by.length === 2 && a.by.every((b) => /beyond/.test(b.t) && b.inside), JSON.stringify(a.by));
    ok(`depth ${tag}: …and the coarse bars past ±45% are drawn twice as wide as the fine ones`, ws.length >= 2 && Math.abs(ws[ws.length - 1] / ws[0] - 2) < 0.35, ws.join(','));
    await pzClick(p, '[data-act="zreset"][data-chart="liq-best"]'); await sleep(150);
    // KOVA: 40% of its parked value above sits past ±45%; the "parked" label reads the fine bars only
    await pick('KOVA/WETH');
    const kid = await p.getAttribute('#best [data-act="detail"]', 'data-id'), kp = live.pools.find((x) => x.id === kid);
    const r30 = kp.w['30d'].range, fineUp = kp.shape.depth.filter(([o, v]) => o > r30 + 1e-9 && o <= 0.45 && v != null).reduce((s2, d) => s2 + d[1], 0);
    const allUp = kp.shape.depth.filter(([o, v]) => o > r30 + 1e-9 && v != null).reduce((s2, d) => s2 + d[1], 0);
    a = await look();
    const parsed = (txt) => { const m = /\$([\d.]+)([KM]?)/.exec(txt || ''); return m ? +m[1] * ({ K: 1e3, M: 1e6 }[m[2]] || 1) : null; };
    const up = parsed(a.mlab.find((x) => /parked/.test(x) && a.mlab.length) && a.mlab[a.mlab.length - 1]);
    ok(`depth ${tag}: the default view's "parked" label counts the ±45% bars only (KOVA)`, up != null && Math.abs(up - fineUp) / fineUp < 0.06 && Math.abs(up - allUp) / allUp > 0.15, `${up} vs fine ${Math.round(fineUp)} / all ${Math.round(allUp)}`);
    for (let k = 0; k < 6 && (await p.isVisible('[data-pz="liq-best"] > .pz-edge.r')); k++) { await pzClick(p, '[data-pz="liq-best"] > .pz-edge.r'); await sleep(phone ? 380 : 380); }
    a = await look();
    ok(`depth ${tag}: panned to the right end the view stops at the last bar (+${SPAN})`, near(+a.view.split(',')[0], SPAN - 0.45, 2e-3), a.view);
    // QUARX: its map is unread from the fourth coarse bar up: a hatch and "— beyond", never a bar of 0
    await p.fill('#f-q', 'QUARX'); await sleep(300);
    await p.click('#all tbody tr.row td:nth-child(3)');
    await p.waitForSelector('#sheet:not([hidden])'); await sleep(300);
    await p.evaluate(() => document.querySelector('#sheet [data-act="zoom"][data-chart="liq-detail"][data-dir="-1"]').click()); await sleep(150);
    for (let k = 0; k < 6 && (await p.isVisible('[data-pz="liq-detail"] > .pz-edge.r')); k++) { await p.evaluate(() => document.querySelector('[data-pz="liq-detail"] > .pz-edge.r').click()); await sleep(380); }
    const q = await p.evaluate(() => { const h = document.querySelector('[data-pz="liq-detail"]'); return { unread: h.querySelectorAll('rect.unread').length, by: [...h.querySelectorAll('.bylab')].map((e) => e.textContent), legend: h.closest('[data-chartbox]').querySelector('.legend').innerText }; });
    ok(`depth ${tag}: unread bars are hatched and the unread "beyond" reads —, never 0`, q.unread === 2 && q.by.some((x) => /^— beyond/.test(x)) && /Not read/.test(q.legend) && !/\$0 /.test(q.by.join(' ')), JSON.stringify(q));
    await p.click('#sheet-close'); await p.fill('#f-q', '');
    // old data without depthStep/depthSpan still draws (the closest spacing, half a bin past the outer bars)
    ok(`depth ${tag}: no page errors`, t.errors.length === 0, t.errors[0]);
    await t.ctx.close();
  }
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
  const sc = box.closest('.sheet-body'), top = sc ? sc.getBoundingClientRect().top : 0;
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
    await sleep(150);
    let s = await p.evaluate(STICKY, '#all-box');
    ok(`sticky ${tag}: no header copy at the top of the page`, !s.on);
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); const r = document.querySelector('#all-tbl tbody tr:nth-child(10)'); scrollTo(0, scrollY + r.getBoundingClientRect().top - 120); });
    await sleep(200);
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
    await sleep(250);
    ok(`sticky ${tag}: sorting from the stuck header sorts the table`, before === 'none' && (await p.getAttribute('#all-tbl thead th:nth-child(3)', 'aria-sort')) !== 'none' && (await p.evaluate(STICKY, '#all-box')).on);
    // at the end of the table it leaves with the table: never over what follows
    await p.evaluate(() => { const b = document.querySelector('#all-box').getBoundingClientRect(); scrollTo(0, scrollY + b.bottom - 30); });
    await sleep(200);
    s = await p.evaluate(STICKY, '#all-box');
    ok(`sticky ${tag}: at the table's end the header goes with it, never past it`, !s.on || s.bottom <= s.boxBottom + 1, JSON.stringify(s));
    await p.evaluate(() => { const b = document.querySelector('#all-box').getBoundingClientRect(); scrollTo(0, scrollY + b.bottom + 40); });
    await sleep(200);
    ok(`sticky ${tag}: past the table no header copy is left behind`, !(await p.evaluate(STICKY, '#all-box')).on);
    await p.evaluate(() => scrollTo(0, 0)); await sleep(200);
    ok(`sticky ${tag}: back at the top it is gone (not stuck)`, !(await p.evaluate(STICKY, '#all-box')).on);
    // the detail panel's long "every window" table sticks inside the panel's own scroll
    await p.click('#best [data-act="detail"]');
    await p.waitForSelector('#sheet:not([hidden])'); await sleep(320);
    const wsel = '#sheet-body .tbl-box:not(.sh-in) > .wtbl';
    await p.evaluate((sel) => { const b = document.querySelector('#sheet-body'), tb = document.querySelector(sel).closest('.tbl-box'), r = tb.querySelector('tbody tr:nth-child(8)').getBoundingClientRect(); b.scrollTop += r.top - b.getBoundingClientRect().top - 40; }, wsel);
    await sleep(200);
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
async function testTop(browser) {
  for (const [tag, o] of [['phone', { phone: true }], ['laptop', { width: 1440 }], ['phone reduced', { phone: true, reducedMotion: 'reduce' }]]) {
    const t = await openUnlocked(browser, 'default', o), p = t.page;
    let b = await p.evaluate(TOTOP);
    ok(`top ${tag}: no ↑ button at the top of the page`, !b.on);
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, innerHeight * 0.5); });
    await sleep(350);
    ok(`top ${tag}: …nor half a screen down`, !(await p.evaluate(TOTOP)).on);
    await p.evaluate(() => scrollTo(0, innerHeight * 1.6));
    await sleep(350);
    b = await p.evaluate(TOTOP);
    ok(`top ${tag}: after a screen a round ↑ button appears, 44×44, inside the screen`, b.on && b.w >= 44 && b.h >= 44 && b.inside && b.label === 'Back to top', JSON.stringify(b));
    if (SHOTS && tag !== 'phone reduced') await p.screenshot({ path: path.join(SHOTS, `totop-${tag}.png`) });
    await p.click('#totop');
    if (/reduced/.test(tag)) { await sleep(60); ok(`top ${tag}: under reduced motion it jumps to the top at once`, (await p.evaluate(() => scrollY)) === 0); }
    else { await p.waitForFunction(() => scrollY === 0, null, { timeout: 4000 }).catch(() => {}); ok(`top ${tag}: it scrolls smoothly back to the top`, (await p.evaluate(() => scrollY)) === 0); }
    await sleep(350);
    ok(`top ${tag}: …and hides again`, !(await p.evaluate(TOTOP)).on);
    // at the very bottom of the page the button covers no control (the footer keeps room for it)
    await p.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); scrollTo(0, document.documentElement.scrollHeight); });
    await sleep(400);
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
      ['by a number', '#all tbody tr.row td:nth-child(4)'], ['by a tag', '#all tbody tr.row .tag'], ['a next-best row', '#next .nb-row'],
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
    await p.fill('#f-q', 'ORVO');
    await sleep(300);
    await tap('#all tbody tr.row td:nth-child(2)');
    await sleep(400);
    ok(`rows ${tag}: a pool with no fees in 30 days opens and says so`, (await p.isVisible('#sheet')) && /no fees in \d+ days/i.test(await p.innerText('#sheet .daily')));
    await close();
    await p.fill('#f-q', '');
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
    const el = [...document.querySelectorAll('[data-act]')].find((e) => sigOf(e) === sig && !e.disabled && e.getBoundingClientRect().width > 0 && e.offsetParent !== null);
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
      const handle = await p.evaluateHandle((sig) => [...document.querySelectorAll('[data-act]')].find((e) => (e.dataset.act + (e.dataset.w ? ':' + e.dataset.w : '') + (e.dataset.k ? ':' + e.dataset.k : '') + (e.dataset.to ? ':' + e.dataset.to : '') + (e.dataset.chart ? ':' + e.dataset.chart : '') + (e.dataset.dir ? ':' + e.dataset.dir : '')) === sig && !e.disabled && e.offsetParent !== null), real);
      if (act === 'lens' || act === 'chain') {
        const v = await handle.evaluate((s) => s.options[Math.min(1, s.options.length - 1)].value);
        await handle.asElement().selectOption(v);
      } else if (act === 'search') await handle.asElement().fill('VEL');
      else if (act === 'scrub') await handle.evaluate((s) => { s.value = String(Math.max(1, Math.floor(+s.max / 2))); s.dispatchEvent(new Event('input', { bubbles: true })); });
      else await handle.asElement().click();
      await sleep(act === 'jump' || act === 'bt-row' ? 1400 : act === 'play' ? 800 : 350);
      const mut = await p.evaluate(() => window.__mut);
      let good = mut > 0;
      if (act === 'jump') good = await headingInView(p, real.split(':')[1]);
      if (act === 'openchart') {
        const u = await p.evaluate(() => (window.__opened || []).slice(-1)[0] || '');
        const want = real.split(':')[1];
        good = new RegExp(`[?&]view=${want}(&|$)`).test(u) && /[?&]w=(24h|7d|30d)/.test(u) && /[?&]z=\d/.test(u) && (['scatter', 'health'].includes(want) || /[?&]pool=[0-9a-fx]+/.test(u));
      }
      if (act === 'detail' || act === 'pair') { good = await p.isVisible('#sheet'); if (good) { done.add('close-detail'); await p.click('#sheet-close'); await sleep(200); good = !(await p.isVisible('#sheet')); } }
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
  await m.page.click('#rp-play');
  await sleep(900);
  const w = await m.page.evaluate(() => { const s = document.querySelector('#rp-scrub'); return [+s.value, +s.max]; });
  ok('motion: otherwise the replay plays as a time-lapse', w[0] > 1 && w[0] < w[1], w.join('/'));
  await m.ctx.close();
}

// ---------- run ----------
const t0 = Date.now();
writeFixtures(FX);
const srv = await serve();
ORIGIN = `http://127.0.0.1:${srv.address().port}`;
const browser = await pw[BROWSER].launch();
const groups = { unlock: testUnlock, layout: testLayout, windows: testWindows, states: testStates, tabs: testTabs, daily: testDaily, pairs: testPairs, charts: testCharts, pan: testPan, depth: testDepth, sheets: testSheets, sticky: testSticky, top: testTop, zoomfit: testZoomFit, rows: testRows, refresh: testRefresh, clicks: testClicks, motion: testMotion };
try {
  for (const g of ONLY) {
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
