// שכבת הנתונים: תיקיות, תוכניות, גרסאות. הכל נשמר ב-IndexedDB ומשוכפל בזיכרון (מטא-דאטה בלבד).
import { t as tr } from './i18n.js';
import { dn, nameVariants } from './names.js';
import * as db from './db.js';
import { uid, natural, norm, sha256 } from './util.js';
import { openPdf, renderThumb, pageText, destroyDoc } from './pdfio.js';
import { applyOverlay, unwrap } from './overlay.js';
import * as OVR from './overrides.js';
import { getSort, getManual } from './order.js';

export { unwrap };

export const P = {
  project: { id: 'main', name: tr('הפרויקט שלי'), createdAt: 0 },
  folders: new Map(),
  plans: new Map(),
  versions: new Map(),
};
// R = המבנה המשותף כפי שהוא בענן/במכשיר (לעולם לא משתנה בגלל שכבה אישית). P = מה שהמשתמש רואה (אחרי שכבה אישית).
export const R = { folders: new Map(), plans: new Map() };
let kids = new Map(), plansBy = new Map(), versBy = new Map();
let viewAs = null; // צפייה כעובד (מנהל): { userId, rows: Map, allow: { folders:Set, plans:Set } }

// חיבורים לשכבת הענן (cloud-sync.js). במצב מקומי הכול no-op.
export const hooks = {
  change() {}, purged() {}, remoteFile: null, // remoteFile(versionId) => Promise<Blob|null>
  guard() {},                                  // guard(kind, ids) זורק שגיאה אם אין הרשאה
  now: () => Date.now(),                       // שעון מתוקן לפי השרת (מצב ענן)
  owner: () => null,                           // מזהה המשתמש הנוכחי (מצב ענן)
  personal: () => false,                       // האם כל שינוי מבנה הוא אישי (עובד במצב ענן)
  isLocal: () => true,                         // האם קובץ הגרסה שמור במכשיר (מצב ענן)
  itemChange() {}, itemDeleted() {},           // סימונים/מדידות/כיולים/קישורים: שינוי / מחיקה לסנכרון
};
const stamp = (r) => { r.updatedAt = hooks.now(); r._d = 1; return r; };

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

function rebuild() {
  const rows = viewAs ? viewAs.rows : (hooks.personal() ? OVR.activeRows() : null);
  if (!rows) { P.folders = R.folders; P.plans = R.plans; return; }
  const o = applyOverlay(R.folders, R.plans, rows, { keepHidden: !!viewAs, allow: viewAs ? viewAs.allow : null });
  P.folders = o.folders; P.plans = o.plans;
}
export const getViewAs = () => viewAs;
export function setViewAs(v) { viewAs = v; emit(); }
export const realFolder = (id) => { let f = id ? P.folders.get(id) : null, g = 0; while (f && f.personal && g++ < 200) f = f.parentId ? P.folders.get(f.parentId) : null; return f ? f.id : null; };
export const isPersonalFolder = (id) => !!(id && P.folders.get(id)?.personal);
// פריטים שהמשתמש הסתיר מעצמו: [{ type:'folder'|'plan', id, name }]
export function hiddenList() {
  const out = [];
  for (const [id, r] of OVR.activeRows()) {
    if (!r.data || !r.data.hidden) continue;
    if (r.kind === 'folder' && R.folders.has(id)) out.push({ type: 'folder', id, name: r.data.name || R.folders.get(id).name });
    else if (r.kind === 'plan' && R.plans.has(id)) out.push({ type: 'plan', id, name: r.data.name || R.plans.get(id).name });
  }
  return out;
}
export async function unhide(ids) { for (const id of ids) { const r = OVR.get(id); if (r) await OVR.merge(id, r.kind, { hidden: undefined }); } emit(); }
OVR.OV.onLocalChange = () => { emit(); };
export const overrideDirty = () => OVR.dirtyCount();

