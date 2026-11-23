// The archive API's bearer token (lib/apitoken.mjs), the function the page build copies: an HMAC-SHA256 of a fixed label
// under the key a slot opened, never the key itself; the owner's under the private key with the key generation, a guest's or
// member's under the market key with its own slot id. Checked against node:crypto, and on a real keys file: what the owner's
// page and a guest's page derive is what the loop derives. Throwaway keys, made-up names.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TOKEN_INFO, TOKEN_RE, apiToken, apiTokenFor, ownerLabel, slotLabel, tokenHash } from '../lib/apitoken.mjs';
import { buildKeysFile, migrateKeys, openGuestSlot, reopen, unwrapSlot } from '../lib/keyring.mjs';

const k32 = () => crypto.randomBytes(32);
const b64 = (b) => b.toString('base64');
const ref = (key, label) => 'lps1.' + crypto.createHmac('sha256', key).update(`${TOKEN_INFO}|${label}`).digest('base64url');

test('a token is lps1. + the HMAC-SHA256 of the label under the key (43 base64url characters), and the same everywhere', async () => {
  for (let i = 0; i < 20; i++) {
    const key = k32(), slot = crypto.randomBytes(8).toString('hex');
    const t = await apiToken(b64(key), slotLabel(slot));
    assert.equal(t, ref(key, `slot|${slot}`));
    assert.match(t, TOKEN_RE);
    assert.equal(t.length, 48);
    assert.ok(!t.includes(b64(key).slice(0, 12)) && !t.includes(key.toString('hex').slice(0, 12)), 'no part of the key');
    assert.equal(await apiToken(b64(key), slotLabel(slot)), t, 'deterministic');
  }
  assert.equal(ownerLabel(0), 'owner|g0'); assert.equal(ownerLabel(12), 'owner|g12');
  assert.equal(slotLabel('0123456789abcdef'), 'slot|0123456789abcdef');
  for (const bad of [-1, 1.5, '1', null]) assert.throws(() => ownerLabel(bad));
  for (const bad of ['0123456789ABCDEF', '0123', 'x'.repeat(16), null, 1]) assert.throws(() => slotLabel(bad));
  for (const [k, l] of [['', 'owner|g0'], [b64(crypto.randomBytes(16)), 'owner|g0'], [b64(k32()), ''], [b64(k32()), null], [null, 'owner|g0'], [b64(k32()).replace(/=$/, ''), 'owner|g0']]) {
    await assert.rejects(() => apiToken(k, l), /bad token input/);
  }
  const h = await tokenHash('lps1.made-up');
  assert.equal(h, crypto.createHash('sha256').update('lps1.made-up').digest('hex'));
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('each slot its own token: another slot, key, generation or role-holder makes another; no slot holder can make the owner\'s', async () => {
  const mdek = k32(), pdek = k32(), s1 = 'aaaaaaaaaaaaaaaa', s2 = 'bbbbbbbbbbbbbbbb';
  const t = new Set([
    await apiToken(b64(mdek), slotLabel(s1)), await apiToken(b64(mdek), slotLabel(s2)), await apiToken(b64(k32()), slotLabel(s1)),
    await apiToken(b64(pdek), ownerLabel(3)), await apiToken(b64(pdek), ownerLabel(4)), await apiToken(b64(mdek), ownerLabel(3)),
  ]);
  assert.equal(t.size, 6);
  // the opened slots as the page holds them
  assert.equal(await apiTokenFor({ k: b64(mdek), p: [], pk: b64(pdek), pp: [], tk: b64(k32()), g: 3 }), await apiToken(b64(pdek), ownerLabel(3)), 'the master slot: the owner');
  assert.equal(await apiTokenFor({ k: b64(mdek), s: s1, n: 'Made-up Friend', e: null, r: 'guest', g: 3 }), await apiToken(b64(mdek), slotLabel(s1)), 'a guest slot');
  for (const bad of [null, {}, { k: b64(mdek) }, { s: s1 }, { pk: b64(pdek) }]) await assert.rejects(() => apiTokenFor(bad));
});

test('on a real keys file: the owner\'s page (master slot) and a guest\'s page (its slot) derive what the loop derives', async () => {
  const pass = k32(), token = k32();
  const { v } = migrateKeys({ pass, token, iter: 1000, t: 1 });
  const kek1 = k32(), kek2 = k32();
  const owner = { iv: b64(crypto.randomBytes(12)), ct: b64(crypto.randomBytes(48)) };
  const kf = buildKeysFile({ v: { ...v, gen: 5 }, owner: [owner], gsalt: b64(crypto.randomBytes(16)), iter: 1000, t: 2,
    guests: [{ s: '1111111111111111', n: 'Made-up One', e: null, r: 'guest', kek: kek1 }, { s: '2222222222222222', n: 'Made-up Two', e: 9e12, r: 'member', kek: kek2 }] });
  const vault = reopen({ ...v, pass, mk: v.mk }, kf);
  // the page: the master slot opened with the master key; a guest's slot with that guest's key
  const m = unwrapSlot(kf.mk, v.mk, 'master');
  assert.equal(await apiTokenFor(m), await apiToken(b64(vault.aes), ownerLabel(5)));
  for (const kek of [kek1, kek2]) {
    const o = openGuestSlot(kf, kek), raw = kf.slots.map((s) => { try { return unwrapSlot(s, kek, 'guest'); } catch { return null; } }).find(Boolean);
    assert.equal(await apiTokenFor(raw), await apiToken(b64(o.dek), slotLabel(o.slot)));
    assert.equal(await apiTokenFor(raw), ref(vault.mdek, `slot|${o.slot}`), 'under the current market key');
  }
});

test('the file is plain WebCrypto with no imports, so the page build copies it as it is', () => {
  const src = fs.readFileSync(new URL('../lib/apitoken.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false);
  assert.equal(/\b(require|Buffer|process)\b/.test(src.replace(/^\/\/.*$/gm, '')), false);
  assert.match(src, /crypto\.subtle\.importKey\('raw', raw, \{ name: 'HMAC', hash: 'SHA-256' \}, false, \['sign'\]\)/, 'a non-extractable HMAC key');
});
