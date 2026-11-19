// 走行データ解析コア（ブラウザ / Node 共通の純粋関数）
// 座標系: 局所平面（x=東, y=北, 単位 m）。方位は北=0・時計回り。
// 符号: 横G・ヨーレート・ライン位置は「右」が＋、前後Gは「加速」が＋。

export const G = 9.80665;
export const DEG = Math.PI / 180;
const R_EARTH = 6378137;

// ---------- 座標 ----------
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
export function gaussianSmooth(arr, sigma, { circular = false } = {}) {
  const n = arr.length;
  if (!(sigma >= 0.5) || n < 3) return Float64Array.from(arr);
  const r = Math.min(Math.ceil(sigma * 3), circular ? Math.floor((n - 1) / 2) : n);
  const w = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (circular) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const v = arr[j];
      if (!Number.isFinite(v)) continue;
      s += v * w[k + r]; ws += w[k + r];
    }
    out[i] = ws > 0 ? s / ws : NaN;
  }
  return out;
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

// 小数インデックスで配列を線形補間
export function interpAt(arr, kf) {
  const n = arr.length;
  const i = Math.max(0, Math.min(n - 1, Math.floor(kf)));
  const j = Math.min(n - 1, i + 1);
  const f = Math.max(0, Math.min(1, kf - i));
  return arr[i] + (arr[j] - arr[i]) * f;
}

export function unwrapAngles(a) {
  const out = new Float64Array(a.length);
  if (!a.length) return out;
  out[0] = a[0];
  for (let i = 1; i < a.length; i++) out[i] = out[i - 1] + wrapPi(a[i] - a[i - 1]);
  return out;
}
export function wrapPi(d) {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function median(arr) { return percentile(arr, 0.5); }
export function percentile(arr, p) {
  const a = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))));
  return a[idx];
}
export function fillNaN(a) {
  let last = NaN;
  for (let i = 0; i < a.length; i++) { if (Number.isFinite(a[i])) last = a[i]; else if (Number.isFinite(last)) a[i] = last; }
  last = NaN;
  for (let i = a.length - 1; i >= 0; i--) { if (Number.isFinite(a[i])) last = a[i]; else a[i] = Number.isFinite(last) ? last : 0; }
  return a;
}

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}
// 3次エルミート補間（m0, m1 は区間長でスケール済みの接線）
function hermite(p0, m0, p1, m1, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
}

function lowerIndex(ts, t, hint = 0) {
  let i = Math.max(0, Math.min(hint, ts.length - 2));
  while (i < ts.length - 2 && ts[i + 1] <= t) i++;
  while (i > 0 && ts[i] > t) i--;
  return i;
}

