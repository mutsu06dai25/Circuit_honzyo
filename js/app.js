import * as C from './core.js';
import * as S from './store.js';
import { ChartGroup, LineChart, drawGG } from './chart.js';
import { makeDemoSession } from './demo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kmh = (v) => v * 3.6;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

let tracks = S.loadTracks();
function toast(msg, ms = 2500) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

// ================= 画面切替 =================
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'sessions') renderSessions();
  if (name === 'analysis') { refreshSessionSelect(); setTimeout(() => { map && map.invalidateSize(); group && group.draw(); }, 50); }
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ================= コース =================
function trackForPoint(lat, lon, create = true) {
  let best = null, bd = Infinity;
  for (const t of tracks) {
    if (!t.center) continue;
    const d = C.haversine(lat, lon, t.center.lat, t.center.lon) / 1000;
    if (d < (t.radiusKm || 3) && d < bd) { bd = d; best = t; }
  }
  if (best || !create) return best;
  const t = { id: S.newId(), name: `コース (${lat.toFixed(3)}, ${lon.toFixed(3)})`, center: { lat, lon }, radiusKm: 3, sf: null, sectors: [], minLapSec: 20 };
  tracks.push(t); S.saveTracks(tracks);
  return t;
}
function trackById(id) { return tracks.find(t => t.id === id) || null; }
function saveTrack(t) { const i = tracks.findIndex(x => x.id === t.id); if (i >= 0) tracks[i] = t; else tracks.push(t); S.saveTracks(tracks); }
function ensureTrack(session) {
  let t = session.trackId && trackById(session.trackId);
  if (t) return t;
  if (session.demo) {
    t = trackById('demo') || { id: 'demo', name: 'デモコース（架空）', center: null, radiusKm: 0, sf: null, sectors: [], minLapSec: 20 };
    saveTrack(t);
  } else {
    const p = session.samples[Math.floor(session.samples.length / 2)] || session.samples[0];
    t = trackForPoint(p.lat, p.lon);
  }
  session.trackId = t.id;
  return t;
}

// ================= 計測 =================
const rec = {
  on: false, session: null, watchId: null, wake: null, lastSave: 0, lastMotion: 0,
  proj: null, track: null, sfXY: null, lapStart: null, lastLap: null, bestLap: null, prev: null,
  timer: null, motionOK: false, rateTimes: [],
};

async function requestMotion() {
  if (typeof DeviceMotionEvent === 'undefined') return false;
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try { return (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch (e) { return false; }
  }
  return true;
}
async function acquireWake() {
  try {
    if ('wakeLock' in navigator) {
      rec.wake = await navigator.wakeLock.request('screen');
      $('stWake').textContent = '有効'; $('stWake').className = 'good';
      rec.wake.addEventListener('release', () => { if (rec.on) { $('stWake').textContent = '解除'; $('stWake').className = 'bad'; } });
      return;
    }
  } catch (e) { /* 無視 */ }
  $('stWake').textContent = '非対応（手動で画面を点灯）'; $('stWake').className = 'bad';
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec.on) acquireWake();
  if (document.visibilityState === 'hidden' && rec.on) saveRec();
});

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const now = Date.now();
  if (now - rec.lastMotion < 45) return; // 約20Hz
  rec.lastMotion = now;
  rec.motionOK = true;
  rec.session.motion.push(now, +a.x.toFixed(3), +a.y.toFixed(3), +a.z.toFixed(3));
}

function setupLiveTiming(lat, lon) {
  rec.track = trackForPoint(lat, lon);
  rec.session.trackId = rec.track.id;
  $('trackName').textContent = rec.track.name;
  if (rec.track.sf) {
    const c = rec.track.center || { lat, lon };
    rec.proj = C.makeProjection(c.lat, c.lon);
    rec.sfXY = [rec.proj.toXY(rec.track.sf.a.lat, rec.track.sf.a.lon), rec.proj.toXY(rec.track.sf.b.lat, rec.track.sf.b.lon)];
    $('lapHint').textContent = 'S/Fライン設定済み: ライン通過ごとにラップを計測します。';
  } else {
    $('lapHint').textContent = 'S/Fライン未設定のため、リアルタイムのラップ表示はありません。走行後の分析で自動設定され、次回から表示されます。';
  }
}

