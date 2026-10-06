// ממשק הענן: מסך כניסה, תיבת חשבון בתפריט הצד, ניהול עובדים והרשאות (מנהל בלבד).
import { h, icon } from './util.js';
import * as UI from './ui.js';
import * as S from './store.js';
import * as db from './db.js';
import { cloud, client, isCloud, isAdmin, signIn, signOut, chooseLocal, callFn, localDataSummary, copyLocalIntoCurrent, switchToLogin } from './cloud.js';
import { syncStatus, onSyncStatus, syncNow } from './cloud-sync.js';

// ---------- מסך כניסה ----------
export function loginScreen() {
  return new Promise((resolve) => {
    document.getElementById('boot')?.remove();
    const email = h('input', { type: 'email', autocomplete: 'username', dir: 'ltr', placeholder: 'אימייל', required: true, inputMode: 'email' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', dir: 'ltr', placeholder: 'סיסמה', required: true });
    const err = h('div', { class: 'login-err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'כניסה');
    const form = h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'נכנס…';
      try { await signIn(email.value, pass.value); box.remove(); resolve('cloud'); }
      catch (ex) { err.textContent = /fetch|network/i.test(ex.message) ? 'אין חיבור לשרת. בדקו אינטרנט ונסו שוב.' : ex.message; btn.disabled = false; btn.textContent = 'כניסה'; }
    } },
    h('div', { class: 'logo big' }, icon('layers', 30)),
    h('h1', {}, 'תוכניות בנייה'),
    h('p', { class: 'hint' }, 'התחברו עם האימייל והסיסמה שקיבלתם מהמנהל'),
    h('label', {}, 'אימייל'), email, h('label', {}, 'סיסמה'), pass, err, btn,
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => { chooseLocal(); box.remove(); resolve('local'); } }, 'המשך בלי חשבון (שמירה מקומית בלבד)'),
    h('div', { class: 'page-credit' }, 'נוצר על ידי דוד אורן'));
    const box = h('div', { class: 'login-screen' }, form);
    document.body.append(box);
    setTimeout(() => email.focus(), 80);
  });
}

// ---------- תיבת חשבון בתפריט הצד ----------
let statusEl = null;
onSyncStatus((s) => { if (statusEl?.isConnected) paintStatus(s); });
function paintStatus(s = syncStatus()) {
  statusEl.className = 'acct-status ' + s.kind; statusEl.textContent = s.text;
}
export function accountBox() {
  if (!isCloud()) {
    return h('div', { class: 'acct' },
      h('div', { class: 'acct-line' }, icon('cloud', 16), h('span', {}, 'מצב מקומי – ללא סנכרון')),
      h('button', { class: 'btn ghost block', onclick: () => switchToLogin() }, icon('user', 18), 'התחברות לענן'));
  }
  const p = cloud.profile;
  statusEl = h('div', { class: 'acct-status' }); paintStatus();
  return h('div', { class: 'acct' },
    h('div', { class: 'acct-line' }, icon('user', 16), h('b', {}, p.display_name || p.email), h('span', { class: 'role-badge' }, p.role === 'admin' ? 'מנהל' : 'עובד')),
    statusEl,
    h('div', { class: 'acct-btns' },
      h('button', { class: 'btn ghost sm', onclick: async () => { await syncNow(); UI.toast('הסנכרון הסתיים'); } }, icon('refresh', 16), 'סנכרן'),
      isAdmin() ? h('button', { class: 'btn ghost sm', onclick: () => usersDialog() }, icon('users', 16), 'עובדים') : null,
      h('button', { class: 'btn ghost sm', onclick: async () => { if (await UI.confirmBox('להתנתק? נתוני העבודה נשארים שמורים במכשיר ויסונכרנו בכניסה הבאה.', { title: 'התנתקות', okText: 'התנתק' })) signOut(); } }, icon('logout', 16), 'התנתק')));
}

// ---------- ניהול עובדים (מנהל) ----------
const genPass = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.getRandomValues(new Uint32Array(10)); r.forEach((x) => { s += c[x % c.length]; }); return s; };
export async function usersDialog() {
  const list = h('div', { class: 'users' });
  const m = UI.openModal({ title: 'ניהול עובדים', wide: true, body: h('div', {}, list), buttons: [{ text: 'סגור', value: true }] });
  async function load() {
    list.replaceChildren(h('p', { class: 'hint' }, 'טוען…'));
    const { data, error } = await client().from('profiles').select('*').order('created_at');
    if (error) { list.replaceChildren(h('p', { class: 'msg' }, 'שגיאה: ' + error.message)); return; }
    list.replaceChildren(
      ...data.map((u) => h('div', { class: 'user-row' },
        h('div', { class: 'u-main' }, h('b', {}, u.display_name || u.email), h('small', { dir: 'ltr' }, u.email), h('span', { class: 'role-badge' }, u.role === 'admin' ? 'מנהל' : 'עובד')),
        u.id === cloud.user.id ? h('small', {}, 'אתה') : h('div', { class: 'u-btns' },
          h('button', { class: 'btn sm', onclick: () => resetPass(u) }, 'סיסמה חדשה'),
          h('button', { class: 'btn sm', onclick: async () => { const r = u.role === 'admin' ? 'worker' : 'admin'; if (await UI.confirmBox(r === 'admin' ? `להפוך את ${u.email} למנהל? הוא יראה ויערוך הכול.` : `להפוך את ${u.email} לעובד?`)) { await run(() => callFn('admin-users', { action: 'setRole', userId: u.id, role: r })); load(); } } }, u.role === 'admin' ? 'הפוך לעובד' : 'הפוך למנהל'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await UI.confirmBox(`למחוק את המשתמש ${u.email}? הסימונים שלו יישארו.`, { danger: true, okText: 'מחק' })) { await run(() => callFn('admin-users', { action: 'delete', userId: u.id })); load(); } } }, 'מחק')))),
      newUserForm());
  }
  async function run(fn) { try { return await fn(); } catch (e) { UI.alertBox(e.message, { title: 'שגיאה' }); return null; } }
  function newUserForm() {
    const name = h('input', { placeholder: 'שם העובד' });
    const em = h('input', { type: 'email', dir: 'ltr', placeholder: 'אימייל (ישמש לכניסה)' });
    const pw = h('input', { dir: 'ltr', value: genPass() });
    return h('div', { class: 'form new-user' }, h('h3', {}, 'הוספת עובד'), name, em, h('label', {}, 'סיסמה (אפשר לשנות)'), pw,
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await run(() => callFn('admin-users', { action: 'create', name: name.value, email: em.value, password: pw.value }));
        if (r) { await UI.alertBox(`העובד נוצר.\nאימייל: ${em.value}\nסיסמה: ${pw.value}\n\nמסרו לו אותם. מומלץ לשמור את הסיסמה כעת, היא לא תוצג שוב.`, { title: 'נוצר' }); load(); }
      } }, icon('plus', 18), 'צור עובד'));
  }
  async function resetPass(u) {
    const v = await UI.promptBox({ title: 'סיסמה חדשה ל-' + u.email, value: genPass(), okText: 'שמור' });
    if (!v) return;
    if (await run(() => callFn('admin-users', { action: 'reset', userId: u.id, password: v }))) UI.alertBox('הסיסמה עודכנה: ' + v, { title: 'בוצע' });
  }
  load();
  return m.promise;
}

