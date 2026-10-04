// ה-Viewer: זום עמוק וחד, גרירה, Pinch, סימונים, מדידות, קישורים, השוואה, חיפוש, גרסאות
import * as S from './store.js';
import * as db from './db.js';
import * as UI from './ui.js';
import * as A from './actions.js';
import { openPdf, pageText, destroyDoc } from './pdfio.js';
import { Layer } from './layer.js';
import { h, icon, uid, clamp, clone, fmtDate, natural } from './util.js';
import {
  svg, LAYER_OF, RECT_TYPES, dist, drawItem, hitItem, handlesOf, boundsOf, corners, textBox,
  paperName, mpuFromRatio, fmtLen, kindOf,
} from './markup.js';
import { recognize, snapAngle } from './shape-recog.js';
import { prefs, savePrefs, COLORS, WIDTHS } from './prefs.js';
import { installStyle } from './viewer-style.js';
import { installPrint } from './viewer-print.js';

const PT = 96 / 72; // "100%" = גודל אמיתי ב-96 DPI
const MAXS = PT * 64; // עד 6400%
const TOOLS = [
  { id: 'pan', icon: 'move', label: 'הזזה' },
  { id: 'select', icon: 'cursor', label: 'בחירה' },
  { sep: true },
  { id: 'pen', icon: 'pen', label: 'עט' },
  { id: 'line', icon: 'line', label: 'קו' },
  { id: 'polyline', icon: 'polyline', label: 'קו נקודות' },
  { id: 'arrow', icon: 'arrow', label: 'חץ' },
  { id: 'rect', icon: 'rect', label: 'מלבן' },
  { id: 'ellipse', icon: 'circle', label: 'עיגול' },
  { id: 'text', icon: 'type', label: 'טקסט' },
  { id: 'highlight', icon: 'highlight', label: 'הדגשה' },
  { id: 'eraser', icon: 'eraser', label: 'מחק' },
  { sep: true },
  { id: 'measure', icon: 'ruler', label: 'מרחק' },
  { id: 'area', icon: 'polygon', label: 'שטח' },
  { sep: true },
  { id: 'link', icon: 'link', label: 'קישור' },
];

const lastView = new Map();

let cur = null;
let pickCtx = null;
export function startPick(ctx) { pickCtx = ctx; }

export async function openViewer(root, planId, opts = {}) {
  if (cur && cur.planId === planId) { await cur.handleOpts(opts); return; }
  await closeViewer();
  cur = new Viewer(root, planId, opts);
  await cur.init();
}
export async function closeViewer() {
  if (cur) { const c = cur; cur = null; await c.destroy(); }
}