function reindex() {
  kids = new Map(); plansBy = new Map(); versBy = new Map();
  for (const f of P.folders.values()) {
    const k = f.parentId || null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(f);
  }
  for (const p of P.plans.values()) {
    const k = p.folderId || null;
    if (!plansBy.has(k)) plansBy.set(k, []);
    plansBy.get(k).push(p);
  }
  for (const v of P.versions.values()) {
    if (!versBy.has(v.planId)) versBy.set(v.planId, []);
    versBy.get(v.planId).push(v);
  }
  for (const [pk, a] of kids.entries()) sortFolders(a, pk);
  for (const a of plansBy.values()) sortPlans(a);
  for (const a of versBy.values()) a.sort((x, y) => y.number - x.number);
}
// ---------- מיון (העדפות במכשיר: order.js) ----------
const tm = (x) => Number(x.updatedAt || x.createdAt || 0);
const cnt = (f) => (plansBy.get(f.id) || []).length;
function sortFolders(a, parentKey) {
  const { mode, dir } = getSort('folders');
  const sg = dir === 'desc' ? -1 : 1;
  if (mode === 'manual') {
    const ord = getManual(parentKey);
    const pos = new Map((ord || []).map((id, i) => [id, i]));
    a.sort((x, y) => (pos.has(x.id) ? pos.get(x.id) : 1e9) - (pos.has(y.id) ? pos.get(y.id) : 1e9) || natural(x.name, y.name));
    return;
  }
  const by = { name: (x, y) => natural(x.name, y.name), modified: (x, y) => tm(x) - tm(y), created: (x, y) => Number(x.createdAt || 0) - Number(y.createdAt || 0), count: (x, y) => cnt(x) - cnt(y) }[mode] || ((x, y) => natural(x.name, y.name));
  a.sort((x, y) => sg * by(x, y) || natural(x.name, y.name));
}
function sortPlans(a) {
  const { mode, dir } = getSort('plans');
  const sg = dir === 'desc' ? -1 : 1;
  const ver = (p) => P.versions.get(p.currentVersionId) || {};
  const by = {
    name: (x, y) => natural(x.name, y.name), modified: (x, y) => tm(x) - tm(y), created: (x, y) => Number(x.createdAt || 0) - Number(y.createdAt || 0),
    size: (x, y) => (ver(x).size || 0) - (ver(y).size || 0), pages: (x, y) => (ver(x).pageCount || 0) - (ver(y).pageCount || 0),
    local: (x, y) => (hooks.isLocal(y.currentVersionId) ? 1 : 0) - (hooks.isLocal(x.currentVersionId) ? 1 : 0),
  }[mode] || ((x, y) => natural(x.name, y.name));
  a.sort((x, y) => (mode === 'local' ? by(x, y) : sg * by(x, y)) || natural(x.name, y.name));
}
export function resort() { reindex(); subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }

function emit() { rebuild(); reindex(); hooks.change(); subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }

export async function init() {
  await db.open();
  if (hooks.personal()) await OVR.load();
  await reload(false);
  if (!P.project.createdAt) {
    P.project = { id: 'main', name: tr('הפרויקט שלי'), createdAt: Date.now() };
    await db.put('projects', P.project);
  }
  emit();
  // המשך אינדוקס טקסט לגרסאות שלא הושלמו
  setTimeout(() => { for (const v of P.versions.values()) if (!v.indexed && !v.broken) enqueueIndex(v.id); }, 4000);
}

export async function reload(doEmit = true) {
  const [f, p, v, pr] = await Promise.all([db.getAll('folders'), db.getAll('plans'), db.getAll('versions'), db.get('projects', 'main')]);
  R.folders = new Map(f.map((x) => [x.id, x]));
  R.plans = new Map(p.map((x) => [x.id, x]));
  P.versions = new Map(v.map((x) => [x.id, x]));
  if (pr) P.project = pr;
  if (doEmit) emit();
}

// ---------- שאילתות ----------
export const childFolders = (id) => kids.get(id || null) || [];
export const plansIn = (id) => plansBy.get(id || null) || [];
export const versionsOf = (planId) => versBy.get(planId) || [];
export const curVer = (plan) => (plan ? P.versions.get(plan.currentVersionId) : null);

export function folderPath(id) {
  const out = [];
  let f = id ? P.folders.get(id) : null;
  let guard = 0;
  while (f && guard++ < 200) { out.unshift(f); f = f.parentId ? P.folders.get(f.parentId) : null; }
  return out;
}
export function pathText(folderId) {
  return [dn(P.project.name), ...folderPath(folderId).map((f) => dn(f.name))].join(' › ');
}
export function planPathText(plan) { return pathText(plan.folderId); }

