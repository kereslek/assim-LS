// v0.4.5 part 2: the competition flash (owner's pick A): the pair's other pools flash onto the detail's chart once, a ghost
// of the whole pair stays behind this pool's bars, and a badge says how much liquidity the others hold near the price
import fs from 'node:fs';
const F = process.argv[2];
let h = fs.readFileSync(F, 'utf8');
const rep = (a, b) => { const n = h.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 90)}`); h = h.replace(a, () => b); };

// ---------------- CSS ----------------
rep(".mgline>span{white-space:nowrap}\n",
  ".mgline>span{white-space:nowrap}\n"
  + "/* the competition flash (v0.4.5): chips light up in turn, a gold banner while the stack holds, then a badge */\n"
  + ".mgc.fl-on{color:var(--fg)}\n.mgc.fl-on::before{border-color:var(--c);box-shadow:inset 0 0 0 1px var(--c)}\n.mgc.fl-on .sq{opacity:1}\n"
  + ".cmp{display:grid;margin:0 0 6px;font:600 10.5px/1.35 var(--mono)}\n"
  + ".cmp>*{grid-area:1/1;margin:0;align-self:center;min-width:0}\n"
  + ".cmp-ban{padding:4px 8px;border-radius:8px;border:1px solid var(--gold);background:rgba(232,184,74,.12);color:var(--gold);font-weight:500;visibility:hidden;opacity:0;transition:opacity .2s ease,visibility 0s linear .2s}\n"
  + ".cmp-ban b{color:#fff;font-weight:700}\n"
  + ".cmp.ban .cmp-ban{visibility:visible;opacity:1;transition:opacity .2s ease}\n"
  + ".cmp.ban .cmp-b{visibility:hidden}\n"
  + ".cmp-b{justify-self:start;display:inline-flex;align-items:center;flex-wrap:wrap;gap:0 4px;min-height:44px;margin:-11px 0;padding:0 9px;border:0;background:transparent;color:var(--gold);font:inherit;text-align:left;cursor:pointer;position:relative}\n"
  + ".cmp-b::before{content:\"\";position:absolute;inset:11px 0;border:1px solid rgba(232,184,74,.5);border-radius:999px;pointer-events:none}\n"
  + ".cmp-b u{color:var(--accent)}\n"
  + "span.cmp-b{cursor:default}\n"
  + ".cmp-b:focus-visible{outline:none}.cmp-b:focus-visible::before{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}\n"
  + ".sw.gh{width:14px;height:0;border-radius:0;border-top:1.5px dashed #AAB4C0;align-self:center}\n"
  + "@media (prefers-reduced-motion:reduce){.cmp-ban,.cmp.ban .cmp-ban{transition:none}}\n");

// ---------------- glossary ----------------
rep("  watchdog: ['Watchdog last restart',",
  "  ghost: ['Whole pair', 'The dashed outline: every pool of this pair stacked bar by bar (its other fee tiers, v3 and v4, other chains). The solid bars are this pool. Tap a chip above the chart to stack one in its own colour.'],\n"
  + "  watchdog: ['Watchdog last restart',");

// ---------------- liqChart: every other pool onto this pool's bars, the ghost, the badge ----------------
rep("function liqChart(p, w, id) {",
  "const frScale = (f, k) => (k === 1 ? f : { v: f.v * k, a: f.a, b: f.b, at: (x) => f.at(x) * k });\n"
  + "const frJoin = (frs) => (!frs.length ? null : frs.length === 1 ? frs[0] : { v: sum(frs.map((f) => f.v)), a: Math.min(...frs.map((f) => f.a)), b: Math.max(...frs.map((f) => f.b)), at: (x) => sum(frs.map((f) => f.at(x))) });\n"
  + "function liqChart(p, w, id) {");
rep("  const mg = [], parts = [{ p, col: '#16C784', v9: mgBand(ext.bars, fr0), self: true }];\n  peers.forEach((q, k) => {\n    if (!on.includes(q.id)) return;\n    const src = mgSrc(q, mgFlip(p, q)), col = MG_COL[k % MG_COL.length];\n    parts.push({ p: q, col, v9: src ? mgBand(src.bars, src.fr) : null });\n    if (src) mg.push({ id: q.id, col, v: mgOnto(src, ext.bars), fr: src.fr });\n  });\n",
  "  const mg = [], parts = [{ p, col: '#16C784', v9: mgBand(ext.bars, fr0), self: true }], every = [];\n"
  + "  peers.forEach((q, k) => { // every other pool of the pair onto this pool's bars: the stack (its chip on), the flash, the ghost\n"
  + "    const src = mgSrc(q, mgFlip(p, q)), col = MG_COL[k % MG_COL.length], m = src ? { id: q.id, col, v: mgOnto(src, ext.bars), fr: src.fr } : null;\n"
  + "    if (m) every.push(m);\n"
  + "    if (!on.includes(q.id)) return;\n"
  + "    parts.push({ p: q, col, v9: src ? mgBand(src.bars, src.fr) : null });\n"
  + "    if (m) mg.push(m);\n"
  + "  });\n"
  + "  // the ghost (v0.4.5): the whole pair stacked, bar by bar; unknown (not drawn) where this pool's bar or another's wasn't read\n"
  + "  const ghost = every.length ? ext.bars.map((b, i) => (isNum(b.v) && every.every((m) => isNum(m.v[i])) ? b.v + sum(every.map((m) => m.v[i])) : null)) : null;\n");
rep("  const fr = !frs.length ? null : frs.length === 1 ? frs[0] : { v: sum(frs.map((f) => f.v)), a: Math.min(...frs.map((f) => f.a)), b: Math.max(...frs.map((f) => f.b)), at: (x) => sum(frs.map((f) => f.at(x))) };\n",
  "  const fr = frJoin(frs);\n");
rep("    key, p, w, depth, unread, fr, mg, ex: ext, sp, kind: 'liq',",
  "    key, p, w, depth, unread, fr, fr0, mg, every, ghost, ex: ext, sp, kind: 'liq',");
rep("    + (mg.length ? mg.map((m) => `<span><i class=\"sw\" style=\"background:${m.col}\"></i>${mgLabel(poolById(m.id))}</span>`).join('') : '')",
  "    + (ghost ? termB('ghost', `<span><i class=\"sw gh\"></i>Whole pair · ${every.length + 1} pools</span>`) : '')\n"
  + "    + (mg.length ? mg.map((m) => `<span><i class=\"sw\" style=\"background:${m.col}\"></i>${mgLabel(poolById(m.id))}</span>`).join('') : '')");
