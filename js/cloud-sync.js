// סנכרון בין המסד המקומי (IndexedDB) לענן. כלל: השמירה האחרונה גוברת.
// שלב 1: תיקיות, תוכניות, גרסאות וקבצי ה-PDF (ב-Google Drive). שלב 2 יוסיף סימונים/מדידות/כיולים/קישורים.
import * as db from './db.js';
import * as S from './store.js';
import * as UI from './ui.js';
import { cloud, client, isCloud, isAdmin, levelOfFolder, levelOfPlan, callFn, authHeaders, fnUrl, loadGrants } from './cloud.js';

const st = { pushing: false, again: false, pulling: false, timer: 0, pullTimer: 0, err: '', last: 0, started: false, fullNext: true, denied: false };
const subs = new Set();
export const onSyncStatus = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export function syncStatus() {
  if (!isCloud()) return { kind: 'local', text: 'מצב מקומי' };
  if (!navigator.onLine) return { kind: 'offline', text: 'אין חיבור – השינויים יסונכרנו בהמשך' + (pendingCount() ? ` (${pendingCount()} ממתינים)` : '') };
  if (st.err) return { kind: 'error', text: 'שגיאת סנכרון: ' + st.err };
  if (st.pushing || st.pulling) return { kind: 'busy', text: 'מסנכרן…' };
  const n = pendingCount();
  if (n) return { kind: 'pending', text: `${n} שינויים ממתינים לסנכרון` };
  return { kind: 'ok', text: st.last ? 'מסונכרן ' + new Date(st.last).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : 'מחובר' };
}
const emitStatus = () => subs.forEach((f) => { try { f(syncStatus()); } catch { /* ignore */ } });

function pendingCount() {
  let n = 0;
  for (const m of [S.P.folders, S.P.plans, S.P.versions]) for (const r of m.values()) if (r._d) n++;
  return n + tombs.length;
}

// ---------- מחיקות שממתינות לענן ----------
let tombs = [];
async function loadTombs() { const r = await db.get('meta', 'tomb'); tombs = r?.list || []; }
const saveTombs = () => db.put('meta', { key: 'tomb', list: tombs });
function onPurged({ folderIds, planIds, versionIds }) {
  const add = (t, ids, map) => { for (const id of ids) if (map.get(id)?._s) tombs.push({ t, id }); };
  add('folders', folderIds, S.P.folders); add('plans', planIds, S.P.plans); add('versions', versionIds, S.P.versions);
  saveTombs(); schedulePush(300);
}

// ---------- המרות ----------
const strip = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith('_') && k !== 'driveId') o[k] = v; return o; };
const LOCAL_ONLY_VER = ['indexed', 'hasText', 'broken'];
async function blobToB64(blob) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => res(''); r.readAsDataURL(blob); });
}
function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}
const depth = (f) => { let d = 0, x = f, g = 0; while (x && x.parentId && g++ < 200) { d++; x = S.P.folders.get(x.parentId); } return d; };

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
    else if (error.code === '42501') return 'denied-new';
    else throw error;
  }
  if (!ok) {
    const { data, error } = await sb.from(table).update(row).eq('id', rec.id).select('id');
    if (error) throw error;
    if (!data || !data.length) return 'denied';
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
    await pushTombs();
    await pushFolders();
    await pushPlans();
    await pushVersions();
    st.last = Date.now();
  } catch (e) {
    console.warn('push', e);
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
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'אין חיבור לשרת';
  return m.slice(0, 120);
}

async function pushTombs() {
  if (!tombs.length) return;
  const sb = client();
  const keep = [];
  for (const t of tombs) {
    const { error } = await sb.from(t.t).update({ deleted: true }).eq('id', t.id);
    if (error && !/permission|violates/i.test(error.message || '')) { keep.push(t); throw error; }
  }
  tombs = keep; await saveTombs();
}

function deniedToast(what) { UI.toast(`אין לך הרשאה ל${what} – השינוי בוטל`, { type: 'error', ms: 4500 }); st.denied = true; }

