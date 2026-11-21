// The loop's keys step (docs/briefs/guest-access.md). Requests reach the loop sealed to the inbox key (lib/inbox.mjs), as
// files in inbox/ on the code branch's tip; it applies them in time order, once each:
//   { lps: 'guest-add', id, at, guests: [{ slot, kek, name, exp, role, wrap }] }   one request for a whole list of friends;
//        wrap: the market key in a guest slot, made by the owner's page; role 'guest' (read-only) or 'member' (a full account);
//        exp: the hard cap (the loop drops the slot past it; the guest's device also stops 30 days after its first unlock)
//   { lps: 'guest-update', id, at, slot, role?, exp?, ext? }   upgrade to member, or extend (ext restarts the device's clock):
//        the slot comes back (an expired friend too) with the same passphrase: the loop kept their key
//   { lps: 'guest-make', names: [..], role?, softDays?, hardDays?, id?, at? }   (also { action: 'add-guests', ... }): the loop makes a
//        passphrase per name itself (lib/words.mjs) and keeps it in guests.json for the owner's page; id and at are optional
//        (sealed with scripts/seal-input.mjs by someone who must never see a passphrase)
//   { lps: 'shared-set', label?, days?, slot?, kek?, wrap?, id?, at? }   (also { action: 'add-shared-guest', label, days }): ONE guest
//        password for a group of friends, read-only, ending `days` (30) after it is made, with no per-device clock. Without kek the
//        loop makes the password (kept in guests.json for the owner's page); with kek and wrap it is the one the owner typed. A
//        shared password with the same label is replaced (the old one stops, the market key rotates)
//   { lps: 'guest-remove', id, at, slot }   for good (their key is forgotten)   { lps: 'guest-reset', id, at }   (everyone)
//   { lps: 'owner-add', id, at, slot }      a new passphrase's owner slot (the master key under it): a passphrase change
//   { lps: 'recovery-set', id, at, rsalt, slot }   the recovery key's slot (replaces the one before)
// A guest's removal or expiry, a reset, or a guest slot no live guest opens rotates the market key: a new one (the master
// slot keeps the old), the market files sealed again, the live guests' slots rebuilt with their keys. A passphrase change
// ends by itself: once the loop's own passphrase opens the new owner slot, every other owner slot is dropped.
// guests.json (private key only): { v: 1, t, gen, guests: [{ s, n, e, r, x, d, at, st, end, kek?, pw? }], done: [key],   (kek kept unless
//   removed; pw: a passphrase the loop made, for the owner's page only; done: every request ever applied or refused, for good,
//   as doneKey(id), so a request is never applied twice, even if its file comes back; older files hold the ids themselves)
//   vault: { change: { at, ct } | null, changedAt, recoveryAt } }
// Public output: counts and yes/no only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inboxKeys, inboxOpen } from './inbox.mjs';
import { KEYS_FILE, MARKET_FILES, MAX_OWNER, MAX_SLOTS, b64ok, buildKeysFile, guestKek, isSlot, migrateKeys, openGuestSlot, privateIn, readKeysFile, reopen, unwrapSlot } from './keyring.mjs';
import { OUT_DIR, openStore, readSealed } from './store.mjs';
import { genPass } from './words.mjs';

export const INBOX_DIR = 'inbox', INBOX_MAX = 200, INBOX_BYTES = 16384, NAME_MAX = 40;
// A done request, compactly: the first 16 hex characters of its id's SHA-256. An entry of an older guests.json (the id
// itself, 32 hex characters) is turned into its key when read.
export const doneKey = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
const asDoneKey = (x) => (/^[0-9a-f]{16}$/.test(x) ? x : doneKey(x));
const KNOWN = ['guest-add', 'guest-update', 'guest-make', 'shared-set', 'guest-remove', 'guest-reset', 'owner-add', 'recovery-set'];
const KNOWN_ACTIONS = ['add-guests', 'add-shared-guest'];
const HEX32 = /^[0-9a-f]{32}$/, HEX16 = /^[0-9a-f]{16}$/, ROLES = ['guest', 'member'];
export const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f-\x9f]|\u2028|\u2029/g, '').replace(/\s+/g, ' ').trim() : '');
const isInboxEnv = (x) => !!x && x.inbox === 1 && typeof x.epk === 'string' && typeof x.iv === 'string' && typeof x.ct === 'string';

