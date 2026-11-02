// יישור אוטומטי בין שתי תוכניות (השוואה): מחפש הזזה + קנה מידה (ואם צריך סיבוב 90°) שמתאימים ביותר בין הקווים של שתי התוכניות.
// איך זה עובד: מציירים כל תוכנית כ"דיו" (כהה = קו), מטשטשים מעט, ומחפשים את ההתאמה הטובה ביותר (מתאם מנורמל, NCC):
//   1. חיפוש גס בכל קני המידה האפשריים באמצעות FFT על תמונה קטנה (עובד גם כשתוכנית אחת היא חלק קטן מהאחרת – מנסים את שני הכיוונים);
//   2. שני שלבי חידוד ברזולוציה גבוהה יותר סביב המועמדים הטובים ביותר, עד דיוק של בערך פיקסל אחד.
// התוצאה: s, dx, dy כך שנקודה u בתוכנית ההשוואה (ביחידות עמוד) נמצאת בתוכנית הפתוחה ב- dx + s*u (ואותו דבר לציר y).
// זו התאמה חזותית בלבד: אם התוכניות לא דומות מספיק (או שאין בהן קווים משותפים) היא תדווח שלא נמצאה התאמה.

const tick = () => new Promise((r) => setTimeout(r, 0));
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// ---------- FFT דו-ממדי (רדיקס 2, במקום) ----------
function fftTable(n) {
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n), cos = new Float64Array(Math.max(1, n >> 1)), sin = new Float64Array(Math.max(1, n >> 1));
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < (n >> 1); i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return { rev, cos, sin, n };
}
function fft1(re, im, off, stride, tab, inv) {
  const { rev, cos, sin, n } = tab;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { const a = off + i * stride, b = off + j * stride; let t = re[a]; re[a] = re[b]; re[b] = t; t = im[a]; im[a] = im[b]; im[b] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t], wi = inv ? sin[t] : -sin[t];
        const a = off + (start + k) * stride, b = off + (start + k + half) * stride;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}
function fft2(re, im, W, H, tabW, tabH, inv) {
  for (let y = 0; y < H; y++) fft1(re, im, y * W, 1, tabW, inv);
  for (let x = 0; x < W; x++) fft1(re, im, x, W, tabH, inv);
}

// ---------- תמונות "דיו" ----------
async function renderCanvas(page, rot, k) {
  const vp = page.getViewport({ scale: k, rotation: ((((page.rotate || 0) + rot) % 360) + 360) % 360 });
  const w = Math.max(1, Math.ceil(vp.width)), h = Math.max(1, Math.ceil(vp.height));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
  // מתעלמים משולי הדף (מסגרת הגיליון וכדומה): הם מבלבלים את ההתאמה כשתוכנית אחת היא חלק מהאחרת
  const bx = Math.round(w * 0.045), by = Math.round(h * 0.045);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, by); ctx.fillRect(0, h - by, w, by); ctx.fillRect(0, 0, bx, h); ctx.fillRect(w - bx, 0, bx, h);
  return { c, w, h, k };
}
const dimsOf = (page, rot) => { const vp = page.getViewport({ scale: 1, rotation: ((((page.rotate || 0) + rot) % 360) + 360) % 360 }); return { w: vp.width, h: vp.height }; };

