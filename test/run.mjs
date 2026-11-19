// 解析ロジックのテスト（デモデータの正解値と比較）: node test/run.mjs
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import * as T from '../js/track.js';
import * as A from '../js/analysis.js';
import * as IO from '../js/io.js';
import { makeDemoSession } from '../js/demo.js';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const rms = (a) => Math.sqrt(mean(a.map(v => v * v)));

function truthTools(ses) {
  const tr = ses.truth, P = tr.path;
  const at = (t) => {
    let lo = 0, hi = P.t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.t[m] <= t) lo = m; else hi = m; }
    const f = (t - P.t[lo]) / ((P.t[hi] - P.t[lo]) || 1);
    return { v: P.v[lo] + (P.v[hi] - P.v[lo]) * f, kap: P.kap[lo] + (P.kap[hi] - P.kap[lo]) * f };
  };
  return { tr, P, at };
}

await test('1Hz: 周回検出とラップタイム（真値 ±0.25秒）', () => {
  const ses = makeDemoSession({ laps: 8, rateHz: 1, seed: 11 });
  const tr = ses.truth;
  const t = C.processSession(ses);
  const r = C.detectLaps(t, { sf: tr.sfLine, minLapSec: 20 });
  assert.equal(r.laps.length, tr.lapTimes.length);
  const err = r.laps.map((l, i) => l.time - tr.lapTimes[i]);
  assert.ok(Math.max(...err.map(Math.abs)) < 0.25, `lap errors ${err.map(e => e.toFixed(3))}`);
  assert.ok(rms(err) < 0.12, `rms ${rms(err)}`);
});

await test('ノイズなしならラップタイム誤差 0.02秒未満（補間方式の検証）', () => {
  const ses = makeDemoSession({ laps: 5, rateHz: 1, seed: 3, gpsNoise: 0 });
  const t = C.processSession(ses);
  const r = C.detectLaps(t, { sf: ses.truth.sfLine, minLapSec: 20 });
  r.laps.forEach((l, i) => assert.ok(Math.abs(l.time - ses.truth.lapTimes[i]) < 0.02, `${l.time} vs ${ses.truth.lapTimes[i]}`));
});

await test('S/F 自動設定（周回する場所の最高速地点）で全周回を検出', () => {
  const ses = makeDemoSession({ laps: 6, rateHz: 1, seed: 4 });
  const t = C.processSession(ses);
  const r = C.detectLaps(t, {});
  assert.ok(r.auto && r.sf);
  assert.ok(r.laps.length >= 6, `laps ${r.laps.length}`);
});

await test('センサー融合: ジャイロの単位(deg/rad)・符号を自動判定し横Gを高精度化', () => {
  for (const units of ['deg', 'rad']) {
    const ses = makeDemoSession({ laps: 5, rateHz: 1, seed: 8, gyroUnits: units });
    const { at } = truthTools(ses);
    const t = C.processSession(ses);
    assert.ok(t.sensor.yawOk && t.sensor.longOk, JSON.stringify({ q: t.sensor.qYaw, ql: t.sensor.qLong }));
    assert.equal(t.sensor.gyroUnits, units === 'deg' ? 'deg/s' : 'rad/s');
    const eg = [], es = [];
    for (let k = 0; k < t.n; k++) {
      const g = at(t.t[k]); if (g.v < 5) continue;
      const lt = g.v * g.v * g.kap / C.G;
      eg.push(t.latG[k] - lt); es.push(t.sensor.latGyro[k] - lt);
    }
    assert.ok(rms(es) < 0.1, `gyro latG rms ${rms(es)}`);
    assert.ok(rms(es) < rms(eg) * 0.6, `gyro ${rms(es)} vs gps ${rms(eg)}`);
  }
});

await test('速度融合: 1Hz GPS のピーク速度の取りこぼしを補正', () => {
  const ses = makeDemoSession({ laps: 6, rateHz: 1, seed: 11 });
  const { at } = truthTools(ses);
  const res = {};
  for (const fuse of [false, true]) {
    const t = C.processSession(ses, { fuseSpeed: fuse });
    const e = [];
    for (let k = 0; k < t.n; k++) { const g = at(t.t[k]); if (g.v > 3) e.push((t.v[k] - g.v) * 3.6); }
    res[fuse] = rms(e);
  }
  assert.ok(res.true < 1.2 && res.true < res.false * 0.5, JSON.stringify(res));
});

