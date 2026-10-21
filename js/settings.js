// מסך הגדרות: גרסה, עדכון, התקנה כאפליקציה, מצב עבודה ללא אינטרנט, אחסון וחשבון.
import { t as tr, toggleLang, langButtonLabel } from './i18n.js';
import { getNameMode, setNameMode } from './names.js';
import { APP_VERSION, checkForUpdate, askWorker } from './update.js';
import { swReady, swError, isInstalled, canPromptInstall, onInstallState, forceRefresh, diagnoseServer } from './pwa.js';
import { cloud, isCloud, isAdmin } from './cloud.js';
import * as db from './db.js';
import { showPrivacy } from './privacy.js';
import * as UI from './ui.js';
import * as S from './store.js';
import { enterViewAs, exitViewAs } from './personal-ui.js';
import { client } from './cloud.js';
import { h, icon, fmtSize } from './util.js';

const row = (label, ...val) => h('div', { class: 'set-row' }, h('div', { class: 'set-l' }, label), h('div', { class: 'set-v' }, ...val));

export async function settingsDialog({ installApp }) {
  const body = h('div', { class: 'stack set-body' });
  const m = UI.openModal({ title: tr('הגדרות'), body, buttons: [{ text: tr('סגור'), value: true }] });
  const out = h('div', { class: 'hint-inline' });
  const off = onInstallState(() => render());
  m.promise.then(() => off());

  // מנהל: כניסה למערכת של עובד (צפייה כפי שהוא רואה, עם כל הרשאות המנהל), מעבר בין עובדים וחזרה לחשבון שלי
  function workersBox() {
    const box = h('div', { class: 'set-sec' }, h('b', {}, tr('כניסה כעובד')), h('small', { class: 'hint-inline' }, tr('טוען…')));
    (async () => {
      const va = S.getViewAs();
      const { data, error } = await client().from('profiles').select('*').order('display_name');
      if (error) { box.replaceChildren(h('b', {}, tr('כניסה כעובד')), h('small', { class: 'set-bad' }, tr('שגיאה: ') + error.message)); return; }
      const ws = data.filter((u) => u.role !== 'admin');
      box.replaceChildren(
        h('b', {}, tr('כניסה כעובד')),
        va ? h('div', { class: 'row' }, h('span', { class: 'set-warn' }, tr('כרגע צופה כעובד: {0}', va.name)), h('button', { class: 'btn sm primary', onclick: () => { exitViewAs(); m.close(true); } }, tr('חזרה לחשבון שלי'))) : h('small', { class: 'hint-inline' }, tr('כרגע בחשבון שלך. בחר עובד כדי לראות את התוכניות, השמות והסימונים שלו.')),
        ...(ws.length ? ws.map((u) => h('div', { class: 'row' }, h('span', {}, u.display_name || u.email),
          h('button', { class: 'btn sm', disabled: !!(va && va.userId === u.id), onclick: async () => { try { await enterViewAs(u); m.close(true); } catch (err) { UI.toast(tr('הטעינה נכשלה: ') + err.message, { type: 'error' }); } } }, va && va.userId === u.id ? tr('צופה כעת') : tr('כניסה כעובד')))) : [h('small', { class: 'hint-inline' }, tr('אין עובדים.'))]));
    })();
    return box;
  }

  async function render() {
    const reg = await Promise.race([swReady, new Promise((r) => setTimeout(() => r(undefined), 1500))]);
    const wv = reg && reg.active ? await askWorker(reg.active) : null;
    const est = await db.storageEstimate();
    const installed = isInstalled();

    const offline = !reg && reg !== undefined
      ? h('span', { class: 'set-bad' }, tr('לא פעיל') + (swError ? ` (${swError.message})` : ''))
      : wv ? h('span', { class: 'set-good' }, tr('מוכנה לעבודה ללא אינטרנט (גרסה {0})', wv))
        : h('span', { class: 'set-warn' }, tr('מתכוננת… טענו מחדש את הדף ובדקו שוב'));

    const installRow = installed
      ? h('span', { class: 'set-good' }, tr('פועלת כאפליקציה מותקנת'))
      : h('div', { class: 'stack' },
        h('button', { class: 'btn primary', onclick: () => { m.close(true); installApp(); } }, icon('download', 18), tr('התקן כאפליקציה')),
        h('small', { class: 'hint-inline' }, canPromptInstall() ? tr('הדפדפן מוכן להתקנה ישירה.') : tr('אם החלון לא נפתח, יוצגו הוראות התקנה (תפריט ⋮ ← התקן אפליקציה).')));

    const acct = isCloud()
      ? h('span', {}, (cloud.user && cloud.user.email) || '—', isAdmin() ? tr(' · מנהל') : tr(' · עובד'))
      : h('span', {}, tr('מצב מקומי (בלי חשבון ענן)'));

    body.replaceChildren(
      row(tr('שפה / Language'), h('button', { class: 'btn sm', onclick: () => { try { sessionStorage.setItem('plans.reopen', 'settings'); } catch { /* ignore */ } toggleLang(); } }, icon('globe', 16), langButtonLabel())),
      row(tr('תרגום שמות קבצים ותיקיות'),
        h('select', { onchange: (e) => setNameMode(e.target.value) },
          ...[['full', tr('מילון בנייה + תרגום ברשת')], ['glossary', tr('מילון בנייה בלבד (בלי אינטרנט)')], ['off', tr('כבוי – שמות כפי שנכתבו')]].map(([v, l]) => h('option', { value: v, selected: getNameMode() === v }, l))),
        h('small', { class: 'hint-inline' }, tr('השמות מוצגים בשפת הממשק שבחרתם. השם המקורי נשמר כמו שנכתב, ובעריכת שם רואים אותו. מילים שאינן במילון נשלחות לשירות תרגום חיצוני (שמות בלבד, לא קבצים).'))),
      row(tr('גרסת האפליקציה'), h('b', { dir: 'ltr' }, APP_VERSION)),
      h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await checkForUpdate(); } finally { b.disabled = false; } } }, icon('refresh', 18), tr('בדוק ועדכן לגרסה האחרונה')),
      isAdmin() ? workersBox() : null,
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; out.textContent = tr('בודק מול השרת…');
          try {
            const d = await diagnoseServer();
            out.className = 'hint-inline';
            out.textContent = d.error ? d.error : tr('בשרת מפורסמת גרסה {0}; פועלת אצלך {1}. ', d.version, APP_VERSION) + (d.missing.length ? tr('קבצים חסרים בשרת ({0}): {1}', d.missing.length, d.missing.join(', ')) : tr('כל {0} הקבצים קיימים בשרת.', d.total));
          } catch (err) { out.textContent = tr('הבדיקה נכשלה: ') + (err && err.message); }
          b.disabled = false;
        } }, tr('אבחון עדכון (בדיקת קבצים בשרת)')),
        out,
        h('button', { class: 'btn', onclick: async () => { if (await UI.confirmBox(tr('ינקה את הקבצים השמורים של האפליקציה ויטען אותם מחדש מהשרת. התוכניות, הסימונים והחשבון לא נמחקים. צריך חיבור לאינטרנט.'), { title: tr('עדכון כפוי'), okText: tr('נקה וטען מחדש') })) forceRefresh(); } }, tr('עדכון כפוי (ניקוי קבצי האפליקציה)'))),
      row(tr('עבודה ללא אינטרנט'), offline),
      row(tr('התקנה'), installRow),
      row(tr('חשבון'), acct),
      h('button', { class: 'btn', onclick: () => showPrivacy() }, tr('תנאי שימוש ופרטיות')),
      row(tr('אחסון במכשיר'), h('span', {}, tr('{0} מתוך {1} · ', fmtSize(est.usage), fmtSize(est.quota)) + (est.persisted ? tr('קבוע') : tr('לא מסומן כקבוע'))),
        est.persisted ? null : h('button', { class: 'btn sm', onclick: async () => { const ok = await db.requestPersist(); UI.toast(ok ? tr('האחסון סומן כקבוע') : tr('הדפדפן לא אישר אחסון קבוע'), { type: ok ? '' : 'error' }); render(); } }, tr('בקש אחסון קבוע'))),
      h('p', { class: 'warn' }, tr('האחסון של האפליקציה המותקנת נפרד מהאחסון של הדפדפן. ') + (isCloud()
        ? tr('עם חשבון ענן זה בסדר: אחרי הכניסה התוכניות מסונכרנות מחדש ונפתחות (מורידות מהענן בפעם הראשונה בכל מכשיר/אפליקציה).')
        : tr('במצב מקומי: התקינו קודם ורק אחר כך העלו תוכניות, אחרת הן לא יופיעו באפליקציה המותקנת.'))));
  }
  render();
}
