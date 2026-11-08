// E · Aurora: flowing shader sky, a liquidity terrain, glass cards that tilt toward the pointer.
const C = require('./common');

const css = `
:root{--f:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,"Segoe UI",Roboto,system-ui,sans-serif;--m:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
--bg-solid:#241F48;--fg:#F3F0FF;--mut:#B7B0D8;--acc:#6EF0C8;--vio:#B69CFF;--pink:#F6A8E8;--amber:#FFC97A;--neg:#FF8FA3;--line:rgba(255,255,255,.14);
--gauge:#6EF0C8;--gauge-bg:rgba(255,255,255,.16)}
body{background:linear-gradient(135deg,#2A2352,#1C3A57 60%,#16474F)}
#sky{position:fixed;inset:0;width:100vw;height:100vh;z-index:0;filter:saturate(1.1)}
.sky-fallback{position:fixed;inset:0;z-index:0;background:radial-gradient(60% 50% at 30% 20%,rgba(160,130,255,.35),transparent),radial-gradient(60% 50% at 80% 40%,rgba(80,230,200,.25),transparent),linear-gradient(135deg,#2A2352,#1C3A57 60%,#16474F)}
.card{position:relative;background:linear-gradient(150deg,rgba(255,255,255,.12),rgba(255,255,255,.04));border:1px solid var(--line);border-radius:28px;box-shadow:0 1px 0 rgba(255,255,255,.18) inset,0 40px 80px -40px rgba(12,8,40,.6);backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);transform-style:preserve-3d;transition:transform .6s cubic-bezier(.22,1,.36,1)}
.card:after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:radial-gradient(420px circle at var(--gx,50%) var(--gy,-20%),rgba(255,255,255,.14),transparent 45%);opacity:var(--go,0);transition:opacity .4s}
.card.tilting{transition:transform .12s linear}
.brand{color:var(--fg)}.brand svg{color:var(--vio)}
.tgl,.chip,.seg{background:rgba(255,255,255,.08);border:1px solid var(--line);color:var(--mut);backdrop-filter:blur(12px)}
.tgl .sw{background:rgba(255,255,255,.18)}.tgl .sw i{background:#fff}
.tgl[aria-pressed=true]{color:var(--acc)}.tgl[aria-pressed=true] .sw{background:linear-gradient(90deg,var(--vio),var(--acc))}
.chip b{color:var(--fg)}.up{color:var(--acc)}.dn{color:var(--neg)}
.fl-up{animation:glow1 .9s}.fl-dn{animation:glow2 .9s}
@keyframes glow1{30%{box-shadow:0 0 18px -2px rgba(110,240,200,.6)}}@keyframes glow2{30%{box-shadow:0 0 18px -2px rgba(255,143,163,.6)}}
.seg button{color:var(--mut)}.seg button.on{color:#1d1640}.seg-ind{background:linear-gradient(90deg,#C9B6FF,#7FF3D2);box-shadow:0 6px 18px -6px rgba(150,240,220,.8)}
.tip{background:rgba(30,24,70,.92);color:var(--fg);border:1px solid var(--line);backdrop-filter:blur(10px)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:20px;perspective:1400px}
.hero{padding:0;overflow:hidden;display:flex;flex-direction:column}
.hero-top{display:flex;justify-content:space-between;gap:20px;padding:28px 30px 0;position:relative;z-index:3}
.kick{color:var(--mut)}.kick b{color:var(--fg)}
.kick .dot{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,var(--vio),var(--acc));box-shadow:0 0 12px var(--acc)}
.pair{color:var(--fg)}.pair small{color:var(--mut)}
.big{background:linear-gradient(100deg,#FFFFFF 0%,#C9B6FF 35%,#7FF3D2 80%);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:72px;filter:drop-shadow(0 8px 30px rgba(127,243,210,.25))}
.per{color:var(--mut)}.breakdown{color:var(--mut)}.pos{color:var(--acc)}.neg{color:var(--neg)}.apr{color:var(--fg)}
.gem{position:relative;width:118px;height:118px;flex:none}
.gem svg{transform:rotate(-90deg)}
.gem .arc{stroke-dasharray:0 100;transition:stroke-dasharray 2s cubic-bezier(.22,1,.36,1) .4s}
.gem.in .arc{stroke-dasharray:72 100}
.gem div{position:absolute;inset:0;display:grid;place-items:center;text-align:center;font:800 30px var(--f);color:var(--fg)}
.gem div small{display:block;font:700 9.5px var(--m);letter-spacing:.14em;color:var(--mut);margin-top:-30px}
.stage{position:relative;height:400px;margin-top:-10px;cursor:crosshair}
.stage canvas{width:100%!important;height:100%!important}
.hero .lg3{position:absolute;left:30px;bottom:18px;z-index:3;color:var(--mut)}
.lg.in i{background:linear-gradient(180deg,#7FF3D2,#2BB8A4);box-shadow:0 0 10px rgba(127,243,210,.7)}.lg.px i{background:var(--pink);height:3px;box-shadow:0 0 8px var(--pink)}.lg.gh i{border:1.5px dashed var(--amber)}
.tag3{background:rgba(36,28,82,.72);border:1px solid var(--line);color:var(--fg);backdrop-filter:blur(8px)}
.tag3.px{background:linear-gradient(90deg,#F6A8E8,#C9B6FF);color:#24124a;border:0;box-shadow:0 6px 24px -6px rgba(246,168,232,.8)}
.tag3.gh{color:var(--amber);border-color:rgba(255,201,122,.45)}.tag3.in{color:var(--acc);border-color:rgba(110,240,200,.45)}
.tag3.ax{background:transparent;border:0;color:var(--mut);backdrop-filter:none}
.side{padding:24px 16px 16px}
.side .kick{padding:0 12px 12px}
.nx{transition:background .3s,transform .5s cubic-bezier(.34,1.56,.64,1)}
.nx:hover,.nx:focus-visible{background:rgba(255,255,255,.07);transform:translateX(4px)}
.nx .nm b{color:var(--fg)}.nx .nm em,.nx .val em,.nx .rank{color:var(--mut)}
.nx .val b{background:linear-gradient(90deg,#C9B6FF,#7FF3D2);-webkit-background-clip:text;background-clip:text;color:transparent}
.nx .spark{color:var(--vio)}
.nx .stag{background:rgba(182,156,255,.2);color:#DCD0FF}
.side .aur{margin:12px 12px 4px;padding:14px;border-radius:18px;background:linear-gradient(120deg,rgba(182,156,255,.16),rgba(110,240,200,.12));border:1px solid var(--line);font:600 12px/1.5 var(--m);color:var(--mut)}
.side .aur b{color:var(--fg)}
.lanes-card,.fee-card{grid-column:1/-1;padding:24px}
.lanes-card .kick,.fee-card .kick{color:var(--mut);margin-bottom:14px}
.lane{position:relative;overflow:hidden;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:20px;padding:16px;transition:transform .5s cubic-bezier(.34,1.56,.64,1),background .3s}
.lane:before{content:"";position:absolute;left:-20%;right:-20%;top:-60px;height:120px;background:radial-gradient(closest-side,var(--lc),transparent);opacity:.55;filter:blur(8px);animation:sway 7s ease-in-out infinite alternate}
.lane>*{position:relative}
@keyframes sway{to{transform:translateX(12%) scaleY(1.2)}}
.lane[data-lane=new]{--lc:rgba(127,243,210,.5)}.lane[data-lane=cex]{--lc:rgba(201,182,255,.55)}.lane[data-lane=xc]{--lc:rgba(246,168,232,.45)}.lane[data-lane=ret]{--lc:rgba(255,201,122,.45)}
.lane:hover,.lane:focus-visible{transform:translateY(-5px);background:rgba(255,255,255,.1);outline:none}
.lane .ico{background:rgba(255,255,255,.12);color:var(--fg)}
.lane .n{background:rgba(255,255,255,.12);color:var(--fg)}.lane p,.lane li em{color:var(--mut)}.lane li b{color:var(--fg)}.lane .lv{color:var(--acc)}
.lane li+li{border-top:1px solid var(--line)}
.fee-card .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap}.fee-card .row .kick{margin:0}
.fee-card .lgd{display:flex;gap:14px;align-items:center}
.fee-bars{height:104px}
.fee-bars i.est{background:linear-gradient(180deg,rgba(201,182,255,.38),rgba(201,182,255,.1));border:1px dashed rgba(201,182,255,.6);border-bottom:0}
.fee-bars i.ex{background:linear-gradient(180deg,#9AF7DB,#2BB8A4);box-shadow:0 0 18px -6px rgba(127,243,210,.8)}
.fee-bars i:hover{filter:brightness(1.25)}
.fl{color:var(--mut)}.fl i.est{background:rgba(201,182,255,.3);border:1px dashed rgba(201,182,255,.7)}.fl i.ex{background:var(--acc)}
.fee-ax{color:var(--mut)}
.fee-sum{font:600 12px var(--m);color:var(--mut)}.fee-sum b{color:var(--fg)}
.fallback small{color:var(--mut)}
@media (max-width:1100px){.grid{grid-template-columns:minmax(0,1fr)}.lanes{grid-template-columns:repeat(2,1fr)}}
@media (max-width:760px){
 .card{border-radius:24px}
 .hero-top{padding:20px 18px 0}
 .gem{width:84px;height:84px}.gem svg{width:84px;height:84px}.gem div{font-size:22px}.gem div small{margin-top:-22px;font-size:8.5px}
 .big{font-size:52px}
 .stage{height:330px;margin-top:-4px}
 .hero .lg3{position:relative;left:auto;bottom:auto;margin:0 16px 16px;justify-content:center;gap:10px}
 .side,.lanes-card,.fee-card{padding:18px 12px}
 .lanes{grid-template-columns:none}
}`;

