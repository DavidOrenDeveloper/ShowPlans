// סנכרון בין המסד המקומי (IndexedDB) לענן. כלל: השמירה האחרונה גוברת.
// תיקיות, תוכניות, גרסאות וקבצי ה-PDF (ב-Google Drive), וגם סימונים/מדידות/כיולים/קישורים (item-sync.js).
import { t as tr, LOCALE } from './i18n.js';
import * as db from './db.js';
import * as S from './store.js';
import * as UI from './ui.js';
import { cloud, client, isCloud, isAdmin, levelOfFolder, levelOfPlan, callFn, authHeaders, fnUrl, loadGrants } from './cloud.js';
import * as diag from './diag.js';
import { createItemSync } from './item-sync.js';
import * as OVR from './overrides.js';
import { fmtSize } from './util.js';

const st = { pushing: false, again: false, pulling: false, timer: 0, pullTimer: 0, err: '', last: 0, started: false, fullNext: true, denied: false, offset: 0 };
let dirtyItems = 0;
const subs = new Set();
export const onSyncStatus = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export function syncStatus() {
  if (!isCloud()) return { kind: 'local', text: tr('מצב מקומי') };
  if (!navigator.onLine) return { kind: 'offline', text: tr('אין חיבור – השינויים יסונכרנו בהמשך') + (pendingCount() ? tr(' ({0} ממתינים)', pendingCount()) : '') };
  if (st.err) return { kind: 'error', text: tr('שגיאת סנכרון: ') + st.err };
  if (st.pushing || st.pulling) return { kind: 'busy', text: tr('מסנכרן…') };
  const n = pendingCount();
  if (n) return { kind: 'pending', text: tr('{0} שינויים ממתינים לסנכרון', n) };
  return { kind: 'ok', text: st.last ? tr('מסונכרן ') + new Date(st.last).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : tr('מחובר') };
}
const emitStatus = () => subs.forEach((f) => { try { f(syncStatus()); } catch { /* ignore */ } });

// ---------- התקדמות העלאה (פס ירוק עם זמן משוער) ----------
const prog = { on: false, finished: false, total: 0, done: 0, bytes: 0, bytesDone: 0, curSent: 0, cur: '', start: 0, tick: 0, last: 0 };
const progSubs = new Set();
export const onProgress = (fn) => { progSubs.add(fn); return () => progSubs.delete(fn); };
export function progressInfo() {
  if (!prog.on) return { on: false };
  const sent = Math.min(prog.bytes, prog.bytesDone + prog.curSent);
  const elapsed = (Date.now() - prog.start) / 1000;
  let eta = null;
  if (!prog.finished && sent > 0 && elapsed >= 3) eta = Math.max(0, Math.round(((prog.bytes - sent) / (sent / elapsed))));
  const pct = prog.finished ? 100 : (prog.bytes ? Math.min(99, Math.floor((sent / prog.bytes) * 100)) : 0);
  return { on: true, finished: prog.finished, total: prog.total, done: prog.done, pct, eta, cur: prog.cur, sent, bytes: prog.bytes };
}
function emitProgress(force = false) {
  const now = Date.now();
  if (!force && now - prog.last < 200) return;
  prog.last = now;
  const info = progressInfo();
  progSubs.forEach((f) => { try { f(info); } catch { /* ignore */ } });
}
function startProgress(list) {
  clearInterval(prog.tick);
  Object.assign(prog, { on: true, finished: false, total: list.length, done: 0, bytes: list.reduce((a, v) => a + (v.size || 0), 0), bytesDone: 0, curSent: 0, cur: '', start: Date.now() });
  prog.tick = setInterval(() => emitProgress(true), 1000); // לעדכון הזמן שנותר גם כשאין תנועה
  emitProgress(true);
}
function endProgress(ok) {
  if (!prog.on) return;
  clearInterval(prog.tick);
  if (ok) {
    prog.finished = true; prog.done = prog.total; emitProgress(true);
    setTimeout(() => { if (prog.finished) { prog.on = false; emitProgress(true); } }, 2500);
  } else { prog.on = false; emitProgress(true); }
}

function pendingCount() {
  let n = 0;
  for (const m of [S.R.folders, S.R.plans, S.P.versions]) for (const r of m.values()) if (r._d) n++;
  return n + tombs.length + dirtyItems + S.overrideDirty();
}

// ---------- מחיקות שממתינות לענן ----------
let tombs = [];
async function loadTombs() { const r = await db.get('meta', 'tomb'); tombs = r?.list || []; }
const saveTombs = () => db.put('meta', { key: 'tomb', list: tombs });
function onPurged({ folderIds, planIds, versionIds }) {
  const add = (t, ids, map) => { for (const id of ids) if (map.get(id)?._s) tombs.push({ t, id }); };
  add('folders', folderIds, S.R.folders); add('plans', planIds, S.R.plans); add('versions', versionIds, S.P.versions);
  saveTombs(); schedulePush(300);
}

// ---------- המרות ----------
const strip = (r0) => { const r = S.unwrap(r0); const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('_') && k !== 'driveId') o[k] = v; return o; };
const LOCAL_ONLY_VER = ['indexed', 'hasText', 'broken'];
async function blobToB64(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => res(''); r.readAsDataURL(blob); });
}
function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}
const depth = (f) => { let d = 0, x = f, g = 0; while (x && x.parentId && g++ < 200) { d++; x = S.R.folders.get(x.parentId); } return d; };

