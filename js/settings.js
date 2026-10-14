// מסך הגדרות: גרסה, עדכון, התקנה כאפליקציה, מצב עבודה ללא אינטרנט, אחסון וחשבון.
import { APP_VERSION, checkForUpdate, askWorker } from './update.js';
import { swReady, swError, isInstalled, canPromptInstall, onInstallState, forceRefresh, diagnoseServer } from './pwa.js';
import { cloud, isCloud, isAdmin } from './cloud.js';
import * as db from './db.js';
import * as UI from './ui.js';
import { h, icon, fmtSize } from './util.js';

const row = (label, ...val) => h('div', { class: 'set-row' }, h('div', { class: 'set-l' }, label), h('div', { class: 'set-v' }, ...val));

export async function settingsDialog({ installApp }) {
  const body = h('div', { class: 'stack set-body' });
  const m = UI.openModal({ title: 'הגדרות', body, buttons: [{ text: 'סגור', value: true }] });
  const out = h('div', { class: 'hint-inline' });
  const off = onInstallState(() => render());
  m.promise.then(() => off());

  async function render() {
    const reg = await Promise.race([swReady, new Promise((r) => setTimeout(() => r(undefined), 1500))]);
    const wv = reg && reg.active ? await askWorker(reg.active) : null;
    const est = await db.storageEstimate();
    const installed = isInstalled();

    const offline = !reg && reg !== undefined
      ? h('span', { class: 'set-bad' }, 'לא פעיל' + (swError ? ` (${swError.message})` : ''))
      : wv ? h('span', { class: 'set-good' }, `מוכנה לעבודה ללא אינטרנט (גרסה ${wv})`)
        : h('span', { class: 'set-warn' }, 'מתכוננת… טענו מחדש את הדף ובדקו שוב');

    const installRow = installed
      ? h('span', { class: 'set-good' }, 'פועלת כאפליקציה מותקנת')
      : h('div', { class: 'stack' },
        h('button', { class: 'btn primary', onclick: () => { m.close(true); installApp(); } }, icon('download', 18), 'התקן כאפליקציה'),
        h('small', { class: 'hint-inline' }, canPromptInstall() ? 'הדפדפן מוכן להתקנה ישירה.' : 'אם החלון לא נפתח, יוצגו הוראות התקנה (תפריט ⋮ ← התקן אפליקציה).'));

    const acct = isCloud()
      ? h('span', {}, (cloud.user && cloud.user.email) || '—', isAdmin() ? ' · מנהל' : ' · עובד')
      : h('span', {}, 'מצב מקומי (בלי חשבון ענן)');

    body.replaceChildren(
      row('גרסת האפליקציה', h('b', { dir: 'ltr' }, APP_VERSION)),
      h('button', { class: 'btn', onclick: () => { m.close(true); checkForUpdate(); } }, icon('refresh', 18), 'בדוק ועדכן לגרסה האחרונה'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; out.textContent = 'בודק מול השרת…';
          try {
            const d = await diagnoseServer();
            out.className = 'hint-inline';
            out.textContent = d.error ? d.error : `בשרת מפורסמת גרסה ${d.version}; פועלת אצלך ${APP_VERSION}. ` + (d.missing.length ? `קבצים חסרים בשרת (${d.missing.length}): ${d.missing.join(', ')}` : `כל ${d.total} הקבצים קיימים בשרת.`);
          } catch (err) { out.textContent = 'הבדיקה נכשלה: ' + (err && err.message); }
          b.disabled = false;
        } }, 'אבחון עדכון (בדיקת קבצים בשרת)'),
        out,
        h('button', { class: 'btn', onclick: async () => { if (await UI.confirmBox('ינקה את הקבצים השמורים של האפליקציה ויטען אותם מחדש מהשרת. התוכניות, הסימונים והחשבון לא נמחקים. צריך חיבור לאינטרנט.', { title: 'עדכון כפוי', okText: 'נקה וטען מחדש' })) forceRefresh(); } }, 'עדכון כפוי (ניקוי קבצי האפליקציה)')),
      row('עבודה ללא אינטרנט', offline),
      row('התקנה', installRow),
      row('חשבון', acct),
      row('אחסון במכשיר', h('span', {}, `${fmtSize(est.usage)} מתוך ${fmtSize(est.quota)} · ` + (est.persisted ? 'קבוע' : 'לא מסומן כקבוע')),
        est.persisted ? null : h('button', { class: 'btn sm', onclick: async () => { const ok = await db.requestPersist(); UI.toast(ok ? 'האחסון סומן כקבוע' : 'הדפדפן לא אישר אחסון קבוע', { type: ok ? '' : 'error' }); render(); } }, 'בקש אחסון קבוע')),
      h('p', { class: 'warn' }, 'האחסון של האפליקציה המותקנת נפרד מהאחסון של הדפדפן. ' + (isCloud()
        ? 'עם חשבון ענן זה בסדר: אחרי הכניסה התוכניות מסונכרנות מחדש ונפתחות (מורידות מהענן בפעם הראשונה בכל מכשיר/אפליקציה).'
        : 'במצב מקומי: התקינו קודם ורק אחר כך העלו תוכניות, אחרת הן לא יופיעו באפליקציה המותקנת.')));
  }
  render();
}