const gem = `<div class="gem rv" aria-label="gem score 72 of 100"><svg width="118" height="118" viewBox="0 0 40 40"><defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C9B6FF"/><stop offset="1" stop-color="#7FF3D2"/></linearGradient></defs><circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="3"/><circle class="arc" cx="20" cy="20" r="16" fill="none" stroke="url(#gg)" stroke-width="3" stroke-linecap="round" pathLength="100"/></svg><div><span><small>GEM</small>72</span></div></div>`;

const body = `
<canvas id="sky" aria-hidden="true"></canvas>
${C.ribbon('E · AURORA')}
<div class="wrap">
${C.topbar({ logo: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="lgE" x1="0" x2="1"><stop offset="0" stop-color="#C9B6FF"/><stop offset="1" stop-color="#7FF3D2"/></linearGradient></defs><path d="M2 18C6 18 7 5 12 5s6 13 10 13" fill="none" stroke="url(#lgE)" stroke-width="2.6" stroke-linecap="round"/></svg>' })}
<main class="grid">
  <section class="card hero tilt" data-tilt="2.2" aria-label="Best find">
    <div class="hero-top">${C.heroCopy()}${gem}</div>
    <div class="stage" id="stage" data-fallback='["#7FF3D2","#6a5cb0","#F6A8E8"]'></div>
    ${C.legend3d()}
  </section>
  <aside class="card side tilt" data-tilt="5" aria-label="Next best">
    <div class="kick">Next best · $/day per $1,000</div>
    ${C.nextList()}
    <div class="aur"><b>Why ABC/WETH leads:</b> liquidity at the price is <b>0.3×</b> the walls on each side, while swaps keep crossing it. Two new pools could fill the gap.</div>
  </aside>
  <section class="card lanes-card tilt rv" data-tilt="2" aria-label="Discovery">
    <div class="kick">Discovery lanes</div>
    ${C.lanes()}
  </section>
  <section class="card fee-card tilt rv" data-tilt="2" aria-label="Fee history">
    <div class="row"><div class="kick">Fee history · ABC/WETH · 30 d</div><div class="lgd">${C.feeLegend}<span class="fee-sum">avg <b>$3.12</b>/day</span></div></div>
    ${C.feeStrip()}
  </section>
</main>
</div>
<script>
// tilt toward the pointer + glare
(function(){ if (window.RM || matchMedia('(hover:none)').matches) return;
  document.querySelectorAll('.tilt').forEach(c => { const m = +c.dataset.tilt || 4;
    c.addEventListener('pointermove', e => { const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      c.classList.add('tilting'); c.style.transform = 'rotateX(' + ((.5 - y) * m).toFixed(2) + 'deg) rotateY(' + ((x - .5) * m * 1.3).toFixed(2) + 'deg)';
      c.style.setProperty('--gx', (x * 100) + '%'); c.style.setProperty('--gy', (y * 100) + '%'); c.style.setProperty('--go', 1); });
    c.addEventListener('pointerleave', () => { c.classList.remove('tilting'); c.style.transform = ''; c.style.setProperty('--go', 0); }); }); })();
</script>`;

