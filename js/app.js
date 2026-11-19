// アプリ本体: 画面の切り替え・コース管理・各画面の初期化
import * as C from './core.js';
import * as S from './store.js';
import { $, toast, LOGO, ICON } from './ui/util.js';
import * as Logger from './ui/logger.js';
import * as Sessions from './ui/sessions.js';
import * as Analysis from './ui/analysis.js';
import * as Settings from './ui/settings.js';

const app = {
  prefs: S.loadPrefs(),
  tracks: S.loadTracks(),
  view: 'log',
  savePrefs() { S.savePrefs(this.prefs); },
  applyTheme() {
    const t = this.prefs.theme;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name=theme-color]').content = dark ? '#090c11' : '#ffffff';
  },

  // ---- コース ----
  trackById(id) { return this.tracks.find(t => t.id === id) || null; },
  saveTrack(t) {
    const i = this.tracks.findIndex(x => x.id === t.id);
    if (i >= 0) this.tracks[i] = t; else this.tracks.push(t);
    if (!S.saveTracks(this.tracks)) toast('コース設定を保存できませんでした（容量不足？）', 5000);
  },
  deleteTrack(id) { this.tracks = this.tracks.filter(t => t.id !== id); S.saveTracks(this.tracks); },
  trackForPoint(lat, lon, create = true) {
    let best = null, bd = Infinity;
    for (const t of this.tracks) {
      if (!t.center || t.id === 'demo') continue;
      const d = C.haversine(lat, lon, t.center.lat, t.center.lon) / 1000;
      if (d < (t.radiusKm ?? 3) && d < bd) { bd = d; best = t; }
    }
    if (best || !create) return best;
    const t = { id: S.newId(), name: `コース (${lat.toFixed(3)}, ${lon.toFixed(3)})`, center: { lat, lon }, radiusKm: 3, sf: null, sectors: [], minLapSec: 20 };
    this.saveTrack(t);
    return t;
  },
  ensureTrack(session) {
    let t = session.trackId && this.trackById(session.trackId);
    if (t) return t;
    if (session.demo || session.trackId === 'demo') {
      t = this.trackById('demo') || { id: 'demo', name: 'デモコース（架空）', center: null, radiusKm: 0, sf: null, sectors: [], minLapSec: 20, note: 'デモデータ用の架空のコースです' };
      this.saveTrack(t);
    } else {
      const p = session.samples[Math.floor(session.samples.length / 2)] || session.samples[0];
      t = this.trackForPoint(p.lat, p.lon, true);
    }
    session.trackId = t.id;
    return t;
  },
  guessTrack() { return this.trackById(this.prefs.lastTrackId) || this.trackById('honjo') || this.tracks[0] || null; },
  setTrackChip(name) { $('trackChip').textContent = name || ''; $('trackChip').hidden = !name; },
  setRecording(on) { $('recBadge').hidden = !on; },

  // ---- 画面 ----
  showView(name, opts = {}) {
    if (this.view === 'log' && name !== 'log') Logger.onHide();
    this.view = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (!opts.noRender) {
      if (name === 'log') Logger.onShow();
      if (name === 'sessions') Sessions.render();
      if (name === 'analysis') Analysis.onShow();
      if (name === 'settings') Settings.render();
    }
    if (name !== 'analysis' || !Analysis.currentSessionId()) history.replaceState(null, '', `#${name}`);
    window.scrollTo(0, 0);
  },
  openAnalysis(id) { return Analysis.open(id); },
  sessionsChanged() { if (this.view === 'sessions') Sessions.render(); Analysis.refreshSessionList(); },
  sessionDeleted() { Analysis.invalidate(); },
  analysisInvalidate() { Analysis.invalidate(); },
  editSessionInfo(id) { return Sessions.editInfo(id); },
  async restoreBackup(j) {
    if (Array.isArray(j.tracks)) {
      for (const t of j.tracks) {
        const cur = this.trackById(t.id);
        if (!cur || (!cur.model && t.model)) this.saveTrack(t);
      }
    }
    for (const s of j.sessions || []) await S.saveSession(s);
    toast(`復元しました（${(j.sessions || []).length} セッション）`);
    this.sessionsChanged();
  },
};

function init() {
  app.applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => app.applyTheme());
  $('brand').innerHTML = `${LOGO}<b>LAP LOGGER</b>`;
  document.querySelectorAll('.tabbar button').forEach(b => {
    b.insertAdjacentHTML('afterbegin', ICON[b.dataset.icon]);
    b.addEventListener('click', () => {
      if (b.dataset.view === 'analysis' && Analysis.currentSessionId()) { app.showView('analysis'); history.replaceState(null, '', `#analysis/${Analysis.currentSessionId()}`); }
      else app.showView(b.dataset.view);
    });
  });
  $('btnDemo').innerHTML = `${ICON.sparkle} デモデータ`;
  $('lblImport').insertAdjacentHTML('afterbegin', ICON.upload);
  $('anaExport').innerHTML = ICON.share;
  Logger.initLogger(app);
  Sessions.initSessions(app);
  Analysis.initAnalysis(app);
  Settings.initSettings(app);
  app.setTrackChip(app.guessTrack()?.name);
  const h = location.hash.replace('#', '');
  if (h.startsWith('analysis/')) Analysis.open(h.split('/')[1]);
  else app.showView(['log', 'sessions', 'analysis', 'settings'].includes(h) ? h : 'log');
  // 前回の記録が途中で終わっていないか
  S.listSessions().then(list => {
    const broken = list.find(s => s.recording);
    if (broken && !Logger.isRecording()) toast(`前回の記録「${broken.name}」は途中で終了しましたが、そこまでのデータは保存されています`, 6000);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
init();
