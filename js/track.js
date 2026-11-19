// コースモデル: 走行データからコース形状（基準ライン）を作り、
// 各点を「コース上の距離 s」と「基準ラインからの横位置 n（右が＋）」で表す。
// 複数ラップを平均して作るので、1Hz のスマホ GPS でも1周より安定した形になる。
import { gaussianSmooth, interpAt, makeProjection, DEG } from './core.js';

// ---------- 閉じた折れ線の等間隔リサンプル ----------
export function resampleClosed(xs, ys, step = 1) {
  const n = xs.length;
  const cum = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = i - 1, b = i % n;
    cum[i] = cum[i - 1] + Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
  }
  const L = cum[n];
  const N = Math.max(8, Math.round(L / step));
  const st = L / N;
  const X = new Float64Array(N), Y = new Float64Array(N);
  let i = 0;
  for (let j = 0; j < N; j++) {
    const s = j * st;
    while (i < n - 1 && cum[i + 1] < s) i++;
    const seg = cum[i + 1] - cum[i];
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - cum[i]) / seg)) : 0;
    const a = i % n, b = (i + 1) % n;
    X[j] = xs[a] + (xs[b] - xs[a]) * f;
    Y[j] = ys[a] + (ys[b] - ys[a]) * f;
  }
  return { x: X, y: Y, N, step: st, L };
}

// 接線・右法線を付けたモデル
export function makeModel(path) {
  const { x, y, N } = path;
  const tx = new Float64Array(N), ty = new Float64Array(N), nx = new Float64Array(N), ny = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const a = (j - 1 + N) % N, b = (j + 1) % N;
    let dx = x[b] - x[a], dy = y[b] - y[a];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    tx[j] = dx; ty[j] = dy; nx[j] = dy; ny[j] = -dx;
  }
  return { x, y, N, step: path.step, L: path.L, tx, ty, nx, ny, left: new Float64Array(N), right: new Float64Array(N) };
}

// ---------- 投影（コース上の位置 s と横位置 n） ----------
export function makeProjector(m, { behind = 10, ahead = 45, lostDist = 35 } = {}) {
  const { x, y, N } = m;
  let j = -1;
  const seg = (jj, px, py) => {
    const b = (jj + 1) % N;
    const sx = x[b] - x[jj], sy = y[b] - y[jj];
    const l2 = sx * sx + sy * sy || 1e-9;
    let u = ((px - x[jj]) * sx + (py - y[jj]) * sy) / l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = x[jj] + u * sx - px, qy = y[jj] + u * sy - py;
    return [qx * qx + qy * qy, u];
  };
  const search = (px, py, from, count) => {
    let best = 0, bd = Infinity, bu = 0;
    for (let k = 0; k < count; k++) {
      const jj = (((from + k) % N) + N) % N;
      const r = seg(jj, px, py);
      if (r[0] < bd) { bd = r[0]; best = jj; bu = r[1]; }
    }
    return [best, bd, bu];
  };
  return {
    reset() { j = -1; },
    project(px, py) {
      let r;
      if (j < 0) r = search(px, py, 0, N);
      else {
        r = search(px, py, j - behind, behind + ahead + 1);
        if (r[1] > lostDist * lostDist) r = search(px, py, 0, N);
      }
      j = r[0];
      const b = (j + 1) % N;
      const sx = x[b] - x[j], sy = y[b] - y[j];
      const len = Math.hypot(sx, sy) || 1e-9;
      const n = ((px - x[j]) * sy - (py - y[j]) * sx) / len; // 右が＋
      return { s: (j + r[2]) * m.step, n, d: Math.sqrt(r[1]), j };
    },
  };
}

// 連続した点列を投影し、s を周回方向に連続（アンラップ）させる
export function projectSeries(m, xs, ys, opts) {
  const P = makeProjector(m, opts);
  const n = xs.length, L = m.L;
  const S = new Float64Array(n), O = new Float64Array(n), D = new Float64Array(n);
  let prev = null;
  for (let i = 0; i < n; i++) {
    const r = P.project(xs[i], ys[i]);
    let s = r.s;
    if (prev === null) { if (s > L / 2) s -= L; }
    else {
      const pm = ((prev % L) + L) % L;
      let ds = s - pm;
      if (ds < -L / 2) ds += L;
      if (ds > L / 2) ds -= L;
      s = prev + ds;
    }
    S[i] = s; O[i] = r.n; D[i] = r.d; prev = s;
  }
  return { s: S, n: O, d: D };
}

