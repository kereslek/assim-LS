// The weekly live check of the site's headers and TLS (.github/workflows/site-check.yml; owner-approved, read-only).
// Fetches the dashboard page and the project site's root, and prints for each: the status, the response's header
// names, and pass/fail for the HTTPS redirect, HSTS, content-type and nosniff, cache-control, the referrer policy
// (meta or header), the CSP meta in the HTML and the robots noindex; then the TLS version and the certificate's
// expiry date. Never anything else from the page: no header value, no URL, no byte of the HTML.
//   node scripts/site-headers.mjs [--host kereslek.github.io] [--page /assim-LS/<folder>/] [--root /assim-LS/]
// "must" checks fail the job; "info" ones (set by GitHub Pages, not by this project) only print.
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const DAY = 86400e3;
const has = (html, re) => re.test(html);
const metaRe = (name, attr = 'name') => new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']?${name}["']?[^>]*>`, 'i');
const metaContent = (html, name, attr = 'name') => { const m = metaRe(name, attr).exec(html); return m ? (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? '') : null; };

// Pure: the checks for one page from what was fetched. headers: a Map/obj of lower-case names; redirect: the
// plain-http answer { status, location }. role: 'page' (the dashboard: page-content checks are "must") or 'root'.
export function pageChecks({ status, headers, html = '', redirect = null, host }, role = 'page') {
  const h = new Map(Object.entries(headers instanceof Map ? Object.fromEntries(headers) : headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const own = role === 'page' ? 'must' : 'info';
  const out = [];
  const add = (name, ok, level, how = '') => out.push({ name, ok: !!ok, level, how });
  add('reachable (200)', status === 200, 'must');
  add('plain http redirects to https', !!redirect && [301, 302, 307, 308].includes(redirect.status) && String(redirect.location || '').startsWith(`https://${host}/`), 'must');
  const hsts = /max-age\s*=\s*(\d+)/i.exec(h.get('strict-transport-security') || '');
  add('HSTS present (max-age ≥ 180 days)', !!hsts && Number(hsts[1]) >= 180 * 86400, 'must');
  add('content-type is text/html', /^text\/html\b/i.test(h.get('content-type') || ''), 'must');
  add('nosniff', /^nosniff$/i.test((h.get('x-content-type-options') || '').trim()), 'info');
  add('cache-control present', h.has('cache-control'), 'info');
  const refMeta = metaContent(html, 'referrer'), refHead = h.get('referrer-policy');
  const strict = (v) => /^(no-referrer|same-origin|strict-origin(-when-cross-origin)?)$/i.test(String(v || '').trim());
  add('referrer policy (meta or header)', strict(refMeta) || strict(refHead), own, refMeta != null ? 'meta' : refHead ? 'header' : 'none');
  add('CSP meta in the HTML', metaContent(html, 'Content-Security-Policy', 'http-equiv') != null, own);
  const robots = metaContent(html, 'robots') || h.get('x-robots-tag') || '';
  add('robots noindex (meta or header)', /noindex/i.test(robots), own);
  return out;
}

export function tlsCheck({ protocol, validTo, now = Date.now() }) {
  const exp = Date.parse(validTo);
  const days = Number.isFinite(exp) ? Math.floor((exp - now) / DAY) : null;
  return [
    { name: `TLS version ${protocol || 'unread'} (1.2 or newer)`, ok: /^TLSv1\.[23]$/.test(String(protocol)), level: 'must', how: '' },
    { name: `certificate expires ${Number.isFinite(exp) ? new Date(exp).toISOString().slice(0, 10) : 'unread'} (${days ?? '—'} days; at least 14 left)`, ok: days != null && days >= 14, level: 'must', how: '' },
  ];
}

export function report(label, { status, headerNames, checks }, say = console.log) {
  if (status !== undefined) say(`site check: ${label}: status ${status ?? 'unread'}; header names: ${headerNames.length ? headerNames.join(', ') : 'none'}`);
  for (const c of checks) say(`site check: ${label}: ${c.name}: ${c.ok ? 'pass' : 'FAIL'}${c.level === 'info' ? ' (info: set by GitHub Pages)' : ''}${c.how ? ` (${c.how})` : ''}`);
}

async function fetchPage(url) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'site-check' }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, headers: Object.fromEntries(r.headers), html: await r.text() };
}
async function fetchRedirect(url) {
  try { const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'site-check' }, signal: AbortSignal.timeout(20000) }); return { status: r.status, location: r.headers.get('location') }; } catch { return null; }
}
function readTls(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 20000 }, () => { const c = s.getPeerCertificate(); resolve({ protocol: s.getProtocol(), validTo: c?.valid_to }); s.end(); });
    s.on('error', () => resolve({ protocol: null, validTo: null }));
    s.on('timeout', () => { s.destroy(); resolve({ protocol: null, validTo: null }); });
  });
}

export async function siteCheck({ host, pages, say = console.log, now = Date.now() }) {
  const all = [];
  for (const [label, p, role] of pages) {
    let got;
    try { got = await fetchPage(`https://${host}${p}`); } catch { got = { status: null, headers: {}, html: '' }; }
    const redirect = await fetchRedirect(`http://${host}${p}`);
    const checks = pageChecks({ ...got, redirect, host }, role);
    report(label, { status: got.status, headerNames: Object.keys(got.headers).map((k) => k.toLowerCase()).sort(), checks }, say);
    all.push(...checks);
  }
  const t = tlsCheck({ ...(await readTls(host)), now });
  report('tls', { checks: t }, say);
  all.push(...t);
  const must = all.filter((c) => c.level === 'must'), info = all.filter((c) => c.level === 'info');
  const ok = must.every((c) => c.ok);
  say(`site check: ${must.filter((c) => c.ok).length} of ${must.length} must-checks pass, ${info.filter((c) => c.ok).length} of ${info.length} info checks; verdict: ${ok ? 'pass' : 'FAIL'}`);
  return { ok, checks: all };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const host = arg('--host', 'kereslek.github.io');
  const r = await siteCheck({ host, pages: [['dashboard page', arg('--page', '/assim-LS/442edd62612a5a84cc58/'), 'page'], ['site root', arg('--root', '/assim-LS/'), 'root']] });
  process.exitCode = r.ok ? 0 : 1;
}
