// הדפסה ושמירה כ-PDF / תמונה: עמוד נוכחי, כמה עמודים, האזור שמוצג במסך, אזור שסומן, או ההשוואה בין תוכניות – כולל הסימונים והמדידות.
// הערה: התוכנית עצמה נשלחת כתמונה ברזולוציה עד ~200 DPI (מוגבלת במספר המגה-פיקסלים, כדי לא לקרוס בטלפון).
import { t as tr } from './i18n.js';
import * as UI from './ui.js';
import { h, safeName, downloadBlob, clamp } from './util.js';
import { svg, drawItem } from './markup.js';
import { prefs } from './prefs.js';
import { renderChangesCanvas } from './diffview.js';

const TOUCH = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
export const MAX_PX = TOUCH ? 12e6 : 24e6, MAX_SIDE = TOUCH ? 8192 : 14000;
const CMP_MAX_PX = TOUCH ? 5e6 : 9e6;

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
    async printDialog(o = {}) {
      if (!this.page) return;
      const cmpOn = !!(this.cmp && this.layerB.page);
      const what = h('select', {}, h('option', { value: 'plan' }, tr('התוכנית (עם הסימונים)')), cmpOn ? h('option', { value: 'compare' }, tr('ההשוואה בין התוכניות')) : null);
      if (cmpOn && o.compare) what.value = 'compare';
      const scope = h('select', {});
      const range = h('input', { type: 'text', placeholder: tr('לדוגמה 1-3,5'), class: 'range-in' });
      const layout = h('select', {}, h('option', { value: 'overlay' }, tr('הדגשת שינויים (אחת מעל השנייה)')), h('option', { value: 'side' }, tr('זו לצד זו, עם הסימונים של כל אחת')));
      layout.value = this.cmp?.mode === 'sidechanges' ? 'side' : 'overlay';
      const paper = h('select', {}, h('option', { value: 'plan' }, tr('כגודל התוכנית המקורי')), h('option', { value: 'A4' }, tr('A4 (מתאים את התוכנית לדף)')), h('option', { value: 'A3' }, tr('A3 (מתאים את התוכנית לדף)')));
      const mk = (label, on) => { const cb = h('input', { type: 'checkbox', checked: on }); return { cb, el: h('label', { class: 'check' }, cb, label) }; };
      const cMk = mk(tr('סימונים וטקסטים שלי'), prefs.show.markups !== false), cMs = mk(tr('מדידות'), prefs.show.measurements !== false), cLn = mk(tr('קישורים (המסגרות המקווקוות)'), false);
      const rowRange = h('div', { class: 'row' }, range), rowLayout = h('div', { class: 'stack' }, h('label', {}, tr('סוג ההדפסה של ההשוואה')), layout);
      const fillScope = () => {
        const cmpMode = what.value === 'compare', prev = scope.value;
        scope.textContent = '';
        const add = (v, t) => scope.append(h('option', { value: v }, t));
        add('page', tr('העמוד הנוכחי (עמוד {0} מתוך {1})', this.pageNum, this.numPages));
        add('view', tr('האזור שמוצג עכשיו במסך'));
        if (this.region) add('region', tr('האזור שסימנתי'));
        if (!cmpMode && this.numPages > 1) { add('all', tr('כל העמודים ({0})', this.numPages)); add('range', tr('עמודים נבחרים…')); }
        scope.value = [...scope.options].some((x) => x.value === prev) ? prev : this.region ? 'region' : 'page';
        rowRange.style.display = scope.value === 'range' ? '' : 'none';
        rowLayout.style.display = cmpMode ? '' : 'none';
        cMk.el.querySelector('span')?.remove?.();
      };
      what.onchange = fillScope; scope.onchange = () => { rowRange.style.display = scope.value === 'range' ? '' : 'none'; };
      fillScope();
      if (o.region && this.region) scope.value = 'region';
      const body = h('div', { class: 'form' },
        h('p', { class: 'msg' }, tr('תוכנית "{0}".', this.plan.name)),
        cmpOn ? h('label', {}, tr('מה להדפיס')) : null, cmpOn ? what : null, rowLayout,
        h('label', {}, tr('איזה חלק')), scope, rowRange,
        h('label', {}, tr('גודל נייר')), paper, cMk.el, cMs.el, cLn.el,
        h('p', { class: 'hint' }, tr('התוכנית מודפסת כתמונה ברזולוציה עד כ-200 DPI (בתוכניות ענק מוגבלת מעט כדי לא להכביד על המכשיר). אם המדפסת לא תומכת בגודל המקורי, בחרו בחלון ההדפסה "התאם לדף". "שמור כ-PDF" יוצר קובץ שאפשר לשתף או לפתוח באפליקציה אחרת.')));
      const r = await UI.modal({
        title: tr('הדפסה / שמירה כ-PDF'), body,
        buttons: [{ text: tr('ביטול'), value: null }, { text: tr('שמור / שתף PDF'), icon: 'share', value: 'pdf' }, { text: tr('הדפס'), kind: 'primary', icon: 'print', value: 'print' }],
      });
      if (!r) return;
      const layers = { markups: cMk.cb.checked, measurements: cMs.cb.checked, links: cLn.cb.checked };
      const cmpMode = what.value === 'compare';
      let pages = [this.pageNum];
      if (!cmpMode && scope.value === 'all') pages = Array.from({ length: this.numPages }, (_, i) => i + 1);
      else if (!cmpMode && scope.value === 'range') { pages = parseRange(range.value, this.numPages); if (!pages.length) { UI.toast(tr('טווח עמודים לא תקין'), { type: 'error' }); return; } }
      if (pages.length > 25 && !(await UI.confirmBox(tr('להכין {0} עמודים? זה עלול לקחת זמן ולהעמיס על המכשיר.', pages.length), { okText: tr('המשך') }))) return;
      const pb = UI.progressBox(tr('מכין להדפסה…'));
      const comps = [];
      try {
        for (let i = 0; i < pages.length; i++) {
          pb.set(tr('מכין עמוד {0} ({1} מתוך {2})…', pages[i], i + 1, pages.length), i / pages.length);
          comps.push(await this.makeComp({ pageNum: pages[i], scope: scope.value, cmpMode, layout: layout.value, layers }));
        }
      } catch (e) {
        console.error(e); pb.close(); UI.alertBox(tr('לא הצלחנו להכין להדפסה: ') + (e.message || e), { title: tr('שגיאה') }); return;
      }
      pb.close();
      const opts = { paper: paper.value };
      if (r === 'print') this.sendToPrinter(comps, opts); else await this.savePagePdf(comps, cmpMode);
    },

    // תמונת JPEG אחת להדפסה (עמוד / אזור / השוואה)
    async makeComp({ pageNum, scope, cmpMode, layout, layers }) {
      let rect = null, k;
      if (scope === 'view' || scope === 'region') {
        if (scope === 'region' && this.region) rect = { ...this.region };
        else { const a = this.toDisp(0, 0), b = this.toDisp(this.vw, this.H); rect = { x0: Math.max(0, a.x), y0: Math.max(0, a.y), x1: Math.min(this.pw, b.x), y1: Math.min(this.ph, b.y) }; }
        k = Math.max(this.scale * this.dpr, 200 / 72);
      } else k = 200 / 72;
      if (!rect && pageNum === this.pageNum) rect = { x0: 0, y0: 0, x1: this.pw, y1: this.ph };
      const fixed = scope === 'view' || scope === 'region';
      let comp;
      if (cmpMode) {
        rect = rect || { x0: 0, y0: 0, x1: this.pw, y1: this.ph };
        k = capScale(k, (rect.x1 - rect.x0) * (layout === 'side' ? 2 : 1), rect.y1 - rect.y0, CMP_MAX_PX);
        comp = await this.renderCompareCanvas({ rect, k, layout, markups: layers.markups || layers.measurements });
      } else {
        let wPt, hPt;
        if (rect) { wPt = rect.x1 - rect.x0; hPt = rect.y1 - rect.y0; } else { const pg = await this.doc.getPage(pageNum); const vp = pg.getViewport({ scale: 1, rotation: ((pg.rotate || 0) + this.rotFor(pageNum)) % 360 }); wPt = vp.width; hPt = vp.height; pg.cleanup?.(); }
        k = capScale(k, wPt, hPt);
        comp = await this.renderRectCanvas({ pageNum, rect, k, layers, fixed });
      }
      const blob = await toBlob(comp.canvas, 'image/jpeg', 0.92);
      comp.canvas.width = comp.canvas.height = 0;
      if (!blob) throw new Error(tr('יצירת התמונה נכשלה (חסר זיכרון?)'));
      return { blob, W: comp.W, H: comp.H, pw: comp.wPt, ph: comp.hPt, pageNum };
    },

    sendToPrinter(comps, opts) {
      let sheet = document.getElementById('print-sheet');
      if (!sheet) { sheet = h('div', { id: 'print-sheet' }); document.body.append(sheet); }
      sheet.textContent = '';
      let style = document.getElementById('print-page-css');
      if (!style) { style = document.createElement('style'); style.id = 'print-page-css'; document.head.append(style); }
      const mm = (pt) => Math.round((pt * 25.4) / 72);
      const urls = [], imgs = [];
      let css = '';
      if (opts.paper === 'plan') {
        const c0 = comps[0];
        css = `@page { size: ${mm(c0.pw)}mm ${mm(c0.ph)}mm; margin: 0; } #print-sheet .pg { break-after: page; }`;
      } else {
        const [a, b] = opts.paper === 'A3' ? [297, 420] : [210, 297];
        css = `@page pv { size: ${opts.paper} portrait; margin: 6mm; } @page ls { size: ${opts.paper} landscape; margin: 6mm; } #print-sheet .pg { break-after: page; text-align: center; } #print-sheet .pg.pv { page: pv; } #print-sheet .pg.ls { page: ls; }`;
        void a; void b;
      }
      style.textContent = css;
      comps.forEach((comp, i) => {
        const url = URL.createObjectURL(comp.blob); urls.push(url);
        const land = comp.pw > comp.ph;
        const img = h('img', { alt: '' });
        if (opts.paper === 'plan') img.style.cssText = 'display:block;width:100%;height:auto;';
        else {
          const [a, b] = opts.paper === 'A3' ? [297, 420] : [210, 297];
          const [pwm, phm] = land ? [b, a] : [a, b];
          img.style.cssText = `display:block;margin:0 auto;max-width:${pwm - 12}mm;max-height:${phm - 14}mm;width:auto;height:auto;object-fit:contain;`;
        }
        imgs.push(img);
        sheet.append(h('div', { class: 'pg ' + (land ? 'ls' : 'pv') }, img));
      });
      const cleanup = () => { window.removeEventListener('afterprint', cleanup); urls.forEach((u) => URL.revokeObjectURL(u)); sheet.textContent = ''; };
      window.addEventListener('afterprint', cleanup);
      let loaded = 0;
      imgs.forEach((img, i) => { img.onload = () => { if (++loaded === imgs.length) setTimeout(() => window.print(), 120); }; img.src = urls[i]; });
    },

    async savePagePdf(comps, cmpMode = false) {
      const pages = [];
      for (const c of comps) pages.push({ jpeg: new Uint8Array(await c.blob.arrayBuffer()), W: c.W, H: c.H, wPt: c.pw, hPt: c.ph });
      const pdf = jpegsToPdf(pages);
      const base = safeName(this.plan.name);
      const name = cmpMode ? tr('{0}_השוואה.pdf', base) : comps.length > 1 ? tr('{0}_עם_סימונים.pdf', base) : tr('{0}_עמוד{1}_עם_סימונים.pdf', base, comps[0].pageNum);
      const file = new File([pdf], name, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      downloadBlob(pdf, name);
      UI.toast(tr('הקובץ נשמר (') + name + ')');
    },

    // המרה של נקודת מסך (בתוך ה-stage) לקואורדינטות תצוגה של העמוד
    toDisp(x, y) { return { x: (x - this.tx) / this.scale, y: (y - this.ty) / this.scale }; },
  });
}
