// עטיפה ל-PDF.js של Mozilla (נטען מקומית מתוך lib/pdfjs, ללא CDN)

let libP = null;
let passwordHandler = null;
export function setPasswordHandler(fn) { passwordHandler = fn; }

export function getLib() {
  if (!libP) {
    libP = import('../lib/pdfjs/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return libP;
}

const base = (p) => new URL(p, import.meta.url).href;

// source: Blob | ArrayBuffer | Uint8Array. הערה: PDF.js "גונב" את ה-buffer שמועבר אליו.
export async function openPdf(source, { interactive = false } = {}) {
  const lib = await getLib();
  let data;
  if (source instanceof Blob) data = new Uint8Array(await source.arrayBuffer());
  else if (source instanceof ArrayBuffer) data = new Uint8Array(source);
  else data = source;
  const task = lib.getDocument({
    data,
    standardFontDataUrl: base('../lib/pdfjs/standard_fonts/'),
    wasmUrl: base('../lib/pdfjs/wasm/'),
    iccUrl: base('../lib/pdfjs/iccs/'),
    isEvalSupported: false,
  });
  task.onPassword = async (cb, reason) => {
    if (!interactive || !passwordHandler) { task.destroy(); return; }
    const pw = await passwordHandler(reason);
    if (pw == null) task.destroy(); else cb(pw);
  };
  return task.promise;
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

// תמונה ממוזערת של עמוד 1 (JPEG קטן כדי לא לבזבז מקום)
export async function renderThumb(doc, maxSide = 400) {
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const s = maxSide / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale: s });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(vp.width));
  c.height = Math.max(1, Math.ceil(vp.height));
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
  page.cleanup();
  const blob = await toBlob(c, 'image/jpeg', 0.72);
  c.width = c.height = 0;
  return blob;
}

export async function pageText(page) {
  const tc = await page.getTextContent();
  return tc.items.map((it) => (it.str || '') + (it.hasEOL ? ' ' : '')).join('').replace(/\s+/g, ' ').trim();
}

// ב-PDF.js 6 משחררים מסמך דרך loadingTask (ל-PDFDocumentProxy אין destroy)
export async function destroyDoc(doc) {
  try { await doc?.loadingTask?.destroy(); } catch { /* ignore */ }
}
