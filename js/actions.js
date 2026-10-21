// פעולות משותפות למסך הקבצים ול-Viewer
import { canEditPlan } from './cloud-sync.js';
import { importWithDedupe } from './dedupe.js';
import { t as tr } from './i18n.js';
import { dn } from './names.js';
import * as S from './store.js';
import * as UI from './ui.js';
import { h, icon, fmtSize, fmtDate, safeName, downloadBlob, todayISO } from './util.js';

export function nav(hash) { location.hash = hash; }

export function pickFiles({ accept = 'application/pdf,.pdf', multiple = true } = {}) {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple; i.style.display = 'none';
    document.body.appendChild(i);
    i.onchange = () => { res([...i.files]); setTimeout(() => i.remove(), 1000); };
    i.addEventListener('cancel', () => { res([]); i.remove(); });
    i.click();
  });
}

export async function importFiles(files, folderId) {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) { UI.toast(tr('לא נבחרו קבצי PDF'), { type: 'error' }); return []; }
  const pb = UI.progressBox(tr('מייבא תוכניות…'));
  let res;
  try {
    res = await importWithDedupe(pdfs.map((f) => ({ name: f.name, folderId: folderId || null, size: f.size, getFile: async () => f })), {
      tick: (label, n, tot) => pb.set(tr('{0} מתוך {1} – {2}', Math.min(n + 1, tot), tot, label), n / Math.max(1, tot)),
    });
  } finally { pb.close(); }
  if (res.cancelled) { UI.toast(tr('ההעלאה בוטלה')); return []; }
  const created = res.created, failed = res.failed;
  const broken = created.filter((p) => S.curVer(p)?.broken).length;
  const bits = [];
  if (created.length) bits.push(tr('נוספו {0} תוכניות', created.length));
  if (res.versions) bits.push(tr('{0} עודכנו כגרסה חדשה', res.versions));
  if (res.renamed) bits.push(tr('{0} שמות עודכנו', res.renamed));
  if (res.existing) bits.push(tr('{0} כבר היו קיימות ודולגו', res.existing));
  if (res.skipped) bits.push(tr('{0} דולגו לבקשתך', res.skipped));
  if (files.length - pdfs.length) bits.push(tr('{0} קבצים שאינם PDF דולגו', files.length - pdfs.length));
  if (bits.length) UI.toast(bits.join(' · ') + (created.length ? tr(' · עותק נשמר באפליקציה, אפשר למחוק את המקור מהטלפון') : ''), { ms: 5000 });
  if (broken) await UI.alertBox(tr('{0} קבצים נשמרו, אבל ה-Viewer הפנימי לא הצליח לפתוח אותם. אפשר להוריד אותם או לפתוח באפליקציית PDF אחרת (תפריט ⋮ ← פתח באמצעות).', broken), { title: tr('שימו לב') });
  if (failed.length) await UI.alertBox(failed.map((f) => `${f.name}: ${f.msg}`).join('\n'), { title: tr('חלק מהקבצים לא נשמרו') });
  return created;
}

export async function uploadInto(folderId) {
  const files = await pickFiles();
  if (files.length) return importFiles(files, folderId);
  return [];
}

export async function downloadVersion(versionId, name) {
  const b = await S.getFileBlob(versionId);
  if (!b) { UI.toast(tr('הקובץ לא נמצא באחסון המקומי'), { type: 'error' }); return; }
  downloadBlob(b, safeName(name) + '.pdf');
}

export async function shareVersion(versionId, name) {
  const b = await S.getFileBlob(versionId);
  if (!b) return false;
  const file = new File([b], safeName(name) + '.pdf', { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return true; }
  }
  return false;
}

