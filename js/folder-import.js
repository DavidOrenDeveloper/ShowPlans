// העלאת תיקייה שלמה כולל כל תתי-התיקיות (בחירת תיקייה, גרירה במחשב, או קובץ ZIP), ושמירה על המבנה המקורי.
import * as S from './store.js';
import * as UI from './ui.js';
import { readZip } from './zip.js';
import { h, natural } from './util.js';

const isPdf = (n) => /\.pdf$/i.test(n);
const hidden = (n) => n.startsWith('.') || n === '__MACOSX' || n === 'Thumbs.db' || n === 'desktop.ini';

// ---------- איסוף: כל מקור מחזיר { files: [{ path: ['תיקייה','תת','קובץ.pdf'], file }], dirs: [['תיקייה','תת'], ...], skipped } ----------
function emptyTree() { return { files: [], dirs: [], skipped: 0 }; }

// א. <input webkitdirectory>
export function pickDirectory() {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.setAttribute('webkitdirectory', ''); i.setAttribute('directory', ''); i.style.display = 'none';
    document.body.appendChild(i);
    i.onchange = () => {
      const list = [...i.files]; setTimeout(() => i.remove(), 1000);
      const t = emptyTree();
      let withPath = 0;
      for (const f of list) {
        const rel = f.webkitRelativePath || '';
        if (rel) withPath++;
        const parts = (rel || f.name).split('/').filter(Boolean);
        if (parts.some(hidden)) { t.skipped++; continue; }
        t.files.push({ path: parts, file: f });
      }
      resolve({ tree: t, noPaths: list.length > 0 && withPath === 0 });
    };
    i.addEventListener('cancel', () => { resolve(null); i.remove(); });
    i.click();
  });
}

// ב. File System Access API (אם קיים) – מכיל גם תיקיות ריקות
export async function pickDirectoryHandle() {
  const root = await window.showDirectoryPicker({ mode: 'read' });
  const t = emptyTree();
  async function walk(dir, path) {
    t.dirs.push(path);
    for await (const [name, handle] of dir.entries()) {
      if (hidden(name)) { t.skipped++; continue; }
      if (handle.kind === 'directory') await walk(handle, [...path, name]);
      else t.files.push({ path: [...path, name], file: await handle.getFile() });
    }
  }
  await walk(root, [root.name]);
  return t;
}

// ג. גרירה לחלון (מחשב). חייבים לקרוא את ה-entries לפני כל await, כי אחרי האירוע הרשימה מתרוקנת.
export function entriesFromDrop(dt) {
  const roots = [];
  for (const it of dt.items || []) {
    if (it.kind !== 'file') continue;
    const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (en) roots.push(en); else { const f = it.getAsFile(); if (f) roots.push({ plainFile: f }); }
  }
  if (!roots.length && dt.files?.length) for (const f of dt.files) roots.push({ plainFile: f });
  return roots;
}
const readAll = (reader) => new Promise((res, rej) => {
  const out = [];
  const next = () => reader.readEntries((b) => { if (!b.length) res(out); else { out.push(...b); next(); } }, rej);
  next();
});
const fileOf = (en) => new Promise((res, rej) => en.file(res, rej));
export async function treeFromEntries(roots) {
  const t = emptyTree();
  async function walk(en, path) {
    if (hidden(en.name)) { t.skipped++; return; }
    if (en.isDirectory) {
      t.dirs.push([...path, en.name]);
      for (const c of await readAll(en.createReader())) await walk(c, [...path, en.name]);
    } else t.files.push({ path: [...path, en.name], file: await fileOf(en) });
  }
  for (const r of roots) {
    if (r.plainFile) { t.files.push({ path: [r.plainFile.name], file: r.plainFile }); continue; }
    await walk(r, []);
  }
  return t;
}

// ד. קובץ ZIP (גם לטלפון: דוחסים את התיקייה במחשב ומעלים קובץ אחד)
export async function treeFromZip(file) {
  const z = await readZip(file);
  const t = emptyTree();
  for (const [name, e] of z.entries) {
    const isDir = name.endsWith('/');
    const parts = name.split('/').filter(Boolean);
    if (!parts.length || parts.some(hidden)) { t.skipped++; continue; }
    if (isDir) { t.dirs.push(parts); continue; }
    if (!isPdf(parts[parts.length - 1])) { t.skipped++; continue; }
    // חילוץ עצל: ה-Blob נוצר רק בזמן הייבוא של אותו קובץ
    const lazy = { name: parts[parts.length - 1], async get() { return new File([await z.getBlob(name)], this.name, { type: 'application/pdf' }); } };
    t.files.push({ path: parts, lazy, size: e.usize });
  }
  return t;
}

