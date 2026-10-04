// סרגל המאפיינים ופאנל העיצוב של ה-Viewer: צבע קו, מילוי, שקיפות, עובי, וגודל טקסט.
// אם נבחר פריט – העריכה חלה עליו (עם Undo). אחרת – היא קובעת את ברירת המחדל לציור הבא.
import { h, icon, clone } from './util.js';
import * as UI from './ui.js';
import { prefs, savePrefs, COLORS, WIDTHS } from './prefs.js';
import { kindOf, canFill, hasFill, isNoStroke } from './markup.js';

const TOOL_KIND = { pen: 'shape', line: 'shape', polyline: 'shape', arrow: 'shape', rect: 'shape', ellipse: 'shape', text: 'text', highlight: 'hl' };
const PREF_KEYS = {
  shape: { color: 'color', fill: 'fill', fillOp: 'fillOp', op: 'op', width: 'w' },
  text: { color: 'tcolor', op: 'top' },
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
          default: return undefined;
        }
      }
      const m = PREF_KEYS[kind];
      return m && m[key] ? prefs[m[key]] : undefined;
    },

    // live=true: תצוגה מקדימה בזמן גרירת מחוון (בלי שמירה); השמירה נעשית ב-commitEdit
    setStyle(key, val, live = false) {
      const { sel, kind } = this.styleCtx();
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
            default: break;
          }
        };
        if (live) this.liveEdit(mut); else this.modifySelected(mut);
        return;
      }
      const m = PREF_KEYS[kind];
      if (!m || !m[key]) return;
      prefs[m[key]] = val;
      savePrefs();
      if (!live) this.renderProps();
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
      return h('button', { class: 'sw' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), style: color ? { background: color } : null, 'aria-label': 'צבע', onclick });
    },
    customColor(key) {
      const cur = this.getStyle(key);
      const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur || '') ? cur : '#e53935', 'aria-label': 'צבע מותאם אישית' });
      inp.addEventListener('input', () => this.setStyle(key, inp.value, true));
      inp.addEventListener('change', () => { if (this.selected) this.commitEdit(); else this.setStyle(key, inp.value); });
      return h('label', { class: 'sw custom', title: 'צבע מותאם אישית' }, inp);
    },
    colorRow(key, { none = false, palette = COLORS } = {}) {
      const cur = this.getStyle(key);
      const row = h('div', { class: 'st-row' });
      if (none) row.append(this.swatch(null, cur == null || cur === 'none', () => this.setStyle(key, key === 'fill' ? null : 'none'), 'none'));
      palette.forEach((c) => row.append(this.swatch(c, cur === c, () => this.setStyle(key, c))));
      row.append(this.customColor(key));
      return row;
    },
    slider(label, key, { min, max, step, fmt }) {
      const val = this.getStyle(key);
      const out = h('b', { class: 'st-v' }, fmt(val));
      const r = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label });
      r.addEventListener('input', () => { out.textContent = fmt(+r.value); this.setStyle(key, +r.value, true); });
      r.addEventListener('change', () => { if (this.selected) this.commitEdit(); else this.setStyle(key, +r.value); });
      return h('label', { class: 'st-slider' }, h('span', {}, label), r, out);
    },
    togglePanel() { this.styleOpen = !this.styleOpen; this.renderProps(); },

    // ---------- סרגל מאפיינים ----------
    renderProps() {
      const p = this.props;
      p.textContent = '';
      const t = this.tool, row = [];
      const { sel, kind, type } = this.styleCtx();
      if (kind) {
        const cur = this.getStyle('color');
        COLORS.forEach((c) => row.push(this.swatch(c, cur === c, () => this.setStyle('color', c))));
        row.push(this.customColor('color'));
        if (kind === 'shape') {
          WIDTHS.forEach((w) => {
            const on = sel ? Math.abs(this.getStyle('width') - w) < 0.6 : prefs.w === w;
            row.push(h('button', { class: 'wd' + (on ? ' on' : ''), 'aria-label': 'עובי קו', onclick: () => this.setStyle('width', w) }, h('i', { style: { height: w + 'px' } })));
          });
          if (sel ? canFill(sel) : (type === 'rect' || type === 'ellipse')) {
            const f = this.getStyle('fill');
            row.push(h('button', { class: 'sw fillchip' + (f ? '' : ' none'), style: f ? { background: f } : null, title: 'מילוי', 'aria-label': 'צבע מילוי', onclick: () => { this.styleOpen = true; this.renderProps(); } }));
          }
        }
        if (kind === 'text' && sel) {
          const sizeIn = h('input', { type: 'number', class: 'num sz', min: 2, max: 2000, step: 1, value: Math.round(sel.fontSize), 'aria-label': 'גודל טקסט' });
          sizeIn.addEventListener('change', () => { const v = parseFloat(sizeIn.value); if (v >= 2) this.setStyle('size', v); });
          row.push(
            h('button', { class: 'icon-btn sm', 'aria-label': 'הקטן טקסט', onclick: () => this.setStyle('size', Math.max(2, Math.round(sel.fontSize * 0.9))) }, icon('minus', 16)),
            sizeIn,
            h('button', { class: 'icon-btn sm', 'aria-label': 'הגדל טקסט', onclick: () => this.setStyle('size', Math.round(sel.fontSize * 1.1) + 1) }, icon('plus', 16)));
        }
        if (kind !== 'meas') row.push(h('button', { class: 'btn sm' + (this.styleOpen ? ' primary' : ''), onclick: () => this.togglePanel() }, icon('sliders', 16), 'עיצוב'));
      }
      if (t === 'polyline' && !sel) {
        const cb = h('input', { type: 'checkbox', checked: !!prefs.ortho, onchange: () => { prefs.ortho = cb.checked; savePrefs(); } });
        row.push(h('label', { class: 'chip-check' }, cb, 'זוויות ישרות'));
        row.push(h('small', { class: 'hint-inline' }, this.draft ? 'הקישו נקודות לפניות. סיום: הקישו שוב על הנקודה האחרונה (או הראשונה לסגירה)' : 'הקישו נקודות לאורך התוואי'));
      }
      if (t === 'pen' && !sel) row.push(h('small', { class: 'hint-inline' }, 'החזקה בסוף הקו מיישרת לקו ישר או לצורה'));
      if (t === 'text' && !sel) row.push(h('small', { class: 'hint-inline' }, 'הקישו על התוכנית להוספת טקסט'));
      if (t === 'eraser') row.push(h('small', { class: 'hint-inline' }, 'גררו על סימונים כדי למחוק אותם (אפשר לבטל)'));
      if (t === 'measure' || t === 'area' || t === 'calibrate' || (sel && (sel.type === 'measure' || sel.type === 'area'))) {
        const cal = this.calibs.get(this.pageNum);
        const u = h('select', { 'aria-label': 'יחידות', onchange: () => { prefs.unit = u.value; savePrefs(); this.renderItems(); } },
          h('option', { value: 'm' }, 'מטר'), h('option', { value: 'cm' }, 'ס״מ'), h('option', { value: 'mm' }, 'מ״מ'));
        u.value = prefs.unit;
        row.push(u, h('button', { class: 'btn sm', onclick: () => this.calibrateDialog() }, cal ? (cal.source === 'ratio' ? `סקאלה 1:${cal.ratio}` : 'כויל ידנית') : 'נדרש כיול'));
        if (t === 'measure') row.push(h('small', { class: 'hint-inline' }, this.draft?.wait ? 'לחצו על הנקודה השנייה' : 'לחצו נקודה ראשונה, או גררו'));
        if (t === 'calibrate') row.push(h('small', { class: 'hint-inline' }, 'כיול: סמנו שתי נקודות'));
        if (t === 'area') row.push(h('small', { class: 'hint-inline' }, 'הקישו נקודות; סיום: לחצו על הנקודה הראשונה'));
      }
      if (this.draft && (t === 'area' || t === 'polyline' || this.draft.wait)) {
        // כפתורי הפעולה בראש השורה (מימין ב-RTL) כדי שלא ייגללו מחוץ למסך
        const acts = [];
        if (t === 'area' || t === 'polyline') {
          acts.push(h('button', { class: 'btn sm primary', onclick: () => this.finishArea() }, 'סיום'));
          acts.push(h('button', { class: 'btn sm', onclick: () => this.undoPoint() }, 'בטל נקודה'));
        }
        acts.push(h('button', { class: 'btn sm', onclick: () => this.cancelDraft() }, 'בטל'));
        row.unshift(...acts);
      }
      if (t === 'calibrate') row.push(h('button', { class: 'btn sm', onclick: () => { this.tool = 'pan'; this.draft = null; this.renderDraft(); this.updateToolUI(); this.renderProps(); } }, 'ביטול כיול'));
      if (sel) {
        if (sel.type === 'text') row.push(h('button', { class: 'btn sm', onclick: async () => { const v = await UI.promptBox({ title: 'עריכת טקסט', multiline: true, value: sel.text, okText: 'שמור' }); if (v) this.modifySelected((it) => { it.text = v; }); } }, icon('edit', 16), 'ערוך'));
        if (sel.type === 'polyline') row.push(h('button', { class: 'btn sm' + (sel.showLen ? ' primary' : ''), onclick: () => { if (!sel.showLen && !this.calibs.get(this.pageNum)) { UI.toast('כדי להציג אורך צריך להגדיר סקאלה או כיול לעמוד'); this.calibrateDialog(); return; } this.modifySelected((it) => { it.showLen = !it.showLen; }); } }, icon('ruler', 16), 'הצג אורך'));
        if (sel.type === 'link') {
          row.push(h('button', { class: 'btn sm', onclick: () => this.followLink(sel) }, 'פתח'));
          row.push(h('button', { class: 'btn sm', onclick: async () => { const r = await this.linkDialog(sel); if (!r) return; await this.modifySelected((it) => { it.target = r.target; }); if (r.pick) this.beginPick(this.selected); } }, icon('edit', 16), 'יעד'));
          row.push(h('button', { class: 'btn sm', onclick: async () => { const v = await UI.promptBox({ title: 'שם הקישור (אופציונלי)', value: sel.text || '', okText: 'שמור' }); if (v != null) this.modifySelected((it) => { it.text = v; }); } }, 'שם'));
        }
        row.push(h('button', { class: 'btn sm danger', onclick: () => this.deleteSelected() }, icon('trash', 16), 'מחק'));
      }
      p.classList.toggle('has', row.length > 0);
      p.append(...row);
      this.renderStylePanel();
    },

    // ---------- פאנל עיצוב מלא ----------
    renderStylePanel() {
      if (this.stylePanel) { this.stylePanel.remove(); this.stylePanel = null; }
      const { sel, kind, type } = this.styleCtx();
      if (!this.styleOpen || !['shape', 'text', 'hl'].includes(kind)) return;
      const fillable = sel ? canFill(sel) : (type === 'rect' || type === 'ellipse');
      const sec = (title, ...kids) => h('div', { class: 'st-sec' }, h('div', { class: 'st-t' }, title), ...kids);
      const body = [];
      if (kind === 'shape') {
        if (fillable) {
          body.push(sec('מילוי', this.colorRow('fill', { none: true, palette: FILL_COLORS }), this.slider('שקיפות מילוי', 'fillOp', { min: 0.05, max: 1, step: 0.05, fmt: pct })));
        }
        body.push(sec(fillable ? 'קו מסביב' : 'צבע', this.colorRow('color', { none: fillable }),
          this.slider('שקיפות קו', 'op', { min: 0.05, max: 1, step: 0.05, fmt: pct }),
          this.slider('עובי', 'width', { min: 1, max: 30, step: 0.5, fmt: (v) => v + ' px' })));
      } else if (kind === 'hl') {
        body.push(sec('הדגשה', this.colorRow('color'), this.slider('שקיפות', 'fillOp', { min: 0.05, max: 1, step: 0.05, fmt: pct })));
      } else if (kind === 'text') {
        body.push(sec('טקסט', this.colorRow('color'), this.slider('שקיפות טקסט', 'op', { min: 0.05, max: 1, step: 0.05, fmt: pct })));
        if (sel) {
          const num = h('input', { type: 'number', class: 'num sz', min: 2, max: 2000, step: 1, value: Math.round(sel.fontSize), 'aria-label': 'גודל טקסט' });
          const range = h('input', { type: 'range', min: 4, max: 400, step: 1, value: Math.min(400, Math.round(sel.fontSize)), 'aria-label': 'גודל טקסט' });
          range.addEventListener('input', () => { num.value = range.value; this.setStyle('size', +range.value, true); });
          range.addEventListener('change', () => this.commitEdit());
          num.addEventListener('change', () => { const v = parseFloat(num.value); if (v >= 2) this.setStyle('size', v); });
          body.push(sec('גודל טקסט (ביחידות העמוד – כך יודפס)', h('div', { class: 'st-row' }, range, num),
            h('p', { class: 'hint' }, 'אפשר גם: צביטה עם שתי אצבעות על הטקסט, או גרירת העיגול בפינה.')));
        } else body.push(h('p', { class: 'hint' }, 'את גודל הטקסט משנים אחרי ההוספה.'));
      }
      const box = h('div', { class: 'v-style' },
        h('div', { class: 'st-head' }, h('b', {}, sel ? 'עיצוב הפריט הנבחר' : 'עיצוב לציור הבא'),
          h('button', { class: 'icon-btn sm', 'aria-label': 'סגור', onclick: () => { this.styleOpen = false; this.renderProps(); } }, icon('x', 18))),
        ...body);
      this.mid.append(box);
      this.stylePanel = box;
    },
  });
}
