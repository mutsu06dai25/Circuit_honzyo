// 走行データ解析コア（ブラウザ / Node 共通の純粋関数）
// 座標系: 局所平面 ENU（x=東, y=北, 単位 m）

export const G = 9.80665;
const R_EARTH = 6378137;
const DEG = Math.PI / 180;

// ---------- 座標変換 ----------
export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * DEG) * R_EARTH * DEG;
  const ky = R_EARTH * DEG;
  return {
    lat0, lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- 数値処理 ----------
export function gaussianSmooth(arr, sigmaSamples) {
  const n = arr.length;
  if (sigmaSamples < 0.5 || n < 3) return Float64Array.from(arr);
  const r = Math.ceil(sigmaSamples * 3);
  const w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const v = arr[j];
      if (!Number.isFinite(v)) continue;
      s += v * w[k + r]; ws += w[k + r];
    }
    out[i] = ws > 0 ? s / ws : NaN;
  }
  return out;
}

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

// 時刻列 ts に対して値列 vs を補間する（ソート済み前提）。
function lowerIndex(ts, t, hint = 0) {
  let i = Math.max(0, Math.min(hint, ts.length - 2));
  while (i < ts.length - 2 && ts[i + 1] <= t) i++;
  while (i > 0 && ts[i] > t) i--;
  return i;
}

export function interpLinear(xs, ys, x) {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

function unwrapAngles(a) {
  const out = new Float64Array(a.length);
  if (!a.length) return out;
  out[0] = a[0];
  for (let i = 1; i < a.length; i++) {
    let d = a[i] - a[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out[i] = out[i - 1] + d;
  }
  return out;
}

function median(arr) {
  const a = arr.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  return a[Math.floor(a.length / 2)];
}

// ---------- サンプル整形 ----------
// sample: { t: epoch ms, lat, lon, alt?, acc?, spd?(m/s), hdg?(deg) }
export function cleanSamples(samples, { maxAcc = 30 } = {}) {
  const s = samples
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t))
    .filter(p => !(Number.isFinite(p.acc) && p.acc > maxAcc))
    .slice()
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of s) {
    const prev = out[out.length - 1];
    if (prev && p.t - prev.t < 20) continue; // 重複
    if (prev) {
      // 物理的にあり得ない跳び（>120 m/s）は捨てる
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      if (d / ((p.t - prev.t) / 1000) > 120) continue;
    }
    out.push(p);
  }
  return out;
}

export function sourceRateHz(samples) {
  if (samples.length < 3) return 1;
  const dts = [];
  for (let i = 1; i < samples.length; i++) dts.push((samples[i].t - samples[i - 1].t) / 1000);
  const m = median(dts);
  return m > 0 ? 1 / m : 1;
}