const mod = `
import * as THREE from 'three';
const D = window.LPD, RM = window.RM;
const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };

// ---------- aurora sky (half resolution) ----------
const skyC = document.getElementById('sky');
const sky = new THREE.WebGLRenderer({ canvas: skyC, antialias: false, alpha: false });
sky.setPixelRatio(.5);
const skyCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), skyScene = new THREE.Scene();
const skyMat = new THREE.ShaderMaterial({ uniforms: { t: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } }, depthTest: false,
  vertexShader: 'void main(){ gl_Position=vec4(position.xy,0.,1.); }',
  fragmentShader: \`uniform vec2 res; uniform float t;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){ vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.-2.*f); return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y); }
  float fbm(vec2 p){ float v=0.,a=.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=.5; } return v; }
  void main(){ vec2 uv=gl_FragCoord.xy/res; vec2 p=uv; p.x*=res.x/res.y; float tt=t*.05;
    vec3 col=mix(vec3(.17,.14,.33),vec3(.08,.28,.32),smoothstep(0.,1.,uv.x*.55+(1.-uv.y)*.55));
    col=mix(col,vec3(.21,.17,.40),smoothstep(.5,1.,uv.y)*.6);
    for(int k=0;k<3;k++){ float fk=float(k);
      float y0=.78-fk*.2+.06*sin(p.x*1.2+tt*7.+fk*2.1);
      float w=fbm(vec2(p.x*1.4+fk*3.7,tt*2.5+fk));
      float d=uv.y-(y0+(w-.5)*.32);
      float band=d>0.?exp(-d*6.5):exp(-d*d*240.);
      float rays=.45+.55*fbm(vec2(p.x*11.+fk*5.,tt*6.+fk));
      vec3 c=k==0?vec3(.30,.95,.80):(k==1?vec3(.70,.58,1.):vec3(.96,.62,.92));
      col+=c*band*rays*(.42-fk*.07); }
    float st=hash(floor(gl_FragCoord.xy)); col+=step(.9985,st)*.5*(.5+.5*sin(t*2.+st*90.));
    col*=.9+.2*smoothstep(1.3,.2,length(uv-vec2(.5,.7)));
    gl_FragColor=vec4(col,1.); }\` });
skyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat));
function skySize() { sky.setSize(innerWidth, innerHeight, false); skyC.style.width = '100vw'; skyC.style.height = '100vh'; skyMat.uniforms.res.value.set(innerWidth * .5, innerHeight * .5); }
addEventListener('resize', skySize); skySize();

// ---------- liquidity terrain ----------
const host = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
host.appendChild(renderer.domElement);
window.__sceneOK = true;
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, .1, 100);
const N = D.N, ROWS = 14, TW = 15, TD = 8.4, HS = 2.3;
const binX = b => (b / (N - 1) - .5) * TW, rowZ = r => TD / 2 - (r / (ROWS - 1)) * TD;
const liq = (b, r) => { b = Math.max(0, Math.min(N - 1.001, b)); r = Math.max(0, Math.min(ROWS - 1.001, r)); const i = Math.floor(b), j = Math.floor(r), fb = b - i, fr = r - j;
  const s = x => x * x * (3 - 2 * x), a = s(fb), c = s(fr);
  return (D.liq(i, j) * (1 - a) + D.liq(i + 1, j) * a) * (1 - c) + (D.liq(i, j + 1) * (1 - a) + D.liq(i + 1, j + 1) * a) * c; };
const SEG_X = 200, SEG_Z = 90;
const tg = new THREE.PlaneGeometry(TW, TD, SEG_X, SEG_Z); tg.rotateX(-Math.PI / 2);
{ const p = tg.attributes.position, h = new Float32Array(p.count), bb = new Float32Array(p.count), rr = new Float32Array(p.count);
  for (let k = 0; k < p.count; k++) { const b = (p.getX(k) / TW + .5) * (N - 1), r = (TD / 2 - p.getZ(k)) / TD * (ROWS - 1); bb[k] = b; rr[k] = r; h[k] = liq(b, r); }
  tg.setAttribute('h', new THREE.BufferAttribute(h, 1)); tg.setAttribute('b', new THREE.BufferAttribute(bb, 1)); tg.setAttribute('r', new THREE.BufferAttribute(rr, 1)); }
const pr = []; for (let r = 0; r < ROWS; r++) pr.push(D.price(r));
const terrMat = new THREE.ShaderMaterial({ transparent: true, extensions: { derivatives: true },
  uniforms: { t: { value: 0 }, g: { value: 0 }, lo: { value: D.LO - .5 }, hi: { value: D.HI + .5 }, pr: { value: pr }, HS: { value: HS } },
  vertexShader: \`attribute float h; attribute float b; attribute float r; uniform float t; uniform float g; uniform float HS;
    varying float vH; varying float vB; varying float vR; varying vec3 vW;
    void main(){ float grow=clamp(g*1.1-r*.05,0.,1.); grow=1.-pow(1.-grow,3.);
      float wave=.035*sin(b*.45-t*1.6+r*.5)*grow;
      vec3 p=position; p.y=(h*grow+wave)*HS; vH=h; vB=b; vR=r;
      vec4 w=modelMatrix*vec4(p,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }\`,
  fragmentShader: \`uniform float t; uniform float lo; uniform float hi; uniform float pr[${14}];
    varying float vH; varying float vB; varying float vR; varying vec3 vW;
    float priceAt(float r){ int i=int(floor(r)); float f=fract(r); float a=pr[0]; float c=pr[0];
      for(int k=0;k<${14};k++){ if(k==i) a=pr[k]; if(k==i+1) c=pr[k]; } if(i>=${13}) c=a; return mix(a,c,f*f*(3.-2.*f)); }
    void main(){
      vec3 n=normalize(cross(dFdx(vW),dFdy(vW)));
      vec3 L=normalize(vec3(-.4,.9,.5)); float dif=clamp(dot(n,L),0.,1.);
      float hh=clamp(vH/1.15,0.,1.);
      vec3 c1=vec3(.24,.17,.50), c2=vec3(.17,.62,.66), c3=vec3(.62,.98,.86);
      vec3 col=hh<.5?mix(c1,c2,hh*2.):mix(c2,c3,(hh-.5)*2.);
      col*=.45+.75*dif;
      float fres=pow(1.-abs(n.y),2.); col+=vec3(.7,.55,1.)*fres*.35;
      float ci=vH*14.; float cl=abs(fract(ci-.5)-.5)/fwidth(ci); col+=vec3(.85,.8,1.)*(1.-smoothstep(0.,1.2,cl))*.22;
      float gb=abs(fract(vB)-.5)/fwidth(vB); col+=vec3(1.)*(1.-smoothstep(0.,1.,gb))*.05;
      float inR=step(lo,vB)*step(vB,hi);
      col=mix(col,col*vec3(.75,1.25,1.1)+vec3(.05,.22,.18),inR*.85);
      float e=min(abs(vB-lo),abs(vB-hi)); float edge=(1.-smoothstep(0.,.12,e)); col+=vec3(.5,1.,.85)*edge*(.8+.4*sin(vR*2.-t*3.));
      float scan=smoothstep(.15,0.,abs(fract(vR*.25-t*.25)-.5)-.35)*inR*.25; col+=vec3(.4,1.,.85)*scan;
      float dp=abs(vB-priceAt(vR)); col+=vec3(1.,.55,.9)*exp(-dp*dp*9.)*1.1;
      float fade=smoothstep(${13}.,8.,vR)*smoothstep(-.3,.05,vR)*smoothstep(0.,1.6,vB)*smoothstep(${35}.,${33.4},vB);
      gl_FragColor=vec4(col*fade,fade); }\` });
const terrain = new THREE.Mesh(tg, terrMat); scene.add(terrain);

// competition ghost: a dashed-looking wire veil over the range, front rows
const gg = new THREE.PlaneGeometry((D.HI - D.LO + 1) * TW / (N - 1), TD * .45, 14, 12); gg.rotateX(-Math.PI / 2);
{ const p = gg.attributes.position, cx = (binX(D.LO - .5) + binX(D.HI + .5)) / 2;
  for (let k = 0; k < p.count; k++) { const x = p.getX(k) + cx, z = p.getZ(k) + TD / 2 - TD * .225; const b = (x / TW + .5) * (N - 1), r = (TD / 2 - z) / TD * (ROWS - 1);
    p.setXYZ(k, x, (liq(b, r) + D.ghost(Math.round(Math.max(D.LO, Math.min(D.HI, b))))) * HS + .04, z); } }
const ghostMat = new THREE.ShaderMaterial({ wireframe: true, transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 }, g: { value: 0 } },
  vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
  fragmentShader: 'uniform float t; uniform float g; varying vec3 vP; void main(){ float d=step(.5,fract((vP.x+vP.z)*6.-t*.8)); gl_FragColor=vec4(vec3(1.,.79,.48)*(.35+.25*sin(t*2.4))*d*g,1.); }' });
const ghost = new THREE.Mesh(gg, ghostMat); scene.add(ghost);

// fee sparkles: rise off the price ridge and stream toward "now"
const NP = RM ? 0 : 260, sp = new Float32Array(NP * 4);
for (let k = 0; k < NP; k++) { sp[k*4] = Math.random(); sp[k*4+1] = Math.random(); sp[k*4+2] = .2 + Math.random() * .5; sp[k*4+3] = Math.random(); }
const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 3), 3)); sg.setAttribute('s', new THREE.BufferAttribute(sp, 4));
const sMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, ...ADD, uniforms: { t: { value: 0 }, px: { value: 1 }, pr: { value: pr }, HS: { value: HS }, TW: { value: TW }, TD: { value: TD } },
  vertexShader: \`attribute vec4 s; uniform float t; uniform float px; uniform float pr[14]; uniform float HS; uniform float TW; uniform float TD; varying float vA; varying float vC;
    void main(){ float life=fract(s.x+t*s.z*.18); float r=(1.-life)*12.5; int i=int(floor(r)); float a=pr[0]; for(int k=0;k<14;k++){ if(k==i) a=pr[k]; }
      float b=a+(s.y-.5)*5.*(1.-life*.6); float x=(b/35.-.5)*TW; float z=TD/2.-r/13.*TD; float y=(.55+life*1.4+sin(life*6.28+s.w*6.)*.2)*HS*.6+.4;
      vA=sin(life*3.1416); vC=s.w; vec4 mv=modelViewMatrix*vec4(x,y,z,1.); gl_PointSize=(22.+s.w*26.)*px/-mv.z; gl_Position=projectionMatrix*mv; }\`,
  fragmentShader: 'varying float vA; varying float vC; void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,0.,d); a*=a; vec3 c=mix(vec3(.5,1.,.85),vec3(1.,.66,.93),step(.6,vC)); gl_FragColor=vec4(c*a*vA*1.3,1.); }' });
scene.add(new THREE.Points(sg, sMat));

// tags
const tag = (cls, txt) => { const d = document.createElement('div'); d.className = 'tag3 ' + cls; d.textContent = txt; host.appendChild(d); return d; };
const p0 = D.price(0);
const T = [[tag('px', 'price ' + D.priceLabel), () => new THREE.Vector3(binX(p0), liq(p0, .4) * HS + .55, rowZ(.4))],
  [tag('gh', 'competition +2 pools'), () => new THREE.Vector3(binX(D.HI + .8), (liq(D.HI, 1.5) + D.ghost(D.HI)) * HS + .55, rowZ(1.5))],
  [tag('in', 'in range ±6%'), () => new THREE.Vector3(binX((D.LO + D.HI) / 2), .1, TD / 2 + .55)],
  [tag('ax', 'now'), () => new THREE.Vector3(binX(1.5), 0, TD / 2 + .35)], [tag('ax', '2 weeks ago'), () => new THREE.Vector3(binX(3.5), 0, -TD / 2 + 1.2)]];
const v3 = new THREE.Vector3();
let W = 1, H = 1;
function placeTags() { for (const [el, f] of T) { v3.copy(f()).project(camera); el.style.transform = 'translate(' + ((v3.x * .5 + .5) * W).toFixed(1) + 'px,' + ((-v3.y * .5 + .5) * H).toFixed(1) + 'px) translate(-50%,-100%)'; } }

let par = { x: 0, y: 0 }, parT = { x: 0, y: 0 }, phone = false;
addEventListener('pointermove', e => { parT.x = (e.clientX / innerWidth - .5) * 2; parT.y = (e.clientY / innerHeight - .5) * 2; });
function resize() { const r = host.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height); phone = W < 560; renderer.setSize(W, H, false); camera.aspect = W / H; camera.fov = phone ? 42 : 30; camera.updateProjectionMatrix(); sMat.uniforms.px.value = H * renderer.getPixelRatio() / 420; }
const t0 = performance.now(); let g0 = 0;
function render(t) {
  par.x += (parT.x - par.x) * .04; par.y += (parT.y - par.y) * .04;
  const az = (RM ? 0 : Math.sin(t * .12) * .16) + par.x * .12, dist = phone ? 13.4 : 15.2;
  camera.position.set(Math.sin(az) * dist, (phone ? 7.4 : 6.6) - par.y * .6, Math.cos(az) * dist); camera.lookAt(0, phone ? .2 : .55, -.6);
  const g = RM ? 1 : Math.min(1.2, (t - g0) / 2.2);
  terrMat.uniforms.t.value = t; terrMat.uniforms.g.value = g; ghostMat.uniforms.t.value = t; ghostMat.uniforms.g.value = Math.max(0, Math.min(1, (g - .9) * 4)); sMat.uniforms.t.value = t;
  renderer.render(scene, camera); placeTags();
  skyMat.uniforms.t.value = t + 30; sky.render(skyScene, skyCam);
}
let vis = true; new IntersectionObserver(es => { vis = es[0].isIntersecting; }).observe(host);
let frameN = 0;
function loop(now) { requestAnimationFrame(loop); const t = (now - t0) / 1000; frameN++;
  if (vis) render(t); else if (frameN % 2 === 0) { skyMat.uniforms.t.value = t + 30; sky.render(skyScene, skyCam); } }
new ResizeObserver(() => { resize(); if (RM) render(8); }).observe(host); resize();
addEventListener('resize', () => { if (RM) render(8); });
if (RM) render(8); else requestAnimationFrame(loop);
addEventListener('lp:refresh', () => { g0 = (performance.now() - t0) / 1000 - .5; });
addEventListener('lp:win', () => { g0 = (performance.now() - t0) / 1000 - 1.2; });
`;

module.exports = C.page({ id: 'E', title: 'LP Shape · Aurora (mockup)', css, body, module: mod });
