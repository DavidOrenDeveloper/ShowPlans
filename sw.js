/* Service Worker – שומר את האפליקציה לעבודה Offline.
   כדי לפרסם עדכון: להעלות את הקבצים החדשים ולהגדיל את VERSION (או להריץ tools/make-sw.py <גרסה>). */
const VERSION = '1.13.2';
const CACHE = 'plans-app-' + VERSION;
const CORE = [
  "./",
  "css/app.css",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon.svg",
  "icons/maskable-512.png",
  "index.html",
  "js/actions.js",
  "js/app.js",
  "js/backstack.js",
  "js/backup.js",
  "js/browser.js",
  "js/cloud-sync.js",
  "js/cloud-ui.js",
  "js/cloud.js",
  "js/config.js",
  "js/db.js",
  "js/dedupe.js",
  "js/diag.js",
  "js/folder-import.js",
  "js/glossary.js",
  "js/i18n.js",
  "js/item-merge.js",
  "js/item-share-ui.js",
  "js/item-sync.js",
  "js/lang-en.js",
  "js/layer.js",
  "js/markup.js",
  "js/names.js",
  "js/ocr.js",
  "js/order.js",
  "js/overlay.js",
  "js/overrides.js",
  "js/pdfio.js",
  "js/personal-ui.js",
  "js/plan-preview.js",
  "js/prefs.js",
  "js/privacy-config.js",
  "js/privacy.js",
  "js/pwa.js",
  "js/settings.js",
  "js/shape-recog.js",
  "js/split.js",
  "js/store.js",
  "js/ui.js",
  "js/update.js",
  "js/util.js",
  "js/version.js",
  "js/viewer-print.js",
  "js/viewer-style.js",
  "js/viewer.js",
  "js/xlsx-export.js",
  "js/zip.js",
  "lib/LICENSE-pdfjs.txt",
  "lib/pdf.min.mjs",
  "lib/pdf.worker.min.mjs",
  "lib/pdfjs/LICENSE-pdfjs.txt",
  "lib/pdfjs/pdf.min.mjs",
  "lib/pdfjs/pdf.worker.min.mjs",
  "lib/supabase.js",
  "manifest-en.webmanifest",
  "manifest.webmanifest"
];
const EXTRA = [
  "lib/pdfjs/iccs/CGATS001Compat-v2-micro.icc",
  "lib/pdfjs/standard_fonts/FoxitDingbats.pfb",
  "lib/pdfjs/standard_fonts/FoxitFixed.pfb",
  "lib/pdfjs/standard_fonts/FoxitFixedBold.pfb",
  "lib/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
  "lib/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
  "lib/pdfjs/standard_fonts/FoxitSerif.pfb",
  "lib/pdfjs/standard_fonts/FoxitSerifBold.pfb",
  "lib/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
  "lib/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
  "lib/pdfjs/standard_fonts/FoxitSymbol.pfb",
  "lib/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
  "lib/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
  "lib/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
  "lib/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
  "lib/pdfjs/wasm/jbig2.wasm",
  "lib/pdfjs/wasm/jbig2_nowasm_fallback.js",
  "lib/pdfjs/wasm/openjpeg.wasm",
  "lib/pdfjs/wasm/openjpeg_nowasm_fallback.js",
  "lib/pdfjs/wasm/qcms_bg.wasm",
  "lib/pdfjs/wasm/quickjs-eval.js",
  "lib/pdfjs/wasm/quickjs-eval.wasm"
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // כל קובץ נטען עם פרמטר ?_v=<גרסה> ועם cache:'reload': זה עוקף גם את מטמון הדפדפן וגם את המטמון של GitHub Pages / CDN,
    // שמחזיקים לפעמים גרסה ישנה של הקובץ עד כמה דקות (וזה גרם ל"פועלת גרסה X, צפוי Y"). נשמר תחת הכתובת הרגילה.
    const grab = async (u) => {
      const res = await fetch(u + (u.includes('?') ? '&' : '?') + '_v=' + VERSION, { cache: 'reload' });
      if (!res.ok) throw new Error('fetch ' + u + ' ' + res.status);
      if (u === 'js/version.js') { const t = await res.clone().text(); if (!t.includes("'" + VERSION + "'")) throw new Error('version.js לא תואם (' + VERSION + ')'); }
      await cache.put(new Request(u), res);
    };
    await Promise.all(CORE.map(grab));              // חובה: אם נכשל – ההתקנה נכשלת ומנסים שוב
    await Promise.allSettled(EXTRA.map(grab));      // גופנים/wasm של PDF.js: best-effort
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


// ---------- הורדה ברקע (Background Fetch, Chrome באנדרואיד) ----------
// הדף מעביר לכאן הורדות כשהאפליקציה יוצאת מהחזית. הדפדפן מוריד גם כשהאפליקציה סגורה והטלפון נעול,
// וכאן שומרים כל קובץ במסד המקומי (אותו מסד שהאפליקציה משתמשת בו) כדי שיהיה זמין כשפותחים את התוכנית.
// מזהה הרישום: dl|<שם המסד>|<זמן>. כל בקשה: ...?v=<מזהה גרסה>
const idbOpen = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function saveFile(dbName, versionId, blob) {
  const d = await idbOpen(dbName);
  try {
    await new Promise((res, rej) => {
      const t = d.transaction(['files', 'meta'], 'readwrite');
      const f = t.objectStore('files'), m = t.objectStore('meta');
      const g = f.get(versionId);
      g.onsuccess = () => {
        if (!g.result) f.put({ id: versionId, blob });
        const k = m.get('bgIndex');
        k.onsuccess = () => { const list = (k.result && k.result.v) || []; if (!list.includes(versionId)) list.push(versionId); m.put({ key: 'bgIndex', v: list }); };
      };
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  } finally { d.close(); }
}
async function tellClients(msg) { for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg); }
self.addEventListener('backgroundfetchsuccess', (event) => {
  const bf = event.registration;
  event.waitUntil((async () => {
    const dbName = bf.id.split('|')[1];
    const ok = [], failed = [];
    for (const rec of await bf.matchAll()) {
      const vid = new URL(rec.request.url).searchParams.get('v');
      try {
        const res = await rec.responseReady;
        if (!res || !res.ok) { failed.push(vid); continue; }
        const blob = await res.blob();
        if (!blob.size) { failed.push(vid); continue; }
        await saveFile(dbName, vid, new Blob([blob], { type: 'application/pdf' }));
        ok.push(vid);
      } catch (e) { failed.push(vid); }
    }
    try { await event.updateUI({ title: failed.length ? 'ההורדה הסתיימה (' + failed.length + ' נכשלו)' : 'ההורדה הסתיימה ✓' }); } catch (e) { /* ignore */ }
    await tellClients({ type: 'bg-done', ok, failed });
  })());
});
self.addEventListener('backgroundfetchfail', (event) => {
  const bf = event.registration;
  event.waitUntil((async () => {
    const dbName = bf.id.split('|')[1];
    const ok = [], failed = [];
    for (const rec of await bf.matchAll()) {
      const vid = new URL(rec.request.url).searchParams.get('v');
      try { const res = await rec.responseReady; if (res && res.ok) { const blob = await res.blob(); if (blob.size) { await saveFile(dbName, vid, new Blob([blob], { type: 'application/pdf' })); ok.push(vid); continue; } } } catch (e) { /* ignore */ }
      failed.push(vid);
    }
    await tellClients({ type: 'bg-done', ok, failed });
  })());
});
self.addEventListener('backgroundfetchabort', (event) => {
  event.waitUntil((async () => { const ids = []; try { for (const r of await event.registration.matchAll()) ids.push(new URL(r.request.url).searchParams.get('v')); } catch (e) { /* ignore */ } await tellClients({ type: 'bg-done', ok: [], failed: ids }); })());
});
self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil(self.clients.openWindow(new URL('./', self.registration.scope).href));
});

// העמוד שואל איזו גרסה ה-Service Worker הזה מייצג (לכפתור "עדכן אפליקציה")
self.addEventListener('message', (event) => {
  if (event.data === 'version' && event.ports && event.ports[0]) event.ports[0].postMessage(VERSION);
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { event.respondWith(handleShare(req)); return; }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/lib/ocr/')) { // רכיבי OCR: נשמרים בעת השימוש הראשון במטמון נפרד שלא נמחק בעדכוני גרסה
    event.respondWith((async () => {
      const c = await caches.open('ocr-assets');
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') c.put(req, res.clone());
      return res;
    })());
    return;
  }
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
