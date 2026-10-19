// שפה / Language: עברית (RTL) או אנגלית (LTR). הבחירה נשמרת במכשיר, ולכן כל משתמש (עובד או מנהל) בוחר לעצמו
// והשפה של משתמש אחד לא משפיעה על אחר – גם כשהמנהל צופה בקבצים של עובד.
// הטקסטים בקוד נכתבים בעברית; tr('עברית') מחזיר את התרגום באנגלית (מתוך lang-en.js) כשהשפה אנגלית.
// פרמטרים: tr('נוספו {0} תוכניות', n). טקסטים שהמשתמשים כתבו (שמות תיקיות/תוכניות, הערות) לא מתורגמים.
import { EN } from './lang-en.js';

const KEY = 'app-lang';
let lang = 'he';
try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'he') lang = s; } catch { /* ignore */ }

export const getLang = () => lang;
export const isEn = () => lang === 'en';
export const LOCALE = lang === 'en' ? 'en-GB' : 'he-IL';
// חצים לפי כיוון הקריאה: קדימה = לכיוון סוף השורה (שמאל בעברית, ימין באנגלית)
export const CHEV_FWD = lang === 'en' ? 'chevR' : 'chevL';
export const CHEV_BACK = lang === 'en' ? 'chevL' : 'chevR';
export const APP_NAME = { he: 'תוכניות בנייה', en: 'Construction Plans' };
export const APP_SHORT = { he: 'תוכניות', en: 'Plans' };

const missing = new Set();
export function t(key, ...args) {
  let s = key;
  if (lang === 'en') {
    if (Object.prototype.hasOwnProperty.call(EN, key)) s = EN[key];
    else if (/[֐-׿]/.test(key) && !missing.has(key)) { missing.add(key); console.warn('[i18n] missing English:', key); }
  }
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => String(args[+i])) : s;
}

// כיוון, שפה, כותרת הדף, שם האפליקציה (manifest) והכותרת במסך הבית של iOS
function applyChrome() {
  const d = document.documentElement;
  d.lang = lang; d.dir = lang === 'en' ? 'ltr' : 'rtl';
  document.title = APP_NAME[lang];
  const setMeta = (name, content) => { const m = document.querySelector(`meta[name="${name}"]`); if (m) m.setAttribute('content', content); };
  setMeta('apple-mobile-web-app-title', APP_SHORT[lang]);
  setMeta('description', lang === 'en' ? 'Manage construction plans and PDF files' : 'ניהול תוכניות בנייה וקבצי PDF');
  const boot = document.querySelector('#boot span'); if (boot) boot.textContent = lang === 'en' ? 'Loading…' : 'טוען…';
  const bc = document.querySelector('.boot-credit'); if (bc) bc.textContent = lang === 'en' ? 'Created by David Oren' : 'נוצר על ידי דוד אורן';
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.setAttribute('href', lang === 'en' ? 'manifest-en.webmanifest' : 'manifest.webmanifest');
}
if (typeof document !== 'undefined') applyChrome();

// מחליף שפה וטוען מחדש (המסך הנוכחי נשמר דרך ה-hash; כל הטקסטים נבנים מחדש בשפה החדשה)
export function setLang(l) {
  if (l !== 'en' && l !== 'he') return;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  location.reload();
}
export const toggleLang = () => setLang(lang === 'en' ? 'he' : 'en');
// הטקסט על הכפתור: השפה שאליה עוברים (בשפה שלה, כדי שמי שלא מבין את השפה הנוכחית יזהה אותו)
export const langButtonLabel = () => (lang === 'en' ? 'עברית' : 'English');
