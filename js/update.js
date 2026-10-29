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
  window.__updating = true; // בזמן עדכון ידני לא מציגים את ההודעה האוטומטית; מתאפס תמיד בסיום (בעבר נשאר דלוק ומנע את ההודעה)
  try { await checkForUpdate0(); } finally { window.__updating = false; }
}
async function checkForUpdate0() {
  if (!('serviceWorker' in navigator)) { UI.toast(tr('הדפדפן לא תומך בעדכון אוטומטי. טענו מחדש את הדף.'), { type: 'error' }); return; }
  if (!navigator.onLine) { UI.toast(tr('אין חיבור לאינטרנט – אי אפשר לבדוק עדכון עכשיו.'), { type: 'error' }); return; }
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

// ---------- הודעת "יש גרסה חדשה" לכל המשתמשים ----------
let bannerEl = null;
const dismissed = new Set(); // גרסאות שהמשתמש סגר ב-✕ (לא מציגים שוב באותה טעינה של האפליקציה)
export function showUpdateBanner(version) {
  if (version && dismissed.has(version)) return;
  if (bannerEl) { const b = bannerEl.querySelector('.ub-v'); if (b && version) b.textContent = tr('גרסה {0}', version); return; }
  const apply = () => {
    try { if (version) localStorage.setItem(KEY, version); } catch { /* ignore */ }
    location.reload();
  };
  bannerEl = document.createElement('div');
  bannerEl.className = 'update-banner';
  bannerEl.setAttribute('role', 'status');
  bannerEl.innerHTML = '<div class="ub-t"><b>' + tr('יש גרסה חדשה של האפליקציה') + '</b><small class="ub-v"></small></div>';
  bannerEl.querySelector('.ub-v').textContent = version ? tr('גרסה {0}', version) : '';
  const ok = document.createElement('button'); ok.className = 'ub-go'; ok.textContent = tr('עדכן עכשיו'); ok.onclick = apply;
  const later = document.createElement('button'); later.className = 'ub-x'; later.textContent = '✕'; later.setAttribute('aria-label', tr('אחר כך'));
  later.onclick = () => { if (version) dismissed.add(version); bannerEl.classList.remove('show'); const el = bannerEl; setTimeout(() => el.remove(), 250); bannerEl = null; };
  bannerEl.append(ok, later);
  document.body.append(bannerEl);
  requestAnimationFrame(() => bannerEl && bannerEl.classList.add('show'));
}

// מופעל בעליית האפליקציה: מזהה גרסה חדשה (גם כשהאפליקציה פתוחה זמן רב) ומציג הודעה עם כפתור עדכון
export function watchForUpdates(reg, hadController) {
  const announce = async () => {
    if (window.__updating) return; // עדכון ידני מתבצע כרגע
    const c = navigator.serviceWorker.controller;
    const v = (await askWorker(c)) || null;
    if (v && v === APP_VERSION) return; // העמוד כבר רץ על הגרסה העדכנית
    showUpdateBanner(v);
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) announce(); });
  // השוואה ישירה: אם ה-Service Worker הפעיל כבר בגרסה חדשה מהקוד שרץ בעמוד (למשל התעדכן בזמן שהאפליקציה הייתה ברקע וההתראה פוספסה) – מציגים הודעה
  const compare = async () => {
    if (window.__updating || !navigator.serviceWorker.controller) return;
    const v = await askWorker(navigator.serviceWorker.controller);
    if (v && v !== APP_VERSION) showUpdateBanner(v);
  };
  const check = () => {
    if (document.visibilityState !== 'visible') return;
    if (navigator.onLine) reg.update().catch(() => {}).finally(compare); else compare();
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  setInterval(check, 15 * 60 * 1000);
  setTimeout(compare, 3000);
  // בדיקה מיד בפתיחת האפליקציה: דפדפן בודק עדכון בניווט רק פעם ב-24 שעות, ולכן בלי זה גרסה חדשה לא הייתה מזוהה עד שעוברים לרקע וחוזרים
  check();
  if (reg.waiting && hadController) announce();
}
