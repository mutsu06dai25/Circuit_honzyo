// 計測画面: GPS・センサー記録、リアルタイムのラップ計測と予測タイム差
import * as C from '../core.js';
import * as T from '../track.js';
import * as S from '../store.js';
import { $, esc, toast, ICON, speak, speechLap, cssVar } from './util.js';
import { TrackMap } from './trackmap.js';

let app = null;
const L = {
  on: false, session: null, watchId: null, warmId: null, wake: null, timer: null, lastSave: 0,
  track: null, proj: null, sf: null, sfSide: 0, path: null, projector: null, ref: null, sessionRef: null,
  lapStart: null, lapStartWall: null, lapNo: 0, laps: [], best: null, lapPts: [], lapRaw: null, lapS: 0,
  prev: null, loop: [], rate: [], gLive: { lat: 0, lon: 0 }, motionAcc: null, motionOK: false, battery: null, lastFixWall: 0, hiddenAt: 0,
};

export function initLogger(ctx) { app = ctx; renderIdle(); }
export const isRecording = () => L.on;
export function onShow() { if (!L.on) { renderIdle(); maybeWarm(); } }
export function onHide() { stopWarm(); }

// ---------- 待機画面 ----------
const WEATHER = ['', '晴れ', '曇り', '小雨', '雨', '雪'];
const SURFACE = ['', 'ドライ', 'ハーフウェット', 'ウェット'];
function renderIdle() {
  const p = app.prefs, info = p.lastInfo || {};
  const tr = L.track || app.guessTrack();
  const best = tr && tr.best;
  $('view-log').innerHTML = `
  <div class="log-idle grid" style="gap:12px">
    <div class="card start-card">
      <div class="row nowrap"><div style="min-width:0"><div class="muted" style="font-size:12px;font-weight:600">コース</div><div style="font-size:21px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="lgTrack">${esc(tr ? tr.name : 'GPS で自動判定')}</div></div>
        <span class="spacer"></span><div class="gps-status"><span class="gps-dot" id="lgDot"></span><span id="lgGps">GPS 未確認</span></div></div>
      ${tr && (tr.model || tr.osm) ? '<canvas class="preview-map" id="lgPreview"></canvas>' : ''}
      <div class="grid g2">
        <div class="kpi"><div class="k">自己ベスト</div><div class="v num">${best ? C.fmtLap(best.time) : '--:--.---'}</div><div class="s">${best ? new Date(best.date).toLocaleDateString('ja-JP') : 'まだ記録なし'}</div></div>
        <div class="kpi"><div class="k">リアルタイム計測</div><div class="v" style="font-size:15px;font-weight:700;margin-top:6px">${tr && tr.sf ? (best && best.ref ? 'ラップ＋予測タイム差' : 'ラップタイム') : '1周走ると自動で開始'}</div><div class="s">${tr && tr.sf ? `S/F ライン ${tr.sfAuto ? '（自動）' : '（手動）'}` : 'S/F ラインは自動検出'}</div></div>
      </div>
      <button class="btn-start" id="btnStart">${ICON.rec} 記録開始</button>
      <button class="btn" id="btnWarm">${ICON.gps} GPS の受信状態を確認</button>
    </div>
    <details class="box" ${Object.keys(info).length ? '' : 'open'}><summary>${ICON.edit.replace('<svg', '<svg width="18" height="18"')} セッション情報 <span class="muted" style="font-weight:400;font-size:12px">（前回の内容を引き継ぎます）</span></summary>
      <div class="form-grid">
        <label>車両<input type="text" data-f="vehicle" value="${esc(info.vehicle)}" placeholder="例: ND ロードスター"></label>
        <label>タイヤ<input type="text" data-f="tires" value="${esc(info.tires)}" placeholder="例: RE-71RS 205/50R16"></label>
        <label>空気圧<input type="text" data-f="pressure" value="${esc(info.pressure)}" placeholder="例: 冷間 F200 / R190"></label>
        <label>ドライバー<input type="text" data-f="driver" value="${esc(info.driver)}"></label>
        <label>天気<select data-f="weather">${WEATHER.map(w => `<option ${w === info.weather ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
        <label>気温（℃）<input type="number" data-f="temp" value="${esc(info.temp)}" inputmode="decimal"></label>
        <label>路面<select data-f="surface">${SURFACE.map(w => `<option ${w === info.surface ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
        <label>セットアップ<input type="text" data-f="setup" value="${esc(info.setup)}" placeholder="減衰・車高など"></label>
        <label class="full">メモ<textarea data-f="notes" placeholder="今日の目標、試すこと など">${esc(info.notes)}</textarea></label>
      </div></details>
    <details class="box"><summary>${ICON.gear.replace('<svg', '<svg width="18" height="18"')} 計測の設定</summary>
      <div class="set-row"><div class="l">Gセンサー・ジャイロも記録<small>ブレーキの強さや横Gが正確になります（推奨）</small></div><input type="checkbox" id="optMotion" ${p.motion ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></div>
      <div class="set-row"><div class="l">ラップタイムを読み上げ<small>イヤホンや車のスピーカーで聞けます</small></div><input type="checkbox" id="optVoice" ${p.voice ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></div>
      <div class="set-row"><div class="l">予測タイム差の基準</div><select id="optRef"><option value="best" ${p.refMode === 'best' ? 'selected' : ''}>自己ベスト（全セッション）</option><option value="session" ${p.refMode === 'session' ? 'selected' : ''}>このセッションのベスト</option></select></div>
    </details>
    <details class="box"><summary>${ICON.info.replace('<svg', '<svg width="18" height="18"')} 走行前のチェック</summary>
      <ul class="tips">
        <li><b>スマホはしっかり固定</b>（走行中に向きが変わらないこと）。向きはどの方向でもOK。データから自動で推定します。</li>
        <li><b>記録中は画面を点けたまま、このアプリを前面に</b>。画面を消したり他のアプリに切り替えると、多くの端末で GPS 記録が止まります。自動ロックは「なし」に。</li>
        <li>走行前にピットで 1〜2 分 GPS を受信させ、精度が <b>5m 以下</b>になってからスタート。</li>
        <li>充電しながらの使用がおすすめです（GPS と画面点灯で電池を使います）。</li>
        <li>初めてのコースでも OK。1周走るとコースと S/F ラインを自動で覚え、2周目からラップを表示します。正確な位置はあとで地図から直せます。</li>
        <li>スマホ GPS は 1 秒に 1 回の更新です。10Hz 以上の外部 GPS ロガーのファイルも「セッション」から読み込めます。</li>
      </ul></details>
  </div>`;
  $('btnStart').onclick = start;
  $('btnWarm').onclick = () => startWarm(true);
  $('view-log').querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => {
    const v = { ...(app.prefs.lastInfo || {}) };
    v[inp.dataset.f] = inp.value;
    app.prefs.lastInfo = v; app.savePrefs();
  }));
  $('optMotion').onchange = (e) => { app.prefs.motion = e.target.checked; app.savePrefs(); };
  $('optVoice').onchange = (e) => { app.prefs.voice = e.target.checked; app.savePrefs(); if (e.target.checked) speak('読み上げをオンにしました'); };
  $('optRef').onchange = (e) => { app.prefs.refMode = e.target.value; app.savePrefs(); };
  if ($('lgPreview')) {
    const tm = new TrackMap($('lgPreview'), { interactive: false, compact: true, padding: 12 });
    const proj = C.makeProjection(tr.center.lat, tr.center.lon);
    const scene = { corners: null };
    if (tr.model) { const m = T.loadModel(tr.model, proj); scene.model = m; scene.corners = tr.model.corners; }
    if (tr.osm) scene.osm = tr.osm.ways.map(w => { const x = [], y = []; for (const [la, lo] of w.pts) { const [a, b] = proj.toXY(la, lo); x.push(a); y.push(b); } return { x, y }; });
    if (!scene.model && scene.osm) scene.laps = [{ x: scene.osm[0].x, y: scene.osm[0].y, color: 'transparent' }];
    requestAnimationFrame(() => tm.setScene(scene));
  }
}

// GPS の受信状態（記録前）
async function maybeWarm() {
  try {
    if (navigator.permissions) { const s = await navigator.permissions.query({ name: 'geolocation' }); if (s.state === 'granted') startWarm(false); }
  } catch (e) { /* 無視 */ }
}
function startWarm(user) {
  if (L.warmId !== null || L.on || !('geolocation' in navigator)) return;
  $('btnWarm') && ($('btnWarm').hidden = true);
  L.warmId = navigator.geolocation.watchPosition((pos) => {
    const a = pos.coords.accuracy;
    const dot = $('lgDot'), txt = $('lgGps');
    if (!dot) return;
    dot.className = 'gps-dot ' + (a <= 5 ? 'ok' : a <= 12 ? 'mid' : 'bad');
    txt.textContent = `GPS 精度 ${a.toFixed(1)} m${a <= 5 ? '（良好）' : a <= 12 ? '（もう少し待つ）' : '（受信中…）'}`;
    const tr = app.trackForPoint(pos.coords.latitude, pos.coords.longitude, false);
    if (tr && $('lgTrack')) $('lgTrack').textContent = tr.name;
  }, (err) => {
    if ($('lgGps')) $('lgGps').textContent = err.code === 1 ? '位置情報が許可されていません' : 'GPS エラー';
    if ($('lgDot')) $('lgDot').className = 'gps-dot bad';
    if (user && err.code === 1) toast('ブラウザの設定で位置情報を許可してください', 5000);
    stopWarm();
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function stopWarm() { if (L.warmId !== null) { navigator.geolocation.clearWatch(L.warmId); L.warmId = null; } }

// ---------- 記録開始・停止 ----------
// iOS は許可ダイアログが必要。許可が取れなくてもリスナーは付けておく（届かなければ記録されないだけ）
async function requestMotion() {
  if (typeof DeviceMotionEvent === 'undefined') return false;
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try { L.motionPerm = await DeviceMotionEvent.requestPermission(); } catch (e) { L.motionPerm = 'error'; }
  }
  return true;
}
async function acquireWake() {
  try { if ('wakeLock' in navigator) { L.wake = await navigator.wakeLock.request('screen'); return true; } } catch (e) { /* 無視 */ }
  return false;
}

async function start() {
  if (!('geolocation' in navigator)) { toast('この端末・ブラウザでは位置情報が使えません'); return; }
  if (!window.isSecureContext) toast('位置情報には HTTPS での配信が必要です', 5000);
  stopWarm();
  if (app.prefs.voice) speak('記録を開始します');
  const now = new Date();
  L.session = {
    id: S.newId(), name: `${now.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} ${now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} の走行`,
    startedAt: Date.now(), samples: [], motion: [], trackId: null, recording: true,
    meta: { ua: navigator.userAgent, motionStride: 7, app: 'lap-logger-2' }, info: { ...(app.prefs.lastInfo || {}) },
  };
  Object.assign(L, { on: true, track: null, proj: null, sf: null, sfSide: 0, path: null, projector: null, ref: null, sessionRef: null, lapStart: null, lapStartWall: null, lapNo: 0, laps: [], best: null, lapPts: [], lapRaw: null, lapS: 0, prev: null, loop: [], rate: [], motionAcc: null, motionOK: false, lastSave: Date.now(), lastFixWall: Date.now() });
  renderDash();
  if (app.prefs.motion && await requestMotion()) window.addEventListener('devicemotion', onMotion);
  const wl = await acquireWake();
  setMsg(wl ? '' : '画面の自動ロックをオフにしてください（このブラウザは画面点灯の維持に未対応）');
  L.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  L.timer = setInterval(tick, 100);
  window.addEventListener('beforeunload', warnUnload);
  document.addEventListener('visibilitychange', onVis);
  try { navigator.getBattery && navigator.getBattery().then(b => { L.battery = b; }); } catch (e) { /* 無視 */ }
  app.setRecording(true);
  await save();
}
function warnUnload(e) { if (L.on) { save(); e.preventDefault(); e.returnValue = ''; } }
function onVis() {
  if (!L.on) return;
  if (document.visibilityState === 'hidden') { L.hiddenAt = Date.now(); save(); }
  else { acquireWake(); if (L.hiddenAt && Date.now() - L.hiddenAt > 5000) setMsg('画面を離れていた間、GPS が止まっていた可能性があります'); }
}
async function stop() {
  L.on = false;
  navigator.geolocation.clearWatch(L.watchId);
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('beforeunload', warnUnload);
  document.removeEventListener('visibilitychange', onVis);
  clearInterval(L.timer);
  try { L.wake && await L.wake.release(); } catch (e) { /* 無視 */ }
  $('dash')?.remove();
  app.setRecording(false);
  const ses = L.session;
  delete ses.recording;
  if (ses.samples.length < 5) { await S.deleteSession(ses.id); toast('データが少ないため保存しませんでした'); L.session = null; renderIdle(); return; }
  await save();
  L.session = null;
  if (app.prefs.voice) speak('記録を終了しました');
  toast('保存しました。解析します…');
  app.sessionsChanged();
  app.openAnalysis(ses.id);
}
async function save() {
  if (!L.session) return;
  L.lastSave = Date.now();
  try { await S.saveSession(L.session); } catch (e) { setMsg('保存に失敗: ' + e.message); }
}

// ---------- センサー（25Hz に平均化して保存） ----------
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const r = e.rotationRate || {};
  const now = Date.now();
  let m = L.motionAcc;
  if (!m) m = L.motionAcc = { t0: now, n: 0, s: [0, 0, 0, 0, 0, 0], g: 0 };
  m.s[0] += a.x; m.s[1] += a.y; m.s[2] += a.z;
  if (Number.isFinite(r.alpha) && Number.isFinite(r.beta) && Number.isFinite(r.gamma)) { m.s[3] += r.alpha; m.s[4] += r.beta; m.s[5] += r.gamma; m.g++; }
  m.n++;
  if (now - m.t0 >= 40) {
    const g = m.g || 1;
    L.session.motion.push(Math.round((m.t0 + now) / 2), +(m.s[0] / m.n).toFixed(3), +(m.s[1] / m.n).toFixed(3), +(m.s[2] / m.n).toFixed(3),
      m.g ? +(m.s[3] / g).toFixed(3) : null, m.g ? +(m.s[4] / g).toFixed(3) : null, m.g ? +(m.s[5] / g).toFixed(3) : null);
    L.motionAcc = null;
    L.motionOK = true;
  }
}

// ---------- GPS ----------
function setupTrack(s) {
  L.track = app.trackForPoint(s.lat, s.lon, true);
  L.session.trackId = L.track.id;
  app.setTrackChip(L.track.name);
  const c = L.track.center || { lat: s.lat, lon: s.lon };
  L.proj = C.makeProjection(c.lat, c.lon);
  if (L.track.sf) setSF(L.track.sf);
  if (L.track.model && L.track.model.pts && L.track.model.pts.length > 10) {
    try {
      L.path = T.loadModel(L.track.model, L.proj);
      L.projector = T.makeProjector(L.path, { behind: 20, ahead: 140, lostDist: 45 });
      if (app.prefs.refMode !== 'session' && L.track.best && L.track.best.ref) L.ref = L.track.best.ref;
    } catch (e) { L.path = null; }
  }
  setMsg(L.track.sf ? '' : 'まず1周してください。コースを覚えて S/F ラインを自動で設定します');
}
function setSF(line) {
  L.sf = [L.proj.toXY(line.a.lat, line.a.lon), L.proj.toXY(line.b.lat, line.b.lon)];
  L.sfSide = 0;
}
function onPos(pos) {
  const c = pos.coords;
  const s = { t: pos.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, alt: c.altitude ?? undefined, acc: c.accuracy, altAcc: c.altitudeAccuracy ?? undefined, spd: c.speed ?? undefined, hdg: Number.isFinite(c.heading) ? c.heading : undefined };
  const ses = L.session;
  if (!ses) return;
  const last = ses.samples[ses.samples.length - 1];
  if (last && s.t <= last.t) return;
  if (!ses.samples.length) setupTrack(s);
  ses.samples.push(s);
  L.lastFixWall = Date.now();
  L.rate.push(s.t); while (L.rate.length && s.t - L.rate[0] > 5000) L.rate.shift();
  const [x, y] = L.proj.toXY(s.lat, s.lon);
  const v = Number.isFinite(s.spd) && s.spd >= 0 ? s.spd : (last ? C.haversine(last.lat, last.lon, s.lat, s.lon) / ((s.t - last.t) / 1000) : 0);
  const fix = { x, y, t: s.t, v, h: Number.isFinite(s.hdg) && v > 2 ? s.hdg * C.DEG : (L.prev ? Math.atan2(x - L.prev.x, y - L.prev.y) : 0), acc: c.accuracy };
  liveG(fix);
  if (!L.sf) autoSF(fix);
  if (L.sf && L.prev && fix.v > 3) {
    const hit = C.segIntersect([L.prev.x, L.prev.y], [x, y], L.sf[0], L.sf[1]);
    if (hit && (!L.sfSide || hit.side === L.sfSide)) {
      if (!L.sfSide && fix.v > 6) L.sfSide = hit.side;
      onCross(L.prev.t + (s.t - L.prev.t) * hit.u, fix);
    }
  }
  if (L.lapStart !== null) trackLap(fix);
  L.prev = fix;
  updateFixUI(s, v);
  if (Date.now() - L.lastSave > 10000) save();
}
function onPosErr(err) {
  setMsg(err.code === 1 ? '位置情報が許可されていません（ブラウザの設定を確認）' : 'GPS の受信が途切れています');
  if (err.code === 1) toast('位置情報の利用を許可してください', 5000);
}

// 1周目: 同じ場所に同じ向きで戻ってきたらコースを1周したとみなす
function autoSF(fix) {
  if (fix.v < 8) return;
  L.loop.push(fix);
  if (L.loop.length > 900) L.loop.shift();
  let start = -1;
  for (let i = L.loop.length - 2; i >= 0; i--) {
    const p = L.loop[i];
    if (fix.t - p.t < 25000) continue;
    if ((p.x - fix.x) ** 2 + (p.y - fix.y) ** 2 < 15 * 15 && Math.abs(C.wrapPi(p.h - fix.h)) < 35 * C.DEG) { start = i; break; }
  }
  if (start < 0) return;
  const loop = L.loop.slice(start);
  let dist = 0; for (let i = 1; i < loop.length; i++) dist += Math.hypot(loop[i].x - loop[i - 1].x, loop[i].y - loop[i - 1].y);
  if (dist < 300 || dist > 10000) return;
  let km = 0; loop.forEach((p, i) => { if (p.v > loop[km].v) km = i; });
  const pk = loop[km];
  const line = C.lineAtXY(L.proj, pk.x, pk.y, pk.h, 40);
  L.track.sf = line; L.track.sfAuto = true;
  if (!L.track.center) L.track.center = { lat: L.proj.lat0, lon: L.proj.lon0 };
  app.saveTrack(L.track);
  setSF(line);
  if (!L.path) {
    const pts = [...loop.slice(km), ...loop.slice(0, km)];
    L.path = T.provisionalPath(Float64Array.from(pts, p => p.x), Float64Array.from(pts, p => p.y), 2);
    L.projector = T.makeProjector(L.path, { behind: 20, ahead: 140, lostDist: 45 });
  }
  L.loop = [];
  setMsg('コースを1周検出しました。S/F ラインを自動設定 → 次の通過から計測します');
  if (app.prefs.voice) speak('コースを検出しました');
}

function onCross(tc, fix) {
  if (L.lapStart === null) { startLap(tc, fix); setMsg(''); return; }
  const lt = (tc - L.lapStart) / 1000;
  if (lt < (L.track.minLapSec || 20)) return;
  finishLap(lt);
  startLap(tc, fix);
}
function startLap(tc, fix) {
  L.lapStart = tc;
  L.lapStartWall = Date.now() - (fix.t - tc);
  L.lapPts = [{ s: 0, t: 0 }];
  L.lapRaw = { x: [], y: [], t: [] };
  L.lapS = 0;
  if (L.projector) L.projector.reset();
}
function finishLap(lt) {
  L.lapNo++;
  const prevBest = L.best;
  const isBest = prevBest === null || lt < prevBest;
  const trackBest = L.track.best ? L.track.best.time : null;
  const isPB = trackBest !== null && lt < Math.min(trackBest, prevBest ?? Infinity);
  L.laps.unshift({ no: L.lapNo, time: lt, d: prevBest === null ? null : lt - prevBest });
  if (isBest) L.best = lt;
  // 予測の基準を更新
  if (isBest) {
    let ref = null;
    if (!L.path && L.lapRaw && L.lapRaw.x.length > 10) {
      L.path = T.provisionalPath(Float64Array.from(L.lapRaw.x), Float64Array.from(L.lapRaw.y), 2);
      L.projector = T.makeProjector(L.path, { behind: 20, ahead: 140, lostDist: 45 });
      const pr = T.projectSeries(L.path, L.lapRaw.x, L.lapRaw.y);
      const s0 = pr.s[0];
      const sArr = Array.from(pr.s, v => v - s0), tArr = L.lapRaw.t;
      ref = buildRef(sArr, tArr, lt);
    } else if (L.path && L.lapPts.length > 10) {
      ref = buildRef(L.lapPts.map(p => p.s), L.lapPts.map(p => p.t), lt);
    }
    if (ref) { L.sessionRef = ref; if (!L.ref || app.prefs.refMode === 'session' || lt < L.ref.time) L.ref = ref; }
  }
  const dl = $('dLast'); if (dl) dl.textContent = C.fmtLap(lt);
  $('dBest') && ($('dBest').textContent = C.fmtLap(L.best));
  const d = prevBest === null ? null : lt - prevBest;
  const el = $('dLastDelta');
  if (el) { el.textContent = d === null ? '—' : C.fmtDelta(d, 2); el.style.color = d === null ? '' : d <= 0 ? '#2fd47c' : '#ff5468'; }
  renderLapList();
  if (navigator.vibrate && app.prefs.vibrate) navigator.vibrate(isBest ? [80, 60, 80] : 150);
  if (app.prefs.voice) speak(`${speechLap(lt)}${isPB ? '、自己ベスト更新' : isBest && prevBest !== null ? '、ベスト' : d !== null ? `、プラス${d.toFixed(1)}` : ''}`);
  if (isPB) setMsg('自己ベスト更新！');
}
function buildRef(sArr, tArr, lt) {
  const Lp = L.path.L;
  const end = sArr[sArr.length - 1];
  if (!(end > Lp * 0.7)) return null;
  const k = Lp / end;
  let mx = 0;
  const s2 = sArr.map(v => { const w = Math.max(mx, v * k); mx = w; return w; });
  return T.refFromSeries([...s2, Lp], [...tArr, lt], Lp, lt, 2);
}
function trackLap(fix) {
  const el = (fix.t - L.lapStart) / 1000;
  if (L.lapRaw) { L.lapRaw.x.push(fix.x); L.lapRaw.y.push(fix.y); L.lapRaw.t.push(el); }
  if (!L.path || !L.projector) return;
  const r = L.projector.project(fix.x, fix.y);
  let s = r.s;
  if (el < 20 && s > L.path.L * 0.6) s -= L.path.L;
  if (s < L.lapS - 50 && el > 20) s += L.path.L; // 終盤で始点側に投影された
  s = Math.max(L.lapS, Math.min(s, L.path.L));
  L.lapS = s;
  L.lapPts.push({ s, t: el });
  if (L.ref && r.d < 35 && s > 30) {
    const refT = T.refTimeAt(L.ref, s * (L.ref.L / L.path.L));
    showDelta(el - refT, L.ref.time + (el - refT));
  }
}
function liveG(fix) {
  const p = L.prev;
  if (!p) return;
  const dt = (fix.t - p.t) / 1000;
  if (!(dt > 0.05) || dt > 3) return;
  const lon = (fix.v - p.v) / dt / C.G;
  const lat = fix.v > 3 ? fix.v * C.wrapPi(fix.h - p.h) / dt / C.G : 0;
  L.gLive = { lat: L.gLive.lat * 0.4 + lat * 0.6, lon: L.gLive.lon * 0.4 + lon * 0.6 };
}

// ---------- ダッシュボード ----------
function renderDash() {
  document.getElementById('dash')?.remove();
  const d = document.createElement('div');
  d.className = 'dash'; d.id = 'dash';
  d.innerHTML = `
    <div class="top"><span class="rec">REC</span><span class="stat" id="dTrack" style="color:#fff;font-weight:700"></span><span class="spacer"></span><span class="stat" id="dGps">GPS —</span><span class="stat" id="dHz"></span><span class="stat" id="dSens"></span><span class="stat" id="dTime">0:00</span><span class="stat" id="dBatt"></span></div>
    <div class="delta"><div class="bar" id="dBar"></div><div class="mid"></div><div class="lbl">予測タイム差</div><div class="pred" id="dPred"></div><div class="val" id="dVal">—</div></div>
    <div class="mainnums">
      <div class="box"><div class="l">現在ラップ <span id="dLapNo"></span></div><div class="lap-now" id="dLap">--:--.---</div></div>
      <div class="box"><div class="l">速度</div><div class="speed"><span id="dSpd">0</span><small>km/h</small></div></div>
    </div>
    <div class="row3">
      <div class="box"><div class="l">前周</div><div class="v" id="dLast">—</div></div>
      <div class="box"><div class="l">ベスト</div><div class="v" id="dBest">—</div></div>
      <div class="box"><div class="l">前周 vs ベスト</div><div class="v" id="dLastDelta">—</div></div>
    </div>
    <div class="side"><div class="box laps-list" id="dLaps"><div class="l">ラップ</div></div><div class="box" style="align-items:center"><canvas class="gmeter" id="dG" width="240" height="240"></canvas></div></div>
    <div class="msg" id="dMsg"></div>
    <button class="hold" id="dStop"><div class="fill"></div><span>長押しで記録停止</span></button>`;
  document.body.appendChild(d);
  const btn = $('dStop'), fill = btn.querySelector('.fill');
  let t0 = 0, raf = 0;
  const reset = () => { cancelAnimationFrame(raf); fill.style.width = '0'; t0 = 0; };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); t0 = performance.now();
    const step = (now) => {
      const f = Math.min(1, (now - t0) / 1100);
      fill.style.width = `${f * 100}%`;
      if (f >= 1) { reset(); stop(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
  btn.addEventListener('pointerup', () => { if (t0 && performance.now() - t0 < 1100) setMsg('止めるときはボタンを長押ししてください'); reset(); });
  btn.addEventListener('pointerleave', reset);
  btn.addEventListener('pointercancel', reset);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
function setMsg(t) { const el = $('dMsg'); if (el) el.textContent = t; }
function showDelta(d, pred) {
  const val = $('dVal'), bar = $('dBar');
  if (!val) return;
  val.textContent = C.fmtDelta(d, 2);
  const col = d <= 0 ? '#2fd47c' : '#ff4d5e';
  val.style.color = col;
  const w = Math.min(50, Math.abs(d) / 1.0 * 50);
  bar.style.background = col; bar.style.opacity = 0.35;
  bar.style.width = `${w}%`; bar.style.left = d <= 0 ? `${50 - w}%` : '50%';
  $('dPred').textContent = `予測 ${C.fmtLap(pred)}`;
}
function updateFixUI(s, v) {
  $('dSpd').textContent = Math.round(v * 3.6);
  const a = s.acc;
  const g = $('dGps');
  g.textContent = `GPS ${a.toFixed(1)}m`;
  g.style.color = a <= 5 ? '#2fd47c' : a <= 12 ? '#ffc53d' : '#ff5468';
  const hz = L.rate.length > 1 ? (L.rate.length - 1) / ((L.rate[L.rate.length - 1] - L.rate[0]) / 1000) : 0;
  $('dHz').textContent = `${hz.toFixed(1)}Hz`;
  if (L.track) $('dTrack').textContent = L.track.name;
}
function tick() {
  if (!L.on) return;
  $('dTime').textContent = C.fmtDur((Date.now() - L.session.startedAt) / 1000);
  $('dLap').textContent = L.lapStartWall ? C.fmtLap((Date.now() - L.lapStartWall) / 1000) : '--:--.---';
  $('dLapNo').textContent = L.lapStartWall ? `L${L.lapNo + 1}` : '';
  if (Date.now() - L.lastFixWall > 4000) { const g = $('dGps'); g.textContent = 'GPS 受信なし'; g.style.color = '#ff5468'; }
  if (L.battery) $('dBatt').textContent = `${Math.round(L.battery.level * 100)}%${L.battery.charging ? '⚡' : ''}`;
  const sg = $('dSens'); if (sg) { sg.textContent = L.motionOK ? 'G●' : 'G○'; sg.style.color = L.motionOK ? '#2fd47c' : '#7f8a99'; sg.title = L.motionOK ? 'センサー記録中' : 'センサーなし'; }
  drawGMeter();
}
function renderLapList() {
  const el = $('dLaps'); if (!el) return;
  el.innerHTML = '<div class="l">ラップ</div>' + L.laps.slice(0, 6).map(l => `<div><span style="color:#9aa4b2">L${l.no}</span><span style="${l.time === L.best ? 'color:#b07cff' : ''}">${C.fmtLap(l.time)}</span></div>`).join('');
}
function drawGMeter() {
  const cv = $('dG'); if (!cv) return;
  const ctx = cv.getContext('2d'), s = cv.width, c = s / 2, r = c - 10;
  ctx.clearRect(0, 0, s, s);
  ctx.strokeStyle = '#2a323d'; ctx.lineWidth = 2;
  for (const g of [0.5, 1.0]) { ctx.beginPath(); ctx.arc(c, c, r * g / 1.2, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(c, 6); ctx.lineTo(c, s - 6); ctx.moveTo(6, c); ctx.lineTo(s - 6, c); ctx.stroke();
  const { lat, lon } = L.gLive;
  const x = c + Math.max(-1.2, Math.min(1.2, lat)) / 1.2 * r, y = c - Math.max(-1.2, Math.min(1.2, lon)) / 1.2 * r;
  ctx.fillStyle = '#ff2b2b'; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#9aa4b2'; ctx.font = '600 22px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(`${Math.hypot(lat, lon).toFixed(1)}G`, c, s - 14);
}
