// B · Teal Depth, evolved: an underwater liquidity city.
const C = require('./common');

const css = `
:root{--f:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,"Segoe UI",Roboto,system-ui,sans-serif;--m:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
--bg-solid:#0E3A3E;--fg:#E9F7F4;--mut:#93C2BB;--acc:#FFB547;--mint:#5EE6C8;--coral:#FF8A65;--line:rgba(126,240,214,.16);
--card:linear-gradient(160deg,rgba(28,92,96,.62),rgba(14,58,62,.55));--gauge:#5EE6C8;--gauge-bg:rgba(255,255,255,.14)}
body{background:#0E3A3E}
.ocean{position:fixed;inset:0;z-index:0;overflow:hidden;background:
 radial-gradient(1100px 520px at 62% -12%,rgba(120,240,220,.30),transparent 62%),
 radial-gradient(900px 700px at 8% 110%,rgba(255,181,71,.10),transparent 60%),
 linear-gradient(172deg,#13545A 0%,#0F4448 38%,#0D3A3E 70%,#0B3236 100%)}
.ocean:before,.ocean:after{content:"";position:absolute;inset:-20% -10% 30%;background:
 repeating-linear-gradient(100deg,transparent 0 7%,rgba(160,255,235,.06) 8% 10%,transparent 11% 19%);
 filter:blur(14px);transform-origin:50% 0;animation:rays 14s ease-in-out infinite alternate;mix-blend-mode:screen}
.ocean:after{animation-duration:19s;animation-direction:alternate-reverse;opacity:.7;background:repeating-linear-gradient(80deg,transparent 0 9%,rgba(255,220,160,.045) 10% 12%,transparent 13% 23%)}
@keyframes rays{from{transform:skewX(-6deg) translateX(-3%)}to{transform:skewX(7deg) translateX(3%)}}
.motes{position:fixed;inset:0;z-index:1;pointer-events:none;background-image:radial-gradient(1.5px 1.5px at 20% 30%,rgba(200,255,240,.5),transparent),radial-gradient(1px 1px at 70% 60%,rgba(200,255,240,.4),transparent),radial-gradient(1.2px 1.2px at 40% 80%,rgba(255,220,160,.35),transparent),radial-gradient(1px 1px at 85% 20%,rgba(200,255,240,.4),transparent);background-size:340px 340px;animation:drift 40s linear infinite;opacity:.8}
@keyframes drift{to{background-position:0 -340px}}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:26px;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 30px 60px -30px rgba(2,20,22,.7);backdrop-filter:blur(18px) saturate(1.2);-webkit-backdrop-filter:blur(18px) saturate(1.2)}
.brand{color:var(--fg)}.brand svg{color:var(--mint)}
.tgl,.chip,.seg{background:rgba(10,52,56,.55);border:1px solid var(--line);color:var(--mut);backdrop-filter:blur(10px)}
.tgl .sw{background:rgba(255,255,255,.14)}.tgl .sw i{background:#cfe9e4}
.tgl[aria-pressed=true]{color:var(--acc);border-color:rgba(255,181,71,.5)}.tgl[aria-pressed=true] .sw{background:var(--acc)}.tgl[aria-pressed=true] .sw i{background:#2b1a00}
.chip b{color:var(--fg)}.up{color:var(--mint)}.dn{color:var(--coral)}
.fl-up{animation:flu .9s}.fl-dn{animation:fld .9s}
@keyframes flu{0%{box-shadow:0 0 0 0 rgba(94,230,200,.55)}100%{box-shadow:0 0 0 10px rgba(94,230,200,0)}}
@keyframes fld{0%{box-shadow:0 0 0 0 rgba(255,138,101,.5)}100%{box-shadow:0 0 0 10px rgba(255,138,101,0)}}
.seg button{color:var(--mut)}.seg button.on{color:#2a1900}.seg-ind{background:linear-gradient(180deg,#FFC870,#FFA62B);box-shadow:0 4px 14px -4px rgba(255,181,71,.7)}
.tip{background:rgba(6,40,43,.94);color:var(--fg);border:1px solid var(--line);box-shadow:0 10px 30px -10px #021a1c}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 392px;gap:18px}
.hero{grid-row:span 1;min-height:590px;overflow:hidden;padding:0;background:linear-gradient(180deg,rgba(18,80,84,.55),rgba(9,48,52,.65))}
.stage{position:absolute;inset:0;cursor:crosshair}
.stage canvas{width:100%!important;height:100%!important}
.hero-copy{position:relative;z-index:4;padding:26px 28px;max-width:560px;pointer-events:none}
.hero-copy:before{content:"";position:absolute;inset:-40px -120px -60px -40px;z-index:-1;background:radial-gradient(closest-side,rgba(9,46,50,.72),transparent);pointer-events:none}
.kick{color:var(--mut)}.kick b{color:var(--acc)}
.kick .dot{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 0 rgba(255,181,71,.6);animation:ping 2s infinite}
@keyframes ping{70%{box-shadow:0 0 0 10px rgba(255,181,71,0)}100%{box-shadow:0 0 0 0 rgba(255,181,71,0)}}
.pair{color:var(--fg)}.pair small{color:var(--mut)}
.big{color:var(--acc);text-shadow:0 0 36px rgba(255,181,71,.35)}
.per{color:var(--mut)}.breakdown{color:var(--mut)}.pos{color:var(--mint)}.neg{color:var(--coral)}.apr{color:var(--fg)}
.hero .lg3{position:absolute;left:28px;bottom:20px;z-index:4;color:var(--mut);background:rgba(8,44,48,.6);border:1px solid var(--line);padding:8px 12px;border-radius:12px;backdrop-filter:blur(8px)}
.lg.in i{background:var(--mint);box-shadow:0 0 10px var(--mint)}.lg.px i{background:var(--acc);height:3px;box-shadow:0 0 8px var(--acc)}.lg.gh i{border:1.5px dashed var(--coral);background:rgba(255,138,101,.12)}
.hint{position:absolute;right:22px;bottom:22px;z-index:4;font:600 10.5px var(--m);color:var(--mut);opacity:.8}
.tag3{background:rgba(7,40,44,.82);border:1px solid var(--line);color:var(--fg);backdrop-filter:blur(6px)}
.tag3.px{color:#2a1900;background:var(--acc);border-color:transparent;box-shadow:0 6px 20px -6px rgba(255,181,71,.8)}
.tag3.gh{color:var(--coral);border-color:rgba(255,138,101,.5)}
.tag3.in{color:var(--mint);border-color:rgba(94,230,200,.45)}
.tag3.ax{background:transparent;border:0;color:var(--mut);font-weight:600}
.side{padding:22px 16px 14px}
.side .kick{padding:0 10px 10px}
.nx{transition:background .25s,transform .35s cubic-bezier(.34,1.56,.64,1)}
.nx:hover,.nx:focus-visible{background:rgba(94,230,200,.07);transform:translateX(4px)}
.nx+.nx{margin-top:2px}
.nx .nm b{color:var(--fg)}.nx .nm em,.nx .val em{color:var(--mut)}.nx .val b{color:var(--acc)}.nx .rank{color:var(--mut)}.nx .spark{color:var(--mint);opacity:.85}
.nx .stag{background:rgba(138,158,245,.18);color:#C6D0FF}
.side .foot{display:flex;justify-content:space-between;align-items:center;margin:10px 10px 4px;padding-top:12px;border-top:1px solid var(--line);font:600 11px var(--m);color:var(--mut)}
.side .foot b{color:var(--mint)}
.lanes-card{padding:22px}
.lanes-card .kick,.fee-card .kick{color:var(--mut);margin-bottom:14px}
.lane{background:rgba(9,48,52,.5);border:1px solid var(--line);border-radius:18px;padding:14px;transition:transform .45s cubic-bezier(.34,1.56,.64,1),border-color .3s,background .3s}
.lane:hover,.lane:focus-visible{transform:translateY(-4px);border-color:rgba(94,230,200,.4);background:rgba(14,66,70,.6);outline:none}
.lane .ico{background:rgba(94,230,200,.12);color:var(--mint)}.lane[data-lane=cex] .ico{background:rgba(255,181,71,.14);color:var(--acc)}.lane[data-lane=ret] .ico{background:rgba(255,138,101,.14);color:var(--coral)}
.lane .n{background:rgba(255,255,255,.07);color:var(--fg)}.lane p,.lane li em{color:var(--mut)}.lane .lv{color:var(--acc)}
.lane li+li{border-top:1px dashed var(--line)}
.fee-card{padding:22px}
.fee-card .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.fee-card .row .kick{margin:0}
.fee-bars i.est{background:linear-gradient(180deg,rgba(94,230,200,.42),rgba(94,230,200,.16));border:1px dashed rgba(94,230,200,.45);border-bottom:0}
.fee-bars i.ex{background:linear-gradient(180deg,#FFC870,#E8902A);box-shadow:0 0 14px -4px rgba(255,181,71,.6)}
.fee-bars i:hover{filter:brightness(1.3)}
.fl{color:var(--mut)}.fl i.est{background:rgba(94,230,200,.3);border:1px dashed rgba(94,230,200,.6)}.fl i.ex{background:var(--acc)}
.fee-ax{color:var(--mut)}
.fee-sum{display:flex;gap:16px;margin-top:14px;font:600 11.5px var(--m);color:var(--mut)}.fee-sum b{color:var(--fg)}
body.refresh .hero{animation:flash 1.2s}
@keyframes flash{30%{box-shadow:0 0 0 2px rgba(255,181,71,.5),0 30px 60px -30px rgba(2,20,22,.7)}}
.fallback small{color:var(--mut)}

.sonar{display:flex;gap:18px;align-items:center;margin:14px 10px 6px;padding-top:16px;border-top:1px solid var(--line)}
.scope{position:relative;width:118px;height:118px;flex:none;border-radius:50%;overflow:hidden;background:repeating-radial-gradient(circle,rgba(94,230,200,.0) 0 17px,rgba(94,230,200,.22) 18px 18.6px),radial-gradient(circle,rgba(14,80,84,.8),rgba(8,44,48,.9));border:1px solid rgba(94,230,200,.3);box-shadow:0 0 30px -8px rgba(94,230,200,.35) inset}
.scope:before,.scope:after{content:"";position:absolute;background:rgba(94,230,200,.18)}.scope:before{left:50%;top:0;bottom:0;width:1px}.scope:after{top:50%;left:0;right:0;height:1px}
.sweep{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,rgba(94,230,200,.55),rgba(94,230,200,0) 70deg,transparent);animation:spin 5.4s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.scope b{position:absolute;left:var(--x);top:var(--y);width:7px;height:7px;margin:-3.5px;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c);animation:blip 5.4s linear infinite;animation-delay:var(--d)}
.scope b.hot{width:9px;height:9px;margin:-4.5px}
@keyframes blip{0%,100%{opacity:.25;transform:scale(.8)}4%{opacity:1;transform:scale(1.5)}30%{opacity:.6;transform:scale(1)}}
.sonar-txt .kick{color:var(--mut);margin-bottom:8px}.sonar-txt p{margin:4px 0;font:500 12px var(--m);color:var(--mut)}.sonar-txt b{color:var(--fg);font-weight:800}.sonar-txt b.m{color:var(--mint)}
@media (max-width:760px){.hero-copy{order:0}.stage{order:1}.hero .lg3{order:2}}
@media (max-width:1100px){.grid{grid-template-columns:minmax(0,1fr)}.lanes{grid-template-columns:repeat(2,1fr)}}
@media (max-width:760px){
 .hero{min-height:0;display:flex;flex-direction:column}
 .hero-copy{padding:20px 18px 0}
 .hero-copy:before{display:none}
 .stage{position:relative;inset:auto;height:330px;margin-top:-6px}
 .hero .lg3{position:relative;left:auto;bottom:auto;margin:0 14px 14px;justify-content:center;gap:10px}
 .hint{display:none}
 .big{font-size:50px}
 .card{border-radius:22px}
 .side,.lanes-card,.fee-card{padding:18px 12px}
 .lanes{grid-template-columns:none}
}`;