class Viewer {
  constructor(root, planId, opts) {
    this.root = root; this.planId = planId; this.opts = opts;
    this.scale = 1; this.tx = 0; this.ty = 0; this.W = 1; this.H = 1; this.vw = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.tool = 'pan'; this.fitMode = 'page';
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
    this.titleEl = h('div', { class: 'v-title', title: 'לחצו לשינוי שם התוכנית' });
    this.titleEl.addEventListener('click', () => this.renameDialog());
    this.credit = h('div', { class: 'v-credit' }, 'נוצר על ידי דוד אורן');
    const btn = (ic, label, fn) => h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick: fn }, icon(ic));
    this.stage = h('div', { class: 'v-stage' });
    this.layerA = new Layer();
    this.layerB = new Layer();
    this.layerB.el.style.display = 'none';
    this.svg = svg('svg', { class: 'v-overlay', preserveAspectRatio: 'none' });
    this.gSearch = svg('g'); this.gItems = svg('g'); this.gDraft = svg('g'); this.gSel = svg('g');
    this.svg.append(this.gSearch, this.gItems, this.gDraft, this.gSel);
    this.loading = h('div', { class: 'v-loading' }, 'טוען תוכנית…');
    this.stage.append(this.layerA.el, this.layerB.el, this.svg, this.loading);

    this.topbar = h('header', { class: 'v-top' },
      btn('back', 'חזרה', () => this.goBack()),
      this.titleEl,
      btn('search', 'חיפוש בתוכנית', () => this.openPanel('search')),
      btn('grid', 'עמודים', () => this.openPanel('pages')),
      btn('layers', 'שכבות', () => this.layersDialog()),
      btn('compare', 'השוואת תוכניות', () => this.openCompare()),
      btn('clock', 'גרסאות', () => A.versionsDialog(this.planId, { onChange: () => this.afterVersionsChange() })),
      btn('print', 'הדפסה', () => this.printDialog()),
      btn('more', 'עוד', (e) => this.moreMenu(e.currentTarget)));
    // במסכים צרים מעבירים כפתורים משניים לתפריט ⋮ כדי שיישאר מקום לשם התוכנית
    this.topbar.querySelectorAll('[aria-label="שכבות"],[aria-label="השוואת תוכניות"],[aria-label="גרסאות"],[aria-label="הדפסה"]').forEach((b) => b.classList.add('nh'));

    this.zoomLabel = h('button', { class: 'zl', onclick: () => this.setZoom100() }, '100%');
    this.zoomBar = h('div', { class: 'v-zoom v-float' },
      btn('zoomIn', 'הגדל', () => this.zoomBy(1.6)),
      this.zoomLabel,
      btn('zoomOut', 'הקטן', () => this.zoomBy(1 / 1.6)),
      btn('maximize', 'התאמה למסך: עמוד שלם / רוחב / גובה (לחיצות חוזרות מחליפות)', () => this.cycleFit()));

    this.pageLabel = h('button', { class: 'pl', onclick: () => this.pagePrompt() }, '1 / 1');
    this.pageBar = h('div', { class: 'v-pages v-float' },
      btn('chevR', 'עמוד קודם', () => this.goPage(this.pageNum - 1)),
      this.pageLabel,
      btn('chevL', 'עמוד הבא', () => this.goPage(this.pageNum + 1)));

    this.props = h('div', { class: 'v-props' });
    this.toolbar = h('div', { class: 'v-tools' });
    this.buildToolbar();
    this.panel = h('aside', { class: 'v-panel hidden' });
    this.cmpBar = h('div', { class: 'v-cmp hidden' });
    this.pickBar = h('div', { class: 'v-pick hidden' });
    this.exitImm = h('button', { class: 'v-exit-imm', 'aria-label': 'הצג סרגלים', onclick: () => this.el.classList.remove('immersive') }, icon('chevD'));

    this.mid = h('div', { class: 'v-mid' }, this.stage, this.zoomBar, this.pageBar, this.panel, this.credit);
    this.el = h('div', { class: 'viewer' }, this.topbar, this.pickBar, this.mid,
      this.cmpBar, this.props, this.toolbar, this.exitImm);
    this.root.append(this.el);

    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this.onDown(e));
    s.addEventListener('pointermove', (e) => this.onMove(e));
    s.addEventListener('pointerup', (e) => this.onUp(e));
    s.addEventListener('pointercancel', (e) => this.onUp(e, true));
    s.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('dblclick', (e) => { if (this.tool === 'area' || this.tool === 'polyline') { e.preventDefault(); this.finishArea(); } });
    this.keyFn = (e) => this.onKey(e);
    this.keyUpFn = (e) => { if (e.code === 'Space') this.spaceDown = false; };
    document.addEventListener('keydown', this.keyFn);
    document.addEventListener('keyup', this.keyUpFn);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.stage);
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
    this.undoBtn = h('button', { class: 'tool', title: 'בטל', onclick: () => this.undo() }, icon('undo', 22), h('span', {}, 'בטל'));
    this.redoBtn = h('button', { class: 'tool', title: 'שחזר', onclick: () => this.redo() }, icon('redo', 22), h('span', {}, 'חזור'));
    this.toolbar.append(this.undoBtn, this.redoBtn);
    this.updateToolUI();
    this.updateUndo();
  }

  async init() {
    const plan = S.P.plans.get(this.planId);
    if (!plan) { UI.toast('התוכנית לא נמצאה', { type: 'error' }); location.hash = '#/f/'; return; }
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
    this.loading.textContent = 'טוען תוכנית…';
    const blob = await S.getFileBlob(vid);
    if (!blob || !ver || ver.broken) { this.showFallback(blob ? 'ה-Viewer הפנימי לא הצליח לפתוח את הקובץ הזה.' : 'הקובץ לא נמצא באחסון המקומי.'); return; }
    let doc;
    try { doc = await openPdf(blob, { interactive: true }); } catch (e) {
      console.error(e);
      this.showFallback(e?.name === 'PasswordException' ? 'הקובץ מוגן בסיסמה.' : 'ה-Viewer הפנימי לא הצליח לפתוח את הקובץ הזה.');
      return;
    }
    if (cur !== this) { destroyDoc(doc); return; }
    destroyDoc(this.doc);
    this.doc = doc; this.numPages = doc.numPages; this.textCache.clear();
    this.search = null;
    const [mk, ms, ln, cal] = await Promise.all(['markups', 'measurements', 'links', 'calibrations'].map((s) => db.byIndex(s, 'versionId', vid)));
    this.items = { markups: mk, measurements: ms, links: ln };
    this.calibs = new Map(cal.map((c) => [c.page, c]));
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
      icon('alert', 44), h('h3', {}, 'לא ניתן להציג את התוכנית'), h('p', {}, msg),
      h('p', { class: 'hint' }, 'הקובץ המקורי שמור ולא שונה. אפשר להוריד אותו או לפתוח אותו באפליקציית PDF אחרת.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => A.openWithDialog(this.plan, this.version?.id) }, icon('share', 18), 'פתח באמצעות…'),
        h('button', { class: 'btn', onclick: () => A.downloadVersion(this.version?.id, this.plan.name) }, icon('download', 18), 'הורד')));
    this.stage.append(box);
    this.updateTitle();
  }

  updateTitle() {
    const vs = S.versionsOf(this.planId);
    const v = this.version;
    const isCur = v && this.plan.currentVersionId === v.id;
    this.titleEl.replaceChildren(
      h('b', {}, this.plan.name, h('span', { class: 'ted' }, icon('edit', 13))),
      h('small', {}, [v && vs.length > 1 ? `V${v.number} · ${fmtDate(v.date)}` : null, v && !isCur ? 'גרסה ישנה' : null].filter(Boolean).join(' · ') || S.planPathText(this.plan)));
    this.titleEl.classList.toggle('old', !!(v && !isCur));
  }
  afterVersionsChange() {
    if (!S.P.plans.has(this.planId)) return;
    if (this.version && !S.P.versions.has(this.version.id)) { this.loadVersion(this.plan.currentVersionId, {}); return; }
    this.updateTitle();
  }

  goBack() {
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
    ty = ph <= this.H ? (this.H - ph) / 2 : clamp(ty, this.H - ph - M, M);
    return [tx, ty];
  }
  setView(scale, tx, ty, { keepFit = false } = {}) {
    if (!this.page) return;
    scale = clamp(scale, this.minScale(), MAXS);
    [tx, ty] = this.clampView(scale, tx, ty);
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
    const all = [['page', sp, 'כל העמוד במסך'], ['width', sw, 'התאמה לרוחב המסך'], ['height', sh, 'התאמה לגובה המסך']];
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
    if (token !== this.pageToken || cur !== this) return;
    this.pageNum = n; this.page = page;
    this.selected = null; this.draft = null; this.gesture = null; this.eraseSet = null;
    this.measure();
    this.layerA.setPage(page).then(() => { if (token === this.pageToken) this.loading.style.display = 'none'; });
    this.pw = this.layerA.pw; this.ph = this.layerA.ph;
    if (this.cmp) this.loadCompareLayer();
    const saved = lastView.get(`${this.version.id}:${n}`);
    if (view) this.applyView(view);
    else if (saved && !fresh) this.applyView(saved);
    else this.fit('page');
    lastView.set(this.version.id + ':last', n);
    this.renderItems(); this.renderProps(); this.updatePageUI();
    this.scheduleDetail(30);
    if (this.panelMode === 'pages') this.markThumb();
    if (this.search) this.renderSearchHits();
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
    const v = await UI.promptBox({ title: 'מעבר לעמוד', label: `מספר עמוד (1–${this.numPages})`, value: String(this.pageNum), okText: 'עבור' });
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
    this.ptrs.set(e.pointerId, pt);
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
    if (g && g.hold) clearTimeout(g.hold);
    if (g && g.type === 'erase') { this.eraseSet = null; this.renderItems(); }
    if (g && (g.type === 'drag' || g.type === 'pen' || g.type === 'seg')) this.draft = null;
    this.gesture = null;
    this.renderDraft();
  }
  startPinch() {
    const [a, b] = [...this.ptrs.values()];
    const sel = this.selected;
    if (sel && sel.type === 'text') { // צביטה על טקסט נבחר משנה את גודל הטקסט ולא את הזום
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
  onMove(e) {
    const pt = this.local(e);
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, pt);
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
      case 'drag': this.draft.pts[1] = p; this.renderDraft(); break;
      case 'pen': {
        if (g.snapped) { // אחרי זיהוי: קו ישר ממשיך לעקוב אחרי האצבע (עם הצמדה ל-0/45/90°)
          if (g.snap.type === 'line') { this.draft.pts[1] = snapAngle(this.draft.pts[0], p); this.renderDraft(); }
          break;
        }
        const last = this.draft.pts[this.draft.pts.length - 1];
        if (dist(last, p) * this.scale > 1.5) { this.draft.pts.push(p); this.renderDraft(); }
        if (Math.hypot(pt.x - g.anchor.x, pt.y - g.anchor.y) > 6) { g.anchor = { x: pt.x, y: pt.y }; this.armHold(g); }
        break;
      }
      case 'erase': this.eraseAt(g.last, p); g.last = p; break;
      case 'seg':
        if (Math.hypot(pt.x - g.sx, pt.y - g.sy) > 8) { g.moved = true; this.draft = { type: this.tool, pts: [g.p0, p] }; this.renderDraft(); }
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
    if ((t === 'measure' || t === 'area') && !this.calibs.get(this.pageNum)) { this.needCalibration(t); return; }
    if (this.draft) { this.draft = null; this.renderDraft(); }
    this.tool = t;
    if (t !== 'select') this.select(null, true);
    this.updateToolUI(); this.renderProps();
  }
  updateToolUI() {
    Object.entries(this.toolBtns).forEach(([id, b]) => b.classList.toggle('on', id === this.tool));
    this.stage.dataset.tool = this.tool;
  }
  toolDown(pt, e) {
    const p = this.toPage(pt);
    const base = { id: e.pointerId, sx: pt.x, sy: pt.y, moved: false };
    switch (this.tool) {
      case 'select': {
        const hd = this.selected && this.hitHandle(p);
        if (hd) { this.gesture = { ...base, type: 'handle', idx: hd.idx, before: clone(this.selected) }; return; }
        const it = this.hit(p);
        if (it) { this.select(it); this.gesture = { ...base, type: 'move', p0: p, before: clone(it) }; return; }
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
      for (const it of this.items[l]) if (it.page === this.pageNum) out.push(it);
    }
    return out;
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
      const node = drawItem(it, cx);
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
    this.gDraft.append(drawItem({ ...it, pts }, this.ctx()));
    if (isPoly) d.pts.forEach((q) => this.gDraft.append(svg('circle', { cx: q.x, cy: q.y, r: 5 / sc, fill: '#fff', stroke: '#d81b60', 'stroke-width': 2 / sc })));
  }
  newItem(d, preview = false) {
    const sc = this.scale;
    const type = d.type;
    const it = {
      id: preview ? 'draft' : uid(), versionId: this.version.id, planId: this.planId, page: this.pageNum, type, layer: LAYER_OF[type],
      pts: d.pts.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })), created: Date.now(),
    };
    const kind = kindOf(type);
    if (kind === 'text') {
      it.color = prefs.tcolor; it.op = prefs.top; it.text = d.text || ''; it.fontSize = prefs.tsize / sc; it.width = 1 / sc;
    } else if (kind === 'hl') {
      it.color = prefs.hcolor; it.fillOp = prefs.hop; it.width = 1 / sc;
    } else if (kind === 'shape') {
      it.color = prefs.color; it.width = prefs.w / sc; it.op = prefs.op;
      if (!d.fromPen && (type === 'rect' || type === 'ellipse')) { it.fill = prefs.fill; it.fillOp = prefs.fillOp; }
      if (type === 'polyline') { it.fontSize = 14 / sc; if (d.closed) it.closed = true; }
    }
    if (type === 'measure' || type === 'area') { it.color = '#d81b60'; it.width = 2.5 / sc; it.fontSize = 15 / sc; }
    if (type === 'link') { it.color = '#1d4e89'; it.width = 2 / sc; it.fontSize = 14 / sc; }
    return it;
  }
  async commitNew(d) {
    if (d.type === 'calibrate') { this.calibrateFromPoints(d.pts); return; }
    if (d.type === 'link') { await this.createLink(d); return; }
    await this.addItem(this.newItem(d));
    this.renderDraft(); this.renderProps();
  }
  async addItem(it) {
    await db.put(it.layer, it);
    this.items[it.layer].push(it);
    this.history.push({ before: null, after: clone(it) });
    this.redoStack = [];
    this.updateUndo(); this.renderItems();
  }
  async commitMod(before, after) {
    const a = clone(after);
    if (a.type === 'text' && before.fontSize !== a.fontSize) { prefs.tsize = Math.max(8, Math.round(a.fontSize * this.scale)); savePrefs(); }
    await db.put(a.layer, a);
    this.history.push({ before: clone(before), after: a });
    this.redoStack = [];
    this.updateUndo(); this.renderItems();
  }
  async setItemState(from, to) {
    const src = to || from;
    const arr = this.items[src.layer];
    const i = arr.findIndex((x) => x.id === src.id);
    if (!to) { if (i >= 0) arr.splice(i, 1); await db.del(src.layer, src.id); if (this.selected?.id === src.id) this.selected = null; }
    else { const c = clone(to); if (i >= 0) arr[i] = c; else arr.push(c); await db.put(src.layer, c); if (this.selected?.id === c.id) this.selected = c; }
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
    this.selected = null;
    await this.setItemState(it, null);
    this.history.push({ before: clone(it), after: null });
    this.redoStack = [];
    this.updateUndo(); this.renderProps();
  }
  async modifySelected(mut) {
    const it = this.selected; if (!it) return;
    const before = clone(it);
    mut(it);
    await this.commitMod(before, it);
    this.renderProps();
  }

  // ---------- טקסט ושטח ----------
  async placeText(p) {
    const v = await UI.promptBox({ title: 'טקסט על התוכנית', multiline: true, placeholder: 'הקלד הערה…', okText: 'הוסף' });
    if (!v) return;
    const it = this.newItem({ type: 'text', pts: [p], text: v });
    await this.addItem(it);
    // עוברים לבחירה: אפשר מיד לשנות גודל (צביטה, ידית בפינה או מספר), צבע ושקיפות
    this.tool = 'select'; this.updateToolUI(); this.select(it);
    if (!prefs.tipText) { prefs.tipText = 1; savePrefs(); UI.toast('לשינוי גודל: צביטה עם שתי אצבעות על הטקסט, גרירת העיגול בפינה, או מספר בסרגל', { ms: 5000 }); }
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
    if (!d || d.pts.length < need) { UI.toast(need === 2 ? 'קו דורש לפחות 2 נקודות' : 'שטח דורש לפחות 3 נקודות'); return; }
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
      if (!g.hintShown) { g.hintShown = true; UI.toast('לא זוהתה צורה – שחררו כרגיל כדי לשמור את הקו החופשי', { ms: 2200 }); }
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
      for (const it of list) if (!this.eraseSet.has(it.id) && hitItem(it, q, tol)) { this.eraseSet.add(it.id); changed = true; }
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
    UI.toast(entries.length === 1 ? 'נמחק פריט אחד (אפשר לבטל)' : `נמחקו ${entries.length} פריטים (אפשר לבטל)`, { ms: 1800 });
  }

  // ---------- כיול ומדידה ----------
  async needCalibration(nextTool) {
    const ok = await UI.confirmBox('כדי למדוד צריך להגדיר סקאלה לעמוד הזה. האפליקציה לא מנחשת מידות – בחרו סקאלה (למשל 1:100) או כיילו לפי מרחק ידוע בתוכנית.', { title: 'נדרש כיול', okText: 'הגדר סקאלה' });
    if (ok) this.calibrateDialog(nextTool);
  }
  async calibrateDialog(nextTool) {
    if (!this.page) return;
    const cal = this.calibs.get(this.pageNum);
    const paper = paperName(this.pw, this.ph);
    const wmm = Math.round((this.pw * 25.4) / 72), hmm = Math.round((this.ph * 25.4) / 72);
    const ratio = h('input', { type: 'number', min: 1, step: 1, value: cal?.ratio || '', placeholder: '100', inputMode: 'numeric' });
    const all = h('input', { type: 'checkbox' });
    const cands = h('div', { class: 'row wrap' });
    let m;
    const applyRatio = async (n) => {
      if (!(n >= 1)) { UI.toast('הזן מספר גדול מ-0', { type: 'error' }); return; }
      const pages = all.checked ? Array.from({ length: this.numPages }, (_, i) => i + 1) : [this.pageNum];
      for (const pg of pages) {
        const c = { id: `${this.version.id}:${pg}`, versionId: this.version.id, page: pg, mpu: mpuFromRatio(n), source: 'ratio', ratio: n };
        await db.put('calibrations', c); this.calibs.set(pg, c);
      }
      this.renderItems(); this.renderProps();
      UI.toast(`הוגדרה סקאלה 1:${n}`);
      m.close(); if (nextTool) this.setTool(nextTool);
    };
    const status = cal
      ? h('p', { class: 'ok' }, cal.source === 'ratio' ? `סקאלה נוכחית לעמוד: 1:${cal.ratio}` : 'העמוד כויל ידנית לפי מרחק ידוע.')
      : h('p', { class: 'warn' }, 'לעמוד הזה עדיין אין כיול – מדידות לא יוצגו.');
    const body = h('div', { class: 'stack' }, status,
      h('h4', {}, '1. סקאלה מהתוכנית'),
      h('p', { class: 'hint' }, `גודל העמוד בקובץ: ${wmm}×${hmm} מ״מ${paper ? ` (${paper})` : ' (לא גודל נייר סטנדרטי)'}. סקאלה 1:N מדויקת רק אם ה-PDF נשמר בגודל הדף המקורי, ללא הקטנה. אם יש ספק – השתמשו בכיול ידני.`),
      h('div', { class: 'row' }, h('span', {}, '1 :'), ratio, h('button', { class: 'btn primary', onclick: () => applyRatio(parseFloat(ratio.value)) }, 'החל')),
      cands,
      h('label', { class: 'check' }, all, 'החל על כל עמודי הקובץ'),
      h('h4', {}, '2. כיול ידני'),
      h('p', { class: 'hint' }, 'סמנו שתי נקודות בתוכנית שהמרחק ביניהן ידוע (למשל מידה כתובה), ואז הזינו את המרחק האמיתי.'),
      h('button', { class: 'btn', onclick: () => { m.close(); this.startCalibrateTool(all.checked, nextTool); } }, icon('ruler', 18), 'סמן שתי נקודות'),
      cal ? h('button', { class: 'btn danger', onclick: async () => { await db.del('calibrations', cal.id); this.calibs.delete(this.pageNum); this.renderItems(); this.renderProps(); m.close(); } }, 'אפס כיול בעמוד') : null);
    m = UI.openModal({ title: 'סקאלה וכיול', body, buttons: [{ text: 'סגור', value: true }] });
    try { // הצעה בלבד: סקאלה שנמצאה בטקסט העמוד – חובה לאמת מול התוכנית
      const txt = await pageText(this.page);
      const found = new Set();
      for (const mm of txt.matchAll(/(?:^|[^\d:])1\s*[:：]\s*(\d{1,4})(?!\d)/g)) { const n = +mm[1]; if (n >= 2 && n <= 5000) found.add(n); }
      if (found.size) {
        cands.append(h('span', { class: 'hint' }, 'נמצא בטקסט של העמוד (יש לאמת מול התוכנית):'));
        [...found].slice(0, 5).forEach((n) => cands.append(h('button', { class: 'btn sm', onclick: () => applyRatio(n) }, `1:${n}`)));
      }
    } catch { /* ignore */ }
  }
  startCalibrateTool(applyAll, nextTool) {
    this.calibAll = applyAll; this.calibNext = nextTool;
    this.tool = 'calibrate'; this.draft = null;
    this.updateToolUI(); this.renderProps();
    UI.toast('סמנו שתי נקודות עם מרחק ידוע', { ms: 4000 });
  }
  async calibrateFromPoints(pts) {
    this.draft = null; this.renderDraft();
    const len = dist(pts[0], pts[1]);
    const val = h('input', { type: 'number', step: 'any', min: 0, placeholder: 'לדוגמה 3.5', inputMode: 'decimal', autofocus: true });
    const unit = h('select', {}, h('option', { value: 'm' }, 'מטר'), h('option', { value: 'cm' }, 'ס״מ'), h('option', { value: 'mm' }, 'מ״מ'));
    unit.value = prefs.unit;
    const r = await UI.modal({
      title: 'המרחק האמיתי בין שתי הנקודות', body: h('div', { class: 'form' }, h('div', { class: 'row' }, val, unit)),
      buttons: [{ text: 'ביטול', value: false }, { text: 'כייל', kind: 'primary', value: true }],
    });
    this.tool = 'pan'; this.updateToolUI();
    if (!r) { this.renderProps(); return; }
    const d = parseFloat(val.value);
    if (!(d > 0) || !(len > 0)) { UI.toast('מרחק לא תקין', { type: 'error' }); this.renderProps(); return; }
    const meters = unit.value === 'm' ? d : unit.value === 'cm' ? d / 100 : d / 1000;
    const pages = this.calibAll ? Array.from({ length: this.numPages }, (_, i) => i + 1) : [this.pageNum];
    for (const pg of pages) {
      const c = { id: `${this.version.id}:${pg}`, versionId: this.version.id, page: pg, mpu: meters / len, source: 'manual' };
      await db.put('calibrations', c); this.calibs.set(pg, c);
    }
    UI.toast('הכיול נשמר');
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
    if (res.pick) this.beginPick(it);
  }
  async linkDialog(existing) {
    let plan = existing ? S.P.plans.get(existing.target.planId) : null;
    if (!plan) plan = await UI.planPicker({ title: 'לאן הקישור יוביל?' });
    if (!plan) return null;
    const ver = S.curVer(plan);
    const page = h('input', { type: 'number', min: 1, max: ver?.pageCount || 999, value: existing?.target?.page || 1, inputMode: 'numeric' });
    const r = await UI.modal({
      title: 'קישור אל: ' + plan.name,
      body: h('div', { class: 'form' }, h('label', {}, `עמוד ביעד (1–${ver?.pageCount || '?'})`), page,
        h('p', { class: 'hint' }, 'אפשר גם לקבוע מיקום והגדלה מדויקים ביעד: בחרו "שמור וקבע מיקום ביעד".')),
      buttons: [
        { text: 'ביטול', value: null },
        { text: 'שמור', kind: 'primary', value: 'save' },
        { text: 'שמור וקבע מיקום ביעד', value: 'pick' },
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
      h('span', {}, 'הזיזו והגדילו לתצוגה הרצויה ליעד הקישור, ואז לחצו "קבע כיעד"'),
      h('button', { class: 'btn sm primary', onclick: () => this.confirmPick() }, 'קבע כיעד'),
      h('button', { class: 'btn sm', onclick: () => { const c = pickCtx; pickCtx = null; location.hash = c.returnHash; } }, 'ביטול'));
  }
  async confirmPick() {
    const c = pickCtx; if (!c) return;
    const link = await db.get('links', c.linkId);
    if (link) {
      link.target = { ...link.target, planId: this.planId, page: this.pageNum, view: this.viewCenter() };
      await db.put('links', link);
    }
    pickCtx = null;
    UI.toast('מיקום היעד נשמר');
    location.hash = c.returnHash;
  }
  followLink(l) {
    const t = l.target;
    const plan = t && S.P.plans.get(t.planId);
    if (!plan) { UI.toast('יעד הקישור נמחק', { type: 'error' }); return; }
    const q = new URLSearchParams();
    q.set('page', t.page || 1);
    if (t.view) { q.set('x', t.view.cx.toFixed(2)); q.set('y', t.view.cy.toFixed(2)); q.set('z', t.view.scale.toFixed(4)); }
    location.hash = `#/p/${plan.id}?${q}`;
  }

  // ---------- לוחות צד: עמודים וחיפוש ----------
  openPanel(mode) {
    if (this.panelMode === mode && !this.panel.classList.contains('hidden')) { this.closePanel(); return; }
    this.panelMode = mode;
    this.panel.classList.remove('hidden');
    this.panel.textContent = '';
    const close = h('button', { class: 'icon-btn', 'aria-label': 'סגור', onclick: () => this.closePanel() }, icon('x'));
    if (mode === 'pages') {
      this.panel.append(h('div', { class: 'pn-head' }, h('b', {}, 'עמודים'), close));
      this.thumbList = h('div', { class: 'thumb-list' });
      this.panel.append(this.thumbList);
      this.buildThumbs();
    } else {
      this.searchInput = h('input', { type: 'search', placeholder: 'חיפוש טקסט בתוכנית…', enterKeyHint: 'search', value: this.search?.q || '' });
      this.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.runSearch(this.searchInput.value, true); });
      this.searchInfo = h('div', { class: 'hint' });
      this.searchList = h('div', { class: 'result-list compact' });
      this.panel.append(h('div', { class: 'pn-head' }, h('b', {}, 'חיפוש בתוכנית'), close),
        h('div', { class: 'pn-search' }, this.searchInput,
          h('button', { class: 'icon-btn', onclick: () => this.gotoMatch(this.search ? this.search.idx - 1 : 0), 'aria-label': 'הקודם' }, icon('chevU')),
          h('button', { class: 'icon-btn', onclick: () => this.gotoMatch(this.search ? this.search.idx + 1 : 0), 'aria-label': 'הבא' }, icon('chevD'))),
        this.searchInfo, this.searchList);
      if (this.search) this.renderSearchList();
      setTimeout(() => this.searchInput.focus(), 50);
    }
    this.el.classList.add('panel-open');
  }
  closePanel() {
    this.panel.classList.add('hidden');
    this.panelMode = null;
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
    const vp = page.getViewport({ scale: 1 });
    let text = '';
    const ranges = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      ranges.push({ start: text.length, end: text.length + it.str.length, it });
      text += it.str + (it.hasEOL ? ' ' : '');
    }
    const rects = (s, e) => {
      const out = [];
      for (const r of ranges) {
        if (r.end <= s || r.start >= e || !r.it.str.length) continue;
        const a = Math.max(s - r.start, 0), b = Math.min(e - r.start, r.it.str.length);
        const t = r.it.transform, len = r.it.str.length;
        const x0 = t[4] + r.it.width * (a / len), w = r.it.width * ((b - a) / len);
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
    if (this.searchInput) this.searchInput.value = q;
    const token = ++this.searchToken;
    const s = { q, matches: [], idx: -1 };
    this.search = s;
    this.searchList?.replaceChildren();
    const ql = q.toLowerCase();
    for (let i = 1; i <= this.numPages; i++) {
      if (token !== this.searchToken || cur !== this) return;
      if (this.searchInfo) this.searchInfo.textContent = `מחפש… עמוד ${i} מתוך ${this.numPages}`;
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
    if (this.searchInfo) this.searchInfo.textContent = s.matches.length ? `${s.matches.length} תוצאות` : 'לא נמצא טקסט תואם. (אם הקובץ סרוק כתמונה – אין בו טקסט לחיפוש, ו-OCR עדיין לא נתמך.)';
    if (jump && s.matches.length) {
      const first = s.matches.findIndex((m) => m.page >= this.pageNum);
      this.gotoMatch(first >= 0 ? first : 0);
    }
  }
  renderSearchList() {
    const s = this.search;
    if (!s || !this.searchList) return;
    this.searchList.replaceChildren(...s.matches.slice(0, 200).map((m, i) => h('button', { class: 'result' + (i === s.idx ? ' cur' : ''), onclick: () => this.gotoMatch(i) },
      h('span', { class: 'col' }, h('b', {}, `עמוד ${m.page}`), h('span', { class: 'snip' }, m.snippet)))));
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
    this.renderSearchHits(); this.renderSearchList();
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

  // ---------- השוואה ----------
  async openCompare(preVid) {
    if (this.cmpUI) { if (preVid) { this.cmpUI.setVersion(preVid); this.cmpUI.apply(); } return; }
    if (!this.doc) return;
    const planSel = h('select', {}), verSel = h('select', {});
    const plans = [...S.P.plans.values()].sort((a, b) => natural(S.planPathText(a) + a.name, S.planPathText(b) + b.name));
    plans.forEach((p) => planSel.append(h('option', { value: p.id }, p.id === this.planId ? `${p.name} (התוכנית הזו)` : `${p.name} — ${S.planPathText(p)}`)));
    const fillVers = (sel) => {
      verSel.textContent = '';
      S.versionsOf(planSel.value).forEach((v) => verSel.append(h('option', { value: v.id }, `V${v.number} – ${fmtDate(v.date)}${v.id === this.version.id ? ' (הפתוחה)' : ''}${S.P.plans.get(v.planId)?.currentVersionId === v.id ? ' · נוכחית' : ''}`)));
      if (sel) verSel.value = sel;
    };
    const setVersion = (vid) => { const v = S.P.versions.get(vid); if (!v) return; planSel.value = v.planId; fillVers(vid); };
    planSel.value = this.planId; fillVers();
    const other = S.versionsOf(this.planId).find((v) => v.id !== this.version.id);
    if (other) verSel.value = other.id;
    planSel.onchange = () => fillVers();
    const pageIn = h('input', { type: 'number', min: 1, value: this.pageNum, inputMode: 'numeric', class: 'num' });
    const modeSel = h('select', {}, h('option', { value: 'diff' }, 'הבדלים (צבעים)'), h('option', { value: 'overlay' }, 'שקיפות'), h('option', { value: 'split' }, 'זו לצד זו'));
    const op = h('input', { type: 'range', min: 0, max: 100, value: 50 });
    const legend = h('div', { class: 'cmp-legend' });
    const apply = async () => {
      const vid = verSel.value;
      if (!vid) return;
      legend.textContent = 'טוען…';
      try { await this.startCompare(vid, parseInt(pageIn.value, 10) || 1, modeSel.value, op.value / 100); } catch (e) { console.error(e); UI.toast('לא ניתן לטעון את התוכנית להשוואה', { type: 'error' }); legend.textContent = ''; return; }
      this.updateCmpLegend(legend);
    };
    modeSel.onchange = () => { if (this.cmp) { this.setCompareMode(modeSel.value, op.value / 100); this.updateCmpLegend(legend); } };
    op.oninput = () => { if (this.cmp) { this.cmp.opacity = op.value / 100; if (this.cmp.mode === 'overlay') this.layerB.el.style.opacity = op.value / 100; } };
    const nudge = (dx, dy) => { if (!this.cmp) return; const st = 1.5 / this.scale; this.layerB.dx += dx * st; this.layerB.dy += dy * st; this.layerB.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(200); };
    const nb = (ic, fn, label) => h('button', { class: 'icon-btn sm', 'aria-label': label, onclick: fn }, icon(ic, 18));
    const alignBtn = h('button', { class: 'btn sm', onclick: () => { this.alignDrag = !this.alignDrag; alignBtn.classList.toggle('primary', this.alignDrag); if (this.alignDrag) UI.toast('בכלי ההזזה: גררו את המסך כדי להזיז את התוכנית להשוואה'); } }, 'גרור ליישור');
    const sc = (f) => { if (!this.cmp) return; this.layerB.s *= f; this.layerB.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(200); };
    this.cmpBar.replaceChildren(
      h('div', { class: 'cmp-row' }, h('b', {}, 'השוואה עם:'), planSel, verSel, h('span', {}, 'עמוד'), pageIn, modeSel,
        h('button', { class: 'btn sm primary', onclick: apply }, 'השווה'), h('button', { class: 'icon-btn sm', 'aria-label': 'סגור השוואה', onclick: () => this.closeCompare() }, icon('x', 18))),
      h('div', { class: 'cmp-row' }, h('span', {}, 'שקיפות'), op, h('span', { class: 'sp' }), h('span', {}, 'יישור:'),
        nb('chevU', () => nudge(0, -1), 'למעלה'), nb('chevD', () => nudge(0, 1), 'למטה'), nb('chevR', () => nudge(1, 0), 'ימינה'), nb('chevL', () => nudge(-1, 0), 'שמאלה'),
        h('button', { class: 'btn sm', onclick: () => sc(1.002) }, 'הגדל'), h('button', { class: 'btn sm', onclick: () => sc(1 / 1.002) }, 'הקטן'),
        alignBtn,
        h('button', { class: 'btn sm', onclick: () => { if (!this.cmp) return; this.layerB.dx = this.layerB.dy = 0; this.layerB.s = this.cmp.baseS; this.layerB.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(50); } }, 'אפס יישור')),
      legend);
    this.cmpBar.classList.remove('hidden');
    this.el.classList.add('cmp-open');
    this.cmpUI = { setVersion, apply };
    if (preVid) { setVersion(preVid); apply(); }
  }
  updateCmpLegend(el) {
    const mode = this.cmp?.mode;
    el.replaceChildren(h('small', {},
      mode === 'diff' ? 'אדום = קיים רק בתוכנית הפתוחה · כחול = קיים רק בתוכנית להשוואה · שחור = זהה. ' : mode === 'overlay' ? 'התוכנית להשוואה מונחת מעל הפתוחה בשקיפות שנבחרה. ' : 'שתי התוכניות זו לצד זו עם זום והזזה משותפים. ',
      'זו השוואה חזותית בלבד – לא זיהוי אוטומטי של שינויים, והיא אמינה רק כשהתוכניות מיושרות.',
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
    if (Math.abs(r - 1) > 0.01) { this.layerB.s = r; this.cmp.baseS = r; this.cmp.sizeNote = 'גודל העמודים שונה – הותאם לפי הרוחב, כדאי לוודא יישור.'; } else { this.layerB.s = 1; this.cmp.baseS = 1; }
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
    UI.modal({
      title: 'שכבות תצוגה',
      body: h('div', { class: 'stack' }, mk('markups', 'סימונים (חצים, קווים, טקסט…)'), mk('measurements', 'מדידות'), mk('links', 'קישורים בין תוכניות'),
        h('p', { class: 'hint' }, 'הסימונים, המדידות והקישורים נשמרים בנפרד מקובץ ה-PDF ואינם משנים אותו.')),
      buttons: [{ text: 'סגור', kind: 'primary', value: true }],
    });
  }
  moreMenu(anchor) {
    UI.menu(anchor, [
      { label: 'גרסאות', icon: 'clock', onClick: () => A.versionsDialog(this.planId, { onChange: () => this.afterVersionsChange() }) },
      { label: 'השוואת תוכניות', icon: 'compare', onClick: () => this.openCompare() },
      { label: 'שכבות (הצגה/הסתרה)', icon: 'layers', onClick: () => this.layersDialog() },
      { divider: true },
      { label: 'הדפסה / שמירה כ-PDF עם הסימונים', icon: 'print', onClick: () => this.printDialog() },
      { label: 'שנה שם תוכנית', icon: 'edit', onClick: () => this.renameDialog() },
      { label: 'פתח באמצעות / שתף', icon: 'share', onClick: () => A.openWithDialog(this.plan, this.version?.id) },
      { label: 'הורד PDF מקורי', icon: 'download', onClick: () => A.downloadVersion(this.version?.id, this.plan.name) },
      { label: 'סקאלה וכיול לעמוד', icon: 'ruler', onClick: () => this.calibrateDialog() },
      { label: 'מסך מלא', icon: 'maximize', onClick: () => this.toggleFullscreen() },
      { label: 'מצב תצוגה נקי (הסתר סרגלים)', icon: 'eye', onClick: () => this.el.classList.add('immersive') },
      { label: 'פרטי תוכנית', icon: 'info', onClick: () => A.planInfoDialog(this.planId) },
      { divider: true },
      { label: 'מחק את כל הסימונים בעמוד', icon: 'trash', danger: true, onClick: () => this.clearPage() },
    ]);
  }
  async clearPage() {
    const list = this.items.markups.filter((i) => i.page === this.pageNum);
    if (!list.length) { UI.toast('אין סימונים בעמוד'); return; }
    if (!(await UI.confirmBox(`למחוק ${list.length} סימונים בעמוד ${this.pageNum}? (מדידות וקישורים לא יימחקו)`, { danger: true, okText: 'מחק' }))) return;
    const entries = list.map((it) => ({ before: clone(it), after: null }));
    for (const e of entries) await this.setItemState(e.before, null);
    this.history.push({ multi: entries });
    this.redoStack = [];
    this.updateUndo();
  }
  toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (this.el.requestFullscreen) this.el.requestFullscreen().catch(() => UI.toast('לא ניתן לעבור למסך מלא'));
    else UI.toast('הדפדפן במכשיר הזה לא תומך במסך מלא. באפליקציה המותקנת המסך כבר מלא; אפשר להשתמש גם ב"מצב תצוגה נקי".', { ms: 5000 });
  }

  async destroy() {
    this.storeView();
    clearTimeout(this.dt);
    document.removeEventListener('keydown', this.keyFn);
    document.removeEventListener('keyup', this.keyUpFn);
    this.ro?.disconnect();
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
