// העדפות מיון וסידור ידני של תיקיות. נשמר במכשיר (localStorage), לא בענן.
const KEY = 'plans.sort.v1';
const def = () => ({ folders: { mode: 'name', dir: 'asc' }, plans: { mode: 'name', dir: 'asc' }, manual: {}, inline: [] });
let cache = null;
function load() {
  if (cache) return cache;
  try { cache = { ...def(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { cache = def(); }
  return cache;
}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ } };
const subs = new Set();
export const onOrderChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const fire = () => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

export const getSort = (kind) => load()[kind];
export function setSort(kind, patch) { load()[kind] = { ...load()[kind], ...patch }; save(); fire(); }
export const getManual = (parentKey) => load().manual[parentKey || 'root'] || null;
export function setManual(parentKey, ids) { load().manual[parentKey || 'root'] = ids; save(); fire(); }
// תיקיות פתוחות בתצוגה החיצונית
export const getOpen = () => new Set(load().inline);
export function setOpen(set) { load().inline = [...set]; save(); }

export const FOLDER_MODES = [['name', 'א-ב / מספרים (לפי שם)'], ['modified', 'תאריך שינוי'], ['created', 'תאריך יצירה'], ['count', 'מספר תוכניות'], ['manual', 'סדר ידני שלי']];
export const PLAN_MODES = [['name', 'א-ב / מספרים (לפי שם)'], ['modified', 'תאריך שינוי'], ['created', 'תאריך יצירה'], ['size', 'גודל קובץ'], ['pages', 'מספר עמודים'], ['local', 'שמורות במכשיר קודם']];
