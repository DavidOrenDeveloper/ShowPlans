// ייצוא PDF וקטורי: דפי ה-PDF המקוריים מוטמעים כמו שהם (וקטור, בלי איבוד רזולוציה), והסימונים והמדידות מצוירים מעליהם כקווים וקטוריים.
// רק הכיתובים (טקסט, מדידות) נשמרים כתמונות שקופות ברזולוציית ~600 DPI – כך עברית ואנגלית נראות בדיוק כמו במסך.
// ספריית pdf-lib נטענת רק כשצריך (lib/pdf-lib.esm.min.js).
import { drawItem } from './markup.js';

let libP = null;
const lib = () => libP || (libP = import('../lib/pdf-lib.esm.min.js'));

const colorCache = new Map();
let cctx = null;
function rgbOf(col) {
  if (colorCache.has(col)) return colorCache.get(col);
  if (!cctx) { const c = document.createElement('canvas'); c.width = c.height = 1; cctx = c.getContext('2d', { willReadFrequently: true }); }
  cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = '#000'; cctx.fillStyle = col; cctx.fillRect(0, 0, 1, 1);
  const d = cctx.getImageData(0, 0, 1, 1).data, r = [d[0] / 255, d[1] / 255, d[2] / 255];
  colorCache.set(col, r); return r;
}
const f = (n) => (Math.abs(n) < 1e-9 ? '0' : (+n.toFixed(4)).toString());
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };
const K = 0.5522847498;

