// כפתור "אחורה" של אנדרואיד: סוגר קודם את השכבה הפתוחה האחרונה (תפריט, חלון, תפריט צד, מצב בחירה),
// ורק אחר כך חוזר שלב אחורה בניווט. כל שכבה מוסיפה רשומת היסטוריה אחת עם אותה כתובת.
let seq = 0;
const stack = []; // { id, url, onBack }
let pending = null; // שכבה שנסגרה ורשומת ההיסטוריה שלה עוד לא הוסרה
let ignorePops = 0;
window.__layerPop = false; // viewer.js בודק אותו כדי לא להגיב ל"אחורה" שכבר טופל כאן
const flag = () => { window.__layerPop = true; setTimeout(() => { window.__layerPop = false; }, 0); };
const isTop = (id) => history.state && history.state.__layer === id;

// onBack() נקרא כשלוחצים "אחורה" (או כשהניווט עבר לעמוד אחר). מחזיר { release } לסגירה מהקוד.
export function pushLayer(onBack) {
  const id = ++seq;
  const url = location.href;
  try {
    if (pending && isTop(pending.id) && location.href === pending.url) {
      clearTimeout(pending.timer); pending = null; // שכבה חדשה תופסת את מקום הקודמת (למשל תפריט ← חלון)
      history.replaceState({ __layer: id }, '');
    } else history.pushState({ __layer: id }, '');
  } catch { return { release() {} }; }
  stack.push({ id, url, onBack });
  return {
    id,
    release() {
      const i = stack.findIndex((l) => l.id === id);
      if (i < 0) return;
      stack.splice(i, 1);
      if (i === stack.length && isTop(id)) {
        // ההסרה מתעכבת מעט: אם בינתיים נפתחה שכבה אחרת או בוצע ניווט – לא נוגעים בהיסטוריה
        const p = { id, url, timer: 0 };
        p.timer = setTimeout(() => { if (pending === p) pending = null; if (isTop(id)) { ignorePops++; history.back(); } }, 60);
        pending = p;
      }
    },
  };
}

function dropAll() { stack.splice(0).reverse().forEach((l) => { try { l.onBack(); } catch (e) { console.error(e); } }); }

window.addEventListener('popstate', (e) => {
  if (ignorePops > 0) { ignorePops--; flag(); return; }
  const top = stack[stack.length - 1];
  if (top) {
    if (location.href === top.url && !(e.state && e.state.__layer === top.id)) {
      flag(); stack.pop();
      try { top.onBack(); } catch (err) { console.error(err); }
      return;
    }
    if (location.href !== top.url) dropAll(); // עברו לעמוד אחר
  }
  // נחתנו על רשומת שכבה ישנה שכבר נסגרה: מדלגים עליה
  if (e.state && e.state.__layer && !stack.some((l) => l.id === e.state.__layer)) { flag(); ignorePops++; history.back(); }
}, true);

window.addEventListener('hashchange', () => {
  const top = stack[stack.length - 1];
  if (top && location.href !== top.url) dropAll();
});
