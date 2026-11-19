// セッション解析: 周回をコース上の距離 s にそろえ、コーナーごとの指標・理論ベスト・改善ポイントを出す
import * as C from './core.js';
import * as T from './track.js';

const kmh = (v) => v * 3.6;

export function analyzeSession(session, track, opts = {}) {
  const trace = C.processSession(session);
  if (!trace) return { error: 'データが少なすぎて解析できません' };
  let lapsRes = C.detectLaps(trace, track);
  const stored = track.model && track.model.pts && track.model.pts.length > 10 ? track.model : null;
  let model = null;
  const info = { built: false, merged: false, rotated: false, shift: null };

  if (stored) {
    model = T.loadModel(stored, trace.proj);
    // 別の日の GPS 位置ずれを補正
    let dx = 0, dy = 0;
    for (let it = 0; it < 3; it++) {
      const sh = T.estimateShift(model, trace, lapsRes.laps);
      if (!sh || sh.mag < 0.1 || sh.mag > 20) break;
      C.shiftTrace(trace, sh.dx, sh.dy); dx += sh.dx; dy += sh.dy;
    }
    if (dx || dy) { info.shift = { dx, dy, mag: Math.hypot(dx, dy) }; lapsRes = C.detectLaps(trace, track); }
    // S/F ラインが変更されていたら s=0 を移す
    if (track.sf) {
      const sfs = T.lineOnModel(model, trace.proj.toXY(track.sf.a.lat, track.sf.a.lon), trace.proj.toXY(track.sf.b.lat, track.sf.b.lon));
      if (sfs !== null && Math.min(sfs, model.L - sfs) > 3) { model = T.rotateModel(model, sfs); info.rotated = sfs; }
    }
    if (opts.merge !== false && !(stored.sessions || []).includes(session.id)) {
      const m2 = T.mergeModel(model, trace, lapsRes.laps);
      if (m2) { model = m2; info.merged = true; }
    }
  } else {
    model = T.buildModel(trace, lapsRes.laps);
    if (model) info.built = true;
  }

  let corners = [], modelUpdate = null;
  if (model) {
    if (info.built || info.merged || info.rotated !== false || !stored.corners) {
      let old = stored?.corners;
      if (old && info.rotated !== false) old = old.map(c => ({ ...c, sApex: ((c.sApex - info.rotated) % model.L + model.L) % model.L }));
      corners = T.transferCornerNames(old, T.detectCorners(model), model.L);
    } else corners = stored.corners.map(c => ({ ...c }));
    if (info.built || info.merged || info.rotated !== false || !stored.corners) {
      const sessions = [...new Set([...(stored?.sessions || []), session.id])];
      modelUpdate = T.serializeModel(model, trace.proj, { corners, sessions });
    }
  }

  const g = C.chooseG(trace, opts.gSource || 'auto');
  const bounds = model ? T.segmentBounds(corners, model.L) : [];
  const laps = lapsRes.laps;
  if (model) {
    for (const lap of laps) {
      const ch = alignLap(trace, lap, model, g);
      if (!ch) { lap.flags.push('nomatch'); lap.valid = false; continue; }
      lap.ch = ch;
      lap.stats = lapStats(ch);
      lap.segTimes = segTimes(ch, bounds);
      lap.cm = corners.map((c, i) => cornerMetrics(ch, c, {
        prevEnd: i > 0 ? corners[i - 1].s1 : (corners.length ? corners[corners.length - 1].s1 - model.L : -250),
        nextBound: bounds[i + 1], segTime: lap.segTimes[i],
        nextStart: i + 1 < corners.length ? corners[i + 1].s0 : Infinity,
      }));
    }
  }
  const valid = laps.filter(l => l.valid && l.ch);
  const best = valid.reduce((b, l) => (!b || l.time < b.time ? l : b), null);
  // 区間ベストと理論ベスト
  const segBest = bounds.slice(1).map((_, k) => {
    let b = null;
    for (const l of valid) if (!b || l.segTimes[k] < b.time) b = { time: l.segTimes[k], lap: l };
    return b;
  });
  const theoretical = segBest.length && segBest.every(Boolean) ? segBest.reduce((a, b) => a + b.time, 0) : null;
  const near = valid.filter(l => best && l.time <= best.time * 1.07);
  const mean = near.length ? near.reduce((a, l) => a + l.time, 0) / near.length : NaN;
  const sd = near.length > 1 ? Math.sqrt(near.reduce((a, l) => a + (l.time - mean) ** 2, 0) / (near.length - 1)) : NaN;
  let gripMax = 1;
  if (valid.length) {
    const combs = [];
    for (const l of valid) for (let i = 0; i < l.ch.comb.length; i += 3) combs.push(l.ch.comb[i]);
    gripMax = Math.max(0.5, C.percentile(combs, 0.98));
  }
  const res = {
    session, track, trace, model, corners, bounds, laps, best, valid,
    sf: lapsRes.sf, autoSF: lapsRes.auto,
    segBest, theoretical, theoreticalSectors: lapsRes.theoreticalSectors,
    consistency: { mean, sd, n: near.length },
    gripMax, gSrc: g, info, modelUpdate,
    perf: perfMetrics(trace),
    quality: qualityInfo(trace),
  };
  res.cornerStats = corners.map((c, k) => cornerStats(valid, k));
  res.opportunities = best ? opportunities(best, res) : [];
  res.summary = summarize(res);
  return res;
}

