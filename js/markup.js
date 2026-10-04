// סימונים, מדידות וקישורים: ציור SVG, גיאומטריה ובדיקת פגיעה.
// כל הקואורדינטות ביחידות של עמוד ה-PDF (נקודות, 1/72 אינץ') – בלתי תלויות בזום.

export const NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  kids.forEach((k) => e.append(k));
  return e;
}

export const LAYER_OF = {
  pen: 'markups', polyline: 'markups', arrow: 'markups', line: 'markups', rect: 'markups', ellipse: 'markups', text: 'markups', highlight: 'markups',
  measure: 'measurements', area: 'measurements', link: 'links',
};
export const RECT_TYPES = new Set(['rect', 'ellipse', 'highlight', 'link']);

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function pathLength(pts, closed = false) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) l += dist(pts[pts.length - 1], pts[0]);
  return l;
}

export function distSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function inPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}
export function bbox(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
export function corners(pts) {
  const b = bbox(pts);
  return [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }];
}

// ---------- מידות ----------
export const PAPER = [['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297]];
export function paperName(wPt, hPt) {
  const w = (wPt * 25.4) / 72, h = (hPt * 25.4) / 72;
  const [s, l] = w < h ? [w, h] : [h, w];
  for (const [n, a, b] of PAPER) if (Math.abs(s - a) < 4 && Math.abs(l - b) < 4) return n;
  return null;
}
// מטרים אמיתיים ליחידת עמוד אחת, עבור סקאלה 1:N (בהנחה שה-PDF בגודל הדף המקורי)
export const mpuFromRatio = (n) => (n * 0.0254) / 72;

export function fmtLen(m, unit) {
  if (unit === 'mm') return `${Math.round(m * 1000).toLocaleString('he-IL')} מ״מ`;
  if (unit === 'cm') return `${(m * 100).toLocaleString('he-IL', { maximumFractionDigits: 1 })} ס״מ`;
  return `${m.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} מ׳`;
}
export function fmtArea(m2, unit) {
  if (unit === 'mm') return `${Math.round(m2 * 1e6).toLocaleString('he-IL')} מ״מ²`;
  if (unit === 'cm') return `${Math.round(m2 * 1e4).toLocaleString('he-IL')} ס״מ²`;
  return `${m2.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} מ״ר`;
}
export function measureText(it, cal, unit) {
  if (!cal || !cal.mpu) return 'נדרש כיול';
  if (it.type === 'area') return fmtArea(polyArea(it.pts) * cal.mpu * cal.mpu, unit);
  if (it.type === 'polyline') return fmtLen(pathLength(it.pts, it.closed) * cal.mpu, unit);
  return fmtLen(dist(it.pts[0], it.pts[1]) * cal.mpu, unit);
}

// ---------- טקסט ----------
const isRTL = (s) => /[\u0590-\u05FF\u0600-\u06FF]/.test(s || '');
export function textBox(it) {
  const lines = String(it.text || '').split('\n');
  const fs = it.fontSize;
  const w = Math.max(...lines.map((l) => l.length), 1) * fs * 0.58;
  return { x0: it.pts[0].x, y0: it.pts[0].y, x1: it.pts[0].x + w, y1: it.pts[0].y + lines.length * fs * 1.25 };
}
function label(text, x, y, fs, { anchor = 'middle', fill = '#111', rtl = false } = {}) {
  const t = svg('text', {
    x, y, 'font-size': fs, 'text-anchor': anchor, fill, 'font-family': 'system-ui, Arial, sans-serif', 'font-weight': 600,
    stroke: '#fff', 'stroke-width': fs * 0.22, 'paint-order': 'stroke', 'stroke-linejoin': 'round', direction: rtl ? 'rtl' : 'ltr',
  });
  t.textContent = text;
  return t;
}

// cx: { cal, unit, planName(target) }
// שדות עיצוב (כולם אופציונליים, כדי לשמור תאימות לפריטים ישנים):
//   color – צבע קו (או 'none' ללא קו) · width – עובי · op – שקיפות קו/טקסט (0..1)
//   fill – צבע מילוי (null = ללא) · fillOp – שקיפות מילוי (0..1)
export const isNoStroke = (it) => !it.color || it.color === 'none';
export const hasFill = (it) => !!it.fill && it.fill !== 'none';

export function drawItem(it, cx) {
  const g = svg('g', { 'data-id': it.id });
  const col = isNoStroke(it) ? 'none' : it.color, w = it.width, p = it.pts;
  const a = p[0], b = p[1];
  const op = it.op == null ? 1 : it.op;
  const stroke = { stroke: col, 'stroke-width': col === 'none' ? 0 : w, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': op };
  const fillAttrs = hasFill(it) ? { fill: it.fill, 'fill-opacity': it.fillOp == null ? 0.3 : it.fillOp } : {};
  switch (it.type) {
    case 'line':
      g.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...stroke }));
      break;
    case 'arrow': {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const hl = Math.min(len * 0.6, w * 5), hw = hl * 0.5;
      const bx = b.x - ux * hl, by = b.y - uy * hl;
      g.append(svg('line', { x1: a.x, y1: a.y, x2: bx, y2: by, ...stroke }));
      g.append(svg('polygon', { points: `${b.x},${b.y} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}`, fill: col, 'fill-opacity': op, stroke: col, 'stroke-width': w * 0.3, 'stroke-linejoin': 'round', 'stroke-opacity': op }));
      break;
    }
    case 'rect': {
      const r = bbox([a, b]);
      g.append(svg('rect', { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, ...stroke, ...fillAttrs }));
      break;
    }
    case 'ellipse': {
      const r = bbox([a, b]);
      g.append(svg('ellipse', { cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2, rx: (r.x1 - r.x0) / 2, ry: (r.y1 - r.y0) / 2, ...stroke, ...fillAttrs }));
      break;
    }
    case 'highlight': {
      const r = bbox([a, b]);
      g.append(svg('rect', { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, fill: it.color, 'fill-opacity': it.fillOp == null ? 0.35 : it.fillOp, stroke: 'none' }));
      break;
    }
    case 'pen':
      g.append(svg('path', { d: 'M' + p.map((q) => `${q.x} ${q.y}`).join(' L'), ...stroke }));
      break;
    case 'polyline': {
      const d = 'M' + p.map((q) => `${q.x} ${q.y}`).join(' L') + (it.closed && p.length > 2 ? ' Z' : '');
      g.append(svg('path', { d, ...stroke, ...(it.closed ? fillAttrs : {}) }));
      if (it.showLen && p.length >= 2) {
        const mid = p[Math.floor((p.length - 1) / 2)], nxt = p[Math.floor((p.length - 1) / 2) + 1] || mid;
        const fs = it.fontSize || it.width * 4;
        g.append(label(measureText(it, cx.cal, cx.unit), (mid.x + nxt.x) / 2, (mid.y + nxt.y) / 2 - fs * 0.5, fs, { fill: cx.cal ? '#111' : '#b71c1c' }));
      }
      break;
    }
    case 'text': {
      const lines = String(it.text || '').split('\n');
      const rtl = isRTL(it.text);
      const bx = textBox(it);
      const x = rtl ? bx.x1 : bx.x0;
      const t = svg('text', {
        x, y: a.y + it.fontSize, 'font-size': it.fontSize, fill: it.color || '#111', opacity: op, 'font-family': 'system-ui, Arial, sans-serif', 'font-weight': 600,
        stroke: '#fff', 'stroke-width': it.fontSize * 0.16, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
        direction: rtl ? 'rtl' : 'ltr', 'text-anchor': 'start', 'unicode-bidi': 'plaintext',
      });
      lines.forEach((ln, i) => { const s = svg('tspan', { x, dy: i === 0 ? 0 : it.fontSize * 1.25 }); s.textContent = ln || ' '; t.append(s); });
      g.append(t);
      break;
    }
    case 'measure': {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, tk = w * 3;
      g.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...stroke }));
      [a, b].forEach((q) => g.append(svg('line', { x1: q.x - nx * tk, y1: q.y - ny * tk, x2: q.x + nx * tk, y2: q.y + ny * tk, ...stroke })));
      g.append(label(measureText(it, cx.cal, cx.unit), (a.x + b.x) / 2 + nx * it.fontSize * 0.9, (a.y + b.y) / 2 + ny * it.fontSize * 0.9 + it.fontSize * 0.35, it.fontSize, { fill: cx.cal ? '#111' : '#b71c1c' }));
      break;
    }
    case 'area': {
      if (p.length >= 3) g.append(svg('polygon', { points: p.map((q) => `${q.x},${q.y}`).join(' '), fill: col, 'fill-opacity': 0.18, ...stroke }));
      else g.append(svg('polyline', { points: p.map((q) => `${q.x},${q.y}`).join(' '), ...stroke }));
      p.forEach((q) => g.append(svg('circle', { cx: q.x, cy: q.y, r: w * 1.2, fill: col })));
      if (p.length >= 3) { const bb = bbox(p); g.append(label(measureText(it, cx.cal, cx.unit), (bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2 + it.fontSize * 0.35, it.fontSize, { fill: cx.cal ? '#111' : '#b71c1c' })); }
      break;
    }
    case 'link': {
      const r = bbox([a, b]);
      g.append(svg('rect', { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, fill: col, 'fill-opacity': 0.13, stroke: col, 'stroke-width': w, 'stroke-dasharray': `${w * 3} ${w * 2}`, 'stroke-linejoin': 'round' }));
      const name = cx.planName ? cx.planName(it.target) : '';
      const lab = (it.text ? it.text : name) || 'קישור';
      g.append(label('↗ ' + lab, r.x0 + w, r.y0 - it.fontSize * 0.3, it.fontSize, { anchor: 'start', fill: name === null ? '#b71c1c' : col, rtl: isRTL(lab) }));
      break;
    }
  }
  return g;
}

