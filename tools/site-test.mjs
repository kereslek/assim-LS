#!/usr/bin/env node
// Browser tests for the dashboard (site/app/index.html) on made-up, sealed fixture data.
// Prints pass/fail, counts and timings only: the fixtures are made up, but the habit stays.
//
//   node tools/site-test.mjs                         Chromium, widths 360…1920 plus reduced motion
//   node tools/site-test.mjs --browser webkit --device "iPhone 15"     phone = that device; laptop 1440
//   node tools/site-test.mjs --shots <dir>           also save full-page screenshots (cut into parts)
//   node tools/site-test.mjs --only unlock,layout    run some groups: unlock layout windows states clicks motion
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
import { writeFixtures, FIXTURE_PASSPHRASE } from './fixtures/make-fixture.mjs';

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
const ONLY = (opt('only') || 'unlock,layout,windows,states,clicks,motion').split(',');
const WIDTHS = DEVICE ? [] : [360, 375, 390, 430, 768, 1024, 1440, 1920];
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
  const base = phone && DEVICE ? { ...pw.devices[DEVICE] } : { viewport: { width, height } };
  if (BROWSER !== 'chromium') delete base.defaultBrowserType;
  const ctx = await browser.newContext({ ...base, reducedMotion });
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
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
  ok('unlock: the right passphrase opens the data', (await page.textContent('#best h2')) === 'VELNA/WETH');
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
  const inScroll = (el) => !!el.closest('.tbl-box, .heat-box, .sheet-body');
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
    const t = await openUnlocked(browser, 'default', { phone, width: 1440 });
    const tag = phone ? 'phone' : 'laptop';
    ok(`windows ${tag}: 30D is the default`, (await t.page.getAttribute('#winseg [data-w="30d"]', 'aria-pressed')) === 'true');
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

// ---------- 5. click audit: press every control, check the DOM answered ----------
const SIG = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '');
async function controls(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; };
    const all = [...document.querySelectorAll('button, select, input, [tabindex="0"], a[href]')].filter(vis);
    const sig = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '');
    return { untagged: all.filter((el) => !el.dataset.act && !el.disabled).map((el) => el.outerHTML.slice(0, 60)), sigs: [...new Set(all.filter((el) => el.dataset.act && !el.disabled).map(sig))], disabled: all.filter((el) => el.disabled).map((el) => el.textContent.trim()) };
  });
}
async function press(page, sig) {
  // beat scroll-settle races: a wheel event first, then bring the control into view
  return page.evaluate((sig) => {
    const sigOf = (el) => el.dataset.act + (el.dataset.w ? ':' + el.dataset.w : '') + (el.dataset.k ? ':' + el.dataset.k : '') + (el.dataset.to ? ':' + el.dataset.to : '');
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
      if (done.has(sig) || /^(lock|retry|lock-retry|pass|unlock)$/.test(sig)) continue; // lock is a danger control: tested on its own
      done.add(sig);
      if (!(await press(p, sig))) { bad.push(sig + ' not found'); continue; }
      const act = sig.split(':')[0];
      const handle = await p.evaluateHandle((sig) => [...document.querySelectorAll('[data-act]')].find((e) => (e.dataset.act + (e.dataset.w ? ':' + e.dataset.w : '') + (e.dataset.k ? ':' + e.dataset.k : '') + (e.dataset.to ? ':' + e.dataset.to : '')) === sig && !e.disabled && e.offsetParent !== null), sig);
      if (act === 'lens' || act === 'chain') {
        const v = await handle.evaluate((s) => s.options[Math.min(1, s.options.length - 1)].value);
        await handle.asElement().selectOption(v);
      } else if (act === 'search') await handle.asElement().fill('VEL');
      else if (act === 'scrub') await handle.evaluate((s) => { s.value = String(Math.max(1, Math.floor(+s.max / 2))); s.dispatchEvent(new Event('input', { bubbles: true })); });
      else await handle.asElement().click();
      await sleep(act === 'jump' || act === 'bt-row' ? 1400 : act === 'play' ? 800 : 350);
      const mut = await p.evaluate(() => window.__mut);
      let good = mut > 0;
      if (act === 'jump') good = await headingInView(p, sig.split(':')[1]);
      if (act === 'detail') { good = await p.isVisible('#sheet'); if (good) { done.add('close-detail'); await p.click('#sheet-close'); await sleep(200); good = !(await p.isVisible('#sheet')); } }
      if (act === 'bt-row') good = (await p.isVisible('#bt-replay')) && (await headingInView(p, '#bt-replay'));
      if (act === 'bt-close') good = !(await p.isVisible('#bt-replay'));
      if (act === 'win') good = good && (await p.getAttribute(`#winseg [data-w="${sig.split(':')[1]}"]`, 'aria-pressed')) === 'true';
      if (act === 'sort') good = good && (await p.$$('#all thead th[aria-sort="ascending"], #all thead th[aria-sort="descending"]')).length === 1;
      if (!good) bad.push(sig);
      // put filters back so later controls see the full table
      if (act === 'lens' || act === 'chain') { await handle.asElement().selectOption('all'); await sleep(150); }
      if (act === 'search') { await handle.asElement().fill(''); await sleep(250); }
      if (act === 'play') { await sleep(200); }
      for (const s of (await controls(p)).sigs) if (!done.has(s) && !queue.includes(s)) queue.push(s);
      if (act === 'bt-row' && !done.has('play')) queue.unshift('play', 'scrub', 'bt-close');
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
const groups = { unlock: testUnlock, layout: testLayout, windows: testWindows, states: testStates, clicks: testClicks, motion: testMotion };
try {
  for (const g of ONLY) {
    if (!groups[g]) continue;
    const s = Date.now();
    try { await groups[g](browser); } catch (e) { ok(`${g}: ran to the end`, false, String(e.message).split('\n')[0].slice(0, 160)); }
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