// One request, opened and checked; null when it isn't one (never says why: the reason could carry its content).
export function parseRequest(env, inboxPrivate, now = Date.now()) {
  if (!isInboxEnv(env)) return null;
  let x;
  try { x = JSON.parse(inboxOpen(env, inboxPrivate)); } catch { return null; }
  if (x && x.action === 'add-guests' && x.lps === undefined) x.lps = 'guest-make';
  if (x && x.action === 'add-shared-guest' && x.lps === undefined) x.lps = 'shared-set';
  if (x && (x.lps === 'guest-make' || x.lps === 'shared-set')) { // id and at may be left out: the seal itself names the request, the loop dates it
    if (x.id === undefined) x.id = crypto.createHash('sha256').update(String(env.epk) + String(env.ct)).digest('hex').slice(0, 32);
    if (x.at === undefined) x.at = now;
  }
  if (!x || typeof x !== 'object' || !HEX32.test(x.id) || !Number.isFinite(x.at)) return null;
  const base = { lps: x.lps, id: x.id, at: x.at };
  if (x.lps === 'shared-set') {
    const label = x.label === undefined ? 'friends' : cleanName(x.label), days = x.days === undefined ? 30 : x.days, own = x.kek !== undefined;
    if (!label || label.length > NAME_MAX || !(Number.isInteger(days) && days >= 1 && days <= 365)) return null;
    if (own && (!HEX16.test(x.slot) || !b64ok(x.kek, 32) || !isSlot(x.wrap))) return null;
    return { ...base, label, days, ...(own ? { slot: x.slot, kek: x.kek, wrap: x.wrap } : {}) };
  }
  if (x.lps === 'guest-make') {
    const names = Array.isArray(x.names) ? x.names.map(cleanName) : [];
    const role = x.role === undefined ? 'guest' : x.role, soft = x.softDays === undefined ? 30 : x.softDays, hard = x.hardDays === undefined ? 45 : x.hardDays;
    if (!names.length || names.length > MAX_SLOTS || names.some((n) => !n || n.length > NAME_MAX) || !ROLES.includes(role)) return null;
    if (!(Number.isInteger(soft) && soft >= 1 && soft <= 365) || !(hard === null || hard === 0 || (Number.isInteger(hard) && hard >= 1 && hard <= 3650))) return null;
    return { ...base, names, role, soft, hard: hard || null };
  }
  if (x.lps === 'guest-add') {
    if (!Array.isArray(x.guests) || !x.guests.length || x.guests.length > MAX_SLOTS) return null;
    const guests = [];
    for (const g of x.guests) {
      const name = cleanName(g?.name);
      if (!g || !HEX16.test(g.slot) || !b64ok(g.kek, 32) || !isSlot(g.wrap) || !name || name.length > NAME_MAX || !ROLES.includes(g.role)) return null;
      if (!(g.exp === null || (Number.isFinite(g.exp) && g.exp > x.at))) return null;
      if (g.soft !== undefined && !(Number.isInteger(g.soft) && g.soft >= 1 && g.soft <= 365)) return null;
      guests.push({ slot: g.slot, kek: g.kek, name, exp: g.exp, role: g.role, wrap: g.wrap, soft: g.soft ?? 30 });
    }
    return { ...base, guests };
  }
  if (x.lps === 'guest-update') {
    if (!HEX16.test(x.slot) || (x.role !== undefined && !ROLES.includes(x.role)) || (x.exp !== undefined && x.exp !== null && !Number.isFinite(x.exp))) return null;
    return { ...base, slot: x.slot, ...(x.role !== undefined ? { role: x.role } : {}), ...(x.exp !== undefined ? { exp: x.exp } : {}), ext: x.ext === true };
  }
  if (x.lps === 'guest-remove') return HEX16.test(x.slot) ? { ...base, slot: x.slot } : null;
  if (x.lps === 'guest-reset') return base;
  if (x.lps === 'owner-add') return isSlot(x.slot) ? { ...base, slot: { iv: x.slot.iv, ct: x.slot.ct } } : null;
  if (x.lps === 'recovery-set') return isSlot(x.slot) && b64ok(x.rsalt, 16) ? { ...base, slot: { iv: x.slot.iv, ct: x.slot.ct }, rsalt: x.rsalt } : null;
  return null;
}

