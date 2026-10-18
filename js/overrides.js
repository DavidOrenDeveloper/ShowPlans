// שורות השכבה האישית של המשתמש הנוכחי: שמירה מקומית וסנכרון לטבלה user_overrides.
// שורה: { id, kind, data, _d (ממתינה לשליחה), _s (קיימת בשרת), _del (מחיקה ממתינה) }
import * as db from './db.js';

export const OV = { rows: new Map(), onLocalChange: () => {}, loaded: false };
const save = () => db.put('meta', { key: 'ov:self', rows: [...OV.rows.values()] });

export async function load() {
  const r = await db.get('meta', 'ov:self');
  OV.rows = new Map(((r && r.rows) || []).map((x) => [x.id, x]));
  OV.loaded = true;
}
export function activeRows() {
  const m = new Map();
  for (const [id, r] of OV.rows) if (!r._del) m.set(id, r);
  return m;
}
export const get = (id) => { const r = OV.rows.get(id); return r && !r._del ? r : null; };

async function commit(changedLocal = true) { await save(); if (changedLocal) OV.onLocalChange(); }

export async function put(id, kind, data) {
  const cur = OV.rows.get(id);
  OV.rows.set(id, { id, kind, data, _d: 1, _s: cur ? cur._s : 0 });
  await commit();
}
// מיזוג שדות; ערך undefined מסיר את השדה. שורה ריקה של folder/plan נמחקת.
export async function merge(id, kind, patch) {
  const cur = get(id);
  const data = { ...(cur ? cur.data : {}), ...patch };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  if (!Object.keys(data).length && kind !== 'pfolder') return remove(id);
  return put(id, kind, data);
}
export async function remove(id) {
  const r = OV.rows.get(id); if (!r) return;
  if (r._s) OV.rows.set(id, { ...r, _del: 1, _d: 1 }); else OV.rows.delete(id);
  await commit();
}
export async function removeMany(ids) {
  for (const id of ids) { const r = OV.rows.get(id); if (!r) continue; if (r._s) OV.rows.set(id, { ...r, _del: 1, _d: 1 }); else OV.rows.delete(id); }
  await commit();
}
export const dirtyCount = () => { let n = 0; for (const r of OV.rows.values()) if (r._d) n++; return n; };

// שליחה לשרת. מחזיר כמה שורות נשלחו.
export async function push(sb, me) {
  let n = 0;
  for (const r of [...OV.rows.values()].filter((x) => x._d)) {
    if (r._del) {
      const { error } = await sb.from('user_overrides').delete().eq('user_id', me).eq('id', r.id);
      if (error) throw error;
      if (OV.rows.get(r.id) === r) OV.rows.delete(r.id);
    } else {
      const { error } = await sb.from('user_overrides').upsert({ user_id: me, id: r.id, kind: r.kind, data: r.data }, { onConflict: 'user_id,id' });
      if (error) throw error;
      if (OV.rows.get(r.id) === r) OV.rows.set(r.id, { ...r, _d: 0, _s: 1 }); // אם השתנתה בינתיים – נשארת מלוכלכת
    }
    n++;
  }
  if (n) await save();
  return n;
}
// משיכה: השרת הוא מקור האמת לכל מה שלא ממתין אצלי לשליחה. מחזיר true אם משהו השתנה.
export async function pull(sb, me) {
  const { data, error } = await sb.from('user_overrides').select('id,kind,data').eq('user_id', me);
  if (error) throw error;
  const srv = new Map(data.map((r) => [r.id, r]));
  let changed = false;
  for (const [id, r] of srv) {
    const loc = OV.rows.get(id);
    if (loc && loc._d) continue;
    if (!loc || loc._del || JSON.stringify(loc.data) !== JSON.stringify(r.data) || loc.kind !== r.kind) { OV.rows.set(id, { id, kind: r.kind, data: r.data, _d: 0, _s: 1 }); changed = true; }
  }
  for (const [id, loc] of [...OV.rows]) if (!srv.has(id) && !loc._d) { OV.rows.delete(id); changed = true; }
  if (changed) await save();
  return changed;
}
// למנהל ("צפייה כעובד"): השורות של עובד אחר
export async function fetchOf(sb, userId) {
  const { data, error } = await sb.from('user_overrides').select('id,kind,data').eq('user_id', userId);
  if (error) throw error;
  return new Map(data.map((r) => [r.id, { id: r.id, kind: r.kind, data: r.data }]));
}
