// ממשק הענן: מסך כניסה, תיבת חשבון בתפריט הצד, ניהול עובדים והרשאות (מנהל בלבד).
import { t as tr, LOCALE, CHEV_FWD, toggleLang, langButtonLabel } from './i18n.js';
import { dn } from './names.js';
import { h, icon } from './util.js';
import * as UI from './ui.js';
import { previewPlan } from './plan-preview.js';
import * as diag from './diag.js';
import * as S from './store.js';
import * as db from './db.js';
import { folderLevelFrom, planLevelFrom, cloud, client, isCloud, isAdmin, signIn, signOut, chooseLocal, requestPasswordReset, setNewPassword, callFn, localDataSummary, copyLocalIntoCurrent, switchToLogin } from './cloud.js';
import { syncStatus, onSyncStatus, syncNow, onProgress, schedulePull } from './cloud-sync.js';

// ---------- מסך כניסה ----------
// שדה סיסמה עם עין להצגה/הסתרה
export function passField(ph, ac) {
  const input = h('input', { type: 'password', autocomplete: ac, dir: 'ltr', placeholder: ph, required: true });
  const btn = h('button', { type: 'button', class: 'pw-eye', 'aria-label': tr('הצג/הסתר סיסמה'), onclick: () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.replaceChildren(icon(show ? 'eyeOff' : 'eye', 20));
  } }, icon('eye', 20));
  return { input, el: h('div', { class: 'pw-wrap' }, input, btn) };
}

export function loginScreen() {
  return new Promise((resolve) => {
    document.getElementById('boot')?.remove();
    const email = h('input', { type: 'email', autocomplete: 'username', dir: 'ltr', placeholder: tr('אימייל'), required: true, inputMode: 'email' });
    const pf = passField(tr('סיסמה'), 'current-password'); const pass = pf.input;
    try { const e0 = localStorage.getItem('plans.cloud.email'); if (e0) email.value = e0; } catch { /* ignore */ }
    const err = h('div', { class: 'login-err', role: 'alert' });
    if (cloud.linkError) err.textContent = cloud.linkError;
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, tr('כניסה'));
    const forgot = h('button', { class: 'btn ghost block', type: 'button', onclick: async () => {
      if (!email.value.trim()) { err.textContent = tr('כתבו קודם את האימייל בשדה למעלה, ואז לחצו שוב על "שכחתי סיסמה".'); email.focus(); return; }
      forgot.disabled = true;
      try { await requestPasswordReset(email.value); err.style.color = '#2e7d32'; err.textContent = tr('נשלח מייל עם קישור לבחירת סיסמה חדשה. בדקו גם בספאם. פתחו את הקישור באותו דפדפן/מכשיר.'); }
      catch (ex) { err.style.color = ''; err.textContent = ex.message; }
      setTimeout(() => { forgot.disabled = false; }, 4000);
    } }, tr('שכחתי סיסמה'));
    const form = h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault(); err.style.color = ''; err.textContent = ''; btn.disabled = true; btn.textContent = tr('נכנס…');
      try { await signIn(email.value, pass.value); box.remove(); resolve('cloud'); }
      catch (ex) { err.textContent = /fetch|network/i.test(ex.message) ? tr('אין חיבור לשרת. בדקו אינטרנט ונסו שוב.') : ex.message; btn.disabled = false; btn.textContent = tr('כניסה'); }
    } },
    h('button', { class: 'btn sm lang-login', type: 'button', onclick: toggleLang }, icon('globe', 16), langButtonLabel()),
    h('div', { class: 'logo big' }, icon('layers', 30)),
    h('h1', {}, tr('תוכניות בנייה')),
    h('p', { class: 'hint' }, tr('התחברו עם האימייל והסיסמה שקיבלתם מהמנהל')),
    h('label', {}, tr('אימייל')), email, h('label', {}, tr('סיסמה')), pf.el, err, btn, forgot,
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => { chooseLocal(); box.remove(); resolve('local'); } }, tr('המשך בלי חשבון (שמירה מקומית בלבד)')),
    h('div', { class: 'page-credit' }, tr('נוצר על ידי דוד אורן')));
    const box = h('div', { class: 'login-screen' }, form);
    document.body.append(box);
    setTimeout(() => email.focus(), 80);
  });
}

// בחירת סיסמה חדשה (אחרי קישור "שכחתי סיסמה", או משינוי סיסמה מתוך החשבון)
export function newPasswordScreen({ inline = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById('boot')?.remove();
    const p1 = passField(tr('סיסמה חדשה'), 'new-password'), p2 = passField(tr('סיסמה חדשה שוב'), 'new-password');
    const err = h('div', { class: 'login-err', role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'submit' }, tr('שמירת סיסמה'));
    const form = h('form', { class: 'login-card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!p1.input.value) { err.textContent = tr('כתבו סיסמה.'); return; }
      if (p1.input.value !== p2.input.value) { err.textContent = tr('שתי הסיסמאות לא זהות.'); return; }
      btn.disabled = true;
      try { await setNewPassword(p1.input.value); box.remove(); UI.toast(tr('הסיסמה עודכנה')); resolve(true); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    } },
    h('div', { class: 'logo big' }, icon('lock', 30)),
    h('h1', {}, tr('בחירת סיסמה חדשה')),
    p1.el, p2.el, err, btn,
    inline ? h('button', { class: 'btn ghost block', type: 'button', onclick: () => { box.remove(); resolve(false); } }, tr('ביטול')) : null);
    const box = h('div', { class: 'login-screen' }, form);
    document.body.append(box);
    setTimeout(() => p1.input.focus(), 80);
  });
}

