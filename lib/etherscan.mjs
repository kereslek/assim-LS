// contract-verified: is a token's source code published on Etherscan (v2 API, chainid 1)? Unverified
// code is where honeypots and hidden mint or blacklist switches hide. One call per token, cached for
// 7 days in a small file the next passes reuse. The key travels only in the request; a failed call is
// unread (null), never a pass, and only its category is ever reported.
import fs from 'node:fs';
import path from 'node:path';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const WEEK = 7 * 86400e3;
const category = (e) => String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 24) || 'error';

// One getsourcecode answer → true (verified), false (no source), null (unreadable answer).
export function readVerified(json) {
  const r = Array.isArray(json?.result) ? json.result[0] : null;
  if (json?.status !== '1' || !r || typeof r.SourceCode !== 'string') return null;
  return r.SourceCode.trim().length > 0;
}

export function makeVerifiedCache(file, { now = Date.now() } = {}) {
  let data = { v: 1, entries: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j?.v === 1 && j.entries && typeof j.entries === 'object') data = j; } catch { /* empty cache */ }
  return {
    get(a) { const e = data.entries[a]; return e && now - e.t < WEEK && typeof e.ok === 'boolean' ? e.ok : null; },
    put(a, ok) { data.entries[a] = { t: now, ok }; },
    save() {
      for (const [k, e] of Object.entries(data.entries)) if (!(now - e.t < WEEK)) delete data.entries[k];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
  };
}

// addresses → Map(address → true | false | null). Without a key nothing is read (all null).
export async function verifiedSources(getJson, addresses, { key, cache = null, spacingMs = 250, tries = 2, maxCalls = 400 } = {}) {
  const out = new Map();
  let calls = 0, fetched = 0, cached = 0, lastError = null;
  for (const a of addresses) {
    const hit = cache?.get(a);
    if (hit != null) { out.set(a, hit); cached++; continue; }
    if (!key || calls >= maxCalls) { out.set(a, null); continue; }
    let ok = null;
    for (let i = 0; i < tries && ok == null; i++) {
      calls++;
      try { ok = readVerified(await getJson(`https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=${a}&apikey=${key}`, { headers: { accept: 'application/json' } }, 20000)); if (ok == null) lastError = 'unreadable answer'; } catch (e) { lastError = category(e); }
      await pause(ok == null ? spacingMs * 4 : spacingMs);
    }
    out.set(a, ok);
    if (ok != null) { cache?.put(a, ok); fetched++; }
  }
  return { verified: out, calls, fetched, cached, lastError };
}
