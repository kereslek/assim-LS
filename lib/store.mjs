// Sealed output files (docs/DATA.md): live.json, history.json, backtest.json, the sealed log log.json
// and snapshots.json (the raw per-pool rows the time windows are recomputed from), written to out/data/ as lock envelopes only. A plaintext object never touches the disk.
// publish-data.mjs then puts them, with lock.json (and keys.json once guests exist), on the `data` branch.
// Key slots (lib/keyring.mjs, docs/briefs/guest-access.md): once out/data holds keys.json, the market files
// (live, history, backtest) are sealed under the data key and their owner-only fields go to owner.json; get()
// merges them back, so callers see the objects they always saw. Before that, everything is as it was.
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DIR, isEnvelope, open, openLock, seal } from './lock.mjs';
import { KEYS_FILE, PRIVATE_FIELDS, isMarket, mergePrivate, ringFor, splitPrivate } from './keyring.mjs';

export const OUT_DIR = 'out/data';
// the core set every data branch has had since the lock; owner.json and guests.json come with key slots
export const DATA_FILES = Object.freeze(['live.json', 'history.json', 'backtest.json', 'log.json', 'snapshots.json']);
export const OWNER_EXTRA = Object.freeze(['owner.json', 'guests.json']);
export const ALL_FILES = Object.freeze([...DATA_FILES, ...OWNER_EXTRA]);

export function checkName(name) {
  if (!ALL_FILES.includes(name)) throw new Error(`not a data file: only ${ALL_FILES.join(', ')} are published`);
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
// aes: one key, or a list tried in order (the file's own key first).
export function readSealed(name, aes, { outDir = OUT_DIR } = {}) {
  checkName(name);
  const file = path.join(outDir, name);
  if (!fs.existsSync(file)) return null;
  let env;
  try { env = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${name}: not JSON`); }
  if (!isEnvelope(env)) throw new Error(`${name}: not a sealed envelope`);
  const list = Array.isArray(aes) ? aes : [aes];
  for (let i = 0; i < list.length; i++) {
    try { return JSON.parse(open(env, list[i])); } catch (e) { if (i === list.length - 1) throw e; }
  }
  throw new Error(`${name}: no key to open it`);
}

// Every file in a folder must be a known data file sealed under this lock: its own key (the data key for a
// market file once keys.json is there), an earlier data key the owner slot keeps, or the lock's key.
// keys.json, when present, must open with the lock. Returns the sealed files' names; throws on a plaintext
// file, an unknown name or an envelope sealed under a foreign key. aes: the lock's AES key (or { aes }).
export function checkSealedDir(outDir, aes) {
  if (!fs.existsSync(outDir)) return [];
  const ring = ringFor(Buffer.isBuffer(aes) ? aes : aes.aes, outDir);
  const names = fs.readdirSync(outDir).filter((n) => !n.startsWith('.') && n !== KEYS_FILE).sort();
  for (const n of names) {
    checkName(n);
    let env;
    try { env = JSON.parse(fs.readFileSync(path.join(outDir, n), 'utf8')); } catch { throw new Error(`${n}: not JSON`); }
    if (!isEnvelope(env)) throw new Error(`${n}: not a sealed envelope (plaintext is never published)`);
    if (!ring.openers(n).some((k) => { try { open(env, k); return true; } catch { return false; } })) throw new Error(`${n}: does not open with this lock`);
  }
  return names;
}

// The store a scanner pass uses: opens the lock once (a wrong passphrase throws here, before any
// file is written), then put/get/update by file name.
// keys.json is read on every call: the loop may rotate the data key between passes.
export function openStore({ lockDir = LOCK_DIR, outDir = OUT_DIR, env = process.env, keys = null } = {}) {
  const k = keys || openLock({ dir: lockDir, env }).keys;
  const ring = () => ringFor(k.aes, outDir);
  const put = (name, obj) => {
    const r = ring();
    if (r.dek && isMarket(name)) {
      const { market, owner } = splitPrivate(name, obj);
      if (owner) writeSealed('owner.json', owner, k.aes, { outDir });
      return writeSealed(name, market, r.dek, { outDir });
    }
    return writeSealed(name, obj, r.keyFor(name), { outDir });
  };
  const get = (name) => {
    const r = ring();
    const x = readSealed(name, r.openers(name), { outDir });
    if (!x || !r.dek || !PRIVATE_FIELDS[name]) return x;
    let o = null;
    try { o = readSealed('owner.json', [k.aes], { outDir }); } catch { o = null; }
    return mergePrivate(name, x, o);
  };
  return {
    keys: k,
    outDir,
    put,
    get,
    hasDek: () => !!ring().dek,
    // fn gets the previous object (or null) and returns the new one, e.g. to append to history.
    update: (name, fn) => put(name, fn(get(name))),
  };
}