// ---------- 周回をコース距離の格子にそろえる ----------
const CH_NAMES = ['t', 'v', 'lg', 'la', 'lgG', 'laG', 'off', 'x', 'y', 'lat', 'lon', 'alt'];
function alignLap(trace, lap, m, g) {
  const p = T.lapXY(trace, lap);
  const pr = T.projectSeries(m, p.x, p.y);
  const n = p.ks.length;
  const s0 = pr.s[0], span = pr.s[n - 1] - s0;
  if (!(Math.abs(span - m.L) < 0.12 * m.L)) return null;
  let far = 0; for (let i = 0; i < n; i++) if (pr.d[i] > 25) far++;
  if (far > n * 0.1) return null;
  const scale = m.L / span;
  const S = new Float64Array(n);
  let mx = -Infinity;
  for (let i = 0; i < n; i++) { let v = (pr.s[i] - s0) * scale; if (v < mx) v = mx; mx = v; S[i] = v; }
  const src = {
    t: Float64Array.from(p.ks, k => C.interpAt(trace.t, k) - lap.start),
    v: Float64Array.from(p.ks, k => C.interpAt(trace.v, k)),
    lg: Float64Array.from(p.ks, k => C.interpAt(g.longG, k)),
    la: Float64Array.from(p.ks, k => C.interpAt(g.latG, k)),
    lgG: Float64Array.from(p.ks, k => C.interpAt(trace.longG, k)),
    laG: Float64Array.from(p.ks, k => C.interpAt(trace.latG, k)),
    off: pr.n,
    x: p.x, y: p.y,
    lat: Float64Array.from(p.ks, k => C.interpAt(trace.lat, k)),
    lon: Float64Array.from(p.ks, k => C.interpAt(trace.lon, k)),
    alt: Float64Array.from(p.ks, k => C.interpAt(trace.alt, k)),
  };
  const Ng = m.N + 1, step = m.step;
  const ch = { step, L: m.L, time: lap.time, N: Ng };
  for (const k of CH_NAMES) ch[k] = new Float64Array(Ng);
  let i = 0;
  for (let gq = 0; gq < Ng; gq++) {
    const s = gq * step;
    while (i < n - 2 && S[i + 1] < s) i++;
    const f = Math.max(0, Math.min(1, (s - S[i]) / ((S[i + 1] - S[i]) || 1)));
    for (const k of CH_NAMES) { const a = src[k]; ch[k][gq] = a[i] + (a[i + 1] - a[i]) * f; }
  }
  ch.t[0] = 0; ch.t[Ng - 1] = lap.time;
  ch.comb = new Float64Array(Ng);
  for (let q = 0; q < Ng; q++) ch.comb[q] = Math.hypot(ch.lg[q], ch.la[q]);
  return ch;
}

