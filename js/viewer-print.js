// הדפסה ושמירה כ-PDF / תמונה: עמוד נוכחי, כמה עמודים, האזור שמוצג במסך, אזור שסומן, או ההשוואה בין תוכניות – כולל הסימונים והמדידות.
// איכות וקטורית (ברירת מחדל): ה-PDF המקורי מוטמע כמו שהוא והסימונים מצוירים מעליו כוקטור (pdf-vector.js). חלופה: תמונה עד 600 DPI (מוגבלת בזיכרון המכשיר).
import { t as tr, CHEV_FWD, CHEV_BACK } from './i18n.js';
import * as UI from './ui.js';
import { openModal } from './ui.js';
import { h, icon, safeName, downloadBlob, askSaveHandle, writeToHandle } from './util.js';
import { bi, PAPERS, MARGINS, mmToPt, ptToMm, layoutSheet, DEFAULT_PRINT } from './print-layout.js';
import { buildVectorPdf } from './pdf-vector.js';
import { svg, drawItem } from './markup.js';
import { prefs } from './prefs.js';
import { renderChangesCanvas } from './diffview.js';

const TOUCH = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
export const MAX_PX = TOUCH ? 12e6 : 24e6, MAX_SIDE = TOUCH ? 8192 : 14000;
const CMP_MAX_PX = TOUCH ? 5e6 : 9e6;
const PP_KEY = 'plans.print';
const loadPrintPrefs = () => { try { return { ...DEFAULT_PRINT, ...JSON.parse(localStorage.getItem(PP_KEY) || '{}') }; } catch { return { ...DEFAULT_PRINT }; } };
const savePrintPrefs = (v) => { try { localStorage.setItem(PP_KEY, JSON.stringify(v)); } catch { /* ignore */ } };