const body = `
<div class="ocean" aria-hidden="true"></div><div class="motes" aria-hidden="true"></div>
${C.ribbon('B · TEAL DEPTH')}
<div class="wrap">
${C.topbar()}
<main class="grid">
  <section class="card hero" aria-label="Best find">
    <div class="stage" id="stage" data-fallback='["#5EE6C8","#2b8b88","#FFB547"]'></div>
    ${C.heroCopy()}
    ${C.legend3d()}
    <div class="hint">move to tilt · hover a tower</div>
  </section>
  <aside class="card side" aria-label="Next best">
    <div class="kick">Next best · $/day per $1,000</div>
    ${C.nextList()}
    <div class="sonar"><div class="scope" aria-hidden="true"><i class="sweep"></i>
      <b style="--x:68%;--y:30%;--c:#2F6BFF;--d:-.5s"></b><b style="--x:30%;--y:62%;--c:#8A9EF5;--d:-3.1s"></b><b style="--x:58%;--y:72%;--c:#F0B90B;--d:-2.2s"></b><b style="--x:40%;--y:24%;--c:#2F6BFF;--d:-4.6s"></b><b class="hot" style="--x:74%;--y:52%;--c:#FFB547;--d:-1.3s"></b></div>
      <div class="sonar-txt"><div class="kick">Scanner sonar</div><p><b>1,284</b> pools pinged</p><p><b>17</b> thin at the price</p><p><b class="m">5</b> pass every check</p></div></div>
  </aside>
  <section class="card lanes-card rv" aria-label="Discovery">
    <div class="kick">Discovery lanes</div>
    ${C.lanes()}
  </section>
  <section class="card fee-card rv" aria-label="Fee history" style="--i:1">
    <div class="row"><div class="kick">Fee history · ABC/WETH · 30 d</div></div>
    ${C.feeStrip()}
    <div class="fee-sum">${C.feeLegend}<span style="margin-left:auto">avg <b>$3.12</b>/day</span></div>
  </section>
</main>
</div>`;