// כל התיקיות והתוכניות בתוך תיקייה (רקורסיבי)
export function descend(folderId) {
  const folders = [], plans = [];
  const walk = (id) => {
    for (const f of childFolders(id)) { folders.push(f.id); walk(f.id); }
    for (const p of plansIn(id)) plans.push(p.id);
  };
  walk(folderId);
  return { folders, plans };
}
export function isDescendant(folderId, ancestorId) {
  let f = P.folders.get(folderId), g = 0;
  while (f && g++ < 200) { if (f.id === ancestorId) return true; f = f.parentId ? P.folders.get(f.parentId) : null; }
  return false;
}

// ---------- תיקיות ----------
export async function createFolder(parentId, name) {
  if (hooks.personal()) { // עובד: תיקייה אישית, נראית רק לו
    const id = uid();
    await OVR.put(id, 'pfolder', { name: name.trim(), parentId: parentId || null, createdAt: Date.now() });
    return P.folders.get(id);
  }
  hooks.guard('folder-in', [parentId || null]);
  const f = stamp({ id: uid(), projectId: 'main', parentId: parentId || null, name: name.trim(), createdAt: Date.now() });
  await db.put('folders', f);
  R.folders.set(f.id, f);
  emit();
  return f;
}
export async function renameFolder(id, name) {
  const f = P.folders.get(id); if (!f) return;
  if (hooks.personal()) { // שם אישי בלבד
    const nm = name.trim();
    if (f.personal) await OVR.merge(id, 'pfolder', { name: nm });
    else await OVR.merge(id, 'folder', { name: nm === unwrap(f).name ? undefined : nm });
    return;
  }
  hooks.guard('folder', [id]);
  f.name = name.trim(); stamp(f); await db.put('folders', f); emit();
}
export async function renameProject(name) {
  P.project.name = name.trim(); await db.put('projects', P.project); emit();
}
export async function renamePlan(id, name) {
  const p = P.plans.get(id); if (!p) return;
  if (hooks.personal()) { const nm = name.trim(); await OVR.merge(id, 'plan', { name: nm === unwrap(p).name ? undefined : nm }); return; }
  hooks.guard('plan', [id]);
  p.name = name.trim(); stamp(p); await db.put('plans', p); emit();
}
export async function setPlanOriginalName(id, name) {
  const p = P.plans.get(id); if (!p) return;
  hooks.guard('plan', [id]);
  p.originalName = name; stamp(p); await db.put('plans', p); emit();
}
export async function setPlanNotes(id, notes) {
  const p = P.plans.get(id); if (!p) return;
  hooks.guard('plan', [id]);
  p.notes = notes; stamp(p); await db.put('plans', p); emit();
}

export async function moveItems({ folders = [], plans = [] }, targetId) {
  const target = targetId || null;
  if (!hooks.personal()) { hooks.guard('folder-in', [target]); hooks.guard('folder', folders); hooks.guard('plan', plans); }
  for (const fid of folders) {
    if (fid === target || (target && isDescendant(target, fid))) throw new Error(tr('אי אפשר להעביר תיקייה לתוך עצמה או לתוך תת-תיקייה שלה'));
  }
  if (hooks.personal()) { // העברה אישית: לא משנה את המבנה אצל אחרים
    for (const fid of folders) {
      const f = P.folders.get(fid); if (!f) continue;
      if (f.personal) await OVR.merge(fid, 'pfolder', { parentId: target });
      else await OVR.merge(fid, 'folder', { parentId: target === (unwrap(f).parentId || null) ? undefined : target });
    }
    for (const pid of plans) {
      const p = P.plans.get(pid); if (!p) continue;
      await OVR.merge(pid, 'plan', { parentId: target === (unwrap(p).folderId || null) ? undefined : target });
    }
    return;
  }
  const fs = folders.map((id) => P.folders.get(id)).filter(Boolean);
  const ps = plans.map((id) => P.plans.get(id)).filter(Boolean);
  fs.forEach((f) => { f.parentId = target; stamp(f); });
  ps.forEach((p) => { p.folderId = target; stamp(p); });
  if (fs.length) await db.putMany('folders', fs);
  if (ps.length) await db.putMany('plans', ps);
  emit();
}

// ---------- מחיקה ----------
export async function deleteItems({ folders = [], plans = [] }) {
  if (hooks.personal()) return hideItems({ folders, plans });
  hooks.guard('folder', folders); hooks.guard('plan', plans);
  const folderIds = new Set(), planIds = new Set(plans);
  for (const fid of folders) {
    folderIds.add(fid);
    const d = descend(fid);
    d.folders.forEach((x) => folderIds.add(x));
    d.plans.forEach((x) => planIds.add(x));
  }
  const vids = [];
  for (const pid of planIds) for (const v of versionsOf(pid)) vids.push(v.id);
  await purge({ folderIds: [...folderIds], planIds: [...planIds], versionIds: vids });
  await reload();
}

