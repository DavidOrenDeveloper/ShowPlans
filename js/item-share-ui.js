// שיתוף סימונים עם עובדים: פריט נבחר / כל הסימונים בעמוד / בתוכנית / בתיקייה / בכל התוכניות,
// צפייה או עריכה לכל עובד בנפרד, וביטול בכל רגע. האכיפה האמיתית בשרת (RLS + פונקציות share_items / share_author).
import { h } from './util.js';
import * as UI from './ui.js';
import * as S from './store.js';
import { client, isAdmin } from './cloud.js';
import { myId, syncNow } from './cloud-sync.js';

// ---------- שמות משתמשים ----------
let people = [], loadedAt = 0;
export async function getPeople(force = false) {
  if (!force && people.length && Date.now() - loadedAt < 60000) return people;
  try {
    const { data, error } = await client().rpc('people');
    if (error) throw error;
    people = data || []; loadedAt = Date.now();
  } catch { /* אין חיבור: משתמשים במה שנטען */ }
  return people;
}
export const nameOf = (id) => {
  if (!id) return '';
  if (id === myId()) return 'אני';
  const p = people.find((x) => x.id === id);
  return p ? (p.display_name || p.email || 'עובד') : 'משתמש אחר';
};

const CHOICES = [['keep', 'ללא שינוי'], ['none', 'ללא גישה'], ['view', 'צפייה בלבד'], ['edit', 'צפייה + עריכה']];
const rpc = async (fn, args) => { const { data, error } = await client().rpc(fn, args); if (error) throw error; return data; };