function lapStats(ch) {
  let vmax = 0, vmin = Infinity, maxBrake = 0, maxAcc = 0, maxLat = 0, maxComb = 0, tB = 0, tA = 0, tN = 0;
  const Ng = ch.t.length;
  for (let q = 0; q < Ng; q++) {
    vmax = Math.max(vmax, ch.v[q]); vmin = Math.min(vmin, ch.v[q]);
    maxBrake = Math.min(maxBrake, ch.lg[q]); maxAcc = Math.max(maxAcc, ch.lg[q]);
    maxLat = Math.max(maxLat, Math.abs(ch.la[q])); maxComb = Math.max(maxComb, ch.comb[q]);
    if (q < Ng - 1) {
      const d = ch.t[q + 1] - ch.t[q];
      if (ch.lg[q] < -0.1) tB += d; else if (ch.lg[q] > 0.05) tA += d; else tN += d;
    }
  }
  const tot = tB + tA + tN || 1;
  return { vmax, vmin, vavg: ch.L / ch.time, maxBrake, maxAcc, maxLat, maxComb, style: { brake: tB / tot, accel: tA / tot, neutral: tN / tot } };
}

export function timeAtS(ch, s) {
  const g = s / ch.step;
  return C.interpAt(ch.t, Math.max(0, Math.min(ch.t.length - 1, g)));
}
function segTimes(ch, bounds) {
  const out = [];
  for (let k = 0; k < bounds.length - 1; k++) out.push(timeAtS(ch, bounds[k + 1]) - timeAtS(ch, bounds[k]));
  return out;
}

// ---------- コーナー指標 ----------
function cornerMetrics(ch, c, ctx) {
  const st = ch.step, Ng = ch.t.length;
  const gi = (s) => Math.max(0, Math.min(Ng - 1, Math.round(s / st)));
  const a0 = gi(Math.min(c.s0, c.sApex) - 12);
  const a1 = gi(Math.min(Math.max(c.s1, c.sApex) + 12, ctx.nextStart ?? Infinity));
  let ap = a0;
  for (let q = a0; q <= a1; q++) if (ch.v[q] < ch.v[ap]) ap = q;
  // 区間の終わりでもまだ減速中 = 次のコーナーに向けたブレーキ。このコーナー自体はブレーキなしで通過
  const through = ap === a1 && a1 < Ng - 1 && ch.v[a1 + 1] < ch.v[a1] - 0.05;
  const w0 = gi(Math.max(ctx.prevEnd, c.sApex - 300));
  let pk = w0;
  for (let q = w0; q <= ap; q++) if (ch.lg[q] < ch.lg[pk]) pk = q;
  let brake = null;
  if (!through && ch.lg[pk] < -0.2) {
    let b = pk; while (b > w0 && ch.lg[b - 1] < -0.08) b--;
    let r = pk; while (r < a1 && ch.lg[r + 1] < -0.06) r++;
    brake = { s: b * st, sRelease: r * st, dist: (r - b) * st, vEntry: ch.v[b], maxG: ch.lg[pk], toApex: (ap - b) * st, time: ch.t[r] - ch.t[b] };
  }
  let th = null;
  const from = brake ? gi(brake.sRelease) : gi(c.s0 - 20);
  const to = Math.min(Ng - 2, gi(c.s1 + 80));
  for (let q = from; q < to; q++) if (ch.lg[q] > 0.06 && ch.lg[q + 1] > 0.06) { th = q; break; }
  const ex = gi(Math.min(c.s1 + 25, ctx.nextBound));
  let maxLat = 0;
  for (let q = gi(c.s0); q <= gi(c.s1); q++) maxLat = Math.max(maxLat, Math.abs(ch.la[q]));
  const vEntry = brake ? brake.vEntry : ch.v[gi(c.s0 - 30)];
  return {
    sApex: ap * st, vMin: ch.v[ap], offApex: ch.off[ap], through,
    brake, vEntry, sThrottle: th !== null ? th * st : null, vExit: ch.v[ex], maxLat, segTime: ctx.segTime,
    offEntry: ch.off[gi(c.s0 - 15)], offExit: ch.off[gi(c.s1 + 20)],
  };
}

function statsOf(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / (a.length - 1)) : 0;
  return { mean, sd, min: Math.min(...a), max: Math.max(...a), n: a.length };
}
function cornerStats(valid, k) {
  return {
    brakeS: statsOf(valid.map(l => l.cm[k].brake ? l.cm[k].brake.s : NaN)),
    vMin: statsOf(valid.map(l => l.cm[k].vMin)),
    vExit: statsOf(valid.map(l => l.cm[k].vExit)),
    offApex: statsOf(valid.map(l => l.cm[k].offApex)),
    seg: statsOf(valid.map(l => l.segTimes[k])),
  };
}