// ---------- סימונים, מדידות, כיולים וקישורים ----------
const items = createItemSync({
  db, sb: () => client(), me: () => cloud.user?.id, isAdmin: () => isAdmin(), now: () => S.hooks.now(),
  planSynced: (id) => !!S.R.plans.get(id)?._s,
  planOfVersion: (vid) => S.P.versions.get(vid)?.planId,
  planLevel: (pid) => levelOfPlan(pid, S.R.plans, S.R.folders),
  planInFolder: (pid, fid) => { const p = S.R.plans.get(pid); if (!p) return false; let f = p.folderId ? S.R.folders.get(p.folderId) : null, g = 0; while (f && g++ < 200) { if (f.id === fid) return true; f = f.parentId ? S.R.folders.get(f.parentId) : null; } return false; },
  fetchChanged: (t, full) => fetchChanged(t, full), fetchIds: (t) => fetchIds(t), setSince: (t, v) => setSince(t, v),
  addTomb: (t) => { tombs.push(t); saveTombs(); schedulePush(300); },
  emit: (vids) => S.emitItems(vids), log: diag,
});
async function refreshDirty() { try { dirtyItems = await items.dirtyCount(); } catch { /* ignore */ } emitStatus(); }
async function pushItemsStep() {
  const r = await items.push();
  if (r['denied-edit']) deniedToast(tr('עריכת סימונים שאינם שלך'));
  if (r['denied-new']) deniedToast(tr('הוספת סימונים בתוכנית הזו'));
  await refreshDirty();
}
// לממשק: מה מותר לי לעשות בפריט / בתוכנית
export const itemAccess = (it, store) => (!isCloud() ? 'edit' : items.levelOf(it, store));
export const canMarkPlan = (planId) => !isCloud() || levelOfPlan(planId, S.R.plans, S.R.folders) >= 2;
export const canEditPlanItems = (planId) => !isCloud() || levelOfPlan(planId, S.R.plans, S.R.folders) >= 3;
export const refreshShares = () => items.loadShares();
export const myId = () => cloud.user?.id || null;

// ---------- דחיפה לענן ----------
const ready = () => isCloud() && cloud.session !== false && navigator.onLine && !!cloud.user;
export function schedulePush(ms = 1200) {
  if (!st.started || !isCloud()) return;
  clearTimeout(st.timer); st.timer = setTimeout(pushAll, ms);
}

async function remoteWrite(table, rec, row, markDone) {
  const sb = client();
  const stampv = rec.updatedAt;
  let ok = false;
  if (!rec._s) {
    const { error } = await sb.from(table).insert(row);
    if (!error) ok = true;
    else if (error.code === '23505') rec._s = 1;                       // כבר קיים – נמשיך לעדכון
    else if (error.code === '42501') { diag.warn('write:' + table, tr('אין הרשאה להוסיף לענן (RLS 42501)'), { id: rec.id, name: rec.name || rec.fileName }); return 'denied-new'; }
    else throw tag(error, 'write:' + table, { op: 'insert', id: rec.id, name: rec.name || rec.fileName });
  }
  if (!ok) {
    let { data, error } = await sb.from(table).update(row).eq('id', rec.id).select('id');
    if (error && error.code === 'P0001' && table === 'versions') {
      // המזהה המקומי של קובץ ה-Drive שונה מזה שבענן (למשל אחרי העלאה כפולה). הענן הוא המקור הקובע.
      const { data: cur } = await sb.from('versions').select('drive_file_id').eq('id', rec.id).maybeSingle();
      if (cur?.drive_file_id && cur.drive_file_id !== row.drive_file_id) {
        diag.warn('write:versions', tr('מזהה הקובץ המקומי שונה מזה שבענן. משתמשים בזה שבענן'), { id: rec.id, name: rec.fileName, local: row.drive_file_id, cloud: cur.drive_file_id });
        row.drive_file_id = cur.drive_file_id; rec.driveId = cur.drive_file_id;
        ({ data, error } = await sb.from(table).update(row).eq('id', rec.id).select('id'));
      }
    }
    if (error) throw tag(error, 'write:' + table, { op: 'update', id: rec.id, name: rec.name || rec.fileName, driveId: row.drive_file_id });
    if (!data || !data.length) { diag.warn('write:' + table, tr('העדכון לא נקלט בענן (אין הרשאה או שהרשומה לא קיימת)'), { id: rec.id, name: rec.name || rec.fileName }); return 'denied'; }
  }
  rec._s = 1;
  if (rec.updatedAt === stampv) rec._d = 0;
  await markDone(rec);
  return 'ok';
}

async function pushAll() {
  if (!ready()) { emitStatus(); return; }
  if (st.pushing) { st.again = true; return; }
  st.pushing = true; st.err = ''; emitStatus();
  try {
    await step('push:tombs', {}, pushTombs);
    await step('push:folders', {}, pushFolders);
    await step('push:plans', {}, pushPlans);
    await step('push:versions', {}, pushVersions);
    await step('push:items', {}, pushItemsStep);
    await step('push:overrides', {}, async () => { if (S.hooks.personal()) { await OVR.push(client(), cloud.user.id); emitStatus(); } });
    st.last = Date.now();
    endProgress(true);
  } catch (e) {
    console.warn('push', e);
    endProgress(false);
    st.err = friendly(e);
    clearTimeout(st.timer); st.timer = setTimeout(pushAll, 30000);
  } finally {
    st.pushing = false; emitStatus();
    if (st.again) { st.again = false; schedulePush(500); }
    if (st.denied) { st.denied = false; schedulePull(true, 300); }
  }
}
function friendly(e) {
  const m = String(e?.message || e || '');
  const w = e?.where ? `[${diag.label(e.where)}] ` : '';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return (w + tr('אין חיבור לשרת')).slice(0, 220);
  const extra = [e?.step && tr('שלב {0}', e.step), (e?.serverStatus || e?.status) && tr('סטטוס {0}', e.serverStatus || e.status), e?.code && !m.includes(String(e.code)) && tr('קוד {0}', e.code)].filter(Boolean).join(', ');
  return (w + m + (extra ? ` (${extra})` : '')).slice(0, 260);
}
// מסמן על שגיאה באיזה שלב היא קרתה, ורושם ביומן התקלות
function tag(e, where, ctx = {}) {
  const err = e && typeof e === 'object' ? e : new Error(String(e));
  if (!err.where) err.where = where;
  err.ctx = { ...(err.ctx || {}), ...ctx };
  if (err._diag) { if (Object.keys(ctx).length) diag.log('error', where, tr('השלב נכשל: ') + (err.message || ''), ctx); }
  else diag.err(where, err, ctx);
  return err;
}
async function step(where, ctx, fn) { try { return await fn(); } catch (e) { throw tag(e, where, ctx); } }

