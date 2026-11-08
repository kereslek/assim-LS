// F · Holo / Orbital: chains as planets, pools as glowing moons; click one to zoom into its liquidity shape.
const C = require('./common');

const css = `
:root{--f:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,"Segoe UI",Roboto,system-ui,sans-serif;--m:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
--bg-solid:#16285F;--fg:#EAF4FF;--mut:#A3B6DD;--acc:#55F0FF;--mag:#FF6AD5;--vio:#8F86FF;--amber:#FFC46B;--neg:#FF8BA7;--line:rgba(85,240,255,.2);
--gauge:#55F0FF;--gauge-bg:rgba(255,255,255,.15)}
body{background:radial-gradient(1200px 700px at 30% -10%,#2C4AA0 0%,rgba(44,74,160,0) 60%),radial-gradient(900px 600px at 100% 30%,rgba(255,106,213,.16),transparent 60%),linear-gradient(180deg,#1A2D6A 0%,#152660 50%,#13235A 100%);background-attachment:fixed}
.hgrid{position:fixed;left:-50%;right:-50%;bottom:-10%;height:55vh;z-index:0;pointer-events:none;background-image:linear-gradient(rgba(85,240,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(85,240,255,.18) 1px,transparent 1px);background-size:60px 60px;transform:perspective(500px) rotateX(62deg);transform-origin:50% 100%;-webkit-mask:linear-gradient(0deg,#000 10%,transparent 85%);mask:linear-gradient(0deg,#000 10%,transparent 85%);animation:gridrun 6s linear infinite;opacity:.55}
@keyframes gridrun{to{background-position:0 60px,0 0}}
.scan{position:fixed;inset:0;z-index:1;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 3px)}
.card{position:relative;background:linear-gradient(160deg,rgba(40,70,160,.55),rgba(22,40,100,.6));border:1px solid var(--line);border-radius:20px;box-shadow:0 0 0 1px rgba(85,240,255,.04) inset,0 30px 70px -30px rgba(5,10,40,.7),0 0 40px -20px rgba(85,240,255,.35);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.card:before{content:"";position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;padding:1px;background:linear-gradient(135deg,rgba(85,240,255,.7),transparent 25%,transparent 75%,rgba(255,106,213,.6));-webkit-mask:linear-gradient(#000,#000) content-box,linear-gradient(#000,#000);-webkit-mask-composite:xor;mask-composite:exclude}
.brand{color:var(--fg)}.brand svg{color:var(--acc)}
.tgl,.chip,.seg{background:rgba(20,40,100,.6);border:1px solid var(--line);color:var(--mut)}
.tgl .sw{background:rgba(255,255,255,.16)}.tgl .sw i{background:#fff}
.tgl[aria-pressed=true]{color:var(--acc)}.tgl[aria-pressed=true] .sw{background:var(--acc)}.tgl[aria-pressed=true] .sw i{background:#0b2050}
.chip b{color:var(--fg)}.up{color:var(--acc)}.dn{color:var(--neg)}
.fl-up{animation:g1 .9s}.fl-dn{animation:g2 .9s}@keyframes g1{30%{box-shadow:0 0 16px rgba(85,240,255,.6)}}@keyframes g2{30%{box-shadow:0 0 16px rgba(255,139,167,.6)}}
.seg button{color:var(--mut)}.seg button.on{color:#06163f}.seg-ind{background:linear-gradient(90deg,#55F0FF,#9CF7FF);box-shadow:0 0 18px rgba(85,240,255,.6)}
.tip{background:rgba(14,30,80,.94);color:var(--fg);border:1px solid var(--line);box-shadow:0 0 24px -6px rgba(85,240,255,.5)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:18px}
.orbit{grid-row:span 2;min-height:660px;overflow:hidden;padding:0;background:radial-gradient(70% 60% at 55% 55%,rgba(60,90,200,.45),rgba(20,36,96,.5))}
.stage{position:absolute;inset:0;cursor:grab}.stage.hov{cursor:pointer}
.stage canvas{width:100%!important;height:100%!important}
.orbit .hero-copy{position:absolute;left:22px;top:22px;z-index:4;width:400px;max-width:calc(100% - 44px);padding:18px 20px;background:linear-gradient(160deg,rgba(24,46,120,.78),rgba(16,32,88,.7));border:1px solid var(--line);clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px));backdrop-filter:blur(10px);transition:opacity .3s}
.orbit .hero-copy.swap{opacity:.25}
.kick{color:var(--acc)}.kick b{color:var(--fg)}
.kick .dot{width:8px;height:8px;background:var(--mag);box-shadow:0 0 12px var(--mag);transform:rotate(45deg)}
.pair{color:var(--fg);font-size:26px}.pair small{color:var(--mut)}
.big{font-size:56px;color:var(--fg);text-shadow:0 0 24px rgba(85,240,255,.55),0 0 2px #fff}
.per{color:var(--acc)}.breakdown{color:var(--mut);font-size:12px}.pos{color:var(--acc)}.neg{color:var(--neg)}.apr{color:var(--fg)}
.chainbar{position:absolute;left:22px;bottom:20px;z-index:4;display:flex;gap:8px;flex-wrap:wrap}
.cb{display:inline-flex;align-items:center;gap:7px;font:600 11.5px var(--m);color:var(--mut);background:rgba(16,32,88,.7);border:1px solid var(--line);padding:7px 11px;border-radius:99px;backdrop-filter:blur(8px);transition:border-color .3s,color .3s}
.cb b{color:var(--fg)}.cb:hover{border-color:var(--acc);color:var(--fg)}
.ohint{position:absolute;right:22px;bottom:24px;z-index:4;font:600 10.5px var(--m);color:var(--mut);letter-spacing:.06em}
.back{position:absolute;right:20px;top:20px;z-index:5;font:700 12px var(--m);color:#06163f;background:var(--acc);padding:8px 14px;border-radius:99px;box-shadow:0 0 20px rgba(85,240,255,.6);opacity:0;transform:translateY(-8px);pointer-events:none;transition:opacity .3s,transform .4s cubic-bezier(.34,1.56,.64,1)}
.back.on{opacity:1;transform:none;pointer-events:auto}
.tag3{background:rgba(14,30,84,.8);border:1px solid var(--line);color:var(--fg)}
.tag3.pl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;border-color:var(--c);color:var(--fg);box-shadow:0 0 14px -4px var(--c)}
.tag3.best{background:var(--mag);color:#2a0525;border:0;box-shadow:0 0 18px rgba(255,106,213,.7)}
.tag3.sel{background:var(--acc);color:#06163f;border:0;box-shadow:0 0 18px rgba(85,240,255,.7)}
.shape{padding:18px 18px 14px}
.shape .hd{display:flex;justify-content:space-between;align-items:center;gap:10px}
.shape .kick{color:var(--mut)}.shape .kick b{color:var(--acc)}
.stage2{position:relative;height:250px;margin:6px -8px 4px}
.shape .lg3{color:var(--mut);justify-content:center}
.lg.in i{background:var(--acc);box-shadow:0 0 10px var(--acc)}.lg.px i{background:var(--mag);height:3px;box-shadow:0 0 8px var(--mag)}.lg.gh i{border:1.5px dashed var(--amber)}
.tag3.px{background:var(--mag);color:#2a0525;border:0}.tag3.gh{color:var(--amber);border-color:rgba(255,196,107,.5)}.tag3.in{color:var(--acc)}
.side{padding:20px 14px 12px}
.side .kick{padding:0 12px 10px;color:var(--mut)}
.nx{cursor:pointer;transition:background .25s,transform .4s cubic-bezier(.34,1.56,.64,1)}
.nx:hover,.nx:focus-visible{background:rgba(85,240,255,.08);transform:translateX(4px)}
.nx.cur{background:rgba(85,240,255,.12);box-shadow:0 0 0 1px rgba(85,240,255,.35) inset}
.nx .nm b{color:var(--fg)}.nx .nm em,.nx .val em,.nx .rank{color:var(--mut)}.nx .val b{color:var(--acc);text-shadow:0 0 12px rgba(85,240,255,.5)}.nx .spark{color:var(--mag)}
.nx .stag{background:rgba(143,134,255,.25);color:#D6D2FF}
.lanes-card,.fee-card{grid-column:1/-1;padding:22px}
.lanes-card .kick,.fee-card .kick{color:var(--mut);margin-bottom:14px}
.lane{background:rgba(16,34,90,.6);border:1px solid var(--line);border-radius:14px;padding:14px;clip-path:polygon(0 0,calc(100% - 14px) 0,100% 14px,100% 100%,0 100%);transition:transform .45s cubic-bezier(.34,1.56,.64,1),background .3s}
.lane:hover,.lane:focus-visible{transform:translateY(-4px);background:rgba(26,52,130,.7);outline:none}
.lane .ico{background:rgba(85,240,255,.14);color:var(--acc)}.lane[data-lane=cex] .ico{background:rgba(255,106,213,.16);color:var(--mag)}.lane[data-lane=xc] .ico{background:rgba(143,134,255,.2);color:#C4BFFF}.lane[data-lane=ret] .ico{background:rgba(255,196,107,.16);color:var(--amber)}
.lane .n{background:rgba(255,255,255,.1);color:var(--fg)}.lane p,.lane li em{color:var(--mut)}.lane li b{color:var(--fg)}.lane .lv{color:var(--acc)}
.lane li+li{border-top:1px dashed var(--line)}
.fee-card .row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}.fee-card .row .kick{margin:0}
.fee-card .lgd{display:flex;gap:14px;align-items:center}
.fee-bars{height:100px}
.fee-bars i.est{background:linear-gradient(180deg,rgba(143,134,255,.45),rgba(143,134,255,.1));border:1px dashed rgba(170,160,255,.7);border-bottom:0}
.fee-bars i.ex{background:linear-gradient(180deg,#9CF7FF,#22B8D6);box-shadow:0 0 14px -2px rgba(85,240,255,.6)}
.fee-bars i:hover{filter:brightness(1.3)}
.fl{color:var(--mut)}.fl i.est{background:rgba(143,134,255,.35);border:1px dashed rgba(170,160,255,.8)}.fl i.ex{background:var(--acc)}
.fee-ax{color:var(--mut)}.fee-sum{font:600 12px var(--m);color:var(--mut)}.fee-sum b{color:var(--fg)}
.fallback small{color:var(--mut)}
@media (max-width:1100px){.grid{grid-template-columns:minmax(0,1fr)}.orbit{grid-row:auto}.lanes{grid-template-columns:repeat(2,1fr)}}
@media (max-width:760px){
 .orbit{min-height:0;display:flex;flex-direction:column}
 .orbit .hero-copy{position:relative;left:auto;top:auto;width:auto;max-width:none;margin:14px 14px 0}
 .stage{position:relative;inset:auto;height:380px}
 .chainbar{position:relative;left:auto;bottom:auto;margin:0 14px 14px;justify-content:center}
 .ohint{display:none}
 .back{top:auto;bottom:70px;right:16px}
 .big{font-size:48px}.pair{font-size:22px}
 .shape,.side,.lanes-card,.fee-card{padding:16px 12px}
 .lanes{grid-template-columns:none}
}`;