// עובד "מוחק": הפריט מוסתר רק ממנו. לא נמחק מהענן/Drive ואצל אחרים לא משתנה כלום.
async function hideItems({ folders = [], plans = [] }) {
  const gone = new Set();
  for (const fid of folders) {
    const f = P.folders.get(fid); if (!f) continue;
    if (f.personal) { // תיקייה אישית נמחקת יחד עם תתי-התיקיות האישיות שבתוכה (לא עם תיקיות משותפות שהוצבו בה)
      const walk = (id) => { gone.add(id); for (const c of childFolders(id)) if (c.personal) walk(c.id); };
      walk(fid);
    }
    else await OVR.merge(fid, 'folder', { hidden: true });
  }
  for (const pid of plans) { if (P.plans.get(pid)) await OVR.merge(pid, 'plan', { hidden: true }); }
  if (gone.size) {
    // פריטים משותפים שהיו בתוך תיקייה אישית שנמחקה חוזרים למקומם המקורי
    for (const [id, r] of OVR.activeRows()) if ((r.kind === 'folder' || r.kind === 'plan') && r.data && gone.has(r.data.parentId)) await OVR.merge(id, r.kind, { parentId: undefined });
    await OVR.removeMany([...gone]);
  }
}

async function purge({ folderIds = [], planIds = [], versionIds = [] }, { silent = false } = {}) {
  const names = ['folders', 'plans', 'versions', 'files', 'thumbs', 'markups', 'measurements', 'links', 'calibrations', 'textindex'];
  await db.run(names, 'readwrite', async (t) => {
    for (const vid of versionIds) {
      t.objectStore('files').delete(vid);
      t.objectStore('thumbs').delete(vid);
      t.objectStore('versions').delete(vid);
      for (const s of ['markups', 'measurements', 'links', 'calibrations', 'textindex']) await db.delByIndex(t, s, 'versionId', vid);
      thumbCache.delete(vid);
    }
    for (const id of planIds) t.objectStore('plans').delete(id);
    for (const id of folderIds) t.objectStore('folders').delete(id);
  });
  if (!silent) hooks.purged({ folderIds, planIds, versionIds });
}
// מחיקה מקומית בלבד (בעקבות שינוי בענן) – לא יוצרת מחיקה בענן
export async function purgeLocal(ids) { await purge(ids, { silent: true }); await reload(); }

// ---------- סימונים, מדידות, קישורים וכיולים ----------
// כל כתיבה של פריט עוברת כאן, כדי שהסנכרון יידע על כל שינוי (וכדי שיהיה בעלים וזמן עריכה).
export const ITEM_STORES = ['markups', 'measurements', 'links', 'calibrations'];
const itemSubs = new Set();
export function onItems(fn) { itemSubs.add(fn); return () => itemSubs.delete(fn); }
export function emitItems(versionIds) { itemSubs.forEach((f) => { try { f(versionIds); } catch (e) { console.error(e); } }); }

export async function putItem(store, it) {
  const cur = await db.get(store, it.id);
  if (cur) { it._s = cur._s; it._srv = cur._srv; it.ownerId = it.ownerId || cur.ownerId; it._rev = cur._rev; }
  else if (it._s) { it._rev = 1; }       // החזרת פריט שנמחק (ביטול מחיקה): הענן מחזיר אותו לחיים
  it.ownerId = it.ownerId || hooks.owner() || undefined;
  it.updatedAt = hooks.now(); it._d = 1;
  await db.put(store, it);
  hooks.itemChange(store, it);
  return it;
}
export async function delItem(store, id) {
  const cur = await db.get(store, id);
  await db.del(store, id);
  if (cur) hooks.itemDeleted(store, cur);
  hooks.itemChange(store, cur);
}

// ---------- ייבוא PDF ----------
function friendlyErr(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) return new Error(tr('אין מספיק מקום אחסון במכשיר'));
  return e;
}