// ラップの点列（10Hz トレースから。始点・終点は S/F 通過位置で補間）
export function lapIndices(lap) {
  const ks = [lap.kStart];
  for (let k = Math.ceil(lap.kStart); k <= Math.floor(lap.kEnd); k++) if (k > lap.kStart + 1e-6 && k < lap.kEnd - 1e-6) ks.push(k);
  ks.push(lap.kEnd);
  return ks;
}
export function lapXY(trace, lap) {
  const ks = lapIndices(lap);
  return { ks, x: Float64Array.from(ks, k => interpAt(trace.x, k)), y: Float64Array.from(ks, k => interpAt(trace.y, k)) };
}

// ラップの横位置をモデルの格子（j=0..N-1）上に並べる。届かない所は NaN
export function offsetsOnGrid(m, xs, ys) {
  const pr = projectSeries(m, xs, ys);
  const out = new Float64Array(m.N).fill(NaN);
  const S = pr.s;
  let mx = -Infinity;
  for (let i = 0; i < S.length; i++) { if (S[i] < mx) S[i] = mx; mx = S[i]; }
  let i = 0;
  for (let j = 0; j < m.N; j++) {
    const s = j * m.step;
    if (s < S[0] || s > S[S.length - 1]) continue;
    while (i < S.length - 2 && S[i + 1] < s) i++;
    const f = (s - S[i]) / ((S[i + 1] - S[i]) || 1);
    out[j] = pr.n[i] + (pr.n[i + 1] - pr.n[i]) * Math.max(0, Math.min(1, f));
  }
  return { off: out, maxDist: Math.max(...pr.d), meanAbs: meanAbs(pr.n) };
}
function meanAbs(a) { let s = 0; for (const v of a) s += Math.abs(v); return s / (a.length || 1); }

function columnStats(offs, N) {
  const mean = new Float64Array(N), mn = new Float64Array(N), mxa = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const vals = [];
    for (const o of offs) if (Number.isFinite(o[j])) vals.push(o[j]);
    if (!vals.length) { mean[j] = NaN; mn[j] = NaN; mxa[j] = NaN; continue; }
    vals.sort((a, b) => a - b);
    const trimmed = vals.length >= 5 ? vals.slice(1, -1) : vals; // 外れ値（大きく外したラップ）の影響を抑える
    mean[j] = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    mn[j] = vals[0]; mxa[j] = vals[vals.length - 1];
  }
  return { mean, min: mn, max: mxa };
}
function fillCircular(a) {
  const N = a.length;
  const first = a.findIndex(Number.isFinite);
  if (first < 0) { a.fill(0); return a; }
  let last = a[first];
  for (let q = 1; q <= N; q++) { const j = (first + q) % N; if (Number.isFinite(a[j])) last = a[j]; else a[j] = last; }
  return a;
}

// ---------- モデル作成 ----------
// laps: detectLaps の結果（valid / flags を見る）
export function goodLaps(laps) { return laps.filter(l => l.valid && !l.flags.includes('slow')); }

export function buildModel(trace, laps, { iterations = 3 } = {}) {
  const good = goodLaps(laps);
  if (!good.length) return null;
  const ref = good.reduce((a, b) => (b.time < a.time ? b : a));
  const pts = lapXY(trace, ref);
  let m = makeModel(resampleClosed(pts.x, pts.y, 1));
  const lapPts = good.map(l => lapXY(trace, l));
  for (let it = 0; it < iterations && good.length > 1; it++) {
    const offs = lapPts.map(p => offsetsOnGrid(m, p.x, p.y).off);
    const st = columnStats(offs, m.N);
    const sm = gaussianSmooth(fillCircular(st.mean), 4 / m.step, { circular: true });
    const X = new Float64Array(m.N), Y = new Float64Array(m.N);
    for (let j = 0; j < m.N; j++) { X[j] = m.x[j] + sm[j] * m.nx[j]; Y[j] = m.y[j] + sm[j] * m.ny[j]; }
    m = makeModel(resampleClosed(X, Y, 1));
  }
  // ごく弱く平滑化して GPS の細かいノイズを除く
  {
    const X = gaussianSmooth(m.x, 1.5 / m.step, { circular: true }), Y = gaussianSmooth(m.y, 1.5 / m.step, { circular: true });
    m = makeModel(resampleClosed(X, Y, 1));
  }
  setEnvelope(m, lapPts.map(p => offsetsOnGrid(m, p.x, p.y).off));
  m.lapsUsed = good.length;
  m.refSpeed = speedOnGrid(m, trace, ref);
  return m;
}

