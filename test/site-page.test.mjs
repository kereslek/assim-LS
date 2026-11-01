// Static checks on the dashboard page, no browser: privacy headers, a CSP pinned to the page's own
// script, the lock's check string, and that WebCrypto (what the page uses) opens lib/lock.mjs seals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { newLockFile, unlock, seal, open } from '../lib/lock.mjs';

const html = fs.readFileSync(new URL('../site/app/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
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
  assert.ok(/connect-src 'self' https:\/\/raw\.githubusercontent\.com;/.test(csp), 'connect-src');
  const src = (csp.match(/script-src ([^;]+);/) || [])[1] || '';
  assert.ok(!src.includes('unsafe-inline'), 'no inline scripts beyond the hashed one');
  const want = scripts.map((s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`).join(' ');
  assert.equal(src, want, 'stale script hash: run node tools/site-test.mjs --fix-csp');
});

test('self-contained: no external scripts, styles or fonts', () => {
  assert.ok(!/<script[^>]+src=/.test(html));
  assert.ok(!/<link[^>]+stylesheet/.test(html));
  const hosts = [...html.matchAll(/https?:\/\/([^/"'\s);]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)].filter((h) => h !== 'www.w3.org').sort(), ['raw.githubusercontent.com']); // w3.org: the svg namespace, never fetched
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(html, /<link rel="apple-touch-icon" href="data:image\/png;base64,/);
  assert.ok(/img-src data:/.test(csp), 'the inline icons are allowed');
});

test('the inline script compiles and carries the build and lock constants', () => {
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]);
  assert.match(scripts[0], /const BUILD = 'v\d+\.\d+\.\d+';/);
  const lock = newLockFile('x', 1000);
  const check = open(lock.check, unlock(lock, 'x').aes);
  assert.ok(scripts[0].includes(`const CHECK = '${check}';`), 'the page checks the same string the lock seals');
  assert.match(scripts[0], /cache: 'no-store'/);
  assert.match(scripts[0], /'\?t=' \+ Date\.now\(\)/);
});

test('no model names in the page', () => {
  assert.ok(!/\b(claude|opus|sonnet|haiku|gpt-?\d)\b/i.test(html));
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
