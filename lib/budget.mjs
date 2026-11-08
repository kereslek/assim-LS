// Read budgets for the parts added after Ethereum's Uniswap list (Base, PancakeSwap, flow quality, the
// exchange screen, the discovery lanes): each part of a pass gets a time limit and a call limit, and what it
// could not read within them is null ("not read"), never a guess, never a zero and never a pass that runs over.
// A budget only says no before a call starts: a call already in flight finishes (within its own timeout).
// Ethereum's Uniswap parts take no budget (UNLIMITED), so their behaviour and timings stay as they were.
//
//   const b = makeBudget({ ms: 60e3, calls: 400 });
//   if (b.take()) { ... one call ... }        // false once the time or the calls are spent
//   b.over(), b.why() → 'time' | 'calls' | null, b.used(), b.elapsed(), b.note() → "12 s, 40 calls" (+ " (time cap)")
//
// capRpc / capGetJson wrap an RPC (lib/rpc.mjs makeRpc) or a fetcher so that every call spends the budget, and
// once it is spent answer what a refused call answers: null (RPC) or a thrown BudgetError (fetcher), which the
// callers already read as unread. isBudgetError tells retry loops not to wait for an answer that cannot come.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export class BudgetError extends Error {
  constructor(why) { super(`budget ${why || 'spent'}`); this.budget = true; }
}
export const isBudgetError = (e) => !!(e && e.budget === true);

export function makeBudget({ ms = Infinity, calls = Infinity, clock = Date.now } = {}) {
  const t0 = clock();
  let used = 0, why = null;
  const over = () => {
    if (why) return true;
    if (isNum(ms) && clock() - t0 >= ms) why = 'time';
    else if (isNum(calls) && used >= calls) why = 'calls';
    return why != null;
  };
  return {
    ms, calls,
    over,
    // permission for n more calls; false once the budget is spent (the calls then are not made)
    take(n = 1) { if (over()) return false; used += n; return true; },
    used: () => used,
    elapsed: () => clock() - t0,
    left: () => (isNum(ms) ? Math.max(0, ms - (clock() - t0)) : Infinity),
    why: () => (over(), why),
    // for the public log: seconds and calls, and which cap stopped the part
    note() { over(); return `${Math.round((clock() - t0) / 1000)} s, ${used} calls${why ? ` (${why} cap)` : ''}`; },
  };
}

// Never spent: Ethereum's Uniswap parts.
export const UNLIMITED = Object.freeze({ ms: Infinity, calls: Infinity, over: () => false, take: () => true, used: () => 0, elapsed: () => 0, left: () => Infinity, why: () => null, note: () => 'no cap' });

// An RPC whose calls spend the budget: call / callWho / ethCall one each, batch one per post (batchSize requests
// a post, as lib/rpc.mjs sends them) and one per item a post left unanswered, retried one by one as lib/rpc.mjs
// does. Spent: null, as an RPC nobody answered.
export function capRpc(rpc, budget, { batchSize = 50 } = {}) {
  if (!budget || budget === UNLIMITED) return rpc;
  const callWho = async (method, params, exclude) => (budget.take() ? rpc.callWho(method, params, exclude) : { result: null, url: null });
  const call = async (method, params) => (await callWho(method, params)).result;
  async function batch(reqs) {
    const out = new Array(reqs.length).fill(null);
    for (let off = 0; off < reqs.length; off += batchSize) {
      if (!budget.take()) break;
      const part = reqs.slice(off, off + batchSize);
      const got = await rpc.batch(part, { retryEach: false });
      for (let i = 0; i < part.length; i++) out[off + i] = got?.[i] ?? (await call(part[i].method, part[i].params));
    }
    return out;
  }
  const ethCall = (to, data, tag = 'latest') => call('eth_call', [{ to, data }, tag]);
  return { ...rpc, call, callWho, batch, ethCall, budget };
}

// A fetcher (lib/rpc.mjs getJson) whose calls spend the budget; spent: throws BudgetError (unread).
export function capGetJson(getJson, budget) {
  if (!budget || budget === UNLIMITED) return getJson;
  return async (...args) => {
    if (!budget.take()) throw new BudgetError(budget.why());
    return getJson(...args);
  };
}
