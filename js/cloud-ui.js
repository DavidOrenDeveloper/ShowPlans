// ממשק הענן: מסך כניסה, תיבת חשבון בתפריט הצד, ניהול עובדים והרשאות (מנהל בלבד).
import { h, icon } from './util.js';
import * as UI from './ui.js';
import * as diag from './diag.js';
import * as S from './store.js';
import * as db from './db.js';
import { cloud, client, isCloud, isAdmin, signIn, signOut, chooseLocal, requestPasswordReset, setNewPassword, callFn, localDataSummary, copyLocalIntoCurrent, switchToLogin } from './cloud.js';
import { syncStatus, onSyncStatus, syncNow, onProgress, schedulePull } from './cloud-sync.js';

// ---------- מסך כניסה ----------
// שדה סיסמה עם עין להצגה/הסתרה
export function passField(ph, ac) {
  const input = h('input', { type: 'password', autocomplete: ac, dir: 'ltr', placeholder: ph, required: true });
  const btn = h('button', { type: 'button', class: 'pw-eye', 'aria-label': 'הצג/הסתר סיסמה', onclick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.replaceChildren(icon(show ? 'eyeOff' : 'eye', 20));
  } }, icon('eye', 20));
  return { input, el: h('div', { class: 'pw-wrap' }, input, btn) };
}

export function loginScreen() {
  return new Promise((resolve) => {
    document.getElementById('boot')?.remove();
    const email = h('input', { type: 'email', autocomplete: 'username', dir: 'ltr', placeholder: 'אימייל', required: true, inputMode: 'email' });
    const pf = passField('סיסמה', 'current-password'); const pass = pf.input;
    try { const e0 = localStorage.getItem('plans.cloud.email'); if (e0) email.value = e0; } catch { /* ignore */ }
    const err = h('div', { class: 'login-err', role: 'alert' });
    if (cloud.linkError) err.textContent = cloud.linkError;
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'כניסה');
    const forgot = h('button', { class: 'btn ghost block', type: 'button', onclick: async () => {
      if (!email.value.trim()) { err.textContent = 'כתבו קודם את האימייל בשדה למעלה, ואז לחצו שוב על "שכחתי סיסמה".'; email.focus(); return; }
      forgot.disabled = true;
      try { await requestPasswordReset(email.value); err.style.color = '#2e7d32'; err.textContent = 'נשלח מייל עם קישור לבחירת סיסמה חדשה. בדקו גם בספאם. פתחו את הקישור באותו דפדפן/מכשיר.'; }
      catch (ex) { err.style.color = ''; err.textContent = ex.message; }
      setTimeout(() => { forgot.disabled = false; }, 4000);
    } }, 'שכחתי סיסמה');
    const form = h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault(); err.style.color = ''; err.textContent = ''; btn.disabled = true; btn.textContent = 'נכנס…';
      try { await signIn(email.value, pass.value); box.remove(); resolve('cloud'); }
      catch (ex) { err.textContent = /fetch|network/i.test(ex.message) ? 'אין חיבור לשרת. בדקו אינטרנט ונסו שוב.' : ex.message; btn.disabled = false; btn.textContent = 'כניסה'; }
    } },
    h('div', { class: 'logo big' }, icon('layers', 30)),
    h('h1', {}, 'תוכניות בנייה'),
    h('p', { class: 'hint' }, 'התחברו עם האימייל והסיסמה שקיבלתם מהמנהל'),
    h('label', {}, 'אימייל'), email, h('label', {}, 'סיסמה'), pf.el, err, btn, forgot,
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => { chooseLocal(); box.remove(); resolve('local'); } }, 'המשך בלי חשבון (שמירה מקומית בלבד)'),
    h('div', { class: 'page-credit' }, 'נוצר על ידי דוד אורן'));
    const box = h('div', { class: 'login-screen' }, form);
    document.body.append(box);
    setTimeout(() => email.focus(), 80);
  });
}

