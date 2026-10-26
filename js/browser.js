// מסך ניהול הקבצים: עץ תיקיות, כרטיסי תיקיות/תוכניות, חיפוש, בחירה מרובה, גרירה, ניהול אחסון
import { t as tr, CHEV_FWD, toggleLang, langButtonLabel } from './i18n.js';
import { dn, onNamesChange } from './names.js';
import { checkForUpdate, APP_VERSION } from './update.js';
import { installNow, isInstalled, installedElsewhere } from './pwa.js';
import { settingsDialog } from './settings.js';
import { hiddenDialog, viewAsDialog, viewAsBanner } from './personal-ui.js';
import { accountBox, grantsDialog, bulkGrantsDialog } from './cloud-ui.js';
import { isAdmin, isCloud } from './cloud.js';
import { canEditHere, downloadForOffline, removeFromDevice, isLocal, needsDownload, onLocalFilesChange, refreshLocalFiles } from './cloud-sync.js';
import { pushLayer } from './backstack.js';
import { getSort, setSort, getManual, setManual, getOpen, setOpen, FOLDER_MODES, PLAN_MODES } from './order.js';
import * as FI from './folder-import.js';
import { pickFiles } from './actions.js';
import * as S from './store.js';
import * as UI from './ui.js';
import * as A from './actions.js';
import * as B from './backup.js';
import * as db from './db.js';
import { h, icon, fmtSize, fmtDate, debounce, natural, expandOnEllipsis } from './util.js';

const MIME = 'application/x-planapp-items';
const st = {
  mode: 'folder', folderId: null, query: '', view: localStorage.getItem('view') || 'grid',
  sel: new Set(), selMode: false, chunk: 60,
  expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
  open: getOpen(), // תיקיות שנפתחו במקום (בתצוגה החיצונית)
};
let el = {};
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && 'ontouchstart' in window;
const credit = () => h('div', { class: 'page-credit' }, tr('נוצר על ידי דוד אורן'));
let carry = null; // מצב "נושאים" תוכניות במגע: { keys, id, x, y, ghost, bar, over, second }
const personal = () => isCloud() && !isAdmin(); // עובד בענן: שינויי מבנה הם אישיים
// תגיות לצפייה כעובד: שם מקורי / מוסתר אצל העובד / תיקייה אישית
function ovTags(r) {
  if (!S.getViewAs()) return null;
  const t = [];
  if (r.personal) t.push(tr('תיקייה אישית של העובד'));
  if (r.origName) t.push(tr('שם מקורי: ') + r.origName);
  if (r._hidden) t.push(tr('מוסתר אצל העובד'));
  return t.length ? h('div', { class: 'ov-tags' }, t.join(' · ')) : null;
}

export async function installApp() {
  if (isInstalled()) { UI.toast(tr('האפליקציה כבר מותקנת ופועלת כאפליקציה.')); return; }
  UI.toast(tr('בודק אפשרות התקנה…'), { ms: 2500 });
  if (await installedElsewhere()) { UI.toast(tr('האפליקציה כבר מותקנת בטלפון. פתחו אותה מהאייקון במסך הבית.'), { ms: 5000 }); return; }
  const r = await installNow();
  if (r === 'unavailable') A.installHelp();
  else if (r === 'accepted') UI.toast(tr('האפליקציה הותקנה. פתחו אותה מהאייקון במסך הבית.'), { ms: 5000 });
}

const saveExpanded = () => localStorage.setItem('expanded', JSON.stringify([...st.expanded]));
const key = (t, id) => `${t}:${id}`;
const selObj = () => {
  const o = { folders: [], plans: [] };
  st.sel.forEach((k) => { const [t, id] = [k[0], k.slice(2)]; (t === 'f' ? o.folders : o.plans).push(id); });
  return o;
};

export function mountBrowser(root) {
  el.shell = h('div', { class: 'app-shell' });
  el.sidebar = h('aside', { class: 'sidebar' });
  el.backdrop = h('div', { class: 'sb-backdrop', onclick: () => toggleSidebar(false) });
  el.main = h('main', { class: 'main' });
  el.top = h('header', { class: 'topbar' });
  el.selbar = h('div', { class: 'selbar hidden' });
  el.content = h('div', { class: 'content' });
  el.fab = h('button', { class: 'fab', 'aria-label': tr('הוסף'), onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 26));
  el.main.append(el.top, el.selbar, el.content);
  el.shell.append(el.sidebar, el.backdrop, el.main, el.fab);
  root.append(el.shell);
  buildTop();
  S.subscribe(() => renderAll());
  onNamesChange(() => renderAll()); // תרגום שם שהגיע מהרשת
  S.onIndexStatus((t) => { if (el.status) el.status.textContent = t; });
  let lfT = 0; onLocalFilesChange(() => { clearTimeout(lfT); lfT = setTimeout(() => { if (st.mode !== 'storage') renderAll(); }, 900); });
  // גרירת קבצים/תיקיות מהמחשב לתוך האפליקציה (בכל מסך הניהול). גרירה פנימית של פריטים משתמשת ב-MIME משלה ולא מושפעת.
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files') && !e.dataTransfer.types.includes(MIME);
  let dragDepth = 0;
  const dropHint = h('div', { class: 'file-drop-hint hidden' }, icon('upload', 28), h('b', {}, tr('שחררו כאן להעלאה')), h('small', {}, tr('קבצי PDF או תיקיות שלמות – המבנה נשמר')));
  el.shell.append(dropHint);
  const inViewer = () => !!document.querySelector('#viewer-root .viewer');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e) && !inViewer()) { dragDepth++; dropHint.classList.remove('hidden'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropHint.classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropHint.classList.add('hidden');
    if (inViewer() || (st.mode !== 'folder')) { UI.toast(tr('גררו לתוך מסך התיקיות כדי להעלות'), { type: 'error' }); return; }
    if (!canEditHere(st.folderId)) { UI.toast(tr('אין לך הרשאת עריכה בתיקייה הזו'), { type: 'error' }); return; }
    await FI.handleDrop(e.dataTransfer, st.folderId);
  });
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.viewer') || document.querySelector('.modal-back')) return;
    if (e.key === 'Escape' && (st.selMode || st.sel.size)) clearSel();
  });
  renderAll();
}

export function show({ mode = 'folder', id = null, q = '' }) {
  st.mode = mode; st.chunk = 60;
  if (mode === 'search' && !st.scope) st.scope = '';
  if (mode === 'folder') {
    st.folderId = id && S.P.folders.has(id) ? id : null;
    S.folderPath(st.folderId).forEach((f) => { if (f.parentId) st.expanded.add(f.parentId); });
  }
  if (mode === 'search') { st.query = q; if (el.q) el.q.value = q; }
  else if (el.q && mode !== 'search') el.q.value = '';
  clearSel(false);
  toggleSidebar(false);
  renderAll();
  el.content.scrollTop = 0;
  updateCarryBar();
}

let sbLayer = null;
function toggleSidebar(open) {
  el.shell.classList.toggle('sb-open', open);
  if (open && !sbLayer) sbLayer = pushLayer(() => { sbLayer = null; el.shell.classList.remove('sb-open'); }); // "אחורה" סוגר את תפריט הצד
  else if (!open && sbLayer) { const l = sbLayer; sbLayer = null; l.release(); }
}

// מצב בחירה: "אחורה" מבטל קודם את הבחירה. הרשומה נוספת רק אחרי נגיעה גמורה (דרישת Chrome: אינטראקציה של המשתמש)
let selLayer = null, selWait = false;
function syncSelLayer() {
  if (st.selMode && !selLayer) {
    const go = () => { selWait = false; if (!st.selMode || selLayer) return; selLayer = pushLayer(() => { selLayer = null; clearSel(); }); };
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      if (selWait) return; selWait = true;
      const once = () => setTimeout(go, 0);
      document.addEventListener('touchend', once, { once: true, capture: true });
      document.addEventListener('pointerup', once, { once: true, capture: true });
    } else go();
  } else if (!st.selMode && selLayer) { const l = selLayer; selLayer = null; l.release(); }
}

