const fs = require('fs');
const path = require('path');
const T = {
  A: { name: 'Slate Glass', pick: true, bg: 'radial-gradient(1200px 600px at 20% -10%,#2B3A4D 0%,#1A2230 55%,#151C27 100%)', card: 'rgba(255,255,255,.06)', cardB: 'rgba(255,255,255,.12)', fg: '#EAF0F6', mut: '#9AA8B8', acc: '#34E0A1', acc2: '#7CC4FF', warn: '#F6C25B', shadow: '0 20px 50px -20px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.08)', blur: 'blur(14px)', font: "Inter,system-ui,sans-serif", mono: "ui-monospace,monospace", rad: 18, bar: ['#34E0A1', '#7CC4FF'] },
  B: { name: 'Teal Depth', bg: 'linear-gradient(160deg,#0F3236 0%,#0B2427 60%,#0A1E21 100%)', card: '#123A3E', cardB: '#1D4E52', fg: '#E8F6F4', mut: '#8FB8B3', acc: '#FFB547', acc2: '#5EE6C8', warn: '#FF8A65', shadow: '0 2px 0 #1D4E52,0 18px 40px -18px rgba(0,0,0,.6)', blur: 'none', font: "system-ui,sans-serif", mono: "ui-monospace,monospace", rad: 22, bar: ['#5EE6C8', '#FFB547'] },
  C: { name: 'Warm Charcoal', bg: 'linear-gradient(180deg,#2A2622 0%,#211E1B 100%)', card: '#302B26', cardB: '#463E36', fg: '#F5EEE4', mut: '#B3A898', acc: '#E9A26B', acc2: '#A7D6B6', warn: '#F2CB6B', shadow: '0 1px 0 #463E36,0 14px 30px -16px rgba(0,0,0,.5)', blur: 'none', font: "Georgia,serif", mono: "ui-monospace,monospace", rad: 10, bar: ['#E9A26B', '#A7D6B6'] },
  D: { name: 'Daylight (with dark twin)', bg: 'linear-gradient(180deg,#F5F7FA 0%,#E9EEF3 100%)', card: '#FFFFFF', cardB: '#E1E7EE', fg: '#152231', mut: '#5E6E80', acc: '#0FA672', acc2: '#3B82F6', warn: '#C77700', shadow: '0 1px 2px rgba(16,24,40,.06),0 12px 28px -12px rgba(16,24,40,.18)', blur: 'none', font: "Inter,system-ui,sans-serif", mono: "ui-monospace,monospace", rad: 16, bar: ['#0FA672', '#3B82F6'] },
};
let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const g = (i, m, s, a) => a * Math.exp(-((i - m) ** 2) / (2 * s * s));
function chart3d(t, W, H) {
  const N = 30; let s = '';
  for (let i = 0; i < N; i++) {
    const v = g(i, 15, 3, 1) + g(i, 7, 2, 0.5) + g(i, 24, 2.5, 0.6);
    const h = v * (H - 20), x = 12 + (i * (W - 24)) / N, w = (W - 24) / N - 3, y = H - 6 - h;
    const inr = i >= 12 && i <= 18, c = inr ? t.bar[0] : t.bar[1];
    s += `<rect x="${x + 3}" y="${y - 3}" width="${w}" height="${h}" fill="${c}" opacity=".3"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${c}" opacity="${inr ? 1 : 0.55}"/>`;
  }
  s += `<line x1="${W / 2}" x2="${W / 2}" y1="4" y2="${H - 4}" stroke="${t.fg}" stroke-dasharray="3 3" opacity=".7"/>`;
  return `<div class="c3d"><svg viewBox="0 0 ${W} ${H}" width="100%">${s}</svg></div>`;
}
const rows = [['ABC/WETH', '0.30% · Base · v3', '#2F6BFF', 2.41, 63], ['DEF/WETH', '1.00% · Ethereum · v3', '#8A9EF5', 1.86, 58], ['GHI/cbBTC', '0.05% · Base · v4', '#2F6BFF', 1.12, 51], ['JKL/WETH', '0.30% · Ethereum · Pancake', '#F0B90B', 0.94, 47]];
function page(k, phone) {
  const t = T[k];
  const vars = `--bg:${t.bg};--card:${t.card};--cb:${t.cardB};--fg:${t.fg};--mut:${t.mut};--acc:${t.acc};--acc2:${t.acc2};--warn:${t.warn};--sh:${t.shadow};--blur:${t.blur};--f:${t.font};--m:${t.mono};--r:${t.rad}px`;
  const lanes = phone ? '' : `<section class="card lanes"><div class="kick">DISCOVERY</div>${['New pools · 4', 'Exchange-led · 6', 'Cross-chain · 2', 'Retail rising · 3'].map((x) => `<span class="lane">${x}</span>`).join('')}<div class="fees">${[...Array(30)].map((_, i) => `<i style="height:${18 + rnd() * 40}px;opacity:${i < 18 ? 0.4 : 1}"></i>`).join('')}</div><div class="cap">fee history · pale = estimated · solid = exact</div></section>`;
  return `<div class="pg ${phone ? 'ph' : 'lp'}" style="${vars}">
<div class="rib">MOCKUP · MADE-UP NUMBERS · ${k} · ${t.name}</div>
<header><b class="logo">◆ LP Shape</b><span class="pill on">Stables: off ⓘ</span><span class="pill">gas 0.4 gwei · cheap</span><span class="pill">ETH $3,412 ▲1.2%</span>${phone ? '' : '<span class="pill">BTC $96.2K ▼0.4%</span><span class="pill">next ⟳ 4:12</span>'}<span class="seg"><s>24H</s><s class="on">7D</s><s>30D</s></span></header>
<main><section class="card hero"><div class="kick">BEST FIND · GEM 72</div><h1><i class="cg" style="--k:#2F6BFF"></i>ABC/WETH <small>0.30% · Base · v3</small></h1>
<div class="money"><div><span class="big">$2.41</span><span class="u">/day at $1,000</span></div><div class="sub">fees $3.80 · LVR −$1.39 · ≈ 88% a year</div></div>${chart3d(t, phone ? 340 : 560, phone ? 140 : 190)}
<div class="flash">competition: +2 pools · 3.4× liquidity <u>replay</u></div></section>
<section class="card list"><div class="kick">NEXT BEST · per $1,000 a day</div>${rows.map((r) => `<div class="row" style="--k:${r[2]}"><span><b>${r[0]}</b><em>${r[1]}</em></span><span class="v">$${r[3].toFixed(2)}<em>gem ${r[4]}</em></span></div>`).join('')}</section>
${lanes}</main></div>`;
}
const css = `*{box-sizing:border-box}body{margin:0;background:#111;font-family:system-ui;padding:20px;color:#ddd}
.set{display:flex;gap:24px;align-items:flex-start;margin-bottom:40px}.tt{font:700 15px system-ui;color:#fff;margin:0 0 10px}.tt b{color:#F6C25B}
.pg{background:var(--bg);color:var(--fg);font-family:var(--f);border-radius:22px;overflow:hidden;box-shadow:0 30px 80px -30px #000;flex:none}
.lp{width:1180px}.ph{width:390px}.rib{background:#FAB219;color:#000;font:700 10px ui-monospace,monospace;letter-spacing:.1em;text-align:center;padding:3px}
header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:14px 18px}.logo{font-size:17px;margin-right:auto}
.pill{font:600 11px var(--m);padding:6px 10px;border-radius:999px;background:var(--card);border:1px solid var(--cb);color:var(--mut);backdrop-filter:var(--blur)}.pill.on{color:var(--acc);border-color:var(--acc)}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--cb);border-radius:999px;padding:2px}.seg s{text-decoration:none;font:600 11px var(--m);padding:4px 9px;border-radius:999px;color:var(--mut)}.seg s.on{background:var(--acc);color:#0b1210}
main{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;padding:6px 18px 20px}.ph main{grid-template-columns:1fr}
.lanes{grid-column:1/-1}.card{background:var(--card);border:1px solid var(--cb);border-radius:var(--r);padding:16px;box-shadow:var(--sh);backdrop-filter:var(--blur)}
.kick{font:600 10.5px var(--m);letter-spacing:.1em;color:var(--mut)}h1{margin:6px 0 10px;font-size:26px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}h1 small{font:500 12px var(--m);color:var(--mut)}
.cg{width:12px;height:12px;border-radius:50%;background:var(--k);box-shadow:0 0 0 3px rgba(255,255,255,.12)}
.money{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:6px}.big{font:800 40px var(--f);color:var(--acc);letter-spacing:-.02em}.u{font:600 13px var(--m);color:var(--mut);margin-left:6px}.sub{font:12px var(--m);color:var(--mut)}
.c3d{margin-top:12px;perspective:700px}.c3d svg{transform:rotateX(18deg);transform-origin:50% 100%;filter:drop-shadow(0 14px 14px rgba(0,0,0,.35))}
.flash{margin-top:8px;display:inline-block;font:600 11px var(--m);color:var(--warn);border:1px solid var(--warn);border-radius:999px;padding:4px 10px}.flash u{color:var(--acc);margin-left:4px}
.row{display:flex;justify-content:space-between;align-items:center;padding:11px 0 11px 12px;border-bottom:1px solid var(--cb);position:relative}.row:before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--k)}
.row b{display:block;font-size:14px}.row em{display:block;font:11px var(--m);color:var(--mut);font-style:normal}.row .v{text-align:right;font:700 15px var(--m);color:var(--acc)}
.lane{display:inline-block;margin:8px 8px 0 0;padding:8px 12px;border-radius:12px;border:1px solid var(--acc2);color:var(--fg);font:600 12px var(--m)}
.fees{display:flex;align-items:flex-end;gap:3px;height:64px;margin-top:14px}.fees i{flex:1;background:var(--acc);border-radius:3px 3px 0 0}.cap{font:11px var(--m);color:var(--mut);margin-top:4px}`;
const body = Object.keys(T).map((k) => `<div class="tt">${k} · ${T[k].name}${T[k].pick ? ' <b>★ PICK</b>' : ''}</div><div class="set" id="s${k}">${page(k, false)}${page(k, true)}</div>`).join('');
fs.writeFileSync(path.join(__dirname, 'redesign.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