async function pushFolders() {
  const list = [...S.P.folders.values()].filter((f) => f._d).sort((a, b) => depth(a) - depth(b));
  for (const f of list) {
    const r = await remoteWrite('folders', f, { id: f.id, parent_id: f.parentId || null, data: strip(f), deleted: false }, (x) => db.put('folders', x));
    if (r === 'denied') { f._d = 0; await db.put('folders', f); deniedToast('שינוי התיקייה'); }
    else if (r === 'denied-new') { deniedToast('יצירת תיקייה כאן'); await S.purgeLocal({ folderIds: [f.id] }); }
  }
}
async function pushPlans() {
  const list = [...S.P.plans.values()].filter((p) => p._d);
  for (const p of list) {
    const r = await remoteWrite('plans', p, { id: p.id, folder_id: p.folderId || null, data: strip(p), deleted: false }, (x) => db.put('plans', x));
    if (r === 'denied') { p._d = 0; await db.put('plans', p); deniedToast('שינוי התוכנית'); }
    else if (r === 'denied-new') {
      deniedToast('הוספת תוכניות כאן');
      await S.purgeLocal({ planIds: [p.id], versionIds: S.versionsOf(p.id).map((v) => v.id) });
    }
  }
}
async function pushVersions() {
  const list = [...S.P.versions.values()].filter((v) => v._d);
  for (const v of list) {
    const plan = S.P.plans.get(v.planId);
    if (!plan || !plan._s) continue; // התוכנית עוד לא בענן
    if (!v.driveId) {
      if (!(await uploadFile(v))) continue;
    }
    const th = await db.get('thumbs', v.id);
    const data = strip(v);
    for (const k of LOCAL_ONLY_VER) delete data[k];
    delete data.thumb;
    if (th?.blob && th.blob.size < 120000) data.thumb = await blobToB64(th.blob);
    const r = await remoteWrite('versions', v, { id: v.id, plan_id: v.planId, drive_file_id: v.driveId, data, deleted: false }, (x) => db.put('versions', x));
    if (r === 'denied') { v._d = 0; await db.put('versions', v); deniedToast('שינוי הגרסה'); }
    else if (r === 'denied-new') { deniedToast('הוספת גרסה'); await S.purgeLocal({ versionIds: [v.id] }); }
  }
}

// העלאת ה-PDF ל-Drive: השרת בודק הרשאה ופותח session, והטלפון מעלה ישירות לגוגל.
async function uploadFile(v) {
  const rec = await db.get('files', v.id);
  if (!rec?.blob) return false;
  const blob = rec.blob;
  UI.toast(`מעלה לענן: ${v.fileName || 'תוכנית'}…`, { ms: 2500 });
  const s = await callFn('drive-upload-session', { planId: v.planId, name: v.fileName || 'plan.pdf', size: blob.size });
  let putOk = false;
  try {
    const r = await fetch(s.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: blob });
    putOk = r.ok;
  } catch (e) { console.warn('PUT (ייתכן CORS, מאמתים מול השרת)', e); }
  const chk = await callFn('drive-upload-session', { action: 'verify', fileId: s.fileId }).catch(() => null);
  if (!chk?.exists || chk.size !== blob.size) throw new Error(putOk ? 'ההעלאה לא אומתה' : 'ההעלאה ל-Drive נכשלה');
  v.driveId = s.fileId; v._up = 0;
  await db.put('versions', v);
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

async function fetchChanged(table) {
  const sb = client(); const since = await getSince(table);
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
  try {
    if (full) await loadGrants();
    const F = await fetchChanged('folders'), Pl = await fetchChanged('plans'), V = await fetchChanged('versions');
    const puts = { folders: [], plans: [], versions: [] }, purge = { folderIds: [], planIds: [], versionIds: [] }, thumbs = [];

    for (const r of F.rows) {
      const loc = S.P.folders.get(r.id); if (loc?._d) continue;
      if (r.deleted) { if (loc) purge.folderIds.push(r.id); continue; }
      puts.folders.push({ ...r.data, id: r.id, parentId: r.parent_id || null, _s: 1, _srv: r.updated_at });
    }
    for (const r of Pl.rows) {
      const loc = S.P.plans.get(r.id); if (loc?._d) continue;
      if (r.deleted) { if (loc) purge.planIds.push(r.id); continue; }
      puts.plans.push({ ...r.data, id: r.id, folderId: r.folder_id || null, _s: 1, _srv: r.updated_at });
    }
    for (const r of V.rows) {
      const loc = S.P.versions.get(r.id); if (loc?._d) continue;
      if (r.deleted) { if (loc) purge.versionIds.push(r.id); continue; }
      const d = { ...r.data }; const th = d.thumb; delete d.thumb;
      puts.versions.push({ ...d, id: r.id, planId: r.plan_id, driveId: r.drive_file_id, _s: 1, _srv: r.updated_at,
        indexed: loc?.indexed ?? false, hasText: loc?.hasText ?? false, broken: loc?.broken ?? false });
      if (th && !(await db.get('thumbs', r.id))) thumbs.push({ id: r.id, blob: b64ToBlob(th) });
    }
    if (puts.folders.length) await db.putMany('folders', puts.folders);
    if (puts.plans.length) await db.putMany('plans', puts.plans);
    if (puts.versions.length) await db.putMany('versions', puts.versions);
    if (thumbs.length) await db.putMany('thumbs', thumbs);

    // התאמה מלאה: מה שכבר לא נראה לי בענן (נמחק או שההרשאה הוסרה) נמחק מהמכשיר
    if (full) {
      const [fi, pi, vi] = await Promise.all([fetchIds('folders'), fetchIds('plans'), fetchIds('versions')]);
      for (const f of S.P.folders.values()) if (f._s && !f._d && !fi.has(f.id) && !puts.folders.some((x) => x.id === f.id)) purge.folderIds.push(f.id);
      for (const p of S.P.plans.values()) if (p._s && !p._d && !pi.has(p.id) && !puts.plans.some((x) => x.id === p.id)) purge.planIds.push(p.id);
      for (const v of S.P.versions.values()) if (v._s && !v._d && !vi.has(v.id) && !puts.versions.some((x) => x.id === v.id)) purge.versionIds.push(v.id);
    }
    const maxOf = (rows, since) => rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), since);
    if (purge.folderIds.length || purge.planIds.length || purge.versionIds.length) await S.purgeLocal(purge);
    else if (puts.folders.length || puts.plans.length || puts.versions.length) await S.reload();
    await setSince('folders', maxOf(F.rows, F.since)); await setSince('plans', maxOf(Pl.rows, Pl.since)); await setSince('versions', maxOf(V.rows, V.since));
    st.err = ''; st.last = Date.now();
    for (const v of puts.versions) if (!v.indexed) { /* ייאונדקס אחרי הורדת הקובץ */ }
  } catch (e) {
    console.warn('pull', e); st.err = friendly(e);
  } finally {
    st.pulling = false; emitStatus();
  }
}

