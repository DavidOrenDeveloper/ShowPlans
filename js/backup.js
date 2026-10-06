// גיבוי ושחזור לקובץ ZIP יחיד + הורדת פריטים נבחרים
import * as db from './db.js';
import * as S from './store.js';
import * as UI from './ui.js';
import { buildZip, readZip, crc32 } from './zip.js';
import { pickFiles } from './actions.js';
import { h, fmtSize, downloadBlob, todayISO, safeName, uid } from './util.js';

const FORMAT = 'planapp-backup';

export async function exportProject() {
  const pb = UI.progressBox('מכין גיבוי…');
  try {
    pb.set('אוסף נתונים…', 0.02);
    const [folders, plans, versions, markups, measurements, links, calibrations] = await Promise.all(
      ['folders', 'plans', 'versions', 'markups', 'measurements', 'links', 'calibrations'].map((s) => db.getAll(s)));
    const data = {
      format: FORMAT, version: 1, createdAt: new Date().toISOString(),
      project: S.P.project, folders, plans, versions, markups, measurements, links, calibrations,
    };
    const entries = [{ name: 'project.json', data: JSON.stringify(data) }];
    for (const v of versions) {
      const f = await db.get('files', v.id);
      if (f) entries.push({ name: `files/${v.id}.pdf`, data: f.blob });
      const t = await db.get('thumbs', v.id);
      if (t) entries.push({ name: `thumbs/${v.id}.jpg`, data: t.blob });
    }
    const zip = await buildZip(entries, (i, n, name) => pb.set(`אורז ${i + 1}/${n}`, 0.05 + 0.6 * (i / n)));
    // אימות: פותחים את הגיבוי מחדש ובודקים שלמות (CRC) והתאמה לנתונים
    pb.set('בודק שהגיבוי ניתן לשחזור…', 0.7);
    const z = await readZip(zip);
    const back = JSON.parse(await z.getText('project.json'));
    const problems = [];
    if (back.format !== FORMAT) problems.push('פורמט לא תקין');
    let k = 0;
    for (const v of back.versions) {
      const name = `files/${v.id}.pdf`;
      if (!z.entries.has(name)) { problems.push('חסר קובץ PDF: ' + v.fileName); continue; }
      if (z.entries.get(name).usize !== v.size) problems.push('גודל לא תואם: ' + v.fileName);
      if (!(await z.checkCRC(name))) problems.push('שגיאת CRC: ' + v.fileName);
      pb.set(`בודק ${++k}/${back.versions.length}`, 0.7 + 0.28 * (k / back.versions.length));
    }
    if (problems.length) throw new Error('הגיבוי לא עבר בדיקה, לא נשמר:\n' + problems.slice(0, 5).join('\n'));
    pb.close();
    downloadBlob(zip, `plans-backup-${todayISO()}.zip`);
    UI.toast(`הגיבוי נוצר ועבר בדיקה (${fmtSize(zip.size)})`);
  } catch (e) {
    pb.close();
    console.error(e);
    await UI.alertBox(e.message || String(e), { title: 'יצירת הגיבוי נכשלה' });
  }
}

