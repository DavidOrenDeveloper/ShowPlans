// עדכון האפליקציה: בדיקה מול השרת, התקנת הגרסה החדשה, טעינה מחדש ואימות.
import { APP_VERSION } from './version.js';
import * as UI from './ui.js';

export { APP_VERSION };
const KEY = 'plans.updateTarget';

function askWorker(w) {
  return new Promise((res) => {
    if (!w) { res(null); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => res(null), 2500);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(String(e.data)); };
    try { w.postMessage('version', [ch.port2]); } catch { clearTimeout(t); res(null); }
  });
}

// נקרא בעליית האפליקציה: מאמת שהעדכון שהתבקש אכן נטען
export function verifyAfterBoot() {
  let target = null;
  try { target = localStorage.getItem(KEY); localStorage.removeItem(KEY); } catch { /* ignore */ }
  if (!target) return;
  if (target === APP_VERSION) UI.toast(`האפליקציה עודכנה בהצלחה לגרסה ${APP_VERSION}`, { ms: 5000 });
  else UI.toast(`העדכון לא הושלם: פועלת גרסה ${APP_VERSION} (צפוי ${target}). נסו שוב, ואם זה חוזר – סגרו את האפליקציה לגמרי ופתחו מחדש.`, { type: 'error', ms: 9000 });
}

export async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) { UI.toast('הדפדפן לא תומך בעדכון אוטומטי. טענו מחדש את הדף.', { type: 'error' }); return; }
  if (!navigator.onLine) { UI.toast('אין חיבור לאינטרנט – אי אפשר לבדוק עדכון עכשיו.', { type: 'error' }); return; }
  window.__updating = true;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) { UI.toast('האפליקציה עדיין לא הותקנה לעבודה אופליין. טענו מחדש ונסו שוב.', { type: 'error' }); return; }
  const busy = UI.toast('בודק עדכונים…', { ms: 20000 });
  try {
    await reg.update();
  } catch (e) {
    busy?.remove?.();
    UI.toast('לא ניתן להגיע לשרת כדי לבדוק עדכון. בדקו חיבור ונסו שוב.', { type: 'error' });
    return;
  }
  const nw = reg.installing || reg.waiting;
  if (!nw) {
    busy?.remove?.();
    const active = await askWorker(reg.active);
    if (active && active !== APP_VERSION) { // העמוד נטען מגרסה ישנה למרות שהמטמון כבר חדש
      try { localStorage.setItem(KEY, active); } catch { /* ignore */ }
      UI.toast(`נמצאה גרסה ${active} – טוען מחדש…`);
      setTimeout(() => location.reload(), 700);
      return;
    }
    UI.toast(`האפליקציה מעודכנת – אין גרסה חדשה (גרסה ${APP_VERSION})`, { ms: 4500 });
    return;
  }
  busy?.remove?.();
  UI.toast('נמצאה גרסה חדשה, מוריד ומתקין…', { ms: 20000 });
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 60000);
    const chk = () => {
      if (nw.state === 'activated') { clearTimeout(t); resolve('ok'); }
      else if (nw.state === 'redundant') { clearTimeout(t); resolve('fail'); }
    };
    nw.addEventListener('statechange', chk); chk();
  });
  if (done !== 'ok') {
    UI.toast(done === 'timeout' ? 'ההתקנה לוקחת יותר מדי זמן (חיבור איטי?). נסו שוב.' : 'ההתקנה של הגרסה החדשה נכשלה. נסו שוב מאוחר יותר.', { type: 'error', ms: 7000 });
    return;
  }
  const v = (await askWorker(nw)) || 'חדשה';
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
  UI.toast(`גרסה ${v} הותקנה – טוען מחדש…`);
  setTimeout(() => location.reload(), 900);
}