// 17 made-up pools across three chains. v = $/day per $1,000.
const POOLS = {
  eth: [['DEF/WETH', '1.00% · Uni v3', 1.86, 58], ['VWX/WETH', '0.30% · Uni v3', 1.21, 55], ['HIJ/WETH', '0.30% · Uni v4', .95, 49], ['OPQ/WETH', '1.00% · Uni v3', .62, 42], ['RST/WETH', '0.30% · Uni v3', .48, 38], ['UVW/WETH', '0.05% · Uni v4', .33, 33]],
  base: [['ABC/WETH', '0.30% · Uni v3', 2.41, 72], ['PQR/WETH', '1.00% · Uni v4', 1.64, 61], ['BCD/WETH', '0.30% · Uni v3', 1.37, 57], ['GHI/cbBTC', '0.05% · Uni v4', 1.12, 51], ['YZA/WETH', '0.30% · Pancake v3', .88, 47], ['MNO/WETH', '0.30% · Pancake v3', .81, 44], ['KLM/cbBTC', '0.30% · Uni v3', .58, 40]],
  bnb: [['JKL/WBNB', '0.25% · Pancake v3', .94, 47], ['STU/WBNB', '0.25% · Pancake v3', .77, 45], ['EFG/WBNB', '0.05% · Pancake v3', .69, 43], ['XYZ/WBNB', '1.00% · Pancake v3', .41, 36]],
};

