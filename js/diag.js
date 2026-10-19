// יומן תקלות: שומר את אירועי הסנכרון והשגיאות (עם השלב המדויק, קוד, סטטוס והקשר) ב-localStorage,
// כדי שאפשר יהיה לראות בדיוק איפה ולמה משהו נכשל, ולהעתיק דוח מלא.
import { t as tr, LOCALE } from './i18n.js';
import { APP_VERSION } from './version.js';

const KEY = 'showplans.diag';
const MAX = 300;
let buf = [];
try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); if (!Array.isArray(buf)) buf = []; } catch { buf = []; }
const subs = new Set();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(buf.slice(-MAX))); } catch { /* ignore */ } }, 300);
}
const notify = () => subs.forEach((f) => { try { f(); } catch { /* ignore */ } });
export const onDiag = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// שמות קריאים לשלבים
const LABELS = {
  'push:tombs': tr('דחיפת מחיקות'), 'push:folders': tr('דחיפת תיקיות'), 'push:plans': tr('דחיפת תוכניות'), 'push:versions': tr('דחיפת גרסאות'),
  'write:folders': tr('כתיבת תיקייה לענן'), 'write:plans': tr('כתיבת תוכנית לענן'), 'write:versions': tr('כתיבת גרסה לענן'),
  upload: tr('העלאה ל-Drive'), 'upload:session': tr('פתיחת העלאה (שרת→גוגל)'), 'upload:put': tr('שליחת הקובץ לגוגל'), 'upload:verify': tr('אימות ההעלאה'),
  adopt: tr('שימוש בקובץ שכבר בענן'), download: tr('הורדה מהענן'), 'pull:grants': tr('משיכה: הרשאות'), 'pull:fetch': tr('משיכה: קריאת שינויים'),
  'pull:apply': tr('משיכה: שמירה במכשיר'), 'pull:reconcile': tr('משיכה: התאמה מלאה'), 'pull:purge': tr('משיכה: ניקוי'), pull: tr('משיכה מהענן'),
  global: tr('שגיאה כללית באפליקציה'), net: tr('רשת'),
};
export function label(where) {
  if (!where) return '';
  if (LABELS[where]) return LABELS[where];
  if (where.startsWith('fn:')) return tr('פונקציית שרת ') + where.slice(3);
  return where;
}

// הופך כל סוג שגיאה (Error, PostgrestError, מחרוזת) לאובייקט פשוט
export function describe(e) {
  if (e == null) return { message: tr('שגיאה לא ידועה') };
  if (typeof e !== 'object') return { message: String(e) };
  const o = { message: String(e.message || e.error_description || e.error || e) };
  if (e.name && e.name !== 'Error') o.name = e.name;
  for (const k of ['status', 'code', 'step', 'serverStatus', 'details', 'hint', 'fn']) if (e[k] != null && e[k] !== '') o[k] = e[k];
  if (e.ctx) o.ctx = e.ctx;
  if (e.stack) o.stack = String(e.stack).split('\n').slice(0, 4).join(' | ').slice(0, 400);
  return o;
}

export function log(level, where, msg, ctx) {
  const entry = { t: Date.now(), level, where, msg: String(msg).slice(0, 500) };
  if (ctx && Object.keys(ctx).length) entry.ctx = ctx;
  buf.push(entry);
  if (buf.length > MAX + 50) buf = buf.slice(-MAX);
  if (level === 'error') console.warn('[diag]', where, msg, ctx || ''); else console.log('[diag]', where, msg, ctx || '');
  save(); notify();
  return entry;
}
export const info = (w, m, c) => log('info', w, m, c);
export const warn = (w, m, c) => log('warn', w, m, c);

// רישום שגיאה (פעם אחת לכל אובייקט שגיאה, גם אם נתפס בכמה שכבות)
export function err(where, e, ctx = {}) {
  const d = describe(e);
  if (e && typeof e === 'object') {
    if (e._diag) return d;
    try { e._diag = true; } catch { /* ignore */ }
  }
  const { message, ctx: ectx, ...rest } = d;
  log('error', where, message, { ...rest, ...(ectx || {}), ...ctx });
  return d;
}

export function entries() { return buf.slice().reverse(); }
export function clear() { buf = []; try { localStorage.removeItem(KEY); } catch { /* ignore */ } notify(); }
export const fmtTime = (t) => new Date(t).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// דוח טקסטואלי להעתקה / שליחה
export async function report(extra = {}) {
  let storage = '';
  try { const s = await navigator.storage?.estimate?.(); if (s) storage = tr('{0}MB מתוך {1}MB', Math.round((s.usage || 0) / 1048576), Math.round((s.quota || 0) / 1048576)); } catch { /* ignore */ }
  const head = [
    `ShowPlans v${APP_VERSION}`,
    tr('זמן: {0}', new Date().toISOString()),
    tr('אונליין: {0}', navigator.onLine),
    tr('אחסון: {0}', storage || tr('לא ידוע')),
    tr('דפדפן: {0}', navigator.userAgent),
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '',
  ];
  const lines = entries().reverse().map((x) => `[${new Date(x.t).toISOString()}] ${x.level.toUpperCase()} ${x.where} | ${x.msg}${x.ctx ? ' | ' + JSON.stringify(x.ctx) : ''}`);
  return head.concat(lines).join('\n');
}

// ---------- תפיסה גלובלית של שגיאות שלא טופלו ----------
let installed = false;
export function install() {
  if (installed) return; installed = true;
  window.addEventListener('error', (ev) => {
    if (/ResizeObserver/i.test(ev.message || '')) return;
    log('error', 'global', ev.message || tr('שגיאה'), { file: String(ev.filename || '').split('/').pop(), line: ev.lineno, col: ev.colno });
  });
  window.addEventListener('unhandledrejection', (ev) => { err('global', ev.reason, { kind: 'unhandledrejection' }); });
  window.addEventListener('offline', () => warn('net', tr('החיבור לאינטרנט נותק')));
  window.addEventListener('online', () => info('net', tr('החיבור לאינטרנט חזר')));
}
install();