// מדגם אזור מקנבס לגודל חדש (בהקטנות גדולות – בכמה שלבי חצייה, כדי לשמור על קווים דקים) והופך לדיו 0..1
function sampleInk(src, sx, sy, sw, sh, dw, dh) {
  let cur = src, cx = sx, cy = sy, cw = sw, ch = sh, tmp = null;
  while (cw / dw > 2.2 || ch / dh > 2.2) {
    const nw = Math.max(dw, Math.round(cw / 2)), nh = Math.max(dh, Math.round(ch / 2));
    const c2 = document.createElement('canvas'); c2.width = nw; c2.height = nh;
    const x2 = c2.getContext('2d'); x2.fillStyle = '#fff'; x2.fillRect(0, 0, nw, nh);
    x2.imageSmoothingEnabled = true; x2.imageSmoothingQuality = 'high';
    x2.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    if (tmp) { tmp.width = tmp.height = 0; }
    tmp = c2; cur = c2; cx = 0; cy = 0; cw = nw; ch = nh;
  }
  const c3 = document.createElement('canvas'); c3.width = dw; c3.height = dh;
  const x3 = c3.getContext('2d', { willReadFrequently: true }); x3.fillStyle = '#fff'; x3.fillRect(0, 0, dw, dh);
  x3.imageSmoothingEnabled = true; x3.imageSmoothingQuality = 'high';
  x3.drawImage(cur, cx, cy, cw, ch, 0, 0, dw, dh);
  const d = x3.getImageData(0, 0, dw, dh).data, out = new Float32Array(dw * dh);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (255 - Math.min(d[i], d[i + 1], d[i + 2])) / 255;
  c3.width = c3.height = 0; if (tmp) tmp.width = tmp.height = 0;
  return out;
}
function boxBlur(a, w, h, r) {
  if (r < 1) return a;
  const t = new Float32Array(a.length), o = new Float32Array(a.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { t[row + x] = s / n; s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { o[y * w + x] = s / n; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
  }
  return o;
}
const blur2 = (a, w, h, r) => boxBlur(boxBlur(a, w, h, r), w, h, r);

// תיבת התוכן (דיו) של תבנית, ביחידות פיקסל של הקנבס
function inkBox(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true }), w = c.width, h = c.height, d = ctx.getImageData(0, 0, w, h).data;
  const rows = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) if (Math.min(d[i], d[i + 1], d[i + 2]) < 200) { rows[y]++; cols[x]++; }
  const first = (arr) => { for (let i = 0; i < arr.length; i++) if (arr[i] >= 2) return i; return -1; };
  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
  const x0 = first(cols), x1 = last(cols), y0 = first(rows), y1 = last(rows);
  if (x0 < 0 || y0 < 0 || x1 - x0 < 6 || y1 - y0 < 6) return null;
  const pad = 2;
  const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad), X1 = Math.min(w, x1 + 1 + pad), Y1 = Math.min(h, y1 + 1 + pad);
  return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
}

// סכומי חלון: אינטגרל של S ושל S^2 (עם שוליים של אפסים)
function integrals(S, w, h) {
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1)), I2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let r = 0, r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = S[y * w + x]; r += v; r2 += v * v;
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + r; I2[(y + 1) * W1 + x + 1] = I2[y * W1 + x + 1] + r2;
    }
  }
  return { I, I2, W1 };
}
const dens = (S) => { const D = new Float32Array(S.length); for (let i = 0; i < S.length; i++) D[i] = Math.min(1, S[i] * 2.5); return D; };
function integral1(S, w, h) {
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) { let r = 0; for (let x = 0; x < w; x++) { r += S[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + r; } }
  return I;
}
// ציון "כיסוי מעבר למקרה": איזה חלק מהקווים של התבנית נמצא בקווים של הסצנה, פחות מה שהיה מכסה במקרה (צפיפות הסצנה בחלון).
// בניגוד ל-NCC, קווים נוספים בסצנה (למשל בניינים אחרים) לא פוגעים בציון – מתאים כשתוכנית אחת היא חלק מהאחרת.
const kappaOf = (cov, d) => Math.max(-1, Math.min(1, (cov - d) / (1 - d + 0.02)));
const win = (J, W1, x, y, w, h) => J[(y + h) * W1 + x + w] - J[y * W1 + x + w] - J[(y + h) * W1 + x] + J[y * W1 + x];
const EPS = 2e-3;
// תבנית קטנה מאוד מתאימה בטעות כמעט לכל דבר, לכן מורידים משקל להתאמות שמכסות רק חלק זעיר מהתוכנית השנייה
const covW = (cov) => Math.min(1, Math.sqrt(cov / 0.08));