export function boundsOf(it) {
  if (it.type === 'text') return textBox(it);
  return bbox(it.pts);
}

// ידיות עריכה. לטקסט: ידית אחת בפינה הימנית-תחתונה לשינוי גודל.
export function handlesOf(it) {
  if (it.type === 'pen') return [];
  if (it.type === 'text') { const b = textBox(it); return [{ x: b.x1, y: b.y1, idx: 0, resize: true }]; }
  if (RECT_TYPES.has(it.type)) return corners(it.pts).map((c, i) => ({ ...c, idx: i }));
  return it.pts.map((c, i) => ({ ...c, idx: i }));
}

// בדיקת פגיעה. tol ביחידות עמוד.
export function hitItem(it, p, tol) {
  const q = it.pts, w = isNoStroke(it) ? 0 : (it.width || 0) / 2;
  const filled = hasFill(it);
  switch (it.type) {
    case 'line': case 'arrow': case 'measure':
      return distSeg(p, q[0], q[1]) <= tol + w;
    case 'pen':
      for (let i = 1; i < q.length; i++) if (distSeg(p, q[i - 1], q[i]) <= tol + w) return true;
      return false;
    case 'polyline': {
      if (it.closed && filled && q.length >= 3 && inPoly(p, q)) return true;
      const n = it.closed ? q.length : q.length - 1;
      for (let i = 0; i < n; i++) if (distSeg(p, q[i], q[(i + 1) % q.length]) <= tol + w) return true;
      return false;
    }
    case 'rect': {
      const r = bbox(q);
      if (filled && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) return true;
      const c = corners(q);
      for (let i = 0; i < 4; i++) if (distSeg(p, c[i], c[(i + 1) % 4]) <= tol + w) return true;
      return false;
    }
    case 'ellipse': {
      const r = bbox(q), rx = (r.x1 - r.x0) / 2 || 1e-6, ry = (r.y1 - r.y0) / 2 || 1e-6;
      const k = Math.hypot((p.x - (r.x0 + r.x1) / 2) / rx, (p.y - (r.y0 + r.y1) / 2) / ry);
      if (filled && k <= 1) return true;
      return Math.abs(k - 1) * Math.min(rx, ry) <= tol + w;
    }
    case 'highlight': case 'link': {
      const r = bbox(q);
      return p.x >= r.x0 - tol && p.x <= r.x1 + tol && p.y >= r.y0 - tol && p.y <= r.y1 + tol;
    }
    case 'text': {
      const r = textBox(it);
      return p.x >= r.x0 - tol && p.x <= r.x1 + tol && p.y >= r.y0 - tol && p.y <= r.y1 + tol;
    }
    case 'area': {
      if (q.length >= 3 && inPoly(p, q)) return true;
      for (let i = 0; i < q.length; i++) if (distSeg(p, q[i], q[(i + 1) % q.length]) <= tol + w) return true;
      return false;
    }
  }
  return false;
}

// סוג עיצוב לכל סוג פריט: text / hl (הדגשה) / shape (קווים וצורות) / meas (מדידות)
export const kindOf = (t) => (t === 'text' ? 'text' : t === 'highlight' ? 'hl'
  : ['pen', 'line', 'arrow', 'polyline', 'rect', 'ellipse'].includes(t) ? 'shape'
    : (t === 'measure' || t === 'area') ? 'meas' : null);
export const canFill = (it) => it.type === 'rect' || it.type === 'ellipse' || (it.type === 'polyline' && !!it.closed);