async function pushTombs() {
  if (!tombs.length) return;
  const sb = client();
  const keep = [];
  for (const t of tombs) {
    const { error } = await sb.from(t.t).update(t.t === 'items' ? { deleted: true, data: {} } : { deleted: true }).eq('id', t.id);
    if (error && !/permission|violates/i.test(error.message || '')) { keep.push(t); throw error; }
  }
  tombs = keep; await saveTombs();
}

function deniedToast(what) { UI.toast(tr('אין לך הרשאה ל{0} – השינוי בוטל', what), { type: 'error', ms: 4500 }); st.denied = true; }

async function pushFolders() {
  const list = [...S.R.folders.values()].filter((f) => f._d).sort((a, b) => depth(a) - depth(b));
  for (const f of list) {
    const r = await remoteWrite('folders', f, { id: f.id, parent_id: f.parentId || null, data: strip(f), deleted: false }, (x) => db.put('folders', x));
    if (r === 'denied') { f._d = 0; await db.put('folders', f); deniedToast(tr('שינוי התיקייה')); }
    else if (r === 'denied-new') { deniedToast(tr('יצירת תיקייה כאן')); await S.purgeLocal({ folderIds: [f.id] }); }
  }
}
async function pushPlans() {
  const list = [...S.R.plans.values()].filter((p) => p._d);
  for (const p of list) {
    const r = await remoteWrite('plans', p, { id: p.id, folder_id: p.folderId || null, data: strip(p), deleted: false }, (x) => db.put('plans', x));
    if (r === 'denied') { p._d = 0; await db.put('plans', p); deniedToast(tr('שינוי התוכנית')); }
    else if (r === 'denied-new') {
      deniedToast(tr('הוספת תוכניות כאן'));
      await S.purgeLocal({ planIds: [p.id], versionIds: S.versionsOf(p.id).map((v) => v.id) });
    }
  }
}
async function pushVersions() {
  const list = [...S.P.versions.values()].filter((v) => v._d);
  const uploads = list.filter((v) => !v.driveId && S.R.plans.get(v.planId)?._s);
  if (uploads.length) startProgress(uploads);
  for (const v of list) {
    const plan = S.R.plans.get(v.planId);
    if (!plan || !plan._s) continue; // התוכנית עוד לא בענן
    if (!v.driveId && (await adoptRemoteDrive(v))) {
      if (prog.on) { prog.done++; prog.bytesDone += v.size || 0; prog.curSent = 0; emitProgress(true); }
    } else if (!v.driveId) {
      if (!(await uploadFile(v))) { if (prog.on) { prog.done++; prog.bytesDone += v.size || 0; emitProgress(true); } continue; }
      if (prog.on) { prog.done++; prog.bytesDone += v.size || 0; prog.curSent = 0; emitProgress(true); }
    }
    const th = await db.get('thumbs', v.id);
    const data = strip(v);
    for (const k of LOCAL_ONLY_VER) delete data[k];
    delete data.thumb;
    if (th?.blob && th.blob.size < 120000) data.thumb = await blobToB64(th.blob);
    const r = await remoteWrite('versions', v, { id: v.id, plan_id: v.planId, drive_file_id: v.driveId, data, deleted: false }, (x) => db.put('versions', x));
    if (r === 'denied') { v._d = 0; await db.put('versions', v); deniedToast(tr('שינוי הגרסה')); }
    else if (r === 'denied-new') { deniedToast(tr('הוספת גרסה')); await S.purgeLocal({ versionIds: [v.id] }); }
  }
}

// אם הגרסה כבר רשומה בענן (עם קובץ Drive), משתמשים בו ולא מעלים שוב.
// מונע את השגיאה "drive_file_id לא ניתן לשינוי" כשהרשומה המקומית איבדה את driveId (למשל אחרי רענון באמצע סנכרון).
async function adoptRemoteDrive(v) {
  try {
    const { data, error } = await client().from('versions').select('drive_file_id').eq('id', v.id).maybeSingle();
    if (error) { diag.err('adopt', error, { id: v.id, file: v.fileName }); return false; }
    if (!data?.drive_file_id) return false;
    v.driveId = data.drive_file_id; v._up = 0;
    await db.put('versions', v);
    diag.info('adopt', tr('הגרסה כבר קיימת בענן, משתמשים בקובץ שלה ולא מעלים שוב'), { id: v.id, file: v.fileName });
    return true;
  } catch (e) { diag.err('adopt', e, { id: v.id }); return false; }
}

