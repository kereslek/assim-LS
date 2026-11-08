// v0.4.5 part 1: the stablecoin switch in the top strip, and the switch applied to every list that shows pools
import fs from 'node:fs';
const F = process.argv[2];
let h = fs.readFileSync(F, 'utf8');
const rep = (a, b) => { const n = h.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 90)}`); h = h.replace(a, () => b); };

rep("const BUILD = 'v0.4.4';", "const BUILD = 'v0.4.5';");

// ---- the top strip: a compact switch next to the gas gauge, with its own plain-words note
const IBTN_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.3v4M8 4.7v.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
rep('    <button type="button" class="gas g-none" id="gas" data-act="gas" aria-haspopup="true" aria-expanded="false" aria-label="Ethereum gas">—</button>\n',
  '    <button type="button" class="gas g-none" id="gas" data-act="gas" aria-haspopup="true" aria-expanded="false" aria-label="Ethereum gas">—</button>\n'
  + `    <span class="stq"><button type="button" class="stt" id="t-stab" role="switch" aria-checked="false" aria-label="Stables: show stablecoin pairs" data-act="stable"><span class="tk" aria-hidden="true"></span><span>Stables: <b class="st">off</b></span></button><button type="button" class="ibtn" data-act="term" data-term="stabtop" aria-expanded="false" aria-controls="pop" aria-label="Stables: what does this switch do?">${IBTN_SVG}</button></span>\n`);

rep(".gas .gb{color:var(--gc)}\n",
  ".gas .gb{color:var(--gc)}\n"
  + "/* the stablecoin-pairs switch, repeated in the strip (v0.4.5): one state with the one above All pools */\n"
  + ".stq{display:inline-flex;align-items:center;white-space:nowrap}\n"
  + ".stt{margin:-12px 0;min-height:44px;padding:0 4px 0 0;border:0;background:transparent;color:var(--fg2);display:inline-flex;align-items:center;gap:6px;font:inherit;cursor:pointer;white-space:nowrap}\n"
  + ".stt .tk{position:relative;flex:none;width:22px;height:12px;border-radius:6px;background:var(--line3);transition:background .15s ease}\n"
  + ".stt .tk::after{content:\"\";position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--fg2);transition:transform .15s ease,background .15s ease}\n"
  + ".stt b{font-weight:700;color:var(--fg)}\n"
  + ".stt[aria-checked=\"true\"] .tk{background:var(--accent)}\n"
  + ".stt[aria-checked=\"true\"] .tk::after{transform:translateX(10px);background:#06110C}\n"
  + ".stt[aria-checked=\"true\"] b{color:var(--accent)}\n"
  + ".stt:focus-visible{outline:2px solid var(--accent);outline-offset:-8px;border-radius:6px}\n"
  + ".stq .ibtn{margin:-15px 0 -15px -4px}\n"
  + "@media (prefers-reduced-motion:reduce){.stt .tk,.stt .tk::after{transition:none}}\n"
  + ".tag.stk{color:var(--fg2);border-color:var(--line3)}\n"
  + ".stkm{font-weight:700;color:var(--fg2)}\n");

// ---- the glossary: the strip's note in the owner's words; the long note names every list the switch covers
rep("  stable: ['Stablecoin pairs', 'Off (the default): pairs holding a USD or EUR stablecoin (USDC, USDT, DAI, EURC and the like) are left out of the best finds, Next best, All pools, similar pools, pair views and search.",
  "  stabtop: ['Stables', 'Pairs with a stablecoin (USDC, USDT, DAI…) are hidden by default. Turn on to include them. Your favourites always show, marked ★ STABLE.'],\n"
  + "  stable: ['Stablecoin pairs', 'Off (the default): pairs holding a USD or EUR stablecoin (USDC, USDT, DAI, EURC and the like) are left out of the best finds, Next best, All pools, New since you last looked, the backtests, similar pools, pair views and search.");

// ---- helpers: a favourite that is a stablecoin pair stays, marked
rep("const hidTxt = (n, up) => (n ? (up ? `${n} HIDDEN · STABLECOIN PAIRS OFF` : `${n} hidden · stablecoin pairs off`) : '');\n",
  "const hidTxt = (n, up) => (n ? (up ? `${n} HIDDEN · STABLECOIN PAIRS OFF` : `${n} hidden · stablecoin pairs off`) : '');\n"
  + "// a favourite that is a stablecoin pair shows while the switch is off: marked, so it doesn't look as if the switch failed\n"
  + "const keptStable = (p) => !!p && !stableOn() && isStablePair(p) && isFav(p.id);\n"
  + "const KEPT_T = 'A stablecoin pair: shown while stablecoin pairs are off because it is a favourite';\n"
  + "const keptTag = (p) => (keptStable(p) ? `<span class=\"tag stk\" title=\"${KEPT_T}\">★ STABLE</span>` : '');\n");