// ---------- メイン処理: 10Hz の解析トレースを作る ----------
export function processSession(session, opts = {}) {
  const dt = opts.dt ?? 0.1;
  const samples = cleanSamples(session.samples || []);
  if (samples.length < 5) return null;
  const lat0 = median(samples.map(s => s.lat));
  const lon0 = median(samples.map(s => s.lon));
  const proj = makeProjection(lat0, lon0);
  const t0 = samples[0].t;
  const ts = samples.map(s => (s.t - t0) / 1000);
  const xs = [], ys = [];
  for (const s of samples) { const [x, y] = proj.toXY(s.lat, s.lon); xs.push(x); ys.push(y); }
  const n = samples.length;

  // 速度: ドップラー速度が十分あれば優先
  const spdCount = samples.filter(s => Number.isFinite(s.spd) && s.spd >= 0).length;
  const useDoppler = spdCount > n * 0.8;
  const vs = new Array(n);
  for (let i = 0; i < n; i++) {
    if (useDoppler && Number.isFinite(samples[i].spd) && samples[i].spd >= 0) { vs[i] = samples[i].spd; continue; }
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const d = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]);
    vs[i] = d / Math.max(1e-3, ts[b] - ts[a]);
  }
  if (useDoppler) { // 欠損を補完
    for (let i = 0; i < n; i++) if (!(Number.isFinite(vs[i]))) vs[i] = i ? vs[i - 1] : 0;
  }

  const rate = sourceRateHz(samples);
  const tEnd = ts[n - 1];
  const m = Math.floor(tEnd / dt) + 1;
  const T = new Float64Array(m), X = new Float64Array(m), Y = new Float64Array(m), V = new Float64Array(m);
  const GAP = new Uint8Array(m);
  let hint = 0;
  for (let k = 0; k < m; k++) {
    const t = k * dt;
    const i = lowerIndex(ts, t, hint); hint = i;
    const i0 = Math.max(0, i - 1), i2 = Math.min(n - 1, i + 1), i3 = Math.min(n - 1, i + 2);
    const span = ts[i2] - ts[i];
    const u = span > 0 ? Math.min(1, Math.max(0, (t - ts[i]) / span)) : 0;
    T[k] = t;
    if (span > 3) { // データ欠落: 線形補間して印を付ける
      X[k] = xs[i] + (xs[i2] - xs[i]) * u;
      Y[k] = ys[i] + (ys[i2] - ys[i]) * u;
      V[k] = vs[i] + (vs[i2] - vs[i]) * u;
      GAP[k] = 1;
    } else {
      X[k] = catmull(xs[i0], xs[i], xs[i2], xs[i3], u);
      Y[k] = catmull(ys[i0], ys[i], ys[i2], ys[i3], u);
      V[k] = Math.max(0, catmull(vs[i0], vs[i], vs[i2], vs[i3], u));
    }
  }

  // 平滑化（低レートほど強め）
  const srcDt = 1 / rate;
  const sigPos = Math.max(0.15, 0.35 * srcDt) / dt;
  const sigV = Math.max(0.2, 0.45 * srcDt) / dt;
  const Xs = gaussianSmooth(X, sigPos), Ys = gaussianSmooth(Y, sigPos), Vs = gaussianSmooth(V, sigV);

  // 方位とヨーレート: 端末のドップラー方位があれば優先（位置差分より格段に低ノイズ）
  const hdgCount = samples.filter(s => Number.isFinite(s.hdg) && Number.isFinite(s.spd) && s.spd > 3).length;
  const movingCount = samples.filter(s => Number.isFinite(s.spd) && s.spd > 3).length;
  const useHdg = useDoppler && movingCount > 10 && hdgCount > movingCount * 0.8;
  let hdg;
  if (useHdg) {
    const hs = new Float64Array(n);
    let last = NaN;
    for (let i = 0; i < n; i++) {
      const h = samples[i].hdg;
      if (Number.isFinite(h) && vs[i] > 2) last = h * DEG;
      hs[i] = last;
    }
    fillNaN(hs);
    const hu = unwrapAngles(hs);
    const H = new Float64Array(m);
    let hh = 0;
    for (let k = 0; k < m; k++) {
      const t = T[k];
      const i = lowerIndex(ts, t, hh); hh = i;
      const i0 = Math.max(0, i - 1), i2 = Math.min(n - 1, i + 1), i3 = Math.min(n - 1, i + 2);
      const span = ts[i2] - ts[i];
      const u = span > 0 ? Math.min(1, Math.max(0, (t - ts[i]) / span)) : 0;
      H[k] = span > 3 ? hu[i] + (hu[i2] - hu[i]) * u : catmull(hu[i0], hu[i], hu[i2], hu[i3], u);
    }
    hdg = gaussianSmooth(H, Math.max(0.15, 0.3 * srcDt) / dt);
  } else {
    const hdgRaw = new Float64Array(m);
    const w = Math.max(1, Math.round(0.3 / dt));
    for (let k = 0; k < m; k++) {
      const a = Math.max(0, k - w), b = Math.min(m - 1, k + w);
      hdgRaw[k] = Math.atan2(Xs[b] - Xs[a], Ys[b] - Ys[a]); // 北=0, 東=+π/2（時計回り）
    }
    // 停止中は方位が乱れるので前回値を保持
    for (let k = 1; k < m; k++) if (Vs[k] < 1.5) hdgRaw[k] = hdgRaw[k - 1];
    hdg = gaussianSmooth(unwrapAngles(hdgRaw), Math.max(0.3, 0.6 * srcDt) / dt);
  }
  const longG = new Float64Array(m), latG = new Float64Array(m), dist = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1);
    const span = (b - a) * dt;
    const dv = (Vs[b] - Vs[a]) / span;
    const yaw = (hdg[b] - hdg[a]) / span; // 右旋回で正
    longG[k] = dv / G;
    latG[k] = Vs[k] > 2 ? (Vs[k] * yaw) / G : 0; // 正 = 右旋回
    if (k > 0) dist[k] = dist[k - 1] + 0.5 * (Vs[k] + Vs[k - 1]) * dt;
  }
  const longGs = gaussianSmooth(longG, Math.max(0.1, 0.25 * srcDt) / dt);
  const latGs = gaussianSmooth(latG, Math.max(0.1, 0.2 * srcDt) / dt);

  const LAT = new Float64Array(m), LON = new Float64Array(m);
  for (let k = 0; k < m; k++) { const [la, lo] = proj.toLatLon(Xs[k], Ys[k]); LAT[k] = la; LON[k] = lo; }

  const trace = {
    t0, dt, n: m, rateHz: rate, useDoppler, useHdg, proj,
    t: T, x: Xs, y: Ys, lat: LAT, lon: LON, v: Vs, dist, hdg, longG: longGs, latG: latGs, gap: GAP,
    sensor: null,
  };
  if (session.motion && session.motion.length > 50) {
    try { trace.sensor = fuseMotion(session.motion, trace); } catch (e) { trace.sensor = null; }
  }
  return trace;
}