// העלאת ה-PDF ל-Drive: השרת בודק הרשאה ופותח session, והטלפון מעלה ישירות לגוגל.
async function uploadFile(v) {
  const rec = await db.get('files', v.id);
  const ctx = { id: v.id, file: v.fileName, size: v.size };
  if (!rec?.blob) { diag.warn('upload', tr('הקובץ לא נמצא בזיכרון המכשיר, לא ניתן להעלות אותו (ייתכן שנמחק או שלא נשמר)'), ctx); return false; }
  const blob = rec.blob;
  const t0 = Date.now();
  prog.cur = v.fileName || tr('תוכנית'); prog.curSent = 0; emitProgress(true);
  const s = await step('upload:session', ctx, () => callFn('drive-upload-session', { planId: v.planId, name: v.fileName || 'plan.pdf', size: blob.size }));
  // העלאה עם דיווח התקדמות (fetch לא מדווח על העלאה, XHR כן). שגיאת CORS בסוף לא משנה – מאמתים מול השרת.
  const put = { status: 0, how: '' };
  const putOk = await new Promise((res) => {
    const x = new XMLHttpRequest();
    x.open('PUT', s.uploadUrl);
    x.setRequestHeader('Content-Type', 'application/pdf');
    x.upload.onprogress = (e) => { prog.curSent = e.loaded; emitProgress(); };
    x.onload = () => { put.status = x.status; put.how = 'load'; res(x.status >= 200 && x.status < 300); };
    x.onerror = () => { put.status = x.status; put.how = 'error'; res(false); };
    x.onabort = () => { put.how = 'abort'; res(false); };
    x.send(blob);
  });
  if (!putOk) diag.warn('upload:put', tr('שליחת הקובץ לגוגל לא החזירה הצלחה ({0}, סטטוס {1}). בודקים מול השרת אם הקובץ בכל זאת הגיע', put.how, put.status || tr('לא ידוע')), { ...ctx, ms: Date.now() - t0 });
  let verr = null;
  const chk = await callFn('drive-upload-session', { action: 'verify', fileId: s.fileId }).catch((e) => { verr = e; return null; });
  if (!chk?.exists || chk.size !== blob.size) {
    const e = new Error(putOk ? tr('ההעלאה לא אומתה (הקובץ ב-Drive שונה מהמקורי או חסר)') : tr('ההעלאה ל-Drive נכשלה'));
    e.where = 'upload:verify';
    throw tag(e, 'upload:verify', { ...ctx, putOk, putStatus: put.status, putHow: put.how, remoteExists: chk?.exists, remoteSize: chk?.size, driveStatus: chk?.driveStatus, driveMessage: chk?.driveMessage, localSize: blob.size, verifyError: verr ? String(verr.message) : undefined });
  }
  v.driveId = s.fileId; v._up = 0;
  await db.put('versions', v);
  diag.info('upload', tr('הקובץ הועלה ל-Drive ואומת'), { ...ctx, ms: Date.now() - t0 });
  return true;
}

// ---------- משיכה מהענן ----------
export function schedulePull(full = false, ms = 800) {
  if (!st.started || !isCloud()) return;
  if (full) st.fullNext = true;
  clearTimeout(st.pullTimer); st.pullTimer = setTimeout(pullAll, ms);
}
const getSince = async (t) => (await db.get('meta', 'pull:' + t))?.v || '1970-01-01T00:00:00Z';
const setSince = (t, v) => db.put('meta', { key: 'pull:' + t, v });

// full = משיכה מלאה (למשל אחרי שינוי הרשאות): מתחילים מההתחלה ולא מהסמן. אחרת פריט שהמנהל רק עכשיו נתן עליו הרשאה,
// ושעודכן לאחרונה לפני הסמן של העובד, לא היה נמשך לעולם.
async function fetchChanged(table, full = false) {
  const sb = client(); const since = full ? '1970-01-01T00:00:00Z' : await getSince(table);
  const rows = []; let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select('*').gte('updated_at', since).order('updated_at').order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return { rows, since };
}
async function fetchIds(table) {
  const sb = client(); const ids = new Set(); let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select('id').eq('deleted', false).order('id').range(from, from + 999);
    if (error) throw error;
    data.forEach((r) => ids.add(r.id));
    if (data.length < 1000) break;
    from += 1000;
  }
  return ids;
}

async function pullAll() {
  if (!ready()) return;
  if (st.pulling) { st.fullNext = st.fullNext || false; clearTimeout(st.pullTimer); st.pullTimer = setTimeout(pullAll, 1500); return; }
  st.pulling = true; emitStatus();
  const full = st.fullNext; st.fullNext = false;
  let stage = 'fetch';
  try {
    stage = 'grants';
    if (full) await loadGrants();
    stage = 'fetch';
    const F = await fetchChanged('folders', full), Pl = await fetchChanged('plans', full), V = await fetchChanged('versions', full);
    const puts = { folders: [], plans: [], versions: [] }, purge = { folderIds: [], planIds: [], versionIds: [] }, thumbs = [];

    for (const r of F.rows) {
      const loc = S.R.folders.get(r.id); if (loc?._d) continue;
      if (loc && !r.deleted && loc._srv === r.updated_at) continue; // כבר אצלי
      if (r.deleted) { if (loc) purge.folderIds.push(r.id); continue; }
      puts.folders.push({ ...r.data, id: r.id, parentId: r.parent_id || null, _s: 1, _srv: r.updated_at });
    }
    for (const r of Pl.rows) {
      const loc = S.R.plans.get(r.id); if (loc?._d) continue;
      if (loc && !r.deleted && loc._srv === r.updated_at) continue; // כבר אצלי
      if (r.deleted) { if (loc) purge.planIds.push(r.id); continue; }
      puts.plans.push({ ...r.data, id: r.id, folderId: r.folder_id || null, _s: 1, _srv: r.updated_at });
    }
    for (const r of V.rows) {
      const loc = S.P.versions.get(r.id); if (loc?._d) continue;
      if (loc && !r.deleted && loc._srv === r.updated_at) continue; // כבר אצלי
      if (r.deleted) { if (loc) purge.versionIds.push(r.id); continue; }
      const d = { ...r.data }; const th = d.thumb; delete d.thumb;
      puts.versions.push({ ...d, id: r.id, planId: r.plan_id, driveId: r.drive_file_id, _s: 1, _srv: r.updated_at,
        indexed: loc?.indexed ?? false, hasText: loc?.hasText ?? false, broken: loc?.broken ?? false });
      if (th && !(await db.get('thumbs', r.id))) thumbs.push({ id: r.id, blob: b64ToBlob(th) });
    }
    stage = 'apply';
    if (puts.folders.length) await db.putMany('folders', puts.folders);
    if (puts.plans.length) await db.putMany('plans', puts.plans);
    if (puts.versions.length) await db.putMany('versions', puts.versions);
    if (thumbs.length) await db.putMany('thumbs', thumbs);

    // התאמה מלאה: מה שכבר לא נראה לי בענן (נמחק או שההרשאה הוסרה) נמחק מהמכשיר
    stage = 'reconcile';
    if (full) {
      const [fi, pi, vi] = await Promise.all([fetchIds('folders'), fetchIds('plans'), fetchIds('versions')]);
      for (const f of S.R.folders.values()) if (f._s && !f._d && !fi.has(f.id) && !puts.folders.some((x) => x.id === f.id)) purge.folderIds.push(f.id);
      for (const p of S.R.plans.values()) if (p._s && !p._d && !pi.has(p.id) && !puts.plans.some((x) => x.id === p.id)) purge.planIds.push(p.id);
      for (const v of S.P.versions.values()) if (v._s && !v._d && !vi.has(v.id) && !puts.versions.some((x) => x.id === v.id)) purge.versionIds.push(v.id);
    }
    const maxOf = (rows, since) => rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), since);
    stage = 'purge';
    if (purge.folderIds.length || purge.planIds.length || purge.versionIds.length) await S.purgeLocal(purge);
    else if (puts.folders.length || puts.plans.length || puts.versions.length) await S.reload();
    await setSince('folders', maxOf(F.rows, F.since)); await setSince('plans', maxOf(Pl.rows, Pl.since)); await setSince('versions', maxOf(V.rows, V.since));
    stage = 'items';
    await items.pull(full);
    stage = 'overrides';
    if (S.hooks.personal() && (await OVR.pull(client(), cloud.user.id))) await S.reload();
    await refreshDirty();
    st.err = ''; st.last = Date.now();
    for (const v of puts.versions) if (!v.indexed) { /* ייאונדקס אחרי הורדת הקובץ */ }
  } catch (e) {
    st.err = friendly(tag(e, 'pull:' + stage, { full }));
  } finally {
    st.pulling = false; emitStatus();
  }
}

