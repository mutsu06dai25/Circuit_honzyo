// コース図（キャンバス）: コース面・コーナー番号・S/F・各ラップのライン・ブレーキ点・リプレイの点を描く
import { cssVar } from './util.js';

export class TrackMap {
  constructor(canvas, { interactive = true, compact = false, padding = 22 } = {}) {
    Object.assign(this, { cv: canvas, interactive, compact, padding });
    this.scene = null; this.dots = []; this.view = { z: 1, px: 0, py: 0 }; this.base = null;
    this.onTap = null;
    this.bind();
    if ('ResizeObserver' in window) new ResizeObserver(() => { this.fit(false); this.draw(); }).observe(canvas);
  }
  setScene(scene, { refit = true } = {}) { this.scene = scene; if (refit || !this.base) this.fit(); this.draw(); }
  setDots(dots) { this.dots = dots; this.requestDraw(); }
  requestDraw() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }
  dims() { return [this.cv.clientWidth, this.cv.clientHeight]; }

  points(step = 4) {
    const sc = this.scene; if (!sc) return [];
    const out = [];
    if (sc.model) { for (let j = 0; j < sc.model.N; j += step) out.push([sc.model.x[j], sc.model.y[j]]); }
    else if (sc.laps && sc.laps[0]) { const l = sc.laps[0]; for (let i = 0; i < l.x.length; i += step) out.push([l.x[i], l.y[i]]); }
    return out;
  }
  fit(resetView = true) {
    const pts = this.points();
    const [W, H] = this.dims();
    if (!pts.length || !W || !H) return;
    let best = null;
    const angles = this.scene.northUp ? [0] : Array.from({ length: 36 }, (_, i) => i * 5 * Math.PI / 180);
    for (const a of angles) {
      const c = Math.cos(a), s = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { const xr = x * c - y * s, yr = x * s + y * c; if (xr < x0) x0 = xr; if (xr > x1) x1 = xr; if (yr < y0) y0 = yr; if (yr > y1) y1 = yr; }
      const m = 10;
      const sc = Math.min((W - 2 * this.padding) / (x1 - x0 + 2 * m), (H - 2 * this.padding) / (y1 - y0 + 2 * m));
      if (!best || sc > best.s * 1.02) best = { s: sc, cos: c, sin: s, mx: (x0 + x1) / 2, my: (y0 + y1) / 2, a };
    }
    this.base = best;
    if (resetView) this.view = { z: 1, px: 0, py: 0 };
  }
  scale() { return this.base ? this.base.s * this.view.z : 1; }
  toScreen(x, y) {
    const b = this.base, [W, H] = this.dims();
    const xr = x * b.cos - y * b.sin, yr = x * b.sin + y * b.cos, s = b.s * this.view.z;
    return [W / 2 + (xr - b.mx) * s + this.view.px, H / 2 - (yr - b.my) * s + this.view.py];
  }
  toWorld(X, Y) {
    const b = this.base, [W, H] = this.dims(), s = b.s * this.view.z;
    const xr = (X - W / 2 - this.view.px) / s + b.mx, yr = -(Y - H / 2 - this.view.py) / s + b.my;
    return [xr * b.cos + yr * b.sin, -xr * b.sin + yr * b.cos];
  }
  zoomAt(f, X, Y) {
    const [W, H] = this.dims();
    X = X ?? W / 2; Y = Y ?? H / 2;
    const z2 = Math.max(0.6, Math.min(40, this.view.z * f)), k = z2 / this.view.z;
    this.view.px = X - W / 2 - (X - W / 2 - this.view.px) * k;
    this.view.py = Y - H / 2 - (Y - H / 2 - this.view.py) * k;
    this.view.z = z2; this.requestDraw();
  }
  reset() { this.view = { z: 1, px: 0, py: 0 }; this.requestDraw(); }
  // モデル上の区間 [s0, s1] を画面いっぱいに
  focusS(s0, s1, pad = 30) {
    const m = this.scene && this.scene.model; if (!m || !this.base) return;
    const [W, H] = this.dims();
    this.view = { z: 1, px: 0, py: 0 };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let s = s0 - pad; s <= s1 + pad; s += 2) {
      const j = ((Math.round(s / m.step) % m.N) + m.N) % m.N;
      for (const off of [m.left[j] - 3, m.right[j] + 3]) {
        const [X, Y] = this.toScreen(m.x[j] + off * m.nx[j], m.y[j] + off * m.ny[j]);
        x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
      }
    }
    const z = Math.min(40, Math.min((W - 30) / (x1 - x0), (H - 30) / (y1 - y0)));
    this.view.z = z;
    this.view.px = (W / 2 - (x0 + x1) / 2) * z;
    this.view.py = (H / 2 - (y0 + y1) / 2) * z;
    this.requestDraw();
  }

  bind() {
    const cv = this.cv, pts = new Map();
    let pinch = null, drag = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const p = pos(e);
      pts.set(e.pointerId, p);
      if (this.interactive) { try { cv.setPointerCapture(e.pointerId); } catch (er) { /* 無視 */ } }
      if (pts.size === 2 && this.interactive) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, view: { ...this.view } };
        drag = null;
      } else drag = { x: p[0], y: p[1], view: { ...this.view }, moved: false, t: performance.now() };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pos(e);
      pts.set(e.pointerId, p);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.view = { ...pinch.view };
        this.zoomAt(d / pinch.d, pinch.mx, pinch.my);
        this.view.px += (a[0] + b[0]) / 2 - pinch.mx;
        this.view.py += (a[1] + b[1]) / 2 - pinch.my;
      } else if (drag) {
        const dx = p[0] - drag.x, dy = p[1] - drag.y;
        if (Math.hypot(dx, dy) > 6) drag.moved = true;
        if (drag.moved && this.interactive) { this.view.px = drag.view.px + dx; this.view.py = drag.view.py + dy; this.requestDraw(); }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (drag && !drag.moved && performance.now() - drag.t < 500 && this.onTap && this.base) {
        const [X, Y] = pos(e);
        const [x, y] = this.toWorld(X, Y);
        this.onTap(x, y, X, Y);
      }
      if (!pts.size) drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = null; drag = null; });
    cv.addEventListener('wheel', (e) => { if (!this.interactive) return; e.preventDefault(); const [X, Y] = pos(e); this.zoomAt(Math.exp(-e.deltaY * 0.0018), X, Y); }, { passive: false });
    cv.addEventListener('dblclick', () => this.reset());
  }

  draw() {
    const cv = this.cv, sc = this.scene;
    const [W, H] = this.dims();
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!sc || !this.base) return;
    const S = (x, y) => this.toScreen(x, y);
    const pxm = this.scale();
    const m = sc.model;
    const trackCol = cssVar('--track'), edgeCol = cssVar('--track-edge'), lineCol = cssVar('--track-line'), muted = cssVar('--muted'), fg = cssVar('--fg');
    // OpenStreetMap のコース形状（取得済みなら）
    if (sc.osm) {
      ctx.strokeStyle = lineCol; ctx.globalAlpha = 0.55; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const w of sc.osm) {
        ctx.lineWidth = Math.max(2, (w.width || 9) * pxm);
        ctx.beginPath();
        w.x.forEach((x, i) => { const [X, Y] = S(x, w.y[i]); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // コース面（全ラップの走行範囲 + 余白）
    if (m) {
      const minHalf = Math.max(4.2, 5 / pxm); // 画面上で最低 5px
      const edge = (j, side) => side > 0 ? Math.max(m.right[j] + 1.5, minHalf) : Math.min(m.left[j] - 1.5, -minHalf);
      const ring = (side) => { for (let j = 0; j <= m.N; j++) { const q = j % m.N; const o = edge(q, side); const [X, Y] = S(m.x[q] + o * m.nx[q], m.y[q] + o * m.ny[q]); if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); } ctx.closePath(); };
      ctx.beginPath(); ring(1); ring(-1);
      ctx.fillStyle = trackCol; ctx.fill('evenodd');
      ctx.lineWidth = 1.2; ctx.strokeStyle = edgeCol; ctx.stroke();
      // 縁石（コーナー内側）
      if (sc.corners && pxm > 0.5 && !this.compact) {
        for (const c of sc.corners) {
          const side = c.dir === 'R' ? 1 : -1;
          ctx.beginPath();
          for (let s = c.s0; s <= c.s1; s += 1) { const q = ((Math.round(s / m.step) % m.N) + m.N) % m.N; const o = edge(q, side); const [X, Y] = S(m.x[q] + o * m.nx[q], m.y[q] + o * m.ny[q]); if (s === c.s0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); }
          ctx.lineWidth = 3; ctx.setLineDash([]); ctx.strokeStyle = '#ffffff'; ctx.stroke();
          ctx.setLineDash([4, 4]); ctx.strokeStyle = '#e3120b'; ctx.stroke(); ctx.setLineDash([]);
        }
      }
      // 距離の目盛り（100m ごと）
      if (!this.compact && pxm > 0.35) {
        ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = muted; ctx.strokeStyle = muted; ctx.lineWidth = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let s = 100; s < m.L - 30; s += 100) {
          const q = Math.round(s / m.step) % m.N;
          const o = edge(q, -1);
          const [X1, Y1] = S(m.x[q] + o * m.nx[q], m.y[q] + o * m.ny[q]);
          const [X2, Y2] = S(m.x[q] + (o - 4) * m.nx[q], m.y[q] + (o - 4) * m.ny[q]);
          ctx.beginPath(); ctx.moveTo(X1, Y1); ctx.lineTo(X2, Y2); ctx.stroke();
          if (s % 200 === 0 && pxm > 0.6) { const dx = X2 - X1, dy = Y2 - Y1, l = Math.hypot(dx, dy) || 1; ctx.fillText(`${s}`, X2 + dx / l * 10, Y2 + dy / l * 10); }
        }
      }
      // S/F（チェッカー）
      {
        const oL = edge(0, -1), oR = edge(0, 1);
        const [X1, Y1] = S(m.x[0] + oL * m.nx[0], m.y[0] + oL * m.ny[0]);
        const [X2, Y2] = S(m.x[0] + oR * m.nx[0], m.y[0] + oR * m.ny[0]);
        ctx.lineCap = 'butt';
        ctx.lineWidth = this.compact ? 3 : 5; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(X1, Y1); ctx.lineTo(X2, Y2); ctx.stroke();
        ctx.setLineDash([3, 3]); ctx.strokeStyle = '#111'; ctx.stroke(); ctx.setLineDash([]);
        if (!this.compact) { ctx.fillStyle = fg; ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('S/F', Math.max(X1, X2) + 4, Math.min(Y1, Y2) - 2); }
      }
    }
    // セクターライン
    for (const [i, l] of (sc.sectorsXY || []).entries()) {
      const [X1, Y1] = S(l[0][0], l[0][1]), [X2, Y2] = S(l[1][0], l[1][1]);
      ctx.strokeStyle = '#ffc53d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X1, Y1); ctx.lineTo(X2, Y2); ctx.stroke();
      if (!this.compact) { ctx.fillStyle = '#d39b00'; ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`S${i + 1}`, X2 + 3, Y2); }
    }
    // ラップのライン
    for (const L of sc.laps || []) {
      const n = L.x.length;
      ctx.lineWidth = L.width || 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = L.alpha ?? 1;
      ctx.setLineDash(L.dash || []);
      const stride = Math.max(1, Math.floor(1.2 / Math.max(0.05, pxm))) || 1;
      if (L.colors) {
        let i = 0;
        while (i < n - 1) {
          const col = L.colors[i];
          ctx.strokeStyle = col; ctx.beginPath();
          let [X, Y] = S(L.x[i], L.y[i]); ctx.moveTo(X, Y);
          let j = i;
          while (j < n - 1 && L.colors[j] === col) { j = Math.min(n - 1, j + stride); [X, Y] = S(L.x[j], L.y[j]); ctx.lineTo(X, Y); }
          ctx.stroke();
          i = j;
        }
      } else {
        ctx.strokeStyle = L.color; ctx.beginPath();
        for (let i = 0; i < n; i += stride) { const [X, Y] = S(L.x[i], L.y[i]); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
        const [X, Y] = S(L.x[n - 1], L.y[n - 1]); ctx.lineTo(X, Y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
    }
    // マーカー
    for (const mk of sc.markers || []) {
      const [X, Y] = S(mk.x, mk.y);
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.fillStyle = mk.color;
      const r = this.compact ? 3.5 : 5;
      ctx.beginPath();
      if (mk.type === 'throttle') { ctx.moveTo(X, Y - r - 1); ctx.lineTo(X + r, Y + r - 1); ctx.lineTo(X - r, Y + r - 1); ctx.closePath(); }
      else if (mk.type === 'apex') { ctx.moveTo(X, Y - r); ctx.lineTo(X + r, Y); ctx.lineTo(X, Y + r); ctx.lineTo(X - r, Y); ctx.closePath(); }
      else ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    // コーナー番号
    if (m && sc.corners) {
      const r = this.compact ? 8 : 11;
      ctx.font = `700 ${this.compact ? 9 : 11}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      sc.corners.forEach((c, i) => {
        const q = ((Math.round(c.sApex / m.step) % m.N) + m.N) % m.N;
        const side = c.dir === 'R' ? -1 : 1; // 外側
        const mh = Math.max(4.2, 5 / pxm);
        const o = side > 0 ? Math.max(m.right[q] + 1.5, mh) : Math.min(m.left[q] - 1.5, -mh);
        const [X0, Y0] = S(m.x[q] + o * m.nx[q], m.y[q] + o * m.ny[q]);
        const [X1, Y1] = S(m.x[q] + (o + side * 5) * m.nx[q], m.y[q] + (o + side * 5) * m.ny[q]);
        const dx = X1 - X0, dy = Y1 - Y0, l = Math.hypot(dx, dy) || 1;
        const X = X0 + dx / l * (r + 5), Y = Y0 + dy / l * (r + 5);
        ctx.fillStyle = sc.highlightCorner === i ? cssVar('--accent') : '#1b2330';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), X, Y + 0.5);
      });
    }
    // 点（カーソル・リプレイ）
    for (const d of this.dots) {
      if (!Number.isFinite(d.x)) continue;
      const [X, Y] = S(d.x, d.y);
      const r = d.r || (this.compact ? 5.5 : 7.5);
      ctx.fillStyle = d.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (d.label && !this.compact) { ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = d.color; ctx.fillText(d.label, X, Y - r - 3); }
    }
    // 方位・縮尺
    if (!this.compact) {
      const b = this.base;
      const nx = -b.sin, ny = -b.cos; // 画面上の北向き
      const cx = 22, cy = H - 26;
      ctx.strokeStyle = muted; ctx.fillStyle = muted; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx - nx * 9, cy - ny * 9); ctx.lineTo(cx + nx * 9, cy + ny * 9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + nx * 12, cy + ny * 12); ctx.lineTo(cx + nx * 5 - ny * 4, cy + ny * 5 + nx * 4); ctx.lineTo(cx + nx * 5 + ny * 4, cy + ny * 5 - nx * 4); ctx.closePath(); ctx.fill();
      ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', cx + nx * 20, cy + ny * 20);
      const target = 80 / pxm;
      const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500].find(v => v >= target * 0.6) || 500;
      const len = nice * pxm;
      ctx.beginPath(); ctx.moveTo(44, H - 14); ctx.lineTo(44 + len, H - 14); ctx.moveTo(44, H - 18); ctx.lineTo(44, H - 10); ctx.moveTo(44 + len, H - 18); ctx.lineTo(44 + len, H - 10); ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = '10px system-ui, sans-serif'; ctx.fillText(`${nice} m`, 46, H - 17);
    }
  }
}
