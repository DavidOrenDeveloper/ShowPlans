// פעולות משותפות למסך הקבצים ול-Viewer
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
  if (!pdfs.length) { UI.toast('לא נבחרו קבצי PDF', { type: 'error' }); return []; }
  const pb = UI.progressBox('מייבא תוכניות…');
  const created = [], failed = [];
  try {
    for (let i = 0; i < pdfs.length; i++) {
      pb.set(`${i + 1} מתוך ${pdfs.length} – ${pdfs[i].name}`, i / pdfs.length);
      try { created.push(await S.importPdf(pdfs[i], folderId)); } catch (e) { console.error(e); failed.push({ name: pdfs[i].name, msg: e.message || String(e) }); }
    }
  } finally { pb.close(); }
  const broken = created.filter((p) => S.curVer(p)?.broken).length;
  if (created.length) UI.toast(`נוספו ${created.length} תוכניות` + (files.length - pdfs.length ? ` (${files.length - pdfs.length} קבצים שאינם PDF דולגו)` : '') + ' · עותק נשמר באפליקציה, אפשר למחוק את המקור מהטלפון', { ms: 5000 });
  if (broken) await UI.alertBox(`${broken} קבצים נשמרו, אבל ה-Viewer הפנימי לא הצליח לפתוח אותם. אפשר להוריד אותם או לפתוח באפליקציית PDF אחרת (תפריט ⋮ ← פתח באמצעות).`, { title: 'שימו לב' });
  if (failed.length) await UI.alertBox(failed.map((f) => `${f.name}: ${f.msg}`).join('\n'), { title: 'חלק מהקבצים לא נשמרו' });
  return created;
}

export async function uploadInto(folderId) {
  const files = await pickFiles();
  if (files.length) return importFiles(files, folderId);
  return [];
}

export async function downloadVersion(versionId, name) {
  const b = await S.getFileBlob(versionId);
  if (!b) { UI.toast('הקובץ לא נמצא באחסון המקומי', { type: 'error' }); return; }
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
    h('p', { class: 'msg' }, 'אם ה-PDF לא מוצג טוב ב-Viewer הפנימי, אפשר לפתוח אותו באפליקציה אחרת (Xodo, Adobe Acrobat ועוד).'),
    canShare ? h('button', { class: 'btn primary block', onclick: async () => { if (!(await shareVersion(vid, plan.name))) UI.toast('השיתוף לא זמין', { type: 'error' }); } }, icon('share', 18), 'שתף / פתח באפליקציית PDF…') : h('p', { class: 'hint' }, 'הדפדפן הזה לא תומך בשיתוף קבצים – אפשר להוריד ולפתוח מהמכשיר.'),
    h('button', { class: 'btn block', onclick: () => downloadVersion(vid, plan.name) }, icon('download', 18), 'הורד את קובץ ה-PDF המקורי'),
    h('button', {
      class: 'btn block', onclick: async () => {
        const b = await S.getFileBlob(vid);
        if (b) window.open(URL.createObjectURL(b), '_blank');
      },
    }, icon('external', 18), 'פתח בלשונית חדשה (Viewer של הדפדפן)'),
    h('p', { class: 'hint' }, 'הערה: אין דרך לרשום מראש את רשימת האפליקציות – בתפריט השיתוף של המכשיר תופיע רשימת האפליקציות שתומכות ב-PDF.'));
  await UI.modal({ title: 'פתח באמצעות', body, buttons: [{ text: 'סגור', value: true }] });
}

// ---------- תיקיות ותוכניות ----------
export async function newFolderDialog(parentId) {
  const v = await UI.promptBox({
    title: 'תיקייה חדשה', label: 'שם התיקייה', multiline: true, value: '', placeholder: 'לדוגמה: חשמל',
    hint: 'אפשר ליצור כמה תיקיות בבת אחת – שורה לכל תיקייה.', okText: 'צור',
  });
  if (!v) return [];
  const names = v.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const n of names) out.push(await S.createFolder(parentId, n));
  return out;
}

export async function renameFolderDialog(id) {
  const f = S.P.folders.get(id); if (!f) return;
  const v = await UI.promptBox({ title: 'שינוי שם תיקייה', value: f.name, okText: 'שמור' });
  if (v) await S.renameFolder(id, v);
}
export async function renamePlanDialog(id) {
  const p = S.P.plans.get(id); if (!p) return;
  const v = await UI.promptBox({ title: 'שינוי שם תוכנית', label: 'השם שמוצג באפליקציה (לא משנה את שם הקובץ המקורי)', value: p.name, okText: 'שמור' });
  if (v) await S.renamePlan(id, v);
}