async function analyze(buf, interactive = true) {
  const blob = new Blob([buf], { type: 'application/pdf' }); // עותק לפני ש-PDF.js לוקח את ה-buffer
  let pageCount = 0, thumb = null, broken = false;
  try {
    const doc = await openPdf(buf, { interactive });
    pageCount = doc.numPages;
    try { thumb = await renderThumb(doc); } catch (e) { console.warn('thumb failed', e); }
    await destroyDoc(doc);
  } catch (e) { console.warn('PDF לא נפתח', e); broken = true; }
  return { blob, pageCount, thumb, broken };
}

export async function importPdf(file, folderId, { name } = {}) {
  let place = null; // תיקייה אישית שבה התוכנית תוצג
  if (hooks.personal() && isPersonalFolder(folderId)) { place = folderId; folderId = realFolder(folderId); }
  hooks.guard('folder-in', [folderId || null]);
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf.slice(0)); // טביעת אצבע לזיהוי כפילויות (לפני ש-PDF.js "גונב" את ה-buffer)
  const a = await analyze(buf);
  const now = Date.now();
  const planId = uid(), verId = uid();
  const plan = {
    id: planId, projectId: 'main', folderId: folderId || null,
    name: (name || file.name.replace(/\.pdf$/i, '')).trim() || tr('תוכנית'),
    originalName: file.name, currentVersionId: verId, notes: '', createdAt: now, updatedAt: now, _d: 1,
  };
  const ver = {
    id: verId, planId, number: 1, date: new Date().toISOString().slice(0, 10), note: '',
    size: a.blob.size, pageCount: a.pageCount, fileName: file.name, createdAt: now,
    indexed: a.broken, hasText: false, broken: a.broken, hash: hash || undefined, _d: 1, _up: 1,
  };
  try {
    await db.run(['plans', 'versions', 'files', 'thumbs'], 'readwrite', async (t) => {
      t.objectStore('files').put({ id: verId, blob: a.blob });
      if (a.thumb) t.objectStore('thumbs').put({ id: verId, blob: a.thumb });
      t.objectStore('versions').put(ver);
      t.objectStore('plans').put(plan);
    });
  } catch (e) { throw friendlyErr(e); }
  R.plans.set(planId, plan); P.versions.set(verId, ver);
  if (place) await OVR.merge(planId, 'plan', { parentId: place });
  emit();
  if (!a.broken) enqueueIndex(verId);
  return P.plans.get(planId) || plan;
}

export async function addVersion(planId, file, { date, note, makeCurrent = true } = {}) {
  const plan = P.plans.get(planId); if (!plan) throw new Error(tr('התוכנית לא נמצאה'));
  hooks.guard('plan', [planId]);
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf.slice(0));
  const a = await analyze(buf);
  const verId = uid();
  const number = Math.max(0, ...versionsOf(planId).map((v) => v.number)) + 1;
  const ver = {
    id: verId, planId, number, date: date || new Date().toISOString().slice(0, 10), note: note || '',
    size: a.blob.size, pageCount: a.pageCount, fileName: file.name, createdAt: Date.now(),
    indexed: a.broken, hasText: false, broken: a.broken, hash: hash || undefined, _d: 1, _up: 1,
  };
  if (makeCurrent) { plan.currentVersionId = verId; }
  stamp(plan);
  try {
    await db.run(['plans', 'versions', 'files', 'thumbs'], 'readwrite', async (t) => {
      t.objectStore('files').put({ id: verId, blob: a.blob });
      if (a.thumb) t.objectStore('thumbs').put({ id: verId, blob: a.thumb });
      t.objectStore('versions').put(ver);
      t.objectStore('plans').put(unwrap(plan));
    });
  } catch (e) { throw friendlyErr(e); }
  P.versions.set(verId, ver);
  emit();
  if (!a.broken) enqueueIndex(verId);
  return ver;
}

export async function setCurrentVersion(planId, versionId) {
  const plan = P.plans.get(planId); if (!plan) return;
  hooks.guard('plan', [planId]);
  plan.currentVersionId = versionId; stamp(plan);
  await db.put('plans', plan); emit();
}

export async function updateVersion(versionId, patch) {
  const v = P.versions.get(versionId); if (!v) return;
  hooks.guard('plan', [v.planId]);
  Object.assign(v, patch); stamp(v); await db.put('versions', v); emit();
}

export async function deleteVersion(versionId) {
  const v = P.versions.get(versionId); if (!v) return;
  hooks.guard('plan', [v.planId]);
  const plan = P.plans.get(v.planId);
  const others = versionsOf(v.planId).filter((x) => x.id !== versionId);
  if (!others.length) { await deleteItems({ plans: [v.planId] }); return; }
  if (plan && plan.currentVersionId === versionId) { plan.currentVersionId = others[0].id; stamp(plan); await db.put('plans', plan); }
  await purge({ versionIds: [versionId] });
  await reload();
}