// ---------- שורת עליונה ----------
function buildTop() {
  el.q = h('input', { type: 'search', class: 'search', placeholder: tr('חיפוש בכל הפרויקט: תיקיות, תוכניות וטקסט בתוך PDF…'), 'aria-label': tr('חיפוש') });
  const go = debounce(() => { const v = el.q.value.trim(); if (v) { if (location.hash.startsWith('#/search')) history.replaceState(null, '', '#/search?q=' + encodeURIComponent(v)); else location.hash = '#/search?q=' + encodeURIComponent(v); show({ mode: 'search', q: v }); } else if (st.mode === 'search') location.hash = '#/f/' + (st.folderId || ''); }, 250);
  el.q.addEventListener('input', go);
  el.viewBtn = h('button', { class: 'icon-btn', 'aria-label': tr('תצוגה'), onclick: () => { st.view = st.view === 'grid' ? 'list' : 'grid'; localStorage.setItem('view', st.view); renderAll(); } });
  el.status = h('span', { class: 'idx-status' });
  el.top.append(
    h('button', { class: 'icon-btn only-narrow', 'aria-label': tr('תפריט'), 'data-act': 'menu', onclick: () => toggleSidebar(true) }, icon('menu')),
    h('div', { class: 'brand-sm' }, tr('תוכניות')),
    h('div', { class: 'search-wrap' }, icon('search', 18), el.q),
    el.viewBtn,
    h('button', { class: 'btn lang-top', 'aria-label': 'Language / שפה', onclick: toggleLang }, icon('globe', 18), langButtonLabel()),
    h('button', { class: 'btn primary only-wide', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 18), tr('חדש')),
    h('button', { class: 'icon-btn', 'aria-label': tr('עוד'), onclick: (e) => mainMenu(e.currentTarget) }, icon('more')));
}

function addMenu(anchor) {
  const fid = st.mode === 'folder' ? st.folderId : null;
  const up = canEditHere(fid);
  UI.menu(anchor, [
    ...(up ? [
      { label: tr('העלאת PDF (אחד או כמה)'), icon: 'upload', onClick: () => A.uploadInto(fid) },
      { label: tr('העלאת תיקייה שלמה (עם תתי-תיקיות)'), icon: 'folderPlus', onClick: () => FI.uploadFolderFlow(fid) },
      { label: tr('העלאת ZIP עם מבנה תיקיות'), icon: 'archive', onClick: () => FI.uploadZipFlow(fid, pickFiles) },
    ] : []),
    { label: personal() ? tr('תיקייה אישית חדשה') : tr('תיקייה חדשה'), icon: 'folderPlus', onClick: () => A.newFolderDialog(fid) },
  ]);
}

function mainMenu(anchor) {
  UI.menu(anchor, [
    { label: tr('מיון וסדר…'), icon: 'sliders', onClick: () => sortDialog() },
    ...(isCloud() ? [{ label: tr('הורד הכל למכשיר (לעבודה בלי קליטה)'), icon: 'cloud', onClick: () => downloadForOffline(null) }, { label: tr('פנה מקום: הסר הורדות מהמכשיר (נשאר בענן)'), icon: 'trash', onClick: () => removeFromDevice(null) }] : []),
    { label: tr('ניהול אחסון'), icon: 'drive', onClick: () => { location.hash = '#/storage'; } },
    { label: tr('גיבוי ושחזור…'), icon: 'archive', onClick: () => B.backupDialog() },
    { divider: true },
    { label: tr('שנה שם פרויקט'), icon: 'edit', onClick: async () => { const v = await UI.promptBox({ title: tr('שם הפרויקט'), value: S.P.project.name, okText: tr('שמור') }); if (v) S.renameProject(v); } },
    ...(isAdmin() ? [{ label: tr('צפייה כעובד…'), icon: 'users', onClick: () => viewAsDialog() }] : []),
    ...(personal() ? [{ label: tr('מוסתרים אצלי'), icon: 'eye', onClick: () => hiddenDialog() }] : []),
    { label: tr('הגדרות ועדכון (גרסה {0})', APP_VERSION), icon: 'settings', onClick: () => settingsDialog({ installApp }) },
  ]);
}

// ---------- רינדור ----------
function renderAll() {
  const keepScroll = el.content.scrollTop;
  renderAll0();
  if (st.mode === 'folder' || st.mode === 'search') el.content.scrollTop = keepScroll;
}
function renderAll0() {
  el.viewBtn.replaceChildren(icon(st.view === 'grid' ? 'list' : 'grid'));
  el.viewBtn.title = st.view === 'grid' ? tr('תצוגת רשימה') : tr('תצוגת רשת');
  renderSidebar();
  renderSelbar();
  if (st.mode === 'folder') renderFolder();
  else if (st.mode === 'search') renderSearch();
  else if (st.mode === 'storage') renderStorage();
  el.fab.style.display = (st.mode === 'storage' || (st.mode === 'folder' && !canEditHere(st.folderId) && !personal())) ? 'none' : '';
  const vb = viewAsBanner(); if (vb) el.content.prepend(vb);
}