// קובץ PDF מכמה תמונות JPEG (עמוד לכל תמונה, בגודל עמוד לפי נקודות)
function jpegsToPdf(pages) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let off = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); off += b.length; };
  const obj = (n, content) => { offsets[n] = off; push(`${n} 0 obj\n${content}\nendobj\n`); };
  const N = pages.length;
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${N} >>`);
  pages.forEach((p, i) => {
    const pg = 3 + 3 * i, ct = pg + 1, im = pg + 2;
    const w = p.wPt.toFixed(2), hh = p.hPt.toFixed(2);
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${hh}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    const content = `q ${w} 0 0 ${hh} 0 0 cm /Im0 Do Q`;
    obj(ct, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[im] = off;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.W} /Height ${p.H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push('\nendstream\nendobj\n');
  });
  const total = 3 + 3 * N, xref = off;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

const mkCanvas = (W, H) => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
// קנה מידה (פיקסלים לנקודת עמוד) כך שלא נחרוג ממגבלות הקנבס
export function capScale(k, wPt, hPt, maxPx = MAX_PX) {
  while (wPt * k * hPt * k > maxPx || Math.max(wPt, hPt) * k > MAX_SIDE) k *= 0.95;
  return k;
}
function parseRange(txt, n) {
  const out = new Set();
  for (const part of String(txt || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= n) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

export function installPrint(V) {
  Object.assign(V.prototype, {
    // ---------- ציור מלבן מהעמוד (בקואורדינטות תצוגה) לקנבס: תוכנית + סימונים ----------
    // rect: { x0, y0, x1, y1 } ביחידות עמוד אחרי סיבוב התצוגה; k: פיקסלים לנקודת עמוד
    async renderRectCanvas({ pageNum = this.pageNum, rect = null, k, layers = { markups: true, measurements: true, links: false }, fixed = false }) {
      const cur = pageNum === this.pageNum;
      const page = cur ? this.page : await this.doc.getPage(pageNum);
      const rot = this.rotFor(pageNum);
      const rotation = ((((page.rotate || 0) + rot) % 360) + 360) % 360;
      const v1 = page.getViewport({ scale: 1, rotation }), o1 = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      const r = rect || { x0: 0, y0: 0, x1: v1.width, y1: v1.height };
      const wPt = r.x1 - r.x0, hPt = r.y1 - r.y0;
      const W = Math.max(1, Math.round(wPt * k)), H = Math.max(1, Math.round(hPt * k));
      const c = mkCanvas(W, H), ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: k, rotation }), transform: [1, 0, 0, 1, -r.x0 * k, -r.y0 * k], background: '#ffffff' }).promise;
      if (!cur) page.cleanup?.();
      await this.paintItems(ctx, { W, H, rect: r, pageNum, rot, ow: o1.width, oh: o1.height, layers, fixed });
      return { canvas: c, W, H, wPt, hPt };
    },
    async paintItems(ctx, { W, H, rect, pageNum, rot, ow, oh, layers, fixed }) {
      const items = [];
      for (const layer of ['markups', 'measurements', 'links']) if (layers[layer]) for (const it of this.items[layer]) if (it.page === pageNum && this.itemShown(it)) items.push(it);
      if (layers.cmpNotes && this.cmp) items.push(...(this.cmp.notes || []));
      if (!items.length) return 0;
      const root = svg('svg', { viewBox: `${rect.x0} ${rect.y0} ${rect.x1 - rect.x0} ${rect.y1 - rect.y0}`, width: W, height: H });
      const g = svg('g'), m = this.rotMatrix(rot, ow, oh);
      if (m) g.setAttribute('transform', m);
      root.append(g);
      const cx = this.ctx();
      for (const it of items) g.append(drawItem(fixed ? this.fixedMeasure(it) : it, { ...cx, cal: this.calFor(it, pageNum) }));
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml;charset=utf-8' }));
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(tr('ציור הסימונים נכשל'))); img.src = url; });
        ctx.drawImage(img, 0, 0, W, H);
      } finally { URL.revokeObjectURL(url); }
      return items.length;
    },

    // ---------- ההשוואה כתמונה: הדגשת שינויים מעל, או כל תוכנית בנפרד זו לצד זו (עם כותרת, צבעים ומקרא) ----------
    async renderCompareCanvas({ rect, k, layout = 'overlay', markups = false }) {
      const c = this.cmp, B = this.layerB;
      const W = Math.max(1, Math.round((rect.x1 - rect.x0) * k)), H = Math.max(1, Math.round((rect.y1 - rect.y0) * k));
      const px = this.cmpPx(k);
      const A = { page: this.page, rot: this.rot, k, ox: -rect.x0 * k, oy: -rect.y0 * k };
      const Bm = { page: B.page, rot: B.rot, k: k * B.s, ox: (B.dx - rect.x0) * k, oy: (B.dy - rect.y0) * k };
      const edits = (c.edits || []).map((e) => {
        const a = this.o2d(e.x0, e.y0), b = this.o2d(e.x1, e.y1);
        return { mode: e.mode, x0: (Math.min(a.x, b.x) - rect.x0) * k, x1: (Math.max(a.x, b.x) - rect.x0) * k, y0: (Math.min(a.y, b.y) - rect.y0) * k, y1: (Math.max(a.y, b.y) - rect.y0) * k };
      });
      const side = layout === 'side';
      const res = await renderChangesCanvas({ A, B: Bm, w: W, h: H, emphasis: this.cmpSet.emph, tol: px.tol, gap: px.gap, colA: this.cmpSet.colA, colB: this.cmpSet.colB, colS: this.cmpSet.colS, edits, side });
      if (!res) throw new Error(tr('היצירה בוטלה'));
      if (markups || (c.notes && c.notes.length)) { // סימוני התוכנית (אם נבחר) + הסימונים שלי על ההשוואה
        const ctxs = side ? [res.left.getContext('2d')] : [res.getContext('2d')];
        await this.paintItems(ctxs[0], { W, H, rect, pageNum: this.pageNum, rot: this.rot, ow: this.ow, oh: this.oh, layers: { markups: markups && prefs.show.markups, measurements: markups && prefs.show.measurements, links: false, cmpNotes: true }, fixed: true });
      }
      // כותרת: שמות התוכניות והצבעים
      const fs = Math.max(12, Math.round(Math.min(W * 0.022, 38))), head = Math.round(fs * 2.2);
      const labelA = `${tr('פתוחה')}: ${this.plan?.name || ''} V${this.version?.number ?? ''}`;
      const labelB = `${tr('להשוואה')}: ${c.label || ''}`;
      const outW = side ? W * 2 + Math.round(fs) : W;
      const out = mkCanvas(outW, H + head), x = out.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, outW, H + head);
      if (side) { x.drawImage(res.left, 0, head); x.drawImage(res.right, W + Math.round(fs), head); x.fillStyle = '#888'; x.fillRect(W, head, Math.round(fs), H); } else x.drawImage(res, 0, head);
      x.font = `600 ${fs}px system-ui, Arial, sans-serif`; x.textBaseline = 'middle';
      const sw = fs * 1.1;
      x.fillStyle = this.cmpSet.colA; x.fillRect(Math.round(fs * 0.5), (head - sw) / 2, sw, sw);
      x.fillStyle = '#111'; x.direction = 'ltr'; x.textAlign = 'left';
      x.fillText(labelA + (side ? '' : '  =  ' + tr('קיים רק בפתוחה')), Math.round(fs * 0.5 + sw + fs * 0.4), head / 2, outW / 2 - fs * 2);
      const bx = side ? W + Math.round(fs) : outW / 2;
      x.fillStyle = this.cmpSet.colB; x.fillRect(bx + Math.round(fs * 0.5), (head - sw) / 2, sw, sw);
      x.fillStyle = '#111';
      x.fillText(labelB + (side ? '' : '  =  ' + tr('קיים רק בהשוואה')), bx + Math.round(fs * 0.5 + sw + fs * 0.4), head / 2, outW / 2 - fs * 2);
      return { canvas: out, W: outW, H: H + head, wPt: (rect.x1 - rect.x0) * (outW / W), hPt: (rect.y1 - rect.y0) * ((H + head) / H) };
    },

    rotFor(n) { return n === this.pageNum ? this.rot : this.rotOfPage(n); },

    // ---------- חלון הדפסה / שמירה ----------
    // מקורות: התוכנית הנוכחית, כל המסך (כל התוכניות הפתוחות בתצוגה מפוצלת), או ההשוואה. הכל נבנה כ"גיליון": דף נייר + מלבנים (tiles) שמוצבים עליו.
    // תצוגה מקדימה, PDF וקטורי, והדפסה כתמונה – כולם משתמשים באותה פריסה, לכן מה שרואים בתצוגה המקדימה הוא מה שיודפס.
    async pageDims(n) {
      const pg = n === this.pageNum ? this.page : await this.doc.getPage(n);
      const vp = pg.getViewport({ scale: 1, rotation: ((((pg.rotate || 0) + this.rotFor(n)) % 360) + 360) % 360 });
      if (n !== this.pageNum) pg.cleanup?.();
      return { w: vp.width, h: vp.height };
    },
    // המלבן שמוצג כרגע במסך (ביחידות עמוד, אחרי סיבוב התצוגה)
    viewRect() {
      const a = this.toDisp(0, 0), b = this.toDisp(this.vw, this.H);
      return { x0: Math.max(0, a.x), y0: Math.max(0, a.y), x1: Math.min(this.pw, b.x), y1: Math.min(this.ph, b.y) };
    },
    // cfg: { what: 'plan'|'screen'|'compare', scope, range, layout, layers }
    async printBlocks(cfg) {
      const layers = cfg.layers, blocks = [];
      if (cfg.what === 'screen') {
        const host = this.host, area = host.area.getBoundingClientRect(), tiles = [];
        for (const v of host.viewers) {
          if (!v.page || v.dead) continue;
          const r = v.viewRect(); if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) continue;
          const st = v.stage.getBoundingClientRect(), s = v.scale;
          tiles.push({ v, pageNum: v.pageNum, rect: r, x: st.left - area.left + v.tx + r.x0 * s, y: st.top - area.top + v.ty + r.y0 * s, w: (r.x1 - r.x0) * s, h: (r.y1 - r.y0) * s, fixed: true, layers });
        }
        if (!tiles.length) throw new Error(tr('אין מה להדפיס'));
        const x0 = Math.min(...tiles.map((t) => t.x)), y0 = Math.min(...tiles.map((t) => t.y)), x1 = Math.max(...tiles.map((t) => t.x + t.w)), y1 = Math.max(...tiles.map((t) => t.y + t.h));
        tiles.forEach((t) => { t.x -= x0; t.y -= y0; });
        blocks.push({ cw: x1 - x0, ch: y1 - y0, tiles });
        return blocks;
      }
      if (cfg.what === 'compare') {
        let rect, k;
        if (cfg.scope === 'view') { rect = this.viewRect(); k = Math.max(this.scale * this.dpr, 200 / 72); }
        else if (cfg.scope === 'region' && this.region) { rect = { ...this.region }; k = Math.max(this.scale * this.dpr, 200 / 72); } else { rect = { x0: 0, y0: 0, x1: this.pw, y1: this.ph }; k = 200 / 72; }
        k = capScale(k, (rect.x1 - rect.x0) * (cfg.layout === 'side' ? 2 : 1), rect.y1 - rect.y0, CMP_MAX_PX);
        const comp = await this.renderCompareCanvas({ rect, k, layout: cfg.layout, markups: layers.markups || layers.measurements });
        blocks.push({ cw: comp.wPt, ch: comp.hPt, tiles: [{ img: comp.canvas, x: 0, y: 0, w: comp.wPt, h: comp.hPt }] });
        return blocks;
      }
      let pages = [this.pageNum];
      if (cfg.scope === 'all') pages = Array.from({ length: this.numPages }, (_, i) => i + 1);
      else if (cfg.scope === 'range') pages = parseRange(cfg.range, this.numPages);
      for (const n of pages) {
        let rect, fixed = false;
        if (cfg.scope === 'view') { rect = this.viewRect(); fixed = true; } else if (cfg.scope === 'region' && this.region) { rect = { ...this.region }; fixed = true; } else { const d = await this.pageDims(n); rect = { x0: 0, y0: 0, x1: d.w, y1: d.h }; }
        const w = rect.x1 - rect.x0, hh = rect.y1 - rect.y0;
        blocks.push({ cw: w, ch: hh, planPt: { w, h: hh }, tiles: [{ v: this, pageNum: n, rect, x: 0, y: 0, w, h: hh, fixed, layers }] });
      }
      return blocks;
    },

    // ציור גיליון כתמונה (דף שלם ברזולוציית dpi, מוגבל לזיכרון). maxSide: לתצוגה מקדימה
    async renderSheetCanvas(sheet, dpi, bitmapOf) {
      let k = dpi / 72;
      while (sheet.pw * k * sheet.ph * k > MAX_PX || Math.max(sheet.pw, sheet.ph) * k > MAX_SIDE) k *= 0.95;
      const c = mkCanvas(Math.max(1, Math.round(sheet.pw * k)), Math.max(1, Math.round(sheet.ph * k))), x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      for (const t of sheet.tiles) {
        const d = t.dest;
        if (bitmapOf) { const bm = await bitmapOf(t); if (bm) x.drawImage(bm, d.x * k, d.y * k, d.w * k, d.h * k); continue; }
        if (t.img) { x.drawImage(t.img, d.x * k, d.y * k, d.w * k, d.h * k); continue; }
        const rw = t.rect.x1 - t.rect.x0, rh = t.rect.y1 - t.rect.y0;
        const kt = capScale(k * (d.w / rw), rw, rh);
        const comp = await t.v.renderRectCanvas({ pageNum: t.pageNum, rect: t.rect, k: kt, layers: t.layers, fixed: t.fixed });
        x.drawImage(comp.canvas, d.x * k, d.y * k, d.w * k, d.h * k);
        comp.canvas.width = comp.canvas.height = 0;
      }
      return c;
    },

    async printDialog(o = {}) {
      if (!this.page) return;
      const self = this, host = this.host, multi = !!(host && host.viewers.filter((v) => v.page).length > 1);
      const cmpOn = !!(this.cmp && this.layerB.page);
      const def = loadPrintPrefs();
      const sel = (opts, val) => { const s = h('select', {}, opts.map(([v, t]) => h('option', { value: v }, t))); if (val != null) s.value = val; return s; };
      const sec = (title, ...kids) => h('div', { class: 'pr-sec' }, h('h4', {}, title), ...kids);
      const lbl = (he, en, el) => h('label', { class: 'pr-f' }, h('span', {}, bi(he, en)), el);
      const mk = (label, on) => { const cb = h('input', { type: 'checkbox', checked: on }); return { cb, el: h('label', { class: 'check' }, cb, label) }; };

      const whatOpts = [['plan', bi('התוכנית הנוכחית', 'Current plan')]];
      if (multi) whatOpts.push(['screen', bi('כל המסך', 'Whole screen')]);
      if (cmpOn) whatOpts.push(['compare', bi('ההשוואה בין התוכניות', 'Plan comparison')]);
      const what = sel(whatOpts, o.compare && cmpOn ? 'compare' : o.screen && multi ? 'screen' : 'plan');
      const scope = h('select', {});
      const range = h('input', { type: 'text', placeholder: bi('לדוגמה 1-3,5', 'e.g. 1-3,5'), class: 'range-in', dir: 'ltr' });
      const layout = sel([['overlay', bi('הדגשת שינויים (מעל)', 'Highlight changes')], ['side', bi('זו לצד זו', 'Side by side')]], this.cmp?.mode === 'sidechanges' ? 'side' : 'overlay');
      const paperOpts = () => [...(what.value === 'screen' || what.value === 'compare' ? [] : [['plan', bi('כגודל התוכנית המקורי', 'Original plan size')]]), ...PAPERS.map(([n, w, hh]) => [n, `${n} (${Math.round(w)}×${Math.round(hh)} ${bi('מ״מ', 'mm')})`])];
      const paper = sel(paperOpts(), def.paper);
      const orient = sel([['auto', bi('אוטומטי', 'Automatic')], ['portrait', bi('לאורך', 'Portrait')], ['landscape', bi('לרוחב', 'Landscape')]], def.orient);
      const margin = sel([['none', bi('ללא שוליים', 'No margins')], ['small', bi('קטנים (5 מ״מ)', 'Small (5 mm)')], ['normal', bi('רגילים (10 מ״מ)', 'Normal (10 mm)')], ['large', bi('גדולים (20 מ״מ)', 'Large (20 mm)')]], def.margin);
      const quality = sel([['vector', bi('וקטורי (מומלץ)', 'Vector (recommended)')], ['img600', bi('תמונה 600 DPI', 'Image 600 DPI')], ['img300', bi('תמונה 300 DPI', 'Image 300 DPI')], ['img200', bi('תמונה 200 DPI (מהיר)', 'Image 200 DPI (fast)')]], def.quality);
      const cMk = mk(bi('סימונים וטקסטים שלי', 'My markups and text'), prefs.show.markups !== false), cMs = mk(bi('מדידות', 'Measurements'), prefs.show.measurements !== false), cLn = mk(bi('קישורים (מסגרות מקווקוות)', 'Links (dashed frames)'), false);
      const fname = h('input', { type: 'text', value: safeName(this.plan.name) + tr('_להדפסה'), dir: 'auto' });
      const remember = mk(bi('שמור הגדרות אלה כברירת מחדל', 'Save these settings as default'), false);
      const rowRange = h('div', { class: 'pr-f' }, range), rowLayout = lbl('סוג ההדפסה של ההשוואה', 'Comparison layout', layout), rowScope = lbl('איזה חלק להדפיס', 'What part to print', scope);
      const info = h('div', { class: 'pr-info' });
      const cv = h('canvas', { class: 'pr-canvas' }), busy = h('div', { class: 'pr-busy' }, bi('מכין תצוגה מקדימה…', 'Preparing preview…'));
      const pgPrev = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': bi('דף קודם', 'Previous sheet'), onclick: () => { cur = Math.max(0, cur - 1); drawPreview(); } }, icon(CHEV_BACK, 18));
      const pgNext = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': bi('דף הבא', 'Next sheet'), onclick: () => { cur = Math.min(sheets.length - 1, cur + 1); drawPreview(); } }, icon(CHEV_FWD, 18));
      const pgLbl = h('span', { class: 'pr-pg' });
      const prev = h('div', { class: 'pr-prev' }, h('div', { class: 'pr-cvwrap' }, cv, busy), h('div', { class: 'pr-nav' }, pgPrev, pgLbl, pgNext), info);

      const fillScope = () => {
        const w = what.value, prevV = scope.value;
        scope.textContent = '';
        const add = (v, t) => scope.append(h('option', { value: v }, t));
        if (w !== 'screen') {
          add('page', bi(`עמוד נוכחי (${this.pageNum}/${this.numPages})`, `Current page (${this.pageNum}/${this.numPages})`));
          add('view', bi('האזור שמוצג במסך', 'Area shown on screen'));
          if (this.region) add('region', bi('האזור שסימנתי', 'The area I marked'));
          if (w === 'plan' && this.numPages > 1) { add('all', bi(`כל העמודים (${this.numPages})`, `All pages (${this.numPages})`)); add('range', bi('עמודים נבחרים…', 'Selected pages…')); }
        }
        scope.value = [...scope.options].some((x) => x.value === prevV) ? prevV : this.region ? 'region' : 'page';
        if (o.region && this.region && w !== 'screen') scope.value = 'region';
        rowScope.style.display = w === 'screen' ? 'none' : '';
        rowRange.style.display = scope.value === 'range' && w === 'plan' ? '' : 'none';
        rowLayout.style.display = w === 'compare' ? '' : 'none';
        const pv = paper.value; paper.replaceChildren(...paperOpts().map(([v, t]) => h('option', { value: v }, t)));
        paper.value = [...paper.options].some((x) => x.value === pv) ? pv : (def.paper === 'plan' ? 'A3' : def.paper);
        const cmpOnly = w === 'compare';
        quality.querySelectorAll('option').forEach((op) => { if (op.value === 'vector') op.disabled = cmpOnly; });
        if (cmpOnly && quality.value === 'vector') quality.value = 'img300';
      };
      fillScope();

      // ---- בניית גיליונות + תצוגה מקדימה ----
      let blocks = [], sheets = [], cur = 0, sig = '', tok = 0, closed = false;
      const bitmaps = new Map();
      const getCfg = () => ({ what: what.value, scope: scope.value, range: range.value, layout: layout.value, layers: { markups: cMk.cb.checked, measurements: cMs.cb.checked, links: cLn.cb.checked } });
      const layoutAll = () => {
        sheets = blocks.map((b) => layoutSheet(b, { paper: paper.value, orient: orient.value, margin: margin.value, planPt: b.planPt }));
        cur = Math.min(cur, Math.max(0, sheets.length - 1));
      };
      const tileKey = (t) => (t.img ? null : `${t.v.planId}|${t.v.version?.id}|${t.pageNum}|${t.rect.x0.toFixed(1)},${t.rect.y0.toFixed(1)},${t.rect.x1.toFixed(1)},${t.rect.y1.toFixed(1)}|${JSON.stringify(t.layers)}|${t.fixed}|${t.v.scale.toFixed(3)}|${t.v.rotFor(t.pageNum)}`);
      const bitmapOf = async (t) => {
        if (t.img) return t.img;
        const key = tileKey(t);
        if (bitmaps.has(key)) return bitmaps.get(key);
        const rw = t.rect.x1 - t.rect.x0, rh = t.rect.y1 - t.rect.y0;
        const k = Math.min(1100 / Math.max(rw, rh), 6);
        const comp = await t.v.renderRectCanvas({ pageNum: t.pageNum, rect: t.rect, k: capScale(k, rw, rh, 4e6), layers: t.layers, fixed: t.fixed });
        if (bitmaps.size > 10) { for (const [kk, c] of bitmaps) { c.width = c.height = 0; bitmaps.delete(kk); break; } }
        bitmaps.set(key, comp.canvas);
        return comp.canvas;
      };
      async function drawPreview() {
        if (closed) return;
        const my = ++tok;
        if (!sheets.length) { busy.style.display = 'none'; info.textContent = ''; return; }
        const sh = sheets[cur], PX = 640, k = Math.min(PX / sh.pw, PX / sh.ph) * 1.4;
        pgLbl.textContent = bi(`דף ${cur + 1} מתוך ${sheets.length}`, `Sheet ${cur + 1} of ${sheets.length}`);
        pgPrev.disabled = cur <= 0; pgNext.disabled = cur >= sheets.length - 1;
        pgPrev.parentElement.style.display = sheets.length > 1 ? '' : 'none';
        const mm = (pt) => Math.round(ptToMm(pt));
        const scaleTxt = blocks[cur]?.planPt || blocks[cur]?.tiles?.[0]?.img ? ` · ${bi('קנה מידה', 'Scale')} \u2066${Math.round(sh.s * 100)}%\u2069` : '';
        info.textContent = `\u2066${mm(sh.pw)}×${mm(sh.ph)}\u2069 ${bi('מ״מ', 'mm')} · ${sh.pw > sh.ph ? bi('לרוחב', 'Landscape') : bi('לאורך', 'Portrait')}${scaleTxt}`;
        busy.style.display = '';
        try {
          const c = await self.renderSheetCanvas(sh, k * 72 / 1, async (t) => { const bm = await bitmapOf(t); return my === tok ? bm : null; });
          if (my !== tok || closed) { c.width = c.height = 0; return; }
          cv.width = c.width; cv.height = c.height;
          const x = cv.getContext('2d'); x.drawImage(c, 0, 0);
          const m = mmToPt(MARGINS[margin.value] || 0) * (c.width / sh.pw); // מסגרת שוליים מקווקוות
          if (m > 1) { x.save(); x.strokeStyle = 'rgba(33,150,243,.55)'; x.setLineDash([6, 5]); x.strokeRect(m, m, c.width - 2 * m, c.height - 2 * m); x.restore(); }
          c.width = c.height = 0;
          cv.style.aspectRatio = `${sh.pw} / ${sh.ph}`;
          busy.style.display = 'none';
        } catch (e) { if (my === tok) { busy.textContent = bi('התצוגה המקדימה נכשלה', 'Preview failed'); console.warn(e); } }
      }
      let t1 = 0;
      const refresh = async (contentChanged) => {
        clearTimeout(t1);
        t1 = setTimeout(async () => {
          if (closed) return;
          const cfg = getCfg(), s2 = JSON.stringify([cfg.what, cfg.scope, cfg.range, cfg.layout, cfg.layers, cfg.what === 'screen' ? self.host.viewers.map((v) => [v.planId, v.pageNum, v.scale, v.tx, v.ty]) : null]);
          const my = ++tok;
          if (contentChanged || s2 !== sig) {
            busy.textContent = bi('מכין תצוגה מקדימה…', 'Preparing preview…'); busy.style.display = '';
            try { blocks = await self.printBlocks(cfg); } catch (e) { if (my === tok) { blocks = []; sheets = []; busy.textContent = e.message || String(e); } return; }
            if (my !== tok) return;
            sig = s2; cur = 0;
          }
          layoutAll(); drawPreview();
        }, 120);
      };
      what.onchange = () => { fillScope(); refresh(true); };
      scope.onchange = () => { rowRange.style.display = scope.value === 'range' ? '' : 'none'; refresh(true); };
      range.oninput = () => refresh(true);
      layout.onchange = () => refresh(true);
      for (const c of [cMk, cMs, cLn]) c.cb.onchange = () => refresh(true);
      for (const s of [paper, orient, margin]) s.onchange = () => refresh(false);
      refresh(true);

      const form = h('div', { class: 'pr-form' },
        multi || cmpOn ? sec(bi('מה להדפיס', 'What to print'), lbl('מקור', 'Source', what), rowScope, rowRange, rowLayout) : sec(bi('מה להדפיס', 'What to print'), rowScope, rowRange),
        sec(bi('נייר', 'Paper'), lbl('גודל נייר', 'Paper size', paper), lbl('כיוון הדף', 'Orientation', orient), lbl('שוליים', 'Margins', margin), remember.el),
        sec(bi('איכות', 'Quality'), lbl('סוג הפלט', 'Output type', quality),
          h('p', { class: 'hint' }, bi('וקטורי: קווי התוכנית והסימונים נשארים חדים גם בהגדלה גדולה מאוד של ה-PDF (כיתובים ברזולוציה גבוהה). תמונה: מתאים כשהוקטורי לא עובד.', 'Vector: plan lines and markups stay sharp at any PDF zoom (labels are high-resolution). Image: use if vector fails.'))),
        sec(bi('שכבות', 'Layers'), cMk.el, cMs.el, cLn.el),
        sec(bi('שם הקובץ (לשמירה כ-PDF)', 'File name (for saving as PDF)'), fname));
      const body = h('div', { class: 'pr-wrap' }, form, prev);

      let pre = null;
      const m = openModal({
        title: bi('הדפסה / שמירה כ-PDF', 'Print / Save as PDF'), body, wide: true, className: 'print-modal',
        buttons: [
          { text: bi('ביטול', 'Cancel'), value: null },
          { text: bi('שמור / שתף PDF', 'Save / Share PDF'), icon: TOUCH ? 'share' : 'download', value: 'pdf' },
          { text: bi('הדפס', 'Print'), kind: 'primary', icon: 'print', value: 'print', onClick: () => { if (!TOUCH && quality.value === 'vector') { try { pre = window.open('about:blank', '_blank'); } catch { pre = null; } } } },
        ],
      });
      const r = await m.promise;
      closed = true; clearTimeout(t1); tok++;
      for (const c of bitmaps.values()) c.width = c.height = 0;
      bitmaps.clear();
      if (!r) { for (const b of blocks) for (const t of b.tiles) if (t.img) t.img.width = t.img.height = 0; return; }
      const settings = { paper: paper.value, orient: orient.value, margin: margin.value, quality: quality.value };
      if (remember.cb.checked) savePrintPrefs(settings);
      const cfg = getCfg();
      if (cfg.what === 'plan' && cfg.scope === 'range' && !parseRange(cfg.range, this.numPages).length) { UI.toast(tr('טווח עמודים לא תקין'), { type: 'error' }); pre?.close(); return; }
      if (sheets.length > 25 && !(await UI.confirmBox(tr('להכין {0} עמודים? זה עלול לקחת זמן ולהעמיס על המכשיר.', sheets.length), { okText: tr('המשך') }))) { pre?.close(); return; }
      const name = (safeName(fname.value.replace(/\.pdf$/i, '')) || 'plan') + '.pdf';
      let handle = null;
      if (r === 'pdf' && !TOUCH) { handle = await askSaveHandle(name, 'application/pdf', 'PDF'); if (handle === 'cancel') return; }
      const pb = UI.progressBox(tr('מכין להדפסה…'));
      try {
        let blob = null, comps = null;
        if (settings.quality === 'vector' && cfg.what !== 'compare') {
          try {
            pb.set(tr('יוצר PDF וקטורי…'), 0.05);
            blob = await buildVectorPdf(sheets, { onProgress: (f) => pb.set(tr('יוצר PDF וקטורי…'), f) });
          } catch (e) {
            console.error(e); blob = null;
            UI.toast(tr('PDF וקטורי לא נתמך בקובץ הזה (למשל קובץ מוצפן) – מכין כתמונה ברזולוציה גבוהה'), { ms: 5000, type: 'error' });
          }
        }
        if (!blob) {
          const dpi = { img600: 600, img300: 300, img200: 200 }[settings.quality] || 300;
          comps = [];
          for (let i = 0; i < sheets.length; i++) {
            pb.set(tr('מכין עמוד {0} ({1} מתוך {2})…', i + 1, i + 1, sheets.length), i / sheets.length);
            const c = await this.renderSheetCanvas(sheets[i], dpi);
            const jb = await toBlob(c, 'image/jpeg', 0.92); const W = c.width, H = c.height; c.width = c.height = 0;
            if (!jb) throw new Error(tr('יצירת התמונה נכשלה (חסר זיכרון?)'));
            comps.push({ blob: jb, W, H, pw: sheets[i].pw, ph: sheets[i].ph });
          }
        }
        pb.close();
        if (r === 'pdf') {
          if (!blob) { const pages = []; for (const c of comps) pages.push({ jpeg: new Uint8Array(await c.blob.arrayBuffer()), W: c.W, H: c.H, wPt: c.pw, hPt: c.ph }); blob = jpegsToPdf(pages); }
          await this.deliverPdf(blob, name, handle);
        } else if (blob) {
          if (TOUCH) { UI.toast(tr('ה-PDF מוכן. בתפריט השיתוף בחרו "הדפס" כדי להדפיס בלי לאבד חדות'), { ms: 6000 }); await this.deliverPdf(blob, name, null); } else this.openPdfTab(blob, name, pre);
        } else { pre?.close(); this.sendToPrinter(comps, name.replace(/\.pdf$/, '')); }
      } catch (e) {
        console.error(e); pb.close(); pre?.close();
        UI.alertBox(tr('לא הצלחנו להכין להדפסה: ') + (e.message || e), { title: tr('שגיאה') });
      } finally { for (const b of blocks) for (const t of b.tiles) if (t.img) t.img.width = t.img.height = 0; }
    },

    // כל המסך (כל התוכניות הפתוחות) כתמונה אחת, באיכות לפי הזום הנוכחי
    async saveScreenImage() {
      if (!this.host) return;
      const fmt = h('select', {}, h('option', { value: 'png' }, bi('PNG (חד, מומלץ)', 'PNG (sharp, recommended)')), h('option', { value: 'jpg' }, bi('JPG (קובץ קטן יותר)', 'JPG (smaller file)')));
      const res = h('select', {}, [[1, bi('כמו במסך', 'Same as screen')], [2, bi('פי 2 (חד יותר)', '2× (sharper)')], [4, bi('פי 4', '4×')], [8, bi('מקסימלי (מוגבל בזיכרון)', 'Maximum (memory-limited)')]].map(([v, t]) => h('option', { value: v }, t)));
      res.value = '2';
      const nameIn = h('input', { type: 'text', value: tr('מסך_מלא'), dir: 'auto' });
      const cMk = h('input', { type: 'checkbox', checked: prefs.show.markups !== false }), cMs = h('input', { type: 'checkbox', checked: prefs.show.measurements !== false });
      const body = h('div', { class: 'form' }, h('label', {}, bi('שם הקובץ', 'File name')), nameIn, h('label', {}, bi('רזולוציה', 'Resolution')), res, h('label', {}, bi('פורמט', 'Format')), fmt,
        h('label', { class: 'check' }, cMk, bi('סימונים וטקסטים שלי', 'My markups and text')), h('label', { class: 'check' }, cMs, bi('מדידות', 'Measurements')),
        h('p', { class: 'hint' }, bi('כל התוכניות הפתוחות נשמרות בתמונה אחת, בדיוק כפי שהן מסודרות במסך עכשיו. לאיכות וקטורית (חדה בכל הגדלה) השתמשו ב"הדפסה / PDF".', 'All open plans are saved in one image, laid out as on screen now. For vector quality (sharp at any zoom) use “Print / PDF”.')));
      const act = await UI.modal({ title: bi('שמירת כל המסך כתמונה', 'Save whole screen as image'), body, buttons: [{ text: bi('ביטול', 'Cancel'), value: null }, { text: bi('שתף', 'Share'), icon: 'share', value: 'share' }, { text: bi('שמור', 'Save'), kind: 'primary', icon: 'download', value: 'save' }] });
      if (!act) return;
      const isPng = fmt.value === 'png', name = (safeName(nameIn.value.replace(/\.(png|jpe?g)$/i, '')) || 'screen') + (isPng ? '.png' : '.jpg');
      let handle = null;
      if (act === 'save') { handle = await askSaveHandle(name, isPng ? 'image/png' : 'image/jpeg', bi('תמונה', 'Image')); if (handle === 'cancel') return; }
      const pb = UI.progressBox(tr('יוצר תמונה…'));
      try {
        const blocks = await this.printBlocks({ what: 'screen', layers: { markups: cMk.checked, measurements: cMs.checked, links: false } });
        const b = blocks[0], sheet = { pw: b.cw, ph: b.ch, s: 1, tiles: b.tiles.map((t) => ({ ...t, dest: { x: t.x, y: t.y, w: t.w, h: t.h } })) };
        const c = await this.renderSheetCanvas(sheet, 72 * (+res.value || 2));
        const blob = await toBlob(c, isPng ? 'image/png' : 'image/jpeg', 0.93); c.width = c.height = 0; pb.close();
        if (!blob) throw new Error(tr('יצירת התמונה נכשלה (חסר זיכרון?)'));
        const file = new File([blob], name, { type: blob.type });
        if (act === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
        if (handle) { await writeToHandle(handle, blob); UI.toast(tr('התמונה נשמרה (') + (handle.name || name) + ')'); return; }
        downloadBlob(blob, name); UI.toast(tr('התמונה נשמרה (') + name + ')');
      } catch (e) { console.error(e); pb.close(); UI.alertBox(tr('לא הצלחנו ליצור את התמונה: ') + (e.message || e), { title: tr('שגיאה') }); }
    },

    // PDF מוכן: שמירה עם בחירת שם ומקום (מחשב), שיתוף (טלפון) או הורדה
    async deliverPdf(blob, name, handle) {
      const file = new File([blob], name, { type: 'application/pdf' });
      if (handle) { await writeToHandle(handle, blob); UI.toast(tr('הקובץ נשמר (') + (handle.name || name) + ')'); return; }
      if (TOUCH && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      downloadBlob(blob, name);
      UI.toast(tr('הקובץ נשמר (') + name + ')');
    },
    // מחשב: ה-PDF נפתח בלשונית חדשה, ושם לוחצים הדפס (Ctrl+P). מדפסת ברירת המחדל נבחרת שם לפי המערכת
    openPdfTab(blob, name, win) {
      const url = URL.createObjectURL(blob);
      setTimeout(() => URL.revokeObjectURL(url), 15 * 60 * 1000);
      if (win && !win.closed) { win.location.href = url; UI.toast(tr('ה-PDF נפתח בלשונית חדשה – לחצו שם על הדפס (Ctrl+P)'), { ms: 6000 }); return; }
      downloadBlob(blob, name);
      UI.toast(tr('הדפדפן חסם את פתיחת הלשונית. ה-PDF ירד לתיקיית ההורדות – פתחו אותו והדפיסו'), { ms: 7000 });
    },

    // הדפסה כתמונה: כל גיליון הוא דף מלא בגודל הנייר, בלי שוליים של הדפדפן ובלי כותרות/כתובות (@page margin 0 + כותרת ריקה)
    sendToPrinter(comps, title) {
      let sheet = document.getElementById('print-sheet');
      if (!sheet) { sheet = h('div', { id: 'print-sheet' }); document.body.append(sheet); }
      sheet.textContent = '';
      let style = document.getElementById('print-page-css');
      if (!style) { style = document.createElement('style'); style.id = 'print-page-css'; document.head.append(style); }
      const mm = (pt) => (pt * 25.4 / 72).toFixed(2);
      const urls = [], imgs = [];
      style.textContent = comps.map((c, i) => `@page p${i} { size: ${mm(c.pw)}mm ${mm(c.ph)}mm; margin: 0; }`).join('\n')
        + '\n#print-sheet .pg { break-after: page; page-break-after: always; overflow: hidden; margin: 0; padding: 0; } #print-sheet .pg:last-child { break-after: auto; page-break-after: auto; }';
      comps.forEach((c, i) => {
        const url = URL.createObjectURL(c.blob); urls.push(url);
        const img = h('img', { alt: '' });
        img.style.cssText = 'display:block;width:100%;height:100%;object-fit:fill;';
        imgs.push(img);
        sheet.append(h('div', { class: 'pg', style: `page:p${i};width:${mm(c.pw)}mm;height:${mm(c.ph)}mm;` }, img));
      });
      const oldTitle = document.title; document.title = title || ' ';
      const cleanup = () => { window.removeEventListener('afterprint', cleanup); document.title = oldTitle; urls.forEach((u) => URL.revokeObjectURL(u)); sheet.textContent = ''; };
      window.addEventListener('afterprint', cleanup);
      let loaded = 0;
      imgs.forEach((img, i) => { img.onload = () => { if (++loaded === imgs.length) setTimeout(() => window.print(), 150); }; img.src = urls[i]; });
    },

    // המרה של נקודת מסך (בתוך ה-stage) לקואורדינטות תצוגה של העמוד
    toDisp(x, y) { return { x: (x - this.tx) / this.scale, y: (y - this.ty) / this.scale }; },
  });
}
