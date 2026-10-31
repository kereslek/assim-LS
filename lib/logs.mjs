// Event logs two ways. pageLogs walks an Etherscan-style API (Blockscout free, or Etherscan with a
// key) that returns at most 1000 logs a call, by moving fromBlock to the last block seen and
// de-duplicating the overlap. rpcLogs reads eth_getLogs in fixed chunks. Either way an unread
// stretch makes the result incomplete or null, never "no events".

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hexNum = (x) => (typeof x === 'number' ? x : parseInt(x, 16));

export async function pageLogs(getJson, { base, address, topic0, fromBlock, toBlock, pageSize = 1000, spacingMs = 300, tries = 3, maxCalls = 1500, apiKey } = {}) {
  const logs = [], seen = new Set();
  let from = fromBlock, calls = 0;
  while (from <= toBlock) {
    if (calls >= maxCalls) return { logs, complete: false, calls, reason: 'budget', reached: from };
    const url = `${base}?module=logs&action=getLogs&address=${address}&fromBlock=${from}&toBlock=${toBlock}` +
      (topic0 ? `&topic0=${topic0}` : '') + `&page=1&offset=${pageSize}` + (apiKey ? `&apikey=${apiKey}` : '');
    let j = null;
    for (let i = 0; i < tries && j == null; i++) {
      try { j = await getJson(url, { headers: { accept: 'application/json' } }, 45000); } catch { await pause(spacingMs * 5 * 2 ** i); }
    }
    calls++;
    if (!j) return { logs, complete: false, calls, reason: 'unanswered', reached: from };
    const rows = Array.isArray(j.result) ? j.result : null;
    if (!rows) return { logs, complete: false, calls, reason: 'refused', reached: from };
    if (rows.length === 0) break;
    let last = from, sorted = true, prev = -1;
    for (const l of rows) {
      const b = hexNum(l.blockNumber);
      if (b < prev) sorted = false;
      prev = b; last = Math.max(last, b);
      const k = l.transactionHash + ':' + hexNum(l.logIndex);
      if (!seen.has(k)) { seen.add(k); logs.push(l); }
    }
    if (!sorted) return { logs, complete: false, calls, reason: 'unsorted', reached: from };
    if (rows.length < pageSize) break;
    if (last === from) return { logs, complete: false, calls, reason: 'dense block', reached: from };
    from = last; // the same block again: de-duplication handles the overlap
    await pause(spacingMs);
  }
  return { logs, complete: true, calls, reached: toBlock };
}

export async function rpcLogs(rpc, filter, from, to, step = 10000) {
  const out = [];
  for (let a = from; a <= to; a += step) {
    const r = await rpc.call('eth_getLogs', [{ ...filter, fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(to, a + step - 1).toString(16) }]);
    if (!Array.isArray(r)) return null;
    out.push(...r);
  }
  return out;
}
