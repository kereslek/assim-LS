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
// The monthly quota: once CoinGecko refuses for the month (a 4xx whose answer names the calls limit, e.g. 429 "You've
// reached 10,000 calls limit", or CG_STREAK.n 429s in a row over at least CG_STREAK.ms, longer than a busy
// minute lasts), coingecko.out = "YYYY-MM" travels with the counts and no CoinGecko call is made for the rest of
// that UTC month: allow('coingecko') is false and the readers' fallbacks serve. It clears itself on the 1st.
// A plain 500, a timeout or a busy-minute 429 ("Rate Limit") is not the quota.
import fs from 'node:fs';
import path from 'node:path';
import { BudgetError } from './budget.mjs';

export const CG_DAILY_CAP = 150;
export const CG_STREAK = Object.freeze({ n: 6, ms: 120e3 });
export const SOURCES = ['coingecko', 'defillama', 'coinbase', 'geckoterminal', 'kraken', 'okx', 'gate', 'kucoin'];
const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-11" → "1 Dec": the day the quota comes back
export const untilText = (month) => { const m = /^(\d{4})-(\d{2})$/.exec(String(month)); return m ? `1 ${MONTHS[Number(m[2]) % 12]}` : 'the 1st'; };

export function sourceOf(url) {
  let h = '';
  try { h = new URL(String(url)).hostname; } catch { return null; }
  if (/(^|\.)coingecko\.com$/.test(h)) return 'coingecko';
  if (/(^|\.)llama\.fi$/.test(h)) return 'defillama';
  if (/(^|\.)coinbase\.com$/.test(h)) return 'coinbase';
  if (/(^|\.)geckoterminal\.com$/.test(h)) return 'geckoterminal';
  if (/(^|\.)kraken\.com$/.test(h)) return 'kraken';
  if (/(^|\.)okx\.com$/.test(h)) return 'okx';
  if (/(^|\.)gateio\.ws$/.test(h)) return 'gate';
  if (/(^|\.)kucoin\.com$/.test(h)) return 'kucoin';
  return null;
}

// An error's HTTP status (lib/rpc.mjs getJson sets e.status; older errors carry it only in "HTTP 429"), or null.
export function statusOf(e) {
  const s = Number(e?.status);
  if (Number.isInteger(s) && s >= 100 && s < 600) return s;
  const m = /\bHTTP (\d{3})\b/.exec(String(e?.message || ''));
  return m ? Number(m[1]) : null;
}
// The monthly refusal: a 4xx whose answer names the calls limit, the month, credits, a quota or a plan/usage limit.
const QUOTA_TEXT = /calls? limit|month|credits?\b|quota|usage limit|plan limit|reached [\d,. ]+ calls/i;
export const quotaRefusal = (e) => { const s = statusOf(e); return s != null && s >= 400 && s < 500 && QUOTA_TEXT.test(String(e?.body ?? '')); };

const usedOf = (x, s) => (s === 'coingecko' ? (isNum(x?.coingecko?.used) ? x.coingecko.used : isNum(x?.coingecko) ? x.coingecko : 0) : isNum(x?.[s]) ? x[s] : 0);

