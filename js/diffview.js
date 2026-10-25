// הדגשת שינויים בין שתי גרסאות: מרנדר את שתי התוכניות ברזולוציית המסך ומחשב איפה יש "דיו" רק באחת מהן.
// אדום = קיים רק בפתוחה, כחול = קיים רק בתוכנית להשוואה, אפור = זהה (מוחלש לפי עוצמת ההדגשה).
// tol = סטייה מותרת בפיקסלים (מתעלם מהזזות קטנות/אי-יישור קל).
function maxFilter(src, w, h, r) {
  if (r < 1) return src;
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let i = a; i <= b; i++) { const v = src[row + i]; if (v > m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0; const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let i = a; i <= b; i++) { const v = tmp[i * w + x]; if (v > m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

async function inkOf(L, w, h, signalCancel) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  const task = L.page.render({ canvasContext: ctx, viewport: L.page.getViewport({ scale: L.k }), transform: [1, 0, 0, 1, L.ox, L.oy], background: 'rgba(0,0,0,0)' });
  signalCancel(() => task.cancel());
  await task.promise;
  const px = ctx.getImageData(0, 0, w, h).data, ink = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < ink.length; i += 4, j++) ink[j] = 255 - ((px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8);
  c.width = c.height = 0;
  return ink;
}

// A,B: { page, k, ox, oy } (בפיקסלי מכשיר). מחזיר canvas בגודל w×h, או null אם בוטל.
const rgb = (hex, def) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return def; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
export async function renderChangesCanvas({ A, B, w, h, emphasis = 0.6, tol = 1.5, colA, colB, onCancel }) {
  let cancels = [];
  if (onCancel) onCancel(() => cancels.forEach((f) => { try { f(); } catch { /* ignore */ } }));
  const reg = (f) => cancels.push(f);
  let ia, ib;
  try { ia = await inkOf(A, w, h, reg); ib = await inkOf(B, w, h, reg); } catch (e) { if (e && e.name === 'RenderingCancelledException') return null; throw e; }
  const r = Math.round(tol);
  const da = maxFilter(ia, w, h, r), db = maxFilter(ib, w, h, r);
  const out = new ImageData(w, h), o = out.data;
  const cA = rgb(colA, [229, 57, 53]), cB = rgb(colB, [30, 99, 255]);
  const e = Math.max(0, Math.min(1, emphasis)), strength = (1 + 3 * e) * 1.5, keep = 1 - 0.8 * e;
  for (let i = 0, p = 0; i < ia.length; i++, p += 4) {
    const a = ia[i], b = ib[i];
    const onlyA = a > db[i] ? a - db[i] : 0, onlyB = b > da[i] ? b - da[i] : 0;
    const common = ((a - onlyA) + (b - onlyB)) / 2;
    let R = 255 - common * keep, G = R, Bl = R;
    if (onlyA) { const t = Math.min(1, (onlyA / 255) * strength); R = R * (1 - t) + cA[0] * t; G = G * (1 - t) + cA[1] * t; Bl = Bl * (1 - t) + cA[2] * t; }
    if (onlyB) { const t = Math.min(1, (onlyB / 255) * strength); R = R * (1 - t) + cB[0] * t; G = G * (1 - t) + cB[1] * t; Bl = Bl * (1 - t) + cB[2] * t; }
    o[p] = R; o[p + 1] = G; o[p + 2] = Bl; o[p + 3] = 255;
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}
