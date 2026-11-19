// キャンバスのグラフ（距離軸を共有・ズーム・カーソル同期）、ラップタイム棒グラフ、G-G ダイアグラム
import { cssVar } from './util.js';

export class ChartGroup {
  constructor() { this.charts = []; this.x0 = 0; this.x1 = 1; this.full = [0, 1]; this.cursor = null; this.listeners = []; }
  add(c) { this.charts.push(c); c.group = this; return c; }
  onCursor(fn) { this.listeners.push(fn); }
  setFull(x0, x1) { this.full = [x0, x1]; this.x0 = x0; this.x1 = x1; this.draw(); }
  setRange(x0, x1) {
    const [f0, f1] = this.full;
    const w = Math.max(20, Math.min(f1 - f0, x1 - x0));
    x0 = Math.max(f0, Math.min(f1 - w, x0));
    this.x0 = x0; this.x1 = x0 + w; this.draw();
  }
  zoom(f, c = this.cursor ?? (this.x0 + this.x1) / 2) { this.setRange(c - (c - this.x0) * f, c + (this.x1 - c) * f); }
  focus(a, b, pad = 40) { this.setRange(a - pad, b + pad); }
  setCursor(x, src = 'chart') { this.cursor = x; this.draw(); for (const fn of this.listeners) fn(x, src); }
  draw() { for (const c of this.charts) c.draw(); }
}

const valueAt = (xs, ys, x) => {
  const n = xs.length;
  if (!n || x < xs[0] || x > xs[n - 1]) return NaN;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]) / ((xs[hi] - xs[lo]) || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
};
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
function trimNum(v, step) { const d = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0; return v.toFixed(d); }

export class LineChart {
  constructor(canvas, { title = '', unit = '', height = 160, zeroLine = false, symmetric = false, fmt = (v) => v.toFixed(1), minSpan = 0 } = {}) {
    Object.assign(this, { cv: canvas, title, unit, height, zeroLine, symmetric, fmt, minSpan });
    this.series = []; this.bands = []; this.marks = []; this.envelope = null;
    this.pad = { l: 40, r: 8, t: 22, b: 18 };
    this.bind();
    if ('ResizeObserver' in window) new ResizeObserver(() => this.draw()).observe(canvas);
  }
  setData({ series = [], bands = [], marks = [], envelope = null } = {}) { Object.assign(this, { series, bands, marks, envelope }); this.draw(); }
  plotW() { return this.w - this.pad.l - this.pad.r; }
  xToPx(x) { const g = this.group; return this.pad.l + (x - g.x0) / (g.x1 - g.x0) * this.plotW(); }
  pxToX(px) { const g = this.group; return g.x0 + (px - this.pad.l) / this.plotW() * (g.x1 - g.x0); }