// "פתח באמצעות": הדפדפן לא יכול להפעיל אפליקציה ספציפית – הדרך האמינה היא תפריט השיתוף של מערכת ההפעלה
export async function openWithDialog(plan, versionId) {
  const vid = versionId || plan.currentVersionId;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] }));
  const body = h('div', { class: 'stack' },
    h('p', { class: 'msg' }, tr('אם ה-PDF לא מוצג טוב ב-Viewer הפנימי, אפשר לפתוח אותו באפליקציה אחרת (Xodo, Adobe Acrobat ועוד).')),
    canShare ? h('button', { class: 'btn primary block', onclick: async () => { if (!(await shareVersion(vid, plan.name))) UI.toast(tr('השיתוף לא זמין'), { type: 'error' }); } }, icon('share', 18), tr('שתף / פתח באפליקציית PDF…')) : h('p', { class: 'hint' }, tr('הדפדפן הזה לא תומך בשיתוף קבצים – אפשר להוריד ולפתוח מהמכשיר.')),
    h('button', { class: 'btn block', onclick: () => downloadVersion(vid, plan.name) }, icon('download', 18), tr('הורד את קובץ ה-PDF המקורי')),
    h('button', {
      class: 'btn block', onclick: async () => {
        const b = await S.getFileBlob(vid);
        if (b) window.open(URL.createObjectURL(b), '_blank');
      },
    }, icon('external', 18), tr('פתח בלשונית חדשה (Viewer של הדפדפן)')),
    h('p', { class: 'hint' }, tr('הערה: אין דרך לרשום מראש את רשימת האפליקציות – בתפריט השיתוף של המכשיר תופיע רשימת האפליקציות שתומכות ב-PDF.')));
  await UI.modal({ title: tr('פתח באמצעות'), body, buttons: [{ text: tr('סגור'), value: true }] });
}

// ---------- תיקיות ותוכניות ----------
export async function newFolderDialog(parentId) {
  const v = await UI.promptBox({
    title: tr('תיקייה חדשה'), label: tr('שם התיקייה'), multiline: true, value: '', placeholder: tr('לדוגמה: חשמל'),
    hint: tr('אפשר ליצור כמה תיקיות בבת אחת – שורה לכל תיקייה.'), okText: tr('צור'),
  });
  if (!v) return [];
  const names = v.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const n of names) out.push(await S.createFolder(parentId, n));
  return out;
}

export async function renameFolderDialog(id) {
  const f = S.P.folders.get(id); if (!f) return;
  const v = await UI.promptBox({ title: tr('שינוי שם תיקייה'), label: S.hooks.personal() ? tr('השם יוצג רק לך, אצל אחרים לא ישתנה') : undefined, value: f.name, okText: tr('שמור') });
  if (v) await S.renameFolder(id, v);
}
export async function renamePlanDialog(id) {
  const p = S.P.plans.get(id); if (!p) return;
  const v = await UI.promptBox({ title: tr('שינוי שם תוכנית'), label: S.hooks.personal() ? tr('השם יוצג רק לך, אצל אחרים לא ישתנה') : tr('השם שמוצג באפליקציה (לא משנה את שם הקובץ המקורי)'), value: p.name, okText: tr('שמור') });
  if (v) await S.renamePlan(id, v);
}

export async function moveDialog(sel, startId) {
  const exclude = new Set();
  for (const fid of sel.folders) { exclude.add(fid); S.descend(fid).folders.forEach((x) => exclude.add(x)); }
  const r = await UI.folderPicker({ title: tr('העבר לתיקייה'), exclude, startId, okText: tr('העבר לכאן') });
  if (!r) return false;
  try { await S.moveItems(sel, r.id); UI.toast(tr('הועבר')); return true; } catch (e) { UI.toast(e.message, { type: 'error' }); return false; }
}

export function countText(sel) {
  const ids = { folders: new Set(sel.folders), plans: new Set(sel.plans) };
  for (const fid of sel.folders) { const d = S.descend(fid); d.folders.forEach((x) => ids.folders.add(x)); d.plans.forEach((x) => ids.plans.add(x)); }
  const subFolders = ids.folders.size - sel.folders.length;
  return { plans: ids.plans.size, folders: ids.folders.size, subFolders, versions: [...ids.plans].reduce((s, p) => s + S.versionsOf(p).length, 0) };
}