function setEnvelope(m, offs) {
  const st = columnStats(offs, m.N);
  m.left = gaussianSmooth(fillCircular(st.min), 2 / m.step, { circular: true });
  m.right = gaussianSmooth(fillCircular(st.max), 2 / m.step, { circular: true });
}

// 最速ラップの速度を格子上に（コーナーの頂点検出用）
export function speedOnGrid(m, trace, lap) {
  const p = lapXY(trace, lap);
  const pr = projectSeries(m, p.x, p.y);
  const v = Float64Array.from(p.ks, k => interpAt(trace.v, k));
  const out = new Float64Array(m.N).fill(NaN);
  let i = 0, mx = -Infinity;
  const S = pr.s; for (let q = 0; q < S.length; q++) { if (S[q] < mx) S[q] = mx; mx = S[q]; }
  for (let j = 0; j < m.N; j++) {
    const s = j * m.step;
    if (s < S[0] || s > S[S.length - 1]) continue;
    while (i < S.length - 2 && S[i + 1] < s) i++;
    const f = (s - S[i]) / ((S[i + 1] - S[i]) || 1);
    out[j] = v[i] + (v[i + 1] - v[i]) * Math.max(0, Math.min(1, f));
  }
  return fillCircular(out);
}

// 既存モデルに別セッションのラップを統合（重み付き平均）
export function mergeModel(m, trace, laps, { maxWeight = 0.5 } = {}) {
  const good = goodLaps(laps);
  const lapPts = good.map(l => lapXY(trace, l));
  const res = lapPts.map(p => offsetsOnGrid(m, p.x, p.y));
  const ok = res.filter(r => r.maxDist < 25 && r.meanAbs < 6);
  if (ok.length < 2) return null;
  const offs = ok.map(r => r.off);
  const st = columnStats(offs, m.N);
  const w = Math.min(maxWeight, ok.length / ((m.lapsUsed || 1) + ok.length));
  const sm = gaussianSmooth(fillCircular(st.mean), 4 / m.step, { circular: true });
  const X = new Float64Array(m.N), Y = new Float64Array(m.N);
  for (let j = 0; j < m.N; j++) { X[j] = m.x[j] + w * sm[j] * m.nx[j]; Y[j] = m.y[j] + w * sm[j] * m.ny[j]; }
  const m2 = makeModel(resampleClosed(X, Y, 1));
  // 走行範囲 = 旧範囲（移動分を補正）と新ラップの和集合
  const newOffs = ok.map((r, i) => offsetsOnGrid(m2, lapPts[res.indexOf(r)].x, lapPts[res.indexOf(r)].y).off);
  const st2 = columnStats(newOffs, m2.N);
  const left = new Float64Array(m2.N), right = new Float64Array(m2.N);
  for (let j = 0; j < m2.N; j++) {
    const f = j / m2.N * m.N;
    const shift = w * interpAt(sm, Math.min(m.N - 1, f));
    const oL = interpAt(m.left, Math.min(m.N - 1, f)) - shift, oR = interpAt(m.right, Math.min(m.N - 1, f)) - shift;
    left[j] = Number.isFinite(st2.min[j]) ? Math.min(oL, st2.min[j]) : oL;
    right[j] = Number.isFinite(st2.max[j]) ? Math.max(oR, st2.max[j]) : oR;
  }
  m2.left = gaussianSmooth(left, 2 / m2.step, { circular: true });
  m2.right = gaussianSmooth(right, 2 / m2.step, { circular: true });
  m2.lapsUsed = (m.lapsUsed || 0) + ok.length;
  const best = good.reduce((a, b) => (b.time < a.time ? b : a));
  m2.refSpeed = m.refSpeed && m.refBest !== undefined && m.refBest < best.time ? resampleArr(m.refSpeed, m2.N) : speedOnGrid(m2, trace, best);
  m2.refBest = Math.min(m.refBest ?? Infinity, best.time);
  return m2;
}
function resampleArr(a, N) { const out = new Float64Array(N); for (let j = 0; j < N; j++) out[j] = interpAt(a, Math.min(a.length - 1, j / N * a.length)); return out; }