export async function importFlow() {
  const [file] = await pickFiles({ accept: '.zip,application/zip', multiple: false });
  if (!file) return;
  let z, data;
  try {
    z = await readZip(file);
    data = JSON.parse(await z.getText('project.json'));
    if (data.format !== FORMAT) throw new Error('זה לא קובץ גיבוי של האפליקציה');
  } catch (e) { await UI.alertBox(e.message || String(e), { title: 'קובץ הגיבוי לא תקין' }); return; }

  const totalSize = data.versions.reduce((s, v) => s + (v.size || 0), 0);
  const mode = { v: 'add' };
  const radio = (val, text, desc) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'mode', checked: val === 'add', onchange: () => { mode.v = val; } }), h('span', {}, h('b', {}, text), h('small', {}, desc)));
  const body = h('div', { class: 'stack' },
    h('p', { class: 'msg' }, `הגיבוי מכיל ${data.folders.length} תיקיות, ${data.plans.length} תוכניות, ${data.versions.length} גרסאות (${fmtSize(totalSize)}). נוצר בתאריך ${new Date(data.createdAt).toLocaleDateString('he-IL')}.`),
    radio('add', 'הוסף לפרויקט הקיים', 'הנתונים המשוחזרים יתווספו לצד מה שיש עכשיו. שום דבר לא נמחק.'),
    radio('replace', 'החלף את כל הפרויקט הנוכחי', 'מוחק את כל מה שקיים כרגע במכשיר ומשחזר בדיוק את הגיבוי.'));
  const go = await UI.modal({ title: 'שחזור מגיבוי', body, buttons: [{ text: 'ביטול', value: false }, { text: 'שחזר', kind: 'primary', value: true }] });
  if (!go) return;
  if (mode.v === 'replace') {
    const ok = await UI.confirmBox('כל התוכניות, התיקיות והסימונים הקיימים במכשיר יימחקו ויוחלפו בגיבוי. להמשיך?', { danger: true, okText: 'החלף הכל', title: 'אזהרה' });
    if (!ok) return;
  }

  const pb = UI.progressBox('משחזר…');
  try {
    const add = mode.v === 'add';
    const maps = { f: new Map(), p: new Map(), v: new Map() };
    const mp = (map, id) => { if (!add) return id; if (!map.has(id)) map.set(id, uid()); return map.get(id); };
    if (!add) { await db.clearAll(); }
    const folders = data.folders.map((f) => ({ ...f, id: mp(maps.f, f.id), parentId: f.parentId ? mp(maps.f, f.parentId) : null }));
    const plans = data.plans.map((p) => ({ ...p, id: mp(maps.p, p.id), folderId: p.folderId ? mp(maps.f, p.folderId) : null, currentVersionId: mp(maps.v, p.currentVersionId) }));
    await db.putMany('folders', folders);
    await db.putMany('plans', plans);
    if (!add && data.project) await db.put('projects', data.project);
    let i = 0;
    for (const v of data.versions) {
      pb.set(`משחזר ${++i}/${data.versions.length} – ${v.fileName}`, i / (data.versions.length + 1));
      const nid = mp(maps.v, v.id);
      const fb = await z.getBlob(`files/${v.id}.pdf`);
      const bytes = await fb.arrayBuffer();
      const entry = z.entries.get(`files/${v.id}.pdf`);
      if (crc32(new Uint8Array(bytes)) !== entry.crc) throw new Error('הקובץ פגום בגיבוי: ' + v.fileName);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      let thumb = null;
      if (z.entries.has(`thumbs/${v.id}.jpg`)) thumb = new Blob([await (await z.getBlob(`thumbs/${v.id}.jpg`)).arrayBuffer()], { type: 'image/jpeg' });
      await db.run(['files', 'thumbs', 'versions'], 'readwrite', async (t) => {
        t.objectStore('files').put({ id: nid, blob });
        if (thumb) t.objectStore('thumbs').put({ id: nid, blob: thumb });
        t.objectStore('versions').put({ ...v, id: nid, planId: mp(maps.p, v.planId), indexed: !!v.broken, hasText: false });
      });
    }
    const remapItem = (m) => {
      const it = { ...m, id: add ? uid() : m.id, versionId: mp(maps.v, m.versionId), planId: mp(maps.p, m.planId) };
      if (it.target?.planId) it.target = { ...it.target, planId: add ? (maps.p.get(it.target.planId) || it.target.planId) : it.target.planId };
      return it;
    };
    await db.putMany('markups', data.markups.map(remapItem));
    await db.putMany('measurements', data.measurements.map(remapItem));
    await db.putMany('links', data.links.map(remapItem));
    await db.putMany('calibrations', data.calibrations.map((c) => ({ ...c, id: `${mp(maps.v, c.versionId)}:${c.page}`, versionId: mp(maps.v, c.versionId) })));
    await S.reload();
    for (const v of S.P.versions.values()) if (!v.indexed && !v.broken) S.enqueueIndex(v.id);
    pb.close();
    UI.toast('השחזור הושלם');
  } catch (e) {
    pb.close();
    console.error(e);
    await S.reload();
    await UI.alertBox((e.message || String(e)) + (mode.v === 'replace' ? '\nהשחזור נעצר באמצע – ייתכן שחלק מהנתונים חסרים. נסו שוב עם אותו קובץ.' : ''), { title: 'השחזור נכשל' });
  }
}

