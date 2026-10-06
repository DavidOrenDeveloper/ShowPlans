// חיבור לענן (Supabase): התחברות, תפקידים והרשאות. אם לא מחוברים – האפליקציה עובדת מקומית כמו קודם.
import { createClient } from '../lib/supabase.js';
import { CLOUD } from './config.js';
import * as db from './db.js';

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
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'אימייל או סיסמה שגויים' : error.message);
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
const RANK = { view: 1, mark: 2, edit: 3 };
export function levelOfFolder(id, folders) {
  if (!isCloud()) return 4;
  if (isAdmin()) return 4;
  let best = 0, f = id ? folders.get(id) : null, g = 0;
  while (f && g++ < 200) {
    for (const gr of cloud.grants) if (gr.folder_id === f.id) best = Math.max(best, RANK[gr.level] || 0);
    f = f.parentId ? folders.get(f.parentId) : null;
  }
  return best;
}
export function levelOfPlan(id, plans, folders) {
  if (!isCloud()) return 4;
  if (isAdmin()) return 4;
  const p = plans.get(id); if (!p) return 0;
  let best = levelOfFolder(p.folderId || null, folders);
  for (const gr of cloud.grants) if (gr.plan_id === id) best = Math.max(best, RANK[gr.level] || 0);
  return best;
}

// ---------- קריאות לפונקציות השרת ----------
export const fnUrl = (name) => `${CLOUD.url}/functions/v1/${name}`;
export async function authHeaders(extra = {}) {
  const { data: { session } } = await client().auth.getSession();
  if (!session) throw new Error('לא מחובר');
  return { Authorization: `Bearer ${session.access_token}`, apikey: CLOUD.key, ...extra };
}
export async function callFn(name, body) {
  const res = await fetch(fnUrl(name), { method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  let j = null; try { j = await res.json(); } catch { /* ignore */ }
  if (!res.ok) { const e = new Error(j?.message || j?.error || ('שגיאה ' + res.status)); e.status = res.status; e.code = j?.error; throw e; }
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
          return r;
        });
        await db.putMany(name, rows);
      }
    }
  } finally { src.close(); }
}
