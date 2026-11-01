// Daily USD price history from DefiLlama's chart API, many coins per call. Keys look like
// "ethereum:0x…". A coin the API doesn't return is absent (unread), never a flat line.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseChart(json) {
  const out = new Map();
  for (const [k, v] of Object.entries(json?.coins || {})) {
    const pts = (v?.prices || []).filter((p) => p && p.price > 0 && Number.isFinite(p.timestamp)).map((p) => ({ t: p.timestamp, price: p.price }));
    if (pts.length) out.set(k.toLowerCase(), pts.sort((a, b) => a.t - b.t));
  }
  return out;
}

export async function dailyHistory(getJson, keys, { days = 31, now = Math.floor(Date.now() / 1000), batch = 30, spacingMs = 1200, tries = 3 } = {}) {
  const out = new Map(), unread = [];
  let lastError = null;
  const start = now - days * 86400;
  for (let i = 0; i < keys.length; i += batch) {
    const part = keys.slice(i, i + batch);
    let j = null;
    for (let k = 0; k < tries && !j; k++) {
      try { j = await getJson(`https://coins.llama.fi/chart/${part.join(',')}?start=${start}&span=${days + 1}&period=1d&searchWidth=600`, {}, 30000); } catch (e) { lastError = String(e?.message || e).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 30); await pause(spacingMs * 3 * 2 ** k); }
    }
    if (!j) { unread.push(...part); continue; }
    for (const [k, v] of parseChart(j)) out.set(k, v);
    await pause(spacingMs);
  }
  return { series: out, unread, lastError };
}