// Apply requests and expiry (pure). G: the guest list; K: { owner, recovery, rsalt } of keys.json; known: the market keys a
// fresh guest slot may hold (current and kept); mine: the owner slot this loop's passphrase opens (its ct).
// make(name) → { pass, kek }: a fresh passphrase and its guest key (guest-make; the loop's own, impure)
export function applyRequests(G, K, reqs, { now, known, mine = null, make = null }) {
  const done = new Set((G.done || []).filter((x) => typeof x === 'string').map(asDoneKey));
  const g = { ...G, guests: G.guests.map((x) => ({ ...x })), done: [], vault: { change: null, changedAt: null, recoveryAt: null, ...(G.vault || {}) } };
  const k = { owner: K.owner.map((s) => ({ ...s })), recovery: K.recovery, rsalt: K.rsalt };
  const c = { added: 0, updated: 0, removed: 0, expired: 0, refused: 0, again: 0, rotate: false, changed: false, keysChanged: false, ownerAdded: 0, recoverySet: 0, ownerDropped: 0 };
  const active = () => g.guests.filter((x) => x.st === 'active');
  // an expired friend keeps their key (an upgrade or an extension brings the same passphrase back); a removal forgets it
  const end = (x, st) => { const had = x.st === 'active'; x.st = st; x.end = now; if (st === 'removed') delete x.kek; c.changed = true; if (had) c.rotate = true; };
  const known_ = (x) => x.st !== 'removed' && !!x.kek;
  for (const r of [...reqs].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))) {
    const key = doneKey(r.id);
    if (done.has(key)) { c.again++; continue; } // done before: never applied twice
    done.add(key);
    c.changed = true;
    if (r.lps === 'guest-add') {
      for (const n of r.guests) {
        let ok = active().length < MAX_SLOTS && !g.guests.some((x) => x.s === n.slot);
        if (ok) {
          try { const key = unwrapSlot(n.wrap, Buffer.from(n.kek, 'base64'), 'guest').k; ok = known.some((d) => d.toString('base64') === key); } catch { ok = false; }
        }
        if (!ok) { c.refused++; continue; }
        g.guests.push({ s: n.slot, n: n.name, e: n.exp, r: n.role, x: null, d: n.soft, at: r.at, st: 'active', end: null, kek: n.kek });
        c.added++;
      }
    } else if (r.lps === 'shared-set') {
      let kek = r.kek, pw = null, s = r.slot;
      if (kek) {
        let ok = !g.guests.some((x) => x.s === r.slot);
        try { const key = unwrapSlot(r.wrap, Buffer.from(kek, 'base64'), 'guest').k; ok = ok && known.some((d) => d.toString('base64') === key); } catch { ok = false; }
        if (!ok) { c.refused++; continue; }
      } else {
        if (!make) { c.refused++; continue; }
        const m = make(r.label); kek = m.kek; pw = m.pass;
        do s = crypto.randomBytes(8).toString('hex'); while (g.guests.some((x) => x.s === s));
      }
      for (const x of g.guests.filter((y) => y.sh && y.n === r.label && y.st !== 'removed')) { end(x, 'removed'); c.removed++; } // a change: the old one stops
      if (active().length >= MAX_SLOTS) { c.refused++; continue; }
      g.guests.push({ s, n: r.label, sh: true, e: r.at + r.days * 86400e3, r: 'guest', x: null, d: 0, at: r.at, st: 'active', end: null, kek, ...(pw ? { pw } : {}) });
      c.added++;
    } else if (r.lps === 'guest-make') {
      for (const name of r.names) {
        if (!make || active().length >= MAX_SLOTS) { c.refused++; continue; }
        const m = make(name);
        let s;
        do s = crypto.randomBytes(8).toString('hex'); while (g.guests.some((x) => x.s === s));
        g.guests.push({ s, n: name, e: r.hard ? r.at + r.hard * 86400e3 : null, r: r.role, x: null, d: r.soft, at: r.at, st: 'active', end: null, kek: m.kek, pw: m.pass });
        c.added++;
      }
    } else if (r.lps === 'guest-update') {
      const x = g.guests.find((y) => y.s === r.slot && known_(y));
      if (!x || (r.exp != null && r.exp <= now) || (x.st === 'active' && active().length > MAX_SLOTS) || (x.st !== 'active' && active().length >= MAX_SLOTS)) { c.refused++; continue; }
      if (r.role) x.r = r.role;
      if ('exp' in r) x.e = r.exp;
      if (r.ext) x.x = r.at;
      if (x.st !== 'active') { x.st = 'active'; x.end = null; }
      c.updated++; c.keysChanged = true;
    } else if (r.lps === 'guest-remove') {
      const x = g.guests.find((y) => y.s === r.slot && y.st !== 'removed');
      if (!x) { c.refused++; continue; }
      end(x, 'removed'); c.removed++;
    } else if (r.lps === 'guest-reset') {
      for (const x of g.guests.filter((y) => y.st !== 'removed')) { end(x, 'removed'); c.removed++; }
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
  g.done = [...done]; // kept for good: no cap
  return { G: g, K: k, ...c };
}

// The keys step on a folder of sealed files (the loop's out/data). keys: openLock's (the vault, or the lock's own key before
// the migration); after a migration it becomes the vault in place. allowMigrate: create keys.json when there is none (only
// once the data branch was read and has none).
export function guestStep({ keys, outDir = OUT_DIR, requests = [], now = Date.now(), allowMigrate = false, rand = crypto.randomBytes } = {}) {
  const res = { migrated: false, rotated: false, wrote: false, added: 0, updated: 0, removed: 0, expired: 0, refused: 0, again: 0, bad: 0, active: 0, stray: 0,
    ownerAdded: 0, ownerDropped: 0, recoverySet: 0, owners: 0, recovery: false, skipped: null, handled: [] };
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
  if (G === undefined || (G == null && kf.slots.length > 0) || (G && G.guests.some((x) => x.st !== 'removed' && !b64ok(x.kek, 32)))) { res.skipped = 'guests file unread'; return res; }
  G = G || { v: 1, t: now, gen: v.gen, guests: [], done: [], vault: { change: null, changedAt: null, recoveryAt: null } };
  const priv = inboxKeys(v.token).privateKey;
  const reqs = [], handled = [];
  requests.forEach((e, i) => {
    const r = parseRequest(e, priv, now);
    if (r) { reqs.push(r); handled.push(i); return; }
    res.bad++;
    if (!laterKind(e, priv)) handled.push(i); // invalid for good; a kind only newer code knows waits for it
  });
  const make = () => { const pass = genPass(); return { pass, kek: guestKek(pass, kf.gsalt, kf.iter).toString('base64') }; };
  const a = applyRequests(G, kf, reqs, { now, known: [v.mdek, ...v.prev], mine: v.slotCt, make });
  for (const f of ['added', 'updated', 'removed', 'expired', 'refused', 'again', 'ownerAdded', 'ownerDropped', 'recoverySet']) res[f] = a[f];
  res.handled = handled; // the requests (indices into `requests`) whose inbox files may go once this step's result is published
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
      guests: live.map((x) => ({ s: x.s, n: x.n, e: x.e, r: x.r, x: x.x, d: x.d, sh: !!x.sh, kek: Buffer.from(x.kek, 'base64') })) });
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