const body = `
<div class="hgrid" aria-hidden="true"></div><div class="scan" aria-hidden="true"></div>
${C.ribbon('F · HOLO ORBITAL')}
<div class="wrap">
${C.topbar({ logo: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="#55F0FF"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="#55F0FF" stroke-width="1.6" transform="rotate(-20 12 12)"/><circle cx="20.6" cy="9" r="1.7" fill="#FF6AD5"/></svg>' })}
<main class="grid">
  <section class="card orbit" aria-label="Pools in orbit">
    <div class="stage" id="stage" data-fallback='["#55F0FF","#4a5bb8","#FF6AD5"]'></div>
    ${C.heroCopy()}
    <div class="chainbar">${['eth', 'base', 'bnb'].map((k) => `<button type="button" class="cb" data-chain="${k}">${C.markSVG(k, 12)} ${C.CHAIN[k][0]} <b>${POOLS[k].length}</b></button>`).join('')}</div>
    <div class="ohint">drag to spin · click a glowing pool</div>
    <button type="button" class="back">← all chains</button>
  </section>
  <section class="card shape" aria-label="Liquidity shape">
    <div class="hd"><div class="kick">Liquidity shape · <b id="shapeName">ABC/WETH</b></div></div>
    <div class="stage2" id="stage2"></div>
    ${C.legend3d()}
  </section>
  <aside class="card side" aria-label="Next best">
    <div class="kick">Next best · $/day per $1,000</div>
    ${C.nextList()}
  </aside>
  <section class="card lanes-card rv" aria-label="Discovery">
    <div class="kick">Discovery lanes</div>
    ${C.lanes()}
  </section>
  <section class="card fee-card rv" aria-label="Fee history">
    <div class="row"><div class="kick">Fee history · ABC/WETH · 30 d</div><div class="lgd">${C.feeLegend}<span class="fee-sum">avg <b>$3.12</b>/day</span></div></div>
    ${C.feeStrip()}
  </section>
</main>
</div>
<script>window.POOLS = ${JSON.stringify(POOLS)};
window.CHAINS = ${JSON.stringify(C.CHAIN)};
window.MARKS = ${JSON.stringify({ eth: C.markSVG('eth', 18), base: C.markSVG('base', 18), bnb: C.markSVG('bnb', 18) })};</script>`;

