// オフライン対応: アプリ本体はキャッシュ優先＋裏で更新、地図タイルは見たものをキャッシュ
const VERSION = 'v1';
const APP = `app-${VERSION}`, TILES = 'tiles-v1';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/core.js', 'js/chart.js', 'js/store.js', 'js/demo.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js', 'icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isTile = /arcgisonline\.com|tile\.openstreetmap\.org/.test(url.host);
  if (isTile) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(caches.open(APP).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