// ---------- פס התקדמות העלאה ----------
function fmtEta(sec) {
  if (sec == null) return tr('מחשב זמן…');
  if (sec < 5) return tr('עוד כמה שניות');
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  if (hh) return tr('נשארו {0} שע׳ {1} דק׳', hh, mm);
  if (mm) return tr('נשארו {0} דק׳ ו-{1} שנ׳', mm, ss);
  return tr('נשארו {0} שנ׳', ss);
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
  barEl.querySelector('.sb-title').textContent = i.finished ? tr('הסנכרון הסתיים ✓ ({0} קבצים)', i.total) : tr('מעלה לענן · {0} מתוך {1} קבצים', i.done, i.total);
  barEl.querySelector('.sb-pct').textContent = i.pct + '%';
  barEl.querySelector('.sb-fill').style.width = i.pct + '%';
  barEl.querySelector('.sb-file').textContent = i.finished ? '' : (i.cur || '') ;
  barEl.querySelector('.sb-eta').textContent = i.finished ? '' : tr('{0} מתוך {1} · {2}', fmtMB(i.sent), fmtMB(i.bytes), fmtEta(i.eta));
}
onProgress(paintBar);

// ---------- תיבת חשבון בתפריט הצד ----------
let statusEl = null;
onSyncStatus((s) => { if (statusEl?.isConnected) paintStatus(s); });
function paintStatus(s = syncStatus()) {
  statusEl.className = 'acct-status ' + s.kind; statusEl.textContent = s.text;
  if (s.kind === 'error') statusEl.append(' ', h('button', { class: 'link-btn', onclick: () => diagDialog() }, tr('פרטי התקלה')));
}

// ---------- יומן תקלות ----------
export function diagDialog() {
  const list = h('div', { class: 'diag-list' });
  const top = h('div', { class: 'diag-top' });
  function paint() {
    const s = syncStatus();
    top.replaceChildren(h('b', {}, tr('מצב נוכחי: ')), s.text);
    const es = diag.entries();
    list.replaceChildren(...(es.length ? es.map((x) => h('div', { class: 'diag-row ' + x.level },
      h('div', { class: 'd-head' }, h('span', { class: 'd-lvl' }, x.level === 'error' ? tr('שגיאה') : x.level === 'warn' ? tr('אזהרה') : tr('מידע')), h('b', {}, diag.label(x.where)), h('small', {}, diag.fmtTime(x.t))),
      h('div', { class: 'd-msg' }, x.msg),
      x.ctx ? h('pre', { class: 'd-ctx', dir: 'ltr' }, Object.entries(x.ctx).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')) : null))
      : [h('p', { class: 'hint' }, tr('היומן ריק. כשתהיה תקלה היא תופיע כאן עם השלב המדויק.'))]));
  }
  paint();
  const off = diag.onDiag(paint);
  const m = UI.openModal({ title: tr('יומן תקלות'), wide: true, body: h('div', {}, top, list), buttons: [
    { text: tr('העתק דוח'), kind: 'primary', keepOpen: true, onClick: async () => {
      const txt = await diag.report({ סטטוס: syncStatus().text });
      try { await navigator.clipboard.writeText(txt); UI.toast(tr('הדוח הועתק. אפשר להדביק אותו בשיחה')); }
      catch { const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = txt; document.body.append(ta); ta.select(); try { document.execCommand('copy'); UI.toast(tr('הדוח הועתק')); } catch { UI.alertBox(txt, { title: tr('דוח תקלות') }); } ta.remove(); }
    } },
    { text: tr('הורד כקובץ'), keepOpen: true, onClick: async () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([await diag.report({ סטטוס: syncStatus().text })], { type: 'text/plain' })), download: 'showplans-diag.txt' });
      document.body.append(a); a.click(); a.remove();
    } },
    { text: tr('נקה יומן'), keepOpen: true, onClick: () => { diag.clear(); } },
    { text: tr('סגור'), value: true },
  ] });
  m.promise.then(off);
  return m;
}
export function accountBox() {
  if (!isCloud()) {
    return h('div', { class: 'acct' },
      h('div', { class: 'acct-line' }, icon('cloud', 16), h('span', {}, tr('מצב מקומי – ללא סנכרון'))),
      h('button', { class: 'btn ghost block', onclick: () => switchToLogin() }, icon('user', 18), tr('התחברות לענן')));
  }
  const p = cloud.profile;
  statusEl = h('div', { class: 'acct-status' }); paintStatus();
  return h('div', { class: 'acct' },
    h('div', { class: 'acct-line' }, icon('user', 16), h('b', {}, p.display_name || p.email), h('span', { class: 'role-badge' }, p.role === 'admin' ? tr('מנהל') : tr('עובד'))),
    statusEl,
    h('div', { class: 'acct-btns' },
      h('button', { class: 'btn ghost sm', onclick: async () => { await syncNow(); UI.toast(tr('הסנכרון הסתיים')); } }, icon('refresh', 16), tr('סנכרן')),
      h('button', { class: 'btn ghost sm', onclick: () => diagDialog() }, icon('alert', 16), tr('יומן תקלות')),
      h('button', { class: 'btn ghost sm', onclick: () => newPasswordScreen({ inline: true }) }, icon('lock', 16), tr('שינוי סיסמה')),
      isAdmin() ? h('button', { class: 'btn ghost sm', onclick: () => usersDialog() }, icon('users', 16), tr('עובדים')) : null,
      isAdmin() ? h('button', { class: 'btn ghost sm', onclick: () => workerAccessDialog() }, icon('lock', 16), tr('גישה לפי עובד')) : null,
      isAdmin() ? h('button', { class: 'btn ghost sm', onclick: () => driveFilesDialog() }, icon('drive', 16), tr('קבצי Drive')) : null,
      h('button', { class: 'btn ghost sm', onclick: async () => { if (await UI.confirmBox(tr('להתנתק? נתוני העבודה נשארים שמורים במכשיר ויסונכרנו בכניסה הבאה.'), { title: tr('התנתקות'), okText: tr('התנתק') })) signOut(); } }, icon('logout', 16), tr('התנתק'))));
}