// ---------- הורדת קובץ מהענן (לפי דרישה) ----------
const inflight = new Map();
const ctrls = new Map();
const STALL_MS = 30000; // בלי קליטה: אם לא הגיע אף בייט כל כך הרבה זמן – עוצרים במקום להיתקע
// אילו גרסאות כבר שמורות במכשיר (לסימון בכרטיסים ולהורדה מרוכזת)
export const localFiles = new Set();
const localSubs = new Set();
export const onLocalFilesChange = (fn) => { localSubs.add(fn); return () => localSubs.delete(fn); };
export async function refreshLocalFiles() {
  try { const k = await db.keys('files'); localFiles.clear(); k.forEach((x) => localFiles.add(x)); } catch { /* ignore */ }
  localSubs.forEach((f) => { try { f(); } catch { /* ignore */ } });
}
export const isLocal = (versionId) => localFiles.has(versionId);
export const needsDownload = (plan) => { const v = S.curVer(plan); return !!(isCloud() && v && v.driveId && !localFiles.has(v.id)); };

// ---------- המשך הורדה ברקע (גם כשיצאו מהאפליקציה / נעלו את הטלפון) ----------
// דפדפן לא נותן לדף להמשיך לרוץ כשהוא ברקע. לכן ברגע שהאפליקציה יוצאת מהחזית וההורדות עוד לא הסתיימו,
// מעבירים אותן ל-Background Fetch (הדפדפן עצמו מוריד, עם התראה, ה-Service Worker שומר את הקבצים במסד המקומי).
// נתמך ב-Chrome באנדרואיד. באייפון/ספארי אין תמיכה: שם ההורדה ממשיכה בלי הפסקה כל עוד המסך דלוק (נעילת מסך),
// וכשחוזרים לאפליקציה כל מה שלא הסתיים נמשך מחדש.
const wanted = new Set();      // גרסאות שמישהו ביקש להוריד ועוד לא ירדו (כולל תור של הורדה מרוכזת)
const bgActive = new Map();    // versionId -> מזהה רישום ה-Background Fetch
const handoffIds = new Set();  // גרסאות שההורדה בדף הופסקה בכוונה כי עברו לרקע
const bgWaiters = new Map();   // versionId -> [{ resolve, onProgress }]
let bgChip = null;
const bgOK = () => isCloud() && 'serviceWorker' in navigator && typeof window.BackgroundFetchManager !== 'undefined';

