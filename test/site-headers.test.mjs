// The weekly header and TLS check (scripts/site-headers.mjs): the checks on made-up responses, each with a planted
// fault it catches, and the output never carries a header value, a URL or any of the page. Made-up data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageChecks, tlsCheck, report } from '../scripts/site-headers.mjs';

const HOST = 'example.invalid';
const SECRET = 'MADE-UP-SECRET-0xfeedbeef';
const HTML = `<!doctype html><html><head><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>${SECRET}</title></head><body>${SECRET}</body></html>`;
const HEADERS = { 'content-type': 'text/html; charset=utf-8', 'strict-transport-security': 'max-age=31556952', 'cache-control': 'max-age=600', 'x-content-type-options': 'nosniff', 'x-made-up': SECRET };
const good = { status: 200, headers: HEADERS, html: HTML, redirect: { status: 301, location: `https://${HOST}/page/` }, host: HOST };
const failedOf = (cs) => cs.filter((c) => !c.ok).map((c) => c.name);

test('a page with every header and meta passes every check', () => {
  assert.deepEqual(failedOf(pageChecks(good)), []);
  assert.deepEqual(failedOf(tlsCheck({ protocol: 'TLSv1.3', validTo: 'Mar  1 23:59:59 2027 GMT', now: Date.parse('2026-11-15T00:00:00Z') })), []);
});

test('planted faults: each missing header or meta fails its own check', () => {
  const faults = {
    'reachable (200)': { status: 404 },
    'plain http redirects to https': { redirect: { status: 200, location: null } },
    'HSTS present (max-age ≥ 180 days)': { headers: { ...HEADERS, 'strict-transport-security': 'max-age=60' } },
    'content-type is text/html': { headers: { ...HEADERS, 'content-type': 'text/plain' } },
    nosniff: { headers: { ...HEADERS, 'x-content-type-options': undefined } },
    'cache-control present': { headers: Object.fromEntries(Object.entries(HEADERS).filter(([k]) => k !== 'cache-control')) },
    'referrer policy (meta or header)': { html: HTML.replace('<meta name="referrer" content="no-referrer">', '') },
    'CSP meta in the HTML': { html: HTML.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '') },
    'robots noindex (meta or header)': { html: HTML.replace(/<meta name="robots"[^>]*>/, '') },
  };
  for (const [name, change] of Object.entries(faults)) {
    const headers = Object.fromEntries(Object.entries(change.headers || HEADERS).filter(([, v]) => v !== undefined));
    assert.deepEqual(failedOf(pageChecks({ ...good, ...change, headers })), [name], name);
  }
  // a redirect to another host is not the https redirect; a referrer header counts like the meta
  assert.deepEqual(failedOf(pageChecks({ ...good, redirect: { status: 301, location: 'https://other.invalid/' } })), ['plain http redirects to https']);
  assert.deepEqual(failedOf(pageChecks({ ...good, html: HTML.replace('<meta name="referrer" content="no-referrer">', ''), headers: { ...HEADERS, 'referrer-policy': 'no-referrer' } })), []);
  // the site root: page-content checks are information only
  const root = pageChecks({ ...good, html: '<p>nothing</p>' }, 'root');
  assert.ok(root.filter((c) => !c.ok).every((c) => c.level === 'info'));
  const t = Date.parse('2026-11-15T00:00:00Z');
  assert.deepEqual(failedOf(tlsCheck({ protocol: 'TLSv1.1', validTo: 'Mar  1 23:59:59 2027 GMT', now: t })).length, 1);
  assert.deepEqual(failedOf(tlsCheck({ protocol: 'TLSv1.3', validTo: 'Nov 20 23:59:59 2026 GMT', now: t })).length, 1);
  assert.deepEqual(failedOf(tlsCheck({ protocol: null, validTo: null, now: t })).length, 2);
});

test('the output is header names and pass/fail only: no value, no URL, nothing from the page', () => {
  const lines = [];
  report('dashboard page', { status: 200, headerNames: Object.keys(HEADERS), checks: pageChecks(good) }, (l) => lines.push(l));
  report('tls', { checks: tlsCheck({ protocol: 'TLSv1.3', validTo: 'Mar  1 23:59:59 2027 GMT' }) }, (l) => lines.push(l));
  const all = lines.join('\n');
  assert.ok(!all.includes(SECRET) && !all.includes('max-age=') && !all.includes('https://') && !all.includes(HOST) && !all.includes('default-src'));
  assert.ok(all.includes('x-made-up'), 'header names are listed');
});