rep("  return (peers.length ? mgChips(p, peers) : '') + pzShell(id, 'liq') + mgl",
  "  return (peers.length ? mgChips(p, peers) : '') + (id === 'liq-detail' || id === 'liq-best' ? cmpHtml(p, id, cmpOf(p)) : '') + pzShell(id, 'liq') + mgl");
rep("peers.map((q, k) => `<button type=\"button\" class=\"mgc\" data-act=\"merge\"",
  "peers.map((q, k) => `<button type=\"button\" class=\"mgc${S.fl && S.fl.for === p.id && S.fl.st.lit[q.id] ? ' fl-on' : ''}\" data-act=\"merge\"");

// ---------------- liqInner: the stack with the flash's shares, the band from what is stacked, the ghost behind ----------------
rep("  const P = PZ[id], { p, w, depth, unread, fr } = P, ext = P.ex,",
  "  const P = PZ[id], { p, w, depth, unread } = P, ext = P.ex,");
rep("  const mg = P.mg || [], bars = ext.bars, stk = (i) => (isNum(bars[i].v) ? bars[i].v : 0) + sum(mg.map((m) => (isNum(m.v[i]) ? m.v[i] : 0)));\n  const want = Math.max(1, ...bars.map((b, i) => (seen(b) ? (stk(i) * ext.step) / (b.b - b.a) : 0)));\n",
  "  // the stack: chips that are on at full height; while the competition flash plays, the others at its share (0..1)\n"
  + "  const fx = id === 'liq-detail' && S.fl && S.fl.for === p.id ? S.fl.st : null, onIds = new Set((P.mg || []).map((m) => m.id));\n"
  + "  const mg = (P.every || P.mg || []).map((m) => ({ ...m, f: onIds.has(m.id) ? 1 : fx ? fx.a[m.id] || 0 : 0 })).filter((m) => m.f > 1e-3);\n"
  + "  const fr = frJoin([P.fr0, ...mg.map((m) => m.fr && frScale(m.fr, m.f))].filter(Boolean));\n"
  + "  const bars = ext.bars, stk = (i) => (isNum(bars[i].v) ? bars[i].v : 0) + sum(mg.map((m) => (isNum(m.v[i]) ? m.v[i] * m.f : 0)));\n"
  + "  const dn = (v, b) => (v * ext.step) / (b.b - b.a);\n"
  + "  let want = Math.max(1, ...bars.map((b, i) => (seen(b) ? dn(stk(i), b) : 0)));\n"
  + "  if (P.ghost) { // one scale for the whole pair, so its ghost fits: this pool's tallest bar stays at least a quarter of the height\n"
  + "    const own = Math.max(1, ...bars.map((b) => (seen(b) && isNum(b.v) ? dn(b.v, b) : 0)));\n"
  + "    const gw = Math.max(0, ...bars.map((b, i) => (seen(b) && isNum(P.ghost[i]) ? dn(P.ghost[i], b) : 0)));\n"
  + "    want = Math.max(want, Math.min(gw, GH_CAP * own));\n"
  + "  }\n");
