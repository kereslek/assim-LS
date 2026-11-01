// Sealed output files (docs/DATA.md): live.json, history.json, backtest.json, the sealed log log.json
// and snapshots.json (the raw per-pool rows the time windows are recomputed from), written to out/data/ as lock envelopes only. A plaintext object never touches the disk.
// publish-data.mjs then puts them, with lock.json, on the `data` branch.
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DIR, isEnvelope, open, openLock, seal } from './lock.mjs';

export const OUT_DIR = 'out/data';
export const DATA_FILES = Object.freeze(['live.json', 'history.json', 'backtest.json', 'log.json', 'snapshots.json']);

export function checkName(name) {
  if (!DATA_FILES.includes(name)) throw new Error(`not a data file: only ${DATA_FILES.join(', ')} are published`);
  return name;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Seal one object. Data files carry v: 1 and their pass time t (ms), which becomes the envelope's
// only readable field, so a staleness check needs no key.
export function writeSealed(name, obj, aes, { outDir = OUT_DIR } = {}) {
  checkName(name);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${name}: must be an object`);
  if (obj.v !== 1) throw new Error(`${name}: needs v: 1 (data contract v1)`);
  if (!Number.isFinite(obj.t) || obj.t <= 0) throw new Error(`${name}: needs t, the pass time in ms`);
  const env = seal(obj, aes, { t: obj.t });
  writeAtomic(path.join(outDir, name), JSON.stringify(env));
  return { name, t: env.t };
}

// Open one file; a file that isn't there is null (missing is never zero). A file that is there but
// won't open (tampered, wrong key, not an envelope) throws.
export function readSealed(name, aes, { outDir = OUT_DIR } = {}) {
  checkName(name);
  const file = path.join(outDir, name);
  if (!fs.existsSync(file)) return null;
  let env;
  try { env = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${name}: not JSON`); }
  if (!isEnvelope(env)) throw new Error(`${name}: not a sealed envelope`);
  return JSON.parse(open(env, aes));
}

// Every file in a folder must be a known data file sealed under this key. Returns the names; throws
// on a plaintext file, an unknown name or an envelope sealed under another key.
export function checkSealedDir(outDir, aes) {
  if (!fs.existsSync(outDir)) return [];
  const names = fs.readdirSync(outDir).filter((n) => !n.startsWith('.')).sort();
  for (const n of names) {
    checkName(n);
    let env;
    try { env = JSON.parse(fs.readFileSync(path.join(outDir, n), 'utf8')); } catch { throw new Error(`${n}: not JSON`); }
    if (!isEnvelope(env)) throw new Error(`${n}: not a sealed envelope (plaintext is never published)`);
    try { open(env, aes); } catch { throw new Error(`${n}: does not open with this lock`); }
  }
  return names;
}

// The store a scanner pass uses: opens the lock once (a wrong passphrase throws here, before any
// file is written), then put/get/update by file name.
export function openStore({ lockDir = LOCK_DIR, outDir = OUT_DIR, env = process.env, keys = null } = {}) {
  const k = keys || openLock({ dir: lockDir, env }).keys;
  return {
    keys: k,
    outDir,
    put: (name, obj) => writeSealed(name, obj, k.aes, { outDir }),
    get: (name) => readSealed(name, k.aes, { outDir }),
    // fn gets the previous object (or null) and returns the new one, e.g. to append to history.
    update: (name, fn) => writeSealed(name, fn(readSealed(name, k.aes, { outDir })), k.aes, { outDir }),
  };
}
