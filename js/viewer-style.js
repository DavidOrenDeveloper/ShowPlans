// סרגל המאפיינים ופאנל העיצוב של ה-Viewer: צבע קו, מילוי, שקיפות, עובי, וגודל טקסט.
// אם נבחר פריט – העריכה חלה עליו (עם Undo). אחרת – היא קובעת את ברירת המחדל לציור הבא.
import { t as tr } from './i18n.js';
import { h, icon, clone } from './util.js';
import * as UI from './ui.js';
import { prefs, savePrefs, COLORS, WIDTHS } from './prefs.js';
import { kindOf, canFill, hasFill, isNoStroke, boundsOf, FM, setFm, setAllFm, allFm, remask, pfList, pfStore, lineCount, isRTL } from './markup.js';
import * as SH from './item-share-ui.js';
import { itemAccess } from './cloud-sync.js';

const CS_ACCESS = (v, it) => itemAccess(it, it.layer || 'markups');
const SH_NAME = (id) => SH.nameOf(id) || tr('משתמש אחר');
const SH_DIALOG = (v, o) => SH.shareDialog(v, o);

const TOOL_KIND = { pen: 'shape', line: 'shape', polyline: 'shape', arrow: 'shape', rect: 'shape', ellipse: 'shape', text: 'text', highlight: 'hl' };
const PREF_KEYS = {
  shape: { color: 'color', fill: 'fill', fillOp: 'fillOp', op: 'op', width: 'w' },
  text: { color: 'tcolor', op: 'top', bg: 'tbg', bgOp: 'tbgop', bold: 'tbold', italic: 'titalic', underline: 'tunder', strike: 'tstrike' },
  hl: { color: 'hcolor', fillOp: 'hop' },
};
const FILL_COLORS = [...COLORS.slice(0, 5), '#ffffff', '#111111'];
const pct = (v) => Math.round(v * 100) + '%';

