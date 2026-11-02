// הדגשת שינויים בין שתי גרסאות: מרנדר את שתי התוכניות ברזולוציית המסך ומחשב איפה יש "דיו" רק באחת מהן.
// אדום = קיים רק בפתוחה, כחול = קיים רק בתוכנית להשוואה, אפור = זהה (מוחלש לפי עוצמת ההדגשה).
// tol = סטייה מותרת בפיקסלים (מתעלם מהזזות קטנות/אי-יישור קל).
// מסנן מקסימום/מינימום מהיר (חלון ריבועי ברדיוס r) – בשיטת הכפלת חלון, בלי תלות ברדיוס
function winPass(src, n, stride, count, step, r, isMax) {
  // src: מערך; לכל "שורה" (count שורות באורך n, מרחק step בין איברים, stride בין תחילת שורות)
  const L = 2 * r + 1, out = new Uint8Array(src.length);
  let cur = src, len = 1;
  const op = isMax ? Math.max : Math.min;
  const at = (arr, base, i) => arr[base + (i < 0 ? 0 : i >= n ? n - 1 : i) * step];
  while (len * 2 <= L) {
    const nxt = new Uint8Array(src.length);
    for (let q = 0; q < count; q++) { const base = q * stride; for (let i = 0; i < n; i++) nxt[base + i * step] = op(at(cur, base, i), at(cur, base, i + len)); }
    cur = nxt; len *= 2;
  }
  for (let q = 0; q < count; q++) { const base = q * stride; for (let i = 0; i < n; i++) { const s0 = i - r; out[base + i * step] = op(at(cur, base, s0), at(cur, base, s0 + L - len)); } }
  return out;
}
function filt(src, w, h, r, isMax) {
  if (r < 1) return src;
  return winPass(winPass(src, w, w, h, 1, r, isMax), h, 1, w, w, r, isMax);
}
const maxFilter = (src, w, h, r) => filt(src, w, h, r, true);
// סגירה (dilate ואז erode): מגשרת על פערים קטנים – קו מקווקו הופך לרציף (רק לצורך ההשוואה, לא לתצוגה)
const closeGaps = (src, w, h, r) => (r < 1 ? src : filt(filt(src, w, h, r, true), w, h, r, false));

async function inkOf(L, w, h, signalCancel) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  const rotation = ((((L.page.rotate || 0) + (L.rot || 0)) % 360) + 360) % 360;
  const task = L.page.render({ canvasContext: ctx, viewport: L.page.getViewport({ scale: L.k, rotation }), transform: [1, 0, 0, 1, L.ox, L.oy], background: 'rgba(0,0,0,0)' });
  signalCancel(() => task.cancel());
  await task.promise;
  const px = ctx.getImageData(0, 0, w, h).data, ink = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < ink.length; i += 4, j++) ink[j] = 255 - ((px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8);
  c.width = c.height = 0;
  return ink;
}