// ---------- ניהול קבצי Drive (מנהל בלבד) ----------
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
export async function driveFilesDialog() {
  if (!isAdmin()) return;
  const list = h('div', { class: 'dfiles' });
  const info = h('div', { class: 'dfiles-info' }, tr('טוען…'));
  let files = [];
  const sel = new Set();
  const delBtn = h('button', { class: 'btn danger sm', disabled: true }, icon('trash', 16), tr('מחק נבחרים'));
  const orphanBtn = h('button', { class: 'btn ghost sm' }, tr('סמן את כל הלא-בשימוש'));
  const clearBtn = h('button', { class: 'btn ghost sm' }, tr('נקה בחירה'));
  function paint() {
    const orphans = files.filter((f) => !f.versionId);
    const total = files.reduce((a, f) => a + f.size, 0);
    info.textContent = tr('{0} קבצים ב-Drive ({1}). {2} מהם לא בשימוש ({3}).', files.length, fmtSize(total), orphans.length, fmtSize(orphans.reduce((a, f) => a + f.size, 0)));
    delBtn.disabled = !sel.size; delBtn.lastChild.textContent = sel.size ? tr('מחק נבחרים ({0})', sel.size) : tr('מחק נבחרים');
    list.replaceChildren(...(files.length ? files : []).map((f) => {
      const cb = h('input', { type: 'checkbox', checked: sel.has(f.id), onchange: (e) => { e.target.checked ? sel.add(f.id) : sel.delete(f.id); paint(); } });
      return h('label', { class: 'dfile ' + (f.versionId ? 'used' : 'orphan') },
        cb,
        h('div', { class: 'df-main' },
          h('b', { dir: 'auto' }, f.name || f.id),
          h('small', {}, `${fmtSize(f.size)}${f.created ? ' · ' + new Date(f.created).toLocaleDateString(LOCALE) : ''}`)),
        f.versionId ? h('span', { class: 'df-badge used' }, tr('בשימוש') + (f.planName ? ': ' + f.planName : '')) : h('span', { class: 'df-badge orphan' }, tr('לא בשימוש')));
    }));
    if (!files.length) list.replaceChildren(h('p', { class: 'hint' }, tr('אין קבצים בתיקיית האפליקציה ב-Drive.')));
  }
  async function load() {
    info.textContent = tr('טוען רשימת קבצים מ-Drive…');
    try {
      const r = await callFn('drive-admin', { action: 'list' });
      files = (r.files || []).sort((a, b) => (!a.versionId) === (!b.versionId) ? String(b.created || '').localeCompare(String(a.created || '')) : (a.versionId ? 1 : -1));
      for (const id of [...sel]) if (!files.some((f) => f.id === id)) sel.delete(id);
      paint();
    } catch (e) { info.textContent = tr('שגיאה בטעינה: ') + e.message; diag.err('drive-admin', e); }
  }
  orphanBtn.onclick = () => { files.filter((f) => !f.versionId).forEach((f) => sel.add(f.id)); paint(); };
  clearBtn.onclick = () => { sel.clear(); paint(); };
  delBtn.onclick = async () => {
    const chosen = files.filter((f) => sel.has(f.id));
    const used = chosen.filter((f) => f.versionId);
    const msg = tr('להעביר {0} קבצים ({1}) לפח של Drive?', chosen.length, fmtSize(chosen.reduce((a, f) => a + f.size, 0)))
      + (used.length ? tr('\n\nשים לב: {0} מהם בשימוש. הגרסאות שלהן יימחקו מהאפליקציה בכל המכשירים, והסימונים והמדידות של אותן גרסאות לא יהיו נגישים.', used.length) : '')
      + tr('\n\nבפח של Drive אפשר לשחזר קבצים במשך כ-30 יום.');
    if (!(await UI.confirmBox(msg, { title: tr('מחיקת קבצים מ-Drive'), danger: true, okText: tr('מחק') }))) return;
    delBtn.disabled = true;
    let ok = 0; const failed = [];
    const ids = chosen.map((f) => f.id);
    for (let i = 0; i < ids.length; i += 25) {
      info.textContent = tr('מוחק… {0} מתוך {1}', Math.min(i + 25, ids.length), ids.length);
      try {
        const r = await callFn('drive-admin', { action: 'delete', fileIds: ids.slice(i, i + 25) });
        for (const x of r.results || []) { if (x.ok) { ok++; sel.delete(x.id); } else failed.push(x); }
      } catch (e) { ids.slice(i, i + 25).forEach((id) => failed.push({ id, error: e.message })); diag.err('drive-admin', e); }
    }
    failed.forEach((x) => diag.warn('drive-admin', tr('מחיקת קובץ נכשלה: ') + x.error, { id: x.id, file: files.find((f) => f.id === x.id)?.name }));
    UI.toast(failed.length ? tr('נמחקו {0}, נכשלו {1} (פרטים ביומן התקלות)', ok, failed.length) : tr('נמחקו {0} קבצים', ok), { type: failed.length ? 'error' : '', ms: 5000 });
    await load();
    schedulePull(true, 300); // מעדכן את המכשיר אחרי מחיקת גרסאות בשימוש
  };
  const m = UI.openModal({ title: tr('קבצי Drive'), wide: true, body: h('div', {}, info,
    h('div', { class: 'dfiles-btns' }, orphanBtn, clearBtn, delBtn), list), buttons: [{ text: tr('סגור'), value: true }] });
  load();
  return m;
}

