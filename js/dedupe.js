// זיהוי כפילויות בהעלאה לפי תוכן הקובץ (SHA-256) ולא רק לפי שם:
//  • אותו שם, תוכן שונה  -> "גרסה חדשה" של אותה תוכנית (המשתמש מחליט: גרסה חדשה / דלג / תוכנית נפרדת)
//  • אותו תוכן, שם אחר   -> הקובץ כבר קיים (המשתמש מחליט: דלג / שנה שם לקיימת / הוסף בכל זאת)
//  • אותו שם ואותו תוכן  -> מדלגים
// ההשוואה נעשית רק מול תוכניות באותה תיקייה, ורק כשיש מועמד (אותו שם או אותו גודל), כדי שהעלאה של הרבה קבצים לא תאט.
import { t as tr } from './i18n.js';
import * as S from './store.js';
import * as db from './db.js';
import * as UI from './ui.js';
import { dn } from './names.js';
import { h, fmtSize, fmtDate, sha256 } from './util.js';

// טביעת אצבע של גרסה קיימת: מהשדה השמור, ממטמון מקומי, או מחושבת מהקובץ שבמכשיר (אם הוא כאן)
async function versionHash(v) {
  if (v.hash) return v.hash;
  try {
    const c = await db.get('meta', 'vh:' + v.id); if (c) return c.v;
    const f = await db.get('files', v.id); if (!f) return null;
    const hh = await sha256(f.blob);
    if (hh) await db.put('meta', { key: 'vh:' + v.id, v: hh });
    return hh;
  } catch { return null; }
}

async function classify(it) {
  const plans = S.plansIn(it.folderId);
  const byName = plans.find((p) => p.originalName === it.name || S.versionsOf(p.id).some((v) => v.fileName === it.name));
  if (byName) {
    const vs = S.versionsOf(byName.id);
    const file = await it.getFile(); const hsh = await sha256(file);
    const hashes = await Promise.all(vs.map(versionHash));
    if (hsh && hashes.some((x) => x === hsh)) return { kind: 'same' };
    const cur = S.curVer(byName);
    if (hashes.every((x) => !x) && cur && cur.size === file.size) return { kind: 'same' }; // אין טביעת אצבע (קובץ לא במכשיר): גודל זהה = כנראה זהה
    return { kind: 'changed', plan: byName, file };
  }
  const sizeHit = plans.filter((p) => S.versionsOf(p.id).some((v) => v.size === it.size));
  if (!sizeHit.length) return { kind: 'new' };
  const file = await it.getFile(); const hsh = await sha256(file);
  if (!hsh) return { kind: 'new' };
  for (const p of sizeHit) for (const v of S.versionsOf(p.id)) {
    if (v.size !== file.size) continue;
    if ((await versionHash(v)) === hsh) return { kind: 'renamed', plan: p, file };
  }
  return { kind: 'new' };
}