// עץ צד
function renderSidebar() {
  const oldTree = el.sidebar.querySelector('.tree');
  const keepTree = oldTree ? oldTree.scrollTop : 0, keepSb = el.sidebar.scrollTop;
  renderSidebar0();
  const nt = el.sidebar.querySelector('.tree');
  if (nt) nt.scrollTop = keepTree; // פתיחה/סגירה של תיקייה בתפריט לא מקפיצה חזרה לראש הרשימה
  el.sidebar.scrollTop = keepSb;
}
function renderSidebar0() {
  const tree = h('div', { class: 'tree' });
  const rootRow = h('div', { class: 'tree-row root' + (st.mode === 'folder' && !st.folderId ? ' cur' : ''), 'data-nav': '#/f/', onclick: () => { location.hash = '#/f/'; } },
    h('span', { class: 'twisty' }), icon('home', 18), h('span', { class: 'nm' }, dn(S.P.project.name)),
    h('button', { class: 'icon-btn sm', 'aria-label': tr('עוד'), onclick: (e) => { e.stopPropagation(); UI.menu(e.currentTarget, [
      { label: tr('תיקייה חדשה'), icon: 'folderPlus', onClick: () => A.newFolderDialog(null) },
      { label: tr('העלאת PDF'), icon: 'upload', onClick: () => A.uploadInto(null) },
      { label: tr('העלאת תיקייה שלמה'), icon: 'folderPlus', onClick: () => FI.uploadFolderFlow(null) },
      { label: tr('העלאת ZIP עם מבנה תיקיות'), icon: 'archive', onClick: () => FI.uploadZipFlow(null, pickFiles) },
      { label: tr('שנה שם פרויקט'), icon: 'edit', onClick: async () => { const v = await UI.promptBox({ title: tr('שם הפרויקט'), value: S.P.project.name, okText: tr('שמור') }); if (v) S.renameProject(v); } },
    ]); } }, icon('more', 16)));
  makeDropTarget(rootRow, null);
  tree.append(rootRow);
  const walk = (pid, depth) => {
    for (const f of S.childFolders(pid)) {
      const kidsN = S.childFolders(f.id).length;
      const open = st.expanded.has(f.id);
      const row = h('div', {
        class: 'tree-row' + (st.mode === 'folder' && st.folderId === f.id ? ' cur' : ''), style: { paddingInlineStart: 8 + depth * 16 + 'px' }, draggable: !COARSE, 'data-nav': '#/f/' + f.id,
        onclick: () => { st.expanded.add(f.id); saveExpanded(); location.hash = '#/f/' + f.id; },
        oncontextmenu: (e) => { e.preventDefault(); folderMenu(f.id, { x: e.clientX, y: e.clientY }); },
      },
      kidsN ? h('button', { class: 'twisty', 'aria-label': open ? tr('כווץ') : tr('הרחב'), onclick: (e) => { e.stopPropagation(); open ? st.expanded.delete(f.id) : st.expanded.add(f.id); saveExpanded(); renderSidebar(); } }, icon(open ? 'chevD' : CHEV_FWD, 16)) : h('span', { class: 'twisty' }),
      icon('folder', 18), (() => { const nm = h('span', { class: 'nm' + (f._hidden ? ' dim' : ''), title: f.name }, dn(f.name)); expandOnEllipsis(nm, tr('כווץ')); return nm; })(),
      h('button', { class: 'icon-btn sm', 'aria-label': tr('עוד'), onclick: (e) => { e.stopPropagation(); folderMenu(f.id, e.currentTarget); } }, icon('more', 16)));
      row.addEventListener('dragstart', (e) => startDrag(e, [key('f', f.id)]));
      makeDropTarget(row, f.id);
      tree.append(row);
      if (kidsN && open) walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  const foot = h('div', { class: 'sb-foot' },
    accountBox(),
    h('button', { class: 'btn ghost block', onclick: () => { location.hash = '#/storage'; } }, icon('drive', 18), tr('ניהול אחסון')),
    ...(isAdmin() ? [h('button', { class: 'btn ghost block', onclick: () => { toggleSidebar(false); viewAsDialog(); } }, icon('users', 18), tr('צפייה כעובד'))] : []),
    h('button', { class: 'btn ghost block', onclick: () => B.backupDialog() }, icon('archive', 18), tr('גיבוי ושחזור')),
    h('button', { class: 'btn ghost block lang-btn', onclick: toggleLang }, icon('globe', 18), langButtonLabel()),
    h('button', { class: 'btn ghost block', onclick: () => settingsDialog({ installApp }) }, icon('settings', 18), tr('הגדרות · גרסה {0}', APP_VERSION)),
    el.status, h('div', { class: 'sb-credit' }, tr('נוצר על ידי דוד אורן')));
  el.sidebar.replaceChildren(
    h('div', { class: 'sb-head' }, h('div', { class: 'logo' }, icon('layers', 22)), h('div', {}, h('b', {}, tr('תוכניות בנייה')), h('small', {}, isCloud() ? tr('מסונכרן לענן') : tr('הכל שמור במכשיר')))),
    tree, foot);
}

// ---------- גרירה ושחרור ----------
function startDrag(e, keys) {
  const k = keys.length === 1 && st.sel.has(keys[0]) ? [...st.sel] : keys;
  e.dataTransfer.setData(MIME, JSON.stringify(k));
  e.dataTransfer.effectAllowed = 'move';
}
function makeDropTarget(node, folderId) {
  node.dataset.drop = folderId || 'root';
  node.addEventListener('dragover', (e) => {
    const t = e.dataTransfer.types;
    if (t.includes(MIME) || t.includes('Files')) { e.preventDefault(); e.stopPropagation(); node.classList.add('drop-over'); }
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-over'));
  node.addEventListener('drop', async (e) => {
    node.classList.remove('drop-over');
    el.content.classList.remove('file-drop');
    const raw = e.dataTransfer.getData(MIME);
    if (raw) {
      e.preventDefault(); e.stopPropagation();
      const keys = JSON.parse(raw);
      const o = { folders: [], plans: [] };
      keys.forEach((k) => (k[0] === 'f' ? o.folders : o.plans).push(k.slice(2)));
      try { await S.moveItems(o, folderId); clearSel(); } catch (err) { UI.toast(err.message, { type: 'error' }); }
    } else if (e.dataTransfer.files?.length) {
      e.preventDefault(); e.stopPropagation();
      await A.importFiles([...e.dataTransfer.files], folderId);
    }
  });
}

// ---------- בחירה ----------
function clearSel(render = true) { st.sel.clear(); st.selMode = false; if (render) renderAll(); }
function toggleSel(k) {
  st.sel.has(k) ? st.sel.delete(k) : st.sel.add(k);
  st.selMode = st.sel.size > 0;
  // עדכון במקום, בלי לבנות את כל הרשימה מחדש: כך המסך לא קופץ לראש הרשימה בכל בחירה
  const on = st.sel.has(k);
  el.content.querySelectorAll('[data-key]').forEach((n) => { if (n.dataset.key === k) n.classList.toggle('selected', on); });
  renderSelbar();
}
function renderSelbar() {
  const n = st.sel.size;
  el.selbar.classList.toggle('hidden', !st.selMode);
  syncSelLayer();
  if (!st.selMode) return;
  const o = selObj();
  el.selbar.replaceChildren(
    h('button', { class: 'icon-btn', 'aria-label': tr('בטל בחירה'), onclick: () => clearSel() }, icon('x')),
    h('b', {}, tr('{0} נבחרו', n)),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn sm', onclick: selectAll }, tr('בחר הכל')),
    h('button', { class: 'btn sm', onclick: async () => { if (await A.moveDialog(o, st.folderId)) clearSel(); } }, icon('move', 16), tr('העבר')),
    h('button', { class: 'btn sm', onclick: () => B.downloadItems(o) }, icon('download', 16), tr('הורד')),
    isCloud() ? h('button', { class: 'btn sm', onclick: () => { downloadForOffline(o); clearSel(); } }, icon('cloud', 16), tr('למכשיר')) : null,
    isCloud() ? h('button', { class: 'btn sm', onclick: () => { removeFromDevice(o); clearSel(); } }, icon('trash', 16), tr('הסר מהמכשיר')) : null,
    h('button', { class: 'btn sm', onclick: () => batchRename(o) }, icon('edit', 16), tr('שנה שם')),
    isAdmin() ? h('button', { class: 'btn sm', onclick: async () => { if (await bulkGrantsDialog(o)) clearSel(); } }, icon('lock', 16), tr('הרשאות')) : null,
    h('button', { class: 'btn sm danger', onclick: async () => { if (await A.deleteDialog(o)) clearSel(); } }, icon('trash', 16), personal() ? tr('הסתר') : tr('מחק')));
}
function selectAll() {
  S.childFolders(st.folderId).forEach((f) => st.sel.add(key('f', f.id)));
  S.plansIn(st.folderId).forEach((p) => st.sel.add(key('p', p.id)));
  st.selMode = st.sel.size > 0;
  el.content.querySelectorAll('[data-key]').forEach((n) => { if (st.sel.has(n.dataset.key)) n.classList.add('selected'); });
  renderSelbar();
}
async function batchRename(o) {
  if (o.folders.length + o.plans.length === 1) {
    if (o.folders.length) await A.renameFolderDialog(o.folders[0]); else await A.renamePlanDialog(o.plans[0]);
    clearSel(); return;
  }
  const find = h('input', { type: 'text', placeholder: tr('טקסט להחלפה (אפשר להשאיר ריק)') });
  const rep = h('input', { type: 'text', placeholder: tr('יוחלף ב…') });
  const pre = h('input', { type: 'text', placeholder: tr('תחילית להוספה') });
  const suf = h('input', { type: 'text', placeholder: tr('סיומת להוספה') });
  const r = await UI.modal({
    title: tr('שינוי שם קבוצתי'), body: h('div', { class: 'form' }, h('label', {}, tr('החלף טקסט')), find, rep, h('label', {}, tr('הוסף')), pre, suf),
    buttons: [{ text: tr('ביטול'), value: false }, { text: tr('החל'), kind: 'primary', value: true }],
  });
  if (!r) return;
  const nm = (n) => pre.value + (find.value ? n.split(find.value).join(rep.value) : n) + suf.value;
  for (const id of o.folders) { const f = S.P.folders.get(id); if (f) await S.renameFolder(id, nm(f.name) || f.name); }
  for (const id of o.plans) { const p = S.P.plans.get(id); if (p) await S.renamePlan(id, nm(p.name) || p.name); }
  clearSel();
}

// ---------- תפריטי פריטים ----------
function folderMenu(id, anchor) {
  UI.menu(anchor, [
    { label: tr('פתח'), icon: 'folder', onClick: () => { location.hash = '#/f/' + id; } },
    { label: tr('תת-תיקייה חדשה'), icon: 'folderPlus', onClick: () => { st.expanded.add(id); saveExpanded(); A.newFolderDialog(id); } },
    ...(canEditHere(id) ? [
      { label: tr('העלאת PDF לכאן'), icon: 'upload', onClick: () => A.uploadInto(id) },
      { label: tr('העלאת תיקייה שלמה לכאן'), icon: 'folderPlus', onClick: () => FI.uploadFolderFlow(id) },
      { label: tr('העלאת ZIP לכאן'), icon: 'archive', onClick: () => FI.uploadZipFlow(id, pickFiles) },
    ] : []),
    { label: personal() ? tr('שנה שם (רק אצלי)') : tr('שנה שם'), icon: 'edit', onClick: () => A.renameFolderDialog(id) },
    { label: tr('העבר…'), icon: 'move', onClick: () => A.moveDialog({ folders: [id], plans: [] }, S.P.folders.get(id)?.parentId) },
    ...(isCloud() ? [{ label: tr('הורד תיקייה למכשיר (לעבודה בלי קליטה)'), icon: 'cloud', onClick: () => downloadForOffline({ folders: [id], plans: [] }) }, { label: tr('הסר את התיקייה מהמכשיר (נשאר בענן)'), icon: 'trash', onClick: () => removeFromDevice({ folders: [id], plans: [] }) }] : []),
    { label: tr('הורד כ-ZIP'), icon: 'download', onClick: () => B.downloadItems({ folders: [id], plans: [] }) },
    ...(isAdmin() ? [{ label: tr('הרשאות עובדים…'), icon: 'lock', onClick: () => grantsDialog({ folderId: id }) }] : []),
    { divider: true },
    { label: personal() ? tr('הסתר ממני') : tr('מחק'), icon: 'trash', danger: true, onClick: async () => { const wasHere = S.isDescendant(st.folderId, id); await A.deleteDialog({ folders: [id], plans: [] }); if (wasHere && !S.P.folders.has(st.folderId)) location.hash = '#/f/'; } },
  ]);
}
function planMenu(id, anchor) {
  const p = S.P.plans.get(id); if (!p) return;
  UI.menu(anchor, [
    { label: tr('פתח'), icon: 'file', onClick: () => { location.hash = '#/p/' + id; } },
    { label: personal() ? tr('שנה שם (רק אצלי)') : tr('שנה שם'), icon: 'edit', onClick: () => A.renamePlanDialog(id) },
    { label: tr('העבר…'), icon: 'move', onClick: () => A.moveDialog({ folders: [], plans: [id] }, p.folderId) },
    ...(canEditHere(p.folderId) ? [{ label: tr('שכפל'), icon: 'copy', onClick: async () => { try { await S.duplicatePlan(id); UI.toast(tr('הועתק')); } catch (e) { UI.toast(e.message, { type: 'error' }); } } }] : []),
    { label: tr('גרסאות'), icon: 'clock', onClick: () => A.versionsDialog(id) },
    ...(needsDownload(p) ? [{ label: tr('שמור במכשיר (לעבודה בלי קליטה)'), icon: 'cloud', onClick: () => downloadForOffline({ folders: [], plans: [id] }) }] : []),
    ...(isCloud() && isLocal(p.currentVersionId) && S.curVer(p)?.driveId ? [{ label: tr('הסר מהמכשיר (נשאר בענן)'), icon: 'trash', onClick: () => removeFromDevice({ folders: [], plans: [id] }) }] : []),
    { label: tr('הורד PDF'), icon: 'download', onClick: () => A.downloadVersion(p.currentVersionId, p.name) },
    { label: tr('פתח באמצעות / שתף'), icon: 'share', onClick: () => A.openWithDialog(p) },
    ...(isAdmin() ? [{ label: tr('הרשאות עובדים…'), icon: 'lock', onClick: () => grantsDialog({ planId: id }) }] : []),
    { label: tr('פרטים'), icon: 'info', onClick: () => A.planInfoDialog(id) },
    { divider: true },
    { label: personal() ? tr('הסתר ממני') : tr('מחק'), icon: 'trash', danger: true, onClick: () => A.deleteDialog({ folders: [], plans: [id] }) },
  ]);
}

// ---------- כרטיסים ----------
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const img = en.target; io.unobserve(img);
    S.thumbURL(img.dataset.v).then((u) => { if (u) { img.src = u; img.classList.add('ok'); } });
  }
}, { rootMargin: '300px' });

function cardBase(k, cls) {
  const card = h('div', { class: 'card ' + cls + (st.sel.has(k) ? ' selected' : ''), draggable: !COARSE, tabIndex: 0, 'data-key': k });
  const chk = h('button', { class: 'chk', 'aria-label': tr('בחירה'), onclick: (e) => { e.stopPropagation(); toggleSel(k); } }, icon('check', 14));
  card.append(chk);
  card.addEventListener('dragstart', (e) => startDrag(e, [k]));

  // מגע: לחיצה ארוכה = בחירה/הרמה. אם ממשיכים לגרור – נושאים את הפריטים; אצבע שנייה מנווטת בין תיקיות; הרמת האצבע הראשונה מניחה.
  // המאזינים צמודים לכרטיס עצמו (ולא ל-document) כי המסך נבנה מחדש בניווט והכרטיס נותק – אירועי המגע ממשיכים להגיע לצומת המקורי.
  let tc = null;
  const clearTc = () => { if (tc) clearTimeout(tc.timer); tc = null; };
  const find = (list, id) => [...list].find((x) => x.identifier === id);
  card.addEventListener('touchstart', (e) => {
    if (carry || e.touches.length !== 1) return;
    const t = e.changedTouches[0];
    tc = { id: t.identifier, x0: t.clientX, y0: t.clientY, picked: false };
    tc.timer = setTimeout(() => {
      if (!tc) return;
      tc.picked = true; card._long = true;
      navigator.vibrate?.(15);
      if (!st.sel.has(k)) { st.sel.add(k); st.selMode = true; card.classList.add('selected'); renderSelbar(); }
    }, 450);
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!tc) return;
    const t = find(e.changedTouches, tc.id); if (!t) return;
    const moved = Math.hypot(t.clientX - tc.x0, t.clientY - tc.y0);
    if (!tc.picked) { if (moved > 10) clearTc(); return; }
    if (e.cancelable) e.preventDefault();
    if (!carry && moved > 10) startCarry(k, t);
    if (carry) carryMove(t.clientX, t.clientY);
  }, { passive: false });
  card.addEventListener('touchend', (e) => {
    if (!tc) return;
    const t = find(e.changedTouches, tc.id); if (!t) return;
    const picked = tc.picked;
    clearTc();
    if (picked && e.cancelable) e.preventDefault(); // בלי "קליק" אחרי הרמה
    if (carry) endCarry(t.clientX, t.clientY);
    setTimeout(() => { card._long = false; }, 400);
  });
  card.addEventListener('touchcancel', () => { if (carry) cancelCarry(); clearTc(); setTimeout(() => { card._long = false; }, 400); });
  return card;
}

