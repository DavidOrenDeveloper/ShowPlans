// תרגום שמות שהמשתמשים נתנו לקבצים/תיקיות (למשל "תוכנית חשמל קומה 2" ⇄ "Electrical Plan Floor 2") לשפת הממשק הנוכחית.
// התרגום להצגה בלבד: השם המקורי נשמר כמו שנכתב, ובעריכה/שינוי שם רואים את המקורי.
// שלבים: 1) מילון מונחי בנייה (glossary.js) – מיידי ובלי אינטרנט, כולל סדר מילים ("תוכנית חשמל" ← "Electrical Plan").
//        2) מילים שאינן במילון נשלחות לתרגום ברשת (MyMemory, חינמי) פעם אחת, והתשובה נשמרת במכשיר – אחר כך עובד גם בלי אינטרנט.
// מצבים (נשמרים במכשיר): 'full' מילון + רשת (ברירת מחדל) · 'glossary' מילון בלבד, בלי שום בקשה לרשת · 'off' שמות כפי שנכתבו.
import { GLOSSARY, HE_LETTERS } from './glossary.js';
import { getLang } from './i18n.js';

const MODE_KEY = 'name-tr-mode', CACHE_KEY = 'name-tr-cache-v1';
const HEB = /[֐-׿]/, LAT = /[A-Za-z]/;
let mode = 'full';
try { const m = localStorage.getItem(MODE_KEY); if (m === 'full' || m === 'glossary' || m === 'off') mode = m; } catch { /* ignore */ }
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch { cache = {}; }
const saveCache = () => { try { const k = Object.keys(cache); if (k.length > 1500) k.slice(0, 300).forEach((x) => delete cache[x]); localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ } };

const subs = new Set();
export const onNamesChange = (f) => { subs.add(f); return () => subs.delete(f); };
let memo = new Map();
let notifyT = null;
const notify = () => { memo = new Map(); clearTimeout(notifyT); notifyT = setTimeout(() => subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }), 250); };
export const getNameMode = () => mode;
export function setNameMode(m) { mode = m; try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } notify(); }

