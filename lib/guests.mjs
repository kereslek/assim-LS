// The loop's keys step (docs/briefs/guest-access.md). Requests reach the loop sealed to the inbox key (lib/inbox.mjs), as
// files in inbox/ on the code branch's tip; it applies them in time order, once each:
//   { lps: 'guest-add', id, at, slot, kek, name, exp, wrap }   wrap: the market key in a guest slot, made by the owner's page
//   { lps: 'guest-remove', id, at, slot }   { lps: 'guest-reset', id, at }   (every guest out)
//   { lps: 'owner-add', id, at, slot }      a new passphrase's owner slot (the master key under it): a passphrase change
//   { lps: 'recovery-set', id, at, rsalt, slot }   the recovery key's slot (replaces the one before)
// A guest's removal or expiry, a reset, or a guest slot no live guest opens rotates the market key: a new one (the master
// slot keeps the old), the market files sealed again, the live guests' slots rebuilt with their keys. A passphrase change
// ends by itself: once the loop's own passphrase opens the new owner slot, every other owner slot is dropped.
// guests.json (private key only): { v: 1, t, gen, guests: [{ s, n, e, at, st, end, kek? }], done: [id],
//   vault: { change: { at, ct } | null, changedAt, recoveryAt } }
// Public output: counts and yes/no only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inboxKeys, inboxOpen } from './inbox.mjs';
import { KEYS_FILE, MARKET_FILES, MAX_OWNER, MAX_SLOTS, b64ok, buildKeysFile, isSlot, migrateKeys, openGuestSlot, privateIn, readKeysFile, reopen, unwrapSlot } from './keyring.mjs';
import { OUT_DIR, openStore, readSealed } from './store.mjs';

export const INBOX_DIR = 'inbox', INBOX_MAX = 200, INBOX_BYTES = 16384, DONE_KEEP = 1000, NAME_MAX = 40;
const HEX32 = /^[0-9a-f]{32}$/, HEX16 = /^[0-9a-f]{16}$/;
export const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f-\x9f]|\u2028|\u2029/g, '').replace(/\s+/g, ' ').trim() : '');
const isInboxEnv = (x) => !!x && x.inbox === 1 && typeof x.epk === 'string' && typeof x.iv === 'string' && typeof x.ct === 'string';

// One request, opened and checked; null when it isn't one (never says why: the reason could carry its content).
export function parseRequest(env, inboxPrivate) {
  if (!isInboxEnv(env)) return null;
  let x;
  try { x = JSON.parse(inboxOpen(env, inboxPrivate)); } catch { return null; }
  if (!x || typeof x !== 'object' || !HEX32.test(x.id) || !Number.isFinite(x.at)) return null;
  const base = { lps: x.lps, id: x.id, at: x.at };
  if (x.lps === 'guest-add') {
    const name = cleanName(x.name);
    if (!HEX16.test(x.slot) || !b64ok(x.kek, 32) || !isSlot(x.wrap) || !name || name.length > NAME_MAX) return null;
    if (!(x.exp === null || (Number.isFinite(x.exp) && x.exp > x.at))) return null;
    return { ...base, slot: x.slot, kek: x.kek, name, exp: x.exp, wrap: x.wrap };
  }
  if (x.lps === 'guest-remove') return HEX16.test(x.slot) ? { ...base, slot: x.slot } : null;
  if (x.lps === 'guest-reset') return base;
  if (x.lps === 'owner-add') return isSlot(x.slot) ? { ...base, slot: { iv: x.slot.iv, ct: x.slot.ct } } : null;
  if (x.lps === 'recovery-set') return isSlot(x.slot) && b64ok(x.rsalt, 16) ? { ...base, slot: { iv: x.slot.iv, ct: x.slot.ct }, rsalt: x.rsalt } : null;
  return null;
}

