// פריסת הדפסה: גודלי נייר, כיוון, שוליים והתאמה לדף. פונקציות טהורות (בלי DOM) שמשמשות גם את התצוגה המקדימה, גם את ה-PDF הווקטורי וגם את ההדפסה כתמונה.
import { getLang } from './i18n.js';

// שם דו-לשוני תמיד (עברית + אנגלית), בלי קשר לשפת האפליקציה; הסדר לפי שפת האפליקציה
const iso = (x) => '\u2068' + x + '\u2069'; // בידוד כיוון: כל חלק (עברית / אנגלית) מוצג נכון גם בתוך טקסט בכיוון הפוך
export const bi = (he, en) => (getLang() === 'en' ? `${iso(en)} · ${iso(he)}` : `${iso(he)} · ${iso(en)}`);

// מ"מ (רוחב × גובה, לאורך)
export const PAPERS = [
  ['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210],
  ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6], ['Tabloid', 279.4, 431.8],
];
export const MARGINS = { none: 0, small: 5, normal: 10, large: 20 }; // מ"מ
export const mmToPt = (mm) => (mm * 72) / 25.4;
export const ptToMm = (pt) => (pt * 25.4) / 72;

export const DEFAULT_PRINT = { paper: 'A4', orient: 'auto', margin: 'small', quality: 'vector', fit: 'fit' };

// גודל הדף בנקודות אחרי כיוון. content: { cw, ch } ביחידות כלשהן (רק היחס קובע באוטומט). paper: 'plan' | שם נייר
export function paperSize(paper, orient, content, planPt) {
  let w, h;
  if (paper === 'plan' && planPt) { w = planPt.w; h = planPt.h; } else {
    const p = PAPERS.find((x) => x[0] === paper) || PAPERS[4];
    w = mmToPt(p[1]); h = mmToPt(p[2]);
  }
  const wantLand = orient === 'landscape' || (orient === 'auto' && content.cw > content.ch);
  if (paper === 'plan') return { w, h };
  return wantLand ? { w: Math.max(w, h), h: Math.min(w, h) } : { w: Math.min(w, h), h: Math.max(w, h) };
}

// block: { cw, ch, tiles: [{ ..., x, y, w, h }] } (יחידות תוכן, מקור למעלה-שמאל).
// מחזיר גיליון: { pw, ph, s, tiles: [{ ...tile, dest: { x, y, w, h } }] } ביחידות נקודה (1/72")
export function layoutSheet(block, { paper, orient, margin, planPt }) {
  const mPt = mmToPt(MARGINS[margin] ?? 0);
  const { w: pw, h: ph } = paperSize(paper, orient, block, planPt);
  const aw = Math.max(10, pw - 2 * mPt), ah = Math.max(10, ph - 2 * mPt);
  const s = Math.min(aw / block.cw, ah / block.ch);
  const ox = (pw - block.cw * s) / 2, oy = (ph - block.ch * s) / 2;
  return {
    pw, ph, s,
    tiles: block.tiles.map((t) => ({ ...t, dest: { x: ox + t.x * s, y: oy + t.y * s, w: t.w * s, h: t.h * s } })),
  };
}
