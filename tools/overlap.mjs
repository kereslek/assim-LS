// Text that collides, or is cut off by the box around it: an in-page check shared by tools/site-test.mjs (made-up
// fixtures) and tools/live-audit.mjs (the deployed page, real data). Run it with page.evaluate(TEXT_OVERLAP, opts).
//
// For every visible text node it takes the rendered line boxes (Range.getClientRects; an SVG <text> gives its own box),
// trims them to what their scroll and clip boxes still show, and reports
//   overlap  two texts (or an icon-only control's glyph) from unrelated elements drawn on top of each other, inside the
//            same layer: the page, the detail panel, a pop-up note, the search list, a sticky header copy and the bar on
//            top are layers of their own (one layer covering another is intended)
//   clip     text cut by a box that hides overflow (scroll boxes and an ellipsis are fine: those are intended)
// Line boxes carry the font's leading, so each is trimmed by 16% top and bottom before the test, and a collision needs
// more than a pixel both ways.
// opts.root: a selector to check under (default the body). opts.safe: report sections and element kinds (tag and first
// class) only, never text: the live audit runs on real data.
export const TEXT_OVERLAP = (opts = {}) => {
  const out = [], root = (opts.root && document.querySelector(opts.root)) || document.body;
  const LAYERS = '#pop, #ctip, #q-list, .sh, #sheet, .pz-hint, #totop, header.top, .mc-nav';
  const seen = (el) => {
    if (el.closest('[hidden], template, script, style, noscript, option, select, textarea')) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1 && cs.overflow === 'hidden') return false; // read aloud only (a visually hidden label)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  const secOf = (el) => {
    const c = el.closest('[data-chartbox]');
    if (c) return 'chart ' + c.dataset.chartbox;
    const s = el.closest('#pop, #q-list, .sh, .sheet-head, #sheet-body, header, #subhead, footer, section[id], aside[id], #banner, #lockscreen, #loaderr, .totop');
    if (!s) return 'page';
    return s.id ? '#' + s.id : s.tagName.toLowerCase() + (typeof s.className === 'string' && s.className ? '.' + s.className.split(' ')[0] : '');
  };
  const cls = (el) => (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '').split(' ')[0];
  // an element's tag and first class (public page structure); its text only off the live page
  const desc = (el, txt) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (cls(el) ? '.' + cls(el) : '')) + (txt && !opts.safe ? ' "' + txt.trim().replace(/\s+/g, ' ').slice(0, 24) + '"' : '');
  // the boxes that clip a text: any ancestor that hides overflow (html and body never count)
  const clipOf = (start) => {
    const list = [];
    for (let a = start; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const svg = a.tagName.toLowerCase() === 'svg';
      const r = a.getBoundingClientRect(), bl = a.clientLeft || 0, bt = a.clientTop || 0;
      const box = svg ? r : { left: r.left + bl, top: r.top + bt, right: r.left + bl + (a.clientWidth || r.width), bottom: r.top + bt + (a.clientHeight || r.height) };
      const scroll = (/auto|scroll/.test(cs.overflowX + cs.overflowY) && !a.matches('.mpx')) || a.matches('.sh-in, .qhint');
      list.push({ a, box, scroll });
      if (cs.position === 'fixed') break;
    }
    return list;
  };
  const items = [], cache = new Map();
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? 1 : 2) });
  for (let n; (n = tw.nextNode());) {
    const el = n.parentElement;
    if (!el || !seen(el)) continue;
    const svgT = el.closest('svg') ? el.closest('text') || el : null;
    let rects;
    if (svgT) rects = [svgT.getBoundingClientRect()];
    else { const rg = document.createRange(); rg.selectNodeContents(n); rects = [...rg.getClientRects()]; }
    rects = rects.filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const host = svgT || el;
    let clips = cache.get(host);
    if (!clips) { clips = clipOf(svgT ? svgT.parentElement : el); cache.set(host, clips); }
    // a table's sticky first column covers the cells scrolled under it
    const cell = el.closest('td, th'), tb = cell && cell.closest('.tbl-box');
    let stickR = null;
    if (cell && tb && cell.cellIndex > 0 && tb.scrollLeft > 0) { const f = cell.parentElement.cells[0]; if (f && getComputedStyle(f).position === 'sticky') stickR = f.getBoundingClientRect().right; }
    let ell = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).textOverflow === 'ellipsis') { ell = true; break; }
    for (const r0 of rects) {
      let r = { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom };
      if (stickR != null) r.left = Math.max(r.left, stickR);
      let cut = null;
      for (const c of clips) {
        const nr = { left: Math.max(r.left, c.box.left), top: Math.max(r.top, c.box.top), right: Math.min(r.right, c.box.right), bottom: Math.min(r.bottom, c.box.bottom) };
        if (nr.right - nr.left < 0.5 || nr.bottom - nr.top < 0.5) { r = null; break; }
        const lost = r.right - r.left - (nr.right - nr.left) > 1.5 || r.bottom - r.top - (nr.bottom - nr.top) > Math.max(2, (r.bottom - r.top) * 0.25);
        if (lost && !c.scroll && !cut) cut = c.a;
        r = nr;
      }
      if (!r) continue;
      if (cut && !ell) out.push({ kind: 'clip', sec: secOf(el), a: desc(el, n.nodeValue), b: desc(cut) });
      if (r.right - r.left < 1) continue;
      items.push({ el: host, txt: n.nodeValue, layer: host.closest(LAYERS), r });
    }
  }
  // icon-only controls: their glyph counts like text
  for (const b of root.querySelectorAll('button, a[href], [role="button"]')) {
    if (b.textContent.trim() || !seen(b)) continue;
    const g = b.querySelector('svg');
    if (!g) continue;
    const r0 = g.getBoundingClientRect();
    if (r0.width < 1 || r0.height < 1) continue;
    items.push({ el: b, txt: '', icon: true, layer: b.closest(LAYERS), r: { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom } });
  }
  const ins = (r, icon) => { const h = r.bottom - r.top, k = icon ? 0.1 : 0.16; return { l: r.left + 0.5, r: r.right - 0.5, t: r.top + h * k, b: r.bottom - h * k }; };
  const A = items.map((it) => ({ ...it, q: ins(it.r, it.icon) })).sort((x, y) => x.q.t - y.q.t);
  const pairs = new Set(), ids = new Map(), eid = (e) => { if (!ids.has(e)) ids.set(e, ids.size); return ids.get(e); };
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    for (let j = i + 1; j < A.length && A[j].q.t < a.q.b; j++) {
      const b = A[j];
      if (a.el === b.el || a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.q.r, b.q.r) - Math.max(a.q.l, b.q.l), h = Math.min(a.q.b, b.q.b) - Math.max(a.q.t, b.q.t);
      if (w <= 1 || h <= 1) continue;
      const k = Math.min(eid(a.el), eid(b.el)) + ':' + Math.max(eid(a.el), eid(b.el));
      if (pairs.has(k)) continue;
      pairs.add(k);
      out.push({ kind: 'overlap', sec: secOf(a.el), a: desc(a.el, a.txt), b: desc(b.el, b.txt) });
    }
  }
  return out;
};