function onPos(pos) {
  const c = pos.coords;
  const s = { t: pos.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, alt: c.altitude ?? undefined, acc: c.accuracy, spd: c.speed ?? undefined, hdg: Number.isFinite(c.heading) ? c.heading : undefined };
  const ses = rec.session;
  if (!ses.samples.length) setupLiveTiming(s.lat, s.lon);
  const last = ses.samples[ses.samples.length - 1];
  if (last && s.t <= last.t) return;
  ses.samples.push(s);
  rec.rateTimes.push(s.t); while (rec.rateTimes.length && s.t - rec.rateTimes[0] > 5000) rec.rateTimes.shift();
  // 表示
  let v = Number.isFinite(s.spd) ? s.spd : (last ? C.haversine(last.lat, last.lon, s.lat, s.lon) / ((s.t - last.t) / 1000) : 0);
  $('liveSpeed').textContent = Math.round(kmh(v || 0));
  $('stAcc').textContent = `${c.accuracy.toFixed(1)} m`;
  $('stAcc').className = c.accuracy <= 5 ? 'good' : c.accuracy <= 12 ? '' : 'bad';
  const hz = rec.rateTimes.length > 1 ? (rec.rateTimes.length - 1) / ((rec.rateTimes[rec.rateTimes.length - 1] - rec.rateTimes[0]) / 1000) : 0;
  $('stRate').textContent = `${hz.toFixed(1)} Hz`;
  $('stCount').textContent = ses.samples.length;
  $('stMotion').textContent = rec.motionOK ? `記録中 (${(ses.motion.length / 4) | 0})` : ($('optMotion').checked ? '待機' : 'オフ');
  // ライブラップ
  if (rec.sfXY && last && v > 3) {
    const p1 = rec.proj.toXY(last.lat, last.lon), p2 = rec.proj.toXY(s.lat, s.lon);
    const hit = C.segIntersect(p1, p2, rec.sfXY[0], rec.sfXY[1]);
    if (hit) {
      const tc = last.t + (s.t - last.t) * hit.u;
      if (rec.lapStart !== null) {
        const lt = (tc - rec.lapStart) / 1000;
        if (lt >= (rec.track.minLapSec || 20)) {
          rec.lastLap = lt;
          const d = rec.bestLap !== null ? lt - rec.bestLap : null;
          if (rec.bestLap === null || lt < rec.bestLap) rec.bestLap = lt;
          $('liveLast').textContent = C.fmtLap(lt);
          $('liveBest').textContent = C.fmtLap(rec.bestLap);
          $('liveDelta').textContent = d === null ? '' : C.fmtDelta(d);
          $('liveDelta').className = 'mono ' + (d === null ? '' : d <= 0 ? 'good' : 'bad');
          if (navigator.vibrate) navigator.vibrate(120);
          rec.lapStart = tc;
          rec.lapStartWall = Date.now() - (s.t - tc);
        }
      } else { rec.lapStart = tc; rec.lapStartWall = Date.now() - (s.t - tc); }
    }
  }
  if (Date.now() - rec.lastSave > 10000) saveRec();
}
function onPosErr(err) {
  $('stAcc').textContent = err.code === 1 ? '許可なし' : 'エラー';
  $('stAcc').className = 'bad';
  if (err.code === 1) toast('位置情報の利用が許可されていません。ブラウザの設定で許可してください。', 5000);
}
async function saveRec() {
  if (!rec.session) return;
  rec.lastSave = Date.now();
  try { await S.saveSession(rec.session); } catch (e) { toast('保存に失敗しました: ' + e.message); }
}
function tick() {
  if (!rec.on) return;
  const ses = rec.session;
  $('stElapsed').textContent = fmtDur((Date.now() - ses.startedAt) / 1000);
  $('liveLap').textContent = rec.lapStartWall ? C.fmtLap((Date.now() - rec.lapStartWall) / 1000) : '--:--.---';
}
function fmtDur(sec) { const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60); return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`; }

async function startRec() {
  if (!('geolocation' in navigator)) { toast('この端末/ブラウザでは位置情報が使えません'); return; }
  if (!window.isSecureContext) { toast('位置情報には HTTPS での配信が必要です', 5000); }
  const now = new Date();
  rec.session = {
    id: S.newId(), name: `走行 ${now.toLocaleDateString('ja-JP')} ${now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`,
    startedAt: Date.now(), samples: [], motion: [], trackId: null, meta: { ua: navigator.userAgent },
  };
  Object.assign(rec, { on: true, lapStart: null, lapStartWall: null, lastLap: null, bestLap: null, sfXY: null, motionOK: false, rateTimes: [], lastSave: Date.now() });
  ['liveLast', 'liveBest'].forEach(id => $(id).textContent = '--:--.---'); $('liveDelta').textContent = '';
  if ($('optMotion').checked && await requestMotion()) window.addEventListener('devicemotion', onMotion);
  await acquireWake();
  rec.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  rec.timer = setInterval(tick, 100);
  $('btnRec').textContent = '記録停止'; $('btnRec').classList.add('on'); $('recBadge').hidden = false;
  window.addEventListener('beforeunload', warnUnload);
  await saveRec();
}
function warnUnload(e) { if (rec.on) { saveRec(); e.preventDefault(); e.returnValue = ''; } }
async function stopRec() {
  if (!confirm('記録を停止しますか？')) return;
  rec.on = false;
  navigator.geolocation.clearWatch(rec.watchId);
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('beforeunload', warnUnload);
  clearInterval(rec.timer);
  try { rec.wake && await rec.wake.release(); } catch (e) { /* 無視 */ }
  $('btnRec').textContent = '記録開始'; $('btnRec').classList.remove('on'); $('recBadge').hidden = true;
  $('stWake').textContent = '-'; $('stWake').className = '';
  const ses = rec.session;
  if (ses.samples.length < 5) { await S.deleteSession(ses.id); toast('データが少ないため保存しませんでした'); rec.session = null; return; }
  await saveRec();
  rec.session = null;
  toast('保存しました');
  openAnalysis(ses.id);
}
$('btnRec').addEventListener('click', () => (rec.on ? stopRec() : startRec()));

// ================= セッション一覧 =================
async function renderSessions() {
  const list = await S.listSessions();
  const el = $('sessionList');
  if (!list.length) { el.innerHTML = '<div class="empty">まだセッションがありません。「計測」で記録するか、ファイルを読み込んでください。</div>'; return; }
  el.innerHTML = list.map(s => `
    <div class="card" data-id="${s.id}">
      <div class="ttl">${esc(s.name)}</div>
      <div class="meta">${new Date(s.startedAt).toLocaleString('ja-JP')} ・ ${fmtDur(s.duration)} ・ ${s.count}点${s.hasMotion ? ' ・ Gセンサーあり' : ''}${s.summary ? ` ・ ${s.summary.laps}周 ベスト <b>${C.fmtLap(s.summary.best)}</b>` : ''}</div>
      <div class="actions">
        <button class="btn sm primary" data-act="open">分析</button>
        <button class="btn sm" data-act="csv">CSV</button>
        <button class="btn sm" data-act="gpx">GPX</button>
        <button class="btn sm" data-act="json">JSON</button>
        <button class="btn sm" data-act="rename">名前変更</button>
        <button class="btn sm danger" data-act="del">削除</button>
      </div>
    </div>`).join('');
}
$('sessionList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.card').dataset.id;
  const act = b.dataset.act;
  if (act === 'open') return openAnalysis(id);
  const ses = await S.getSession(id);
  const base = (ses.name || 'session').replace(/[\\/:*?"<>| ]+/g, '_');
  if (act === 'csv') download(`${base}.csv`, C.toCSV(ses), 'text/csv');
  if (act === 'gpx') download(`${base}.gpx`, C.toGPX(ses), 'application/gpx+xml');
  if (act === 'json') download(`${base}.json`, JSON.stringify(ses), 'application/json');
  if (act === 'rename') { const n = prompt('セッション名', ses.name); if (n) { ses.name = n; await S.saveSession(ses); renderSessions(); } }
  if (act === 'del') { if (confirm(`「${ses.name}」を削除しますか？`)) { await S.deleteSession(id); if (cur && cur.session.id === id) cur = null; renderSessions(); } }
});
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('fileImport').addEventListener('change', async (e) => {
  let lastId = null;
  for (const f of e.target.files) {
    try {
      const text = await f.text();
      let ses;
      if (/\.json$/i.test(f.name)) {
        const j = JSON.parse(text);
        ses = Array.isArray(j.sessions) ? null : j;
        if (!ses) { await restoreBackup(j); continue; }
        ses.id = ses.id || S.newId();
      } else {
        const samples = C.parseFile(text, f.name);
        if (samples.length < 5) throw new Error('有効な位置データがありません');
        ses = { id: S.newId(), name: f.name.replace(/\.[^.]+$/, ''), startedAt: samples[0].t, samples, motion: [], trackId: null, meta: { imported: f.name } };
      }
      await S.saveSession(ses); lastId = ses.id;
      toast(`読み込みました: ${f.name}（${ses.samples.length}点）`);
    } catch (err) { toast(`${f.name}: ${err.message}`, 5000); }
  }
  e.target.value = '';
  renderSessions();
  if (lastId) openAnalysis(lastId);
});
$('btnDemo').addEventListener('click', async () => {
  const ses = { id: S.newId(), ...makeDemoSession({ laps: 8, rateHz: 1, seed: (Math.random() * 1e6) | 0 }), trackId: 'demo' };
  await S.saveSession(ses);
  toast('デモデータを作成しました（スマホGPS相当の1Hz）');
  openAnalysis(ses.id);
});

// ================= 分析 =================
let cur = null; // { session, track, trace, res, ref, cmp, rsRef, rsCmp }
let map = null, mapLayers = {}, baseLayers = {}, mapMode = null, cursorMarkers = [];
let group = null, charts = {};

async function refreshSessionSelect(selectId) {
  const list = await S.listSessions();
  const sel = $('selSession');
  const want = selectId || (cur && cur.session.id) || '';
  sel.innerHTML = '<option value="">— セッションを選択 —</option>' + list.map(s => `<option value="${s.id}">${esc(s.name)}（${new Date(s.startedAt).toLocaleDateString('ja-JP')}）</option>`).join('');
  sel.value = want;
}
$('selSession').addEventListener('change', (e) => { if (e.target.value) openAnalysis(e.target.value); });

async function openAnalysis(id) {
  showView('analysis');
  await refreshSessionSelect(id);
  const session = await S.getSession(id);
  if (!session) return;
  const track = ensureTrack(session);
  const trace = C.processSession(session);
  if (!trace) { toast('データが少なすぎて解析できません'); return; }
  cur = { session, track, trace };
  $('trackName').textContent = track.name;
  recompute(true);
}

function recompute(first = false) {
  const { trace, track, session } = cur;
  const res = C.detectLaps(trace, track);
  cur.res = res;
  // 自動で決めた S/F ラインをコースに保存（次回のリアルタイム計測に使う）
  if (res.auto && res.sf && res.laps.length >= 2) {
    track.sf = res.sf; track.sfAuto = true;
    if (!track.center) { const c = trace.proj; track.center = { lat: c.lat0, lon: c.lon0 }; track.radiusKm = track.radiusKm || 3; }
    if (track.id === 'demo') track.center = null;
    saveTrack(track);
  }
  const valid = res.laps.filter(l => l.valid);
  if (first || !cur.ref || !res.laps.includes(cur.ref)) {
    cur.ref = res.best;
    const sorted = valid.slice().sort((a, b) => a.time - b.time);
    cur.cmp = sorted[1] || null;
  }
  // サマリーを保存
  const summary = res.best ? { laps: res.laps.length, best: res.best.time } : null;
  if (JSON.stringify(summary) !== JSON.stringify(session.summary || null)) { session.summary = summary; S.saveSession(session); }
  renderAnalysis();
}

function renderAnalysis() {
  const { trace, res, track } = cur;
  $('anaEmpty').hidden = true; $('anaBody').hidden = false;
  const s = trace.sensor;
  $('anaInfo').innerHTML = [
    `コース <b>${esc(track.name)}</b>`,
    `周回 <b>${res.laps.length}</b>`,
    `ベスト <b class="mono">${C.fmtLap(res.best?.time)}</b>`,
    res.theoretical ? `理論ベスト <b class="mono">${C.fmtLap(res.theoretical)}</b>` : '',
    `GPS <b>${trace.rateHz.toFixed(1)} Hz</b>${trace.useDoppler ? '（ドップラー速度）' : '（位置から速度算出）'}`,
    s ? (s.ok ? `Gセンサー <b class="good">向き推定OK</b>（一致度 ${(s.quality * 100).toFixed(0)}%）` : `Gセンサー <b class="bad">向き推定できず</b>`) : 'Gセンサー なし',
    res.auto ? 'S/Fライン: <b>自動</b>（最高速地点）' : `S/Fライン: <b>${track.sfAuto ? '自動保存' : '手動設定'}</b>`,
  ].filter(Boolean).join('<span class="muted">｜</span>');
  $('optSensorG').disabled = !(s && s.ok);
  if (!(s && s.ok)) $('optSensorG').checked = false;
  renderLapTable();
  computeCompare();
  renderMap();
  renderCharts();
  renderTables();
}

function renderLapTable() {
  const { res, ref, cmp } = cur;
  const best = res.best;
  const ns = Math.max(0, ...res.laps.map(l => l.sectors.length));
  const bestSec = [];
  for (let j = 0; j < ns; j++) bestSec[j] = Math.min(...res.laps.filter(l => l.valid && l.sectors[j]).map(l => l.sectors[j]));
  const rows = res.laps.map((l, i) => {
    const ch = C.lapData(cur.trace, l);
    const st = C.lapStats(ch);
    return `<tr class="${l === best ? 'best' : ''} ${l.valid ? '' : 'invalid'}">
      <td>${l.no}${l === best ? ' ★' : ''}</td>
      <td><input type="radio" name="refLap" value="${i}" ${l === ref ? 'checked' : ''} aria-label="基準"></td>
      <td><input type="radio" name="cmpLap" value="${i}" ${l === cmp ? 'checked' : ''} aria-label="比較"></td>
      <td class="mono">${C.fmtLap(l.time)}</td>
      <td class="mono ${l === best ? '' : 'bad'}">${l === best || !best ? '' : C.fmtDelta(l.time - best.time)}</td>
      ${l.sectors.map((t, j) => `<td class="mono ${Math.abs(t - bestSec[j]) < 1e-6 ? 'good' : ''}">${t.toFixed(2)}</td>`).join('')}${'<td></td>'.repeat(ns - l.sectors.length)}
      <td>${kmh(st.vmax).toFixed(0)}</td>
    </tr>`;
  }).join('');
  $('lapTable').innerHTML = `<thead><tr><th>周</th><th><span class="sw ref"></span>基準</th><th><span class="sw cmp"></span>比較</th><th>タイム</th><th>差</th>${Array.from({ length: ns }, (_, j) => `<th>S${j + 1}</th>`).join('')}<th>最高km/h</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7">周回が検出できませんでした（S/Fラインを地図で設定してみてください）</td></tr>`}</tbody>
    ${res.laps.length ? `<tfoot><tr><td></td><td></td><td><label class="inline"><input type="radio" name="cmpLap" value="-1" ${!cmp ? 'checked' : ''}>なし</label></td><td colspan="${3 + ns}"></td></tr></tfoot>` : ''}`;
}
$('lapTable').addEventListener('change', (e) => {
  if (e.target.name === 'refLap') cur.ref = cur.res.laps[+e.target.value];
  if (e.target.name === 'cmpLap') cur.cmp = +e.target.value < 0 ? null : cur.res.laps[+e.target.value];
  if (cur.cmp === cur.ref) cur.cmp = null;
  computeCompare(); renderLapTable(); renderMap(); renderCharts(); renderTables();
});

function computeCompare() {
  const { trace, ref, cmp } = cur;
  cur.rsRef = ref ? C.resampleByDistance(C.lapData(trace, ref), 1) : null;
  cur.rsCmp = ref && cmp ? C.resampleByDistance(C.lapData(trace, cmp), 1, cur.rsRef.length) : null;
}
const useSensor = () => $('optSensorG').checked && cur.trace.sensor && cur.trace.sensor.ok;
const gLong = (rs) => (useSensor() && rs.sLong ? rs.sLong : rs.longG);
const gLat = (rs) => (useSensor() && rs.sLat ? rs.sLat : rs.latG);
$('optSensorG').addEventListener('change', () => { renderCharts(); renderTables(); renderMap(); });

// ---------- 地図 ----------
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { preferCanvas: true, zoomControl: true, attributionControl: true });
  baseLayers.sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri' });
  baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
  baseLayers.sat.addTo(map);
  map.on('click', onMapClick);
}
$('mapLayer').addEventListener('change', (e) => {
  Object.values(baseLayers).forEach(l => map.removeLayer(l));
  if (baseLayers[e.target.value]) baseLayers[e.target.value].addTo(map);
});
$('mapColor').addEventListener('change', renderMap);

function colorScale(t) { // 0..1 → 青→シアン→緑→黄→赤
  t = Math.max(0, Math.min(1, t));
  const stops = [[0, [48, 86, 214]], [0.25, [36, 180, 220]], [0.5, [60, 200, 90]], [0.75, [245, 205, 40]], [1, [230, 50, 40]]];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i]; const f = (t - a) / (b - a);
    return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * f)).join(',')})`;
  }
  return 'rgb(230,50,40)';
}
function gColor(g) { // 前後G: 減速=赤, 加速=緑
  const m = Math.min(1, Math.abs(g) / 0.8);
  if (g < -0.05) return `rgb(${Math.round(120 + 115 * m)},${Math.round(120 - 90 * m)},${Math.round(120 - 90 * m)})`;
  if (g > 0.05) return `rgb(${Math.round(120 - 90 * m)},${Math.round(130 + 90 * m)},${Math.round(120 - 60 * m)})`;
  return 'rgb(150,150,150)';
}