rep("      const v = m.v[i];\n      if (v === null) { const a = X(",
  "      const v = m.v[i] === null ? null : m.v[i] * m.f;\n      if (v === null) { if (m.f < 1) return; const a = X(");
rep("  s += `<path fill=\"#3A4452\" d=\"${pout}\"/>",
  "  // the ghost: a dashed outline of the whole pair's stack behind this pool's bars (it fades in as the flash ends)\n"
  + "  const ga = P.ghost ? (fx ? fx.ghost : 1) : 0;\n"
  + "  if (ga > 0.01) {\n"
  + "    const fA = frJoin([P.fr0, ...P.every.map((m) => m.fr)].filter(Boolean)), hA = fA && Math.min(v1, fA.b) > Math.max(v0, fA.a) ? clamp(((fA.at(0) * ext.step) / max) * (VH - 4), 2, 12) : 0, bA = VH - hA;\n"
  + "    let d = '', open = false;\n"
  + "    bars.forEach((b, i) => {\n"
  + "      const g = P.ghost[i];\n"
  + "      if (!seen(b) || !isNum(g)) { if (open) { d += `V${bA.toFixed(1)}`; open = false; } return; }\n"
  + "      const y = Math.max(0.8, bA - (g > 0 ? (dn(g, b) / max) * (VH - 4 - hA) : 0));\n"
  + "      d += (open ? '' : `M${X(b.a).toFixed(1)} ${bA.toFixed(1)}`) + `V${y.toFixed(1)}H${X(b.b).toFixed(1)}`; open = true;\n"
  + "    });\n"
  + "    if (open) d += `V${bA.toFixed(1)}`;\n"
  + "    if (d) s += `<path class=\"ghost\" d=\"${d}\" fill=\"none\" stroke=\"#AAB4C0\" stroke-width=\"1.2\" stroke-dasharray=\"3 3\" vector-effect=\"non-scaling-stroke\" opacity=\"${(0.85 * ga).toFixed(2)}\"/>`;\n"
  + "  }\n"
  + "  s += `<path fill=\"#3A4452\" d=\"${pout}\"/>");