export async function deleteDialog(sel) {
  const c = countText(sel);
  if (S.hooks.personal()) { // עובד: הסתרה אישית, לא מוחקת כלום אצל אחרים
    const n = sel.folders.length + sel.plans.length;
    const ok = await UI.confirmBox(tr('להסתיר {0} ממך? זה לא ימחק אותם ולא ישפיע על אחרים. אפשר להחזיר דרך "מוסתרים אצלי" בתפריט.', n === 1 ? tr('את הפריט') : n + tr(' פריטים')), { title: tr('הסתרה'), okText: tr('הסתר') });
    if (!ok) return false;
    await S.deleteItems(sel);
    UI.toast(tr('הוסתר. להחזרה: תפריט ⋮ ← מוסתרים אצלי'));
    return true;
  }
  let msg;
  if (sel.folders.length === 1 && !sel.plans.length) {
    const f = S.P.folders.get(sel.folders[0]);
    msg = c.plans || c.subFolders
      ? tr('התיקייה "{0}" מכילה {1} תוכניות ו-{2} תתי-תיקיות. האם למחוק?', f?.name, c.plans, c.subFolders)
      : tr('למחוק את התיקייה הריקה "{0}"?', f?.name);
  } else if (!sel.folders.length && sel.plans.length === 1) {
    const p = S.P.plans.get(sel.plans[0]);
    msg = tr('למחוק את התוכנית "{0}"', p?.name) + (c.versions > 1 ? tr(' על כל {0} הגרסאות שלה', c.versions) : '') + tr('? הסימונים והמדידות שלה יימחקו גם הם.');
  } else {
    msg = tr('למחוק {0} תיקיות ו-{1} תוכניות? בסך הכל יימחקו {2} תוכניות ו-{3} תיקיות (כולל תוכן).', sel.folders.length, sel.plans.length, c.plans, c.folders);
  }
  const ok = await UI.confirmBox(msg + tr('\nהפעולה אינה הפיכה. מומלץ לגבות לפני מחיקה גדולה.'), { title: tr('אישור מחיקה'), okText: tr('מחק'), danger: true });
  if (!ok) return false;
  await S.deleteItems(sel);
  UI.toast(tr('נמחק'));
  return true;
}

export async function planInfoDialog(planId) {
  const p = S.P.plans.get(planId); if (!p) return;
  const v = S.curVer(p);
  const notes = h('textarea', { rows: 3, value: p.notes || '', placeholder: tr('הערות לתוכנית…') });
  const row = (k, val) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, val));
  const body = h('div', { class: 'stack' },
    row(tr('שם מוצג'), p.name), row(tr('שם קובץ מקורי'), v?.fileName || p.originalName || ''),
    row(tr('מיקום'), S.planPathText(p)),
    row(tr('עמודים'), v?.pageCount ? String(v.pageCount) : tr('לא זמין')),
    row(tr('גודל (גרסה נוכחית)'), fmtSize(v?.size)),
    row(tr('גרסאות'), String(S.versionsOf(p.id).length)),
    row(tr('נוספה'), fmtDate(p.createdAt)),
    v?.broken ? h('p', { class: 'warn' }, tr('ה-Viewer הפנימי לא הצליח לפתוח קובץ זה.')) : null,
    v && v.indexed && !v.hasText && !v.broken ? h('p', { class: 'hint' }, tr('לא נמצא טקסט לחיפוש בקובץ (ייתכן שזו סריקה). חיפוש OCR עדיין לא נתמך.')) : null,
    notes);
  const r = await UI.modal({ title: tr('פרטי תוכנית'), body, buttons: [{ text: tr('סגור'), value: false }, { text: tr('שמור הערות'), kind: 'primary', value: true }] });
  if (r) await S.setPlanNotes(planId, notes.value);
}

// ---------- גרסאות ----------
export async function addVersionDialog(planId) {
  const [file] = await pickFiles({ multiple: false });
  if (!file) return null;
  const date = h('input', { type: 'date', value: todayISO() });
  const note = h('input', { type: 'text', placeholder: tr('לדוגמה: תיקוני יועץ חשמל') });
  const cur = h('input', { type: 'checkbox', checked: true });
  const r = await UI.modal({
    title: tr('גרסה חדשה – ') + file.name,
    body: h('div', { class: 'form' }, h('label', {}, tr('תאריך הגרסה')), date, h('label', {}, tr('הערה לגרסה')), note,
      h('label', { class: 'check' }, cur, tr('הפוך לגרסה הנוכחית'))),
    buttons: [{ text: tr('ביטול'), value: false }, { text: tr('שמור גרסה'), kind: 'primary', value: true }],
  });
  if (!r) return null;
  const pb = UI.progressBox(tr('שומר גרסה…'));
  try { return await S.addVersion(planId, file, { date: date.value || todayISO(), note: note.value.trim(), makeCurrent: cur.checked }); }
  catch (e) { UI.toast(e.message || tr('השמירה נכשלה'), { type: 'error' }); return null; }
  finally { pb.close(); }
}

