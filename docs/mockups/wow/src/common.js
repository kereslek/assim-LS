// Shared markup + runtime for the four "wow" mockups. All numbers are made up.
const CHAIN = { eth: ['Ethereum', '#8A9EF5'], base: ['Base', '#2F6BFF'], bnb: ['BNB', '#F0B90B'] };

const markSVG = (k, s = 14) => {
  const c = CHAIN[k][1];
  if (k === 'eth') return `<svg class="cm" width="${s}" height="${s}" viewBox="0 0 14 14" aria-label="Ethereum"><path d="M7 .5 12 7 7 13.5 2 7Z" fill="${c}"/><path d="M7 .5 12 7 7 9.2 2 7Z" fill="#fff" opacity=".28"/></svg>`;
  if (k === 'base') return `<svg class="cm" width="${s}" height="${s}" viewBox="0 0 14 14" aria-label="Base"><circle cx="7" cy="7" r="6.5" fill="${c}"/><rect x="2.4" y="6.1" width="6" height="1.8" rx=".9" fill="#fff"/></svg>`;
  return `<svg class="cm" width="${s}" height="${s}" viewBox="0 0 14 14" aria-label="BNB"><rect x="3" y="3" width="8" height="8" rx="1.2" transform="rotate(45 7 7)" fill="${c}"/><rect x="5.4" y="5.4" width="3.2" height="3.2" transform="rotate(45 7 7)" fill="#fff" opacity=".55"/></svg>`;
};

const NEXT = [
  { pair: 'DEF/WETH', meta: '1.00% · Ethereum · Uni v3', ch: 'eth', v: 1.86, gem: 58, sp: [3, 4, 3.6, 5, 4.6, 5.8, 5.2, 6.1, 6.6, 6.2, 7.1, 7.6] },
  { pair: 'GHI/cbBTC', meta: '0.05% · Base · Uni v4', ch: 'base', v: 1.12, gem: 51, sp: [5, 4.4, 4.8, 4.1, 4.6, 5.2, 4.9, 5.6, 5.1, 5.9, 6.2, 6.0] },
  { pair: 'JKL/WBNB', meta: '0.25% · BNB · Pancake v3', ch: 'bnb', v: 0.94, gem: 47, sp: [2, 2.6, 3.4, 3.1, 4.2, 4.0, 4.8, 4.4, 5.1, 5.6, 5.3, 6.0] },
  { pair: 'MNO/WETH', meta: '0.30% · Base · Pancake v3', ch: 'base', v: 0.81, gem: 44, sp: [6, 5.4, 5.8, 5.0, 4.6, 4.9, 4.4, 4.8, 4.2, 4.5, 4.1, 4.4] },
];

const LANES = [
  { k: 'new', ico: '✦', t: 'New pools', n: 4, d: 'born in the last 24 h', it: [['PQR/WETH', 'base', '3 h old', 1.64], ['STU/WBNB', 'bnb', '9 h old', 0.77]] },
  { k: 'cex', ico: '⇄', t: 'Exchange-led', n: 6, d: 'volume led by a listing', it: [['VWX/WETH', 'eth', 'listed on 2 exchanges', 1.21], ['YZA/WETH', 'base', 'volume 4.1× usual', 0.88]] },
  { k: 'xc', ico: '⛓', t: 'Cross-chain', n: 2, d: 'same token, thinner chain', it: [['BCD/WETH', 'base', 'Base thinner than Ethereum', 1.37], ['EFG/WBNB', 'bnb', 'BNB gap vs Base', 0.69]] },
  { k: 'ret', ico: '↗', t: 'Retail rising', n: 3, d: 'small swaps picking up', it: [['HIJ/WETH', 'eth', 'swaps +38% this week', 0.95], ['KLM/cbBTC', 'base', 'new wallets +21%', 0.58]] },
];