// ---------- ייבוא ----------
export async function importTree(tree, targetFolderId, { skipExisting = true } = {}) {
  const pdfs = tree.files.filter((f) => isPdf(f.path[f.path.length - 1]));
  const nonPdf = tree.files.length - pdfs.length + (tree.skipped || 0);
  if (!pdfs.length && !tree.dirs.length) { UI.toast('לא נמצאו קבצי PDF', { type: 'error' }); return null; }

  // כל התיקיות הנדרשות (גם אלה שמופיעות רק כחלק מנתיב של קובץ)
  const dirKeys = new Map();
  const addDir = (parts) => { for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i); dirKeys.set(p.join('/'), p); } };
  tree.dirs.forEach(addDir);
  pdfs.forEach((f) => addDir(f.path.slice(0, -1)));
  const dirs = [...dirKeys.values()].sort((a, b) => a.length - b.length || natural(a.join('/'), b.join('/')));
  pdfs.sort((a, b) => natural(a.path.join('/'), b.path.join('/')));

  let stop = false;
  const txt = h('div', { class: 'msg' }, ''), bar = h('div', { class: 'bar-fill' });
  const m = UI.openModal({ title: 'מעלה תיקייה…', cancelable: false, body: h('div', {}, txt, h('div', { class: 'bar' }, bar)), buttons: [{ text: 'עצור', keepOpen: true, onClick: () => { stop = true; txt.textContent = 'עוצר אחרי הקובץ הנוכחי…'; return false; } }] });
  const total = dirs.length + pdfs.length;
  let done = 0;
  const res = { folders: 0, plans: 0, existing: 0, failed: [], nonPdf, stopped: false };
  const idOf = new Map([['', targetFolderId || null]]);
  const tick = (label) => { txt.textContent = `${done} מתוך ${total} · ${label}`; bar.style.width = Math.round((done / Math.max(1, total)) * 100) + '%'; };
  try {
    for (const parts of dirs) {
      if (stop) break;
      const key = parts.join('/'), parentKey = parts.slice(0, -1).join('/'), name = parts[parts.length - 1];
      const parent = idOf.get(parentKey) ?? null;
      let f = S.childFolders(parent).find((x) => x.name === name);
      if (!f) { f = await S.createFolder(parent, name); res.folders++; }
      idOf.set(key, f.id);
      tick('תיקייה: ' + name); done++;
    }
    for (const it of pdfs) {
      if (stop) break;
      const fname = it.path[it.path.length - 1];
      const folderId = idOf.get(it.path.slice(0, -1).join('/')) ?? (targetFolderId || null);
      tick(fname);
      try {
        if (skipExisting && S.plansIn(folderId).some((p) => p.originalName === fname)) res.existing++;
        else { await S.importPdf(it.lazy ? await it.lazy.get() : it.file, folderId); res.plans++; }
      } catch (e) { console.error(e); res.failed.push({ name: it.path.join('/'), msg: e.message || String(e) }); if (/הרשאה|אחסון/.test(e.message || '')) { stop = true; } }
      done++;
    }
    res.stopped = stop;
  } finally { m.close(); }
  const bits = [`נוצרו ${res.folders} תיקיות`, `נוספו ${res.plans} תוכניות`];
  if (res.existing) bits.push(`${res.existing} כבר היו קיימות ודולגו`);
  if (res.nonPdf) bits.push(`${res.nonPdf} קבצים שאינם PDF דולגו`);
  UI.toast(bits.join(' · ') + (res.stopped ? ' (נעצר)' : ''), { ms: 6000 });
  if (res.failed.length) await UI.alertBox(res.failed.slice(0, 15).map((f) => `${f.name}: ${f.msg}`).join('\n') + (res.failed.length > 15 ? `\n…ועוד ${res.failed.length - 15}` : ''), { title: 'חלק מהקבצים לא נשמרו' });
  return res;
}

// ---------- נקודות כניסה לממשק ----------
export async function uploadFolderFlow(targetFolderId) {
  try {
    if (window.showDirectoryPicker) {
      try { return await importTree(await pickDirectoryHandle(), targetFolderId); }
      catch (e) { if (e?.name === 'AbortError') return null; console.warn('showDirectoryPicker נכשל, עוברים לבחירה רגילה', e); }
    }
    const r = await pickDirectory();
    if (!r) return null;
    if (r.noPaths) {
      await UI.alertBox('הדפדפן במכשיר הזה לא מאפשר לבחור תיקייה שלמה (הוא החזיר קבצים בלי מבנה תיקיות). הדרך המומלצת בטלפון: לדחוס את התיקייה לקובץ ZIP ולהעלות אותו דרך "העלאת ZIP עם מבנה תיקיות". במחשב אפשר לבחור תיקייה או לגרור אותה לחלון.', { title: 'בחירת תיקייה לא נתמכת כאן' });
      return null;
    }
    return await importTree(r.tree, targetFolderId);
  } catch (e) { console.error(e); UI.alertBox(e.message || String(e), { title: 'העלאת התיקייה נכשלה' }); return null; }
}
export async function uploadZipFlow(targetFolderId, pick) {
  try {
    const [file] = await pick({ accept: '.zip,application/zip', multiple: false });
    if (!file) return null;
    return await importTree(await treeFromZip(file), targetFolderId);
  } catch (e) { console.error(e); UI.alertBox((e.message || String(e)) + '\nאם שמות התיקיות בעברית נראים משובשים, דחסו מחדש עם 7-Zip או WinRAR בקידוד UTF-8.', { title: 'קריאת ה-ZIP נכשלה' }); return null; }
}
export async function handleDrop(dt, targetFolderId) {
  const roots = entriesFromDrop(dt); // סינכרוני, לפני כל await
  if (!roots.length) return null;
  const pb = UI.progressBox('קורא את מבנה התיקיות…');
  let tree;
  try { tree = await treeFromEntries(roots); } catch (e) { pb.close(); UI.alertBox('לא הצלחנו לקרוא את מה שנגרר: ' + (e.message || e)); return null; }
  pb.close();
  // קובץ ZIP בודד שנגרר – מפרקים אותו
  if (tree.files.length === 1 && /\.zip$/i.test(tree.files[0].path[0]) && tree.files[0].path.length === 1) {
    try { return await importTree(await treeFromZip(tree.files[0].file), targetFolderId); } catch (e) { UI.alertBox(e.message || String(e), { title: 'קריאת ה-ZIP נכשלה' }); return null; }
  }
  return importTree(tree, targetFolderId);
}