export async function duplicatePlan(planId) {
  const plan = P.plans.get(planId); if (!plan) return;
  const rp = unwrap(plan);
  hooks.guard('folder-in', [rp.folderId || null]);
  const ver = curVer(plan); if (!ver) return;
  const now = Date.now();
  const np = { ...rp, id: uid(), name: plan.name + tr(' (עותק)'), createdAt: now, updatedAt: now, _d: 1, _s: 0, _srv: null };
  const place = (plan.folderId || null) !== (rp.folderId || null) ? plan.folderId : null;
  const nv = { ...ver, id: uid(), planId: np.id, number: 1, createdAt: now, note: '', _d: 1, _up: 1, _s: 0, driveId: null };
  const srcBlob = await getFileBlob(ver.id);
  np.currentVersionId = nv.id;
  const [file, thumb, mk, ms, ln, cal, tx] = await Promise.all([
    srcBlob ? { blob: srcBlob } : null, db.get('thumbs', ver.id),
    db.byIndex('markups', 'versionId', ver.id), db.byIndex('measurements', 'versionId', ver.id),
    db.byIndex('links', 'versionId', ver.id), db.byIndex('calibrations', 'versionId', ver.id),
    db.byIndex('textindex', 'versionId', ver.id),
  ]);
  try {
    await db.run(['plans', 'versions', 'files', 'thumbs', 'markups', 'measurements', 'links', 'calibrations', 'textindex'], 'readwrite', async (t) => {
      if (file) t.objectStore('files').put({ id: nv.id, blob: file.blob });
      if (thumb) t.objectStore('thumbs').put({ id: nv.id, blob: thumb.blob });
      const fresh = (m) => ({ ...m, _s: 0, _d: 1, _srv: null, _rev: 0, ownerId: hooks.owner() || undefined, updatedAt: now });
      for (const m of mk) t.objectStore('markups').put({ ...fresh(m), id: uid(), versionId: nv.id, planId: np.id });
      for (const m of ms) t.objectStore('measurements').put({ ...fresh(m), id: uid(), versionId: nv.id, planId: np.id });
      for (const m of ln) t.objectStore('links').put({ ...fresh(m), id: uid(), versionId: nv.id, planId: np.id });
      for (const c of cal) t.objectStore('calibrations').put({ ...fresh(c), id: `${nv.id}:${c.page}${hooks.owner() ? ':' + hooks.owner() : ''}`, versionId: nv.id, planId: np.id });
      for (const x of tx) t.objectStore('textindex').put({ ...x, id: `${nv.id}:${x.page}`, versionId: nv.id, planId: np.id });
      t.objectStore('versions').put(nv);
      t.objectStore('plans').put(np);
    });
  } catch (e) { throw friendlyErr(e); }
  R.plans.set(np.id, np); P.versions.set(nv.id, nv);
  if (place && hooks.personal()) await OVR.merge(np.id, 'plan', { parentId: place });
  emit();
  return P.plans.get(np.id) || np;
}

// ---------- קבצים ותמונות ממוזערות ----------
export async function getFileBlob(versionId, { remote = true } = {}) {
  const r = await db.get('files', versionId);
  if (r) return r.blob;
  if (remote && hooks.remoteFile) return hooks.remoteFile(versionId); // הורדה מהענן אם הקובץ לא במכשיר
  return null;
}
const thumbCache = new Map();
export async function thumbURL(versionId) {
  if (thumbCache.has(versionId)) return thumbCache.get(versionId);
  const r = await db.get('thumbs', versionId);
  const url = r ? URL.createObjectURL(r.blob) : null;
  thumbCache.set(versionId, url);
  if (thumbCache.size > 400) {
    const k = thumbCache.keys().next().value;
    const u = thumbCache.get(k); if (u) URL.revokeObjectURL(u);
    thumbCache.delete(k);
  }
  return url;
}

