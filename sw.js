// ============================================================
// Service Worker：应用外壳缓存（离线打开 + 秒开）
// 策略：assets/css 先缓存后后台更新（stale-while-revalidate）；HTML/JS 网络优先；均离线回落缓存
// 注意：改动静态资源后务必递增 CACHE 版本号，否则老客户端可能继续命中旧缓存
// ============================================================
const CACHE = 'monopoly-shell-v2';
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

// 页面发现新版本时让它立刻接管
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
    // 静态资源：先给缓存保证秒开，同时后台拉新版本写回缓存（stale-while-revalidate）
    // 这样部署后第二次刷新就能拿到新样式，不会像纯缓存优先那样长期卡在旧版本
    e.respondWith(caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || refresh;
    }));
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