  bind() {
    const cv = this.cv, pts = new Map();
    let pinch = null;
    const local = (e) => e.clientX - cv.getBoundingClientRect().left;
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pts.set(e.pointerId, local(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.abs(a - b), mid: this.pxToX((a + b) / 2), x0: this.group.x0, x1: this.group.x1 };
      } else this.group.setCursor(this.pxToX(local(e)));
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) { if (e.pointerType === 'mouse') this.group.setCursor(this.pxToX(local(e))); return; }
      pts.set(e.pointerId, local(e));
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const w = (pinch.x1 - pinch.x0) * pinch.d / Math.max(10, Math.abs(a - b));
        const f = ((a + b) / 2 - this.pad.l) / this.plotW();
        this.group.setRange(pinch.mid - w * f, pinch.mid + w * (1 - f));
      } else this.group.setCursor(this.pxToX(local(e)));
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const g = this.group, x = this.pxToX(local(e));
      g.zoom(Math.exp(e.deltaY * 0.0015), x);
    }, { passive: false });
    cv.addEventListener('dblclick', () => { const g = this.group; g.setRange(g.full[0], g.full[1]); });
  }

  draw() {
    const cv = this.cv, g = this.group;
    if (!g || !cv.isConnected) return;
    const w = cv.clientWidth, h = this.height;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = w;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const P = this.pad, ph = h - P.t - P.b;
    const fg = cssVar('--fg'), muted = cssVar('--muted'), grid = cssVar('--grid'), panel2 = cssVar('--panel2');
    // y 範囲（表示中の範囲だけで決める）
    let lo = Infinity, hi = -Infinity;
    const scan = (xs, ys) => { for (let i = 0; i < xs.length; i++) { if (xs[i] < g.x0 || xs[i] > g.x1) continue; const v = ys[i]; if (!Number.isFinite(v)) continue; if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (const s of this.series) scan(s.x, s.y);
    if (this.envelope) { scan(this.envelope.x, this.envelope.lo); scan(this.envelope.x, this.envelope.hi); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (this.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi), 0.1); lo = -m; hi = m; }
    if (hi - lo < this.minSpan) { const c = (hi + lo) / 2; lo = c - this.minSpan / 2; hi = c + this.minSpan / 2; }
    if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
    const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
    const yToPx = (v) => P.t + (hi - v) / (hi - lo) * ph;
    // コーナー区間の帯
    ctx.font = '600 10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (const b of this.bands) {
      if (b.x1 < g.x0 || b.x0 > g.x1) continue;
      const x0 = Math.max(P.l, this.xToPx(b.x0)), x1 = Math.min(w - P.r, this.xToPx(b.x1));
      ctx.fillStyle = panel2; ctx.fillRect(x0, P.t, x1 - x0, ph);
      if (b.label) { const txt = x1 - x0 > ctx.measureText(b.label).width + 4 ? b.label : b.label.replace(/^T/, ''); if (x1 - x0 > ctx.measureText(txt).width + 2) { ctx.fillStyle = muted; ctx.fillText(txt, (x0 + x1) / 2, P.t + 2); } }
    }
    // グリッド
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
    const ys = niceStep((hi - lo) / 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
      const y = Math.round(yToPx(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(w - P.r, y); ctx.stroke();
      ctx.fillText(trimNum(v, ys), P.l - 5, y);
    }
    const xs = niceStep((g.x1 - g.x0) / Math.max(3, Math.floor(w / 80)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = Math.ceil(g.x0 / xs) * xs; v <= g.x1; v += xs) {
      const x = Math.round(this.xToPx(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, h - P.b); ctx.stroke();
      ctx.fillText(`${Math.round(v)}`, x, h - P.b + 3);
    }
    if (this.zeroLine && lo < 0 && hi > 0) { ctx.strokeStyle = muted; ctx.beginPath(); ctx.moveTo(P.l, Math.round(yToPx(0)) + 0.5); ctx.lineTo(w - P.r, Math.round(yToPx(0)) + 0.5); ctx.stroke(); }
    ctx.save();
    ctx.beginPath(); ctx.rect(P.l, P.t, w - P.l - P.r, ph); ctx.clip();
    // 走行範囲（包絡）
    if (this.envelope) {
      const E = this.envelope;
      ctx.fillStyle = E.color;
      ctx.beginPath();
      let first = true;
      for (let i = 0; i < E.x.length; i += 2) { const px = this.xToPx(E.x[i]), py = yToPx(E.hi[i]); if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py); }
      for (let i = E.x.length - 1; i >= 0; i -= 2) ctx.lineTo(this.xToPx(E.x[i]), yToPx(E.lo[i]));
      ctx.closePath(); ctx.fill();
    }
    // マーカー
    for (const m of this.marks) {
      if (m.x < g.x0 || m.x > g.x1) continue;
      const x = Math.round(this.xToPx(m.x)) + 0.5;
      ctx.strokeStyle = m.color; ctx.globalAlpha = 0.7; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, P.t + 12); ctx.lineTo(x, h - P.b); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // 系列
    for (const s of this.series) {
      const { x, y } = s;
      const vis = [];
      for (let i = 0; i < x.length; i++) if (x[i] >= g.x0 - 5 && x[i] <= g.x1 + 5) vis.push(i);
      const stride = Math.max(1, Math.floor(vis.length / (w * 1.5)));
      if (s.fill) { // 0 を基準に塗る（タイム差: 遅れ=赤, 速い=緑）
        const y0 = yToPx(0);
        for (const [sign, color] of [[1, s.fill.pos], [-1, s.fill.neg]]) {
          ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(this.xToPx(x[vis[0]] ?? 0), y0);
          for (let j = 0; j < vis.length; j += stride) { const i = vis[j]; const v = sign > 0 ? Math.max(0, y[i]) : Math.min(0, y[i]); ctx.lineTo(this.xToPx(x[i]), yToPx(v)); }
          ctx.lineTo(this.xToPx(x[vis[vis.length - 1]] ?? 0), y0); ctx.closePath(); ctx.fill();
        }
      }
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.7; ctx.lineJoin = 'round';
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let started = false;
      for (let j = 0; j < vis.length; j += stride) {
        const i = vis[j];
        if (!Number.isFinite(y[i])) { started = false; continue; }
        const px = this.xToPx(x[i]), py = yToPx(y[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    // マーカーのラベル
    ctx.font = '700 10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    let lastX = -1e9;
    for (const m of this.marks.slice().sort((a, b) => a.x - b.x)) {
      if (m.x < g.x0 || m.x > g.x1 || !m.label) continue;
      const x = this.xToPx(m.x);
      if (x - lastX < 26) continue;
      ctx.fillStyle = m.color; ctx.fillText(m.label, x + 2, P.t + 1); lastX = x;
    }
    // タイトル
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = '700 12px system-ui, sans-serif';
    const tt = `${this.title}${this.unit ? ` [${this.unit}]` : ''}`;
    ctx.fillText(tt, P.l, 4);
    // カーソル
    if (g.cursor !== null && g.cursor >= g.x0 && g.cursor <= g.x1) {
      const x = Math.round(this.xToPx(g.cursor)) + 0.5;
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.65; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, h - P.b); ctx.stroke(); ctx.globalAlpha = 1;
      let tx = w - P.r - 2;
      ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'right';
      for (let i = this.series.length - 1; i >= 0; i--) {
        const s = this.series[i];
        const v = valueAt(s.x, s.y, g.cursor);
        if (!Number.isFinite(v)) continue;
        const py = yToPx(v);
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, py, 3.2, 0, Math.PI * 2); ctx.fill();
        if (s.label !== undefined) { const txt = `${s.label ? s.label + ' ' : ''}${this.fmt(v)}`; ctx.fillText(txt, tx, 4); tx -= ctx.measureText(txt).width + 10; }
      }
    }
  }
}

// ラップタイムの棒グラフ（タップで選択）
export class LapBars {
  constructor(canvas, { height = 170, onSelect } = {}) {
    Object.assign(this, { cv: canvas, height, onSelect, laps: [], ref: null, cmp: null, theoretical: null });
    canvas.addEventListener('click', (e) => {
      const x = e.clientX - canvas.getBoundingClientRect().left;
      const i = Math.floor((x - this.l) / this.bw);
      if (i >= 0 && i < this.laps.length && this.onSelect) this.onSelect(this.laps[i]);
    });
    if ('ResizeObserver' in window) new ResizeObserver(() => this.draw()).observe(canvas);
  }
  setData({ laps, ref, cmp, theoretical, best }) { Object.assign(this, { laps, ref, cmp, theoretical, best }); this.draw(); }
  draw() {
    const cv = this.cv, w = cv.clientWidth, h = this.height;
    if (!w || !this.laps.length) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const valid = this.laps.filter(l => l.valid);
    const times = (valid.length ? valid : this.laps).map(l => l.time);
    let lo = Math.min(...times, this.theoretical ?? Infinity), hi = Math.max(...times);
    hi = Math.min(hi, lo * 1.12); // 遅すぎるラップは上限で切る
    const span = Math.max(0.5, hi - lo);
    lo -= span * 0.25; hi += span * 0.08;
    this.l = 34; const r = 6, t = 10, b = 20;
    const n = this.laps.length;
    this.bw = (w - this.l - r) / n;
    const yOf = (v) => t + (hi - Math.min(v, hi)) / (hi - lo) * (h - t - b);
    const muted = cssVar('--muted'), grid = cssVar('--grid');
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const step = niceStep((hi - lo) / 3);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { const y = Math.round(yOf(v)) + .5; ctx.beginPath(); ctx.moveTo(this.l, y); ctx.lineTo(w - r, y); ctx.stroke(); ctx.fillText(v.toFixed(step < 1 ? 1 : 0), this.l - 4, y); }
    this.laps.forEach((l, i) => {
      const x = this.l + i * this.bw + this.bw * 0.15, bw = this.bw * 0.7;
      const y = yOf(l.time);
      ctx.fillStyle = !l.valid ? cssVar('--line') : l === this.best ? cssVar('--purple') : l === this.ref ? cssVar('--ref') : l === this.cmp ? cssVar('--cmp') : cssVar('--fg2');
      ctx.globalAlpha = l.valid ? (l === this.ref || l === this.cmp || l === this.best ? 1 : 0.45) : 0.8;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, bw, h - b - y, [4, 4, 0, 0]) : ctx.rect(x, y, bw, h - b - y); ctx.fill();
      ctx.globalAlpha = 1;
      if (this.bw > 14 || i % Math.ceil(14 / this.bw) === 0) { ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(String(l.no), x + bw / 2, h - b + 4); }
      if (l === this.ref || l === this.cmp) { ctx.fillStyle = l === this.ref ? cssVar('--ref') : cssVar('--cmp'); ctx.fillRect(x, h - b, bw, 3); }
    });
    if (this.theoretical) {
      const y = Math.round(yOf(this.theoretical)) + 0.5;
      ctx.strokeStyle = cssVar('--purple'); ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(this.l, y); ctx.lineTo(w - r, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--purple'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.font = '600 11px system-ui, sans-serif'; ctx.fillText('理論ベスト', w - r - 2, y - 2);
    }
  }
}

// G-G ダイアグラム（摩擦円）
export function drawGG(canvas, sets, { gripMax = null, cursor = [] } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 300;
  if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr); canvas.style.height = size + 'px'; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const fg = cssVar('--fg'), muted = cssVar('--muted'), grid = cssVar('--grid');
  let mx = 1.0;
  for (const s of sets) for (let i = 0; i < s.lat.length; i++) mx = Math.max(mx, Math.abs(s.lat[i]), Math.abs(s.lon[i]));
  mx = Math.min(2.5, Math.ceil(mx * 4) / 4 + 0.1);
  const c = size / 2, r = c - 18;
  const toPx = (la, lo) => [c + la / mx * r, c - lo / mx * r];
  ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 1;
  for (let g = 0.5; g <= mx + 1e-9; g += 0.5) { ctx.beginPath(); ctx.arc(c, c, g / mx * r, 0, Math.PI * 2); ctx.stroke(); ctx.fillText(`${g.toFixed(1)}G`, c + 3, c - g / mx * r + 11); }
  ctx.beginPath(); ctx.moveTo(c, 6); ctx.lineTo(c, size - 6); ctx.moveTo(6, c); ctx.lineTo(size - 6, c); ctx.stroke();
  if (gripMax) { ctx.strokeStyle = cssVar('--purple'); ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(c, c, gripMax / mx * r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
  ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText('加速', c, 14); ctx.fillText('ブレーキ', c, size - 6);
  ctx.textAlign = 'left'; ctx.fillText('左', 6, c - 6); ctx.textAlign = 'right'; ctx.fillText('右', size - 6, c - 6);
  for (const s of sets) {
    ctx.fillStyle = s.color; ctx.globalAlpha = s.alpha ?? 0.4;
    for (let i = 0; i < s.lat.length; i += s.stride || 1) { const [x, y] = toPx(s.lat[i], s.lon[i]); ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4); }
  }
  ctx.globalAlpha = 1;
  for (const p of cursor) {
    const [x, y] = toPx(p.lat, p.lon);
    ctx.fillStyle = p.color; ctx.strokeStyle = fg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}
