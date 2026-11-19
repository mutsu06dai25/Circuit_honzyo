// IndexedDB によるセッション保存
const DB_NAME = 'lap-logger';
const VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('sessions', mode);
    const st = t.objectStore('sessions');
    const r = fn(st);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export const saveSession = (s) => tx('readwrite', st => st.put(s));
export const getSession = (id) => tx('readonly', st => st.get(id));
export const deleteSession = (id) => tx('readwrite', st => st.delete(id));
export async function listSessions() {
  const all = await tx('readonly', st => st.getAll());
  return (all || []).map(s => ({ id: s.id, name: s.name, startedAt: s.startedAt, count: s.samples.length, duration: s.samples.length ? (s.samples[s.samples.length - 1].t - s.samples[0].t) / 1000 : 0, summary: s.summary || null, demo: !!s.demo, hasMotion: !!(s.motion && s.motion.length) }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// コース設定（S/F ライン等）は localStorage
const TRACK_KEY = 'lap-logger-tracks-v1';
export const DEFAULT_TRACKS = [
  { id: 'honjo', name: '本庄サーキット', center: { lat: 36.19, lon: 139.13 }, radiusKm: 8, sf: null, sectors: [], minLapSec: 25, lengthM: 1112 },
];
export function loadTracks() {
  try {
    const v = JSON.parse(localStorage.getItem(TRACK_KEY));
    if (Array.isArray(v) && v.length) return v;
  } catch (e) { /* 無視 */ }
  return structuredClone(DEFAULT_TRACKS);
}
export function saveTracks(tracks) {
  try { localStorage.setItem(TRACK_KEY, JSON.stringify(tracks)); } catch (e) { /* 無視 */ }
}
