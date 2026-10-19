// מסכי השכבה האישית: "מוסתרים אצלי" (עובד) ו"צפייה כעובד" (מנהל).
import { t as tr } from './i18n.js';
import { dn } from './names.js';
import * as S from './store.js';
import * as UI from './ui.js';
import * as OVR from './overrides.js';
import { client, cloud } from './cloud.js';
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
const RANK = { view: 1, mark: 2, edit: 3 };
// מה העובד רואה לפי ההרשאות שלו (קירוב של מדיניות השרת: הרשאה על תיקייה חלה על כל מה שבתוכה; תיקיות-אב מוצגות לצורך ניווט)
export function computeAllow(grants, rawFolders, rawPlans) {
  const lvF = new Map();
  const folderLevel = (id) => {
    if (lvF.has(id)) return lvF.get(id);
    let best = 0, f = rawFolders.get(id), g = 0;
    while (f && g++ < 200) { for (const gr of grants) if (gr.folder_id === f.id) best = Math.max(best, RANK[gr.level] || 0); f = f.parentId ? rawFolders.get(f.parentId) : null; }
    lvF.set(id, best); return best;
  };
  const plans = new Set(), folders = new Set();
  for (const p of rawPlans.values()) {
    let best = p.folderId ? folderLevel(p.folderId) : 0;
    for (const gr of grants) if (gr.plan_id === p.id) best = Math.max(best, RANK[gr.level] || 0);
    if (best >= 1) { plans.add(p.id); let f = p.folderId ? rawFolders.get(p.folderId) : null, g = 0; while (f && g++ < 200) { folders.add(f.id); f = f.parentId ? rawFolders.get(f.parentId) : null; } }
  }
  for (const f of rawFolders.values()) if (folderLevel(f.id) >= 1) { let x = f, g = 0; while (x && g++ < 200) { folders.add(x.id); x = x.parentId ? rawFolders.get(x.parentId) : null; } }
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