let A1 = null, S1 = null;
await test('コースモデル: 長さ・コーナー数と向き', () => {
  S1 = makeDemoSession({ laps: 8, rateHz: 1, seed: 11 });
  S1.id = 'A';
  const track = { id: 'demo', name: 'demo', sf: S1.truth.sfLine, sectors: [], minLapSec: 20 };
  A1 = A.analyzeSession(S1, track, {});
  assert.ok(A1.info.built && A1.modelUpdate);
  const P = S1.truth.path;
  const lens = [];
  for (let lap = 1; lap <= S1.truth.lapTimes.length; lap++) {
    let d = 0;
    for (let k = 1; k < P.x.length; k++) if (P.lap[k] === lap && P.lap[k - 1] === lap) d += Math.hypot(P.x[k] - P.x[k - 1], P.y[k] - P.y[k - 1]);
    lens.push(d);
  }
  assert.ok(Math.abs(A1.model.L - mean(lens)) < 12, `model ${A1.model.L} vs ${mean(lens)}`);
  const dirs = A1.corners.map(c => c.dir).join('');
  assert.ok(A1.corners.length >= 6 && A1.corners.length <= 7, `corners ${dirs}`);
  assert.equal(A1.corners[0].dir, 'R'); assert.ok(A1.corners[0].angle > 140, 'T1 is a hairpin');
  assert.equal(A1.corners[1].dir, 'L');
  assert.ok(A1.theoretical <= A1.best.time + 1e-9);
  assert.ok(A1.laps.filter(l => l.ch).every(l => Math.abs(l.segTimes.reduce((a, b) => a + b, 0) - l.time) < 1e-6), 'segments sum to lap time');
});

await test('ブレーキ開始位置: 真値との差 平均±5m・RMS 8m 以内（1Hz + センサー）', () => {
  const { P } = truthTools(S1);
  const tr = S1.truth;
  const cum = [0]; for (let k = 1; k < P.x.length; k++) cum.push(cum[k - 1] + Math.hypot(P.x[k] - P.x[k - 1], P.y[k] - P.y[k - 1]));
  const nearest = (ks, lat, lon) => { const [x, y] = tr.proj.toXY(lat, lon); let b = -1, bd = Infinity; for (const k of ks) { const d = (P.x[k] - x) ** 2 + (P.y[k] - y) ** 2; if (d < bd) { bd = d; b = k; } } return b; };
  const dec = (q) => (P.v[q] - P.v[q - 1]) / ((P.t[q] - P.t[q - 1]) || 1) / C.G;
  const err = [];
  for (const l of A1.valid) {
    const ks = []; for (let k = 0; k < P.x.length; k++) if (P.lap[k] === l.no) ks.push(k);
    A1.corners.forEach((c, ci) => {
      const b = l.cm[ci].brake; if (!b) return;
      const g = (s) => Math.round(s / l.ch.step);
      const kE = nearest(ks, l.ch.lat[g(b.s)], l.ch.lon[g(b.s)]);
      const kA = nearest(ks, l.ch.lat[g(l.cm[ci].sApex)], l.ch.lon[g(l.cm[ci].sApex)]);
      const sPrev = ci > 0 ? A1.corners[ci - 1].s1 : 0;
      const kP = nearest(ks, l.ch.lat[g(sPrev)], l.ch.lon[g(sPrev)]);
      let pk = kA; for (let q = Math.max(ks[0] + 1, kP); q <= kA; q++) if (dec(q) < dec(pk)) pk = q;
      let kk = pk; while (kk > Math.max(ks[0] + 1, kP) && dec(kk - 1) < -0.08) kk--;
      err.push(cum[kE] - cum[kk]);
    });
  }
  const sorted = err.map(Math.abs).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  assert.ok(Math.abs(mean(err)) < 5 && rms(err) < 8, `mean ${mean(err).toFixed(1)} rms ${rms(err).toFixed(1)} p90 ${p90} n ${err.length}`);
});