// ---------- ניהול עובדים (מנהל) ----------
const genPass = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.getRandomValues(new Uint32Array(10)); r.forEach((x) => { s += c[x % c.length]; }); return s; };
export async function usersDialog() {
  const list = h('div', { class: 'users' });
  const m = UI.openModal({ title: tr('ניהול עובדים'), wide: true, body: h('div', {}, list), buttons: [{ text: tr('סגור'), value: true }] });
  async function load() {
    list.replaceChildren(h('p', { class: 'hint' }, tr('טוען…')));
    const { data, error } = await client().from('profiles').select('*').order('created_at');
    if (error) { list.replaceChildren(h('p', { class: 'msg' }, tr('שגיאה: ') + error.message)); return; }
    list.replaceChildren(
      ...data.map((u) => h('div', { class: 'user-row' },
        h('div', { class: 'u-main' }, h('b', {}, u.display_name || u.email), h('small', { dir: 'ltr' }, u.email), h('span', { class: 'role-badge' }, u.role === 'admin' ? tr('מנהל') : tr('עובד'))),
        u.id === cloud.user.id ? h('small', {}, tr('אתה')) : h('div', { class: 'u-btns' },
          u.role === 'admin' ? null : h('button', { class: 'btn sm', onclick: () => workerAccessDialog(u.id) }, tr('גישה לתוכניות')),
          h('button', { class: 'btn sm', onclick: () => resetPass(u) }, tr('סיסמה חדשה')),
          h('button', { class: 'btn sm', onclick: () => exportData(u) }, tr('ייצוא מידע')),
          h('button', { class: 'btn sm danger', onclick: () => eraseData(u) }, tr('מחק מידע')),
          h('button', { class: 'btn sm', onclick: async () => { const r = u.role === 'admin' ? 'worker' : 'admin'; if (await UI.confirmBox(r === 'admin' ? tr('להפוך את {0} למנהל? הוא יראה ויערוך הכול.', u.email) : tr('להפוך את {0} לעובד?', u.email))) { await run(() => callFn('admin-users', { action: 'setRole', userId: u.id, role: r })); load(); } } }, u.role === 'admin' ? tr('הפוך לעובד') : tr('הפוך למנהל')),
          h('button', { class: 'btn sm danger', onclick: async () => { if (await UI.confirmBox(tr('למחוק את המשתמש {0}? הסימונים שלו יישארו.', u.email), { danger: true, okText: tr('מחק') })) { await run(() => callFn('admin-users', { action: 'delete', userId: u.id })); load(); } } }, tr('מחק'))))),
      newUserForm());
  }
  async function run(fn) { try { return await fn(); } catch (e) { UI.alertBox(e.message, { title: tr('שגיאה') }); return null; } }
  function newUserForm() {
    const name = h('input', { placeholder: tr('שם העובד') });
    const em = h('input', { type: 'email', dir: 'ltr', placeholder: tr('אימייל (ישמש לכניסה)') });
    const pw = h('input', { dir: 'ltr', value: genPass() });
    return h('div', { class: 'form new-user' }, h('h3', {}, tr('הוספת עובד')), name, em, h('label', {}, tr('סיסמה (אפשר לשנות)')), pw,
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await run(() => callFn('admin-users', { action: 'create', name: name.value, email: em.value, password: pw.value }));
        if (r) { await UI.alertBox(tr('העובד נוצר.\nאימייל: {0}\nסיסמה: {1}\n\nמסרו לו אותם. מומלץ לשמור את הסיסמה כעת, היא לא תוצג שוב.', em.value, pw.value), { title: tr('נוצר') }); load(); }
      } }, icon('plus', 18), tr('צור עובד')));
  }
  // מימוש זכות עיון: קובץ JSON עם כל המידע שנשמר על המשתמש
  async function exportData(u) {
    const r = await run(async () => { const { data, error } = await client().rpc('export_user_data', { p_user: u.id }); if (error) throw error; return data; });
    if (!r) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    a.download = tr('מידע-{0}.json', (u.email || u.id).replace(/[^\w.@-]+/g, '_'));
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  // מימוש זכות מחיקה: הסימונים, השכבה האישית והאישורים של המשתמש (לא מוחק את החשבון)
  async function eraseData(u) {
    if (!(await UI.confirmBox(tr('למחוק את כל הסימונים, המדידות והשכבה האישית של {0}? החשבון עצמו נשאר (למחיקת החשבון: כפתור "מחק"). אי אפשר לבטל.', u.email), { title: tr('מחיקת מידע'), danger: true, okText: tr('מחק מידע') }))) return;
    const r = await run(async () => { const { data, error } = await client().rpc('erase_user_data', { p_user: u.id }); if (error) throw error; return data; });
    if (r) UI.toast(tr('נמחקו {0} סימונים/מדידות ו-{1} פריטים אישיים', r.items, r.overrides));
  }
  async function resetPass(u) {
    const v = await UI.promptBox({ title: tr('סיסמה חדשה ל-') + u.email, value: genPass(), okText: tr('שמור') });
    if (!v) return;
    if (await run(() => callFn('admin-users', { action: 'reset', userId: u.id, password: v }))) UI.alertBox(tr('הסיסמה עודכנה: ') + v, { title: tr('בוצע') });
  }
  load();
  return m.promise;
}

