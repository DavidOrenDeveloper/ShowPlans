// מסכי השכבה האישית: "מוסתרים אצלי" (עובד) ו"צפייה כעובד" (מנהל).
import { t as tr } from './i18n.js';
import { dn } from './names.js';
import * as S from './store.js';
import * as UI from './ui.js';
import * as OVR from './overrides.js';
import { client, cloud, folderLevelFrom, planLevelFrom } from './cloud.js';
import { h, icon } from './util.js';

// ---------- מוסתרים אצלי ----------
export async function hiddenDialog() {
  const list = h('div', { class: 'result-list' });
  const body = h('div', { class: 'stack' }, h('p', { class: 'hint' }, tr('פריטים שהסתרת מעצמך. הם לא נמחקו, ואצל אחרים לא השתנה כלום. אפשר להחזיר אותם.')), list);
  const m = UI.openModal({ title: tr('מוסתרים אצלי'), body, buttons: [{ text: tr('סגור'), value: true }] });
  const paint = () => {
    const items = S.hiddenList();
    list.replaceChildren(...(items.length ? items.map((x) => h('div', { class: 'result' },
      icon(x.type === 'folder' ? 'folder' : 'file', 20), h('span', { class: 'col' }, h('b', {}, dn(x.name))),
      h('button', { class: 'btn sm', onclick: async () => { await S.unhide([x.id]); paint(); UI.toast(tr('הוחזר')); } }, tr('החזר')))) : [h('p', { class: 'hint' }, tr('אין פריטים מוסתרים.'))]));
  };
  paint();
  return m.promise;
}

// ---------- צפייה כעובד (מנהל) ----------
// מה העובד רואה לפי ההרשאות שלו (אותו כלל כמו בשרת: ההרשאה הקרובה ביותר קובעת, 'none' חוסם; תיקיות-אב מוצגות לצורך ניווט)
export function computeAllow(grants, rawFolders, rawPlans) {
  const plans = new Set(), folders = new Set();
  const up = (fid) => { let f = fid ? rawFolders.get(fid) : null, g = 0; while (f && g++ < 200) { folders.add(f.id); f = f.parentId ? rawFolders.get(f.parentId) : null; } };
  for (const p of rawPlans.values()) if (planLevelFrom(grants, p, rawFolders) >= 1) { plans.add(p.id); up(p.folderId); }
  for (const f of rawFolders.values()) if (folderLevelFrom(grants, f.id, rawFolders) >= 1) up(f.id);
  return { folders, plans };
}

export async function enterViewAs(user) {
  const sb = client();
  const [g, rows] = await Promise.all([sb.from('grants').select('*').eq('user_id', user.id), OVR.fetchOf(sb, user.id)]);
  if (g.error) throw g.error;
  S.setViewAs({ userId: user.id, name: user.display_name || user.email, rows, allow: computeAllow(g.data || [], S.R.folders, S.R.plans) });
  location.hash = '#/f/';
}
export function exitViewAs() { S.setViewAs(null); }

export async function viewAsDialog() {
  const list = h('div', { class: 'result-list' }, h('p', { class: 'hint' }, tr('טוען…')));
  const m = UI.openModal({ title: tr('צפייה כעובד'), body: h('div', { class: 'stack' }, h('p', { class: 'hint' }, tr('תראה בדיוק מה העובד רואה: רק התוכניות שהרשית לו, עם השמות שנתן והסתרות שעשה, ועם הסימונים. כל הרשאות המנהל שלך נשארות.')), list), buttons: [{ text: tr('סגור'), value: true }] });
  const { data, error } = await client().from('profiles').select('*').order('created_at');
  if (error) { list.replaceChildren(h('p', { class: 'msg' }, tr('שגיאה: ') + error.message)); return m.promise; }
  const workers = data.filter((u) => u.role !== 'admin' && u.id !== cloud.user.id);
  list.replaceChildren(...(workers.length ? workers.map((u) => h('button', { class: 'result', onclick: async () => {
    try { await enterViewAs(u); m.close(true); } catch (e) { UI.toast(tr('הטעינה נכשלה: ') + e.message, { type: 'error' }); }
  } }, icon('users', 20), h('span', { class: 'col' }, h('b', {}, u.display_name || u.email), h('small', { dir: 'ltr' }, u.email)))) : [h('p', { class: 'hint' }, tr('אין עובדים.'))]));
  return m.promise;
}

export function viewAsBanner() {
  const v = S.getViewAs(); if (!v) return null;
  return h('div', { class: 'viewas-bar' },
    icon('users', 18), h('span', {}, tr('צפייה כעובד: {0}. מוצג כפי שהוא רואה (שמות אישיים, והסתרות מסומנות), כולל הסימונים שלו. אפשר לערוך ולסדר כמנהל.', v.name)),
    h('button', { class: 'btn sm', onclick: () => viewAsDialog() }, tr('החלף עובד')),
    h('button', { class: 'btn sm primary', onclick: () => { exitViewAs(); } }, tr('חזרה לחשבון שלי')));
}