await test('改善ポイントとコーナー統計が出る', () => {
  assert.ok(A1.opportunities.items.length >= 1);
  const o = A1.opportunities.items[0];
  assert.ok(o.gain > 0 && o.notes.length >= 1, JSON.stringify(o.notes));
  assert.ok(A1.cornerStats.length === A1.corners.length);
  assert.ok(A1.perf.accel && A1.perf.brake, JSON.stringify(A1.perf));
  assert.ok(A1.summary.thumb && A1.summary.thumb.pts.length > 30);
});

await test('別セッション: GPS 位置ずれ補正・モデル統合・同じ距離軸で比較', () => {
  const stored = A1.modelUpdate;
  const track = { id: 'demo', name: 'demo', sf: S1.truth.sfLine, sectors: [], minLapSec: 20, model: stored };
  const S2 = makeDemoSession({ laps: 6, rateHz: 1, seed: 12, skill: 1.02 });
  S2.id = 'B';
  // 全体を東へ 3m・南へ 2m ずらす（別の日の GPS 誤差を模擬）
  const p = C.makeProjection(S2.samples[0].lat, S2.samples[0].lon);
  for (const s of S2.samples) { const [x, y] = p.toXY(s.lat, s.lon); const [la, lo] = p.toLatLon(x + 3, y - 2); s.lat = la; s.lon = lo; }
  const r2 = A.analyzeSession(S2, track, {});
  assert.ok(r2.info.shift && Math.abs(r2.info.shift.mag - Math.hypot(3, 2)) < 1.2, JSON.stringify(r2.info.shift));
  assert.ok(r2.info.merged, 'merged');
  assert.equal(r2.corners.length, A1.corners.length);
  assert.ok(r2.best.ch.t.length === A1.best.ch.t.length || Math.abs(r2.best.ch.t.length - A1.best.ch.t.length) <= 2);
  const d = A.deltaSeries(A1.best, r2.best);
  assert.ok(Math.abs(d[d.length - 1] - (r2.best.time - A1.best.time)) < 0.05);
});

await test('モデルの保存・復元・S/F 変更（回転）', () => {
  const p = A1.trace.proj;
  const m2 = T.loadModel(A1.modelUpdate, p);
  assert.ok(Math.abs(m2.L - A1.model.L) < 0.5);
  const r = T.rotateModel(m2, 100);
  assert.ok(Math.hypot(r.x[0] - m2.x[100], r.y[0] - m2.y[100]) < 1.5);
});

await test('読込: 本アプリ CSV / GPX の往復', () => {
  const ses = makeDemoSession({ laps: 2, rateHz: 1, motion: false });
  const back = IO.parseCSV(IO.toCSV(ses));
  assert.equal(back.length, ses.samples.length);
  assert.ok(Math.abs(back[10].spd - ses.samples[10].spd) < 0.01);
  assert.ok(Math.abs(back[10].t - ses.samples[10].t) < 1);
  const g = IO.parseGPX(IO.toGPX(ses));
  assert.equal(g.length, ses.samples.length);
  assert.ok(Math.abs(g[5].hdg - ses.samples[5].hdg) < 0.1);
});

await test('読込: NMEA（RMC + GGA を統合）', () => {
  const txt = [
    '$GPGGA,010203.00,3611.4000,N,13907.8000,E,1,09,0.9,95.2,M,39.0,M,,*00',
    '$GPRMC,010203.00,A,3611.4000,N,13907.8000,E,20.0,90.0,221126,,,A*00',
    '$GPRMC,010203.10,A,3611.4010,N,13907.8100,E,20.5,91.0,221126,,,A*00',
  ].join('\n');
  const r = IO.parseFile(txt, 'x.nmea');
  assert.equal(r.format, 'NMEA');
  assert.equal(r.samples.length, 2);
  const s = r.samples[0];
  assert.ok(Math.abs(s.lat - 36.19) < 1e-6 && Math.abs(s.lon - 139.13) < 1e-6);
  assert.ok(Math.abs(s.spd - 10.289) < 0.01 && s.alt === 95.2 && Math.abs(s.acc - 2.7) < 1e-9);
  assert.equal(new Date(s.t).toISOString(), '2026-11-22T01:02:03.000Z');
});