// ---------------- the flash itself ----------------
rep("function liqChart(p, w, id) {",
  `// ---------- the competition flash (owner's pick A, v0.4.5) ----------
// A pool's detail with other pools of the same pair plays this once per pool in the page's life (the pop-out window is a page
// of its own): 0–0.6 s the others' chips light up in turn and their bars grow onto this pool's (the 1A stack), the stack holds
// with a gold banner from 0.8 s, from 2.6 s it fades back to this pool alone while a dashed ghost of the whole pair fades in,
// done at 3.5 s. Any tap, key, wheel or close ends it at once on that end state; under reduced motion it never plays. The
// badge (this pool's detail, the best-find card) says how many other pools and how much liquidity they hold within ±9% of
// the price against this pool's: X = others ÷ this (each pool's own ±9%, the full-range layer's share in). A pool whose
// map wasn't read leaves the others' sum a floor: "≥ X×". The stack always comes back to the chips' own state.
const FL_MS = 3500, FL_GROW = 600, FL_HOLD = 600, FL_BAN = 800, FL_FADE = 2600, GH_CAP = 4;
const FL_SEEN = new Set();
const NOFLASH = window.__lpsNoFlash === true; // browser tests of other features turn the auto-play off (made-up fixtures)
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function flAt(t, ids) { // the flash at t ms: each other pool's share of its height, which chips are lit, the banner, the ghost
  const n = Math.max(1, ids.length), d = FL_GROW / n, a = {}, lit = {}, fade = clamp((t - FL_FADE) / (FL_MS - FL_FADE), 0, 1);
  ids.forEach((id, k) => {
    a[id] = t < FL_FADE ? easeIO(clamp((t - k * d) / d, 0, 1)) : 1 - easeIO(fade);
    lit[id] = t >= k * d && fade < 0.5;
  });
  return { a, lit, ban: t >= FL_BAN && t < FL_FADE, ghost: easeIO(fade), ph: t < FL_HOLD ? 'grow' : t < FL_FADE ? 'hold' : t < FL_MS ? 'fade' : 'end' };
}
function cmpOf(p) { // the pair's other pools, and their liquidity near the price against this pool's
  const peers = mgPeers(p);
  if (!peers.length) return null;
  const all = mgDepth(p), own = all.some((d) => isNum(d[1])) ? mgBand(liqExtent(p.shape, all).bars, frLayer(p.shape)) : null;
  let oth = 0, unread = 0;
  for (const q of peers) { const s = mgSrc(q, false), v = s ? mgBand(s.bars, s.fr) : null; if (isNum(v)) oth += v; else unread++; }
  return { n: peers.length, x: isNum(own) && own > 0 && unread < peers.length ? oth / own : null, ge: unread > 0 };
}
const xTxt = (c) => (isNum(c.x) ? (c.ge ? '≥' : '') + (c.x >= 9.95 ? int(Math.round(c.x)) : c.x >= 0.095 ? c.x.toFixed(1) : '<0.1') + '×' : null);
function cmpHtml(p, id, c) {
  if (!c) return '';
  const n = c.n, s = n === 1 ? '' : 's', X = xTxt(c), more = isNum(c.x) && c.x >= 1;
  const lab = \`⚠ competition: +\${n} pool\${s} · \${X ? X + ' liquidity' : 'liquidity ' + DASH}\`;
  const say = \`Competition: \${n} other pool\${s} of this pair\${X ? \` hold\${n === 1 ? 's' : ''} \${X.replace('×', ' times')} \${more ? 'more liquidity than this one' : 'this pool’s liquidity'} near the price\` : ', liquidity near the price not read'}\`;
  if (id === 'liq-best') return SOLO ? \`<div class="cmp"><span class="cmp-b" title="\${esc(say)}">\${lab}</span></div>\`
    : \`<div class="cmp"><button type="button" class="cmp-b" data-act="flash-open" data-id="\${esc(p.id)}" aria-label="\${esc(say)}: open the pool to see them">\${lab} · <u>show</u></button></div>\`;
  const st = S.fl && S.fl.for === p.id ? S.fl.st : null;
  const ban = X ? \`This pair: <b>\${n} other pool\${s}</b> hold\${n === 1 ? 's' : ''} \${more ? \`<b>\${X}</b> more liquidity\` : \`only <b>\${X}</b> this pool’s liquidity\`} near the price\`
    : \`This pair: <b>\${n} other pool\${s}</b> trade\${n === 1 ? 's' : ''} the same tokens (their liquidity near the price wasn’t read)\`;
  return \`<div class="cmp\${st && st.ban ? ' ban' : ''}" data-ph="\${st ? st.ph : 'end'}"><p class="cmp-ban" aria-hidden="true">\${ban}</p>\`
    + (reduced() ? \`<span class="cmp-b" title="\${esc(say)}">\${lab}</span>\` : \`<button type="button" class="cmp-b" data-act="flash" data-id="\${esc(p.id)}" aria-label="\${esc(say)}: replay">\${lab} · <u>replay</u></button>\`) + '</div>';
}
function flPaint() { // this frame: the chart, the chips' light, the banner
  const hst = pzHost('liq-detail'), box = hst && hst.closest('[data-chartbox]');
  if (!box) return;
  const st = S.fl && S.fl.st;
  pzRedraw('liq-detail');
  for (const b of box.querySelectorAll('[data-act="merge"]')) { const on = !!(st && st.lit[b.dataset.id]); if (b.classList.contains('fl-on') !== on) b.classList.toggle('fl-on', on); }
  const c = box.querySelector('.cmp[data-ph]');
  if (c) { c.classList.toggle('ban', !!(st && st.ban)); c.dataset.ph = st ? st.ph : 'end'; }
}
function flEnd() { // straight to the end state: the chips' own stack, the ghost, the badge
  if (!S.fl) return;
  cancelAnimationFrame(S.fl.raf);
  S.fl = null;
  flPaint();
}
function flStart(id, auto) {
  if (auto) { if (FL_SEEN.has(id)) return; FL_SEEN.add(id); }
  const P = PZ['liq-detail'];
  if (S.detail !== id || !P || !P.p || P.p.id !== id || !P.every || !P.every.length || reduced() || (auto && NOFLASH)) return;
  flEnd();
  const ids = P.every.map((m) => m.id), t0 = performance.now();
  S.fl = { for: id, ids, st: flAt(0, ids), raf: 0 };
  const step = () => {
    const f = S.fl;
    if (!f || f.for !== id) return;
    if (S.detail !== id || !pzHost('liq-detail') || reduced()) { flEnd(); return; }
    const t = performance.now() - t0;
    if (t >= FL_MS) { flEnd(); return; }
    f.st = flAt(t, f.ids); flPaint();
    f.raf = requestAnimationFrame(step);
  };
  flPaint();
  S.fl.raf = requestAnimationFrame(step);
}
function liqChart(p, w, id) {`);