const mod = `
import * as THREE from 'three';
const D = window.LPD, RM = window.RM;
const host = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
host.appendChild(renderer.domElement);
window.__sceneOK = true;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0e4347, 0.052);
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);
const N = D.N, ROWS = 14, SX = 0.44, SZ = 0.64, HS = 3.1;
const X = i => (i - (N - 1) / 2) * SX, Z = r => 2.2 - r * SZ;
const liqAt = (x, r) => { const a = Math.floor(x), f = x - a; return D.liq(a, r) * (1 - f) + D.liq(a + 1, r) * f; };

// lights
scene.add(new THREE.HemisphereLight(0xa8fff0, 0x0a2c30, 1.1));
const sun = new THREE.DirectionalLight(0xffe2b0, 1.6); sun.position.set(6, 12, 8); scene.add(sun);
const mintL = new THREE.PointLight(0x5ee6c8, 9, 7, 1.6); mintL.position.set(X(17.5), 2.4, Z(1)); scene.add(mintL);
const ambL = new THREE.PointLight(0xffb547, 6, 6, 1.8); scene.add(ambL);

// bars: vertical gradient via vertex colours, emissive follows the gradient
const geo = new THREE.BoxGeometry(SX * 0.8, 1, SZ * 0.72); geo.translate(0, 0.5, 0);
{ const p = geo.attributes.position, c = new Float32Array(p.count * 3); for (let k = 0; k < p.count; k++) { const v = p.getY(k) > 0.5 ? 1 : 0.22; c[k*3] = c[k*3+1] = c[k*3+2] = v; } geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
const glowify = m => { m.onBeforeCompile = s => { s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\\n totalEmissiveRadiance *= vColor.rgb;'); }; return m; };
const matOut = glowify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .42, metalness: .2, emissive: 0xffffff, emissiveIntensity: .08 }));
const matIn = glowify(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .3, metalness: .1, emissive: 0xffffff, emissiveIntensity: .42 }));
const cells = [];
for (let r = 0; r < ROWS; r++) for (let i = 0; i < N; i++) cells.push({ i, r, inr: i >= D.LO && i <= D.HI, h: D.liq(i, r), d: .15 + r * .055 + Math.abs(i - 17.5) * .014 });
const outC = cells.filter(c => !c.inr), inC = cells.filter(c => c.inr);
const meshOut = new THREE.InstancedMesh(geo, matOut, outC.length), meshIn = new THREE.InstancedMesh(geo, matIn, inC.length);
const col = new THREE.Color();
outC.forEach((c, k) => { const shoulder = Math.min(1, c.h / 1.1); col.setHSL(.5 - shoulder * .035, .5 + shoulder * .1, .16 + shoulder * .13 - c.r * .004); meshOut.setColorAt(k, col); });
inC.forEach((c, k) => { col.set(c.r === 0 ? 0x5ef0cc : 0x3fcfae); col.offsetHSL(0, 0, -c.r * .016); meshIn.setColorAt(k, col); });
scene.add(meshOut, meshIn);

// sea floor with caustics
const floorMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { t: { value: 0 } },
  vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
  fragmentShader: \`varying vec2 vUv; varying vec3 vW; uniform float t;
  float caus(vec2 uv){ vec2 p=mod(uv*6.28318,6.28318)-250.; vec2 i=p; float c=1.; for(int n=0;n<4;n++){ float tt=t*.35*(1.-(3.5/float(n+1))); i=p+vec2(cos(tt-i.x)+sin(tt+i.y),sin(tt-i.y)+cos(tt+i.x)); c+=1./length(vec2(p.x/(sin(i.x+tt)/.005),p.y/(cos(i.y+tt)/.005))); } c/=4.; c=1.17-pow(c,1.4); return pow(abs(c),8.); }
  void main(){ float d=length(vW.xz-vec2(0.,-2.)); float fade=smoothstep(14.,3.,d);
    vec2 g=abs(fract(vW.xz*vec2(1./${(0.44).toFixed(2)},1./${(0.64).toFixed(2)}))-.5); float grid=smoothstep(.47,.5,max(g.x,g.y))*.18;
    float c=caus(vW.xz*.09); vec3 col=vec3(.05,.27,.28)+vec3(.45,1.,.9)*c*.55+vec3(.4,1.,.9)*grid;
    gl_FragColor=vec4(col,fade*.92); }\` });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), floorMat); floor.rotation.x = -Math.PI / 2; floor.position.set(0, -.01, -2); scene.add(floor);

// in-range band: floor strip + two glowing range walls
const bandW = (D.HI - D.LO + 1) * SX, bandX = (X(D.LO) + X(D.HI)) / 2, depth = ROWS * SZ + .6, zMid = (Z(0) + Z(ROWS - 1)) / 2;
const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };
const addMat = (frag, extra) => new THREE.ShaderMaterial(Object.assign({ transparent: true, depthWrite: false, ...ADD, side: THREE.DoubleSide, uniforms: { t: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }', fragmentShader: frag }, extra || {}));
const strip = new THREE.Mesh(new THREE.PlaneGeometry(bandW, depth), addMat('varying vec2 vUv; uniform float t; void main(){ float e=smoothstep(.0,.06,vUv.x)*smoothstep(1.,.94,vUv.x); float edge=1.-e; float z=smoothstep(0.,.25,vUv.y); float run=.5+.5*sin(vUv.y*30.-t*3.); gl_FragColor=vec4(vec3(.37,.9,.78)*(edge*.9+.12+run*.05)*z*(.6+.4*vUv.y),1.); }'));
strip.rotation.x = -Math.PI / 2; strip.position.set(bandX, .02, zMid); scene.add(strip);
for (const sx of [X(D.LO) - SX / 2, X(D.HI) + SX / 2]) {
  const w = new THREE.Mesh(new THREE.PlaneGeometry(depth, 3.6), addMat('varying vec2 vUv; uniform float t; void main(){ float a=pow(1.-vUv.y,2.2)*.34*smoothstep(0.,.2,vUv.x); float sc=.85+.15*sin(vUv.y*60.-t*2.); gl_FragColor=vec4(vec3(.37,.9,.78)*a*sc,1.); }'));
  w.rotation.y = Math.PI / 2; w.position.set(sx, 1.8, zMid); scene.add(w);
}

// price path laid over the rooftops + vertical price beam at "now"
const pts = []; for (let r = 0; r < ROWS; r += .25) { const px = D.price(r); pts.push(new THREE.Vector3(X(px), liqAt(px, Math.round(r)) * HS + .22, Z(r))); }
const curve = new THREE.CatmullRomCurve3(pts);
const tubeMat = addMat('varying vec2 vUv; uniform float t; void main(){ float p=fract(vUv.x*2.-t*.35); float pulse=smoothstep(.0,.04,p)*smoothstep(.16,.04,p); vec3 c=vec3(1.,.62,.18)*(.75+pulse*1.6); gl_FragColor=vec4(c*(.35+.65*(1.-vUv.x)),1.); }');
scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 220, .04, 8), tubeMat));
scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 220, .16, 8), addMat('varying vec2 vUv; void main(){ gl_FragColor=vec4(vec3(1.,.55,.15)*.09*(1.-vUv.x*.7),1.); }')));
const p0 = D.price(0), beamH = 5.2;
const beam = new THREE.Mesh(new THREE.PlaneGeometry(.5, beamH), addMat('varying vec2 vUv; uniform float t; void main(){ float x=abs(vUv.x-.5)*2.; float core=smoothstep(.22,0.,x); float glow=pow(1.-x,3.)*.35; float a=(core+glow)*smoothstep(1.,.55,vUv.y)*(.85+.15*sin(t*3.+vUv.y*20.)); gl_FragColor=vec4(vec3(1.,.66,.22)*a*1.1,1.); }'));
beam.position.set(X(p0), beamH / 2, Z(0) + .45); scene.add(beam);
ambL.position.set(X(p0), 1.6, Z(0) + .6);

// competition ghost: dashed boxes stacked on the front in-range towers
const ghosts = [];
for (let i = D.LO; i <= D.HI; i++) {
  const g = new THREE.BoxGeometry(SX * .8, 1, SZ * .72); g.translate(0, .5, 0);
  const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff8a65, transparent: true, opacity: .2, depthWrite: false }));
  const ln = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineDashedMaterial({ color: 0xffb08f, dashSize: .08, gapSize: .05, transparent: true, opacity: 1 }));
  ln.computeLineDistances(); const grp = new THREE.Group(); grp.add(fill, ln); grp.position.set(X(i), 0, Z(0)); scene.add(grp); ghosts.push({ grp, fill, ln, i });
}

// fee particles: swaps at the price drift in and land on the in-range towers
const NP = RM ? 0 : 240, fp = new Float32Array(NP * 3), fa = new Float32Array(NP), fm = new Float32Array(NP), P = [];
const rnd = Math.random;
function spawn(k, first) { const rb = 2 + rnd() * (ROWS - 3), px = D.price(rb), bi = D.LO + Math.floor(rnd() * (D.HI - D.LO + 1)), rr = Math.floor(rnd() * 2);
  P[k] = { s: new THREE.Vector3(X(px) + (rnd() - .5) * 1.6, 1.6 + rnd() * 2.2, Z(rb)), e: new THREE.Vector3(X(bi) + (rnd() - .5) * .2, 0, Z(rr)), bi, rr, t: first ? rnd() : 0, v: .22 + rnd() * .22 }; }
for (let k = 0; k < NP; k++) spawn(k, true);
const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(fp, 3)); pg.setAttribute('a', new THREE.BufferAttribute(fa, 1)); pg.setAttribute('m', new THREE.BufferAttribute(fm, 1));
const ptsMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { px: { value: 1 } },
  vertexShader: 'attribute float a; attribute float m; varying float vA; varying float vM; uniform float px; void main(){ vA=a; vM=m; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=(38.+30.*m)*px/-mv.z; gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'varying float vA; varying float vM; void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,0.,d); a=a*a; vec3 c=mix(vec3(1.,.72,.3),vec3(.5,1.,.88),vM); gl_FragColor=vec4(c*a*vA*1.6,1.); }' });
scene.add(new THREE.Points(pg, ptsMat));

// drifting plankton
const NB = RM ? 0 : 420, bp = new Float32Array(NB * 3), bs = new Float32Array(NB);
for (let k = 0; k < NB; k++) { bp[k*3] = (rnd() - .5) * 26; bp[k*3+1] = rnd() * 7; bp[k*3+2] = 4 - rnd() * 16; bs[k] = .1 + rnd() * .3; }
const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(bp, 3)); bg.setAttribute('s', new THREE.BufferAttribute(bs, 1));
const bubMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 }, px: { value: 1 } },
  vertexShader: 'attribute float s; uniform float t; uniform float px; varying float vA; void main(){ vec3 p=position; p.y=mod(p.y+t*s,7.); p.x+=sin(t*.4+p.z)*.3; vA=smoothstep(0.,1.,p.y)*smoothstep(7.,5.,p.y); vec4 mv=modelViewMatrix*vec4(p,1.); gl_PointSize=(10.+s*26.)*px/-mv.z; gl_Position=projectionMatrix*mv; }',
  fragmentShader: 'varying float vA; void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,.15,d)*.55; gl_FragColor=vec4(vec3(.7,1.,.95)*a*vA*.6,1.); }' });
scene.add(new THREE.Points(bg, bubMat));

// HTML tags projected from 3D
const tag = (cls, txt) => { const d = document.createElement('div'); d.className = 'tag3 ' + cls; d.textContent = txt; host.appendChild(d); return d; };
const T = [
  [tag('px', 'price ' + D.priceLabel), () => new THREE.Vector3(X(p0), beamH * .78, Z(0) + .45)],
  [tag('gh', 'competition +2 pools'), () => new THREE.Vector3(X(D.HI) + .35, cur(D.HI, 0) * HS + D.ghost(D.HI) * HS + .25, Z(0))],
  [tag('in', 'in range ±6%'), () => new THREE.Vector3(bandX, .02, Z(0) + .9)],
  [tag('ax', 'now'), () => new THREE.Vector3(X(2), 0, Z(0) + .7)],
  [tag('ax', '2 weeks ago'), () => new THREE.Vector3(X(3), 0, Z(ROWS - 1) - .2)],
];
const v3 = new THREE.Vector3();
function placeTags(w, h) { for (const [el, f] of T) { v3.copy(f()).project(camera); const vis = v3.z < 1 && v3.x > -1.05 && v3.x < 1.05 && v3.y > -1.05 && v3.y < 1.1; el.style.opacity = vis ? 1 : 0;
  el.style.transform = 'translate(' + ((v3.x * .5 + .5) * w).toFixed(1) + 'px,' + ((-v3.y * .5 + .5) * h).toFixed(1) + 'px) translate(-50%,-100%)'; } }

// animation state
const dummy = new THREE.Object3D(); let t0 = performance.now(), grow0 = 0;
const easeBack = k => { const c = 1.5; k = Math.min(1, Math.max(0, k)); return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const heights = new Map();
function cur(i, r) { return heights.get(i + ',' + r) || D.liq(i, r); }
function setBars(time) {
  const g = time - grow0;
  const upd = (mesh, list) => { list.forEach((c, k) => { const p = RM ? 1 : easeBack((g - c.d) / 1.3); const breathe = RM ? 1 : 1 + .04 * Math.sin(time * 1.3 + c.i * .32 + c.r * .7);
    const h = Math.max(.002, c.h * p * breathe); heights.set(c.i + ',' + c.r, h); dummy.position.set(X(c.i), 0, Z(c.r)); dummy.scale.set(1, h * HS, 1); dummy.updateMatrix(); mesh.setMatrixAt(k, dummy.matrix); }); mesh.instanceMatrix.needsUpdate = true; };
  upd(meshOut, outC); upd(meshIn, inC);
  ghosts.forEach(o => { const top = cur(o.i, 0) * HS; o.grp.position.y = top; const gh = D.ghost(o.i) * HS * Math.min(1, Math.max(0, (g - 1.6) / .8)); o.grp.scale.y = Math.max(.001, gh);
    const pulse = .55 + .45 * Math.sin(time * 2.4); o.ln.material.opacity = RM ? .9 : .45 + .5 * pulse; o.fill.material.opacity = .12 + .16 * pulse; });
}

// camera framing + parallax (pointer or device tilt)
let W = 1, H = 1, aspect = 1, par = { x: 0, y: 0 }, parT = { x: 0, y: 0 };
const base = new THREE.Vector3(), look = new THREE.Vector3();
function frame() { const phone = W < 560; const k = phone ? 1 : Math.min(1.5, Math.max(1, 1.75 / aspect));
  base.set(phone ? .2 : 2.6, phone ? 6.6 : 7.4, (phone ? 9.4 : 11.2) * k); look.set(phone ? .2 : -1.9, phone ? .5 : 1.35, -3.2); camera.fov = phone ? 46 : 35; camera.updateProjectionMatrix(); }
function resize() { const r = host.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height); aspect = W / H; renderer.setSize(W, H, false); camera.aspect = aspect; frame(); ptsMat.uniforms.px.value = bubMat.uniforms.px.value = H * renderer.getPixelRatio() / 600; render(performance.now() / 1000); }
addEventListener('pointermove', e => { parT.x = (e.clientX / innerWidth - .5) * 2; parT.y = (e.clientY / innerHeight - .5) * 2; });
addEventListener('deviceorientation', e => { if (e.gamma == null) return; parT.x = Math.max(-1, Math.min(1, e.gamma / 25)); parT.y = Math.max(-1, Math.min(1, (e.beta - 45) / 25)); });

// hover a tower: tooltip
const ray = new THREE.Raycaster(), mv = new THREE.Vector2();
host.addEventListener('pointermove', e => { const r = host.getBoundingClientRect(); mv.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(mv, camera);
  const hit = ray.intersectObjects([meshIn, meshOut])[0]; if (!hit) { window.LPUI.tip && window.LPUI.tip.hide(); return; }
  const c = (hit.object === meshIn ? inC : outC)[hit.instanceId]; const pr = (0.0330 + c.i * 0.00052).toFixed(5);
  window.LPUI.tip.show((c.r === 0 ? 'now' : c.r + ' d ago') + ' · price ' + pr + ' · liquidity $' + (c.h * 41.7).toFixed(1) + 'K' + (c.inr ? ' · in range' : ''), e.clientX, e.clientY); });
host.addEventListener('pointerleave', () => window.LPUI.tip && window.LPUI.tip.hide());

function render(time) {
  par.x += (parT.x - par.x) * .05; par.y += (parT.y - par.y) * .05;
  const sway = RM ? 0 : Math.sin(time * .16) * .5;
  camera.position.set(base.x + par.x * 1.5 + sway, base.y - par.y * .7, base.z); camera.lookAt(look.x + par.x * .4, look.y, look.z);
  setBars(time);
  floorMat.uniforms.t.value = time; tubeMat.uniforms.t.value = time; bubMat.uniforms.t.value = time;
  scene.traverse(o => { if (o.material && o.material.uniforms && o.material.uniforms.t) o.material.uniforms.t.value = time; });
  mintL.intensity = 8 + 2 * Math.sin(time * 2);
  renderer.render(scene, camera); placeTags(W, H);
}
let last = performance.now();
function updParticles(dt) {
  for (let k = 0; k < NP; k++) { const p = P[k]; p.t += dt * p.v; if (p.t >= 1) spawn(k, false);
    const t = p.t, e = P[k].e, s = P[k].s; e.y = cur(p.bi, p.rr) * HS + .05;
    const cx = (s.x + e.x) / 2, cy = Math.max(s.y, e.y) + 1.4, cz = (s.z + e.z) / 2, u = 1 - t;
    fp[k*3] = u*u*s.x + 2*u*t*cx + t*t*e.x; fp[k*3+1] = u*u*s.y + 2*u*t*cy + t*t*e.y; fp[k*3+2] = u*u*s.z + 2*u*t*cz + t*t*e.z;
    fa[k] = Math.min(1, t * 5) * Math.min(1, (1 - t) * 8); fm[k] = Math.max(0, (t - .55) / .45); }
  pg.attributes.position.needsUpdate = pg.attributes.a.needsUpdate = pg.attributes.m.needsUpdate = true;
}
let visible = true;
new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(host);
function loop(now) { requestAnimationFrame(loop); if (!visible) return; const dt = Math.min(.05, (now - last) / 1000); last = now; updParticles(dt); render((now - t0) / 1000); }
new ResizeObserver(resize).observe(host); resize();
if (RM) render(10); else requestAnimationFrame(loop);
addEventListener('lp:refresh', () => { grow0 = (performance.now() - t0) / 1000 - .2; });
addEventListener('lp:win', () => { grow0 = (performance.now() - t0) / 1000 - .6; });
`;

module.exports = C.page({ id: 'B', title: 'LP Shape · Teal Depth (mockup)', css, body, module: mod });