const mod = `
import * as THREE from 'three';
const D = window.LPD, RM = window.RM;
const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };
const VS = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }';

// ---------- pools ----------
let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pools = [];
for (const ch of ['eth', 'base', 'bnb']) window.POOLS[ch].forEach((p, k) => {
  const best = p[0] === 'ABC/WETH';
  const shape = best ? Array.from({ length: D.N }, (_, i) => D.liq(i, 0)) : D.shape([8 + rnd() * 4, 2.6 + rnd() * 1.4, 24 + rnd() * 5, 3 + rnd(), .55 + rnd() * .45, .12 + rnd() * .35, k + 2]);
  pools.push({ ch, k, pair: p[0], meta: p[1], v: p[2], gem: p[3], best, shape, fees: +(p[2] * 1.577).toFixed(2) });
});
pools.forEach(p => { p.lvr = +(p.fees - p.v).toFixed(2); });

// ---------- holographic bar chart (used in the side card and above a zoomed pool) ----------
function holoChart(nBars) {
  const grp = new THREE.Group(), SX = .3, w = SX * .74, d = .5;
  const g = new THREE.BoxGeometry(w, 1, d); g.translate(0, .5, 0);
  const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 }, a: { value: 1 } },
    vertexShader: 'varying vec3 vL; varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vY; void main(){ vL=position; vC=instanceColor; vec4 w=modelMatrix*instanceMatrix*vec4(position,1.); vY=w.y; vN=normalize(mat3(modelMatrix*instanceMatrix)*normal); vV=normalize(cameraPosition-w.xyz); gl_Position=projectionMatrix*viewMatrix*w; }',
    fragmentShader: 'uniform float t; uniform float a; varying vec3 vL; varying vec3 vN; varying vec3 vV; varying vec3 vC; varying float vY; void main(){ float fr=pow(1.-abs(dot(vN,vV)),1.6); vec3 q=abs(vL/vec3(${(0.3 * 0.74 / 2).toFixed(4)},1.,.25)); q.y=abs(vL.y*2.-1.); float ex=smoothstep(.86,1.,q.x), ez=smoothstep(.9,1.,q.z), ey=smoothstep(.96,1.,q.y); float edge=max(ex*ez,max(ex*ey,ez*ey)); float sc=step(.55,fract(vY*14.-t*1.2))*.12; vec3 col=vC*(.16+fr*.9+edge*1.3+sc); gl_FragColor=vec4(col*a,1.); }' });
  const mesh = new THREE.InstancedMesh(g, mat, nBars); const col = new THREE.Color();
  for (let i = 0; i < nBars; i++) { col.set(i >= D.LO && i <= D.HI ? 0x55f0ff : 0x6f6cff); mesh.setColorAt(i, col); }
  grp.add(mesh);
  const X = i => (i - (nBars - 1) / 2) * SX;
  // floor band + price beam + ghost wire caps
  const bw = (D.HI - D.LO + 1) * SX, bx = (X(D.LO) + X(D.HI)) / 2;
  const band = new THREE.Mesh(new THREE.PlaneGeometry(bw, 1.4), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { a: { value: 1 } }, vertexShader: VS,
    fragmentShader: 'uniform float a; varying vec2 vUv; void main(){ float e=1.-smoothstep(.0,.05,min(vUv.x,1.-vUv.x)); float f=smoothstep(0.,.5,vUv.y)*smoothstep(1.,.5,vUv.y); gl_FragColor=vec4(vec3(.33,.94,1.)*(.12+e*.8)*f*a,1.); }' }));
  band.rotation.x = -Math.PI / 2; band.position.set(bx, .01, 0); grp.add(band);
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(.22, 4.2), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 }, a: { value: 1 } }, vertexShader: VS, side: THREE.DoubleSide,
    fragmentShader: 'uniform float t; uniform float a; varying vec2 vUv; void main(){ float x=abs(vUv.x-.5)*2.; float c=smoothstep(.35,0.,x)+pow(1.-x,3.)*.3; c*=smoothstep(1.,.6,vUv.y)*(.85+.15*sin(t*4.+vUv.y*30.)); gl_FragColor=vec4(vec3(1.,.42,.84)*c*1.3*a,1.); }' }));
  beam.position.y = 2.1; grp.add(beam);
  const gbox = new THREE.BoxGeometry(w, 1, d); gbox.translate(0, .5, 0); const eg = new THREE.EdgesGeometry(gbox);
  const gmat = new THREE.LineDashedMaterial({ color: 0xffc46b, dashSize: .06, gapSize: .05, transparent: true, ...ADD });
  const ghosts = []; for (let i = D.LO; i <= D.HI; i++) { const l = new THREE.LineSegments(eg, gmat); l.computeLineDistances(); l.position.x = X(i); grp.add(l); ghosts.push({ l, i }); }
  const cur = new Float32Array(nBars), target = new Float32Array(nBars), dummy = new THREE.Object3D();
  return { grp, mesh, mat, band, beam, gmat, X, cur, target, ghosts,
    set(shape, price) { for (let i = 0; i < nBars; i++) target[i] = shape[i]; beam.position.x = X(price); },
    update(t, dt, HS, alpha) { for (let i = 0; i < nBars; i++) { cur[i] += (target[i] - cur[i]) * Math.min(1, dt * (3 + (i % 5) * .6)); dummy.position.set(X(i), 0, 0); dummy.scale.set(1, Math.max(.003, cur[i] * HS), 1); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); }
      mesh.instanceMatrix.needsUpdate = true; mat.uniforms.t.value = t; beam.material.uniforms.t.value = t;
      mat.uniforms.a.value = band.material.uniforms.a.value = beam.material.uniforms.a.value = alpha; gmat.opacity = alpha * (.55 + .45 * Math.sin(t * 2.6));
      ghosts.forEach(o => { o.l.position.y = cur[o.i] * HS; o.l.scale.y = Math.max(.001, D.ghost(o.i) * HS); }); } };
}

// ---------- side card chart ----------
const host2 = document.getElementById('stage2');
const r2 = new THREE.WebGLRenderer({ antialias: true, alpha: true }); r2.setPixelRatio(Math.min(devicePixelRatio, 2)); host2.appendChild(r2.domElement);
const s2 = new THREE.Scene(), c2 = new THREE.PerspectiveCamera(30, 1, .1, 100);
const chart = holoChart(D.N); s2.add(chart.grp);
const grid2 = new THREE.GridHelper(14, 28, 0x55f0ff, 0x3a52b0); grid2.material.transparent = true; grid2.material.opacity = .22; s2.add(grid2);
const tag = (h, cls, txt) => { const d = document.createElement('div'); d.className = 'tag3 ' + cls; d.textContent = txt; h.appendChild(d); return d; };
const t2 = [[tag(host2, 'px', 'price'), () => new THREE.Vector3(chart.beam.position.x, 3.6, 0)], [tag(host2, 'gh', '+2 pools'), () => new THREE.Vector3(chart.X(D.HI) + .25, (chart.cur[D.HI] + D.ghost(D.HI)) * 2.2 + .35, 0)]];
let W2 = 1, H2 = 1;
function size2() { const r = host2.getBoundingClientRect(); W2 = Math.max(1, r.width); H2 = Math.max(1, r.height); r2.setSize(W2, H2, false); c2.aspect = W2 / H2; c2.updateProjectionMatrix(); }
new ResizeObserver(size2).observe(host2); size2();

// ---------- orbital scene ----------
const host = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); host.appendChild(renderer.domElement);
window.__sceneOK = true;
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, .1, 200);
const sys = new THREE.Group(); scene.add(sys);

// stars
{ const n = 900, p = new Float32Array(n * 3), s = new Float32Array(n); for (let k = 0; k < n; k++) { const u = rnd() * 2 - 1, th = rnd() * 6.283, r = 40 + rnd() * 30, q = Math.sqrt(1 - u * u); p[k*3] = q * Math.cos(th) * r; p[k*3+1] = u * r; p[k*3+2] = q * Math.sin(th) * r; s[k] = rnd(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('s', new THREE.BufferAttribute(s, 1));
  scene.add(new THREE.Points(g, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 } },
    vertexShader: 'attribute float s; uniform float t; varying float vA; void main(){ vA=.35+.65*abs(sin(t*.8+s*40.)); vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=1.+s*2.2; gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'varying float vA; void main(){ float d=length(gl_PointCoord-.5); gl_FragColor=vec4(vec3(.75,.9,1.)*smoothstep(.5,0.,d)*vA*.8,1.); }' }))); }

// holo floor disc
const disc = new THREE.Mesh(new THREE.CircleGeometry(13, 96), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 } },
  vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: 'uniform float t; varying vec3 vP; void main(){ float r=length(vP.xy); float a=atan(vP.y,vP.x); float ring=1.-smoothstep(0.,.03,abs(fract(r*1.)-.5)-.47); float rad=1.-smoothstep(0.,.012*r,abs(fract(a/6.2832*36.)-.5)*6.2832/36.*r); float sweep=pow(fract((a/6.2832)+t*.05),8.); float f=smoothstep(13.,4.,r); vec3 c=vec3(.33,.94,1.)*(ring*.22+rad*.08+sweep*.18)*f; gl_FragColor=vec4(c,1.); }' }));
disc.rotation.x = -Math.PI / 2; disc.position.y = -1.6; sys.add(disc);

// core
const core = new THREE.Group(); sys.add(core);
core.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(.9, 1)), new THREE.LineBasicMaterial({ color: 0x55f0ff, transparent: true, opacity: .75, ...ADD })));
core.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(.55, 0)), new THREE.LineBasicMaterial({ color: 0xff6ad5, transparent: true, opacity: .9, ...ADD })));

// glow points (planets, nodes, core) drawn as one buffer
const GL = []; const glowG = new THREE.BufferGeometry(); let glowPos, glowCol, glowSize;
const glowMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { px: { value: 1 } },
  vertexShader: 'attribute vec3 c; attribute float sz; uniform float px; varying vec3 vC; void main(){ vC=c; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=sz*px/-mv.z; gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'varying vec3 vC; void main(){ float d=length(gl_PointCoord-.5)*2.; float a=exp(-d*d*4.)*.9+exp(-d*d*28.)*.6; gl_FragColor=vec4(vC*a,1.); }' });

const planetMat = c => new THREE.ShaderMaterial({ uniforms: { c: { value: new THREE.Color(c) }, t: { value: 0 }, dim: { value: 1 } },
  vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec2 vUv; void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.); vN=normalize(mat3(modelMatrix)*normal); vV=normalize(cameraPosition-w.xyz); gl_Position=projectionMatrix*viewMatrix*w; }',
  fragmentShader: 'uniform vec3 c; uniform float t; uniform float dim; varying vec3 vN; varying vec3 vV; varying vec2 vUv; void main(){ float f=pow(1.-max(dot(vN,vV),0.),2.4); float lat=abs(fract(vUv.y*10.)-.5); float lon=abs(fract(vUv.x*20.+t*.03)-.5); float gr=(1.-smoothstep(0.,.05,lat))+(1.-smoothstep(0.,.05,lon)); float sc=1.-smoothstep(0.,.02,abs(fract(vUv.y-t*.12)-.5)); float l=.25+.6*max(dot(vN,normalize(vec3(.4,.8,.5))),0.); vec3 col=c*(.22*l+gr*.22+sc*.5)+c*f*1.5+vec3(1.)*f*.3; gl_FragColor=vec4(col*dim,1.); }' });

const CH = { eth: { r: 5.4, size: .78, sp: .055, ph: .4, tilt: .0 }, base: { r: 3.4, size: .64, sp: .085, ph: 2.6, tilt: .0 }, bnb: { r: 7.6, size: .58, sp: .04, ph: 4.4, tilt: .0 } };
const planets = {}, nodes = [];
for (const k of ['base', 'eth', 'bnb']) {
  const cfg = CH[k], colr = window.CHAINS[k][1];
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 160 }, (_, i) => new THREE.Vector3(Math.cos(i / 160 * 6.283) * cfg.r, 0, Math.sin(i / 160 * 6.283) * cfg.r))),
    new THREE.LineBasicMaterial({ color: colr, transparent: true, opacity: .32, ...ADD })); sys.add(ring);
  const pg = new THREE.Group(); sys.add(pg);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(cfg.size, 48, 32), planetMat(colr)); pg.add(mesh);
  const pl = { k, cfg, pg, mesh, ring, colr, gi: GL.push({ obj: pg, c: new THREE.Color(colr), sz: cfg.size * 260 }) - 1 }; planets[k] = pl;
  pools.filter(p => p.ch === k).forEach((p, j, arr) => {
    const orb = new THREE.Group(); orb.rotation.set((j % 3 - 1) * .5 + .15, j * 1.1, (j % 2 ? .3 : -.25)); pg.add(orb);
    const rr = cfg.size + .55 + j * .2;
    orb.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos(i / 64 * 6.283) * rr, 0, Math.sin(i / 64 * 6.283) * rr))), new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .1, ...ADD })));
    const holder = new THREE.Group(); orb.add(holder);
    const sz = .06 + p.v * .055, cc = p.best ? 0xff6ad5 : (p.v > 1.1 ? 0x55f0ff : 0x8fb6ff);
    const n = new THREE.Mesh(new THREE.SphereGeometry(sz, 20, 14), new THREE.MeshBasicMaterial({ color: cc })); holder.add(n);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(Math.max(.32, sz * 2.4), 8, 6), new THREE.MeshBasicMaterial({ visible: false })); holder.add(hit);
    const node = { p, orb, holder, n, hit, rr, ph: j * 2.1 + rnd(), sp: .5 - j * .04 + rnd() * .1, gi: GL.push({ obj: n, c: new THREE.Color(cc), sz: 34 + p.v * 70 }) - 1 }; hit.userData.node = node; nodes.push(node);
  });
}
GL.push({ obj: core, c: new THREE.Color(0x55f0ff), sz: 420 });
glowPos = new Float32Array(GL.length * 3); glowCol = new Float32Array(GL.length * 3); glowSize = new Float32Array(GL.length);
glowG.setAttribute('position', new THREE.BufferAttribute(glowPos, 3)); glowG.setAttribute('c', new THREE.BufferAttribute(glowCol, 3)); glowG.setAttribute('sz', new THREE.BufferAttribute(glowSize, 1));
scene.add(new THREE.Points(glowG, glowMat));

// best-find pulse ring
const pulse = new THREE.Mesh(new THREE.RingGeometry(.2, .24, 48), new THREE.MeshBasicMaterial({ color: 0xff6ad5, transparent: true, side: THREE.DoubleSide, ...ADD })); scene.add(pulse);
// zoom hologram
const zoomChart = holoChart(D.N); zoomChart.grp.scale.setScalar(.075); scene.add(zoomChart.grp);

// tags
const tags = [];
for (const k in planets) { const pl = planets[k]; const el = tag(host, 'pl', window.CHAINS[k][0] + ' · ' + window.POOLS[k].length); el.style.setProperty('--c', pl.colr); tags.push([el, () => pl.pg.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, pl.cfg.size + .35, 0))]); }
const bestNode = nodes.find(n => n.p.best);
const bestTag = tag(host, 'best', 'ABC/WETH · $2.41/day'); tags.push([bestTag, () => bestNode.n.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, .3, 0))]);
const selTag = tag(host, 'sel', ''); selTag.style.opacity = 0;

// camera control: auto-spin, drag, fly-to-node
let W = 1, H = 1, spin = 0, spinV = 0, drag = null, sel = null, zoomA = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3(), tmp = new THREE.Vector3();
function homeView() { const phone = W < 560; wantLook.set(phone ? 0 : 1.2, phone ? -.4 : -.2, 0); wantPos.set(phone ? 0 : 1.2, phone ? 10.5 : 7.4, phone ? 19.5 : 15.6); }
function resize() { const r = host.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height); renderer.setSize(W, H, false); camera.aspect = W / H; camera.fov = W < 560 ? 46 : 38; camera.updateProjectionMatrix(); glowMat.uniforms.px.value = H * renderer.getPixelRatio() / 700; if (!sel) homeView(); }
new ResizeObserver(resize).observe(host); resize(); camPos.copy(wantPos).add(new THREE.Vector3(0, 6, 8)); camLook.copy(wantLook);
const ray = new THREE.Raycaster(), mv = new THREE.Vector2(), hits = nodes.map(n => n.hit);
function pick(e) { const r = host.getBoundingClientRect(); mv.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mv, camera); const h = ray.intersectObjects(hits)[0]; return h ? h.object.userData.node : null; }
host.addEventListener('pointerdown', e => { drag = { x: e.clientX, s: spin, moved: false }; });
host.addEventListener('pointermove', e => { if (drag) { const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true; if (!sel) { const ns = drag.s + dx * .006; spinV = ns - spin; spin = ns; } }
  const n = pick(e); host.classList.toggle('hov', !!n); if (n && !drag) window.LPUI.tip.show(n.p.pair + ' · ' + window.CHAINS[n.p.ch][0] + ' · $' + n.p.v.toFixed(2) + '/day', e.clientX, e.clientY); else window.LPUI.tip.hide(); });
host.addEventListener('pointerup', e => { const wasDrag = drag && drag.moved; drag = null; if (!wasDrag) { const n = pick(e); if (n) select(n); } });
host.addEventListener('pointerleave', () => { drag = null; window.LPUI.tip.hide(); });
const back = document.querySelector('.back'); back.addEventListener('click', () => select(null));
document.querySelectorAll('.cb').forEach(b => b.addEventListener('click', () => { const n = nodes.filter(x => x.p.ch === b.dataset.chain).sort((a, c) => c.p.v - a.p.v)[0]; select(n); }));
document.querySelectorAll('.next .nx').forEach(li => li.addEventListener('click', () => { const nm = li.querySelector('.nm b').textContent.trim(); const n = nodes.find(x => x.p.pair === nm); if (n) select(n); }));

// hero card + side chart follow the selection
const hc = document.querySelector('.orbit .hero-copy');
function showPool(p) {
  hc.classList.add('swap'); setTimeout(() => {
    hc.querySelector('.kick').innerHTML = '<span class="dot"></span>' + (p.best ? 'BEST FIND' : 'SELECTED') + ' · GEM <b>' + p.gem + '</b>';
    const h1 = hc.querySelector('.pair'); h1.innerHTML = window.MARKS[p.ch] + '<span class="pn">' + p.pair + '</span> <small>' + p.meta.split(' · ')[0] + ' · ' + window.CHAINS[p.ch][0] + ' · ' + p.meta.split(' · ')[1].replace('Uni', 'Uniswap') + '</small>';
    const set = (sel, v) => { const el = hc.querySelector(sel); const from = +(el.dataset.now || el.dataset.count); el.dataset.count = v; window.LPUI.countUp(el, v * window.LPUI.mult, from, 900); el.dataset.now = v * window.LPUI.mult; };
    set('.big', p.v); set('.pos', p.fees); set('.neg', p.lvr);
    const apr = hc.querySelector('.apr'), na = Math.round(p.v * window.LPUI.mult * 36.5); window.LPUI.countUp(apr, na, +(apr.dataset.now || 88), 900); apr.dataset.now = na;
    hc.classList.remove('swap'); }, 220);
  document.getElementById('shapeName').textContent = p.pair; chart.set(p.shape, p.best ? D.price(0) : 17.2 + (p.k % 3) * .6); zoomChart.set(p.shape, p.best ? D.price(0) : 17.2 + (p.k % 3) * .6);
  document.querySelectorAll('.next .nx').forEach(li => li.classList.toggle('cur', li.querySelector('.nm b').textContent.trim() === p.pair));
}
function select(n) { sel = n; back.classList.toggle('on', !!n); zoomChart.cur.fill(0); showPool(n ? n.p : bestNode.p); if (!n) homeView(); }
chart.set(bestNode.p.shape, D.price(0)); zoomChart.set(bestNode.p.shape, D.price(0));
window.__select = i => select(i == null ? null : nodes.find(n => n.p.pair === i));

const v3 = new THREE.Vector3();
function project(el, p, w, h, cam) { v3.copy(p).project(cam); const vis = v3.z < 1; el.style.transform = 'translate(' + ((v3.x * .5 + .5) * w).toFixed(1) + 'px,' + ((-v3.y * .5 + .5) * h).toFixed(1) + 'px) translate(-50%,-100%)'; return vis; }
let tScale = 1, simT = 0;
function frame(t, dt) {
  tScale += ((sel ? .12 : 1) - tScale) * .05; simT += dt * (RM ? 0 : tScale);
  if (!drag && !sel) { spin += spinV; spinV *= .94; spin += dt * .05 * (RM ? 0 : 1); }
  sys.rotation.y = spin;
  for (const k in planets) { const pl = planets[k], a = pl.cfg.ph + simT * pl.cfg.sp; pl.pg.position.set(Math.cos(a) * pl.cfg.r, 0, Math.sin(a) * pl.cfg.r); pl.pg.rotation.y = simT * .2; pl.mesh.material.uniforms.t.value = t; pl.mesh.material.uniforms.dim.value += ((sel && sel.p.ch !== k ? .35 : 1) - pl.mesh.material.uniforms.dim.value) * .08; }
  nodes.forEach(n => { const a = n.ph + simT * n.sp; n.holder.position.set(Math.cos(a) * n.rr, 0, Math.sin(a) * n.rr); });
  core.rotation.set(t * .1, t * .17, 0);
  // glows
  GL.forEach((g, i) => { g.obj.getWorldPosition(tmp); glowPos[i*3] = tmp.x; glowPos[i*3+1] = tmp.y; glowPos[i*3+2] = tmp.z; const dimmed = sel && g.obj !== sel.n && !(planets[sel.p.ch].pg === g.obj) ? .3 : 1;
    glowCol[i*3] = g.c.r * dimmed; glowCol[i*3+1] = g.c.g * dimmed; glowCol[i*3+2] = g.c.b * dimmed; glowSize[i] = g.sz * (g.obj === (sel && sel.n) ? 1.6 + .3 * Math.sin(t * 4) : 1); });
  glowG.attributes.position.needsUpdate = glowG.attributes.c.needsUpdate = glowG.attributes.sz.needsUpdate = true;
  const focus = sel || bestNode; focus.n.getWorldPosition(tmp); pulse.position.copy(tmp); pulse.lookAt(camera.position); const ph = (t * .7) % 1; pulse.scale.setScalar(1 + ph * 2.4); pulse.material.color.set(sel ? 0x55f0ff : 0xff6ad5); pulse.material.opacity = 1 - ph;
  if (sel) { sel.n.getWorldPosition(tmp); wantLook.copy(tmp).add(new THREE.Vector3(0, .32, 0)); const dir = tmp.clone().sub(new THREE.Vector3(0, 0, 0)).setY(0).normalize(); wantPos.copy(tmp).addScaledVector(dir, 2.4).add(new THREE.Vector3(0, 1.0, 0)); }
  camPos.lerp(wantPos, sel ? .05 : .035); camLook.lerp(wantLook, .06); camera.position.copy(camPos); camera.lookAt(camLook);
  zoomA += ((sel ? 1 : 0) - zoomA) * .06; zoomChart.grp.visible = zoomA > .02;
  if (sel) { sel.n.getWorldPosition(tmp); zoomChart.grp.position.copy(tmp).add(new THREE.Vector3(0, .2, 0)); zoomChart.grp.lookAt(camera.position.x, zoomChart.grp.position.y, camera.position.z); }
  zoomChart.update(t, dt, 2.2, zoomA);
  renderer.render(scene, camera);
  tags.forEach(([el, f]) => { const vis = project(el, f(), W, H, camera); el.style.opacity = vis ? (sel ? .25 : 1) : 0; });
  if (sel) { sel.n.getWorldPosition(tmp); tmp.y += .55 * 1.2; project(selTag, tmp, W, H, camera); selTag.textContent = sel.p.pair + ' · $' + sel.p.v.toFixed(2) + '/day'; } selTag.style.opacity = sel && zoomA > .6 ? 1 : 0;
  // side chart
  chart.update(t, dt, 2.2, 1); const a2 = RM ? .5 : .5 + Math.sin(t * .35) * .28;
  c2.position.set(Math.sin(a2) * 11.5, 4.6, Math.cos(a2) * 11.5); c2.lookAt(0, 1.05, 0); r2.render(s2, c2);
  t2.forEach(([el, f]) => project(el, f(), W2, H2, c2));
  s2.traverse(o => { if (o.material && o.material.uniforms && o.material.uniforms.t) o.material.uniforms.t.value = t; });
  disc.material.uniforms.t.value = t; scene.children.forEach(o => { if (o.isPoints && o.material.uniforms.t) o.material.uniforms.t.value = t; });
}
const t0 = performance.now(); let last = t0;
function loop(now) { requestAnimationFrame(loop); const dt = Math.min(.05, (now - last) / 1000); last = now; frame((now - t0) / 1000, dt); }
if (RM) { for (let i = 0; i < 90; i++) frame(i / 30, 1 / 30); addEventListener('resize', () => frame(3, 0)); host.addEventListener('pointerup', () => { for (let i = 0; i < 90; i++) frame(3 + i / 30, 1 / 30); }); }
else requestAnimationFrame(loop);
showPool(bestNode.p);
`;

module.exports = C.page({ id: 'F', title: 'LP Shape · Holo Orbital (mockup)', css, body, module: mod });