// ---------- 改善ポイント（区間ベストとの比較） ----------
export function cornerDiffNotes(c, a, b) {
  const notes = [];
  if (a.brake && b.brake) {
    const d = b.brake.s - a.brake.s;
    if (Math.abs(d) >= 4) notes.push({ w: Math.abs(d) / 4, text: d > 0 ? `ブレーキ開始が ${d.toFixed(0)}m 奥` : `ブレーキ開始が ${(-d).toFixed(0)}m 手前` });
  } else if (a.brake && !b.brake) notes.push({ w: 2, text: 'ブレーキを踏まずに通過' });
  const dv = kmh(b.vMin - a.vMin);
  if (Math.abs(dv) >= 1.5) notes.push({ w: Math.abs(dv) / 1.5, text: `最低速度 ${dv > 0 ? '+' : '−'}${Math.abs(dv).toFixed(1)} km/h` });
  if (a.sThrottle !== null && b.sThrottle !== null) {
    const d = a.sThrottle - b.sThrottle;
    if (Math.abs(d) >= 4) notes.push({ w: Math.abs(d) / 4, text: d > 0 ? `アクセルオンが ${d.toFixed(0)}m 早い` : `アクセルオンが ${(-d).toFixed(0)}m 遅い` });
  }
  const de = kmh(b.vExit - a.vExit);
  if (Math.abs(de) >= 1.5) notes.push({ w: Math.abs(de) / 1.5, text: `立ち上がり速度 ${de > 0 ? '+' : '−'}${Math.abs(de).toFixed(1)} km/h` });
  const inside = c.dir === 'R' ? 1 : -1;
  const doff = (b.offApex - a.offApex) * inside;
  if (Math.abs(doff) >= 0.8) notes.push({ w: Math.abs(doff) / 0.8, text: doff > 0 ? `クリップが ${doff.toFixed(1)}m イン寄り` : `クリップが ${(-doff).toFixed(1)}m アウト寄り` });
  return notes.sort((p, q) => q.w - p.w).map(n => n.text);
}

function opportunities(ref, res) {
  const items = [];
  res.corners.forEach((c, k) => {
    const sb = res.segBest[k];
    if (!sb || sb.lap === ref) return;
    const gain = ref.segTimes[k] - sb.time;
    if (gain < 0.03) return;
    items.push({ k, corner: c, gain, bestLap: sb.lap, notes: cornerDiffNotes(c, ref.cm[k], sb.lap.cm[k]).slice(0, 3) });
  });
  items.sort((a, b) => b.gain - a.gain);
  // 運転の傾向
  const tips = [];
  const st = ref.stats.style;
  if (st.neutral > 0.3) tips.push(`加速もブレーキもしていない時間が ${(st.neutral * 100).toFixed(0)}% あります。ブレーキからアクセルへの移行を早められないか見てみましょう。`);
  const cs = res.cornerStats.map((s, k) => ({ s, k })).filter(o => o.s.brakeS && o.s.brakeS.n >= 3 && o.s.brakeS.sd > 6);
  if (cs.length) tips.push(`ブレーキ開始位置のばらつきが大きいコーナー: ${cs.map(o => `${res.corners[o.k].name}（±${o.s.brakeS.sd.toFixed(0)}m）`).join('、')}。目標物を決めると安定します。`);
  return { items: items.slice(0, 3), tips, potential: res.theoretical ? ref.time - res.theoretical : null };
}

