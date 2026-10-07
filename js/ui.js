// רכיבי ממשק בסיסיים: דיאלוגים, הודעות, תפריטים, בוחרי תיקייה/תוכנית
import { h, icon, natural, norm } from './util.js';
import * as S from './store.js';

let layer = null;
function root() {
  if (!layer) { layer = h('div', { id: 'ui-root' }); document.body.appendChild(layer); }
  return layer;
}

// ---------- הודעות ----------
export function toast(msg, { type = '', ms = 3200 } = {}) {
  const t = h('div', { class: 'toast ' + type, role: 'status' }, msg);
  root().appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---------- דיאלוג ----------
export function openModal({ title, body, buttons = [], wide = false, cancelable = true, className = '' }) {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal ' + (wide ? 'wide ' : '') + className, role: 'dialog', 'aria-modal': 'true' });
  const head = title ? h('div', { class: 'modal-head' }, h('h2', {}, title)) : null;
  if (head && cancelable) head.append(h('button', { class: 'icon-btn', 'aria-label': 'סגור', onclick: () => m.close(undefined) }, icon('x')));
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const foot = buttons.length ? h('div', { class: 'modal-foot' }) : null;
  const m = {
    el: box, body: bodyEl, promise,
    close(v) {
      document.removeEventListener('keydown', onKey, true);
      back.classList.remove('show');
      setTimeout(() => back.remove(), 180);
      resolve(v);
    },
  };
  (buttons || []).forEach((b) => {
    const btn = h('button', {
      class: 'btn ' + (b.kind || ''), type: 'button',
      onclick: async () => {
        if (b.onClick) { const r = await b.onClick(m); if (r === false) return; }
        if (!b.keepOpen) m.close(b.value);
      },
    }, b.icon ? icon(b.icon, 18) : null, b.text);
    foot.append(btn);
  });
  box.append(...[head, bodyEl, foot].filter(Boolean));
  back.append(box);
  if (cancelable) back.addEventListener('mousedown', (e) => { if (e.target === back) m.close(undefined); });
  function onKey(e) {
    if (e.key === 'Escape' && cancelable) { e.stopPropagation(); m.close(undefined); }
  }
  document.addEventListener('keydown', onKey, true);
  root().appendChild(back);
  requestAnimationFrame(() => back.classList.add('show'));
  setTimeout(() => { const f = box.querySelector('[autofocus], input, textarea, select'); if (f && !('ontouchstart' in window)) f.focus(); }, 60);
  return m;
}

export const modal = (opts) => openModal(opts).promise;

export function alertBox(message, { title = 'הודעה', okText = 'הבנתי' } = {}) {
  return modal({ title, body: h('p', { class: 'msg' }, message), buttons: [{ text: okText, kind: 'primary', value: true }] });
}

export async function confirmBox(message, { title = 'אישור', okText = 'אישור', danger = false, cancelText = 'ביטול' } = {}) {
  const r = await modal({
    title,
    body: h('p', { class: 'msg' }, message),
    buttons: [{ text: cancelText, value: false }, { text: okText, kind: danger ? 'danger' : 'primary', value: true }],
  });
  return r === true;
}

export function promptBox({ title, label = '', value = '', multiline = false, okText = 'אישור', placeholder = '', hint = '' }) {
  const input = multiline
    ? h('textarea', { rows: 4, value, placeholder, autofocus: true })
    : h('input', { type: 'text', value, placeholder, autofocus: true, enterKeyHint: 'done' });
  const body = h('div', { class: 'form' }, label ? h('label', {}, label) : null, input, hint ? h('p', { class: 'hint' }, hint) : null);
  const m = openModal({
    title, body,
    buttons: [
      { text: 'ביטול', value: null },
      { text: okText, kind: 'primary', onClick: (mm) => { const v = input.value.trim(); if (!v) { input.focus(); return false; } mm.close(v); return false; } },
    ],
  });
  if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) m.close(v); } });
  input.addEventListener('focus', () => input.select?.());
  return m.promise.then((v) => (v === undefined ? null : v));
}

export function askPassword(reason) {
  const input = h('input', { type: 'password', autofocus: true, autocomplete: 'off' });
  const m = openModal({
    title: 'ה-PDF מוגן בסיסמה',
    body: h('div', { class: 'form' }, h('label', {}, reason === 2 ? 'הסיסמה שגויה, נסה שוב' : 'הזן סיסמה לפתיחת הקובץ'), input),
    buttons: [{ text: 'ביטול', value: null }, { text: 'פתח', kind: 'primary', onClick: (mm) => { mm.close(input.value); return false; } }],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close(input.value); });
  return m.promise.then((v) => (v === undefined ? null : v));
}

