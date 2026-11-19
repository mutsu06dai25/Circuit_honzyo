// 軽量キャンバスチャート（距離軸を共有、ズーム・パン・カーソル同期）

export class ChartGroup {
  constructor() { this.charts = []; this.x0 = 0; this.x1 = 1; this.full = [0, 1]; this.cursor = null; this.onCursor = null; }
  add(c) { this.charts.push(c); c.group = this; return c; }
  setFull(x0, x1) { this.full = [x0, x1]; this.x0 = x0; this.x1 = x1; this.draw(); }
  setRange(x0, x1) {
    const [f0, f1] = this.full;
    const w = Math.max(10, Math.min(f1 - f0, x1 - x0));
    x0 = Math.max(f0, Math.min(f1 - w, x0));
    this.x0 = x0; this.x1 = x0 + w; this.draw();
  }
  setCursor(x, src) { this.cursor = x; this.draw(); if (this.onCursor && src !== 'ext') this.onCursor(x); }
  draw() { for (const c of this.charts) c.draw(); }
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class LineChart {
  constructor(canvas, { title = '', unit = '', height = 160, zeroLine = false, fmt = (v) => v.toFixed(1), yMin = null, yMax = null, symmetric = false } = {}) {
    this.cv = canvas; this.title = title; this.unit = unit; this.height = height; this.zeroLine = zeroLine; this.fmt = fmt;
    this.yMinFix = yMin; this.yMaxFix = yMax; this.symmetric = symmetric;
    this.series = []; this.marks = [];
    this.pad = { l: 42, r: 10, t: 20, b: 18 };
    this.bind();
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  setSeries(series, marks = []) { this.series = series; this.marks = marks; this.draw(); }

  xToPx(x) { const g = this.group; const w = this.w - this.pad.l - this.pad.r; return this.pad.l + (x - g.x0) / (g.x1 - g.x0) * w; }
  pxToX(px) { const g = this.group; const w = this.w - this.pad.l - this.pad.r; return g.x0 + (px - this.pad.l) / w * (g.x1 - g.x0); }

  bind() {
    const cv = this.cv;
    const pts = new Map();
    let pinch = null, drag = null;
    const local = (e) => { const r = cv.getBoundingClientRect(); return e.clientX - r.left; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.abs(a - b), mid: this.pxToX((a + b) / 2), x0: this.group.x0, x1: this.group.x1 };
        drag = null;
      } else {
        drag = { px: local(e), x0: this.group.x0, x1: this.group.x1, moved: false, type: e.pointerType };
        this.group.setCursor(this.pxToX(local(e)));
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) {
        if (e.pointerType === 'mouse') this.group.setCursor(this.pxToX(local(e)));
        return;
      }
      pts.set(e.pointerId, local(e));
      const g = this.group;
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const s = pinch.d / Math.max(10, Math.abs(a - b));
        const w = (pinch.x1 - pinch.x0) * s;
        // 2本指の中点に、つまみ始めのデータ位置が来るように（ズーム + パン）
        const f = ((a + b) / 2 - this.pad.l) / (this.w - this.pad.l - this.pad.r);
        g.setRange(pinch.mid - w * f, pinch.mid + w * (1 - f));
      } else if (drag) {
        const dx = local(e) - drag.px;
        if (Math.abs(dx) > 4) drag.moved = true;
        // 1本指: カーソル移動 / マウス + Shift: パン
        if (e.pointerType === 'mouse' && e.buttons && e.shiftKey) {
          const w = this.w - this.pad.l - this.pad.r;
          const shift = -dx / w * (drag.x1 - drag.x0);
          g.setRange(drag.x0 + shift, drag.x1 + shift);
        } else {
          g.setCursor(this.pxToX(local(e)));
        }
      }
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) drag = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const g = this.group, x = this.pxToX(local(e));
      const s = Math.exp(e.deltaY * 0.0015);
      g.setRange(x - (x - g.x0) * s, x + (g.x1 - x) * s);
    }, { passive: false });
    cv.addEventListener('dblclick', () => { const g = this.group; g.setRange(g.full[0], g.full[1]); });
  }

  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = this.height;
    if (!w || !this.group) return;
    this.w = w;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const g = this.group, P = this.pad;
    const fg = css('--fg') || '#ddd', muted = css('--muted') || '#888', grid = css('--grid') || '#333';
    // y 範囲（表示中の x 範囲だけで決める）
    let lo = Infinity, hi = -Infinity;
    for (const s of this.series) {
      const { x, y } = s;
      for (let i = 0; i < x.length; i++) { if (x[i] < g.x0 || x[i] > g.x1) continue; const v = y[i]; if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (this.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.1); lo = -m; hi = m; }
    if (this.yMinFix !== null) lo = Math.min(lo, this.yMinFix);
    if (this.yMaxFix !== null) hi = Math.max(hi, this.yMaxFix);
    if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
    const padY = (hi - lo) * 0.06; lo -= padY; hi += padY;
    const ph = h - P.t - P.b;
    const yToPx = (v) => P.t + (hi - v) / (hi - lo) * ph;
    // グリッド
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
    const step = niceStep((hi - lo) / 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const y = yToPx(v);
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(w - P.r, y); ctx.stroke();
      ctx.fillText(trimNum(v, step), P.l - 4, y);
    }
    const xs = niceStep((g.x1 - g.x0) / 6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(g.x0 / xs) * xs; v <= g.x1; v += xs) {
      const x = this.xToPx(v);
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, h - P.b); ctx.stroke();
      ctx.fillText(`${Math.round(v)}`, x, h - P.b + 3);
    }
    if (this.zeroLine && lo < 0 && hi > 0) { ctx.strokeStyle = muted; ctx.beginPath(); ctx.moveTo(P.l, yToPx(0)); ctx.lineTo(w - P.r, yToPx(0)); ctx.stroke(); }
    // マーカー（ブレーキ開始・コーナー等）
    const lastLabel = [-1e9, -1e9];
    ctx.font = '10px system-ui, sans-serif';
    for (const m of this.marks.slice().sort((a, b) => a.x - b.x)) {
      if (m.x < g.x0 || m.x > g.x1) continue;
      const x = this.xToPx(m.x);
      ctx.strokeStyle = m.color; ctx.globalAlpha = 0.6; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, h - P.b); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      const row = m.row || 0;
      // ラベルが重なる場合は省略（ズームすると表示される）
      if (m.label && x - lastLabel[row] > 22) {
        ctx.fillStyle = m.color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(m.label, x + 2, P.t + 1 + row * 11);
        lastLabel[row] = x;
      }
    }
    // 系列
    ctx.save();
    ctx.beginPath(); ctx.rect(P.l, P.t, w - P.l - P.r, ph); ctx.clip();
    for (const s of this.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
      if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
      ctx.beginPath();
      let started = false;
      const { x, y } = s;
      // 画素あたり1点程度に間引き
      const visible = []; for (let i = 0; i < x.length; i++) if (x[i] >= g.x0 - 5 && x[i] <= g.x1 + 5) visible.push(i);
      const stride = Math.max(1, Math.floor(visible.length / (w * 1.5)));
      for (let j = 0; j < visible.length; j += stride) {
        const i = visible[j];
        if (!Number.isFinite(y[i])) { started = false; continue; }
        const px = this.xToPx(x[i]), py = yToPx(y[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.setLineDash([]);
    // タイトル
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`${this.title}${this.unit ? ` (${this.unit})` : ''}`, P.l, 3);
    // カーソル
    if (g.cursor !== null && g.cursor >= g.x0 && g.cursor <= g.x1) {
      const x = this.xToPx(g.cursor);
      ctx.strokeStyle = fg; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, h - P.b); ctx.stroke();
      ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'top';
      const labels = this.series.filter(s => s.label).map(s => ({ s, v: valueAt(s.x, s.y, g.cursor) }));
      let tx = w - P.r - 4; ctx.textAlign = 'right';
      for (let i = labels.length - 1; i >= 0; i--) {
        const { s, v } = labels[i];
        const txt = `${s.label} ${Number.isFinite(v) ? this.fmt(v) : '-'}`;
        ctx.fillStyle = s.color; ctx.fillText(txt, tx, 3);
        tx -= ctx.measureText(txt).width + 10;
      }
    }
  }
}

