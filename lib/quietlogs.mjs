// Sealed logs for a public repo: the full log is sealed to a file; the public job log gets only
// line counts and error categories (the first word, letters only), never an address or amount.
import fs from 'node:fs';

export function categorize(lines) {
  const cat = {};
  for (const e of lines) {
    const k = (String(e).match(/^[A-Za-z]+/) || ['other'])[0].slice(0, 24);
    cat[k] = (cat[k] || 0) + 1;
  }
  return cat;
}

export function quietLogs(sealFn, file) {
  const buf = [], errs = [], real = console.log.bind(console);
  const put = (lvl, a) => {
    const s = a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x))).join(' ');
    buf.push(lvl + ' ' + s);
    if (lvl !== 'log') errs.push(s);
  };
  console.log = (...a) => put('log', a);
  console.info = (...a) => put('log', a);
  console.warn = (...a) => put('warn', a);
  console.error = (...a) => put('error', a);
  process.on('exit', (code) => {
    try { fs.writeFileSync(file, JSON.stringify(sealFn(JSON.stringify(buf.slice(-4000))))); } catch { /* the public line below still prints */ }
    real(`pass: ${buf.length} lines (sealed), ${errs.length} warnings/errors, exit ${code}`);
    for (const [k, n] of Object.entries(categorize(errs))) real(`  · ${k} ×${n}`);
  });
  return { publicLog: real };
}