// ---------- חיפוש ----------
// היקף חיפוש: תיקייה נבחרת + כל מה שבתוכה (ריק = כל הפרויקט)
export function scopeSet(folderId) {
  if (!folderId || !P.folders.has(folderId)) return null;
  return new Set([folderId, ...descend(folderId).folders]);
}
export function searchNames(q, scope = null) {
  const n = norm(q);
  if (!n) return { folders: [], plans: [] };
  return {
    folders: [...P.folders.values()].filter((f) => (!scope || scope.has(f.id)) && nameVariants(f.name).some((v) => norm(v).includes(n))).sort((a, b) => natural(a.name, b.name)),
    plans: [...P.plans.values()].filter((p) => (!scope || scope.has(p.folderId)) && nameVariants(p.name).some((v) => norm(v).includes(n))).sort((a, b) => natural(a.name, b.name)),
  };
}

export async function searchText(q, limit = 150, isStale = () => false, scope = null) {
  const n = norm(q);
  const out = [];
  if (n.length < 2) return out;
  await db.scan('textindex', (row) => {
    if (isStale()) return false;
    const v = P.versions.get(row.versionId);
    if (!v) return true;
    const plan = P.plans.get(v.planId);
    if (!plan || plan.currentVersionId !== v.id) return true; // מחפשים רק בגרסה הנוכחית
    if (scope && !scope.has(plan.folderId)) return true;
    const t = row.text.toLowerCase();
    const i = t.indexOf(n);
    if (i < 0) return true;
    const a = Math.max(0, i - 40), b = Math.min(row.text.length, i + n.length + 60);
    out.push({ planId: plan.id, versionId: v.id, page: row.page, snippet: (a > 0 ? '…' : '') + row.text.slice(a, b) + (b < row.text.length ? '…' : '') });
    return out.length < limit;
  });
  return out;
}

// ---------- אינדוקס טקסט ברקע (לחיפוש בתוך PDF) ----------
const queue = [];
let running = false;
export let indexStatus = '';
const statusSubs = new Set();
export function onIndexStatus(fn) { statusSubs.add(fn); }
function setStatus(s) { indexStatus = s; statusSubs.forEach((f) => f(s)); }

export function enqueueIndex(vid) {
  if (!queue.includes(vid)) queue.push(vid);
  if (!running) pump();
}
async function pump() {
  running = true;
  while (queue.length) {
    const vid = queue.shift();
    try { await indexVersion(vid); } catch (e) { console.warn('אינדוקס נכשל', e); }
  }
  running = false;
  setStatus('');
}
export async function reindexAll() {
  for (const v of P.versions.values()) { v.indexed = false; }
  await db.putMany('versions', [...P.versions.values()]);
  const keep = (await db.getAll('textindex')).filter((r) => r.ocr); // תוצאות OCR נשמרות
  await db.run(['textindex'], 'readwrite', async (t) => { t.objectStore('textindex').clear(); });
  if (keep.length) await db.putMany('textindex', keep);
  for (const v of P.versions.values()) if (!v.broken) enqueueIndex(v.id);
}
async function indexVersion(vid) {
  const v = P.versions.get(vid);
  if (!v || v.broken) return;
  const blob = await getFileBlob(vid, { remote: false });
  if (!blob) return; // קובץ שעוד לא הורד מהענן – יאונדקס אחרי ההורדה
  let doc;
  try { doc = await openPdf(blob, { interactive: false }); } catch { v.indexed = true; await db.put('versions', v); return; }
  const plan = P.plans.get(v.planId);
  let rows = [], chars = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    if (!P.versions.has(vid)) { await destroyDoc(doc); return; }
    setStatus(tr('מאנדקס טקסט לחיפוש: {0} ({1}/{2})', plan ? plan.name : '', i, doc.numPages));
    const pg = await doc.getPage(i);
    const text = await pageText(pg);
    pg.cleanup();
    chars += text.length;
    if (text) rows.push({ id: `${vid}:${i}`, versionId: vid, planId: v.planId, page: i, text });
    if (rows.length >= 10) { await db.putMany('textindex', rows); rows = []; }
  }
  if (rows.length) await db.putMany('textindex', rows);
  await destroyDoc(doc);
  if (!P.versions.has(vid)) return;
  v.indexed = true; v.hasText = chars > 0;
  await db.put('versions', v);
}

// ---------- אחסון ----------
export function usageByPlan() {
  const rows = [];
  for (const p of P.plans.values()) {
    const vs = versionsOf(p.id);
    rows.push({ plan: p, versions: vs.length, size: vs.reduce((s, v) => s + (v.size || 0), 0) });
  }
  return rows.sort((a, b) => b.size - a.size);
}