const spark = (a, w = 52, h = 22) => {
  const mn = Math.min(...a), mx = Math.max(...a);
  const pts = a.map((v, i) => `${((i / (a.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M${pts.join(' L')}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${pts[pts.length - 1].split(',')[0]}" cy="${pts[pts.length - 1].split(',')[1]}" r="2.2" fill="currentColor"/></svg>`;
};

function ribbon(tag) {
  return `<div class="ribbon" role="note">MOCKUP · MADE-UP NUMBERS <span>· ${tag}</span></div>`;
}

function topbar(o = {}) {
  return `<header class="tb">
  <a class="brand" href="#" aria-label="LP Shape home">${o.logo || '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 18 C6 18 7 6 11 6 S16 18 20 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="11" cy="6" r="2.6" fill="var(--acc)"/></svg>'}<span>LP Shape</span></a>
  <button class="tgl" type="button" data-stables aria-pressed="false"><span class="sw"><i></i></span><span class="tl">Stables: <b>off</b></span><span class="info" data-tip="Stable–stable pools (USDC/USDT…) are hidden. Turn on to include them.">ⓘ</span></button>
  <div class="chips">
    <span class="chip gas" data-tip="Ethereum gas right now (made up)"><svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true"><path d="M3 14a10 10 0 0 1 20 0" fill="none" stroke="var(--gauge-bg)" stroke-width="3" stroke-linecap="round"/><path class="g-arc" d="M3 14a10 10 0 0 1 20 0" fill="none" stroke="var(--gauge)" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="22 100"/><line class="g-ndl" x1="13" y1="14" x2="13" y2="6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><b>0.4</b> gwei · cheap</span>
    <span class="chip px" data-px="eth">ETH <b>$3,412</b> <em class="up">▲1.2%</em></span>
    <span class="chip px" data-px="btc">BTC <b>$96.2K</b> <em class="dn">▼0.4%</em></span>
    <span class="chip cd" data-tip="Next data refresh"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--gauge-bg)" stroke-width="2"/><circle class="cd-ring" cx="8" cy="8" r="6" fill="none" stroke="var(--acc)" stroke-width="2" pathLength="100" stroke-dasharray="84 100" transform="rotate(-90 8 8)" stroke-linecap="round"/></svg>next <b data-cd>4:12</b></span>
  </div>
  <div class="seg" role="tablist" aria-label="Time window"><i class="seg-ind"></i><button type="button" role="tab" data-win="24h">24H</button><button type="button" role="tab" class="on" aria-selected="true" data-win="7d">7D</button><button type="button" role="tab" data-win="30d">30D</button></div>
</header>`;
}

function heroCopy() {
  return `<div class="hero-copy">
  <div class="kick"><span class="dot"></span>BEST FIND · GEM <b>72</b></div>
  <h1 class="pair">${markSVG('base', 18)}<span class="pn">ABC/WETH</span> <small>0.30% · Base · Uniswap v3</small></h1>
  <div class="headline"><span class="big" data-count="2.41" data-prefix="$">$2.41</span><span class="per">/day at $1,000</span></div>
  <div class="breakdown">fees <b class="pos" data-count="3.80" data-prefix="$">$3.80</b> · LVR <b class="neg" data-count="1.39" data-prefix="−$">−$1.39</b> · net ≈ <b class="apr" data-count="88" data-dec="0" data-suffix="%">88%</b> a year</div>
</div>`;
}

function legend3d() {
  return `<div class="lg3"><span class="lg in"><i></i>in range</span><span class="lg px"><i></i>price</span><span class="lg gh"><i></i>competition +2 pools</span></div>`;
}

function nextList() {
  return `<ol class="next">${NEXT.map((r, i) => `<li class="nx rv" style="--c:${CHAIN[r.ch][1]};--i:${i}" tabindex="0"><span class="rank">${i + 2}</span><div class="nm"><b>${markSVG(r.ch, 12)}${r.pair}</b><em>${r.meta}</em></div>${spark(r.sp)}<div class="val"><b data-count="${r.v}" data-prefix="$">$${r.v.toFixed(2)}</b><em>gem ${r.gem}</em></div></li>`).join('')}</ol>`;
}

function lanes() {
  return `<div class="lanes">${LANES.map((l, i) => `<article class="lane rv" data-lane="${l.k}" style="--i:${i}" tabindex="0"><header><span class="ico">${l.ico}</span><h3>${l.t}</h3><span class="n">${l.n}</span></header><p>${l.d}</p><ul>${l.it.map((x) => `<li style="--c:${CHAIN[x[1]][1]}"><span><b>${x[0]}</b><em>${x[2]}</em></span><span class="lv">$${x[3].toFixed(2)}</span></li>`).join('')}</ul></article>`).join('')}</div>`;
}

function feeStrip() {
  let s = 7;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const base = new Date(Date.UTC(2026, 10, 8));
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const bars = [];
  for (let i = 0; i < 30; i++) {
    const v = 2.1 + 1.1 * Math.sin(i / 4.2) + i * 0.035 + r() * 1.3;
    const d = new Date(base - (29 - i) * 864e5);
    bars.push({ v: +v.toFixed(2), ex: i >= 19, d: `${M[d.getUTCMonth()]} ${d.getUTCDate()}` });
  }
  const mx = Math.max(...bars.map((b) => b.v));
  return `<div class="fees"><div class="fee-bars">${bars.map((b, i) => `<i class="${b.ex ? 'ex' : 'est'}" style="--h:${((b.v / mx) * 100).toFixed(1)}%;--i:${i}" data-tip="${b.d} · $${b.v.toFixed(2)} · ${b.ex ? 'exact' : 'estimated'}"></i>`).join('')}</div><div class="fee-ax"><span>Oct 10</span><span>Oct 24</span><span>today</span></div></div>`;
}

const feeLegend = `<span class="fl"><i class="est"></i>estimated</span><span class="fl"><i class="ex"></i>exact</span>`;

const IMPORTMAP = `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>`;

// Liquidity data used by every scene (made up): 36 price bins, rows back in time.
const DATA_JS = `
window.LPD = (function(){
  const N = 36, LO = 15, HI = 20;
  const g = (x,m,s,a) => a*Math.exp(-((x-m)**2)/(2*s*s));
  const h = (i,r) => { const x = Math.sin(i*12.9898 + r*78.233)*43758.5453; return x - Math.floor(x); };
  function liq(i, r){ r = r||0; const d = r*0.11;
    return 0.10 + g(i,9.5-d,3.2,1.0+0.025*r) + g(i,26.5+d*0.6,3.6,0.86-0.01*r) + g(i,17.6,1.7,0.17+0.03*Math.sin(r*0.9)) + 0.07*h(i,r); }
  function price(r){ r = r||0; return 17.9 + 1.25*Math.sin(r*0.55+0.25) + 0.45*Math.sin(r*1.7); }
  function ghost(i){ return (i>=LO && i<=HI) ? 0.2 + 0.07*Math.sin(i*1.3) : 0; }
  function shape(p){ // for other pools (F)
    const a = []; for (let i=0;i<N;i++) a.push(0.08 + g(i,p[0],p[1],1) + g(i,p[2],p[3],p[4]) + g(i,17.6,1.6,p[5]) + 0.05*h(i,p[6]||1)); return a; }
  return { N, LO, HI, liq, price, ghost, shape, priceLabel: '0.04213 WETH' };
})();`;

const RUNTIME_JS = `
(function(){
  const RM = window.RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s,r=document)=>r.querySelector(s), $$ = (s,r=document)=>[...r.querySelectorAll(s)];
  const fmt = (v,d)=>v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const WIN = {'24h':1.12,'7d':1,'30d':0.86}; let mult = 1;
  function countUp(el, to, from, dur){
    const d = el.dataset.dec ? +el.dataset.dec : 2, pre = el.dataset.prefix||'', suf = el.dataset.suffix||'';
    if (RM){ el.textContent = pre+fmt(to,d)+suf; return; }
    const t0 = performance.now(); dur = dur||1500;
    const st = t => { const k = Math.min(1,(t-t0)/dur), e = 1-Math.pow(1-k,4); el.textContent = pre+fmt(from+(to-from)*e,d)+suf; if(k<1) requestAnimationFrame(st); };
    requestAnimationFrame(st);
  }
  function runCounts(prev){
    $$('[data-count]').forEach(el => { const b = +el.dataset.count; let to = b*mult, fr = prev!=null ? b*prev : 0;
      if (el.classList.contains('apr')) { const hc = el.closest('.hero-copy'), net = +hc.querySelector('.pos').dataset.count - +hc.querySelector('.neg').dataset.count; to = Math.round(net*mult*36.5); fr = prev!=null ? Math.round(net*prev*36.5) : 0; }
      el.dataset.now = to; countUp(el, to, fr, prev!=null ? 700 : 1700); });
  }
  window.LPUI = { countUp, runCounts, get mult(){ return mult; } };

  // reveal on scroll
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }), {threshold:.12}) : null;
  function initReveal(){ $$('.rv, .fees').forEach(el => io && !RM ? io.observe(el) : el.classList.add('in')); }

  // segmented 24H/7D/30D
  function initSeg(){
    const seg = $('.seg'); if(!seg) return; const ind = $('.seg-ind', seg);
    const place = b => { ind.style.width = b.offsetWidth+'px'; ind.style.transform = 'translateX('+(b.offsetLeft-3)+'px)'; };
    $$('button', seg).forEach(b => b.addEventListener('click', () => {
      $$('button', seg).forEach(x => { x.classList.toggle('on', x===b); x.setAttribute('aria-selected', x===b); });
      place(b); const prev = mult; mult = WIN[b.dataset.win]; runCounts(prev);
      const fb = $('.fee-bars'); if (fb){ fb.classList.remove('go'); void fb.offsetWidth; fb.classList.add('go'); }
      dispatchEvent(new CustomEvent('lp:win', {detail:{win:b.dataset.win, mult}}));
    }));
    requestAnimationFrame(() => place($('button.on', seg)));
    addEventListener('resize', () => place($('button.on', seg)));
  }

  // Stables toggle adds/removes a stable pool row
  function initStables(){
    const t = $('[data-stables]'); if(!t) return;
    t.addEventListener('click', e => {
      if (e.target.closest('.info')) return;
      const on = t.getAttribute('aria-pressed') !== 'true'; t.setAttribute('aria-pressed', on); $('b', t).textContent = on ? 'on' : 'off';
      const list = $('.next'); if(!list) return; let row = $('.nx.stable', list);
      if (on && !row){
        row = document.createElement('li'); row.className = 'nx stable rv in'; row.tabIndex = 0; row.style.setProperty('--c','#8A9EF5');
        row.innerHTML = '<span class="rank">s</span><div class="nm"><b>USDC/USDT</b><em>0.01% · Ethereum · Uni v4</em></div><span class="stag">stable</span><div class="val"><b>$0.42</b><em>gem 39</em></div>';
        list.appendChild(row); requestAnimationFrame(() => row.classList.add('pop'));
      } else if (!on && row){ row.classList.remove('pop'); row.classList.add('bye'); setTimeout(() => row.remove(), 380); }
      dispatchEvent(new CustomEvent('lp:stables', {detail:{on}}));
    });
  }

  // countdown with ring
  function initCountdown(){
    const el = $('[data-cd]'), ring = $('.cd-ring'); if(!el) return; let s = 252;
    const draw = () => { el.textContent = Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); if(ring) ring.setAttribute('stroke-dasharray', (s/300*100).toFixed(1)+' 100'); };
    draw(); setInterval(() => { s--; if (s < 0){ s = 300; document.body.classList.add('refresh'); setTimeout(()=>document.body.classList.remove('refresh'), 1200); dispatchEvent(new Event('lp:refresh')); } draw(); }, 1000);
  }

  // ETH/BTC ticking (made up random walk)
  function initPrices(){
    const P = { eth:{v:3412, b:3371.5, f:v=>'$'+Math.round(v).toLocaleString('en-US')}, btc:{v:96200, b:96585, f:v=>'$'+(v/1000).toFixed(1)+'K'} };
    let s = 11; const rnd = () => (s = (s*16807)%2147483647)/2147483647;
    const tick = () => { for (const k in P){ const p = P[k], el = $('[data-px='+k+']'); if(!el) continue; const old = p.v; p.v *= 1+(rnd()-.5)*0.0016;
      const ch = (p.v/p.b-1)*100, em = $('em',el), b = $('b',el); b.textContent = p.f(p.v);
      em.textContent = (ch>=0?'▲':'▼')+Math.abs(ch).toFixed(1)+'%'; em.className = ch>=0?'up':'dn';
      el.classList.remove('fl-up','fl-dn'); void el.offsetWidth; el.classList.add(p.v>=old?'fl-up':'fl-dn'); } };
    if (!RM) setInterval(tick, 2600);
  }

  // gas gauge needle
  function initGas(){ const n = $('.g-ndl'); if(!n) return; const set = a => n.setAttribute('transform','rotate('+a+' 13 14)'); set(-90); if (RM){ set(-58); return; }
    setTimeout(() => { n.style.transition = 'transform 1.2s cubic-bezier(.34,1.56,.64,1)'; set(-58); }, 400);
    setInterval(() => set(-62 + Math.random()*10), 3200); }

  // tooltips
  function initTips(){
    const tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role','tooltip'); document.body.appendChild(tip);
    let cur = null;
    const show = (el, x, y) => { cur = el; tip.textContent = el.dataset.tip; tip.classList.add('on'); const r = tip.getBoundingClientRect();
      let L = x - r.width/2, T = y - r.height - 12; L = Math.max(8, Math.min(innerWidth - r.width - 8, L)); if (T < 8) T = y + 16; tip.style.transform = 'translate('+L+'px,'+T+'px)'; };
    addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (el){ const r = el.getBoundingClientRect(); show(el, r.left + r.width/2, r.top); } });
    addEventListener('pointerout', e => { if (cur && !cur.contains(e.relatedTarget)) { tip.classList.remove('on'); cur = null; } });
    addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el){ const r = el.getBoundingClientRect(); show(el, r.left + r.width/2, r.top); } });
    addEventListener('focusout', () => tip.classList.remove('on'));
    window.LPUI.tip = { show:(txt,x,y)=>{ tip.textContent = txt; tip.classList.add('on'); const r = tip.getBoundingClientRect(); let L = Math.max(8, Math.min(innerWidth-r.width-8, x - r.width/2)); let T = y - r.height - 14; if (T<8) T = y+18; tip.style.transform='translate('+L+'px,'+T+'px)'; }, hide:()=>tip.classList.remove('on') };
  }

  // flat SVG fallback if WebGL / the CDN is unavailable
  window.LPFallback = function(host, cols){
    if (!host || host.querySelector('.fallback')) return; const D = window.LPD, W = 600, H = 220; let s = '';
    for (let i=0;i<D.N;i++){ const v = D.liq(i,0), h = v/1.3*(H-30), x = 10 + i*(W-20)/D.N, w = (W-20)/D.N - 3, inr = i>=D.LO && i<=D.HI;
      s += '<rect x="'+x+'" y="'+(H-10-h)+'" width="'+w+'" height="'+h+'" rx="2" fill="'+(inr?cols[0]:cols[1])+'" opacity="'+(inr?1:.55)+'"/>';
      if (inr) s += '<rect x="'+x+'" y="'+(H-10-h-D.ghost(i)/1.3*(H-30))+'" width="'+w+'" height="'+(D.ghost(i)/1.3*(H-30))+'" rx="2" fill="none" stroke="'+cols[2]+'" stroke-dasharray="3 2"/>'; }
    const px = 10 + D.price(0)*(W-20)/D.N; s += '<line x1="'+px+'" x2="'+px+'" y1="8" y2="'+(H-6)+'" stroke="'+cols[2]+'" stroke-width="2"/>';
    const d = document.createElement('div'); d.className = 'fallback'; d.innerHTML = '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="100%" preserveAspectRatio="none">'+s+'</svg><small>3D view unavailable on this device: flat view shown</small>'; host.appendChild(d);
  };

  function boot(){ initTips(); initReveal(); initSeg(); initStables(); initCountdown(); initPrices(); initGas(); runCounts(null);
    setTimeout(() => { if (!window.__sceneOK) document.querySelectorAll('[data-fallback]').forEach(h => window.LPFallback(h, JSON.parse(h.dataset.fallback))); }, 6000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();`;

// Base CSS shared by all (structure only; each theme supplies colours/looks).
const BASE_CSS = `
*,*:before,*:after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--f);color:var(--fg);background:var(--bg-solid);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
a{color:inherit;text-decoration:none}
.ribbon{position:fixed;top:0;left:0;right:0;z-index:50;background:#FAB219;color:#1a1200;font:800 10px/1 var(--m);letter-spacing:.14em;text-align:center;padding:5px 8px;box-shadow:0 2px 12px rgba(0,0,0,.18)}
.ribbon span{opacity:.75}
.grid>*{min-width:0}
.wrap{max-width:1360px;margin:0 auto;padding:30px 24px 40px;position:relative;z-index:2}
.tb{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 0 18px}
.brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:18px;letter-spacing:-.01em;margin-right:6px}
.tgl{display:inline-flex;align-items:center;gap:8px;font:600 12px var(--m);padding:7px 11px 7px 8px;border-radius:999px}
.tgl .sw{width:28px;height:16px;border-radius:99px;position:relative;transition:background .3s}
.tgl .sw i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;transition:transform .45s cubic-bezier(.34,1.56,.64,1)}
.tgl[aria-pressed=true] .sw i{transform:translateX(12px)}
.info{opacity:.75;cursor:help}
.chips{display:flex;gap:8px;align-items:center;margin-left:auto}
.chip{display:inline-flex;align-items:center;gap:6px;font:600 12px var(--m);padding:7px 11px;border-radius:999px;white-space:nowrap}
.chip b{font-weight:700}
.chip em{font-style:normal;font-weight:700}
.seg{position:relative;display:inline-flex;padding:3px;border-radius:999px}
.seg button{position:relative;z-index:1;font:700 11.5px var(--m);padding:6px 12px;border-radius:999px;transition:color .3s}
.seg-ind{position:absolute;top:3px;bottom:3px;left:3px;border-radius:999px;transition:transform .55s cubic-bezier(.34,1.45,.64,1),width .4s}
.tip{position:fixed;left:0;top:0;z-index:80;pointer-events:none;font:600 11.5px/1.35 var(--m);padding:7px 10px;border-radius:9px;max-width:260px;opacity:0;transition:opacity .15s}
.tip.on{opacity:1}
.kick{font:700 10.5px var(--m);letter-spacing:.14em;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.pair{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 4px;font-size:30px;letter-spacing:-.02em;line-height:1.1}
.pair small{font:600 12px var(--m);letter-spacing:0}
.headline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:8px}
.big{font-weight:800;font-size:64px;letter-spacing:-.04em;line-height:.95;font-variant-numeric:tabular-nums}
.per{font:600 14px var(--m)}
.breakdown{font:500 13px var(--m);margin-top:10px}
.breakdown b{font-weight:700}
.lg3{display:flex;gap:14px;flex-wrap:wrap;font:600 11px var(--m)}
.lg{display:inline-flex;align-items:center;gap:6px}
.lg i{display:inline-block;width:12px;height:12px;border-radius:3px}
.next{list-style:none;margin:0;padding:0}
.nx{display:grid;grid-template-columns:22px 1fr auto auto;align-items:center;gap:12px;padding:13px 12px 13px 14px;position:relative;border-radius:14px;outline:none}
.nx:before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:var(--c)}
.nx .rank{font:700 11px var(--m);opacity:.6}
.nx .nm b{display:flex;align-items:center;gap:6px;font-size:15px}
.nx .nm em{display:block;font:500 11px var(--m);font-style:normal;margin-top:3px}
.nx .val{text-align:right}
.nx .val b{display:block;font:800 19px var(--m);font-variant-numeric:tabular-nums}
.nx .val em{display:block;font:500 10.5px var(--m);font-style:normal}
.nx .stag{font:700 10px var(--m);padding:3px 7px;border-radius:99px}
.nx.stable{transform:translateY(8px);opacity:0;transition:transform .5s cubic-bezier(.34,1.56,.64,1),opacity .35s}
.nx.stable.pop{transform:none;opacity:1}.nx.stable.bye{opacity:0;transform:translateX(20px)}
.lanes{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.lane header{display:flex;align-items:center;gap:9px}
.lane h3{margin:0;font-size:15px;letter-spacing:-.01em}
.lane .n{margin-left:auto;font:800 12px var(--m);padding:3px 9px;border-radius:99px}
.lane .ico{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;font-size:14px}
.lane p{margin:8px 0 10px;font:500 11.5px var(--m)}
.lane ul{list-style:none;margin:0;padding:0}
.lane li{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0 8px 10px;position:relative}
.lane li:before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:2px;background:var(--c)}
.lane li b{display:block;font-size:13px}
.lane li em{display:block;font:500 10.5px var(--m);font-style:normal;margin-top:2px}
.lane .lv{font:800 13px var(--m)}
.fees{position:relative}
.fee-bars{display:flex;align-items:flex-end;gap:4px;height:92px}
.fee-bars i{flex:1;height:var(--h);border-radius:4px 4px 2px 2px;transform-origin:bottom;transform:scaleY(.02);transition:transform .9s cubic-bezier(.34,1.4,.64,1) calc(var(--i)*28ms),filter .2s;cursor:default}
.fees.in .fee-bars i{transform:scaleY(1)}
.fee-bars.go i{animation:regrow .8s cubic-bezier(.34,1.4,.64,1) calc(var(--i)*18ms) both}
@keyframes regrow{from{transform:scaleY(.05)}to{transform:scaleY(1)}}
.fee-ax{display:flex;justify-content:space-between;font:500 10.5px var(--m);margin-top:6px}
.fl{display:inline-flex;align-items:center;gap:6px;font:600 11px var(--m)}
.fl i{display:inline-block;width:12px;height:12px;border-radius:3px}
.rv{opacity:0;transform:translateY(18px);transition:opacity .7s ease calc(var(--i,0)*90ms),transform .9s cubic-bezier(.22,1.3,.36,1) calc(var(--i,0)*90ms)}
.rv.in{opacity:1;transform:none}
.tag3{position:absolute;left:0;top:0;pointer-events:none;font:700 10.5px var(--m);white-space:nowrap;padding:4px 8px;border-radius:99px;will-change:transform;z-index:3}
.fallback{position:absolute;inset:10px;display:flex;flex-direction:column}.fallback svg{flex:1}.fallback small{font:500 10px var(--m);opacity:.6}
canvas{display:block}
@media (max-width:760px){
  .wrap{padding:26px 14px 30px}
  .tb{gap:8px;padding:10px 0 14px}
  .brand{font-size:17px;margin-right:auto;order:0}
  .seg{order:1}.tgl{order:2;flex:none}
  .chips{order:3;flex:1;min-width:0;margin:0;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;-webkit-mask:linear-gradient(90deg,#000 88%,transparent)}
  .chips::-webkit-scrollbar{display:none}
  .pair{font-size:24px}
  .big{font-size:52px}
  .lanes{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:78%;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px;scrollbar-width:none}
  .lanes::-webkit-scrollbar{display:none}
  .lane{scroll-snap-align:start}
  .nx{grid-template-columns:18px 1fr auto;gap:10px}
  .nx .spark{display:none}
}
@media (prefers-reduced-motion:reduce){
  *,*:before,*:after{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important;transition-delay:0s!important}
  .rv{opacity:1;transform:none}
}`;

function page({ id, title, css, head = '', body, module, extraScripts = '' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
${head}
<style>${BASE_CSS}
${css}</style>
${IMPORTMAP}
</head>
<body class="dir-${id}">
${body}
<script>${DATA_JS}
${RUNTIME_JS}</script>
${extraScripts}
<script type="module">
${module}
</script>
</body></html>
`;
}

module.exports = { page, ribbon, topbar, heroCopy, legend3d, nextList, lanes, feeStrip, feeLegend, markSVG, CHAIN, NEXT };
