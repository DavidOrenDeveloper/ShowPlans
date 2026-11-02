// השוואת תוכניות: מצבי תצוגה (הדגשת שינויים / צד-לצד / הבדלים / שקיפות), יישור אוטומטי וידני (הזזה, גודל, סיבוב),
// ועריכה ידנית של סימוני ההשוואה (ביטול סימון שאינו שינוי, הוספת סימון שהמערכת פספסה).
import { t as tr } from './i18n.js';
import * as S from './store.js';
import * as UI from './ui.js';
import { dn } from './names.js';
import { openPdf, destroyDoc } from './pdfio.js';
import { h, icon, clamp, fmtDate, natural } from './util.js';
import { svg, drawItem } from './markup.js';
import { prefs, savePrefs } from './prefs.js';
import { renderChangesCanvas } from './diffview.js';
import { autoAlign } from './autoalign.js';

const CHANGE_MODES = new Set(['changes', 'sidechanges']);
const NOTE_TOOLS = new Set(['pen', 'line', 'polyline', 'arrow', 'rect', 'ellipse', 'highlight']);
const MM = 72 / 25.4; // נקודות עמוד למ״מ
const cmpDefaults = () => ({ emph: 0.6, shift: prefs.cmpShift ?? 0.4, thick: prefs.cmpThick ?? 0.3, gap: prefs.cmpGap ?? 0, colA: prefs.cmpA || '#e53935', colB: prefs.cmpB || '#1e63ff', colS: prefs.cmpS || '#000000' });