// ---------- הרשאות לתיקייה/תוכנית (מנהל) ----------
const LEVELS = [['', tr('ללא הרשאה ישירה')], ['none', tr('חסום (ללא גישה)')], ['view', tr('צפייה בלבד')], ['mark', tr('צפייה + סימונים')], ['edit', tr('עריכה מלאה')]];
export async function grantsDialog({ folderId = null, planId = null }) {
  const sb = client();
  const plan = planId ? S.P.plans.get(planId) : null;
  const target = plan ? plan.name : S.P.folders.get(folderId)?.name;
  const col = planId ? 'plan_id' : 'folder_id', tid = planId || folderId;
  const body = h('div', { class: 'form' }, h('p', { class: 'hint' }, planId ? tr('ההרשאה חלה על התוכנית הזו.') : tr('ההרשאה חלה על התיקייה ועל כל מה שבתוכה.')));
  const m = UI.openModal({ title: tr('הרשאות: {0}', target || ''), body, wide: true, buttons: [{ text: tr('סגור'), value: true }] });
  // ההרשאות של התיקיות שמעל (וההרשאה על הפריט עצמו) – כדי להראות מה כל עובד מקבל בפועל, כולל ירושה מתיקיית האב
  const chain = [];
  { let f = S.P.folders.get(plan ? plan.folderId : folderId), n = 0; while (f && n++ < 200) { chain.push(f.id); f = f.parentId ? S.P.folders.get(f.parentId) : null; } }
  const [uRes, gF, gP] = await Promise.all([
    sb.from('profiles').select('*').eq('role', 'worker').order('display_name'),
    chain.length ? sb.from('grants').select('*').in('folder_id', chain) : { data: [] },
    plan ? sb.from('grants').select('*').eq('plan_id', planId) : { data: [] },
  ]);
  const err = uRes.error || gF.error || gP.error;
  if (err) { body.append(h('p', { class: 'msg' }, tr('שגיאה: ') + err.message)); return m.promise; }
  const users = uRes.data || [], all = [...(gF.data || []), ...(gP.data || [])];
  if (!users.length) { body.append(h('p', { class: 'msg' }, tr('עוד אין עובדים. צרו עובד דרך "עובדים" בתפריט הצד.'))); return m.promise; }
  const parentId = plan ? plan.folderId || null : S.P.folders.get(folderId)?.parentId || null;
  const ug = (uid) => all.filter((g) => g.user_id === uid);
  const direct = (uid) => all.find((g) => g.user_id === uid && g[col] === tid);
  const eff = (uid) => (plan ? planLevelFrom(ug(uid), plan, S.P.folders) : folderLevelFrom(ug(uid), folderId, S.P.folders));
  const inh = (uid) => folderLevelFrom(ug(uid), parentId, S.P.folders);
  const lvlName = (n) => ['', 'view', 'mark', 'edit'][n] || '';
  const selected = new Set();
  const list = h('div', {}), selBar = h('div', { class: 'wa-sel' });
  body.append(selBar, list);

  async function setGrant(uid, value) {
    const ex = direct(uid);
    if (!value) { if (ex) { const { error } = await sb.from('grants').delete().eq('id', ex.id); if (error) throw error; all.splice(all.indexOf(ex), 1); } }
    else if (ex) { if (ex.level !== value) { const { error } = await sb.from('grants').update({ level: value }).eq('id', ex.id); if (error) throw error; ex.level = value; } }
    else { const { data, error } = await sb.from('grants').insert({ user_id: uid, [col]: tid, level: value }).select().single(); if (error) throw error; all.push(data); }
  }
  const fail = (e) => UI.toast(tr('שגיאה: ') + (/check constraint|grants_level/i.test(e.message || '') ? tr('חסימה דורשת להריץ את קובץ ה-SQL החדש (update-v2.sql) ב-Supabase') : e.message), { type: 'error', ms: 6000 });
  // מה העובד מקבל בפועל (כולל ירושה)
  function status(uid) {
    const d = direct(uid), e = eff(uid);
    if (d?.level === 'none') return tr('חסום לעובד');
    if (!e) return tr('העובד לא רואה');
    return d ? tr('העובד רואה: {0} (נקבע כאן)', LEVEL_TEXT[lvlName(e)]) : tr('העובד רואה: {0} (מתיקיית האב)', LEVEL_TEXT[lvlName(e)]);
  }
  function paint() {
    list.replaceChildren(...users.map((u) => {
      const i = inh(u.id), d = direct(u.id);
      const opts = LEVELS.filter(([v]) => v !== 'none' || i > 0 || d?.level === 'none')
        .map(([v, t]) => h('option', { value: v }, v === '' ? (i > 0 ? tr('לפי התיקייה: {0}', LEVEL_TEXT[lvlName(i)]) : tr('ללא גישה')) : t));
      const sel = h('select', { 'aria-label': tr('רמת גישה') }, opts);
      sel.value = d?.level || '';
      sel.addEventListener('change', async () => {
        sel.disabled = true;
        try { await setGrant(u.id, sel.value); UI.toast(tr('נשמר')); } catch (e) { fail(e); }
        paint();
      });
      const ck = h('input', { type: 'checkbox', class: 'wa-ck', 'aria-label': tr('בחירה'), checked: selected.has(u.id), onchange: (e) => { e.target.checked ? selected.add(u.id) : selected.delete(u.id); paintBar(); } });
      return h('div', { class: 'grant-row' + (selected.has(u.id) ? ' sel' : '') },
        h('div', {}, h('div', { class: 'row' }, ck, h('b', {}, u.display_name || u.email)), h('small', { dir: 'ltr' }, u.email), h('small', {}, status(u.id))), sel);
    }));
    paintBar();
  }
  function paintBar() {
    const n = selected.size;
    const allOn = users.length && users.every((u) => selected.has(u.id));
    const sel = h('select', { 'aria-label': tr('רמת גישה לנבחרים') }, [['', tr('הסר הרשאה ישירה (לפי התיקייה / ללא גישה)')], ['none', tr('חסום (ללא גישה)')], ['view', tr('צפייה בלבד')], ['mark', tr('צפייה + סימונים')], ['edit', tr('עריכה מלאה')]].map(([v, t]) => h('option', { value: v }, t)));
    selBar.replaceChildren(
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!allOn, onchange: (e) => { users.forEach((u) => (e.target.checked ? selected.add(u.id) : selected.delete(u.id))); paint(); } }), tr('בחר את כל העובדים')),
      n ? h('div', { class: 'row wrap' }, h('b', {}, tr('{0} נבחרו', n)), sel,
        h('button', { class: 'btn sm primary', onclick: async () => {
          const ids = [...selected];
          try { for (const id of ids) await setGrant(id, sel.value); UI.toast(tr('עודכנו {0} עובדים', ids.length)); selected.clear(); } catch (e) { fail(e); }
          paint();
        } }, tr('החל על הנבחרים')),
        h('button', { class: 'btn sm', onclick: () => { selected.clear(); paint(); } }, tr('נקה בחירה'))) : null);
  }
  paint();
  return m.promise;
}

