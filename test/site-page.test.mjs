// Static checks on the dashboard page, no browser: privacy headers, a CSP pinned to the page's own
// script, the lock's check string, and that WebCrypto (what the page uses) opens lib/lock.mjs seals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { newLockFile, unlock, seal, open } from '../lib/lock.mjs';

// SITE_PAGE: a candidate page (relative to the repo) checked before it deploys; the deployed page otherwise
const html = fs.readFileSync(new URL('../' + (process.env.SITE_PAGE || 'site/app/index.html'), import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
// v0.7.9: blocks the page runs later (the 3D layer): never run by the parser, allowed by their own hash
const lazy = [...html.matchAll(/<script type="text\/plain" id="[\w-]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hashed = [...html.matchAll(/<script(?: type="text\/plain" id="[\w-]+")?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';

test('privacy and robots headers', () => {
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  assert.match(html, /scrollRestoration = 'manual'/);
  assert.match(html, /Europe\/Budapest/);
});

test('the CSP allows only the page’s own script, its origin and the data branch', () => {
  assert.ok(csp.includes("default-src 'none'"));
  // v0.8.3: the D1 archive's read API (worker/, docs/DATA.md "Archive API") is the one other origin a page with it may connect to
  const AR = /const AR_API = 'https:\/\/assim-ls-api\.kereslek\.workers\.dev'/.test(html);
  assert.ok((AR ? /connect-src 'self' https:\/\/raw\.githubusercontent\.com https:\/\/assim-ls-api\.kereslek\.workers\.dev;/ : /connect-src 'self' https:\/\/raw\.githubusercontent\.com;/).test(csp), 'connect-src');
  const src = (csp.match(/script-src ([^;]+);/) || [])[1] || '';
  assert.ok(!src.includes('unsafe-inline'), 'no inline scripts beyond the hashed one');
  const want = hashed.map((s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`).join(' ');
  assert.equal(src, want, 'stale script hash: run node tools/site-test.mjs --fix-csp');
});

test('self-contained: no external scripts, styles or fonts', () => {
  assert.ok(!/<script[^>]+src=/.test(html));
  assert.ok(!/<link[^>]+stylesheet/.test(html));
  const hosts = [...html.matchAll(/https?:\/\/([^/"'\s);]+)/g)].map((m) => m[1]);
  // explorer links open in a new tab (navigation, not a fetch): the only other hosts, never in the CSP's fetch lists
  // v0.7.0: github.com, for the owner's two links (a sealed request as a new inbox/ file; the LOCK_PASSPHRASE secret's page)
  // v0.7.8: each token's coin page (CoinMarketCap, else CoinGecko), a link too
  const LINKS = ['etherscan.io', 'basescan.org', 'app.uniswap.org', ...(/const INBOX_NEW = /.test(html) ? ['github.com'] : []), ...(/const COIN_PAGES = /.test(html) ? ['coinmarketcap.com', 'www.coingecko.com'] : [])];
  assert.deepEqual([...new Set(hosts)].filter((h) => h !== 'www.w3.org' && !LINKS.includes(h)).sort(), [...(/const AR_API = /.test(html) ? ['assim-ls-api.kereslek.workers.dev'] : []), 'raw.githubusercontent.com']); // w3.org: the svg namespace, never fetched
  for (const h of LINKS) assert.ok(!csp.includes(h), `${h} is a link target, not a source`);
  const linkLines = html.split('\n').filter((l) => LINKS.some((h) => l.includes('https://' + h)));
  assert.ok(linkLines.length >= 1 && linkLines.every((l) => /^const (EXPLORER|UNI_CHAIN|INBOX_NEW|SECRET_URL|COIN_PAGES) = |^  const id = String\(p\.id/.test(l)), 'link hosts only in the link builders');
  assert.match(html, /target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(html, /<link rel="apple-touch-icon" href="data:image\/png;base64,/);
  assert.ok(/img-src data:/.test(csp), 'the inline icons are allowed');
});

test('the inline script compiles and carries the build and lock constants', () => {
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]);
  for (const b of lazy) new vm.Script(b); // v0.7.9: a block run later compiles too
  assert.match(scripts[0], /const BUILD = 'v\d+\.\d+\.\d+';/);
  const lock = newLockFile('x', 1000);
  const check = open(lock.check, unlock(lock, 'x').aes);
  assert.ok(scripts[0].includes(`const CHECK = '${check}';`), 'the page checks the same string the lock seals');
  assert.match(scripts[0], /cache: 'no-store'/);
  assert.match(scripts[0], /'\?t=' \+ Date\.now\(\)/);
});

test('no model names in the page', () => {
  // v0.7.0: the code branch's name (where the sealed inbox lives, in the owner's two GitHub links) is the one allowed match
  assert.ok(!/\b(claude|opus|sonnet|haiku|gpt-?\d)\b/i.test(html.replaceAll('/claude/ecstatic-dirac-wkrqja', '/BRANCH')));
});

test('v0.7.0: the inbox key in the page is the repo\'s (lock/inbox.json), a public X25519 key and nothing else', (t) => {
  const meta = (/<meta name="lps-inbox-key" content="([^"]*)">/.exec(html) || [])[1];
  if (meta === undefined) { t.skip('a page from before v0.7.0 seals nothing'); return; }
  const repo = JSON.parse(fs.readFileSync(new URL('../lock/inbox.json', import.meta.url), 'utf8'));
  assert.equal(meta, repo.x25519);
  assert.equal(Buffer.from(meta, 'base64').length, 32);
});

test('WebCrypto opens a lib/lock.mjs seal the way the page does (PBKDF2 → AES-GCM → gunzip)', async () => {
  const lock = newLockFile('made-up passphrase', 2000);
  const { aes } = unlock(lock, 'made-up passphrase');
  const env = seal({ pools: [{ pair: 'MADEUP/WETH' }] }, aes, { t: 1 });
  const { subtle } = globalThis.crypto;
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const base = await subtle.importKey('raw', new TextEncoder().encode('made-up passphrase'), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(lock.salt), iterations: lock.iter }, base, 512));
  const key = await subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['decrypt']);
  const dec = async (e) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64(e.iv) }, key, b64(e.ct)));
  assert.equal(new TextDecoder().decode(await dec(lock.check)), open(lock.check, aes));
  const stream = new Blob([await dec(env)]).stream().pipeThrough(new DecompressionStream('gzip'));
  assert.equal(JSON.parse(await new Response(stream).text()).pools[0].pair, 'MADEUP/WETH');
  const wrong = await subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, ['decrypt']);
  await assert.rejects(subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, wrong, b64(env.ct)));
});

test('chain colours and marks live in one map (CHAINS), each colour written once', (t) => {
  const src = scripts[0], v = (/const BUILD = 'v(\d+)\.(\d+)\.(\d+)'/.exec(src) || []).slice(1).map(Number);
  if (v[0] === 0 && (v[1] < 4 || (v[1] === 4 && v[2] < 1))) { t.skip('a page from before v0.4.1 (a rollback) has no chain marks'); return; }
  assert.match(src, /const CHAINS = \{/);
  for (const c of ['#8A9EF5', '#2F6BFF', '#F0B90B', '#28A0F0']) assert.equal(html.split(c).length - 1, 1, `${c} appears once, in CHAINS`);
  assert.match(src, /const CHAIN_UNKNOWN = '#6B7684'/);
});