// ---- המרת צמתי SVG (מ-drawItem) לפקודות PDF ----
function pathOf(el) {
  const t = el.tagName.toLowerCase(), n = (a) => parseFloat(el.getAttribute(a)) || 0;
  switch (t) {
    case 'line': return `${f(n('x1'))} ${f(n('y1'))} m ${f(n('x2'))} ${f(n('y2'))} l`;
    case 'polygon': case 'polyline': {
      const p = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat);
      let s = '';
      for (let i = 0; i + 1 < p.length; i += 2) s += `${f(p[i])} ${f(p[i + 1])} ${i ? 'l' : 'm'} `;
      return s + (t === 'polygon' ? 'h' : '');
    }
    case 'rect': return `${f(n('x'))} ${f(n('y'))} ${f(n('width'))} ${f(n('height'))} re`;
    case 'ellipse': case 'circle': {
      const cx = n('cx'), cy = n('cy'), rx = t === 'circle' ? n('r') : n('rx'), ry = t === 'circle' ? n('r') : n('ry'), kx = rx * K, ky = ry * K;
      return `${f(cx + rx)} ${f(cy)} m ${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)} c ${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)} c h`;
    }
    case 'path': {
      const tok = (el.getAttribute('d') || '').match(/[MLZmlz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
      let s = '', i = 0, cmd = 'M';
      while (i < tok.length) {
        if (/[A-Za-z]/.test(tok[i])) { cmd = tok[i++].toUpperCase(); if (cmd === 'Z') s += 'h '; continue; }
        const x = parseFloat(tok[i++]), y = parseFloat(tok[i++]);
        s += `${f(x)} ${f(y)} ${cmd === 'M' ? 'm' : 'l'} `; if (cmd === 'M') cmd = 'L';
      }
      return s;
    }
    default: return null;
  }
}

class Page {
  constructor(out, pw, ph) { this.out = out; this.pw = pw; this.ph = ph; this.ops = []; this.gs = new Map(); this.xo = new Map(); this.node = out.addPage([pw, ph]); }
  gstate(ca, CA) {
    const k = ca.toFixed(3) + '_' + CA.toFixed(3);
    if (!this.gs.has(k)) {
      const ref = this.out.context.register(this.out.context.obj({ Type: 'ExtGState', ca, CA }));
      const name = 'G' + this.gs.size; this.gs.set(k, name); this.node.node.setExtGState(this.L.PDFName.of(name), ref);
    }
    return this.gs.get(k);
  }
  xobj(ref) {
    const name = 'X' + this.xo.size; this.xo.set(name, ref); this.node.node.setXObject(this.L.PDFName.of(name), ref); return name;
  }
  finish() {
    const ctx = this.out.context;
    this.node.node.addContentStream(ctx.register(ctx.flateStream(this.ops.join('\n'))));
  }
}

function shape(page, el) {
  const d = pathOf(el); if (!d) return;
  const attr = (a) => el.getAttribute(a);
  const fill = attr('fill'), stroke = attr('stroke'), sw = parseFloat(attr('stroke-width')) || 0;
  const doFill = fill && fill !== 'none', doStroke = stroke && stroke !== 'none' && sw > 0;
  if (!doFill && !doStroke) return;
  const fo = attr('fill-opacity') == null ? 1 : +attr('fill-opacity'), so = attr('stroke-opacity') == null ? 1 : +attr('stroke-opacity');
  const o = [`q /${page.gstate(doFill ? fo : 1, doStroke ? so : 1)} gs`];
  if (doFill) o.push(rgbOf(fill).map(f).join(' ') + ' rg');
  if (doStroke) {
    o.push(rgbOf(stroke).map(f).join(' ') + ' RG', `${f(sw)} w`, `${attr('stroke-linecap') === 'round' ? 1 : 0} J`, `${attr('stroke-linejoin') === 'round' ? 1 : 0} j`);
    const da = attr('stroke-dasharray'); if (da) o.push(`[${da.split(/[\s,]+/).map((x) => f(parseFloat(x))).join(' ')}] 0 d`);
  }
  o.push(d, doFill && doStroke ? 'B' : doFill ? 'f' : 'S', 'Q');
  page.ops.push(o.join('\n'));
}

// כיתובים: נשמרים כתמונת PNG שקופה (הדפדפן מצייר עברית/אנגלית נכון), מוצבת בדיוק במקום הכיתוב
let measSvg = null;
async function labelImage(page, textEls, M, ppuMax) {
  if (!measSvg) {
    measSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    measSvg.setAttribute('style', 'position:fixed;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;pointer-events:none');
    document.body.append(measSvg);
  }
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  textEls.forEach((e) => g.append(e.cloneNode(true)));
  measSvg.append(g);
  let b; try { b = g.getBBox(); } catch { b = null; }
  measSvg.removeChild(g);
  if (!b || !(b.width > 0) || !(b.height > 0)) return;
  const pad = Math.max(b.height * 0.2, 0.01);
  const x0 = b.x - pad, y0 = b.y - pad, bw = b.width + 2 * pad, bh = b.height + 2 * pad;
  const itemScale = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
  let ppu = Math.max(0.5, itemScale * (600 / 72));
  ppu = Math.min(ppu, ppuMax, 3500 / Math.max(bw, bh));
  const W = Math.max(2, Math.ceil(bw * ppu)), H = Math.max(2, Math.ceil(bh * ppu));
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${bw} ${bh}" width="${W}" height="${H}">${textEls.map((e) => new XMLSerializer().serializeToString(e)).join('')}</svg>`;
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  let png;
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    c.getContext('2d').drawImage(img, 0, 0, W, H);
    png = await new Promise((res) => c.toBlob(res, 'image/png'));
    c.width = c.height = 0;
  } finally { URL.revokeObjectURL(url); }
  if (!png) return;
  const im = await page.out.embedPng(new Uint8Array(await png.arrayBuffer()));
  const name = page.xobj(im.ref);
  page.ops.push(`q ${M.map(f).join(' ')} cm ${f(bw)} 0 0 ${f(-bh)} ${f(x0)} ${f(y0 + bh)} cm /${name} Do Q`);
}

