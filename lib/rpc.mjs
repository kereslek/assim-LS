// JSON-RPC across several public endpoints. The first real result wins; a failure is null,
// never a default value ("missing is never zero").

export async function getJson(url, init = {}, timeout = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { ...init, signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Run fn over items with at most n in flight; results keep their order.
export async function mapLimit(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}

// An endpoint is dropped after maxRefusals failures in a row; any answer resets its count, so one
// rate-limited moment doesn't cost a node that has been serving.
export function makeRpc(urls, { timeout = 12000, maxRefusals = 3, batchSize = 50 } = {}) {
  const refusals = new Map(), served = new Map();
  const live = () => urls.filter((u) => (refusals.get(u) || 0) < maxRefusals);
  const refuse = (u) => refusals.set(u, (refusals.get(u) || 0) + 1);
  const serve = (u) => { refusals.set(u, 0); served.set(u, (served.get(u) || 0) + 1); };
  const post = (u, body) => getJson(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeout);

  // callWho also says which endpoint answered, and can skip some: { result, url } or { result: null }.
  async function callWho(method, params, exclude = []) {
    for (const u of live()) {
      if (exclude.includes(u)) continue;
      try {
        const r = await post(u, { jsonrpc: '2.0', id: 1, method, params });
        if (r && r.result !== undefined && !r.error) { serve(u); return { result: r.result, url: u }; }
        refuse(u);
      } catch {
        refuse(u);
      }
    }
    return { result: null, url: null };
  }
  const call = async (method, params) => (await callWho(method, params)).result;

  // Batched calls; any request a batch did not answer is retried one by one. Unanswered stays null.
  async function batch(reqs) {
    const out = new Array(reqs.length).fill(null);
    for (let off = 0; off < reqs.length; off += batchSize) {
      const chunk = reqs.slice(off, off + batchSize);
      let done = false;
      for (const u of live()) {
        try {
          const r = await post(u, chunk.map((q, i) => ({ jsonrpc: '2.0', id: i, method: q.method, params: q.params })));
          if (!Array.isArray(r)) { refuse(u); continue; }
          serve(u);
          for (const item of r) {
            if (item && item.result !== undefined && !item.error && Number.isInteger(item.id) && item.id < chunk.length) out[off + item.id] = item.result;
          }
          done = true;
          break;
        } catch {
          refuse(u);
        }
      }
      if (!done || chunk.some((_, i) => out[off + i] === null)) {
        for (let i = 0; i < chunk.length; i++) {
          if (out[off + i] === null) out[off + i] = await call(chunk[i].method, chunk[i].params);
        }
      }
    }
    return out;
  }

  const ethCall = (to, data, tag = 'latest') => call('eth_call', [{ to, data }, tag]);
  return { call, callWho, batch, ethCall, refusals, served, live };
}
