// The archive API's bearer token (worker/, docs/DATA.md "Archive API"). The page derives it after unlock from what its key
// slot opened; it never sends a key that decrypts data, only an HMAC-SHA256 of a fixed label under that key. The Worker
// keeps only SHA-256 hashes of the valid tokens (KV assim-ls-auth, written by the loop: lib/apiauth.mjs).
//   owner           apiToken(m.pk, ownerLabel(m.g))   m: the opened master slot (the private key and the key generation)
//   guest / member  apiToken(g.k,  slotLabel(g.s))    g: the opened guest slot (the market key and the slot's id)
// apiTokenFor(opened) picks the right one for either slot. Only the owner holds the private key, so no slot holder can make
// the owner's token; a slot's id sits inside its own slot, so no guest can make another's. A new market key (a guest
// removed or expired, "remove all") changes every slot's token, and the generation in the owner's label changes the owner's.
// Plain WebCrypto with atob/btoa and no imports: the page build copies this file's functions as they are (Node 22 runs them too).
export const TOKEN_PREFIX = 'lps1.';
export const TOKEN_INFO = 'assim-ls-api/v1';
export const TOKEN_RE = /^lps1\.[A-Za-z0-9_-]{43}$/;
const SLOT_RE = /^[0-9a-f]{16}$/;
export const ownerLabel = (gen) => {
  if (!Number.isInteger(gen) || gen < 0) throw new Error('bad token input');
  return `owner|g${gen}`;
};
export const slotLabel = (slot) => {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw new Error('bad token input');
  return `slot|${slot}`;
};

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64url = (u8) => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

// keyB64: a 32-byte key, base64 (as the slots hold them); label: ownerLabel(..) or slotLabel(..). Returns 'lps1.' + 43 characters.
export async function apiToken(keyB64, label) {
  if (typeof keyB64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(keyB64) || typeof label !== 'string' || !label) throw new Error('bad token input');
  const raw = fromB64(keyB64);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); // non-extractable
  raw.fill(0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${TOKEN_INFO}|${label}`)));
  return TOKEN_PREFIX + toB64url(mac);
}

// The token for an opened slot: the master slot ({ pk, g, .. }) makes the owner's, a guest or member slot ({ k, s, .. }) its own.
export async function apiTokenFor(opened) {
  if (opened && typeof opened.pk === 'string') return apiToken(opened.pk, ownerLabel(opened.g));
  if (opened && typeof opened.k === 'string' && typeof opened.s === 'string') return apiToken(opened.k, slotLabel(opened.s));
  throw new Error('bad token input');
}

// What the Worker keeps and looks up: SHA-256 of the token's text, lowercase hex.
export async function tokenHash(token) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))));
  let h = '';
  for (const b of d) h += b.toString(16).padStart(2, '0');
  return h;
}
