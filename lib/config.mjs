// The scanner's settings: public, made-up defaults in code, overlaid by the owner's private values,
// which travel sealed to the inbox at lock/config.sealed.json and are opened in Actions with the lock.
// Error messages name a field, never its value: they can end up in a public log.
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DIR, openLock } from './lock.mjs';
import { inboxKeys, inboxOpen } from './inbox.mjs';

export const CONFIG_FILE = 'config.sealed.json';

// Made-up public defaults, so code and tests run without the private file. Not anyone's real values.
export const DEFAULTS = Object.freeze({
  ticket: 1000,          // example ticket every pool is scored at, USD
  gemAt: 60,             // gem threshold, 0..100
  minTvlUsd: 300000,     // pools below this are left out
  minPairAgeDays: 180,   // a "fresh pool" needs a pair that has traded this long
  stopLoss: 0.25,        // fraction of a position's value lost before exiting
  priceSanity: 0.1,      // a pool's price counts only within this fraction of market
  toxicMarkout: 0.6,     // markout ÷ fee above this is toxic flow
  holdDays: Object.freeze({ ethereum: 14, base: 7 }),
  windows: Object.freeze(['24h', '7d', '30d']),
  leakSensitive: Object.freeze([]),   // strings the leak check searches for (wallets, ids...)
});

const num = (x) => typeof x === 'number' && Number.isFinite(x);
const RULES = {
  ticket: (x) => num(x) && x > 0 || 'must be a positive number (USD)',
  gemAt: (x) => num(x) && x >= 0 && x <= 100 || 'must be a number from 0 to 100',
  minTvlUsd: (x) => num(x) && x >= 0 || 'must be a number ≥ 0 (USD)',
  minPairAgeDays: (x) => num(x) && x >= 0 || 'must be a number of days ≥ 0',
  stopLoss: (x) => num(x) && x > 0 && x <= 1 || 'must be a fraction above 0, at most 1',
  priceSanity: (x) => num(x) && x > 0 && x <= 1 || 'must be a fraction above 0, at most 1',
  toxicMarkout: (x) => num(x) && x > 0 && x <= 10 || 'must be a ratio above 0, at most 10',
  holdDays: (x) => (x && typeof x === 'object' && !Array.isArray(x) &&
    Object.entries(x).every(([k, v]) => /^[a-z][a-z0-9-]{1,30}$/.test(k) && num(v) && v > 0 && v <= 365)) ||
    'must map chain names to days (above 0, at most 365)',
  windows: (x) => (Array.isArray(x) && x.length > 0 && x.every((w) => typeof w === 'string' && /^\d{1,3}[hd]$/.test(w)) &&
    new Set(x).size === x.length) || 'must be a non-empty list of distinct windows like "24h" or "30d"',
  leakSensitive: (x) => (Array.isArray(x) && x.every((s) => typeof s === 'string' && s.length > 0)) || 'must be a list of strings',
};

// Check a (possibly partial) overlay. Returns a list of "field: problem" lines; empty means valid.
export function configProblems(obj, { partial = true } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['config: must be a JSON object'];
  const out = [];
  for (const k of Object.keys(obj)) if (!(k in RULES)) out.push(`unknown field (${Object.keys(obj).indexOf(k) + 1} of ${Object.keys(obj).length}): not a config field`);
  for (const [k, rule] of Object.entries(RULES)) {
    if (!(k in obj)) { if (!partial) out.push(`${k}: missing`); continue; }
    const r = rule(obj[k]);
    if (r !== true) out.push(`${k}: ${r}`);
  }
  return out;
}

const copy = (x) => JSON.parse(JSON.stringify(x));

// Defaults overlaid by the private values: holdDays merges per chain, everything else replaces.
export function mergeConfig(base, overlay) {
  const bad = configProblems(overlay);
  if (bad.length) throw new Error('bad config: ' + bad.join('; '));
  const out = copy(base);
  for (const [k, v] of Object.entries(overlay)) out[k] = k === 'holdDays' ? { ...out.holdDays, ...v } : copy(v);
  const still = configProblems(out, { partial: false });
  if (still.length) throw new Error('bad config: ' + still.join('; '));
  return out;
}

// Load the config. No sealed file: the defaults, sealed = false. A sealed file: it must open with the
// lock (missing passphrase, wrong passphrase or a tampered file all throw: never fall back silently).
export function loadConfig({ dir = LOCK_DIR, env = process.env, keys = null, file = CONFIG_FILE } = {}) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return { config: copy(DEFAULTS), sealed: false };
  const k = keys || openLock({ dir, env }).keys;
  let envl;
  try { envl = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new Error('bad sealed config: not JSON'); }
  let text;
  try { text = inboxOpen(envl, inboxKeys(k.token).privateKey); } catch { throw new Error('bad sealed config: it does not open with this lock (tampered, or sealed to another key)'); }
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('bad sealed config: the sealed text is not JSON'); }
  return { config: mergeConfig(DEFAULTS, obj), sealed: true };
}

// Strings for the leak check. Shorter than `min` characters can't be searched without false alarms;
// they are counted, never printed.
export function leakStrings(config, { min = 6 } = {}) {
  const all = [...new Set((config?.leakSensitive || []).filter((s) => typeof s === 'string'))];
  return { strings: all.filter((s) => s.length >= min), short: all.filter((s) => s.length < min).length };
}
