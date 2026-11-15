// Guests (docs/briefs/guest-access.md): the loop's keys step. Requests reach the loop sealed to the inbox key
// (lib/inbox.mjs), as files in inbox/ on the code branch's tip; it applies them in time order, once each:
//   { lps: 'guest-add', id, at, slot, kek, name, exp, wrap }   wrap: the data key in a guest slot made by the owner's page
//   { lps: 'guest-remove', id, at, slot }   { lps: 'guest-reset', id, at }   (every guest out)
// A removal, an expiry, a reset or a slot no live guest opens rotates the data key: a new one, the owner slot keeps the
// old (p), the market files are sealed again under the new one, the live guests' slots are rebuilt with their KEKs.
// guests.json (owner key only): { v: 1, t, gen, guests: [{ s, n, e, at, st: 'active'|'removed'|'expired', end, kek? }], done: [id] }
// Public output: counts and yes/no only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inboxKeys, inboxOpen } from './inbox.mjs';
import { KEYS_FILE, MARKET_FILES, MAX_SLOTS, buildKeysFile, isSlot, openGuestSlot, ownerRing, privateIn, readKeysFile, unwrapSlot } from './keyring.mjs';
import { ITERATIONS } from './lock.mjs';
import { OUT_DIR, openStore, readSealed } from './store.mjs';

export const INBOX_DIR = 'inbox', INBOX_MAX = 200, INBOX_BYTES = 16384, DONE_KEEP = 1000, NAME_MAX = 40;
const HEX32 = /^[0-9a-f]{32}$/, HEX16 = /^[0-9a-f]{16}$/;
const b64key = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').length === 32;
export const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f-\x9f]|\u2028|\u2029/g, '').replace(/\s+/g, ' ').trim() : '');
const isInboxEnv = (x) => !!x && x.inbox === 1 && typeof x.epk === 'string' && typeof x.iv === 'string' && typeof x.ct === 'string';

// One request, opened and checked; null when it isn't one (never says why: the reason could carry its content).
export function parseRequest(env, inboxPrivate) {
  if (!isInboxEnv(env)) return null;
  let x;
  try { x = JSON.parse(inboxOpen(env, inboxPrivate)); } catch { return null; }
  if (!x || typeof x !== 'object' || !HEX32.test(x.id) || !Number.isFinite(x.at)) return null;
  if (x.lps === 'guest-add') {
    const name = cleanName(x.name);
    if (!HEX16.test(x.slot) || !b64key(x.kek) || !isSlot(x.wrap) || !name || name.length > NAME_MAX) return null;
    if (!(x.exp === null || (Number.isFinite(x.exp) && x.exp > x.at))) return null;
    return { lps: x.lps, id: x.id, at: x.at, slot: x.slot, kek: x.kek, name, exp: x.exp, wrap: x.wrap };
  }
  if (x.lps === 'guest-remove') return HEX16.test(x.slot) ? { lps: x.lps, id: x.id, at: x.at, slot: x.slot } : null;
  if (x.lps === 'guest-reset') return { lps: x.lps, id: x.id, at: x.at };
  return null;
}