// ---------- גישה לפי עובד: מה כל עובד רואה (מנהל) ----------
// עובד לא רואה שום תיקייה או תוכנית עד שנותנים לו הרשאה. הרשאה על תיקייה חלה על כל מה שבתוכה,
// וההרשאה הקרובה ביותר קובעת: אפשר לתת גישה לתיקייה ולחסום ("חסום") תוכנית או תת-תיקייה מסוימת בתוכה.
const LEVEL_TEXT = { view: tr('צפייה'), mark: tr('צפייה + סימונים'), edit: tr('עריכה מלאה') };
export async function workerAccessDialog(userId = null) {
  const sb = client();
  const body = h('div', { class: 'form wa' });
  const m = UI.openModal({ title: tr('גישה לתוכניות לפי עובד'), body, wide: true, buttons: [{ text: tr('סגור'), value: true }] });
  const { data: users, error } = await sb.from('profiles').select('*').eq('role', 'worker').order('display_name');
  if (error) { body.append(h('p', { class: 'msg' }, tr('שגיאה: ') + error.message)); return m.promise; }
  if (!users.length) { body.append(h('p', { class: 'msg' }, tr('עוד אין עובדים. צרו עובד דרך "עובדים" בתפריט הצד.'))); return m.promise; }
  let uid = userId && users.some((u) => u.id === userId) ? userId : users[0].id;
  let grants = [];
  const expanded = new Set(), selected = new Set();
  let filter = '', visibleKeys = [];
  const who = h('select', { 'aria-label': tr('עובד') }, users.map((u) => h('option', { value: u.id }, u.display_name || u.email)));
  who.value = uid;
  const summary = h('p', { class: 'hint' });
  const search = h('input', { type: 'search', placeholder: tr('חיפוש תיקייה או תוכנית…'), 'aria-label': tr('חיפוש') });
  const selBar = h('div', { class: 'wa-sel hidden' });
  const tree = h('div', { class: 'users' });
  body.append(h('p', { class: 'hint' }, tr('בוחרים עובד ואז קובעים לכל תיקייה או תוכנית אם הוא רואה אותה. הרשאה על תיקייה חלה על כל מה שבתוכה, ואפשר לחסום תוכנית ספציפית בתוכה. אפשר לסמן כמה פריטים ולשנות את כולם בבת אחת. לחיצה על שם תוכנית פותחת אותה לצפייה.')),
    h('label', {}, tr('עובד')), who, summary, search, selBar, tree);

  const direct = (col, id) => grants.find((g) => g[col] === id);
  const folderLevel = (fid) => folderLevelFrom(grants, fid, S.P.folders);
  const planLevel = (p) => planLevelFrom(grants, p, S.P.folders);
  const levelName = (n) => ['', 'view', 'mark', 'edit'][n] || '';
  const keyOf = (col, id) => (col === 'folder_id' ? 'f:' : 'p:') + id;

  async function setGrant(col, id, value) {
    const existing = direct(col, id);
    if (!value) { if (existing) { const { error: e } = await sb.from('grants').delete().eq('id', existing.id); if (e) throw e; grants.splice(grants.indexOf(existing), 1); } }
    else if (existing) { if (existing.level !== value) { const { error: e } = await sb.from('grants').update({ level: value }).eq('id', existing.id); if (e) throw e; existing.level = value; } }
    else { const { data, error: e } = await sb.from('grants').insert({ user_id: uid, [col]: id, level: value }).select().single(); if (e) throw e; grants.push(data); }
  }
  function levelSelect(col, id, inherited) {
    const opts = LEVELS.filter(([v]) => v !== 'none' || inherited > 0 || direct(col, id)?.level === 'none')
      .map(([v, t]) => h('option', { value: v }, v === '' ? (inherited > 0 ? tr('לפי התיקייה: {0}', LEVEL_TEXT[levelName(inherited)]) : tr('ללא גישה')) : t));
    const sel = h('select', { 'aria-label': tr('רמת גישה') }, opts);
    sel.value = direct(col, id)?.level || '';
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      try { await setGrant(col, id, sel.value); UI.toast(tr('נשמר')); paint(); }
      catch (e) { UI.toast(tr('שגיאה: ') + (/check constraint|grants_level/i.test(e.message || '') ? tr('חסימה דורשת להריץ את קובץ ה-SQL החדש (update-v2.sql) ב-Supabase') : e.message), { type: 'error', ms: 6000 }); sel.value = direct(col, id)?.level || ''; sel.disabled = false; }
    });
    return sel;
  }
  const matches = (name) => !filter || name.toLowerCase().includes(filter);
  function hasMatch(fid) { // תיקייה מוצגת בחיפוש אם היא או משהו בתוכה תואם
    if (matches(S.P.folders.get(fid)?.name || '')) return true;
    return S.plansIn(fid).some((p) => matches(p.name)) || S.childFolders(fid).some((c) => hasMatch(c.id));
  }
  const status = (eff, dir) => (dir?.level === 'none' ? tr('חסום לעובד') : eff ? tr('העובד רואה: {0}', LEVEL_TEXT[levelName(eff)]) : tr('העובד לא רואה'));
  const check = (key) => h('input', { type: 'checkbox', class: 'wa-ck', 'aria-label': tr('בחירה'), checked: selected.has(key), onchange: (e) => { e.target.checked ? selected.add(key) : selected.delete(key); paintSel(); } });
  function folderRows(parentId, depth, out) {
    for (const f of S.childFolders(parentId)) {
      if (filter && !hasMatch(f.id)) continue;
      const open = filter ? true : expanded.has(f.id);
      const eff = folderLevel(f.id), inh = parentId ? folderLevel(parentId) : 0, key = keyOf('folder_id', f.id);
      visibleKeys.push(key);
      const toggle = h('button', { class: 'icon-btn sm', 'aria-label': open ? tr('סגור') : tr('פתח'), onclick: () => { open ? expanded.delete(f.id) : expanded.add(f.id); paint(); } }, icon(open ? 'chevD' : CHEV_FWD, 16));
      out.push(h('div', { class: 'grant-row' + (selected.has(key) ? ' sel' : ''), style: { marginInlineStart: depth * 16 + 'px' } },
        h('div', {}, h('div', { class: 'row' }, check(key), toggle, icon('folder', 18), h('b', {}, dn(f.name))), h('small', {}, status(eff, direct('folder_id', f.id)))),
        levelSelect('folder_id', f.id, inh)));
      if (open) folderRows(f.id, depth + 1, out);
    }
    for (const p of S.plansIn(parentId)) {
      if (filter && !matches(p.name)) continue;
      const eff = planLevel(p), inh = folderLevel(p.folderId || null), key = keyOf('plan_id', p.id);
      visibleKeys.push(key);
      const openFull = () => { m.close(true); location.hash = '#/p/' + p.id; };
      out.push(h('div', { class: 'grant-row' + (selected.has(key) ? ' sel' : ''), style: { marginInlineStart: depth * 16 + 'px' } },
        h('div', {}, h('div', { class: 'row' }, check(key), icon('file', 18), h('button', { class: 'plan-link', title: tr('לחצו לצפייה בקובץ התוכנית'), onclick: () => previewPlan(p.id, { onOpenFull: openFull }) }, dn(p.name))), h('small', {}, status(eff, direct('plan_id', p.id)))),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost sm', title: tr('צפייה בקובץ התוכנית (בלי לצאת מהמסך הזה)'), onclick: () => previewPlan(p.id, { onOpenFull: openFull }) }, icon('eye', 16), tr('צפייה')),
          levelSelect('plan_id', p.id, inh))));
    }
  }
  function paintSel() {
    const n = selected.size;
    selBar.classList.toggle('hidden', !n && !visibleKeys.length);
    const allOn = visibleKeys.length && visibleKeys.every((k) => selected.has(k));
    const sel = h('select', { 'aria-label': tr('רמת גישה לנבחרים') }, [['', tr('הסר הרשאה ישירה (לפי התיקייה / ללא גישה)')], ['none', tr('חסום (ללא גישה)')], ['view', tr('צפייה בלבד')], ['mark', tr('צפייה + סימונים')], ['edit', tr('עריכה מלאה')]].map(([v, t]) => h('option', { value: v }, t)));
    selBar.replaceChildren(
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!allOn, onchange: (e) => { visibleKeys.forEach((k) => (e.target.checked ? selected.add(k) : selected.delete(k))); paint(); } }), tr('בחר הכל (מה שמוצג)')),
      n ? h('div', { class: 'row wrap' }, h('b', {}, tr('{0} נבחרו', n)), sel,
        h('button', { class: 'btn sm primary', onclick: () => applyBulk(sel.value) }, tr('החל על הנבחרים')),
        h('button', { class: 'btn sm', onclick: () => { selected.clear(); paint(); } }, tr('נקה בחירה'))) : null);
  }
  async function applyBulk(value) {
    const keys = [...selected];
    try {
      for (const k of keys) await setGrant(k[0] === 'f' ? 'folder_id' : 'plan_id', k.slice(2), value);
      UI.toast(tr('עודכנו {0} פריטים', keys.length)); selected.clear(); paint();
    } catch (e) { UI.toast(tr('שגיאה: ') + (/check constraint|grants_level/i.test(e.message || '') ? tr('חסימה דורשת להריץ את קובץ ה-SQL החדש (update-v2.sql) ב-Supabase') : e.message), { type: 'error', ms: 6000 }); paint(); }
  }
  function paint() {
    const rows = [];
    visibleKeys = [];
    folderRows(null, 0, rows);
    tree.replaceChildren(...(rows.length ? rows : [h('p', { class: 'hint' }, filter ? tr('לא נמצאו תוצאות.') : tr('אין תיקיות או תוכניות.'))]));
    const vis = [...S.P.plans.values()].filter((p) => planLevel(p) > 0).length;
    summary.textContent = tr('העובד רואה {0} מתוך {1} תוכניות.', vis, S.P.plans.size);
    paintSel();
  }
  async function loadUser() {
    tree.replaceChildren(h('p', { class: 'hint' }, tr('טוען…')));
    selected.clear();
    const { data, error: e } = await sb.from('grants').select('*').eq('user_id', uid);
    if (e) { tree.replaceChildren(h('p', { class: 'msg' }, tr('שגיאה: ') + e.message)); return; }
    grants = data || [];
    for (const g of grants) { // פותחים את הענפים שיש בהם הרשאה
      let f = g.folder_id ? S.P.folders.get(g.folder_id) : (S.P.plans.get(g.plan_id) ? S.P.folders.get(S.P.plans.get(g.plan_id).folderId) : null), n = 0;
      while (f && n++ < 200) { expanded.add(f.id); f = f.parentId ? S.P.folders.get(f.parentId) : null; }
    }
    paint();
  }
  who.addEventListener('change', () => { uid = who.value; loadUser(); });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); paint(); });
  loadUser();
  return m.promise;
}