// ---------- דיאלוג שיתוף ----------
// v = ה-Viewer הפעיל. מחזיר אחרי סגירה.
export async function shareDialog(v, { preset } = {}) {
  if (!navigator.onLine) { await UI.alertBox('שיתוף דורש חיבור לאינטרנט.', { title: 'אין חיבור' }); return; }
  const ppl = (await getPeople(true)).filter((p) => p.id !== myId() && p.role !== 'admin');
  if (!ppl.length) { await UI.alertBox('אין עובדים לשיתוף. צרו עובדים דרך "עובדים" בתפריט הצד.', { title: 'אין עובדים' }); return; }

  const me = myId();
  const editableMine = (it) => (it.layer === 'markups' || it.layer === 'measurements') && v.canEditItem(it);
  const shown = () => [...v.items.markups, ...v.items.measurements].filter((it) => v.itemShown(it) && editableMine(it));
  const plan = v.plan, folderId = plan.folderId || null;
  const sel = v.selected && editableMine(v.selected) ? v.selected : null;

  const scopes = [];
  if (sel) scopes.push({ id: 'sel', label: 'הפריט הנבחר', items: () => [sel.id] });
  scopes.push({ id: 'page', label: 'כל הסימונים והמדידות בעמוד הזה', items: () => shown().filter((it) => it.page === v.pageNum).map((i) => i.id) });
  scopes.push({ id: 'ver', label: 'כל הסימונים והמדידות בתוכנית הזו (הגרסה הנוכחית)', items: () => shown().map((i) => i.id) });
  scopes.push({ id: 'a-plan', label: 'כל הסימונים של הכותב בתוכנית הזו, גם החדשים שיווצרו', author: true, plan: plan.id });
  if (folderId) scopes.push({ id: 'a-folder', label: `כל הסימונים של הכותב בתיקייה "${S.P.folders.get(folderId)?.name || ''}" ובכל מה שבתוכה`, author: true, folder: folderId });
  if (isAdmin()) scopes.push({ id: 'a-all', label: 'כל הסימונים של הכותב בכל התוכניות', author: true });

  let scope = scopes.find((s) => s.id === (preset || (sel ? 'sel' : 'page'))) || scopes[0];
  let author = me;
  const authors = isAdmin() ? [{ id: me, name: 'אני' }, ...ppl.map((p) => ({ id: p.id, name: p.display_name || p.email }))] : [{ id: me, name: 'אני' }];
  const state = new Map(); // userId -> { init, sel }
  const body = h('div', { class: 'form' });
  const list = h('div', { class: 'users' });
  const info = h('p', { class: 'hint' });
  let busy = false;

  const scopeSel = h('select', { 'aria-label': 'מה לשתף' }, scopes.map((s) => h('option', { value: s.id }, s.label)));
  scopeSel.value = scope.id;
  const authorSel = h('select', { 'aria-label': 'של מי' }, authors.map((a) => h('option', { value: a.id }, a.name)));
  const authorRow = h('label', {}, 'של הכותב: ', authorSel);
  scopeSel.addEventListener('change', () => { scope = scopes.find((s) => s.id === scopeSel.value); refresh(); });
  authorSel.addEventListener('change', () => { author = authorSel.value; refresh(); });

  async function currentLevels() {
    // מצב קיים לכל עובד, כשאפשר לדעת אותו (פריט בודד או הרשאת כותב); אחרת "ללא שינוי"
    const cur = new Map();
    try {
      if (scope.id === 'sel') {
        const { data } = await client().from('item_shares').select('user_id,level').eq('item_id', sel.id);
        (data || []).forEach((r) => cur.set(r.user_id, r.level));
        return { cur, known: true };
      }
      if (scope.author) {
        let q = client().from('author_shares').select('viewer_id,level').eq('author_id', author);
        q = scope.plan ? q.eq('plan_id', scope.plan) : scope.folder ? q.eq('folder_id', scope.folder) : q.is('plan_id', null).is('folder_id', null);
        const { data } = await q;
        (data || []).forEach((r) => cur.set(r.viewer_id, r.level));
        return { cur, known: true };
      }
    } catch { /* ignore */ }
    return { cur, known: false };
  }

  async function refresh() {
    authorRow.style.display = scope.author && isAdmin() ? '' : 'none';
    const n = scope.items ? scope.items().length : 0;
    info.textContent = scope.author
      ? 'ההרשאה חלה גם על סימונים עתידיים של הכותב באותו היקף, ואפשר לבטל אותה בכל רגע.'
      : (n ? `יש ${n} פריטים בהיקף הזה.` : 'אין פריטים בהיקף הזה.');
    list.replaceChildren(h('p', { class: 'hint' }, 'טוען…'));
    const { cur, known } = await currentLevels();
    state.clear();
    const rows = ppl.filter((p) => !(scope.author && p.id === author)).map((p) => {
      const init = known ? (cur.get(p.id) || 'none') : 'keep';
      const select = h('select', { 'aria-label': 'רמת שיתוף' }, CHOICES.map(([val, t]) => h('option', { value: val }, t)));
      select.value = init;
      state.set(p.id, { init, select });
      return h('div', { class: 'grant-row' }, h('div', {}, h('b', {}, p.display_name || p.email)), select);
    });
    list.replaceChildren(...rows);
  }

  async function apply(m) {
    if (busy) return false;
    const groups = { view: [], edit: [], none: [] };
    for (const [uid, s] of state) { const val = s.select.value; if (val !== 'keep' && val !== s.init) groups[val].push(uid); }
    if (!groups.view.length && !groups.edit.length && !groups.none.length) { UI.toast('לא בוצע שינוי'); return false; }
    const ids = scope.items ? scope.items() : null;
    if (ids && !ids.length) { UI.toast('אין פריטים לשיתוף בהיקף הזה', { type: 'error' }); return false; }
    busy = true;
    const pb = UI.progressBox('משתף…');
    try {
      await syncNow(); // הפריטים חייבים להיות בענן לפני שיתוף
      let count = 0, skipped = 0; const noAccess = new Map();
      for (const level of ['view', 'edit', 'none']) {
        if (!groups[level].length) continue;
        const r = ids
          ? await rpc('share_items', { p_items: ids, p_users: groups[level], p_level: level, p_add_access: false })
          : await rpc('share_author', { p_author: author, p_viewers: groups[level], p_plan: scope.plan || null, p_folder: scope.folder || null, p_level: level, p_add_access: false });
        count += r.count || 0; skipped += r.skipped || 0;
        (r.noAccess || []).forEach((u) => noAccess.set(u, level));
      }
      pb.close();
      if (noAccess.size) await fixAccess([...noAccess.keys()], ids, scope);
      UI.toast(skipped ? `השיתוף עודכן. ${skipped} פריטים דולגו (אין הרשאה או שטרם הועלו)` : 'השיתוף עודכן', { ms: 3500 });
      m.close(true);
      return true;
    } catch (e) {
      pb.close();
      UI.alertBox(e.message || String(e), { title: 'השיתוף נכשל' });
      return false;
    } finally { busy = false; }
  }

  // לעובד שאין לו גישה לתוכנית אי אפשר לראות בה כלום. מנהל יכול להוסיף לו צפייה ברגע זה.
  async function fixAccess(userIds, ids, sc) {
    const names = userIds.map((u) => nameOf(u)).join(', ');
    if (!isAdmin()) { await UI.alertBox(`ל-${names} אין גישה לתוכנית הזו, ולכן הם לא יראו את השיתוף. המנהל צריך לתת להם הרשאת צפייה בתוכנית.`, { title: 'חסרה גישה לתוכנית' }); return; }
    if (!(await UI.confirmBox(`ל-${names} אין גישה לתוכנית הזו. להוסיף להם צפייה בתוכנית (בלי סימונים של אחרים)?`, { title: 'חסרה גישה לתוכנית', okText: 'הוסף צפייה', cancelText: 'לא עכשיו' }))) return;
    for (const level of ['view', 'edit']) {
      const us = userIds.filter((u) => state.get(u)?.select.value === level); if (!us.length) continue;
      if (ids) await rpc('share_items', { p_items: ids, p_users: us, p_level: level, p_add_access: true });
      else await rpc('share_author', { p_author: author, p_viewers: us, p_plan: sc.plan || null, p_folder: sc.folder || null, p_level: level, p_add_access: true });
    }
  }

  body.append(
    h('p', { class: 'hint' }, 'ברירת המחדל: כל סימון פרטי ורק היוצר והמנהל רואים אותו. כאן בוחרים מי עוד רואה, ומי גם יכול לערוך.'),
    h('label', {}, 'מה לשתף'), scopeSel, authorRow, info, list);
  const m = UI.openModal({
    title: 'שיתוף סימונים', body, wide: true,
    buttons: [{ text: 'ביטול', value: false }, { text: 'שיתופים פעילים…', keepOpen: true, onClick: () => { sharesOverview(v); } }, { text: 'שמור', kind: 'primary', keepOpen: true, onClick: (mm) => apply(mm) }],
  });
  refresh();
  return m.promise;
}

