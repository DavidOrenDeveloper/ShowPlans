// כלי "אזור": מסמנים מלבן על התוכנית (אפשר להזיז, לשנות גודל בגרירת הידיות, ולהתקרב ולהתרחק כרגיל),
// ואז שומרים את האזור כתמונה (ברזולוציה שמתאימה להגדלה הנוכחית) או מדפיסים רק אותו.
// עובד בעכבר ובמגע: גרירה בתוך המסגרת = הזזת האזור, גרירת ידית = שינוי גודל, גרירה מחוץ למסגרת = הזזת התוכנית, צביטה = זום.
import { t as tr } from './i18n.js';
import * as UI from './ui.js';
import { h, icon, safeName, downloadBlob, clamp, askSaveHandle, writeToHandle, canPickSave } from './util.js';
import { bi } from './print-layout.js';
import { svg } from './markup.js';
import { prefs } from './prefs.js';
import { capScale, MAX_PX } from './viewer-print.js';

const HANDLES = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];

export function installArea(V) {
  Object.assign(V.prototype, {
    regionScreen() {
      const r = this.region, s = this.scale;
      return { x0: this.tx + Math.min(r.x0, r.x1) * s, x1: this.tx + Math.max(r.x0, r.x1) * s, y0: this.ty + Math.min(r.y0, r.y1) * s, y1: this.ty + Math.max(r.y0, r.y1) * s };
    },
    regionHit(pt) {
      const r = this.regionScreen(), w = r.x1 - r.x0, hh = r.y1 - r.y0;
      const R = Math.max(10, Math.min(24, Math.min(w, hh) / 3));
      const pos = { tl: [r.x0, r.y0], t: [(r.x0 + r.x1) / 2, r.y0], tr: [r.x1, r.y0], r: [r.x1, (r.y0 + r.y1) / 2], br: [r.x1, r.y1], b: [(r.x0 + r.x1) / 2, r.y1], bl: [r.x0, r.y1], l: [r.x0, (r.y0 + r.y1) / 2] };
      let best = null, bd = R;
      for (const k of HANDLES) { const d = Math.hypot(pt.x - pos[k][0], pt.y - pos[k][1]); if (d < bd) { bd = d; best = k; } }
      if (best) return best;
      const E = 14;
      if (pt.y >= r.y0 - E && pt.y <= r.y1 + E && pt.x >= r.x0 - E && pt.x <= r.x1 + E) {
        if (Math.abs(pt.x - r.x0) < E) return 'l';
        if (Math.abs(pt.x - r.x1) < E) return 'r';
        if (Math.abs(pt.y - r.y0) < E) return 't';
        if (Math.abs(pt.y - r.y1) < E) return 'b';
        if (pt.x > r.x0 && pt.x < r.x1 && pt.y > r.y0 && pt.y < r.y1) return 'move';
      }
      return null;
    },
    regionDown(pt, e, base) {
      const toD = (q) => ({ x: (this.viewX(q.x) - this.tx) / this.scale, y: (q.y - this.ty) / this.scale });
      if (this.region) {
        const hd = this.regionHit(pt);
        if (hd) { this.gesture = { ...base, type: 'region', hd, r0: this.regionNorm(), d0: toD(pt) }; return; }
        // מחוץ למסגרת: הזזת התוכנית
        this.gesture = { type: 'pan', id: e.pointerId, x: pt.x, y: pt.y, sx: pt.x, sy: pt.y, t0: performance.now(), moved: false, mouse: e.pointerType === 'mouse' };
        return;
      }
      const d0 = toD(pt);
      this.region = { x0: d0.x, y0: d0.y, x1: d0.x, y1: d0.y };
      this.regionBar.classList.add('hidden');
      this.gesture = { ...base, type: 'region', hd: 'new', r0: { ...this.region }, d0 };
    },
    regionNorm() { const r = this.region; return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) }; },
    regionMove(g, pt) {
      if (!this.region) return;
      const d = { x: (this.viewX(pt.x) - this.tx) / this.scale, y: (pt.y - this.ty) / this.scale };
      const cx = (v) => clamp(v, 0, this.pw), cy = (v) => clamp(v, 0, this.ph), r0 = g.r0, dx = d.x - g.d0.x, dy = d.y - g.d0.y;
      let r = { ...this.region };
      if (g.hd === 'new') r = { x0: cx(g.d0.x), y0: cy(g.d0.y), x1: cx(d.x), y1: cy(d.y) };
      else if (g.hd === 'move') {
        const mx = clamp(dx, -r0.x0, this.pw - r0.x1), my = clamp(dy, -r0.y0, this.ph - r0.y1);
        r = { x0: r0.x0 + mx, x1: r0.x1 + mx, y0: r0.y0 + my, y1: r0.y1 + my };
      } else {
        r = { ...r0 };
        if (g.hd.includes('l')) r.x0 = cx(r0.x0 + dx);
        if (g.hd.includes('r')) r.x1 = cx(r0.x1 + dx);
        if (g.hd.includes('t')) r.y0 = cy(r0.y0 + dy);
        if (g.hd.includes('b')) r.y1 = cy(r0.y1 + dy);
      }
      this.region = r;
      g.moved = true;
      this.renderRegion();
    },
    regionUp(g) {
      if (!this.region) return;
      const n = this.regionNorm();
      if ((n.x1 - n.x0) * this.scale < 14 || (n.y1 - n.y0) * this.scale < 14) { if (g.hd === 'new') { this.clearRegion(); return; } }
      this.region = n;
      this.renderRegion();
      this.updateRegionUI();
    },
    clearRegion() {
      this.region = null;
      this.gRegion && (this.gRegion.textContent = '');
      this.regionBar && this.regionBar.classList.add('hidden');
    },
    renderRegion() {
      const g = this.gRegion; g.textContent = '';
      if (!this.region) return;
      const r = this.regionNorm(), sc = this.scale, B = 1e6;
      g.append(svg('path', { d: `M${-B} ${-B}H${B}V${B}H${-B}ZM${r.x0} ${r.y0}V${r.y1}H${r.x1}V${r.y0}Z`, fill: 'rgba(0,0,0,.38)', 'fill-rule': 'evenodd' }));
      g.append(svg('rect', { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, fill: 'none', stroke: '#2196f3', 'stroke-width': 2 / sc }));
      const sz = 12 / sc, mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
      const pts = [[r.x0, r.y0], [mx, r.y0], [r.x1, r.y0], [r.x1, my], [r.x1, r.y1], [mx, r.y1], [r.x0, r.y1], [r.x0, my]];
      for (const [x, y] of pts) g.append(svg('rect', { x: x - sz / 2, y: y - sz / 2, width: sz, height: sz, fill: '#fff', stroke: '#1976d2', 'stroke-width': 2 / sc, rx: 2 / sc }));
    },
    // סרגל הפעולות של האזור (מופיע אחרי שסימנו אזור)
    updateRegionUI() {
      const bar = this.regionBar; if (!bar) return;
      if (!this.region) { bar.classList.add('hidden'); return; }
      const b = (ic, label, fn, cls = '') => h('button', { class: 'rg-btn ' + cls, onclick: fn }, icon(ic, 18), h('span', {}, label));
      bar.replaceChildren(
        b('image', tr('שמור כתמונה'), () => this.saveImageDialog(), 'main'),
        b('print', tr('הדפס אזור'), () => this.printDialog({ region: true })),
        b('crop', tr('אזור חדש'), () => { this.clearRegion(); }),
        h('button', { class: 'icon-btn', 'aria-label': tr('סגור'), onclick: () => { this.clearRegion(); this.setTool('pan'); } }, icon('x', 18)));
      bar.classList.remove('hidden');
    },

    // ---------- שמירת האזור כתמונה ----------
    async saveImageDialog() {
      if (!this.region || !this.page) return;
      const r = this.regionNorm(), wPt = r.x1 - r.x0, hPt = r.y1 - r.y0;
      const kScreen = Math.max(this.scale * this.dpr, 2);
      const opts = [['screen', bi('כמו שנראה עכשיו במסך (מומלץ אחרי התקרבות)', 'As currently shown on screen (recommended after zooming)'), kScreen], ['high', bi('גבוהה (300 DPI)', 'High (300 DPI)'), 300 / 72], ['max', bi('מקסימלית (מוגבלת בזיכרון המכשיר)', 'Maximum (limited by device memory)'), 1000]];
      const sel = h('select', {}, opts.map(([v, t]) => h('option', { value: v }, t)));
      const fmt = h('select', {}, h('option', { value: 'png' }, bi('PNG (חד, מומלץ לתוכניות)', 'PNG (sharp, recommended for plans)')), h('option', { value: 'jpg' }, bi('JPG (קובץ קטן יותר)', 'JPG (smaller file)')));
      const baseName = tr('{0}_עמוד{1}_אזור', safeName(this.plan.name), this.pageNum);
      const nameIn = h('input', { type: 'text', value: baseName, dir: 'auto', 'aria-label': bi('שם הקובץ', 'File name') });
      const info = h('p', { class: 'hint' });
      const mk = (label, on) => { const cb = h('input', { type: 'checkbox', checked: on }); return { cb, el: h('label', { class: 'check' }, cb, label) }; };
      const cMk = mk(bi('סימונים וטקסטים שלי', 'My markups and text'), prefs.show.markups !== false), cMs = mk(bi('מדידות', 'Measurements'), prefs.show.measurements !== false), cLn = mk(bi('קישורים', 'Links'), false);
      const cCmp = this.cmp && this.layerB.page ? mk(bi('כולל הדגשת ההשוואה', 'Include comparison highlights'), true) : null;
      const kOf = () => { const base = opts.find((o) => o[0] === sel.value)[2]; return capScale(base, wPt, hPt, MAX_PX); };
      const upd = () => { const k = kOf(); info.textContent = bi('גודל התמונה: {0}×{1} פיקסלים', 'Image size: {0}×{1} pixels').replace('{0}', Math.round(wPt * k)).replace('{1}', Math.round(hPt * k)); };
      sel.onchange = upd; upd();
      const body = h('div', { class: 'form' },
        h('label', {}, bi('שם הקובץ', 'File name')), nameIn,
        h('label', {}, bi('איכות / רזולוציה', 'Quality / resolution')), sel, info,
        h('label', {}, bi('פורמט', 'Format')), fmt, cMk.el, cMs.el, cLn.el, cCmp ? cCmp.el : null,
        h('p', { class: 'hint' }, canPickSave() ? bi('בלחיצה על "שמור" תיפתח בחירת תיקייה ושם לקובץ.', 'Clicking “Save” opens a dialog to choose the folder and file name.') : bi('בדפדפן הזה הקובץ יורד לתיקיית ההורדות עם השם שבחרתם (אפשר לשתף ולבחור יעד דרך "שתף").', 'In this browser the file goes to your downloads folder with the name above (use “Share” to pick a destination).')),
        h('p', { class: 'hint' }, bi('התמונה נוצרת מחדש מהקובץ המקורי ברזולוציה הנבחרת, כך שגם באזור גדול הקווים והטקסט נשארים חדים.', 'The image is re-rendered from the original file at the chosen resolution, so lines and text stay sharp.')));
      const act = await UI.modal({ title: bi('שמירת האזור כתמונה', 'Save area as image'), body, buttons: [{ text: bi('ביטול', 'Cancel'), value: null }, { text: bi('שתף', 'Share'), icon: 'share', value: 'share' }, { text: bi('שמור', 'Save'), kind: 'primary', icon: 'download', value: 'save' }] });
      if (!act) return;
      const isPng = fmt.value === 'png';
      const name = (safeName(nameIn.value.replace(/\.(png|jpe?g)$/i, '')) || baseName) + (isPng ? '.png' : '.jpg');
      let handle = null;
      if (act === 'save') { // קודם בוחרים שם ומיקום (בזמן שהלחיצה עדיין "טרייה"), ורק אחר כך יוצרים את התמונה
        handle = await askSaveHandle(name, isPng ? 'image/png' : 'image/jpeg', bi('תמונה', 'Image'));
        if (handle === 'cancel') return;
      }
      const pb = UI.progressBox(tr('יוצר תמונה…'));
      try {
        const k = kOf(), layers = { markups: cMk.cb.checked, measurements: cMs.cb.checked, links: cLn.cb.checked };
        let canvas;
        pb.set(tr('מצייר את האזור…'), 0.4);
        if (cCmp && cCmp.cb.checked) {
          const layout = this.cmp.mode === 'sidechanges' ? 'side' : 'overlay';
          canvas = (await this.renderCompareCanvas({ rect: r, k: capScale(k, wPt * (layout === 'side' ? 2 : 1), hPt, 9e6), layout, markups: layers.markups || layers.measurements })).canvas;
        } else canvas = (await this.renderRectCanvas({ rect: r, k, layers, fixed: true })).canvas;
        const blob = await new Promise((res) => canvas.toBlob(res, isPng ? 'image/png' : 'image/jpeg', 0.93));
        canvas.width = canvas.height = 0;
        pb.close();
        if (!blob) throw new Error(tr('יצירת התמונה נכשלה (חסר זיכרון?)'));
        const file = new File([blob], name, { type: blob.type });
        if (act === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
        }
        if (handle) { await writeToHandle(handle, blob); UI.toast(tr('התמונה נשמרה (') + (handle.name || name) + ')'); return; }
        downloadBlob(blob, name);
        UI.toast(tr('התמונה נשמרה (') + name + ')');
      } catch (e) {
        console.error(e); pb.close();
        UI.alertBox(tr('לא הצלחנו ליצור את התמונה: ') + (e.message || e), { title: tr('שגיאה') });
      }
    },
  });
}