// ---------- נשיאת פריטים במגע ----------
function carryLabel() {
  const n = carry.keys.length;
  if (n === 1) {
    const [t, id] = [carry.keys[0][0], carry.keys[0].slice(2)];
    return (t === 'f' ? S.P.folders.get(id)?.name : S.P.plans.get(id)?.name) || tr('פריט');
  }
  return tr('{0} פריטים', n);
}
function updateCarryBar() {
  if (!carry) return;
  const where = st.mode === 'folder' ? (st.folderId ? S.P.folders.get(st.folderId)?.name : S.P.project.name) : null;
  carry.bar.replaceChildren(
    h('div', { class: 'col' },
      h('span', {}, tr('מעבירים: {0}', carryLabel())),
      h('small', {}, where ? tr('אם תשחררו כאן – יועבר אל "{0}". אצבע שנייה: כניסה/יציאה מתיקיות', where) : tr('נווטו עם אצבע שנייה לתיקייה, ושחררו'))),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn sm', 'data-act': 'cancel-carry' }, tr('ביטול')));
}
function startCarry(k, t) {
  const keys = st.sel.has(k) ? [...st.sel] : [k];
  carry = { keys, id: t.identifier, x: t.clientX, y: t.clientY, over: null, second: new Map(), scrollV: 0, raf: 0 };
  carry.ghost = h('div', { class: 'carry-ghost' }, h('span', { class: 'n' }, String(keys.length)), h('span', {}, carryLabel()));
  carry.bar = h('div', { class: 'carry-bar' });
  document.body.append(carry.ghost, carry.bar);
  document.body.classList.add('carry-active');
  keys.forEach((kk) => document.querySelector(`.card[data-key="${kk}"]`)?.classList.add('lift'));
  document.addEventListener('touchstart', carrySecondStart, { passive: false, capture: true });
  document.addEventListener('touchmove', carrySecondMove, { passive: false, capture: true });
  document.addEventListener('touchend', carrySecondEnd, { capture: true });
  updateCarryBar();
  carryMove(t.clientX, t.clientY);
  const loop = () => {
    if (!carry) return;
    if (carry.scrollV) el.content.scrollTop += carry.scrollV * 14;
    carry.raf = requestAnimationFrame(loop);
  };
  carry.raf = requestAnimationFrame(loop);
}
function carryMove(x, y) {
  if (!carry) return;
  carry.x = x; carry.y = y;
  carry.ghost.style.left = x + 'px'; carry.ghost.style.top = y + 'px';
  const over = document.elementFromPoint(x, y)?.closest('[data-drop]') || null;
  if (over !== carry.over) { carry.over?.classList.remove('drop-over'); over?.classList.add('drop-over'); carry.over = over; }
  const r = el.content.getBoundingClientRect();
  carry.scrollV = y > innerHeight - 90 ? 1 : (y < r.top + 60 && y > r.top - 10 ? -1 : 0);
}
function cleanupCarry() {
  if (!carry) return;
  cancelAnimationFrame(carry.raf);
  carry.ghost.remove(); carry.bar.remove();
  carry.over?.classList.remove('drop-over');
  document.body.classList.remove('carry-active');
  document.querySelectorAll('.card.lift').forEach((c) => c.classList.remove('lift'));
  document.removeEventListener('touchstart', carrySecondStart, { capture: true });
  document.removeEventListener('touchmove', carrySecondMove, { capture: true });
  document.removeEventListener('touchend', carrySecondEnd, { capture: true });
  const c = carry; carry = null;
  return c;
}
function cancelCarry() { if (cleanupCarry()) UI.toast(tr('ההעברה בוטלה'), { ms: 1500 }); }
async function endCarry(x, y) {
  if (!carry) return;
  const dropEl = document.elementFromPoint(x, y)?.closest('[data-drop]');
  let dest;
  if (dropEl) dest = dropEl.dataset.drop === 'root' ? null : dropEl.dataset.drop;
  else {
    const r = el.content.getBoundingClientRect();
    if (st.mode === 'folder' && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) dest = st.folderId;
  }
  const c = cleanupCarry();
  if (dest === undefined) { UI.toast(tr('ההעברה בוטלה (שחררו מעל אזור התוכניות או מעל תיקייה)'), { ms: 2500 }); return; }
  const o = { folders: [], plans: [] };
  c.keys.forEach((kk) => (kk[0] === 'f' ? o.folders : o.plans).push(kk.slice(2)));
  const same = o.folders.every((id) => (S.P.folders.get(id)?.parentId || null) === (dest || null)) && o.plans.every((id) => (S.P.plans.get(id)?.folderId || null) === (dest || null));
  if (same) { UI.toast(tr('הפריטים כבר נמצאים בתיקייה הזו'), { ms: 2000 }); clearSel(); return; }
  try {
    await S.moveItems(o, dest);
    const name = dest ? S.P.folders.get(dest)?.name : S.P.project.name;
    UI.toast(tr('הועברו {0} פריטים אל "{1}"', c.keys.length, name), { ms: 2500 });
    clearSel();
  } catch (err) { UI.toast(err.message, { type: 'error' }); }
}
// אצבע שנייה בזמן נשיאה: לחיצה = ניווט/כפתור, גרירה = גלילה
function carrySecondStart(e) {
  if (!carry) return;
  for (const t of e.changedTouches) if (t.identifier !== carry.id) carry.second.set(t.identifier, { x0: t.clientX, y0: t.clientY, y: t.clientY, t0: performance.now(), moved: false });
  if (e.cancelable && [...e.changedTouches].some((t) => t.identifier !== carry.id)) e.preventDefault();
}
function carrySecondMove(e) {
  if (!carry) return;
  for (const t of e.changedTouches) {
    if (t.identifier === carry.id) continue;
    const s2 = carry.second.get(t.identifier); if (!s2) continue;
    if (Math.hypot(t.clientX - s2.x0, t.clientY - s2.y0) > 10) s2.moved = true;
    if (s2.moved) { el.content.scrollTop -= t.clientY - s2.y; }
    s2.y = t.clientY;
    if (e.cancelable) e.preventDefault();
  }
}
function carrySecondEnd(e) {
  if (!carry) return;
  for (const t of e.changedTouches) {
    if (t.identifier === carry.id) continue;
    const s2 = carry.second.get(t.identifier); carry.second.delete(t.identifier);
    if (s2 && !s2.moved && performance.now() - s2.t0 < 600) carryTap(t.clientX, t.clientY);
  }
  // רשת ביטחון: אם כל האצבעות עזבו והכרטיס המקורי כבר לא מקבל אירועים – מניחים במקום האחרון
  if (e.touches.length === 0) setTimeout(() => { if (carry) endCarry(carry.x, carry.y); }, 40);
}
function carryTap(x, y) {
  const target = document.elementFromPoint(x, y);
  if (!target) return;
  const act = target.closest('[data-act]');
  if (act) { if (act.dataset.act === 'cancel-carry') cancelCarry(); else if (act.dataset.act === 'menu') toggleSidebar(true); return; }
  const nav = target.closest('[data-nav]');
  if (nav) { location.hash = nav.dataset.nav; return; }
  if (target.classList.contains('sb-backdrop')) toggleSidebar(false);
}
const clickGuard = (card, fn, k) => (e) => {
  if (card._long) { card._long = false; e.preventDefault(); return; }
  if (e.ctrlKey || e.metaKey || e.shiftKey || st.selMode) { toggleSel(k); return; }
  fn(e);
};

// מפריד בין חלקי טקסט עם ' · ' ושומר על סדר תקין בטקסט מעורב עברית/לטינית
function interleave(parts) {
  const out = [];
  parts.forEach((t, i) => { if (i) out.push(' · '); out.push(h('bdi', {}, t)); });
  return out;
}

// הזזת תיקייה למעלה/למטה בסדר הידני (נשמר במכשיר, לכל תיקיית אב בנפרד)
function moveFolderOrder(f, dir) {
  const pk = f.parentId || null;
  const ids = S.childFolders(pk).map((x) => x.id);
  const i = ids.indexOf(f.id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  setManual(pk, ids);
  S.resort();
}
// מרנדר מחדש ומחזיר את הפריט שנלחץ לאותו מקום על המסך (כדי שהרשימה לא "תברח" בפתיחה/סגירה)
function rerenderAnchored(akey) {
  const find = () => [...el.content.querySelectorAll('[data-akey]')].find((n) => n.dataset.akey === akey);
  const before = find()?.getBoundingClientRect().top;
  renderAll();
  const n = find();
  if (n && before != null) el.content.scrollTop += n.getBoundingClientRect().top - before;
}
function toggleInline(id) {
  st.open.has(id) ? st.open.delete(id) : st.open.add(id);
  setOpen(st.open); rerenderAnchored('f:' + id);
}
function inlineBlock(fid, depth = 0) {
  const box = h('div', { class: 'inl' + (depth ? ' nested' : '') });
  if (depth > 30) return box;
  for (const f of S.childFolders(fid)) {
    const open = st.open.has(f.id);
    box.append(h('div', { class: 'inl-row folder', 'data-akey': 'f:' + f.id, 'data-nav': '#/f/' + f.id, onclick: () => { location.hash = '#/f/' + f.id; } },
      h('button', { class: 'twisty', 'aria-label': open ? tr('כווץ') : tr('הרחב'), onclick: (e) => { e.stopPropagation(); toggleInline(f.id); } }, icon(open ? 'chevD' : CHEV_FWD, 18)),
      icon('folder', 18), (() => { const nm = h('span', { class: 'nm', title: f.name }, dn(f.name)); expandOnEllipsis(nm, tr('כווץ')); return nm; })(),
      h('small', {}, tr('{0} תוכניות · {1} תיקיות', S.plansIn(f.id).length, S.childFolders(f.id).length)),
      h('button', { class: 'icon-btn sm', 'aria-label': tr('עוד'), onclick: (e) => { e.stopPropagation(); folderMenu(f.id, e.currentTarget); } }, icon('more', 16))));
    if (open) box.append(inlineBlock(f.id, depth + 1));
  }
  for (const p of S.plansIn(fid)) {
    const v = S.curVer(p);
    box.append(h('div', { class: 'inl-row plan', onclick: () => openPlan(p) },
      h('span', { class: 'twisty' }), icon('file', 18), h('span', { class: 'nm', title: p.name, onclick: (e) => { e.stopPropagation(); e.currentTarget.classList.toggle('open'); } }, dn(p.name)), cloudBadge(p),
      h('small', {}, interleave([v?.pageCount ? tr('{0} עמ׳', v.pageCount) : null, fmtSize(v?.size)].filter(Boolean))),
      h('button', { class: 'icon-btn sm', 'aria-label': tr('עוד'), onclick: (e) => { e.stopPropagation(); planMenu(p.id, e.currentTarget); } }, icon('more', 16))));
  }
  if (!box.childNodes.length) box.append(h('div', { class: 'inl-empty' }, tr('התיקייה ריקה')));
  return box;
}

function folderCard(f) {
  const k = key('f', f.id);
  const d = S.descend(f.id);
  const card = cardBase(k, 'folder');
  const manual = getSort('folders').mode === 'manual';
  const sibs = S.childFolders(f.parentId || null);
  const idx = sibs.findIndex((x) => x.id === f.id);
  const isOpen = st.open.has(f.id);
  card.dataset.akey = 'f:' + f.id;
  if (manual) card.classList.add('has-reord');
  card.append(
    h('button', { class: 'fc-open', 'aria-label': isOpen ? tr('סגור תיקייה') : tr('הצג את תוכן התיקייה כאן'), title: isOpen ? tr('סגור') : tr('הצג תוכן כאן'), onclick: (e) => { e.stopPropagation(); toggleInline(f.id); } }, icon(isOpen ? 'chevD' : CHEV_FWD, 20)),
    h('div', { class: 'f-ic' }, icon('folder', 34)),
    h('div', { class: 'meta' }, (() => { const nm = h('div', { class: 'name', title: f.name }, dn(f.name)); expandOnEllipsis(nm, tr('כווץ')); return nm; })(), ovTags(f), h('div', { class: 'sub' }, tr('{0} תוכניות · {1} תיקיות', S.plansIn(f.id).length, S.childFolders(f.id).length) + (d.plans.length !== S.plansIn(f.id).length ? tr(' ({0} בסה״כ)', d.plans.length) : ''))),
    manual ? h('div', { class: 'reord' },
      h('button', { 'aria-label': tr('הזז למעלה'), disabled: idx <= 0, onclick: (e) => { e.stopPropagation(); moveFolderOrder(f, -1); } }, icon('chevU', 18)),
      h('button', { 'aria-label': tr('הזז למטה'), disabled: idx >= sibs.length - 1, onclick: (e) => { e.stopPropagation(); moveFolderOrder(f, 1); } }, icon('chevD', 18))) : '',
    h('button', { class: 'icon-btn more', 'aria-label': tr('עוד'), onclick: (e) => { e.stopPropagation(); folderMenu(f.id, e.currentTarget); } }, icon('more')));
  card.dataset.nav = '#/f/' + f.id;
  card.addEventListener('click', clickGuard(card, () => { location.hash = '#/f/' + f.id; }, k));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); if (card._long || carry) return; folderMenu(f.id, { x: e.clientX, y: e.clientY }); });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = '#/f/' + f.id; });
  makeDropTarget(card, f.id);
  return card;
}

