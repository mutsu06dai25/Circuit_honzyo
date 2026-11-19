// 保存: セッションは IndexedDB（本体と一覧用の軽いメタ情報を別ストアに）、コースと設定は localStorage
const DB_NAME = 'lap-logger';
const VER = 2;
let dbp = null;

function metaOf(s) {
  const n = s.samples ? s.samples.length : 0;
  return {
    id: s.id, name: s.name, startedAt: s.startedAt, count: n,
    duration: n ? (s.samples[n - 1].t - s.samples[0].t) / 1000 : 0,
    summary: s.summary || null, demo: !!s.demo, trackId: s.trackId || null,
    hasMotion: !!(s.motion && s.motion.length), info: s.info || {}, recording: !!s.recording,
  };
}

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VER);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
        if (ev.oldVersion >= 1) { // 旧版のデータから一覧を作る
          const tx = req.transaction;
          tx.objectStore('sessions').openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return;
            tx.objectStore('meta').put(metaOf(c.value));
            c.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const r = fn(t);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : r);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}

export const saveSession = (s) => tx(['sessions', 'meta'], 'readwrite', t => { t.objectStore('sessions').put(s); t.objectStore('meta').put(metaOf(s)); });
export const getSession = (id) => tx(['sessions'], 'readonly', t => t.objectStore('sessions').get(id));
export const deleteSession = (id) => tx(['sessions', 'meta'], 'readwrite', t => { t.objectStore('sessions').delete(id); t.objectStore('meta').delete(id); });
export async function listSessions() {
  const all = await tx(['meta'], 'readonly', t => t.objectStore('meta').getAll());
  return (all || []).sort((a, b) => b.startedAt - a.startedAt);
}
export async function allSessions() {
  return (await tx(['sessions'], 'readonly', t => t.objectStore('sessions').getAll())) || [];
}
export async function clearAll() { await tx(['sessions', 'meta'], 'readwrite', t => { t.objectStore('sessions').clear(); t.objectStore('meta').clear(); }); }

export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------- コース ----------
const TRACK_KEY = 'lap-logger-tracks-v1';
export const DEFAULT_TRACKS = [
  { id: 'honjo', name: '本庄サーキット', center: { lat: 36.19, lon: 139.13 }, radiusKm: 8, sf: null, sectors: [], minLapSec: 25, lengthM: 1112, note: '埼玉県本庄市児玉町。全長 約1.1km、ストレートとヘアピンを組み合わせたレイアウト' },
];
function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }
export function loadTracks() {
  const v = lsGet(TRACK_KEY);
  if (Array.isArray(v) && v.length) return v;
  return structuredClone(DEFAULT_TRACKS);
}
export function saveTracks(tracks) { return lsSet(TRACK_KEY, tracks); }

// ---------- 設定 ----------
const PREF_KEY = 'lap-logger-prefs-v1';
export const DEFAULT_PREFS = { theme: 'auto', voice: true, vibrate: true, refMode: 'best', gSource: 'auto', motion: true, lastInfo: {}, channels: ['speed', 'delta', 'long', 'lat', 'off'] };
export function loadPrefs() { return { ...DEFAULT_PREFS, ...(lsGet(PREF_KEY) || {}) }; }
export function savePrefs(p) { lsSet(PREF_KEY, p); }
