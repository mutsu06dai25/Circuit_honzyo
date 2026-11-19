// 設定画面
import * as C from '../core.js';
import * as S from '../store.js';
import { $, esc, toast, confirmSheet, saveFile, ICON } from './util.js';

let app = null;
export function initSettings(ctx) { app = ctx; }

export function render() {
  const p = app.prefs;
  const el = $('view-settings');
  el.innerHTML = `
    <h2>設定</h2>
    <div class="card">
      <div class="card-title">表示</div>
      <div class="set-row"><div class="l">テーマ</div><div class="seg" id="setTheme">${[['auto', '自動'], ['dark', 'ダーク'], ['light', 'ライト']].map(([v, l]) => `<button data-v="${v}" class="${p.theme === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    </div>
    <div class="card">
      <div class="card-title">解析・計測</div>
      <div class="set-row"><div class="l">G の算出方法<small>自動: センサーの向き推定に成功したら加速度・ジャイロを使い、だめなら GPS から計算</small></div>
        <select id="setG"><option value="auto" ${p.gSource === 'auto' ? 'selected' : ''}>自動（推奨）</option><option value="gps" ${p.gSource === 'gps' ? 'selected' : ''}>GPS のみ</option></select></div>
      <div class="set-row"><div class="l">ラップの読み上げ<small>計測中にラップタイムを音声で</small></div><input type="checkbox" id="setVoice" ${p.voice ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></div>
      <div class="set-row"><div class="l">バイブレーション<small>ラップ通過時（Android）</small></div><input type="checkbox" id="setVib" ${p.vibrate ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></div>
    </div>
    <h3>コース</h3>
    <div id="trackList">${app.tracks.map(trackCard).join('')}</div>
    <h3>データ</h3>
    <div class="card">
      <div class="row"><button class="btn" id="btnBackup">${ICON.share} 全データをバックアップ</button>
        <label class="btn">${ICON.upload} バックアップから復元<input type="file" id="fileRestore" accept=".json,application/json" hidden></label>
        <span class="spacer"></span><button class="btn danger ghost" id="btnWipe">${ICON.trash} 全セッションを削除</button></div>
      <p class="hint" id="storageInfo"></p>
    </div>
    <h3>このアプリについて</h3>
    <div class="card">
      <p style="margin-top:0">スマホの GPS（位置・ドップラー速度・方位）と加速度センサー・ジャイロから、ラップタイム・速度・ブレーキ／加速・横G・走行ラインを解析します。データはこの端末のブラウザ内にだけ保存され、外部には送信しません（地図の背景画像と、ボタンを押したときの天気・OSM の取得を除く）。</p>
      <ul class="tips">
        <li>符号: 横G・ライン位置は<b>右が＋</b>、前後Gは<b>加速が＋</b>。</li>
        <li>精度の目安（スマホ GPS 1Hz）: ラップタイム ±0.1 秒程度、位置 ±1〜3 m。速度は加速度センサーがあれば GPS の間を補完します。</li>
        <li>コース形状は走行データから作ります（ラップを平均）。セッションを重ねるほど正確になり、別の日の GPS のずれも自動で補正します。</li>
        <li>参考にした機能: 予測ラップタイム・理論ベスト・区間タイム（RaceChrono / Harry's LapTimer / AiM）、ブレーキ位置とコーナー分析（VBOX Circuit Tools）、改善ポイント TOP3（Garmin Catalyst）。</li>
      </ul>
      <p class="hint">地図: © OpenStreetMap contributors / Imagery © Esri ・ 地図ライブラリ Leaflet ・ 数字フォント Barlow Condensed (OFL)</p>
    </div>`;
  $('setTheme').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; p.theme = b.dataset.v; app.savePrefs(); app.applyTheme(); render(); };
  $('setG').onchange = (e) => { p.gSource = e.target.value; app.savePrefs(); app.analysisInvalidate(); toast('次に開く解析から反映します'); };
  $('setVoice').onchange = (e) => { p.voice = e.target.checked; app.savePrefs(); };
  $('setVib').onchange = (e) => { p.vibrate = e.target.checked; app.savePrefs(); };
  $('trackList').addEventListener('change', onTrackChange);
  $('trackList').addEventListener('click', onTrackClick);
  $('btnBackup').onclick = backup;
  $('fileRestore').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { await app.restoreBackup(JSON.parse(await f.text())); render(); } catch (err) { toast('復元に失敗: ' + err.message, 5000); }
    e.target.value = '';
  };
  $('btnWipe').onclick = async () => {
    if (!await confirmSheet('すべてのセッションを削除します。元に戻せません。先にバックアップを取ることをおすすめします。', '削除する', true)) return;
    await S.clearAll(); app.sessionsChanged(); app.sessionDeleted(null); toast('削除しました'); render();
  };
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { const el2 = $('storageInfo'); if (el2) el2.textContent = `使用容量: 約 ${(e.usage / 1e6).toFixed(1)} MB${e.quota ? ` / 上限 約 ${(e.quota / 1e9).toFixed(1)} GB` : ''}`; });
}

function trackCard(t) {
  const m = t.model;
  return `<details class="box" data-id="${esc(t.id)}"><summary>${ICON.flag.replace('<svg', '<svg width="18" height="18"')} ${esc(t.name)} <span class="muted" style="font-weight:400;font-size:12px">${m ? `${m.length.toFixed(0)} m ・ ${m.corners ? m.corners.length : 0} コーナー` : 'コース形状 未作成'}${t.best ? ` ・ ベスト ${C.fmtLap(t.best.time)}` : ''}</span></summary>
    <div class="form-grid">
      <label>コース名<input type="text" data-f="name" value="${esc(t.name)}"></label>
      <label>最短ラップ（秒）<input type="number" data-f="minLapSec" value="${t.minLapSec ?? 20}" min="5" max="900"></label>
    </div>
    <div class="set-row"><div class="l">S/F ライン<small>${t.sf ? `${t.sfAuto ? '自動設定' : '手動設定'}（${t.sf.a.lat.toFixed(5)}, ${t.sf.a.lon.toFixed(5)}）` : '未設定（走行すると自動で設定）'} ・ セクター ${t.sectors ? t.sectors.length : 0}</small></div><button class="btn sm" data-act="resetLines">リセット</button></div>
    <div class="set-row"><div class="l">コース形状<small>${m ? `${m.lapsUsed} 周分のデータから作成 ・ ${(m.sessions || []).length} セッション ・ 更新 ${new Date(m.updatedAt).toLocaleDateString('ja-JP')}` : '最初の解析で走行データから作ります'}</small></div>${m ? '<button class="btn sm" data-act="resetModel">作り直す</button>' : ''}</div>
    <div class="set-row"><div class="l">地図データからコース図<small>${t.osm ? `OpenStreetMap から取得済み（${t.osm.ways.length} 本）` : 'OpenStreetMap のサーキット形状を取得して重ねて表示（通信あり）'}</small></div><button class="btn sm" data-act="osm">${t.osm ? '再取得' : '取得'}</button></div>
    ${m && m.corners && m.corners.length ? `<div class="card-title" style="margin-top:10px">コーナー名 <span class="muted" style="font-weight:400">（例: 1コーナー、第2ヘアピン）</span></div>
      <div class="corner-names">${m.corners.map((c, i) => `<label>${i + 1}<input type="text" data-corner="${i}" value="${esc(c.name)}" title="${c.dir === 'R' ? '右' : '左'} ${c.angle}°"></label>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:10px"><span class="hint" style="margin:0">${esc(t.note || '')}</span><span class="spacer"></span>${t.id !== 'honjo' ? '<button class="btn sm danger ghost" data-act="del">コースを削除</button>' : ''}</div>
  </details>`;
}
function trackOf(el) { const d = el.closest('details[data-id]'); return d ? app.trackById(d.dataset.id) : null; }
function onTrackChange(e) {
  const t = trackOf(e.target); if (!t) return;
  const f = e.target.dataset.f;
  if (f === 'name') t.name = e.target.value.trim() || t.name;
  if (f === 'minLapSec') t.minLapSec = Math.max(5, +e.target.value || 20);
  if (e.target.dataset.corner !== undefined && t.model) {
    const c = t.model.corners[+e.target.dataset.corner];
    c.name = e.target.value.trim() || `T${+e.target.dataset.corner + 1}`;
    c.custom = !!e.target.value.trim();
  }
  app.saveTrack(t); app.analysisInvalidate();
}
async function onTrackClick(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const t = trackOf(b); if (!t) return;
  const act = b.dataset.act;
  if (act === 'resetLines' && await confirmSheet('S/F ラインとセクターをリセットしますか？（次の解析で自動設定されます）')) { t.sf = null; t.sfAuto = false; t.sectors = []; if (t.best) t.best.ref = null; }
  else if (act === 'resetModel' && await confirmSheet('コース形状とコーナー名をリセットし、次に解析するセッションから作り直します。')) { t.model = null; if (t.best) t.best.ref = null; }
  else if (act === 'del' && await confirmSheet(`コース「${t.name}」の設定を削除しますか？（セッションは残ります）`, '削除する', true)) { app.deleteTrack(t.id); render(); return; }
  else if (act === 'osm') { await fetchOSM(t); }
  else return;
  app.saveTrack(t); app.analysisInvalidate(); render();
  const d = document.querySelector(`#trackList details[data-id="${t.id}"]`); if (d) d.open = true;
}

// OpenStreetMap（Overpass API）からサーキットの形状を取得
async function fetchOSM(t) {
  const c = t.center;
  if (!c) { toast('先にこのコースを走行して位置を記録してください'); return; }
  if (!await confirmSheet('コース周辺の位置を OpenStreetMap（Overpass API）に送って、サーキットの形状データを取得します。')) return;
  toast('取得中…', 4000);
  const q = `[out:json][timeout:25];(way["highway"="raceway"](around:1500,${c.lat},${c.lon});way["sport"="motor"]["highway"](around:1500,${c.lat},${c.lon}););out geom;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const ways = (j.elements || []).filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1).map(e => ({
      pts: e.geometry.map(g => [+g.lat.toFixed(7), +g.lon.toFixed(7)]),
      width: parseFloat(e.tags && e.tags.width) || null,
      name: e.tags && (e.tags.name || e.tags['name:ja']) || '',
    }));
    if (!ways.length) { toast('このあたりにはサーキットの形状データが見つかりませんでした', 5000); return; }
    t.osm = { ways, fetchedAt: Date.now() };
    toast(`コース形状を取得しました（${ways.length} 本）`);
  } catch (e) { toast('取得できませんでした: ' + e.message, 5000); }
}

async function backup() {
  const sessions = await S.allSessions();
  saveFile(`lap-logger-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 2, tracks: app.tracks, prefs: app.prefs, sessions }), 'application/json', { share: true });
}