// A request that opens but names a kind this code does not know (a newer page than the pinned loop): kept for newer code.
function laterKind(env, priv) {
  if (!isInboxEnv(env)) return false;
  let x;
  try { x = JSON.parse(inboxOpen(env, priv)); } catch { return false; }
  if (!x || typeof x !== 'object') return false;
  if (typeof x.lps === 'string') return !KNOWN.includes(x.lps);
  return typeof x.action === 'string' && !KNOWN_ACTIONS.includes(x.action);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The public line: counts and yes/no only.
export function guestLine(r, inbox = null) {
  const ib = inbox ? `; inbox ${inbox.read ? `${inbox.files} files${inbox.skipped ? ` (${inbox.skipped} more not read: over ${INBOX_MAX})` : ''}` : 'unread'}` : '';
  if (r.skipped) return `guests: keys step skipped (${r.skipped})${ib}`;
  return `guests: ${r.active} active, ${r.added} added, ${r.updated ? `${r.updated} updated, ` : ''}${r.removed} removed, ${r.expired} expired, ${r.refused} refused${r.again ? `, ${r.again} already done` : ''}${r.bad ? `, ${r.bad} unreadable` : ''}${ib}`
    + `; data key ${r.migrated ? 'created (first run with key slots)' : r.rotated ? 'rotated' : 'kept'}${r.stray ? ` (${r.stray} stray slots)` : ''}`
    + `; passphrases ${r.owners}${r.ownerAdded ? `, ${r.ownerAdded} added` : ''}${r.ownerDropped ? `, ${r.ownerDropped} dropped` : ''}; recovery key ${r.recovery ? 'yes' : 'no'}${r.recoverySet ? ' (set now)' : ''}; keys written: ${r.wrote ? 'yes' : 'no'}`;
}

// The sealed requests in inbox/ at the tip of the code branch (fetched each pass: the loop runs pinned code, the
// inbox is not pinned). { envs, names, read, files, skipped }; names: each env's path; read is false when the branch could not
// be fetched. At most INBOX_MAX files are read; skipped counts the rest (read on a later pass, once done files are removed).
export function readInbox({ repo = '.', remote = 'origin', branch = process.env.BRANCH, run = null } = {}) {
  const none = { envs: [], names: [], read: false, files: 0, skipped: 0 };
  if (!branch || !/^[\w./-]+$/.test(branch)) return none;
  const git = run || ((args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return r.status === 0 ? r.stdout : null; });
  const ref = 'refs/lps/inbox-head';
  if (git(['fetch', '--quiet', '--no-tags', '--depth=1', remote, `+refs/heads/${branch}:${ref}`]) === null) return none;
  const ls = git(['ls-tree', '-r', '-z', '-l', ref, '--', INBOX_DIR]);
  if (ls === null) return none;
  const envs = [], names = [];
  let files = 0, skipped = 0;
  for (const ent of ls.split('\0').filter(Boolean)) {
    const [meta, name] = ent.split('\t');
    const [, type, blob, size] = meta.trim().split(/\s+/);
    if (type !== 'blob' || !String(name).endsWith('.json')) continue;
    if (files >= INBOX_MAX) { skipped++; continue; }
    files++;
    names.push(name);
    if (!(Number(size) <= INBOX_BYTES)) { envs.push(null); continue; }
    const text = git(['cat-file', 'blob', blob]);
    try { envs.push(JSON.parse(text)); } catch { envs.push(null); }
  }
  return { envs, names, read: true, files, skipped };
}

// Remove done requests' files from inbox/ on the code branch: one commit on its tip (deletions only, nothing else in the
// tree changes), pushed without force; a tip that moved meanwhile is fetched again and the commit rebuilt (as pull --rebase).
// The commit message holds a count only. Uses the checkout's own push credentials, as the data branch's publish does.
// { removed, pushed, gone: the paths no longer on the branch }.
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const INBOX_PATH = /^inbox\/[\w.\-/]+\.json$/;
export function removeInbox({ repo = '.', remote = 'origin', branch = process.env.BRANCH, paths = [], tries = 4, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), beforePush = null } = {}) {
  if (!branch || !/^[\w./-]+$/.test(branch)) throw new Error('bad branch: no code branch to remove inbox files from');
  const want = [...new Set(paths)].filter((p) => INBOX_PATH.test(p) && !p.split('/').includes('..'));
  if (!want.length) return { removed: 0, pushed: false, gone: [] };
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lps-inbox-')), 'index');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.email, GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email };
  const git = (args, input) => { const r = spawnSync('git', args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 1 << 26, env }); return r.status === 0 ? r.stdout.trim() : null; };
  const ref = 'refs/lps/inbox-tip';
  try {
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) wait(2000 * 2 ** (attempt - 2));
      if (git(['fetch', '--quiet', '--no-tags', '--depth=1', remote, `+refs/heads/${branch}:${ref}`]) === null) continue;
      const tip = git(['rev-parse', '--verify', `${ref}^{commit}`]);
      const ls = tip ? git(['ls-tree', '-r', '-z', '--name-only', tip, '--', INBOX_DIR]) : null;
      if (ls === null) continue;
      const have = new Set(ls.split('\0').filter(Boolean));
      const present = want.filter((p) => have.has(p));
      if (!present.length) return { removed: 0, pushed: false, gone: want };
      fs.rmSync(idx, { force: true });
      if (git(['read-tree', tip]) === null) continue;
      if (git(['update-index', '-z', '--index-info'], present.map((p) => `0 ${'0'.repeat(40)}\t${p}`).join('\0') + '\0') === null) continue;
      const tree = git(['write-tree']);
      const n = present.length;
      const commit = tree ? git(['commit-tree', tree, '-p', tip, '-m', `inbox: ${n} request${n === 1 ? '' : 's'} done, removed`]) : null;
      if (!commit) continue;
      if (beforePush) beforePush(attempt);
      if (git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]) !== null) return { removed: n, pushed: true, gone: want, attempts: attempt };
    }
    return { removed: 0, pushed: false, gone: [] };
  } finally { fs.rmSync(path.dirname(idx), { recursive: true, force: true }); }
}