// פתיחת תוכנית. אם היא עוד לא הורדה ואין חיבור – לא נכנסים למסך ריק, נשארים ברשימה
function openPlan(p, query) {
  if (needsDownload(p) && !navigator.onLine) { UI.toast(tr('התוכנית \"{0}\" עוד לא הורדה למכשיר ואין חיבור. אפשר לפתוח תוכניות שכבר הורדו.', p.name), { type: 'error', ms: 4000 }); return; }
  location.hash = '#/p/' + p.id + (query || '');
}
const cloudBadge = (p) => (needsDownload(p) ? h('span', { class: 'cloud-badge', title: tr('לא הורדה למכשיר') }, icon('cloud', 14)) : null);

function planCard(p, extra) {
  const k = key('p', p.id);
  const v = S.curVer(p);
  const card = cardBase(k, 'plan');
  const img = h('img', { alt: '', 'data-v': v?.id || '', draggable: false });
  const nver = S.versionsOf(p.id).length;
  card.append(
    h('div', { class: 'thumb' }, v?.broken ? h('div', { class: 'thumb-warn' }, icon('alert', 28), h('small', {}, tr('לא ניתן להציג'))) : icon('file', 32), img, cloudBadge(p)),
    h('div', { class: 'meta' },
      h('div', { class: 'name', title: p.name, onclick: (e) => { if (st.selMode || carry) return; e.stopPropagation(); e.currentTarget.classList.toggle('open'); } }, dn(p.name)), ovTags(p),
      h('div', { class: 'sub' }, interleave([v?.pageCount ? tr('{0} עמ׳', v.pageCount) : null, fmtSize(v?.size), nver > 1 ? tr('V{0} ({1} גרסאות)', v.number, nver) : null].filter(Boolean))),
      extra ? h('div', { class: 'sub path' }, extra) : null),
    h('button', { class: 'icon-btn more', 'aria-label': tr('עוד'), onclick: (e) => { e.stopPropagation(); planMenu(p.id, e.currentTarget); } }, icon('more')));
  if (v) io.observe(img);
  card.addEventListener('click', clickGuard(card, () => openPlan(p), k));
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); if (card._long || carry) return; planMenu(p.id, { x: e.clientX, y: e.clientY }); });
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openPlan(p); });
  return card;
}

