// デモ用の疑似走行データ生成（架空のコースレイアウト。実コースの形状ではありません）
import { makeProjection, G } from './core.js';

// 架空コースの制御点（m, 時計回り）。全長はおよそ 1.1 km
const CTRL = [
  [0, 0], [120, 0], [230, 5], [270, 40], [265, 95], [220, 120], [170, 110], [140, 140],
  [150, 190], [200, 215], [235, 260], [210, 300], [140, 305], [70, 280], [20, 230],
  [-10, 170], [-50, 130], [-80, 80], [-60, 25],
];

function closedSpline(ctrl, perSeg = 60) {
  const n = ctrl.length, pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let j = 0; j < perSeg; j++) {
      const u = j / perSeg, u2 = u * u, u3 = u2 * u;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      pts.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return pts;
}

function resamplePath(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  const all = pts.concat([pts[0]]);
  for (let i = 1; i < all.length; i++) {
    const [ax, ay] = all[i - 1], [bx, by] = all[i];
    const seg = Math.hypot(bx - ax, by - ay);
    let pos = step - carry;
    while (pos <= seg) { const f = pos / seg; out.push([ax + (bx - ax) * f, ay + (by - ay) * f]); pos += step; }
    carry = seg - (pos - step);
  }
  return out;
}

function randn(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// opts: { laps, rateHz, center:[lat,lon], seed, motion }
export function makeDemoSession(opts = {}) {
  const laps = opts.laps ?? 8, rate = opts.rateHz ?? 1, seed = opts.seed ?? 7;
  const [lat0, lon0] = opts.center ?? [36.19, 139.13];
  const rng = mulberry32(seed);
  const proj = makeProjection(lat0, lon0);
  const ds = 1;
  const path = resamplePath(closedSpline(CTRL), ds);
  const N = path.length;
  // 曲率
  const kappa = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = path[(i - 3 + N) % N], b = path[i], c = path[(i + 3) % N];
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let d = h2 - h1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    kappa[i] = d / ((Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2);
  }
  const vmaxCar = 33;
  const t0 = Date.UTC(2026, 10, 22, 1, 0, 0);
  const samples = [], motion = [];
  // 取り付け向き（ランダムな回転）
  const yawM = rng() * Math.PI * 2, tilt = 0.5;
  let t = 0, s = 0, lapIdx = -1;
  let v = 0;
  const dtSim = 0.01;
  // ラップごとの速度プロファイル
  let profile = null;
  const makeProfile = (latLim, brk, acc) => {
    const vlim = new Float64Array(N);
    for (let i = 0; i < N; i++) vlim[i] = Math.min(vmaxCar, Math.sqrt(latLim * G / Math.max(1e-4, Math.abs(kappa[i]))));
    const p = Float64Array.from(vlim);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < N * 2; i++) { const a = i % N, b = (i - 1) % N; p[a] = Math.min(p[a], Math.sqrt(p[b] ** 2 + 2 * acc * G * ds)); }
      for (let i = N * 2; i > 0; i--) { const a = i % N, b = (i + 1) % N; p[a] = Math.min(p[a], Math.sqrt(p[b] ** 2 + 2 * brk * G * ds)); }
    }
    return p;
  };
  let nextGps = 0, nextMot = 0;
  const totalDist = N * ds * (laps + 1.3);
  let prevV = 0;
  // GPS 位置誤差: ゆっくり変動する成分 + 白色雑音
  let nx = 0, ny = 0;
  while (s < totalDist) {
    const curLap = Math.floor((s + 0.3 * N * ds) / (N * ds));
    if (curLap !== lapIdx) {
      lapIdx = curLap;
      const skill = 0.88 + 0.1 * Math.min(1, lapIdx / 4) + randn(rng) * 0.025;
      profile = makeProfile(1.05 * skill, 0.95 * skill, 0.42);
    }
    const idx = Math.floor((s / ds) % N);
    const target = lapIdx === 0 && s < 0.3 * N * ds ? Math.min(profile[idx], 15) : profile[idx];
    const pitIn = s > N * ds * (laps + 1);
    const tv = pitIn ? Math.min(target, 12) : target;
    v = v < tv ? Math.min(tv, v + 0.45 * G * dtSim) : Math.max(tv, v - 1.0 * G * dtSim);
    if (t === 0) v = 0.5;
    s += v * dtSim; t += dtSim;
    const p = path[idx], q = path[(idx + 1) % N];
    const f = (s / ds) % 1;
    const x = p[0] + (q[0] - p[0]) * f, y = p[1] + (q[1] - p[1]) * f;
    const pa = path[(idx - 2 + N) % N], pb = path[(idx + 2) % N];
    const h = Math.atan2(pb[0] - pa[0], pb[1] - pa[1]);
    if (t >= nextMot && opts.motion !== false) {
      nextMot += 0.05;
      const along = (v - prevV) / 0.05, lat = v * v * kappa[idx];
      prevV = v;
      // 車体座標 (前, 右, 上) → 端末座標
      const fwd = along + randn(rng) * 0.6, right = lat + randn(rng) * 0.6, up = G + randn(rng) * 0.4;
      const cx = Math.cos(yawM), sx = Math.sin(yawM);
      const ax = fwd * cx - right * sx, ay = fwd * sx + right * cx;
      const az = up * Math.cos(tilt) + ax * Math.sin(tilt);
      const ax2 = ax * Math.cos(tilt) - up * Math.sin(tilt);
      motion.push(t0 + t * 1000, ax2, ay, az);
    }
    if (t >= nextGps) {
      nextGps += 1 / rate;
      const a = Math.exp(-(1 / rate) / 4);
      nx = a * nx + Math.sqrt(1 - a * a) * randn(rng) * 1.2;
      ny = a * ny + Math.sqrt(1 - a * a) * randn(rng) * 1.2;
      const [la, lo] = proj.toLatLon(x + nx + randn(rng) * 0.25, y + ny + randn(rng) * 0.25);
      samples.push({ t: Math.round(t0 + t * 1000), lat: la, lon: lo, alt: 90, acc: 4, spd: Math.max(0, v + randn(rng) * 0.25), hdg: ((h * 180 / Math.PI + randn(rng) * 0.8) + 360) % 360 });
    }
  }
  return {
    name: `デモ走行（架空コース・${rate}Hz）`,
    startedAt: t0,
    demo: true,
    samples,
    motion: opts.motion === false ? [] : motion,
    meta: { device: 'demo', rateHz: rate },
  };
}
