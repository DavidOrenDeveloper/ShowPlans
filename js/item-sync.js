// סנכרון סימונים, מדידות, קישורים וכיולים בין המכשיר לענן (טבלת items).
// מנוע בלי תלות ישירה בדפדפן: כל התלויות מגיעות מ-env, כדי שאפשר יהיה לבדוק אותו (ראו item-merge.js).
// כללים: מחיקה = deleted=true (tombstone). התנגשות: העריכה החדשה לפי זמן עריכה גוברת; מחיקה גוברת על עריכה.
import { ITEM_KINDS, SHARED_KINDS, toRow, fromRow, decide, accessLevel } from './item-merge.js';

export function createItemSync(env) {
  const shares = { items: new Map(), authors: [] };

  // ---------- דחיפה ----------
  async function pushOne(store, rec) {
    const planId = rec.planId || env.planOfVersion(rec.versionId);
    if (!planId || !env.planSynced(planId)) return 'wait'; // התוכנית עוד לא בענן
    const sb = env.sb();
    const stampv = rec.updatedAt;
    const row = toRow(store, rec, planId, env.me());

    const finish = async (updatedAt) => {
      const latest = await env.db.get(store, rec.id);
      if (!latest) { env.addTomb({ t: 'items', id: rec.id }); return 'ok'; } // נמחק בזמן ההעלאה: מוחקים גם בענן
      latest._s = 1; latest._srv = updatedAt; latest._rev = 0; latest.planId = latest.planId || planId;
      if (latest.updatedAt === stampv) latest._d = 0;
      await env.db.put(store, latest);
      return 'ok';
    };

    let skipUpdate = false;
    if (!rec._s) {
      const { data, error } = await sb.from('items').insert(row).select('id,updated_at');
      if (!error && data && data.length) return finish(data[0].updated_at);
      if (error && error.code === '42501') return denyNew(store, rec, planId);
      if (error && error.code !== '23505') throw error;
      rec = { ...rec, _srv: null }; skipUpdate = true; // כבר קיים בענן: קודם מכריעים מול הגרסה שבענן
    }

    const upd = { version_id: row.version_id, plan_id: planId, data: row.data, deleted: false };
    for (let i = 0; i < 4; i++) {
      if (!skipUpdate) {
        let q = sb.from('items').update(upd).eq('id', rec.id);
        if (!rec._rev && rec._srv) q = q.eq('updated_at', rec._srv); // עדכון מותנה: רק אם לא השתנה בענן מאז שראינו
        const { data, error } = await q.select('id,updated_at');
        if (error) throw error;
        if (data && data.length) return finish(data[0].updated_at);
      }
      skipUpdate = false;

      // לא עודכנה שורה: או שמישהו שינה אותה, או שאין הרשאה, או שהיא לא נראית לנו
      const { data: cur, error: e2 } = await sb.from('items').select('id,updated_at,deleted,owner_id,version_id,plan_id,kind,data').eq('id', rec.id).maybeSingle();
      if (e2) throw e2;
      if (!cur) { await env.db.delManyIfClean(store, [rec.id]); return 'gone'; }
      if (rec._srv && cur.updated_at === rec._srv && !cur.deleted) {
        await env.db.put(store, fromRow(cur)); return 'denied-edit'; // לא השתנה בענן ובכל זאת נדחה = אין הרשאת עריכה. מחזירים את הגרסה שבענן
      }
      const d = decide(rec, cur);
      if (d === 'drop') { await env.db.del(store, rec.id); return 'dropped'; }
      if (d === 'remote') { await env.db.put(store, fromRow(cur)); return 'remote'; }
      rec = { ...rec, _srv: cur.updated_at }; // שלנו חדש יותר: מנסים שוב מול הגרסה העדכנית
    }
    return 'retry';
  }

  async function denyNew(store, rec, planId) {
    const need = SHARED_KINDS.includes(store) ? 3 : 2;
    if (env.isAdmin() || env.planLevel(planId) >= need) {
      // לפי ההרשאות שלנו מותר, והשרת דוחה: כנראה מדיניות השרת לא עודכנה. לא מוחקים את העבודה
      env.log.warn('items', 'השרת דחה הוספת פריט למרות שלפי ההרשאות מותר (ייתכן שקובץ ה-SQL החדש עוד לא הורץ)', { id: rec.id, kind: store });
      return 'blocked';
    }
    await env.db.del(store, rec.id);
    return 'denied-new';
  }

  async function push() {
    const res = { ok: 0, wait: 0, 'denied-edit': 0, 'denied-new': 0, blocked: 0, gone: 0, dropped: 0, remote: 0, retry: 0 };
    const touched = new Set();
    for (const store of ITEM_KINDS) {
      const list = (await env.db.getAll(store)).filter((r) => r._d);
      for (const rec of list) {
        const r = await pushOne(store, rec);
        res[r] = (res[r] || 0) + 1;
        if (r !== 'ok' && r !== 'wait' && r !== 'blocked' && r !== 'retry') touched.add(rec.versionId);
      }
    }
    if (touched.size) env.emit([...touched]);
    return res;
  }

  // ---------- משיכה ----------
  async function pull(full) {
    const { rows, since } = await env.fetchChanged('items');
    const touched = new Set();
    const byStore = new Map(ITEM_KINDS.map((k) => [k, { puts: [], dels: [] }]));
    for (const r of rows) {
      const b = byStore.get(r.kind); if (!b) continue;
      const loc = await env.db.get(r.kind, r.id);
      if (loc && !loc._d && loc._srv === r.updated_at) continue; // הד של השינוי שלנו
      touched.add(r.version_id);
      if (r.deleted) { if (loc) b.dels.push(r.id); } else b.puts.push(fromRow(r));
    }
    // התאמה מלאה: מה שכבר לא נראה לנו בענן (נמחק, או שהשיתוף/ההרשאה בוטלו) מוסר מהמכשיר.
    // מועמדים נקבעים לפני שליפת הרשימה, כדי לא למחוק פריט שנוצר בינתיים.
    const cands = new Map();
    if (full) for (const store of ITEM_KINDS) cands.set(store, (await env.db.getAll(store)).filter((r) => r._s && !r._d));
    const ids = full ? await env.fetchIds('items') : null;
    for (const store of ITEM_KINDS) {
      const b = byStore.get(store);
      if (full) for (const r of cands.get(store)) if (!ids.has(r.id) && !b.puts.some((x) => x.id === r.id)) { b.dels.push(r.id); touched.add(r.versionId); }
      if (b.puts.length) await env.db.putManyIfClean(store, b.puts);
      if (b.dels.length) await env.db.delManyIfClean(store, b.dels);
    }
    const maxAt = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), since);
    await env.setSince('items', maxAt);
    if (full) await loadShares();
    if (touched.size) env.emit([...touched]);
    return { changed: touched.size };
  }

  // ---------- שיתופים שניתנו לי (לממשק: מה מותר לי לערוך) ----------
  async function loadShares() {
    if (env.isAdmin()) return;
    try {
      const sb = env.sb(), me = env.me();
      const [a, b] = await Promise.all([
        sb.from('item_shares').select('item_id,level').eq('user_id', me),
        sb.from('author_shares').select('author_id,plan_id,folder_id,level').eq('viewer_id', me),
      ]);
      if (a.error || b.error) throw (a.error || b.error);
      shares.items = new Map((a.data || []).map((r) => [r.item_id, r.level]));
      shares.authors = b.data || [];
      await env.db.put('meta', { key: 'shares', items: [...shares.items], authors: shares.authors });
    } catch (e) {
      const c = await env.db.get('meta', 'shares').catch(() => null);
      if (c) { shares.items = new Map(c.items || []); shares.authors = c.authors || []; }
      env.log.warn('items', 'טעינת השיתופים נכשלה (משתמשים במה ששמור במכשיר)', { msg: String(e && e.message) });
    }
  }
  async function restoreShares() {
    const c = await env.db.get('meta', 'shares').catch(() => null);
    if (c) { shares.items = new Map(c.items || []); shares.authors = c.authors || []; }
  }

  // 'edit' | 'view' | 'none' – לממשק בלבד; האכיפה האמיתית בשרת
  function levelOf(it, store) {
    const planId = it.planId || env.planOfVersion(it.versionId);
    return accessLevel({ ...it, planId }, store, {
      me: env.me(), isAdmin: env.isAdmin(), planLevel: env.planLevel(planId),
      itemShares: shares.items, authorShares: shares.authors, planInFolder: env.planInFolder,
    });
  }

  // ---------- עזרים ----------
  // פריטים שנוצרו לפני שהענן הופעל במכשיר הזה: מסמנים להעלאה בבעלות המשתמש הנוכחי
  async function adoptLegacy() {
    let n = 0;
    for (const store of ITEM_KINDS) {
      const all = await env.db.getAll(store);
      const mine = all.filter((r) => r._s === undefined && r._d === undefined);
      if (!mine.length) continue;
      await env.db.putMany(store, mine.map((r) => ({ ...r, ownerId: r.ownerId || env.me(), updatedAt: r.updatedAt || r.createdAt || env.now(), _d: 1, _s: 0 })));
      n += mine.length;
    }
    return n;
  }
  async function dirtyCount() {
    let n = 0;
    for (const store of ITEM_KINDS) n += (await env.db.getAll(store)).filter((r) => r._d).length;
    return n;
  }

  return { push, pull, pushOne, loadShares, restoreShares, levelOf, adoptLegacy, dirtyCount, shares };
}