async function drawItems(page, v, tile, M) {
  const { pageNum, fixed } = tile;
  const items = [];
  for (const layer of ['markups', 'measurements', 'links']) if (tile.layers[layer]) for (const it of v.items[layer]) if (it.page === pageNum && v.itemShown(it)) items.push(it);
  if (!items.length) return;
  const cx = v.ctx(), sc = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
  page.ops.push(`q ${M.map(f).join(' ')} cm`);
  const labels = [];
  for (const it of items) {
    const node = drawItem(fixed ? v.fixedMeasure(it) : it, { ...cx, cal: v.calFor(it, pageNum) });
    const texts = [];
    for (const el of node.querySelectorAll('*')) {
      const t = el.tagName.toLowerCase();
      if (t === 'text' || (it.type === 'text' && t === 'rect')) texts.push(el); else shape(page, el);
    }
    if (texts.length) labels.push(texts);
  }
  page.ops.push('Q');
  for (const texts of labels) await labelImage(page, texts, M, 1e9);
  void sc;
}

// sheets: [{ pw, ph, tiles: [{ v, pageNum, rect, dest, fixed, layers }] }] (ביחידות נקודה; מקור למעלה-שמאל)
export async function buildVectorPdf(sheets, { onProgress } = {}) {
  const L = await lib();
  const { PDFDocument } = L;
  const out = await PDFDocument.create();
  const srcs = new Map(), embedded = new Map();
  const total = sheets.reduce((a, s) => a + s.tiles.length, 0);
  let done = 0;
  for (const sh of sheets) {
    const page = new Page(out, sh.pw, sh.ph); page.L = L;
    for (const tile of sh.tiles) {
      onProgress?.(done++ / total);
      const { v, pageNum, rect, dest } = tile;
      let src = srcs.get(v.doc);
      if (!src) {
        const bytes = await v.doc.getData();
        src = await PDFDocument.load(bytes); // מגן על PDF מוצפן: נכשל ואז עוברים להדפסה כתמונה
        srcs.set(v.doc, src);
      }
      const pg = await v.doc.getPage(pageNum);
      const rot = (((pg.rotate || 0) + v.rotFor(pageNum)) % 360 + 360) % 360;
      const vp = pg.getViewport({ scale: 1, rotation: rot }), o1 = pg.getViewport({ scale: 1, rotation: pg.rotate || 0 });
      const pts = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]].map(([x, y]) => vp.convertToPdfPoint(x, y));
      const bb = { left: Math.min(...pts.map((p) => p[0])), right: Math.max(...pts.map((p) => p[0])), bottom: Math.min(...pts.map((p) => p[1])), top: Math.max(...pts.map((p) => p[1])) };
      const key = `${v.doc.fingerprints?.[0] || ''}|${pageNum}|${bb.left.toFixed(2)},${bb.bottom.toFixed(2)},${bb.right.toFixed(2)},${bb.top.toFixed(2)}`;
      let ep = embedded.get(key);
      if (!ep) {
        const [cp] = await out.copyPages(src, [pageNum - 1]);
        ep = await out.embedPage(cp, bb, [1, 0, 0, 1, 0, 0]);
        embedded.set(key, ep);
      }
      const sc = dest.w / (rect.x1 - rect.x0), t = vp.transform;
      const Mp = [sc * t[0], -sc * t[1], sc * t[2], -sc * t[3], sc * (t[4] - rect.x0) + dest.x, sh.ph - dest.y - sc * (t[5] - rect.y0)]; // PDF → דף הפלט
      const name = page.xobj(ep.ref);
      page.ops.push(`q ${f(dest.x)} ${f(sh.ph - dest.y - dest.h)} ${f(dest.w)} ${f(dest.h)} re W n`, '1 1 1 rg ' + `${f(dest.x)} ${f(sh.ph - dest.y - dest.h)} ${f(dest.w)} ${f(dest.h)} re f`);
      page.ops.push(`q ${Mp.map(f).join(' ')} cm /${name} Do Q`);
      const Mi = mul(Mp, inv(o1.transform)); // קואורדינטות סימון (מרחב העמוד לפני סיבוב התצוגה) → דף הפלט
      await drawItems(page, v, tile, Mi);
      page.ops.push('Q');
    }
    page.finish();
  }
  onProgress?.(1);
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}
