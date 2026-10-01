/* Service Worker – שומר את האפליקציה לעבודה Offline.
   כדי לפרסם עדכון: להעלות את הקבצים החדשים ולהגדיל את VERSION (או להריץ tools/make-sw.py <גרסה>). */
const VERSION = '__VERSION__';
const CACHE = 'plans-app-' + VERSION;
const CORE = [
  __CORE__
];
const EXTRA = [
  __EXTRA__
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);                       // חובה: אם נכשל – ההתקנה נכשלת ומנסים שוב
    await Promise.allSettled(EXTRA.map((u) => cache.add(u))); // גופנים/wasm של PDF.js: best-effort
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('plans-app-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// קבלת קבצים משיתוף (Web Share Target) – Android בלבד
async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('pdfs').filter((f) => f && f.name);
    const cache = await caches.open('shared-inbox');
    let i = 0;
    for (const f of files) {
      await cache.put(new Request(new URL(`./__shared/${Date.now()}-${i++}/${encodeURIComponent(f.name)}`, self.registration.scope).href), new Response(f));
    }
  } catch (e) { /* ignore */ }
  return Response.redirect(new URL('./#/inbox', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { event.respondWith(handleShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (e) {
      if (req.mode === 'navigate') { const idx = await caches.match('./index.html'); if (idx) return idx; }
      return Response.error();
    }
  })());
});