// חלון החלטה. מחזיר { changed: [פעולה...], renamed: [פעולה...] } או null אם ביטלו
function resolveDialog({ changed, renamed }) {
  const body = h('div', { class: 'stack dd' });
  const sels = { changed: [], renamed: [] };
  const group = (key, list, title, hint, options, def) => {
    if (!list.length) return;
    const master = h('select', { 'aria-label': tr('החל על כולם') }, h('option', { value: '' }, tr('בחרו לכולם…')), ...options.map(([v, t]) => h('option', { value: v }, t)));
    body.append(h('h3', {}, tr('{0} ({1})', title, list.length)), h('p', { class: 'hint' }, hint),
      h('div', { class: 'row' }, h('b', {}, tr('לכולם יחד: ')), master));
    const mine = [];
    list.forEach((c) => {
      const sel = h('select', { 'aria-label': tr('מה לעשות') }, options.map(([v, t]) => h('option', { value: v }, t)));
      sel.value = def; mine.push(sel); sels[key].push(sel);
      const cv = S.curVer(c.plan);
      body.append(h('div', { class: 'grant-row' },
        h('div', {}, h('b', {}, c.it.name), h('small', {}, key === 'changed'
          ? tr('הקיימת: {0} · V{1} · {2} → החדש: {3}', dn(c.plan.name), cv?.number ?? '?', cv ? fmtDate(cv.date) : '', fmtSize(c.file.size))
          : tr('כבר קיים בשם: {0}', dn(c.plan.name)))),
        sel));
    });
    master.addEventListener('change', () => { if (master.value) { mine.forEach((s) => { s.value = master.value; }); master.value = ''; } });
  };
  group('changed', changed, tr('אותו שם קובץ, תוכן שונה'), tr('נראה שאלה גרסאות מעודכנות של תוכניות שכבר קיימות. גרסה חדשה הופכת לנוכחית, והקודמת נשמרת בתוך התוכנית (תפריט "גרסאות") ולא מופיעה ברשימה הרגילה.'),
    [['version', tr('עדכן כגרסה חדשה')], ['skip', tr('דלג')], ['new', tr('הוסף כתוכנית נפרדת')]], 'version');
  group('renamed', renamed, tr('אותו תוכן, שם קובץ אחר'), tr('הקבצים האלה זהים לגמרי לתוכניות שכבר קיימות, רק בשם אחר.'),
    [['skip', tr('דלג (כבר קיים)')], ['rename', tr('שנה את שם הקיימת לשם החדש')], ['new', tr('הוסף בכל זאת')]], 'skip');
  const m = UI.openModal({
    title: tr('נמצאו קבצים שדומים לקיימים'), body, wide: true, cancelable: false,
    buttons: [{ text: tr('בטל את ההעלאה'), value: null }, { text: tr('המשך'), kind: 'primary', value: true }],
  });
  return m.promise.then((v) => (v ? { changed: sels.changed.map((s) => s.value), renamed: sels.renamed.map((s) => s.value) } : null));
}

const nameOf = (n) => n.replace(/\.pdf$/i, '').trim();

// items: [{ name, path?, folderId, size, getFile() }]. מחזיר סיכום.
export async function importWithDedupe(items, { tick = () => {}, stopped = () => false, check = true } = {}) {
  const res = { plans: 0, versions: 0, renamed: 0, existing: 0, skipped: 0, failed: [], cancelled: false, stopped: false, created: [] };
  const clean = [], changed = [], renamed = [];
  let i = 0;
  for (const it of items) {
    if (stopped()) { res.stopped = true; break; }
    tick(tr('בודק כפילויות: ') + it.name, i++, items.length);
    let c = { kind: 'new' };
    if (check) { try { c = await classify(it); } catch (e) { console.warn('dedupe', e); } }
    if (c.kind === 'same') res.existing++;
    else if (c.kind === 'changed') changed.push({ it, ...c });
    else if (c.kind === 'renamed') renamed.push({ it, ...c });
    else clean.push(it);
  }
  if (res.stopped) return res;
  let dec = { changed: [], renamed: [] };
  if (changed.length || renamed.length) {
    dec = await resolveDialog({ changed, renamed });
    if (!dec) { res.cancelled = true; return res; }
  }
  const todo = [
    ...clean.map((it) => ({ it, act: 'new' })),
    ...changed.map((c, k) => ({ it: c.it, act: dec.changed[k], plan: c.plan, file: c.file })),
    ...renamed.map((c, k) => ({ it: c.it, act: dec.renamed[k], plan: c.plan, file: c.file, ren: true })),
  ];
  let done = 0;
  for (const t of todo) {
    if (stopped()) { res.stopped = true; break; }
    tick(t.it.name, done++, todo.length, true);
    try {
      if (t.act === 'skip') { res.skipped++; continue; }
      if (t.act === 'version') { await S.addVersion(t.plan.id, t.file, { note: tr('עודכן בהעלאה'), makeCurrent: true }); res.versions++; }
      else if (t.act === 'rename') { await S.renamePlan(t.plan.id, nameOf(t.it.name)); await S.setPlanOriginalName(t.plan.id, t.it.name); res.renamed++; }
      else { const p = await S.importPdf(t.file || (await t.it.getFile()), t.it.folderId); res.plans++; res.created.push(p); }
    } catch (e) {
      console.error(e);
      res.failed.push({ name: t.it.path || t.it.name, msg: e.message || String(e) });
      if (/הרשאה|אחסון|permission|storage/i.test(e.message || '')) { res.stopped = true; break; }
    }
  }
  return res;
}