rep("  n.textContent = on ? `${S.live.pools.filter(isStablePair).length} shown` : `${hid} hidden`;\n}",
  "  n.textContent = on ? `${S.live.pools.filter(isStablePair).length} shown` : `${hid} hidden`;\n"
  + "  const t = $('#t-stab'); // the strip's copy: the same state\n"
  + "  if (t) { t.setAttribute('aria-checked', String(on)); t.querySelector('.st').textContent = on ? 'on' : 'off'; t.title = on ? 'Stablecoin pairs shown: tap to hide them' : `${hid} stablecoin pair${hid === 1 ? '' : 's'} hidden: tap to show them`; }\n}");
rep("    case 'stable': setStable(!stableOn()); refocus('#f-stab'); break;",
  "    case 'stable': setStable(!stableOn()); refocus('#' + (el.id || 'f-stab')); break;");
rep("  $('#mpx').innerHTML = ['ETH', 'BTC', 'SOL'].map((c) => pxChip(c, pxs[c])).join('');\n",
  "  $('#mpx').innerHTML = ['ETH', 'BTC', 'SOL'].map((c) => pxChip(c, pxs[c])).join('');\n  renderStable();\n");

// ---- the marks: tags (table, Next best, pair view, headers), best-find tabs, mini cards, New since, backtest rows
rep("  const t = [], x = (k, h) => (explain ? termB(k, h) : h);\n",
  "  const t = [], x = (k, h) => (explain ? termB(k, h) : h);\n  if (keptStable(p)) t.push(keptTag(p));\n");
rep("function tabTags(p) {\n  return (p.verified === false",
  "function tabTags(p) {\n  return keptTag(p) + (p.verified === false");
rep("const mcMeta = (p) => `${chainMark(p.chain)}${feeTxt(p.feeTier)} · v${esc(p.v)}`;",
  "const mcMeta = (p) => `${chainMark(p.chain)}${feeTxt(p.feeTier)} · v${esc(p.v)}${keptStable(p) ? ` · <b class=\"stkm\" title=\"${KEPT_T}\">★ STABLE</b>` : ''}`;");
rep("<span class=\"lbl\">${metaTxt(p)} · since ${dmhm(p.gemFirstAt)}</span>",
  "<span class=\"lbl\">${metaTxt(p)}${keptStable(p) ? ' · ★ STABLE' : ''} · since ${dmhm(p.gemFirstAt)}</span>");
rep("${r.p ? metaTxt(r.p) : DASH}${r.bench ? ' · benchmark' : ''}",
  "${r.p ? metaTxt(r.p) : DASH}${r.bench ? ' · benchmark' : ''}${keptStable(r.p) ? ' · ★ STABLE' : ''}");

