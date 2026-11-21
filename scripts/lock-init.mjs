// Create the lock once: lock/lock.json (salt, rounds, a sealed check string) and lock/inbox.json (the
// X25519 public key only), from the LOCK_PASSPHRASE secret. If lock.json already exists it is never
// rewritten (a new salt would orphan every sealed file): the passphrase is checked against it instead.
// Prints yes/no lines only.
//   node scripts/lock-init.mjs [--dir lock] [--verify]                 production (600k rounds)
//   node scripts/lock-init.mjs --dir <tmp> --iter 1000 --throwaway      tests and rehearsals only
//   --keys-dir <dir>: read keys.json from there instead of copying it from the data branch into out/data first
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ITERATIONS, LOCK_DIR, initLock, passphraseFrom } from '../lib/lock.mjs';
import { OUT_DIR } from '../lib/store.mjs';
import { restoreKeysFile } from './publish-data.mjs';

const yn = (b) => (b ? 'yes' : 'no');

export function main(argv = process.argv.slice(2), env = process.env, say = console.log) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = arg('--dir') || LOCK_DIR;
  const iter = arg('--iter') ? Number(arg('--iter')) : ITERATIONS;
  if (!Number.isInteger(iter) || iter < 1000) throw new Error('bad --iter: a whole number ≥ 1000');
  if (iter < ITERATIONS && !argv.includes('--throwaway')) throw new Error(`refusing: fewer than ${ITERATIONS} rounds is for throwaway locks only (add --throwaway)`);
  const passphrase = passphraseFrom(env);
  // key slots: keys.json is readable, so it comes first (as in the loop); the passphrase may then open an owner slot
  let keysDir = arg('--keys-dir') || null;
  if (!keysDir && fs.existsSync(path.join(dir, 'lock.json'))) {
    try { restoreKeysFile(); keysDir = OUT_DIR; } catch (e) { say(`keys file not read (${reason(e).split(/[^A-Za-z]/)[0] || 'Error'}); the lock's own check decides`); }
  }
  const r = initLock({ dir, passphrase, iterations: iter, verifyOnly: argv.includes('--verify'), keysDir });
  say(`lock existed before: ${yn(r.existed)}`);
  if (r.existed) say(`key slots (keys.json) read: ${yn(r.slots)}`);
  say(`lock created now: ${yn(r.created)}`);
  say(`passphrase opens the lock: ${yn(r.opens)}`);
  if (r.opens) say(`inbox public key ${r.inboxWritten ? 'written' : 'present'} and matches the lock: ${yn(r.inboxMatches)}`);
  return r.opens && r.inboxMatches ? 0 : 1;
}

// Our own messages carry no values; anything else prints only its error code or name.
const reason = (e) => (/^(missing|bad|refusing|wrong)\b/.test(String(e?.message)) ? e.message : e?.code || e?.name || 'Error');

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); } catch (e) { console.log(`lock init failed: ${reason(e)}`); process.exitCode = 1; }
}