// הורדת פריטים נבחרים: תוכנית בודדת כ-PDF, אחרת ZIP עם מבנה התיקיות
export async function downloadItems({ folders = [], plans = [] }) {
  if (!folders.length && plans.length === 1) {
    const p = S.P.plans.get(plans[0]);
    const b = await S.getFileBlob(p.currentVersionId);
    if (b) downloadBlob(b, safeName(p.name) + '.pdf'); else UI.toast('הקובץ לא נמצא', { type: 'error' });
    return;
  }
  const pb = UI.progressBox('מכין קובץ ZIP…');
  try {
    const entries = [];
    const used = new Set();
    const uniq = (path) => { let p = path, n = 1; while (used.has(p)) p = path.replace(/(\.pdf)?$/, ` (${++n})$1`); used.add(p); return p; };
    const addPlan = async (pid, prefix) => {
      const p = S.P.plans.get(pid); if (!p) return;
      const b = await S.getFileBlob(p.currentVersionId);
      if (b) entries.push({ name: uniq(prefix + safeName(p.name) + '.pdf'), data: b });
    };
    const addFolder = async (fid, prefix) => {
      const f = S.P.folders.get(fid); const pre = prefix + safeName(f.name) + '/';
      for (const c of S.childFolders(fid)) await addFolder(c.id, pre);
      for (const p of S.plansIn(fid)) await addPlan(p.id, pre);
    };
    for (const f of folders) await addFolder(f, '');
    for (const p of plans) await addPlan(p, '');
    if (!entries.length) { pb.close(); UI.toast('אין קבצים להורדה'); return; }
    const zip = await buildZip(entries, (i, n) => pb.set(`אורז ${i + 1}/${n}`, i / n));
    pb.close();
    downloadBlob(zip, `plans-${todayISO()}.zip`);
  } catch (e) { pb.close(); await UI.alertBox(e.message || String(e), { title: 'ההורדה נכשלה' }); }
}

// מסך אחד לגיבוי ושחזור (במקום כפתורי "ייצוא/ייבוא" מפוזרים)
export function backupDialog() {
  const body = h('div', { class: 'form' },
    h('h3', {}, 'גיבוי'),
    h('p', { class: 'hint' }, 'קובץ ZIP אחד עם כל התוכניות, התיקיות, הגרסאות והסימונים. נשמר אצלך (הורדות) ומאומת אחרי היצירה. מומלץ לגבות מדי פעם ולשמור את הקובץ מחוץ לטלפון.'),
    h('button', { class: 'btn primary', onclick: () => { m.close(); exportProject(); } }, 'צור גיבוי'),
    h('h3', {}, 'שחזור'),
    h('p', { class: 'hint' }, 'טוען קובץ גיבוי שיצרתם קודם. תוכלו לבחור אם להחליף את כל מה שיש כעת, או להוסיף אליו.'),
    h('button', { class: 'btn', onclick: () => { m.close(); importFlow(); } }, 'שחזר מקובץ גיבוי'),
    h('p', { class: 'hint' }, 'הורדת תוכניות או תיקייה בלי הסימונים (קבצי PDF בלבד, כ-ZIP): תפריט ⋮ של התיקייה ← "הורד כ-ZIP".'));
  const m = UI.openModal({ title: 'גיבוי ושחזור', body, buttons: [{ text: 'סגור', value: true }] });
  return m.promise;
}