// בחירת סיסמה חדשה (אחרי קישור "שכחתי סיסמה", או משינוי סיסמה מתוך החשבון)
export function newPasswordScreen({ inline = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById('boot')?.remove();
    const p1 = passField('סיסמה חדשה', 'new-password'), p2 = passField('סיסמה חדשה שוב', 'new-password');
    const err = h('div', { class: 'login-err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'שמירת סיסמה');
    const form = h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!p1.input.value) { err.textContent = 'כתבו סיסמה.'; return; }
      if (p1.input.value !== p2.input.value) { err.textContent = 'שתי הסיסמאות לא זהות.'; return; }
      btn.disabled = true;
      try { await setNewPassword(p1.input.value); box.remove(); UI.toast('הסיסמה עודכנה'); resolve(true); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    } },
    h('div', { class: 'logo big' }, icon('lock', 30)),
    h('h1', {}, 'בחירת סיסמה חדשה'),
    p1.el, p2.el, err, btn,
    inline ? h('button', { class: 'btn ghost block', type: 'button', onclick: () => { box.remove(); resolve(false); } }, 'ביטול') : null);
    const box = h('div', { class: 'login-screen' }, form);
    document.body.append(box);
    setTimeout(() => p1.input.focus(), 80);
  });
}

// ---------- פס התקדמות העלאה ----------
function fmtEta(sec) {
  if (sec == null) return 'מחשב זמן…';
  if (sec < 5) return 'עוד כמה שניות';
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  if (hh) return `נשארו ${hh} שע׳ ${mm} דק׳`;
  if (mm) return `נשארו ${mm} דק׳ ו-${ss} שנ׳`;
  return `נשארו ${ss} שנ׳`;
}
const fmtMB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB');
let barEl = null;
function paintBar(i) {
  if (!i.on) { barEl?.remove(); barEl = null; document.body.classList.remove('sync-bar-on'); return; }
  if (!barEl) {
    barEl = h('div', { class: 'syncbar', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'sb-top' }, h('b', { class: 'sb-title' }), h('span', { class: 'sb-pct' })),
      h('div', { class: 'sb-track' }, h('div', { class: 'sb-fill' })),
      h('div', { class: 'sb-bot' }, h('span', { class: 'sb-file' }), h('span', { class: 'sb-eta' })));
    document.body.append(barEl); document.body.classList.add('sync-bar-on');
  }
  barEl.classList.toggle('done', !!i.finished);
  barEl.querySelector('.sb-title').textContent = i.finished ? `הסנכרון הסתיים ✓ (${i.total} קבצים)` : `מעלה לענן · ${i.done} מתוך ${i.total} קבצים`;
  barEl.querySelector('.sb-pct').textContent = i.pct + '%';
  barEl.querySelector('.sb-fill').style.width = i.pct + '%';
  barEl.querySelector('.sb-file').textContent = i.finished ? '' : (i.cur || '') ;
  barEl.querySelector('.sb-eta').textContent = i.finished ? '' : `${fmtMB(i.sent)} מתוך ${fmtMB(i.bytes)} · ${fmtEta(i.eta)}`;
}
onProgress(paintBar);

// ---------- תיבת חשבון בתפריט הצד ----------
let statusEl = null;
onSyncStatus((s) => { if (statusEl?.isConnected) paintStatus(s); });
function paintStatus(s = syncStatus()) {
  statusEl.className = 'acct-status ' + s.kind; statusEl.textContent = s.text;
  if (s.kind === 'error') statusEl.append(' ', h('button', { class: 'link-btn', onclick: () => diagDialog() }, 'פרטי התקלה'));
}

