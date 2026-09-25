// ============================================================
// Service Worker：应用外壳缓存（离线打开 + 秒开）
// 策略：assets/css 缓存优先；HTML/JS 网络优先（保证更新及时），离线时回落到缓存
// ============================================================
const CACHE = 'monopoly-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/client.js',
  '/js/board2d.js',
  '/js/sound.js',
  '/js/data/tiles.js',
  '/js/data/maps.js',
  '/js/data/cards.js',
  '/js/data/chat.js',
  '/assets/logo-dice.svg',
  '/assets/card-chance.webp',
  '/assets/card-chest.webp',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/healthz') return;                    // 健康检查不进缓存
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/css/')) {
    // 静态资源：缓存优先（服务端已设一年 immutable）
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    })));
    return;
  }
  // 其它（HTML/JS）：网络优先，失败回落缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