export function progressBox(title) {
  const bar = h('div', { class: 'bar-fill' });
  const txt = h('div', { class: 'msg' }, '');
  const m = openModal({ title, body: h('div', {}, txt, h('div', { class: 'bar' }, bar)), cancelable: false });
  return {
    set(text, frac) { txt.textContent = text; if (frac != null) bar.style.width = Math.round(frac * 100) + '%'; },
    close() { m.close(); },
  };
}

// ---------- תפריט (חלון קטן, ובמובייל – גיליון תחתון) ----------
export function menu(anchor, items) {
  document.querySelectorAll('.menu-back').forEach((n) => n.remove());
  const back = h('div', { class: 'menu-back' });
  const box = h('div', { class: 'menu', role: 'menu' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey, true);
  items.filter(Boolean).forEach((it) => {
    if (it.divider) { box.append(h('div', { class: 'menu-div' })); return; }
    box.append(h('button', {
      class: 'menu-item ' + (it.danger ? 'danger' : ''), role: 'menuitem', disabled: !!it.disabled,
      onclick: () => { close(); setTimeout(() => it.onClick && it.onClick(), 0); },
    }, it.icon ? icon(it.icon, 18) : h('span', { class: 'ic' }), h('span', {}, it.label)));
  });
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.addEventListener('contextmenu', (e) => { e.preventDefault(); close(); });
  root().appendChild(back);
  const narrow = window.innerWidth < 700;
  if (narrow) { box.classList.add('sheet'); return; }
  let x, y;
  if (anchor instanceof Element) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  else { x = anchor.x; y = anchor.y; }
  const bw = box.offsetWidth, bh = box.offsetHeight;
  x = Math.max(8, Math.min(x, window.innerWidth - bw - 8));
  if (y + bh > window.innerHeight - 8) y = Math.max(8, (anchor instanceof Element ? anchor.getBoundingClientRect().top : y) - bh - 4);
  box.style.left = x + 'px';
  box.style.top = y + 'px';
}

// ---------- בורר תיקייה ----------
// מחזיר { id } (id=null לשורש) או null אם בוטל
export function folderPicker({ title = 'בחר תיקייה', exclude = new Set(), okText = 'העבר לכאן', startId = null } = {}) {
  let selected = startId;
  const expanded = new Set(S.folderPath(startId).map((f) => f.id));
  const list = h('div', { class: 'picker-list' });
  const okBtnRef = {};
  function render() {
    list.textContent = '';
    const row = (id, name, depth, hasKids) => {
      const dis = id && exclude.has(id);
      const r = h('div', {
        class: 'picker-row ' + (selected === id ? 'sel ' : '') + (dis ? 'dis' : ''), style: { paddingInlineStart: 8 + depth * 18 + 'px' },
        onclick: () => { if (dis) return; selected = id; render(); },
      },
      hasKids ? h('button', { class: 'twisty', type: 'button', onclick: (e) => { e.stopPropagation(); expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); } }, icon(expanded.has(id) ? 'chevD' : 'chevL', 16)) : h('span', { class: 'twisty' }),
      icon('folder', 18), h('span', { class: 'nm' }, name));
      list.append(r);
    };
    row(null, S.P.project.name + ' (שורש)', 0, false);
    const walk = (pid, depth) => {
      for (const f of S.childFolders(pid)) {
        if (exclude.has(f.id)) continue;
        const has = S.childFolders(f.id).some((c) => !exclude.has(c.id));
        row(f.id, f.name, depth, has);
        if (has && expanded.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
  }
  render();
  const m = openModal({
    title, body: list,
    buttons: [{ text: 'ביטול', value: null }, { text: okText, kind: 'primary', onClick: (mm) => { mm.close({ id: selected }); return false; } }],
  });
  return m.promise.then((v) => v || null);
}

// ---------- בורר תוכנית ----------
export function planPicker({ title = 'בחר תוכנית', excludeIds = new Set() } = {}) {
  const q = h('input', { type: 'search', placeholder: 'חיפוש תוכנית…' });
  const list = h('div', { class: 'picker-list tall' });
  let m;
  const all = [...S.P.plans.values()].filter((p) => !excludeIds.has(p.id))
    .map((p) => ({ p, path: S.planPathText(p) })).sort((a, b) => natural(a.path + a.p.name, b.path + b.p.name));
  function render() {
    list.textContent = '';
    const n = norm(q.value);
    const shown = all.filter((x) => !n || norm(x.p.name).includes(n) || norm(x.path).includes(n)).slice(0, 200);
    if (!shown.length) list.append(h('p', { class: 'empty-sm' }, 'לא נמצאו תוכניות'));
    shown.forEach(({ p, path }) => list.append(h('button', { class: 'picker-plan', type: 'button', onclick: () => m.close(p) },
      icon('file', 18), h('span', { class: 'col' }, h('b', {}, p.name), h('small', {}, path)))));
  }
  q.addEventListener('input', render);
  render();
  m = openModal({ title, body: h('div', {}, q, list), buttons: [{ text: 'ביטול', value: null }] });
  return m.promise.then((v) => v || null);
}