// תבנית דלילה (רק פיקסלים עם דיו) להערכה מהירה בחיפוש מקומי
function sparse(T, tw, th, W) {
  const idx = [], val = [];
  let sum = 0, sum2 = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const v = T[y * tw + x];
    if (v >= 0.05) { idx.push(y * W + x); val.push(v); sum += v; sum2 += v * v; }
  }
  const n = tw * th, mu = sum / n;
  return { idx: Int32Array.from(idx), val: Float32Array.from(val), mu, st2: Math.max(1e-9, sum2 - n * mu * mu), n, tw, th, sum };
}
function kappaSparse(Sd, W1s, Jd, tpl, x, y, W) {
  const { idx, val, n, tw, th, sum } = tpl;
  const base = y * W + x;
  let cov = 0;
  for (let i = 0; i < idx.length; i++) cov += Sd[base + idx[i]] * val[i];
  return kappaOf(sum > 0 ? cov / sum : 0, win(Jd, W1s, x, y, tw, th) / n) * Math.min(1, idx.length / 120);
}
function nccSparse(S, W1s, Ji, tpl, x, y, W) {
  const { idx, val, mu, st2, n, tw, th } = tpl;
  const base = y * W + x;
  let num = 0;
  for (let i = 0; i < idx.length; i++) num += S[base + idx[i]] * val[i];
  const SA = win(Ji.I, Ji.W1, x, y, tw, th), SA2 = win(Ji.I2, Ji.W1, x, y, tw, th);
  num -= mu * SA;
  const varS = SA2 - (SA * SA) / n + n * EPS;
  return num / Math.sqrt(Math.max(1e-12, varS * st2));
}

// ---------- הפונקציה הראשית ----------
// ctl: { cancelled:boolean, progress(text, frac) }
export async function autoAlign({ pageA, rotA, pageB, ctl = {} }) {
  const prog = (t, f) => { try { ctl.progress?.(t, f); } catch { /* ignore */ } };
  const dA = dimsOf(pageA, rotA);
  const dB0 = dimsOf(pageB, rotA);
  const first = (dA.w >= dA.h) === (dB0.w >= dB0.h) ? [0] : [0, 90, 270];
  let best = await searchRots({ pageA, rotA, pageB, rels: first, prog, ctl, lo: 0, hi: first.length < 4 ? 0.6 : 1 });
  if (ctl.cancelled) return { ok: false, cancelled: true };
  if ((!best || best.score < 0.25) && first.length < 4) {
    const rest = [0, 90, 180, 270].filter((r) => !first.includes(r));
    const b2 = await searchRots({ pageA, rotA, pageB, rels: rest, prog, ctl, lo: 0.6, hi: 1, label: 'מנסה גם עם סיבוב…' });
    if (ctl.cancelled) return { ok: false, cancelled: true };
    if (b2 && (!best || b2.score > best.score)) best = b2;
  }
  if (!best) return { ok: false, score: 0 };
  return { ok: best.raw >= 0.18 && best.cov >= 0.01, ...best };
}