// start it when a detail opens (and in the pop-out window, which opens its detail the same way); a close ends it
rep("  S.detail = id; S.pair = null;\n  renderDetail();\n  showSheet();\n}",
  "  S.detail = id; S.pair = null;\n  if (S.fl && S.fl.for !== id) flEnd();\n  renderDetail();\n  showSheet();\n  flStart(id, true);\n}");
rep("  $('#sheet').hidden = true;\n  S.simFor = null;",
  "  flEnd();\n  $('#sheet').hidden = true;\n  S.simFor = null;");
// any interaction ends it at once: a tap, a key, a wheel or a touch anywhere, or a click on any control but the replay
rep("for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, () => { S.touched = true; cancelSettle(); }, { passive: true, capture: true });",
  "for (const ev of ['wheel', 'touchstart', 'keydown', 'mousedown']) addEventListener(ev, () => { S.touched = true; cancelSettle(); }, { passive: true, capture: true });\n"
  + "for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) addEventListener(ev, (e) => { if (S.fl && !(e.target && e.target.closest && e.target.closest('[data-act=\"flash\"]'))) flEnd(); }, { passive: true, capture: true });");
rep("  const el = e.target.closest('[data-act]');\n  if (!el || el.disabled) return;\n  switch (el.dataset.act) {",
  "  const el = e.target.closest('[data-act]');\n  if (!el || el.disabled) return;\n  if (S.fl && el.dataset.act !== 'flash') flEnd();\n  switch (el.dataset.act) {");
rep("    case 'merge': mgToggle(el.dataset.id); break;",
  "    case 'merge': mgToggle(el.dataset.id); break;\n"
  + "    case 'flash': flStart(el.dataset.id, false); break;\n"
  + "    case 'flash-open': if (el.dataset.id) { openDetail(el.dataset.id, el); flStart(el.dataset.id, false); } break;");

fs.writeFileSync(F, h);
console.log('p2 ok');
