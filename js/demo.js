// デモ用の疑似走行データ（架空のコース。実在コースの形状ではありません）
// 物理的にそれらしい速度プロファイル・ライン取りのばらつき・GPS誤差・端末センサーを合成し、
// テスト用に「正解データ（truth）」も返す。
import { makeProjection, gaussianSmooth, G, DEG } from './core.js';

// 架空コース: 多角形の頂点にフィレット（円弧）を入れて作る。[x, y, R]（m）
const SCALE = 1.5;
const VERTS = [
  [-90, 0, 20],    // 最終コーナー（右90°）
  [200, 0, 30],    // T1 ヘアピン前半（右90°）
  [200, -40, 30],  // T1 ヘアピン後半（右90°）
  [90, -40, 22],   // T2（左90°）
  [90, -110, 22],  // T3（右90°）
  [-50, -110, 18], // T4（右90°）
  [-50, -75, 25],  // T5 S字（左45°）
  [-90, -35, 25],  // T6 S字（右45°）
];

export function demoCenterline(step = 1) {
  const V = VERTS.map(([x, y, r]) => [x * SCALE, y * SCALE, r]);
  const n = V.length;
  const pts = [];
  const arcs = [];
  for (let i = 0; i < n; i++) {
    const P = V[i], A0 = V[(i - 1 + n) % n], B0 = V[(i + 1) % n];
    let d1 = [P[0] - A0[0], P[1] - A0[1]]; const l1 = Math.hypot(...d1); d1 = [d1[0] / l1, d1[1] / l1];
    let d2 = [B0[0] - P[0], B0[1] - P[1]]; const l2 = Math.hypot(...d2); d2 = [d2[0] / l2, d2[1] / l2];
    const crossz = d1[0] * d2[1] - d1[1] * d2[0];
    const phi = Math.atan2(crossz, d1[0] * d2[0] + d1[1] * d2[1]); // 左回り(CCW)が＋
    const R = P[2], Tl = R * Math.tan(Math.abs(phi) / 2);
    const A = [P[0] - d1[0] * Tl, P[1] - d1[1] * Tl];
    const right = phi < 0;
    const nrm = right ? [d1[1], -d1[0]] : [-d1[1], d1[0]];
    const C = [A[0] + nrm[0] * R, A[1] + nrm[1] * R];
    const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
    const steps = Math.max(4, Math.ceil(Math.abs(phi) * R / 0.5));
    arcs.push({ i, right, angle: Math.abs(phi) / DEG, R, startIdx: pts.length });
    for (let k = 0; k <= steps; k++) {
      const a = a0 + phi * (k / steps);
      pts.push([C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)]);
    }
    arcs[arcs.length - 1].endIdx = pts.length - 1;
  }
  // 弧長でリサンプル（閉路）
  const N0 = pts.length;
  const cum = [0];
  for (let i = 1; i <= N0; i++) { const a = pts[i - 1], b = pts[i % N0]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = cum[N0];
  // S/F はメインストレート（頂点0→1）の 40% 地点
  const arc0 = arcs[0], arc1 = arcs[1];
  const sSF = cum[arc0.endIdx] + 0.4 * (cum[arc1.startIdx] - cum[arc0.endIdx]);
  const N = Math.round(L / step), st = L / N;
  const x = new Float64Array(N), y = new Float64Array(N);
  let i = 0;
  for (let j = 0; j < N; j++) {
    const s = (sSF + j * st) % L;
    if (j === 0 || s < cum[i]) i = 0;
    while (i < N0 - 1 && cum[i + 1] < s) i++;
    while (i < N0 && cum[i + 1] < s) i++;
    const f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    const a = pts[i % N0], b = pts[(i + 1) % N0];
    x[j] = a[0] + (b[0] - a[0]) * f; y[j] = a[1] + (b[1] - a[1]) * f;
  }
  // 各コーナー（円弧）の s 範囲
  const raw = arcs.map(a => {
    const s0 = ((cum[a.startIdx] - sSF) % L + L) % L, s1 = ((cum[a.endIdx] - sSF) % L + L) % L;
    return { s0, s1: s1 < s0 ? s1 + L : s1, right: a.right, angle: a.angle, R: a.R };
  }).sort((p, q) => p.s0 - q.s0);
  // 直線を挟まずに続く同じ向きの円弧（ヘアピン）は1つのコーナーにまとめる
  const corners = [];
  for (const c of raw) {
    const p = corners[corners.length - 1];
    if (p && p.right === c.right && c.s0 - p.s1 < 3) { p.s1 = c.s1; p.angle += c.angle; } else corners.push({ ...c });
  }
  return { x, y, N, step: st, L, corners };
}

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randn(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const smoothstep = (t) => t * t * (3 - 2 * t);

// 1周分のライン（センターラインからの横位置, 右が＋）
function lapOffsets(cl, rng, cornerVar, lapVar) {
  const { N, step, L } = cl;
  const half = 4.1; // コース幅 10m − 車幅分
  const tg = [];
  // 隣接するコーナー同士でアウト側の点が重なる場合は片方を省く
  cl.corners.forEach((c, ci) => {
    const inside = c.right ? 1 : -1;
    const mid = (c.s0 + c.s1) / 2;
    const v = cornerVar[ci];
    tg.push({ s: c.s0 - 22 + v.entry * 4, o: -inside * (3.4 + v.out * 0.5) });
    tg.push({ s: mid + (c.angle > 120 ? 6 : 2) + v.apexS * 3, o: inside * Math.min(half, 3.6 + v.apex * lapVar) });
    tg.push({ s: c.s1 + 28 + v.exitS * 4, o: -inside * (3.6 + v.exit * 0.5) });
  });
  tg.forEach(p => { p.s = ((p.s % L) + L) % L; });
  tg.sort((a, b) => a.s - b.s);
  const pts = [];
  for (const p of tg) { const q = pts[pts.length - 1]; if (q && p.s - q.s < 14) { q.s = (q.s + p.s) / 2; q.o = (q.o + p.o) / 2; } else pts.push({ ...p }); }
  const off = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const s = j * step;
    let k = pts.findIndex(p => p.s > s);
    const a = k <= 0 ? pts[pts.length - 1] : pts[k - 1];
    const b = k < 0 ? pts[0] : pts[k];
    let sa = a.s, sb = b.s;
    if (sa > s) sa -= L;
    if (sb < s) sb += L;
    const f = smoothstep((s - sa) / ((sb - sa) || 1));
    off[j] = Math.max(-half, Math.min(half, a.o + (b.o - a.o) * f));
  }
  // 実際のハンドル操作のように滑らかにする（曲率の急変を防ぐ）
  const sm = gaussianSmooth(off, 9 / step, { circular: true });
  for (let j = 0; j < N; j++) off[j] = Math.max(-half, Math.min(half, sm[j]));
  return off;
}