let wl = null;
async function wakeOn() { try { if (!wl && navigator.wakeLock && document.visibilityState === 'visible') { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch { /* ignore */ } }
function wakeOff() { try { wl?.release(); } catch { /* ignore */ } wl = null; }

async function bgHandoff(ids) {
  ids = [...new Set(ids)].filter((id) => !bgActive.has(id) && !localFiles.has(id) && S.P.versions.get(id)?.driveId);
  if (!ids.length) return bgActive.size > 0;
  if (!bgOK() || !navigator.onLine) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.backgroundFetch) return false;
    const headers = await authHeaders();
    const reqs = ids.map((id) => new Request(`${fnUrl('drive-download')}?v=${encodeURIComponent(id)}`, { headers }));
    const total = ids.reduce((a, id) => a + (S.P.versions.get(id)?.size || 0), 0);
    const bid = `dl|${db.dbName()}|${Date.now()}`;
    const bf = await reg.backgroundFetch.fetch(bid, reqs, { title: tr('מוריד תוכניות ({0})', ids.length), icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }], downloadTotal: total });
    ids.forEach((id) => bgActive.set(id, bid));
    bf.addEventListener('progress', () => bgProgress(bf));
    diag.info('bgfetch', tr('ההורדה הועברה לרקע'), { files: ids.length });
    return true;
  } catch (e) { diag.warn('bgfetch', tr('העברת ההורדה לרקע נכשלה (הדפדפן לא תומך או סירב): ') + (e?.message || e)); return false; }
}
function bgProgress(bf) {
  const frac = bf.downloadTotal ? Math.min(0.99, bf.downloaded / bf.downloadTotal) : null;
  const txt = tr('{0}MB · ממשיך ברקע', Math.round((bf.downloaded / 1048576) * 10) / 10);
  for (const ws of bgWaiters.values()) for (const w of ws) w.onProgress?.(txt, frac);
  bgChip?.set(txt, frac);
}
// ממתינים לקובץ שירד ברקע. מחזיר Blob, או null אם ההורדה ברקע נכשלה/בוטלה.
function bgWaitFor(versionId, onProgress) {
  return new Promise((resolve) => {
    let done = false, poll = 0;
    const fin = (b) => { if (done) return; done = true; clearInterval(poll); const a = bgWaiters.get(versionId) || []; const i = a.findIndex((w) => w.resolve === fin); if (i >= 0) a.splice(i, 1); resolve(b); };
    if (!bgWaiters.has(versionId)) bgWaiters.set(versionId, []);
    bgWaiters.get(versionId).push({ resolve: fin, onProgress });
    poll = setInterval(async () => {
      const r = await db.get('files', versionId).catch(() => null);
      if (r) { await onBgDone([versionId], []); return; }
      if (!bgActive.has(versionId)) fin(null);
    }, 3000);
  });
}
async function onBgDone(okIds, failIds) {
  for (const id of [...okIds, ...failIds]) bgActive.delete(id);
  await refreshLocalFiles();
  for (const id of okIds) {
    wanted.delete(id); handoffIds.delete(id);
    try { S.enqueueIndex(id); } catch { /* ignore */ }
    const r = await db.get('files', id).catch(() => null);
    for (const w of [...(bgWaiters.get(id) || [])]) w.resolve(r ? r.blob : null);
  }
  for (const id of failIds) { handoffIds.delete(id); for (const w of [...(bgWaiters.get(id) || [])]) w.resolve(null); }
  if (!bgActive.size && bgChip) { bgChip.close(); bgChip = null; if (okIds.length) UI.toast(tr('ההורדה ברקע הסתיימה ✓ ({0} קבצים)', okIds.length), { ms: 3500 }); }
}
// בהפעלה ובחזרה לחזית: בודקים מה ירד ברקע בזמן שהאפליקציה הייתה סגורה, ומתחברים להורדות שעדיין רצות
async function bgReconcile() {
  if (!isCloud()) return;
  try {
    const m = await db.get('meta', 'bgIndex');
    if (m && m.v && m.v.length) { await db.put('meta', { key: 'bgIndex', v: [] }); for (const id of m.v) { try { S.enqueueIndex(id); } catch { /* ignore */ } } await refreshLocalFiles(); }
  } catch { /* ignore */ }
  if (!bgOK()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.backgroundFetch) return;
    for (const bid of await reg.backgroundFetch.getIds()) {
      if (!bid.startsWith(`dl|${db.dbName()}|`)) continue;
      const bf = await reg.backgroundFetch.get(bid); if (!bf) continue;
      for (const r of await bf.matchAll()) { const id = new URL(r.request.url).searchParams.get('v'); if (id && !localFiles.has(id)) bgActive.set(id, bid); }
      if (!bgChip && bgActive.size) bgChip = UI.bgProgress(tr('הורדה ברקע ממשיכה'));
      bf.addEventListener('progress', () => bgProgress(bf));
      bgProgress(bf);
    }
  } catch (e) { diag.warn('bgfetch', String(e?.message || e)); }
}
async function bgAbortAll() {
  try {
    const reg = await navigator.serviceWorker.ready;
    for (const bid of new Set(bgActive.values())) { const bf = await reg.backgroundFetch?.get(bid); await bf?.abort(); }
  } catch { /* ignore */ }
  const ids = [...bgActive.keys()]; bgActive.clear();
  for (const id of ids) for (const w of [...(bgWaiters.get(id) || [])]) w.resolve(null);
  if (bgChip) { bgChip.close(); bgChip = null; }
}
async function onLeaveForeground() {
  wakeOff();
  const ids = [...wanted].filter((id) => !localFiles.has(id) && !bgActive.has(id));
  if (!ids.length) return;
  if (await bgHandoff(ids)) {
    for (const id of ids) { if (ctrls.has(id)) { handoffIds.add(id); ctrls.get(id).abort(); } }
  }
}
function initBgDownloads() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeaveForeground();
    else { if (inflight.size) wakeOn(); bgReconcile(); }
  });
  window.addEventListener('pagehide', () => { onLeaveForeground(); });
  try {
    navigator.serviceWorker?.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.type === 'bg-done') onBgDone(d.ok || [], d.failed || []);
    });
  } catch { /* ignore */ }
  bgReconcile();
}

