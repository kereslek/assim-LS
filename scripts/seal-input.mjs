// Seal a private input (JSON) to the inbox public key in lock/inbox.json. Needs no secret: anyone can
// seal, only the scanner (which holds the lock) can open. Never prints the plaintext, and refuses to
// write if the plaintext shows up in what it would write or print.
//   node scripts/seal-input.mjs --out lock/config.sealed.json < private.json
//   node scripts/seal-input.mjs --in private.json --out lock/config.sealed.json [--pub lock/inbox.json]
// An output named config.sealed.json is checked against the config fields first (by name, never value).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { echoes, readInboxKey, sealChecked } from '../lib/inbox.mjs';
import { configProblems } from '../lib/config.mjs';

export function sealInput({ text, out, pubDir = 'lock', say = console.log, sealFn } = {}) {
  if (!out) throw new Error('missing --out: where to write the sealed file');
  const pub = readInboxKey(pubDir);
  const { env, parsed } = sealChecked(text, pub, sealFn ? { sealFn } : {});
  const lines = [];
  if (path.basename(out) === 'config.sealed.json') {
    const bad = configProblems(parsed);
    if (bad.length) throw new Error(`refusing: not a valid config: ${bad.join('; ')}`);
    lines.push(`config fields valid: yes (${Object.keys(parsed).length} fields)`);
  }
  const existed = fs.existsSync(out);
  const body = JSON.stringify(env) + '\n';
  lines.push(`sealed to the inbox: yes`, `replaced an existing file: ${existed ? 'yes' : 'no'}`, `plaintext in the output: no`);
  if (echoes(body + lines.join('\n'), text, parsed)) throw new Error('refusing: the plaintext shows up in the output');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, body);
  for (const l of lines) say(l);
  return env;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const inFile = arg('--in');
    if (!inFile && process.stdin.isTTY) process.stderr.write('Paste the JSON, then press Ctrl-D (it is not echoed back by this script).\n');
    const text = inFile ? fs.readFileSync(inFile, 'utf8') : readStdin();
    if (!text.trim()) throw new Error('missing input: nothing on stdin or in --in');
    sealInput({ text, out: arg('--out'), pubDir: arg('--pub') || 'lock' });
  } catch (e) {
    // Our messages never carry the input; other errors print their code or name only.
    const m = String(e?.message || '');
    console.log(`seal-input failed: ${/^(missing|bad|refusing|input)\b/.test(m) ? m : e?.code || e?.name || 'Error'}`);
    process.exitCode = 1;
  }
}
