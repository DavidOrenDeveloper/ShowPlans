// זיהוי צורה מקו חופשי (עט) בלחיצה ארוכה, בסגנון Samsung Notes.
// כל הקואורדינטות ביחידות עמוד; scale = פיקסלים למסך ליחידה (לקביעת ספי גודל).

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLen(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += d(pts[i - 1], pts[i]);
  return l;
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  if (!l2) return d(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Ramer–Douglas–Peucker על מסלול פתוח
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const dd = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (dd > max) { max = dd; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
  return l.slice(0, -1).concat(r);
}

// פינות של מסלול סגור: מפצלים בנקודה הרחוקה ביותר מההתחלה, כדי שההתחלה לא תהיה "פינה" שרירותית
function closedCorners(pts, eps) {
  let far = 0, fd = 0;
  for (let i = 0; i < pts.length; i++) { const dd = d(pts[i], pts[0]); if (dd > fd) { fd = dd; far = i; } }
  const A = rdp(pts.slice(0, far + 1), eps), B = rdp(pts.slice(far), eps);
  let c = A.slice(0, -1).concat(B); // B נגמר בנקודת הסיום ≈ ההתחלה
  if (c.length > 2 && d(c[0], c[c.length - 1]) < eps * 2) c = c.slice(0, -1);
  return c;
}

function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y, m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
}

// מחזיר { type, pts, closed? } או null אם לא זוהתה צורה סגורה
export function recognize(pts, scale = 1) {
  if (pts.length < 4) return null;
  const len = pathLen(pts);
  if (len * scale < 24) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
  const closed = d(first, last) < Math.max(0.2 * len, 0.12 * diag) && len > 1.6 * diag * 0.9 && (x1 - x0) > 0 && (y1 - y0) > 0;

  if (!closed) return { type: 'line', pts: [first, last] };

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  // התאמה לאליפסה: ממוצע |k-1| קטן
  let sum = 0;
  for (const p of pts) sum += Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1);
  const ellErr = sum / pts.length;
  if (ellErr < 0.1) return { type: 'ellipse', pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };

  const eps = Math.max(0.045 * diag, 6 / scale);
  const corners = closedCorners(pts, eps);
  const n = corners.length;
  if (n === 4) {
    const angs = [0, 1, 2, 3].map((i) => angleAt(corners[(i + 3) % 4], corners[i], corners[(i + 1) % 4]));
    const rightish = angs.every((a) => Math.abs(a - 90) < 22);
    if (rightish) {
      // ישר-צירים? כל הצלעות קרובות לאופקי/אנכי
      const axis = corners.every((c, i) => {
        const nx = corners[(i + 1) % 4];
        const ang = Math.abs((Math.atan2(nx.y - c.y, nx.x - c.x) * 180) / Math.PI) % 90;
        return ang < 14 || ang > 76;
      });
      if (axis) return { type: 'rect', pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] };
    }
    return { type: 'polyline', pts: corners, closed: true };
  }
  if (n >= 3 && n <= 8) return { type: 'polyline', pts: corners, closed: true };
  return null;
}

// הצמדת זווית לכפולות של 45° אם קרוב (למשיכת קו ישר)
export function snapAngle(a, b, tolDeg = 5) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (!len) return b;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const nearest = Math.round(ang / 45) * 45;
  if (Math.abs(ang - nearest) > tolDeg) return b;
  const r = (nearest * Math.PI) / 180;
  return { x: a.x + Math.cos(r) * len, y: a.y + Math.sin(r) * len };
}
