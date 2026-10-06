// נקודת הכניסה: אתחול, ניתוב לפי hash, רישום Service Worker
import * as S from './store.js';
import * as UI from './ui.js';
import * as A from './actions.js';
import * as db from './db.js';
import { setPasswordHandler } from './pdfio.js';
import { mountBrowser, show } from './browser.js';
import { openViewer, closeViewer } from './viewer.js';
import { h } from './util.js';
import { initCloud, cloud, dbNameFor, isCloud } from './cloud.js';
import { loginScreen, maybeImportLocal } from './cloud-ui.js';
import { startSync } from './cloud-sync.js';

window.__navCount = 0;
let viewerRoot;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

async function route() {
  const { parts, q } = parseHash();
  const head = parts[0];
  if (head === 'p' && parts[1]) {
    const num = (k) => (q.get(k) != null ? parseFloat(q.get(k)) : undefined);
    await openViewer(viewerRoot, parts[1], {
      page: q.get('page') ? parseInt(q.get('page'), 10) : undefined,
      v: q.get('v') || undefined, cmp: q.get('cmp') || undefined, query: q.get('q') || undefined,
      pick: q.get('pick') === '1', x: num('x'), y: num('y'), z: num('z'),
    });
    return;
  }
  await closeViewer();
  if (head === 'search') show({ mode: 'search', q: q.get('q') || '' });
  else if (head === 'storage') show({ mode: 'storage' });
  else if (head === 'inbox') { show({ mode: 'folder', id: null }); handleInbox(); }
  else show({ mode: 'folder', id: head === 'f' ? parts[1] || null : null });
}

// קבצים שהתקבלו דרך "שתף אל האפליקציה" (Android בלבד, לא נבדק במכשיר אמיתי)
async function handleInbox() {
  try {
    const cache = await caches.open('shared-inbox');
    const keys = await cache.keys();
    if (!keys.length) { history.replaceState(null, '', '#/f/'); return; }
    const files = [];
    for (const k of keys) {
      const res = await cache.match(k);
      const blob = await res.blob();
      const name = decodeURIComponent(k.url.split('/').pop());
      files.push(new File([blob], name, { type: 'application/pdf' }));
    }
    history.replaceState(null, '', '#/f/');
    const r = await UI.folderPicker({ title: `נתקבלו ${files.length} קבצים – לאיזו תיקייה לייבא?`, okText: 'ייבא לכאן' });
    if (r) await A.importFiles(files, r.id);
    for (const k of keys) await cache.delete(k);
  } catch (e) { console.warn('inbox', e); }
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const had = !!navigator.serviceWorker.controller;
    await navigator.serviceWorker.register('./sw.js');
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (had) UI.toast('האפליקציה עודכנה. רעננו את הדף כדי לעבוד עם הגרסה החדשה.', { ms: 8000 });
    });
  } catch (e) { console.warn('SW נכשל', e); }
}

async function main() {
  setPasswordHandler(UI.askPassword);
  try {
    await initCloud();
    if (cloud.needLogin) await loginScreen();
    db.useDb(dbNameFor());
  } catch (e) { console.error('cloud init', e); }
  try {
    await S.init();
  } catch (e) {
    console.error(e);
    document.getElementById('boot').replaceChildren(h('div', { class: 'boot-err' }, 'לא ניתן לפתוח את האחסון המקומי (IndexedDB). ייתכן שהדפדפן במצב גלישה פרטית או שהאחסון חסום.', h('br'), String(e.message || e)));
    return;
  }
  const app = document.getElementById('app');
  viewerRoot = h('div', { id: 'viewer-root' });
  mountBrowser(app);
  document.body.append(viewerRoot);
  window.addEventListener('hashchange', () => { window.__navCount++; route(); });
  document.getElementById('boot')?.remove();
  await route();
  registerSW();
  db.requestPersist();
  if (isCloud()) { try { await startSync(); await maybeImportLocal(); } catch (e) { console.warn('sync start', e); } }
}

window.addEventListener('unhandledrejection', (e) => {
  const m = e.reason?.message || '';
  if (/הרשאה/.test(m)) { UI.toast(m, { type: 'error', ms: 4500 }); e.preventDefault(); }
});

main();