// ---------- הורדת קובץ מהענן (לפי דרישה) ----------
const inflight = new Map();
async function remoteFile(versionId) {
  const v = S.P.versions.get(versionId);
  if (!isCloud() || !v?.driveId) return null;
  if (!navigator.onLine) { UI.toast('אין חיבור לאינטרנט, והקובץ הזה עוד לא הורד למכשיר', { type: 'error', ms: 4500 }); return null; }
  if (inflight.has(versionId)) return inflight.get(versionId);
  const pr = (async () => {
    const pb = UI.progressBox ? UI.progressBox('מוריד את התוכנית מהענן…') : null;
    try {
      const res = await fetch(`${fnUrl('drive-download')}?v=${encodeURIComponent(versionId)}`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(res.status === 404 ? 'אין הרשאה או שהקובץ לא נמצא' : 'ההורדה נכשלה (' + res.status + ')');
      const total = Number(res.headers.get('content-length')) || v.size || 0;
      const chunks = []; let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (pb && total) pb.set(`מוריד… ${Math.round((got / 1048576) * 10) / 10}MB`, Math.min(0.99, got / total));
      }
      const blob = new Blob(chunks, { type: 'application/pdf' });
      if (v.size && blob.size !== v.size) throw new Error('הקובץ שהורד לא שלם, נסו שוב');
      await db.put('files', { id: versionId, blob });
      S.enqueueIndex(versionId);
      return blob;
    } catch (e) {
      UI.toast(friendly(e), { type: 'error', ms: 5000 });
      return null;
    } finally { pb?.close(); inflight.delete(versionId); }
  })();
  inflight.set(versionId, pr);
  return pr;
}

// ---------- הרשאות בצד הממשק ----------
function guard(kind, ids) {
  if (!isCloud() || isAdmin()) return;
  const deny = () => { throw new Error('אין לך הרשאת עריכה כאן'); };
  for (const id of ids) {
    if (kind === 'folder-in') { if (levelOfFolder(id, S.P.folders) < 3) deny(); }
    else if (kind === 'folder') { const f = S.P.folders.get(id); if (f && levelOfFolder(id, S.P.folders) < 3) deny(); }
    else if (kind === 'plan') { const p = S.P.plans.get(id); if (p && levelOfPlan(id, S.P.plans, S.P.folders) < 3) deny(); }
  }
}
export const canEditHere = (folderId) => !isCloud() || isAdmin() || levelOfFolder(folderId || null, S.P.folders) >= 3;
export const canEditPlan = (planId) => !isCloud() || isAdmin() || levelOfPlan(planId, S.P.plans, S.P.folders) >= 3;

// ---------- הפעלה ----------
export async function startSync() {
  if (!isCloud() || st.started) return;
  st.started = true;
  await loadTombs();
  S.hooks.change = () => schedulePush();
  S.hooks.purged = onPurged;
  S.hooks.remoteFile = remoteFile;
  S.hooks.guard = guard;
  window.addEventListener('online', () => { emitStatus(); schedulePull(true, 300); schedulePush(300); });
  window.addEventListener('offline', emitStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { schedulePull(false, 300); schedulePush(300); } });
  setInterval(() => { if (document.visibilityState === 'visible') { schedulePull(false, 0); } }, 60000);
  try {
    const sb = client();
    const ch = sb.channel('plans-sync');
    for (const t of ['folders', 'plans', 'versions']) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => schedulePull(false, 700));
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'grants' }, () => schedulePull(true, 500));
    ch.subscribe();
  } catch (e) { console.warn('realtime', e); }
  await pullAll();
  await pushAll();
}
export const syncNow = async () => { st.fullNext = true; await pullAll(); await pushAll(); };