// Apply requests and expiry to the guest list (pure). known: the data keys a fresh guest slot may hold (current + kept).
export function applyRequests(G, reqs, { now, known }) {
  const g = { ...G, guests: G.guests.map((x) => ({ ...x })), done: [...G.done] };
  const c = { added: 0, removed: 0, expired: 0, refused: 0, rotate: false, changed: false };
  const active = () => g.guests.filter((x) => x.st === 'active');
  const end = (x, st) => { x.st = st; x.end = now; delete x.kek; c.rotate = c.changed = true; };
  for (const r of [...reqs].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))) {
    if (g.done.includes(r.id)) continue;
    g.done.push(r.id);
    c.changed = true;
    if (r.lps === 'guest-add') {
      let ok = active().length < MAX_SLOTS && !g.guests.some((x) => x.s === r.slot);
      if (ok) {
        try { const k = unwrapSlot(r.wrap, Buffer.from(r.kek, 'base64'), 'guest').k; ok = known.some((d) => d.toString('base64') === k); } catch { ok = false; }
      }
      if (!ok) { c.refused++; continue; }
      g.guests.push({ s: r.slot, n: r.name, e: r.exp, at: r.at, st: 'active', end: null, kek: r.kek });
      c.added++;
    } else if (r.lps === 'guest-remove') {
      const x = active().find((y) => y.s === r.slot);
      if (!x) { c.refused++; continue; }
      end(x, 'removed'); c.removed++;
    } else if (r.lps === 'guest-reset') {
      for (const x of active()) { end(x, 'removed'); c.removed++; }
      c.rotate = true;
    }
  }
  for (const x of active()) if (x.e != null && x.e <= now) { end(x, 'expired'); c.expired++; }
  g.done = g.done.slice(-DONE_KEEP);
  return { G: g, ...c };
}

