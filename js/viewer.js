// ה-Viewer: זום עמוק וחד, גרירה, Pinch, סימונים, מדידות, קישורים, השוואה, חיפוש, גרסאות
import { pushLayer } from './backstack.js';
import { t as tr, CHEV_FWD, CHEV_BACK, toggleLang, langButtonLabel } from './i18n.js';
import { dn, onNamesChange } from './names.js';
import * as OCR from './ocr.js';
import * as S from './store.js';
import * as db from './db.js';
import * as UI from './ui.js';
import * as diag from './diag.js';
import * as A from './actions.js';
import { openPdf, pageText, destroyDoc } from './pdfio.js';
import { Layer } from './layer.js';
import { h, icon, uid, clamp, clone, fmtDate, natural } from './util.js';
import {
  svg, LAYER_OF, RECT_TYPES, dist, drawItem, hitItem, handlesOf, boundsOf, corners, textBox,
  paperName, mpuFromRatio, fmtLen, kindOf, polyArea, pathLength,
} from './markup.js';
import { recognize, snapAngle } from './shape-recog.js';
import { prefs, savePrefs, COLORS, WIDTHS } from './prefs.js';
import { installStyle } from './viewer-style.js';
import { installPrint } from './viewer-print.js';
import * as CS from './cloud-sync.js';
import { isCloud, isAdmin } from './cloud.js';
import { exportMeasurementsXlsx } from './xlsx-export.js';
import * as SH from './item-share-ui.js';
import { SplitHost } from './split.js';

const PT = 96 / 72; // "100%" = גודל אמיתי ב-96 DPI
const GAP = 24;
const MAXS = PT * 64; // עד 6400%
const TOOLS = [
  { id: 'pan', icon: 'move', label: tr('הזזה') },
  { id: 'select', icon: 'cursor', label: tr('בחירה') },
  { sep: true },
  { id: 'pen', icon: 'pen', label: tr('עט') },
  { id: 'line', icon: 'line', label: tr('קו') },
  { id: 'polyline', icon: 'polyline', label: tr('קו נקודות') },
  { id: 'arrow', icon: 'arrow', label: tr('חץ') },
  { id: 'rect', icon: 'rect', label: tr('מלבן') },
  { id: 'ellipse', icon: 'circle', label: tr('עיגול') },
  { id: 'text', icon: 'type', label: tr('טקסט') },
  { id: 'highlight', icon: 'highlight', label: tr('הדגשה') },
  { id: 'eraser', icon: 'eraser', label: tr('מחק') },
  { sep: true },
  { id: 'measure', icon: 'ruler', label: tr('מרחק') },
  { id: 'area', icon: 'polygon', label: tr('שטח') },
  { sep: true },
  { id: 'link', icon: 'link', label: tr('קישור') },
];

const lastView = new Map();

let cur = null;
let split = null; // תצוגה מפוצלת פעילה (SplitHost) – במקום cur
let pickCtx = null;
const ASSIST_TYPES = new Set(['seg', 'seg2', 'poly', 'drag', 'pen']), EDGE_TYPES = new Set(['seg', 'drag', 'pen']);
export function startPick(ctx) { pickCtx = ctx; }
if (typeof window !== 'undefined') window.__viewer = () => cur;

export async function openViewer(root, planId, opts = {}) {
  if (split && !split.dead) { await split.routeOpen(planId, opts); return; }
  if (cur && cur.planId === planId) { await cur.handleOpts(opts); return; }
  await closeViewer();
  cur = new Viewer(root, planId, opts);
  await cur.init();
}
export async function closeViewer() {
  if (split) { const s = split; split = null; await s.teardown(); }
  if (cur) { const c = cur; cur = null; await c.destroy(); }
}
// כניסה לתצוגה מפוצלת מתוך צופה רגיל: בוחרים תוכנית שנייה, והתוכנית הנוכחית נשארת באותה נקודת תצוגה
async function enterSplit(v) {
  const p = await UI.planPicker({ title: tr('איזו תוכנית לפתוח לצד התוכנית הזו?') });
  if (!p || cur !== v) return;
  const root = v.root, keep = { page: v.pageNum, view: v.page ? v.viewCenter() : undefined, v: v.version?.id }, pid = v.planId;
  cur = null; await v.destroy();
  split = new SplitHost(Viewer, root, { onExit: (st) => exitSplit(root, st || { planId: pid, opts: keep }) });
  await split.add(pid, keep);
  await split.add(p.id, {});
}
async function exitSplit(root, st) {
  split = null;
  if (!st) { location.hash = '#/f/'; return; }
  try { history.replaceState(history.state, '', '#/p/' + st.planId); } catch { /* ignore */ }
  cur = new Viewer(root, st.planId, st.opts);
  await cur.init();
}

class Viewer {
  constructor(root, planId, opts, host = null) {
    this.root = root; this.planId = planId; this.opts = opts; this.host = host; this.dead = false;
    this.scale = 1; this.tx = 0; this.ty = 0; this.W = 1; this.H = 1; this.vw = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.tool = 'pan'; this.fitMode = 'page';
    try { this.cont = localStorage.getItem('plans.cont') === '1'; } catch { this.cont = false; }
    this.ptrs = new Map(); this.gesture = null; this.pinch = null;
    this.items = { markups: [], measurements: [], links: [] };
    this.calibs = new Map(); this.history = []; this.redoStack = [];
    this.selected = null; this.draft = null;
    this.pageToken = 0; this.searchToken = 0; this.textCache = new Map();
    this.cmp = null; this.split = false; this.lastTap = { t: 0, x: 0, y: 0 };
    this.eraseSet = null; this.styleOpen = false; this._editBefore = null;
  }

