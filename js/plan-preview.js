// תצוגה מקדימה קלה של תוכנית (קריאה בלבד) מעל חלון אחר, בלי לצאת ממנו. משמשת למסך "גישה לתוכניות לפי עובד":
// המנהל לוחץ על שם תוכנית, רואה את הקובץ, וסוגר – וממשיך להחליט אם לתת לעובד גישה.
import { t as tr } from './i18n.js';
import { dn } from './names.js';
import * as S from './store.js';
import * as UI from './ui.js';
import { pushLayer } from './backstack.js';
import { openPdf, destroyDoc } from './pdfio.js';
import { h, icon, clamp } from './util.js';

const ZOOMS = [1, 1.5, 2, 3, 4];
export async function previewPlan(planId, { onOpenFull } = {}) {
  const plan = S.P.plans.get(planId);
  const ver = plan && S.curVer(plan);
  if (!plan || !ver) { UI.toast(tr('התוכנית לא נמצאה'), { type: 'error' }); return; }
  const title = h('b', { class: 'pv-title' }, dn(plan.name));
  const info = h('span', { class: 'pv-info' }, '');
  const scroller = h('div', { class: 'pv-scroll' });
  const status = h('div', { class: 'pv-status' }, tr('טוען תוכנית…'));
  let zi = 0, doc = null, closed = false, io = null, layer = null;
  const zoomLbl = h('span', { class: 'pv-zl' }, '100%');
  const close = () => {
    if (closed) return; closed = true;
    io?.disconnect(); layer?.release(); layer = null;
    root.remove();
    if (doc) destroyDoc(doc);
  };
  const btn = (ic, label, fn) => h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick: fn }, icon(ic));
  const bar = h('div', { class: 'pv-bar' },
    btn('x', tr('סגור תצוגה מקדימה'), close), title, info, h('span', { class: 'sp' }),
    btn('zoomOut', tr('הקטן'), () => setZoom(zi - 1)), zoomLbl, btn('zoomIn', tr('הגדל'), () => setZoom(zi + 1)),
    onOpenFull ? h('button', { class: 'btn sm', onclick: () => { close(); onOpenFull(); } }, tr('פתח במלואה')) : null);
  const root = h('div', { class: 'pv-root', role: 'dialog', 'aria-modal': 'true' }, bar, scroller, status);
  UI.uiRoot().appendChild(root);
  layer = pushLayer(() => { layer = null; close(); });

  const blob = await S.getFileBlob(ver.id);
  if (closed) return;
  if (!blob) { status.textContent = tr('הקובץ לא זמין (אין חיבור, או שעוד לא הורד).'); return; }
  try { doc = await openPdf(blob, { interactive: true }); } catch (e) { status.textContent = tr('לא ניתן להציג את הקובץ הזה.'); return; }
  if (closed) { destroyDoc(doc); return; }
  status.remove();
  info.textContent = tr('{0} עמודים', doc.numPages);

  const pages = [];
  const wrapW = () => Math.max(200, scroller.clientWidth - 16) * ZOOMS[zi];
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    const vp = pg.getViewport({ scale: 1 });
    const cv = h('canvas', {});
    const box = h('div', { class: 'pv-page' }, cv, h('span', { class: 'pv-n' }, String(n)));
    box._info = { n, pg, ratio: vp.height / vp.width, w: vp.width, cv, done: 0 };
    pages.push(box); scroller.append(box);
    if (n > 60 && n < doc.numPages) { /* כמה עמודים שיהיו – ההכנה זולה */ }
  }
  function layout() {
    const W = wrapW();
    for (const b of pages) { const i = b._info; b.style.width = W + 'px'; b.style.height = Math.round(W * i.ratio) + 'px'; i.done = 0; i.cv.width = 1; i.cv.height = 1; }
    pages.forEach((b) => io.observe(b));
    zoomLbl.textContent = Math.round(ZOOMS[zi] * 100) + '%';
  }
  let q = Promise.resolve();
  const render = (b) => { q = q.then(async () => {
    const i = b._info, W = wrapW();
    if (closed || i.done === W) return;
    const k = Math.min(W * (window.devicePixelRatio || 1), 3600) / i.w;
    const vp = i.pg.getViewport({ scale: k });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    try { await i.pg.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#fff' }).promise; } catch { return; }
    if (closed) return;
    c.style.width = '100%'; c.style.height = '100%';
    i.cv.replaceWith(c); i.cv = c; i.done = W;
  }); };
  io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) render(e.target); }, { root: scroller, rootMargin: '400px 0px' });
  function setZoom(n) {
    n = clamp(n, 0, ZOOMS.length - 1); if (n === zi) return;
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    zi = n; io.disconnect(); layout();
    scroller.scrollTop = ratio * scroller.scrollHeight;
  }
  layout();
}
