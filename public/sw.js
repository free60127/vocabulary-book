/**
 * Service Worker：让这个应用**离线也能打开**。
 *
 * 为什么值得做：复习本身就是纯本机的事（词条、排期、连续天数都在 localStorage），
 * 地铁里、飞机上、酒店弱网下打开网页，本来应该能正常复习 ——
 * 但在没有 SW 之前，浏览器连 index.html 都拿不到，用户看到的是一张"无法连接"的错误页。
 *
 * 策略（刻意保持简单，不做离线写队列）：
 *   · **页面导航**：network-first —— 有网就永远拿最新的，断网才回落到缓存的 index.html；
 *   · **同源静态资源**（/assets/xxx-hash.js、图标）：cache-first ——
 *     文件名带内容 hash，内容变了文件名就变了，不存在"缓存过期"的问题；
 *   · 凡是 /api/ 开头的请求一律不碰：查词/出题/同步必须走网络，离线时由前端给出可读的错误提示
 *     （缓存一份假的 AI 讲解比报错还糟）。
 *
 * 升级：CACHE 名字里带版本号，activate 时把旧版本整个删掉。
 */
const VERSION = 'v2';
const CACHE = 'vocabulary-book-' + VERSION;

/** 这几个是"壳"，没有它们页面根本起不来 */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 单个资源失败不该让整个安装失败（图标缺失之类）
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
    // 第一次安装直接接管，别让用户为了拿到离线能力再刷新一次
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('vocabulary-book-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* 首屏有个天然的缺口：**第一次访问时页面还没被 SW 接管**，
   JS/CSS 是浏览器直接取的，没经过我们 —— 于是缓存里只有 index.html，
   一断网刷新就白屏（实测踩到：assets 缓存未命中 + 网络不可用 → 脚本加载失败）。
   补法：页面加载完把这一屏真正用到的同源资源列表发过来，SW 补进缓存。 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of data.urls.slice(0, 80)) {
      try {
        const res = await fetch(u, { cache: 'reload' });
        if (res && res.ok) await cache.put(u, res);
      } catch { /* 单个资源失败不影响其他 */ }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 跨域（模型接口）不碰
  if (url.pathname.startsWith('/api/')) return;         // 接口必须走网络

  // 页面导航：先网络，断网回落缓存
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // 静态资源：先缓存，没有再取网络并顺手存下来
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 只缓存成功的同源响应（206/302 之类不碰）
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      const fallback = await cache.match(req);
      if (fallback) return fallback;
      throw e;
    }
  })());
});