// quiet: בלי שבב התקדמות ובלי הודעת שגיאה (להורדה מרוכזת). מחזיר Blob או null.
async function remoteFile(versionId, opts = {}) {
  const v = S.P.versions.get(versionId);
  if (!isCloud() || !v?.driveId) return null;
  if (!navigator.onLine) { if (!opts.quiet) UI.toast(tr('אין חיבור לאינטרנט, והקובץ הזה עוד לא הורד למכשיר'), { type: 'error', ms: 4500 }); return null; }
  if (inflight.has(versionId)) return inflight.get(versionId);
  if (bgActive.has(versionId)) return bgWaitFor(versionId); // כבר יורד ברקע
  if (document.visibilityState === 'hidden' && bgOK() && await bgHandoff([versionId])) return bgWaitFor(versionId);
  wanted.add(versionId); wakeOn();
  const pr = (async () => {
    const ctrl = new AbortController(); ctrls.set(versionId, ctrl);
    let reason = '';
    const pb = !opts.quiet && UI.bgProgress ? UI.bgProgress(tr('מוריד: {0}', S.P.plans.get(v.planId)?.name || v.fileName || ''), { onCancel: () => { reason = 'user'; ctrl.abort(); } }) : null;
    let last = Date.now();
    const watch = setInterval(() => { if (Date.now() - last > STALL_MS) { reason = 'stall'; ctrl.abort(); } }, 2000);
    try {
      const res = await fetch(`${fnUrl('drive-download')}?v=${encodeURIComponent(versionId)}`, { headers: await authHeaders(), signal: ctrl.signal });
      last = Date.now();
      if (!res.ok) {
        let j = null; try { j = await res.clone().json(); } catch { /* ignore */ }
        const e = new Error(res.status === 404 ? tr('אין הרשאה או שהקובץ לא נמצא') : tr('ההורדה נכשלה (') + res.status + ')');
        e.status = res.status; e.code = j?.error; e.step = j?.step; e.serverStatus = j?.status; e.detail = j?.message;
        throw e;
      }
      const total = Number(res.headers.get('content-length')) || v.size || 0;
      const chunks = []; let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        last = Date.now();
        chunks.push(value); got += value.length;
        if (pb && total) pb.set(tr('{0}MB מתוך {1}MB', Math.round((got / 1048576) * 10) / 10, Math.round((total / 1048576) * 10) / 10), Math.min(0.99, got / total));
      }
      const blob = new Blob(chunks, { type: 'application/pdf' });
      if (v.size && blob.size !== v.size) throw new Error(tr('הקובץ שהורד לא שלם, נסו שוב'));
      await db.put('files', { id: versionId, blob });
      localFiles.add(versionId); localSubs.forEach((f) => { try { f(); } catch { /* ignore */ } });
      S.enqueueIndex(versionId);
      return blob;
    } catch (e) {
      if (handoffIds.has(versionId)) { // האפליקציה יצאה מהחזית: ההורדה ממשיכה ברקע ואנחנו ממתינים לה
        const b = await bgWaitFor(versionId, (t, f) => pb?.set(t, f));
        if (b) return b;
        handoffIds.delete(versionId);
      }
      if (opts.quiet) { opts.onError?.(e, reason); return null; }
      if (reason === 'user') { UI.toast(tr('ההורדה בוטלה'), { ms: 2000 }); return null; }
      if (reason === 'stall' || e?.name === 'AbortError') { UI.toast(tr('אין קליטה – ההורדה נעצרה. אפשר להמשיך לעבוד עם תוכניות שכבר הורדו, ולנסות שוב כשיש קליטה.'), { type: 'error', ms: 6000 }); return null; }
      tag(e, 'download', { id: versionId, file: v.fileName, size: v.size });
      UI.toast(friendly(e), { type: 'error', ms: 6000 });
      return null;
    } finally { clearInterval(watch); pb?.close(); inflight.delete(versionId); ctrls.delete(versionId); if (!bgActive.has(versionId)) wanted.delete(versionId); if (!inflight.size) wakeOff(); }
  })();
  inflight.set(versionId, pr);
  return pr;
}

// הורדה מרוכזת למכשיר: { folders, plans } (בלי ארגומנט – כל מה שנראה לי). מדלגת על מה שכבר במכשיר.
let bulk = null;
export async function downloadForOffline(o) {
  if (!isCloud()) { UI.toast(tr('במצב מקומי כל הקבצים כבר במכשיר')); return; }
  if (bulk) { UI.toast(tr('הורדה מרוכזת כבר רצה'), { ms: 2000 }); return; }
  await refreshLocalFiles();
  const ids = new Set();
  if (!o) S.P.plans.forEach((p) => ids.add(p.id));
  else { (o.plans || []).forEach((id) => ids.add(id)); (o.folders || []).forEach((fid) => { S.descend(fid).plans.forEach((id) => ids.add(id)); }); }
  const list = [];
  for (const id of ids) { const p = S.P.plans.get(id); const v = p && S.curVer(p); if (v && v.driveId && !localFiles.has(v.id)) list.push({ p, v }); }
  if (!list.length) { UI.toast(tr('הכל כבר שמור במכשיר ✓')); return; }
  const bytes = list.reduce((s, x) => s + (x.v.size || 0), 0);
  const est = await db.storageEstimate();
  const room = est.quota ? est.quota - est.usage : Infinity;
  if (bytes > room * 0.9) { await UI.alertBox(tr('אין מספיק מקום פנוי במכשיר להורדה של {0}. פנו מקום או הורידו חלק מהתיקיות.', fmtSize(bytes)), { title: tr('אין מספיק מקום') }); return; }
  if (!(await UI.confirmBox(tr('להוריד {0} קבצים ({1}) למכשיר כדי לעבוד גם בלי קליטה? ההורדה ממשיכה ברקע, אפשר להמשיך להשתמש באפליקציה.', list.length, fmtSize(bytes)), { title: tr('הורדה למכשיר'), okText: tr('הורד') }))) return;
  list.forEach((x) => wanted.add(x.v.id));
  const st2 = { cancel: false, done: 0, fail: 0, row: 0 };
  const pb = UI.bgProgress(tr('מוריד למכשיר'), { onCancel: () => { st2.cancel = true; list.forEach((x) => wanted.delete(x.v.id)); bgAbortAll(); for (const [id] of ctrls) ctrls.get(id)?.abort(); } });
  bulk = st2;
  let streak = 0;
  const work = async () => {
    for (;;) {
      if (st2.cancel || streak >= 3) return;
      const x = list[st2.row++]; if (!x) return;
      let err = null;
      const b = await remoteFile(x.v.id, { quiet: true, onError: (e) => { err = e; } });
      if (b) { st2.done++; streak = 0; } else if (!st2.cancel) { st2.fail++; streak++; }
      pb.set(tr('{0} מתוך {1} · {2}', st2.done + st2.fail, list.length, x.p.name), (st2.done + st2.fail) / list.length);
      if (err && /403|401/.test(String(err.status))) streak = 3;
    }
  };
  pb.set(tr('0 מתוך {0}', list.length), 0);
  try { await Promise.all([work(), work()]); } finally { pb.close(); bulk = null; await refreshLocalFiles(); list.forEach((x) => { if (!bgActive.has(x.v.id)) wanted.delete(x.v.id); }); }
  if (st2.cancel) UI.toast(tr('ההורדה הופסקה. הורדו {0} מתוך {1}', st2.done, list.length), { ms: 4000 });
  else if (streak >= 3) UI.toast(tr('ההורדה נעצרה, כנראה אין קליטה. הורדו {0} מתוך {1}. אפשר להפעיל שוב כשיש קליטה והיא תמשיך מאותה נקודה.', st2.done, list.length), { type: 'error', ms: 7000 });
  else UI.toast(st2.fail ? tr('הורדו {0} קבצים, {1} נכשלו. אפשר להפעיל שוב.', st2.done, st2.fail) : tr('הורדו {0} קבצים למכשיר ✓', st2.done), { ms: 4000 });
}

