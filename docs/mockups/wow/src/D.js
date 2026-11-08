// D · Daylight, evolved: airy, premium, isometric 3D chart with soft shadows and springs.
const C = require('./common');

const css = `
:root{--f:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,"Segoe UI",Roboto,system-ui,sans-serif;--m:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
--bg-solid:#F3F6F9;--fg:#0F1B2A;--mut:#5E6E80;--acc:#0FA672;--blue:#3B82F6;--amber:#E08A00;--neg:#E5484D;--line:rgba(15,27,42,.08);
--gauge:#0FA672;--gauge-bg:rgba(15,27,42,.1);
--spring:linear(0,.009,.035 2.1%,.141,.281 6.7%,.723 12.9%,.938 16.7%,1.017,1.077,1.121,1.149 24.3%,1.159,1.163,1.161,1.154 29.9%,1.129 32.8%,1.051 39.6%,1.017 43.1%,.991,.977 51%,.974 53.8%,.975 57.1%,.997 69.8%,1.003 76.9%,1);
--sh:0 1px 1px rgba(16,24,40,.04),0 6px 16px -6px rgba(16,24,40,.08),0 30px 60px -28px rgba(16,24,40,.16)}
body{background:#F3F6F9}
body{position:relative}
.sky{position:absolute;inset:0;z-index:0;overflow:hidden;background:linear-gradient(180deg,#F7F9FB,#EDF2F6)}
.sky i{position:absolute;border-radius:50%;filter:blur(70px);opacity:.55;animation:float 22s ease-in-out infinite alternate}
.sky i:nth-child(1){width:560px;height:560px;left:-120px;top:-160px;background:#B6F0D6;animation-duration:24s}
.sky i:nth-child(2){width:520px;height:520px;right:-140px;top:60px;background:#C8DCFF;animation-duration:28s;animation-delay:-6s}
.sky i:nth-child(3){width:520px;height:520px;left:30%;top:640px;background:#FFE1C2;opacity:.45;animation-duration:31s;animation-delay:-12s}
@keyframes float{50%{transform:translate(60px,40px) scale(1.08)}100%{transform:translate(-30px,70px) scale(.96)}}
.sky i:nth-child(4){width:460px;height:460px;right:6%;top:1100px;background:#C9F2E2;animation-duration:26s;animation-delay:-3s}
.grain{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.35;background-image:radial-gradient(rgba(15,27,42,.05) 1px,transparent 1px);background-size:3px 3px;mix-blend-mode:multiply}
.card{position:relative;background:rgba(255,255,255,.74);border:1px solid rgba(255,255,255,.95);border-radius:26px;box-shadow:var(--sh),inset 0 0 0 1px rgba(15,27,42,.03);backdrop-filter:blur(26px) saturate(1.7);-webkit-backdrop-filter:blur(26px) saturate(1.7)}
.brand{color:var(--fg)}.brand svg{color:var(--fg)}
.tgl,.chip,.seg{background:rgba(255,255,255,.78);border:1px solid rgba(15,27,42,.06);color:var(--mut);box-shadow:0 1px 2px rgba(16,24,40,.05),0 4px 12px -6px rgba(16,24,40,.12);backdrop-filter:blur(12px)}
.tgl .sw{background:#DCE3EA}.tgl .sw i{background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.3)}
.tgl[aria-pressed=true]{color:var(--acc)}.tgl[aria-pressed=true] .sw{background:var(--acc)}
.chip b{color:var(--fg)}.up{color:var(--acc)}.dn{color:var(--neg)}
.fl-up b{animation:tu .8s}.fl-dn b{animation:td .8s}
@keyframes tu{30%{color:var(--acc)}}@keyframes td{30%{color:var(--neg)}}
.seg button{color:var(--mut)}.seg button.on{color:#fff}.seg-ind{background:var(--fg);box-shadow:0 4px 10px -3px rgba(15,27,42,.4);transition-timing-function:var(--spring);transition-duration:.7s}
.tip{background:rgba(15,27,42,.92);color:#fff;box-shadow:0 10px 30px -10px rgba(15,27,42,.5)}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:20px}
.hero{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);min-height:470px;overflow:hidden}
.hero-copy{padding:32px 34px;display:flex;flex-direction:column}
.kick{color:var(--mut)}.kick b{color:var(--fg)}
.kick .dot{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 4px rgba(15,166,114,.15)}
.pair{color:var(--fg);font-size:32px;font-weight:700}.pair small{color:var(--mut);flex-basis:100%;margin-left:28px}
.headline{margin-top:22px}
.big{font-size:84px;font-weight:800;background:linear-gradient(180deg,#14C08A,#0A8A5E);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 10px 18px rgba(15,166,114,.18))}
.per{color:var(--mut);font-size:15px}
.breakdown{color:var(--mut);font-size:13.5px}.pos{color:var(--acc)}.neg{color:var(--neg)}.apr{color:var(--fg)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:auto;padding-top:22px}
.stat{background:#fff;border:1px solid var(--line);border-radius:16px;padding:10px 14px;box-shadow:0 1px 2px rgba(16,24,40,.04);font:600 11px var(--m);color:var(--mut)}
.stat b{display:block;font:700 15px var(--f);color:var(--fg);margin-top:3px}
.stat.g b{color:var(--acc)}
.stage-wrap{position:relative;border-left:1px solid var(--line);background:radial-gradient(80% 70% at 50% 60%,#fff,rgba(255,255,255,0))}
.stage{position:absolute;inset:0;cursor:grab;touch-action:pan-y}.stage:active{cursor:grabbing}
.stage canvas{width:100%!important;height:100%!important}
.hero .lg3{position:absolute;left:22px;top:20px;z-index:3;color:var(--mut)}
.lg.in i{background:var(--acc)}.lg.px i{background:var(--fg);width:3px;height:14px;border-radius:2px}.lg.gh i{border:1.5px dashed var(--amber);background:rgba(224,138,0,.12)}
.hint{position:absolute;right:20px;top:20px;z-index:3;font:600 10.5px var(--m);color:var(--mut);background:rgba(255,255,255,.8);border:1px solid var(--line);padding:5px 9px;border-radius:99px}
.tag3{background:#fff;color:var(--fg);box-shadow:0 4px 14px -4px rgba(16,24,40,.25);border:1px solid var(--line)}
.tag3.px{background:var(--fg);color:#fff;border-color:transparent}
.tag3.gh{color:var(--amber)}
.tag3.in{color:var(--acc)}
.side{grid-column:span 5;padding:24px 18px 16px}
.side .kick{padding:0 10px 12px}
.nx{transition:transform .6s var(--spring),box-shadow .3s,background .3s}
.nx:hover,.nx:focus-visible{background:#fff;transform:translateY(-3px) scale(1.01);box-shadow:0 12px 28px -14px rgba(16,24,40,.25)}
.nx .nm b{color:var(--fg)}.nx .nm em,.nx .val em,.nx .rank{color:var(--mut)}.nx .val b{color:var(--fg)}.nx .spark{color:var(--acc)}
.nx .stag{background:#EEF2FF;color:#4F46E5}
.lanes-card{grid-column:span 7;padding:24px}
.lanes-card .kick,.fee-card .kick{color:var(--mut);margin-bottom:14px}
.lanes-card .lanes{grid-template-columns:repeat(2,1fr)}
.lane{background:#fff;border:1px solid var(--line);border-radius:20px;padding:16px;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:transform .7s var(--spring),box-shadow .35s}
.lane:hover,.lane:focus-visible{transform:translateY(-5px);box-shadow:0 18px 36px -18px rgba(16,24,40,.28);outline:none}
.lane .ico{background:#E7F8F1;color:var(--acc)}.lane[data-lane=cex] .ico{background:#EAF1FF;color:var(--blue)}.lane[data-lane=xc] .ico{background:#F3EEFF;color:#7C3AED}.lane[data-lane=ret] .ico{background:#FFF3E3;color:var(--amber)}
.lane .n{background:#F1F4F8;color:var(--fg)}.lane p,.lane li em{color:var(--mut)}.lane li b{color:var(--fg)}.lane .lv{color:var(--acc)}
.lane li+li{border-top:1px solid var(--line)}
.fee-card{grid-column:1/-1;padding:24px 26px;display:grid;grid-template-columns:240px minmax(0,1fr);gap:28px;align-items:end}
.fee-card .fsum .kick{margin-bottom:10px}
.fee-card .fsum .v{font:800 40px var(--f);letter-spacing:-.03em;color:var(--fg)}
.fee-card .fsum .v small{font:600 13px var(--m);color:var(--mut);letter-spacing:0}
.fee-card .fsum .lgd{display:flex;gap:14px;margin-top:12px}
.fee-bars{height:110px}
.fee-bars i.est{background:rgba(15,166,114,.16);border:1.5px dashed rgba(15,166,114,.45);border-bottom:0}
.fee-bars i.ex{background:linear-gradient(180deg,#19C38D,#0C9A69);box-shadow:0 6px 14px -8px rgba(15,166,114,.7)}
.fee-bars i{transition-timing-function:var(--spring)}
.fee-bars i:hover{filter:brightness(1.1) saturate(1.2)}
.fl{color:var(--mut)}.fl i.est{background:rgba(15,166,114,.16);border:1.5px dashed rgba(15,166,114,.5)}.fl i.ex{background:var(--acc)}
.fee-ax{color:var(--mut)}
.rv{transition:opacity .6s ease calc(var(--i,0)*80ms),transform 1s var(--spring) calc(var(--i,0)*80ms);transform:translateY(26px) scale(.98)}
.rv.in{transform:none}
.hero.rv{transform:translateY(20px) scale(.985)}
body.refresh .big{animation:pop .9s var(--spring)}
@keyframes pop{0%{transform:scale(.94)}100%{transform:none}}
.fallback small{color:var(--mut)}

.side{display:flex;flex-direction:column}
.mix{margin:auto 10px 6px;padding-top:18px;border-top:1px solid var(--line)}
.mix-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.mix-h .kick{padding:0}
.all{font:600 12px var(--f);color:var(--acc);padding:6px 10px;border-radius:99px;background:#E7F8F1;transition:transform .6s var(--spring)}.all:hover{transform:translateX(3px)}
.mix-bar{display:flex;gap:4px;height:12px}
.mix-bar i{display:block;height:100%;border-radius:6px;background:var(--c);width:0;transition:width 1.2s var(--spring) .5s}
.side.in .mix-bar i{width:var(--w)}
.mix-k{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font:600 11.5px var(--m);color:var(--mut)}.mix-k span{display:inline-flex;align-items:center;gap:5px}.mix-k b{color:var(--fg)}
@media (max-width:1100px){.hero{grid-template-columns:1fr}.stage-wrap{height:400px;border-left:0;border-top:1px solid var(--line)}.side,.lanes-card{grid-column:1/-1}}
@media (max-width:760px){
 .grid{gap:14px}
 .card{border-radius:22px}
 .hero-copy{padding:22px 20px 18px}
 .pair{font-size:26px}.pair small{margin-left:0}
 .headline{margin-top:14px}
 .big{font-size:60px}
 .stats{padding-top:16px;gap:8px}.stat{padding:8px 11px;flex:1}.stat b{font-size:14px}
 .stage-wrap{height:320px}
 .hero .lg3{left:14px;top:12px;right:14px;gap:10px;font-size:10.5px}
 .hint{display:none}
 .side,.lanes-card{padding:18px 12px}
 .lanes-card .lanes{grid-template-columns:none}
 .fee-card{grid-template-columns:1fr;gap:14px;padding:18px 16px}
 .fee-card .fsum .v{font-size:32px}
}`;