export function valueAt(xs, ys, x) {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0 || x < xs[0] || x > xs[hi]) return NaN;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function trimNum(v, step) { const d = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0; return v.toFixed(d); }

// G-G ダイアグラム（摩擦円）
export function drawGG(canvas, sets, cursorPts = []) {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 280;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); canvas.style.height = size + 'px'; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const fg = css('--fg'), muted = css('--muted'), grid = css('--grid');
  let mx = 1.0;
  for (const s of sets) for (let i = 0; i < s.lat.length; i++) mx = Math.max(mx, Math.abs(s.lat[i]), Math.abs(s.lon[i]));
  mx = Math.ceil(mx * 4) / 4 + 0.1;
  const c = size / 2, r = c - 14;
  const toPx = (lat, lon) => [c + lat / mx * r, c - lon / mx * r];
  ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left';
  for (let g = 0.5; g <= mx; g += 0.5) { ctx.beginPath(); ctx.arc(c, c, g / mx * r, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(`${g.toFixed(1)}G`, c + 2, c - g / mx * r + 10); }
  ctx.beginPath(); ctx.moveTo(c, 4); ctx.lineTo(c, size - 4); ctx.moveTo(4, c); ctx.lineTo(size - 4, c); ctx.stroke();
  ctx.fillStyle = muted; ctx.textAlign = 'center';
  ctx.fillText('加速', c, 10); ctx.fillText('減速', c, size - 4);
  ctx.textAlign = 'left'; ctx.fillText('左', 4, c - 4); ctx.textAlign = 'right'; ctx.fillText('右', size - 4, c - 4);
  for (const s of sets) {
    ctx.fillStyle = s.color;
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < s.lat.length; i += 1) { const [x, y] = toPx(s.lat[i], s.lon[i]); ctx.fillRect(x - 1, y - 1, 2, 2); }
  }
  ctx.globalAlpha = 1;
  for (const p of cursorPts) {
    const [x, y] = toPx(p.lat, p.lon);
    ctx.fillStyle = p.color; ctx.strokeStyle = fg;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}