// Apply requests and expiry (pure). G: the guest list; K: { owner, recovery, rsalt } of keys.json; known: the market keys a
// fresh guest slot may hold (current and kept); mine: the owner slot this loop's passphrase opens (its ct).
export function applyRequests(G, K, reqs, { now, known, mine = null }) {
  const g = { ...G, guests: G.guests.map((x) => ({ ...x })), done: [...G.done], vault: { change: null, changedAt: null, recoveryAt: null, ...(G.vault || {}) } };
  const k = { owner: K.owner.map((s) => ({ ...s })), recovery: K.recovery, rsalt: K.rsalt };
  const c = { added: 0, removed: 0, expired: 0, refused: 0, rotate: false, changed: false, keysChanged: false, ownerAdded: 0, recoverySet: 0, ownerDropped: 0 };
  const active = () => g.guests.filter((x) => x.st === 'active');
  const end = (x, st) => { x.st = st; x.end = now; delete x.kek; c.rotate = c.changed = true; };
  for (const r of [...reqs].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))) {
    if (g.done.includes(r.id)) continue;
    g.done.push(r.id);
    c.changed = true;
    if (r.lps === 'guest-add') {
      let ok = active().length < MAX_SLOTS && !g.guests.some((x) => x.s === r.slot);
      if (ok) {
        try { const key = unwrapSlot(r.wrap, Buffer.from(r.kek, 'base64'), 'guest').k; ok = known.some((d) => d.toString('base64') === key); } catch { ok = false; }
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
    } else if (r.lps === 'owner-add') {
      // a change still waiting (its slot not opened by the loop yet) gives way to the newer one; the slot in use stays
      const pend = g.vault.change;
      if (pend && pend.ct !== mine) k.owner = k.owner.filter((s) => s.ct !== pend.ct);
      if (k.owner.some((s) => s.ct === r.slot.ct) || k.owner.length >= MAX_OWNER) { c.refused++; continue; }
      k.owner.push(r.slot);
      g.vault.change = { at: r.at, ct: r.slot.ct };
      c.ownerAdded++; c.keysChanged = true;
    } else if (r.lps === 'recovery-set') {
      k.recovery = r.slot; k.rsalt = r.rsalt; g.vault.recoveryAt = r.at;
      c.recoverySet++; c.keysChanged = true;
    }
  }
  for (const x of active()) if (x.e != null && x.e <= now) { end(x, 'expired'); c.expired++; }
  // the switch is done once this loop runs on the new passphrase: the other owner slots go
  if (g.vault.change && mine && g.vault.change.ct === mine) {
    c.ownerDropped = k.owner.length - 1;
    k.owner = k.owner.filter((s) => s.ct === mine);
    g.vault.change = null; g.vault.changedAt = now;
    c.changed = true;
    if (c.ownerDropped) c.keysChanged = true;
  }
  g.done = g.done.slice(-DONE_KEEP);
  return { G: g, K: k, ...c };
}