function breadcrumbs() {
  const nav = h('nav', { class: 'crumbs', 'aria-label': tr('נתיב') });
  const seg = (name, id, last) => {
    const a = h('button', { class: 'crumb' + (last ? ' last' : ''), 'data-nav': '#/f/' + (id || ''), onclick: () => { location.hash = '#/f/' + (id || ''); } }, name);
    if (!last) makeDropTarget(a, id);
    return a;
  };
  nav.append(seg(dn(S.P.project.name), null, st.mode === 'folder' && !st.folderId));
  const path = S.folderPath(st.folderId);
  path.forEach((f, i) => { nav.append(icon(CHEV_FWD, 14), seg(dn(f.name), f.id, i === path.length - 1)); });
  return nav;
}

function renderFolder() {
  const fid = st.folderId;
  const folders = S.childFolders(fid);
  const plans = S.plansIn(fid);
  const cur = fid ? S.P.folders.get(fid) : null;
  const wrap = h('div', { class: 'page' });
  wrap.append(breadcrumbs());
  wrap.append(h('div', { class: 'title-row' },
    cur ? h('button', { class: 'icon-btn', 'aria-label': tr('לתיקיית האב'), title: tr('לתיקיית האב'), 'data-nav': '#/f/' + (cur.parentId || ''), onclick: () => { location.hash = '#/f/' + (cur.parentId || ''); } }, icon('up')) : null,
    h('h1', { title: cur ? cur.name : undefined }, dn(cur ? cur.name : S.P.project.name)),
    cur ? h('button', { class: 'icon-btn', 'aria-label': tr('עוד'), onclick: (e) => folderMenu(fid, e.currentTarget) }, icon('more')) : null));
  if (!folders.length && !plans.length) {
    wrap.append(h('div', { class: 'empty' },
      icon('folder', 48),
      h('h3', {}, tr('התיקייה ריקה')),
      h('p', {}, tr('צרו תיקיות ותתי-תיקיות בכל מבנה שתרצו, והעלו לתוכן קבצי PDF. אפשר גם לגרור קבצי PDF מהמחשב לכאן.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => A.uploadInto(fid) }, icon('upload', 18), tr('העלאת PDF')),
        h('button', { class: 'btn', onclick: () => A.newFolderDialog(fid) }, icon('folderPlus', 18), tr('תיקייה חדשה')))));
  }
  if (folders.length || plans.length) {
    const ds = S.descend(fid).folders;
    const allOpen = ds.length > 0 && ds.every((id) => st.open.has(id));
    wrap.append(h('div', { class: 'tools-row', 'data-akey': 'tools' },
      h('button', { class: 'btn sm', onclick: () => sortDialog() }, icon('sliders', 16), tr('מיון וסדר')),
      ds.length ? h('button', { class: 'btn sm', onclick: () => { ds.forEach((id) => (allOpen ? st.open.delete(id) : st.open.add(id))); setOpen(st.open); rerenderAnchored('tools'); } }, icon(allOpen ? 'chevU' : 'chevD', 16), allOpen ? tr('סגור את כל התיקיות') : tr('פתח את כל התיקיות')) : null));
  }
  if (folders.length) {
    wrap.append(h('h4', { class: 'sec' }, tr('תיקיות ({0})', folders.length)));
    wrap.append(h('div', { class: 'grid folders' }, folders.flatMap((f) => [folderCard(f), st.open.has(f.id) ? h('div', { class: 'fold-inline' }, inlineBlock(f.id)) : null])));
  }
  if (plans.length) {
    wrap.append(h('h4', { class: 'sec' }, tr('תוכניות ({0})', plans.length)));
    const grid = h('div', { class: 'grid plans ' + st.view });
    const draw = (from, to) => plans.slice(from, to).forEach((p) => grid.append(planCard(p)));
    draw(0, st.chunk);
    wrap.append(grid);
    if (plans.length > st.chunk) {
      const more = h('button', { class: 'btn block', onclick: () => { const a = st.chunk; st.chunk += 60; draw(a, st.chunk); if (st.chunk >= plans.length) more.remove(); } }, tr('הצג עוד ({0})', plans.length - st.chunk));
      wrap.append(more);
      const sentinel = new IntersectionObserver((es) => { if (es[0].isIntersecting && more.isConnected) more.click(); }, { rootMargin: '400px' });
      sentinel.observe(more);
    }
  }
  wrap.append(credit());
  el.content.replaceChildren(wrap);
}

// ---------- מיון וסדר ----------
const DIR_LABELS = {
  name: ['א ← ת (עולה)', 'ת ← א (יורד)'], modified: ['ישן ← חדש', 'חדש ← ישן'], created: ['ישן ← חדש', 'חדש ← ישן'],
  size: ['קטן ← גדול', 'גדול ← קטן'], pages: ['מעט ← הרבה', 'הרבה ← מעט'], count: ['מעט ← הרבה', 'הרבה ← מעט'],
};
function sortDialog() {
  const body = h('div', { class: 'stack sort-body' });
  const m = UI.openModal({ title: tr('מיון וסדר'), body, buttons: [{ text: tr('סגור'), value: true }] });
  const apply = (kind, patch) => {
    const next = { ...patch };
    if (patch.mode && !patch.dir) next.dir = patch.mode === 'name' ? 'asc' : 'desc'; // תאריכים/גודל: החדש והגדול קודם
    setSort(kind, next); S.resort(); draw();
    if (kind === 'folders' && patch.mode === 'manual') UI.toast(tr('סדר ידני: בכל כרטיס תיקייה יש חצים למעלה ולמטה'), { ms: 3500 });
  };
  const group = (title, kind, modes, note) => {
    const cur = getSort(kind);
    const labels = DIR_LABELS[cur.mode];
    return h('div', { class: 'set-sec' }, h('b', {}, title),
      h('select', { onchange: (e) => apply(kind, { mode: e.target.value }) }, ...modes.map(([v, l]) => h('option', { value: v, selected: cur.mode === v }, tr(l)))),
      labels ? h('div', { class: 'row' }, ...['asc', 'desc'].map((d, i) => h('button', { class: 'btn sm' + (cur.dir === d ? ' primary' : ''), onclick: () => apply(kind, { dir: d }) }, tr(labels[i])))) : null,
      note ? h('small', { class: 'hint-inline' }, note) : null);
  };
  function draw() {
    body.replaceChildren(
      group(tr('סדר התיקיות'), 'folders', FOLDER_MODES, getSort('folders').mode === 'manual' ? tr('הסדר הידני נשמר במכשיר הזה. סדרו עם החצים שעל כל תיקייה.') : ''),
      group(tr('סדר התוכניות'), 'plans', PLAN_MODES, ''),
      h('small', { class: 'hint-inline' }, tr('המיון נשמר במכשיר הזה ולא משפיע על עובדים אחרים.')));
  }
  draw();
  return m;
}

// ---------- חיפוש ----------
let searchToken = 0;
function renderSearch() {
  const q = st.query;
  const wrap = h('div', { class: 'page' });
  wrap.append(h('div', { class: 'title-row' }, h('h1', {}, tr('חיפוש: {0}', q))));
  if (st.scope && !S.P.folders.has(st.scope)) st.scope = '';
  const scope = S.scopeSet(st.scope);
  wrap.append(h('div', { class: 'scope-row' }, h('span', {}, tr('חיפוש ב:')), UI.folderScopeSelect(st.scope, (v) => { st.scope = v; renderSearch(); })));
  const { folders, plans } = S.searchNames(q, scope);
  if (folders.length) {
    wrap.append(h('h4', { class: 'sec' }, tr('תיקיות ({0})', folders.length)));
    wrap.append(h('div', { class: 'result-list' }, folders.slice(0, 100).map((f) => h('button', { class: 'result', onclick: () => { location.hash = '#/f/' + f.id; } },
      icon('folder', 20), h('span', { class: 'col' }, h('b', {}, dn(f.name)), h('small', {}, S.pathText(f.parentId)))))));
  }
  if (plans.length) {
    wrap.append(h('h4', { class: 'sec' }, tr('תוכניות ({0})', plans.length)));
    wrap.append(h('div', { class: 'result-list' }, plans.slice(0, 200).map((p) => h('button', { class: 'result', onclick: () => openPlan(p) },
      icon('file', 20), h('span', { class: 'col' }, h('b', {}, dn(p.name)), h('small', {}, S.planPathText(p)))))));
  }
  const textBox = h('div', {}, h('h4', { class: 'sec' }, tr('טקסט בתוך קבצי PDF')), h('p', { class: 'hint' }, q.length < 2 ? tr('הקלידו לפחות 2 תווים לחיפוש בתוך הקבצים.') : tr('מחפש…')));
  wrap.append(textBox);
  if (!folders.length && !plans.length && q.length < 2) wrap.append(h('p', { class: 'empty-sm' }, tr('לא נמצאו תוצאות')));
  wrap.append(credit());
  el.content.replaceChildren(wrap);
  if (q.length >= 2) {
    const token = ++searchToken;
    S.searchText(q, 150, () => token !== searchToken, scope).then((rows) => {
      if (token !== searchToken) return;
      textBox.replaceChildren(h('h4', { class: 'sec' }, tr('טקסט בתוך קבצי PDF ({0}{1})', rows.length, rows.length >= 150 ? '+' : '')));
      if (!rows.length) {
        const pending = [...S.P.versions.values()].filter((v) => !v.indexed && !v.broken).length;
        textBox.append(h('p', { class: 'hint' }, pending ? tr('לא נמצאו תוצאות. {0} קבצים עדיין באינדוקס, נסו שוב בעוד רגע.', pending) : tr('לא נמצא טקסט תואם בקבצים. (קבצי סריקה ללא טקסט ניתנים לחיפוש רק אחרי זיהוי טקסט – OCR – בתוך התוכנית, בתפריט ⋮.)')));
        if (!pending) textBox.append(h('button', { class: 'btn sm', onclick: async () => { if (await UI.confirmBox(tr('האפליקציה קוראת את הטקסט מכל ה-PDF ברקע כדי שאפשר יהיה לחפש בתוכם. אם נראה שהחיפוש מפספס טקסט שקיים בקבצים, אפשר לבנות את האינדקס מחדש. זה לא משנה ולא מוחק שום קובץ. להמשיך?'), { okText: tr('בנה מחדש') })) { await S.reindexAll(); UI.toast(tr('האינדוקס התחיל ברקע')); } } }, tr('החיפוש מפספס? בנה מחדש אינדקס טקסט')));
        return;
      }
      textBox.append(h('div', { class: 'result-list' }, rows.map((r) => {
        const p = S.P.plans.get(r.planId);
        return h('button', { class: 'result', onclick: () => { if (p) openPlan(p, `?page=${r.page}&q=${encodeURIComponent(q)}`); } },
          icon('search', 20), h('span', { class: 'col' }, h('b', {}, tr('{0} – עמוד {1}', dn(p.name), r.page)), h('small', {}, S.planPathText(p)), h('span', { class: 'snip' }, r.snippet)));
      })));
    });
  }
}

// ---------- ניהול אחסון ----------
async function renderStorage() {
  const wrap = h('div', { class: 'page' });
  wrap.append(h('div', { class: 'title-row' },
    h('button', { class: 'icon-btn', 'aria-label': tr('חזרה'), onclick: () => { location.hash = '#/f/' + (st.folderId || ''); } }, icon('back')),
    h('h1', {}, tr('ניהול אחסון'))));
  wrap.append(h('p', { class: 'hint' }, tr('כאן רואים כמה מקום תופסות התוכניות ואפשר למחוק קבצים כדי לפנות מקום. גיבוי ושחזור נמצאים בתפריט הצד: "גיבוי ושחזור".')));
  wrap.append(credit());
  el.content.replaceChildren(wrap);
  const est = await db.storageEstimate();
  const rows = S.usageByPlan();
  const total = rows.reduce((s, r) => s + r.size, 0);
  const versions = S.P.versions.size;
  const frac = est.quota ? est.usage / est.quota : 0;
  const box = h('div', { class: 'stor-box' },
    h('div', { class: 'stor-nums' },
      h('div', {}, h('b', {}, fmtSize(total)), h('small', {}, tr('קבצי PDF (מקוריים)'))),
      h('div', {}, h('b', {}, String(S.P.plans.size)), h('small', {}, tr('תוכניות'))),
      h('div', {}, h('b', {}, String(versions)), h('small', {}, tr('גרסאות'))),
      h('div', {}, h('b', {}, fmtSize(est.usage)), h('small', {}, tr('סה״כ בשימוש (כולל נתוני מערכת)')))),
    est.quota ? h('div', { class: 'bar' + (frac > 0.8 ? ' danger' : '') }, h('div', { class: 'bar-fill', style: { width: Math.min(100, frac * 100) + '%' } })) : null,
    est.quota ? h('small', {}, tr('{0} מתוך כ-{1} שהדפדפן מקצה ({2}%). המכסה משתנה לפי המכשיר והדפדפן.', fmtSize(est.usage), fmtSize(est.quota), (frac * 100).toFixed(1))) : h('small', {}, tr('הדפדפן לא מדווח על מכסת אחסון.')),
    frac > 0.8 ? h('p', { class: 'warn' }, tr('האחסון מתקרב למגבלה. מומלץ לגבות (תפריט ← גיבוי ושחזור) ולמחוק קבצים שלא בשימוש.')) : null,
    h('p', { class: est.persisted ? 'ok' : 'hint' }, est.persisted ? tr('האחסון מסומן כקבוע – הדפדפן לא אמור למחוק אותו אוטומטית.') : tr('האחסון לא מסומן כקבוע: בלחץ מקום, או ב-Safari אחרי כמה ימים בלי שימוש (כשלא מותקן כאפליקציה), הדפדפן עלול למחוק נתונים. התקנה למסך הבית וגיבוי קבוע מקטינים את הסיכון.')),
    est.persisted ? null : h('button', { class: 'btn', onclick: async () => { const ok = await db.requestPersist(); UI.toast(ok ? tr('האחסון סומן כקבוע') : tr('הדפדפן לא אישר אחסון קבוע'), { type: ok ? '' : 'error' }); renderStorage(); } }, tr('בקש אחסון קבוע')));
  wrap.append(box);
  wrap.append(h('h4', { class: 'sec' }, tr('תוכניות לפי גודל')));
  if (!rows.length) wrap.append(h('p', { class: 'empty-sm' }, tr('אין עדיין תוכניות')));
  wrap.append(h('div', { class: 'stor-list' }, rows.slice(0, 500).map((r) => h('div', { class: 'stor-row' },
    h('div', { class: 'col' }, h('b', {}, dn(r.plan.name)), h('small', {}, tr('{0} · {1} גרסאות', S.planPathText(r.plan), r.versions))),
    h('span', { class: 'sz' }, fmtSize(r.size)),
    h('button', { class: 'icon-btn', 'aria-label': tr('מחק'), onclick: async () => { if (await A.deleteDialog({ folders: [], plans: [r.plan.id] })) renderStorage(); } }, icon('trash', 18))))));
  if (rows.length > 500) wrap.append(h('p', { class: 'hint' }, tr('מוצגות 500 הגדולות מתוך {0}.', rows.length)));
}
