// הודעת פרטיות והסכמה לתנאי שימוש (חובת יידוע לפי חוק הגנת הפרטיות, תיקון 13).
// כל משתמש בענן מאשר פעם אחת (וגם אחרי כל שינוי מהותי בנוסח). האישור נרשם בטבלה consents.
import { PRIVACY } from './privacy-config.js';
import { client, cloud, signOut } from './cloud.js';
import * as UI from './ui.js';
import { h } from './util.js';

const LSK = (uid) => 'plans.consent.' + uid;
const localOk = (uid) => { try { return localStorage.getItem(LSK(uid)) === PRIVACY.version; } catch { return false; } };
const setLocal = (uid) => { try { localStorage.setItem(LSK(uid), PRIVACY.version); } catch { /* ignore */ } };

export function privacyBody() {
  const who = PRIVACY.contact ? `${PRIVACY.controller} (${PRIVACY.contact})` : `${PRIVACY.controller}, מנהל המערכת`;
  const li = (...x) => h('li', {}, ...x);
  return h('div', { class: 'privacy' },
    h('p', {}, 'האפליקציה משמשת את צוות העבודה לניהול ולצפייה בתוכניות בנייה ובסימונים עליהן. לפני שנכנסים, חשוב שתדעו איזה מידע נשמר ולמה.'),
    h('h3', {}, 'מי אחראי על המידע'),
    h('p', {}, `בעל המאגר: ${who}. אליו פונים בכל שאלה, ולמימוש הזכויות שלהלן.`),
    h('h3', {}, 'איזה מידע נשמר'),
    h('ul', {},
      li('פרטי החשבון: שם, כתובת אימייל לכניסה, תפקיד (מנהל או עובד) וההרשאות שניתנו לכם.'),
      li('תוכניות ו-PDF שהועלו, ומי העלה אותן ומתי.'),
      li('סימונים, מדידות, כיולים וקישורים שיצרתם, עם זמן היצירה והעריכה.'),
      li('שמות אישיים שנתתם לתיקיות ולתוכניות, תיקיות אישיות שיצרתם, ופריטים שהסתרתם מעצמכם.'),
      li('נתונים טכניים של האתר והשרת: כתובת IP וסוג דפדפן, כפי שנרשמים אצל ספקי התשתית. האפליקציה לא אוספת מיקום, אנשי קשר, תמונות, מיקרופון או מצלמה.')),
    h('h3', {}, 'למה'),
    h('p', {}, 'לצורך עבודה משותפת על תוכניות בלבד: הצגה, סימון, שיתוף בין עובדים וניהול הרשאות. לא לשיווק ולא למכירה לאחרים.'),
    h('h3', {}, 'מי רואה את המידע'),
    h('ul', {},
      li('המנהל רואה את כל התוכניות, את כל הסימונים והמדידות של כל עובד (גם אלה שלא שיתפתם), מי יצר ומתי ערך, ואת השמות האישיים וההסתרות שלכם. כלומר יש למנהל יכולת מעקב אחרי העבודה שנעשית באפליקציה.'),
      li('עובדים אחרים רואים רק את מה שהמנהל נתן להם הרשאה לראות, ואת הסימונים שלכם רק אם שיתפתם או שהמנהל שיתף.')),
    h('h3', {}, 'האם חובה למסור'),
    h('p', {}, 'אין חובה חוקית למסור את המידע. הוא נדרש כדי להשתמש באפליקציה: בלי אימייל וחשבון אי אפשר להיכנס, ואם לא תסכימו – לא תוכלו להשתמש בה.'),
    h('h3', {}, 'ספקי תשתית והעברה לחו"ל'),
    h('p', {}, 'המידע נשמר אצל ספקים חיצוניים: Supabase (מסד נתונים והתחברות), Google Drive (קבצי ה-PDF) ו-GitHub Pages (אירוח האתר). השרתים שלהם עשויים להיות מחוץ לישראל. הספקים מקבלים את המידע רק כדי להפעיל את השירות.'),
    h('h3', {}, 'כמה זמן'),
    h('p', {}, 'כל עוד אתם משתמשים באפליקציה. פריטים שנמחקו מוסרים סופית מהשרת אחרי 30 יום. אפשר לבקש מחיקה מוקדמת של כל המידע שלכם.'),
    h('h3', {}, 'הזכויות שלכם'),
    h('p', {}, 'אפשר לבקש לעיין במידע שנשמר עליכם, לתקן אותו או למחוק אותו, בפנייה לבעל המאגר.'),
    h('h3', {}, 'אבטחה'),
    h('p', {}, 'החיבור מוצפן (HTTPS), הגישה למידע מוגבלת לפי הרשאות בשרת עצמו ולא רק במסך, ורק המנהל מנהל משתמשים. אם נודע על אירוע אבטחה שפוגע בכם נדווח לכם.'),
    h('p', { class: 'hint-inline' }, `נוסח מתאריך ${PRIVACY.version}.`));
}

export function showPrivacy() {
  return UI.modal({ title: 'תנאי שימוש ופרטיות', body: privacyBody(), wide: true, buttons: [{ text: 'סגור', value: true }] });
}

const missingTable = (e) => /PGRST205|42P01|schema cache|does not exist/i.test(`${e.code || ''} ${e.message || ''}`);

// חוסם את הכניסה עד שהמשתמש מאשר את הנוסח הנוכחי
export async function ensureConsent() {
  if (cloud.mode !== 'cloud' || !cloud.user) return true;
  const uid = cloud.user.id;
  if (localOk(uid)) return true;
  try {
    const { data, error } = await client().from('consents').select('version').eq('user_id', uid).eq('version', PRIVACY.version);
    if (!error && data && data.length) { setLocal(uid); return true; }
    if (error && missingTable(error)) return true; // קובץ ה-SQL עוד לא הורץ: לא נועלים אף אחד בחוץ
  } catch { /* אין חיבור: מבקשים אישור מחדש */ }
  for (;;) {
    const cb = h('input', { type: 'checkbox' });
    const agree = h('label', { class: 'check' }, cb, 'קראתי והבנתי, ואני מסכים/ה לתנאי השימוש ולאיסוף המידע כמתואר');
    const r = await UI.modal({
      title: 'תנאי שימוש ופרטיות', wide: true, cancelable: false,
      body: h('div', { class: 'stack' }, privacyBody(), agree),
      buttons: [
        { text: 'לא מסכים (התנתקות)', value: 'no' },
        { text: 'המשך', kind: 'primary', value: 'yes', keepOpen: true, onClick: (mm) => { if (!cb.checked) { UI.toast('כדי להמשיך יש לסמן שקראתם ומסכימים', { type: 'error' }); return false; } mm.close('yes'); return false; } },
      ],
    });
    if (r === 'no') { await signOut(); return false; }
    if (r !== 'yes') continue;
    const { error } = await client().from('consents').upsert({ user_id: uid, version: PRIVACY.version }, { onConflict: 'user_id,version', ignoreDuplicates: true });
    if (error && missingTable(error)) return true;
    if (error) { await UI.alertBox('לא ניתן היה לשמור את האישור: ' + error.message + '\nבדקו חיבור ונסו שוב.', { title: 'שגיאה' }); continue; }
    setLocal(uid);
    return true;
  }
}
