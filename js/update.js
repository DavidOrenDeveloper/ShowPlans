// עדכון האפליקציה: בדיקה מול השרת, התקנת הגרסה החדשה, טעינה מחדש ואימות.
import { t as tr } from './i18n.js';
import { APP_VERSION } from './version.js';
import * as UI from './ui.js';
import { swReady, swError } from './pwa.js';

export { APP_VERSION };
const KEY = 'plans.updateTarget';

export function askWorker(w) {
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
  if (target === APP_VERSION) UI.toast(tr('האפליקציה עודכנה בהצלחה לגרסה {0}', APP_VERSION), { ms: 5000 });
  else UI.toast(tr('העדכון לא הושלם: פועלת גרסה {0} (צפוי {1}). נסו שוב, ואם זה חוזר – סגרו את האפליקציה לגמרי ופתחו מחדש.', APP_VERSION, target), { type: 'error', ms: 9000 });
}

export async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) { UI.toast(tr('הדפדפן לא תומך בעדכון אוטומטי. טענו מחדש את הדף.'), { type: 'error' }); return; }
  if (!navigator.onLine) { UI.toast(tr('אין חיבור לאינטרנט – אי אפשר לבדוק עדכון עכשיו.'), { type: 'error' }); return; }
  window.__updating = true;
  const reg = (await navigator.serviceWorker.getRegistration()) || (await swReady);
  if (!reg) {
    const why = swError && swError.message ? ` (${swError.message})` : '';
    UI.toast(tr('לא ניתן להפעיל את מנגנון העבודה ללא אינטרנט בדפדפן הזה') + why + tr('. אם זה חלון גלישה פרטית – פתחו בחלון רגיל.'), { type: 'error', ms: 8000 });
    return;
  }
  const busy = UI.toast(tr('בודק עדכונים…'), { ms: 20000 });
  try {
    await reg.update();
  } catch (e) {
    busy?.remove?.();
    UI.toast(tr('לא ניתן להגיע לשרת כדי לבדוק עדכון. בדקו חיבור ונסו שוב.'), { type: 'error' });
    return;
  }
  const nw = reg.installing || reg.waiting;
  if (!nw) {
    busy?.remove?.();
    const active = await askWorker(reg.active);
    if (active && active !== APP_VERSION) { // העמוד נטען מגרסה ישנה למרות שהמטמון כבר חדש
      try { localStorage.setItem(KEY, active); } catch { /* ignore */ }
      UI.toast(tr('נמצאה גרסה {0} – טוען מחדש…', active));
      setTimeout(() => location.reload(), 700);
      return;
    }
    UI.toast(tr('האפליקציה מעודכנת – אין גרסה חדשה (גרסה {0})', APP_VERSION), { ms: 4500 });
    return;
  }
  busy?.remove?.();
  UI.toast(tr('נמצאה גרסה חדשה, מוריד ומתקין…'), { ms: 20000 });
  const done = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 60000);
    const chk = () => {
      if (nw.state === 'activated') { clearTimeout(t); resolve('ok'); }
      else if (nw.state === 'redundant') { clearTimeout(t); resolve('fail'); }
    };
    nw.addEventListener('statechange', chk); chk();
  });
  if (done !== 'ok') {
    UI.toast(done === 'timeout' ? tr('ההתקנה לוקחת יותר מדי זמן (חיבור איטי?). נסו שוב.') : tr('ההתקנה של הגרסה החדשה נכשלה. נסו שוב מאוחר יותר.'), { type: 'error', ms: 7000 });
    return;
  }
  const v = (await askWorker(nw)) || tr('חדשה');
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
  UI.toast(tr('גרסה {0} הותקנה – טוען מחדש…', v));
  setTimeout(() => location.reload(), 900);
}
