// זיהוי טקסט (OCR) לקבצי סריקה – tesseract.js מקומי (עברית + אנגלית), רץ במכשיר ולא שולח כלום החוצה.
// התוצאות נשמרות באינדקס הטקסט (textindex) ולכן גם החיפוש הכללי מוצא אותן.
import * as db from './db.js';
import * as S from './store.js';
import { openPdf, destroyDoc, pageText } from './pdfio.js';

const BASE = new URL('../lib/ocr/', import.meta.url).href;
let tessP = null;
function loadTess() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return tessP || (tessP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = BASE + 'tesseract.min.js';
    s.onload = () => res(window.Tesseract);
    s.onerror = () => rej(new Error('טעינת רכיב ה-OCR נכשלה'));
    document.head.appendChild(s);
  }));
}

let workerP = null;
async function getWorker() {
  if (workerP) return workerP;
  workerP = (async () => {
    const T = await loadTess();
    return T.createWorker(['heb', 'eng'], 1, { workerPath: BASE + 'worker.min.js', corePath: BASE, langPath: BASE + 'lang', workerBlobURL: false, gzip: true });
  })().catch((e) => { workerP = null; throw e; });
  return workerP;
}
export async function stopOcr() {
  if (!workerP) return;
  const w = await workerP.catch(() => null); workerP = null;
  try { await w?.terminate(); } catch { /* ignore */ }
}

const MIN_CHARS = 20;
// אילו עמודים חסרי טקסט (סריקה) ועדיין לא עברו OCR
export async function pagesNeedingOcr(vid) {
  const blob = await S.getFileBlob(vid, { remote: false });
  if (!blob) return null;
  const doc = await openPdf(blob, { interactive: false });
  const need = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const row = await db.get('textindex', `${vid}:${i}`);
      if (row && row.text && row.text.trim().length >= MIN_CHARS) continue;
      const pg = await doc.getPage(i);
      const t = await pageText(pg); pg.cleanup();
      if ((t || '').trim().length < MIN_CHARS) need.push(i);
    }
    return { need, total: doc.numPages };
  } finally { await destroyDoc(doc); }
}

function flatWords(data) {
  if (data.blocks) {
    const out = [];
    for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) out.push(w);
    if (out.length) return out;
  }
  return data.words || [];
}

// מריץ OCR על העמודים שנבחרו. onProgress({done,total,page}); isCancelled() מפסיק.
export async function ocrVersion(vid, pages, { onProgress, isCancelled } = {}) {
  const v = S.P.versions.get(vid);
  const blob = await S.getFileBlob(vid, { remote: false });
  if (!v || !blob) throw new Error('הקובץ לא זמין במכשיר');
  const worker = await getWorker();
  const doc = await openPdf(blob, { interactive: false });
  let done = 0, found = 0;
  try {
    for (const n of pages) {
      if (isCancelled?.()) break;
      onProgress?.({ done, total: pages.length, page: n });
      const pg = await doc.getPage(n);
      const v1 = pg.getViewport({ scale: 1 });
      const k = Math.min(3, 3200 / Math.max(v1.width, v1.height));
      const vp = pg.getViewport({ scale: k });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
      pg.cleanup();
      const res = await worker.recognize(c, {}, { blocks: true, text: true });
      c.width = c.height = 1;
      const ws = flatWords(res.data).filter((w) => w.text && w.text.trim());
      let text = '';
      const words = [];
      for (const w of ws) {
        const t = w.text.trim();
        const b = w.bbox;
        words.push({ s: text.length, e: text.length + t.length, x: b.x0 / k, y: b.y0 / k, w: (b.x1 - b.x0) / k, h: (b.y1 - b.y0) / k });
        text += t + ' ';
      }
      text = text.trim();
      if (text) { await db.put('textindex', { id: `${vid}:${n}`, versionId: vid, planId: v.planId, page: n, text, ocr: true, words }); found++; }
      done++;
    }
    onProgress?.({ done, total: pages.length, page: null });
  } finally { await destroyDoc(doc); }
  if (!v.hasText && found) { v.hasText = true; v.ocr = true; await db.put('versions', v); }
  return { done, found };
}