function coloredLine(rs, colorFn, weight) {
  const layer = L.layerGroup();
  let seg = [], col = null;
  for (let i = 0; i < rs.lat.length; i += 2) {
    const c = colorFn(i);
    const p = [rs.lat[i], rs.lon[i]];
    if (c !== col && seg.length) { seg.push(p); L.polyline(seg, { color: col, weight, opacity: 0.95 }).addTo(layer); seg = []; }
    col = c; seg.push(p);
  }
  if (seg.length > 1) L.polyline(seg, { color: col, weight, opacity: 0.95 }).addTo(layer);
  return layer;
}

function renderMap() {
  initMap();
  if (!map) { $('mapHint').textContent = '地図ライブラリを読み込めませんでした（オフライン？）'; return; }
  Object.values(mapLayers).forEach(l => map.removeLayer(l));
  mapLayers = {};
  const { trace, rsRef, rsCmp, res, track } = cur;
  // セッション全体（薄く）
  const all = []; for (let k = 0; k < trace.n; k += 5) all.push([trace.lat[k], trace.lon[k]]);
  mapLayers.all = L.polyline(all, { color: '#888', weight: 1, opacity: 0.5 }).addTo(map);
  const mode = $('mapColor').value;
  const refC = cssVar('--ref'), cmpC = cssVar('--cmp');
  if (rsCmp) mapLayers.cmp = L.polyline(Array.from(rsCmp.lat, (la, i) => [la, rsCmp.lon[i]]), { color: cmpC, weight: mode === 'plain' ? 3 : 2, opacity: 0.9, dashArray: mode === 'plain' ? null : '4 4' }).addTo(map);
  if (rsRef) {
    let vmin = Infinity, vmax = 0; for (const v of rsRef.v) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    const quant = (x, n) => Math.round(x * n) / n;
    const lg = gLong(rsRef), la = gLat(rsRef);
    const fn = mode === 'speed' ? (i) => colorScale(quant((rsRef.v[i] - vmin) / (vmax - vmin || 1), 16))
      : mode === 'long' ? (i) => gColor(quant(lg[i], 10))
        : mode === 'lat' ? (i) => colorScale(quant(Math.abs(la[i]) / 1.2, 12))
          : () => refC;
    mapLayers.ref = coloredLine(rsRef, fn, 5).addTo(map);
    // 凡例
    $('mapLegend').innerHTML = mode === 'speed' ? `<span>${kmh(vmin).toFixed(0)} km/h</span><span class="bar" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(colorScale).join(',')})"></span><span>${kmh(vmax).toFixed(0)} km/h</span><span>（基準ラップ）</span>`
      : mode === 'long' ? `<span>減速</span><span class="bar" style="background:linear-gradient(90deg,${gColor(-0.8)},${gColor(0)},${gColor(0.8)})"></span><span>加速</span>`
        : mode === 'lat' ? `<span>0G</span><span class="bar" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(colorScale).join(',')})"></span><span>1.2G</span>`
          : `<span class="sw ref"></span> 基準 <span class="sw cmp"></span> 比較`;
    if (rsCmp && mode !== 'plain') $('mapLegend').innerHTML += ' <span class="sw cmp"></span> 比較ラップ（点線）';
    // ブレーキ開始地点
    const bz = C.brakingZones({ ...rsRef, longG: gLong(rsRef) });
    mapLayers.brake = L.layerGroup(bz.map((z, i) => L.circleMarker([rsRef.lat[z.iStart], rsRef.lon[z.iStart]], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#e63946', fillOpacity: 1 }).bindTooltip(`B${i + 1} ブレーキ開始 ${kmh(z.vEntry).toFixed(0)}km/h → ${kmh(z.vMin).toFixed(0)}km/h`))).addTo(map);
  } else $('mapLegend').innerHTML = '';
  // ライン
  const lineLayer = (l, color, label) => L.polyline([[l.a.lat, l.a.lon], [l.b.lat, l.b.lon]], { color, weight: 4 }).bindTooltip(label, { permanent: true, direction: 'right', className: '' });
  const lines = [];
  if (res.sf) lines.push(lineLayer(res.sf, '#ffffff', 'S/F'));
  (track.sectors || []).forEach((l, i) => lines.push(lineLayer(l, '#ffd43b', `S${i + 1}`)));
  mapLayers.lines = L.layerGroup(lines).addTo(map);
  cursorMarkers.forEach(m => map.removeLayer(m)); cursorMarkers = [];
  if (!renderMap.fitted || renderMap.fitted !== cur.session.id) {
    map.fitBounds(L.latLngBounds(all), { padding: [16, 16] });
    renderMap.fitted = cur.session.id;
  }
  setMapMode(mapMode);
}

function setMapMode(m) {
  mapMode = m;
  $('btnSetSF').classList.toggle('active', m === 'sf');
  $('btnAddSector').classList.toggle('active', m === 'sector');
  $('mapHint').textContent = m === 'sf' ? '地図上のS/F（コントロール）ライン付近をタップしてください。走行ラインに直交するラインを置きます。'
    : m === 'sector' ? 'セクターの区切りにしたい地点をタップしてください。'
      : '★ ライン設定はコースごとに保存され、次回以降のセッションと計測中のラップ表示にも使われます。';
}
$('btnSetSF').addEventListener('click', () => setMapMode(mapMode === 'sf' ? null : 'sf'));
$('btnAddSector').addEventListener('click', () => setMapMode(mapMode === 'sector' ? null : 'sector'));
$('btnClearSector').addEventListener('click', () => { cur.track.sectors = []; saveTrack(cur.track); recompute(); toast('セクターを消去しました'); });
function onMapClick(e) {
  if (!mapMode || !cur) return;
  const { k, d } = C.nearestIndex(cur.trace, e.latlng.lat, e.latlng.lng);
  if (k < 0 || d > 40) { toast('走行ラインの近くをタップしてください'); return; }
  // その地点を速く通過したサンプルの方位を使う（ピット等の低速通過を避ける）
  let kk = k, bestV = cur.trace.v[k];
  for (let j = 0; j < cur.trace.n; j++) {
    if (cur.trace.v[j] <= bestV) continue;
    const dd = Math.hypot(cur.trace.x[j] - cur.trace.x[k], cur.trace.y[j] - cur.trace.y[k]);
    if (dd < 6) { kk = j; bestV = cur.trace.v[j]; }
  }
  const line = C.lineAt(cur.trace, kk, 40);
  if (mapMode === 'sf') { cur.track.sf = line; cur.track.sfAuto = false; toast('S/Fラインを設定しました'); }
  else { cur.track.sectors = [...(cur.track.sectors || []), line]; sortSectors(); toast(`セクターライン ${cur.track.sectors.length} を追加しました`); }
  if (!cur.track.center && cur.track.id !== 'demo') cur.track.center = { lat: cur.trace.proj.lat0, lon: cur.trace.proj.lon0 };
  saveTrack(cur.track);
  setMapMode(null);
  cur.ref = null;
  recompute(true);
}
// セクターラインを周回順に並べる
function sortSectors() {
  const { trace, track } = cur;
  const res = C.detectLaps(trace, { ...track, sectors: [] });
  const lap = res.best; if (!lap) return;
  const pos = (l) => { const c = C.findCrossings(trace, l, { minInterval: 1 }).find(c => c.t > lap.start && c.t < lap.end); return c ? c.t : Infinity; };
  track.sectors = track.sectors.map(l => ({ l, t: pos(l) })).filter(o => Number.isFinite(o.t)).sort((a, b) => a.t - b.t).map(o => o.l);
}

// ---------- グラフ ----------
function initCharts() {
  if (group) return;
  group = new ChartGroup();
  charts.speed = group.add(new LineChart($('cSpeed'), { title: '速度', unit: 'km/h', height: 190, fmt: v => v.toFixed(1) }));
  charts.delta = group.add(new LineChart($('cDelta'), { title: 'タイム差（比較 − 基準）', unit: '秒', height: 120, zeroLine: true, fmt: v => C.fmtDelta(v) }));
  charts.long = group.add(new LineChart($('cLong'), { title: '前後G（＋加速／−ブレーキ）', unit: 'G', height: 150, zeroLine: true, fmt: v => v.toFixed(2) }));
  charts.lat = group.add(new LineChart($('cLat'), { title: '横G（＋右／−左）', unit: 'G', height: 150, zeroLine: true, symmetric: true, fmt: v => v.toFixed(2) }));
  group.onCursor = (x) => updateCursor(x);
  $('zIn').addEventListener('click', () => zoom(0.6));
  $('zOut').addEventListener('click', () => zoom(1 / 0.6));
  $('zAll').addEventListener('click', () => group.setRange(...group.full));
}
function zoom(f) {
  const c = group.cursor ?? (group.x0 + group.x1) / 2;
  group.setRange(c - (c - group.x0) * f, c + (group.x1 - c) * f);
}
function renderCharts() {
  initCharts();
  const { rsRef: r, rsCmp: c } = cur;
  if (!r) { Object.values(charts).forEach(ch => ch.setSeries([])); return; }
  const refC = cssVar('--ref'), cmpC = cssVar('--cmp');
  const d = Array.from(r.d);
  const ser = (rs, y, color, label, extra = {}) => ({ x: d, y: Array.from(y), color, label, ...extra });
  const bz = C.brakingZones({ ...r, longG: gLong(r) });
  const cs = C.corners({ ...r, latG: gLat(r) });
  const marks = [...bz.map((z, i) => ({ x: z.dStart, color: '#e63946', label: `B${i + 1}` })), ...cs.map((k, i) => ({ x: k.d, color: '#8a8f98', label: `C${i + 1}`, row: 1 }))];
  charts.speed.setSeries([ser(r, r.v.map(kmh), refC, '基準'), ...(c ? [ser(c, c.v.map(kmh), cmpC, '比較')] : [])], marks);
  charts.delta.setSeries(c ? [ser(r, C.deltaTime(r, c), cmpC, 'Δ', { width: 2 })] : [], marks);
  charts.long.setSeries([ser(r, gLong(r), refC, '基準'), ...(c ? [ser(c, gLong(c), cmpC, '比較')] : [])], bz.map((z, i) => ({ x: z.dStart, color: '#e63946', label: `B${i + 1}` })));
  charts.lat.setSeries([ser(r, gLat(r), refC, '基準'), ...(c ? [ser(c, gLat(c), cmpC, '比較')] : [])], cs.map((k, i) => ({ x: k.d, color: '#8a8f98', label: `C${i + 1}` })));
  $('cDelta').style.display = c ? '' : 'none';
  if (group.full[1] !== r.length) group.setFull(0, r.length); else group.draw();
  drawGGNow();
}
function drawGGNow(cursorIdx = null) {
  const { rsRef: r, rsCmp: c } = cur;
  if (!r) return;
  const sets = [{ lat: gLat(r), lon: gLong(r), color: cssVar('--ref') }];
  if (c) sets.push({ lat: gLat(c), lon: gLong(c), color: cssVar('--cmp') });
  const pts = [];
  if (cursorIdx !== null) {
    pts.push({ lat: gLat(r)[cursorIdx], lon: gLong(r)[cursorIdx], color: cssVar('--ref') });
    if (c && cursorIdx < c.d.length) pts.push({ lat: gLat(c)[cursorIdx], lon: gLong(c)[cursorIdx], color: cssVar('--cmp') });
  }
  drawGG($('cGG'), sets, pts);
}
function updateCursor(x) {
  const { rsRef: r, rsCmp: c } = cur;
  if (!r || !map) return;
  const i = Math.max(0, Math.min(r.d.length - 1, Math.round(x)));
  const mk = (rs, color) => L.circleMarker([rs.lat[i], rs.lon[i]], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
  cursorMarkers.forEach(m => map.removeLayer(m));
  cursorMarkers = [mk(r, cssVar('--ref')).addTo(map)];
  if (c && i < c.d.length) cursorMarkers.push(mk(c, cssVar('--cmp')).addTo(map));
  drawGGNow(i);
}
window.addEventListener('resize', () => cur && drawGGNow());

// ---------- 表・コーチング ----------
function renderTables() {
  const { rsRef: r, rsCmp: c } = cur;
  if (!r) { $('brakeTable').innerHTML = ''; $('cornerTable').innerHTML = ''; $('coach').innerHTML = ''; return; }
  const R = { ...r, longG: gLong(r), latG: gLat(r) };
  const Cc = c ? { ...c, longG: gLong(c), latG: gLat(c) } : null;
  const bzR = C.brakingZones(R), bzC = Cc ? C.brakingZones(Cc) : [];
  const match = (z) => { let b = null, bd = 60; for (const y of bzC) { const dd = Math.abs(y.dStart - z.dStart); if (dd < bd) { bd = dd; b = y; } } return b; };
  $('brakeTable').innerHTML = `<thead><tr><th>#</th><th>開始位置</th><th>進入速度</th><th>最低速度</th><th>最大減速</th>${c ? '<th>比較: 開始</th><th>進入</th><th>最低</th><th>最大</th>' : ''}</tr></thead><tbody>` +
    bzR.map((z, i) => {
      const m = c ? match(z) : null;
      const diff = m ? m.dStart - z.dStart : null;
      return `<tr><td>B${i + 1}</td><td>${z.dStart.toFixed(0)} m</td><td>${kmh(z.vEntry).toFixed(0)}</td><td>${kmh(z.vMin).toFixed(0)}</td><td>${z.peakG.toFixed(2)} G</td>
      ${c ? (m ? `<td>${diff >= 0 ? `${diff.toFixed(0)}m 奥` : `${(-diff).toFixed(0)}m 手前`}</td><td>${kmh(m.vEntry).toFixed(0)}</td><td>${kmh(m.vMin).toFixed(0)}</td><td>${m.peakG.toFixed(2)}</td>` : '<td colspan="4" class="muted">対応なし</td>') : ''}</tr>`;
    }).join('') + '</tbody>';
  const csR = C.corners(R);
  const csC = Cc ? C.matchCorners(csR, Cc) : [];
  $('cornerTable').innerHTML = `<thead><tr><th>#</th><th>位置</th><th>向き</th><th>基準 最低速度</th><th>横G</th>${c ? '<th>比較 最低速度</th><th>差</th>' : ''}</tr></thead><tbody>` +
    csR.map((k, i) => {
      const m = csC[i];
      const dv = m ? kmh(m.vMin - k.vMin) : null;
      return `<tr><td>C${i + 1}</td><td>${k.d.toFixed(0)} m</td><td>${k.dir}</td><td>${kmh(k.vMin).toFixed(1)}</td><td>${Math.abs(k.latG).toFixed(2)}</td>${c ? (m ? `<td>${kmh(m.vMin).toFixed(1)}</td><td class="${dv >= 0 ? 'good' : 'bad'}">${dv >= 0 ? '+' : ''}${dv.toFixed(1)}</td>` : '<td>-</td><td></td>') : ''}</tr>`;
    }).join('') + '</tbody>';
  renderCoach(R, Cc, csR, bzR, bzC);
}

function renderCoach(r, c, cs, bzR, bzC) {
  const items = [];
  if (c) {
    const dl = C.deltaTime(r, c);
    // コーナー間で区間を切り、差の増減を見る
    const cuts = [0, ...cs.map((k, i) => (i + 1 < cs.length ? (k.d + cs[i + 1].d) / 2 : null)).filter(v => v !== null), r.length];
    const segs = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = Math.round(cuts[i]), b = Math.min(dl.length - 1, Math.round(cuts[i + 1]));
      const corner = cs.findIndex(k => k.d >= a && k.d < b);
      segs.push({ a, b, loss: dl[b] - dl[a], corner });
    }
    segs.sort((p, q) => Math.abs(q.loss) - Math.abs(p.loss));
    for (const sg of segs.slice(0, 3)) {
      if (Math.abs(sg.loss) < 0.05) continue;
      const k = sg.corner >= 0 ? cs[sg.corner] : null;
      const where = k ? `C${sg.corner + 1}（${k.d.toFixed(0)}m・${k.dir}）付近` : `${sg.a}〜${sg.b}m`;
      let why = '';
      if (k) {
        const m = C.matchCorners([k], c)[0];
        if (m) { const dv = kmh(m.vMin - k.vMin); why = `最低速度 ${dv >= 0 ? '+' : ''}${dv.toFixed(1)} km/h`; }
        const zr = bzR.filter(z => z.dStart < k.d && z.dStart > k.d - 200).pop();
        const zc = zr && bzC.find(z => Math.abs(z.dStart - zr.dStart) < 60);
        if (zr && zc) { const dd = zc.dStart - zr.dStart; if (Math.abs(dd) >= 3) why += `、ブレーキ開始 ${dd > 0 ? `${dd.toFixed(0)}m 奥` : `${(-dd).toFixed(0)}m 手前`}`; }
      }
      items.push(`<li>${where}: 比較ラップが <b class="${sg.loss > 0 ? 'bad' : 'good'}">${sg.loss > 0 ? `${sg.loss.toFixed(2)} 秒ロス` : `${(-sg.loss).toFixed(2)} 秒ゲイン`}</b>${why ? `（${why}）` : ''}</li>`);
    }
  }
  const st = C.lapStats(r);
  const head = `<b>基準ラップ ${C.fmtLap(r.time)}</b>：最高 ${kmh(st.vmax).toFixed(0)} km/h ／ 最大減速 ${Math.abs(st.maxBrake).toFixed(2)} G ／ 最大横G ${st.maxLat.toFixed(2)} G`;
  $('coach').innerHTML = head + (items.length ? `<div>差が大きい区間:</div><ul>${items.join('')}</ul>` : '');
}

// ================= 設定 =================
function renderSettings() {
  $('trackList').innerHTML = tracks.map(t => `
    <div class="track-card" data-id="${esc(t.id)}">
      <div class="row"><span>名前</span><input type="text" data-f="name" value="${esc(t.name)}"></div>
      <div class="row"><span>最短ラップ(秒)</span><input type="number" data-f="minLapSec" value="${t.minLapSec ?? 20}" min="5" max="600"></div>
      <div class="row"><span>S/Fライン</span><span>${t.sf ? `${t.sfAuto ? '自動' : '手動'}（${t.sf.a.lat.toFixed(5)}, ${t.sf.a.lon.toFixed(5)}）` : '未設定'} ・ セクター ${t.sectors?.length || 0}</span></div>
      <div class="toolbar wrap">
        <button class="btn sm" data-act="resetLine">ラインをリセット</button>
        ${t.id !== 'honjo' ? '<button class="btn sm danger" data-act="del">コース削除</button>' : ''}
      </div>
    </div>`).join('');
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { $('storageInfo').textContent = `使用容量: 約 ${(e.usage / 1e6).toFixed(1)} MB`; });
}
$('trackList').addEventListener('change', (e) => {
  const card = e.target.closest('.track-card'); const t = trackById(card.dataset.id); if (!t) return;
  const f = e.target.dataset.f;
  if (f === 'name') t.name = e.target.value;
  if (f === 'minLapSec') t.minLapSec = Math.max(5, +e.target.value || 20);
  saveTrack(t);
});
$('trackList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const t = trackById(b.closest('.track-card').dataset.id);
  if (b.dataset.act === 'resetLine' && confirm('S/Fラインとセクターをリセットしますか？')) { t.sf = null; t.sectors = []; t.sfAuto = false; saveTrack(t); }
  if (b.dataset.act === 'del' && confirm(`コース「${t.name}」を削除しますか？`)) { tracks = tracks.filter(x => x !== t); S.saveTracks(tracks); }
  renderSettings();
});
$('btnBackup').addEventListener('click', async () => {
  const list = await S.listSessions();
  const sessions = [];
  for (const s of list) sessions.push(await S.getSession(s.id));
  download(`lap-logger-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, tracks, sessions }), 'application/json');
});
async function restoreBackup(j) {
  if (Array.isArray(j.tracks)) { for (const t of j.tracks) if (!trackById(t.id)) tracks.push(t); S.saveTracks(tracks); }
  for (const s of j.sessions || []) await S.saveSession(s);
  toast(`復元しました（${(j.sessions || []).length} セッション）`);
}
$('fileRestore').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await restoreBackup(JSON.parse(await f.text())); renderSettings(); } catch (err) { toast('復元に失敗: ' + err.message); }
  e.target.value = '';
});

// ================= 起動 =================
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
// 記録途中で落ちたセッションの通知
S.listSessions().then(list => { if (list.length && !list[0].summary && !list[0].demo && Date.now() - list[0].startedAt < 6 * 3600e3) $('lapHint').textContent = `前回の記録「${list[0].name}」は保存済みです（セッション一覧から分析できます）。`; });