// ---------- 2ラップの比較 ----------
export function deltaSeries(ref, cmp) {
  const n = Math.min(ref.ch.t.length, cmp.ch.t.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = cmp.ch.t[i] - ref.ch.t[i];
  return out;
}
// 時刻 → コース距離（リプレイ用）
export function sAtTime(ch, t) {
  const T = ch.t;
  if (t <= 0) return 0;
  if (t >= T[T.length - 1]) return (T.length - 1) * ch.step;
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  return (lo + (t - T[lo]) / ((T[hi] - T[lo]) || 1)) * ch.step;
}

// ---------- 加速・減速性能（RaceBox / Dragy 風） ----------
function perfMetrics(trace) {
  const out = {};
  const pairs = [[50, 100], [40, 80], [60, 100]];
  for (const [a, b] of pairs) { const r = bestAccel(trace, a / 3.6, b / 3.6); if (r) { out.accel = { from: a, to: b, ...r }; break; } }
  for (const [b, a] of [[100, 50], [80, 40], [100, 60]]) { const r = bestBrake(trace, b / 3.6, a / 3.6); if (r) { out.brake = { from: b, to: a, ...r }; break; } }
  let vmax = 0, kmax = -1;
  for (let k = 0; k < trace.n; k++) if (trace.v[k] > vmax && !trace.gap[k]) { vmax = trace.v[k]; kmax = k; }
  out.vmax = vmax; out.kVmax = kmax;
  return out;
}
function crossTime(trace, k, v) { const a = trace.v[k - 1], b = trace.v[k]; const f = (v - a) / ((b - a) || 1); return trace.t[k - 1] + f * trace.dt; }
function crossDist(trace, k, v) { const a = trace.v[k - 1], b = trace.v[k]; const f = (v - a) / ((b - a) || 1); return trace.dist[k - 1] + f * (trace.dist[k] - trace.dist[k - 1]); }
function bestAccel(trace, v1, v2) {
  let best = null;
  for (let k = 1; k < trace.n; k++) {
    if (!(trace.v[k - 1] < v1 && trace.v[k] >= v1)) continue;
    const t1 = crossTime(trace, k, v1), d1 = crossDist(trace, k, v1);
    let peak = trace.v[k];
    for (let q = k + 1; q < trace.n; q++) {
      if (trace.gap[q]) break;
      if (trace.v[q] >= v2) {
        const t2 = crossTime(trace, q, v2), d2 = crossDist(trace, q, v2);
        if (!best || t2 - t1 < best.time) best = { time: t2 - t1, dist: d2 - d1 };
        break;
      }
      if (trace.v[q] < peak - 1) break;
      peak = Math.max(peak, trace.v[q]);
    }
  }
  return best;
}
function bestBrake(trace, v1, v2) {
  let best = null;
  for (let k = 1; k < trace.n; k++) {
    if (!(trace.v[k - 1] > v1 && trace.v[k] <= v1)) continue;
    const t1 = crossTime(trace, k, v1), d1 = crossDist(trace, k, v1);
    let low = trace.v[k];
    for (let q = k + 1; q < trace.n; q++) {
      if (trace.gap[q]) break;
      if (trace.v[q] <= v2) {
        const t2 = crossTime(trace, q, v2), d2 = crossDist(trace, q, v2);
        if (!best || d2 - d1 < best.dist) best = { time: t2 - t1, dist: d2 - d1 };
        break;
      }
      if (trace.v[q] > low + 1) break;
      low = Math.min(low, trace.v[q]);
    }
  }
  return best;
}

function qualityInfo(trace) {
  let gaps = 0;
  for (let k = 1; k < trace.n; k++) if (trace.gap[k] && !trace.gap[k - 1]) gaps++;
  const s = trace.sensor;
  return {
    rate: trace.rateHz, doppler: trace.useDoppler, heading: trace.useHdg, samples: trace.samplesUsed,
    accMedian: C.median(trace.acc), gaps,
    sensor: s ? { long: !!s.longOk, qLong: s.qLong, yaw: !!s.yawOk, qYaw: s.qYaw, hasGyro: s.hasGyro, units: s.gyroUnits } : null,
  };
}

// セッション一覧用の要約（コース形状のサムネイル付き）
function summarize(res) {
  const out = {
    laps: res.laps.length, valid: res.valid.length,
    best: res.best ? res.best.time : null, bestNo: res.best ? res.best.no : null,
    theoretical: res.theoretical, vmax: res.perf.vmax, track: res.track.name, trackId: res.track.id,
  };
  const m = res.model;
  if (m) {
    const pts = [];
    const stride = Math.max(1, Math.floor(m.N / 90));
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let j = 0; j < m.N; j += stride) { minx = Math.min(minx, m.x[j]); maxx = Math.max(maxx, m.x[j]); miny = Math.min(miny, m.y[j]); maxy = Math.max(maxy, m.y[j]); }
    const sc = 100 / Math.max(maxx - minx, maxy - miny, 1);
    for (let j = 0; j < m.N; j += stride) pts.push([+((m.x[j] - minx) * sc).toFixed(1), +((maxy - m.y[j]) * sc).toFixed(1)]);
    out.thumb = { pts, w: +((maxx - minx) * sc).toFixed(1), h: +((maxy - miny) * sc).toFixed(1) };
  }
  return out;
}
