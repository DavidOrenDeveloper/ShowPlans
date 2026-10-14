// התקנה כאפליקציה ו-Service Worker: רישום מוקדם, זיהוי מצב התקנה, התקנה ישירה (beforeinstallprompt).
// הרישום מתחיל כבר בטעינת המודול (לא מחכה לסיום עליית המסכים), כדי שהאפליקציה תהיה "מותקנת לאופליין" ותעמוד בתנאי ההתקנה של Chrome.
export const hadController = !!(typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller);
export let swError = null;

export const swReady = (async () => {
  if (!('serviceWorker' in navigator)) { swError = new Error('הדפדפן לא תומך ב-Service Worker'); return null; }
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