// ---------- יומן תקלות ----------
export function diagDialog() {
  const list = h('div', { class: 'diag-list' });
  const top = h('div', { class: 'diag-top' });
  function paint() {
    const s = syncStatus();
    top.replaceChildren(h('b', {}, 'מצב נוכחי: '), s.text);
    const es = diag.entries();
    list.replaceChildren(...(es.length ? es.map((x) => h('div', { class: 'diag-row ' + x.level },
      h('div', { class: 'd-head' }, h('span', { class: 'd-lvl' }, x.level === 'error' ? 'שגיאה' : x.level === 'warn' ? 'אזהרה' : 'מידע'), h('b', {}, diag.label(x.where)), h('small', {}, diag.fmtTime(x.t))),
      h('div', { class: 'd-msg' }, x.msg),
      x.ctx ? h('pre', { class: 'd-ctx', dir: 'ltr' }, Object.entries(x.ctx).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')) : null))
      : [h('p', { class: 'hint' }, 'היומן ריק. כשתהיה תקלה היא תופיע כאן עם השלב המדויק.')]));
  }
  paint();
  const off = diag.onDiag(paint);
  const m = UI.openModal({ title: 'יומן תקלות', wide: true, body: h('div', {}, top, list), buttons: [
    { text: 'העתק דוח', kind: 'primary', keepOpen: true, onClick: async () => {
      const txt = await diag.report({ סטטוס: syncStatus().text });
      try { await navigator.clipboard.writeText(txt); UI.toast('הדוח הועתק. אפשר להדביק אותו בשיחה'); }
      catch { const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = txt; document.body.append(ta); ta.select(); try { document.execCommand('copy'); UI.toast('הדוח הועתק'); } catch { UI.alertBox(txt, { title: 'דוח תקלות' }); } ta.remove(); }
    } },
    { text: 'הורד כקובץ', keepOpen: true, onClick: async () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([await diag.report({ סטטוס: syncStatus().text })], { type: 'text/plain' })), download: 'showplans-diag.txt' });
      document.body.append(a); a.click(); a.remove();
    } },
    { text: 'נקה יומן', keepOpen: true, onClick: () => { diag.clear(); } },
    { text: 'סגור', value: true },
  ] });
  m.promise.then(off);
  return m;
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
      h('button', { class: 'btn ghost sm', onclick: () => diagDialog() }, icon('alert', 16), 'יומן תקלות'),
      h('button', { class: 'btn ghost sm', onclick: () => newPasswordScreen({ inline: true }) }, icon('lock', 16), 'שינוי סיסמה'),
      isAdmin() ? h('button', { class: 'btn ghost sm', onclick: () => usersDialog() }, icon('users', 16), 'עובדים') : null,
      isAdmin() ? h('button', { class: 'btn ghost sm', onclick: () => driveFilesDialog() }, icon('drive', 16), 'קבצי Drive') : null,
      h('button', { class: 'btn ghost sm', onclick: async () => { if (await UI.confirmBox('להתנתק? נתוני העבודה נשארים שמורים במכשיר ויסונכרנו בכניסה הבאה.', { title: 'התנתקות', okText: 'התנתק' })) signOut(); } }, icon('logout', 16), 'התנתק')));
}