// ---------- 加速度センサーの取り付け向き推定 ----------
// motion: フラット配列 [t(ms), ax, ay, az, ...]（accelerationIncludingGravity, m/s²）
export function fuseMotion(motion, trace) {
  const STR = 4;
  const cnt = Math.floor(motion.length / STR);
  if (cnt < 50) return null;
  // 重力方向 = 全体平均（固定マウント前提）
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < cnt; i++) { gx += motion[i * STR + 1]; gy += motion[i * STR + 2]; gz += motion[i * STR + 3]; }
  gx /= cnt; gy /= cnt; gz /= cnt;
  const gn = Math.hypot(gx, gy, gz);
  if (gn < 5) return null;
  const gu = [gx / gn, gy / gn, gz / gn];
  // 重力に直交する基底 e1, e2
  const ref = Math.abs(gu[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let e1 = cross(gu, ref); const n1 = Math.hypot(...e1); e1 = e1.map(v => v / n1);
  const e2 = cross(gu, e1);

  // トレース時刻（dt 刻み）へ平均化して落とす
  const m = trace.n, dt = trace.dt;
  const h1 = new Float64Array(m), h2 = new Float64Array(m), c = new Float64Array(m);
  for (let i = 0; i < cnt; i++) {
    const t = (motion[i * STR] - trace.t0) / 1000;
    const k = Math.round(t / dt);
    if (k < 0 || k >= m) continue;
    const a = [motion[i * STR + 1] - gx, motion[i * STR + 2] - gy, motion[i * STR + 3] - gz];
    h1[k] += dot(a, e1); h2[k] += dot(a, e2); c[k]++;
  }
  for (let k = 0; k < m; k++) { if (c[k]) { h1[k] /= c[k]; h2[k] /= c[k]; } else { h1[k] = NaN; h2[k] = NaN; } }
  // 欠損補間
  fillNaN(h1); fillNaN(h2);
  const s1 = gaussianSmooth(h1, 0.15 / dt), s2 = gaussianSmooth(h2, 0.15 / dt);
  // GPS 由来の前後Gで最小二乗フィット → 前方向
  // 比較のため同程度に平滑化したものを使う
  const f1 = gaussianSmooth(s1, 0.4 / dt), f2 = gaussianSmooth(s2, 0.4 / dt);
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (let k = 0; k < m; k++) {
    if (trace.v[k] < 4 || trace.gap[k]) continue;
    const y = trace.longG[k] * G;
    a11 += f1[k] * f1[k]; a12 += f1[k] * f2[k]; a22 += f2[k] * f2[k];
    b1 += f1[k] * y; b2 += f2[k] * y;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-9) return null;
  let p = (a22 * b1 - a12 * b2) / det, q = (a11 * b2 - a12 * b1) / det;
  const pn = Math.hypot(p, q); if (pn < 1e-6) return null;
  p /= pn; q /= pn;
  const longS = new Float64Array(m), latS = new Float64Array(m);
  for (let k = 0; k < m; k++) { longS[k] = (p * s1[k] + q * s2[k]) / G; latS[k] = (-q * s1[k] + p * s2[k]) / G; }
  // 横方向の符号を GPS 横Gに合わせる
  const lf = gaussianSmooth(latS, 0.4 / dt);
  if (corr(lf, trace.latG, trace) < 0) for (let k = 0; k < m; k++) latS[k] = -latS[k];
  const quality = corr(gaussianSmooth(longS, 0.4 / dt), trace.longG, trace);
  if (!(quality > 0.5)) return { ok: false, quality };
  return { ok: true, quality, longG: longS, latG: latS };
}

function fillNaN(a) {
  let last = NaN;
  for (let i = 0; i < a.length; i++) { if (Number.isFinite(a[i])) last = a[i]; else if (Number.isFinite(last)) a[i] = last; }
  last = NaN;
  for (let i = a.length - 1; i >= 0; i--) { if (Number.isFinite(a[i])) last = a[i]; else a[i] = Number.isFinite(last) ? last : 0; }
}

function corr(a, b, trace) {
  let sa = 0, sb = 0, n = 0;
  for (let k = 0; k < a.length; k++) { if (trace.v[k] < 4) continue; sa += a[k]; sb += b[k]; n++; }
  if (n < 10) return 0;
  sa /= n; sb /= n;
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < a.length; k++) {
    if (trace.v[k] < 4) continue;
    num += (a[k] - sa) * (b[k] - sb); da += (a[k] - sa) ** 2; db += (b[k] - sb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

// ---------- ライン（S/F・セクター） ----------
// line: { a:{lat,lon}, b:{lat,lon} }
export function segIntersect(p1, p2, q1, q2) {
  const r = [p2[0] - p1[0], p2[1] - p1[1]], s = [q2[0] - q1[0], q2[1] - q1[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const qp = [q1[0] - p1[0], q1[1] - p1[1]];
  const u = (qp[0] * s[1] - qp[1] * s[0]) / den; // p 側の位置
  const w = (qp[0] * r[1] - qp[1] * r[0]) / den; // q 側の位置
  if (u < 0 || u > 1 || w < 0 || w > 1) return null;
  return { u, side: Math.sign(den) };
}

// トレース上でラインを通過した時刻（秒）とインデックス補間位置を返す
export function findCrossings(trace, line, { minInterval = 10 } = {}) {
  if (!line) return [];
  const a = trace.proj.toXY(line.a.lat, line.a.lon), b = trace.proj.toXY(line.b.lat, line.b.lon);
  const raw = [];
  for (let k = 1; k < trace.n; k++) {
    if (trace.v[k] < 2) continue;
    const hit = segIntersect([trace.x[k - 1], trace.y[k - 1]], [trace.x[k], trace.y[k]], a, b);
    if (hit) raw.push({ k: k - 1 + hit.u, t: trace.t[k - 1] + hit.u * trace.dt, side: hit.side });
  }
  if (!raw.length) return [];
  // 多数派の通過方向のみ採用（逆走・ピット通過の誤検出防止）
  const pos = raw.filter(c => c.side > 0).length;
  const dir = pos >= raw.length - pos ? 1 : -1;
  const out = [];
  for (const c of raw) {
    if (c.side !== dir) continue;
    if (out.length && c.t - out[out.length - 1].t < minInterval) continue;
    out.push(c);
  }
  return out;
}

// ラインが未設定のとき: 最高速地点（＝メインストレート想定）に進行方向と直交するラインを置く
export function autoLine(trace, width = 40) {
  let best = -1, bv = -1;
  for (let k = 0; k < trace.n; k++) if (trace.v[k] > bv && !trace.gap[k]) { bv = trace.v[k]; best = k; }
  if (best < 0) return null;
  return lineAt(trace, best, width);
}

export function lineAt(trace, k, width = 40) {
  const h = trace.hdg[k];
  const nx = Math.cos(h), ny = -Math.sin(h); // 進行方向(sin h, cos h) に直交
  const x = trace.x[k], y = trace.y[k];
  const [laA, loA] = trace.proj.toLatLon(x - nx * width / 2, y - ny * width / 2);
  const [laB, loB] = trace.proj.toLatLon(x + nx * width / 2, y + ny * width / 2);
  return { a: { lat: laA, lon: loA }, b: { lat: laB, lon: loB } };
}

// 任意の地点に最も近いトレース点を探す
export function nearestIndex(trace, lat, lon, from = 0, to = trace.n) {
  const [px, py] = trace.proj.toXY(lat, lon);
  let best = -1, bd = Infinity;
  for (let k = from; k < to; k++) {
    const d = (trace.x[k] - px) ** 2 + (trace.y[k] - py) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return { k: best, d: Math.sqrt(bd) };
}

// ---------- 周回 ----------
export function detectLaps(trace, track = {}) {
  const minLap = track.minLapSec ?? 20;
  const sf = track.sf || autoLine(trace);
  const cr = findCrossings(trace, sf, { minInterval: minLap });
  const sectorCross = (track.sectors || []).map(l => findCrossings(trace, l, { minInterval: 5 }));
  const laps = [];
  for (let i = 1; i < cr.length; i++) {
    const s = cr[i - 1], e = cr[i];
    const time = e.t - s.t;
    if (time < minLap) continue;
    const i0 = Math.floor(s.k), i1 = Math.ceil(e.k);
    let hasGap = false;
    for (let k = i0; k <= i1; k++) if (trace.gap[k]) { hasGap = true; break; }
    const sectors = [];
    let prev = s.t;
    for (const sc of sectorCross) {
      const c = sc.find(c => c.t > s.t && c.t < e.t);
      if (!c) { sectors.length = 0; break; }
      sectors.push(c.t - prev); prev = c.t;
    }
    if (sectors.length) sectors.push(e.t - prev);
    laps.push({ no: laps.length + 1, start: s.t, end: e.t, kStart: s.k, kEnd: e.k, time, valid: !hasGap, sectors });
  }
  const valid = laps.filter(l => l.valid);
  const best = valid.reduce((b, l) => (!b || l.time < b.time ? l : b), null);
  let theoretical = null;
  if (track.sectors && track.sectors.length && valid.length && valid.every(l => l.sectors.length)) {
    const ns = valid[0].sectors.length;
    theoretical = 0;
    for (let j = 0; j < ns; j++) theoretical += Math.min(...valid.map(l => l.sectors[j]));
  }
  return { sf, auto: !track.sf, laps, best, theoretical };
}

// 1周分のチャンネルを取り出す（距離・時間は周回開始基準）
export function lapData(trace, lap) {
  const k0 = Math.ceil(lap.kStart), k1 = Math.floor(lap.kEnd);
  const d0 = interpAt(trace.dist, lap.kStart);
  const ch = { t: [], d: [], v: [], longG: [], latG: [], lat: [], lon: [], x: [], y: [], k: [], sLong: [], sLat: [] };
  const push = (kf) => {
    ch.t.push(interpAt(trace.t, kf) - lap.start);
    ch.d.push(interpAt(trace.dist, kf) - d0);
    ch.v.push(interpAt(trace.v, kf));
    ch.longG.push(interpAt(trace.longG, kf));
    ch.latG.push(interpAt(trace.latG, kf));
    ch.lat.push(interpAt(trace.lat, kf));
    ch.lon.push(interpAt(trace.lon, kf));
    ch.x.push(interpAt(trace.x, kf));
    ch.y.push(interpAt(trace.y, kf));
    ch.k.push(kf);
    if (trace.sensor && trace.sensor.ok) { ch.sLong.push(interpAt(trace.sensor.longG, kf)); ch.sLat.push(interpAt(trace.sensor.latG, kf)); }
  };
  push(lap.kStart);
  for (let k = k0; k <= k1; k++) if (k > lap.kStart && k < lap.kEnd) push(k);
  push(lap.kEnd);
  ch.length = ch.d[ch.d.length - 1];
  ch.time = lap.time;
  return ch;
}

function interpAt(arr, kf) {
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(kf)));
  const j = Math.min(arr.length - 1, i + 1);
  const f = kf - i;
  return arr[i] + (arr[j] - arr[i]) * f;
}

// 距離基準に再サンプル（refLen を与えると距離を正規化して比較可能にする）
export function resampleByDistance(ch, step = 1, refLen = null) {
  const scale = refLen ? refLen / ch.length : 1;
  const d = ch.d.map(v => v * scale);
  const L = refLen || ch.length;
  const N = Math.floor(L / step) + 1;
  const out = { d: new Float64Array(N), t: new Float64Array(N), v: new Float64Array(N), longG: new Float64Array(N), latG: new Float64Array(N), lat: new Float64Array(N), lon: new Float64Array(N), sLong: null, sLat: null };
  const hasS = ch.sLong.length === ch.d.length;
  if (hasS) { out.sLong = new Float64Array(N); out.sLat = new Float64Array(N); }
  for (let i = 0; i < N; i++) {
    const x = i * step;
    out.d[i] = x;
    out.t[i] = interpLinear(d, ch.t, x);
    out.v[i] = interpLinear(d, ch.v, x);
    out.longG[i] = interpLinear(d, ch.longG, x);
    out.latG[i] = interpLinear(d, ch.latG, x);
    out.lat[i] = interpLinear(d, ch.lat, x);
    out.lon[i] = interpLinear(d, ch.lon, x);
    if (hasS) { out.sLong[i] = interpLinear(d, ch.sLong, x); out.sLat[i] = interpLinear(d, ch.sLat, x); }
  }
  out.length = L;
  out.time = ch.time;
  return out;
}

// 比較ラップとの差（正 = 比較ラップが遅れている）
export function deltaTime(ref, cmp) {
  const n = Math.min(ref.t.length, cmp.t.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = cmp.t[i] - ref.t[i];
  return out;
}

// ---------- ブレーキングゾーン / コーナー ----------
export function brakingZones(rs, { threshold = -0.25, minDur = 0.3, useSensor = false } = {}) {
  const zones = [];
  let st = -1;
  const n = rs.d.length;
  const g = useSensor && rs.sLong ? rs.sLong : rs.longG;
  for (let i = 0; i <= n; i++) {
    const on = i < n && g[i] < threshold;
    if (on && st < 0) st = i;
    if (!on && st >= 0) {
      const ed = i - 1;
      const dur = rs.t[ed] - rs.t[st];
      if (dur >= minDur) {
        let peak = 0, minV = Infinity;
        for (let j = st; j <= ed; j++) { peak = Math.min(peak, g[j]); }
        // 減速終了後の最低速度（ゾーン末尾から少し先まで）
        let jEnd = ed;
        for (let j = ed; j < Math.min(n, ed + 80); j++) { if (rs.v[j] < minV) { minV = rs.v[j]; jEnd = j; } if (rs.v[j] > minV + 1) break; }
        // ブレーキ開始点を少し遡って補正（閾値に達する前の立ち上がり）
        let b0 = st;
        while (b0 > 0 && g[b0 - 1] < -0.08 && st - b0 < 30) b0--;
        zones.push({ iStart: b0, iEnd: ed, iMin: jEnd, dStart: rs.d[b0], dEnd: rs.d[ed], vEntry: rs.v[b0], vMin: minV, peakG: peak, dur: rs.t[ed] - rs.t[b0] });
      }
      st = -1;
    }
  }
  return zones;
}

export function corners(rs, { prominence = 2.0, minLat = 0.25 } = {}) {
  // 速度の極小（プロミネンス m/s 以上）をコーナーとみなす
  const v = gaussianSmooth(rs.v, 3);
  const n = v.length, out = [];
  for (let i = 2; i < n - 2; i++) {
    if (!(v[i] <= v[i - 1] && v[i] < v[i + 1])) continue;
    let lmax = v[i], rmax = v[i];
    for (let j = i; j >= Math.max(0, i - 250); j--) lmax = Math.max(lmax, v[j]);
    for (let j = i; j < Math.min(n, i + 250); j++) rmax = Math.max(rmax, v[j]);
    if (Math.min(lmax, rmax) - v[i] < prominence) continue;
    let peakLat = 0;
    for (let j = Math.max(0, i - 30); j < Math.min(n, i + 30); j++) if (Math.abs(rs.latG[j]) > Math.abs(peakLat)) peakLat = rs.latG[j];
    if (Math.abs(peakLat) < minLat) continue;
    out.push({ i, d: rs.d[i], vMin: rs.v[i], latG: peakLat, dir: peakLat > 0 ? '右' : '左' });
  }
  // 近すぎる極小を統合
  const merged = [];
  for (const c of out) {
    const p = merged[merged.length - 1];
    if (p && c.d - p.d < 40) { if (c.vMin < p.vMin) merged[merged.length - 1] = c; } else merged.push(c);
  }
  return merged;
}

// 基準ラップのコーナー位置で、比較ラップの値を取る
export function matchCorners(refCorners, cmpRs, window = 30) {
  return refCorners.map(c => {
    let best = -1, bv = Infinity;
    for (let i = Math.max(0, c.i - window); i < Math.min(cmpRs.v.length, c.i + window); i++) if (cmpRs.v[i] < bv) { bv = cmpRs.v[i]; best = i; }
    return best < 0 ? null : { i: best, d: cmpRs.d[best], vMin: bv };
  });
}

export function lapStats(ch) {
  let vmax = 0, maxBrake = 0, maxLat = 0, maxAcc = 0;
  for (let i = 0; i < ch.v.length; i++) {
    vmax = Math.max(vmax, ch.v[i]);
    maxBrake = Math.min(maxBrake, ch.longG[i]);
    maxAcc = Math.max(maxAcc, ch.longG[i]);
    maxLat = Math.max(maxLat, Math.abs(ch.latG[i]));
  }
  return { vmax, maxBrake, maxAcc, maxLat, length: ch.length };
}

// ---------- 入出力 ----------
export function toCSV(session) {
  const lines = ['time_iso,timestamp_ms,lat,lon,alt_m,accuracy_m,speed_kmh,heading_deg'];
  for (const s of session.samples) {
    lines.push([new Date(s.t).toISOString(), s.t, s.lat.toFixed(7), s.lon.toFixed(7), fmt(s.alt, 1), fmt(s.acc, 1), Number.isFinite(s.spd) ? (s.spd * 3.6).toFixed(2) : '', fmt(s.hdg, 1)].join(','));
  }
  return lines.join('\n');
}
function fmt(v, d) { return Number.isFinite(v) ? v.toFixed(d) : ''; }

export function toGPX(session) {
  const pts = session.samples.map(s => `<trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}">${Number.isFinite(s.alt) ? `<ele>${s.alt.toFixed(1)}</ele>` : ''}<time>${new Date(s.t).toISOString()}</time>${Number.isFinite(s.spd) ? `<extensions><speed>${s.spd.toFixed(2)}</speed></extensions>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Honjo Lap Logger" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${escapeXml(session.name || '')}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
}
function escapeXml(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// ファイル内容から samples を作る（CSV / GPX / NMEA）
export function parseFile(text, name = '') {
  const head = text.slice(0, 2000);
  if (/<gpx[\s>]/i.test(head) || /\.gpx$/i.test(name)) return parseGPX(text);
  if (/^\s*\$G[PNL]/m.test(head) || /\.(nmea|nma)$/i.test(name)) return parseNMEA(text);
  return parseCSV(text);
}

export function parseGPX(text) {
  const out = [];
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
  let m;
  while ((m = re.exec(text))) {
    const lat = parseFloat((/lat="([^"]+)"/.exec(m[1]) || [])[1]);
    const lon = parseFloat((/lon="([^"]+)"/.exec(m[1]) || [])[1]);
    const time = (/<time>([^<]+)<\/time>/.exec(m[2]) || [])[1];
    const ele = parseFloat((/<ele>([^<]+)<\/ele>/.exec(m[2]) || [])[1]);
    const spd = parseFloat((/<(?:\w+:)?speed>([^<]+)<\/(?:\w+:)?speed>/.exec(m[2]) || [])[1]);
    if (!time) continue;
    out.push({ t: Date.parse(time), lat, lon, alt: ele, spd: Number.isFinite(spd) ? spd : undefined });
  }
  return out;
}

export function parseNMEA(text) {
  const out = [];
  let date = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\*[0-9A-F]{2}$/i, '');
    const f = line.split(',');
    if (/^\$G.RMC$/.test(f[0])) {
      if (f[2] !== 'A') continue;
      const time = f[1], d = f[9];
      if (!time || !d) continue;
      date = d;
      const t = Date.UTC(2000 + +d.slice(4, 6), +d.slice(2, 4) - 1, +d.slice(0, 2), +time.slice(0, 2), +time.slice(2, 4), 0) + parseFloat(time.slice(4)) * 1000;
      const lat = nmeaDeg(f[3], f[4]), lon = nmeaDeg(f[5], f[6]);
      const spd = parseFloat(f[7]) * 0.514444;
      const hdg = parseFloat(f[8]);
      out.push({ t, lat, lon, spd: Number.isFinite(spd) ? spd : undefined, hdg: Number.isFinite(hdg) ? hdg : undefined });
    }
  }
  void date;
  return out;
}
function nmeaDeg(v, hemi) {
  if (!v) return NaN;
  const dot = v.indexOf('.');
  const degLen = dot - 2;
  const deg = parseFloat(v.slice(0, degLen)), min = parseFloat(v.slice(degLen));
  const r = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -r : r;
}

export function parseCSV(text) {
  const rows = text.split(/\r?\n/);
  const split = (l) => l.split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, ''));
  let hi = -1, cols = null;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const c = split(rows[i]).map(s => s.toLowerCase());
    if (c.some(s => /^(lat|latitude|緯度)/.test(s)) && c.some(s => /^(lon|lng|long|longitude|経度)/.test(s))) { hi = i; cols = c; break; }
  }
  if (hi < 0) throw new Error('CSV に緯度・経度の列が見つかりません');
  const find = (re) => cols.findIndex(s => re.test(s));
  const iLat = find(/^(lat|latitude|緯度)/), iLon = find(/^(lon|lng|long|longitude|経度)/);
  const iIso = find(/^(time_iso|utc|datetime|date ?time|time$|gps time)/);
  const iMs = find(/^(timestamp_ms|timestamp|time ?\(s\)|timestamp ?\(s\)|elapsed|seconds|time_s)/);
  const iSpd = find(/^(speed|spd|速度)/);
  const iAlt = find(/^(alt|altitude|elevation|ele|高度)/);
  const iHdg = find(/^(heading|bearing|course|hdg)/);
  const iAcc = find(/^(accuracy|hacc|acc)/);
  const spdUnit = iSpd >= 0 ? cols[iSpd] : '';
  const spdK = /km\/?h|kph|kmh/.test(spdUnit) ? 1 / 3.6 : /mph/.test(spdUnit) ? 0.44704 : /knot|kt/.test(spdUnit) ? 0.514444 : /m\/s|mps/.test(spdUnit) ? 1 : 1 / 3.6; // 単位不明は km/h とみなす
  const out = [];
  const base = Date.UTC(2000, 0, 1);
  for (let i = hi + 1; i < rows.length; i++) {
    if (!rows[i].trim()) continue;
    const c = split(rows[i]);
    const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    let t = NaN;
    if (iMs >= 0) {
      const v = parseFloat(c[iMs]);
      if (Number.isFinite(v)) t = v > 1e11 ? v : v > 1e8 ? v * 1000 : base + v * 1000; // ms epoch / s epoch / 経過秒
    }
    if (!Number.isFinite(t) && iIso >= 0) t = Date.parse(c[iIso]);
    if (!Number.isFinite(t)) continue;
    const spd = iSpd >= 0 ? parseFloat(c[iSpd]) * spdK : undefined;
    out.push({ t, lat, lon, spd: Number.isFinite(spd) ? spd : undefined, alt: iAlt >= 0 ? parseFloat(c[iAlt]) : undefined, hdg: iHdg >= 0 ? parseFloat(c[iHdg]) : undefined, acc: iAcc >= 0 ? parseFloat(c[iAcc]) : undefined });
  }
  return out;
}

// ---------- 表示用 ----------
export function fmtLap(sec) {
  if (!Number.isFinite(sec)) return '--:--.---';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
export function fmtDelta(sec) {
  if (!Number.isFinite(sec)) return '';
  return (sec >= 0 ? '+' : '−') + Math.abs(sec).toFixed(3);
}
