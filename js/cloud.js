// חיבור לענן (Supabase): התחברות, תפקידים והרשאות. אם לא מחוברים – האפליקציה עובדת מקומית כמו קודם.
import { t as tr } from './i18n.js';
import { createClient } from '../lib/supabase.js';
import { CLOUD } from './config.js';
import * as db from './db.js';
import * as diag from './diag.js';

const LS = 'plans.cloud.';
const ls = {
  get: (k) => { try { return localStorage.getItem(LS + k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(LS + k) : localStorage.setItem(LS + k, v); } catch { /* ignore */ } },
};

export const cloud = {
  sb: null,
  mode: 'local',        // 'local' | 'cloud'
  needLogin: false,
  user: null,           // { id, email }
  profile: null,        // { id, email, display_name, role }
  grants: [],           // ההרשאות שלי (לעובד)
  recovery: false,      // נכנסו דרך קישור "שכחתי סיסמה"
  linkError: '',
};
export const configured = () => !!(CLOUD.url && CLOUD.key);
export const isAdmin = () => cloud.mode === 'cloud' && cloud.profile?.role === 'admin';
export const isCloud = () => cloud.mode === 'cloud';

export function client() {
  if (!cloud.sb) {
    cloud.sb = createClient(CLOUD.url, CLOUD.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'plans-auth', detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  return cloud.sb;
}

export function dbNameFor() { return cloud.mode === 'cloud' && cloud.user ? 'planapp-' + cloud.user.id : 'planapp'; }

export async function initCloud() {
  if (!configured()) return cloud;
  const sb = client();
  await handleAuthLink(sb);
  const pref = ls.get('mode');
  let session = null;
  try { ({ data: { session } } = await sb.auth.getSession()); } catch (e) { console.warn('getSession', e); }
  const cachedUid = ls.get('uid');
  if (session?.user) {
    cloud.user = { id: session.user.id, email: session.user.email };
    ls.set('uid', cloud.user.id);
  } else if (cachedUid && pref === 'cloud' && !navigator.onLine) {
    cloud.user = { id: cachedUid, email: ls.get('email') || '' }; // אופליין עם חיבור קודם
  }
  if (cloud.user) {
    cloud.mode = 'cloud';
    await loadProfile();
  } else if (pref === 'local') {
    cloud.mode = 'local';
  } else {
    cloud.needLogin = true;
  }
  return cloud;
}

// קישור מהמייל (איפוס סיסמה) מגיע כ-#access_token=...&type=recovery. הנתב של האפליקציה משתמש ב-# ולכן מטפלים בזה ידנית.
async function handleAuthLink(sb) {
  const hash = location.hash || '';
  if (!/access_token=|error_description=|type=recovery/.test(hash)) return;
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''));
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  if (q.get('error_description')) { cloud.linkError = tr('הקישור לא תקין או שפג תוקפו. בקשו קישור חדש.'); return; }
  if (q.get('access_token') && q.get('refresh_token')) {
    const { error } = await sb.auth.setSession({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token') });
    if (error) { cloud.linkError = tr('הקישור לא תקין או שפג תוקפו. בקשו קישור חדש.'); return; }
    if (q.get('type') === 'recovery') cloud.recovery = true;
  }
}
export async function requestPasswordReset(email) {
  const redirectTo = location.origin + location.pathname;
  const { error } = await client().auth.resetPasswordForEmail(email.trim(), { redirectTo });
  if (error) throw new Error(/rate|seconds/i.test(error.message) ? tr('נשלח כבר מייל לאחרונה. המתינו דקה ונסו שוב.') : error.message);
}
export async function setNewPassword(pw) {
  const { error } = await client().auth.updateUser({ password: pw });
  if (error) throw new Error(/same|different/i.test(error.message) ? tr('הסיסמה החדשה זהה לקודמת') : error.message);
}

export async function loadProfile() {
  const cached = ls.get('profile');
  try {
    const { data, error } = await client().from('profiles').select('*').eq('id', cloud.user.id).maybeSingle();
    if (error) throw error;
    if (data) { cloud.profile = data; ls.set('profile', JSON.stringify(data)); }
  } catch (e) {
    if (!cloud.profile && cached) { try { const p = JSON.parse(cached); if (p.id === cloud.user.id) cloud.profile = p; } catch { /* ignore */ } }
  }
  if (!cloud.profile) cloud.profile = { id: cloud.user.id, email: cloud.user.email, role: 'worker', display_name: cloud.user.email };
  await loadGrants();
}

export async function loadGrants() {
  if (isAdmin()) { cloud.grants = []; return; }
  try {
    const { data, error } = await client().from('grants').select('*').eq('user_id', cloud.user.id);
    if (error) throw error;
    cloud.grants = data || [];
    ls.set('grants', JSON.stringify(cloud.grants));
  } catch {
    try { cloud.grants = JSON.parse(ls.get('grants') || '[]'); } catch { cloud.grants = []; }
  }
}

export async function signIn(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? tr('אימייל או סיסמה שגויים') : error.message);
  cloud.user = { id: data.user.id, email: data.user.email };
  ls.set('uid', cloud.user.id); ls.set('email', cloud.user.email); ls.set('mode', 'cloud');
  cloud.mode = 'cloud'; cloud.needLogin = false;
  await loadProfile();
  return cloud;
}
export function chooseLocal() { ls.set('mode', 'local'); cloud.mode = 'local'; cloud.needLogin = false; }
export async function signOut() {
  try { await client().auth.signOut(); } catch { /* ignore */ }
  ls.set('mode', null); ls.set('uid', null); ls.set('profile', null); ls.set('grants', null);
  location.hash = '#/'; location.reload();
}
export function switchToLogin() { ls.set('mode', null); location.reload(); }

// ---------- רמות הרשאה (חישוב מקומי לממשק בלבד; האכיפה האמיתית היא ב-RLS בשרת) ----------
export const RANK = { none: 0, view: 1, mark: 2, edit: 3 };
// ההרשאה הקרובה ביותר קובעת: הרשאה על התוכנית עצמה, אחרת על התיקייה שלה, אחרת על תיקיית האב וכן הלאה.
// רמה 'none' היא חסימה מפורשת (מבטלת גישה שירשה התוכנית מתיקייה). כך אפשר לתת גישה לתיקייה ולחסום תוכנית אחת בתוכה.
export function folderLevelFrom(grants, id, folders) {
  let f = id ? folders.get(id) : null, g = 0;
  while (f && g++ < 200) {
    const gr = grants.find((x) => x.folder_id === f.id);
    if (gr) return RANK[gr.level] || 0;
    f = f.parentId ? folders.get(f.parentId) : null;
  }
  return 0;
}
export function planLevelFrom(grants, plan, folders) {
  if (!plan) return 0;
  const d = grants.find((x) => x.plan_id === plan.id);
  if (d) return RANK[d.level] || 0;
  return folderLevelFrom(grants, plan.folderId || null, folders);
}
export function levelOfFolder(id, folders) {
  if (!isCloud()) return 4;
  if (isAdmin()) return 4;
  return folderLevelFrom(cloud.grants, id, folders);
}
export function levelOfPlan(id, plans, folders) {
  if (!isCloud()) return 4;
  if (isAdmin()) return 4;
  return planLevelFrom(cloud.grants, plans.get(id), folders);
}

// ---------- קריאות לפונקציות השרת ----------
export const fnUrl = (name) => `${CLOUD.url}/functions/v1/${name}`;
export async function authHeaders(extra = {}) {
  const { data: { session } } = await client().auth.getSession();
  if (!session) throw new Error(tr('לא מחובר'));
  return { Authorization: `Bearer ${session.access_token}`, apikey: CLOUD.key, ...extra };
}
export async function callFn(name, body) {
  let res;
  try { res = await fetch(fnUrl(name), { method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) }); }
  catch (e) { if (e && typeof e === 'object') { e.where = e.where || 'fn:' + name; e.fn = name; } diag.err('fn:' + name, e, { phase: 'network' }); throw e; }
  let j = null; try { j = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error(j?.message || j?.error || (tr('שגיאה ') + res.status));
    e.status = res.status; e.code = j?.error; e.fn = name; e.step = j?.step; e.serverStatus = j?.status; e.where = 'fn:' + name;
    diag.err('fn:' + name, e, { action: body?.action || undefined });
    throw e;
  }
  return j;
}

// ---------- העתקת הנתונים המקומיים הקיימים אל חשבון הענן ----------
export async function localDataSummary() {
  if (db.dbName() === 'planapp') return null;
  return new Promise((res) => {
    const r = indexedDB.open('planapp');
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('plans')) { d.close(); return res(null); }
      const q = d.transaction('plans').objectStore('plans').count();
      q.onsuccess = () => { const n = q.result; d.close(); res(n ? { plans: n } : null); };
      q.onerror = () => { d.close(); res(null); };
    };
  });
}
export async function copyLocalIntoCurrent(onProgress = () => {}) {
  const src = await new Promise((res, rej) => { const r = indexedDB.open('planapp'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    for (const name of Object.keys(db.STORES)) {
      if (!src.objectStoreNames.contains(name) || name === 'meta' || name === 'projects') continue;
      onProgress(name);
      const keys = await new Promise((res, rej) => { const q = src.transaction(name).objectStore(name).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      for (let i = 0; i < keys.length; i += 10) {
        const chunk = await Promise.all(keys.slice(i, i + 10).map((k) => new Promise((res, rej) => { const q = src.transaction(name).objectStore(name).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); })));
        const rows = chunk.filter(Boolean).map((r) => {
          if (name === 'folders' || name === 'plans') return { ...r, _d: 1, _s: 0 };
          if (name === 'versions') return { ...r, _d: 1, _up: 1, _s: 0, driveId: null };
          if (['markups', 'measurements', 'links', 'calibrations'].includes(name)) return { ...r, ownerId: cloud.user?.id, updatedAt: r.updatedAt || r.createdAt || Date.now(), _d: 1, _s: 0 };
          return r;
        });
        await db.putMany(name, rows);
      }
    }
  } finally { src.close(); }
}
