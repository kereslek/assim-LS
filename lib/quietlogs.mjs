// Sealed logs for a public repo: the full log is sealed to a file; the public job log gets only
// line counts and error categories (the first word, letters only), never an address or amount.
//
// One line in a script:  import { installSealedLogs } from '../lib/quietlogs.mjs'; installSealedLogs();
// It opens the lock first (a missing lock or wrong passphrase throws before anything is logged),
// then every console line, uncaught error and rejected promise goes to out/data/log.json, sealed.
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DIR, openLock, seal } from './lock.mjs';

export const LOG_FILE = 'out/data/log.json';
const MAX_CATEGORIES = 12;

export function categorize(lines) {
  const cat = {};
  for (const e of lines) {
    const k = (String(e).match(/^[A-Za-z]+/) || ['other'])[0].slice(0, 24);
    cat[k] = (cat[k] || 0) + 1;
  }
  return cat;
}

const text = (x) => {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || `${x.name}: ${x.message}`;
  try { return JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(x); } catch { return String(x); }
};

export function quietLogs(sealFn, file, { keep = 4000 } = {}) {
  const buf = [], errs = [], real = console.log.bind(console);
  const put = (lvl, a) => {
    const s = a.map(text).join(' ');
    buf.push(lvl + ' ' + s);
    if (lvl !== 'log') errs.push(s);
  };
  for (const m of ['log', 'info', 'debug', 'dir', 'table']) console[m] = (...a) => put('log', a);
  console.warn = (...a) => put('warn', a);
  console.error = console.trace = (...a) => put('error', a);
  // Node would print an uncaught error's stack straight to the public log: catch it and seal it.
  const crash = (e) => { put('error', [e]); process.exit(1); };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  const stats = () => ({ lines: buf.length, errors: errs.length, categories: categorize(errs) });
  process.once('exit', (code) => {
    let sealed = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(sealFn(JSON.stringify({ v: 1, t: Date.now(), exit: code, ...stats(), lines: buf.slice(-keep) }))));
      sealed = true;
    } catch { /* the public lines below still print */ }
    real(`pass: ${buf.length} lines (${sealed ? 'sealed' : 'NOT sealed: write failed'}), ${errs.length} warnings/errors, exit ${code}`);
    const cats = Object.entries(categorize(errs)).sort((a, b) => b[1] - a[1]);
    for (const [k, n] of cats.slice(0, MAX_CATEGORIES)) real(`  · ${k} ×${n}`);
    if (cats.length > MAX_CATEGORIES) real(`  · ${cats.length - MAX_CATEGORIES} more categories ×${cats.slice(MAX_CATEGORIES).reduce((s, [, n]) => s + n, 0)}`);
  });
  return { publicLog: real, stats };
}

// The one-liner other scripts call. Returns { publicLog, stats }: publicLog prints to the public log
// (counts and pass/fail only); stats() gives { lines, errors, categories } for live.json's health.
export function installSealedLogs({ lockDir = LOCK_DIR, file = LOG_FILE, env = process.env, keys = null } = {}) {
  const k = keys || openLock({ dir: lockDir, env }).keys;
  return quietLogs((s) => seal(s, k.aes), file);
}