export function installCompare(V) {
  Object.assign(V.prototype, {
    // ---------- חלון ההשוואה ----------
    async openCompare(preVid) {
      if (this.cont) this.setCont(false, { quiet: true });
      if (this.cmpUI) { if (preVid) { this.cmpUI.setVersion(preVid); this.cmpUI.apply(); } return; }
      if (!this.doc) return;
      const planSel = h('select', {}), verSel = h('select', {});
      const plans = [...S.P.plans.values()].sort((a, b) => natural(S.planPathText(a) + a.name, S.planPathText(b) + b.name));
      plans.forEach((p) => planSel.append(h('option', { value: p.id }, p.id === this.planId ? tr('{0} (התוכנית הזו)', dn(p.name)) : `${dn(p.name)} — ${S.planPathText(p)}`)));
      const fillVers = (sel) => {
        verSel.textContent = '';
        S.versionsOf(planSel.value).forEach((v) => verSel.append(h('option', { value: v.id }, `V${v.number} – ${fmtDate(v.date)}${v.id === this.version.id ? tr(' (הפתוחה)') : ''}${S.P.plans.get(v.planId)?.currentVersionId === v.id ? tr(' · נוכחית') : ''}`)));
        if (sel) verSel.value = sel;
      };
      const setVersion = (vid) => { const v = S.P.versions.get(vid); if (!v) return; planSel.value = v.planId; fillVers(vid); };
      planSel.value = this.planId; fillVers();
      const other = S.versionsOf(this.planId).find((v) => v.id !== this.version.id);
      if (other) verSel.value = other.id;
      planSel.onchange = () => fillVers();
      const pageIn = h('input', { type: 'number', min: 1, value: this.pageNum, inputMode: 'numeric', class: 'num' });
      this.cmpSet = this.cmpSet || cmpDefaults();
      const modeSel = h('select', {},
        h('option', { value: 'changes' }, tr('הדגשת שינויים')),
        h('option', { value: 'sidechanges' }, tr('זו לצד זו + הדגשת שינויים')),
        h('option', { value: 'diff' }, tr('הבדלים (צבעים)')),
        h('option', { value: 'overlay' }, tr('שקיפות')),
        h('option', { value: 'split' }, tr('זו לצד זו (רגיל)')));
      const op = h('input', { type: 'range', min: 0, max: 100, value: Math.round(this.cmpSet.emph * 100) });
      const opLabel = h('span', {}, tr('עוצמת ההדגשה'));
      const slider = (key, label, max, step, unit, hint) => {
        const val = h('b', { class: 'cmp-val' }), inp = h('input', { type: 'range', min: 0, max, step, value: this.cmpSet[key], 'aria-label': label, title: hint });
        const show = () => { val.textContent = (+inp.value).toFixed(step < 1 ? 1 : 0) + unit; };
        inp.oninput = () => { this.cmpSet[key] = +inp.value; prefs['cmp' + key[0].toUpperCase() + key.slice(1)] = +inp.value; show(); if (this.cmp && CHANGE_MODES.has(this.cmp.mode)) later(); };
        inp.onchange = () => savePrefs();
        show();
        return h('label', { class: 'cmp-tol', title: hint }, h('span', {}, label), inp, val);
      };
      const tolBox = h('span', { class: 'cmp-tolbox' },
        slider('shift', tr('הזזה מותרת'), 5, 0.1, tr(' מ״מ'), tr('קווים שזזו עד המרחק הזה לא יסומנו כשינוי')),
        slider('thick', tr('הבדל עובי קו'), 3, 0.1, tr(' מ״מ'), tr('קו שרק עבה/דק יותר באחת התוכניות לא יסומן כשינוי')),
        slider('gap', tr('מקווקו = רציף'), 12, 0.5, tr(' מ״מ'), tr('פערים עד הגודל הזה בקו מקווקו ייחשבו כקו רציף (0 = כבוי)')));
      const busy = h('small', { class: 'cmp-busy' });
      const colorIn = (key, label) => {
        const pk = { colA: 'cmpA', colB: 'cmpB', colS: 'cmpS' }[key];
        const inp = h('input', { type: 'color', value: this.cmpSet[key], 'aria-label': label });
        inp.oninput = () => { this.cmpSet[key] = inp.value; prefs[pk] = inp.value; savePrefs(); if (this.cmp && CHANGE_MODES.has(this.cmp.mode)) later(); };
        inp.onchange = () => { if (this.cmp && this.cmp.mode === 'diff') this.setCompareMode('diff', this.cmp.opacity); };
        return h('label', { class: 'cmp-col' }, h('span', {}, label), inp);
      };
      const colBox = h('span', { class: 'cmp-colors' }, colorIn('colA', tr('צבע: רק בפתוחה')), colorIn('colB', tr('צבע: רק בהשוואה')), colorIn('colS', tr('צבע: זהה בשתיהן')));
      this.chBusy = busy;

      // שורת עריכת סימוני השוואה
      const editRow = h('div', { class: 'cmp-row' });
      const eIgnore = h('button', { class: 'btn sm', onclick: () => this.setCmpEdit('ignore') }, tr('מחק סימון (זה לא שינוי)'));
      const eAdd = h('button', { class: 'btn sm', onclick: () => this.setCmpEdit('add') }, tr('הוסף סימון (פספוס)'));
      const eClear = h('button', { class: 'btn sm', onclick: () => this.cmpClearEdits() }, tr('נקה את כל העריכות'));
      const eInfo = h('small', { class: 'hint-inline' });
      editRow.append(h('b', {}, tr('תיקון סימוני ההשוואה:')), eIgnore, eAdd, eClear, eInfo);
      this.syncCmpEditUI = () => {
        eIgnore.classList.toggle('primary', this.cmpEditMode === 'ignore');
        eAdd.classList.toggle('primary', this.cmpEditMode === 'add');
        eInfo.textContent = this.cmpEditMode ? (this.cmpEditMode === 'ignore' ? tr('גררו מלבן על ההדגשה שאינה שינוי (או הקישו עליה). שוב על הכפתור – יציאה') : tr('גררו מלבן סביב ההבדל שלא סומן. שוב על הכפתור – יציאה')) : (this.cmp?.edits?.length ? tr('{0} עריכות', this.cmp.edits.length) : '');
      };

      // סימונים משלי על ההשוואה (חץ, מלבן, עיגול, מרקר, עט) – נשמרים רק בהשוואה, לא בתוכנית, ונכנסים להדפסה/שמירה
      const noteRow = h('div', { class: 'cmp-row' });
      const noteCb = h('input', { type: 'checkbox', checked: this.cmpNoteMode !== false });
      noteCb.onchange = () => { this.cmpNoteMode = noteCb.checked; this.updateUndo(); };
      this.cmpNoteMode = noteCb.checked;
      const nUndo = h('button', { class: 'btn sm', onclick: () => this.undo() }, icon('undo', 16), tr('בטל'));
      const nRedo = h('button', { class: 'btn sm', onclick: () => this.redo() }, icon('redo', 16), tr('חזור'));
      const nClear = h('button', { class: 'btn sm', onclick: () => this.cmpClearNotes() }, tr('מחק את הסימונים שלי'));
      noteRow.append(h('b', {}, tr('סימונים על ההשוואה:')), h('label', { class: 'check' }, noteCb, tr('צייר על ההשוואה בלבד (לא על התוכנית)')), nUndo, nRedo, nClear,
        h('small', { class: 'hint-inline' }, tr('בחרו כלי (חץ / מלבן / עיגול / הדגשה / עט) בסרגל הכלים. Ctrl+Z / Ctrl+Y = בטל / חזור')));
      this.cmpUndoUI = () => { const c = this.cmp; nUndo.disabled = !c || !c.hist.length; nRedo.disabled = !c || !c.redo.length; };
      const syncControls = () => {
        const m = modeSel.value, ch = CHANGE_MODES.has(m);
        opLabel.textContent = ch ? tr('עוצמת ההדגשה') : m === 'diff' ? tr('עוצמת התוכנית להשוואה') : tr('שקיפות');
        tolBox.style.display = ch ? '' : 'none';
        colBox.style.display = ch || m === 'diff' ? '' : 'none';
        editRow.style.display = ch ? '' : 'none';
      colBox.title = tr('צבעים: מה שקיים רק בפתוחה / רק בהשוואה / זהה בשתיהן');
        op.disabled = m === 'split';
      };
      let chT = 0;
      const later = () => { clearTimeout(chT); chT = setTimeout(() => this.renderChanges(), 160); };
      const legend = h('div', { class: 'cmp-legend' });
      const apply = async () => {
        const vid = verSel.value;
        if (!vid) return;
        legend.textContent = tr('טוען…');
        try { await this.startCompare(vid, parseInt(pageIn.value, 10) || 1, modeSel.value, op.value / 100); } catch (e) { console.error(e); UI.toast(tr('לא ניתן לטעון את התוכנית להשוואה'), { type: 'error' }); legend.textContent = ''; return; }
        this.updateCmpLegend(legend);
        refresh();
      };
      const changeMode = (m, val) => {
        modeSel.value = m; op.value = val != null ? val : m === 'changes' || m === 'sidechanges' ? Math.round(this.cmpSet.emph * 100) : m === 'overlay' ? 50 : 100;
        syncControls();
        if (this.cmp) { this.setCompareMode(m, op.value / 100); this.updateCmpLegend(legend); }
      };
      modeSel.onchange = () => {
        if (this.alignDrag) setAlign(false, true);
        if (this.cmpEditMode && !CHANGE_MODES.has(modeSel.value)) this.setCmpEdit(null);
        changeMode(modeSel.value);
      };
      op.oninput = () => {
        if (!this.cmp) return;
        const val = op.value / 100;
        this.cmp.opacity = val;
        if (CHANGE_MODES.has(this.cmp.mode)) { this.cmpSet.emph = val; later(); }
        else if (this.cmp.mode === 'overlay' || this.cmp.mode === 'diff') this.layerB.el.style.opacity = val;
      };

      // ---------- יישור ----------
      const sizeIn = h('input', { type: 'number', class: 'num', min: 5, max: 2000, step: 0.1, inputMode: 'decimal', 'aria-label': tr('גודל התוכנית להשוואה באחוזים') });
      const refresh = () => {
        syncCmpEditState();
        if (this.cmp && this.layerB.page) sizeIn.value = (100 * this.movingSize() / this.movingBase()).toFixed(1);
        this.cmpUndoUI?.();
      };
      const syncCmpEditState = () => this.syncCmpEditUI?.();
      const nudge = (dx, dy) => { if (!this.cmp || !this.layerB.page) return; this.relMove(dx * 1.5, dy * 1.5); this.scheduleDetail(200); };
      const nb = (ic, fn, label) => h('button', { class: 'icon-btn sm', 'aria-label': label, title: label, onclick: fn }, icon(ic, 18));
      const sc = (f) => { if (!this.cmp) return; this.relZoom(f); refresh(); };
      sizeIn.onchange = () => {
        if (!this.cmp) return;
        const v = parseFloat(sizeIn.value);
        if (v >= 5) this.relZoom((v / 100 * this.movingBase()) / this.movingSize());
        refresh();
      };
      let prevMode = null;
      const alignBtn = h('button', { class: 'btn sm', onclick: () => setAlign(!this.alignDrag) }, tr('יישור ידני'));
      const setAlign = (on, silent = false) => {
        if (!!on === !!this.alignDrag) return;
        if (on && !this.cmp) { UI.toast(tr('בחרו תוכנית להשוואה ולחצו "השווה" קודם')); return; }
        this.alignDrag = !!on;
        alignBtn.classList.toggle('primary', !!on);
        alignBtn.textContent = on ? tr('סיום יישור – השווה') : tr('יישור ידני');
        if (on) {
          if (this.cmpEditMode) this.setCmpEdit(null);
          if (this.tool !== 'pan') this.setTool('pan');
          prevMode = { mode: modeSel.value, val: op.value };
          if (modeSel.value !== 'overlay') changeMode('overlay', 50); // מציגים את שתי התוכניות זו מעל זו כדי לראות את היישור
          if (!silent) UI.toast(tr('גררו באצבע/בעכבר כדי להזיז את תוכנית ההשוואה, צבטו בשתי אצבעות כדי להגדיל/להקטין אותה (או הקלידו אחוז). בסיום לחצו "סיום יישור"'), { ms: 6000 });
        } else if (prevMode) {
          const pm = prevMode; prevMode = null;
          if (!silent) changeMode(pm.mode, pm.val);
        }
      };
      this.cmpEndAlign = () => { prevMode = null; this.alignDrag = false; alignBtn.classList.remove('primary'); alignBtn.textContent = tr('יישור ידני'); };
      const whoA = h('button', { class: 'btn sm', onclick: () => setWho('A') }, tr('הפתוחה'));
      const whoB = h('button', { class: 'btn sm', onclick: () => setWho('B') }, tr('תוכנית ההשוואה'));
      const setWho = (w) => { this.cmpWho = w; if (this.cmp) this.cmp.who = w; whoA.classList.toggle('primary', w === 'A'); whoB.classList.toggle('primary', w === 'B'); refresh(); };
      setWho(this.cmpWho || 'B');
      const fitBtn = (kind, label) => h('button', { class: 'btn sm', onclick: () => { if (!this.cmp || !this.layerB.page) { UI.toast(tr('בחרו תוכנית להשוואה ולחצו "השווה" קודם')); return; } this.fitMoving(kind); refresh(); } }, label);
      const autoBtn = h('button', { class: 'btn sm primary', onclick: () => runAuto() }, icon('target', 16), tr('יישור אוטומטי'));
      const runAuto = async () => {
        if (!this.cmp || !this.layerB.page || !this.page) { UI.toast(tr('בחרו תוכנית להשוואה ולחצו "השווה" קודם')); return; }
        if (this._autoBusy) return;
        this._autoBusy = true; autoBtn.disabled = true;
        const ctl = { cancelled: false };
        const pb = UI.bgProgress(tr('יישור אוטומטי'), { onCancel: () => { ctl.cancelled = true; } });
        ctl.progress = (t, f) => pb.set(tr(t), f);
        let res = null;
        try { res = await autoAlign({ pageA: this.page, rotA: this.rot, pageB: this.layerB.page, ctl }); } catch (e) { console.error(e); res = { ok: false, error: e }; }
        pb.close(); this._autoBusy = false; autoBtn.disabled = false;
        if (this.dead || !this.cmp) return;
        if (res.cancelled) return;
        if (!res.ok) { UI.toast(res.error ? tr('היישור האוטומטי נכשל: ') + (res.error.message || res.error) : tr('לא נמצאה התאמה אמינה בין התוכניות. אפשר ליישר ידנית ("יישור ידני"), או לנסות עמוד אחר.'), { type: 'error', ms: 6000 }); return; }
        const rel = (res.rotB - this.rot + 360) % 360;
        const B = this.layerB;
        if (B.rot !== res.rotB) { B.rot = res.rotB; B.setPage(B.page); }
        this.cmp.rotB = rel;
        B.s = res.s; B.dx = res.dx; B.dy = res.dy;
        B.place(this.scale, this.tx, this.ty, this.dpr);
        B.removeDetail(); this.scheduleDetail(30);
        this.cmp.sizeNote = '';
        this.updateCmpLegend(legend);
        refresh();
        const pct = Math.round(res.score * 100);
        UI.toast(res.score < 0.3 ? tr('יושר אוטומטית, אבל ההתאמה חלשה ({0}%). כדאי לבדוק ולדייק ידנית.', pct) : tr('יושר אוטומטית (התאמה {0}%). אפשר לדייק ידנית.', pct), { ms: 5000 });
      };

      const more = h('div', { class: 'cmp-more' });
      const setMore = (on) => { this.cmpMoreOpen = on; more.classList.toggle('hidden', !on); moreBtn.replaceChildren(icon(on ? 'chevU' : 'chevD', 16), tr('הגדרות וכלים')); };
      const moreBtn = h('button', { class: 'btn sm', onclick: () => setMore(more.classList.contains('hidden')) });
      more.append(
        h('div', { class: 'cmp-row' }, opLabel, op, tolBox, colBox, busy),
        h('div', { class: 'cmp-row' }, h('b', {}, tr('מזיזים ומשנים גודל של:')), whoA, whoB, h('span', {}, tr('התאמה:')), fitBtn('h', tr('לגובה')), fitBtn('w', tr('לרוחב')), fitBtn('both', tr('מילוי'))),
        h('div', { class: 'cmp-row' }, h('b', {}, tr('יישור:')), autoBtn, alignBtn,
          nb('chevU', () => nudge(0, -1), tr('למעלה')), nb('chevD', () => nudge(0, 1), tr('למטה')), nb('chevR', () => nudge(1, 0), tr('ימינה')), nb('chevL', () => nudge(-1, 0), tr('שמאלה')),
          h('span', {}, tr('גודל:')), nb('minus', () => sc(1 / 1.01), tr('הקטן ב-1%')), sizeIn, h('span', {}, '%'), nb('plus', () => sc(1.01), tr('הגדל ב-1%')),
          nb('rotate', () => this.rotateMoving(), tr('סובב ב-90° את התוכנית שנבחרה להזזה')),
          h('button', { class: 'btn sm', onclick: () => { if (!this.cmp) return; this.relSet(this.cmp.baseS, 0, 0); this.scheduleDetail(50); refresh(); } }, tr('אפס יישור'))),
        editRow, noteRow,
        h('div', { class: 'cmp-row' },
          h('button', { class: 'btn sm', onclick: () => this.printDialog({ compare: true }) }, icon('print', 16), tr('הדפס / שמור את ההשוואה')),
          h('button', { class: 'btn sm', onclick: () => this.setTool('region') }, icon('crop', 16), tr('בחירת אזור'))),
        legend);
      this.cmpBar.replaceChildren(
        h('div', { class: 'cmp-row' }, h('b', {}, tr('השוואה עם:')), planSel, verSel, h('span', {}, tr('עמוד')), pageIn, modeSel,
          h('button', { class: 'btn sm primary', onclick: apply }, tr('השווה')), moreBtn, h('button', { class: 'icon-btn sm', 'aria-label': tr('סגור השוואה'), onclick: () => this.closeCompare() }, icon('x', 18))),
        more);
      setMore(this.cmpMoreOpen != null ? this.cmpMoreOpen : window.innerWidth > 900);
      this.cmpBar.classList.remove('hidden');
      this.el.classList.add('cmp-open');
      this.cmpUI = { setVersion, apply, refresh };
      syncControls();
      if (preVid) { setVersion(preVid); apply(); }
    },

    updateCmpLegend(el) {
      const mode = this.cmp?.mode;
      el.replaceChildren(h('small', {},
        mode === 'changes' ? tr('אדום = קיים רק בתוכנית הפתוחה · כחול = קיים רק בתוכנית להשוואה · אפור = זהה (מוחלש ככל שמגדילים את עוצמת ההדגשה). "התעלמות מהזזות קטנות" מסנן הבדלים שנובעים מאי-יישור. ')
          : mode === 'sidechanges' ? tr('שתי התוכניות זו לצד זו (זום והזזה משותפים). בכל אחת מסומן בצבע רק מה שקיים בה ולא בשנייה. ')
            : mode === 'diff' ? tr('אדום = קיים רק בתוכנית הפתוחה · כחול = קיים רק בתוכנית להשוואה · שחור = זהה. ')
              : mode === 'overlay' ? tr('התוכנית להשוואה מונחת מעל הפתוחה בשקיפות שנבחרה. ') : tr('שתי התוכניות זו לצד זו עם זום והזזה משותפים. '),
        tr('זו השוואה חזותית בלבד – לא זיהוי אוטומטי של שינויים, והיא אמינה רק כשהתוכניות מיושרות. אפשר לתקן סימונים ידנית.'),
        this.cmp?.sizeNote ? ' ' + this.cmp.sizeNote : ''));
    },

    async startCompare(vid, pageNo, mode, opacity) {
      const blob = await S.getFileBlob(vid);
      if (!blob) throw new Error('missing');
      const doc = await openPdf(blob, { interactive: true });
      destroyDoc(this.cmpDoc);
      this.cmpDoc = doc;
      const prev = this.cmp, pg = clamp(pageNo, 1, doc.numPages);
      const keep = prev && prev.vid === vid && prev.page === pg;
      const vr = S.P.versions.get(vid), pl = vr && S.P.plans.get(vr.planId);
      this.cmp = { vid, label: pl ? `${pl.name} V${vr.number}` : '', page: pg, mode, opacity, baseS: 1, rotB: keep ? prev.rotB : 0, edits: keep ? prev.edits : [], notes: keep ? prev.notes : [], hist: keep ? prev.hist : [], redo: keep ? prev.redo : [], who: this.cmpWho || 'B' };
      await this.loadCompareLayer();
      this.setCompareMode(mode, opacity);
      this.renderCmpEdits(); this.updateUndo(); this.cmpUndoUI?.();
    },

    async loadCompareLayer() {
      if (!this.cmpDoc || !this.cmp) return;
      const pg = await this.cmpDoc.getPage(clamp(this.cmp.page, 1, this.cmpDoc.numPages));
      this.layerB.rot = (this.rot + (this.cmp.rotB || 0)) % 360;
      await this.layerB.setPage(pg);
      this.layerB.dx = this.layerB.dy = 0;
      const r = this.layerA.pw / this.layerB.pw;
      this.cmp.sizeNote = '';
      if (Math.abs(r - 1) > 0.01) { this.layerB.s = r; this.cmp.baseS = r; this.cmp.sizeNote = tr('גודל העמודים שונה – הותאם לפי הרוחב, כדאי לוודא יישור.'); } else { this.layerB.s = 1; this.cmp.baseS = 1; }
    },

    // ---------- הזזה / שינוי גודל של אחת משתי התוכניות (נבחר בכפתורי "מזיזים ומשנים גודל של") ----------
    // מייצגים תמיד את היחס בין התוכניות דרך layerB (s, dx, dy ביחידות העמוד הפתוח). כשמזיזים את הפתוחה –
    // מזיזים/מגדילים את התצוגה בפועל ומפצים ב-layerB כך שתוכנית ההשוואה נשארת במקומה על המסך.
    movingIsA() { return this.cmp?.who === 'A'; },
    movingSize() { const s = this.layerB.s; return this.movingIsA() ? 1 / s : s; },
    movingBase() { const b = this.cmp?.baseS || 1; return this.movingIsA() ? 1 / b : b; },
    relSet(s, dx, dy) {
      const B = this.layerB; if (!this.cmp || !B.page) return;
      s = clamp(s, 0.02, 50);
      if (!this.movingIsA()) { B.s = s; B.dx = dx; B.dy = dy; B.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(150); return; }
      const o = { sc: this.scale, tx: this.tx, ty: this.ty, bs: B.s, bdx: B.dx, bdy: B.dy };
      const sc2 = o.sc * o.bs / s;
      this.setView(sc2, o.tx + o.sc * o.bdx - sc2 * dx, o.ty + o.sc * o.bdy - sc2 * dy);
      B.s = s; B.dx = dx; B.dy = dy; // היחס בין התוכניות תמיד כמו שהתבקש (גם אם התצוגה הוגבלה בקצה)
      B.place(this.scale, this.tx, this.ty, this.dpr); this.scheduleDetail(150);
    },
    // הזזת התוכנית שנבחרה בפיקסלי מסך
    relMove(dxs, dys) {
      const B = this.layerB; if (!this.cmp || !B.page) return;
      if (!this.movingIsA()) { B.dx += dxs / this.scale; B.dy += dys / this.scale; B.place(this.scale, this.tx, this.ty, this.dpr); return; }
      const sc = this.scale;
      this.setView(sc, this.tx + dxs, this.ty + dys);
      B.dx -= dxs / sc; B.dy -= dys / sc; // היחס בין התוכניות משתנה תמיד, גם אם התצוגה לא יכלה לזוז
      B.place(this.scale, this.tx, this.ty, this.dpr);
    },
    // שינוי גודל התוכנית שנבחרה פי f סביב נקודה במסך (ברירת מחדל: מרכז התצוגה)
    relZoom(f, cx = this.vw / 2, cy = this.H / 2) {
      const B = this.layerB; if (!this.cmp || !B.page) return;
      const g = this.movingIsA() ? 1 / f : f;
      const px = (cx - this.tx) / this.scale, py = (cy - this.ty) / this.scale;
      this.relSet(B.s * g, px - (px - B.dx) * g, py - (py - B.dy) * g);
    },
    // התאמה אוטומטית של התוכנית שנבחרה לגובה / לרוחב / מילוי של השנייה (ממורכז). אחר כך אפשר לדייק ביישור אוטומטי/ידני.
    fitMoving(kind) {
      const A = this.layerA, B = this.layerB; if (!this.cmp || !B.page) return;
      const sh = A.ph / B.ph, sw = A.pw / B.pw;
      const s = kind === 'h' ? sh : kind === 'w' ? sw : Math.max(sh, sw);
      this.relSet(s, (A.pw - B.pw * s) / 2, (A.ph - B.ph * s) / 2);
      this.cmp.sizeNote = '';
    },
    // סובב ב-90°: את תוכנית ההשוואה, או (כשנבחרה הפתוחה) את הפתוחה ביחס להשוואה (שקול לסיבוב ההשוואה ב-270°)
    rotateMoving() {
      if (!this.cmp || !this.layerB.page) return;
      const n = this.movingIsA() ? 3 : 1;
      for (let i = 0; i < n; i++) this.rotateB();
    },
    // רדיוסים בפיקסלים להשוואה: k = פיקסלים לנקודת עמוד
    cmpPx(k) {
      const s = this.cmpSet, sum = (s.shift || 0) + (s.thick || 0);
      return { tol: sum > 0 ? Math.min(80, Math.max(1, Math.round(sum * MM * k))) : 0, gap: s.gap > 0 ? Math.min(60, Math.max(1, Math.round(s.gap * MM * k / 2))) : 0 };
    },

    // סיבוב תוכנית ההשוואה ב-90° (סביב מרכז התצוגה הנוכחי), למשל כשאחת התוכניות שמורה הפוך
    rotateB() {
      const B = this.layerB; if (!this.cmp || !B.page) return;
      const bw = B.pw, bh = B.ph, cx = this.vw / 2, cy = this.H / 2;
      const px = (cx - this.tx) / this.scale, py = (cy - this.ty) / this.scale;
      const u = (px - B.dx) / B.s, v = (py - B.dy) / B.s; // הנקודה בתוכנית ההשוואה שמתחת למרכז
      B.rot = (B.rot + 90) % 360; B.setPage(B.page);
      // אחרי סיבוב 90° עם השעון: (u,v) -> (bh - v, u)
      const nu = bh - v, nv = u; void bw;
      B.dx = px - nu * B.s; B.dy = py - nv * B.s;
      this.cmp.rotB = ((this.cmp.rotB || 0) + 90) % 360;
      B.place(this.scale, this.tx, this.ty, this.dpr);
      B.renderBase(); B.removeDetail(); this.scheduleDetail(60);
    },

    setCompareMode(mode, opacity) {
      const c = this.cmp; c.mode = mode; c.opacity = opacity;
      const wasSplit = this.split;
      this.split = mode === 'split' || mode === 'sidechanges';
      const diff = mode === 'diff';
      const changes = CHANGE_MODES.has(mode);
      if (changes) { this.cmpSet = this.cmpSet || cmpDefaults(); this.cmpSet.emph = opacity; } else this.hideChanges();
      this.layerA.tint = diff ? this.cmpSet.colA : null;
      this.layerB.tint = diff ? this.cmpSet.colB : null;
      const B = this.layerB.el;
      B.style.display = mode === 'changes' ? 'none' : '';
      B.style.isolation = 'isolate';
      B.style.mixBlendMode = diff ? 'multiply' : 'normal';
      B.style.opacity = mode === 'overlay' || diff ? opacity : 1;
      this.measure();
      this.layerA.renderBase(); this.layerB.renderBase();
      this.layerA.removeDetail(); this.layerB.removeDetail();
      if (wasSplit !== this.split) this.fit(this.fitMode || 'page'); else this.setView(this.scale, this.tx, this.ty, { keepFit: !!this.fitMode });
      this.scheduleDetail(50);
    },

    closeCompare() {
      this.setCmpEdit(null);
      this.cmpEndAlign?.();
      this.cmp = null; this.split = false; this.alignDrag = false; this.cmpUI = null; this.cmpUndoUI = null;
      this.hideChanges();
      this.gCmp.textContent = '';
      this.layerA.tint = null;
      this.layerB.el.style.display = 'none'; this.layerB.removeDetail();
      destroyDoc(this.cmpDoc); this.cmpDoc = null;
      this.cmpBar.classList.add('hidden');
      this.el.classList.remove('cmp-open');
      this.measure();
      this.layerA.renderBase(); this.layerA.removeDetail();
      this.fit(this.fitMode || 'page');
      this.scheduleDetail(50);
    },

    // ---------- חישוב הדגשת השינויים (שכבה מחושבת מעל התוכנית) ----------
    editsPx(d) {
      const out = [];
      for (const e of this.cmp.edits || []) {
        const a = this.o2d(e.x0, e.y0), b = this.o2d(e.x1, e.y1);
        out.push({ mode: e.mode, x0: (this.tx + Math.min(a.x, b.x) * this.scale) * d, x1: (this.tx + Math.max(a.x, b.x) * this.scale) * d, y0: (this.ty + Math.min(a.y, b.y) * this.scale) * d, y1: (this.ty + Math.max(a.y, b.y) * this.scale) * d });
      }
      return out;
    },
    async renderChanges() {
      const c = this.cmp;
      if (!c || !CHANGE_MODES.has(c.mode) || !this.layerA.page || !this.layerB.page) return;
      const side = c.mode === 'sidechanges';
      const gen = ++this.chGen || (this.chGen = 1);
      this._chCancel?.();
      const { scale, tx, ty, W, H, dpr } = this;
      const Wc = side ? this.vw : W;
      let d = Math.min(dpr || 1, 2); while (Wc * H * d * d > 4.5e6) d *= 0.9;
      const mk = (L) => ({ page: L.page, rot: L.rot, k: scale * L.s * d, ox: (tx + L.dx * scale) * d, oy: (ty + L.dy * scale) * d });
      if (this.chBusy) this.chBusy.textContent = tr('מחשב הבדלים…');
      let res = null;
      try { res = await renderChangesCanvas({ A: mk(this.layerA), B: mk(this.layerB), w: Math.round(Wc * d), h: Math.round(H * d), emphasis: this.cmpSet.emph, ...this.cmpPx(scale * d), colA: this.cmpSet.colA, colB: this.cmpSet.colB, colS: this.cmpSet.colS, edits: this.editsPx(d), side, onCancel: (f) => { this._chCancel = f; } }); } catch (e) { console.error(e); }
      if (this.chBusy) this.chBusy.textContent = '';
      if (!res || gen !== this.chGen || !this.cmp || !CHANGE_MODES.has(this.cmp.mode)) return;
      if (this.scale !== scale || this.tx !== tx || this.ty !== ty) return; // התוכנית זזה בינתיים: חישוב חדש כבר בדרך
      const list = side ? [[res.left, 0], [res.right, this.vw]] : [[res, 0]];
      const els = list.map(([cv, left]) => { cv.className = 'cmp-changes'; cv.style.width = Wc + 'px'; cv.style.height = H + 'px'; cv.style.left = left + 'px'; return cv; });
      (this.chEls || []).forEach((e) => e.remove());
      els.forEach((e) => this.stage.insertBefore(e, this.svg));
      this.chEls = els;
    },
    hideChanges() {
      this.chGen = (this.chGen || 0) + 1; this._chCancel?.();
      (this.chEls || []).forEach((e) => e.remove());
      this.chEls = [];
    },

    // ---------- עריכת סימוני השוואה ----------
    setCmpEdit(mode) {
      if (mode && !this.cmp) return;
      if (mode && !CHANGE_MODES.has(this.cmp.mode)) { UI.toast(tr('עריכת סימונים זמינה במצבי "הדגשת שינויים"')); return; }
      if (mode === this.cmpEditMode) mode = null;
      if (mode && this.alignDrag) this.cmpEndAlign?.();
      this.cmpEditMode = mode;
      if (mode) { if (this.draft) this.cancelDraft(); this.tool = 'cmpedit'; this.select(null, true); } else if (this.tool === 'cmpedit') this.tool = 'pan';
      this.updateToolUI(); this.renderProps();
      this.renderCmpEdits();
      this.syncCmpEditUI?.();
    },
    renderCmpEdits() {
      this.gCmp.textContent = '';
      const c = this.cmp;
      if (!c) return;
      const sc = this.scale, cx = this.ctx();
      for (const it of c.notes || []) this.gCmp.append(drawItem(it, cx));
      if (!this.cmpEditMode || !c.edits) return;
      for (const e of c.edits) this.gCmp.append(svg('rect', { x: e.x0, y: e.y0, width: e.x1 - e.x0, height: e.y1 - e.y0, fill: e.mode === 'add' ? 'rgba(46,125,50,.12)' : 'rgba(117,117,117,.12)', stroke: e.mode === 'add' ? '#2e7d32' : '#616161', 'stroke-width': 1.5 / sc, 'stroke-dasharray': `${6 / sc} ${4 / sc}` }));
    },
    // סימון חדש של המשתמש על ההשוואה (במקום על התוכנית עצמה)
    cmpNoteActive(type) { return !!(this.cmp && this.cmpNoteMode && (!type || NOTE_TOOLS.has(type))); },
    addCmpNote(d) {
      const it = this.newItem(d);
      it.id = 'n' + it.id; delete it.ownerId;
      this.cmp.notes.push(it); this.cmp.hist.push({ k: 'n', it }); this.cmp.redo = [];
      this.renderCmpEdits(); this.draft = null; this.renderDraft(); this.updateUndo(); this.cmpUndoUI?.();
    },
    cmpUndo() {
      const c = this.cmp; if (!c) return;
      const e = c.hist.pop(); if (!e) return;
      if (e.k === 'n') c.notes.splice(c.notes.indexOf(e.it), 1); else if (e.k === 'e') c.edits.splice(c.edits.indexOf(e.e), 1);
      else if (e.k === 'cn') { c.notes.push(...e.list); } else if (e.k === 'ce') { c.edits.push(...e.list); }
      c.redo.push(e); this.afterCmpHist(e);
    },
    cmpRedo() {
      const c = this.cmp; if (!c) return;
      const e = c.redo.pop(); if (!e) return;
      if (e.k === 'n') c.notes.push(e.it); else if (e.k === 'e') c.edits.push(e.e);
      else if (e.k === 'cn') { for (const it of e.list) c.notes.splice(c.notes.indexOf(it), 1); } else if (e.k === 'ce') { for (const x of e.list) c.edits.splice(c.edits.indexOf(x), 1); }
      c.hist.push(e); this.afterCmpHist(e);
    },
    afterCmpHist(e) {
      this.renderCmpEdits(); this.updateUndo(); this.cmpUndoUI?.(); this.syncCmpEditUI?.();
      if (e.k === 'e' || e.k === 'ce') this.renderChanges();
    },
    cmpClearNotes() {
      const c = this.cmp; if (!c || !c.notes.length) return;
      const list = c.notes.splice(0); c.hist.push({ k: 'cn', list }); c.redo = [];
      this.renderCmpEdits(); this.updateUndo(); this.cmpUndoUI?.();
    },
    cmpClearEdits() {
      const c = this.cmp; if (!c || !c.edits.length) return;
      const list = c.edits.splice(0); c.hist.push({ k: 'ce', list }); c.redo = [];
      this.renderCmpEdits(); this.renderChanges(); this.updateUndo(); this.cmpUndoUI?.(); this.syncCmpEditUI?.();
    },
    cmpEditMove(g, p) {
      if (!this.cmpEditMode) return;
      const r = { x: Math.min(g.p0.x, p.x), y: Math.min(g.p0.y, p.y), w: Math.abs(p.x - g.p0.x), h: Math.abs(p.y - g.p0.y) }, sc = this.scale;
      this.gDraft.textContent = '';
      this.gDraft.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'none', stroke: this.cmpEditMode === 'add' ? '#2e7d32' : '#d81b60', 'stroke-width': 2 / sc, 'stroke-dasharray': `${6 / sc} ${4 / sc}` }));
    },
    cmpEditUp(g, p, pt) {
      this.gDraft.textContent = '';
      if (!this.cmp || !this.cmpEditMode) return;
      const moved = Math.hypot(pt.x - g.sx, pt.y - g.sy) > 8;
      const k = 16 / this.scale; // הקשה בלי גרירה = ריבוע קטן סביב הנקודה
      const r = moved ? { x0: Math.min(g.p0.x, p.x), y0: Math.min(g.p0.y, p.y), x1: Math.max(g.p0.x, p.x), y1: Math.max(g.p0.y, p.y) } : { x0: p.x - k, y0: p.y - k, x1: p.x + k, y1: p.y + k };
      const ed = { mode: this.cmpEditMode, ...r };
      this.cmp.edits.push(ed); this.cmp.hist.push({ k: 'e', e: ed }); this.cmp.redo = [];
      this.updateUndo(); this.cmpUndoUI?.();
      this.renderCmpEdits();
      this.renderChanges();
      this.syncCmpEditUI?.();
    },
  });
}
