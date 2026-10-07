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

const MAX_DETAIL_PIXELS = 16e6;
const MAX_BASE_PIXELS = 14e6;

export class Layer {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'grp';
    this.page = null; this.pw = 0; this.ph = 0;
    this.dx = 0; this.dy = 0; this.s = 1; this.sx = 0;
    this.tint = null;
    this.base = null; this.detail = null; this.baseK = 1;
    this.baseGen = 0; this.gen = 0; this.dState = null;
    this.baseTask = null; this.dTask = null;
  }

  setPage(page) {
    this.cancel();
    this.page = page;
    const vp = page.getViewport({ scale: 1 });
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
    const task = this.page.render({ canvasContext: ctx, viewport: this.page.getViewport({ scale: this.baseK }), background: '#ffffff' });
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
    const ex = tx + this.sx + this.dx * scale;
    const ey = ty + this.dy * scale;
    const k = scale * this.s;
    if (this.base) {
      const b = this.base.style;
      b.transformOrigin = '0 0';
      b.transform = `translate(${ex}px,${ey}px) scale(${k})`;
      // בהגדלות קיצוניות מסתירים את הבסיס (הפירוט מכסה את המסך)
      b.display = k * dpr > this.baseK * 24 ? 'none' : '';
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
    if (this.detail) { this.detail.remove(); this.detail = null; this.dState = null; }
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
    const cw = Math.max(1, Math.round(W * d)), ch = Math.max(1, Math.round(H * d));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    const k = k0 * d;
    const ex = tx + this.sx + this.dx * scale, ey = ty + this.dy * scale;
    const ox = ex * d, oy = ey * d;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox, oy, this.pw * k, this.ph * k);
    const vp = this.page.getViewport({ scale: k });
    const task = this.page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, ox, oy], background: 'rgba(0,0,0,0)' });
    this.dTask = task;
    try { await task.promise; } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e); return;
    }
    if (gen !== this.gen) return;
    if (this.tint) {
      const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
      const x1 = Math.min(cw, ox + this.pw * k), y1 = Math.min(ch, oy + this.ph * k);
      if (x1 > x0 && y1 > y0) tintCanvas(ctx, x0, y0, x1 - x0, y1 - y0, this.tint);
    }
    c.className = 'pg-detail';
    c.style.width = W + 'px';
    c.style.height = H + 'px';
    this.dState = { k: k0, ex, ey };
    if (this.detail) this.detail.replaceWith(c); else this.el.appendChild(c);
    this.detail = c;
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