// opts: { laps, rateHz, seed, center:[lat,lon], skill, motion, gyroUnits:'deg'|'rad', startDate }
export function makeDemoSession(opts = {}) {
  const nLaps = opts.laps ?? 8, rate = opts.rateHz ?? 1, seed = opts.seed ?? 7;
  const skill = opts.skill ?? 1;
  const [lat0, lon0] = opts.center ?? [36.205, 139.105];
  const rng = mulberry32(seed);
  const proj = makeProjection(lat0, lon0);
  const cl = demoCenterline(1);
  const { N, step, L } = cl;
  // 右法線
  const nx = new Float64Array(N), ny = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const a = (j - 1 + N) % N, b = (j + 1) % N;
    const tx = cl.x[b] - cl.x[a], ty = cl.y[b] - cl.y[a], l = Math.hypot(tx, ty);
    nx[j] = ty / l; ny[j] = -tx / l;
  }
  const nC = cl.corners.length;
  // ラップ構成: 0=アウトラップ(部分), 1..nLaps=計測ラップ, nLaps+1=インラップ(部分)
  const lapsDef = [];
  for (let i = 0; i <= nLaps + 1; i++) {
    const learn = Math.min(1, i / 4);
    const mu = (0.95 + 0.04 * learn) * skill * (1 + randn(rng) * 0.01);
    const cornerVar = Array.from({ length: nC }, () => ({ entry: randn(rng), apex: randn(rng), apexS: randn(rng), exit: randn(rng), exitS: randn(rng), out: randn(rng), brake: 0.92 + 0.06 * learn + randn(rng) * 0.03 }));
    lapsDef.push({ mu, cornerVar, off: lapOffsets(cl, rng, cornerVar, 0.6 + 0.3 * (1 - learn)) });
  }
  // ミス（ワイドになって失速）を1か所入れる
  const mistakeLap = Math.min(nLaps, 3 + Math.floor(rng() * 3));
  const mistakeCorner = Math.floor(rng() * nC);
  lapsDef[mistakeLap].cornerVar[mistakeCorner].brake *= 0.82;
  {
    const c = cl.corners[mistakeCorner];
    const inside = c.right ? 1 : -1;
    const off = lapsDef[mistakeLap].off;
    for (let j = 0; j < N; j++) {
      const s = j * step;
      const d = ((s - (c.s1 + 10)) % L + L) % L;
      const w = d < 40 ? Math.sin(Math.PI * d / 40) : 0;
      off[j] = Math.max(-4.1, Math.min(4.1, off[j] - inside * 2.2 * w));
    }
  }

  // 走行経路を連結（アウトラップは S/F の 260m 手前から、インラップは 320m まで）
  const P = []; // {x, y, lap, sc}
  const outStart = Math.round((L - 260) / step);
  const inEnd = Math.round(320 / step);
  for (let i = 0; i <= nLaps + 1; i++) {
    const j0 = i === 0 ? outStart : 0;
    const j1 = i === nLaps + 1 ? inEnd : N;
    const off = lapsDef[Math.min(i, nLaps + 1)].off;
    for (let j = j0; j < j1; j++) P.push({ x: cl.x[j] + off[j] * nx[j], y: cl.y[j] + off[j] * ny[j], lap: i, sc: j * step, cj: j });
  }
  const M = P.length;
  const ds = new Float64Array(M), kap = new Float64Array(M), hd = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const a = P[Math.max(0, k - 1)], b = P[Math.min(M - 1, k + 1)];
    hd[k] = Math.atan2(b.x - a.x, b.y - a.y);
    if (k > 0) ds[k] = Math.hypot(P[k].x - P[k - 1].x, P[k].y - P[k - 1].y);
  }
  for (let k = 0; k < M; k++) {
    const a = Math.max(0, k - 2), b = Math.min(M - 1, k + 2);
    let d = hd[b] - hd[a]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    let sl = 0; for (let q = a + 1; q <= b; q++) sl += ds[q];
    kap[k] = d / (sl || 1);
  }
  // 次に来るコーナー番号（ブレーキ強さのばらつき用）
  const nextCorner = (sc) => { for (let ci = 0; ci < nC; ci++) if (cl.corners[ci].s1 > sc) return ci; return 0; };
  // 速度プロファイル
  const vmax = 48, Pm = 92; // 出力重量比 W/kg 相当
  const lim = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const p = P[k];
    let mu = lapsDef[p.lap].mu;
    if (p.lap === 0) mu *= 0.85; // タイヤが冷えている
    lim[k] = Math.min(vmax, Math.sqrt(mu * G / Math.max(1e-4, Math.abs(kap[k]))));
    if (p.lap === 0 && k < 140) lim[k] = Math.min(lim[k], 14); // ピット出口
    if (p.lap === nLaps + 1 && p.sc > 60) lim[k] = Math.min(lim[k], 16);
  }
  lim[M - 1] = 0;
  const v = new Float64Array(M);
  v[0] = 2;
  for (let k = 1; k < M; k++) {
    const a = Math.min(0.62 * G, Pm / Math.max(3, v[k - 1])) - 0.00038 * v[k - 1] ** 2 - 0.12;
    v[k] = Math.min(lim[k], Math.sqrt(Math.max(0, v[k - 1] ** 2 + 2 * a * ds[k])));
  }
  for (let k = M - 2; k >= 0; k--) {
    const p = P[k];
    const ci = nextCorner(p.sc);
    const brk = 0.98 * G * lapsDef[p.lap].cornerVar[ci].brake;
    v[k] = Math.min(v[k], Math.sqrt(v[k + 1] ** 2 + 2 * brk * ds[k + 1]));
  }
  const tt = new Float64Array(M);
  for (let k = 1; k < M; k++) tt[k] = tt[k - 1] + ds[k] / Math.max(0.5, 0.5 * (v[k] + v[k - 1]));
  const Tend = tt[M - 1];
  // 正解ラップタイム（センターライン s=0 の通過時刻）
  const lapStarts = [];
  for (let k = 1; k < M; k++) if (P[k].lap !== P[k - 1].lap && P[k].lap >= 1) lapStarts.push(tt[k]);
  const truthLapTimes = [];
  for (let i = 1; i < lapStarts.length; i++) truthLapTimes.push(lapStarts[i] - lapStarts[i - 1]);

  const t0 = opts.startDate ?? Date.UTC(2026, 10, 22, 1, 0, 0);
  // 時刻 → 経路上の状態
  let hk = 0;
  const stateAt = (t) => {
    while (hk < M - 2 && tt[hk + 1] < t) hk++;
    while (hk > 0 && tt[hk] > t) hk--;
    const f = Math.max(0, Math.min(1, (t - tt[hk]) / ((tt[hk + 1] - tt[hk]) || 1)));
    const a = P[hk], b = P[hk + 1];
    let dh = hd[hk + 1] - hd[hk]; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, v: v[hk] + (v[hk + 1] - v[hk]) * f, h: hd[hk] + dh * f, kap: kap[hk] + (kap[hk + 1] - kap[hk]) * f, k: hk };
  };
  // GPS
  const samples = [];
  let nxr = 0, nyr = 0, nalt = 0;
  const aAR = Math.exp(-(1 / rate) / 4);
  for (let t = 0; t <= Tend; t += 1 / rate) {
    const st = stateAt(t);
    const gn = opts.gpsNoise ?? 1;
    nxr = aAR * nxr + Math.sqrt(1 - aAR * aAR) * randn(rng) * 1.1 * gn;
    nyr = aAR * nyr + Math.sqrt(1 - aAR * aAR) * randn(rng) * 1.1 * gn;
    nalt = aAR * nalt + Math.sqrt(1 - aAR * aAR) * randn(rng) * 2.5;
    const [la, lo] = proj.toLatLon(st.x + nxr + randn(rng) * 0.25 * gn, st.y + nyr + randn(rng) * 0.25 * gn);
    const sc = P[st.k].sc;
    const alt = 92 + 2.2 * Math.sin(2 * Math.PI * sc / L) + 1.1 * Math.sin(4 * Math.PI * sc / L + 1);
    samples.push({
      t: Math.round(t0 + t * 1000), lat: la, lon: lo, alt: alt + nalt, acc: 3 + Math.abs(randn(rng)) * 1.2,
      spd: Math.max(0, st.v + randn(rng) * 0.12 * (opts.gpsNoise ?? 1)),
      hdg: st.v > 1 ? (((st.h / DEG + randn(rng) * 0.9 * (opts.gpsNoise ?? 1)) % 360) + 360) % 360 : undefined,
    });
  }
  // 端末センサー（25Hz）。取り付け向きはランダム
  const motion = [];
  if (opts.motion !== false) {
    const yawM = rng() * 2 * Math.PI, pitch = (10 + rng() * 25) * DEG, roll = (randn(rng) * 6) * DEG;
    // 車体座標 (x前, y左, z上) → 端末座標 の回転行列 R = Rx(roll)·Ry(pitch)·Rz(yaw)
    const Rz = [[Math.cos(yawM), -Math.sin(yawM), 0], [Math.sin(yawM), Math.cos(yawM), 0], [0, 0, 1]];
    const Ry = [[Math.cos(pitch), 0, Math.sin(pitch)], [0, 1, 0], [-Math.sin(pitch), 0, Math.cos(pitch)]];
    const Rx = [[1, 0, 0], [0, Math.cos(roll), -Math.sin(roll)], [0, Math.sin(roll), Math.cos(roll)]];
    const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    const R = mul(Rx, mul(Ry, Rz));
    const ap = (vec) => [0, 1, 2].map(i => R[i][0] * vec[0] + R[i][1] * vec[1] + R[i][2] * vec[2]);
    const units = opts.gyroUnits === 'rad' ? 1 : 1 / DEG;
    const bias = [randn(rng) * 0.004, randn(rng) * 0.004, randn(rng) * 0.004];
    let prevV = stateAt(0).v;
    const dtm = 0.04;
    for (let t = dtm; t <= Tend; t += dtm) {
      const st = stateAt(t);
      const along = (st.v - prevV) / dtm; prevV = st.v;
      const latR = st.v * st.v * st.kap, yawR = st.v * st.kap; // 右旋回が＋
      const acc = ap([along + randn(rng) * 0.35, -latR + randn(rng) * 0.35, G + randn(rng) * 0.3]);
      const gyr = ap([randn(rng) * 0.01, randn(rng) * 0.01, -yawR + randn(rng) * 0.008]);
      motion.push(Math.round(t0 + t * 1000), +acc[0].toFixed(3), +acc[1].toFixed(3), +acc[2].toFixed(3),
        +((gyr[2] + bias[2]) * units).toFixed(4), +((gyr[0] + bias[0]) * units).toFixed(4), +((gyr[1] + bias[1]) * units).toFixed(4));
    }
  }
  // 正解データ
  const truth = {
    lapTimes: truthLapTimes, L, corners: cl.corners, centerline: { x: cl.x, y: cl.y }, proj,
    offsets: lapsDef.slice(1, nLaps + 1).map(d => d.off), mistake: { lap: mistakeLap, corner: mistakeCorner },
    path: { x: P.map(p => p.x), y: P.map(p => p.y), t: Array.from(tt), v: Array.from(v), kap: Array.from(kap), lap: P.map(p => p.lap), sc: P.map(p => p.sc) },
    sfLine: (() => {
      const h = Math.atan2(cl.x[1] - cl.x[N - 1], cl.y[1] - cl.y[N - 1]);
      const ex = Math.cos(h), ey = -Math.sin(h);
      const [la1, lo1] = proj.toLatLon(cl.x[0] - ex * 20, cl.y[0] - ey * 20);
      const [la2, lo2] = proj.toLatLon(cl.x[0] + ex * 20, cl.y[0] + ey * 20);
      return { a: { lat: la1, lon: lo1 }, b: { lat: la2, lon: lo2 } };
    })(),
  };
  return {
    name: opts.name ?? `デモ走行（${rate}Hz）`,
    startedAt: t0,
    demo: true,
    trackId: 'demo',
    samples,
    motion,
    meta: { device: 'demo', rateHz: rate, motionStride: 7 },
    info: opts.info ?? {},
    truth,
  };
}