// פינוי מקום: מסיר מהמכשיר את קובצי ה-PDF שכבר נמצאים גם בענן. התוכנית, הסימונים והחיפוש נשארים, והקובץ יורד שוב לפי דרישה.
export async function removeFromDevice(o) {
  if (!isCloud()) { UI.toast(tr('במצב מקומי הקבצים נמצאים רק במכשיר, אי אפשר להסיר אותם בלי למחוק'), { type: 'error', ms: 4500 }); return; }
  await refreshLocalFiles();
  const ids = new Set();
  if (!o) S.P.plans.forEach((p) => ids.add(p.id));
  else { (o.plans || []).forEach((id) => ids.add(id)); (o.folders || []).forEach((fid) => { S.descend(fid).plans.forEach((id) => ids.add(id)); }); }
  const list = [];
  for (const id of ids) {
    const p = S.P.plans.get(id);
    for (const v of S.versionsOf(id)) if (v.driveId && localFiles.has(v.id)) list.push({ p, v });
  }
  if (!list.length) { UI.toast(tr('אין קבצים שאפשר להסיר מהמכשיר (רק קבצים שנמצאים גם בענן)'), { ms: 3500 }); return; }
  const bytes = list.reduce((s, x) => s + (x.v.size || 0), 0);
  if (!(await UI.confirmBox(tr('להסיר {0} קבצים ({1}) מהמכשיר? התוכניות נשארות בענן, והסימונים נשמרים. כשתפתחו תוכנית היא תרד שוב (צריך קליטה).', list.length, fmtSize(bytes)), { title: tr('פינוי מקום'), okText: tr('הסר מהמכשיר') }))) return;
  for (const x of list) { try { await db.del('files', x.v.id); localFiles.delete(x.v.id); } catch (e) { console.error(e); } }
  localSubs.forEach((f) => { try { f(); } catch { /* ignore */ } });
  UI.toast(tr('הוסרו {0} קבצים, התפנו כ-{1}', list.length, fmtSize(bytes)), { ms: 4000 });
}

// ---------- הרשאות בצד הממשק ----------
function guard(kind, ids) {
  if (!isCloud() || isAdmin()) return;
  const deny = () => { throw new Error(tr('אין לך הרשאת עריכה כאן')); };
  for (const id of ids) {
    if (kind === 'folder-in') { if (levelOfFolder(id, S.R.folders) < 3) deny(); }
    else if (kind === 'folder') { const f = S.R.folders.get(id); if (f && levelOfFolder(id, S.R.folders) < 3) deny(); }
    else if (kind === 'plan') { const p = S.R.plans.get(id); if (p && levelOfPlan(id, S.R.plans, S.R.folders) < 3) deny(); }
  }
}
export const canEditHere = (folderId) => !isCloud() || isAdmin() || levelOfFolder(S.realFolder(folderId || null), S.R.folders) >= 3;
export const canEditPlan = (planId) => !isCloud() || isAdmin() || levelOfPlan(planId, S.R.plans, S.R.folders) >= 3;

// ---------- הפעלה ----------
// הפרש השעון מול השרת, כדי ש"השמירה האחרונה גוברת" תתבסס על זמן אחיד ולא על שעון הטלפון
async function syncClock() {
  try {
    const t0 = Date.now();
    const { data, error } = await client().rpc('ping');
    const t1 = Date.now();
    if (error || !data) return;
    st.offset = Math.round(new Date(data).getTime() - (t0 + t1) / 2);
    await db.put('meta', { key: 'clockOffset', v: st.offset });
  } catch { /* ignore */ }
}

export async function startSync() {
  if (!isCloud() || st.started) return;
  st.started = true;
  await loadTombs();
  st.offset = (await db.get('meta', 'clockOffset'))?.v || 0;
  S.hooks.now = () => Date.now() + st.offset;
  S.hooks.owner = () => cloud.user?.id || null;
  S.hooks.itemChange = () => { dirtyItems++; emitStatus(); schedulePush(); };
  S.hooks.itemDeleted = (store, rec) => { if (rec?._s) { tombs.push({ t: 'items', id: rec.id }); saveTombs(); } };
  await items.restoreShares();
  await items.adoptLegacy();
  await refreshDirty();
  syncClock();
  S.hooks.change = () => schedulePush();
  S.hooks.purged = onPurged;
  S.hooks.remoteFile = remoteFile;
  S.hooks.isLocal = (id) => localFiles.has(id);
  refreshLocalFiles();
  initBgDownloads();
  S.hooks.guard = guard;
  window.addEventListener('online', () => { emitStatus(); syncClock(); schedulePull(true, 300); schedulePush(300); });
  window.addEventListener('offline', emitStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { schedulePull(false, 300); schedulePush(300); } });
  setInterval(() => { if (document.visibilityState === 'visible') { schedulePull(false, 0); } }, 60000);
  try {
    const sb = client();
    const ch = sb.channel('plans-sync');
    for (const t of ['folders', 'plans', 'versions']) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => schedulePull(false, 700));
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => schedulePull(false, 400));
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'user_overrides' }, () => schedulePull(false, 400));
    for (const t of ['grants', 'item_shares', 'author_shares']) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => schedulePull(true, 500));
    ch.subscribe();
  } catch (e) { console.warn('realtime', e); }
  await pullAll();
  await pushAll();
}
export const syncNow = async () => { st.fullNext = true; await pullAll(); await pushAll(); };