// ---------- サンプル整形 ----------
// sample: { t: epoch ms, lat, lon, alt?, acc?, altAcc?, spd?(m/s), hdg?(deg) }
export function cleanSamples(samples, { maxAcc = 35 } = {}) {
  const s = samples
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t) && !(p.lat === 0 && p.lon === 0))
    .filter(p => !(Number.isFinite(p.acc) && p.acc > maxAcc))
    .slice()
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of s) {
    const prev = out[out.length - 1];
    if (prev && p.t - prev.t < 20) continue; // 重複
    if (prev) {
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      if (d / ((p.t - prev.t) / 1000) > 120) continue; // 物理的にあり得ない跳び
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

// ---------- メイン処理: 10Hz の解析トレース ----------
// GPS の位置とドップラー速度ベクトル（速度＋方位）の両方を通る3次エルミート曲線で
// 1Hz の点の間を補間する。位置差分だけで補間するより、コーナーでラインが内側に潰れにくい。
export function processSession(session, opts = {}) {
  const dt = opts.dt ?? 0.1;
  const samples = cleanSamples(session.samples || []);
  if (samples.length < 5) return null;
  const n = samples.length;
  const lat0 = median(samples.map(s => s.lat));
  const lon0 = median(samples.map(s => s.lon));
  const proj = makeProjection(lat0, lon0);
  const t0 = samples[0].t;
  const ts = new Float64Array(n), xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    ts[i] = (s.t - t0) / 1000;
    const [x, y] = proj.toXY(s.lat, s.lon);
    xs[i] = x; ys[i] = y;
  }

  // 速度: ドップラー速度が十分あれば優先
  const spdCount = samples.filter(s => Number.isFinite(s.spd) && s.spd >= 0).length;
  const useDoppler = spdCount > n * 0.8;
  const vs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sp = samples[i].spd;
    if (useDoppler && Number.isFinite(sp) && sp >= 0) { vs[i] = sp; continue; }
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    vs[i] = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]) / Math.max(1e-3, ts[b] - ts[a]);
  }

  // 方位: 端末のドップラー方位が十分あれば優先
  let moving = 0, hdgCount = 0;
  for (let i = 0; i < n; i++) if (vs[i] > 3) { moving++; if (Number.isFinite(samples[i].hdg)) hdgCount++; }
  const useHdg = useDoppler && moving > 10 && hdgCount > moving * 0.8;
  const vxs = new Float64Array(n), vys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = samples[i].hdg;
    if (useHdg && vs[i] > 2 && Number.isFinite(h)) {
      vxs[i] = vs[i] * Math.sin(h * DEG); vys[i] = vs[i] * Math.cos(h * DEG);
    } else {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const span = ts[b] - ts[a] || 1;
      let dx = (xs[b] - xs[a]) / span, dy = (ys[b] - ys[a]) / span;
      const mag = Math.hypot(dx, dy);
      if (useDoppler && mag > 0.3) { dx *= vs[i] / mag; dy *= vs[i] / mag; }
      vxs[i] = dx; vys[i] = dy;
    }
  }

  const rate = sourceRateHz(samples);
  const srcDt = 1 / rate;
  const m = Math.floor(ts[n - 1] / dt) + 1;
  const T = new Float64Array(m), X = new Float64Array(m), Y = new Float64Array(m), V = new Float64Array(m);
  const ALT = new Float64Array(m), ACC = new Float64Array(m), GAP = new Uint8Array(m);
  const alts = samples.map(s => (Number.isFinite(s.alt) ? s.alt : NaN));
  const accs = samples.map(s => (Number.isFinite(s.acc) ? s.acc : NaN));
  fillNaN(alts); fillNaN(accs);
  let hint = 0;
  for (let k = 0; k < m; k++) {
    const t = k * dt;
    const i = lowerIndex(ts, t, hint); hint = i;
    const i0 = Math.max(0, i - 1), i2 = Math.min(n - 1, i + 1), i3 = Math.min(n - 1, i + 2);
    const span = ts[i2] - ts[i];
    const u = span > 0 ? Math.min(1, Math.max(0, (t - ts[i]) / span)) : 0;
    T[k] = t;
    ALT[k] = alts[i] + (alts[i2] - alts[i]) * u;
    ACC[k] = accs[i] + (accs[i2] - accs[i]) * u;
    if (span > 3 || span <= 0) { // データ欠落: 線形補間して印を付ける
      X[k] = xs[i] + (xs[i2] - xs[i]) * u;
      Y[k] = ys[i] + (ys[i2] - ys[i]) * u;
      V[k] = vs[i] + (vs[i2] - vs[i]) * u;
      if (span > 3) GAP[k] = 1;
    } else if (opts.interp === 'catmull') {
      X[k] = catmull(xs[i0], xs[i], xs[i2], xs[i3], u);
      Y[k] = catmull(ys[i0], ys[i], ys[i2], ys[i3], u);
      V[k] = Math.max(0, catmull(vs[i0], vs[i], vs[i2], vs[i3], u));
    } else {
      X[k] = hermite(xs[i], vxs[i] * span, xs[i2], vxs[i2] * span, u);
      Y[k] = hermite(ys[i], vys[i] * span, ys[i2], vys[i2] * span, u);
      V[k] = Math.max(0, catmull(vs[i0], vs[i], vs[i2], vs[i3], u));
    }
  }

  // 平滑化（低レートほど強め）
  const sigPos = (opts.sigPos ?? Math.max(0.12, 0.25 * srcDt)) / dt;
  const sigV = Math.max(0.2, 0.45 * srcDt) / dt;
  const Xs = gaussianSmooth(X, sigPos), Ys = gaussianSmooth(Y, sigPos), Vs = gaussianSmooth(V, sigV);

  // 方位とヨーレート（補間した軌跡の接線から）
  const hdgRaw = new Float64Array(m);
  const w = Math.max(1, Math.round(0.2 / dt));
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - w), b = Math.min(m - 1, k + w);
    hdgRaw[k] = Math.atan2(Xs[b] - Xs[a], Ys[b] - Ys[a]);
  }
  for (let k = 1; k < m; k++) if (Vs[k] < 1.5) hdgRaw[k] = hdgRaw[k - 1]; // 停止中は保持
  const hdg = gaussianSmooth(unwrapAngles(hdgRaw), (opts.sigHdg ?? Math.max(0.2, 0.3 * srcDt)) / dt);
  const longG = new Float64Array(m), latG = new Float64Array(m), yaw = new Float64Array(m), dist = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1);
    const span = (b - a) * dt;
    yaw[k] = Vs[k] > 2 ? (hdg[b] - hdg[a]) / span : 0; // rad/s, 右旋回が＋
    longG[k] = (Vs[b] - Vs[a]) / span / G;
    latG[k] = (Vs[k] * yaw[k]) / G;
    if (k > 0) dist[k] = dist[k - 1] + 0.5 * (Vs[k] + Vs[k - 1]) * dt;
  }
  const longGs = gaussianSmooth(longG, Math.max(0.1, 0.25 * srcDt) / dt);
  const latGs = gaussianSmooth(latG, Math.max(0.1, 0.15 * srcDt) / dt);
  const altS = gaussianSmooth(ALT, 2 / dt);

  const LAT = new Float64Array(m), LON = new Float64Array(m);
  for (let k = 0; k < m; k++) { const [la, lo] = proj.toLatLon(Xs[k], Ys[k]); LAT[k] = la; LON[k] = lo; }

  const trace = {
    t0, dt, n: m, rateHz: rate, useDoppler, useHdg, proj, samplesUsed: n,
    t: T, x: Xs, y: Ys, lat: LAT, lon: LON, v: Vs, dist, hdg, yaw, longG: longGs, latG: latGs, alt: altS, acc: ACC, gap: GAP,
    sensor: null,
  };
  const motion = session.motion;
  if (motion && motion.length > 400) {
    const stride = session.meta?.motionStride || 4;
    try { trace.sensor = fuseMotion(motion, stride, trace); } catch (e) { trace.sensor = { error: String(e) }; }
    // 低レート GPS の速度を加速度センサーで補う（GPS 点の間の山・谷を復元）
    if (trace.sensor && trace.sensor.longOk && trace.sensor.qLong > 0.8 && rate < 5 && opts.fuseSpeed !== false) {
      fuseSpeed(trace, ts, vs);
    }
  }
  return trace;
}

