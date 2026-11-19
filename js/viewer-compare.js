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
import { renderChangesCanvas, inkMap, diffMasks, overlapRect } from './diffview.js';
import { autoAlign } from './autoalign.js';

const CHANGE_MODES = new Set(['changes', 'sidechanges', 'blink']);
const NOTE_TOOLS = new Set(['pen', 'line', 'polyline', 'arrow', 'rect', 'ellipse', 'highlight']);
const MM = 72 / 25.4; // נקודות עמוד למ״מ
const cmpDefaults = () => ({ emph: 0.6, shift: prefs.cmpShift ?? 0.4, thick: prefs.cmpThick ?? 0.3, gap: prefs.cmpGap ?? 0, minSz: prefs.cmpMinSz ?? 0.6, localMm: prefs.cmpLocalMm ?? 4, clip: prefs.cmpClip ?? true, edgeMm: prefs.cmpEdgeMm ?? 0, blinkMs: prefs.cmpBlinkMs ?? 700, colA: prefs.cmpA || '#e53935', colB: prefs.cmpB || '#1e63ff', colS: prefs.cmpS || '#000000' });

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
        h('option', { value: 'blink' }, tr('הבהוב: ישנה ↔ חדשה (עם הזהה באפור)')),
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
        slider('gap', tr('מקווקו = רציף'), 12, 0.5, tr(' מ״מ'), tr('פערים עד הגודל הזה בקו מקווקו ייחשבו כקו רציף (0 = כבוי)')),
        slider('localMm', tr('יישור מקומי'), 10, 0.5, tr(' מ״מ'), tr('מפצה על הבדלי גודל או סיבוב קלים בין התוכניות (למשל סריקה או ייצוא בגודל מעט שונה), בכל אזור בנפרד. 0 = כבוי')),
        slider('edgeMm', tr('התעלמות משולי הדף'), 40, 1, tr(' מ״מ'), tr('לא מסמנים שינויים בפס הצר סביב קצה הדף (מסגרת, סרגל קואורדינטות, כותרת). 0 = כבוי')),
        slider('minSz', tr('התעלמות משינויים קטנים'), 5, 0.1, tr(' מ״מ'), tr('שינוי קצר מהאורך הזה (כתמים, קטעים זעירים) לא יסומן (0 = כבוי)')));
      const blinkVal = h('b', { class: 'cmp-val' }), blinkIn = h('input', { type: 'range', min: 200, max: 2000, step: 100, value: this.cmpSet.blinkMs, 'aria-label': tr('זמן בין החלפות') });
      const blinkShow = () => { blinkVal.textContent = (blinkIn.value / 1000).toFixed(1) + tr(' שנ׳'); };
      blinkIn.oninput = () => { this.cmpSet.blinkMs = +blinkIn.value; prefs.cmpBlinkMs = +blinkIn.value; blinkShow(); };
      blinkIn.onchange = () => savePrefs();
      blinkShow();
      const blinkBox = h('label', { class: 'cmp-tol' }, h('span', {}, tr('זמן בין החלפות')), blinkIn, blinkVal);
      const clipCb = h('input', { type: 'checkbox', checked: this.cmpSet.clip !== false });
      clipCb.onchange = () => { this.cmpSet.clip = clipCb.checked; prefs.cmpClip = clipCb.checked; savePrefs(); if (this.cmp && CHANGE_MODES.has(this.cmp.mode)) later(); };
      const clipLbl = h('label', { class: 'check', title: tr('כשאחת התוכניות גדולה/רחבה יותר, האזור הנוסף שלה לא יסומן כשינוי') }, clipCb, tr('השווה רק את האזור המשותף לשני הדפים'));
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
      let tabs = null, selTab = () => {};
      const syncControls = () => {
        const m = modeSel.value, ch = CHANGE_MODES.has(m);
        opLabel.textContent = ch ? tr('עוצמת ההדגשה') : m === 'diff' ? tr('עוצמת התוכנית להשוואה') : tr('שקיפות');
        blinkBox.style.display = m === 'blink' ? '' : 'none';
        if (tabs) { tabs.tol.btn.style.display = ch ? '' : 'none'; if (!ch && this.cmpTab === 'tol') selTab('view'); }
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
        paintRegs();
        // השוואה חדשה (תוכנית/גרסה/עמוד שונים מהקודמת): יישור אוטומטי פעם אחת, כדי לא להתחיל מתצוגה לא מיושרת
        const key = vid + ':' + (parseInt(pageIn.value, 10) || 1);
        if (autoOpenCb.checked && this._autoKey !== key) { this._autoKey = key; await runAuto(); }
      };
      const autoOpenCb = h('input', { type: 'checkbox', checked: prefs.cmpAutoOpen !== false });
      autoOpenCb.onchange = () => { prefs.cmpAutoOpen = autoOpenCb.checked; savePrefs(); };
      const autoOpenLbl = h('label', { class: 'check' }, autoOpenCb, tr('יישור אוטומטי בכל השוואה חדשה'));
      const changeMode = (m, val) => {
        modeSel.value = m; op.value = val != null ? val : CHANGE_MODES.has(m) ? Math.round(this.cmpSet.emph * 100) : m === 'overlay' ? 50 : 100;
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

      // ---------- רשימת שינויים (סריקת כל העמוד) ----------
      const regInfo = h('small', { class: 'hint-inline' });
      const regList = h('div', { class: 'cmp-regs' });
      const regFilter = h('select', { 'aria-label': tr('סינון אזורים') },
        h('option', { value: 'all' }, tr('הכל')), h('option', { value: 'todo' }, tr('לבדיקה')), h('option', { value: 'ok' }, tr('אושרו')), h('option', { value: 'ignore' }, tr('התעלמות')));
      const STN = { todo: tr('לבדיקה'), ok: tr('אושר'), ignore: tr('התעלם') };
      const NEXT = { todo: 'ok', ok: 'ignore', ignore: 'todo' };
      const typeOf = (r) => (r.o && r.n ? tr('שינוי') : r.o ? tr('קיים רק בפתוחה') : tr('קיים רק בהשוואה'));
      const paintRegs = () => {
        const c = this.cmp, regs = (c && c.regs) || [];
        const cnt = { todo: 0, ok: 0, ignore: 0 }; regs.forEach((r) => { cnt[r.st]++; });
        regInfo.textContent = regs.length ? tr('{0} אזורים · {1} לבדיקה · {2} אושרו · {3} התעלמות', regs.length, cnt.todo, cnt.ok, cnt.ignore) : '';
        regList.replaceChildren();
        const f = regFilter.value; let shown = 0;
        regs.forEach((r, i) => {
          if (f !== 'all' && r.st !== f) return;
          if (shown++ >= 300) return;
          regList.append(h('div', { class: 'cmp-reg ' + r.st + (c.regSel === i ? ' cur' : '') },
            h('button', { class: 'reg-go', onclick: () => this.gotoReg(i) }, h('b', {}, '#' + (i + 1)), ' ', typeOf(r)),
            h('button', { class: 'btn sm reg-st', title: tr('לחצו כדי לשנות סטטוס'), onclick: () => { r.st = NEXT[r.st]; paintRegs(); } }, STN[r.st])));
        });
        if (shown > 300) regList.append(h('small', { class: 'hint-inline' }, tr('מוצגים 300 הראשונים. סננו כדי לראות אחרים.')));
        this.renderCmpEdits();
      };
      regFilter.onchange = paintRegs;
      this.cmpRegUI = paintRegs;
      const nextTodo = (dir) => { const c = this.cmp; if (!c || !c.regs || !c.regs.length) return; const n = c.regs.length; for (let k = 1; k <= n; k++) { const i = (c.regSel + dir * k + n * 2) % n; if (c.regs[i].st === 'todo') { this.gotoReg(i); return; } } UI.toast(tr('אין עוד אזורים לבדיקה')); };
      const regCb = h('input', { type: 'checkbox', checked: true });
      regCb.onchange = () => { if (this.cmp) { this.cmp.showRegs = regCb.checked; this.renderCmpEdits(); } };
      const regRow = h('div', { class: 'cmp-row' },
        h('b', {}, tr('רשימת שינויים:')),
        h('button', { class: 'btn sm primary', onclick: () => this.scanChanges() }, icon('search', 16), tr('סרוק את כל העמוד')),
        h('button', { class: 'btn sm', onclick: () => nextTodo(-1) }, icon('chevU', 16), tr('הקודם לבדיקה')),
        h('button', { class: 'btn sm', onclick: () => nextTodo(1) }, icon('chevD', 16), tr('הבא לבדיקה')),
        regFilter, h('label', { class: 'check' }, regCb, tr('הצג ריבועים')), regInfo,
        h('small', { class: 'hint-inline' }, tr('אחרי שינוי יישור או סבילות – סרקו שוב (הסטטוסים של אזורים שכבר נבדקו נשמרים).')));

      const more = h('div', { class: 'cmp-more' });
      const setMore = (on) => { this.cmpMoreOpen = on; more.classList.toggle('hidden', !on); moreBtn.replaceChildren(icon(on ? 'chevU' : 'chevD', 16), tr('הגדרות וכלים')); };
      const moreBtn = h('button', { class: 'btn sm', onclick: () => setMore(more.classList.contains('hidden')) });
      // ארגון הכלים בלשוניות: תצוגה / סבילות / יישור / שינויים / סימונים והדפסה
      const tabDefs = [
        ['view', tr('תצוגה'), [h('div', { class: 'cmp-row' }, opLabel, op, blinkBox, busy), h('div', { class: 'cmp-row' }, colBox)]],
        ['tol', tr('סבילות'), [h('div', { class: 'cmp-row' }, tolBox, clipLbl), h('small', { class: 'hint-inline' }, tr('כמה "מעבר" מותר לפני שהפרש נחשב שינוי. מגדילים כשיש הרבה רעש, מקטינים כדי לא לפספס שינויים קטנים.'))]],
        ['align', tr('יישור'), [
          h('div', { class: 'cmp-row' }, h('b', {}, tr('מזיזים ומשנים גודל של:')), whoA, whoB, h('span', {}, tr('התאמה:')), fitBtn('h', tr('לגובה')), fitBtn('w', tr('לרוחב')), fitBtn('both', tr('מילוי'))),
          h('div', { class: 'cmp-row' }, autoOpenLbl,
            nb('chevU', () => nudge(0, -1), tr('למעלה')), nb('chevD', () => nudge(0, 1), tr('למטה')), nb('chevR', () => nudge(1, 0), tr('ימינה')), nb('chevL', () => nudge(-1, 0), tr('שמאלה')),
            h('span', {}, tr('גודל:')), nb('minus', () => sc(1 / 1.01), tr('הקטן ב-1%')), sizeIn, h('span', {}, '%'), nb('plus', () => sc(1.01), tr('הגדל ב-1%')),
            nb('rotate', () => this.rotateMoving(), tr('סובב ב-90° את התוכנית שנבחרה להזזה')),
            h('button', { class: 'btn sm', onclick: () => { if (!this.cmp) return; this.relSet(this.cmp.baseS, 0, 0); this.scheduleDetail(50); refresh(); } }, tr('אפס יישור')))]],
        ['changes', tr('רשימת שינויים'), [regRow, regList]],
        ['tools', tr('סימונים והדפסה'), [editRow, noteRow,
          h('div', { class: 'cmp-row' },
            h('button', { class: 'btn sm', onclick: () => this.printDialog({ compare: true }) }, icon('print', 16), tr('הדפס / שמור את ההשוואה')),
            h('button', { class: 'btn sm', onclick: () => this.setTool('region') }, icon('crop', 16), tr('בחירת אזור')))]],
      ];
      tabs = {};
      const tabBar = h('div', { class: 'cmp-tabs', role: 'tablist' });
      selTab = (id) => {
        this.cmpTab = id;
        for (const k of Object.keys(tabs)) { tabs[k].body.classList.toggle('hidden', k !== id); tabs[k].btn.classList.toggle('on', k === id); tabs[k].btn.setAttribute('aria-selected', k === id ? 'true' : 'false'); }
      };
      for (const [id, label, rows] of tabDefs) {
        const btn = h('button', { class: 'cmp-tab', role: 'tab', onclick: () => selTab(id) }, label);
        tabs[id] = { btn, body: h('div', { class: 'cmp-tabbody hidden' }, ...rows) };
        tabBar.append(btn);
      }
      more.append(tabBar, ...Object.values(tabs).map((t) => t.body), legend);
      selTab(tabs[this.cmpTab] ? this.cmpTab : 'view');
      this.cmpBar.replaceChildren(
        h('div', { class: 'cmp-row' }, h('b', {}, tr('השוואה עם:')), planSel, verSel, h('span', {}, tr('עמוד')), pageIn, modeSel,
          h('button', { class: 'btn sm primary', onclick: apply }, tr('השווה')), autoBtn, alignBtn, moreBtn, h('button', { class: 'icon-btn sm', 'aria-label': tr('סגור השוואה'), onclick: () => this.closeCompare() }, icon('x', 18))),
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
              : mode === 'overlay' ? tr('התוכנית להשוואה מונחת מעל הפתוחה בשקיפות שנבחרה. ')
                : mode === 'blink' ? tr('התצוגה מתחלפת בין שני מצבים: התוכנית הפתוחה (הישנה) לבין תוכנית ההשוואה (החדשה). בשניהם מה שזהה בדיוק מופיע באפור, וכל מה שמבהב בצבע הוא מה שהשתנה. ') : tr('שתי התוכניות זו לצד זו עם זום והזזה משותפים. '),
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
      this.cmp = { vid, label: pl ? `${pl.name} V${vr.number}` : '', page: pg, mode, opacity, baseS: 1, rotB: keep ? prev.rotB : 0, edits: keep ? prev.edits : [], notes: keep ? prev.notes : [], hist: keep ? prev.hist : [], redo: keep ? prev.redo : [], regs: keep ? prev.regs || [] : [], regSel: -1, who: this.cmpWho || 'B' };
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
      return {
        tol: sum > 0 ? Math.min(80, Math.max(1, Math.round(sum * MM * k))) : 0,
        gap: s.gap > 0 ? Math.min(60, Math.max(1, Math.round(s.gap * MM * k / 2))) : 0,
        gapFull: s.gap > 0 ? Math.min(120, Math.max(1, Math.round(s.gap * MM * k))) : 0, // לאלגוריתם החדש: אורך הפער המלא
        mn: s.minSz > 0 ? Math.round(s.minSz * MM * k) : 0, // שינוי קצר מזה (באורך קו) לא יסומן
        edge: s.edgeMm > 0 ? Math.round(s.edgeMm * MM * k) : 0,
        clip: s.clip !== false, // לא מסמנים שינוי באזור שקיים רק באחת התוכניות (מחוץ לגבולות הדף של השנייה)
        local: s.localMm > 0 ? Math.min(40, Math.round(s.localMm * MM * k)) : 0, // יישור מקומי: טווח ההזזה המקסימלי (פיקסלים)
      };
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
      this.stopBlink();
      B.style.display = mode === 'changes' || mode === 'blink' ? 'none' : '';
      B.style.isolation = 'isolate';
      B.style.mixBlendMode = diff ? 'multiply' : 'normal';
      B.style.opacity = mode === 'overlay' || diff ? opacity : 1;
      this.measure();
      this.layerA.renderBase(); this.layerB.renderBase();
      this.layerA.removeDetail(); this.layerB.removeDetail();
      if (wasSplit !== this.split) this.fit(this.fitMode || 'page'); else this.setView(this.scale, this.tx, this.ty, { keepFit: !!this.fitMode });
      this.scheduleDetail(50);
    },

    // הבהוב: מתחלף בין "הישנה + הזהה באפור" לבין "החדשה + הזהה באפור" (שני הקנבסים של מצב "זו לצד זו" מוצבים זה על זה)
    startBlink() {
      if (this._blink) return;
      let flip = false;
      const apply = () => {
        const e = this.chEls || [];
        if (e.length === 2) { e[0].style.display = flip ? 'none' : ''; e[1].style.display = flip ? '' : 'none'; }
        if (this.chBusy) this.chBusy.textContent = flip ? tr('מוצגת: החדשה (תוכנית ההשוואה)') : tr('מוצגת: הישנה (התוכנית הפתוחה)');
      };
      const tick = () => {
        if (!this.cmp || this.cmp.mode !== 'blink') { this.stopBlink(); return; }
        flip = !flip; apply();
        this._blink = setTimeout(tick, Math.max(150, (this.cmpSet && this.cmpSet.blinkMs) || 700));
      };
      this._blinkApply = apply;
      this._blink = setTimeout(tick, Math.max(150, (this.cmpSet && this.cmpSet.blinkMs) || 700));
    },
    stopBlink() {
      if (this._blink) { clearTimeout(this._blink); this._blink = null; }
      this._blinkApply = null;
      if (this.chBusy && /^(מוצגת|Showing)/.test(this.chBusy.textContent || '')) this.chBusy.textContent = '';
    },

    closeCompare() {
      this.stopBlink();
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
      const side = c.mode === 'sidechanges' || c.mode === 'blink', sbs = c.mode === 'sidechanges';
      const gen = ++this.chGen || (this.chGen = 1);
      this._chCancel?.();
      const { scale, tx, ty, W, H, dpr } = this;
      const Wc = sbs ? this.vw : W;
      let d = Math.min(dpr || 1, 2); while (Wc * H * d * d > 4.5e6) d *= 0.9;
      const mk = (L) => ({ page: L.page, rot: L.rot, k: scale * L.s * d, ox: (tx + L.dx * scale) * d, oy: (ty + L.dy * scale) * d });
      if (this.chBusy) this.chBusy.textContent = tr('מחשב הבדלים…');
      let res = null;
      try { res = await renderChangesCanvas({ A: mk(this.layerA), B: mk(this.layerB), w: Math.round(Wc * d), h: Math.round(H * d), emphasis: this.cmpSet.emph, ...this.cmpPx(scale * d), colA: this.cmpSet.colA, colB: this.cmpSet.colB, colS: this.cmpSet.colS, edits: this.editsPx(d), side, onCancel: (f) => { this._chCancel = f; } }); } catch (e) { console.error(e); }
      if (this.chBusy) this.chBusy.textContent = '';
      if (!res || gen !== this.chGen || !this.cmp || !CHANGE_MODES.has(this.cmp.mode)) return;
      if (this.scale !== scale || this.tx !== tx || this.ty !== ty) return; // התוכנית זזה בינתיים: חישוב חדש כבר בדרך
      const list = sbs ? [[res.left, 0], [res.right, this.vw]] : side ? [[res.left, 0], [res.right, 0]] : [[res, 0]];
      const els = list.map(([cv, left]) => { cv.className = 'cmp-changes'; cv.style.width = Wc + 'px'; cv.style.height = H + 'px'; cv.style.left = left + 'px'; return cv; });
      (this.chEls || []).forEach((e) => e.remove());
      els.forEach((e) => this.stage.insertBefore(e, this.svg));
      this.chEls = els;
      if (c.mode === 'blink') { this.startBlink(); this._blinkApply?.(); } else this.stopBlink();
    },
    hideChanges() {
      this.stopBlink();
      this.chGen = (this.chGen || 0) + 1; this._chCancel?.();
      (this.chEls || []).forEach((e) => e.remove());
      this.chEls = [];
    },

    // ---------- רשימת שינויים לכל העמוד (מבוסס על אלגוריתם האזורים של MatchPlan) ----------
    // רינדור קבוע של כל העמוד בשתי התוכניות (לפי היישור הנוכחי), זיהוי הבדלים וקיבוצם לאזורים ממוספרים.
    async scanChanges() {
      const c = this.cmp;
      if (!c || !this.layerA.page || !this.layerB.page) { UI.toast(tr('בחרו תוכנית להשוואה ולחצו "השווה" קודם')); return; }
      if (this._scanBusy) return;
      this._scanBusy = true;
      let cancelled = false; const cancels = [];
      const pb = UI.bgProgress(tr('סורק את כל העמוד'), { onCancel: () => { cancelled = true; cancels.forEach((f) => { try { f(); } catch { /* ignore */ } }); } });
      try {
        const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
        const budget = coarse ? 4.5e6 : 9e6;
        const sc0 = Math.sqrt(budget / (this.pw * this.ph));
        const w = Math.max(50, Math.ceil(this.pw * sc0)), hh = Math.max(50, Math.ceil(this.ph * sc0));
        const mk = (L) => ({ page: L.page, rot: L.rot, k: sc0 * L.s, ox: L.dx * sc0, oy: L.dy * sc0 });
        pb.set(tr('קורא את התוכנית הפתוחה…'), 0.1);
        const ia = await inkMap(mk(this.layerA), w, hh, (f) => cancels.push(f));
        if (cancelled) return;
        pb.set(tr('קורא את תוכנית ההשוואה…'), 0.35);
        const ib = await inkMap(mk(this.layerB), w, hh, (f) => cancels.push(f));
        if (cancelled) return;
        pb.set(tr('משווה ומקבץ אזורי שינוי…'), 0.6);
        const px = this.cmpPx(sc0);
        const res = await diffMasks({ W: w, H: hh, dA: ia, dB: ib, tol: px.tol, gap: px.gapFull, mn: px.mn, local: px.local, clip: px.clip || px.edge ? overlapRect(mk(this.layerA), mk(this.layerB), px.edge) : null, regs: true });
        if (cancelled) return;
        if (!res || !res.regs) { UI.toast(tr('לא ניתן לחשב את רשימת השינויים במכשיר הזה'), { type: 'error' }); return; }
        // אזורים → קואורדינטות העמוד המקורי (כמו כל הסימונים), ושמירת סטטוס של אזורים שכבר נבדקו בסריקה קודמת
        const iou = (p, q) => { const ww = Math.min(p[0] + p[2], q[0] + q[2]) - Math.max(p[0], q[0]), h2 = Math.min(p[1] + p[3], q[1] + q[3]) - Math.max(p[1], q[1]); if (ww <= 0 || h2 <= 0) return 0; const i = ww * h2; return i / (p[2] * p[3] + q[2] * q[3] - i); };
        const old = c.regs || [];
        const ignoreEdits = (c.edits || []).filter((e) => e.mode === 'ignore');
        const out = [];
        for (const r of res.regs) {
          const a = this.d2o(r.box[0] / sc0, r.box[1] / sc0), b = this.d2o((r.box[0] + r.box[2]) / sc0, (r.box[1] + r.box[3]) / sc0);
          const box = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
          const cxm = box[0] + box[2] / 2, cym = box[1] + box[3] / 2;
          if (ignoreEdits.some((e) => cxm >= Math.min(e.x0, e.x1) && cxm <= Math.max(e.x0, e.x1) && cym >= Math.min(e.y0, e.y1) && cym <= Math.max(e.y0, e.y1))) continue; // המשתמש סימן "זה לא שינוי"
          const prev = old.find((o) => iou(o.box, box) > 0.5);
          out.push({ box, o: r.o, n: r.n, st: prev ? prev.st : 'todo', note: prev ? prev.note : '' });
        }
        c.regs = out; c.regSel = -1;
        UI.toast(out.length ? tr('נמצאו {0} אזורי שינוי', out.length) : tr('לא נמצאו הבדלים בהתאם להגדרות הסבילות'), { ms: 3500 });
        this.cmpRegUI?.();
      } catch (e) {
        if (!cancelled) { console.error(e); UI.toast(tr('סריקת העמוד נכשלה: ') + (e.message || e), { type: 'error', ms: 5000 }); }
      } finally { pb.close(); this._scanBusy = false; }
    },
    // קופץ לאזור שינוי מספר i (ומקרב אליו)
    gotoReg(i) {
      const c = this.cmp;
      if (!c || !c.regs || !c.regs.length) return;
      i = (i + c.regs.length) % c.regs.length;
      c.regSel = i;
      const [x, y, w, hh] = c.regs[i].box;
      const a = this.o2d(x, y), b = this.o2d(x + w, y + hh);
      const dw = Math.abs(b.x - a.x), dh = Math.abs(b.y - a.y);
      const sc = clamp(Math.min(this.vw / (Math.max(dw, 1) * 4), this.H / (Math.max(dh, 1) * 4)), this.minScale(), this.maxScale());
      this.applyView({ cx: x + w / 2, cy: y + hh / 2, scale: Math.max(sc, this.scale * 0.2) });
      this.renderCmpEdits(); this.cmpRegUI?.();
    },
    // ריבועים ממוספרים סביב אזורי השינוי (כתום = לבדיקה, ירוק = אושר; "התעלם" לא מצוין)
    drawCmpRegs() {
      const c = this.cmp;
      if (!c || !c.regs || !c.regs.length || c.showRegs === false) return;
      const fs = Math.max(this.pw, this.ph) / 80;
      c.regs.forEach((r, i) => {
        if (r.st === 'ignore') return;
        const col = r.st === 'ok' ? '#2e7d32' : '#ff6d00', sel = i === c.regSel;
        const [x, y, w, hh] = r.box;
        this.gCmp.append(svg('rect', { x, y, width: w, height: hh, fill: sel ? 'rgba(255,109,0,.10)' : 'none', stroke: col, 'stroke-width': sel ? 3 : 1.6, 'vector-effect': 'non-scaling-stroke', rx: fs * 0.1 }));
        this.gCmp.append(svg('rect', { x, y: y - fs * 1.25, width: fs * (0.7 + 0.62 * String(i + 1).length), height: fs * 1.25, fill: col }));
        const t = svg('text', { x: x + fs * 0.3, y: y - fs * 0.25, fill: '#fff', 'font-size': fs, 'font-weight': 'bold', 'font-family': 'sans-serif' });
        t.textContent = String(i + 1);
        this.gCmp.append(t);
      });
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
      this.drawCmpRegs();
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