// 別の日のデータは GPS 全体が数 m ずれていることがある。
// 横位置の残差を平行移動で最小二乗フィットしてずれを推定する（ライン取りの違いは周回で相殺される）
export function estimateShift(m, trace, laps) {
  const good = goodLaps(laps);
  if (!good.length) return null;
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, cnt = 0;
  for (const l of good) {
    const p = lapXY(trace, l);
    const pr = projectSeries(m, p.x, p.y);
    for (let i = 0; i < pr.s.length; i += 2) {
      if (pr.d[i] > 20) continue;
      const j = Math.floor((((pr.s[i] % m.L) + m.L) % m.L) / m.step) % m.N;
      const nx = m.nx[j], ny = m.ny[j], r = pr.n[i];
      a11 += nx * nx; a12 += nx * ny; a22 += ny * ny; b1 += nx * r; b2 += ny * r; cnt++;
    }
  }
  const det = a11 * a22 - a12 * a12;
  if (cnt < 50 || Math.abs(det) < 1e-6) return null;
  const bx = (a22 * b1 - a12 * b2) / det, by = (a11 * b2 - a12 * b1) / det;
  return { dx: -bx, dy: -by, mag: Math.hypot(bx, by) };
}

// ---------- 保存形式 ----------
export function serializeModel(m, proj, extra = {}) {
  const pts = [];
  for (let j = 0; j < m.N; j++) { const [la, lo] = proj.toLatLon(m.x[j], m.y[j]); pts.push([+la.toFixed(7), +lo.toFixed(7)]); }
  return {
    v: 2, pts,
    left: Array.from(m.left, v => +v.toFixed(2)), right: Array.from(m.right, v => +v.toFixed(2)),
    refSpeed: m.refSpeed ? Array.from(m.refSpeed, v => +v.toFixed(2)) : null,
    refBest: m.refBest ?? null,
    length: +m.L.toFixed(1), lapsUsed: m.lapsUsed || 0, updatedAt: Date.now(),
    ...extra,
  };
}
export function loadModel(stored, proj) {
  const N = stored.pts.length;
  const x = new Float64Array(N), y = new Float64Array(N);
  for (let j = 0; j < N; j++) { const [px, py] = proj.toXY(stored.pts[j][0], stored.pts[j][1]); x[j] = px; y[j] = py; }
  let L = 0;
  for (let j = 0; j < N; j++) { const b = (j + 1) % N; L += Math.hypot(x[b] - x[j], y[b] - y[j]); }
  const m = makeModel({ x, y, N, step: L / N, L });
  m.left = Float64Array.from(stored.left || new Array(N).fill(0));
  m.right = Float64Array.from(stored.right || new Array(N).fill(0));
  m.refSpeed = stored.refSpeed ? Float64Array.from(stored.refSpeed) : null;
  m.refBest = stored.refBest ?? undefined;
  m.lapsUsed = stored.lapsUsed || 0;
  return m;
}
// S/F ラインが変わったときに s=0 の位置を移す
export function rotateModel(m, s0) {
  const N = m.N, sh = Math.round(s0 / m.step);
  const rot = (a) => { if (!a) return a; const out = new Float64Array(N); for (let j = 0; j < N; j++) out[j] = a[(j + sh + N) % N]; return out; };
  const m2 = makeModel({ x: rot(m.x), y: rot(m.y), N, step: m.step, L: m.L });
  m2.left = rot(m.left); m2.right = rot(m.right); m2.refSpeed = rot(m.refSpeed); m2.lapsUsed = m.lapsUsed; m2.refBest = m.refBest;
  return m2;
}
// 線分（S/F ライン）とモデルの交点の s
export function lineOnModel(m, a, b) {
  for (let j = 0; j < m.N; j++) {
    const k = (j + 1) % m.N;
    const r = [m.x[k] - m.x[j], m.y[k] - m.y[j]], s = [b[0] - a[0], b[1] - a[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) continue;
    const qp = [a[0] - m.x[j], a[1] - m.y[j]];
    const u = (qp[0] * s[1] - qp[1] * s[0]) / den, w = (qp[0] * r[1] - qp[1] * r[0]) / den;
    if (u >= 0 && u <= 1 && w >= 0 && w <= 1) return (j + u) * m.step;
  }
  return null;
}

// ---------- コーナー検出 ----------
export function detectCorners(m, { enter = 1 / 70, exit = 1 / 150, minAngle = 20, mergeGap = 10 } = {}) {
  const N = m.N, st = m.step;
  const k = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const a = (j - 1 + N) % N, b = (j + 1) % N;
    let d = Math.atan2(m.tx[b], m.ty[b]) - Math.atan2(m.tx[a], m.ty[a]);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    k[j] = d / (2 * st); // 右旋回が＋
  }
  const ks = gaussianSmooth(k, 4 / st, { circular: true });
  // 直線部分から走査を始める（S/F をまたぐコーナーを分断しない）
  let j0 = 0, mn = Infinity;
  for (let j = 0; j < N; j++) if (Math.abs(ks[j]) < mn) { mn = Math.abs(ks[j]); j0 = j; }
  const regs = [];
  let cur = null;
  for (let q = 0; q < N; q++) {
    const j = (j0 + q) % N, v = ks[j], sg = Math.sign(v);
    if (!cur) { if (Math.abs(v) > enter) cur = { q0: q, q1: q, sign: sg }; continue; }
    if (Math.abs(v) < exit || sg !== cur.sign) {
      regs.push(cur); cur = null;
      if (Math.abs(v) > enter) cur = { q0: q, q1: q, sign: sg };
    } else cur.q1 = q;
  }
  if (cur) regs.push(cur);
  const merged = [];
  for (const r of regs) {
    const p = merged[merged.length - 1];
    if (p && p.sign === r.sign && (r.q0 - p.q1) * st < mergeGap) p.q1 = r.q1; else merged.push({ ...r });
  }
  const out = [];
  for (const r of merged) {
    let ang = 0, peak = 0;
    for (let q = r.q0; q <= r.q1; q++) { const v = ks[(j0 + q) % N]; ang += v * st; peak = Math.max(peak, Math.abs(v)); }
    if (Math.abs(ang) < minAngle * DEG) continue;
    // 頂点: 基準ラップの最低速度地点（なければ曲率最大）
    let qa = r.q0, best = Infinity;
    const pad = Math.round(15 / st);
    for (let q = r.q0 - pad; q <= r.q1 + pad; q++) {
      const j = ((j0 + q) % N + N) % N;
      const score = m.refSpeed ? m.refSpeed[j] : -Math.abs(ks[j]);
      if (score < best) { best = score; qa = q; }
    }
    const s0 = (((j0 + r.q0) % N) + N) % N * st;
    const len = (r.q1 - r.q0) * st;
    let sApex = ((((j0 + qa) % N) + N) % N) * st;
    if (sApex < s0 - 20) sApex += m.L;
    const deg = Math.abs(ang) / DEG;
    out.push({ s0, s1: s0 + len, sApex, dir: r.sign > 0 ? 'R' : 'L', angle: Math.round(deg), radius: Math.round(1 / peak), type: deg >= 130 ? 'ヘアピン' : deg >= 60 ? 'コーナー' : '高速コーナー' });
  }
  out.sort((a, b) => a.s0 - b.s0);
  out.forEach((c, i) => { c.id = i; c.name = `T${i + 1}`; });
  return out;
}

