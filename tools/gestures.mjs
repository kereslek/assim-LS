// Synthetic fingers for the dashboard's charts, shared by tools/site-test.mjs and tools/live-audit.mjs: pointer events
// with pointerType 'touch', one pointerId per finger, each sent to the element under it, as a phone's browser sends
// them. Run with page.evaluate(FINGERS, { pts: [{ id, x0, y0, x1, y1 }], steps, ms, end }); `end` is 'pointerup',
// 'pointercancel' or '' (the fingers stay down). It returns whether every finger landed on something.
// What this can't show: that a real iPhone's Safari hands the gesture to the page at all. That rests on the charts'
// touch-action: pan-y and on the page holding its touchmove and gesture events, which the tests check separately.
export const FINGERS = async ({ pts, steps = 10, ms = 16, end = 'pointerup' }) => {
  const tgt = pts.map((q) => document.elementFromPoint(q.x0, q.y0));
  const fire = (type, i, x, y) => tgt[i] && tgt[i].dispatchEvent(new PointerEvent(type, { pointerId: pts[i].id, pointerType: 'touch', isPrimary: i === 0, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, buttons: /up|cancel/.test(type) ? 0 : 1, width: 18, height: 18, pressure: /up|cancel/.test(type) ? 0 : 0.5 }));
  pts.forEach((q, i) => fire('pointerdown', i, q.x0, q.y0));
  for (let k = 1; k <= steps; k++) { await new Promise((r) => setTimeout(r, ms)); pts.forEach((q, i) => fire('pointermove', i, q.x0 + ((q.x1 - q.x0) * k) / steps, q.y0 + ((q.y1 - q.y0) * k) / steps)); }
  if (end) pts.forEach((q, i) => fire(end, i, q.x1, q.y1));
  return tgt.every(Boolean);
};
// where a chart host sits on screen, scrolled to the middle first
export const HOST_BOX = ({ id, root = '' }) => { window.dispatchEvent(new WheelEvent('wheel')); const h = document.querySelector(`${root} [data-pz="${id}"]`); if (!h) return null; h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
// two fingers `d0` px apart around (fx, fy) of a host box, spread by `k`, their middle moved by (mx, my)
export const pinchPts = (b, k, { fx = 0.5, fy = 0.5, d0 = 80, mx = 0, my = 0 } = {}) => {
  const cx = b.x + b.w * fx, cy = b.y + b.h * fy;
  return [{ id: 21, x0: cx - d0 / 2, y0: cy, x1: cx + mx - (d0 * k) / 2, y1: cy + my }, { id: 22, x0: cx + d0 / 2, y0: cy, x1: cx + mx + (d0 * k) / 2, y1: cy + my }];
};
