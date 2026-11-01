// eth_getLogs over a long range: the range is cut into segments read side by side, and each
// segment walks forward in chunks that halve when a node refuses. Returns all logs, or null if any
// stretch stayed unread: an unread stretch is never "no events".
// Keep chunks at most 9,000 blocks on Ethereum: on a first live run, chunks allowed to grow past
// that came back short without any error (60 of 228 events in a week). A chunk that returns
// maxLogs or more is treated as possibly cut off and read again in halves.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function logsAdaptive(rpc, filter, from, to, { step = 1000, minStep = 25, maxStep = step, segments = 1, growBelow = 2000, maxLogs = 5000, retries = 0, waitMs = 2000 } = {}) {
  if (to < from) return [];
  const span = to - from + 1, per = Math.ceil(span / segments);
  const parts = Array.from({ length: Math.min(segments, span) }, (_, i) => [from + i * per, Math.min(to, from + (i + 1) * per - 1)]).filter(([a, b]) => a <= b);
  async function walk([a, b]) {
    const out = [];
    let x = a, s = step, tries = 0;
    while (x <= b) {
      const y = Math.min(b, x + s - 1);
      const r = await rpc.call('eth_getLogs', [{ ...filter, fromBlock: '0x' + x.toString(16), toBlock: '0x' + y.toString(16) }]);
      if (Array.isArray(r) && r.length >= maxLogs && s > minStep) { s = Math.max(minStep, Math.floor(s / 2)); continue; }
      if (Array.isArray(r)) {
        out.push(...r);
        x = y + 1;
        tries = 0;
        if (r.length < growBelow && s < maxStep) s = Math.min(maxStep, s * 2);
        continue;
      }
      if (tries < retries) { tries++; await pause(waitMs * 2 ** (tries - 1)); continue; } // a busy moment: wait, then try the same chunk
      tries = 0;
      if (s <= minStep) return null;
      s = Math.max(minStep, Math.floor(s / 2));
    }
    return out;
  }
  const res = await Promise.all(parts.map(walk));
  return res.some((r) => r == null) ? null : res.flat();
}