// 旧コーナー名を新しい検出結果に引き継ぐ（頂点位置が近いものどうし）
export function transferCornerNames(oldC, newC, L) {
  if (!oldC || !oldC.length) return newC;
  const cd = (a, b) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d); };
  for (const c of newC) {
    let best = null, bd = 30;
    for (const o of oldC) { const d = cd(o.sApex, c.sApex); if (d < bd) { bd = d; best = o; } }
    if (best && best.custom) { c.name = best.name; c.custom = true; }
  }
  return newC;
}

// 区間（コーナーごと）: 直線の中点で区切る
export function segmentBounds(corners, L) {
  const b = [0];
  for (let k = 1; k < corners.length; k++) b.push((corners[k - 1].s1 + corners[k].s0) / 2);
  b.push(L);
  return b;
}

// ---------- 計測中の予測ラップ ----------
// モデル（またはその場で作った暫定経路）に GPS 点を投影して、基準ラップとの差をリアルタイムに出す
export function makeLivePath(stored, centerLat, centerLon) {
  const proj = makeProjection(centerLat, centerLon);
  const m = loadModel(stored, proj);
  return { proj, m };
}
export function provisionalPath(xs, ys, step = 2) {
  return makeModel(resampleClosed(xs, ys, step));
}
// 基準ラップの t(s) を step m 刻みで
export function refFromSeries(sArr, tArr, L, lapTime, step = 2) {
  const n = Math.floor(L / step) + 1;
  const out = new Array(n);
  let i = 0;
  for (let g = 0; g < n; g++) {
    const s = g * step;
    while (i < sArr.length - 2 && sArr[i + 1] < s) i++;
    const f = (s - sArr[i]) / ((sArr[i + 1] - sArr[i]) || 1);
    out[g] = +(tArr[i] + (tArr[i + 1] - tArr[i]) * Math.max(0, Math.min(1, f))).toFixed(3);
  }
  out[0] = 0; out[n - 1] = +lapTime.toFixed(3);
  return { step, t: out, L, time: lapTime };
}
export function refTimeAt(ref, s) {
  if (!ref) return NaN;
  const g = s / ref.step;
  if (g <= 0) return 0;
  if (g >= ref.t.length - 1) return ref.t[ref.t.length - 1];
  return interpAt(ref.t, g);
}