// The keys step on a folder of sealed files (the loop's out/data). keys: openLock's (the vault, or the lock's own key before
// the migration); after a migration it becomes the vault in place. allowMigrate: create keys.json when there is none (only
// once the data branch was read and has none).
export function guestStep({ keys, outDir = OUT_DIR, requests = [], now = Date.now(), allowMigrate = false, rand = crypto.randomBytes } = {}) {
  const res = { migrated: false, rotated: false, wrote: false, added: 0, removed: 0, expired: 0, refused: 0, bad: 0, active: 0, stray: 0,
    ownerAdded: 0, ownerDropped: 0, recoverySet: 0, owners: 0, recovery: false, skipped: null };
  let kf = readKeysFile(outDir), v;
  if (!kf && !allowMigrate) { res.skipped = 'no keys file'; return res; }
  if (!kf) {
    if (keys.mdek) throw new Error('refusing: this lock holds key slots but the folder has no keys.json (never made twice)');
    const m = migrateKeys({ pass: keys.pass || keys.aes, token: keys.token, t: now, rand });
    kf = m.keysFile; v = { ...m.v, pass: keys.pass || keys.aes, slotCt: kf.owner[0].ct };
    res.migrated = true;
  } else v = reopen(keys, kf); // throws when the passphrase opens no owner slot: nothing is touched
  const store = openStore({ keys, outDir });
  let G;
  try { G = store.get('guests.json'); } catch { G = undefined; }
  if (G === undefined || (G == null && kf.slots.length > 0) || (G && G.guests.some((x) => x.st === 'active' && !b64ok(x.kek, 32)))) { res.skipped = 'guests file unread'; return res; }
  G = G || { v: 1, t: now, gen: v.gen, guests: [], done: [], vault: { change: null, changedAt: null, recoveryAt: null } };
  const priv = inboxKeys(v.token).privateKey;
  const reqs = [];
  for (const e of requests) { const r = parseRequest(e, priv); if (r) reqs.push(r); else res.bad++; }
  const a = applyRequests(G, kf, reqs, { now, known: [v.mdek, ...v.prev], mine: v.slotCt });
  for (const f of ['added', 'removed', 'expired', 'refused', 'ownerAdded', 'ownerDropped', 'recoverySet']) res[f] = a[f];
  const live = a.G.guests.filter((x) => x.st === 'active');
  // every guest slot must belong to a live guest: a stray one (e.g. a removal whose keys never reached the data branch) rotates
  const opened = new Set();
  for (const x of live) {
    const kek = Buffer.from(x.kek, 'base64');
    kf.slots.forEach((s, i) => { try { unwrapSlot(s, kek, 'guest'); opened.add(i); } catch { /* not this guest's */ } });
  }
  res.stray = kf.slots.length - opened.size;
  const rotate = a.rotate || res.stray > 0;
  const rebuild = rotate || res.migrated || a.added > 0 || a.keysChanged || live.length !== kf.slots.length;
  res.active = live.length; res.owners = a.K.owner.length; res.recovery = !!a.K.recovery;
  if (!rebuild && !a.changed) return res;
  if (rebuild) {
    const nv = { ...v, mdek: rotate ? rand(32) : v.mdek, prev: rotate ? [v.mdek, ...v.prev] : v.prev, gen: v.gen + (rotate ? 1 : 0) };
    const nkf = buildKeysFile({ v: nv, owner: a.K.owner, recovery: a.K.recovery, rsalt: a.K.rsalt, gsalt: kf.gsalt, iter: kf.iter, t: now,
      guests: live.map((x) => ({ s: x.s, n: x.n, e: x.e, kek: Buffer.from(x.kek, 'base64') })) });
    // checked before anything is written: the loop's passphrase opens it to the same keys, every live guest opens exactly their slot
    const chk = reopen({ pass: v.pass }, nkf);
    if (!chk.mdek.equals(nv.mdek) || !chk.aes.equals(nv.aes) || !chk.token.equals(nv.token)) throw new Error('bad keys: the new keys file does not hold the new keys');
    for (const x of live) { const o = openGuestSlot(nkf, Buffer.from(x.kek, 'base64')); if (!o || !o.dek.equals(nv.mdek) || o.slot !== x.s) throw new Error('bad keys: a guest slot does not open'); }
    // read every market file under the old keys (the old format before the migration), then write: keys first, so a file
    // left under an old key still opens (the master slot keeps it) and the publish seals it again
    const objs = {};
    if (rotate || res.migrated) for (const n of [...MARKET_FILES, ...(res.migrated ? ['snapshots.json', 'log.json'] : [])]) { const o = store.get(n); if (o) objs[n] = o; }
    writeAtomic(path.join(outDir, KEYS_FILE), JSON.stringify(nkf, null, 1) + '\n');
    if (res.migrated) Object.assign(keys, chk); // this process now holds the vault: its sealed log goes under the private key
    for (const [n, o] of Object.entries(objs)) store.put(n, o);
    for (const n of Object.keys(objs).filter((x) => MARKET_FILES.includes(x))) {
      if (privateIn(n, readSealed(n, [nv.mdek], { outDir })).length) throw new Error('bad keys: a market file kept an owner-only field');
    }
    res.rotated = rotate && !res.migrated;
    a.G.gen = nv.gen;
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
  const ib = inbox ? `; inbox ${inbox.read ? `${inbox.files} files` : 'unread'}` : '';
  if (r.skipped) return `guests: keys step skipped (${r.skipped})${ib}`;
  return `guests: ${r.active} active, ${r.added} added, ${r.removed} removed, ${r.expired} expired, ${r.refused} refused${r.bad ? `, ${r.bad} unreadable` : ''}${ib}`
    + `; data key ${r.migrated ? 'created (first run with key slots)' : r.rotated ? 'rotated' : 'kept'}${r.stray ? ` (${r.stray} stray slots)` : ''}`
    + `; passphrases ${r.owners}${r.ownerAdded ? `, ${r.ownerAdded} added` : ''}${r.ownerDropped ? `, ${r.ownerDropped} dropped` : ''}; recovery key ${r.recovery ? 'yes' : 'no'}${r.recoverySet ? ' (set now)' : ''}; keys written: ${r.wrote ? 'yes' : 'no'}`;
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
