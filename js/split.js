// תצוגה מפוצלת: 2–3 תוכניות פתוחות במקביל, כל אחת צופה עצמאי לגמרי (הזזה, זום, עמוד, חיפוש, גרסה, סימונים).
// הסרגל התחתון (כלי סימון ומאפייני העיצוב) משותף: הוא תמיד שייך לתצוגה הפעילה (המסומנת בכתום), כדי להשאיר מקום לתוכניות.
// הקובץ לא מייבא את viewer.js (כדי להימנע ממעגל ייבוא): מחלקת ה-Viewer מועברת אליו בעת היצירה.
import { t as tr } from './i18n.js';
import { pushLayer } from './backstack.js';
import * as UI from './ui.js';
import { h } from './util.js';

export const MAX_PANES = 3;
const DIR_KEY = 'plans.splitDir';

export class SplitHost {
  constructor(Viewer, root, { onExit } = {}) {
    this.V = Viewer; this.root = root; this.onExit = onExit;
    this.slots = []; this.active = null; this.dead = false;
    let dir = null; try { dir = localStorage.getItem(DIR_KEY); } catch { /* ignore */ }
    this.dir = dir === 'row' || dir === 'column' ? dir : (window.innerWidth > window.innerHeight ? 'row' : 'column');
    this.area = h('div', { class: 'split-area dir-' + this.dir });
    this.dock = h('div', { class: 'split-dock' });
    this.el = h('div', { class: 'split-host' }, this.area, this.dock);
    root.append(this.el);
    this.url = location.href;
    // "אחורה" של אנדרואיד יוצא מהתצוגה המפוצלת וחוזר לתצוגה רגילה (אם עברו לעמוד אחר – רק מנקים)
    this.layer = pushLayer(() => { this.layer = null; if (location.href === this.url) this.exit(); else this.teardown(); });
  }

  get viewers() { return this.slots.map((s) => s.v).filter(Boolean); }
  find(planId) { return this.slots.find((s) => s.v && s.v.planId === planId) || null; }

  async add(planId, opts = {}) {
    if (this.slots.length >= MAX_PANES) { UI.toast(tr('אפשר עד {0} תצוגות במקביל', MAX_PANES)); return null; }
    const slot = { el: h('div', { class: 'split-slot' }), v: null };
    this.slots.push(slot); this.area.append(slot.el);
    await this.fill(slot, planId, opts);
    return slot;
  }
  async fill(slot, planId, opts = {}) {
    const v = new this.V(slot.el, planId, opts, this);
    slot.v = v;
    await v.init();
    if (this.dead) return;
    this.setActive(v);
    this.updateCounts();
  }
  setActive(v) {
    if (!v || this.active === v || v.dead) return;
    this.active = v;
    for (const s of this.slots) s.v?.el.classList.toggle('active-pane', s.v === v);
    this.dock.replaceChildren(v.props, v.toolbar);
  }
  updateCounts() { this.area.dataset.n = String(this.slots.length); }

  // תוכנית אחרת בתצוגה קיימת
  async replace(v, planId, opts = {}) {
    const slot = this.slots.find((s) => s.v === v); if (!slot) return;
    if (v.planId === planId && !opts.v) return;
    if (this.active === v) { this.active = null; this.dock.replaceChildren(); }
    await v.destroy();
    slot.el.replaceChildren();
    await this.fill(slot, planId, opts);
  }
  async pickFor(v) {
    const p = await UI.planPicker({ title: tr('איזו תוכנית להציג כאן?') });
    if (p) await this.replace(v, p.id, {});
  }
  async addByPicker() {
    if (this.slots.length >= MAX_PANES) { UI.toast(tr('אפשר עד {0} תצוגות במקביל', MAX_PANES)); return; }
    const p = await UI.planPicker({ title: tr('איזו תוכנית להוסיף לתצוגה?') });
    if (p) await this.add(p.id, {});
  }
  async close(v) {
    if (this.slots.length <= 2) { // נשארת תוכנית אחת: חוזרים לתצוגה רגילה עם התוכנית שנשארה
      const other = this.slots.find((s) => s.v && s.v !== v);
      await this.exit(other ? other.v : v);
      return;
    }
    const i = this.slots.findIndex((s) => s.v === v);
    if (i < 0) return;
    const [slot] = this.slots.splice(i, 1);
    if (this.active === v) { this.active = null; this.dock.replaceChildren(); }
    await v.destroy(); slot.el.remove();
    this.setActive(this.slots[Math.min(i, this.slots.length - 1)]?.v);
    this.updateCounts();
  }
  toggleDir() {
    this.dir = this.dir === 'row' ? 'column' : 'row';
    try { localStorage.setItem(DIR_KEY, this.dir); } catch { /* ignore */ }
    this.area.className = 'split-area dir-' + this.dir;
  }

  // יציאה לתצוגה רגילה עם התוכנית של התצוגה (keepV, ברירת מחדל: הפעילה)
  async exit(keepV) {
    if (this.dead) return;
    const keep = keepV || this.active || this.slots[0]?.v;
    const state = keep ? { planId: keep.planId, opts: { page: keep.pageNum, view: keep.page ? keep.viewCenter() : undefined, v: keep.version?.id } } : null;
    await this.teardown();
    await new Promise((r) => setTimeout(r, 160)); // נותן ל-history.back של השכבה להסתיים לפני שינוי הכתובת
    this.onExit?.(state);
  }
  async teardown() {
    if (this.dead) return;
    this.dead = true;
    const l = this.layer; this.layer = null; l?.release();
    for (const s of this.slots) { try { await s.v?.destroy(); } catch (e) { console.error(e); } }
    this.slots = []; this.active = null;
    this.el.remove();
  }

  // ניווט מהכתובת (למשל קישור בין תוכניות): אם התוכנית כבר פתוחה – מפעילים אותה, אחרת היא נטענת בתצוגה הפעילה
  async routeOpen(planId, opts) {
    const s = this.find(planId);
    if (s) { this.setActive(s.v); await s.v.handleOpts(opts); return; }
    await this.replace(this.active || this.slots[0].v, planId, opts);
  }

  menu(v, anchor) {
    const n = this.slots.length;
    UI.menu(anchor, [
      { label: tr('הוסף תצוגה (עד {0})', MAX_PANES), icon: 'plus', disabled: n >= MAX_PANES, onClick: () => this.addByPicker() },
      { label: tr('החלף את התוכנית בתצוגה הזו'), icon: 'folder', onClick: () => this.pickFor(v) },
      { label: this.dir === 'row' ? tr('סידור: זו מעל זו') : tr('סידור: זו לצד זו'), icon: 'split', onClick: () => this.toggleDir() },
      { label: tr('סגור תצוגה זו'), icon: 'x', onClick: () => this.close(v) },
      { divider: true },
      { label: tr('חזרה לתצוגה רגילה (תוכנית אחת)'), icon: 'maximize', onClick: () => this.exit(v) },
    ]);
  }
}
