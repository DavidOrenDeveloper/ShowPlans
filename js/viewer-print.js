// הדפסה ושמירה כ-PDF של העמוד הנוכחי כולל הסימונים, הטקסטים והמדידות שמוצגים.
// הערה: התוכנית עצמה נשלחת כתמונה ברזולוציה עד ~200 DPI (מוגבלת ל-12 מגה-פיקסל, כדי לא לקרוס בטלפון).
import * as UI from './ui.js';
import { h, icon, safeName, downloadBlob } from './util.js';
import { svg, drawItem } from './markup.js';
import { prefs } from './prefs.js';

const MAX_PX = 12e6, MAX_SIDE = 8192;

function jpegToPdf(jpeg, W, H, wPt, hPt) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let off = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); off += b.length; };
  const obj = (n, content) => { offsets[n] = off; push(`${n} 0 obj\n${content}\nendobj\n`); };
  const w = wPt.toFixed(2), hh = hPt.toFixed(2);
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${hh}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  const content = `q ${w} 0 0 ${hh} 0 0 cm /Im0 Do Q`;
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  offsets[5] = off;
  push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push('\nendstream\nendobj\n');
  const xref = off;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

export function installPrint(V) {
  Object.assign(V.prototype, {
    async printDialog() {
      if (!this.page) return;
      const paper = h('select', {}, h('option', { value: 'plan' }, 'כגודל התוכנית המקורי'), h('option', { value: 'A4' }, 'A4 (מתאים את התוכנית לדף)'), h('option', { value: 'A3' }, 'A3 (מתאים את התוכנית לדף)'));
      const mk = (label, on) => { const cb = h('input', { type: 'checkbox', checked: on }); return { cb, el: h('label', { class: 'check' }, cb, label) }; };
      const cMk = mk('סימונים וטקסטים שלי', true), cMs = mk('מדידות', true), cLn = mk('קישורים (המסגרות המקווקוות)', false);
      const body = h('div', { class: 'form' },
        h('p', { class: 'msg' }, `עמוד ${this.pageNum} מתוך ${this.numPages} בתוכנית "${this.plan.name}".`),
        h('label', {}, 'גודל נייר'), paper, cMk.el, cMs.el, cLn.el,
        h('p', { class: 'hint' }, 'התוכנית מודפסת כתמונה ברזולוציה עד כ-200 DPI (בתוכניות ענק מוגבלת מעט כדי לא להכביד על המכשיר). אם המדפסת לא תומכת בגודל המקורי, בחרו בחלון ההדפסה "התאם לדף". "שמור כ-PDF" יוצר קובץ שאפשר לשתף או לפתוח באפליקציה אחרת.'));
      const r = await UI.modal({
        title: 'הדפסה / שמירה כ-PDF', body,
        buttons: [{ text: 'ביטול', value: null }, { text: 'שמור / שתף PDF', icon: 'share', value: 'pdf' }, { text: 'הדפס', kind: 'primary', icon: 'print', value: 'print' }],
      });
      if (!r) return;
      const opts = { paper: paper.value, markups: cMk.cb.checked, measurements: cMs.cb.checked, links: cLn.cb.checked };
      const pb = UI.progressBox('מכין את העמוד…');
      let comp;
      try { pb.set('מצייר את התוכנית והסימונים…', 0.4); comp = await this.renderComposite(opts); } catch (e) {
        console.error(e); pb.close(); UI.alertBox('לא הצלחנו להכין את העמוד להדפסה: ' + (e.message || e), { title: 'שגיאה' }); return;
      }
      pb.close();
      if (r === 'print') this.sendToPrinter(comp, opts); else await this.savePagePdf(comp);
    },

    async renderComposite(opts) {
      const page = this.page, pw = this.pw, ph = this.ph;
      let k = 200 / 72;
      while (pw * k * ph * k > MAX_PX || Math.max(pw, ph) * k > MAX_SIDE) k *= 0.95;
      const W = Math.round(pw * k), H = Math.round(ph * k);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: k }), background: '#ffffff' }).promise;
      const items = [];
      for (const layer of ['markups', 'measurements', 'links']) if (opts[layer]) for (const it of this.items[layer]) if (it.page === this.pageNum) items.push(it);
      if (items.length) {
        const root = svg('svg', { viewBox: `0 0 ${pw} ${ph}`, width: W, height: H });
        const cx = this.ctx();
        for (const it of items) root.append(drawItem(it, cx));
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml;charset=utf-8' }));
        try {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('ציור הסימונים נכשל')); img.src = url; });
          ctx.drawImage(img, 0, 0, W, H);
        } finally { URL.revokeObjectURL(url); }
      }
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      c.width = c.height = 0;
      if (!blob) throw new Error('יצירת התמונה נכשלה (חסר זיכרון?)');
      return { blob, W, H, pw, ph, count: items.length };
    },

    sendToPrinter(comp, opts) {
      const url = URL.createObjectURL(comp.blob);
      let sheet = document.getElementById('print-sheet');
      if (!sheet) { sheet = h('div', { id: 'print-sheet' }, h('img', { alt: '' })); document.body.append(sheet); }
      const img = sheet.querySelector('img');
      let style = document.getElementById('print-page-css');
      if (!style) { style = document.createElement('style'); style.id = 'print-page-css'; document.head.append(style); }
      const mm = (pt) => Math.round((pt * 25.4) / 72);
      const land = comp.pw > comp.ph;
      if (opts.paper === 'plan') {
        style.textContent = `@page { size: ${mm(comp.pw)}mm ${mm(comp.ph)}mm; margin: 0; }`;
        img.style.cssText = 'display:block;width:100%;height:auto;';
      } else {
        const [a, b] = opts.paper === 'A3' ? [297, 420] : [210, 297];
        const [pwm, phm] = land ? [b, a] : [a, b];
        style.textContent = `@page { size: ${opts.paper} ${land ? 'landscape' : 'portrait'}; margin: 6mm; }`;
        img.style.cssText = `display:block;margin:0 auto;max-width:${pwm - 12}mm;max-height:${phm - 14}mm;width:auto;height:auto;object-fit:contain;`;
      }
      const cleanup = () => { window.removeEventListener('afterprint', cleanup); URL.revokeObjectURL(url); img.removeAttribute('src'); };
      window.addEventListener('afterprint', cleanup);
      img.onload = () => setTimeout(() => window.print(), 80);
      img.src = url;
    },

    async savePagePdf(comp) {
      const jpeg = new Uint8Array(await comp.blob.arrayBuffer());
      const pdf = jpegToPdf(jpeg, comp.W, comp.H, comp.pw, comp.ph);
      const name = `${safeName(this.plan.name)}_עמוד${this.pageNum}_עם_סימונים.pdf`;
      const file = new File([pdf], name, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      downloadBlob(pdf, name);
      UI.toast('הקובץ נשמר (' + name + ')');
    },
  });
}
