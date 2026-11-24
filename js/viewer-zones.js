// השוואת תוכניות: יישור לפי אזורים, יעד היישור (כללי / אזור), היסטוריית ביטול-שחזור ליישור, ותצוגה מקדימה בזמן הזזה של תוכנית אחת.
//
// רעיון האזורים: לפעמים קנה המידה באזור אחד של התוכנית שונה מאזור אחר (למשל כשמישהו הקטין חלק מהגיליון).
// אי אפשר ליישר הכול ביחד עם הזזה/גודל אחד. לכן מסמנים אזור (מלבן או צורה חופשית) על התוכנית הפתוחה, ולאזור הזה יש יישור משלו
// של תוכנית ההשוואה. מחוץ לאזורים משתמשים ביישור הכללי. התוכנית הפתוחה נשארת שלמה, ולכן לא רואים חיתוכים.
// הצורה של האזור נשמרת בקואורדינטות העמוד המקורי (כמו כל הסימונים), ויישור האזור הוא (s, dx, dy) באותן יחידות של layerB.
import { t as tr } from './i18n.js';
import * as UI from './ui.js';
import { h, icon } from './util.js';
import { svg } from './markup.js';
import { Layer } from './layer.js';

let COARSE = false; try { COARSE = matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
let zseq = 0;
const MAX_ZONES = COARSE ? 3 : 6;
const CHANGE_MODES = new Set(['changes', 'sidechanges', 'blink']);

// חיתוך מצולע במלבן (Sutherland–Hodgman)
function clipPoly(pts, x0, y0, x1, y1) {
  const edges = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]],
  ];
  let out = pts;
  for (const [inside, cross] of edges) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length], ia = inside(a), ib = inside(b);
      if (ia) { out.push(a); if (!ib) out.push(cross(a, b)); } else if (ib) out.push(cross(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

export function installZones(V) {
  Object.assign(V.prototype, {
    // ---------- יעד היישור: 'g' = יישור כללי, אחרת מזהה אזור ----------
    cmpZones() { return (this.cmp && this.cmp.zones) || []; },
    cmpTargetZone() { const id = this.cmpTgt; if (!id || id === 'g') return null; return this.cmpZones().find((z) => z.id === id && z.layer) || null; },
    cmpTargetLayer() { const z = this.cmpTargetZone(); if (z) return z.layer; this.cmpTgt = 'g'; return this.layerB; },
    setCmpTarget(id) {
      this.cmpTgt = id || 'g';
      if (!this.cmpTargetZone()) this.cmpTgt = 'g';
      this.zonesUI?.(); this.cmpUI?.refresh?.(); this.renderCmpEdits();
    },

    // ---------- היסטוריה של יישור ----------
    alSnap() {
      const z = this.cmpTargetZone(), L = z ? z.layer : this.layerB;
      return { t: z ? z.id : 'g', s: L.s, dx: L.dx, dy: L.dy, rot: L.rot, rotB: this.cmp ? this.cmp.rotB : 0 };
    },
    alBegin() { if (!this._alB && this.cmp && this.layerB.page) this._alB = this.alSnap(); },
    alEnd(merge = false) {
      const b = this._alB; this._alB = null;
      const c = this.cmp; if (!b || !c) return;
      const a = this.alSnap();
      if (a.t !== b.t || (a.s === b.s && a.dx === b.dx && a.dy === b.dy && a.rot === b.rot)) return;
      const last = c.hist[c.hist.length - 1], now = performance.now();
      if (merge && last && last.k === 'al' && last.b.t === b.t && now - (last._t || 0) < 900) { last.a = a; last._t = now; } else c.hist.push({ k: 'al', b, a, _t: now });
      c.redo = []; c.alN = (c.alN || 0) + 1;
      this.updateUndo(); this.cmpUndoUI?.();
    },
    // מבצע פעולה שמשנה יישור ושומר אותה בהיסטוריה (ביטול/שחזור)
    alDo(fn, merge = false) { this.alBegin(); try { return fn(); } finally { this.alEnd(merge); } },
    async alApply(sn) {
      const c = this.cmp; if (!c) return;
      const z = sn.t === 'g' ? null : c.zones.find((q) => q.id === sn.t);
      const L = z ? z.layer : this.layerB;
      if (!L || !L.page) return;
      if (L.rot !== sn.rot) { L.rot = sn.rot; await L.setPage(L.page); }
      if (!z) c.rotB = sn.rotB;
      L.s = sn.s; L.dx = sn.dx; L.dy = sn.dy;
      if (z) { z.s = sn.s; z.dx = sn.dx; z.dy = sn.dy; z.rot = sn.rot; }
      L.place(this.scale, this.tx, this.ty, this.dpr);
      L.removeDetail(); this.scheduleDetail(40);
      this.cmpUI?.refresh?.();
    },

    // ---------- תצוגה בזמן הזזה של תוכנית אחת ----------
    // במצבי "הדגשת שינויים" / "הבהוב" תוכנית ההשוואה מוסתרת. בזמן גרירה מציגים את שתי התוכניות בצבעים (ישנה כחולה, חדשה אדומה), ובעזיבה מחשבים מחדש.
    startAlignPreview() {
      const c = this.cmp; if (!c || this._alPrev) return;
      if (c.mode === 'changes' || c.mode === 'blink') {
        this._alPrev = true; this.stopBlink();
        (this.chEls || []).forEach((e) => { e.style.display = 'none'; });
        this.cmpApplyLayerStyles(true);
      }
    },
    endAlignPreview() {
      if (!this._alPrev) return;
      this._alPrev = false;
      this.cmpApplyLayerStyles(false);
    },

    // ---------- סגנון השכבות לפי המצב (צבעים, מיזוג, אזורים) ----------
    cmpApplyLayerStyles(preview = false) {
      const c = this.cmp; if (!c) return;
      const mode = c.mode, diff = mode === 'diff' || preview;
      const showB = !(mode === 'changes' || mode === 'blink') || preview;
      const op = preview ? 1 : (mode === 'overlay' || mode === 'diff' ? c.opacity : 1);
      const st = this.cmpSet;
      this.layerA.setCssTint(diff ? st.colA : null);
      const sty = (L, on) => {
        L.setCssTint(diff ? st.colB : null);
        const e = L.el.style;
        e.display = on ? '' : 'none'; e.isolation = 'isolate';
        e.mixBlendMode = diff ? 'multiply' : 'normal'; e.opacity = op;
      };
      sty(this.layerB, showB);
      const zonesOn = c.zonesOn !== false;
      for (const z of c.zones || []) if (z.layer) sty(z.layer, showB && zonesOn);
      this.updateZoneClips();
    },

    // ---------- גיאומטריה ----------
    // קודקודי האזור בפיקסלי הבמה (בתוך אלמנט השכבה)
    zonePolyStage(z) {
      const sx = this.split ? (this.layerB.sx || 0) : 0;
      return z.pts.map((p) => { const d = this.o2d(p.x, p.y); return [this.tx + sx + d.x * this.scale, this.ty + d.y * this.scale]; });
    },
    updateZoneClips() {
      const c = this.cmp, B = this.layerB.el;
      if (!c) return;
      const on = c.zonesOn !== false, polys = [];
      const X0 = this.split ? (this.layerB.sx || 0) : 0, X1 = this.W, Y0 = 0, Y1 = this.H;
      for (const z of c.zones || []) {
        if (!z.layer) continue;
        z.layer.sx = this.split ? this.vw : 0;
        const cl = on ? clipPoly(this.zonePolyStage(z), X0, Y0, X1, Y1) : [];
        z._clip = cl.length >= 3 ? cl : null;
        if (z._clip) { polys.push(z._clip); z.layer.el.style.clipPath = 'polygon(' + z._clip.map((q) => `${q[0].toFixed(1)}px ${q[1].toFixed(1)}px`).join(',') + ')'; } else z.layer.el.style.clipPath = 'inset(100%)';
      }
      if (polys.length) {
        const d = `M${X0} ${Y0}H${X1}V${Y1}H${X0}Z` + polys.map((p) => 'M' + p.map((q) => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('L') + 'Z').join('');
        B.style.clipPath = `path(evenodd,"${d}")`;
      } else B.style.clipPath = this.split ? `inset(0 0 0 ${this.vw}px)` : '';
    },
    placeZones() {
      const c = this.cmp; if (!c || !c.zones || !c.zones.length) return;
      for (const z of c.zones) if (z.layer) { z.layer.sx = this.split ? this.vw : 0; z.layer.place(this.scale, this.tx, this.ty, this.dpr); }
      this.updateZoneClips();
    },
    // פירוט (חד) של האזורים: רק במלבן שמכסה את האזור, כדי לא לבזבז זיכרון
    renderZoneDetails() {
      const c = this.cmp; if (!c || !c.zones) return;
      const { scale, tx, ty, dpr } = this;
      const showB = !(CHANGE_MODES.has(c.mode) && c.mode !== 'sidechanges');
      for (const z of c.zones) {
        if (!z.layer) continue;
        if (!showB || !z._clip || c.zonesOn === false || CHANGE_MODES.has(c.mode)) { z.layer.removeDetail(); continue; }
        const xs = z._clip.map((q) => q[0]), ys = z._clip.map((q) => q[1]);
        const x0 = Math.floor(Math.min(...xs)) - 2, y0 = Math.floor(Math.min(...ys)) - 2, x1 = Math.ceil(Math.max(...xs)) + 2, y1 = Math.ceil(Math.max(...ys)) + 2;
        z.layer.renderDetail(scale, tx, ty, this.W, this.H, dpr, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    },

    // ---------- יצירה ומחיקה ----------
    async zoneMakeLayer(z) {
      const L = new Layer();
      L.maxBase = COARSE ? 4e6 : 9e6;
      L.rot = z.rot; L.s = z.s; L.dx = z.dx; L.dy = z.dy;
      L.sx = this.split ? this.vw : 0;
      this.stage.insertBefore(L.el, this.layerB.el.nextSibling);
      z.layer = L;
      await L.setPage(this.layerB.page);
      L.s = z.s; L.dx = z.dx; L.dy = z.dy;
    },
    zoneSync(z) { if (z.layer) { z.s = z.layer.s; z.dx = z.layer.dx; z.dy = z.layer.dy; z.rot = z.layer.rot; } },
    zoneDrop(z) { this.zoneSync(z); if (z.layer) { z.layer.destroy(); z.layer = null; } },
    async addZone(kind, pts, { silent = false } = {}) {
      const c = this.cmp; if (!c || !this.layerB.page) return null;
      if (c.zones.length >= MAX_ZONES) { UI.toast(tr('אפשר עד {0} אזורי יישור', MAX_ZONES), { type: 'error' }); return null; }
      const B = this.layerB;
      const z = { id: 'z' + (++zseq), name: tr('אזור {0}', ++c.zoneN), kind, pts, s: B.s, dx: B.dx, dy: B.dy, rot: B.rot, layer: null };
      c.zones.push(z);
      await this.zoneMakeLayer(z);
      if (!silent) { c.hist.push({ k: 'zadd', z }); c.redo = []; this.updateUndo(); this.cmpUndoUI?.(); }
      this.cmpTgt = z.id;
      this.cmpApplyLayerStyles(); this.placeZones(); this.renderCmpEdits(); this.scheduleDetail(40);
      this.zonesUI?.(); this.cmpUI?.refresh?.();
      if (!silent) { this.renderChanges(); }
      return z;
    },
    zoneRemove(z, { silent = false } = {}) {
      const c = this.cmp; if (!c) return;
      const i = c.zones.indexOf(z); if (i < 0) return;
      this.zoneDrop(z);
      c.zones.splice(i, 1);
      if (this.cmpTgt === z.id) this.cmpTgt = 'g';
      if (!silent) { c.hist.push({ k: 'zdel', z, i }); c.redo = []; this.updateUndo(); this.cmpUndoUI?.(); }
      this.updateZoneClips(); this.renderCmpEdits(); this.zonesUI?.(); this.cmpUI?.refresh?.();
      if (CHANGE_MODES.has(c.mode)) this.renderChanges();
    },
    async zoneRestore(z, i) {
      const c = this.cmp; if (!c) return;
      c.zones.splice(Math.min(i, c.zones.length), 0, z);
      await this.zoneMakeLayer(z);
      this.cmpApplyLayerStyles(); this.placeZones(); this.renderCmpEdits(); this.scheduleDetail(40);
      this.zonesUI?.(); this.cmpUI?.refresh?.();
      if (CHANGE_MODES.has(c.mode)) this.renderChanges();
    },
    // בהחלפת המסמך להשוואה (או סגירה): משחררים את שכבות האזורים, ושומרים את הפרמטרים
    zonesDropAll() { for (const z of this.cmpZones()) this.zoneDrop(z); },
    async zonesRebuild() { for (const z of this.cmpZones()) await this.zoneMakeLayer(z); this.cmpApplyLayerStyles(); this.placeZones(); },
    // סיבוב התצוגה (rotate ב-viewer.js): האזורים מסתובבים יחד עם התוכנית, כמו תוכנית ההשוואה
    zonesRotateView(oldPh, bh) {
      for (const z of this.cmpZones()) {
        const L = z.layer; if (!L) continue;
        const ndx = oldPh - L.dy - L.s * bh, ndy = L.dx;
        L.rot = (L.rot + 90) % 360; L.setPage(L.page); L.dx = ndx; L.dy = ndy; this.zoneSync(z);
      }
    },

    // ---------- מצייר אזור ----------
    startZoneDraw(kind) {
      const c = this.cmp; if (!c || !this.layerB.page) { UI.toast(tr('בחרו תוכנית להשוואה ולחצו "השווה" קודם')); return; }
      if (this.cmpEditMode) this.setCmpEdit(null);
      this.endZoneDraw(true);
      this.zoneKind = kind; this.zoneDraft = null;
      this.tool = 'cmpzone'; this.select(null, true); this.updateToolUI(); this.renderProps();
      c.zoneLines = true;
      UI.toast(kind === 'rect' ? tr('גררו מלבן סביב האזור שרוצים ליישר בנפרד') : tr('הקישו על נקודות לאורך גבול האזור. לסיום: הקשה על הנקודה הראשונה או Enter. Esc = ביטול'), { ms: 5000 });
      this.zonesUI?.();
    },
    endZoneDraw(keepTool = false) {
      this.zoneDraft = null; this.zoneKind = null;
      if (this.gDraft) this.gDraft.textContent = '';
      if (!keepTool && this.tool === 'cmpzone') { this.tool = 'pan'; this.updateToolUI(); this.renderProps(); }
      this.zonesUI?.();
    },
    renderZoneDraft(hover) {
      this.gDraft.textContent = '';
      const d = this.zoneDraft; if (!d || !d.pts.length) return;
      const sc = this.scale, pts = d.pts.concat(hover ? [hover] : []);
      this.gDraft.append(svg('polyline', { points: pts.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: '#8e24aa', 'stroke-width': 2 / sc, 'stroke-dasharray': `${6 / sc} ${4 / sc}` }));
      d.pts.forEach((p, i) => this.gDraft.append(svg('circle', { cx: p.x, cy: p.y, r: (i === 0 ? 6 : 3.5) / sc, fill: i === 0 ? '#8e24aa' : '#fff', stroke: '#8e24aa', 'stroke-width': 1.5 / sc })));
    },
    zoneMove(g, p) {
      if (this.zoneKind === 'rect') {
        const x0 = Math.min(g.p0.x, p.x), y0 = Math.min(g.p0.y, p.y), w = Math.abs(p.x - g.p0.x), hh = Math.abs(p.y - g.p0.y), sc = this.scale;
        this.gDraft.textContent = '';
        this.gDraft.append(svg('rect', { x: x0, y: y0, width: w, height: hh, fill: 'rgba(142,36,170,.10)', stroke: '#8e24aa', 'stroke-width': 2 / sc, 'stroke-dasharray': `${6 / sc} ${4 / sc}` }));
      } else if (this.zoneDraft) this.renderZoneDraft(p);
    },
    zoneUp(g, p, pt) {
      const moved = Math.hypot(pt.x - g.sx, pt.y - g.sy) > 8;
      if (this.zoneKind === 'rect') {
        this.gDraft.textContent = '';
        if (!moved) return;
        const x0 = Math.min(g.p0.x, p.x), y0 = Math.min(g.p0.y, p.y), x1 = Math.max(g.p0.x, p.x), y1 = Math.max(g.p0.y, p.y);
        this.endZoneDraw();
        this.addZone('rect', [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
        return;
      }
      if (moved) return;
      const d = this.zoneDraft || (this.zoneDraft = { pts: [] });
      if (d.pts.length >= 3) { // סגירה בהקשה על הנקודה הראשונה
        const f = this.o2d(d.pts[0].x, d.pts[0].y), here = this.o2d(p.x, p.y);
        if (Math.hypot((f.x - here.x) * this.scale, (f.y - here.y) * this.scale) < 16) { this.zoneFinish(); return; }
      }
      d.pts.push(p); this.renderZoneDraft();
    },
    zoneFinish() {
      const d = this.zoneDraft;
      if (!d || d.pts.length < 3) { UI.toast(tr('צריך לפחות 3 נקודות')); return; }
      const pts = d.pts.slice();
      this.endZoneDraw();
      this.addZone('poly', pts);
    },
    zoneKey(e) {
      if (this.tool !== 'cmpzone') return false;
      if (e.key === 'Enter') { this.zoneFinish(); return true; }
      if (e.key === 'Escape') { this.endZoneDraw(); return true; }
      if (e.key === 'Backspace' && this.zoneDraft && this.zoneDraft.pts.length) { this.zoneDraft.pts.pop(); this.renderZoneDraft(); return true; }
      return false;
    },

    // קווי האזורים על התוכנית (אפשר להסתיר בכפתור "הצג קווי אזורים")
    drawZoneLines() {
      const c = this.cmp; if (!c || !c.zones || !c.zones.length || c.zoneLines === false) return;
      const sc = this.scale, fs = 12 / sc;
      c.zones.forEach((z, i) => {
        const sel = this.cmpTgt === z.id, col = sel ? '#8e24aa' : '#1565c0', off = c.zonesOn === false;
        this.gCmp.append(svg('polygon', { points: z.pts.map((p) => `${p.x},${p.y}`).join(' '), fill: sel ? 'rgba(142,36,170,.07)' : 'none', stroke: col, 'stroke-width': sel ? 2.5 : 1.6, 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': off ? '4 4' : '', opacity: off ? 0.5 : 1 }));
        const p0 = z.pts[0], tw = fs * (0.9 + 0.62 * z.name.length);
        this.gCmp.append(svg('rect', { x: p0.x, y: p0.y - fs * 1.3, width: tw, height: fs * 1.3, fill: col }));
        const t = svg('text', { x: p0.x + fs * 0.3, y: p0.y - fs * 0.3, fill: '#fff', 'font-size': fs, 'font-weight': 'bold', 'font-family': 'sans-serif' });
        t.textContent = z.name; this.gCmp.append(t);
        void i;
      });
    },

    // ---------- נתונים לחישוב ההבדלים: כל אזור = תוכנית ההשוואה במיקום שלו, ומצולע בפיקסלי הקנבס ----------
    // mkLayer(L) -> תיאור שכבה בפיקסלים; toPx(x,y) -> נקודת עמוד בתצוגה לפיקסלים של הקנבס
    zonesForDiff(mkLayer, toPx) {
      const c = this.cmp; if (!c || c.zonesOn === false) return [];
      return (c.zones || []).filter((z) => z.layer).map((z) => ({ B: mkLayer(z.layer), poly: z.pts.map((p) => { const d = this.o2d(p.x, p.y); return toPx(d.x, d.y); }) }));
    },

    // ---------- לשונית "אזורים" ----------
    buildZonesTab() {
      const list = h('div', { class: 'cmp-zones' });
      const info = h('small', { class: 'hint-inline' });
      const mkBtn = (label, ic, fn, cls = '') => h('button', { class: 'btn sm ' + cls, onclick: fn }, ic ? icon(ic, 16) : null, label);
      const linesCb = h('input', { type: 'checkbox', checked: true });
      linesCb.onchange = () => { if (this.cmp) { this.cmp.zoneLines = linesCb.checked; this.renderCmpEdits(); } };
      const onCb = h('input', { type: 'checkbox', checked: true });
      onCb.onchange = () => {
        const c = this.cmp; if (!c) return;
        c.zonesOn = onCb.checked; this.cmpApplyLayerStyles(); this.renderCmpEdits(); this.scheduleDetail(30);
        if (CHANGE_MODES.has(c.mode)) this.renderChanges();
      };
      const paint = () => {
        const c = this.cmp, zs = (c && c.zones) || [];
        list.replaceChildren();
        const g = h('button', { class: 'btn sm' + (this.cmpTgt === 'g' || !this.cmpTgt ? ' primary' : ''), onclick: () => this.setCmpTarget('g') }, tr('יישור כללי'));
        list.append(h('div', { class: 'cmp-reg' + (this.cmpTgt === 'g' || !this.cmpTgt ? ' cur' : '') }, h('span', { class: 'reg-go' }, tr('כל מה שמחוץ לאזורים')), g));
        zs.forEach((z) => {
          const sel = this.cmpTgt === z.id;
          list.append(h('div', { class: 'cmp-reg' + (sel ? ' cur' : '') },
            h('span', { class: 'reg-go' }, h('b', {}, z.name), ' · ', z.kind === 'rect' ? tr('מלבן') : tr('צורה חופשית')),
            h('button', { class: 'btn sm' + (sel ? ' primary' : ''), onclick: () => this.setCmpTarget(z.id) }, sel ? tr('מיישרים אותו') : tr('יישר אזור זה')),
            h('button', { class: 'btn sm', title: tr('העתק את היישור הכללי לאזור'), onclick: () => this.alDo(() => { this.setCmpTarget(z.id); const B = this.layerB; this.relSet(B.s, B.dx, B.dy); }) }, tr('התחל מהכללי')),
            h('button', { class: 'icon-btn sm', title: tr('מחק אזור'), 'aria-label': tr('מחק אזור'), onclick: () => this.zoneRemove(z) }, icon('x', 16))));
        });
        info.textContent = zs.length ? tr('{0} אזורים. הגרירה, הגודל והחצים מיישרים את מה שנבחר ("מיישרים אותו").', zs.length) : tr('עדיין אין אזורים.');
        linesCb.checked = !c || c.zoneLines !== false; onCb.checked = !c || c.zonesOn !== false;
      };
      this.zonesUI = paint;
      const body = [
        h('small', { class: 'hint-inline' }, tr('כשבחלק אחד של התוכנית קנה המידה שונה: מסמנים עליו אזור, ומיישרים אותו בנפרד. התוכנית נשארת שלמה ובלי חיתוכים נראים, ואפשר להסתיר את הקווים.')),
        h('div', { class: 'cmp-row' }, mkBtn(tr('אזור מלבני חדש'), 'crop', () => this.startZoneDraw('rect'), 'primary'), mkBtn(tr('אזור חופשי (נקודות)'), 'area', () => this.startZoneDraw('poly')), mkBtn(tr('סיים צורה'), 'check', () => this.zoneFinish())),
        h('div', { class: 'cmp-row' }, h('label', { class: 'check' }, onCb, tr('השתמש באזורים')), h('label', { class: 'check' }, linesCb, tr('הצג קווי אזורים')), info),
        list,
      ];
      paint();
      return body;
    },
  });
}