export function makeApiCounter({ file = null, now = Date.now(), cap = CG_DAILY_CAP, seed = null, clock = Date.now } = {}) {
  const today = dayOf(now), month = monthOf(now), n = Object.fromEntries(SOURCES.map((s) => [s, 0])), pass = { ...n };
  let refused = 0, refusedOut = 0, known = false; // known: the counts include today's earlier calls (a file or a seed of today was read)
  let out = null, outWhy = null; // the month CoinGecko's quota ran out, and how this process knows it
  let streak = { n: 0, t0: null, t1: null }; // CoinGecko 429s in a row (carried in the file: the pool list, then the scan)
  // the quota mark holds for its whole month, whatever the day; a mark of an earlier month is ignored (cleared)
  const takeOut = (x) => { if (out == null && x?.coingecko?.out === month) { out = month; outWhy = 'carried'; } };
  // a count of today: the larger one wins, except while nothing earlier was known: then the counts so far are
  // only this run's own (e.g. the pool list's before the scan read live.json), so they add up
  const take = (x) => {
    takeOut(x);
    if (x?.day !== today) return;
    for (const s of SOURCES) n[s] = known ? Math.max(n[s], usedOf(x, s)) : n[s] + usedOf(x, s);
    known = known || x.known !== false;
  };
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      take(j);
      const s = j?.cg429;
      if (s && isNum(s.n) && isNum(s.t0) && isNum(s.t1) && s.t1 >= s.t0 && clock() - s.t1 < 3600e3) streak = { n: s.n, t0: s.t0, t1: s.t1 };
    } catch { /* no file yet: today starts at the seed */ }
  }
  take(seed);
  const isOut = () => out === month;
  const c = {
    today, cap, month,
    seed: take,
    used: (s = 'coingecko') => n[s],
    left: () => (isOut() ? 0 : Math.max(0, cap - n.coingecko)),
    // may one more call go to this source? Only CoinGecko is capped (by the day's budget and the month's quota).
    allow: (s, { reserve = 0 } = {}) => s !== 'coingecko' || (!isOut() && n.coingecko + Math.max(0, reserve) < cap),
    isOut,
    // the public log's line while the quota is out (no key, no URL), else null
    outLine: () => (isOut() ? `coingecko: monthly quota out until ${untilText(month)}; fallbacks serving` : null),
    note(s) {
      if (!SOURCES.includes(s)) return;
      n[s]++; pass[s]++;
      if (s === 'coingecko') c.save(); // rare and precious: written at once, so a killed pass still counts it
    },
    // what CoinGecko answered: an answer ends a run of 429s; the quota's refusal (or a long run of 429s) marks the month
    answered() { if (streak.n) { streak = { n: 0, t0: null, t1: null }; c.save(); } },
    refusal(e) {
      if (quotaRefusal(e)) return c.markOut('the refusal names the calls limit');
      if (statusOf(e) !== 429) return; // a 500, a 404, a timeout: not the quota
      const t = clock();
      streak = { n: streak.n + 1, t0: streak.t0 ?? t, t1: t };
      if (streak.n >= CG_STREAK.n && streak.t1 - streak.t0 >= CG_STREAK.ms) return c.markOut(`${streak.n} refusals in a row over ${Math.round((streak.t1 - streak.t0) / 60e3)} min`);
      c.save();
    },
    markOut(why = 'marked') { if (isOut()) return; out = month; outWhy = why; c.save(); },
    // a fetcher that counts every call by host; CoinGecko over the budget (keeping `reserve`) throws a BudgetError,
    // and so does every CoinGecko call while the month's quota is out (not sent, not counted)
    wrap(getJson, { reserve = 0 } = {}) {
      return async (url, init, t) => {
        const s = sourceOf(url);
        if (s === 'coingecko' && isOut()) { refusedOut++; throw new BudgetError('coingecko monthly'); }
        if (s === 'coingecko' && !c.allow(s, { reserve })) { refused++; throw new BudgetError('coingecko daily'); }
        c.note(s);
        if (s !== 'coingecko') return getJson(url, init, t);
        let j;
        try { j = await getJson(url, init, t); } catch (e) { c.refusal(e); throw e; }
        c.answered();
        return j;
      };
    },
    refused: () => refused,
    pass: () => ({ ...pass }),
    health: () => ({ day: today, coingecko: { used: n.coingecko, cap, out: isOut() ? out : null }, ...Object.fromEntries(SOURCES.slice(1).map((s) => [s, n[s]])) }),
    // counts only, for the public log
    line: () => `coingecko ${pass.coingecko} this pass (${n.coingecko} of ${cap} today${refused ? `, ${refused} refused by the budget` : ''}` +
      `${isOut() ? `; monthly quota out until ${untilText(month)}${outWhy === 'carried' ? ' (carried)' : ` (found this run: ${outWhy})`}, ${refusedOut} calls not made` : ''}), ` +
      SOURCES.slice(1).map((s) => `${s} ${pass[s]}`).join(', '),
    save() {
      if (!file) return;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ v: 1, ...c.health(), known, ...(streak.n ? { cg429: streak } : {}) })); } catch { /* the live.json copy carries it */ }
    },
  };
  return c;
}