export async function versionsDialog(planId, { onChange } = {}) {
  const plan = S.P.plans.get(planId); if (!plan) return;
  const list = h('div', { class: 'ver-list' });
  let m;
  const canEdit = () => canEditPlan(planId); // עובד עם הרשאת צפייה/סימון רואה ופותח גרסאות קודמות, אבל לא משנה אותן
  function render() {
    list.textContent = '';
    const vs = S.versionsOf(planId);
    vs.forEach((v) => {
      const isCur = plan.currentVersionId === v.id;
      list.append(h('div', { class: 'ver-row' + (isCur ? ' cur' : '') },
        h('div', { class: 'ver-main' },
          h('b', {}, `V${v.number} – ${fmtDate(v.date)}`, isCur ? h('span', { class: 'chip' }, tr('נוכחית')) : null),
          v.note ? h('div', { class: 'ver-note' }, v.note) : null,
          h('small', {}, tr('{0} עמ׳ · {1}', v.pageCount || '?', fmtSize(v.size)))),
        h('div', { class: 'ver-actions' },
          h('button', { class: 'btn sm', onclick: () => { m.close(); nav(`#/p/${planId}?v=${v.id}`); } }, tr('פתח')),
          !isCur && canEdit() ? h('button', { class: 'btn sm', onclick: async () => { await S.setCurrentVersion(planId, v.id); render(); onChange?.(); } }, tr('הפוך לנוכחית')) : null,
          !isCur ? h('button', { class: 'btn sm', onclick: () => { m.close(); nav(`#/p/${planId}?v=${plan.currentVersionId}&cmp=${v.id}`); } }, tr('השווה לנוכחית')) : null,
          h('button', { class: 'btn sm', onclick: () => downloadVersion(v.id, `${plan.name}_V${v.number}`) }, tr('הורד')),
          !canEdit() ? null : h('button', {
            class: 'btn sm danger', onclick: async () => {
              const only = S.versionsOf(planId).length === 1;
              const ok = await UI.confirmBox(only ? tr('זו הגרסה היחידה – מחיקתה תמחק את כל התוכנית. להמשיך?') : tr('למחוק את גרסה V{0} ({1})? הסימונים והמדידות של הגרסה יימחקו.', v.number, fmtDate(v.date)), { danger: true, okText: tr('מחק'), title: tr('מחיקת גרסה') });
              if (!ok) return;
              await S.deleteVersion(v.id);
              if (only) { m.close(); nav('#/f/' + (plan.folderId || '')); } else render();
              onChange?.();
            },
          }, tr('מחק')))));
    });
  }
  render();
  m = UI.openModal({
    title: tr('גרסאות – ') + dn(plan.name), body: list, wide: true,
    buttons: [{ text: tr('סגור'), value: true }, ...(canEdit() ? [{ text: tr('העלה גרסה חדשה'), kind: 'primary', icon: 'upload', keepOpen: true, onClick: async () => { const v = await addVersionDialog(planId); if (v) { render(); onChange?.(); } return false; } }] : [])],
  });
}

// ---------- התקנה ----------
export function installHelp() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const body = h('div', { class: 'stack' },
    h('p', { class: 'hint' }, tr('הדפדפן לא הציע התקנה ישירה. סיבות נפוצות: האפליקציה כבר מותקנת (פתחו אותה מהאייקון), חלון גלישה פרטית, או שהאתר נפתח בדפדפן שאינו Chrome.')),
    ios ? h('ol', { class: 'steps' }, h('li', {}, tr('פתחו את האתר ב-Safari (לא בדפדפן אחר).')), h('li', {}, tr('לחצו על כפתור השיתוף (ריבוע עם חץ למעלה).')), h('li', {}, tr('בחרו "הוסף למסך הבית".')), h('li', {}, tr('פתחו את האפליקציה מהאייקון במסך הבית.')))
      : h('ol', { class: 'steps' }, h('li', {}, tr('פתחו את האתר ב-Chrome.')), h('li', {}, tr('תפריט ⋮ ← "התקן אפליקציה" או "הוסף למסך הבית".')), h('li', {}, tr('פתחו את האפליקציה מהאייקון.'))),
    h('p', { class: 'warn' }, tr('חשוב: האחסון של האפליקציה המותקנת נפרד מהאחסון של הדפדפן. תוכניות שנפתחו בדפדפן לא יופיעו מקומית באפליקציה המותקנת. עם חשבון ענן הן יורדות שוב אוטומטית ב-Drive; במצב מקומי (בלי חשבון) – התקינו קודם ורק אחר כך העלו תוכניות.')));
  return UI.modal({ title: tr('התקנה כאפליקציה'), body, buttons: [{ text: tr('סגור'), value: true }] });
}
