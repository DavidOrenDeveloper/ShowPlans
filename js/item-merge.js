// ליבת הסנכרון של סימונים/מדידות/קישורים/כיולים: המרות והכרעת התנגשויות.
// בלי תלות בדפדפן, כדי שאפשר יהיה לבדוק אותה בנפרד (ראו tools/test-item-merge.mjs).

export const ITEM_KINDS = ['markups', 'measurements', 'links', 'calibrations'];
export const SHARED_KINDS = ['links']; // משותפים לכל מי שרואה את התוכנית

// מה נשמר בעמודת data בענן: כל הרשומה ללא שדות פנימיים (_xxx) וללא ownerId (עמודה נפרדת)
export function stripItem(rec) {
  const o = {};
  for (const [k, v] of Object.entries(rec)) if (!k.startsWith('_') && k !== 'ownerId') o[k] = v;
  return o;
}

// רשומה מקומית -> שורה לענן. planId נגזר מהגרסה אם חסר (כיולים לא שומרים אותו)
export function toRow(store, rec, planId, meId) {
  return { id: rec.id, version_id: rec.versionId, plan_id: planId, kind: store, owner_id: rec.ownerId || meId, data: stripItem(rec), deleted: false };
}

// שורה מהענן -> רשומה מקומית
export function fromRow(row) {
  return { ...(row.data || {}), id: row.id, versionId: row.version_id, planId: row.plan_id, ownerId: row.owner_id, _s: 1, _d: 0, _rev: 0, _srv: row.updated_at };
}

// כשמתגלה שהשורה בענן השתנתה מאז שראינו אותה:
//  'push'   – השינוי המקומי חדש יותר (לפי זמן העריכה): דוחפים אותו
//  'remote' – מה שבענן חדש יותר: לוקחים אותו ומבטלים את השינוי המקומי
//  'drop'   – הפריט נמחק בענן: מחיקה גוברת, מסירים אותו מהמכשיר
// החזרת פריט שנמחק במכוון (ביטול מחיקה, _rev) גוברת על מחיקה קודמת.
export function decide(local, remote) {
  if (remote.deleted) return local._rev ? 'push' : 'drop';
  const r = Number(remote.data && remote.data.updatedAt) || 0;
  return (Number(local.updatedAt) || 0) >= r ? 'push' : 'remote';
}

// רמת הגישה של המשתמש לפריט, לממשק בלבד (האכיפה האמיתית ב-RLS): 'edit' | 'view' | 'none'
// ctx: { me, isAdmin, planLevel (0-3), itemShares: Map(itemId->'view'|'edit'), authorShares: [{author_id, plan_id, folder_id, level}], planInFolder(planId, folderId) }
export function accessLevel(it, store, ctx) {
  if (ctx.isAdmin) return 'edit';
  const lvl = ctx.planLevel || 0;
  if (lvl < 1) return 'none';
  if (SHARED_KINDS.includes(store)) return lvl >= 3 ? 'edit' : 'view';
  if (store === 'calibrations' && !(it.ownerId && it.ownerId === ctx.me)) return it.shared ? 'view' : 'none'; // כיול פרטי לכל משתמש; המנהל יכול לשתף
  if (it.ownerId && it.ownerId === ctx.me) return lvl >= 2 ? 'edit' : 'view';
  let best = 0;
  const rank = (l) => (l === 'edit' ? 2 : l === 'view' ? 1 : 0);
  best = Math.max(best, rank(ctx.itemShares && ctx.itemShares.get(it.id)));
  for (const a of ctx.authorShares || []) {
    if (a.author_id !== it.ownerId) continue;
    const inScope = (!a.plan_id && !a.folder_id) || a.plan_id === it.planId || (a.folder_id && ctx.planInFolder(it.planId, a.folder_id));
    if (inScope) best = Math.max(best, rank(a.level));
  }
  return best >= 2 ? 'edit' : best === 1 ? 'view' : 'none';
}
