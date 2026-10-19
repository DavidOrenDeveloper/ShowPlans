// הודעת פרטיות והסכמה לתנאי שימוש (חובת יידוע לפי חוק הגנת הפרטיות, תיקון 13).
// כל משתמש בענן מאשר פעם אחת (וגם אחרי כל שינוי מהותי בנוסח). האישור נרשם בטבלה consents.
import { t as tr } from './i18n.js';
import { PRIVACY } from './privacy-config.js';
import { client, cloud, signOut } from './cloud.js';
import * as UI from './ui.js';
import { h } from './util.js';

const LSK = (uid) => 'plans.consent.' + uid;
const localOk = (uid) => { try { return localStorage.getItem(LSK(uid)) === PRIVACY.version; } catch { return false; } };
const setLocal = (uid) => { try { localStorage.setItem(LSK(uid), PRIVACY.version); } catch { /* ignore */ } };

export function privacyBody() {
  const who = PRIVACY.contact ? `${PRIVACY.controller} (${PRIVACY.contact})` : tr('{0}, מנהל המערכת', PRIVACY.controller);
  const li = (...x) => h('li', {}, ...x);
  return h('div', { class: 'privacy' },
    h('p', {}, tr('האפליקציה משמשת את צוות העבודה לניהול ולצפייה בתוכניות בנייה ובסימונים עליהן. לפני שנכנסים, חשוב שתדעו איזה מידע נשמר ולמה.')),
    h('h3', {}, tr('מי אחראי על המידע')),
    h('p', {}, tr('בעל המאגר: {0}. אליו פונים בכל שאלה, ולמימוש הזכויות שלהלן.', who)),
    h('h3', {}, tr('איזה מידע נשמר')),
    h('ul', {},
      li(tr('פרטי החשבון: שם, כתובת אימייל לכניסה, תפקיד (מנהל או עובד) וההרשאות שניתנו לכם.')),
      li(tr('תוכניות ו-PDF שהועלו, ומי העלה אותן ומתי.')),
      li(tr('סימונים, מדידות, כיולים וקישורים שיצרתם, עם זמן היצירה והעריכה.')),
      li(tr('שמות אישיים שנתתם לתיקיות ולתוכניות, תיקיות אישיות שיצרתם, ופריטים שהסתרתם מעצמכם.')),
      li(tr('נתונים טכניים של האתר והשרת: כתובת IP וסוג דפדפן, כפי שנרשמים אצל ספקי התשתית. האפליקציה לא אוספת מיקום, אנשי קשר, תמונות, מיקרופון או מצלמה.'))),
    h('h3', {}, tr('למה')),
    h('p', {}, tr('לצורך עבודה משותפת על תוכניות בלבד: הצגה, סימון, שיתוף בין עובדים וניהול הרשאות. לא לשיווק ולא למכירה לאחרים.')),
    h('h3', {}, tr('מי רואה את המידע')),
    h('ul', {},
      li(tr('המנהל רואה את כל התוכניות, את כל הסימונים והמדידות של כל עובד (גם אלה שלא שיתפתם), מי יצר ומתי ערך, ואת השמות האישיים וההסתרות שלכם. כלומר יש למנהל יכולת מעקב אחרי העבודה שנעשית באפליקציה.')),
      li(tr('עובדים אחרים רואים רק את מה שהמנהל נתן להם הרשאה לראות, ואת הסימונים שלכם רק אם שיתפתם או שהמנהל שיתף.'))),
    h('h3', {}, tr('האם חובה למסור')),
    h('p', {}, tr('אין חובה חוקית למסור את המידע. הוא נדרש כדי להשתמש באפליקציה: בלי אימייל וחשבון אי אפשר להיכנס, ואם לא תסכימו – לא תוכלו להשתמש בה.')),
    h('h3', {}, tr('ספקי תשתית והעברה לחו"ל')),
    h('p', {}, tr('המידע נשמר אצל ספקים חיצוניים: Supabase (מסד נתונים והתחברות), Google Drive (קבצי ה-PDF) ו-GitHub Pages (אירוח האתר). השרתים שלהם עשויים להיות מחוץ לישראל. הספקים מקבלים את המידע רק כדי להפעיל את השירות.')),
    h('p', {}, tr('תרגום שמות: כדי להציג שמות של תיקיות ותוכניות בשפה שבחרתם, שמות (בלבד, לא תוכן הקבצים) שאינם במילון המובנה נשלחים לשירות תרגום חיצוני (MyMemory) ונשמרים במכשיר. אפשר לכבות זאת בהגדרות ← תרגום שמות קבצים ותיקיות.')),
    h('h3', {}, tr('כמה זמן')),
    h('p', {}, tr('כל עוד אתם משתמשים באפליקציה. פריטים שנמחקו מוסרים סופית מהשרת אחרי 30 יום. אפשר לבקש מחיקה מוקדמת של כל המידע שלכם.')),
    h('h3', {}, tr('הזכויות שלכם')),
    h('p', {}, tr('אפשר לבקש לעיין במידע שנשמר עליכם, לתקן אותו או למחוק אותו, בפנייה לבעל המאגר.')),
    h('h3', {}, tr('אבטחה')),
    h('p', {}, tr('החיבור מוצפן (HTTPS), הגישה למידע מוגבלת לפי הרשאות בשרת עצמו ולא רק במסך, ורק המנהל מנהל משתמשים. אם נודע על אירוע אבטחה שפוגע בכם נדווח לכם.')),
    h('p', { class: 'hint-inline' }, tr('נוסח מתאריך {0}.', PRIVACY.version)));
}

export function showPrivacy() {
  return UI.modal({ title: tr('תנאי שימוש ופרטיות'), body: privacyBody(), wide: true, buttons: [{ text: tr('סגור'), value: true }] });
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
  document.getElementById('boot')?.remove(); // מסך הטעינה מכסה את החלון, אחרת ההודעה לא נראית והאפליקציה נראית תקועה
  for (;;) {
    const cb = h('input', { type: 'checkbox' });
    const agree = h('label', { class: 'check' }, cb, tr('קראתי והבנתי, ואני מסכים/ה לתנאי השימוש ולאיסוף המידע כמתואר'));
    const r = await UI.modal({
      title: tr('תנאי שימוש ופרטיות'), wide: true, cancelable: false,
      body: h('div', { class: 'stack' }, privacyBody(), agree),
      buttons: [
        { text: tr('לא מסכים (התנתקות)'), value: 'no' },
        { text: tr('המשך'), kind: 'primary', value: 'yes', keepOpen: true, onClick: (mm) => { if (!cb.checked) { UI.toast(tr('כדי להמשיך יש לסמן שקראתם ומסכימים'), { type: 'error' }); return false; } mm.close('yes'); return false; } },
      ],
    });
    if (r === 'no') { await signOut(); return false; }
    if (r !== 'yes') continue;
    const { error } = await client().from('consents').upsert({ user_id: uid, version: PRIVACY.version }, { onConflict: 'user_id,version', ignoreDuplicates: true });
    if (error && missingTable(error)) return true;
    if (error) { await UI.alertBox(tr('לא ניתן היה לשמור את האישור: ') + error.message + tr('\nבדקו חיבור ונסו שוב.'), { title: tr('שגיאה') }); continue; }
    setLocal(uid);
    return true;
  }
}