export async function moveDialog(sel, startId) {
  const exclude = new Set();
  for (const fid of sel.folders) { exclude.add(fid); S.descend(fid).folders.forEach((x) => exclude.add(x)); }
  const r = await UI.folderPicker({ title: 'העבר לתיקייה', exclude, startId, okText: 'העבר לכאן' });
  if (!r) return false;
  try { await S.moveItems(sel, r.id); UI.toast('הועבר'); return true; } catch (e) { UI.toast(e.message, { type: 'error' }); return false; }
}

export function countText(sel) {
  const ids = { folders: new Set(sel.folders), plans: new Set(sel.plans) };
  for (const fid of sel.folders) { const d = S.descend(fid); d.folders.forEach((x) => ids.folders.add(x)); d.plans.forEach((x) => ids.plans.add(x)); }
  const subFolders = ids.folders.size - sel.folders.length;
  return { plans: ids.plans.size, folders: ids.folders.size, subFolders, versions: [...ids.plans].reduce((s, p) => s + S.versionsOf(p).length, 0) };
}

export async function deleteDialog(sel) {
  const c = countText(sel);
  let msg;
  if (sel.folders.length === 1 && !sel.plans.length) {
    const f = S.P.folders.get(sel.folders[0]);
    msg = c.plans || c.subFolders
      ? `התיקייה "${f?.name}" מכילה ${c.plans} תוכניות ו-${c.subFolders} תתי-תיקיות. האם למחוק?`
      : `למחוק את התיקייה הריקה "${f?.name}"?`;
  } else if (!sel.folders.length && sel.plans.length === 1) {
    const p = S.P.plans.get(sel.plans[0]);
    msg = `למחוק את התוכנית "${p?.name}"` + (c.versions > 1 ? ` על כל ${c.versions} הגרסאות שלה` : '') + '? הסימונים והמדידות שלה יימחקו גם הם.';
  } else {
    msg = `למחוק ${sel.folders.length} תיקיות ו-${sel.plans.length} תוכניות? בסך הכל יימחקו ${c.plans} תוכניות ו-${c.folders} תיקיות (כולל תוכן).`;
  }
  const ok = await UI.confirmBox(msg + '\nהפעולה אינה הפיכה. מומלץ לגבות לפני מחיקה גדולה.', { title: 'אישור מחיקה', okText: 'מחק', danger: true });
  if (!ok) return false;
  await S.deleteItems(sel);
  UI.toast('נמחק');
  return true;
}

export async function planInfoDialog(planId) {
  const p = S.P.plans.get(planId); if (!p) return;
  const v = S.curVer(p);
  const notes = h('textarea', { rows: 3, value: p.notes || '', placeholder: 'הערות לתוכנית…' });
  const row = (k, val) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, val));
  const body = h('div', { class: 'stack' },
    row('שם מוצג', p.name), row('שם קובץ מקורי', v?.fileName || p.originalName || ''),
    row('מיקום', S.planPathText(p)),
    row('עמודים', v?.pageCount ? String(v.pageCount) : 'לא זמין'),
    row('גודל (גרסה נוכחית)', fmtSize(v?.size)),
    row('גרסאות', String(S.versionsOf(p.id).length)),
    row('נוספה', fmtDate(p.createdAt)),
    v?.broken ? h('p', { class: 'warn' }, 'ה-Viewer הפנימי לא הצליח לפתוח קובץ זה.') : null,
    v && v.indexed && !v.hasText && !v.broken ? h('p', { class: 'hint' }, 'לא נמצא טקסט לחיפוש בקובץ (ייתכן שזו סריקה). חיפוש OCR עדיין לא נתמך.') : null,
    notes);
  const r = await UI.modal({ title: 'פרטי תוכנית', body, buttons: [{ text: 'סגור', value: false }, { text: 'שמור הערות', kind: 'primary', value: true }] });
  if (r) await S.setPlanNotes(planId, notes.value);
}