async function searchRots({ pageA, rotA, pageB, rels, prog, ctl, lo, hi, label }) {
  const cands = [];
  const steps = rels.length * 2, mid = lo + (hi - lo) * 0.6;
  let stepNo = 0;
  for (const rel of rels) {
    const rotB = (rotA + rel) % 360;
    for (const dir of [1, 2]) {
      if (ctl.cancelled) return null;
      const n0 = stepNo;
      const res = await coarseSearch({ pageA, rotA, pageB, rotB, dir, prog: (f) => prog(label || 'מחפש התאמה…', lo + (mid - lo) * ((n0 + f) / steps)), ctl });
      stepNo++;
      if (res) for (const c of res) cands.push({ ...c, dir, rotB });
      await tick();
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  if (window.__aaDebug) console.log('AA cands', JSON.stringify(cands.slice(0, 8).map((c) => ({ dir: c.dir, rot: c.rotB, t: +c.t.toFixed(3), xs: +c.xs.toFixed(3), ys: +c.ys.toFixed(3), sc: +c.score.toFixed(3) }))));
  // עד 3 מועמדים שונים
  const pick = [];
  for (const c of cands) {
    if (pick.length >= 3) break;
    if (pick.some((p) => p.dir === c.dir && p.rotB === c.rotB && Math.abs(Math.log(p.t / c.t)) < 0.12 && Math.hypot(p.xs - c.xs, p.ys - c.ys) < 0.06)) continue;
    pick.push(c);
  }
  let bestFinal = null;
  for (let i = 0; i < pick.length; i++) {
    if (ctl.cancelled) return null;
    prog('מחדד את היישור…', mid + (hi - mid) * (i / pick.length));
    let r;
    try { r = await refine({ pageA, rotA, pageB, c: pick[i], ctl }); } catch (e) { console.error(e); r = null; }
    if (window.__aaDebug) console.log('AA refine', i, JSON.stringify(r));
    ctl.debug?.({ pick: { dir: pick[i].dir, t: pick[i].t, xs: pick[i].xs, ys: pick[i].ys, score: pick[i].score }, final: r && { score: r.score, s: r.s, dx: r.dx, dy: r.dy } });
    if (r && (!bestFinal || r.score > bestFinal.score)) bestFinal = r;
    await tick();
  }
  return bestFinal;
}

// ---------- שלב 1: חיפוש גס ב-FFT ----------
// מחזיר את המועמדים הטובים ביותר: { t, xs, ys (מיקום יחסי 0..1 של פינת התבנית בתוך הסצנה), score }
async function coarseSearch({ pageA, rotA, pageB, rotB, dir, prog, ctl }) {
  const scenePage = dir === 1 ? pageA : pageB, sceneRot = dir === 1 ? rotA : rotB;
  const tmplPage = dir === 1 ? pageB : pageA, tmplRot = dir === 1 ? rotB : rotA;
  const sd = dimsOf(scenePage, sceneRot), td = dimsOf(tmplPage, tmplRot);
  const SIDE = 160;
  const kS = SIDE / Math.max(sd.w, sd.h);
  const sc = await renderCanvas(scenePage, sceneRot, kS);
  const M = Math.round(0.1 * Math.max(sc.w, sc.h));
  const pw = sc.w + 2 * M, ph = sc.h + 2 * M, Nx = pow2(pw), Ny = pow2(ph);
  const S0 = boxBlur(sampleInk(sc.c, 0, 0, sc.w, sc.h, sc.w, sc.h), sc.w, sc.h, 1);
  const S = new Float32Array(pw * ph);
  for (let y = 0; y < sc.h; y++) S.set(S0.subarray(y * sc.w, (y + 1) * sc.w), (y + M) * pw + M);
  sc.c.width = sc.c.height = 0;
  const Ji = integrals(S, pw, ph);
  const tabX = fftTable(Nx), tabY = fftTable(Ny);
  const sRe = new Float32Array(Nx * Ny), sIm = new Float32Array(Nx * Ny);
  for (let y = 0; y < ph; y++) sRe.set(S.subarray(y * pw, (y + 1) * pw), y * Nx);
  fft2(sRe, sIm, Nx, Ny, tabX, tabY, false);

  const kT = 640 / Math.max(td.w, td.h);
  const tc = await renderCanvas(tmplPage, tmplRot, kT);
  const box = inkBox(tc.c);
  if (!box) { tc.c.width = tc.c.height = 0; return null; }
  const cwPt = box.w / kT, chPt = box.h / kT;
  const tMax = Math.min(pw / (cwPt * kS), ph / (chPt * kS)) * 1.02, tMin = tMax * 0.08;
  const tr = new Float32Array(Nx * Ny), ti = new Float32Array(Nx * Ny);
  const out = [];
  const ts = [];
  for (let t = tMax; t >= tMin; t /= 1.045) ts.push(t);
  for (let i = 0; i < ts.length; i++) {
    if (ctl.cancelled) break;
    const t = ts[i];
    const tw = Math.round(cwPt * t * kS), th = Math.round(chPt * t * kS);
    if (tw < 18 || th < 18 || tw > pw || th > ph) continue;
    const T = blur2(sampleInk(tc.c, box.x, box.y, box.w, box.h, tw, th), tw, th, 1);
    let sum = 0; for (let j = 0; j < T.length; j++) sum += T[j];
    const n = tw * th, mu = sum / n;
    tr.fill(0); ti.fill(0);
    let st2 = 0;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const v = T[y * tw + x] - mu; tr[y * Nx + x] = v; st2 += v * v; }
    if (st2 < 1e-6) continue;
    fft2(tr, ti, Nx, Ny, tabX, tabY, false);
    for (let j = 0; j < tr.length; j++) { const a = sRe[j], b = sIm[j], c = tr[j], d = ti[j]; tr[j] = a * c + b * d; ti[j] = b * c - a * d; }
    fft2(tr, ti, Nx, Ny, tabX, tabY, true);
    const norm = 1 / (Nx * Ny);
    let bs = -1, bx = 0, by = 0;
    for (let y = 0; y + th <= ph; y++) {
      for (let x = 0; x + tw <= pw; x++) {
        const SA = win(Ji.I, Ji.W1, x, y, tw, th), SA2 = win(Ji.I2, Ji.W1, x, y, tw, th);
        const varS = SA2 - (SA * SA) / n + n * EPS;
        const v = (tr[y * Nx + x] * norm) / Math.sqrt(Math.max(1e-12, varS * st2));
        if (v > bs) { bs = v; bx = x; by = y; }
      }
    }
    if (bs > 0) out.push({ t, xs: (bx - M) / sc.w, ys: (by - M) / sc.h, raw: bs, score: bs * covW((tw * th) / (sc.w * sc.h)), cwPt, chPt, cxPt: box.x / kT, cyPt: box.y / kT, sdw: sd.w, sdh: sd.h });
    if (i % 4 === 0) { prog(i / ts.length); await tick(); }
  }
  tc.c.width = tc.c.height = 0;
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 4);
}

