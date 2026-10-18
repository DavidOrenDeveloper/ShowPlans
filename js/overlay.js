// שכבה אישית מעל המבנה המשותף: שם אישי, הסתרה, העברה ותיקיות אישיות.
// לוגיקה טהורה (בלי דפדפן) כדי שאפשר יהיה לבדוק אותה בנפרד. המבנה המשותף (raw) לא משתנה אף פעם.
// rows: Map(id -> { kind: 'folder'|'plan'|'pfolder', data: { name?, hidden?, parentId? } })

export const RAW = Symbol('raw');
export const unwrap = (v) => (v && v[RAW]) || v;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function wrap(rec, patch) {
  return new Proxy(rec, {
    get(t, k) { if (k === RAW) return t; if (has(patch, k)) return patch[k]; return t[k]; },
  });
}

// opt.keepHidden: מציג גם פריטים מוסתרים, עם סימון _hidden (לצפייה כעובד)
// opt.allow: { folders:Set, plans:Set } – מגביל למה שמותר לעובד לראות (לצפייה כעובד)
export function applyOverlay(rawF, rawP, rows, opt = {}) {
  const keep = !!opt.keepHidden, allow = opt.allow || null;
  const eff = new Map(); // folderId -> { raw|pers, name, parent, origParent, hidden }
  for (const f of rawF.values()) {
    if (allow && !allow.folders.has(f.id)) continue;
    const o = rows.get(f.id); const d = o && o.kind === 'folder' ? o.data : null;
    eff.set(f.id, { raw: f, name: (d && d.name) || f.name, parent: d && has(d, 'parentId') ? d.parentId || null : f.parentId || null, origParent: f.parentId || null, hidden: !!(d && d.hidden), ov: !!d });
  }
  for (const [id, o] of rows) {
    if (o.kind !== 'pfolder') continue;
    const d = o.data || {};
    eff.set(id, { pers: { id, projectId: 'main', parentId: d.parentId || null, name: d.name || 'תיקייה', createdAt: d.createdAt || 0, personal: true }, name: d.name || 'תיקייה', parent: d.parentId || null, origParent: null, hidden: false, ov: true });
  }
  // הורה שלא קיים או מעגל -> חוזרים להורה המקורי (או לשורש)
  for (const [id, n] of eff) { if (n.parent && !eff.has(n.parent)) n.parent = n.origParent && eff.has(n.origParent) ? n.origParent : null; }
  for (const [id, n] of eff) {
    let x = n, g = 0, bad = false;
    while (x && x.parent && g++ < 300) { if (x.parent === id) { bad = true; break; } x = eff.get(x.parent); }
    if (bad || g >= 300) n.parent = n.origParent && eff.has(n.origParent) && n.origParent !== id ? n.origParent : null;
  }
  const hiddenOf = (id) => { let x = eff.get(id), g = 0; while (x && g++ < 300) { if (x.hidden) return true; x = x.parent ? eff.get(x.parent) : null; } return false; };

  const folders = new Map();
  for (const [id, n] of eff) {
    const hid = hiddenOf(id);
    if (hid && !keep) continue;
    if (n.pers) { folders.set(id, { ...n.pers, parentId: n.parent, _hidden: hid || undefined }); continue; }
    const f = n.raw;
    const changed = n.name !== f.name || n.parent !== (f.parentId || null) || hid;
    if (!changed) { folders.set(id, f); continue; }
    folders.set(id, wrap(f, { name: n.name, parentId: n.parent, origName: f.name, _hidden: hid || undefined, _ov: true }));
  }

  const plans = new Map();
  for (const p of rawP.values()) {
    if (allow && !allow.plans.has(p.id)) continue;
    const o = rows.get(p.id); const d = o && o.kind === 'plan' ? o.data : null;
    let parent = d && has(d, 'parentId') ? d.parentId || null : p.folderId || null;
    if (parent && !eff.has(parent)) parent = p.folderId && eff.has(p.folderId) ? p.folderId : null;
    const hid = !!(d && d.hidden) || (parent ? hiddenOf(parent) : false);
    if (hid && !keep) continue;
    const name = (d && d.name) || p.name;
    if (name === p.name && parent === (p.folderId || null) && !hid) { plans.set(p.id, p); continue; }
    plans.set(p.id, wrap(p, { name, folderId: parent, origName: p.name, _hidden: hid || undefined, _ov: true }));
  }
  return { folders, plans };
}

// לתיקייה אישית או משותפת: האם id הוא תיקייה אישית
export const isPersonalId = (rows, id) => !!(id && rows.get(id) && rows.get(id).kind === 'pfolder');
