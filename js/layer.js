// שכבת עמוד: קנבס בסיס (כל העמוד ברזולוציה בינונית, להצגה מיידית)
// + קנבס פירוט (רק האזור הנראה ברזולוציה מלאה, נצבע מחדש אחרי כל זום/הזזה).
// כך אפשר להגדיל עד רמות גבוהות מאוד בלי ליצור קנבס ענק, והקווים והטקסט נשארים חדים.

function tintCanvas(ctx, x, y, w, hh, color) {
  // טשטוש צבע: קווים שחורים הופכים לצבע, רקע לבן נשאר לבן
  ctx.save();
  ctx.globalCompositeOperation = 'lighten';
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, hh);
  ctx.restore();
}

let COARSE = false; try { COARSE = matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
const MAX_DETAIL_PIXELS = COARSE ? 7e6 : 16e6; // בטלפון קנבס גדול מדי גורם לקריסת הדף
// "פירור" אבחוני: נשמר לפני רינדור כבד; אם הדף קורס, בפתיחה הבאה אפשר לראות מה קרה (ביומן התקלות)
// תקרת רזולוציית רינדור (פיקסלי מכשיר לנקודת עמוד). בטלפון ברירת מחדל 64; אם הדף קרס באמצע רינדור – האפליקציה מורידה אותה אוטומטית (ראו app.js), כך שהזום נשאר מלא והחדות יורדת רק כמה שהמכשיר צריך
export const safeK = () => { try { const v = parseFloat(localStorage.getItem('plans.safeK')); if (v > 0) return v; } catch { /* ignore */ } return COARSE ? 64 : Infinity; };
const crumb = (o) => { try { localStorage.setItem('plans.crumb', JSON.stringify({ ...o, t: Date.now() })); } catch { /* ignore */ } };
const MAX_BASE_PIXELS = 14e6;



// Path2D "עצל": רושם את הפקודות ב-JS (מערך מספרים) ואת תיבת הגבולות, ויוצר Path2D מקורי רק כשבאמת מציירים אותו.
// pdf.js בונה Path2D לכל קו בכל רינדור; בתוכנית CAD עם 650 אלף קווים זה אלפי מגה-בתים של זיכרון מקורי ש-GC של JS לא "מרגיש"
// (הערימה קטנה) ולכן לא נאסף בזמן – וזו הייתה סיבת הקריסה בזום גבוה. כאן קווים שמחוץ למסך אפילו לא נוצרים כנתיב מקורי.
if (typeof Path2D !== 'undefined' && !Path2D.__lazy) {
  const Real = Path2D;
  const grow = (o, x, y) => { if (x < o._x0) o._x0 = x; if (x > o._x1) o._x1 = x; if (y < o._y0) o._y0 = y; if (y > o._y1) o._y1 = y; };
  class LazyPath2D {
    constructor(src) {
      this._c = []; this._g = null; this._real = null;
      this._x0 = this._y0 = Infinity; this._x1 = this._y1 = -Infinity; this._unk = false;
      if (src instanceof LazyPath2D) { this._c = src._c.slice(); this._g = src._g ? src._g.slice() : null; this._x0 = src._x0; this._y0 = src._y0; this._x1 = src._x1; this._y1 = src._y1; this._unk = src._unk; }
      else if (src !== undefined && src !== null) { this._real = new Real(src); this._unk = true; }
    }
    moveTo(x, y) { grow(this, x, y); this._c.push(0, x, y); }
    lineTo(x, y) { grow(this, x, y); this._c.push(1, x, y); }
    bezierCurveTo(a, b, c, d, x, y) { grow(this, a, b); grow(this, c, d); grow(this, x, y); this._c.push(2, a, b, c, d, x, y); }
    quadraticCurveTo(a, b, x, y) { grow(this, a, b); grow(this, x, y); this._c.push(3, a, b, x, y); }
    closePath() { this._c.push(4); }
    rect(x, y, w, h) { grow(this, x, y); grow(this, x + w, y + h); this._c.push(5, x, y, w, h); }
    _gen(name, args) { this._unk = true; (this._g || (this._g = [])).push([name, args]); this._c.push(6, this._g.length - 1); }
    arc(...a) { this._gen('arc', a); }
    arcTo(...a) { this._gen('arcTo', a); }
    ellipse(...a) { this._gen('ellipse', a); }
    roundRect(...a) { this._gen('roundRect', a); }
    addPath(p, m) { this._unk = true; this._gen('addPath', [p, m]); }
    toReal() {
      const r = this._real ? new Real(this._real) : new Real();
      const c = this._c;
      for (let i = 0; i < c.length;) {
        switch (c[i++]) {
          case 0: r.moveTo(c[i++], c[i++]); break;
          case 1: r.lineTo(c[i++], c[i++]); break;
          case 2: r.bezierCurveTo(c[i++], c[i++], c[i++], c[i++], c[i++], c[i++]); break;
          case 3: r.quadraticCurveTo(c[i++], c[i++], c[i++], c[i++]); break;
          case 4: r.closePath(); break;
          case 5: r.rect(c[i++], c[i++], c[i++], c[i++]); break;
          default: { const [n, a] = this._g[c[i++]]; if (n === 'addPath') r.addPath(a[0] instanceof LazyPath2D ? a[0].toReal() : a[0], a[1]); else r[n](...a); }
        }
      }
      return r;
    }
  }
  LazyPath2D.__lazy = true;
  const un = (p) => (p instanceof LazyPath2D ? p.toReal() : p);
  const cp = CanvasRenderingContext2D.prototype;
  for (const n of ['stroke', 'fill', 'clip', 'isPointInPath', 'isPointInStroke']) {
    const f = cp[n];
    cp[n] = function (...a) { if (a[0] instanceof LazyPath2D) a[0] = a[0].toReal(); return f.apply(this, a); };
  }
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const op = OffscreenCanvasRenderingContext2D.prototype;
    for (const n of ['stroke', 'fill', 'clip', 'isPointInPath', 'isPointInStroke']) { const f = op[n]; op[n] = function (...a) { if (a[0] instanceof LazyPath2D) a[0] = a[0].toReal(); return f.apply(this, a); }; }
  }
  const ap = Real.prototype.addPath; Real.prototype.addPath = function (p, m) { return ap.call(this, un(p), m); };
  globalThis.Path2D = LazyPath2D;
}