const body = `
<div class="sky" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="grain" aria-hidden="true"></div>
${C.ribbon('D · DAYLIGHT')}
<div class="wrap">
${C.topbar({ logo: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="7" fill="#0F1B2A"/><path d="M5 16c3 0 3.6-8 7-8s4 8 7 8" fill="none" stroke="#19C38D" stroke-width="2.2" stroke-linecap="round"/></svg>' })}
<main class="grid">
  <section class="card hero rv" aria-label="Best find">
    ${C.heroCopy().replace('</div>\n</div>', `</div>
  <div class="stats"><div class="stat g">in range<b>±6% · 4.1 d</b></div><div class="stat">at the price<b>0.3× walls</b></div><div class="stat">fees, 7 d<b data-count="26.60" data-prefix="$">$26.60</b></div></div>
</div>`)}
    <div class="stage-wrap"><div class="stage" id="stage" data-fallback='["#0FA672","#cfd8e2","#0F1B2A"]'></div>${C.legend3d()}<div class="hint">drag to turn</div></div>
  </section>
  <aside class="card side rv" style="--i:1" aria-label="Next best">
    <div class="kick">Next best · $/day per $1,000</div>
    ${C.nextList()}
    <div class="mix"><div class="mix-h"><span class="kick">Chain mix · 17 pools</span><a href="#" class="all">See all →</a></div>
      <div class="mix-bar"><i style="--w:35%;--c:#8A9EF5"></i><i style="--w:41%;--c:#2F6BFF"></i><i style="--w:24%;--c:#F0B90B"></i></div>
      <div class="mix-k"><span>${C.markSVG('eth', 11)} Ethereum <b>6</b></span><span>${C.markSVG('base', 11)} Base <b>7</b></span><span>${C.markSVG('bnb', 11)} BNB <b>4</b></span></div></div>
  </aside>
  <section class="card lanes-card rv" style="--i:2" aria-label="Discovery">
    <div class="kick">Discovery lanes</div>
    ${C.lanes()}
  </section>
  <section class="card fee-card rv" style="--i:1" aria-label="Fee history">
    <div class="fsum"><div class="kick">Fee history · 30 d</div><div class="v"><span data-count="3.12" data-prefix="$">$3.12</span> <small>avg/day per $1k</small></div><div class="lgd">${C.feeLegend}</div></div>
    ${C.feeStrip()}
  </section>
</main>
</div>`;