// ---------- הרשאות לכמה תיקיות/תוכניות בבת אחת (מהבחירה בדפדפן הקבצים) ----------
export async function bulkGrantsDialog({ folders = [], plans = [] }) {
  const sb = client();
  const total = folders.length + plans.length;
  const body = h('div', { class: 'form' }, h('p', { class: 'hint' }, tr('ההרשאה תיקבע ל-{0} פריטים שנבחרו (תיקייה כוללת את כל מה שבתוכה). "ללא שינוי" משאיר את ההרשאה הקיימת של העובד.', total)));
  const m = UI.openModal({ title: tr('הרשאות לפריטים שנבחרו'), body, wide: true, buttons: [
    { text: tr('ביטול'), value: false },
    { text: tr('החל'), kind: 'primary', keepOpen: true, onClick: (mm) => apply(mm) },
  ] });
  const { data: users, error } = await sb.from('profiles').select('*').eq('role', 'worker').order('display_name');
  if (error) { body.append(h('p', { class: 'msg' }, tr('שגיאה: ') + error.message)); return m.promise; }
  if (!users.length) { body.append(h('p', { class: 'msg' }, tr('עוד אין עובדים.'))); return m.promise; }
  const sels = new Map();
  for (const u of users) {
    const sel = h('select', { 'aria-label': tr('רמת גישה') }, [['keep', tr('ללא שינוי')], ['', tr('הסר הרשאה ישירה')], ['none', tr('חסום (ללא גישה)')], ['view', tr('צפייה בלבד')], ['mark', tr('צפייה + סימונים')], ['edit', tr('עריכה מלאה')]].map(([v, t]) => h('option', { value: v }, t)));
    sel.value = 'keep'; sels.set(u.id, sel);
    body.append(h('div', { class: 'grant-row' }, h('div', {}, h('b', {}, u.display_name || u.email), h('small', { dir: 'ltr' }, u.email)), sel));
  }
  async function apply(mm) {
    const changes = [...sels].filter(([, s]) => s.value !== 'keep').map(([id, s]) => [id, s.value]);
    if (!changes.length) { UI.toast(tr('לא נבחר שינוי')); return false; }
    try {
      const [fg, pg] = await Promise.all([
        folders.length ? sb.from('grants').select('*').in('folder_id', folders) : { data: [] },
        plans.length ? sb.from('grants').select('*').in('plan_id', plans) : { data: [] },
      ]);
      const have = [...(fg.data || []), ...(pg.data || [])];
      const inserts = [];
      for (const [userId, level] of changes) {
        const targets = [...folders.map((id) => ['folder_id', id]), ...plans.map((id) => ['plan_id', id])];
        for (const [col, id] of targets) {
          const ex = have.find((g) => g.user_id === userId && g[col] === id);
          if (!level) { if (ex) { const { error: e } = await sb.from('grants').delete().eq('id', ex.id); if (e) throw e; } }
          else if (ex) { if (ex.level !== level) { const { error: e } = await sb.from('grants').update({ level }).eq('id', ex.id); if (e) throw e; } }
          else inserts.push({ user_id: userId, [col]: id, level });
        }
      }
      if (inserts.length) { const { error: e } = await sb.from('grants').insert(inserts); if (e) throw e; }
      UI.toast(tr('ההרשאות עודכנו'));
      mm.close(true);
      return true;
    } catch (e) { UI.alertBox(e.message || String(e), { title: tr('העדכון נכשל') }); return false; }
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
  const ok = await UI.confirmBox(tr('נמצאו {0} תוכניות בשמירה המקומית של המכשיר הזה (לפני החיבור לענן). להעתיק אותן לענן? הן יישארו גם במצב המקומי.', sum.plans), { title: tr('העלאת התוכניות הקיימות לענן'), okText: tr('העתק לענן'), cancelText: tr('לא עכשיו') });
  if (!ok) return;
  const pb = UI.progressBox(tr('מעתיק…'));
  try { await copyLocalIntoCurrent((n) => pb.set(tr('מעתיק: ') + n)); await S.reload(); UI.toast(tr('הועתק. ההעלאה ל-Drive תתבצע ברקע.'), { ms: 5000 }); }
  catch (e) { UI.alertBox(tr('ההעתקה נכשלה: ') + (e.message || e), { title: tr('שגיאה') }); }
  finally { pb.close(); }
}