// GPS 速度（各測位時刻）を通り、その間はセンサー前後加速度の積分で形を作る
function fuseSpeed(trace, ts, vs) {
  const m = trace.n, dt = trace.dt, a = trace.sensor.longG;
  const A = new Float64Array(m);
  for (let k = 1; k < m; k++) A[k] = A[k - 1] + 0.5 * (a[k] + a[k - 1]) * G * dt;
  const Aat = (t) => interpAt(A, t / dt);
  const V = Float64Array.from(trace.v);
  for (let i = 0; i < ts.length - 1; i++) {
    const t1 = ts[i], t2 = ts[i + 1], span = t2 - t1;
    if (!(span > 0) || span > 3) continue;
    const a1 = Aat(t1), drift = vs[i] + (Aat(t2) - a1) - vs[i + 1];
    for (let k = Math.ceil(t1 / dt); k <= Math.min(m - 1, Math.floor(t2 / dt)); k++) {
      const tk = k * dt;
      V[k] = Math.max(0, vs[i] + (A[k] - a1) - drift * (tk - t1) / span);
    }
  }
  const Vs = gaussianSmooth(V, 0.1 / dt);
  trace.vGps = trace.v;
  trace.v = Vs;
  trace.speedFused = true;
  for (let k = 0; k < m; k++) {
    trace.dist[k] = k ? trace.dist[k - 1] + 0.5 * (Vs[k] + Vs[k - 1]) * dt : 0;
    trace.latG[k] = (Vs[k] * trace.yaw[k]) / G;
    if (trace.sensor.latGyro) trace.sensor.latGyro[k] = Vs[k] > 1 ? (Vs[k] * trace.sensor.yaw[k]) / G : 0;
  }
}

// 軌跡の平行移動（セッション間の GPS 位置ずれ補正用）
export function shiftTrace(trace, dx, dy) {
  for (let k = 0; k < trace.n; k++) {
    trace.x[k] += dx; trace.y[k] += dy;
    const [la, lo] = trace.proj.toLatLon(trace.x[k], trace.y[k]);
    trace.lat[k] = la; trace.lon[k] = lo;
  }
}

