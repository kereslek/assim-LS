#!/usr/bin/env node
// A local server for the dashboard on made-up, sealed fixtures, so tools/live-audit.mjs can run its whole walk in
// WebKit before a page deploys (site.yml, dispatch input `audit`). Prints the page's URL, then serves until killed.
//   node tools/serve-fixtures.mjs [--page <file>] [--port 8731]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixtures } from './fixtures/make-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PAGE = path.resolve(ROOT, opt('page', 'site/app/index.html'));
const FX = fs.mkdtempSync(path.join(os.tmpdir(), 'lps-serve-'));
writeFixtures(FX);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = u.pathname === '/app/index.html' || u.pathname === '/app/' ? PAGE : u.pathname.startsWith('/fx/') ? path.join(FX, path.normalize(u.pathname.slice(4))) : null;
  if (!file || (file !== PAGE && !file.startsWith(FX)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
srv.listen(+opt('port', '8731'), '127.0.0.1', () => console.log(`http://127.0.0.1:${srv.address().port}/app/index.html?base=/fx/default/`));
const stop = () => { srv.close(); fs.rmSync(FX, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
