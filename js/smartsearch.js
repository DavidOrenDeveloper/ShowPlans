// חיפוש חכם (משותף לכל שדות החיפוש באפליקציה)
//  • כמה מילים בכל סדר, לא חייבות להיות צמודות: "טרפו חדר" מוצא "חדר טרפו"
//  • מילים נבדקות גם מול שם הקובץ וגם מול שמות התיקיות שמעליו: "קומה A חשמל" מוצא את "קומה A" שבתיקיית חשמל.
//    התאמה בשם הקובץ עצמו תמיד גוברת על התאמה דרך שם תיקייה (קובץ בשם "אדריכלות קומה A" יופיע לפני "קומה A" שבתיקיית אדריכלות)
//  • מתעלם משינויים קלים: ו/י חסרות או מיותרות (טרפו/טרפ, שמל/שמל), אותיות סופיות, ניקוד, גרשיים, רישיות,
//    קידומת ו/ה/ב/ל/מ/ש, טעות הקלדה אחת, וגם הדבקה בין עברית/אנגלית/ספרות ("קומהA" = "קומה A")
const NIQQUD = /[\u0591-\u05C7\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const FINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const DROP_IN_WORD = new Set(['"', "'", '’', '‘', '״', '׳', '`']); // גרשיים בתוך מילה לא שוברים אותה (ת"א → תא)
const isHeb = (c) => c >= '\u05D0' && c <= '\u05EA';
const clsOf = (c) => (isHeb(c) ? 'h' : (c >= 'a' && c <= 'z') ? 'l' : (c >= '0' && c <= '9') ? 'd' : (c > '\u007f' && /\p{L}/u.test(c) ? 'o' : ''));

// "שלד" של מילה בעברית: בלי ו/י (כתיב מלא/חסר) ועם אותיות סופיות רגילות. מילה שנשארה עם פחות מ-2 אותיות נשארת כמו שהיא.
function skeleton(chars) {
  const base = chars.map((x) => ({ c: FINAL[x.c] || x.c, i: x.i }));
  const kept = base.filter((x) => x.c !== 'ו' && x.c !== 'י');
  return kept.length >= 2 ? kept : base;
}

// מנרמל טקסט: מחזיר {t, map, words}. t = מילים מנורמלות מופרדות ברווח; map[i] = אינדקס בטקסט המקורי של התו ה-i ב-t;
// words = [{w, ts, te}] (מיקומים ב-t)
export function normMap(src) {
  const s = String(src == null ? '' : src);
  const words = [];
  let cur = null;
  const flush = () => { if (cur && cur.chars.length) words.push(cur); cur = null; };
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (NIQQUD.test(ch)) continue;
    const lo = ch.toLowerCase(); if (lo.length === 1) ch = lo;
    if (DROP_IN_WORD.has(ch)) continue;
    const k = clsOf(ch);
    if (!k) { flush(); continue; }
    if (!cur || cur.k !== k) { flush(); cur = { k, chars: [] }; }
    cur.chars.push({ c: ch, i });
  }
  flush();
  let t = '';
  const map = [], out = [];
  for (const w of words) {
    const chars = w.k === 'h' ? skeleton(w.chars) : w.chars;
    if (t) { t += ' '; map.push(chars[0].i); }
    const ts = t.length;
    for (const x of chars) { t += x.c; map.push(x.i); }
    out.push({ w: t.slice(ts), ts, te: t.length, k: w.k, os: w.chars[0].i, oe: w.chars[w.chars.length - 1].i + 1 });
  }
  return { t, map, words: out };
}