// מטריצה קלה במקום DOMMatrix. pdf.js קורא ל-ctx.getTransform() בכל נתיב; בתוכנית CAD עם מאות אלפי נתיבים נוצרים מאות אלפי אובייקטי DOMMatrix
// (זיכרון מקורי של הדפדפן שלא משתחרר מיד) – כ-250MB בכל רינדור, ואחרי כמה הגדלות הטלפון נגמר לו הזיכרון והדף קורס.
class LM {
  constructor(a, b, c, d, e, f) { this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f; }
  get is2D() { return true; }
  get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
  multiplySelf(o) { // this = this × o
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b; this.b = b * o.a + d * o.b; this.c = a * o.c + c * o.d; this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e; this.f = b * o.e + d * o.f + f; return this;
  }
  preMultiplySelf(o) { const r = new LM(o.a, o.b, o.c, o.d, o.e, o.f).multiplySelf(this); Object.assign(this, { a: r.a, b: r.b, c: r.c, d: r.d, e: r.e, f: r.f }); return this; }
  invertSelf() {
    const { a, b, c, d, e, f } = this, det = a * d - b * c;
    if (!det) { this.a = this.b = this.c = this.d = this.e = this.f = NaN; return this; }
    this.a = d / det; this.b = -b / det; this.c = -c / det; this.d = a / det; this.e = (c * f - d * e) / det; this.f = (b * e - a * f) / det; return this;
  }
}