// ---- the scanner tile: gems, scored and the top score among the pools the lists show
rep("  const gems = L.pools.filter((p) => isGem(p, wk)).length;\n  const scored = L.pools.filter((p) => gemOf(p, wk) != null && p.verified !== false).length;\n  const tops = L.pools.filter((p) => p.verified !== false).map((p) => gemOf(p, wk)).filter(isNum);\n",
  "  const vis = unhidden(L.pools), gHid = L.pools.filter((p) => hideStable(p) && gemOf(p, wk) != null && p.verified !== false).length; // the lists' pools\n"
  + "  const gems = vis.filter((p) => isGem(p, wk)).length;\n  const scored = vis.filter((p) => gemOf(p, wk) != null && p.verified !== false).length;\n  const tops = vis.filter((p) => p.verified !== false).map((p) => gemOf(p, wk)).filter(isNum);\n");
rep("of ${int(scored)} scored · top ${top == null ? DASH : top} · ${WIN_LABEL[wk]}</span>`;",
  "of ${int(scored)} scored · top ${top == null ? DASH : top} · ${WIN_LABEL[wk]}</span>`\n    + (gHid ? `<span class=\"line hidn\">${hidTxt(gHid)}</span>` : '');");

// ---- Next best's button and All pools' counts: the pools the lists show
rep("data-to=\"#all\">All ${int(L.pools.length)} scored pools ▸</button>", "data-to=\"#all\">All ${int(pools.length)} scored pools ▸</button>");
rep("  const fresh = L.pools.filter(isNew).length;\n", "  const fresh = vis.filter(isNew).length;\n");
rep("SHOWING ${shown.length} OF ${rows.length}${rows.length !== L.pools.length ? ' (' + L.pools.length + ' IN ALL)' : ''}",
  "SHOWING ${shown.length} OF ${rows.length}${rows.length !== vis.length ? ' (' + vis.length + ' IN ALL)' : ''}");

// ---- the backtests: leaderboard, scatter, KPIs, replay and the strategy lab's pool
rep("function btRows() {\n  if (!S.bt || !S.bt.pools) return [];\n  const rows = [];\n  for (const [id, e] of Object.entries(S.bt.pools)) {\n    const b = e && e[S.win];\n    if (!b || !b.series || !Array.isArray(b.series.t) || b.series.t.length < 2) continue;\n    rows.push({ id, p: poolById(id), b, bench: id === S.live.bench });",
  "function btRows(raw = false) { // raw: the stablecoin pairs the switch hides too\n  if (!S.bt || !S.bt.pools) return [];\n  const rows = [];\n  for (const [id, e] of Object.entries(S.bt.pools)) {\n    const b = e && e[S.win];\n    if (!b || !b.series || !Array.isArray(b.series.t) || b.series.t.length < 2) continue;\n    const p = poolById(id);\n    if (!raw && p && hideStable(p)) continue;\n    rows.push({ id, p, b, bench: id === S.live.bench });");
rep("  const rows = btRows();\n  ctx.textContent",
  "  const rows = btRows(), bHid = btRows(true).length - rows.length;\n  ctx.textContent");
rep("  if (!rows.length) {\n    lead.innerHTML = `<p class=\"empty\">No backtests for the ${WIN_WORD[S.win]} window yet.</p>`;",
  "  if (!rows.length) {\n    lead.innerHTML = bHid ? `<p class=\"empty\">Every pool backtested over the ${WIN_WORD[S.win]} window is a stablecoin pair: ${hidTxt(bHid)}. <button type=\"button\" class=\"linkbtn\" data-act=\"stable-on\">Show stablecoin pairs</button></p>`\n      : `<p class=\"empty\">No backtests for the ${WIN_WORD[S.win]} window yet.</p>`;");
rep("FORECAST VS BACKTEST · NET APR · ${WIN_LABEL[S.win]}</div>",
  "FORECAST VS BACKTEST · NET APR · ${WIN_LABEL[S.win]}${bHid ? `<span class=\"hidn\"> · ${hidTxt(bHid, true)}</span>` : ''}</div>");

fs.writeFileSync(F, h);
console.log('p1 ok');