const mod = `
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
const D = window.LPD, RM = window.RM;
const host = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);
window.__sceneOK = true;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 100);
const N = D.N, ROWS = 3, SX = .42, SZ = 1.05, HS = 2.35;
const X = i => (i - (N - 1) / 2) * SX, Z = r => -r * SZ;
const world = new THREE.Group(); scene.add(world);

scene.add(new THREE.HemisphereLight(0xffffff, 0xd9e2ec, 1.25));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-6, 14, 9); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 40 }); key.shadow.bias = -.0004; key.shadow.normalBias = .02;
scene.add(key);
const fill = new THREE.DirectionalLight(0xdff7ee, .6); fill.position.set(8, 5, -4); scene.add(fill);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: .13 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; world.add(ground);
// in-range floor tint + glass range panes
const bandW = (D.HI - D.LO + 1) * SX, bandX = (X(D.LO) + X(D.HI)) / 2, depth = ROWS * SZ + .5, zMid = Z((ROWS - 1) / 2);
const band = new THREE.Mesh(new THREE.PlaneGeometry(bandW, depth), new THREE.MeshBasicMaterial({ color: 0x0fa672, transparent: true, opacity: .1, depthWrite: false }));
band.rotation.x = -Math.PI / 2; band.position.set(bandX, .005, zMid); world.add(band);
for (const sx of [X(D.LO) - SX / 2, X(D.HI) + SX / 2]) {
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(depth, 3.4), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec2 vUv; void main(){ float a=(1.-vUv.y)*.16; float e=smoothstep(.0,.02,vUv.x)*smoothstep(1.,.98,vUv.x); gl_FragColor=vec4(.06,.65,.45,a*e + (1.-e)*.0); }' }));
  pane.rotation.y = Math.PI / 2; pane.position.set(sx, 1.7, zMid); world.add(pane);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(.012, .012, depth), new THREE.MeshBasicMaterial({ color: 0x0fa672 })); edge.position.set(sx, .006, zMid); world.add(edge);
}

// bars
const geo = new RoundedBoxGeometry(SX * .78, 1, SZ * .74, 3, .045); geo.translate(0, .5, 0);
const matFront = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .5, metalness: 0 });
const matIn = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .35, metalness: 0, emissive: 0x0fa672, emissiveIntensity: .12 });
const matBack = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .6, metalness: 0, transparent: true, opacity: .9 });
const cells = []; for (let r = 0; r < ROWS; r++) for (let i = 0; i < N; i++) cells.push({ i, r, inr: i >= D.LO && i <= D.HI, h: D.liq(i, r * 2), x: 0, v: 0, d: .2 + Math.abs(i - 17.5) * .028 + r * .12 });
const groups = [[cells.filter(c => c.r === 0 && !c.inr), matFront], [cells.filter(c => c.r === 0 && c.inr), matIn], [cells.filter(c => c.r > 0), matBack]];
const col = new THREE.Color();
const meshes = groups.map(([list, mat], gi) => { const m = new THREE.InstancedMesh(geo, mat, list.length); m.castShadow = true; m.receiveShadow = true;
  list.forEach((c, k) => { if (gi === 0) col.set(0xf7f9fc).lerp(new THREE.Color(0xdfe7f1), Math.min(1, c.h)); else if (gi === 1) col.set(0x12b981).lerp(new THREE.Color(0x0a8a5e), c.i % 2 ? .25 : 0); else col.set(0xfbfcfe).lerp(new THREE.Color(0xe6edf5), .4 - c.r * .12); m.setColorAt(k, col); });
  world.add(m); return { m, list }; });

// competition ghost: glass caps on the front in-range bars
const ghosts = [];
for (let i = D.LO; i <= D.HI; i++) { const g = new RoundedBoxGeometry(SX * .78, 1, SZ * .74, 2, .03); g.translate(0, .5, 0);
  const cap = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffc56b, transparent: true, opacity: .32, roughness: .2, depthWrite: false }));
  const box = new THREE.BoxGeometry(SX * .78, 1, SZ * .74); box.translate(0, .5, 0);
  const ln = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineDashedMaterial({ color: 0xe08a00, dashSize: .06, gapSize: .045 })); ln.computeLineDistances();
  const grp = new THREE.Group(); grp.add(cap, ln); grp.position.set(X(i), 0, Z(0)); world.add(grp); ghosts.push({ grp, cap, i }); }

// price pin
const p0 = D.price(0);
const pin = new THREE.Group(); pin.position.set(X(p0), 0, Z(0) + SZ * .55); world.add(pin);
const stem = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, 4.2, 12).translate(0, 0, 0), new THREE.MeshStandardMaterial({ color: 0x0f1b2a, roughness: .4 })); stem.scale.y = .86; stem.position.y = 2.1 * .86; stem.castShadow = true; pin.add(stem);
const head = new THREE.Mesh(new THREE.SphereGeometry(.12, 24, 16), new THREE.MeshStandardMaterial({ color: 0x0f1b2a, roughness: .25 })); head.position.y = 3.62; head.castShadow = true; pin.add(head);
const ring = new THREE.Mesh(new THREE.RingGeometry(.14, .2, 40), new THREE.MeshBasicMaterial({ color: 0x0f1b2a, transparent: true, opacity: .5, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .01; pin.add(ring);

// fee coins dropping into the range
const coinGeo = new THREE.CylinderGeometry(.11, .11, .03, 28); const coinMat = new THREE.MeshStandardMaterial({ color: 0x16c08a, roughness: .25, metalness: .35, emissive: 0x0fa672, emissiveIntensity: .25 });
const coins = []; for (let k = 0; k < (RM ? 0 : 9); k++) { const c = new THREE.Mesh(coinGeo, coinMat); c.castShadow = true; world.add(c); coins.push({ c, t: -k * .45, bi: D.LO + (k * 7) % (D.HI - D.LO + 1) }); }

// tags
const tag = (cls, txt) => { const d = document.createElement('div'); d.className = 'tag3 ' + cls; d.textContent = txt; host.appendChild(d); return d; };
const hOf = (i, r) => { const c = cells[r * N + i]; return c.x; };
const T = [[tag('px', 'price ' + D.priceLabel), () => new THREE.Vector3(X(p0), 3.95, Z(0) + SZ * .55)],
  [tag('gh', 'competition +2 pools'), () => new THREE.Vector3(X(D.HI) + .2, (hOf(D.HI, 0) + D.ghost(D.HI)) * HS + .45, Z(0))],
  [tag('in', 'in range ±6%'), () => new THREE.Vector3(bandX, 0, Z(0) + SZ * 1.25)]];
const v3 = new THREE.Vector3();
function placeTags() { for (const [el, f] of T) { v3.copy(f()); world.localToWorld(v3); v3.project(camera); el.style.transform = 'translate(' + ((v3.x * .5 + .5) * W).toFixed(1) + 'px,' + ((-v3.y * .5 + .5) * H).toFixed(1) + 'px) translate(-50%,-100%)'; } }

// camera + gentle rotation + drag with inertia
let W = 1, H = 1, rotY = 0, rotV = 0, drag = null, start = performance.now(), grow0 = 0;
function frame() { const phone = W < 560, a = W / H; const view = phone ? 12.8 : 16.5; const hh = Math.max(view / a, phone ? 7.6 : 6.6) / 2;
  camera.left = -hh * a; camera.right = hh * a; camera.top = hh; camera.bottom = -hh; camera.zoom = 1; camera.updateProjectionMatrix();
  camera.position.set(14, 11.5, 16); camera.lookAt(0, phone ? 1.0 : .95, -1.0); }
function resize() { const r = host.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height); renderer.setSize(W, H, false); frame(); }
host.addEventListener('pointerdown', e => { drag = { x: e.clientX, r: rotY }; host.setPointerCapture(e.pointerId); });
host.addEventListener('pointermove', e => { if (drag) { const nr = drag.r + (e.clientX - drag.x) * .006; rotV = nr - rotY; rotY = nr; } });
host.addEventListener('pointerup', () => { drag = null; });
const dummy = new THREE.Object3D();
function step(time, dt) {
  const g = time - grow0;
  for (const { m, list } of meshes) { list.forEach((c, k) => { if (RM) c.x = c.h; else if (g > c.d) { const f = -170 * (c.x - c.h) - 13 * c.v; c.v += f * dt; c.x += c.v * dt; }
      dummy.position.set(X(c.i), 0, Z(c.r)); dummy.scale.set(1, Math.max(.004, c.x) * HS, 1); dummy.updateMatrix(); m.setMatrixAt(k, dummy.matrix); }); m.instanceMatrix.needsUpdate = true; }
  ghosts.forEach(o => { const top = Math.max(0, hOf(o.i, 0)) * HS; o.grp.position.y = top; const k = RM ? 1 : Math.min(1, Math.max(0, (g - 1.4) / .7)); o.grp.scale.y = Math.max(.001, D.ghost(o.i) * HS * (1 - Math.pow(1 - k, 3))); o.cap.material.opacity = .22 + .14 * Math.sin(time * 2.2); });
  coins.forEach(o => { o.t += dt * .55; if (o.t > 1.6) { o.t = 0; o.bi = D.LO + Math.floor(Math.random() * (D.HI - D.LO + 1)); }
    const k = Math.max(0, o.t), top = hOf(o.bi, 0) * HS + .03; const y = top + Math.max(0, 3.4 * (1 - k * k * 1.25));
    o.c.position.set(X(o.bi), y, Z(0)); o.c.rotation.set(Math.PI / 2 * (1 - Math.min(1, k * 1.25)), time * 3, 0); o.c.visible = o.t > 0 && k < 1.15; o.c.scale.setScalar(k > .8 ? Math.max(.01, 1 - (k - .8) * 2.8) : 1); });
  if (!drag) { rotY += rotV; rotV *= .92; rotY += (0 - rotY) * .01; }
  world.rotation.y = rotY + (RM ? 0 : Math.sin(time * .22) * .2);
  ring.scale.setScalar(1 + ((time * .8) % 1) * 2.2); ring.material.opacity = .5 * (1 - (time * .8) % 1);
  renderer.render(scene, camera); placeTags();
}
let last = performance.now(), visible = true;
new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(host);
function loop(now) { requestAnimationFrame(loop); if (!visible) return; const dt = Math.min(.033, (now - last) / 1000); last = now; step((now - start) / 1000, dt); }
new ResizeObserver(() => { resize(); if (RM) step(5, 0); }).observe(host); resize();
if (RM) step(5, 0); else requestAnimationFrame(loop);
const regrow = () => { cells.forEach(c => { c.v = -1.5 - Math.random(); }); };
addEventListener('lp:win', e => { const m = e.detail.mult; cells.forEach(c => { c.v += (m - 1) * 6 - .8; }); });
addEventListener('lp:refresh', regrow);
`;

module.exports = C.page({ id: 'D', title: 'LP Shape · Daylight (mockup)', css, body, module: mod });