// ---------- הרשאות לתיקייה/תוכנית (מנהל) ----------
const LEVELS = [['', 'ללא גישה'], ['view', 'צפייה בלבד'], ['mark', 'צפייה + סימונים'], ['edit', 'עריכה מלאה']];
export async function grantsDialog({ folderId = null, planId = null }) {
  const sb = client();
  const target = planId ? S.P.plans.get(planId)?.name : S.P.folders.get(folderId)?.name;
  const col = planId ? 'plan_id' : 'folder_id', tid = planId || folderId;
  const body = h('div', { class: 'form' }, h('p', { class: 'hint' }, planId ? 'ההרשאה חלה על התוכנית הזו.' : 'ההרשאה חלה על התיקייה ועל כל מה שבתוכה.'));
  const m = UI.openModal({ title: `הרשאות: ${target || ''}`, body, wide: true, buttons: [{ text: 'סגור', value: true }] });
  const [{ data: users, error: e1 }, { data: grants, error: e2 }] = await Promise.all([
    sb.from('profiles').select('*').eq('role', 'worker').order('display_name'),
    sb.from('grants').select('*').eq(col, tid),
  ]);
  if (e1 || e2) { body.append(h('p', { class: 'msg' }, 'שגיאה: ' + (e1 || e2).message)); return m.promise; }
  if (!users.length) body.append(h('p', { class: 'msg' }, 'עוד אין עובדים. צרו עובד דרך "עובדים" בתפריט הצד.'));
  for (const u of users) {
    const cur = grants.find((g) => g.user_id === u.id);
    const sel = h('select', {}, LEVELS.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = cur?.level || '';
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        const existing = grants.find((g) => g.user_id === u.id);
        if (!sel.value) {
          if (existing) { const { error } = await sb.from('grants').delete().eq('id', existing.id); if (error) throw error; grants.splice(grants.indexOf(existing), 1); }
        } else if (existing) {
          const { error } = await sb.from('grants').update({ level: sel.value }).eq('id', existing.id); if (error) throw error; existing.level = sel.value;
        } else {
          const { data, error } = await sb.from('grants').insert({ user_id: u.id, [col]: tid, level: sel.value }).select().single(); if (error) throw error; grants.push(data);
        }
        UI.toast('נשמר');
      } catch (e) { UI.toast('שגיאה: ' + e.message, { type: 'error' }); sel.value = grants.find((g) => g.user_id === u.id)?.level || ''; }
      sel.disabled = false;
    });
    body.append(h('div', { class: 'grant-row' }, h('div', {}, h('b', {}, u.display_name || u.email), h('small', { dir: 'ltr' }, u.email)), sel));
  }
  return m.promise;
}

// ---------- העתקת נתונים מקומיים קיימים לענן (פעם אחת) ----------
export async function maybeImportLocal() {
  if (!isAdmin() || db.dbName() === 'planapp') return;
  const asked = await db.get('meta', 'importAsked');
  if (asked || S.P.plans.size) return;
  const sum = await localDataSummary();
  await db.put('meta', { key: 'importAsked', v: 1 });
  if (!sum) return;
  const ok = await UI.confirmBox(`נמצאו ${sum.plans} תוכניות בשמירה המקומית של המכשיר הזה (לפני החיבור לענן). להעתיק אותן לענן? הן יישארו גם במצב המקומי.`, { title: 'העלאת התוכניות הקיימות לענן', okText: 'העתק לענן', cancelText: 'לא עכשיו' });
  if (!ok) return;
  const pb = UI.progressBox('מעתיק…');
  try { await copyLocalIntoCurrent((n) => pb.set('מעתיק: ' + n)); await S.reload(); UI.toast('הועתק. ההעלאה ל-Drive תתבצע ברקע.', { ms: 5000 }); }
  catch (e) { UI.alertBox('ההעתקה נכשלה: ' + (e.message || e), { title: 'שגיאה' }); }
  finally { pb.close(); }
}