  // ---------- בנייה ----------
  build() {
    this.titleEl = h('div', { class: 'v-title', title: this.host ? tr('לחצו כדי להחליף תוכנית בתצוגה הזו') : tr('לחצו לשינוי שם התוכנית') });
    this.titleEl.addEventListener('click', () => (this.host ? this.host.pickFor(this) : this.renameDialog()));
    const btn = (ic, label, fn) => h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick: fn }, icon(ic));
    this.stage = h('div', { class: 'v-stage' });
    this.layerA = new Layer();
    this.layerB = new Layer();
    this.layerB.el.style.display = 'none';
    this.layerN = new Layer(); this.layerP = new Layer();
    this.svg = svg('svg', { class: 'v-overlay', preserveAspectRatio: 'none' });
    this.gSearch = svg('g'); this.gItems = svg('g'); this.gDraft = svg('g'); this.gSel = svg('g');
    this.svg.append(this.gSearch, this.gItems, this.gDraft, this.gSel);
    this.loading = h('div', { class: 'v-loading' }, tr('טוען תוכנית…'));
    this.stage.append(this.layerA.el, this.layerB.el, this.layerN.el, this.layerP.el, this.svg, this.loading);

    this.topbar = h('header', { class: 'v-top' },
      this.host ? btn('x', tr('סגור תצוגה זו'), () => this.host.close(this)) : btn('back', tr('חזרה'), () => this.goBack()),
      this.titleEl,
      this.host ? btn('folder', tr('החלף תוכנית בתצוגה הזו'), () => this.host.pickFor(this)) : null,
      btn('search', tr('חיפוש בתוכנית'), () => this.openPanel('search')),
      btn('grid', tr('עמודים'), () => this.openPanel('pages')),
      btn('layers', tr('שכבות'), () => this.layersDialog()),
      btn('compare', tr('השוואת תוכניות'), () => this.openCompare()),
      btn('clock', tr('גרסאות'), () => A.versionsDialog(this.planId, { onChange: () => this.afterVersionsChange() })),
      btn('print', tr('הדפסה'), () => this.printDialog()),
      this.host ? btn('split', tr('תצוגה מפוצלת'), (e) => this.host.menu(this, e.currentTarget)) : null,
      btn('more', tr('עוד'), (e) => this.moreMenu(e.currentTarget)));
    // במסכים צרים מעבירים כפתורים משניים לתפריט ⋮ כדי שיישאר מקום לשם התוכנית
    this.topbar.querySelectorAll([tr('שכבות'), tr('השוואת תוכניות'), tr('גרסאות'), tr('הדפסה')].map((x) => `[aria-label="${x}"]`).join(',')).forEach((b) => b.classList.add('nh'));

    this.zoomLabel = h('button', { class: 'zl', onclick: () => this.setZoom100() }, '100%');
    const zbtn = (ic, label, dir) => { const b = btn(ic, label, () => {}); b.onclick = null; this.holdZoom(b, dir); return b; };
    this.zoomBar = h('div', { class: 'v-zoom v-float' },
      zbtn('zoomIn', tr('הגדל (לחיצה ארוכה = הגדלה רציפה)'), 1),
      this.zoomLabel,
      zbtn('zoomOut', tr('הקטן (לחיצה ארוכה = הקטנה רציפה)'), -1),
      this.fsBtn = btn('expand', tr('מסך מלא'), () => this.toggleFullscreen()),
      this.splitBtn = btn('split', tr('תצוגה מפוצלת: פתיחת 2–3 תוכניות במקביל'), () => this.splitEnter()),
      btn('maximize', tr('התאמה למסך: עמוד שלם / רוחב / גובה (לחיצות חוזרות מחליפות)'), () => this.cycleFit()),
      this.contBtn = btn('scroll', tr('גלילה רציפה (עמודים ברצף) / עמוד בודד'), () => this.setCont(!this.cont)));

    this.pageLabel = h('button', { class: 'pl', onclick: () => this.pagePrompt() }, '1 / 1');
    this.pageBar = h('div', { class: 'v-pages v-float' },
      btn(CHEV_BACK, tr('עמוד קודם'), () => this.goPage(this.pageNum - 1)),
      this.pageLabel,
      btn(CHEV_FWD, tr('עמוד הבא'), () => this.goPage(this.pageNum + 1)));

    this.props = h('div', { class: 'v-props' });
    this.toolbar = h('div', { class: 'v-tools' });
    this.buildToolbar();
    this.panel = h('aside', { class: 'v-panel hidden' });
    this.cmpBar = h('div', { class: 'v-cmp hidden' });
    this.pickBar = h('div', { class: 'v-pick hidden' });
    this.exitImm = h('button', { class: 'v-exit-imm', 'aria-label': tr('הצג סרגלים'), onclick: () => this.el.classList.remove('immersive') }, icon('chevD'));

    this.sbarLabel = h('span', { class: 'sl' }, '');
    this.sbar = h('div', { class: 'v-sbar v-float hidden' },
      btn('chevU', tr('תוצאה קודמת'), () => this.gotoMatch(this.search.idx - 1)),
      this.sbarLabel,
      btn('chevD', tr('תוצאה הבאה'), () => this.gotoMatch(this.search.idx + 1)),
      btn('list', tr('רשימת תוצאות'), () => this.openPanel('search')),
      btn('x', tr('סיום חיפוש'), () => this.clearSearch()));
    this.mid = h('div', { class: 'v-mid' }, this.stage, this.zoomBar, this.pageBar, this.sbar, this.panel);
    this.exitFs = h('button', { class: 'v-exit-fs', 'aria-label': tr('כיווץ מסך מלא'), onclick: () => this.exitFullscreenMode() }, icon('x', 18), h('span', {}, tr('כיווץ מסך מלא')));
    // במסך מלא: חץ קטן שפותח/סוגר את כלי העריכה והאפשרויות מעל התוכנית
    this.fsToolsBtn = h('button', { class: 'v-fs-tools', 'aria-label': tr('כלי עריכה ואפשרויות'), onclick: () => { this.el.classList.toggle('fs-tools'); this._quietUntil = performance.now() + 250; } }, icon('chevU', 20));
    this.el = h('div', { class: 'viewer' }, this.topbar, this.pickBar, this.mid,
      this.cmpBar, this.props, this.toolbar, this.exitImm, this.exitFs, this.fsToolsBtn);
    this.root.append(this.el);
    this.el.classList.toggle('cont', !!this.cont); this.contBtn.classList.toggle('on', !!this.cont);
    this.fsBtn.classList.add('only-single'); this.splitBtn.classList.add('only-single');
    if (this.host) { // תצוגה בתוך פיצול: הסרגל התחתון משותף ויושב אצל המארח, ונכנסים אליו כשהתצוגה פעילה
      this.el.classList.add('pane');
      this.props.remove(); this.toolbar.remove();
      this.el.addEventListener('pointerdown', () => this.host.setActive(this), true);
    }
    this._onPop = () => {
      if (window.__layerPop) return; // "אחורה" שנוצל לסגירת תפריט/חלון
      if (!this._sPush) return;
      this._sPush = false;
      if (this.panelMode === 'search') { this.closePanel(); this.pushSearch(); } // שלב 1: סוגר את לוח החיפוש, הסימונים נשארים
      else this.clearSearch(); // שלב 2: מנקה את החיפוש
    };
    window.addEventListener('popstate', this._onPop);

    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this.onDown(e));
    s.addEventListener('pointermove', (e) => this.onMove(e));
    s.addEventListener('pointerup', (e) => this.onUp(e));
    s.addEventListener('pointercancel', (e) => this.onUp(e, true));
    s.addEventListener('lostpointercapture', (e) => { if (this.ptrs.has(e.pointerId)) this.onUp(e, true); });
    s.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('dblclick', (e) => { if (this.tool === 'area' || this.tool === 'polyline') { e.preventDefault(); this.finishArea(); } });
    this.keyFn = (e) => this.onKey(e);
    this.keyUpFn = (e) => { if (e.code === 'Space') this.spaceDown = false; };
    document.addEventListener('keydown', this.keyFn);
    document.addEventListener('keyup', this.keyUpFn);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.stage);
    this._onFsChange = () => this.onFsChange();
    document.addEventListener('fullscreenchange', this._onFsChange);
    this.offItems = S.onItems((vids) => { if (this.version && vids && vids.includes(this.version.id)) this.reloadItems(); });
    if (isCloud()) SH.getPeople().then(() => { if (this.items) this.renderProps(); });
    this.measure();
    this.renderProps();
  }

  buildToolbar() {
    this.toolBtns = {};
    this.toolbar.textContent = '';
    for (const t of TOOLS) {
      if (t.sep) { this.toolbar.append(h('span', { class: 'tsep' })); continue; }
      const b = h('button', { class: 'tool', 'data-tool': t.id, title: t.label, onclick: () => this.setTool(t.id) }, icon(t.icon, 22), h('span', {}, t.label));
      this.toolBtns[t.id] = b;
      this.toolbar.append(b);
    }
    this.toolbar.append(h('span', { class: 'tsep' }));
    this.undoBtn = h('button', { class: 'tool', title: tr('בטל'), onclick: () => this.undo() }, icon('undo', 22), h('span', {}, tr('בטל')));
    this.redoBtn = h('button', { class: 'tool', title: tr('שחזר'), onclick: () => this.redo() }, icon('redo', 22), h('span', {}, tr('חזור')));
    this.toolbar.append(this.undoBtn, this.redoBtn);
    this.updateToolUI();
    this.updateUndo();
  }

  async init() {
    const plan = S.P.plans.get(this.planId);
    if (!plan) { UI.toast(tr('התוכנית לא נמצאה'), { type: 'error' }); location.hash = '#/f/'; return; }
    this.plan = plan;
    this.build();
    const o = this.opts;
    const vid = o.v && S.P.versions.get(o.v)?.planId === plan.id ? o.v : plan.currentVersionId;
    await this.loadVersion(vid, o);
  }

  async handleOpts(o) {
    this.opts = o;
    if (o.pick) this.showPickBar();
    const vid = o.v && S.P.versions.get(o.v)?.planId === this.planId ? o.v : null;
    if (vid && vid !== this.version?.id) { await this.loadVersion(vid, o); return; }
    if (!this.doc) return;
    if (o.page && o.page !== this.pageNum) await this.goPage(o.page, { view: this.viewOf(o), fresh: true });
    else if (o.view || o.x != null) { const v = this.viewOf(o); if (v) this.applyView(v); }
    if (o.query) this.runSearch(o.query, true);
    if (o.cmp) this.openCompare(o.cmp);
  }
  viewOf(o) {
    if (o.view) return o.view;
    if (o.x != null && o.y != null && o.z != null) return { cx: o.x, cy: o.y, scale: o.z };
    return null;
  }

  async loadVersion(vid, o = {}) {
    const ver = S.P.versions.get(vid);
    this.version = ver;
    this.loading.style.display = '';
    this.loading.textContent = tr('טוען תוכנית…');
    const blob = await S.getFileBlob(vid);
    if (!blob || !ver || ver.broken) { this.showFallback(blob ? tr('ה-Viewer הפנימי לא הצליח לפתוח את הקובץ הזה.') : tr('הקובץ לא נמצא באחסון המקומי.')); return; }
    let doc;
    try { doc = await openPdf(blob, { interactive: true }); } catch (e) {
      console.error(e);
      this.showFallback(e?.name === 'PasswordException' ? tr('הקובץ מוגן בסיסמה.') : tr('ה-Viewer הפנימי לא הצליח לפתוח את הקובץ הזה.'));
      return;
    }
    if (this.dead) { destroyDoc(doc); return; }
    destroyDoc(this.doc);
    this.doc = doc; this.numPages = doc.numPages; this.textCache.clear();
    this.search = null;
    const [mk, ms, ln, cal] = await Promise.all(['markups', 'measurements', 'links', 'calibrations'].map((s) => db.byIndex(s, 'versionId', vid)));
    this.items = { markups: mk, measurements: ms, links: ln };
    this.setCals(cal);
    this.history = []; this.redoStack = [];
    this.updateUndo(); this.updateTitle();
    const first = clamp(o.page || lastView.get(vid + ':last') || 1, 1, this.numPages);
    await this.goPage(first, { view: this.viewOf(o), fresh: !!o.page });
    if (o.pick) this.showPickBar();
    if (o.query) this.runSearch(o.query, true);
    if (o.cmp) this.openCompare(o.cmp);
  }

  showFallback(msg) {
    this.loading.style.display = 'none';
    const box = h('div', { class: 'v-fallback' },
      icon('alert', 44), h('h3', {}, tr('לא ניתן להציג את התוכנית')), h('p', {}, msg),
      h('p', { class: 'hint' }, tr('הקובץ המקורי שמור ולא שונה. אפשר להוריד אותו או לפתוח אותו באפליקציית PDF אחרת.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => A.openWithDialog(this.plan, this.version?.id) }, icon('share', 18), tr('פתח באמצעות…')),
        h('button', { class: 'btn', onclick: () => A.downloadVersion(this.version?.id, this.plan.name) }, icon('download', 18), tr('הורד'))));
    this.stage.append(box);
    this.updateTitle();
  }

  updateTitle() {
    if (!this._nameSub) this._nameSub = onNamesChange(() => { if (this.plan) this.updateTitle(); });
    const vs = S.versionsOf(this.planId);
    const v = this.version;
    const isCur = v && this.plan.currentVersionId === v.id;
    this.titleEl.replaceChildren(
      h('b', { title: this.plan.name }, dn(this.plan.name), h('span', { class: 'ted' }, icon('edit', 13))),
      h('small', {}, [v && vs.length > 1 ? `V${v.number} · ${fmtDate(v.date)}` : null, v && !isCur ? tr('גרסה ישנה') : null].filter(Boolean).join(' · ') || S.planPathText(this.plan)));
    this.titleEl.classList.toggle('old', !!(v && !isCur));
  }
  afterVersionsChange() {
    if (!S.P.plans.has(this.planId)) return;
    if (this.version && !S.P.versions.has(this.version.id)) { this.loadVersion(this.plan.currentVersionId, {}); return; }
    this.updateTitle();
  }

  goBack() {
    if (this.panelMode === 'search') { this.closePanel(); return; }
    if (this.search) { this.clearSearch(); return; }
    if (this.host) { this.host.close(this); return; }
    if (pickCtx && this.opts.pick) pickCtx = null;
    if (window.__navCount > 0) history.back();
    else location.hash = '#/f/' + (this.plan.folderId || '');
  }

  // ---------- מדידות תצוגה ----------
  measure() {
    this.W = this.stage.clientWidth || 1;
    this.H = this.stage.clientHeight || 1;
    this.vw = this.split ? this.W / 2 : this.W;
    if (this.split) {
      this.layerA.el.style.clipPath = `inset(0 ${this.W - this.vw}px 0 0)`;
      this.layerB.el.style.clipPath = `inset(0 0 0 ${this.vw}px)`;
      this.layerB.sx = this.vw;
    } else {
      this.layerA.el.style.clipPath = ''; this.layerB.el.style.clipPath = ''; this.layerB.sx = 0;
    }
  }
  onResize() {
    // בזמן מעבר למסך מלא / יציאה ממנו הדפדפן שולח הרבה אירועי שינוי גודל. מחכים שהמעבר יסתיים ומחשבים פעם אחת.
    const left = (this._quietUntil || 0) - performance.now();
    if (left > 0) { clearTimeout(this._rt); this._rt = setTimeout(() => this.doResize(), left + 30); return; }
    this.doResize();
  }
  doResize() {
    const w = this.W, hh = this.H;
    this.measure();
    if (w === this.W && hh === this.H) return;
    if (!this.page) return;
    if (this.fitMode) this.fit(this.fitMode); else this.setView(this.scale, this.tx, this.ty);
  }
  minScale() { return Math.min(this.vw / this.pw, this.H / this.ph) * 0.4; }
  clampView(s, tx, ty) {
    const M = 60, pw = this.pw * s, ph = this.ph * s;
    tx = pw <= this.vw ? (this.vw - pw) / 2 : clamp(tx, this.vw - pw - M, M);
    if (this.cont) { // גלילה רציפה: מותר לגלול עד סוף העמוד הסמוך
      const up = this.layerP.page ? (this.layerP.ph + GAP) * s : 0, dn = this.layerN.page ? (this.layerN.ph + GAP) * s : 0;
      ty = clamp(ty, this.H - ph - M - dn, M + up);
      return [tx, ty];
    }
    ty = ph <= this.H ? (this.H - ph) / 2 : clamp(ty, this.H - ph - M, M);
    return [tx, ty];
  }
  setView(scale, tx, ty, { keepFit = false } = {}) {
    if (!this.page) return;
    scale = clamp(scale, this.minScale(), MAXS);
    [tx, ty] = this.clampView(scale, tx, ty);
    if (this.cont) {
      const sh = this.maybeShift(scale, tx, ty);
      if (sh) { [tx, ty] = this.clampView(scale, sh[0], sh[1]); }
    }
    if (!keepFit) this.fitMode = null;
    this.scale = scale; this.tx = tx; this.ty = ty;
    this.applyTransform();
    this.scheduleDetail();
    this.updateZoomUI();
  }
  applyTransform() {
    const { scale, tx, ty, vw, H, dpr } = this;
    this.svg.style.width = vw + 'px';
    this.svg.setAttribute('viewBox', `${-tx / scale} ${-ty / scale} ${vw / scale} ${H / scale}`);
    this.layerA.place(scale, tx, ty, dpr);
    if (this.cmp) this.layerB.place(scale, tx, ty, dpr);
    if (this.cont) { this.layerN.place(scale, tx, ty, dpr); this.layerP.place(scale, tx, ty, dpr); }
    if (this.selected || this.draft) { this.renderSel(); this.renderDraft(); }
  }
  scheduleDetail(delay = 140) {
    clearTimeout(this.dt);
    this.dt = setTimeout(() => this.renderDetails(), delay);
  }
  renderDetails() {
    if (!this.page) return;
    const { scale, tx, ty, W, H, dpr } = this;
    this.layerA.renderDetail(scale, tx, ty, W, H, dpr);
    if (this.cmp) this.layerB.renderDetail(scale, tx, ty, W, H, dpr);
    if (this.cont) {
      const nTop = ty + (this.ph + GAP) * scale, pBot = ty - GAP * scale;
      if (this.layerN.page && nTop < H) this.layerN.renderDetail(scale, tx, ty, W, H, dpr); else this.layerN.removeDetail();
      if (this.layerP.page && pBot > 0) this.layerP.renderDetail(scale, tx, ty, W, H, dpr); else this.layerP.removeDetail();
    }
  }
  // ---------- גלילה רציפה ----------
  placeNeighbors() {
    const N = this.layerN, P = this.layerP;
    N.dx = (this.pw - N.pw) / 2; N.dy = this.ph + GAP;
    P.dx = (this.pw - P.pw) / 2; P.dy = -(P.ph + GAP);
  }
  async loadNeighbors() {
    const show = this.cont && !this.cmp && !this.split;
    for (const [L, n] of [[this.layerN, this.pageNum + 1], [this.layerP, this.pageNum - 1]]) {
      if (!show || n < 1 || n > this.numPages) { if (L.n) L.clear(); continue; }
      if (L.n === n) continue;
      const tok = this.pageToken;
      L.clear();
      const pg = await this.doc.getPage(n);
      if (tok !== this.pageToken || this.dead || !this.cont) return;
      L.n = n;
      L.setPage(pg);
    }
    this.placeNeighbors();
    this.applyTransform();
    this.scheduleDetail(60);
  }
  maybeShift(scale, tx, ty) {
    const mid = this.H / 2;
    let dir = 0;
    if (this.layerN.page && this.layerN.n === this.pageNum + 1 && ty + (this.ph + GAP / 2) * scale < mid) dir = 1;
    else if (this.layerP.page && this.layerP.n === this.pageNum - 1 && ty - (GAP / 2) * scale > mid) dir = -1;
    if (!dir) return null;
    const oldpw = this.pw, oldph = this.ph;
    this.storeView();
    if (dir > 0) { const t = this.layerP; this.layerP = this.layerA; this.layerA = this.layerN; this.layerN = t; }
    else { const t = this.layerN; this.layerN = this.layerA; this.layerA = this.layerP; this.layerP = t; }
    (dir > 0 ? this.layerN : this.layerP).clear();
    this.layerA.dx = this.layerA.dy = 0;
    this.pageNum += dir; this.page = this.layerA.page; this.layerA.n = this.pageNum;
    this.pw = this.layerA.pw; this.ph = this.layerA.ph;
    this.pageToken++;
    this.selected = null; this.draft = null; this.gesture = this.gesture && this.gesture.type === 'pan' ? this.gesture : null; this.eraseSet = null;
    const ntx = tx + (oldpw - this.pw) * scale / 2;
    const nty = dir > 0 ? ty + (oldph + GAP) * scale : ty - (this.ph + GAP) * scale;
    this.placeNeighbors();
    this.renderItems(); this.renderProps(); this.updatePageUI();
    lastView.set(this.version.id + ':last', this.pageNum);
    if (this.panelMode === 'pages') this.markThumb();
    if (this.search) this.renderSearchHits();
    this.loadNeighbors();
    return [ntx, nty];
  }
  setCont(on, { quiet = false } = {}) {
    if (on && (this.cmp || this.split)) { UI.toast(tr('גלילה רציפה לא זמינה בזמן השוואת תוכניות')); return; }
    this.cont = !!on;
    try { localStorage.setItem('plans.cont', on ? '1' : '0'); } catch { /* ignore */ }
    this.el.classList.toggle('cont', this.cont);
    this.contBtn?.classList.toggle('on', this.cont);
    if (!this.cont) { this.layerN.clear(); this.layerP.clear(); this.fit('page'); }
    else { this.fit('width'); this.loadNeighbors(); }
    if (!quiet) UI.toast(this.cont ? tr('גלילה רציפה: גוללים מעלה/מטה בין העמודים') : tr('מצב עמוד בודד'), { ms: 1800 });
  }
  fit(mode) {
    if (!this.page) return;
    this.fitMode = mode;
    const s = mode === 'width' ? this.vw / this.pw : mode === 'height' ? this.H / this.ph : Math.min(this.vw / this.pw, this.H / this.ph) * 0.98;
    this.setView(s, (this.vw - this.pw * s) / 2, mode === 'width' ? 0 : (this.H - this.ph * s) / 2, { keepFit: true });
  }
  // כפתור התאמה אחד שמחליף בין: עמוד שלם → רוחב → גובה (מדלג על מצבים שנראים זהים)
  cycleFit() {
    if (!this.page) return;
    const sw = this.vw / this.pw, sh = this.H / this.ph, sp = Math.min(sw, sh) * 0.98;
    const all = [['page', sp, tr('כל העמוד במסך')], ['width', sw, tr('התאמה לרוחב המסך')], ['height', sh, tr('התאמה לגובה המסך')]];
    const kept = [];
    for (const m of all) if (!kept.some((k) => Math.abs(k[1] / m[1] - 1) < 0.04)) kept.push(m);
    const i = kept.findIndex((k) => k[0] === this.fitMode);
    const next = kept[(i + 1) % kept.length];
    this.fit(next[0]);
    UI.toast(next[2], { ms: 1400 });
  }
  async renameDialog() {
    await A.renamePlanDialog(this.planId);
    this.plan = S.P.plans.get(this.planId) || this.plan;
    this.updateTitle();
  }
  // לחיצה קצרה: זום בצעד; לחיצה ארוכה: זום רציף וחלק (מהיר יותר ככל שממשיכים) סביב מרכז התצוגה
  holdZoom(b, dir) {
    let raf = 0, t0 = 0, timer = 0, held = false, last = 0;
    const stop = () => { clearTimeout(timer); cancelAnimationFrame(raf); raf = 0; };
    const loop = (now) => {
      const dt = Math.min(50, now - last); last = now;
      const rate = 0.0010 + Math.min(0.0012, (now - t0) / 1.5e6); // לוגריתמי לאלפית שנייה
      this.zoomAt(this.vw / 2, this.H / 2, Math.exp(dir * rate * dt));
      raf = requestAnimationFrame(loop);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); held = false; stop();
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      timer = setTimeout(() => { held = true; t0 = last = performance.now(); raf = requestAnimationFrame(loop); }, 280);
    });
    const up = () => { const was = held; stop(); if (!was && timer) { /* קצר */ } held = false; };
    b.addEventListener('pointerup', (e) => { const was = held; stop(); held = false; if (!was) this.zoomBy(dir > 0 ? 1.6 : 1 / 1.6); });
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.zoomBy(dir > 0 ? 1.6 : 1 / 1.6); } });
  }
  setZoom100() { this.zoomAt(this.vw / 2, this.H / 2, PT / this.scale); }
  zoomBy(f) { this.zoomAt(this.vw / 2, this.H / 2, f); }
  zoomAt(x, y, f) {
    const ns = clamp(this.scale * f, this.minScale(), MAXS);
    const px = (x - this.tx) / this.scale, py = (y - this.ty) / this.scale;
    this.setView(ns, x - px * ns, y - py * ns);
  }
  viewCenter() { return { cx: (this.vw / 2 - this.tx) / this.scale, cy: (this.H / 2 - this.ty) / this.scale, scale: this.scale }; }
  applyView(v) { this.setView(v.scale, this.vw / 2 - v.cx * v.scale, this.H / 2 - v.cy * v.scale); }
  updateZoomUI() { this.zoomLabel.textContent = Math.round((this.scale / PT) * 100) + '%'; }

  // ---------- עמודים ----------
  async goPage(n, { view = null, fresh = false } = {}) {
    if (!this.doc) return;
    n = clamp(n, 1, this.numPages);
    const token = ++this.pageToken;
    this.storeView();
    this.loading.style.display = '';
    const page = await this.doc.getPage(n);
    if (token !== this.pageToken || this.dead) return;
    this.pageNum = n; this.page = page;
    if (this.cont) { this.layerN.clear(); this.layerP.clear(); }
    this.selected = null; this.draft = null; this.gesture = null; this.eraseSet = null;
    this.measure();
    this.layerA.setPage(page).then(() => { if (token === this.pageToken) this.loading.style.display = 'none'; });
    this.pw = this.layerA.pw; this.ph = this.layerA.ph;
    if (this.cmp) this.loadCompareLayer();
    const saved = lastView.get(`${this.version.id}:${n}`);
    if (view) this.applyView(view);
    else if (saved && !fresh) this.applyView(saved);
    else this.fit(this.cont ? 'width' : 'page');
    lastView.set(this.version.id + ':last', n);
    this.renderItems(); this.renderProps(); this.updatePageUI();
    this.scheduleDetail(30);
    if (this.panelMode === 'pages') this.markThumb();
    if (this.search) this.renderSearchHits();
    if (this.cont) this.loadNeighbors();
  }
  storeView() {
    if (this.page && this.version) lastView.set(`${this.version.id}:${this.pageNum}`, this.viewCenter());
  }
  updatePageUI() {
    this.pageLabel.textContent = `${this.pageNum} / ${this.numPages}`;
    this.pageBar.style.display = this.numPages > 1 ? '' : 'none';
    this.updateZoomUI();
  }
  async pagePrompt() {
    const v = await UI.promptBox({ title: tr('מעבר לעמוד'), label: tr('מספר עמוד (1–{0})', this.numPages), value: String(this.pageNum), okText: tr('עבור') });
    const n = parseInt(v, 10);
    if (n >= 1 && n <= this.numPages) this.goPage(n);
  }

  // ---------- קואורדינטות ----------
  local(e) { const r = this.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  viewX(x) { return this.split && x > this.vw ? x - this.vw : x; }
  toPage(pt) { return { x: (this.viewX(pt.x) - this.tx) / this.scale, y: (pt.y - this.ty) / this.scale }; }

  // ---------- מחוות ----------
  onWheel(e) {
    e.preventDefault();
    if (!this.page) return;
    const pt = this.local(e);
    const k = e.ctrlKey ? 0.012 : 0.0018;
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * k);
    this.zoomAt(this.viewX(pt.x), pt.y, f);
  }
  onDown(e) {
    if (!this.page) return;
    if (e.pointerType === 'mouse' && e.button > 2) return;
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const pt = this.local(e);
    if (e.isPrimary && this.ptrs.size) { this.ptrs.clear(); this.pinch = null; this.assist = null; if (this.gesture) this.abortGesture(); } // אצבע ראשונה חדשה = אין נגיעות אחרות; מנקה נגיעה "תקועה" שגרמה לקפיצות
    this.ptrs.set(e.pointerId, pt);
    // יד שנייה בזמן שהראשונה באמצע שרטוט/מדידה: היד השנייה מזיזה ומגדילה את התוכנית, והמדידה נשארת בידך הראשונה
    const g0 = this.gesture;
    if (g0 && ASSIST_TYPES.has(g0.type) && e.pointerId !== g0.id && !this.pinch && (this.assist || this.drawing(g0))) {
      if (!this.assist) this.assist = { pts: new Map() };
      if (this.assist.pts.size < 2) { this.assist.pts.set(e.pointerId, pt); this.assistReset(); }
      return;
    }
    if (this.ptrs.size === 2) { this.abortGesture(); this.startPinch(); return; }
    if (this.ptrs.size > 2) return;
    const forcePan = e.button === 1 || e.button === 2 || this.spaceDown;
    const t0 = performance.now();
    if (forcePan || this.tool === 'pan') {
      const align = this.cmp && this.alignDrag && !forcePan;
      this.gesture = { type: align ? 'align' : 'pan', id: e.pointerId, x: pt.x, y: pt.y, sx: pt.x, sy: pt.y, t0, moved: false, mouse: e.pointerType === 'mouse' };
      return;
    }
    this.toolDown(pt, e);
  }
  abortGesture() {
    const g = this.gesture;
    if (g && (g.type === 'move' || g.type === 'handle') && this.selected) { Object.assign(this.selected, clone(g.before)); this.renderItems(); }
    this.assist = null;
    if (g && g.hold) clearTimeout(g.hold);
    if (g && g.type === 'erase') { this.eraseSet = null; this.renderItems(); }
    if (g && (g.type === 'drag' || g.type === 'pen' || g.type === 'seg')) this.draft = null;
    this.gesture = null;
    this.renderDraft();
  }
  startPinch() {
    const [a, b] = [...this.ptrs.values()];
    const sel = this.selected;
    if (sel && sel.type === 'text' && this.canEditItem(sel)) { // צביטה על טקסט נבחר משנה את גודל הטקסט ולא את הזום
      const mid = this.toPage({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const bb = textBox(sel), pad = 80 / this.scale;
      if (mid.x >= bb.x0 - pad && mid.x <= bb.x1 + pad && mid.y >= bb.y0 - pad && mid.y <= bb.y1 + pad) {
        this.pinch = { mode: 'text', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, f0: sel.fontSize, before: clone(sel) };
        return;
      }
    }
    this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s0: this.scale, tx0: this.tx, ty0: this.ty };
  }
  doPinch() {
    const [a, b] = [...this.ptrs.values()];
    const p = this.pinch;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    if (p.mode === 'text') {
      this.selected.fontSize = Math.max(2, p.f0 * clamp(d / p.d0, 0.15, 10));
      this.renderItems();
      return;
    }
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ns = clamp(p.s0 * (d / p.d0), this.minScale(), MAXS);
    const c0x = this.viewX(p.c0.x), cx = this.viewX(c.x);
    const px = (c0x - p.tx0) / p.s0, py = (p.c0.y - p.ty0) / p.s0;
    this.setView(ns, cx - px * ns, c.y - py * ns);
  }
  // האם האצבע הראשונה כבר באמצע שרטוט (זזה ממקום הנגיעה)? אם לא – אצבע שנייה היא צביטה/הזזה רגילה של התוכנית
  drawing(g) {
    if (g.type === 'pen') return !!(this.draft && this.draft.pts.length > 3);
    const q = this.ptrs.get(g.id);
    return !!g.moved || (!!q && Math.hypot(q.x - g.sx, q.y - g.sy) > 12 && (g.type === 'drag' || g.type === 'seg'));
  }
  assistReset() {
    const a = this.assist; if (!a) return;
    const l = [...a.pts.values()];
    a.n = l.length;
    a.c = { x: l.reduce((s, q) => s + q.x, 0) / l.length, y: l.reduce((s, q) => s + q.y, 0) / l.length };
    a.d = l.length > 1 ? Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y) || 1 : 0;
  }
  assistMove() {
    const a = this.assist; if (!a) return;
    const l = [...a.pts.values()];
    if (l.length !== a.n) { this.assistReset(); return; }
    const c = { x: l.reduce((s, q) => s + q.x, 0) / l.length, y: l.reduce((s, q) => s + q.y, 0) / l.length };
    const d = l.length > 1 ? Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y) || 1 : 0;
    const ns = l.length > 1 && a.d ? clamp(this.scale * (d / a.d), this.minScale(), MAXS) : this.scale;
    const px = (this.viewX(a.c.x) - this.tx) / this.scale, py = (a.c.y - this.ty) / this.scale;
    this.setView(ns, this.viewX(c.x) - px * ns, c.y - py * ns);
    a.c = c; a.d = d;
    this.refreshPrimary();
  }
  // אחרי שהתצוגה זזתה מתחת לאצבע הראשונה (יד שנייה / גלילה בקצה): מעדכנים את הקו הנמשך לפי מיקום האצבע
  refreshPrimary() {
    const g = this.gesture; if (!g) return;
    const pt = this.ptrs.get(g.id); if (!pt) return;
    if (g.type === 'seg' && !g.moved) { g.p0 = this.toPage(pt); g.sx = pt.x; g.sy = pt.y; return; }
    this.onMove({ pointerId: g.id }, pt);
  }
  edgeCheck(g, pt) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight, M = 56;
    const ex = pt.x < M ? -(M - pt.x) / M : pt.x > W - M ? (pt.x - (W - M)) / M : 0;
    const ey = pt.y < M ? -(M - pt.y) / M : pt.y > H - M ? (pt.y - (H - M)) / M : 0;
    if (!ex && !ey) { g.edge = null; g.edgeT = 0; return; }
    g.edge = { ex: clamp(ex, -1, 1), ey: clamp(ey, -1, 1) };
    if (!g.edgeT) g.edgeT = performance.now();
    if (!this.edgeRaf) this.edgeRaf = requestAnimationFrame(() => this.edgeStep());
  }
  edgeStep() {
    this.edgeRaf = 0;
    const g = this.gesture;
    if (!g || !g.edge || this.assist || !EDGE_TYPES.has(g.type) || (g.type === 'seg' && !g.moved)) return;
    const now = performance.now(), dt = Math.min(0.05, (now - (g.edgeLast || now)) / 1000);
    g.edgeLast = now;
    if (now - g.edgeT >= 300) { // רק אחרי שהאצבע נשארת בקצה, כדי לא לזוז בנגיעה רגילה; מהירות איטית שגדלה ככל שהאצבע קרובה יותר לקצה
      const sp = (r) => Math.sign(r) * (30 + 150 * r * r) * dt;
      this.setView(this.scale, this.tx - sp(g.edge.ex), this.ty - sp(g.edge.ey));
      this.refreshPrimary();
    }
    this.edgeRaf = requestAnimationFrame(() => this.edgeStep());
  }
  onMove(e, forced) {
    const pt = forced || this.local(e);
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, pt);
    if (this.assist && this.assist.pts.has(e.pointerId) && !forced) { this.assist.pts.set(e.pointerId, pt); this.assistMove(); return; }
    if (this.pinch && this.ptrs.size >= 2) { this.doPinch(); return; }
    const g = this.gesture;
    if (!g) {
      if (this.draft && (this.draft.wait || this.draft.type === 'area' || this.draft.type === 'polyline')) { this.draft.hover = this.orthoPt(this.toPage(pt)); this.renderDraft(); }
      return;
    }
    if (g.id !== e.pointerId) return;
    const p = this.toPage(pt);
    const dx = pt.x - g.x, dy = pt.y - g.y;
    switch (g.type) {
      case 'pan':
        if (Math.hypot(pt.x - g.sx, pt.y - g.sy) > 6) g.moved = true;
        if (g.moved) this.setView(this.scale, this.tx + dx, this.ty + dy);
        g.x = pt.x; g.y = pt.y;
        break;
      case 'align':
        this.layerB.dx += dx / this.scale; this.layerB.dy += dy / this.scale;
        this.layerB.place(this.scale, this.tx, this.ty, this.dpr);
        g.x = pt.x; g.y = pt.y; g.moved = true;
        break;
      case 'drag': this.draft.pts[1] = p; this.renderDraft(); this.edgeCheck(g, pt); break;
      case 'pen': {
        if (g.snapped) { // אחרי זיהוי: קו ישר ממשיך לעקוב אחרי האצבע (עם הצמדה ל-0/45/90°)
          if (g.snap.type === 'line') { this.draft.pts[1] = snapAngle(this.draft.pts[0], p); this.renderDraft(); }
          break;
        }
        const last = this.draft.pts[this.draft.pts.length - 1];
        this.edgeCheck(g, pt);
        if (dist(last, p) * this.scale > 1.5) { this.draft.pts.push(p); this.renderDraft(); }
        if (Math.hypot(pt.x - g.anchor.x, pt.y - g.anchor.y) > 6) { g.anchor = { x: pt.x, y: pt.y }; this.armHold(g); }
        break;
      }
      case 'erase': this.eraseAt(g.last, p); g.last = p; break;
      case 'seg':
        if (g.moved || Math.hypot(pt.x - g.sx, pt.y - g.sy) > 8) { g.moved = true; this.draft = { type: this.tool, pts: [g.p0, p] }; this.renderDraft(); this.edgeCheck(g, pt); }
        break;
      case 'seg2': case 'poly': case 'text':
        if (g.moved || Math.hypot(pt.x - g.sx, pt.y - g.sy) > 10) {
          if (!g.moved) { g.moved = true; g.x = g.sx; g.y = g.sy; }
          this.setView(this.scale, this.tx + (pt.x - g.x), this.ty + (pt.y - g.y));
          g.x = pt.x; g.y = pt.y;
        } else if (g.type === 'seg2') { this.draft.pts[1] = p; this.renderDraft(); }
        break;
      case 'move': {
        const ddx = p.x - g.p0.x, ddy = p.y - g.p0.y;
        if (Math.hypot(pt.x - g.sx, pt.y - g.sy) > 3) g.moved = true;
        this.selected.pts = g.before.pts.map((q) => ({ x: q.x + ddx, y: q.y + ddy }));
        this.renderItems();
        break;
      }
      case 'handle': {
        const it = this.selected;
        if (it.type === 'text') { // ידית פינה: שינוי גודל טקסט
          const a0 = g.before.pts[0], bb = textBox(g.before);
          const d0 = Math.hypot(bb.x1 - a0.x, bb.y1 - a0.y) || 1, d1 = Math.hypot(p.x - a0.x, p.y - a0.y);
          it.fontSize = Math.max(2, g.before.fontSize * (d1 / d0));
        } else if (RECT_TYPES.has(it.type)) { const c = corners(g.before.pts); it.pts = [c[(g.idx + 2) % 4], p]; } else it.pts = g.before.pts.map((q, i) => (i === g.idx ? p : q));
        g.moved = true;
        this.renderItems();
        break;
      }
    }
  }
  onUp(e, cancelled = false) {
    const pt = this.local(e);
    this.ptrs.delete(e.pointerId);
    if (this.assist) {
      if (this.assist.pts.delete(e.pointerId)) { if (this.assist.pts.size) this.assistReset(); else this.assist = null; return; }
      this.assist = null; // האצבע הראשונה עזבה: ממשיכים רגיל (היד השנייה כבר לא משפיעה)
    }
    if (this.pinch) {
      if (this.ptrs.size < 2) {
        const pm = this.pinch;
        this.pinch = null;
        if (pm.mode === 'text') { this.commitMod(pm.before, this.selected).then(() => this.renderProps()); return; }
        if (this.ptrs.size === 1) { const [id, q] = [...this.ptrs][0]; this.gesture = { type: 'pan', id, x: q.x, y: q.y, sx: q.x, sy: q.y, moved: true, t0: 0 }; }
      }
      return;
    }
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.gesture = null;
    if (cancelled) { this.gesture = g; this.abortGesture(); return; }
    const p = this.toPage(pt);
    switch (g.type) {
      case 'pan':
        if (!g.moved && performance.now() - g.t0 < 600) this.onTap(pt);
        else if (g.moved && !g.mouse) this.maybeSwipe(g, pt);
        break;
      case 'align': this.scheduleDetail(30); break;
      case 'drag': {
        const d = this.draft; this.draft = null;
        if (d && dist(d.pts[0], d.pts[1]) * this.scale >= 8) this.commitNew(d); else this.renderDraft();
        break;
      }
      case 'pen': {
        clearTimeout(g.hold);
        const d = this.draft; this.draft = null;
        if (d && d.pts.length >= 2) this.commitNew(d); else this.renderDraft();
        break;
      }
      case 'erase': this.commitErase(); break;
      case 'seg':
        if (g.moved) { const d = this.draft; this.draft = null; if (d && dist(d.pts[0], d.pts[1]) * this.scale >= 8) this.commitNew(d); else this.renderDraft(); }
        else { this.draft = { type: this.tool, pts: [g.p0, g.p0], wait: true, hover: g.p0 }; this.renderDraft(); this.renderProps(); }
        break;
      case 'seg2':
        if (!g.moved) {
          const d = this.draft;
          if (dist(d.pts[0], p) * this.scale < 4) return;
          this.draft = null; d.pts = [d.pts[0], p]; delete d.wait; delete d.hover; this.commitNew(d);
        }
        break;
      case 'poly': if (!g.moved) this.addAreaPoint(p); break;
      case 'text': if (!g.moved) this.placeText(p); break;
      case 'move': case 'handle':
        if (g.moved) this.commitMod(g.before, this.selected).then(() => { if (g.type === 'handle') this.renderProps(); });
        break;
    }
  }
  maybeSwipe(g, pt) {
    if (this.numPages < 2 || this.cmp) return;
    if (this.pw * this.scale > this.vw * 1.02) return;
    const dx = pt.x - g.sx, dy = pt.y - g.sy;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 50) this.goPage(this.pageNum + (dx < 0 ? 1 : -1));
  }
  onTap(pt) {
    const p = this.toPage(pt);
    const now = performance.now();
    const lt = this.lastTap;
    if (this.tool === 'pan' && prefs.show.links) {
      const l = this.items.links.filter((it) => it.page === this.pageNum).reverse().find((it) => hitItem(it, p, 6 / this.scale));
      if (l) { this.followLink(l); return; }
    }
    if (this.tool === 'pan' && now - lt.t >= 320) { // לחיצה על סימון במצב הזזה: בוחרת אותו (עריכה/מחיקה)
      const it = this.hit(p);
      if (it && it.layer !== 'links') { this.lastTap = { t: now, x: pt.x, y: pt.y }; this.tool = 'select'; this.updateToolUI(); this.select(it); return; }
    }
    if (now - lt.t < 320 && Math.hypot(pt.x - lt.x, pt.y - lt.y) < 30) {
      const fitS = Math.min(this.vw / this.pw, this.H / this.ph) * 0.98;
      if (this.scale > fitS * 1.6) this.fit('page'); else this.zoomAt(this.viewX(pt.x), pt.y, 2.5);
      this.lastTap = { t: 0, x: 0, y: 0 };
      return;
    }
    this.lastTap = { t: now, x: pt.x, y: pt.y };
  }
  onKey(e) {
    if (e.target.matches?.('input, textarea, select') || document.querySelector('.modal-back')) return;
    if (this.host && this.host.active !== this) return; // מקשים פועלים רק על התצוגה הפעילה
    const k = e.key;
    if (e.code === 'Space') { this.spaceDown = true; e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (k === 'Escape') {
      if (this.draft) this.cancelDraft();
      else if (this.selected) this.select(null);
      else if (this.tool !== 'pan') { this.tool = 'pan'; this.updateToolUI(); this.renderProps(); }
      else this.goBack();
      return;
    }
    if (k === 'Delete' || k === 'Backspace') { if (this.selected) this.deleteSelected(); return; }
    if (k === 'Enter' && this.draft && (this.draft.type === 'area' || this.draft.type === 'polyline')) { this.finishArea(); return; }
    if (k === '+' || k === '=') this.zoomBy(1.4);
    else if (k === '-') this.zoomBy(1 / 1.4);
    else if (k === '0') this.setZoom100();
    else if (k.toLowerCase() === 'f') this.fit('page');
    else if (k.toLowerCase() === 'w') this.fit('width');
    else if (k === 'PageDown') this.goPage(this.pageNum + 1);
    else if (k === 'PageUp') this.goPage(this.pageNum - 1);
    else if (k === 'ArrowLeft') this.setView(this.scale, this.tx + 80, this.ty);
    else if (k === 'ArrowRight') this.setView(this.scale, this.tx - 80, this.ty);
    else if (k === 'ArrowUp') this.setView(this.scale, this.tx, this.ty + 80);
    else if (k === 'ArrowDown') this.setView(this.scale, this.tx, this.ty - 80);
  }

  // ---------- כלים ----------
  setTool(t) {
    if (t !== 'pan' && t !== 'select' && !CS.canMarkPlan(this.planId)) { UI.toast(tr('בתוכנית הזו יש לך הרשאת צפייה בלבד. סימון דורש הרשאת סימון מהמנהל'), { type: 'error' }); return; }
    if (t === 'link' && !CS.canEditPlanItems(this.planId)) { UI.toast(tr('קישורים בין תוכניות דורשים הרשאת עריכה מלאה'), { type: 'error' }); return; }
    if ((t === 'measure' || t === 'area') && !this.calibs.get(this.pageNum)) { this.needCalibration(t); return; }
    if (this.draft) { this.draft = null; this.renderDraft(); }
    this.tool = t;
    if (t !== 'select') this.select(null, true);
    this.updateToolUI(); this.renderProps();
  }
  updateToolUI() {
    const canMark = CS.canMarkPlan(this.planId), canEdit = CS.canEditPlanItems(this.planId);
    Object.entries(this.toolBtns).forEach(([id, b]) => {
      b.classList.toggle('on', id === this.tool);
      const off = id !== 'pan' && id !== 'select' && (!canMark || (id === 'link' && !canEdit));
      b.disabled = off; b.style.opacity = off ? '0.4' : '';
    });
    this.stage.dataset.tool = this.tool;
  }
  toolDown(pt, e) {
    if (this.autoSel) {
      const fs = this.selected === this.autoSel && this.tool !== 'select';
      if (fs) { const it = this.selected; this.select(null); this.dropFreshText(it); }
      this.autoSel = null;
    }
    const p = this.toPage(pt);
    const base = { id: e.pointerId, sx: pt.x, sy: pt.y, moved: false };
    switch (this.tool) {
      case 'select': {
        const hd = this.selected && this.canEditItem(this.selected) && this.hitHandle(p);
        if (hd) { this.gesture = { ...base, type: 'handle', idx: hd.idx, before: clone(this.selected) }; return; }
        const it = this.hit(p);
        if (it) { this.select(it); if (this.canEditItem(it)) this.gesture = { ...base, type: 'move', p0: p, before: clone(it) }; return; }
        this.select(null);
        this.gesture = { type: 'pan', id: e.pointerId, x: pt.x, y: pt.y, sx: pt.x, sy: pt.y, t0: performance.now(), moved: false, mouse: e.pointerType === 'mouse' };
        return;
      }
      case 'text': this.gesture = { ...base, type: 'text', x: pt.x, y: pt.y }; return;
      case 'measure': case 'calibrate':
        if (this.draft && this.draft.wait) { this.gesture = { ...base, type: 'seg2', x: pt.x, y: pt.y }; return; }
        this.gesture = { ...base, type: 'seg', p0: p }; return;
      case 'area': case 'polyline': this.gesture = { ...base, type: 'poly', x: pt.x, y: pt.y }; return;
      case 'eraser': this.eraseSet = new Set(); this.gesture = { ...base, type: 'erase', last: p }; this.eraseAt(p, p); return;
      case 'pen':
        this.draft = { type: 'pen', pts: [p] };
        this.gesture = { ...base, type: 'pen', anchor: { x: pt.x, y: pt.y } };
        this.armHold(this.gesture);
        return;
      default: this.draft = { type: this.tool, pts: [p, p] }; this.gesture = { ...base, type: 'drag' };
    }
  }

  // ---------- פריטים ----------
  visibleItems() {
    const out = [];
    for (const l of ['markups', 'measurements', 'links']) {
      if (!prefs.show[l]) continue;
      for (const it of this.items[l]) if (it.page === this.pageNum && this.itemShown(it)) out.push(it);
    }
    return out;
  }
  // ---------- של מי הסימונים (מצב ענן) ----------
  // ברירת מחדל: מנהל רואה רק את שלו (ובוחר להוסיף עובדים); עובד רואה את מה שהגיע אליו (שלו + מה ששותף איתו)
  itemShown(it) {
    if (!isCloud() || it.layer === 'links' || !it.ownerId) return true;
    const f = prefs.authors;
    if (f === 'all') return true;
    if (Array.isArray(f)) return f.includes(it.ownerId);
    return isAdmin() && !S.getViewAs() ? it.ownerId === CS.myId() : true; // בצפייה כעובד המנהל רואה את כל הסימונים
  }
  canEditItem(it) { return CS.itemAccess(it, it.layer || 'markups') === 'edit'; }
  canShareHere() { return isCloud() && (isAdmin() || CS.canEditPlanItems(this.planId)); }
  async reloadItems() {
    const ver = this.version; if (!ver) return;
    if (this.gesture || this.draft) { clearTimeout(this._ri); this._ri = setTimeout(() => this.reloadItems(), 800); return; }
    const [mk, ms, ln, cal] = await Promise.all(['markups', 'measurements', 'links', 'calibrations'].map((s) => db.byIndex(s, 'versionId', ver.id)));
    if (this.version !== ver) return;
    this.items = { markups: mk, measurements: ms, links: ln };
    this.setCals(cal);
    if (this.selected) this.selected = [...mk, ...ms, ...ln].find((x) => x.id === this.selected.id) || null;
    this.renderItems(); this.renderProps();
  }
  // כיולים: לכל משתמש כיול משלו. כיול שלי > כיול ישן (לפני הפיצול) > כיול שהמנהל שיתף. מדידה של מישהו אחר מוצגת לפי הכיול שלו
  setCals(list) {
    this.calList = list;
    const me = S.hooks.owner() || undefined, rank = (c) => (c.ownerId === me ? 3 : !c.ownerId ? 2 : c.shared ? 1 : 0), m = new Map();
    for (const c of list) if (rank(c) > 0 && (!m.has(c.page) || rank(c) > rank(m.get(c.page)))) m.set(c.page, c);
    this.calibs = m;
  }
  calFor(it, page = it.page) {
    const own = it.ownerId && (this.calList || []).find((c) => c.page === page && c.ownerId === it.ownerId);
    return own || this.calibs.get(page);
  }
  refScale() { return 380 / Math.min(this.pw, this.ph); } // קנה מידה ייחוס (פיקסלים לנקודת עמוד ברוחב מסך רגיל)
  calId(pg) { const me = S.hooks.owner(); return me ? `${this.version.id}:${pg}:${me}` : `${this.version.id}:${pg}`; }
  // גודל כיתוב מדידה לא תלוי ברמת הזום: בין 12 ל-30 פיקסלים על המסך
  fixedMeasure(it) {
    if (it.type !== 'measure' && it.type !== 'area' && !(it.type === 'polyline' && it.showLen)) return it;
    const sc = this.scale || 1;
    if (it.tsz) return { ...it, fontSize: it.tsz / this.refScale() }; // גודל שנקבע ידנית: לא מוגבל
    return { ...it, fontSize: clamp(it.fontSize || 15 / sc, 12 / sc, 30 / sc) };
  }
  async exportXlsx() {
    const rows = [];
    const owners = new Map();
    try { for (const p of await (await import('./item-share-ui.js')).getPeople?.() || []) owners.set(p.id, p.display_name || p.email); } catch { /* ignore */ }
    const mine = S.hooks.owner();
    for (const it of [...this.items.measurements, ...this.items.markups.filter((x) => x.type === 'polyline' && x.showLen)]) {
      if (!this.itemShown(it)) continue;
      const cal = this.calFor(it);
      let value = null;
      if (cal && cal.mpu) value = it.type === 'area' ? polyArea(it.pts) * cal.mpu * cal.mpu : it.type === 'polyline' ? pathLength(it.pts, it.closed) * cal.mpu : Math.hypot(it.pts[1].x - it.pts[0].x, it.pts[1].y - it.pts[0].y) * cal.mpu;
      rows.push({ title: it.title || '', type: it.type, page: it.page, plan: this.plan?.name || '', value, owner: it.ownerId && it.ownerId !== mine ? owners.get(it.ownerId) || '' : '' });
    }
    if (!rows.length) { UI.toast(tr('אין מדידות לייצוא בתוכנית הזו')); return; }
    await exportMeasurementsXlsx(rows, tr('מדידות') + ' - ' + (this.plan?.name || ''));
    UI.toast(tr('הקובץ נוצר: {0} מדידות', rows.length));
  }
  ctx() {
    return {
      cal: this.calibs.get(this.pageNum), unit: prefs.unit,
      planName: (t) => { if (!t) return ''; const p = S.P.plans.get(t.planId); return p ? p.name : null; },
    };
  }
  renderItems() {
    this.gItems.textContent = '';
    const cx = this.ctx();
    for (const it of this.visibleItems()) {
      const node = drawItem(this.fixedMeasure(it), { ...cx, cal: this.calFor(it, this.pageNum) });
      if (this.eraseSet && this.eraseSet.has(it.id)) node.setAttribute('opacity', '0.22');
      this.gItems.append(node);
    }
    this.renderSel();
  }
  renderDraft() {
    this.gDraft.textContent = '';
    const d = this.draft;
    if (!d) return;
    const sc = this.scale;
    if (d.type === 'calibrate') {
      const pts = d.wait && d.hover ? [d.pts[0], d.hover] : d.pts;
      this.gDraft.append(drawItem({ type: 'line', pts, color: '#d81b60', width: 2 / sc }, this.ctx()));
      return;
    }
    const it = this.newItem(d, true);
    let pts = d.pts;
    const isPoly = d.type === 'area' || d.type === 'polyline';
    if (isPoly && d.hover) pts = [...d.pts, d.hover];
    else if (d.wait && d.hover) pts = [d.pts[0], d.hover];
    this.gDraft.append(drawItem(this.fixedMeasure({ ...it, pts }), this.ctx()));
    if (isPoly) d.pts.forEach((q) => this.gDraft.append(svg('circle', { cx: q.x, cy: q.y, r: 5 / sc, fill: '#fff', stroke: '#d81b60', 'stroke-width': 2 / sc })));
  }
  newItem(d, preview = false) {
    const sc = this.scale;
    const type = d.type;
    const it = {
      id: preview ? 'draft' : uid(), versionId: this.version.id, planId: this.planId, page: this.pageNum, type, layer: LAYER_OF[type],
      pts: d.pts.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })), created: Date.now(), ownerId: S.hooks.owner() || undefined,
    };
    const kind = kindOf(type);
    if (kind === 'text') {
      it.color = prefs.tcolor; it.op = prefs.top; if (prefs.tbg) { it.bg = prefs.tbg; it.bgOp = prefs.tbgop; } it.text = d.text || ''; it.fontSize = prefs.tsize / sc; it.width = 1 / sc;
    } else if (kind === 'hl') {
      it.color = prefs.hcolor; it.fillOp = prefs.hop; it.width = 1 / sc;
    } else if (kind === 'shape') {
      it.color = prefs.color; it.width = prefs.w / sc; it.op = prefs.op;
      if (!d.fromPen && (type === 'rect' || type === 'ellipse')) { it.fill = prefs.fill; it.fillOp = prefs.fillOp; }
      if (type === 'polyline') { it.fontSize = 14 / (380 / Math.min(this.pw, this.ph)); if (d.closed) it.closed = true; }
    }
    if (type === 'measure' || type === 'area') {
      const ref = this.refScale();
      it.color = prefs.mcolor || '#d81b60'; it.width = (prefs.mw || 2.5) / ref; it.fontSize = 15 / ref; it.tcolor = prefs.mtcolor || '#111111';
      if (prefs.mtsize) { it.tsz = prefs.mtsize; it.fontSize = prefs.mtsize / ref; }
      if (this.measTitle) it.title = this.measTitle;
    }
    if (type === 'link') { it.color = '#1d4e89'; it.width = 2 / sc; it.fontSize = 14 / sc; }
    return it;
  }
  async commitNew(d) {
    if (d.type === 'calibrate') { this.calibrateFromPoints(d.pts); return; }
    if (d.type === 'link') { await this.createLink(d); return; }
    const it = this.newItem(d);
    await this.addItem(it);
    // הפריט שנוצר נשאר נבחר: שינוי צבע/גודל חל עליו, ורק נגיעה במקום אחר מתחילה פריט חדש
    if (this.items[it.layer].includes(it)) { this.autoSel = it; this.select(it, true); }
    this.renderDraft(); this.renderProps();
  }
  async addItem(it) {
    if (!CS.canMarkPlan(this.planId)) { UI.toast(tr('אין לך הרשאת סימון בתוכנית הזו'), { type: 'error' }); return; }
    await S.putItem(it.layer, it);
    this.items[it.layer].push(it);
    this.history.push({ before: null, after: clone(it) });
    this.redoStack = [];
    this.updateUndo(); this.renderItems();
  }
  async commitMod(before, after) {
    const a = clone(after);
    if (a.type === 'text' && before.fontSize !== a.fontSize) { prefs.tsize = Math.max(8, Math.round(a.fontSize * this.scale)); savePrefs(); }
    await S.putItem(a.layer, a);
    this.history.push({ before: clone(before), after: a });
    this.redoStack = [];
    this.updateUndo(); this.renderItems();
  }
  async setItemState(from, to) {
    const src = to || from;
    const arr = this.items[src.layer];
    const i = arr.findIndex((x) => x.id === src.id);
    if (!to) { if (i >= 0) arr.splice(i, 1); await S.delItem(src.layer, src.id); if (this.selected?.id === src.id) this.selected = null; }
    else { const c = clone(to); if (i >= 0) arr[i] = c; else arr.push(c); await S.putItem(src.layer, c); if (this.selected?.id === c.id) this.selected = c; }
    this.renderItems(); this.renderProps();
  }
  async applyEntry(c, undo) {
    const list = c.multi ? (undo ? [...c.multi].reverse() : c.multi) : [c];
    for (const e of list) await (undo ? this.setItemState(e.after, e.before) : this.setItemState(e.before, e.after));
  }
  async undo() { const c = this.history.pop(); if (!c) return; await this.applyEntry(c, true); this.redoStack.push(c); this.updateUndo(); }
  async redo() { const c = this.redoStack.pop(); if (!c) return; await this.applyEntry(c, false); this.history.push(c); this.updateUndo(); }
  updateUndo() {
    if (!this.undoBtn) return;
    this.undoBtn.disabled = !this.history.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  hit(p) {
    const tol = 12 / this.scale;
    const list = this.visibleItems();
    for (let i = list.length - 1; i >= 0; i--) if (hitItem(list[i], p, tol)) return list[i];
    return null;
  }
  hitHandle(p) {
    const tol = 16 / this.scale;
    return handlesOf(this.selected).find((hd) => Math.hypot(hd.x - p.x, hd.y - p.y) <= tol) || null;
  }
  select(it, silent) {
    if (this._editBefore) this.commitEdit();
    this.selected = it;
    this.renderSel();
    if (!silent) this.renderProps();
  }
  renderSel() {
    this.gSel.textContent = '';
    const it = this.selected;
    if (!it) return;
    const sc = this.scale;
    const b = boundsOf(it), pad = 6 / sc;
    this.gSel.append(svg('rect', { x: b.x0 - pad, y: b.y0 - pad, width: b.x1 - b.x0 + pad * 2, height: b.y1 - b.y0 + pad * 2, fill: 'none', stroke: '#1d4e89', 'stroke-width': 1.5 / sc, 'stroke-dasharray': `${5 / sc} ${4 / sc}` }));
    handlesOf(it).forEach((hd) => this.gSel.append(svg('circle', { cx: hd.x, cy: hd.y, r: 8 / sc, fill: '#fff', stroke: '#1d4e89', 'stroke-width': 2.5 / sc })));
  }
  async deleteSelected() {
    const it = this.selected; if (!it) return;
    if (!this.canEditItem(it)) { UI.toast(tr('אין לך הרשאה למחוק את הפריט הזה'), { type: 'error' }); return; }
    this.selected = null;
    await this.setItemState(it, null);
    this.history.push({ before: clone(it), after: null });
    this.redoStack = [];
    this.updateUndo(); this.renderProps();
  }
  async modifySelected(mut) {
    const it = this.selected; if (!it) return;
    if (!this.canEditItem(it)) { UI.toast(tr('אין לך הרשאה לערוך את הפריט הזה'), { type: 'error' }); return; }
    const before = clone(it);
    mut(it);
    await this.commitMod(before, it);
    this.renderProps();
  }

  // ---------- טקסט ושטח ----------
  async placeText(p) {
    // הטקסט נוצר מיד על התוכנית עם טקסט לדוגמה: מקלידים בשדה בסרגל וצבע/גודל מתעדכנים בזמן אמת על התוכנית
    const ph = tr('טקסט');
    const it = this.newItem({ type: 'text', pts: [p], text: ph });
    await this.addItem(it);
    if (!this.items[it.layer].includes(it)) return;
    this.freshText = { id: it.id, ph };
    this.autoSel = it; this.select(it);
    const inp = this.props.querySelector('.txt-inline');
    if (inp) { inp.focus(); inp.select(); }
  }
  // טקסט שנוצר ולא נכתב בו כלום (נשאר "טקסט") נמחק בשקט כשמתחילים טקסט אחר
  async dropFreshText(it) {
    const f = this.freshText; this.freshText = null;
    if (!f || !it || it.id !== f.id || (it.text !== f.ph && it.text !== '')) return;
    this.selected = null;
    await this.setItemState(it, null);
    const h2 = this.history[this.history.length - 1];
    if (h2 && h2.after && h2.after.id === it.id && !h2.before) this.history.pop();
    this.updateUndo(); this.renderItems();
  }
  // אם נבחר פריט – משנים אותו. אחרת – מעדכנים את ברירת המחדל.
  orthoPt(p) {
    const d = this.draft;
    if (!d || d.type !== 'polyline' || !prefs.ortho || !d.pts.length) return p;
    const last = d.pts[d.pts.length - 1];
    const ang = Math.atan2(p.y - last.y, p.x - last.x), step = Math.PI / 4, a2 = Math.round(ang / step) * step, len = Math.hypot(p.x - last.x, p.y - last.y);
    return { x: last.x + Math.cos(a2) * len, y: last.y + Math.sin(a2) * len };
  }
  addAreaPoint(p) {
    const type = this.tool === 'polyline' ? 'polyline' : 'area';
    if (!this.draft) this.draft = { type, pts: [] };
    const d = this.draft;
    const last = d.pts[d.pts.length - 1];
    if (type === 'polyline') {
      if (last && d.pts.length >= 2 && dist(last, p) * this.scale < 18) { this.finishArea(); return; } // לחיצה על הנקודה האחרונה = סיום
      if (d.pts.length >= 3 && dist(d.pts[0], p) * this.scale < 18) { d.closed = true; this.finishArea(); return; } // לחיצה על הראשונה = סגירת צורה
      p = this.orthoPt(p);
    } else {
      if (last && dist(last, p) * this.scale < 4) return;
      if (d.pts.length >= 3 && dist(d.pts[0], p) * this.scale < 14) { this.finishArea(); return; }
    }
    if (last && dist(last, p) * this.scale < 4) return;
    d.pts.push(p);
    this.renderDraft(); this.renderProps();
  }
  undoPoint() {
    const d = this.draft;
    if (!d || !d.pts) return;
    d.pts.pop();
    if (!d.pts.length) this.draft = null;
    this.renderDraft(); this.renderProps();
  }
  async finishArea() {
    const d = this.draft;
    const need = d && d.type === 'polyline' ? 2 : 3;
    if (!d || d.pts.length < need) { UI.toast(need === 2 ? tr('קו דורש לפחות 2 נקודות') : tr('שטח דורש לפחות 3 נקודות')); return; }
    this.draft = null;
    delete d.hover;
    await this.commitNew(d);
    this.renderDraft(); this.renderProps();
  }
  cancelDraft() { this.draft = null; this.renderDraft(); this.renderProps(); }

  // ---------- עט: לחיצה ארוכה מיישרת לקו/צורה ----------
  armHold(g) {
    clearTimeout(g.hold);
    g.hold = setTimeout(() => this.snapPen(g), 650);
  }
  snapPen(g) {
    if (this.gesture !== g || g.snapped || !this.draft || this.draft.type !== 'pen') return;
    const r = recognize(this.draft.pts, this.scale);
    if (!r) {
      if (!g.hintShown) { g.hintShown = true; UI.toast(tr('לא זוהתה צורה – שחררו כרגיל כדי לשמור את הקו החופשי'), { ms: 2200 }); }
      return;
    }
    g.snapped = true; g.snap = r;
    navigator.vibrate?.(12);
    this.draft = { type: r.type, pts: r.pts.map((q) => ({ x: q.x, y: q.y })), closed: r.closed, fromPen: true };
    this.renderDraft();
  }

  // ---------- מחק ----------
  eraseAt(a, b) {
    const tol = 11 / this.scale, step = Math.max(2 / this.scale, 1e-3);
    const n = Math.max(1, Math.ceil(dist(a, b) / (step * 3)));
    let changed = false;
    const list = this.visibleItems();
    for (let i = 0; i <= n; i++) {
      const q = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      for (const it of list) if (!this.eraseSet.has(it.id) && this.canEditItem(it) && hitItem(it, q, tol)) { this.eraseSet.add(it.id); changed = true; }
    }
    if (changed) this.renderItems();
  }
  async commitErase() {
    const ids = this.eraseSet; this.eraseSet = null;
    if (!ids || !ids.size) { this.renderItems(); return; }
    const entries = [];
    for (const layer of ['markups', 'measurements', 'links']) for (const it of this.items[layer]) if (ids.has(it.id)) entries.push({ before: clone(it), after: null });
    for (const e of entries) await this.setItemState(e.before, null);
    this.history.push({ multi: entries }); this.redoStack = [];
    this.updateUndo(); this.renderProps();
    UI.toast(entries.length === 1 ? tr('נמחק פריט אחד (אפשר לבטל)') : tr('נמחקו {0} פריטים (אפשר לבטל)', entries.length), { ms: 1800 });
  }

  // ---------- כיול ומדידה ----------
  async needCalibration(nextTool) {
    if (!CS.canMarkPlan(this.planId)) { UI.toast(tr('נדרש כיול לעמוד הזה, אבל אין לך הרשאת סימון בתוכנית'), { type: 'error', ms: 5000 }); return; }
    const ok = await UI.confirmBox(tr('כדי למדוד צריך להגדיר סקאלה לעמוד הזה. האפליקציה לא מנחשת מידות – בחרו סקאלה (למשל 1:100) או כיילו לפי מרחק ידוע בתוכנית.'), { title: tr('נדרש כיול'), okText: tr('הגדר סקאלה') });
    if (ok) this.calibrateDialog(nextTool);
  }
  async calibrateDialog(nextTool) {
    if (!this.page) return;
    if (!CS.canMarkPlan(this.planId)) { UI.toast(tr('כיול דורש הרשאת סימון בתוכנית'), { type: 'error' }); return; }
    const cal = this.calibs.get(this.pageNum);
    const paper = paperName(this.pw, this.ph);
    const wmm = Math.round((this.pw * 25.4) / 72), hmm = Math.round((this.ph * 25.4) / 72);
    const ratio = h('input', { type: 'number', min: 1, step: 1, value: cal?.ratio || '', placeholder: '100', inputMode: 'numeric' });
    const all = h('input', { type: 'checkbox' });
    const shareCal = h('input', { type: 'checkbox', checked: !!cal?.shared });
    const cands = h('div', { class: 'row wrap' });
    let m;
    const applyRatio = async (n) => {
      if (!(n >= 1)) { UI.toast(tr('הזן מספר גדול מ-0'), { type: 'error' }); return; }
      const pages = all.checked ? Array.from({ length: this.numPages }, (_, i) => i + 1) : [this.pageNum];
      for (const pg of pages) {
        const c = { id: this.calId(pg), versionId: this.version.id, planId: this.planId, page: pg, mpu: mpuFromRatio(n), source: 'ratio', ratio: n, shared: shareCal.checked || undefined };
        await S.putItem('calibrations', c); this.setCals([...(this.calList || []).filter((x) => x.id !== c.id), c]);
      }
      this.renderItems(); this.renderProps();
      UI.toast(tr('הוגדרה סקאלה 1:{0}', n));
      m.close(); if (nextTool) this.setTool(nextTool);
    };
    const status = cal
      ? h('p', { class: 'ok' }, cal.source === 'ratio' ? tr('סקאלה נוכחית לעמוד: 1:{0}', cal.ratio) : tr('העמוד כויל ידנית לפי מרחק ידוע.'))
      : h('p', { class: 'warn' }, tr('לעמוד הזה עדיין אין כיול – מדידות לא יוצגו.'));
    const body = h('div', { class: 'stack' }, status,
      h('h4', {}, tr('1. סקאלה מהתוכנית')),
      h('p', { class: 'hint' }, tr('גודל העמוד בקובץ: {0}×{1} מ״מ{2}. סקאלה 1:N מדויקת רק אם ה-PDF נשמר בגודל הדף המקורי, ללא הקטנה. אם יש ספק – השתמשו בכיול ידני.', wmm, hmm, paper ? ` (${paper})` : tr(' (לא גודל נייר סטנדרטי)'))),
      h('div', { class: 'row' }, h('span', {}, '1 :'), ratio, h('button', { class: 'btn primary', onclick: () => applyRatio(parseFloat(ratio.value)) }, tr('החל'))),
      cands,
      h('label', { class: 'check' }, all, tr('החל על כל עמודי הקובץ')),
      isCloud() && isAdmin() ? h('label', { class: 'check' }, shareCal, tr('שתף את הכיול עם העובדים (אחרת הכיול שלי בלבד)')) : null,
      h('h4', {}, tr('2. כיול ידני')),
      h('p', { class: 'hint' }, tr('סמנו שתי נקודות בתוכנית שהמרחק ביניהן ידוע (למשל מידה כתובה), ואז הזינו את המרחק האמיתי.')),
      h('button', { class: 'btn', onclick: () => { m.close(); this.calShare = shareCal.checked; this.startCalibrateTool(all.checked, nextTool); } }, icon('ruler', 18), tr('סמן שתי נקודות')),
      cal && (!cal.ownerId || cal.ownerId === S.hooks.owner()) ? h('button', { class: 'btn danger', onclick: async () => { await S.delItem('calibrations', cal.id); this.setCals((this.calList || []).filter((c) => c.id !== cal.id)); this.renderItems(); this.renderProps(); m.close(); } }, tr('אפס כיול בעמוד')) : null);
    m = UI.openModal({ title: tr('סקאלה וכיול'), body, buttons: [{ text: tr('סגור'), value: true }] });
    try { // הצעה בלבד: סקאלה שנמצאה בטקסט העמוד – חובה לאמת מול התוכנית
      const txt = await pageText(this.page);
      const found = new Set();
      for (const mm of txt.matchAll(/(?:^|[^\d:])1\s*[:：]\s*(\d{1,4})(?!\d)/g)) { const n = +mm[1]; if (n >= 2 && n <= 5000) found.add(n); }
      if (found.size) {
        cands.append(h('span', { class: 'hint' }, tr('נמצא בטקסט של העמוד (יש לאמת מול התוכנית):')));
        [...found].slice(0, 5).forEach((n) => cands.append(h('button', { class: 'btn sm', onclick: () => applyRatio(n) }, `1:${n}`)));
      }
    } catch { /* ignore */ }
  }
  startCalibrateTool(applyAll, nextTool) {
    this.calibAll = applyAll; this.calibNext = nextTool;
    this.tool = 'calibrate'; this.draft = null;
    this.updateToolUI(); this.renderProps();
    UI.toast(tr('סמנו שתי נקודות עם מרחק ידוע'), { ms: 4000 });
  }
  async calibrateFromPoints(pts) {
    this.draft = null; this.renderDraft();
    const len = dist(pts[0], pts[1]);
    const val = h('input', { type: 'number', step: 'any', min: 0, placeholder: tr('לדוגמה 3.5'), inputMode: 'decimal', autofocus: true });
    const unit = h('select', {}, h('option', { value: 'm' }, tr('מטר')), h('option', { value: 'cm' }, tr('ס״מ')), h('option', { value: 'mm' }, tr('מ״מ')));
    unit.value = prefs.unit;
    const r = await UI.modal({
      title: tr('המרחק האמיתי בין שתי הנקודות'), body: h('div', { class: 'form' }, h('div', { class: 'row' }, val, unit)),
      buttons: [{ text: tr('ביטול'), value: false }, { text: tr('כייל'), kind: 'primary', value: true }],
    });
    this.tool = 'pan'; this.updateToolUI();
    if (!r) { this.renderProps(); return; }
    const d = parseFloat(val.value);
    if (!(d > 0) || !(len > 0)) { UI.toast(tr('מרחק לא תקין'), { type: 'error' }); this.renderProps(); return; }
    const meters = unit.value === 'm' ? d : unit.value === 'cm' ? d / 100 : d / 1000;
    const pages = this.calibAll ? Array.from({ length: this.numPages }, (_, i) => i + 1) : [this.pageNum];
    for (const pg of pages) {
      const c = { id: this.calId(pg), versionId: this.version.id, planId: this.planId, page: pg, mpu: meters / len, source: 'manual', shared: this.calShare || undefined };
      await S.putItem('calibrations', c); this.setCals([...(this.calList || []).filter((x) => x.id !== c.id), c]);
    }
    UI.toast(tr('הכיול נשמר'));
    this.renderItems();
    if (this.calibNext) { const t = this.calibNext; this.calibNext = null; this.setTool(t); } else this.renderProps();
  }

  // ---------- קישורים ----------
  async createLink(d) {
    const res = await this.linkDialog(null);
    if (!res) { this.renderDraft(); return; }
    const it = this.newItem(d);
    it.target = res.target;
    await this.addItem(it);
    this.renderProps();
    if (res.pick && !this.host) this.beginPick(it);
    else if (res.pick) UI.toast(tr('קביעת מיקום מדויק ליעד זמינה בתצוגה רגילה (לא מפוצלת)'), { ms: 4000 });
  }
  async linkDialog(existing) {
    let plan = existing ? S.P.plans.get(existing.target.planId) : null;
    if (!plan) plan = await UI.planPicker({ title: tr('לאן הקישור יוביל?') });
    if (!plan) return null;
    const ver = S.curVer(plan);
    const page = h('input', { type: 'number', min: 1, max: ver?.pageCount || 999, value: existing?.target?.page || 1, inputMode: 'numeric' });
    const r = await UI.modal({
      title: tr('קישור אל: ') + plan.name,
      body: h('div', { class: 'form' }, h('label', {}, tr('עמוד ביעד (1–{0})', ver?.pageCount || '?')), page,
        h('p', { class: 'hint' }, tr('אפשר גם לקבוע מיקום והגדלה מדויקים ביעד: בחרו "שמור וקבע מיקום ביעד".'))),
      buttons: [
        { text: tr('ביטול'), value: null },
        { text: tr('שמור'), kind: 'primary', value: 'save' },
        { text: tr('שמור וקבע מיקום ביעד'), value: 'pick' },
      ],
    });
    if (!r) return null;
    const old = existing?.target;
    const pg = clamp(parseInt(page.value, 10) || 1, 1, ver?.pageCount || 999);
    const target = { planId: plan.id, page: pg };
    if (old && old.planId === plan.id && old.page === pg && old.view) target.view = old.view;
    return { target, pick: r === 'pick' };
  }
  beginPick(link) {
    pickCtx = { linkId: link.id, returnHash: location.hash };
    const t = link.target;
    location.hash = `#/p/${t.planId}?page=${t.page}&pick=1`;
  }
  showPickBar() {
    if (!pickCtx) { this.pickBar.classList.add('hidden'); return; }
    this.pickBar.classList.remove('hidden');
    this.pickBar.replaceChildren(
      h('span', {}, tr('הזיזו והגדילו לתצוגה הרצויה ליעד הקישור, ואז לחצו "קבע כיעד"')),
      h('button', { class: 'btn sm primary', onclick: () => this.confirmPick() }, tr('קבע כיעד')),
      h('button', { class: 'btn sm', onclick: () => { const c = pickCtx; pickCtx = null; location.hash = c.returnHash; } }, tr('ביטול')));
  }
  async confirmPick() {
    const c = pickCtx; if (!c) return;
    const link = await db.get('links', c.linkId);
    if (link) {
      link.target = { ...link.target, planId: this.planId, page: this.pageNum, view: this.viewCenter() };
      await S.putItem('links', link);
    }
    pickCtx = null;
    UI.toast(tr('מיקום היעד נשמר'));
    location.hash = c.returnHash;
  }
  followLink(l) {
    const t = l.target;
    const plan = t && S.P.plans.get(t.planId);
    if (!plan) { UI.toast(tr('יעד הקישור נמחק'), { type: 'error' }); return; }
    const q = new URLSearchParams();
    q.set('page', t.page || 1);
    if (t.view) { q.set('x', t.view.cx.toFixed(2)); q.set('y', t.view.cy.toFixed(2)); q.set('z', t.view.scale.toFixed(4)); }
    if (this.host) { // בתצוגה מפוצלת הקישור נפתח באותה תצוגה, בלי לשנות את הכתובת
      const o = { page: t.page || 1 };
      if (t.view) o.view = t.view;
      if (plan.id === this.planId) this.handleOpts(o); else this.host.replace(this, plan.id, o);
      return;
    }
    location.hash = `#/p/${plan.id}?${q}`;
  }

  // ---------- לוחות צד: עמודים וחיפוש ----------
  openPanel(mode) {
    if (this.panelMode === mode && !this.panel.classList.contains('hidden')) { this.closePanel(); return; }
    this.panelMode = mode;
    this.updateSearchBar();
    this.panel.classList.remove('hidden');
    this.panel.textContent = '';
    const close = h('button', { class: 'icon-btn', 'aria-label': tr('סגור'), onclick: () => this.closePanel() }, icon('x'));
    if (mode === 'pages') {
      this.panel.append(h('div', { class: 'pn-head' }, h('b', {}, tr('עמודים')), close));
      this.thumbList = h('div', { class: 'thumb-list' });
      this.panel.append(this.thumbList);
      this.buildThumbs();
    } else {
      this.searchInput = h('input', { type: 'search', placeholder: tr('חיפוש טקסט בתוכנית…'), enterKeyHint: 'search', value: this.search?.q || '' });
      this.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(this._st); this.runSearch(this.searchInput.value, true).then(() => { if (window.innerWidth < 800 && this.search?.matches.length) this.closePanel(); }); } });
      // חיפוש תוך כדי הקלדה (השהיה קצרה כדי לא לחפש בכל תו)
      this.searchInput.addEventListener('input', () => {
        clearTimeout(this._st);
        const q = this.searchInput.value.trim();
        if (!q) { this.clearSearch({ keepPanel: true }); return; }
        this._st = setTimeout(() => this.runSearch(q, true), 250);
      });
      this.searchInfo = h('div', { class: 'hint' });
      this.searchList = h('div', { class: 'result-list compact' });
      this.panel.append(h('div', { class: 'pn-head' }, h('b', {}, tr('חיפוש בתוכנית')), close),
        h('div', { class: 'pn-search' }, this.searchInput,
          h('button', { class: 'icon-btn', onclick: () => this.gotoMatch(this.search ? this.search.idx - 1 : 0), 'aria-label': tr('הקודם') }, icon('chevU')),
          h('button', { class: 'icon-btn', onclick: () => this.gotoMatch(this.search ? this.search.idx + 1 : 0), 'aria-label': tr('הבא') }, icon('chevD'))),
        this.searchInfo, this.searchList);
      if (this.search) this.renderSearchList();
      setTimeout(() => this.searchInput.focus(), 50);
      this.pushSearch();
    }
    this.el.classList.add('panel-open');
  }
  updateSearchBar() {
    const s = this.search;
    const show = !!(s && s.matches.length) && this.panelMode !== 'search';
    this.sbar.classList.toggle('hidden', !show);
    if (show) this.sbarLabel.textContent = tr('{0} / {1}{2} · עמוד {3}', s.idx + 1, s.matches.length, s.matches.length >= 500 ? '+' : '', s.matches[s.idx]?.page ?? '');
  }
  pushSearch() { if (!this._sPush) { try { history.pushState({ vsearch: 1 }, ''); this._sPush = true; } catch { /* ignore */ } } }
  // מצב חיפוש: מנקה תוצאות וסימונים (וסוגר את רשומת ההיסטוריה שנוספה בשבילו)
  clearSearch({ keepPanel = false } = {}) {
    clearTimeout(this._st); this.searchToken++;
    this.search = null; this.renderSearchHits(); this.updateSearchBar();
    if (this._sPush) { this._sPush = false; try { history.back(); } catch { /* ignore */ } }
    if (keepPanel) { this.searchList?.replaceChildren(); if (this.searchInfo) this.searchInfo.textContent = ''; }
    else if (this.panelMode === 'search') this.closePanel();
  }
  closePanel() {
    this.panel.classList.add('hidden');
    this.panelMode = null;
    this.updateSearchBar();
    this.el.classList.remove('panel-open');
  }
  buildThumbs() {
    const io = new IntersectionObserver((es) => {
      for (const en of es) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        this.thumbQueue = (this.thumbQueue || Promise.resolve()).then(() => this.renderThumbInto(+en.target.dataset.n, en.target.querySelector('canvas')));
      }
    }, { root: this.thumbList, rootMargin: '200px' });
    this.thumbIO?.disconnect();
    this.thumbIO = io;
    for (let i = 1; i <= this.numPages; i++) {
      const c = h('canvas', { width: 10, height: 14 });
      const d = h('button', { class: 'pg-thumb' + (i === this.pageNum ? ' cur' : ''), 'data-n': i, onclick: () => { this.goPage(i); if (window.innerWidth < 800) this.closePanel(); } }, c, h('span', {}, String(i)));
      this.thumbList.append(d);
      io.observe(d);
    }
  }
  async renderThumbInto(i, canvas) {
    try {
      if (!this.doc || !canvas.isConnected) return;
      const page = await this.doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const s = Math.min(240 / v1.width, 300 / v1.height) * Math.min(this.dpr, 2);
      const vp = page.getViewport({ scale: s });
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#fff' }).promise;
      page.cleanup();
    } catch { /* ignore */ }
  }
  markThumb() {
    this.thumbList?.querySelectorAll('.pg-thumb').forEach((d) => d.classList.toggle('cur', +d.dataset.n === this.pageNum));
    this.thumbList?.querySelector('.pg-thumb.cur')?.scrollIntoView({ block: 'nearest' });
  }

  async pageTextData(i) {
    if (this.textCache.has(i)) return this.textCache.get(i);
    const page = await this.doc.getPage(i);
    const tc = await page.getTextContent();
    if (!tc.items.some((it) => typeof it.str === 'string' && it.str.trim())) { // עמוד סרוק: אם בוצע OCR משתמשים בו
      try {
        const row = await db.get('textindex', `${this.version.id}:${i}`);
        if (row && row.ocr && row.words) {
          page.cleanup();
          const words = row.words;
          const rects = (s, e) => words.filter((w) => w.e > s && w.s < e).map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
          const d = { text: row.text, rects, ocr: true };
          this.textCache.set(i, d);
          return d;
        }
      } catch { /* ignore */ }
    }
    const vp = page.getViewport({ scale: 1 });
    let text = '';
    const ranges = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      ranges.push({ start: text.length, end: text.length + it.str.length, it });
      text += it.str + (it.hasEOL ? ' ' : '');
    }
    const mc = document.createElement('canvas').getContext('2d');
    const RTL = /[\u0590-\u08FF]/;
    // חלק יחסי של רוחב המחרוזת עד אינדקס n (לפי מדידת פונט אמיתית, לא לפי מספר תווים)
    const frac = (str, n) => {
      if (n <= 0) return 0;
      if (n >= str.length) return 1;
      mc.font = '100px sans-serif';
      const tot = mc.measureText(str).width;
      return tot > 0 ? mc.measureText(str.slice(0, n)).width / tot : n / str.length;
    };
    const rects = (s, e) => {
      const out = [];
      for (const r of ranges) {
        if (r.end <= s || r.start >= e || !r.it.str.length) continue;
        const str = r.it.str;
        const a = Math.max(s - r.start, 0), b = Math.min(e - r.start, str.length);
        const t = r.it.transform;
        const rtl = r.it.dir === 'rtl' || (r.it.dir !== 'ltr' && RTL.test(str));
        let f0 = frac(str, a), f1 = frac(str, b);
        if (rtl) { const x = 1 - f1; f1 = 1 - f0; f0 = x; }
        const x0 = t[4] + r.it.width * f0, w = r.it.width * (f1 - f0);
        const hh = r.it.height || Math.hypot(t[2], t[3]);
        const [X1, Y1] = vp.convertToViewportPoint(x0, t[5] - hh * 0.2);
        const [X2, Y2] = vp.convertToViewportPoint(x0 + w, t[5] + hh * 0.95);
        out.push({ x: Math.min(X1, X2), y: Math.min(Y1, Y2), w: Math.abs(X2 - X1), h: Math.abs(Y2 - Y1) });
      }
      return out;
    };
    page.cleanup();
    const d = { text, rects };
    this.textCache.set(i, d);
    return d;
  }
  async runSearch(q, jump) {
    q = (q || '').trim();
    if (!q || !this.doc) return;
    if (this.panelMode !== 'search') this.openPanel('search');
    if (this.searchInput && this.searchInput.value.trim() !== q) this.searchInput.value = q;
    const token = ++this.searchToken;
    const s = { q, matches: [], idx: -1 };
    this.search = s;
    this.searchList?.replaceChildren();
    const ql = q.toLowerCase();
    for (let i = 1; i <= this.numPages; i++) {
      if (token !== this.searchToken || this.dead) return;
      if (this.searchInfo) this.searchInfo.textContent = tr('מחפש… עמוד {0} מתוך {1}', i, this.numPages);
      let d;
      try { d = await this.pageTextData(i); } catch { continue; }
      const tl = d.text.toLowerCase();
      let from = 0, idx;
      while ((idx = tl.indexOf(ql, from)) >= 0 && s.matches.length < 500) {
        const a = Math.max(0, idx - 30), b = Math.min(d.text.length, idx + ql.length + 40);
        s.matches.push({ page: i, start: idx, end: idx + ql.length, snippet: d.text.slice(a, b), d });
        from = idx + ql.length;
      }
      if (i % 5 === 0) this.renderSearchList();
    }
    this.renderSearchList();
    if (this.searchInfo) this.searchInfo.textContent = s.matches.length ? tr('{0} תוצאות', s.matches.length) : tr('לא נמצא טקסט תואם. אם הקובץ סרוק כתמונה – אפשר להפעיל זיהוי טקסט (OCR) מהתפריט ⋮.');
    if (jump && s.matches.length) {
      const first = s.matches.findIndex((m) => m.page >= this.pageNum);
      this.gotoMatch(first >= 0 ? first : 0);
    }
  }
  renderSearchList() {
    const s = this.search;
    if (!s || !this.searchList) return;
    this.searchList.replaceChildren(...s.matches.slice(0, 200).map((m, i) => h('button', { class: 'result' + (i === s.idx ? ' cur' : ''), onclick: async () => { await this.gotoMatch(i); if (window.innerWidth < 800) this.closePanel(); } },
      h('span', { class: 'col' }, h('b', {}, tr('עמוד {0}', m.page)), h('span', { class: 'snip' }, m.snippet)))));
  }
  async gotoMatch(i) {
    const s = this.search;
    if (!s || !s.matches.length) return;
    s.idx = (i + s.matches.length) % s.matches.length;
    const m = s.matches[s.idx];
    if (m.page !== this.pageNum) await this.goPage(m.page, { fresh: true });
    const r = m.d.rects(m.start, m.end)[0];
    if (r) {
      const sc = Math.max(this.scale, PT * 1.5);
      this.setView(sc, this.vw / 2 - (r.x + r.w / 2) * sc, this.H / 2 - (r.y + r.h / 2) * sc);
    }
    this.renderSearchHits(); this.renderSearchList(); this.updateSearchBar();
    this.searchList?.querySelector('.result.cur')?.scrollIntoView({ block: 'nearest' });
  }
  renderSearchHits() {
    this.gSearch.textContent = '';
    const s = this.search;
    if (!s) return;
    s.matches.forEach((m, i) => {
      if (m.page !== this.pageNum) return;
      for (const r of m.d.rects(m.start, m.end)) this.gSearch.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: i === s.idx ? '#ff9800' : '#ffeb3b', 'fill-opacity': 0.5, rx: r.h * 0.1 }));
    });
  }

  async ocrDialog() {
    if (!this.version) return;
    const vid = this.version.id;
    const info = h('p', { class: 'msg' }, tr('בודק אילו עמודים חסרי טקסט…'));
    const m = UI.openModal({ title: tr('זיהוי טקסט בסריקה (OCR)'), body: info, buttons: [{ text: tr('סגור'), value: false }] });
    let r;
    try { r = await OCR.pagesNeedingOcr(vid); } catch (e) { info.textContent = tr('הבדיקה נכשלה: ') + (e.message || e); return; }
    if (!r) { info.textContent = tr('הקובץ עדיין לא הורד למכשיר.'); return; }
    if (!r.need.length) { info.textContent = tr('לכל העמודים כבר יש טקסט שניתן לחיפוש – אין צורך ב-OCR.'); return; }
    const cur = this.pageNum;
    const choose = (pages) => { m.close(); this.runOcr(vid, pages); };
    info.textContent = tr('נמצאו {0} עמודים בלי טקסט (סרוקים כתמונה) מתוך {1}. הזיהוי רץ במכשיר (עברית ואנגלית), בלי לשלוח כלום החוצה, ולוקח כמה שניות עד חצי דקה לעמוד בטלפון. הקובץ עצמו לא משתנה. הדיוק תלוי באיכות הסריקה – בכתב יד ובשרטוטים מסובכים הוא נמוך.', r.need.length, r.total);
    const foot = m.el.querySelector('.modal-foot');
    const b1 = h('button', { class: 'btn', onclick: () => choose(r.need.includes(cur) ? [cur] : [r.need[0]]) }, tr('העמוד הנוכחי בלבד'));
    const b2 = h('button', { class: 'btn primary', onclick: () => choose(r.need) }, tr('כל {0} העמודים', r.need.length));
    foot.prepend(b2); foot.prepend(b1);
  }
  async runOcr(vid, pages) {
    let cancel = false;
    const status = h('p', { class: 'msg' }, tr('טוען רכיבי זיהוי (בפעם הראשונה זה לוקח קצת)…'));
    const m = UI.openModal({ title: tr('מזהה טקסט…'), body: status, cancelable: false, buttons: [{ text: tr('עצור'), value: false, onClick: () => { cancel = true; status.textContent = tr('עוצר אחרי העמוד הנוכחי…'); return false; } }] });
    try {
      const res = await OCR.ocrVersion(vid, pages, {
        isCancelled: () => cancel || this.dead,
        onProgress: (p) => { if (p.page) status.textContent = tr('מזהה עמוד {0} ({1} מתוך {2})…', p.page, p.done + 1, p.total); },
      });
      m.close();
      this.textCache.clear();
      UI.toast(res.found ? tr('זוהה טקסט ב-{0} עמודים. אפשר לחפש עכשיו.', res.found) : tr('לא זוהה טקסט (הסריקה ריקה או באיכות נמוכה מדי).'), { ms: 5000 });
      if (this.search) this.runSearch(this.search.q, false);
    } catch (e) {
      m.close();
      console.error(e);
      UI.toast(tr('ה-OCR נכשל: ') + (e.message || e), { type: 'error', ms: 7000 });
    }
  }

  // ---------- השוואה ----------
  async openCompare(preVid) {
    if (this.cont) this.setCont(false, { quiet: true });
    if (this.cmpUI) { if (preVid) { this.cmpUI.setVersion(preVid); this.cmpUI.apply(); } return; }
    if (!this.doc) return;
    const planSel = h('select', {}), verSel = h('select', {});
    const plans = [...S.P.plans.values()].sort((a, b) => natural(S.planPathText(a) + a.name, S.planPathText(b) + b.name));
    plans.forEach((p) => planSel.append(h('option', { value: p.id }, p.id === this.planId ? tr('{0} (התוכנית הזו)', dn(p.name)) : `${dn(p.name)} — ${S.planPathText(p)}`)));
    const fillVers = (sel) => {
      verSel.textContent = '';
      S.versionsOf(planSel.value).forEach((v) => verSel.append(h('option', { value: v.id }, `V${v.number} – ${fmtDate(v.date)}${v.id === this.version.id ? tr(' (הפתוחה)') : ''}${S.P.plans.get(v.planId)?.currentVersionId === v.id ? tr(' · נוכחית') : ''}`)));
      if (sel) verSel.value = sel;
    };
    const setVersion = (vid) => { const v = S.P.versions.get(vid); if (!v) return; planSel.value = v.planId; fillVers(vid); };
    planSel.value = this.planId; fillVers();
    const other = S.versionsOf(this.planId).find((v) => v.id !== this.version.id);
    if (other) verSel.value = other.id;
    planSel.onchange = () => fillVers();
    const pageIn = h('input', { type: 'number', min: 1, value: this.pageNum, inputMode: 'numeric', class: 'num' });
    const modeSel = h('select', {}, h('option', { value: 'diff' }, tr('הבדלים (צבעים)')), h('option', { value: 'overlay' }, tr('שקיפות')), h('option', { value: 'split' }, tr('זו לצד זו')));
    const op = h('input', { type: 'range', min: 0, max: 100, value: 50 });
    const legend = h('div', { class: 'cmp-legend' });
    const apply = async () => {
      const vid = verSel.value;
      if (!vid) return;
      legend.textContent = tr('טוען…');
      try { await this.startCompare(vid, parseInt(pageIn.value, 10) || 1, modeSel.value, op.value / 100); } catch (e) { console.error(e); UI.toast(tr('לא ניתן לטעון את התוכנית להשוואה'), { type: 'error' }); legend.textContent = ''; return; }
      this.updateCmpLegend(legend);
    };
    modeSel.onchange = () => { if (this.cmp) { this.setCompareMode(modeSel.value, op.value / 100); this.updateCmpLegend(legend); } };
    op.oninput = () => { if (this.cmp) { this.cmp.opacity = op.value / 100; if (this.cmp.mode === 'overlay') this.layerB.el.style.opacity = op.value / 100; } };
    const nudge = (dx, dy) => { if (!this.cmp) return; const st = 1.5 / this.scale; this.layerB.dx += dx * st; this.layerB.dy += dy * st; this.layerB.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(200); };
    const nb = (ic, fn, label) => h('button', { class: 'icon-btn sm', 'aria-label': label, onclick: fn }, icon(ic, 18));
    const alignBtn = h('button', { class: 'btn sm', onclick: () => { this.alignDrag = !this.alignDrag; alignBtn.classList.toggle('primary', this.alignDrag); if (this.alignDrag) UI.toast(tr('בכלי ההזזה: גררו את המסך כדי להזיז את התוכנית להשוואה')); } }, tr('גרור ליישור'));
    const sc = (f) => { if (!this.cmp) return; this.layerB.s *= f; this.layerB.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(200); };
    this.cmpBar.replaceChildren(
      h('div', { class: 'cmp-row' }, h('b', {}, tr('השוואה עם:')), planSel, verSel, h('span', {}, tr('עמוד')), pageIn, modeSel,
        h('button', { class: 'btn sm primary', onclick: apply }, tr('השווה')), h('button', { class: 'icon-btn sm', 'aria-label': tr('סגור השוואה'), onclick: () => this.closeCompare() }, icon('x', 18))),
      h('div', { class: 'cmp-row' }, h('span', {}, tr('שקיפות')), op, h('span', { class: 'sp' }), h('span', {}, tr('יישור:')),
        nb('chevU', () => nudge(0, -1), tr('למעלה')), nb('chevD', () => nudge(0, 1), tr('למטה')), nb('chevR', () => nudge(1, 0), tr('ימינה')), nb('chevL', () => nudge(-1, 0), tr('שמאלה')),
        h('button', { class: 'btn sm', onclick: () => sc(1.002) }, tr('הגדל')), h('button', { class: 'btn sm', onclick: () => sc(1 / 1.002) }, tr('הקטן')),
        alignBtn,
        h('button', { class: 'btn sm', onclick: () => { if (!this.cmp) return; this.layerB.dx = this.layerB.dy = 0; this.layerB.s = this.cmp.baseS; this.layerB.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(50); } }, tr('אפס יישור'))),
      legend);
    this.cmpBar.classList.remove('hidden');
    this.el.classList.add('cmp-open');
    this.cmpUI = { setVersion, apply };
    if (preVid) { setVersion(preVid); apply(); }
  }
  updateCmpLegend(el) {
    const mode = this.cmp?.mode;
    el.replaceChildren(h('small', {},
      mode === 'diff' ? tr('אדום = קיים רק בתוכנית הפתוחה · כחול = קיים רק בתוכנית להשוואה · שחור = זהה. ') : mode === 'overlay' ? tr('התוכנית להשוואה מונחת מעל הפתוחה בשקיפות שנבחרה. ') : tr('שתי התוכניות זו לצד זו עם זום והזזה משותפים. '),
      tr('זו השוואה חזותית בלבד – לא זיהוי אוטומטי של שינויים, והיא אמינה רק כשהתוכניות מיושרות.'),
      this.cmp?.sizeNote ? ' ' + this.cmp.sizeNote : ''));
  }
  async startCompare(vid, pageNo, mode, opacity) {
    const blob = await S.getFileBlob(vid);
    if (!blob) throw new Error('missing');
    const doc = await openPdf(blob, { interactive: true });
    destroyDoc(this.cmpDoc);
    this.cmpDoc = doc;
    this.cmp = { vid, page: clamp(pageNo, 1, doc.numPages), mode, opacity, baseS: 1 };
    await this.loadCompareLayer();
    this.setCompareMode(mode, opacity);
  }
  async loadCompareLayer() {
    if (!this.cmpDoc || !this.cmp) return;
    const pg = await this.cmpDoc.getPage(clamp(this.cmp.page, 1, this.cmpDoc.numPages));
    await this.layerB.setPage(pg);
    this.layerB.dx = this.layerB.dy = 0;
    const r = this.layerA.pw / this.layerB.pw;
    this.cmp.sizeNote = '';
    if (Math.abs(r - 1) > 0.01) { this.layerB.s = r; this.cmp.baseS = r; this.cmp.sizeNote = tr('גודל העמודים שונה – הותאם לפי הרוחב, כדאי לוודא יישור.'); } else { this.layerB.s = 1; this.cmp.baseS = 1; }
  }
  setCompareMode(mode, opacity) {
    const c = this.cmp; c.mode = mode; c.opacity = opacity;
    this.split = mode === 'split';
    const diff = mode === 'diff';
    this.layerA.tint = diff ? '#e53935' : null;
    this.layerB.tint = diff ? '#1e63ff' : null;
    const B = this.layerB.el;
    B.style.display = '';
    B.style.isolation = 'isolate';
    B.style.mixBlendMode = diff ? 'multiply' : 'normal';
    B.style.opacity = mode === 'overlay' ? opacity : 1;
    this.measure();
    this.layerA.renderBase(); this.layerB.renderBase();
    this.layerA.removeDetail(); this.layerB.removeDetail();
    this.fit(this.fitMode || 'page');
    this.scheduleDetail(50);
  }
  closeCompare() {
    this.cmp = null; this.split = false; this.alignDrag = false; this.cmpUI = null;
    this.layerA.tint = null;
    this.layerB.el.style.display = 'none'; this.layerB.removeDetail();
    destroyDoc(this.cmpDoc); this.cmpDoc = null;
    this.cmpBar.classList.add('hidden');
    this.el.classList.remove('cmp-open');
    this.measure();
    this.layerA.renderBase(); this.layerA.removeDetail();
    this.fit(this.fitMode || 'page');
    this.scheduleDetail(50);
  }

  // ---------- תפריטים ----------
  layersDialog() {
    const mk = (key, label) => {
      const cb = h('input', { type: 'checkbox', checked: !!prefs.show[key], onchange: () => { prefs.show[key] = cb.checked; savePrefs(); this.renderItems(); } });
      return h('label', { class: 'check' }, cb, label);
    };
    const parts = [mk('markups', tr('סימונים (חצים, קווים, טקסט…)')), mk('measurements', tr('מדידות')), mk('links', tr('קישורים בין תוכניות'))];
    if (isCloud()) {
      const owners = [...new Set([...this.items.markups, ...this.items.measurements].map((it) => it.ownerId).filter(Boolean))];
      const me = CS.myId();
      if (me && !owners.includes(me)) owners.unshift(me);
      owners.sort((a, b) => (a === me ? -1 : b === me ? 1 : 0));
      const cur = () => (prefs.authors === 'all' ? owners : Array.isArray(prefs.authors) ? prefs.authors : (isAdmin() && !S.getViewAs() ? [me] : owners));
      const boxes = [];
      const setSel = () => { const on = boxes.filter((b) => b.cb.checked).map((b) => b.id); prefs.authors = on.length === owners.length ? 'all' : on; savePrefs(); this.renderItems(); };
      parts.push(h('h3', {}, tr('סימונים ומדידות של')));
      for (const id of owners) {
        const cb = h('input', { type: 'checkbox', checked: cur().includes(id), onchange: setSel });
        boxes.push({ id, cb });
        parts.push(h('label', { class: 'check' }, cb, SH.nameOf(id)));
      }
      if (owners.length <= 1 && isAdmin()) parts.push(h('p', { class: 'hint' }, tr('סימונים של עובדים יופיעו כאן כשיהיו כאלה בגרסה הזו. כל עובד מסמן באופן פרטי, ואתה בוחר מה להציג.')));
      if (this.canShareHere()) {
        parts.push(h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm primary', onclick: () => SH.shareDialog(this) }, icon('users', 16), tr('שיתוף סימונים…')),
          h('button', { class: 'btn sm', onclick: () => SH.sharesOverview(this) }, tr('שיתופים פעילים'))));
      }
    }
    parts.push(h('p', { class: 'hint' }, tr('הסימונים, המדידות והקישורים נשמרים בנפרד מקובץ ה-PDF ואינם משנים אותו.')));
    UI.modal({ title: tr('שכבות תצוגה'), body: h('div', { class: 'stack' }, ...parts), buttons: [{ text: tr('סגור'), kind: 'primary', value: true }] });
  }
  moreMenu(anchor) {
    UI.menu(anchor, [
      { label: tr('גרסאות'), icon: 'clock', onClick: () => A.versionsDialog(this.planId, { onChange: () => this.afterVersionsChange() }) },
      { label: tr('השוואת תוכניות'), icon: 'compare', onClick: () => this.openCompare() },
      { label: this.cont ? tr('מצב עמוד בודד') : tr('גלילה רציפה (עמודים ברצף)'), icon: 'scroll', onClick: () => this.setCont(!this.cont) },
      { label: tr('זיהוי טקסט בסריקה (OCR)…'), icon: 'search', onClick: () => this.ocrDialog() },
      { label: tr('שכבות (הצגה/הסתרה)'), icon: 'layers', onClick: () => this.layersDialog() },
      ...(this.canShareHere() ? [{ label: tr('שיתוף סימונים עם עובדים…'), icon: 'users', onClick: () => SH.shareDialog(this) }] : []),
      { divider: true },
      { label: tr('הדפסה / שמירה כ-PDF עם הסימונים'), icon: 'print', onClick: () => this.printDialog() },
      { label: tr('שנה שם תוכנית'), icon: 'edit', onClick: () => this.renameDialog() },
      { label: tr('פתח באמצעות / שתף'), icon: 'share', onClick: () => A.openWithDialog(this.plan, this.version?.id) },
      { label: tr('הורד PDF מקורי'), icon: 'download', onClick: () => A.downloadVersion(this.version?.id, this.plan.name) },
      { label: tr('סקאלה וכיול לעמוד'), icon: 'ruler', onClick: () => this.calibrateDialog() },
      { label: tr('ייצוא מדידות לאקסל'), icon: 'download', onClick: () => this.exportXlsx() },
      { label: tr('מסך מלא'), icon: 'maximize', onClick: () => this.toggleFullscreen() },
      ...(this.host ? [{ label: tr('אפשרויות תצוגה מפוצלת…'), icon: 'split', onClick: () => this.host.menu(this, this.topbar.lastElementChild) }] : [{ label: tr('תצוגה מפוצלת (2–3 תוכניות במקביל)'), icon: 'split', onClick: () => this.splitEnter() }]),
      { label: tr('מצב תצוגה נקי (הסתר סרגלים)'), icon: 'eye', onClick: () => this.el.classList.add('immersive') },
      { label: tr('פרטי תוכנית'), icon: 'info', onClick: () => A.planInfoDialog(this.planId) },
      { label: langButtonLabel(), icon: 'globe', onClick: toggleLang },
      { divider: true },
      { label: tr('מחק את כל הסימונים בעמוד'), icon: 'trash', danger: true, onClick: () => this.clearPage() },
    ]);
  }
  async clearPage() {
    const list = this.items.markups.filter((i) => i.page === this.pageNum);
    if (!list.length) { UI.toast(tr('אין סימונים בעמוד')); return; }
    if (!(await UI.confirmBox(tr('למחוק {0} סימונים בעמוד {1}? (מדידות וקישורים לא יימחקו)', list.length, this.pageNum), { danger: true, okText: tr('מחק') }))) return;
    const entries = list.map((it) => ({ before: clone(it), after: null }));
    for (const e of entries) await this.setItemState(e.before, null);
    this.history.push({ multi: entries });
    this.redoStack = [];
    this.updateUndo();
  }
  splitEnter() { if (!this.host) enterSplit(this); }
  toggleFullscreen() {
    if (this.host) { UI.toast(tr('מסך מלא זמין בתצוגה רגילה. אפשר לצאת מהתצוגה המפוצלת מכפתור התצוגה המפוצלת.'), { ms: 3500 }); return; }
    if (this.el.classList.contains('fs')) this.exitFullscreenMode(); else this.enterFullscreenMode();
  }
  enterFullscreenMode() {
    // הממשק מוסתר מיד (נשאר רק כפתור יציאה), בלי לבקש מסך מלא מהדפדפן
    this._fsT0 = performance.now(); this._quietUntil = this._fsT0 + 450;
    this.el.classList.add('fs');
    this.el.classList.remove('fs-tools');
    this.panel?.classList.add('hidden');
    // "אחורה" של אנדרואיד מכווץ את המסך המלא (ולא יוצא מהתוכנית)
    this._fsLayer?.release();
    this._fsLayer = pushLayer(() => { this._fsLayer = null; this.exitFullscreenMode(); });
    // מסך מלא של האפליקציה בלבד: מסתירים את כל הסרגלים שלה. לא מבקשים מסך מלא מהדפדפן, כי אז Chrome מציג בעצמו
    // הודעה ("גררו מלמעלה ליציאה") שנשארת על המסך זמן רב ואי אפשר לשלוט בה. באפליקציה מותקנת זה כמעט זהה.
  }
  exitFullscreenMode() {
    // חוזרים מיד לממשק הרגיל, ורק אחר כך מבקשים מהדפדפן לצאת ממסך מלא, כדי שהלחיצה תרגיש מיידית
    this._fsT0 = performance.now(); this._quietUntil = this._fsT0 + 450;
    this.el.classList.remove('fs', 'fs-tools');
    const l = this._fsLayer; this._fsLayer = null; l?.release();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  onFsChange() {
    this._quietUntil = performance.now() + 450;
    const inFs = !!document.fullscreenElement;
    if (!inFs && this.el?.classList.contains('fs')) { this.el.classList.remove('fs', 'fs-tools'); const l = this._fsLayer; this._fsLayer = null; l?.release(); } // יציאה בתנועת מערכת
    if (this._fsT0) { diag.info('fullscreen', inFs ? tr('נכנס למסך מלא') : tr('יצא ממסך מלא'), { ms: Math.round(performance.now() - this._fsT0) }); this._fsT0 = 0; }
  }

  async destroy() {
    this.dead = true;
    if (this._fsLayer) { this._fsLayer.release(); this._fsLayer = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.storeView();
    clearTimeout(this.dt);
    document.removeEventListener('keydown', this.keyFn);
    this._nameSub?.();
    document.removeEventListener('keyup', this.keyUpFn);
    this.ro?.disconnect();
    document.removeEventListener('fullscreenchange', this._onFsChange);
    clearTimeout(this._rt); clearTimeout(this._ri);
    this.offItems?.();
    window.removeEventListener('popstate', this._onPop);
    this.layerN?.destroy(); this.layerP?.destroy();
    this.thumbIO?.disconnect();
    this.searchToken++;
    this.layerA?.destroy(); this.layerB?.destroy();
    try { await destroyDoc(this.doc); } catch { /* ignore */ }
    try { await destroyDoc(this.cmpDoc); } catch { /* ignore */ }
    this.el?.remove();
  }
}

installStyle(Viewer);
installPrint(Viewer);