await test('読込: RaceChrono 形式 CSV（単位行あり, m/s）', () => {
  const txt = [
    'This file is created using RaceChrono',
    'Format,3',
    '',
    'Timestamp (s),Fragment ID,Lap #,Elapsed time (s),Distance (m),Latitude (deg),Longitude (deg),Speed (m/s),Altitude (m),Bearing (deg)',
    'unix time,,,s,m,deg,deg,m/s,m,deg',
    ',,,,,gps,gps,gps,gps,gps',
    '1763773323.000,0,,0.000,0.0,36.1900000,139.1300000,20.00,95.0,90.0',
    '1763773323.100,0,,0.100,2.0,36.1900000,139.1300222,20.10,95.0,90.0',
  ].join('\n');
  const r = IO.parseFile(txt, 'rc.csv');
  assert.equal(r.samples.length, 2);
  assert.equal(r.samples[0].spd, 20);
  assert.equal(r.samples[1].t - r.samples[0].t, 100);
  assert.equal(r.samples[0].t, 1763773323000);
});

await test('読込: AiM 形式 CSV（GPS Latitude, km/h の単位行）', () => {
  const txt = [
    '"Format","AiM CSV File"', '"Session","Test"', '',
    '"Time","GPS Speed","GPS Latitude","GPS Longitude","GPS Heading"',
    '"s","km/h","deg","deg","deg"',
    '0.000,72.0,36.19,139.13,90',
    '0.050,72.4,36.19,139.13001,90',
  ].join('\n');
  const r = IO.parseFile(txt, 'aim.csv');
  assert.equal(r.samples.length, 2);
  assert.ok(Math.abs(r.samples[0].spd - 20) < 1e-9);
  assert.equal(r.samples[1].t - r.samples[0].t, 50);
});

await test('読込: VBO（分単位・西が＋の経度）', () => {
  const txt = [
    'File created on 22/11/2026 @ 10:00:00', '', '[header]', 'satellites', 'time', 'latitude', 'longitude', 'velocity kmh', 'heading', 'height', '',
    '[column names]', 'sats time lat long velocity heading height', '', '[data]',
    '010 010203.00 +02171.400000 -08347.800000 072.000 090.00 +00095.00',
    '010 010203.10 +02171.400600 -08347.801300 072.100 090.10 +00095.00',
  ].join('\n');
  const r = IO.parseFile(txt, 'a.vbo');
  assert.equal(r.format, 'VBO');
  assert.ok(Math.abs(r.samples[0].lat - 36.19) < 1e-6 && Math.abs(r.samples[0].lon - 139.13) < 1e-6, JSON.stringify(r.samples[0]));
  assert.ok(Math.abs(r.samples[0].spd - 20) < 1e-9);
  assert.equal(new Date(r.samples[0].t).toISOString(), '2026-11-22T01:02:03.000Z');
});

await test('書き出し: 解析CSV・ラップ表・KML', () => {
  const csv = IO.toAnalysisCSV(A1);
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('lap,lap_time_s'));
  assert.ok(lines.length > 1000);
  const rep = IO.toLapReportCSV(A1);
  assert.ok(rep.split('\n')[0].includes('T1_seg_s'));
  const kml = IO.toKML(A1);
  assert.ok(kml.includes('<LineString>') && kml.trim().endsWith('</kml>'));
});

await test('ピット停止を含むラップは無効扱い', () => {
  const ses = makeDemoSession({ laps: 4, rateHz: 1, seed: 2, motion: false });
  // 3周目の途中で 8 秒停止させる
  const t = C.processSession(ses);
  const r0 = C.detectLaps(t, { sf: ses.truth.sfLine });
  const lap = r0.laps[2];
  const mid = ses.samples[0].t + (lap.start + lap.time / 2) * 1000;
  const shifted = [];
  let stopAdded = false;
  for (const s of ses.samples) {
    if (!stopAdded && s.t >= mid) { for (let i = 0; i < 8; i++) shifted.push({ ...s, t: s.t + i * 1000, spd: 0 }); stopAdded = true; }
    shifted.push(stopAdded ? { ...s, t: s.t + 8000 } : s);
  }
  const t2 = C.processSession({ ...ses, samples: shifted });
  const r = C.detectLaps(t2, { sf: ses.truth.sfLine });
  assert.ok(r.laps[2].flags.includes('pit') && !r.laps[2].valid, JSON.stringify(r.laps.map(l => l.flags)));
});

console.log(failures ? `\n${failures} 件失敗` : '\nすべて成功');
process.exit(failures ? 1 : 0);