// גרסה מהירה בלי מיפוי (לסריקת אינדקס הטקסט של כל ה-PDF-ים)
const HEBRUN = /[\u05D0-\u05EA]+/g;
export function fastNorm(src) {
  let s = String(src == null ? '' : src).toLowerCase();
  s = s.replace(/[\u0591-\u05C7\u200e\u200f\u202a-\u202e\u2066-\u2069"'’‘״׳`]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  s = s.replace(/([\u05D0-\u05EA])(?=[a-z0-9])|([a-z0-9])(?=[\u05D0-\u05EA])|([a-z])(?=[0-9])|([0-9])(?=[a-z])/g, (m) => m + ' ');
  s = s.replace(HEBRUN, (w) => {
    const b = w.replace(/[ךםןףץ]/g, (c) => FINAL[c]);
    const k = b.replace(/[וי]/g, '');
    return k.length >= 2 ? k : b;
  });
  return s.replace(/\s+/g, ' ').trim();
}

export function within1(a, b) { // מרחק עריכה ≤ 1 (כולל החלפת שתי אותיות סמוכות)
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

export function parseQuery(q) {
  const nm = normMap(q);
  const seen = new Set(), tokens = [];
  for (const w of nm.words) if (!seen.has(w.w)) { seen.add(w.w); tokens.push({ w: w.w, k: w.k }); }
  if (!tokens.length) return null;
  return { tokens, phrase: tokens.map((x) => x.w).join(' '), raw: String(q || '') };
}

const PREFIX1 = new Set(['ה', 'ב', 'כ', 'ל', 'מ', 'ש']); // (ו כבר הוסרה בשלד)
// איכות התאמה של מילת חיפוש מול טקסט מנורמל: 3 = מילה זהה, 2 = התחלה/חלק ממילה, 1 = קרוב (טעות אחת / קידומת), 0 = אין
function tokenQuality(tok, nm, fuzzy = true) {
  const w = tok.w, n = w.length, t = nm.t, ws = nm.words;
  if (!n || !t) return 0;
  for (const x of ws) if (x.w === w) return 3;
  if (n >= 3) { if (t.includes(w)) return 2; }
  else if (n === 2) { for (const x of ws) if (x.w.startsWith(w)) return 2; }
  if (!fuzzy) return 0;
  if (tok.k === 'h' && n >= 4 && PREFIX1.has(w[0])) { const w2 = w.slice(1); if (ws.some((x) => x.w === w2) || t.includes(w2)) return 1; }
  if (n >= 4) for (const x of ws) { if (x.k === tok.k && Math.abs(x.w.length - n) <= 1 && within1(w, x.w)) return 1; }
  if (n >= 5) for (const x of ws) { if (x.k === tok.k && x.w.length >= 4 && x.w.length < n && within1(w.slice(0, x.w.length), x.w) && n - x.w.length <= 2) return 1; }
  return 0;
}

const memo = new Map();
const nmOf = (s) => {
  let r = memo.get(s);
  if (!r) { r = normMap(s); if (memo.size > 6000) memo.clear(); memo.set(s, r); }
  return r;
};

// ניקוד התאמה של פריט (תוכנית/תיקייה): names = שמות הפריט (מקור + תרגום), path = שמות התיקיות שמעליו, מהשורש כלפי מטה: [[גרסאות שם]...]
// maxMissing = כמה מילות חיפוש מותר שלא ימצאו. מחזיר null אם אין התאמה, אחרת מספר (גבוה = טוב יותר)
export function scoreItem(Q, names, path = [], maxMissing = 0) {
  const nn = names.map(nmOf), pp = path.map((lvl) => lvl.map(nmOf));
  let score = 0, miss = 0, inName = 0;
  for (const tok of Q.tokens) {
    let qn = 0;
    for (const x of nn) qn = Math.max(qn, tokenQuality(tok, x));
    if (qn) { score += 6 + qn * 2; inName++; continue; }
    let best = 0;
    pp.forEach((lvl, depth) => { for (const x of lvl) { const q = tokenQuality(tok, x); if (q) best = Math.max(best, 2 + q + depth * 0.1); } });
    if (best) score += best; else if (++miss > maxMissing) return null;
  }
  if (inName === Q.tokens.length) score += 20; // כל המילים בשם הקובץ עצמו: גובר על התאמה דרך תיקייה
  if (Q.tokens.length > 1) for (const x of nn) { if (x.t.includes(Q.phrase)) { score += 15; break; } }
  for (const x of nn) { if (x.t === Q.phrase) { score += 30; break; } }
  return score - miss * 8;
}

// מדרג רשימה: מחזיר [{item, score}] ממוין. miss = כמה מילות חיפוש מותר שיחסרו (ברירת מחדל 0)
export function rank(Q, items, getNames, getPath, miss = 0) {
  if (!Q) return [];
  const out = [];
  for (const item of items) { const s = scoreItem(Q, getNames(item), getPath ? getPath(item) : [], miss); if (s != null) out.push({ item, score: s }); }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- טקסט חופשי (תוכן PDF) ----------
// איתור מילות החיפוש בטקסט מנורמל: לכל מילה רשימת מופעים [ts, te) ב-t. בלי התאמה מקורבת (כבד מדי על הרבה טקסט)
export function findTokens(Q, nm, { any = false } = {}) {
  const t = nm.t, occ = [];
  for (const tok of Q.tokens) {
    const w = tok.w, list = [];
    if (w.length >= 3) { let i = -1; while ((i = t.indexOf(w, i + 1)) >= 0) list.push([i, i + w.length]); }
    else for (const x of nm.words) { if (x.w === w || (w.length === 2 && x.w.startsWith(w))) list.push([x.ts, x.ts + w.length]); }
    occ.push(list);
  }
  if (!any && occ.some((l) => !l.length)) return null;
  if (any && occ.every((l) => !l.length)) return null;
  return occ;
}
// שורת בדיקה זולה: האם כל המילים נמצאות בטקסט מנורמל (בלי מיפוי)
export function hasAll(Q, normText) {
  for (const tok of Q.tokens) {
    const w = tok.w;
    if (w.length >= 3) { if (!normText.includes(w)) return false; }
    else if (w.length === 2) { if (!(normText.startsWith(w) || normText.includes(' ' + w))) return false; }
    else if (!(normText === w || normText.startsWith(w + ' ') || normText.endsWith(' ' + w) || normText.includes(' ' + w + ' '))) return false;
  }
  return true;
}
// בונה "קבוצות" התאמה: סביב כל מופע של המילה הנדירה ביותר – המופע הקרוב ביותר של כל מילה אחרת (לא חייב סדר/צמידות)
export function groups(Q, nm, occ, { max = 500 } = {}) {
  const have = occ.map((l, i) => ({ i, l })).filter((x) => x.l.length);
  if (!have.length) return [];
  const anchor = have.reduce((a, b) => (b.l.length < a.l.length ? b : a));
  const out = [], seen = new Set();
  for (const a of anchor.l) {
    const spans = [{ ts: a[0], te: a[1] }];
    for (const o of have) {
      if (o === anchor) continue;
      let best = null, bd = Infinity;
      for (const x of o.l) { const d = x[0] > a[1] ? x[0] - a[1] : a[0] > x[1] ? a[0] - x[1] : 0; if (d < bd) { bd = d; best = x; } }
      if (best) spans.push({ ts: best[0], te: best[1] });
    }
    const key = spans.map((s) => s.ts).sort((p, q) => p - q).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const lo = Math.min(...spans.map((s) => s.ts)), hi = Math.max(...spans.map((s) => s.te));
    out.push({ spans, anchor: spans[0], lo, hi, span: hi - lo });
    if (out.length >= max) break;
  }
  return out.sort((p, q) => p.anchor.ts - q.anchor.ts);
}
// ממיר טווח ב-t לטווח בטקסט המקורי
// (אם הטווח מגיע לקצה מילה, מרחיבים לקצה המילה המקורית כולל ו/י שהוסרו, כדי שההדגשה תכסה את המילה כולה)
export function toOrig(nm, ts, te) {
  let start = nm.map[ts], end = nm.map[Math.max(ts, te - 1)] + 1;
  for (const w of nm.words) { if (w.ts === ts) start = w.os; if (w.te === te) end = w.oe; }
  return { start, end };
}
