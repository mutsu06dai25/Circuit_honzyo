// オフライン対応
// アプリ本体: ネットワーク優先（3秒で諦めてキャッシュ）＝更新がすぐ反映され、圏外でも起動できる
// 地図タイル: 一度表示したものをキャッシュ
const VERSION = 'v2';
const APP = `app-${VERSION}`, TILES = 'tiles-v1';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/core.js', 'js/track.js', 'js/analysis.js', 'js/io.js', 'js/store.js', 'js/demo.js',
  'js/ui/util.js', 'js/ui/charts.js', 'js/ui/trackmap.js', 'js/ui/logger.js', 'js/ui/sessions.js', 'js/ui/analysis.js', 'js/ui/settings.js',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'fonts/barlow-condensed-latin-500-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2',
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
  if (/arcgisonline\.com|tile\.openstreetmap\.org/.test(url.host)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(APP);
    try {
      const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      if (res && res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