// עטיפה ל-context ש: (1) עוקבת אחרי המטריצה בעצמה ומחזירה LM במקום DOMMatrix, (2) מדלגת על ציור (stroke/fill) של נתיבים שנמצאים כולם מחוץ לקנבס
// (cull=true; הנתיב עצמו נבנה כרגיל, הסמנטיקה זהה).
function fastCtx(real, cw, ch, cull = true) {
  const m0 = real.getTransform();
  let cur = [m0.a, m0.b, m0.c, m0.d, m0.e, m0.f];
  const stack = [];
  let nCall = 0;
  const mul = (a, b, c, d, e, f) => {
    const p = cur;
    cur = [p[0] * a + p[2] * b, p[1] * a + p[3] * b, p[0] * c + p[2] * d, p[1] * c + p[3] * d, p[0] * e + p[2] * f + p[4], p[1] * e + p[3] * f + p[5]];
  };
  let M = null, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, unknown = false;
  const reset = () => { M = null; x0 = y0 = Infinity; x1 = y1 = -Infinity; unknown = false; };
  const pt = (x, y) => {
    if (!M) M = cur;
    const X = M[0] * x + M[2] * y + M[4], Y = M[1] * x + M[3] * y + M[5];
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
  };
  const visible = () => {
    if (!cull || unknown || x0 === Infinity) return true;
    const sc = Math.max(Math.hypot(cur[0], cur[1]), Math.hypot(cur[2], cur[3])), mg = (real.lineWidth || 1) * sc * 3 + 4;
    return x1 + mg >= 0 && x0 - mg <= cw && y1 + mg >= 0 && y0 - mg <= ch;
  };
  const pathVisible = (q) => {
    if (!cull || q._x0 === undefined || q._unk || q._x0 === Infinity) return true;
    const a = cur[0], b = cur[1], c = cur[2], d = cur[3], e = cur[4], f = cur[5];
    let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
    for (let i = 0; i < 4; i++) { const x = i & 1 ? q._x1 : q._x0, y = i & 2 ? q._y1 : q._y0, X = a * x + c * y + e, Y = b * x + d * y + f; if (X < lx) lx = X; if (X > hx) hx = X; if (Y < ly) ly = Y; if (Y > hy) hy = Y; }
    const sc = Math.max(Math.hypot(a, b), Math.hypot(c, d)), mg = (real.lineWidth || 1) * sc * 3 + 4;
    return hx + mg >= 0 && lx - mg <= cw && hy + mg >= 0 && ly - mg <= ch;
  };
  // תבניות מילוי (hatch): pdf.js בונה קנבס אריח חדש לכל פעולה, ו-createPattern שומר עותק שלו. בתוכנית CAD עם 6,448 מילויים זה כ-2GB לכל רינדור (אריחים זהים!).
  // כאן אריחים זהים בתוכן משתפים קנבס פרטי אחד, ו-Chrome משתף את הפיקסלים בין כל התבניות שנוצרו ממנו.
  const shared = new Map();
  const sharedTile = (img) => {
    const w = img.width, h = img.height;
    let g; try { g = img.getContext('2d'); } catch { return img; }
    if (!g) return img;
    const d = new Uint32Array(g.getImageData(0, 0, w, h).data.buffer);
    let h1 = 2166136261 ^ w, h2 = 5381 ^ h;
    for (let i = 0; i < d.length; i++) { const v = d[i]; h1 = Math.imul(h1 ^ v, 16777619); h2 = (Math.imul(h2, 33) + v) | 0; }
    const key = w + 'x' + h + ':' + (h1 >>> 0) + ':' + (h2 >>> 0);
    let c = shared.get(key);
    if (!c) {
      if (shared.size > 300) { for (const v of shared.values()) { v.width = 0; } shared.clear(); }
      c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      shared.set(key, c);
    }
    return c;
  };
  const ov = {
    createPattern(img, rep) {
      if (img && img.width * img.height > 2500 && typeof img.getContext === 'function') { try { return real.createPattern(sharedTile(img), rep); } catch { /* ignore */ } }
      return real.createPattern(img, rep);
    },
    getTransform() { if ((++nCall & 0x7fff) === 0) gcNudge(); return new LM(cur[0], cur[1], cur[2], cur[3], cur[4], cur[5]); },
    save() { stack.push(cur); return real.save(); },
    restore() { if (stack.length) cur = stack.pop(); return real.restore(); },
    transform(a, b, c, d, e, f) { mul(a, b, c, d, e, f); return real.transform(a, b, c, d, e, f); },
    scale(x, y) { mul(x, 0, 0, y, 0, 0); return real.scale(x, y); },
    translate(x, y) { mul(1, 0, 0, 1, x, y); return real.translate(x, y); },
    rotate(r) { const c = Math.cos(r), s = Math.sin(r); mul(c, s, -s, c, 0, 0); return real.rotate(r); },
    setTransform(a, b, c, d, e, f) {
      if (typeof a === 'object' && a) { cur = [a.a ?? a.m11 ?? 1, a.b ?? a.m12 ?? 0, a.c ?? a.m21 ?? 0, a.d ?? a.m22 ?? 1, a.e ?? a.m41 ?? 0, a.f ?? a.m42 ?? 0]; return real.setTransform(a); }
      cur = [a, b, c, d, e, f]; return real.setTransform(a, b, c, d, e, f);
    },
    resetTransform() { cur = [1, 0, 0, 1, 0, 0]; return real.resetTransform(); },
    beginPath() { reset(); return real.beginPath(); },
    moveTo(x, y) { pt(x, y); return real.moveTo(x, y); },
    lineTo(x, y) { pt(x, y); return real.lineTo(x, y); },
    bezierCurveTo(a, b, c, d, x, y) { pt(a, b); pt(c, d); pt(x, y); return real.bezierCurveTo(a, b, c, d, x, y); },
    quadraticCurveTo(a, b, x, y) { pt(a, b); pt(x, y); return real.quadraticCurveTo(a, b, x, y); },
    rect(x, y, w, h) { pt(x, y); pt(x + w, y + h); pt(x + w, y); pt(x, y + h); return real.rect(x, y, w, h); },
    arc(...a) { unknown = true; return real.arc(...a); },
    arcTo(...a) { unknown = true; return real.arcTo(...a); },
    ellipse(...a) { unknown = true; return real.ellipse(...a); },
    roundRect(...a) { unknown = true; return real.roundRect(...a); },
    stroke(...a) { const q = a[0]; if (q && typeof q === 'object') { if (pathVisible(q)) return real.stroke(q); return; } if (visible()) return real.stroke(); },
    fill(...a) { const q = a[0]; if (q && typeof q === 'object') { if (pathVisible(q)) return real.fill(...a); return; } if (visible()) return real.fill(...a); },
  };
  const bound = new Map();
  return new Proxy(real, {
    get(t, k) {
      if (Object.prototype.hasOwnProperty.call(ov, k)) return ov[k];
      const v = t[k];
      if (typeof v !== 'function') return v;
      let f = bound.get(k); if (!f) { f = v.bind(t); bound.set(k, f); } return f;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const fastOn = () => { try { return localStorage.getItem('plans.fastctx') !== '0'; } catch { return true; } };
export const mkCtx = (ctx, cw, ch, cull = true) => (fastOn() ? fastCtx(ctx, cw, ch, cull) : ctx);

// שחרור מיידי של זיכרון הפיקסלים (אחרת הוא ממתין לאיסוף זבל, ובמסמכים כבדים זה מצטבר לגיגות)
function freeCanvas(c) { try { c.width = 0; c.height = 0; } catch { /* ignore */ } }
// רינדור כבד מייצר הרבה אובייקטים עם זיכרון מקורי שה-GC של JS לא "מרגיש" (הערימה קטנה). הקצאת מאגר זמני גדול דוחפת את הדפדפן לאסוף זבל.
function gcNudge() { try { const a = new ArrayBuffer(48 * 1024 * 1024); a.byteLength; } catch { /* ignore */ } }

export class Layer {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'grp';
    this.page = null; this.pw = 0; this.ph = 0;
    this.dx = 0; this.dy = 0; this.s = 1; this.sx = 0;
    this.tint = null;
    this.rot = 0; // סיבוב נוסף (0/90/180/270) מעל הסיבוב המובנה של העמוד
    this.base = null; this.detail = null; this.baseK = 1;
    this.baseGen = 0; this.gen = 0; this.dState = null;
    this.baseTask = null; this.dTask = null;
  }

  // viewport לפי הסיבוב הנוכחי של השכבה
  vp(scale) { return this.page.getViewport({ scale, rotation: (((this.page.rotate || 0) + (this.rot || 0)) % 360 + 360) % 360 }); }

  setPage(page) {
    this.cancel();
    this.page = page;
    const vp = this.vp(1);
    this.pw = vp.width; this.ph = vp.height;
    this.el.textContent = '';
    this.detail = null; this.dState = null;
    let k = Math.min(3, 3200 / Math.max(this.pw, this.ph));
    while (this.pw * k * this.ph * k > MAX_BASE_PIXELS) k *= 0.9;
    this.baseK = k;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(this.pw * k));
    c.height = Math.max(1, Math.ceil(this.ph * k));
    c.className = 'pg-base';
    c.style.width = this.pw + 'px';
    c.style.height = this.ph + 'px';
    this.base = c;
    this.el.appendChild(c);
    return this.renderBase();
  }

  async renderBase() {
    if (!this.base || !this.page) return;
    const gen = ++this.baseGen;
    this.baseTask?.cancel();
    const c = this.base;
    const ctx = c.getContext('2d');
    const task = this.page.render({ canvas: null, canvasContext: mkCtx(ctx, c.width, c.height, false), viewport: this.vp(this.baseK), background: '#ffffff' });
    this.baseTask = task;
    try { await task.promise; } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e); return;
    }
    if (gen !== this.baseGen) return;
    if (this.tint) tintCanvas(ctx, 0, 0, c.width, c.height, this.tint);
  }

  // מיקום קנבס הבסיס לפי מצב התצוגה
  place(scale, tx, ty, dpr) {
    this._last = [scale, tx, ty, dpr];
    const ex = tx + this.sx + this.dx * scale;
    const ey = ty + this.dy * scale;
    const k = scale * this.s;
    if (this.base) {
      const b = this.base.style;
      b.transformOrigin = '0 0';
      b.transform = `translate(${ex}px,${ey}px) scale(${k})`;
      // בהגדלות קיצוניות מסתירים את הבסיס (הפירוט מכסה את המסך)
      b.display = (k * dpr > this.baseK * 24 && this.detail && this.dState) ? 'none' : ''; // מסתירים את הבסיס רק כשיש פירוט שמכסה במקומו – אחרת המסך היה אפור עד סיום הרינדור
    }
    if (this.detail && this.dState) {
      const d = this.dState;
      const r = k / d.k;
      const s = this.detail.style;
      s.transformOrigin = '0 0';
      s.transform = `translate(${ex - d.ex * r}px,${ey - d.ey * r}px) scale(${r})`;
    }
  }

  removeDetail() {
    this.gen++;
    this.dTask?.cancel();
    if (this.detail) { freeCanvas(this.detail); this.detail.remove(); this.detail = null; this.dState = null; }
  }

  // W,H = גודל אזור התצוגה ב-CSS px
  async renderDetail(scale, tx, ty, W, H, dpr, clipW) {
    if (!this.page) return;
    const k0 = scale * this.s;
    if (k0 * dpr <= this.baseK * 1.02) { this.removeDetail(); return; }
    const gen = ++this.gen;
    this.dTask?.cancel();
    let d = dpr;
    if (W * H * d * d > MAX_DETAIL_PIXELS) d = Math.sqrt(MAX_DETAIL_PIXELS / (W * H));
    // בטלפון: גם תקרה לפי גודל העמוד הווירטואלי (קריסה אמיתית נרשמה בעמוד של 4252 נקודות ברזולוציה 64: כ-270 אלף פיקסלים ברוחב)
    const cap = safeK();
    if (k0 * d > cap) d = Math.max(0.25, cap / k0);
    const cw = Math.max(1, Math.round(W * d)), ch = Math.max(1, Math.round(H * d));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d', localStorage.getItem('plans.wrf') === '1' ? { willReadFrequently: true } : undefined);
    const k = k0 * d;
    const ex = tx + this.sx + this.dx * scale, ey = ty + this.dy * scale;
    const ox = ex * d, oy = ey * d;
    const vp = this.vp(k);
    // בהגדלה גבוהה בטלפון מציירים באריחים קטנים: ב-pdf.js כל קבוצת שקיפות/מסכה מקצה קנבס זמני בגודל הקנבס שאליו מציירים,
    // ובתוכנית עם אלפי קבוצות כאלה (הדפסות CAD) זה מילא את הזיכרון וגרם לקריסה. אריחים קטנים = הקצאות קטנות פי כמה.
    let forced = false; try { forced = localStorage.getItem('plans.tiles') === '1'; } catch { /* ignore */ }
    const TS = 384;
    const tiled = forced && k >= 8 && cw * ch > 2 * TS * TS; // אריחים: רק לניסוי (plans.tiles=1); ברירת המחדל – ציור אחד עם דילוג על מה שמחוץ למסך
    crumb({ ph: 'detail', zoom: Math.round(k0 * 75), k: +k.toFixed(2), cw, ch, pw: Math.round(this.pw), phh: Math.round(this.ph), tiled });
    if (!tiled) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(ox, oy, this.pw * k, this.ph * k);
      const task = this.page.render({ canvas: null, canvasContext: mkCtx(ctx, cw, ch), viewport: vp, transform: [1, 0, 0, 1, ox, oy], background: 'rgba(0,0,0,0)' });
      this.dTask = task;
      try { await task.promise; } catch (e) {
        if (e && e.name === 'RenderingCancelledException') return;
        console.error(e); return;
      }
    } else {
      const X0 = Math.max(0, Math.floor(ox)), Y0 = Math.max(0, Math.floor(oy)), X1 = Math.min(cw, Math.ceil(ox + this.pw * k)), Y1 = Math.min(ch, Math.ceil(oy + this.ph * k));
      for (let ty0 = Y0; ty0 < Y1; ty0 += TS) for (let tx0 = X0; tx0 < X1; tx0 += TS) {
        if (gen !== this.gen) return;
        const tw = Math.min(TS, X1 - tx0), th = Math.min(TS, Y1 - ty0);
        const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
        const tctx = tc.getContext('2d');
        tctx.fillStyle = '#ffffff'; tctx.fillRect(0, 0, tw, th);
        const task = this.page.render({ canvas: null, canvasContext: mkCtx(tctx, tw, th), viewport: vp, transform: [1, 0, 0, 1, ox - tx0, oy - ty0], background: 'rgba(0,0,0,0)' });
        this.dTask = task;
        try { await task.promise; } catch (e) {
          tc.width = tc.height = 0;
          if (e && e.name === 'RenderingCancelledException') return;
          console.error(e); return;
        }
        ctx.drawImage(tc, tx0, ty0);
        tc.width = tc.height = 0;
      }
    }
    crumb({ ph: 'ok' });
    if (gen !== this.gen) { freeCanvas(c); return; }
    if (this.tint) {
      const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
      const x1 = Math.min(cw, ox + this.pw * k), y1 = Math.min(ch, oy + this.ph * k);
      if (x1 > x0 && y1 > y0) tintCanvas(ctx, x0, y0, x1 - x0, y1 - y0, this.tint);
    }
    c.className = 'pg-detail';
    c.style.width = W + 'px';
    c.style.height = H + 'px';
    this.dState = { k: k0, ex, ey };
    // הקנבס החדש נצבע לפי המיקום בתחילת הרינדור; אם בינתיים גררו – ממקמים אותו מיד לפי המצב הנוכחי (מונע "קפיצה" באמצע גרירה)
    const old = this.detail;
    if (old) old.replaceWith(c); else this.el.appendChild(c);
    this.detail = c;
    if (old) freeCanvas(old);
    gcNudge();
    if (this._last) this.place(...this._last);
    return true;
  }

  clear() {
    this.cancel();
    this.el.textContent = '';
    this.page = null; this.base = null; this.detail = null; this.dState = null; this.n = 0;
  }

  cancel() {
    this.gen++; this.baseGen++;
    try { this.baseTask?.cancel(); } catch { /* ignore */ }
    try { this.dTask?.cancel(); } catch { /* ignore */ }
  }

  destroy() {
    this.cancel();
    this.el.remove();
    this.page?.cleanup?.();
  }
}