// ---------- שיתופים פעילים ובטולם ----------
export async function sharesOverview(v) {
  await getPeople(true);
  const body = h('div', { class: 'users' });
  const m = UI.openModal({ title: 'שיתופים פעילים', body: h('div', {}, body), wide: true, buttons: [{ text: 'סגור', value: true }] });
  const scopeText = (r) => (r.plan_id ? `בתוכנית "${S.P.plans.get(r.plan_id)?.name || '?'}"` : r.folder_id ? `בתיקייה "${S.P.folders.get(r.folder_id)?.name || '?'}"` : 'בכל התוכניות');
  const lv = (l) => (l === 'edit' ? 'צפייה ועריכה' : 'צפייה');
  async function load() {
    body.replaceChildren(h('p', { class: 'hint' }, 'טוען…'));
    try {
      const [a, i] = await Promise.all([
        client().from('author_shares').select('*').order('created_at'),
        client().from('item_shares').select('user_id,item_id,level,plan_id').eq('plan_id', v.planId),
      ]);
      if (a.error) throw a.error; if (i.error) throw i.error;
      const rows = [];
      for (const r of a.data) {
        rows.push(h('div', { class: 'user-row' },
          h('div', { class: 'u-main' }, h('b', {}, `${nameOf(r.viewer_id)} ← הסימונים של ${nameOf(r.author_id)}`), h('small', {}, `${scopeText(r)} · ${lv(r.level)}`)),
          h('button', { class: 'btn sm danger', onclick: async () => { try { await rpc('share_author', { p_author: r.author_id, p_viewers: [r.viewer_id], p_plan: r.plan_id, p_folder: r.folder_id, p_level: 'none', p_add_access: false }); UI.toast('השיתוף בוטל'); load(); } catch (e) { UI.toast(e.message, { type: 'error' }); } } }, 'בטל')));
      }
      const byUser = new Map();
      for (const r of i.data) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
      for (const [uid, list] of byUser) {
        rows.push(h('div', { class: 'user-row' },
          h('div', { class: 'u-main' }, h('b', {}, nameOf(uid)), h('small', {}, `${list.length} פריטים משותפים בתוכנית הזו (${list.some((x) => x.level === 'edit') ? 'חלקם לעריכה' : 'צפייה'})`)),
          h('button', { class: 'btn sm danger', onclick: async () => { try { await rpc('share_items', { p_items: list.map((x) => x.item_id), p_users: [uid], p_level: 'none', p_add_access: false }); UI.toast('השיתוף בוטל'); load(); } catch (e) { UI.toast(e.message, { type: 'error' }); } } }, 'בטל הכול')));
      }
      body.replaceChildren(...(rows.length ? rows : [h('p', { class: 'hint' }, 'אין שיתופים פעילים.')]));
    } catch (e) { body.replaceChildren(h('p', { class: 'msg' }, 'שגיאה: ' + (e.message || e))); }
  }
  load();
  return m.promise;
}