// ---------- גרסאות ----------
export async function addVersionDialog(planId) {
  const [file] = await pickFiles({ multiple: false });
  if (!file) return null;
  const date = h('input', { type: 'date', value: todayISO() });
  const note = h('input', { type: 'text', placeholder: 'לדוגמה: תיקוני יועץ חשמל' });
  const cur = h('input', { type: 'checkbox', checked: true });
  const r = await UI.modal({
    title: 'גרסה חדשה – ' + file.name,
    body: h('div', { class: 'form' }, h('label', {}, 'תאריך הגרסה'), date, h('label', {}, 'הערה לגרסה'), note,
      h('label', { class: 'check' }, cur, 'הפוך לגרסה הנוכחית')),
    buttons: [{ text: 'ביטול', value: false }, { text: 'שמור גרסה', kind: 'primary', value: true }],
  });
  if (!r) return null;
  const pb = UI.progressBox('שומר גרסה…');
  try { return await S.addVersion(planId, file, { date: date.value || todayISO(), note: note.value.trim(), makeCurrent: cur.checked }); }
  catch (e) { UI.toast(e.message || 'השמירה נכשלה', { type: 'error' }); return null; }
  finally { pb.close(); }
}

export async function versionsDialog(planId, { onChange } = {}) {
  const plan = S.P.plans.get(planId); if (!plan) return;
  const list = h('div', { class: 'ver-list' });
  let m;
  function render() {
    list.textContent = '';
    const vs = S.versionsOf(planId);
    vs.forEach((v) => {
      const isCur = plan.currentVersionId === v.id;
      list.append(h('div', { class: 'ver-row' + (isCur ? ' cur' : '') },
        h('div', { class: 'ver-main' },
          h('b', {}, `V${v.number} – ${fmtDate(v.date)}`, isCur ? h('span', { class: 'chip' }, 'נוכחית') : null),
          v.note ? h('div', { class: 'ver-note' }, v.note) : null,
          h('small', {}, `${v.pageCount || '?'} עמ׳ · ${fmtSize(v.size)}`)),
        h('div', { class: 'ver-actions' },
          h('button', { class: 'btn sm', onclick: () => { m.close(); nav(`#/p/${planId}?v=${v.id}`); } }, 'פתח'),
          !isCur ? h('button', { class: 'btn sm', onclick: async () => { await S.setCurrentVersion(planId, v.id); render(); onChange?.(); } }, 'הפוך לנוכחית') : null,
          !isCur ? h('button', { class: 'btn sm', onclick: () => { m.close(); nav(`#/p/${planId}?v=${plan.currentVersionId}&cmp=${v.id}`); } }, 'השווה לנוכחית') : null,
          h('button', { class: 'btn sm', onclick: () => downloadVersion(v.id, `${plan.name}_V${v.number}`) }, 'הורד'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              const only = S.versionsOf(planId).length === 1;
              const ok = await UI.confirmBox(only ? 'זו הגרסה היחידה – מחיקתה תמחק את כל התוכנית. להמשיך?' : `למחוק את גרסה V${v.number} (${fmtDate(v.date)})? הסימונים והמדידות של הגרסה יימחקו.`, { danger: true, okText: 'מחק', title: 'מחיקת גרסה' });
              if (!ok) return;
              await S.deleteVersion(v.id);
              if (only) { m.close(); nav('#/f/' + (plan.folderId || '')); } else render();
              onChange?.();
            },
          }, 'מחק'))));
    });
  }
  render();
  m = UI.openModal({
    title: 'גרסאות – ' + plan.name, body: list, wide: true,
    buttons: [{ text: 'סגור', value: true }, { text: 'העלה גרסה חדשה', kind: 'primary', icon: 'upload', keepOpen: true, onClick: async () => { const v = await addVersionDialog(planId); if (v) { render(); onChange?.(); } return false; } }],
  });
}

// ---------- התקנה ----------
export function installHelp() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const body = h('div', { class: 'stack' },
    ios ? h('ol', { class: 'steps' }, h('li', {}, 'פתחו את האתר ב-Safari (לא בדפדפן אחר).'), h('li', {}, 'לחצו על כפתור השיתוף (ריבוע עם חץ למעלה).'), h('li', {}, 'בחרו "הוסף למסך הבית".'), h('li', {}, 'פתחו את האפליקציה מהאייקון במסך הבית.'))
      : h('ol', { class: 'steps' }, h('li', {}, 'פתחו את האתר ב-Chrome.'), h('li', {}, 'תפריט ⋮ ← "התקן אפליקציה" או "הוסף למסך הבית".'), h('li', {}, 'פתחו את האפליקציה מהאייקון.')),
    h('p', { class: 'warn' }, 'חשוב: האחסון של האפליקציה המותקנת נפרד מהאחסון של הדפדפן (במיוחד באייפון). התקינו קודם, ורק אחר כך העלו תוכניות.'));
  return UI.modal({ title: 'התקנה כאפליקציה', body, buttons: [{ text: 'סגור', value: true }] });
}