export function installStyle(V) {
  Object.assign(V.prototype, {
    styleCtx() {
      const sel = this.selected;
      if (sel) return { sel, kind: kindOf(sel.type), type: sel.type };
      return { sel: null, kind: TOOL_KIND[this.tool] || null, type: this.tool };
    },

    getStyle(key) {
      const { sel, kind, type } = this.styleCtx();
      if (sel) {
        switch (key) {
          case 'color': return isNoStroke(sel) ? 'none' : sel.color;
          case 'fill': return hasFill(sel) ? sel.fill : null;
          case 'fillOp': return sel.fillOp == null ? (type === 'highlight' ? 0.35 : 0.3) : sel.fillOp;
          case 'op': return sel.op == null ? 1 : sel.op;
          case 'width': return Math.round(sel.width * this.scale * 10) / 10;
          case 'size': return sel.fontSize;
          case 'bg': return sel.bg || null;
          case 'bgOp': return sel.bgOp == null ? 1 : sel.bgOp;
          case 'bold': case 'italic': case 'underline': case 'strike': return allFm(sel, FM[key]);
          default: return undefined;
        }
      }
      const m = PREF_KEYS[kind];
      return m && m[key] ? prefs[m[key]] : undefined;
    },

    // live=true: תצוגה מקדימה בזמן גרירת מחוון (בלי שמירה); השמירה נעשית ב-commitEdit
    setStyle(key, val, live = false) {
      const { sel, kind } = this.styleCtx();
      if (sel && !this.canEditItem(sel)) return;
      if (sel) {
        const mut = (it) => {
          switch (key) {
            case 'color': {
              const old = it.color;
              it.color = val;
              if (val === 'none' && !hasFill(it) && canFill(it)) { it.fill = old && old !== 'none' ? old : '#e53935'; if (it.fillOp == null) it.fillOp = 0.3; }
              break;
            }
            case 'fill':
              it.fill = val;
              if (val && it.fillOp == null) it.fillOp = 0.3;
              if (!val && isNoStroke(it)) it.color = '#e53935';
              break;
            case 'fillOp': it.fillOp = val; break;
            case 'op': it.op = val; break;
            case 'width': it.width = val / this.scale; break;
            case 'size': it.fontSize = val; break;
            case 'bg': if (val) it.bg = val; else delete it.bg; break;
            case 'bgOp': it.bgOp = val; break;
            case 'bold': case 'italic': case 'underline': case 'strike': setAllFm(it, FM[key], !!val); break;
            default: break;
          }
        };
        if (live) this.liveEdit(mut); else this.modifySelected(mut);
        if (prefs.keep) this.keepStyle(key, val);
        return;
      }
      const m = PREF_KEYS[kind];
      if (!m || !m[key]) return;
      prefs[m[key]] = val;
      savePrefs();
      if (!live) this.renderProps();
    },

    // "שמור עיצוב" (Keep tool selected): כשפעיל, כל שינוי עיצוב בפריט נבחר נשמר גם כברירת מחדל לסימון הבא, עד שמשנים שוב
    keepStyle(key, val) {
      const { kind } = this.styleCtx();
      const m = PREF_KEYS[kind];
      if (!m) return;
      if (key === 'size') { if (kind === 'text') prefs.tsize = Math.max(8, Math.round(val * this.scale)); }
      else if (m[key]) { if (key === 'color' && val === 'none') return; prefs[m[key]] = val; }
      else return;
      savePrefs();
    },
    keepFromSel() {
      const { sel, kind } = this.styleCtx();
      const m = PREF_KEYS[kind];
      if (!sel || !m || !this.canEditItem(sel)) return;
      for (const k of Object.keys(m)) { if ((k === 'fill' || k === 'fillOp') && kind === 'shape' && !canFill(sel)) continue; const v = this.getStyle(k); if (v !== undefined && !(k === 'color' && v === 'none')) prefs[m[k]] = v; }
      if (kind === 'text') prefs.tsize = Math.max(8, Math.round(sel.fontSize * this.scale));
      if (sel.type === 'measure' || sel.type === 'area') for (const k of ['color', 'width', 'tcolor', 'tsize']) prefs[{ color: 'mcolor', width: 'mw', tcolor: 'mtcolor', tsize: 'mtsize' }[k]] = this.measGet(k);
      savePrefs();
    },
    keepBtn() {
      const on = !!prefs.keep;
      return h('button', { class: 'btn sm' + (on ? ' primary' : ''), title: tr('שמור עיצוב: ההגדרות הנוכחיות (צבע, שקיפות, עובי, גודל…) יישארו לכל הסימונים הבאים עד שתשנו אותן שוב'), 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { prefs.keep = !prefs.keep; if (prefs.keep) this.keepFromSel(); savePrefs(); UI.toast(prefs.keep ? tr('העיצוב הנוכחי נשמר לסימונים הבאים') : tr('שמירת העיצוב כובתה')); this.renderProps(); } },
        icon('lock', 16), tr('שמור עיצוב'));
    },

    // ---------- עיצוב טקסט: מודגש / נטוי / קו תחתון / קו חוצה ----------
    // בזמן עריכה על התוכנית – חל על הטקסט המסומן (כמו בעורך תמלילים). בלי עריכה – על כל הטקסט הנבחר, ואם לא נבחר – ברירת מחדל לטקסט הבא
    fmtRow() {
      const defs = [['bold', 'B', tr('מודגש'), 'bold', 'font-weight:800'], ['italic', 'I', tr('נטוי'), 'italic', 'font-style:italic;font-weight:600'], ['underline', 'U', tr('קו תחתון'), 'underline', 'text-decoration:underline;font-weight:600'], ['strike', 'S', tr('קו חוצה'), 'strikeThrough', 'text-decoration:line-through;font-weight:600']];
      return defs.map(([k, ch, title, cmd, css]) => {
        const on = this.fmtState(k, cmd);
        const b = h('button', { class: 'btn sm fmt' + (on ? ' primary' : ''), title, 'aria-label': title, 'aria-pressed': on ? 'true' : 'false', 'data-fmt': k, 'data-cmd': cmd,
          onclick: () => { if (this.inl) { this.inl.ed.focus(); document.execCommand('styleWithCSS', false, false); document.execCommand(cmd, false); this.refreshFmt(); } else this.setStyle(k, !this.getStyle(k)); } }, h('span', { style: css }, ch));
        for (const ev of ['pointerdown', 'mousedown']) b.addEventListener(ev, (e) => e.preventDefault()); // לא גונב את המיקוד מהעורך שעל התוכנית
        return b;
      });
    },
    fmtState(k, cmd) {
      if (this.inl) { try { return document.queryCommandState(cmd); } catch { return false; } }
      return !!this.getStyle(k);
    },
    refreshFmt() {
      this.el?.querySelectorAll('[data-fmt]').forEach((b) => { const on = this.fmtState(b.dataset.fmt, b.dataset.cmd); b.classList.toggle('primary', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      this.el?.querySelectorAll('[data-blk]').forEach((b) => { const [k, v] = b.dataset.blk.split(':'); const on = this.blockState(k, v); b.classList.toggle('primary', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    },

    // ---------- רשימות ויישור (לפי שורה/פסקה) ----------
    blockRow() {
      const ic = (d) => { const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('width', '16'); sv.setAttribute('height', '16'); sv.setAttribute('fill', 'none'); sv.setAttribute('stroke', 'currentColor'); sv.setAttribute('stroke-width', '2'); sv.setAttribute('stroke-linecap', 'round'); sv.innerHTML = d; return sv; };
      const L = (w, y, al) => `<line x1="${al === 'l' ? 4 : al === 'r' ? 20 - w : 12 - w / 2}" y1="${y}" x2="${al === 'l' ? 4 + w : al === 'r' ? 20 : 12 + w / 2}" y2="${y}"/>`;
      const al = (a) => L(16, 6, a) + L(10, 12, a) + L(16, 18, a);
      const defs = [
        ['b', 'list', tr('רשימת נקודות'), ic('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>')],
        ['n', 'list', tr('רשימה ממוספרת'), h('span', { style: 'font-size:12px;font-weight:700;letter-spacing:-1px' }, '1.2.')],
        ['l', 'align', tr('יישור לשמאל'), ic(al('l'))], ['c', 'align', tr('יישור למרכז'), ic(al('c'))], ['r', 'align', tr('יישור לימין'), ic(al('r'))],
      ];
      return defs.map(([v, kind, title, content]) => {
        const on = this.blockState(kind, v);
        const b = h('button', { class: 'btn sm fmt' + (on ? ' primary' : ''), title, 'aria-label': title, 'aria-pressed': on ? 'true' : 'false', 'data-blk': kind + ':' + v, onclick: () => this.blockSet(kind, v) }, content);
        for (const ev of ['pointerdown', 'mousedown']) b.addEventListener(ev, (e) => e.preventDefault());
        return b;
      });
    },
    // השורות שנוגעת בהן הבחירה בעורך (או כל השורות כשלא עורכים)
    inlLines() {
      const ed = this.inl.ed, sel = window.getSelection();
      const all = [...ed.children];
      if (!sel.rangeCount || !ed.contains(sel.anchorNode)) return all.slice(0, 1);
      const r = sel.getRangeAt(0), out = all.filter((d) => r.intersectsNode(d));
      return out.length ? out : all.slice(0, 1);
    },
    blockState(kind, v) {
      const key = kind === 'list' ? 'l' : 'a';
      if (this.inl) { const ls = this.inlLines(); return ls.length > 0 && ls.every((d) => (d.dataset[key] || '') === v); }
      const it = this.selected; if (!it || it.type !== 'text') return false;
      return pfList(it, lineCount(it)).every((x) => x[key] === v);
    },
    blockSet(kind, v) {
      const key = kind === 'list' ? 'l' : 'a';
      if (this.inl) {
        this.inl.ed.focus();
        const ls = this.inlLines(), on = ls.every((d) => (d.dataset[key] || '') === v);
        ls.forEach((d) => { if (kind === 'list' && on) delete d.dataset[key]; else d.dataset[key] = v; });
        this.fixEmptyDirs(this.inl.ed); this.positionInline(); this.refreshFmt();
        return;
      }
      const it = this.selected; if (!it || it.type !== 'text') return;
      const on = this.blockState(kind, v);
      this.modifySelected((i) => { const arr = pfList(i, lineCount(i)); arr.forEach((x) => { x[key] = kind === 'list' && on ? '' : v; }); pfStore(i, arr); });
    },

    // ---------- עריכת טקסט ישירות על התוכנית (contenteditable, עם עיצוב חלקי למילים מסומנות) ----------
    lineEl(l, a, runs) {
      const d = document.createElement('div'); d.setAttribute('dir', 'auto');
      if (l) d.dataset.l = l; if (a) d.dataset.a = a;
      for (const [txt, m] of runs) {
        let n = document.createTextNode(txt);
        if (m & 1) { const e = document.createElement('b'); e.append(n); n = e; }
        if (m & 2) { const e = document.createElement('i'); e.append(n); n = e; }
        if (m & 4) { const e = document.createElement('u'); e.append(n); n = e; }
        if (m & 8) { const e = document.createElement('s'); e.append(n); n = e; }
        d.append(n);
      }
      if (!d.firstChild) d.append(document.createElement('br')); // שורה ריקה צריכה גובה
      return d;
    },
    fmEditorFill(ed, it) {
      ed.textContent = '';
      const lines = String(it.text || '').split('\n'), pf = pfList(it, lines.length);
      let off = 0;
      lines.forEach((ln, i) => {
        const runs = []; let j = 0;
        while (j < ln.length) {
          const m = it.fm ? parseInt(it.fm[off + j], 16) || 0 : 0; let k = j + 1;
          while (k < ln.length && (it.fm ? parseInt(it.fm[off + k], 16) || 0 : 0) === m) k++;
          runs.push([ln.slice(j, k), m]); j = k;
        }
        off += ln.length + 1;
        ed.append(this.lineEl(pf[i].l, pf[i].a, runs));
      });
      this.fixEmptyDirs(ed);
    },
    fmEditorRead(ed) {
      let text = '', fm = '';
      const pf = [];
      const walk = (n, st) => {
        if (n.nodeType === 3) { const v = n.nodeValue.replace(/[ \n\r]/g, ' '); for (let i = 0; i < v.length; i++) { text += v[i]; fm += st.toString(16); } return; }
        if (n.nodeType !== 1 || n.tagName === 'BR') return;
        const tg = n.tagName, sy = n.style;
        if (tg === 'B' || tg === 'STRONG') st |= 1;
        if (tg === 'I' || tg === 'EM') st |= 2;
        if (tg === 'U') st |= 4;
        if (tg === 'S' || tg === 'STRIKE' || tg === 'DEL') st |= 8;
        const fw = sy.fontWeight; if (fw) { if (fw === 'bold' || +fw >= 600) st |= 1; else st &= ~1; }
        if (sy.fontStyle) { if (sy.fontStyle === 'italic') st |= 2; else st &= ~2; }
        const td = sy.textDecorationLine || sy.textDecoration || '';
        if (td) { if (td.includes('none')) st &= ~12; if (td.includes('underline')) st |= 4; if (td.includes('line-through')) st |= 8; }
        n.childNodes.forEach((c) => walk(c, st));
      };
      const lines = [...ed.childNodes];
      if (!lines.length) lines.push(document.createElement('div'));
      lines.forEach((d, i) => {
        if (i > 0) { text += '\n'; fm += '0'; }
        if (d.nodeType === 1 && d.tagName === 'DIV') { pf.push({ l: d.dataset.l || '', a: d.dataset.a || '' }); d.childNodes.forEach((c) => walk(c, 0)); } else { pf.push({ l: '', a: '' }); walk(d, 0); }
      });
      const tmp = {}; pfStore(tmp, pf);
      return { text, fm: /[1-9a-f]/.test(fm) ? fm : '', pf: tmp.pf ? tmp.pf.join(',') : '' };
    },
    // שורה ריקה אין לה כיוון משלה (dir=auto נופל לשמאל) ולכן הנקודה/המספר קפצו שמאלה עד להקלדה: שורה ריקה יורשת את כיוון השורה שמעליה
    fixEmptyDirs(ed) {
      let prev = 'rtl';
      for (const d of ed.children) {
        if (d.tagName !== 'DIV') continue;
        if (/[A-Za-z\u00C0-\u024F\u0590-\u05FF\u0600-\u06FF]/.test(d.textContent)) { d.setAttribute('dir', 'auto'); prev = isRTL(d.textContent) ? 'rtl' : 'ltr'; }
        else if (!d.textContent) d.setAttribute('dir', prev);
        else d.setAttribute('dir', 'auto');
      }
    },
    curLine(ed) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      let n = sel.anchorNode;
      while (n && n.parentNode !== ed) n = n.parentNode;
      return n && n.nodeType === 1 ? n : null;
    },
    // מפצל את השורה הנוכחית במקום הסמן; השורה החדשה יורשת רשימה ויישור (כמו אנטר בוורד)
    splitLine() {
      const ed = this.inl.ed, sel = window.getSelection();
      if (!sel.rangeCount) return;
      if (!sel.isCollapsed) sel.getRangeAt(0).deleteContents();
      const d = this.curLine(ed); if (!d) return;
      const r = sel.getRangeAt(0), tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset); tail.setEnd(d, d.childNodes.length);
      const frag = tail.extractContents();
      const nd = document.createElement('div'); nd.setAttribute('dir', 'auto');
      if (d.dataset.l) nd.dataset.l = d.dataset.l; if (d.dataset.a) nd.dataset.a = d.dataset.a;
      nd.append(frag);
      if (!nd.textContent) nd.replaceChildren(document.createElement('br'));
      if (!d.textContent) d.replaceChildren(document.createElement('br'));
      d.after(nd);
      this.fixEmptyDirs(ed);
      const nr = document.createRange(); nr.setStart(nd, 0); nr.collapse(true); sel.removeAllRanges(); sel.addRange(nr);
    },
    insertPlain(txt) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      txt.split(/\r?\n/).forEach((part, i) => {
        if (i > 0) this.splitLine();
        if (!part) return;
        const r = sel.getRangeAt(0); r.deleteContents();
        const d = this.curLine(this.inl.ed); if (d && d.firstChild && d.firstChild.tagName === 'BR' && !d.textContent) d.replaceChildren();
        const nd = document.createTextNode(part); sel.getRangeAt(0).insertNode(nd);
        const r2 = document.createRange(); r2.setStartAfter(nd); r2.collapse(true); sel.removeAllRanges(); sel.addRange(r2);
      });
    },
    startInline() {
      const it = this.selected;
      if (!it || it.type !== 'text' || !this.canEditItem(it)) return false;
      if (this.inl) { this.inl.ed.focus(); return true; }
      const ed = h('div', { class: 'txt-canvas', contenteditable: 'true', spellcheck: 'false', dir: 'auto', role: 'textbox', 'aria-label': tr('טקסט') });
      this.fmEditorFill(ed, it);
      for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'dblclick', 'click', 'contextmenu']) ed.addEventListener(ev, (e) => e.stopPropagation());
      ed.addEventListener('input', () => {
        if (!ed.firstChild || ![...ed.childNodes].every((c) => c.nodeType === 1 && c.tagName === 'DIV')) { // הדפדפן השאיר צמתים מחוץ לשורות: עוטפים אותם בשורה
          const tx = this.fmEditorRead(ed); const t = {}; t.text = tx.text; t.fm = tx.fm; if (tx.pf) t.pf = tx.pf.split(',');
          this.fmEditorFill(ed, t);
        }
        ed.querySelectorAll(':scope > div').forEach((d) => { if (!d.firstChild) d.append(document.createElement('br')); });
        this.fixEmptyDirs(ed);
        this.positionInline();
      });
      ed.addEventListener('beforeinput', (e) => {
        const t = e.inputType;
        if (t === 'insertParagraph' || t === 'insertLineBreak') {
          e.preventDefault();
          const d = this.curLine(ed);
          if (d && d.dataset.l && !d.textContent) { delete d.dataset.l; this.refreshFmt(); } // אנטר בשורה ריקה ברשימה: יוצא מהרשימה
          else this.splitLine();
          this.positionInline();
        }
        else if (t === 'insertFromPaste' || t === 'insertFromDrop') { e.preventDefault(); const v = e.dataTransfer && e.dataTransfer.getData('text/plain'); if (v) { this.insertPlain(v); this.positionInline(); } }
      });
      ed.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); this.endInline(false); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.endInline(true); }
        else if (e.key === 'Backspace') { // בתחילת שורה ברשימה: מחיקה מסירה קודם את הנקודה/המספר (כמו בוורד)
          const d = this.curLine(ed), sel = window.getSelection();
          if (d && d.dataset.l && sel.isCollapsed) { const r = document.createRange(); r.setStart(d, 0); r.setEnd(sel.anchorNode, sel.anchorOffset); if (!r.toString()) { e.preventDefault(); delete d.dataset.l; this.refreshFmt(); } }
        }
      });
      ed.addEventListener('blur', () => this.endInline(true));
      this._selFn = () => { if (this.inl) this.refreshFmt(); };
      document.addEventListener('selectionchange', this._selFn);
      const ph = !!(this.freshText && this.freshText.id === it.id && it.text === this.freshText.ph);
      this.inl = { id: it.id, ed };
      this.stage.append(ed);
      this.renderItems(); // הפריט המקורי מוסתר בזמן העריכה
      this.positionInline();
      ed.focus();
      const r = document.createRange(), sel = window.getSelection();
      const last = ed.lastElementChild;
      if (ph) r.selectNodeContents(ed); else { r.selectNodeContents(last); r.collapse(false); if (last.lastChild && last.lastChild.tagName === 'BR') { r.setStartBefore(last.lastChild); r.collapse(true); } }
      sel.removeAllRanges(); sel.addRange(r);
      this.refreshFmt();
      return true;
    },
    positionInline() {
      const inl = this.inl;
      if (!inl) return;
      const it = this.selected;
      if (!it || it.id !== inl.id) return;
      const s = this.scale, fs = it.fontSize * s, o0 = this.o2d(it.pts[0].x, it.pts[0].y);
      Object.assign(inl.ed.style, {
        left: (this.tx + o0.x * s) + 'px', top: (this.ty + o0.y * s) + 'px', transformOrigin: '0 0', transform: this.rot ? `rotate(${this.rot}deg)` : 'none', // בתצוגה מסובבת העורך מסתובב יחד עם התוכנית
        minWidth: Math.max(fs * 3, 20) + 'px', fontSize: fs + 'px', lineHeight: '1.25', color: it.color || '#111',
        background: it.bg || 'rgba(255,255,255,.94)',
      });
    },
    endInline(commit) {
      const inl = this.inl;
      if (!inl) return;
      this.inl = null;
      document.removeEventListener('selectionchange', this._selFn);
      const v = this.fmEditorRead(inl.ed);
      inl.ed.remove();
      const it = this.selected;
      if (commit && it && it.id === inl.id && this.canEditItem(it) && (v.text !== it.text || v.fm !== (it.fm || '') || v.pf !== (it.pf ? it.pf.join(',') : ''))) {
        if (this.freshText && this.freshText.id === it.id && v.text && v.text !== this.freshText.ph) this.freshText = null;
        this.modifySelected((i) => { i.text = v.text; setFm(i, v.fm); if (v.pf) i.pf = v.pf.split(','); else delete i.pf; });
      } else { this.renderItems(); this.renderProps(); }
    },

    liveEdit(mut) {
      const it = this.selected;
      if (!it) return;
      if (!this._editBefore) this._editBefore = clone(it);
      mut(it);
      this.renderItems();
    },
    async commitEdit() {
      if (!this._editBefore) return;
      const before = this._editBefore;
      this._editBefore = null;
      await this.commitMod(before, this.selected);
      this.renderProps();
    },

    // ---------- רכיבי עזר ----------
    swatch(color, on, onclick, cls = '') {
      return h('button', { class: 'sw' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), style: color ? { background: color } : null, 'aria-label': tr('צבע'), onclick });
    },
    customColor(key) {
      const cur = this.getStyle(key);
      const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur || '') ? cur : '#e53935', 'aria-label': tr('צבע מותאם אישית') });
      inp.addEventListener('input', () => this.setStyle(key, inp.value, true));
      inp.addEventListener('change', () => { if (this.selected) this.commitEdit(); else this.setStyle(key, inp.value); });
      return h('label', { class: 'sw custom', title: tr('צבע מותאם אישית') }, inp);
    },
    colorRow(key, { none = false, palette = COLORS } = {}) {
      const cur = this.getStyle(key);
      const row = h('div', { class: 'st-row' });
      if (none) row.append(this.swatch(null, cur == null || cur === 'none' || (key === 'bg' && !cur), () => this.setStyle(key, key === 'fill' ? null : key === 'bg' ? '' : 'none'), 'none'));
      palette.forEach((c) => row.append(this.swatch(c, cur === c, () => this.setStyle(key, c))));
      row.append(this.customColor(key));
      return row;
    },
    slider(label, key, { min, max, step, fmt }) {
      const val = this.getStyle(key);
      const isPct = fmt === pct; // שקיפות: צעד של 1% + שדה להקלדת ערך מדויק
      if (isPct) step = 0.01;
      const out = isPct ? h('input', { type: 'number', class: 'num sz', min: Math.round(min * 100), max: Math.round(max * 100), step: 1, value: Math.round(val * 100), 'aria-label': label }) : h('b', { class: 'st-v' }, fmt(val));
      const r = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label });
      r.addEventListener('input', () => { if (isPct) out.value = Math.round(+r.value * 100); else out.textContent = fmt(+r.value); this.setStyle(key, +r.value, true); });
      r.addEventListener('change', () => { if (this.selected) this.commitEdit(); else this.setStyle(key, +r.value); });
      if (isPct) out.addEventListener('change', () => { const x = Math.max(min, Math.min(max, parseFloat(out.value) / 100)); if (!(x >= min)) return; r.value = x; out.value = Math.round(x * 100); this.setStyle(key, x); });
      return h('label', { class: 'st-slider' }, h('span', {}, label), r, out);
    },
    togglePanel() { this.styleOpen = !this.styleOpen; this.renderProps(); },

    // כשחלונית עיצוב פתוחה: מזיזים את התוכנית כך שהפריט הנבחר יישאר גלוי מעל החלונית וראוים השינויים בזמן אמת
    ensureSelVisible() {
      const sel = this.selected, box = this.stylePanel || this.measPanel;
      if (!box) { if (this.bottomPad) { this.bottomPad = 0; this.setView(this.scale, this.tx, this.ty); } return; }
      if (!sel || !this.page || !sel.pts) return;
      requestAnimationFrame(() => {
        if (!this.selected || this.selected.id !== sel.id || !box.isConnected) return;
        const sr = this.stage.getBoundingClientRect(), pr = box.getBoundingClientRect();
        const top = Math.max(60, 0), bottom = pr.top - sr.top - 10, W = this.stage.clientWidth;
        if (bottom < 80) return;
        this.bottomPad = this.H;
        const b0 = boundsOf(this.selected), s = this.scale;
        const c1 = this.o2d(b0.x0, b0.y0), c2 = this.o2d(b0.x1, b0.y1); // הסימון שמור בקואורדינטות המקור; התצוגה יכולה להיות מסובבת
        const x0 = this.tx + Math.min(c1.x, c2.x) * s, x1 = this.tx + Math.max(c1.x, c2.x) * s, y0 = this.ty + Math.min(c1.y, c2.y) * s, y1 = this.ty + Math.max(c1.y, c2.y) * s;
        let dy = 0, dx = 0;
        if (y1 > bottom || y0 < top) dy = y1 - y0 > bottom - top ? top - y0 : (top + bottom) / 2 - (y0 + y1) / 2;
        if (x1 > W - 8 || x0 < 8) dx = x1 - x0 > W - 16 ? 8 - x0 : W / 2 - (x0 + x1) / 2;
        if (dx || dy) this.setView(s, this.tx + dx, this.ty + dy);
      });
    },

    // ---------- עיצוב מדידה: קו וכיתוב בנפרד ----------
    measGet(k) {
      const sel = this.selected && (this.selected.type === 'measure' || this.selected.type === 'area') ? this.selected : null, ref = this.refScale();
      if (sel) return { color: sel.color, width: sel.width * ref, tcolor: sel.tcolor || '#111111', tsize: sel.tsz || Math.round(Math.max(12, Math.min(30, (sel.fontSize || 15 / ref) * this.scale))) }[k];
      return { color: prefs.mcolor || '#d81b60', width: prefs.mw || 2.5, tcolor: prefs.mtcolor || '#111111', tsize: prefs.mtsize || 15 }[k];
    },
    measSet(k, val, live = false) {
      const sel = this.selected && (this.selected.type === 'measure' || this.selected.type === 'area') ? this.selected : null, ref = this.refScale();
      if (sel && !this.canEditItem(sel)) return;
      if (sel) {
        const mut = (it) => {
          if (k === 'color') it.color = val;
          else if (k === 'width') it.width = val / ref;
          else if (k === 'tcolor') it.tcolor = val;
          else if (k === 'tsize') { it.tsz = val; it.fontSize = val / ref; }
        };
        if (live) this.liveEdit(mut); else this.modifySelected(mut);
        if (prefs.keep) { prefs[{ color: 'mcolor', width: 'mw', tcolor: 'mtcolor', tsize: 'mtsize' }[k]] = val; savePrefs(); }
        return;
      }
      prefs[{ color: 'mcolor', width: 'mw', tcolor: 'mtcolor', tsize: 'mtsize' }[k]] = val;
      savePrefs();
      if (!live) this.renderProps();
    },
    measStyleBtn() {
      return h('button', { class: 'btn sm' + (this.measOpen ? ' primary' : ''), onclick: () => { this.measOpen = !this.measOpen; this.renderMeasPanel(); } }, icon('sliders', 16), tr('עיצוב מדידה'));
    },
    renderMeasPanel() {
      const keepTop = this.measPanel ? this.measPanel.scrollTop : 0;
      if (this.measPanel) { this.measPanel.remove(); this.measPanel = null; }
      const isM = this.tool === 'measure' || this.tool === 'area' || (this.selected && (this.selected.type === 'measure' || this.selected.type === 'area'));
      if (!this.measOpen || !isM) return;
      const colorRow = (k) => {
        const cur = this.measGet(k), row = h('div', { class: 'st-row' });
        COLORS.forEach((c) => row.append(this.swatch(c, cur === c, () => { this.measSet(k, c); this.renderMeasPanel(); })));
        const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur || '') ? cur : '#d81b60', 'aria-label': tr('צבע מותאם אישית') });
        inp.addEventListener('input', () => this.measSet(k, inp.value, true));
        inp.addEventListener('change', () => { if (this.selected) this.commitEdit(); else this.measSet(k, inp.value); });
        row.append(h('label', { class: 'sw custom', title: tr('צבע מותאם אישית') }, inp));
        return row;
      };
      const num = (k, min, max, step) => {
        const cur = this.measGet(k);
        const out = h('input', { type: 'number', class: 'num sz', min: 0.05, max: 200, step, value: Math.round(cur * 100) / 100, 'aria-label': k });
        const r = h('input', { type: 'range', min, max, step, value: Math.min(max, cur), 'aria-label': k });
        r.addEventListener('input', () => { out.value = r.value; this.measSet(k, +r.value, true); });
        r.addEventListener('change', () => { if (this.selected) this.commitEdit(); else this.measSet(k, +r.value); });
        out.addEventListener('change', () => { const x = parseFloat(out.value); if (x >= 0.05) { r.value = Math.min(max, x); this.measSet(k, x); } });
        return h('label', { class: 'st-slider' }, h('span', {}, ''), r, out);
      };
      const sec = (title, ...kids) => h('div', { class: 'st-sec' }, h('div', { class: 'st-t' }, title), ...kids);
      const lw = num('width', 0.05, 12, 0.05), ts = num('tsize', 0.3, 60, 0.1);
      lw.firstChild.textContent = tr('עובי קו'); ts.firstChild.textContent = tr('גודל כיתוב');
      this.measPanel = h('div', { class: 'v-style' },
        h('div', { class: 'st-head' }, h('b', {}, this.selected ? tr('עיצוב המדידה הנבחרת') : tr('עיצוב למדידה הבאה')),
          h('button', { class: 'icon-btn sm', 'aria-label': tr('סגור'), onclick: () => { this.measOpen = false; this.renderMeasPanel(); this.renderProps(); } }, icon('x', 18))),
        sec(tr('קו המדידה'), colorRow('color'), lw),
        sec(tr('הכיתוב (המרחק)'), colorRow('tcolor'), ts));
      this.mid.append(this.measPanel);
      this.measPanel.scrollTop = keepTop;
    },

    // ---------- סרגל מאפיינים ----------
    renderProps() {
      const p = this.props;
      const keepL = p.scrollLeft;
      p.textContent = '';
      const t = this.tool, row = [];
      const { sel, kind, type } = this.styleCtx();
      if (sel && !this.canEditItem(sel)) {
        const lvl = CS_ACCESS(this, sel);
        row.push(h('small', { class: 'hint-inline' }, tr('סימון של {0} · {1}', SH_NAME(sel.ownerId), lvl === 'view' ? tr('צפייה בלבד') : tr('ללא הרשאת עריכה'))));
        p.classList.add('has'); p.append(...row);
        if (this.stylePanel) { this.stylePanel.remove(); this.stylePanel = null; }
        return;
      }
      if (kind) {
        const cur = this.getStyle('color');
        COLORS.forEach((c) => row.push(this.swatch(c, cur === c, () => this.setStyle('color', c))));
        row.push(this.customColor('color'));
        if (kind === 'shape') {
          WIDTHS.forEach((w) => {
            const on = sel ? Math.abs(this.getStyle('width') - w) < 0.6 : prefs.w === w;
            row.push(h('button', { class: 'wd' + (on ? ' on' : ''), 'aria-label': tr('עובי קו'), onclick: () => this.setStyle('width', w) }, h('i', { style: { height: w + 'px' } })));
          });
          if (sel ? canFill(sel) : (type === 'rect' || type === 'ellipse')) {
            const f = this.getStyle('fill');
            row.push(h('button', { class: 'sw fillchip' + (f ? '' : ' none'), style: f ? { background: f } : null, title: tr('מילוי'), 'aria-label': tr('צבע מילוי'), onclick: () => { this.styleOpen = true; this.renderProps(); } }));
          }
        }
        if (kind === 'text' && sel) {
          const sizeIn = h('input', { type: 'number', class: 'num sz', min: 2, max: 2000, step: 1, value: Math.round(sel.fontSize), 'aria-label': tr('גודל טקסט') });
          sizeIn.addEventListener('change', () => { const v = parseFloat(sizeIn.value); if (v >= 2) this.setStyle('size', v); });
          row.push(
            h('button', { class: 'icon-btn sm', 'aria-label': tr('הקטן טקסט'), onclick: () => this.setStyle('size', Math.max(2, Math.round(sel.fontSize * 0.9))) }, icon('minus', 16)),
            sizeIn,
            h('button', { class: 'icon-btn sm', 'aria-label': tr('הגדל טקסט'), onclick: () => this.setStyle('size', Math.round(sel.fontSize * 1.1) + 1) }, icon('plus', 16)),
            ...this.fmtRow(), ...this.blockRow());
        }
        if (kind !== 'meas') row.push(h('button', { class: 'btn sm' + (this.styleOpen ? ' primary' : ''), onclick: () => this.togglePanel() }, icon('sliders', 16), tr('עיצוב')));
      }
      if (kind || t === 'measure' || t === 'area' || (sel && (sel.type === 'measure' || sel.type === 'area'))) row.push(this.keepBtn());
      if (t === 'polyline' && !sel) {
        const cb = h('input', { type: 'checkbox', checked: !!prefs.ortho, onchange: () => { prefs.ortho = cb.checked; savePrefs(); } });
        row.push(h('label', { class: 'chip-check' }, cb, tr('זוויות ישרות')));
        row.push(h('small', { class: 'hint-inline' }, this.draft ? tr('הקישו נקודות לפניות. סיום: הקישו שוב על הנקודה האחרונה (או הראשונה לסגירה)') : tr('הקישו נקודות לאורך התוואי')));
      }
      if (t === 'pen' && !sel) row.push(h('small', { class: 'hint-inline' }, tr('החזקה בסוף הקו מיישרת לקו ישר או לצורה')));
      if (t === 'text' && !sel) row.push(h('small', { class: 'hint-inline' }, tr('הקישו על התוכנית להוספת טקסט')));
      if (t === 'eraser') row.push(h('small', { class: 'hint-inline' }, tr('גררו על סימונים כדי למחוק אותם (אפשר לבטל)')));
      if (t === 'measure' || t === 'area' || (sel && (sel.type === 'measure' || sel.type === 'area'))) row.push(this.measStyleBtn());
      if (t === 'measure' || t === 'area' || t === 'calibrate' || (sel && (sel.type === 'measure' || sel.type === 'area'))) {
        const cal = this.calibs.get(this.pageNum);
        const u = h('select', { 'aria-label': tr('יחידות'), onchange: () => { prefs.unit = u.value; savePrefs(); this.renderItems(); } },
          h('option', { value: 'm' }, tr('מטר')), h('option', { value: 'cm' }, tr('ס״מ')), h('option', { value: 'mm' }, tr('מ״מ')));
        u.value = prefs.unit;
        row.push(u, h('button', { class: 'btn sm', onclick: () => this.calibrateDialog() }, cal ? (cal.source === 'ratio' ? tr('סקאלה 1:{0}', cal.ratio) : tr('כויל ידנית')) : tr('נדרש כיול')));
        const tIn = h('input', { type: 'text', class: 'meas-title', placeholder: tr('כותרת (צינור, תעלה…)'), 'aria-label': tr('כותרת מדידה'), value: sel && (sel.type === 'measure' || sel.type === 'area') ? sel.title || '' : this.measTitle || '', list: 'meas-titles' });
        const known = [...new Set((this.items.measurements || []).map((x) => x.title).filter(Boolean))];
        const dl = h('datalist', { id: 'meas-titles' }, known.map((x) => h('option', { value: x })));
        tIn.addEventListener('change', () => { const v = tIn.value.trim(); if (sel && (sel.type === 'measure' || sel.type === 'area')) this.modifySelected((it) => { if (v) it.title = v; else delete it.title; }); else this.measTitle = v; });
        row.push(tIn, dl);
        if (t === 'measure') row.push(h('small', { class: 'hint-inline' }, this.draft?.wait ? tr('לחצו על הנקודה השנייה') : tr('לחצו נקודה ראשונה, או גררו')));
        if (t === 'calibrate') row.push(h('small', { class: 'hint-inline' }, tr('כיול: סמנו שתי נקודות')));
        if (t === 'area') row.push(h('small', { class: 'hint-inline' }, tr('הקישו נקודות; סיום: לחצו על הנקודה הראשונה')));
      }
      if (this.draft && (t === 'area' || t === 'polyline' || this.draft.wait)) {
        // כפתורי הפעולה בראש השורה (מימין ב-RTL) כדי שלא ייגללו מחוץ למסך
        const acts = [];
        if (t === 'area' || t === 'polyline') {
          acts.push(h('button', { class: 'btn sm primary', onclick: () => this.finishArea() }, tr('סיום')));
          acts.push(h('button', { class: 'btn sm', onclick: () => this.undoPoint() }, tr('בטל נקודה')));
        }
        acts.push(h('button', { class: 'btn sm', onclick: () => this.cancelDraft() }, tr('בטל')));
        row.unshift(...acts);
      }
      if (t === 'calibrate') row.push(h('button', { class: 'btn sm', onclick: () => { this.tool = 'pan'; this.draft = null; this.renderDraft(); this.updateToolUI(); this.renderProps(); } }, tr('ביטול כיול')));
      if (sel) {
        if (sel.type === 'text') {
          const ta = h('textarea', { class: 'txt-inline', rows: 1, placeholder: tr('הקלד טקסט…'), 'aria-label': tr('טקסט') }, sel.text || '');
          ta.value = sel.text || '';
          ta.addEventListener('input', () => { this.liveEdit((it) => { remask(it, ta.value); }); ta.style.height = 'auto'; ta.style.height = Math.min(110, ta.scrollHeight) + 'px'; });
          ta.addEventListener('change', () => { if (this.freshText && this.freshText.id === sel.id && ta.value && ta.value !== this.freshText.ph) this.freshText = null; this.commitEdit(); });
          row.unshift(ta);
        }
        if (sel.type === 'polyline') row.push(h('button', { class: 'btn sm' + (sel.showLen ? ' primary' : ''), onclick: () => { if (!sel.showLen && !this.calibs.get(this.pageNum)) { UI.toast(tr('כדי להציג אורך צריך להגדיר סקאלה או כיול לעמוד')); this.calibrateDialog(); return; } this.modifySelected((it) => { it.showLen = !it.showLen; }); } }, icon('ruler', 16), tr('הצג אורך')));
        if (sel.type === 'link') {
          row.push(h('button', { class: 'btn sm', onclick: () => this.followLink(sel) }, tr('פתח')));
          row.push(h('button', { class: 'btn sm', onclick: async () => { const r = await this.linkDialog(sel); if (!r) return; await this.modifySelected((it) => { it.target = r.target; }); if (r.pick) this.beginPick(this.selected); } }, icon('edit', 16), tr('יעד')));
          row.push(h('button', { class: 'btn sm', onclick: async () => { const v = await UI.promptBox({ title: tr('שם הקישור (אופציונלי)'), value: sel.text || '', okText: tr('שמור') }); if (v != null) this.modifySelected((it) => { it.text = v; }); } }, tr('שם')));
        }
        if (this.canShareHere() && (sel.layer === 'markups' || sel.layer === 'measurements')) row.push(h('button', { class: 'btn sm', onclick: () => SH_DIALOG(this, { preset: 'sel' }) }, icon('users', 16), tr('שיתוף')));
        row.push(h('button', { class: 'btn sm', title: tr('בחר את הסימן שמתחת לסימן הנבחר (באותו מקום)'), onclick: () => this.cycleBeneath() }, icon('layers', 16), tr('סימן מתחת')));
        row.push(h('button', { class: 'btn sm danger', onclick: () => this.deleteSelected() }, icon('trash', 16), tr('מחק')));
      }
      p.classList.toggle('has', row.length > 0);
      p.append(...row);
      p.scrollLeft = keepL;
      this.renderStylePanel();
      this.renderMeasPanel();
      this.ensureSelVisible();
      this.positionInline();
    },

    // ---------- פאנל עיצוב מלא ----------
    renderStylePanel() {
      const keepTop = this.stylePanel ? this.stylePanel.scrollTop : 0; // שומרים את מיקום הגלילה בחלונית כדי שלא תקפוץ לראש בכל שינוי
      if (this.stylePanel) { this.stylePanel.remove(); this.stylePanel = null; }
      this._stKeep = keepTop;
      const { sel, kind, type } = this.styleCtx();
      if (!this.styleOpen || !['shape', 'text', 'hl'].includes(kind)) return;
      const fillable = sel ? canFill(sel) : (type === 'rect' || type === 'ellipse');
      const sec = (title, ...kids) => h('div', { class: 'st-sec' }, h('div', { class: 'st-t' }, title), ...kids);
      const body = [];
      if (kind === 'shape') {
        if (fillable) {
          body.push(sec(tr('מילוי'), this.colorRow('fill', { none: true, palette: FILL_COLORS }), this.slider(tr('שקיפות מילוי'), 'fillOp', { min: 0.05, max: 1, step: 0.05, fmt: pct })));
        }
        body.push(sec(fillable ? tr('קו מסביב') : tr('צבע'), this.colorRow('color', { none: fillable }),
          this.slider(tr('שקיפות קו'), 'op', { min: 0.05, max: 1, step: 0.05, fmt: pct }),
          this.slider(tr('עובי'), 'width', { min: 1, max: 30, step: 0.5, fmt: (v) => v + ' px' })));
      } else if (kind === 'hl') {
        body.push(sec(tr('הדגשה'), this.colorRow('color'), this.slider(tr('שקיפות'), 'fillOp', { min: 0.05, max: 1, step: 0.05, fmt: pct })));
      } else if (kind === 'text') {
        body.push(sec(tr('סגנון'), h('div', { class: 'st-row' }, ...this.fmtRow())));
        if (sel) body.push(sec(tr('פסקה'), h('div', { class: 'st-row' }, ...this.blockRow())));
        body.push(sec(tr('טקסט'), this.colorRow('color'), this.slider(tr('שקיפות טקסט'), 'op', { min: 0.05, max: 1, step: 0.05, fmt: pct })));
        body.push(sec(tr('רקע לטקסט'), this.colorRow('bg', { none: true, palette: ['#fff59d', '#ffffff', '#ffcc80', '#a5d6a7', '#90caf9', '#f48fb1', '#111111'] }), this.slider(tr('שקיפות רקע'), 'bgOp', { min: 0.1, max: 1, step: 0.05, fmt: pct })));
        if (sel) {
          const num = h('input', { type: 'number', class: 'num sz', min: 2, max: 2000, step: 1, value: Math.round(sel.fontSize), 'aria-label': tr('גודל טקסט') });
          const range = h('input', { type: 'range', min: 4, max: 400, step: 1, value: Math.min(400, Math.round(sel.fontSize)), 'aria-label': tr('גודל טקסט') });
          range.addEventListener('input', () => { num.value = range.value; this.setStyle('size', +range.value, true); });
          range.addEventListener('change', () => this.commitEdit());
          num.addEventListener('change', () => { const v = parseFloat(num.value); if (v >= 2) this.setStyle('size', v); });
          body.push(sec(tr('גודל טקסט (ביחידות העמוד – כך יודפס)'), h('div', { class: 'st-row' }, range, num),
            h('p', { class: 'hint' }, tr('אפשר גם: צביטה עם שתי אצבעות על הטקסט, או גרירת העיגול בפינה.'))));
        } else body.push(h('p', { class: 'hint' }, tr('את גודל הטקסט משנים אחרי ההוספה.')));
      }
      const box = h('div', { class: 'v-style' },
        h('div', { class: 'st-head' }, h('b', {}, sel ? tr('עיצוב הפריט הנבחר') : tr('עיצוב לציור הבא')),
          h('button', { class: 'icon-btn sm', 'aria-label': tr('סגור'), onclick: () => { this.styleOpen = false; this.renderProps(); } }, icon('x', 18))),
        ...body);
      this.mid.append(box);
      box.scrollTop = this._stKeep || 0;
      this.stylePanel = box;
    },
  });
}