// A,B: { page, k, ox, oy, rot } (בפיקסלי מכשיר). מחזיר canvas בגודל w×h, או null אם בוטל.
// edits: עריכות ידניות של המשתמש, בפיקסלים של הקנבס: [{ mode: 'ignore'|'add', x0, y0, x1, y1 }] (האחרונה גוברת).
//   ignore = "זה לא שינוי": באזור הזה לא מסמנים הבדלים. add = "פספוס": באזור הזה מסמנים כל הבדל בין הקווים (בלי סובלנות להזזות).
// side: true = מחזיר { left, right }: כל תוכנית בנפרד (A מצד אחד, B מהצד השני), ובכל אחת רק הסימון ששייך לה בצבע שלה.
const rgb = (hex, def) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return def; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
export async function renderChangesCanvas({ A, B, w, h, emphasis = 0.6, tol = 1.5, gap = 0, colA, colB, colS, edits = [], side = false, onCancel }) {
  let cancels = [];
  if (onCancel) onCancel(() => cancels.forEach((f) => { try { f(); } catch { /* ignore */ } }));
  const reg = (f) => cancels.push(f);
  let ia, ib;
  try { ia = await inkOf(A, w, h, reg); ib = await inkOf(B, w, h, reg); } catch (e) { if (e && e.name === 'RenderingCancelledException') return null; throw e; }
  const r = Math.round(tol);
  const g = Math.min(60, Math.round(gap));
  const da = maxFilter(closeGaps(ia, w, h, g), w, h, r), db = maxFilter(closeGaps(ib, w, h, g), w, h, r);
  let mask = null;
  if (edits && edits.length) {
    mask = new Uint8Array(w * h);
    for (const e of edits) {
      const x0 = Math.max(0, Math.floor(Math.min(e.x0, e.x1))), x1 = Math.min(w, Math.ceil(Math.max(e.x0, e.x1)));
      const y0 = Math.max(0, Math.floor(Math.min(e.y0, e.y1))), y1 = Math.min(h, Math.ceil(Math.max(e.y0, e.y1)));
      const v = e.mode === 'add' ? 2 : 1;
      for (let y = y0; y < y1; y++) mask.fill(v, y * w + x0, y * w + x1);
    }
  }
  const cA = rgb(colA, [229, 57, 53]), cB = rgb(colB, [30, 99, 255]), cS = rgb(colS, [0, 0, 0]);
  const mix = (t, c) => [255 - t * (255 - c[0]), 255 - t * (255 - c[1]), 255 - t * (255 - c[2])]; // t = כמה דיו (0..1) בצבע c על לבן
  const e = Math.max(0, Math.min(1, emphasis)), strength = (1 + 3 * e) * 1.5, keep = side ? 1 - 0.5 * e : 1 - 0.8 * e;
  const out = new ImageData(w, h), o = out.data;
  const out2 = side ? new ImageData(w, h) : null, o2 = out2 ? out2.data : null;
  for (let i = 0, p = 0; i < ia.length; i++, p += 4) {
    const a = ia[i], b = ib[i];
    let onlyA = a > db[i] ? a - db[i] : 0, onlyB = b > da[i] ? b - da[i] : 0;
    const m = mask ? mask[i] : 0;
    if (m === 1) { onlyA = 0; onlyB = 0; } else if (m === 2) { onlyA = a > b ? a - b : 0; onlyB = b > a ? b - a : 0; }
    if (side) {
      let [R, G, Bl] = mix(((a - onlyA) * keep) / 255, cS);
      if (onlyA) { const t = Math.min(1, (onlyA / 255) * strength); R = R * (1 - t) + cA[0] * t; G = G * (1 - t) + cA[1] * t; Bl = Bl * (1 - t) + cA[2] * t; }
      o[p] = R; o[p + 1] = G; o[p + 2] = Bl; o[p + 3] = 255;
      let [R2, G2, B2] = mix(((b - onlyB) * keep) / 255, cS);
      if (onlyB) { const t = Math.min(1, (onlyB / 255) * strength); R2 = R2 * (1 - t) + cB[0] * t; G2 = G2 * (1 - t) + cB[1] * t; B2 = B2 * (1 - t) + cB[2] * t; }
      o2[p] = R2; o2[p + 1] = G2; o2[p + 2] = B2; o2[p + 3] = 255;
      continue;
    }
    const common = ((a - onlyA) + (b - onlyB)) / 2;
    let [R, G, Bl] = mix((common * keep) / 255, cS);
    if (onlyA) { const t = Math.min(1, (onlyA / 255) * strength); R = R * (1 - t) + cA[0] * t; G = G * (1 - t) + cA[1] * t; Bl = Bl * (1 - t) + cA[2] * t; }
    if (onlyB) { const t = Math.min(1, (onlyB / 255) * strength); R = R * (1 - t) + cB[0] * t; G = G * (1 - t) + cB[1] * t; Bl = Bl * (1 - t) + cB[2] * t; }
    o[p] = R; o[p + 1] = G; o[p + 2] = Bl; o[p + 3] = 255;
  }
  const mk = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(img, 0, 0); return c; };
  if (side) return { left: mk(out), right: mk(out2) };
  return mk(out);
}