// ---------- 加速度・ジャイロセンサーの融合 ----------
// motion: フラット配列。stride=4: [t, ax, ay, az]（重力込み加速度 m/s²）
//                    stride=7: [t, ax, ay, az, alpha, beta, gamma]（+ 回転速度 alpha=z軸, beta=x軸, gamma=y軸）
// 取り付け向きは未知でよい。重力方向は走行中の平均、前方向は GPS 前後Gとの最小二乗、
// ヨーレートは「回転速度ベクトル・重力方向」を GPS 方位変化率に回帰して符号と単位(deg/rad)を決める。
export function fuseMotion(motion, stride, trace) {
  const cnt = Math.floor(motion.length / stride);
  if (cnt < 100) return null;
  const m = trace.n, dt = trace.dt;
  const hasGyro = stride >= 7;
  const sum = Array.from({ length: hasGyro ? 6 : 3 }, () => new Float64Array(m));
  const c = new Float64Array(m);
  for (let i = 0; i < cnt; i++) {
    const o = i * stride;
    const k = Math.round(((motion[o] - trace.t0) / 1000) / dt);
    if (k < 0 || k >= m) continue;
    const ax = motion[o + 1], ay = motion[o + 2], az = motion[o + 3];
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) continue;
    sum[0][k] += ax; sum[1][k] += ay; sum[2][k] += az;
    if (hasGyro) {
      const al = motion[o + 4], be = motion[o + 5], ga = motion[o + 6];
      sum[3][k] += Number.isFinite(be) ? be : 0; // x
      sum[4][k] += Number.isFinite(ga) ? ga : 0; // y
      sum[5][k] += Number.isFinite(al) ? al : 0; // z
    }
    c[k]++;
  }
  const ch = sum.map(arr => { const out = new Float64Array(m); for (let k = 0; k < m; k++) out[k] = c[k] ? arr[k] / c[k] : NaN; return out; });
  const covered = c.reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
  if (covered < 100) return null;

  // 重力方向（走行中の平均。ピットで端末を触っていても影響を受けにくい）
  let gx = 0, gy = 0, gz = 0, gc = 0;
  for (let k = 0; k < m; k++) {
    if (!(c[k] > 0) || trace.v[k] < 3) continue;
    gx += ch[0][k]; gy += ch[1][k]; gz += ch[2][k]; gc++;
  }
  if (gc < 50) {
    gx = gy = gz = gc = 0;
    for (let k = 0; k < m; k++) if (c[k] > 0) { gx += ch[0][k]; gy += ch[1][k]; gz += ch[2][k]; gc++; }
  }
  gx /= gc; gy /= gc; gz /= gc;
  const gn = Math.hypot(gx, gy, gz);
  if (!(gn > 5)) return null;
  const gu = [gx / gn, gy / gn, gz / gn];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const ref = Math.abs(gu[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let e1 = cross(gu, ref); const n1 = Math.hypot(...e1); e1 = e1.map(v => v / n1);
  const e2 = cross(gu, e1);

  const h1 = new Float64Array(m), h2 = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    if (!(c[k] > 0)) { h1[k] = NaN; h2[k] = NaN; continue; }
    const a = [ch[0][k] - gx, ch[1][k] - gy, ch[2][k] - gz];
    h1[k] = dot(a, e1); h2[k] = dot(a, e2);
  }
  fillNaN(h1); fillNaN(h2);
  const sig = (s) => s / dt;
  const s1 = gaussianSmooth(h1, sig(0.12)), s2 = gaussianSmooth(h2, sig(0.12));
  const f1 = gaussianSmooth(s1, sig(0.4)), f2 = gaussianSmooth(s2, sig(0.4));
  const use = (k) => trace.v[k] > 4 && !trace.gap[k] && c[k] > 0;
  // 前方向: GPS 前後G ≈ p·h1 + q·h2
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (let k = 0; k < m; k++) {
    if (!use(k)) continue;
    const y = trace.longG[k] * G;
    a11 += f1[k] * f1[k]; a12 += f1[k] * f2[k]; a22 += f2[k] * f2[k]; b1 += f1[k] * y; b2 += f2[k] * y;
  }
  const det = a11 * a22 - a12 * a12;
  const out = { hasGyro, longOk: false, qLong: 0, yawOk: false, qYaw: 0, longG: null, latA: null, yaw: null, latGyro: null, gyroUnits: null };
  if (Math.abs(det) > 1e-9) {
    let p = (a22 * b1 - a12 * b2) / det, q = (a11 * b2 - a12 * b1) / det;
    const pn = Math.hypot(p, q);
    if (pn > 1e-6) {
      p /= pn; q /= pn;
      const longS = new Float64Array(m), latS = new Float64Array(m);
      for (let k = 0; k < m; k++) { longS[k] = (p * s1[k] + q * s2[k]) / G; latS[k] = (-q * s1[k] + p * s2[k]) / G; }
      if (corrUse(gaussianSmooth(latS, sig(0.4)), trace.latG, use) < 0) for (let k = 0; k < m; k++) latS[k] = -latS[k];
      out.qLong = corrUse(gaussianSmooth(longS, sig(0.4)), trace.longG, use);
      out.longOk = out.qLong > 0.6;
      out.longG = longS; out.latA = latS;
    }
  }
  // ヨーレート（ジャイロ）
  if (hasGyro) {
    const yr = new Float64Array(m);
    for (let k = 0; k < m; k++) yr[k] = c[k] > 0 ? ch[3][k] * gu[0] + ch[4][k] * gu[1] + ch[5][k] * gu[2] : NaN;
    fillNaN(yr);
    const yrS = gaussianSmooth(yr, sig(0.1));
    const yrF = gaussianSmooth(yr, sig(0.45));
    // GPS ヨーレート ≈ k·yr + b
    let n0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < m; k++) {
      if (!use(k)) continue;
      const xv = yrF[k], yv = trace.yaw[k];
      n0++; sx += xv; sy += yv; sxx += xv * xv; sxy += xv * yv;
    }
    const den = n0 * sxx - sx * sx;
    if (n0 > 50 && Math.abs(den) > 1e-12) {
      const kk = (n0 * sxy - sx * sy) / den, bb = (sy - kk * sx) / n0;
      const yaw = new Float64Array(m), latGyro = new Float64Array(m), fit = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        yaw[k] = kk * yrS[k] + bb; fit[k] = kk * yrF[k] + bb;
        latGyro[k] = trace.v[k] > 1 ? (trace.v[k] * yaw[k]) / G : 0;
      }
      out.qYaw = corrUse(fit, trace.yaw, use);
      out.yawOk = out.qYaw > 0.75;
      out.gyroUnits = Math.abs(kk) > 0.2 ? 'rad/s' : 'deg/s';
      out.yaw = yaw; out.latGyro = latGyro;
    }
  }
  out.ok = out.longOk || out.yawOk;
  return out;
}