// The keys step on a folder of sealed files (the loop's out/data). keys: the lock's { aes, token }.
// allowMigrate: create the data key when there is no keys.json (only once the data branch was read and has none).
export function guestStep({ keys, outDir = OUT_DIR, requests = [], now = Date.now(), allowMigrate = false, rand = crypto.randomBytes } = {}) {
  const aes = keys.aes;
  const res = { migrated: false, rotated: false, wrote: false, added: 0, removed: 0, expired: 0, refused: 0, bad: 0, active: 0, stray: 0, skipped: null };
  let kf = readKeysFile(outDir);
  if (!kf && !allowMigrate) { res.skipped = 'no keys file'; return res; }
  let ring;
  if (!kf) {
    kf = buildKeysFile({ ownerAes: aes, dek: rand(32), prev: [], gen: 0, gsalt: rand(16).toString('base64'), iter: ITERATIONS, guests: [], t: now });
    res.migrated = true;
  }
  ring = ownerRing(aes, kf); // throws when keys.json doesn't open with the lock: nothing is touched
  const store = openStore({ keys, outDir });
  let G;
  try { G = store.get('guests.json'); } catch { G = undefined; }
  if (G === undefined || (G == null && kf.slots.length > 0)) { res.skipped = 'guests file unread'; return res; }
  G = G || { v: 1, t: now, gen: ring.gen, guests: [], done: [] };
  const priv = inboxKeys(keys.token).privateKey;
  const reqs = [];
  for (const e of requests) { const r = parseRequest(e, priv); if (r) reqs.push(r); else res.bad++; }
  const a = applyRequests(G, reqs, { now, known: [ring.dek, ...ring.prev] });
  Object.assign(res, { added: a.added, removed: a.removed, expired: a.expired, refused: a.refused });
  const live = a.G.guests.filter((x) => x.st === 'active');
  // every slot must belong to a live guest: a stray one (e.g. a removal whose keys never reached the data branch) rotates
  const opened = new Set();
  for (const x of live) {
    const kek = Buffer.from(x.kek, 'base64');
    kf.slots.forEach((s, i) => { try { unwrapSlot(s, kek, 'guest'); opened.add(i); } catch { /* not this guest's */ } });
  }
  res.stray = kf.slots.length - opened.size;
  const rotate = a.rotate || res.stray > 0;
  const rebuild = rotate || res.migrated || a.added > 0 || live.length !== kf.slots.length;
  res.active = live.length;
  if (!rebuild && !a.changed) return res;
  let nkf = kf;
  if (rebuild) {
    const dek = rotate ? rand(32) : ring.dek, prev = rotate ? [ring.dek, ...ring.prev] : ring.prev, gen = ring.gen + (rotate ? 1 : 0);
    nkf = buildKeysFile({ ownerAes: aes, dek, prev, gen, gsalt: kf.gsalt, iter: kf.iter, t: now,
      guests: live.map((x) => ({ s: x.s, n: x.n, e: x.e, kek: Buffer.from(x.kek, 'base64') })) });
    // checked before anything is written: the owner slot holds the new key, every live guest opens exactly its slot
    const chk = ownerRing(aes, nkf);
    if (!chk.dek.equals(dek)) throw new Error('bad keys: the new owner slot does not hold the new data key');
    for (const x of live) { const o = openGuestSlot(nkf, Buffer.from(x.kek, 'base64')); if (!o || !o.dek.equals(dek) || o.slot !== x.s) throw new Error('bad keys: a guest slot does not open'); }
    // read every market file under the old keys (the old format before the migration), then write: keys first, so a
    // file left under the old key still opens (the owner slot keeps it) and the publish seals it again
    const objs = {};
    if (rotate || res.migrated) for (const n of MARKET_FILES) { const o = store.get(n); if (o) objs[n] = o; }
    writeAtomic(path.join(outDir, KEYS_FILE), JSON.stringify(nkf, null, 1) + '\n');
    for (const [n, o] of Object.entries(objs)) store.put(n, o);
    for (const n of Object.keys(objs)) {
      const x = readSealed(n, [dek], { outDir });
      if (privateIn(n, x).length) throw new Error('bad keys: a market file kept an owner-only field');
    }
    res.rotated = rotate && !res.migrated;
    a.G.gen = gen;
  }
  a.G.t = now;
  store.put('guests.json', a.G);
  res.wrote = true;
  return res;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The public line: counts and yes/no only.
export function guestLine(r, inbox = null) {
  if (r.skipped) return `guests: keys step skipped (${r.skipped})${inbox ? `; inbox ${inbox.read ? `${inbox.files} files` : 'unread'}` : ''}`;
  return `guests: ${r.active} active, ${r.added} added, ${r.removed} removed, ${r.expired} expired, ${r.refused} refused${r.bad ? `, ${r.bad} unreadable` : ''}`
    + `${inbox ? `; inbox ${inbox.read ? `${inbox.files} files` : 'unread'}` : ''}; data key ${r.migrated ? 'created (first run with guests)' : r.rotated ? 'rotated' : 'kept'}${r.stray ? ` (${r.stray} stray slots)` : ''}; keys written: ${r.wrote ? 'yes' : 'no'}`;
}

// The sealed requests in inbox/ at the tip of the code branch (fetched each pass: the loop runs pinned code, the
// inbox is not pinned). { envs, read, files }; read is false when the branch could not be fetched.
export function readInbox({ repo = '.', remote = 'origin', branch = process.env.BRANCH, run = null } = {}) {
  if (!branch || !/^[\w./-]+$/.test(branch)) return { envs: [], read: false, files: 0 };
  const git = run || ((args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return r.status === 0 ? r.stdout : null; });
  const ref = 'refs/lps/inbox-head';
  if (git(['fetch', '--quiet', '--no-tags', '--depth=1', remote, `+refs/heads/${branch}:${ref}`]) === null) return { envs: [], read: false, files: 0 };
  const ls = git(['ls-tree', '-r', '-z', '-l', ref, '--', INBOX_DIR]);
  if (ls === null) return { envs: [], read: false, files: 0 };
  const envs = [];
  let files = 0;
  for (const ent of ls.split('\0').filter(Boolean).slice(0, INBOX_MAX)) {
    const [meta, name] = ent.split('\t');
    const [, type, blob, size] = meta.trim().split(/\s+/);
    if (type !== 'blob' || !String(name).endsWith('.json')) continue;
    files++;
    if (!(Number(size) <= INBOX_BYTES)) { envs.push(null); continue; }
    const text = git(['cat-file', 'blob', blob]);
    try { envs.push(JSON.parse(text)); } catch { envs.push(null); }
  }
  return { envs, read: true, files };
}
