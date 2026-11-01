// Service worker de la PWA: guarda la app entera al instalar y la sirve desde la cache (arranque sin red).
// La version y la lista de ficheros las pone el build (plugin fision-pwa de vite.config.ts).
const VERSION = '__VERSION__';
const FILES = __FILES__; // relativas al scope; '' = la pagina
const PREFIX = 'fision-app-';
const CACHE = PREFIX + VERSION;
const BASE = new URL('./', self.location.href).pathname; // /app/

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => BASE + f))).then(() => self.skipWaiting()));
});

// Version nueva: fuera las caches viejas y toma las pestanas abiertas
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  // API del server y todo lo de fuera de /app: directo a la red
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const key = req.mode === 'navigate' ? BASE : url.pathname;
  e.respondWith(caches.open(CACHE).then((c) => c.match(key, { ignoreSearch: true })).then((r) => r || fetch(req)));
});
