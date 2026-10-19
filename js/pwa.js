import { t as tr } from './i18n.js';
// התקנה כאפליקציה ו-Service Worker: רישום מוקדם, זיהוי מצב התקנה, התקנה ישירה (beforeinstallprompt).
// הרישום מתחיל כבר בטעינת המודול (לא מחכה לסיום עליית המסכים), כדי שהאפליקציה תהיה "מותקנת לאופליין" ותעמוד בתנאי ההתקנה של Chrome.
export const hadController = !!(typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller);
export let swError = null;

export const swReady = (async () => {
  if (!('serviceWorker' in navigator)) { swError = new Error(tr('הדפדפן לא תומך ב-Service Worker')); return null; }
  try { return await navigator.serviceWorker.register('./sw.js'); } catch (e) { swError = e; console.warn('SW נכשל', e); return null; }
})();

let evt = null;
const subs = new Set();
const notify = () => subs.forEach((f) => { try { f(); } catch { /* ignore */ } });
export const onInstallState = (f) => { subs.add(f); return () => subs.delete(f); };
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); evt = e; notify(); });
window.addEventListener('appinstalled', () => { evt = null; notify(); });

export const canPromptInstall = () => !!evt;
export function isInstalled() {
  try { return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true; } catch { return false; }
}

// 'accepted' | 'dismissed' | 'unavailable'
export async function installNow(waitMs = 2500) {
  if (!evt) {
    await new Promise((res) => { const t = setTimeout(() => { off(); res(); }, waitMs); const off = onInstallState(() => { clearTimeout(t); off(); res(); }); });
  }
  if (!evt) return 'unavailable';
  const e = evt; evt = null; notify();
  try { await e.prompt(); const c = await e.userChoice; return c && c.outcome === 'accepted' ? 'accepted' : 'dismissed'; } catch { return 'unavailable'; }
}

// האם האפליקציה כבר מותקנת בטלפון (גם כשפותחים מלשונית דפדפן). לא נתמך בכל דפדפן; אז מחזיר false.
export async function installedElsewhere() {
  try { if (navigator.getInstalledRelatedApps) return (await navigator.getInstalledRelatedApps()).length > 0; } catch { /* ignore */ }
  return false;
}

// איפוס מטמוני האפליקציה (לא נוגע בתוכניות, בסימונים או בחשבון) וטעינה מחדש מהשרת
export async function forceRefresh() {
  try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); } catch { /* ignore */ }
  try { const keys = await caches.keys(); await Promise.all(keys.filter((k) => k.startsWith('plans-app-')).map((k) => caches.delete(k))); } catch { /* ignore */ }
  location.reload();
}

// בודק מול השרת: איזו גרסה מפורסמת, ואילו קבצים שנדרשים לעבודה ללא אינטרנט חסרים שם
export async function diagnoseServer() {
  const res = await fetch('./sw.js', { cache: 'no-store' });
  if (!res.ok) return { error: tr('sw.js לא נמצא בשרת ({0})', res.status) };
  const txt = await res.text();
  const version = (txt.match(/const VERSION = '([^']+)'/) || [])[1] || '?';
  const core = (txt.match(/const CORE = \[([\s\S]*?)\];/) || [, ''])[1].match(/"([^"]+)"/g) || [];
  const files = core.map((x) => x.slice(1, -1)).filter((f) => f !== './');
  const missing = [];
  await Promise.all(files.map(async (f) => { try { const r = await fetch(f, { cache: 'no-store' }); if (!r.ok) missing.push(f); } catch { missing.push(f); } }));
  return { version, total: files.length, missing };
}