// ---------- ניהול קבצי Drive (מנהל בלבד) ----------
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
export async function driveFilesDialog() {
  if (!isAdmin()) return;
  const list = h('div', { class: 'dfiles' });
  const info = h('div', { class: 'dfiles-info' }, 'טוען…');
  let files = [];
  const sel = new Set();
  const delBtn = h('button', { class: 'btn danger sm', disabled: true }, icon('trash', 16), 'מחק נבחרים');
  const orphanBtn = h('button', { class: 'btn ghost sm' }, 'סמן את כל הלא-בשימוש');
  const clearBtn = h('button', { class: 'btn ghost sm' }, 'נקה בחירה');
  function paint() {
    const orphans = files.filter((f) => !f.versionId);
    const total = files.reduce((a, f) => a + f.size, 0);
    info.textContent = `${files.length} קבצים ב-Drive (${fmtSize(total)}). ${orphans.length} מהם לא בשימוש (${fmtSize(orphans.reduce((a, f) => a + f.size, 0))}).`;
    delBtn.disabled = !sel.size; delBtn.lastChild.textContent = sel.size ? `מחק נבחרים (${sel.size})` : 'מחק נבחרים';
    list.replaceChildren(...(files.length ? files : []).map((f) => {
      const cb = h('input', { type: 'checkbox', checked: sel.has(f.id), onchange: (e) => { e.target.checked ? sel.add(f.id) : sel.delete(f.id); paint(); } });
      return h('label', { class: 'dfile ' + (f.versionId ? 'used' : 'orphan') },
        cb,
        h('div', { class: 'df-main' },
          h('b', { dir: 'auto' }, f.name || f.id),
          h('small', {}, `${fmtSize(f.size)}${f.created ? ' · ' + new Date(f.created).toLocaleDateString('he-IL') : ''}`)),
        f.versionId ? h('span', { class: 'df-badge used' }, 'בשימוש' + (f.planName ? ': ' + f.planName : '')) : h('span', { class: 'df-badge orphan' }, 'לא בשימוש'));
    }));
    if (!files.length) list.replaceChildren(h('p', { class: 'hint' }, 'אין קבצים בתיקיית האפליקציה ב-Drive.'));
  }
  async function load() {
    info.textContent = 'טוען רשימת קבצים מ-Drive…';
    try {
      const r = await callFn('drive-admin', { action: 'list' });
      files = (r.files || []).sort((a, b) => (!a.versionId) === (!b.versionId) ? String(b.created || '').localeCompare(String(a.created || '')) : (a.versionId ? 1 : -1));
      for (const id of [...sel]) if (!files.some((f) => f.id === id)) sel.delete(id);
      paint();
    } catch (e) { info.textContent = 'שגיאה בטעינה: ' + e.message; diag.err('drive-admin', e); }
  }
  orphanBtn.onclick = () => { files.filter((f) => !f.versionId).forEach((f) => sel.add(f.id)); paint(); };
  clearBtn.onclick = () => { sel.clear(); paint(); };
  delBtn.onclick = async () => {
    const chosen = files.filter((f) => sel.has(f.id));
    const used = chosen.filter((f) => f.versionId);
    const msg = `להעביר ${chosen.length} קבצים (${fmtSize(chosen.reduce((a, f) => a + f.size, 0))}) לפח של Drive?`
      + (used.length ? `\n\nשים לב: ${used.length} מהם בשימוש. הגרסאות שלהן יימחקו מהאפליקציה בכל המכשירים, והסימונים והמדידות של אותן גרסאות לא יהיו נגישים.` : '')
      + '\n\nבפח של Drive אפשר לשחזר קבצים במשך כ-30 יום.';
    if (!(await UI.confirmBox(msg, { title: 'מחיקת קבצים מ-Drive', danger: true, okText: 'מחק' }))) return;
    delBtn.disabled = true;
    let ok = 0; const failed = [];
    const ids = chosen.map((f) => f.id);
    for (let i = 0; i < ids.length; i += 25) {
      info.textContent = `מוחק… ${Math.min(i + 25, ids.length)} מתוך ${ids.length}`;
      try {
        const r = await callFn('drive-admin', { action: 'delete', fileIds: ids.slice(i, i + 25) });
        for (const x of r.results || []) { if (x.ok) { ok++; sel.delete(x.id); } else failed.push(x); }
      } catch (e) { ids.slice(i, i + 25).forEach((id) => failed.push({ id, error: e.message })); diag.err('drive-admin', e); }
    }
    failed.forEach((x) => diag.warn('drive-admin', 'מחיקת קובץ נכשלה: ' + x.error, { id: x.id, file: files.find((f) => f.id === x.id)?.name }));
    UI.toast(failed.length ? `נמחקו ${ok}, נכשלו ${failed.length} (פרטים ביומן התקלות)` : `נמחקו ${ok} קבצים`, { type: failed.length ? 'error' : '', ms: 5000 });
    await load();
    schedulePull(true, 300); // מעדכן את המכשיר אחרי מחיקת גרסאות בשימוש
  };
  const m = UI.openModal({ title: 'קבצי Drive', wide: true, body: h('div', {}, info,
    h('div', { class: 'dfiles-btns' }, orphanBtn, clearBtn, delBtn), list), buttons: [{ text: 'סגור', value: true }] });
  load();
  return m;
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
