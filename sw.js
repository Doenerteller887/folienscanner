// Service Worker: macht die App offline-fähig (wichtig bei schlechtem WLAN im Hörsaal).
// App-Dateien: zuerst Netz (immer aktuell), nach 3 s oder offline aus dem Cache.
// Bibliotheken (lib/, ~10 MB): nur einmal laden, danach immer aus dem Cache.

const SHELL = 'shell-v8';
const LIB = 'lib-v1';
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/camera.js', 'js/change.js', 'js/cv.js', 'js/detector.js',
  'js/outputs.js', 'js/pdf.js', 'js/pipeline.js', 'js/rectify.js', 'js/storage.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const LIB_FILES = ['lib/opencv.js', 'lib/jspdf.umd.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)),
    caches.open(LIB).then((c) => c.addAll(LIB_FILES)),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== LIB).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function networkFirst(req) {
  return new Promise((resolve) => {
    let settled = false;
    // Startseite nur als Ersatz für Seitenaufrufe – nie für Skripte oder Stylesheets.
    const fromCache = () => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
      .then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
    const timer = setTimeout(() => {
      fromCache().then((r) => { if (r && !settled) { settled = true; resolve(r); } });
    }, 3000);
    fetch(req, { cache: 'no-cache' }).then((res) => {
      clearTimeout(timer);
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
      }
      if (!settled) { settled = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then((r) => { if (!settled) { settled = true; resolve(r || Response.error()); } });
    });
  });
}

function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(LIB).then((c) => c.put(req, copy));
    }
    return res;
  }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(url.pathname.includes('/lib/') ? cacheFirst(req) : networkFirst(req));
});