// ---------- אינדקס המילון ----------
const normHe = (w) => w.replace(/["'׳״’]/g, '').replace(/[֑-ׇ]/g, '');
const normEn = (w) => w.toLowerCase();
let IDX = null;
function build() {
  const he = new Map(), en = new Map();
  let maxHe = 1, maxEn = 1;
  for (const raw of GLOSSARY.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = /^([KDA]):/.exec(line); const type = m ? m[1] : 'N';
    const [l, r] = (m ? line.slice(2) : line).split('=').map((x) => x.trim());
    const hes = l.split('|').map((x) => x.trim()), ens = r.split('|').map((x) => x.trim());
    const fem = hes[0].endsWith('*'); hes[0] = hes[0].replace(/\*$/, '');
    const ent = { type, he: hes, en: ens, fem, canonHe: hes[0], canonEn: ens[0] };
    for (const k of hes) { const key = k.split(/\s+/).map(normHe).join(' '); if (!he.has(key)) he.set(key, ent); maxHe = Math.max(maxHe, key.split(' ').length); }
    for (const k of ens) { const key = k.split(/\s+/).map(normEn).join(' '); if (!en.has(key)) en.set(key, ent); maxEn = Math.max(maxEn, key.split(' ').length); }
  }
  IDX = { he, en, maxHe, maxEn };
}

// ---------- פירוק שם למילים ----------
const PIECE = /([֐-׿]+(?:["'׳״’][֐-׿]*)*|[A-Za-z]+(?:\/[A-Za-z])?|[0-9]+)|([^֐-׿A-Za-z0-9]+)/g;
const SIMPLE_GAP = /^[ _\-–]+$/;
function pieces(name) {
  const out = []; let m; PIECE.lastIndex = 0;
  while ((m = PIECE.exec(name))) out.push(m[1] ? { w: true, s: m[1], lang: HEB.test(m[1]) ? 'he' : LAT.test(m[1]) ? 'en' : 'num' } : { w: false, s: m[2] });
  return out;
}
const titleCase = (s) => s.replace(/\S+/g, (w, i) => (i > 0 && /^(and|for|of|with|in|to|from|or|the|between)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));

const HE_PREFIX = [['ומה', 'and from '], ['וה', 'and '], ['ול', 'and for '], ['וב', 'and in '], ['מה', 'from '], ['לה', 'for '], ['בה', 'in '], ['ו', 'and '], ['ה', ''], ['ב', 'in '], ['ל', 'for '], ['מ', 'from ']];
const EN_CONN = { and: 'ו', for: 'ל', in: 'ב', to: 'ל' }, EN_SEP = { of: 'של', with: 'עם', or: 'או', between: 'בין' };

// ---------- תרגום עם מילון ----------
function run(name, from) {
  if (!IDX) build();
  const map = from === 'he' ? IDX.he : IDX.en, maxL = from === 'he' ? IDX.maxHe : IDX.maxEn, norm = from === 'he' ? normHe : normEn;
  const P = pieces(name);
  const W = []; // מילים בשפת המקור + אינדקס ב-P
  P.forEach((p, i) => { if (p.w) W.push({ i, key: norm(p.s), lang: p.lang, s: p.s }); });
  const linked = (a, b) => { // אין בין שתי מילים סמוכות שום דבר מלבד רווח/קו
    const x = W[a], y = W[b]; if (!x || !y || x.lang !== from || y.lang !== from) return false;
    for (let k = x.i + 1; k < y.i; k++) if (!(!P[k].w && SIMPLE_GAP.test(P[k].s))) return false;
    return y.i > x.i;
  };
  const direct = (j, firstKey) => { // התאמה ישירה הארוכה ביותר שמתחילה במילה j
    for (let L = Math.min(maxL, W.length - j); L >= 1; L--) {
      let ok = true; const keys = [];
      for (let k = 0; k < L; k++) { const w = W[j + k]; if (w.lang !== from || (k > 0 && !linked(j + k - 1, j + k))) { ok = false; break; } keys.push(k === 0 && firstKey ? firstKey : w.key); }
      if (!ok) continue;
      const ent = map.get(keys.join(' ')); if (ent) return { ent, n: L };
    }
    return null;
  };
  const typed = (j, t, firstKey) => { // ההתאמה הארוכה ביותר מסוג מסוים (K/D/A) שמתחילה במילה j
    for (let L = Math.min(maxL, W.length - j); L >= 1; L--) {
      let ok = true; const keys = [];
      for (let k = 0; k < L; k++) { const w = W[j + k]; if (w.lang !== from || (k > 0 && !linked(j + k - 1, j + k))) { ok = false; break; } keys.push(k === 0 && firstKey ? firstKey : w.key); }
      if (!ok) continue;
      const e = map.get(keys.join(' ')); if (e && e.type === t) return { ent: e, n: L };
    }
    return null;
  };
  const txt = (e) => (from === 'he' ? e.canonEn : e.canonHe);
  // יחידה = ביטוי מהמילון, או "סוג מסמך + תחום" (עם החלפת סדר)
  const unit = (j, firstKey) => {
    const d = direct(j, firstKey);
    let combo = null;
    if (from === 'he') { const k = typed(j, 'K', firstKey); if (k && linked(j + k.n - 1, j + k.n)) { const dd = typed(j + k.n, 'D'); if (dd) combo = { n: k.n + dd.n, text: dd.ent.canonEn + ' ' + k.ent.canonEn, ent: k.ent }; } }
    else { const dd = typed(j, 'D', firstKey); if (dd && linked(j + dd.n - 1, j + dd.n)) { const k = typed(j + dd.n, 'K'); if (k) combo = { n: dd.n + k.n, text: k.ent.canonHe + ' ' + dd.ent.canonHe, ent: k.ent }; } }
    if (combo && (!d || combo.n > d.n)) return combo;
    return d ? { n: d.n, text: txt(d.ent), ent: d.ent } : null;
  };
  const adjText = (a, nounEnt) => {
    if (from === 'he') return a.canonEn;
    if (!nounEnt) return a.he[0];
    const plural = /(ים|ות)$/.test(nounEnt.canonHe), i = plural ? (/ות$/.test(nounEnt.canonHe) ? 3 : 2) : (nounEnt.fem ? 1 : 0);
    return a.he[i] || a.he[nounEnt.fem ? 1 : 0] || a.he[0];
  };
  const out = []; // {s, run}
  const runs = [];
  let j = 0, wi = 0, lastPieceEmitted = -1;
  const emitGap = (upTo) => { for (let k = lastPieceEmitted + 1; k < upTo; k++) out.push({ s: P[k].s }); lastPieceEmitted = Math.max(lastPieceEmitted, upTo - 1); };
  while (j < W.length) {
    const w = W[j];
    emitGap(w.i);
    if (w.lang !== from) { out.push({ s: w.s }); lastPieceEmitted = w.i; j++; continue; }
    // אות בבניין/קומה: א׳ ← A
    if (from === 'he' && w.s.length === 2 && /["'׳’]/.test(w.s[1]) && HE_LETTERS[w.s[0]]) { out.push({ s: HE_LETTERS[w.s[0]] }); lastPieceEmitted = w.i; j++; continue; }
    let u = unit(j), pre = '';
    if (!u && from === 'he') {
      for (const [pf, en] of HE_PREFIX) { if (w.key.startsWith(pf) && w.key.length - pf.length >= 2) { const v = unit(j, w.key.slice(pf.length)); if (v) { u = v; pre = en; break; } } }
    }
    if (!u && from === 'en') { // and/for/in + מילה ← ו/ל/ב כתחילית
      const c = EN_CONN[w.key]; const nx = c && W[j + 1] && linked(j, j + 1) ? unit(j + 1) : null;
      if (nx) { out.push({ s: c + nx.text }); lastPieceEmitted = W[j + nx.n].i; j += 1 + nx.n; continue; }
      if (EN_SEP[w.key]) { out.push({ s: EN_SEP[w.key] }); lastPieceEmitted = w.i; j++; continue; }
      if (w.key === 'the') { lastPieceEmitted = w.i; j++; if (out.length && !P[w.i + 1]?.w) lastPieceEmitted = w.i + 1; continue; }
    }
    if (u) {
      let text = pre + u.text, n = u.n;
      if (from === 'he') { // שם עצם + תואר ← תואר לפני שם העצם
        const adjs = [];
        while (u.ent.type !== 'A' && linked(j + n - 1, j + n)) { const a = typed(j + n, 'A'); if (!a) break; adjs.push(a.ent.canonEn); n += a.n; }
        if (adjs.length) text = pre + adjs.join(' ') + ' ' + u.text;
      } else if (u.ent.type === 'A') { // תואר לפני שם עצם ← שם עצם + תואר
        const adjs = [u.ent]; let nu = null; let k = j + n;
        while (linked(k - 1, k)) { const x = unit(k); if (!x) break; if (x.ent.type === 'A') { adjs.push(x.ent); k += x.n; } else { nu = x; k += x.n; break; } }
        if (nu) { text = nu.text + ' ' + adjs.map((a) => adjText(a, nu.ent)).join(' '); n = k - j; }
      }
      out.push({ s: text }); lastPieceEmitted = W[j + n - 1].i; j += n; continue;
    }
    // מילה לא מוכרת: נשארת כמו שהיא, ומילים רצופות כאלה נאספות לתרגום ברשת
    const lastRun = runs[runs.length - 1];
    const part = { s: w.s, run: null };
    if (lastRun && lastRun.endW === j - 1 && linked(j - 1, j)) { lastRun.phrase += ' ' + w.s; lastRun.endW = j; part.run = lastRun; }
    else { const nr = { phrase: w.s, endW: j }; runs.push(nr); part.run = nr; }
    out.push(part); lastPieceEmitted = w.i; j++;
  }
  emitGap(P.length);
  return { out, runs, from };
}

// ---------- תרגום ברשת (MyMemory) ----------
const inflight = new Set(); let netQueue = Promise.resolve(); let failUntil = 0;
const cacheKey = (from, phrase) => `${from}:${phrase.trim().toLowerCase()}`;
function lookupOnline(from, phrase) {
  const key = cacheKey(from, phrase);
  if (key in cache || inflight.has(key) || Date.now() < failUntil || mode !== 'full' || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  inflight.add(key);
  netQueue = netQueue.then(async () => {
    try {
      const to = from === 'he' ? 'en' : 'he';
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(phrase + (from === 'he' ? '' : ''))}&langpair=${from}|${to}&mt=1`, { signal: ctl.signal });
      clearTimeout(tm);
      const j = await res.json();
      let t = j && j.responseData && j.responseData.translatedText;
      const bad = !t || +j.responseStatus !== 200 || /MYMEMORY|INVALID|QUERY LENGTH|PLEASE SELECT/i.test(t) || t.trim().toLowerCase() === phrase.trim().toLowerCase();
      if (bad) { cache[key] = ''; if (+j.responseStatus === 429) failUntil = Date.now() + 10 * 60 * 1000; }
      else cache[key] = (to === 'en' ? titleCase(t.replace(/[.]+$/, '')) : t.replace(/[.]+$/, '')).trim();
      saveCache(); notify();
    } catch { failUntil = Date.now() + 2 * 60 * 1000; }
    finally { inflight.delete(key); }
    await new Promise((r) => setTimeout(r, 400));
  });
}

function assemble(r) {
  let s = ''; const done = new Set();
  for (const p of r.out) {
    if (p.run) {
      const t = mode === 'full' ? cache[cacheKey(r.from, p.run.phrase)] : '';
      if (t) { if (!done.has(p.run)) { s += t; done.add(p.run); } continue; }
    }
    s += p.s;
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

// השם להצגה בשפת הממשק. סינכרוני: מחזיר מיד את מה שיודעים (מילון + מה ששמור), ותרגום מהרשת מתעדכן אחר כך דרך onNamesChange.
export function dn(name) {
  if (!name || mode === 'off') return name;
  const to = getLang(), from = to === 'en' ? 'he' : 'en';
  if (!(from === 'he' ? HEB : LAT).test(name)) return name;
  const mk = `${to}|${name}`;
  if (memo.has(mk)) return memo.get(mk);
  let res = name;
  try {
    const r = run(name, from);
    if (mode === 'full') r.runs.forEach((x) => { if (!(cacheKey(from, x.phrase) in cache) && (from === 'he' || x.phrase.length > 2)) lookupOnline(from, x.phrase); });
    res = assemble(r) || name;
  } catch (e) { console.warn('dn', e); }
  memo.set(mk, res);
  return res;
}
// לחיפוש: גם השם המקורי וגם התרגום
export const nameVariants = (name) => { const a = dn(name); return a === name ? [name] : [name, a]; };
