// Per-UTC-day call counts for the public market-data APIs, and a hard daily CoinGecko budget: the free Demo
// key allows 10,000 calls a month, and every reader now asks DefiLlama, Coinbase or GeckoTerminal first.
//   const apis = makeApiCounter({ file: 'out/cache/apis.json', now, seed: prevLive?.health?.apis });
//   const gj = apis.wrap(getJson);            // counts each call by host; a CoinGecko call over the budget throws
//   apis.allow('coingecko', { reserve: 40 })  // a lower-priority reader leaves `reserve` calls for the others
//   apis.health() → live.json health.apis; apis.line() → the public log's counts; apis.save()
// The counts travel two ways: a small file (one process to the next: the pool list, then the scan) and the sealed
// live.json (one loop job to the next); a new process takes the larger count of the two for today. A call is
// counted when it is sent, whatever it answers. Over the budget, CoinGecko calls are not made: the readers fall
// back or leave the value null (never 0).
import fs from 'node:fs';
import path from 'node:path';
import { BudgetError } from './budget.mjs';

export const CG_DAILY_CAP = 150;
export const SOURCES = ['coingecko', 'defillama', 'coinbase', 'geckoterminal'];
const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export function sourceOf(url) {
  let h = '';
  try { h = new URL(String(url)).hostname; } catch { return null; }
  if (/(^|\.)coingecko\.com$/.test(h)) return 'coingecko';
  if (/(^|\.)llama\.fi$/.test(h)) return 'defillama';
  if (/(^|\.)coinbase\.com$/.test(h)) return 'coinbase';
  if (/(^|\.)geckoterminal\.com$/.test(h)) return 'geckoterminal';
  return null;
}

const usedOf = (x, s) => (s === 'coingecko' ? (isNum(x?.coingecko?.used) ? x.coingecko.used : isNum(x?.coingecko) ? x.coingecko : 0) : isNum(x?.[s]) ? x[s] : 0);

export function makeApiCounter({ file = null, now = Date.now(), cap = CG_DAILY_CAP, seed = null } = {}) {
  const today = dayOf(now), n = Object.fromEntries(SOURCES.map((s) => [s, 0])), pass = { ...n };
  let refused = 0, known = false; // known: the counts include today's earlier calls (a file or a seed of today was read)
  // a count of today: the larger one wins, except while nothing earlier was known: then the counts so far are
  // only this run's own (e.g. the pool list's before the scan read live.json), so they add up
  const take = (x) => {
    if (x?.day !== today) return;
    for (const s of SOURCES) n[s] = known ? Math.max(n[s], usedOf(x, s)) : n[s] + usedOf(x, s);
    known = known || x.known !== false;
  };
  if (file) { try { take(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* no file yet: today starts at the seed */ } }
  take(seed);
  const c = {
    today, cap,
    seed: take,
    used: (s = 'coingecko') => n[s],
    left: () => Math.max(0, cap - n.coingecko),
    // may one more call go to this source? Only CoinGecko is capped.
    allow: (s, { reserve = 0 } = {}) => s !== 'coingecko' || n.coingecko + Math.max(0, reserve) < cap,
    note(s) {
      if (!SOURCES.includes(s)) return;
      n[s]++; pass[s]++;
      if (s === 'coingecko') c.save(); // rare and precious: written at once, so a killed pass still counts it
    },
    // a fetcher that counts every call by host; CoinGecko over the budget (keeping `reserve`) throws a BudgetError
    wrap(getJson, { reserve = 0 } = {}) {
      return async (url, init, t) => {
        const s = sourceOf(url);
        if (s === 'coingecko' && !c.allow(s, { reserve })) { refused++; throw new BudgetError('coingecko daily'); }
        c.note(s);
        return getJson(url, init, t);
      };
    },
    refused: () => refused,
    pass: () => ({ ...pass }),
    health: () => ({ day: today, coingecko: { used: n.coingecko, cap }, defillama: n.defillama, coinbase: n.coinbase, geckoterminal: n.geckoterminal }),
    // counts only, for the public log
    line: () => `coingecko ${pass.coingecko} this pass (${n.coingecko} of ${cap} today${refused ? `, ${refused} refused by the budget` : ''}), defillama ${pass.defillama}, coinbase ${pass.coinbase}, geckoterminal ${pass.geckoterminal}`,
    save() {
      if (!file) return;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ v: 1, ...c.health(), known })); } catch { /* the live.json copy carries it */ }
    },
  };
  return c;
}