// ---------- שלבים 2 ו-3: חידוד מקומי ברזולוציה גבוהה ----------
async function refine({ pageA, rotA, pageB, c, ctl }) {
  const dir = c.dir;
  const scenePage = dir === 1 ? pageA : pageB, sceneRot = dir === 1 ? rotA : rotB(c);
  const tmplPage = dir === 1 ? pageB : pageA, tmplRot = dir === 1 ? rotB(c) : rotA;
  let cur = { t: c.t, ox: c.xs * c.sdw, oy: c.ys * c.sdh, score: c.score }; // מיקום פינת התבנית בסצנה, ביחידות עמוד
  const stages = [
    { side: 640, sc: 1.02, nsc: 3, R: 12, step: 2, fine: 2 },
    { side: 1280, sc: 1.0035, nsc: 3, R: 9, step: 3, fine: 2 },
    { side: 1280, sc: 1.001, nsc: 4, R: 5, step: 2, fine: 1 },
  ];
  let final = null;
  for (const st of stages) {
    if (ctl.cancelled) return null;
    const kS = st.side / Math.max(c.sdw, c.sdh);
    const scn = await renderCanvas(scenePage, sceneRot, kS);
    const M = Math.round(0.08 * Math.max(scn.w, scn.h));
    const pw = scn.w + 2 * M, ph = scn.h + 2 * M;
    const S0 = blur2(sampleInk(scn.c, 0, 0, scn.w, scn.h, scn.w, scn.h), scn.w, scn.h, 1);
    scn.c.width = scn.c.height = 0;
    const S = new Float32Array(pw * ph);
    for (let y = 0; y < scn.h; y++) S.set(S0.subarray(y * scn.w, (y + 1) * scn.w), (y + M) * pw + M);
    const Ji = integrals(S, pw, ph);
    const kT = cur.t * kS;
    const tcv = await renderCanvas(tmplPage, tmplRot, kT);
    const sx = c.cxPt * kT, sy = c.cyPt * kT, sw = c.cwPt * kT, sh = c.chPt * kT;
    let bestAll = null;
    for (let i = -st.nsc; i <= st.nsc; i++) {
      if (ctl.cancelled) { tcv.c.width = tcv.c.height = 0; return null; }
      const t = cur.t * Math.pow(st.sc, i);
      const tw = Math.round(c.cwPt * t * kS), th = Math.round(c.chPt * t * kS);
      if (tw < 8 || th < 8 || tw > pw || th > ph) continue;
      const T = blur2(sampleInk(tcv.c, Math.max(0, sx), Math.max(0, sy), Math.min(sw, tcv.w - Math.max(0, sx)), Math.min(sh, tcv.h - Math.max(0, sy)), tw, th), tw, th, 1);
      const tpl = sparse(T, tw, th, pw);
      const px = Math.round(cur.ox * kS) + M, py = Math.round(cur.oy * kS) + M;
      let b = { v: -2, x: px, y: py };
      const scan = (cx, cy, R, stp) => {
        for (let y = cy - R; y <= cy + R; y += stp) for (let x = cx - R; x <= cx + R; x += stp) {
          if (x < 0 || y < 0 || x + tw > pw || y + th > ph) continue;
          const v = nccSparse(S, Ji.W1, Ji, tpl, x, y, pw);
          if (v > b.v) b = { v, x, y };
        }
      };
      scan(px, py, st.R, st.step);
      scan(b.x, b.y, st.fine, 1);
      // דיוק תת-פיקסל (פרבולה) בכל ציר
      let fx = b.x, fy = b.y;
      if (b.v > -1) {
        const at = (x, y) => (x < 0 || y < 0 || x + tw > pw || y + th > ph ? null : nccSparse(S, Ji.W1, Ji, tpl, x, y, pw));
        const l = at(b.x - 1, b.y), r = at(b.x + 1, b.y), u = at(b.x, b.y - 1), d = at(b.x, b.y + 1);
        const par = (m, c0, p) => { if (m == null || p == null) return 0; const den = m - 2 * c0 + p; return Math.abs(den) < 1e-9 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / den)); };
        fx += par(l, b.v, r); fy += par(u, b.v, d);
      }
      if (!bestAll || b.v > bestAll.v) bestAll = { v: b.v, t, ox: (fx - M) / kS, oy: (fy - M) / kS };
      await tick();
    }
    tcv.c.width = tcv.c.height = 0;
    if (!bestAll) return null;
    cur = { t: bestAll.t, ox: bestAll.ox, oy: bestAll.oy, score: bestAll.v };
    final = cur;
  }
  if (!final) return null;
  // המרה למיפוי "תוכנית ההשוואה -> הפתוחה": x_A = dx + s*u
  const DX = final.ox - final.t * c.cxPt, DY = final.oy - final.t * c.cyPt;
  let s, dx, dy;
  if (dir === 1) { s = final.t; dx = DX; dy = DY; } else { s = 1 / final.t; dx = -DX / final.t; dy = -DY / final.t; }
  const cov = (c.cwPt * final.t * c.chPt * final.t) / (c.sdw * c.sdh);
  return { score: final.score * covW(cov), raw: final.score, cov, s, dx, dy, rotB: rotB(c), dir };
}
const rotB = (c) => c.rotB;