function corrUse(a, b, use) {
  let sa = 0, sb = 0, n = 0;
  for (let k = 0; k < a.length; k++) { if (!use(k)) continue; sa += a[k]; sb += b[k]; n++; }
  if (n < 20) return 0;
  sa /= n; sb /= n;
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < a.length; k++) {
    if (!use(k)) continue;
    num += (a[k] - sa) * (b[k] - sb); da += (a[k] - sa) ** 2; db += (b[k] - sb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

// G チャンネルの選択: 'auto'（センサー融合が成功していれば使う）/'gps'/'sensor'
export function chooseG(trace, src = 'auto') {
  const s = trace.sensor;
  const longSensor = s && s.longOk && s.longG;
  const latSensor = s && s.yawOk && s.latGyro;
  const useLong = src === 'gps' ? false : !!longSensor;
  const useLat = src === 'gps' ? false : !!latSensor;
  return {
    longG: useLong ? s.longG : trace.longG,
    latG: useLat ? s.latGyro : trace.latG,
    longSrc: useLong ? 'sensor' : 'gps',
    latSrc: useLat ? 'gyro' : 'gps',
  };
}

// ---------- ライン（S/F・セクター） ----------
// line: { a:{lat,lon}, b:{lat,lon} }
export function segIntersect(p1, p2, q1, q2) {
  const r = [p2[0] - p1[0], p2[1] - p1[1]], s = [q2[0] - q1[0], q2[1] - q1[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const qp = [q1[0] - p1[0], q1[1] - p1[1]];
  const u = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const w = (qp[0] * r[1] - qp[1] * r[0]) / den;
  if (u < 0 || u > 1 || w < 0 || w > 1) return null;
  return { u, side: Math.sign(den) };
}

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
  const pos = raw.filter(c => c.side > 0).length;
  const dir = pos >= raw.length - pos ? 1 : -1; // 多数派の通過方向のみ（逆走・ピット誤検出防止）
  const out = [];
  for (const c of raw) {
    if (c.side !== dir) continue;
    if (out.length && c.t - out[out.length - 1].t < minInterval) continue;
    out.push(c);
  }
  return out;
}

// 何度も通過した場所（＝周回コース）だけを候補にして最高速地点に S/F を置く。
// サーキットまでの一般道の走行が混ざっていても誤検出しにくい。
export function autoLine(trace, width = 40) {
  const cell = 12;
  const visits = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (let k = 0; k < trace.n; k += 2) {
    if (trace.v[k] < 5) continue;
    const kk = key(trace.x[k], trace.y[k]);
    let e = visits.get(kk);
    if (!e) { e = { n: 0, last: -1e9 }; visits.set(kk, e); }
    if (trace.t[k] - e.last > 15) e.n++;
    e.last = trace.t[k];
  }
  let best = -1, bv = -1, bestAny = -1, bvAny = -1;
  for (let k = 0; k < trace.n; k++) {
    if (trace.gap[k]) continue;
    if (trace.v[k] > bvAny) { bvAny = trace.v[k]; bestAny = k; }
    const e = visits.get(key(trace.x[k], trace.y[k]));
    if (e && e.n >= 3 && trace.v[k] > bv) { bv = trace.v[k]; best = k; }
  }
  const k = best >= 0 ? best : bestAny;
  return k < 0 ? null : lineAt(trace, k, width);
}

export function lineAt(trace, k, width = 40) {
  return lineAtXY(trace.proj, trace.x[k], trace.y[k], trace.hdg[k], width);
}
export function lineAtXY(proj, x, y, h, width = 40) {
  const nx = Math.cos(h), ny = -Math.sin(h);
  const [laA, loA] = proj.toLatLon(x - nx * width / 2, y - ny * width / 2);
  const [laB, loB] = proj.toLatLon(x + nx * width / 2, y + ny * width / 2);
  return { a: { lat: laA, lon: loA }, b: { lat: laB, lon: loB } };
}

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
    const flags = [];
    let stopRun = 0, maxStop = 0;
    for (let k = i0; k <= i1; k++) {
      if (trace.gap[k]) { if (!flags.includes('gap')) flags.push('gap'); }
      if (trace.v[k] < 3) { stopRun += trace.dt; maxStop = Math.max(maxStop, stopRun); } else stopRun = 0;
    }
    if (maxStop > 4) flags.push('pit');
    const sectors = [];
    let prev = s.t;
    for (const sc of sectorCross) {
      const c = sc.find(c => c.t > s.t && c.t < e.t);
      if (!c) { sectors.length = 0; break; }
      sectors.push(c.t - prev); prev = c.t;
    }
    if (sectors.length) sectors.push(e.t - prev);
    laps.push({ no: laps.length + 1, start: s.t, end: e.t, kStart: s.k, kEnd: e.k, time, flags, valid: !flags.length, sectors });
  }
  const med = median(laps.filter(l => l.valid).map(l => l.time));
  for (const l of laps) if (l.valid && l.time > med * 1.15) l.flags.push('slow');
  const valid = laps.filter(l => l.valid);
  const best = valid.reduce((b, l) => (!b || l.time < b.time ? l : b), null);
  let theoreticalSectors = null;
  if (track.sectors && track.sectors.length && valid.length && valid.every(l => l.sectors.length)) {
    const ns = valid[0].sectors.length;
    theoreticalSectors = 0;
    for (let j = 0; j < ns; j++) theoreticalSectors += Math.min(...valid.map(l => l.sectors[j]));
  }
  return { sf, auto: !track.sf, laps, best, theoreticalSectors, crossings: cr };
}

// ---------- 表示用 ----------
export function fmtLap(sec) {
  if (!Number.isFinite(sec)) return '--:--.---';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
export function fmtDelta(sec, digits = 3) {
  if (!Number.isFinite(sec)) return '';
  return (sec >= 0 ? '+' : '−') + Math.abs(sec).toFixed(digits);
}
export function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
export const kmh = (v) => v * 3.6;
